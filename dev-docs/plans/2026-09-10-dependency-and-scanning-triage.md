---
title: "Dependency alerts and code scanning — triage and clearance"
status: proposed
created: 2026-09-10
branch: deps-security-triage
---

# Dependency Alerts and Code Scanning — Triage and Clearance

**Status:** Proposed.

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. See
> `docs/development/workflow.md#archive-lifecycle`.

**Goal:** Get both alert surfaces to a state where a new alert means something.
Today there are 49 open Dependabot alerts and 195 open code-scanning alerts, and
nobody can tell the real ones from the noise at a glance. That is the actual
defect: not any single advisory, but that the signal is unreadable.

Recorded as [todo “Address code scanning / security alerts and Dependabot
PRs”](../todo.md#2-code-scanning-security-alerts-and-dependabot).

## What is actually there

Measured 2026-09-10 on `main` at `0acc8b4`.

| Surface | Open | Shape |
|---|---|---|
| Dependabot | 49 (2 critical, 12 high, 29 medium, 6 low) | 34 in `web/`, 15 in `server/`; 37 runtime, 12 development |
| CodeQL | 195 (all high) | 183 `js/path-injection`, 7 `js/insecure-randomness`, 2 `js/polynomial-redos`, 1 each `js/resource-exhaustion`, `js/reflected-xss`, `js/incomplete-sanitization` |

`npm audit` tells a much smaller story than Dependabot, because Dependabot
counts each advisory separately while npm groups by package: 10 vulnerable
packages in `server/`, 29 in `web/`.

The `Rules1` branch ruleset is active on `main` and does gate merges on CodeQL
`high_or_higher` / `errors`. It has not blocked anything so far because the gate
is on alerts a pull request *introduces*, not on the standing backlog — PR #22
passed `Analyze (javascript-typescript)` with all 195 open. So the backlog is
not blocking today, but the gate is live, and a PR that adds one new high alert
to `server/src/api/sandbox.ts` would be stopped by a check whose output is 49
pre-existing alerts in that same file. That is the concrete cost of the noise.

## Dependency triage

Three buckets. The split is by *what the bump costs*, not by severity, because
severity is what Dependabot already sorts on and it is not the thing in dispute.

### Bucket 1 — safe, mechanical, no API surface at risk

Everything reachable by plain `npm audit fix`, which resolves transitive
dependencies inside the ranges the direct dependencies already permit. No
`package.json` edit, no major version, no code change.

- `server/`: 9 of 10 vulnerable packages, covering `fastify` → 5.12.1,
  `find-my-way`, `ip-address`, `qs`, `protobufjs`, `body-parser`,
  `@hono/node-server`, `esbuild`, `smol-toml`. Dry run: added 3, removed 1,
  changed 12 of 725 packages.
- `web/`: the majority, covering `browserslist`, `flatted`, `lodash-es`,
  `mermaid`, `picomatch`, `postcss-selector-parser`, `uuid`, `@babel/core`,
  `@humanfs/node`, `@vitest/mocker` + `vitest`, `@ai-sdk/provider-utils`,
  `baseline-browser-mapping`. Dry run: added 8, removed 14, changed 52 of 1149.

Verification is the existing ladder: `npm run verify -- all` on both packages.
The `web/` dry run removes 14 packages, which is the one number in this bucket
worth reading the resulting diff for rather than trusting.

### Bucket 2 — needs a decision or a code check

**`next` 16.2.11 → 16.3.3 (both critical alerts).** Exact-pinned, not
caret-ranged, so `audit fix` will not touch it. `eslint-config-next` is pinned
to the same 16.2.11 and must move in lockstep. This also clears the `postcss`
and `sharp` highs, which are transitive *through* `next` — `npm audit` reports
both as "will install next@16.3.4, which is outside the stated dependency
range", i.e. they are not independently fixable. One bump, three problems.
Patch-level within 16.3, so the risk is low, but it is the largest single
runtime change here and deserves its own commit.

**`pdfjs-dist` ^5.6.205 → 6.2.108 (high, arbitrary JS execution on opening a
malicious PDF).** A major bump, and the one item here with real API risk: six
files import it, including `pdf-viewer.tsx`, `annotation-layer.tsx` and
`lib/pdf-annotations.ts`. There is an existing `pdf-viewer-init.test.tsx`
covering worker-URL construction and polyfill installation, so the blast radius
is at least partly tested, but the worker entry point and the annotation-layer
API are the two places a v5→v6 change would land. This is the item most likely
to need its own PR.

**`express-rate-limit` (high, IPv4-mapped IPv6 bypass).** Depends on the
vulnerable `ip-address`. Worth confirming whether this is reachable at all —
`server/` uses `@fastify/rate-limit`, so an `express-rate-limit` in `web/`'s
tree is likely a transitive test-tool dependency rather than anything serving
traffic. Confirm before spending a bump on it.

### Bucket 3 — not reachable in this codebase

**`adm-zip` (2 high + 1 medium, and the medium has no patch at all).** All three
advisories are extraction-path bugs: the 4 GB allocation on a crafted archive,
the symlink-following overwrite in `extractAllTo`/`extractEntryTo`, and
CVE-2026-76845, whose fixed version is `none`.

Kady never extracts. The single use is `server/src/agent/notebook-zip.ts:38`,
`new AdmZip()` with no argument, then `addLocalFile`, `addFile`, `toBuffer` —
construction only, and the sandbox download path uses `archiver` instead. No
call site reads or extracts an archive, so no untrusted ZIP ever reaches the
vulnerable code.

That makes the 0.5.17 → 0.6.0 breaking bump elective rather than urgent, and it
is the right answer for the unpatched one, which cannot be fixed by upgrading
at all. Dismiss all three as "vulnerable code is not actually used", with the
call-site evidence in the dismissal comment, and bump on the next convenient
pass. **If anything ever adds an extract path, this reasoning expires** — worth
a comment in `notebook-zip.ts` saying so.

### The two open Dependabot PRs

PRs #5 and #6 have been open since 2026-09-02, predating PR #7 and everything
built since. They overlap each other (both bump `ip-address`, `postcss` and
`mermaid` in `web/`), neither covers the `next` critical because that advisory
is newer, and #6 proposes `@hono/node-server` 1.19.14 → **2.1.1**, a major bump
where 1.19.15 is the patched version.

Close both. They are strictly worse than a fresh `audit fix` and one of them
smuggles a major bump past a checklist that reads it as a security patch.
Dependabot will re-raise anything still outstanding.

## Code scanning triage

**183 of 195 alerts are one rule, `js/path-injection`, and are very likely a
sanitizer CodeQL cannot see.** They cluster in
`server/src/api/sandbox.ts` (49), `pdf-annotations-store.ts` (21),
`agent/skills.ts` (20), `agent/skills-install.ts` (17), `agent/agent-files.ts`
(16) and eleven more files.

This repo already knows the mechanism. `server/src/paths-contained.ts` says so
in its own docstring: CodeQL "does not treat a user-defined `isValidSessionId`
as a barrier, and reported these joins as path injection until the check moved
here." The sandbox has an equivalent and stronger guard —
`sandbox-fs.ts:51 safePath()`, which does a lexical `path.resolve` plus
`isWithin`, *and* canonicalizes the deepest existing ancestor with
`realpathSync` to defeat a symlink inside the sandbox. It is a better check than
the one CodeQL accepts; it just returns from a helper, and CodeQL's
`js/path-injection` does not follow the barrier across that return.

So the work is not to rewrite 183 sinks. It is, in order:

1. **Confirm the hypothesis on a sample** rather than assuming it. Take one
   alert from each of the top five files and trace the source-to-sink path by
   hand. Any sink that does not in fact pass through `safePath` or
   `containedIn` is a real finding and leaves this bucket immediately.
2. **Teach CodeQL the barrier.** A CodeQL model pack declaring `safePath` and
   `containedIn` as path sanitizers is the durable fix — it keeps working as new
   call sites are added, and a future sink that *forgets* the guard still
   alerts. There is no `.github/codeql*` config in the repo today, so this is
   new configuration rather than an edit.
3. **Only then** dismiss what remains, per-alert with the reason, not in bulk.

Bulk-dismissing 183 alerts without step 1 would be the worst outcome available:
it clears the dashboard and destroys the one signal that would catch a genuinely
unguarded join later.

The remaining 12 are individually reviewable and are the more interesting half:

| Rule | Where | First question |
|---|---|---|
| `js/insecure-randomness` ×7 | `web/src/components/file-preview-panel.tsx:1969-1992`, `chat-tabs-bar.tsx:420,430`, `app/page.tsx:749` | Are these ids/keys for React or DOM, or do any feed a token, filename or nonce? Only the latter is a real finding. |
| `js/reflected-xss` | `server/src/api/sessions.ts:809` | A server route reflecting a user value. Needs reading; this is the one alert whose default assumption should be "real until shown otherwise". |
| `js/polynomial-redos` ×2 | `server/src/projects.ts:103`, `agent/skills-fetch.ts:83` | Both on repeated `-`. Is the input length-capped upstream? |
| `js/resource-exhaustion` | `server/src/modal/store.ts:289` | Buffer allocated from a user-controlled size. |
| `js/incomplete-sanitization` | `server/src/api/credentials.ts:133` | Does not escape backslashes. In a credentials path, worth reading closely. |

## Implementation sequence

Split by risk, so a revert is cheap and a review is readable. Each is its own PR
unless it turns out to be trivial.

- [ ] Close Dependabot PRs #5 and #6 with a comment saying why (superseded,
      overlapping, and one carries an unrelated major bump).
- [ ] Bucket 1: `npm audit fix` in `server/`, verify, commit the lockfile alone.
- [ ] Bucket 1: `npm audit fix` in `web/`, verify, read the removed-package diff,
      commit the lockfile alone.
- [ ] Bucket 2: `next` + `eslint-config-next` to 16.3.3. Confirm `postcss` and
      `sharp` clear as a consequence rather than assuming it.
- [ ] Bucket 2: settle `express-rate-limit` reachability; bump or dismiss.
- [ ] Bucket 2: `pdfjs-dist` v5 → v6, on its own branch, with the PDF viewer
      exercised by hand as well as by `pdf-viewer-init.test.tsx`.
- [ ] Bucket 3: dismiss the three `adm-zip` alerts with call-site evidence; add
      the expiry comment to `notebook-zip.ts`.
- [ ] CodeQL: sample five path-injection alerts by hand and record the result.
- [ ] CodeQL: add the model pack for `safePath` and `containedIn`; re-run and
      record how many of the 183 clear.
- [ ] CodeQL: triage the remaining 12 individually, starting with the
      `js/reflected-xss` in `sessions.ts`.
- [ ] Append the outcome to `dev-docs/maintenance-log.md` — this is exactly the
      security/dependency work that log exists for.

## Guardrails

- Do not lower a coverage floor or raise a lint ratchet to make a bump pass
  (`AGENTS.md`). If a bump breaks a gate, that is the finding.
- Exact-pinned dependencies are pinned deliberately. `@earendil-works/*`,
  `skills`, `zod`, `undici`, `pi-subagents` and `pi-web-access` are the harness
  set; `next`/`react`/`react-dom`/`eslint-config-next` are pinned too. Moving
  any of them is a decision, not a side effect of `audit fix`.
- One `npm audit fix` per package per commit, lockfile only. A lockfile diff
  mixed with a source change is unreviewable.
- Never `npm audit fix --force` as a batch. Every entry it would move is in
  bucket 2 or 3 above and has been costed individually.
- Dismissals are per-alert with a written reason and a call-site reference.
  No bulk dismissal, and no dismissal of a rule class.
- MCP tools never return secrets; nothing here weakens the local trust boundary.

## Open questions

1. Should the `Rules1` CodeQL threshold tighten once the noise is gone? It
   currently gates on newly-introduced high alerts, which is the right shape,
   but the backlog makes any such block unreadable. Revisit after the count is
   real, not before.
2. Is a `.github/dependabot.yml` grouping change warranted? The two stale PRs
   went stale partly because a 5-update group PR is hard to review and easy to
   defer.
3. Does the `next` bump want to wait for 16.3.4? `npm audit` names 16.3.4 in its
   `--force` output while the advisory's first patched version is 16.3.3.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| Dependabot count is real | Every remaining open alert has been read; each is either fixed or dismissed with a reason |
| CodeQL count is real | The 183 are cleared by a barrier model, not by bulk dismissal, and the sample trace is recorded |
| No regression | `npm run verify -- all` green on both packages at each step |
| Decisions survive | Outcome appended to `dev-docs/maintenance-log.md` with evidence |
