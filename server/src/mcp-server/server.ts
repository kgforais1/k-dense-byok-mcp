/**
 * Inbound MCP tool definitions for Kady.
 *
 * Keep handlers thin and return the same domain data used by the HTTP API. The
 * HTTP transport owns connection/session lifecycle in `http.ts`; this module
 * is deliberately transport-independent so its contract can be exercised with
 * the SDK's in-memory transport.
 *
 * Every handler runs inside the Fastify request scope, so `currentProjectId()`
 * and `activePaths()` resolve the same `X-Project-Id` the REST API uses. No
 * tool re-implements agent, billing, or run-ownership logic: `beginRun` is the
 * one run-start path, shared with `POST /sessions/:id/run`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import packageJson from "../../package.json";
import { activePaths, listProjects } from "../projects.ts";
import { currentProjectId } from "../scope.ts";
import { contextUsageForClient } from "../agent/events.ts";
import { runBroker } from "../agent/run-broker.ts";
import { readRunResult } from "../agent/run-results.ts";
import { findSessionFile } from "../agent/session-export.ts";
import { createSession, getSession } from "../agent/session-registry.ts";
import { toHistory } from "../agent/session-history.ts";
import { beginRun, type RunStartRejection } from "../api/sessions.ts";

/** MCP has no typed result channel, so structured payloads travel as JSON text. */
function json(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function failure(message: string, extra?: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }],
  };
}

/**
 * Translate a rejected run start into a tool error.
 *
 * Only the typed `run_already_active` reason — preserved by `runStartFailure`
 * from the broker's `RunAlreadyActiveError`, and by `prepareRun`'s synchronous
 * claim check — becomes the concurrency answer. Every other rejection keeps its
 * own detail, so an unrelated failure is never mislabelled as concurrency.
 */
function rejectionResult(rejection: RunStartRejection): CallToolResult {
  if (rejection.body.reason === "run_already_active") {
    return failure(
      "This session already has a run in flight. Poll it with poll_run, or wait for it to finish before starting another.",
      { reason: "run_already_active" },
    );
  }
  return failure(rejection.body.detail, {
    ...(rejection.body.reason ? { reason: rejection.body.reason } : {}),
  });
}

/**
 * Whether a run produced anything a caller can read.
 *
 * `status: "done"` alone cannot say this: a human watching a chat UI sees an
 * empty bubble and retries, while an MCP client reads `done` as success.
 *
 * Only two frame types carry an answer. Prose arrives as `text_delta` — note
 * `delta`, not `text`: `toClientFrame` maps Pi's `message_update` to
 * `{ type: "text_delta", delta }` (`agent/events.ts:311`), and a first draft of
 * this helper read `frame.text`, which no published frame has. That draft
 * returned `false` for every real run and its tests passed only because they
 * published a frame shape the agent never emits.
 *
 * A successful `tool_end` counts too. A run whose whole answer is an exported
 * notebook or a written file said nothing in prose but did not finish with
 * nothing. `isError` tool results do not count.
 *
 * Everything else — `run_start`, `done`, `turn_*`, `message_*`, `tool_start`,
 * `thinking_delta`, `context_usage`, `cost`, `retry`, `queue_update` — is
 * bookkeeping, not output.
 */
function producedOutput(frames: readonly { type: string; [k: string]: unknown }[]): boolean {
  return frames.some((frame) => {
    if (frame.type === "text_delta") {
      return typeof frame.delta === "string" && frame.delta.trim().length > 0;
    }
    return frame.type === "tool_end" && frame.isError !== true;
  });
}

export function createKadyMcpServer(log: FastifyBaseLogger): McpServer {
  const server = new McpServer({ name: "kady", version: packageJson.version });

  server.registerTool(
    "list_projects",
    {
      title: "List Kady projects",
      description: "List the local Kady projects available to this MCP client.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const projects = listProjects();
      return json({ projects });
    },
  );

  server.registerTool(
    "create_research_session",
    {
      title: "Create a Kady research session",
      description: [
        "Create one Kady research session for this client's research thread and return its session id.",
        "Call this once per thread, then pass the returned sessionId to start_research_run, poll_run, and get_session_history.",
        "Do not call it per run or per poll: each project keeps at most 10 live sessions.",
        "The session is headless — the interactive `interview` tool is disabled because no human is watching a chat UI to answer it.",
      ].join(" "),
      // Deliberately no `inputSchema`. An empty shape (`{}`) is not the same as
      // omitting the key: the SDK builds a validating object schema from it and
      // then rejects a call that sends no arguments at all, which is exactly how
      // a client invokes a no-argument tool.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const session = await createSession(currentProjectId(), activePaths(), {
        includeInterview: false,
      });
      // Deliberately not `session.sessionFile`. It is an absolute host path,
      // the client only ever echoes `sessionId` back to the other tools, and
      // the guardrail is that tools return no more host detail than they must.
      return json({ sessionId: session.sessionId, interviewDisabled: true });
    },
  );

  server.registerTool(
    "get_session_history",
    {
      title: "Get a Kady session transcript",
      description: [
        "Return the WHOLE persisted transcript for a session, plus its context usage.",
        "To read only what a specific run produced, use poll_run with an `after` cursor instead — this tool re-sends everything each time.",
      ].join(" "),
      inputSchema: {
        sessionId: z.string().describe("Session id returned by create_research_session."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ sessionId }) => {
      const projectId = currentProjectId();
      const paths = activePaths();
      const file = findSessionFile(paths, sessionId);
      if (!file) return failure("No such session", { sessionId });
      const session = await getSession(projectId, paths, sessionId);
      return json({
        sessionId,
        messages: toHistory(file, paths.sandbox),
        contextUsage: session ? contextUsageForClient(session) ?? null : null,
      });
    },
  );

  server.registerTool(
    "start_research_run",
    {
      title: "Start a Kady research run",
      description: [
        "Start a research run on an existing session and return immediately with its runId.",
        "The run is owned by the server, not by this call, so it keeps going after this tool returns.",
        "Poll it with poll_run until the status is no longer `running`.",
      ].join(" "),
      inputSchema: {
        sessionId: z.string().describe("Session id returned by create_research_session."),
        message: z.string().describe("The research request to send to Kady."),
        model: z
          .string()
          .optional()
          .describe("Model id override; defaults to the session's current model."),
        thinkingLevel: z.string().optional().describe("Thinking level override."),
        images: z
          .array(z.object({ data: z.string(), mimeType: z.string() }))
          .optional()
          .describe(
            "Inline image attachments as base64 `data` plus `mimeType`. Mirrors the REST run body, so image-carrying research is not silently downgraded to text-only.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ sessionId, message, model, thinkingLevel, images }) => {
      const started = await beginRun(sessionId, { message, model, thinkingLevel, images }, log);
      if ("failure" in started) return rejectionResult(started.failure);
      return json({ sessionId, runId: started.runId, status: "running" });
    },
  );

  server.registerTool(
    "poll_run",
    {
      title: "Poll a Kady research run",
      description: [
        "Return a run's status and the frames produced since `after`.",
        "Statuses: `running` (poll again), `done`, `aborted`, `unknown` (no such run in this project), or one of two distinct failures.",
        "`blocked` means a project spend cap stopped the run: its terminal frame is `{type:\"error\", kind:\"budget\"}` and raising the limit is what unblocks it.",
        "`error` means anything else failed, including a provider refusal — that frame has no `kind`, and its `message` already carries the guidance for what to do about it. Read the terminal frame's `message` in both cases.",
        "Pass the returned `lastSeq` back as `after` on the next call to receive only new frames.",
        "This keeps working after the in-memory broker drops the run: completed runs are also persisted durably.",
        "`done`, `aborted`, `blocked` and `error` also carry `producedOutput`: whether the run emitted any assistant prose or any successful tool result. `running` and `unknown` do not carry it at all — nothing is knowable yet in the first case, and there is no record to read in the second. Test for the key, not for a falsy value.",
        "`done` with `producedOutput: false` is a run that finished with nothing — retry it, do not report it as an answer.",
        "`status` stays authoritative: on `error`, `blocked` or `aborted`, `producedOutput: true` only means partial output arrived before the run stopped.",
      ].join(" "),
      inputSchema: {
        sessionId: z.string().describe("Session id the run belongs to."),
        runId: z.string().describe("Run id returned by start_research_run."),
        after: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Return only frames with a sequence number greater than this. Defaults to 0."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ sessionId, runId, after = 0 }) => {
      const projectId = currentProjectId();

      // The live broker is authoritative while it still holds this run. It is
      // checked first so an in-flight run is never answered from the durable
      // snapshot, which only exists once the run is already terminal.
      const handle = runBroker.get(projectId, sessionId);
      const live = handle?.state();
      if (handle && live?.run?.runId === runId) {
        // `activityState` alone reports an aborted run as `done`, because an
        // abort publishes no error frame. The durable record does distinguish
        // it, so the abort check is applied here too — otherwise the same run
        // answers `done` before the broker expires it and `aborted` after.
        // The same "an aborted run is not a done run" rule the durable record
        // applies in `persistRunResult` (`agent/run-results.ts`), but not the
        // same expression: that one runs only at a terminal moment and folds
        // `running` into `done`, while this one must still be able to answer
        // `running`. Change either and check the other.
        const status =
          handle.isAbortRequested && handle.isComplete ? "aborted" : handle.activityState;
        const result: Record<string, unknown> = {
          sessionId,
          runId,
          status,
          frames: live.run.frames.filter((frame) => frame.seq > after),
          lastSeq: live.run.lastSeq,
        };
        // Computed over the whole frame list, never the `after` slice: a client
        // polling with a cursor would otherwise be told the run produced
        // nothing simply because it had already consumed the frames. Omitted
        // entirely while the run is `running`, where the answer is not yet
        // knowable and `false` would read as a verdict.
        if (status !== "running") {
          result.producedOutput = producedOutput(live.run.frames);
        }
        return json(result);
      }

      // Past the broker's ~30s completed-run retention the durable record is
      // the only source. An unknown runId stays distinct from an expired one:
      // this returns `unknown` only when no record was ever written.
      // Durable records are keyed by `runId` alone, so the session is checked
      // here rather than trusted: polling a real run id under the wrong session
      // must not hand back another session's transcript.
      const durable = readRunResult(projectId, runId);
      if (!durable || durable.sessionId !== sessionId) {
        return json({ sessionId, runId, status: "unknown", frames: [], lastSeq: 0 });
      }
      return json({
        sessionId: durable.sessionId,
        runId,
        status: durable.status,
        frames: durable.frames.filter((frame) => frame.seq > after),
        lastSeq: durable.lastSeq,
        completedAt: durable.completedAt,
        producedOutput: producedOutput(durable.frames),
      });
    },
  );

  return server;
}
