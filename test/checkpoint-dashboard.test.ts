// T-CHECK-REAL: the real engine, then the real dashboard (docs/checkpoints-spec.md, 13 and 16).
//
// The engine runs on the mock harness until a mission stops for the owner's check. The harness's home is then copied, as
// dashboard-helpers.copyHome copies a fixture, and the dashboard builds its snapshot from the copy. So the card, the lamp
// and the timeline are checked on what the engine really writes, not on files written by hand (src/dashboard/checkpoint.test.ts
// does that), and the engine's scratch state (dispatch.json, the rework fingerprint, the owner's note) is checked not to leak.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyAnswer, MAX_SEND_BACKS } from "../src/checkpoint.js";
import { CHECKPOINT_SEND_BACK_CAP } from "../src/dashboard/constants.js";
import { clearReadCache } from "../src/dashboard/read.js";
import { buildSnapshot } from "../src/dashboard/snapshot.js";
import type { NeedsYouCard, Snapshot } from "../src/dashboard/types.js";
import type { CheckpointKind, Mission, PendingCheckpoint } from "../src/types.js";
import { assertSnapshotShape, copyHomeOf, hashTree } from "./dashboard-helpers.js";
import { type AgentHandler, buildOutput, feature, type HarnessOptions, MissionHarness, writeFile } from "./fixtures/mission-harness.js";

let h: MissionHarness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function harness(opts: HarnessOptions = {}): MissionHarness {
  h = new MissionHarness(opts);
  return h;
}

/** The owner answers, the way `mc approve` and `mc send-back` do while no run is going. */
function answer(hh: MissionHarness, id: string, decision: "approve" | "send_back", note?: string): void {
  const result = applyAnswer(hh.store, id, { decision, ...(note !== undefined && { note }) }, Date.now());
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

/** Runs the mission and checks it stopped for a check of this scope; returns the check. */
async function runToCheck(hh: MissionHarness, id: string, scope: string): Promise<PendingCheckpoint> {
  const m = await hh.run(id);
  expect(m.status).toBe("stopped");
  expect(m.checkpoint).toMatchObject({ scope, state: "pending" });
  return m.checkpoint as PendingCheckpoint;
}

/** The dashboard's snapshot of a copy of the harness's home (the copy is the dashboard's, the engine's home is not touched). */
function snapshotOf(hh: MissionHarness): Snapshot {
  const home = copyHomeOf(hh.home);
  const before = hashTree(home);
  clearReadCache(); // the cache is keyed by inode and size; a new copy can reuse both
  const s = buildSnapshot({ home, now: Date.now(), timeZone: "UTC" });
  assertSnapshotShape(s);
  expect(hashTree(home), "the dashboard left the home as it found it").toBe(before);
  return s;
}

const cardsOf = (s: Snapshot): NeedsYouCard[] => s.needsYou.filter((c) => c.kind === "checkpoint");
const reasonCodes = (s: Snapshot): string[] => s.lamp.reasons.map((r) => r.code);
const timelineTexts = (s: Snapshot): string[] => s.timeline.items.map((i) => i.text);

/** The same engineer as the default, except that a fix round changes something (so a change the owner asked for lands). */
const fixing: AgentHandler = (job, call) =>
  call.label.startsWith("fix-")
    ? { edit: (cwd) => writeFile(cwd, `src/touched-${call.n}.mjs`, `export const n = ${call.n};\n`), structured: buildOutput("changed it") }
    : (h as MissionHarness).defaults.engineer(job, call); // `h` is the harness of the test that is running

function queue(hh: MissionHarness, ...checkpoints: CheckpointKind[]): string {
  return hh.createMission("greenfield", { checkpoints }).id;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) strings(v, out);
  return out;
}

const dispatchOf = (hh: MissionHarness, id: string): unknown => JSON.parse(readFileSync(join(hh.store.missionDir(id), "dispatch.json"), "utf8"));

describe("the plan check, as the dashboard shows it", () => {
  it("is one amber card, one amber lamp reason and one line in the timeline, built from what the engine wrote", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    const cp = await runToCheck(hh, id, "plan");
    const s = snapshotOf(hh);

    expect(s.missions).toHaveLength(1);
    expect(s.missions[0]).toMatchObject({ id, state: "paused", pausedWhy: "checkpoint", scope: "recent", sentence: "Waiting for your check of the plan." });

    const [card, ...others] = cardsOf(s);
    expect(others).toEqual([]);
    expect(s.needsYou).toHaveLength(1);
    expect(card).toMatchObject({
      kind: "checkpoint",
      severity: "look",
      missionId: id,
      featureId: null,
      title: "“Fixture app”: please check the plan",
      ifNothing: "Nothing happens. This mission waits for you. Other work carries on.",
    });
    // The look is the engine's own lines, in order, each one labelled as the AI's (it cannot tell its own words from the AI's).
    expect(card?.lines).toEqual(cp.look.lines.map((text) => ({ text, author: "ai" })));
    expect(card?.lines?.length).toBeGreaterThanOrEqual(3);
    expect(card?.answers).toEqual({
      approve: 'About the check of "Fixture app" (the plan): approved, go ahead.',
      sendBack: 'About the check of "Fixture app" (the plan): send it back. What to change: <your answer here>',
    });
    expect(card?.tellLeader).toBe('About the check of "Fixture app": <your answer here>');
    expect(card?.whatToDo?.text).toBe("Look at it as the report describes, then tell the leader to approve it or send it back.");

    expect(s.lamp).toMatchObject({ state: "needs_look", word: "Needs a look" });
    expect(s.lamp.reasons.filter((r) => r.code === "checkpoint_waiting")).toEqual([
      { code: "checkpoint_waiting", severity: "look", text: "“Fixture app” is waiting for your check", missionId: id, featureId: null },
    ]);
    expect(s.lamp.sentence).toBe("“Fixture app” is waiting for your check.");

    const last = s.timeline.items.at(-1);
    expect(last).toMatchObject({ missionId: id, tone: "warn", text: "Waiting for your check of the plan for “Fixture app”." });
    // A mission that waits has no Results entry yet: "continues on the next run" would not be true of it.
    expect(s.debrief).toBeNull();
  });

  it("turns into a quiet row, with no card and no lamp reason, once the owner has answered and before the next run", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    await runToCheck(hh, id, "plan");
    answer(hh, id, "approve", "plan is fine");
    const s = snapshotOf(hh);

    expect(s.missions[0]).toMatchObject({ state: "paused", pausedWhy: "checkpoint", sentence: "You answered. It continues on the next run." });
    expect(s.needsYou).toEqual([]);
    expect(reasonCodes(s)).not.toContain("checkpoint_waiting");
    expect(timelineTexts(s).slice(-2)).toEqual(["Waiting for your check of the plan for “Fixture app”.", "You approved the plan. “Fixture app” carries on when the next run starts."]);
    expect(s.timeline.items.at(-1)?.tone).toBe("good");
    // The owner's own note is theirs: the snapshot, which the leader and the page read, never carries it.
    expect(JSON.stringify(s)).not.toContain("plan is fine");
  });

  it("is gone once the mission has carried on: no card, no lamp reason, the hidden 'passed' event adds no line", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    await runToCheck(hh, id, "plan");
    answer(hh, id, "approve");
    const before = timelineTexts(snapshotOf(hh));
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    const s = snapshotOf(hh);

    expect(s.missions[0]).toMatchObject({ state: "done", pausedWhy: null });
    expect(s.needsYou).toEqual([]);
    expect(reasonCodes(s)).not.toContain("checkpoint_waiting");
    const texts = timelineTexts(s);
    expect(texts.slice(0, before.length)).toEqual(before);
    // Parked, then answered; the engine's "passed" event is hidden and the next run's lines say nothing of the check.
    expect(texts.filter((t) => /your check|You approved/.test(t))).toEqual(before.filter((t) => /your check|You approved/.test(t)));
    expect(texts.filter((t) => /your check|You approved/.test(t))).toHaveLength(2);
    expect(hh.store.readEvents(id).some((e) => e.type === "checkpoint.passed")).toBe(true);
  });
});

describe("the feature check, as the dashboard shows it", () => {
  it("names the feature, its work branch and the tile that is paused for the check", async () => {
    const hh = harness();
    const id = queue(hh, "feature");
    const cp = await runToCheck(hh, id, "feature:greet");
    const real = hh.load(id);
    const s = snapshotOf(hh);

    const [card] = cardsOf(s);
    expect(cardsOf(s)).toHaveLength(1);
    expect(card).toMatchObject({
      severity: "look",
      featureId: "greet",
      title: "“Fixture app”: please check “Feature greet” before it is added",
      summary: `The work is saved under the name ${real.features[0]?.branch}. The report says how to open it.`,
    });
    expect(card?.lines).toEqual(cp.look.lines.map((text) => ({ text, author: "ai" })));
    expect(card?.lines?.[0]?.text).toBe("“Feature greet” is built and passed its checks, and was reviewed.");
    expect(card?.answers?.approve).toBe('About the check of "Fixture app" (the feature "Feature greet"): approved, go ahead.');
    expect(s.missions[0]?.sentence).toBe("Waiting for your check of “Feature greet”.");
    expect(s.missions[0]?.features.map((f) => [f.id, f.state])).toEqual([
      ["greet", "paused"],
      ["farewell", "waiting_turn"], // the next feature is not started, so it is not "paused" mid-work
    ]);
    expect(s.timeline.items.at(-1)?.text).toBe("Waiting for your check of “Feature greet” before it is added.");
    expect(s.lamp.reasons.map((r) => r.code)).toContain("checkpoint_waiting");
    // The commit and the changed files are the engine's: the dashboard shows neither (the report does).
    const text = JSON.stringify(s);
    expect(cp.look.commit && text.includes(cp.look.commit)).toBeFalsy();
    for (const file of cp.look.files ?? []) expect(text, file).not.toContain(file);
  });

  it("while a send-back is being handled and after it: the rework in the timeline, and nothing of the note or the engine's scratch state", async () => {
    // The engineer's first fix is cut short by a stop, as a stop or a crash would; the second one lands.
    const cutShort: AgentHandler = (job, call) => (call.label === "fix-greet" && call.n === 1 ? { outcome: "aborted" } : fixing(job, call));
    const hh = harness({ agents: { engineer: cutShort } });
    const note = "ZEBRA-4471 make the greeting friendlier";
    const id = queue(hh, "feature");
    await runToCheck(hh, id, "feature:greet");
    const passing = hh.load(id).features[0]?.passingCommit as string;

    // A stop cuts the rework short: the engine now holds its fingerprint (reworkFrom) in the mission file, next to the answer.
    answer(hh, id, "send_back", note);
    const cut = await hh.run(id);
    expect(cut.status).toBe("stopped");
    expect(cut.checkpoint).toMatchObject({ id: "feature:greet#1", state: "answered", reworkFrom: passing });
    const midway = snapshotOf(hh);
    expect(midway.missions[0]).toMatchObject({ state: "paused", pausedWhy: "checkpoint", sentence: "You answered. It continues on the next run." });
    expect(midway.needsYou).toEqual([]);
    expect(reasonCodes(midway)).not.toContain("checkpoint_waiting");

    const again = await runToCheck(hh, id, "feature:greet");
    expect(again).toMatchObject({ id: "feature:greet#2", round: 2 });
    const s = snapshotOf(hh);
    expect(timelineTexts(s).filter((t) => /your check|sent|after your note/.test(t))).toEqual([
      "Waiting for your check of “Feature greet” before it is added.",
      "You sent “Feature greet” back. It is changed and shown to you again.",
      "“Feature greet” was changed after your note.",
      "Waiting for your check of “Feature greet” before it is added.",
    ]);
    expect(cardsOf(s)).toHaveLength(1);
    expect(cardsOf(s)[0]?.summary).not.toContain("sent this back"); // once is below the cap: no warning yet
    expect(reasonCodes(s).filter((c) => c === "checkpoint_waiting")).toHaveLength(1);

    // Nothing the engine keeps for itself travels: not the owner's note, not the fingerprint, not a word of dispatch.json.
    for (const snapshot of [midway, s]) {
      const text = JSON.stringify(snapshot);
      expect(text).not.toContain("ZEBRA-4471");
      expect(text).not.toContain(passing);
      for (const key of ["reworkFrom", "reviewedCommit", "reviewSkipped", "reworkFailed", "notifiedAt", "dispatch.json"]) expect(text, key).not.toContain(key);
      // Every value dispatch.json holds (the commit that was reviewed, the last test output, the git settings), as JSON would write it.
      const scratch = strings(dispatchOf(hh, id))
        .filter((v) => v.length >= 7)
        .map((v) => JSON.stringify(v).slice(1, -1));
      expect(scratch.length).toBeGreaterThanOrEqual(3); // the scan has something to find
      for (const value of scratch) expect(text, value).not.toContain(value);
    }
    expect(readFileSync(join(hh.store.missionDir(id), "dispatch.json"), "utf8")).toContain("reviewedCommit");
  });
});

describe("the final check, as the dashboard shows it", () => {
  it("names the finished app, and the branch the whole work is on", async () => {
    const hh = harness();
    const id = queue(hh, "final");
    const cp = await runToCheck(hh, id, "final");
    const real = hh.load(id);
    expect(real.features.map((f) => f.status)).toEqual(["done", "done"]);
    const s = snapshotOf(hh);

    const [card] = cardsOf(s);
    expect(cardsOf(s)).toHaveLength(1);
    expect(card).toMatchObject({
      severity: "look",
      featureId: null,
      title: "“Fixture app”: please check the finished app",
      summary: `The work is saved under the name ${real.integrationBranch}. The report says how to open it.`,
    });
    expect(card?.lines?.map((l) => l.text)).toEqual(expect.arrayContaining(["All 2 features are built.", "The final checks passed."]));
    expect(card?.lines).toEqual(cp.look.lines.map((text) => ({ text, author: "ai" })));
    expect(s.missions[0]).toMatchObject({ state: "paused", pausedWhy: "checkpoint", sentence: "Waiting for your check of the finished app.", featuresDone: 2, featuresTotal: 2 });
    expect(s.timeline.items.at(-1)?.text).toBe("Waiting for your check of the finished app.");
    expect(s.lamp.state).toBe("needs_look");
    expect(s.debrief).toBeNull();
  });

  it("walks the three checks of one mission: each stop is one card, and the card is gone when the mission carries on", async () => {
    const hh = harness();
    const id = queue(hh, "plan", "feature", "final");
    const seen: string[] = [];
    const stops = ["plan", "feature:greet", "feature:farewell", "final"];
    for (const scope of stops) {
      await runToCheck(hh, id, scope);
      const s = snapshotOf(hh);
      expect(cardsOf(s), scope).toHaveLength(1);
      expect(s.needsYou, scope).toHaveLength(1);
      seen.push(cardsOf(s)[0]?.title ?? "");
      answer(hh, id, "approve");
      expect(snapshotOf(hh).needsYou, `${scope} answered`).toEqual([]);
    }
    expect(seen).toEqual([
      "“Fixture app”: please check the plan",
      "“Fixture app”: please check “Feature greet” before it is added",
      "“Fixture app”: please check “Feature farewell” before it is added",
      "“Fixture app”: please check the finished app",
    ]);
    const done = await hh.run(id);
    expect(done).toMatchObject({ status: "done", stage: "complete" });
    const s = snapshotOf(hh);
    expect(s.missions[0]).toMatchObject({ state: "done", featuresDone: 2 });
    expect(s.needsYou).toEqual([]);
    expect(reasonCodes(s)).not.toContain("checkpoint_waiting");
    expect(s.debrief?.missions[0]?.verdict.id).toBe("done");
  });
});

describe("a plan sent back once too often", () => {
  it("warns before the last showing in both the engine's and the dashboard's words, then reads as the engine's own failure", async () => {
    expect(CHECKPOINT_SEND_BACK_CAP, "the dashboard repeats the engine's cap").toBe(MAX_SEND_BACKS);
    const hh = harness();
    const id = queue(hh, "plan");
    await runToCheck(hh, id, "plan");
    for (const round of [1, 2]) {
      answer(hh, id, "send_back", `change ${round}`);
      await runToCheck(hh, id, "plan");
    }
    const warning = "You have sent this back 2 times. If you send it back again, the work stops here: nothing will be built. You can still approve.";
    const showing = snapshotOf(hh);
    const [card] = cardsOf(showing);
    expect(hh.load(id).checkpoint).toMatchObject({ id: "plan#3", round: 3 });
    expect(card?.summary).toBe(`Nothing is built yet. The report has the whole plan. ${warning}`);
    expect(card?.lines?.at(-1)?.text).toBe(warning);

    answer(hh, id, "send_back", "change 3");
    const failed = await hh.run(id);
    expect(failed).toMatchObject({ status: "failed", stage: "init" });
    expect(failed.checkpoint).toBeUndefined();
    expect(hh.jobs.filter((j) => /^(test|build)-/.test(j.id))).toEqual([]); // nothing was built
    const s = snapshotOf(hh);
    expect(s.missions[0]?.state).toBe("needs_you");
    expect(cardsOf(s)).toEqual([]);
    expect(s.needsYou.map((c) => [c.kind, c.severity])).toEqual([["mission_failed", "now"]]);
    expect(s.needsYou[0]?.happened).toEqual({
      text: "You asked for changes to the plan twice and sent it back a third time, so Mission Control stopped before building anything.",
      author: "engine",
    });
    expect(reasonCodes(s)).not.toContain("checkpoint_waiting");
    expect(timelineTexts(s)).toContain("You sent this back twice before, so “Fixture app” stops here. The report says what to do.");
  });
});

describe("a feature or the finished app sent back once too often", () => {
  it("shows a feature that was set aside as one stuck feature (one card, the engine's words), not as a question and a check", async () => {
    const hh = harness({ features: [feature("greet")], agents: { engineer: fixing } });
    const id = queue(hh, "feature");
    await runToCheck(hh, id, "feature:greet");
    for (const round of [1, 2, 3]) {
      answer(hh, id, "send_back", `change ${round}`);
      const next = await hh.run(id);
      if (round < 3) expect(next.checkpoint).toMatchObject({ id: `feature:greet#${round + 1}`, state: "pending" });
    }
    const end = hh.load(id);
    expect(end).toMatchObject({ status: "partial", stage: "complete" });
    const s = snapshotOf(hh);

    expect(s.needsYou.map((c) => [c.kind, c.featureId])).toEqual([["feature_stuck", "greet"]]); // the decision entry joined the feature's card
    expect(s.needsYou[0]?.happened).toEqual({ text: "You asked for changes twice and it still was not right, so it was set aside.", author: "engine" });
    expect(reasonCodes(s)).not.toContain("checkpoint_waiting");
    expect(s.missions[0]).toMatchObject({ state: "partly_done", pausedWhy: null });
    expect(timelineTexts(s)).toContain("You sent this back twice before, so “Fixture app” stops here. The report says what to do.");
  });

  it("shows the finished app that was kept as it is as a partly done mission with its one question", async () => {
    const hh = harness({ features: [feature("greet")] });
    const id = queue(hh, "final");
    await runToCheck(hh, id, "final");
    for (const round of [1, 2, 3]) {
      answer(hh, id, "send_back", `change ${round}`);
      const next = await hh.run(id);
      if (round < 3) expect(next.checkpoint).toMatchObject({ id: `final#${round + 1}`, state: "pending" });
    }
    expect(hh.load(id)).toMatchObject({ status: "partial", stage: "complete" });
    const s = snapshotOf(hh);

    expect(s.missions[0]).toMatchObject({ state: "partly_done", pausedWhy: null });
    expect(s.needsYou.map((c) => c.kind)).toEqual(["decision"]);
    expect(s.needsYou[0]?.happened.text).toBe("You sent the finished result back twice; it was finalized as it is.");
    expect(reasonCodes(s)).not.toContain("checkpoint_waiting");
    expect(s.debrief?.missions[0]?.verdict.id).toBe("partly_done");
  });
});

describe("a mission that chose no check", () => {
  it("has no card, no lamp reason and no checkpoint line, and a snapshot of the same shape as before", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield").id;
    const m: Mission = await hh.run(id);
    expect(m.status).toBe("done");
    const s = snapshotOf(hh);
    expect(s.needsYou).toEqual([]);
    expect(reasonCodes(s)).not.toContain("checkpoint_waiting");
    expect(timelineTexts(s).some((t) => /check of|your check|you approved|sent .* back/i.test(t))).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/"(?:lines|answers)":/);
  });
});
