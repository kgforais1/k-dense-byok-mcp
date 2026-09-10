---
title: "MCP server Phase 3 — harden and package"
status: accepted
created: 2026-09-06
branch: mcp-phase-3
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

- [x] Write `docs/kady-as-mcp-server.md` and register it per `docs/development/workflow.md` (Adding a new document) and `scripts/repo-manifest.json`.
- [ ] Validate that doc with a fresh-client walkthrough. Unchecked deliberately: the transcript that backs the "installable by a third party" claim does not exist yet, and the doc is written from the code rather than from a run.
- [x] Settle packaging (stdio npx-style vs documented HTTP endpoint) per Phase 1/2 verdicts. Decided below: the documented HTTP endpoint, with no npx package.
- [x] Add or explicitly defer remaining §10 tools. The first two are decided and specified below: `list_research_sessions` and `delete_research_session`. Both are built; the rest of §10 is still expand-as-needed.
- [ ] Record the CLI entry point (adapter reuse map) and leave the CLI itself out of scope.

**Exit criteria:** fresh client connects via docs alone; packaging decided and working; CLI follow-up recorded, not built.

The two unticked items above are deliberately still open: the CLI reuse map,
and the fresh-client walkthrough transcript that backs the "installable by a
third party" acceptance measure. Do not archive this plan until they are done.
The documentation item, the carried-in review work, the two session-management
tools below and the packaging decision have landed.

## Packaging: the documented HTTP endpoint, and no npx package

Phase 1 settled this without naming it. The transport verdict was Streamable
HTTP on the existing listener, and that alone is why a stdio-only client cannot
connect today — there is no stdio transport to connect to.

Building one would cost more than a transport. Project scope is the
`X-Project-Id` header, first in the existing scope precedence, and Phase 1
recorded that "stdio clients have no HTTP headers". An npx stdio server would
therefore also need a second way to say which project it is talking about — an
environment variable or a tool argument — and that is a second scoping path for
the same question, which the standing guardrail rejects for the same reason it
rejects a second agent implementation in the adapter. The one that drifts is
the one nobody tests.

The other half is that there is nothing to distribute. The tools are an
interface onto a Kady that is already running: they read that instance's
projects, its sandbox and its model runtime. An npx package would either have
to start the whole server — at which point it is Kady, not a package — or proxy
stdio to a Kady the user is running anyway, which adds a process and no
capability. `docs/kady-as-mcp-server.md` documents the endpoint and the client
config instead.

The refusal is worth naming rather than leaving implicit, because "publish an
npx server" is the reflex answer for an MCP server and someone will propose it
again. A stdio→HTTP shim stays available as a *client-side* workaround if a
client that cannot speak HTTP ever matters; that is a compatibility follow-up,
not a distribution story, and nothing today needs it.

## Next chunk: session management over MCP — built

Built as specified below. The one thing the spec did not anticipate:
`SessionManager.list` filters on the transcript header's `cwd`, so a session
whose header does not name the project sandbox is invisible to
`list_research_sessions` however it was created. Test fixtures have to carry it.

An MCP client can create sessions it cannot enumerate or remove. The five
Phase 2 tools cover one research loop and nothing around it, so a scripted
client accumulates sessions and has to open a browser to clean them up. That is
the same asymmetry this phase rejected when it chose delete-and-label over a
creation cap: the browser must not be the only interface that can manage its
own data.

Both endpoints already exist and both already behave identically for the two
callers, so these are translation only — no new logic in the adapter, per the
standing guardrail.

- **`list_research_sessions`** wraps `GET /sessions`. Returns `sessionId`,
  `name`, `created`, `modified`, `messageCount`, `firstMessage` and `headless`.
  Rename `id` to `sessionId` on the way out so it matches the field name every
  other tool takes as input; that mismatch is the kind of thing a calling agent
  gets wrong once and then works around forever. `firstMessage` is user prose
  from the transcript, so it is the one field worth re-checking against the
  no-host-path property test.
- **`delete_research_session`** wraps `DELETE /sessions/:id`. Keep the REST
  behaviour exactly: 404 becomes a "No such session" tool error, and a run in
  flight becomes the same `run_already_active` reason `start_research_run`
  already returns, so a client learns one vocabulary rather than two. Mark it
  `destructiveHint: true` in the tool annotations — it is the first inbound tool
  that destroys anything, and a client that surfaces annotations should be able
  to prompt for it.
- Both need the Phase 2 contract tests: scope resolved per request, and a case
  in `mcp-adapter-guardrails.test.ts` (which fails today if a tool has no case,
  so this is enforced rather than remembered).
- Once they land, drop the "no way to delete a session through MCP" entry from
  the Limits section of `docs/kady-as-mcp-server.md` and describe the two tools
  in the tool table.

Deliberately still out: no abort tool. Aborting is a live-run operation with
ownership implications, not a translation, and `docs/kady-as-mcp-server.md`
discloses the gap.

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

- **Deleting a session leaves two things behind on purpose, and one by
  omission.** On purpose: the cost ledger (below), and the per-PDF annotation
  sidecars in `server/src/pdf-annotations-store.ts`, which are keyed by PDF
  rather than by session and outlive any single chat. Worth naming the
  consequence, because it is a decision and not a cleanup: markup authored from
  a deleted chat survives, but the provenance that linked it to that chat does
  not, so it becomes unattributable. By omission: `methods_draft_<sessionId>.md`
  files written into the sandbox (`server/src/agent/methods-draft.ts`). Those
  are user-visible sandbox files the user can delete themselves, which is the
  argument for leaving them, but nobody actually made that call.

- **A tab whose session is deleted elsewhere has no steady-state recovery.**
  The web guard is preventive — the history menu disables delete for a session
  open in any tab. It cannot cover a session deleted through MCP or a second
  browser window. `useSessionRestore`'s `onUnavailable` only runs at mount, so a
  live tab keeps its in-memory transcript and fails every later send with a
  generic error. Wanted: a 404-on-send handler that tells the tab its session is
  gone.

- **`producedOutput` counts any successful `tool_end`, including a pure read.**
  A run that read one file and then finished silently reports `true`, which is
  the case the flag exists to catch. Narrowing it means enumerating which tools
  "produce" something, and getting that list wrong reports a real answer as
  nothing — a worse failure than the one it fixes. Left as is, deliberately.

- ~~**`deleteSession` is check-then-act, not an atomic claim.**~~ **Fixed.**
  Three reviewers raised this, so it stopped being worth recording. The precise
  window is narrower than first described: `deleteSession` is synchronous end to
  end, and `prepareRun`'s own guard-to-claim span has no `await` in it, so those
  two cannot interleave. The reachable window is the `await getSession(...)`
  *before* `prepareRun`'s busy check — a delete completing inside it leaves the
  run holding a session whose transcript is gone, which it then recreates
  partially on the next write. Closed with a deletion tombstone in
  `session-registry.ts` that `prepareRun` checks after that await, rather than
  the shared claim first proposed: a re-`existsSync` would have been wrong,
  because a freshly created session has no transcript on disk until its first
  write.

- **Artifact cleanup failures are swallowed and the call still reports
  `deleted`.** Deliberate. The transcript is already gone by that point, so
  failing the call would deny a delete that did happen. The cost is named in the
  code: if `forgetSessionRunResults` fails, `poll_run` keeps answering for a
  session `get_session_history` now 404s on, until the 7-day retention sweep
  collects it.

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

1. ~~Packaging: npx distribution vs "point your client at localhost:8000" docs?~~
   **Answered:** the documented endpoint, no npx package. See *Packaging* above.
2. ~~Which §10 tools make the cut vs defer?~~ **Answered for the first two:**
   `list_research_sessions` and `delete_research_session` are in, no abort tool.
   The rest stays expand-as-needed, which is the standing answer rather than an
   open question.
3. Does anything in Phase 2 force an SDK upgrade (deliberate, test-gated path)?
