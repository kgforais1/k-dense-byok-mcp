#!/usr/bin/env node
/**
 * Repository command hub.
 *
 * Phase 2 of dev-docs/plans/2026-09-03-repo-agent-harness.md. This is a
 * portable Node command hub that delegates to the existing server/ and web/
 * scripts. It is dependency-free, cross-platform, and never bypasses hooks
 * or CI. Subcommands fail loudly and preserve the original exit code of the
 * underlying check.
 *
 * Subcommands:
 *   status                  current branch, dirty status, recent commits, active handoffs
 *   map                     print architectural map and entry points from scripts/repo-manifest.json
 *   verify [ladder]         run the verification ladder: fast | server | web | docs | all (default: fast)
 *   handoff:check           validate dev-docs/handoffs/active/ files for schema and branch consistency
 *   release:check           check server/package.json version and CHANGELOG.md structure
 *   work:plan --slug ...    scaffold a new plan under dev-docs/plans/ (refuses to overwrite)
 *   work:handoff --plan ... scaffold a new active handoff (refuses to overwrite)
 *   work:maintenance --pr ... scaffold a new maintenance-log entry (refuses to overwrite)
 *
 * Designed to be importable from tests: the CLI runner only runs when this
 * file is executed directly (i.e. process.argv[1] ends with repo.mjs).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// --------------------------------------------------------------------------
// Paths and tiny utilities
// --------------------------------------------------------------------------

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

function rel(p) {
  // Normalize to forward slashes so messages are identical on every OS
  // (matches docs-check.mjs and keeps repo-relative paths copy-pasteable).
  return path.relative(REPO_ROOT, p).split(path.sep).join("/") || ".";
}

function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function runGit(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trimEnd();
}

function fail(message, code = 1) {
  process.stderr.write(`repo: ${message}\n`);
  process.exit(code);
}

// --------------------------------------------------------------------------
// Manifest
// --------------------------------------------------------------------------

export const MANIFEST_PATH = path.join(REPO_ROOT, "scripts", "repo-manifest.json");

function validateManifestEntry(entry, knownCategories, seenIds, seenPaths, missing) {
  if (!entry || typeof entry !== "object") {
    throw new Error("manifest entry is not an object");
  }
  for (const key of ["id", "category", "path", "name", "description"]) {
    if (typeof entry[key] !== "string" || entry[key].length === 0) {
      throw new Error(`manifest entry missing string field '${key}'`);
    }
  }
  if (seenIds.has(entry.id)) {
    throw new Error(`manifest entry id '${entry.id}' is duplicated`);
  }
  seenIds.add(entry.id);
  if (seenPaths.has(entry.path)) {
    throw new Error(`manifest entry path '${entry.path}' is duplicated`);
  }
  seenPaths.add(entry.path);
  if (!knownCategories.has(entry.category)) {
    throw new Error(
      `manifest entry '${entry.id}' has unknown category '${entry.category}'; allowed: ${[...knownCategories].join(", ")}`,
    );
  }
  const target = path.join(REPO_ROOT, entry.path);
  if (!exists(target)) {
    missing.push(entry.id);
  }
}

/**
 * Load and validate the manifest. Throws on:
 *  - missing file
 *  - non-JSON
 *  - missing required keys
 *  - duplicate ids
 *  - unknown categories
 *  - targets that do not exist on disk
 * Returns the parsed object on success.
 */
export function loadManifest(manifestPath = MANIFEST_PATH) {
  if (!exists(manifestPath)) {
    throw new Error(`manifest not found at ${rel(manifestPath)}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readText(manifestPath));
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${err.message}`);
  }
  if (typeof manifest !== "object" || manifest === null) {
    throw new Error("manifest must be a JSON object");
  }
  if (typeof manifest.categories !== "object" || manifest.categories === null) {
    throw new Error("manifest.categories must be an object");
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error("manifest.entries must be an array");
  }
  const knownCategories = new Set(Object.keys(manifest.categories));
  const seenIds = new Set();
  const seenPaths = new Set();
  const missing = [];
  for (const entry of manifest.entries) {
    validateManifestEntry(entry, knownCategories, seenIds, seenPaths, missing);
  }
  if (missing.length > 0) {
    throw new Error(
      `manifest references ${missing.length} missing target(s): ${missing.join(", ")}`,
    );
  }
  return manifest;
}

// --------------------------------------------------------------------------
// status
// --------------------------------------------------------------------------

const ACTIVE_HANDOFFS_DIR = path.join(REPO_ROOT, "dev-docs", "handoffs", "active");

function listActiveHandoffs() {
  if (!exists(ACTIVE_HANDOFFS_DIR)) return [];
  return fs
    .readdirSync(ACTIVE_HANDOFFS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(ACTIVE_HANDOFFS_DIR, name))
    .sort();
}

function stripQuotes(value) {
  // YAML scalar values may be single- or double-quoted; the schema checks below
  // compare against unquoted forms (branch names, ISO dates, paths).
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  if (!match) return { frontmatter: null, body: text };
  const frontmatter = match[1];
  const body = text.slice(match[0].length);
  const fields = {};
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (m) fields[m[1]] = stripQuotes(m[2]);
  }
  return { frontmatter: fields, body };
}

export function statusReport() {
  const out = { lines: [] };
  let branch = "(unknown)";
  let dirty = "(unknown)";
  let recent = [];
  let handoffs = [];
  try {
    branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch (err) {
    out.lines.push(`branch: <error: ${err.message}>`);
  }
  try {
    const status = runGit(["status", "--porcelain"]);
    dirty = status.length === 0 ? "clean" : `${status.split("\n").length} file(s) changed`;
  } catch (err) {
    out.lines.push(`status: <error: ${err.message}>`);
  }
  try {
    const log = runGit(["log", "--oneline", "-10"]);
    recent = log.split("\n").filter(Boolean);
  } catch (err) {
    out.lines.push(`recent commits: <error: ${err.message}>`);
  }
  for (const file of listActiveHandoffs()) {
    let info = { file: rel(file) };
    try {
      const text = readText(file);
      const { frontmatter } = parseFrontmatter(text);
      if (frontmatter) {
        info.branch = frontmatter.branch;
        info.status = frontmatter.status;
        info.updated = frontmatter.updated;
        info.plan = frontmatter.plan;
      }
    } catch (err) {
      info.error = err.message;
    }
    handoffs.push(info);
  }
  out.report = { branch, dirty, recent, handoffs };
  out.lines.push(`branch: ${branch}`);
  out.lines.push(`status: ${dirty}`);
  out.lines.push(`recent commits:`);
  for (const line of recent) out.lines.push(`  ${line}`);
  if (handoffs.length === 0) {
    out.lines.push(`active handoffs: (none)`);
  } else {
    out.lines.push(`active handoffs:`);
    for (const h of handoffs) {
      const meta = [h.branch, h.status, h.updated].filter(Boolean).join(" / ");
      out.lines.push(`  - ${h.file}${meta ? ` [${meta}]` : ""}`);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// map
// --------------------------------------------------------------------------

export function mapReport(manifest = loadManifest()) {
  const lines = [];
  lines.push("Repository manifest");
  lines.push("===================");
  lines.push("");
  lines.push("Categories:");
  for (const [cat, def] of Object.entries(manifest.categories)) {
    lines.push(`  ${cat}: ${def}`);
  }
  lines.push("");
  const byCategory = new Map();
  for (const entry of manifest.entries) {
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
    byCategory.get(entry.category).push(entry);
  }
  for (const [cat, entries] of byCategory) {
    lines.push(`## ${cat} (${entries.length})`);
    for (const e of entries) {
      lines.push(`  ${e.id}  ${e.path}`);
      lines.push(`    ${e.name} — ${e.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// verify
// --------------------------------------------------------------------------

const VERIFY_LADDERS = {
  fast: {
    description: "fast targeted checks (manifest validation + manifest git-hygiene + hub aliases). No builds, no tests.",
    steps: [
      {
        name: "manifest validates and every target exists",
        run: () => {
          loadManifest();
          return "ok";
        },
      },
      {
        name: "no uncommitted changes to manifest targets",
        run: () => {
          if (!exists(path.join(REPO_ROOT, ".git"))) return "skipped (no .git)";
          const status = runGit(["status", "--porcelain", "--", "scripts/repo-manifest.json"]);
          if (status.length > 0) {
            throw new Error(
              `scripts/repo-manifest.json has uncommitted changes; commit it with the PR`,
            );
          }
          return "ok";
        },
      },
      {
        name: "root package.json exposes the hub aliases",
        run: () => {
          const pkg = JSON.parse(readText(path.join(REPO_ROOT, "package.json")));
          const required = [
            "status",
            "verify",
            "docs:check",
            "repo:map",
            "handoff:check",
            "release:check",
            "work:plan",
            "work:handoff",
            "work:maintenance",
          ];
          const missing = required.filter((k) => typeof pkg.scripts?.[k] !== "string");
          if (missing.length > 0) {
            throw new Error(`root package.json is missing scripts: ${missing.join(", ")}`);
          }
          return "ok";
        },
      },
    ],
  },
  server: {
    description: "backend typecheck + backend tests (server/)",
    steps: [
      {
        name: "server typecheck (tsc --noEmit)",
        run: () => runNpmScript(["--prefix", "server", "run", "typecheck"]),
      },
      {
        name: "server tests (vitest run)",
        run: () => runNpmScript(["--prefix", "server", "test", "--", "--reporter=default"]),
      },
    ],
  },
  web: {
    description: "frontend typecheck + frontend tests (web/)",
    steps: [
      {
        name: "web typecheck (tsc --noEmit)",
        run: () => runNpmScript(["--prefix", "web", "run", "typecheck"]),
      },
      {
        name: "web tests (vitest run)",
        run: () => runNpmScript(["--prefix", "web", "test", "--", "--reporter=default"]),
      },
    ],
  },
  docs: {
    description: "documentation checks (docs-check.mjs structure, handoff schema, release/changelog, manifest category coverage)",
    steps: [
      {
        name: "docs:check",
        run: () => {
          const result = spawnSync("node", [path.join(REPO_ROOT, "scripts", "docs-check.mjs")], {
            cwd: REPO_ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          if (result.error) {
            throw new Error(`failed to spawn docs-check: ${result.error.message}`);
          }
          if (result.status !== 0) {
            const err = new Error(
              `docs:check failed:\n${result.stderr ?? result.stdout}`,
            );
            err.code = result.status ?? 1;
            throw err;
          }
          return (result.stdout || "docs:check: ok").trim();
        },
      },
      {
        name: "handoff:check",
        run: () => {
          const result = checkHandoffs();
          if (result.failures.length > 0) {
            const err = new Error(
              `handoff:check failed:\n${result.failures.map((f) => `  - ${f}`).join("\n")}`,
            );
            err.code = 1;
            throw err;
          }
          return `${result.checked} active handoff(s) ok`;
        },
      },
      {
        name: "release:check",
        run: () => {
          const result = checkRelease();
          if (result.errors.length > 0) {
            const err = new Error(
              `release:check failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
            );
            err.code = 1;
            throw err;
          }
          return "ok";
        },
      },
      {
        name: "manifest category coverage",
        run: () => {
          const manifest = loadManifest();
          const counts = new Map();
          for (const e of manifest.entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
          const empty = Object.keys(manifest.categories).filter((c) => !counts.has(c));
          if (empty.length > 0) {
            const err = new Error(`manifest categories with no entries: ${empty.join(", ")}`);
            err.code = 1;
            throw err;
          }
          return `${Object.keys(manifest.categories).length} categories covered`;
        },
      },
    ],
  },
};

// `all` is built dynamically as fast + server + web + docs.
VERIFY_LADDERS.all = {
  description: "fast + server + web + docs",
  steps: [
    ...VERIFY_LADDERS.fast.steps,
    ...VERIFY_LADDERS.server.steps,
    ...VERIFY_LADDERS.web.steps,
    ...VERIFY_LADDERS.docs.steps,
  ],
};

function runNpmScript(args) {
  // Returns the captured stdout. Throws on non-zero exit (preserves code).
  // On Windows the `npm` command is a shim (`npm.cmd`) that spawnSync cannot
  // resolve without a shell; use the .cmd name plus `shell: true` there. The
  // args are fixed internal constants (no user input), so shell use is safe.
  const isWindows = process.platform === "win32";
  const npmCmd = isWindows ? "npm.cmd" : "npm";
  const result = spawnSync(npmCmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    shell: isWindows,
  });
  if (result.error) {
    const wrapped = new Error(
      `failed to spawn npm ${args.join(" ")}: ${result.error.message}`,
    );
    wrapped.code = result.status ?? 1;
    throw wrapped;
  }
  if (result.status !== 0) {
    const err = new Error(
      `npm ${args.join(" ")} exited with code ${result.status}${result.stderr ? `:\n${result.stderr}` : ""}`,
    );
    err.code = result.status ?? 1;
    throw err;
  }
  return (result.stdout || "").trim();
}

/**
 * Run a verify ladder. Returns { ladder, results: [{name, ok, message, code}] }.
 * Throws nothing — failures are reported per-step. The caller decides
 * whether to exit non-zero based on the summary.
 */
export function runVerify(ladderName = "fast") {
  const ladder = VERIFY_LADDERS[ladderName];
  if (!ladder) {
    const err = new Error(
      `unknown ladder '${ladderName}'; expected one of: ${Object.keys(VERIFY_LADDERS).join(", ")}`,
    );
    err.code = 2;
    throw err;
  }
  const results = [];
  for (const step of ladder.steps) {
    try {
      const message = step.run();
      results.push({ name: step.name, ok: true, message: message ?? "ok", code: 0 });
    } catch (err) {
      results.push({
        name: step.name,
        ok: false,
        message: err.message ?? String(err),
        code: typeof err.code === "number" ? err.code : 1,
      });
      // Stop the ladder at the first failing step and return that step's exit
      // code, matching the documented "stop at first failure" contract. A
      // green run is the only pass signal; the first failure is the actionable
      // one.
      break;
    }
  }
  return { ladder: ladderName, description: ladder.description, results };
}

// --------------------------------------------------------------------------
// handoff:check
// --------------------------------------------------------------------------

const REQUIRED_HANDOFF_FRONTMATTER = ["branch", "plan", "status", "updated"];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Parse a YYYY-MM-DD string strictly: return the UTC Date on success, or null
// for malformed / impossible calendar dates (e.g. 2026-02-31), which plain
// `new Date(...)` would silently normalize into a later day.
function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt;
}

// Return the ISO date (YYYY-MM-DD) `days` days before the given ISO date.
function isoDateDaysAgo(iso, days) {
  const [y, mo, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

// Validate a handoff `updated` date string against today (calendar-string
// comparison avoids timezone skew). Returns a failure message, or null if ok.
function handoffDateFailure(updated, todayIso, maxAgeDays) {
  if (!ISO_DATE_RE.test(updated)) {
    return `frontmatter.updated '${updated}' is not ISO YYYY-MM-DD`;
  }
  if (parseIsoDate(updated) === null) {
    return `frontmatter.updated '${updated}' is not a valid calendar date`;
  }
  if (updated > todayIso) {
    return `frontmatter.updated '${updated}' is in the future`;
  }
  if (updated < isoDateDaysAgo(todayIso, maxAgeDays)) {
    return `handoff is stale (updated ${updated}, > ${maxAgeDays} days ago)`;
  }
  return null;
}

const REQUIRED_HANDOFF_HEADINGS = ["Scope", "Verification", "Next action"];

function missingRequiredHeadings(body) {
  return REQUIRED_HANDOFF_HEADINGS.filter(
    (h) => !new RegExp(`^##\\s+${h}`, "m").test(body),
  );
}

// Resolve the git branch name to compare against, honoring an override (used
// by tests to avoid depending on the checked-out branch). Returns "" when no
// real branch is available (detached HEAD, CI without a ref), so callers skip
// the mismatch comparison instead of flagging a false mismatch.
function currentBranchName(branchOverride) {
  if (branchOverride !== undefined) return branchOverride;
  // GitHub Actions checks out a detached ref; fall back to the PR source
  // branch so handoff comparison still works on CI pull-request runs.
  const headRef = process.env.GITHUB_HEAD_REF;
  if (typeof headRef === "string" && headRef.length > 0) return headRef;
  try {
    const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    // A detached HEAD resolves to the literal "HEAD"; there is no branch name.
    return branch === "HEAD" ? "" : branch;
  } catch {
    return "";
  }
}

// Validate a single active handoff file. Returns a list of failure messages.
function validateHandoffFile(file, todayIso, maxAgeDays, branchOverride) {
  const name = rel(file);
  let text;
  try {
    text = readText(file);
  } catch (err) {
    return [`${name}: cannot read (${err.message})`];
  }
  const { frontmatter, body } = parseFrontmatter(text);
  if (!frontmatter) {
    return [`${name}: missing YAML frontmatter (expected '---\\n...\\n---' at top)`];
  }
  const failures = [];
  for (const key of REQUIRED_HANDOFF_FRONTMATTER) {
    if (typeof frontmatter[key] !== "string" || frontmatter[key].length === 0) {
      failures.push(`${name}: frontmatter missing required field '${key}'`);
    }
  }
  if (typeof frontmatter.updated === "string") {
    const dateFailure = handoffDateFailure(frontmatter.updated, todayIso, maxAgeDays);
    if (dateFailure) failures.push(`${name}: ${dateFailure}`);
  }
  if (frontmatter.branch) {
    const currentBranch = currentBranchName(branchOverride);
    if (currentBranch && frontmatter.branch !== currentBranch) {
      failures.push(
        `${name}: frontmatter.branch '${frontmatter.branch}' does not match current branch '${currentBranch}'`,
      );
    }
  }
  if (frontmatter.plan) {
    const planPath = path.isAbsolute(frontmatter.plan)
      ? frontmatter.plan
      : path.join(REPO_ROOT, frontmatter.plan);
    if (!exists(planPath)) {
      failures.push(`${name}: frontmatter.plan '${frontmatter.plan}' does not exist`);
    }
  }
  for (const heading of missingRequiredHeadings(body)) {
    failures.push(`${name}: body is missing required heading '## ${heading}'`);
  }
  return failures;
}

/**
 * Validate every active handoff.
 * Returns { checked, failures }. Never throws — the caller renders the list.
 */
export function checkHandoffs({ dir, currentBranch: branchOverride, maxAgeDays = 14 } = {}) {
  const handoffsDir = dir || ACTIVE_HANDOFFS_DIR;
  const files = exists(handoffsDir)
    ? fs
        .readdirSync(handoffsDir)
        .filter((f) => f.endsWith(".md") && !f.startsWith("."))
        .map((f) => path.join(handoffsDir, f))
    : [];
  // Compare calendar dates (YYYY-MM-DD strings), not timestamps, so that a
  // handoff dated today is never misclassified as future or stale across time
  // zones, and a tomorrow/impossible date is always rejected.
  const todayIso = new Date().toISOString().slice(0, 10);
  const failures = [];
  for (const file of files) {
    failures.push(...validateHandoffFile(file, todayIso, maxAgeDays, branchOverride));
  }
  return { checked: files.length, failures };
}

// --------------------------------------------------------------------------
// release:check
// --------------------------------------------------------------------------

const CHANGELOG_REQUIRED_HEADINGS = [
  /^#\s+Changelog\s*$/m,
  /^All notable changes to this project will be documented in this file\./m,
  /^##\s+\[Unreleased\]/m,
];

// Read and validate server/package.json's version (the single source of truth
// for the app). Returns { version } on success or { error } on failure.
function readServerVersion(serverPkgPath) {
  if (!exists(serverPkgPath)) return { error: "server/package.json is missing" };
  try {
    const pkg = JSON.parse(readText(serverPkgPath));
    if (typeof pkg.version !== "string" || pkg.version.length === 0) {
      return { error: "server/package.json is missing 'version'" };
    }
    if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
      return { error: `server/package.json version '${pkg.version}' is not SemVer (x.y.z...)` };
    }
    return { version: pkg.version };
  } catch (err) {
    return { error: `server/package.json is not valid JSON: ${err.message}` };
  }
}

// Confirm web/package.json carries no version field (server is the sole source).
function webVersionIssues(webPkgPath) {
  if (!exists(webPkgPath)) return [];
  try {
    const pkg = JSON.parse(readText(webPkgPath));
    if (pkg.version !== undefined) {
      return [
        "web/package.json must not carry a 'version' field; server/package.json is the single source of truth",
      ];
    }
    return [];
  } catch (err) {
    return [`web/package.json is not valid JSON: ${err.message}`];
  }
}

// Validate CHANGELOG.md structure and version-source consistency.
function changelogIssues(changelogPath, serverVersion) {
  if (!exists(changelogPath)) return ["CHANGELOG.md is missing at the repository root"];
  const text = readText(changelogPath);
  const errors = [];
  for (const re of CHANGELOG_REQUIRED_HEADINGS) {
    if (!re.test(text)) errors.push(`CHANGELOG.md is missing required pattern ${re}`);
  }
  if (serverVersion) {
    const versionRe = new RegExp(
      `^##\\s+\\[${serverVersion.replace(/[.+*?^$()|[\\]\\\\]/g, "\\$&")}\\]`,
      "m",
    );
    const unreleasedRe = /^##\s+\[Unreleased\]/m;
    if (!versionRe.test(text) && !unreleasedRe.test(text)) {
      // Not a hard error: the current version may not be released yet.
      // Mention it so the user can decide.
      errors.push(
        `CHANGELOG.md has no entry for current version ${serverVersion} and no Unreleased section`,
      );
    }
  }
  return errors;
}

/**
 * Validate the changelog structure and version-source consistency.
 * Returns { errors }. Never throws.
 */
export function checkRelease() {
  const serverPkgPath = path.join(REPO_ROOT, "server", "package.json");
  const webPkgPath = path.join(REPO_ROOT, "web", "package.json");
  const changelogPath = path.join(REPO_ROOT, "CHANGELOG.md");

  const server = readServerVersion(serverPkgPath);
  const errors = server.error ? [server.error] : [];
  errors.push(...webVersionIssues(webPkgPath));
  errors.push(...changelogIssues(changelogPath, server.version ?? ""));
  return { errors };
}

// --------------------------------------------------------------------------
// work:* scaffolders
// --------------------------------------------------------------------------

function parseFlag(argv, name) {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === `--${name}`) {
      // `--name value` form: consume the next arg if it isn't another flag.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) return next;
      // A value-bearing flag supplied without a value is a usage error. Reject
      // it (exit 2) rather than substituting a truthy/empty placeholder and
      // writing an artifact that fails the repo's own validation.
      const err = new Error(`flag --${name} requires a value`);
      err.code = 2;
      throw err;
    }
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function refuseOverwrite(target, kind) {
  if (exists(target)) {
    const err = new Error(
      `refusing to overwrite existing ${kind} at ${rel(target)}; move or remove it first`,
    );
    err.code = 4;
    throw err;
  }
}

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

const TEMPLATES_DIR = path.join(REPO_ROOT, "dev-docs", "templates");

const PLAN_TEMPLATE = `---
title: "<title>"
status: proposed
created: {{date}}
branch: <branch>
---

# <title>

> **Status:** proposed. Update to \`accepted\` once the plan is reviewed and the
> implementation starts. Move this file under \`dev-docs/plans/completed/\` only
> after the implementing PR merges.

## Goal

One paragraph: what is being built and why.

## Constraints

- Hard constraints inherited from root \`AGENTS.md\` (fork guard, version
  source, release rules, harness pins, privacy/security).

## Interfaces and data flow

- Modules touched.
- New routes / API / persistence locations.
- New manifest entries (update \`scripts/repo-manifest.json\` in the same PR).

## Phases

- [ ] Phase 0 — ...
- [ ] Phase 1 — ...

## Acceptance checks

- Fast targeted check: \`npm run verify -- fast\`
- Server check: \`npm run verify -- server\`
- Web check: \`npm run verify -- web\`
- Docs check: \`npm run verify -- docs\`
- Full local check: \`npm run verify -- all\`

## Decisions

Capture the non-obvious decisions and their reasoning here as they are made.
`;

const HANDOFF_TEMPLATE = `---
branch: {{branch}}
plan: <relative path under dev-docs/plans/>
status: active
updated: {{date}}
---

# Active handoff: <title>

> Branch-scoped continuation record. Remove this file when the work merges,
> is abandoned, or is superseded. Do not use it as a global state file.

## Scope

- One paragraph: what this handoff covers.

## Decisions

- Bullet list of decisions taken since the handoff was opened.

## Changed files

- Bullet list of files changed (paths relative to repo root).

## Verification

- Command, outcome, and link to evidence (test output, screenshot, log).

## Known failures

- Bullet list, or \`(none)\`.

## Blockers

- Bullet list, or \`(none)\`.

## Next action

One sentence: the single thing the next session should do first.
`;

const MAINTENANCE_TEMPLATE = `---
date: {{date}}
category: <security | dependency | ci-tooling | operational | verification>
pr: <PR number or merge commit hash>
---

# Maintenance log entry — {{date}}

## Summary

One paragraph: what changed and why it is in the maintenance log instead of
the changelog or a plan.

## Evidence

- Bullet list of commands run, links to artifacts, or output excerpts.
`;

function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] !== undefined ? String(vars[key]) : `{{${key}}}`,
  );
}

/**
 * Scaffold a new plan. Returns the target path. Throws on validation errors
 * or overwrite refusal.
 */
export function scaffoldPlan({ slug, title, branch, cwd = REPO_ROOT } = {}) {
  if (!slug) {
    const err = new Error("--slug <kebab-case> is required");
    err.code = 2;
    throw err;
  }
  const safe = slugify(slug);
  if (!safe) {
    const err = new Error(`--slug '${slug}' did not produce a safe filename`);
    err.code = 2;
    throw err;
  }
  const plansDir = path.join(cwd, "dev-docs", "plans");
  const date = nowIsoDate();
  const target = path.join(plansDir, `${date}-${safe}.md`);
  refuseOverwrite(target, "plan");
  fs.mkdirSync(plansDir, { recursive: true });
  const templatePath = path.join(cwd, "dev-docs", "templates", "plan.md");
  const rawTemplate = exists(templatePath) ? readText(templatePath) : PLAN_TEMPLATE;
  const content = renderTemplate(rawTemplate, {
    date,
    title: title || safe,
    branch: branch || "<branch>",
  })
    .replace(/\[Feature \/ Task Title\]/g, title || safe)
    .replace(/\[YYYY-MM-DD\]/g, date)
    .replace(/\[branch-name\]/g, branch || "<branch>");
  fs.writeFileSync(target, content);
  return target;
}

/**
 * Scaffold a new active handoff. Returns the target path.
 */
export function scaffoldHandoff({ slug, branch, plan, cwd = REPO_ROOT } = {}) {
  let resolvedBranch = branch;
  if (!resolvedBranch) {
    try {
      resolvedBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      const err = new Error("--branch <name> is required (no git checkout available to read it)");
      err.code = 2;
      throw err;
    }
  }
  if (!plan) {
    const err = new Error("--plan <path> is required (relative to repo root, e.g. dev-docs/plans/2026-09-03-foo.md)");
    err.code = 2;
    throw err;
  }
  const safe = slug ? slugify(slug) : slugify(resolvedBranch);
  if (!safe) {
    const err = new Error(`could not derive a safe filename from '${slug || resolvedBranch}'`);
    err.code = 2;
    throw err;
  }
  const dir = path.join(cwd, "dev-docs", "handoffs", "active");
  const target = path.join(dir, `${safe}.md`);
  refuseOverwrite(target, "handoff");
  fs.mkdirSync(dir, { recursive: true });
  const templatePath = path.join(cwd, "dev-docs", "templates", "handoff.md");
  const rawTemplate = exists(templatePath) ? readText(templatePath) : HANDOFF_TEMPLATE;
  const date = nowIsoDate();
  const content = renderTemplate(rawTemplate, {
    date,
    branch: resolvedBranch,
  })
    .replace(/<relative path under dev-docs\/plans\/>/, plan)
    .replace("[branch-name]", resolvedBranch)
    .replace("[plan-file].md", plan.replace(/^dev-docs\/plans\//, ""))
    .replace("[optional-owner]", "")
    .replace("[YYYY-MM-DD]", date)
    .replace("[Branch Name]", resolvedBranch);
  fs.writeFileSync(target, content);
  return target;
}

/**
 * Scaffold a new maintenance-log entry. Returns the target path.
 */
export function scaffoldMaintenance({ pr, category, cwd = REPO_ROOT } = {}) {
  if (!pr) {
    const err = new Error("--pr <PR number or commit hash> is required");
    err.code = 2;
    throw err;
  }
  const logPath = path.join(cwd, "dev-docs", "maintenance-log.md");
  if (!exists(logPath)) {
    const err = new Error(`dev-docs/maintenance-log.md is missing at ${rel(logPath)}`);
    err.code = 5;
    throw err;
  }
  const templatePath = path.join(cwd, "dev-docs", "templates", "maintenance-entry.md");
  const rawTemplate = exists(templatePath) ? readText(templatePath) : MAINTENANCE_TEMPLATE;
  const prRef = String(pr).replace(/^#/, "");
  const current = readText(logPath);
  const prMarker = `(PR #${prRef})`;
  if (current.includes(prMarker)) {
    const err = new Error(
      `refusing to append duplicate maintenance entry for ${prMarker}; edit the existing entry instead`,
    );
    err.code = 4;
    throw err;
  }
  const date = nowIsoDate();
  const entry = renderTemplate(rawTemplate, {
    date,
    category: category || "<security | dependency | ci-tooling | operational | verification>",
  })
    .replace(/<PR number or merge commit hash>/, pr)
    .replace(/<security \| dependency \| ci-tooling \| operational \| verification>/, category || "<security | dependency | ci-tooling | operational | verification>")
    .replace(/\[YYYY-MM-DD\]/g, date)
    .replace("[security | dependency | ci-tooling | operational | verification]", category || "[security | dependency | ci-tooling | operational | verification]")
    .replace("[number]", prRef);
  const lines = current.split("\n");
  let h1Index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) {
      h1Index = i;
      break;
    }
  }
  let updated;
  if (h1Index === -1) {
    updated = `# Maintenance log\n\n${entry.trimEnd()}\n\n${current.replace(/^\n+/, "")}`;
  } else {
    let insertAt = h1Index + 1;
    while (insertAt < lines.length && lines[insertAt].trim().length > 0) {
      insertAt++;
    }
    const before = lines.slice(0, insertAt).join("\n");
    const after = lines.slice(insertAt).join("\n");
    updated = `${before}\n\n${entry.trimEnd()}\n\n${after.replace(/^\n+/, "")}`;
  }
  fs.writeFileSync(logPath, updated);
  return logPath;
}

// --------------------------------------------------------------------------
// CLI runner
// --------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(`Repository command hub

Usage: node scripts/repo.mjs <subcommand> [args]

Subcommands:
  status                  Show branch, dirty state, recent commits, and active handoffs.
  map                     Print the architectural map from scripts/repo-manifest.json.
  verify [ladder]         Run a verification ladder. Ladder: fast | server | web | docs | all.
                          Default: fast. (npm run docs:check aliases verify -- docs.)
  handoff:check           Validate dev-docs/handoffs/active/ files.
  release:check           Check server/package.json version and CHANGELOG.md structure.
  work:plan --slug <s>    Scaffold a new plan under dev-docs/plans/ (refuses overwrite).
  work:handoff --plan <p> Scaffold a new active handoff (refuses overwrite).
                          Optional: --slug <s>, --branch <name> (default: current).
  work:maintenance --pr <p> Append a new entry to dev-docs/maintenance-log.md
                          (refuses overwrite). Optional: --category <name>.

All subcommands fail loudly, preserve the original exit code of any check they
delegate to, and never bypass hooks, CI, or release automation.
`);
}

function isMain() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === SCRIPT_PATH;
}

function cmdStatus() {
  const report = statusReport();
  process.stdout.write(`${report.lines.join("\n")}\n`);
  return 0;
}

function cmdMap() {
  const manifest = loadManifest();
  process.stdout.write(`${mapReport(manifest)}\n`);
  return 0;
}

function cmdVerify(rest) {
  const ladder = rest[0] && !rest[0].startsWith("--") ? rest[0] : "fast";
  let result;
  try {
    result = runVerify(ladder);
  } catch (err) {
    process.stderr.write(`repo verify: ${err.message}\n`);
    return err.code ?? 2;
  }
  process.stdout.write(`verify (${result.ladder}): ${result.description}\n`);
  let worstCode = 0;
  for (const r of result.results) {
    const tag = r.ok ? "ok  " : "FAIL";
    process.stdout.write(`  [${tag}] ${r.name}: ${r.message}\n`);
    if (!r.ok && r.code > worstCode) worstCode = r.code;
  }
  if (worstCode !== 0) {
    process.stderr.write(
      `repo verify: ${result.results.filter((r) => !r.ok).length} step(s) failed; see output above for the failing command and its exit code\n`,
    );
  }
  return worstCode;
}

function cmdHandoffCheck() {
  const result = checkHandoffs();
  process.stdout.write(`handoff:check: ${result.checked} active handoff(s)\n`);
  if (result.failures.length > 0) {
    for (const f of result.failures) process.stderr.write(`  - ${f}\n`);
    return 1;
  }
  return 0;
}

function cmdReleaseCheck() {
  const result = checkRelease();
  if (result.errors.length === 0) {
    process.stdout.write(`release:check: ok\n`);
    return 0;
  }
  for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
  return 1;
}

function cmdWorkPlan(rest) {
  try {
    const target = scaffoldPlan({
      slug: parseFlag(rest, "slug"),
      title: parseFlag(rest, "title"),
      branch: parseFlag(rest, "branch"),
    });
    process.stdout.write(`wrote ${rel(target)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`repo: ${err.message}\n`);
    return err.code ?? 2;
  }
}

function cmdWorkHandoff(rest) {
  try {
    const target = scaffoldHandoff({
      slug: parseFlag(rest, "slug"),
      branch: parseFlag(rest, "branch"),
      plan: parseFlag(rest, "plan"),
    });
    process.stdout.write(`wrote ${rel(target)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`repo: ${err.message}\n`);
    return err.code ?? 2;
  }
}

function cmdWorkMaintenance(rest) {
  try {
    const target = scaffoldMaintenance({
      pr: parseFlag(rest, "pr"),
      category: parseFlag(rest, "category"),
    });
    process.stdout.write(`appended to ${rel(target)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`repo: ${err.message}\n`);
    return err.code ?? 2;
  }
}

const COMMANDS = {
  status: cmdStatus,
  map: cmdMap,
  verify: cmdVerify,
  "handoff:check": cmdHandoffCheck,
  "release:check": cmdReleaseCheck,
  "work:plan": cmdWorkPlan,
  "work:handoff": cmdWorkHandoff,
  "work:maintenance": cmdWorkMaintenance,
};

function main(argv) {
  const [, , subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return 0;
  }
  const cmd = COMMANDS[subcommand];
  if (!cmd) {
    process.stderr.write(`repo: unknown subcommand '${subcommand}'\n`);
    printHelp();
    return 2;
  }
  return cmd(rest);
}

// Expose the CLI entry for tests that want to invoke main() directly.
export const __cli = { main, printHelp };

if (isMain()) {
  const code = main(process.argv);
  if (typeof code === "number" && code !== 0) process.exit(code);
}
