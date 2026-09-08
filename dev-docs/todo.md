# TODO

## Next Up

- [ ] **Address code scanning / security alerts and Dependabot PRs** → [2. Code scanning, security alerts, and Dependabot](#2-code-scanning-security-alerts-and-dependabot)
- [ ] **Start MCP server work** → [3. Start MCP server work](#3-start-mcp-server-work)
- [ ] **Evaluate alternate coding-agent engines** → [4. Alternate coding-agent engines](#4-alternate-coding-agent-engines)
- [ ] **Fix the local-model context window** → [5. Local-model context window is hardcoded to 32K](#5-local-model-context-window-is-hardcoded-to-32k)
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

Triage and resolve the security findings GitHub reports on the fork — currently 41 open Dependabot alerts (11 high, 25 moderate, 5 low as of 2026-09-06; down from ~140 in the 2026-09-02 snapshot — see git history for this file) plus 207 open CodeQL code-scanning alerts (196 error, 11 warning — dominated by 195× `js/path-injection`). The branch ruleset (`Rules1`, active on `main`) gates merges on CodeQL `high_or_higher` / errors, so error-level findings can block PRs.

Triage snapshot (2026-09-06 — refresh from the GitHub security tabs when working this item):

- Dependabot highs to prioritize: `pdfjs-dist` (arbitrary JS via malicious PDF — directly relevant to the PDF preview/annotation surface), `postcss` path-traversal/file-read (web build chain), `sharp`/libvips CVEs, `lodash-es` template injection, `adm-zip` 4GB allocation (notebook export zips via adm-zip), `find-my-way` HTTP2 DDoS (Fastify dep), `flatted` prototype pollution, `ip-address` leading-zero octet decoding (server + web; SSRF/trust-boundary angle given backend outbound fetches), `browserslist` stats crash. The bulk of the count is `mermaid` (9×) and `postcss` (4×) in `web/`.
- CodeQL: 195 of 207 are `js/path-injection`, spread across server-side filesystem path handling — largest single file `server/src/api/sandbox.ts` (49); also annotation sidecars, skills install/sync, agent files, Modal store, and project/ledger paths — triage true vs false positives before bulk action (the sandbox API legitimately resolves user-supplied paths). Remaining: 7× `js/insecure-randomness`, 2× polynomial ReDoS, 1× resource-exhaustion, 1× incomplete-sanitization, 1× reflected-XSS.

Ideas:

- Review Dependabot alerts: https://github.com/kgforais1/k-dense-byok-mcp/security/dependabot
- Review code scanning (CodeQL) alerts: https://github.com/kgforais1/k-dense-byok-mcp/security/code-scanning
- Work through Dependabot version-update PRs (npm bumps for `server/` and `web/`). `dependabot.yml` is already active (weekly, grouped; Pi harness pins ignored) — the work is triaging the open alerts, not enabling the config.
- Pin or upgrade transitive deps flagged high/critical first; dismiss-not-fixable ones with a reason
- Rate limiting (PR #7) is scoped to sandbox routes only, so UI polling can no longer be throttled; the frontend 429-handling idea for `apiFetch` is moot unless per-route limits are ever tightened
- Consider exempting `/health` from rate limits if external monitoring ever polls it (currently unthrottled anyway, since the limiter is sandbox-scoped)

## 3. Start MCP server work

Expose K-Dense/Kady itself as an MCP server so an external coding agent can delegate research to it. Today Kady is only an MCP *client* (consumes external tools); the inverse — another agent driving Kady over MCP — is not a documented feature. Background, candidate tool surface (`kdense_research`, `kdense_delegate_specialist`, …), and the CLI-vs-MCP rationale are in [kady-architecture-and-integration-notes.md](kady-architecture-and-integration-notes.md) §§ 9–11 and §13 (recommendations 7–8).

Ideas:

- Master plan (Proposed): [2026-09-06 MCP server](plans/2026-09-06-mcp-server.md) with phase plans — MCP first, CLI deferred, per the notes' recommendations 7–8.
- Decide transport and scope: stdio vs HTTP, project scoping (`X-Project-Id`), auth for a local server.
- Adapt the existing project/session/run/file/sandbox HTTP APIs as the tool backend rather than building from scratch.
- Start with a minimal tool subset (e.g. list projects, research prompt, get result) before the full §10 surface.

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

`buildOllamaModel` and `buildOpenAICompatibleModel` (`server/src/agent/models.ts:223`, `:246`) both hardcode `contextWindow: 32_768`. The comment explains the choice honestly — the OpenAI-compatible `/v1/models` endpoint carries no context length — but the default is now wrong in a way that breaks the local path outright.

Measured on 2026-09-08 while running the MCP Phase 2 external-client check against LM Studio:

- Kady's own prompt for one trivial request was **44,409 tokens** (system prompt + seeded `AGENTS.md` + the full tool surface). That is already **above** the declared 32,768 window, so no local model can run Kady within its declared budget — the floor exceeds the ceiling.
- The model actually loaded (`qwen/qwen3.8-27b`) reports `max_context_length: 262144`, loaded at the full 262,144. The declared value is 8× too low.
- Observed effect: the model returned an empty assistant message and the run still completed as `done`, with no error frame and nothing logged. See the Phase 3 follow-up in the [Phase 2 plan](plans/completed/2026-09-06-mcp-server-phase-2-server.md).

It does not need to be this low, and the value is discoverable rather than merely configurable:

- **Cheap fix:** `OPENAI_COMPATIBLE_CONTEXT_WINDOW` / `OLLAMA_CONTEXT_WINDOW` env knobs beside the existing `*_BASE_URL` ones in `config.ts`, defaulting to today's 32K.
- **Better fix:** probe the server. LM Studio's native `GET /api/v0/models` returns `max_context_length` and `loaded_context_length` per model; Ollama's `POST /api/show` returns the equivalent. Probe on model resolution, fall back to the env knob, then to 32K.
- Whichever lands, raise the fallback: 32K is below Kady's own prompt floor.

Note the two builders are deliberately parallel rather than sharing a base (see the comment at `models.ts:238`), so a fix touches both.
