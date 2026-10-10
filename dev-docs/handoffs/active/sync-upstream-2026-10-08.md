---
branch: "sync/upstream-2026-10-08"
plan: "dev-docs/plans/2026-10-08-upstream-sync-50.md"
owner: "Codex"
status: "in-progress"
updated: "2026-10-10"
---

# Active Handoff: sync/upstream-2026-10-08

## Scope
Merge upstream 44c52cee8e9f (44 commits, issue #50) onto fork c8ed0c0.
Draft review: [PR #51](https://github.com/kgforais1/k-dense-byok-mcp/pull/51).

## Decisions
Adopt Pi 1.0 and native outbound MCP; retain inbound MCP, headless session identity, run admission/results, security gates and fork dependency fixes. Session deletion now awaits extension cleanup and marks deletion before yielding.

The owner approved a one-time exception to the 100-file PR limit for PR #51.
Bot review corrections preserve usage after image-save failure, avoid Radius
connector-name collisions, and prevent pending cold opens from escaping deletion.
Office asset availability, live tool-spend accounting and compatibility review
are tracked in issues #52, #53 and #54 respectively.

## Changed files
- Upstream product code and docs, plus fork integration seams in session registry, routes, scheduling and transfer.
- Dependency manifests merged; lockfiles regenerated from fork lockfile baselines.

## Verification
- Backend: 1,910 tests pass, 8 intentionally skipped; typecheck and lint pass. Latest-revision coverage remains part of CI.
- Frontend: 928 tests and coverage pass; typechecks and lint pass in both packages.
- Production webpack build passes locally; the default production build passed Linux and Windows frontend CI.
- Full `npm run verify -- all` passes; secret-history scans pass; exact synthetic fixture literals are narrowly allowlisted, and fixture paths use explicit placeholders.

## Known failures / Rough edges
- The 18 targeted Sonar quality fixes have regression coverage. Kimi identified a pre-action scheduler ownership regression; notifications now run only after successful tool results. Kilo free and Claude Opus 5.5 medium approve the correction; Kimi follow-up output is unusable. Opus's exposure-control accessible-name finding is fixed with a role/name regression assertion. Older padded schedule ids and an unreproduced budget-tick race remain follow-up observations. Runtime unsafe-eval remains unresolved; intentional-behavior findings have not been dismissed remotely.
- Modal reserved-root case handling is corrected with regression coverage; Muse reconciled its earlier concerns with Opus, and both agree the current CodeQL root-escape findings are false positives. Authorized dispositions are recorded; CodeQL is green. SonarCloud remains blocked on its reliability/security ratings (46 findings); its newly introduced trailing-trim regex is corrected with a linear scan.
- Initial Windows backend CI failed a fixed-delay Modal recovery assertion; follow-up waits for the observed failure.
- DeepSource JavaScript passes after the type and host-global corrections. CodeQL's failed-auth alert is resolved; its remaining guarded path/command and test-response annotations require follow-up review. Static triage evidence is retained privately; no alerts or verification rules were suppressed.
- npm audit retains 1 backend high and 9 frontend high / 7 low findings; exact framework/harness pins retained and critical findings cleared with compatible fixes. Details in maintenance log.
- Draft PR review/CI and lifecycle closeout remain before merge.

## Blockers
- Current status supersedes the older scanner notes above: CodeQL, SonarCloud and DeepSource pass at `5ce59f3`. The Windows backend failure is a robustness result-readiness assertion; the review correction uses the shared wait budget and polls for both retained results. Latest-revision CI and Hyrax re-review remain pending before merge.

## Next action
Check the CI follow-up and scanner review on PR #51. After review approval, finalize the plan/handoff closeout in the same PR before merge.
