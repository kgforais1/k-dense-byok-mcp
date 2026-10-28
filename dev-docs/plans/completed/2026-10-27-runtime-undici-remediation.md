---
title: "Remediate residual undici exposure"
status: completed
created: 2026-10-27
branch: security/runtime-undici-remediation
---

# Remediate residual undici exposure

**Status:** Implemented on branch `security/runtime-undici-remediation`; record the PR number here when it opens (per Implementation Plan Lifecycle, the number lands as part of the PR's closing checklist — never as a post-merge follow-up).

**Goal:** Reduce the remaining exposure to vulnerable HTTP clients without
maintaining a Pi fork or requesting upstream changes. Enforce a verified Node
runtime policy, establish which Pi CLI paths Kady actually reaches, and test
failure handling at real process boundaries.

PR [#69](https://github.com/kgforais1/k-dense-byok-mcp/pull/69) is merged at
`b4ef5a0` and supplies the dependency changes and prior documentation
corrections. This branch is based on that merge; target `main` and verify the
final base and complete implementation range before delivery.

## Why this work

[GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c)
allows a malicious peer responding to a vulnerable `fetch` to terminate the
Node process, even when the rejection is caught. Node 22.22.0–22.23.3 and
24.13.0–24.22.0 contain affected undici copies; 22.23.4 and 24.22.1 have
fixed copies. The server's proxy setup can install fixed npm globals in the
backend, but it does not cover Next.js and should not be required as a security
mitigation. See [#68](https://github.com/kgforais1/k-dense-byok-mcp/issues/68).

Pi's CLI bundle also embeds an affected copy. The installed pi-subagents 0.78
code runs foreground sessions in the backend and ordinary background sessions
in a Node runner that attempts to install npm-resolved undici. Profile model
probes can invoke the bundled CLI; whether Kady exposes those probes remains
unverified. Kady's MCP integration invokes unbundled `dist/cli.js`. Do not
claim ordinary subagent runs execute the bundle or that the bundle is
unreachable without further evidence. See
[#67](https://github.com/kgforais1/k-dense-byok-mcp/issues/67).

## Design decisions

- **Runtime policy:** use a shared, testable version predicate and enforce the
  same supported ranges in the launcher and all three package engine declarations.
  Candidate floors are Node 22.23.4, 24.22.1 and 26.12.1; verify release data,
  supported lines, actual bundled undici, Next.js and Pi requirements before
  choosing exact ranges. Do not use `>=22.23.4` alone: it admits vulnerable 24.x
  releases. Explicitly decide how to treat odd, future and prerelease Node
  versions using a table of verified major/minimum-version pairs; accept a line
  only after its relevant fix and compatibility are established. Reject unsupported versions before startup with actionable upgrade
  instructions. Engine declarations alone normally warn rather than enforce. Use the launcher
  check and pre-execution guards for supported direct `npm run dev`/`start`
  paths; do not enable `engine-strict` globally or change install behavior.
- **Direct startup:** inventory `start.mjs`, package scripts, CI and other
  supported entry points. Enforce the policy at each supported production entry
  point, or explicitly narrow and document the supported contract; do not claim
  `engines` prevents direct startup. Use a zero-dependency predicate compatible
  with older runtimes, and run it before loading `tsx`, Next.js or undici so
  failures remain actionable. A launcher or npm lifecycle check alone can
  validate a different Node binary than the service (npm and executables resolve
  through PATH); enforce or establish the same runtime in the actual service
  process as well. Test differing launcher, npm and service Node executables.
  The launcher must check before its dependency installations.
- **Bundled CLI:** trace Kady's registered commands and actual spawn paths. If
  a user-reachable profile probe launches the bundle, evaluate using Pi's
  installed unbundled `dist/cli.js` through a verified launch seam; the installed pi-subagents code exposes
  `PI_SUBAGENT_PI_BINARY`, but its platform behavior and suitability for Kady
  are not yet established. Verify
  arguments, cross-platform behavior, authentication, provider setup and child
  semantics, including the Node-script and executable branches on Windows and
  POSIX; do not assume setting a binary override affects ordinary runners.
  If the seam is unsafe or no path is reachable, document the evidence and
  remaining risk instead of introducing a fragile workaround.
- **No upstream request, vendor patch, or private Pi rebuild.** Keep the npm
  override unless proven unnecessary for all npm-resolved paths. The existing
  postinstall pi-subagents patch is a separate compatibility seam and remains
  intact; adding a patch to `node_modules` or Pi's bundle for this advisory is
  outside scope.
- **Availability:** exercise abnormal runner exit and dispatcher setup failure
  separately; inspect task
  status, admission and recoverable usage accounting. The dispatcher failure
  is global-client setup, not an npm installation failure. Avoid assuming a
  reservation exists or usage can be recovered before it was observed.
  Containment fixes neither the advisory nor the spend-cap overshoot limit.
- **Other advisories:** retain the separate KaTeX and dev-only Zod follow-ups;
  they are not prerequisites for the Node and CLI work.

## Proposed information architecture / file changes

- `start.mjs` and a small shared runtime-policy module: version check and
  upgrade message, with import-safe tests and cross-platform behavior.
- Root `package.json`, `server/package.json`, `web/package.json`, and any
  affected lockfile root metadata (there is currently no root lockfile):
  consistent engine ranges; any required startup-script checks.
- `server/src/agent/` and relevant tests: only if the confirmed CLI path needs
  a supported unbundled entry point or runner failure handling needs a fix.
- `server/test/` and launcher tests: version boundaries, process-level HTTP
  regression and failure/cleanup behavior; no real provider or credentials.
- Installation/launcher documentation, `AGENTS.md`, `CHANGELOG.md`,
  `dev-docs/maintenance-log.md` and `dev-docs/todo.md`: consistent supported
  versions, evidence, and remaining risks. Reconcile #67 and #68 with results.
- CI workflows if needed: test supported minimum versions and the project's
  ordinary current Node line without changing verification gates; preserve
  floating jobs alongside pinned minimum-version checks.

## Implementation sequence

### Phase 1 — Establish the actual runtime and entry points

- [ ] Confirm current advisory ranges and each proposed Node line's bundled
      undici using authoritative Node release records; compare minimum versions
      with the current Next.js/Pi requirements and platform support.
- [ ] Trace foreground, background, profile-probe and MCP launches from Kady,
      including whether slash commands or user settings can reach the bundled
      CLI. Include MCP and skills subprocesses using `process.execPath`, and
      record exact call sites, assumptions and any untested paths.
- [ ] Inventory direct startup paths, CI, all three engine declarations and
      existing runtime tests. Independently compare the server and web npm
      undici lockfile versions, Node-bundled copies and Pi bundle against the
      advisory; confirm #69's override and distinguish their call paths.

**Exit criteria:** A documented version policy, npm and Node version verdicts,
and call-path evidence exist before later phases begin; unknown reachability
remains explicitly marked unknown.

**Inventory (2026-10-28):** Node's release notes report undici 6.29.1 in
[22.23.4](https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V22.md),
7.30.1 in [24.22.1](https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V24.md),
and 8.12.2 in [26.12.1](https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V26.md);
all meet the advisory's fixed versions. The server's npm copy resolves to
8.12.3; web resolves 7.30.1 and 6.29.1. The current development host is Node
24.18.0 and will require a separate fixed Node binary for acceptance tests.
Profile probes and disabled Herdr panes can launch Pi's bundled CLI, but their
reachability through Kady is not established. Foreground sessions run in the
backend; the detached runner normally installs npm undici, with a fallback to
existing globals on installation failure. Its `resolveNodeExecutable` and
all other subprocess paths must be checked individually, not assumed to use
the launcher's binary. Verify Node 26 behavior, including compression and proxy
streaming, before accepting it in the final policy.

### Phase 2 — Enforce the Node policy

- [ ] Implement and test one runtime predicate against both sides of every
      supported/rejected boundary, including prereleases and explicitly decided
      odd/future majors; keep package engine ranges in parity.
- [ ] Apply it at supported startup entry points and update installation guidance
      and lockfile metadata. Provide a clear platform-appropriate upgrade message.
- [ ] Prove the actual service Node is checked, including a launcher/`npm`/PATH
      mismatch test, and check before the launcher installs dependencies.
- [ ] Exercise both normal launcher and documented direct starts on a supported
      version and a rejected version. Add exact minimum-version CI jobs for
      supported lines alongside floating jobs, or record a concrete blocker;
      cover launcher `--check` on the supported operating systems.

**Exit criteria:** Supported startup paths reject versions outside the policy
before running services; engine metadata, tests and documentation agree.

### Phase 3 — Address verified CLI paths and runner resilience

- [ ] If a reachable bundled CLI path is found, prove whether the installed
      unbundled CLI and supported spawn seam preserve behavior on macOS, Linux
      and Windows; implement only if that proof succeeds. Otherwise record why
      the path is unavailable, unmitigated, or unsuitable for redirection.
- [ ] Test foreground and detached runner client selection, including separately
      injected dispatcher setup failure and unexpected runner death. Identify
      the actual client used after setup failure. Verify the
      actual failure behavior, visible task status, observable usage recovery,
      idempotence and cleanup; repair any worthwhile verified failure. Do not
      assume an incomplete request produced a pending usage receipt.

**Exit criteria:** Each examined path has a source-backed outcome and any
implemented redirection or containment has a focused regression test; no
unsupported claim of complete bundle remediation remains.

### Phase 4 — Validate and prepare delivery

- [ ] Build a local controlled malformed-response fixture from the advisory;
      first validate the fixture against a pinned, isolated known-vulnerable
      implementation before treating it as a crash regression test. Then
      exercise the actual affected process paths with explicit rejection, exit,
      signal and task-state oracles. If the vulnerable control is unavailable,
      test client identity instead and document the reproduction gap. Use
      loopback and ephemeral ports, bound time, clean up on all platforms and
      never use a live service.
- [ ] Run targeted tests and applicable `npm run verify -- fast`, `server`,
      `web`, and `docs` ladders. Verify lockfile/engine parity and minimum
      supported versions; do not bypass hooks or gates.
- [ ] Update the issue assessments and completion records, archive this plan in
      the implementing PR, and retain TODOs for any unresolved paths. Verify PR
      #69 and any other prerequisite is merged or submitted with correct head,
      base and dependency links before claiming delivery.

**Exit criteria:** Test outcomes and residual limitations are recorded, all
required checks complete, and the implementing PR covers the full intended
range with prerequisites accounted for.

## Guardrails

- Do not weaken request guards, alter authentication, send credentials to test
  endpoints, or bypass verification and branch protections.
- Preserve current proxy behavior, including loopback bypass, and verify any
  Node or client change does not regress compressed responses or streaming.
- Do not claim the Node upgrade patches Pi's independently bundled undici, or
  that fixed npm dependencies guarantee every independently spawned process.
- Preserve user configuration and existing uncommitted changes; make no public
  issue or PR writes beyond separately authorized work.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| Runtime policy excludes known vulnerable releases | Boundary tests, matching engines and actual startup checks |
| User-visible startup and direct-use guidance is consistent | Launcher tests and reviewed installation documentation |
| Pi bundle exposure is correctly scoped | Trace of actual Kady entry points and process/client identity; remaining unknowns stated |
| Confirmed reachable paths are addressed where feasible | Local process-level tests or documented limitation; no assumed bundle fix |
| Runner failures do not silently lose state | Focused failure, accounting and cleanup tests, or a documented remaining gap |
| Change is reviewable and deliverable | Required verification results, updated records, and prerequisite PR inventory |

## Outcome (implemented 2026-10-28, unmerged)

- **Runtime policy enforced:** supported releases are exactly 22.23.4–22.x, 24.22.1–24.x, 26.12.1–26.x (stable only; prereleases and odd/future majors rejected). Shared zero-dependency predicate (`node-policy.mjs`) enforced by the launcher before installs and inside every service process via `node --import` (`scripts/node-guard.mjs`); matching `engines` ranges stay advisory. SemVer parity against npm's own `semver.satisfies` is tested per boundary.
- **Probe reachability, source-backed:** `/subagents-refresh-provider-models|generate-profiles|check-profile` typed in chat or sent as MCP research text reach pi-subagents' handlers through Kady's slash dispatch (`api/sessions.ts` → Pi `_tryExecuteExtensionCommand`); `pi.exec` is unconditional headless, and the default spawn resolves to the bundled CLI. No Herdr-pane slash path exists; panes stay disabled. Kady now sets `PI_SUBAGENT_PI_BINARY` to the installed unbundled `dist/cli.js` (npm undici 8.12.3), with POSIX PATH-front alignment to the verified backend binary, verbatim operator-override preservation, loud warn-and-visible-probe-failure on missing/non-executable entries, and clear startup failure on unresolvable entry or un-aimable PATH. This covers the default probe path only — a custom operator override is an explicit user-controlled exception, not proven safe.
- **Validation actually performed (all local, loopback-only):** `node --test node-policy.test.mjs node-guard.test.mjs` green under verified fixed Node 24.22.1 (36/36) and 26.12.1 (34 pass, 2 host-reject-only skips); `server/test/http-proxy.test.ts` 11/11 under both, including the new gzip-streaming case (the only Node 26 compressed-stream coverage claimed); `server/test/subagent-pi-binary.test.ts` 26/26 under both; broader local verification: server 158 files passed (1 skipped file), 1982 tests passed (8 skipped), web 136 files / 943 tests passed, `web` production build clean, offline launcher shell test (`scripts/test-start-sh-missing-node.sh`, fake brew/node) 12/12; server typecheck and lint clean; docs ladder green at delivery. New CI minimum-version jobs and the shell-test step are defined but have not run (no pushes); Windows coverage is injected-platform unit tests only, not a Windows runner.
- **Explicitly not done:** no malformed-response PoC crash test (no isolated vulnerable control was available; client identity tested instead); no live detached-runner kill test (needs live Pi sessions; Kady-side meter/recovery coverage plus code tracing stand in).
- **Tradeoffs and residual risks (recorded, not signed off):** process-wide PATH move (backend children resolve `node` to the guarded binary); operator overrides unproven by design; missing/non-executable entry degrades to loud probe errors, never the bundle; Pi upgrades require re-checking the bundle and the seam shape (standing #67 follow-up, retained in `dev-docs/todo.md`).
