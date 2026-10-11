---
title: "Upstream sync #50"
status: accepted
created: 2026-10-08
branch: sync/upstream-2026-10-08
---

# Upstream sync #50 Implementation Plan

**Status:** Accepted

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
