---
branch: "merge/upstream-0.10.0"
plan: "dev-docs/plans/2026-09-14-upstream-0-10-0-merge.md"
owner: ""
status: "in-progress"
updated: "2026-09-17"
---

# Active Handoff: merge/upstream-0-10-0

## Scope

Merge upstream K-Dense-AI/k-dense-byok `7b3e895..21a4ff6` (v0.9.13–v0.10.0, 38 commits) into the
fork. Base 2026-08-27; fork 213 ahead, upstream 38 ahead. 11 conflicted files.

## Decisions

- True merge (no squash/rebase); upstream wins on shared files, fork behavior re-applied as
  overlays; new fork-overlay standing policy (CONTRIBUTING + AGENTS.md).
- `git mv` refused (handoff file untracked) — used filesystem `mv` for the rename.

## Changed files

- `dev-docs/plans/2026-09-14-upstream-0-10-0-merge.md`: accepted plan with overlay rule.
- 11 conflicted: AGENTS.md, docs/limitations.md, server/package-lock.json,
  server/pi-packages/kady-{modal,pdf-annotations}/index.ts, server/src/agent/session-registry.ts,
  server/src/api/sessions.ts, server/src/cost/ledger.ts, server/src/index.ts,
  server/src/modal/manager.ts, web/src/components/pdf-viewer/pdf-viewer.tsx.

## Verification

- `git rev-list --left-right --count main...upstream/main` -> 213 / 38.
- Merge started on `merge/upstream-0.10.0`; 11 files in UU state, all resolved.
- Backend `typecheck` clean; backend vitest 1268 passed / 5 failed (all 5 are
  `session-observer.test.ts` timing flakes — proven environmental: pure
  `upstream/main` fails the same 5 in a worktree on this box; `python3
  --version` alone costs 115 ms here vs the test's 20 ms flush).
- `test/scheduler.test.ts` mock updated for merged route (`listSessionsLabelled`); 7/7 pass.
- Frontend `tsc --noEmit` clean, vitest 725/725.
- `npm run docs:check` green (after fixing handoff branch field to dotted name).

## Known failures / Rough edges

- skills-install.ts and provenance/store.ts AUTO-merged — Phase-2 semantic check still required
  (stageForSkill gate, harvest semantics).
- package-lock.json conflicted — resolve via fresh `npm install` in server/.

## Blockers

- None.

## Deferred follow-ups

- Evidence-package storage: tolerate and expose a corrupt package without letting it block new
  package preparation; account for its bytes conservatively and keep it removable.
- Run lifecycle: consolidate the legacy HTTP user-run path with `run-pipeline`; retain broker-based
  ownership and regression coverage until both paths share one lifecycle.

## Next action

Resolve the 11 conflicts file by file (lockfile + docs first, then code), then Phase-2
semantic review of auto-merged hot files.
