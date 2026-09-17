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
import type { Api, Model } from "@earendil-works/pi-ai";
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
import { notebookSearchTool } from "../../pi-packages/kady-notebook/memory-tool.ts";
import { executeMemoryRecall } from "./notebook-memory.ts";
import { makeScientificResultTool } from "./scientific-result.ts";
import { clearSessionCompute, makeModalTools, MODAL_TOOL_NAMES } from "./modal-tool.ts";
import {
  makeSubagentLedgerExtension,
  makeSubagentRefusalExtension,
  subagentsExtensionPath,
} from "./subagent-bridge.ts";
import { makeFusionRequestExtension } from "./fusion-bridge.ts";
import { makeScientificCompactionExtension } from "./compaction-bridge.ts";
import { makeDataGuardExtension } from "./data-guard.ts";
import { readSchedulerState } from "./scheduler-state.ts";
import { seedGuardPackage } from "./guard-bridge.ts";
import { seedPromptTemplates } from "./prompts.ts";
import { seedWatchdogGuidance } from "./watchdog-settings.ts";
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
import { isSafeSessionId, ownsSessionFile, sessionFileCandidates } from "./session-export.ts";
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
import { seedSubagentRuntimeSettings } from "./subagent-runtime-settings.ts";

// Entry points normally establish this in env.ts. Keep the registry safe when
// imported directly (tests/scripts) so child Pi processes still share the same
// Kady-scoped auth store as the in-process runtime.
process.env.PI_CODING_AGENT_DIR ??= KADY_PI_AGENT_DIR;

// pi-subagents ≥0.65 runs children as native Pi sessions (background ones in a
// detached runner it imports from our pi-coding-agent dependency), so no `pi`
// binary is spawned for delegation any more. The `pi` bin is still put on PATH
// for the few places that shell out to it (Herdr panes, the profile model
// probe) so they resolve even when the server wasn't started via npm.
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

/**
 * Hook for the session observer (agent/session-observer.ts). Registered from
 * index.ts rather than imported here: the observer needs the run pipeline,
 * which imports this module for pin/unpin, and this module has top-level
 * awaits — keep the cycle out.
 */
export type SessionObserverFactory = (ctx: {
  projectId: string;
  paths: ProjectPaths;
  session: AgentSession;
}) => () => void;
let observerFactory: SessionObserverFactory | null = null;
export function setSessionObserver(factory: SessionObserverFactory | null): void {
  observerFactory = factory;
}
/** Detach functions of attached observers, keyed like `live`. */
const observers = new Map<string, () => void>();

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

// Kady-owned resident sessions (the per-project scheduler host). Pinned for
// good and not counted against MAX_LIVE_PER_PROJECT, so they never cost a
// user a tab slot and are never evicted.
const systemSessions = new Set<string>();
export function markSystemSession(projectId: string, sessionId: string): void {
  const key = keyFor(projectId, sessionId);
  systemSessions.add(key);
  pinned.add(key);
}
export function isSystemSession(projectId: string, sessionId: string): boolean {
  return systemSessions.has(keyFor(projectId, sessionId));
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
    // pi-subagents registers the wait tool alongside `subagent` and enables it by
    // default. Since 0.47 a workflowScript launch is async by default and
    // returns a receipt, so without it in this allowlist Pi filters out the
    // lead's only way to block on the children it just started. 0.61 renamed
    // it `subagent_wait` → `bg_wait`; the old name is harmless here (unknown
    // names are ignored) and covers a deliberate pin rollback.
    "bg_wait",
    "subagent_wait",
    ...(includeInterview ? ["interview"] : []),
    // pi-subagents' parent side of the supervisor channel: reply to a
    // background specialist that called `contact_supervisor` (the request
    // arrives as a custom message and starts a system run; see AGENTS.md).
    "subagent_supervisor",
    "notebook",
    "notebook_search",
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
  const keys = [...live.keys()].filter((k) => k.startsWith(prefix) && !systemSessions.has(k));
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
  // Detach before dispose so an in-flight system run can finalize its handle
  // while the session is still queryable.
  const detach = observers.get(key);
  if (detach) {
    observers.delete(key);
    try {
      detach();
    } catch {
      /* an observer failure must not block disposal */
    }
  }
  // Pi's dispose() does not tell extensions the session is going away;
  // pi-subagents releases its supervisor-channel watchers and pollers on
  // `session_shutdown`, so emit it the way Pi's own quit path does.
  void session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {
    /* best effort: a failing shutdown handler must not block disposal */
  });
  session.dispose();
  live.delete(key);
  pinned.delete(key);
  systemSessions.delete(key);
  clearSessionCompute(projectId, key.slice(projectId.length + 1));
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
  // Validated before the directory is even listed. Thrown rather than returned
  // as `not_found`: this id could never name a session, and the route answers
  // 400 for it.
  if (!isSafeSessionId(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);

  // Every candidate, not the first one. More than one filename can name this
  // session — a stray `23.jsonl` beside the real `<timestamp>_23.jsonl` — and
  // stopping at whichever `readdir` happened to yield first made a session
  // that plainly exists report `not_found` as soon as a neighbour shadowed it.
  // Readdir order is filesystem-dependent, so that was not theoretical.
  const file = sessionFileCandidates(paths, sessionId).find((candidate) =>
    ownsSessionFile(candidate, sessionId),
  );
  if (!file) return "not_found";

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
  // Best-effort like the artifact loop below, and for the same reason.
  // `force: true` only suppresses ENOENT; an EPERM or a Windows EBUSY still
  // throws, and letting it escape here would strand the delete half-done: the
  // transcript is already gone, but the tombstone and the durable run records
  // below would be skipped and the route would answer 400 as though nothing
  // had happened.
  try {
    forgetHeadlessSession(projectId, sessionId);
  } catch {
    // Nothing actionable; the transcript is already gone. The marker outliving
    // it is inert: `isHeadlessSession` is only ever asked about a session that
    // still has a transcript, and Pi ids are not reused.
  }

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

export interface OpenSessionOptions {
  /**
   * Which model a cold-opened or brand-new session starts on. `"session"`
   * (default) restores the session's own last model; `"project"` uses the
   * model most recently used by any *chat* session of the project, which is
   * what the resident automation session wants: its own history is only
   * notices, and the default model is the most expensive one in the picker.
   */
  modelPolicy?: "session" | "project";
  /**
   * Whether the blocking `interview` tool is registered. Regular chat sessions
   * include it; headless / MCP-only sessions must not block on browser UI input.
   */
  includeInterview?: boolean;
}

/** Last `{provider, modelId}` a session JSONL recorded (model change or assistant reply). */
export function lastModelInSessionFile(file: string): { provider: string; modelId: string } | undefined {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf-8").split("\n");
  } catch {
    return undefined;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") {
      return { provider: entry.provider, modelId: entry.modelId };
    }
    const message = entry.message as Record<string, unknown> | undefined;
    if (
      entry.type === "message" &&
      message?.role === "assistant" &&
      typeof message.provider === "string" &&
      typeof message.model === "string"
    ) {
      return { provider: message.provider, modelId: message.model };
    }
  }
  return undefined;
}

/**
 * The model most recently used by a chat session of this project (system
 * sessions excluded), when the runtime still knows it and has credentials.
 */
async function latestProjectModel(
  paths: ProjectPaths,
  runtime: ModelRuntime,
  exclude: ReadonlySet<string>,
): Promise<Model<Api> | undefined> {
  let infos: SessionInfo[];
  try {
    infos = await SessionManager.list(paths.sandbox, paths.sessionsDir);
  } catch {
    return undefined;
  }
  const schedulerSessionId = readSchedulerState(paths).sessionId;
  const candidates = infos
    .filter((info) => !exclude.has(info.id) && info.id !== schedulerSessionId && info.messageCount > 0)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  for (const info of candidates) {
    const last = lastModelInSessionFile(info.path);
    if (!last) continue;
    const model = runtime.getModel(last.provider, last.modelId);
    if (model && runtime.hasConfiguredAuth(model.provider)) return model;
  }
  return undefined;
}

/**
 * The model a persisted session last ran with, when Pi's registry still knows
 * it and its provider has credentials. Mirrors the restore Pi's SDK performs
 * when no explicit `model` is passed.
 */
function restoredSessionModel(sessionManager: SessionManager, runtime: ModelRuntime): Model<Api> | undefined {
  const context = sessionManager.buildSessionContext();
  if (context.messages.length === 0 || !context.model) return undefined;
  const model = runtime.getModel(context.model.provider, context.model.modelId);
  if (!model || !runtime.hasConfiguredAuth(model.provider)) return undefined;
  return model;
}

async function build(
  projectId: string,
  paths: ProjectPaths,
  sessionManager: SessionManager,
  options: OpenSessionOptions = {},
): Promise<AgentSession> {
  const fallbackModel = defaultModel(modelRegistry);
  const ownId = sessionManager.getSessionId();
  const initialModel =
    (options.modelPolicy === "project" ? undefined : restoredSessionModel(sessionManager, modelRuntime)) ??
    (await latestProjectModel(paths, modelRuntime, new Set(ownId ? [ownId] : []))) ??
    fallbackModel;
  const mcpTools = await getMcpTools(projectId, paths);
  // Make the scientific agent roster visible to pi-subagents' project-agent
  // discovery (sandbox/.pi/agents/) before the session starts.
  seedAgentFiles(paths);
  // Reference pi-web-access from sandbox/.pi/settings.json and pre-trust the
  // sandbox so both this session and pi-subagents' background children (native
  // sessions in a detached runner that loads the sandbox's ambient packages)
  // get the web tools (web-access-bridge.ts explains why children need this).
  ensureWebAccess(paths);
  // Reference the kady-notebook package so child sessions get the notebook
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
  // Raw-data guard for background specialists (the lead runs data-guard.ts).
  seedGuardPackage(paths);
  // Scientific prompt templates (`/qc <file>` …) live in sandbox/.pi/prompts.
  seedPromptTemplates(paths);
  // Standing instructions for the (opt-in) pi-subagents watchdog reviewer.
  seedWatchdogGuidance(paths);
  // Every child tool above arrives as an ambient package, which pi-subagents
  // ≥0.65 loads only into *background* children — so force background
  // launches; and keep the external-CLI builtins (Claude Code/Codex/Cursor)
  // off until a user turns one on in Settings → Specialists.
  seedSubagentRuntimeSettings(paths);
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
      // Science-aware context compaction: a deterministic state preamble (plan,
      // notebook, results, environment) plus a summary generated under
      // science-focused instructions; falls back to Pi's default on error.
      makeScientificCompactionExtension(projectId, () => holder.session?.sessionId ?? ""),
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
      // Raw-data guard: blocks mutations of protected paths and asks the user
      // before destructive shell commands. Registered after the subagent
      // bridge so budget gates run first.
      makeDataGuardExtension(projectId, () => holder.session?.sessionId ?? "", paths.sandbox),
    ],
  });
  await resourceLoader.reload();
  // The interview tool blocks mid-run on answers posted to the HTTP API; it
  // reads the live sessionId through the same holder as the ledger extension.
  // It is included by default for regular chat sessions; set includeInterview
  // to false for headless / MCP-only sessions that must not block on user input.
  // FORK: headless/MCP sessions cannot block on the interactive interview UI,
  // so session construction needs this narrow opt-out from upstream defaults.
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
    // A cold-opened session starts on the model it last ran with (or the
    // project's latest chat model), not the global default: user runs set the
    // model per request anyway, but extension-initiated system runs
    // (supervisor replies, scheduled-run notices) use whatever the session
    // holds, and the default is the most expensive model in the picker.
    model: initialModel,
    modelRuntime,
    sessionManager,
    resourceLoader,
    tools: sessionToolNames(includeInterview, mcpTools.map((t) => t.name)),
    customTools: [
      ...(includeInterview && interviewTool ? [interviewTool] : []),
      notebookTool,
      notebookSearchTool((params) => executeMemoryRecall(projectId, params)),
      scientificResultTool,
      ...pdfAnnotationTools,
      ...modalTools,
      ...mcpTools,
    ],
  });
  // Pi emits `session_start` only from bindExtensions(); without it the
  // extensions never see a live session: pi-subagents never starts its
  // supervisor channel (so the `subagent_supervisor` tool in the allowlist
  // above is never registered), never resets per-session state, and skips
  // `resources_discover`. Headless mode mirrors `pi -p`.
  await session.bindExtensions({
    mode: "print",
    onError: (error) => {
      console.warn(`[session-registry] extension error in ${session.sessionId}:`, error);
    },
  });
  holder.session = session;
  if (observerFactory) {
    observers.set(keyFor(projectId, session.sessionId), observerFactory({ projectId, paths, session }));
  }
  return session;
}

/** Create a brand-new persistent session for the active project. */
export async function createSession(
  projectId: string,
  paths: ProjectPaths,
  options: OpenSessionOptions = {},
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
  options: OpenSessionOptions = {},
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

/**
 * `listSessions`, plus which of those sessions were created headless.
 *
 * Both interfaces that show a user their sessions need the flag, and both
 * would otherwise add it themselves — the flag's definition would then live in
 * two places and drift the first time it grows a second condition. It is not
 * folded into `listSessions` because that has three other callers
 * (`project-activity`, `project-archive`, `api/projects`) that want the
 * transcript facts and have no project id to hand.
 */
export async function listSessionsLabelled(
  projectId: string,
  paths: ProjectPaths,
): Promise<(SessionInfo & { headless: boolean })[]> {
  return (await listSessions(paths)).map((info) => ({
    ...info,
    headless: isHeadlessSession(projectId, info.id),
  }));
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
