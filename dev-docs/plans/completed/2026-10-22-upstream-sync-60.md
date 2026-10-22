---
title: "Upstream sync #60"
status: completed
created: 2026-10-22
branch: claude/relaxed-mayer-64s1am
---

# Upstream sync #60 Implementation Plan

**Status:** Completed and merged in PR #61

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. That same PR must record the
> result in `CHANGELOG.md`, `dev-docs/maintenance-log.md`, or both. See
> `docs/development/workflow.md#archive-lifecycle`.

**Goal:** Merge the single upstream-only commit `6a55f5ce6f4b` ("Upgrade Pi to
1.3.0, pi-subagents to 0.78.0, pi-web-access to 0.41.0") into the fork, moving
the harness from Pi 1.1.0 to 1.3.0 without losing fork seams.

## Why this work

Issue #60 (weekly `upstream-sync` check) reports one upstream-only commit. It
is a harness upgrade, so it also settles most of issue #16 (Pi harness updates
available): Pi `1.1.0 → 1.3.0`, `pi-web-access 0.40.0 → 0.41.0`;
`pi-subagents` is already `0.78.0` on both sides.

Upstream commit summary (44 files, +930/−325):

- Re-anchor subagent host seams for pi-subagents 0.78; drop the runner-alias
  seam (now handled by the plugin).
- Rename the Azure provider to `azure` with a legacy-id alias
  (`canonicalProviderId` in `provider-catalog.ts`).
- Prune stale saved OpenRouter catalogs so pricing tiers stay current.
- Hide pi-subagents' parent-wake prompt from chat, history and exports.
- Read targets of built-in named workflows (`parallel`, `review`, `run-ci`).
- Upgrade unchanged seeded subagent prompts/skills on plugin updates.
- Calendar/mission schedules and realpath-keyed mission stores.
- Enable `activeRunsPrompt`; add a Ceramic search key to Settings → Services.

## Complexity assessment

**Moderate.** One commit, but it is a harness upgrade that overlaps work the
fork already did independently (PR #57 harness pins; the Pi 1.1 Azure
rename). A trial `git merge upstream/main` on `origin/main@f65f533`
auto-merges 33 files and conflicts in 11:

| File | Hunks | Nature | Resolution |
|---|---|---|---|
| `server/package.json` | 2 | Pins | Take upstream Pi 1.3.0 / pi-web-access 0.41.0; **keep fork** `skills 1.7.2` (upstream 1.7.0) and fork-only scripts/deps/engines. |
| `server/package-lock.json` | 15 | Generated | Never hand-merge: take fork side, then `npm install` in `server/` to regenerate. |
| `AGENTS.md` | 2 | Prose | Merge both: upstream's 0.78 workflow wording + new pin versions, keep fork prose. |
| `server/src/agent/models.ts` | 2 | Same feature twice | Fork has `normalizeProviderId` (Pi 1.1 Azure rename); upstream has `canonicalProviderId`. Adopt upstream's `canonicalProviderId` as the single table; make `normalizeProviderId`/`normalizeModelRef` thin wrappers (or replace callers in `session-registry.ts`, `verifier-models.ts`, `models.test.ts`). Keep fork's `getContextWindow` import. |
| `server/src/agent/session-registry.ts` | 2 | Imports + cold-open restore | Union imports (fork's `catalogueEntryFor`/`isLocalProvider` + upstream's `pruneStaleOpenRouterCatalog`); adopt upstream's "removed custom provider must not fall back to OpenRouter" guard on top of fork's restore path. |
| `server/src/agent/subagent-bridge.ts` | 3 | Fork refactor vs upstream inline | Fork split `readReplyWorkflowScript` into helpers (`assistantReply`, `issuedThisCall`, `workflowFenceBody`). Keep fork structure, port upstream's behavior delta (named built-in workflows, fence parsing) into the helpers. Highest-judgment file. |
| `server/test/subagent-runner-aliases.test.ts` | 2 | Diverged tests | Upstream dropped the alias seam; fork's tests cover the optional-subpath rule. Keep the tests that still describe behaviour under 1.3 (incl. Pi 1.2 dropping `@earendil-works/chord`); drop any asserting the removed seam. |
| `server/test/backend.test.ts` | 3 | Tests | Union. |
| `server/test/subagent-runtime.test.ts` | 4 | Tests | Union. |
| `server/test/subagent-integration.test.ts` | 1 | Tests | Union. |
| `web/src/components/chat-tab.tsx` | 1 (265 lines) | Fork reformat vs 1-line comment | Take fork side, re-apply upstream's one-line comment change by hand. |

Main risk is not the textual conflicts but **semantic drift from Pi 1.1 → 1.3
in fork-only code** (inbound MCP server, headless sessions, verifier models,
fork `pi-packages`), which the merge will not flag. The full test ladder and
a targeted check of Pi API usage in fork-only files are the guard.

## Outcome

Resolved as the table above describes, with two deviations. The fork's
`normalizeProviderId` was removed rather than aliased (`normalizeModelRef`
now wraps `canonicalProviderId`). `session-registry.ts` kept the fork's
`persistedModel` instead of upstream's restore guard, because the fork's
version already restricts `resolveModel` to local providers. See the
2026-10-22 entry in `dev-docs/maintenance-log.md` for verification evidence.

## Design decisions

- Merge, never rebase (`CONTRIBUTING.md#keeping-up-with-upstream`); upstream
  wins on product code, fork wins on fork-owned files.
- One provider-rename table: upstream's `RENAMED_PROVIDERS` /
  `canonicalProviderId`. The fork's duplicate goes away (or becomes an alias)
  so the next sync does not conflict again.
- Keep `skills 1.7.2` (fork pin, PR #57) — downgrading would regress skill
  staging.
- Out of scope: bumping beyond upstream (pi-web-access 0.42.0, Pi > 1.3.0 from
  issue #16). Issue #16 stays open for the remainder; refresh its body/comment.

## Proposed file changes

```text
M  server/package.json, server/package-lock.json (regenerated)
M  server/src/agent/{models,session-registry,subagent-bridge}.ts (+ auto-merged upstream files)
M  server/src/agent/verifier-models.ts (only if callers of normalize* change)
M  server/test/* (conflict union + any fork tests broken by Pi 1.3)
M  web/src/components/chat-tab.tsx
M  AGENTS.md, server/AGENTS.md, docs/development/architecture-map.md (pin versions)
M  CHANGELOG.md, dev-docs/maintenance-log.md
D  dev-docs/plans/2026-10-22-upstream-sync-60.md → plans/completed/
```

## Implementation sequence

### Phase 1 — Merge and resolve

- [x] `git fetch upstream main && git merge upstream/main` on this branch.
- [x] Resolve the 11 conflicts per the table; regenerate the lockfile with `npm install` in `server/`.
- [x] Grep fork-only code for Pi APIs changed in 1.2/1.3 (`@earendil-works/chord`, session/registry/auth APIs) and fix.

**Exit criteria:** no conflict markers; `npm run typecheck` and `npm run lint` pass in `server/` and `web/`.

### Phase 2 — Verify

- [x] `npm run verify -- all` green (server + web vitest, docs, manifest).
- [x] `npm run test:coverage` in both packages still meets floors.
- [x] Targeted: `models.test.ts` (Azure legacy refs), `subagent-*.test.ts`, inbound MCP tests, `provider-catalog.test.ts` against live Pi 1.3.
- [x] Ratchets in sync (pre-commit/pre-push hooks).

**Exit criteria:** all green; any fork test changed is justified in the PR.

### Phase 3 — Close out

- [x] Maintenance-log entry (commits merged, conflicts resolved, evidence); CHANGELOG `Unreleased` entry for the Pi 1.3 upgrade.
- [x] Update pin versions in AGENTS.md / server/AGENTS.md / architecture map.
- [x] Move this plan to `plans/completed/` with final status; PR body `Closes #60`; comment on #16 with what remains.

## Guardrails

- No push to upstream; no `--no-verify`; no hand-edited lockfile.
- Do not weaken cost/budget gates, inbound MCP safeguards, or provenance invariants.
- Saved refs using `azure-openai-responses` must still resolve (read-time only, no config rewrite).
- PR stays under 100 files.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| Fork on Pi 1.3.0 with upstream behavior | `npm run verify -- all` exit 0; CI green |
| Fork seams preserved | Targeted MCP / headless / verifier tests pass; `// FORK:` markers intact |
| Legacy Azure refs resolve | `models.test.ts` legacy-ref cases |
| Reviewable record | Maintenance-log entry + PR closing #60 |
