/**
 * The Phase 1 prerequisite for exposing MCP runs: an MCP session must not carry
 * the blocking `interview` tool, and must not silently regain it later.
 */
import { describe, expect, it } from "vitest";

import { createProject } from "../src/projects.ts";
import { isHeadlessSession, markHeadlessSession } from "../src/agent/headless-sessions.ts";
import { HEADLESS_PROMPT_NOTE, sessionToolNames } from "../src/agent/session-registry.ts";

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
