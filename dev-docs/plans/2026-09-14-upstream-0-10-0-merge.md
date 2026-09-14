---
title: "upstream-0-10-0-merge"
status: accepted
created: 2026-09-14
branch: merge/upstream-0-10-0
---

# Merge upstream v0.9.13 → v0.10.0 into the MCP fork

**Status:** Accepted

**Goal:** Merge the 38 upstream commits (K-Dense-AI/k-dense-byok `7b3e895..21a4ff6`, releases
0.9.13–0.10.0) into the fork while preserving fork behavior (billing/subscription, CodeQL
hardening, fork positioning), and adopt the fork-overlay rule for all future fork work.

## Why this work

Base `7b3e895` (2026-08-27). Since then upstream shipped provenance lineage + environment
capture, a Modal hardening series, extension-initiated system runs, follow-up queue, compaction,
raw-data guard, prompt templates, supervisor bridge, per-agent memory, custom model servers,
server-owned schedules/missions, "every Pi model provider", session-lifecycle/E2E fixes, and
release 0.10.0. The fork is 213 commits ahead on the same base; 30 files changed on both sides.
Staying unmerged compounds every future pull — merge now, then keep the fork additive.

## Design decisions

- Merge strategy: true `git merge upstream/main` (preserve both histories), NOT squash, NOT rebase.
- Conflict policy: upstream wins on shared upstream-owned files; fork behavior re-applied as
  additive overlays where possible (see fork-overlay rule below). Code wins over docs on facts.
- Version truth stays `server/package.json`; expect upstream at 0.10.0 — take the higher version.
- Out of scope: adopting upstream's GPT-6 Astra default blindly (check against our model/billing
  matrix); backporting our 213 fork commits upstream.

## Fork-overlay rule (new standing policy)

Prefer ADDITIVE fork changes over MODIFIED upstream files: new files, new modules, config/flags,
and narrow seam hooks beat in-place edits to upstream-owned code. Rationale: every modified
upstream file is a future merge conflict; every additive file merges clean. When an in-place edit
is unavoidable, isolate it behind a seam (named function, option flag) and mark it
`// FORK:` with a one-line why. Recorded in CONTRIBUTING.md#keeping-up-with-upstream.

## Proposed information architecture / file changes

```text
M (merge resolution, ~30 overlap files — hot: session-registry.ts, skills-install.ts,
  provenance/store.ts, modal/manager.ts + modal-tool.ts, cost/ledger.ts, sessions.ts,
  models.ts/billing, README.md, package.json)
+ dev-docs/plans/2026-09-14-upstream-0-10-0-merge.md (this file)
+ dev-docs/handoffs/active/<this-merge>.md
~ CONTRIBUTING.md#keeping-up-with-upstream (fork-overlay rule)
~ AGENTS.md (one-line pointer to the rule)
```

## Implementation sequence

### Phase 1 — Merge + mechanical resolution

- [x] Branch `merge/upstream-0.10.0`, `git merge upstream/main`
- [ ] Resolve textual conflicts (version bumps, lockfile, README title vs #47, docs)
- [ ] `npm run verify -- fast` green

**Exit criteria:** merge commit exists, no conflict markers, fast ladder green.

### Phase 2 — Semantic resolution (both sides changed behavior)

- [ ] `session-registry.ts` (system runs, follow-up queue, lifecycle vs fork session work)
- [ ] `skills-install.ts` (keep CodeQL Phase-2 `stageForSkill` gate against upstream refactors)
- [ ] `provenance/store.ts` + harvest (upstream lineage/env-capture vs fork harvest)
- [ ] `modal/*` (upstream hardening vs fork modal work)
- [ ] `models.ts`/billing/catalogue (every-provider vs subscription billing + Astra default)
- [ ] `npm run verify -- all` green; targeted tests for each seam

**Exit criteria:** full ladder green, no `<<<<<<<`, behavior checklist per file.

### Phase 3 — PR + policy landing

- [ ] Open PR against `kgforais1/k-dense-byok-mcp` main, bot findings triaged
- [ ] Two reviews (SHIP), merge, move this plan to `completed/`

**Exit criteria:** merged to main, plan archived, handoff closed.

## Guardrails

- Never push to / PR against upstream K-Dense-AI (pre-push hook + `--repo` flag).
- Do not lower coverage floors to make the merge pass.
- Do not reintroduce dismissed CodeQL patterns (path-injection sinks, weak randomness).
- Preserve fork billing semantics: subscription runs ledger $0, caps apply to payg only.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| Upstream 0.10.0 fully merged | `git merge-base --is-ancestor upstream/main HEAD`, version 0.10.0+ |
| No regressions | `npm run verify -- all` green |
| Future pulls cheaper | Overlay rule recorded; new fork code additive where feasible |
