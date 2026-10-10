---
title: "SonarCloud quality gate triage and disposition"
status: accepted
created: 2026-10-10
branch: sync/upstream-2026-10-08
pr: 51
---

# SonarCloud quality gate triage and disposition

**Status:** Accepted

**Goal:** Clear the failing `SonarCloud Code Analysis` check on PR #51 by fixing every
issue that is genuinely fixable in repository code, and resolving the remainder in the
SonarCloud dashboard with a documented, evidence-backed justification.

## Gate state (measured 2026-10-10)

PR #51 check `SonarCloud Code Analysis` is `failure`. Of five gate conditions,
two are in `ERROR`:

| Condition | Actual | Required | Status |
|---|---|---|---|
| `new_reliability_rating` | 4 (D) | ≤ 1 (A) | **ERROR** |
| `new_security_rating` | 4 (D) | ≤ 1 (A) | **ERROR** |
| `new_maintainability_rating` | 1 (A) | ≤ 1 | OK |
| `new_duplicated_lines_density` | 0.8 | ≤ 3 | OK |
| `new_security_hotspots_reviewed` | 100.0 | ≥ 100 | OK |

28 open issues in PR scope — 11 `BUG`, 9 `VULNERABILITY`, 8 `CODE_SMELL`, `effortTotal`
378 min. Project-wide baseline: 42 bugs, 116 code smells, 36 vulnerabilities,
`reliability_rating` 4.0, `security_rating` 5.0.

Sonar rating bands relevant here: `A` = zero findings, `B` = at least one minor,
`C` = at least one major, `D` = at least one critical, `E` = at least one blocker.

**The decisive consequence.** An `A` threshold on new code means *every* new
bug and vulnerability must be gone, not merely reduced:

- **`new_reliability_rating` is achievable with code alone.** All 11 bugs
  (10 × `typescript:S2871`, 1 × `typescript:S5850`) have real code remedies.
- **`new_security_rating` is not.** Even with `unsafe-inline` moved to a code
  remedy, 6 of the 9 vulnerabilities have no repository change that removes
  them: `javascript:S5443` ×3 (the rule cannot see Emscripten MEMFS),
  `Web:S7039` unsafe-eval (engine-dependent, unverified), `typescript:S8479`
  (containment is by design) and `python:S5332` (a namespace constant that
  cannot be avoided without obfuscation). These require dashboard resolutions.

Prior art: `dev-docs/maintenance-log.md` records 18 Sonar quality fixes on
2026-10-09 and notes the gate was still failing afterwards ("SonarCloud remains
blocked on its reliability/security ratings (46 findings)"). The handoff adds
"Runtime unsafe-eval remains unresolved; intentional-behavior findings have not
been dismissed remotely." Nothing has been dismissed, so no existing disposition
needs to be preserved.

## Disposition table

`FP` = mark **False positive** (the rule's premise is wrong).
`WONT` = mark **Won't fix** (real finding, accepted by design).
Both resolve the issue and remove it from the rating metrics; the distinction
matters for honesty, not for the gate.

### Group 1 — fix in code (16 issues, 11 files)

| Rule | Location | Issue key | Change |
|---|---|---|---|
| typescript:S2871 | `server/src/agent/agent-files.ts:258` | `AaEhokRy6Za53JnjS2vx` | Add compare function |
| typescript:S2871 | `server/src/agent/compaction-bridge.ts:198` | `AaEhokJE6Za53JnjS2vj` | Add compare function |
| typescript:S2871 | `server/src/agent/compaction-bridge.ts:199` | `AaEhokJE6Za53JnjS2vk` | Add compare function |
| typescript:S2871 | `server/src/agent/prompts.ts:343` | `AaEhokLM6Za53JnjS2vp` | Add compare function |
| typescript:S2871 | `server/src/agent/verifier-models.ts:146` | `AaEhokOp6Za53JnjS2vt` | Add compare function |
| typescript:S2871 | `server/src/agent/verifier-models.ts:146` | `AaEhokOp6Za53JnjS2vu` | Add compare function |
| typescript:S2871 | `server/src/agent/verifier-models.ts:161` | `AaEhokOp6Za53JnjS2vv` | Add compare function |
| typescript:S2871 | `server/src/agent/verifier-models.ts:169` | `AaEhokOp6Za53JnjS2vw` | Add compare function |
| typescript:S2871 | `web/src/components/connectors-panel.tsx:631` | `AaEhoj6l6Za53JnjS2vS` | Add compare function |
| typescript:S2871 | `web/src/components/lab-notebook-view.tsx:144` | `AaEhojxZ6Za53JnjS2vR` | Add compare function |
| typescript:S5850 | `web/src/components/latex/log-panel.tsx:9` | `AaEhojtK6Za53JnjS2vP` | Group the regex |
| typescript:S7773 | `server/src/index.ts:268` | `AaEhokYZ6Za53JnjS2v3` | `parseInt` → `Number.parseInt` |
| javascript:S7773 | `start.mjs:46` | `AaEhokdc6Za53JnjS2v7` | `parseInt` → `Number.parseInt` |
| typescript:S7773 | `web/src/components/office-toolbar.tsx:51` | `AaEhoj6v6Za53JnjS2vW` | `parseInt` → `Number.parseInt` |
| typescript:S7773 | `web/src/lib/office-render.ts:38` | `AaEhoj-C6Za53JnjS2va` | `parseFloat` → `Number.parseFloat` |
| typescript:S6853 | `web/src/components/connectors-panel.tsx:970` | `AaEhoj6l6Za53JnjS2vT` | Associate the label with its control |

**Why the compare function, and why not `localeCompare`.** Bare `Array.sort()`
orders by UTF-16 code units, which is locale-independent but puts every uppercase
letter ahead of every lowercase one. Verified empirically — the explicit code-unit
comparator below is byte-identical to bare `.sort()` across every shape tested
(lowercase names, mixed case, non-ASCII, surrogate pairs, and `Object.entries`
pair arrays), while `localeCompare` is not:

```
["Session-10","Session-2","a1b2c3"]  code-unit: Session-10, Session-2, a1b2c3
                                    locale:    a1b2c3, Session-10, Session-2   ← differ
["Beta","alpha","Delta"]             code-unit: Beta, Delta, alpha
                                    locale:    alpha, Beta, Delta             ← differ
["zebra","Ähnlich","apple"]          code-unit: apple, zebra, Ähnlich
                                    locale:    Ähnlich, apple, zebra          ← differ
```

`String.localeCompare` — the fix Sonar's message names — is the *wrong* remedy: it
is locale- and ICU-dependent, so it makes ordering *less* deterministic and would
diverge on any mixed-case, non-ASCII or session-id input. Use an explicit
comparator that preserves today's code-unit order exactly.

**Two comparators, because the data shapes differ.** Nine of the ten sites sort
`string[]` and take `(a, b) => (a < b ? -1 : a > b ? 1 : 0)`. The remaining site is
`verifier-models.ts:146`, which sorts `[string, string][]` from `Object.entries()`.
Bare `.sort()` stringifies each tuple before comparing, and JS relational operators
coerce the same way, so behaviour is preserved either way — but `a < b` on a typed
tuple is not valid TypeScript and will not compile. That site must compare the
stringifications explicitly, e.g.
`(a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)`, or map
the entries to strings first. Its sorted value is used only for equality comparison,
never persisted, so a canonical stringification is sufficient.

**A caveat on framing, recorded after review.** Bare `.sort()` is deterministic and
locale-independent, and at these sites that determinism is deliberate — so this is
best described as scanner compliance plus latent-risk removal, not repair of a
present bug. Every seeded roster, template and verifier name shipped today is
lowercase (`LEGACY_SEEDED_TEMPLATES`, `LEGACY_SEEDED_ROSTER`), and
`lab-notebook-view.tsx:144` only builds a `useMemo` dependency key, where order
affects cache invalidation and not correctness. The one site with a genuine product
concern is `connectors-panel.tsx:631`, which orders user-visible MCP connector
names that *can* be mixed case — and the fix there is the explicit code-unit
comparator, not `localeCompare`, unless the product decides it wants
natural-language ordering as a separate UX change.

### Group 2 — fix in code, hardens a real surface (3 issues)

| Rule | Location | Issue key | Change |
|---|---|---|---|
| pythonsecurity:S8707 | `server/src/helpers/office_helper.py:39` | `AaEhokS86Za53JnjS2v0` | Validate the argv path inside `Package.__init__` |
| githubactions:S8541 | `.github/workflows/tests.yml:47` | `AaEhokcb6Za53JnjS2v6` | Try `uv sync --no-build` |
| Web:S7039 | `web/public/office/runtime.html:3` | `AaEjq_whuTTJwnnNnp3z` | Externalise the inline `<style>` (partial remedy — see below) |

`S8707` is a false positive *as deployed* — `server/src/api/office.ts` is the only
caller and always passes its own `path.join(dir, "input.<kind>")` with `kind`
pinned by `kindOf()` to `docx|pptx|xlsx` — but the helper accepts an arbitrary
`sys.argv[1]` with no containment check, which is a genuine latent weakness. Any
containment check must compare against a **trusted root passed in from the caller**:
asserting against the file's own parent is tautological, and asserting against the
OS temp directory does not prove the API created it. Pass the API-created temp root
separately and compare canonical paths component-aware (`os.path.commonpath`),
covering Windows behaviour. If that proves awkward, resolve as FP on the caller
boundary instead — an underspecified containment check is worse than no check.

**`Web:S7039` (unsafe-inline, key `AaEjq_whuTTJwnnNnp3z`) has only a *partial* code
remedy, and the obvious fix would break the Office editor.** Externalising the
inline `<style>` block in `web/public/office/runtime.html:3` into a linked
`web/public/office/runtime.css` and setting `style-src 'self'` is genuinely
possible — nothing in `AGENTS.md` or `web/AGENTS.md` requires those rules to be
inline, and they are static layout for the canvas. **But `'unsafe-inline'` cannot
simply be deleted.** The runtime reveals the document by setting a style attribute
from JavaScript — `canvas.style.visibility = 'visible'` at
`web/public/office/runtime.js:61`, against a `visibility:hidden` default in that
same stylesheet — and a script-set style attribute is governed by `style-src`.
Dropping `unsafe-inline` therefore leaves the canvas permanently hidden and breaks
Office editing entirely. The behaviour-preserving form is
`style-src 'self'; style-src-attr 'unsafe-inline'`, plus the externalised
stylesheet. Whether that silences `Web:S7039` or merely relocates it to
`style-src-attr` is **unverified**. Treat this as Group 2 *only* behind a mandatory
Writer/Calc/Impress open-edit-save browser smoke test; if the test fails or the
finding persists, revert this row to a Group 3 `Won't fix` and record the exact
violation as the justification.

`S8541` is one line, but `--no-build` changes dependency installation behaviour.
Land it only if CI still installs the scientific test dependencies; otherwise
resolve as WONT — the lock is `--frozen` from the repo's own
`server/src/helpers/uv.lock` on a pinned toolchain, which is not the threat the
rule describes.

### Group 3 — dashboard only, no code remedy (6 issues)

| Rule | Location | Issue key | Resolution | Evidence |
|---|---|---|---|---|
| javascript:S5443 | `web/public/office/runtime.js:41` | `AaEhokDT6Za53JnjS2vb` | FP | `/tmp/office` is Emscripten **MEMFS** inside the WASM sandbox, not the OS temp dir. `FS` is a `/* global FS */` virtual filesystem supplied by the pinned loader, with no application-level NODEFS or host mount. |
| javascript:S5443 | `web/public/office/runtime.js:42` | `AaEhokDT6Za53JnjS2vc` | FP | Same. |
| javascript:S5443 | `web/public/office/runtime.js:65` | `AaEhokDT6Za53JnjS2vd` | FP | Same. |
| Web:S7039 | `web/public/office/runtime.html:3` | `AaEjq_whuTTJwnnNnp3y` | WONT (evidence gap) | `wasm-unsafe-eval` is explained by WebAssembly compilation, but generic `'unsafe-eval'` is **not yet proven necessary**. Do not assert "required" until removing only `'unsafe-eval'` has been tested across Writer, Calc and Impress open/edit/save; if it fails, record the exact violation as the justification. The handoff and maintenance log both still call this an unresolved evidence gap. |
| typescript:S8479 | `web/src/lib/office-render.ts:7` | `AaEhoj-C6Za53JnjS2vZ` | FP | `ADD_TAGS: ["style"]` is required for DOCX inline styles, and the output is mounted in `<iframe sandbox="" srcDoc={…}>` (`web/src/components/viewers/office-viewer.tsx:68`) — fully sandboxed, no scripts, no same-origin — under a `default-src 'none'` CSP. Not a DOM-XSS vector. |
| python:S5332 | `server/src/helpers/office_helper.py:63` | `AaEhokS86Za53JnjS2vz` | FP | The flagged `http://` string is an **XML namespace identifier**, never fetched. Parser is built with `no_network=True, load_dtd=False, resolve_entities=False`. No code change avoids this without obfuscating the namespace constant. |

### Group 4 — dashboard, rule premise true and the behaviour intended (2 issues)

| Rule | Location | Issue key | Resolution | Evidence |
|---|---|---|---|---|
| javascript:S2310 | `web/public/office/zeta.js:573` | `AaEhokDo6Za53JnjS2vh` | WONT | The rule is *loop counters should not be assigned within the loop body*, and the premise is **true**: the inner rest-parameter loop `for (; j + 1 < arguments.length; ++j)` deliberately advances the outer parameter counter while consuming remaining arguments. That is intentional, not a defect, and the file is a pinned upstream snapshot that must not be edited. Not a false positive. |
| typescript:S9379 | `web/src/components/delegate-picker.tsx:98` | `AaEhoj736Za53JnjS2vX` | WONT | `autoFocus` is gated behind a prop defaulting to `false` (`delegate-picker.tsx:32`), but the only caller (`add-context-menu.tsx:281`) passes it unconditionally inside a Radix `Popover`, alongside three sibling pickers that do the same. Auto-focusing a search input in an open popover is the correct pattern. |

### Group 5 — dashboard, rule premise false (1 issue)

| Rule | Location | Issue key | Resolution | Evidence |
|---|---|---|---|---|
| typescript:S6845 | `web/src/components/latex/latex-editor.tsx:995` | `AaEhojuP6Za53JnjS2vQ` | FP | The element **is** interactive: `role="separator"` with `aria-orientation`, `aria-valuenow/min/max`, a real `onKeyDown` handling ArrowLeft/ArrowRight, and an `onMouseDown` drag handler. `tabIndex={0}` is required for keyboard operation, so the rule's premise — that `tabIndex` appears on a non-interactive element — is false. |

## Investigation history

Three independent passes over the same tree informed this plan. Recording them
matters because two of them overturned the plan's original positions, and a future
reader needs to know which claims are still contested.

1. **This session**, reading the API data and the flagged source directly.
2. **`agy/gemini-3.8-flash-high`**, read-only, briefed with the same API data.
3. **`kiro/gpt-5.6-sol`**, read-only, reviewing an earlier draft of this plan.
   It found the plan's issue keys and aggregate arithmetic sound (all 28 table
   rows matched, 11/9/8 counts and 378 min confirmed) and overturned several
   dispositions — including two of this session's own errors, one of which was a
   **fabricated element inside an example presented as empirical evidence**
   (a four-item output for a three-item input) and one **invented API field**
   (`inNewCodePeriod`, which the API does not return). Both are corrected here.

### Where the three investigations diverged

**`typescript:S2871` ×10.** The plan originally called these a real bug and the agy
agent called them false positives. On review, the plan's bug claim was **wrong** and
agy's instinct was closer to correct: bare `.sort()` is deterministic and
locale-independent, and that determinism is intended at these sites, so there is no
present defect. The surviving position is that they are cheaply code-fixable for
scanner compliance and latent-risk removal — `connectors-panel.tsx:631` being the
one site with a genuine product concern, since it orders user-visible connector
names that can be mixed case. This still matters because they are 10 of the 11
issues that determine the failing `new_reliability_rating`.

**`typescript:S9379`.** The plan keeps **WONT** and the third review agreed: the
behaviour is real (the only caller always enables it) and intended, so `FP` would
assert something untrue.

**`javascript:S2310`.** Both earlier passes misread the flagged symbol — the plan as
a dead-store misfire on `arg`, the agy agent likewise. The raw message is
`Remove this assignment of "j"` at offset 51–52, and the rule targets loop-counter
mutation. The correct disposition is **WONT** on intentional rest-argument
consumption, which supersedes both.

**`typescript:S6845`.** Originally WONT in the plan, which contradicted this plan's
own definitions (a false premise calls for FP). Corrected to **FP**.

**`Web:S7039` unsafe-inline.** The original plan said "no code remedy". The third
review identified a real partial remedy, and this session then found the limit of
it: `runtime.js:61` sets `canvas.style.visibility` from script, so `unsafe-inline`
is load-bearing for that mutation even after the stylesheet is externalised. See
Group 2.

## Implementation sequence

1. **Land Group 1 as one PR** (16 issues, 11 files). All mechanical and
   behaviour-preserving. Must use the explicit code-unit comparator, never
   `localeCompare`, and must use the tuple-safe comparator at
   `verifier-models.ts:146`.
2. **Land Group 2 as one PR** (3 issues, 3 files), independently verifiable: the
   helper's actual exit-code behaviour (0/1/5 — see Verification), a full CI
   dependency install, and a mandatory Office browser smoke test for the
   stylesheet change.
3. **Verify the reliability rating empirically.** After Group 1 merges, confirm
   `new_reliability_rating` reaches A on a fresh analysis. This is the first
   empirical test of the assumption that resolving all bugs in new code yields A.
4. **File Group 3, 4 and 5 resolutions in the dashboard**. This step is
   **not yet approved and must not be executed** — the user's standing
   instruction is that nothing is marked in the SonarCloud dashboard yet.
   A `SONAR_CLOUD_TOKEN` is now available in the repository's `.env` (gitignored;
   never log or commit its value). Until it is supplied to a shell, every
   resolution below is a proposal only.
5. **Re-verify the security rating.** Expect the trajectory D → C → B → A as each
   severity band clears; if it does not clear after all nine vulnerabilities are
   resolved, investigate why rather than adding more dispositions.

## Guardrails

**Group 1 and 2 edits need `// FORK:` markers or a seam.** These are in-place
edits to upstream-owned files — all 13 Group 1/2 files exist in `upstream/main` —
and `CONTRIBUTING.md#keeping-up-with-upstream` requires that an unavoidable
in-place edit be isolated behind a seam or a `// FORK:`-marked block with a
one-line why, precisely so the next merge can see what is ours. An earlier draft
of this plan claimed the opposite; that was wrong. Prefer a named seam or option
over an inline marker where one exists.

Never edit `web/public/office/zeta.js`, `runtime.js` or `runtime.html` to satisfy a
scanner. All three are upstream-owned files carrying only narrow fork annotations —
`git show upstream/main:<path>` succeeds for each, with diffs of 3–5 lines — not
fork-authored originals. Changing them to dodge a rule is both fragile and a silent
divergence from the pinned asset. The new `web/public/office/runtime.css` proposed
in Group 2 would be a fork-created file and needs no marker; the corresponding
`runtime.html` edit does.

Do not switch any `.sort()` to `localeCompare` without a site-specific product
decision, and do not collapse the code-unit comparator into a shorter form that
changes ordering.

No dashboard action is taken as part of a code PR — dispositions are a separate,
user-approved step. **Nothing in this plan authorizes a dashboard change**: all
Group 3, 4 and 5 rows are proposals pending explicit user approval, and the
`SONAR_CLOUD_TOKEN` in `.env` is gitignored and must never be logged or committed.

## Verification gates

| Outcome | Evidence |
|---|---|
| Group 1 correct and behaviour-preserving | `npm run verify -- server` and `npm run verify -- web` pass. Existing suites cover several consumers of the sorted values (`server/test/{verifier-models,prompts-api,backend,agent-memory,notebook-subagent-bridge,mcp-headless-sessions,models}.test.ts` plus the compaction-bridge, connectors-panel and log-panel suites), but they do **not** establish mixed-case/non-ASCII equivalence or tuple stringification at every site — add explicit comparator assertions rather than assuming coverage |
| Group 1 silent-order regression check | Assert persisted `.kady` marker ordering is byte-identical before and after (the comparator must be a no-op ordering-wise, so a golden-file or snapshot comparison is sufficient) |
| Group 2 helper safe | `office_helper.py` actually exits **0 on success and 5 on validation errors**; missing files and missing imports are uncaught and exit 1, with `api/office.ts` detecting `No module named` for its 503. Do not claim a 0/3/4/5 contract — 0/3/4/5 is the *generic* sci-helpers dispatcher contract, not this helper's |
| Group 2 `uv sync` | `--no-build` still installs the scientific test dependencies on both CI platforms. If it cannot, that proves build execution is *required*, not that the finding is a false positive — the disposition is then WONT, not FP |
| Group 2 Office smoke test | Writer, Calc and Impress each open, edit and save, and the canvas becomes visible (`runtime.js:61` must still be able to set the style attribute) |
| Metrics actually move | Fresh SonarCloud analysis shows `new_reliability_rating` down after Group 1 and `new_security_rating` down after Group 3–5 |
| Gate green | PR #51 `SonarCloud Code Analysis` reports `success` |

## Follow-ups (recorded here; not to be lost)

- **The gate is structurally hostile to this repo.** `new_reliability_rating` and
  `new_security_rating` at threshold 1 require an `A` — zero new findings. The user
  cannot raise the threshold on the SonarCloud free plan, so the only lever is
  per-issue disposition. Every future upstream sync that introduces new code will
  hit the same wall. If this recurs, the realistic options are to exclude the
  vendored `web/public/office/**` snapshot from analysis or to gate on
  `new_bugs`/`new_vulnerabilities` counts instead of ratings.
- **The PR new-code window is unverified, not mismatched.** The API response does
  not include `inNewCodePeriod`, so no claim can be made about whether these 28
  issues sit inside the PR's new-code period. An earlier draft of this plan
  asserted they all reported `false`; that field is simply absent. Resolve this
  empirically — after the first code fix, check whether the rating actually moves —
  before adding further dispositions.
- **42 bugs / 36 vulnerabilities / 116 code smells are still open project-wide.**
  This plan clears only the 28 in PR #51's scope. Nothing here reduces the overall
  `reliability_rating` 4.0 / `security_rating` 5.0 baseline.
- **Refresh the active handoff.** `dev-docs/handoffs/active/sync-upstream-2026-10-08.md`
  still phrases the 46-finding count as current and still describes runtime
  unsafe-eval as an open evidence gap, both of which are now stale (46 → 28 after
  the 2026-10-09 fixes). Update it in the same PR that lands the Group 1 code
  changes. Note that `AGENTS.md` itself does *not* describe these as evidence gaps
  — that wording lives in the handoff — so update the right file.
- **The `style-src-attr` remedy is untested against Sonar.** If externalising the
  stylesheet relocates rather than clears `Web:S7039`, record that outcome here so
  the next attempt starts from a measured result rather than a guess.
