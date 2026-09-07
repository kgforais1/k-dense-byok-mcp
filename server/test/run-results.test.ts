import { describe, expect, it } from "vitest";

import { createProject } from "../src/projects.ts";
import {
  persistTerminalRunResult,
  readRunResult,
  persistRunResult,
} from "../src/agent/run-results.ts";
import { RunBroker, type RunMetadata } from "../src/agent/run-broker.ts";

function metadata(runId: string): RunMetadata {
  return { runId, prompt: "test", images: [], baseline: { messages: [], contextUsage: null } };
}

describe("durable terminal run results", () => {
  it("keeps completed terminal frames after broker retention would expire", () => {
    createProject({ projectId: "run-results", name: "Run results" });
    const broker = new RunBroker({ completedRetentionMs: 1 });
    const handle = broker.start("run-results", "session-1", metadata("run-result-1"));
    handle.publish({ type: "error", kind: "budget", message: "spend limit reached" });
    handle.publish({ type: "done" });
    handle.complete();

    expect(persistRunResult("run-results", handle)).toMatchObject({
      runId: "run-result-1",
      sessionId: "session-1",
      status: "blocked",
      lastSeq: 2,
    });
    expect(readRunResult("run-results", "run-result-1")).toMatchObject({
      status: "blocked",
      frames: expect.arrayContaining([
        expect.objectContaining({ type: "error", kind: "budget" }),
        expect.objectContaining({ type: "done" }),
      ]),
    });
  });

  it("keeps an unknown run distinct from a malformed id", () => {
    expect(readRunResult("run-results", "does-not-exist")).toBeNull();
    expect(readRunResult("run-results", "../escape")).toBeNull();
  });

  it("preserves an abort as a distinct terminal outcome", () => {
    createProject({ projectId: "aborted-results", name: "Aborted results" });
    const broker = new RunBroker();
    const handle = broker.start("aborted-results", "session-2", metadata("aborted-result-1"));
    handle.requestAbort();
    handle.publish({ type: "done" });
    handle.complete();

    expect(persistRunResult("aborted-results", handle)).toMatchObject({ status: "aborted" });
    expect(readRunResult("aborted-results", "aborted-result-1")).toMatchObject({ status: "aborted" });
  });

  it("can snapshot a terminal result before the live done frame is published", () => {
    createProject({ projectId: "pre-done-results", name: "Pre-done results" });
    const broker = new RunBroker();
    const handle = broker.start("pre-done-results", "session-3", metadata("pre-done-result-1"));
    handle.publish({ type: "cost", cost: 0, tokens: 0 });

    expect(persistTerminalRunResult("pre-done-results", handle)).toMatchObject({
      status: "done",
      frames: expect.arrayContaining([expect.objectContaining({ type: "done", seq: 2 })]),
    });
    expect(handle.isComplete).toBe(false);
  });
});
