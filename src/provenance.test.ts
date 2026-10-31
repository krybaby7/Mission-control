// Authored under the former testing hold. Execution evidence is recorded in the reconstruction ledger.
import { describe, expect, it } from "vitest";
import { interpretProvenance, type Provenance, type ProvenanceContext, type RetainedSnapshot, type WorkEvidence, type WorkSubject } from "./provenance.js";
import type { Family } from "./types.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const HASH = "c".repeat(64);
const OTHER_HASH = "d".repeat(64);
const NOW = "2026-10-31T00:00:00.000Z";
const FEATURE = { kind: "feature_commit", featureId: "one", commit: A } as const satisfies WorkSubject;
const TESTS = { kind: "frozen_tests", featureId: "one", testSetId: HASH } as const satisfies WorkSubject;
const APP = { kind: "application_commit", commit: A } as const satisfies WorkSubject;
const PLAN: WorkSubject = { kind: "plan", planHash: HASH };

function context(subject: WorkSubject = FEATURE, extra: Partial<ProvenanceContext> = {}): ProvenanceContext {
  return { subject, hasPendingWrites: false, maxEntries: 20, maxSnapshots: 20, ...extra };
}

function work(jobId: string, family: Family, extra: Partial<WorkEvidence> = {}): WorkEvidence {
  return {
    jobId, scope: { kind: "feature", featureId: "one" }, stage: "build",
    actual: { provider: family, model: `recorded-${family}`, family }, outcome: "completed", at: NOW, subject: FEATURE, ...extra,
  };
}

function review(jobId = "review", family: Family = "codex", extra: Partial<WorkEvidence> = {}): WorkEvidence {
  return work(jobId, family, { stage: "review", ...extra });
}

function writes(jobIds = ["builder"], extra: Partial<Extract<RetainedSnapshot, { kind: "writes" }>> = {}): RetainedSnapshot {
  return { kind: "writes", subject: FEATURE, complete: true, jobIds, ...extra } as RetainedSnapshot;
}

function envelope(entries = [work("builder", "claude"), review()], retained: RetainedSnapshot[] = [writes()]): Provenance {
  return { version: 1, entries, retained };
}

function frozen(): { envelope: Provenance; context: ProvenanceContext } {
  const members = [{ path: "tests/kept.test.ts", sha256: HASH }, { path: "tests/replaced.test.ts", sha256: OTHER_HASH }];
  return {
    context: context(TESTS, { frozenMembers: members }),
    envelope: envelope([
      work("original-author", "claude", { stage: "test_author", subject: TESTS }),
      work("replacement-author", "codex", { stage: "test_author", subject: TESTS }),
    ], [{
      kind: "tests", subject: TESTS, complete: true, jobIds: ["original-author", "replacement-author"],
      members: members.map((member, i) => ({ ...member, complete: true, jobIds: [i === 0 ? "original-author" : "replacement-author"] })),
    }]),
  };
}

describe("inactive provenance reader: current retained evidence", () => {
  it("PC06 records distinct actual families without inventing checks or approvals", () => {
    const summary = interpretProvenance(envelope(), context());
    expect(summary).toEqual({
      contributorJobIds: ["builder"], contributorFamilies: ["claude"], contributionsComplete: true,
      currentReviews: [{ jobId: "review", actual: { provider: "codex", model: "recorded-codex", family: "codex" }, subject: FEATURE, at: NOW, relationship: "different_family", overlappingFamilies: [] }],
      uncertainties: [],
    });
  });

  it("PC01 retains the failed first writer across successful executor failover", () => {
    const data = envelope([work("first", "claude", { outcome: "failed" }), work("last", "codex"), review("review", "claude")], [writes(["first", "last"])]);
    const summary = interpretProvenance(data, context());
    expect(summary.contributorFamilies).toEqual(["claude", "codex"]);
    expect(summary.contributionsComplete).toBe(true);
    expect(summary.currentReviews[0]?.relationship).toBe("same_family");
    expect(summary.currentReviews[0]?.overlappingFamilies).toEqual(["claude"]);
  });

  it("PC02 excludes an explicitly reverted invocation only through the controller snapshot", () => {
    const data = envelope([work("reverted", "claude", { outcome: "failed" }), work("builder", "codex"), review("review", "claude")], [writes()]);
    const summary = interpretProvenance(data, context());
    expect(summary.contributorJobIds).toEqual(["builder"]);
    expect(summary.currentReviews[0]?.relationship).toBe("different_family");
  });

  it("PC02 unknown retention prevents independence while preserving known overlap", () => {
    const summary = interpretProvenance(envelope([work("builder", "claude"), review("review", "claude")], [writes(["builder", "unidentified"], { complete: false })]), context());
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.contributorFamilies).toEqual(["claude"]);
    expect(summary.currentReviews[0]?.relationship).toBe("same_family");
  });

  it("accepts an incomplete failed writer without a settled subject when explicitly retained", () => {
    const summary = interpretProvenance(envelope([work("builder", "claude", { outcome: "incomplete", subject: undefined }), review()], [writes()]), context());
    expect(summary.contributionsComplete).toBe(true);
    expect(summary.contributorFamilies).toEqual(["claude"]);
  });

  it("PC04 keeps earlier writers and adds a repair, without crediting the earlier review", () => {
    const next: WorkSubject = { kind: "feature_commit", featureId: "one", commit: B };
    const data = envelope([work("builder", "claude"), review(), work("repair", "codex", { stage: "fix", subject: next })], [writes(), writes(["builder", "repair"], { subject: next })]);
    const summary = interpretProvenance(data, context(next));
    expect(summary.contributorFamilies).toEqual(["claude", "codex"]);
    expect(summary.contributionsComplete).toBe(true);
    expect(summary.currentReviews).toEqual([]);
    expect(summary.uncertainties).toContain("stale_review");
  });

  it("keeps each current reviewer relationship separate", () => {
    const summary = interpretProvenance(envelope([work("builder", "claude"), review("same", "claude"), review("different", "codex")]), context());
    expect(summary.currentReviews.map((r) => r.relationship)).toEqual(["same_family", "different_family"]);
  });

  it("does not translate premerge review credit to an integration merge subject", () => {
    expect(interpretProvenance(envelope(), context({ kind: "feature_commit", featureId: "one", commit: B })).currentReviews).toEqual([]);
  });

  it("deduplicates families from different actual jobs without conflating their identities", () => {
    const summary = interpretProvenance(envelope([work("a", "claude"), work("b", "claude"), review()], [writes(["a", "b"])]), context());
    expect(summary.contributorJobIds).toEqual(["a", "b"]);
    expect(summary.contributorFamilies).toEqual(["claude"]);
  });
});

describe("PC03 retained frozen-test authorship", () => {
  it("preserves original authors of retained files beside replacement-file authors", () => {
    const fixture = frozen();
    const summary = interpretProvenance(fixture.envelope, fixture.context);
    expect(summary.contributorFamilies).toEqual(["claude", "codex"]);
    expect(summary.contributionsComplete).toBe(true);
    expect(summary.currentReviews).toEqual([]);
  });

  it("preserves known authors when one retained member has incomplete authorship", () => {
    const fixture = frozen();
    const snapshot = fixture.envelope.retained![0] as Extract<RetainedSnapshot, { kind: "tests" }>;
    snapshot.members[0]!.complete = false;
    snapshot.members[0]!.jobIds = ["unknown-author"];
    snapshot.jobIds = ["unknown-author", "replacement-author"];
    const summary = interpretProvenance(fixture.envelope, fixture.context);
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.contributorFamilies).toEqual(["codex"]);
    expect(summary.uncertainties).toContain("incomplete_test_authorship");
  });

  it("retains partial author-family evidence when another member is malformed", () => {
    const fixture = frozen();
    const snapshot = fixture.envelope.retained![0] as Extract<RetainedSnapshot, { kind: "tests" }>;
    snapshot.members[0]!.sha256 = "wrong";
    const summary = interpretProvenance(fixture.envelope, fixture.context);
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.contributorFamilies).toEqual(["codex"]);
    expect(summary.contributorJobIds).toEqual(["replacement-author"]);
  });

  it("does not attribute an extra top-level author without a valid current member", () => {
    const fixture = frozen();
    fixture.envelope.entries[0]!.actual = { provider: "codex", model: "recorded-codex", family: "codex" };
    fixture.envelope.entries.push(work("ungrounded-author", "claude", { stage: "test_author", subject: TESTS }));
    const snapshot = fixture.envelope.retained![0] as Extract<RetainedSnapshot, { kind: "tests" }>;
    snapshot.jobIds.push("ungrounded-author");
    const summary = interpretProvenance(fixture.envelope, fixture.context);
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.contributorJobIds).toEqual(["original-author", "replacement-author"]);
    expect(summary.contributorJobIds).not.toContain("ungrounded-author");
    expect(summary.contributorFamilies).toEqual(["codex"]);
  });

  it("does not attribute an author whose only current member is missing", () => {
    const fixture = frozen();
    const snapshot = fixture.envelope.retained![0] as Extract<RetainedSnapshot, { kind: "tests" }>;
    snapshot.members.shift();
    const summary = interpretProvenance(fixture.envelope, fixture.context);
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.contributorJobIds).toEqual(["replacement-author"]);
    expect(summary.contributorFamilies).toEqual(["codex"]);
  });

  it("excludes every author of a duplicated path while retaining unique current members", () => {
    const fixture = frozen();
    fixture.context.frozenMembers!.push({ path: "tests/missing.test.ts", sha256: HASH });
    fixture.envelope.entries.push(work("conflicting-author", "codex", { stage: "test_author", subject: TESTS }));
    const snapshot = fixture.envelope.retained![0] as Extract<RetainedSnapshot, { kind: "tests" }>;
    snapshot.members.push({ ...snapshot.members[0]!, jobIds: ["conflicting-author"] });
    snapshot.jobIds.push("conflicting-author");
    const summary = interpretProvenance(fixture.envelope, fixture.context);
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.contributorJobIds).toEqual(["replacement-author"]);
    expect(summary.contributorFamilies).toEqual(["codex"]);
    expect(summary.contributorJobIds).not.toContain("original-author");
    expect(summary.contributorJobIds).not.toContain("conflicting-author");
  });

  it.each(["missing", "extra", "duplicate", "hash", "union"])("refuses %s member coverage", (damage) => {
    const fixture = frozen();
    const snapshot = fixture.envelope.retained![0] as Extract<RetainedSnapshot, { kind: "tests" }>;
    if (damage === "missing") snapshot.members.pop();
    if (damage === "extra") snapshot.members.push({ path: "tests/extra.ts", sha256: HASH, jobIds: ["original-author"], complete: true });
    if (damage === "duplicate") snapshot.members[1] = { ...snapshot.members[0]! };
    if (damage === "hash") snapshot.members[0]!.sha256 = OTHER_HASH;
    if (damage === "union") snapshot.jobIds = ["replacement-author"];
    expect(interpretProvenance(fixture.envelope, fixture.context).contributionsComplete).toBe(false);
  });

  it("can salvage valid member author IDs when the top-level contributor list is invalid", () => {
    const fixture = frozen();
    (fixture.envelope.retained![0] as unknown as Record<string, unknown>).jobIds = null;
    const summary = interpretProvenance(fixture.envelope, fixture.context);
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.contributorFamilies).toEqual(["claude", "codex"]);
  });

  it.each(["/absolute", "../outside", "a/../b", "a//b", "a/./b", "C:/drive", "a\\b", "", " ", "a\u0000b"])("rejects noncanonical member path %j", (path) => {
    const fixture = frozen();
    const snapshot = fixture.envelope.retained![0] as Extract<RetainedSnapshot, { kind: "tests" }>;
    snapshot.members[0]!.path = path;
    fixture.context.frozenMembers![0]!.path = path;
    expect(interpretProvenance(fixture.envelope, fixture.context).contributionsComplete).toBe(false);
  });
});

describe("PC05 damaged provenance cannot earn credit", () => {
  it("loads an old absent record as unknown without requested-identity backfill", () => {
    expect(interpretProvenance(undefined, context())).toEqual({ contributorJobIds: [], contributorFamilies: [], contributionsComplete: false, currentReviews: [], uncertainties: ["identity_not_recorded"] });
  });

  it.each([null, {}, { version: 2, entries: [] }, { version: 1, entries: null }, { version: 1, entries: [], retained: {} }])("rejects unusable envelope %j", (value) => {
    const summary = interpretProvenance(value, context());
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.currentReviews).toEqual([]);
    expect(summary.contributorFamilies).toEqual([]);
  });

  it.each([
    undefined, { kind: "feature_commit", featureId: "one", commit: "" },
    { kind: "feature_commit", featureId: "one", commit: A.slice(0, 8) },
    { kind: "feature_commit", featureId: "other", commit: A },
    { kind: "frozen_tests", featureId: "one", testSetId: HASH },
    { kind: "application_commit", commit: A }, { kind: "plan", planHash: HASH },
  ])("does not credit a review with missing/wrong subject %j", (subject) => {
    const data = envelope([work("builder", "claude"), review("review", "codex", { subject: subject as WorkSubject })]);
    expect(interpretProvenance(data, context()).currentReviews).toEqual([]);
  });

  it.each(["incomplete", "failed"] as const)("does not credit a %s review", (outcome) => {
    expect(interpretProvenance(envelope([work("builder", "claude"), review("review", "codex", { outcome })]), context()).currentReviews).toEqual([]);
  });

  it.each([
    { jobId: "" }, { jobId: " " }, { jobId: "x".repeat(201) }, { jobId: "a\nb" },
    { stage: "plan_review" }, { scope: { kind: "plan" } }, { outcome: "ok" },
    { at: "" }, { at: "2026-02-30T00:00:00Z" }, { at: "2026-10-31T00:00:00+01:00" },
  ])("does not credit malformed review fields %j", (extra) => {
    const data = envelope();
    Object.assign(data.entries[1]!, extra);
    expect(interpretProvenance(data, context()).currentReviews).toEqual([]);
  });

  it("duplicate job IDs provide no identity, even if one duplicate is malformed", () => {
    const data = envelope([work("builder", "claude"), work("builder", "codex", { at: "bad" }), review()]);
    const summary = interpretProvenance(data, context());
    expect(summary.contributorFamilies).toEqual([]);
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.currentReviews[0]?.relationship).toBe("unknown");
  });

  it("duplicate review IDs provide no completed current reviewer", () => {
    expect(interpretProvenance(envelope([work("builder", "claude"), review(), review()]), context()).currentReviews).toEqual([]);
  });

  it("refuses multiple same-subject snapshots rather than selecting a repair winner", () => {
    const summary = interpretProvenance(envelope(undefined, [writes(), writes()]), context());
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.contributorFamilies).toEqual([]);
    expect(summary.currentReviews[0]?.relationship).toBe("unknown");
    expect(summary.uncertainties).toContain("ambiguous_snapshot");
  });

  it("keeps known overlap when a separate malformed entry makes history incomplete", () => {
    const data = envelope([work("builder", "claude"), review("review", "claude"), work("bad", "codex", { subject: { kind: "feature_commit", featureId: "", commit: A } })]);
    const summary = interpretProvenance(data, context());
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.currentReviews[0]?.relationship).toBe("same_family");
  });
});

describe("PC07 scope and actual identity", () => {
  it("records a current plan reviewer without a builder-independence claim", () => {
    const summary = interpretProvenance(envelope([review("plan-review", "codex", { scope: { kind: "plan" }, stage: "plan_review", subject: PLAN })], []), context(PLAN));
    expect(summary.currentReviews[0]?.relationship).toBe("unknown");
    expect(summary.contributionsComplete).toBe(false);
  });

  it.each(["claude", "codex"] as const)("application-only writers never establish whole-app independence with %s review", (family) => {
    const summary = interpretProvenance(envelope([
      work("scaffold", "claude", { scope: { kind: "application" }, subject: APP }),
      review("final", family, { scope: { kind: "application" }, stage: "final_review", subject: APP }),
    ], [writes(["scaffold"], { subject: APP })]), context(APP));
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.currentReviews[0]?.relationship).toBe(family === "claude" ? "same_family" : "unknown");
  });

  it("does not accept an imported feature writer as application aggregation", () => {
    const summary = interpretProvenance(envelope([work("builder", "claude"), review("final", "claude", { scope: { kind: "application" }, stage: "final_review", subject: APP })], [writes(["builder"], { subject: APP })]), context(APP));
    expect(summary.contributorFamilies).toEqual([]);
    expect(summary.currentReviews[0]?.relationship).toBe("unknown");
  });

  it("a partial actual family discloses overlap but cannot prove complete authorship", () => {
    const summary = interpretProvenance(envelope([work("builder", "claude", { actual: { family: "claude" } }), review("review", "claude")]), context());
    expect(summary.contributorFamilies).toEqual(["claude"]);
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.currentReviews[0]?.relationship).toBe("same_family");
  });

  it("a contradictory provider/family pair supplies no family fact", () => {
    const summary = interpretProvenance(envelope([work("builder", "claude", { actual: { provider: "codex", family: "claude", model: "recorded" } }), review("review", "claude")]), context());
    expect(summary.contributorFamilies).toEqual([]);
    expect(summary.currentReviews[0]?.relationship).toBe("unknown");
  });

  it("mock uses its explicit actual family, never the model's name", () => {
    const summary = interpretProvenance(envelope([work("builder", "claude", { actual: { provider: "mock", model: "codex-looking-name", family: "claude" } }), review()]), context());
    expect(summary.contributionsComplete).toBe(true);
    expect(summary.contributorFamilies).toEqual(["claude"]);
  });

  it.each([
    {}, { provider: "mock", model: "claude-looking-name" },
    { provider: "codex", family: "codex", model: " " },
    { provider: "codex", family: "codex", model: "x".repeat(201) },
    { provider: "codex", family: "codex", model: "a\nb" },
  ])("does not complete actual review identity from %j", (actual) => {
    const data = envelope();
    (data.entries[1]! as unknown as Record<string, unknown>).actual = actual;
    expect(interpretProvenance(data, context()).currentReviews).toEqual([]);
  });

  it("ignores requested identity and unfinished legacy checker fields", () => {
    const data = { ...envelope([work("builder", "claude"), review("review", "codex", { actual: undefined, outcome: "incomplete" })]), requestedFamily: "codex", checked: { reviewer: "codex", unfinished: true } };
    expect(interpretProvenance(data, context()).currentReviews).toEqual([]);
  });
});

describe("PC08 bounds, uncertainty and pure input handling", () => {
  it("pending writes remove current credit and complete-history claims", () => {
    const summary = interpretProvenance(envelope(), context(FEATURE, { hasPendingWrites: true }));
    expect(summary.contributorFamilies).toEqual(["claude"]);
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.currentReviews).toEqual([]);
    expect(summary.uncertainties).toContain("pending_writes");
  });

  it.each([[], ["builder", "builder"], ["missing"]].map((ids) => ({ ids })))("does not establish independence from contributor list $ids", ({ ids }) => {
    expect(interpretProvenance(envelope(undefined, [writes(ids)]), context()).currentReviews[0]?.relationship).toBe("unknown");
  });

  it("oversized envelopes return no positive facts instead of truncating", () => {
    const summary = interpretProvenance(envelope(), context(FEATURE, { maxEntries: 1 }));
    expect(summary.contributorFamilies).toEqual([]);
    expect(summary.currentReviews).toEqual([]);
    expect(summary.contributionsComplete).toBe(false);
  });

  it("oversized snapshot history returns no positive facts", () => {
    const data = envelope(undefined, [writes(), writes(["builder"], { subject: { kind: "feature_commit", featureId: "one", commit: B } })]);
    expect(interpretProvenance(data, context(FEATURE, { maxSnapshots: 1 })).currentReviews).toEqual([]);
  });

  it.each([{ hasPendingWrites: undefined }, { maxEntries: 0 }, { maxEntries: Infinity }, { maxSnapshots: -1 }, { subject: { kind: "plan", planHash: "" } }])("fails closed on damaged controller context %j", (extra) => {
    const summary = interpretProvenance(envelope(), { ...context(), ...extra } as ProvenanceContext);
    expect(summary.currentReviews).toEqual([]);
    expect(summary.contributionsComplete).toBe(false);
    expect(summary.uncertainties).toEqual(["invalid_context"]);
  });

  it("ignores future optional fields and returns bounded fixed uncertainty codes", () => {
    const data = { ...envelope(), future: "private untrusted value" };
    const before = JSON.stringify(data);
    const summary = interpretProvenance(data, context());
    expect(summary.currentReviews[0]?.relationship).toBe("different_family");
    expect(JSON.stringify(summary)).not.toContain(data.future);
    expect(JSON.stringify(data)).toBe(before);
  });

  it("does not mutate caller records through returned review facts", () => {
    const data = envelope();
    const query = context();
    const before = JSON.stringify([data, query]);
    const summary = interpretProvenance(data, query);
    summary.currentReviews[0]!.actual.model = "changed in output";
    const subject = summary.currentReviews[0]!.subject;
    if (subject.kind === "feature_commit") subject.commit = B;
    expect(JSON.stringify([data, query])).toBe(before);
  });

  it("omits unknown nested subject fields without exposing or aliasing persisted input", () => {
    const data = envelope();
    const nested = { privateValue: "persisted optional text", values: ["original"] };
    const originalSubject = { ...FEATURE, future: nested };
    data.entries[1]!.subject = originalSubject;
    const before = JSON.stringify(data);
    const summary = interpretProvenance(data, context());
    const returned = summary.currentReviews[0]!.subject;
    expect(returned).toEqual(FEATURE);
    expect(returned).not.toHaveProperty("future");
    expect(JSON.stringify(summary)).not.toContain(nested.privateValue);
    (returned as unknown as Record<string, unknown>).future = { privateValue: "output only" };
    if (returned.kind === "feature_commit") returned.commit = B;
    expect(JSON.stringify(data)).toBe(before);
    nested.values.push("input only");
    expect(JSON.stringify(returned)).not.toContain("input only");
  });
});

describe("retained snapshot revision chains", () => {
  const version = (revision: number, jobIds = ["builder"]) => ({ ...writes(jobIds), revision, supersedes: revision === 1 ? null : revision - 1 });
  it("selects the terminal of an out-of-order contiguous same-subject chain", () => {
    const data = envelope([work("builder", "claude"), work("repair", "codex"), review("review", "claude")],
      [version(2, ["builder", "repair"]), version(1)]);
    const result = interpretProvenance(data, context());
    expect(result.contributionsComplete).toBe(true);
    expect(result.contributorJobIds).toEqual(["builder", "repair"]);
    expect(result.currentReviews[0]?.relationship).toBe("same_family");
  });
  it.each([
    { name: "owned undefined pair", rows: [{ ...writes(), revision: undefined, supersedes: undefined }] },
    { name: "owned undefined revision", rows: [{ ...writes(), revision: undefined }] },
    { name: "owned undefined supersedes", rows: [{ ...writes(), supersedes: undefined }] },
    { name: "missing predecessor", rows: [version(2)] },
    { name: "gap", rows: [version(1), version(3)] },
    { name: "fork", rows: [version(1), version(2), { ...version(3), supersedes: 1 }] },
    { name: "duplicate revision", rows: [version(1), version(1)] },
    { name: "mixed legacy", rows: [writes(), version(1)] },
    { name: "non-null first predecessor", rows: [{ ...version(1), supersedes: 0 }] },
  ])("rejects $name without choosing author facts", ({ rows }) => {
    const result = interpretProvenance(envelope(undefined, rows as RetainedSnapshot[]), context());
    expect(result.contributionsComplete).toBe(false);
    expect(result.contributorFamilies).toEqual([]);
  });
  it("validates historical chain content rather than trusting a terminal record", () => {
    const result = interpretProvenance(envelope(undefined,
      [{ ...version(1), complete: undefined }, version(2)] as unknown as RetainedSnapshot[]), context());
    expect(result.contributionsComplete).toBe(false);
  });
});

describe("application retained mission AI graph", () => {
  const MERGE = "e".repeat(40);
  function graph() {
    const baseline = { kind: "recorded_baseline" as const, commit: B };
    const reference = { featureId: "one", passingCommit: A, mergeCommit: MERGE, snapshotRevision: 1 };
    const feature = envelope([work("builder", "claude")],
      [{ ...writes(), revision: 1, supersedes: null }] as RetainedSnapshot[]);
    const app = envelope([
      work("scaffold", "codex", { scope: { kind: "application" }, subject: APP }),
      review("final", "claude", { scope: { kind: "application" }, stage: "final_review", subject: APP }),
    ], [{ ...writes(["scaffold"], { subject: APP }), baseline, featureRefs: [reference] }] as RetainedSnapshot[]);
    const query = context(APP, { maxEntries: 100, maxSnapshots: 100,
      application: {
        expectedIntegrationHead: A, observedHead: A, expectedBaseline: baseline,
        hasRetainedAiScaffold: true,
        expectedFeatureRefs: [{ ...reference, hasPendingWrites: false }],
        featureEvidence: [{ featureId: "one", provenance: feature }],
      },
    });
    return { app, query, feature, baseline, reference };
  }
  const summary = (f: ReturnType<typeof graph>) => interpretProvenance(f.app, f.query);
  const application = (f: ReturnType<typeof graph>) => f.query.application!;
  const snapshot = (f: ReturnType<typeof graph>) => f.app.retained![0] as Extract<RetainedSnapshot, { kind: "writes" }>;

  it.each([FEATURE, TESTS, PLAN])("rejects application graph context for direct $kind queries before resolving writers", (target) => {
    const f = graph();
    f.query.subject = target;
    const tests = frozen();
    const main = target.kind === "frozen_tests" ? tests.envelope : envelope();
    if (target.kind === "frozen_tests") {
      f.query.frozenMembers = tests.context.frozenMembers;
      application(f).featureEvidence[0]!.provenance = structuredClone(main);
    }
    main.entries = [];
    const result = interpretProvenance(main, f.query);
    expect(result.contributorJobIds).toEqual([]);
    expect(result.contributorFamilies).toEqual([]);
    expect(result.currentReviews).toEqual([]);
    expect(result.contributionsComplete).toBe(false);
    expect(result.uncertainties).toEqual(["invalid_context"]);
  });
  it("rejects an own undefined application context for a non-application query", () => {
    const query = context();
    Object.assign(query, { application: undefined });
    const result = interpretProvenance(envelope(), query);
    expect(result.contributorJobIds).toEqual([]);
    expect(result.currentReviews).toEqual([]);
    expect(result.uncertainties).toEqual(["invalid_context"]);
  });

  it("aggregates scaffold and exact feature scope with mission-only coverage", () => {
    const result = summary(graph());
    expect(result.contributionsComplete).toBe(true);
    expect(result.contributorJobIds).toEqual(["scaffold", "builder"]);
    expect(result.contributorFamilies).toEqual(["codex", "claude"]);
    expect(result.currentReviews[0]?.relationship).toBe("same_family");
    expect(result).toHaveProperty("applicationCoverage", "mission_retained_ai");
  });
  it("selects exactly the merged chain member despite later retained/unmerged work", () => {
    const f = graph();
    f.feature.entries.push(work("later", "codex", { subject: { ...FEATURE, commit: B } }));
    f.feature.retained!.push(
      { ...writes(["later"]), revision: 2, supersedes: 1 } as RetainedSnapshot,
      writes(["later"], { subject: { ...FEATURE, commit: B } }));
    expect(summary(f).contributorJobIds).toEqual(["scaffold", "builder"]);
    expect(summary(f).contributionsComplete).toBe(true);
  });
  it.each(["passingCommit", "mergeCommit", "snapshotRevision", "featureId"])("refuses mismatched %s without fabricating feature authors", (field) => {
    const f = graph();
    Object.assign(snapshot(f).featureRefs![0]!, { [field]: field === "snapshotRevision" ? 2 : B });
    const result = summary(f);
    expect(result.contributionsComplete).toBe(false);
    expect(result.contributorJobIds).toEqual(["scaffold"]);
    expect(result.currentReviews).toEqual([]);
  });
  it.each(["expectedIntegrationHead", "observedHead"])("unexpected %s cannot self-certify current review", (field) => {
    const f = graph();
    Object.assign(application(f), { [field]: B });
    const result = summary(f);
    expect(result.contributionsComplete).toBe(false);
    expect(result.currentReviews).toEqual([]);
    expect(result.contributorFamilies).toContain("claude");
  });
  it("requires a baseline independently equal to the controller baseline", () => {
    const f = graph();
    snapshot(f).baseline = { kind: "recorded_baseline", commit: MERGE };
    expect(summary(f).contributionsComplete).toBe(false);
    expect(summary(f).currentReviews).toEqual([]);
  });
  it("a baseline creates no author and cannot conceal required AI scaffold work", () => {
    const f = graph();
    snapshot(f).jobIds = [];
    expect(summary(f).contributionsComplete).toBe(false);
    application(f).hasRetainedAiScaffold = false;
    const result = summary(f);
    expect(result.contributionsComplete).toBe(true);
    expect(result.contributorJobIds).toEqual(["builder"]);
  });
  it("retains known overlap despite a missing feature and withholds current app review credit", () => {
    const f = graph();
    application(f).expectedFeatureRefs.push({ featureId: "missing", passingCommit: A, mergeCommit: MERGE, snapshotRevision: null, hasPendingWrites: false });
    const result = summary(f);
    expect(result.contributionsComplete).toBe(false);
    expect(result.contributorFamilies).toContain("claude");
    expect(result.currentReviews).toEqual([]);
  });
  it.each(["wrapper", "reference", "expected-reference"])("does not choose a winner for a duplicate %s", (kind) => {
    const f = graph();
    if (kind === "wrapper") application(f).featureEvidence.push(application(f).featureEvidence[0]!);
    if (kind === "reference") snapshot(f).featureRefs!.push(snapshot(f).featureRefs![0]!);
    if (kind === "expected-reference") application(f).expectedFeatureRefs.push(application(f).expectedFeatureRefs[0]!);
    const result = summary(f);
    expect(result.contributionsComplete).toBe(false);
    expect(result.contributorJobIds).not.toContain("builder");
  });
  it.each(["builder", "final"])("globally poisons colliding %s even in unsupported unreferenced envelopes", (id) => {
    const f = graph();
    application(f).featureEvidence.push({ featureId: "other", provenance: { version: 99, entries: [{ jobId: id }] } });
    const result = summary(f);
    expect(result.contributionsComplete).toBe(false);
    if (id === "builder") {
      expect(result.contributorJobIds).not.toContain("builder");
      expect(result.contributorFamilies).not.toContain("claude");
    } else expect(result.currentReviews).toEqual([]);
  });
  it("does not include test authors as application code contributors", () => {
    const f = graph();
    f.feature.entries.push(work("author", "codex", { stage: "test_author", subject: TESTS }));
    expect(summary(f).contributorJobIds).not.toContain("author");
    expect(summary(f).contributionsComplete).toBe(true);
  });
  it("source pending writes preserve known facts without current review credit", () => {
    const f = graph();
    application(f).expectedFeatureRefs[0]!.hasPendingWrites = true;
    const result = summary(f);
    expect(result.contributorFamilies).toContain("claude");
    expect(result.contributionsComplete).toBe(false);
    expect(result.currentReviews).toEqual([]);
  });
  it("counts cumulative nested references before returning any positive facts", () => {
    const f = graph();
    Object.assign(f.query, { maxReferences: 3 });
    const result = summary(f);
    expect(result.contributorJobIds).toEqual([]);
    expect(result.currentReviews).toEqual([]);
    expect(result.contributionsComplete).toBe(false);
  });

  it("preserves known same-family overlap when actual writer identity is partial", () => {
    const f = graph();
    f.feature.entries[0]!.actual = { family: "claude" };
    const result = summary(f);
    expect(result.contributionsComplete).toBe(false);
    expect(result.contributorFamilies).toContain("claude");
    expect(result.currentReviews[0]?.relationship).toBe("same_family");
  });
  it("accepts the sole legacy merged snapshot only with an explicit null reference", () => {
    const f = graph();
    f.feature.retained = [writes()];
    snapshot(f).featureRefs![0]!.snapshotRevision = null;
    application(f).expectedFeatureRefs[0]!.snapshotRevision = null;
    expect(summary(f).contributionsComplete).toBe(true);
    expect(summary(f).contributorJobIds).toContain("builder");
  });
  it("validates the entire source chain before selecting an older merged member", () => {
    const f = graph();
    f.feature.retained!.push({ ...writes(), revision: 2, supersedes: 99 } as RetainedSnapshot);
    const result = summary(f);
    expect(result.contributorJobIds).not.toContain("builder");
    expect(result.contributionsComplete).toBe(false);
    expect(result.currentReviews).toEqual([]);
  });
  it("does not invent independence for a baseline with zero retained AI contributions", () => {
    const f = graph();
    snapshot(f).jobIds = [];
    snapshot(f).featureRefs = [];
    application(f).hasRetainedAiScaffold = false;
    application(f).expectedFeatureRefs = [];
    const result = summary(f);
    expect(result.contributorJobIds).toEqual([]);
    expect(result.contributionsComplete).toBe(false);
    expect(result.currentReviews[0]?.relationship).toBe("unknown");
  });
  it("rejects feature evidence relabeled as an application writer", () => {
    const f = graph();
    f.feature.entries[0] = work("builder", "claude", { scope: { kind: "application" }, subject: APP });
    snapshot(f).jobIds = ["builder"];
    const result = summary(f);
    expect(result.contributorJobIds).not.toContain("builder");
    expect(result.contributionsComplete).toBe(false);
  });
  it("cannot borrow a feature writer stored in the mission envelope to fill a missing feature entry", () => {
    const f = graph();
    f.app.entries.push(f.feature.entries[0]!);
    f.feature.entries = [];
    const result = summary(f);
    expect(result.contributorJobIds).not.toContain("builder");
    expect(result.contributionsComplete).toBe(false);
  });
  it("audits duplicates inside a damaged unreferenced envelope with malformed retained data", () => {
    const f = graph();
    application(f).featureEvidence.push({ featureId: "other", provenance: {
      version: 1, entries: [{ jobId: "builder", at: "bad" }], retained: null,
    } });
    const result = summary(f);
    expect(result.contributorFamilies).not.toContain("claude");
    expect(result.uncertainties).toContain("duplicate_job_id");
  });
  it("duplicate wrappers with different jobs cannot provide selected feature identity", () => {
    const f = graph();
    application(f).featureEvidence.push({ featureId: "one", provenance: envelope([work("different", "codex")], [writes(["different"])]) });
    expect(summary(f).contributorJobIds).toEqual(["scaffold"]);
    expect(summary(f).contributionsComplete).toBe(false);
  });
  it.each(["maxEntries", "maxSnapshots"] as const)("applies cumulative %s across envelopes before any fact", (field) => {
    const f = graph();
    f.query[field] = field === "maxEntries" ? 2 : 1;
    const result = summary(f);
    expect(result.contributorJobIds).toEqual([]);
    expect(result.contributorFamilies).toEqual([]);
    expect(result.currentReviews).toEqual([]);
    expect(result.uncertainties).toEqual(["graph_budget_exceeded"]);
  });
  it.each([undefined, 0, -1, Number.NaN, Infinity])("rejects an owned invalid reference budget %s", (maxReferences) => {
    const f = graph();
    Object.assign(f.query, { maxReferences });
    const result = summary(f);
    expect(result.contributorJobIds).toEqual([]);
    expect(result.currentReviews).toEqual([]);
    expect(result.uncertainties).toEqual(["invalid_context"]);
  });
  it("counts nested frozen members and author lists cumulatively, including an unselected envelope", () => {
    const f = graph();
    const tests = frozen();
    application(f).featureEvidence.push({ featureId: "unused", provenance: tests.envelope });
    f.query.maxReferences = 11;
    expect(summary(f).uncertainties).toEqual(["graph_budget_exceeded"]);
    expect(summary(f).contributorFamilies).toEqual([]);
  });
  it("is immutable and does not expose arbitrary context data", () => {
    const f = graph();
    Object.assign(application(f), { privateValue: "private-value" });
    const before = JSON.stringify(f);
    const result = summary(f);
    expect(JSON.stringify(f)).toBe(before);
    expect(JSON.stringify(result)).not.toContain("private-value");
  });
});

describe("frozen revision and cumulative reference boundaries", () => {
  it("selects terminal member-grounded authorship without retaining discarded revision authors", () => {
    const f = frozen();
    const initial = f.envelope.retained![0]!;
    const next = structuredClone(initial);
    if (next.kind !== "tests") throw new Error("fixture kind");
    next.members[0]!.jobIds = ["replacement-author"];
    next.jobIds = ["replacement-author"];
    f.envelope.retained = [
      { ...next, revision: 2, supersedes: 1 },
      { ...initial, revision: 1, supersedes: null },
    ];
    const result = interpretProvenance(f.envelope, f.context);
    expect(result.contributorJobIds).toEqual(["replacement-author"]);
    expect(result.contributorFamilies).toEqual(["codex"]);
    expect(result.contributionsComplete).toBe(true);
  });
  it("enforces an exact cumulative member/author budget without prefix credit", () => {
    const f = frozen();
    f.context.maxReferences = 8;
    expect(interpretProvenance(f.envelope, f.context).contributionsComplete).toBe(true);
    f.context.maxReferences = 7;
    const result = interpretProvenance(f.envelope, f.context);
    expect(result.contributorJobIds).toEqual([]);
    expect(result.currentReviews).toEqual([]);
    expect(result.uncertainties).toEqual(["graph_budget_exceeded"]);
  });
});
