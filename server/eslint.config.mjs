import tseslint from "typescript-eslint";

/**
 * Backend lint configuration.
 *
 * The frontend has had ESLint since it was scaffolded by Next.js; the backend
 * had none, so `npm run lint` here starts from `typescript-eslint`'s
 * recommended set plus a small number of size and shape limits.
 *
 * The size limits below are deliberately set at the current worst offender
 * rather than at a value anyone would choose from scratch. They exist to stop
 * new code from getting worse, not to claim the tree is already clean. Bringing
 * them down is tracked in
 * `dev-docs/plans/2026-09-08-repo-quality-gates.md`.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      // A vendored Python virtualenv that happens to ship matplotlib's own
      // browser JavaScript. It is third-party and not ours to lint.
      "src/helpers/.venv/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // A leading underscore is this codebase's existing marker for a
      // parameter kept for signature compatibility (see `notebook.ts`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // 34 occurrences today, concentrated in the Pi SDK boundary where the
      // upstream types are genuinely loose. Turning it on now would be 34
      // speculative type assertions, so it is a ratchet item, not a gate.
      "@typescript-eslint/no-explicit-any": "off",

      // Already tight: nothing in `src/` or `test/` exceeds either today.
      "max-depth": ["error", 6],
      "max-params": ["error", 6],

      // Ceilings, not targets. Current worst: complexity 62
      // (`agent/notebook-export.ts`), 1137 lines (`modal/manager.ts`), and a
      // 639-line function (`api/sandbox.ts`). Those are physical line counts;
      // `skipBlankLines`/`skipComments` means the rules count effective code
      // lines, so the limits below bite sooner than the numbers suggest. That
      // is the intent — the concern is code bulk, not file size.
      complexity: ["error", 65],
      "max-lines": ["error", { max: 1200, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": [
        "error",
        { max: 650, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    // Test files describe whole suites in one callback and reach for CommonJS
    // interop when checking how a module behaves under `require`.
    files: ["test/**"],
    rules: {
      "max-lines-per-function": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-this-alias": "off",
    },
  },
);
