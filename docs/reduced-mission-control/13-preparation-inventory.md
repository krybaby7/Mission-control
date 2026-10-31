# Local source inventory and bounded preparation

31 October 2026. Historical initial inventory, preserved below. Its initial testing hold and source-gap statements describe the preparation checkpoint only. Current authorization, implementation and executed evidence are in 12 and 15; do not treat the old permission quote as the current hold.

## Starting point and scope

The integrator read HANDOFF, 08, 10, the main reduced specification, 00–07, 11 and 12. Relevant original product contracts and source remain authoritative where the reconstruction does not deliberately change them. The source is `/home/adami/Mission-control`, branch `codex/local-reconstruction-preparation-20261031`, base `a4a6f4315d5f0af03ec1e28b7539e609c3e2b11a`. No applicable AGENTS.md was found in the checkout or its named Linux ancestors. Root CLAUDE.md was not read.

The initial checkpoint is `/home/adami/mc-reconstruction-checkpoints/20261030T235245Z-r0-preserved`. All 514 explicit regular source/document members matched source bytes and their SHA-256 manifest. Git history, original refs, status, tracked patch and the separate untracked list are retained. The Windows export is `C:\Users\adami\projects\Mission control Harness\recovery-backups\20261030T235245Z-r0-preserved`. Source archive SHA-256: `d7a9b954a55a2353178f80e451fe912e6208d3202015a64b931193001b57cbaf`. Both copies were verified. The only subsequent ref change is the new working branch.

Current owner permission, verbatim:

> My testing hold remains. You may inspect, author inactive modules, fixtures and test cases, prepare runtime patch proposals, and perform source review. Do not execute tests, typecheck/build, OS probes, active runtime integration or protection activation until we discuss testing and I explicitly clarify permission.

This batch covers R0 source preservation and inventory, R1 preparation contracts/cases, and a bounded R2 pure evidence interpretation slice if its contract passes source review. It does not complete R1 runtime lifecycle, all P1 slices, R3–R7 reconstruction or R8 fixture implementation. The complete requirements remain open in 12. Do not generate the entire untested product while the execution gate is closed.

Estimates after inspection: retain 38–74 active hours for the full core, low–medium confidence. The retry/persistence coupling makes a narrower estimate unjustified before observed baseline and regression results. Protection remains additional. This batch's delegated author/review work has a 60–90 minute initial bound and at most two focused correction rounds.

## Source findings

These observations were checked by a separate gpt-6.1-sol source worker. They identify code and cases to preserve; they are not test results.

| Requirements | Existing source | Gap / next work |
|---|---|---|
| B01–B06 | package/lock/browser files survive; working branch and dirty files inspected | Native tool/version recheck, baseline, browser and advisory work held; historical results not reused |
| B07–B08 | config defaultConfig, model tables/ladders, runners createRunners | Preserve source bytes and later prove light selection/escalation with stand-ins |
| R01–R09; RC01–RC04 | executor ExecResult exposes final provider/model/family; builtBy supports routing; rubric records some actual identity | No retry history, versioned provenance, validated current subjects or shared retained-contribution interpreter |
| R10–R16; RC05 | finalReview uses SCHEMAS.review; gateC knows integration head/verification; openFindings exists | Stable IDs, strict final schema and audited current-head reassessments absent |
| R17–R22 | report guardProse and withoutNoRecordSentences | Whole-field rejection still discards useful prose; canonical replacement and helper switch absent |
| E01–E10 | scrubEnv removes billing routes; supervision/stdin/structured outputs exist | Filter clones parent environment; browser inherits implicitly; all launch purposes need positive policy |
| I01–I12; ISO01–ISO20; T01–T20 | Worktree restore, hashes and native Codex probe are existing safeguards | No complete file boundary or surviving experiment fixture; no current capability result; all OS proof held |
| H01–H06 | MissionStore.createMission; CLI creation paths at new, feature and plan queue | No helper type/config/saved snapshot or damaged-snapshot validation |
| H07–H12 | buildAttempt/makeAttempt context jobs, failBuild digest, reportProse; optional scout uses light role | No independent switches; preserve raw diagnostics, required diagnosis/review/stops and light escalation |
| H13–H16 | specStage adopts planOf(m).spec, skips initial planner, proceeds to gate A | Preserve route and selected stops; no workflow rewrite |
| U01–U07 | quota recordUtilization/sameReading/save/restore | No trusted receipt time; malformed resets can inherit; identical observations do not refresh freshness |
| U08/U22 | Limit/auth/failure distinctions, pacing, memory-only per-invocation nightStart | Preserve distinctions; no claim of account-wide or restart-proof allowance reservation |
| U09–U18 | Codex loginRefusal queries app-server inside runIn | No prelaunch readAllowance, abortable metadata contract, unknown policy or Mission.pause |
| U19–U21; RC07–RC08 | Dispatcher counts once after outer executor call and uses scratch inflight | Retry reservations missing; marker clears before cleanup and durable save; recovery clears first |
| F01–F05; RC06 | otherFeaturesSection, makePrompt, later-files and noteLaterFeatureFiles | Scope/warnings limited by mode; maker missing scope; extend to every multi-feature mission |
| F06–F12 | carryModes and keepWrittenChecks | Only reading-mode checks protected against previous spec; reconcile all supplied features against immutable original PlanSource.spec |
| F13–F18 | normalizeSpecText/plainEscapes invoked by writeSpec, including revisions | Second decoding exists; preserve new parsed strings literally, retain persisted records and historical fixture |
| V01–V10 | Evidence ledger and old compatibility fixtures survive | Current source review only; execution and release decision held |

## Production launch inventory

Every row is a future explicit context site. The generic wrapper alone cannot cover the direct app-server and browser launches. Recheck this inventory after core integration.

| Source symbol / site | Purpose | Present policy / future requirement |
|---|---|---|
| util/process runProcess → spawn | Shared supervised subprocess gateway | Defaults to process.env; require declared context at callers |
| runners/claude runProcess | Official Claude worker | scrubEnv denylist; selected Claude config only |
| runners/codex runProcess | Official Codex worker | scrubEnv denylist; selected Codex config only |
| runners/codex probeReadOnlySandbox | Native protection probe | scrubEnv; selected required protection must eventually forbid permissive fallback |
| runners/codex-app-server readCodexAccount → spawn | Provider metadata | Caller env; own supervision; needs abort/deadline and explicit metadata context |
| runners/worktree-guard Git helper | Controller Git snapshot/restore | Parent clone with constructed GIT fields/temp index; retain protected controller authority |
| verify runProcess | Project install and check commands | scrubEnv plus CI/color; no provider/GitHub/SSH credentials |
| render renderPages → chromium.launch | Untrusted page/browser | No explicit launch env; discovery options.env is separate |
| git Git helper → runProcess | Controller Git | gitEnv clones parent; replace with explicit required controller values without altering owner shell |
| dispatcher repoFiles | Controller repository file listing | Implicit environment |
| dispatcher gitRead | Controller Git read/diff | Parent clone minus Git location fields |
| dispatcher gitConfigEntries | Controller local Git configuration inspection | Parent clone with controller overrides |
| doctor command gateway | Version/login/diagnostic command | scrubEnv; all execution held in this task |
| cli project-root detection | Controller rev-parse | Implicit environment |

The shell wrapper is a separate owner/controller boundary. It launches Docker, host leader Claude, clean_git and GitHub publication. Its deliberate owner-side credentials and approval rules must not be replaced by blanket worker policy. No wrapper command is authorized here. Environment filtering does not establish file or network protection.

## Deferred cases, authored as specifications only

| Case set | Concrete stimulus and required observation after permission |
|---|---|
| P0 preservation | Compare model/pin/config and existing fixture hashes to R0; baseline records exact passes/failures/skips, no historical total as target |
| P2 context | Parent object contains arbitrary fake secret, API route, SSH socket, NODE_OPTIONS and Windows PATH; worker/check/browser/metadata each receive only declared native values; missing required paths fail without printing values |
| P4 eight combinations | Enumerate three independent booleans; assert absence/presence of context-*, digest-* and report-prose labels; identical required stages, owner stops and raw failure tail; restart with changed global config retains snapshot |
| P5 freshness | Fake clock crosses ten minutes, future receipt, expired/malformed/omitted reset, identical new observation; strict unknown launches zero runners; warn preserves routing with uncertainty; metadata stop/cap creates no model charge |
| P5 retries | Stand-in writes then errors, executor retries; each attempted invocation has a durable count; restart after reservation retains it; metadata and disabled helper reserve nothing |
| P6 supplied plan | All-tests/mixed/all-review missions receive scoped author/engineer/maker prompts; attempted ID/check/dependency edit is rejected against original PlanSource.spec; literal backslash+n and true newline remain distinct after restart |
| SC01–SC10 | Retain all ten combined scenarios in main spec; each is execution-held and requires an actual integrated fixture later |
| Protection | Retain all T01–T20 positive/denial controls in 07. No fixture authored in this bounded P1 batch. R8 must author/review it before the capped R9 experiment |

## Ownership and evidence limits

The orchestrator owns all documentation and shared contracts/runtime files. Source inventory worker is read-only. P1 worker may write only individually assigned new pure module/test files after the contract review. No existing test is weakened or edited. No runtime imports/default changes, test collection, fixture execution, typecheck/build, OS probes, dependency downloads/audit, provider queries, product runs, Docker, publication, commits, deletion or master changes are part of preparation.

The two development workers use exactly gpt-6.1-sol with fork_turns none and no reasoning override. They create no agents. A separate Sol source reviewer is not evidence from another AI family. No development allowance percentage was queried or inferred.

## Current launch inventory after core reconstruction

31 October2026, source inspection only for this inventory. The historical table above describes the starting tree.

| Current launch sites | Explicit environment source |
|---|---|
| Claude/Codex workers and existing Codex native read-only probe | providerLaunchEnv(worker), selected provider config, fresh owned HOME/TMP and nativeToolPath |
| Codex app-server metadata | providerLaunchEnv(provider-metadata), bounded abort/deadline lifecycle; no real query executed |
| Verification | localLaunchEnv(verification), fresh owned HOME/TMP; no provider config |
| Chromium rendering | localLaunchEnv(rendering) passed to chromium.launch; real browser cases remain skipped |
| Controller Git, worktree-guard, dispatcher listing/read/config, CLI root detection | controllerGitEnv with explicit typed overrides; no inherited arbitrary Git/SSH environment |
| New committed/live work capture scanner | controllerGitEnv with explicit root ceiling and replacement-disabled Git |
| Doctor | explicit provider diagnostic or controller Git context; tested with stand-ins, no live doctor |
| Generic runProcess | explicit env required by type and runtime; no parent-environment default |

Only direct subprocess entry points are util/process spawn and codex-app-server spawn, plus Chromium launch. The provider spawn methods delegate to runProcess. Existing controller shell wrappers remain separate and unchanged. This inventory and environment tests do not prove file/network isolation; the separate07 experiment and concrete design gates remain held.
