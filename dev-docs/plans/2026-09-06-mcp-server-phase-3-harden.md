---
title: "MCP server Phase 3 — harden and package"
status: proposed
created: 2026-09-06
branch: mcp-work
---

# MCP Server Phase 3 — Harden, Document, Package (Partial)

**Status:** Accepted — deliberately partial. Scope depends on what Phase 2 actually built and what it deferred. Part of the [master plan](2026-09-06-mcp-server.md).

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. See
> `docs/development/workflow.md#archive-lifecycle`.

**Goal:** Turn the Phase 2 minimal server into something another human can install and use: client setup docs, packaging story, remaining §10 tools (or explicit deferrals), and a recorded entry point for the deferred CLI.

## Why this work

A working adapter nobody can install is a demo, not a feature. This phase is the difference — plus it closes the loop on the CLI question so the two interfaces share one tool core instead of forking.

## Design decisions

- Docs before packaging tweaks: `docs/kady-as-mcp-server.md` must let a fresh client connect before any registry/publish step.
- CLI stays deferred but gets a recorded entry point (which adapter modules it will reuse) so the follow-up doesn't redesign.
- Full §10 surface is expand-as-needed; each added tool needs the same contract tests as Phase 2.

## Proposed information architecture / file changes

```text
docs/kady-as-mcp-server.md      NEW — setup for OpenCode / Claude Code / Codex clients
server/src/mcp-server/          EXTEND — remaining tools or explicit deferrals
dev-docs/todo.md                UPDATE — CLI follow-up entry if not already present
```

## Implementation sequence

- [x] Write `docs/kady-as-mcp-server.md` and validate with a fresh-client walkthrough. Register the new doc per `docs/development/workflow.md` (Adding a new document) and `scripts/repo-manifest.json`.
- [ ] Settle packaging (stdio npx-style vs documented HTTP endpoint) per Phase 1/2 verdicts.
- [ ] Add or explicitly defer remaining §10 tools.
- [ ] Record the CLI entry point (adapter reuse map) and leave the CLI itself out of scope.

**Exit criteria:** fresh client connects via docs alone; packaging decided and working; CLI follow-up recorded, not built.

Archive note: archiving this file breaks the master plan's link to it — rewrite to `completed/…` in the same PR.

## Carried in from the Phase 2 review

- **Session creation is unauthenticated, unrate-limited, and grows disk without
  bound.** `create_research_session` writes a JSONL transcript under
  `.pi/sessions/` and a marker under `.kady/headless-sessions/`. `evictOverCap`
  disposes only the *in-memory* session past the per-project cap of 10; neither
  file is ever removed. The MCP route also sits outside the sandbox rate-limit
  scope, and each `createSession` is expensive — it dials MCP servers via
  `getMcpTools`, reloads the resource loader, and seeds packages. The UI's
  `POST /sessions` has the same unbounded behaviour, but it is human-driven;
  MCP makes it scriptable by an autonomous agent. Decide between a retention
  sweep, a creation cap, and bringing the MCP route inside the rate limit.
  Wherever it lands, the fix belongs in `session-registry.ts` next to
  `evictOverCap`, not in the `create_research_session` handler: a quota enforced
  only on the MCP path would leave `POST /sessions` unbounded, make MCP clients
  second-class against the browser, and violate this plan's standing guardrail
  that the adapter translates rather than reimplements. Retention also has to
  remove both artifacts — the JSONL transcript *and* the headless marker —
  or a cold open of a swept session silently regains the `interview` tool.

  **Decided: neither a sweep nor a cap.** Both were rejected for the same
  reason — they answer a disk-space question by taking a decision away from the
  user. A sweep silently destroys chat history the UI still lists; a creation
  cap refuses work the user asked for. The real defect is narrower and was
  hiding behind the growth framing: *nothing can delete a session at all*, from
  either interface. There is no `DELETE /sessions/:id`. So the fix is to add
  one, in `session-registry.ts` next to `evictOverCap` as required above, and
  to label headless sessions in `GET /sessions` so a user can see which came
  from MCP. Deletion removes the transcript and the marker together, and
  refuses while a run is in flight. Growth stays unbounded by policy, which is
  the correct answer for a local single-user app whose other stores behave the
  same way.

- **A run that produces nothing still reports `done`.** Carried from the Phase 2
  plan's follow-up: `poll_run` cannot distinguish "finished with an answer" from
  "finished with nothing", and no human is watching the transcript. Decide
  whether to flag a content-free terminal run.

  **Decided: flag it.** `poll_run` now returns `producedOutput` on every status
  except `unknown`, computed over the run's whole frame list rather than the
  `after` slice so a cursor cannot turn a real answer into a false negative.
  Only two frame types count: a `text_delta` with non-empty `delta`, and a
  `tool_end` that is not an error — a run whose whole answer is a written file
  said nothing but did not finish with nothing. The first implementation read
  `frame.text`, a field no published frame has, so it reported every real run
  as empty and its tests passed only because they published a frame shape the
  agent never emits (`agent/events.ts:311` is the real mapping). That is now a
  named regression test.

## Open, recorded rather than fixed

- **`DELETE /sessions/:id` sits outside the sandbox rate-limit scope.** So does
  every other session route: the scope in `server/src/index.ts` wraps the
  filesystem-touching sandbox routes only. Bringing session routes inside it is
  a change to that scope's meaning, not a one-line fix, and this is a loopback
  single-user app. Recorded so the next person does not rediscover it.

- **`deleteSession` is check-then-act, not an atomic claim.** The busy guard
  reads `live`/`pinned`/the broker, then unlinks; `prepareRun` takes its claim
  later (`server/src/api/sessions.ts:214`). A DELETE landing between a run's
  guard check and its claim, or during the `await` inside a cold-open
  `getSession`, would remove a transcript a run is about to use. The window is
  small and the browser path is behind a confirm, but MCP makes DELETE
  scriptable. Closing it properly means one shared synchronous claim covering
  both operations, which is a change to how run ownership works rather than a
  patch to this function.

- **Cost ledger entries outlive the chat they belong to.** Deliberate: the money
  was spent. Deleting a chat must not silently refund the project's budget
  tracking. Everything else keyed by the session id — notebook, PDF
  annotations, provenance — is removed with the transcript.

## Carried in from the CI-hardening review (PR #19)

Two of the three "guardrails enforced only by prose" turn out to want tests, not
static rules, and the moment to write them is while the seam is fresh:

- **No absolute host path in any MCP tool result.**
  `server/test/mcp-server-tools.test.ts:122` pins the one known instance, the
  `sessionFile` near-miss. It is an assertion about a single field, not the
  property. `get_session_history` returns `toHistory(file, paths.sandbox)` and
  `poll_run` returns broker frames; neither is checked. Gitleaks scans source
  and can never see runtime output, so a new tool — or a new frame type that
  happens to carry a path — goes green through the entire pipeline. Wanted: one
  test that walks every tool's serialized result and fails on anything matching
  an absolute host path.

  **Done** — `server/test/mcp-adapter-guardrails.test.ts`. Cases rather than one
  entry per tool, because a tool can leak on one branch and not another: the
  history case writes a real transcript so `toHistory` actually runs, and
  `poll_run` and `start_research_run` are each exercised on both branches. Every
  registered tool must appear in a case, so a tool added later cannot escape.

- **`start_research_run` and `POST /sessions/:id/run` share one path.**
  `beginRun` is that path today and the adapter calls it, but nothing fails if a
  future handler reimplements run-start instead. Wanted: a concurrency test that
  drives `run_already_active` *through the MCP adapter*, so ownership and
  billing behaviour are pinned to the shared path rather than to the REST route
  alone.

  **Done** — `server/test/mcp-run-concurrency.test.ts`. It spies through to the
  real `beginRun` with `importOriginal` rather than mocking it, so an inlined
  reimplementation in the adapter fails the test; asserting only the returned
  `run_already_active` shape would not have.

The third, "`prepareRun` must not call `reply.code`", is genuinely structural
and stays a Semgrep candidate. `prepareRun` is transport-neutral now and returns
`RunStartRejection`; re-adding a `reply` parameter would pass lint, typecheck
and every test while breaking only the MCP path.

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
