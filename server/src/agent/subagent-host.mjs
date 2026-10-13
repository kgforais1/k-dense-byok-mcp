/** Runs in both the backend and detached Pi runner. No shared process identity:
 * owner/model/auth are captured per session and per request. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// Keep fetch and its explicit dispatcher on the same undici implementation.
// Node 22/24's built-in fetch uses an older handler contract than undici 8.
import { Agent, fetch } from 'undici';
const direct = new Agent();
let localMeter;
const childOwners = new Map();
export function setHostMeter(handler) { localMeter = handler; }
function projectOwner(cwd) {
  for (let dir = path.resolve(cwd);;) {
    if (path.basename(dir) === 'sandbox') {
      const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'project.json'), 'utf8'));
      if (meta.id !== path.basename(path.dirname(dir))) throw new Error('Invalid child project identity');
      return { projectId: meta.id, sandbox: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Subagent launch must remain in a Kady project sandbox');
    dir = parent;
  }
}
async function meter(action, input) {
  if (localMeter) return localMeter(action, input);
  const url = new URL(process.env.KADY_INTERNAL_URL || `http://127.0.0.1:${process.env.KADY_PORT || process.env.PORT || 8000}`);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Invalid Kady internal URL');
  url.pathname = `/subagents/meter/${action}`;
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', dispatcher: direct,
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-Project-Id': input.projectId,
      ...(process.env.KADY_AUTH_TOKEN ? { 'X-Kady-Token': process.env.KADY_AUTH_TOKEN } : {}) },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || 'Subagent accounting unavailable');
  return result;
}
function persistUsage(request) {
  if (!request.sandbox) return undefined;
  const dir = path.join(request.sandbox, '.kady', 'subagent-usage-pending');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${request.requestId}.json`), tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(request)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return file;
}
export function meteredStream(base, owner, usingOAuth) {
  return async (model, context, options) => {
    const request = { ...owner, requestId: randomUUID(), provider: model.provider, model: model.id,
      authType: usingOAuth(model) ? 'oauth' : 'api_key' };
    await meter('admit', request);
    const stream = await base(model, context, options);
    // Meter before exposing the terminal event, so the next request and the
    // parent's completion cannot race ahead of accounting. Never consume twice.
    let settled;
    const settle = (message) => settled ??= (async () => {
      const usage = { ...request, usage: message?.usage };
      const pending = persistUsage(usage);
      await meter('usage', usage);
      if (pending) fs.rmSync(pending, { force: true });
    })();
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of stream) {
          if (event.type === 'done' || event.type === 'error') await settle(event.message || event.error);
          yield event;
        }
      },
      async result() { const message = await stream.result(); await settle(message); return message; },
    };
  };
}
// FORK: Pi 1.1 keeps MCP (`mcp__*`) tools registered unless the child allowlist
// is empty or names an `mcp__` tool. A restricted child — an explicit
// `launch.tools` (which also carries a capability-ceiling allowlist, see
// pi-subagents resolvePiLaunchToolPlan) — must still exclude the MCP tools it
// does not name, exactly as before 1.1.
//
// Pinned-Pi compat seam (Pi 1.1.x AgentSession): `_allowlistFiltersMcp` chooses
// whether a non-empty allowlist also filters `mcp__*` tools, and
// `_refreshToolRegistry()` re-derives the registry. The flag alone only affects
// later filtering: tools registered at construction (custom tools, or an
// extension that registers before this seam) and not re-derived would stay
// callable, and `bindExtensions` does not refresh the registry either. So flip
// the flag and refresh immediately; MCP that connects later is filtered at its
// own registration. Fail visibly if a Pi upgrade changes this shape rather than
// silently leaving a restricted child with MCP tools it must not have.
/** No explicit tool list means the child is not under a capability ceiling. */
function childHasNoToolCeiling(tools) {
  return tools === undefined || tools.length === 0;
}

/** The pinned Pi fields this seam writes. Null means the SDK shape drifted. */
function childMcpAllowlistSeam(session) {
  if (typeof session._allowlistFiltersMcp !== "boolean") return null;
  if (typeof session._refreshToolRegistry !== "function") return null;
  return session;
}

/**
 * Restore a strict MCP ceiling for one child session.
 *
 * Input is the child `AgentSession` and its launch, whose `tools` list is the
 * ceiling. When that list is present and non-empty, unlisted `mcp__` tools are
 * removed, including tools already registered. Returns nothing. Requires the
 * pinned Pi fields `_allowlistFiltersMcp` and `_refreshToolRegistry`.
 */
export function restrictChildMcpToAllowlist(session, launch) {
  if (childHasNoToolCeiling(launch.tools)) return;
  if (!childMcpAllowlistSeam(session)) {
    throw new Error(
      "Kady child MCP allowlist seam no longer matches the pinned Pi SDK " +
      "(AgentSession._allowlistFiltersMcp/_refreshToolRegistry). Review " +
      "server/src/agent/subagent-host.mjs before upgrading Pi.",
    );
  }
  if (session._allowlistFiltersMcp) return; // already filtering: empty allowlist or a named mcp__ tool
  session._allowlistFiltersMcp = true;
  session._refreshToolRegistry();
}
export function attachChildSession(session, launch, runtime) {
  restrictChildMcpToAllowlist(session, launch);
  const parentId = launch.runtime.orchestratorSessionId || launch.runtime.parentSessionId || session.sessionId;
  const owner = { ...projectOwner(launch.cwd), sessionId: childOwners.get(parentId)?.sessionId || parentId,
    childSessionId: session.sessionId, sessionFile: session.sessionFile, kind: 'subagent', runId: launch.runtime.runId };
  childOwners.set(session.sessionId, owner);
  const dispose = session.dispose.bind(session);
  session.dispose = () => { childOwners.delete(session.sessionId); return dispose(); };
  session.agent.streamFunction = meteredStream(session.agent.streamFunction.bind(session.agent), owner, model => runtime.isUsingOAuth(model.provider));
}
export function watchdogStream(ctx, base) {
  const sessionId = ctx.sessionManager.getSessionId();
  return meteredStream(base, { ...projectOwner(ctx.cwd), sessionId, ...childOwners.get(sessionId), kind: 'watchdog' },
    model => ctx.modelRegistry.isUsingOAuth(model));
}
