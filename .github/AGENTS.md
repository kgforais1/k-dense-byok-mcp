# Automation & Release Guidance (`.github/`)

Scoped to GitHub-side automation: workflows, action pinning, secret
handling, matrix testing, and release automation. Read the root
[`../AGENTS.md`](../AGENTS.md) first for cross-agent policy, fork/hook
constraints, and the source-of-truth order; this file owns only
automation deltas.

## What lives here

- `workflows/` — CI and automation workflows.
- `release.yml` — release automation that creates the `v<version>` tag and
  GitHub release with auto-generated notes after a version bump merges to
  `main`. **No manual tagging.**
- `dependabot.yml` — dependency update policy.

## Workflow conventions

- Declare the minimum `permissions:` block per workflow (and per job where
  it differs). The default for read-only or test jobs is
  `permissions: { contents: read }`. Never grant `write` or `admin`
  scope at the workflow level.
- Pin third-party GitHub Actions to a full-length commit SHA, not a tag.
  Use Dependabot (`dependabot.yml`) to keep those pins current. Do not
  pin first-party `actions/*` to a SHA; a major version tag is acceptable
  for `actions/checkout` and similar. Where a tool ships a plain
  release binary, installing it with a pinned version and a verified
  SHA-256 is preferred over wrapping it in a third-party Action at all —
  that is why `checks.yml` fetches `gitleaks` directly rather than using
  `gitleaks-action`. Keep the version and its checksum together; bumping
  one without the other must fail.
- Use `concurrency:` with a workflow+ref group and
  `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` for
  any per-PR job, so superseded pushes don't pile up.
- The `Tests` workflow runs on every push to `main` and on every pull
  request. It is the authoritative gate; the matrix (`ubuntu-latest` and
  `windows-latest` for backend) is the source of cross-platform coverage.
  Do not change the matrix without updating this file and the
  verification doc.
- The `Checks` workflow (`workflows/checks.yml`) carries the
  repository-hygiene gates: `npm run docs:check` and two full-history
  gitleaks scans. It is deliberately a second workflow rather than extra
  jobs in `Tests`, because `Tests` skips docs-only pushes to `main` via
  `paths-ignore` — exactly the changes `docs:check` exists to validate.
  **Never add `paths-ignore` to `Checks`.**
- The two gitleaks passes use two configs and cannot be merged.
  `.gitleaks.toml` extends the upstream rules; `.gitleaks-paths.toml`
  finds committed host paths and must keep `useDefault = false`, because
  the bundled defaults globally allowlist `/home/<name>/` and would
  silently disable that branch of the rule.
- The secret pass scans git history; the path pass scans only the tracked
  tree, exported with `git ls-files`. A leaked key stays live wherever it
  landed, but a host path only matters where it currently is — scanning
  history there would fail the build forever over a path already removed.
  Do not "simplify" the two into one invocation.
- Do not add a blanket file allowlist to either gitleaks config. A
  `package-lock.json` exemption was tried and removed: it suppressed every
  finding in both lockfiles, including a real key, and was hiding nothing.
- Coverage thresholds live in `server/vitest.config.ts` and
  `web/vitest.config.ts`, and run on `ubuntu-latest` only: the floor is
  platform-independent and the Windows legs are already the slowest in
  the matrix. Do not lower a floor to make a change pass.
- Rationale for every gate, plus the ratchet backlog and the tools that
  were considered and rejected, is in
  [`../dev-docs/plans/2026-09-08-repo-quality-gates.md`](../dev-docs/plans/2026-09-08-repo-quality-gates.md).

## Secrets

- Secrets are only read through `${{ secrets.NAME }}`; never echo them,
  log them, or pass them to a third-party Action that does not need them.
- Provider API keys are read in the backend from `process.env` (see
  `server/src/env.ts`). The backend does not surface them in responses and
  must not log them at any log level.
- Modal tokens, Pi OAuth tokens, and provider OAuth refresh tokens are
  managed in the running app's Settings, not as repo secrets.

## Matrix testing

- Backend: `ubuntu-latest` and `windows-latest` in `workflows/tests.yml`.
  Backend tests run with `KADY_PROJECTS_ROOT` pointed at a temp directory
  by `server/vitest.config.ts`; do not point that at `projects/` from CI.
- Frontend: same workflow, `ubuntu-latest` and `windows-latest`. Keep the
  matrix aligned with the backend unless a change is deliberately
  OS-specific; call out any matrix change in the PR.
- Node ≥ 22.19 is what the backend targets; lower 22.x usually works but
  emits an `EBADENGINE` warning. Node < 22 fails to build/install the
  packages, so the launcher (`start.mjs`) refuses to run on it on every
  platform. Do not lower the version floor in CI without a plan.

## Release automation

- `server/package.json` `version` is the single source of truth for the
  app version. The web build reads it at build time (`web/next.config.ts`
  injects `NEXT_PUBLIC_APP_VERSION`); `web/package.json` deliberately has
  no `version` field. Do not add one.
- Releasing = bump `server/package.json` version and push/merge to `main`.
  The `Release` workflow (`.github/workflows/release.yml`) runs on every
  push to `main`, and if the tag `v<version>` doesn't exist yet it
  creates it plus a GitHub release with auto-generated notes.
- Never manually create a `v<version>` tag. Never push tags directly to
  the fork or upstream.
- `CHANGELOG.md` is updated under the `Unreleased` section in the
  implementing PR when shipped behavior changes; entries move under
  `[version] - YYYY-MM-DD` as part of release preparation (see
  `docs/development/release-policy.md`).

## What this file does not own

- Local hooks live under `.githooks/`. The pre-push hook
  (`.githooks/pre-push`) blocks pushes to any remote that is not the
  fork; `start.mjs` activates it automatically via
  `git config core.hooksPath .githooks` on every launch. Hook policy is
  documented in root `AGENTS.md`; do not duplicate it here.
- Sandbox / runtime policy is owned by `server/AGENTS.md`.
- UI / viewer conventions are owned by `web/AGENTS.md`.
