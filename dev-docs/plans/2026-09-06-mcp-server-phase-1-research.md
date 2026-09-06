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

Phase 2 scope hinges on transport (stdio vs StreamableHTTP), run-mapping (SSE → MCP), and which tools are minimal-viable. Guessing any of these risks building the wrong adapter. A short spike against the real backend and the declared SDK range (`@modelcontextprotocol/sdk` `^1.29.0`) resolves them cheaply — validate server-side exports against the lockfile-resolved version `1.29.0`.

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
- [ ] Inventory blocking/headless-hostile tools — notably `interview` (blocks a run on a chat-UI answer; withheld from subagent child processes for this reason) — and decide for MCP-driven sessions: disable, surface as MCP elicitation, or map to a tool result.
- [ ] Confirm server-side exports available at the declared `@modelcontextprotocol/sdk` range against the lockfile-resolved version `1.29.0` (`McpServer`, stdio + StreamableHTTP transports) and record the exact resolved version.
- [ ] List the HTTP endpoints backing each candidate §10 tool (projects, sessions/run SSE, files, notebook).

**Exit criteria:** inventory written down; no open "what exists?" questions remain.

### Phase 1b — Prototype (throwaway)

- [ ] Stand up one read-only tool (e.g. project list) over the leading transport candidate.
- [ ] Attempt one live run-mapping experiment (SSE run → MCP progress or poll) and record what worked.
- [ ] Record verdicts for master-plan questions 1–7 (answered or explicitly deferred with a reason), including CLI-ordering (Q6) and interview-handling (Q7).

**Exit criteria:** decision record complete; Phase 2 plan updated to match; spike code discarded or clearly quarantined.

Archive note: archiving this file breaks the master plan's link to it — rewrite to `completed/…` in the same PR.

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

Record each master-plan open question as **answered** or **deferred** (with reason) before Phase 2 starts. Include inherited decisions from the master plan (e.g. CLI default: after hardening).

1. Transport (stdio vs StreamableHTTP): **Answered:** SSEServerTransport (HTTP over standard SSE) works cleanly.
2. Process model (in-process vs sidecar): **Answered:** In-process. By mounting the MCP routes directly on the existing Fastify server, we reuse the `X-Project-Id` scope and avoid duplicating state or budgets.
3. SSE run → MCP mapping (progress vs poll): **Answered:** Poll. Since agent runs are long, `start_research_run` will return a run ID and the client can use `poll_run` to check status. This prevents MCP tool timeout.
4. Minimal-viable tool subset: **Answered:** `list_projects`, `get_session_history`, `start_research_run`, `poll_run`.
5. Project-scoping/auth UX (local-first; remote out of scope): **Answered:** Pass `X-Project-Id` in the MCP client connection headers, reusing existing scoping.
6. CLI ordering (before vs after hardening): _inherited — after, reusing the adapter; revisit only if Phase 1 finds MCP blocked_
7. Interview handling for MCP-driven sessions (disable / elicitation / tool result): **Answered:** Disable. `interview` is an interactive chat form not supported by standard MCP. MCP-driven sessions must skip it.
