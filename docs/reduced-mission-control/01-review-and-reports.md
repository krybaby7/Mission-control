# P1 — Review evidence and truthful reports

Part of the [build specification](../reduced-mission-control-spec.md).

**Current local reconstruction, 31 October 2026:** the reviewed cloud delivery is unavailable. Follow [10 reconstruction plan](10-reconstruction-plan.md), [11 regression supplement](11-reconstruction-regressions.md) and the newest HANDOFF entries. Original requirements below remain binding. No reconstructed behavior is validated. All test/typecheck/build/OS execution and active runtime integration remain held until explicit owner clarification; command lists and older permissions below do not override that hold.

## Outcome

The owner can tell who built, wrote tests and reviewed the delivered work. Findings disappear from the open list only after an explicit reassessment. A mixed code/document report retains useful prose and derives checking claims from recorded facts.

**Owner:** review/report worker, with the coordinator integrating shared contracts. **Estimate:** 8–14 hours, medium confidence. **Dependencies:** P0; shared-contract agreement. Implement in three reviewable slices.

## Files and boundaries

Existing: `src/executor.ts`, `src/dispatcher.ts`, `src/types.ts`, `src/state.ts`, `src/schemas.ts`, `src/prompts.ts`, `src/checked-by.ts`, `src/report.ts`, relevant `src/dashboard/` readers and wording.

Proposed focused modules: `src/provenance.ts` for interpreting identity evidence; `src/finding-resolution.ts` for stable finding IDs and resolution validation. Do not move the whole dispatcher into new files.

Tests: `src/executor.test.ts`, `src/dispatcher.test.ts`, `src/dispatcher-modes.test.ts`, `src/state.test.ts`, `src/checked-by.test.ts`, `src/report.test.ts`, `src/real-run-fixes-r6-flow.test.ts`, plus focused tests for new modules and affected dashboard/publish fixtures.

## Slice A: actual identity, option A

- [ ] **R01:** Carry the executor's actual job ID, provider, model and family into accepted stage evidence. The requested profile is never evidence of who ran.
- [ ] **R02:** Add an optional, versioned provenance record to a feature. Each entry identifies its stage (`test_author`, `build`, `review` or `fix`), actual identity, completion outcome, time and the commit/test set it concerns. Records are append-only audit evidence; derive the current effective record separately.
- [ ] **R03:** A successful retained build/fix updates effective builder evidence. A reverted failure does not replace it. Preserve `builtBy` for existing routing.
- [ ] **R04:** Record tests' actual authors separately. Preserve the relation to the frozen test set; a rewrite does not erase authorship of tests that it retained. If that relation is incomplete, report authorship as partly unknown.
- [ ] **R05:** Record each completed review against the reviewed commit. Incomplete/malformed answers and a requested but unexecuted reviewer never count as completed review. A fix or later mutation invalidates review credit for the changed result until it is checked again.
- [ ] **R06:** Compare the completed review family with the families of retained build/fix contributions to the reviewed result. If any overlap, disclose it. With incomplete history, say that independence could not be established. Do not derive independence by excluding failed calls alone.
- [ ] **R07:** Apply equivalent truthful identity recording to rubric checking and the final whole-app review. Store whole-app records in optional `Mission.provenance`, with the same versioned entry envelope and explicit `plan_review` / `final_review` stages. Retained scaffold build evidence may use its own application scope. Keep plan review separate; it is not a code review. Do not call a final review independent of the whole app when retained builder evidence is incomplete.
- [ ] **R08:** Continue under the owner's option A. No new pause solely because a cross-family reviewer is unavailable. Existing failed-check and incomplete-review outcomes remain.
- [ ] **R09:** Old records without provenance load and display “review identity not recorded” where relevant. Never backfill from configuration. An unfinished `FeatureChecked` record's requested family cannot become successful evidence.

Required owner wording is descriptive, for example: “Built and reviewed by Claude in separate jobs; this was not a review by another AI family.” A single-family profile gets truthful wording without implying its configured behavior is an error.

At a minimum, the CLI/report, feature detail and final report summary agree. The dashboard remains read-only. Reuse one interpretation function rather than separately guessing identities in each surface.

## Slice B: resolve stale findings explicitly

- [ ] **R10:** Give each feature's retained finding a stable SHA-256 ID over the JSON array [originating feature ID, severity, file or null, description, suggested test or null], encoded as UTF-8 without altering the original strings. Identical repeated findings deduplicate. Keep the original text and origin.
- [ ] **R11:** Extend the existing final whole-app review request with the outstanding finding IDs. Use a separate strict final-review output schema containing explicit per-ID outcomes: `resolved`, `open` or `cannot_judge`, and evidence. Ordinary per-feature review output need not change.
- [ ] **R12:** A resolution is accepted only for a known outstanding ID, from a usable completed review of the current integration commit, with nonempty evidence. Duplicate, unknown, missing or malformed assessments do not close anything. Merely making a later file or omitting a finding from a new list does not close it.
- [ ] **R13:** Save accepted resolutions with reviewed commit and actual reviewer identity. Maintain the unresolved set in `openFindings` for existing consumers; retain an audit history of resolved findings.
- [ ] **R14:** Closing a blocking finding also requires the current final verification result to pass. Any subsequent integration change makes that assessment stale; include the finding in the next outstanding assessment set until it is reassessed. Keep the historical resolution, but it cannot support current completion.
- [ ] **R15:** Do not add a separate AI call per old finding. Piggyback on the required final review. A failed or skipped final review leaves unresolved findings visible.
- [ ] **R16:** Reports say that a reviewer reported a concern resolved. This is AI review evidence, not an independent executable proof that an arbitrary concern is fixed.

## Slice C: retain useful prose without trusting its checking claims

- [ ] **R17:** The engine owns sentences about how work was checked. In mixed missions, do not discard the entire narrative and all capability bullets because one sentence contains “tests.”
- [ ] **R18:** Retain unaffected prose. Replace sentences making checking/approval/guarantee claims with the applicable canonical facts generated from mission records. Insert those facts once in the relevant report section, not once for every removed sentence.
- [ ] **R19:** Use the existing conservative claim detector and its regressions as the bounded scope. If sentence segmentation is ambiguous, fall back for the affected field. This is deliberately not an exhaustive natural-language truth classifier. A true AI sentence may be replaced by equivalent recorded facts. A false or ambiguous claim cannot survive merely because another feature has tests.
- [ ] **R20:** Preserve existing protections against false “no record,” false owner approval, unjudged checks, missing pictures and guarantees. Existing safe denials may remain. If all prose is removed, use the existing complete plain report.
- [ ] **R21:** The footnote states the actual action: checking claims were replaced with recorded facts. It must not say the whole summary was unconfirmable when only its checking language was replaced.
- [ ] **R22:** Helper-disabled mode from P4 uses the same deterministic facts and requires no prose job.

## Acceptance matrix

| Case | Expected result |
|---|---|
| Preferred reviewer unavailable; builder family reviews | Work continues; actual same-family disclosure |
| Builder switches family during retained repair | Disclosure uses the repaired result's contributions |
| Test author matches eventual builder | Separate authorship disclosure; not hidden by a different reviewer |
| Invalid review output | No completed-review credit |
| Old mission or damaged new provenance | Unknown/incomplete evidence, never invented independence |
| Review at commit A, result changes to B | A is not credited as B's completed review |
| R7-style missing-file note explicitly resolved at final head | Leaves open count; remains in audit history |
| Later file appears, no explicit assessment | Finding stays open |
| Resolution ID unknown, duplicate or assessment missing | No finding silently closes |
| Review says resolved but final verification fails | Cannot support a completed result |
| Mixed report includes the R7 sentence about tests | Useful prose remains; recorded per-feature checking facts appear |
| Prose says documents passed code tests / owner approved when no answer exists | Claim removed/replaced; no false approval |
| Helpers disabled | Same truthful report facts without a prose call |

## Completion

Write focused failing regressions first. Each slice must pass its focused tests before integration. After all shared-file edits are integrated, run `npm run check`. Check report/dashboard agreement and any publication-text fixtures with stand-ins only. Record all evidence as local stand-in evidence.
