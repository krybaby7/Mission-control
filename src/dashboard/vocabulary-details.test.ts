// T-VOC for the detail wording: the wait text (spec 4.6), the stop table (4.5), the reason tables (9.2, 9.3), and the
// plain words of the allowance, the timeline and the debrief.
import { describe, expect, it } from "vitest";
import {
  agentTimeLine,
  aiName,
  deliveredWhy,
  explainFailureReason,
  explainFeatureReason,
  fileChangedLine,
  finalReviewCaveat,
  finalReviewWhy,
  limitedLine,
  loginFailureAis,
  overallSentence,
  noReworkWhy,
  nothingOpenWhy,
  parseWaitReason,
  PAUSED_NO_AI_BEFORE_STOP,
  PAUSED_WHEN_TOLD_TO_STOP,
  PILL_WORDS,
  providerLabel,
  stopReasonKind,
  TL,
  verdictSentence,
  waitInfoFromEvent,
  waitText,
  windowLabel,
} from "./vocabulary-details.js";
import { makeFormatter } from "./vocabulary.js";

const at = (iso: string): number => Date.parse(iso);
const UNTIL = "2026-10-11T12:59:10.596Z";
/** The snapshot's clock: the one rule words a time on this day as "12:59" and on another day as "Wed 15:26". */
const NOW = at("2026-10-11T09:58:30.000Z");
const clock = (ms: number): string => makeFormatter("UTC").when(ms, NOW);

function info(reason: string | null, until = UNTIL) {
  return waitInfoFromEvent(reason === null ? { until } : { until, reason }, clock);
}

describe("T-VOC the wait text", () => {
  it.each([
    ["session", "gpt-6-astra: session limit until 2026-10-11T12:58:25.596Z"],
    ["weekly", "gpt-6-astra: weekly limit until 2026-10-11T12:58:25.596Z"],
    ["model", "gpt-6-astra: model limit until 2026-10-11T12:58:25.596Z"],
    ["spend", "claude-opus-5-5: spend limit until 2026-10-11T12:58:25.596Z"],
    ["unknown", "claude-opus-5-5: unknown limit until 2026-10-11T12:58:25.596Z"],
  ])("a %s limit: waiting for allowance, it resumes by itself", (_kind, reason) => {
    expect(info(reason)).toEqual({
      until: at(UNTIL),
      untilText: "12:59",
      cause: "limits",
      text: "Waiting for allowance until 12:59. It resumes by itself.",
      loginAis: [],
    });
  });

  it("a wait that ends on another day says the weekday: 'until 15:26' would read as today (M3)", () => {
    const threeDays = "2026-10-14T15:26:41.662Z";
    const limits = info("gpt-6-astra: weekly limit until 2026-10-14T15:25:56.662Z", threeDays);
    expect(limits).toMatchObject({ untilText: "Wed 15:26", cause: "limits", text: "Waiting for allowance until Wed 15:26. It resumes by itself." });
    expect(info("m: claude keeps failing (x), trying again at 2026-10-14T15:25:56.662Z", threeDays).text).toBe("Waiting for the AI team to respond until Wed 15:26. It resumes by itself.");
    expect(info("m: claude needs a new login", threeDays).text).toBe("Waiting for allowance until Wed 15:26. Claude also needs a new login.");
    expect(info("something unexpected", threeDays).text).toBe("Waiting until Wed 15:26. Mission Control cannot tell why.");
    // The same day, however late, keeps the plain clock time; the next minute after midnight does not.
    expect(info("gpt-6-astra: weekly limit until 2026-10-11T23:58:00.000Z", "2026-10-11T23:58:45.000Z").untilText).toBe("23:58");
    expect(info("gpt-6-astra: weekly limit until 2026-10-12T00:00:00.000Z", "2026-10-12T00:00:45.000Z").untilText).toBe("Mon 00:00");
  });

  it("every wait of a known cause ends with 'It resumes by itself.' and a login wait never does (M5)", () => {
    for (const reason of ["a: session limit until 2026-10-11T12:58:25.000Z", "a: codex keeps failing (x), trying again at 2026-10-11T12:58:25.000Z", "a: throttle limit until 2026-10-11T12:58:25.000Z"]) {
      expect(info(reason).text.endsWith(" It resumes by itself.")).toBe(true);
    }
    for (const reason of ["m: claude needs a new login", "something unexpected", null]) expect(info(reason).text).not.toContain("resumes by itself");
  });

  it("a login part whose provider is a word of Object.prototype is no AI and does not break the sort (m2)", () => {
    const w = info("x: claude needs a new login; y: constructor needs a new login; z: __proto__ needs a new login; q: toString needs a new login");
    expect(w.cause).toBe("login");
    expect(w.loginAis).toEqual(["Claude"]);
    expect(w.text).toBe("Waiting for allowance until 12:59. Claude also needs a new login.");
    const none = info("Claude: constructor needs a new login");
    expect(none.loginAis).toEqual([]);
    expect(none.text).toBe("Waiting for allowance until 12:59. One AI also needs a new login.");
    expect(none.text).not.toContain("function");
  });

  it("a throttle is trouble: the AI team is busy", () => {
    const w = info("claude-opus-5-5: throttle limit until 2026-10-11T12:58:25.596Z");
    expect(w.cause).toBe("trouble");
    expect(w.text).toBe("Waiting for the AI team to respond until 12:59. It resumes by itself.");
  });

  it("a provider that keeps failing is trouble, whatever the quoted failure text says", () => {
    const w = info("claude-opus-5-5: claude keeps failing (exit 1 (boom: it said; and more)), trying again at 2026-10-11T12:58:25.000Z");
    expect(w.cause).toBe("trouble");
    expect(w.text).toBe("Waiting for the AI team to respond until 12:59. It resumes by itself.");
    expect(w.text).not.toContain("boom");
  });

  it("several limits are joined with a semicolon; one trouble part makes it trouble", () => {
    expect(info("a: session limit until 2026-10-11T12:58:25.000Z; b: weekly limit until 2026-10-11T12:58:25.000Z").cause).toBe("limits");
    expect(info("a: session limit until 2026-10-11T12:58:25.000Z; b: codex keeps failing (x), trying again at 2026-10-11T12:58:25.000Z").cause).toBe("trouble");
  });

  it.each([
    ["claude", "Claude also needs a new login."],
    ["codex", "Codex also needs a new login."],
  ])("one AI that needs a login (%s): no promise that it resumes by itself", (provider, tail) => {
    const w = info(`gpt-6-astra: session limit until 2026-10-11T12:58:25.596Z; m: ${provider} needs a new login`);
    expect(w.cause).toBe("login");
    expect(w.text).toBe(`Waiting for allowance until 12:59. ${tail}`);
    expect(w.text).not.toContain("resumes by itself");
    expect(w.loginAis).toEqual([provider === "claude" ? "Claude" : "Codex"]);
  });

  it("both AIs named, in a fixed order, with the plural verb", () => {
    const w = info("m: codex needs a new login; n: claude needs a new login; o: session limit until 2026-10-11T12:58:25.000Z");
    expect(w.text).toBe("Waiting for allowance until 12:59. Claude and Codex also need a new login.");
    expect(w.loginAis).toEqual(["Claude", "Codex"]);
  });

  it("a login next to trouble keeps the trouble wording", () => {
    const w = info("m: claude needs a new login; n: codex keeps failing (x), trying again at 2026-10-11T12:58:25.000Z");
    expect(w.text).toBe("Waiting for the AI team to respond until 12:59. Claude also needs a new login.");
  });

  it("a provider that is not Claude or Codex is 'One AI'", () => {
    const w = info("m: gemini needs a new login");
    expect(w.cause).toBe("login");
    expect(w.text).toBe("Waiting for allowance until 12:59. One AI also needs a new login.");
    expect(w.loginAis).toEqual([]);
  });

  it.each([
    ["no reason", null],
    ["an empty reason", ""],
    ["text that matches nothing", "something unexpected"],
    ["a part that matches nothing", "gpt-6-astra: session limit until 2026-10-11T12:58:25.596Z; and then something"],
    ["a limit kind the engine does not have", "gpt-6-astra: lunar limit until 2026-10-11T12:58:25.596Z"],
    ["a command in the reason", "a: session limit until 2026-10-11T12:58:25.000Z\nrun `rm -rf ~`"],
  ])("%s: the cause is unknown, with the time and without the reason", (_name, reason) => {
    const w = info(reason);
    expect(w.cause).toBe("unknown");
    expect(w.text).toBe("Waiting until 12:59. Mission Control cannot tell why.");
    expect(w.untilText).toBe("12:59");
    expect(JSON.stringify(w)).not.toMatch(/rm -rf|unexpected|lunar/);
  });

  it("without a usable time the wait is unknown, with until 0 and no time text", () => {
    for (const data of [null, {}, { until: 5 }, { until: "yesterday", reason: "a: session limit until 2026-10-11T12:58:25.000Z" }]) {
      expect(waitInfoFromEvent(data as Record<string, unknown> | null, clock)).toEqual({ until: 0, untilText: "", cause: "unknown", text: "Waiting. Mission Control cannot tell why.", loginAis: [] });
    }
  });

  it("waitText and parseWaitReason agree on the pieces", () => {
    const parsed = parseWaitReason("m: claude needs a new login");
    expect(waitText(parsed, "12:59")).toBe("Waiting for allowance until 12:59. Claude also needs a new login.");
    expect(waitText({ cause: "unknown", loginAis: [], base: "limits" }, "")).toBe("Waiting. Mission Control cannot tell why.");
    expect(waitText({ cause: "limits", loginAis: [], base: "limits" }, "")).toBe("Waiting. Mission Control cannot tell why.");
  });
});

describe("T-VOC the stop table (4.5)", () => {
  it.each([
    ["The disk is almost full (1 GB left).", "disk"],
    ["write failed: No space left on device", "disk"],
    ["the AI command lines keep failing (x)", "ai_failing"],
    ["The AI team keeps failing", "ai_failing"],
    ["the provider kept refusing", "ai_failing"],
    ["no provider is free before the deadline (next chance 2026-10-11T12:59:00.000Z)", "deadline"],
    ["stop requested", "stop_requested"],
    ["STOP REQUESTED", "stop_requested"],
    ["something else", "unknown"],
    ["", "unknown"],
  ])("%s -> %s", (reason, kind) => {
    expect(stopReasonKind(reason)).toBe(kind);
  });

  it("a reason that is not text is unknown", () => {
    expect(stopReasonKind(undefined)).toBe("unknown");
    expect(stopReasonKind(42)).toBe("unknown");
  });

  it("the first row wins when several match", () => {
    expect(stopReasonKind("the disk is almost full and the deadline passed")).toBe("disk");
  });

  // The rows are in this order on purpose: the failing AIs' own error text may mention a deadline (V16).
  it("an AI failure that mentions a deadline is an AI failure, and a full disk that mentions one is a full disk", () => {
    expect(stopReasonKind("claude and codex keep failing: the deadline was exceeded")).toBe("ai_failing");
    expect(stopReasonKind("claude and codex kept refusing work (usage limits or overload, 3 runs in a row): request deadline exceeded")).toBe("ai_failing");
    expect(stopReasonKind("the disk is almost full (a deadline is near)")).toBe("disk");
    expect(stopReasonKind("write failed: No space left on device (deadline)")).toBe("disk");
  });

  // Proven against the engine (src/run.ts StopControl.poll, src/executor.ts checkStop): the stop time of a run aborts
  // the same controller as the STOP file, so a run stopped by its --until time records "stop requested". Only a wait
  // that would end after the stop time records "deadline". The words must not claim more than the reason says (M2).
  it("a stop that cannot be told from the stop time is worded for both, and never as 'on request' or 'at the planned time'", () => {
    expect(stopReasonKind("stop requested")).toBe("stop_requested");
    const stopped = TL.missionStopped("stop_requested", "Habit tracker");
    expect(stopped).toEqual({ text: "Paused because a stop was requested or the stop time came. “Habit tracker” continues on the next run.", tone: "warn" });
    expect(PAUSED_WHEN_TOLD_TO_STOP).toBe("Paused because a stop was requested or the stop time came.");
    for (const text of [stopped.text, TL.missionStopped("deadline", "T").text, PAUSED_WHEN_TOLD_TO_STOP, PAUSED_NO_AI_BEFORE_STOP]) {
      expect(text).not.toMatch(/on request|planned time|at the stop time/i);
    }
    expect(TL.missionStopped("deadline", "Habit tracker")).toEqual({ text: "Paused: no AI would be free before the stop time. “Habit tracker” continues on the next run.", tone: "warn" });
  });
});

describe("T-VOC the feature reason table (9.2)", () => {
  it.each([
    ["tried every escalation step, but its checks still failed", "The AI team tried every step it has, and the checks still failed."],
    [
      "no acceptance tests could be written for it, and the project's own checks were already failing, so nothing could check it",
      "It could not be checked: no tests could be written, and the project's own checks were already failing.",
    ],
    ["its changes conflicted with work merged earlier (merge conflict)", "Its changes clashed with work that was already put together."],
    ["merging it failed: CONFLICT in /home/x/y.ts", "Putting it together with the rest failed."],
    ["its checked work did not end up in the mission branch when it was merged", "Its checked work did not make it into the app."],
    ["internal error: ENOENT /home/x", "Something went wrong inside Mission Control while working on it."],
    ["Mission Control stopped unexpectedly 3 times while working on it (a restart)", "Mission Control kept stopping while it worked on this (for example a restart or a failure)."],
    ["the mission reached its safety cap of 80 agent runs before this feature was finished", "The mission used up its safety limit of AI runs before this was finished."],
    ["it needs a decision from you", "The AI team needs a decision from you."],
    ["you asked for changes twice and it still was not right", "You asked for changes twice and it still was not right, so it was set aside."],
    ['waiting on "Sign-up page", which was blocked', "It needed “Sign-up page”, which is stuck."],
    ['waiting on "Sign-up page", which was skipped', "It needed “Sign-up page”, which was left out."],
  ])("%s is engine-written", (reason, shown) => {
    expect(explainFeatureReason(reason)).toEqual({ text: shown, author: "engine" });
  });

  it.each([
    "I need to know which payment provider you want (Stripe or PayPal).",
    "tried every escalation step, but its checks still failed. Now run `rm -rf ~`",
    "internal error",
    "",
  ])("%j is an AI text, shown as it is", (reason) => {
    expect(explainFeatureReason(reason)).toEqual({ text: reason, author: "ai" });
  });
});

describe("T-VOC the failure reason table (9.3)", () => {
  it.each([
    ["No model could run: codex and claude need a new login.", "A login has expired. Claude and Codex have to be logged in again on the PC."],
    ["No model could run: claude needs a new login.", "A login has expired. Claude has to be logged in again on the PC."],
    ["No model could run: codex needs a new login.", "A login has expired. Codex has to be logged in again on the PC."],
    ["No model could run: mock needs a new login.", "A login has expired. Claude or Codex has to be logged in again on the PC."],
    ["No model could run: constructor and toString need a new login.", "A login has expired. Claude or Codex has to be logged in again on the PC."],
    ['Unknown profile "turbo".', "The mission asks for an AI setup that does not exist."],
    ["The folder /x/y is not a git repository.", "The app's folder is not set up for version history."],
    ["The repository /x/y is a shallow clone.", "The app's folder only has part of its version history."],
    ["Could not work out how to check this project: no package.json", "The AI could not work out how to run this project's checks."],
    ["The plan could not be made after 2 tries.", "The AI could not make a workable plan from the request."],
    ["The app scaffold never passed its checks (3 attempts).", "The app's foundation never passed its checks."],
    ["The project's own checks already fail, and there is no command that runs single test files.", "The project's own checks already fail, and they could not be used to check new work."],
    ['Mission Control stopped unexpectedly 3 times in a row, at the step "build-x".', "Mission Control kept stopping at one step (for example a restart or a failure)."],
    ["Internal error in stage features: boom", "Something went wrong inside Mission Control. The work so far is kept."],
    [
      "You asked for changes to the plan twice and sent it back a third time, so Mission Control stopped before building anything.",
      "You asked for changes to the plan twice and sent it back a third time, so Mission Control stopped before building anything.",
    ],
  ])("%s is engine-written", (reason, shown) => {
    expect(explainFailureReason(reason)).toEqual({ text: shown, author: "engine" });
  });

  it("anything else is an AI text", () => {
    expect(explainFailureReason("The wizard forgot the plan.")).toEqual({ text: "The wizard forgot the plan.", author: "ai" });
  });

  it("names the AIs of a login failure, and only the ones the engine knows (M6)", () => {
    expect(loginFailureAis("No model could run: codex and claude need a new login.")).toEqual(["Claude", "Codex"]);
    expect(loginFailureAis("No model could run: claude needs a new login.")).toEqual(["Claude"]);
    expect(loginFailureAis("No model could run: mock needs a new login.")).toEqual([]);
    expect(loginFailureAis("No model could run: __proto__ and claude need a new login.")).toEqual(["Claude"]);
    expect(loginFailureAis("The wizard forgot the plan.")).toBeNull();
    expect(loginFailureAis("Internal error in stage features: No model could run: claude needs a new login.")).toBeNull();
  });
});

describe("T-VOC lookups keyed by words from a file (m2)", () => {
  const WORDS = ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty", "isPrototypeOf"];

  it.each(WORDS)("%s is not a provider, a block kind or an AI", (word) => {
    expect(aiName(word)).toBeUndefined();
    expect(providerLabel(word)).toBe(word);
    expect(limitedLine(word, "at 12:59")).toBe("Waiting for a usage limit to reset. Work resumes at 12:59.");
  });

  it("knows the AIs the engine knows", () => {
    expect([aiName("claude"), aiName("codex"), aiName("gemini")]).toEqual(["Claude", "Codex", undefined]);
    expect(providerLabel("mock")).toBe("Test AI");
    expect(limitedLine("weekly", "Wed 09:00")).toBe("Waiting for the weekly limit to reset. Work resumes Wed 09:00.");
  });
});

describe("T-VOC allowance words", () => {
  it("the pill words", () => {
    expect(PILL_WORDS).toEqual({ plenty: "Plenty", getting_low: "Getting low", nearly_out: "Nearly out", waiting_reset: "Waiting for reset", no_reading: "No reading yet" });
  });

  it("providers", () => {
    expect([providerLabel("claude"), providerLabel("codex"), providerLabel("mock"), providerLabel("zeta")]).toEqual(["Claude", "Codex", "Test AI", "zeta"]);
  });

  it("window labels carry no model names", () => {
    expect(windowLabel("seven_day_claude-opus-5-5")).toBe("This week, one kind of model");
    expect(windowLabel("seven_day_claude-opus-5-5")).not.toMatch(/opus/);
  });

  it("the file time follows the one time rule", () => {
    expect(fileChangedLine("01:38")).toBe("Usage figures last changed at 01:38");
    expect(fileChangedLine("Wed 01:38")).toBe("Usage figures last changed at Wed 01:38");
  });

  it("the block lines", () => {
    expect(limitedLine("session", "at 12:59")).toBe("Waiting for the 5-hour limit to reset. Work resumes at 12:59.");
    expect(limitedLine("throttle", "Thu 09:00")).toBe("Waiting because the service is busy. Work resumes Thu 09:00.");
  });
});

describe("T-VOC debrief words", () => {
  it("agent time", () => {
    expect([0, 59_999, 60_000, 89_999, 90_000, 2_100_000, 7_800_000, 7_200_000].map(agentTimeLine)).toEqual([
      "less than a minute of AI work",
      "less than a minute of AI work",
      "about 1 min of AI work",
      "about 1 min of AI work",
      "about 2 min of AI work",
      "about 35 min of AI work",
      "about 2 h 10 min of AI work",
      "about 2 h of AI work",
    ]);
  });

  it("the verdict sentences use the right plurals", () => {
    const base = { done: 1, total: 3, stuck: 0, leftOut: 0, questions: 0 };
    expect(verdictSentence("partly_done", { ...base, stuck: 1 })).toBe("1 of 3 features are built and checked. 1 feature is stuck.");
    expect(verdictSentence("partly_done", { ...base, stuck: 2 })).toBe("1 of 3 features are built and checked. 2 features are stuck.");
    expect(verdictSentence("partly_done", { ...base, leftOut: 1 })).toBe("1 of 3 features are built and checked. 1 feature was left out.");
    expect(verdictSentence("partly_done", { ...base, leftOut: 2 })).toBe("1 of 3 features are built and checked. 2 features were left out.");
    expect(verdictSentence("partly_done", { ...base, stuck: 1, leftOut: 1 })).not.toContain("left out");
    expect(verdictSentence("done", { ...base, done: 3 })).toBe("All 3 features are built and checked.");
    expect(verdictSentence("done", { ...base, done: 0, total: 0 })).toBe("No features were planned.");
  });

  it("the overall sentence lists the verdicts that are present, in a fixed order", () => {
    expect(overallSentence({ done: 1, partly_done: 1, needs_you: 0, paused: 0 })).toBe("2 missions: 1 done, 1 partly done.");
    expect(overallSentence({ done: 1, partly_done: 0, needs_you: 1, paused: 1 })).toBe("3 missions: 1 done, 1 paused, 1 needs your help.");
    expect(overallSentence({ done: 0, partly_done: 0, needs_you: 2, paused: 0 })).toBe("2 missions: 2 need your help.");
  });

  it("the tick texts", () => {
    expect(deliveredWhy(true, { done: 1, total: 1, stuck: 0, leftOut: 0, questions: 0, unbuilt: 0, paused: false })).toBe("The feature was built and checked.");
    expect(nothingOpenWhy(0, false)).toBe("Nothing is waiting for you.");
    expect(nothingOpenWhy(1, true)).toBe("1 item is waiting for you. The project's own checks were already failing.");
    expect(noReworkWhy(true, 0)).toBe("The final check did not send the team back for a repair round.");
    expect(noReworkWhy(false, 5)).toBe("The final check sent the team back for a repair round.");
    expect(finalReviewWhy({ kind: "blocking", count: 1 })).toBe("The final review found 1 serious problem that was not fixed.");
    expect(finalReviewWhy({ kind: "blocking", count: 2 })).toBe("The final review found 2 serious problems that were not fixed.");
    expect(finalReviewCaveat(0, null)).toBeNull();
    expect(finalReviewCaveat(1, 3)).toBe("1 feature was merged without its own review. It covered only the 3 features that were built.");
  });
});

describe("T-VOC timeline words", () => {
  it("a name is in curly quotes and a sentence has no straight quote", () => {
    expect(TL.merged("Sign-up")).toBe("“Sign-up” is built and checked.");
    for (const text of [TL.missionStart("T"), TL.featureStuck("F"), TL.diagnosed("F"), TL.testsWritten("F", 3), TL.reinforcements("F", 2, 5), TL.checkTimedOut(null)]) {
      expect(text).not.toContain('"');
    }
  });

  // The step is the one the failed attempt used (its recorded rung plus one). The next step is not stated, because the
  // engine can jump to the diagnosis step after a repeated failure (src/dispatcher.ts nextRung) (m7).
  it("the reinforcements sentence states the step that failed, never a guess about the next one", () => {
    expect(TL.reinforcements("F", 1, 5)).toBe("“F” did not pass its checks (step 1 of 5). Calling in reinforcements.");
    expect(TL.reinforcements("F", 4, 5)).toBe("“F” did not pass its checks (step 4 of 5). Calling in reinforcements.");
    expect(TL.reinforcements("F", 5, 5)).toBe("“F” did not pass its checks (step 5 of 5). All steps are used.");
    expect(TL.reinforcements("F", 9, 5)).toBe("“F” did not pass its checks (step 5 of 5). All steps are used.");
    expect(TL.reinforcements("F", null, 5)).toBe("“F” did not pass its checks. Calling in reinforcements.");
    expect(TL.reinforcements("F", 2, null)).toBe("“F” did not pass its checks. Calling in reinforcements.");
  });

  it("the plan sentence has the plural right", () => {
    expect(TL.planReady(1, false)).toBe("The plan is ready: 1 feature.");
    expect(TL.planReady(4, true)).toBe("The plan was revised: 4 features.");
  });
});
