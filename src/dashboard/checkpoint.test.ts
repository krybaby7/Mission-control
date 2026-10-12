// T-CHECK: the dashboard's side of the human checkpoints (docs/checkpoints-spec.md, 10 and 16): a mission that waits for the
// owner's look reads as paused for a check, has one amber card and one amber lamp reason, and its events have sentences.
// The four synthetic fixtures stand for what the engine writes; test/checkpoint-dashboard.test.ts runs the real engine.
import { describe, expect, it } from "vitest";
import { buildHome, featureWith, FIN, fixtureSnapshot, HOUR, iso, MID, MINUTE, missionAt, snap } from "../../test/dashboard-kit.js";
import { copyHome, hashTree, makeEvent } from "../../test/dashboard-helpers.js";
import { fakeFacts } from "../../test/dashboard-facts-helpers.js";
import type { CheckpointKind, CheckpointRecord, Mission, MissionEvent, PendingCheckpoint } from "../types.js";
import { CHECKPOINT_LINES_MAX, CHECKPOINT_SEND_BACK_CAP } from "./constants.js";
import { clearReadCache, readDetails, readHome } from "./read.js";
import { buildTimeline } from "./timeline.js";
import type { Snapshot } from "./types.js";
import { CARD_KINDS, LAMP_REASON_CODES, PAUSED_WHY } from "./types.js";
import { CARD_TEXT, CLAUSE, checkpointSummary, LEADER, leaderHelp, makeFormatter, makeLeaderNames, missionSentence, TL } from "./vocabulary.js";

const ID = "2026-10-11-habit-tracker";

/** A pending checkpoint as the engine writes it. */
function pending(over: Partial<PendingCheckpoint> = {}): PendingCheckpoint {
  return {
    id: "plan#1",
    scope: "plan",
    kind: "plan",
    round: 1,
    state: "pending",
    parkedAt: iso(MID - 5000),
    notifiedAt: iso(MID - 4000),
    look: { headline: "Check the plan for “Habit tracker”", lines: ["The plan has 1 feature: Add and name a habit."] },
    ...over,
  };
}

/** A stopped mission with a checkpoint, saved `age` ago. */
function parked(over: Partial<Mission> = {}, o: { id?: string; age?: number } = {}): Mission {
  return missionAt(MID, o.id ?? ID, {
    title: "Habit tracker",
    status: "stopped",
    stage: "init",
    age: o.age ?? 5 * 1000,
    features: [featureWith("add-habit", "pending", { title: "Add and name a habit" })],
    checkpoints: ["plan"],
    checkpoint: pending(),
    ...over,
  });
}

function snapOf(missions: { mission: Mission; events?: MissionEvent[] }[], o: { live?: boolean; now?: number } = {}): Snapshot {
  const now = o.now ?? MID;
  return snap(buildHome({ missions, lock: o.live ? { at: iso(now - 10 * MINUTE) } : undefined }, now), now);
}

const checkCard = (s: Snapshot) => s.needsYou.filter((c) => c.kind === "checkpoint");

describe("T-CHECK-1: the contract lists the new words", () => {
  it("has the checkpoint paused reason, the checkpoint card kind (second, after the failed mission) and the lamp reason", () => {
    expect(PAUSED_WHY).toContain("checkpoint");
    expect(CARD_KINDS.slice(0, 2)).toEqual(["mission_failed", "checkpoint"]);
    expect(LAMP_REASON_CODES).toContain("checkpoint_waiting");
  });
});

describe("T-CHECK-2: reading the checkpoint fields (read.ts)", () => {
  function read(missions: { mission: Mission; events?: MissionEvent[] }[]) {
    const home = buildHome({ missions }, MID);
    clearReadCache();
    const data = readHome(home);
    readDetails(home, data, data.missions.map((m) => m.folder));
    return data.missions[0];
  }

  it("passes checkpoints, the checkpoint and the log through, and leaves the owner's note, the fingerprint and the paths out", () => {
    const log: CheckpointRecord[] = [{ id: "plan#1", scope: "plan", kind: "plan", round: 1, decision: "send_back", note: "make the buttons bigger", at: iso(MID - HOUR) }];
    const m = parked({
      checkpointLog: log,
      checkpoint: pending({
        round: 2,
        reworkFrom: "abc123",
        answer: { decision: "approve", note: "the plan is fine", at: iso(MID) },
        look: { headline: "Check", lines: ["a", "b"], branch: "mc/x", commit: "3f2a91c", files: ["src/secret/path.ts"], screenshots: ["screenshots/home.png"] },
      }),
    });
    const entry = read([{ mission: m }])?.mission;
    expect(entry?.checkpoints).toEqual(["plan"]);
    expect(entry?.checkpoint).toEqual({
      id: "plan#1",
      scope: "plan",
      kind: "plan",
      round: 2,
      state: "pending",
      parkedAt: iso(MID - 5000),
      look: { headline: "Check", lines: ["a", "b"], branch: "mc/x" },
      answer: { decision: "approve", at: iso(MID) },
    });
    expect(entry?.checkpointLog).toEqual([{ id: "plan#1", scope: "plan", kind: "plan", round: 1, decision: "send_back", at: iso(MID - HOUR) }]);
    const text = JSON.stringify(entry);
    for (const gone of ["make the buttons bigger", "the plan is fine", "abc123", "secret/path", "home.png", "3f2a91c"]) expect(text, gone).not.toContain(gone);
  });

  it("a mission with no checkpoints has none of the three keys", () => {
    const entry = read([{ mission: missionAt(MID, ID, { title: "Habit tracker" }) }])?.mission;
    expect(entry).toBeDefined();
    for (const key of ["checkpoints", "checkpoint", "checkpointLog"]) expect(key in (entry ?? {}), key).toBe(false);
  });

  it("drops what is not a checkpoint: an unknown kind or state, a missing id, a value that is not an object, a list that is not a list", () => {
    for (const bad of [{ kind: "banana" }, { state: "paused" }, { id: 7 }, { scope: 7 }]) {
      expect(read([{ mission: parked({ checkpoint: { ...pending(), ...bad } as never }) }])?.mission?.checkpoint, JSON.stringify(bad)).toBeUndefined();
    }
    const odd = read([{ mission: parked({ checkpoint: "plan" as never, checkpoints: "plan" as never, checkpointLog: { a: 1 } as never }) }])?.mission;
    expect(odd?.checkpoint).toBeUndefined();
    expect(odd?.checkpoints).toBeUndefined();
    expect(odd?.checkpointLog).toBeUndefined();
    expect(read([{ mission: parked({ checkpoints: ["plan", "banana", "plan", "final"] as CheckpointKind[] }) }])?.mission?.checkpoints).toEqual(["plan", "final"]);
  });

  it("cleans every string and cuts the lines: hidden characters go, a long line is cut, at most the capped number of lines stay", () => {
    const lines = Array.from({ length: CHECKPOINT_LINES_MAX + 5 }, (_, i) => `line ${i}`);
    lines[0] = "Check‮ the ​plan " + "x".repeat(5000);
    const entry = read([{ mission: parked({ checkpoint: pending({ look: { headline: "H‮ead", lines } }) }) }])?.mission;
    expect(entry?.checkpoint?.look.lines).toHaveLength(CHECKPOINT_LINES_MAX);
    expect(entry?.checkpoint?.look.lines[0]?.startsWith("Check the plan x")).toBe(true);
    expect(entry?.checkpoint?.look.lines[0]?.length).toBeLessThanOrEqual(400);
    expect(entry?.checkpoint?.look.headline).toBe("Head");
  });

  it("keeps the log to the newest 50 records and drops a record that is not one", () => {
    const rec = (n: number): CheckpointRecord => ({ id: `feature:f${n}#1`, scope: `feature:f${n}`, kind: "feature", featureId: `f${n}`, round: 1, decision: "approve", at: iso(MID - n * MINUTE) });
    const log = [...Array.from({ length: 60 }, (_, n) => rec(n)), { id: "x" } as never, { ...rec(1), decision: "maybe" } as never];
    const entry = read([{ mission: parked({ checkpointLog: log }) }])?.mission;
    expect(entry?.checkpointLog).toHaveLength(50);
    expect(entry?.checkpointLog?.[0]?.id).toBe("feature:f10#1");
    expect(entry?.checkpointLog?.at(-1)?.id).toBe("feature:f59#1");
  });

  it("reads the kind and the decision of a checkpoint event, and nothing else of the event (no id, no proof, no note)", () => {
    const events = [makeEvent(ID, MID - 2000, "checkpoint.answered", { id: "plan#1", kind: "plan", decision: "approve", round: 1, at: iso(MID), proof: "deadbeef", note: "private words" })];
    const data = read([{ mission: parked(), events }])?.events?.[0]?.data;
    expect(data).toEqual({ kind: "plan", decision: "approve" });
  });
});

describe("T-CHECK-3: the mission state (missions.ts, spec 4.2)", () => {
  const sentenceOf = (m: Mission, now = MID) => snapOf([{ mission: m }], { now }).missions[0];

  it("pending: paused, because of the check, with the sentence of the kind", () => {
    const plan = sentenceOf(parked());
    expect(plan).toMatchObject({ state: "paused", word: "Paused", pausedWhy: "checkpoint", sentence: "Waiting for your check of the plan.", scope: "recent" });
    const feature = sentenceOf(parked({ stage: "features", checkpoints: ["feature"], checkpoint: pending({ id: "feature:add-habit#1", scope: "feature:add-habit", kind: "feature", featureId: "add-habit" }) }));
    expect(feature?.sentence).toBe("Waiting for your check of “Add and name a habit”.");
    const final = sentenceOf(parked({ stage: "finalize", checkpoints: ["final"], checkpoint: pending({ id: "final#1", scope: "final", kind: "final" }) }));
    expect(final?.sentence).toBe("Waiting for your check of the finished app.");
    expect(sentenceOf(parked({ stage: "features", checkpoint: pending({ id: "feature:gone#1", scope: "feature:gone", kind: "feature", featureId: "gone" }) }))?.sentence).toBe("Waiting for your check of a feature.");
  });

  it("answered and not continued: paused, and it says it continues on the next run", () => {
    const answered = sentenceOf(parked({ checkpoint: pending({ state: "answered", answer: { decision: "approve", at: iso(MID) } }) }));
    expect(answered).toMatchObject({ state: "paused", pausedWhy: "checkpoint", sentence: "You answered. It continues on the next run." });
  });

  it("the stage steps of a parked mission are those of its stage; the feature tiles read as paused, and say what for", () => {
    const m = parked({ stage: "features", features: [featureWith("a", "reviewing"), featureWith("b", "pending")], checkpoint: pending({ id: "feature:a#1", scope: "feature:a", kind: "feature", featureId: "a" }) });
    const view = sentenceOf(m);
    expect(view?.progress.map((p) => p.state)).toEqual(["done", "done", "current", "todo", "todo"]);
    expect(view?.features.map((f) => [f.state, f.reason?.text ?? null])).toEqual([
      ["paused", "Paused while the mission waits for your check."],
      ["waiting_turn", null],
    ]);
    const answered = sentenceOf({ ...m, checkpoint: pending({ id: "feature:a#1", scope: "feature:a", kind: "feature", featureId: "a", state: "answered", answer: { decision: "approve", at: iso(MID) } }) });
    expect(answered?.features[0]?.reason?.text).toBe("Paused. It continues on the next run.");
  });

  it("a checkpoint on a mission that is not stopped is not one: a running mission is working, a failed one needs help", () => {
    const running = snapOf([{ mission: parked({ status: "running" }) }], { live: true }).missions[0];
    expect(running).toMatchObject({ state: "working", pausedWhy: null });
    const failed = snapOf([{ mission: parked({ status: "failed", failure: { reason: "x", retryable: false } }) }]).missions[0];
    expect(failed?.state).toBe("needs_you");
  });

  it("a mission that waits for a check stays recent however long it waits; one that was answered ages out like any other", () => {
    const old = 5 * 24 * HOUR;
    expect(sentenceOf(parked({}, { age: old }))).toMatchObject({ scope: "recent", state: "paused", pausedWhy: "checkpoint" });
    const answered = parked({ checkpoint: pending({ state: "answered", answer: { decision: "approve", at: iso(MID) } }) }, { age: old });
    expect(sentenceOf(answered)).toMatchObject({ scope: "earlier", openFromEarlier: true, pausedWhy: "checkpoint" });
  });
});

describe("T-CHECK-4: the card (cards.ts)", () => {
  const planCard = () => checkCard(snapOf([{ mission: parked() }]))[0];

  it("plan: one amber card with the engine's sentences, the look's lines as the AI's, and the two answers", () => {
    expect(checkCard(snapOf([{ mission: parked() }]))).toEqual([
      {
        id: `checkpoint:${ID}:0`,
        kind: "checkpoint",
        severity: "look",
        missionId: ID,
        missionTitle: "Habit tracker",
        fromEarlier: false,
        featureId: null,
        title: "“Habit tracker”: please check the plan",
        happened: { text: "The team stopped here because you asked to look at it first.", author: "engine" },
        summary: "Nothing is built yet. The report has the whole plan.",
        ifNothing: "Nothing happens. This mission waits for you. Other work carries on.",
        whatToDo: { text: "Look at it as the report describes, then tell the leader to approve it or send it back.", author: "engine" },
        tellLeader: 'About the check of "Habit tracker": <your answer here>',
        lines: [{ text: "The plan has 1 feature: Add and name a habit.", author: "ai" }],
        answers: {
          approve: 'About the check of "Habit tracker" (the plan): approved, go ahead.',
          sendBack: 'About the check of "Habit tracker" (the plan): send it back. What to change: <your answer here>',
        },
      },
    ]);
  });

  it("feature: names the feature in the title and in both answers, and shows where the work is saved", () => {
    const m = parked({
      stage: "features",
      checkpoint: pending({ id: "feature:add-habit#1", scope: "feature:add-habit", kind: "feature", featureId: "add-habit", look: { headline: "h", lines: [], branch: "mc/x--add-habit" } }),
    });
    const [c] = checkCard(snapOf([{ mission: m }]));
    expect(c).toMatchObject({
      title: "“Habit tracker”: please check “Add and name a habit” before it is added",
      featureId: "add-habit",
      summary: "The work is saved under the name mc/x--add-habit. The report says how to open it.",
      answers: {
        approve: 'About the check of "Habit tracker" (the feature "Add and name a habit"): approved, go ahead.',
        sendBack: 'About the check of "Habit tracker" (the feature "Add and name a habit"): send it back. What to change: <your answer here>',
      },
    });
    expect(c && "lines" in c).toBe(false); // no lines to show: the key is absent, not empty
  });

  it("final: the finished app, with the same two answers", () => {
    const m = parked({ stage: "finalize", checkpoint: pending({ id: "final#1", scope: "final", kind: "final", look: { headline: "h", lines: ["All 1 feature is built."] } }) });
    const [c] = checkCard(snapOf([{ mission: m }]));
    expect(c).toMatchObject({
      title: "“Habit tracker”: please check the finished app",
      summary: "The report says how to open it.",
      answers: { approve: 'About the check of "Habit tracker" (the finished app): approved, go ahead.' },
    });
  });

  it("is amber, never red, and the lines are all the AI's (they mix engine and AI text and are not parsed)", () => {
    const c = planCard();
    expect(c?.severity).toBe("look");
    expect(c?.lines?.every((l) => l.author === "ai")).toBe(true);
    expect(snapOf([{ mission: parked() }]).needsYou.map((x) => x.severity)).toEqual(["look"]);
  });

  it("whatToDo is one engine sentence with no name, no quote and no command", () => {
    const text = planCard()?.whatToDo?.text ?? "";
    expect(text).not.toMatch(/["“”]|\bmc\b|`|approve <|send-back/);
    expect((text.match(/\. /g) ?? []).length).toBe(0);
    expect(text.endsWith(".")).toBe(true);
  });

  it("answers and lines are on a checkpoint card only", () => {
    const s = snapOf([{ mission: parked() }, { mission: missionAt(MID, "2026-10-11-b", { title: "B", status: "partial", stage: "complete", decisionsNeeded: ["Which colour?"] }) }]);
    expect(s.needsYou.map((c) => c.kind).sort()).toEqual(["checkpoint", "decision"]);
    for (const c of s.needsYou.filter((x) => x.kind !== "checkpoint")) expect(Object.keys(c)).not.toEqual(expect.arrayContaining(["answers"]));
    expect(s.needsYou.filter((c) => "answers" in c || "lines" in c).map((c) => c.kind)).toEqual(["checkpoint"]);
  });

  it("an answered check has no card; a failed mission's red card comes before the check's amber one", () => {
    expect(snapOf([{ mission: parked({ checkpoint: pending({ state: "answered", answer: { decision: "approve", at: iso(MID) } }) }) }]).needsYou).toEqual([]);
    const s = snapOf([
      { mission: parked() },
      { mission: missionAt(MID, "2026-10-11-z", { title: "Zed", status: "failed", stage: "features", failure: { reason: "x", retryable: false } }) },
    ]);
    expect(s.needsYou.map((c) => [c.kind, c.severity])).toEqual([["mission_failed", "now"], ["checkpoint", "look"]]);
  });

  it("a long wait does not age the card out", () => {
    expect(checkCard(snapOf([{ mission: parked({}, { age: 9 * 24 * HOUR }) }]))).toHaveLength(1);
  });

  it("warns what the next send-back does once the cap is reached, and not before", () => {
    const sent = (n: number): CheckpointRecord[] => Array.from({ length: n }, (_, i) => ({ id: `plan#${i + 1}`, scope: "plan", kind: "plan", round: i + 1, decision: "send_back", at: iso(MID - HOUR) }));
    expect(checkCard(snapOf([{ mission: parked({ checkpointLog: sent(1) }) }]))[0]?.summary).toBe("Nothing is built yet. The report has the whole plan.");
    expect(CHECKPOINT_SEND_BACK_CAP).toBe(2);
    expect(checkCard(snapOf([{ mission: parked({ checkpointLog: sent(2), checkpoint: pending({ round: 3 }) }) }]))[0]?.summary).toBe(
      "Nothing is built yet. The report has the whole plan. You have sent this back 2 times. If you send it back again, the work stops here: nothing will be built. You can still approve.",
    );
    // earlier answers about another scope do not count
    const other = [{ id: "feature:x#1", scope: "feature:x", kind: "feature", round: 1, decision: "send_back", at: iso(MID) }, ...sent(1)] as CheckpointRecord[];
    expect(checkCard(snapOf([{ mission: parked({ checkpointLog: other }) }]))[0]?.summary).not.toContain("You have sent this back");
    expect(checkpointSummary("feature", null, 2, 2)).toContain("this feature is set aside and the rest carries on");
    expect(checkpointSummary("final", null, 2, 2)).toContain("the finished result is kept as it is");
  });

  it("the mission's title cannot break out of the quotes of the pasted sentences, and the sentences hold no curly quote", () => {
    const [c] = checkCard(snapOf([{ mission: parked({ title: 'Habit "tracker"' }) }]));
    expect(c?.tellLeader).toBe(`About the check of "Habit 'tracker'": <your answer here>`);
    for (const sentence of [c?.tellLeader, c?.answers?.approve, c?.answers?.sendBack]) expect(sentence, String(sentence)).not.toMatch(/[“”]/);
    expect(c?.title).toContain('“Habit "tracker"”'); // displayed with curly quotes around the name
  });

  it("a feature check whose feature is not in the file still gets its card, with no answers to paste", () => {
    const m = parked({ stage: "features", checkpoint: pending({ id: "feature:gone#1", scope: "feature:gone", kind: "feature", featureId: "gone" }) });
    const [c] = checkCard(snapOf([{ mission: m }]));
    expect(c?.title).toBe("“Habit tracker”: please check a feature before it is added");
    expect(c && "answers" in c).toBe(false);
  });

  it("two missions with the same title tell their answers apart by id", () => {
    const s = snapOf([{ mission: parked({}, { id: "2026-10-11-a" }) }, { mission: parked({}, { id: "2026-10-11-b" }) }]);
    expect(checkCard(s).map((c) => c.answers?.approve)).toEqual([
      'About the check of "Habit tracker" (mission 2026-10-11-a) (the plan): approved, go ahead.',
      'About the check of "Habit tracker" (mission 2026-10-11-b) (the plan): approved, go ahead.',
    ]);
  });
});

describe("T-CHECK-5: the lamp (lamp.ts)", () => {
  const codes = (s: Snapshot) => s.lamp.reasons.map((r) => r.code);

  it("a check that waits is amber and says so", () => {
    const s = snapOf([{ mission: parked() }]);
    expect(s.lamp).toMatchObject({ state: "needs_look", word: "Needs a look", sentence: "“Habit tracker” is waiting for your check." });
    expect(s.lamp.reasons).toEqual([{ code: "checkpoint_waiting", severity: "look", text: "“Habit tracker” is waiting for your check", missionId: ID, featureId: null }]);
  });

  it("beside a live run the rest is on track; the clause has no semicolon and no inner 'and'", () => {
    const working = missionAt(MID, "2026-10-11-w", { title: "Worker", status: "running", stage: "features", features: [featureWith("a", "building")] });
    const s = snapOf([{ mission: parked() }, { mission: working, events: [makeEvent(working.id, MID - 3000, "run.start", { label: "build-a", jobId: "build-a-1", role: "engineer" })] }], { live: true });
    expect(s.lamp.sentence).toBe("“Habit tracker” is waiting for your check. The rest is on track.");
    for (const r of s.lamp.reasons) expect(r.text.replace(/“[^”]*”/g, "“”")).not.toMatch(/;| and /);
  });

  it("several checks are counted, and name no mission", () => {
    const s = snapOf([{ mission: parked({}, { id: "2026-10-11-a" }) }, { mission: parked({}, { id: "2026-10-11-b" }) }]);
    expect(s.lamp.sentence).toBe("2 checks are waiting for you.");
    expect(s.lamp.reasons[0]).toMatchObject({ code: "checkpoint_waiting", missionId: null });
    expect(CLAUSE.checkpoint(1, null)).toBe("1 check is waiting for you");
  });

  it("is not counted as unbuilt work: no paused_unbuilt reason for a parked mission", () => {
    expect(codes(snapOf([{ mission: parked({ features: [featureWith("a", "pending"), featureWith("b", "pending")] }) }]))).toEqual(["checkpoint_waiting"]);
  });

  it("an answered check raises nothing", () => {
    const s = snapOf([{ mission: parked({ checkpoint: pending({ state: "answered", answer: { decision: "approve", at: iso(MID) } }) }) }]);
    expect(codes(s)).toEqual(["nothing_running"]);
    expect(s.lamp.state).toBe("idle");
  });

  it("comes after the questions and before the project's own failing checks; red still wins", () => {
    const both = parked({ decisionsNeeded: ["Which colour?"], baselineBroken: true });
    expect(codes(snapOf([{ mission: both }]))).toEqual(["decision_waiting", "checkpoint_waiting", "checks_failing_before"]);
    const s = snapOf([{ mission: parked() }, { mission: missionAt(MID, "2026-10-11-z", { title: "Zed", status: "failed", stage: "features", failure: { reason: "x", retryable: false } }) }]);
    expect(s.lamp.state).toBe("needs_you_now");
    expect(codes(s)).toEqual(["mission_failed", "checkpoint_waiting"]);
  });

  it("a check that waits is never a calm lamp, however long it waits", () => {
    const s = snapOf([{ mission: parked({}, { age: 9 * 24 * HOUR }) }]);
    expect(s.lamp.state).toBe("needs_look");
    expect(s.lamp.sentence).not.toContain("Nothing needs you");
  });
});

describe("T-CHECK-6: the timeline (timeline.ts, spec 12)", () => {
  const T = "“Habit tracker”";
  const m = missionAt(MID, ID, { title: "Habit tracker", features: [featureWith("add-habit", "pending", { title: "Add and name a habit" })] });
  const items = (events: MissionEvent[]) => buildTimeline([fakeFacts(m, { events })], MID, makeFormatter("UTC")).items;
  let n = 0;
  const ev = (type: string, data: Record<string, unknown>) => makeEvent(ID, MID - 60_000 + ++n * 1000, type, data);
  const one = (type: string, data: Record<string, unknown>) => {
    const [item, ...rest] = items([ev(type, data)]);
    expect(rest).toEqual([]);
    return item;
  };
  const F = "“Add and name a habit”";

  it.each([
    ["checkpoint.parked", { id: "plan#1", kind: "plan", round: 1 }, `Waiting for your check of the plan for ${T}.`, "warn"],
    ["checkpoint.parked", { id: "feature:add-habit#1", kind: "feature", feature: "add-habit", round: 1 }, `Waiting for your check of ${F} before it is added.`, "warn"],
    ["checkpoint.parked", { id: "final#1", kind: "final", round: 1 }, "Waiting for your check of the finished app.", "warn"],
    ["checkpoint.answered", { id: "plan#1", kind: "plan", decision: "approve", round: 1 }, `You approved the plan. ${T} carries on when the next run starts.`, "good"],
    ["checkpoint.answered", { id: "feature:add-habit#1", kind: "feature", feature: "add-habit", decision: "approve", round: 1 }, `You approved ${F}. ${T} carries on when the next run starts.`, "good"],
    ["checkpoint.answered", { id: "final#1", kind: "final", decision: "approve", round: 1 }, `You approved the finished app. ${T} carries on when the next run starts.`, "good"],
    ["checkpoint.answered", { id: "plan#1", kind: "plan", decision: "send_back", round: 1 }, "You sent the plan back. It is revised and shown to you again.", "info"],
    ["checkpoint.answered", { id: "feature:add-habit#1", kind: "feature", feature: "add-habit", decision: "send_back", round: 1 }, `You sent ${F} back. It is changed and shown to you again.`, "info"],
    ["checkpoint.answered", { id: "final#1", kind: "final", decision: "send_back", round: 1 }, "You sent the finished app back. Your change is added and shown to you again.", "info"],
    ["checkpoint.reworked", { id: "plan#1", kind: "plan", ok: true }, "The plan was revised after your note.", "info"],
    ["checkpoint.reworked", { id: "feature:add-habit#1", kind: "feature", feature: "add-habit", ok: true }, `${F} was changed after your note.`, "info"],
    ["checkpoint.reworked", { id: "final#1", kind: "final", ok: true }, "A new feature was added for your change.", "info"],
    ["checkpoint.reworked", { id: "plan#1", kind: "plan", ok: false }, "Your change could not be made. The earlier version is shown again.", "warn"],
    ["checkpoint.limit", { kind: "plan" }, `You sent this back twice before, so ${T} stops here. The report says what to do.`, "bad"],
    ["checkpoint.rejected", { id: "plan#1", reason: "bad_proof" }, `An answer to the check of ${T} was ignored because it did not match. The check is still waiting.`, "warn"],
    ["checkpoint.rejected", { id: "plan#1", reason: "no_record" }, `An answer to the check of ${T} was ignored because it did not match. The check is still waiting.`, "bad"],
  ] as [string, Record<string, unknown>, string, string][])("%s %j", (type, data, text, tone) => {
    expect(one(type, data)).toMatchObject({ text, tone, note: null, author: "engine", count: 1 });
  });

  it("checkpoint.passed is hidden: the mission.resume that follows reads as the continuation", () => {
    const list = items([ev("checkpoint.passed", { id: "plan#1" }), ev("mission.resume", { stage: "init" })]);
    expect(list.map((i) => i.text)).toEqual([`Picked ${T} up again where it left off.`]);
  });

  it("never shows the owner's note, the proof or the id, and a missing kind is hidden", () => {
    const [item] = items([ev("checkpoint.answered", { id: "plan#1", kind: "plan", decision: "send_back", round: 1, note: "make the buttons bigger", proof: "deadbeef" })]);
    expect(JSON.stringify(item)).not.toMatch(/buttons|deadbeef|plan#1/);
    expect(items([ev("checkpoint.parked", { id: "x" })])).toEqual([]);
  });

  it("the lines carry the plain words only: no straight quote, no em dash, none of the forbidden words", () => {
    const words = /\b(builder|test writer|acceptance|git|crash|crashed|worktree|branch|frozen|gate|escalation|rung|token|objective|halted|killed)\b/i;
    const all = [TL.checkpointParked("plan", "T", null), TL.checkpointParked("feature", "T", "F"), TL.checkpointParked("final", "T", null), TL.checkpointLimit("T"), TL.checkpointRejected("T"), TL.checkpointAnswered("send_back", "final", "T", null).text, TL.checkpointReworked(false, "plan", null).text];
    for (const line of all) {
      expect(line).not.toMatch(/"|—/);
      expect(line.replace(/“[^”]*”/g, "")).not.toMatch(words);
    }
  });
});

describe("T-CHECK-7: the words (vocabulary.ts)", () => {
  const names = makeLeaderNames([{ id: "m1", title: "Shout", features: [{ id: "f1", title: "Add shout" }] }]);
  const mission = { id: "m1", title: "Shout" };

  it("the card's title, by kind", () => {
    expect(CARD_TEXT.checkpointTitle("Shout", "plan", null)).toBe("“Shout”: please check the plan");
    expect(CARD_TEXT.checkpointTitle("Shout", "feature", "Add shout")).toBe("“Shout”: please check “Add shout” before it is added");
    expect(CARD_TEXT.checkpointTitle("Shout", "final", null)).toBe("“Shout”: please check the finished app");
  });

  it("the three pasted sentences, in straight quotes", () => {
    expect(LEADER.checkpoint(names, mission)).toBe('About the check of "Shout": <your answer here>');
    expect(LEADER.approve(names, mission, { kind: "plan" })).toBe('About the check of "Shout" (the plan): approved, go ahead.');
    expect(LEADER.approve(names, mission, { kind: "feature", feature: { id: "f1", title: "Add shout" } })).toBe('About the check of "Shout" (the feature "Add shout"): approved, go ahead.');
    expect(LEADER.sendBack(names, mission, { kind: "final" })).toBe('About the check of "Shout" (the finished app): send it back. What to change: <your answer here>');
  });

  it("the sheet tells the CEO the leader can approve or send back a check", () => {
    expect(leaderHelp().canDo).toContain("approve or send back a check");
  });

  it("the mission sentence of a paused mission falls back when the checkpoint is not known", () => {
    const facts = { state: "paused" as const, stage: "init", pausedWhy: "checkpoint" as const, staleBusy: false, waitText: null, n: 1, k: 1, u: 1, d: 0, stuck: 0, leftOut: 0 };
    expect(missionSentence({ ...facts })).toBe("Paused. It continues on the next run.");
    expect(missionSentence({ ...facts, checkpoint: { state: "pending", kind: "plan", featureTitle: null } })).toBe("Waiting for your check of the plan.");
  });
});

describe("T-CHECK-8: the four fixtures", () => {
  const FIXTURES = ["checkpoint-plan", "checkpoint-feature", "checkpoint-final", "checkpoint-answered"] as const;

  it.each(FIXTURES)("%s builds a valid snapshot and leaves its home as it found it", (name) => {
    const home = copyHome(name);
    const before = hashTree(home);
    const s = snap(home, FIN);
    expect(hashTree(home)).toBe(before);
    expect(s.missions).toHaveLength(1);
    expect(s.missions[0]).toMatchObject({ state: "paused", pausedWhy: "checkpoint", scope: "recent" });
  });

  it("plan: the card, the amber lamp, the parked line", () => {
    const s = fixtureSnapshot("checkpoint-plan");
    expect(s.missions[0]?.sentence).toBe("Waiting for your check of the plan.");
    expect(checkCard(s)).toHaveLength(1);
    expect(checkCard(s)[0]?.lines).toHaveLength(5);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "“Habit tracker” is waiting for your check." });
    expect(s.timeline.items.at(-1)).toMatchObject({ tone: "warn", text: "Waiting for your check of the plan for “Habit tracker”." });
    expect(s.debrief).toBeNull();
  });

  it("feature: the card names the feature, the tile is paused for the check, the line names the feature", () => {
    const s = fixtureSnapshot("checkpoint-feature");
    expect(checkCard(s)[0]).toMatchObject({
      title: "“Shout”: please check “Add shout” before it is added",
      featureId: "add-shout",
      summary: "The work is saved under the name mc/2026-10-11-shout--add-shout. The report says how to open it.",
    });
    expect(s.missions[0]?.features.map((f) => [f.id, f.state])).toEqual([["add-shout", "paused"], ["add-docs", "waiting_turn"]]);
    expect(s.timeline.items.at(-1)?.text).toBe("Waiting for your check of “Add shout” before it is added.");
  });

  it("final: the card, and no Results entry for a mission that waits for a check", () => {
    const s = fixtureSnapshot("checkpoint-final");
    expect(checkCard(s)[0]?.title).toBe("“Recipe box”: please check the finished app");
    expect(s.missions[0]).toMatchObject({ featuresDone: 2, featuresTotal: 2 });
    expect(s.debrief).toBeNull();
    expect(s.lamp.state).toBe("needs_look");
  });

  it("answered: no card, no lamp reason, the sentence and the timeline say what the owner did", () => {
    const s = fixtureSnapshot("checkpoint-answered");
    expect(s.needsYou).toEqual([]);
    expect(s.missions[0]?.sentence).toBe("You answered. It continues on the next run.");
    expect(s.lamp.reasons.map((r) => r.code)).toEqual(["nothing_running"]);
    expect(s.timeline.items.map((i) => i.text).slice(-2)).toEqual(["Waiting for your check of the plan for “Garden planner”.", "You approved the plan. “Garden planner” carries on when the next run starts."]);
    // a mission that continues on the next run is a paused one in the results, worded as such
    expect(s.debrief?.missions[0]?.verdict).toMatchObject({ id: "paused", sentence: "Paused. It continues on the next run." });
  });

  it("the owner's note and the fingerprint never reach the snapshot", () => {
    const text = JSON.stringify(fixtureSnapshot("checkpoint-answered"));
    expect(text).not.toContain("the plan is fine");
    for (const name of FIXTURES) expect(JSON.stringify(fixtureSnapshot(name)), name).not.toMatch(/reworkFrom|proof|nonce/);
  });
});

describe("T-CHECK-9: every combination builds a valid snapshot, and nothing of dispatch.json travels", () => {
  const kinds: CheckpointKind[] = ["plan", "feature", "final"];
  const stages = { plan: "init", feature: "features", final: "finalize" } as const;

  it.each(kinds.flatMap((kind) => (["pending", "answered"] as const).flatMap((state) => (["stopped", "running", "done"] as const).map((status) => [kind, state, status] as const))))(
    "%s, %s, saved %s",
    (kind, state, status) => {
      const cp = pending({
        id: kind === "plan" ? "plan#1" : kind === "final" ? "final#1" : "feature:add-habit#1",
        scope: kind === "plan" ? "plan" : kind === "final" ? "final" : "feature:add-habit",
        kind,
        state,
        ...(kind === "feature" && { featureId: "add-habit" }),
        ...(state === "answered" && { answer: { decision: "send_back" as const, note: "private", at: iso(MID) } }),
      });
      const mission = parked({ status, stage: stages[kind], checkpoint: cp, ...(status === "done" && { stage: "complete" as const }) });
      const s = snapOf([{ mission }], { live: status === "running" });
      const waiting = status === "stopped" && state === "pending";
      expect(checkCard(s).length, "a card only for a pending check of a stopped mission").toBe(waiting ? 1 : 0);
      expect(s.lamp.reasons.some((r) => r.code === "checkpoint_waiting")).toBe(waiting);
      expect(s.missions[0]?.pausedWhy === "checkpoint").toBe(status === "stopped");
      expect(JSON.stringify(s)).not.toContain("private");
    },
  );

  it("nothing of dispatch.json except the final check and the open step reaches the snapshot, a checkpoint key in it included", () => {
    const dispatch = { checkpoint: { id: "plan#1", nonce: "SENTINEL-NONCE" }, units: { x: { reviewedCommit: "SENTINEL-COMMIT" } }, finalVerify: { ok: true, head: "SENTINEL-HEAD", reviewed: true, blocking: 0 } };
    const s = snapOf([{ mission: parked(), events: [], ...({ dispatch } as object) }] as never);
    const text = JSON.stringify(s);
    for (const secret of ["SENTINEL-NONCE", "SENTINEL-COMMIT", "SENTINEL-HEAD"]) expect(text, secret).not.toContain(secret);
  });
});
