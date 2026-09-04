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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();

function rel(p) {
  return path.relative(REPO_ROOT, p) || ".";
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

function extractAnchors(text) {
  const anchors = new Set();
  for (const m of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const raw = m[1].trim();
    const slug = raw
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 80);
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
        return i === -1 ? null : href.slice(i + 1).toLowerCase();
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

const REQUIRED_HANDOFF_FIELDS = ["branch", "plan", "status", "updated"];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REQUIRED_HANDOFF_HEADINGS = ["Scope", "Verification", "Next action"];

function checkHandoffs() {
  const failures = [];
  const dir = path.join(REPO_ROOT, "dev-docs", "handoffs", "active");
  if (!exists(dir)) return failures; // no active handoffs is fine

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .map((f) => path.join(dir, f))
    .sort();

  for (const file of files) {
    const name = rel(file);
    let text;
    try {
      text = readText(file);
    } catch (err) {
      failures.push(`${name}: cannot read (${err.message})`);
      continue;
    }
    const frontMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
    if (!frontMatch) {
      failures.push(
        `${name}: missing YAML frontmatter (expected ---\\n...\\n--- at top)`,
      );
      continue;
    }
    const fields = {};
    for (const line of frontMatch[1].split("\n")) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
      if (m) fields[m[1]] = stripQuotes(m[2]);
    }
    for (const key of REQUIRED_HANDOFF_FIELDS) {
      if (typeof fields[key] !== "string" || fields[key].length === 0) {
        failures.push(`${name}: frontmatter missing required field '${key}'`);
      }
    }
    if (typeof fields.updated === "string") {
      if (!ISO_DATE_RE.test(fields.updated)) {
        failures.push(
          `${name}: frontmatter.updated '${fields.updated}' is not ISO YYYY-MM-DD`,
        );
      }
    }
    const body = text.slice(frontMatch[0].length);
    for (const heading of REQUIRED_HANDOFF_HEADINGS) {
      if (!new RegExp(`^##\\s+${heading}`, "m").test(body)) {
        failures.push(`${name}: body is missing required heading '## ${heading}'`);
      }
    }
  }
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
