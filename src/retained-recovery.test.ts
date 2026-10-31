import { describe, expect, it } from "vitest";
import { initializeTracking, beginWriter, finishWriter, adoptRetained, reconcileRestore, pendingWrites, type TrackingPlan, type WorkCapture } from "./retained-work.js";
import { reserveInvocation, observeInvocation, cleanInvocation, recoverInvocations, restoreUnsettledInvocations, settleRecovery, journalOf, InvocationPersistenceError, type InvocationState } from "./invocations.js";
import { interpretProvenance } from "./provenance.js";
const scope = { kind: "feature", featureId: "one" } as const, head = "a".repeat(40), next = "b".repeat(40);
const at = "2026-10-31T00:00:00.000Z", later = "2026-10-31T00:01:00.000Z", restoredAt = "2026-10-31T00:02:00.000Z";
const cap: WorkCapture = { scope, root: "/fixture/feature", universe: "git-source-v1", head, complete: true, files: [] };
const subject = { kind: "feature_commit", featureId: "one", commit: head } as const;
function ok<T extends object>(r: TrackingPlan<T>): Extract<TrackingPlan<T>,{ok:true}> { if (!r.ok) throw Error(r.reason); return r; }
function fixture(observed = false) {
  const m: InvocationState = { agentRuns: 0 };
  const seed = ok(initializeTracking(cap, { freshBaseline: { head, beforeMissionWrites: true, noRetainedAiWriters: true } }));
  const checkpoint = ok(adoptRetained(seed.state, { scope, capture: cap, committed: cap, subject, at, journal: journalOf(m), provenance: undefined }));
  const candidate = { provider: "claude", family: "claude", model: "candidate-only" } as const;
  reserveInvocation(m, { jobId: "crashed", label: "build-one", role: "engineer", access: "workspace-write", feature: "one", scope,
    stage: "build", baseSubject: subject, reservedAt: at, candidate }, 100, () => {});
  const begun = ok(beginWriter(checkpoint.state, { jobId: "crashed", scope, stage: "build", before: cap, frozenPaths: [] }));
  if (observed) observeInvocation(m, "crashed", candidate, "failed", later, () => {});
  const recovery = recoverInvocations(m, undefined, {}, later, () => {})[0]!;
  const restored = ok(reconcileRestore(begun.state, { scope, checkpointId: checkpoint.checkpointId, after: cap, provenance: checkpoint.provenance }));
  const proof = { at: restoredAt, checkpointId: checkpoint.checkpointId, subject, cleanupComplete: true } as const;
  return { m, checkpoint, begun, restored, recovery, proof };
}
describe("integrated retained restore and durable journal proof", () => {
  it.each([false, true])("full restore settles interrupted work without creating contributor credit, observed=%s", observed => {
    const f = fixture(observed); expect(f.restored.dispositions).toEqual([{ jobId: "crashed", disposition: "reverted" }]);
    restoreUnsettledInvocations(f.m, ["crashed"], f.proof, () => {});
    settleRecovery(f.m, f.recovery.key, false, () => {});
    const pending = ok(pendingWrites(f.restored.state, journalOf(f.m), scope));
    expect(pending.complete).toBe(true); expect(pending.pendingJobIds).toEqual([]);
    const adopted = ok(adoptRetained(f.restored.state, { scope, capture: cap, committed: cap, subject, at: restoredAt, journal: journalOf(f.m), provenance: f.checkpoint.provenance }));
    expect(adopted.provenance.entries).toEqual([]);
    expect(f.m.agentRuns).toBe(1); expect(f.m.invocations?.entries[0]?.cleanedAt).toBeUndefined();
    expect(f.m.invocations?.entries[0]?.observation !== undefined).toBe(observed);
    expect(recoverInvocations(f.m, undefined, {}, restoredAt, () => {})).toEqual([]);
  });
  it("does not become complete when only tracking or only journal restoration was saved", () => {
    const f = fixture();
    expect(ok(pendingWrites(f.restored.state, journalOf(f.m), scope)).complete).toBe(false);
    restoreUnsettledInvocations(f.m, ["crashed"], f.proof, () => {});
    const half = ok(pendingWrites(f.begun.state, journalOf(f.m), scope));
    expect(half.complete).toBe(false); expect(half.pendingJobIds).toContain("crashed");
  });
  it("keeps unknown pending state after a failed journal restoration save", () => {
    const f = fixture(), before = structuredClone(f.m);
    expect(() => restoreUnsettledInvocations(f.m, ["crashed"], f.proof, () => { throw Error("fixture atomic save failed"); })).toThrow(InvocationPersistenceError);
    expect(f.m).toEqual(before);
    expect(ok(pendingWrites(f.begun.state, journalOf(f.m), scope)).complete).toBe(false);
    expect(ok(pendingWrites(f.restored.state, journalOf(f.m), scope)).complete).toBe(false);
  });
  it("allows a later recorded writer while excluding the restored job's candidate family", () => {
    const f = fixture(); restoreUnsettledInvocations(f.m, ["crashed"], f.proof, () => {}); settleRecovery(f.m, f.recovery.key, false, () => {});
    const actual = { provider: "codex", family: "codex", model: "actual-later-model" } as const;
    reserveInvocation(f.m, { jobId: "later", label: "build-one", role: "engineer", access: "workspace-write", feature: "one", scope,
      stage: "build", baseSubject: subject, reservedAt: restoredAt, candidate: actual }, 100, () => {});
    const begun = ok(beginWriter(f.restored.state, { jobId: "later", scope, stage: "build", before: cap, frozenPaths: [] }));
    observeInvocation(f.m, "later", actual, "ok", restoredAt, () => {});
    const after: WorkCapture = { ...cap, files: [{ path: "a.ts", sha256: "c".repeat(64), mode: "100644" }] };
    const finished = ok(finishWriter(begun.state, { jobId: "later", after, journal: journalOf(f.m) }));
    cleanInvocation(f.m, "later", restoredAt, () => {});
    const accepted = { ...after, head: next }, acceptedSubject = { ...subject, commit: next };
    const adopted = ok(adoptRetained(finished.state, { scope, capture: accepted, committed: accepted, subject: acceptedSubject,
      at: restoredAt, journal: journalOf(f.m), provenance: f.checkpoint.provenance }));
    const evidence = interpretProvenance(adopted.provenance, { subject: acceptedSubject, hasPendingWrites: false, maxEntries: 100, maxSnapshots: 100 });
    expect(evidence.contributionsComplete).toBe(true); expect(evidence.contributorJobIds).toEqual(["later"]); expect(evidence.contributorFamilies).toEqual(["codex"]);
    expect(adopted.provenance.entries.map(e => e.jobId)).toEqual(["later"]);
    expect(f.m.agentRuns).toBe(2);
  });
});
