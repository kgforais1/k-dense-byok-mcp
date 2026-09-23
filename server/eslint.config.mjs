import tseslint from "typescript-eslint";
import ratchets from "./.ratchets.json" with { type: "json" };

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
 *
 * The `max-lines` cap is maintained by `npm run ratchet:sync`. Its value lives
 * in `server/.ratchets.json` (key `maxLines`, floor `floor`). It only ever
 * moves down and stops at the floor. Re-measure after touching the worst file:
 * this config's own lint fix deleted a dead import from `manager.ts` and moved
 * the number.
 */
/** Every shape `prepareRun` could take. A reviewer pointed out the first
 * version of this list called itself "the two shapes" while already being
 * short by one — `const prepareRun = function () {}` is neither a declaration
 * nor an arrow. */
const PREPARE_RUN_FORMS = [
  'FunctionDeclaration[id.name="prepareRun"]',
  'VariableDeclarator[id.name="prepareRun"]',
  'MethodDefinition[key.name="prepareRun"]',
  'Property[key.name="prepareRun"]',
];

/** Parameter names that mean "an HTTP reply" by convention. */
const REPLY_NAMES = "/^(reply|res|response)$/";

/** The ways a Fastify reply type can be written: bare, aliased on import
 * (`FastifyReply as Reply`), qualified (`fastify.FastifyReply`), or inline
 * (`import("fastify").FastifyReply`). Each is a different AST node, and the
 * first version of this rule only knew the first one.
 *
 * Every entry names the *reply*, never the package. An earlier version also
 * carried `TSImportType[argument.value="fastify"]`, which was inert: on this
 * AST the module string sits at `argument.literal.value`, so it matched
 * nothing. Spelled correctly it would have fired on
 * `import("fastify").FastifyRequest["log"]` and on `FastifyInstance` — types
 * this file threads legitimately in eight places (`sessions.ts:348` onward).
 * So the entry was both dead and, once fixed, wrong. The invariant is about
 * the reply, not about touching Fastify, and the negative test pins the
 * working spelling rather than the dead one. */
const REPLY_TYPE_SELECTORS = [
  'TSTypeReference[typeName.name=/^(FastifyReply|Reply)$/]',
  'TSTypeReference[typeName.right.name="FastifyReply"]',
  'TSImportType[qualifier.name="FastifyReply"]',
];

/** Parameter shapes that can bind a name without being a bare identifier:
 * `{ reply }`, `[reply]`, `reply = fallback`, `...reply`. The first version
 * matched only a direct `Identifier` child, so a destructured or defaulted
 * reply was seen only if it was later member-accessed — and forwarding it to
 * a helper has no member access at all. */
const PARAM_PATTERNS =
  ":matches(ObjectPattern, ArrayPattern, AssignmentPattern, RestElement)";

/** A `prepareRun` form either *is* the callable or wraps one. */
const CALLABLE_WRAPPERS = [
  "",
  " > :matches(ArrowFunctionExpression, FunctionExpression)",
];

const PREPARE_RUN_MESSAGE =
  "prepareRun must stay transport-neutral: it returns a typed RunStartRejection so the MCP adapter, which has no reply to write to, can share it. Do not accept or touch a Fastify reply here. See server/src/api/sessions.ts.";

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
      // complexity 62 (`agent/notebook-export.ts` is now exempted per-function;
      // see the FORK notes there), the ratcheted `max-lines` cap (in
      // `.ratchets.json`; `modal/manager.ts` is the file that sets it), and a
      // 672-line function (`api/sandbox.ts`, grown by merged routes).
      //
      // No number is written here for `max-lines` on purpose: the ratchet
      // moves it, so any figure in this comment would be a lie after the
      // first shrink. Read `.ratchets.json`. The other two are still
      // hand-measured, so re-measure those after touching their worst file.
      //
      // The number only ever moves *down*. A change that needs lines in the
      // worst file pays for them there: rewriting `manager.ts`'s `wait` cost
      // four lines and returned five, so the limit went 1468 -> 1467. Raising
      // it to fit a diff would make the cap track the tree instead of bounding
      // it, which is the opposite of what it is for.
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
      "max-lines": ["error", ratchets.maxLines],
      "max-lines-per-function": ["error", 672],
    },
  },
  {
    // One invariant, one function, one file — so the rule says so, rather
    // than leaving the function's name to do the scoping by itself. A future
    // unrelated `prepareRun` elsewhere in the tree is then not this rule's
    // business. `test/lint-rules.test.ts` keeps this path honest: it lints
    // its synthetic sources *as* this file, and fails if the function is
    // renamed or moved out from under the rule.
    files: ["src/api/sessions.ts"],
    rules: {
      // `prepareRun` returns a typed `RunStartRejection` instead of writing
      // an HTTP reply, and that is the only reason the MCP adapter can share
      // it: the MCP path has no `reply` to write to. A second run path built
      // because this one was unusable headlessly would split run ownership
      // and billing, which is the failure the archived MCP work exists to
      // avoid.
      //
      // TypeScript does not catch the refactor this guards — threading a
      // Fastify reply back into `prepareRun` compiles fine and breaks only
      // the MCP path. The rule states the reason at the moment it happens.
      //
      // Guarded at the *signature*, not only at the use. A rule matching
      // `reply.code(...)` alone is bypassed by renaming the parameter,
      // aliasing it, destructuring it, or handing it to a helper — all of
      // which still couple this function to HTTP, and all of which have to
      // bring the reply in through the parameter list first.
      //
      // WHAT THIS DOES NOT CATCH, stated plainly because the previous version
      // of this comment claimed the opposite. Two reviewers independently
      // showed the hatch is not closed. A structural annotation with an
      // innocent name — `function prepareRun(sink: { code: (n: number) => void })`
      // — trips nothing here, and `unknown` plus a cast at the use site does
      // the same. Neither `noImplicitAny` nor `no-explicit-any` helps:
      // `no-explicit-any` catches only the literal `any`, and `unknown` is a
      // one-word substitute for it. Closing that needs type information this
      // rule does not have. What is left is a guard against the honest
      // refactor, not against someone working around it — which is the
      // failure actually worth spending on, since nobody threads a reply into
      // this function on purpose while disguising its type.
      "no-restricted-syntax": [
        "error",
        ...PREPARE_RUN_FORMS.flatMap((form) => [
          // A parameter that says "reply" by name — bare, or bound inside a
          // destructuring, default or rest pattern — in either of the
          // callable shapes the form can wrap.
          ...CALLABLE_WRAPPERS.flatMap((wrapper) => [
            {
              selector: `${form}${wrapper} > Identifier[name=${REPLY_NAMES}]`,
              message: PREPARE_RUN_MESSAGE,
            },
            {
              selector: `${form}${wrapper} > ${PARAM_PATTERNS} Identifier[name=${REPLY_NAMES}]`,
              message: PREPARE_RUN_MESSAGE,
            },
          ]),
          // A parameter that says "reply" by type, anywhere inside. This is
          // what covers an alias or a destructure: either still has to be
          // typed to compile.
          ...REPLY_TYPE_SELECTORS.map((type) => ({
            selector: `${form} ${type}`,
            message: PREPARE_RUN_MESSAGE,
          })),
          // A reply reached from module scope rather than through a
          // parameter.
          {
            selector: `${form} MemberExpression[object.name=${REPLY_NAMES}]`,
            message: PREPARE_RUN_MESSAGE,
          },
        ]),
      ],
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
