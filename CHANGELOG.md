# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **CI Hardening & Quality Gates** ([#8](https://github.com/kgforais1/k-dense-byok-mcp/pull/8)):
  - Top-level least-privilege token permissions (`contents: read`) in GitHub Actions workflow.
  - Workflow concurrency with PR cancellation (`cancel-in-progress: ${{ github.event_name == 'pull_request' }}`).
  - Job timeout limits (15m) and build failure artifact capture (`web/.next/`).
  - Full frontend verification pipeline: `typecheck` (`tsc --noEmit`), `lint` (`next lint`), `build` (`next build`), and `test` (`vitest`).
  - Expanded `paths-ignore` for documentation and markdown file changes (`docs/**`, `dev-docs/**`, `**/*.md`).
- **PDF Viewer Initialization Unit Tests & Polyfills** ([#8](https://github.com/kgforais1/k-dense-byok-mcp/pull/8)):
  - Exported and documented `installMapUpsertPolyfill`, `MAP_UPSERT_POLYFILL_SRC`, and `buildWorkerUrl`.
  - Added strict HTTP status checking (`if (!r.ok) throw`) to prevent HTML error pages from being wrapped in worker Blobs.
  - Added unit tests covering Map upsert idempotency, native preservation, prepended worker polyfills, and network/404 fallbacks.
  - Added `IntersectionObserverStub` in `web/vitest.setup.ts` supporting constructor options, element tracking (`observe`/`unobserve`/`disconnect`), and test event simulation (`trigger()`).
- **Security & Rate Limiting** ([#7](https://github.com/kgforais1/k-dense-byok-mcp/pull/7)):
  - Added `@fastify/rate-limit` for sandbox routes.
  - Added Dependabot configuration (`.github/dependabot.yml`) for `server/` and `web/` packages.
- **Fork Safety & Architecture Documentation** ([#3](https://github.com/kgforais1/k-dense-byok-mcp/pull/3)):
  - Pre-push git hook (`.githooks/pre-push`) guarding against accidental upstream pushes.
  - Added fork policies and architecture guidelines in `AGENTS.md` and `dev-docs/`.

### Changed
- Standardized `npm ci` across both backend and frontend GitHub Actions jobs for deterministic dependency installation.
- Standardized `"typecheck": "tsc --noEmit"` script in `web/package.json`.
- Configured experimental React 19 compiler ESLint rules to `warn` in Next.js 16 flat config for progressive codebase modernization.
- Reorganized planning artifacts: moved plans into `dev-docs/plans/` (with completed plans archived in `dev-docs/plans/completed/`) and tracked roadmap in `dev-docs/todo.md`.

## [0.9.12] - 2026-09-02

### Added
- Tagged release baseline for K-Dense BYOK fork.
