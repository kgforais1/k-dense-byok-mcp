---
title: "Fork etiquette leftovers — attribution cleanup"
status: completed
created: 2026-09-18
branch: fork-etiquette-leftovers
---

# Fork etiquette leftovers — attribution cleanup Implementation Plan

**Status:** Completed and merged in PR #34

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. That same PR must record the
> result in `CHANGELOG.md`, `dev-docs/maintenance-log.md`, or both. See
> `docs/development/workflow.md#archive-lifecycle`.

**Goal:** Finish the deliberately-deferred fork-etiquette items in todo §6, so every reader-facing surface either names this fork or stops presenting upstream's channels and unverifiable counts as this fork's own.

Recorded as [todo "Make this repo read as a fork"](../../todo.md) (section 6, deleted on shipment in PR #34).

## What is actually there

Measured 2026-09-18 on `main` at `5ae0604`. Two claims in todo §6 are wrong (flagged inline); per the repo source-of-truth order, measured truth wins and the implementing PR corrects the todo.

1. **Badges** (`README.md:3-7`): five shields. The License MIT shield links to the local `LICENSE`, and the fork notice at `README.md:16-18` states that licence covers this repo too — **keep**. The other four (X `@k__dense__ai`, LinkedIn K-Dense Inc., YouTube `@K-Dense-Inc`, Reddit `u/-k-dense-`) are K-Dense's channels. The fork notice qualifies them ("refer to the upstream project and its authors, not to this fork") rather than resolving them. The fork has no channels of its own — public, not promoted, no support commitment (decided 2026-09-12) — so there is nothing to replace them with.
2. **Fork notices**: present only in `README.md:9-26`. Absent from all 28 files under `docs/*.md`, including `docs/installation.md` (whose only "fork" mention is issue routing at `:145`) and `docs/limitations.md` (routes Windows issues to this fork's tracker at `:136` but never states the relationship). The todo's claim that both files carry a notice is wrong.
3. **Skills figure**: all four prose sites now say **149** (`README.md:89`, `docs/basic-usage.md:20`, `docs/codebase-summary.md:12`, `docs/installation.md:98` — "downloads the catalogue of 149 scientific skills") — the 140+ inconsistency recorded in the todo is stale; the figure is consistent but unverifiable locally. Skills sync from `K-Dense-AI/scientific-agent-skills` at whatever revision arrives (`server/src/config.ts:42`, `KADY_SKILLS_REPO` override), so no local count can settle it. Workflows 326 and databases 229 were verified against `web/src/data/workflows.json` and `databases.json` — keep, but they currently have no check behind them.
4. **Already correct — verify, don't touch**: `CONTRIBUTING.md` (fork-first workflow, fork guard, upstream-sync policy), `SECURITY.md` (private advisories for this fork, "this repository only", upstream issues routed upstream), `.github/pull_request_template.md:98` (target must be this fork). `.github/workflows/upstream-sync-check.yml:35` names `K-Dense-AI:main` by design (drift detection) — keep. No `ISSUE_TEMPLATE` directory exists. Technical references to the default skills catalogue (`docs/skill-management.md:5,133`, `docs/development/architecture-map.md:258`) are correct references, not attribution gaps. `README.md:243` ("K-Dense believes in giving back") is inherited product prose covered by the top fork notice — out of scope; rewriting attribution line-by-line is unbounded.

## Design decisions

- **Remove the four social shields; keep the License shield.** Nothing regenerates or replaces them (no fork channels exist), and per the todo's own drift rule a badge without a check is a future lie. This resolves the todo's "judgement call" for the social four; the License shield was never in question.
- **Do not add fork-owned social badges** — there is nothing to link to while the fork is unpromoted. If that ever changes, the new badges ship with a check.
- **Skills figure: drop the number, name the source.** Reword the four prose sites to point at the default catalogue repo plus the `KADY_SKILLS_REPO` override instead of asserting a count — the todo's "either name that revision or drop the figure", and naming a revision of a repo we do not control is the weaker option.
- **Fork notices: one short line atop the remaining user-facing docs.** Candidate wording (final in implementation, reviewed in PR): `> **Fork note:** this is the [kgforais1/k-dense-byok-mcp](https://github.com/kgforais1/k-dense-byok-mcp) fork of [K-Dense-AI/k-dense-byok](https://github.com/K-Dense-AI/k-dense-byok); product prose below is upstream's work except where noted.` Skip `docs/development/*` — contributor-internal, already fork-scoped via `AGENTS.md`/`CONTRIBUTING.md`.
- **Counts check: assert 326/229 in `docs:check`.** Extends the todo's "add a check with them" principle from badges to prose: `scripts/docs-check.mjs` counts `web/src/data/workflows.json` / `databases.json` entries and fails if they differ from the figures asserted in prose. If `docs:check` proves the wrong home (structural vs content), a standalone script plus a `Checks` workflow step is the fallback — record the decision in the implementing PR.
- **`LICENSE`: verification only.** Confirm the MIT grant covers this repo (as `README.md:18` claims) and record the outcome; do not rewrite licence text.
- **Out of scope**: `README.md:243` prose, skills-catalogue technical references, `upstream-sync-check.yml`, re-adding any badge.

## Proposed information architecture / file changes

```text
README.md                                    # remove 4 social shields; drop 149 figure
docs/basic-usage.md                          # drop 149 figure; add fork notice
docs/codebase-summary.md                     # drop 149 figure; add fork notice
docs/installation.md                         # drop 149 figure; add fork notice
docs/<25 remaining user-facing docs>         # add one-line fork notice
scripts/docs-check.mjs                       # counts assertion for 326/229
dev-docs/todo.md                             # §6: "Planned in [...]" pointer + fix wrong claims (implementing PR)
```

## Implementation sequence

### Phase 1 — Badges and the skills figure

- [ ] Remove the four social shields from `README.md:4-7`; keep the License shield.
- [ ] Reword the four "149 skills" prose sites (`README.md:89`, `docs/basic-usage.md:20`, `docs/codebase-summary.md:12`, `docs/installation.md:98`) to name the catalogue source instead of a count.
- [ ] Re-read the README fork notice after badge removal — it references "social links" at `:16`, which will no longer exist on the page; adjust that sentence.

**Exit criteria:** no shields pointing at K-Dense channels; no bare skills count in prose; the fork notice still describes the page accurately.

### Phase 2 — Fork notices across docs/

- [ ] Add the one-line notice to all 28 user-facing `docs/*.md` files (none has one today); skip `docs/development/*`.
- [ ] Keep the wording byte-identical across files so a future `grep` can audit it.

**Exit criteria:** every user-facing doc states the fork relationship exactly once.

### Phase 3 — Counts check

- [ ] Assert workflows/databases JSON entry counts match the prose figures in `docs:check` (fallback: standalone script + `Checks` step; record the call).
- [ ] Confirm the check fails loudly on a mismatch (bump a count in a scratch copy, run, revert).

**Exit criteria:** moving 326/229 without updating prose fails a CI check.

### Phase 4 — Verification and close-out

- [ ] `npm run verify -- docs` and `npm run verify -- fast` green.
- [ ] Implementing PR adds the "Planned in" pointer to todo §6, fixes the wrong claims (installation.md + limitations.md notices, 140+ inconsistency), moves this plan to `completed/`, sets final status, records handoff disposition (no active handoff exists for this work — mark N/A in the PR closing checklist), and records in `CHANGELOG.md` and/or `maintenance-log.md` per the archive lifecycle.

**Exit criteria:** plan archived; todo §6's remaining items either done or re-pointed.

## Guardrails

- Never push to / PR against upstream K-Dense-AI (pre-push hook + `--repo` flag).
- Do not touch the skills-catalogue technical references (`skill-management.md`, `architecture-map.md`) or `upstream-sync-check.yml`.
- Do not rewrite `LICENSE` text; verification only.
- No new badges without a check that regenerates or asserts them (the drift rule).
- Docs-only change: no `server/` or `web/` code, no test changes except the docs-check assertion itself.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| No fork-external channels presented as this repo's | `grep -n "img.shields" README.md` shows only the License shield |
| No unverifiable skills count in prose | `grep -rn "149" README.md docs/basic-usage.md docs/codebase-summary.md docs/installation.md` returns nothing |
| Every user-facing doc names the fork | `grep -L "Fork note" docs/*.md` is empty |
| Kept counts can't drift | docs:check fails on a scratch count bump |
| Lifecycle followed | plan in `completed/`, todo §6 pointed and corrected, CHANGELOG/maintenance-log recorded |
