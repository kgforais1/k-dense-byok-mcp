/** Durable terminal snapshots for run-broker handles. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../projects.ts";
import type { RunActivityState, RunHandle, SequencedClientFrame } from "./run-broker.ts";

export type DurableRunStatus = Exclude<RunActivityState, "running"> | "aborted";

export interface DurableRunResult {
  runId: string;
  sessionId: string;
  status: DurableRunStatus;
  frames: SequencedClientFrame[];
  lastSeq: number;
  completedAt: string;
}

const RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RESULTS_PER_PROJECT = 500;

function pruneResults(resultsDir: string, now = Date.now()): void {
  try {
    const files = fs.readdirSync(resultsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        const file = path.join(resultsDir, entry.name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const [index, entry] of files.entries()) {
      if (now - entry.mtimeMs > RESULT_RETENTION_MS || index >= MAX_RESULTS_PER_PROJECT) {
        fs.unlinkSync(entry.file);
      }
    }
  } catch {
    // Retention is best effort; a completed result must not be lost because
    // cleanup raced another process or encountered an unrelated bad entry.
  }
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
}

function resultPath(projectId: string, runId: string): string {
  validateRunId(runId);
  return path.join(resolvePaths(projectId).runsDir, "results", `${runId}.json`);
}

/** Atomically persist the replayable terminal frames for a completed run. */
export function persistRunResult(projectId: string, handle: RunHandle): DurableRunResult {
  if (!handle.isComplete) throw new Error("Cannot persist a non-terminal run");
  const state = handle.state();
  const activityState = handle.activityState;
  if (activityState === "running" || !state.run) {
    throw new Error("Cannot persist an incomplete run state");
  }
  const status: DurableRunStatus = handle.isAbortRequested ? "aborted" : activityState;
  const result: DurableRunResult = {
    runId: handle.runId,
    sessionId: handle.sessionId,
    status,
    frames: state.run.frames,
    lastSeq: state.run.lastSeq,
    completedAt: new Date().toISOString(),
  };
  const file = resultPath(projectId, result.runId);
  const resultsDir = path.dirname(file);
  fs.mkdirSync(resultsDir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(result) + "\n", "utf8");
    fs.renameSync(tmp, file);
    pruneResults(resultsDir);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Rename consumed it, or the best-effort cleanup has nothing to remove.
    }
  }
  return result;
}

/** Return a terminal result by id, distinct from a missing/unknown run. */
export function readRunResult(projectId: string, runId: string): DurableRunResult | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(resultPath(projectId, runId), "utf8")) as DurableRunResult;
    if (
      parsed.runId !== runId ||
      typeof parsed.sessionId !== "string" ||
      (parsed.status !== "done" &&
        parsed.status !== "error" &&
        parsed.status !== "blocked" &&
        parsed.status !== "aborted") ||
      !Array.isArray(parsed.frames) ||
      !Number.isSafeInteger(parsed.lastSeq) ||
      typeof parsed.completedAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
