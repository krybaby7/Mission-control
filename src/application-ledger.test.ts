import { describe, expect, it } from "vitest";
import { initializeApplicationLedger, recordApplicationScaffold, beginApplicationMerge, finishApplicationMerge, readApplicationLedger, type ApplicationLedger, type LedgerResult, type MergeInput, type MergeReceipt } from "./application-ledger.js";
import type { WorkCapture } from "./work-capture.js";
const base = "a".repeat(40), scaffold = "b".repeat(40), passing = "c".repeat(40), merged = "d".repeat(40), descendant = "e".repeat(40);
const capture = (head = base): WorkCapture => ({ scope: { kind: "application" }, root: "/fixture/integration", universe: "git-source-v1", head, complete: true, files: [{ path: "a", sha256: "f".repeat(64), mode: "100644" }] });
function unwrap(result: LedgerResult): ApplicationLedger { expect(result.ok).toBe(true); if (!result.ok) throw Error(result.reason); return result.ledger; }
function fresh() { return unwrap(initializeApplicationLedger({ capture: capture(), committed: capture(), beforeMissionWrites: true, noRetainedAiWriters: true })); }
function ready() { return unwrap(recordApplicationScaffold(fresh(), { capture: capture(scaffold), committed: capture(scaffold), beforeHead: base, snapshotRevision: 1, hasRetainedAiWork: true, baselineIsAncestor: true })); }
function input(): MergeInput { return { capture: capture(scaffold), committed: capture(scaffold), attemptId: "merge-1", featureId: "one", passingCommit: passing, snapshotRevision: 2 }; }
function pending() { return unwrap(beginApplicationMerge(ready(), input())); }
function receipt(): MergeReceipt { return { attemptId: "merge-1", beforeHead: scaffold, passingCommit: passing, returnedHead: merged, observedHead: merged, successful: true, sourceIsAncestor: true, previousHeadIsAncestor: true }; }
describe("durable independent integration ledger", () => {
  it("records a pre-write baseline and a distinct accepted scaffold selection", () => {
    const original = fresh(); const snapshot = structuredClone(original); const result = ready();
    expect(original).toEqual(snapshot); expect(result).toMatchObject({ baseline: { kind: "recorded_baseline", commit: base }, head: scaffold,
      scaffold: { commit: scaffold, snapshotRevision: 1, hasRetainedAiWork: true }, features: [] });
  });
  it("persists the exact pending source before it can record a delivered feature", () => {
    const before = ready(), snapshot = structuredClone(before); const result = unwrap(beginApplicationMerge(before, input()));
    expect(before).toEqual(snapshot); expect(result.features).toEqual([]); expect(result.head).toBe(scaffold);
    expect(result.pendingMerge).toEqual({ attemptId: "merge-1", beforeHead: scaffold, featureId: "one", passingCommit: passing, snapshotRevision: 2 });
  });
  it("adopts only the fresh successful exact merge receipt and retains source revision", () => {
    const before = pending(), snapshot = structuredClone(before);
    const result = unwrap(finishApplicationMerge(before, { capture: capture(merged), committed: capture(merged), receipt: receipt() }));
    expect(before).toEqual(snapshot); expect(result.pendingMerge).toBeUndefined(); expect(result.head).toBe(merged);
    expect(result.features).toEqual([{ featureId: "one", passingCommit: passing, mergeCommit: merged, snapshotRevision: 2 }]);
    expect(result.scaffold).toEqual(before.scaffold);
  });
  it.each(["successful", "sourceIsAncestor", "previousHeadIsAncestor"] as const)("refuses missing %s merge proof without consuming the pending intent", key => {
    const before = pending(), snapshot = structuredClone(before); const proof = receipt(); proof[key] = false;
    expect(finishApplicationMerge(before, { capture: capture(merged), committed: capture(merged), receipt: proof }).ok).toBe(false);
    expect(before).toEqual(snapshot);
  });
  it("does not reconcile an unexpected later descendant merely because both ancestors are present", () => {
    const before = pending();
    expect(finishApplicationMerge(before, { capture: capture(descendant), committed: capture(descendant),
      receipt: { ...receipt(), observedHead: descendant } }).ok).toBe(false);
    expect(before.pendingMerge).toBeDefined(); expect(before.features).toEqual([]);
  });
  it.each(["attemptId", "beforeHead", "passingCommit", "returnedHead", "observedHead"] as const)("rejects a mismatched %s in the merge receipt", key => {
    const proof = receipt(); proof[key] = key === "attemptId" ? "different-attempt" : descendant;
    expect(finishApplicationMerge(pending(), { capture: capture(merged), committed: capture(merged), receipt: proof }).ok).toBe(false);
  });
  it("handles a source already in the integration head without inventing a new merge SHA or duplicate reference", () => {
    const before = ready(); const request = { ...input(), passingCommit: scaffold };
    const begun = unwrap(beginApplicationMerge(before, request));
    const done = unwrap(finishApplicationMerge(begun, { capture: capture(scaffold), committed: capture(scaffold),
      receipt: { ...receipt(), passingCommit: scaffold, returnedHead: scaffold, observedHead: scaffold } }));
    expect(done.features).toEqual([{ featureId: "one", passingCommit: scaffold, mergeCommit: scaffold, snapshotRevision: 2 }]);
    expect(beginApplicationMerge(done, { ...request, attemptId: "duplicate" }).ok).toBe(false);
    expect(finishApplicationMerge(done, { capture: capture(scaffold), committed: capture(scaffold), receipt: receipt() }).ok).toBe(false);
  });
  it("handles a fast-forward merge whose result is the source commit", () => {
    const done = unwrap(finishApplicationMerge(pending(), { capture: capture(passing), committed: capture(passing),
      receipt: { ...receipt(), returnedHead: passing, observedHead: passing } }));
    expect(done.head).toBe(passing); expect(done.features[0]?.mergeCommit).toBe(passing);
  });
  it("allows only exact idempotent pending intent replay and never substitutes latest source revision", () => {
    const before = pending(); expect(unwrap(beginApplicationMerge(before, input()))).toEqual(before);
    before.pendingMerge = { beforeHead: scaffold, snapshotRevision: 2, passingCommit: passing, featureId: "one", attemptId: "merge-1" };
    expect(unwrap(beginApplicationMerge(before, input()))).toEqual(before);
    expect(beginApplicationMerge(before, { ...input(), snapshotRevision: 3 }).ok).toBe(false);
    expect(beginApplicationMerge(before, { ...input(), passingCommit: descendant }).ok).toBe(false);
  });
  it("rejects an unexpected integration HEAD before merge", () => {
    expect(beginApplicationMerge(ready(), { ...input(), capture: capture(descendant), committed: capture(descendant) }).ok).toBe(false);
  });
  it.each(["root", "complete", "bytes", "scope"])("requires matching complete committed proof for %s divergence", kind => {
    const live = capture(scaffold), committed = capture(scaffold);
    if (kind === "root") live.root = "/another/root";
    if (kind === "complete") committed.complete = false;
    if (kind === "bytes") live.files[0]!.sha256 = "1".repeat(64);
    if (kind === "scope") live.scope = { kind: "feature", featureId: "one" };
    expect(beginApplicationMerge(ready(), { ...input(), capture: live, committed }).ok).toBe(false);
  });
  it("does not change scaffold selection after a feature has entered the ledger or while a merge is pending", () => {
    const begun = pending(); const done = unwrap(finishApplicationMerge(begun, { capture: capture(merged), committed: capture(merged), receipt: receipt() }));
    for (const before of [begun, done]) expect(recordApplicationScaffold(before, { capture: capture(descendant), committed: capture(descendant),
      beforeHead: before.head, snapshotRevision: 2, hasRetainedAiWork: true, baselineIsAncestor: true }).ok).toBe(false);
  });
  it("does not infer no retained scaffold work from missing identities", () => {
    expect(recordApplicationScaffold(ready(), { capture: capture(scaffold), committed: capture(scaffold), beforeHead: scaffold,
      snapshotRevision: null, hasRetainedAiWork: false, baselineIsAncestor: true }).ok).toBe(false);
  });
  it.each([undefined, null, { version: 99 }, { version: 1, extra: "retained" }])("preserves malformed present ledger %j as an error", raw => {
    const before = structuredClone(raw); expect(readApplicationLedger(raw).ok).toBe(false); expect(beginApplicationMerge(raw, input()).ok).toBe(false); expect(raw).toEqual(before);
  });
  it("rejects altered pending head and duplicate delivered feature records", () => {
    const wrong = pending(); wrong.pendingMerge!.beforeHead = base; expect(readApplicationLedger(wrong).ok).toBe(false);
    const done = unwrap(finishApplicationMerge(pending(), { capture: capture(merged), committed: capture(merged), receipt: receipt() }));
    done.features.push({ ...done.features[0]! }); expect(readApplicationLedger(done).ok).toBe(false);
  });
  it("rejects storage bounds and unknown or explicitly undefined fields without truncation", () => {
    const state = fresh(); state.features = Array.from({ length: 2_001 }, (_, n) => ({ featureId: "f" + n, passingCommit: passing, mergeCommit: scaffold, snapshotRevision: 1 }));
    state.head = scaffold; expect(readApplicationLedger(state).ok).toBe(false);
    expect(readApplicationLedger({ ...fresh(), pendingMerge: undefined }).ok).toBe(false);
    expect(readApplicationLedger({ ...fresh(), extra: true }).ok).toBe(false);
    expect(readApplicationLedger({ ...fresh(), scaffold: { ...fresh().scaffold, hasRetainedAiWork: undefined } }).ok).toBe(false);
    const huge = capture(); huge.files = Array.from({ length: 20_001 }, (_, n) => ({ path: "f" + n.toString().padStart(6, "0"), sha256: "f".repeat(64), mode: "100644" as const }));
    expect(initializeApplicationLedger({ capture: huge, committed: huge, beforeMissionWrites: true, noRetainedAiWriters: true }).ok).toBe(false);
  });
  it("rejects missing independent pre-write assertions and incomplete initial capture", () => {
    expect(initializeApplicationLedger({ capture: capture(), committed: capture(), beforeMissionWrites: false as true, noRetainedAiWriters: true }).ok).toBe(false);
    expect(initializeApplicationLedger({ capture: capture(), committed: { ...capture(), complete: false }, beforeMissionWrites: true, noRetainedAiWriters: true }).ok).toBe(false);
  });
});
