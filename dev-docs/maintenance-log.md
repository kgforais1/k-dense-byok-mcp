# Maintenance Log

This document records ongoing maintenance, security triaging, dependency lifecycle, refactoring, and infrastructure tasks performed on the fork (`kgforais1/k-dense-byok-mcp`).

---

## Log Entries

### 2026-09-05: Closing Checklist Belongs in the Implementing PR
- **PR:** [#13](https://github.com/kgforais1/k-dense-byok-mcp/pull/13)
- **Category:** Governance & Documentation
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
