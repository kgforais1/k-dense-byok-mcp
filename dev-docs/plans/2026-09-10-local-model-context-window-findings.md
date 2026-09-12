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
