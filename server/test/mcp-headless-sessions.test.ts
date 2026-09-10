/**
 * The Phase 1 prerequisite for exposing MCP runs: an MCP session must not carry
 * the blocking `interview` tool, and must not silently regain it later.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createProject, resolvePaths } from "../src/projects.ts";
import { isHeadlessSession, markHeadlessSession } from "../src/agent/headless-sessions.ts";
import {
  deleteSession,
  HEADLESS_PROMPT_NOTE,
  sessionToolNames,
} from "../src/agent/session-registry.ts";
import { RunBroker, runBroker, type RunMetadata } from "../src/agent/run-broker.ts";
import { persistRunResult, readRunResult } from "../src/agent/run-results.ts";
import { buildApp } from "../src/index.ts";

function metadata(runId = "run-1"): RunMetadata {
  return {
    runId,
    prompt: "test",
    images: [],
    baseline: { messages: [], contextUsage: null },
  };
}

const realReaddir = fs.readdirSync;

describe("deleteSession", () => {
  afterEach(() => {
    runBroker.clear();
  });

  /**
   * A transcript in Pi's real shape, in both respects that deletion cares
   * about: named `<timestamp>_<id>.jsonl`, and carrying a `session` header
   * row. A fixture written as a bare `<id>.jsonl` full of `{}` takes the
   * exact-name shortcut and never exercises the lookup at all, which is how
   * a suffix collision hid here for two review rounds.
   */
  function writeSessionFile(
    sessionsDir: string,
    sessionId: string,
    options?: { name?: string; rows?: unknown[] },
  ): string {
    fs.mkdirSync(sessionsDir, { recursive: true });
    const file = path.join(sessionsDir, options?.name ?? `20260909-101500_${sessionId}.jsonl`);
    const rows = options?.rows ?? [
      { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString() },
    ];
    fs.writeFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
    return file;
  }

  it("removes both the transcript and the headless marker", () => {
    const projectId = "delete-session-cleanup";
    createProject({ projectId, name: "Delete session cleanup" });
    const paths = resolvePaths(projectId);
    const sessionId = "session-to-delete";

    writeSessionFile(paths.sessionsDir, sessionId);

    markHeadlessSession(projectId, sessionId);

    const result = deleteSession(projectId, paths, sessionId);
    expect(result).toBe("deleted");

    expect(fs.existsSync(path.join(paths.sessionsDir, `${sessionId}.jsonl`))).toBe(false);
    expect(isHeadlessSession(projectId, sessionId)).toBe(false);
  });

  it("does not delete a different session whose filename merely ends with the id", () => {
    // `findSessionFile` matches on a filename suffix, so the id `23` also
    // matches `subagent-123.jsonl`. Harmless for a read, destructive here.
    const projectId = "delete-session-collide";
    createProject({ projectId, name: "Delete session collide" });
    const paths = resolvePaths(projectId);

    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    const other = path.join(paths.sessionsDir, "subagent-123.jsonl");
    fs.writeFileSync(other, `${JSON.stringify({ type: "session", id: "subagent-123" })}\n`);

    expect(deleteSession(projectId, paths, "23")).toBe("not_found");
    expect(fs.existsSync(other)).toBe(true);
  });

  it("removes the notebook, annotations and provenance that belong to the chat", () => {
    // These are part of the chat, not separate records. Left behind, the lab
    // notebook still lists entries for a chat that no longer exists.
    const projectId = "delete-session-artifacts";
    createProject({ projectId, name: "Delete session artifacts" });
    const paths = resolvePaths(projectId);
    const sessionId = "session-with-artifacts";

    writeSessionFile(paths.sessionsDir, sessionId);
    fs.mkdirSync(paths.notebookDir, { recursive: true });
    const notebook = path.join(paths.notebookDir, `${sessionId}.jsonl`);
    const annotations = path.join(paths.notebookDir, `${sessionId}.annotations.json`);
    const provenance = path.join(paths.provenanceDir, sessionId);
    fs.writeFileSync(notebook, "{}");
    fs.writeFileSync(annotations, "{}");
    fs.mkdirSync(provenance, { recursive: true });
    fs.writeFileSync(path.join(provenance, "steps.jsonl"), "{}");

    expect(deleteSession(projectId, paths, sessionId)).toBe("deleted");
    expect(fs.existsSync(notebook)).toBe(false);
    expect(fs.existsSync(annotations)).toBe(false);
    expect(fs.existsSync(provenance)).toBe(false);
  });

  it("stops poll_run serving a deleted session's runs", () => {
    // Durable records are keyed by runId, so without a sweep `poll_run` keeps
    // answering for a session `get_session_history` now 404s on.
    const projectId = "delete-session-runs";
    createProject({ projectId, name: "Delete session runs" });
    const paths = resolvePaths(projectId);
    const sessionId = "session-with-runs";

    writeSessionFile(paths.sessionsDir, sessionId);
    const expired = new RunBroker({ completedRetentionMs: 1 });
    const handle = expired.start(projectId, sessionId, metadata("run-kept"));
    handle.publish({ type: "done" });
    handle.complete();
    persistRunResult(projectId, handle);
    expect(readRunResult(projectId, "run-kept")).not.toBeNull();

    expect(deleteSession(projectId, paths, sessionId)).toBe("deleted");
    expect(readRunResult(projectId, "run-kept")).toBeNull();
  });

  it("still finishes the delete when the headless marker cannot be removed", () => {
    // `force: true` only suppresses ENOENT. An EPERM, or a Windows handle held
    // on the marker, used to escape `deleteSession` entirely and strand it
    // half-done: transcript gone, but the tombstone unset and `poll_run` still
    // serving the run records, while the route answered 400.
    const projectId = "delete-session-marker-locked";
    createProject({ projectId, name: "Delete session marker locked" });
    const paths = resolvePaths(projectId);
    const sessionId = "marker-locked";

    writeSessionFile(paths.sessionsDir, sessionId);
    markHeadlessSession(projectId, sessionId);
    const expired = new RunBroker({ completedRetentionMs: 1 });
    const handle = expired.start(projectId, sessionId, metadata("run-marker"));
    handle.publish({ type: "done" });
    handle.complete();
    persistRunResult(projectId, handle);

    const real = fs.rmSync;
    const rmSync = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target).includes("headless-sessions")) {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }
      return real(target, options);
    });

    try {
      expect(deleteSession(projectId, paths, sessionId)).toBe("deleted");
    } finally {
      rmSync.mockRestore();
    }
    // The steps after the marker still ran.
    expect(readRunResult(projectId, "run-marker")).toBeNull();
  });

  it("deletes the exact session even when a suffix-colliding file exists", () => {
    // `findSessionFile` returns whichever candidate readdir yields first, so a
    // session with a colliding neighbour could report not_found and become
    // undeletable.
    const projectId = "delete-session-both";
    createProject({ projectId, name: "Delete session both" });
    const paths = resolvePaths(projectId);

    const wanted = writeSessionFile(paths.sessionsDir, "23", { name: "23.jsonl" });
    const neighbour = writeSessionFile(paths.sessionsDir, "subagent-123", {
      name: "subagent-123.jsonl",
    });

    expect(deleteSession(projectId, paths, "23")).toBe("deleted");
    expect(fs.existsSync(wanted)).toBe(false);
    expect(fs.existsSync(neighbour)).toBe(true);
  });

  it("refuses a file named for the session whose header names another", () => {
    // The name is not proof. A transcript literally called `23.jsonl` whose
    // header says it belongs to `other` is not session `23`, and deleting it
    // destroys a transcript the caller never asked about.
    const projectId = "delete-session-header-lies";
    createProject({ projectId, name: "Delete session header lies" });
    const paths = resolvePaths(projectId);

    const impostor = writeSessionFile(paths.sessionsDir, "other", { name: "23.jsonl" });

    expect(deleteSession(projectId, paths, "23")).toBe("not_found");
    expect(fs.existsSync(impostor)).toBe(true);
  });

  it("is not shadowed by a stray file that carries no header", () => {
    // Pi writes the header when it creates the file, so an empty transcript is
    // not a session. A stray `23.jsonl` beside the real
    // `<timestamp>_23.jsonl` must neither be deleted in its place nor make the
    // real one unreachable — which is what stopping at the first candidate
    // `readdir` yields used to do.
    const projectId = "delete-session-shadow";
    createProject({ projectId, name: "Delete session shadow" });
    const paths = resolvePaths(projectId);

    const real = writeSessionFile(paths.sessionsDir, "23");
    const shadow = path.join(paths.sessionsDir, "23.jsonl");
    fs.writeFileSync(shadow, "");
    const expired = new RunBroker({ completedRetentionMs: 1 });
    const handle = expired.start(projectId, "23", metadata("run-real"));
    handle.publish({ type: "done" });
    handle.complete();
    persistRunResult(projectId, handle);

    // Forced, not hoped for. Every Pi filename starts with an ISO year, so the
    // stray sorts second on any real listing and the scan would find the right
    // file first by luck. The bug is only visible when it does not.
    const readdirSync = vi
      .spyOn(fs, "readdirSync")
      .mockImplementation(((dir: fs.PathLike, options?: unknown) => {
        const entries = realReaddir(dir, options as never);
        return String(dir) === paths.sessionsDir ? [...entries].reverse() : entries;
      }) as never);

    try {
      expect(deleteSession(projectId, paths, "23")).toBe("deleted");
    } finally {
      readdirSync.mockRestore();
    }
    expect(fs.existsSync(real)).toBe(false);
    expect(fs.existsSync(shadow)).toBe(true);
    expect(readRunResult(projectId, "run-real")).toBeNull();
  });

  it("refuses a session id that would escape the sessions directory", () => {
    // The id reaches `path.join` before `findSessionFile` validates it, so a
    // traversing id would address — and unlink — a transcript in another
    // project.
    const projectId = "delete-session-traversal";
    createProject({ projectId, name: "Delete session traversal" });
    const paths = resolvePaths(projectId);

    const victim = path.join(paths.sessionsDir, "..", "outside.jsonl");
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    fs.writeFileSync(victim, `${JSON.stringify({ type: "session", id: "outside" })}\n`);

    for (const id of ["../outside", "..\\outside", "/etc/passwd", ".hidden"]) {
      expect(() => deleteSession(projectId, paths, id)).toThrow(/Invalid session id/);
    }
    expect(fs.existsSync(victim)).toBe(true);
  });

  it("returns not_found when the transcript is missing", () => {
    const projectId = "delete-session-missing";
    createProject({ projectId, name: "Delete session missing" });
    const paths = resolvePaths(projectId);

    const result = deleteSession(projectId, paths, "nonexistent-session");
    expect(result).toBe("not_found");
  });

  it("returns run_active and leaves the transcript when the broker holds an incomplete run", () => {
    const projectId = "delete-session-active";
    createProject({ projectId, name: "Delete session active" });
    const paths = resolvePaths(projectId);
    const sessionId = "session-active-run";

    const sessionFile = writeSessionFile(paths.sessionsDir, sessionId);

    runBroker.start(projectId, sessionId, metadata("incomplete-run"));

    const result = deleteSession(projectId, paths, sessionId);
    expect(result).toBe("run_active");
    expect(fs.existsSync(sessionFile)).toBe(true);
  });
});

const app = await buildApp();

describe("session routes", () => {
  afterAll(async () => {
    await app.close();
  });

  /**
   * A stored transcript Pi's own `SessionManager.list` will accept. The header
   * row is required: without it the file is skipped and `GET /sessions` comes
   * back empty, which reads as a passing assertion about nothing.
   */
  function writeTranscript(projectId: string, sessionId: string): string {
    const paths = resolvePaths(projectId);
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
    const at = new Date().toISOString();
    const rows = [
      { type: "session", version: 3, id: sessionId, timestamp: at, cwd: paths.sandbox },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: at,
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
    ];
    const file = path.join(paths.sessionsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return file;
  }

  it("labels which stored sessions are headless so the UI can say so", async () => {
    // A headless session reopened in a chat tab has no `interview` tool. That
    // is invisible without this flag, and the difference only shows up when the
    // agent needs to ask a question and cannot.
    createProject({ projectId: "headless-flag", name: "Headless flag" });
    writeTranscript("headless-flag", "from-mcp");
    writeTranscript("headless-flag", "from-browser");
    markHeadlessSession("headless-flag", "from-mcp");

    const res = await app.inject({
      method: "GET",
      url: "/sessions",
      headers: { "x-project-id": "headless-flag" },
    });
    expect(res.statusCode).toBe(200);
    const byId = new Map(
      (res.json() as { id: string; headless: boolean }[]).map((s) => [s.id, s.headless]),
    );
    expect(byId.get("from-mcp")).toBe(true);
    expect(byId.get("from-browser")).toBe(false);
  });

  it("deletes a stored session and reports it gone afterwards", async () => {
    createProject({ projectId: "delete-route", name: "Delete route" });
    const file = writeTranscript("delete-route", "doomed");

    const res = await app.inject({
      method: "DELETE",
      url: "/sessions/doomed",
      headers: { "x-project-id": "delete-route" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deleted: true });
    expect(fs.existsSync(file)).toBe(false);

    const again = await app.inject({
      method: "DELETE",
      url: "/sessions/doomed",
      headers: { "x-project-id": "delete-route" },
    });
    expect(again.statusCode).toBe(404);
  });

  it("refuses to delete a session with a run in flight", async () => {
    // Deleting the transcript out from under a running agent would leave the
    // run writing to a file nobody can read.
    createProject({ projectId: "delete-busy", name: "Delete busy" });
    const file = writeTranscript("delete-busy", "busy");
    runBroker.start("delete-busy", "busy", metadata("run-in-flight"));

    const res = await app.inject({
      method: "DELETE",
      url: "/sessions/busy",
      headers: { "x-project-id": "delete-busy" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: "run_already_active" });
    expect(fs.existsSync(file)).toBe(true);
    runBroker.clear();
  });

  it("rejects a malformed session id rather than touching the filesystem", async () => {
    createProject({ projectId: "delete-bad-id", name: "Delete bad id" });

    const res = await app.inject({
      method: "DELETE",
      url: "/sessions/..%2F..%2Fescape",
      headers: { "x-project-id": "delete-bad-id" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("headless session marker", () => {
  it("survives the eviction that would otherwise restore interview", () => {
    createProject({ projectId: "headless-marker", name: "Headless marker" });

    // Before creation the session is interactive by default; this is what makes
    // the marker necessary rather than merely convenient.
    expect(isHeadlessSession("headless-marker", "session-1")).toBe(false);

    markHeadlessSession("headless-marker", "session-1");

    // A cold open after LRU eviction reads the same on-disk answer, so the
    // rebuilt session keeps `interview` disabled.
    expect(isHeadlessSession("headless-marker", "session-1")).toBe(true);
  });

  it("does not treat one session's marker as another's", () => {
    createProject({ projectId: "headless-scope", name: "Headless scope" });
    markHeadlessSession("headless-scope", "session-a");

    expect(isHeadlessSession("headless-scope", "session-b")).toBe(false);
  });

  it("is project scoped", () => {
    createProject({ projectId: "headless-one", name: "Headless one" });
    createProject({ projectId: "headless-two", name: "Headless two" });
    markHeadlessSession("headless-one", "shared-id");

    expect(isHeadlessSession("headless-two", "shared-id")).toBe(false);
  });

  it("fails closed on a session id that would escape the marker directory", () => {
    createProject({ projectId: "headless-traversal", name: "Headless traversal" });

    expect(() => markHeadlessSession("headless-traversal", "../escape")).not.toThrow();
    expect(isHeadlessSession("headless-traversal", "../escape")).toBe(false);
  });
});

describe("headless replacement guidance", () => {
  it("omits interview from the tool allowlist", () => {
    expect(sessionToolNames(false, [])).not.toContain("interview");
    expect(sessionToolNames(false, [])).toContain("notebook");
  });

  it("tells the model the interview tool is gone, so it stops being told to call it", () => {
    // The sandbox AGENTS.md seeded for every project still has an "ask, don't
    // assume" section naming `interview`. That file is shared with the browser
    // UI, so this note is what resolves the contradiction for MCP sessions.
    expect(HEADLESS_PROMPT_NOTE).toMatch(/`interview` tool is NOT available/);
    expect(HEADLESS_PROMPT_NOTE).toMatch(/AGENTS\.md/);
  });

  it("replaces interviewing with a non-blocking instruction rather than leaving a gap", () => {
    // Phase 1's recorded risk was that removing the tool leaves the model
    // wanting to ask and unable to, so it guesses silently. The note has to
    // supply the alternative, not just the prohibition.
    expect(HEADLESS_PROMPT_NOTE).toMatch(/do not stall waiting for/i);
    expect(HEADLESS_PROMPT_NOTE).toMatch(/State the interpretation you chose/);
    expect(HEADLESS_PROMPT_NOTE).toMatch(/`notebook` tool/);
  });
});
