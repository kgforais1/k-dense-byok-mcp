---
title: "CodeQL triage and remediation — 195 open alerts on main"
status: accepted
created: 2026-09-13
branch: codeql-triage-plan
---

# CodeQL Triage and Remediation Implementation Plan

**Status:** Accepted — Phase 1 implemented on this branch (PR #28).

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. See
> `docs/development/workflow.md#archive-lifecycle`.

**Goal:** Get the CodeQL backlog from 195 open alerts to a state where a new
alert means something — each fixed in code or dismissed per-alert with a
written reason — and record the Dependabot zero so the next reader does not
re-triage it.

## Why this work

The `dev-docs/todo.md` security section quoted a 2026-09-06 snapshot (41
Dependabot, 207 CodeQL) that is now wrong on both surfaces, and the earlier
[triage plan](2026-09-10-dependency-and-scanning-triage.md) predates PR #27
(pdfjs 6) plus a wave of Dependabot fixes. The `Rules1` branch ruleset gates
merges on newly-introduced CodeQL highs/errors, so the 184 standing errors
are pure noise that would bury a real new finding in the same file. The
defect is the unreadable signal, not any single alert.

## What is actually there

Measured 2026-09-13 on `main` at `6ad96d1` (PR #27 merge):

| Surface | Open | Shape |
|---|---|---|
| Dependabot | **0** | All fixed since 09-06 (incl. `sharp` high, `next` critical ×2, `vitest`, `fastify`/`qs`, `browserslist`, `nanoid`) |
| CodeQL | **195** (184 error, 11 warning) | 183 `js/path-injection` (error), 7 `js/insecure-randomness`, 2 `js/polynomial-redos`, 1 `js/resource-exhaustion`, 1 `js/incomplete-sanitization` (all warning), 1 `js/reflected-xss` (error) |

Evidence: `gh api repos/kgforais1/k-dense-byok-mcp/dependabot/alerts?state=open`
→ `[]`; `code-scanning/alerts?state=open` grouped by rule and file (deduped
by alert number — the raw paginated output double-counts).

`js/path-injection` by file: `api/sandbox.ts` 49,
`pdf-annotations-store.ts` 21, `agent/skills.ts` 20,
`agent/skills-install.ts` 17, `agent/agent-files.ts` 16,
`agent/skills-sync.ts` 12, `modal/store.ts` 9, `projects.ts` 8,
`sandbox-seed.ts` 7, `agent/skills-fetch.ts` 6, `latex/compile.ts` 6,
`cost/ledger.ts` 4, `provenance/store.ts` 2, `agent/notebook-store.ts` 2,
plus singletons (`sandbox-fs.ts:60` self-hit, `api/sessions.ts` is the XSS
one, `agent/session-registry.ts`, `agent/notebook-zip.ts`,
`agent/methods-draft.ts`).

The 12 non-path-injection alerts, each read on current `main`:

| Rule | Location | Verdict |
|---|---|---|
| `insecure-randomness` ×7 | sources `web/src/app/page.tsx:83` (`makeTabId`) + `web/src/lib/pdf-annotations.ts:222` (`newAnnotationId`); sinks `file-preview-panel.tsx` ×4, `chat-tabs-bar.tsx` ×2, `page.tsx` ×1 | **False positive class.** Client tab/draft ids, not tokens/nonces. Fix cheaply anyway (two source edits clear all 7) |
| `polynomial-redos` ×2 | `agent/skills-fetch.ts:83` (slug), `projects.ts:103` (`mintProjectId`) — `.replace(/[^a-z0-9]+/g, "-")` runs on the full input, `.slice(0, 32)` after | **Real but low.** Unbounded input into a repeated-class regex. Cap input length before the replace |
| `resource-exhaustion` ×1 | `modal/store.ts:289` `Buffer.alloc(available)` | **Likely dismiss.** `available ≤ safeLimit ≤ MAX_LOG_READ_BYTES` (1 MiB; constant at `store.ts:13`, `safeLimit` at `store.ts:280`), floored at 0. Verify no path bypasses `safeLimit`, then dismiss with clamp evidence |
| `incomplete-sanitization` ×1 | `api/credentials.ts:133` — escapes `"` but not `\` | **Dismiss (false positive for this sink).** Re-triaged 2026-09-13 after Sourcery/Greptile flagged the first fix: the sole reader of this file is `applyEnvFile` (`env-file.mjs`), which strips quotes via `/^"([^"]*)"/` and performs *no unescaping* — a `\` is literal, so a trailing backslash cannot swallow the closing quote. Escaping `\` in the writer (the first attempt) *broke* the round-trip by doubling backslashes on reload; reverted, with a true writer→loader round-trip test locking the contract. Nothing bash-sources `.env` anymore (only `start.mjs` + `server/src/env.ts` via `applyEnvFile`). Pre-existing limitation, out of scope: embedded `"` truncates in the parser before and after; credential values never contain quotes in practice |
| `reflected-xss` ×1 | `api/sessions.ts:809` — export returns `body` built from session file + params (`:801-802`), served as `text/markdown` / `text/x-shellscript` with `Content-Disposition: attachment` | **Likely false positive / by-design export.** A file download, not inline HTML. Verify no inline-render path, consider `X-Content-Type-Options: nosniff`, then dismiss with reason or add the header |

Path-injection barrier inventory (superset of the 09-10 plan — the `isWithin`
fold it called for is **done**: `pdf-annotations-store.ts:12` imports
`isWithin` from `sandbox-fs.ts`):

- `safePath()` (`sandbox-fs.ts:51`) — lexical `resolve` + `isWithin`, then
  `realpathSync` on the deepest existing ancestor. Strongest; covers
  `api/sandbox.ts`.
- `containedIn()` (`paths-contained.ts`) — `resolve` + prefix check, refuses
  absolute names. Written to be the form CodeQL follows.
- `resolvePdf()` (`pdf-annotations-store.ts:73`) — absolute-path refusal +
  `isWithin` + realpath re-check. Sound, now shares the canonical `isWithin`.
- Name regexes — `SKILL_NAME_RE`, `PI_SKILL_NAME_RE`, `AGENT_NAME_RE`,
  plus `PROJECT_ID_RE`/`JOB_ID_RE` found in the 09-10 sample. Sound as
  validators (no `/` or `\` admitted; `.`/`..` refused by the anchored first
  character), but a validity predicate, not a containment proof — exactly the
  barrier class CodeQL does not model. The 09-10 sample trace (5 alerts, all
  guarded, incl. the indirect `findSkillDir → null → 404` case in
  `skills-install.ts:464`) holds; spot-checks on current `main`
  (`sandbox.ts:88-94` tmp derived from a `safePath` target;
  `pdf-annotations-store.ts:73-99`; `skills.ts:180-184` scoped-root joins)
  agree.

## Design decisions

- **Fix the cheap real ones in code; model the systemic ones; dismiss only
  with per-alert reasons.** No bulk dismissal of the 183 — that clears the
  dashboard and destroys the signal that catches a genuinely unguarded join.
- **Prefer moving regex-guarded sinks onto `containedIn`/`safePath` over
  modelling a regex as a sanitizer**, where the call shape allows it. A
  direct containment check is both safer code and a tractable CodeQL model;
  the indirect `returns-null-and-caller-404s` idiom cannot be modelled at
  all.
- **Dependabot needs no work** beyond recording the zero. If new alerts
  appear, they arrive as their own triage, not as this plan.
- Out of scope: tightening the `Rules1` threshold (revisit after the count
  is real, per the 09-10 open question), semgrep invariants, coverage/lint
  ratchets.

## Proposed information architecture / file changes

```text
dev-docs/todo.md                          # counts refreshed (this branch)
dev-docs/plans/2026-09-13-codeql-triage-remediation.md  # this plan
web/src/app/page.tsx                      # crypto id instead of Math.random (Phase 1)
web/src/lib/pdf-annotations.ts            # same crypto-id fix (Phase 1, unconditional)
server/src/projects.ts                    # bound input before slug regex (Phase 1)
server/src/agent/skills-fetch.ts          # same (Phase 1)
server/src/api/credentials.ts + test      # backslash escaping (Phase 1)
.github/codeql* (new)                     # model pack for safePath/containedIn/resolvePdf (Phase 2)
<path-injection sinks>                    # move regex-guarded sinks onto containedIn where shaped right (Phase 2)
server/src/api/sessions.ts                # nosniff header if warranted (Phase 3)
dev-docs/maintenance-log.md               # outcome entry (Phase 4)
```

## Implementation sequence

### Phase 0 — Counts and triage record (this branch)

- [x] Refresh `dev-docs/todo.md` §2 (Dependabot 0, CodeQL 195 = 184/11).
- [x] Write this plan with per-alert verdicts and file/line evidence.
- [ ] Review of triage + plan (opencode/nvidia kimi-k3), then commit.

**Exit criteria:** `npm run docs:check` green; reviewer verdict recorded.

### Phase 1 — Cheap real fixes (one PR)

Done 2026-09-13 on `codeql-triage-plan` (commit below): `makeTabId` moved to
`web/src/lib/tab-ids.ts` (crypto-first, no `Math.random`), same shape for
`newAnnotationId` (monotonic-counter final fallback — Sourcery caught a
same-millisecond collision in the first cut); slug inputs capped before the
replace (`projects.ts`, `skills-fetch.ts`); `persistEnv` left unescaped for
`\` after bot review proved the paired parser (`applyEnvFile`) performs no
unescaping, so escaping would corrupt on reload — re-triaged to dismiss with
a writer→loader round-trip test locking the contract. Tests:
`tab-ids.test.ts`, `codeql-phase1.test.ts` (deterministic cap-equivalence,
`.env` round-trip via the real loader); existing `pdf-annotations.test.ts`
uniqueness still green. `npm run verify -- all` green, Aikido clean,
`Math.random` gone from first-party `web/src`/`server/src`.

- [x] `insecure-randomness` ×7: replace the `Math.random` fallbacks with
  `crypto.randomUUID()` (or `getRandomValues`) at `web/src/app/page.tsx:83`
  (`makeTabId`) and unconditionally at `web/src/lib/pdf-annotations.ts:222`
  (`newAnnotationId`, same pattern). Test: `makeTabId()` and
  `newAnnotationId()` return non-empty unique ids. Re-run CodeQL,
  expect −7.
- [x] `polynomial-redos` ×2: bound the input before the slug replace
  (`slice` first, then replace, then trim/slice to final length) in
  `mintProjectId` and `cacheKeyForSource`. Deterministic cap-equivalence test
  (no wall-clock assertions — those flake on busy CI).
- [x] `incomplete-sanitization` ×1: re-triaged to **dismiss** — false positive
  for this sink (see table). Writer→loader round-trip test added instead, so
  the contract cannot regress silently.
- [x] `npm run verify -- all` green on both packages.

**Exit criteria:** 9 alerts gone by code change, 1 re-triaged to dismiss;
CodeQL shows 186 once re-scanned (9 fixed; the sanitization dismissal lands
with the per-alert dismissal pass in Phase 2).

### Phase 2 — Path-injection: verify, then model (one PR, possibly two)
- [ ] Sample-verify these 10 alerts on current `main` (numbers are GitHub
  code-scanning alert IDs; record source→sink→barrier per alert). Any sink
  with no barrier leaves this bucket immediately as a real finding:
  - 147 `api/sandbox.ts:820` (expect `safePath`)
  - 188 `pdf-annotations-store.ts:295` (expect `resolvePdf`)
  - 79 `agent/skills.ts:371` (expect name regex)
  - 74 `agent/skills-install.ts:464` (the indirect `findSkillDir → null → 404`
    idiom CodeQL cannot model — the case the migration strategy is designed for)
  - 16 `agent/agent-files.ts:336` (expect name regex)
  - 85 `agent/skills-sync.ts:355`
  - 167 `modal/store.ts:286` (expect `assertJobId → JOB_ID_RE`)
  - 195 `projects.ts:336` (expect `validateId → PROJECT_ID_RE`)
  - 153 `latex/compile.ts:117`
  - 148 `cost/ledger.ts:315`
- [ ] Where the shape allows, move regex-guarded sinks onto `containedIn`
  / `safePath` (converts unmodellable indirect barriers into direct ones).
  Each migrated sink keeps a regression test asserting the same
  reject/accept behavior (valid names still pass, traversal still 403/404).
- [ ] Add a CodeQL model pack (new `.github/codeql*` config) naming the
  surviving barriers — `safePath`, `containedIn`, `resolvePdf`, and whichever
  name-regexes survive the move. Re-run CodeQL and record how many of the
  183 clear. Expect the regex-guarded `skills*.ts` / `agent-files.ts` sinks
  to need their own answer.
- [ ] Dismiss whatever remains per-alert with barrier + call-site evidence.

**Exit criteria:** 183 cleared by model or dismissed per-alert with reason;
sample trace recorded in the plan/PR.

### Phase 3 — The two judgement calls (same or separate PR)

- [ ] `resource-exhaustion`: confirm every `Buffer.alloc` size in
  `modal/store.ts` flows through `safeLimit`; dismiss with clamp evidence,
  or harden further if a path bypasses it.
- [ ] `reflected-xss`: confirm the export is always `attachment` +
  non-HTML type with no inline-render path; add
  `X-Content-Type-Options: nosniff` if missing; dismiss with reason or fix.

**Exit criteria:** 2 resolved with written reasoning.

### Phase 4 — Close out

- [ ] CodeQL open count re-measured; every remaining alert (ideally zero)
  has a reason.
- [ ] Append outcome to `dev-docs/maintenance-log.md` (the security log
  that file exists for).
- [ ] Move this plan to `dev-docs/plans/completed/` in the closing PR.

## Guardrails

- Dismissals are per-alert with a written reason and call-site reference.
  No bulk dismissal, no rule-class dismissal.
- Do not lower a coverage floor or raise a lint ratchet to make a fix pass
  (`AGENTS.md`). If a fix breaks a gate, that is the finding.
- Exact-pinned dependencies are untouched by this plan (Dependabot is at
  zero; no bumps here).
- MCP tools never return secrets; nothing here weakens the local trust
  boundary.
- Aikido scan on changed files before commit (repo skill), rescan after
  fixes until clean.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| Counts are real | `todo.md` §2 matches `gh api …/dependabot/alerts?state=open` (`[]`) and `…/code-scanning/alerts?state=open` (195, 183 path-injection) |
| Cheap fixes land | −10 by code change (7 randomness, 2 redos, 1 sanitization), tests added |
| Path-injection resolved durably | Cleared by barrier model, not bulk dismissal; sample trace recorded |
| Judgement calls written down | resource-exhaustion + reflected-xss each have a verdict with evidence |
| No regression | `npm run verify -- all` green at each step |
| Decisions survive | Outcome in `dev-docs/maintenance-log.md`; plan archived per lifecycle |
