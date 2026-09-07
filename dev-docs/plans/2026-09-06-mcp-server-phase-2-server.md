---
title: "MCP server Phase 2 — minimal server"
status: accepted
created: 2026-09-06
branch: mcp-phase-2
---

# MCP Server Phase 2 — Minimal Server

**Status:** Accepted — implementation started from the Phase 1 decision record. Part of the [master plan](2026-09-06-mcp-server.md).

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. See
> `docs/development/workflow.md#archive-lifecycle`.

**Goal:** Build the smallest MCP server that lets an external client complete one Kady research task end-to-end (list scope → run research → fetch result) using only MCP tools backed by the existing HTTP API.

## Why this work

A minimal live loop validates the adapter approach before committing to the full §10 tool surface. If the thin-translation design holds for one loop, it generalizes; if not, Phase 1's fallback (revisit scope) triggers before sunk cost grows.

## Design decisions

- Thin translation only — tools call existing endpoints; no agent logic in the adapter.
- Minimal subset decided in Phase 1: `list_projects`, `create_research_session`, `get_session_history`, `start_research_run`, `poll_run` (see the Phase 1 Decisions for the transport/process verdicts). `create_research_session` wraps `POST /sessions`, returns the Kady session id required by the latter three session-scoped tools, and is the provisioning path for a fresh external client.
- Local-only; project scoping via the existing `X-Project-Id` mechanism. `KADY_MCP_ENABLED=1` opts into Kady's inbound MCP server. When it is enabled, startup rejects every non-loopback `KADY_HOST` value (including `0.0.0.0`) before mounting or serving MCP routes; `127.0.0.1` remains the supported default.

## Proposed information architecture / file changes

```text
server/src/mcp-server/      NEW — adapter (exact split TBD in Phase 1)
server/src/agent/run-results.ts  NEW — persisted terminal records keyed by `runId`
server/test/mcp-server-*.test.ts   NEW — tool-shape, scoping, contract tests
  (flat files, per the existing `server/test/` convention)
```

## Implementation sequence

- [x] Establish the opt-in `KADY_MCP_ENABLED` gate and fail-closed shared-listener assertion; contract-test the `127.0.0.1` default and non-loopback rejection before MCP routes exist.
- [~] Scaffold the adapter per Phase 1 transport/process verdicts: stateful Streamable HTTP now mounts at opt-in `/mcp` and serves the contract-tested `list_projects` tool; the remaining four tools follow in this phase.
- [ ] Before exposing MCP runs, disable `interview` for MCP-created sessions and add the MCP-specific system-prompt/skill note required by Phase 1; contract-test that the tool is absent and the replacement guidance is present.
- [x] Add a durable terminal-result record keyed by `runId` under the existing per-project run-data tree and a lookup that returns its terminal status/result after the broker's ~30s retention expires; `poll_run` must read the broker while live and the persisted record afterward.
- [ ] Implement the minimal tool subset with contract tests (shape, project scoping, fresh-client `create_research_session` → run/poll flow, a bind assertion that preserves the `127.0.0.1` default and rejects every non-loopback `KADY_HOST` value — including `0.0.0.0` — whenever MCP is enabled, durable terminal-result lookup, and error mapping). The run-start contract must map **only** `RunAlreadyActiveError` — either via a typed `reason` preserved by `/sessions/:id/run` or by the adapter's direct `runBroker` rule — to the MCP “run already active” response. Its test must force both that concurrent case and an unrelated `start()`/`publish()` failure: the former gets that response; an HTTP 500 unrelated failure preserves its actual mapped failure rather than being mislabeled as concurrency. It must also distinguish the `/steer`-only HTTP 403 from the run's `kind:"budget"` frame on an HTTP-200 stream, plus a post-expiry poll that retrieves the durable terminal record.
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

1. Exact schemas for the five decided tools (`list_projects`, `create_research_session`, `get_session_history`, `start_research_run`, `poll_run`).
2. Error mapping and result durability — **resolved:** HTTP/SSE failures map to MCP responses, while budget-blocked runs surface as a `kind:"budget"` *frame* inside an HTTP-200 SSE stream (not a 403), so the mapping inspects terminal frames. Phase 2 persists a terminal record keyed by `runId` under the existing project run-data tree and has `poll_run` use it after the broker's ~30s retention expires; an unknown `runId` remains distinct from an expired completed run.
3. Session lifecycle over MCP — **resolved:** `create_research_session` is a required session-management tool backed by `POST /sessions`; fresh clients call it once per research thread and pass the returned id to history/start/poll. The adapter never creates a session during a run or poll. It inherits existing lifecycle semantics: live idle sessions are LRU-evicted at the backend's per-project cap, while persisted JSONL transcripts are retained until the existing project lifecycle removes them; Phase 2 adds no adapter-only reaper.
4. Transport session mode: StreamableHTTP stateful vs stateless, and whether/how the transport session id relates to a Kady Pi session (recorded in Phase 1 Decisions). In stateful mode each request maps to a `StreamableHTTPServerTransport` keyed by the SDK `Mcp-Session-Id` header — the adapter must cache transports per session id (or choose per-request stateless), otherwise stateful mode breaks across requests.
5. `start_research_run` image attachments: mirror the existing inline `images: [{data, mimeType}]` run body so image content from the MCP client (base64 in its content array) reaches the model; otherwise image-carrying research is silently text-only.
6. `poll_run` vs `get_session_history` contract: both can read `/sessions/:id/history`; define which returns "new messages since run baseline" vs "whole transcript" to avoid double-fetching and a duplicated tool surface.
7. Provider refusals (e.g. Anthropic Mythos/Fable refusals) reach the client as a terminal `error` frame inside the run, not as an MCP tool error — decide how `poll_run` surfaces them (reuse `model-refusal.ts` guidance).
