/**
 * The session-id validators upstream already reject anything that could
 * traverse, so these cases cannot arise through the API today. They are here
 * because this helper is the last thing between a name and `rmSync`, and it
 * has to hold on its own rather than because of a check in another file.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import { containedIn } from "../src/paths-contained.ts";

const ROOT = path.join(path.sep, "tmp", "kady-notebooks");
// Resolved once for the expectations. On Windows a separator-rooted path has
// no drive letter, so `path.join(ROOT, ...)` and what `containedIn` returns
// differ by the `D:` that `path.resolve` supplies.
const ABS_ROOT = path.resolve(ROOT);

describe("containedIn", () => {
  it("joins an ordinary name onto the root", () => {
    expect(containedIn(ROOT, "abc.jsonl")).toBe(path.join(ABS_ROOT, "abc.jsonl"));
  });

  it("refuses a name that climbs out of the root", () => {
    expect(() => containedIn(ROOT, `..${path.sep}..${path.sep}etc${path.sep}passwd`)).toThrow(
      /outside/,
    );
  });

  it("refuses a sibling directory that merely shares the root's prefix", () => {
    // `/tmp/kady-notebooks-old` starts with the root string, so a containment
    // check without the trailing separator would let this through.
    expect(() => containedIn(ROOT, `..${path.sep}kady-notebooks-old${path.sep}abc.jsonl`)).toThrow(
      /outside/,
    );
  });

  it("refuses an absolute name, even one that lands inside the root", () => {
    // The first is the obvious case. The second is the one the containment
    // check cannot catch on its own: it resolves inside `base`, so it would be
    // returned as though the root had been applied to it.
    expect(() => containedIn(ROOT, path.join(path.sep, "etc", "passwd"))).toThrow(/absolute/);
    expect(() => containedIn(ROOT, path.join(ABS_ROOT, "abc.jsonl"))).toThrow(/absolute/);
  });

  it("refuses the root itself and its parent", () => {
    expect(() => containedIn(ROOT, ".")).toThrow(/outside/);
    expect(() => containedIn(ROOT, "..")).toThrow(/outside/);
  });

  it("still works when the root is a filesystem root", () => {
    // `path.resolve` leaves the separator on, and appending another would
    // reject every name under it.
    expect(containedIn(path.sep, "abc.jsonl")).toBe(
      path.join(path.resolve(path.sep), "abc.jsonl"),
    );
    // The same root is where the prefix test alone stops being enough: the
    // base is its own prefix, so these pass it and have to be refused on
    // their own.
    expect(() => containedIn(path.sep, ".")).toThrow(/outside/);
    expect(() => containedIn(path.sep, "..")).toThrow(/outside/);
  });
});
