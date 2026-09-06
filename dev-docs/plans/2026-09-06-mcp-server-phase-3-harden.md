---
title: "MCP server Phase 3 — harden and package"
status: proposed
created: 2026-09-06
branch: chore/todo-refresh-mcp-roadmap
---

# MCP Server Phase 3 — Harden, Document, Package (Partial)

**Status:** Proposed — deliberately partial. Scope depends on what Phase 2 actually built and what it deferred. Part of the [master plan](2026-09-06-mcp-server.md).

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. See
> `../../docs/development/workflow.md#archive-lifecycle`.

**Goal:** Turn the Phase 2 minimal server into something another human can install and use: client setup docs, packaging story, remaining §10 tools (or explicit deferrals), and a recorded entry point for the deferred CLI.

## Why this work

A working adapter nobody can install is a demo, not a feature. This phase is the difference — plus it closes the loop on the CLI question so the two interfaces share one tool core instead of forking.

## Design decisions

- Docs before packaging tweaks: `docs/mcp-server.md` must let a fresh client connect before any registry/publish step.
- CLI stays deferred but gets a recorded entry point (which adapter modules it will reuse) so the follow-up doesn't redesign.
- Full §10 surface is expand-as-needed; each added tool needs the same contract tests as Phase 2.

## Proposed information architecture / file changes

```text
docs/mcp-server.md              NEW — setup for OpenCode / Claude Code / Codex clients
server/src/mcp-server/          EXTEND — remaining tools or explicit deferrals
dev-docs/todo.md                UPDATE — CLI follow-up entry if not already present
```

## Implementation sequence

- [ ] Write `docs/mcp-server.md` and validate with a fresh-client walkthrough. Register the new doc per `docs/development/workflow.md` (Adding a new document) and `scripts/repo-manifest.json`.
- [ ] Settle packaging (stdio npx-style vs documented HTTP endpoint) per Phase 1/2 verdicts.
- [ ] Add or explicitly defer remaining §10 tools.
- [ ] Record the CLI entry point (adapter reuse map) and leave the CLI itself out of scope.

**Exit criteria:** fresh client connects via docs alone; packaging decided and working; CLI follow-up recorded, not built.

Archive note: archiving this file breaks the master plan's link to it — rewrite to `completed/…` in the same PR.

## Guardrails

- Same as Phase 2 (no secrets over tools, local-first, pin discipline, cross-platform).
- No registry publish or version-bump side effects — release automation stays the sole publisher.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| Installable by a third party | Fresh-client walkthrough transcript |
| No forked logic for the future CLI | Adapter reuse map recorded |

## Open questions

1. Packaging: npx distribution vs "point your client at localhost:8000" docs?
2. Which §10 tools make the cut vs defer?
3. Does anything in Phase 2 force an SDK upgrade (deliberate, test-gated path)?
