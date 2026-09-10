/**
 * Durable "this session is headless" marker.
 *
 * MCP-created sessions omit the `interview` tool because it blocks mid-run
 * waiting for the browser UI to post an answer. That choice is made once, at
 * `createSession` time, but it has to survive longer than the live registry:
 * `evictOverCap` LRU-evicts idle sessions past the per-project cap, and the
 * next `getSession` cold-opens the JSONL file and rebuilds the Pi session from
 * scratch. Without a marker on disk that rebuild silently re-enables
 * `interview`, and the next MCP-driven run blocks forever on a form no MCP
 * client can see.
 *
 * The marker is one small file per session under the project's `.kady` tree,
 * mirroring `run-results.ts`: cheap to write once, cheap to read on every
 * cold open, and removed with the project.
 */
import fs from "node:fs";
import path from "node:path";
import { resolvePaths } from "../projects.ts";
// Shared rather than restated: this file had its own copy of the same rule,
// and the two drifted the moment one of them gained a check. A rejected id
// fails closed here — `isHeadlessSession` returns false and the caller keeps
// the interactive default.
import { isSafeSessionId } from "./session-export.ts";
import { containedIn } from "../paths-contained.ts";

function markerPath(projectId: string, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  const markerRoot = path.resolve(resolvePaths(projectId).kadyDir, "headless-sessions");
  try {
    return containedIn(markerRoot, `${sessionId}.json`);
  } catch {
    // The shared rule throws; this file's callers expect `null` and no-op on
    // it, because a missing marker means "interactive" and that is the safe
    // default here.
    return null;
  }
}

/** Record that `sessionId` was created headless and must stay that way. */
export function markHeadlessSession(projectId: string, sessionId: string): void {
  const file = markerPath(projectId, sessionId);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ sessionId, createdAt: new Date().toISOString(), reason: "mcp" }),
  );
  fs.renameSync(tmp, file);
}

/** Remove the headless marker for `sessionId`. */
export function forgetHeadlessSession(projectId: string, sessionId: string): void {
  const file = markerPath(projectId, sessionId);
  if (!file) return;
  // A swept transcript whose marker survives is exactly the bug Phase 3
  // warns about: a later reused session id cold-opens headless and silently
  // loses the `interview` tool. `force: true` swallows a missing marker so
  // the caller can treat transcript + marker removal as one atomic cleanup.
  fs.rmSync(file, { force: true });
}

/** True when this session was created headless, including after a cold open. */
export function isHeadlessSession(projectId: string, sessionId: string): boolean {
  const file = markerPath(projectId, sessionId);
  if (!file) return false;
  return fs.existsSync(file);
}
