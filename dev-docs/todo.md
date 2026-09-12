# TODO

## Next Up

- [ ] **Address code scanning / security alerts and Dependabot PRs** → [2. Code scanning, security alerts, and Dependabot](#2-code-scanning-security-alerts-and-dependabot)
- [ ] **Finish MCP server work** → [3. Finish MCP server work](#3-finish-mcp-server-work)
- [ ] **Evaluate alternate coding-agent engines** → [4. Alternate coding-agent engines](#4-alternate-coding-agent-engines)
- [ ] **Fix the local-model context window** → [5. Local-model context window is hardcoded to 32K](#5-local-model-context-window-is-hardcoded-to-32k)
- [ ] **Bring the lint and coverage ratchets down** → [1. CI and hooks](#1-ci-and-hooks)
- [ ] **Make this repo read as a fork** → [6. Fork etiquette](#6-fork-etiquette)

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

## 6. Fork etiquette

This repo is a fork of K-Dense-AI/k-dense-byok. The README now opens with a
fork notice saying so, but the rest of the repo still does not — a reader
arriving at `CONTRIBUTING.md`, `SECURITY.md` or `docs/` cannot tell whose work
they are looking at, which is the part that matters — attribution, not
paperwork.

Two badges were wrong outright and are already gone: a Tests badge pointing at
`K-Dense-AI/k-dense-byok/actions/workflows/tests.yml`, which rendered upstream's
CI result on this fork's front page, and a Version badge reading 0.7.3 against
a `server/package.json` on 0.9.12. Repointing the Tests badge at this repo is
still an option once the rest is decided.

The three count shields — Skills 149, Workflows 326, Databases 229 — are now
also gone. **They were removed for the wrong stated reason, and the record
should say so.** The removal commit claimed they were inherited numbers never
verified here. Two of the three were this fork's own correct numbers at the
time of removal: `web/src/data/workflows.json` holds exactly 326 entries and
`web/src/data/databases.json` exactly 229. Only Skills 149 is unverifiable
locally — there is no skills manifest in the repo, and skills come from an
external catalogue defaulting to `K-Dense-AI/scientific-agent-skills`
(`server/src/agent/config.ts:42`), which this fork did not change.

The defensible reason to leave them out is different: nothing regenerates or
checks them, so they drift silently, exactly as the Version badge drifted to
0.7.3 against a 0.9.12 `package.json`. Accuracy today is not the same as
staying accurate.

Note also that removing the badges did not stop the claim. The same three
numbers are still asserted in prose at `README.md:60-62`, `docs/basic-usage.md`
and `docs/codebase-summary.md`. Those are accurate for workflows and databases
and unverified for skills. The skills figure is not even self-consistent:
`README.md:64` and `docs/codebase-summary.md:12` say 149 while
`docs/basic-usage.md:20` says 140+. Skills are fetched from a remote catalogue
(`server/src/agent/skills-fetch.ts`), so any number in prose is a claim about
one revision of a repo we do not control. Either name that revision or drop the
figure; a local JSON count can never settle it the way it settles 326 and 229.

**If adding them back, add a check with them** — a script that counts the JSON
files and a CI assertion, so the badge cannot drift unnoticed. Without that,
leaving them out is the better option.

Five remain, and they are a judgement call rather than a defect: one License
shield and four links to K-Dense's own X, LinkedIn, YouTube and Reddit
accounts. The social four present upstream's channels as this repo's, which the
fork notice at the top of the README now qualifies rather than resolves.

### Decided 2026-09-12: public fork, installable, not promoted

Kevin settled the question these all turned on — this fork is public and
anyone may install it, but it is not being promoted and carries no support
commitment. That made every item below a mechanical fix, now done:

- **Install instructions clone this fork.** `README.md`, `docs/installation.md`.
  Someone following this fork's front page now gets the MCP work.
- **The update check points here.** `server/src/api/system.ts:14`, and the
  "update available" link at `web/src/app/page.tsx:867` now opens this fork's
  releases page. Safe because this fork publishes releases — `v0.9.12`, which
  matches `server/package.json` — so no false prompt. Had there been none, the
  `!resp.ok` branch already degrades to "no update".
- **Launcher failures report here.** `start.mjs:246`, `:417`.
- **Issue routing split by cause.** Fork and MCP problems here, anything that
  reproduces on upstream without this fork's changes goes upstream, and "if you
  cannot tell, open it here" resolves the classification problem. The inherited
  "We read every one" is gone — that was a promise made on K-Dense's behalf.

Still open, deliberately:

- The four social badges and the License shield still show K-Dense's channels.
  Qualified by the fork notice rather than resolved.
- `docs/` beyond `installation.md` and `limitations.md` has no fork notice.
- The Skills 149 count remains unverifiable locally; see the badge note above.

### Issue routing — background to the decision above

Before the decision, `README.md`'s issues section sent every reporter
to upstream's tracker, which was wrong for anything this fork added and rude to
upstream, who would receive bug reports for code they never wrote.

The likely answer is to split by cause: **report MCP and other fork-specific
problems here, everything else upstream.** Do not write that until the
practical questions are settled, because a reporter cannot classify their own
bug:

- Can a non-technical reporter tell an MCP bug from an upstream one? If not,
  the rule needs a fallback — probably "if unsure, open it here and we will
  redirect it".
- Are this fork's issues even enabled, and is anyone watching them? Routing
  people to an unwatched tracker is worse than routing them upstream.
- Does upstream want fork traffic at all? Their README says "We read every
  one", which this fork's README currently inherits verbatim and should not
  claim on their behalf.

Resolved by the decision above; kept because the reasoning still applies if the
routing is revisited.

To check, before calling this done:

- Whether `README.md` and `docs/` state the fork relationship at all, and where
  a short attribution line belongs. **Partly done:** the README now opens with
  a fork notice and the star-history heading names upstream. `docs/` now says
  it for `installation.md` and `limitations.md`; the rest is untouched.
- Whether the skills count asserted in prose (`README.md:60`,
  `docs/basic-usage.md`, `docs/codebase-summary.md`) is accurate, since it is
  the one number that cannot be counted from this repo. The workflows and
  databases figures were verified correct; the badges themselves are gone.
- Whether `LICENSE`, `CONTRIBUTING.md` and `SECURITY.md` still route a reporter
  or contributor to upstream when they should reach this fork, or the reverse.
- Whether any workflow, issue template or link still names the upstream repo.
