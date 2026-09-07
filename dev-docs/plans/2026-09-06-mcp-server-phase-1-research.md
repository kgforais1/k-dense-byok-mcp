---
title: "MCP server Phase 1 — research spike"
status: proposed
created: 2026-09-06
branch: mcp-work
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
- [x] Confirm server-side exports available at the declared `@modelcontextprotocol/sdk` range against the lockfile-resolved version `1.29.0` (high-level `McpServer`, stdio + StreamableHTTP transports) and record the exact resolved version: `server/package-lock.json` resolves `@modelcontextprotocol/sdk` to `1.29.0`; import `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, the low-level `Server` (whose `elicitInput()` method is needed only for a future elicitation bridge) from `@modelcontextprotocol/sdk/server/index.js`, `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`, and `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`.
- [ ] List the HTTP endpoints backing each candidate §10 tool (projects, sessions/run SSE, files, notebook).

**Exit criteria:** every Phase 1a inventory item is checked, or explicitly deferred with a reason; no open "what exists?" questions remain.

### Phase 1b — Prototype (throwaway)

- [ ] Stand up one read-only tool (e.g. project list) over the leading transport candidate.
- [ ] Attempt one live run-mapping experiment (SSE run → MCP progress or poll) and record what worked.
- [ ] Record verdicts for master-plan questions 1–7 (answered or explicitly deferred with a reason), including CLI-ordering (Q6) and interview-handling (Q7).

**Exit criteria:** every Phase 1b prototype item is checked, or explicitly deferred with a reason; decision record updated with its evidence; Phase 2 plan updated to match; spike code discarded or clearly quarantined.

Archive note: archiving this file breaks the master plan's link to it — rewrite to `completed/…` in the same PR.

## Guardrails

- No credentials in spike code, logs, or pasted transcripts.
- No changes to product behavior; backend runs locally only during the spike.
- Timebox: if a question resists the spike, mark it deferred with a reason rather than expanding the spike.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| Transport + process model decided | Verdict recorded in Decisions with the experiment behind it, or an explicit deferral |
| Run-mapping approach chosen | Spike transcript or explicit deferral |
| Phase 2 is implementable | All Phase 1a/1b exit criteria met and the refined Phase 2 plan references the evidence |

## Decisions

The entries below are **provisional design constraints**, not completed-spike evidence: the unchecked Phase 1a/1b tasks above still need to validate or revise them. Do not treat these labels as verified until their inventory/prototype evidence is recorded and the Phase 1 exit criteria are met. Record each master-plan question as verified, revised, or explicitly deferred (with reason) before Phase 2 starts. Include inherited decisions from the master plan (e.g. CLI default: after hardening).

1. Transport (stdio vs StreamableHTTP): **Provisionally answered:** StreamableHTTPServerTransport (SSEServerTransport is deprecated in 1.29.0). Note that mounting this on Fastify requires `reply.hijack()` to pass raw Node.js ServerResponses, which skips Fastify's response-side hooks (CORS headers, logging) — the `onRequest` scope hook still runs, so project scoping is unaffected. The transport has both a stateful mode (session id via response header) and a stateless mode (no session id) — Phase 2 must pick one and record how (or whether) the transport session id relates to a Kady Pi session before implementation.
2. Process model (in-process vs sidecar): **Provisionally answered:** In-process. By mounting the MCP routes directly on the existing Fastify server, we reuse the `X-Project-Id` scope and avoid duplicating state or budgets. The MCP route shares the existing listener — never a separate port — so the "local-only" guarantee is a property of that shared listener, not of the MCP route.
3. SSE run → MCP mapping (progress vs poll): **Provisionally answered:** Poll. Prefer a durable-job pattern (`start_research_run` + `poll_run`) over streaming: the SDK does have (experimental) task support and progress notifications, but a poll tool matched to the existing `runBroker` is the thinner adapter. Three guards, mostly provided by the HTTP layer, must be reused rather than re-implemented: (a) concurrent runs — `/sessions/:id/run` rejects a second live run with 409 (`sessions.ts:523`); `runBroker.start` additionally throws `RunAlreadyActiveError` on a narrow race. Today the `/run` catch collapses *any* `start`/`publish` failure into a single HTTP 500 (`sessions.ts:587-595`), so the adapter must not treat every 500 as concurrency — either the HTTP layer must preserve a distinct `reason` for `RunAlreadyActiveError`, or the adapter must call `runBroker` directly and inspect the typed error. (b) completion — `runBroker` retains completed run frames for only ~30s (`DEFAULT_COMPLETED_RETENTION_MS`), so Phase 2 will persist one terminal record per `runId` under the existing project run-data tree and expose a per-run lookup. `poll_run` reads the live broker first, then that durable record after the retention window, returning its terminal status/result rather than treating an expired completed run as unknown. (c) budget — a budget-blocked *run* is not an HTTP error: `/sessions/:id/run` opens the SSE stream (HTTP 200) then publishes a `kind:"budget"` error *frame* (`sessions.ts:711`); the 403 + `reason:"budget"` exists only on `/steer` (`sessions.ts:479`). `start_research_run` therefore cannot surface a spend cap from the HTTP status — `poll_run` must detect it from the terminal frame.
4. Minimal-viable tool subset and session lifecycle: **Provisionally answered:** `list_projects`, `create_research_session`, `get_session_history`, `start_research_run`, `poll_run`. `create_research_session` is the fresh-client provisioning path and directly wraps the existing `POST /sessions` route; it creates one Pi session per client-requested research thread, returns its Kady session id, and must not create a session per run or poll. The client retains that returned id; the adapter adds no deletion because no delete endpoint exists. Lifecycle remains the backend's current, explicit behavior: `SessionManager` persists session JSONL history, while the live in-memory registry LRU-evicts only idle objects over the per-project cap; persistent histories are retained until an existing project-level lifecycle operation removes the project. Phase 2 must document that retention rather than invent a reaper in the adapter.
5. Project-scoping/auth UX (local-first; remote out of scope): **Provisionally answered:** Pass `X-Project-Id` in the MCP client connection headers, reusing existing scoping (header is first in scope precedence). This only works for StreamableHTTP clients that can set per-request headers — stdio clients have no HTTP headers, and some MCP clients don't expose custom headers, so the supported-client set must be documented. Because `reply.hijack()` skips Fastify's CORS *response* handling, a browser-origin MCP client would fail CORS unless the adapter writes CORS headers manually (as the existing `streamRun` path does via `corsResponseHeaders()`) or browser/remote clients are declared out of scope. Note this does *not* affect scoping — the `onRequest` hook still resolves `X-Project-Id` before the handler.
6. CLI ordering (before vs after hardening): **Provisionally deferred:** after, reusing the adapter — revisit only if Phase 1 finds MCP blocked.
7. Interview handling for MCP-driven sessions (disable / elicitation / tool result): **Provisionally answered:** Disable. While MCP SDK 1.29.0 does support elicitation (`elicitInput` — note it lives on the low-level `Server`, not re-exposed on `McpServer`), bridging our Pi-specific React UI and `runBroker` to MCP elicitation is out of scope. Risk: MCP-driven sessions will guess instead of asking clarifying questions. Second-order risk: the `interview` tool ships `promptGuidelines` ("ask clarifying questions as much as possible … do not silently assume") plus a seeded AGENTS.md with the same push, so removing the tool from the allowlist leaves the model still wanting to interview — it will guess *and* has been told not to. **Named Phase 2 prerequisite:** disable the tool only together with an MCP-specific system-prompt/skill note that explains the limitation, and contract-test the resulting MCP session configuration. Only `interview` is withheld; `notebook` and the other custom/inbuilt tools stay enabled for MCP sessions.
8. SDK version pinning (inherited guardrail, restated): `@modelcontextprotocol/sdk` stays a caret-range dep, deliberately *not* in the exact-pin harness set. Record the upgrade playbook (bump pin, `npm install` in `server/`, typecheck + tests) and re-confirm the server-side class/transport surface after every bump — the `McpServer` vs `Server` split has proven easy to misname.
