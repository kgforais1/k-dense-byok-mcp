---
title: "MCP server Phase 2 — minimal server"
status: proposed
created: 2026-09-06
branch: mcp-work
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
- Minimal subset decided in Phase 1: `list_projects`, `get_session_history`, `start_research_run`, `poll_run` (see the Phase 1 Decisions for the transport/process verdicts).
- Local-only; project scoping via the existing `X-Project-Id` mechanism.

## Proposed information architecture / file changes

```text
server/src/mcp-server/      NEW — adapter (exact split TBD in Phase 1)
server/test/mcp-server-*.test.ts   NEW — tool-shape, scoping, contract tests
  (flat files, per the existing `server/test/` convention)
```

## Implementation sequence

- [ ] Scaffold the adapter per Phase 1 transport/process verdicts.
- [ ] Implement the minimal tool subset with contract tests (shape, project scoping, a bind assertion on the shared Fastify listener — it must bind `127.0.0.1` — and error mapping incl. the distinct budget-403 and the ~30s completed-handle retention reconciliation).
- [ ] End-to-end check from a real external MCP client (OpenCode or Claude Code) against a scratch project.
- [ ] Record deviations from this stub as Decisions.

**Exit criteria:** external client completes one research task via MCP tools only; tests green; deviations recorded.

Archive note: archiving this file breaks the master plan's link to it — rewrite to `completed/…` in the same PR.

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

1. Exact schemas for the four decided tools (`list_projects`, `get_session_history`, `start_research_run`, `poll_run`).
2. Error mapping: HTTP/SSE failures → MCP error responses. Budget-blocked runs surface as a `kind:"budget"` *frame* inside an HTTP-200 SSE stream (not a 403), so the mapping must inspect terminal frames — and `poll_run` needs a durable-result source given no first-class per-run terminal endpoint exists today.
3. Session lifecycle over MCP (who creates/reaps Pi sessions?) — load-bearing: the decided subset cannot bootstrap a new session, so resolve before the end-to-end loop is implementable.
4. Transport session mode: StreamableHTTP stateful vs stateless, and whether/how the transport session id relates to a Kady Pi session (recorded in Phase 1 Decisions). In stateful mode each request maps to a `StreamableHTTPServerTransport` keyed by the SDK `Mcp-Session-Id` header — the adapter must cache transports per session id (or choose per-request stateless), otherwise stateful mode breaks across requests.
5. `start_research_run` image attachments: mirror the existing inline `images: [{data, mimeType}]` run body so image content from the MCP client (base64 in its content array) reaches the model; otherwise image-carrying research is silently text-only.
6. `poll_run` vs `get_session_history` contract: both can read `/sessions/:id/history`; define which returns "new messages since run baseline" vs "whole transcript" to avoid double-fetching and a duplicated tool surface.
7. Provider refusals (e.g. Anthropic Mythos/Fable refusals) reach the client as a terminal `error` frame inside the run, not as an MCP tool error — decide how `poll_run` surfaces them (reuse `model-refusal.ts` guidance).
