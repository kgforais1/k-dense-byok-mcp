---
title: "MCP server for K-Dense"
status: proposed
created: 2026-09-06
branch: chore/todo-refresh-mcp-roadmap
---

# MCP Server for K-Dense (Kady as a Tool for External Agents) — Master Plan

**Status:** Proposed

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. See
> `docs/development/workflow.md#archive-lifecycle`.

**Goal:** Expose the local K-Dense backend as an MCP server so an external coding agent (OpenCode / Claude Code / Codex-style) can delegate research work to Kady — project, file, session, notebook, and agent-run operations — over MCP instead of raw HTTP. A CLI over the same API is explicitly deferred to a follow-up.

## Why this work

`dev-docs/kady-architecture-and-integration-notes.md` §§ 9–13 establishes that Kady is currently only an MCP *client* (consumes external tools via `server/src/agent/mcp.ts`); the inverse — another agent driving Kady over MCP — is not a documented feature. Recommendation 7 says to consider an MCP server layer for agent delegation, and recommendation 8 says a lightweight CLI would also be useful but "MCP is likely the more powerful integration for agent-to-agent workflows." The owner's primary workflow is coding-agent-to-Kady delegation, so this plan leads with MCP and defers the CLI. Both eventually; one at a time.

Because the backend already exposes project/session/run/file APIs (notes §§ 6–7), the MCP layer should be a thin translation, not a second implementation of agent logic (notes §12).

## Design decisions

- **MCP first, CLI deferred.** Per notes §13 recs 7–8 and the agent-to-agent workflow. The CLI becomes a thin client over the same API/adapter later — it must not fork the tool logic.
- **Thin adapter over the existing HTTP API.** Translate MCP tool calls into the already-existing project/session/run endpoints (notes §12). No duplicated agent logic in the adapter.
- **Minimal tool subset first.** Prove the path with a few tools (list/get + one research run) before the full §10 surface (`kdense_research`, `kdense_delegate_specialist`, …).
- **SDK already vendored.** `@modelcontextprotocol/sdk` (`^1.29.0`) is in `server/package.json`; current imports are client-side only (`Client`, `StdioClientTransport`, `StreamableHTTPClientTransport` in `server/src/agent/mcp.ts`). Server-side exports (`McpServer`, transports) to be confirmed against the pinned version in Phase 1 — SDK upgrades stay deliberate and test-gated (note: the SDK is a caret-range dep, not part of the exact-pin harness set).
- **Local-only by default.** Project scoping reuses the existing `X-Project-Id` mechanism (notes §7). Remote/multi-user auth is an open question, not a Phase 2 requirement.

## Proposed information architecture / file changes

```text
server/src/mcp-server/          NEW — MCP adapter: tool definitions → HTTP/session calls
  (exact module split TBD in Phase 1; candidate: index.ts + tools/*.ts)
server/test/mcp-server/         NEW — tool-shape, scoping, and contract tests
docs/mcp-server.md              NEW — client setup (OpenCode / Claude Code / Codex) — Phase 3
dev-docs/plans/2026-09-06-mcp-server-phase-*.md   phase plans (this directory)
```

All paths tentative pending Phase 1 findings.

## Implementation sequence

Detail lives in the phase plans, not here — this master stays at the high level. If any phase grows too large for its file, split its detail into further per-phase plan files and keep this master as the index.

- [ ] Phase 1 — Research spike and decisions → [phase plan](2026-09-06-mcp-server-phase-1-research.md)
- [ ] Phase 2 — Minimal MCP server → [phase plan](2026-09-06-mcp-server-phase-2-server.md)
- [ ] Phase 3 — Harden, document, package → [phase plan](2026-09-06-mcp-server-phase-3-harden.md)

**Exit criteria (master):** an external MCP client completes a Kady research task end-to-end through MCP tools only; docs let a new client connect; CLI remains explicitly deferred (recorded in todo §3), with its adapter entry point recorded per Phase 3.

## Guardrails

- Tools never return secrets; API keys and OAuth tokens stay server-side.
- No auth downgrade: nothing in the adapter weakens the local trust boundary (`docs/limitations.md` applies to MCP-driven runs unchanged).
- No second agent implementation in the adapter — translate, don't duplicate.
- MCP SDK upgrades are deliberate and test-gated (caret-range dep, not in the exact-pin harness set); Phase 1 records the exact resolved version.
- Cross-platform like the rest of the backend (Windows Git-Bash paths, no `which`).

## Acceptance measures

| Outcome | Evidence |
|---|---|
| External agent completes research via MCP | Transcript + notebook entry produced through MCP tools only |
| Minimal subset covers the loop | Phase 2 tool list exercised end-to-end without raw-HTTP fallback |
| A new client can connect quickly | Fresh-client walkthrough against `docs/mcp-server.md` |

## Open questions (hinge Phase 2 scope)

1. Transport: stdio (npx-style per client) vs StreamableHTTP against the running backend (:8000, reuses scope/auth)?
2. Process model: in-process with the backend vs sidecar process?
3. How do long SSE agent runs map to MCP — progress notifications vs poll-style `kdense_get_result`?
4. Which tool subset is minimal-viable?
5. Project-scoping/auth UX for external clients (local-first; remote explicitly out of scope for now)?
6. CLI before or after hardening? Default: after, reusing the adapter — revisit only if Phase 1 finds MCP blocked.
