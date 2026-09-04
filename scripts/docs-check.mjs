#!/usr/bin/env node
/**
 * Deterministic documentation/handoff validation (Phase 5).
 *
 * Checks:
 *  1. Internal relative markdown links and anchors across
 *     root markdown files, docs/**, dev-docs/**, and .github/**.
 *  2. CLAUDE.md and GEMINI.md are short compatibility pointers to AGENTS.md
 *     and contain no extra policy.
 *  3. scripts/repo-manifest.json target paths exist and required
 *     categories are declared.
 *  4. Active handoffs in dev-docs/handoffs/active/ match the schema.
 *  5. Plan placement: active plans live under dev-docs/plans/ and
 *     completed plans live under dev-docs/plans/completed/.
 *
 * No network access. Dependency-free. Exit code 0 on success, 1 on
 * failure with clear descriptions to stderr.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkHandoffs as checkHandoffsStrict } from "./repo.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// docs-check validates the repository it is pointed at. It resolves the repo
// root from cwd (so tests can run it against a fixture tree), while the
// strict handoff checker it delegates to lives beside this script and targets
// its own repo root. Both agree for the in-repo case.
const REPO_ROOT = process.cwd();
const SCRIPT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rel(p) {
  // Normalize to forward slashes so error messages are identical on every OS
  // (markdown links and the manifest use / separators; a Windows backslash in
  // a reported path would break copy-paste and differ from the link text).
  return path.relative(REPO_ROOT, p).split(path.sep).join("/") || ".";
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

function stripQuotes(value) {
  // YAML scalar values may be single- or double-quoted; the schema checks below
  // compare against unquoted forms (ISO dates, branch names, plan paths).
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function walk(dir, predicate) {
  if (!exists(dir)) return [];
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, predicate));
    } else if (predicate(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function fail(messages) {
  const list = Array.isArray(messages) ? messages : [messages];
  for (const msg of list) {
    process.stderr.write(`docs:check: ${msg}\n`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Link validation
// ---------------------------------------------------------------------------

const LINK_RE = /!?\[[^\]]*\]\(([^)]+)\)/g;

// Approximate GitHub's heading-anchor algorithm: lowercase, drop punctuation
// except hyphens/underscores, collapse whitespace to single hyphens, and dedupe
// repeated headings by appending -1, -2, ... . Kept in one place so the
// fragment checks below stay consistent with the links GitHub generates.
function slugifyHeading(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "") // drop punctuation (backticks, dots, slashes, etc.)
    .trim()
    .replace(/\s+/g, "-"); // whitespace -> single hyphen run
}

function extractAnchors(text) {
  const anchors = new Set();
  const seen = new Map();
  for (const m of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    let slug = slugifyHeading(m[1]).slice(0, 80);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    if (count > 0) slug = `${slug}-${count}`;
    anchors.add(slug);
  }
  return anchors;
}

function checkLinks() {
  const failures = [];
  const roots = [
    { dir: REPO_ROOT, glob: "*.md" },
    { dir: path.join(REPO_ROOT, "docs"), glob: "**/*.md" },
    { dir: path.join(REPO_ROOT, "dev-docs"), glob: "**/*.md" },
    { dir: path.join(REPO_ROOT, ".github"), glob: "**/*.md" },
  ];

  const files = new Set();
  for (const { dir, glob } of roots) {
    if (glob === "*.md") {
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (entry.endsWith(".md") && !entry.startsWith(".")) {
            files.add(path.join(dir, entry));
          }
        }
      } catch {
        // ignore unreadable dir
      }
    } else {
      for (const f of walk(dir, (n) => n.endsWith(".md"))) {
        files.add(f);
      }
    }
  }

  const anchorMap = new Map();
  for (const file of files) {
    anchorMap.set(file, extractAnchors(readText(file)));
  }

  for (const file of files) {
    const text = readText(file);
    for (const m of text.matchAll(LINK_RE)) {
      const raw = m[1].trim();
      // Skip external URLs and mailto.
      if (/^(https?:|mailto:)/i.test(raw)) continue;

      const href = raw.split(/\s+/)[0];
      const anchor = (() => {
        const i = href.indexOf("#");
        if (i === -1) return null;
        // Normalize the fragment the same way we slugify headings so that
        // e.g. `#foo bar` and `#Foo Bar` resolve to the same `foo-bar` anchor.
        return slugifyHeading(decodeURIComponent(href.slice(i + 1)));
      })();
      const target = href.split("#")[0];

      if (!target) {
        // Self-reference or empty.
        if (anchor && !anchorMap.get(file).has(anchor)) {
          failures.push(
            `${rel(file)}: fragment #${anchor} not found in ${rel(file)}`,
          );
        }
        continue;
      }

      const resolved = path.resolve(path.dirname(file), target);
      if (!exists(resolved)) {
        failures.push(`${rel(file)}: link target missing: ${href}`);
        continue;
      }
      if (anchor && !anchorMap.get(resolved).has(anchor)) {
        failures.push(
          `${rel(file)}: fragment #${anchor} not found in ${rel(resolved)}`,
        );
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Pointer validation
// ---------------------------------------------------------------------------

function checkPointers() {
  const failures = [];
  for (const name of ["CLAUDE.md", "GEMINI.md"]) {
    const file = path.join(REPO_ROOT, name);
    if (!exists(file)) {
      failures.push(`${name}: missing`);
      continue;
    }
    const text = readText(file);
    const lines = text.split("\n").filter((l) => l.trim().length > 0);

    // Must contain exactly one AGENTS.md pointer link (with or without backticks).
    const pointerLines = lines.filter((l) =>
      /\[`?AGENTS\.md`?\]\(AGENTS\.md\)/.test(l),
    );
    if (pointerLines.length !== 1) {
      failures.push(
        `${name}: must contain exactly one AGENTS.md pointer line, found ${pointerLines.length}`,
      );
    }

    // Must contain exactly one H1 heading matching the filename (standard pointer template).
    const h1Headings = lines.filter((l) => /^#\s+/.test(l));
    if (h1Headings.length !== 1) {
      failures.push(
        `${name}: must contain exactly one H1 heading, found ${h1Headings.length}`,
      );
    }

    // Must not contain policy headings beyond the allowed H1 (## , ### ) or bullet/numbered
    // policy-style lines. Allow the known template lines.
    const knownTemplatePrefixes = [
      "Read and follow the canonical repository instructions at",
      "If a scoped instruction file is closer to the",
      "area you are changing, read it first, then this file:",
      "- `",
      "Do not add policy",
    ];
    for (const line of lines) {
      // Skip known template lines.
      const isKnown = knownTemplatePrefixes.some((p) => line.startsWith(p));
      if (isKnown) continue;
      // Allow the single H1 filename heading.
      if (/^##\s+/.test(line)) {
        failures.push(
          `${name}: must not contain extra policy headings (found '${line}')`,
        );
      }
      // Disallow numbered policy rules.
      if (/^\d+\.\s/.test(line)) {
        failures.push(
          `${name}: must not contain extra numbered policy (found '${line}')`,
        );
      }
      // Disallow bold rule-style bullets.
      if (/^-\s+\*\*[^*]+\*\*/.test(line)) {
        failures.push(
          `${name}: must not contain extra policy bullets (found '${line}')`,
        );
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

const REQUIRED_CATEGORIES = new Set([
  "entry-point",
  "runtime-service",
  "persistence-boundary",
  "policy",
  "verification",
  "developer-documentation",
  "product-documentation",
  "release-record",
]);

function checkManifest() {
  const failures = [];
  const manifestPath = path.join(REPO_ROOT, "scripts", "repo-manifest.json");
  if (!exists(manifestPath)) {
    failures.push("scripts/repo-manifest.json: missing");
    return failures;
  }
  let manifest;
  try {
    manifest = JSON.parse(readText(manifestPath));
  } catch (err) {
    failures.push(`scripts/repo-manifest.json: invalid JSON: ${err.message}`);
    return failures;
  }
  if (typeof manifest !== "object" || manifest === null) {
    failures.push("scripts/repo-manifest.json: must be a JSON object");
    return failures;
  }
  if (typeof manifest.categories !== "object" || manifest.categories === null) {
    failures.push("scripts/repo-manifest.json: missing categories");
    return failures;
  }
  if (!Array.isArray(manifest.entries)) {
    failures.push("scripts/repo-manifest.json: missing entries");
    return failures;
  }

  const missingCategories = [...REQUIRED_CATEGORIES].filter(
    (c) => !(c in manifest.categories),
  );
  if (missingCategories.length > 0) {
    failures.push(
      `scripts/repo-manifest.json: missing required categories: ${missingCategories.join(", ")}`,
    );
  }

  const seenIds = new Set();
  const seenPaths = new Set();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object") {
      failures.push("scripts/repo-manifest.json: entry is not an object");
      continue;
    }
    for (const key of ["id", "category", "path", "name", "description"]) {
      if (typeof entry[key] !== "string" || entry[key].length === 0) {
        failures.push(
          `scripts/repo-manifest.json: entry missing string field '${key}'`,
        );
      }
    }
    if (seenIds.has(entry.id)) {
      failures.push(`scripts/repo-manifest.json: duplicate entry id '${entry.id}'`);
    }
    seenIds.add(entry.id);
    if (seenPaths.has(entry.path)) {
      failures.push(
        `scripts/repo-manifest.json: duplicate entry path '${entry.path}'`,
      );
    }
    seenPaths.add(entry.path);
    if (!(entry.category in manifest.categories)) {
      failures.push(
        `scripts/repo-manifest.json: entry '${entry.id}' has unknown category '${entry.category}'`,
      );
    }
    const target = path.join(REPO_ROOT, entry.path);
    if (!exists(target)) {
      failures.push(
        `scripts/repo-manifest.json: entry '${entry.id}' references missing target '${entry.path}'`,
      );
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Handoff validation
// ---------------------------------------------------------------------------

// Delegate to the strict checker in repo.mjs so `npm run docs:check` and
// `npm run verify -- docs` (and `npm run handoff:check`) all enforce the SAME
// rules: required frontmatter, ISO date, not future / not stale (>14d),
// branch-name match, plan-file existence, and required body headings. A
// shorter local copy here previously skipped branch/staleness/plan checks,
// letting a bad handoff pass docs:check while verify -- docs failed it.
function checkHandoffs() {
  // When docs-check runs against a fixture tree (cwd != this script's repo),
  // handoff fixtures are validated by the caller's own copy of repo.mjs, not
  // this checkout's, so skip the in-repo delegation to avoid cross-contamination.
  if (SCRIPT_REPO_ROOT !== REPO_ROOT) return [];
  const { failures } = checkHandoffsStrict({ dir: path.join(REPO_ROOT, "dev-docs", "handoffs", "active") });
  return failures;
}

// ---------------------------------------------------------------------------
// Plan placement validation
// ---------------------------------------------------------------------------

function checkPlans() {
  const failures = [];
  const plansDir = path.join(REPO_ROOT, "dev-docs", "plans");
  const completedDir = path.join(REPO_ROOT, "dev-docs", "plans", "completed");
  if (exists(plansDir)) {
    for (const f of fs.readdirSync(plansDir)) {
      if (!f.endsWith(".md") || f.startsWith(".")) continue;
      const full = path.join(plansDir, f);
      const text = readText(full);
      if (/status:\s*completed/i.test(text)) {
        failures.push(
          `${rel(full)}: plan with status 'completed' must be under dev-docs/plans/completed/`,
        );
      }
    }
  }
  if (exists(completedDir)) {
    for (const f of fs.readdirSync(completedDir)) {
      if (!f.endsWith(".md") || f.startsWith(".")) continue;
      const full = path.join(completedDir, f);
      const text = readText(full);
      if (
        !/status:\s*completed/i.test(text) &&
        !/Completed and merged/i.test(text)
      ) {
        failures.push(
          `${rel(full)}: completed plan must have status 'completed' or 'Completed and merged...'`,
        );
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const allFailures = [
  ...checkLinks(),
  ...checkPointers(),
  ...checkManifest(),
  ...checkHandoffs(),
  ...checkPlans(),
];

if (allFailures.length > 0) {
  fail(allFailures);
}
process.stdout.write("docs:check: ok\n");
process.exit(0);
