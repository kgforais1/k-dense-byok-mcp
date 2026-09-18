# TODO

## Next Up

- [ ] **Finish MCP server work** → [3. Finish MCP server work](#3-finish-mcp-server-work)
- [ ] **Evaluate alternate coding-agent engines** → [4. Alternate coding-agent engines](#4-alternate-coding-agent-engines)
- [ ] **Fix the local-model context window** → [5. Local-model context window is hardcoded to 32K](#5-local-model-context-window-is-hardcoded-to-32k)
- [ ] **Check the restored-session model fallback** → [6. A restored session silently switches away from a local model](#6-a-restored-session-silently-switches-away-from-a-local-model)
- [ ] **Bring the lint and coverage ratchets down** → [1. CI and hooks](#1-ci-and-hooks)

---

## 1. CI and hooks

Baseline in place (PR #8, `.githooks/pre-push`, `tests`/`release`/`harness-update-check` workflows, active `dependabot.yml`). The gates listed here as future work were implemented on branch `ci-hardening` — see the plan, [Repository quality gates](plans/2026-09-08-repo-quality-gates.md), for what each one does and why the rest were rejected.

Done:

- **broken links / docs structure** — `npm run docs:check` now runs in CI (`Checks` workflow). It never did before, and a `git mv` during MCP Phase 2 broke relative links with nothing to catch it.
- **absolute paths / privacy protection** — a `local-home-directory-path` gitleaks rule blocks `/Users/<name>/`-style paths, alongside a full-history secret scan.
- **test coverage** — thresholds on both `server` and `web`, enforced on `ubuntu-latest`.
- **complexity / file line count** — backend ESLint (`server/eslint.config.mjs`), which the backend had entirely lacked.

Still open:

- **Bring the ratchets down.** The complexity, `max-lines` and `max-lines-per-function` limits are set at today's worst offender. The frontend has no size limits at all, because a useful value cannot be set while `file-preview-panel.tsx` is 2238 lines. Full backlog with current numbers is in the plan's [ratchet backlog](plans/2026-09-08-repo-quality-gates.md).
- **Raise the coverage floors**, particularly on the frontend (48.8% statements vs the backend's 72.1%, which now includes `server/pi-packages/**`).
- **Semgrep rules for this repository's own invariants** — not a generic ruleset, which would duplicate CodeQL. Candidates are recorded in the plan.
- **Required status checks before merge.** The branch ruleset gates on CodeQL today; the new `Checks` jobs are not yet in the required set.
- **Pre-commit hook coverage** beyond the fork push guard (`.githooks/`).

## 2. Code scanning, security alerts, and Dependabot

Triage and resolve the security findings GitHub reports on the fork — cleared 2026-09-14: 0 open Dependabot alerts and 0 open CodeQL alerts (was 0 / 195 on 2026-09-13, 41 / 207 on 2026-09-06, ~140 Dependabot on 2026-09-02 — see git history for this file). The branch ruleset (`Rules1`, active on `main`) gates merges on CodeQL `high_or_higher` / errors, so error-level findings can block PRs.

Refreshed 2026-09-13 on `main` at `6ad96d1` (PR #27). Full triage and remediation plan: [CodeQL triage and remediation](plans/completed/2026-09-13-codeql-triage-remediation.md).

Triage snapshot (2026-09-06 — historical; counts refreshed above):

- Dependabot highs to prioritize: `pdfjs-dist` (arbitrary JS via malicious PDF — directly relevant to the PDF preview/annotation surface), `postcss` path-traversal/file-read (web build chain), `sharp`/libvips CVEs, `lodash-es` template injection, `adm-zip` 4GB allocation (notebook export zips via adm-zip), `find-my-way` HTTP2 DDoS (Fastify dep), `flatted` prototype pollution, `ip-address` leading-zero octet decoding (server + web; SSRF/trust-boundary angle given backend outbound fetches), `browserslist` stats crash. The bulk of the count is `mermaid` (9×) and `postcss` (4×) in `web/`.
- CodeQL: 183 of 195 are `js/path-injection`, spread across server-side filesystem path handling — largest single file `server/src/api/sandbox.ts` (49); also annotation sidecars (21), skills install/sync (20/12), agent files (16), Modal store (9), and project/ledger paths — triage true vs false positives before bulk action (the sandbox API legitimately resolves user-supplied paths). Remaining: 7× `js/insecure-randomness`, 2× polynomial ReDoS, 1× resource-exhaustion, 1× incomplete-sanitization, 1× reflected-XSS. Per-alert file/line table measured 2026-09-13 is in the [triage plan](plans/completed/2026-09-13-codeql-triage-remediation.md#what-is-actually-there).

Done 2026-09-12: `pdfjs-dist` (PR #27), bumped 5.7.284 -> 6.3.289. Two things
that upgrade taught us, both worth carrying into the rest of this triage:

- **A major bump can pass a green suite and still be broken.** pdfjs 6 removed
  `PDFDocumentProxy.destroy()`, and every viewer test mocked the library, so
  nothing failed. `web/src/components/pdf-viewer/pdfjs-integration.test.ts` now
  loads the real module against a 592-byte PDF fixture and asserts the API
  facts the viewer depends on. Prefer that shape for any dependency whose
  surface we consume directly.
- **Two gaps remain on the PDF viewer specifically.** Node cannot rasterise a
  canvas or build the DOM text layer, so those are still unverified by CI; they
  were checked by hand in a browser for 6.x. That manual pass is not a one-off
  tick: `BROWSER_VERIFIED_MAJOR` in the integration test pins the major it
  covered, so the next major bump fails a test and asks for the pass to be
  redone before the number moves. Re-run it for a major bump, or for any change
  to `buildWorkerUrl` or the text-layer construction, since those are the parts
  only a browser exercises. A major pin alone is not enough — a 6.x minor can
  change worker loading or the `TextLayer` signature without moving it — so
  `pdfjs-dist` is pinned exactly, and every bump arrives as a PR to review
  rather than floating in on a lockfile refresh.
- **Decide whether to enforce the Node floor.** The manifests now declare
  `>=22.13.0`, but there is no `.npmrc` and `engine-strict` is off, so that is
  advice rather than a gate: npm warns `EBADENGINE` and installs anyway. Adding
  `engine-strict=true` would make it real, at the cost of hard-failing installs
  that work today. Worth deciding deliberately rather than leaving the manifest
  implying an enforcement that does not exist. And `pdfjs.renderTextLayer`, the
  fallback at `web/src/components/pdf-viewer/pdf-viewer.tsx`, no longer exists
  in v6 — it is dead code reached through an `as unknown as` cast, so its
  removal was silent. Worth deleting the fallback, and worth asking what else
  we reach for through a cast.

Ideas:

- Review Dependabot alerts: https://github.com/kgforais1/k-dense-byok-mcp/security/dependabot
- Review code scanning (CodeQL) alerts: https://github.com/kgforais1/k-dense-byok-mcp/security/code-scanning
- Work through Dependabot version-update PRs (npm bumps for `server/` and `web/`). `dependabot.yml` is already active (weekly, grouped; Pi harness pins ignored) — the work is triaging the open alerts, not enabling the config.
- Pin or upgrade transitive deps flagged high/critical first; dismiss-not-fixable ones with a reason
- Rate limiting (PR #7) is scoped to sandbox routes only, so UI polling can no longer be throttled; the frontend 429-handling idea for `apiFetch` is moot unless per-route limits are ever tightened
- Consider exempting `/health` from rate limits if external monitoring ever polls it (currently unthrottled anyway, since the limiter is sandbox-scoped)

## 3. Finish MCP server work

Kady exposes itself as an MCP server so an external coding agent can delegate
research to it. Phases 1 and 2 shipped, and Phase 3 is partly done. Background
and the CLI-vs-MCP rationale are in
[kady-architecture-and-integration-notes.md](kady-architecture-and-integration-notes.md)
§§ 9–11 and §13 (recommendations 7–8).

Decided and built, so no longer open questions:

- Transport is Streamable HTTP on the existing backend listener, not stdio.
  Scoping is the `X-Project-Id` header the REST API already uses, and the
  endpoint refuses to start on a non-loopback host because it has no auth.
- The tools call the same functions the REST routes call. The adapter
  translates and never reimplements.
- Seven tools, documented in [Kady as an MCP server](../docs/kady-as-mcp-server.md):
  the five-tool research loop plus `list_research_sessions` and
  `delete_research_session`. The rest of the §10 surface is expand-as-needed.

Still open, tracked in the
[Phase 3 plan](plans/2026-09-06-mcp-server-phase-3-harden.md):

- Validate the setup doc with a fresh-client walkthrough. The doc is written
  from the code rather than from a run, and no transcript backs the
  "installable by a third party" claim.
- Record the CLI entry point — which adapter modules a future CLI reuses — so
  the deferred CLI does not redesign the tool core.

## 4. Alternate coding-agent engines

These are exploratory integrations, not API-key replacements already supported by
Kady's Pi OAuth providers. Any adapter must retain Kady's local-only boundary,
project scoping, cancellation, tool policy, and accounting.

- **OpenCode:** Medium feasibility. Checked 2026-09-07 against
  [`anomalyco/opencode@ecbc6cc`](https://github.com/anomalyco/opencode/tree/ecbc6ccac85b3e8087b6445e584318419b9e2b34)
  and its [server documentation](https://opencode.ai/docs/server): loopback
  `opencode serve` exposes an OpenAPI server with sessions and events. It is a
  second agent runtime, so an adapter must reconcile tools, state, credentials,
  and costs with Kady rather than treating it as a drop-in model provider.
- **Antigravity / agy:** Medium-low feasibility. The evaluation target is the
  currently active fork
  [`kgrizz-git/agy-acp@743ee45`](https://github.com/kgrizz-git/agy-acp/tree/743ee4534bb77d3bcdd88ce5526e1e9ed343dd10),
  checked 2026-09-07 and observed pushed that day; it is a fork of
  [`hicder/agy-acp@858041c`](https://github.com/hicder/agy-acp/tree/858041c957e79d8308412d1b71a8dded27c11f22).
  This records no maintenance commitment. Native agy ACP support is unverified;
  the candidate is an ACP adapter, so Kady would still need a durable
  session/event/cancel adapter and explicit ownership of credentials and
  sandbox policy.
- **Kiro:** Medium feasibility. Checked 2026-09-07 against Kiro's
  [ACP documentation](https://kiro.dev/docs/cli/acp/) (whose protocol example
  identifies `kiro-cli` 1.5.0) and [CLI overview](https://kiro.dev/docs/):
  `kiro-cli acp` is a documented stdio JSON-RPC ACP server, while the CLI also
  supports headless execution, sessions, and CI. It remains a separate agent
  engine with its own authentication, tool permissions, and lifecycle—not a
  direct Pi model-provider entry.

## 5. Local-model context window is hardcoded to 32K

`buildOllamaModel` and `buildOpenAICompatibleModel` (`server/src/agent/models.ts:237`, `:261`) both hardcode `contextWindow: 32_768`. The comment explains the choice honestly — the OpenAI-compatible `/v1/models` endpoint carries no context length — but the default is now wrong in a way that breaks the local path outright.

Measured on 2026-09-08 while running the MCP Phase 2 external-client check against LM Studio:

- Kady's own prompt for one trivial request was **44,409 tokens** (system prompt + seeded `AGENTS.md` + the full tool surface). That is already **above** the declared 32,768 window, so no local model can run Kady within its declared budget — the floor exceeds the ceiling.
- The model actually loaded (`qwen/qwen3.8-27b`) reports `max_context_length: 262144`, loaded at the full 262,144. The declared value is 8× too low.
- Observed effect: the model returned an empty assistant message and the run still completed as `done`, with no error frame and nothing logged. See the Phase 3 follow-up in the [Phase 2 plan](plans/completed/2026-09-06-mcp-server-phase-2-server.md).

It does not need to be this low, and the value is discoverable rather than merely configurable. The approach is settled in the plan linked below: probe the local server from the two discovery routes, cache the result, and fall back to 128,000 when nothing answers. `resolveModel` stays synchronous. The two builders are deliberately parallel rather than sharing a base (see the comment at `models.ts:241`), so a fix touches both.

Planned in [Local-model context window: probe it instead of guessing 32K](plans/2026-09-10-local-model-context-window.md), revised 2026-09-18 after re-verifying every premise against `main`. Four things that revision settled, because they change what the entry above implies:

- **The effective budget is the declared window minus `reserveTokens`**, which is 16,384 by default, so the prompt is 2.7x over rather than 1.35x. That reserve is now Kady's own per-project setting (`server/src/agent/compaction-settings.ts`, tunable 4,000–64,000), not Pi's fixed default, so the arithmetic moves with it.
- **The compaction hypothesis for the empty assistant message was falsified.** Phase 4 ran the feature against live servers on 2026-09-18 and compaction never fired, even with `reserveTokens` maxed. The symptom itself belongs to a different defect on a different surface, already fixed by `e2022ea` (2026-09-09), which told MCP clients when a finished run produced nothing. The context window was a real defect on its own terms; the two were never causally linked.
- **The value really is discoverable, and Phase 1 is now complete.** LM Studio's `/api/v0/models` reports `max_context_length` (and `loaded_context_length`, which can be half of it on a default install); Ollama's `/api/tags` reports `details.context_length` and `/api/ps` the loaded figure. Both verified against live servers. The last open item — the Ollama model-name round trip — closed on 2026-09-18: Ollama accepts an untagged `all-minilm` but every listing endpoint reports `all-minilm:latest`, so `cacheKey` must append `:latest` to an untagged Ollama id. That normalisation is Ollama-only; applying it to LM Studio would break every key.
- **A restored chat cannot hold a local model at all.** `runtime.getModel` returns `undefined` for both local providers, so `session.model` falls through to the configured default. That deleted the plan's run-path probe and half its dedup machinery — and it exposed a separate defect, below.

## 6. A restored session silently switches away from a local model

`restoredSessionModel` and `latestProjectModel` (`server/src/agent/session-registry.ts:486`, `:472`) resolve through `runtime.getModel(provider, modelId)`. Local models are never in Pi's registry — Kady creates the runtime with `allowModelNetwork: false` and registers `ollama` / `openai-compatible` as providers with no model list — so that lookup returns `undefined` and the session falls back to `defaultModel`, normally an OpenRouter model.

Verified 2026-09-18 by constructing the real `ModelRuntime` the way `session-registry.ts` does: `getModels("ollama")` is `[]` and `getModel("ollama", "qwen3:0.6b")` is `undefined`.

The web client persists `selectedModel` per tab and sends it on every run (`web/src/lib/workspace-persistence.ts:59`, `use-agent.ts:531`), so the UI path is unaffected — `body.model` wins before the fallback is reached. A run that omits `model` is not: a headless or MCP-initiated continuation of a local chat quietly bills a cloud provider instead. Worth confirming against the MCP server path before deciding how much this matters.

Found while revising the plan in section 5. Deliberately not folded into it — it is a different defect in a different file, and that plan is narrow on purpose.
