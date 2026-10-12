---
title: "Next.js and brace-expansion security bumps"
status: completed
created: 2026-10-11
branch: security-next-brace-bumps
---

# Next.js and brace-expansion security bumps

**Status:** Completed and merged in PR #56

**Goal:** Investigate nine current dependency alerts with narrowly scoped updates:
Next.js 16.3.7 to 16.3.8 (six alerts), and Pi's nested brace-expansion 5.0.9 to
5.0.12 (three alerts). Keep KaTeX's separate compatibility upgrade out of scope.

## Why this work

Patched versions are available in npm. Pi's minimatch permits the patched brace-expansion via `^5.0.8`, but the
published SDK shrinkwrap pins 5.0.9. A scoped override was tested and ignored. Removing root-lock `hasShrinkwrap`
with the override preserves 5.0.12 through plain install and clean `npm ci`, but
the launcher-style explicit SDK install restores 5.0.9. Ship the verified Next
patch in f3dc275. The user subsequently authorized the durable Pi 1.1.0 upgrade
after inspection of its published archive confirmed no shrinkwrap. Upgrade all
three direct Pi pins together and verify the fixed graph survives startup.
The user delegated implementation to OpenCode Go DeepSeek V4.1 Flash and reserves
review and commits to the parent Codex agent.

## Design decisions

- Pin next and eslint-config-next together at 16.3.8.
- Upgrade the three direct Pi pins together to exact 1.1.0. Keep extension pins
  unchanged initially; do not ship the ineffective override or unstable lock
  workaround. Review session events, billing, MCP and child compatibility.
- Preserve child tool ceilings across Pi 1.1 MCP retention changes, including
  tools registered before host attachment and after MCP connects. Fail visibly
  if the pinned SDK compatibility seam changes.
- Normalize legacy Azure references when Kady resolves saved models and
  projects its verifier defaults; retain model ids and credential variables.
  Do not rewrite native user auth or custom Pi configuration.
- Parent owns documentation, review, commits and fork PR writes. Implementer may
  update the scoped manifests/locks and installed dependencies, but no Git writes.
- Confirm actual resolved versions and package/lock consistency before verification.

## Proposed information architecture / file changes

- web/package.json and web/package-lock.json: matching Next patch versions.
- server/package.json and server/package-lock.json: matching Pi 1.1.0 pins and
  the resulting patched dependency graph.
- Narrow provider/model/session/child-host seams and regression tests for
  Azure references and strict MCP ceilings.
- CHANGELOG and maintenance-log: scope, alert identifiers and verification.

## Implementation sequence

1. Delegate the minimal dependency changes and inspect every changed lock entry.
2. Verify resolution, typechecks/tests, lint and frontend production build.
3. Record results, archive this plan in the implementing PR and complete the
   standard PR checklist; keep hooks and branch protections enabled.

## Guardrails

No unrelated SDK/extension upgrades, KaTeX changes, secret/user-data reads, upstream writes,
manual version tags or verification bypasses. Dependency security alerts identify
vulnerable versions, not proof that every affected feature is reachable in Kady.

## Acceptance measures

| Outcome | Evidence |
| --- | --- |
| Six Next alerts fixed by version | next and eslint-config-next both 16.3.8 in manifest/lock/runtime |
| Three brace alerts fixed by version | All affected Pi paths resolve patched versions after clean ci and startup install |
| Harness compatibility | Pi pins match; extension pins retained; host patch anchors and targeted regressions pass |
| MCP child ceilings | Initial/late forbidden MCP excluded; permitted, unrestricted and empty-ceiling cases verified |
| Azure compatibility | Legacy saved Kady refs restore the same Azure model without fallback |
| No regressions | Full verification and production frontend build pass |

## Completion evidence

PR #56 includes Next 16.3.8 and Pi 1.1.0, Azure compatibility and strict child MCP regression coverage. Full verification passes 1,936 backend tests (8 intentional skips), 939 frontend tests, typechecks and docs gates. Clean and launcher-style installs retain the patched graph. GitHub alert closure is assessed after merge and graph refresh.
