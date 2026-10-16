import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerIsRecorded,
  answerNotice,
  applyAnswer,
  checkpointId,
  cleanNote,
  didWhat,
  endState,
  isCheckpointShape,
  isDerivedFeature,
  isLeaderPlanStop,
  isWaitingForCheck,
  lookCommand,
  MAX_LOG_ENTRIES,
  MAX_NOTE_CHARS,
  nextCheckpointState,
  parkedNotice,
  planReviewSentence,
  planReviewShort,
  scopeOf,
  sendBacks,
  subjectOf,
  trimLog,
  waitingWhat,
  whyStopped,
} from "./checkpoint.js";
import { describePlan } from "./plan.js";
import { buildReportFacts, renderReport } from "./report.js";
import { MissionStore } from "./state.js";
import type { CheckpointAnswer, CheckpointKind, CheckpointRecord, Feature, Mission, PendingCheckpoint, PlanReview, PlanSource, SpecOutput } from "./types.js";

let root: string;
let store: MissionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-checkpoint-"));
  store = new MissionStore(join(root, "home"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-12T14:05:00.000Z");

function pending(kind: CheckpointKind = "plan", round = 1, featureId?: string): PendingCheckpoint {
  const scope = scopeOf(kind, featureId);
  return {
    id: checkpointId(scope, round),
    scope,
    kind,
    ...(featureId !== undefined && { featureId }),
    round,
    state: "pending",
    parkedAt: "2026-10-12T13:00:00.000Z",
    look: { headline: "Check it", lines: ["a line"] },
  };
}

function answered(cp: PendingCheckpoint, decision: CheckpointAnswer["decision"] = "approve", note?: string): PendingCheckpoint {
  return { ...cp, state: "answered", answer: { decision, ...(note !== undefined && { note }), at: "2026-10-12T14:00:00.000Z" } };
}

function record(scope: string, decision: CheckpointRecord["decision"], round = 1): CheckpointRecord {
  const kind: CheckpointKind = scope === "plan" ? "plan" : scope === "final" ? "final" : "feature";
  return { id: checkpointId(scope, round), scope, kind, round, decision, at: "2026-10-12T13:30:00.000Z" };
}

/** A queued mission on disk that the owner's checks apply to. */
function mission(fields: Partial<Mission> = {}): Mission {
  const m = store.createMission({ kind: "greenfield", title: "Shout", request: "Build shout", repoPath: "", baseBranch: "main", profile: "mixed", checkpoints: ["plan", "feature", "final"], nowMs: NOW });
  Object.assign(m, { status: "stopped", stage: "features" }, fields);
  store.save(m, NOW);
  return m;
}

describe("names and small helpers", () => {
  it("builds scopes and ids", () => {
    expect(scopeOf("plan")).toBe("plan");
    expect(scopeOf("final")).toBe("final");
    expect(scopeOf("feature", "add-shout")).toBe("feature:add-shout");
    expect(checkpointId("feature:add-shout", 2)).toBe("feature:add-shout#2");
  });

  it("knows the features the engine adds by itself", () => {
    expect(isDerivedFeature("gate-c-fix-1")).toBe(true);
    expect(isDerivedFeature("owner-change-2")).toBe(true);
    expect(isDerivedFeature("add-shout")).toBe(false);
  });

  it("keeps a note on one line without control characters", () => {
    expect(cleanNote("  make it\n\tbigger\u001b[2J \u0007 please  ")).toBe("make it bigger[2J please");
  });

  it("trims the log from the oldest feature entries, keeping plan and final answers", () => {
    const log = [record("plan", "approve"), ...Array.from({ length: MAX_LOG_ENTRIES + 4 }, (_, i) => record(`feature:f${i}`, "approve")), record("final", "approve")];
    const trimmed = trimLog(log);
    expect(trimmed).toHaveLength(MAX_LOG_ENTRIES);
    expect(trimmed[0]?.scope).toBe("plan");
    expect(trimmed.at(-1)?.scope).toBe("final");
    expect(trimmed.some((r) => r.scope === "feature:f0")).toBe(false);
    expect(trimmed.some((r) => r.scope === `feature:f${MAX_LOG_ENTRIES + 3}`)).toBe(true);
    expect(trimLog(log.slice(0, 5))).toHaveLength(5);
  });

  it("counts send-backs and recognises a damaged record", () => {
    const m = { checkpointLog: [record("plan", "send_back"), record("plan", "send_back", 2), record("final", "send_back"), record("plan", "approve", 3)] };
    expect(sendBacks(m, "plan")).toBe(2);
    expect(sendBacks({}, "plan")).toBe(0);
    expect(isCheckpointShape(pending())).toBe(true);
    for (const bad of [undefined, null, [], "x", { ...pending(), kind: "other" }, { ...pending(), round: 0 }, { ...pending(), state: "waiting" }, { ...pending(), look: undefined }, { ...pending(), answer: { decision: "yes", at: "x" } }]) {
      expect(isCheckpointShape(bad)).toBe(false);
    }
  });

  it("waits only while pending and not complete", () => {
    expect(isWaitingForCheck({ stage: "features", checkpoint: pending() })).toBe(true);
    expect(isWaitingForCheck({ stage: "features", checkpoint: answered(pending()) })).toBe(false);
    expect(isWaitingForCheck({ stage: "features" })).toBe(false);
    expect(isWaitingForCheck({ stage: "complete", checkpoint: pending() })).toBe(false);
    expect(isWaitingForCheck({ stage: "features", checkpoint: { ...pending(), round: -1 } })).toBe(false);
  });
});

describe("nextCheckpointState: what the dispatcher does at a gate", () => {
  const all: CheckpointKind[] = ["plan", "feature", "final"];
  const log = (...r: CheckpointRecord[]) => ({ checkpoints: all, checkpointLog: r });

  it.each<[string, Parameters<typeof nextCheckpointState>, unknown]>([
    ["no checkpoints chosen: carry on", [{}, "plan", undefined, false], { step: "go" }],
    ["this kind not chosen: carry on", [{ checkpoints: ["final"] }, "plan", undefined, false], { step: "go" }],
    ["a feature the engine added itself: carry on", [{ checkpoints: all }, "feature", "gate-c-fix-1", false], { step: "go" }],
    ["a feature gate with no feature: carry on", [{ checkpoints: all }, "feature", undefined, false], { step: "go" }],
    ["already approved: carry on", [log(record("plan", "approve")), "plan", undefined, false], { step: "go" }],
    ["nothing waiting: ask, round 1", [{ checkpoints: all }, "plan", undefined, false], { step: "ask", round: 1 }],
    ["asked twice before: round 3", [log(record("plan", "send_back"), record("plan", "send_back", 2)), "plan", undefined, false], { step: "ask", round: 3 }],
    ["another feature's approval does not count", [log(record("feature:a", "approve")), "feature", "b", false], { step: "ask", round: 1 }],
    ["a check for another scope is in the way: drop it, ask", [{ checkpoints: all, checkpoint: pending("final") }, "plan", undefined, false], { step: "ask", round: 1, drop: "stale" }],
    ["a damaged check is in the way: drop it, ask", [{ checkpoints: all, checkpoint: { id: "plan#1" } as PendingCheckpoint }, "plan", undefined, false], { step: "ask", round: 1, drop: "shape" }],
    ["still waiting: park again", [{ checkpoints: all, checkpoint: pending() }, "plan", undefined, false], { step: "stay" }],
    ["answered with no record: forged", [{ checkpoints: all, checkpoint: answered(pending()) }, "plan", undefined, false], { step: "forged" }],
    ["answered without an answer: forged", [{ checkpoints: all, checkpoint: { ...pending(), state: "answered" } }, "plan", undefined, true], { step: "forged" }],
    ["approved with a record: pass", [{ checkpoints: all, checkpoint: answered(pending()) }, "plan", undefined, true], { step: "pass" }],
    ["sent back for the first time: rework, change 1", [{ checkpoints: all, checkpoint: answered(pending(), "send_back", "x") }, "plan", undefined, true], { step: "rework", change: 1 }],
    [
      "sent back the second time: rework, change 2",
      [{ checkpoints: all, checkpointLog: [record("plan", "send_back")], checkpoint: answered(pending("plan", 2), "send_back", "x") }, "plan", undefined, true],
      { step: "rework", change: 2 },
    ],
    [
      "sent back the third time: the limit",
      [{ checkpoints: all, checkpointLog: [record("plan", "send_back"), record("plan", "send_back", 2)], checkpoint: answered(pending("plan", 3), "send_back", "x") }, "plan", undefined, true],
      { step: "limit" },
    ],
    [
      "a feature's send-backs are counted per feature",
      [{ checkpoints: all, checkpointLog: [record("feature:b", "send_back"), record("feature:b", "send_back", 2)], checkpoint: answered(pending("feature", 1, "a"), "send_back", "x") }, "feature", "a", true],
      { step: "rework", change: 1 },
    ],
  ])("%s", (_name, args, expected) => {
    expect(nextCheckpointState(...args)).toEqual(expected);
  });
});

describe("applyAnswer", () => {
  it("records an approval: event first, then the mission, with nothing but what the owner said", () => {
    const m = mission({ checkpoint: pending("feature", 2, "add-shout") });
    const order: string[] = [];
    const appendEvent = store.appendEvent.bind(store);
    const save = store.save.bind(store);
    vi.spyOn(store, "appendEvent").mockImplementation((...args) => (order.push("event"), appendEvent(...args)));
    vi.spyOn(store, "save").mockImplementation((...args) => (order.push("save"), save(...args)));

    const result = applyAnswer(store, m.id, { decision: "approve", note: " looks  fine\n" }, NOW);

    expect(order).toEqual(["event", "save"]);
    expect(result).toMatchObject({ ok: true, change: 1, limit: false });
    const cp = store.load(m.id).checkpoint;
    expect(cp).toMatchObject({ id: "feature:add-shout#2", state: "answered", answer: { decision: "approve", note: "looks fine", at: "2026-10-12T14:05:00.000Z" } });
    expect(Object.keys(cp?.answer ?? {}).sort()).toEqual(["at", "decision", "note"]);
    const events = store.readEvents(m.id).filter((e) => e.type === "checkpoint.answered");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({ id: "feature:add-shout#2", kind: "feature", feature: "add-shout", decision: "approve", round: 2, at: "2026-10-12T14:05:00.000Z" });
    expect(JSON.stringify(events)).not.toContain("looks fine"); // the note stays out of the event log
  });

  it("an approval without a note has no note key", () => {
    const m = mission({ checkpoint: pending() });
    applyAnswer(store, m.id, { decision: "approve" }, NOW);
    expect(store.load(m.id).checkpoint?.answer).toEqual({ decision: "approve", at: "2026-10-12T14:05:00.000Z" });
  });

  it("tells a send-back which change it is and when it is one too many", () => {
    const first = mission({ checkpoint: pending() });
    expect(applyAnswer(store, first.id, { decision: "send_back", note: "x" }, NOW)).toMatchObject({ ok: true, change: 1, limit: false });
    const second = mission({ checkpointLog: [record("plan", "send_back")], checkpoint: pending("plan", 2) });
    expect(applyAnswer(store, second.id, { decision: "send_back", note: "x" }, NOW)).toMatchObject({ ok: true, change: 2, limit: false });
    const third = mission({ checkpointLog: [record("plan", "send_back"), record("plan", "send_back", 2)], checkpoint: pending("plan", 3) });
    expect(applyAnswer(store, third.id, { decision: "send_back", note: "x" }, NOW)).toMatchObject({ ok: true, change: 3, limit: true });
  });

  it.each<[string, Partial<Mission>, { decision: "approve" | "send_back"; note?: string }, unknown]>([
    ["nothing is waiting", {}, { decision: "approve" }, { ok: false, reason: "not_waiting" }],
    ["the mission is complete", { stage: "complete", checkpoint: pending() }, { decision: "approve" }, { ok: false, reason: "not_waiting" }],
    ["the record is damaged", { checkpoint: { id: "plan#1" } as PendingCheckpoint }, { decision: "approve" }, { ok: false, reason: "damaged" }],
    ["it was answered already", { checkpoint: answered(pending(), "send_back", "x") }, { decision: "approve" }, { ok: false, reason: "already_answered", decision: "send_back", at: "2026-10-12T14:00:00.000Z" }],
    ["an answered record has no answer", { checkpoint: { ...pending(), state: "answered" } }, { decision: "approve" }, { ok: false, reason: "damaged" }],
    ["a send-back has no note", { checkpoint: pending() }, { decision: "send_back" }, { ok: false, reason: "no_note" }],
    ["a send-back note is only spaces", { checkpoint: pending() }, { decision: "send_back", note: " \n " }, { ok: false, reason: "no_note" }],
    ["the note is too long", { checkpoint: pending() }, { decision: "approve", note: "x".repeat(MAX_NOTE_CHARS + 1) }, { ok: false, reason: "note_too_long" }],
  ])("records nothing when %s", (_name, fields, input, expected) => {
    const m = mission(fields);
    const before = JSON.stringify(store.load(m.id));
    expect(applyAnswer(store, m.id, input, NOW)).toEqual(expected);
    expect(JSON.stringify(store.load(m.id))).toBe(before);
    expect(store.readEvents(m.id).some((e) => e.type === "checkpoint.answered")).toBe(false);
  });

  it("accepts a note of exactly the longest length", () => {
    const m = mission({ checkpoint: pending() });
    expect(applyAnswer(store, m.id, { decision: "send_back", note: "x".repeat(MAX_NOTE_CHARS) }, NOW).ok).toBe(true);
  });

  it("is applied once however often it is asked: the second answer says it was answered", () => {
    const m = mission({ checkpoint: pending() });
    expect(applyAnswer(store, m.id, { decision: "approve" }, NOW).ok).toBe(true);
    expect(applyAnswer(store, m.id, { decision: "approve" }, NOW + 1000)).toMatchObject({ ok: false, reason: "already_answered", decision: "approve" });
    expect(store.readEvents(m.id).filter((e) => e.type === "checkpoint.answered")).toHaveLength(1);
  });

  it("survives a crash between the event and the save: the check still waits and the answer can be given again", () => {
    const m = mission({ checkpoint: pending() });
    const save = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementationOnce(() => {
      throw new Error("power cut");
    });
    expect(() => applyAnswer(store, m.id, { decision: "approve" }, NOW)).toThrow("power cut");
    expect(store.load(m.id).checkpoint?.state).toBe("pending");
    expect(store.readEvents(m.id).filter((e) => e.type === "checkpoint.answered")).toHaveLength(1);

    vi.spyOn(store, "save").mockImplementation(save);
    expect(applyAnswer(store, m.id, { decision: "approve" }, NOW + 5000).ok).toBe(true);
    expect(store.load(m.id).checkpoint?.state).toBe("answered");
    const cp = store.load(m.id).checkpoint;
    // Both events exist, but only the one that matches the saved answer counts.
    expect(answerIsRecorded(cp as PendingCheckpoint, store.readEvents(m.id))).toBe(true);
  });
});

describe("answerIsRecorded: the cross-check against hand edits", () => {
  const cp = answered(pending("feature", 1, "a"), "approve");
  const event = (data: Record<string, unknown>) => [{ at: "x", missionId: "m", type: "checkpoint.answered", data }];
  const good = { id: "feature:a#1", decision: "approve", at: "2026-10-12T14:00:00.000Z" };

  it("believes an answer whose id, decision and time match an event", () => {
    expect(answerIsRecorded(cp, event(good))).toBe(true);
  });

  it.each([
    ["another checkpoint's id", { ...good, id: "feature:a#2" }],
    ["another decision", { ...good, decision: "send_back" }],
    ["another time", { ...good, at: "2026-10-12T14:00:01.000Z" }],
  ])("does not believe an event with %s", (_name, data) => {
    expect(answerIsRecorded(cp, event(data))).toBe(false);
  });

  it("does not believe an event of another type, or no event, or no answer", () => {
    expect(answerIsRecorded(cp, [{ at: "x", missionId: "m", type: "checkpoint.parked", data: good }])).toBe(false);
    expect(answerIsRecorded(cp, [])).toBe(false);
    expect(answerIsRecorded(pending(), event(good))).toBe(false);
  });
});

describe("texts", () => {
  const m = { title: "Shout", id: "2026-10-12-shout", features: [{ id: "add-shout", title: "Add shout" }] } as unknown as Mission;

  it("names what a check is about", () => {
    expect(subjectOf(m, pending())).toBe("the plan");
    expect(subjectOf(m, pending("feature", 1, "add-shout"))).toBe("“Add shout”");
    expect(subjectOf(m, pending("final"))).toBe("the finished app");
    expect(waitingWhat(m, pending("feature", 1, "add-shout"))).toBe("“Add shout”, before it is added");
    expect(waitingWhat(m, pending())).toBe("the plan");
    expect(subjectOf(m, pending("feature", 1, "gone"))).toBe("“gone”");
  });

  it("writes the phone notice with the commands that answer it", () => {
    const notice = parkedNotice(m, pending());
    expect(notice.title).toBe("Shout: please check the plan");
    expect(notice.message).toBe(
      'The team stopped because you asked to look at the plan first. Read it with: mc report 2026-10-12-shout. Then run: mc approve 2026-10-12-shout, or: mc send-back 2026-10-12-shout --note "what to change". Nothing else is waiting on this; other work carries on.',
    );
    expect(parkedNotice(m, pending("feature", 1, "add-shout")).title).toBe("Shout: please check “Add shout” before it is added");
    expect(parkedNotice(m, pending("final")).title).toBe("Shout: please check the finished app");
    expect(parkedNotice(m, pending(), true).message).toMatch(/^An answer was found in this mission's file that was not given with mc approve or mc send-back, so it was ignored\. The team stopped/);
  });

  it("confirms an answer without repeating the note", () => {
    const notice = answerNotice(m, answered(pending(), "send_back", "secret words"), { decision: "send_back", note: "secret words", at: "2026-10-12T14:05:00.000Z" });
    expect(notice.title).toBe("Shout: your answer was recorded");
    expect(notice.message).toMatch(/^You sent the plan for “Shout” back at \d\d:\d\d\. It continues on the next run\.$/);
    expect(notice.message).not.toContain("secret");
  });

  it("names the feature once when it has the mission's own title, and the mission otherwise (real run R2)", () => {
    const twin = { ...m, title: "Add shout" } as Mission;
    expect(didWhat(twin, pending("feature", 1, "add-shout"), "approve")).toBe("you approved “Add shout”");
    expect(didWhat(twin, pending("feature", 1, "add-shout"), "send_back")).toBe("you sent “Add shout” back");
    expect(answerNotice(twin, answered(pending("feature", 1, "add-shout"), "approve"), { decision: "approve", at: "2026-10-12T14:05:00.000Z" }).message).toMatch(/^You approved “Add shout” at \d\d:\d\d\. It continues on the next run\.$/);
    // another title, the plan and the finished app keep the longer words
    expect(didWhat(m, pending("feature", 1, "add-shout"), "approve")).toBe("you approved “Add shout” for “Shout”");
    expect(didWhat(m, pending(), "approve")).toBe("you approved the plan for “Shout”");
    expect(didWhat(m, pending("final"), "send_back")).toBe("you sent the finished app for “Shout” back");
  });

  it("strips control characters out of AI-written titles", () => {
    const dirty = { ...m, title: "Sho\u001b]52;;x\u0007ut" } as Mission;
    expect(parkedNotice(dirty, pending()).title).toBe("Shout: please check the plan".replace("Shout", "Sho]52;;xut"));
  });

  it("says how each kind ends when it is sent back once too often", () => {
    expect(endState("plan")).toBe("nothing will be built");
    expect(endState("feature")).toBe("this feature is set aside and the rest carries on");
    expect(endState("final")).toBe("the finished result is kept as it is");
  });
});

describe("the report", () => {
  const render = (m: Mission) => renderReport(m, { usage: [], screenshots: [], generatedAt: "2026-10-12T14:00:00.000Z", inContainer: false });
  const shout = (status: Feature["status"], id = "add-shout"): Feature => ({
    id,
    title: "Add shout",
    story: "s",
    acceptance: [],
    kind: "standard",
    deps: [],
    status,
    rung: 0,
    attempts: [],
    frozenTests: [],
    reviewRounds: 0,
    openFindings: [],
  });

  function parkedMission(checkpoint: PendingCheckpoint | undefined, fields: Partial<Mission> = {}): Mission {
    return mission({ repoPath: join(root, "app"), features: [shout("reviewing")], ...(checkpoint && { checkpoint }), ...fields });
  }

  it("puts the waiting check first, with what to look at and the two ways to answer", () => {
    const cp = { ...pending(), look: { headline: "Check the plan for “Shout”", lines: ["The plan has 1 feature: Add shout.", "“Add shout”: Shout the text."] } };
    const report = render(parkedMission(cp, { stage: "init" }));
    expect(report.startsWith("## Waiting for your check\n\n")).toBe(true);
    expect(report).toContain("The team stopped here on purpose, because you asked to look at the plan first. Nothing else is waiting on this mission; other work carries on.");
    expect(report).toContain("**Check the plan for “Shout”**\n\n- The plan has 1 feature: Add shout.\n- “Add shout”: Shout the text.");
    expect(report).toMatch(/- \*\*Approve\*\* lets the team carry on from here: `mc approve [^`]+`\./);
    expect(report).toMatch(/- \*\*Send back\*\* with what to change: `mc send-back [^`]+ --note "what to change"`\. The planner revises the plan with your note, then shows it to you again\. You can do this 2 more times\./);
    expect(report).toContain("**Waiting for your check** ·"); // the status line under the title
    expect(report).toContain("I stopped here on purpose, so you can look at it before I go on.");
    expect(report).not.toContain("To look at it yourself:"); // there is nothing to open yet
    expect(report.indexOf("# Shout")).toBeGreaterThan(report.indexOf("## Waiting for your check"));
  });

  it("keeps a line that starts with spaces under the bullet before it, and makes a bullet of every other line (R3-8)", () => {
    const lines = ["First fact.", "The reviewer asked for a long list of changes, so", "  this is the rest of the same sentence,", "  and the end of it.", "Second fact.", "  piece of the second.", "Check for “Add shout”: a check."];
    const cp = { ...pending(), look: { headline: "Check the plan for “Shout”", lines } };
    const report = render(parkedMission(cp, { stage: "init" }));
    expect(report).toContain(
      "**Check the plan for “Shout”**\n\n- First fact.\n- The reviewer asked for a long list of changes, so\n  this is the rest of the same sentence,\n  and the end of it.\n- Second fact.\n  piece of the second.\n- Check for “Add shout”: a check.",
    );
    // a first line that starts with spaces is still a bullet, and plain lines are as they were
    const odd = render(parkedMission({ ...pending(), look: { headline: "h", lines: ["  starts with spaces", "next"] } }, { stage: "init" }));
    expect(odd).toContain("**h**\n\n- starts with spaces\n- next");
  });

  it("tells the owner how to open a feature that waits to be added, and how to put the folder back", () => {
    const cp = { ...pending("feature", 1, "add-shout"), look: { headline: "Check “Add shout” before it is added", lines: ["It works."], branch: "mc/2026-10-12-shout--add-shout", commit: "abc1234567", files: ["src/shout.js", "tests/shout.test.js"] } };
    const report = render(parkedMission(cp));
    expect(report).toContain("Files that changed: `src/shout.js` and `tests/shout.test.js`.");
    expect(report).toContain("To look at it yourself:");
    expect(report).toContain("2. `git checkout --detach mc/2026-10-12-shout--add-shout`: switch to the version with the new work");
    expect(report).toContain("press Ctrl+C to stop the app");
    expect(report).toContain("put the folder back on your own version with `git checkout main`");
    expect(report).toContain("The team changes it with your note, a second AI looks again, then it is shown to you again.");
  });

  it("does not send the owner to a main branch that has not moved yet", () => {
    const final = { ...pending("final"), look: { headline: "Check", lines: ["a"], branch: "mc/some-branch" } };
    const parked = parkedMission(final, { stage: "finalize", features: [shout("done")] });
    const report = render(parked);
    const tryIt = report.slice(report.indexOf("## How to try it"));
    expect(tryIt).toContain(`\`git checkout --detach ${parked.integrationBranch}\``); // the id carries the local date, so don't spell it out
    // Once finished, main follows the work and no checkout is needed (as before).
    const finished = render(parkedMission(undefined, { stage: "complete", status: "done", features: [shout("done")] }));
    expect(finished.slice(finished.indexOf("## How to try it"))).not.toContain("git checkout --detach");
  });

  it("warns that one more send-back ends the work, in the engine's words", () => {
    const cp = pending("final", 3);
    const report = render(parkedMission(cp, { checkpointLog: [record("final", "send_back"), record("final", "send_back", 2)] }));
    expect(report).toContain("Sending it back again stops the work here: the finished result is kept as it is.");
  });

  it("says an answer is recorded while the mission has not carried on yet", () => {
    const report = render(parkedMission(answered(pending(), "send_back", "make it bigger")));
    expect(report.startsWith("## Your answer is recorded\n\nYou sent the plan back at ")).toBe(true);
    expect(report).toContain("when the mission runs next:");
    expect(report).not.toContain("## Waiting for your check");
    expect(report).not.toContain("make it bigger"); // the note is in the log table once it is handled, not here
  });

  it("lists every answer in a table, with feature names and the owner's notes kept to one cell", () => {
    const report = render(
      parkedMission(undefined, {
        checkpointLog: [
          { ...record("plan", "approve"), note: "fine | really" },
          { ...record("feature:add-shout", "send_back", 1), kind: "feature", featureId: "add-shout", note: "louder" },
          { ...record("final", "approve"), kind: "final" },
        ],
      }),
    );
    expect(report).toContain("## Your checks\n\n| What you checked | Your answer | When | Your note |\n|---|---|---|---|\n| The plan | Approved |");
    expect(report).toContain("fine \\| really |");
    expect(report).toMatch(/\| “Add shout” \| Sent back \| [^|]+ \| louder \|/);
    expect(report).toMatch(/\| The finished app \| Approved \|/);
    expect(report).not.toContain("## Waiting for your check");
  });

  it("is the same report as before for a mission with no checks, and its fact sheet for the AI never mentions one", () => {
    const plain = mission({ checkpoints: undefined, features: [shout("done", "f1")], status: "done", stage: "complete" });
    const report = render(plain);
    expect(report).not.toMatch(/Waiting for your check|Your checks|Your answer is recorded/);
    expect(report.startsWith("# Shout\n")).toBe(true);

    const waiting = parkedMission({ ...pending(), look: { headline: "Check", lines: ["a"] } }, { checkpointLog: [record("plan", "send_back")] });
    const facts = buildReportFacts(waiting, []);
    expect(facts).not.toMatch(/check|waiting|approve|send back/i);
    expect(facts).toContain("Status: Paused, continues on the next run (stopped).");
  });
});

// ───────────────────────────── A plan written outside the team ─────────────────────────────

describe("a plan written outside the team", () => {
  const plan: PlanSource = {
    spec: { appName: "Shout", summary: "Shouts.", features: [], assumptions: [], uiContract: "" },
    sha256: `a4adaca5${"0".repeat(56)}`,
    at: "2026-10-12T09:00:00.000Z",
  };
  const m = { title: "Shout", id: "2026-10-12-shout", features: [{ id: "add-shout", title: "Add shout" }], plan } as unknown as Mission;
  const old = { ...m, plan: undefined } as unknown as Mission;
  const render = (mission: Mission) => renderReport(mission, { usage: [], screenshots: [], generatedAt: "2026-10-12T14:00:00.000Z", inContainer: false });

  it("sends the owner to mc plan show at the plan stop, in the notice, the report and the commands, and nowhere else", () => {
    expect(isLeaderPlanStop(m, pending())).toBe(true);
    expect(isLeaderPlanStop(m, pending("feature", 1, "add-shout"))).toBe(false);
    expect(isLeaderPlanStop(old, pending())).toBe(false);
    expect(whyStopped(m, pending())).toBe("the leader wrote this plan, and you look at such a plan first. Read all of it with: mc plan show 2026-10-12-shout");
    expect(whyStopped(m, pending("final"))).toBe("you asked to look at the finished app first");
    expect(whyStopped(old, pending("feature", 1, "add-shout"))).toBe("you asked to look at “Add shout” before it is added first");
    expect(lookCommand(m, pending())).toBe("mc plan show 2026-10-12-shout");
    expect(lookCommand(m, pending("final"))).toBe("mc report 2026-10-12-shout");
    expect(lookCommand(old, pending())).toBe("mc report 2026-10-12-shout");
    expect(lookCommand(m, undefined)).toBe("mc report 2026-10-12-shout");
    expect(parkedNotice(m, pending()).message).toBe(
      'The team stopped because the leader wrote this plan, and you look at such a plan first. Read all of it with: mc plan show 2026-10-12-shout. Then run: mc approve 2026-10-12-shout, or: mc send-back 2026-10-12-shout --note "what to change". Nothing else is waiting on this; other work carries on.',
    );
    expect(parkedNotice(m, pending()).title).toBe("Shout: please check the plan");
    // a stop the owner chose for the feature or the finished app of a plan mission keeps the old words
    expect(parkedNotice(m, pending("final")).message).toContain("The team stopped because you asked to look at the finished app first. Read it with: mc report 2026-10-12-shout. Then run:");
    expect(parkedNotice(old, pending()).message).toContain("The team stopped because you asked to look at the plan first. Read it with: mc report 2026-10-12-shout. Then run:");
  });

  it("words the plan reviewer's answer in full and short", () => {
    const answers: PlanReview[] = [
      { outcome: "approved", issues: [] },
      { outcome: "revised", issues: ["a", "b", "c", "d"] },
      { outcome: "not_applied", issues: ["Ask."] },
      { outcome: "unfinished", issues: [] },
    ];
    expect(answers.map((a) => planReviewSentence(a))).toEqual([
      "The team's plan reviewer read it and asked for no changes.",
      "The team's plan reviewer asked for changes, so the team's planner revised the plan. This is the revised plan. It asked: a; b; c and 1 more.",
      "The team's plan reviewer asked for changes that could not be applied, so the plan is as the leader wrote it. It asked: Ask.",
      "The team's plan reviewer did not finish, so the plan is as the leader wrote it.",
    ]);
    expect(answers.map((a) => planReviewShort(a))).toEqual([
      "the team's plan reviewer asked for no changes.",
      "the team's plan reviewer asked for changes and the planner revised it.",
      "the team's plan reviewer asked for changes that could not be applied.",
      "the team's plan reviewer did not finish.",
    ]);
  });

  it("puts the plan, who wrote it and what its reviewer did under the title of the report, and only for such a plan", () => {
    const withReview = (outcome: "approved" | "revised" | "not_applied" | "unfinished"): Mission => mission({ plan: { ...plan, review: { outcome, issues: [] } }, features: [] });
    expect(render(mission({ plan, features: [] }))).toContain("\n\nPlan: written by the leader (plan code a4adaca5).\n");
    expect(render(withReview("approved"))).toContain("\n\nPlan: written by the leader (plan code a4adaca5); the team's plan reviewer asked for no changes.\n");
    expect(render(withReview("revised"))).toContain("(plan code a4adaca5); the team's plan reviewer asked for changes and the planner revised it.\n");
    expect(render(withReview("not_applied"))).toContain("; the team's plan reviewer asked for changes that could not be applied.\n");
    expect(render(withReview("unfinished"))).toContain("; the team's plan reviewer did not finish.\n");
    expect(render(mission({ features: [] }))).not.toContain("Plan: written by the leader");
    // a damaged plan field is no plan
    expect(render(mission({ plan: "x" as unknown as PlanSource, features: [] }))).not.toContain("Plan: written by the leader");
  });

  it("says who wrote the plan inside the first 40 lines of the report, above the look, for a plan of any size", () => {
    // Ten features with twenty checks each, the biggest plan there is: its look is hundreds of lines.
    const ten: SpecOutput = {
      appName: "Big app",
      summary: "Does a lot.",
      assumptions: ["A choice."],
      uiContract: "- Name one.",
      features: Array.from({ length: 10 }, (_, i) => ({
        id: `part-${i}`,
        title: `Part ${i}`,
        story: `Story ${i}.`,
        acceptance: Array.from({ length: 20 }, (_c, c) => `Part ${i} check ${c} works.`),
        kind: "standard" as const,
        deps: [],
      })),
    };
    const lines = describePlan(ten, { request: "Build it.", style: "look" });
    expect(lines.length).toBeGreaterThan(200);
    const big: PlanSource = { ...plan, spec: ten, review: { outcome: "approved", issues: [] } };
    const parked = mission({ plan: big, stage: "init", checkpoint: { ...pending(), look: { headline: "Check the plan for “Big app”", lines } }, features: [] });
    const reportLines = render(parked).split("\n");
    const planAt = reportLines.findIndex((l) => l.startsWith("Plan: written by the leader (plan code a4adaca5)"));
    expect(reportLines[planAt]).toBe("Plan: written by the leader (plan code a4adaca5); the team's plan reviewer asked for no changes.");
    expect(planAt).toBeGreaterThanOrEqual(0);
    expect(planAt).toBeLessThan(40);
    // above the look, and the owner's two answers are still in the first lines too
    expect(planAt).toBeLessThan(reportLines.findIndex((l) => l.startsWith("**Check the plan for")));
    expect(reportLines.slice(0, 40).join("\n")).toContain(`mc approve ${parked.id}`);
    expect(reportLines.slice(0, 40).join("\n")).toContain(`mc send-back ${parked.id}`);
    // said once, not again under the title further down
    expect(reportLines.filter((l) => l.startsWith("Plan: written by the leader"))).toHaveLength(1);
    // once the check is answered there is no look, and the line is under the title as before
    const after = render(mission({ plan: big, stage: "init", checkpoint: answered(pending()), features: [] })).split("\n");
    const afterAt = after.findIndex((l) => l.startsWith("Plan: written by the leader"));
    expect(afterAt).toBeGreaterThanOrEqual(0);
    expect(afterAt).toBeLessThan(40);
  });

  it("says in the waiting block why the team stopped, and where to read all of the plan; an owner's own stop reads as before", () => {
    const cp = { ...pending(), look: { headline: "Check the plan for “Shout”", lines: ["a"] } };
    const parked = mission({ plan, stage: "init", checkpoint: cp, features: [] });
    expect(render(parked)).toContain(
      `The team stopped here on purpose, because the leader wrote this plan, and you look at such a plan first. Read all of it with: mc plan show ${parked.id}. Nothing else is waiting on this mission; other work carries on.`,
    );
    expect(render(parked)).not.toContain("because you asked to look at");
    expect(render(mission({ stage: "init", checkpoint: cp, features: [] }))).toContain(
      "The team stopped here on purpose, because you asked to look at the plan first. Nothing else is waiting on this mission; other work carries on.",
    );
    const stage = { id: "add-shout", title: "Add shout", story: "s", acceptance: [], kind: "standard", deps: [], status: "reviewing", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] } satisfies Feature;
    const feature = { ...pending("feature", 1, "add-shout"), look: { headline: "Check", lines: ["a"] } };
    expect(render(mission({ plan, checkpoint: feature, features: [stage] }))).toContain("because you asked to look at “Add shout”, before it is added first.");
  });
});

// ───────────────────────────── Stops the plan asks for (docs/modes-spec.md 5.2 step 8 and 10.2 line 8) ─────────────────────────────

describe("a stop at a feature that the plan marks for the owner's look", () => {
  const all: CheckpointKind[] = ["plan", "feature", "final"];
  const feature = (id: string, fields: Partial<Feature> = {}): Feature => ({
    id,
    title: `Title of ${id}`,
    story: "s",
    acceptance: ["a", "b"],
    kind: "standard",
    deps: [],
    status: "reviewing",
    rung: 0,
    attempts: [],
    frozenTests: [],
    reviewRounds: 0,
    openFindings: [],
    ...fields,
  });

  it("the fifth parameter of nextCheckpointState says whether the gate stops, and defaults to the old rule", () => {
    // the default is the owner's choice of this kind of check, exactly as before
    expect(nextCheckpointState({}, "feature", "a", false)).toEqual({ step: "go" });
    expect(nextCheckpointState({ checkpoints: all }, "feature", "a", false)).toEqual({ step: "ask", round: 1 });
    expect(nextCheckpointState({ checkpoints: ["plan"] }, "feature", "a", false)).toEqual({ step: "go" });
    // a gate that the plan asks for, with no choice of the owner's
    expect(nextCheckpointState({}, "feature", "a", false, true)).toEqual({ step: "ask", round: 1 });
    expect(nextCheckpointState({ checkpoints: all }, "feature", "a", false, false)).toEqual({ step: "go" });
    // the rest of the machine is the same: waiting, approved, sent back, the limit, a feature the engine added itself
    const waiting = { checkpoint: pending("feature", 1, "a") };
    expect(nextCheckpointState(waiting, "feature", "a", false, true)).toEqual({ step: "stay" });
    expect(nextCheckpointState({ checkpoint: answered(pending("feature", 1, "a")) }, "feature", "a", true, true)).toEqual({ step: "pass" });
    expect(nextCheckpointState({ checkpointLog: [record("feature:a", "approve")] }, "feature", "a", false, true)).toEqual({ step: "go" });
    expect(nextCheckpointState({ checkpoint: answered(pending("feature", 1, "a"), "send_back", "x") }, "feature", "a", true, true)).toEqual({ step: "rework", change: 1 });
    expect(nextCheckpointState({}, "feature", "gate-c-fix-1", false, true)).toEqual({ step: "go" });
  });

  it("the sixth parameter lets the final repair that changed approved work through the machine, and nothing else changes", () => {
    // by default a feature the engine added itself still carries on, even when the gate says it asks
    expect(nextCheckpointState({}, "feature", "gate-c-fix-1", false, true, false)).toEqual({ step: "go" });
    expect(nextCheckpointState({}, "feature", "owner-change-1", false, true, false)).toEqual({ step: "go" });
    // with it, the repair is asked about like any other feature
    expect(nextCheckpointState({}, "feature", "gate-c-fix-1", false, true, true)).toEqual({ step: "ask", round: 1 });
    expect(nextCheckpointState({ checkpoint: pending("feature", 1, "gate-c-fix-1") }, "feature", "gate-c-fix-1", false, true, true)).toEqual({ step: "stay" });
    expect(nextCheckpointState({ checkpoint: answered(pending("feature", 1, "gate-c-fix-1")) }, "feature", "gate-c-fix-1", true, true, true)).toEqual({ step: "pass" });
    expect(nextCheckpointState({ checkpointLog: [record("feature:gate-c-fix-1", "approve")] }, "feature", "gate-c-fix-1", false, true, true)).toEqual({ step: "go" });
    expect(nextCheckpointState({ checkpoint: answered(pending("feature", 1, "gate-c-fix-1"), "send_back", "x") }, "feature", "gate-c-fix-1", true, true, true)).toEqual({ step: "rework", change: 1 });
    // it never makes a gate that does not ask stop, and never lets a missing feature id through
    expect(nextCheckpointState({}, "feature", "gate-c-fix-1", false, false, true)).toEqual({ step: "go" });
    expect(nextCheckpointState({}, "feature", undefined, false, true, true)).toEqual({ step: "go" });
  });

  it("says why the team stopped in the words of that stop, for the plan's mark, a check not judged, a review that did not finish, and a send-back", () => {
    const base = { id: "2026-10-12-guide", plan: undefined };
    const stop = (f: Feature, fields: Partial<Mission> = {}): string => whyStopped({ ...base, features: [f], ...fields }, pending("feature", 1, f.id));
    const judged = (results: ("pass" | "fail" | "cannot_judge")[], extra = {}): Feature["checked"] => ({
      round: 1,
      reviewer: "claude",
      results: results.map((result, i) => ({ n: i + 1, result, evidence: "e", basis: "text" as const })),
      unjudged: results.filter((r) => r === "cannot_judge").length,
      scripted: { problems: [], facts: [] },
      pictures: { taken: 0 },
      ...extra,
    });
    expect(stop(feature("guide", { mode: "owner", checked: judged(["pass", "pass"]) }))).toBe("the plan marks “Title of guide” for your look");
    expect(stop(feature("guide", { mode: "review", checked: judged(["pass", "cannot_judge"]) }))).toBe("the second AI could not judge every check of “Title of guide”");
    expect(stop(feature("guide", { mode: "review" }))).toBe("the second AI's check of “Title of guide” did not finish");
    expect(stop(feature("guide", { mode: "review", checked: judged([], { unfinished: true, unjudged: 2 }) }))).toBe("the second AI's check of “Title of guide” did not finish");
    expect(stop(feature("guide", { mode: "review", checked: judged(["pass", "pass"]) }), { checkpointLog: [record("feature:guide", "send_back")] })).toBe("you sent “Title of guide” back and it is shown again");
  });

  it("builds the phone notice and the report's waiting block from those words", () => {
    const f = feature("guide", { mode: "owner" });
    const m = { ...mission({ features: [f], checkpoint: pending("feature", 1, "guide") }), checkpoints: undefined } as Mission;
    expect(parkedNotice(m, pending("feature", 1, "guide")).message).toContain("The team stopped because the plan marks “Title of guide” for your look. Read it with:");
    expect(parkedNotice(m, pending("feature", 1, "guide")).message).not.toContain("you asked to look");
    const report = renderReport(m, { usage: [], screenshots: [], generatedAt: "2026-10-12T14:00:00.000Z", inContainer: false });
    expect(report).toContain("The team stopped here on purpose, because the plan marks “Title of guide” for your look. Nothing else is waiting on this mission; other work carries on.");
  });

  it("keeps the old words when the owner asked to look at each feature, for a feature with a mode as for any other", () => {
    const owner = feature("guide", { mode: "owner" });
    const old = whyStopped({ id: "m", plan: undefined, features: [owner], checkpoints: all }, pending("feature", 1, "guide"));
    expect(old).toBe("you asked to look at “Title of guide” before it is added first");
    expect(whyStopped({ id: "m", plan: undefined, features: [feature("guide")] }, pending("feature", 1, "guide"))).toBe("you asked to look at “Title of guide” before it is added first");
    // a feature with a mode that stops for no reason of the plan's (the flag is set) also keeps them, and so do the plan and the final stop
    expect(whyStopped({ id: "m", plan: undefined, ownerStops: false, features: [owner] }, pending("feature", 1, "guide"))).toBe(old);
    expect(whyStopped({ id: "m", plan: undefined, features: [owner] }, pending("final"))).toBe("you asked to look at the finished app first");
  });
});
