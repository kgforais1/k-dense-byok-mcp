---
title: "Repository quality gates — CI hardening and the ratchet backlog"
status: accepted
created: 2026-09-08
branch: ci-hardening
---

# Repository Quality Gates

**Status:** Accepted — tier 1 implemented on branch `ci-hardening`; tiers 2 and 3 deferred.

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. See
> `docs/development/workflow.md#archive-lifecycle`.

**Goal:** Close the gaps between what CI actually enforces and what the repository's own instructions claim it enforces, and record the ones deliberately left open so they are a backlog rather than an oversight.

## Why this work

Three gaps prompted this, and one of them had already bitten:

1. **`npm run docs:check` never ran in CI.** `AGENTS.md` and `docs/development/workflow.md` treat the documentation checks as binding — plan placement, handoff schema, release/changelog consistency, manifest category coverage. Nothing enforced them. A `git mv` of a plan file into `dev-docs/plans/completed/` broke every relative link inside it during the MCP Phase 2 work, and the only reason it was caught is that the check happened to be run by hand.
2. **The backend had no linter.** `web/` has had ESLint since Next.js scaffolded it and CI runs it. `server/` — the larger and more security-sensitive half — had none.
3. **Nothing scanned for committed secrets.** This is a bring-your-own-key application whose entire job is handling provider credentials. CodeQL looks for vulnerable code patterns and Dependabot looks for vulnerable dependencies; neither looks for an API key pasted into a fixture or a doc.

## What was implemented (tier 1)

### `Checks` workflow (`.github/workflows/checks.yml`)

A second workflow rather than new jobs in `Tests`, for one reason: `Tests` carries `paths-ignore` for `docs/**`, `dev-docs/**` and `**/*.md` on pushes to `main`. Those are exactly the paths `docs:check` exists to validate, so folding it into `Tests` would have made it skip the changes it is meant to catch. `Checks` carries no `paths-ignore`.

- **`docs:check`** — runs `npm run docs:check` (which is `repo.mjs verify docs`). No `npm ci` step: the root package has no dependencies, and both `repo.mjs` and `docs-check.mjs` are plain Node.
- **`gitleaks`** — three scans (`fetch-depth: 0`, so a key committed and later removed on the same branch is still found): one for secrets, one for host paths. See below for why they cannot share a config.

Gitleaks is installed from the upstream release tarball and verified by SHA-256, not run through `gitleaks-action`. Two reasons: the Action requires a licence key for organisation accounts, and `.github/AGENTS.md` requires third-party Actions to be pinned to a full-length commit SHA — a checksummed binary is a stronger guarantee than a SHA-pinned Action and one fewer thing for Dependabot to chase.

### Gitleaks configuration (two configs, two passes)

`.gitleaks.toml` extends the upstream default rule set and does nothing else. `.gitleaks-paths.toml` holds one repository-specific rule, `local-home-directory-path`, matching `/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\` and `C:/Users/<name>/`. Committed host paths leak the machine's username and break for every other contributor.

**The split is not cosmetic.** Gitleaks' bundled default config carries a global allowlist that suppresses `/home/<name>/` outright — sensible for a secret scanner, fatal for a rule whose entire purpose is finding them. Under `[extend] useDefault = true` the `/home/` branch matched nothing at all, silently: a green gate checking nothing. The path rules therefore run as a second pass with `useDefault = false`. The split is also honest about the concepts, since a committed home directory is a portability and privacy problem rather than a secret, which is why the second pass does not run with `--redact`.

Four further details worth recording, every one of which was wrong in an earlier draft:

- Gitleaks compiles rules with RE2, which has no lookaround, so the exclusions live in the rule's allowlist rather than as a negative lookahead in the match. That allowlist is matched against the rule's own *match string*, so listing `home` as a placeholder username suppressed every `/home/...` finding — the allowlist ate the rule.
- A Windows path in JavaScript source has its backslashes escaped (`C:\\Users\\<name>\\`), so the separator has to accept a run rather than a single character. `C:/Users/<name>/` is also ordinary in JS and needs the forward-slash form.
- The allowlist originally excused `root`, `admin`, `node`, `ubuntu`, `user`, `test` and `me`. Every one of those is a real account name on some machine, so a genuine home directory belonging to any of them walked straight through the gate. Only the CI runner and syntactic placeholders (`<name>`, `${VAR}`, `%VAR%`) are excused now; the few real fixture paths are allowlisted as exact strings rather than by username, and single-letter names are no longer blanket-excused for the same reason.
- A `{0,31}` bound on the username silently exempted anyone with a 33-character name — the rule's own subject matter. It is unbounded now.

**The path pass scans the tracked tree; the secret pass scans history.** That difference is deliberate. A key that reached any commit is still a live credential and must be found wherever it is. A host path only matters where it currently sits, and scanning history would mean a path removed three commits ago fails the build forever — which is exactly what happened when this plan's own text quoted an example path. The tree is exported with `git ls-files` rather than scanned in place, because `gitleaks dir .` walks gitignored content: locally that is the 2 GB `projects/` directory, full of real host paths that are not ours to police. Exported, the scan covers 13.7 MB in 198 ms.

There is no repository-wide `package-lock.json` allowlist of our own. One was added on the assumption that upstream integrity hashes would trip the entropy rules; scanning without it found nothing, so it was pure suppression — it would have hidden a real provider key committed to a lockfile and bought nothing in exchange. The only blanket exemption we add is `.gitleaks-paths.toml` itself, which has to be able to spell the patterns it matches on. That is not the whole story, though, and an earlier draft of this paragraph claimed it was. `[extend] useDefault = true` silently inherits gitleaks' *bundled* `[allowlist] paths`, which skips `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `node_modules`, `vendor`, Python virtualenvs and binary assets — so removing our own lockfile exemption did not actually make lockfiles scannable. Verified: an identical synthetic Anthropic key is caught in a `.ts` file and missed in `package-lock.json`. There is no supported way to un-inherit that list; `paths = []` is rejected outright. Hence a third pass, `.gitleaks-lockfiles.toml`, with `useDefault = false` and a small high-precision rule set for the credential shapes this backend actually handles. Dependabot moves those lockfiles every week and one branch here moved `server/package-lock.json` by 1,960 lines, so exempting them from every rule at once was the wrong blind spot to accept. Nothing else is exempt, including this file — an earlier draft of the paragraph above quoted a literal home path as an example and CI failed on it, correctly. Prose about the rule has to describe a path rather than spell one.

Verified: the secret pass is clean across all 471 commits; the path pass is clean over the tracked tree; the rule fires on all four host-path forms plus a home directory named after one of the removed placeholders, and stays quiet on the CI-runner, variable and fixture forms; the upstream rules still catch a synthetic high-entropy Anthropic key and GitHub PAT.

### Backend ESLint (`server/eslint.config.mjs`)

`typescript-eslint`'s recommended set plus size and shape limits, wired into `Tests` as a `Lint` step alongside the existing `Typecheck`. Five genuine problems surfaced and were fixed: four dead imports/variables and one `let` that is never reassigned.

The vendored Python virtualenv at `server/src/helpers/.venv/**` is ignored. It ships matplotlib's own browser JavaScript, which is third-party and not ours to lint.

### Coverage floors

Both `server/vitest.config.ts` and `web/vitest.config.ts` now carry `thresholds`, set a few points under the measured value so they catch a regression without failing on normal drift. Coverage runs on `ubuntu-latest` only — the threshold is platform-independent and the Windows legs are already the slowest in the matrix.

Measured at the time of writing:

| | statements | branches | functions | lines |
| --- | --- | --- | --- | --- |
| `server` (`src/**` + `pi-packages/**`) | 72.12% | 61.30% | 74.06% | 74.05% |
| `web` (non-excluded) | 48.81% | 45.89% | 44.33% | 50.92% |

## The ratchet backlog (tier 2, deferred)

Every item here is a threshold set at today's worst offender. They stop new code from getting worse; they do not claim the tree is clean. Each should come down as the underlying code is touched, not in one sweeping refactor.

They are set at *exactly* the worst offender rather than rounded up to a comfortable number, and they count physical lines rather than effective ones. Both details matter, and a first draft got both wrong. A ceiling above the worst thing in the tree is a gate nobody can trip — at `max-lines: 1200` a new 1199-line file passes, and new code gets modelled on whatever already sits near the line. And `skipBlankLines`/`skipComments` makes the limit *looser* than it reads, since `manager.ts` is 1136 physical but roughly 1049 effective, so a 1200 effective-line limit would have admitted a file of about 1300 lines.

The obvious counter-proposal — set the limits at p95 (complexity ~14, `max-lines` ~400) and fail the build on the existing violations — is not implementable as stated. 169 files exceed `max-lines` at that level, so the gate would block every unrelated PR from day one, and `--max-warnings=0` does not help because it makes warnings fail too. Coming down is a per-file job done when the file is next touched.

- **`complexity: 62`** — set at the current worst, in `server/src/agent/notebook-export.ts`. The p95 across 931 backend functions is 14 and the p99 is 25, so the tail is short: roughly ten functions sit above 25. A target of 25 is realistic once those are split.
- **`max-lines: 1136`** — set at the current worst, `server/src/modal/manager.ts`; then `api/sessions.ts` at 892 and `api/sandbox.ts` at 879. On the frontend the problem is worse and unmeasured by this rule, since `web` has no size limits at all: `components/file-preview-panel.tsx` is 2238 lines and `components/chat-tab.tsx` is 1937. **Adding `max-lines` to `web/eslint.config.mjs` is deferred precisely because it cannot be set at a useful value today.**
- **`max-lines-per-function: 639`** — set at the current worst, the route registrar in `server/src/api/sandbox.ts`; then a 383-line function in `api/sessions.ts`. Disabled entirely under `test/**`, where a single `describe` callback legitimately spans a suite.
- ~~**`@typescript-eslint/no-explicit-any: off`**~~ — **no longer deferred; enabled.** The original entry said 34 occurrences at the loose Pi SDK boundary, too many to fix. The real count was 36, and the distribution was the point: 31 in `test/**`, 3 in `src/`, 2 in `pi-packages/`. Turning the rule off globally to spare 31 mock casts also excused the five sites that matter. It is now an error for shipped code and off under `test/**`, and each of the five carries a line-level disable saying why — four are `ToolDefinition<any>[]`, which is genuinely uninstantiable across tools with different parameter schemas, and one is `@fastify/multipart`'s declaration merging. A stated reason a reviewer can check beats a silent `off`. That the number had already drifted 34 to 36 inside this branch is the argument in miniature.
- **Coverage floors** are set a few points under the measured value rather than exactly at it. The measured surface now includes `server/pi-packages/**`, which was outside `include` while ESLint was linting it — 576 lines of shipped code running in child `pi` processes could have gone to zero coverage without tripping anything. Adding it cost 0.4 points. The case for exact floors is that a buffer masks precisely the regression it should catch: 200 new untested lines in `api/sandbox.ts` move the number by roughly 1.5% and still clear a 70% floor. The case against is that an exact floor turns every refactor deleting a covered line into a red build, which trains people to edit the threshold — the one habit that makes the gate worthless. The buffer stays for now, deliberately, and this is the item most worth revisiting first. The floors should also rise as suites are added: the backend number is healthy; the frontend's 48.8% is the real gap, and it is concentrated in the large components listed above.

`max-depth` and `max-params` are both set at 6 and are *not* ratchet items — nothing in `src/` or `test/` exceeded either, so they are live gates from day one.

## Considered and rejected (tier 3)

- **Semgrep** — rejected as a generic ruleset. For TypeScript it overlaps CodeQL heavily and would mostly add duplicate findings. There *is* a real use for it, deferred rather than dismissed: custom rules encoding this repository's own invariants, which no off-the-shelf scanner knows about. Candidates, all from guardrails that already exist in prose in `AGENTS.md` and the MCP plans: an MCP tool result must never include an absolute host path; `prepareRun` must not call `reply.code`; there must be no second, MCP-only run path. Those are worth writing as rules when there are enough of them to justify the job. A reviewer made a sharper point about the framing: two of those three are not Semgrep-shaped at all. "No absolute host path in a tool result" is a property of *runtime output*, which no static rule can see — `server/test/mcp-server-tools.test.ts:122` pins the one known instance, but `get_session_history` and `poll_run` have no such assertion. "No second, MCP-only run path" wants a test driving `run_already_active` through the MCP adapter to prove it shares `beginRun`'s ownership and billing. Only "`prepareRun` must not call `reply.code`" is structural. Deferring the *job* is right; deferring the two tests is not, and they are carried into Phase 3 of the MCP plan rather than left here.
- **Bandit** — rejected. The repository has one Python file, `scripts/update-models.py`, and it is a manual maintenance script: nothing in `.github/`, `start.mjs`, `package.json` or `scripts/repo.mjs` invokes it, so it does not run in CI or at boot. A reviewer argued the opposite — that a single Python entry point is exactly when a security linter is cheapest, and that this one is supply-chain-adjacent because it fetches pricing and writes `web/src/data/models.json` in automation. The first half is fair; the second half is factually wrong about this repository. If Python linting is ever wanted, `ruff` covers more for less.
- **Aikido in CI** — rejected. It is already available locally as a plugin for on-demand scans. As a CI app it would triplicate CodeQL, Dependabot and gitleaks for the same findings.
- **Docstring coverage** — rejected. There is no TypeScript tool for this worth adopting, and the codebase's convention is explanatory comments at decision points rather than uniform per-symbol docblocks. A percentage gate would reward the wrong thing.
- **A standalone "no absolute paths" script** — rejected as redundant. The `local-home-directory-path` gitleaks rule covers it, and gets history scanning for free. Worth recording that the real near-miss during MCP Phase 2 was *runtime* output — `create_research_session` returning `session.sessionFile` — which no source scan would ever have caught. That class of leak needs a contract test, and has one.

## Guardrails

- Do not add `paths-ignore` to `Checks`. Its entire purpose is running on the documentation changes `Tests` skips.
- Do not raise a ratchet threshold to make a change pass. Lowering them is the direction; if a new file needs 1300 lines, split the file.
- Keep the gitleaks binary's version and SHA-256 together in `checks.yml`. Bumping one without the other fails the checksum, which is the intended behaviour.
- Do not merge `.gitleaks-paths.toml` back into `.gitleaks.toml`. It needs `useDefault = false`, and folding it in re-breaks the `/home/` branch without failing anything.

## Closing checklist

- [x] `Checks` workflow added with `docs:check` and `gitleaks` jobs.
- [x] `.gitleaks.toml` added; verified against full history and against synthetic positives.
- [x] Backend ESLint config added, wired into CI, and the five findings fixed.
- [x] Coverage thresholds added for `server` and `web`; coverage step added to CI.
- [x] Ratchet backlog and rejected tools recorded above and linked from `dev-docs/todo.md`.
- [ ] Set status to `Completed and merged in PR #<n>` and move to `dev-docs/plans/completed/`.
