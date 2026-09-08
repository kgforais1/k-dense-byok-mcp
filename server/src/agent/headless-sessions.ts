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

/**
 * Session ids come from Pi, but this value reaches the filesystem, so it is
 * validated the same way `run-results.ts` validates run ids rather than
 * trusted. A rejected id fails closed: `isHeadlessSession` returns false and
 * the caller keeps the interactive default.
 */
function isSafeSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId);
}

function markerPath(projectId: string, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  const markerRoot = path.resolve(resolvePaths(projectId).kadyDir, "headless-sessions");
  const file = path.resolve(markerRoot, `${sessionId}.json`);
  // Keep this normalized containment check next to the filesystem sinks, as
  // `cost/ledger.ts` does. The grammar above already blocks traversal, but this
  // protects the boundary even if a future caller broadens that grammar — and
  // it is the form static analysis can actually see.
  if (!file.startsWith(`${markerRoot}${path.sep}`)) return null;
  return file;
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

/** True when this session was created headless, including after a cold open. */
export function isHeadlessSession(projectId: string, sessionId: string): boolean {
  const file = markerPath(projectId, sessionId);
  if (!file) return false;
  return fs.existsSync(file);
}
