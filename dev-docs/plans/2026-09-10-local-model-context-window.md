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

**Goal:** Make the local-model path runnable. Today `buildOllamaModel` and
`buildOpenAICompatibleModel` declare a 32,768-token context window that is far
below Kady's own prompt, so every local run is over budget before it starts.
Replace the guess with the value the local server already reports, and raise the
fallback for the case where it reports nothing.

Recorded as [todo “Local-model context window is hardcoded to
32K”](../todo.md#5-local-model-context-window-is-hardcoded-to-32k).

## Why this work

`server/src/agent/models.ts:233` and `:246` both hardcode
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

Pi's compaction is on by default and Kady never overrides it, so the harness
default applies (`@earendil-works/pi-agent-core`,
`dist/harness/agent-harness.js:97`, matching `DEFAULT_COMPACTION_SETTINGS` at
`dist/harness/compaction/compaction.js:85`):

```js
{ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }
```

and the trigger (`compaction.js:154`) is:

```js
export function shouldCompact(contextTokens, contextWindow, settings) {
    if (!settings.enabled) return false;
    return contextTokens > contextWindow - settings.reserveTokens;
}
```

So the effective budget is `32768 - 16384` = **16,384 tokens**, against a
44,409-token prompt. That is not 1.35× over, it is 2.7× over.

This also supplies the mechanism for the observed symptom. Compaction fires on
the very first turn and can never succeed, because what is over budget is the
system prompt plus the seeded `AGENTS.md` plus the tool surface — none of which
compaction can cut. The run then completes as `done` with an empty assistant
message and no error frame, exactly as recorded during the Phase 2 external
client check.

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

Ollama's `POST /api/show` is the stated equivalent. It is likewise
**unverified**: the CLI is installed at `/usr/local/bin/ollama` but the daemon
was not running during this research (`curl http://localhost:11434/` returned no
response), and starting a background daemon on the owner's machine was out of
scope for writing a plan. The implementing PR must probe a live Ollama and
record the real field name, because the two providers are separate code paths
and a guess in one does not validate the other.

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

**Accept that the cache can be cold.** If a run starts before the picker has
ever been opened, the lookup misses and the fallback applies. That is the
correct trade: it is the current behaviour, only with a better number, and it
self-corrects the first time the picker opens. Do not add a blocking
warm-up — this is a local-only path and a cold miss is not a failure.

**Prefer `loaded_context_length` over `max_context_length`** when both are
present, per the reasoning above: the loaded value is what the request is
measured against, and it can be lower.

**Raise the fallback to 128,000.** Two arguments. It matches what the repo
already uses when it has no better information (`models.ts:132`, and `:71`).
And the two failure directions are not symmetric: declaring too high fails
loudly at the provider, with the provider's own message reaching the user
through the existing error frame, whereas declaring too low fails silently in
the way this plan exists to fix. Prefer the loud failure.

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

**Out of scope.** Overriding Pi's `reserveTokens`, changing compaction
behaviour, and shrinking Kady's 44,409-token prompt are all real questions and
all separate from this one. This plan makes the declared window truthful and
stops there.

## Proposed information architecture / file changes

```text
server/src/agent/local-context.ts      NEW — probe helpers + the id→window cache
server/src/agent/models.ts             MODIFIED — builders read the cache, fallback 128K
server/src/api/system.ts               MODIFIED — both routes populate the cache
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

- [ ] Add `server/src/agent/local-context.ts`: a module-level
      `Map<string, number>` keyed by the full model ref (`ollama/…`,
      `openai-compatible/…`), a setter, and a lookup.
- [ ] Parse the context length in each of the two discovery routes and populate
      the cache. Keep the existing lenient parsing style — a malformed entry
      must not blank the list, so treat a bad or missing length as absent
      rather than as zero.
- [ ] Return the real value in each route's `context_length` field instead of
      the hardcoded `0`.

**Exit criteria:** opening the picker populates the cache; `npm run verify -- server` green.

### Phase 3 — Consume it

- [ ] Add `OLLAMA_CONTEXT_WINDOW` and `OPENAI_COMPATIBLE_CONTEXT_WINDOW` to
      `config.ts`, beside the existing `*_BASE_URL` knobs.
- [ ] In both builders, resolve in order: cache, then env knob, then 128,000.
- [ ] Update the comment at `models.ts:243`. It is currently correct about
      `/v1/models` and should stay — extend it to say why the native endpoint is
      consulted instead, so the next reader does not re-derive this.
- [ ] Update the two existing 32K assertions in
      `server/test/openai-compatible.test.ts`.

**Exit criteria:** `resolveModel("openai-compatible/qwen/qwen3.8-27b", …)`
returns 262,144 with a warm cache and 128,000 with a cold one.

### Phase 4 — Confirm the bug is actually gone

- [ ] Run one trivial request against LM Studio end to end and confirm a
      non-empty assistant message.
- [ ] Confirm compaction does not fire on the first turn.

**Exit criteria:** the Phase 2 external-client symptom does not reproduce.

## Guardrails

- The probe is best-effort. A local server that is down, slow, or returns
  nonsense must fall back silently, exactly as the two routes already do
  today — a dead Ollama must never make a run fail.
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
| A dead local server is harmless | Probe with nothing listening; run still resolves at the fallback |
| The original symptom is fixed | One local run returns a non-empty assistant message |
| No regression elsewhere | `npm run verify -- server` green; 785 tests pass |
