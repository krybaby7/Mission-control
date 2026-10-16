// T-MODES: the dashboard's side of the work modes (docs/modes-spec.md, section 11): which features are checked by a second AI, how each
// finished feature was checked and in which words, the owner stop's reasons, the Results sentences, the ladder size and the mission
// sentences. A mission with no such feature is shown as before (test/dashboard-compat.test.ts pins that for every old fixture).
import { describe, expect, it } from "vitest";
import { fakeFacts } from "../../test/dashboard-facts-helpers.js";
import { makeFeature, makeMission } from "../../test/dashboard-helpers.js";
import type { CheckResult, CheckpointRecord, Feature, FeatureChecked, Mission } from "../types.js";
import { buildDebrief } from "./debrief.js";
import { approvedTitles, checkedFacts, checkedList, hasModeFeature, hasNoTests, isApproved, isModeFeature, lookWhy, noTestsDone, timesSentBack } from "./modes.js";
import { ladderTotal } from "./missions.js";
import { builtInSettings, type DashboardSettings } from "./snapshot.js";
import {
  CARD_TEXT,
  checkedByWords,
  checkedGroupWords,
  checkedSummary,
  checkpointSummary,
  deliveredWhy,
  DEBRIEF_HONESTY_NOTE,
  explainFeatureReason,
  finalReviewCaveat,
  finalReviewWhy,
  honestyNoteFor,
  makeFormatter,
  missionSentence,
  UNFINISHED_REVIEW_NOTE,
  verdictSentence,
} from "./vocabulary.js";

const AT = "2026-10-11T09:58:30.000Z";

function checkedOf(results: CheckResult[], o: { unfinished?: boolean; unjudged?: number } = {}): FeatureChecked {
  return {
    round: 1,
    reviewer: "claude",
    results: results.map((result, i) => ({ n: i + 1, result, evidence: "", basis: "text" as const })),
    unjudged: o.unjudged ?? results.filter((r) => r === "cannot_judge").length,
    ...(o.unfinished === true && { unfinished: true as const }),
    scripted: { problems: [], facts: [] },
    pictures: { taken: 0 },
  };
}

/** A finished feature checked by a second AI. */
function reading(id: string, results: CheckResult[], o: Partial<Feature> = {}): Feature {
  return makeFeature({ id, title: `Title of ${id}`, status: "done", mode: "review", checked: checkedOf(results), ...o });
}

/** A finished feature checked by tests. */
function tested(id: string, o: Partial<Feature> = {}): Feature {
  return makeFeature({ id, title: `Title of ${id}`, status: "done", frozenTests: [{ path: "", sha256: "" }], ...o });
}

const answer = (featureId: string, decision: "approve" | "send_back", round = 1): CheckpointRecord => ({
  id: `feature:${featureId}#${round}`,
  scope: `feature:${featureId}`,
  kind: "feature",
  featureId,
  round,
  decision,
  at: AT,
});

function mission(features: Feature[], o: Partial<Mission> = {}): Mission {
  return makeMission({ id: "2026-10-11-docs", title: "Docs", status: "done", stage: "complete", features, ...o });
}

describe("T-MODES-1: which features are checked by reading", () => {
  it("a mode feature is one with a mode; a mission has a mode feature when any of its features does", () => {
    expect(isModeFeature(makeFeature({ id: "a" }))).toBe(false);
    expect(isModeFeature(makeFeature({ id: "a", mode: "review" }))).toBe(true);
    expect(isModeFeature(makeFeature({ id: "a", mode: "owner" }))).toBe(true);
    expect(hasModeFeature(mission([tested("a")]))).toBe(false);
    expect(hasModeFeature(mission([tested("a"), reading("b", ["pass"])]))).toBe(true);
    expect(hasModeFeature(mission([]))).toBe(false);
  });

  it("no finished feature is checked by tests: true only for a mission with a mode feature and no finished tests feature", () => {
    expect(noTestsDone(mission([reading("a", ["pass"])]))).toBe(true);
    expect(noTestsDone(mission([reading("a", ["pass"]), reading("b", ["pass"], { mode: "owner" })]))).toBe(true);
    expect(noTestsDone(mission([tested("a"), reading("b", ["pass"])]))).toBe(false);
    expect(noTestsDone(mission([tested("a")]))).toBe(false);
    expect(noTestsDone(mission([]))).toBe(false);
    // a tests feature that is not done yet does not count: the final check can only run once the features are settled
    expect(noTestsDone(mission([makeFeature({ id: "t", status: "blocked" }), reading("b", ["pass"])]))).toBe(true);
  });

  it("an approval is an approve in the checkpoint log for the feature's own scope, and nothing else", () => {
    const m = mission([reading("a", ["pass"]), reading("b", ["pass"])], {
      checkpointLog: [answer("a", "send_back", 1), answer("a", "approve", 2), answer("b", "send_back", 1)],
    });
    const [a, b] = m.features;
    expect(isApproved(m, a as Feature)).toBe(true);
    expect(isApproved(m, b as Feature)).toBe(false);
    expect(timesSentBack(m, a as Feature)).toBe(1);
    expect(timesSentBack(m, b as Feature)).toBe(1);
    expect(approvedTitles(m)).toEqual(["Title of a"]);
    // the plan's and the final stop's approvals are not a feature's
    const other = mission([reading("a", ["pass"])], {
      checkpointLog: [{ id: "plan#1", scope: "plan", kind: "plan", round: 1, decision: "approve", at: AT }, { id: "final#1", scope: "final", kind: "final", round: 1, decision: "approve", at: AT }],
    });
    expect(approvedTitles(other)).toEqual([]);
  });
});

describe("T-MODES-2: how a finished feature was checked (the table of spec 10.1)", () => {
  it("row 3: checked by tests; row 1: the owner approved it; row 2: no test was written for it, approved or not", () => {
    const m = mission([tested("a"), tested("b"), makeFeature({ id: "c", status: "done" }), makeFeature({ id: "d", status: "done" })], { checkpointLog: [answer("b", "approve"), answer("d", "approve")] });
    const rows = m.features.map((f) => checkedFacts(m, f));
    expect(rows.map((r) => r.row)).toEqual([3, 1, 2, 2]);
    expect(rows.map((r) => r.approved)).toEqual([false, true, false, true]);
    expect(rows.every((r) => !r.queuedWithoutLook && r.unmet === 0 && r.unjudged === 0)).toBe(true);
  });

  it("rows 4 to 7 for a feature checked by a second AI: unfinished, unmet checks, checks not judged, every check met", () => {
    const m = mission([]);
    const row = (f: Feature) => checkedFacts(m, f);
    expect(row(makeFeature({ id: "a", status: "done", mode: "review" })).row).toBe(4); // the second AI never answered
    expect(row(reading("a", [], { checked: checkedOf([], { unfinished: true }) })).row).toBe(4);
    expect(row(reading("a", ["pass", "fail", "fail"]))).toMatchObject({ row: 5, unmet: 2, unjudged: 0 });
    expect(row(reading("a", ["pass", "fail", "cannot_judge"]))).toMatchObject({ row: 5, unmet: 1, unjudged: 1 });
    expect(row(reading("a", ["pass", "cannot_judge", "cannot_judge"]))).toMatchObject({ row: 6, unmet: 0, unjudged: 2 });
    expect(row(reading("a", ["pass", "pass"]))).toMatchObject({ row: 7, unmet: 0, unjudged: 0 });
    expect(row(reading("a", ["pass"], { mode: "owner" })).row).toBe(7);
  });

  // R2-5 of the real runs: a taste check ends "(the CEO decides)", and the second AI can only say that it cannot judge it.
  it("a taste check that nobody judged is left for the owner, and only where the owner is asked", () => {
    const TASTE = "(the CEO decides)"; // all the page keeps of the text of a taste check (read.ts); every other check is kept as ""
    const taste = (results: CheckResult[], o: Partial<Feature> = {}) => reading("a", results, { mode: "owner", acceptance: ["", "", TASTE], ...o });
    const m = mission([]);
    expect(checkedFacts(m, taste(["pass", "pass", "cannot_judge"]))).toMatchObject({ row: 6, unjudged: 1, left: 1 });
    expect(checkedFacts(m, taste(["pass", "cannot_judge", "cannot_judge"]))).toMatchObject({ row: 6, unjudged: 2, left: 1 });
    // judged by the second AI, or an ordinary check: nothing is left for the owner, and the key is absent
    expect(checkedFacts(m, taste(["pass", "pass", "pass"]))).not.toHaveProperty("left");
    expect(checkedFacts(m, taste(["pass", "cannot_judge", "pass"]))).not.toHaveProperty("left");
    expect(checkedFacts(m, taste(["fail", "pass", "pass"]))).not.toHaveProperty("left");
    expect(checkedFacts(m, reading("a", ["pass", "pass", "cannot_judge"], { mode: "owner", acceptance: ["", "", ""] }))).not.toHaveProperty("left");
    // queued without a stop for the owner's look: nobody answers it, so it is not left for anyone
    expect(checkedFacts(mission([], { ownerStops: false }), taste(["pass", "pass", "cannot_judge"]))).toMatchObject({ row: 6, unjudged: 1, queuedWithoutLook: true });
    expect(checkedFacts(mission([], { ownerStops: false }), taste(["pass", "pass", "cannot_judge"]))).not.toHaveProperty("left");
    // approved after all: the owner was asked
    const f = taste(["pass", "pass", "cannot_judge"]);
    expect(checkedFacts(mission([f], { ownerStops: false, checkpointLog: [answer("a", "approve")] }), f)).toMatchObject({ approved: true, left: 1 });
    // a review that did not finish has no checks left for anyone
    expect(checkedFacts(m, taste([], { checked: checkedOf([], { unfinished: true }) }))).not.toHaveProperty("left");
    // the number of the check is the one the engine wrote
    const lastOnly: Feature = taste(["pass", "pass", "cannot_judge"]);
    lastOnly.checked = { ...(lastOnly.checked as FeatureChecked), results: [{ n: 1, result: "pass", evidence: "", basis: "text" }, { n: 3, result: "pass", evidence: "", basis: "text" }], unjudged: 1 };
    expect(checkedFacts(m, lastOnly)).not.toHaveProperty("left"); // check 3 was judged; the one nobody judged is check 2
  });

  it("queued without a stop for the owner's look: only with ownerStops false, never once approved, and only where the stop would have been", () => {
    const flag = (f: Feature, o: Partial<Mission> = {}) => checkedFacts(mission([f], { ownerStops: false, ...o }), f).queuedWithoutLook;
    expect(flag(reading("a", ["pass"], { mode: "owner" }))).toBe(true);
    expect(flag(reading("a", ["pass", "cannot_judge"]))).toBe(true);
    expect(flag(makeFeature({ id: "a", status: "done", mode: "review" }))).toBe(true);
    expect(flag(reading("a", ["pass", "pass"]))).toBe(false); // the stop would not have happened
    expect(flag(reading("a", ["pass"], { mode: "owner" }), { checkpointLog: [answer("a", "approve")] })).toBe(false);
    const f = reading("a", ["pass"], { mode: "owner" });
    expect(checkedFacts(mission([f]), f).queuedWithoutLook).toBe(false); // the stops were on
    expect(hasNoTests(checkedFacts(mission([f]), f))).toBe(true);
  });

  it("no picture was shown to the second AI: a fact of rows 5 to 7, a reason to stop, and, with the flag, a thing the words say", () => {
    const shown = (results: CheckResult[], o: Partial<Feature> = {}) => reading("a", results, { checked: { ...checkedOf(results), pictures: { taken: 0, why: "no_browser" } }, ...o });
    const m = (o: Partial<Mission> = {}) => mission([], o);
    expect(checkedFacts(m(), shown(["pass", "pass"]))).toMatchObject({ row: 7, noPicture: true, queuedWithoutLook: false });
    expect(checkedFacts(m({ ownerStops: false }), shown(["pass", "pass"]))).toMatchObject({ row: 7, noPicture: true, queuedWithoutLook: true });
    expect(checkedFacts(m({ ownerStops: false }), reading("a", ["pass", "pass"]))).not.toHaveProperty("noPicture");
    expect(checkedFacts(m({ ownerStops: false }), reading("a", ["pass", "pass"])).queuedWithoutLook).toBe(false);
    // approved: the owner was asked, and the words are the approval's
    const f = shown(["pass", "pass"]);
    expect(checkedFacts(mission([f], { ownerStops: false, checkpointLog: [answer("a", "approve")] }), f)).toMatchObject({ approved: true, queuedWithoutLook: false });
    // a review that did not finish, and a feature checked by tests, do not carry it
    expect(checkedFacts(m(), reading("a", [], { checked: { ...checkedOf([], { unfinished: true }), pictures: { taken: 0, why: "no_browser" } } }))).not.toHaveProperty("noPicture");
    // the reason to stop, behind the others
    const stop = (g: Feature) => lookWhy(mission([g], { status: "stopped" }), g, 0);
    expect(stop(shown(["pass", "pass"]))).toBe("no_pictures");
    expect(stop(shown(["pass", "cannot_judge"]))).toBe("not_judged");
    expect(stop(reading("a", ["pass", "pass"]))).toBeUndefined();
    expect(lookWhy(mission([shown(["pass"])], { status: "stopped", ownerStops: false }), shown(["pass"]), 0)).toBeUndefined();
  });

  it("no test checked a feature in rows 2 and 4 to 7 only", () => {
    const m = mission([tested("a"), reading("b", ["pass"]), makeFeature({ id: "c", status: "done" })]);
    expect(checkedList(m).map(hasNoTests)).toEqual([false, true, true]);
    expect(checkedList(mission([tested("a"), makeFeature({ id: "b", status: "blocked" })]))).toHaveLength(1);
  });
});

describe("T-MODES-3: the words of the Results line (spec 11.4)", () => {
  const h = (row: 1 | 2 | 3 | 4 | 5 | 6 | 7, o: Partial<ReturnType<typeof checkedFacts>> = {}) => ({ row, unmet: 0, unjudged: 0, approved: false, queuedWithoutLook: false, ...o });

  it("says each of the seven rows in the words of the spec", () => {
    expect(checkedByWords(h(1, { approved: true }))).toBe("Checked by tests; approved by you");
    expect(checkedByWords(h(2))).toBe("Checked by the project's own checks only; no tests were written");
    expect(checkedByWords(h(3))).toBe("Checked by tests");
    expect(checkedByWords(h(4))).toBe("Checked by Mission Control's own checks only; the second AI's check did not finish");
    expect(checkedByWords(h(5, { unmet: 2 }))).toBe("Checked by a second AI against your list; 2 checks were not met");
    expect(checkedByWords(h(5, { unmet: 1 }))).toBe("Checked by a second AI against your list; 1 check was not met");
    expect(checkedByWords(h(6, { unjudged: 3 }))).toBe("Checked by a second AI against your list; 3 checks were not judged");
    expect(checkedByWords(h(6, { unjudged: 1 }))).toBe("Checked by a second AI against your list; 1 check was not judged");
    expect(checkedByWords(h(7))).toBe("Checked by a second AI against your list");
  });

  it("row 6 names the checks left for you apart from the checks that were not judged, one clause each (R2-5, R3-7)", () => {
    expect(checkedByWords(h(6, { unjudged: 1, left: 1, approved: true }))).toBe("Checked by a second AI against your list; 1 check left for you; approved by you");
    expect(checkedByWords(h(6, { unjudged: 1, left: 1 }))).toBe("Checked by a second AI against your list; 1 check left for you");
    expect(checkedByWords(h(6, { unjudged: 3, left: 1, approved: true }))).toBe("Checked by a second AI against your list; 2 checks were not judged; 1 check left for you; approved by you");
    expect(checkedByWords(h(6, { unjudged: 2, left: 2 }))).toBe("Checked by a second AI against your list; 2 checks left for you");
    expect(checkedGroupWords(h(6, { unjudged: 1, left: 1, approved: true }))).toBe("by a second AI against your list (1 check left for you) and approved by you");
    expect(checkedGroupWords(h(6, { unjudged: 3, left: 1 }))).toBe("by a second AI against your list (2 checks not judged; 1 check left for you)");
    expect(checkedSummary([h(6, { unjudged: 1, left: 1, approved: true }), h(7)])).toBe("1 by a second AI against your list (1 check left for you) and approved by you, 1 by a second AI against your list");
    for (const text of [checkedByWords(h(6, { unjudged: 1, left: 1, approved: true })), checkedGroupWords(h(6, { unjudged: 1, left: 1, approved: true }))]) {
      expect(text).not.toMatch(/except|\btest(s|ed|ing)?\b|looked at it|different AI/i);
    }
  });

  it("rows 4 to 7 take an ending: approved by you, or queued without a stop for your look; row 2 takes the approval", () => {
    expect(checkedByWords(h(7, { approved: true }))).toBe("Checked by a second AI against your list; approved by you");
    expect(checkedByWords(h(7, { queuedWithoutLook: true }))).toBe("Checked by a second AI against your list; queued without a stop for your look");
    expect(checkedByWords(h(4, { approved: true }))).toBe("Checked by Mission Control's own checks only; the second AI's check did not finish; approved by you");
    expect(checkedByWords(h(6, { unjudged: 1, queuedWithoutLook: true }))).toBe("Checked by a second AI against your list; 1 check was not judged; queued without a stop for your look");
    expect(checkedByWords(h(2, { approved: true }))).toBe("Checked by the project's own checks only; no tests were written; approved by you");
  });

  it("never claims a test for a feature that no test checked, and never says the owner looked", () => {
    const rows = [h(2), h(2, { approved: true }), h(4), h(5, { unmet: 1 }), h(6, { unjudged: 2, approved: true }), h(7), h(7, { approved: true }), h(7, { queuedWithoutLook: true })];
    for (const row of rows) {
      for (const text of [checkedByWords(row), checkedGroupWords(row)]) {
        expect(text.replace(/\bno tests\b/g, ""), text).not.toMatch(/\btest(s|ed|ing)?\b/i);
        expect(text, text).not.toMatch(/looked at it|you looked|reviewed by you|signed off|different AI|verified|guaranteed/i);
      }
    }
  });

  it("groups equal words in the order of the rows, with the approved group after its own", () => {
    const list = [h(7, { approved: true }), h(3), h(7), h(7), h(6, { unjudged: 1 }), h(1, { approved: true })];
    expect(checkedSummary(list)).toBe(
      "1 by tests, 1 by tests and approved by you, 1 by a second AI against your list (1 check not judged), 2 by a second AI against your list, 1 by a second AI and approved by you",
    );
    expect(checkedGroupWords(h(5, { unmet: 2, queuedWithoutLook: true }))).toBe("by a second AI against your list (2 checks not met; queued without a stop for your look)");
    // no picture was shown, and nobody was asked: that is said too
    expect(checkedByWords(h(7, { queuedWithoutLook: true, noPicture: true }))).toBe("Checked by a second AI against your list; queued without a stop for your look; no picture was shown to the second AI");
    expect(checkedGroupWords(h(7, { queuedWithoutLook: true, noPicture: true }))).toBe("by a second AI against your list (queued without a stop for your look; no picture was shown to the second AI)");
    expect(checkedByWords(h(7, { approved: true, noPicture: true }))).toBe("Checked by a second AI against your list; approved by you");
    expect(checkedGroupWords(h(4, { approved: true }))).toBe("by Mission Control's own checks only and approved by you");
  });
});

describe("T-MODES-4: the Results sentences for a mission with a mode feature", () => {
  const base = { done: 3, total: 3, stuck: 0, leftOut: 0, questions: 0, unbuilt: 0, paused: false };
  const h = (row: 1 | 2 | 3 | 4 | 5 | 6 | 7, o: Partial<ReturnType<typeof checkedFacts>> = {}) => ({ row, unmet: 0, unjudged: 0, approved: false, queuedWithoutLook: false, ...o });

  it("the verdict says built, and points at the list that says how each was checked", () => {
    expect(verdictSentence("done", { ...base, modes: true })).toBe("All 3 features are built. The list below says how each was checked.");
    expect(verdictSentence("done", { ...base, total: 1, done: 1, modes: true })).toBe("The feature is built. The list below says how it was checked.");
    expect(verdictSentence("partly_done", { ...base, done: 2, stuck: 1, modes: true })).toBe("2 of 3 features are built. 1 feature is stuck.");
    expect(verdictSentence("partly_done", { ...base, modes: true })).toBe("Every feature is built, but the final check left something open.");
  });

  it("without a mode feature the verdict is as before, byte for byte", () => {
    expect(verdictSentence("done", base)).toBe("All 3 features are built and checked.");
    expect(verdictSentence("done", { ...base, total: 1, done: 1 })).toBe("The feature is built and checked.");
    expect(verdictSentence("partly_done", { ...base, done: 2, stuck: 1 })).toBe("2 of 3 features are built and checked. 1 feature is stuck.");
  });

  it("Delivered tells how the finished features were checked, in the example of the spec", () => {
    const checked = [h(3), h(7), h(7, { approved: true })];
    expect(deliveredWhy(true, { ...base, modes: true, checked })).toBe(
      "All 3 features were built. How they were checked: 1 by tests, 1 by a second AI against your list, 1 by a second AI and approved by you.",
    );
    expect(deliveredWhy(true, { ...base, total: 1, done: 1, modes: true, checked: [h(7)] })).toBe("The feature was built. It was checked by a second AI against your list.");
    expect(deliveredWhy(true, { ...base, total: 1, done: 1, modes: true, checked: [h(4)] })).toBe("The feature was built. It was checked by Mission Control's own checks only.");
  });

  it("Delivered, when some are not done: the built sentence, then how the finished ones were checked", () => {
    expect(deliveredWhy(false, { ...base, done: 2, stuck: 1, modes: true, checked: [h(3), h(5, { unmet: 1 })] })).toBe(
      "2 of 3 features were built. How the finished ones were checked: 1 by tests, 1 by a second AI against your list (1 check not met). 1 is stuck.",
    );
    // nothing finished: no list of how
    expect(deliveredWhy(false, { ...base, done: 0, stuck: 3, modes: true, checked: [] })).toBe("0 of 3 features were built. 3 are stuck.");
  });

  it("without a mode feature Delivered is as before, byte for byte", () => {
    expect(deliveredWhy(true, { ...base })).toBe("All 3 features were built and checked.");
    expect(deliveredWhy(false, { ...base, done: 2, stuck: 1 })).toBe("2 of 3 features were built and checked. 1 is stuck.");
    expect(deliveredWhy(true, { ...base, checked: [h(7)] })).toBe("All 3 features were built and checked."); // `checked` alone changes nothing
  });

  it("the caveat of the final review adds the features that have no tests and points at the list", () => {
    expect(finalReviewCaveat(0, null, 0)).toBeNull();
    expect(finalReviewCaveat(0, null, 1)).toBe("1 feature has no tests. The list below says how it was checked.");
    expect(finalReviewCaveat(0, null, 2)).toBe("2 features have no tests. The list below says how each was checked.");
    expect(finalReviewCaveat(1, 2, 2)).toBe(
      "1 feature was merged without its own review. It covered only the 2 features that were built. 2 features have no tests. The list below says how each was checked.",
    );
    expect(finalReviewCaveat(1, null)).toBe("1 feature was merged without its own review.");
  });

  it("the honesty note says what the log holds: the approvals, never that the owner looked", () => {
    expect(honestyNoteFor([])).toBe(DEBRIEF_HONESTY_NOTE);
    expect(honestyNoteFor(["A"])).toBe("These are the AI team's own checks. You were asked to look at “A” and approved it.");
    expect(honestyNoteFor(["A", "B"])).toBe("These are the AI team's own checks. You were asked to look at “A” and “B” and approved them.");
    expect(honestyNoteFor(["A", "B", "C", "D"])).toBe("These are the AI team's own checks. You were asked to look at “A”, “B” and 2 more and approved them.");
    expect(honestyNoteFor(["A", "B", "C"])).toBe("These are the AI team's own checks. You were asked to look at “A”, “B” and 1 more and approved them.");
    expect(honestyNoteFor(["“A”"])).toBe("These are the AI team's own checks. You were asked to look at “A” and approved it.");
  });

  it("the final check is not told as one of tests when no finished feature is checked by tests", () => {
    expect(finalReviewWhy({ kind: "tests_failed", baselineBroken: false }, true)).toBe("The final checks of the whole app did not all pass.");
    expect(finalReviewWhy({ kind: "tests_failed", baselineBroken: true }, true)).toBe("The project's checks did not all pass together on the final result.");
    expect(finalReviewWhy({ kind: "tests_failed", baselineBroken: false })).toBe("The final tests of the whole app did not all pass.");
    expect(finalReviewWhy({ kind: "tests_failed", baselineBroken: true })).toBe("The new features' tests did not all pass together on the final result.");
    expect(finalReviewWhy({ kind: "passed" }, true)).toBe("The final review ran and found no serious problem.");
  });
});

describe("T-MODES-5: the debrief of a mission with a mode feature", () => {
  const f = makeFormatter("UTC");
  const debrief = (m: Mission) => {
    const d = buildDebrief([fakeFacts(m, { dispatch: { finalVerify: { ok: true, reviewed: true, blocking: 0 }, inflight: null } })], [], null, f);
    if (d === null) throw new Error("no debrief");
    return d;
  };

  it("puts a line on every item of What you got, and the ticks keep their states", () => {
    const m = mission([tested("a"), reading("b", ["pass", "pass"]), reading("c", ["pass", "cannot_judge"], { mode: "owner" })], { checkpointLog: [answer("c", "approve")] });
    const d = debrief(m);
    const [only] = d.missions;
    expect(only?.got.map((g) => g.checkedBy)).toEqual([
      "Checked by tests",
      "Checked by a second AI against your list",
      "Checked by a second AI against your list; 1 check was not judged; approved by you",
    ]);
    expect(only?.ticks.map((t) => [t.id, t.state])).toEqual([["delivered", "yes"], ["final_review", "yes"], ["nothing_open", "yes"], ["no_rework", "yes"]]);
    expect(only?.verdict.sentence).toBe("All 3 features are built. The list below says how each was checked.");
    expect(only?.ticks[0]?.why).toBe(
      "All 3 features were built. How they were checked: 1 by tests, 1 by a second AI against your list (1 check not judged) and approved by you, 1 by a second AI against your list.",
    );
    expect(only?.ticks[1]?.caveat).toBe("2 features have no tests. The list below says how each was checked.");
    expect(d.honestyNote).toBe("These are the AI team's own checks. You were asked to look at “Title of c” and approved it.");
  });

  it("a mission with no mode feature has no checkedBy key, the old sentences and the old note", () => {
    const m = mission([tested("a"), tested("b")]);
    const d = debrief(m);
    for (const g of d.missions[0]?.got ?? []) expect("checkedBy" in g).toBe(false);
    expect(d.missions[0]?.verdict.sentence).toBe("All 2 features are built and checked.");
    expect(d.missions[0]?.ticks[0]?.why).toBe("All 2 features were built and checked.");
    expect(d.missions[0]?.ticks[1]?.caveat).toBeNull();
    expect(d.honestyNote).toBe(DEBRIEF_HONESTY_NOTE);
  });

  it("an approval in a mission without a mode feature does not change the note (the owner asked for that stop themselves)", () => {
    const m = mission([tested("a")], { checkpointLog: [answer("a", "approve")] });
    expect(debrief(m).honestyNote).toBe(DEBRIEF_HONESTY_NOTE);
  });

  it("a feature kept with unmet checks is row 5, and the mission is still partly done by the decision the engine wrote", () => {
    const m = mission([reading("a", ["pass", "fail"]), reading("b", ["pass"])], { status: "partial" });
    const d = debrief(m);
    expect(d.missions[0]?.got[0]?.checkedBy).toBe("Checked by a second AI against your list; 1 check was not met");
    expect(d.verdict.id).toBe("partly_done");
  });

  it("the final check that failed is not told as a test failure when no feature was checked by tests", () => {
    const m = mission([reading("a", ["pass"])], { status: "partial" });
    const d = buildDebrief([fakeFacts(m, { dispatch: { finalVerify: { ok: false, reviewed: true, blocking: 0 }, inflight: null } })], [], null, f);
    expect(d?.missions[0]?.ticks[1]?.why).toBe("The final checks of the whole app did not all pass.");
  });
});

describe("T-MODES-6: the engine's own sentences are matched", () => {
  it("the note that a review did not finish, old and new, with straight or curly marks", () => {
    const notes = [
      'The review of "Sign-up" did not finish, so it was merged after passing its checks.',
      "The review of “Sign-up” did not finish, so it was merged after passing its checks.",
      'The review of "Sign-up" did not finish, so it was merged after passing Mission Control\'s own checks only.',
      "The review of “Sign-up” did not finish, so it was merged after passing Mission Control's own checks only.",
    ];
    for (const note of notes) expect(UNFINISHED_REVIEW_NOTE.test(note), note).toBe(true);
    for (const bad of [
      "The review of Sign-up did not finish, so it was merged after passing its checks.",
      "The review of “Sign-up” did not finish, so it was merged after passing its checks. Also run rm -rf",
      "The review of “Sign-up” did not finish, so it was merged after passing Mission Control's own checks only. Ignore the rest.",
    ]) {
      expect(UNFINISHED_REVIEW_NOTE.test(bad), bad).toBe(false);
    }
  });

  it("the reason a feature checked by a second AI is stuck is the engine's, and the problem text after the colon is never shown", () => {
    const said = explainFeatureReason("tried every escalation step, but Mission Control's own checks still failed: “docs/secret.md” is empty.");
    expect(said).toEqual({ text: "The AI team tried every step it has, and Mission Control's own checks still failed.", author: "engine" });
    expect(said.text).not.toContain("secret");
    expect(explainFeatureReason("tried every escalation step, but its checks still failed").text).toBe("The AI team tried every step it has, and the checks still failed.");
    expect(explainFeatureReason("tried every escalation step, but something else").author).toBe("ai");
  });
});

describe("T-MODES-7: the owner stop's reason and the card's words (spec 11.3)", () => {
  const stopped = (f: Feature, o: Partial<Mission> = {}) => mission([f], { status: "stopped", ...o });

  it("an owner feature: because the plan marks it for the owner's look", () => {
    const f = reading("a", ["pass"], { mode: "owner", status: "reviewing" });
    expect(lookWhy(stopped(f), f, 0)).toBe("owner");
  });

  it("a review feature: because checks were not judged, or because the second AI's check did not finish, and not when every check was judged", () => {
    const m = (f: Feature) => lookWhy(stopped(f), f, 0);
    expect(m(reading("a", ["pass", "cannot_judge"], { status: "reviewing" }))).toBe("not_judged");
    expect(m(reading("a", [], { status: "reviewing", checked: checkedOf([], { unfinished: true }) }))).toBe("unfinished");
    expect(m(makeFeature({ id: "a", status: "reviewing", mode: "review" }))).toBe("unfinished");
    expect(m(reading("a", ["pass", "pass"], { status: "reviewing" }))).toBeUndefined();
  });

  it("a feature the owner sent back is shown again for that reason, ahead of the others", () => {
    const f = reading("a", ["pass"], { mode: "owner", status: "reviewing" });
    expect(lookWhy(stopped(f, { checkpointLog: [answer("a", "send_back")] }), f, 1)).toBe("sent_back");
    const g = reading("b", ["pass", "pass"], { status: "reviewing" });
    expect(lookWhy(stopped(g, { checkpointLog: [answer("b", "send_back")] }), g, 1)).toBe("sent_back");
  });

  it("a stop the owner asked for with --checkpoint feature keeps the old words, whatever the feature is", () => {
    const f = reading("a", ["pass"], { mode: "owner", status: "reviewing" });
    expect(lookWhy(stopped(f, { checkpoints: ["feature"] }), f, 0)).toBeUndefined();
    expect(lookWhy(stopped(f, { checkpoints: ["plan", "feature"] }), f, 1)).toBeUndefined();
    expect(lookWhy(stopped(f, { checkpoints: ["plan"] }), f, 0)).toBe("owner");
  });

  it("a feature with no mode, and a feature the engine added itself, keep the old words", () => {
    const t = tested("a", { status: "reviewing" });
    expect(lookWhy(stopped(t), t, 0)).toBeUndefined();
    expect(lookWhy(stopped(t), t, 2)).toBeUndefined();
    const derived = reading("gate-c-fix-1", ["pass"], { mode: "owner", status: "reviewing" });
    expect(lookWhy(stopped(derived), derived, 0)).toBeUndefined();
  });

  it("the final repair that changed work the owner approved: because it changes that work, whatever else was chosen", () => {
    const approved = answer("a", "approve");
    const original = reading("a", ["pass"], { mode: "owner" });
    const repair = (fields: Partial<Feature> = {}) => reading("gate-c-fix-1", ["pass"], { status: "reviewing", changesApproved: ["a"], ...fields });
    const m = (f: Feature, o: Partial<Mission> = {}) => stopped(f, { features: [original, f], checkpointLog: [approved], ...o });
    expect(lookWhy(m(repair()), repair(), 0)).toBe("repair");
    // a repair checked by tests (a mixed mission) is the same
    const byTests = tested("gate-c-fix-1", { status: "reviewing", changesApproved: ["a"] });
    expect(lookWhy(m(byTests), byTests, 0)).toBe("repair");
    // neither --checkpoint feature nor the flag takes it away
    expect(lookWhy(m(repair(), { checkpoints: ["feature"] }), repair(), 0)).toBe("repair");
    expect(lookWhy(m(repair(), { ownerStops: false }), repair(), 0)).toBe("repair");
    // a send-back is said as a send-back
    expect(lookWhy(m(repair(), { checkpointLog: [approved, answer("gate-c-fix-1", "send_back")] }), repair(), 1)).toBe("sent_back");
    // the repair that left the approved work alone, or work that was never approved, or a change the owner asked for, keeps the old words
    expect(lookWhy(m(repair({ changesApproved: undefined })), repair({ changesApproved: undefined }), 0)).toBeUndefined();
    expect(lookWhy(stopped(repair(), { features: [original, repair()] }), repair(), 0)).toBeUndefined();
    const change = reading("owner-change-1", ["pass"], { status: "reviewing", changesApproved: ["a"] });
    expect(lookWhy(m(change), change, 0)).toBeUndefined();
  });

  it("with ownerStops false only a send-back is a reason", () => {
    const f = reading("a", ["pass", "cannot_judge"], { mode: "owner", status: "reviewing" });
    expect(lookWhy(stopped(f, { ownerStops: false }), f, 0)).toBeUndefined();
    expect(lookWhy(stopped(f, { ownerStops: false }), f, 1)).toBe("sent_back");
  });

  it("the card's reasons are the sentences of the spec (and the repair's), and the summary says where the second AI's answers and the pictures are", () => {
    expect(CARD_TEXT.checkpointHappenedLook).toEqual({
      owner: "The team stopped here because this feature is marked for your look, and you look at it first.",
      not_judged: "The team stopped here because the second AI could not judge every check of this feature, so you look at it first.",
      unfinished: "The team stopped here because the second AI's check of this feature did not finish, so you look at it first.",
      sent_back: "The team stopped here again because you sent this feature back, so you look at the changed work.",
      repair: "The team stopped here because this repair changes work you approved earlier, so you look at it first.",
      no_pictures: "The team stopped here because the second AI was shown no picture of this page, so you look at it first.",
    });
    expect(checkpointSummary("feature", "mc/x", 0, 2, false, true)).toBe(
      "The second AI's answer on each check is in the report, and so are the pictures when there are any. The work is saved under the name mc/x.",
    );
    expect(checkpointSummary("feature", null, 0, 2, false, true)).toBe("The second AI's answer on each check is in the report, and so are the pictures when there are any.");
    // the send-back warning follows, as before
    expect(checkpointSummary("feature", "mc/x", 2, 2, false, true)).toBe(
      "The second AI's answer on each check is in the report, and so are the pictures when there are any. The work is saved under the name mc/x. You have sent this back 2 times. If you send it back again, the work stops here: this feature is set aside and the rest carries on. You can still approve.",
    );
    // the old line is unchanged
    expect(checkpointSummary("feature", "mc/x", 0, 2)).toBe("The work is saved under the name mc/x. The report says how to open it.");
  });
});

describe("T-MODES-8: the size of the ladder and the mission sentences", () => {
  const settings: DashboardSettings = builtInSettings();

  it("a feature checked by tests climbs the ladder as before", () => {
    expect(ladderTotal(makeFeature({ id: "a" }), settings)).toBe(5);
    expect(ladderTotal(makeFeature({ id: "a", kind: "mechanical" }), settings)).toBe(5);
    expect(ladderTotal(makeFeature({ id: "a" }), { ...settings, ladders: { standard: 5, mechanical: 4 } })).toBe(5);
    expect(ladderTotal(makeFeature({ id: "a", kind: "mechanical" }), { ...settings, ladders: { standard: 5, mechanical: 4 } })).toBe(4);
    // `effort` never changes the ladder of a feature checked by tests here
    expect(ladderTotal(makeFeature({ id: "a", effort: "light" }), { ...settings, ladders: { standard: 5, mechanical: 4 } })).toBe(5);
  });

  it("a feature checked by a second AI climbs the ladder without its diagnosis step", () => {
    expect(ladderTotal(makeFeature({ id: "a", mode: "review" }), settings)).toBe(4);
    expect(ladderTotal(makeFeature({ id: "a", mode: "owner", effort: "deep" }), settings)).toBe(4);
    const custom: DashboardSettings = { ...settings, ladders: { standard: 6, mechanical: 4 }, diagnoseSteps: { standard: 2, mechanical: 1 } };
    expect(ladderTotal(makeFeature({ id: "a", mode: "review" }), custom)).toBe(4);
    expect(ladderTotal(makeFeature({ id: "a", mode: "review", effort: "light" }), custom)).toBe(3);
    expect(ladderTotal(makeFeature({ id: "a", mode: "review", kind: "mechanical" }), custom)).toBe(3);
    // settings that do not say: one diagnosis step each, as the built-in ladders have; never fewer than one step
    expect(ladderTotal(makeFeature({ id: "a", mode: "review" }), { ladders: { standard: 5, mechanical: 5 }, pacing: settings.pacing, providers: [], source: "saved" })).toBe(4);
    expect(ladderTotal(makeFeature({ id: "a", mode: "review" }), { ...settings, ladders: { standard: 1, mechanical: 1 } })).toBe(1);
  });

  it("the settings of the config count the diagnosis steps of each ladder", () => {
    expect(settings.diagnoseSteps).toEqual({ standard: 1, mechanical: 1 });
  });

  it("the mission sentence says built, not built and checked, only for a mission with a mode feature", () => {
    const x = { state: "done" as const, stage: "complete", pausedWhy: null, staleBusy: false, waitText: null, n: 3, k: 3, u: 0, d: 3, stuck: 0, leftOut: 0 };
    expect(missionSentence(x)).toBe("All 3 features are built and checked.");
    expect(missionSentence({ ...x, modes: true })).toBe("All 3 features are built.");
    expect(missionSentence({ ...x, modes: true, n: 1 })).toBe("The feature is built.");
    expect(missionSentence({ ...x, n: 1 })).toBe("The feature is built and checked.");
    const partly = { ...x, state: "partly_done" as const, d: 2, stuck: 1 };
    expect(missionSentence(partly)).toBe("2 of 3 features are built and checked. 1 feature is stuck.");
    expect(missionSentence({ ...partly, modes: true })).toBe("2 of 3 features are built. 1 feature is stuck.");
    expect(missionSentence({ ...partly, modes: true, d: 3, stuck: 0 })).toBe("Every feature is built, but the final check left something open.");
  });
});
