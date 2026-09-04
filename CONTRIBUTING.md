# Contributing to K-Dense BYOK

Thanks for contributing to the `kgforais1/k-dense-byok-mcp` fork. This doc is the
human contributor workflow. For the canonical repository policy (fork safety,
source-of-truth order, lifecycle) see [`AGENTS.md`](AGENTS.md). For the
developer documentation index, ownership table, and deeper lifecycle detail see
[`docs/development/README.md`](docs/development/README.md).

## Prerequisites

- **Node.js >= 22.19** (Pi targets 22.19+; Node < 22 fails to build the Pi
  harness — `start.mjs` refuses to run on it on every platform).
- **Git** with `core.hooksPath` support.
- **Windows only:** [Git for Windows](https://git-scm.com/download/win) — the
  agent's `bash` tool runs through Git Bash.

## Setup

```bash
# 1. Clone the fork (not upstream)
git clone https://github.com/kgforais1/k-dense-byok-mcp.git
cd k-dense-byok-mcp

# 2. Install dependencies (root has no deps; server + web do)
npm --prefix server install
npm --prefix web install
# or: ./start.sh on macOS/Linux, start.cmd on Windows (also seeds skills and starts both services)

# 3. Verify the harness is intact
npm run verify -- fast        # <2s, manifest + hygiene + hub aliases
git config core.hooksPath     # should print .githooks (set automatically by start.mjs)
```

Configuration is via `process.env`, auto-loaded by `server/src/env.ts` from
repo-root `.env` → legacy `kady_agent/.env` → `server/.env` (in that order).
Copy `.env.example` to `.env` and add only the keys you need
(`OPENROUTER_API_KEY` is optional when using OAuth / NIM / Ollama). See
[`AGENTS.md`](AGENTS.md#configuration) for the full env surface.

## Where does the change belong? (scope selection)

Use the nearest scoped instruction file — **closest-scope wins**:

| Scope | Instruction | Owns |
|---|---|---|
| Repository | [`AGENTS.md`](AGENTS.md) | Cross-agent policy, navigation, lifecycle, source-of-truth order |
| Backend | [`server/AGENTS.md`](server/AGENTS.md) | Fastify/Pi SDK, tests, helper venv, sandbox boundaries |
| Frontend | [`web/AGENTS.md`](web/AGENTS.md) | Next.js/React, viewer registry, browser tests |
| Automation | [`.github/AGENTS.md`](.github/AGENTS.md) | Workflow permissions, action pinning, release automation |

Then confirm the package/module destination in
[`docs/development/architecture-map.md`](docs/development/architecture-map.md).
If you add or relocate a manifest-listed entry point, update
`scripts/repo-manifest.json` in the **same PR** — see
[`docs/development/README.md#category-definitions`](docs/development/README.md#category-definitions).

## Branching

- Branch from `main`: `git checkout main && git pull && git checkout -b <kebab-case-slug>`.
- Branch names are kebab-case and descriptive (`feat/modal-retry`, `fix/provenance-scan-budget`). Short-lived branches; avoid long-lived forks.
- **Fork guard:** This repo is `kgforais1/k-dense-byok-mcp`. Never open PRs against upstream. Always pass `--repo kgforais1/k-dense-byok-mcp` to `gh pr create` (the pre-push hook `.githooks/pre-push` blocks pushes to any non-fork remote; `start.mjs` activates it via `git config core.hooksPath .githooks`). Never use `git push --no-verify` without explicit user confirmation.
- One PR per branch. Keep branches focused so the PR description maps 1:1.

## Plan requirement

A plan is required before **substantial implementation** — any change that
spans packages, introduces a new route/tool/storage boundary, changes the
harness, or needs phased review.

- **Location:** `dev-docs/plans/YYYY-MM-DD-<slug>.md` (active). Move to
  `dev-docs/plans/completed/` only after the implementing PR merges.
- **Scaffold (refuses to overwrite):** `npm run work:plan -- --slug <kebab-case> --title "..."`.
- **Template:** `dev-docs/templates/plan.md` — must contain Goal, Constraints,
  Interfaces/data flow, Phases with exit criteria, Acceptance checks, and
  Decisions.
- **Status:** `Proposed` → `Accepted` (reviewed) → update to
  `Completed and merged in PR #...` on merge, then archive.
- Plans are intent, not a task board. Code, tests, and CI are the source of
  truth when a plan and the implementation disagree — fix the doc in the same
  PR. See [`docs/development/workflow.md`](docs/development/workflow.md) for
  the full plan/handoff/PR/archive lifecycle.

Small, single-file fixes and typo/documentation-only corrections do not require
a plan — mention the rationale in the PR description instead.

## Verification ladder

Do not guess which check to run. Follow
[`docs/development/verification.md`](docs/development/verification.md) and the
command hub in [`scripts/repo.mjs`](scripts/repo.mjs):

| Ladder | Command | What it runs | When |
|---|---|---|---|
| `fast` | `npm run verify -- fast` | Manifest + git hygiene + hub alias check (<2 s) | After every edit, before commit |
| `server` | `npm run verify -- server` | `server` typecheck + vitest | After touching `server/src/` |
| `web` | `npm run verify -- web` | `web` typecheck + vitest | After touching `web/src/` |
| `docs` | `npm run verify -- docs` | `handoff:check` + `release:check` + manifest coverage | After editing handoffs / changelog / manifest |
| `all` | `npm run verify -- all` | The four ladders in order (2–6 min) | Before requesting review on any non-trivial PR |

Rules:

- The hub never bypasses hooks or CI and preserves the original exit code — a
  green hub run is the only pass signal.
- CI (`.github/workflows/tests.yml`) runs the same checks; a local failure
  should reproduce in its matching CI job. If it does not, file a maintenance
  log entry — the disagreement is the bug.
- Also run `npm run status` to surface branch, recent commits, and any active
  handoff before pushing.

## PR evidence (required)

Every PR uses the template at [`.github/pull_request_template.md`](.github/pull_request_template.md).
Fill all five mandatory evidence sections — reviewers reject PRs that omit them:

1. **Scope** — what changed and what did not (package/area boundary).
2. **Commands / Tests run with evidence** — ladder commands, exit codes, and
   output or log links. Quote the command verbatim (`npm run verify -- server`).
3. **Docs touched** — every canonical doc reviewed/updated and the
   ownership/freshness row it maps to, or `None — no doc surface changed`.
4. **Security / Privacy impact** — secrets, sandbox egress, auth store, origin
   of imported code/skills, or `None`.
5. **Handoff disposition** — `None`, `Active: dev-docs/handoffs/active/<file>`,
   or `Archived/removed at <path>` with plan link.

Create the PR explicitly against the fork:

```bash
gh pr create --repo kgforais1/k-dense-byok-mcp --title "..." --body "..."
```

**CODEOWNERS:** deliberately not used. This fork has no stable per-area human
owners, so a `CODEOWNERS` file would auto-request reviewers who have not agreed
to that role. Reviews are assigned manually per PR.

## Handoff & archive duty

- If work will continue after the current session or another agent is asked to
  take over, create a branch-scoped handoff in `dev-docs/handoffs/active/`
  (`npm run work:handoff -- --plan dev-docs/plans/...` — refuses to overwrite).
  See the schema and removal rule in
  [`docs/development/workflow.md`](docs/development/workflow.md).
- Remove the handoff when the work merges, is abandoned, or is superseded. If
  it records an enduring operational decision or incident, distill that fact
  into [`dev-docs/maintenance-log.md`](dev-docs/maintenance-log.md) — do not
  keep a second state record.
- On merge, archive the plan to `dev-docs/plans/completed/` and update its
  status line to `Completed and merged in PR #...`.

## Documentation duty

When your change touches a doc's declared source of truth, update the doc in
the **same PR**. The owner/trigger table is in
[`docs/development/README.md#ownership-and-freshness`](docs/development/README.md#ownership-and-freshness).
`npm run docs:check` (via the `docs` ladder) catches structural drift;
reviewers catch semantic drift.

## Release notes

- User-facing behavior changes go under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md)
  using [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories
  (`Added`/`Changed`/`Deprecated`/`Removed`/`Fixed`/`Security`) with a PR link
  where useful. See
  [`docs/development/release-policy.md`](docs/development/release-policy.md).
- Security triage, dependency/tooling, CI, and operational decisions go in
  [`dev-docs/maintenance-log.md`](dev-docs/maintenance-log.md), not the
  changelog.

## Further reading

- [Developer documentation index](docs/development/README.md) — start here for ownership, freshness, and the full document set.
- [Architecture map](docs/development/architecture-map.md) — package boundaries and data flows.
- [Verification ladder](docs/development/verification.md) — the complete command-to-CI mapping.
- [Workflow](docs/development/workflow.md) — branch/plan/handoff/PR/archive lifecycle and resume protocol.
- [Release policy](docs/development/release-policy.md) — SemVer, changelog vs maintenance log, release automation.
- [Known limitations](docs/limitations.md) — trust boundary and product constraints.
