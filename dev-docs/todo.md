# TODO

## Next Up

- [ ] **Address code scanning / security alerts and Dependabot PRs** → [2. Code scanning, security alerts, and Dependabot](#2-code-scanning-security-alerts-and-dependabot)
- [ ] **Start MCP server work** → [3. Start MCP server work](#3-start-mcp-server-work)

---

## 1. CI and hooks (optional future enhancements)

CI and hooks are set up (hardened in PR #8; `.githooks/pre-push` fork guard; `tests` / `release` / `harness-update-check` workflows; active `dependabot.yml`). What remains is enhancement-track only — pick up if/when it pays for itself, not as blocking setup work:
- pre-commit / pre-push hook coverage beyond the fork push guard (`.githooks/`)
- status checks required before merge
- test coverage
- complexity
- file line count
- broken links
- absolute paths
- privacy protection

## 2. Code scanning, security alerts, and Dependabot

Triage and resolve the security findings GitHub reports on the fork — currently 41 open Dependabot alerts (11 high, 25 moderate, 5 low as of 2026-09-06; down from ~140 on 2026-09-02) plus 207 open CodeQL code-scanning alerts (196 error, 11 warning — dominated by 195× `js/path-injection`). The branch ruleset (`Rules1`, active on `main`) gates merges on CodeQL `high_or_higher` / errors, so error-level findings can block PRs.

Triage snapshot (2026-09-06):

- Dependabot highs to prioritize: `pdfjs-dist` (arbitrary JS via malicious PDF — directly relevant to the PDF preview/annotation surface), `postcss` path-traversal/file-read (web build chain), `sharp`/libvips CVEs, `lodash-es` template injection, `adm-zip` 4GB allocation (notebook export zips via adm-zip), `find-my-way` HTTP2 DDoS (Fastify dep), `flatted` prototype pollution. The bulk of the count is `mermaid` (9×) and `postcss` (4×) in `web/`.
- CodeQL: 195 of 207 are `js/path-injection`, likely concentrated on the sandbox file-serving routes, which legitimately resolve user-supplied paths — triage true vs false positives before bulk action. Remaining: 7× `js/insecure-randomness`, 2× polynomial ReDoS, 1× resource-exhaustion, 1× incomplete-sanitization, 1× reflected-XSS.

Ideas:

- Review Dependabot alerts: https://github.com/kgforais1/k-dense-byok-mcp/security/dependabot
- Review code scanning (CodeQL) alerts: https://github.com/kgforais1/k-dense-byok-mcp/security/code-scanning
- Work through Dependabot version-update PRs (npm bumps for `server/` and `web/`). `dependabot.yml` is already active (weekly, grouped; Pi harness pins ignored) — the work is triaging the open alerts, not enabling the config.
- Pin or upgrade transitive deps flagged high/critical first; dismiss-not-fixable ones with a reason
- Rate limiting (PR #7) is scoped to sandbox routes only, so UI polling can no longer be throttled; the frontend 429-handling idea for `apiFetch` is moot unless per-route limits are ever tightened
- Consider exempting `/health` from rate limits if external monitoring ever polls it (currently unthrottled anyway, since the limiter is sandbox-scoped)

## 3. Start MCP server work

Expose K-Dense/Kady itself as an MCP server so an external coding agent can delegate research to it. Today Kady is only an MCP *client* (consumes external tools); the inverse — another agent driving Kady over MCP — is not a documented feature. Background, candidate tool surface (`kdense_research`, `kdense_delegate_specialist`, …), and the CLI-vs-MCP rationale are in [kady-architecture-and-integration-notes.md](kady-architecture-and-integration-notes.md) §§ 9–11.

Ideas:

- Master plan (Proposed): [2026-09-06 MCP server](plans/2026-09-06-mcp-server.md) with phase plans — MCP first, CLI deferred, per the notes' recommendations 7–8.
- Decide transport and scope: stdio vs HTTP, project scoping (`X-Project-Id`), auth for a local server.
- Adapt the existing project/session/run/file/sandbox HTTP APIs as the tool backend rather than building from scratch.
- Start with a minimal tool subset (e.g. list projects, research prompt, get result) before the full §10 surface.
