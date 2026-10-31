# Reduced Mission Control: build specification

28 October 2026: original specification. **Current authority, 31 October 2026:** the owner chose local reconstruction because the reviewed cloud source/evidence cannot be retrieved. Follow the [reconstruction plan](reduced-mission-control/10-reconstruction-plan.md), [regression supplement](reduced-mission-control/11-reconstruction-regressions.md), [new-chat prompt](reduced-mission-control/08-next-orchestrator.md) and newest [HANDOFF](HANDOFF.md) entries. Reconstruct missing P1/P2/P4/P5/P6 behavior on the surviving engine; do not wait for cloud recovery. All requirements below remain binding. Historical cloud passes do not validate local reconstruction.

**Testing hold remains:** inspection, inactive modules/fixtures/test authoring and source review are allowed. Tests, typecheck/build, OS probes, active runtime integration and protection activation await explicit owner clarification. Command/TDD instructions below are conditional on that permission.

**Goal:** reduce avoidable AI work while retaining Mission Control's useful checks, owner decisions and recovery. Strengthen access controls and make reports say exactly what evidence exists.

This specification turns the [keep/simplify/replace list](keep-simplify-replace.md) into bounded work packages. It follows [HANDOFF sections 10–13](HANDOFF.md) and the [research reconciliation](research-reconciliation.md). Existing product specs still apply except where a requirement below explicitly changes them.

## What the owner will get

- A choice to omit three optional helper jobs, without removing small models or required checks.
- Clear disclosure when work was built, tested or reviewed by the same AI family.
- A smaller, explicit set of settings passed to worker processes.
- A tested proposal for keeping worker processes away from other projects, protected tests and approval records.
- Honest treatment of missing allowance readings.
- The remaining report and plan-integrity fixes already listed in the handoff.

**Small models remain.** The product's light tier stays configured as Claude Haiku 5.5. Light mechanical work can still start there and escalate through the existing ladder. Enabled optional helpers still use the light role. No product model IDs, versions, profiles or pricing assumptions change in this work.

**Development agents:** use `gpt-6.1-sol` (GPT 6.1 Sol), as requested. This is separate from the models the finished product uses. Do not silently substitute another development model. No agents were launched to write this spec.

## Decisions written into this design

1. **Keep the current engine.** No full harness replacement, new database or general workflow framework.
2. **Keep required reviews.** The owner's option A applies: disclose same-family checking; do not pause a feature solely because another family is unavailable.
3. **Make helper reduction explicit.** A documented reduced configuration disables context suggestions, failure summaries and AI-written report prose. Existing configuration behavior and old missions remain compatible. Turning helpers off does not turn tests or reviews off.
4. **Keep plan reuse.** A supplied plan continues to skip duplicate initial planning. Its review and selected owner stops remain.
5. **Use safe allowance defaults for new setup.** Newly generated setup settings explicitly select strict stopping on unknown allowance. Existing settings that omit the new policy retain warning behavior. Neither mode claims to reserve an exact share of the account.
6. **No paid probe.** Strict mode may stop before Claude's first job if no usable reading is available. It must explain this rather than launch a model merely to discover allowance.
7. **Prove isolation first.** An experiment is capped at 4–8 active hours. Product integration is conditional on a viable mechanism, a written result and a reviewed integration design.
8. **Preserve existing work.** No branch/file deletion, destructive setup script, automatic migration of saved missions or change to master.

Items 3, 5 and the detailed report/plan rules below are proposed behavior. They are not already implemented.

## Work packages and estimates

Times are active engineering effort, including focused tests and review, not elapsed promises. Parallel agents can shorten elapsed time only where files and dependencies permit it.

| ID | Package | Size / estimate | Confidence | Complete when |
|---|---|---|---|---|
| P0 | [Local baseline and model policy](reduced-mission-control/00-baseline.md) | Small, 1–3 hours | Medium | Browser checks run or the exact dependency blocker is documented; dependency issue is assessed; model assignments stay intact |
| P1 | [Review evidence and truthful reports](reduced-mission-control/01-review-and-reports.md) | Medium, 8–14 hours | Medium | Actual families are recorded; stale findings need explicit resolution; truthful report facts survive mixed work |
| P2 | [Worker environment](reduced-mission-control/02-environment-and-isolation.md) | Medium, 4–8 hours | Medium | Unrelated settings do not reach workers or checks; launch paths are accounted for |
| P3 | [Linux isolation experiment](reduced-mission-control/02-environment-and-isolation.md) | Medium, capped at 4–8 hours | Low–medium | Harmless fixtures demonstrate the boundary, or a precise blocker is reported |
| P3b | Conditional isolation integration | Provisionally 1–3 further days | Low | P3 evidence supports a reviewed integration design; full acceptance matrix passes |
| P4 | [Optional helpers and supplied plans](reduced-mission-control/03-helpers-and-plans.md) | Medium, 4–8 hours | Medium | Disabled helper jobs do not launch; old missions and Haiku's role are preserved |
| P5 | [Unknown allowance](reduced-mission-control/04-allowance.md) | Medium, 8–16 hours | Low–medium | Strict admission happens before model execution; unknown observations remain visible; no paid bootstrap |
| P6 | [Feature boundaries and plan integrity](reduced-mission-control/05-plan-integrity.md) | Medium, 6–12 hours | Medium | All multi-feature briefs stay scoped; supplied checks survive revision; literal plan text is preserved |
| P7 | [Integration, evidence and agent dispatch](reduced-mission-control/06-agent-execution.md) | Small–medium, 2–4 hours after package checks | Medium | Integrated checks/build pass and the handoff describes all remaining untried paths |

These estimates are more conservative than the initial list because they now include old records, restarts, report consistency and allowance bootstrap behavior. The core packages total roughly 5–9 active working days for one worker, with the isolation experiment and conditional integration additional. Re-estimate after the first completed batch. Do not turn this into an open-ended agent loop.

## Architecture and ownership

Retain the existing TypeScript/Node application, official CLI runners, fixed dispatcher, JSON state, work folders, verification and read-only dashboard.

Use small pure modules for new policy and presentation decisions where that keeps the dispatcher from growing. Proposed modules are named in each package. They must solve the named problem; no plugin framework.

The coordinator owns shared contracts and integration. `src/types.ts` already says shared contracts change only through the integrator. Workers propose the necessary changes; only the designated integrator applies them.

| Shared area | Rule |
|---|---|
| `src/types.ts`, `src/config.ts`, `src/state.ts`, `src/schemas.ts` | One integrator owns additive contracts, validation, defaults and migrations |
| `src/dispatcher.ts`, `src/executor.ts`, `src/run.ts` | Serialize edits in the same checkout; use isolated branches if work must overlap |
| `src/report.ts`, `src/checked-by.ts`, dashboard readers | P1 leads wording; later packages integrate through that owner |
| Package/lock files and browser setup | P0 only until baseline work is complete |
| Handoff and this specification | Coordinator only |

A worker may read other files. It must not edit outside its assigned set without first reporting the concrete need to the coordinator.

## Shared compatibility and evidence rules

**C1. Additive records.** Old missions/configurations load. Missing new evidence means unknown, not success. Malformed new safety settings are rejected with a plain explanation; they never silently select permissive behavior.

**C2. Decisions remain authoritative.** Helpers, model fallback, restarts and plan revisions cannot manufacture an owner approval. Existing selected approval stops remain. Isolation must protect the state and event records that give approvals authority, not just one answer file.

**C3. Preserve existing failure meaning.** A missing/failed check, crash, timeout, unknown allowance, provider limit and failed login are distinct. Only actual required evidence can support completion.

**C4. No fabricated independence.** “Another session” is not “another AI family.” Old or incomplete identity records do not prove cross-family review. A later changed result requires relevant new evidence.

**C5. No claim of cheaper work yet.** Fewer helper jobs are a measurable local result. Lower total allowance or better real output requires a later owner-approved real comparison.

**C6. Honest test evidence.** Report the exact passed/skipped/failed counts and commands. A skipped isolation or browser test does not prove its mechanism. Do not remove checks or weaken assertions merely to get a green result.

**C7. Keep the product boundary.** Development agents must not run the product against real AIs, use Docker, log it into providers, set API keys, publish, push to another branch or change master. A fixture with a stand-in runner is allowed; a real provider job is not.

**C8. Record effective behavior.** A report identifies helper settings, allowance policy and relevant evidence used for that result. Resuming must not silently change helper settings or reuse stale review evidence.

## Acceptance scenarios across packages

The package documents contain the detailed scenarios. Integration must also demonstrate:

1. A two-feature stand-in mission with helpers enabled and disabled produces the same required check/review/approval sequence; disabled helpers produce no model jobs.
2. A light mechanical feature still selects the configured light model. Failure advances through the existing escalation ladder.
3. Failover makes the builder and reviewer the same family: the result continues under option A and the report discloses it.
4. A reviewer fix changes the code: the report does not credit a review of an older commit as a review of the new result.
5. An owner stop survives process interruption; no worker can turn a pending answer into approval within the proven P3 boundary.
6. A strict allowance check with missing data makes zero model calls. Valid later data permits a deliberate resume.
7. A mixed code/document mission retains truthful per-feature facts, does not claim documents passed code tests, and closes only findings explicitly reassessed.
8. A supplied plan's tests-mode checks cannot be removed or reworded by its reviewer.
9. A literal backslash followed by n survives plan intake and output. Real newline characters remain real newline characters.
10. Existing mission fixtures still load without invented identities, approvals or allowance freshness.

## Coverage of the agreed list

| Earlier item | Specification coverage |
|---|---|
| Keep official adapters, engine, checks and dashboard (1–3) | Shared rules C1–C8, P0 model invariants and P7 integration scenarios |
| Switch optional helpers (4) | P4 H01–H12 |
| Reuse supplied planning (5) | P4 H13–H15 and P6 F06–F12 |
| Targeted maintenance only (6) | P4 H16 and shared-file ownership |
| Environment filtering (7) | P2 E01–E10 |
| Enforced file protection (8) | P3 I01–I12 and the conditional P3b gate |
| Actual review identity (9) | P1 R01–R09 |
| Unknown allowance (10) | P5 U01–U22 |
| HANDOFF 7.1: work on later features; changed supplied checks | P6 slices A and B |
| HANDOFF 7.1: stale findings; dropped report prose | P1 slices B and C |
| HANDOFF 7.1: literal escape limitation | P6 slice C |
| Release preparation and evidence | P7 V01–V10; no automatic PR, merge or deletion |

## Validation and release limits

Each behavioral fix gets a regression test that fails for the actual defect before the change. Workers run focused checks; the integrator runs `npm run check` before any commit. The final integrated tree also runs `npm run build`. All commands run in Ubuntu on its Linux filesystem.

The last existing local baseline is typecheck passed, **5,639 passed / 15 skipped**. Fourteen skips were missing Chromium; one was missing Pandoc. Counts will change as tests are added; explain the change rather than chasing an old total. No suite was rerun while writing this specification.

No Git author identity is currently configured in Ubuntu. Do not invent one. Obtain the owner's intended identity before committing; uncommitted work may still be reviewed and tested.

A passing local release candidate is **tested here only with stand-in AIs**. It is not evidence of a real Claude/Codex job, real account-limit handling, Docker, publication, phone access or interactive leader permissions. Historical tiny Claude runs remain separate evidence in [real-runs.md](real-runs.md).

No release PR is created automatically. The owner chose to wait for the agreed fixes. A blocked isolation experiment cannot be described as a completed fix; record it and return the release decision to the owner.

## Out of scope

No complete Cezar/OpenHands/Orchestrator migration; no parallel product features; no new remote-control service; no new model router or vector memory; no broad Word/PDF/spreadsheet engine; no server rental; no real benchmark; no destructive cleanup. Research candidates remain references, not installed dependencies.

REA is not needed for these source-code changes. If code is borrowed, pin its source, retain the required notices and record exactly what was adapted. Do not copy a whole framework to obtain one helper.

## Original specification status, 28 October 2026

All package checkboxes originally started unchecked. Only specification documents and the handoff changed in that original request. Later cloud implementation is recorded historically in HANDOFF; its source/evidence are unavailable. Current reconstruction status belongs in [12 evidence ledger](reduced-mission-control/12-reconstruction-evidence.md), not in reused historical test counts.
