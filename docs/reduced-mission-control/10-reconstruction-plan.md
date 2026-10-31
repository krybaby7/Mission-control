# Local reconstruction: implementation plan and current authority

31 October 2026. Original restart plan, preserved below. Later explicit owner permission authorizes local tests/typecheck/build and core integration; see 15-authorized-execution.md and the current register in 12. The specific OS/protection/provider restrictions remain. Historical preparation-state statements below are not current execution status.

> For agentic workers: use the existing package specifications and bounded subagent-driven development when implementation is authorized. The owner's testing hold overrides any skill instruction to run tests or commit. This document is an orchestration plan; each assigned slice gets an exact file/contract plan before code is authored.

**Goal:** reconstruct the unavailable P1/P2/P4/P5/P6 improvements on the surviving Mission Control source, then complete the conditional protection work without replacing the existing engine.

**Architecture:** retain TypeScript/Node, official CLI runners, deterministic dispatcher, JSON persistence, existing checks and read-only dashboard. Add only the small policy/evidence modules needed by the existing requirements. One integrator controls shared contracts and runtime wiring.

**Tech stack:** the existing package/lock files, Node >=22.12, TypeScript, Vitest and Playwright; Bubblewrap is only the candidate for the later synthetic protection experiment.

## 1. Latest owner decision and precedence

The owner said: "Okay, I think we should accept that we have lost it. So we'll have to restart the implementation. So prepare the plan, the specs that we already have, adapt them if we need to adapt anything, and then provide me with a prompt I'll take to a new chat with fresh context to take over as the orchestrator and spawn GPT 6.1 soul agents for implementation."

Use the already agreed exact model ID **gpt-6.1-sol**. "Soul" in that request does not select a different model.

This supersedes the requirement to recover the cloud delivery before coding and the wait-for-support reconstruction pause. It does not establish permanent deletion of the cloud files. Recovery is now optional, not a prerequisite. Do not create/restart a cloud workspace or spend another recovery loop before local preparation.

The current turn prepares documents only. The copyable prompt in [08](08-next-orchestrator.md) authorizes the next orchestrator to begin the bounded preparation below. The owner's separate testing/activation hold remains unchanged.

Precedence: newest explicit owner instructions; newest HANDOFF entries; this restart plan and [11 reconstruction regressions](11-reconstruction-regressions.md); then the original main specification and package requirements. The current [08 prompt](08-next-orchestrator.md) summarizes those rules. Dated cloud authorization, old "core complete" statements and recovery-only blockers do not authorize current tests or prevent reconstruction.

## 2. What survives and what must be rebuilt

Working checkout: /home/adami/Mission-control, inspected branch codex/remaining-protection-preparation. Inspected HEAD: a4a6f4315d5f0af03ec1e28b7539e609c3e2b11a. There are newer uncommitted research/specification documents. Re-inspect these facts at takeover; preserve any later work.

The older engine, dashboard, official adapters and older tests remain. Source inspection found the old denylist environment filter, incomplete executor-retry identity/accounting, whole-prose rejection, mode-only supplied-check preservation and second decoding of parsed strings. These are inspected source findings, not newly executed failures.

Reconstruction scope is the original P0–P7 contract, especially P1/P2/P4/P5/P6, plus the later review lessons in 11. Keep C1–C8 and the main specification's ten combined scenarios. Keep every B/R/E/I/H/U/F/V, ISO and T requirement. Do not rebuild working infrastructure merely to change its architecture.

The following cloud-only files are unavailable inputs, not mandatory reading dependencies:
- docs/research/linux-isolation-result.md
- scripts/dev/linux-isolation-fixture.py
- docs/reduced-mission-control/release-evidence.md
- docs/reduced-mission-control/verification-20261029-review.md

If a needed file is absent, create a newly authored counterpart with its own date and honest status. Never label it recovered or reproduce invented historical logs. If an exact cloud artifact later becomes available, verify the original hashes in 07, compare it in a separate directory and reconcile deliberately; do not overwrite new local work.

## 3. Evidence and execution gates

The historical local baseline was 5,639 passes / 15 skips plus typecheck/build. The inaccessible corrected cloud tree reportedly passed 5,724 / 14 skips. Neither result is a fresh result for reconstruction. Test totals are evidence, not targets to reproduce by removing or adding meaningless cases.

| Gate | Allowed | Still held |
|---|---|---|
| Now and new-chat preparation | Read source/specs; branch and snapshot preservation; source review; author meaningful test cases, new unreferenced pure modules and inactive fixture code; write precise runtime patch proposals; document/hash/format checks | Running tests, typecheck/build, OS probes, provider queries, product execution, active runtime integration or protection selection |
| Owner explicitly allows development checks | Record exact permission; execute only its allowed baseline/stand-in/browser/synthetic cases; integrate reconstructed core slice by slice using observed regressions and focused checks | Real providers, product logins/live doctor, Docker, publication, master changes and deletion remain separately restricted |
| Applicable protection experiment passes and concrete addendum is separately reviewed | Conditional protection integration under 07 D–F and authorized checks | Any unproved host/network profile; real-provider trials and release remain held |

During the testing hold, do not import new policy modules into live entry points, change operational defaults, invoke a test runner "just to collect" tests, or execute a fixture to see whether it starts. Runtime edits can be described as patch proposals in the checkpoint; do not apply their active wiring yet. New tests/modules may be syntactically unverified. Mark them authored/not run, never red/green.

After test permission, preserve a runnable baseline from the recorded source checkpoint before applying active runtime proposals. Use observed before/after regressions where practical. Do not manufacture a historical failing result for a defect already changed. A full check must pass before any commit; do not invent Git identity. No commit is required for a checkpoint.

The ISO acceptance gate is unchanged: actual applicable OS evidence first, reviewed concrete integration design second, production protection wiring third. Pure argument-generation tests do not prove a boundary. Offline success does not approve provider networking.

## 4. Bounded work order, estimates and stop points

Times are active engineering estimates for authoring, focused checking when allowed and review, not elapsed promises. The core range is provisionally **38–74 hours**: five behavioral packages 30–58, preservation/contracts/baseline 4–8, final integration 4–8. Confidence is low–medium because the exact patch/tests are missing. The protection work is additional. Re-estimate after the first source/contract inventory; do not add these ranges to the historical cloud estimates as separate duplicate work.

| Stage | Deliverable and requirements | Estimate / confidence | Gate |
|---|---|---|---|
| R0 Preserve and inventory | Current branch/HEAD/status/refs; verified source/docs checkpoint; B01/B07/V09; new own branch | 1–3 hours, high for inspection | Start now; no baseline execution during hold |
| R1 Contracts and cases | Exact per-slice types, persistence/write ordering, launch inventory and unrun regressions; 06 and 11 | 3–5 hours, medium; includes later P0 baseline work | No active wiring under hold |
| R2 Review/report reconstruction | P1 R01–R22; RC01–RC05, RC07–RC08 | 8–14 hours, medium | Prepare first; integrate only after test permission |
| R3 Environment reconstruction | P2 E01–E10; explicit purpose for every launch | 4–8 hours, medium | Same; does not implement isolation |
| R4 Helper controls | P4 H01–H16; persisted settings and all eight combinations | 4–8 hours, medium | Serialized dispatcher/config integration |
| R5 Allowance/admission | P5 U01–U22; durable per-invocation reservations | 8–16 hours, low–medium | Needs P1 invocation contracts and P2 |
| R6 Plan integrity | P6 F01–F18; RC06 maker scope | 6–12 hours, medium | Needs agreed P4/plan contracts |
| R7 Core integration/evidence | P0 remaining baseline/browser/advisory decisions; P7 V01–V10; all ten combined cases | 4–8 hours, medium | Authorized development checks; V05/V10 remain conditional |
| R8 Protection preparation | 07 B; I/ISO/T inventory, newly authored fixture, inactive policy proposal | 3–6 hours, medium | May prepare under hold; recheck launch inventory after core integration |
| R9 Protection experiment | 07 C; applicable T cases and I01–I12/ISO evidence | Capped at 4–8 active hours, low–medium | Explicit synthetic-test permission |
| R10 Design and conditional integration | 07 D–F; concrete addendum, bounded implementation, full evidence | Design 2–4 hours; integration 1–3 active days; final checks/review 4–8 hours; low–medium | Experiment and addendum gates; no weaker fallback |

Before each stage, explain size, time and confidence in plain words. Divide a delegated slice into a 60–90 minute initial work bound, followed by a checkpoint and report. At most two focused correction rounds per package before a new estimate. A time cap never permits dropping a requirement.

Under the current hold, a useful stopping point is a reviewed set of core contracts/cases, isolated pure modules where appropriate, runtime patch proposals, fixture/policy preparation, requirement ledger and verified backup. Do not accumulate an unreviewed whole-product patch while waiting for test permission.

## 5. Concrete source map and per-package tasks

The following existing functions were inspected as text. Proposed modules are not present in the starting tree. Line numbers may change; use the symbol names and requirement IDs.

### R0–R1: baseline, ownership and contracts

Files: package.json, package-lock.json, src/types.ts, src/config.ts, src/state.ts, src/schemas.ts, src/executor.ts, src/dispatcher.ts, src/run.ts; current docs.

- [ ] Re-read HANDOFF completely, this plan, the main spec, 00–07 and 11; inspect applicable AGENTS.md without reading a root CLAUDE.md.
- [ ] Preserve existing dirty files and refs through the checkpoint procedure below. Create a new own branch from the current preserved checkout; do not reset, re-clone or switch to master. If a suitable new reconstruction branch already contains work, reuse it after inspection.
- [ ] Create/maintain [12 reconstruction evidence](12-reconstruction-evidence.md) with actual status, ownership and source identities.
- [ ] Inventory existing behavior against every included requirement; distinguish already present behavior from gaps. Keep the exact existing model configuration.
- [ ] Freeze one coherent invocation contract used by P1 provenance and P5 reservations. Record job identity, pre-invocation persistence, partial/missing results and crash recovery. The integrator owns exact TypeScript shapes and validation; use 06's required storage/API names.
- [ ] Define the retained-contribution representation, subject validation and pending-write transaction from 11 before dispatching related code.
- [ ] Author baseline/compatibility cases as text/test code only while held. After permission, run the preserved baseline once, record exact skips/errors, then handle P0 dependencies narrowly. Do not run npm install/audit/browser downloads during the preparation phase.

### R2: provenance, findings and truthful report text

Existing execution points: RoleExecutor.exec/run in src/executor.ts; Dispatcher.run, writeTests/runTestAuthor/amendTests, buildAttempt/passBuild/fixFindings, makeAttempt/fixDeliverable, init/adoptInitOutput, rubricCheck/recordChecked, review/finalReview/gateC and keepOpen in src/dispatcher.ts.

Existing consumers: src/checked-by.ts howChecked/checkedWords/checkedLine/ownerSentences; src/report.ts guardProse/reviewNotesSection; src/cli.ts feature details; src/dashboard/modes.ts, missions.ts, debrief.ts, read.ts and types.ts.

Proposed pure modules/tests: src/provenance.ts and provenance.test.ts; src/finding-resolution.ts and finding-resolution.test.ts. Existing regressions to extend: executor, dispatcher, dispatcher-modes, state, checked-by, report, real-run-fixes-r6-flow and affected dashboard tests.

- [ ] Slice A: retain actual identity of every invocation that may contribute writes; retain partial test authorship; derive current review credit from valid current subjects and all retained contributions. Apply option A without adding a cross-family pause.
- [ ] Slice B: implement the exact R10 finding ID, strict final-review resolutions and current-head verification conditions. Unknown/duplicate/missing assessments close nothing.
- [ ] Slice C: replace only checking/approval/guarantee claims using recorded facts; retain unrelated prose and canonical facts once; keep conservative fallback on ambiguous fields.
- [ ] Author each RC01–RC05/RC07–RC08 case in 11 alongside the original P1 matrix. Review pending-write ordering before any runtime integration.
- [ ] After permission only: observe focused regressions, integrate one slice, run its focused checks, inspect report/CLI/dashboard agreement and update evidence.

### R3: positive environment policy

Proposed src/util/child-env.ts and child-env.test.ts. Existing src/util/process.ts scrubEnv/runProcess; direct spawns in runners/claude.ts, codex.ts, codex-app-server.ts; verification in src/verify.ts; browser launch/discovery in src/render.ts; controller paths in src/git.ts, runners/worktree-guard.ts, dispatcher Git helpers, cli.ts and doctor.ts.

- [ ] Record every subprocess/browser entry point and its purpose. Select controller-supplied native PATH, HOME/TMP and selected-provider config inputs. Never use the old denylist as a positive list.
- [ ] Build the environment from an empty object with explicit per-purpose values and validation. Unknown values are absent; errors name settings without exposing their contents.
- [ ] Author fake-child cases for arbitrary secrets, billing/API routes, Git/SSH credentials, injection settings, browser/metadata inheritance, legitimate native tools and failure/stop handling.
- [ ] Keep policy code unreferenced while held. After permission, integrate declared contexts at all launch sites and check each caller.
- [ ] Preserve supervision, prompt stdin, structured outcomes and billing safeguards. Record that this is environment filtering, not file protection.

### R4: helpers and saved configuration

Existing defaultConfig/validateConfig and generated settings in src/config.ts; MissionStore.createMission in src/state.ts; three production creation paths in src/cli.ts; dispatcher buildAttempt/makeAttempt, failBuild, reportProse and specStage. Use the 06 HelperSettings contracts.

- [ ] Resolve omitted helper values to true and reject malformed/unknown values. Save new mission snapshots at every creation path; legacy missions keep all true.
- [ ] Author all eight helper combinations with explicit job-label assertions, required-stage/owner-stop preservation, raw failure information, light-model escalation and restart after global settings change.
- [ ] Keep supplied-plan reuse in specStage and required gate A/final review. Do not introduce duplicate planning.
- [ ] After permission, wire skips through saved mission settings and consistent report facts. Disabled jobs create no model usage or invocation reservation.

### R5: allowance policy, transport and reservation

Proposed src/allowance.ts and allowance.test.ts. Existing quota recordUtilization/pacingBlock/sameReading/save/restore/prune/snapshot; RoleExecutor.exec/run; dispatcher run; CodexRunner.loginRefusal/askAppServer/readUsage; AgentRunner; src/run.ts buildDispatcher/runOne/queue summary; src/dashboard/allowance.ts buildAllowance.

- [ ] Implement the 10-minute controller receipt rule for both aggregate windows; distinguish omitted versus malformed resets and clock rollback. Repeated identical fresh observations update receipt time.
- [ ] Define metadata-only refresh using the existing Codex transport and bounded abort/deadline behavior. No Claude paid bootstrap or undocumented account endpoint.
- [ ] Implement stop/warn compatibility, explicit unknown-allowance pause and optional-helper skip. Keep pending owner approvals unchanged.
- [ ] Persist a single attempt reservation before each actual runner invocation, including retries. Remove the final-result double count; stale dispatcher saves must not overwrite the reservation.
- [ ] Author fake-clock/metadata cases for missing/malformed/stale/expired/future observations, candidate failover, optional work, cap exhaustion, interrupted reservation and restart.
- [ ] After permission, integrate policy and metadata transport with stand-ins only. Do not invoke installed provider/account tools during development.

### R6: scope, immutable supplied checks and literal text

Existing src/prompts.ts otherFeaturesSection/testAuthorPrompt/buildPrompt/makePrompt; dispatcher noteLaterFeatureFiles/reviseSpec/carryModes/keepWrittenChecks/setPlanReview/writeSpec; src/later-files.ts, plan.ts and schemas.ts normalizeSpecText.

- [ ] Apply current-feature scope to test author, engineer and document maker for every multi-feature mission. Keep overlap detection text-only and non-destructive.
- [ ] Reconcile revisions against immutable original PlanSource.spec by feature ID; retain exact check text and order, mode/effort/expectation semantics, valid dependencies and selected owner stops.
- [ ] Record applied, partly rejected and rejected changes accurately. Never rebase the original reference on an accepted AI revision.
- [ ] Preserve parsed strings without a second escape decode. Keep the external grammar/hash and existing accepted records intact.
- [ ] Author explicit tests for all-tests and mixed missions, maker scope, ID/dependency edits, restart, literal backslashes/quotes/newlines and old plans.
- [ ] After permission, explain intentional changes to schemas.test.ts's old normalization expectations; retain historical fixtures and do not weaken unrelated assertions.

### R7–R10: validation and protection

- [ ] Execute the main specification's ten combined scenarios only after authorization, covering helpers, Haiku escalation, same-family evidence, stale review, owner stops, strict admission, mixed reports/findings, supplied checks, literal text and old records.
- [ ] Freeze source/test/config inputs; run npm run check and npm run build with logs and immediate separate exit files. Confirm input hashes before/after; account for later documentation-only changes.
- [ ] Keep missing browser/Pandoc prerequisites and failed/blocked tests explicit. A historical cloud skip is not the current local skip count.
- [ ] R0/R1 replace the old unavailable-delivery recovery prerequisite. The adapted 07 A confirms the local reconstructed-core state; follow 07 B–F for protection preparation, experiment and conditional integration. Author a new isolation fixture when the cloud one is absent; keep its evidence new. Re-inventory the final core launch paths before claiming ISO coverage.
- [ ] Complete applicable I/ISO/T evidence, then write and separately review docs/reduced-mission-control/isolation-integration-design.md. No production isolation recipe is selected in this plan.
- [ ] Produce a bounded release recommendation only after the agreed applicable gates. No PR, push, merge or real trial is authorized.

## 6. Agent dispatch and ownership

Use exactly model gpt-6.1-sol with fork_turns none and a self-contained brief. Do not set a different reasoning effort. If unavailable, report it; do not substitute. At most two workers plus the orchestrator; no recursive agents or independent task creation by workers.

Default to one code writer plus one read-only reviewer. The orchestrator alone owns src/types.ts, config.ts, state.ts, schemas.ts, dispatcher.ts, executor.ts and run.ts, plus all documentation/evidence integration. A worker may propose exact central-file patches but must not apply them. Serialize any transfer of file ownership explicitly.

Suggested worker ownership:
- P1: new provenance/finding-resolution modules and focused tests; reporting/dashboard files only when individually assigned and not being edited by the integrator.
- P2: child-env module/tests and specifically assigned runner/process/verifier/renderer files.
- P4/P5/P6: focused policy/prompt/test slices outside shared files; central changes remain integrator proposals.
- Protection: only explicitly assigned fixture/isolation modules; no default activation.

Each brief must contain: purpose; requirement IDs; current branch/path; exact writable files; forbidden files; existing contracts; cases to author/run; current test permission verbatim; 60–90 minute initial bound; deliverable; stop condition; no recursive delegation. Reviewer briefs require inspecting the actual diff and new files rather than accepting summaries.

Concurrent writers require safe isolated Ubuntu worktrees and a checked common baseline after test permission. Do not use a worktree at HEAD that silently drops the uncommitted specifications. Until those conditions exist, keep one writer.

## 7. Checkpoint and backup procedure

The source of truth is the local Ubuntu checkout. A cloud task, chat transcript or archive path printed in a response is not the only backup.

At R0, each completed authored slice, the testing gate, after authorized validation and final handoff:

- [ ] Create a fresh timestamped directory under /home/adami/mc-reconstruction-checkpoints. Never overwrite or delete an earlier checkpoint.
- [ ] Record base HEAD, branch, Git status and refs. Retain a base Git bundle when needed for a standalone reconstruction; it must not include local Git config or credentials.
- [ ] Inventory tracked and intended untracked files. Save a complete source archive including specs, tests and new modules; save git diff --binary HEAD and a separate untracked-file list. A tracked diff alone is incomplete.
- [ ] Use an explicit reviewed member list. Exclude .git, credentials/local environment files, node_modules, generated build/cache output, unrelated files and fixture data not needed as evidence. Reject absolute/traversal/link escape members. Do not open unrelated secrets to determine exclusions.
- [ ] Save per-file SHA-256 values, archive hashes, current requirement ledger, review dispositions, permission state and the exact stopping point. Evidence logs are included only if actually produced by authorized runs.
- [ ] Inspect archive contents without extracting over the checkout. Compare every archived regular member with the manifest and source bytes. Archive verification is a document/recovery check, not a product test.
- [ ] Keep an owner-accessible second archive copy under this chat's authorized Windows workspace, in a new recovery-backups/<checkpoint-id> folder. This is an export only, not a Windows source checkout. Perform copy/hash operations inside Ubuntu through the mounted path and verify the copied hash. Retain both copies.
- [ ] Report both paths and verification result. Mark unverified or incomplete copies honestly.

The documentation-only preparation created a before-edit archive under /home/adami/mc-reconstruction-checkpoints/20261030T230909Z-before-plan. It preserves the prior versions of all 32 documentation files. Its archive SHA-256 is 8e43df4ca4f3b108c6ae083c1f32998498f53b031ddf0282e48fad5d230163d8. The date component is UTC; the owner-local planning date is 31 October.

## 8. Environment and owner restrictions

Every local project/Git command runs inside WSL Ubuntu. Keep source in its Linux filesystem; edit via \\wsl.localhost\Ubuntu\home\adami\Mission-control using UTF-8/LF. No Windows Git. Do not read/add a root CLAUDE.md; ignore leader/CLAUDE.md's product role.

No real Mission Control AI runs, live doctor, provider metadata/account queries or logins, API-key setup, Docker, publication, push/PR, master changes, deletion or scripts/dev/real-run-setup.sh. No unrelated projects/secrets. Ask before sudo/system installs. Preserve backup branches and existing files. Do not weaken container/bypass guards or spoof platform state. No product-model or Haiku change.

Record inspected code, source review, authored/unrun cases, actual stand-in results, actual synthetic OS observations and real-provider work separately. Stop Ubuntu after the final handoff only when no worker/job needs it. Do not promise a future support reply or automatic cloud recovery.
