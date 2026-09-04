# Verification Ladder

This doc is the contributor's guide to running checks. It mirrors the
command hub exposed by `scripts/repo.mjs` and the npm script aliases in the
root `package.json`. The hub exists so a fresh agent does not have to
guess which package and which command to run; the ladder exists so the
same agent can pick the right speed/strength of check for the moment.

For harness policy see [`../../AGENTS.md`](../../AGENTS.md). For
architectural context see
[`architecture-map.md`](architecture-map.md).

## Principles

- **Loud failures.** Every check prints which command failed, its exit
  code, and the first useful line of stderr. A green hub run is the only
  pass signal; a `0` exit with a `FAIL` line in the body is a bug.
- **Exit codes are preserved.** When the hub delegates to `npm run`,
  `tsc`, or `vitest`, the original exit code is returned. CI uses the
  same checks, so a failure here is a failure there.
- **No bypasses.** The hub never runs `git push --no-verify`, never
  edits `.githooks/`, never tags or publishes. The release workflow on
  `main` is the only path to a tag.
- **No network writes.** The fast and docs ladders are fully offline.
  Server, web, and full ladders may reach npm for `npm install`/`npm ci`
  if the lockfile is stale; they do not push, tag, or post anywhere.

## The ladder at a glance

| Ladder | Command | What it runs | Approx runtime | When to use |
|---|---|---|---|---|
| `fast` | `npm run verify -- fast` | Manifest validation, manifest git-hygiene, root script aliases. | <2s | After every edit, before committing. |
| `server` | `npm run verify -- server` | `server` typecheck + `server` tests. | 1–3 min | Before opening a backend PR, after touching `server/src/`. |
| `web` | `npm run verify -- web` | `web` typecheck + `web` tests. | 1–3 min | Before opening a frontend PR, after touching `web/src/`. |
| `docs` | `npm run verify -- docs` | `docs:check` + `handoff:check` + `release:check` + manifest category coverage. | <2s | After editing a handoff, the changelog, or the manifest. |
| `all` | `npm run verify -- all` | The four ladders in order. | 2–6 min | Before requesting review on a non-trivial PR. |

The `verify` subcommand accepts the ladder as its first positional
argument. The default is `fast`. Any unknown ladder is rejected with
exit code 2.

## Step-by-step

### `fast` — the always-on check

Three small, offline steps. Cheap enough to run on every save and
reliable enough to gate a commit:

1. **Manifest validates and every target exists.** Loads
   `scripts/repo-manifest.json`, checks that every entry has a unique
   `id`, a known `category`, a non-empty `path`/`name`/`description`,
   and that the listed target exists on disk. Add or relocate a target
   in the same PR that updates the manifest.
2. **No uncommitted changes to manifest targets.** Reads
   `git status --porcelain -- scripts/repo-manifest.json` and fails if
   the file is dirty. The manifest is the source of truth for
   navigation; leaving it out of a PR leaves reviewers guessing.
   *(If the step reports `skipped (no .git)`, that is **not** a pass —
   it means the hygiene check could not run; run it inside a git clone.)*
3. **Root `package.json` exposes the hub aliases.** Confirms the
   scripts `status`, `verify`, `docs:check`, `repo:map`,
   `handoff:check`, `release:check`, `work:plan`, `work:handoff`, and
   `work:maintenance` are present. Adding a new subcommand means
   adding its alias here.

### `server` — backend typecheck + tests

1. `cd server && npm run typecheck` — runs `tsc --noEmit`. Fails on
   any type error, including ones in test files (vitest typechecks
   tests separately).
2. `cd server && npm test -- --reporter=default` — runs the vitest
   suite. The `KADY_PROJECTS_ROOT` is redirected to a temp dir by
   `server/vitest.config.ts`, so tests do not touch user projects.
   Pass `--reporter=default` explicitly so the hub can grep output.

   **Prerequisite:** the `server` ladder (like `web` and `all`) runs
   `npm` scripts, so `npm install` must have been run in `server/` (and
   `web/`). On a fresh clone run `npm --prefix server install` and
   `npm --prefix web install` first. `verify fast` and `verify docs`
   need no dependencies.

### `web` — frontend typecheck + tests

1. `cd web && npm run typecheck` — runs `tsc --noEmit` against the
   Next.js 16 / React 19 codebase.
2. `cd web && npm test -- --reporter=default` — runs the vitest
   suite. There is currently no browser/e2e test suite; if one is
   added, wire it into this ladder and the CI matrix in the same PR.

### `docs` — structure, handoff, release, and manifest coverage

1. **`docs:check`** (`scripts/docs-check.mjs`) — validates internal
   Markdown links and anchors, the `CLAUDE.md`/`GEMINI.md` pointer
   template, manifest target existence, active-handoff schema
   (frontmatter + required headings), and plan/completed placement.

2. **`handoff:check`** (`scripts/repo.mjs`) — walks
   `dev-docs/handoffs/active/*.md`. For each file it requires:
   - YAML frontmatter with `branch`, `plan`, `status`, `updated`.
   - `updated` is ISO `YYYY-MM-DD`.
   - `branch` matches the current `git rev-parse --abbrev-ref HEAD`.
   - `plan` resolves to an existing file.
   - The body has `## Scope`, `## Verification`, and `## Next action`
     headings.

   See `dev-docs/handoffs/active/` for the schema. Templates live
   under `dev-docs/templates/` and are scaffolded via
   `npm run work:handoff -- --plan <path>`.

3. **`release:check`** — checks that:
   - `server/package.json` has a SemVer `version` field (single
     source of truth for the app).
   - `web/package.json` does **not** carry a `version` field.
   - `CHANGELOG.md` has a `# Changelog` heading, the Keep-a-Changelog
     preamble line, and an `## [Unreleased]` section.
   - When the current version is not yet released, an `Unreleased`
     section exists; otherwise the current version is listed.

4. **Manifest category coverage** — every category defined in
   `scripts/repo-manifest.json` has at least one entry. Empty
   categories usually mean someone added a new category without
   seeding it.

### `all` — fast + server + web + docs

Runs the four ladders in that order. Each ladder stops at its first failing
step and returns that step's exit code, so a red run points directly at the
first actionable failure. Use it before opening or updating a PR; it is the
closest the local machine gets to what CI runs.

> `npm run docs:check` is an alias for `npm run verify -- docs` (the full docs
> gate: structure + handoff + release + manifest category coverage).

## CI matrix

The `.github/workflows/tests.yml` workflow is the source of truth for
CI coverage. The mapping is:

| Local ladder | CI job / step | Runner(s) |
|---|---|---|
| `verify fast` | launcher smoke (`start.sh/cmd --check`; manifest/alias checks are local-only) | `ubuntu-latest`, `macos-latest`, `windows-latest` |
| `verify server` | backend job (`typecheck` + `vitest`) | `ubuntu-latest`, `windows-latest` |
| `verify web` | frontend job (`typecheck` + `lint` + `build` + `vitest`; local `web` omits lint/build) | `ubuntu-latest`, `windows-latest` |
| `verify docs` | *(local only — no CI job yet; the plan's Phase 5 docs job is still pending)* | — |
| `verify all` | all jobs in matrix | per-job matrix runners |

Failures in overlapping checks should reproduce across local ladders and CI.
The `fast` and `web` ladders are not identical to their CI jobs — see the
notes in the table above. The `docs` ladder is local-only for now, so run it
before review. If a CI-mapped check and its local counterpart disagree, file
a maintenance log entry; the disagreement is the bug.

## Adding a new check

1. Add the step to the relevant ladder in `scripts/repo.mjs`. The
   step is a function that returns a one-line success message and
   throws on failure with the command/exit code in the error
   message.
2. Update the table above to document the new step.
3. If the check is suitable for CI, add the matching step to
   `.github/workflows/tests.yml` in the same PR.

Do not add a step that runs only locally; that creates the
"passes on my machine" failure mode the ladder exists to prevent.
