import { describe, expect, it } from "vitest";
import { makeTabId } from "./tab-ids";

describe("makeTabId", () => {
  it("returns a non-empty string", () => {
    expect(typeof makeTabId()).toBe("string");
    expect(makeTabId().length).toBeGreaterThan(0);
  });

  it("produces unique ids on successive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) ids.add(makeTabId());
    expect(ids.size).toBe(10);
  });
});
