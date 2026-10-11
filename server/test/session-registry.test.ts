// FORK: check required values at runtime instead of asserting away nullability.
import { required as requireValue } from "../src/required.ts";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
// FORK: exercise construction barriers and failed-deletion recovery with real Pi sessions.
import { DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { ensureProjectExists } from "../src/projects.ts";
// FORK: deletion admission and recovery share the live registry's lifecycle.
import { SHUTDOWN_GRACE_MS, deleteSession, isDeletedSession, disposeSession, disposeProjectSessions, getSession } from "../src/agent/session-registry.ts";
import { markHeadlessSession } from "../src/agent/headless-sessions.ts";
import { subagentHost } from "../src/agent/subagent-control.ts";

const projectId = "session-registry";
afterEach(async () => {
  await disposeProjectSessions(projectId);
  vi.restoreAllMocks();
});

function savedSession() {
  const paths = ensureProjectExists(projectId);
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const manager = SessionManager.create(paths.sandbox, paths.sessionsDir);
  manager.appendMessage({ role: "user", content: "A persisted conversation", timestamp: Date.now() });
  return { paths, sessionId: manager.getSessionId() };
}

describe("cold session opens", () => {
  // FORK: verify headless identity with real sessions after the native MCP migration.
  it.each([true, false])("preserves interview availability on real cold opens (interactive=%s)", async (interactive) => {
    const { paths, sessionId } = savedSession();
    if (!interactive) markHeadlessSession(projectId, sessionId);
    const first = requireValue((await getSession(projectId, paths, sessionId)));
    expect(first.getAllTools().some(tool => tool.name === "interview")).toBe(interactive);
    expect(first.getActiveToolNames()).toContain("notebook");
    await disposeSession(projectId, sessionId);
    const reopened = requireValue((await getSession(projectId, paths, sessionId)));
    expect(reopened).not.toBe(first);
    expect(reopened.getAllTools().some(tool => tool.name === "interview")).toBe(interactive);
  });

  it("shares one real Pi session and extension host across concurrent requests", async () => {
    const { paths, sessionId } = savedSession();
    const warnings = vi.spyOn(console, "warn");
    const sessions = await Promise.all([
      getSession(projectId, paths, sessionId),
      getSession(projectId, paths, sessionId),
      getSession(projectId, paths, sessionId),
    ]);
    expect(sessions[0]).not.toBeNull();
    expect(sessions[1]).toBe(sessions[0]);
    expect(sessions[2]).toBe(sessions[0]);
    expect(await getSession(projectId, paths, sessionId)).toBe(sessions[0]);
    expect(warnings.mock.calls.some((args) => String(args[0]).includes("[session-registry] extension error"))).toBe(false);
    expect(await subagentHost(projectId, sessionId).rpc("status")).toHaveProperty("asyncSnapshot");
  }, 30_000);

  it("shares a failed opening attempt and allows a fresh retry", async () => {
    const { paths, sessionId } = savedSession();
    // The real construction path first opens the JSONL. Fail that operation
    // once without mocking getSession or the session/extension implementation.
    const open = vi.spyOn(SessionManager, "open").mockImplementationOnce(() => {
      throw new Error("Temporary session read failure");
    });
    const attempts = await Promise.allSettled([
      getSession(projectId, paths, sessionId),
      getSession(projectId, paths, sessionId),
    ]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
    expect(open).toHaveBeenCalledTimes(1);
    const retried = await getSession(projectId, paths, sessionId);
    expect(retried?.sessionId).toBe(sessionId);
    expect(open).toHaveBeenCalledTimes(2);
    expect(await getSession(projectId, paths, sessionId)).toBe(retried);
  }, 30_000);

  it("does not cache a missing session", async () => {
    const { paths, sessionId } = savedSession();
    vi.spyOn(SessionManager, "list").mockResolvedValueOnce([]);
    expect(await getSession(projectId, paths, sessionId)).toBeNull();
    expect((await getSession(projectId, paths, sessionId))?.sessionId).toBe(sessionId);
  }, 30_000);
});

describe("session release", () => {
  // FORK: deletion must fence opens that passed the first tombstone check.
  it("does not publish a cold open that finishes during deletion", async () => {
    const { paths, sessionId } = savedSession();
    let resume!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const realReload = DefaultResourceLoader.prototype.reload;
    vi.spyOn(DefaultResourceLoader.prototype, "reload").mockImplementationOnce(async function () {
      started();
      await gate;
      return realReload.call(this);
    });
    const opening = getSession(projectId, paths, sessionId);
    await ready;
    const deleting = deleteSession(projectId, paths, sessionId);
    expect(isDeletedSession(projectId, sessionId)).toBe(true);
    // Allow construction to finish after deletion has fenced new callers.
    resume();
    expect(await getSession(projectId, paths, sessionId)).toBeNull();
    expect(await opening).toBeNull();
    expect(await deleting).toBe("deleted");
    expect(await getSession(projectId, paths, sessionId)).toBeNull();
  });

  // FORK: not_deleted describes the transcript; cache eviction is recoverable.
  it("allows a fresh open when disposal fails after releasing the original session", async () => {
    const { paths, sessionId } = savedSession();
    const session = requireValue(await getSession(projectId, paths, sessionId));
    const realDispose = session.dispose.bind(session);
    vi.spyOn(session, "dispose").mockImplementationOnce(() => {
      realDispose();
      throw new Error("Cleanup failed");
    });
    expect(await deleteSession(projectId, paths, sessionId)).toBe("not_deleted");
    expect(isDeletedSession(projectId, sessionId)).toBe(false);
    const reopened = requireValue(await getSession(projectId, paths, sessionId));
    expect(reopened).not.toBe(session);
    expect(reopened.messages.some(message => message.role === "user")).toBe(true);
  });

  it("allows reopening when transcript removal fails", async () => {
    const { paths, sessionId } = savedSession();
    await getSession(projectId, paths, sessionId);
    const realRemove = fs.rmSync;
    const remove = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target).endsWith(".jsonl")) throw new Error("Transcript is locked");
      return realRemove(target, options);
    });
    try {
      expect(await deleteSession(projectId, paths, sessionId)).toBe("not_deleted");
      expect(isDeletedSession(projectId, sessionId)).toBe(false);
      expect((await getSession(projectId, paths, sessionId))?.sessionId).toBe(sessionId);
    } finally {
      remove.mockRestore();
    }
  });

  it("disposes after the grace period when a shutdown handler never settles", async () => {
    const { paths, sessionId } = savedSession();
    const session = requireValue((await getSession(projectId, paths, sessionId)));
    const emit = vi.spyOn(session.extensionRunner, "emit").mockReturnValue(new Promise(() => {}));
    const dispose = vi.spyOn(session, "dispose");
    vi.useFakeTimers();
    try {
      const released = disposeProjectSessions(projectId);
      await vi.advanceTimersByTimeAsync(SHUTDOWN_GRACE_MS - 1);
      expect(dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await released;
      expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});
