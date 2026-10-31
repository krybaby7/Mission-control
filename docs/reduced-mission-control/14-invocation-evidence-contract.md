# Invocation and evidence contract for the first inactive slice

31 October 2026. Proposed runtime contract; no runtime changes applied. The exact pure interpretation subset below is for source review before authoring.

## Purpose and ownership

R01–R09, U19–U21 and RC01–RC04/RC07–RC08 share one problem: the final successful call is not necessarily the only writer. Keep immutable actual invocation evidence, exact-result retained contribution snapshots, and durable pending intent. A failed call can contribute retained work. A separate session is not a separate family.

The orchestrator owns these contracts and all future changes to types, config, state, schemas, dispatcher, executor and run. The worker owns only new `src/provenance.ts` and `src/provenance.test.ts` after design review. During preparation these types live in that unreferenced module; future shared-type relocation belongs to the integrator. No live module imports it. No persistence, runner, Git, filesystem or network operations belong in the pure interpreter.

## Exact interpretation types

```ts
type ActualIdentity = { provider?: Provider; model?: string; family?: Family };
type WorkScope =
  | { kind: "feature"; featureId: string }
  | { kind: "application" }
  | { kind: "plan" };
type WorkSubject =
  | { kind: "feature_commit"; featureId: string; commit: string }
  | { kind: "frozen_tests"; featureId: string; testSetId: string }
  | { kind: "application_commit"; commit: string }
  | { kind: "plan"; planHash: string };
type WorkEvidence = {
  jobId: string;
  scope: WorkScope;
  stage: "test_author" | "build" | "fix" | "review" | "plan_review" | "final_review";
  actual?: ActualIdentity;
  outcome: "completed" | "incomplete" | "failed";
  at: string;
  subject?: WorkSubject;
};
type FrozenMember = { path: string; sha256: string };
type RetainedMember = FrozenMember & { jobIds: string[]; complete: boolean };
type RetainedSnapshot =
  | { kind: "writes"; subject: Extract<WorkSubject, {kind: "feature_commit" | "application_commit"}>;
      complete: boolean; jobIds: string[] }
  | { kind: "tests"; subject: Extract<WorkSubject, {kind: "frozen_tests"}>;
      complete: boolean; jobIds: string[]; members: RetainedMember[] };
type Provenance = { version: 1; entries: WorkEvidence[]; retained?: RetainedSnapshot[] };
type ProvenanceContext = {
  subject: WorkSubject;
  // Controller projection, not an AI claim. Omission/malformed value fails closed.
  hasPendingWrites: boolean;
  // Required for frozen_tests; exact accepted path/hash list from controller.
  frozenMembers?: FrozenMember[];
  // Derived from the mission's actual reservation count and configured bounds.
  maxEntries: number;
  maxSnapshots: number;
};
type ReviewFact = {
  jobId: string;
  actual: Required<ActualIdentity>;
  subject: WorkSubject;
  at: string;
  relationship: "same_family" | "different_family" | "unknown";
  overlappingFamilies: Family[];
};
type ProvenanceSummary = {
  contributorJobIds: string[];
  contributorFamilies: Family[];
  contributionsComplete: boolean;
  currentReviews: ReviewFact[];
  uncertainties: string[];
};
```

`Provider` and `Family` retain existing definitions, including the synthetic `mock` provider. Actual identity may be incomplete. Requested identities are never passed as actual. The exported pure API is `interpretProvenance(envelope: unknown, context: ProvenanceContext): ProvenanceSummary`. It accepts damaged persisted input and returns conservative facts, without repairing it or mutating inputs. Family and job lists are deduplicated; per-review relationships never blend multiple reviewers into one claim. `uncertainties` contains bounded reason codes, never raw malformed input or secret values. No field means executable checks passed or owner approval exists. Frozen-test contributors mean test authors, not code builders; plan review has no builder-independence claim.

Feature and mission envelopes keep 06's required version/entries names. The optional `retained` projection is additive. Entries and snapshots are append-only. This slice refuses duplicate job IDs or multiple snapshots for the same exact subject as ambiguous, rather than silently picking a winner. Same-commit recovery/revalidation therefore stays unknown in this slice. A reviewed revision/selection protocol is required before runtime integration; no claim that the full evidence lifecycle is implemented. This deliberate conservative restriction keeps the first reader bounded.

## Validation and interpretation rules

1. Accept only version 1 with arrays within the supplied positive integer budgets. An absent legacy envelope, unsupported version or unusable container returns no positive facts. Unknown future optional keys may be ignored. Never truncate away evidence and claim a complete history. Within a usable envelope, independently valid entries/references and test-member author IDs may supply conservative known-family facts even when another entry/member is invalid; global completeness becomes false. Conflicting or duplicate job IDs supply no identity at all. A malformed current snapshot cannot manufacture completeness or a current review; valid current review entries may still disclose overlap with independently valid retained references from that snapshot.
2. Job IDs, model and feature IDs contain at least one non-whitespace character, have no control characters and are at most 200 characters. Paths are at most 4096 characters. Do not trim or rewrite identity strings. Commits are full lowercase hexadecimal Git object IDs (40 or 64 digits); frozen-set/plan/member hashes are lowercase SHA-256 (64 digits). Timestamp is a finite ISO UTC instant. Invalid identity components cannot establish identity completeness. An independently valid actual family can support known overlap even with a missing provider/model, but only when a supplied provider/family pair is not contradictory. `mock` requires an explicitly recorded family; never infer a family from a mock or model string.
3. Valid pairs: feature test_author → same feature frozen_tests; feature build/fix/review → same feature feature_commit; application build/fix/final_review → application_commit; plan plan_review → plan. All other pairs are invalid for credit. Failed/incomplete evidence may omit subject; it may still identify a retained writer through an explicit valid snapshot reference of the same scope. Completed evidence requires a valid subject. Process exit zero alone does not mean accepted completed evidence.
4. A current review is a structurally valid completed review of the exact queried commit/plan, with a complete actual identity and no pending write uncertainty. An old review is stale for a changed subject. Plan review never counts as code review. Invalid or incomplete reviews do not acquire identity from requested configuration. Feature review queries use accepted premerge `f.passingCommit`, not integration merge `f.commit`; never translate evidence between them. Surface integration must carry the correct subject through dashboard's lossy projection, which currently substitutes a Claude reviewer and blanks test hashes. It must never feed those placeholders into the interpreter.
5. Each current retained snapshot is controller-derived, matches the exact queried result and lists every retained actual invocation ID, including failures. Every reference must resolve to appropriate build/fix or test-author evidence of matching scope. An earlier valid subject in that same scope is allowed for a retained writer; only the current snapshot and credited review require exact current-subject equality. Explicitly reverted writers are omitted only when the controller proved restoration. A failed outcome alone is not proof of reversion. Missing snapshots, missing referenced entries, empty contribution sets, duplicate IDs, unknown identities, invalid members or pending writes prevent a complete contribution claim.
6. A frozen snapshot must match the exact current member list: unique canonical relative paths, no empty/dot/dot-dot components, no absolute/backslash paths; identical member hashes; no missing/extra/duplicate paths. Its top-level jobIds must equal the union of member jobIds. Every member requires complete authorship for overall completeness. A replacement file cannot erase authorship of retained files. An empty set never proves independence.
7. Compare a current reviewer against all retained writer families. Any known overlap must be disclosed even if other history is incomplete. Only a complete nonempty retained set plus complete current review permits a cross-family claim. Unknown history remains unknown; option A adds no pause. Frozen author facts are separate from review facts and must not imply a review occurred.
8. This first slice does not implement application aggregation. Application interpretation accepts only application-scoped writers, always returns `contributionsComplete: false`, and never returns `different_family` for final review, even if the supplied application-only snapshot claims completeness. Known overlap and a valid current final reviewer identity may still be reported. Later controller aggregation must include every retained scaffold and feature contribution with correct premerge/integration mapping before R07 can close. Plan queries likewise never establish builder independence.

## Runtime patch proposal: one durable lifecycle

These are exact insertion points and write order, not applied edits. No dispatcher/executor/state file changes occur while held.

```ts
type InvocationIntent = {
  jobId: string; label: string; role: Role; access: Access;
  scope?: WorkScope; stage?: WorkEvidence["stage"];
  baseSubject?: WorkSubject; at: string;
  candidate: {provider: Provider; model: string; family: Family};
};
interface InvocationLifecycle {
  // Persist count and pending intent on the one authoritative Mission object.
  // Optional cap exhaustion returns false; all save errors prevent runner.run.
  reserve(intent: InvocationIntent, optional: boolean): Promise<boolean>;
  // Persist actual per-invocation outcome even if exec later retries/throws.
  // It does not classify or clear retained writes before controller adoption.
  observed(jobId: string, actual: ActualIdentity, result: RunResult | null): Promise<void>;
}
```

1. `RoleExecutor.run`: allocate a unique actual job ID using durable reservation IDs as well as existing log files. After admission/stop/deadline checks and immediately before each `runner.run`, await `reserve`. The controller increments `Mission.agentRuns` once and durably stores invocation intent in the same mission save. All launched roles count; metadata and skipped helpers do not. Write-capable calls retain pending intent. Failed save means zero runner starts. Optional cap exhaustion returns false, starts no runner and invokes no observation callback; required cap exhaustion throws the established cap-stop outcome. A successful reservation is never refunded because of an abort/throw. Do not record requested candidate identity as completed actual evidence.
2. `RoleExecutor.run/exec`: invoke `observed` for each attempted child outcome, including thrown/aborted paths, before retrying or propagating. Unknown start/completion leaves intent and conservative count. Preserve the current final-answer semantics, but callbacks retain earlier retry identity. An observation-save failure prevents further retry launches. Exceptions cannot bypass recovery state. Actual identity is controller-known dispatched provider/model/family for a confirmed attempted invocation; it is never copied from the caller's preferred assignment after failure.
3. `Dispatcher.run`: remove later `agentRuns++`. Keep cleanup (`reap`, `guardGitSettings`) under the durable pending intent; never clear in the current finally before cleanup. An observation does not yet decide which writes survive. A cleanup exception preserves intent or durably records uncertainty before propagation.
4. `writeTests/runTestAuthor/amendTests`, `buildAttempt/passBuild/fixFindings`, `makeAttempt/fixDeliverable`, `init/adoptInitOutput`: controller adoption records exact result subject, all retained invocation contributions, effective commit/test fields and pending removal in one `MissionStore.save`. Test member hashes map partial authorship. Explicit rollback removes a contributor only after restoration is established. A new commit stales older review credit. If adoption save fails, the earlier intent remains the recovery authority.
5. `review/rubricCheck/recordChecked/finalReview/gateC`: record usable actual review against the current subject. Read-only protection is not yet proved, so unclassified mutations still invalidate credit. Do not use AgentAnswer's existing `exec.family ?? call.assignment.family` fallback for evidence.
6. `recoverInterruptedRun` and `run` recovery: first save uncertainty for each durable pending scope, preserving count, owner decision and already accepted records. Only after that save may scratch inflight be cleared. Failure before save retains original marker/intent. Crash between save and scratch clear is idempotent by job ID, without a second count. Missing/corrupt scratch cannot hide mission-owned intent. Legacy scratch without reservation is reconciled once in an explicit saved migration transaction, not incremented repeatedly.
7. `MissionStore.save` / `RunMissionStore.save`: one in-memory mission object owns reservations, pending intent and result updates. No separate loaded copy may overwrite a more recent count or intent. The serialized run lock remains. Confirm writeJsonAtomic semantics for process-crash recovery; do not promise power-loss durability without filesystem evidence. Retain reservation history within configured attempt limits; overflow errors stop rather than discard evidence.

The exact persisted invocation-ledger schema, legacy migration transaction, application aggregation and fault-injection integration tests remain further R1 work. This proposal freezes ordering and the pure reader contract only; it is not ready-to-apply production wiring.

## Cases to author without running

| ID | Stimulus | Required interpretation / later lifecycle assertion |
|---|---|---|
| PC01 / RC01 | Failed Claude write retained, Codex completes, Claude reviews current head | Both writer families recorded; overlap disclosed |
| PC02 / RC01 | Same failed write explicitly reverted versus unknown retention | Proven reverted ID absent; unknown contribution prevents independence |
| PC03 / RC02 | One retained test has unknown authors, replacement test has known author | Known authors preserved, incomplete test authorship |
| PC04 / RC03 | Repair changes commit/contributors after completed review | Old review stale; new snapshot includes repair; surfaces later share interpreter |
| PC05 / RC04 | Missing/empty/wrong subject, stage/scope mismatch, unsupported version, duplicate IDs | No completed/current review credit or independence |
| PC06 | Valid distinct-family review with complete exact retained set | Cross-family fact only, no claim that checks passed or owner approved |
| PC07 | Plan review, application review and frozen author records mixed | No cross-scope credit |
| PC08 | Pending writes, malformed identity, wrong member hash, partial list, duplicate/empty contributors | Conservative unknown, preserving valid known overlap where possible |
| PC09 / RC07 | Save failure before launch, interruption during scaffold, completion before adoption, cleanup failure | Zero launch before reservation save; recoverable pending/unknown ownership |
| PC10 / RC08 | Crash after uncertainty save before marker clear; first save fails; second recovery | No lost uncertainty/count, no duplicate charge, pending owner approval intact |

PC01–PC08 target the pure module in this batch. PC09–PC10 are authored lifecycle specifications only and remain unimplemented/unrun fault-injection cases. R10–R22, RC05 and active surface integration remain later slices. All old test files stay unchanged.

## Review and stopping point

Design review precedes authoring. One read-only Sol reviewer inspects the actual new files for specification compliance and code quality afterward. At most two correction rounds precede a revised estimate. Any unresolved significant issue stays explicit. Freeze a checkpoint after the authored slice and at the testing gate. No run, typecheck, build, test collection or OS probe is needed or authorized to call this source-reviewed preparation.
