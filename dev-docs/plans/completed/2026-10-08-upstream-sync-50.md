---
title: "Upstream sync #50"
status: completed
created: 2026-10-08
branch: sync/upstream-2026-10-08
---

# Upstream sync #50 Implementation Plan

**Status:** Completed and merged in PR #51

> Closeout recorded 2026-10-11 after merge. Office keyboard/save verification now passes for Writer, Calc and Impress; see [the verification record](../../office-keyboard-verification-2026-10-11.md). Earlier pending statements below are historical. Asset retention (#52) and compatibility investigation (#54) remain separate follow-ups. This late archival corrects the missed PR closing checklist; it does not redefine the lifecycle rule.

**Goal:** Merge 44 upstream commits through 44c52cee8e9f, bringing the fork to upstream 0.15.0 while preserving inbound MCP capabilities and repository verification gates.

## Design decisions

- Adopt upstream Pi 1.0, native outbound MCP, security guards, UI and scientific improvements.
- Port headless sessions, run admission/results, scheduling holds and atomic transfer safeguards onto upstream APIs.
- Retain fork dependency fixes, CI matrices, pinned actions, coverage floors and ratchets.

## Implementation sequence

- Resolve product code and dependency conflicts, retaining fork seams.
- Refresh product documentation while retaining fork attribution and contributor guidance.
- Verify backend/frontend types, tests, lint, builds and documentation; investigate semantic auto-merge issues.
- Record merge evidence in the maintenance log and prepare a fork PR closing issue #50.

## Guardrails

No upstream push, verification bypass, lost headless identity or weakened cost/security gate.

## Acceptance measures

| Outcome | Evidence |
|---|---|
| Integrated runtime and fork behavior | Full verification, lint, coverage, build and targeted MCP/session regressions |
| Reviewable sync | Maintenance record and fork PR |
