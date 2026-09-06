# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.**

Use **GitHub Security Advisories — Private vulnerability reporting** for this
fork, which creates a private, encrypted channel with the maintainers and
avoids disclosing the issue before a fix is ready:

1. Open the **Security** tab of `kgforais1/k-dense-byok-mcp` on GitHub
   (`https://github.com/kgforais1/k-dense-byok-mcp/security/advisories/new`).
2. Click **Report a vulnerability** and fill in the description, impact, and
   reproduction steps. Include the affected commit/branch, your environment
   (OS, Node version), and whether user data is involved.
3. If you cannot use the advisory flow, open a **draft** Security Advisory
   or contact the maintainer through the repository's Security tab — do not
   email a vulnerability to a personal address or post it publicly.

What to expect after you report:

- Reports are triaged by the repository maintainers (see [`docs/development/README.md#ownership-and-freshness`](docs/development/README.md#ownership-and-freshness)).
- Acknowledgement within **5 business days**.
- A triage decision (confirm / needs-more-info / not-applicable) with a
  severity assessment.
- Coordination on a fix and a disclosure timeline; you will be credited if
  you wish. The fix lands as a normal PR/commit and is noted in
  `CHANGELOG.md` (`Security`) and, where operational detail helps maintainers,
  in `dev-docs/maintenance-log.md`.

Please do not run automated scanners against the hosted `k-dense.ai` domain
as part of testing this fork — this policy covers **this repository only**. If this fork is ever relocated, update the repository URLs in this file and in `CONTRIBUTING.md`.

## Scope

In scope for this fork:

- Application code under `server/` and `web/`, the launcher `start.mjs`, and
  the sandbox / session / provenance / Modal / skill handling that the backend
  exposes locally.
- Dependency and supply-chain issues in `server/package.json` / `web/package.json`
  and the pinned harness packages (`@earendil-works/pi-*`, `pi-subagents`,
  `pi-web-access`, `skills`).
- Workflow and release automation under `.github/`.

Out of scope for this advisory route (open a normal issue instead):

- Upstream `K-Dense-AI/k-dense-byok` issues that reproduce without this fork's
  changes — report those to the upstream repository.
- Provider-side billing, quota, or model behavior (OpenRouter, NVIDIA NIM,
  Ollama, Pi OAuth providers) — those are governed by the provider, not this
  repo. For Kady's billing classification, see `server/src/cost/billing.ts`
  and [`AGENTS.md`](AGENTS.md).
- Feature requests, flaky tests unrelated to a security boundary, or
  documentation typos.

## Supported versions

K-Dense BYOK is a local desktop app, not a hosted service. Only the latest
tagged release and `main` receive security fixes.

| Version | Supported |
|---|---|
| Latest `vX.Y.Z` tag (from `server/package.json`) and `main` | Yes |
| Older tags | No — upgrade to the latest tag |

The version is the single source of truth in `server/package.json`
(`web/package.json` has no version field). The tag `v<version>` is created
only by `.github/workflows/release.yml` after a version bump merges to `main`.
See [`docs/development/release-policy.md`](docs/development/release-policy.md).

If you are on an older tag, verify the issue reproduces on `main` before
reporting.

## Secret-handling rules

This is a local app — secrets live on your machine, not on a hosted service.
Contributors and agents must treat credentials as non-exportable:

- **Never commit a secret.** `.env`, `server/.env`, `vertex_ai_credentials.json`,
  `~/.kady/pi-agent/auth.json`, and `projects/` are gitignored. Do not add
  keys, tokens, or session JSONL to a commit, issue, or PR, even redacted
  snippets. Use placeholders (`sk-or-...`, `<token>`) in examples.
- **Provider keys are read from `process.env`** via `server/src/env.ts`
  (repo-root `.env` → `kady_agent/.env` → `server/.env`). The backend never
  surfaces them in API responses and must not log them at any level. Secrets
  in CI are only read via `${{ secrets.NAME }}` and are never echoed. See
  [`.github/AGENTS.md`](.github/AGENTS.md#secrets).
- **Pi OAuth / Modal tokens** are stored at `~/.kady/pi-agent/auth.json`
  (override `KADY_PI_AGENT_DIR`; `PI_CODING_AGENT_DIR` takes precedence when
  set) and managed through Settings → Model providers / Modal. Do not copy
  them into the repo or share them between machines via the repository.
- **MCP configuration** under `projects/<id>/sandbox/.pi/mcp.json` may contain
  local tokens — treat it like `.env`.
- **Installed skills are instructions, not data.** A skill is a procedure the
  agent executes with shell access — review a third-party skill source before
  installing and pin a branch/tag. Kady shows the parsed skills first and
  requires acknowledgement; installed skills are never auto-updated. See
  [`docs/limitations.md`](docs/limitations.md).

If you accidentally commit a secret, rotate it immediately (provider dashboard
/ OAuth Settings) and notify the maintainers via the private advisory route so
the history can be handled.

## Local desktop context

K-Dense BYOK is a **local desktop app** — there is no hosted sandbox or
container boundary by default. The Pi agent's `bash` tool runs as **your OS
user** — this is the local shell trust boundary. File permissions like `0600`
on `auth.json` protect against other users on the same machine, but do not
isolate same-user shell processes from reading your own `.env` or `~/.kady`
directory. New sandbox instructions forbid reading credentials, but instructions
are not a substitute for OS isolation.

- Do not ask Kady to process adversarial files while secrets are accessible to
  the same account.
- For untrusted content, use an OS sandbox, container, VM, or separate user
  account. See [`docs/limitations.md#local-shell-trust-boundary`](docs/limitations.md#local-shell-trust-boundary)
  and [`AGENTS.md`](AGENTS.md).
- Outbound HTTP from the lead agent honours `HTTP_PROXY`/`HTTPS_PROXY` via
  undici's `EnvHttpProxyAgent` (`server/src/http-proxy.ts`); child `pi`
  processes already honour the proxy. There is no hosted intermediary that
  can enforce an egress allowlist on local shell actions.

## Public disclosure

Once a fix is available, maintainers publish a GitHub Security Advisory and a
release. Please give the maintainers a reasonable window to patch and release
before disclosing publicly. Coordinated disclosure protects users who run the
app locally and may not update automatically.

## Attribution

Security-relevant maintenance is recorded in the implementing PR in
[`dev-docs/maintenance-log.md`](dev-docs/maintenance-log.md) (internal
operational record) and, when users are affected, in [`CHANGELOG.md`](CHANGELOG.md)
under `Security`. The advisory itself remains the canonical disclosure record.
