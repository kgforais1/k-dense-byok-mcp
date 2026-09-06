---
title: "MCP server Phase 2 — minimal server"
status: proposed
created: 2026-09-06
branch: chore/todo-refresh-mcp-roadmap
---

# MCP Server Phase 2 — Minimal Server (Partial)

**Status:** Proposed — deliberately partial. This phase hinges on Phase 1 verdicts (transport, process model, run-mapping, tool subset) and must be refined against them before implementation starts. Part of the [master plan](2026-09-06-mcp-server.md).

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. See
> `docs/development/workflow.md#archive-lifecycle`.

**Goal:** Build the smallest MCP server that lets an external client complete one Kady research task end-to-end (list scope → run research → fetch result) using only MCP tools backed by the existing HTTP API.

## Why this work

A minimal live loop validates the adapter approach before committing to the full §10 tool surface. If the thin-translation design holds for one loop, it generalizes; if not, Phase 1's fallback (revisit scope) triggers before sunk cost grows.

## Design decisions

- Thin translation only — tools call existing endpoints; no agent logic in the adapter. (To be confirmed against Phase 1 inventory.)
- Minimal subset TBD by Phase 1 (placeholder: project list/get, research run, result fetch).
- Local-only; project scoping via the existing `X-Project-Id` mechanism.

## Proposed information architecture / file changes

```text
server/src/mcp-server/      NEW — adapter (exact split TBD in Phase 1)
server/test/mcp-server/     NEW — tool-shape, scoping, contract tests
```

## Implementation sequence

- [ ] Scaffold the adapter per Phase 1 transport/process verdicts.
- [ ] Implement the minimal tool subset with contract tests (shape, project scoping, error mapping).
- [ ] End-to-end check from a real external MCP client (OpenCode or Claude Code) against a scratch project.
- [ ] Record deviations from this stub as Decisions.

**Exit criteria:** external client completes one research task via MCP tools only; tests green; deviations recorded.

## Guardrails

- Tools never return secrets; local trust boundary unchanged (`docs/limitations.md`).
- No casual SDK upgrades — deliberate, test-gated upgrades only (typecheck + tests).
- Cross-platform paths; no new network listeners beyond what Phase 1 decided.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| Loop works without raw HTTP | Client transcript using MCP tools only |
| Contract held | `server` ladder green incl. new tests |

## Open questions (for Phase 1 or Phase 2 kickoff)

1. Exact minimal tool subset and their schemas.
2. Error mapping: HTTP/SSE failures → MCP error responses.
3. Session lifecycle over MCP (who creates/reaps Pi sessions?).
