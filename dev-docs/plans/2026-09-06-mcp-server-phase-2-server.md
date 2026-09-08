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
server/src/mcp-server/http.ts    Streamable HTTP mount on the shared listener
server/src/mcp-server/server.ts  the five tool definitions
server/src/agent/run-results.ts  persisted terminal records keyed by `runId`
server/src/agent/headless-sessions.ts  NEW — durable "created headless" marker
server/src/api/sessions.ts       refactored: `beginRun` is the shared run-start path
server/test/mcp-server-*.test.ts       tool-shape, scoping, contract tests
server/test/mcp-headless-sessions.test.ts  NEW — interview-disable prerequisite
  (flat files, per the existing `server/test/` convention)
```

## Implementation sequence

- [x] Establish the opt-in `KADY_MCP_ENABLED` gate and fail-closed shared-listener assertion; contract-test the `127.0.0.1` default and non-loopback rejection before MCP routes exist.
- [x] Scaffold the adapter per Phase 1 transport/process verdicts: stateful Streamable HTTP mounts at opt-in `/mcp-server` (kept distinct from the existing outbound-connector `/mcp` API) and serves all five contract-tested tools.
- [x] Before exposing MCP runs, disable `interview` for MCP-created sessions and add the MCP-specific system-prompt/skill note required by Phase 1; contract-test that the tool is absent and the replacement guidance is present. `create_research_session` passes `{ includeInterview: false }`, and `HEADLESS_PROMPT_NOTE` is appended to the system prompt of headless sessions only — the seeded sandbox `AGENTS.md` still tells the model to interview and is shared with the browser UI, so it must not be edited. See the durable-marker deviation in Decisions.
- [x] Add a durable terminal-result record keyed by `runId` under the existing per-project run-data tree and a lookup that returns its terminal status/result after the broker's ~30s retention expires. The snapshot is intentionally an atomic synchronous write for every completed local run: that small completion-path cost guarantees the record exists before broker expiry; records are bounded to 500 per project and seven days; Phase 2 does not add a second, MCP-only run path.
- [x] Implement the minimal tool subset with contract tests (shape, project scoping, fresh-client `create_research_session` → run/poll flow, a bind assertion that preserves the `127.0.0.1` default and rejects every non-loopback `KADY_HOST` value — including `0.0.0.0` — whenever MCP is enabled, durable terminal-result lookup, and error mapping). The run-start contract must map **only** `RunAlreadyActiveError` — either via a typed `reason` preserved by `/sessions/:id/run` or by the adapter's direct `runBroker` rule — to the MCP “run already active” response. Its test must force both that concurrent case and an unrelated `start()`/`publish()` failure: the former gets that response; an HTTP 500 unrelated failure preserves its actual mapped failure rather than being mislabeled as concurrency. It must also distinguish the `/steer`-only HTTP 403 from the run's `kind:"budget"` frame on an HTTP-200 stream, plus a post-expiry poll that retrieves the durable terminal record.
- [x] End-to-end check from a real external MCP client against a scratch project. Run from a separate Node process over real Streamable HTTP, driven by the MCP SDK client with no raw-HTTP fallback: connect → `Mcp-Session-Id` issued → all five tools discovered → `list_projects` twice on one connection (exercising the stateful transport cache) → `create_research_session` → `start_research_run` → `poll_run` to a terminal `done` → `get_session_history`. Backed by a local LM Studio model through the existing `openai-compatible` provider, so the run cost $0 and reported `runBillingMode: "local"`. It caught one defect that the in-memory contract tests could not — see Decisions 9 — and surfaced one follow-up for Phase 3.
- [x] Record deviations from this stub as Decisions.

**Exit criteria:** external client completes one research task via MCP tools only; tests green; deviations recorded.

## Decisions (deviations from this stub)

1. **The adapter calls in-process functions, not its own HTTP client.** "Thin
   translation over the existing HTTP API" is honoured at the level of *logic*,
   not transport: the tools call the same `listProjects`, `createSession`,
   `toHistory`, `beginRun`, `runBroker`, and `readRunResult` the REST routes
   call. Making the adapter issue loopback HTTP requests to its own listener
   would have added a second serialization boundary and a second failure mode
   for no gain, since both surfaces already share the `X-Project-Id` request
   scope.

2. **`prepareRun` became transport-neutral and `beginRun` is now the single
   run-start path.** `prepareRun` previously wrote status codes onto a
   `FastifyReply`, so it could not be reused. It now returns a
   `RunStartRejection` carrying its own `statusCode`, and the new exported
   `beginRun` performs claim → configure → hand off → detached `ownRun`. The SSE
   route and `start_research_run` differ only in what they do with the returned
   handle: the route attaches `streamRun` as an observer, MCP returns the run
   id. This is what keeps the plan's "no second, MCP-only run path" guardrail
   true in fact rather than only in intent.

3. **New durable headless marker — `server/src/agent/headless-sessions.ts`.**
   Not anticipated by this plan. `createSession({ includeInterview: false })`
   alone is not sufficient: `evictOverCap` LRU-evicts idle sessions past the
   per-project cap of 10, and the next `getSession` cold-opens the JSONL file
   and rebuilds the Pi session with the interactive default restored. An
   MCP-driven run on that rebuilt session would then block forever on an
   `interview` form no MCP client can see or answer. The marker is one small
   file per session under the project's `.kady` tree; `getSession` consults it
   on the cold-open path, and an explicit caller option still wins.

4. **The replacement guidance is a system-prompt append, not an `AGENTS.md`
   edit.** Removing the tool also removes its `promptGuidelines`, but the
   sandbox `AGENTS.md` seeded by `sandbox-seed.ts` has its own "Clarifying
   questions — ask, don't assume" section naming `interview` directly, and that
   file is shared with the browser UI where the tool genuinely exists. Editing
   it would degrade the UI to fix MCP. Instead `HEADLESS_PROMPT_NOTE` is
   appended via the resource loader's `getAppendSystemPrompt()` for headless
   sessions only, and it supplies the alternative behaviour (choose an
   interpretation, state it, log assumptions to the notebook) rather than only
   the prohibition — Phase 1 recorded that a bare prohibition leaves the model
   wanting to ask and unable to, so it guesses silently.

5. **Phase 1's `runBroker`-direct fallback was not needed.** Phase 1 decision 3
   required *either* a typed `reason` preserved by the HTTP layer *or* a direct
   `runBroker` call in the adapter, because at the time every start failure
   collapsed into an HTTP 500. `server/src/agent/run-start-errors.ts` (shipped
   in PR #17) now maps `RunAlreadyActiveError` to a typed
   `409 { reason: "run_already_active" }`, so the adapter takes the first
   option and no run-start logic is duplicated.

6. **`poll_run` verifies the session binding on the durable path.** Durable
   records are keyed by `runId` alone. Polling a real run id under the wrong
   `sessionId` would otherwise return another session's frames, so the lookup
   compares `durable.sessionId` and answers `unknown` on a mismatch.

7. **`poll_run` normalises the aborted status across both paths.** A run that
   was aborted publishes no error frame, so `RunHandle.activityState` reports it
   as `done`, while `persistRunResult` records it as `aborted`. Left alone, the
   same run would answer `done` inside the broker's retention window and
   `aborted` after it. `poll_run` applies the abort check on the live path too,
   and a contract test polls one aborted run across both paths.

8. **`zod` is now a direct, exactly-pinned dependency of `server/`.** The SDK's
   `registerTool` takes a Zod raw shape for `inputSchema`, so the tools import
   `zod` directly rather than relying on it being hoisted from the SDK. It is
   pinned to `4.4.3` — the version the SDK itself resolves — because a Zod major
   mismatch between the two breaks tool registration.

9. **`inputSchema: {}` is not the same as omitting the key.** Found by the
   external-client check, not by the in-memory tests. The SDK builds a
   validating object schema from an empty Zod shape and then rejects a call
   that carries no `arguments` at all — which is exactly how a client invokes a
   no-argument tool. `create_research_session` was therefore unreachable from a
   real client while `list_projects`, which omits the key, worked. The in-memory
   tests missed it because they only *listed* those tools; there is now a test
   that calls them.

## Follow-up for Phase 3

- **A run that produces nothing still reports `done`.** During the check the
  local model received ~44.4k prompt tokens against the 32,768-token context
  window that `models.ts` declares for `openai-compatible` models, returned an
  empty assistant message, and the run completed normally: `poll_run` reported
  `status: "done"`, no error frame was published, and nothing was logged
  server-side. A calling agent cannot currently distinguish "finished with an
  answer" from "finished with nothing". This is pre-existing local-model
  behaviour rather than an adapter defect — the browser UI would show the same
  empty turn — but MCP makes it worse, because there is no human looking at the
  transcript to notice. Phase 3 should decide whether `poll_run` flags a
  content-free terminal run.

## Still open in Phase 2

- Nothing. The exit criteria are met: an external client completed the loop
  over MCP tools only, the `server` ladder is green, and the deviations above
  are recorded. The Phase 3 follow-up noted above is hardening, not a Phase 2
  gap. This plan is ready to archive with the PR that closes it.

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

1. Exact schemas for the five decided tools — **resolved:** declared as Zod shapes in `server/src/mcp-server/server.ts`. `list_projects` and `create_research_session` take no arguments; `get_session_history` takes `sessionId`; `start_research_run` takes `sessionId`, `message`, and optional `model` / `thinkingLevel` / `images`; `poll_run` takes `sessionId`, `runId`, and an optional `after` cursor. Every tool answers with a single JSON text block.
2. Error mapping and result durability — **resolved:** HTTP/SSE failures map to MCP responses, while budget-blocked runs surface as a `kind:"budget"` *frame* inside an HTTP-200 SSE stream (not a 403), so the mapping inspects terminal frames. Phase 2 persists a terminal record keyed by `runId` under the existing project run-data tree and has `poll_run` use it after the broker's ~30s retention expires; an unknown `runId` remains distinct from an expired completed run.
3. Session lifecycle over MCP — **resolved:** `create_research_session` is a required session-management tool backed by `POST /sessions`; fresh clients call it once per research thread and pass the returned id to history/start/poll. The adapter never creates a session during a run or poll. It inherits existing lifecycle semantics: live idle sessions are LRU-evicted at the backend's per-project cap, while persisted JSONL transcripts are retained until the existing project lifecycle removes them; Phase 2 adds no adapter-only reaper.
4. Transport session mode: StreamableHTTP stateful vs stateless, and whether/how the transport session id relates to a Kady Pi session (recorded in Phase 1 Decisions). In stateful mode each request maps to a `StreamableHTTPServerTransport` keyed by the SDK `Mcp-Session-Id` header — the adapter must cache transports per session id (or choose per-request stateless), otherwise stateful mode breaks across requests.
5. `start_research_run` image attachments — **resolved:** the tool declares `images: [{data, mimeType}]` and forwards it into the same `RunBody` the REST route uses, so `parseRunImages` validates it once for both transports. Contract-tested.
6. `poll_run` vs `get_session_history` contract — **resolved:** `get_session_history` returns the whole persisted transcript plus context usage, mirroring `GET /sessions/:id/history`. `poll_run` returns run status plus only the frames after the caller's `after` cursor, and never reads the transcript. Each tool's description states the split so a client does not double-fetch.
7. Provider refusals — **resolved, no adapter work needed:** `ownRun` already wraps the refusal in `withRefusalGuidance` before publishing the terminal `error` frame, so the `model-refusal.ts` guidance is inside the frame `poll_run` returns. `poll_run` reports it as a non-`running` status with the frame attached, rather than as an MCP tool error, because the tool call itself succeeded.
