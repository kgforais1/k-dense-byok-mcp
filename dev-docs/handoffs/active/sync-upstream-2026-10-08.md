---
branch: "sync/upstream-2026-10-08"
plan: "dev-docs/plans/2026-10-08-upstream-sync-50.md"
owner: "Codex"
status: "in-progress"
updated: "2026-10-08"
---

# Active Handoff: sync/upstream-2026-10-08

## Scope
Merge upstream 44c52cee8e9f (44 commits, issue #50) onto fork c8ed0c0.
Draft review: [PR #51](https://github.com/kgforais1/k-dense-byok-mcp/pull/51).

## Decisions
Adopt Pi 1.0 and native outbound MCP; retain inbound MCP, headless session identity, run admission/results, security gates and fork dependency fixes. Session deletion now awaits extension cleanup and marks deletion before yielding.

## Changed files
- Upstream product code and docs, plus fork integration seams in session registry, routes, scheduling and transfer.
- Dependency manifests merged; lockfiles regenerated from fork lockfile baselines.

## Verification
- Backend: 1,888 tests pass, 8 intentionally skipped; all coverage floors pass.
- Frontend: 928 tests and coverage pass; typechecks and lint pass in both packages.
- Production webpack build passes locally; the default production build passed Linux and Windows frontend CI.
- Full `npm run verify -- all` passes; secret-history scans pass; exact synthetic fixture literals are narrowly allowlisted, and fixture paths use explicit placeholders.

## Known failures / Rough edges
- Initial Windows backend CI failed a fixed-delay Modal recovery assertion; follow-up waits for the observed failure.
- DeepSource JavaScript passes after the type and host-global corrections. CodeQL's failed-auth alert is resolved; its remaining guarded path/command and test-response annotations require follow-up review. Static triage evidence is retained privately; no alerts or verification rules were suppressed.
- npm audit retains 1 backend high and 9 frontend high / 7 low findings; exact framework/harness pins retained and critical findings cleared with compatible fixes. Details in maintenance log.
- Draft PR review/CI and lifecycle closeout remain before merge.

## Blockers
- Merge remains blocked until the scanner summaries and follow-up Windows verification are resolved.

## Next action
Check the CI follow-up and scanner review on PR #51. After review approval, finalize the plan/handoff closeout in the same PR before merge.
