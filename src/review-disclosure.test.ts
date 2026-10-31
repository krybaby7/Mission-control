import { describe, expect, it } from "vitest";
import { reviewDisclosure, testAuthorshipDisclosure } from "./review-disclosure.js";
import type { Provenance, ProvenanceContext, RetainedSnapshot, WorkEvidence, WorkSubject } from "./provenance.js";
const sha = "a".repeat(40), next = "b".repeat(40), hash = "c".repeat(64);
const subject = { kind: "feature_commit", featureId: "one", commit: sha } as const;
const tests = { kind: "frozen_tests", featureId: "one", testSetId: hash } as const;
const context = (s: WorkSubject = subject, extra: Partial<ProvenanceContext> = {}): ProvenanceContext => ({ subject: s, hasPendingWrites: false, maxEntries: 100, maxSnapshots: 100, ...extra });
const entry = (id: string, family: "claude" | "codex", extra: Partial<WorkEvidence> = {}): WorkEvidence => ({
  jobId: id, actual: { provider: family, family, model: "private-model-never-display" }, scope: { kind: "feature", featureId: "one" },
  stage: "build", outcome: "completed", at: "2026-10-31T00:00:00.000Z", subject, ...extra,
});
const envelope = (extra: Partial<Provenance> = {}): Provenance => ({ version: 1,
  entries: [entry("build", "claude"), entry("review", "codex", { stage: "review" })],
  retained: [{ kind: "writes", subject, jobIds: ["build"], complete: true }], ...extra });
const words = (p: unknown, c = context()) => reviewDisclosure(p, c).join(" ");
describe("truthful shared review wording", () => {
  it("discloses same-family work in separate jobs without a failure or approval claim", () => {
    const text = words(envelope({ entries: [entry("build", "claude"), entry("review", "claude", { stage: "review" })] }));
    expect(text).toContain("Built and reviewed by Claude in separate jobs; this was not a review by another AI family.");
    expect(text).not.toMatch(/approved|passed|independent|error|private-model/u);
  });
  it("describes an established different family without broad independence promises", () => {
    const text = words(envelope());
    expect(text).toContain("Recorded build and repair contributors: Claude.");
    expect(text).toContain("Reviewed by Codex in a separate job from the recorded builders; the reviewer belongs to another AI family.");
    expect(text).not.toMatch(/independent|passed|approved/u);
  });
  it("keeps known overlap visible even when retained authorship is partly unknown", () => {
    const p = envelope({ entries: [entry("build", "claude"), entry("review", "claude", { stage: "review" })],
      retained: [{ kind: "writes", subject, jobIds: ["build", "missing"], complete: false }] });
    const text = words(p);
    expect(text).toContain("not a review by another AI family");
    expect(text).toContain("Some retained build or repair contributions have no recorded AI identity.");
  });
  it("does not establish different-family review from missing builder history", () => {
    const p = envelope({ retained: [{ kind: "writes", subject, jobIds: ["unknown"], complete: false }] });
    expect(words(p)).toContain("whether the reviewer came from another AI family could not be established");
    expect(words(p)).not.toContain("reviewer belongs to another AI family");
  });
  it.each([undefined, { version: 99, entries: [] }, { builtBy: "claude", checked: { reviewer: "codex" } }])("uses explicit unknown wording for old or damaged records %j", p => {
    expect(words(p)).toContain("Review identity not recorded for this version.");
    expect(words(p)).not.toMatch(/Reviewed by|Built and reviewed/u);
  });
  it.each(["incomplete", "failed"] as const)("does not credit an %s review", outcome => {
    expect(words(envelope({ entries: [entry("build", "claude"), entry("review", "codex", { stage: "review", outcome })] }))).toContain("Review identity not recorded for this version.");
  });
  it("withholds stale and pending review credit", () => {
    expect(words(envelope(), context({ ...subject, commit: next }))).toContain("Review identity not recorded for this version.");
    expect(words(envelope(), context(subject, { hasPendingWrites: true }))).toContain("Review identity not recorded for this version.");
  });
  it("reports each current family once, with deterministic family ordering", () => {
    const p = envelope({ entries: [entry("build", "claude"), entry("r-codex", "codex", { stage: "review" }), entry("r-claude", "claude", { stage: "review" }), entry("r-codex-again", "codex", { stage: "review" })] });
    const text = words(p); expect(text.match(/Reviewed by Codex/gu)).toHaveLength(1);
    expect(text.indexOf("Built and reviewed by Claude")).toBeLessThan(text.indexOf("Reviewed by Codex"));
  });
  it("identifies plan review without presenting it as code review", () => {
    const plan = { kind: "plan", planHash: hash } as const;
    const text = words(envelope({ entries: [entry("plan", "codex", { scope: { kind: "plan" }, stage: "plan_review", subject: plan })], retained: [] }), context(plan));
    expect(text).toBe("Plan reviewed by Codex. This records review of the plan, not the built application.");
  });
  it("qualifies whole-app comparison as retained AI work of this mission only", () => {
    const app = { kind: "application_commit", commit: sha } as const;
    const baseline = { kind: "recorded_baseline", commit: next } as const;
    const p = envelope({ entries: [entry("scaffold", "claude", { scope: { kind: "application" }, subject: app }), entry("final", "codex", { scope: { kind: "application" }, stage: "final_review", subject: app })],
      retained: [{ kind: "writes", subject: app, complete: true, jobIds: ["scaffold"], baseline, featureRefs: [] }] });
    const c = context(app, { application: { expectedIntegrationHead: sha, observedHead: sha, expectedBaseline: baseline, hasRetainedAiScaffold: true, expectedFeatureRefs: [], featureEvidence: [] } });
    const text = words(p, c);
    expect(text).toContain("Final review of this version: Codex.");
    expect(text).toContain("These comparisons cover retained AI work from this mission; earlier repository authorship is outside this record.");
    for (const broken of [
      { ...c, hasPendingWrites: true },
      { ...c, application: { ...c.application!, observedHead: next } },
      { ...c, application: { ...c.application!, expectedFeatureRefs: [{ featureId: "missing", passingCommit: sha, mergeCommit: sha, snapshotRevision: null, hasPendingWrites: false }] } },
      { ...c, application: { ...c.application!, expectedBaseline: { kind: "recorded_baseline" as const, commit: sha } } },
    ]) {
      const brokenText = words(p, broken);
      expect(brokenText).toContain("Final review identity not recorded for this version.");
      expect(brokenText).not.toContain("Final review of this version:");
    }
    expect(words(p, { ...context(), application: c.application })).toContain("Review identity not recorded for this version.");
    expect(words(p, context(app))).toContain("Whether the final reviewer came from another AI family than the retained mission contributors could not be established.");
  });
});
describe("separate frozen test authorship", () => {
  const member = { path: "tests/a.ts", sha256: hash };
  function fixture(): Provenance {
    return envelope({ entries: [entry("build", "claude"), entry("author", "claude", { stage: "test_author", subject: tests })],
      retained: [{ kind: "writes", subject, complete: true, jobIds: ["build"] },
      { kind: "tests", subject: tests, complete: true, jobIds: ["author"], members: [{ ...member, complete: true, jobIds: ["author"] }] }] });
  }
  const tc = () => context(tests, { frozenMembers: [member] });
  it("separately discloses an author who also belongs to the builder family", () => {
    const text = testAuthorshipDisclosure(fixture(), tc(), context()).join(" ");
    expect(text).toContain("Recorded authors of the frozen tests: Claude.");
    expect(text).toContain("Claude authored retained tests and also contributed to the build.");
  });
  it("describes fully recorded disjoint authors and builders", () => {
    const p = fixture(); p.entries[1] = entry("author", "codex", { stage: "test_author", subject: tests });
    const text = testAuthorshipDisclosure(p, tc(), context()).join(" ");
    expect(text).toContain("Recorded authors of the frozen tests: Codex.");
    expect(text).toContain("The recorded test authors and builders belong to different AI families.");
    expect(text).not.toContain("also contributed");
  });
  it.each(["authors", "builders"])("does not claim disjoint families with incomplete %s", incomplete => {
    const p = fixture(); p.entries[1] = entry("author", "codex", { stage: "test_author", subject: tests });
    p.retained![incomplete === "authors" ? 1 : 0]!.complete = false;
    const text = testAuthorshipDisclosure(p, tc(), context()).join(" ");
    expect(text).toContain("Whether test authors and builders came from different AI families could not be established.");
    expect(text).not.toContain("The recorded test authors and builders belong to different AI families.");
  });
  it("says partial authorship when a retained frozen member cannot be linked", () => {
    const p = fixture(); (p.retained![1] as Extract<RetainedSnapshot, { kind: "tests" }>).members.push({ path: "tests/unknown.ts", sha256: hash, complete: false, jobIds: [] });
    const text = testAuthorshipDisclosure(p, context(tests, { frozenMembers: [member, { path: "tests/unknown.ts", sha256: hash }] }), context()).join(" ");
    expect(text).toContain("Some retained test contributions have no recorded AI identity.");
  });
  it("does not compare another feature's builders or claim independence from missing authors", () => {
    const text = testAuthorshipDisclosure(fixture(), tc(), context({ ...subject, featureId: "other" })).join(" ");
    expect(text).toContain("Whether test authors and builders came from different AI families could not be established.");
    expect(text).not.toContain("also contributed");
  });
});
