---
title: "Local-model context window: probe it instead of guessing 32K"
status: proposed
created: 2026-09-10
branch: local-context-window
---

# Local-Model Context Window Implementation Plan

**Status:** Proposed — reviewed during this PR.

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

This also supplies a **possible** mechanism for the observed symptom, and the
detail matters because an earlier draft of this plan got it wrong.

That draft said compaction "fires on the very first turn" and blocks the prompt
before it is sent. It does not. The pre-send check is guarded:
`const lastAssistant = this._findLastAssistantMessage(); if (lastAssistant) {
await this._checkCompaction(lastAssistant, false); }`
(`pi-coding-agent/dist/core/agent-session.js:866-868`). On the first turn of a
new session there is no prior assistant message, so the check is skipped
entirely and the full 44,409-token prompt goes to the model regardless of the
declared window.

That weakens the hypothesis rather than strengthening it, which is worth saying
plainly. The declared window cannot block the first send. It can only bite
afterwards, when `_checkCompaction` runs against the response and finds the
context far over the 16,384 effective budget, or when Pi's overflow path fires
on a rejection. Either way compaction cannot cut a fixed system prompt, so it
fails — and the failure is invisible for the reason given below.

The step that is *not* verified is the last one, that this is what produces a
`done` run with an empty assistant message and no error frame. That symptom was
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

`loaded_context_length` is the companion field, and it matters more than
`max_context_length` does: LM Studio lets you load a model at less than its
architectural maximum, and it is the loaded value the request is measured
against. It was absent from the probe above only because every model read
`"state": "not-loaded"`. It has since been **verified** by loading one — see
the divergence evidence in the Ollama section below, where a loaded model
reported `max_context_length: 128000` alongside `loaded_context_length: 64000`.

### Ollama is symmetrical with LM Studio after all — verified 2026-09-11

Earlier drafts of this plan built a whole second mechanism on the belief that
`/api/tags` carries no context length, so covering every Ollama model would mean
one `POST /api/show` per model — an N+1 fan-out inside a 2 s budget. That
belief was never verified, because no model was pulled on this machine. It is
**wrong** on Ollama 0.33.2.

Pulled `qwen3:0.6b` and probed a live daemon:

```console
$ curl -s http://localhost:11434/api/tags
{"models":[{"name":"qwen3:0.6b","model":"qwen3:0.6b","size":522653767,
  "details":{"family":"qwen3","parameter_size":"751.63M",
             "quantization_level":"Q4_K_M",
             "context_length":40960,"embedding_length":1024},
  "capabilities":["completion","tools","thinking"]}]}
```

`details.context_length` is right there, per model, in the call
`GET /ollama/models` already makes (`api/system.ts:67`). There is no N+1 and
never was. The two providers have the same shape: one list call carries every
model's window.

For completeness, `POST /api/show` does also carry it, but awkwardly — under
`model_info` behind an architecture-prefixed key, `"qwen3.context_length":
40960`, so a caller would have to find the key *ending* in `.context_length`
rather than read a fixed field. That is a second reason to read `/api/tags`
instead.

**And the `num_ctx` worry has an answer.** Review flagged that Ollama serves
`min(architectural max, num_ctx)`, so a probe reporting the architectural figure
could over-declare. `/api/ps` reports the actually-loaded figure for running
models:

```console
$ ollama ps
NAME          ID            SIZE     PROCESSOR   CONTEXT   UNTIL
qwen3:0.6b    7df6b6e09427  5.6 GB   100% GPU    40960     4 minutes from now
```

The CLI is not the endpoint, and this plan's own Phase 1 standard says field
names must be quoted from live output. So, the JSON — taken after loading the
same model with `options.num_ctx: 8192`, which is also the divergence proof:

```console
$ curl -s http://localhost:11434/api/ps
{"models":[{"name":"qwen3:0.6b", …, "context_length":8192}]}
```

The field is `context_length`, and it reports the loaded 8,192 rather than the
architectural 40,960.

Here the served figure equals the architectural one, but they can diverge when
`num_ctx` is set. That makes the mapping exactly parallel to LM Studio's:

| | all models, architectural | loaded model, actual |
|---|---|---|
| LM Studio | `/api/v0/models` → `max_context_length` | `loaded_context_length` |
| Ollama | `/api/tags` → `details.context_length` | `/api/ps` → `context_length` |

Read the loaded figure when the model is loaded and the architectural one
otherwise, for both providers, by the same rule.

These are the fields these servers actually return, re-checked on 2026-09-11:
Ollama 0.33.2 carries `details.context_length` in `/api/tags`, and LM Studio's
loaded entry carries exactly `max_context_length` and `loaded_context_length`
and no other context field. Review suggested reading Ollama's figure from
`/api/show` instead and LM Studio's from a `load_config.context_length`; neither
matches what these servers return — `/api/tags` does carry it, and `load_config`
is absent from a loaded entry here. Phase 1 still says to re-confirm against the
reader's own versions, because these are observed fields rather than contract
guarantees.

**Both divergences were then reproduced deliberately, and neither is an edge
case.**

On Ollama, one `POST /api/generate` carrying `options.num_ctx: 8192` left
`/api/tags` still reporting `40960` while `/api/ps` reported `8192`. A
tags-only probe would over-declare by 5x on this exact machine.

On LM Studio the divergence needs no user action at all. Loading
`allenai/olmocr-2-7b` with a single chat completion and re-probing returned
`state: "loaded"`, `max_context_length: 128000`, **`loaded_context_length:
64000`** — it defaults to half the architectural maximum. Reading
`max_context_length` would over-declare 2x on a default install. That settles
the field carried as unverified since the first draft.

So "prefer the loaded figure" is load-bearing on both sides, not a refinement.
Note also that Pi never sends `num_ctx` itself — the string appears nowhere in
`pi-ai/dist` — so any divergence is the operator's or the server's, which is
exactly the case an architectural-only probe gets wrong.

### What this removes

The asymmetry was carrying roughly half the design. With it gone, so are:

- the on-demand `GET /ollama/model-context` route,
- the picker hook in `handleSelect` and its `isOllama` gating,
- the `force` flag, and the selection-as-repair gesture it existed for,
- the two different dedup scopes,
- the per-model `modelId` argument to the probe,
- and the two-slice release split, which existed only because Ollama could not
  be verified. It can be, and now has been.

What remains is one mechanism for both providers: each discovery route makes one
extra call and fills every entry for its server. A probe is scoped to
`(providerId, baseUrl)` and takes no model argument.

```
probeLoaded(providerId, baseUrl): Promise<void>   // loaded figures only
probeAll(providerId, baseUrl): Promise<void>      // from cold, for the run path
```

Both return the shared in-flight promise from one dedup map keyed on
`(providerId, baseUrl)`. Phase 2 explains why two entry points rather than
one. The promise **always resolves and
never rejects** — failures leave the cache untouched. Callers do not await it
and need no `.catch()`, because there is nothing to catch.

No `force` flag: every discovery call overwrites unconditionally, so opening the
picker is the repair gesture for **both** providers, and the earlier split
between "LM Studio repaired by opening, Ollama by selecting" is gone with it.

### The restored-chat gap remains, and is now simpler

A restored chat never opens the picker, so nothing fills its cache and every run
uses the fallback. That is true for both providers and is the one reason to
touch the run path at all.

Call it from the `/run` handler in `server/src/api/sessions.ts`, and **not**
where an earlier draft said. That draft said "immediately after `resolveModel`
returns (`:254-255`)", which would have missed the only case this probe exists
for. The resolution is:

```ts
requestedModel = body.model
  ? resolveModel(body.model, getModelRegistry(), body.fusionConfig)
  : session.model ?? resolveModel(undefined, getModelRegistry());
```

A restored chat arrives with `session.model` already populated, so the `??`
short-circuits and `resolveModel` is never called. Anchoring to `resolveModel`
would leave every restored *local* run on the 128,000 fallback forever — exactly
the bug the probe was added to fix.

Anchor on the variable instead, not the call. Put it after the `try`/`catch`
closes — the `catch` block's closing brace is `sessions.ts:272` and
`const runId = mintRunId()` follows at `:274` — where `requestedModel` is
populated on all three branches.
Take the bare id from `requestedModel.id`, which is already the stripped form
the builders received (`models.ts:432`) — do not re-parse the ref. Nothing
awaits it.

That is proven for the `body.model` branch, where `resolveModel` strips the
prefix itself. On the restored branch `resolveModel` is never called, so the id
is whatever Pi persisted. It is bare there too, for a reason worth stating
rather than assuming: local models are never in Pi's registry, so they are
always built by `buildOllamaModel` / `buildOpenAICompatibleModel`, which set
`id` to the bare name. Confirm it holds during implementation instead of
trusting this paragraph — a prefixed id here would key every restored-chat
lookup into a permanent miss.

The base URL needs wiring that does not exist yet. `sessions.ts` imports neither
`OLLAMA_BASE_URL` nor `OPENAI_COMPATIBLE_BASE_URL`; both are module constants in
`config.ts` (`:90`, `:99`). Import them and map provider to base URL at the call
site, passing the same string the builders pass, normalised the same way. An
un-normalised URL produces a key that never matches the one the discovery route
wrote — a permanent cache miss presenting as a silent fallback.

**Gate it on "is a local provider", not on Ollama.** An earlier draft said
`requestedModel.provider === "ollama"`, which left the same hole one provider
over. LM Studio has the identical problem: a restored chat never opens the
picker, so the discovery route never runs, so its entry is never written, and
every run sits on the 128,000 fallback until the user happens to open the
picker. Gate on `provider === "ollama" || provider === "openai-compatible"`. These are
Pi's lowercase provider ids (`models.ts:228`, `:253`), which is the server-side
vocabulary — not the capitalised display labels the picker uses. See the note in
Phase 2 about that trap.

Both probes have the same shape: one list call per server, filling every entry.
Ollama reads `details.context_length` from `/api/tags`; OpenAI-compatible reads
`max_context_length` / `loaded_context_length` from `/api/v0/models`. There is
no per-model argument and no per-model dedup scope on either side.

`resolveModel` itself stays untouched and synchronous; the probe is fired by its
caller, not from inside it. That distinction is the whole reason this design
avoids an async run path, so do not "tidy" it by moving the call into
`resolveModel`.

Four requirements, because "fire and forget" is easy to implement as a leak:

- **Deduplicate by canonical key.** Track in-flight probes in a
  `Map<key, Promise>` keyed on `(providerId, baseUrl)`, so several quick runs or
  picker opens cannot stack duplicate list calls at one local server.
- **Absorb every failure inside the probe. The returned promise
  never rejects.** This is the single contract, and it is worth being exact
  because an earlier draft stated two incompatible ones. A timeout, a dead
  daemon, a 404, a malformed body: all of them resolve to `null`. Nothing
  rejects, so no caller needs a `.catch()`, the route needs no `try`/`catch`,
  and a forgotten promise cannot become an unhandled rejection.

  The alternative — propagate and make each caller handle it — was rejected
  because it puts the burden in three places instead of one, and the route is
  already required never to error on a dead server. Note the hazard is *not*
  promise sharing itself: a `.catch()` attached by one consumer does not swallow
  the rejection for another awaiting the same promise, since it derives a new
  promise rather than mutating the original. The hazard was only the
  ambiguity.
- **Clear the pending entry on settle, success or failure.** Otherwise a single
  failed probe blocks every later retry for the life of the process.
- **Give the probe its own `AbortController` timeout**, matching the 2 s the
  discovery routes already use. Without one, a hanging Ollama leaves an entry in
  the in-flight map forever, and the dedup rule above then blocks every
  subsequent probe for that model — the two requirements combine into a wedge if
  the timeout is missing.

Be honest about what this buys: the *next* run is correct only if the probe has
finished by then. A user who sends two messages quickly gets the fallback twice.
This converges rather than guarantees, and that is enough here — the fallback is
runnable, so the cost of losing the race is one turn of a less accurate window,
not a failure.

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
`GET /openai-compatible/models` (`api/system.ts:97`) already call both servers
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

- **Use one cache key everywhere: `(providerId, normalizedBaseUrl,
  bareModelId)`.** This is the canonical contract and nothing in this plan may
  restate it differently. `normalizedBaseUrl` means trailing slashes stripped,
  matching the `replace(/\/+$/, "")` the builders and routes already apply.

  A correction on the reasoning, because the first draft got it wrong: the base
  URL cannot actually differ between projects. `OLLAMA_BASE_URL` and
  `OPENAI_COMPATIBLE_BASE_URL` are process-global module constants
  (`config.ts:90`, `:99`) with no per-project override anywhere in `src`. So the
  base URL is in the key as cheap insurance against that changing, not because
  two projects can diverge today. The load-bearing part of the key is the
  **bare** id — see the note below.
- **Do not expire entries. Overwrite them.** The first draft gave entries a 60 s
  TTL, and review showed that expiry actively creates the failure this plan
  exists to remove. Nothing refreshes the cache on its own, so an expired entry
  does not become correct — it becomes the 128,000 fallback. For a 256K model
  that is an *under*-declaration, and under-declaring is the silent-compaction
  case. A TTL would therefore mean every large local model quietly drops to
  128,000 a minute after the picker was last opened, and starts compacting
  history it did not need to.

  The asymmetry the fallback argument rests on settles this — *given Phase 0*.
  A stale value that is too high fails loudly and recoverably; a value that is
  too low fails silently. Note that this is only true once `compaction_end` is
  forwarded; without Phase 0 both directions are silent and this argument does
  not hold. Keeping the last probed value is therefore strictly better than
  expiring to a fallback, and it is also simpler. So: entries live until
  something overwrites them.

  What remains, stated plainly, in both directions:

  After a 256K-to-32K swap the cache serves 262,144 until something overwrites
  it, and runs in between fail with the overflow message rather than working.
  That is loud and actionable. What repairs it differs by provider, and the
  difference is not cosmetic — see the repair note below.

  The *opposite* swap is the accepted limitation. If the loaded window grows —
  32,768 to 262,144 — the cache keeps serving 32,768 until something overwrites
  it, and Kady compacts earlier than it needs to. That is silent. It is
  accepted rather than solved because the only clean fix is a refresh on the
  run path, which is the async round trip this whole design avoids, and because
  the cost is degraded efficiency rather than a failed run. Do **not** "fix" it
  with a monotonic max-wins update: that would make the downward swap
  unrepairable, trading a silent inefficiency for a permanent broken state.
  Overwrite in both directions and accept the window between refreshes.
- **Close the reordering window with dedup, not with a generation counter.**
  Out-of-order writes are a real hazard: open the picker twice and the first
  `/api/v0/models` response could return after the second, overwriting fresh
  data with stale. An earlier draft answered this with a monotonic generation
  number per key, stamped at probe start and checked at write.

  That is more machinery than the hazard needs, and review was right to push
  back. The reordering window only exists if two probes for the same scope are
  in flight at once, and the dedup map already forbids that — a second open
  while the first probe is running reuses the in-flight probe rather than
  starting a rival. Close the window at the source instead of reconciling
  writes afterwards.

  One requirement follows: **dedup by `(providerId, baseUrl)`, not by model
  key.** One list call fills every model's entry, so the dedup scope is the
  call, not the row. The Ollama
  probes dedupe at the same scope, because they are also one call per server
  filling every entry. One rule, both providers.
- **Refresh on every write, and one gesture repairs both providers.** Writes
  overwrite, never merge. Opening the picker runs both discovery routes, and
  each fills every entry for its server, so reopening the picker is the repair
  for LM Studio and Ollama alike.

  Earlier drafts split this — LM Studio repaired by opening, Ollama only by
  selecting — because Ollama was believed to need a per-model fan-out it could
  not afford on the picker's path. `/api/tags` carries the value, so that split
  is gone along with the selection gesture it justified.

**The picker's own context badge lags by one open, and that is accepted.**
Review asked whether the displayed `context_length` needs a refresh path after
the unawaited probe lands. It does not, because of what the picker already does
with the field: `model-selector.tsx:250` renders the badge behind
`{model.context_length > 0 && (…)}`, so a zero hides the badge rather than
printing "0".

That makes a cold cache safe. Today every local model reports `0` and shows no
badge. After this change an LM Studio row still carries `0` on the first open,
because its probe has not landed — identical to today, not a regression — and
carries the real figure on the next. Ollama differs, and better: its
architectural figure is parsed inline from the payload the route already holds,
so the badge is right on the *first* open.

What is **not** guaranteed is freshness within a single open. If the cache holds
a figure and the server's context then changes, the row carries the old value
until the unawaited probe lands, so a stale badge can show for one open. That is
the same one-open lag the rest of this design accepts, and it is bounded the
same way — the next open is correct. The guarantee worth stating is narrower
than "never wrong": the badge is never the 128,000 fallback presented as the
model's own number, because the fallback lives in the builders and never reaches
this field.

So no push, no polling, and no refetch-on-probe-settle. Adding any of those
would put a second refresh mechanism into a design whose whole point is that one
gesture — opening the picker — refreshes everything. If the one-open lag ever
becomes worth closing, the cheap fix is for the route to await the probe on a
*cold* cache only, which trades one slow first open for an accurate badge. Not
now: it reintroduces the awaiting-the-probe hazard this plan deliberately
removed.

**The env knob outranks the probe, and is a blunt instrument on purpose.** The
first draft resolved cache first and still called these knobs "overrides",
which they would not have been: both discovery routes fill the cache the moment
the picker opens, so a probed value would have silently beaten anything the
operator configured. Resolve env first. That is what makes the knob an escape
hatch, for the case where the probe answers but answers wrongly.

Note the tension with the argument two paragraphs up, which rejected env-only
*because* the right window differs per model. Both are true. The knob is
per-provider, not per-model, so setting it to correct one model caps every model
on that provider. That is an acceptable escape hatch and an unacceptable primary
mechanism, which is why it is second in precedence and the probe is first.
Document it as a last resort, not as the normal way to configure a window.
Check both `docs/model-selection.md` and `docs/local-models-ollama.md` and put
it where the local-model setup instructions already live, rather than assuming
the former.

**Key the cache on the bare model id, not the provider-prefixed ref.** This is
easy to get backwards. `resolveModel` strips the prefix before it calls either
builder — `buildOllamaModel(r.slice("ollama/".length))` at `models.ts:432`, and
the same for `openai-compatible` at `:441` — so the builders only ever see the
bare id and cannot look up a ref-keyed entry. Every warm entry would miss and
fall back to 128,000, which is exactly the kind of failure that looks like it
works. That is why the canonical key uses the bare id. Each builder already
holds its own provider and base URL as constants, so it can construct the key
from what it has, and no signature changes.

**Prefer `loaded_context_length` over `max_context_length`** when both are
present, per the reasoning above: the loaded value is what the request is
measured against, and it can be lower.

**Raise the fallback to 128,000 — but not before Phase 0.** These ship
together or not at all. Until `compaction_end` is forwarded, a 128,000 fallback
against a real 32,768 server reproduces exactly the empty-run failure this plan
exists to remove, because the rejection is invisible. The fallback is only safe
once the overflow is visible, so treat Phase 0 as a hard dependency rather than
a first step that could be deferred.

Two arguments for the number itself. It matches what the repo
already uses when it has no better information (`models.ts:132`, and `:71`).
And the two failure directions are not symmetric — but only after a
prerequisite fix, and the earlier drafts of this plan were wrong to assume
otherwise.

Pi does produce the right message. On a context-overflow error it compacts,
retries once, and if that fails emits `"Context overflow recovery failed after
one compact-and-retry attempt. Try reducing context or switching to a
larger-context model."` (`pi-coding-agent/dist/core/agent-session.js:1595`).
The problem is what Kady does with it. That message rides on a
`type: "compaction_end"` event, and `toClientFrame`
(`server/src/agent/events.ts:283`) has no `compaction_end` case. It falls to
`default: return null` at `:349` and is dropped. No `compaction_end` handler
exists anywhere. A repo-wide grep for `compaction` returns four hits, none of
them a handler: a comment at `cost/ledger.ts:50`, a comment and a test name in
`web/src/lib/use-agent.ts:95` and `use-agent.test.ts:91`, and tooltip prose in
`web/src/components/context-usage-indicator.tsx:35`. An earlier draft of this
plan said "exactly one hit", which was wrong — that grep had been run against
`web/app`, `web/components` and `web/lib`, none of which exist; the frontend
lives under `web/src`. The conclusion survives the correction, but the evidence
for it was not what the plan claimed.

**Now verified, with one real exception.** An earlier draft flagged as unknown
whether Pi even classifies a local server's rejection as a context overflow.
It does: `pi-ai/dist/utils/overflow.js` carries an explicit pattern list, and
both local servers are named in it — LM Studio's `"tokens to keep from the
initial prompt is greater than the context length"` and Ollama's `"prompt too
long; exceeded max context length by X tokens"`. So the `compaction_end` path
is the right target for Phase 0.

The exception is documented in that same file and matters: *"Ollama: Some
deployments truncate silently, others return errors."* Against a silently
truncating Ollama there is no error to classify and no event to forward, so the
run neither fails loudly nor uses the whole prompt — it answers from a quietly
truncated one. Phase 0 cannot fix that and neither can this plan; it is a
property of the server. It does narrow the asymmetry argument, which holds for
LM Studio and for erroring Ollama builds, and not for silently truncating ones.

Two further qualifications on "loudly", from the same code path. The *first*
overflow triggers a silent compact-and-retry; the message only appears on the
second consecutive failure (`agent-session.js:1593`). And if `prepareCompaction`
returns falsy, no event fires at all. "Loud" here means within about two turns,
not immediately.

So today, over-declaring does **not** fail loudly. It produces a dead run and an
empty assistant bubble, which is the same symptom this plan is chasing. That
matters more than a wording correction, because the asymmetry is what justifies
the 128,000 fallback *and* the decision not to expire cache entries. Both of
those rest on "too high fails loudly, too low fails silently", and that sentence
is currently false in this codebase.

The fix is small and it is now a prerequisite of this plan rather than an aside:
map `compaction_end` carrying an `errorMessage` onto the existing `error` client
frame, the same way the `message_update` error case at `events.ts:313-324`
already turns a provider failure into readable text. Phase 0 below does this
first, so that every later decision rests on something true.

The fallback must clear the prompt floor with reserve headroom. `44409 + 16384`
= 60,793, so 128,000 clears it with room for the conversation itself; 65,536
would clear the arithmetic but leave 4,743 tokens of actual working space
(49,152 effective minus the 44,409 prompt) — enough for a trivial exchange, and
not enough for real work. That is why 65,536 is rejected as a *blind fallback*
while still being the right window for the Phase 4 success case: there it is a
deliberate, measured choice testing one trivial request, not a guess applied to
every unknown server.

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
server/src/agent/events.ts             MODIFIED — forward compaction_end errors (Phase 0)
server/src/agent/local-context.ts      NEW — probe helpers + the canonical-key cache
server/src/agent/models.ts             MODIFIED — builders read the cache, fallback 128K
server/src/api/system.ts               MODIFIED — both discovery routes fill the cache
server/src/config.ts                   MODIFIED — two env override knobs
server/test/local-context.test.ts      NEW — cache, probe parsing, precedence
server/test/openai-compatible.test.ts  MODIFIED — the context_length: 0 assertions
server/test/model-refusal.test.ts      MODIFIED — compaction_end forwarding (Phase 0);
                                       there is no events.test.ts, and this file
                                       already covers toClientFrame error mapping
docs/model-selection.md                MODIFIED — document the knobs (or
docs/local-models-ollama.md            — whichever already covers local setup)
dev-docs/todo.md                       MODIFIED — delete section 5 on completion
```

## Implementation sequence

### Phase 0 — Make the loud failure actually loud

This is a prerequisite, not a nicety. Every later decision in this plan assumes
an over-declared window surfaces an actionable error, and today it does not.

- [ ] Add a `compaction_end` case to `toClientFrame`
      (`server/src/agent/events.ts:283`). When the event carries an
      `errorMessage`, emit `{ type: "error", message: errorMessage }` and
      **omit `reason`**. An earlier draft of this plan said to send
      `reason: "error"`, which was a conflation of two different fields: the
      `reason` on a `message_update` error is Pi's `"error" | "aborted"`
      (`events.ts:314`), while the `compaction_end` event carries its own
      `reason: "overflow"` (`agent-session.js:1598`). Those vocabularies are
      unrelated. Nothing reads the field either: the client dispatches on
      `frame.type` (`use-agent.ts:190`, `:319`, `:578`) and reads exactly one
      other field on an `error` frame, `frame.kind` (`:579`). `frame.reason` is
      never read anywhere. `ClientFrame` (`events.ts:18`) is
      `{ type: string; [k: string]: unknown }`, so nothing requires it either.

      **Omit `kind` as well, and know why.** `use-agent.ts:579` reads
      `frame.kind === "budget" ? "blocked" : "error"`, so leaving it off makes
      an overflow resolve to `"error"` — which is what we want. An overflow is
      not a spend-cap block, and labelling it `budget` would send the user to
      project settings to raise a limit that is not the problem. The omission is
      deliberate, not an oversight.
      Passing the event's own `"overflow"` through would also be defensible;
      inventing `"error"` is not. Do not reuse the `Model error: ` prefix from
      `:321`; this is not a provider failure and Pi's message is already a
      complete sentence. When there is no `errorMessage`, keep returning `null`
      so ordinary successful compaction stays invisible.
- [ ] Confirm the client renders it. The `error` frame is already handled, so
      this should need no frontend change — verify rather than assume.
- [ ] Add a test that a `compaction_end` with an `errorMessage` produces an
      `error` frame, and that one without stays `null`.

**Exit criteria:** a run against a deliberately over-declared window shows the
overflow text instead of an empty assistant bubble.

### Phase 1 — Verify the two probe shapes

- [ ] Load a model in LM Studio and re-probe `/api/v0/models`. Record whether
      `loaded_context_length` appears, and whether it differs from
      `max_context_length` when the model is loaded below its maximum.
- [ ] Both providers are verified, including the loaded-versus-architectural
      divergence on each — see the evidence above. Nothing in Phase 1 is
      blocked. Re-confirm against the reader's own Ollama version before relying
      on it: this was checked on 0.33.2 and the field is absent in older
      releases.
- [ ] Check the model-name round trip before writing any cache code. `/api/tags`
      returns names that usually carry a tag (`llama3:latest`), and the bare id
      `resolveModel` hands the builder comes from the user's ref
      (`models.ts:432`), which may omit it. If `llama3` and `llama3:latest` can
      denote one model, they are two cache keys and every lookup misses. Record
      which form each side uses and normalise in `cacheKey` if they differ.
- [ ] Write both real response fragments into this plan before writing code.

**Exit criteria:** both field names are quoted from live output, not from
documentation or from this plan's guesses.

### Phase 2 — Cache and probe

- [ ] Add `server/src/agent/local-context.ts`: a module-level cache keyed by
      the canonical `(providerId, normalizedBaseUrl, bareModelId)`. No TTL —
      entries live until overwritten, for the reason given above. Note the key
      is the **bare** id, not the provider-prefixed ref — see the note below on
      why.

      Export six things, so the callers do not each invent a shape:
      `cacheKey(providerId, baseUrl, modelId): string`, normalising the base
      URL; `getContextWindow(providerId, baseUrl, modelId): number | undefined`;
      `recordArchitectural(key, value)` and `recordLoaded(key, value |
      undefined)`, the two setters described above — the first writes a positive
      integer and no-ops otherwise, the second clears the loaded slot when
      passed `undefined`; and
      `probeLoaded(providerId, baseUrl)` and `probeAll(providerId, baseUrl)`,
      both `Promise<void>`, sharing one dedup map keyed on
      `(providerId, baseUrl)` and a 2 s timeout. Each returns the shared
      in-flight promise so a second caller joins the first rather than starting
      a rival.

      It resolves to nothing. The probe's product is the cache write, not a
      return value, so there is no `null` result to inspect — callers read the
      cache with `getContextWindow` afterwards. It never rejects either: every
      failure leaves the cache untouched and resolves normally, so no caller
      needs a `.catch()`. (An earlier draft returned `Promise<number | null>`,
      from when a deleted per-model route needed a value to hand back.)
- [ ] Never let a failed probe destroy a good entry. Write only when the parsed
      value is a positive integer; on a 404, a timeout, a malformed body or a
      zero, leave the existing entry alone. A refresh that fails must be a
      no-op, not a downgrade to the fallback.
- [ ] Fill the cache from `GET /openai-compatible/models` with a **second,
      independent** call to `/api/v0/models`, preferring
      `loaded_context_length` where present and writing `max_context_length`
      when it is absent — never skip an entry because it is not loaded. **Do not await it and
      do not share its `AbortController`.** The route answers as soon as
      `/v1/models` returns; the native probe writes to the cache whenever it
      finishes, exactly like the Ollama probes.

      An earlier draft had the two run concurrently under one shared 2 s
      deadline, which was worse in two ways. One shared signal aborts *both*
      fetches, so a slow native probe kills the `/v1/models` call that had
      already succeeded. And even with per-promise `.catch()`, awaiting both
      makes the picker wait the full 2 s for the native probe to time out before
      rendering a list it already had. Not awaiting it removes both problems and
      the reasoning needed to avoid them.

      The cost is that the `context_length` in the row returned by *this* open
      may lag by one open. That field is not what the fix depends on — the
      builders read the cache, not the route's response — and the picker
      degrades safely rather than showing a wrong number. See the note below. `/api/v0/models` is
      LM Studio's own endpoint; vLLM, text-generation-webui and the rest answer
      `/v1/models` and 404 the native one. A 404, a timeout or a malformed body
      means "no context metadata", never "no models" — the route must still
      return every row `/v1/models` gave it. Keep the existing lenient parsing
      style, so a bad or missing length is absent rather than zero.
- [ ] Fill the cache from `GET /ollama/models` by reading
      `details.context_length` out of the `/api/tags` response the route already
      fetches. That costs no extra HTTP call and there is no fan-out — the
      architectural figure is already in the payload the route holds.
- [ ] Then fetch the loaded figures with **one** extra call to `/api/ps`,
      unawaited, with its own `AbortController`, failing into a no-op. They go
      into the entry's separate `loaded` slot — see the two-slot rule below,
      which explicitly forbids merging them into the architectural value.

      Both providers cost two HTTP calls per open; they differ only in which
      call carries which figure. LM Studio: `/v1/models` for the list and
      `/api/v0/models` for both figures. Ollama: `/api/tags` for the list *and*
      the architectural figure, `/api/ps` for the loaded one. An earlier draft
      said "two calls, not one" as though Ollama were the expensive side. It is
      not — it is the cheaper one, because its list call does double duty.

      `/api/ps` returns every running model at once, so this is bounded and not
      a fan-out.

      **The probe needs two entry points, because the picker and the run path
      start from different places.** A single
      `probeContextWindows(providerId, baseUrl)` cannot express "the caller
      already holds the `/api/tags` body" versus "fetch everything from cold",
      and an earlier draft tried to carry that distinction in prose alone.

      - `probeLoaded(providerId, baseUrl)` — the loaded figures only:
        `/api/ps` for Ollama, `/api/v0/models` for LM Studio. This is what a
        discovery route fires after writing what it already had.
      - `probeAll(providerId, baseUrl)` — everything from cold, for the run
        path, where nothing is in hand. Ollama needs `/api/tags` *and*
        `/api/ps`; LM Studio's single `/api/v0/models` carries both, so the two
        entry points do the same work there.

      Both are unawaited, share one dedup map keyed `(providerId, baseUrl)`,
      resolve to nothing and never reject. The Ollama architectural figure on
      the picker path goes through **neither**: it is parsed inline from the
      payload the route already holds, synchronously, before the route replies.
      Re-fetching `/api/tags` to route it through a shared function would buy
      nothing and cost a duplicate call.
- [ ] **Store the two figures in separate slots. Do not overlay them into one
      value.** An earlier draft said to "overwrite the entries reported as
      loaded", which is wrong in a way that goes quietly bad.

      Overlaying loses the architectural figure, and the loaded one is the
      transient of the pair. Load a model with `num_ctx: 8192` and the entry
      becomes 8,192; let it unload and the server serves 40,960 again while the
      cache still says 8,192. That is an under-declaration — the silent
      early-compaction case — produced by the mechanism meant to stop
      over-declaring. It also contradicts the acceptance row promising that an
      empty `/api/ps` leaves the architectural values in place, which cannot
      hold if they were overwritten.

      So each entry holds `{ architectural?: number, loaded?: number }` and
      `getContextWindow` returns `loaded ?? architectural`, recomputed on read
      rather than stored as a merged number. Two setters, because their failure
      modes differ:

      - `recordArchitectural(key, value)` — writes a positive integer, no-ops
        otherwise.
      - `recordLoaded(key, value | undefined)` — `undefined` **clears** the
        loaded slot, which is how an unloaded model reverts to its architectural
        figure.

      One rule that is easy to get backwards: a *successful* loaded-probe must
      clear the loaded slot for every model it did **not** report, because that
      is what unloading looks like. A *failed* loaded-probe must clear nothing.
      Absent-from-a-good-answer and no-answer-at-all are opposite cases, and
      treating them alike either strands stale loaded values or wipes good ones.

      The loaded figure is only readable while the model is resident. Ollama
      unloads after its keep-alive expires, so `/api/ps` is empty most of the
      time and falling back to the architectural slot is the normal path.
- [ ] Fire the probe, unawaited, when a run resolves **either local provider's**
      ref and `getContextWindow` returns `undefined` for it. A restored LM Studio
      chat never opens the picker either, so gate on
      `provider === "ollama" || provider === "openai-compatible"`, not on Ollama
      alone. Nothing on the run path may await it.

      **The cache-miss guard is deliberate, and it does not cover staleness.**
      Skipping when an entry exists is what stops a probe firing on every turn
      of every local chat. The cost is that a *stale* entry is not refreshed
      here: a restored chat whose cached figure is out of date keeps using it
      until the picker is opened. That is the same trade the no-expiry rule
      makes — a stale value that is too high fails loudly and is repaired by one
      picker open, which is why the run path is not the repair mechanism.

      **On the run path, Ollama costs both calls.** Nothing is in hand there, so
      a cold Ollama entry needs `/api/tags` for the architectural figure *and*
      `/api/ps` for the loaded one. Only the picker path gets `/api/tags` for
      free. An implementer who writes `/api/ps` alone here leaves the
      architectural entries missing.
- [ ] Return the real value in each route's `context_length` field instead of
      the hardcoded `0`.

**Exit criteria:** opening the picker populates the cache for **both**
providers, and reopening it after either local server changes overwrites those
entries. `npm run verify -- server` green.

### Phase 3 — Consume it

- [ ] Add `OLLAMA_CONTEXT_WINDOW` and `OPENAI_COMPATIBLE_CONTEXT_WINDOW` to
      `config.ts`, beside the existing `*_BASE_URL` knobs. Trim, and accept only
      a positive finite integer. Blank, non-numeric, zero, negative and
      fractional values are ignored so resolution falls through to the cache and
      then 128,000 — a typo must not become a context window. Test each case;
      note `OPENAI_COMPATIBLE_BASE_URL` already uses `?.trim() ||` at
      `config.ts:100` for the same reason.
- [ ] In both builders, resolve in order: env knob, then cache, then 128,000. The env value wins over a probed one — see the precedence
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
returns 262,144 with a warm cache, 128,000 with a cold one, and the env value
whenever one is set regardless of cache state.

### Phase 4 — Confirm the bug is actually gone

- [ ] Run one trivial request against LM Studio end to end and confirm a
      non-empty assistant message.
- [ ] Confirm compaction does not fire on the first turn — and decide *how you
      will see that* before asserting it. There is no UI signal:
      `compaction_start` is dropped by `toClientFrame` exactly as
      `compaction_end` is, and Phase 0 only forwards the latter, and only when
      it carries an `errorMessage`. Observe it from the Pi session JSONL or a
      temporary log line instead. Do not assert a negative you cannot see.
- [ ] Load the same model in LM Studio at a *reduced* context length without
      reopening the picker. Expect the run to fail with the overflow message
      from Phase 0, not to work and not to silently compact. If the message does
      not appear, Phase 0 is incomplete and the fallback argument is still
      resting on nothing.
- [ ] Then reopen the picker, and be careful about what "repair" means. It
      refreshes the *declared value*; it does not make an impossible prompt fit.
      Pick the reduced window deliberately:
      - Reduce to **65,536**, above the 60,793 floor (44,409 + 16,384). After
        reopening, the run should succeed. This is the repair case.
      - Reduce to something **below** the floor, say 16,384. After reopening,
        the run should still fail, and still fail *visibly*. That is correct
        behaviour, not a regression — the model genuinely cannot hold Kady's
        prompt, which is the scope limit recorded in the goal.
- [ ] Distinguish the two candidate mechanisms before declaring the bug fixed.
      If the loaded server really holds 262,144, the 44,409-token prompt *fits*,
      so there may have been no rejection and no overflow path at all — and the
      empty bubble would instead be the server returning an empty success
      (`stop` or `length`, no error, run `done`). Declaring the window truthfully
      cures that path too, but Phase 0's machinery is irrelevant to it, so a
      green run does not by itself confirm the compaction story. Check the raw
      response shape or the server log and say which one it was.
- [ ] If the empty-message symptom survives, stop and say so. The mechanism in
      this plan is a hypothesis, and a surviving symptom falsifies it rather
      than calling for a bigger number.

**Exit criteria:** the Phase 2 external-client symptom does not reproduce, or is
recorded as unexplained with the compaction hypothesis ruled out.

## Guardrails

- The probe is best-effort. A local server that is down, slow, or returns
  nonsense must fall back silently, exactly as the two routes already do
  today — a dead Ollama must never make a run fail.
- No fan-out inside a discovery route. Each provider costs a bounded number of
  calls per open — Ollama reads `/api/tags` (already fetched) plus one
  `/api/ps`; LM Studio adds one `/api/v0/models`. Never one call per model.
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
| Overflow is visible at all | A `compaction_end` carrying an `errorMessage` reaches the client as an `error` frame, instead of being dropped at `events.ts:349` |
| A stale entry fails loudly and is repairable | Reduce the loaded window in LM Studio; the run fails with the overflow message rather than compacting silently, and reopening the picker fixes it |
| A large model never silently loses its window | Warm the cache at 262,144, wait, and confirm the declared window is still 262,144 rather than having decayed to the fallback |
| A restored LM Studio chat converges too | Restore an `openai-compatible` chat without opening the picker; the run path probes, and the cache holds the probed value once it settles. This is the gap a draft left open by gating the run probe on Ollama alone |
| A restored Ollama chat converges | Restore an Ollama chat and send a message **without opening the picker**, so the discovery and selection probes cannot mask a broken run path. The first run uses 128,000; once the probe settles the cache holds the probed value. Convergence is not per-turn — a second run started before the probe finishes correctly uses the fallback again |
| Every *new* HTTP call goes through a shared probe | Assert `/api/v0/models`, `/api/ps` and both run-path probes go through `probeLoaded`/`probeAll`, not a private `fetch`, and that a second one started while the first is in flight joins it. Ollama's architectural figure on the picker path is exempt — parsed inline from the `/api/tags` payload the route already holds |
| Two picker opens cannot race | Delay one `/api/v0/models` response and open the picker again while it is in flight; the second open reuses the in-flight probe rather than starting a rival, so no reordering is possible |
| The probe never rejects | Point it at a closed port, a 404 and a malformed body in turn; each resolves normally, leaves the cache untouched, and logs no unhandled rejection. The discovery route still returns its model list with `context_length` unchanged, and never a 500 |
| A failed refresh is a no-op | Warm the cache, then make the probe 404; the cached value survives rather than reverting to 128,000 |
| A bad env knob is ignored | Set the knob to `""`, `abc`, `0`, `-1` and `1.5`; each falls through to the cache or 128,000 rather than being declared |
| A slow native probe cannot stall the picker | Stub `/api/v0/models` to hang; `GET /openai-compatible/models` returns as soon as `/v1/models` does, without waiting for the probe or its timeout |
| The native probe still lands afterwards | With the probe merely slow rather than hung, the route returns first; once the probe settles, the cache holds the probed value |
| An unknown small server fails loudly, not silently | Native probe 404s and the real server holds 32,768; the 44,409-token prompt is rejected with the overflow message rather than silently compacted |
| Ollama discovery stays inside its budget | `GET /ollama/models` takes the architectural figure from the `/api/tags` payload it already has, and makes at most one extra unawaited `/api/ps` call for the loaded figures, so its response timing is unchanged with 10+ models present |
| The loaded figure wins over the architectural one | With `allenai/olmocr-2-7b` loaded in LM Studio, the declared window is 64,000 (`loaded_context_length`), not 128,000 (`max_context_length`). With `num_ctx: 8192` set on Ollama, it is 8,192, not 40,960 |
| A cold cache hides the badge rather than faking one | With the cache empty, LM Studio rows carry `0` and render no badge, exactly as today. Ollama rows carry their architectural figure on the *first* open, because it is parsed inline rather than probed |
| A stale badge can appear for one open, and that is accepted | Change the served context, reopen the picker: the row may still show the previous cached figure until the unawaited probe lands, and is correct on the next open. The badge is never the 128,000 fallback dressed as the model's own number, but it is not guaranteed fresh within a single open |
| An empty `/api/ps` is the normal case | Let the keep-alive expire so no model is resident; the architectural slots survive and `getContextWindow` falls back to them |
| An unloaded model reverts, rather than stranding its loaded figure | Load with `num_ctx: 8192`, confirm 8,192 is declared, let it unload, and confirm the next successful loaded-probe clears the loaded slot so 40,960 is declared again — not 8,192 forever |
| A failed loaded-probe clears nothing | Warm both slots, then make `/api/ps` fail; the loaded slot survives, because absent-from-a-good-answer and no-answer are different cases |
| Opening the picker repairs either provider | Change the served context on each server in turn, reopen the picker, and confirm the cached value follows. There is no longer a provider for which opening is the wrong gesture |
| A non-LM-Studio server still lists models | Point `OPENAI_COMPATIBLE_BASE_URL` at a server that 404s `/api/v0/models`; the route returns its full `/v1/models` list |
| The env knob is actually an override | Set `OPENAI_COMPATIBLE_CONTEXT_WINDOW`, warm the cache, confirm the env value is what `resolveModel` returns |
| A warm cache entry is actually found | The builders' bare-id lookup hits an entry written by the discovery route, rather than silently falling back |
| A dead local server is harmless | Probe with nothing listening; run still resolves at the fallback |
| The original symptom is fixed | One local run returns a non-empty assistant message |
| No regression elsewhere | `npm run verify -- server` green, with no drop in the suite's test count — re-count at implementation time rather than trusting a number written here |
