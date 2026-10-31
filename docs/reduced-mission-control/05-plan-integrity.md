# P6 — Feature boundaries and plan integrity

Part of the [build specification](../reduced-mission-control-spec.md).

**Current local reconstruction, 31 October 2026:** the reviewed cloud delivery is unavailable. Follow [10 reconstruction plan](10-reconstruction-plan.md), [11 regression supplement](11-reconstruction-regressions.md) and the newest HANDOFF entries. Original requirements below remain binding. No reconstructed behavior is validated. All test/typecheck/build/OS execution and active runtime integration remain held until explicit owner clarification; command lists and older permissions below do not override that hold.

## Outcome

All multi-feature jobs receive the same scope protection. An externally supplied plan cannot lose its checks through an AI revision. Literal plan text is not silently decoded a second time.

**Estimate:** 6–12 hours, medium confidence. **Dependencies:** P0, P4's supplied-plan contract. Serialize dispatcher/schema edits with P1/P5.

## Files

Existing: `src/prompts.ts`, `src/dispatcher.ts`, `src/later-files.ts`, `src/plan.ts`, `src/schemas.ts`, `src/state.ts`, `src/checked-by.ts`, `src/report.ts`; relevant role prompts if needed.

Tests: `src/prompts-r6.test.ts`, `src/real-run-fixes-r6.test.ts`, `src/real-run-fixes-r6-flow.test.ts`, `src/dispatcher-plan.test.ts`, `src/plan.test.ts`, `src/schemas.test.ts`, `src/report.test.ts` and affected prompt fixtures.

## Slice A: scope every multi-feature mission

- [ ] **F01:** The test-author and builder briefs say to complete only the current feature whenever there is more than one feature. This includes missions where every feature is checked by tests; it must not depend on the presence of a review/owner mode.
- [ ] **F02:** Shared contract text does not automatically authorize building another feature. Explicitly explain this in both roles' briefs.
- [ ] **F03:** Extend the existing later-feature-file warning to all multi-feature missions. Preserve its text-only interpretation: a filename mentioned in a check is not a path that the engine should open or execute.
- [ ] **F04:** Persist and display detected overlap consistently in feature details and the report. Do not automatically delete, undo or reject a legitimate shared file based on a filename heuristic.
- [ ] **F05:** No warning for a single feature merely because a contract contains several filenames. Existing ownership of already completed features' tests remains protected.

This is a prompt and disclosure improvement. It is not a hard filesystem ownership boundary and cannot prove a real AI will never work ahead. State that limitation.

## Slice B: preserve supplied checks

For `mc plan queue`, the stored original `PlanSource.spec` is the reference for the owner's supplied feature IDs and acceptance checks.

- [ ] **F06:** Gate A may request clearer implementation wording, but it may not silently alter the acceptance text of any supplied feature, including tests-mode features.
- [ ] **F07:** Carry original checks byte-for-byte by feature ID, in original order. Preserve existing mode/effort/expectation semantics. Technical wording may change only without weakening those retained requirements.
- [ ] **F08:** A proposed revision that adds/drops/renames supplied feature IDs, invalidates dependencies or cannot be reconciled with the original checks is not applied. Retain the original usable plan and show the exact rejected changes and review concerns.
- [ ] **F09:** Record whether a revision was applied, partly rejected or wholly not applied using an additive extension of the existing plan-review record. Do not label a rejected edit as accepted. The current plan display and approval look explain which checks were retained.
- [ ] **F10:** Preserve selected owner stops. A rejected revision does not forge approval; it also does not introduce an unrelated new approval loop. If the original plan is unusable under existing validation, stop with that actual problem.
- [ ] **F11:** Later resumes do not rebase the reference onto an AI-modified plan. The originally supplied plan remains immutable.
- [ ] **F12:** Internally generated plans keep existing validation and review behavior. Once a plan has actually been approved, subsequent changes remain subject to existing owner-change rules; this package is not permission to rewrite approved checks.

## Slice C: literal text

The current `normalizeSpecText` can reinterpret already parsed backslash escape text. Intent is ambiguous: a JSON string containing two characters backslash+n may describe those characters deliberately.

- [ ] **F13:** Parse JSON once. For new planner responses, preserve the resulting strings literally. Do not heuristically turn backslash+n or backslash+quote into another character.
- [ ] **F14:** A real newline produced by JSON parsing remains a newline. The text `backslash + n` remains those two characters. The external `mc-plan 1` grammar and its plan hash remain unchanged.
- [ ] **F15:** Tell the planner to use normal JSON escaping once. Do not add an extra paid correction call merely because a sentence contains literal escape text.
- [ ] **F16:** Never rewrite persisted accepted plans during load or migration. Update tests that explicitly depended on the old heuristic as an intentional contract correction; retain the historical R3 fixture as a regression demonstrating literal preservation.
- [ ] **F17:** Keep normal display wrapping and control-character safety. Those are presentation rules, not permission to reinterpret the original text.
- [ ] **F18:** Update the owner guide's stated backslash-n limitation to explain the new literal behavior. Historical reports stay unchanged.

Trade-off: a future AI response that mistakenly double-escapes an intended list will display its literal escape text instead of being guessed into a list. This favors preserving requirements over guessing intent.

## Acceptance matrix

| Case | Expected |
|---|---|
| Two tests-mode features | Both test-author and builder briefs restrict work to the current feature |
| Mixed-mode features | Existing scope text and warnings remain |
| First feature creates a later named file | Warning recorded in either kind of multi-feature mission |
| Ambiguous shared file | No automatic destructive action |
| Reviewer rewrites a supplied tests-mode check | Original check retained; rejected edit visible |
| Reviewer drops/adds/renames supplied feature | Revision not applied; original plan and concerns retained |
| Reviewer revises allowed technical wording | Can apply while original checks and valid dependencies remain |
| Restart after revision | Same original reference and same effective checks |
| Existing approved plan | No automatic normalization or migration |
| Literal escape text in code example/regex/path | Round-trips unchanged |
| Real newlines from valid JSON | Remain real newlines |
| R3 double-escaped fixture | Preserved literally; no second decode |
| Quotes, non-ASCII, long lines and control characters | Existing validation/display protections continue |

## Completion

Each slice starts with focused regressions, then integration runs `npm run check`. Report the scope fix as stand-in-tested briefs/disclosure, not proof of real AI obedience. No real plan queue, leader session or provider call is part of validation.
