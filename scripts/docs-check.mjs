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

/** Return a repo-relative path using forward slashes for stable error messages. */
function rel(p) {
  return path.relative(REPO_ROOT, p).split(path.sep).join("/") || ".";
}

/** Return true when `p` exists and is accessible. */
function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Read a UTF-8 text file from disk. */
function readText(p) {
  return fs.readFileSync(p, "utf8");
}

/** Strip optional YAML single- or double-quote wrappers from a scalar value. */
function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Recursively collect files under `dir` whose names satisfy `predicate`. */
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

/** Print validation failures to stderr and exit with code 1. */
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

/** Slugify a markdown heading the way GitHub generates fragment anchors. */
function slugifyHeading(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "") // drop punctuation (backticks, dots, slashes, etc.)
    .trim()
    .replace(/\s+/g, "-"); // whitespace -> single hyphen run
}

/** Extract deduplicated heading anchor slugs from markdown text. */
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

/** Validate internal markdown links and fragment anchors across scanned roots. */
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
      failures.push(...checkLink(file, m[1], anchorMap));
    }
  }
  return failures;
}

/** Validate one markdown link target and optional fragment against `anchorMap`. */
function checkLink(file, raw, anchorMap) {
  const failures = [];
  // Skip external URLs and mailto.
  if (/^(https?:|mailto:)/i.test(raw.trim())) return failures;

  const href = raw.trim().split(/\s+/)[0];
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
      failures.push(`${rel(file)}: fragment #${anchor} not found in ${rel(file)}`);
    }
    return failures;
  }

  const resolved = path.resolve(path.dirname(file), target);
  if (!exists(resolved)) {
    failures.push(`${rel(file)}: link target missing: ${href}`);
    return failures;
  }
  if (anchor && !anchorsFor(resolved, anchorMap).has(anchor)) {
    failures.push(`${rel(file)}: fragment #${anchor} not found in ${rel(resolved)}`);
  }
  return failures;
}

/**
 * Return anchor slugs for a link target, lazily parsing out-of-root markdown
 * files and caching the result in `anchorMap`.
 */
function anchorsFor(resolvedPath, anchorMap) {
  if (anchorMap.has(resolvedPath)) return anchorMap.get(resolvedPath);
  let anchors = new Set();
  if (resolvedPath.endsWith(".md")) {
    try {
      anchors = extractAnchors(readText(resolvedPath));
    } catch {
      anchors = new Set();
    }
  }
  anchorMap.set(resolvedPath, anchors);
  return anchors;
}

// ---------------------------------------------------------------------------
// Pointer validation
// ---------------------------------------------------------------------------

/** Split pointer-file text into non-empty lines with CRLF normalized away. */
function pointerFileLines(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0);
}

/** Validate CLAUDE.md and GEMINI.md pointer files for shape and policy drift. */
function checkPointers() {
  const failures = [];
  for (const name of ["CLAUDE.md", "GEMINI.md"]) {
    const file = path.join(REPO_ROOT, name);
    if (!exists(file)) {
      failures.push(`${name}: missing`);
      continue;
    }
    const text = readText(file);
    const lines = pointerFileLines(text);

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
    } else {
      const expectedH1 = `# ${name}`;
      if (h1Headings[0] !== expectedH1) {
        failures.push(
          `${name}: H1 must be '${expectedH1}', found '${h1Headings[0]}'`,
        );
      }
    }

    // Must not contain policy headings beyond the allowed H1 (## , ### ) or bullet/numbered
    // policy-style lines. Allow the known template lines.
    for (const msg of pointerPolicyLineFailures(name, lines)) failures.push(msg);
  }
  return failures;
}

/**
 * Scan pointer-file lines for policy content outside the allowed template.
 * Returns human-readable failure messages.
 */
function pointerPolicyLineFailures(name, lines) {
  const failures = [];
  const allowedScopedBullets = new Set([
    "- `server/AGENTS.md` — backend (TypeScript + Pi SDK).",
    "- `web/AGENTS.md` — frontend (Next.js 16 / React 19).",
    "- `.github/AGENTS.md` — workflow permissions, matrix, release automation.",
  ]);
  const knownTemplatePrefixes = [
    "Claude Code project memory discovers",
    "Gemini CLI discovers",
    "This file is a short",
    "compatibility pointer",
    "pointer; it is not a second policy.",
    "Read and follow the canonical repository instructions at",
    "If a scoped instruction file is closer to the",
    "area you are changing, read it first, then this file:",
    "Do not add policy",
    "`AGENTS.md` (and the scoped file, if any) instead.",
  ];
  for (const line of lines) {
    // Allow the single H1 filename heading and the AGENTS.md pointer line.
    if (/^#\s+/.test(line)) continue;
    if (/\[`?AGENTS\.md`?\]\(AGENTS\.md\)/.test(line)) continue;
    if (knownTemplatePrefixes.some((p) => line.startsWith(p))) continue;
    if (allowedScopedBullets.has(line)) continue;
    if (/^##\s+/.test(line)) {
      failures.push(
        `${name}: must not contain extra policy headings (found '${line}')`,
      );
      continue;
    }
    if (line.startsWith("- ")) {
      failures.push(
        `${name}: must not contain extra policy bullets (found '${line}')`,
      );
      continue;
    }
    // Disallow numbered policy rules.
    if (/^\d+\.\s/.test(line)) {
      failures.push(
        `${name}: must not contain extra numbered policy (found '${line}')`,
      );
      continue;
    }
    // Disallow bold rule-style bullets.
    if (/^-\s+\*\*[^*]+\*\*/.test(line)) {
      failures.push(
        `${name}: must not contain extra policy bullets (found '${line}')`,
      );
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

/** Validate repo-manifest.json categories, entries, and on-disk targets. */
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
    validateManifestEntry(entry, manifest.categories, seenIds, seenPaths, failures);
  }
  return failures;
}

/** Append manifest entry validation failures into the shared `failures` list. */
function validateManifestEntry(entry, categories, seenIds, seenPaths, failures) {
  const prefix = "scripts/repo-manifest.json:";
  if (!entry || typeof entry !== "object") {
    failures.push(`${prefix} entry is not an object`);
    return;
  }
  for (const key of ["id", "category", "path", "name", "description"]) {
    if (typeof entry[key] !== "string" || entry[key].length === 0) {
      failures.push(`${prefix} entry missing string field '${key}'`);
    }
  }
  if (seenIds.has(entry.id)) {
    failures.push(`${prefix} duplicate entry id '${entry.id}'`);
  }
  seenIds.add(entry.id);
  if (seenPaths.has(entry.path)) {
    failures.push(`${prefix} duplicate entry path '${entry.path}'`);
  }
  seenPaths.add(entry.path);
  if (!(entry.category in categories)) {
    failures.push(`${prefix} entry '${entry.id}' has unknown category '${entry.category}'`);
  }
  const target = path.join(REPO_ROOT, entry.path);
  if (!exists(target)) {
    failures.push(`${prefix} entry '${entry.id}' references missing target '${entry.path}'`);
  }
}

// ---------------------------------------------------------------------------
// Handoff validation
// ---------------------------------------------------------------------------

/** Delegate active-handoff validation to the shared checker in repo.mjs. */
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

/** Enforce active vs completed plan placement under dev-docs/plans/. */
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
