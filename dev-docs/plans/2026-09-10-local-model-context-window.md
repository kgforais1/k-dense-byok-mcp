---
title: "Local-model context window: probe it instead of guessing 32K"
status: proposed
created: 2026-09-10
revised: 2026-09-18
branch: local-context-window
---

# Local-Model Context Window Implementation Plan

**Status:** Proposed — revised 2026-09-18 after re-verifying every premise
against `main`.

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. See
> `docs/development/workflow.md#archive-lifecycle`.
>
> **This plan is two files. Archive both together.** The companion
> `2026-09-10-local-model-context-window-findings.md` carries the same status
> and moves in the same commit. Moving only the plan breaks the findings
> file's relative link to it, which `scripts/docs-check.mjs` fails as a
> missing link target; leaving the findings file behind with a non-`completed`
> status while it sits in `completed/` fails the same script at `:463`. Set
> both statuses and move both paths.

**Goal:** Make Kady declare the local model's real context window instead of
guessing 32,768. `buildOllamaModel` and `buildOpenAICompatibleModel`
(`server/src/agent/models.ts:237`, `:261`) hardcode a window far below Kady's
own prompt, so every local run is over budget before it starts. Replace the
guess with the value the local server already reports, and raise the fallback
for the case where it reports nothing.

Stated deliberately narrowly. This makes the declared window *truthful*, which
makes large local models runnable and makes small ones fail legibly. It does not
make every local model work: Kady's prompt needs roughly 61,000 tokens of window
at the default reserve, so a genuine 8K or 32K local model will still not run.
What changes for those is that they stop failing silently and start saying why.

## What the 2026-09-18 revision changed

The first draft was written against a tree roughly ninety commits behind
`main`, and three of its premises had gone stale. The verification log is in
the findings file under "Re-verification, 2026-09-18"; the consequences are:

- **The run-path probe is gone, and with it half the mechanism.** The draft
  built `probeAll`, a scope component in the dedup key, and an asymmetric
  superset-join rule, all to serve a restored chat whose `session.model`
  holds a local model. That case cannot occur. `restoredSessionModel` and
  `latestProjectModel` resolve through `runtime.getModel`
  (`session-registry.ts:472`, `:486`), which returns `undefined` for both
  local providers — verified by running the real `ModelRuntime`. A local model
  reaches a run only as an explicit `body.model` ref, through `resolveModel`
  and the builders. One probe, fired from the discovery routes, is the whole
  design.
- **Phase 0 is half-built already.** `toClientFrame` now has a `compaction_end`
  case (`events.ts:412`). It returns `null` when `!ev.result`, which is exactly
  the failure shape. The work is a guard inside that case, not a new case.
- **`reserveTokens` is Kady's own setting now**
  (`server/src/agent/compaction-settings.ts`), user-tunable from 4,000 to
  64,000 per project. Every arithmetic claim about the "effective budget" is
  therefore a function of a project setting, not of Pi's default.
- **The env knobs are dropped.** Custom model servers (shipped 2026-09-08,
  `docs/custom-model-servers.md`) already let a user declare a per-model
  `contextWindow` for any OpenAI-compatible endpoint. That is a better escape
  hatch than two per-provider globals, and it is the granularity this plan's
  own reasoning argues for.

## Why this work

The evidence lives in a companion file:
[`2026-09-10-local-model-context-window-findings.md`](2026-09-10-local-model-context-window-findings.md).
Read it before implementing — it is the measurement record, and the decisions
below are only defensible with it in hand. **The findings file is the source of
truth for every number quoted here.** If the two disagree, the findings file
wins.

Three results drive the design:

- **The effective budget is the declared window minus `reserveTokens`.** Pi
  compacts above `contextWindow - reserveTokens`. At Kady's default reserve of
  16,384 that leaves 16,384 usable against a measured 44,409-token prompt —
  2.7x over, not 1.35x. **44,409 is an empirical measurement, not a constant
  in the code**; re-measure it during implementation. The reserve is now a
  project setting (`compaction-settings.ts:22`, bounds at `:27`), so record
  which value a measurement was taken at.
- **Both servers report the real figure, on a non-standard endpoint.** LM
  Studio's `/api/v0/models` carries `max_context_length`; Ollama's `/api/tags`
  carries `details.context_length`. The standard `/v1/models` carries neither,
  which is why the original 32,768 guess was reasonable for the endpoint it
  was looking at.
- **The loaded figure diverges from the architectural one on both servers.** On
  LM Studio this happens with no user action: a default install loaded
  `allenai/olmocr-2-7b` at `loaded_context_length: 64000` against a
  `max_context_length` of `128000`. On Ollama the divergence is *induced* by an
  `options.num_ctx`. Preferring the loaded figure is load-bearing on both.

The symptom this is *hypothesised* to fix — a `done` run with an empty
assistant message and no error frame — is not a verified consequence of the
above. Phase 4 exists to test it.

## Design decisions

**Probe from the discovery routes, not from `resolveModel`.** `resolveModel`
(`models.ts:466`) is synchronous and sits on the run path
(`api/sessions.ts:286`). Awaiting a network call inside it would mean making it
async, changing four call sites, and putting a round trip between the user
pressing send and the run starting. There is no need:
`GET /ollama/models` (`api/system.ts:63`) and `GET /openai-compatible/models`
(`api/system.ts:97`) already call both servers whenever the picker opens, both
already run async under a 2 s `AbortController`, and both currently hardcode
`context_length: 0` in the rows they return (`:78`, `:123`). Read the real
value there, cache it, and have the builders do a synchronous lookup.

**There is no run-path probe, because there is no restored local model.**
This was the largest single piece of the first draft and it was aimed at a case
that does not exist. Local models are never in Pi's registry: `getModels`
returns `[]` for both providers under `allowModelNetwork: false`
(`session-registry.ts:97`), so `runtime.getModel` returns `undefined` and a
restored session falls through to `defaultModel`. The only way a local model
reaches a run is an explicit ref the client sends, which goes through
`resolveModel` → `buildOllamaModel` / `buildOpenAICompatibleModel`
(`models.ts:485`, `:490`). Those read the cache. Opening the picker fills it.

One consequence to state plainly, because it is the honest limit: a local chat
whose *first* run happens before the picker was ever opened gets the fallback.
The fallback is runnable, so that costs a less accurate window for one session,
not a failure. Do not add a run-path probe to close it.

**Keep the cache key `(providerId, normalizedBaseUrl, bareModelId)`.**
`normalizedBaseUrl` means trailing slashes stripped, matching the
`replace(/\/+$/, "")` the builders and routes already apply. The base URL
cannot differ between projects today — `OLLAMA_BASE_URL` and
`OPENAI_COMPATIBLE_BASE_URL` are process-global constants (`config.ts:90`,
`:99`) — so it is in the key as cheap insurance, not because two projects can
diverge.

**The bare id is the load-bearing component.** `resolveModel` strips the
prefix before calling either builder — `buildOllamaModel(r.slice("ollama/".length))`
at `models.ts:486`, the same for `openai-compatible` at `:491` — so the builders
only ever see the bare id and cannot look up a ref-keyed entry. A ref-keyed
cache would miss 100% of the time and look like it worked.

**Do not expire entries. Overwrite them.** An earlier draft gave entries a 60 s
TTL. Expiry actively creates the failure this plan exists to remove: nothing
refreshes the cache on its own, so an expired entry does not become correct, it
becomes the 128,000 fallback. For a 256K model that is an *under*-declaration,
which is the silent early-compaction case. Entries live until something
overwrites them.

The two directions are not symmetric. After a 256K-to-32K swap the cache serves
the stale high value and runs fail with the overflow message until the picker is
reopened — loud and actionable, *given Phase 0*. After the opposite swap the
cache serves the stale low value and Kady compacts earlier than it needs to —
silent, accepted, and self-correcting on the next picker open. Do **not** "fix"
the second with a monotonic max-wins update: that makes the downward swap
unrepairable, trading a silent inefficiency for a permanent broken state.

**Dedup per server, not per model, and keep the key scope-free.** One list call
fills every model's entry, so the dedup scope is the call. Two picker opens in
quick succession must share one in-flight probe — that is also what closes the
reordering window, without needing the generation counter an earlier draft
proposed. With the run-path probe gone there is exactly one probe shape per
provider, so the key is `(providerId, baseUrl)` and the superset-join rule the
draft spent four hundred words on is deleted.

**The probe never rejects.** A timeout, a dead daemon, a 404, a malformed body:
all resolve normally, with no cache write. It is `Promise<void>` — its product
is the cache write, not a return value. Nothing rejects, so no caller needs a
`.catch()`, the route needs no `try`/`catch`, and a forgotten promise cannot
become an unhandled rejection.

**Clear the pending entry on settle, and give the probe its own 2 s
`AbortController`.** Otherwise one failed probe blocks every later retry for the
life of the process, and a hanging server wedges the picker path permanently.
These two requirements combine into a wedge if either is missing.

**Store the two figures in separate slots. Do not overlay them.** Each entry
holds `{ architectural?: number, loaded?: number }` and `getContextWindow`
returns `loaded ?? architectural`, recomputed on read. Overlaying loses the
architectural figure, and the loaded one is the transient of the pair: load with
`num_ctx: 8192`, let it unload, and an overlaid entry says 8,192 forever while
the server serves 40,960.

One rule that is easy to get backwards: a *successful* loaded-probe clears the
loaded slot for every model it did **not** report, because that is what
unloading looks like. A *failed* loaded-probe clears nothing.
Absent-from-a-good-answer and no-answer-at-all are opposite cases. The cost of
that rule — a model that unloads while `/api/ps` is failing keeps its stale
loaded figure — is under-declaration, which is the safe direction, and it
converges on the next successful probe. Do not "fix" it by clearing on failure:
every transient blip would then wipe a good figure and over-declare.

**Prefer `loaded_context_length` over `max_context_length`** when both are
present. The loaded value is what the request is measured against, and it can be
lower.

**Raise the fallback to 128,000 — but not before Phase 0.** These ship together
or not at all. Until a compaction failure is visible, a 128,000 fallback against
a real 32,768 server reproduces exactly the empty-run failure this plan exists
to remove. Three arguments for the number: it is what the repo already uses when
it has no better information (`models.ts:75`, `:136`); it is what Pi itself
defaults a compat-provider model to (`provider-composer.js:72`); and it clears
the prompt floor with headroom. `44409 + 16384` = 60,793, so 65,536 would clear
the arithmetic while leaving 4,743 tokens of working space — enough for a
trivial exchange, not enough for real work.

**No env knobs. The escape hatch already shipped.** The first draft added
`OLLAMA_CONTEXT_WINDOW` and `OPENAI_COMPATIBLE_CONTEXT_WINDOW` for the case
where the probe answers wrongly. Custom model servers
(`docs/custom-model-servers.md`, `server/src/agent/custom-models.ts`) already
cover that case better: a user points a custom provider at the same base URL and
declares `contextWindow` per model from Settings → Model providers, and the
route already serves that figure as a real `context_length`
(`custom-models.ts:287`). A per-provider global would cap every model on the
provider to correct one — the exact granularity failure this plan's own
reasoning rejects. Document the custom-server route in the local-model docs
instead. Reversing this costs one `config.ts` block plus its tests, if a real
case for a global override ever appears.

**Custom providers pointed at a local server are out of scope.** They resolve
through `custom-models.ts`, not through the builders, and they already carry a
user-declared window. This plan does not probe for them.

**Keep the two providers on parallel paths.** `models.ts:241` documents that the
two builders are deliberately not factored into a shared base, and
`api/system.ts:89` says the same about the two discovery routes: the protocols
are unrelated and Ollama's is upstream-owned. This plan touches four places
rather than two, on purpose.

**The picker's badge lags by one open on LM Studio, and that is accepted.**
`model-selector.tsx:282` renders the badge behind `{model.context_length > 0 &&
(…)}`, so a zero hides the badge rather than printing "0". A cold LM Studio
open therefore looks exactly like today. Ollama is better: its architectural
figure is parsed inline from the `/api/tags` payload the route already holds, so
its badge is right on the first open. No push, no polling, no
refetch-on-probe-settle — one gesture refreshes everything.

**Out of scope, with one caveat.** Overriding `reserveTokens`, changing
compaction behaviour, and shrinking Kady's 44,409-token prompt are separate
questions. The caveat: they are separable but not independent. Kady needs about
61,000 tokens of window at the default reserve, so for any local model below
that, this plan converts a silent failure into a loud one without making the
model usable. That is a strict improvement, but "the local path works now" would
be an overstatement after this lands.

## Adjacent bug found during verification

A session restored **without** a client-supplied model ref cannot keep a local
model: `runtime.getModel` returns `undefined` for both local providers, so
`session.model` falls through to `defaultModel` and the chat silently switches
to the configured default (OpenRouter, normally). The web client persists
`selectedModel` per tab and sends it on every run
(`web/src/lib/workspace-persistence.ts:59`, `use-agent.ts:531`), so the UI path
is unaffected; a headless or MCP-initiated run that omits `model` is not. This
is a separate defect from the context window. Record it as its own todo item;
do not widen this plan to cover it.

## Proposed information architecture / file changes

```text
server/src/agent/events.ts             MODIFIED — surface compaction_end errorMessage (Phase 0)
server/src/agent/local-context.ts      NEW — probe helpers + the canonical-key cache
server/src/agent/models.ts             MODIFIED — builders read the cache, fallback 128K
server/src/api/system.ts               MODIFIED — both discovery routes fill the cache
server/test/local-context.test.ts      NEW — cache, probe parsing, dedup, failure modes
server/test/openai-compatible.test.ts  MODIFIED — the context_length: 0 assertions (:229, :239)
server/test/model-refusal.test.ts      MODIFIED — compaction_end forwarding (Phase 0);
                                       there is no events.test.ts, and this file
                                       already covers toClientFrame error mapping
docs/local-models-ollama.md            MODIFIED — how the window is discovered, and
                                       the custom-server route for overriding it
dev-docs/todo.md                       MODIFIED — delete section 5 on completion
```

No `config.ts` change: the env knobs are dropped.

## Implementation sequence

### Phase 0 — Make the loud failure actually loud

A prerequisite, not a nicety. Every later decision assumes an over-declared
window surfaces an actionable error, and today it does not.

- [ ] Extend the **existing** `compaction_end` case at `events.ts:412`. It
      currently reads `if (ev.aborted || !ev.result) return null;` and then
      renders a compaction system card. Pi sets `result: undefined` and
      populates `errorMessage` on every failure emit
      (`agent-session.js:1580`, `:1672`, `:1874`; the field is on the event
      type at `agent-session.d.ts:65`), so that early return is what swallows
      the overflow message today. Note which emits those are: the manual
      failure at `:1580`, the overflow-recovery failure at `:1672`, and the
      auto-compaction `catch` at `:1874`. The abort branch at `:1812` carries
      no `errorMessage` at all, which is why the `aborted` bail stays first. Before it, return
      `{ type: "error", message: ev.errorMessage }` when `errorMessage` is
      present and `ev.aborted` is false. Keep the `aborted` bail ahead of it:
      a user-cancelled compaction is not an error.
- [ ] **Omit `reason` and `kind`.** `reason` on a `message_update` error is
      Pi's `"error" | "aborted"` (`events.ts:434`), while `compaction_end`
      carries its own `reason: "overflow"`. Those vocabularies are unrelated
      and nothing reads the field — the client dispatches on `frame.type` and
      reads only `frame.kind` on an error frame (`use-agent.ts:766`), where
      `kind === "budget"` means "blocked". An overflow is not a spend-cap
      block, so leaving `kind` off resolves it to `"error"`, which is correct.
      Do not reuse the `Model error: ` prefix from `events.ts:437`; this is not
      a provider failure and Pi's message is already a complete sentence.
- [ ] Note that `compaction-bridge.ts:249` already logs
      `session_compact_failed` server-side. That is the same information on a
      different hook; it is a useful cross-check while testing, not a
      substitute, because it never reaches the client.
- [ ] Add tests to `model-refusal.test.ts`: a `compaction_end` with an
      `errorMessage` produces an `error` frame carrying that exact text; one
      with a `result` still produces the compaction system card; one with
      neither still returns `null`.

**Exit criteria:** a run against a deliberately over-declared window shows the
overflow text instead of an empty assistant bubble.

### Phase 1 — Verify the two probe shapes

- [x] LM Studio's loaded-versus-architectural divergence, verified 2026-09-11:
      `allenai/olmocr-2-7b` returned `max_context_length: 128000` with
      `loaded_context_length: 64000`. Quoted in the findings file.
- [x] Ollama's `/api/tags` → `details.context_length` and `/api/ps` →
      `context_length`, verified 2026-09-11 on 0.33.2. Re-confirm against your
      own version: the field is absent in older releases.
- [x] **LM Studio's model-name round trip, verified 2026-09-18.** All six ids
      from `/v1/models` are byte-identical to those from `/api/v0/models`, so
      the route's list and the probe's writes share a key. See the findings
      file for the captured ids.
- [ ] **Ollama's model-name round trip is still open, and still blocks Phase 2.**
      `/api/tags` returns names that usually carry a tag (`llama3:latest`),
      while the bare id `resolveModel` hands the builder comes from the user's
      ref (`models.ts:486`), which may omit it. If `llama3` and `llama3:latest`
      can denote one model they are two cache keys and every lookup misses —
      silently, because the probe succeeds and the entry is written. Settle
      which form each side uses and normalise in `cacheKey` if they differ,
      **before** writing `local-context.ts`. No daemon was running on
      2026-09-18, so this could not be closed with the rest.

**Exit criteria:** both field names quoted from live output, and the Ollama
round trip resolved.

### Phase 2 — Cache and probe

- [ ] Add `server/src/agent/local-context.ts`: a module-level cache keyed by
      `(providerId, normalizedBaseUrl, bareModelId)`, no TTL. Export five
      things so the callers do not each invent a shape:
      `cacheKey(providerId, baseUrl, modelId): string`;
      `getContextWindow(providerId, baseUrl, modelId): number | undefined`
      returning `loaded ?? architectural`; `recordArchitectural(key, value)`
      and `recordLoaded(key, value | undefined)`; and
      `probeLoaded(providerId, baseUrl): Promise<void>`, sharing one dedup map
      keyed `(providerId, baseUrl)` and a 2 s timeout. A second caller joins
      the in-flight promise rather than starting a rival.
- [ ] Never let a failed probe destroy a good entry. Write only when the parsed
      value is a positive integer; on a 404, a timeout, a malformed body or a
      zero, leave the existing entry alone. A refresh that fails is a no-op,
      not a downgrade to the fallback.
- [ ] Fill the cache from `GET /openai-compatible/models` with a **second,
      independent** call to `/api/v0/models`, preferring `loaded_context_length`
      and falling back to `max_context_length` — never skip an entry because it
      is not loaded. **Do not await it and do not share its
      `AbortController`.** One shared signal would abort the `/v1/models` call
      that had already succeeded, and awaiting would make the picker wait the
      full 2 s for a hung probe before rendering a list it already had.
      `/api/v0/models` is LM Studio's own endpoint; vLLM,
      text-generation-webui and the rest 404 it. A 404, a timeout or a
      malformed body means "no context metadata", never "no models" — the
      route must still return every row `/v1/models` gave it.
- [ ] Fill the cache from `GET /ollama/models` by reading
      `details.context_length` out of the `/api/tags` response the route
      already fetches (`api/system.ts:67`). No extra call, no fan-out.
- [ ] Then fetch the loaded figures with **one** extra call to `/api/ps`,
      unawaited, with its own `AbortController`, failing into a no-op. They go
      into the entry's `loaded` slot. `/api/ps` returns every running model at
      once, so this is bounded.

      Both providers cost two calls per open; they differ only in which call
      carries which figure. LM Studio: `/v1/models` for the list,
      `/api/v0/models` for both figures. Ollama: `/api/tags` for the list *and*
      the architectural figure, `/api/ps` for the loaded one — the cheaper
      side, because its list call does double duty.

      Ollama's architectural write goes through **neither** probe: it is parsed
      inline from the payload the route already holds, synchronously, before
      the route replies. Re-fetching `/api/tags` to route it through a shared
      function would buy nothing and cost a duplicate call.
- [ ] Serve each route's `context_length` from the cache instead of the
      hardcoded `0`: the cached figure when there is one, `0` when there is
      not. **Do not make the route await the probe to avoid a cold `0`.** On a
      cold first open the honest answer is `0`, which the picker already
      renders as "no badge".

**Exit criteria:** opening the picker populates the cache for both providers,
and reopening it after either local server changes overwrites those entries.
`npm run verify -- server` green.

### Phase 3 — Consume it

- [ ] In both builders, resolve the cache and fall back to 128,000. Each
      builder already holds its own provider id and base URL as constants, so
      it can build the key from what it has; no signature changes.
- [ ] Update the comment at `models.ts:247`. It is correct about `/v1/models`
      and should stay — extend it to say why the native endpoint is consulted
      instead, so the next reader does not re-derive this.
- [ ] Fix the test expectations. `server/test/openai-compatible.test.ts` has
      **no** 32K builder assertions to update; what it has is two route
      assertions on `context_length: 0` (`:229`, `:239`), which break the
      moment the routes return real values. Update those, and add the builder
      assertions that do not exist yet — otherwise the fallback change ships
      with no regression coverage at all.

**Exit criteria:** `resolveModel("openai-compatible/qwen/qwen3.8-27b", …)`
returns the probed figure with a warm cache and 128,000 with a cold one.

### Phase 4 — Confirm the bug is actually gone

- [ ] Run one trivial request against LM Studio end to end and confirm a
      non-empty assistant message. Record the project's `reserveTokens` with
      the result; the floor below is computed at 16,384.
- [ ] Confirm compaction does not fire on the first turn — and decide *how you
      will see that* before asserting it. There is no UI signal:
      `compaction_start` is dropped by `toClientFrame`, and Phase 0 only
      surfaces `compaction_end` when it carries an `errorMessage`. Observe it
      from the Pi session JSONL, or from the `session_compact_failed` warning
      `compaction-bridge.ts:249` already logs. Do not assert a negative you
      cannot see.
- [ ] Load the same model at a *reduced* context length without reopening the
      picker. Expect the run to fail with the overflow message from Phase 0,
      not to work and not to silently compact. If the message does not appear,
      Phase 0 is incomplete and the fallback argument is resting on nothing.
- [ ] Then reopen the picker, and be careful about what "repair" means. It
      refreshes the *declared value*; it does not make an impossible prompt fit.
      - Reduce to **65,536**, above the 60,793 floor. After reopening, the run
        should succeed. This is the repair case.
      - Reduce to **16,384**. After reopening, the run should still fail, and
        still fail *visibly*. That is correct behaviour, not a regression.
- [ ] Distinguish the two candidate mechanisms before declaring the bug fixed.
      If the loaded server really holds 262,144, the 44,409-token prompt
      *fits*, so there may have been no rejection and no overflow path at all —
      and the empty bubble would instead be the server returning an empty
      success (`stop` or `length`, no error, run `done`). Declaring the window
      truthfully cures that path too, but Phase 0's machinery is irrelevant to
      it, so a green run does not by itself confirm the compaction story. Check
      the raw response shape or the server log and say which one it was.
- [ ] If the empty-message symptom survives, stop and say so. The mechanism
      here is a hypothesis, and a surviving symptom falsifies it rather than
      calling for a bigger number.

**Exit criteria:** the Phase 2 external-client symptom does not reproduce, or is
recorded as unexplained with the compaction hypothesis ruled out.

## Guardrails

- The probe is best-effort. A local server that is down, slow, or returns
  nonsense must fall back silently — a dead Ollama must never make a run fail.
- No fan-out inside a discovery route. Ollama reads `/api/tags` (already
  fetched) plus one `/api/ps`; LM Studio adds one `/api/v0/models`. Never one
  call per model.
- The native LM Studio probe must never be able to empty the model list. The
  OpenAI-compatible route serves vLLM and others that do not implement
  `/api/v0/models`; losing context metadata is acceptable, losing the models is
  not.
- Keep the existing 2 s `AbortController` on both routes. This is on the
  picker's path and must not hang the UI.
- `resolveModel` stays synchronous, and nothing on the run path probes.
- No shared base between the two providers, per `models.ts:241` and
  `api/system.ts:89`.
- Local providers stay `$0`-costed; nothing here touches `billingForProvider`
  or the spend cap.
- Kady must behave identically for anyone who configures nothing.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| The declared window matches the server | `resolveModel` returns the probed figure for a live LM Studio model, not 32,768 |
| Cold start no longer under-declares | With the cache empty, the builders return 128,000, above the 44,409 + 16,384 floor |
| Overflow is visible at all | A `compaction_end` carrying an `errorMessage` reaches the client as an `error` frame instead of being dropped by the `!ev.result` bail at `events.ts:413` |
| Ordinary compaction is unchanged | A `compaction_end` carrying a `result` still renders the compaction system card, and an aborted one still returns `null` |
| A stale entry fails loudly and is repairable | Reduce the loaded window in LM Studio; the run fails with the overflow message rather than compacting silently, and reopening the picker fixes it |
| A large model never silently loses its window | Warm the cache, wait, and confirm the declared window has not decayed to the fallback |
| Every new HTTP call goes through the shared probe | Assert `/api/v0/models` and `/api/ps` go through `probeLoaded`, not a private `fetch`, and that a second call started while the first is in flight joins it. Ollama's architectural figure on the picker path is exempt — parsed inline from the `/api/tags` payload the route already holds |
| Two picker opens cannot race | Delay one `/api/v0/models` response and open the picker again while it is in flight; the second reuses the in-flight probe, so no reordering is possible |
| The probe never rejects | Point it at a closed port, a 404 and a malformed body in turn; each resolves normally, leaves the cache untouched, and logs no unhandled rejection. The route still returns its model list and never a 500 |
| A failed refresh is a no-op | Warm the cache, then make the probe 404; the cached value survives rather than reverting to 128,000 |
| A slow native probe cannot stall the picker | Stub `/api/v0/models` to hang; `GET /openai-compatible/models` returns as soon as `/v1/models` does, without waiting for the probe or its timeout |
| The native probe still lands afterwards | With the probe merely slow rather than hung, the route returns first; once the probe settles, the cache holds the probed value |
| An unknown small server fails loudly — *on a server that errors* | Native probe 404s and the real server holds 32,768; the prompt is rejected with the overflow message rather than silently compacted. A silently truncating Ollama is an accepted exception, not a failing test |
| Ollama discovery stays inside its budget | `GET /ollama/models` takes the architectural figure from the `/api/tags` payload it already has, and makes at most one extra unawaited `/api/ps` call, so its response timing is unchanged with 10+ models present |
| The loaded figure wins over the architectural one | With `allenai/olmocr-2-7b` loaded, the declared window is 64,000, not 128,000. With `num_ctx: 8192` on Ollama, it is 8,192, not 40,960 |
| A cold cache hides the badge rather than faking one | With the cache empty, LM Studio rows carry `0` and render no badge. Ollama rows carry their architectural figure on the *first* open |
| An unloaded model reverts | Load with `num_ctx: 8192`, confirm 8,192, let it unload, and confirm the next successful probe clears the loaded slot so 40,960 is declared again |
| A failed loaded-probe clears nothing | Warm both slots, then make `/api/ps` fail; the loaded slot survives |
| Opening the picker repairs either provider | Change the served context on each server in turn, reopen the picker, confirm the cached value follows |
| A non-LM-Studio server still lists models | Point `OPENAI_COMPATIBLE_BASE_URL` at a server that 404s `/api/v0/models`; the route returns its full `/v1/models` list |
| A warm cache entry is actually found | The builders' bare-id lookup hits an entry written by the discovery route, rather than silently falling back |
| A dead local server is harmless | Probe with nothing listening; the run still resolves at the fallback |
| The original symptom is fixed | One local run returns a non-empty assistant message |
| No regression elsewhere | `npm run verify -- server` green, with no drop in the suite's test count |
