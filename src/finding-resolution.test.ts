import { describe, expect, it } from "vitest";
import { rediscoverFindings, assessFindings, currentOpenFindings, findingId, retainFindings, type FindingAssessmentContext, MAX_FINDING_RECORDS } from "./finding-resolution.js";
import type { Finding } from "./types.js";
const A = "a".repeat(40), B = "b".repeat(40);
const F: Finding = { severity: "major", file: "src/a", description: "Missing guide\nline", suggestedTest: null };
const ID = "c35df5546e39ebb6c861ee89b8a4dee6f7ba3f156939c25a8f7dbc476a8b47d1";
const context = (changes: Partial<FindingAssessmentContext> = {}): FindingAssessmentContext => ({
  currentCommit: A, reviewedCommit: A, completed: true, unchanged: true, clean: true,
  jobId: "review-1", actual: { provider: "codex", family: "codex", model: "existing-model" },
  at: "2026-10-31T01:00:00.000Z", verification: { commit: A, passed: true }, ...changes,
});
const history = () => retainFindings(undefined, "first", [F])!;
const resolved = (id = ID) => ({ id, outcome: "resolved", evidence: "Read src/a; the referenced guide now exists." });
describe("stable original findings", () => {
  it("hashes exact UTF8 JSON array and preserves original text", () => {
    expect(findingId("first", F)).toBe(ID); // independent Python hashlib reference vector
    const h = retainFindings(undefined, "first", [F, { ...F }])!;
    expect(h.records).toHaveLength(1); expect(h.records[0]?.finding).toEqual(F);
    expect(h.records[0]?.assessments).toEqual([]);
    expect(findingId("first", { ...F, description: F.description.replace("\n", "\\n") })).not.toBe(ID);
    expect(findingId("second", F)).not.toBe(ID);
    expect(findingId("first", { ...F, description: " " + F.description })).not.toBe(ID);
  });
  it("detaches input and retains old findings when later calls omit them", () => {
    const input = { ...F }; const h = retainFindings(undefined, "first", [input])!;
    input.description = "changed";
    expect(retainFindings(h, "first", [])).toEqual(h);
    expect(h.records[0]?.finding.description).toBe(F.description);
  });
  it.each([null, {}, { version: 2, records: [] }, { version: 1, records: [{ id: ID }] }])("damaged history %j never becomes an empty authoritative list", raw => {
    expect(retainFindings(raw, "first", [F])).toBeUndefined();
    expect(assessFindings(raw, "first", [resolved()], context())).toBeUndefined();
    expect(currentOpenFindings(raw, "first", A)).toBeUndefined();
  });
});
describe("explicit current-subject assessments", () => {
  it("closes a known blocking finding with actual identity and verification at the exact commit", () => {
    const h = assessFindings(history(), "first", [resolved()], context())!;
    expect(currentOpenFindings(h, "first", A)).toEqual([]);
    expect(h.records[0]?.assessments[0]).toMatchObject({ outcome: "resolved", jobId: "review-1", reviewedCommit: A, actual: context().actual, verificationPassedAtCommit: A });
    expect(h.records[0]?.finding).toEqual(F);
  });
  it.each([
    { completed: false }, { unchanged: false }, { clean: false }, { currentCommit: B }, { reviewedCommit: "" },
    { actual: undefined }, { actual: { family: "codex" as const } }, { jobId: "" },
    { actual: { provider: "claude" as const, family: "codex" as const, model: "existing-model" } },
  ])("does not accept closure from unusable review context %j", change => {
    const h = assessFindings(history(), "first", [resolved()], context(change))!;
    expect(currentOpenFindings(h, "first", A)).toHaveLength(1);
    expect(h.records[0]?.assessments).toEqual([]);
  });
  it.each([undefined, { commit: B, passed: true }, { commit: A, passed: false }])("keeps blocking concern open without current passing verification %j", verification => {
    const h = assessFindings(history(), "first", [resolved()], context({ verification }))!;
    expect(currentOpenFindings(h, "first", A)).toHaveLength(1);
  });
  it("can record a minor resolution as AI review evidence without inventing executable proof", () => {
    const minor = { ...F, severity: "minor" as const };
    const h = retainFindings(undefined, "first", [minor])!;
    const assessed = assessFindings(h, "first", [resolved(findingId("first", minor))], context({ verification: undefined }))!;
    expect(currentOpenFindings(assessed, "first", A)).toEqual([]);
    expect(assessed.records[0]?.assessments[0]?.verificationPassedAtCommit).toBeNull();
  });
  it("reopens a stale closure without erasing its audit history", () => {
    const h = assessFindings(history(), "first", [resolved()], context())!;
    expect(currentOpenFindings(h, "first", B)).toHaveLength(1);
    expect(h.records[0]?.assessments).toHaveLength(1);
    expect(currentOpenFindings(h, "first", "bad")).toBeUndefined();
  });
  it.each([
    [], [resolved("unknown")], [{ id: ID, outcome: "resolved", evidence: "" }],
    [{ id: ID, outcome: "resolved", evidence: "   " }], [{ id: ID, outcome: "invented", evidence: "text" }],
    [resolved(), resolved()], [resolved(), { id: ID }], [resolved(), { id: ID, outcome: "open", evidence: "Still missing." }],
  ].map(raw => ({ raw })))("unknown, missing, duplicate or malformed assessment cannot close a finding %j", ({ raw }) => {
    const h = assessFindings(history(), "first", raw, context())!;
    expect(currentOpenFindings(h, "first", A)).toHaveLength(1);
    expect(h.records[0]?.assessments).toEqual([]);
  });
  it.each(["open", "cannot_judge"] as const)("records explicit %s without closing it", outcome => {
    const h = assessFindings(history(), "first", [{ id: ID, outcome, evidence: "The source is not sufficient." }], context())!;
    expect(currentOpenFindings(h, "first", A)).toHaveLength(1);
    expect(h.records[0]?.assessments[0]?.outcome).toBe(outcome);
  });
  it("same review replay is idempotent and cannot overwrite its accepted evidence", () => {
    const h = assessFindings(history(), "first", [resolved()], context())!;
    expect(assessFindings(h, "first", [resolved()], context())).toEqual(h);
    expect(assessFindings(h, "first", [{ id: ID, outcome: "open", evidence: "contradiction" }], context())).toEqual(h);
  });
  it("rejects duplicate stored records and altered hash/origin rather than granting closure", () => {
    const h = history(); h.records.push(structuredClone(h.records[0]!));
    expect(currentOpenFindings(h, "first", A)).toBeUndefined();
    const changed = history(); changed.records[0]!.originFeatureId = "other";
    expect(assessFindings(changed, "first", [resolved()], context())).toBeUndefined();
  });
  it("does not resurrect an earlier closure when returning to its old SHA", () => {
    const first = assessFindings(history(), "first", [resolved()], context())!;
    const later = assessFindings(first, "first", [{ id: ID, outcome: "open", evidence: "The concern applies again." }], context({ currentCommit: B, reviewedCommit: B, jobId: "review-2", verification: { commit: B, passed: true } }))!;
    expect(later.records[0]?.assessments).toHaveLength(2);
    expect(currentOpenFindings(later, "first", A)).toHaveLength(1);
  });
  it("rejects a valid history copied into another feature boundary", () => {
    expect(currentOpenFindings(history(), "second", A)).toBeUndefined();
    expect(assessFindings(history(), "second", [resolved()], context())).toBeUndefined();
    expect(retainFindings(history(), "second", [F])).toBeUndefined();
  });
  it("rejects an oversized whole batch instead of missing a duplicate beyond its prefix", () => {
    const batch = Array.from({ length: MAX_FINDING_RECORDS + 1 }, () => resolved("unknown"));
    batch[0] = resolved(); batch[MAX_FINDING_RECORDS] = resolved();
    const h = assessFindings(history(), "first", batch, context())!;
    expect(currentOpenFindings(h, "first", A)).toHaveLength(1);
    expect(h.records[0]?.assessments).toEqual([]);
  });
  it("does not trust a stored blocking resolution with a Boolean or different verification SHA", () => {
    const h = assessFindings(history(), "first", [resolved()], context())!;
    for (const verificationPassedAtCommit of [true, B, null]) {
      const damaged = structuredClone(h);
      (damaged.records[0]!.assessments[0] as unknown as { verificationPassedAtCommit: unknown }).verificationPassedAtCommit = verificationPassedAtCommit;
      expect(currentOpenFindings(damaged, "first", A)).toBeUndefined();
    }
  });
});

describe("immutable review invocation context", () => {
  const other = { ...F, description: "Second independent concern" };
  const secondId = findingId("first", other);
  const both = () => retainFindings(undefined, "first", [F, other])!;
  it.each([
    { actual: { provider: "claude" as const, family: "claude" as const, model: "another-model" } },
    { currentCommit: B, reviewedCommit: B, verification: { commit: B, passed: true } },
    { at: "2026-10-31T01:01:00.000Z" },
    { verification: undefined },
  ])("rejects conflicting job context across records %j", changes => {
    const first = assessFindings(both(), "first", [resolved()], context())!;
    const response = { id: secondId, outcome: "open", evidence: "Still open." };
    expect(assessFindings(first, "first", [response], context(changes))).toBeUndefined();
    expect(first.records[1]?.assessments).toEqual([]);
  });
  it("rejects corrupted stored identity across records", () => {
    const h = assessFindings(both(), "first", [resolved(), resolved(secondId)], context())!;
    h.records[1]!.assessments[0]!.actual = { provider: "claude", family: "claude", model: "other" };
    expect(currentOpenFindings(h, "first", A)).toBeUndefined();
    expect(retainFindings(h, "first", [])).toBeUndefined();
  });
  it("allows distinct per-finding outcomes from one immutable review context", () => {
    const first = assessFindings(both(), "first", [resolved()], context())!;
    const h = assessFindings(first, "first", [{ id: secondId, outcome: "open", evidence: "Still missing." }], context())!;
    expect(currentOpenFindings(h, "first", A)?.map(r => r.id)).toEqual([secondId]);
  });
});

describe("controller rediscovery audit", () => {
  it("reopens at the same head without inventing another AI assessment", () => {
    const h = assessFindings(history(), "first", [resolved()], context())!;
    const reopened = { ...h, records: h.records.map(r => ({ ...r, reopens: [{ afterAssessmentCount: 1, at: context().at }] })) };
    expect(currentOpenFindings(reopened, "first", A)).toHaveLength(1);
    expect(assessFindings(reopened, "first", [resolved()], context())).toEqual(reopened);
    const later = assessFindings(reopened, "first", [resolved()], context({ jobId: "review-2" }))!;
    expect(currentOpenFindings(later, "first", A)).toEqual([]);
    expect(later.records[0]?.assessments).toHaveLength(2);
  });
  it.each([0, 2, 1.5])("rejects invalid reopen anchor %s", n => {
    const h = assessFindings(history(), "first", [resolved()], context())!;
    expect(currentOpenFindings({ ...h, records: h.records.map(r => ({ ...r, reopens: [{ afterAssessmentCount: n, at: context().at }] })) }, "first", A)).toBeUndefined();
  });
});

describe("bounded rediscovery helper", () => {
  it("is idempotent at one assessment count, keeps input immutable and uses count order despite clock rollback", () => {
    const closed = assessFindings(history(), "first", [resolved()], context())!;
    const before = structuredClone(closed);
    const reopened = rediscoverFindings(closed, "first", [F], "2026-10-30T00:00:00.000Z")!;
    expect(currentOpenFindings(reopened, "first", A)).toHaveLength(1);
    expect(rediscoverFindings(reopened, "first", [F], context().at)).toEqual(reopened);
    expect(closed).toEqual(before);
  });
  it("returns unknown rather than truncating a full audit to add a reopen", () => {
    const base = assessFindings(history(), "first", [resolved()], context())!;
    const template = { ...base.records[0]!.assessments[0]!, evidence: "x", actual: { provider: "codex" as const, family: "codex" as const, model: "x" } };
    const full = { ...base, records: [{ ...base.records[0]!, assessments: Array.from({ length: 100000 }, (_, i) => ({ ...template, jobId: `j${i}` })) }] };
    expect(currentOpenFindings(full, "first", A)).toEqual([]);
    expect(rediscoverFindings(full, "first", [F], context().at)).toBeUndefined();
    expect(full.records[0]?.assessments).toHaveLength(100000);
  });
});
