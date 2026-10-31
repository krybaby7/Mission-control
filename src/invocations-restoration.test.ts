import { describe, expect, it, vi } from "vitest";
import { cleanInvocation, InvocationPersistenceError, journalOf, observeInvocation, recoverInvocations, reserveInvocation,
  restoreUnsettledInvocations, settleRecovery, type InvocationState, type Reservation, type RestorationProof } from "./invocations.js";
const at = "2026-10-31T00:00:00.000Z", observed = "2026-10-31T00:01:00.000Z", recovered = "2026-10-31T00:02:00.000Z", restored = "2026-10-31T00:03:00.000Z";
const actual = { provider: "claude", model: "recorded-model", family: "claude" } as const;
function input(jobId = "writer-1"): Reservation { return { jobId, label: "build-one", role: "engineer", access: "workspace-write", feature: "one",
  scope: { kind: "feature", featureId: "one" }, stage: "build", reservedAt: at, candidate: actual }; }
function proof(): RestorationProof { return { at: restored, checkpointId: "b".repeat(64), subject: { kind: "feature_commit", featureId: "one", commit: "a".repeat(40) }, cleanupComplete: true }; }
function state(): InvocationState { const m: InvocationState = { agentRuns: 0 }; reserveInvocation(m, input(), 100, () => {}); return m; }
describe("journal proof for unobserved interrupted work restored exactly", () => {
  it("settles a restored reservation without inventing actual identity, outcome or ordinary cleanup", () => {
    const m = state(); restoreUnsettledInvocations(m, ["writer-1"], proof(), () => {});
    expect(journalOf(m).entries[0]).toMatchObject({ writeDisposition: "reverted", restoration: proof() });
    expect(m.invocations?.entries[0]).not.toHaveProperty("observation"); expect(m.invocations?.entries[0]).not.toHaveProperty("cleanedAt");
    expect(m.agentRuns).toBe(1);
    expect(recoverInvocations(m, undefined, {}, restored, () => {})).toEqual([]);
    expect(m.invocations?.recoveries).toEqual([]);
  });
  it("preserves already counted interruption and replays its decision until acknowledged", () => {
    const m = state(); const notices = recoverInvocations(m, undefined, {}, recovered, () => {});
    restoreUnsettledInvocations(m, ["writer-1"], proof(), () => {});
    const replay = recoverInvocations(m, undefined, {}, restored, () => {});
    expect(replay).toHaveLength(1); expect(replay[0]).toMatchObject({ key: notices[0]!.key, count: 1, fresh: false });
    settleRecovery(m, notices[0]!.key, false, () => {});
    expect(recoverInvocations(m, undefined, {}, restored, () => {})).toEqual([]);
    expect(m.invocations?.interruptionCounts["build-one"]).toBe(1); expect(m.agentRuns).toBe(1);
  });
  it("retains an actual failed observation without calling it a completed or cleaned job", () => {
    const m = state(); observeInvocation(m, "writer-1", actual, "failed", observed, () => {});
    recoverInvocations(m, undefined, {}, recovered, () => {}); restoreUnsettledInvocations(m, ["writer-1"], proof(), () => {});
    expect(journalOf(m).entries[0]).toMatchObject({ observation: { actual, outcome: "failed", at: observed }, writeDisposition: "reverted" });
    expect(m.invocations?.entries[0]?.cleanedAt).toBeUndefined();
  });
  it("restores a batch atomically and rolls it all back on failed persistence", () => {
    const m = state(); reserveInvocation(m, input("writer-2"), 100, () => {}); const before = structuredClone(m);
    expect(() => restoreUnsettledInvocations(m, ["writer-1", "writer-2"], proof(), () => { throw Error("fixture storage failure"); })).toThrow(InvocationPersistenceError);
    expect(m).toEqual(before);
    restoreUnsettledInvocations(m, ["writer-1", "writer-2"], proof(), () => {});
    expect(journalOf(m).entries.map(e => e.writeDisposition)).toEqual(["reverted", "reverted"]);
  });
  it("allows exact replay while refusing altered proof or later observation/cleanup", () => {
    const m = state(); restoreUnsettledInvocations(m, ["writer-1"], proof(), () => {}); const before = structuredClone(m);
    restoreUnsettledInvocations(m, ["writer-1"], { cleanupComplete: true, subject: { commit: "a".repeat(40), featureId: "one", kind: "feature_commit" }, checkpointId: "b".repeat(64), at: restored }, () => {});
    expect(m).toEqual(before);
    expect(() => restoreUnsettledInvocations(m, ["writer-1"], { ...proof(), checkpointId: "c".repeat(64) }, () => {})).toThrow(InvocationPersistenceError);
    expect(() => observeInvocation(m, "writer-1", actual, "ok", restored, () => {})).toThrow(InvocationPersistenceError);
    expect(() => cleanInvocation(m, "writer-1", restored, () => {})).toThrow(InvocationPersistenceError);
    expect(m).toEqual(before);
  });
  it.each([
    { at }, { checkpointId: "short" }, { cleanupComplete: false },
    { subject: { kind: "feature_commit", featureId: "other", commit: "a".repeat(40) } },
    { subject: { kind: "application_commit", commit: "a".repeat(40) } },
    { subject: { kind: "frozen_tests", featureId: "one", testSetId: "a".repeat(64) } },
    { extra: true },
  ])("rejects invalid or mismatched restoration %j", change => {
    const m = state(); recoverInvocations(m, undefined, {}, recovered, () => {}); const before = structuredClone(m);
    expect(() => restoreUnsettledInvocations(m, ["writer-1"], { ...proof(), ...change } as RestorationProof, () => {})).toThrow(InvocationPersistenceError); expect(m).toEqual(before);
  });
  it.each(["reader", "cleaned", "legacy-controller"])("does not apply this unsettled-write transition to %s", kind => {
    const m: InvocationState = { agentRuns: 0 };
    reserveInvocation(m, kind === "reader" ? { ...input(), access: "read-only", stage: "review" } : kind === "legacy-controller" ? { ...input(), scope: { kind: "controller" }, stage: "other" } : input(), 100, () => {});
    if (kind === "cleaned") { observeInvocation(m, "writer-1", actual, "ok", observed, () => {}); cleanInvocation(m, "writer-1", observed, () => {}); }
    const before = structuredClone(m); expect(() => restoreUnsettledInvocations(m, ["writer-1"], proof(), () => {})).toThrow(InvocationPersistenceError); expect(m).toEqual(before);
  });
  it("clears a matching stale marker without adding an interruption and still rejects mismatches", () => {
    const m = state(); restoreUnsettledInvocations(m, ["writer-1"], proof(), () => {});
    const marker = { jobId: "writer-1", label: "build-one", feature: "one", at };
    expect(recoverInvocations(m, marker, {}, restored, () => {})).toEqual([]);
    expect(m.invocations?.recoveries).toEqual([]);
    expect(() => recoverInvocations(m, { ...marker, label: "other" }, {}, restored, () => {})).toThrow(InvocationPersistenceError);
  });
  it("refuses terminal restoration fields in a fresh reservation, including explicit undefined", () => {
    for (const restoration of [proof(), undefined]) {
      const m: InvocationState = { agentRuns: 0 };
      expect(() => reserveInvocation(m, { ...input(), restoration } as Reservation, 100, () => {})).toThrow(InvocationPersistenceError);
      expect(m).toEqual({ agentRuns: 0 });
    }
  });
  it("rejects damaged stored restoration or an attempted future adoption without discarding the original", () => {
    const m = state(); restoreUnsettledInvocations(m, ["writer-1"], proof(), () => {});
    m.invocations!.entries[0]!.writeDisposition = "adopted"; const before = structuredClone(m);
    expect(() => journalOf(m)).toThrow(InvocationPersistenceError); expect(m).toEqual(before);
    m.invocations!.entries[0]!.writeDisposition = "reverted";
    (m.invocations!.entries[0] as unknown as { restoration: unknown }).restoration = undefined;
    expect(() => journalOf(m)).toThrow(InvocationPersistenceError);
  });
  it("validates every row before accepting a partly eligible batch", () => {
    const m = state(); reserveInvocation(m, { ...input("other"), feature: "other", scope: { kind: "feature", featureId: "other" } }, 100, () => {});
    const before = structuredClone(m), save = vi.fn();
    expect(() => restoreUnsettledInvocations(m, ["writer-1", "other"], proof(), save)).toThrow(InvocationPersistenceError);
    expect(m).toEqual(before); expect(save).not.toHaveBeenCalled();
  });
  it.each([[], ["missing"], ["writer-1", "writer-1"]].map(ids => ({ ids })))("rejects invalid batch %j without saving", ({ ids }) => {
    const m = state(), before = structuredClone(m), save = vi.fn();
    expect(() => restoreUnsettledInvocations(m, ids, proof(), save)).toThrow(InvocationPersistenceError);
    expect(m).toEqual(before); expect(save).not.toHaveBeenCalled();
  });
});
