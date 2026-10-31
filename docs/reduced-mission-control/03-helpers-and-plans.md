# P4 — Optional helpers and supplied plans

Part of the [build specification](../reduced-mission-control-spec.md).

**Current local reconstruction, 31 October 2026:** the reviewed cloud delivery is unavailable. Follow [10 reconstruction plan](10-reconstruction-plan.md), [11 regression supplement](11-reconstruction-regressions.md) and the newest HANDOFF entries. Original requirements below remain binding. No reconstructed behavior is validated. All test/typecheck/build/OS execution and active runtime integration remain held until explicit owner clarification; command lists and older permissions below do not override that hold.

## Outcome

A reduced configuration skips optional AI jobs while preserving required work, useful failure details and small-model use. Reuse the existing supplied-plan path rather than inventing a planner.

**Estimate:** 4–8 hours, medium confidence. **Dependencies:** shared contracts, P0; integrate dispatcher changes after its current owner finishes.

## Files

Existing: `src/config.ts`, `src/types.ts`, `src/state.ts`, `src/cli.ts`, `src/dispatcher.ts`, `src/report.ts`, `src/prompts.ts`.

Tests: `src/config.test.ts`, `src/state.test.ts`, `src/cli-plan.test.ts`, `src/dispatcher.test.ts`, `src/dispatcher-plan.test.ts`, `src/dispatcher-safety.test.ts`, `src/report.test.ts` and relevant mode fixtures.

Docs: a short reduced-configuration example in the existing configuration/owner guide, plus the coordinator's handoff update. No new CLI framework.

## Configuration and persistence contract

The proposed configuration section is:

```yaml
helpers:
  contextPack: true
  failureDigest: true
  reportProse: true
```

Each key is a boolean. An omitted section/key resolves to true. Invalid values and unknown keys are reported by the normal config validator, not coerced.

The reduced example explicitly sets all three false. This is independent of Claude/Codex family profiles. Users may enable any subset; no new hidden “cheap model” override.

- [ ] **H01:** Introduce a shared `HelperSettings` type with these three booleans.
- [ ] **H02:** New missions receive a resolved `Mission.helpers` snapshot when created/queued. Update every production mission-creation entry point. The store's test/convenience default is all true.
- [ ] **H03:** Old missions without that snapshot retain all-true behavior, even if the current global config has changed. Do not infer “never started” from a counter that might lag an interrupted job.
- [ ] **H04:** Resume uses the saved settings. This release has no implicit rewrite of queued or active missions. Documentation explains that changed global settings apply to newly created missions.
- [ ] **H05:** A malformed saved snapshot cannot disable required work or silently enable an unintended helper. Refuse the damaged mission with the normal plain diagnostic.
- [ ] **H06:** Report the effective helper settings from the mission record, including the legacy default. Do not read current global config to describe a historical run.

## Execution rules

- [ ] **H07:** Disabled `contextPack` produces no `context-*` job. The builder/maker still gets its normal file list, scope and required brief.
- [ ] **H08:** Disabled `failureDigest` produces no `digest-*` job. The next attempt still receives the raw bounded failure tail, signature, frozen-test problems and diagnosis hints. Do not remove the required diagnosis for a disputed test.
- [ ] **H09:** Disabled `reportProse` produces no prose job. The complete plain report and P1's evidence-based checking facts remain.
- [ ] **H10:** A disabled job consumes no model invocation, usage entry or allowance. It may emit a deterministic “helper disabled” event. A job that was actually attempted is accounted for normally.
- [ ] **H11:** Required planning review, test authorship, building, checking, review, final review and owner stops remain under their existing rules.
- [ ] **H12:** Enabled helpers retain the light role and optional/unavailable fallback behavior. Light mechanical builders still use the configured Haiku role and existing escalation ladder. No product model pin changes.

## Supplied-plan route

- [ ] **H13:** Keep `specStage` adopting an externally supplied plan without a duplicate initial planner call.
- [ ] **H14:** Keep gate A, any required revision handling, selected plan approval and final review. A reviewer-requested revision can still require a planner job.
- [ ] **H15:** Document this route for a future comparison. Do not run the interactive leader, queue a real product job or claim that preparing the external plan costs nothing.
- [ ] **H16:** Shared-code extraction is allowed only for a repeated sequence changed by this package. No configurable workflow graph or speculative primitives layer.

## Acceptance

Run stand-in missions with all eight helper on/off combinations. Assert omitted job labels and retained required work, not a fragile total number that hides which role ran.

Include:

1. A successful two-feature job; all-off avoids its two context jobs and one report job.
2. A failed build followed by repair; raw diagnostics remain with digest off.
3. A disputed test; diagnosis still occurs.
4. A stop during work and resume after global helper settings change; the mission keeps its snapshot.
5. A legacy mission with no snapshot; all helpers remain enabled.
6. Helpers unavailable or malformed output when enabled; existing fallback remains.
7. An owner checkpoint; turning helpers off does not approve or bypass it.
8. Mechanical light work with helpers off; the light builder is still selected and can escalate.
9. A supplied plan; no initial spec job, but gate A and final review remain.
10. A damaged snapshot; explicit error rather than a permissive default.

The local comparison proves job-count differences and required-stage preservation. It does not prove lower total allowance, equal real output quality or real Haiku availability. Do not describe those as established savings.

## Completion

Focused test files pass; integrated `npm run check` passes. No real AI jobs. Return the exact configuration example, persistence behavior, job-label comparison and any changed tests to the coordinator.
