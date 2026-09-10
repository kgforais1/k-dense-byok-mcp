---
title: "Local-model context window: probe it instead of guessing 32K"
status: proposed
created: 2026-09-10
branch: local-context-window
---

# Local-Model Context Window Implementation Plan

**Status:** Proposed

> Status values: `Proposed` → `Accepted` (when implementation starts) →
> `Completed and merged in PR #<n>`. The implementing PR sets the
> final status and moves this file to `dev-docs/plans/completed/` in
> its closing checklist — never after merge. See
> `docs/development/workflow.md#archive-lifecycle`.

**Goal:** Make Kady declare the local model's real context window instead of
guessing 32,768. Today `buildOllamaModel` and `buildOpenAICompatibleModel`
hardcode a window far below Kady's own prompt, so every local run is over budget
before it starts. Replace the guess with the value the local server already
reports, and raise the fallback for the case where it reports nothing.

Stated deliberately narrowly. This makes the declared window *truthful*, which
makes large local models runnable and makes small ones fail legibly. It does not
make every local model work: Kady's prompt needs roughly 61,000 tokens of window
(44,409 plus the 16,384 reserve), so a genuine 8K or 32K local model will still
not run. What changes for those is that they stop failing silently and start
saying why. Closing that remaining gap means shrinking the prompt or the
reserve, which is separate work — see the out-of-scope note below.

Recorded as [todo “Local-model context window is hardcoded to
32K”](../todo.md#5-local-model-context-window-is-hardcoded-to-32k).

## Why this work

`server/src/agent/models.ts:233` and `:257` both hardcode
`contextWindow: 32_768`. The comment at `:243` is honest about the reason — the
standard OpenAI `/v1/models` endpoint carries no context length — and that part
is still true, verified 2026-09-10 against a live LM Studio:

```console
$ curl -s http://localhost:1234/v1/models
{ "data": [ { "id": "qwen/qwen3.8-27b", "object": "model",
             "owned_by": "organization_owner" }, … ] }
```

`id`, `object`, `owned_by`. Nothing else. So the original decision was correct
for the endpoint it was looking at.

### The gap is larger than the todo entry records

The todo compares Kady's measured 44,409-token prompt against the declared
32,768 window and concludes the floor exceeds the ceiling. The real ceiling is
lower still, because the harness reserves headroom on top of the declared
window.

The live path is `@earendil-works/pi-coding-agent`, not `pi-agent-core`. The
`AgentHarness` class in `pi-agent-core/dist/harness/agent-harness.js` is a stub
whose every method returns `unavailable` (`:109-164`), so citing its settings
block would be citing dead code. The real chain is:

- `AgentSession._checkCompaction` reads the declared window straight off the
  model — `const contextWindow = this.model?.contextWindow ?? 0`
  (`pi-coding-agent/dist/core/agent-session.js`). That is the direct link from
  the builders this plan changes to the trigger below.
- Settings come from `settingsManager.getCompactionSettings()`
  (`dist/core/settings-manager.js:565`), which resolves
  `this.settings.compaction?.reserveTokens ?? 16384` (`:560`). Kady sets no
  `compaction` settings anywhere in `server/src`, so the default applies.
- The trigger fires at `agent-session.js:1650` —
  `if (shouldCompact(contextTokens, contextWindow, settings))` — and
  `shouldCompact` (`dist/core/compaction/compaction.js`) is
  `contextTokens > contextWindow - settings.reserveTokens`.

So the effective budget is `32768 - 16384` = **16,384 tokens**, against a
44,409-token prompt. That is not 1.35x over, it is 2.7x over.

The 44,409 figure is an empirical measurement from the Phase 2 external-client
check, not a constant in the code. Re-measure it during implementation rather
than treating it as fixed.

This also supplies a **likely** mechanism for the observed symptom, and it is
worth being precise about how much of that is established. The arithmetic is
verified: the prompt exceeds the effective budget, so `shouldCompact` returns
true on the first turn, and compaction cannot cut what is over budget — the
system prompt, the seeded `AGENTS.md` and the tool surface are all fixed. The
step that is *not* verified is the last one, that this is what produces a `done`
run with an empty assistant message and no error frame. That symptom was
observed during the Phase 2 external-client check, and this chain explains it,
but the two have not been connected by observation. Treat it as the leading
hypothesis rather than a finding. Phase 4 exists to test it, and if the symptom
survives the fix then the cause is elsewhere and this plan has not addressed
it.

Two consequences for this plan. The fix is a correctness fix rather than a
tuning nicety, and any fallback we choose has to clear 44,409 *plus*
`reserveTokens`, not merely 44,409.

### The value is available, on a different endpoint

LM Studio's native API carries it, verified the same way:

```console
$ curl -s http://localhost:1234/api/v0/models
{ "data": [
  { "id": "qwen/qwen3.8-27b", "arch": "qwen3_5", "state": "not-loaded",
    "max_context_length": 262144, "capabilities": ["tool_use"] },
  { "id": "mistralai/devstral-small-2-2512", "state": "not-loaded",
    "max_context_length": 393216, … },
  { "id": "allenai/olmocr-2-7b", "state": "not-loaded",
    "max_context_length": 128000 }, … ] }
```

Every entry carries `max_context_length`. The declared 32,768 is 8× low for the
model the owner actually runs.

`loaded_context_length` is documented as the companion field, and it matters
more than `max_context_length` does: LM Studio lets you load a model at less
than its architectural maximum, and it is the loaded value that the request
will actually be measured against. It was not observable in the probe above —
every model read `"state": "not-loaded"`, and the field was absent from all of
them. Treat its exact shape as **unverified** and confirm it against a loaded
model during implementation rather than trusting this plan for it.

### Ollama is not symmetrical with LM Studio, and that shapes the design

Ollama's `POST /api/show` is the stated equivalent, and it is still
**unverified**: the daemon is installed and reachable, but `ollama list` returns
an empty set on this machine, so there is no model to probe and no real response
to quote. Pulling one is a multi-gigabyte download and was out of scope for
writing a plan. The implementing PR must probe a live Ollama and record the real
field name rather than assuming it mirrors LM Studio.

What *is* clear without a live probe is a structural difference that the first
draft of this plan missed. LM Studio answers for every model in **one** call:
`/api/v0/models` returns `max_context_length` per entry. Ollama does not.
`/api/tags`, which `GET /ollama/models` already calls, carries no context length
at all, so covering every model would mean one `POST /api/show` **per model** —
an N+1 fan-out inside a route that holds a single 2 s budget. For a user with a
dozen models that either blows the timeout or forces the timeout up, and this
route is on the picker's path.

So the two providers get different probe strategies, which is consistent with
them already being deliberately parallel paths:

- **LM Studio / OpenAI-compatible:** probe in the discovery route. One call,
  every model, no extra cost over what the route already pays.
- **Ollama:** do **not** fan out in the discovery route. Probe `/api/show` for a
  single model id, on demand, through a separate lightweight endpoint the picker
  calls when a model is actually selected. One model is selected at a time, so
  there is no fan-out, and the run path stays synchronous because the result
  lands in the same cache before the run starts.

If the on-demand probe has not run — the user selected nothing, or restored a
saved model ref — the cache misses and the fallback applies, exactly as for a
cold LM Studio cache.

## Design decisions

**Probe, with an env override, rather than env knobs alone.** The todo offers
env-only as the cheap option. It is not much cheaper here, because the probe
point already exists and already talks to both servers, and it is strictly
worse: an env knob is one global number, while the right window differs per
model — 262,144 and 393,216 and 128,000 all appeared in a single probe above.

**Probe from the existing discovery routes, not from `resolveModel`.**
`resolveModel` (`models.ts:412`) is synchronous, and it is on the run path
(`api/sessions.ts:254`). Awaiting a network call inside it would mean making it
async and changing four call sites (`latex/assist.ts:133`,
`agent/methods-draft.ts:174`, `api/sessions.ts:254-255`, `models.ts:477`), and
would put a network round trip — with its own timeout and failure mode — between
the user pressing send and the run starting.

There is no need for any of that. `GET /ollama/models` (`api/system.ts:63`) and
`GET /openai-compatible/models` (`api/system.ts:96`) already call both servers
whenever the model picker opens, both already run async with a 2 s
`AbortController` timeout, and both currently hardcode `context_length: 0` in
the rows they return. Read the real value there, cache it by model id, and have
`resolveModel` do a synchronous cache lookup. The builders stay synchronous and
no call site changes.

**Accept that the cache can be cold. Do not accept that it can be stale.**
A cold cache is benign: the lookup misses, the fallback applies, and it
self-corrects the first time the picker opens. Do not add a blocking warm-up.

A *stale* cache is not benign, and the first draft of this plan ignored it.
Both reviewers raised it independently, and they are right. The user loads a
256K model in LM Studio, opens the picker (caching 256,000), then swaps to a 32K
model without reopening the picker. Kady now declares 256,000 for a model that
physically holds 32,768 and sends a prompt that cannot fit, on every turn, until
the user somehow guesses that reopening the picker is the fix. That is a worse
failure than the one this plan exists to remove, because it is both persistent
and unguessable.

Three requirements follow, and the implementation is not correct without them:

- **Key the cache by base URL as well as model ref.** A module-level
  `Map<modelRef, number>` is process-global. Two projects pointed at different
  local servers would otherwise share one entry and serve each other's window.
  Key on `(baseUrl, modelRef)`.
- **Give entries a TTL** — 60 seconds is a reasonable start. Local servers are
  restarted and reconfigured constantly during exactly the kind of local-model
  work this feature serves, so an entry should not outlive a plausible fiddle.
  On expiry, fall back rather than blocking on a refresh.
- **Refresh on every discovery call.** The routes overwrite, never merge, so
  reopening the picker is always a repair.

**The env knob outranks the probe.** The first draft resolved cache first and
still called these knobs "overrides", which they would not have been: both
discovery routes fill the cache the moment the picker opens, so a probed value
would have silently beaten anything the operator configured. Resolve env first.
That is what makes the knob an escape hatch — it is there for the case where the
probe is available but wrong, which is the only case anyone would reach for it.

**Key the cache on the bare model id, not the provider-prefixed ref.** This is
easy to get backwards. `resolveModel` strips the prefix before it calls either
builder — `buildOllamaModel(r.slice("ollama/".length))` at `models.ts:432`, and
the same for `openai-compatible` at `:441` — so the builders only ever see the
bare id and cannot look up a ref-keyed entry. Every warm entry would miss and
fall back to 128,000, which is exactly the kind of failure that looks like it
works. Key on `(providerId, baseUrl, bareModelId)`. Each builder already holds
its own provider and base URL as constants, so it can construct the key from
what it has, and no signature changes.

**Prefer `loaded_context_length` over `max_context_length`** when both are
present, per the reasoning above: the loaded value is what the request is
measured against, and it can be lower.

**Raise the fallback to 128,000.** Two arguments. It matches what the repo
already uses when it has no better information (`models.ts:132`, and `:71`).
And the two failure directions are not symmetric. This was checked rather than
assumed: on a context-overflow error Pi compacts and retries once, and if that
does not recover it surfaces `"Context overflow recovery failed after one
compact-and-retry attempt. Try reducing context or switching to a larger-context
model."` (`pi-coding-agent/dist/core/agent-session.js:1595`). That is an
actionable message reaching the user. Declaring too low fails silently, in the
way this plan exists to fix. Prefer the loud failure.

The fallback must clear the prompt floor with reserve headroom. `44409 + 16384`
= 60,793, so 128,000 clears it with room for the conversation itself; 65,536
would clear the arithmetic but leave roughly 4 KB of actual working space, which
is not a usable agent.

**Keep the two providers on parallel paths.** `models.ts:238` documents that
`buildOllamaModel` and `buildOpenAICompatibleModel` are deliberately not
factored into a shared base, and `api/system.ts:89` says the same about the two
discovery routes: the protocols are unrelated and Ollama's is upstream-owned.
This plan touches four places rather than two, on purpose. Do not "clean that
up" along the way.

**Out of scope, with one caveat.** Overriding Pi's `reserveTokens`, changing
compaction behaviour, and shrinking Kady's 44,409-token prompt are all real
questions and all separate from this one. This plan makes the declared window
truthful and stops there.

The caveat, raised in review and worth recording rather than waving away: these
are separable but not independent. Kady needs about 61,000 tokens of window to
function at all, so for any local model below that, this plan converts a silent
failure into a loud one without making the model usable. That is still a strict
improvement — an unusable model that says so beats one that returns an empty
message — but it means "the local path works now" would be an overstatement
after this lands. If small local models turn out to matter, raise a follow-up
todo for the prompt floor itself. Do not quietly widen this plan to cover it.

## Proposed information architecture / file changes

```text
server/src/agent/local-context.ts      NEW — probe helpers + the (baseUrl, ref) TTL cache
server/src/agent/models.ts             MODIFIED — builders read the cache, fallback 128K
server/src/api/system.ts               MODIFIED — LM Studio route fills the cache;
                                       NEW route probes one Ollama model on demand
server/src/config.ts                   MODIFIED — two env override knobs
server/test/local-context.test.ts      NEW — cache, probe parsing, precedence
server/test/openai-compatible.test.ts  MODIFIED — existing 32K assertions
docs/model-selection.md                MODIFIED — document the knobs
dev-docs/todo.md                       MODIFIED — delete section 5 on completion
```

## Implementation sequence

### Phase 1 — Verify the two probe shapes

- [ ] Load a model in LM Studio and re-probe `/api/v0/models`. Record whether
      `loaded_context_length` appears, and whether it differs from
      `max_context_length` when the model is loaded below its maximum.
- [ ] Start Ollama, `POST /api/show` for a pulled model, and record the actual
      field carrying the context length. Do not assume it mirrors LM Studio.
- [ ] Write both real response fragments into this plan before writing code.

**Exit criteria:** both field names are quoted from live output, not from
documentation or from this plan's guesses.

### Phase 2 — Cache and probe

- [ ] Add `server/src/agent/local-context.ts`: a module-level cache keyed by
      `(providerId, baseUrl, bareModelId)` with a 60 s TTL, a setter, and a
      lookup that treats an expired entry as a miss. Note the key is the
      **bare** id, not the provider-prefixed ref — see the note below on why.
- [ ] Fill the cache from `GET /openai-compatible/models` with a **second,
      independent** call to `/api/v0/models`, preferring
      `loaded_context_length` over `max_context_length`. It must not replace
      the `/v1/models` call and must not share its failure. `/api/v0/models` is
      LM Studio's own endpoint; vLLM, text-generation-webui and the rest answer
      `/v1/models` and 404 the native one. A 404, a timeout or a malformed body
      means "no context metadata", never "no models" — the route must still
      return every row `/v1/models` gave it. Keep the existing lenient parsing
      style, so a bad or missing length is absent rather than zero.
- [ ] Add the on-demand Ollama route (one model id, one `POST /api/show`) and
      have the picker call it on selection. Do **not** fan out across
      `/api/tags`; see the Ollama section above for why.
- [ ] Return the real value in each route's `context_length` field instead of
      the hardcoded `0`.

**Exit criteria:** opening the picker populates the cache; a second open after
the TTL refreshes it; `npm run verify -- server` green.

### Phase 3 — Consume it

- [ ] Add `OLLAMA_CONTEXT_WINDOW` and `OPENAI_COMPATIBLE_CONTEXT_WINDOW` to
      `config.ts`, beside the existing `*_BASE_URL` knobs.
- [ ] In both builders, resolve in order: env knob, then cache (unexpired),
      then 128,000. The env value wins over a probed one — see the precedence
      note in the design decisions.
- [ ] Update the comment at `models.ts:243`. It is currently correct about
      `/v1/models` and should stay — extend it to say why the native endpoint is
      consulted instead, so the next reader does not re-derive this.
- [ ] Fix the test expectations, which are not what the first draft of this
      plan claimed. `server/test/openai-compatible.test.ts` has **no** 32K
      builder assertions to update. What it does have is two route assertions
      on `context_length: 0` (`:229`, `:239`), and those break the moment the
      routes return real values. Update those, and add the builder assertions
      that do not exist yet — otherwise the fallback change ships with no
      regression coverage at all.

**Exit criteria:** `resolveModel("openai-compatible/qwen/qwen3.8-27b", …)`
returns 262,144 with a warm cache, 128,000 with a cold or expired one, and the
env value whenever one is set regardless of cache state.

### Phase 4 — Confirm the bug is actually gone

- [ ] Run one trivial request against LM Studio end to end and confirm a
      non-empty assistant message.
- [ ] Confirm compaction does not fire on the first turn.
- [ ] Load the same model in LM Studio at a *reduced* context length, confirm
      the declared window follows it down, and confirm a stale entry cannot
      outlive the TTL.
- [ ] If the empty-message symptom survives, stop and say so. The mechanism in
      this plan is a hypothesis, and a surviving symptom falsifies it rather
      than calling for a bigger number.

**Exit criteria:** the Phase 2 external-client symptom does not reproduce, or is
recorded as unexplained with the compaction hypothesis ruled out.

## Guardrails

- The probe is best-effort. A local server that is down, slow, or returns
  nonsense must fall back silently, exactly as the two routes already do
  today — a dead Ollama must never make a run fail.
- No fan-out inside a discovery route. The Ollama probe is one model per call,
  on demand; an N+1 across `/api/tags` would blow the 2 s budget on the
  picker's path.
- The native LM Studio probe must never be able to empty the model list. The
  OpenAI-compatible route serves vLLM and others that do not implement
  `/api/v0/models`; losing context metadata is acceptable, losing the models is
  not.
- Keep the existing 2 s `AbortController` timeout on both routes. This is on the
  picker's path and must not hang the UI.
- `resolveModel` stays synchronous.
- No shared base between the two providers, per `models.ts:238` and
  `api/system.ts:89`.
- Local providers stay `$0`-costed; nothing here touches `billingForProvider` or
  the spend cap.
- The env knobs are overrides for the probe, not new required configuration.
  Kady must behave identically for anyone who sets neither.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| The declared window matches the server | `resolveModel` returns 262,144 for `qwen/qwen3.8-27b` against live LM Studio |
| Cold start no longer under-declares | With the cache empty, the builders return 128,000, above the 44,409 + 16,384 floor |
| A stale entry cannot persist | Reduce the loaded window in LM Studio; the declared value follows within the TTL without reopening the picker |
| Ollama discovery stays inside its budget | `GET /ollama/models` issues no `/api/show` calls; the route's timing is unchanged with 10+ models present |
| A non-LM-Studio server still lists models | Point `OPENAI_COMPATIBLE_BASE_URL` at a server that 404s `/api/v0/models`; the route returns its full `/v1/models` list |
| The env knob is actually an override | Set `OPENAI_COMPATIBLE_CONTEXT_WINDOW`, warm the cache, confirm the env value is what `resolveModel` returns |
| A warm cache entry is actually found | The builders' bare-id lookup hits an entry written by the discovery route, rather than silently falling back |
| A dead local server is harmless | Probe with nothing listening; run still resolves at the fallback |
| The original symptom is fixed | One local run returns a non-empty assistant message |
| No regression elsewhere | `npm run verify -- server` green; 785 tests pass |
