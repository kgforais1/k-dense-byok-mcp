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
- **`gitleaks`** — full-history secret scan (`fetch-depth: 0`, so a key committed and later removed on the same branch is still found).

Gitleaks is installed from the upstream release tarball and verified by SHA-256, not run through `gitleaks-action`. Two reasons: the Action requires a licence key for organisation accounts, and `.github/AGENTS.md` requires third-party Actions to be pinned to a full-length commit SHA — a checksummed binary is a stronger guarantee than a SHA-pinned Action and one fewer thing for Dependabot to chase.

### Gitleaks configuration (`.gitleaks.toml`)

Extends the upstream default rule set and adds one repository-specific rule, `local-home-directory-path`, matching `/Users/<name>/`, `/home/<name>/` and `C:\Users\<name>\`. Committed host paths leak the machine's username and break for every other contributor. CI runners and documentation placeholders (`/Users/runner/`, `/home/${USER}/`, `<your-name>`) are allowlisted.

Note that Gitleaks compiles rules with RE2, which has no lookaround, so the exclusions live in the rule's allowlist rather than as a negative lookahead in the match.

Verified: clean across all 467 commits of history; the new rule fires on a real home path and stays quiet on `/Users/runner/`; the upstream rules still catch a synthetic high-entropy Anthropic key and GitHub PAT.

### Backend ESLint (`server/eslint.config.mjs`)

`typescript-eslint`'s recommended set plus size and shape limits, wired into `Tests` as a `Lint` step alongside the existing `Typecheck`. Five genuine problems surfaced and were fixed: four dead imports/variables and one `let` that is never reassigned.

The vendored Python virtualenv at `server/src/helpers/.venv/**` is ignored. It ships matplotlib's own browser JavaScript, which is third-party and not ours to lint.

### Coverage floors

Both `server/vitest.config.ts` and `web/vitest.config.ts` now carry `thresholds`, set a few points under the measured value so they catch a regression without failing on normal drift. Coverage runs on `ubuntu-latest` only — the threshold is platform-independent and the Windows legs are already the slowest in the matrix.

Measured at the time of writing:

| | statements | branches | functions | lines |
| --- | --- | --- | --- | --- |
| `server` (`src/**`) | 72.52% | 61.54% | 74.98% | 74.51% |
| `web` (non-excluded) | 48.81% | 45.89% | 44.33% | 50.92% |

## The ratchet backlog (tier 2, deferred)

Every item here is a threshold set at today's worst offender. They stop new code from getting worse; they do not claim the tree is clean. Each should come down as the underlying code is touched, not in one sweeping refactor.

- **`complexity: 65`** — the current worst is 62, in `server/src/agent/notebook-export.ts`. The p95 across 931 backend functions is 14 and the p99 is 25, so the tail is short: roughly ten functions sit above 25. A target of 25 is realistic once those are split.
- **`max-lines: 1200`** — worst is `server/src/modal/manager.ts` at 1137, then `api/sessions.ts` at 892 and `api/sandbox.ts` at 879. On the frontend the problem is worse and unmeasured by this rule, since `web` has no size limits at all: `components/file-preview-panel.tsx` is 2238 lines and `components/chat-tab.tsx` is 1937. **Adding `max-lines` to `web/eslint.config.mjs` is deferred precisely because it cannot be set at a useful value today.**
- **`max-lines-per-function: 650`** — worst is the 639-line route registrar in `server/src/api/sandbox.ts`, then a 383-line function in `api/sessions.ts`. Disabled entirely under `test/**`, where a single `describe` callback legitimately spans a suite.
- **`@typescript-eslint/no-explicit-any: off`** — 34 occurrences, concentrated at the Pi SDK boundary where the upstream types are genuinely loose. Turning it on now would produce 34 speculative type assertions, which is worse than the `any`.
- **Coverage floors** should rise as suites are added. The backend number is healthy; the frontend's 48.8% is the real gap, and it is concentrated in the large components listed above.

`max-depth` and `max-params` are both set at 6 and are *not* ratchet items — nothing in `src/` or `test/` exceeded either, so they are live gates from day one.

## Considered and rejected (tier 3)

- **Semgrep** — rejected as a generic ruleset. For TypeScript it overlaps CodeQL heavily and would mostly add duplicate findings. There *is* a real use for it, deferred rather than dismissed: custom rules encoding this repository's own invariants, which no off-the-shelf scanner knows about. Candidates, all from guardrails that already exist in prose in `AGENTS.md` and the MCP plans: an MCP tool result must never include an absolute host path; `prepareRun` must not call `reply.code`; there must be no second, MCP-only run path. Those are worth writing as rules when there are enough of them to justify the job.
- **Bandit** — rejected. The repository has one Python file, `scripts/update-models.py`. If Python linting is ever wanted, `ruff` covers more for less.
- **Aikido in CI** — rejected. It is already available locally as a plugin for on-demand scans. As a CI app it would triplicate CodeQL, Dependabot and gitleaks for the same findings.
- **Docstring coverage** — rejected. There is no TypeScript tool for this worth adopting, and the codebase's convention is explanatory comments at decision points rather than uniform per-symbol docblocks. A percentage gate would reward the wrong thing.
- **A standalone "no absolute paths" script** — rejected as redundant. The `local-home-directory-path` gitleaks rule covers it, and gets history scanning for free. Worth recording that the real near-miss during MCP Phase 2 was *runtime* output — `create_research_session` returning `session.sessionFile` — which no source scan would ever have caught. That class of leak needs a contract test, and has one.

## Guardrails

- Do not add `paths-ignore` to `Checks`. Its entire purpose is running on the documentation changes `Tests` skips.
- Do not raise a ratchet threshold to make a change pass. Lowering them is the direction; if a new file needs 1300 lines, split the file.
- Keep the gitleaks binary's version and SHA-256 together in `checks.yml`. Bumping one without the other fails the checksum, which is the intended behaviour.

## Closing checklist

- [x] `Checks` workflow added with `docs:check` and `gitleaks` jobs.
- [x] `.gitleaks.toml` added; verified against full history and against synthetic positives.
- [x] Backend ESLint config added, wired into CI, and the five findings fixed.
- [x] Coverage thresholds added for `server` and `web`; coverage step added to CI.
- [x] Ratchet backlog and rejected tools recorded above and linked from `dev-docs/todo.md`.
- [ ] Set status to `Completed and merged in PR #<n>` and move to `dev-docs/plans/completed/`.
