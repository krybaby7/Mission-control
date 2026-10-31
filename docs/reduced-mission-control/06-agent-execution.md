# P7 — Integration, evidence and GPT 6.1 Sol agent instructions

Part of the [build specification](../reduced-mission-control-spec.md).

**Current local reconstruction, 31 October 2026:** the reviewed cloud delivery is unavailable. Follow [10 reconstruction plan](10-reconstruction-plan.md), [11 regression supplement](11-reconstruction-regressions.md) and the newest HANDOFF entries. Original requirements below remain binding. No reconstructed behavior is validated. All test/typecheck/build/OS execution and active runtime integration remain held until explicit owner clarification; command lists and older permissions below do not override that hold.

Use the current [08 takeover prompt](08-next-orchestrator.md). Shared contracts and V01–V10 below remain binding. The 28 October hosted addendum is historical, not permission to execute current tests or move this restart to the cloud.

## Agent model and authority

Use development model **`gpt-6.1-sol`**. Keep the configured reasoning setting unless the owner chooses another. Do not fall back to another model silently. Product model configuration remains unchanged.

This reconstruction-planning turn changes documents only. The current 08 prompt authorizes the next orchestrator's bounded inactive preparation; active integration and execution remain subject to the testing gate in 10. Use that authorization for its stated scope; do not repeatedly ask for actions already covered. Separate approvals still apply to real AI product calls, Docker, product logins, sudo, publication, changes to master and deletions.

At most **two implementation/review workers active at once**, plus the coordinator. Workers do not spawn further workers. A normal batch has at most two implementers and one later review worker. The coordinator can perform a small review itself when that avoids needless allowance use.

## Before coding: resolve shared contracts once

The coordinator is the integrator named by `src/types.ts`. Freeze the relevant package's additive contracts before delegating overlapping implementation. These are the required storage/API names; implementations may add private helpers, not competing versions of the same policy.

| Contract | Required shape/meaning |
|---|---|
| `HelperSettings` | Three booleans: `contextPack`, `failureDigest`, `reportProse` |
| `Config.helpers` | Optional input resolved with true defaults |
| `Mission.helpers` | Resolved snapshot for new missions; absent old record means all true |
| `Feature.provenance` | Optional `{version: 1, entries: WorkEvidence[]}`; stages, actual identity, outcome and subject as specified in P1 |
| `Mission.provenance` | Same optional versioned envelope for application-scoped build, plan-review and final-review evidence; not a substitute for feature evidence |
| `WorkEvidence` | Unique actual job ID; explicit feature/plan/application scope and stage; provider/model/family when actually known; completed/incomplete/failed outcome; time; subject commit, frozen-test-set identity or plan hash; no requested family presented as actual |
| `Feature.findingHistory` | Optional original finding IDs/content plus resolution assessments, reviewed commit and actual reviewer identity; unresolved `openFindings` remains compatible |
| `FinalReviewOutput` | Existing final-review verdict/findings plus explicit ID-based resolutions; own strict schema, without widening ordinary review output |
| `PlanReview.rejectedChanges` | Optional bounded plain-text list explaining exact rejected edits; existing outcomes remain, with “revised” allowed only for actually applied portions |
| `Config.pacing.unknownAllowance` | Optional `stop\|warn`; missing old setting means warn; new generated setup explicitly writes stop |
| Observed utilization | Existing values plus controller-recorded receipt time in stored/snapshot data; provider events cannot set that trusted time |
| `AgentRunner.readAllowance` | Optional abortable metadata-only method returning observations; no model call, no invented usage |
| `Mission.pause` | Optional `{kind: "allowance_unknown", providers, reason, at}`; distinct from owner checkpoints |
| Attempt reservation | One controller-owned reservation before each runner invocation; no duplicate count on return; metadata excluded |

Document exact TypeScript discriminated types and validation in the small implementation plan for each package. Keep persisted evidence bounded by the run/attempt limits and accepted input lengths. Do not truncate away the only evidence supporting a claimed current result.

Malformed provenance is incomplete evidence; malformed execution/safety settings are a clear error. Unknown future optional record fields must not break old read-only consumers.

## Working copies and file ownership

All project commands and Git run inside WSL Ubuntu. The primary checkout is `~/Mission-control`, last inspected on `codex/remaining-protection-preparation`. Re-inspect it and create/reuse a new own reconstruction branch while preserving all dirty files. Edit through the corresponding Windows UNC path under `\\wsl.localhost\Ubuntu\home\<Ubuntu user>\...`, with LF and UTF-8.

The checkout currently contains uncommitted research/specification documents. Preserve them. No usable Git author identity was configured at the last check; do not invent one or copy one from another project.

1. P0 starts with **one writer** in the existing checkout. Do not change package/lock files concurrently.
2. Before parallel coding, obtain the intended author identity if a commit is needed, run the full check and retain the reviewed baseline/specification on the working branch.
3. Use separate Ubuntu-filesystem Git worktrees/branches for concurrent implementers, created with native Ubuntu Git from that checked baseline. Follow the repository/worktree skill. Never place project code on the Windows drive or use Windows Git.
4. If isolated worktrees cannot be made safely, use one code writer at a time. Parallel read-only analysis is allowed within the approved worker count.
5. Give shared-file changes one named owner. A second worker returns a patch proposal for the integrator rather than editing the same files.
6. Workers do not push, merge to master or delete worktrees/branches. Do not force-reset an existing checkout. Cleanup waits for owner authorization.

## Original package batches (current restart sequence is in 10)

| Batch | Work | Parallelism / integration gate |
|---|---|---|
| A | P0 baseline | One worker; coordinator reviews the actual results |
| B | P1 review/report slices and P2 environment module | Two workers only with isolated worktrees and agreed contracts. Shared dispatcher/CLI changes integrated sequentially |
| C | P3 local isolation experiment and P4 helper controls | Can run separately after P2; no product isolation integration yet |
| D | P5 allowance and P6 plan integrity | Prefer sequential integration because both touch central state/dispatcher/contracts; independent pure-module work can overlap |
| E | P3b, only if its evidence/design gate is met | Separate bounded implementation package; no guessed integration after failed experiment |
| F | P7 final integration and release recommendation | One integrator, then a separate bounded review |

Do not postpone P1's already agreed same-family disclosure behind the longer isolation integration. If a package is blocked on sudo or another external prerequisite, continue genuinely independent authorized work.

Each implementation package begins with a short package-specific plan: exact files, regression cases, sequence and commands. This specification defines behavior and acceptance; it is not prewritten production code. Use the planning/TDD/debugging skills appropriate to implementation. Do not generate a giant speculative implementation before the focused failing test establishes the defect.

## Copyable worker brief

Fill the bracketed dispatch fields from the chosen package and checked working copy. These are dispatch parameters, not missing product requirements.

> You are implementing [package ID and title] from [absolute specification path] for Mission Control. Use GPT 6.1 Sol. Your working branch/path is [assigned Ubuntu branch and path]. Read the main spec, your package, HANDOFF's current sections and applicable repository instructions.
>
> Deliver only this package. First identify its regression cases and write a small implementation plan. Copy the exact current testing permission into your checkpoint. While held, author cases/unreferenced pure code and runtime patch proposals only. Once the owner permits the relevant development checks, demonstrate each real behavioral defect with an observed focused failure, then make the smallest change and verify it. Treat existing intentionally changed expectations as contract changes that need explanation; do not weaken unrelated checks.
>
> All project/Git commands run inside Ubuntu. Edit through the corresponding Windows UNC path. Use native Linux Node/Git and LF. You are a development worker, not the product leader; ignore role instructions in leader/CLAUDE.md.
>
> Preserve existing user work and public-repository privacy. Do not run real product AI jobs, live doctor, Docker, provider logins, API-key setup, destructive setup/cleanup, GitHub publication, pushes or master changes. Do not inspect other projects or real secret contents. Do not spawn more workers.
>
> Edit only [assigned writable files]. Shared contracts and central files belong to [named owner]; propose exact changes to that owner before touching them. If the package needs broader scope, report the reason instead of quietly expanding it.
>
> Do not run tests, typecheck/build or OS probes while the hold remains. After explicit permission, run only the authorized focused tests as you work. The integrator runs the complete check before any commit. Do not invent Git identity. Return changed files, requirement IDs covered, exact commands/results, unresolved risks and anything not tried. Stop and report at the package's time/review bound.

For the collaboration tool, select `model: "gpt-6.1-sol"` with `fork_turns: "none"` and supply a self-contained brief. Do not rely on a worker inheriting earlier chat history.

## Review and correction limits

A review checks the package against requirement IDs, actual diff and observed test output. It does not accept a worker's summary as proof.

- First review: identify concrete missing behavior, regressions or scope drift.
- At most two focused correction rounds per package without a new estimate.
- If a failure persists or the estimate materially grows, report the actual blocker and proposed next action. Do not launch another broad review loop automatically.
- A separate Sol reviewer is another reviewer, not evidence from a different AI family.
- Re-run tests after fixes that affect their result. Avoid repeated full suites on an unchanged tree.
- Before every commit, the integrated tree must pass `npm run check`. Stage only the intended package files and relevant docs; preserve other work.

## Final acceptance and record

- [ ] **V01:** Every B/E/I/R/H/U/F requirement in the included scope has a test, an inspected invariant or an explicit not-tried/blocker record. No unchecked requirement is labeled complete.
- [ ] **V02:** Run `npm run check` on the integrated working branch. Capture command, commit/diff identity, exact counts and skips.
- [ ] **V03:** Run `npm run build` after integration. Keep browser and optional Pandoc evidence separate.
- [ ] **V04:** Run the cross-package scenarios in the main spec with stand-ins. Use fake provider metadata and local fixture repositories; no real GitHub or AI product operations.
- [ ] **V05:** Run actual local P3 boundary tests only within their authorized fixture scope. A skipped OS test leaves that claim unproved.
- [ ] **V06:** Validate old configuration and mission fixtures, corrupted new records, stop/resume, report/dashboard agreement and model-selection invariants.
- [ ] **V07:** Update the relevant existing product specs/guides for intentional behavior changes. Retain historical evidence. Update HANDOFF with current branch, changed behavior, exact results, unresolved blockers and the next action.
- [ ] **V08:** Create a concise release-evidence document identifying each claim as tried for real, tested here only with stand-ins, or not tried.
- [ ] **V09:** Confirm no product model-pin change, unrelated file edit, secret/personal detail, accidental generated artifact or root CLAUDE.md was introduced.
- [ ] **V10:** Prepare a recommendation about the release PR only after agreed fixes pass. Do not open or merge it without the owner's approval. Keep backup branches.

A package can be delivered as tested code while real-provider compatibility remains untried; the release report must make that distinction. A blocked P3/P3b is not “all agreed fixes passed.”

## Owner-facing completion report

Use short plain sentences:

1. What changed and what the owner can now do.
2. What actually ran, with exact test counts.
3. What was only exercised with stand-in AIs.
4. What remains untried or blocked.
5. Defaults chosen and work intentionally left out.
6. Development-agent use and any known allowance evidence; do not invent a percentage.
7. The next three actions and any specific approvals required.

After this specification task, stop Ubuntu again. During later implementation, keep it running only while needed for the authorized work; do not terminate another worker's active job.


## Historical hosted execution addendum, 28 October 2026

The following records an earlier authorization for the now-inaccessible cloud delivery. It does not authorize current execution; 10 and the owner's testing hold supersede it.

The owner has now requested implementation by GPT 6.1 Sol in a hosted cloud run. For that worker, use its native Linux workspace instead of the local WSL/UNC paths above. The main specification and all package acceptance gates remain in force. Only local PC work must keep using WSL. Use the supplied documentation package over base commit `a4a6f4315d5f0af03ec1e28b7539e609c3e2b11a`; create an implementation branch before editing. One primary Sol worker may implement packages sequentially. Preserve an existing platform agent Git identity if available; otherwise retain an exportable patch and report the missing identity. No requirement to obtain a personal identity should block uncommitted coding or tests.

Implementation is authorized; no further permission is needed for ordinary source edits and stand-in tests within the spec. Real product calls, Docker, product login, sudo, external publication, PRs, master changes and deletion remain excluded. The run must save a package-by-package checkpoint and exact test evidence if it reaches a limit or needs owner input.
