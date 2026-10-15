// The words and the rule of docs/modes-spec.md 10.1 and 5.2 (step 8): how a done feature was checked, and who is asked to look.
import { describe, expect, it } from "vitest";
import {
  askedBecause,
  asksForLook,
  type CheckedMission,
  checkedLine,
  checkedWords,
  hasModeFeature,
  howChecked,
  isDerivedFeature,
  isModeFeature,
  lookReason,
  ownerSentences,
  pictureReason,
  stoppedBecause,
  tableWords,
} from "./checked-by.js";
import type { CheckedResult, CheckpointRecord, Feature, FeatureChecked } from "./types.js";

const RESULT = (n: number, result: CheckedResult["result"]): CheckedResult => ({ n, result, evidence: `Evidence ${n}`, basis: "text" });

function checked(results: CheckedResult["result"][], extra: Partial<FeatureChecked> = {}): FeatureChecked {
  return {
    round: 1,
    reviewer: "claude",
    results: results.map((r, i) => RESULT(i + 1, r)),
    unjudged: results.filter((r) => r === "cannot_judge").length,
    scripted: { problems: [], facts: [] },
    pictures: { taken: 0 },
    ...extra,
  };
}

function feature(id: string, fields: Partial<Feature> = {}, checks = 3): Feature {
  return {
    id,
    title: `Title of ${id}`,
    story: "As a user.",
    acceptance: Array.from({ length: checks }, (_, i) => `Check ${i + 1}.`),
    kind: "standard",
    deps: [],
    status: "done",
    rung: 0,
    attempts: [],
    frozenTests: [{ path: "a.test.ts", sha256: "x" }],
    reviewRounds: 0,
    openFindings: [],
    ...fields,
  };
}

const log = (scope: string, decision: CheckpointRecord["decision"], round = 1): CheckpointRecord => ({ id: `${scope}#${round}`, scope, kind: "feature", round, decision, at: "2026-10-12T13:30:00.000Z" });

function mission(features: Feature[], fields: Partial<CheckedMission> = {}): CheckedMission {
  return { features, ...fields };
}

const ALL_PASS = checked(["pass", "pass", "pass"]);

describe("the small predicates", () => {
  it("a mode feature is one with a mode, and nothing else marks one", () => {
    expect(isModeFeature({})).toBe(false);
    expect(isModeFeature({ mode: "review" })).toBe(true);
    expect(isModeFeature({ mode: "owner" })).toBe(true);
    // a word that is not one of the two is not a mode: it is never read as "checked by reading with no stop"
    for (const odd of [null, 5, true, "", "Owner", "OWNER", "owner ", "tests", ["owner"], {}]) expect(isModeFeature({ mode: odd as never })).toBe(false);
    expect(hasModeFeature([{}, {}])).toBe(false);
    expect(hasModeFeature([{}, { mode: "owner" }])).toBe(true);
    expect(hasModeFeature([])).toBe(false);
  });

  it("knows the features the engine adds by itself", () => {
    expect(isDerivedFeature("gate-c-fix-1")).toBe(true);
    expect(isDerivedFeature("owner-change-3")).toBe(true);
    expect(isDerivedFeature("gate-c-fix")).toBe(false);
    expect(isDerivedFeature("my-gate-c-fix-1")).toBe(false);
  });
});

describe("howChecked: the seven rows of the table in 10.1", () => {
  it("row 3, a feature checked by tests", () => {
    const f = feature("a");
    expect(howChecked(mission([f]), f)).toMatchObject({ row: 3, approved: false, sentBack: 0, queuedWithoutLook: false, total: 0, unfinished: false });
  });

  it("row 1, a feature checked by tests that the owner approved", () => {
    const f = feature("a");
    const h = howChecked(mission([f], { checkpointLog: [log("feature:a", "approve")] }), f);
    expect(h).toMatchObject({ row: 1, approved: true });
  });

  it("row 2, a feature whose test author wrote no test, approved or not", () => {
    const f = feature("a", { frozenTests: [] });
    expect(howChecked(mission([f]), f).row).toBe(2);
    expect(howChecked(mission([f], { checkpointLog: [log("feature:a", "approve")] }), f)).toMatchObject({ row: 2, approved: true });
  });

  it("row 4, a mode feature with no record of the second AI's answer, or an unfinished one", () => {
    const none = feature("a", { mode: "review" });
    expect(howChecked(mission([none]), none)).toMatchObject({ row: 4, unfinished: true, total: 3, passed: 0, failed: 0, unjudged: 3 });
    const gone = feature("b", { mode: "review", checked: checked([], { unfinished: true, unjudged: 3 }) });
    expect(howChecked(mission([gone]), gone)).toMatchObject({ row: 4, unfinished: true, unjudged: 3 });
  });

  it("row 5, checks left unmet, row 6, checks not judged, row 7, every check judged and met", () => {
    const five = feature("a", { mode: "review", checked: checked(["pass", "fail", "cannot_judge"]) });
    expect(howChecked(mission([five]), five)).toMatchObject({ row: 5, passed: 1, failed: 1, unjudged: 1, total: 3, unfinished: false });
    const six = feature("b", { mode: "review", checked: checked(["pass", "cannot_judge", "pass"]) });
    expect(howChecked(mission([six]), six)).toMatchObject({ row: 6, passed: 2, failed: 0, unjudged: 1 });
    const seven = feature("c", { mode: "owner", checked: ALL_PASS });
    expect(howChecked(mission([seven]), seven)).toMatchObject({ row: 7, passed: 3, failed: 0, unjudged: 0 });
  });

  it("counts a check with no result as a check nobody judged", () => {
    const f = feature("a", { mode: "review", checked: checked(["pass", "pass"]) });
    expect(howChecked(mission([f]), f)).toMatchObject({ row: 6, passed: 2, unjudged: 1 });
  });

  it("holds an approval only from the log of that feature, and counts the send-backs", () => {
    const f = feature("a", { mode: "owner", checked: ALL_PASS });
    const m = mission([f], { checkpointLog: [log("feature:other", "approve"), log("feature:a", "send_back"), log("feature:a", "send_back", 2), log("feature:a", "approve", 3)] });
    expect(howChecked(m, f)).toMatchObject({ approved: true, sentBack: 2 });
    expect(howChecked(mission([f], { checkpointLog: [log("feature:other", "approve")] }), f)).toMatchObject({ approved: false, sentBack: 0 });
    // a damaged log is read as empty
    expect(howChecked({ features: [f], checkpointLog: "oops" as unknown as CheckpointRecord[] }, f).approved).toBe(false);
  });

  it("says it was queued without a stop only for rows 4 to 7, with the flag, not approved, and an owner feature or checks not judged", () => {
    const flag = { ownerStops: false as const };
    const owner = feature("a", { mode: "owner", checked: ALL_PASS });
    expect(howChecked(mission([owner], flag), owner).queuedWithoutLook).toBe(true);
    expect(howChecked(mission([owner]), owner).queuedWithoutLook).toBe(false);
    expect(howChecked(mission([owner], { ...flag, checkpointLog: [log("feature:a", "approve")] }), owner).queuedWithoutLook).toBe(false);
    const clean = feature("b", { mode: "review", checked: ALL_PASS });
    expect(howChecked(mission([clean], flag), clean).queuedWithoutLook).toBe(false);
    const unjudged = feature("c", { mode: "review", checked: checked(["pass", "cannot_judge", "pass"]) });
    expect(howChecked(mission([unjudged], flag), unjudged).queuedWithoutLook).toBe(true);
    const unfinished = feature("d", { mode: "review" });
    expect(howChecked(mission([unfinished], flag), unfinished).queuedWithoutLook).toBe(true);
    const tests = feature("e");
    expect(howChecked(mission([tests], flag), tests).queuedWithoutLook).toBe(false);
  });
});

describe("the words of the Checked: line and of the Features table", () => {
  const f = (checks: CheckedResult["result"][] | undefined, mode: "review" | "owner" = "review", extra: Partial<Feature> = {}): Feature =>
    feature("a", { mode, ...(checks && { checked: checked(checks) }), ...extra });
  const words = (feat: Feature, fields: Partial<CheckedMission> = {}): { line: string; table: string } => {
    const h = howChecked(mission([feat], fields), feat);
    return { line: checkedWords(h), table: tableWords(h) };
  };
  const approve = { checkpointLog: [log("feature:a", "approve")] };

  it("row 1, 2 and 3", () => {
    expect(words(feature("a"))).toEqual({ line: "by tests", table: "Built and checked" });
    expect(words(feature("a"), approve)).toEqual({ line: "by tests, and approved by you", table: "Built and checked by tests; approved by you" });
    expect(words(feature("a", { frozenTests: [] }))).toEqual({
      line: "by the project's own checks only (no tests were written for it)",
      table: "Built; checked by the project's own checks only, because no tests were written for it",
    });
    expect(words(feature("a", { frozenTests: [] }), approve)).toEqual({
      line: "by the project's own checks only (no tests were written for it), and approved by you",
      table: "Built; checked by the project's own checks only, because no tests were written for it; approved by you",
    });
  });

  it("row 4", () => {
    expect(words(f(undefined))).toEqual({
      line: "by Mission Control's own checks only (the second AI's check did not finish)",
      table: "Built; the second AI's check did not finish, so only Mission Control's own checks ran",
    });
  });

  it("row 5, with the plural and the singular", () => {
    expect(words(f(["pass", "fail", "fail"]))).toEqual({ line: "by a second AI against your list (2 checks not met)", table: "Built, but 2 of 3 checks were not met (see the review notes)" });
    expect(words(f(["fail", "pass", "pass"]))).toEqual({ line: "by a second AI against your list (1 check not met)", table: "Built, but 1 of 3 checks were not met (see the review notes)" });
    expect(words(feature("a", { mode: "review", checked: checked(["fail"]) }, 1))).toEqual({ line: "by a second AI against your list (1 check not met)", table: "Built, but 1 of 1 check was not met (see the review notes)" });
    expect(words(f(["fail", "cannot_judge", "pass"])).table).toBe("Built, but 1 of 3 checks were not met (see the review notes), and 1 was not judged by anyone");
    expect(words(f(["fail", "cannot_judge", "cannot_judge"])).table).toBe("Built, but 1 of 3 checks were not met (see the review notes), and 2 were not judged by anyone");
  });

  it("row 6", () => {
    expect(words(f(["pass", "cannot_judge", "cannot_judge"]))).toEqual({ line: "by a second AI against your list, except 2 checks it could not judge", table: "Built; 2 checks were not judged by anyone" });
    expect(words(f(["pass", "cannot_judge", "pass"]))).toEqual({ line: "by a second AI against your list, except 1 check it could not judge", table: "Built; 1 check was not judged by anyone" });
  });

  it("row 7", () => {
    expect(words(f(["pass", "pass", "pass"]))).toEqual({ line: "by a second AI against your list", table: "Built; a second AI checked it against your list (3 of 3 passed)" });
  });

  it("the two endings: approved by you, or queued without a stop for your look", () => {
    expect(words(f(["pass", "pass", "pass"]), approve)).toEqual({ line: "by a second AI against your list and approved by you", table: "Built; a second AI checked it against your list (3 of 3 passed); approved by you" });
    expect(words(f(["pass", "fail", "pass"]), approve).line).toBe("by a second AI against your list (1 check not met) and approved by you");
    expect(words(f(["pass", "pass", "pass"], "owner"), { ownerStops: false })).toEqual({
      line: "by a second AI against your list (it was queued without a stop for your look)",
      table: "Built; a second AI checked it against your list (3 of 3 passed); it was queued without a stop for your look",
    });
    expect(words(f(undefined), { ownerStops: false }).line).toBe("by Mission Control's own checks only (the second AI's check did not finish) (it was queued without a stop for your look)");
    // an approval wins over the flag
    expect(words(f(["pass", "pass", "pass"], "owner"), { ownerStops: false, ...approve }).line).toBe("by a second AI against your list and approved by you");
    // a review feature whose checks were all judged was never going to stop
    expect(words(f(["pass", "pass", "pass"]), { ownerStops: false }).line).toBe("by a second AI against your list");
  });

  it("never says a test checked a feature that no test checked, nor that the owner looked", () => {
    const allowed = /no tests were written for it|by tests|tests, written first|Built and checked by tests/gi;
    const mode = [undefined, ["pass", "pass", "pass"], ["pass", "fail", "pass"], ["pass", "cannot_judge", "pass"], ["fail", "cannot_judge", "pass"]] as (CheckedResult["result"][] | undefined)[];
    for (const checks of mode) {
      for (const fields of [{}, approve, { ownerStops: false as const }]) {
        for (const feat of [f(checks), f(checks, "owner"), feature("a", { frozenTests: [] })]) {
          const { line, table } = words(feat, fields);
          for (const text of [line, table]) {
            expect(text.replace(allowed, "")).not.toMatch(/\btest(s|ed|ing)?\b/i);
            expect(text).not.toMatch(/looked at it|you looked|different AI|signed off|guarantee/i);
          }
        }
      }
    }
  });
});

describe("checkedLine", () => {
  it("is undefined when no finished feature has a mode, so a mission with no mode gets no new line", () => {
    expect(checkedLine(mission([feature("a"), feature("b")]))).toBeUndefined();
    expect(checkedLine(mission([feature("a"), feature("b", { mode: "review", status: "blocked" })]))).toBeUndefined();
    expect(checkedLine(mission([]))).toBeUndefined();
  });

  it("counts the finished features by how each was checked, in the order of the rows, with an approved group straight after its base", () => {
    const m = mission(
      [
        feature("t1"),
        feature("t2"),
        feature("r1", { mode: "review", checked: ALL_PASS }),
        feature("r2", { mode: "review", checked: ALL_PASS }),
        feature("o1", { mode: "owner", checked: ALL_PASS }),
        feature("u1", { mode: "review", checked: checked(["pass", "cannot_judge", "pass"]) }),
        feature("x1", { mode: "review", checked: checked(["fail", "pass", "pass"]) }),
        feature("n1", { mode: "review" }),
        feature("skipped", { mode: "review", status: "skipped" }),
      ],
      { checkpointLog: [log("feature:o1", "approve"), log("feature:t2", "approve")] },
    );
    expect(checkedLine(m)).toBe(
      "Checked: 1 feature by tests; 1 feature by tests, and approved by you; 1 feature by Mission Control's own checks only (the second AI's check did not finish); " +
        "1 feature by a second AI against your list (1 check not met); 1 feature by a second AI against your list, except 1 check it could not judge; " +
        "2 features by a second AI against your list; 1 feature by a second AI against your list and approved by you.",
    );
  });

  it("reads like the design's example", () => {
    const m = mission([feature("a"), feature("b"), feature("c", { mode: "review", checked: ALL_PASS }), feature("d", { mode: "owner", checked: ALL_PASS })], { checkpointLog: [log("feature:d", "approve")] });
    expect(checkedLine(m)).toBe("Checked: 2 features by tests; 1 feature by a second AI against your list; 1 feature by a second AI against your list and approved by you.");
  });

  it("names a feature queued without a stop for the owner's look, as its own group", () => {
    const m = mission([feature("a", { mode: "owner", checked: ALL_PASS }), feature("b", { mode: "review", checked: ALL_PASS })], { ownerStops: false });
    expect(checkedLine(m)).toBe("Checked: 1 feature by a second AI against your list; 1 feature by a second AI against your list (it was queued without a stop for your look).");
  });
});

describe("ownerSentences", () => {
  const h = (feat: Feature, fields: Partial<CheckedMission> = {}) => ownerSentences(howChecked(mission([feat], fields), feat));

  it("says what the log holds and nothing more", () => {
    const f = feature("a", { mode: "owner", checked: ALL_PASS });
    expect(h(f)).toEqual([]);
    expect(h(f, { checkpointLog: [log("feature:a", "approve")] })).toEqual(["You were asked to look at it, and you approved it."]);
    expect(h(f, { checkpointLog: [log("feature:a", "send_back"), log("feature:a", "approve", 2)] })).toEqual(["You sent it back once, and then approved it."]);
    expect(h(f, { checkpointLog: [log("feature:a", "send_back"), log("feature:a", "send_back", 2), log("feature:a", "approve", 3)] })).toEqual(["You sent it back twice, and then approved it."]);
    expect(h(f, { ownerStops: false })).toEqual(["It was queued without a stop for your look."]);
  });

  it("says when the second AI's check did not finish", () => {
    expect(h(feature("a", { mode: "review" }))).toEqual(["The second AI's check did not finish."]);
    expect(h(feature("a", { mode: "review" }), { ownerStops: false })).toEqual(["The second AI's check did not finish.", "It was queued without a stop for your look."]);
  });

  it("says nothing extra for a feature checked by tests that nobody was asked about", () => {
    expect(h(feature("a"))).toEqual([]);
    expect(h(feature("a"), { checkpointLog: [log("feature:a", "approve")] })).toEqual(["You were asked to look at it, and you approved it."]);
  });
});

describe("asksForLook: the one rule for whether a feature stops (5.2, step 8)", () => {
  const owner = feature("o", { mode: "owner", checked: ALL_PASS });
  const clean = feature("c", { mode: "review", checked: ALL_PASS });
  const unjudged = feature("u", { mode: "review", checked: checked(["pass", "cannot_judge", "pass"]) });
  const unfinished = feature("n", { mode: "review" });
  const unmet = feature("m", { mode: "review", checked: checked(["fail", "pass", "pass"]) });
  const tests = feature("t");
  const all = [owner, clean, unjudged, unfinished, unmet, tests];
  const asks = (m: CheckedMission): string[] => all.filter((f) => asksForLook(m, f)).map((f) => f.id);

  it("(b) an owner feature, a review feature with a check not judged or an unfinished review: yes. Others: no", () => {
    expect(asks(mission(all))).toEqual(["o", "u", "n"]);
  });

  it("(a) --checkpoint feature stops at every feature that is not a derived one", () => {
    const m = mission([...all, feature("gate-c-fix-1"), feature("owner-change-1", { mode: "review" })], { checkpoints: ["feature"] });
    expect(asks(m)).toEqual(["o", "c", "u", "n", "m", "t"]);
    expect(asksForLook(m, feature("gate-c-fix-1"))).toBe(false);
    expect(asksForLook(m, feature("owner-change-1", { mode: "review", checked: checked(["cannot_judge"]) }))).toBe(false);
  });

  it("(a) other kinds of checkpoint do not stop a feature", () => {
    expect(asks(mission(all, { checkpoints: ["plan", "final"] }))).toEqual(["o", "u", "n"]);
    expect(asksForLook(mission([tests], { checkpoints: ["plan", "final"] }), tests)).toBe(false);
  });

  it("the flag removes (b) and nothing else", () => {
    expect(asks(mission(all, { ownerStops: false }))).toEqual([]);
    // with --checkpoint feature as well, every feature still stops
    expect(asks(mission(all, { ownerStops: false, checkpoints: ["feature"] }))).toEqual(["o", "c", "u", "n", "m", "t"]);
  });

  it("(c) a mode feature that was sent back stops again, even when every check is judged now, and even with the flag", () => {
    const sent = { checkpointLog: [log("feature:c", "send_back")] };
    expect(asks(mission(all, sent))).toEqual(["o", "c", "u", "n"]);
    expect(asks(mission(all, { ...sent, ownerStops: false }))).toEqual(["c"]);
    // a send-back of a feature checked by tests is not a mode feature's rule
    expect(asksForLook(mission([tests], { checkpointLog: [log("feature:t", "send_back")] }), tests)).toBe(false);
  });

  it("a derived feature never stops through (b)", () => {
    const derived = feature("gate-c-fix-2", { mode: "review" });
    expect(asksForLook(mission([derived]), derived)).toBe(false);
  });

  describe("(d) the final repair that changed work the owner approved", () => {
    const approved = [log("feature:o", "approve")];
    const repair = (fields: Partial<Feature> = {}) => feature("gate-c-fix-1", { mode: "review", checked: ALL_PASS, ...fields });
    const m = (f: Feature, fields: Partial<CheckedMission> = {}) => mission([owner, f], { checkpointLog: approved, ...fields });

    it("stops when its record names approved work, for a repair checked by reading and for one checked by tests", () => {
      const r = repair({ changesApproved: ["o"] });
      expect(asksForLook(m(r), r)).toBe(true);
      expect(lookReason(m(r), r)).toBe("repair");
      const tests = feature("gate-c-fix-1", { changesApproved: ["o"] });
      expect(asksForLook(m(tests), tests)).toBe(true);
      expect(lookReason(m(tests), tests)).toBe("repair");
    });

    it("does not stop when the repair changed none of it, when nothing was approved, or when the record names work that was not approved", () => {
      const untouched = repair();
      expect(asksForLook(m(untouched), untouched)).toBe(false);
      const named = repair({ changesApproved: ["o"] });
      expect(asksForLook(mission([owner, named]), named)).toBe(false); // no approval in the log
      expect(asksForLook(mission([owner, named], { checkpointLog: [log("feature:o", "send_back")] }), named)).toBe(false);
      const other = repair({ changesApproved: ["c"] });
      expect(asksForLook(mission([owner, clean, other], { checkpointLog: approved }), other)).toBe(false); // "c" was not approved
    });

    it("is not removed by the flag, and not an old-way mission's concern (a feature checked by tests that the owner approved)", () => {
      const r = repair({ changesApproved: ["o"] });
      expect(asksForLook(m(r, { ownerStops: false }), r)).toBe(true);
      const a = feature("a");
      const fix = feature("gate-c-fix-1", { changesApproved: ["a"] });
      expect(asksForLook(mission([a, fix], { checkpointLog: [log("feature:a", "approve")] }), fix)).toBe(false);
    });

    it("is only the repair of the final review: a change the owner asked for at the final stop is not asked about", () => {
      const change = feature("owner-change-1", { mode: "review", checked: ALL_PASS, changesApproved: ["o"] });
      expect(asksForLook(m(change), change)).toBe(false);
    });

    it("keeps stopping after a send-back, with or without a mode, and after the owner approved the repair itself", () => {
      const r = repair({ changesApproved: ["o"] });
      const sentBack = { checkpointLog: [...approved, log("feature:gate-c-fix-1", "send_back")] };
      expect(lookReason(m(r, sentBack), r)).toBe("sent_back");
      const tests = feature("gate-c-fix-1", { changesApproved: ["o"] });
      expect(lookReason(m(tests, sentBack), tests)).toBe("sent_back");
      const both = { checkpointLog: [...approved, log("feature:gate-c-fix-1", "approve")] };
      expect(asksForLook(m(r, both), r)).toBe(true); // the gate then finds it passed, as for any other stop
    });

    it("a second repair is asked about too when it changed a first repair that the owner approved", () => {
      const first = repair();
      const second = feature("gate-c-fix-2", { mode: "review", checked: ALL_PASS, changesApproved: ["gate-c-fix-1"] });
      expect(asksForLook(mission([owner, first, second], { checkpointLog: [...approved, log("feature:gate-c-fix-1", "approve")] }), second)).toBe(true);
    });
  });
});

describe("lookReason: why the team stops, when it is not the --checkpoint feature stop", () => {
  const reason = (f: Feature, fields: Partial<CheckedMission> = {}) => lookReason(mission([f], fields), f);

  it("names the four reasons", () => {
    expect(reason(feature("a", { mode: "owner", checked: ALL_PASS }))).toBe("owner");
    expect(reason(feature("a", { mode: "review", checked: checked(["pass", "cannot_judge", "pass"]) }))).toBe("not_judged");
    expect(reason(feature("a", { mode: "review" }))).toBe("unfinished");
    expect(reason(feature("a", { mode: "review", checked: ALL_PASS }), { checkpointLog: [log("feature:a", "send_back")] })).toBe("sent_back");
  });

  it("is undefined for a stop that only --checkpoint feature asked for, and for a feature that does not stop", () => {
    expect(reason(feature("a"), { checkpoints: ["feature"] })).toBeUndefined();
    expect(reason(feature("a", { mode: "review", checked: ALL_PASS }), { checkpoints: ["feature"] })).toBeUndefined();
    expect(reason(feature("a", { mode: "owner", checked: ALL_PASS }), { ownerStops: false })).toBeUndefined();
  });

  it("puts sent_back first, then owner, then unfinished, then not_judged", () => {
    const sent = { checkpointLog: [log("feature:a", "send_back")] };
    expect(reason(feature("a", { mode: "owner", checked: ALL_PASS }), sent)).toBe("sent_back");
    expect(reason(feature("a", { mode: "owner" }))).toBe("owner");
    expect(reason(feature("a", { mode: "review", checked: checked([], { unfinished: true, unjudged: 3 }) }))).toBe("unfinished");
    // a send-back stands with the flag, the others do not
    expect(reason(feature("a", { mode: "owner", checked: ALL_PASS }), { ...sent, ownerStops: false })).toBe("sent_back");
  });
});

describe("a page whose second AI was shown no picture", () => {
  const noPicture = (extra: Partial<FeatureChecked> = {}) => checked(["pass", "pass", "pass"], { pictures: { taken: 0, why: "no_browser" }, ...extra });
  const review = (fields: Partial<Feature> = {}) => feature("p", { mode: "review", checked: noPicture(), ...fields });

  it("is a reason to stop for a feature checked by a second AI, behind the others, and the flag removes it like the others", () => {
    const f = review();
    expect(asksForLook(mission([f]), f)).toBe(true);
    expect(lookReason(mission([f]), f)).toBe("no_pictures");
    expect(asksForLook(mission([f], { ownerStops: false }), f)).toBe(false);
    // the pictures were taken and given: nothing to ask
    const seen = review({ checked: checked(["pass", "pass", "pass"], { pictures: { taken: 2 } }) });
    expect(asksForLook(mission([seen]), seen)).toBe(false);
    // behind an owner feature, a review that did not finish, and checks not judged
    expect(lookReason(mission([review({ mode: "owner" })]), review({ mode: "owner" }))).toBe("owner");
    const notJudged = review({ checked: checked(["pass", "cannot_judge", "pass"], { pictures: { taken: 0, why: "no_browser" } }) });
    expect(lookReason(mission([notJudged]), notJudged)).toBe("not_judged");
    const unfinished = review({ checked: checked([], { unfinished: true, unjudged: 3, pictures: { taken: 0, why: "no_browser" } }) });
    expect(lookReason(mission([unfinished]), unfinished)).toBe("unfinished");
    // a feature checked by tests has none of this, and a repair is not asked through it
    expect(asksForLook(mission([feature("t", { checked: noPicture() })]), feature("t", { checked: noPicture() }))).toBe(false);
    const repair = feature("gate-c-fix-1", { mode: "review", checked: noPicture() });
    expect(asksForLook(mission([repair]), repair)).toBe(false);
  });

  it("is said where the owner is not asked, and only there", () => {
    const f = review();
    const queued = howChecked(mission([f], { ownerStops: false }), f);
    expect(queued).toMatchObject({ row: 7, noPicture: true, queuedWithoutLook: true });
    expect(checkedWords(queued)).toBe("by a second AI against your list (it was queued without a stop for your look; no picture was shown to the second AI)");
    expect(tableWords(queued)).toBe("Built; a second AI checked it against your list (3 of 3 passed); it was queued without a stop for your look; no picture was shown to the second AI");
    expect(ownerSentences(queued)).toEqual(["It was queued without a stop for your look.", "No picture was shown to the second AI."]);
    // the owner was asked and approved: the words are the approval's, as before
    const approved = howChecked(mission([f], { checkpointLog: [log("feature:p", "approve")] }), f);
    expect(approved).toMatchObject({ noPicture: true, queuedWithoutLook: false });
    expect(checkedWords(approved)).toBe("by a second AI against your list and approved by you");
    expect(ownerSentences(approved)).toEqual(["You were asked to look at it, and you approved it."]);
    // a stop that is still to come says nothing of being queued without one
    expect(howChecked(mission([f]), f).queuedWithoutLook).toBe(false);
  });

  it("is told for the rows with checks left unmet or not judged too, and never for a review that did not finish or a feature checked by tests", () => {
    const unmet = review({ checked: checked(["fail", "pass", "pass"], { pictures: { taken: 0, why: "no_browser" } }) });
    expect(checkedWords(howChecked(mission([unmet], { ownerStops: false }), unmet))).toBe("by a second AI against your list (1 check not met) (it was queued without a stop for your look; no picture was shown to the second AI)");
    const unfinished = review({ checked: checked([], { unfinished: true, unjudged: 3, pictures: { taken: 0, why: "no_browser" } }) });
    expect(howChecked(mission([unfinished], { ownerStops: false }), unfinished)).toMatchObject({ row: 4, noPicture: false });
    const tests = feature("t", { checked: noPicture() });
    expect(howChecked(mission([tests], { ownerStops: false }), tests).noPicture).toBe(false);
  });
});

describe("the sentences about why the owner is asked", () => {
  it("the look's line 8", () => {
    expect(askedBecause("owner", 0)).toBe("You are asked because the plan marks this feature for your look.");
    expect(askedBecause("not_judged", 2)).toBe("You are asked because the second AI could not judge 2 of the checks.");
    expect(askedBecause("unfinished", 3)).toBe("You are asked because the second AI's check did not finish.");
    expect(askedBecause("sent_back", 0)).toBe("You are asked again because you sent it back.");
    expect(askedBecause("repair", 0, ["Setup guide", "Landing page"])).toBe("You are asked because this repair changes work you approved earlier: “Setup guide”, “Landing page”.");
    expect(askedBecause("repair", 0)).toBe("You are asked because this repair changes work you approved earlier.");
    expect(askedBecause("no_pictures", 0)).toBe("You are asked because the second AI was shown no picture of the page.");
  });

  it("the clause after The team stopped because", () => {
    expect(stoppedBecause("owner", "Setup guide")).toBe("the plan marks “Setup guide” for your look");
    expect(stoppedBecause("not_judged", "Setup guide")).toBe("the second AI could not judge every check of “Setup guide”");
    expect(stoppedBecause("unfinished", "Setup guide")).toBe("the second AI's check of “Setup guide” did not finish");
    expect(stoppedBecause("sent_back", "Setup guide")).toBe("you sent “Setup guide” back and it is shown again");
    expect(stoppedBecause("repair", "Fix problems found in the final review")).toBe("the repair “Fix problems found in the final review” changes work you approved earlier");
    expect(stoppedBecause("no_pictures", "Landing page")).toBe("the second AI was shown no picture of “Landing page”");
  });

  it("has no word of tests, and never says the owner looked", () => {
    for (const reason of ["owner", "not_judged", "unfinished", "sent_back", "repair", "no_pictures"] as const) {
      for (const text of [askedBecause(reason, 2), stoppedBecause(reason, "T")]) expect(text).not.toMatch(/\btest|looked at|you looked/i);
    }
  });
});

describe("pictureReason", () => {
  it("gives a plain reason for each code, and for a feature with no page", () => {
    expect(pictureReason("no_tool")).toBe("the picture tool is not available");
    expect(pictureReason("no_browser")).toBe("no browser was found in the container");
    expect(pictureReason("start_failed")).toBe("the browser could not start");
    expect(pictureReason("too_slow")).toBe("the page took too long to load");
    expect(pictureReason("reviewer")).toBe("the second AI could not look at the pictures, because it runs on a different tool");
    expect(pictureReason("not_plain_file")).toBe("a page is not a plain file inside the project");
    expect(pictureReason(undefined)).toBe("this feature has no page");
  });
});
