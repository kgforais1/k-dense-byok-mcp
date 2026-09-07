/** Durable terminal snapshots for run-broker handles. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../projects.ts";
import type { RunActivityState, RunHandle, SequencedClientFrame } from "./run-broker.ts";

export interface DurableRunResult {
  runId: string;
  sessionId: string;
  status: Exclude<RunActivityState, "running">;
  frames: SequencedClientFrame[];
  lastSeq: number;
  completedAt: string;
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
  const status = handle.activityState;
  if (status === "running" || !state.run) throw new Error("Cannot persist an incomplete run state");
  const result: DurableRunResult = {
    runId: handle.runId,
    sessionId: handle.sessionId,
    status,
    frames: state.run.frames,
    lastSeq: state.run.lastSeq,
    completedAt: new Date().toISOString(),
  };
  const file = resultPath(projectId, result.runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(result) + "\n", "utf8");
    fs.renameSync(tmp, file);
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
      (parsed.status !== "done" && parsed.status !== "error" && parsed.status !== "blocked") ||
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
