# TODO

## Next Up

- [ ] **CI and hooks** → [2. CI and hooks](#2-ci-and-hooks)
- [ ] **Address code scanning / security alerts and Dependabot PRs** → [3. Code scanning, security alerts, and Dependabot](#3-code-scanning-security-alerts-and-dependabot)

---

## 1. Repo harness

> **Shipped** in [PR #11](https://github.com/kgforais1/k-dense-byok-mcp/pull/11)
> (plan archived at
> `dev-docs/plans/completed/2026-09-03-repo-agent-harness.md`). Section
> kept as a stable anchor for the rest of the roadmap.

## 2. CI and hooks

Set up continuous integration and git hooks for the fork.

Implemented:
- GitHub Actions CI hardened in PR #8 (`.github/workflows/tests.yml`): `permissions: contents: read`, `cancel-in-progress` on PRs, 15m timeouts, deterministic `npm ci`, full frontend gates (`typecheck`, `lint`, `build`, `test`), failure artifact capture, and PDF viewer initialization unit tests.

Remaining Ideas:
- pre-commit / pre-push hook coverage beyond the fork push guard (`.githooks/`)
- status checks required before merge
- test coverage
- complexity
- file line count
- broken links
- absolute paths
- privacy protection

## 3. Code scanning, security alerts, and Dependabot

Triage and resolve the security findings GitHub reports on the fork — currently ~140 Dependabot alerts on the default branch (47 high, 79 moderate, 14 low as of 2026-09-02), plus any CodeQL code-scanning alerts (the branch ruleset gates merges on CodeQL errors).

Ideas:

- Review Dependabot alerts: https://github.com/kgforais1/k-dense-byok-mcp/security/dependabot
- Review code scanning (CodeQL) alerts: https://github.com/kgforais1/k-dense-byok-mcp/security/code-scanning
- Work through Dependabot version-update PRs (npm bumps for `server/` and `web/`)
- Pin or upgrade transitive deps flagged high/critical first; dismiss-not-fixable ones with a reason
- Consider enabling Dependabot config (`dependabot.yml`) for ongoing update PRs
- Rate limiting (PR #7) is scoped to sandbox routes only, so UI polling can no longer be throttled; the frontend 429-handling idea for `apiFetch` is moot unless per-route limits are ever tightened
- Consider exempting `/health` from rate limits if external monitoring ever polls it (currently unthrottled anyway, since the limiter is sandbox-scoped)
