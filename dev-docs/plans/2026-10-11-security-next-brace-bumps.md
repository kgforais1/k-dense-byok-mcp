---
title: "Next.js and brace-expansion security bumps"
status: accepted
created: 2026-10-11
branch: security-next-brace-bumps
---

# Next.js and brace-expansion security bumps

**Status:** Accepted

**Goal:** Investigate nine current dependency alerts with narrowly scoped updates:
Next.js 16.3.7 to 16.3.8 (six alerts), and Pi's nested brace-expansion 5.0.9 to
5.0.12 (three alerts). Keep KaTeX's separate compatibility upgrade out of scope.

## Why this work

Patched versions are available in npm. Pi's minimatch permits the patched brace-expansion via `^5.0.8`, but the
published SDK shrinkwrap pins 5.0.9. A scoped override was tested and ignored. Removing root-lock `hasShrinkwrap`
with the override preserves 5.0.12 through plain install and clean `npm ci`, but
the launcher-style explicit SDK install restores 5.0.9. Ship the verified Next
patch and track brace-expansion for a patched SDK release; SDK pins remain intact.
The user delegated implementation to OpenCode Go DeepSeek V4.1 Flash and reserves
review and commits to the parent Codex agent.

## Design decisions

- Pin next and eslint-config-next together at 16.3.8.
- Preserve Pi and extension exact pins. Do not ship the ineffective override
  or unstable lock workaround; record the demonstrated blocker in TODO and
  maintenance notes.
- Parent owns documentation, review, commits and fork PR writes. Implementer may
  update the scoped manifests/locks and installed dependencies, but no Git writes.
- Confirm actual resolved versions and package/lock consistency before verification.

## Proposed information architecture / file changes

- web/package.json and web/package-lock.json: matching Next patch versions.
- server manifests and lock: unchanged after investigation.
- CHANGELOG and maintenance-log: scope, alert identifiers and verification.

## Implementation sequence

1. Delegate the minimal dependency changes and inspect every changed lock entry.
2. Verify resolution, typechecks/tests, lint and frontend production build.
3. Record results, archive this plan in the implementing PR and complete the
   standard PR checklist; keep hooks and branch protections enabled.

## Guardrails

No SDK/extension upgrades, KaTeX changes, secret/user-data reads, upstream writes,
manual version tags or verification bypasses. Dependency security alerts identify
vulnerable versions, not proof that every affected feature is reachable in Kady.

## Acceptance measures

| Outcome | Evidence |
| --- | --- |
| Six Next alerts fixed by version | next and eslint-config-next both 16.3.8 in manifest/lock/runtime |
| Three brace alerts dispositioned honestly | Still open; shrinkwrap blocker and durable follow-up recorded |
| No harness drift | Exact Pi/extension pins and patch-subagent anchors unchanged |
| No regressions | Full verification and production frontend build pass |
