// T-DEB: the debrief, shown as Results (docs/dashboard-spec.md, section 11): verdicts, the four ticks in every state, the lists,
// the agent time and the notes. The unit tests build the facts by hand; the last group builds snapshots from fixtures.
import { describe, expect, it } from "vitest";
import { copyHome, makeEvent, makeFeature, makeMission, withLock, writeMission, emptyHome } from "../../test/dashboard-helpers.js";
import { fakeCard, fakeFacts, type FakeFactsOptions, fixtureFacts } from "../../test/dashboard-facts-helpers.js";
import type { Attempt, Feature, Mission } from "../types.js";
import { buildDebrief } from "./debrief.js";
import type { DispatchPicks, UsageRecord } from "./read.js";
import { buildSnapshot } from "./snapshot.js";
import { TICK_IDS, type Debrief, type MissionDebrief, type NeedsYouCard, type Tick } from "./types.js";
import { makeFormatter } from "./vocabulary.js";

const f = makeFormatter("UTC");
const CLOCK = Date.parse("2026-10-11T10:03:30.000Z");

const FV_OK: DispatchPicks = { finalVerify: { ok: true, reviewed: true, blocking: 0 }, inflight: null };
const fv = (o: Partial<NonNullable<DispatchPicks["finalVerify"]>>): DispatchPicks => ({ finalVerify: { ok: true, reviewed: true, blocking: 0, ...o }, inflight: null });

function attempt(action: Attempt["action"], outcome: Attempt["outcome"]): Attempt {
  return { rung: 0, action, provider: "codex", model: "m", effort: "medium", outcome, summary: "", at: "2026-10-11T09:58:30.000Z" };
}

const done = (id: string, title = id, o: Partial<Feature> = {}) => makeFeature({ id, title, status: "done", attempts: [attempt("build", "pass")], ...o });

function finished(o: Partial<Mission> = {}): Mission {
  return makeMission({
    id: "2026-10-11-members",
    title: "Members site",
    status: "done",
    stage: "complete",
    features: [done("a", "Sign-up"), done("b", "Welcome email"), done("c", "Settings"), done("d", "Billing")],
    ...o,
  });
}

interface Run extends FakeFactsOptions {
  cards?: NeedsYouCard[];
  usage?: UsageRecord[] | null;
}

function debriefOf(mission: Mission, o: Run = {}): Debrief | null {
  const { cards, usage, ...facts } = o;
  return buildDebrief([fakeFacts(mission, { dispatch: FV_OK, ...facts })], cards ?? [], usage ?? null, f);
}

function one(mission: Mission, o: Run = {}): MissionDebrief {
  const debrief = debriefOf(mission, o);
  const [first] = debrief?.missions ?? [];
  if (first === undefined) throw new Error("no debrief for the mission");
  return first;
}

function tick(d: MissionDebrief, id: Tick["id"]): Tick {
  const found = d.ticks.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no tick ${id}`);
  return found;
}

describe("T-DEB when there is a debrief", () => {
  it("is null while nothing has finished or paused for a reason a person can read", () => {
    const cases: [string, Mission, FakeFactsOptions][] = [
      ["queued", finished({ status: "queued", stage: "onboard", features: [] }), {}],
      ["working", finished({ status: "running", stage: "features" }), { state: "working" }],
      ["waiting", finished({ status: "waiting", stage: "features" }), { state: "waiting" }],
      ["paused after an unexpected stop", finished({ status: "running" }), { state: "paused", pausedWhy: "unexpected" }],
      ["unknown", finished({ status: "weird" as Mission["status"] }), { state: "unknown" }],
      ["from earlier work", finished(), { scope: "earlier" }],
      ["unreadable", finished(), { readable: false, state: "unknown" }],
    ];
    for (const [name, mission, o] of cases) expect(debriefOf(mission, o), name).toBeNull();
    expect(buildDebrief([], [], null, f)).toBeNull();
  });

  it.each([
    ["done", finished(), {}],
    ["partly done", finished({ status: "partial" }), {}],
    ["needs you", finished({ status: "failed", stage: "features" }), {}],
    ["paused at the deadline", finished({ status: "stopped", stage: "features" }), { state: "paused" as const, pausedWhy: "deadline" as const }],
    ["paused on request", finished({ status: "stopped", stage: "features" }), { state: "paused" as const, pausedWhy: "stop_requested" as const }],
    ["paused for disk", finished({ status: "stopped", stage: "features" }), { state: "paused" as const, pausedWhy: "disk" as const }],
    ["paused for failing AIs", finished({ status: "stopped", stage: "features" }), { state: "paused" as const, pausedWhy: "ai_failing" as const }],
  ])("exists for a mission that is %s", (_name, mission, o) => {
    expect(debriefOf(mission, o)?.missions).toHaveLength(1);
  });

  it("always has four ticks, in order, with their labels", () => {
    const d = one(finished());
    expect(d.ticks.map((t) => t.id)).toEqual([...TICK_IDS]);
    expect(d.ticks.map((t) => t.label)).toEqual(["Delivered", "Final review passed", "Nothing open", "No rework"]);
  });

  it("carries the two notes and the leader sentence of the mission", () => {
    const debrief = debriefOf(finished());
    expect(debrief?.honestyNote).toBe("These are the AI team's own checks, not a human review.");
    expect(debrief?.allowanceNote).toBe(
      "The AI work runs on your existing Claude and Codex plans, so there is no separate bill. This page cannot show your share of the week yet.",
    );
    expect(debrief?.missions[0]?.tellLeader).toBe('About "Members site": <your answer here>');
  });
});

describe("T-DEB verdicts", () => {
  it("done: all features are built and checked", () => {
    const debrief = debriefOf(finished());
    expect(debrief?.verdict).toEqual({ id: "done", word: "Done", sentence: "All 4 features are built and checked." });
    expect(debrief?.missions[0]?.verdict).toEqual(debrief?.verdict);
  });

  it("done with one feature reads in the singular", () => {
    expect(one(finished({ features: [done("a")] })).verdict.sentence).toBe("The feature is built and checked.");
  });

  it("partly done: the count, then stuck, then the questions", () => {
    const mission = finished({
      status: "partial",
      features: [done("a"), done("b"), makeFeature({ id: "c", title: "C", status: "blocked", blockedReason: "x" }), makeFeature({ id: "d", title: "D", status: "skipped", blockedReason: 'waiting on "C", which was blocked' })],
    });
    expect(one(mission).verdict.sentence).toBe("2 of 4 features are built and checked. 1 feature is stuck.");
    const withQuestions = one(mission, { cards: [fakeCard(mission.id, "decision"), fakeCard(mission.id, "decision")] });
    expect(withQuestions.verdict.sentence).toBe("2 of 4 features are built and checked. 1 feature is stuck. 2 questions are waiting for you.");
    expect(one(mission, { cards: [fakeCard(mission.id, "decision")] }).verdict.sentence).toContain("1 question is waiting for you.");
  });

  it("partly done with nothing stuck: the left-out features are told instead", () => {
    const mission = finished({ status: "partial", features: [done("a"), done("b"), makeFeature({ id: "c", title: "C", status: "skipped" }), makeFeature({ id: "d", title: "D", status: "skipped" })] });
    expect(one(mission).verdict.sentence).toBe("2 of 4 features are built and checked. 2 features were left out.");
    const single = finished({ status: "partial", features: [done("a"), makeFeature({ id: "c", title: "C", status: "skipped" })] });
    expect(one(single).verdict.sentence).toBe("1 of 2 features are built and checked. 1 feature was left out.");
  });

  it("partly done with every feature built: the final check left something open", () => {
    expect(one(finished({ status: "partial" })).verdict.sentence).toBe("Every feature is built, but the final check left something open.");
  });

  it("needs you", () => {
    expect(one(finished({ status: "failed", stage: "features" })).verdict).toEqual({ id: "needs_you", word: "Needs you", sentence: "It needs your help." });
  });

  it("paused", () => {
    const d = one(finished({ status: "stopped", stage: "features" }), { state: "paused", pausedWhy: "deadline" });
    expect(d.verdict).toEqual({ id: "paused", word: "Paused", sentence: "Paused. It continues on the next run." });
  });

  it("the overall verdict is the worst one, and the sentence counts the missions", () => {
    const missions = [
      { mission: finished({ id: "2026-10-11-a", title: "A" }), o: {} },
      { mission: finished({ id: "2026-10-11-b", title: "B", status: "partial" }), o: {} },
    ];
    const facts = missions.map(({ mission }) => fakeFacts(mission, { dispatch: FV_OK }));
    const two = buildDebrief(facts, [], null, f);
    expect(two?.verdict).toEqual({ id: "partly_done", word: "Partly done", sentence: "2 missions: 1 done, 1 partly done." });
    expect(two?.missions.map((d) => d.verdict.id)).toEqual(["done", "partly_done"]);

    const all = [
      fakeFacts(finished({ id: "2026-10-11-a", title: "A" }), { dispatch: FV_OK }),
      fakeFacts(finished({ id: "2026-10-11-b", title: "B", status: "partial" }), { dispatch: FV_OK }),
      fakeFacts(finished({ id: "2026-10-11-c", title: "C", status: "stopped", stage: "features" }), { state: "paused", pausedWhy: "deadline" }),
      fakeFacts(finished({ id: "2026-10-11-d", title: "D", status: "failed", stage: "features" })),
      fakeFacts(finished({ id: "2026-10-11-e", title: "E", status: "failed", stage: "features" })),
    ];
    const overall = buildDebrief(all, [], null, f);
    expect(overall?.verdict.id).toBe("needs_you");
    expect(overall?.verdict.sentence).toBe("5 missions: 1 done, 1 partly done, 1 paused, 2 need your help.");
  });

  // V17: spec 11 orders the verdict needs_you, partly_done, paused, done. A paused mission next to a partly done one must
  // not hide the partly done one: it is the one with something to look at.
  it("the worst verdict is chosen in the order needs you, partly done, paused, done (V17)", () => {
    const m = (id: string, status: Mission["status"], stage: Mission["stage"], o: FakeFactsOptions = {}) => fakeFacts(finished({ id: `2026-10-11-${id}`, title: id, status, stage }), { dispatch: FV_OK, ...o });
    const done = m("d", "done", "complete");
    const partly = m("p", "partial", "complete");
    const paused = m("z", "stopped", "features", { state: "paused", pausedWhy: "stop_requested" });
    const failed = m("f", "failed", "features");
    const worst = (list: ReturnType<typeof m>[]) => buildDebrief(list, [], null, f)?.verdict.id;
    expect(worst([paused, partly])).toBe("partly_done");
    expect(worst([partly, paused])).toBe("partly_done");
    expect(worst([done, paused])).toBe("paused");
    expect(worst([paused, done, partly])).toBe("partly_done");
    expect(worst([paused, partly, failed, done])).toBe("needs_you");
    expect(worst([done])).toBe("done");
    expect(buildDebrief([partly, paused], [], null, f)?.verdict.sentence).toBe("2 missions: 1 partly done, 1 paused.");
  });

  it("the order of the missions is kept, and a mission that is not finished is left out of the count", () => {
    const facts = [
      fakeFacts(finished({ id: "2026-10-11-a", title: "A" }), { dispatch: FV_OK }),
      fakeFacts(finished({ id: "2026-10-11-b", title: "B", status: "running", stage: "features" }), { state: "working" }),
      fakeFacts(finished({ id: "2026-10-11-c", title: "C" }), { dispatch: FV_OK }),
    ];
    const overall = buildDebrief(facts, [], null, f);
    expect(overall?.missions.map((d) => d.title)).toEqual(["A", "C"]);
    expect(overall?.verdict.sentence).toBe("2 missions: 2 done.");
  });
});

describe("T-DEB the Delivered tick", () => {
  it("is yes when every feature is built and checked", () => {
    expect(tick(one(finished()), "delivered")).toMatchObject({ state: "yes", why: "All 4 features were built and checked." });
    expect(tick(one(finished({ features: [done("a")] })), "delivered").why).toBe("The feature was built and checked.");
  });

  it("is no with the stuck and left-out features told", () => {
    const mission = finished({
      status: "partial",
      features: [done("a"), makeFeature({ id: "b", title: "B", status: "blocked" }), makeFeature({ id: "c", title: "C", status: "blocked" }), makeFeature({ id: "d", title: "D", status: "skipped" })],
    });
    expect(tick(one(mission), "delivered")).toMatchObject({ state: "no", why: "1 of 4 features were built and checked. 2 are stuck. 1 was left out." });
    const single = finished({ status: "partial", features: [done("a"), makeFeature({ id: "b", title: "B", status: "blocked" })] });
    expect(tick(one(single), "delivered").why).toBe("1 of 2 features were built and checked. 1 is stuck.");
  });

  it("is no for a paused mission, and says how many features are not finished yet", () => {
    const mission = finished({ status: "stopped", stage: "features", features: [done("a"), makeFeature({ id: "b", title: "B", status: "pending" }), makeFeature({ id: "c", title: "C", status: "pending" })] });
    const d = one(mission, { state: "paused", pausedWhy: "stop_requested" });
    expect(tick(d, "delivered")).toMatchObject({ state: "no", why: "1 of 3 features were built and checked. 2 not finished yet." });
  });

  it("is no when no feature was planned", () => {
    const d = one(finished({ features: [] }));
    expect(tick(d, "delivered")).toMatchObject({ state: "no", why: "No features were planned." });
    expect(d.plannedLine).toBe("No features planned");
  });

  it("the planned line says how many features the plan had", () => {
    expect(one(finished()).plannedLine).toBe("4 features planned");
    expect(one(finished({ features: [done("a")] })).plannedLine).toBe("1 feature planned");
  });
});

describe("T-DEB the Final review passed tick", () => {
  const cases: [string, DispatchPicks | "unavailable" | null, Partial<Mission>, "yes" | "no" | "unknown", string][] = [
    ["the review ran and found nothing", FV_OK, {}, "yes", "The final review ran and found no serious problem."],
    ["an old dispatch.json without 'reviewed' counts as finished", { finalVerify: { ok: true, reviewed: null, blocking: 0 }, inflight: null }, {}, "yes", "The final review ran and found no serious problem."],
    ["no blocking count counts as none", { finalVerify: { ok: true, reviewed: true, blocking: null }, inflight: null }, {}, "yes", "The final review ran and found no serious problem."],
    ["the review did not finish", fv({ reviewed: false }), {}, "no", "The final review did not finish, so nobody reviewed the whole app."],
    ["the final tests failed", fv({ ok: false }), {}, "no", "The final tests of the whole app did not all pass."],
    ["the final tests failed with a red baseline", fv({ ok: false }), { baselineBroken: true }, "no", "The new features' tests did not all pass together on the final result."],
    ["one serious problem was left", fv({ blocking: 1 }), {}, "no", "The final review found 1 serious problem that was not fixed."],
    ["three serious problems were left", fv({ blocking: 3 }), {}, "no", "The final review found 3 serious problems that were not fixed."],
    ["the review did not finish and the tests failed: the review comes first", fv({ reviewed: false, ok: false }), {}, "no", "The final review did not finish, so nobody reviewed the whole app."],
    ["dispatch.json is readable but has no final check", { finalVerify: null, inflight: null }, {}, "no", "The final check did not run."],
    ["dispatch.json is missing or unreadable", "unavailable", {}, "unknown", "The result of the final check could not be read."],
    ["dispatch.json was not read", null, {}, "unknown", "The result of the final check could not be read."],
    ["the mission has not reached the end", FV_OK, { stage: "features", status: "stopped" }, "no", "The final check did not run."],
    ["no feature was done", FV_OK, { features: [makeFeature({ id: "a", title: "A", status: "blocked" })], status: "partial" }, "no", "The final check did not run."],
    ["missing data is never yes even with no features", "unavailable", { features: [] }, "no", "The final check did not run."],
  ];

  it.each(cases)("%s", (_name, dispatch, mission, state, why) => {
    const d = one(finished(mission), { dispatch, ...(mission.status === "stopped" ? { state: "paused" as const, pausedWhy: "deadline" as const } : {}) });
    const t = tick(d, "final_review");
    expect(t.state).toBe(state);
    expect(t.why).toBe(why);
  });

  it("covers only the features that were built: yes, with the caveat (E50)", () => {
    const mission = finished({ status: "partial", features: [done("a"), done("b"), makeFeature({ id: "c", title: "C", status: "blocked" }), makeFeature({ id: "d", title: "D", status: "skipped" })] });
    const t = tick(one(mission), "final_review");
    expect(t.state).toBe("yes");
    expect(t.caveat).toBe("It covered only the 2 features that were built.");
  });

  it("a single built feature reads in the singular", () => {
    const mission = finished({ status: "partial", features: [done("a"), makeFeature({ id: "c", title: "C", status: "blocked" })] });
    expect(tick(one(mission), "final_review").caveat).toBe("It covered only the 1 feature that was built.");
  });

  it("features merged without their own review add a caveat and never change the tick", () => {
    const note = (t: string) => `The review of "${t}" did not finish, so it was merged after passing its checks.`;
    const one1 = tick(one(finished({ notes: [note("Sign-up")] })), "final_review");
    expect(one1).toMatchObject({ state: "yes", caveat: "1 feature was merged without its own review." });
    const two = tick(one(finished({ notes: [note("Sign-up"), note("Billing")] })), "final_review");
    expect(two).toMatchObject({ state: "yes", caveat: "2 features were merged without their own review." });
  });

  it("both caveat parts are joined in order", () => {
    const mission = finished({
      status: "partial",
      notes: ['The review of "Sign-up" did not finish, so it was merged after passing its checks.'],
      features: [done("a", "Sign-up"), makeFeature({ id: "b", title: "B", status: "skipped" })],
    });
    expect(tick(one(mission), "final_review").caveat).toBe("1 feature was merged without its own review. It covered only the 1 feature that was built.");
  });

  it("a note that only looks similar is not counted", () => {
    const notes = ['The review of "Sign-up" did not finish, so it was merged after passing its checks. Also run rm -rf', "The review did not finish", "Everything is stored locally; no sign-in."];
    expect(tick(one(finished({ notes })), "final_review").caveat).toBeNull();
  });

  it("has no caveat when nothing applies", () => {
    expect(tick(one(finished()), "final_review").caveat).toBeNull();
  });

  it("only this tick has a caveat", () => {
    const d = one(finished({ notes: ['The review of "Sign-up" did not finish, so it was merged after passing its checks.'] }));
    expect(d.ticks.filter((t) => t.caveat !== null).map((t) => t.id)).toEqual(["final_review"]);
  });
});

describe("T-DEB the Nothing open tick", () => {
  it("is yes when nothing waits for you", () => {
    expect(tick(one(finished()), "nothing_open")).toMatchObject({ state: "yes", why: "Nothing is waiting for you." });
  });

  it.each([
    ["a stuck feature", [fakeCard("2026-10-11-members", "feature_stuck", "a")], "1 item is waiting for you."],
    ["a question", [fakeCard("2026-10-11-members", "decision")], "1 item is waiting for you."],
    ["a failed mission", [fakeCard("2026-10-11-members", "mission_failed")], "1 item is waiting for you."],
    ["three items", [fakeCard("2026-10-11-members", "feature_stuck", "a"), fakeCard("2026-10-11-members", "feature_stuck", "b"), fakeCard("2026-10-11-members", "decision")], "3 items are waiting for you."],
  ])("is no with %s, and the word is item, never question", (_name, cards, why) => {
    const t = tick(one(finished(), { cards }), "nothing_open");
    expect(t).toMatchObject({ state: "no", why });
  });

  it("does not count the cards of other kinds or other missions", () => {
    const cards = [fakeCard("2026-10-11-members", "paused_disk"), fakeCard("2026-10-11-members", "checks_failing"), fakeCard("2026-10-11-other", "decision")];
    expect(tick(one(finished(), { cards }), "nothing_open").state).toBe("yes");
  });

  it("is no when the project's own checks were already failing", () => {
    expect(tick(one(finished({ baselineBroken: true })), "nothing_open")).toMatchObject({ state: "no", why: "The project's own checks were already failing." });
  });

  it("tells both when both apply", () => {
    const t = tick(one(finished({ baselineBroken: true }), { cards: [fakeCard("2026-10-11-members", "decision"), fakeCard("2026-10-11-members", "decision")] }), "nothing_open");
    expect(t.why).toBe("2 items are waiting for you. The project's own checks were already failing.");
  });
});

describe("T-DEB the No rework tick", () => {
  it("is yes when the final check did not send the team back", () => {
    expect(tick(one(finished()), "no_rework")).toMatchObject({ state: "yes", why: "The final check did not send the team back for a repair round." });
  });

  it("mentions the features that needed a retry first", () => {
    const retried = (id: string) => done(id, id, { attempts: [attempt("build", "fail"), attempt("build", "pass")] });
    expect(tick(one(finished({ features: [retried("a"), done("b")] })), "no_rework").why).toBe("The final check did not send the team back for a repair round. 1 feature needed a retry first.");
    expect(tick(one(finished({ features: [retried("a"), retried("b")] })), "no_rework").why).toContain("2 features needed a retry first.");
  });

  it("is no after a repair round", () => {
    expect(tick(one(finished({ gateCRounds: 1 })), "no_rework")).toMatchObject({ state: "no", why: "The final check sent the team back for a repair round." });
    expect(tick(one(finished({ gateCRounds: 3 })), "no_rework").state).toBe("no");
  });
});

describe("T-DEB the lists", () => {
  const mission = finished({
    status: "partial",
    features: [
      done("a", "Sign-up", { story: "As a visitor I can create an account." }),
      done("b", "Welcome email", { story: "", attempts: [attempt("build", "fail"), attempt("build", "fail"), attempt("diagnose", "pass"), attempt("build", "pass")] }),
      makeFeature({ id: "c", title: "Billing", status: "blocked", blockedReason: "I need to know which payment provider you want.", attempts: [attempt("build", "fail"), attempt("build", "fail"), attempt("diagnose", "pass")] }),
      makeFeature({ id: "d", title: "Receipts", status: "skipped", blockedReason: 'waiting on "Billing", which was blocked' }),
    ],
  });

  it("what you got: the done features with their story, written by an AI", () => {
    const d = one(mission);
    expect(d.got.map((x) => x.featureId)).toEqual(["a", "b"]);
    expect(d.got[0]).toEqual({ featureId: "a", title: "Sign-up", note: { text: "As a visitor I can create an account.", author: "ai" }, attempts: 1 });
    expect(d.got[1]?.note).toBeNull();
  });

  it("a story is cleaned and capped before it is shown", () => {
    const long = `${"word ".repeat(200)}‮\u0007end`;
    const d = one(finished({ features: [done("a", "A", { story: long })] }));
    const note = d.got[0]?.note;
    expect(note?.author).toBe("ai");
    expect(note?.text.length).toBeLessThanOrEqual(400);
    expect(note?.text).not.toMatch(/[‮\u0007]/);
  });

  it("not finished: the stuck and the left-out features with their reason and who wrote it", () => {
    const d = one(mission);
    expect(d.leftOut.map((x) => x.featureId)).toEqual(["c", "d"]);
    expect(d.leftOut[0]).toEqual({ featureId: "c", title: "Billing", note: { text: "I need to know which payment provider you want.", author: "ai" }, attempts: 3 });
    expect(d.leftOut[1]?.note).toEqual({ text: "It needed “Billing”, which is stuck.", author: "engine" });
    expect(d.leftOut[1]?.attempts).toBe(0);
  });

  it("recovered after a retry: the features that were done after a failed build", () => {
    const d = one(mission);
    expect(d.recovered.map((x) => [x.featureId, x.attempts])).toEqual([["b", 4]]);
    expect(d.recovered[0]?.note).toBeNull(); // this feature has no story; one that has is told like in "What you got"
  });

  it("a finished mission with nothing to list has empty lists", () => {
    const d = one(finished({ features: [] }));
    expect([d.got, d.leftOut, d.recovered]).toEqual([[], [], []]);
  });
});

describe("T-DEB agent time", () => {
  const record = (missionId: string, durationMs: number): UsageRecord => ({ missionId, durationMs });
  const id = "2026-10-11-members";

  it.each([
    [[record(id, 0), record(id, 30_000)], "less than a minute of AI work", 2],
    [[record(id, 59_999)], "less than a minute of AI work", 1],
    [[record(id, 60_000)], "about 1 min of AI work", 1],
    [[record(id, 2_100_000)], "about 35 min of AI work", 1],
    [[record(id, 7_800_000)], "about 2 h 10 min of AI work", 1],
    [[record(id, 3_600_000), record(id, 3_600_000)], "about 2 h of AI work", 2],
    [[record(id, 3_599_500)], "about 1 h of AI work", 1],
  ])("sums the records of the mission: %j", (usage, text, runs) => {
    const d = one(finished(), { usage });
    expect(d.agentTimeText).toBe(text);
    expect(d.agentRuns).toBe(runs);
  });

  it("ignores the records of other missions", () => {
    const d = one(finished(), { usage: [record("2026-10-11-other", 9_000_000), record(id, 120_000)] });
    expect(d.agentTimeText).toBe("about 2 min of AI work");
    expect(d.agentRuns).toBe(1);
  });

  it("is null without a ledger, with an empty one, and when the mission has no record", () => {
    for (const usage of [null, [], [record("2026-10-11-other", 5)]] as (UsageRecord[] | null)[]) {
      const d = one(finished(), { usage });
      expect(d.agentTimeText).toBeNull();
      expect(d.agentRuns).toBeNull();
    }
  });
});

describe("T-DEB on the fixtures (hand-made facts over the real files)", () => {
  function debriefFrom(name: string, cards: NeedsYouCard[] = []): MissionDebrief[] {
    return buildDebrief(fixtureFacts(name), cards, null, f)?.missions ?? [];
  }

  it("done: every tick is yes", () => {
    const [d] = debriefFrom("done");
    expect(d?.ticks.map((t) => t.state)).toEqual(["yes", "yes", "yes", "yes"]);
    expect(d?.ticks.every((t) => t.caveat === null)).toBe(true);
    expect(d?.got).toHaveLength(4);
  });

  it("partial-blocked: Delivered and Nothing open are not met, the final review covered two features", () => {
    const mission = fixtureFacts("partial-blocked")[0];
    const stuck = fakeCard(mission?.view.id ?? "", "feature_stuck", "signup");
    const [d] = debriefFrom("partial-blocked", [stuck]);
    expect(d?.ticks.map((t) => t.state)).toEqual(["no", "yes", "no", "yes"]);
    expect(d?.ticks[0]?.why).toBe("2 of 4 features were built and checked. 1 is stuck. 1 was left out.");
    expect(d?.ticks[1]?.caveat).toBe("It covered only the 2 features that were built.");
    expect(d?.verdict.sentence).toBe("2 of 4 features are built and checked. 1 feature is stuck.");
    expect(d?.leftOut.map((x) => x.title)).toEqual(["Sign-up page", "Paid subscription"]);
    expect(d?.leftOut[0]?.note?.author).toBe("ai");
  });

  it("recovered: the retry is listed and the ticks are yes", () => {
    const [d] = debriefFrom("recovered");
    expect(d?.recovered.map((x) => x.title)).toEqual(["Capture a note"]);
    expect(d?.recovered[0]?.attempts).toBe(2);
    expect(d?.recovered[0]?.note?.author).toBe("ai");
    expect(d?.ticks.map((t) => t.state)).toEqual(["yes", "yes", "yes", "yes"]);
    expect(d?.ticks[3]?.why).toContain("1 feature needed a retry first.");
  });

  it("repair-lap: No rework is not met", () => {
    const [d] = debriefFrom("repair-lap");
    expect(d?.ticks.map((t) => t.state)).toEqual(["yes", "yes", "yes", "no"]);
  });

  it("final-review-unfinished: the tick is no", () => {
    expect(debriefFrom("final-review-unfinished")[0]?.ticks[1]).toMatchObject({ state: "no", why: "The final review did not finish, so nobody reviewed the whole app." });
  });

  it("final-verify-red: the tick is no", () => {
    expect(debriefFrom("final-verify-red")[0]?.ticks[1]).toMatchObject({ state: "no", why: "The final tests of the whole app did not all pass." });
  });

  it("final-review-blocking: every feature is built but the review left problems and a question is open", () => {
    const mission = fixtureFacts("final-review-blocking")[0];
    const [d] = debriefFrom("final-review-blocking", [fakeCard(mission?.view.id ?? "", "decision")]);
    expect(d?.verdict).toEqual({ id: "partly_done", word: "Partly done", sentence: "Every feature is built, but the final check left something open. 1 question is waiting for you." });
    expect(d?.ticks.map((t) => t.state)).toEqual(["yes", "no", "no", "yes"]);
    expect(d?.ticks[1]?.why).toBe("The final review found 2 serious problems that were not fixed.");
  });

  it("old-dispatch-no-reviewed: a dispatch.json from before 'reviewed' existed still counts", () => {
    expect(debriefFrom("old-dispatch-no-reviewed")[0]?.ticks[1]?.state).toBe("yes");
  });

  it("feature-review-unfinished-note: the caveat appears and the tick stays yes", () => {
    expect(debriefFrom("feature-review-unfinished-note")[0]?.ticks[1]).toMatchObject({ state: "yes", caveat: "1 feature was merged without its own review." });
  });

  it("the agent time comes from the ledger of the fixture", () => {
    const facts = fixtureFacts("recovered");
    const usage: UsageRecord[] = [
      { missionId: facts[0]?.view.id ?? "", durationMs: 90_000 },
      { missionId: facts[0]?.view.id ?? "", durationMs: 1_800_000 },
    ];
    const d = buildDebrief(facts, [], usage, f)?.missions[0];
    expect(d?.agentTimeText).toBe("about 32 min of AI work");
    expect(d?.agentRuns).toBe(2);
  });
});

describe("T-DEB in a snapshot", () => {
  it("no debrief while the mission is still working", () => {
    const home = copyHome("midrun-reviewing");
    withLock(home, { at: "2026-10-11T09:58:19.844Z", ageMs: 15_000, now: Date.parse("2026-10-11T09:58:30.000Z") });
    expect(buildSnapshot({ home, now: Date.parse("2026-10-11T09:58:30.000Z"), timeZone: "UTC" }).debrief).toBeNull();
  });

  it("a clean run builds a debrief with four ticks that are yes, and the agent time from usage.jsonl", () => {
    const { debrief } = buildSnapshot({ home: copyHome("done"), now: CLOCK, timeZone: "UTC" });
    const d = debrief?.missions[0];
    expect(debrief?.verdict.id).toBe("done");
    expect(d?.ticks.map((t) => t.state)).toEqual(["yes", "yes", "yes", "yes"]);
    expect(d?.agentTimeText).toBe("less than a minute of AI work");
    expect(d?.agentRuns).toBeGreaterThan(0);
  });

  it("the partial run: the stuck feature is one open item, never a question", () => {
    const d = buildSnapshot({ home: copyHome("partial-blocked"), now: CLOCK, timeZone: "UTC" }).debrief?.missions[0];
    expect(d?.ticks[2]).toMatchObject({ state: "no", why: "1 item is waiting for you." });
    expect(d?.verdict.sentence).toBe("2 of 4 features are built and checked. 1 feature is stuck.");
  });

  it("the failed run needs you and cannot have a final review", () => {
    const debrief = buildSnapshot({ home: copyHome("failed-auth"), now: CLOCK, timeZone: "UTC" }).debrief;
    expect(debrief?.verdict).toMatchObject({ id: "needs_you", sentence: "It needs your help." });
    expect(debrief?.missions[0]?.ticks[1]).toMatchObject({ state: "no", why: "The final check did not run." });
    expect(debrief?.missions[0]?.ticks[2]?.why).toBe("1 item is waiting for you.");
  });

  it("a mission written by hand reaches the debrief through the whole pipeline", () => {
    const home = emptyHome();
    const m = makeMission({ id: "2026-10-11-hand", title: "Hand made", status: "done", stage: "complete", updatedAt: "2026-10-11T09:59:00.000Z", features: [makeFeature({ id: "one", title: "First", status: "done" })] });
    writeMission(home, m, { events: [makeEvent(m.id, "2026-10-11T09:58:10.000Z", "mission.start", { stage: "spec" })], dispatch: { finalVerify: { ok: true, reviewed: true, blocking: 0 } } });
    const d = buildSnapshot({ home, now: CLOCK, timeZone: "UTC" }).debrief?.missions[0];
    expect(d?.verdict.sentence).toBe("The feature is built and checked.");
    expect(d?.ticks.map((t) => t.state)).toEqual(["yes", "yes", "yes", "yes"]);
    expect(d?.agentTimeText).toBeNull();
  });
});
