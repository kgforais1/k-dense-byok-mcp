import { describe, expect, it } from "vitest";
import { trimTrailingSlashes } from "../src/trim-slashes.ts";
import { sameUrl } from "../src/agent/mcp.ts";

describe("linear URL suffix trimming", () => {
  it("preserves internal slashes and compares complete URLs", () => {
    const run = "/".repeat(100_000);
    expect(trimTrailingSlashes("http://localhost/a" + run)).toBe("http://localhost/a");
    expect(trimTrailingSlashes("http://localhost/" + run + "x")).toBe("http://localhost/" + run + "x");
    expect(sameUrl("http://localhost/a///", "http://localhost/a/")).toBe(true);
    expect(sameUrl("http://localhost/a", "http://localhost/b")).toBe(false);
    expect(sameUrl(undefined, "http://localhost/a")).toBe(false);
  });
});
