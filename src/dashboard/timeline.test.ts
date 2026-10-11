// T-TL-*: the translation of every event type (docs/dashboard-spec.md, 7.1), the shortening rules (7.2) and the
// author of each line. The unit tests build the facts by hand; the last group builds real snapshots from the fixtures.
import { describe, expect, it } from "vitest";
import { copyHome, emptyHome, makeEvent, makeFeature, makeMission, withLock, writeMission } from "../../test/dashboard-helpers.js";
import { fakeFacts, type FakeFactsOptions } from "../../test/dashboard-night-helpers.js";
import type { MissionEvent } from "../types.js";
import { TIMELINE_MAX_ITEMS, TONIGHT_WINDOW_MS } from "./constants.js";
import { buildSnapshot } from "./snapshot.js";
import { buildTimeline } from "./timeline.js";
import type { Timeline, TimelineItem, Tone } from "./types.js";
import { makeFormatter } from "./vocabulary.js";

const NOW = Date.parse("2026-10-11T10:03:30.000Z");
const f = makeFormatter("UTC");
const MISSION_ID = "2026-10-11-gadget-shop";
const T = "“Gadget shop”";

function mission() {
  return makeMission({
    id: MISSION_ID,
    title: "Gadget shop",
    features: [
      makeFeature({ id: "alpha", title: "Alpha page" }),
      makeFeature({ id: "beta", title: "Beta page" }),
      makeFeature({ id: "gate-c-fix-1", title: "Repair page" }),
    ],
  });
}

let clockMs = Date.parse("2026-10-11T09:58:10.000Z");
/** An event a second after the last one made by this helper. */
function ev(type: string, data: Record<string, unknown> = {}): MissionEvent {
  clockMs += 1000;
  return makeEvent(MISSION_ID, clockMs, type, data);
}

function timelineOf(events: MissionEvent[], o: FakeFactsOptions = {}, now = NOW): Timeline {
  return buildTimeline([fakeFacts(mission(), { events, ...o })], now, f);
}

function lines(events: MissionEvent[], o: FakeFactsOptions = {}): string[] {
  return timelineOf(events, o).items.map((i) => i.text);
}

function only(events: MissionEvent[], o: FakeFactsOptions = {}): TimelineItem {
  const { items } = timelineOf(events, o);
  expect(items).toHaveLength(1);
  return items[0] as TimelineItem;
}

/** [name, event type, data, sentence, tone] */
type Case = [string, string, Record<string, unknown>, string, Tone];

const WAIT_MS = Date.parse("2026-10-11T12:59:10.000Z");

describe("T-TL-01 to T-TL-26: one sentence per event type", () => {
  const cases: Case[] = [
    ["T-TL-01 mission.start", "mission.start", { stage: "spec" }, `Started working on ${T}.`, "info"],
    ["T-TL-02 mission.resume", "mission.resume", { stage: "features" }, `Picked ${T} up again where it left off.`, "info"],
    ["T-TL-03 mission.retry", "mission.retry", { failure: "private text" }, `Trying ${T} again.`, "info"],
    ["T-TL-04 mission.stopped deadline", "mission.stopped", { reason: "Stopped at the deadline." }, `Paused at the planned time. ${T} continues on the next run.`, "warn"],
    ["T-TL-04 mission.stopped stop requested", "mission.stopped", { reason: "stop requested" }, `Paused on request. ${T} continues on the next run.`, "warn"],
    ["T-TL-04 mission.stopped disk", "mission.stopped", { reason: "The disk is almost full (1 GB left)." }, `Paused: the disk is almost full. ${T} continues once there is space.`, "bad"],
    ["T-TL-04 mission.stopped no space", "mission.stopped", { reason: "write failed: no space left on device" }, `Paused: the disk is almost full. ${T} continues once there is space.`, "bad"],
    ["T-TL-04 mission.stopped ai failing", "mission.stopped", { reason: "The AI team keeps failing." }, `Paused: the AI team kept failing. ${T} continues on the next run.`, "bad"],
    ["T-TL-04 mission.stopped kept refusing", "mission.stopped", { reason: "Both AIs kept refusing the work." }, `Paused: the AI team kept failing. ${T} continues on the next run.`, "bad"],
    ["T-TL-04 mission.stopped unknown reason", "mission.stopped", { reason: "Something else." }, `Paused. ${T} continues on the next run.`, "warn"],
    ["T-TL-04 mission.stopped no reason", "mission.stopped", {}, `Paused. ${T} continues on the next run.`, "warn"],
    ["T-TL-05 mission.failed", "mission.failed", { reason: "No model could run: codex and claude need a new login." }, `${T} needs your help.`, "bad"],
    ["T-TL-06 mission.end done", "mission.end", { status: "done" }, `Finished ${T}: done.`, "good"],
    ["T-TL-06 mission.end partial", "mission.end", { status: "partial" }, `Finished ${T}: partly done.`, "warn"],
    ["T-TL-06 mission.end other", "mission.end", { status: "stopped" }, `Finished ${T}.`, "info"],
    ["T-TL-07 stage features to gate_c", "stage", { from: "features", to: "gate_c" }, "The building is finished. Starting the final check.", "info"],
    ["T-TL-07 stage gate_c to features", "stage", { from: "gate_c", to: "features" }, "The final check found problems. Starting a repair round.", "warn"],
    ["T-TL-07 stage features to finalize", "stage", { from: "features", to: "finalize" }, "Skipped the rest of the building and moved on to the final steps.", "warn"],
    ["T-TL-08 feature.status testing", "feature.status", { feature: "alpha", from: "pending", to: "testing" }, "Started on “Alpha page”.", "info"],
    ["T-TL-08 feature.status reviewing", "feature.status", { feature: "alpha", from: "building", to: "reviewing" }, "“Alpha page” is built. A second AI is reviewing it.", "info"],
    ["T-TL-08 feature.status blocked", "feature.status", { feature: "alpha", from: "building", to: "blocked", reason: "x" }, "“Alpha page” is stuck.", "bad"],
    ["T-TL-08 feature.status skipped", "feature.status", { feature: "beta", from: "pending", to: "skipped", reason: 'waiting on "Alpha page", which was blocked' }, "“Beta page” was left out because it needed a stuck feature.", "warn"],
    ["T-TL-09 attempt foundation ready", "attempt", { feature: "_init", rung: 0, outcome: "pass" }, "The app's foundation is ready.", "good"],
    ["T-TL-09 attempt foundation retry", "attempt", { feature: "_init", rung: 0, outcome: "fail" }, "The first try at the app's foundation did not pass. Trying again.", "warn"],
    ["T-TL-09 attempt build failed (first rung)", "attempt", { feature: "alpha", rung: 0, action: "build", outcome: "fail" }, "“Alpha page” did not pass its checks. Calling in reinforcements (step 2 of 5).", "warn"],
    ["T-TL-09 attempt build failed (third rung)", "attempt", { feature: "alpha", rung: 2, action: "build", outcome: "error" }, "“Alpha page” did not pass its checks. Calling in reinforcements (step 4 of 5).", "warn"],
    ["T-TL-09 attempt build failed (last rung stays capped)", "attempt", { feature: "alpha", rung: 4, action: "build", outcome: "fail" }, "“Alpha page” did not pass its checks. Calling in reinforcements (step 5 of 5).", "warn"],
    ["T-TL-09 attempt diagnose passed", "attempt", { feature: "alpha", rung: 2, action: "diagnose", outcome: "pass" }, "An expert AI looked at why “Alpha page” keeps failing.", "info"],
    ["T-TL-09 attempt diagnose failed", "attempt", { feature: "alpha", rung: 2, action: "diagnose", outcome: "fail" }, "The expert diagnosis of “Alpha page” did not finish.", "warn"],
    ["T-TL-09 attempt fix failed", "attempt", { feature: "alpha", rung: 0, action: "fix", outcome: "fail" }, "A fix for the review's concerns on “Alpha page” did not pass and was undone.", "warn"],
    ["T-TL-10 verify gate-c passed", "verify", { label: "gate-c", ok: true }, "The final tests of the whole app passed.", "good"],
    ["T-TL-10 verify gate-c failed", "verify", { label: "gate-c", ok: false }, "The final tests of the whole app failed.", "warn"],
    ["T-TL-10 verify gate-c-features passed", "verify", { label: "gate-c-features", ok: true }, "The tests of the new features passed together on the final result.", "good"],
    ["T-TL-10 verify gate-c-features failed", "verify", { label: "gate-c-features", ok: false }, "The tests of the new features did not all pass together on the final result.", "warn"],
    ["T-TL-10 verify timed out (feature)", "verify", { label: "alpha-tests-a1", feature: "alpha", ok: false, timedOut: true }, "A check on “Alpha page” took too long and was stopped.", "warn"],
    ["T-TL-10 verify timed out (no feature)", "verify", { label: "slow", ok: false, timedOut: true }, "A check took too long and was stopped.", "warn"],
    ["T-TL-11 merge", "merge", { feature: "alpha", commit: "abc" }, "“Alpha page” is built and checked.", "good"],
    ["T-TL-11 merge of an unknown feature", "merge", { feature: "nope" }, "“a feature” is built and checked.", "good"],
    ["T-TL-13 run.end timeout", "run.end", { label: "spec", outcome: "timeout" }, "An AI step did not finish. It ran too long or stopped working.", "warn"],
    ["T-TL-13 run.end crashed (feature)", "run.end", { label: "build-alpha", outcome: "crashed" }, "An AI step on “Alpha page” did not finish. It ran too long or stopped working.", "warn"],
    ["T-TL-13 run.end auth", "run.end", { label: "build-alpha", outcome: "auth" }, "A login has expired.", "bad"],
    ["T-TL-14 limit.wait", "limit.wait", { until: new Date(WAIT_MS).toISOString(), reason: "gpt-6-astra: session limit until 2026-10-11T12:58:25.000Z" }, "Waiting for allowance until 12:59. It resumes by itself.", "warn"],
    ["T-TL-16 error", "error", { stage: "features", message: "private" }, "Something went wrong inside Mission Control. The work so far is kept.", "bad"],
    ["T-TL-16 error (feature)", "error", { feature: "alpha", message: "private" }, "Something went wrong inside Mission Control while working on “Alpha page”. The work so far is kept.", "bad"],
    ["T-TL-17 spec", "spec", { appName: "x", features: ["alpha", "beta", "gate-c-fix-1"] }, "The plan is ready: 3 features.", "info"],
    ["T-TL-17 spec (one feature)", "spec", { features: ["alpha"] }, "The plan is ready: 1 feature.", "info"],
    ["T-TL-18 tests.frozen", "tests.frozen", { feature: "alpha", files: ["a.test.mjs", "b.test.mjs"] }, "Wrote 2 checks that “Alpha page” must pass. The AI that builds it cannot change them.", "info"],
    ["T-TL-18 tests.frozen (one file)", "tests.frozen", { feature: "alpha", files: ["a.test.mjs"] }, "Wrote 1 check that “Alpha page” must pass. The AI that builds it cannot change it.", "info"],
    ["T-TL-19 tests.stray", "tests.stray", { feature: "alpha" }, "While writing the checks for “Alpha page”, an AI changed files it should not. The changes were undone.", "warn"],
    ["T-TL-20 frozen.reverted", "frozen.reverted", { feature: "alpha" }, "While building “Alpha page”, an AI changed the checks it must pass. The change was undone.", "warn"],
    ["T-TL-21 feature.added", "feature.added", { feature: "gate-c-fix-1", round: 1 }, "The final check found problems, so a repair feature was added.", "warn"],
    ["T-TL-22 run.interrupted", "run.interrupted", { label: "build-alpha" }, "Work was cut off by a restart or a failure. That step is tried again.", "warn"],
    ["T-TL-26 git.settings.restored", "git.settings.restored", {}, "An AI changed the app's version-control settings. The change was undone.", "warn"],
  ];

  it.each(cases)("%s", (_name, type, data, text, tone) => {
    const item = only([ev(type, data)]);
    expect(item.text).toBe(text);
    expect(item.tone).toBe(tone);
    expect(item.count).toBe(1);
    expect(item.missionId).toBe(MISSION_ID);
  });

  it("T-TL-05 mission.failed: the reason is a note, engine-written when it is a known engine sentence", () => {
    const login = only([ev("mission.failed", { reason: "No model could run: codex and claude need a new login." })]);
    expect(login.note).toEqual({ text: "A login has expired. Claude or Codex has to be logged in again on the PC.", author: "engine" });
    expect(login.author).toBe("engine");
    const odd = only([ev("mission.failed", { reason: "The wizard forgot the plan." })]);
    expect(odd.note).toEqual({ text: "The wizard forgot the plan.", author: "ai" });
    expect(odd.author).toBe("ai");
    expect(only([ev("mission.failed", {})]).note).toBeNull();
  });

  it("T-TL-07 the other stage changes are hidden", () => {
    const hidden = [
      ["onboard", "spec"],
      ["spec", "gate_a"],
      ["gate_a", "init"],
      ["gate_a", "features"],
      ["init", "features"],
      ["gate_c", "finalize"],
      ["finalize", "complete"],
    ];
    expect(lines(hidden.map(([from, to]) => ev("stage", { from, to })))).toEqual([]);
  });

  it("T-TL-08 a feature status of building, done or pending is hidden (the merge tells done)", () => {
    expect(lines(["building", "done", "pending", "weird"].map((to) => ev("feature.status", { feature: "alpha", to })))).toEqual([]);
  });

  it("T-TL-08 feature.status blocked: the reason is a note, engine-written for a known engine sentence", () => {
    const known = only([ev("feature.status", { feature: "alpha", to: "blocked", reason: "tried every escalation step, but its checks still failed" })]);
    expect(known.note).toEqual({ text: "The AI team tried every step it has, and the checks still failed.", author: "engine" });
    expect(known.author).toBe("engine");
    const architect = only([ev("feature.status", { feature: "alpha", to: "blocked", reason: "I need to know which payment provider you want." })]);
    expect(architect.note).toEqual({ text: "I need to know which payment provider you want.", author: "ai" });
    expect(architect.author).toBe("ai");
    expect(architect.featureId).toBe("alpha");
    expect(only([ev("feature.status", { feature: "alpha", to: "blocked" })]).note).toBeNull();
  });

  it("T-TL-09 attempt: a passing build and a passing fix are hidden", () => {
    expect(lines([ev("attempt", { feature: "alpha", rung: 0, action: "build", outcome: "pass" }), ev("attempt", { feature: "alpha", rung: 0, action: "fix", outcome: "pass" })])).toEqual([]);
  });

  it("T-TL-09 attempt: a failed build of a feature the mission does not know gets no step number", () => {
    expect(only([ev("attempt", { feature: "ghost", rung: 0, action: "build", outcome: "fail" })]).text).toBe(
      "“a feature” did not pass its checks. Calling in reinforcements.",
    );
  });

  it("T-TL-09 attempt: the step count is the size of that feature's ladder", () => {
    const facts = fakeFacts(mission(), { events: [ev("attempt", { feature: "beta", rung: 1, action: "build", outcome: "fail" })] });
    const beta = facts.view.features.find((x) => x.id === "beta");
    if (beta === undefined) throw new Error("fixture");
    beta.steps.total = 3;
    expect(buildTimeline([facts], NOW, f).items[0]?.text).toBe("“Beta page” did not pass its checks. Calling in reinforcements (step 3 of 3).");
  });

  it("T-TL-10 verify: a failed final test run with a red baseline is told as already failing (info)", () => {
    const item = only([ev("verify", { label: "gate-c", ok: false })], { baselineBroken: true });
    expect(item.text).toBe("The project's own full test suite failed. It was already failing before this work started.");
    expect(item.tone).toBe("info");
  });

  it("T-TL-10 verify: a red check before a build, an install and a green check are hidden", () => {
    const events = [
      ev("verify", { label: "alpha-red", feature: "alpha", ok: false, timedOut: false }),
      ev("verify", { label: "install-alpha", ok: true }),
      ev("verify", { label: "alpha-full-a1", feature: "alpha", ok: true }),
      ev("verify", { label: "install-gate-c", ok: false }),
    ];
    expect(lines(events)).toEqual([]);
  });

  it("T-TL-12 and T-TL-15 run.start and report are hidden", () => {
    expect(lines([ev("run.start", { label: "spec", jobId: "spec-1", role: "architect" }), ev("report", { path: "/x/report.md" })])).toEqual([]);
  });

  it("T-TL-13 run.end: ok, failed, limited and aborted are hidden", () => {
    expect(lines(["ok", "failed", "limited", "aborted", "mystery"].map((outcome) => ev("run.end", { label: "spec", outcome })))).toEqual([]);
  });

  it("T-TL-14 limit.wait: the cause and the time come from the reason, and the raw reason is never shown", () => {
    const login = only([ev("limit.wait", { until: new Date(WAIT_MS).toISOString(), reason: "gpt-6-astra: session limit until 2026-10-11T12:58:25.000Z; claude-opus-5-5: claude needs a new login" })]);
    expect(login.text).toBe("Waiting for allowance until 12:59. Claude also needs a new login.");
    const odd = only([ev("limit.wait", { until: new Date(WAIT_MS).toISOString(), reason: "something unexpected" })]);
    expect(odd.text).toBe("Waiting until 12:59. Mission Control cannot tell why.");
    expect(odd.text).not.toContain("unexpected");
    expect(only([ev("limit.wait", {})]).text).toBe("Waiting. Mission Control cannot tell why.");
  });

  it("T-TL-17 spec: a second plan in the same night is a revision", () => {
    expect(lines([ev("spec", { features: ["alpha", "beta"] }), ev("spec", { features: ["alpha"] })])).toEqual(["The plan is ready: 2 features.", "The plan was revised: 1 feature."]);
  });

  it("T-TL-17 spec: only a plan inside the window counts as the first one", () => {
    const old = makeEvent(MISSION_ID, NOW - TONIGHT_WINDOW_MS - 60_000, "spec", { features: ["alpha"] });
    expect(lines([old, ev("spec", { features: ["alpha", "beta"] })])).toEqual(["The plan is ready: 2 features."]);
  });

  it("T-TL-18 tests.frozen without a list of files is hidden", () => {
    expect(lines([ev("tests.frozen", { feature: "alpha" })])).toEqual([]);
  });

  it("T-TL-23 to T-TL-25 processes.reaped, branch.restored and git.locks.removed are hidden", () => {
    expect(lines([ev("processes.reaped", { count: 1 }), ev("branch.restored", { branch: "mc/x" }), ev("git.locks.removed", { count: 2 })])).toEqual([]);
  });

  it("T-TL-UNKNOWN an unknown event type is hidden, never shown raw, and does not throw", () => {
    const events = [ev("mystery.event", { secret: "do-not-show", feature: "alpha" }), ev("mission.start", {}), ev("", {}), ev("feature.status", { feature: 7, to: "blocked" })];
    const timeline = timelineOf(events);
    expect(timeline.items.map((i) => i.text)).toEqual([`Started working on ${T}.`]);
    expect(JSON.stringify(timeline)).not.toContain("do-not-show");
  });

  it("every sentence is plain: no straight quotes, no em dash, none of the words the glossary forbids", () => {
    const home = copyHome("all-event-types");
    const snapshot = buildSnapshot({ home, now: Date.parse("2026-10-11T10:03:30.000Z"), timeZone: "UTC" });
    const words = /\b(builder|test writer|acceptance|git|crash|crashed|worktree|branch|frozen|gate|escalation|rung|token|objective|halted|killed)\b/i;
    expect(snapshot.timeline.items.length).toBeGreaterThan(20);
    for (const item of snapshot.timeline.items) {
      expect(item.text).not.toMatch(/"/);
      expect(item.text).not.toContain("—");
      expect(item.text.replace(/“[^”]*”/g, "")).not.toMatch(words);
    }
  });
});

describe("T-TL-SHORT: keeping the timeline short (spec 7.2)", () => {
  it("the window: an event 18 hours old is kept, one older is dropped", () => {
    const edge = makeEvent(MISSION_ID, NOW - TONIGHT_WINDOW_MS, "mission.retry");
    const older = makeEvent(MISSION_ID, NOW - TONIGHT_WINDOW_MS - 1, "mission.resume");
    expect(lines([older, edge])).toEqual([`Trying ${T} again.`]);
  });

  it("an event that is not a time is skipped", () => {
    const broken = { at: "not a time", missionId: MISSION_ID, type: "mission.start", data: {} };
    expect(lines([broken, ev("mission.retry")])).toEqual([`Trying ${T} again.`]);
  });

  it("a feature that finished shows one line: the details before its last milestone are dropped", () => {
    const events = [
      ev("feature.status", { feature: "alpha", to: "testing" }),
      ev("tests.frozen", { feature: "alpha", files: ["a"] }),
      ev("feature.status", { feature: "alpha", to: "reviewing" }),
      ev("merge", { feature: "alpha" }),
    ];
    expect(lines(events)).toEqual(["“Alpha page” is built and checked."]);
  });

  it("a feature in progress shows its one newest step", () => {
    const events = [ev("feature.status", { feature: "alpha", to: "testing" }), ev("tests.frozen", { feature: "alpha", files: ["a"] }), ev("feature.status", { feature: "alpha", to: "reviewing" })];
    expect(lines(events)).toEqual(["“Alpha page” is built. A second AI is reviewing it."]);
  });

  it("a detail after the last milestone of its feature stays, a milestone of another feature does not hide it", () => {
    const events = [
      ev("feature.status", { feature: "alpha", to: "testing" }),
      ev("attempt", { feature: "alpha", rung: 0, action: "build", outcome: "fail" }),
      ev("attempt", { feature: "alpha", rung: 1, action: "diagnose", outcome: "pass" }),
      ev("merge", { feature: "beta" }),
    ];
    expect(lines(events)).toEqual([
      "“Alpha page” did not pass its checks. Calling in reinforcements (step 2 of 5).",
      "An expert AI looked at why “Alpha page” keeps failing.",
      "“Beta page” is built and checked.",
    ]);
  });

  it("a stuck feature keeps its reinforcements and says it is stuck, without the earlier details", () => {
    const events = [
      ev("feature.status", { feature: "alpha", to: "testing" }),
      ev("tests.frozen", { feature: "alpha", files: ["a"] }),
      ev("attempt", { feature: "alpha", rung: 0, action: "build", outcome: "fail" }),
      ev("attempt", { feature: "alpha", rung: 1, action: "build", outcome: "fail" }),
      ev("attempt", { feature: "alpha", rung: 2, action: "diagnose", outcome: "pass" }),
      ev("feature.status", { feature: "alpha", to: "blocked", reason: "x" }),
    ];
    expect(lines(events)).toEqual([
      "“Alpha page” did not pass its checks. Calling in reinforcements (step 2 of 5).",
      "“Alpha page” did not pass its checks. Calling in reinforcements (step 3 of 5).",
      "“Alpha page” is stuck.",
    ]);
  });

  it("consecutive identical sentences of one mission are merged with a count and the first time", () => {
    const first = ev("tests.stray", { feature: "alpha" });
    const events = [first, ev("tests.stray", { feature: "alpha" }), ev("tests.stray", { feature: "alpha" }), ev("mission.retry"), ev("tests.stray", { feature: "alpha" })];
    const items = timelineOf(events).items;
    expect(items.map((i) => i.count)).toEqual([3, 1, 1]);
    expect(items[0]?.at).toBe(Date.parse(first.at));
  });

  it("two sentences that read the same but carry different notes are not merged", () => {
    const events = [ev("mission.failed", { reason: "No model could run: codex needs a new login." }), ev("mission.failed", { reason: "The wizard forgot the plan." })];
    expect(timelineOf(events).items).toHaveLength(2);
  });

  it("items of different missions are never merged, and are ordered by time (ties keep the order of the missions)", () => {
    const a = makeMission({ id: "2026-10-11-a", title: "A" });
    const b = makeMission({ id: "2026-10-11-b", title: "B" });
    const at = Date.parse("2026-10-11T09:58:10.000Z");
    const factsA = fakeFacts(a, { events: [makeEvent(a.id, at + 3000, "mission.retry"), makeEvent(a.id, at, "mission.start")] });
    const factsB = fakeFacts(b, { events: [makeEvent(b.id, at, "mission.start"), makeEvent(b.id, at + 1000, "mission.retry")] });
    const items = buildTimeline([factsA, factsB], NOW, f).items;
    expect(items.map((i) => `${i.time}:${i.text}`)).toEqual([
      "09:58:Started working on “A”.",
      "09:58:Started working on “B”.",
      "09:58:Trying “B” again.",
      "09:58:Trying “A” again.",
    ]);
    expect(items.map((i) => i.at)).toEqual([at, at, at + 1000, at + 3000]);
  });

  it("only the newest TIMELINE_MAX_ITEMS items are kept and earlierNotShown counts the rest", () => {
    const events: MissionEvent[] = [];
    for (let i = 0; i < TIMELINE_MAX_ITEMS + 10; i++) events.push(ev(i % 2 === 0 ? "mission.retry" : "mission.resume"));
    const timeline = timelineOf(events);
    expect(timeline.items).toHaveLength(TIMELINE_MAX_ITEMS);
    expect(timeline.earlierNotShown).toBe(10);
    expect(timeline.items[0]?.at).toBe(Date.parse((events[10] as MissionEvent).at));
  });

  it("nothing is cut when the night fits", () => {
    expect(timelineOf([ev("mission.retry")]).earlierNotShown).toBe(0);
  });

  it("an item has the clock time and the day of the server's zone", () => {
    const [item] = timelineOf([makeEvent(MISSION_ID, "2026-10-11T23:58:10.000Z", "mission.retry")], {}, Date.parse("2026-10-12T00:10:00.000Z")).items;
    expect(item?.time).toBe("23:58");
    expect(item?.day).toBe("Sun 11 Oct");
  });

  it("missions from before, unreadable missions and missions without events add nothing", () => {
    const events = [ev("mission.start")];
    expect(timelineOf(events, { scope: "before" }).items).toEqual([]);
    expect(timelineOf(events, { readable: false }).items).toEqual([]);
    expect(timelineOf([], {}).items).toEqual([]);
    expect(timelineOf([], { events: null }).items).toEqual([]);
  });

  it("no missions give an empty timeline", () => {
    expect(buildTimeline([], NOW, f)).toEqual({ items: [], earlierNotShown: 0 });
  });
});

describe("T-TL-AUTHOR: who wrote the note of a line", () => {
  it("an AI-written reason makes the line AI-authored; an engine sentence does not", () => {
    const aiLine = only([ev("feature.status", { feature: "alpha", to: "blocked", reason: "Ask the owner which logo to use." })]);
    expect(aiLine.author).toBe("ai");
    expect(aiLine.note?.author).toBe("ai");
    const engineLine = only([ev("feature.status", { feature: "alpha", to: "blocked", reason: "its changes conflicted with work merged earlier (merge conflict)" })]);
    expect(engineLine.author).toBe("engine");
    expect(engineLine.note?.text).toBe("Its changes clashed with work that was already put together.");
  });

  it("a line without a note is engine-written", () => {
    const item = only([ev("merge", { feature: "alpha" })]);
    expect(item.note).toBeNull();
    expect(item.author).toBe("engine");
  });

  it("a feature waiting on a stuck one reads as an engine sentence naming that feature", () => {
    const item = only([ev("feature.status", { feature: "beta", to: "blocked", reason: 'waiting on "Alpha page", which was skipped' })]);
    expect(item.note).toEqual({ text: "It needed “Alpha page”, which was left out.", author: "engine" });
  });
});

describe("the timeline of real snapshots (authentic fixtures)", () => {
  const CAPTURE_PLUS_5 = Date.parse("2026-10-11T10:03:30.000Z");
  const CAPTURE_PLUS_30S = Date.parse("2026-10-11T09:58:30.000Z");

  function timelineFrom(name: string, now: number): Timeline {
    return buildSnapshot({ home: copyHome(name), now, timeZone: "UTC" }).timeline;
  }

  it("a clean night of four features is 10 lines", () => {
    const { items } = timelineFrom("done", CAPTURE_PLUS_5);
    expect(items.map((i) => i.text)).toEqual([
      "Started working on “Habit tracker”.",
      "The plan is ready: 4 features.",
      "The app's foundation is ready.",
      "“Add and name a habit” is built and checked.",
      "“Daily check-in” is built and checked.",
      "“Streak counter” is built and checked.",
      "“Weekly streak chart” is built and checked.",
      "The building is finished. Starting the final check.",
      "The final tests of the whole app passed.",
      "Finished “Habit tracker”: done.",
    ]);
    expect(items.every((i) => i.count === 1)).toBe(true);
  });

  it("the partial night shows the reinforcements, the stuck feature and the left-out one", () => {
    const { items } = timelineFrom("partial-blocked", CAPTURE_PLUS_5);
    expect(items).toHaveLength(12);
    const texts = items.map((i) => i.text);
    expect(texts).toContain("“Sign-up page” did not pass its checks. Calling in reinforcements (step 2 of 5).");
    expect(texts).toContain("“Sign-up page” did not pass its checks. Calling in reinforcements (step 3 of 5).");
    expect(texts).toContain("“Sign-up page” is stuck.");
    expect(texts).toContain("“Paid subscription” was left out because it needed a stuck feature.");
    expect(texts.at(-1)).toBe("Finished “Members site”: partly done.");
    const stuck = items.find((i) => i.text.endsWith("is stuck."));
    expect(stuck?.author).toBe("ai");
    expect(stuck?.note?.text).toContain("which payment provider");
  });

  it.each([
    ["midrun-testing", "Started on “Add a task”."],
    ["midrun-building", "Wrote 1 check that “Add a task” must pass. The AI that builds it cannot change it."],
    ["midrun-reviewing", "“Add a task” is built. A second AI is reviewing it."],
  ])("%s is 5 lines and ends with the step in progress", (name, last) => {
    const { items } = timelineFrom(name, CAPTURE_PLUS_30S);
    expect(items).toHaveLength(5);
    expect(items.at(-1)?.text).toBe(last);
  });

  it("the night that waited for a limit tells the wait inside the finished timeline", () => {
    const { items } = timelineFrom("limit-then-done", CAPTURE_PLUS_5);
    expect(items).toHaveLength(9);
    expect(items.map((i) => i.text)).toContain("Waiting for allowance until 12:59. It resumes by itself.");
  });

  it("the failed night is 6 lines and says the mission needs help", () => {
    const { items } = timelineFrom("failed-auth", CAPTURE_PLUS_5);
    expect(items).toHaveLength(6);
    const failed = items.at(-1);
    expect(failed?.text).toBe("“Recipe box” needs your help.");
    expect(failed?.note).toEqual({ text: "A login has expired. Claude or Codex has to be logged in again on the PC.", author: "engine" });
  });

  it("the tour of every event type builds a valid timeline from the fixture", () => {
    const home = copyHome("all-event-types");
    withLock(home, { at: "2026-10-11T09:58:09.000Z", ageMs: 15_000, now: CAPTURE_PLUS_30S });
    const { items, earlierNotShown } = buildSnapshot({ home, now: CAPTURE_PLUS_5, timeZone: "UTC" }).timeline;
    expect(earlierNotShown).toBe(0);
    expect(items.length).toBeGreaterThan(30);
    expect(JSON.stringify(items)).not.toContain("do not show");
  });

  it("a home with no missions has no timeline", () => {
    expect(buildSnapshot({ home: emptyHome(), now: CAPTURE_PLUS_5, timeZone: "UTC" }).timeline).toEqual({ items: [], earlierNotShown: 0 });
  });

  it("a mission written by hand is told in the order of its events", () => {
    const home = emptyHome();
    const m = makeMission({ id: "2026-10-11-hand", title: "Hand made", status: "done", stage: "complete", updatedAt: "2026-10-11T09:59:00.000Z", features: [makeFeature({ id: "one", title: "First", status: "done" })] });
    writeMission(home, m, {
      events: [
        makeEvent(m.id, "2026-10-11T09:58:10.000Z", "mission.start", { stage: "spec" }),
        makeEvent(m.id, "2026-10-11T09:58:20.000Z", "merge", { feature: "one" }),
        makeEvent(m.id, "2026-10-11T09:58:30.000Z", "mission.end", { status: "done" }),
      ],
    });
    const { items } = buildSnapshot({ home, now: CAPTURE_PLUS_5, timeZone: "UTC" }).timeline;
    expect(items.map((i) => i.text)).toEqual(["Started working on “Hand made”.", "“First” is built and checked.", "Finished “Hand made”: done."]);
  });
});
