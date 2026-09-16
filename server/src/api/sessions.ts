/**
 * Session lifecycle + the streaming run endpoint.
 *
 * Replaces ADK's /apps/.../sessions + /run_sse. Each session is a Pi JSONL
 * conversation; `/sessions/:id/run` streams the agent's events as SSE using the
 * compact client schema from agent/events.ts, then emits a terminal `cost`
 * frame sourced from Pi's per-session usage accounting.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { activePaths, getProject, touchProject, type ProjectPaths } from "../projects.ts";
import { corsResponseHeaders } from "../cors.ts";
import { currentProjectId } from "../scope.ts";
import {
  contextUsageForClient,
  contextUsageFrame,
  toClientFrame,
  type ClientFrame,
} from "../agent/events.ts";
import { setFusionConfig } from "../agent/fusion-bridge.ts";
import {
  cancelInterviewsForSession,
  pendingInterviewFor,
  resolveInterview,
  validateAnswer,
  type InterviewAnswer,
} from "../agent/interview.ts";
import {
  setSessionComputeOptions,
  setSessionComputeTarget,
  type SessionComputeOptions,
} from "../agent/modal-tool.ts";
import {
  cancelPermissionsForSession,
  pendingPermissionFor,
  resolvePermission,
} from "../agent/permissions.ts";
import {
  assertModelAuthentication,
  ModelAuthenticationError,
  modelReference,
  resolveModel,
} from "../agent/models.ts";
import { explainProviderRefusal } from "../agent/model-refusal.ts";
import { parseRunImages, type RunImage } from "../agent/prompt-images.ts";
import { expandLeadingCommand } from "../agent/prompt-expansion.ts";
import { expandableTemplates } from "../agent/prompts.ts";
import { globalSkillRoot, listProjectSkills, projectSkillRoot } from "../agent/skills.ts";
import { schedulerSessionId } from "../agent/scheduler-state.ts";
import { readNotebookEntries } from "../agent/notebook-store.ts";
import { withNotebookArtifactHealth } from "../agent/notebook-artifacts.ts";
import { withNotebookPlanHistory } from "../agent/notebook-research.ts";
import { notebookToMarkdown } from "../agent/notebook-export.ts";
import { buildNotebookZip } from "../agent/notebook-zip.ts";
import {
  normalizeNotebookAnnotations,
  readNotebookAnnotations,
  writeNotebookAnnotations,
} from "../agent/notebook-annotations.ts";
import { MethodsDraftError, runMethodsDraft } from "../agent/methods-draft.ts";
import { mintRunId, setSessionRunId } from "../agent/run-ids.ts";
import { runBroker, type RunHandle } from "../agent/run-broker.ts";
import { runStartFailure } from "../agent/run-start-errors.ts";
import { persistTerminalRunResult } from "../agent/run-results.ts";
import { ProvenanceRecorder } from "../provenance/recorder.ts";
import {
  isRunClaimed,
  snapshot,
} from "../agent/run-pipeline.ts";
import { SandboxError } from "../sandbox-fs.ts";
import {
  findSessionFile,
  toNotebook,
  toShellScript,
} from "../agent/session-export.ts";
import { toHistory } from "../agent/session-history.ts";
import {
  createSession,
  deleteSession,
  isDeletedSession,
  getModelRegistry,
  getModelRuntime,
  getSession,
  listSessionsLabelled,
  pinSession,
  unpinSession,
} from "../agent/session-registry.ts";
import { parseThinkingLevel } from "../agent/thinking.ts";
import {
  addTurnUsage,
  emptySnapshot,
  isBudgetExceeded,
  recordRun,
  sessionCostSummary,
  snapshotDelta,
  snapshotMax,
  trackInFlightRun,
  untrackInFlightRun,
  type CostSnapshot,
} from "../cost/ledger.ts";
import {
  billingCountsTowardBudget,
  billingForModel,
  type BillingContext,
} from "../cost/billing.ts";

interface RunBody {
  message?: string;
  model?: string;
  thinkingLevel?: string;
  /** Full OpenRouter Fusion request body for a "fusion/<id>" model selection. */
  fusionConfig?: Record<string, unknown>;
  /** Default Modal compute instance id for `modal_run` this run ("local" / unset = none). */
  computeTarget?: string;
  /** Optional defaults attached to the selected Modal target. */
  computeOptions?: SessionComputeOptions;
  /** Inline image attachments (base64 + mime type); ride the user message as image blocks. */
  images?: unknown;
}

// Sessions with a run in flight, claimed synchronously. `session.isStreaming`
// flips true only after awaits inside prompt(), so concurrent POSTs could
// otherwise both pass the guard and the loser's close handler would abort the
// winner's live turn.
const activeRuns = new Set<string>();

/**
 * Expand a leading `/skill:name args` or `/template args` from disk (project
 * entries win), so a just-installed skill or just-edited template works
 * without a session reload. Returns the text unchanged when it is not a command.
 */
function expandChatCommand(paths: ReturnType<typeof activePaths>, text: string): string {
  if (!text.startsWith("/")) return text;
  const skills = new Map<string, { name: string; filePath: string; baseDir: string }>();
  for (const root of [globalSkillRoot(), projectSkillRoot(paths)]) {
    for (const skill of listProjectSkills(root)) skills.set(skill.name, skill);
  }
  return expandLeadingCommand(text, {
    skills: [...skills.values()],
    templates: expandableTemplates(paths),
  }).text;
}

/** Attach one HTTP response to a broker-owned run. Closing the response only
 * removes this observer; the run itself remains owned by the broker. */
function streamRun(
  req: FastifyRequest,
  reply: FastifyReply,
  handle: RunHandle,
  after = 0,
): void {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...corsResponseHeaders(req.headers.origin),
  });

  let unsubscribe = () => {};
  const detach = () => unsubscribe();
  raw.on("close", detach);
  unsubscribe = handle.subscribe({
    after,
    onFrame(frame) {
      if (!raw.writableEnded && !raw.destroyed) {
        raw.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
    },
    onComplete() {
      if (!raw.writableEnded && !raw.destroyed) raw.end();
    },
  });
  // The socket may have closed while a completed handle replayed
  // synchronously, before `unsubscribe` received its real function.
  if (raw.destroyed) unsubscribe();
}

type LiveSession = NonNullable<Awaited<ReturnType<typeof getSession>>>;

interface PreparedRun {
  projectId: string;
  paths: ProjectPaths;
  session: LiveSession;
  sessionId: string;
  runKey: string;
  body: RunBody;
  prompt: string;
  dispatchExtensionCommand: boolean;
  images: RunImage[];
  baseline: {
    messages: ReturnType<typeof toHistory>;
    contextUsage: ReturnType<typeof contextUsageForClient> | null;
  };
  isFusion: boolean;
  requestedModel: ReturnType<typeof resolveModel>;
  runBilling: BillingContext;
  runId: string;
  handle: RunHandle;
}

interface RunLifecycle {
  handOff(): void;
  wasHandedOff(): boolean;
  saveToolNames(names: string[]): void;
  complete(): void;
  cleanup(): void;
}

/**
 * A run that never started. The status code travels with the body so the run
 * pipeline stays transport-neutral: the HTTP route turns this into a reply,
 * while the MCP adapter maps it to a tool result.
 */
export interface RunStartRejection {
  statusCode: number;
  body: { detail: string; reason?: string };
}

interface RunPreparationFailure {
  failure: RunStartRejection;
}

/** Claim a session, validate its inputs, and create its replayable run handle.
 * Every pre-handle failure releases the synchronous claim here. */
async function prepareRun(
  sessionId: string,
  rawBody: RunBody | null | undefined,
): Promise<PreparedRun | RunPreparationFailure> {
  const projectId = currentProjectId();
  const paths = activePaths();
  const session = await getSession(projectId, paths, sessionId);
  // Checked after the await, not before: a delete landing inside `getSession`
  // would otherwise pass this function's busy check below and start a run on a
  // session whose transcript no longer exists.
  if (!session || isDeletedSession(projectId, sessionId)) {
    return { failure: { statusCode: 404, body: { detail: "No such session" } } };
  }

  const runKey = `${projectId}:${sessionId}`;
  const retained = runBroker.get(projectId, sessionId);
  if (session.isStreaming || activeRuns.has(runKey) || (retained && !retained.isComplete)) {
    return {
      failure: {
        statusCode: 409,
        body: {
          detail: "Session is already streaming a response",
          reason: "run_already_active",
        },
      },
    };
  }

  const body = rawBody ?? {};
  if (!body.message || !body.message.trim()) {
    return { failure: { statusCode: 400, body: { detail: "message is required" } } };
  }
  const parsedImages = parseRunImages(body.images);
  if ("error" in parsedImages) {
    return { failure: { statusCode: 400, body: { detail: parsedImages.error } } };
  }

  const historyFile = findSessionFile(paths, sessionId);
  const baseline = {
    messages: historyFile ? toHistory(historyFile, paths.sandbox) : [],
    contextUsage: contextUsageForClient(session) ?? null,
  };
  activeRuns.add(runKey);
  pinSession(projectId, session.sessionId);

  let requestedModel: ReturnType<typeof resolveModel>;
  let runBilling: BillingContext;
  try {
    requestedModel = body.model
      ? resolveModel(body.model, getModelRegistry(), body.fusionConfig)
      : session.model ?? resolveModel(undefined, getModelRegistry());
    await assertModelAuthentication(requestedModel, getModelRuntime());
    runBilling = await billingForModel(requestedModel, getModelRuntime());
  } catch (error) {
    unpinSession(projectId, session.sessionId);
    activeRuns.delete(runKey);
    return {
      failure: {
        statusCode: error instanceof ModelAuthenticationError ? 401 : 400,
        body: {
          detail:
            error instanceof Error ? error.message : "The selected model could not be prepared",
          reason:
            error instanceof ModelAuthenticationError ? "provider_not_connected" : "invalid_model",
        },
      },
    };
  }

  const runId = mintRunId();
  // Kady expands slash commands itself (see expandChatCommand) and tells Pi
  // not to, so composer-appended context never becomes `$ARGUMENTS`. A
  // leading `/command` Kady did not recognize is left for Pi to dispatch:
  // extension commands such as pi-subagents' `/subagents-watchdog status`
  // answer with a custom message (a notice card) instead of a model turn.
  const prompt = expandChatCommand(paths, body.message);
  const dispatchExtensionCommand = prompt === body.message && /^\/[a-z]/i.test(prompt);
  try {
    setSessionRunId(projectId, session.sessionId, runId);
    const handle = runBroker.start(projectId, sessionId, {
      runId,
      prompt,
      images: parsedImages.images.map(({ data, mimeType }) => ({ data, mimeType })),
      baseline,
    });
    handle.publish({ type: "run_start", runId });
    return {
      projectId,
      paths,
      session,
      sessionId,
      runKey,
      body,
      prompt,
      dispatchExtensionCommand,
      images: parsedImages.images,
      baseline,
      isFusion: Boolean(body.model && body.model.startsWith("fusion/")),
      requestedModel,
      runBilling,
      runId,
      handle,
    };
  } catch (error) {
    setSessionRunId(projectId, session.sessionId, null);
    unpinSession(projectId, session.sessionId);
    activeRuns.delete(runKey);
    return { failure: runStartFailure(error) };
  }
}

function createRunLifecycle(run: PreparedRun, log: FastifyRequest["log"]): RunLifecycle {
  let savedToolNames: string[] | null = null;
  let handedOff = false;
  return {
    handOff: () => {
      handedOff = true;
    },
    wasHandedOff: () => handedOff,
    saveToolNames: (names) => {
      savedToolNames = names;
    },
    complete: () => {
      if (run.handle.isComplete) return;
      try {
        persistTerminalRunResult(run.projectId, run.handle);
      } catch (error) {
        log.error({ error, runId: run.runId }, "failed to persist terminal run result");
        run.handle.publish({
          type: "error",
          message: "Terminal run result could not be persisted; late MCP polling is unavailable.",
        });
      }
      run.handle.publish({ type: "done" });
      run.handle.complete();
    },
    cleanup: () => {
      if (savedToolNames !== null) {
        run.session.setActiveToolsByName(savedToolNames);
        savedToolNames = null;
      }
      setSessionRunId(run.projectId, run.session.sessionId, null);
      untrackInFlightRun(run.runKey);
      unpinSession(run.projectId, run.session.sessionId);
      activeRuns.delete(run.runKey);
    },
  };
}

async function configureRunModel(run: PreparedRun, lifecycle: RunLifecycle): Promise<string | null> {
  if (run.isFusion) {
    try {
      await run.session.setModel(run.requestedModel);
      setFusionConfig(run.projectId, run.session.sessionId, run.body.fusionConfig ?? null);
      lifecycle.saveToolNames(run.session.getActiveToolNames());
      run.session.setActiveToolsByName([]);
      return null;
    } catch (error) {
      setFusionConfig(run.projectId, run.session.sessionId, null);
      const detail = `Fusion model could not be prepared: ${(error as Error).message}`;
      run.handle.publish({ type: "error", message: detail });
      return detail;
    }
  }

  setFusionConfig(run.projectId, run.session.sessionId, null);
  if (!run.body.model) return null;
  try {
    await run.session.setModel(run.requestedModel);
    return null;
  } catch (error) {
    const detail = `Model could not be selected: ${(error as Error).message}`;
    run.handle.publish({ type: "error", message: detail });
    return detail;
  }
}

async function configureRun(
  run: PreparedRun,
  lifecycle: RunLifecycle,
  log: FastifyRequest["log"],
): Promise<string | null> {
  setSessionComputeTarget(run.projectId, run.session.sessionId, run.body.computeTarget ?? null);
  setSessionComputeOptions(
    run.projectId,
    run.session.sessionId,
    run.body.computeTarget ? run.body.computeOptions : null,
  );
  const modelError = await configureRunModel(run, lifecycle);
  if (modelError) return modelError;

  if (run.body.thinkingLevel !== undefined) {
    const level = parseThinkingLevel(run.body.thinkingLevel);
    if (level) run.session.setThinkingLevel(level);
    else log.warn({ thinkingLevel: run.body.thinkingLevel }, "ignoring invalid thinkingLevel");
  }
  run.baseline.contextUsage = contextUsageForClient(run.session) ?? null;
  const frame = contextUsageFrame(contextUsageForClient(run.session));
  if (frame) run.handle.publish(frame);
  return null;
}

function publishContextUsage(run: PreparedRun): void {
  const frame = contextUsageFrame(contextUsageForClient(run.session));
  if (frame) run.handle.publish(frame);
}

function publishBudgetFailure(run: PreparedRun): boolean {
  const budget = isBudgetExceeded(run.projectId);
  if (!billingCountsTowardBudget(run.runBilling) || !budget.exceeded) return false;
  run.handle.publish({
    type: "error",
    kind: "budget",
    message:
      `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
      `$${(budget.limitUsd ?? 0).toFixed(2)}). Raise the limit in project settings and retry.`,
  });
  return true;
}

async function recordRunAccounting(
  run: PreparedRun,
  before: CostSnapshot,
  turnTally: CostSnapshot,
  log: FastifyRequest["log"],
): Promise<void> {
  try {
    const usage = snapshotMax(snapshotDelta(before, snapshot(run.session)), turnTally);
    const entry = recordRun({
      sessionId: run.sessionId,
      projectId: run.projectId,
      model: run.session.model ? modelReference(run.session.model) : "unknown",
      before: emptySnapshot(),
      after: usage,
      billing: run.runBilling,
    });
    const stats = run.session.getSessionStats();
    publishContextUsage(run);
    run.handle.publish({
      type: "cost",
      cost: sessionCostSummary(run.sessionId, run.projectId).totalUsd,
      tokens: stats.tokens,
      runCost: entry?.costUsd ?? 0,
      runTokens: usage.total,
      runBillingMode: run.runBilling.billingMode,
      runProvider: run.runBilling.provider,
      ...(entry?.listPriceUsd !== undefined ? { runListPriceUsd: entry.listPriceUsd } : {}),
    });
  } catch (error) {
    log.warn({ error }, "failed to ledger run cost");
  }
}

async function promptAndRecordRun(run: PreparedRun, log: FastifyRequest["log"]): Promise<void> {
  const turnTally = emptySnapshot();
  const provenance = new ProvenanceRecorder({
    projectId: run.projectId,
    sessionId: run.sessionId,
    sandboxRoot: run.paths.sandbox,
    runId: run.runId,
    getModel: () => (run.session.model ? modelReference(run.session.model) : undefined),
    onError: (error) => log.warn({ error }, "provenance recorder step failed"),
  });
  const withRefusalGuidance = (frame: ClientFrame): ClientFrame =>
    frame.type === "error" && typeof frame.message === "string"
      ? {
          ...frame,
          message: explainProviderRefusal(frame.message, {
            projectId: run.projectId,
            modelRef: run.session.model ? modelReference(run.session.model) : undefined,
          }),
        }
      : frame;
  const priorError = run.session.state.errorMessage;
  const before = snapshot(run.session);
  let unsubscribe = () => {};
  try {
    unsubscribe = run.session.subscribe((event) => {
      provenance.observe(event);
      if (event.type === "turn_end") {
        const usage = (event.message as { usage?: Parameters<typeof addTurnUsage>[1] }).usage;
        if (usage) addTurnUsage(turnTally, usage);
      }
      const frame = toClientFrame(event, run.paths.sandbox);
      if (frame) run.handle.publish(withRefusalGuidance(frame));
      if (event.type === "turn_end") publishContextUsage(run);
    });
    if (billingCountsTowardBudget(run.runBilling)) {
      trackInFlightRun(run.runKey, run.projectId, () =>
        Math.max(0, snapshot(run.session).costUsd - before.costUsd),
      );
    }
    await run.session.prompt(run.prompt, {
      expandPromptTemplates: run.dispatchExtensionCommand,
      ...(run.images.length > 0 ? { images: run.images } : {}),
    });
    const errorMessage = run.session.state.errorMessage;
    if (errorMessage && errorMessage !== priorError) {
      run.handle.publish(withRefusalGuidance({ type: "error", message: errorMessage }));
    }
  } catch (error) {
    run.handle.publish({ type: "error", message: (error as Error).message });
  } finally {
    unsubscribe();
    try {
      await provenance.flush();
    } catch (error) {
      log.warn({ error }, "failed to flush provenance");
    }
    await recordRunAccounting(run, before, turnTally, log);
  }
}

async function ownRun(run: PreparedRun, lifecycle: RunLifecycle, log: FastifyRequest["log"]): Promise<void> {
  try {
    if (!run.handle.isAbortRequested && !publishBudgetFailure(run)) {
      await promptAndRecordRun(run, log);
    }
  } catch (error) {
    log.error({ error }, "detached run failed");
    if (!run.handle.isComplete) {
      run.handle.publish({ type: "error", message: (error as Error).message });
    }
  } finally {
    lifecycle.complete();
    lifecycle.cleanup();
  }
}

/**
 * Claim a session, configure it, and hand the run to its detached owner.
 *
 * This is the single run-start path. Both the SSE route and the MCP adapter
 * call it and differ only in what they do with the returned handle: the route
 * attaches an HTTP observer via `streamRun`, while MCP returns the run id and
 * lets the client poll. Nothing about starting, owning, billing, or completing
 * a run is duplicated for MCP.
 */
export async function beginRun(
  sessionId: string,
  body: RunBody | null | undefined,
  log: FastifyRequest["log"],
): Promise<PreparedRun | RunPreparationFailure> {
  const prepared = await prepareRun(sessionId, body);
  if ("failure" in prepared) return prepared;

  const lifecycle = createRunLifecycle(prepared, log);
  try {
    const setupError = await configureRun(prepared, lifecycle, log);
    if (setupError) {
      return { failure: { statusCode: 400, body: { detail: setupError } } };
    }
    lifecycle.handOff();
    void ownRun(prepared, lifecycle, log);
    return prepared;
  } catch (error) {
    if (!lifecycle.wasHandedOff() && !prepared.handle.isComplete) {
      prepared.handle.publish({ type: "error", message: (error as Error).message });
    }
    throw error;
  } finally {
    // Reached on the setup-error return as well: that run was claimed but never
    // handed off, so its claim, pin, and handle must be released here.
    if (!lifecycle.wasHandedOff()) {
      lifecycle.complete();
      lifecycle.cleanup();
    }
  }
}

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/sessions", async () => {
    const session = await createSession(currentProjectId(), activePaths());
    return { id: session.sessionId, sessionFile: session.sessionFile };
  });

  app.delete<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    try {
      const projectId = currentProjectId();
      const paths = activePaths();
      const result = deleteSession(projectId, paths, req.params.id);
      switch (result) {
        case "not_found":
          reply.code(404);
          return { detail: "No such session" };
        case "run_active":
          reply.code(409);
          // The machine-readable reason matches the run-start conflict — it is
          // the same condition — but the sentence has to describe a refused
          // delete, not a refused turn.
          return {
            detail: "That session has a run in flight; wait for it to finish",
            reason: "run_already_active",
          };
        case "not_deleted":
          reply.code(500);
          return { detail: "The session transcript could not be removed" };
        case "deleted":
          return { deleted: true };
      }
    } catch (err) {
      reply.code(400);
      return { detail: (err as Error).message };
    }
  });

  app.get("/sessions", async () => {
    const paths = activePaths();
    const infos = await listSessionsLabelled(currentProjectId(), paths);
    // Kady-owned resident sessions (the scheduler host) are not chats.
    const hidden = schedulerSessionId(paths);
    return infos.filter((i) => i.id !== hidden).map((i) => ({
      id: i.id,
      name: i.name ?? null,
      created: i.created,
      modified: i.modified,
      messageCount: i.messageCount,
      firstMessage: i.firstMessage,
      headless: i.headless,
    }));
  });

  // Full transcript of a stored session, replayed as client frames so the UI
  // can rebuild a past chat after a reload ("reopen session").
  app.get<{ Params: { id: string } }>("/sessions/:id/history", async (req, reply) => {
    try {
      const paths = activePaths();
      const file = findSessionFile(paths, req.params.id);
      if (!file) {
        reply.code(404);
        return { detail: "No such session" };
      }
      const session = await getSession(currentProjectId(), paths, req.params.id);
      return {
        messages: toHistory(file, paths.sandbox),
        contextUsage: session ? contextUsageForClient(session) ?? null : null,
      };
    } catch (err) {
      reply.code(400);
      return { detail: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/costs", async (req, reply) => {
    try {
      return sessionCostSummary(req.params.id, currentProjectId());
    } catch (err) {
      reply.code(400);
      return { detail: (err as Error).message };
    }
  });

  app.get<{ Params: { id: string } }>("/sessions/:id/notebook", async (req, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      const projectId = currentProjectId();
      return { entries: withNotebookPlanHistory(await withNotebookArtifactHealth(readNotebookEntries(req.params.id, projectId), projectId), projectId, req.params.id) };
    } catch (exc) {
      reply.code(400);
      return { detail: (exc as Error).message };
    }
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/sessions/:id/notebook/export",
    async (req, reply) => {
      const format = req.query.format ?? "md";
      if (format !== "md" && format !== "json" && format !== "zip") {
        reply.code(400);
        return { detail: "format must be md, json, or zip (PDF is exported client-side)" };
      }
      try {
        const projectId = currentProjectId();
        const entries = withNotebookPlanHistory(await withNotebookArtifactHealth(readNotebookEntries(req.params.id, projectId), projectId), projectId, req.params.id);
        reply.header("Cache-Control", "no-store");
        const projectName = getProject(projectId)?.name ?? projectId;
        // Pins, comments and standalone notes live in a sidecar. Leaving them
        // out made every export silently drop the user's own layer.
        const { doc: annotationsDoc } = readNotebookAnnotations(req.params.id, projectId);
        const annotations = annotationsDoc.annotations;
        const attachment = (ext: string) =>
          reply.header(
            "Content-Disposition",
            `attachment; filename="lab-notebook-${req.params.id}.${ext}"`,
          );
        if (format === "json") {
          reply.header("Content-Type", "application/json; charset=utf-8");
          attachment("json");
          return { sessionId: req.params.id, projectName, entries, annotations };
        }
        if (format === "zip") {
          const { buffer } = buildNotebookZip(entries, {
            sessionId: req.params.id,
            projectName,
            sandboxRoot: activePaths().sandbox,
            annotations,
          });
          reply.type("application/zip");
          attachment("zip");
          return buffer;
        }
        const md = notebookToMarkdown(entries, {
          sessionId: req.params.id,
          projectName,
          annotations,
        });
        reply.header("Content-Type", "text/markdown; charset=utf-8");
        attachment("md");
        return md;
      } catch (exc) {
        reply.code(400);
        return { detail: (exc as Error).message };
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/sessions/:id/notebook/annotations",
    async (req, reply) => {
      try {
        reply.header("Cache-Control", "no-store");
        const { doc, mtime, etag } = readNotebookAnnotations(req.params.id, currentProjectId());
        if (mtime) reply.header("Last-Modified", mtime.toUTCString());
        if (etag) reply.header("ETag", etag);
        return doc;
      } catch (err) {
        if (err instanceof SandboxError) {
          reply.code(err.statusCode);
          return { detail: err.message };
        }
        throw err;
      }
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/sessions/:id/notebook/annotations",
    async (req, reply) => {
      try {
        const projectId = currentProjectId();
        const { mtime, etag } = readNotebookAnnotations(req.params.id, projectId);
        const ifMatch = req.headers["if-match"] ? String(req.headers["if-match"]) : null;
        const ifUnmodifiedSince = req.headers["if-unmodified-since"];
        if (ifMatch) {
          // Exact check. The Last-Modified fallback below can only compare
          // whole seconds, so a same-second edit would slip through it.
          if (ifMatch === "*" ? !etag : ifMatch !== etag) {
            reply.code(412);
            return { detail: "Sidecar modified; re-read and retry" };
          }
        } else if (ifUnmodifiedSince && mtime) {
          const since = new Date(String(ifUnmodifiedSince)).getTime();
          if (
            !Number.isNaN(since) &&
            Math.floor(mtime.getTime() / 1000) > Math.floor(since / 1000)
          ) {
            reply.code(412);
            return { detail: "Sidecar modified; re-read and retry" };
          }
        }
        const doc = normalizeNotebookAnnotations(req.body);
        const saved = writeNotebookAnnotations(req.params.id, doc, projectId);
        touchProject(projectId);
        reply.header("Last-Modified", saved.mtime.toUTCString());
        if (saved.etag) reply.header("ETag", saved.etag);
        return { saved: req.params.id, count: doc.annotations.length };
      } catch (err) {
        if (err instanceof SandboxError) {
          reply.code(err.statusCode);
          return { detail: err.message };
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { model?: string } | null }>(
    "/sessions/:id/notebook/methods-draft",
    async (req, reply) => {
      try {
        return await runMethodsDraft(req.params.id, currentProjectId(), {
          model: req.body?.model,
        });
      } catch (err) {
        if (err instanceof MethodsDraftError) {
          reply.code(err.status);
          return err.status === 402
            ? { detail: "budget-exceeded", message: err.message }
            : { detail: "methods-draft-failed", message: err.message };
        }
        throw err;
      }
    },
  );

  // Reproducibility export: a runnable shell script (?format=sh) or a markdown
  // lab notebook (?format=md) reconstructed from the Pi session log.
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/sessions/:id/export",
    async (req, reply) => {
      try {
        const format = req.query.format === "md" ? "md" : "sh";
        const paths = activePaths();
        const file = findSessionFile(paths, req.params.id);
        if (!file) {
          reply.code(404);
          return { detail: "No such session" };
        }
        const body =
          format === "md"
            ? toNotebook(file, req.params.id, paths.sandbox)
            : toShellScript(file, req.params.id, paths.sandbox);
        const ext = format === "md" ? "md" : "sh";
        reply.type(format === "md" ? "text/markdown" : "text/x-shellscript");
        // Defense-in-depth for the export download (CodeQL `js/reflected-xss`
        // #3, false positive): attachment + non-HTML type already prevent
        // inline rendering; nosniff pins that down against MIME sniffing.
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header(
          "Content-Disposition",
          `attachment; filename="session-${req.params.id}.${ext}"`,
        );
        return body;
      } catch (err) {
        reply.code(400);
        return { detail: (err as Error).message };
      }
    },
  );

  // The interview tool blocks its run until the user answers here (or the
  // form is dismissed). 404 = nothing waiting (answered, timed out, aborted);
  // 400 = fixable submission problem — the pending interview is NOT consumed,
  // so the form can correct and resubmit.
  app.post<{ Params: { id: string; toolCallId: string }; Body: InterviewAnswer }>(
    "/sessions/:id/interview/:toolCallId",
    async (req, reply) => {
      const body = (req.body ?? {}) as { cancelled?: boolean; responses?: unknown };
      const answer = (
        body.cancelled ? { cancelled: true } : { responses: body.responses ?? [] }
      ) as InterviewAnswer;
      const invalid = validateAnswer(answer);
      if (invalid) {
        reply.code(400);
        return { detail: invalid };
      }
      const ok = resolveInterview(
        currentProjectId(),
        req.params.id,
        req.params.toolCallId,
        answer,
      );
      if (!ok) {
        reply.code(404);
        return { detail: "No pending interview for this tool call" };
      }
      return { ok: true };
    },
  );

  // Data-guard permission decisions (destructive shell commands).
  app.post<{ Params: { id: string; requestId: string }; Body: { allow?: unknown } }>(
    "/sessions/:id/permissions/:requestId",
    async (req, reply) => {
      const allow = req.body?.allow;
      if (typeof allow !== "boolean") {
        reply.code(400);
        return { detail: "allow must be a boolean" };
      }
      const ok = resolvePermission(currentProjectId(), req.params.id, req.params.requestId, allow);
      if (!ok) {
        reply.code(404);
        return { detail: "No pending permission request for this id" };
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>("/sessions/:id/permissions", async (req) => {
    return { pending: pendingPermissionFor(currentProjectId(), req.params.id) };
  });

  // Pending interview for a session (lets a reconnecting UI re-render the form).
  app.get<{ Params: { id: string } }>("/sessions/:id/interview", async (req) => {
    return { pending: pendingInterviewFor(currentProjectId(), req.params.id) };
  });

  // `?frames=0` returns metadata only (no replay buffer/baseline) so an idle
  // tab can poll cheaply for a run it did not start (system-initiated runs).
  app.get<{ Params: { id: string }; Querystring: { frames?: string } }>(
    "/sessions/:id/run/state",
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const includeFrames = req.query.frames !== "0";
      return runBroker.state(currentProjectId(), req.params.id, { includeFrames });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/sessions/:id/run/events",
    async (req, reply) => {
      const rawAfter = req.query.after;
      const after = rawAfter === undefined ? 0 : Number(rawAfter);
      if (!Number.isSafeInteger(after) || after < 0) {
        reply.code(400);
        return { detail: "after must be a non-negative integer" };
      }
      const handle = runBroker.get(currentProjectId(), req.params.id);
      if (!handle) {
        reply.code(404);
        return { detail: "No retained run for this session" };
      }
      streamRun(req, reply, handle, after);
    },
  );

  app.post<{ Params: { id: string } }>("/sessions/:id/abort", async (req) => {
    const projectId = currentProjectId();
    // Mark first so an abort racing with pre-prompt model setup prevents that
    // detached owner from entering prompt() after session.abort() returns.
    runBroker.get(projectId, req.params.id)?.requestAbort();
    // Release any interview blocking the turn before aborting: a form still
    // waiting on user input would otherwise keep the run alive.
    cancelInterviewsForSession(projectId, req.params.id);
    cancelPermissionsForSession(projectId, req.params.id);
    const session = await getSession(projectId, activePaths(), req.params.id);
    if (!session) return { ok: true, restored: [] };
    // Clear BEFORE abort so a pending steer can't be delivered into the
    // dying loop; the texts go back to the composer client-side.
    const cleared = session.clearQueue();
    await session.abort();
    return { ok: true, restored: [...cleared.steering, ...cleared.followUp] };
  });

  // Steering side-channel: queue a message into the LIVE run (delivered by Pi
  // after the current tool calls, before the next LLM call). Never creates a
  // run or an SSE stream — the /run stream carries the delivery + queue_update
  // frames. 409 reason "not_streaming" tells the client to fall back to a
  // normal run.
  app.post<{ Params: { id: string }; Body: { message?: string } }>(
    "/sessions/:id/steer",
    async (req, reply) => {
      const projectId = currentProjectId();
      const session = await getSession(projectId, activePaths(), req.params.id);
      if (!session) {
        reply.code(404);
        return { detail: "No such session" };
      }
      const message = req.body?.message;
      if (!message || !message.trim()) {
        reply.code(400);
        return { detail: "message is required" };
      }
      if (!session.isStreaming) {
        reply.code(409);
        return { detail: "No run in flight", reason: "not_streaming" };
      }
      // A steer extends a live run's spend past what the run-start check
      // gated, so re-check the cap here.
      const budget = isBudgetExceeded(projectId);
      const steeringBilling = session.model
        ? await billingForModel(session.model, getModelRuntime())
        : { provider: "unknown", authType: "none" as const, billingMode: "payg" as const };
      if (billingCountsTowardBudget(steeringBilling) && budget.exceeded) {
        reply.code(403);
        return {
          detail:
            `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
            `$${(budget.limitUsd ?? 0).toFixed(2)}).`,
          reason: "budget",
        };
      }
      await session.steer(expandChatCommand(activePaths(), message));
      // The run can end between the guard and the queue write; a steer left
      // behind would silently deliver into the NEXT run, so pull it back out.
      if (!session.isStreaming) {
        const cleared = session.clearQueue();
        reply.code(409);
        return {
          detail: "Run ended before the message was delivered",
          reason: "not_streaming",
          // Hand every dropped message back so the client can restore them;
          // clearQueue also discards anything queued before this steer.
          restored: [...cleared.steering, ...cleared.followUp],
        };
      }
      return { ok: true, pending: [...session.getSteeringMessages()] };
    },
  );

  // Manual context compaction ("Compact now"). Runs outside a run: Pi's
  // compact() aborts any live turn first, so refuse while streaming instead.
  // The summary call's usage lands on the compaction entry and in
  // getSessionStats(), so the before/after delta is ledgered like a turn.
  app.post<{ Params: { id: string }; Body: { instructions?: string } }>(
    "/sessions/:id/compact",
    async (req, reply) => {
      const projectId = currentProjectId();
      const sessionId = req.params.id;
      const session = await getSession(projectId, activePaths(), sessionId);
      if (!session) {
        reply.code(404);
        return { detail: "No such session" };
      }
      if (session.isStreaming || isRunClaimed(projectId, sessionId)) {
        reply.code(409);
        return { detail: "Wait for the current run to finish before compacting", reason: "streaming" };
      }
      const instructions =
        typeof req.body?.instructions === "string" ? req.body.instructions.slice(0, 2_000) : undefined;
      const billing = session.model
        ? await billingForModel(session.model, getModelRuntime())
        : { provider: "unknown", authType: "none" as const, billingMode: "payg" as const };
      const budget = isBudgetExceeded(projectId);
      if (billingCountsTowardBudget(billing) && budget.exceeded) {
        reply.code(402);
        return {
          detail:
            `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
            `$${(budget.limitUsd ?? 0).toFixed(2)}). Raise the limit in project settings.`,
          reason: "budget",
        };
      }
      const before = snapshot(session);
      let result: Awaited<ReturnType<typeof session.compact>>;
      try {
        result = await session.compact(instructions);
      } catch (err) {
        const message = (err as Error).message;
        // Pi refuses when every message fits inside `keepRecentTokens`; that
        // is a normal state, not a failure.
        if (/nothing to compact/i.test(message)) {
          reply.code(409);
          return {
            detail: "Nothing to compact yet: the whole conversation still fits inside the recent-context window.",
            reason: "too_small",
          };
        }
        reply.code(502);
        return { detail: `Compaction failed: ${message}` };
      }
      const entry = recordRun({
        sessionId,
        projectId,
        model: session.model ? modelReference(session.model) : "unknown",
        role: "agent",
        before: emptySnapshot(),
        after: snapshotDelta(before, snapshot(session)),
        billing,
      });
      return {
        ok: true,
        tokensBefore: result.tokensBefore,
        estimatedTokensAfter: result.estimatedTokensAfter ?? null,
        costUsd: entry?.costUsd ?? 0,
        billingMode: billing.billingMode,
        contextUsage: contextUsageForClient(session) ?? null,
      };
    },
  );

  // Follow-up side-channel: queue a message that Pi delivers once the live
  // run has no more tool calls or steering messages, still inside the same
  // run (same SSE stream, same ledger row). Unlike steering it may carry
  // images. Same 409/403 contract as /steer.
  app.post<{ Params: { id: string }; Body: { message?: string; images?: unknown } }>(
    "/sessions/:id/follow-up",
    async (req, reply) => {
      const projectId = currentProjectId();
      const session = await getSession(projectId, activePaths(), req.params.id);
      if (!session) {
        reply.code(404);
        return { detail: "No such session" };
      }
      const message = req.body?.message;
      if (!message || !message.trim()) {
        reply.code(400);
        return { detail: "message is required" };
      }
      const parsedImages = parseRunImages(req.body?.images);
      if ("error" in parsedImages) {
        reply.code(400);
        return { detail: parsedImages.error };
      }
      if (!session.isStreaming) {
        reply.code(409);
        return { detail: "No run in flight", reason: "not_streaming" };
      }
      const budget = isBudgetExceeded(projectId);
      const followUpBilling = session.model
        ? await billingForModel(session.model, getModelRuntime())
        : { provider: "unknown", authType: "none" as const, billingMode: "payg" as const };
      if (billingCountsTowardBudget(followUpBilling) && budget.exceeded) {
        reply.code(403);
        return {
          detail:
            `Project spend limit reached ($${budget.totalUsd.toFixed(2)} / ` +
            `$${(budget.limitUsd ?? 0).toFixed(2)}).`,
          reason: "budget",
        };
      }
      await session.followUp(
        expandChatCommand(activePaths(), message),
        parsedImages.images.length > 0 ? parsedImages.images : undefined,
      );
      if (!session.isStreaming) {
        const cleared = session.clearQueue();
        reply.code(409);
        return {
          detail: "Run ended before the message was delivered",
          reason: "not_streaming",
          restored: [...cleared.steering, ...cleared.followUp],
        };
      }
      return { ok: true, pending: [...session.getFollowUpMessages()] };
    },
  );

  app.post<{ Params: { id: string }; Body: RunBody }>(
    "/sessions/:id/run",
    async (req, reply) => {
      const started = await beginRun(req.params.id, req.body, req.log);
      if ("failure" in started) {
        reply.code(started.failure.statusCode);
        return started.failure.body;
      }
      // The detached owner already retains the run, so attaching this stream is
      // pure observation: a client disconnect cannot interrupt Pi, accounting,
      // or cleanup.
      streamRun(req, reply, started.handle);
    },
  );
}
