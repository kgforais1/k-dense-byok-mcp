---
title: "Local-model context window: what the servers actually report"
status: proposed
created: 2026-09-12
branch: local-context-window
---

# Local-Model Context Window — Findings

Companion to
[`2026-09-10-local-model-context-window.md`](2026-09-10-local-model-context-window.md).
That file is the plan: what to build, in what order. This file is the
measurement record it rests on — the live server output, the compaction-budget
derivation, and the two divergences that decided the design.

Split out on 2026-09-12 because the combined document reached 1,129 lines. No
content changed in the split. Every claim here was verified on the dates
given; re-confirm against your own server versions before relying on it, as
the plan's Phase 1 instructs.

Re-checked against `main` on 2026-09-18. Four premises had moved since the
first draft; the evidence is in
[Re-verification, 2026-09-18](#re-verification-2026-09-18) at the end, and the
corrections are marked inline where they change a claim above.

## Why this work

`server/src/agent/models.ts:237` and `:261` both hardcode
`contextWindow: 32_768`. The comment at `:247` is honest about the reason — the
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
  `this.settings.compaction?.reserveTokens ?? 16384` (`:560`). **Corrected
  2026-09-18:** an earlier version of this file said Kady sets no `compaction`
  settings anywhere in `server/src`. It does now.
  `server/src/agent/compaction-settings.ts` writes
  `compaction.{enabled,reserveTokens,keepRecentTokens}` into
  `sandbox/.pi/settings.json`, which is where Pi reads them. The default still
  matches Pi's 16,384 (`:22`), but the value is user-tunable per project from
  4,000 to 64,000 (`:27`) through Settings → project
  (`web/src/components/project-switcher.tsx:586`). So the arithmetic below
  holds at the default and is a function of a project setting otherwise —
  record which reserve a measurement was taken at.
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
fails — and the failure is invisible, for the reason the plan gives in its Phase 0 section.

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
the LM Studio divergence evidence below, under "Both divergences were then
reproduced deliberately", where loading `allenai/olmocr-2-7b` reported
`max_context_length: 128000` alongside `loaded_context_length: 64000`. That
evidence sits inside the Ollama-titled section because the two divergences are
presented as a pair; the figures above are LM Studio's.

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
tags-only probe would over-declare by 5x on this exact machine. (**Corrected
2026-09-18:** this section went on to say the Ollama divergence "takes an
operator action rather than arriving by default". It does not — see
[Ollama's loaded/architectural divergence is not operator-induced](#ollamas-loadedarchitectural-divergence-is-not-operator-induced)
below. `num_ctx` widens the gap; it does not create it.)

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

## Re-verification, 2026-09-18

The plan was written against a tree roughly ninety commits behind `main`. Every
premise was re-checked on 2026-09-18; four had moved. This section is the
evidence for the revision recorded at the top of the plan.

### Local models are never in Pi's registry, so no restored session can hold one

The plan's largest mechanism — a run-path `probeAll`, a scope component in the
dedup key, and an asymmetric superset-join rule — existed to serve a restored
chat whose `session.model` holds a local model. That case cannot occur.

`restoredSessionModel` and `latestProjectModel` both resolve through
`runtime.getModel(provider, modelId)` (`server/src/agent/session-registry.ts:486`,
`:472`), which is `getModels(provider).find(m => m.id === id)`
(`pi-ai/dist/models.js:78-80`). Kady creates the runtime with
`allowModelNetwork: false` (`session-registry.ts:97`) and registers both local
providers with `registerProvider` and no model list (`models.ts:303-318`), so
neither provider ever has models to find.

Reproduced with the real `ModelRuntime`, constructed exactly as
`session-registry.ts` does and with `setupModelRuntime`'s two
`registerProvider` calls:

```console
ollama models: []
getModel(ollama, qwen3:0.6b) = undefined
getModel(openai-compatible, qwen/qwen3.8-27b) = undefined
hasConfiguredAuth(ollama) = true
hasConfiguredAuth(openai-compatible) = true
```

So a local model reaches a run only as an explicit `body.model` ref, which goes
through `resolveModel` → `buildOllamaModel` / `buildOpenAICompatibleModel`
(`models.ts:485`, `:490`). Those are the builders this plan changes, and they
read the cache the discovery routes fill. One probe covers everything.

Two consequences beyond deleting the mechanism. Pi defaults a compat-provider
model to `contextWindow: 128000`
(`pi-coding-agent/dist/core/provider-composer.js:72`), which is independent
corroboration of the fallback figure this plan picks. And a session restored
without a client-supplied ref silently switches a local chat to the configured
default model — a separate defect, recorded in the plan under "Adjacent bug
found during verification".

### `toClientFrame` already handles `compaction_end`

The plan said no `compaction_end` handler existed anywhere and the event fell
to `default: return null`. A case was added since, at
`server/src/agent/events.ts:412`, rendering successful compaction as a system
card. Its first line is `if (ev.aborted || !ev.result) return null;`, and every
failure emit sets `result: undefined` alongside `errorMessage`
(`pi-coding-agent/dist/core/agent-session.js:1580`, `:1672`, `:1874`; the field
is declared at `dist/core/agent-session.d.ts:65`). Those are the manual
failure, the overflow-recovery failure, and the auto-compaction `catch`
respectively. The fourth `result: undefined` emit, the abort branch at `:1812`,
carries no `errorMessage` — it sets `aborted: true` instead, which is why the
`aborted` bail has to stay ahead of the new guard. An earlier version of this
section cited `:1812` in place of `:1580`; caught in review 2026-09-18.

That early return, not a missing case, is what swallows the overflow message
today.

`server/src/agent/compaction-bridge.ts:249` also listens to
`session_compact_failed` and logs the same `errorMessage` server-side. Useful
as a cross-check while testing; it never reaches the client.

### LM Studio's model-name round trip is clean

Phase 1's open item, for the LM Studio half. Both endpoints on a live server
(2026-09-18) return byte-identical ids, so the route's list and the probe's
writes share a cache key:

```console
$ curl -s http://localhost:1234/v1/models        # ids only
['qwen/qwen3.8-27b-mlx-6bit-xhigh', 'qwen/qwen3.8-27b-mlx-6bit-medium',
 'qwen/qwen3.8-27b', 'qwen/qwen3.8-27b-mlx-4bit-xhigh',
 'qwen/qwen3.8-27b-mlx-4bit-medium', 'qwen3.8-27b-mlx-new']
keys: ['id', 'object', 'owned_by']

$ curl -s http://localhost:1234/api/v0/models    # same ids, same order
keys: ['arch', 'capabilities', 'compatibility_type', 'id',
       'max_context_length', 'object', 'publisher', 'quantization',
       'state', 'type']
```

### Ollama's model-name round trip needs normalisation

The other half of Phase 1's open item, closed the same day by starting the
daemon (0.33.2) and pulling a model that lands untagged.

`all-minilm` was pulled with no tag. Ollama stored it as `all-minilm:latest`,
and **every** listing endpoint reports only that canonical form:

```console
$ curl -s http://localhost:11434/api/tags     # (name, details.context_length)
[('all-minilm:latest', 512), ('qwen3:0.6b', 40960)]

$ curl -s http://localhost:11434/v1/models    # ids
['all-minilm:latest', 'qwen3:0.6b']

$ curl -s http://localhost:11434/api/ps       # (name, context_length)
[('all-minilm:latest', 256), ('qwen3:0.6b', 8192)]
```

But a *request* accepts either form — Ollama normalises the missing tag:

```console
$ curl -s http://localhost:11434/api/embed -d '{"model":"all-minilm","input":"hi"}'
{"model":"all-minilm","embeddings":[[-0.09047712, …

$ curl -s http://localhost:11434/api/embed -d '{"model":"all-minilm:latest","input":"hi"}'
{"model":"all-minilm:latest","embeddings":[[-0.09047712, …
```

Identical embeddings, so they are one model under two names. That is exactly
the failure the plan feared: the probe always writes `all-minilm:latest`, a
bare `all-minilm` ref looks up `all-minilm`, the run works, and the cache
misses forever on the fallback.

A name with no such model at all is rejected outright, on both APIs — so this
is specifically the missing-tag case, not a general aliasing one:

```console
$ curl -s http://localhost:11434/v1/chat/completions -d '{"model":"qwen3", …}'
{"error":{"message":"model 'qwen3' not found","type":"not_found_error", …}}
```

The picker path is safe by construction: `GET /ollama/models` builds
`id: ollama/${m.name}` straight from `/api/tags` (`server/src/api/system.ts:74`),
so a picker-sourced ref already carries the tag. The exposure is refs from
elsewhere — `DEFAULT_MODEL_ID`, a hand-typed ref, a workspace entry persisted
before a re-pull. The plan's Phase 1 records the normalisation rule and why it
must not be applied to `openai-compatible`.

### Ollama's loaded/architectural divergence is not operator-induced

An earlier version of this file said the Ollama divergence "was *induced* — so
it takes an operator action rather than arriving by default". That is wrong,
and the `all-minilm` probe above shows it: with no options sent at all,
`/api/tags` reports 512 and `/api/ps` reports 256. Reproduced twice on
2026-09-18, the second time deliberately from a cold load after the keep-alive
had expired, because a reviewer could not reach `/api/ps` while nothing was
resident and flagged the figure as unverified:

```console
$ curl -s .../api/embed -d '{"model":"all-minilm","input":"x"}'   # no options
$ curl -s .../api/ps      → [('all-minilm:latest', 256)]
$ curl -s .../api/tags    → [('all-minilm:latest', 512), ('qwen3:0.6b', 40960)]
```

**And the mechanism is the model's own Modelfile**, which review surfaced and
is worth recording because it generalises. `/api/show` reports the pinned
parameter next to the architectural figure:

```console
$ curl -s .../api/show -d '{"name":"all-minilm"}'
parameters:   'num_ctx                        256'
model_info:   {'bert.context_length': 512}

$ curl -s .../api/show -d '{"name":"qwen3:0.6b"}'
parameters:   'repeat_penalty 1 / stop … / temperature 0.6 / top_k 20 / top_p 0.95'
model_info:   {'qwen3.context_length': 40960}
```

`all-minilm` pins `num_ctx 256`; `qwen3:0.6b` pins no `num_ctx` at all, which
is why its two figures agreed until an explicit `options.num_ctx` was sent. So
the divergence is *publisher*-controlled and arrives with the pull. That is
worse than operator-controlled: nobody involved has to do anything wrong to end
up with a declared window twice the real one, and an architectural-only probe
over-declares on any model whose Modelfile pins a smaller `num_ctx`. Ollama picked the smaller
figure itself. Setting `options.num_ctx: 8192` on `qwen3:0.6b` widens the gap
to 40,960 against 8,192 — reproduced again on 2026-09-18 — but the divergence
exists without it. Both servers diverge by default; preferring the loaded
figure is load-bearing on both for the same reason.

### Custom model servers already provide the escape hatch

`docs/custom-model-servers.md` (shipped 2026-09-08, before the first draft of
this plan) lets a user point a custom provider at any OpenAI-compatible
endpoint — LM Studio is named explicitly — and declare a per-model
`contextWindow` from Settings → Model providers. The route already serves that
figure as a real `context_length` (`server/src/agent/custom-models.ts:287`).
That is per-model rather than per-provider, which is the granularity this
plan's own reasoning argues for, so the two env knobs the first draft proposed
are dropped in favour of it.

### Line references that moved

| First draft | Actual, 2026-09-18 |
|---|---|
| `models.ts:233`, `:257` (the 32K hardcodes) | `:237`, `:261` |
| `models.ts:238` (parallel-paths comment) | `:241` |
| `models.ts:243` (the `/v1/models` comment) | `:247` |
| `models.ts:412` (`resolveModel`) | `:466` |
| `models.ts:432`, `:441` (the prefix slices) | `:486`, `:491` |
| `sessions.ts:254-255` (`resolveModel` call) | `:285-287` |
| `sessions.ts:272`, `:274` (`catch` close, `mintRunId`) | `:304`, `:306` |
| `events.ts:283` (`toClientFrame`) | `:385` |
| `events.ts:313-324` (`message_update` error) | `:433-444` |
| `events.ts:349` (`default: return null`) | `:466` |
| `model-selector.tsx:250` (the badge guard) | `:282` |
| `use-agent.ts:579` (`frame.kind`) | `:766` |

`server/test/openai-compatible.test.ts:229` and `:239` still assert
`context_length: 0`, as the first draft said.
