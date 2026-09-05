# Maintenance Log

This document records ongoing maintenance, security triaging, dependency lifecycle, refactoring, and infrastructure tasks performed on the fork (`kgforais1/k-dense-byok-mcp`).

---

## Log Entries

### 2026-09-05: Repository Agent Harness Archive
- **PR:** [#11](https://github.com/kgforais1/k-dense-byok-mcp/pull/11)
- **Category:** CI-Tooling & Verification
- **Summary:**
  - Archived `dev-docs/plans/2026-09-03-repo-agent-harness.md` to `dev-docs/plans/completed/` and updated its status to `Completed and merged in PR #11`, matching the workflow's "only after the implementing PR merges" rule.
  - Checked off the "Add repo harness" entry in `dev-docs/todo.md` and re-pointed the link at the archived plan + PR.
  - No code changes; this entry exists so the archive and the distilled decision land in the same PR per `docs/development/workflow.md`.
- **Evidence:** `docs:check` (link + manifest coverage) clean; `git log -1` on `origin/main` shows `de17efe` as the harness merge.
- **Follow-up:** None — CI Hardening (#8) and Harness (#11) are the two PRs currently listed under `[Unreleased]` in `CHANGELOG.md`; the next release bump rolls them up.

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
   - Upon completion and merge of the PR, update the plan status to `Status: Completed and merged in PR #...` and move it to `dev-docs/plans/completed/`.
3. **Changelog & Maintenance Logging:**
   - User-facing and structural additions/changes should be recorded under `## [Unreleased]` in `CHANGELOG.md`.
   - Internal refactoring, security triage, dependency maintenance, and CI adjustments should be logged in `dev-docs/maintenance-log.md`.
