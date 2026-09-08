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

      // On for shipped code. The count that made this look expensive — 36
      // occurrences — was 31 test files plus five real sites, and a global
      // "off" to spare the fixtures hid the five that matter. Each of those
      // five now carries a line-level disable stating why, which is a claim a
      // reviewer can check; "off" was not. Tests keep the escape hatch in the
      // `test/**` block below, where mock casts are the point.
      "@typescript-eslint/no-explicit-any": "error",

      // Already tight: nothing in `src/` or `test/` exceeds either today.
      "max-depth": ["error", 6],
      "max-params": ["error", 6],

      // Ceilings, not targets, set at exactly the current worst offender:
      // complexity 62 (`agent/notebook-export.ts`), 1136 lines
      // (`modal/manager.ts`), and a 639-line function (`api/sandbox.ts`).
      // Re-measure after touching those files: this config's own lint fix
      // deleted a dead import from `manager.ts` and moved the number.
      //
      // Exactly, not rounded up. A limit above the worst thing in the tree is
      // a gate nobody can trip: at `max-lines: 1200` a new 1199-line file
      // passes, and new code gets modelled on the files that already sit near
      // the line. At the worst offender, anything worse than the worst thing
      // here fails, which is the weakest claim actually worth enforcing.
      // ESLint errors only when the count *exceeds* the limit, so the worst
      // file passes at its own size and one line more does not.
      //
      // Physical lines, deliberately. `skipBlankLines`/`skipComments` would
      // count effective lines instead, and since `manager.ts` is 1136 physical
      // but ~1049 effective, that makes the limit *looser* than the number
      // reads — it would admit a ~1300-line file. Counting physical lines
      // keeps the number honest, and this codebase should never be discouraged
      // from adding a comment.
      complexity: ["error", 62],
      "max-lines": ["error", 1136],
      "max-lines-per-function": ["error", 639],
    },
  },
  {
    // Test files describe whole suites in one callback and reach for CommonJS
    // interop when checking how a module behaves under `require`.
    files: ["test/**"],
    rules: {
      "max-lines-per-function": "off",
      // 31 of the 36 `any`s are here: mock casts, `JSON.parse` results, and
      // partial SDK fixtures. Typing a stub precisely is busywork that makes
      // the test harder to read without making it check more.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-this-alias": "off",
    },
  },
);
