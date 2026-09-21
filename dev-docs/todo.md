# TODO

## Next Up

- [ ] **Finish MCP server work** → [3. Finish MCP server work](#3-finish-mcp-server-work)
- [ ] **Evaluate alternate coding-agent engines** → [4. Alternate coding-agent engines](#4-alternate-coding-agent-engines)
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

- **Bring the remaining ratchets down.** `max-lines` now lowers itself
  (`server/.ratchets.json`, `npm run ratchet:sync`, floor 750), but
  `complexity` and `max-lines-per-function` still sit at today's worst
  offender and still move only by hand. Both need ESLint's AST analysis
  rather than a line count, which is why they were left out. The frontend has
  no size limits at all, because a useful value cannot be set while
  `file-preview-panel.tsx` is 2238 lines — a candidate for the same
  self-lowering treatment once it comes down. Full backlog with current
  numbers is in the plan's [ratchet
  backlog](plans/2026-09-08-repo-quality-gates.md).
- **Raise the coverage floors**, particularly on the frontend (48.8% statements vs the backend's 72.1%, which now includes `server/pi-packages/**`).
- **Semgrep rules for this repository's own invariants** — not a generic ruleset, which would duplicate CodeQL. Candidates are recorded in the plan.
- **Required status checks before merge.** The branch ruleset gates on CodeQL today; the new `Checks` jobs are not yet in the required set.

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

Done 2026-09-20: the setup doc is validated. A client working only from
`docs/kady-as-mcp-server.md` drove the whole seven-tool surface over
Streamable HTTP, including a completed run, and the loopback guard was
confirmed to refuse both `0.0.0.0` and `localhost`. Three documentation
defects came out of it and are fixed; the server itself needed no change. The
transcript is the [walkthrough
record](plans/2026-09-06-mcp-server-phase-3-harden.md#walkthrough-record-2026-09-20).

Still open, tracked in the
[Phase 3 plan](plans/2026-09-06-mcp-server-phase-3-harden.md):

- Record the CLI entry point — which adapter modules a future CLI reuses — so
  the deferred CLI does not redesign the tool core. This is the last item
  before the plan can be archived.

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

## 5. Ollama's architectural context figure is undocumented

`/api/tags` → `details.context_length` is what PR #35 reads for a model's
architectural maximum, and Ollama does not document it. The documented
`details` fields are `format`, `family`, `families`, `parameter_size` and
`quantization_level`. Ollama 0.33.2 does emit it. `/api/ps` → `context_length`,
the loaded figure, *is* documented.

Losing it degrades rather than breaks: a loaded model still reports correctly
through `/api/ps`, and only an unloaded one falls through to the 128,000 floor
— the over-declaring direction, but bounded and already accepted.

**Decided 2026-09-20:** keep `/api/tags` as the primary source and fall back to
`/api/show` — which does document a model's parameters — only for rows whose
`details.context_length` is missing. The two alternatives were both worse.
Switching to `/api/show` outright costs a call per model against today's budget
of two per picker open, which `test/ollama.test.ts` has a test guarding
("stays within two calls per open"); doing nothing leaves the figure resting on
an undocumented field. The fallback costs nothing while Ollama still emits it,
and pays only in the failure this item is about. Keep the per-open budget
assertion, and extend it to allow the extra calls only on the fallback path.

Not worth doing: tracing how far back the undocumented field goes. Old Ollama
builds are not a supported target, and the degradation is benign.

The practical guard is re-checking the field after an Ollama upgrade. The
version this was confirmed against is recorded in
[the findings note](plans/completed/2026-09-10-local-model-context-window-findings.md)
and in [the user docs](../docs/local-models-ollama.md).
