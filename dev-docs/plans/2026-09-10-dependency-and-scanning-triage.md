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
malicious PDF).** A major bump, but a narrower one than the file count suggests.
Exactly one module imports the library: `pdf-viewer.tsx`, which dynamically
imports it at `:145` and takes `PDFDocumentProxy`/`PDFPageProxy` types from it.
`annotation-layer.tsx` consumes a viewport object handed to it and never touches
`pdfjs-dist`; `lib/pdf-annotations.ts` deals in PDF concepts, not the library.

Two things to watch, both in that one file. The worker URL is built from
`pdfjs-dist/build/pdf.worker.min.mjs` (`:125`), a path that can move across a
major. And `:61` documents a Map-upsert polyfill as "required before loading
`pdfjs-dist` 5.6+" — a version-coupled workaround that should be re-checked
against v6 rather than carried forward blindly. `pdf-viewer-init.test.tsx`
covers both, which is why this is a contained change rather than a risky one.

**`express-rate-limit` (high, IPv4-mapped IPv6 bypass) — belongs in bucket 1,
not here.** It is flagged only because it depends on the vulnerable
`ip-address`, which plain `npm audit fix` resolves, so the web `audit fix` step
will clear it before any decision is needed. Nothing serves traffic through it
either: `server/` rate-limits with `@fastify/rate-limit`. Left recorded here
only so the next reader does not re-open the question.

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

Note that 0.6.0 does not fix CVE-2026-76845 either — the advisory range is
"0.5.9 through 0.6.0", and there is no fixed release. So the 0.5.17 → 0.6.0
breaking bump is elective rather than urgent, and it would clear two of the
three advisories while leaving the symlink one open at the newest version
available. Anyone who later adds an extract path inherits an unpatched
dependency, not merely an unfixed alert. Dismiss all three as "vulnerable code is not actually used", with the
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

**183 of 195 alerts are one rule, `js/path-injection`, and are very likely
sanitizers CodeQL cannot see.** They cluster in
`server/src/api/sandbox.ts` (49), `pdf-annotations-store.ts` (21),
`agent/skills.ts` (20), `agent/skills-install.ts` (17), `agent/agent-files.ts`
(16) and eleven more files.

This repo already knows the mechanism. `server/src/paths-contained.ts` says so
in its own docstring: CodeQL "does not treat a user-defined `isValidSessionId`
as a barrier, and reported these joins as path injection until the check moved
here."

**But there is not one barrier here, there are four**, and they are not equally
convincing. Any plan that names only the first will leave most of the alerts
open and mislabel the rest:

| Idiom | Where | Strength |
|---|---|---|
| `safePath()` — lexical `resolve` + `isWithin`, then `realpathSync` on the deepest existing ancestor to defeat a symlink | `sandbox-fs.ts:51`, used by `api/sandbox.ts` | Strongest. Beats what CodeQL accepts inline. |
| `containedIn()` — `resolve` + prefix check, refuses absolute names | `paths-contained.ts`, 4 callers | Strong, and written specifically to be the form CodeQL follows. |
| A private `isWithin()` plus a `realpathSync` re-check | `pdf-annotations-store.ts:72,92,104` | Sound, but a **second copy** of `sandbox-fs.ts:25`'s exported `isWithin`. |
| A name regex — `SKILL_NAME_RE`, `PI_SKILL_NAME_RE`, `AGENT_NAME_RE` | `skills.ts:338`, `skills-install.ts:58`, `agent-files.ts:43` | Sound *as validation* — the character classes exclude `/`, `\` and `.` — but it is a validity predicate, not a containment proof. |

That last row matters most. A regex validator is exactly the barrier class the
`paths-contained.ts` docstring records CodeQL rejecting. So roughly 53 alerts
across `skills.ts`, `skills-install.ts` and `agent-files.ts` will **not** clear
from a model pack that names only `safePath` and `containedIn`, and they are not
real findings either — the regex does hold. They need either their own model
entry or a containment check moved to the sink, the same move
`paths-contained.ts` already made once.

So the work is, in order:

1. **Confirm the hypothesis on a sample** rather than assuming it. Take one
   alert from each of the top five files and trace the source-to-sink path by
   hand. The test is "does *some* barrier stand between the request value and
   the join", not "does it call one of two named functions" — a sink guarded
   only by `AGENT_NAME_RE` is guarded. A sink with no barrier at all is a real
   finding and leaves this bucket immediately.
2. **Teach CodeQL the barriers — all four.** A model pack is the durable fix: it
   keeps working as call sites are added, and a sink that *forgets* every guard
   still alerts. There is no `.github/codeql*` config in the repo today, so this
   is new configuration rather than an edit. Expect the regex validators to be
   the awkward ones to model, and prefer moving those sinks onto `containedIn`
   over modelling a regex as a path sanitizer, which is a weaker claim to encode
   permanently.
3. **Fold the duplicate `isWithin` away.** `pdf-annotations-store.ts:72`
   reimplements `sandbox-fs.ts:25`. One of them is enough, and one barrier to
   model is better than two.
4. **Only then** dismiss what remains, per-alert with the reason, not in bulk.

Bulk-dismissing 183 alerts without step 1 would be the worst outcome available:
it clears the dashboard and destroys the one signal that would catch a genuinely
unguarded join later.

The remaining 12 are individually reviewable and are the more interesting half:

| Rule | Where | First question |
|---|---|---|
| `js/insecure-randomness` ×7 | `web/src/components/file-preview-panel.tsx:1969-1992`, `chat-tabs-bar.tsx:420,430`, `app/page.tsx:749` | Are these ids/keys for React or DOM, or do any feed a token, filename or nonce? Only the latter is a real finding. |
| `js/reflected-xss` | `server/src/api/sessions.ts:809` | A server route reflecting a user value. Needs reading; this is the one alert whose default assumption should be "real until shown otherwise". |
| `js/polynomial-redos` ×2 | `server/src/projects.ts:103`, `agent/skills-fetch.ts:83` | Both on repeated `-`. Not capped: `mintProjectId` runs `.replace(/[^a-z0-9]+/g, "-")` on the raw `name` and only calls `.slice(0, 32)` afterwards, so the regex sees the full input. Cap first, or bound the name at the route. |
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
- [ ] CodeQL: fold `pdf-annotations-store.ts`'s private `isWithin` into the
      exported one in `sandbox-fs.ts`.
- [ ] CodeQL: add the model pack covering all the barriers that survive that
      fold; re-run and record how many of the 183 clear. Expect the
      regex-guarded sinks in `skills*.ts` and `agent-files.ts` to need their own
      answer.
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
