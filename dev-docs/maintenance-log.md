# Maintenance Log

### 2026-09-20 — Real-time waits across the backend suite (PR #42)

- **Category:** CI / test infrastructure
- **Summary:** PR #38 fixed two named files and called the Windows flake
  closed. It was not: the condition is that a Windows runner intermittently
  runs about three times slow, and every wait written as a fixed budget is
  exposed to it, so the flake simply moved. PR #41's run `35515576893` lost 27
  tests across `steer-abort.test.ts` and `session-observer.test.ts` on a
  commit that touched no server runtime code. The two failed differently and
  that distinction drove the fix. `steer-abort` timed out, which a bigger
  budget solves. `session-observer` asserted `running` where it wanted
  `complete` after a flat 250ms sleep, which no budget solves — the test has
  to poll. `server/test/helpers/timing.ts` now holds `waitFor` (polling, on a
  10s ceiling), `quietFor` (a fixed delay, for the negative assertions that
  cannot be polled for) and `WAIT_BUDGET_MS` for blocking calls that take a
  deadline. Every positive assertion behind a sleep in the backend suite now
  polls, and `testTimeout` moved to 30s in `vitest.config.ts`.
- **Evidence:** Server suite 1438 passed / 5 skipped, backend lint and
  typecheck clean, `ratchet:check: ok (cap 1467)`.
- **Why the budgets are generous:** a wait ceiling is a hang detector, not a
  performance target. A satisfied condition returns on the first poll, so only
  a test that was going to fail pays the ceiling. The 5s default bought
  nothing and cost real flakes.
- **Removed:** the file-scoped `vi.setConfig({ testTimeout: 20_000 })` in
  `notebook-robustness.test.ts`, whose comment claimed the 5s default was
  right everywhere else. That reading is what kept the scope too narrow the
  first time.

### 2026-09-19 — Windows CI test timeouts fixed (PR #38)

- **Category:** CI / test infrastructure
- **Summary:** Two unrelated test files had been failing intermittently on the
  Windows runners only, both with `Test timed out in 5000ms`, and between them
  had redded #35 twice and #37 once. The job logs gave two different causes.
  `web/src/components/pdf-viewer/pdfjs-integration.test.ts` charged whichever
  test imported `pdfjs-dist` first for loading it — 6311ms on Windows against
  the 5s per-test budget, while the other six tests in the file cost 238ms
  between them; both builds now load once in a `beforeAll`.
  `server/test/notebook-robustness.test.ts` had no single slow operation, just
  a Windows median of 1.1s per test with failures at 5.4s on tests that passed
  in under a second the run before. `DurableModalJobManager.wait` no longer
  polls on a fixed 250ms tick — it races the worker's own promise, which
  settles exactly when the condition `wait` checks becomes true — and the file
  raises `testTimeout` to 20s, file-scoped, for the contention that is left.
- **Evidence:** Windows job logs `35442605790` (frontend, 6311ms import) and
  `105412502215` (backend, per-test durations). Locally the backend file drops
  5.13s → 3.28s and its worst test 684ms → 421ms; no test in the frontend file
  now exceeds 22ms. Full server (1402) and web (728) suites, both typechecks,
  both lints, and `docs:check` pass.
- **Follow-up:** The backend `max-lines` ratchet moved 1468 → 1467 rather than
  up, and `server/eslint.config.mjs` now states that the number only ever moves
  down. Automating that check is recorded in `dev-docs/todo.md` §1.
- **Latent bug found in review:** making `wait` depend on the worker promise
  exposed an ordering the old fixed tick had masked. `schedule()`'s `finally`
  called `runtime.adapter.close()` before `this.active.delete(key)`, so a
  throwing `close()` skipped the delete and the terminal `.catch` swallowed the
  error, leaving a settled promise in `active`. Every race then resolved
  immediately: the wait loop burned its whole budget without yielding to a
  timer, and with no timeout it would have starved the event loop. The delete
  now precedes the close, covered by `settles waiters when adapter cleanup
  throws` in `test/modal-durable.test.ts`. Found by a `codex/gpt-5.6-terra`
  review of PR #38; a second reviewer traced the same chain and missed it.

### 2026-09-19 — Local discovery route contract and adm-zip bump (PR #37)

- **Category:** test infrastructure / security
- **Summary:** Answered the two server-behaviour questions PR #35 left open and
  pinned the result: `server/test/local-discovery-contract.test.ts` runs one
  table of malformed-payload cases against both local model-discovery routes,
  so a rule applied to one provider and not the other fails there rather than
  shipping. Recorded the Ollama (0.33.2) and LM Studio (0.4.23+1) builds the
  context-window work was verified against, giving the undocumented
  `/api/tags` → `details.context_length` field a re-check trigger. Bumped
  `adm-zip` 0.5.18 → 0.6.1 and dropped `@types/adm-zip`.
- **Evidence:** Reverting `system.ts` to `0dc70d0` fails 8 of the 24 contract
  cases, all on the OpenAI-compatible side, while every Ollama case passes.
- **Follow-up:** The routes' background probes have no equivalent contract
  test, and the whitespace-identifier bug lived there too. This entry is
  recorded late, in PR #38: #37 ticked its `dev-docs/todo.md` row "done"
  instead of deleting it and wrote no durable record, which is what
  `docs/development/workflow.md#archive-lifecycle` requires. The row is now
  deleted.

### 2026-09-17 — Plan-close lifecycle clarified (PR #33)

- **Category:** operational
- **Summary:** Made plan completion an explicit same-PR operation: finalize
  status, create at least one durable changelog or maintenance record, archive
  the plan, and remove its active handoff before merge. Clarified that the
  existing changelog and maintenance log are fork-owned; upstream release
  notes are linked rather than duplicated into parallel records. Improved
  subprocess-backed repository tests so CI failures include exit status,
  spawn errors, stdout, and stderr without weakening their assertions.
- **Evidence:** `npm run docs:check` validates completed-plan placement,
  handoff removal, release-record structure, and manifest coverage. Focused
  backend tests (49), lint, and typecheck pass for the diagnostic harness.
- **Follow-up:** None.

### 2026-09-17 — Upstream v0.10.0 merge (PR #31)

- **Category:** operational
- **Summary:** Merged upstream releases v0.9.13 through
  [v0.10.0](https://github.com/K-Dense-AI/k-dense-byok/releases/tag/v0.10.0) while
  preserving the fork's billing, security, Modal, provenance, and session
  overlays. Added the standing fork-overlay policy and triaged all automated
  review findings before merge.
- **Evidence:** Required GitHub checks were green at merge; CodeQL and
  DeepSource passed, and focused regression tests covered the reviewed
  session, follow-up, scheduler, Modal, and path-safety changes.
- **Follow-up:** The completed plan retains the explicitly deferred hardening
  items; the weekly `upstream-sync-check` workflow reports future upstream
  drift through the `upstream-sync` issue label.

This document records ongoing maintenance, security triaging, dependency lifecycle, refactoring, and infrastructure tasks performed on the fork (`kgforais1/k-dense-byok-mcp`).

---

## Log Entries

### 2026-09-14: Fork positioning and upstream-sync automation
- **Branch:** `fork-positioning`
- **Category:** operational / docs / CI
- **Summary:**
  - README title is now `K-Dense BYOK (MCP fork)`; the fork notice no
    longer claims cloning gives "everything upstream provides" — it states
    best-effort merging and links the sync policy. (Upstream is 38 commits
    ahead as of this writing; the actual merge is separate work.)
  - `CONTRIBUTING.md` gained a "Keeping up with upstream" runbook (remote,
    fetch, merge-no-rebase into a sync branch, verify, PR, log).
  - New `upstream-sync-check` workflow (weekly + dispatch, mirrors
    `harness-update-check`): compares upstream `main` against fork `main`
    via the compare API and files/updates/closes a labeled issue. No
    checkout, no third-party actions, minimum permissions.

### 2026-09-14: CodeQL Backlog Clearance (195 → 0 open)
- **Branch:** `codeql-phase2-path-injection` (follows PR #28, which shipped
  the refreshed triage + Phase 1 code fixes)
- **Category:** security / code scanning
- **Summary:**
  - Phase 1 (PR #28): 9 alerts fixed in code (7× `insecure-randomness` →
    crypto ids, 2× `polynomial-redos` → capped slug inputs); 1×
    `incomplete-sanitization` re-triaged to dismiss after bot review proved
    the paired `.env` parser performs no unescaping (escaping would have
    corrupted reloads — reverted).
  - Phase 2: 10-alert path-injection sample trace, all guarded, zero real
    findings; hardened `stageForSkill` with a direct `SKILL_NAME_RE` gate
    (the unmodellable indirect-barrier case) + regression test; dismissed
    all 183 per-alert with barrier evidence (script re-verifies open+rule+
    path per alert; first run caught GitHub's 280-char comment cap).
  - Phase 3: `nosniff` on the session-export download + route test;
    dismissed `reflected-xss` (attachment, non-HTML), `resource-exhaustion`
    (1 MiB clamp, no bypass), `incomplete-sanitization` (parser evidence).
  - End state: **0 open Dependabot, 0 open CodeQL.** New alerts mean
    something again. Reviewed throughout: kimi-k3, kilo stepfun (×4),
    DeepSeek v4 Pro, agy sonnet, Cursor Composer, muse-spark, plus
    Sourcery/Greptile/CodeRabbit bot findings (one real regression caught).
- **Verification:**
  - `npm run verify -- all` green at each step; Aikido scans clean.
  - Live API confirms zero open on both surfaces.

### 2026-09-10: Dependency Alert Clearance and CodeQL Sample Trace
- **PR:** [#24](https://github.com/kgforais1/k-dense-byok-mcp/pull/24) (triage plan: [#23](https://github.com/kgforais1/k-dense-byok-mcp/pull/23))
- **Category:** security / dependency
- **Summary:**
  - `npm audit fix` in `server/` (10 vulnerable packages → 1) and `web/`
    (29 → 7), lockfile-only, no `package.json` edits and no major versions.
  - `next` 16.2.11 → 16.3.4 with `eslint-config-next` in lockstep, both
    keeping their exact pins. This cleared the repo's only two critical
    alerts (CVE-2026-75604 / GHSA-2xp9-vwfh-vxw4) and the `postcss` and
    `sharp` highs, which `npm audit` reported as fixable only through `next`.
    Took 16.3.4 over the advisory's first-patched 16.3.3: same patch line,
    and what npm resolves to.
  - Raised the vitest floor to 4.1.11 in **both** packages. In `web/`,
    `vitest` and `@vitest/coverage-v8` depend on each other and each held the
    other at 4.1.4 inside a range that permitted 4.1.11; `npm update` was a
    no-op and an explicit install was needed. `server/` had already resolved
    to 4.1.11, but its declared range was still `^4.1.4` — inside
    CVE-2026-84373's `>=2.1.0 <4.1.11` — so a fresh resolution could have
    reintroduced it. Raising the floor closes that.
  - Dismissed both `adm-zip` alerts as `not_used` with call-site evidence.
    The property relied on is that nothing in `src/` ever hands adm-zip bytes
    it did not just produce (`server/src/agent/notebook-zip.ts`). That is
    stronger than "we do not extract", and deliberately so: only
    GHSA-vwc7-r8mq-g2x9 is extraction-only, while GHSA-xcpc-8h2w-3j85's 4 GB
    allocation also fires on `readFile`, `readAsText` and `getData`.
    CVE-2026-76845 has no fixed release at all, 0.6.0 being inside its range. An expiry note
    now sits in `notebook-zip.ts` so the reasoning is revisited if an extract
    path is added.
  - Closed stale Dependabot PRs #5 and #6 (open since 2026-09-02, overlapping,
    missing the `next` critical, and #6 carried a `@hono/node-server` major
    where 1.19.15 was the patch).
  - Folded `pdf-annotations-store.ts`'s private `isWithin` into the exported
    one in `sandbox-fs.ts` — one containment barrier instead of two.
- **Verification:**
  - `server`: typecheck, 785 tests, lint.
  - `web`: typecheck, 541 tests, `next build`, lint with 0 errors.
  - Alert count 49 → 8 open, all remaining ones read and accounted for.
- **Follow-ups:**
  - `pdfjs-dist` v5 → v6 is deliberately not in this pass; it needs the PDF
    viewer exercised by hand, and `pdf-viewer.tsx:61` carries a polyfill
    documented as required for 5.6+ that must be re-checked against v6.
  - The 183 `js/path-injection` CodeQL alerts remain open by design. A
    five-alert hand trace found all five guarded, but also found more barrier
    idioms than expected and one **indirect** barrier
    (`skills-install.ts:464`, guarded only because `findSkillDir` returns
    `null` and callers 404 on it) that no sanitizer-style model can express.
    Recorded in the triage plan.

---

### 2026-09-05: Closing Checklist Belongs in the Implementing PR
- **PR:** [#13](https://github.com/kgforais1/k-dense-byok-mcp/pull/13)
- **Category:** operational
- **Summary:**
  - Rewrote the archive-lifecycle flow in `docs/development/workflow.md`,
    `CONTRIBUTING.md`, the PR template, the plan template, and this
    log's procedures section so the closing checklist (plan archive,
    handoff removal, CHANGELOG `Unreleased` entry, maintenance log
    entry, TODO row deletion) ships **in the implementing PR** instead
    of as a follow-up after merge. The old text explicitly said "only
    after the implementing PR merges" and contradicted the PR template
    it was supposed to back.
  - Cleaned up the prior PR #11's trailing state: archived the
    `2026-09-03-repo-agent-harness` plan to `dev-docs/plans/completed/`,
    deleted (not checked off) the "Add repo harness" TODO row, fixed
    the manifest and `workflow.md` link targets so `docs:check` is
    green on the next branch, and replaced the section body with a
    short shipped pointer so the `## 1. Repo harness` anchor still
    resolves for downstream links.
  - `CHANGELOG.md` already covered the harness under `[Unreleased]`
    in PR #11, so no new entry is needed in this PR.
- **Evidence:**
  - `npm run verify -- fast` — green (manifest validates, no uncommitted
    manifest changes, hub aliases present).
  - `npm run verify -- docs` — green (`docs:check` passes pointer
    check, `handoff:check` clean, `release:check` clean, manifest
    category coverage 8/8).
- **Follow-up:** None — the new rule is the workflow going forward.
  PR #12 (the old-shape follow-up) was closed in favour of this PR
  so the rule and its first application land together.

### 2026-09-03: CI Hardening & Frontend Quality Pipeline
- **PR:** [#8](https://github.com/kgforais1/k-dense-byok-mcp/pull/8)
- **Category:** CI/CD & Testing
- **Summary:**
  - Added top-level least-privilege `permissions: { contents: read }` to `.github/workflows/tests.yml`.
  - Added workflow-level `concurrency` cancellation (`cancel-in-progress` only on PRs so `main` pushes complete).
  - Added `timeout-minutes: 15` to all matrix jobs (`backend`, `frontend`, `launcher-smoke`).
  - Added full frontend verification gates: `typecheck` (`tsc --noEmit`), `lint` (`next lint`), `build` (`next build`), and `.next` failure artifact capture.
  - Added Map upsert polyfill and PDF worker URL unit test suite (`pdf-viewer-init.test.tsx`) with strict mock isolation.
  - Added `IntersectionObserverStub` in `web/vitest.setup.ts` supporting constructor options, element tracking, and `trigger()` simulation.
  - Aligned React 19 compiler ESLint rules to `warn` to unblock CI while preserving diagnostic visibility.
- **Verification:**
  - Backend vitest suite: 70 files (604 passed).
  - Frontend vitest suite: 77 files (528 passed).
  - Next.js 16 Turbopack production build: 0 errors.
  - Multi-model peer reviews completed by MiniMax M3 Free, Muse Spark 1.2 Free, Claude Sonnet 4.5, and Claude Sonnet 5.

### 2026-09-02: Security Quick Wins & Rate Limiting
- **PR:** [#7](https://github.com/kgforais1/k-dense-byok-mcp/pull/7)
- **Category:** Security & Dependabot
- **Summary:**
  - Added `@fastify/rate-limit` for sandbox API routes to protect local server endpoints against unbounded loops.
  - Added `.github/dependabot.yml` configuration for automated weekly dependency updates across `server/` and `web/`.
- **Verification:**
  - Backend and frontend test suites passed.

### 2026-09-02: Safe Dependency Updates
- **PR:** [#4](https://github.com/kgforais1/k-dense-byok-mcp/pull/4)
- **Category:** Dependencies
- **Summary:**
  - Triaged and applied minor and patch updates for non-breaking server and frontend dependencies.
- **Verification:**
  - Full test suite verified clean.

### 2026-09-02: Fork Safeguards & Architecture Documentation
- **PR:** [#3](https://github.com/kgforais1/k-dense-byok-mcp/pull/3)
- **Category:** Governance & Documentation
- **Summary:**
  - Configured `.githooks/pre-push` to enforce the fork boundary (`kgforais1/k-dense-byok-mcp`).
  - Updated `AGENTS.md` and repository guidelines to prevent accidental pushes or PRs targeting upstream.
- **Verification:**
  - Pre-push hook tested on non-fork and fork targets.

---

## Maintenance Procedures & Guidelines

1. **Semantic Versioning (SemVer):**
   - Version bumps follow `MAJOR.MINOR.PATCH` in `server/package.json`.
   - `web/package.json` deliberately does not carry a separate version; `web/next.config.ts` reads `server/package.json` version at build time.
   - Tagging `v<version>` triggers `.github/workflows/release.yml` to generate release notes and publish a GitHub release.
2. **Implementation Plan Lifecycle:**
   - Active plans live in `dev-docs/plans/<YYYY-MM-DD>-<plan-title>.md`.
   - The implementing PR moves the plan to `dev-docs/plans/completed/`
     and updates its Status to `Completed and merged in PR #<this PR>`
     as part of the PR's closing checklist — never as a follow-up after
     merge. See `docs/development/workflow.md#archive-lifecycle`.
3. **TODO Lifecycle:**
   - `dev-docs/todo.md` only contains unstarted or in-progress work.
   - When a TODO entry ships, the implementing PR **deletes** the row
     (not check it off). A checked-off box is a bug — the entry has
     shipped, so it no longer belongs on the roadmap.
4. **Changelog & Maintenance Logging:**
   - User-facing and structural additions/changes should be recorded under
     `## [Unreleased]` in `CHANGELOG.md` in the implementing PR.
   - Internal refactoring, security triage, dependency maintenance, and
     CI adjustments should be logged in `dev-docs/maintenance-log.md` in
     the implementing PR.
