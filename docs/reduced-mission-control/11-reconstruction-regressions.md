# Reconstruction supplement: retained review and recovery lessons

31 October 2026. Behavioral requirements for the local reconstruction. No new test evidence is claimed.

The exact cloud patch, its 17 added regression tests and raw review report are unavailable. HANDOFF's 29 October account preserves the defects below. These requirements recover intended behavior, not the lost implementation bytes. Read with P1/P5/P6 and [10 reconstruction plan](10-reconstruction-plan.md).

## Evidence contract to freeze before implementation

Use 06's additive versioned Feature.provenance and Mission.provenance envelopes. A subject explicitly identifies feature/plan/application scope and the exact commit, frozen-test-set identity or plan hash it concerns. Validate discriminants, required nonempty identities and scope/subject consistency before deriving credit. Invalid evidence remains incomplete; it never establishes independence or review completion.

Represent retained contributions as a bounded set of actual invocation records. A final successful call cannot erase earlier retained writes. Missing actual identities remain unknown. Test authorship relates to the retained frozen set and may be incomplete; an authorship gap cannot be filled using requested models.

Before any writing invocation, durably record its pending scope/attempt identity. Conservatively keep uncertainty until the controller has evidence of accepted, reverted or retained work. Persist accepted evidence and removal of its pending marker in one mission-state save. During interruption recovery, first durably save uncertainty, then clear the interruption marker. Failure while saving or cleaning up must leave a recoverable marker or uncertainty record.

P5 reservations and P1 pending-write evidence share one controller-owned invocation lifecycle. No runner may start before its reservation/pending intent is saved. Metadata-only work is excluded from model reservations and cannot create builder/reviewer identity. The integrator chooses exact private types/callbacks and documents write ordering before workers implement them.

## RC01: identities from retained executor retries

Requirements: R01–R07, U19–U21, ISO17.
Files: src/executor.ts, dispatcher.ts, provenance.ts, types.ts, state.ts; executor/dispatcher/provenance tests.

Author cases where:
- A first runner writes retained content and then fails; a second provider completes the job.
- A later reviewer shares the first writer's family but not the final writer's.
- A failed attempt is explicitly reverted, contrasted with failure whose retained-write state is unknown.

Expected: retain the first actual writer when its work survives; disclose overlap with any retained family. Explicitly reverted contributions do not count as current builders. Unknown retention/identity prevents a claim of independence. Do not infer that every failed invocation wrote nothing.

## RC02: incomplete retained test authorship

Requirements: R02/R04/R06/R09, ISO17.
Files: test-author/amend-test dispatcher paths, provenance interpretation and state tests.

Author an interrupted or partially identified test-author attempt whose tests survive into the accepted frozen set, followed by a different successful author. Expected: known authors remain recorded, the unresolved portion stays unknown, and the final author's identity does not replace all retained authorship. A rewritten set may supersede only the evidence for checks actually replaced.

## RC03: repaired-feature disclosure on every surface

Requirements: R03/R05–R09, V06, ISO18.
Files: provenance.ts, checked-by.ts, report.ts, cli.ts and affected dashboard readers/tests.

Author a retained repair that changes the effective contributor set, then inspect CLI details, report and dashboard model outputs. Expected: all use the same interpretation and show the repaired result's evidence. Review of the earlier commit is stale. Another Sol session is not another AI family.

## RC04: malformed evidence subjects cannot earn credit

Requirements: R02/R05/R07/R09, C1/C4, V06.
Files: provenance validation, types/state boundaries and focused reader tests.

Author missing/empty subject values, wrong scope/subject pairing, wrong current commit/test-set/plan identity, unsupported optional envelope version and incomplete outcomes. Expected: no completed/current review credit or independence claim from malformed/inapplicable evidence. Preserve compatible loading and safe unknown wording; malformed execution settings remain explicit errors rather than permissive defaults.

## RC05: finding resolution cannot invent actual reviewer identity

Requirements: R10–R16, C4, V06.
Files: finding-resolution.ts, final-review schema and dispatcher finalReview/gateC; report/dashboard readers.

Author a resolution with requested family present but actual identity missing; include unknown IDs, duplicates, omissions, empty evidence, stale integration head and failed current verification. Expected: record uncertainty without substituting requested identity. Accept closure only under the original P1 current-subject/evidence/verification rules. Duplicate assessments close nothing for that ID. New findings and unresolved older findings remain visible.

## RC06: document maker receives multi-feature scope

Requirements: F01–F05, H07/H11, ISO17.
Files: src/prompts.ts makePrompt/otherFeaturesSection; dispatcher mode paths; prompts-r6/real-run-fixes/mode fixtures.

Author all-tests, mixed and all-review multi-feature missions plus a one-feature control. Expected: test author, engineer and document maker are restricted to the current feature where applicable; shared contracts are not permission to implement later features. Overlap remains a warning, not automatic deletion or undo. Helper disabling does not remove the scope brief.

## RC07: scaffold pending writes survive interruption and cleanup errors

Requirements: R02/R03/R07, C2/C3/C4, V06, ISO16/ISO17.
Files: dispatcher init/adoptInitOutput and interruption recovery, state persistence, executor lifecycle and focused regressions.

Author interruptions before launch after intent persistence, during scaffold writes, after child completion before accepted-state save, during cleanup, and after save. Inject save failures with controlled stand-ins. Expected: uncertain ownership remains explicit; no successful review/completion is invented; accepted evidence and its pending-marker removal become durable together. A thrown cleanup step cannot erase evidence or bypass durable uncertainty.

## RC08: recovery persists uncertainty before clearing interruption state

Requirements: C2/C3/C4, R02/R07/R09, U20, V06.
Files: dispatcher/run recovery, state persistence and interruption fixtures.

Author a crash between recovery's uncertainty save and marker clearing, plus failure of that first save. Resume the stand-in mission again. Expected: uncertainty survives or the original pending marker remains available for another recovery; no point leaves unexplained writes presented as fully identified. Existing pending owner approval and durable invocation count survive. Retrying recovery does not duplicate invocation charges.

## Acceptance and review

These eight IDs supplement rather than replace the original 118 B/R/E/I/H/U/F/V requirements, C1–C8, ten combined scenarios, ISO01–ISO20 and T01–T20. The historical 17-case count is not a new test-count target.

While testing is held, author cases and review source/write-order proposals only. Do not claim these cases fail or pass. After explicit permission, use fake runners, fake clocks and confined temporary fixtures, observe meaningful regression failures, integrate minimal changes and record exact results. No real AI/provider calls.

The read-only reviewer must inspect all retry/write/cleanup/recovery exits and the actual new files. A summary saying "provenance fixed" is insufficient. At most two focused correction rounds without a revised estimate.
