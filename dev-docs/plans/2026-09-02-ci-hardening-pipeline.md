# CI Hardening and Frontend Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build out robust CI verification gates in GitHub Actions for the Next.js frontend (typecheck, lint, production build), harden workflow permissions, add concurrency and timeouts, and establish unit tests for viewer initialization and polyfill safety.

**Architecture:** Extend `.github/workflows/tests.yml` with top-level least-privilege permissions (`contents: read`), workflow-level `concurrency` cancellation, per-job `timeout-minutes`, `paths-ignore` for doc-only pushes, and full frontend `typecheck`, `lint`, and `build` (`next build`) gates with build artifact upload on failure. Standardize the `typecheck` script in `web/package.json`, export and unit-test `pdf-viewer` worker URL resolution and polyfills with clean spy/lifecycle isolation (avoiding `global.URL` prototype disruption), and stub missing browser globals (`IntersectionObserver`, `CanvasRenderingContext2D`) in `vitest.setup.ts`.

**Tech Stack:** GitHub Actions, Next.js 16 (Turbopack), TypeScript 5, React 19, Vitest, Node 22.

## Global Constraints

- Never open PRs against or push to the upstream repo; all work targets `kgforais1/k-dense-byok-mcp`.
- Maintain cross-platform CI matrix support (Ubuntu, Windows, macOS).
- Do not bypass pre-push hooks.
- Pi harness dependencies (`@earendil-works/*`, `pi-subagents`, `pi-web-access`, `skills`) must remain pinned and ignored by automatic Dependabot upgrades.

---

### Task 1: Standardize Frontend Typecheck Script in `web/package.json`

**Files:**
- Modify: `web/package.json:4-13`

**Interfaces:**
- Consumes: TypeScript compiler in `web/node_modules/.bin/tsc`.
- Produces: Standardized `"typecheck": "tsc --noEmit"` script matching backend convention.

- [x] **Step 1: Check `web/package.json` scripts**
- [x] **Step 2: Add `typecheck` script to `web/package.json`**
- [x] **Step 3: Verify script runs cleanly**
- [x] **Step 4: Commit package.json update**

---

### Task 2: Workflow Permissions, Concurrency, and Frontend Build Gates

**Files:**
- Modify: `.github/workflows/tests.yml`
- Modify: `web/eslint.config.mjs`
- Modify: `web/src/components/viewers/structure-viewer.test.tsx`

**Interfaces:**
- Consumes: `web/package.json` scripts (`typecheck`, `lint`, `build`, `test`), `server/package.json` scripts (`typecheck`, `test`).
- Produces: Hardened `.github/workflows/tests.yml` with least-privilege token permissions, concurrency cancellation, job timeouts, paths-ignore for docs, and comprehensive frontend quality gates.

- [x] **Step 1: Update `tests.yml` with permissions, concurrency, timeouts, and frontend gates**
- [x] **Step 2: Adjust `web/eslint.config.mjs` and fix structure-viewer test**
- [x] **Step 3: Run local verification of frontend CI commands**
- [x] **Step 4: Commit workflow updates**

---

### Task 3: Unit Tests for PDF Viewer Initialization and Polyfills

**Files:**
- Modify: `web/src/components/pdf-viewer/pdf-viewer.tsx:62-138` (export `installMapUpsertPolyfill`, `buildWorkerUrl`, and `MAP_UPSERT_POLYFILL_SRC` for testing)
- Modify: `web/vitest.setup.ts` (add typed `IntersectionObserver` stub)
- Create: `web/src/components/pdf-viewer/pdf-viewer-init.test.ts`

**Interfaces:**
- Consumes: `web/src/components/pdf-viewer/pdf-viewer.tsx` functions (`installMapUpsertPolyfill`, `buildWorkerUrl`, `MAP_UPSERT_POLYFILL_SRC`).
- Produces: Automated test suite ensuring Map polyfill correctness, cleanup on teardown, and worker URL resolution resilience under both successful (verifying prepended polyfill) and fallback fetch scenarios.

- [x] **Step 1: Export initialization helpers from `pdf-viewer.tsx`**
- [x] **Step 2: Add typed `IntersectionObserver` stub to `web/vitest.setup.ts`**
- [x] **Step 3: Write test suite for PDF viewer initialization and polyfill safety**
- [x] **Step 4: Run new vitest test**
- [x] **Step 5: Commit test and helper updates**

---

### Task 4: Verify Full Test and Build Suite Locally

**Files:** None (verification step)

- [x] **Step 1: Run full server test suite and typecheck (`npm run typecheck && npm test`)**
- [x] **Step 2: Run full web test suite, typecheck, lint, and build (`npm run typecheck && npm run lint && npm run build && npm test`)**
- [x] **Step 3: Run cross-platform launcher check (`./start.sh --check`)**
