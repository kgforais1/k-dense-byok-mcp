---
title: "MCP server Phase 1 — research spike"
status: proposed
created: 2026-09-06
branch: chore/todo-refresh-mcp-roadmap
---

# MCP Server Phase 1 — Research Spike and Decisions

**Status:** Proposed

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. See
> `docs/development/workflow.md#archive-lifecycle`.

**Goal:** Answer the master plan's open questions with a timeboxed spike so Phase 2 has a decided transport, process model, and tool subset. Part of the [master plan](2026-09-06-mcp-server.md).

## Why this work

Phase 2 scope hinges on transport (stdio vs StreamableHTTP), run-mapping (SSE → MCP), and which tools are minimal-viable. Guessing any of these risks building the wrong adapter. A short spike against the real backend and the pinned SDK resolves them cheaply.

## Design decisions

- Spike, don't ship: throwaway or clearly-marked prototype code only; nothing in this phase lands as product surface.
- Decide in writing: each master-plan open question gets an answered / deferred verdict recorded in this file's Decisions section before Phase 2 starts.

## Proposed information architecture / file changes

```text
(no product files; spike code lives in tmp/ or a scratch branch and is discarded)
dev-docs/plans/2026-09-06-mcp-server-phase-1-research.md  THIS FILE (+ Decisions)
dev-docs/plans/2026-09-06-mcp-server-phase-2-server.md    refined with Phase 1 verdicts
```

## Implementation sequence

### Phase 1a — Inventory (read-only)

- [ ] Map the existing MCP-related code — the client bridge (`server/src/agent/mcp.ts`) plus the server-side config API (`server/src/api/mcp.ts`, Fastify settings endpoints for MCP client configs) — and note what transports/patterns already exist in-repo.
- [ ] Confirm server-side exports available at the pinned `@modelcontextprotocol/sdk` version (`McpServer`, stdio + StreamableHTTP transports) and record the exact resolved version.
- [ ] List the HTTP endpoints backing each candidate §10 tool (projects, sessions/run SSE, files, notebook).

**Exit criteria:** inventory written down; no open "what exists?" questions remain.

### Phase 1b — Prototype (throwaway)

- [ ] Stand up one read-only tool (e.g. project list) over the leading transport candidate.
- [ ] Attempt one live run-mapping experiment (SSE run → MCP progress or poll) and record what worked.
- [ ] Record verdicts for master-plan questions 1–5 (answered or explicitly deferred with a reason).

**Exit criteria:** decision record complete; Phase 2 plan updated to match; spike code discarded or clearly quarantined.

## Guardrails

- No credentials in spike code, logs, or pasted transcripts.
- No changes to product behavior; backend runs locally only during the spike.
- Timebox: if a question resists the spike, mark it deferred with a reason rather than expanding the spike.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| Transport + process model decided | Verdict recorded in Decisions with the experiment behind it |
| Run-mapping approach chosen | Spike transcript or explicit deferral |
| Phase 2 is implementable | Refined Phase 2 plan references these verdicts |

## Decisions

(Record Phase 1 verdicts here as they are made.)
