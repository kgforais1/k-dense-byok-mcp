import { describe, expect, it } from "vitest";

import { RunAlreadyActiveError } from "../src/agent/run-broker.ts";
import { runStartFailure } from "../src/agent/run-start-errors.ts";

describe("run start error mapping", () => {
  it("maps only RunAlreadyActiveError to the typed concurrent-run response", () => {
    expect(runStartFailure(new RunAlreadyActiveError())).toEqual({
      statusCode: 409,
      body: { detail: "Session already has an active run", reason: "run_already_active" },
    });
  });

  it("preserves unrelated failures as their generic HTTP-500 mapping", () => {
    expect(runStartFailure(new Error("publisher failed"))).toEqual({
      statusCode: 500,
      body: { detail: "publisher failed" },
    });
  });
});
