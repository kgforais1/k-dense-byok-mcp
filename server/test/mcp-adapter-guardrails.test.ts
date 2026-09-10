/**
 * Property test: no MCP tool result may carry an absolute host path.
 *
 * Gitleaks scans source and can never see runtime output, so a new tool — or a
 * new frame type that happens to carry a path — would go green through the
 * whole pipeline. `mcp-server-tools.test.ts` pins the one known near-miss,
 * `create_research_session` returning `sessionFile`; that is an assertion about
 * a single field, not the property.
 *
 * Cases, not one entry per tool: a tool can leak on one branch and not another,
 * so `get_session_history` gets a real transcript, `start_research_run` gets
 * both its success and its rejection, and `poll_run` gets both the live broker
 * and the durable fallback. Every registered tool must still appear in at least
 * one case, which is what stops a tool added later from escaping silently.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FastifyBaseLogger } from "fastify";

import { PROJECTS_ROOT } from "../src/config.ts";
import { activePaths, createProject } from "../src/projects.ts";
import { withActiveProject } from "../src/scope.ts";
import { RunBroker, runBroker, type RunMetadata } from "../src/agent/run-broker.ts";
import { persistRunResult } from "../src/agent/run-results.ts";
import { toClientFrame } from "../src/agent/events.ts";
import { createKadyMcpServer } from "../src/mcp-server/server.ts";
import { beginRun } from "../src/api/sessions.ts";

vi.mock("../src/api/sessions.ts", () => ({ beginRun: vi.fn() }));
// Only the two functions that need a model runtime are replaced. `listSessions`
// and `deleteSession` stay real: both read what is actually on disk, and a
// stub returning invented rows would make their cases below unable to detect a
// leak at all. `getSession` returning null only costs this test the
// `contextUsage` field; the transcript is read from disk by
// `findSessionFile`/`toHistory`, which is the path under test.
vi.mock("../src/agent/session-registry.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/agent/session-registry.ts")>()),
  createSession: vi.fn(async () => ({
    sessionId: "session-headless",
    sessionFile: "/tmp/session-headless.jsonl",
  })),
  getSession: vi.fn(async () => null),
}));

const PROJECT = "mcp-hostpath";

/**
 * Absolute host paths that must not survive into a tool result.
 *
 * `PROJECTS_ROOT` is the load-bearing check: under vitest it is an OS temp
 * directory, so a `/Users/` regex alone would never fire. The regex is the
 * backstop for a path from somewhere else entirely, and lists both temp roots
 * — macOS runners use `/var/folders`, Linux runners use `/tmp`.
 */
const HOST_PATH_REGEX = /(?:\/Users\/|\/home\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\\\)/;

interface ToolCase {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  setUp?: () => void;
  /**
   * Checked before the leak assertions.
   *
   * A tool that returns nothing passes a "carries no host path" test for the
   * wrong reason, so a case whose fixture could silently produce an empty
   * result says here what it expects to have found.
   */
  expect?: (serialized: string) => void;
}

const closeables: Array<{ close(): Promise<void> }> = [];

/** The adapter only ever forwards this to `beginRun`; nothing calls it here. */
const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

function metadata(runId: string): RunMetadata {
  return { runId, prompt: "test", images: [], baseline: { messages: [], contextUsage: null } };
}

/**
 * A `tool_start` frame carrying a sandbox-absolute path, run through the same
 * `toClientFrame` the run pipeline uses.
 *
 * `poll_run` forwards broker frames verbatim, so its only defence against a
 * host path is that whatever was published was relativized on the way in.
 * A fixture with no path in it cannot test that at all.
 */
function toolStartFrame(sessionId: string): Record<string, unknown> {
  const sandbox = activePaths().sandbox;
  const frame = toClientFrame(
    {
      type: "tool_execution_start",
      toolCallId: `call-${sessionId}`,
      toolName: "bash",
      args: { command: `wc -l ${path.join(sandbox, "data/out.csv")}` },
    } as never,
    sandbox,
  );
  return frame as unknown as Record<string, unknown>;
}

async function connect(): Promise<Client> {
  const server = createKadyMcpServer(log);
  const client = new Client({ name: "kady-mcp-hostpath-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closeables.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/**
 * A stored transcript whose tool call and tool result both name a file by its
 * sandbox-absolute path — deliberately, because that is what Pi writes. The
 * relativization in `toHistory` -> `relativizeSandboxPaths` is the only thing
 * standing between it and the client, and this fixture is what exercises it.
 */
function writeTranscript(): void {
  const paths = activePaths();
  const file = path.join(paths.sandbox, "data/out.csv");
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  // A second, disposable transcript so `delete_research_session` can be
  // exercised on its success branch without removing the one every other case
  // reads.
  fs.writeFileSync(
    path.join(paths.sessionsDir, "20260909-101600_session-doomed.jsonl"),
    `${JSON.stringify({ type: "session", version: 3, id: "session-doomed", timestamp: "2026-09-09T10:16:00.000Z", cwd: paths.sandbox })}\n`,
  );
  fs.writeFileSync(
    path.join(paths.sessionsDir, "20260909-101500_session-headless.jsonl"),
    [
      // Pi writes this header when it creates the file, and refuses to load a
      // transcript without one. A fixture that skips it is not a shape the
      // agent can produce.
      // `cwd` matters to `SessionManager.list`, which drops any session whose
      // header cwd is not this project's sandbox. Without it the
      // `list_research_sessions` case below would list nothing and could not
      // detect a leak.
      {
        type: "session",
        version: 3,
        id: "session-headless",
        timestamp: "2026-09-09T10:15:00.000Z",
        cwd: paths.sandbox,
      },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "read it" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: file } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "text", text: `wrote ${file}` }],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
}

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
  runBroker.clear();
  vi.mocked(beginRun).mockReset();
});

describe("no MCP tool result carries an absolute host path", () => {
  it("holds for every registered tool, on both its success and its failure branch", async () => {
    createProject({ projectId: PROJECT, name: "MCP host path" });
    withActiveProject(PROJECT, writeTranscript);

    const cases: ToolCase[] = [
      { name: "list_projects", tool: "list_projects", args: {} },
      { name: "create_research_session", tool: "create_research_session", args: {} },
      {
        name: "get_session_history (real transcript)",
        tool: "get_session_history",
        args: { sessionId: "session-headless" },
      },
      {
        name: "start_research_run (started)",
        tool: "start_research_run",
        args: { sessionId: "session-headless", message: "hi" },
        setUp: () => vi.mocked(beginRun).mockResolvedValueOnce({ runId: "run-1" } as never),
      },
      {
        // Error bodies are where a raw filesystem error is likeliest to bleed
        // a path through, and the success case never reaches `rejectionResult`.
        name: "start_research_run (rejected)",
        tool: "start_research_run",
        args: { sessionId: "session-headless", message: "hi" },
        setUp: () =>
          vi
            .mocked(beginRun)
            .mockResolvedValueOnce({
              failure: { statusCode: 500, body: { detail: "read failed" } },
            } as never),
      },
      {
        name: "poll_run (live broker)",
        tool: "poll_run",
        args: { sessionId: "session-live", runId: "run-live" },
        setUp: () => {
          const handle = runBroker.start(PROJECT, "session-live", metadata("run-live"));
          handle.publish({ type: "run_start", runId: "run-live" });
          // Built through the real `toClientFrame`, from an event whose args
          // carry a sandbox-absolute path. Publishing a path-free frame would
          // make this case unable to detect a leak at all: there would be
          // nothing in the fixture for `poll_run` to leak.
          handle.publish(toolStartFrame("session-live"));
        },
      },
      {
        // Real `listSessions`, so this reads the transcripts written above and
        // the row it returns is the one a client would get. `firstMessage` is
        // the field worth the check: it is transcript prose, and nothing
        // relativizes it on the way out.
        name: "list_research_sessions",
        tool: "list_research_sessions",
        args: {},
        expect: (serialized) => expect(serialized).toContain("session-headless"),
      },
      {
        name: "delete_research_session (deleted)",
        tool: "delete_research_session",
        args: { sessionId: "session-doomed" },
      },
      {
        // The error branch, where a raw filesystem or validation message is
        // likeliest to carry a path. An id this shape is refused before any
        // path is built, and the message must not name the directory it was
        // refused from.
        name: "delete_research_session (refused)",
        tool: "delete_research_session",
        args: { sessionId: "../escape" },
      },
      {
        // The durable branch reads frames back off disk, which the live case
        // skips entirely.
        name: "poll_run (durable record)",
        tool: "poll_run",
        args: { sessionId: "session-durable", runId: "run-durable" },
        setUp: () => {
          const expired = new RunBroker({ completedRetentionMs: 1 });
          const handle = expired.start(PROJECT, "session-durable", metadata("run-durable"));
          handle.publish(toolStartFrame("session-durable"));
          handle.publish({ type: "done" });
          handle.complete();
          persistRunResult(PROJECT, handle);
        },
      },
    ];

    const client = await connect();
    const registered = (await client.listTools()).tools.map((tool) => tool.name);
    const covered = new Set(cases.map((entry) => entry.tool));
    expect([...registered].sort()).toEqual([...covered].sort());

    for (const entry of cases) {
      entry.setUp?.();
      const result = await withActiveProject(PROJECT, () =>
        client.callTool({ name: entry.tool, arguments: entry.args }),
      );
      // The whole result, not the decoded payload: an error message is a leak
      // surface too.
      const serialized = JSON.stringify(result);
      entry.expect?.(serialized);
      expect(serialized, `${entry.name} leaked PROJECTS_ROOT`).not.toContain(PROJECTS_ROOT);
      expect(serialized, `${entry.name} leaked a host path`).not.toMatch(HOST_PATH_REGEX);
    }
  });
});
