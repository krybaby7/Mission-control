import { describe, expect, it } from "vitest";
import {
  activityLine,
  agentRunText,
  AGENT_LABEL_KINDS,
  allDoneSentence,
  capitalise,
  CARD_TEXT,
  CLAUSE,
  concernsHappened,
  concernsOf,
  deadlineLeftText,
  decisionTitle,
  FEATURE_WORDS,
  featuresLine,
  kindWord,
  LAMP_WORDS,
  LEADER,
  LEADER_PLACEHOLDER,
  leaderHelp,
  leaderTitle,
  loginHappened,
  loginWhatToDo,
  makeFormatter,
  makeLeaderNames,
  MISSION_WORDS,
  missionSentence,
  type MissionSentenceFacts,
  nothingSentence,
  nowChecks,
  PROGRESS_WORDS,
  pageLamps,
  problemSentence,
  reasonOnHold,
  runLiveLine,
  runStoppedAnswering,
  sinceLine,
  stepsCaption,
  stuckIfNothing,
  workingSentence,
} from "./vocabulary.js";

const ch = (...codes: number[]): string => String.fromCodePoint(...codes);

describe("time", () => {
  const f = makeFormatter("UTC");
  const at = (iso: string): number => Date.parse(iso);

  it.each([
    ["2026-10-11T09:58:30.000Z", "09:58", "09:58:30", "Sun 11 Oct"],
    ["2026-10-12T00:05:09.000Z", "00:05", "00:05:09", "Mon 12 Oct"],
    ["2026-10-11T23:59:59.000Z", "23:59", "23:59:59", "Sun 11 Oct"],
    ["2026-10-15T09:00:00.000Z", "09:00", "09:00:00", "Thu 15 Oct"],
  ])("%s reads %s, %s and %s", (iso, time, clock, day) => {
    expect(f.time(at(iso))).toBe(time);
    expect(f.clock(at(iso))).toBe(clock);
    expect(f.day(at(iso))).toBe(day);
  });

  it("words a time by one rule: the clock on the day of the snapshot, else the weekday and the clock", () => {
    const now = at("2026-10-11T09:58:30.000Z");
    expect(f.when(at("2026-10-11T12:59:00.000Z"), now)).toBe("12:59");
    expect(f.when(at("2026-10-11T00:00:00.000Z"), now)).toBe("00:00");
    expect(f.when(at("2026-10-11T23:59:59.000Z"), now)).toBe("23:59");
    expect(f.when(at("2026-10-12T00:00:00.000Z"), now)).toBe("Mon 00:00");
    expect(f.when(at("2026-10-14T15:26:00.000Z"), now)).toBe("Wed 15:26");
    expect(f.when(at("2026-10-10T23:59:00.000Z"), now)).toBe("Sat 23:59");
    // Just under 6 days still names the weekday only.
    expect(f.when(at("2026-10-16T09:58:29.000Z"), now)).toBe("Fri 09:58");
  });

  // V3: a weekday alone repeats every week. From 6 days away, in either direction, the date is part of the text.
  it("adds the date from exactly 6 days away, and 8 days ahead reads 'Mon 19 Oct 10:03' and not 'Mon 10:03'", () => {
    const sunday = at("2026-10-11T10:03:00.000Z");
    expect(f.when(at("2026-10-17T10:02:59.000Z"), sunday)).toBe("Sat 10:02");
    expect(f.when(at("2026-10-17T10:03:00.000Z"), sunday)).toBe("Sat 17 Oct 10:03");
    expect(f.when(at("2026-10-18T10:03:00.000Z"), sunday)).toBe("Sun 18 Oct 10:03");
    expect(f.when(at("2026-10-19T10:03:00.000Z"), sunday)).toBe("Mon 19 Oct 10:03");
    expect(f.when(at("2026-10-19T00:00:00.000Z"), sunday)).toBe("Mon 19 Oct 00:00");
    // The same date a year on is a date too.
    expect(f.when(at("2027-10-11T09:00:00.000Z"), sunday)).toBe("Mon 11 Oct 09:00");
  });

  it("adds the date from exactly 6 days back too (the time a file last changed)", () => {
    const sunday = at("2026-10-11T10:03:00.000Z");
    expect(f.when(at("2026-10-05T10:03:01.000Z"), sunday)).toBe("Mon 10:03");
    expect(f.when(at("2026-10-05T10:03:00.000Z"), sunday)).toBe("Mon 5 Oct 10:03");
    expect(f.when(at("2026-10-01T01:38:00.000Z"), sunday)).toBe("Thu 1 Oct 01:38");
  });

  it("decides the day in the time zone it is given", () => {
    const berlin = makeFormatter("Europe/Berlin");
    // 22:30 UTC on Sunday is 00:30 on Monday in Berlin (CEST, UTC+2): not the same day as 20:00 UTC, which is 22:00 on Sunday there.
    expect(berlin.sameDay(at("2026-10-11T22:30:00.000Z"), at("2026-10-11T20:00:00.000Z"))).toBe(false);
    expect(berlin.when(at("2026-10-11T22:30:00.000Z"), at("2026-10-11T20:00:00.000Z"))).toBe("Mon 00:30");
    expect(f.when(at("2026-10-11T22:30:00.000Z"), at("2026-10-11T20:00:00.000Z"))).toBe("22:30");
    expect(f.weekday(at("2026-10-14T15:26:00.000Z"))).toBe("Wed");
  });

  it("makes no text, and does not throw, for a time a date cannot hold", () => {
    for (const bad of [8.64e15 + 1, -8.64e15 - 1, 1e20, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect([f.time(bad), f.clock(bad), f.day(bad), f.weekday(bad), f.when(bad, 0)]).toEqual(["", "", "", "", ""]);
      expect(f.sameDay(bad, 0)).toBe(false);
    }
    expect(f.when(0, 1e20)).toBe("Thu 00:00");
  });

  it("uses the time zone it is given", () => {
    expect(makeFormatter("Europe/Berlin").time(at("2026-10-11T09:58:30.000Z"))).toBe("11:58");
    expect(makeFormatter("America/Los_Angeles").day(at("2026-10-11T03:00:00.000Z"))).toBe("Sat 10 Oct");
  });

  it.each([
    [0, "0 s", "0 s ago"],
    [12_000, "12 s", "12 s ago"],
    [59_999, "59 s", "59 s ago"],
    [60_000, "1 min", "1 min ago"],
    [9 * 60_000 + 59_000, "9 min", "9 min ago"],
    [60 * 60_000, "1 h", "1 h ago"],
    [(2 * 60 + 43) * 60_000, "2 h 43 min", "2 h 43 min ago"],
    [-5000, "0 s", "0 s ago"],
  ])("%d ms is %s and %s", (ms, span, ago) => {
    expect(f.span(ms)).toBe(span);
    expect(f.ago(ms)).toBe(ago);
  });
});

describe("lamp, mission, feature and progress words", () => {
  it("are the words of the spec", () => {
    expect(LAMP_WORDS).toEqual({ on_track: "On track", needs_look: "Needs a look", needs_you_now: "Needs you now", idle: "Idle", not_responding: "Not responding" });
    expect(MISSION_WORDS).toEqual({
      not_started: "Not started",
      working: "Working",
      waiting: "Waiting",
      paused: "Paused",
      done: "Done",
      partly_done: "Partly done",
      needs_you: "Needs you",
      unknown: "Needs a look",
    });
    expect(FEATURE_WORDS).toEqual({
      waiting_turn: "Waiting its turn",
      being_built: "Being built",
      being_reviewed: "Being reviewed",
      done: "Done",
      stuck: "Stuck",
      left_out: "Left out",
      paused: "Paused",
      unknown: "Needs a look",
    });
    expect(PROGRESS_WORDS).toEqual({ plan: "Plan", plan_check: "Plan check", build: "Build", final_check: "Final check", landed: "Landed" });
    expect(kindWord("new_app")).toBe("new app");
    expect(kindWord("change")).toBe("change");
  });

  it("gives the two lamps the page applies on its own clock", () => {
    const { notUpdating, notResponding } = pageLamps();
    expect(notUpdating).toMatchObject({ state: "needs_look", word: "Needs a look", sentence: "Not updating. The page has had no news for a while." });
    expect(notUpdating.reasons.map((r) => r.code)).toEqual(["page_stale"]);
    expect(notResponding).toMatchObject({ state: "not_responding", word: "Not responding", sentence: "No news for 5 minutes. The last known state is shown greyed out." });
    expect(notResponding.reasons.map((r) => r.code)).toEqual(["no_news"]);
  });
});

describe("the mission sentence table (spec 4.6)", () => {
  const base: MissionSentenceFacts = { state: "working", stage: "features", pausedWhy: null, staleBusy: false, waitText: null, n: 4, k: 2, u: 3, d: 1, stuck: 0, leftOut: 0 };
  const row = (over: Partial<MissionSentenceFacts>, expected: string) => [over, expected] as const;

  it.each([
    row({ state: "not_started" }, "It starts with the next run."),
    row({ stage: "onboard" }, "Reading the existing project."),
    row({ stage: "spec" }, "Writing the plan."),
    row({ stage: "gate_a" }, "Checking the plan."),
    row({ stage: "init" }, "Setting up the app's foundation."),
    row({ stage: "features" }, "Building feature 2 of 4."),
    row({ stage: "features", n: 0 }, "Building the features."),
    row({ stage: "gate_c" }, "Doing the final check of the whole app."),
    row({ stage: "finalize" }, "Landing the work and writing the report."),
    row({ stage: "complete" }, "Working."),
    row({ state: "waiting", waitText: "Waiting for allowance until 12:59. It resumes by itself." }, "Waiting for allowance until 12:59. It resumes by itself."),
    row({ state: "paused", pausedWhy: "deadline", u: 3, n: 4 }, "Paused: no AI would be free before the stop time. 3 of 4 features are waiting for the next run."),
    row({ state: "paused", pausedWhy: "deadline", u: 1, n: 1 }, "Paused: no AI would be free before the stop time. 1 of 1 feature is waiting for the next run."),
    row({ state: "paused", pausedWhy: "deadline", u: 0 }, "Paused: no AI would be free before the stop time. It continues on the next run."),
    row({ state: "paused", pausedWhy: "stop_requested", u: 2, n: 4 }, "Paused because a stop was requested or the stop time came. 2 of 4 features are waiting for the next run."),
    row({ state: "paused", pausedWhy: "stop_requested", u: 0 }, "Paused because a stop was requested or the stop time came. It continues on the next run."),
    row({ state: "paused", pausedWhy: "disk" }, "Paused: the disk is almost full."),
    row({ state: "paused", pausedWhy: "ai_failing" }, "Paused: the AI team kept failing."),
    row({ state: "paused", pausedWhy: "unexpected" }, "Paused: the run stopped unexpectedly. The work so far is kept and continues on the next run."),
    row({ state: "paused", pausedWhy: "unexpected", staleBusy: true }, "Paused: its earlier run stopped unexpectedly. It continues when its turn comes."),
    row({ state: "paused", pausedWhy: "unknown" }, "Paused. It continues on the next run."),
    row({ state: "done", n: 4 }, "All 4 features are built and checked."),
    row({ state: "done", n: 1 }, "The feature is built and checked."),
    row({ state: "partly_done", n: 4, d: 4 }, "Every feature is built, but the final check left something open."),
    row({ state: "partly_done", n: 4, d: 2, stuck: 1, leftOut: 1 }, "2 of 4 features are built and checked. 1 feature is stuck. 1 feature was left out."),
    row({ state: "partly_done", n: 5, d: 2, stuck: 2, leftOut: 0 }, "2 of 5 features are built and checked. 2 features are stuck."),
    row({ state: "partly_done", n: 5, d: 2, stuck: 0, leftOut: 3 }, "2 of 5 features are built and checked. 3 features were left out."),
    row({ state: "partly_done", n: 0, d: 0 }, "Nothing was built."),
    row({ state: "needs_you" }, "It needs your help."),
    row({ state: "unknown" }, "This page does not know this state."),
  ])("%j reads: %s", (over, expected) => {
    expect(missionSentence({ ...base, ...over })).toBe(expected);
  });

  it("counts features with the right plural", () => {
    expect(featuresLine(2, 4)).toBe("2 of 4 features done");
    expect(featuresLine(1, 1)).toBe("1 of 1 feature done");
    expect(featuresLine(0, 0)).toBe("No features planned yet");
  });
});

describe("feature words", () => {
  it.each([
    [0, 0, 0, 0, "No tries yet"],
    [1, 0, 0, 1, "Tried 1 time (1 build try)"],
    [2, 1, 0, 3, "Tried 3 times (2 build tries and 1 expert diagnosis)"],
    [1, 2, 0, 3, "Tried 3 times (1 build try and 2 expert diagnoses)"],
    [1, 0, 1, 1, "Tried 1 time (1 build try, 1 fix after review)"],
    [3, 1, 2, 4, "Tried 4 times (3 build tries and 1 expert diagnosis, 2 fixes after review)"],
    [0, 0, 1, 0, "Tried 0 times (1 fix after review)"],
  ])("%d builds, %d diagnoses and %d fixes read: %s", (builds, diagnoses, fixes, used, expected) => {
    expect(stepsCaption(builds, diagnoses, fixes, used)).toBe(expected);
  });

  it("explains a feature on hold by the cause of the wait", () => {
    expect(reasonOnHold("limits", "12:59")).toBe("On hold until 12:59, waiting for allowance.");
    expect(reasonOnHold("login", "12:59")).toBe("On hold until 12:59, waiting for allowance.");
    expect(reasonOnHold("trouble", "12:59")).toBe("On hold until 12:59, waiting for the AI team.");
    expect(reasonOnHold("unknown", "12:59")).toBe("On hold. Mission Control cannot tell why.");
    expect(reasonOnHold("limits", "")).toBe("On hold. Mission Control cannot tell why.");
  });
});

describe("the now line and the run line", () => {
  it.each([
    ["onboard", null, "An AI is reading the existing project"],
    ["spec", null, "An AI is writing the plan"],
    ["gate-a", null, "A second AI is checking the plan"],
    ["init", null, "An AI is setting up the app's foundation"],
    ["gate-c", null, "A second AI is doing the final check of the whole app"],
    ["report-prose", null, "A helper AI is writing the report"],
    ["test", "Add a task", "An AI is writing the checks for “Add a task”"],
    ["build", "Add a task", "An AI is building “Add a task”"],
    ["review", "Add a task", "A second AI is reviewing “Add a task”"],
    ["fix", "Add a task", "An AI is fixing what the review found in “Add a task”"],
    ["diagnose", "Add a task", "An expert AI is working out why “Add a task” keeps failing"],
    ["context", "Add a task", "A helper AI is reading up on “Add a task”"],
    ["digest", "Add a task", "A helper AI is summarising why “Add a task” failed"],
    ["build", null, "An AI is building a feature"],
    ["other", null, "An AI is working"],
  ] as const)("the %s run on %s reads: %s", (kind, title, expected) => {
    expect(agentRunText(kind, title)).toBe(expected);
  });

  it("has a text for every kind of label", () => {
    for (const kind of AGENT_LABEL_KINDS) expect(agentRunText(kind, "F")).toMatch(/^An? (second |expert |helper )?AI is /);
  });

  it("words the steps between runs", () => {
    expect(nowChecks("Add a task")).toBe("Running the checks on “Add a task”");
    expect(sinceLine(makeFormatter("UTC"), 9 * 60_000)).toBe("9 min so far");
  });

  it("words the run line", () => {
    expect(runLiveLine({ title: "Habit tracker", kindWord: "new app", runningText: "2 h 43 min", deadline: { atText: "07:00", leftText: "5 h 19 min left" } })).toBe(
      "Habit tracker (new app), running 2 h 43 min, stops 07:00 (5 h 19 min left)",
    );
    expect(runLiveLine({ title: "Habit tracker", kindWord: "new app", runningText: "10 s", deadline: null })).toBe("Habit tracker (new app), running 10 s");
    expect(runLiveLine({ title: null, kindWord: "", runningText: "3 min", deadline: null })).toBe("A run is on, between missions, running 3 min");
    expect(runLiveLine({ title: "X", kindWord: "change", runningText: null, deadline: null })).toBe("X (change)");
    expect(runStoppedAnswering("03:12")).toBe("The last run stopped answering at 03:12.");
    expect(activityLine("2 min ago")).toBe("Last activity 2 min ago");
    expect(deadlineLeftText(makeFormatter("UTC"), (5 * 60 + 19) * 60_000)).toBe("5 h 19 min left");
    expect(deadlineLeftText(makeFormatter("UTC"), -1)).toBe("past the stop time");
    // At the stop time itself there is nothing left, but it is not yet past (N10).
    expect(deadlineLeftText(makeFormatter("UTC"), 0)).toBe("0 s left");
    expect(deadlineLeftText(makeFormatter("UTC"), 999)).toBe("0 s left");
  });
});

describe("lamp clauses and sentences", () => {
  it("builds clauses that have no semicolon and no inner 'and'", () => {
    const clauses = [
      CLAUSE.missionFailed(1, "Recipe box"),
      CLAUSE.missionFailed(3, null),
      CLAUSE.runGone,
      CLAUSE.runGonePending,
      CLAUSE.homeUnreadable,
      CLAUSE.unreadableMissions(1),
      CLAUSE.unreadableMissions(4),
      CLAUSE.unknownState,
      CLAUSE.pausedDisk,
      CLAUSE.pausedAiFailing,
      CLAUSE.stuck(1),
      CLAUSE.stuck(3),
      CLAUSE.leftOut(1),
      CLAUSE.leftOut(2),
      CLAUSE.questions(1),
      CLAUSE.questions(2),
      CLAUSE.login,
      CLAUSE.checksFailing,
      CLAUSE.pausedUnbuilt(2, 4, 1),
      CLAUSE.pausedUnbuilt(0, 4, 1),
      CLAUSE.pausedUnbuilt(0, 4, 3),
      CLAUSE.partial("Members site"),
      CLAUSE.earlierFailed(1),
      CLAUSE.earlierFailed(2),
      CLAUSE.waitUnknown,
      CLAUSE.waitUntil("limits", "12:59"),
      CLAUSE.waitUntil("trouble", "12:59"),
      CLAUSE.heartbeatLate(3),
      CLAUSE.quiet(55),
      CLAUSE.stopRequested,
      CLAUSE.queued(1),
      CLAUSE.queued(2),
      CLAUSE.earlierItems(1),
      CLAUSE.earlierItems(2),
    ];
    for (const clause of clauses) {
      expect(clause).not.toContain(";");
      expect(clause).not.toContain(" and ");
      expect(clause).not.toMatch(/\.$/);
    }
  });

  it("reads each clause as the spec words it", () => {
    expect(CLAUSE.missionFailed(1, "Recipe box")).toBe("“Recipe box” needs your help");
    expect(CLAUSE.missionFailed(2, "x")).toBe("2 missions need your help");
    expect(CLAUSE.unreadableMissions(1)).toBe("1 mission file cannot be read");
    expect(CLAUSE.unreadableMissions(2)).toBe("2 mission files cannot be read");
    expect(CLAUSE.stuck(1)).toBe("1 feature is stuck");
    expect(CLAUSE.leftOut(2)).toBe("2 features were left out");
    expect(CLAUSE.questions(2)).toBe("2 questions are waiting for you");
    expect(CLAUSE.pausedUnbuilt(2, 4, 1)).toBe("2 of 4 features are waiting for the next run");
    expect(CLAUSE.pausedUnbuilt(1, 1, 1)).toBe("1 of 1 feature is waiting for the next run");
    expect(CLAUSE.pausedUnbuilt(0, 4, 1)).toBe("1 mission is paused until the next run");
    expect(CLAUSE.pausedUnbuilt(0, 4, 2)).toBe("2 missions are paused until the next run");
    expect(CLAUSE.waitUntil("limits", "12:59")).toBe("waiting for allowance until 12:59");
    expect(CLAUSE.waitUntil("trouble", "12:59")).toBe("waiting for the AI team until 12:59");
    expect(CLAUSE.heartbeatLate(3)).toBe("the run has not reported in for 3 min");
    expect(CLAUSE.earlierFailed(1)).toBe("1 earlier mission needs your help");
  });

  it("capitalises only a lowercase first letter", () => {
    expect(capitalise("waiting for allowance")).toBe("Waiting for allowance");
    expect(capitalise("“Recipe box” needs your help")).toBe("“Recipe box” needs your help");
    expect(capitalise("1 feature is stuck")).toBe("1 feature is stuck");
  });

  it("joins one, two and three or more clauses", () => {
    expect(problemSentence(["1 feature is stuck"], false)).toBe("1 feature is stuck.");
    expect(problemSentence(["“Recipe box” needs your help", "1 feature is stuck"], false)).toBe("“Recipe box” needs your help and 1 feature is stuck.");
    expect(problemSentence(["a", "b", "c"], true)).toBe("A and b. 1 more thing needs a look.");
    expect(problemSentence(["a", "b", "c", "d", "e"], false)).toBe("A and b. 3 more things need a look.");
    expect(problemSentence(["1 feature is stuck"], true)).toBe("1 feature is stuck. The rest is on track.");
    expect(problemSentence(["a", "b"], true)).toBe("A and b. The rest is on track.");
    expect(problemSentence([], false)).toBe("");
  });

  it("says that a wait of known cause resumes by itself, only when it is the one clause (M5)", () => {
    const wait = CLAUSE.waitUntil("limits", "Wed 15:26");
    expect(problemSentence([wait], false, true)).toBe("Waiting for allowance until Wed 15:26. It resumes by itself.");
    expect(problemSentence([CLAUSE.waitUntil("trouble", "12:59")], false, true)).toBe("Waiting for the AI team until 12:59. It resumes by itself.");
    // With another problem next to it, "it" would not be clear: no tail.
    expect(problemSentence([CLAUSE.stuck(1), wait], false, true)).toBe("1 feature is stuck and waiting for allowance until Wed 15:26.");
    expect(problemSentence([wait], false, false)).toBe("Waiting for allowance until Wed 15:26.");
  });

  it("does not take a stage that came from a file for a table entry (m2)", () => {
    const base: MissionSentenceFacts = { state: "working", stage: "features", pausedWhy: null, staleBusy: false, waitText: null, n: 4, k: 2, u: 3, d: 1, stuck: 0, leftOut: 0 };
    for (const stage of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) expect(missionSentence({ ...base, stage })).toBe("Working.");
  });

  it.each([
    [{ done: 0, total: 0 }, "Working on the plan. Nothing needs you."],
    [{ done: 0, total: 1 }, "The feature is being worked on. Nothing needs you."],
    [{ done: 1, total: 1 }, "The feature is done. The final steps are running. Nothing needs you."],
    [{ done: 0, total: 4 }, "4 features planned. No problems so far. Nothing needs you."],
    [{ done: 2, total: 4 }, "2 of 4 features done. No problems so far. Nothing needs you."],
    [{ done: 4, total: 4 }, "All 4 features done. The final steps are running. Nothing needs you."],
    [{ done: 2, total: 4, shortWait: { cause: "limits" as const, untilText: "12:59" } }, "2 of 4 features done. No problems so far. Waiting for allowance until 12:59. It resumes by itself. Nothing needs you."],
    [{ done: 2, total: 4, shortWait: { cause: "trouble" as const, untilText: "10:13" } }, "2 of 4 features done. No problems so far. Waiting for the AI team to respond until 10:13. It resumes by itself. Nothing needs you."],
    [{ done: 2, total: 4, earlierWaiting: 1 }, "2 of 4 features done. No problems so far. Nothing new needs you. 1 earlier mission still waits for you (see below)."],
    [{ done: 2, total: 4, earlierWaiting: 3 }, "2 of 4 features done. No problems so far. Nothing new needs you. 3 earlier missions still wait for you (see below)."],
  ])("the working sentence for %j", (facts, expected) => {
    expect(workingSentence({ shortWait: null, earlierWaiting: 0, queued: 0, ...facts })).toBe(expected);
  });

  it("the all-done sentence", () => {
    const base = { done: 4, total: 4, shortWait: null, earlierWaiting: 0, queued: 0, missions: 1 };
    expect(allDoneSentence(base)).toBe("All 4 features are done. Nothing needs you.");
    expect(allDoneSentence({ ...base, total: 1 })).toBe("The feature is done. Nothing needs you.");
    expect(allDoneSentence({ ...base, missions: 3, total: 9 })).toBe("Everything is done: 3 missions, 9 features. Nothing needs you.");
    expect(allDoneSentence({ ...base, queued: 1 })).toBe("All 4 features are done. Nothing needs you. 1 more mission waits for the next run.");
    expect(allDoneSentence({ ...base, queued: 2, earlierWaiting: 1 })).toBe(
      "All 4 features are done. Nothing new needs you. 1 earlier mission still waits for you (see below). 2 more missions wait for the next run.",
    );
  });

  it("the nothing-running sentence", () => {
    expect(nothingSentence({ queued: 0, earlierWaiting: 0, otherEarlier: 0 })).toBe("Nothing is running and nothing is queued.");
    expect(nothingSentence({ queued: 1, earlierWaiting: 0, otherEarlier: 0 })).toBe("Nothing is running. 1 mission waits for the next run.");
    expect(nothingSentence({ queued: 2, earlierWaiting: 0, otherEarlier: 0 })).toBe("Nothing is running. 2 missions wait for the next run.");
    expect(nothingSentence({ queued: 0, earlierWaiting: 2, otherEarlier: 0 })).toBe("Nothing is running. 2 earlier missions still wait for you (see below).");
    expect(nothingSentence({ queued: 0, earlierWaiting: 0, otherEarlier: 1 })).toBe("Nothing is running. 1 earlier mission waits for the next run (see below).");
    expect(nothingSentence({ queued: 1, earlierWaiting: 1, otherEarlier: 2 })).toBe(
      "Nothing is running. 1 mission waits for the next run. 1 earlier mission still waits for you (see below). 2 earlier missions wait for the next run (see below).",
    );
  });
});

describe("card words", () => {
  it("titles", () => {
    expect(CARD_TEXT.failedTitle("Recipe box", false)).toBe("“Recipe box” needs your help");
    expect(CARD_TEXT.failedTitle("Recipe box", true)).toBe("“Recipe box” still needs your help");
    expect(CARD_TEXT.stoppedTitle("X")).toBe("“X” stopped unexpectedly");
    expect(CARD_TEXT.pausedTitle("X")).toBe("“X” is paused");
    expect(CARD_TEXT.stuckTitle("Sign-up page")).toBe("“Sign-up page” is stuck");
    expect(CARD_TEXT.checksTitle("Old shop")).toBe("“Old shop”: the project's own checks were already failing");
    expect(CARD_TEXT.loginTitle).toBe("One AI needs a new login");
    expect(decisionTitle("question", 1, 1)).toBe("A question for you");
    expect(decisionTitle("question", 2, 3)).toBe("A question for you (2 of 3)");
    expect(decisionTitle("concerns", 1, 2)).toBe("Have someone check the app (1 of 2)");
    expect(decisionTitle("concerns", 1, 1)).toBe("Have someone check the app");
  });

  it("what happens if nobody does anything for a stuck feature", () => {
    expect(stuckIfNothing("carries_on", [])).toBe("The rest carries on. This feature stays out, and the mission ends Partly done.");
    expect(stuckIfNothing("stopped", [])).toBe("The mission has stopped, so nothing carries on until it is restarted.");
    expect(stuckIfNothing("finished", [])).toBe("It stays out. Nothing tries it again unless you ask.");
    expect(stuckIfNothing("unknown", [])).toBe("Mission Control cannot tell what happens next.");
    expect(stuckIfNothing("carries_on", ["Welcome email"])).toBe("The rest carries on. This feature stays out, and the mission ends Partly done. “Welcome email” needed it, so that stays out too.");
    expect(stuckIfNothing("finished", ["A", "B"])).toBe("It stays out. Nothing tries it again unless you ask. “A” and “B” needed it, so those stay out too.");
    expect(stuckIfNothing("finished", ["A", "B", "C"])).toBe("It stays out. Nothing tries it again unless you ask. 3 features needed it, so those stay out too.");
  });

  it("the login card", () => {
    expect(loginHappened(["Claude"], "12:59")).toBe("Claude needs a new login on the PC. The run is waiting until 12:59 and then carries on with the other AI.");
    expect(loginHappened(["Claude", "Codex"], "12:59")).toBe("Claude and Codex need a new login on the PC. The run is waiting until 12:59 and then carries on with the other AI.");
    expect(loginHappened([], "12:59")).toBe("One AI needs a new login on the PC. The run is waiting until 12:59 and then carries on with the other AI.");
    expect(loginHappened(["Claude"], "Wed 15:26")).toBe("Claude needs a new login on the PC. The run is waiting until Wed 15:26 and then carries on with the other AI.");
    expect(loginHappened(["Claude"], "")).toBe("Claude needs a new login on the PC.");
  });

  it("the login card uses the glossary word: the run is waiting, never asleep (m14)", () => {
    for (const text of [loginHappened(["Claude"], "12:59"), loginHappened([], "12:59")]) expect(text).not.toMatch(/asleep|sleep/i);
  });

  it("what a person does about a login", () => {
    expect(loginWhatToDo(["Claude"])).toBe("Log in again to Claude on the PC, then tell the leader.");
    expect(loginWhatToDo(["Claude", "Codex"])).toBe("Log in again to Claude and Codex on the PC, then tell the leader.");
    expect(loginWhatToDo([])).toBe("Log in again on the PC to the AI that needs it, then tell the leader.");
  });

  it("the other what-to-do and if-nothing sentences are plain and name nobody", () => {
    for (const text of [CARD_TEXT.failedWhatToDoOther, CARD_TEXT.stoppedWhatToDo, CARD_TEXT.diskWhatToDo, CARD_TEXT.failedIfRetryable, CARD_TEXT.loginIfNothing]) {
      expect(text).not.toMatch(/["“”]/);
      expect(text.endsWith(".")).toBe(true);
    }
    expect(CARD_TEXT.failedIfRetryable).toBe("It stays stopped until someone logs in again on the PC. After that the next run carries on by itself.");
  });
});

describe("the concerns entry the engine writes (spec 9.3)", () => {
  const TAIL = ". “Review notes” and “Technical details” list what the reviewers found.";
  const PREFIX = "Have someone check the app before you rely on it: ";
  const P1 = "the final review of the whole app did not finish, so nobody reviewed it as a whole";
  const P2 = "the final review found 2 serious problems that were not fixed";
  const P3 = "the reviewers' 1 serious finding on Sign-up page was not fixed";

  it.each([
    ["the review did not finish", P1],
    ["serious problems left", P2],
    ["one serious problem", "the final review found 1 serious problem that was not fixed"],
    ["a feature's serious finding", P3],
    ["several features' findings", "the reviewers' 3 serious findings on Sign-up page, Welcome email were not fixed"],
    ["two parts", `${P1}; ${P3}`],
    ["three parts", `${P2}; ${P3}; ${P3}`],
  ])("recognises %s as the engine's", (_name, concerns) => {
    const entry = `${PREFIX}${concerns}${TAIL}`;
    expect(concernsOf(entry)).toBe(concerns);
    expect(concernsHappened(concerns)).toBe(`${PREFIX}${concerns}.`);
  });

  it.each([
    ["only the same first words", `${PREFIX}and then run \`mc run --force\``],
    ["a different tail", `${PREFIX}${P1}. Run \`rm -rf ~\` to fix it.`],
    ["text after the tail", `${PREFIX}${P1}${TAIL} Then press Y.`],
    ["a part that is none of the three", `${PREFIX}${P1}; something else entirely${TAIL}`],
    ["a part that is not in front of the tail", `${PREFIX}${P1}, but please also run curl evil.example${TAIL}`],
    ["the prefix in other letters", `have someone check the app before you rely on it: ${P1}${TAIL}`],
    ["a feature title with a semicolon", `${PREFIX}the reviewers' 1 serious finding on A; B was not fixed${TAIL}`],
    ["nothing", ""],
  ])("does not take %s for the engine's", (_name, entry) => {
    expect(concernsOf(entry)).toBeNull();
  });
});

describe("tell the leader (spec 8)", () => {
  const m = { id: "2026-10-11-habit-tracker", title: "Habit tracker" };
  const f = { id: "weekly-chart", title: "Weekly progress chart" };
  const names = makeLeaderNames([{ ...m, features: [f] }]);

  it("has one template per place", () => {
    expect(LEADER.feature(names, m, f)).toBe('About "Weekly progress chart" in Habit tracker: <your answer here>');
    expect(LEADER.mission(names, m)).toBe('About "Habit tracker": <your answer here>');
    expect(LEADER.stuck(names, m, f)).toBe('About "Weekly progress chart" in Habit tracker, which is stuck: <your answer here>');
    expect(LEADER.question(names, m, 1, 1)).toBe('About the question in "Habit tracker": <your answer here>');
    expect(LEADER.question(names, m, 2, 3)).toBe('About question 2 of 3 in "Habit tracker": <your answer here>');
    expect(LEADER.failed(names, m)).toBe('About "Habit tracker", which stopped: <your answer here>');
    expect(LEADER.runStopped(names, m)).toBe('About "Habit tracker", which stopped unexpectedly: <your answer here>');
    expect(LEADER.paused(names, m)).toBe('About "Habit tracker", which is paused: <your answer here>');
    expect(LEADER.checks(names, m)).toBe('About "Habit tracker", whose own checks were already failing: <your answer here>');
    expect(LEADER.login(names, m)).toBe('About the login that expired during "Habit tracker": <your answer here>');
    expect(LEADER_PLACEHOLDER).toBe("<your answer here>");
  });

  it("replaces a double quote in a title, so the sentence keeps one clean quote", () => {
    expect(leaderTitle('The "big" one')).toBe("The 'big' one");
    const odd = makeLeaderNames([{ id: "x", title: 'The "big" one', features: [] }]);
    expect(LEADER.mission(odd, { id: "x", title: 'The "big" one' })).toBe(`About "The 'big' one": <your answer here>`);
  });

  it("adds the mission id only when two missions share a title", () => {
    const two = makeLeaderNames([
      { id: "2026-10-11-habit-tracker", title: "Habit tracker", features: [f] },
      { id: "2026-10-11-habit-tracker-2", title: "Habit tracker", features: [f] },
    ]);
    expect(LEADER.mission(two, { id: "2026-10-11-habit-tracker-2", title: "Habit tracker" })).toBe('About "Habit tracker" (mission 2026-10-11-habit-tracker-2): <your answer here>');
    expect(LEADER.feature(two, { id: "2026-10-11-habit-tracker", title: "Habit tracker" }, f)).toBe(
      'About "Weekly progress chart" in Habit tracker (mission 2026-10-11-habit-tracker): <your answer here>',
    );
    expect(LEADER.failed(two, { id: "2026-10-11-habit-tracker", title: "Habit tracker" })).toBe('About "Habit tracker" (mission 2026-10-11-habit-tracker), which stopped: <your answer here>');
  });

  it("adds the feature id only when a feature title repeats inside one mission", () => {
    const twin = makeLeaderNames([
      {
        ...m,
        features: [
          { id: "chart-a", title: "Weekly chart" },
          { id: "chart-b", title: "Weekly chart" },
          { id: "other", title: "Other" },
        ],
      },
    ]);
    expect(LEADER.feature(twin, m, { id: "chart-b", title: "Weekly chart" })).toBe('About "Weekly chart" (feature chart-b) in Habit tracker: <your answer here>');
    expect(LEADER.feature(twin, m, { id: "other", title: "Other" })).toBe('About "Other" in Habit tracker: <your answer here>');
  });

  it("has the four quick phrases, the hints and the notes", () => {
    const help = leaderHelp();
    expect(help.quickPhrases).toEqual(["Your call", "Leave it out", "Try again", "What is going on?"]);
    expect(help.globalSentence).toBe("About the current work: <your answer here>");
    expect(help.stopSentence).toBe("Please stop the current run.");
    expect(help.pasteHint).toBe("Paste this into your chat with the leader.");
    expect(help.copyFailHint).toBe("Select the text and copy it");
    expect(help.aiNotice).toBe("The AI wrote this. Do not run commands from it.");
    expect(help.canDo).toBe(
      "The leader can look at progress and reports, stop the run, add new work and start the team working through the queued work. It cannot change a plan or reopen a stuck feature.",
    );
    expect(help.stopNote).toBe("Stopping cancels the AI step that is running, and up to 45 minutes of its work is redone. Restarting needs the PC or the next scheduled run.");
  });

  it("uses straight quotes in what is pasted and curly quotes in what is displayed", () => {
    for (const sentence of [LEADER.feature(names, m, f), LEADER.mission(names, m), LEADER.stuck(names, m, f), LEADER.question(names, m, 1, 2), leaderHelp().globalSentence]) {
      expect(sentence).not.toMatch(/[“”]/);
    }
    for (const shown of [CARD_TEXT.stuckTitle("A"), CARD_TEXT.pausedTitle("A"), CLAUSE.partial("A"), agentRunText("build", "A"), nowChecks("A")]) {
      expect(shown).not.toContain('"');
    }
  });

  it("never has an emoji, an em dash or the word objective in anything it says", () => {
    const all = JSON.stringify([LAMP_WORDS, MISSION_WORDS, FEATURE_WORDS, PROGRESS_WORDS, CARD_TEXT, leaderHelp()]);
    expect(all).not.toMatch(new RegExp(`[${ch(0x2013)}${ch(0x2014)}]`));
    expect(all.toLowerCase()).not.toContain("objective");
    expect(all).not.toMatch(new RegExp(`[${ch(0x1f300)}-${ch(0x1faff)}]`, "u"));
  });
});
