/**
 * `start_research_run` and `POST /sessions/:id/run` must stay one run-start
 * path. `beginRun` is that path today and the adapter calls it, but nothing
 * fails if a future handler reimplements run-start inside the MCP server: an
 * inlined `if (runBroker.get(...)) return failure(..., "run_already_active")`
 * would return the same shape and pass any outcome-only assertion.
 *
 * So this drives the concurrency rejection *through the adapter* against the
 * real `beginRun`, and asserts that the shared function is what was called.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FastifyBaseLogger } from "fastify";

import { createProject } from "../src/projects.ts";
import { withActiveProject } from "../src/scope.ts";
import { runBroker, type RunMetadata } from "../src/agent/run-broker.ts";
import { createKadyMcpServer } from "../src/mcp-server/server.ts";
import { beginRun } from "../src/api/sessions.ts";

// A spy that calls through, not a stand-in: the real `prepareRun` has to be
// the thing that rejects, or this test proves nothing about the shared path.
vi.mock("../src/api/sessions.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/sessions.ts")>();
  return { ...actual, beginRun: vi.fn(actual.beginRun) };
});
// `prepareRun` rejects on the retained broker handle before it resolves a
// model or bills anything, so a plausible live session is all this needs.
vi.mock("../src/agent/session-registry.ts", () => ({
  createSession: vi.fn(async () => ({ sessionId: "session-created" })),
  getSession: vi.fn(async () => ({
    sessionId: "session-busy",
    isStreaming: false,
    model: undefined,
  })),
}));

const PROJECT = "mcp-concurrency";

const closeables: Array<{ close(): Promise<void> }> = [];

const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

function metadata(runId: string): RunMetadata {
  return { runId, prompt: "test", images: [], baseline: { messages: [], contextUsage: null } };
}

async function connect(): Promise<Client> {
  const server = createKadyMcpServer(log);
  const client = new Client({ name: "kady-mcp-concurrency-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closeables.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/** Every tool answers with one JSON text block; this is the only decoding rule. */
function payload(result: { content: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text");
  expect(text).toMatchObject({ type: "text" });
  return JSON.parse(text?.text ?? "") as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
  runBroker.clear();
  vi.mocked(beginRun).mockClear();
});

describe("run_already_active through the MCP adapter", () => {
  it("refuses a second start on a busy session without disturbing the first run", async () => {
    createProject({ projectId: PROJECT, name: "MCP concurrency" });
    const first = runBroker.start(PROJECT, "session-busy", metadata("run-first"));
    first.publish({ type: "run_start", runId: "run-first" });

    const client = await connect();
    const result = await withActiveProject(PROJECT, () =>
      client.callTool({
        name: "start_research_run",
        arguments: { sessionId: "session-busy", message: "second" },
      }),
    );

    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ reason: "run_already_active" });
    // The rejection came from the shared run-start path, not from a
    // reimplementation inside the adapter.
    expect(vi.mocked(beginRun)).toHaveBeenCalledWith(
      "session-busy",
      expect.objectContaining({ message: "second" }),
      expect.anything(),
    );
    // A refused start must not steal, replace, or complete the run in flight.
    const held = runBroker.get(PROJECT, "session-busy");
    expect(held?.state().run?.runId).toBe("run-first");
    expect(held?.isComplete).toBe(false);
  });
});
