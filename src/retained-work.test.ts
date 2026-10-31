import { describe, expect, it } from "vitest";
import { recoverInvocations, type InvocationEntry, type InvocationJournal } from "./invocations.js";
import { interpretProvenance, type Provenance } from "./provenance.js";
import {
  recoverInterruptedWriter, initializeTracking, beginWriter, finishWriter, adoptRetained, reconcileRestore, pendingWrites,
  appendReviewEvidence, appendApplicationSnapshot, frozenSetId, type WorkCapture, type TrackingState, type TrackingPlan,
} from "./retained-work.js";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const H = "d".repeat(64), I = "e".repeat(64);
const NOW = "2026-10-31T00:00:00.000Z";
const SCOPE = { kind: "feature", featureId: "one" } as const;
const SUBJECT = { kind: "feature_commit", featureId: "one", commit: B } as const;
function capture(files: WorkCapture["files"] = [], head: string | null = A): WorkCapture {
  return { scope: SCOPE, root: "/work/project", universe: "git-source-v1", head, complete: true, files };
}
function ready<T extends object>(result: TrackingPlan<T>): TrackingState {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.state;
}
function seed(before = capture()) {
  return ready(initializeTracking(before, { freshBaseline: { head: before.head!, beforeMissionWrites: true, noRetainedAiWriters: true } }));
}
function writer(jobId = "writer-1", family: "claude" | "codex" = "claude", outcome: "ok" | "failed" = "ok", stage: "build" | "fix" | "test_author" = "build"): InvocationEntry {
  return { jobId, label: "build-one", role: stage === "test_author" ? "test_author" : "engineer", access: "workspace-write",
    scope: SCOPE, stage, reservedAt: NOW, candidate: { provider: family, model: "recorded-model", family },
    observation: { at: NOW, actual: { provider: family, model: "recorded-model", family }, outcome },
    cleanedAt: NOW, writeDisposition: "pending" };
}
function journal(...entries: InvocationEntry[]): InvocationJournal {
  return { version: 1, legacyAgentRuns: 0, legacyInterruptionCounts: {}, entries, recoveries: [], interruptionCounts: {} };
}
function run(state: TrackingState, before: WorkCapture, after: WorkCapture, entry = writer(), frozenPaths: string[] = []) {
  const begun = ready(beginWriter(state, { jobId: entry.jobId, scope: SCOPE, stage: entry.stage, before, frozenPaths }));
  return finishWriter(begun, { jobId: entry.jobId, after, journal: journal(entry), testPaths: [...new Set([...before.files, ...after.files].filter(f => f.path.endsWith(".test.ts")).map(f => f.path))] });
}
function adopt(state: TrackingState, accepted: WorkCapture, entries = [writer()], provenance: unknown = undefined) {
  return adoptRetained(state, { scope: SCOPE, capture: accepted, committed: structuredClone(accepted), subject: { ...SUBJECT, commit: accepted.head! }, at: NOW, journal: journal(...entries), provenance });
}
describe("retained writer transitions", () => {
  it("keeps a failed first writer beside a successful retry from another family", () => {
    const before = capture();
    const first = capture([{ path: "a.ts", sha256: H, mode: "100644" }]);
    const last = capture([{ path: "a.ts", sha256: I, mode: "100644" }]);
    const failed = writer("first", "claude", "failed"), passed = writer("last", "codex");
    const state1 = ready(run(seed(), before, first, failed));
    const state2 = ready(run(state1, first, last, passed));
    const result = adopt(state2, { ...last, head: B }, [failed, passed]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.entries.map(e => e.jobId)).toEqual(["first", "last"]);
      expect(result.provenance.retained?.[0]?.jobIds).toEqual(["first", "last"]);
      expect(result.provenance.retained?.[0]?.complete).toBe(true);
    }
  });
  it("proves no retained delta only with equal complete HEAD and full fingerprints", () => {
    const before = capture();
    const result = run(seed(), before, before, writer("failed", "claude", "failed"));
    expect(result.ok && result.retention).toBe("none");
    const adopted = adopt(ready(result), { ...before, head: B }, [writer("failed", "claude", "failed")]);
    expect(adopted.ok && adopted.provenance.entries).toEqual([]);
  });
  it.each(["root", "scope", "universe"])("rejects %s capture binding changes", (field) => {
    const before = capture();
    const after = { ...capture(), [field]: field === "scope" ? { kind: "feature", featureId: "other" } : "/different" };
    expect(run(seed(), before, after as WorkCapture).ok).toBe(false);
  });
  it("keeps crash/missing observation intent pending instead of inventing candidate identity", () => {
    const begun = ready(beginWriter(seed(), { jobId: "writer-1", scope: SCOPE, stage: "build", before: capture(), frozenPaths: [] }));
    const entry = writer();
    delete entry.observation; delete entry.cleanedAt;
    const result = finishWriter(begun, { jobId: entry.jobId, after: capture(), journal: journal(entry) });
    expect(result.ok).toBe(false);
    expect(pendingWrites(begun, journal(entry), SCOPE).ok).toBe(true);
  });
  it("cleaned-but-unadopted captured writers stay pending until selected adoption", () => {
    const after = capture([{ path: "a.ts", sha256: H, mode: "100644" }]);
    const state = ready(run(seed(), capture(), after));
    const pending = pendingWrites(state, journal(writer()), SCOPE);
    expect(pending.ok && pending.pendingJobIds).toEqual(["writer-1"]);
    const result = adopt(state, { ...after, head: B });
    expect(result.ok && result.dispositions).toContainEqual({ jobId: "writer-1", disposition: "adopted" });
  });
  it("does not infer a fresh baseline by looking at a progressed legacy capture", () => {
    const state = ready(initializeTracking(capture([{ path: "legacy.ts", sha256: H, mode: "100644" }])));
    const result = adopt(state, { ...capture([{ path: "legacy.ts", sha256: H, mode: "100644" }]), head: B }, []);
    expect(result.ok).toBe(true);
    expect(result.ok && result.provenance.retained?.[0]?.complete).toBe(false);
  });
  it("cannot bridge content changes with a controller commit", () => {
    expect(adopt(seed(), capture([{ path: "unaccounted.ts", sha256: H, mode: "100644" }], B), []).ok).toBe(false);
  });
  it("rejects malformed existing tracking without mutating raw data", () => {
    const raw = { version: 99, privateValue: "preserve-me", scopes: [] };
    const before = JSON.stringify(raw);
    expect(beginWriter(raw, { jobId: "writer-1", scope: SCOPE, stage: "build", before: capture(), frozenPaths: [] }).ok).toBe(false);
    expect(JSON.stringify(raw)).toBe(before);
  });
});

describe("strict adoption and restore proof", () => {
  function accepted() {
    const after = capture([{ path: "a.ts", sha256: H, mode: "100644" }]);
    const entry = writer();
    const state = ready(run(seed(), capture(), after, entry));
    const result = adopt(state, { ...after, head: B }, [entry]);
    if (!result.ok) throw new Error(result.reason);
    return { ...result, entry, after: { ...after, head: B } };
  }
  it("adopts and restores each feature using its separate provenance envelope", () => {
    const first = accepted(), scope = { kind: "feature", featureId: "two" } as const;
    const before = { ...capture(), scope, root: "/work/second" };
    const entry = { ...writer("second"), scope };
    const after = { ...before, files: [{ path: "two.ts", sha256: I, mode: "100644" as const }] };
    let state = ready(initializeTracking(before, { state: first.state, freshBaseline: { head: A, beforeMissionWrites: true, noRetainedAiWriters: true } }));
    state = ready(beginWriter(state, { jobId: entry.jobId, scope, stage: "build", before, frozenPaths: [] }));
    state = ready(finishWriter(state, { jobId: entry.jobId, after, journal: journal(entry) }));
    const committed = { ...after, head: C };
    const second = adoptRetained(state, { scope, capture: committed, committed, subject: { kind: "feature_commit", featureId: "two", commit: C }, at: NOW, journal: journal(entry), provenance: undefined });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const restored = reconcileRestore(second.state, { scope, checkpointId: second.checkpointId, after: committed, provenance: second.provenance });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.state.scopes[0]).toEqual(first.state.scopes[0]);
    expect(reconcileRestore(restored.state, { scope: SCOPE, checkpointId: first.checkpointId, after: first.after, provenance: first.provenance }).ok).toBe(true);
  });
  it("retires an unobserved crash intent only after exact full checkpoint restoration", () => {
    const f = accepted();
    const active = ready(beginWriter(f.state, { jobId: "crashed", scope: SCOPE, stage: "build", before: f.after, frozenPaths: [] }));
    const raw = JSON.stringify(active), prior = JSON.stringify(f.provenance);
    expect(reconcileRestore(active, { scope: SCOPE, checkpointId: f.checkpointId, after: f.after, paths: [], provenance: f.provenance }).ok).toBe(false);
    expect(reconcileRestore(active, { scope: SCOPE, checkpointId: f.checkpointId, after: { ...f.after, files: [] }, provenance: f.provenance }).ok).toBe(false);
    const result = reconcileRestore(active, { scope: SCOPE, checkpointId: f.checkpointId, after: f.after, provenance: f.provenance });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dispositions).toEqual([{ jobId: "crashed", disposition: "reverted" }]);
      expect(result.state.scopes[0]?.intents).toEqual([]);
      expect(result.state.scopes[0]?.liveWriterIds).toEqual(["writer-1"]);
    }
    expect(JSON.stringify(active)).toBe(raw);
    expect(JSON.stringify(f.provenance)).toBe(prior);
  });
  it("requires independently matched committed capture rather than HEAD alone", () => {
    const f = accepted();
    const result = adoptRetained(f.state, { scope: SCOPE, capture: f.after, committed: { ...f.after, files: [] },
      subject: SUBJECT, at: NOW, journal: journal(f.entry), provenance: f.provenance });
    expect(result).toEqual({ ok: false, reason: "commit_capture_mismatch" });
  });
  it("reuses immutable first-subject evidence across a later accepted subject", () => {
    const f = accepted(); f.entry.writeDisposition = "adopted";
    const next = adopt(f.state, { ...f.after, head: C }, [f.entry], f.provenance);
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.provenance.entries).toHaveLength(1);
      expect(next.provenance.entries[0]?.subject).toEqual(SUBJECT);
      expect(next.provenance.retained).toHaveLength(2);
    }
  });
  it("idempotently reuses the same adopted snapshot and checkpoint", () => {
    const f = accepted(); f.entry.writeDisposition = "adopted";
    const next = adopt(f.state, f.after, [f.entry], f.provenance);
    expect(next.ok).toBe(true);
    if (next.ok) {
      expect(next.provenance).toEqual(f.provenance);
      expect(next.checkpointId).toBe(f.checkpointId);
      expect(next.state.scopes[0]?.checkpoints).toHaveLength(1);
    }
  });
  it("rejects duplicate/corrupt prior history instead of appending to salvage", () => {
    const f = accepted();
    const raw = structuredClone(f.provenance); raw.entries.push({ ...raw.entries[0]! });
    const before = JSON.stringify(raw);
    expect(adopt(f.state, f.after, [f.entry], raw).ok).toBe(false);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it("does not adopt an active unaccounted writer as complete", () => {
    const f = accepted(); f.entry.writeDisposition = "adopted";
    const pending = writer("later"); delete pending.observation; delete pending.cleanedAt;
    const state = ready(beginWriter(f.state, { jobId: pending.jobId, scope: SCOPE, stage: "build", before: f.after, frozenPaths: [] }));
    const result = adopt(state, f.after, [f.entry, pending], f.provenance);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provenance.retained?.at(-1)?.complete).toBe(false);
  });
  it("narrows retained writers only after an exact full checkpoint restore", () => {
    const f = accepted(); f.entry.writeDisposition = "adopted";
    const later = writer("later", "codex");
    const changed = capture([{ path: "a.ts", sha256: I, mode: "100644" }], B);
    const dirty = ready(run(f.state, f.after, changed, later));
    const result = reconcileRestore(dirty, { scope: SCOPE, checkpointId: f.checkpointId, after: f.after, provenance: f.provenance });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.scopes[0]?.liveWriterIds).toEqual(["writer-1"]);
      expect(result.dispositions).toContainEqual({ jobId: "later", disposition: "reverted" });
    }
    expect(reconcileRestore(dirty, { scope: SCOPE, checkpointId: f.checkpointId, after: changed, provenance: f.provenance }).ok).toBe(false);
  });
  it("rejects a checkpoint whose HEAD does not match its referenced accepted subject", () => {
    const f = accepted(), raw = structuredClone(f.state);
    raw.scopes[0]!.checkpoints[0]!.capture.head = C;
    expect(reconcileRestore(raw, { scope: SCOPE, checkpointId: f.checkpointId, after: { ...f.after, head: C }, provenance: f.provenance }).ok).toBe(false);
  });
  it("cannot drop a stored retained writer without a matching restoration basis", () => {
    const f = accepted(), raw = structuredClone(f.state);
    raw.scopes[0]!.liveWriterIds = [];
    expect(adopt(raw, f.after, [f.entry], f.provenance).ok).toBe(false);
  });
  it("missing live-writer journal observations keep pending projection unknown", () => {
    const f = accepted();
    const result = pendingWrites(f.state, journal(), SCOPE);
    expect(result.ok && result.complete).toBe(false);
    expect(result.ok && result.pendingJobIds).toContain("writer-1");
  });
  it("an adopted journal writer absent from tracking history cannot become a fresh green baseline", () => {
    const entry = writer(); entry.writeDisposition = "adopted";
    const result = adopt(seed(), capture([], B), [entry]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provenance.retained?.[0]?.complete).toBe(false);
    const pending = pendingWrites(seed(), journal(entry), SCOPE);
    expect(pending.ok && pending.complete).toBe(false);
  });
  it("a partial path restoration keeps the job's other writes", () => {
    const f = accepted(); f.entry.writeDisposition = "adopted";
    const changed = capture([{ path: "a.ts", sha256: I, mode: "100644" }, { path: "b.ts", sha256: I, mode: "100644" }], B);
    const state = ready(run(f.state, f.after, changed, writer("later", "codex")));
    const after = capture([{ path: "a.ts", sha256: H, mode: "100644" }, { path: "b.ts", sha256: I, mode: "100644" }], B);
    const result = reconcileRestore(state, { scope: SCOPE, checkpointId: f.checkpointId, after, paths: ["a.ts"], provenance: f.provenance });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.scopes[0]?.liveWriterIds).toEqual(["writer-1", "later"]);
  });
  it("counts cumulative before/current/checkpoint fingerprints without truncation", () => {
    const f = accepted();
    const result = pendingWrites(f.state, journal(f.entry), SCOPE, { maxFiles: 1 });
    expect(result).toEqual({ ok: false, reason: "tracking_budget_exceeded" });
  });
});

describe("member-grounded frozen adoption", () => {
  const FILE = { path: "a.test.ts", sha256: H, mode: "100644" } as const;
  function freeze(state: TrackingState, cap: WorkCapture, entries: InvocationEntry[], provenance: unknown = undefined) {
    const members = cap.files.filter(f => f.path.endsWith(".test.ts")).map(f => ({ path: f.path, sha256: f.sha256 }));
    return adoptRetained(state, { scope: SCOPE, capture: cap, committed: structuredClone(cap),
      subject: { kind: "frozen_tests", featureId: "one", testSetId: frozenSetId(members) },
      frozenMembers: members, journal: journal(...entries), provenance, at: NOW });
  }
  function authored() {
    const author = writer("author-1", "claude", "ok", "test_author");
    const cap = capture([FILE]);
    const state = ready(run(seed(), capture(), cap, author));
    const frozen = freeze(state, { ...cap, head: B }, [author]);
    if (!frozen.ok) throw new Error(frozen.reason);
    return { ...frozen, author, cap: { ...cap, head: B } };
  }
  it.each(["missing", "empty-authors"] as const)("rejects damaged %s member linkage before another author", damage => {
    const f = authored(), raw = structuredClone(f.state);
    if (damage === "missing") raw.scopes[0]!.members = [];
    else raw.scopes[0]!.members[0]!.jobIds = [];
    const original = JSON.stringify(raw);
    const next = beginWriter(raw, { jobId: "author-2", scope: SCOPE, stage: "test_author", before: f.cap, frozenPaths: [FILE.path] });
    expect(next.ok).toBe(false);
    expect(JSON.stringify(raw)).toBe(original);
  });
  it("does not lose basis authors while a later intent is active", () => {
    const f = authored();
    const active = ready(beginWriter(f.state, { jobId: "author-2", scope: SCOPE, stage: "test_author", before: f.cap, frozenPaths: [FILE.path] }));
    active.scopes[0]!.members = [];
    const next = finishWriter(active, { jobId: "author-2", after: { ...f.cap, files: [{ ...FILE, sha256: I }] }, journal: journal(writer("author-2", "codex", "ok", "test_author")), testPaths: [FILE.path] });
    expect(next.ok).toBe(false);
  });
  it("keeps an unknown old member incomplete through edit, freeze, deletion and recreation", () => {
    const old = capture([FILE]), author = writer("editor", "claude", "ok", "test_author");
    const edited = capture([{ ...FILE, sha256: I }]);
    const partial = freeze(ready(run(seed(old), old, edited, author)), { ...edited, head: B }, [author]);
    expect(partial.ok).toBe(true); if (!partial.ok) return;
    expect(partial.state.scopes[0]?.members[0]?.complete).toBe(false);
    author.writeDisposition = "adopted";
    const deleter = writer("delete", "codex", "ok", "test_author"), creator = writer("recreate", "claude", "ok", "test_author");
    const empty = capture([], B), restored = { ...edited, head: B };
    const deleted = ready(run(partial.state, restored, empty, deleter));
    const recreated = ready(run(deleted, empty, restored, creator));
    expect(recreated.scopes[0]?.members[0]?.complete).toBe(false);
    expect(recreated.scopes[0]?.members[0]?.jobIds).toEqual(["editor", "delete", "recreate"]);
    const result = freeze(recreated, { ...restored, head: C }, [author, deleter, creator], partial.provenance);
    expect(result.ok && result.provenance.retained?.at(-1)?.complete).toBe(false);
  });
  it("a partial test restore retains prior author linkage and remains incomplete", () => {
    const f = authored(); f.author.writeDisposition = "adopted";
    const later = writer("author-2", "codex", "ok", "test_author");
    const changed = { ...f.cap, files: [{ ...FILE, sha256: I }] };
    const dirty = ready(run(f.state, f.cap, changed, later));
    const restored = reconcileRestore(dirty, { scope: SCOPE, checkpointId: f.checkpointId, after: f.cap, paths: [FILE.path], provenance: f.provenance });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.state.scopes[0]?.members[0]?.jobIds).toEqual(["author-1", "author-2"]);
      expect(restored.state.scopes[0]?.members[0]?.complete).toBe(false);
      expect(restored.dispositions).toEqual([]);
      const frozen = freeze(restored.state, { ...f.cap, head: C }, [f.author, later], f.provenance);
      expect(frozen.ok && frozen.provenance.retained?.at(-1)?.complete).toBe(false);
    }
  });
  it("does not repair an incomplete tombstone using a complete equal-content source", () => {
    const initial = capture([{ ...FILE, sha256: I }]), author = writer("editor", "claude", "ok", "test_author");
    const created = capture([{ ...FILE, sha256: H }, { path: "b.test.ts", sha256: H, mode: "100644" }]);
    const state = ready(run(seed(initial), initial, created, author));
    expect(state.scopes[0]?.members.map(m => m.complete)).toEqual([false, true]);
    const onlySource = capture([created.files[1]!]);
    const deleted = ready(run(state, created, onlySource, writer("delete", "codex", "ok", "test_author")));
    const recreated = ready(run(deleted, onlySource, created, writer("recreate", "claude", "ok", "test_author")));
    expect(recreated.scopes[0]?.members[0]?.complete).toBe(false);
  });
  it("replays frozen snapshot rows with reversed saved field order exactly", () => {
    const f = authored(); f.author.writeDisposition = "adopted";
    const reordered = structuredClone(f.provenance);
    reordered.retained = reordered.retained!.map(row => row.kind === "tests" ? {
      supersedes: row.supersedes!, revision: row.revision!, members: row.members.map(m => ({
        complete: m.complete, jobIds: m.jobIds, sha256: m.sha256, path: m.path,
      })), jobIds: row.jobIds, complete: row.complete,
      subject: { testSetId: row.subject.testSetId, featureId: row.subject.featureId, kind: row.subject.kind }, kind: row.kind,
    } : { supersedes: row.supersedes!, revision: row.revision!, jobIds: row.jobIds, complete: row.complete,
      subject: { commit: row.subject.commit, featureId: "one", kind: "feature_commit" }, kind: row.kind });
    const original = JSON.stringify(reordered);
    const result = freeze(f.state, f.cap, [f.author], reordered);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.provenance)).toBe(original);
      expect(result.checkpointId).toBe(f.checkpointId);
    }
  });
  it("records separate author and code snapshots at the accepted capture", () => {
    const f = authored();
    expect(f.provenance.retained?.map(s => s.kind)).toEqual(["writes", "tests"]);
    expect(f.provenance.retained?.[0]?.jobIds).toEqual([]);
    expect(f.provenance.retained?.[1]?.jobIds).toEqual(["author-1"]);
    expect(f.provenance.entries[0]?.stage).toBe("test_author");
  });
  it("unions changed member authors and carries unchanged member authors", () => {
    const f = authored(); f.author.writeDisposition = "adopted";
    const author = writer("author-2", "codex", "ok", "test_author");
    const cap = capture([{ ...FILE, sha256: I }, { path: "b.test.ts", sha256: H, mode: "100644" }], B);
    const state = ready(run(f.state, f.cap, cap, author));
    const result = freeze(state, { ...cap, head: C }, [f.author, author], f.provenance);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const snapshot = result.provenance.retained?.at(-1);
      expect(snapshot?.kind === "tests" && snapshot.members[0]?.jobIds).toEqual(["author-1", "author-2"]);
      expect(snapshot?.kind === "tests" && snapshot.members[1]?.jobIds).toContain("author-1");
    }
  });
  it("wrong-stage frozen test edits retain known authors and become incomplete", () => {
    const f = authored(); f.author.writeDisposition = "adopted";
    const builder = writer("builder-1", "codex");
    const cap = capture([{ ...FILE, sha256: I }], B);
    const state = ready(run(f.state, f.cap, cap, builder, [FILE.path]));
    const result = freeze(state, { ...cap, head: C }, [f.author, builder], f.provenance);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const snapshot = result.provenance.retained?.at(-1);
      expect(snapshot?.kind === "tests" && snapshot.members[0]?.jobIds).toEqual(["author-1"]);
      expect(snapshot?.complete).toBe(false);
      expect(result.provenance.entries.find(e => e.jobId === "builder-1")?.stage).toBe("build");
    }
  });
  it("does not label non-test writes by a test author as builder contributions", () => {
    const author = writer("author-1", "claude", "ok", "test_author");
    const cap = capture([FILE, { path: "app.ts", sha256: H, mode: "100644" }]);
    const state = ready(run(seed(), capture(), cap, author));
    const result = freeze(state, { ...cap, head: B }, [author]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.retained?.[0]?.jobIds).toEqual([]);
      expect(result.provenance.retained?.[0]?.complete).toBe(false);
    }
  });
  it("keeps carried builders across a content-exact restack commit bridge", () => {
    const builder = writer("builder", "claude", "failed");
    const code = capture([{ path: "app.ts", sha256: H, mode: "100644" }]);
    const state1 = ready(run(seed(), capture(), code, builder));
    const author = writer("author", "codex", "ok", "test_author");
    const rewritten = capture([FILE, ...code.files].sort((a,b) => a.path < b.path ? -1 : 1));
    const state2 = ready(run(state1, code, rewritten, author));
    const result = freeze(state2, { ...rewritten, head: C }, [builder, author]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provenance.retained?.[0]?.jobIds).toEqual(["builder"]);
      expect(result.provenance.retained?.[1]?.jobIds).toEqual(["author"]);
      expect(result.provenance.retained?.every(s => s.complete)).toBe(true);
    }
  });
  it("full restoration of a frozen checkpoint preserves its distinct author mapping", () => {
    const f = authored(); f.author.writeDisposition = "adopted";
    const later = writer("later", "codex", "ok", "test_author");
    const cap = capture([{ ...FILE, sha256: I }], B);
    const state = ready(run(f.state, f.cap, cap, later));
    const restored = reconcileRestore(state, { scope: SCOPE, checkpointId: f.checkpointId, after: f.cap, provenance: f.provenance });
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.state.scopes[0]?.members[0]?.jobIds).toEqual(["author-1"]);
  });
});
describe("strict review evidence append", () => {
  const entry = { jobId: "review-1", scope: SCOPE, stage: "review", actual: { provider: "claude", model: "recorded-model", family: "claude" },
    outcome: "completed", at: NOW, subject: SUBJECT } as const;
  it("adds a review without tracking and exact repetition is idempotent", () => {
    const first = appendReviewEvidence(undefined, entry);
    expect(first.ok).toBe(true);
    if (first.ok) expect(appendReviewEvidence(first.provenance, entry)).toEqual(first);
  });
  it("rejects same-job changed subject or identity and corrupt prior history", () => {
    const first = appendReviewEvidence(undefined, entry);
    if (!first.ok) throw new Error(first.reason);
    expect(appendReviewEvidence(first.provenance, { ...entry, subject: { ...SUBJECT, commit: C } }).ok).toBe(false);
    expect(appendReviewEvidence({ ...first.provenance, entries: [...first.provenance.entries, entry] }, entry).ok).toBe(false);
    expect(appendReviewEvidence(undefined, { ...entry, stage: "build" }).ok).toBe(false);
  });
});

describe("capture and mutation validation boundaries", () => {
  it.each([
    { root: "/work/../project" }, { root: "relative" }, { universe: "unknown" }, { scope: { kind: "plan" } },
    { head: null }, { complete: undefined }, { files: [{ path: "../escape", sha256: H, mode: "100644" }] },
    { files: [{ path: "a", sha256: H, mode: "100600" }] },
    { files: [{ path: "b", sha256: H, mode: "100644" }, { path: "a", sha256: H, mode: "100644" }] },
    { files: [{ path: "a", sha256: H, mode: "100644" }, { path: "a", sha256: H, mode: "100644" }] },
  ])("refuses malformed full capture %j without modifying its input", (damage) => {
    const raw = { ...capture(), ...damage } as WorkCapture;
    const before = JSON.stringify(raw);
    expect(initializeTracking(raw).ok).toBe(false);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it.each([{ head: B }, { complete: false }])("does not use no-delta proof for changed/incomplete anchor %j", (change) => {
    const before = capture(), after = { ...before, ...change };
    const result = run(seed(), before, after);
    expect(result.ok && result.retention).not.toBe("none");
  });
  it("executable-mode changes are retained deltas even with equal content hashes", () => {
    const before = capture([{ path: "script", sha256: H, mode: "100644" }]);
    const after = capture([{ path: "script", sha256: H, mode: "100755" }]);
    const result = run(seed(before), before, after);
    expect(result.ok).toBe(true);
    expect(result.ok && result.retention).toBe("possible");
  });
  it("a read-only journal row cannot be promoted into writer credit", () => {
    const begun = ready(beginWriter(seed(), { jobId: "writer-1", scope: SCOPE, stage: "build", before: capture(), frozenPaths: [] }));
    const entry = writer(); entry.access = "read-only"; entry.writeDisposition = "none";
    expect(finishWriter(begun, { jobId: entry.jobId, after: capture(), journal: journal(entry) }).ok).toBe(false);
  });
  it.each([
    { maxScopes: 0 }, { maxJobs: Infinity }, { maxFiles: undefined }, { maxReferences: -1 }, { maxCheckpoints: Number.NaN },
  ])("rejects malformed explicit cap %j", (limits) => {
    expect(initializeTracking(capture(), {}, limits).ok).toBe(false);
  });
  it("missing classifier leaves test-author writes unknown rather than assuming every file is a test", () => {
    const author = writer("author", "claude", "ok", "test_author");
    const begun = ready(beginWriter(seed(), { jobId: author.jobId, scope: SCOPE, stage: "test_author", before: capture(), frozenPaths: [] }));
    const cap = capture([{ path: "app.ts", sha256: H, mode: "100644" }]);
    const finished = finishWriter(begun, { jobId: author.jobId, after: cap, journal: journal(author) });
    expect(finished.ok).toBe(true);
    if (finished.ok) {
      expect(finished.state.scopes[0]?.complete).toBe(false);
      expect(finished.state.scopes[0]?.members[0]?.jobIds).toEqual([]);
    }
  });
  it("preserves deleted test authors through exact-path recreation", () => {
    const author1 = writer("author-1", "claude", "ok", "test_author");
    const author2 = writer("author-2", "codex", "ok", "test_author");
    const author3 = writer("author-3", "codex", "ok", "test_author");
    const file = { path: "a.test.ts", sha256: H, mode: "100644" } as const;
    const created = ready(run(seed(), capture(), capture([file]), author1));
    const deleted = ready(run(created, capture([file]), capture(), author2));
    const restored = ready(run(deleted, capture(), capture([file]), author3));
    expect(restored.scopes[0]?.members[0]?.jobIds).toEqual(["author-1", "author-2", "author-3"]);
  });
  it("a byte-identical renamed test carries its known prior authors conservatively", () => {
    const a = writer("author-1", "claude", "ok", "test_author"), b = writer("author-2", "codex", "ok", "test_author");
    const before = capture([{ path: "old.test.ts", sha256: H, mode: "100644" }]);
    const state = ready(run(seed(), capture(), before, a));
    const after = capture([{ path: "new.test.ts", sha256: H, mode: "100644" }]);
    const next = ready(run(state, before, after, b));
    expect(next.scopes[0]?.members.find(m => m.path === "new.test.ts")?.jobIds).toEqual(["author-1", "author-2"]);
  });
});
describe("strict provenance history and review scope", () => {
  const valid = { jobId: "review", scope: SCOPE, stage: "review", actual: { provider: "codex", model: "actual", family: "codex" },
    outcome: "completed", at: NOW, subject: SUBJECT } as const;
  it.each([
    { scope: { kind: "application" } }, { subject: undefined }, { actual: undefined }, { actual: { family: "codex" } },
    { actual: { provider: "claude", model: "actual", family: "codex" } }, { at: "2026-02-30T00:00:00.000Z" },
    { jobId: "raw\nsecret" }, { stage: "test_author" },
  ])("rejects malformed/new incomplete review credit %j", (damage) => {
    const raw = { ...valid, ...damage };
    const before = JSON.stringify(raw);
    expect(appendReviewEvidence(undefined, raw as unknown as import("./provenance.js").WorkEvidence).ok).toBe(false);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it("accepts exact plan/final stage scopes without relabeling feature reviews", () => {
    expect(appendReviewEvidence(undefined, { ...valid, jobId: "plan", scope: { kind: "plan" }, stage: "plan_review", subject: { kind: "plan", planHash: H } }).ok).toBe(true);
    expect(appendReviewEvidence(undefined, { ...valid, jobId: "final", scope: { kind: "application" }, stage: "final_review", subject: { kind: "application_commit", commit: B } }).ok).toBe(true);
  });
  it("rejects a malformed prior snapshot revision instead of filtering it out", () => {
    const builder = writer(), cap = capture([{ path: "a.ts", sha256: H, mode: "100644" }]);
    const result = adopt(ready(run(seed(), capture(), cap, builder)), { ...cap, head: B });
    if (!result.ok) throw new Error(result.reason);
    const damaged = structuredClone(result.provenance);
    Object.assign(damaged.retained![0]!, { revision: undefined, supersedes: undefined });
    const before = JSON.stringify(damaged);
    const rejected = appendReviewEvidence(damaged, valid);
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(damaged)).toBe(before);
  });
});

describe("strict application snapshot append", () => {
  const entry = { jobId: "scaffold", scope: { kind: "application" }, stage: "build",
    actual: { provider: "claude", model: "actual", family: "claude" }, outcome: "completed", at: NOW,
    subject: { kind: "application_commit", commit: A } } as const;
  const snapshot = { kind: "writes", subject: { kind: "application_commit", commit: B }, complete: true, jobIds: ["scaffold"],
    baseline: { kind: "recorded_baseline", commit: A }, featureRefs: [{ featureId: "one", passingCommit: A, mergeCommit: B, snapshotRevision: 1 }] } as const;
  const input = () => ({ ...snapshot, jobIds: [...snapshot.jobIds], featureRefs: snapshot.featureRefs.map(r => ({ ...r })) });
  it("appends a new aggregate head without relabeling feature writers, then exact-reuses", () => {
    const first = appendApplicationSnapshot({ version: 1, entries: [entry], retained: [] }, input());
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.revision).toBe(1);
      expect(first.provenance.entries).toEqual([entry]);
      expect(appendApplicationSnapshot(first.provenance, input())).toEqual(first);
    }
  });
  it("rejects duplicate refs and unusable writer references without mutating prior data", () => {
    const prior = { version: 1 as const, entries: [entry], retained: [] };
    const before = JSON.stringify(prior);
    const duplicate = input(); duplicate.featureRefs.push({ ...duplicate.featureRefs[0]! });
    expect(appendApplicationSnapshot(prior, duplicate).ok).toBe(false);
    expect(appendApplicationSnapshot(prior, { ...input(), jobIds: ["missing"] }).ok).toBe(false);
    expect(JSON.stringify(prior)).toBe(before);
  });
  it.each([false, true])("replays semantically equal reversed-key snapshots without appending (revisioned=%s)", revisioned => {
    const reordered = { featureRefs: input().featureRefs.map(r => ({ snapshotRevision: r.snapshotRevision, mergeCommit: r.mergeCommit, passingCommit: r.passingCommit, featureId: r.featureId })),
      baseline: { commit: A, kind: "recorded_baseline" }, jobIds: ["scaffold"], complete: true,
      subject: { commit: B, kind: "application_commit" }, kind: "writes",
      ...(revisioned ? { supersedes: null, revision: 1 } : {}) };
    const prior = { version: 1, entries: [entry], retained: [reordered] }, original = JSON.stringify(prior);
    const result = appendApplicationSnapshot(prior, input());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.revision).toBe(revisioned ? 1 : null);
      expect(JSON.stringify(result.provenance)).toBe(original);
    }
    expect(JSON.stringify(prior)).toBe(original);
  });
  it("never rewrites or mixes a changed legacy snapshot", () => {
    const legacy = input();
    const prior = { version: 1 as const, entries: [entry], retained: [legacy] };
    const repeated = appendApplicationSnapshot(prior, input());
    expect(repeated.ok && repeated.revision).toBeNull();
    expect(appendApplicationSnapshot(prior, { ...input(), complete: false }).ok).toBe(false);
  });
});

describe("RC02 interrupted writer recovery", () => {
  const FILE = {path:"surviving.test.ts",sha256:H,mode:"100644"} as const;
  function interrupted(observed=false, finished=false) {
    const base=adopt(seed(),capture(),[]);
    if(!base.ok)throw Error(base.reason);
    const old=writer("interrupted","claude","failed","test_author");
    delete old.cleanedAt;
    if(!observed)delete old.observation;
    let state=ready(beginWriter(base.state,{jobId:old.jobId,scope:SCOPE,stage:old.stage,before:capture(),frozenPaths:[]}));
    const after=capture([FILE]);
    if(finished)state=ready(finishWriter(state,{jobId:old.jobId,after,journal:journal(old),testPaths:[FILE.path]}));
    const invocationState={agentRuns:1,invocations:journal(old)};
    recoverInvocations(invocationState,undefined,{},NOW,()=>{});
    const durable=invocationState.invocations;
    const reap={jobId:old.jobId,recoveryKey:"job:"+old.jobId,at:NOW};
    return {base,state,after,reap,journal:durable,old:durable.entries[0]!};
  }
  function recovered(observed=false,finished=false) {
    const f=interrupted(observed,finished);
    const result=recoverInterruptedWriter(f.state,{jobId:f.old.jobId,after:f.after,journal:f.journal,reap:f.reap,testPaths:[FILE.path]});
    return {...f,state:ready(result)};
  }
  function partial(observed=false,finished=false) {
    const f=recovered(observed,finished), last=writer("last","codex","ok","test_author");
    const after=capture([{...FILE,sha256:I}]);
    const state=ready(run(f.state,f.after,after,last));
    const completeJournal={...f.journal,entries:[...f.journal.entries,last]};
    const accepted={...after,head:B}, members=[{path:FILE.path,sha256:I}];
    const result=adoptRetained(state,{scope:SCOPE,capture:accepted,committed:accepted,
      subject:{kind:"frozen_tests",featureId:"one",testSetId:frozenSetId(members)},at:NOW,journal:completeJournal,
      provenance:f.base.provenance,frozenMembers:members});
    if(!result.ok)throw Error(result.reason);
    return {...f,...result,accepted,last,members,journal:completeJournal};
  }
  it("allows later known authors and partial adoption without fabricating the interrupted identity",()=>{
    const f=partial(), snapshot=f.provenance.retained?.at(-1);
    expect(f.provenance.entries.map(e=>e.jobId)).toEqual(["last"]);
    expect(snapshot?.kind==="tests"&&snapshot.members[0]?.jobIds).toEqual(["last"]);
    expect(snapshot?.complete).toBe(false);
    expect(f.state.scopes[0]?.members[0]?.jobIds).toEqual(["interrupted","last"]);
    expect(f.state.scopes[0]?.liveWriterIds).toEqual(["interrupted","last"]);
    expect(f.dispositions).toEqual([{jobId:"last",disposition:"adopted"}]);
    expect(f.old.observation).toBeUndefined();expect(f.old.cleanedAt).toBeUndefined();
    expect(pendingWrites(f.state,f.journal,SCOPE).ok).toBe(true);
    const facts=interpretProvenance(f.provenance,{subject:{kind:"frozen_tests",featureId:"one",testSetId:frozenSetId(f.members)},
      hasPendingWrites:true,frozenMembers:f.members,maxEntries:100,maxSnapshots:100});
    expect(facts.contributorFamilies).toEqual(["codex"]);expect(facts.contributionsComplete).toBe(false);
    const cp=f.state.scopes[0]!.checkpoints.find(c=>c.id===f.checkpointId)!;
    expect(cp.unresolvedWriterIds).toEqual(["interrupted"]);expect(cp.liveWriterIds).toEqual(["last"]);
  });
  it.each([false,true])("observed but uncleaned recovery (already finished=%s) stays uncredited",finished=>{
    const f=partial(true,finished);
    expect(f.old.observation?.actual.family).toBe("claude");
    expect(f.old.cleanedAt).toBeUndefined();
    expect(f.provenance.entries.map(e=>e.jobId)).toEqual(["last"]);
    expect(f.state.scopes[0]?.members[0]?.complete).toBe(false);
  });
  it("replay cannot rewind the capture after a later writer",()=>{
    const f=recovered(), last=writer("last","codex","ok","test_author"), after=capture([{...FILE,sha256:I}]);
    const state=ready(run(f.state,f.after,after,last));
    const replay=recoverInterruptedWriter(state,{jobId:f.old.jobId,after:f.after,journal:f.journal,reap:f.reap,testPaths:[FILE.path]});
    expect(replay.ok&&replay.replayed).toBe(true);expect(replay.ok&&replay.state).toEqual(state);
    expect(recoverInterruptedWriter(state,{jobId:f.old.jobId,after,journal:f.journal,reap:f.reap,testPaths:[FILE.path]}).ok).toBe(false);
  });
  it("rejects a newly supplied backdated replay receipt without changing recovered state",()=>{
    const f=recovered(), before=JSON.stringify(f.state), durable=JSON.stringify(f.journal);
    const result=recoverInterruptedWriter(f.state,{jobId:f.old.jobId,after:f.after,journal:f.journal,
      reap:{...f.reap,at:"2026-10-30T00:00:00.000Z"},testPaths:[FILE.path]});
    expect(result).toEqual({ok:false,reason:"invalid_recovery_receipt"});
    expect(JSON.stringify(f.state)).toBe(before);expect(JSON.stringify(f.journal)).toBe(durable);
  });
  it("interrupted byte-identical test rename carries prior known authors through later rewriting",()=>{
    const first=writer("first","claude","ok","test_author"), a={path:"a.test.ts",sha256:H,mode:"100644"} as const;
    const initial=capture([a]), members=[{path:a.path,sha256:H}];
    const accepted=adoptRetained(ready(run(seed(),capture(),initial,first)),{scope:SCOPE,capture:{...initial,head:B},committed:{...initial,head:B},
      subject:{kind:"frozen_tests",featureId:"one",testSetId:frozenSetId(members)},at:NOW,journal:journal(first),provenance:undefined,frozenMembers:members});
    if(!accepted.ok)throw Error(accepted.reason);first.writeDisposition="adopted";
    const unknown=writer("unknown","claude","failed","test_author");delete unknown.observation;delete unknown.cleanedAt;
    const before={...initial,head:B}, renamed=capture([{...a,path:"b.test.ts"}],B);
    const active=ready(beginWriter(accepted.state,{jobId:unknown.jobId,scope:SCOPE,stage:"test_author",before,frozenPaths:[]}));
    const m={agentRuns:2,invocations:journal(first,unknown)};recoverInvocations(m,undefined,{},NOW,()=>{});
    const recovered=ready(recoverInterruptedWriter(active,{jobId:unknown.jobId,after:renamed,journal:m.invocations,
      reap:{jobId:unknown.jobId,recoveryKey:"job:"+unknown.jobId,at:NOW},testPaths:[a.path,"b.test.ts"]}));
    const last=writer("last","codex","ok","test_author"), rewritten=capture([{...a,path:"b.test.ts",sha256:I}],B);
    const state=ready(run(recovered,renamed,rewritten,last)), finalMembers=[{path:"b.test.ts",sha256:I}];
    const result=adoptRetained(state,{scope:SCOPE,capture:{...rewritten,head:C},committed:{...rewritten,head:C},
      subject:{kind:"frozen_tests",featureId:"one",testSetId:frozenSetId(finalMembers)},at:NOW,
      journal:{...m.invocations,entries:[...m.invocations.entries,last]},provenance:accepted.provenance,frozenMembers:finalMembers});
    expect(result.ok).toBe(true);
    if(result.ok){const tests=result.provenance.retained?.at(-1);
      expect(tests?.kind==="tests"&&tests.members[0]?.jobIds).toEqual(["first","last"]);expect(tests?.complete).toBe(false);}
  });
  it("retired unresolved job IDs cannot be reused through historical checkpoints",()=>{
    const f=partial(), restored=reconcileRestore(f.state,{scope:SCOPE,checkpointId:f.base.checkpointId,after:capture(),provenance:f.provenance});
    if(!restored.ok)throw Error(restored.reason);
    expect(beginWriter(restored.state,{jobId:"interrupted",scope:SCOPE,stage:"test_author",before:capture(),frozenPaths:[]}).ok).toBe(false);
  });
  it.each(["recovery","pending-membership"] as const)("damaged %s stays raw and invalid",kind=>{
    const f=partial(), raw=structuredClone(f.state);
    if(kind==="recovery")(raw.scopes[0]!.intents[0] as unknown as Record<string,unknown>).recovery=undefined;
    else (raw.scopes[0]!.checkpoints.at(-1) as unknown as Record<string,unknown>).unresolvedWriterIds=undefined;
    const before=JSON.stringify(raw);
    expect(pendingWrites(raw,f.journal,SCOPE).ok).toBe(false);expect(JSON.stringify(raw)).toBe(before);
  });
  it("recovery obeys cumulative bounds and does not change raw state on overflow",()=>{
    const f=interrupted(), before=JSON.stringify(f.state);
    const result=recoverInterruptedWriter(f.state,{jobId:f.old.jobId,after:f.after,journal:f.journal,reap:f.reap,testPaths:[FILE.path]},{maxReferences:1});
    expect(result).toEqual({ok:false,reason:"tracking_budget_exceeded"});expect(JSON.stringify(f.state)).toBe(before);
  });
  it("restoring the partial checkpoint preserves its unresolved intent",()=>{
    const f=partial();
    const result=reconcileRestore(f.state,{scope:SCOPE,checkpointId:f.checkpointId,after:f.accepted,provenance:f.provenance});
    expect(result.ok).toBe(true);
    if(result.ok){expect(result.state.scopes[0]?.intents.map(i=>i.jobId)).toEqual(["interrupted"]);
      expect(result.dispositions).toEqual([]);expect(result.state.scopes[0]?.complete).toBe(false);}
  });
  it("an exact old checkpoint can retire the unknown intent, but cannot later rehydrate it from partial history",()=>{
    const f=partial();
    const restored=reconcileRestore(f.state,{scope:SCOPE,checkpointId:f.base.checkpointId,after:capture(),provenance:f.provenance});
    expect(restored.ok).toBe(true);if(!restored.ok)return;
    expect(restored.dispositions).toContainEqual({jobId:"interrupted",disposition:"reverted"});
    expect(restored.state.scopes[0]?.intents).toEqual([]);
    const prior=JSON.stringify(restored.state);
    expect(reconcileRestore(restored.state,{scope:SCOPE,checkpointId:f.checkpointId,after:f.accepted,provenance:f.provenance}).ok).toBe(false);
    expect(JSON.stringify(restored.state)).toBe(prior);
  });
  it.each(["incomplete","root","job","key","time","missing-recovery"] as const)("rejects unsupported recovery proof %s without changing input",kind=>{
    const f=interrupted(), args={jobId:f.old.jobId,after:structuredClone(f.after),journal:structuredClone(f.journal),reap:{...f.reap},testPaths:[FILE.path]};
    if(kind==="incomplete")args.after.complete=false;
    if(kind==="root")args.after.root="/different";
    if(kind==="job")args.reap.jobId="different";
    if(kind==="key")args.reap.recoveryKey="job:different";
    if(kind==="time")args.reap.at="2026-10-30T00:00:00.000Z";
    if(kind==="missing-recovery"){args.journal.recoveries=[];args.journal.interruptionCounts={};}
    const prior=JSON.stringify(f.state);
    expect(recoverInterruptedWriter(f.state,args).ok).toBe(false);expect(JSON.stringify(f.state)).toBe(prior);
  });
});
