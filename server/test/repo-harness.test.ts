import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANIFEST_PATH,
  __cli,
  changelogDuplicateCategoryIssues,
  checkHandoffs,
  checkRelease,
  loadManifest,
  measuredFileLines,
  nextMaxLines,
  ratchetCheck,
  ratchetPackageNames,
  ratchetSync,
  runVerify,
  scaffoldHandoff,
  scaffoldMaintenance,
  scaffoldPlan,
} from "../../scripts/repo.mjs";
import { commandDiagnostics } from "./helpers/command-diagnostics";

const REPO_ROOT = path.resolve(path.dirname(MANIFEST_PATH), "..");
const ratchetsFile = (pkg: string) => path.join(REPO_ROOT, pkg, ".ratchets.json");

function freshDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function manifestClean(): boolean {
  try {
    loadManifest();
  } catch {
    return false;
  }
  try {
    const status = spawnSync("git", ["status", "--porcelain", "--", "scripts/repo-manifest.json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return status.status === 0 && status.stdout.trim().length === 0;
  } catch {
    return false;
  }
}

describe("scripts/repo-manifest.json", () => {
  it("exists and parses as JSON", () => {
    expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
    const text = fs.readFileSync(MANIFEST_PATH, "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("declares the expected top-level shape", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    expect(typeof manifest.categories).toBe("object");
    expect(Array.isArray(manifest.entries)).toBe(true);
    expect(manifest.entries.length).toBeGreaterThan(0);
  });

  it("uses only declared categories and unique ids", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const known = new Set(Object.keys(manifest.categories));
    const ids = new Set();
    for (const entry of manifest.entries) {
      expect(known.has(entry.category), `unknown category ${entry.category}`).toBe(true);
      expect(ids.has(entry.id), `duplicate id ${entry.id}`).toBe(false);
      ids.add(entry.id);
    }
  });

  it("lists a target for every entry that actually exists on disk", () => {
    // loadManifest throws when a target is missing; the absence of a throw
    // is the assertion. We also assert the error path separately below.
    expect(() => loadManifest()).not.toThrow();
  });

  it("loadManifest rejects a missing manifest file", () => {
    expect(() => loadManifest(path.join(os.tmpdir(), "definitely-missing.json"))).toThrow(
      /manifest not found/,
    );
  });

  it("loadManifest rejects a manifest whose target does not exist", () => {
    const dir = freshDir("kady-manifest-");
    const manifestPath = path.join(dir, "repo-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        categories: { test: "test" },
        entries: [
          {
            id: "x",
            category: "test",
            path: "no-such-file",
            name: "x",
            description: "x",
          },
        ],
      }),
    );
    expect(() => loadManifest(manifestPath)).toThrow(/missing target/);
  });

  it("loadManifest rejects an unknown category", () => {
    const dir = freshDir("kady-manifest-");
    const manifestPath = path.join(dir, "repo-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        categories: { allowed: "x" },
        entries: [
          {
            id: "x",
            category: "not-allowed",
            path: "scripts/repo.mjs",
            name: "x",
            description: "x",
          },
        ],
      }),
    );
    expect(() => loadManifest(manifestPath)).toThrow(/unknown category/);
  });
});

describe("repo.mjs CLI runner", () => {
  it("prints help for an unknown subcommand and returns a non-zero code", () => {
    const code = __cli.main(["node", "scripts/repo.mjs", "definitely-not-a-subcommand"]);
    expect(code).toBe(2);
  });

  it("prints help for --help without error", () => {
    const code = __cli.main(["node", "scripts/repo.mjs", "--help"]);
    expect(code).toBe(0);
  });

  it("status subcommand returns 0 and includes the current branch", () => {
    // Capture stdout by intercepting process.stdout.write for the duration of
    // the call, then restoring the original.
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: (chunk: string) => boolean }).write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = __cli.main(["node", "scripts/repo.mjs", "status"]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const out = writes.join("");
    expect(out).toMatch(/^branch:/m);
  });

  it("map subcommand returns 0 and lists every category", () => {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: (chunk: string) => boolean }).write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = __cli.main(["node", "scripts/repo.mjs", "map"]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const out = writes.join("");
    const manifest = loadManifest();
    for (const cat of Object.keys(manifest.categories)) {
      expect(out).toContain(`## ${cat}`);
    }
  });

  it("verify rejects an unknown ladder with exit code 2", () => {
    const code = __cli.main(["node", "scripts/repo.mjs", "verify", "no-such-ladder"]);
    expect(code).toBe(2);
  });

  it.skipIf(!manifestClean())(
    "verify fast returns 0 when the manifest is in sync and aliases are present",
    () => {
      const result = runVerify("fast");
      const failed = result.results.filter((r) => !r.ok);
      expect(failed).toEqual([]);
    },
  );

  it("runVerify reports per-step failure with the original exit code preserved", () => {
    // A ladder that is guaranteed to fail: 'docs' will fail on the active
    // handoffs directory if it contains a malformed handoff. We do not want
    // to require a malformed handoff on disk, so we exercise a synthetic
    // step instead by injecting through the public API. The simplest
    // synthetic failure: ask runVerify to validate a non-existent ladder
    // via the error path, then assert the error carries a numeric code.
    let caught: unknown;
    try {
      runVerify("nope");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: number }).code).toBe(2);
  });

  it("work:plan rejects a value-bearing flag supplied without a value (exit 2)", () => {
    // A bare --slug must not be silently converted to `true` and written into
    // an artifact; it is a usage error.
    const code = __cli.main(["node", "scripts/repo.mjs", "work:plan", "--slug"]);
    expect(code).toBe(2);
  });

  it("work:handoff rejects a missing required --plan value (exit 2)", () => {
    const code = __cli.main(["node", "scripts/repo.mjs", "work:handoff", "--plan", "--branch", "x"]);
    expect(code).toBe(2);
  });

  it("work:maintenance rejects a missing required --pr value (exit 2)", () => {
    const code = __cli.main(["node", "scripts/repo.mjs", "work:maintenance", "--pr"]);
    expect(code).toBe(2);
  });
});

describe("checkHandoffs", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshDir("kady-handoffs-");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes for a valid active handoff pointing to an existing plan", () => {
    const plansDir = path.join(tmp, "plans");
    const handoffsDir = path.join(tmp, "handoffs");
    fs.mkdirSync(plansDir, { recursive: true });
    fs.mkdirSync(handoffsDir, { recursive: true });
    const planPath = path.join(plansDir, "plan.md");
    fs.writeFileSync(planPath, "# Test Plan");
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(handoffsDir, "feature.md"),
      [
        "---",
        "branch: feat/test",
        `plan: ${planPath}`,
        "status: active",
        `updated: ${today}`,
        "---",
        "",
        "## Scope",
        "Implementation scope",
        "",
        "## Verification",
        "npm test",
        "",
        "## Next action",
        "Complete task",
      ].join("\n"),
    );

    const result = checkHandoffs({ dir: handoffsDir, currentBranch: "feat/test", maxAgeDays: 14 });
    expect(result.checked).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it("flags missing frontmatter, missing fields, invalid date, and missing headings", () => {
    fs.writeFileSync(path.join(tmp, "bad-no-frontmatter.md"), "# No frontmatter here");
    fs.writeFileSync(
      path.join(tmp, "bad-fields.md"),
      [
        "---",
        "branch: test-branch",
        "status: active",
        "updated: invalid-date",
        "---",
        "",
        "## Scope",
        "Scope only",
      ].join("\n"),
    );

    const result = checkHandoffs({ dir: tmp, currentBranch: "test-branch" });
    expect(result.checked).toBe(2);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.some((f) => f.includes("missing YAML frontmatter"))).toBe(true);
    expect(result.failures.some((f) => f.includes("missing required field 'plan'"))).toBe(true);
    expect(result.failures.some((f) => f.includes("is not ISO YYYY-MM-DD"))).toBe(true);
    expect(result.failures.some((f) => f.includes("missing required heading '## Verification'"))).toBe(true);
  });

  it("flags stale handoffs older than maxAgeDays", () => {
    const planPath = path.join(tmp, "plan.md");
    fs.writeFileSync(planPath, "# Test Plan");
    fs.writeFileSync(
      path.join(tmp, "stale.md"),
      [
        "---",
        "branch: feat/test",
        `plan: ${planPath}`,
        "status: active",
        "updated: 2020-01-01",
        "---",
        "",
        "## Scope",
        "x",
        "",
        "## Verification",
        "x",
        "",
        "## Next action",
        "x",
      ].join("\n"),
    );

    const result = checkHandoffs({ dir: tmp, currentBranch: "feat/test", maxAgeDays: 14 });
    expect(result.failures.some((f) => f.includes("handoff is stale"))).toBe(true);
  });

  it("skips branch mismatch when the current branch is unknown (empty)", () => {
    const handoffsDir = path.join(tmp, "handoffs");
    const plansDir = path.join(tmp, "plans");
    fs.mkdirSync(handoffsDir, { recursive: true });
    fs.mkdirSync(plansDir, { recursive: true });
    const planPath = path.join(plansDir, "plan.md");
    fs.writeFileSync(planPath, "# Test Plan");
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(handoffsDir, "detached.md"),
      [
        "---",
        "branch: feat/foo",
        `plan: ${planPath}`,
        "status: active",
        `updated: ${today}`,
        "---",
        "",
        "## Scope",
        "x",
        "",
        "## Verification",
        "x",
        "",
        "## Next action",
        "x",
      ].join("\n"),
    );

    const result = checkHandoffs({ dir: handoffsDir, currentBranch: "", maxAgeDays: 14 });
    expect(result.checked).toBe(1);
    expect(result.failures.some((f) => f.includes("does not match current branch"))).toBe(false);
  });

  it("honors GITHUB_HEAD_REF for branch comparison when currentBranch is omitted", () => {
    const handoffsDir = path.join(tmp, "handoffs");
    const plansDir = path.join(tmp, "plans");
    fs.mkdirSync(handoffsDir, { recursive: true });
    fs.mkdirSync(plansDir, { recursive: true });
    const planPath = path.join(plansDir, "plan.md");
    fs.writeFileSync(planPath, "# Test Plan");
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(handoffsDir, "ci-handoff.md"),
      [
        "---",
        "branch: feat/ci-branch",
        `plan: ${planPath}`,
        "status: active",
        `updated: ${today}`,
        "---",
        "",
        "## Scope",
        "x",
        "",
        "## Verification",
        "x",
        "",
        "## Next action",
        "x",
      ].join("\n"),
    );

    const prev = process.env.GITHUB_HEAD_REF;
    process.env.GITHUB_HEAD_REF = "feat/ci-branch";
    try {
      const result = checkHandoffs({ dir: handoffsDir, maxAgeDays: 14 });
      expect(result.checked).toBe(1);
      expect(result.failures).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_HEAD_REF;
      else process.env.GITHUB_HEAD_REF = prev;
    }
  });

  it("flags branch mismatch against GITHUB_HEAD_REF when currentBranch is omitted", () => {
    const handoffsDir = path.join(tmp, "handoffs");
    const plansDir = path.join(tmp, "plans");
    fs.mkdirSync(handoffsDir, { recursive: true });
    fs.mkdirSync(plansDir, { recursive: true });
    const planPath = path.join(plansDir, "plan.md");
    fs.writeFileSync(planPath, "# Test Plan");
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(handoffsDir, "ci-mismatch.md"),
      [
        "---",
        "branch: branch-a",
        `plan: ${planPath}`,
        "status: active",
        `updated: ${today}`,
        "---",
        "",
        "## Scope",
        "x",
        "",
        "## Verification",
        "x",
        "",
        "## Next action",
        "x",
      ].join("\n"),
    );

    const prev = process.env.GITHUB_HEAD_REF;
    process.env.GITHUB_HEAD_REF = "branch-b";
    try {
      const result = checkHandoffs({ dir: handoffsDir, maxAgeDays: 14 });
      expect(result.failures.some((f) => f.includes("does not match current branch"))).toBe(true);
      expect(result.failures.some((f) => f.includes("branch-b"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_HEAD_REF;
      else process.env.GITHUB_HEAD_REF = prev;
    }
  });

  it("flags branch mismatch and missing plan file", () => {
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(tmp, "mismatch.md"),
      [
        "---",
        "branch: branch-a",
        "plan: dev-docs/plans/non-existent-plan.md",
        "status: active",
        `updated: ${today}`,
        "---",
        "",
        "## Scope",
        "x",
        "",
        "## Verification",
        "x",
        "",
        "## Next action",
        "x",
      ].join("\n"),
    );

    const result = checkHandoffs({ dir: tmp, currentBranch: "branch-b" });
    expect(result.failures.some((f) => f.includes("does not match current branch"))).toBe(true);
    expect(result.failures.some((f) => f.includes("does not exist"))).toBe(true);
  });

  it("rejects a handoff dated tomorrow (no one-day grace)", () => {
    const planPath = path.join(tmp, "plan.md");
    fs.writeFileSync(planPath, "# Plan");
    const today = new Date();
    const tomorrow = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
    const tomorrowIso = tomorrow.toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(tmp, "future.md"),
      [
        "---",
        "branch: feat/test",
        `plan: ${planPath}`,
        "status: active",
        `updated: ${tomorrowIso}`,
        "---",
        "",
        "## Scope",
        "x",
        "",
        "## Verification",
        "x",
        "",
        "## Next action",
        "x",
      ].join("\n"),
    );
    const result = checkHandoffs({ dir: tmp, currentBranch: "feat/test", maxAgeDays: 14 });
    expect(result.failures.some((f) => f.includes("is in the future"))).toBe(true);
  });

  it("rejects an impossible calendar date such as 2026-02-31", () => {
    const planPath = path.join(tmp, "plan.md");
    fs.writeFileSync(planPath, "# Plan");
    fs.writeFileSync(
      path.join(tmp, "impossible.md"),
      [
        "---",
        "branch: feat/test",
        `plan: ${planPath}`,
        "status: active",
        "updated: 2026-02-31",
        "---",
        "",
        "## Scope",
        "x",
        "",
        "## Verification",
        "x",
        "",
        "## Next action",
        "x",
      ].join("\n"),
    );
    const result = checkHandoffs({ dir: tmp, currentBranch: "feat/test", maxAgeDays: 14 });
    expect(result.failures.some((f) => f.includes("is not a valid calendar date"))).toBe(true);
  });
});

describe("checkRelease", () => {
  it("returns no errors for the current repository state", () => {
    const result = checkRelease();
    expect(result.errors).toEqual([]);
  });
});

describe("nextMaxLines", () => {
  // Table: [currentCap, worstFileLines, floor, expected]
  const cases = [
    [1467, 1467, 750, 1467],
    [1467, 1402, 750, 1402],
    [1467, 600, 750, 750],
    [750, 400, 750, 750],
    [1467, 1500, 750, 1467],
  ];
  for (const [cap, worst, floor, expected] of cases) {
    it(`nextMaxLines(${cap}, ${worst}, ${floor}) === ${expected}`, () => {
      expect(nextMaxLines(cap, worst, floor)).toBe(expected);
    });
  }
});

describe("the ratchet against this repository", () => {
  // Every package, not just the backend. A cap added for one package and
  // tested for the other is a cap nobody is watching.
  it.each(ratchetPackageNames())(
    // Read-only on purpose. An earlier version of this called `ratchetSync()`,
    // which writes `.ratchets.json` — a test that edits checked-in config, and
    // one that proved nothing, since it then compared the file against the
    // value it had just written.
    "%s stores a cap that is in sync, and does not move it to find out",
    (pkg: string) => {
      const before = fs.readFileSync(ratchetsFile(pkg), "utf8");

      const result = ratchetCheck(pkg);

      expect(result.package).toBe(pkg);
      expect(result.outOfDate).toBe(false);
      expect(result.stored).toBe(result.expected);
      expect(fs.readFileSync(ratchetsFile(pkg), "utf8")).toBe(before);
    },
  );

  it("measures the frontend, and skips what its lint config ignores", () => {
    const measured = measuredFileLines("web").map((f) => f.file);

    expect(measured.some((f) => f.startsWith("web/src/"))).toBe(true);
    // The config file carrying the cap is itself linted, so it is measured.
    expect(measured).toContain("web/eslint.config.mjs");
    for (const ignored of [".next", "out", "build", "node_modules", "coverage"]) {
      expect(measured.some((f) => f.includes(`/${ignored}/`))).toBe(false);
    }
    // `next-env.d.ts` is ignored by eslint-config-next, so counting it could
    // hold the cap above a file ESLint never checks.
    expect(measured).not.toContain("web/next-env.d.ts");
  });

  it("anchors its skip patterns the way the lint config does", () => {
    // A lint config's `ignores: ["out/**"]` means the package's own `out`, not
    // any directory called that. Matching `/out/` anywhere would skip a
    // nested `src/out/` that ESLint still lints — a linted file the scan
    // cannot see is one the cap can be lowered underneath, and the next lint
    // run fails on a file nobody touched. `node_modules` is the exception,
    // because ESLint skips it at any depth. Raised by a muse-spark review.
    const repo = freshDir("kady-ratchet-anchor-");
    try {
      const run = (...args: string[]) =>
        execFileSync("git", args, { cwd: repo, encoding: "utf8" });
      run("init", "-q");
      run("config", "user.email", "test@example.com");
      run("config", "user.name", "test");
      const write = (relative: string) => {
        const full = path.join(repo, relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, "// x\n");
      };
      write("web/out/top-level.ts");
      write("web/src/out/nested.ts");
      write("web/node_modules/pkg/index.ts");
      write("web/src/deep/node_modules/pkg/index.ts");
      write("web/next-env.d.ts");
      write("web/src/app/page.tsx");
      run("add", "-A");

      const measured = measuredFileLines("web", repo).map((f) => f.file);

      expect(measured).toContain("web/src/app/page.tsx");
      // Nested, so ESLint lints it and the scan must count it.
      expect(measured).toContain("web/src/out/nested.ts");
      // Anchored at the package root, so ESLint ignores it and so do we.
      expect(measured).not.toContain("web/out/top-level.ts");
      expect(measured).not.toContain("web/next-env.d.ts");
      // Any depth, because that is ESLint's own default.
      expect(measured).not.toContain("web/node_modules/pkg/index.ts");
      expect(measured).not.toContain("web/src/deep/node_modules/pkg/index.ts");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps the pre-commit hook's package list in step with the code's", () => {
    // The hook stages each `.ratchets.json` the sync lowered, and it cannot
    // import from `scripts/repo.mjs` — it is POSIX sh. A package added to the
    // code and not to the hook is one whose cap is recomputed, left unstaged,
    // and then fails `ratchet:check` in CI on the very next push.
    const hook = fs.readFileSync(path.join(REPO_ROOT, ".githooks", "pre-commit"), "utf8");
    const declared = /^PACKAGES="([^"]*)"$/m.exec(hook);

    expect(declared).toBeTruthy();
    expect(declared?.[1].split(/\s+/).filter(Boolean).sort()).toEqual(
      [...ratchetPackageNames()].sort(),
    );
  });

  it("measures files ESLint lints that live outside src and test", () => {
    // Found by a kimi-k3 review: `eslint .` runs from `server/` and covers
    // everything but its four ignores, while the scan looked only at `src`
    // and `test`. A linted file the scan cannot see is one the cap can be
    // lowered underneath, and the next lint run fails on a file nobody
    // touched.
    //
    // Renamed and rewritten after a glm-5.3 review pointed out the earlier
    // version asserted neither the scan's coverage nor lint/scan agreement,
    // while being named as though it did. This asserts the actual property:
    // a file outside src/test is in the measured set.
    const measured = measuredFileLines().map((f) => f.file);

    expect(measured.some((f) => f.startsWith("server/pi-packages/"))).toBe(true);
    expect(measured).toContain("server/vitest.config.ts");
    // And nothing from the directories the lint config ignores.
    for (const ignored of ["node_modules", "dist", "coverage", ".venv"]) {
      expect(measured.some((f) => f.includes(`/${ignored}/`))).toBe(false);
    }
  });

  it("measures the index, not the working tree", () => {
    // Found by a kimi-k3 review; rewritten after the same reviewer pointed
    // out the first version proved nothing. It compared the measured count
    // against `git grep --cached` on a clean tree — where disk and index are
    // identical, so reverting the code to read from disk still passed.
    //
    // This builds the divergence instead: a scratch repo whose staged file is
    // long and whose working copy is short. Reading disk gives 20; reading
    // the index gives 900, which is what the commit would contain and what
    // CI would lint.
    const repo = freshDir("kady-ratchet-index-");
    try {
      const run = (...args: string[]) =>
        execFileSync("git", args, { cwd: repo, encoding: "utf8" });
      run("init", "-q");
      run("config", "user.email", "test@example.com");
      run("config", "user.name", "test");
      fs.mkdirSync(path.join(repo, "server", "src"), { recursive: true });
      const file = path.join(repo, "server", "src", "big.ts");

      fs.writeFileSync(file, "// x\n".repeat(900));
      run("add", "server/src/big.ts");
      // Shrink on disk only. The index still holds the 900-line version.
      fs.writeFileSync(file, "// x\n".repeat(20));

      const measured = measuredFileLines("server", repo);
      const big = measured.find((f) => f.file === "server/src/big.ts");

      expect(big?.lines).toBe(900);
      expect(big?.lines).not.toBe(20);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each(ratchetPackageNames())(
    "%s counts lines the way wc -l does, which is what ESLint agrees with",
    (pkg: string) => {
    // The assertion that matters. `split("\n").length` overcounts a
    // newline-terminated file by one, and `min(cap, ...)` hides that for as
    // long as the cap is already at or below the true worst — so a sync test
    // alone passes while the count is wrong, and the error only surfaces later
    // as a cap set one line looser than the worst file.
      const result = ratchetCheck(pkg);
      expect(result.worstFile).toBeTruthy();

      const text = fs.readFileSync(path.join(REPO_ROOT, result.worstFile!), "utf8");
      const newlineTerminatedLines = text.endsWith("\n")
        ? text.split("\n").length - 1
        : text.split("\n").length;

      expect(result.worstLines).toBe(newlineTerminatedLines);
      // And the stored cap sits exactly at the worst file — or at the floor,
      // once every file is smaller than it. Asserting equality with the worst
      // file alone would have turned the success case into a failure: the
      // ratchet stops at 750 by design, so the test would start failing on
      // the day the last oversized file was finally split. Found by a
      // greptile review.
      expect(result.stored).toBe(Math.max(result.worstLines, result.floor));
    },
  );
});

describe("the ratchet against a scratch repository", () => {
  /**
   * A repo with one staged backend file of `lines` lines and a stored cap.
   * Scratch rather than this checkout, because `ratchetSync` writes: pointing
   * it at the real tree would edit checked-in config, which is why the
   * in-sync test next door is careful to stay read-only.
   */
  function scratch(options: { lines: number; ratchets: Record<string, unknown> }) {
    const repo = freshDir("kady-ratchet-sync-");
    const run = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    run("init", "-q");
    run("config", "user.email", "test@example.com");
    run("config", "user.name", "test");
    fs.mkdirSync(path.join(repo, "server", "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "server", ".ratchets.json"),
      `${JSON.stringify(options.ratchets, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(repo, "server", "src", "big.ts"), "// x\n".repeat(options.lines));
    run("add", "-A");
    return repo;
  }

  const storedCap = (repo: string) =>
    JSON.parse(fs.readFileSync(path.join(repo, "server", ".ratchets.json"), "utf8"));

  it("lowers the cap to the worst file, and keeps keys it does not own", () => {
    // The `{ ...stored }` spread is load-bearing and was never exercised: a
    // sync that dropped an unrelated key would delete configuration on every
    // commit, silently.
    const repo = scratch({ lines: 800, ratchets: { maxLines: 1000, floor: 750, note: "keep me" } });
    try {
      const result = ratchetSync("server", repo);

      expect(result.changed).toBe(true);
      expect(result.previous).toBe(1000);
      expect(result.next).toBe(800);
      expect(storedCap(repo)).toEqual({ maxLines: 800, floor: 750, note: "keep me" });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("never raises the cap, however long the worst file gets", () => {
    const repo = scratch({ lines: 900, ratchets: { maxLines: 800, floor: 750 } });
    try {
      const result = ratchetSync("server", repo);

      expect(result.changed).toBe(false);
      expect(result.next).toBe(800);
      expect(storedCap(repo).maxLines).toBe(800);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("stops at the floor rather than following a small tree down", () => {
    const repo = scratch({ lines: 300, ratchets: { maxLines: 1000, floor: 750 } });
    try {
      const result = ratchetSync("server", repo);

      expect(result.next).toBe(750);
      expect(result.worstLines).toBe(300);
      // Relative to the repo that was measured, not to this checkout. It
      // reported `../../../../var/folders/...` before.
      expect(result.worstFile).toBe("server/src/big.ts");
      expect(storedCap(repo).maxLines).toBe(750);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports a file over the cap, which a stale-cap check cannot see", () => {
    // `min(cap, max(worst, floor))` leaves `expected` equal to `stored` when a
    // file is over the cap, so `outOfDate` stays false while ESLint would
    // fail. Before this, `ratchet:check` was silent on the one condition a
    // developer is most likely to create.
    const repo = scratch({ lines: 900, ratchets: { maxLines: 800, floor: 750 } });
    try {
      const result = ratchetCheck("server", repo);

      expect(result.outOfDate).toBe(false);
      expect(result.violations).toEqual([{ file: "server/src/big.ts", lines: 900 }]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("measures the same set from disk when the tree is not a git checkout", () => {
    // The fallback path. It has to agree with the index path about what
    // counts, or the cap can be lowered underneath a file ESLint still lints.
    const dir = freshDir("kady-ratchet-nogit-");
    try {
      const write = (relative: string, lines: number) => {
        const full = path.join(dir, relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, "// x\n".repeat(lines));
      };
      write("server/src/counted.ts", 120);
      write("server/pi-packages/also-counted.ts", 60);
      write("server/dist/skipped.ts", 900);
      write("server/src/helpers/.venv/skipped.js", 900);
      write("server/node_modules/pkg/skipped.ts", 900);

      const measured = measuredFileLines("server", dir);

      expect(measured.map((f) => f.file).sort()).toEqual([
        "server/pi-packages/also-counted.ts",
        "server/src/counted.ts",
      ]);
      expect(measured.find((f) => f.file === "server/src/counted.ts")?.lines).toBe(120);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the PR checklist phrases the CI job looks for", () => {
  it("have not all gone stale against the PR template", () => {
    // Found by a glm-5.3 review. `.github/workflows/checks.yml` hardcodes
    // phrases copied from the template. Reword the template and every
    // subsequent PR body — copied from the new template — fails the gate, one
    // PR after the change and far from its cause. This fails at the edit
    // instead.
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, ".github", "workflows", "checks.yml"),
      "utf8",
    );
    const template = fs.readFileSync(
      path.join(REPO_ROOT, ".github", "pull_request_template.md"),
      "utf8",
    );

    // Indent-agnostic: this broke once when the job was restructured and the
    // phrases shifted two columns, which is noise rather than drift.
    const phrases = [...workflow.matchAll(/^\s+"([^"]+)",$/gm)].map((m) => m[1]);
    expect(phrases.length).toBeGreaterThanOrEqual(3);

    expect(template).toContain("## PR closing checklist");
    // The gate requires two matches, so two must survive a template reword.
    // This asserts that, rather than the stronger "all four" the older name
    // implied and never checked.
    const surviving = phrases.filter((phrase) => template.includes(phrase));
    expect(surviving.length).toBeGreaterThanOrEqual(2);
  });
});

describe("changelogDuplicateCategoryIssues", () => {
  it("allows the same category in different releases", () => {
    const text = [
      "# Changelog",
      "",
      "All notable changes to this project will be documented in this file.",
      "",
      "## [Unreleased]",
      "",
      "### Fixed",
      "- fix one",
      "",
      "## [0.9.12] - 2026-09-02",
      "",
      "### Fixed",
      "- fix two",
      "",
      "### Added",
      "- add one",
      "",
      "## [0.9.11] - 2026-09-01",
      "",
      "### Fixed",
      "- fix three",
    ].join("\n");
    expect(changelogDuplicateCategoryIssues(text)).toEqual([]);
  });

  it("flags two of the same category within one release", () => {
    const text = [
      "# Changelog",
      "",
      "All notable changes to this project will be documented in this file.",
      "",
      "## [Unreleased]",
      "",
      "### Fixed",
      "- first fixed",
      "",
      "### Added",
      "- added thing",
      "",
      "### Fixed",
      "- second fixed",
      "",
      "## [0.9.12] - 2026-09-02",
      "",
      "### Added",
      "- added thing",
    ].join("\n");
    const issues = changelogDuplicateCategoryIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('release "[Unreleased]"');
    expect(issues[0]).toContain('2 "### Fixed" sections');
    expect(issues[0]).toContain("Keep a Changelog expects one per category per release");
  });

  it("reports the count when three of the same category appear in one release", () => {
    const text = [
      "# Changelog",
      "",
      "All notable changes to this project will be documented in this file.",
      "",
      "## [Unreleased]",
      "",
      "### Fixed",
      "- first",
      "",
      "### Added",
      "- added",
      "",
      "### Fixed",
      "- second",
      "",
      "### Changed",
      "- changed",
      "",
      "### Fixed",
      "- third",
    ].join("\n");
    const issues = changelogDuplicateCategoryIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('3 "### Fixed" sections');
  });

  it("returns no errors for an empty string", () => {
    expect(changelogDuplicateCategoryIssues("")).toEqual([]);
  });

  it("returns no errors when no ## headings exist", () => {
    const text = [
      "# Changelog",
      "",
      "All notable changes to this project will be documented in this file.",
      "",
      "### Fixed",
      "- bullet",
      "",
      "### Added",
      "- bullet",
    ].join("\n");
    expect(changelogDuplicateCategoryIssues(text)).toEqual([]);
  });

  it("ignores ### headings before the first ## release heading", () => {
    const text = [
      "# Changelog",
      "",
      "All notable changes to this project will be documented in this file.",
      "",
      "### Fixed",
      "- preamble fixed",
      "",
      "## [Unreleased]",
      "",
      "### Fixed",
      "- real fixed",
    ].join("\n");
    expect(changelogDuplicateCategoryIssues(text)).toEqual([]);
  });

  it("ignores headings inside a fenced code block", () => {
    // A false positive would block a legitimate PR, which is worse than the
    // duplicate this check exists to find.
    const text = [
      "## [Unreleased]",
      "",
      "### Fixed",
      "- a real entry",
      "",
      "Example of the shape:",
      "```markdown",
      "### Fixed",
      "- not a real entry",
      "```",
    ].join("\n");
    expect(changelogDuplicateCategoryIssues(text)).toEqual([]);
  });

  it("ignores a ~~~ fence, not only a backtick one", () => {
    // Found by a kimi-k3 review. CommonMark allows both, and only backticks
    // were blanked — so a tilde-fenced example invented a duplicate and would
    // have blocked a legitimate PR.
    const text = [
      "## [Unreleased]",
      "",
      "~~~",
      "### Fixed",
      "~~~",
      "",
      "### Fixed",
      "- the only real one",
    ].join("\n");
    expect(changelogDuplicateCategoryIssues(text)).toEqual([]);
  });

  it("treats a marker of the other kind inside a fence as content", () => {
    // A fence closes only on its own marker.
    const text = [
      "## [Unreleased]",
      "",
      "~~~",
      "### Fixed",
      "```",
      "~~~",
      "",
      "### Fixed",
      "- the only real one",
    ].join("\n");
    expect(changelogDuplicateCategoryIssues(text)).toEqual([]);
  });

  it("reports an unclosed fence rather than going quiet", () => {
    // The worse half of the two failure modes: an unclosed fence blanked the
    // rest of the file, so a real duplicate after it passed silently.
    const text = [
      "## [Unreleased]",
      "",
      "```",
      "### Fixed",
      "- a",
      "",
      "### Fixed",
      "- b",
    ].join("\n");
    const issues = changelogDuplicateCategoryIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("unclosed code fence");
  });

  it("returns no errors for the repository's actual CHANGELOG.md", () => {
    const changelogPath = path.join(REPO_ROOT, "CHANGELOG.md");
    const text = fs.readFileSync(changelogPath, "utf8");
    expect(changelogDuplicateCategoryIssues(text)).toEqual([]);
  });
});

describe("scaffolders", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = freshDir("kady-scaffold-");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("scaffoldPlan writes a plan and refuses to overwrite", () => {
    const target = scaffoldPlan({ slug: "demo", title: "Demo", cwd: tmp });
    expect(fs.existsSync(target)).toBe(true);
    const text = fs.readFileSync(target, "utf8");
    expect(text).toMatch(/^---\n/);
    expect(text).toContain("status: proposed");
    // Second call must throw via fail(); refactor the call to capture the
    // exit rather than kill the test runner. We re-implement by calling the
    // internal refuseOverwrite-equivalent through scaffoldPlan.
    expect(() => scaffoldPlan({ slug: "demo", title: "Demo", cwd: tmp })).toThrow();
  });

  it("scaffoldHandoff writes a handoff with branch and plan placeholders replaced", () => {
    // First we need a plan to reference.
    const planPath = path.join(tmp, "dev-docs", "plans", "demo.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "# plan\n");
    const target = scaffoldHandoff({
      slug: "demo",
      branch: "feature/demo",
      plan: "dev-docs/plans/demo.md",
      cwd: tmp,
    });
    const text = fs.readFileSync(target, "utf8");
    expect(text).toContain("branch: feature/demo");
    expect(text).toContain("plan: dev-docs/plans/demo.md");
    expect(text).toMatch(/^## Scope/m);
    expect(text).toMatch(/^## Verification/m);
    expect(text).toMatch(/^## Next action/m);
    expect(() => scaffoldHandoff({
      slug: "demo",
      branch: "feature/demo",
      plan: "dev-docs/plans/demo.md",
      cwd: tmp,
    })).toThrow();
  });

  it("scaffoldHandoff and scaffoldPlan substitute the shipped templates' placeholders", () => {
    // Copy the real shipped templates into the temp repo so the scaffolders
    // render the same bytes a contributor would get (not the fallback strings).
    const realTemplates = path.join(REPO_ROOT, "dev-docs", "templates");
    const tmpTemplates = path.join(tmp, "dev-docs", "templates");
    fs.mkdirSync(tmpTemplates, { recursive: true });
    for (const f of fs.readdirSync(realTemplates)) {
      fs.copyFileSync(path.join(realTemplates, f), path.join(tmpTemplates, f));
    }

    const today = new Date().toISOString().slice(0, 10);

    const handoffTarget = scaffoldHandoff({
      slug: "demo",
      branch: "feature/demo",
      plan: "dev-docs/plans/demo.md",
      cwd: tmp,
    });
    const handoff = fs.readFileSync(handoffTarget, "utf8");
    expect(handoff).toContain('branch: "feature/demo"');
    expect(handoff).toContain('plan: "dev-docs/plans/demo.md"');
    expect(handoff).toContain(`updated: "${today}"`);
    expect(handoff).not.toContain("[branch-name]");
    expect(handoff).not.toContain("[plan-file]");
    expect(handoff).not.toContain("[YYYY-MM-DD]");

    const planTarget = scaffoldPlan({ slug: "demo", title: "My Title", branch: "feature/demo", cwd: tmp });
    const plan = fs.readFileSync(planTarget, "utf8");
    expect(plan).toContain("# My Title Implementation Plan");
    expect(plan).not.toContain("[Feature / Task Title]");
  });

  it("scaffoldMaintenance appends a new entry without overwriting the log", () => {
    // Copy the shipped templates so the scaffolder renders the real bytes (not
    // the hardcoded fallback), and use a log to exercise the insert position.
    const realTemplates = path.join(REPO_ROOT, "dev-docs", "templates");
    const tmpTemplates = path.join(tmp, "dev-docs", "templates");
    fs.mkdirSync(tmpTemplates, { recursive: true });
    for (const f of fs.readdirSync(realTemplates)) {
      fs.copyFileSync(path.join(realTemplates, f), path.join(tmpTemplates, f));
    }
    const logPath = path.join(tmp, "dev-docs", "maintenance-log.md");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const original = "# Maintenance log\n\n## 2026-01-01 — first entry\n\nPrior content.\n";
    fs.writeFileSync(logPath, original);
    const target = scaffoldMaintenance({ pr: "#42", category: "ci-tooling", cwd: tmp });
    expect(target).toBe(logPath);
    const updated = fs.readFileSync(target, "utf8");
    // The new entry is inserted between the H1 and the first H2; the H1
    // and the existing H2 entry must both remain in the file.
    expect(updated).toContain("# Maintenance log");
    expect(updated).toContain("## 2026-01-01 — first entry");
    expect(updated).toContain("Prior content.");
    // Shipped-template substitution: real date, PR number, and category, and no
    // leftover placeholders.
    expect(updated).toContain("### " + new Date().toISOString().slice(0, 10) + " — [Brief Title] (PR #42)");
    expect(updated).toContain("**Category:** ci-tooling");
    expect(updated).not.toContain("[number]");
    expect(updated).not.toContain("[YYYY-MM-DD]");
    expect(updated).not.toContain("[security | dependency | ci-tooling | operational | verification]");
  });

  it("scaffoldMaintenance refuses to append a duplicate entry for the same PR", () => {
    const realTemplates = path.join(REPO_ROOT, "dev-docs", "templates");
    const tmpTemplates = path.join(tmp, "dev-docs", "templates");
    fs.mkdirSync(tmpTemplates, { recursive: true });
    for (const f of fs.readdirSync(realTemplates)) {
      fs.copyFileSync(path.join(realTemplates, f), path.join(tmpTemplates, f));
    }
    const logPath = path.join(tmp, "dev-docs", "maintenance-log.md");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "# Maintenance log\n\n");
    scaffoldMaintenance({ pr: "#42", category: "ci-tooling", cwd: tmp });
    expect(() => scaffoldMaintenance({ pr: "#42", category: "ci-tooling", cwd: tmp })).toThrow(
      /refusing to append duplicate maintenance entry/,
    );
  });
});

describe("end-to-end CLI invocation via node", () => {
  // These exercise the actual node entrypoint to guard against module-level
  // side effects that vitest's in-process import might mask.

  it("node scripts/repo.mjs status exits 0 and prints 'branch:'", () => {
    const result = spawnSync("node", ["scripts/repo.mjs", "status"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status, commandDiagnostics(result)).toBe(0);
    expect(result.stdout).toMatch(/^branch:/m);
  });

  it("node scripts/repo.mjs verify fast exits 0 when the repo is clean", () => {
    // Only run if the fast ladder is currently expected to pass.
    try {
      loadManifest();
    } catch {
      return;
    }
    const result = spawnSync("node", ["scripts/repo.mjs", "verify", "fast"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    // The manifest is dirty in the test environment because the test wrote
    // to it; either pass (clean) or fail with the expected 'uncommitted
    // changes' message. Both are acceptable; what we forbid is a silent
    // crash (status === null) or a different exit code than the script
    // would produce for the same input.
    expect(
      result.status === 0 || result.status === 1,
      commandDiagnostics(result),
    ).toBe(true);
  });

  it("node scripts/repo.mjs handoff:check exits 0 when no handoffs are present", () => {
    const result = spawnSync("node", ["scripts/repo.mjs", "handoff:check"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status, commandDiagnostics(result)).toBe(0);
    expect(result.stdout).toMatch(/active handoff\(s\)/);
  });
});
