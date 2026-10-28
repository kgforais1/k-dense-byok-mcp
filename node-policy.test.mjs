/**
 * Focused tests for ../node-policy.mjs — version boundaries, prereleases,
 * build metadata and malformed input. Runs on the standard Node test runner
 * with no dependencies and no network:
 *
 *   node --test node-policy.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUPPORTED_NODE_RANGES,
  checkNodeVersion,
  formatNodeVersionError,
  parseNodeVersion,
} from "./node-policy.mjs";

describe("parseNodeVersion", () => {
  it("parses process.version shapes with leading v", () => {
    assert.deepEqual(parseNodeVersion("v22.23.4"), {
      major: 22,
      minor: 23,
      patch: 4,
      prerelease: null,
      build: null,
    });
    assert.deepEqual(parseNodeVersion("24.22.1"), {
      major: 24,
      minor: 22,
      patch: 1,
      prerelease: null,
      build: null,
    });
  });

  it("tolerates surrounding whitespace", () => {
    const parsed = parseNodeVersion("  v26.12.1  ");
    assert.equal(parsed && parsed.major, 26);
    assert.equal(parsed && parsed.patch, 1);
  });

  it("keeps valid build metadata and drops it from the verdict inputs", () => {
    assert.deepEqual(parseNodeVersion("v22.23.4+build.1"), {
      major: 22,
      minor: 23,
      patch: 4,
      prerelease: null,
      build: "build.1",
    });
    // Leading zeros are legal in build metadata (SemVer 10).
    assert.equal(parseNodeVersion("24.30.0+001") !== null, true);
  });

  it("records prereleases instead of accepting them", () => {
    const parsed = parseNodeVersion("22.23.4-rc.1");
    assert.equal(parsed && parsed.prerelease, "rc.1");
  });

  it("rejects malformed input as null", () => {
    for (const bad of [
      "",
      "   ",
      "v",
      "V",
      null,
      undefined,
      24,
      {},
      "foo",
      "22",
      "22.23",
      "22.23.4.5",
      "22.x.1",
      "22.23.x",
      ".23.4",
      "22.23.4-",
      "22.23.4+",
      "22.23.4+bad id",
      "22.23.4+",
      "22.23.4-rc..1",
      "v 22.23.4",
      "22. 23.4",
      "v22.23.4v",
      // Leading zeros are not valid SemVer numeric identifiers: fail closed.
      "22.04.1",
      "022.23.4",
      "24.999999999999999999999.0",
    ]) {
      assert.equal(parseNodeVersion(bad), null, "expected null for " + JSON.stringify(String(bad)));
    }
  });
});

describe("checkNodeVersion boundaries", () => {
  it("accepts each exact floor", () => {
    for (const floor of ["22.23.4", "v22.23.4", "24.22.1", "26.12.1"]) {
      const result = checkNodeVersion(floor);
      assert.equal(result.ok, true, floor);
      assert.equal(result.reason, null, floor);
    }
  });

  it("rejects one patch below each floor", () => {
    assert.deepEqual(checkNodeVersion("22.23.3").reason, "below-minimum");
    assert.deepEqual(checkNodeVersion("24.22.0").reason, "below-minimum");
    assert.deepEqual(checkNodeVersion("26.12.0").reason, "below-minimum");
  });

  it("accepts newer minors/patches on supported majors", () => {
    for (const good of ["22.23.5", "22.24.0", "22.30.1", "24.22.2", "24.30.0", "26.12.2", "26.20.0"]) {
      assert.equal(checkNodeVersion(good).ok, true, good);
    }
  });

  it("rejects earlier minors on supported majors", () => {
    assert.deepEqual(checkNodeVersion("22.22.9").reason, "below-minimum");
    assert.deepEqual(checkNodeVersion("24.13.0").reason, "below-minimum");
    assert.deepEqual(checkNodeVersion("26.0.0").reason, "below-minimum");
  });

  it("rejects unsupported majors, including odd/future lines", () => {
    for (const bad of ["18.20.8", "20.19.0", "21.7.3", "23.0.0", "23.11.0", "25.0.0", "27.0.0", "28.1.0"]) {
      const result = checkNodeVersion(bad);
      assert.equal(result.ok, false, bad);
      assert.equal(result.reason, "unsupported-major", bad);
    }
  });

  it("rejects the current affected host line position (24.18.0)", () => {
    // Host state at time of writing: v24.18.0 predates the 24.22.1 floor.
    // This documents that the dev host will be rejected once wired in.
    const result = checkNodeVersion("v24.18.0");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "below-minimum");
    assert.equal(result.minimum, "24.22.1");
  });

  it("rejects prereleases even on/above supported lines", () => {
    for (const pre of [
      "22.23.4-rc.1",
      "22.30.0-nightly20260101",
      "24.22.1-pre",
      "26.12.1-x.1",
      "26.20.0-alpha.1+build.5",
    ]) {
      const result = checkNodeVersion(pre);
      assert.equal(result.ok, false, pre);
      assert.equal(result.reason, "prerelease", pre);
    }
  });

  it("allows valid build metadata on supported versions", () => {
    assert.equal(checkNodeVersion("22.23.4+build.1").ok, true);
    assert.equal(checkNodeVersion("24.22.1+20260101").ok, true);
    assert.equal(checkNodeVersion("26.12.1+exp.sha.5114f85").ok, true);
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", "v", "latest", "22", null, undefined, 42]) {
      const result = checkNodeVersion(bad);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "malformed");
    }
  });

  it("never throws for hostile input", () => {
    const hostile = ["\0", "v".repeat(10000), "1.2.3----", "1.2.3++++", "-1.-2.-3", "99999999999999999999.0.0"];
    for (const input of hostile) {
      assert.doesNotThrow(() => checkNodeVersion(input));
    }
  });
});

describe("supported ranges table", () => {
  it("declares exactly the three verified floors", () => {
    assert.deepEqual(SUPPORTED_NODE_RANGES, [
      { major: 22, minMinor: 23, minPatch: 4 },
      { major: 24, minMinor: 22, minPatch: 1 },
      { major: 26, minMinor: 12, minPatch: 1 },
    ]);
  });
});

describe("formatNodeVersionError", () => {
  it("returns null for supported versions", () => {
    assert.equal(formatNodeVersionError("22.23.4"), null);
    assert.equal(formatNodeVersionError("v24.22.1"), null);
    assert.equal(formatNodeVersionError("26.12.1+build.1"), null);
  });

  it("reports an actionable message naming the version and the policy", () => {
    const message = formatNodeVersionError("v24.18.0");
    assert.ok(typeof message === "string" && message.length > 0);
    assert.ok(message.includes("24.18.0"), "names the installed version");
    assert.ok(message.includes("24.22.1"), "names the line minimum");
    assert.ok(message.includes("GHSA-xjj6-f33q-929c"), "names the reason");
  });

  it("distinguishes prerelease, major and malformed rejections", () => {
    assert.ok((formatNodeVersionError("24.22.1-rc.1") || "").includes("prerelease"));
    assert.ok((formatNodeVersionError("23.0.0") || "").includes("unsupported major"));
    assert.ok((formatNodeVersionError("nope") || "").includes("could not be parsed"));
  });

  it("reports explicit malformed values instead of substituting the running version", () => {
    for (const input of [null, 42, ""]) {
      const message = formatNodeVersionError(input);
      assert.ok(message && message.includes("could not be parsed"));
      assert.ok(message.includes("(unknown)"));
    }
    assert.equal(formatNodeVersionError(), formatNodeVersionError(process.version));
  });

  it("appends a caller hint when provided", () => {
    const message = formatNodeVersionError("22.22.0", { hint: "hint-text-here" });
    assert.ok((message || "").includes("hint-text-here"));
  });

  it("never throws", () => {
    assert.doesNotThrow(() => formatNodeVersionError(null));
    assert.doesNotThrow(() => formatNodeVersionError(undefined));
    assert.doesNotThrow(() => formatNodeVersionError(42));
  });
});

describe("engines metadata parity", () => {
  const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
  const EXPECTED_ENGINES = ">=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1 <27";

  function readJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8"));
  }

  /**
   * npm's real range evaluator, resolved from the installed server tree
   * (CI installs server dependencies before running these tests). Throws
   * when unavailable so a missing install fails loudly instead of silently
   * skipping the parity check.
   */
  function loadSemver() {
    try {
      const req = createRequire(path.join(REPO_ROOT, "server", "package.json"));
      return req("semver");
    } catch (err) {
      throw new Error(
        "semver is unavailable from server/node_modules — run `npm ci` in server/ first: " +
          (err && err.message ? err.message : err),
      );
    }
  }

  it("declares the same engines range in all package and lockfile roots", () => {
    const locations = [
      ["package.json", (pkg) => pkg.engines.node],
      ["server/package.json", (pkg) => pkg.engines.node],
      ["web/package.json", (pkg) => pkg.engines.node],
      ["server/package-lock.json", (pkg) => pkg.packages[""].engines.node],
      ["web/package-lock.json", (pkg) => pkg.packages[""].engines.node],
    ];
    for (const [rel, pick] of locations) {
      assert.equal(pick(readJson(rel)), EXPECTED_ENGINES, rel);
    }
  });

  it("predicate and npm semver agree on explicitly tabled verdicts", () => {
    const semver = loadSemver();
    // [input, expected]. Every row verified against semver@7.8.3 from the
    // server tree: whitespace/`v` are trimmed, malformed never throws and
    // never satisfies, prereleases are excluded, build metadata is ignored.
    const cases = [
      ["22.23.4", true],
      ["v22.23.4", true],
      ["24.22.1", true],
      ["26.12.1", true],
      ["  24.22.1  ", true],
      ["22.23.3", false],
      ["24.22.0", false],
      ["26.12.0", false],
      ["22.23.5", true],
      ["22.24.0", true],
      ["22.99.99", true],
      ["24.22.2", true],
      ["24.99.99", true],
      ["26.12.2", true],
      ["26.99.99", true],
      ["22.22.9", false],
      ["24.13.0", false],
      ["26.0.0", false],
      ["18.20.8", false],
      ["20.19.0", false],
      ["21.7.3", false],
      ["23.0.0", false],
      ["23.99.99", false],
      ["25.0.0", false],
      ["27.0.0", false],
      ["22.23.4-rc.1", false],
      ["22.30.0-nightly.1", false],
      ["24.22.1-pre", false],
      ["26.12.1-alpha.1+build.5", false],
      ["22.23.4+build.1", true],
      ["24.22.1+001", true],
      ["26.12.1+exp.sha.5114f85", true],
      ["", false],
      ["foo", false],
      ["22", false],
      ["22.23", false],
      ["22.23.4.5", false],
      ["22.04.1", false],
      ["v", false],
    ];
    for (const [input, expected] of cases) {
      assert.equal(
        semver.satisfies(input, EXPECTED_ENGINES),
        expected,
        "npm verdict for " + JSON.stringify(input),
      );
      assert.equal(
        checkNodeVersion(input).ok,
        expected,
        "predicate verdict for " + JSON.stringify(input),
      );
    }
  });
});
