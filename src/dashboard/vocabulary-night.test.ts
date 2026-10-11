// T-VOC for the night wording: the wait text (spec 4.6), the stop table (4.5), the reason tables (9.2, 9.3), and the
// plain words of the allowance, the timeline and the debrief.
import { describe, expect, it } from "vitest";
import {
  agentTimeLine,
  deliveredWhy,
  explainFailureReason,
  explainFeatureReason,
  finalReviewCaveat,
  finalReviewWhy,
  limitedLine,
  nightSentence,
  noReworkWhy,
  nothingOpenWhy,
  parseWaitReason,
  PILL_WORDS,
  providerLabel,
  stopReasonKind,
  TL,
  verdictSentence,
  waitInfoFromEvent,
  waitText,
  windowLabel,
} from "./vocabulary-night.js";

const at = (iso: string): number => Date.parse(iso);
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const UNTIL = "2026-10-11T12:59:10.596Z";

function info(reason: string | null) {
  return waitInfoFromEvent(reason === null ? { until: UNTIL } : { until: UNTIL, reason }, clock);
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
    ["No model could run: codex and claude need a new login.", "A login has expired. Claude or Codex has to be logged in again on the PC."],
    ["No model could run: claude needs a new login.", "A login has expired. Claude or Codex has to be logged in again on the PC."],
    ['Unknown profile "turbo".', "The mission asks for an AI setup that does not exist."],
    ["The folder /x/y is not a git repository.", "The app's folder is not set up for version history."],
    ["The repository /x/y is a shallow clone.", "The app's folder only has part of its version history."],
    ["Could not work out how to check this project: no package.json", "The AI could not work out how to run this project's checks."],
    ["The plan could not be made after 2 tries.", "The AI could not make a workable plan from the request."],
    ["The app scaffold never passed its checks (3 attempts).", "The app's foundation never passed its checks."],
    ["The project's own checks already fail, and there is no command that runs single test files.", "The project's own checks already fail, and they could not be used to check new work."],
    ['Mission Control stopped unexpectedly 3 times in a row, at the step "build-x".', "Mission Control kept stopping at one step (for example a restart or a failure)."],
    ["Internal error in stage features: boom", "Something went wrong inside Mission Control. The work so far is kept."],
  ])("%s is engine-written", (reason, shown) => {
    expect(explainFailureReason(reason)).toEqual({ text: shown, author: "engine" });
  });

  it("anything else is an AI text", () => {
    expect(explainFailureReason("The wizard forgot the plan.")).toEqual({ text: "The wizard forgot the plan.", author: "ai" });
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

  it("the night sentence lists the verdicts that are present, in a fixed order", () => {
    expect(nightSentence({ done: 1, partly_done: 1, needs_you: 0, paused: 0 })).toBe("2 missions: 1 done, 1 partly done.");
    expect(nightSentence({ done: 1, partly_done: 0, needs_you: 1, paused: 1 })).toBe("3 missions: 1 done, 1 paused, 1 needs your help.");
    expect(nightSentence({ done: 0, partly_done: 0, needs_you: 2, paused: 0 })).toBe("2 missions: 2 need your help.");
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

  it("the plan sentence has the plural right", () => {
    expect(TL.planReady(1, false)).toBe("The plan is ready: 1 feature.");
    expect(TL.planReady(4, true)).toBe("The plan was revised: 4 features.");
  });
});
