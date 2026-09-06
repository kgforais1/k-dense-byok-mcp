# Release Policy

This policy governs versioning, user-facing release notes, internal maintenance
records, and the automation that publishes a release. It is the canonical
reference for the release workflow declared in [`.github/AGENTS.md`](../../.github/AGENTS.md)
and the version contract in [`../../AGENTS.md`](../../AGENTS.md).

## Single source of truth for the version

- **`server/package.json` `version` is the only version.** The web package
  deliberately has no `version` field — `web/next.config.ts` injects
  `NEXT_PUBLIC_APP_VERSION` from the server package at build time. Do not add a
  `version` to `web/package.json`.
- The current version is whatever `server/package.json` declares — read it there;
  this doc intentionally does not hardcode it. Any bump is a
  **semantic versioning** change (see below) and is the event that the release
  workflow watches.
- The manifest entry `server-version-source` in `scripts/repo-manifest.json`
  tracks this invariant; `npm run release:check` validates it.

## Semantic Versioning

This project follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape. For this
**local desktop app**, the "public contract" (what a version bump promises) is:

- User-visible behavior (UI, CLI, launcher, file previews, workflows).
- Persisted project data under `projects/` and `sandbox/.kady/` / `.pi/`.
- Documented configuration and environment variables (see `AGENTS.md#configuration`).
- Supported local HTTP/API integrations (the sandbox API, sessions, model
  providers, Modal).

Internal refactors, undocumented implementation details, and private module
boundaries are **not** a public contract.

### Decision table

| Change | Example | Version bump |
|---|---|---|
| **PATCH** — compatible bug fix | Fix a provenance scan budget that truncated edges silently, correct a 404 in a viewer, fix a typecheck in `server/` | `0.9.12` → `0.9.13` (increment `PATCH`) |
| **MINOR** — backward-compatible capability | Add a new viewer, a new scientific helper `kind`, a non-breaking route, a new `docs:check` validation | `0.9.12` → `0.10.0` (increment `MINOR`, reset `PATCH`) |
| **MAJOR** — breaking public-contract change | Rename or remove a documented env var, change the on-disk `costs.jsonl` schema incompatibly, remove a documented API route, bump the Node floor to 24+ | `0.9.12` → `1.0.0` (increment `MAJOR`, reset `MINOR` and `PATCH`) |

While pre-`1.0.0` (`0.y.z`), breaking public-contract changes should bump `MINOR` (`0.y.z` → `0.(y+1).0`) with a `Changed`/`Removed` changelog entry that calls out migration. After `1.0.0`, `MAJOR` carries the breaking signal per standard SemVer.

If in doubt: PATCH when the changelog would be `Fixed`/`Security`; MINOR when it would be `Added` with `Changed` that is compatible; MAJOR (or pre-1.0 minor-as-major) when the release notes must carry a `BREAKING:` notice.

## CHANGELOG.md versus maintenance-log.md

The repository keeps two distinct records; do not merge them.

| Record | File | Purpose & timing | Required content | Not for |
|---|---|---|---|---|
| **Changelog** | [`../../CHANGELOG.md`](../../CHANGELOG.md) | User-facing release notes. Update the `## [Unreleased]` section in the **implementing PR** when shipped behavior changes; entries move under `## [X.Y.Z] - YYYY-MM-DD` as part of release preparation. | [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. Include a PR link where useful. | Internal cleanup narratives, exhaustive implementation detail, or every docs typo. |
| **Maintenance log** | [`../../dev-docs/maintenance-log.md`](../../dev-docs/maintenance-log.md) | Internal, **append-only** record **in the implementing PR** for security triage, dependency work, CI/tooling, operational decisions, and non-obvious verification. | Date, PR/commit, category (`security` / `dependency` / `ci-tooling` / `operational` / `verification`), summary, evidence (commands, logs, links), and follow-up if needed. | A substitute for the changelog or for active state. |
| **Plan** | `dev-docs/plans/` | Proposed/accepted intent **before** substantial implementation. | Goal, constraints, interfaces, phases, acceptance checks, decisions. | A live task board or a release note. |
| **Active handoff** | `dev-docs/handoffs/active/` | Short-lived continuation state for work that **crossed a session or agent boundary**. | Branch, required local plan path, status, updated date, scope, decisions, changed files, verification, blockers, one next action. | Long-term history, a lock, or a replacement for commits/PRs. |

An issue may be linked from the plan or handoff body, but it is **not** a
substitute for the required local plan reference in the handoff frontmatter.

### Changelog shape

At least these headings must be present (`npm run release:check` validates
them):

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.12] - 2026-09-02
```

- Every shipped-behavior change gets an `Unreleased` entry in the PR that
  introduces it. Release preparation moves entries under the new `## [X.Y.Z]`
  heading with the release date — that move is part of the version-bump PR,
  not a follow-up.
- The advisory script `npm run release:check` checks the file for the
  `Changelog` heading, the Keep-a-Changelog preamble line, and the
  `Unreleased` section. It warns when the current `server/package.json`
  version has no listed entry and no `Unreleased` is present.

## Release automation

- **Workflow:** [`.github/workflows/release.yml`](../../.github/workflows/release.yml).
  It runs on every push to `main` (only `main`).
- **Behavior:** The workflow reads `version` from `server/package.json`,
  derives `tag = v<version>`, and checks whether `refs/tags/<tag>` already
  exists (`git rev-parse`). If the tag does **not** exist, it creates it with
  `gh release create <tag> --generate-notes` (auto-generated release notes
  from merged PRs since the previous tag). If the tag already exists, the
  workflow is a no-op.
- **What triggers a release:** bumping `server/package.json` `version` and
  pushing/merging that bump to `main`. That is the only path to a release.
- **Evidence:** the tag and GitHub release with generated notes are the
  release record; the changelog move under `[X.Y.Z] - YYYY-MM-DD` is the
  curated human note.

### No-manual-tag rule

- **Never** create a `v<version>` tag by hand (`git tag`, `gh release create`
  from a workstation, or any tag push).
- **Never** push tags directly to the fork or upstream (`git push --tags`,
  `git push origin v...`).
- **Never** use `git push --no-verify` or any hook-bypass flag — ask the
  user first and get explicit confirmation, as required by [`AGENTS.md`](../../AGENTS.md).
- The release workflow is the sole publisher. A manual tag that races with
  the workflow creates a drifted release and a missing notes generation step.

## Release-readiness check (advisory)

- **Command:** `npm run release:check` (deterministic, offline, part of
  `npm run verify -- docs` / `npm run docs:check` and the `docs` ladder).
- **What it validates:**
  - `server/package.json` carries a SemVer `version`.
  - `web/package.json` does **not** carry a `version` field.
  - `CHANGELOG.md` has the `Changelog` heading, the Keep-a-Changelog
    preamble, and an `## [Unreleased]` section.
  - When the current version is not yet released, an `Unreleased` section
    exists; otherwise the current version is listed.
- **Advisory only** until it has survived the pilot — it never tags,
  publishes, or rewrites history. The pilot exits when the baseline
  navigation/verification exercise improves measurably and maintainers agree
  the scheduled gardening load is proportionate (see the harness plan
  Phase 6).
- **Templates:** `dev-docs/templates/release-readiness.md` is the checklist
  for release preparation (single version source, changelog move,
  Keep-a-Changelog categories, ledger pass, no dirty state, fork PR target).

## Updating this policy

Changes to versioning, changelog, maintenance-log, or release-readiness rules
are themselves product-behavior changes: update this doc and the matching
ownership row in [`README.md#ownership-and-freshness`](README.md#ownership-and-freshness)
in the same PR as the underlying change. The PR's **Docs touched** section
must name this file when the policy changes.
