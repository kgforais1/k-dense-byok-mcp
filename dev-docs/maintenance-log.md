# Maintenance Log

### 2026-10-13 — Extension harness bump (pi-subagents 0.78, pi-web-access 0.40, skills 1.7.2)

- **Pins:** Stay on Pi 1.1.0. Move pi-subagents 0.74.0 → 0.78.0, pi-web-access 0.35.0 → 0.40.0, and skills 1.7.0 → 1.7.2. Peers still accept Pi ≥ 0.86.1. Pi 1.1.0 already depends on `pi-mcp` and `pi-codemode`; this bump does not move the Pi version line. 0.78 runs on 1.1 and also starts background children on 1.2 again.
- **Host seams:** The patch script now requires 0.78.0. Schedule save/read keep the new `missionId` field while still pinning the host model. The headless drain skip keeps `.then(resultWatcher.deliverPendingResults)`. The `pi-agent-core/node` seam is removed because 0.78 marks that alias optional and skips it when the installed Pi does not export it.
- **Workflow scripts:** 0.76 runs one untagged `js` block when the reply has no `js workflow` fence. `replyWorkflowScript` follows that rule so budget gating sees the script the plugin will run. Two untagged blocks stay dynamic.
- **Skills layout:** skills 1.7.1 installs `--agent pi` into `.agents/skills`. Staging follows that path. Live project skills remain `.pi/skills`, which Pi 1.1 discovers.
- **Left in place:** reviewer/oracle/evidence-auditor acceptance reports are no longer written unless the call passes `acceptance` (0.78). Kady does not read those files. `run-history.jsonl` is no longer written; nothing here reads it. pi-web-access 0.38–0.40 search and fetch changes are opt-in or provider-side; the MCP SDK bump inside that package is overridden to this repo's SDK. The chat chip still collapses only a tagged workflow fence.
- **Review corrections:** OpenCode Muse Spark 1.3 Free and Kilo Step 5 Preview Free both approved. Follow-up: the Pi 1.1 pin note no longer claims that 1.2 is what split out MCP and codemode; a reply counts `workflow: "true"` the same way the plugin does; a fixture package asserts that a declared runner alias with a missing file still fails; the skills staging comment names `.agents/`. DeepSource's complexity note on `replyWorkflowScript` is the fence scan, now its own helper; the two new test strings use template literals.

### 2026-10-12 — Pi 1.1 security upgrade and compatibility repairs (PR #56)

- **Dependency fix:** Upgrade pi-agent-core, pi-ai and pi-coding-agent together to exact 1.1.0; keep pi-subagents 0.74.0, pi-web-access 0.35.0 and skills 1.7.0. Pi 1.1 has no published shrinkwrap and directly pins brace-expansion 5.0.12, replacing the vulnerable 5.0.9 copy for GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7 and GHSA-6j4f-fj2g-mc7p. The nine known Next/Pi advisories are addressed by version on this branch; GitHub alert closure still depends on merge and dependency-graph refresh.
- **Graph review:** The large lock diff removes 130 duplicate SDK-nested entries and Pi TUI's dropped optional koffi dependency. New hoisted Pi packages, Anthropic SDK 0.129.0 and marked 18.0.11 follow the upstream exact dependencies. No unrelated package upgrade or override. Parent independently verified clean npm ci and the exact launcher install retain 5.0.12 and the same lock hash, with normal postinstall seams.
- **Compatibility:** Pi renamed Azure to `azure`; Kady resolves old Azure references at model/default resolution and cold-session restoration, and projects canonical verifier overrides without rewriting app defaults or credentials. Native Pi custom settings and hand-written specialist refs require manual provider-ID updates; see [model selection](../docs/model-selection.md).
- **MCP review finding:** Pi 1.1 retains unlisted MCP tools under ordinary child allowlists. The fork-owned host restores strict filtering and refreshes the registry immediately, covering existing and late registrations. The private filter/refresh seam is pinned to Pi 1.1 and rejects SDK-shape drift. Real child-factory regressions cover forbidden, permitted, unrestricted and empty allowlists; removing the refresh reproduces the initial-registration failure. Parent independently reproduced the defect and verified the repaired callable set.
- **Review:** OpenCode Go DeepSeek V4.1 Flash implemented the upgrade and compatibility repairs; parent reviewed the full dependency delta and session/tool-event changes. Focused parent regression run passes 39 tests, including legacy verifier projection with the original saved default left intact. KaTeX remains separately tracked; no SDK-native user files or secrets were migrated.

- **Final verification:** `npm run verify -- all` passes both typechecks, 1,936 backend tests (8 intentional skips), 939 frontend tests and all documentation gates. Backend lint has zero warnings/errors. Frontend production build passes; frontend lint has zero errors and 58 existing warnings on the unchanged Next patch tree.

- **DeepSource follow-up:** The new findings are complexity in the write-ahead ownership reader (14) and reconciler (39), complexity 7 in the interruption matrix, and two redundant `undefined` clear calls. The projection is split into the same decisions as before: load settings, recover pending ownership, skip user edits, then write the pending sidecar before settings. Clearing a verifier model omits the argument. No routing change. The child MCP shape check is its own function so the allowlist guard stays under the complexity warning. Helpers that the split added carry comments, and removing an owned override rebuilds the map instead of deleting a computed key. The MCP ceiling test loads that facade with a dynamic import, so the static namespace import is gone. `restrictChildMcpToAllowlist` now has its own documentation comment. Ubuntu CI then failed `provenance.test.ts` once: the declared-write case wrote `de_analysis.py` before the async baseline scan finished, so the edge was `modified`. That test now waits for the empty baseline first, as the bash cases already do.

- **Bot review follow-up:** Sourcery correctly identified interrupted verifier settings/ownership writes. A write-ahead ownership record now recognizes either committed settings value, recovers on retry, and preserves intervening user edits. Seven fault-injection regressions cover creation, changes, clearing and user edits. Greptile’s shared timing-helper requirement is applied to MCP polling. DeepSource fixture cleanup removes empty error handling, redundant undefined and unnecessary async syntax; the SDK namespace is required for the factory module facade, and the short fail-closed MCP guard remains readable. Its callback-arity warning is a false positive against the typed one-argument contract (now also explicit on the default implementation). Focused regressions pass 46 tests; backend lint/typecheck pass. The complete post-fix ladder passes 1,943 backend tests (8 intentional skips), 939 frontend tests, both typechecks and all docs gates.

### 2026-10-11 — Next security patch and Pi shrinkwrap investigation

Historical result at f3dc275; the Pi 1.1 upgrade above supersedes the brace blocker.

- **Shipped scope:** Next and eslint-config-next 16.3.7 → 16.3.8; lock changes are limited to matching Next packages. This addresses the vulnerable version in six Next alerts. No SDK, extension or KaTeX upgrade.
- **Brace blocker:** Pi coding-agent 1.0.0 publishes a shrinkwrap pinning brace-expansion 5.0.9. DeepSeek reproduced a scoped override being ignored. A root-lock metadata workaround retained 5.0.12 through two plain installs and clean npm ci, but explicit `npm install --save-exact @earendil-works/pi-coding-agent@1.0.0` restored both `hasShrinkwrap: true` and installed 5.0.9. Parent independently confirmed the final scratch lock and runtime. No ineffective backend change is shipped; three brace alerts remain open and tracked for a patched SDK release.
- **Review:** Implementation delegated to OpenCode Go DeepSeek V4.1 Flash; parent reviewed every changed lock entry and ran frontend typecheck, all 939 tests, production build and lint (zero errors; 58 existing warnings). KaTeX compatibility work remains separately tracked. Full elevated `npm run verify -- all` passes backend/frontend typechecks, 1,928 backend tests (8 intentional skips), 939 frontend tests and documentation gates. The first sandboxed run stalled and was stopped; it is not counted as a pass.

### 2026-10-11 — Sourcery slow-download and estimate corrections (PR #55)

- **Findings:** Both Sourcery comments are valid. A cold-cache transfer exceeding the previous three-minute deadline returned 503; the workspace loading message still promised approximately 50 MB after the mirror changed the transfer estimate to approximately 250 MB.
- **Corrections:** Raise the finite per-asset download deadline to 30 minutes and update the workspace loading estimate to approximately 250 MB. Keep download size/hash checks, atomic installation and explicit failure behavior.
- **Regression:** A virtual-time streamed transfer delivering its final bytes after 181 seconds fails with 503 under the former timeout and succeeds with exact verified cache bytes after the correction. All 13 focused route/workspace tests pass.

### 2026-10-11 — Retained Office runtime for cold-cache installations (PR #55)

- **Review and closeout:** OpenCode Go DeepSeek V4.1 Flash approves `a238c73` and `b87026b` with no blocking defects. Full local verification passes 1,928 backend tests (8 intentional skips) and 938 frontend tests; all CI checks pass at `b87026b`. Archive the retention plan and remove its shipped TODO in PR #55. The archived Sonar handoff instruction is explicitly marked historical.
- **Retention:** Publish the four exact tested `zeta-2025-05-13` runtime files with build-prefixed names on the fork's existing `v0.15.0` release. Include checksums, embedded source revision, source download references and source-revision licensing/third-party notices. No manual release tag or asset replacement.
- **Behavior:** Cold caches fetch retained release assets instead of the vendor's moving latest path. Keep hash verification, cache location, atomic replacement and explicit 503 failures. Record metadata's measured size (215,180 bytes) without changing its hash.
- **Verification:** All four published files independently pass exact size/SHA-256 checks through the real route into a fresh disposable cache. Five offline route regressions pass; frontend typecheck and all 938 tests pass; changed-file lint and docs checks pass. The earlier keyboard/reopen evidence remains valid because the executable bytes are identical.
- **Documentation:** Correct first-download size to approximately 250 MB for the mirror; document source provenance, administrator mutability versus digest enforcement, offline provisioning and update/retention procedure. Visual layout and advanced-object preservation are not newly claimed.

### 2026-10-11 — PR #51 closeout and Office keyboard verification

- **Keyboard evidence:** Writer DOCX, Calc XLSX and Impress PPTX accepted unique markers through trusted Paseo canvas key events, saved through Kady, reopened and saved again at merge commit `8c59dc5`. Parent inspection independently confirmed marker presence, ZIP CRC validity and XML parsing in all six packages. See [the verification record](office-keyboard-verification-2026-10-11.md).
- **Limits:** Native desktop tooling and screenshots were unavailable; visual layout and advanced-object preservation are not claimed. Isolated servers were stopped and user projects were untouched.
- **Review closeout:** GLM's complete narrow review approves all three corrections at `8f5c12e`; Muse also approves. Final CI passed 1,928 backend tests (8 intentional skips) and 933 frontend tests. Earlier pending-review and pre-merge statements below are historical.
- **Lifecycle repair:** Remove the shipped keyboard TODO, archive both PR #51 plans and remove its stale active handoff. These should have shipped before merge; this follow-up repairs that omission. Issues #52 and #54 remain open.

### 2026-10-11 — GLM correctness review corrections (PR #51)

- **Review scope:** The fresh NVIDIA GLM 5.3 pass returned approve with three low-severity notes. It verified event ordering against pinned Pi code and listed substantial unreviewed files; no exhaustive whole-repository claim is made. The earlier GLM instance's unfinished notices are not counted as reviews.
- **Corrections:** Subtract only tool usage included in session stats when calculating the lead row, while ledgering every completed paid tool separately. Stop recovery on permanent 404/410 responses and append an unavailable-chat error without replacing partial output; transport/auth/server failures remain retryable. Require the specialist usage cost object's numeric total instead of interpreting malformed values as free work, preserving malformed durable receipts and failing subsequent admission visibly.
- **Reproduction:** Two interrupted-run cases, four missing-chat recovery cases and five malformed-cost cases failed before their respective changes. Existing normal tool billing, abort/recovery, transient reconnect and terminal specialist usage tests remain enabled. An added recovery test preserves a malformed receipt and proves new admission is refused.
- **Verification:** Full `npm run verify -- all` passes (1,927 backend tests with 8 intentional skips; 932 frontend tests; both typechecks and docs gates). The additional late-404-after-Stop/reset regression then passes the complete frontend ladder, bringing it to 933 tests. Backend lint passes; frontend lint has zero errors and 58 existing warnings. A sandbox-only child MCP test timed out; the identical test passed in the elevated full ladder. Muse's narrow re-review approves all three corrections; GLM's narrow re-review remains pending.
- **Follow-ups:** Immutable Office assets (#52) and validated Modal/JCAMP compatibility work (#54) remain open. The repeated-message gate claim is not established by the stated trigger: the first installed gate handles later public sends directly. Conservative delegated in-flight overcount predates this sync and is outside these narrow corrections.
- **Remaining pre-merge evidence:** The earlier Sonar plan still requires real keyboard open-type-save in Writer, Calc and Impress; its scripted open/export checks did not prove keyboard entry. This gap is now explicit in TODO, and plan/handoff archival remains pending that closeout rather than claiming all acceptance evidence is complete. The mixed persisted/unpersisted-tool regression also passes with lead $0.01 plus paid tools $0.05, without omission or duplicate charging.

### 2026-10-10 — Live paid-tool accounting and extended correctness review (PR #51)

- **Muse review follow-up (2026-10-11):** The complete Go Muse Spark 1.3 Contributor record returns approve, with explicit substantial unreviewed areas. Its low-severity local-billing observation reproduced for both local prefixes: a custom resolver could overwrite the initial exemption, although the production resolver already preserves it. The helper now bypasses resolution for local providers. Two regressions fail before the correction and assert local billing, zero cap spend and no resolver invocation afterward. GLM's independent review remains pending.

- **Correction:** Issue [#53](https://github.com/kgforais1/k-dense-byok-mcp/issues/53) is implemented in this PR. Observe completed tool usage before persistence, classify by each model's credential with a conservative pending charge, and retain usage when a run fails before `turn_end`. Call ids are scoped to turns; completion, message and turn events update one charge. Payg lead runs release the additional hold when session stats include the result; subscription runs retain their paid-tool charge until ledger cleanup.
- **Focused verification:** Sixteen tests pass across the live-tool and pipeline suites, including concurrent-tab refusal, the pre-persistence window, final ledger reconciliation, mixed providers, repeated call ids, failed billing lookup and interrupted turns. Backend typecheck and lint pass.
- **Review:** After initial endpoint errors, the owner's resumed Longcat 2.5 Preview Free pass returned an approve verdict for `dab6fea`, with a substantial explicit list of unreviewed files. Its suspected nesting from two messages during finalization is not established: the first gate replaces both public methods, so subsequent messages enter that gate instead of re-entering the observer wrapper. Corrupt-receipt admission failure is intentional fail-closed accounting. GLM and Muse will independently review the updated full diff and these coverage gaps.
- **Frontend assertion investigation:** Full verification passed 1,917 backend tests but one editor test timed out while its lazy-import fallback was still visible. The unchanged four-test file and unchanged full 928-test frontend suite both passed on rerun; no component defect was reproduced. The editor queries now wait up to five seconds for actual readiness (with a fifteen-second test ceiling), preserving real editor state and every draft/save assertion. Focused tests and the complete frontend typecheck/test ladder pass after the change.

### 2026-10-10 — Bot review corrections and dispositions (PR #51)

- **Corrections:** Preserve image-provider usage and partial successful outputs when saving fails. Radius setup chooses a free numbered fallback instead of overwriting an unrelated global connector. Reject tombstoned warm/pending opens and dispose a cold session constructed while deletion was awaiting it.
- **Lifecycle evidence:** A deterministic construction barrier reproduced the pending-open gap before the correction. Regression tests cover that interleaving, disposal failure after real cleanup, and failed transcript removal. Failed deletion clears the tombstone and permits reopening the retained transcript; `not_deleted` describes persistence, not a guarantee that a warm cache entry survives. Pi's shutdown emitter is async and catches handler errors, while release additionally handles a rejected emission. Keeping a tombstone permanently after failed deletion would unnecessarily strand the chat.
- **Verification:** The four focused suites pass (79 tests), backend typecheck and lint pass, and `npm run verify -- all` passes outside the sandbox. The identical sandbox run stalled in a backend worker and was stopped only after the complete elevated ladder passed. No checks were disabled.
- **Windows CI correction:** The failed backend job at `5ce59f3` asserted retained robustness results after a four-second job wait. The API regression now uses the shared wait budget and polls the two expected results; the focused two-test suite passes. This retains the result-readiness assertion instead of accepting partial or missing output.
- **Dispositions:** The remaining CodeQL threads refer to dismissed alerts #376/#377; existing alert dispositions and scanner rules are unchanged. The owner explicitly approved a one-time 100-file-limit exception for this already assembled upstream sync, recorded in `AGENTS.md`.
- **Follow-ups:** [#52](https://github.com/kgforais1/k-dense-byok-mcp/issues/52) retains immutable Office assets without weakening hash checks. [#53](https://github.com/kgforais1/k-dense-byok-mcp/issues/53) tracks the separate confirmed gap where paid tool usage in subscription chats is invisible to admission until final ledgering; the image-save fix does not resolve that gap. [#54](https://github.com/kgforais1/k-dense-byok-mcp/issues/54) records legacy Modal reservation recovery and JCAMP profile compatibility for further validation, without adopting the bot's suggested policy changes.

### 2026-10-09 — Targeted SonarCloud quality corrections (PR #51)

- **Scope:** The 18 fix-worthy static findings: two ignored scheduler promises, twelve regex sites (including mirrored classifier copies and repeated URL expressions), three connector label associations and Office runtime language.
- **Implementation:** Await manual-action listeners and propagate the registered scheduler refresh promise. Use linear trailing-slash trimming, cached compaction-tag terminators, direct fence delimiters and disjoint numeric/package grammar repetitions. Keep standalone classifier parity, deterministic ordering, scriptless previews and runtime CSP behavior intact.
- **Regression coverage:** Async listener rejection propagates for pause/resume/delete; malformed repeated tags, long whitespace/digit/slash inputs and valid scientific values retain correct behavior. Connector labels identify their controls.
- **Review:** Kilo's free NVIDIA Nemotron Ultra approved the scheduler correction. Kimi's initial review found the ordering bug below; its follow-ups and a fresh instance produced unusable output, so no follow-up approval is claimed. Claude Opus 5.5 medium independently approved the corrected range and identified an exposure-control accessible-name mismatch, now fixed by letting the visible form label name its trigger. The regression assertion queries the accessible role/name. No SonarCloud findings are dismissed as part of these code changes; runtime unsafe-eval remains a separate evidence gap.
- **Kimi follow-up:** Its first review found a real state-ordering regression: a pre-action refresh failure could prevent a manual schedule action after recording its ownership marker. Manual notifications now occur only on successful tool results and include the schedule id; failed/unexecuted operations leave markers untouched, while a post-success refresh failure retains the existing saved-but-refresh-failed response. Typecheck, lint, 15 focused scheduler tests and full verification pass. Kilo and Opus approve the correction. Opus also noted an older padded-id mismatch and a hypothetical budget-tick race; neither is introduced by this range, and the race was not reproduced.

### 2026-10-09 — Modal reserved-directory transfer correction (PR #51)

- **Category:** Security / cross-platform transfer
- **Summary:** Independent reviews identified an application-state protection bypass on case-insensitive filesystems. A shared reserved-root predicate now rejects mixed case and Win32 trailing-dot/space spellings across path validation, remote discovery and output selection. Native realpath canonicalization checks existing aliases in both input enumeration and output validation.
- **Regression coverage:** Explicit input/output aliases and glob discoveries cannot transfer reserved state; ordinary outputs still install and existing application-state bytes remain unchanged. Existing symlink alias and raw-data guard tests remain enabled.
- **Review:** The same Muse Spark 1.3 Free and Claude Opus 5.5 instances found no surviving bypass or regression in the candidate. Opus reproduced rejection on APFS, checked symlink aliases and confirmed the regression fails against the original implementation. Muse retains earlier caller-validation concerns; Opus traced the current callers and found those concerns do not establish a current exploit. No CodeQL alerts have been dismissed; scanner dispositions and overall PR lifecycle closeout remain separate from this correction.
- **Reconciliation and scanners:** After reading Opus's reports and retracing current callers, Muse retracted its blocking concerns and agreed the current root-escape alerts are false positives. Under conditional user approval, the 32 still-open original alerts and renumbered #402 (formerly #397) were dismissed with guard-specific comments; CodeQL is green. SonarCloud reports 46 findings and fails reliability/security ratings. Its new trailing-trim regex warning is corrected with a linear scan; the other findings remain pending triage, without service-side dismissals.

### 2026-10-08 — Upstream 0.15.0 integration (PR #51, issue #50)

- **Category:** Upstream sync / runtime / security / dependencies
- **Scope:** Merge 44 upstream commits through `44c52cee8e9f` onto fork `c8ed0c0`; the initial Git merge reported 51 conflicting files (24 docs, 18 backend, 5 frontend, 4 root/CI).
- **Resolution:** Adopt upstream product code and native Pi MCP support, while porting inbound MCP, headless identity, deletion, scheduler budget-hold, rate-limit and atomic output-rollback seams. REST and inbound MCP now share upstream's run claim and accounting pipeline; durable terminal snapshots are written before `done`.
- **Gates:** Preserve CI matrices, coverage floors and lint rules. Extract queue/message presentation, Modal wrapper/identity helpers and bounded registration/validation functions rather than raising size or complexity limits. Pin the new setup-uv action to a commit SHA.
- **Dependencies:** Preserve fork direct dependency fixes, adopt exact Pi 1.0.0 / pi-subagents 0.74.0 / pi-web-access 0.35.0 / skills 1.7.0, regenerate lockfiles, apply compatible audit updates and pin undici 8.11.2. A narrow pi-web-access override reuses the patched direct MCP SDK without changing the extension pin. After these updates npm reports no critical findings; backend retains 1 high finding (brace-expansion in Pi’s published shrinkwrap), frontend retains 9 high and 7 low findings (including Next 16.3.7 and developer-tool dependency chains). Broader framework/harness upgrades are outside this sync; no force/downgrade workaround was used.
- **Verification:** Backend/frontend typechecks and lint pass; frontend 928 tests and coverage pass. Production webpack build passes. Backend: 1,888 tests pass (8 intentionally skipped), coverage 82.60% statements / 75.04% branches / 85.69% functions / 85.91% lines. Frontend coverage: 64.88% statements / 58.71% branches / 60.28% functions / 67.18% lines. `npm run verify -- all` passes. Both history secret scans pass, and tracked-path fixture fixes use explicit placeholders. Exact synthetic upstream test key values are allowlisted without exempting files or changing real-key rules.
- **Build environment:** Turbopack fails locally when its CSS worker binds an internal port (`Operation not permitted`), including elevated retries. `npm run build -- --webpack` builds the same application successfully; the default production build passed the Linux and Windows frontend CI jobs.
- **CI follow-up:** The initial Windows backend job exposed a fixed-delay Modal recovery assertion. It now waits for the finalization failure before inspecting the non-terminal job. Failed access-token checks use an independent limiter, and compiler plans resolve engines to executable literals. New non-null assertions now use runtime guards; test fixtures use explicit SDK/structural types, and Office scripts declare the globals supplied by their pinned Emscripten host. Existing scanner rules, hooks and coverage floors remain enabled.
- **Scanner review:** The initial CodeQL summary reported 37 annotations. Inline static triage found effective containment/allowlist controls or test-only JSON responses for 36; failed-auth throttling was retained for review and has now been implemented. Detailed evidence is stored privately through the Codex Security artifact service. No alerts have been dismissed. DeepSource initially reported 258 critical JavaScript findings (undeclared host globals and fixture `any` types) plus 185 major findings; follow-up analysis is required before merge.
- **Follow-up scanner result:** DeepSource JavaScript passes at `d9716b3`, and CodeQL no longer reports missing failed-auth throttling. Its remaining 36 annotations require review. A further narrow follow-up resolves the actual launch command to fixed literals after argv-plan traversal and sets explicit JSON/nosniff headers on the offline meter fixture's error branch; focused compiler/runtime tests, typecheck and lint pass.


### 2026-09-22 — Semgrep answered: one rule, in the lint that already runs (PR #48)

- **Category:** CI / lint
- **Summary:** `dev-docs/todo.md` §1 carried "Semgrep rules for this
  repository's own invariants" as deferred work. Re-examining the candidate
  list left exactly one rule that a static matcher can express, so the answer
  is no Semgrep job and one `no-restricted-syntax` rule in
  `server/eslint.config.mjs`. The todo row is deleted rather than re-deferred:
  the question has now been examined twice and the answer did not change.
- **The rule:** `prepareRun` must not touch the HTTP reply. It returns a typed
  `RunStartRejection`, and that is the only reason the MCP adapter can share
  it — the MCP path has no `reply` to write to. A second run path built
  because this one was unusable headlessly would split run ownership and
  billing.
- **Why a rule at all, when TypeScript already rejects it:** it does, but only
  by accident of the current signature — `reply` is not in scope. The refactor
  this guards is someone threading `reply: FastifyReply` into `prepareRun` and
  then using it, which compiles. The archived Phase 3 plan said that change
  "would pass lint, typecheck and every test while breaking only the MCP
  path"; that sentence is now false by one clause, and has been corrected in
  place.
- **Why not Semgrep:** a second scanner, config, annotation vocabulary and
  version pin for one rule is a bad trade. Two further candidate rules were
  measured and died on the data: `process.env` is read 31 times across 12+
  backend files, so "centralise env access" would be a refactor rather than a
  gate, and there are only 4 `fetch` call sites, too few to justify a rule
  about timeouts.
- **Tested, not just configured:** `server/test/lint-rules.test.ts` lints
  synthetic sources through the real config, so the rule is checked by its
  behaviour rather than by its presence in the file. That includes the cases
  where it must stay *quiet* — a typed rejection, a reply write in a route
  handler, and `FastifyRequest["log"]` — because a rule that fired on those
  would be deleted within a week. Every selector has a mutation that turns a
  test red; the rounds below are the ones where that was not yet true.
- **A fourth review round, on the comments themselves.** kilo stepfun found
  that the config claimed the file threads Fastify types "in eight places". It
  counted seven; the answer is six `FastifyRequest["log"]` threadings plus one
  `FastifyInstance`. All three of us were wrong, so the count is gone rather
  than corrected — a number in a comment is a claim that rots, and this branch
  had already shipped three claims that outran the code. It also found the
  mutation the tests could not see: `PREPARE_RUN_FORMS` lists four shapes and
  only two were exercised, so deleting the class-method and object-property
  entries left the suite green. Covered now.
- **CodeRabbit round.** Two more, both valid. A parameter that binds a reply
  through a destructuring, default or rest pattern and then *forwards* it was
  unguarded: the bare-identifier selector matches only a direct child, and
  with no member access the member selector never saw it. Covered now, with a
  test per binding form. And the type list carried a package-wide
  `TSImportType[argument.value="fastify"]` entry, which turned out to be inert
  — on this AST the module string sits at `argument.literal.value` — but which,
  spelled correctly, would have fired on `FastifyRequest["log"]` and
  `FastifyInstance`, both threaded legitimately through this file. Removed,
  and a negative test now pins the working spelling so a later correction of
  the dead one cannot land the false positive.
- **Revised twice more after review.** Two reviewers independently showed the
  comment overclaimed: `no-explicit-any` catches only the literal `any`, and
  `unknown` plus a structural annotation is a one-word substitute that neither
  it nor `noImplicitAny` sees. A structural type with an innocent name —
  `prepareRun(sink: { code: (n: number) => void })` — is not catchable without
  type information the rule does not have, so the config now says so instead
  of claiming the hatch is closed. What is caught is the honest refactor,
  which is the failure worth spending on. The cheap type forms that *were*
  closeable are closed: an import alias, a qualified `fastify.FastifyReply`,
  and an inline `import("fastify")` type were each three separate AST nodes
  the first version did not know.
- **Two selector halves were mutually masking.** Every test tripped both the
  parameter-name selector and the member-access selector, so deleting either
  half whole left the suite green. Two tests now isolate them: a reply-named
  parameter that is never used, and a module-scope reply with clean
  parameters.
- **The rule is scoped to `src/api/sessions.ts`** rather than leaving the
  function name to do the scoping alone, and a canary test fails if
  `prepareRun` is renamed or moved — losing the guard in silence is the same
  failure class the rule exists to prevent.
- **Scope note, revised after review:** the first version matched member
  access on a variable named `reply`. Greptile pointed out that renaming,
  aliasing, destructuring or forwarding the parameter all still couple
  `prepareRun` to HTTP and all slip past that. Every one of them has to get
  the reply in through the parameter list first, so the guard moved to the
  signature: a parameter named `reply`/`res`/`response`, or anything typed
  `FastifyReply` anywhere inside. The member-access selectors stay for a reply
  reached from module scope. This bullet originally ended by claiming `any`
  was not a way round the rule; the round recorded above found that wrong and
  the clause is struck rather than left to be read.

### 2026-09-22 — MCP server plans archived, CLI entry point recorded (PR #46)

- **Category:** documentation / plan lifecycle
- **Summary:** the last open item on the MCP Phase 3 plan was the CLI reuse
  map — which modules a future CLI would share with the MCP adapter, recorded
  so that whoever builds one extends the core instead of writing a second one.
  It is now in the plan as [CLI reuse
  map](plans/completed/2026-09-06-mcp-server-phase-3-harden.md#cli-reuse-map-2026-09-22).
  With that and the 2026-09-20 fresh-client walkthrough both done, Phase 3 and
  the master plan are archived, and `dev-docs/todo.md` §3 is deleted.
- **What the map says:** `mcp-server/http.ts` is entirely transport and should
  not be reused. `mcp-server/server.ts` is two things in one file — seven tool
  bodies, which are the core, and their MCP registrations, which are
  presentation; a CLI wants the first and needs its own second. The nine
  modules the tool bodies call are listed with what each is used for. Three
  traps are called out: scoping lives in an `AsyncLocalStorage` store rather
  than a parameter, `beginRun` sits in the REST route module and is the one
  place the core reaches into HTTP, and headless sessions disable `interview`
  for a reason that may not apply to a CLI that can prompt.
- **Not decided:** whether to build a CLI at all. Nothing in the MCP work
  needs one. The map exists to keep that question cheap to answer later.
- **Link surgery:** archiving the set moved **two** files — the master plan and
  Phase 3 — and required rewriting cross-links in three more (the phase 1 and
  phase 2 plans, already archived, plus the master's own links), along with the
  `mcp-server-plan` manifest entry. The master plan's own archive note warned
  about exactly this. `docs:check` caught every broken link, one round at a
  time. An earlier version of this entry said four files moved; a reviewer
  counted.

### 2026-09-21 — The frontend gets a max-lines ratchet (PR #45)

- **Category:** CI / lint gates
- **Summary:** `web/` had no file-size limit at all, while `server/` has had a
  self-lowering one since PR #41. The same machinery now serves both:
  `scripts/repo.mjs` carries a `RATCHET_PACKAGES` list, each package has its
  own `.ratchets.json`, and `ratchet:sync` / `ratchet:check` iterate over
  them. `web/.ratchets.json` starts at 2355, pinned exactly at `chat-tab.tsx`,
  with the same floor of 750.
- **Evidence:** wiring proved by moving the cap to 2354, which makes ESLint
  report `File has too many lines (2355). Maximum allowed is 2354` on that
  file, and back to 2355, which passes with 0 errors. `ratchet:check` reports
  both packages. Server suite green; two mutations checked — dropping `web`
  from the hook's package list, and setting the web cap high — each fail a
  test that names them.
- **The todo's numbers were stale:** it said `file-preview-panel.tsx` at 2238
  was the blocker. That file is 1978 now, and the worst is `chat-tab.tsx` at
  2355.
- **Most of what this caps is upstream's code**, which is the accepted cost
  and the same one the backend already carries — `modal/manager.ts` is
  upstream's and sets the backend cap. A cap never demands a refactor; an
  upstream merge that grows a file past it fails lint until the cap is raised
  or the file is split, and raising it is meant to be a deliberate act.
  `web/eslint.config.mjs` is upstream-owned, so the import and the rule both
  carry `FORK:` markers.
- **Drift guard:** the pre-commit hook lists its packages in POSIX sh and
  cannot import them, so a test asserts its `PACKAGES` line matches
  `ratchetPackageNames()`. A package added to one and not the other would
  leave a recomputed cap unstaged and fail CI on the next push.
- **`ratchet:check` now enforces the cap, not just its freshness.** It only
  ever asked whether the stored cap was stale-high; because the policy is
  `min(cap, max(worst, floor))`, a file *above* the cap leaves `expected`
  equal to `stored`, so the check passed while ESLint would fail. Since
  neither `verify -- server` nor `verify -- web` runs lint, the first sight of
  a violation was CI. The check reports the two failures separately — the
  fixes differ, one being `ratchet:sync` and the other splitting the file —
  and the pre-push hook already ran it, so enforcement arrived there without a
  new hook.
- **Skip patterns are anchored** the way the lint configs' globs are, after a
  muse-spark review found `skipsFile` matching a directory name at any depth.
  A future `web/src/out/foo.ts` would have been linted and unmeasured. Not
  live in either package; fixed while cheap. `node_modules` stays any-depth,
  which is ESLint's own default rather than a config glob.
- **Tests added for the parts that had none:** `ratchetSync`'s write path
  (lowering, never raising, stopping at the floor, and preserving keys it does
  not own), the disk-walk fallback used when the tree is not a git checkout,
  and violation reporting. All five run against scratch repositories, which
  needed an optional `repoRoot` threaded through `ratchetSync`, `ratchetCheck`
  and the file scan — without it a test could only point at this checkout, and
  `ratchetSync` writes.

### 2026-09-21 — Tests can no longer delete the real user directories (PR #44)

- **Category:** test infrastructure / data safety
- **Summary:** Sixty-three backend test files open with
  `fs.rmSync(PROJECTS_ROOT, { recursive: true, force: true })`, and
  `skills-install.test.ts` does the same to `KADY_SKILLS_CACHE_DIR` and two
  directories under `KADY_PI_AGENT_DIR`. That is safe only because
  `server/vitest.config.ts` points all three at the OS temp dir. A vitest run
  that does not load that config gets the production defaults instead, and
  running a test file from the repository root is enough to miss it — there is
  no config there, so vitest uses its own defaults and the `env` block never
  applies. The failure mode is not a red test; it is the user's `projects/`
  directory, sandboxes and venvs included, deleted in a `beforeEach`.
  `src/config.ts` now throws at import when `VITEST` is set and any of the
  three resolves to its production path. The check is on the resolved value
  rather than on whether the variable was set: `env.ts` assigns
  `PI_CODING_AGENT_DIR` the real `~/.kady/pi-agent` when it is unset, so a
  presence check would have accepted that from anything importing `env.ts`
  first. Found by a `nvidia/moonshotai/kimi-k3` review of the first version.
  The comparison is on canonical paths: a symlink whose target is the
  production directory *is* that directory, and comparing strings would admit
  it. `realpathSync` throws on a path that does not exist yet, so both sides
  fall back to lexical resolution there — but only for `ENOENT`, because any
  other failure means the path could not be read and degrading to a string
  comparison would reopen the hole. Raised by CodeRabbit.
- **Overlap, not equality, and against every production path:** a directory
  inside the production tree would be deleted from within, and one containing
  it is worse — a `KADY_PROJECTS_ROOT` of `~/.kady` takes the Pi auth store
  and the skills cache with it. Each variable is checked against all three
  production paths rather than its own, which is what catches that case, since
  `~/.kady` looks nothing like the projects root it stands in for. Raised by a
  `stepfun/step-3.7-flash:free` review.
- **Evidence this already happened:** `projects/` held a project named
  `Observed` (created 2026-09-15T00:19:07Z) containing a session directory
  `obs-1`. Both are fixture names from `test/session-observer.test.ts`. The
  `default` project's `createdAt` is 2026-09-18, later than the stray one,
  which is consistent with the directory having been wiped and rebuilt.
  Reproduced directly: `npx vitest run --root . server/test/<file>` reports
  `VITEST=true` with `KADY_PROJECTS_ROOT` undefined.
- **Verification:** the guard fires from the repository root, naming all three
  real paths, and the suite still passes from `server/`.
  `test/config-guard.test.ts` covers seven cases in child processes, including
  a variable set to the real directory, a projects root pointed at the
  repository's own, a blank value, and an unset `VITEST` — the running
  application — which is left alone. The only test files that delete a path
  not derived from these three build it with `fs.mkdtempSync` under
  `os.tmpdir()`, so nothing reaches real data without importing `config.ts`.
  Server suite 1445 passed / 5 skipped, lint and typecheck clean.
- **The deliberate escape hatch, for the record:** `server/vitest.config.ts`
  honours `VITEST_PROJECTS_ROOT`, `VITEST_PI_AGENT_DIR` and
  `VITEST_SKILLS_CACHE_DIR` — all three, not just the first — and the guard
  accepts whatever they name. Pointing one at real data would still let the
  suite delete it. That takes a `VITEST_`-prefixed variable set on purpose,
  which is a different act from the accident this entry is about.

- **Why the guard is in `src/config.ts` and not a vitest setup file:** a setup
  file is configuration, and configuration not being loaded is the whole
  failure. The check has to live in the module the tests import.

### 2026-09-20 — Real-time waits across the backend suite (PR #42)

- **Category:** CI / test infrastructure
- **Summary:** PR #38 fixed two named files and called the Windows flake
  closed. It was not: the condition is that a Windows runner intermittently
  runs about three times slow, and every wait written as a fixed budget is
  exposed to it, so the flake simply moved. PR #41's run `35515576893` lost 27
  tests across `steer-abort.test.ts` and `session-observer.test.ts` on a
  commit that touched no server runtime code. The two failed differently and
  that distinction drove the fix. `steer-abort` timed out, which a bigger
  budget solves. `session-observer` asserted `running` where it wanted
  `complete` after a flat 250ms sleep, which no budget solves — the test has
  to poll. `server/test/helpers/timing.ts` now holds `waitFor` (polling, on a
  10s ceiling), `quietFor` (a fixed delay, for the negative assertions that
  cannot be polled for) and `WAIT_BUDGET_MS` for blocking calls that take a
  deadline. Every positive assertion behind a sleep in the backend suite now
  polls, and `testTimeout` moved to 30s in `vitest.config.ts`.
- **Evidence:** Server suite 1438 passed / 5 skipped, backend lint and
  typecheck clean, `ratchet:check: ok (cap 1467)`.
- **Why the budgets are generous:** a wait ceiling is a hang detector, not a
  performance target. A satisfied condition returns on the first poll, so only
  a test that was going to fail pays the ceiling. The 5s default bought
  nothing and cost real flakes.
- **Two backlog decisions recorded in the same PR**, both from `dev-docs/todo.md`.
  The subagent context-window gap is **accepted as a documented limitation**
  rather than fixed: `subagent-bridge.ts` pins a child to a model id string and
  the window is resolved in the child's own process, so seeding it is not a
  parameter we already have a slot for, and the over-declaration only bites a
  child pinned to a local model whose loaded window is genuinely small — a case
  where the lead usually fails first. It is now in
  `docs/limitations.md#sub-agents`. Ollama's undocumented
  `details.context_length` **stays the primary source**, with an `/api/show`
  fallback to build for rows that lack it; switching outright would cost a call
  per model against a two-call budget that `test/ollama.test.ts` guards.

- **Removed:** the file-scoped `vi.setConfig({ testTimeout: 20_000 })` in
  `notebook-robustness.test.ts`, whose comment claimed the 5s default was
  right everywhere else. That reading is what kept the scope too narrow the
  first time.

### 2026-09-19 — Windows CI test timeouts fixed (PR #38)

- **Category:** CI / test infrastructure
- **Summary:** Two unrelated test files had been failing intermittently on the
  Windows runners only, both with `Test timed out in 5000ms`, and between them
  had redded #35 twice and #37 once. The job logs gave two different causes.
  `web/src/components/pdf-viewer/pdfjs-integration.test.ts` charged whichever
  test imported `pdfjs-dist` first for loading it — 6311ms on Windows against
  the 5s per-test budget, while the other six tests in the file cost 238ms
  between them; both builds now load once in a `beforeAll`.
  `server/test/notebook-robustness.test.ts` had no single slow operation, just
  a Windows median of 1.1s per test with failures at 5.4s on tests that passed
  in under a second the run before. `DurableModalJobManager.wait` no longer
  polls on a fixed 250ms tick — it races the worker's own promise, which
  settles exactly when the condition `wait` checks becomes true — and the file
  raises `testTimeout` to 20s, file-scoped, for the contention that is left.
- **Evidence:** Windows job logs `35442605790` (frontend, 6311ms import) and
  `105412502215` (backend, per-test durations). Locally the backend file drops
  5.13s → 3.28s and its worst test 684ms → 421ms; no test in the frontend file
  now exceeds 22ms. Full server (1402) and web (728) suites, both typechecks,
  both lints, and `docs:check` pass.
- **Follow-up:** The backend `max-lines` ratchet moved 1468 → 1467 rather than
  up, and `server/eslint.config.mjs` now states that the number only ever moves
  down. Automating that check is recorded in `dev-docs/todo.md` §1.
- **Latent bug found in review:** making `wait` depend on the worker promise
  exposed an ordering the old fixed tick had masked. `schedule()`'s `finally`
  called `runtime.adapter.close()` before `this.active.delete(key)`, so a
  throwing `close()` skipped the delete and the terminal `.catch` swallowed the
  error, leaving a settled promise in `active`. Every race then resolved
  immediately: the wait loop burned its whole budget without yielding to a
  timer, and with no timeout it would have starved the event loop. The delete
  now precedes the close, covered by `settles waiters when adapter cleanup
  throws` in `test/modal-durable.test.ts`. Found by a `codex/gpt-5.6-terra`
  review of PR #38; a second reviewer traced the same chain and missed it.

### 2026-09-19 — Local discovery route contract and adm-zip bump (PR #37)

- **Category:** test infrastructure / security
- **Summary:** Answered the two server-behaviour questions PR #35 left open and
  pinned the result: `server/test/local-discovery-contract.test.ts` runs one
  table of malformed-payload cases against both local model-discovery routes,
  so a rule applied to one provider and not the other fails there rather than
  shipping. Recorded the Ollama (0.33.2) and LM Studio (0.4.23+1) builds the
  context-window work was verified against, giving the undocumented
  `/api/tags` → `details.context_length` field a re-check trigger. Bumped
  `adm-zip` 0.5.18 → 0.6.1 and dropped `@types/adm-zip`.
- **Evidence:** Reverting `system.ts` to `0dc70d0` fails 8 of the 24 contract
  cases, all on the OpenAI-compatible side, while every Ollama case passes.
- **Follow-up:** The routes' background probes have no equivalent contract
  test, and the whitespace-identifier bug lived there too. This entry is
  recorded late, in PR #38: #37 ticked its `dev-docs/todo.md` row "done"
  instead of deleting it and wrote no durable record, which is what
  `docs/development/workflow.md#archive-lifecycle` requires. The row is now
  deleted.

### 2026-09-17 — Plan-close lifecycle clarified (PR #33)

- **Category:** operational
- **Summary:** Made plan completion an explicit same-PR operation: finalize
  status, create at least one durable changelog or maintenance record, archive
  the plan, and remove its active handoff before merge. Clarified that the
  existing changelog and maintenance log are fork-owned; upstream release
  notes are linked rather than duplicated into parallel records. Improved
  subprocess-backed repository tests so CI failures include exit status,
  spawn errors, stdout, and stderr without weakening their assertions.
- **Evidence:** `npm run docs:check` validates completed-plan placement,
  handoff removal, release-record structure, and manifest coverage. Focused
  backend tests (49), lint, and typecheck pass for the diagnostic harness.
- **Follow-up:** None.

### 2026-09-17 — Upstream v0.10.0 merge (PR #31)

- **Category:** operational
- **Summary:** Merged upstream releases v0.9.13 through
  [v0.10.0](https://github.com/K-Dense-AI/k-dense-byok/releases/tag/v0.10.0) while
  preserving the fork's billing, security, Modal, provenance, and session
  overlays. Added the standing fork-overlay policy and triaged all automated
  review findings before merge.
- **Evidence:** Required GitHub checks were green at merge; CodeQL and
  DeepSource passed, and focused regression tests covered the reviewed
  session, follow-up, scheduler, Modal, and path-safety changes.
- **Follow-up:** The completed plan retains the explicitly deferred hardening
  items; the weekly `upstream-sync-check` workflow reports future upstream
  drift through the `upstream-sync` issue label.

This document records ongoing maintenance, security triaging, dependency lifecycle, refactoring, and infrastructure tasks performed on the fork (`kgforais1/k-dense-byok-mcp`).

---

## Log Entries

### 2026-09-14: Fork positioning and upstream-sync automation
- **Branch:** `fork-positioning`
- **Category:** operational / docs / CI
- **Summary:**
  - README title is now `K-Dense BYOK (MCP fork)`; the fork notice no
    longer claims cloning gives "everything upstream provides" — it states
    best-effort merging and links the sync policy. (Upstream is 38 commits
    ahead as of this writing; the actual merge is separate work.)
  - `CONTRIBUTING.md` gained a "Keeping up with upstream" runbook (remote,
    fetch, merge-no-rebase into a sync branch, verify, PR, log).
  - New `upstream-sync-check` workflow (weekly + dispatch, mirrors
    `harness-update-check`): compares upstream `main` against fork `main`
    via the compare API and files/updates/closes a labeled issue. No
    checkout, no third-party actions, minimum permissions.

### 2026-09-14: CodeQL Backlog Clearance (195 → 0 open)
- **Branch:** `codeql-phase2-path-injection` (follows PR #28, which shipped
  the refreshed triage + Phase 1 code fixes)
- **Category:** security / code scanning
- **Summary:**
  - Phase 1 (PR #28): 9 alerts fixed in code (7× `insecure-randomness` →
    crypto ids, 2× `polynomial-redos` → capped slug inputs); 1×
    `incomplete-sanitization` re-triaged to dismiss after bot review proved
    the paired `.env` parser performs no unescaping (escaping would have
    corrupted reloads — reverted).
  - Phase 2: 10-alert path-injection sample trace, all guarded, zero real
    findings; hardened `stageForSkill` with a direct `SKILL_NAME_RE` gate
    (the unmodellable indirect-barrier case) + regression test; dismissed
    all 183 per-alert with barrier evidence (script re-verifies open+rule+
    path per alert; first run caught GitHub's 280-char comment cap).
  - Phase 3: `nosniff` on the session-export download + route test;
    dismissed `reflected-xss` (attachment, non-HTML), `resource-exhaustion`
    (1 MiB clamp, no bypass), `incomplete-sanitization` (parser evidence).
  - End state: **0 open Dependabot, 0 open CodeQL.** New alerts mean
    something again. Reviewed throughout: kimi-k3, kilo stepfun (×4),
    DeepSeek v4 Pro, agy sonnet, Cursor Composer, muse-spark, plus
    Sourcery/Greptile/CodeRabbit bot findings (one real regression caught).
- **Verification:**
  - `npm run verify -- all` green at each step; Aikido scans clean.
  - Live API confirms zero open on both surfaces.

### 2026-09-10: Dependency Alert Clearance and CodeQL Sample Trace
- **PR:** [#24](https://github.com/kgforais1/k-dense-byok-mcp/pull/24) (triage plan: [#23](https://github.com/kgforais1/k-dense-byok-mcp/pull/23))
- **Category:** security / dependency
- **Summary:**
  - `npm audit fix` in `server/` (10 vulnerable packages → 1) and `web/`
    (29 → 7), lockfile-only, no `package.json` edits and no major versions.
  - `next` 16.2.11 → 16.3.4 with `eslint-config-next` in lockstep, both
    keeping their exact pins. This cleared the repo's only two critical
    alerts (CVE-2026-75604 / GHSA-2xp9-vwfh-vxw4) and the `postcss` and
    `sharp` highs, which `npm audit` reported as fixable only through `next`.
    Took 16.3.4 over the advisory's first-patched 16.3.3: same patch line,
    and what npm resolves to.
  - Raised the vitest floor to 4.1.11 in **both** packages. In `web/`,
    `vitest` and `@vitest/coverage-v8` depend on each other and each held the
    other at 4.1.4 inside a range that permitted 4.1.11; `npm update` was a
    no-op and an explicit install was needed. `server/` had already resolved
    to 4.1.11, but its declared range was still `^4.1.4` — inside
    CVE-2026-84373's `>=2.1.0 <4.1.11` — so a fresh resolution could have
    reintroduced it. Raising the floor closes that.
  - Dismissed both `adm-zip` alerts as `not_used` with call-site evidence.
    The property relied on is that nothing in `src/` ever hands adm-zip bytes
    it did not just produce (`server/src/agent/notebook-zip.ts`). That is
    stronger than "we do not extract", and deliberately so: only
    GHSA-vwc7-r8mq-g2x9 is extraction-only, while GHSA-xcpc-8h2w-3j85's 4 GB
    allocation also fires on `readFile`, `readAsText` and `getData`.
    CVE-2026-76845 has no fixed release at all, 0.6.0 being inside its range. An expiry note
    now sits in `notebook-zip.ts` so the reasoning is revisited if an extract
    path is added.
  - Closed stale Dependabot PRs #5 and #6 (open since 2026-09-02, overlapping,
    missing the `next` critical, and #6 carried a `@hono/node-server` major
    where 1.19.15 was the patch).
  - Folded `pdf-annotations-store.ts`'s private `isWithin` into the exported
    one in `sandbox-fs.ts` — one containment barrier instead of two.
- **Verification:**
  - `server`: typecheck, 785 tests, lint.
  - `web`: typecheck, 541 tests, `next build`, lint with 0 errors.
  - Alert count 49 → 8 open, all remaining ones read and accounted for.
- **Follow-ups:**
  - `pdfjs-dist` v5 → v6 is deliberately not in this pass; it needs the PDF
    viewer exercised by hand, and `pdf-viewer.tsx:61` carries a polyfill
    documented as required for 5.6+ that must be re-checked against v6.
  - The 183 `js/path-injection` CodeQL alerts remain open by design. A
    five-alert hand trace found all five guarded, but also found more barrier
    idioms than expected and one **indirect** barrier
    (`skills-install.ts:464`, guarded only because `findSkillDir` returns
    `null` and callers 404 on it) that no sanitizer-style model can express.
    Recorded in the triage plan.

---

### 2026-09-05: Closing Checklist Belongs in the Implementing PR
- **PR:** [#13](https://github.com/kgforais1/k-dense-byok-mcp/pull/13)
- **Category:** operational
- **Summary:**
  - Rewrote the archive-lifecycle flow in `docs/development/workflow.md`,
    `CONTRIBUTING.md`, the PR template, the plan template, and this
    log's procedures section so the closing checklist (plan archive,
    handoff removal, CHANGELOG `Unreleased` entry, maintenance log
    entry, TODO row deletion) ships **in the implementing PR** instead
    of as a follow-up after merge. The old text explicitly said "only
    after the implementing PR merges" and contradicted the PR template
    it was supposed to back.
  - Cleaned up the prior PR #11's trailing state: archived the
    `2026-09-03-repo-agent-harness` plan to `dev-docs/plans/completed/`,
    deleted (not checked off) the "Add repo harness" TODO row, fixed
    the manifest and `workflow.md` link targets so `docs:check` is
    green on the next branch, and replaced the section body with a
    short shipped pointer so the `## 1. Repo harness` anchor still
    resolves for downstream links.
  - `CHANGELOG.md` already covered the harness under `[Unreleased]`
    in PR #11, so no new entry is needed in this PR.
- **Evidence:**
  - `npm run verify -- fast` — green (manifest validates, no uncommitted
    manifest changes, hub aliases present).
  - `npm run verify -- docs` — green (`docs:check` passes pointer
    check, `handoff:check` clean, `release:check` clean, manifest
    category coverage 8/8).
- **Follow-up:** None — the new rule is the workflow going forward.
  PR #12 (the old-shape follow-up) was closed in favour of this PR
  so the rule and its first application land together.

### 2026-09-03: CI Hardening & Frontend Quality Pipeline
- **PR:** [#8](https://github.com/kgforais1/k-dense-byok-mcp/pull/8)
- **Category:** CI/CD & Testing
- **Summary:**
  - Added top-level least-privilege `permissions: { contents: read }` to `.github/workflows/tests.yml`.
  - Added workflow-level `concurrency` cancellation (`cancel-in-progress` only on PRs so `main` pushes complete).
  - Added `timeout-minutes: 15` to all matrix jobs (`backend`, `frontend`, `launcher-smoke`).
  - Added full frontend verification gates: `typecheck` (`tsc --noEmit`), `lint` (`next lint`), `build` (`next build`), and `.next` failure artifact capture.
  - Added Map upsert polyfill and PDF worker URL unit test suite (`pdf-viewer-init.test.tsx`) with strict mock isolation.
  - Added `IntersectionObserverStub` in `web/vitest.setup.ts` supporting constructor options, element tracking, and `trigger()` simulation.
  - Aligned React 19 compiler ESLint rules to `warn` to unblock CI while preserving diagnostic visibility.
- **Verification:**
  - Backend vitest suite: 70 files (604 passed).
  - Frontend vitest suite: 77 files (528 passed).
  - Next.js 16 Turbopack production build: 0 errors.
  - Multi-model peer reviews completed by MiniMax M3 Free, Muse Spark 1.2 Free, Claude Sonnet 4.5, and Claude Sonnet 5.

### 2026-09-02: Security Quick Wins & Rate Limiting
- **PR:** [#7](https://github.com/kgforais1/k-dense-byok-mcp/pull/7)
- **Category:** Security & Dependabot
- **Summary:**
  - Added `@fastify/rate-limit` for sandbox API routes to protect local server endpoints against unbounded loops.
  - Added `.github/dependabot.yml` configuration for automated weekly dependency updates across `server/` and `web/`.
- **Verification:**
  - Backend and frontend test suites passed.

### 2026-09-02: Safe Dependency Updates
- **PR:** [#4](https://github.com/kgforais1/k-dense-byok-mcp/pull/4)
- **Category:** Dependencies
- **Summary:**
  - Triaged and applied minor and patch updates for non-breaking server and frontend dependencies.
- **Verification:**
  - Full test suite verified clean.

### 2026-09-02: Fork Safeguards & Architecture Documentation
- **PR:** [#3](https://github.com/kgforais1/k-dense-byok-mcp/pull/3)
- **Category:** Governance & Documentation
- **Summary:**
  - Configured `.githooks/pre-push` to enforce the fork boundary (`kgforais1/k-dense-byok-mcp`).
  - Updated `AGENTS.md` and repository guidelines to prevent accidental pushes or PRs targeting upstream.
- **Verification:**
  - Pre-push hook tested on non-fork and fork targets.

---

## Maintenance Procedures & Guidelines

1. **Semantic Versioning (SemVer):**
   - Version bumps follow `MAJOR.MINOR.PATCH` in `server/package.json`.
   - `web/package.json` deliberately does not carry a separate version; `web/next.config.ts` reads `server/package.json` version at build time.
   - Tagging `v<version>` triggers `.github/workflows/release.yml` to generate release notes and publish a GitHub release.
2. **Implementation Plan Lifecycle:**
   - Active plans live in `dev-docs/plans/<YYYY-MM-DD>-<plan-title>.md`.
   - The implementing PR moves the plan to `dev-docs/plans/completed/`
     and updates its Status to `Completed and merged in PR #<this PR>`
     as part of the PR's closing checklist — never as a follow-up after
     merge. See `docs/development/workflow.md#archive-lifecycle`.
3. **TODO Lifecycle:**
   - `dev-docs/todo.md` only contains unstarted or in-progress work.
   - When a TODO entry ships, the implementing PR **deletes** the row
     (not check it off). A checked-off box is a bug — the entry has
     shipped, so it no longer belongs on the roadmap.
4. **Changelog & Maintenance Logging:**
   - User-facing and structural additions/changes should be recorded under
     `## [Unreleased]` in `CHANGELOG.md` in the implementing PR.
   - Internal refactoring, security triage, dependency maintenance, and
     CI adjustments should be logged in `dev-docs/maintenance-log.md` in
     the implementing PR.
