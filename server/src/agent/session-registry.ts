/**
 * Live AgentSession registry.
 *
 * Each chat tab maps to one Pi AgentSession persisted as a JSONL file under the
 * project's `sandbox/.pi/sessions/`. We hold the live session objects in a Map
 * (keyed by projectId:sessionId) so streaming runs reuse warm state, and
 * cold-open from disk after a restart. ModelRuntime + ModelRegistry are process
 * singletons sharing Kady's OpenRouter runtime key and Pi OAuth store.
 */
import fs from "node:fs";
import path from "node:path";
import {
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { KADY_PI_AGENT_DIR } from "../config.ts";
import type { ProjectPaths } from "../projects.ts";
import { getMcpTools } from "./mcp.ts";
import { defaultModel, setupModelRuntime } from "./models.ts";
import { seedAgentFiles } from "./agent-files.ts";
import {
  forgetHeadlessSession,
  isHeadlessSession,
  markHeadlessSession,
} from "./headless-sessions.ts";
import { makeInterviewTool } from "./interview.ts";
import { makeNotebookTool } from "./notebook.ts";
import { makeScientificResultTool } from "./scientific-result.ts";
import { clearSessionCompute, makeModalTools, MODAL_TOOL_NAMES } from "./modal-tool.ts";
import {
  makeSubagentLedgerExtension,
  makeSubagentRefusalExtension,
  subagentsExtensionPath,
} from "./subagent-bridge.ts";
import { makeFusionRequestExtension } from "./fusion-bridge.ts";
import { WEB_ACCESS_TOOLS, ensureWebAccess } from "./web-access-bridge.ts";
import {
  seedNotebookPackage,
  seedBuiltinAgentNotebookTools,
  makeSubagentNotebookExtension,
} from "./notebook-bridge.ts";
import { makeSubagentProvenanceExtension } from "../provenance/bridge.ts";
import {
  makeSubagentModalExtension,
  seedBuiltinAgentModalTools,
  seedModalPackage,
} from "./modal-bridge.ts";
import { findSessionFile, isSafeSessionId } from "./session-export.ts";
import { notebookAnnotationsPath } from "./notebook-annotations.ts";
import { notebookPath } from "./notebook-store.ts";
import { provenanceSessionDir } from "../provenance/store.ts";
import { forgetSessionRunResults } from "./run-results.ts";
import { setSessionRunId } from "./run-ids.ts";
import { runBroker } from "./run-broker.ts";
import {
  makePdfAnnotationTools,
  PDF_ANNOTATION_TOOL_NAMES,
} from "./pdf-annotation-tool.ts";
import {
  seedBuiltinAgentPdfAnnotationTools,
  seedPdfAnnotationPackage,
} from "./pdf-annotation-bridge.ts";
import { BUILTIN_TOOLS } from "./tools.ts";

// Entry points normally establish this in env.ts. Keep the registry safe when
// imported directly (tests/scripts) so child Pi processes still share the same
// Kady-scoped auth store as the in-process runtime.
process.env.PI_CODING_AGENT_DIR ??= KADY_PI_AGENT_DIR;

// pi-subagents runs each delegation as a child `pi` CLI process. The binary
// ships with our pi-coding-agent dependency; make sure spawn("pi") resolves
// even when the server wasn't started through an npm script.
const localBin = path.resolve(import.meta.dirname, "..", "..", "node_modules", ".bin");
if (!(process.env.PATH ?? "").split(path.delimiter).includes(localBin)) {
  process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH ?? ""}`;
}

const modelRuntime = await ModelRuntime.create({
  allowModelNetwork: false,
  authPath: path.join(KADY_PI_AGENT_DIR, "auth.json"),
});
await setupModelRuntime(modelRuntime);
const modelRegistry = new ModelRegistry(modelRuntime);

export function getModelRuntime(): ModelRuntime {
  return modelRuntime;
}
export function getModelRegistry(): ModelRegistry {
  return modelRegistry;
}

/** Max live (in-memory) sessions kept per project; oldest idle ones are evicted. */
const MAX_LIVE_PER_PROJECT = 10;

// Insertion-ordered Map doubles as an LRU: we delete+re-set an entry on access
// so the first matching key for a project is always the least-recently-used.
const live = new Map<string, AgentSession>();
const keyFor = (projectId: string, sessionId: string) => `${projectId}:${sessionId}`;

// Sessions with a claimed run. A run holds its claim across async model setup
// before `isStreaming` ever flips, so eviction cannot rely on isStreaming
// alone — a tab opened during that window could dispose the session that is
// about to stream.
const pinned = new Set<string>();

/** Protect a session from eviction for the lifetime of a claimed run. */
/**
 * Sessions deleted in this process, so a run cannot start on one.
 *
 * `deleteSession` is synchronous end to end, but `prepareRun` awaits
 * `getSession` *before* it checks whether the session is busy. A delete landing
 * inside that await passes its own busy check — no run has claimed anything
 * yet — and the run then resumes holding a session whose transcript is gone,
 * recreating a partial one on its next write. Scriptable over MCP, which is
 * this phase's threat model.
 *
 * A tombstone rather than a re-`existsSync`: a freshly created session has no
 * transcript on disk until its first write, so absence does not mean deleted.
 * Bounded, because ids are minted per session and a process deletes few.
 */
const deletedSessions = new Set<string>();
const MAX_TOMBSTONES = 1_000;

/** True when this session was deleted and must not be run again. */
export function isDeletedSession(projectId: string, sessionId: string): boolean {
  return deletedSessions.has(keyFor(projectId, sessionId));
}

function tombstone(projectId: string, sessionId: string): void {
  if (deletedSessions.size >= MAX_TOMBSTONES) {
    // Oldest first; Set preserves insertion order.
    const oldest = deletedSessions.values().next();
    if (!oldest.done) deletedSessions.delete(oldest.value);
  }
  deletedSessions.add(keyFor(projectId, sessionId));
}

export function pinSession(projectId: string, sessionId: string): void {
  pinned.add(keyFor(projectId, sessionId));
}

export function unpinSession(projectId: string, sessionId: string): void {
  pinned.delete(keyFor(projectId, sessionId));
}

/**
 * Replacement guidance for sessions that lose the `interview` tool.
 *
 * Dropping the tool also drops its `promptGuidelines`, but the sandbox
 * `AGENTS.md` seeded by `sandbox-seed.ts` has its own "Clarifying questions —
 * ask, don't assume" section naming `interview` directly. That file is shared
 * with the browser UI, where the tool genuinely exists, so it must not be
 * edited. Instead this note is appended to the system prompt of headless
 * sessions only, which is what stops the model being told to call a tool it
 * cannot see and then guessing anyway.
 */
export const HEADLESS_PROMPT_NOTE = [
  "## Headless session — no interactive interview",
  "",
  "You are running for an external MCP client, not a human watching a chat UI.",
  "The `interview` tool is NOT available in this session, so the sandbox",
  "AGENTS.md guidance about asking the user clarifying questions through an",
  "interview form does not apply here. There is no one to answer a form.",
  "",
  "When a request is ambiguous or underspecified, do not stall waiting for",
  "clarification and do not silently guess. Instead:",
  "",
  "- Choose the most reasonable interpretation and proceed.",
  "- State the interpretation you chose, and the alternatives you rejected, in",
  "  your response, so the calling agent can correct you and re-run.",
  "- Record assumptions that affect the result in the lab notebook via the",
  "  `notebook` tool, which is available and does not block.",
].join("\n");

/**
 * Return the allowlist supplied to Pi when creating a session.
 *
 * MCP clients are headless, so their sessions intentionally omit `interview`:
 * the tool waits for the browser UI to submit an answer. Keeping this as a
 * pure helper makes that boundary testable without starting a full Pi session.
 */
export function sessionToolNames(
  includeInterview: boolean,
  mcpToolNames: readonly string[],
): string[] {
  return [
    ...BUILTIN_TOOLS,
    "subagent",
    // pi-subagents ≥0.45 registers this alongside `subagent` and enables it by
    // default. Since 0.47 a workflowScript launch is async by default and
    // returns a receipt, so without it in this allowlist Pi filters out the
    // lead's only way to block on the children it just started.
    "subagent_wait",
    ...(includeInterview ? ["interview"] : []),
    "notebook",
    "scientific_result",
    ...PDF_ANNOTATION_TOOL_NAMES,
    ...WEB_ACCESS_TOOLS,
    ...MODAL_TOOL_NAMES,
    ...mcpToolNames,
  ];
}

/** Dispose the least-recently-used idle sessions for a project over the cap. */
function evictOverCap(projectId: string): void {
  const prefix = `${projectId}:`;
  const keys = [...live.keys()].filter((k) => k.startsWith(prefix));
  let remaining = keys.length;
  for (const k of keys) {
    if (remaining <= MAX_LIVE_PER_PROJECT) break;
    const s = live.get(k);
    if (!s || s.isStreaming || pinned.has(k)) continue; // in-flight or claimed
    release(projectId, k, s);
    remaining--;
  }
}

/** Dispose one live session and drop everything keyed off it. */
function release(projectId: string, key: string, session: AgentSession): void {
  session.dispose();
  live.delete(key);
  pinned.delete(key);
  clearSessionCompute(projectId, key.slice(projectId.length + 1));
}

/**
 * Confirm a transcript really belongs to `sessionId` before unlinking it.
 *
 * `findSessionFile` matches on a filename *suffix*, which is fine for reads
 * but not for a delete: the id `23` also matches `subagent-123.jsonl`, so a
 * short id could destroy an unrelated transcript. Pi writes a `{"type":
 * "session", "id": ...}` header as the first row, and that is authoritative.
 * A file with no readable header is accepted only on an exact filename match.
 */
function ownsSessionFile(file: string, sessionId: string): boolean {
  if (path.basename(file) === `${sessionId}.jsonl`) return true;
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = JSON.parse(trimmed) as { type?: string; id?: string };
      return row.type === "session" && row.id === sessionId;
    }
  } catch {
    // Unreadable or malformed. The exact-name rule above has already run and
    // failed by this point, so there is nothing left to fall back to: refuse
    // the delete rather than unlink a file whose ownership cannot be read.
  }
  return false;
}

export type DeleteSessionResult = "deleted" | "not_found" | "run_active" | "not_deleted";

/**
 * Remove a session's transcript and its headless marker.
 *
 * Lives here rather than in the route so `POST /sessions` and the MCP path get
 * the same behaviour; a delete enforced only on one interface would make the
 * other second-class. Both artifacts go together: a transcript removed while
 * its marker survives means a later reused session id cold-opens headless and
 * silently loses the `interview` tool.
 */
export function deleteSession(
  projectId: string,
  paths: ProjectPaths,
  sessionId: string,
): DeleteSessionResult {
  // Validated before any path is built from it. `findSessionFile` does this
  // itself, but the exact-filename shortcut below reaches `path.join` first, so
  // an id carrying a separator would address a file outside `sessionsDir`
  // before that check ever ran. Thrown rather than returned as `not_found`:
  // this id could never name a session, and the route answers 400 for it.
  if (!isSafeSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);

  // The exact filename first. `findSessionFile` matches on a suffix and returns
  // whichever candidate `readdir` yields first, so with both `23.jsonl` and
  // `subagent-123.jsonl` present it can hand back the collision — and then
  // `ownsSessionFile` rejects it and a session that plainly exists reports
  // `not_found`. Readdir order is filesystem-dependent, so this is not
  // theoretical.
  // `path.basename` as well as the guard above, and not instead of it: it makes
  // the join provably inside `sessionsDir` at the point of use, rather than at
  // the mercy of a check several lines away that a later edit could move. At
  // runtime it is a no-op for every id the guard admits.
  const exact = path.join(paths.sessionsDir, path.basename(`${sessionId}.jsonl`));
  const file = fs.existsSync(exact) ? exact : findSessionFile(paths, sessionId);
  if (!file || !ownsSessionFile(file, sessionId)) return "not_found";

  // Deleting the transcript out from under a running agent would leave the run
  // writing to a file nobody can read.
  const runKey = keyFor(projectId, sessionId);
  const retained = runBroker.get(projectId, sessionId);
  if (live.get(runKey)?.isStreaming || pinned.has(runKey) || (retained && !retained.isComplete)) {
    return "run_active";
  }

  // Dispose before unlinking, so Pi is not still holding the file. If the
  // unlink itself fails — a Windows handle, a permission problem — stop here
  // and say so rather than stripping the notebook and provenance off a chat
  // whose transcript is still on disk.
  disposeSession(projectId, sessionId);
  try {
    fs.rmSync(file, { force: true });
  } catch {
    return "not_deleted";
  }
  forgetHeadlessSession(projectId, sessionId);

  // Everything else keyed by this session id. These are part of the chat, not
  // separate records: leaving them means the lab notebook still lists entries
  // for a chat that no longer exists, and a reused id would inherit them.
  //
  // Best-effort, and the result still reports `deleted`. The transcript — the
  // thing the user asked to remove — is already gone by this point, so failing
  // the call would report a delete that did in fact happen. The cost of that
  // choice is real and worth naming: if `forgetSessionRunResults` below fails,
  // `poll_run` keeps answering for a session `get_session_history` now 404s on
  // until the 7-day retention sweep collects it.
  for (const artifact of [
    notebookPath(sessionId, projectId),
    notebookAnnotationsPath(sessionId, projectId),
    provenanceSessionDir(sessionId, projectId),
  ]) {
    try {
      fs.rmSync(artifact, { force: true, recursive: true });
    } catch {
      /* nothing actionable; the transcript is already gone */
    }
  }

  tombstone(projectId, sessionId);

  // Durable run records are keyed by runId, so without this `poll_run` would
  // keep serving a deleted session's frames while `get_session_history` 404s.
  forgetSessionRunResults(projectId, sessionId);
  setSessionRunId(projectId, sessionId, null);

  // The cost ledger is deliberately kept. That money was actually spent, and
  // erasing a chat must not silently refund the project's budget tracking.
  return "deleted";
}

async function build(
  projectId: string,
  paths: ProjectPaths,
  sessionManager: SessionManager,
  options?: { includeInterview?: boolean },
): Promise<AgentSession> {
  const fallbackModel = defaultModel(modelRegistry);
  const mcpTools = await getMcpTools(projectId, paths);
  // Make the scientific agent roster visible to pi-subagents' project-agent
  // discovery (sandbox/.pi/agents/) before the session starts.
  seedAgentFiles(paths);
  // Reference pi-web-access from sandbox/.pi/settings.json and pre-trust the
  // sandbox so both this session and pi-subagents' child `pi` processes load
  // the web tools (web-access-bridge.ts explains why children need this).
  ensureWebAccess(paths);
  // Reference the kady-notebook package so child pi processes get the notebook
  // tool (sandbox trust is already handled by ensureWebAccess above).
  seedNotebookPackage(paths);
  // Builtin pi-subagents specialists pin a tools allowlist that would filter
  // the notebook tool out of their child processes — extend it via overrides.
  seedBuiltinAgentNotebookTools(paths);
  // Child-only localhost bridge for the same durable project-scoped Modal
  // jobs. Builtin allowlists are extended only when they retain our generated
  // shape; user-pinned lists remain authoritative.
  seedModalPackage(paths);
  seedBuiltinAgentModalTools(paths);
  // PDF annotation tools are in-process for the lead and package-backed for
  // child agents so both can create expert markup visible in the viewer.
  seedPdfAnnotationPackage(paths);
  seedBuiltinAgentPdfAnnotationTools(paths);
  // The ledger extension is created before the session exists, so it reads
  // the live sessionId through this holder (set right after creation).
  const holder: { session?: AgentSession } = {};
  const resourceLoader = new DefaultResourceLoader({
    cwd: paths.sandbox,
    agentDir: getAgentDir(),
    additionalExtensionPaths: [subagentsExtensionPath()],
    extensionFactories: [
      makeSubagentLedgerExtension(
        projectId,
        () => holder.session?.sessionId ?? "",
        () => holder.session?.model,
        (providerId) => modelRuntime.isUsingOAuth(providerId),
      ),
      // Rewrites the outgoing provider body to an OpenRouter Fusion request when
      // the /run handler stashed a Fusion config for this session (setFusionConfig).
      makeFusionRequestExtension(projectId, () => holder.session?.sessionId ?? ""),
      // Harvest notebook entries the roster's subagents logged (child pi
      // processes get the notebook tool via seedNotebookPackage above) into
      // the parent notebook — the parent is the single writer.
      makeSubagentNotebookExtension(projectId, () => holder.session?.sessionId ?? ""),
      // Reconstruct provenance for the child's tool calls from its session file
      // and append it to the parent's log. Needs no tool inside the child — the
      // session file is the record, which is what makes it unauthorable.
      makeSubagentProvenanceExtension(projectId, () => holder.session?.sessionId ?? ""),
      // A child refused by the provider dies in its own process; the parent
      // only sees the runner's "Provider finish_reason" text. Attach what to
      // do about it so the lead reports something actionable.
      makeSubagentRefusalExtension(projectId, () => holder.session?.model),
      // Child Modal jobs are submitted through the localhost bridge under the
      // child run id; reattribute them to this parent session on completion.
      makeSubagentModalExtension(projectId, () => holder.session?.sessionId ?? ""),
    ],
  });
  await resourceLoader.reload();
  // The interview tool blocks mid-run on answers posted to the HTTP API; it
  // reads the live sessionId through the same holder as the ledger extension.
  // It is included by default for regular chat sessions; set includeInterview
  // to false for headless / MCP-only sessions that must not block on user input.
  const includeInterview = options?.includeInterview ?? true;
  const interviewTool = includeInterview
    ? makeInterviewTool(projectId, () => holder.session?.sessionId ?? "")
    : undefined;
  if (!includeInterview) {
    // Patch the instance rather than subclassing: the loader is created and
    // consumed entirely within this function, and overriding the method here
    // keeps `this` bound to the real loader, so every other resource it
    // resolved during `reload()` above is returned unchanged.
    const inherited = resourceLoader.getAppendSystemPrompt();
    resourceLoader.getAppendSystemPrompt = () => [...inherited, HEADLESS_PROMPT_NOTE];
  }
  // Non-blocking lab-notebook tool: logs the agent's own narrative entries.
  const notebookTool = makeNotebookTool(projectId, () => holder.session?.sessionId ?? "");
  // Typed presentation layer for compact scientific results and artifact links.
  const scientificResultTool = makeScientificResultTool(projectId);
  const pdfAnnotationTools = makePdfAnnotationTools(projectId);
  // Durable remote-compute tools are always present. Missing credentials are
  // reported at submission time, so warm sessions become compatible
  // immediately after credentials are configured live.
  const modalTools = makeModalTools(projectId, () => holder.session?.sessionId ?? "");
  const { session } = await createAgentSession({
    cwd: paths.sandbox,
    model: fallbackModel,
    modelRuntime,
    sessionManager,
    resourceLoader,
    tools: sessionToolNames(includeInterview, mcpTools.map((t) => t.name)),
    customTools: [
      ...(includeInterview && interviewTool ? [interviewTool] : []),
      notebookTool,
      scientificResultTool,
      ...pdfAnnotationTools,
      ...modalTools,
      ...mcpTools,
    ],
  });
  holder.session = session;
  return session;
}

/** Create a brand-new persistent session for the active project. */
export async function createSession(
  projectId: string,
  paths: ProjectPaths,
  options?: { includeInterview?: boolean },
): Promise<AgentSession> {
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const sm = SessionManager.create(paths.sandbox, paths.sessionsDir);
  const session = await build(projectId, paths, sm, options);
  // Persist the headless choice before the session can be evicted, so a later
  // cold open rebuilds it without `interview` (see headless-sessions.ts).
  if (options?.includeInterview === false) {
    markHeadlessSession(projectId, session.sessionId);
  }
  deletedSessions.delete(keyFor(projectId, session.sessionId));
  live.set(keyFor(projectId, session.sessionId), session);
  evictOverCap(projectId);
  return session;
}

/** Return a live session, cold-opening its JSONL file from disk if needed. */
export async function getSession(
  projectId: string,
  paths: ProjectPaths,
  sessionId: string,
  options?: { includeInterview?: boolean },
): Promise<AgentSession | null> {
  const k = keyFor(projectId, sessionId);
  const existing = live.get(k);
  if (existing) {
    live.delete(k); // re-insert to mark most-recently-used
    live.set(k, existing);
    return existing;
  }

  const infos = await SessionManager.list(paths.sandbox, paths.sessionsDir);
  const info = infos.find((i) => i.id === sessionId);
  if (!info) return null;
  const sm = SessionManager.open(info.path, paths.sessionsDir, paths.sandbox);
  // Cold open: an explicit caller option wins, but a session created headless
  // must not silently regain the blocking `interview` tool just because it was
  // evicted from the live map and rebuilt here.
  const session = await build(projectId, paths, sm, {
    ...options,
    includeInterview: options?.includeInterview ?? !isHeadlessSession(projectId, sessionId),
  });
  live.set(k, session);
  evictOverCap(projectId);
  return session;
}

export async function listSessions(paths: ProjectPaths): Promise<SessionInfo[]> {
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  return SessionManager.list(paths.sandbox, paths.sessionsDir);
}

export function disposeSession(projectId: string, sessionId: string): void {
  const k = keyFor(projectId, sessionId);
  const s = live.get(k);
  if (s) release(projectId, k, s);
}

/** Stop every live session before its project directory is removed. */
export async function abortProjectSessions(projectId: string): Promise<void> {
  const prefix = `${projectId}:`;
  const sessions = [...live.entries()].filter(([key]) => key.startsWith(prefix));
  await Promise.all(
    sessions.map(async ([, session]) => {
      session.clearQueue();
      await session.abort();
    }),
  );
}

/** Release every live session after its project runs have finalized. */
export function disposeProjectSessions(projectId: string): void {
  const prefix = `${projectId}:`;
  const sessions = [...live.entries()].filter(([key]) => key.startsWith(prefix));
  for (const [key, session] of sessions) {
    release(projectId, key, session);
  }
}
