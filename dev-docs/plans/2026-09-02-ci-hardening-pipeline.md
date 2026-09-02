# CI Hardening and Frontend Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build out robust CI verification gates in GitHub Actions for the Next.js frontend (typecheck, lint, production build), harden workflow permissions, add concurrency and timeouts, and establish unit tests for viewer initialization and polyfill safety.

**Architecture:** Extend `.github/workflows/tests.yml` with top-level least-privilege permissions (`contents: read`), workflow-level `concurrency` cancellation, per-job `timeout-minutes`, `paths-ignore` for doc-only pushes, and full frontend `typecheck`, `lint` (`--max-warnings=0`), and `build` (`next build`) gates with build artifact upload on failure. Standardize the `typecheck` script in `web/package.json`, export and unit-test `pdf-viewer` worker URL resolution and polyfills with clean spy/lifecycle isolation (avoiding `global.URL` prototype disruption), and stub missing browser globals (`IntersectionObserver`, `CanvasRenderingContext2D`) in `vitest.setup.ts`.

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

- [ ] **Step 1: Check `web/package.json` scripts**

Verify existing scripts in `web/package.json`.

- [ ] **Step 2: Add `typecheck` script to `web/package.json`**

Update `scripts` in `web/package.json` to include:
```json
"typecheck": "tsc --noEmit",
```

- [ ] **Step 3: Verify script runs cleanly**

Run:
```bash
cd web && npm run typecheck
```
Expected: PASS with exit code 0.

- [ ] **Step 4: Commit package.json update**

```bash
git add web/package.json
git commit -m "chore(web): add typecheck script to package.json"
```

---

### Task 2: Workflow Permissions, Concurrency, and Frontend Build Gates

**Files:**
- Modify: `.github/workflows/tests.yml`

**Interfaces:**
- Consumes: `web/package.json` scripts (`typecheck`, `lint`, `build`, `test`), `server/package.json` scripts (`typecheck`, `test`).
- Produces: Hardened `.github/workflows/tests.yml` with least-privilege token permissions, concurrency cancellation, job timeouts, paths-ignore for docs, and comprehensive frontend quality gates.

- [ ] **Step 1: Update `tests.yml` with permissions, concurrency, timeouts, and frontend gates**

Modify `.github/workflows/tests.yml` to:
1. Add top-level `permissions: { contents: read }`.
2. Add `concurrency` block with `cancel-in-progress: true`.
3. Add `paths-ignore` for documentation and plan files on push.
4. Add `timeout-minutes: 15` to all jobs.
5. Add `Typecheck` (`npm run typecheck`), `Lint` (`npm run lint -- --max-warnings=0`), and `Next.js Production Build` (`npm run build`) steps to the `frontend` job before `npm run test`.
6. Add failure artifact upload for `.next` logs if the Next.js build fails.

```yaml
name: Tests

on:
  push:
    branches: [main]
    paths-ignore:
      - "docs/**"
      - "dev-docs/**"
      - "*.md"
  pull_request:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  backend:
    name: backend (vitest, ${{ matrix.os }})
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - name: Set up Node
        uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: server/package-lock.json
      - name: Install dependencies
        working-directory: server
        run: npm install
      - name: Typecheck
        working-directory: server
        run: npm run typecheck
      - name: Run tests
        working-directory: server
        run: npm test

  frontend:
    name: frontend (vitest, ${{ matrix.os }})
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - name: Set up Node
        uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: web/package-lock.json
      - name: Install frontend dependencies
        working-directory: web
        run: npm ci
      - name: Typecheck
        working-directory: web
        run: npm run typecheck
      - name: Lint
        working-directory: web
        run: npm run lint -- --max-warnings=0
      - name: Build Next.js
        working-directory: web
        run: npm run build
      - name: Upload build artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: next-build-failure-${{ matrix.os }}
          path: web/.next/
          retention-days: 7
      - name: Run tests
        working-directory: web
        run: npm run test

  launcher-smoke:
    name: launcher --check (${{ matrix.os }})
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - name: Set up Node
        uses: actions/setup-node@v5
        with:
          node-version: 22
      - name: Run start.sh --check
        if: runner.os != 'Windows'
        run: ./start.sh --check
      - name: Run start.cmd --check
        if: runner.os == 'Windows'
        shell: cmd
        run: start.cmd --check
```

- [ ] **Step 2: Run local verification of frontend CI commands**

Run:
```bash
cd web && npm run typecheck && npm run lint -- --max-warnings=0 && npm run build && npm test
```
Expected: All steps complete with exit code 0.

- [ ] **Step 3: Commit workflow updates**

```bash
git add .github/workflows/tests.yml
git commit -m "ci: add permissions, concurrency, timeouts, and frontend quality gates"
```

---

### Task 3: Unit Tests for PDF Viewer Initialization and Polyfills

**Files:**
- Modify: `web/src/components/pdf-viewer/pdf-viewer.tsx:62-138` (export `installMapUpsertPolyfill`, `buildWorkerUrl`, and `MAP_UPSERT_POLYFILL_SRC` for testing)
- Modify: `web/vitest.setup.ts` (add `IntersectionObserver` stub)
- Create: `web/src/components/pdf-viewer/pdf-viewer-init.test.ts`

**Interfaces:**
- Consumes: `web/src/components/pdf-viewer/pdf-viewer.tsx` functions (`installMapUpsertPolyfill`, `buildWorkerUrl`, `MAP_UPSERT_POLYFILL_SRC`).
- Produces: Automated test suite ensuring Map polyfill correctness, cleanup on teardown, and worker URL resolution resilience under both successful (verifying prepended polyfill) and fallback fetch scenarios.

- [ ] **Step 1: Export initialization helpers from `pdf-viewer.tsx`**

In `web/src/components/pdf-viewer/pdf-viewer.tsx`:
- Export `installMapUpsertPolyfill`
- Export `buildWorkerUrl`
- Export `MAP_UPSERT_POLYFILL_SRC`

- [ ] **Step 2: Add `IntersectionObserver` stub to `web/vitest.setup.ts`**

Ensure `vitest.setup.ts` contains the global stub for `IntersectionObserver`:

```typescript
if (typeof window !== "undefined") {
  if (!window.IntersectionObserver) {
    window.IntersectionObserver = class IntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
}
```

- [ ] **Step 3: Write test suite for PDF viewer initialization and polyfill safety**

Create `web/src/components/pdf-viewer/pdf-viewer-init.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  installMapUpsertPolyfill,
  buildWorkerUrl,
  MAP_UPSERT_POLYFILL_SRC,
} from "./pdf-viewer";

describe("pdf-viewer initialization", () => {
  const originalGetOrInsertComputed = (Map.prototype as any).getOrInsertComputed;
  const originalGetOrInsert = (Map.prototype as any).getOrInsert;

  afterEach(() => {
    (Map.prototype as any).getOrInsertComputed = originalGetOrInsertComputed;
    (Map.prototype as any).getOrInsert = originalGetOrInsert;
    vi.restoreAllMocks();
  });

  it("installs Map.prototype.getOrInsertComputed correctly when absent", () => {
    delete (Map.prototype as any).getOrInsertComputed;
    delete (Map.prototype as any).getOrInsert;

    installMapUpsertPolyfill();

    const map = new Map<string, number>();
    expect(typeof (map as any).getOrInsertComputed).toBe("function");

    const val1 = (map as any).getOrInsertComputed("k1", () => 100);
    expect(val1).toBe(100);
    expect(map.get("k1")).toBe(100);

    const val2 = (map as any).getOrInsertComputed("k1", () => 200);
    expect(val2).toBe(100);
  });

  it("builds a patched blob worker URL with prepended polyfill on successful fetch", async () => {
    const mockWorkerSrc = "/* mock worker source */";
    let capturedBlobContent: string[] = [];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve(mockWorkerSrc),
    }));

    // Spy on URL.createObjectURL without replacing URL constructor
    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn();
    }
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob) => {
      // Capture blob content for assertion
      capturedBlobContent = (blob as any)._chunks || [];
      return "blob:http://localhost/mock-worker-blob";
    });

    const url = await buildWorkerUrl();
    expect(url).toBe("blob:http://localhost/mock-worker-blob");
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    const passedBlob = createObjectURLSpy.mock.calls[0][0];
    expect(passedBlob).toBeInstanceOf(Blob);
    expect(passedBlob.type).toBe("text/javascript");
  });

  it("falls back to real asset URL if fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const url = await buildWorkerUrl();
    expect(url).toContain("pdfjs-dist");
  });
});
```

- [ ] **Step 4: Run new vitest test**

Run:
```bash
cd web && npx vitest run src/components/pdf-viewer/pdf-viewer-init.test.ts
```
Expected: PASS (3 tests passed).

- [ ] **Step 5: Commit test and helper updates**

```bash
git add web/src/components/pdf-viewer/pdf-viewer.tsx web/vitest.setup.ts web/src/components/pdf-viewer/pdf-viewer-init.test.ts
git commit -m "test(web): add unit tests for pdf-viewer initialization and polyfills"
```

---

### Task 4: Verify Full Test and Build Suite Locally

**Files:** None (verification step)

- [ ] **Step 1: Run full server test suite and typecheck**
Run: `cd server && npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 2: Run full web test suite, typecheck, lint, and build**
Run: `cd web && npm run typecheck && npm run lint -- --max-warnings=0 && npm run build && npm test`
Expected: PASS

- [ ] **Step 3: Run cross-platform launcher check**
Run: `./start.sh --check`
Expected: PASS
