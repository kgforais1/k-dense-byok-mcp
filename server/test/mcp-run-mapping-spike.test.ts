/**
 * MCP server Phase 1 run-mapping spike.
 *
 * Captures the existing RunBroker behavior a Phase 2 poll adapter must retain.
 * The /run route's generic 500 collapse is covered by steer-abort.test.ts;
 * this test deliberately stays at the deterministic broker boundary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RunAlreadyActiveError,
  RunBroker,
  type RunMetadata,
} from "../src/agent/run-broker.ts";

function metadata(runId = "run-1"): RunMetadata {
  return {
    runId,
    prompt: "analyze this",
    images: [],
    baseline: { messages: [], contextUsage: null },
  };
}

afterEach(() => vi.useRealTimers());

describe("RunBroker (MCP poll adapter contract)", () => {
  it("exposes pollable live state with monotonically sequenced frames", () => {
    const broker = new RunBroker();
    const handle = broker.start("p", "s", metadata());
    handle.publish({ type: "run_start", runId: "run-1" });
    handle.publish({ type: "text_delta", delta: "hello" });

    expect(broker.state("p", "s")).toMatchObject({
      status: "running",
      run: { runId: "run-1", lastSeq: 2 },
    });

    handle.publish({ type: "text_delta", delta: " world" });
    const second = broker.state("p", "s");
    expect(second.run?.lastSeq).toBe(3);
    expect(second.run?.frames).toHaveLength(3);
  });

  it("throws typed RunAlreadyActiveError only for a concurrent start", () => {
    const broker = new RunBroker();
    broker.start("p", "s", metadata());

    expect(() => broker.start("p", "s", metadata("run-2"))).toThrow(RunAlreadyActiveError);
  });

  it("does not label an unrelated publish failure as concurrency", () => {
    const broker = new RunBroker();
    const handle = broker.start("p", "s", metadata());
    handle.publish({ type: "done" });
    handle.complete();

    let thrown: unknown;
    try {
      handle.publish({ type: "text_delta", delta: "late" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(RunAlreadyActiveError);
    expect((thrown as Error).message).toMatch(/completed run/);
  });

  it("allows a fresh start after completion rather than reporting concurrency", () => {
    const broker = new RunBroker();
    const first = broker.start("p", "s", metadata("run-1"));
    first.publish({ type: "done" });
    first.complete();

    expect(broker.state("p", "s").status).toBe("complete");
    expect(broker.start("p", "s", metadata("run-2")).runId).toBe("run-2");
  });

  it("retains terminal budget, error, and completion semantics in frames", () => {
    const broker = new RunBroker();
    const blocked = broker.start("p", "blocked", metadata("b"));
    blocked.publish({ type: "error", kind: "budget", message: "spend limit reached" });
    blocked.complete();

    const failed = broker.start("p", "failed", metadata("f"));
    failed.publish({ type: "error", message: "provider failed" });
    failed.complete();

    const complete = broker.start("p", "complete", metadata("c"));
    complete.publish({ type: "cost", cost: 1.5, tokens: 100, runCost: 0.5, runTokens: 20 });
    complete.publish({ type: "done" });
    complete.complete();

    expect(broker.activityForProject("p")).toEqual(
      expect.arrayContaining([
        { sessionId: "blocked", state: "blocked" },
        { sessionId: "failed", state: "error" },
        { sessionId: "complete", state: "done" },
      ]),
    );
    expect(broker.state("p", "blocked").run?.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", kind: "budget", message: "spend limit reached" }),
      ]),
    );
    expect(broker.state("p", "failed").run?.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "error", message: "provider failed" }),
      ]),
    );
    expect(broker.state("p", "complete").run?.frames.map((frame) => frame.type)).toEqual(
      expect.arrayContaining(["cost", "done"]),
    );
  });

  it("expires completed state, requiring a durable per-run result for late polls", () => {
    vi.useFakeTimers();
    const broker = new RunBroker({ completedRetentionMs: 30_000 });
    const handle = broker.start("p", "s", metadata());
    handle.publish({ type: "done" });
    handle.complete();

    vi.advanceTimersByTime(30_001);

    expect(broker.get("p", "s")).toBeUndefined();
    expect(broker.state("p", "s")).toEqual({ status: "none" });
  });
});
