import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FastifyBaseLogger } from "fastify";
import packageJson from "../package.json";

import { createProject } from "../src/projects.ts";
import { withActiveProject } from "../src/scope.ts";
import { RunBroker, runBroker, type RunMetadata } from "../src/agent/run-broker.ts";
import { persistRunResult } from "../src/agent/run-results.ts";
import { createKadyMcpServer } from "../src/mcp-server/server.ts";
import { beginRun } from "../src/api/sessions.ts";
import { createSession } from "../src/agent/session-registry.ts";

vi.mock("../src/api/sessions.ts", () => ({ beginRun: vi.fn() }));
// A real Pi session needs a model runtime; the adapter contract under test is
// only that it asks for a headless one and returns the id it gets back.
vi.mock("../src/agent/session-registry.ts", () => ({
  createSession: vi.fn(async () => ({
    sessionId: "session-headless",
    sessionFile: "/tmp/session-headless.jsonl",
  })),
  getSession: vi.fn(async () => null),
}));

const PHASE_2_TOOLS = [
  "list_projects",
  "create_research_session",
  "get_session_history",
  "start_research_run",
  "poll_run",
];

const closeables: Array<{ close(): Promise<void> }> = [];

/** The adapter only ever forwards this to `beginRun`; nothing calls it in tests. */
const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

function metadata(runId: string): RunMetadata {
  return { runId, prompt: "test", images: [], baseline: { messages: [], contextUsage: null } };
}

async function connect(): Promise<Client> {
  const server = createKadyMcpServer(log);
  const client = new Client({ name: "kady-mcp-contract-test", version: "1.0.0" });
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
  vi.mocked(beginRun).mockReset();
});

describe("inbound MCP Phase 2 tool contract", () => {
  it("serves the whole decided Phase 2 tool subset", async () => {
    const client = await connect();

    expect(client.getServerVersion()).toMatchObject({ version: packageJson.version });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(PHASE_2_TOOLS));
  });

  it("serves list_projects through the SDK server contract", async () => {
    createProject({ projectId: "mcp-contract", name: "MCP contract" });
    const client = await connect();

    const result = await client.callTool({ name: "list_projects" });
    expect(payload(result)).toMatchObject({
      projects: expect.arrayContaining([expect.objectContaining({ id: "mcp-contract" })]),
    });
  });

  it("declares an images parameter on start_research_run so runs are not text-only", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === "start_research_run",
    );

    const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;
    expect(Object.keys(properties ?? {})).toEqual(
      expect.arrayContaining(["sessionId", "message", "images"]),
    );
    expect(tool?.inputSchema.required).toEqual(
      expect.arrayContaining(["sessionId", "message"]),
    );
  });

  it("lets a client invoke the no-argument tools with no arguments at all", async () => {
    // Regression: `inputSchema: {}` is not the same as omitting the key. The
    // SDK builds a validating object schema from an empty shape and then
    // rejects a call that sends no `arguments` — which is exactly how a real
    // client invokes a no-argument tool. The in-memory contract tests missed
    // this originally because they only *listed* these tools; the external
    // client check caught it. So this calls them.
    createProject({ projectId: "mcp-noargs", name: "MCP no args" });
    const client = await connect();

    const listed = await withActiveProject("mcp-noargs", () =>
      client.callTool({ name: "list_projects" }),
    );
    expect(listed.isError).toBeFalsy();

    const created = await withActiveProject("mcp-noargs", () =>
      client.callTool({ name: "create_research_session" }),
    );
    expect(created.isError).toBeFalsy();
    const body = payload(created);
    expect(body).toMatchObject({ sessionId: "session-headless", interviewDisabled: true });
    // No absolute host path in the tool result.
    expect(body.sessionFile).toBeUndefined();
  });

  it("scopes every call to its own request header, not to the connection", async () => {
    // One MCP connection can address several projects: scope is resolved
    // per-request from `X-Project-Id`, exactly as the REST API does. Pinning
    // this in a test because the transport used to cache the initializing
    // request's project id, which nothing consumed and which could disagree
    // with the request actually being served.
    createProject({ projectId: "mcp-scope-a", name: "Scope A" });
    createProject({ projectId: "mcp-scope-b", name: "Scope B" });
    const client = await connect();

    const underA = await withActiveProject("mcp-scope-a", () =>
      client.callTool({ name: "poll_run", arguments: { sessionId: "s", runId: "r" } }),
    );
    const underB = await withActiveProject("mcp-scope-b", () =>
      client.callTool({ name: "create_research_session" }),
    );
    expect(payload(underA)).toMatchObject({ status: "unknown" });
    expect(underB.isError).toBeFalsy();
    expect(vi.mocked(createSession).mock.calls.at(-1)?.[0]).toBe("mcp-scope-b");
  });

  it("reports a missing session rather than inventing one", async () => {
    createProject({ projectId: "mcp-history", name: "MCP history" });
    const client = await connect();

    const result = await withActiveProject("mcp-history", () =>
      client.callTool({ name: "get_session_history", arguments: { sessionId: "nope" } }),
    );
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ error: "No such session" });
  });
});

describe("start_research_run failure mapping", () => {
  it("returns the run id without waiting for the run to finish", async () => {
    vi.mocked(beginRun).mockResolvedValue({ runId: "run-mcp-1" } as never);
    const client = await connect();

    const result = await client.callTool({
      name: "start_research_run",
      arguments: { sessionId: "session-1", message: "survey the literature" },
    });
    expect(result.isError).toBeFalsy();
    expect(payload(result)).toMatchObject({ runId: "run-mcp-1", status: "running" });
  });

  it("forwards image attachments to the shared run path", async () => {
    vi.mocked(beginRun).mockResolvedValue({ runId: "run-mcp-img" } as never);
    const client = await connect();

    await client.callTool({
      name: "start_research_run",
      arguments: {
        sessionId: "session-1",
        message: "read this figure",
        images: [{ data: "aGk=", mimeType: "image/png" }],
      },
    });
    expect(vi.mocked(beginRun).mock.calls[0]?.[1]).toMatchObject({
      images: [{ data: "aGk=", mimeType: "image/png" }],
    });
  });

  it("maps only the typed concurrency rejection to the run-already-active answer", async () => {
    vi.mocked(beginRun).mockResolvedValue({
      failure: {
        statusCode: 409,
        body: { detail: "Session is already streaming a response", reason: "run_already_active" },
      },
    } as never);
    const client = await connect();

    const result = await client.callTool({
      name: "start_research_run",
      arguments: { sessionId: "session-1", message: "again" },
    });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ reason: "run_already_active" });
  });

  it("preserves an unrelated start failure instead of mislabelling it as concurrency", async () => {
    vi.mocked(beginRun).mockResolvedValue({
      failure: { statusCode: 500, body: { detail: "publish exploded" } },
    } as never);
    const client = await connect();

    const result = await client.callTool({
      name: "start_research_run",
      arguments: { sessionId: "session-1", message: "again" },
    });
    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body).toMatchObject({ error: "publish exploded" });
    expect(body.reason).toBeUndefined();
  });

  it("keeps a provider/auth rejection distinct from both of those", async () => {
    vi.mocked(beginRun).mockResolvedValue({
      failure: {
        statusCode: 401,
        body: { detail: "Anthropic is not connected", reason: "provider_not_connected" },
      },
    } as never);
    const client = await connect();

    const result = await client.callTool({
      name: "start_research_run",
      arguments: { sessionId: "session-1", message: "go" },
    });
    expect(payload(result)).toMatchObject({
      error: "Anthropic is not connected",
      reason: "provider_not_connected",
    });
  });
});

describe("poll_run", () => {
  it("reads the live broker while the run is in flight and honours the cursor", async () => {
    createProject({ projectId: "mcp-poll", name: "MCP poll" });
    const handle = runBroker.start("mcp-poll", "session-live", metadata("run-live"));
    handle.publish({ type: "run_start", runId: "run-live" });
    handle.publish({ type: "text", text: "thinking" } as never);
    const client = await connect();

    const first = await withActiveProject("mcp-poll", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-live", runId: "run-live" },
      }),
    );
    const firstBody = payload(first);
    expect(firstBody).toMatchObject({ status: "running", lastSeq: 2 });
    expect(firstBody.frames).toHaveLength(2);

    const second = await withActiveProject("mcp-poll", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-live", runId: "run-live", after: 2 },
      }),
    );
    expect(payload(second).frames).toHaveLength(0);
  });

  it("surfaces a budget-blocked run from its terminal frame, not an HTTP status", async () => {
    createProject({ projectId: "mcp-budget", name: "MCP budget" });
    const handle = runBroker.start("mcp-budget", "session-budget", metadata("run-budget"));
    handle.publish({ type: "error", kind: "budget", message: "Project spend limit reached" });
    const client = await connect();

    const result = await withActiveProject("mcp-budget", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-budget", runId: "run-budget" },
      }),
    );
    const body = payload(result);
    expect(body).toMatchObject({ status: "blocked" });
    expect(body.frames).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "error", kind: "budget" })]),
    );
  });

  it("reports a provider refusal as `error`, not `blocked`", async () => {
    // Only `kind: "budget"` maps to `blocked` (run-broker.ts:132). A refusal
    // frame has no `kind`, so it is an `error`. The two mean different things
    // to a calling agent -- a cap is fixed by raising the limit, a refusal is
    // not -- and poll_run's own description promises that split.
    createProject({ projectId: "mcp-refusal", name: "MCP refusal" });
    const handle = runBroker.start("mcp-refusal", "session-refusal", metadata("run-refusal"));
    handle.publish({ type: "error", message: "Provider refused the request" });
    const client = await connect();

    const result = await withActiveProject("mcp-refusal", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-refusal", runId: "run-refusal" },
      }),
    );
    const body = payload(result);
    expect(body).toMatchObject({ status: "error" });
    expect(body.status).not.toBe("blocked");
  });

  it("documents the blocked/error split the broker actually implements", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "poll_run");
    const description = tool?.description ?? "";

    // The description is read by other AI agents, so a wrong one is a defect.
    expect(description).toMatch(/`blocked` means a project spend cap/);
    expect(description).toMatch(/`error` means anything else failed, including a provider refusal/);
  });

  it("falls back to the durable record once the broker has dropped the run", async () => {
    createProject({ projectId: "mcp-durable", name: "MCP durable" });
    // A separate broker stands in for the global one having already expired the
    // handle: the global broker below knows nothing about this run.
    const expired = new RunBroker({ completedRetentionMs: 1 });
    const handle = expired.start("mcp-durable", "session-durable", metadata("run-durable"));
    handle.publish({ type: "done" });
    handle.complete();
    persistRunResult("mcp-durable", handle);
    const client = await connect();

    const result = await withActiveProject("mcp-durable", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-durable", runId: "run-durable" },
      }),
    );
    expect(payload(result)).toMatchObject({
      runId: "run-durable",
      sessionId: "session-durable",
      status: "done",
    });
  });

  it("keeps an unknown run id distinct from an expired completed one", async () => {
    createProject({ projectId: "mcp-unknown", name: "MCP unknown" });
    const client = await connect();

    const result = await withActiveProject("mcp-unknown", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-x", runId: "never-existed" },
      }),
    );
    expect(payload(result)).toMatchObject({ status: "unknown", frames: [], lastSeq: 0 });
  });

  it("reports producedOutput: false on a done run with no content frames", async () => {
    createProject({ projectId: "mcp-empty-done", name: "MCP empty done" });
    const handle = runBroker.start("mcp-empty-done", "session-empty", metadata("run-empty"));
    handle.publish({ type: "run_start", runId: "run-empty" });
    handle.publish({ type: "done" });
    handle.complete();
    const client = await connect();

    const result = await withActiveProject("mcp-empty-done", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-empty", runId: "run-empty" },
      }),
    );
    expect(payload(result)).toMatchObject({ status: "done", producedOutput: false });
  });

  it("reports producedOutput: true on a done run that published real prose via the durable path", async () => {
    createProject({ projectId: "mcp-text-durable", name: "MCP text durable" });
    const expired = new RunBroker({ completedRetentionMs: 1 });
    const handle = expired.start("mcp-text-durable", "session-text", metadata("run-text"));
    handle.publish({ type: "text_delta", delta: "Here is the answer" } as never);
    handle.complete();
    persistRunResult("mcp-text-durable", handle);
    const client = await connect();

    const result = await withActiveProject("mcp-text-durable", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-text", runId: "run-text" },
      }),
    );
    expect(payload(result)).toMatchObject({ status: "done", producedOutput: true });
  });

  it("reports producedOutput: false when the only prose delta is whitespace", async () => {
    createProject({ projectId: "mcp-whitespace", name: "MCP whitespace" });
    const handle = runBroker.start("mcp-whitespace", "session-ws", metadata("run-ws"));
    handle.publish({ type: "text_delta", delta: "   " } as never);
    handle.complete();
    const client = await connect();

    const result = await withActiveProject("mcp-whitespace", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-ws", runId: "run-ws" },
      }),
    );
    expect(payload(result)).toMatchObject({ status: "done", producedOutput: false });
  });

  it("reports producedOutput: true even when the cursor has passed the content frame", async () => {
    createProject({ projectId: "mcp-cursor", name: "MCP cursor" });
    const handle = runBroker.start("mcp-cursor", "session-cursor", metadata("run-cursor"));
    handle.publish({ type: "run_start", runId: "run-cursor" });
    handle.publish({ type: "text_delta", delta: "answer" } as never);
    handle.complete();
    const client = await connect();

    const first = await withActiveProject("mcp-cursor", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-cursor", runId: "run-cursor" },
      }),
    );
    expect(payload(first)).toMatchObject({ status: "done", producedOutput: true });

    const second = await withActiveProject("mcp-cursor", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-cursor", runId: "run-cursor", after: 2 },
      }),
    );
    expect(payload(second)).toMatchObject({ status: "done", producedOutput: true });
  });

  it("omits producedOutput while the run is still running", async () => {
    createProject({ projectId: "mcp-running", name: "MCP running" });
    const handle = runBroker.start("mcp-running", "session-running", metadata("run-running"));
    handle.publish({ type: "run_start", runId: "run-running" });
    const client = await connect();

    const result = await withActiveProject("mcp-running", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-running", runId: "run-running" },
      }),
    );
    const body = payload(result);
    expect(body).toMatchObject({ status: "running" });
    expect(body).not.toHaveProperty("producedOutput");
  });

  it("counts a successful tool result as output even with no prose", async () => {
    // A run whose whole answer is an exported notebook or a written file said
    // nothing but did not finish with nothing.
    createProject({ projectId: "mcp-tool-only", name: "MCP tool only" });
    const handle = runBroker.start("mcp-tool-only", "session-tool", metadata("run-tool"));
    handle.publish({ type: "run_start", runId: "run-tool" });
    handle.publish({
      type: "tool_end",
      toolCallId: "c1",
      toolName: "notebook",
      isError: false,
    } as never);
    handle.complete();
    const client = await connect();

    const result = await withActiveProject("mcp-tool-only", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-tool", runId: "run-tool" },
      }),
    );
    expect(payload(result)).toMatchObject({ status: "done", producedOutput: true });
  });

  it("does not count a failed tool result as output", async () => {
    createProject({ projectId: "mcp-tool-fail", name: "MCP tool fail" });
    const handle = runBroker.start("mcp-tool-fail", "session-fail", metadata("run-fail"));
    handle.publish({
      type: "tool_end",
      toolCallId: "c1",
      toolName: "read",
      isError: true,
    } as never);
    handle.complete();
    const client = await connect();

    const result = await withActiveProject("mcp-tool-fail", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-fail", runId: "run-fail" },
      }),
    );
    expect(payload(result)).toMatchObject({ status: "done", producedOutput: false });
  });

  it("reads prose from `delta`, which is the field the agent actually publishes", async () => {
    // Regression: the first version of this check read `frame.text`. No frame
    // the agent emits has that field -- `toClientFrame` publishes
    // `{ type: "text_delta", delta }` (agent/events.ts:311) -- so it reported
    // every real run as having produced nothing, and its tests passed only
    // because they published a frame shape that does not exist. A frame
    // carrying `text` instead of `delta` must not count.
    createProject({ projectId: "mcp-delta", name: "MCP delta" });
    const handle = runBroker.start("mcp-delta", "session-delta", metadata("run-delta"));
    handle.publish({ type: "text_delta", text: "not the real field" } as never);
    handle.complete();
    const client = await connect();

    const result = await withActiveProject("mcp-delta", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-delta", runId: "run-delta" },
      }),
    );
    expect(payload(result)).toMatchObject({ status: "done", producedOutput: false });
  });

  it("describes producedOutput in the poll_run tool description", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "poll_run");
    const description = tool?.description ?? "";
    expect(description).toMatch(/producedOutput/);
    expect(description).toMatch(/`status` stays authoritative/);
  });
});

describe("poll_run session binding", () => {
  it("does not hand back another session's run when the session id does not match", async () => {
    createProject({ projectId: "mcp-crossed", name: "MCP crossed" });
    const expired = new RunBroker({ completedRetentionMs: 1 });
    const handle = expired.start("mcp-crossed", "session-owner", metadata("run-crossed"));
    handle.publish({ type: "done" });
    handle.complete();
    persistRunResult("mcp-crossed", handle);
    const client = await connect();

    const result = await withActiveProject("mcp-crossed", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-intruder", runId: "run-crossed" },
      }),
    );
    expect(payload(result)).toMatchObject({ status: "unknown", frames: [] });
  });
});

describe("poll_run abort reporting", () => {
  it("reports an aborted run the same way before and after the broker expires it", async () => {
    createProject({ projectId: "mcp-abort", name: "MCP abort" });
    const handle = runBroker.start("mcp-abort", "session-abort", metadata("run-abort"));
    handle.publish({ type: "run_start", runId: "run-abort" });
    handle.requestAbort();
    handle.complete();
    const client = await connect();

    // Live: the broker still holds the handle.
    const live = await withActiveProject("mcp-abort", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-abort", runId: "run-abort" },
      }),
    );
    expect(payload(live)).toMatchObject({ status: "aborted" });

    // Durable: what the same poll returns once retention has expired.
    persistRunResult("mcp-abort", handle);
    runBroker.clear();
    const durable = await withActiveProject("mcp-abort", () =>
      client.callTool({
        name: "poll_run",
        arguments: { sessionId: "session-abort", runId: "run-abort" },
      }),
    );
    expect(payload(durable)).toMatchObject({ status: "aborted" });
  });
});
