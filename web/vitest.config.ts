import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      include: ["src/lib/**", "src/components/**"],
      exclude: [
        "src/lib/use-*.ts",
        "src/components/ai-elements/**",
        "src/components/pdf-viewer/**",
        "src/components/ui/**",
        "**/*.d.ts",
      ],
      // A floor set a few points under the measured value (48.8% statements,
      // 45.9% branches at the time of writing) over the non-excluded surface.
      // It catches a real regression without failing on normal drift; raising
      // it is tracked in `dev-docs/plans/2026-09-08-repo-quality-gates.md`.
      thresholds: {
        statements: 46,
        branches: 43,
        functions: 42,
        lines: 48,
      },
    },
  },
});
