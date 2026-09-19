# Local models (Ollama and OpenAI-compatible servers)

> **Fork note:** this is the [kgforais1/k-dense-byok-mcp](https://github.com/kgforais1/k-dense-byok-mcp) fork of [K-Dense-AI/k-dense-byok](https://github.com/K-Dense-AI/k-dense-byok).

You can run Kady entirely against local models - no OpenRouter key required for those models. This is useful if you want to keep everything on your machine or experiment without spending on API calls.

Two kinds of local server are supported, and they appear as separate sections in the model picker:

| Server | Section | Model refs |
|---|---|---|
| [Ollama](https://ollama.com) | **Local (Ollama)** | `ollama/<name>` |
| Anything speaking the OpenAI API — LM Studio, vLLM, text-generation-webui, `llama.cpp` server | **Local (OpenAI-compatible)** | `openai-compatible/<model-id>` |

## Ollama setup

1. **Install Ollama and start the daemon:**

   ```bash
   # macOS / Linux
   curl -fsSL https://ollama.com/install.sh | sh
   ollama serve
   ```

   On Windows, download and run the installer from [ollama.com/download](https://ollama.com/download) — it starts the daemon for you.

2. **Pull one or more models:**

   ```bash
   ollama pull qwen3.6
   ollama pull qwen2.5-coder:7b
   ```

3. **(Optional) Custom Ollama host.** If your Ollama server lives somewhere other than `http://localhost:11434`, set `OLLAMA_BASE_URL` in the repo-root `.env`.

4. **Pick the model in the app.** Open the model dropdown in the chat input. Pulled models appear under the **Local (Ollama)** section at the bottom. Picking one routes Kady - and any subagents it spawns - through your local daemon.

The list is populated live from Ollama's `GET /api/tags` endpoint (via the backend's `/ollama/models` route), so pulling a new model and re-opening the dropdown is enough - no app restart needed.

To make a local model the default for every new chat, set in `.env`:

```bash
DEFAULT_MODEL_PROVIDER="ollama"
DEFAULT_MODEL_ID="llama3"   # any model you've pulled
```

## OpenAI-compatible server setup (LM Studio, vLLM, …)

Any local server exposing the standard `GET /v1/models` and `POST /v1/chat/completions` endpoints works. Unlike the Ollama section, this one is hidden until you ask for it:

1. **Start your server and load a model.** In LM Studio that's the *Developer* tab → *Start Server*; with vLLM it's `vllm serve <model>`.

2. **Point Kady at it** in the repo-root `.env`:

   ```bash
   OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234   # LM Studio's default port
   ```

   The default is LM Studio's port, so if that's what you run, setting the variable to any value switches the section on. **vLLM defaults to port 8000, which is Kady's backend port** — move one of the two, e.g. `vllm serve <model> --port 1234`.

3. **Pick the model in the app.** Loaded models appear under **Local (OpenAI-compatible)**. The list comes from your server's `/v1/models` (via the backend's `/openai-compatible/models` route), so loading a different model and re-opening the dropdown is enough — no app restart.

To make one the default for every new chat:

```bash
DEFAULT_MODEL_PROVIDER="openai-compatible"
DEFAULT_MODEL_ID="qwen/qwen3-8b"   # exactly as your server reports it
```

Notes:

- **One server at a time.** There is a single base URL, as with Ollama. If you run both LM Studio and Ollama, both sections appear — but not two OpenAI-compatible servers.
- **Local servers only.** These models are treated as free and are never counted against a project spend cap. Pointing the base URL at a paid hosted gateway would leave that spend untracked and uncapped. For hosted gateways that mirror OpenRouter's model ids, use `OPENROUTER_BASE_URL` instead — those keep catalogue pricing and stay inside the cap.
- **Only the model id is read** from `/v1/models`. Servers disagree on every other field, so pricing is $0 (as with Ollama) and thinking levels are disabled. The context length is discovered separately — see below.

## Context length

Kady asks your server what the model's context window actually is, rather than
assuming one. The standard `/v1/models` endpoint carries no context length, so
each server's own API is read when the model picker opens:

| Server | Architectural maximum | Currently loaded |
|---|---|---|
| Ollama | `/api/tags` → `details.context_length` | `/api/ps` → `context_length` |
| LM Studio | `/api/v0/models` → `max_context_length` | `loaded_context_length` |

Those field names were last confirmed on 2026-09-19 against Ollama 0.33.2 and
LM Studio 0.4.23+1 (`cat ~/.lmstudio/.internal/app-version`). Ollama does not
document `details.context_length`, so that one in particular is worth
re-checking after an upgrade; if it disappears, an unloaded model falls back to
the figure below rather than breaking.

The **loaded** figure wins when both are known, because that is what your
request is measured against and it is often smaller than the maximum. Both
servers do this by default: LM Studio loads a model at half its maximum on a
default install, and an Ollama model whose Modelfile pins `num_ctx` (Ollama's
own `all-minilm` pins 256 against an architectural 512) serves the smaller
number without anyone configuring anything.

Practical consequences:

- **Opening the model picker is what refreshes this.** If you load a model at
  a different context length, reopen the picker so Kady sees the new figure.
  Until then it uses the previous one.
- **The first open shows the maximum; the loaded figure arrives on the
  second.** Ollama's list call already carries the architectural maximum, so
  its rows get a badge immediately, while LM Studio's figures live on a second
  endpoint read in the background and its rows show no badge at all until
  then. Either way the *loaded* figure — the one your request is measured
  against — lands only after that background read, so if a model is loaded
  smaller than its maximum, the first open overstates it. Reopening the picker
  settles it.
- **If nothing answers, Kady assumes 128,000.** That is a deliberate floor
  rather than a guess at your hardware: Kady's own system prompt is roughly
  44,000 tokens and the compaction reserve adds about 16,000 on top, so a
  smaller assumption cannot fit the prompt before you have typed anything.
- **A genuinely small model will say so, if your server says so.** A model
  whose real window is below roughly 61,000 tokens cannot hold Kady's prompt.
  On a server that rejects an oversized request — LM Studio and other
  llama.cpp servers do — the run fails with a context-overflow message naming
  the numbers, instead of returning an empty reply. Ollama instead truncates
  the prompt silently, so there the model simply answers without the part that
  did not fit. Declaring the real window is what avoids the oversized request
  in the first place; the visible error is the backstop, and only some servers
  offer it.
- **To override a figure**, add the server as a custom model server
  (Settings → **Model providers** → **Custom model servers**) and declare
  `contextWindow` per model. See [Custom model servers](./custom-model-servers.md).
  That is per-model, so it is the right tool when one model's reported figure
  is wrong.

## Caveats

Local models are fully supported, but skill-heavy work leans on model quality (see [Known limitations](./limitations.md)):

- **Tool-calling fidelity is noticeably weaker** on sub-frontier models.
- **Skills that rely on multi-tool choreography** (running scripts, chaining file edits, producing structured output) are the most fragile.

If a task loops or ignores its skill, try a **larger local model** (or temporarily switch back to an OpenRouter-hosted model) before assuming the workflow is broken.

## Want pricing and metadata for a hosted or shared server?

Ollama and the OpenAI-compatible section are billed at $0 and are meant for
local servers. For an institutional vLLM gateway or any endpoint whose usage
should count toward the spend cap, add it as a
[custom model server](./custom-model-servers.md) instead.
