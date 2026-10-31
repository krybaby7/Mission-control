import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyHome, emptyHome, makeEvent, withLock, withStop } from "../../test/dashboard-helpers.js";
import { buildHome, featureWith, FIN, fixtureNames, fixtureSnapshot, HOUR, iso, MID, MINUTE, missionAt, runEvents, SECOND, snap } from "../../test/dashboard-kit.js";
import { LOCK_FRESH_MS, LOCK_STALE_MS, LONG_WAIT_MS, QUIET_ACTIVITY_MS, RUN_GONE_GRACE_MS } from "./constants.js";
import type { LampReasonCode, Snapshot } from "./types.js";

const codes = (s: Snapshot): LampReasonCode[] => s.lamp.reasons.map((r) => r.code);
const reason = (s: Snapshot, code: LampReasonCode) => s.lamp.reasons.find((r) => r.code === code);
const live = (home: string, at: string, now = MID) => withLock(home, { at, ageMs: 15 * SECOND, now });
const LOCK_AT = "2026-10-11T09:58:00.000Z";

/** A snapshot of one mission made in code, with a lock when `live`. */
function oneMission(over: Parameters<typeof missionAt>[2], o: { live?: boolean; events?: ReturnType<typeof runEvents>; lockAgeMs?: number; lockAt?: string; now?: number; stop?: boolean } = {}): Snapshot {
  const now = o.now ?? MID;
  const home = buildHome(
    { missions: [{ mission: missionAt(now, "2026-10-11-a", { title: "Members site", ...over }), events: o.events ?? [] }], lock: o.live ? { at: o.lockAt ?? iso(now - 10 * MINUTE), ageMs: o.lockAgeMs } : undefined, stop: o.stop },
    now,
  );
  return snap(home, now);
}

describe("T-LAMP-L1: mission_failed (red)", () => {
  it("a failed mission makes the lamp red and says whose", () => {
    const s = snap(copyHome("failed-auth"), FIN);
    expect(s.lamp).toMatchObject({ state: "needs_you_now", word: "Needs you now", sentence: "“Recipe box” needs your help." });
    expect(s.lamp.reasons).toEqual([{ code: "mission_failed", severity: "now", text: "“Recipe box” needs your help", missionId: "2026-10-11-recipe-box", featureId: null }]);
  });

  it("counts several failed missions", () => {
    const home = buildHome({ missions: [{ mission: missionAt(MID, "2026-10-11-a", { status: "failed" }) }, { mission: missionAt(MID, "2026-10-11-b", { status: "failed" }) }] }, MID);
    const s = snap(home, MID);
    expect(s.lamp.sentence).toBe("2 missions need your help.");
    expect(reason(s, "mission_failed")).toMatchObject({ text: "2 missions need your help", missionId: null });
  });

  it("is red even while a run is live", () => {
    expect(oneMission({ status: "failed", stage: "features" }, { live: true }).lamp.state).toBe("needs_you_now");
  });
});

describe("T-LAMP-L2 and L3: the run is gone", () => {
  const gone = (ageMs: number) => oneMission({ status: "running", age: ageMs });

  it("is amber for the first minute after the mission was last saved", () => {
    const s = gone(RUN_GONE_GRACE_MS - 1);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "Checking whether the run is still going." });
    expect(codes(s)).toEqual(["run_gone_pending"]);
    expect(s.needsYou).toEqual([]);
  });

  it("is red from the minute on, with a card", () => {
    const s = gone(RUN_GONE_GRACE_MS);
    expect(s.lamp).toMatchObject({ state: "needs_you_now", sentence: "The run stopped unexpectedly." });
    expect(codes(s)).toEqual(["run_gone"]);
    expect(s.needsYou.map((c) => c.kind)).toEqual(["run_stopped"]);
  });

  it("is never grey 'Idle' while a recent mission is saved busy (E11)", () => {
    for (const age of [0, 30 * SECOND, 5 * MINUTE, 5 * HOUR]) expect(gone(age).lamp.state).not.toBe("idle");
  });

  it("a lock that stopped beating five minutes ago does not count as a run (E9)", () => {
    const s = oneMission({ status: "running", age: 10 * MINUTE }, { live: true, lockAgeMs: LOCK_STALE_MS });
    expect(s.run).toMatchObject({ active: false, heartbeat: "stale" });
    expect(s.run.line).toBe("The last run stopped answering at 09:53.");
    expect(codes(s)).toEqual(["run_gone"]);
  });

  it("a lock that stopped beating 8 days ago names the date, not a weekday that repeats (V3)", () => {
    const s = oneMission({ status: "running", age: 10 * MINUTE }, { live: true, lockAgeMs: 8 * 24 * HOUR });
    expect(s.run).toMatchObject({ active: false, heartbeat: "stale" });
    expect(s.run.line).toBe("The last run stopped answering at Sat 3 Oct 09:58.");
  });

  it("is not made by a mission that is only saved busy from long ago: it is earlier work still open", () => {
    const s = oneMission({ status: "running", age: 30 * HOUR });
    expect(s.missions[0]).toMatchObject({ scope: "earlier", state: "paused", pausedWhy: "unexpected" });
    expect(codes(s)).toEqual(["nothing_running"]);
    expect(s.lamp.sentence).toBe("Nothing is running. 1 earlier mission waits for the next run (see below).");
  });
});

// M4: a run that dies during a long wait (a killed container, a PC that went to sleep) leaves the mission saved as
// "waiting". The saved status must not make the lamp calm: it is amber for the first minute and red from then on, the
// mission reads Paused, there is no wait banner, and the card says the run stopped.
describe("T-LAMP-L2 and L3: the run is gone during a wait (M4)", () => {
  function deadWait(ageMs: number): Snapshot {
    const m = missionAt(MID, "2026-10-11-a", { title: "Members site", status: "waiting", stage: "gate_a", age: ageMs, features: [featureWith("f", "pending")] });
    const until = MID + 3 * HOUR;
    const events = [
      makeEvent(m.id, MID - ageMs - 2 * MINUTE, "mission.start", { stage: "spec" }),
      makeEvent(m.id, MID - ageMs, "limit.wait", { until: iso(until), reason: `gpt-6-astra: session limit until ${iso(until - 45_000)}` }),
    ];
    return snap(buildHome({ missions: [{ mission: m, events }] }, MID), MID);
  }

  it("is amber for 59 999 ms after the last save, with no card, a Paused mission and no banner", () => {
    const s = deadWait(RUN_GONE_GRACE_MS - 1);
    expect(codes(s)).toEqual(["run_gone_pending"]);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "Checking whether the run is still going." });
    expect(s.missions[0]).toMatchObject({ state: "paused", pausedWhy: "unexpected", waiting: null });
    expect(s.allowance.waiting).toBeNull();
    expect(s.now).toBeNull();
    expect(s.needsYou).toEqual([]);
  });

  it("is red from 60 000 ms on, with the card that says the run stopped", () => {
    const s = deadWait(RUN_GONE_GRACE_MS);
    expect(codes(s)).toEqual(["run_gone"]);
    expect(s.lamp).toMatchObject({ state: "needs_you_now", sentence: "The run stopped unexpectedly." });
    expect(s.missions[0]).toMatchObject({ state: "paused", pausedWhy: "unexpected", waiting: null });
    expect(s.allowance.waiting).toBeNull();
    expect(s.needsYou.map((c) => c.kind)).toEqual(["run_stopped"]);
  });

  it("is never grey 'Idle' next to a mission that says Paused, however long the wait was", () => {
    for (const age of [0, 30 * SECOND, RUN_GONE_GRACE_MS - 1, RUN_GONE_GRACE_MS, 10 * MINUTE, 5 * HOUR]) {
      const s = deadWait(age);
      expect(s.lamp.state, `${age} ms`).not.toBe("idle");
      expect(s.lamp.state, `${age} ms`).not.toBe("on_track");
      expect(s.missions[0]?.word).toBe("Paused");
    }
  });

  it("is also gone when the lock stopped beating, not only when it is missing", () => {
    const m = missionAt(MID, "2026-10-11-a", { status: "waiting", stage: "gate_a", age: 10 * MINUTE, features: [featureWith("f", "pending")] });
    const events = [makeEvent(m.id, MID - 10 * MINUTE, "limit.wait", { until: iso(MID + 3 * HOUR), reason: `x: session limit until ${iso(MID + 3 * HOUR)}` })];
    const s = snap(buildHome({ missions: [{ mission: m, events }], lock: { at: iso(MID - HOUR), ageMs: LOCK_STALE_MS } }, MID), MID);
    expect(s.run).toMatchObject({ active: false, heartbeat: "stale" });
    expect(codes(s)).toEqual(["run_gone"]);
    expect(s.missions[0]).toMatchObject({ state: "paused", pausedWhy: "unexpected" });
  });
});

describe("T-LAMP-L4 and L5: files that cannot be read", () => {
  it("L4: a home that cannot be read gives an amber lamp, not an error (E3)", () => {
    const home = emptyHome();
    const file = join(home, "not-a-folder");
    writeFileSync(file, "x");
    const s = snap(file, MID);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "Mission Control's files cannot be read." });
    expect(s.lamp.reasons).toEqual([{ code: "home_unreadable", severity: "look", text: "Mission Control's files cannot be read", missionId: null, featureId: null }]);
    expect(s.missions).toEqual([]);
  });

  it("L4: a missions folder that is a file is unreadable too", () => {
    const home = emptyHome();
    rmSync(join(home, "missions"), { recursive: true });
    writeFileSync(join(home, "missions"), "x");
    expect(codes(snap(home, MID))).toEqual(["home_unreadable"]);
  });

  it("E1: a home that does not exist is idle, not an error", () => {
    const s = snap(join(emptyHome(), "nope"), MID);
    expect(s.lamp).toMatchObject({ state: "idle", word: "Idle", sentence: "Nothing is running and nothing is queued." });
    expect(s.missions).toEqual([]);
    expect(s.needsYou).toEqual([]);
    expect(s.timeline.items).toEqual([]);
    expect(s.debrief).toBeNull();
  });

  it("L5: one mission file that cannot be read", () => {
    const s = snap(copyHome("unreadable-mission"), MID);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "1 mission file cannot be read." });
    expect(codes(s)).toEqual(["unreadable_mission"]);
    expect(s.counts.unreadableMissions).toBe(1);
  });

  it("L5: several, and the valid one is still shown", () => {
    const home = copyHome("unreadable-mission");
    mkdirSync(join(home, "missions", "2026-10-11-broken-two"));
    writeFileSync(join(home, "missions", "2026-10-11-broken-two", "mission.json"), "[]");
    const s = snap(home, MID);
    expect(s.lamp.sentence).toBe("2 mission files cannot be read.");
    expect(s.counts.unreadableMissions).toBe(2);
    expect(s.missions.map((m) => [m.id, m.readable])).toEqual([["2026-10-11-calendar", true], ["2026-10-11-broken", false], ["2026-10-11-broken-two", false]]);
  });
});

describe("T-LAMP-L6: a state this page does not know", () => {
  it("an unknown mission status, and a feature of an unknown status (E5, E6)", () => {
    const s = snap(copyHome("unknown-status"), MID);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "Something is in a state this page does not know." });
    expect(codes(s)).toEqual(["unknown_state"]);
    const byId = Object.fromEntries(s.missions.map((m) => [m.id, m]));
    expect(byId["2026-10-11-mystery-status"]).toMatchObject({ state: "unknown", word: "Needs a look", sentence: "This page does not know this state." });
    expect(byId["2026-10-11-mystery-feature"]?.features.map((f) => f.state)).toEqual(["done", "unknown"]);
  });

  it("an unknown stage", () => {
    expect(codes(oneMission({ status: "running", stage: "dreaming" as never }, { live: true }))).toEqual(["unknown_state"]);
  });

  it("an unreadable mission is L5 alone: one fact, one reason", () => {
    expect(codes(snap(copyHome("unreadable-mission"), MID))).not.toContain("unknown_state");
  });
});

describe("T-LAMP-L7 and L8: paused for a reason that is not the owner's", () => {
  it("L7: the disk is almost full", () => {
    const s = snap(copyHome("paused-disk"), MID);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "Work paused because the disk is almost full." });
    expect(codes(s)).toEqual(["paused_disk"]);
    expect(reason(s, "paused_disk")?.missionId).toBe("2026-10-11-garden-planner");
  });

  it("L8: the AI team keeps failing", () => {
    const s = snap(copyHome("paused-ai-failing"), MID);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "Work paused because the AI team keeps failing." });
    expect(codes(s)).toEqual(["paused_ai_failing"]);
  });
});

describe("T-LAMP-L9 and L10: stuck features and questions", () => {
  it("L9: one stuck feature (partial-blocked), and no separate question for it", () => {
    const s = snap(copyHome("partial-blocked"), FIN);
    expect(s.lamp).toMatchObject({ state: "needs_look", word: "Needs a look", sentence: "1 feature is stuck." });
    expect(codes(s)).toEqual(["feature_stuck"]);
  });

  it("L9: several stuck features", () => {
    const { lamp } = oneMission({ status: "partial", stage: "complete", features: [featureWith("a", "blocked"), featureWith("b", "blocked"), featureWith("c", "done")] });
    expect(lamp.sentence).toBe("2 features are stuck.");
  });

  it("L9: only left-out features say so (E34), and make no card", () => {
    const s = oneMission({ status: "partial", stage: "complete", features: [featureWith("a", "skipped", { blockedReason: 'waiting on "x", which was blocked' }), featureWith("b", "done")] });
    expect(s.lamp.sentence).toBe("1 feature was left out.");
    expect(reason(s, "feature_stuck")?.text).toBe("1 feature was left out");
    expect(s.needsYou).toEqual([]);
    expect(oneMission({ status: "partial", stage: "complete", features: [featureWith("a", "skipped"), featureWith("b", "skipped")] }).lamp.sentence).toBe("2 features were left out.");
  });

  it("L9: stuck wins over left out", () => {
    const s = oneMission({ status: "partial", stage: "complete", features: [featureWith("a", "blocked"), featureWith("b", "skipped")] });
    expect(s.lamp.sentence).toBe("1 feature is stuck.");
  });

  it("L10: one question, then two", () => {
    const features = [featureWith("a", "done")];
    expect(oneMission({ status: "partial", stage: "complete", features, decisionsNeeded: ["Which colour?"] }).lamp.sentence).toBe("1 question is waiting for you.");
    const two = oneMission({ status: "partial", stage: "complete", features, decisionsNeeded: ["Which colour?", "Which font?"] });
    expect(two.lamp.sentence).toBe("2 questions are waiting for you.");
    expect(codes(two)).toEqual(["decision_waiting"]);
  });

  it("L9 and L10 together read as one sentence", () => {
    const s = oneMission({ status: "partial", stage: "complete", features: [featureWith("a", "blocked")], decisionsNeeded: ["Which colour?"] });
    expect(s.lamp.sentence).toBe("1 feature is stuck and 1 question is waiting for you.");
  });
});

describe("T-LAMP-L11: a login is needed", () => {
  it("is amber whatever the length of the wait", () => {
    const home = copyHome("login-wait");
    live(home, LOCK_AT);
    const s = snap(home, MID);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "One AI needs a new login." });
    expect(codes(s)).toEqual(["login_needed"]);
    expect(reason(s, "login_needed")?.missionId).toBe("2026-10-11-photo-album");
    expect(s.needsYou.map((c) => c.kind)).toEqual(["login_needed"]);
  });

  it("is amber for a short wait too, and never says 'Nothing needs you' (E45)", () => {
    const m = missionAt(MID, "2026-10-11-a", { status: "waiting" });
    const home = buildHome({ missions: [{ mission: m, events: [makeEvent(m.id, MID - 5 * SECOND, "limit.wait", { until: iso(MID + 10 * MINUTE), reason: `x: session limit until ${iso(MID + 9 * MINUTE)}; z: claude needs a new login` })] }], lock: { at: iso(MID - 10 * MINUTE) } }, MID);
    const s = snap(home, MID);
    expect(s.lamp.state).toBe("needs_look");
    expect(s.lamp.sentence).not.toContain("Nothing needs you");
    expect(codes(s)).toEqual(["login_needed"]);
  });
});

describe("T-LAMP-L12: the project's own checks were already failing", () => {
  it("is amber with its own sentence", () => {
    const s = snap(copyHome("baseline-broken"), MID);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "The project's own checks were already failing." });
    expect(codes(s)).toEqual(["checks_failing_before"]);
    expect(s.needsYou.map((c) => c.kind)).toEqual(["checks_failing"]);
  });
});

describe("T-LAMP-L13: paused work waits for the next run", () => {
  it("counts the features still to build (paused at the deadline, and on request)", () => {
    for (const name of ["paused-deadline", "paused-stop"]) {
      const s = snap(copyHome(name), MID);
      expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "2 of 3 features are waiting for the next run." });
      expect(codes(s)).toEqual(["paused_unbuilt"]);
    }
  });

  it("also for a stop with no reason this page knows", () => {
    const s = oneMission({ status: "stopped", stage: "features", features: [featureWith("a", "done"), featureWith("b", "pending")] }, { events: [makeEvent("2026-10-11-a", MID - 3000, "mission.stopped", { reason: "a reason nobody has seen" })] });
    expect(s.lamp.sentence).toBe("1 of 2 features are waiting for the next run.");
  });

  it("counts missions when nothing is left to build", () => {
    const stopped = (id: string) => ({ mission: missionAt(MID, id, { status: "stopped", stage: "gate_c", features: [featureWith("a", "done")] }), events: [makeEvent(id, MID - 3000, "mission.stopped", { reason: "stop requested" })] });
    expect(snap(buildHome({ missions: [stopped("2026-10-11-a")] }, MID), MID).lamp.sentence).toBe("1 mission is paused until the next run.");
    expect(snap(buildHome({ missions: [stopped("2026-10-11-a"), stopped("2026-10-11-b")] }, MID), MID).lamp.sentence).toBe("2 missions are paused until the next run.");
  });

  it("is not made for a mission paused by disk or failing AIs: those have their own reasons", () => {
    expect(codes(snap(copyHome("paused-disk"), MID))).not.toContain("paused_unbuilt");
  });
});

describe("T-LAMP-L14: finished partly done", () => {
  it("fires when every feature is built and nothing else says why", () => {
    const s = oneMission({ status: "partial", stage: "complete", title: "Members site", features: [featureWith("a", "done"), featureWith("b", "done")] });
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "“Members site” finished partly done." });
    expect(reason(s, "mission_partial")).toMatchObject({ missionId: "2026-10-11-a" });
  });

  it("does not fire when a stuck feature or a question explains it", () => {
    expect(codes(snap(copyHome("partial-blocked"), FIN))).not.toContain("mission_partial");
    expect(codes(oneMission({ status: "partial", stage: "complete", features: [featureWith("a", "done")], decisionsNeeded: ["Which colour?"] }))).toEqual(["decision_waiting"]);
    expect(codes(oneMission({ status: "partial", stage: "complete", features: [featureWith("a", "skipped")] }))).toEqual(["feature_stuck"]);
  });
});

describe("T-LAMP-L15 and L23: earlier missions", () => {
  const NOW = Date.parse("2026-10-11T10:00:00.000Z");

  it("L15: an earlier failed mission is amber, and the sentence never says 'Nothing needs you' (E46)", () => {
    const s = snap(copyHome("scope-mix"), NOW);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "1 earlier mission needs your help." });
    expect(codes(s)).toEqual(["earlier_failed", "earlier_items"]);
    expect(s.counts.earlierNeedYou).toBe(1);
    expect(s.lamp.sentence).not.toContain("Nothing needs you");
  });

  it("L23: earlier items that wait for the owner change no colour (grey)", () => {
    const home = copyHome("scope-mix");
    for (const gone of ["2026-10-10-login-lapsed", "2026-10-11-recent-work"]) rmSync(join(home, "missions", gone), { recursive: true });
    const s = snap(home, NOW);
    expect(s.lamp).toMatchObject({ state: "idle", sentence: "Nothing is running. 1 earlier mission still waits for you (see below). 1 earlier mission waits for the next run (see below)." });
    expect(codes(s)).toEqual(["earlier_items", "nothing_running"]);
    expect(reason(s, "earlier_items")).toMatchObject({ severity: "info", text: "1 earlier mission still waits for you" });
  });

  it("L23 with a run on: green, and the tail says what is earlier", () => {
    const home = copyHome("scope-mix");
    rmSync(join(home, "missions", "2026-10-10-login-lapsed"), { recursive: true });
    live(home, "2026-10-11T09:55:00.000Z", NOW);
    const s = snap(home, NOW);
    expect(s.lamp.state).toBe("on_track");
    expect(s.lamp.sentence).toMatch(/Nothing new needs you\. 1 earlier mission still waits for you \(see below\)\.$/);
    expect(s.lamp.sentence).not.toContain("Nothing needs you");
  });

  it("L23 with every recent mission done: green, with the same tail", () => {
    const home = copyHome("scope-mix");
    for (const gone of ["2026-10-10-login-lapsed", "2026-10-06-queued-long-ago"]) rmSync(join(home, "missions", gone), { recursive: true });
    const s = snap(home, NOW);
    expect(s.lamp).toMatchObject({ state: "on_track", sentence: "The feature is done. Nothing new needs you. 1 earlier mission still waits for you (see below)." });
    expect(codes(s)).toEqual(["earlier_items", "all_done"]);
  });
});

describe("T-LAMP-L16 and L17: waits", () => {
  it("L16: a wait whose reason matches no known shape is amber", () => {
    const home = copyHome("unknown-wait");
    live(home, LOCK_AT);
    const s = snap(home, MID);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "The run is waiting for an unknown reason." });
    expect(codes(s)).toEqual(["wait_unknown"]);
    expect(s.missions[0]?.waiting).toMatchObject({ cause: "unknown", text: "Waiting until 10:08. Mission Control cannot tell why." });
  });

  it("L16: a wait with no limit.wait event at all (E29)", () => {
    const s = oneMission({ status: "waiting" }, { live: true });
    expect(codes(s)).toEqual(["wait_unknown"]);
    expect(s.missions[0]?.waiting?.text).toBe("Waiting. Mission Control cannot tell why.");
  });

  function waitOf(leftMs: number, cause: "limits" | "trouble" = "limits") {
    const m = missionAt(MID, "2026-10-11-a", { status: "waiting" });
    const until = MID + leftMs;
    const reasonText = cause === "limits" ? `gpt-6.1-sol: session limit until ${iso(until - 45_000)}` : `gpt-6.1-sol: codex keeps failing (network), trying again at ${iso(until - 45_000)}`;
    const home = buildHome({ missions: [{ mission: m, events: [makeEvent(m.id, MID - 5 * SECOND, "limit.wait", { until: iso(until), reason: reasonText })] }], lock: { at: iso(MID - 10 * MINUTE) } }, MID);
    return snap(home, MID);
  }

  it("L17: a wait of exactly 60 minutes is short, one millisecond more is long", () => {
    const short = waitOf(LONG_WAIT_MS);
    expect(codes(short)).toEqual(["short_wait", "working"]);
    expect(short.lamp.state).toBe("on_track");
    const long = waitOf(LONG_WAIT_MS + 1);
    expect(codes(long)).toEqual(["long_wait"]);
    expect(long.lamp).toMatchObject({ state: "needs_look", sentence: "Waiting for allowance until 10:58. It resumes by itself." });
  });

  it("L17: the sentence for a trouble wait names the AI team", () => {
    expect(waitOf(2 * HOUR, "trouble").lamp.sentence).toBe("Waiting for the AI team until 11:58. It resumes by itself.");
  });

  it("L17: a live run asleep for three hours reads 'Waiting for allowance until 12:59. It resumes by itself.' (spec 5.4)", () => {
    const home = copyHome("limit-waiting");
    live(home, LOCK_AT);
    const s = snap(home, MID);
    expect(s.lamp.sentence).toBe("Waiting for allowance until 12:59. It resumes by itself.");
    expect(s.allowance.waiting?.untilText).toBe("12:59");
  });

  // M3: a wait can last days. Every place that words it must say the weekday, and all of them the same moment.
  it("L17: a wait three days long says the weekday everywhere, and every text names the same moment (M3)", () => {
    const until = MID + 3 * 24 * HOUR + HOUR; // Wed 14 Oct 10:58:30
    const m = missionAt(MID, "2026-10-11-a", { status: "waiting", stage: "features", features: [featureWith("a", "done"), featureWith("b", "building")] });
    const reasonText = `claude-opus-5-5: weekly limit until ${iso(until - 45_000)}; gpt-6-astra: weekly limit until ${iso(until - 45_000)}`;
    const quota = {
      version: 1,
      limits: { claude: { kind: "weekly", until: until - 45_000, raw: "x" }, codex: { kind: "weekly", until: until - 45_000, raw: "x" } },
      modelBlocks: [],
      utilization: [],
    };
    const home = buildHome(
      { missions: [{ mission: m, events: [makeEvent(m.id, MID - 5 * SECOND, "limit.wait", { until: iso(until), reason: reasonText })] }], lock: { at: iso(MID - 10 * MINUTE) }, quota, quotaMtimeMs: MID - 2 * 24 * HOUR },
      MID,
    );
    const s = snap(home, MID);
    const wait = "Waiting for allowance until Wed 10:58. It resumes by itself.";
    expect(codes(s)).toEqual(["long_wait"]);
    expect(s.lamp.sentence).toBe(wait);
    expect(s.missions[0]?.sentence).toBe(wait);
    expect(s.missions[0]?.waiting).toMatchObject({ untilText: "Wed 10:58", text: wait });
    expect(s.now).toMatchObject({ kind: "waiting", text: wait });
    expect(s.allowance.waiting).toMatchObject({ untilText: "Wed 10:58", text: wait });
    expect(s.timeline.items.map((i) => i.text)).toContain(wait);
    expect(s.missions[0]?.features.find((f) => f.id === "b")?.reason?.text).toBe("On hold until Wed 10:58, waiting for allowance.");
    expect(s.lamp.reasons[0]?.text).toBe("waiting for allowance until Wed 10:58");
    // The allowance rows name the same moment, and the file time says which day the figures changed.
    expect(s.allowance.providers.map((p) => p.limitedText)).toEqual(["Waiting for the weekly limit to reset. A new allowance check can be made Wed 10:58.", "Waiting for the weekly limit to reset. A new allowance check can be made Wed 10:58."]);
    expect(s.allowance.fileChangedText).toBe("Usage figures last changed at Fri 09:58");
    expect(JSON.stringify(s)).not.toMatch(/until 10:58|at 10:58/);
  });

  // V3: a weekday alone repeats every week. From 6 days away a wait, a reset and the time the figures changed carry the
  // date, so "Mon 10:03" is never read as tomorrow. Everything names the same moment, with the same words.
  it.each([
    ["5 days 23 h 59 min ahead still names the weekday only", 6 * 24 * HOUR - MINUTE, "Sat 09:57", "Mon 09:59"],
    ["exactly 6 days ahead carries the date", 6 * 24 * HOUR, "Sat 17 Oct 09:58", "Mon 5 Oct 09:58"],
    ["8 days ahead (the longest a limit can reset) carries the date", 8 * 24 * HOUR, "Mon 19 Oct 09:58", "Sat 3 Oct 09:58"],
  ])("V3: a wait %s, and so does every text that names it", (_name, ahead, untilText, changedAt) => {
    const until = MID + ahead;
    const m = missionAt(MID, "2026-10-11-a", { status: "waiting", stage: "features", features: [featureWith("a", "done"), featureWith("b", "building")] });
    const quota = { version: 1, limits: { claude: { kind: "weekly", until: until - 45_000, raw: "x" } }, modelBlocks: [], utilization: [] };
    const home = buildHome(
      {
        missions: [{ mission: m, events: [makeEvent(m.id, MID - 5 * SECOND, "limit.wait", { until: iso(until), reason: `claude-opus-5-5: weekly limit until ${iso(until - 45_000)}` })] }],
        lock: { at: iso(MID - 10 * MINUTE) },
        quota,
        quotaMtimeMs: MID - ahead,
      },
      MID,
    );
    const s = snap(home, MID);
    const wait = `Waiting for allowance until ${untilText}. It resumes by itself.`;
    expect(s.lamp.sentence).toBe(wait);
    expect(s.missions[0]?.sentence).toBe(wait);
    expect(s.missions[0]?.waiting).toMatchObject({ untilText, text: wait });
    expect(s.now).toMatchObject({ kind: "waiting", text: wait });
    expect(s.allowance.waiting).toMatchObject({ untilText, text: wait });
    expect(s.timeline.items.map((i) => i.text)).toContain(wait);
    expect(s.missions[0]?.features.find((f) => f.id === "b")?.reason?.text).toBe(`On hold until ${untilText}, waiting for allowance.`);
    expect(s.lamp.reasons[0]?.text).toBe(`waiting for allowance until ${untilText}`);
    expect(s.allowance.providers.find((p) => p.id === "claude")?.limitedText).toBe(`Waiting for the weekly limit to reset. A new allowance check can be made ${untilText}.`);
    expect(s.allowance.fileChangedText).toBe(`Usage figures last changed at ${changedAt}`);
  });

  it("V3: the verifier's case, a Sunday wait that ends the Monday after, reads 'Mon 19 Oct 10:03' and never 'Mon 10:03'", () => {
    const now = Date.parse("2026-10-11T10:03:00.000Z");
    const until = Date.parse("2026-10-19T10:03:00.000Z");
    const m = missionAt(now, "2026-10-11-a", { status: "waiting", stage: "features", features: [featureWith("b", "building")] });
    const home = buildHome(
      { missions: [{ mission: m, events: [makeEvent(m.id, now - 5 * SECOND, "limit.wait", { until: iso(until), reason: `claude-opus-5-5: weekly limit until ${iso(until - 45_000)}` })] }], lock: { at: iso(now - 10 * MINUTE) } },
      now,
    );
    const s = snap(home, now);
    expect(s.lamp.sentence).toBe("Waiting for allowance until Mon 19 Oct 10:03. It resumes by itself.");
    expect(JSON.stringify(s)).not.toContain("Mon 10:03");
    // A wait that ends at midnight carries the date too.
    const midnight = Date.parse("2026-10-19T00:00:00.000Z");
    const home2 = buildHome(
      { missions: [{ mission: m, events: [makeEvent(m.id, now - 5 * SECOND, "limit.wait", { until: iso(midnight), reason: `claude-opus-5-5: weekly limit until ${iso(midnight - 45_000)}` })] }], lock: { at: iso(now - 10 * MINUTE) } },
      now,
    );
    expect(snap(home2, now).lamp.sentence).toBe("Waiting for allowance until Mon 19 Oct 00:00. It resumes by itself.");
  });

  it("L17: a long wait of known cause next to another problem keeps its clause, with no 'it' that could mean the other problem (M5)", () => {
    const m = missionAt(MID, "2026-10-11-a", { status: "waiting", stage: "features", features: [featureWith("a", "blocked", { blockedReason: "x" }), featureWith("b", "building")] });
    const until = MID + 3 * HOUR;
    const home = buildHome(
      { missions: [{ mission: m, events: [makeEvent(m.id, MID - 5 * SECOND, "limit.wait", { until: iso(until), reason: `gpt-6.1-sol: session limit until ${iso(until - 45_000)}` })] }], lock: { at: iso(MID - 10 * MINUTE) } },
      MID,
    );
    const s = snap(home, MID);
    expect(codes(s)).toEqual(["feature_stuck", "long_wait"]);
    expect(s.lamp.sentence).toBe("1 feature is stuck and waiting for allowance until 12:58.");
  });

  it("L17: with two long waits the clause names the first mission's (M32)", () => {
    const wait = (id: string, createdAgo: number, hours: number) => {
      const m = missionAt(MID, id, { status: "waiting", createdAt: iso(MID - createdAgo), features: [featureWith("a", "building")] });
      const until = MID + hours * HOUR;
      return { mission: m, events: [makeEvent(m.id, MID - 5 * SECOND, "limit.wait", { until: iso(until), reason: `gpt-6.1-sol: session limit until ${iso(until - 45_000)}` })] };
    };
    const home = buildHome({ missions: [wait("2026-10-11-a", 9 * HOUR, 2), wait("2026-10-11-b", 8 * HOUR, 5)], lock: { at: iso(MID - 10 * MINUTE) } }, MID);
    const s = snap(home, MID);
    expect(reason(s, "long_wait")).toMatchObject({ text: "waiting for allowance until 11:58", missionId: "2026-10-11-a" });
  });

  it("L17: only a wait of known cause resumes by itself: an unknown or login wait never says so (M5)", () => {
    const login = copyHome("login-wait");
    live(login, LOCK_AT);
    expect(snap(login, MID).lamp.sentence).not.toContain("resumes by itself");
    const unknown = copyHome("unknown-wait");
    live(unknown, LOCK_AT);
    expect(snap(unknown, MID).lamp.sentence).not.toContain("resumes by itself");
  });
});

describe("T-LAMP-L18: the heartbeat", () => {
  const heartbeat = (ageMs: number) => {
    const s = oneMission({ status: "running", features: [featureWith("a", "building")] }, { live: true, lockAgeMs: ageMs, events: runEvents("2026-10-11-a", MID - 20 * SECOND, "build-a") });
    return s;
  };

  it("is fresh under two minutes", () => {
    const s = heartbeat(LOCK_FRESH_MS - 1);
    expect(s.run).toMatchObject({ active: true, heartbeat: "fresh", heartbeatAgeMs: LOCK_FRESH_MS - 1, heartbeatText: "1 min ago" });
    expect(codes(s)).toEqual(["working"]);
  });

  it("is late from two minutes to five, and amber", () => {
    for (const age of [LOCK_FRESH_MS, LOCK_STALE_MS - 1]) {
      const s = heartbeat(age);
      expect(s.run).toMatchObject({ active: true, heartbeat: "late" });
      expect(s.lamp.state).toBe("needs_look");
      expect(codes(s)).toEqual(["heartbeat_late"]);
    }
    expect(heartbeat(LOCK_FRESH_MS).lamp.sentence).toBe("The run has not reported in for 2 min.");
    expect(heartbeat(LOCK_STALE_MS - 1).lamp.sentence).toBe("The run has not reported in for 4 min.");
  });

  it("is stale from five minutes: the run is gone", () => {
    const s = heartbeat(LOCK_STALE_MS);
    expect(s.run).toMatchObject({ active: false, heartbeat: "stale" });
    expect(s.now).toBeNull();
  });

  it("a lock touched in the future counts as just touched (E14)", () => {
    const s = heartbeat(-1 * HOUR);
    expect(s.run).toMatchObject({ heartbeat: "fresh", heartbeatAgeMs: 0 });
  });

  it("a lock that is not a lock is not a run (E12)", () => {
    const home = buildHome({ missions: [{ mission: missionAt(MID, "2026-10-11-a", { status: "running" }) }] }, MID);
    writeFileSync(join(home, "mc.lock"), "garbage");
    const s = snap(home, MID);
    expect(s.run).toMatchObject({ active: false, heartbeat: "unreadable", heartbeatAgeMs: null, startedAt: null });
    expect(s.run.line).toBe("No run is working right now.");
  });
});

describe("T-LAMP-L19: a quiet run", () => {
  // The run started two hours ago, long before the mission's last sign of life.
  const quiet = (since: number, lockAgeMs?: number) => {
    const events = [makeEvent("2026-10-11-a", MID - since, "mission.start", { stage: "spec" })];
    return oneMission({ status: "running", stage: "features", features: [featureWith("a", "building")], age: since }, { live: true, events, lockAt: iso(MID - 2 * HOUR - since), lockAgeMs });
  };

  it("does not fire at 49 minutes and 59.999 seconds and fires at 50 minutes", () => {
    expect(codes(quiet(QUIET_ACTIVITY_MS - 1))).toEqual(["working"]);
    const s = quiet(QUIET_ACTIVITY_MS);
    expect(codes(s)).toEqual(["quiet_run"]);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "The run has been quiet for 50 min." });
    expect(s.run.activityLine).toBe("Last activity 50 min ago");
  });

  it("is not checked while the heartbeat is late: that is L18", () => {
    expect(codes(quiet(HOUR, LOCK_FRESH_MS))).toEqual(["heartbeat_late"]);
  });
});

describe("T-LAMP-L20: a stop was requested", () => {
  it("is amber while a run is live", () => {
    const s = oneMission({ status: "running", features: [featureWith("a", "building")] }, { live: true, stop: true, events: runEvents("2026-10-11-a", MID - 20 * SECOND, "build-a") });
    expect(s.run.stopRequested).toBe(true);
    expect(s.lamp).toMatchObject({ state: "needs_look", sentence: "A stop was requested." });
    expect(codes(s)).toEqual(["stop_requested"]);
  });

  it("is no reason when no run is live: the next run clears it (E20)", () => {
    const home = emptyHome();
    withStop(home);
    const s = snap(home, MID);
    expect(s.run.stopRequested).toBe(true);
    expect(s.lamp).toMatchObject({ state: "idle", sentence: "Nothing is running and nothing is queued." });
  });
});

describe("T-LAMP-L21: a short wait", () => {
  it("is shown but changes no colour (green)", () => {
    const home = copyHome("trouble-wait");
    live(home, LOCK_AT);
    const s = snap(home, MID);
    expect(s.lamp).toMatchObject({ state: "on_track", sentence: "1 of 3 features done. No problems so far. Waiting for the AI team to respond until 10:13. It resumes by itself. Nothing needs you." });
    expect(codes(s)).toEqual(["short_wait", "working"]);
    expect(reason(s, "short_wait")).toMatchObject({ severity: "info", text: "waiting for the AI team until 10:13" });
  });

  it("says 'allowance' for a usage limit", () => {
    const m = missionAt(MID, "2026-10-11-a", { status: "waiting", features: [featureWith("a", "done"), featureWith("b", "building")] });
    const home = buildHome({ missions: [{ mission: m, events: [makeEvent(m.id, MID - 5000, "limit.wait", { until: iso(MID + 30 * MINUTE), reason: `x: session limit until ${iso(MID + 29 * MINUTE)}` })] }], lock: { at: iso(MID - 10 * MINUTE) } }, MID);
    expect(snap(home, MID).lamp.sentence).toBe("1 of 2 features done. No problems so far. Waiting for allowance until 10:28. It resumes by itself. Nothing needs you.");
  });
});

describe("T-LAMP-L22: a queued mission", () => {
  it("makes a grey lamp say it waits for the next run, not an amber one", () => {
    const s = oneMission({ status: "queued", stage: "spec" });
    expect(s.lamp).toMatchObject({ state: "idle", word: "Idle", sentence: "Nothing is running. 1 mission waits for the next run." });
    expect(codes(s)).toEqual(["queued", "nothing_running"]);
    expect(reason(s, "queued")).toMatchObject({ severity: "info", text: "1 mission waits for the next run" });
  });

  it("counts several", () => {
    const home = buildHome({ missions: [{ mission: missionAt(MID, "2026-10-11-a", { status: "queued", stage: "spec" }) }, { mission: missionAt(MID, "2026-10-11-b", { status: "queued", stage: "spec" }) }] }, MID);
    expect(snap(home, MID).lamp.sentence).toBe("Nothing is running. 2 missions wait for the next run.");
  });
});

describe("T-LAMP-L24: working (green)", () => {
  it("a live run with nothing to look at", () => {
    const home = copyHome("midrun-reviewing");
    live(home, "2026-10-11T09:58:19.844Z");
    const s = snap(home, MID);
    expect(s.lamp).toEqual({
      state: "on_track",
      word: "On track",
      sentence: "1 of 3 features done. No problems so far. Nothing needs you.",
      reasons: [{ code: "working", severity: "ok", text: "the run is working and nothing needs a look", missionId: null, featureId: null }],
    });
  });

  it.each([
    [0, 0, "Working on the plan. Nothing needs you."],
    [1, 0, "The feature is being worked on. Nothing needs you."],
    [1, 1, "The feature is done. The final steps are running. Nothing needs you."],
    [4, 0, "4 features planned. No problems so far. Nothing needs you."],
    [4, 4, "All 4 features done. The final steps are running. Nothing needs you."],
  ])("%d features, %d done", (total, done, sentence) => {
    const features = Array.from({ length: total }, (_, i) => featureWith(`f${i}`, i < done ? "done" : "pending"));
    const stage = total === 0 ? "spec" : done === total ? "gate_c" : "features";
    const s = oneMission({ status: "running", stage, features }, { live: true, events: [makeEvent("2026-10-11-a", MID - 5 * SECOND, "mission.start", { stage: "spec" })] });
    expect(s.lamp.sentence).toBe(sentence);
  });
});

describe("T-LAMP-L25: all done (green)", () => {
  it("one finished mission", () => {
    const s = snap(copyHome("done"), FIN);
    expect(s.lamp).toEqual({
      state: "on_track",
      word: "On track",
      sentence: "All 4 features are done. Nothing needs you.",
      reasons: [{ code: "all_done", severity: "ok", text: "everything is done", missionId: null, featureId: null }],
    });
  });

  it("several finished missions, and a queued one after them", () => {
    const done = (id: string, n: number) => ({ mission: missionAt(FIN, id, { status: "done", stage: "complete", features: Array.from({ length: n }, (_, i) => featureWith(`f${i}`, "done")) }) });
    const two = buildHome({ missions: [done("2026-10-11-a", 2), done("2026-10-11-b", 3)] }, FIN);
    expect(snap(two, FIN).lamp.sentence).toBe("Everything is done: 2 missions, 5 features. Nothing needs you.");
    const queued = buildHome({ missions: [done("2026-10-11-a", 2), { mission: missionAt(FIN, "2026-10-11-q", { status: "queued", stage: "spec" }) }] }, FIN);
    const s = snap(queued, FIN);
    expect(s.lamp).toMatchObject({ state: "on_track", sentence: "All 2 features are done. Nothing needs you. 1 more mission waits for the next run." });
    expect(codes(s)).toEqual(["queued", "all_done"]);
  });

  it("is not made when one recent mission is something else", () => {
    const home = buildHome({ missions: [{ mission: missionAt(FIN, "2026-10-11-a", { status: "done", stage: "complete", features: [featureWith("f", "done")] }) }, { mission: missionAt(FIN, "2026-10-11-b", { status: "stopped", stage: "features", features: [featureWith("g", "done")] }) }] }, FIN);
    expect(codes(snap(home, FIN))).not.toContain("all_done");
  });
});

describe("T-LAMP-L26: nothing running (grey)", () => {
  it("an empty home", () => {
    const s = snap(emptyHome(), MID);
    expect(s.lamp).toEqual({
      state: "idle",
      word: "Idle",
      sentence: "Nothing is running and nothing is queued.",
      reasons: [{ code: "nothing_running", severity: "ok", text: "nothing is running", missionId: null, featureId: null }],
    });
  });

  it("a run that is live with nothing to do is working, not idle", () => {
    const home = emptyHome();
    live(home, LOCK_AT);
    const s = snap(home, MID);
    expect(s.lamp).toMatchObject({ state: "on_track", sentence: "Working on the plan. Nothing needs you." });
    expect(s.run.line).toBe("A run is on, between missions, running 30 s");
  });

  it("earlier missions that only wait for the next run are mentioned", () => {
    const home = copyHome("scope-mix");
    rmSync(join(home, "missions", "2026-10-10-login-lapsed"), { recursive: true });
    rmSync(join(home, "missions", "2026-10-10-earlier-partial"), { recursive: true });
    rmSync(join(home, "missions", "2026-10-11-recent-work"), { recursive: true });
    const s = snap(home, Date.parse("2026-10-11T10:00:00.000Z"));
    expect(s.lamp.sentence).toBe("Nothing is running. 1 earlier mission waits for the next run (see below).");
  });
});

describe("T-LAMP-ORDER: the worst wins and the sentence is composed", () => {
  it("red over amber over green, and the reasons in table order", () => {
    const s = snap(copyHome("multi-mission"), FIN);
    expect(s.lamp.state).toBe("needs_you_now");
    expect(codes(s)).toEqual(["mission_failed", "feature_stuck"]);
    expect(s.lamp.reasons.map((r) => r.severity)).toEqual(["now", "look"]);
    expect(s.lamp.sentence).toBe("“Recipe box” needs your help and 1 feature is stuck.");
  });

  it("the examples of spec 5.4, word for word", () => {
    expect(snap(copyHome("partial-blocked"), FIN).lamp.sentence).toBe("1 feature is stuck.");
    expect(snap(copyHome("failed-auth"), FIN).lamp.sentence).toBe("“Recipe box” needs your help.");
    const wait = copyHome("limit-waiting");
    live(wait, LOCK_AT);
    expect(snap(wait, MID).lamp.sentence).toBe("Waiting for allowance until 12:59. It resumes by itself.");
  });

  it("three clauses: the first two, then 'N more things need a look'", () => {
    const s = oneMission({ status: "partial", stage: "complete", baselineBroken: true, features: [featureWith("a", "blocked")], decisionsNeeded: ["Which colour?"] });
    expect(codes(s)).toEqual(["feature_stuck", "decision_waiting", "checks_failing_before"]);
    expect(s.lamp.sentence).toBe("1 feature is stuck and 1 question is waiting for you. 1 more thing needs a look.");
  });

  it("four clauses", () => {
    const home = buildHome(
      {
        missions: [
          { mission: missionAt(MID, "2026-10-11-a", { status: "partial", stage: "complete", baselineBroken: true, features: [featureWith("a", "blocked")], decisionsNeeded: ["Which colour?"] }) },
          { mission: missionAt(MID, "2026-10-11-b", { status: "stopped", stage: "features", features: [featureWith("b", "pending")] }), events: [makeEvent("2026-10-11-b", MID - 3000, "mission.stopped", { reason: "the disk is almost full" })] },
        ],
      },
      MID,
    );
    expect(snap(home, MID).lamp.sentence).toBe("Work paused because the disk is almost full and 1 feature is stuck. 2 more things need a look.");
  });

  it("'The rest is on track.' only for a live run whose problems are the ones that wait for the owner", () => {
    const stuck = { status: "running" as const, stage: "features" as const, features: [featureWith("a", "blocked"), featureWith("b", "building")] };
    const events = runEvents("2026-10-11-a", MID - 5 * SECOND, "build-b");
    expect(oneMission(stuck, { live: true, events }).lamp.sentence).toBe("1 feature is stuck. The rest is on track.");
    expect(oneMission({ ...stuck, status: "partial", stage: "complete", features: [featureWith("a", "blocked")] }).lamp.sentence).toBe("1 feature is stuck.");
    const withDisk = buildHome(
      {
        missions: [
          { mission: missionAt(MID, "2026-10-11-a", stuck), events },
          { mission: missionAt(MID, "2026-10-11-c", { status: "stopped", stage: "features", features: [featureWith("c", "pending")] }), events: [makeEvent("2026-10-11-c", MID - 3000, "mission.stopped", { reason: "the disk is almost full" })] },
        ],
        lock: { at: iso(MID - 10 * MINUTE) },
      },
      MID,
    );
    const s = snap(withDisk, MID);
    expect(s.lamp.state).toBe("needs_look");
    expect(s.lamp.sentence).toBe("Work paused because the disk is almost full and 1 feature is stuck.");
    const red = oneMission({ ...stuck, status: "failed" }, { live: true });
    expect(red.lamp.sentence).not.toContain("The rest is on track");
  });

  it("every clause of every fixture that is joined into a sentence has no semicolon and no inner 'and' (titles are not part of the rule)", () => {
    for (const name of fixtureNames()) {
      const s = fixtureSnapshot(name);
      // The reasons that explain a green or grey lamp are not joined into a sentence, so the rule does not bind them.
      for (const r of s.lamp.reasons.filter((x) => x.severity !== "ok")) {
        const withoutTitles = r.text.replace(/“[^”]*”/g, "“”");
        expect(withoutTitles, `${name} ${r.code}`).not.toMatch(/;| and /);
        expect(r.text).not.toMatch(/\.$/);
      }
    }
  });

  it("the state follows the reasons, always (the shape check proves it for every fixture)", () => {
    const s = snap(copyHome("multi-mission"), FIN);
    expect(s.lamp.state).toBe("needs_you_now");
    expect(s.freshness.notUpdating.state).toBe("needs_look");
  });
});

describe("T-LAMP-NEVER-GREEN: unknown input is never green", () => {
  const notGreen = (s: Snapshot) => {
    expect(s.lamp.state).not.toBe("on_track");
    expect(s.lamp.sentence).not.toContain("Nothing needs you");
    expect(codes(s)).not.toContain("working");
    expect(codes(s)).not.toContain("all_done");
  };

  it.each([
    ["an unknown mission status", () => oneMission({ status: "hibernating" as never }, { live: true })],
    ["an unknown stage", () => oneMission({ status: "running", stage: "dreaming" as never }, { live: true })],
    ["an unknown feature status", () => oneMission({ status: "done", stage: "complete", features: [featureWith("a", "done"), featureWith("b", "daydreaming" as never)] })],
    ["an unreadable mission", () => snap(copyHome("unreadable-mission"), MID)],
    ["a home that cannot be read", () => snapUnreadable()],
    ["a wait of unknown cause", () => snapWait("every provider is paused", MID + 10 * MINUTE)],
    ["a wait with no event", () => oneMission({ status: "waiting" }, { live: true })],
    ["a wait for a login", () => snapWait("x: claude needs a new login", MID + 10 * MINUTE)],
    ["a mission done at stage finalize and no lock", () => snap(copyHome("finalize-cut-off"), MID)],
    ["a mission that failed long ago (earlier work)", () => snap(copyHome("scope-mix"), Date.parse("2026-10-11T10:00:00.000Z"))],
    ["a mission saved busy and a run that is gone", () => oneMission({ status: "running", age: 10 * MINUTE })],
    ["a stale lock", () => oneMission({ status: "running" }, { live: true, lockAgeMs: LOCK_STALE_MS })],
  ])("%s", (_name, build) => {
    notGreen(build());
  });

  function snapUnreadable(): Snapshot {
    const file = join(emptyHome(), "a-file");
    writeFileSync(file, "x");
    return snap(file, MID);
  }

  function snapWait(reasonText: string, until: number): Snapshot {
    const m = missionAt(MID, "2026-10-11-a", { status: "waiting" });
    const home = buildHome({ missions: [{ mission: m, events: [makeEvent(m.id, MID - 5000, "limit.wait", { until: iso(until), reason: reasonText })] }], lock: { at: iso(MID - 10 * MINUTE) } }, MID);
    return snap(home, MID);
  }
});

describe("T-LAMP-PAGE: the lamps the page applies on its own clock", () => {
  it("carries a stale lamp and a not-responding lamp that are valid lamps", () => {
    const { freshness } = snap(emptyHome(), MID);
    expect(freshness).toMatchObject({ pollEveryMs: 4000, staleAfterMs: 30_000, notRespondingAfterMs: 300_000, notUpdatingText: "Not updating" });
    expect(freshness.notUpdating).toMatchObject({ state: "needs_look", word: "Needs a look", sentence: "Not updating. The page has had no news for a while." });
    expect(freshness.notUpdating.reasons.map((r) => r.code)).toEqual(["page_stale"]);
    expect(freshness.notResponding).toMatchObject({ state: "not_responding", word: "Not responding", sentence: "No news for 5 minutes. The last known state is shown greyed out." });
    expect(freshness.notResponding.reasons.map((r) => r.code)).toEqual(["no_news"]);
  });
});
