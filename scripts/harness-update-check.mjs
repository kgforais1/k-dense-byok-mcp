/**
 * Harness update check.
 *
 * The Pi harness packages are pinned to exact versions in server/package.json
 * on purpose (see AGENTS.md): upstream "minor" releases have repeatedly changed
 * agent tool surfaces in ways tests do not catch, so upgrading is a deliberate
 * act. This script does NOT upgrade anything — it only compares each pinned
 * package against npm's `latest` dist-tag and reports the difference, so the
 * scheduled workflow can open/update a notification issue.
 *
 * NOTE: keep the PINNED list in sync with server/package.json's exact pins.
 *
 * Usage: node scripts/harness-update-check.mjs <markdown-output> <gha-output>
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const PINNED = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "pi-subagents",
  "pi-web-access",
  "skills",
];

const markdownOut = process.argv[2] ?? "harness-check-result.md";
const ghaOut = process.argv[3] ?? process.env.GITHUB_OUTPUT ?? "/dev/null";

const pkg = JSON.parse(fs.readFileSync("server/package.json", "utf8"));
const updates = [];
const errors = [];
for (const name of PINNED) {
  const pin = pkg.dependencies[name];
  if (pin === undefined) continue;
  let latest;
  try {
    latest = execFileSync("npm", ["view", name, "version"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch (err) {
    // A single registry blip should not kill the report; only fail when
    // nothing at all could be checked.
    errors.push(name);
    console.error(`npm view failed for ${name}: ${err.message}`);
    continue;
  }
  if (latest !== pin) {
    updates.push({ name, pin, latest });
  }
}

if (errors.length > 0 && errors.length === PINNED.length) {
  console.error("All npm view calls failed — cannot produce a report.");
  process.exit(1);
}

const errorNote =
  errors.length > 0
    ? `\n> ⚠️ Could not check: ${errors.map((e) => `\`${e}\``).join(", ")} (npm registry error). Re-run the workflow to retry.\n`
    : "";

const signature = updates.map((u) => `${u.name}@${u.latest}`).sort().join("|");

if (updates.length === 0) {
  fs.writeFileSync(
    markdownOut,
    `<!-- harness-update signature: none -->\nAll pinned harness packages are current as of ${new Date().toISOString().slice(0, 10)}.${errorNote}`,
  );
  fs.appendFileSync(ghaOut, "has_updates=false\n");
  process.exit(0);
}

const rows = updates
  .map((u) => `| \`${u.name}\` | \`${u.pin}\` | \`${u.latest}\` |`)
  .join("\n");
const body = `<!-- harness-update signature: ${signature} -->
Newer releases exist for pinned Pi harness packages. The repo keeps these on exact pins on purpose — upstream releases have changed agent tool surfaces in ways tests do not catch (see AGENTS.md), so upgrading is a deliberate act.

| Package | Pinned / installed | Latest on npm |
|---|---|---|
${rows}

> The three \`@earendil-works/*\` packages share one version line and must be bumped together.${errorNote}

**To upgrade:** bump the pins in \`server/package.json\`, run \`npm install\` in \`server/\`, then \`npm run typecheck && npm test\`. Read the upstream release notes first for tool-surface changes (notably the \`subagent\` tool and builtin specialist allowlists).`;

fs.writeFileSync(markdownOut, body);
fs.appendFileSync(ghaOut, `has_updates=true\nsignature=${signature}\n`);
