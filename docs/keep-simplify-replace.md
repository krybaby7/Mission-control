# Keep, simplify, replace: Mission Control

28 October 2026. Decision list for the owner. **No product changes implemented.**

Reviewed the current code at `a4a6f43` on the development branch, together with the [handoff](HANDOFF.md), [initial research](harness-research.md) and [research reconciliation](research-reconciliation.md).

## Recommendation

Keep Mission Control's existing coordination core. Make its optional AI helpers switchable. Strengthen the controls around private files, approvals and truthful reports. Borrow specific ideas from existing projects before writing those controls.

A wholesale replacement has not earned its migration cost. That is a provisional judgment: no comparison has yet shown Mission Control cheaper or more reliable than a simpler official-tool workflow. Existing work is not a reason to keep a component that loses that comparison.

## Evidence key

- **Tried for real, historical:** the handoff records ten small real Claude runs on a cloud machine. They exposed several faults. They were not repeated here.
- **Tested here only with stand-ins:** the earlier local baseline passed typecheck and 5,639 tests, with 15 skipped. Fourteen browser checks lacked Chromium; one check lacked Pandoc. This does not prove real provider behavior.
- **Not tried:** every proposed change below. This review inspected implementation and test source; it did not rerun the suite or launch a product job. Evidence for existing behavior does not transfer automatically to a replacement.

The file references below explain the recommendations. A reference to an existing test identifies a behavior to preserve, not a new passing result.

## The list

| # | Decision | What to do | Why / cost avoided |
|---|---|---|---|
| 1 | **Keep** the official AI tools and current adapters | Keep Claude Code and Codex as the workers. Retain structured results, timeouts, stop handling and error classification. | These pieces already exist. Replacing them with a full framework would add a migration before solving a demonstrated gap. |
| 2 | **Keep** the single-work-item engine | Keep saved progress, exclusive run ownership, separate work folders, recovery and ordered integration. | Avoid rebuilding coordination that the local suite already exercises. Separate work folders organize changes; they are not a security boundary. |
| 3 | **Keep** verification and owner decisions | Keep command-based checks, test fingerprints, review records, approval stops and truthful completion states. Retain the read-only dashboard. | These are the useful product layer above a plain AI session. Removing them merely to shorten the code would remove the reason to use Mission Control. |
| 4 | **Simplify** optional helper calls | Add a clearly named reduced configuration that can omit context suggestions, failure summaries and AI-written report prose independently. Keep the existing plain report and raw failure details. | This offers a measurable way to reduce calls without removing the builder, checks or required reviews. No such switches exist today. |
| 5 | **Simplify** planning | Prefer the existing supplied-plan route when a usable plan has already been prepared. Keep its plan review and the chosen owner stop. | It already avoids asking the internal planner to write the same plan again. No new planning framework is needed. Preparing the supplied plan can still cost AI allowance. |
| 6 | **Simplify** maintenance only where needed | Extract a repeated verification sequence when a real fix needs it. Preserve the fixed workflow for now. | Avoid a speculative general workflow engine, new database or broad dispatcher rewrite. File length alone does not justify that work. |
| 7 | **Replace** broad inherited settings | Pass workers an explicit, small list of allowed environment settings. Apply the policy to verification commands as well as AI processes. | The existing filter removes billing and routing variables but retains unrelated values, including any unrelated secrets. Adapt Cezar's pattern, with stricter exclusions. |
| 8 | **Replace** prompt-only protection with enforced access limits | Prove Linux restrictions for project files, frozen checks and coordinator state. Hide unrelated Linux and Windows files. Stop if the selected protection cannot start. | Prompt instructions and restoring changed files cannot prevent a read or protect approval records from the same user. Omnigent is a source of controls and test cases to examine. |
| 9 | **Replace** assumed review identity with recorded facts | Record which AI family actually wrote tests, built and reviewed each relevant result. Show same-family or unknown review clearly. | Implements the owner's option A without pausing a feature just because the preferred reviewer is unavailable. Never infer a completed independent review from the requested profile. |
| 10 | **Keep and tighten** allowance handling | Keep observed-limit waiting, backoff and run controls. Make missing or unusable allowance readings explicit; design a conservative unattended-start policy. | Current pacing is useful but is not an exact reservation of account allowance. A reading without any usable reset time does not create a pacing block. |

Keeping an item does not mean freezing it forever. Numbers 1–3 are worth retaining during the comparison because replacing them now has no demonstrated benefit.

## What each change must preserve

### 1–3. Keep the core, with clear limits

Source: [runners](../src/runners/codex.ts), [Claude runner](../src/runners/claude.ts), [executor](../src/executor.ts), [run control](../src/run.ts), [state](../src/state.ts), [Git work](../src/git.ts), [verification](../src/verify.ts), [deliverable checks](../src/checks.ts), [checkpoints](../src/checkpoint.ts), [reports](../src/report.ts) and [dashboard server](../src/dashboard/server.ts).

The Codex worker already reads structured JSON events. [Codex account queries](../src/runners/codex-app-server.ts) already use app-server. Moving every worker call to app-server is optional future work, not a missing prerequisite for structured integration.

Preserve these observable outcomes:

- A failed or missing check cannot become a success merely because an AI says the work is done.
- Stopping, a timeout, a crashed worker, an exhausted retry path and a login failure remain distinct outcomes.
- A restart preserves the pending owner decision and does not silently approve it.
- Earlier features' frozen tests stay protected; the final checks apply to the integrated result.
- Missing evidence and unfinished reviews remain visible in the report.
- The dashboard remains read-only unless a separately designed owner-control route is approved.

Existing regression sources include `dispatcher-safety.test.ts`, `run.test.ts`, `state.test.ts`, `verify.test.ts`, `checkpoint.test.ts`, `dispatcher-checkpoint.test.ts`, `checked-by.test.ts` and `dashboard/readonly.test.ts`, under `src/`. They belong to the existing stand-in evidence, not proof against real crashes or hostile agents.

### 4. Make optional helpers switchable

Source: [dispatcher](../src/dispatcher.ts), functions `scout`, `buildAttempt` and `reportProse`, plus the maker and failure paths; [configuration](../src/config.ts); [prompts](../src/prompts.ts); [report fallback](../src/report.ts).

The relevant call sites use labels beginning `context-` and `digest-`, plus `report-prose`. Helpers already return no result when unavailable or unsuccessful. The builder still receives a file list and failure details; the report has a plain template.

Proposed design: independent switches for those three helpers, with a documented reduced configuration. Preserve existing behavior when settings are absent. Save the selected behavior with a run so that resuming it does not silently change the experiment. This is a design recommendation, not an existing configuration option.

In a straightforward successful two-feature run, this could avoid two context-helper jobs and one report-helper job. That is a source-based estimate of omitted jobs, not a measured saving in tokens, allowance or overall completion time. A weaker context brief could cause extra builder work and cancel the saving.

Local acceptance: disabled helpers launch no jobs; failure details still reach the builder; the report remains complete and honest; required reviews, approval stops and cap/stop handling remain intact. Compare both settings on the same fixtures. Keep the report's false-claim filter; omitting prose in the reduced route is not permission to weaken it elsewhere.

**Size: small–medium. Estimate: 4–8 active hours. Confidence: medium.** Actual quality and allowance savings need a separately approved real comparison.

### 5–6. Reuse planning and resist a framework rewrite

Source: [plan parsing](../src/plan.ts), [dispatcher plan adoption](../src/dispatcher.ts), `specStage`; [supplied-plan tests](../src/dispatcher-plan.test.ts).

The existing test named “adopts the plan with no planner call, has it read once, stops at the plan, and builds it once approved” spells out the behavior. The internal planner may still be called if the reviewer requests revision. Preserve the original plan, visible changes, selected approval stops and final review.

**Supplied-plan route: small, 1–2 hours to document and select for a future comparison; high confidence.** It needs no new engine. The interactive leader route remains untried here.

**Shared-code extraction: defer as a separate project.** If an agreed fix touches duplicated run/commit/check logic, budget roughly 2–4 hours for a narrowly scoped extraction and its regression checks; medium confidence. Preserve recovery and ordering. Do not add configurable graphs, a plugin system or parallel features.

### 7. Replace broad environment inheritance

Source: [process environment filtering](../src/util/process.ts), `scrubEnv`, and its [tests](../src/util/process.test.ts); both worker runners and [verification](../src/verify.ts) use it.

The test explicitly expects unrelated settings to remain. That establishes why another list of known secret names is insufficient: a newly named secret would still pass through.

Candidate donor: Cezar 0.16.3, MIT, pinned in [the first research report](harness-research.md). Borrow the positive-list structure and test ideas. Its list allows some provider/GitHub credentials, so copying it unchanged would violate this project's intended separation.

Start with the smallest settings needed for native Linux tools, temporary files and the intended official-CLI login location. Handle dependency installation and any future publication as separate permissions. Do not pass developer GitHub credentials to builders. No API keys may be introduced.

Local acceptance: synthetic unrelated secrets disappear; required basic tools still start; environment-routing tricks cannot select an API account; logging does not reveal removed values. Reading files on disk remains a separate problem addressed by item 8.

**Size: medium. Estimate: 4–8 active hours. Confidence: medium.** Official login compatibility remains untried until separately authorized.

### 8. Prove enforced access before adopting it

Source: [Codex sandbox selection](../src/runners/codex.ts), `readOnlySandbox` and `probeReadOnlySandbox`; [checkpoint records](../src/checkpoint.ts); [HANDOFF security limits](HANDOFF.md).

When write jobs already use full access, the current Codex path can fall back to full access for read-only work after a failed protection probe, then restore changes in its work folder. The `noTools` path has a separate read-only choice. Neither the fallback nor ordinary same-user file permissions establish protection for coordinator state or unrelated files.

Candidate donor: [Omnigent 0.20.0](research-reconciliation.md), Apache-2.0. Examine its path restrictions, environment separation and symlink tests. Do not import its whole Python framework. Its generic fallback can run without protection; explicitly selected protection must fail closed in Mission Control.

First experiment, using harmless files and ordinary local processes only:

1. Allow edits inside the assigned project, but prevent changes to frozen checks.
2. Hide harmless sentinel files in a separate Linux folder and in a Windows-mounted folder. Do not probe real private files.
3. Prevent worker processes from writing coordinator state, approval records or their authoritative event records.
4. Test symlinks, parent-folder escapes and a missing or failed protection tool.
5. Show how required official-CLI authentication could be exposed narrowly without exposing other projects or developer credentials. Do not claim the CLI's own credentials can be hidden from the CLI that needs them.
6. Identify the required network access and test any proposed restrictions locally. Do not describe unrestricted outbound access as a complete security solution.

No Docker, sudo install or real login is part of this authorized review. Any necessary system installation needs approval. A protected approval file alone is not enough if the worker can still change the state or event record that gives it authority.

**Experiment: medium, capped at 4–8 active hours; low–medium confidence.** If no viable boundary is demonstrated, report the specific blocker before extending the work. **Integration: provisionally 1–3 further days**, to be re-estimated after the experiment. Stand-ins cannot establish real CLI compatibility.

### 9. Record who actually did the work

Source: [executor](../src/executor.ts), `ExecResult.family`; [dispatcher](../src/dispatcher.ts), `exec`, `runTestAuthor`, `review`, `rubricCheck` and `recordChecked`; [feature types](../src/types.ts); [report wording](../src/checked-by.ts).

The executor returns the actual family. The successful builder is recorded. The tests-mode review path returns findings without retaining that family on the feature; the test-author path likewise does not retain a dedicated identity record. The rubric path already records the family for a usable answer. An unfinished rubric result must not be mistaken for a completed review by its requested family.

Retain actual outcomes for each relevant round, including a reviewer fix that changes the builder. Record test authorship separately from review; one does not prove the other. A switched builder can also match the earlier test author without reviewer failover.

Local acceptance: use stand-ins to force provider failover, builder changes, failed/unfinished reviews, single-family profiles and old records with no identity. The report must disclose same-family checking and say unknown where evidence is absent. It must not pause solely because another family is unavailable: the owner chose A.

**Size: medium. Estimate: 3–6 active hours. Confidence: medium.** No new real AI run is needed for the implementation checks.

### 10. Keep allowance handling, expose its uncertainty

Source: [quota](../src/quota.ts), `providerBlocks`, `pacingBlock` and the per-run share calculation; [quota tests](../src/quota.test.ts); [executor](../src/executor.ts); [account queries](../src/runners/codex-app-server.ts).

The existing test “does not pace on a reading with no reset time at all” expects a fully used reading to leave the provider available. A missing reset can inherit a previously known valid reset, which is a different case. An actual limit response also has its own waiting logic. Preserve those distinctions.

Recommend an explicit “allowance unknown” state. Before future unattended use, require usable readings for a claimed reserve, or a separately agreed tightly bounded override. Do not silently equate missing readings with available allowance. The reserve still cannot be exact while other sessions consume the same account.

Local acceptance should cover missing, stale and malformed observations, valid inherited resets, retry attempts, restarts and simultaneous outside consumption represented by changed readings. Existing controls remain in place.

**Size: medium. Estimate: 4–8 active hours for an agreed policy and local checks. Confidence: medium.** Policy detail and real provider observations remain untried.

## What to borrow, and what to leave out

| Source | Use now | Adoption limit |
|---|---|---|
| Cezar | Environment-filter structure and selected recovery test ideas | Adapt narrowly. Its failed local continuation reproduction blocks treating recovery as proven for our needs. |
| Omnigent | Linux access-control and escape-test ideas | Prove the exact mechanism locally first. No whole-framework adoption. |
| Orchestrator | Keep its acknowledged-event/recovery design as a reference if a concrete recovery gap appears | No daemon, database or interface migration now. Its allowance readings are advisory. |
| HAPI | Revisit only if phone control becomes a required feature | No new remote service now. Its AGPL license and privileged access need a deliberate adoption decision. |
| OpenHands / Pi durable | Retain in the comparison notes | No dependency now. Current approval-route and experimental-interface questions remain unresolved. |

Pinned versions, primary-source links and license findings are in the [reconciliation](research-reconciliation.md) and [initial report](harness-research.md). Licenses and notices must be retained for any copied code; no code was copied during this task.

Leave out a new coordinator, parallel feature workers, a learned model router, vector memory, a marketplace, broad Word/PDF/spreadsheet support, custom phone controls, server hosting and a large live benchmark. Some are unbuilt ideas, so “leave out” means do not add them, not delete working features.

REA was not used. These questions concern available source code; inspecting packaged binaries would add work without closing the identified gaps.

## Recommended build order

This is the proposed next sequence, not authorization for product runs or file/branch deletions. Estimates are active effort and overlap with the item estimates above; do not add both sets together.

| Order | Deliverable | Size / estimate | Confidence |
|---|---|---|---|
| 1 | Close the local browser-check prerequisite gap and inspect the affected dependency update. Then implement the already chosen same-family disclosure. | Medium, 4–9 hours total | Medium |
| 2 | Replace broad environment inheritance. Prove the bounded Linux protection experiment before choosing its integration design. | Medium, 1–2 days total for filter and experiment; integration estimated separately | Low–medium |
| 3 | Add optional-helper switches and settle unknown-allowance behavior. Keep both configurations testable. | Medium, 1–2 days | Medium |
| 4 | Finish the existing report, feature-boundary and agreed-check fixes from HANDOFF 7.1. Extract shared code only as those fixes need it. | Medium, 1–3 days | Medium |
| 5 | Run the full local checks and build; update the handoff and owner-facing limitations. Prepare the release recommendation. | Small, 1–2 hours | High |

The report-summary word-filter fault remains in the existing route even if prose is disabled in the reduced route. A review note should close only with evidence it was resolved, not merely because a later feature exists. Keep the literal backslash-n limitation visible until a compatible fix is established.

No server rental, paid API access or product AI calls are required for these local development steps. They do use development effort and this chat's allowance; a percentage cannot be estimated reliably. Extra workers, real trials, Docker and outward GitHub actions retain the owner's approval rules.

After local controls pass, propose a small real comparison against plain official-tool use, with the same tasks and explicit allowance limits. Measure useful completed output, failed checks, elapsed time, allowance and owner rescue work. If the reduced layer does not justify itself, replace or retire the losing pieces. No such comparison is authorized now.

## Record of this review

Source and test definitions were inspected inside Ubuntu. Only this decision document, the research cross-reference and the handoff changed. No production code, dependencies or provider pins changed. No tests, product jobs, extra research workers, Docker operations, product API calls, provider logins, GitHub writes, commits or deletions were performed during this review.

The existing baseline remains 5,639 passing / 15 skipped. Documentation checks are recorded separately in HANDOFF section 13. The closing action is to stop Ubuntu again; confirm its state before later work.
