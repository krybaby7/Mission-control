// T-MODES-SNAP: the dashboard reads, builds and words a mission that has features checked by a second AI (docs/modes-spec.md, 11):
// what read.ts keeps, the three synthetic fixtures end to end, the owner stop's card, the timeline rows, and the rule of 10.3 that no
// sentence about such a feature claims a test. Missions with no such feature are pinned by test/dashboard-compat.test.ts.
import { describe, expect, it } from "vitest";
import { buildHome, featureWith, fixtureSnapshot, HOUR, iso, MID, MINUTE, missionAt, snap } from "../../test/dashboard-kit.js";
import { makeEvent } from "../../test/dashboard-helpers.js";
import { fakeFacts } from "../../test/dashboard-facts-helpers.js";
import type { CheckResult, CheckpointRecord, Feature, FeatureChecked, Mission, MissionEvent, PendingCheckpoint } from "../types.js";
import { clearReadCache, readDetails, readHome } from "./read.js";
import { buildTimeline } from "./timeline.js";
import type { NeedsYouCard, Snapshot } from "./types.js";
import { makeFormatter } from "./vocabulary.js";

const ID = "2026-10-11-landing-page";
/** Two characters that hide or reverse text, made from their code points so this file holds none. */
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);

function checkedOf(results: CheckResult[], o: { unfinished?: boolean } = {}): FeatureChecked {
  return {
    round: 1,
    reviewer: "claude",
    results: results.map((result, i) => ({ n: i + 1, result, evidence: "SECRET-EVIDENCE", basis: "text" as const })),
    unjudged: results.filter((r) => r === "cannot_judge").length,
    ...(o.unfinished === true && { unfinished: true as const }),
    scripted: { problems: ["SECRET-PROBLEM"], facts: ["SECRET-FACT"] },
    pictures: { taken: 2, why: "no_browser" },
  };
}

function reading(id: string, status: Feature["status"], results: CheckResult[], o: Partial<Feature> = {}): Feature {
  return featureWith(id, status, { title: `Title of ${id}`, mode: "review", checked: checkedOf(results), acceptance: ["SECRET-CHECK-TEXT"], ...o });
}

function pending(featureId: string, over: Partial<PendingCheckpoint> = {}): PendingCheckpoint {
  return {
    id: `feature:${featureId}#1`,
    scope: `feature:${featureId}`,
    kind: "feature",
    featureId,
    round: 1,
    state: "pending",
    parkedAt: iso(MID - 5000),
    notifiedAt: iso(MID - 4000),
    look: { headline: "Check", lines: ["The feature is built."], branch: `mc/${ID}--${featureId}` },
    ...over,
  };
}

/** A mission stopped at the owner's look at one feature. */
function stoppedAt(f: Feature, o: Partial<Mission> = {}, cp: Partial<PendingCheckpoint> = {}): Mission {
  return missionAt(MID, ID, { title: "Landing page", status: "stopped", stage: "features", features: [f, featureWith("other", "pending")], checkpoint: pending(f.id, cp), ...o });
}

const answered = (featureId: string, decision: "approve" | "send_back", round = 1): CheckpointRecord => ({
  id: `feature:${featureId}#${round}`,
  scope: `feature:${featureId}`,
  kind: "feature",
  featureId,
  round,
  decision,
  at: iso(MID - HOUR),
});

function snapOf(missions: { mission: Mission; events?: MissionEvent[]; dispatch?: unknown }[], o: { now?: number; live?: boolean } = {}): Snapshot {
  const now = o.now ?? MID;
  return snap(buildHome({ missions, lock: o.live ? { at: iso(now - 10 * MINUTE) } : undefined }, now), now);
}

const checkCard = (s: Snapshot): NeedsYouCard | undefined => s.needsYou.find((c) => c.kind === "checkpoint");

describe("T-MODES-SNAP-1: what read.ts keeps of a feature checked by a second AI", () => {
  function read(missions: { mission: Mission; events?: MissionEvent[] }[]) {
    const home = buildHome({ missions }, MID);
    clearReadCache();
    const data = readHome(home);
    readDetails(home, data, data.missions.map((m) => m.folder));
    return data.missions[0];
  }

  it("passes the mode, the effort and the mission's ownerStops through, and leaves the plan's own checks out", () => {
    const f = reading("a", "done", ["pass"], { mode: "owner", effort: "deep", expect: { headings: ["SECRET-HEADING"], mentions: ["SECRET-MENTION"], words: [1, 5], columns: ["SECRET-COLUMN"], rows: [0, 9] } });
    const entry = read([{ mission: missionAt(MID, ID, { features: [f], ownerStops: false }) }])?.mission;
    const kept = entry?.features[0];
    expect(kept).toMatchObject({ id: "a", mode: "owner", effort: "deep" });
    expect(entry?.ownerStops).toBe(false);
    expect("expect" in (kept ?? {})).toBe(false);
    expect(JSON.stringify(entry)).not.toMatch(/SECRET/);
  });

  it("from checked it keeps how many checks were not judged, whether the review did not finish, and the code of each result, and nothing else", () => {
    const f = reading("a", "done", ["pass", "fail", "cannot_judge"]);
    const kept = read([{ mission: missionAt(MID, ID, { features: [f] }) }])?.mission?.features[0]?.checked;
    expect(kept).toEqual({
      round: 0,
      reviewer: "claude",
      results: [
        { n: 1, result: "pass", evidence: "", basis: "text" },
        { n: 2, result: "fail", evidence: "", basis: "text" },
        { n: 3, result: "cannot_judge", evidence: "", basis: "text" },
      ],
      unjudged: 1,
      scripted: { problems: [], facts: [] },
      // only the code of why the second AI was shown no picture (it decides whether the owner is asked); the number taken is not read
      pictures: { taken: 0, why: "no_browser" },
    });
    const unfinished = read([{ mission: missionAt(MID, ID, { features: [reading("a", "done", [], { checked: checkedOf([], { unfinished: true }) })] }) }])?.mission?.features[0]?.checked;
    expect(unfinished).toMatchObject({ unfinished: true, unjudged: 0, results: [] });
  });

  it("keeps no text of a check, except a fixed mark for a taste check, which the words call left for you (R2-5)", () => {
    const f = reading("a", "done", ["pass", "pass", "cannot_judge"], { mode: "owner", acceptance: ["SECRET-ONE", "SECRET-TWO (the CEO decides) and more", "A matter of taste (The CEO decides)."] });
    const kept = read([{ mission: missionAt(MID, ID, { features: [f], checkpointLog: [answered("a", "approve")] }) }])?.mission?.features[0];
    expect(kept?.acceptance).toEqual(["", "", "(the CEO decides)"]);
    expect(JSON.stringify(kept)).not.toMatch(/SECRET|matter of taste/);
    // the same, end to end: the line under the finished feature on the Results page
    const s = snapOf([{ mission: missionAt(MID, ID, { status: "done", stage: "complete", features: [f], checkpointLog: [answered("a", "approve")] }) }]);
    const got = s.debrief?.missions[0]?.got.map((g) => g.checkedBy);
    expect(got).toEqual(["Checked by a second AI against your list; 1 check left for you; approved by you"]);
  });

  it("a mission with no mode, no effort, no checked and no ownerStops has none of the keys", () => {
    const entry = read([{ mission: missionAt(MID, ID, { features: [featureWith("a", "done")] }) }])?.mission;
    expect("ownerStops" in (entry ?? {})).toBe(false);
    for (const key of ["mode", "effort", "checked", "expect"]) expect(key in (entry?.features[0] ?? {}), key).toBe(false);
  });

  it("drops what is not a mode, an effort, an ownerStops or a checked record, and cleans damaged numbers", () => {
    const odd = (over: Record<string, unknown>) => read([{ mission: missionAt(MID, ID, { features: [featureWith("a", "done", over as Partial<Feature>)] }) }])?.mission?.features[0];
    // A mode or an effort that is not one of the known words makes the whole file unreadable, as it does for the engine: the page must not
    // show such a feature as one checked by tests (docs/modes-spec.md, M4, and the review of Wave 2). It is counted with the unreadable missions.
    for (const over of [{ mode: "banana", effort: "huge" }, { mode: "tests" }, { mode: "review", effort: "standard" }, { mode: ["owner"], effort: 7 }, { mode: null }]) {
      expect(read([{ mission: missionAt(MID, ID, { features: [featureWith("a", "done", over as Partial<Feature>)] }) }])?.mission, JSON.stringify(over)).toBeNull();
    }
    expect(odd({ checked: "yes" })).not.toHaveProperty("checked");
    expect(odd({ checked: [1] })).not.toHaveProperty("checked");
    expect(odd({ checked: { unjudged: -3 } })?.checked?.unjudged).toBe(0);
    expect(odd({ checked: { unjudged: "7" } })?.checked?.unjudged).toBe(0);
    expect(odd({ checked: { unjudged: 2.9 } })?.checked?.unjudged).toBe(2);
    expect(odd({ checked: { unjudged: 1e9 } })?.checked?.unjudged).toBeLessThanOrEqual(200);
    expect(odd({ checked: { unfinished: "true" } })?.checked).not.toHaveProperty("unfinished");
    expect(odd({ checked: { results: [{ result: "pass" }, { result: "maybe" }, 5, null, { result: "fail", evidence: "SECRET" }] } })?.checked?.results.map((r) => r.result)).toEqual(["pass", "fail"]);
    expect(odd({ checked: { results: "all" } })?.checked?.results).toEqual([]);
    const m = read([{ mission: missionAt(MID, ID, { features: [featureWith("a", "done")], ownerStops: true as never }) }])?.mission;
    expect("ownerStops" in (m ?? {})).toBe(false);
  });

  it("caps the list of results, so a damaged file cannot grow the snapshot", () => {
    const many = Array.from({ length: 5000 }, () => ({ result: "fail" }));
    expect(read([{ mission: missionAt(MID, ID, { features: [featureWith("a", "done", { checked: { results: many } as never })] }) }])?.mission?.features[0]?.checked?.results).toHaveLength(200);
  });

  it("reads the numbers and the two short codes of the three new events, and nothing else of them", () => {
    const events = [
      makeEvent(ID, MID - 6000, "deliverable.checked", { feature: "a", label: "a1", ok: false, problems: 2, projectChecks: "failed", file: "docs/SECRET.md", problem: "SECRET-PROBLEM" }),
      makeEvent(ID, MID - 5000, "pictures.taken", { feature: "a", taken: 0, why: "no_browser", page: "SECRET.html" }),
      makeEvent(ID, MID - 4000, "rubric.checked", { feature: "a", round: 2, pass: 3, fail: 1, unjudged: 0, downgraded: 1, reviewer: "claude", words: "SECRET-WORDS" }),
    ];
    const read2 = read([{ mission: missionAt(MID, ID, { features: [featureWith("a", "reviewing")] }), events }])?.events ?? [];
    expect(read2.map((e) => e.data)).toEqual([
      { feature: "a", label: "a1", ok: false, problems: 2, projectChecks: "failed" },
      { feature: "a", taken: 0, why: "no_browser" },
      { feature: "a", round: 2, pass: 3, fail: 1, unjudged: 0, downgraded: 1 },
    ]);
  });

  it("drops a code that is not one of the known short codes, and a count that is not a whole number of 0 or more", () => {
    const events = [
      makeEvent(ID, MID - 3000, "pictures.taken", { feature: "a", taken: -1, why: "<script>alert(1)</script>" }),
      makeEvent(ID, MID - 2000, "deliverable.checked", { feature: "a", ok: true, problems: "many", projectChecks: "maybe" }),
      makeEvent(ID, MID - 1000, "rubric.checked", { feature: "a", pass: 2.7, fail: 1e12, unjudged: Number.NaN }),
    ];
    const data = read([{ mission: missionAt(MID, ID, { features: [featureWith("a", "reviewing")] }), events }])?.events?.map((e) => e.data);
    expect(data).toEqual([{ feature: "a" }, { feature: "a", ok: true }, { feature: "a", pass: 2, fail: 100000 }]);
  });

  it("keeps the numbers of an event of another type out: only the three new types carry them", () => {
    const events = [makeEvent(ID, MID - 1000, "merge", { feature: "a", pass: 3, why: "no_browser", taken: 4 })];
    const data = read([{ mission: missionAt(MID, ID, { features: [featureWith("a", "reviewing")] }), events }])?.events?.[0]?.data;
    expect(data).toEqual({ feature: "a" });
  });
});

describe("T-MODES-SNAP-2: the three synthetic fixtures, end to end", () => {
  it("modes-review-round: a second AI is reading, the ladder has four steps, the timeline tells the second AI's answer", () => {
    const s = fixtureSnapshot("modes-review-round");
    expect(s.lamp.state).toBe("on_track");
    expect(s.now?.text).toBe("A second AI is reviewing “Setup guide for new users”");
    const [m] = s.missions;
    expect(m).toMatchObject({ state: "working", sentence: "Building feature 1 of 1." });
    expect(m?.features[0]).toMatchObject({ state: "being_reviewed", word: "Being reviewed", steps: { total: 4, used: 2, caption: "Tried 2 times (2 build tries, 1 fix after review)" } });
    expect(s.timeline.items.map((i) => [i.tone, i.text])).toEqual([
      ["info", "Started working on “Habit tracker”."],
      ["info", "The plan is ready: 1 feature."],
      ["warn", "“Setup guide for new users” did not pass its checks (step 1 of 4). Calling in reinforcements."],
      ["warn", "A second AI checked “Setup guide for new users” against your list: 3 of 4 checks passed. 1 needs a fix."],
    ]);
    expect(s.debrief).toBeNull();
    expect(JSON.stringify(s)).not.toMatch(/SECRET|never says what the reader|numbered 1 to 5/);
  });

  it("modes-owner-stop: one card that says why the team stopped, where the answers are, and what the second AI could not judge", () => {
    const s = fixtureSnapshot("modes-owner-stop");
    const card = checkCard(s);
    expect(card).toMatchObject({
      kind: "checkpoint",
      severity: "look",
      featureId: "landing-page",
      title: "“Landing page”: please check “One-page landing page” before it is added",
      happened: { text: "The team stopped here because this feature is marked for your look, and you look at it first.", author: "engine" },
      summary: "The second AI's answer on each check is in the report, and so are the pictures when there are any. The work is saved under the name mc/2026-10-11-landing-page--landing-page.",
    });
    expect(card?.lines?.length).toBe(6);
    expect(card?.lines?.every((l) => l.author === "ai")).toBe(true);
    expect(card?.answers?.approve).toBe('About the check of "Landing page" (the feature "One-page landing page"): approved, go ahead.');
    expect(s.lamp.state).toBe("needs_look");
    expect(s.lamp.reasons.map((r) => r.code)).toContain("checkpoint_waiting");
    const [m] = s.missions;
    expect(m).toMatchObject({ state: "paused", pausedWhy: "checkpoint" });
    expect(m?.features.map((f) => [f.title, f.state])).toEqual([["One-page landing page", "paused"], ["Contact page", "waiting_turn"]]);
    expect(s.timeline.items.map((i) => i.text)).toContain("A second AI checked “One-page landing page” against your list: 3 of 4 checks passed. 1 could not be judged.");
    expect(s.debrief).toBeNull();
  });

  it("modes-mixed-done: the Results page says how each feature was checked and what the log holds", () => {
    const s = fixtureSnapshot("modes-mixed-done");
    expect(s.lamp.state).toBe("on_track");
    expect(s.missions[0]).toMatchObject({ state: "done", sentence: "All 3 features are built." });
    const d = s.debrief;
    expect(d?.verdict).toEqual({ id: "done", word: "Done", sentence: "All 3 features are built. The list below says how each was checked." });
    const [only] = d?.missions ?? [];
    expect(only?.got.map((g) => [g.title, g.checkedBy])).toEqual([
      ["Totals for each region", "Checked by tests"],
      ["Description of each column", "Checked by a second AI against your list"],
      ["Sales sheet for the board", "Checked by a second AI against your list; 1 check was not judged; approved by you"],
    ]);
    expect(only?.ticks.map((t) => [t.id, t.state])).toEqual([["delivered", "yes"], ["final_review", "yes"], ["nothing_open", "yes"], ["no_rework", "yes"]]);
    expect(only?.ticks[0]?.why).toBe(
      "All 3 features were built. How they were checked: 1 by tests, 1 by a second AI against your list (1 check not judged) and approved by you, 1 by a second AI against your list.",
    );
    expect(only?.ticks[1]?.caveat).toBe("2 features have no tests. The list below says how each was checked.");
    expect(d?.honestyNote).toBe("These are the AI team's own checks. You were asked to look at “Sales sheet for the board” and approved it.");
  });

  it("modes-mixed-done: the timeline words a feature checked by a second AI as added, and keeps the old words for the one checked by tests", () => {
    const texts = fixtureSnapshot("modes-mixed-done").timeline.items.map((i) => i.text);
    expect(texts).toContain("“Totals for each region” is built and checked.");
    expect(texts).toContain("“Description of each column” is added.");
    expect(texts).toContain("“Sales sheet for the board” is added.");
    // a tests feature is finished, so the final check is told as before
    expect(texts).toContain("The final tests of the whole app passed.");
  });

  it("none of the three leaks a check, the evidence, a path or a model name into the snapshot", () => {
    for (const name of ["modes-review-round", "modes-owner-stop", "modes-mixed-done"]) {
      const json = JSON.stringify(fixtureSnapshot(name));
      expect(json, name).not.toMatch(/Quote from|\/fixture|\/home\/|\/tmp\/|model-x|claude-|landing\.html|docs\/|tests\/|"evidence"|"acceptance"/);
    }
  });
});

describe("T-MODES-SNAP-3: the owner stop's card (spec 11.3)", () => {
  const cardOf = (m: Mission): NeedsYouCard | undefined => checkCard(snapOf([{ mission: m }]));
  const WHY = {
    owner: "The team stopped here because this feature is marked for your look, and you look at it first.",
    notJudged: "The team stopped here because the second AI could not judge every check of this feature, so you look at it first.",
    unfinished: "The team stopped here because the second AI's check of this feature did not finish, so you look at it first.",
    again: "The team stopped here again because you sent this feature back, so you look at the changed work.",
    asked: "The team stopped here because you asked to look at it first.",
  };
  const SUMMARY = "The second AI's answer on each check is in the report, and so are the pictures when there are any.";

  it("an owner feature", () => {
    const c = cardOf(stoppedAt(reading("a", "reviewing", ["pass", "pass"], { mode: "owner" })));
    expect(c?.happened).toEqual({ text: WHY.owner, author: "engine" });
    expect(c?.summary).toBe(`${SUMMARY} The work is saved under the name mc/${ID}--a.`);
  });

  it("a review feature with a check nobody could judge", () => {
    expect(cardOf(stoppedAt(reading("a", "reviewing", ["pass", "cannot_judge"])))?.happened.text).toBe(WHY.notJudged);
  });

  it("a review feature whose check did not finish, or has no record of the second AI's answer", () => {
    expect(cardOf(stoppedAt(reading("a", "reviewing", [], { checked: checkedOf([], { unfinished: true }) })))?.happened.text).toBe(WHY.unfinished);
    expect(cardOf(stoppedAt(featureWith("a", "reviewing", { mode: "review" })))?.happened.text).toBe(WHY.unfinished);
  });

  it("a review feature the owner sent back, shown again even though every check is judged now", () => {
    const m = stoppedAt(reading("a", "reviewing", ["pass", "pass"]), { checkpointLog: [answered("a", "send_back")] }, { id: "feature:a#2", round: 2 });
    const c = cardOf(m);
    expect(c?.happened.text).toBe(WHY.again);
    expect(c?.summary?.startsWith(SUMMARY)).toBe(true);
  });

  it("the send-back warning follows the summary once the cap is reached", () => {
    const log = [answered("a", "send_back", 1), answered("a", "send_back", 2)];
    const c = cardOf(stoppedAt(reading("a", "reviewing", ["pass"], { mode: "owner" }), { checkpointLog: log }, { id: "feature:a#3", round: 3 }));
    expect(c?.summary).toBe(
      `${SUMMARY} The work is saved under the name mc/${ID}--a. You have sent this back 2 times. If you send it back again, the work stops here: this feature is set aside and the rest carries on. You can still approve.`,
    );
  });

  it("a stop that the owner asked for with --checkpoint feature keeps the old words, for a feature with a mode too", () => {
    for (const f of [reading("a", "reviewing", ["pass", "cannot_judge"], { mode: "owner" }), reading("a", "reviewing", ["pass"])]) {
      const c = cardOf(stoppedAt(f, { checkpoints: ["feature"] }));
      expect(c?.happened.text).toBe(WHY.asked);
      expect(c?.summary).toBe(`The work is saved under the name mc/${ID}--a. The report says how to open it.`);
    }
  });

  it("a feature checked by tests keeps the old words", () => {
    const c = cardOf(stoppedAt(featureWith("a", "reviewing", { frozenTests: [{ path: "", sha256: "" }] })));
    expect(c?.happened.text).toBe(WHY.asked);
  });

  it("the other fields of the card do not change", () => {
    const own = cardOf(stoppedAt(reading("a", "reviewing", ["pass"], { mode: "owner" })));
    const old = cardOf(stoppedAt(featureWith("a", "reviewing", { title: "Title of a" })));
    expect({ ...own, happened: old?.happened, summary: old?.summary }).toEqual(old);
  });
});

describe("T-MODES-SNAP-4: the timeline rows of the three new events (spec 11.2)", () => {
  const f = makeFormatter("UTC");
  const feature = featureWith("a", "reviewing", { title: "Setup guide", mode: "review" });
  const rows = (events: MissionEvent[], m: Mission = missionAt(MID, ID, { title: "Docs", features: [feature] })) => buildTimeline([fakeFacts(m, { events })], MID, f).items;
  const ev = (type: string, data: Record<string, unknown>, back = 1000) => makeEvent(ID, MID - back, type, data);

  it("the second AI's answer: every check passed is good, anything else is a warning, with the counts that apply", () => {
    expect(rows([ev("rubric.checked", { feature: "a", pass: 4, fail: 0, unjudged: 0 })]).map((i) => [i.tone, i.text])).toEqual([
      ["good", "A second AI checked “Setup guide” against your list: 4 of 4 checks passed."],
    ]);
    expect(rows([ev("rubric.checked", { feature: "a", pass: 2, fail: 1, unjudged: 1 })]).map((i) => [i.tone, i.text])).toEqual([
      ["warn", "A second AI checked “Setup guide” against your list: 2 of 4 checks passed. 1 needs a fix. 1 could not be judged."],
    ]);
    expect(rows([ev("rubric.checked", { feature: "a", pass: 1, fail: 2, unjudged: 0 })])[0]?.text).toBe("A second AI checked “Setup guide” against your list: 1 of 3 checks passed. 2 need a fix.");
    expect(rows([ev("rubric.checked", { feature: "a", pass: 1, fail: 0, unjudged: 0 })])[0]?.text).toBe("A second AI checked “Setup guide” against your list: 1 of 1 check passed.");
  });

  it("an answer with no count, or for no feature, says nothing", () => {
    expect(rows([ev("rubric.checked", { feature: "a" })])).toEqual([]);
    expect(rows([ev("rubric.checked", { pass: 1 })])).toEqual([]);
  });

  it("Mission Control's own checks are told only when they found problems, as a detail that the next milestone replaces", () => {
    expect(rows([ev("deliverable.checked", { feature: "a", label: "a1", ok: false, problems: 2 })]).map((i) => [i.tone, i.text])).toEqual([
      ["info", "Mission Control's own checks of “Setup guide” found problems. The AI is asked to fix them."],
    ]);
    expect(rows([ev("deliverable.checked", { feature: "a", label: "a1", ok: true, problems: 0 })])).toEqual([]);
    expect(rows([ev("deliverable.checked", { feature: "a", label: "a1", ok: false }, 2000), ev("rubric.checked", { feature: "a", pass: 1, fail: 0, unjudged: 0 }, 1000)])).toHaveLength(1);
  });

  it("the pictures: taken at both widths, or none could be taken when pages were expected, and nothing for a feature with no page", () => {
    expect(rows([ev("pictures.taken", { feature: "a", taken: 2 })]).map((i) => [i.tone, i.text])).toEqual([["info", "Pictures of “Setup guide” were taken at phone width and desktop width."]]);
    expect(rows([ev("pictures.taken", { feature: "a", taken: 0, why: "no_browser" })]).map((i) => [i.tone, i.text])).toEqual([["warn", "No pictures of “Setup guide” could be taken."]]);
    expect(rows([ev("pictures.taken", { feature: "a", taken: 0 })])).toEqual([]);
    expect(rows([ev("pictures.taken", { taken: 2 })])).toEqual([]);
  });

  it("a feature with an id the file does not have is named as a feature, not by an invented title", () => {
    expect(rows([ev("rubric.checked", { feature: "ghost", pass: 1, fail: 0, unjudged: 0 })])[0]?.text).toBe("A second AI checked “a feature” against your list: 1 of 1 check passed.");
  });

  it("a merged feature checked by a second AI is added; one checked by tests keeps the old sentence", () => {
    const m = missionAt(MID, ID, { title: "Docs", features: [feature, featureWith("t", "done", { title: "Totals" })] });
    expect(rows([ev("merge", { feature: "a" }), ev("merge", { feature: "t" })], m).map((i) => i.text)).toEqual(["“Setup guide” is added.", "“Totals” is built and checked."]);
  });

  it("the final steps are told as checks when no finished feature is checked by tests, and as tests in a mixed mission", () => {
    const only = missionAt(MID, ID, { title: "Docs", features: [featureWith("a", "done", { title: "Setup guide", mode: "review" })] });
    const mixed = missionAt(MID, ID, { title: "Docs", features: [featureWith("a", "done", { title: "Setup guide", mode: "review" }), featureWith("t", "done", { title: "Totals" })] });
    const finals = [ev("verify", { label: "gate-c", ok: true }, 3000), ev("verify", { label: "gate-c-features", ok: true }, 2000)];
    expect(rows(finals, only).map((i) => i.text)).toEqual(["The final checks of the whole app passed.", "The project's checks passed on the final result."]);
    expect(rows(finals, mixed).map((i) => i.text)).toEqual(["The final tests of the whole app passed.", "The tests of the new features passed together on the final result."]);
    const red = [ev("verify", { label: "gate-c", ok: false }, 3000), ev("verify", { label: "gate-c-features", ok: false }, 2000)];
    expect(rows(red, only).map((i) => i.text)).toEqual(["The final checks of the whole app failed.", "The project's checks did not all pass together on the final result."]);
    expect(rows(red, mixed).map((i) => i.text)).toEqual(["The final tests of the whole app failed.", "The tests of the new features did not all pass together on the final result."]);
    const base = missionAt(MID, ID, { title: "Docs", baselineBroken: true, features: only.features });
    expect(rows([ev("verify", { label: "gate-c", ok: false })], base).map((i) => i.text)).toEqual(["The project's own full check failed. It was already failing before this work started."]);
  });

  it("an event type the table does not list is still hidden", () => {
    expect(rows([ev("rubric.unknown", { feature: "a", pass: 1 }), ev("deliverable.other", { feature: "a", ok: false })])).toEqual([]);
  });
});

/** Every string value of a value, without the keys. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) stringsOf(v, out);
  return out;
}

/** The rule of spec 10.3: after the allowed phrase "no tests" is taken out, a sentence about a feature without tests holds no test word. */
function claimsATest(text: string, allowByTests = false): boolean {
  const without = text.replace(/\bno tests\b/gi, "");
  return /\btest(s|ed|ing)?\b/i.test(allowByTests ? without.replace(/\bby tests\b/gi, "") : without);
}

describe("T-MODES-SNAP-5: no sentence about a mission of features checked by a second AI claims a test (spec 10.3, M6)", () => {
  const onlyReading = (o: Partial<Mission> = {}, features: Feature[] = [reading("a", "done", ["pass", "pass"]), reading("b", "done", ["pass"], { mode: "owner" })]) =>
    missionAt(MID, ID, { title: "Docs", status: "done", stage: "complete", features, ...o });
  const gateC = (ok: boolean, label = "gate-c"): MissionEvent => makeEvent(ID, MID - 2000, "verify", { label, ok, exitCode: ok ? 0 : 1, timedOut: false });
  const finalVerify = (o: Record<string, unknown> = {}) => ({ finalVerify: { ok: true, reviewed: true, blocking: 0, ...o } });
  const stories: [string, () => Snapshot][] = [
    ["done", () => snapOf([{ mission: onlyReading({ checkpointLog: [answered("b", "approve")] }), events: [gateC(true), gateC(true, "gate-c-features")], dispatch: finalVerify() }])],
    ["done with the owner's look queued without a stop", () => snapOf([{ mission: onlyReading({ ownerStops: false }), dispatch: finalVerify() }])],
    ["partly done, one feature stuck", () => snapOf([{ mission: onlyReading({ status: "partial" }, [reading("a", "done", ["pass"]), reading("b", "blocked", [], { blockedReason: "tried every escalation step, but Mission Control's own checks still failed: x" })]), dispatch: finalVerify() }])],
    ["a feature kept with unmet checks and an unfinished review", () => snapOf([{ mission: onlyReading({ status: "partial", notes: ["The review of “Title of b” did not finish, so it was merged after passing Mission Control's own checks only."] }, [reading("a", "done", ["pass", "fail"]), reading("b", "done", [], { checked: checkedOf([], { unfinished: true }) })]), dispatch: finalVerify() }])],
    ["the final check red", () => snapOf([{ mission: onlyReading({ status: "partial" }), events: [gateC(false)], dispatch: finalVerify({ ok: false }) }])],
    ["the project's own checks already failing", () => snapOf([{ mission: onlyReading({ status: "partial", baselineBroken: true }), events: [gateC(false)], dispatch: finalVerify({ ok: false }) }])],
    ["a repair feature of the final check", () => snapOf([{ mission: onlyReading({}, [reading("a", "done", ["pass"]), reading("gate-c-fix-1", "done", ["pass"])]), dispatch: finalVerify() }])],
    ["running the final steps", () => snapOf([{ mission: onlyReading({ status: "running", stage: "gate_c" }) }], { live: true })],
    ["stopped at the owner's look", () => snapOf([{ mission: stoppedAt(reading("a", "reviewing", ["pass", "cannot_judge"], { mode: "owner" }), { features: [reading("a", "reviewing", ["pass", "cannot_judge"], { mode: "owner" })] }) }])],
    ["stopped, sent back and shown again", () => snapOf([{ mission: stoppedAt(reading("a", "reviewing", ["pass"]), { features: [reading("a", "reviewing", ["pass"])], checkpointLog: [answered("a", "send_back")] }) }])],
  ];

  it.each(stories)("%s", (_name, build) => {
    const s = build();
    const claims = stringsOf(s).filter((t) => claimsATest(t));
    expect(claims).toEqual([]);
  });

  it("the rule itself finds a claim and lets the allowed phrase through", () => {
    expect(claimsATest("All 3 features were tested.")).toBe(true);
    expect(claimsATest("The final tests of the whole app passed.")).toBe(true);
    expect(claimsATest("2 features have no tests. The list below says how each was checked.")).toBe(false);
    expect(claimsATest("Checked by the project's own checks only; no tests were written")).toBe(false);
    expect(claimsATest("Attestation of the contest")).toBe(false);
    expect(claimsATest("1 by tests, 1 by a second AI")).toBe(true);
    expect(claimsATest("1 by tests, 1 by a second AI", true)).toBe(false);
  });

  it("in a mixed mission the sentences that name the feature checked by a second AI still hold no test word", () => {
    const s = fixtureSnapshot("modes-mixed-done");
    const about = stringsOf(s).filter((t) => /second AI|approved by you|is added\.|Title of|Description of each column|Sales sheet for the board/.test(t));
    expect(about.length).toBeGreaterThan(5);
    // in a mixed mission "by tests" may appear in a sentence that also counts the features checked by tests (spec 10.3)
    expect(about.filter((t) => claimsATest(t, true))).toEqual([]);
    expect(about.filter((t) => claimsATest(t))).toEqual(["All 3 features were built. How they were checked: 1 by tests, 1 by a second AI against your list (1 check not judged) and approved by you, 1 by a second AI against your list."]);
  });
});

describe("T-MODES-SNAP-6: hostile and damaged input", () => {
  it("a file that names its own mode, checks and results in odd ways never reaches the snapshot as text, and never breaks it", () => {
    const hostile = reading("a", "done", ["pass", "fail"], {
      title: `Guide ${RLO}reversed ${ZWSP}`,
      mode: "review",
      expect: { headings: ["<img src=x onerror=alert(1)>"], mentions: ["rm -rf ~"], words: [1, 2] },
    });
    const events = [
      makeEvent(ID, MID - 3000, "rubric.checked", { feature: "a", pass: "<b>1</b>", fail: { x: 1 }, unjudged: [2], why: "<script>", reviewer: `codex ${RLO}` }),
      makeEvent(ID, MID - 2000, "pictures.taken", { feature: "a", taken: "2", why: { code: "no_tool" } }),
      makeEvent(ID, MID - 1000, "deliverable.checked", { feature: "a", ok: "no", problems: 1e99, projectChecks: ["failed"] }),
    ];
    const s = snapOf([{ mission: missionAt(MID, ID, { title: "Docs", status: "done", stage: "complete", features: [hostile] }), events, dispatch: { finalVerify: { ok: true, reviewed: true, blocking: 0 } } }]);
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/SECRET|onerror|rm -rf|<script|<b>/);
    expect(json.includes(RLO) || json.includes(ZWSP)).toBe(false);
    expect(s.debrief?.missions[0]?.got[0]?.title).toBe("Guide reversed");
    expect(s.debrief?.missions[0]?.got[0]?.checkedBy).toBe("Checked by a second AI against your list; 1 check was not met");
  });

  it("a mission file with a mode on a feature the file lists twice, or a checkpoint log of the wrong shape, still builds a valid snapshot", () => {
    const twice = [reading("a", "done", ["pass"]), reading("a", "done", ["fail"], { title: "Second" })];
    const s = snapOf([{ mission: missionAt(MID, ID, { status: "done", stage: "complete", features: twice, checkpointLog: [{ scope: 7 } as never, null as never] }), dispatch: { finalVerify: { ok: true, reviewed: true, blocking: 0 } } }]);
    expect(s.debrief?.missions[0]?.got).toHaveLength(2);
  });
});
