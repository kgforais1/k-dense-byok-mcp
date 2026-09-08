import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Multiple test files reset/repopulate this same shared directory in
    // beforeEach/afterAll; running files concurrently races on it (ENOTEMPTY,
    // files vanishing mid-assertion). Run test files serially to avoid that.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      // A floor set a few points under the measured value (72.5% statements,
      // 61.5% branches at the time of writing), so it catches a real
      // regression without failing on normal drift. Raising it as coverage
      // improves is tracked in
      // `dev-docs/plans/2026-09-08-repo-quality-gates.md`.
      thresholds: {
        statements: 70,
        branches: 59,
        functions: 72,
        lines: 72,
      },
      // `pi-packages/**` is in scope deliberately. It was outside this list
      // while ESLint was linting it, so 576 lines of shipped code running in
      // child `pi` processes — notebook, modal and annotation tools — could
      // have gone to zero coverage without tripping the gate. Including it
      // costs 0.4 points.
      include: ["src/**/*.ts", "pi-packages/**/*.ts"],
      exclude: [
        // A vendored Python virtualenv, not backend source.
        "src/helpers/.venv/**",
        // Process entry points; exercised by the launcher smoke test instead.
        "src/index.ts",
        "src/prep.ts",
      ],
    },
    // Each run gets an isolated projects root under the OS temp dir.
    env: {
      KADY_PROJECTS_ROOT:
        process.env.VITEST_PROJECTS_ROOT ??
        path.join(os.tmpdir(), `kady-vitest-projects-${process.pid}`),
      PI_CODING_AGENT_DIR:
        process.env.VITEST_PI_AGENT_DIR ??
        path.join(os.tmpdir(), `kady-vitest-pi-agent-${process.pid}`),
      KADY_SKILLS_CACHE_DIR:
        process.env.VITEST_SKILLS_CACHE_DIR ??
        path.join(os.tmpdir(), `kady-vitest-skills-cache-${process.pid}`),
    },
  },
});
