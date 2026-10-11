import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyHome, makeEvent, touch, withLock } from "../../test/dashboard-helpers.js";
import { buildHome, featureWith, FIN, HOUR, iso, MID, MINUTE, missionAt, runEvents, SECOND, snap } from "../../test/dashboard-kit.js";
import { STALE_BUSY_AFTER_MS, TONIGHT_WINDOW_MS, WAIT_OVER_GRACE_MS } from "./constants.js";
import { isSavedBusy, readLabel } from "./missions.js";
import { builtInSettings } from "./snapshot.js";
import type { FeatureStateId, MissionStateId, Snapshot } from "./types.js";
import { AGENT_LABEL_KINDS } from "./vocabulary.js";

const ID = "2026-10-11-task-board";

/** A home with one running mission whose events end in the given run, and a fresh lock. */
function liveWith(events: (now: number) => ReturnType<typeof runEvents>, o: { stage?: "features" | "gate_c" | "finalize" | "init" | "spec"; features?: ReturnType<typeof featureWith>[]; lockAt?: string } = {}): Snapshot {
  const features = o.features ?? [featureWith("add-task", "building", { title: "Add a task" })];
  const home = buildHome(
    {
      missions: [{ mission: missionAt(MID, ID, { status: "running", stage: o.stage ?? "features", features, title: "Task board" }), events: events(MID) }],
      lock: { at: o.lockAt ?? iso(MID - 10 * MINUTE) },
    },
    MID,
  );
  return snap(home, MID);
}

describe("T-NOW: the now line", () => {
  it.each([
    ["midrun-testing", "test-add-task", "An AI is writing the checks for “Add a task”"],
    ["midrun-building", "build-add-task", "An AI is building “Add a task”"],
    ["midrun-reviewing", "review-add-task", "A second AI is reviewing “Add a task”"],
  ])("%s: the open run is %s", (fixture, label, text) => {
    const home = copyHome(fixture);
    withLock(home, { at: "2026-10-11T09:58:19.844Z", ageMs: 15_000, now: MID });
    const s = snap(home, MID);
    expect(s.now).toMatchObject({ kind: "agent", text, missionId: ID, featureId: "add-task", exact: true });
    expect(s.now?.since).toBeGreaterThan(Date.parse("2026-10-11T09:58:19.844Z"));
    expect(s.now?.sinceText).toMatch(/^\d+ s so far$/);
    expect(label).toMatch(/-add-task$/);
  });

  it.each([
    ["onboard", "An AI is reading the existing project"],
    ["spec", "An AI is writing the plan"],
    ["gate-a", "A second AI is checking the plan"],
    ["init", "An AI is setting up the app's foundation"],
    ["gate-c", "A second AI is doing the final check of the whole app"],
    ["report-prose", "A helper AI is writing the report"],
  ])("the %s run has no feature", (label, text) => {
    const s = liveWith((now) => runEvents(ID, now - 5 * SECOND, label));
    expect(s.now).toMatchObject({ kind: "agent", text, featureId: null, missionId: ID });
  });

  it.each([
    ["test", "An AI is writing the checks for “Add a task”"],
    ["build", "An AI is building “Add a task”"],
    ["review", "A second AI is reviewing “Add a task”"],
    ["fix", "An AI is fixing what the review found in “Add a task”"],
    ["diagnose", "An expert AI is working out why “Add a task” keeps failing"],
    ["context", "A helper AI is reading up on “Add a task”"],
    ["digest", "A helper AI is summarising why “Add a task” failed"],
  ])("the %s- run names its feature", (prefix, text) => {
    const s = liveWith((now) => runEvents(ID, now - 5 * SECOND, `${prefix}-add-task`));
    expect(s.now).toMatchObject({ kind: "agent", text, featureId: "add-task" });
  });

  it("names a feature id that contains dashes, a repair feature included", () => {
    const s = liveWith((now) => runEvents(ID, now - 5 * SECOND, "build-gate-c-fix-1"), { features: [featureWith("gate-c-fix-1", "building", { title: "Fix the cart" })] });
    expect(s.now).toMatchObject({ text: "An AI is building “Fix the cart”", featureId: "gate-c-fix-1" });
  });

  it("says 'a feature' for a label that matches no feature of the mission (E24)", () => {
    const s = liveWith((now) => runEvents(ID, now - 5 * SECOND, "build-no-such-feature"));
    expect(s.now).toMatchObject({ kind: "agent", text: "An AI is building a feature", featureId: null });
  });

  it("says 'An AI is working' for a label it does not know", () => {
    const s = liveWith((now) => runEvents(ID, now - 5 * SECOND, "something-else"));
    expect(s.now).toMatchObject({ kind: "agent", text: "An AI is working", featureId: null });
  });

  it("lets dispatch.json's inflight marker fill in the feature when the label cannot", () => {
    const home = buildHome(
      {
        missions: [
          {
            mission: missionAt(MID, ID, { status: "running", features: [featureWith("add-task", "building", { title: "Add a task" })] }),
            events: runEvents(ID, MID - 5 * SECOND, "diagnose-gone"),
            dispatch: { inflight: { label: "diagnose-gone", feature: "add-task", at: iso(MID - 5 * SECOND) } },
          },
        ],
        lock: { at: iso(MID - 10 * MINUTE) },
      },
      MID,
    );
    expect(snap(home, MID).now).toMatchObject({ featureId: "add-task", text: "An expert AI is working out why “Add a task” keeps failing" });
  });

  it("keeps the feature of the label when the inflight marker agrees", () => {
    const home = buildHome(
      {
        missions: [
          {
            mission: missionAt(MID, ID, { status: "running", features: [featureWith("add-task", "building", { title: "Add a task" })] }),
            events: runEvents(ID, MID - 5 * SECOND, "build-add-task"),
            dispatch: { inflight: { label: "build-add-task", feature: "add-task", at: iso(MID - 5 * SECOND) } },
          },
        ],
        lock: { at: iso(MID - 10 * MINUTE) },
      },
      MID,
    );
    expect(snap(home, MID).now).toMatchObject({ featureId: "add-task", text: "An AI is building “Add a task”" });
  });

  it("ignores an inflight marker for another label or for a feature that does not exist", () => {
    for (const inflight of [{ label: "other-label", feature: "add-task", at: iso(MID) }, { label: "diagnose-gone", feature: "ghost", at: iso(MID) }]) {
      const home = buildHome(
        {
          missions: [{ mission: missionAt(MID, ID, { status: "running", features: [featureWith("add-task", "building")] }), events: runEvents(ID, MID - 5 * SECOND, "diagnose-gone"), dispatch: { inflight } }],
          lock: { at: iso(MID - 10 * MINUTE) },
        },
        MID,
      );
      expect(snap(home, MID).now?.featureId).toBeNull();
    }
  });

  it("is null when the run is not live (a killed run leaves an open start behind, E23)", () => {
    const home = copyHome("midrun-building");
    expect(snap(home, MID).now).toBeNull();
    withLock(home, { at: "2026-10-11T09:58:19.844Z", ageMs: 5 * MINUTE, now: MID });
    expect(snap(home, MID).now).toBeNull();
    withLock(home, { at: "2026-10-11T09:58:19.844Z", ageMs: 5 * MINUTE - 1, now: MID });
    expect(snap(home, MID).now?.kind).toBe("agent");
  });

  it("matches starts and ends by jobId when they interleave", () => {
    const s = liveWith((now) => [
      ...runEvents(ID, now - 30 * SECOND, "build-add-task", { n: 1 }),
      ...runEvents(ID, now - 25 * SECOND, "review-add-task", { n: 1 }),
      makeEvent(ID, now - 20 * SECOND, "run.end", { label: "build-add-task", jobId: "build-add-task-1", outcome: "ok" }),
    ]);
    expect(s.now).toMatchObject({ text: "A second AI is reviewing “Add a task”" });
    const none = liveWith((now) => [
      ...runEvents(ID, now - 30 * SECOND, "build-add-task", { end: true }),
      ...runEvents(ID, now - 25 * SECOND, "review-add-task", { end: true }),
    ]);
    expect(none.now?.kind).toBe("between_steps");
  });

  it.each(["mission.resume", "mission.start", "mission.stopped", "mission.failed", "mission.end", "run.interrupted"])("a %s event clears an open run (E25)", (type) => {
    const s = liveWith((now) => [...runEvents(ID, now - 30 * SECOND, "build-add-task"), makeEvent(ID, now - 20 * SECOND, type, {})]);
    expect(s.now?.kind).not.toBe("agent");
  });

  it("does not count an open start older than the live run's own start: another process wrote it", () => {
    const s = liveWith((now) => runEvents(ID, now - 3 * HOUR, "build-add-task"), { lockAt: iso(MID - 10 * MINUTE) });
    expect(s.now?.kind).not.toBe("agent");
  });

  it("names the waiting mission when the sleep is on", () => {
    const home = copyHome("limit-waiting");
    withLock(home, { at: "2026-10-11T09:58:25.597Z", ageMs: 15_000, now: MID });
    const s = snap(home, MID);
    expect(s.now).toEqual({ kind: "waiting", text: "Waiting for allowance until 12:59. It resumes by itself.", missionId: "2026-10-11-reader", featureId: null, since: null, sinceText: null, exact: true });
  });

  it("the agent that follows a wait is the now line, and there is no wait left (E41)", () => {
    const home = copyHome("waiting-then-running");
    const now = Date.parse("2026-10-11T12:59:40.000Z");
    withLock(home, { at: "2026-10-11T09:58:25.597Z", ageMs: 15_000, now });
    const s = snap(home, now);
    expect(s.now).toMatchObject({ kind: "agent", text: "A second AI is checking the plan" });
    expect(s.missions[0]).toMatchObject({ state: "working", waiting: null });
    expect(s.allowance.waiting).toBeNull();
    expect(s.lamp.reasons.map((r) => r.code)).toEqual(["working"]);
  });

  describe("between steps (exact: false)", () => {
    const quiet = (stage: "features" | "gate_c" | "finalize" | "init", features = [featureWith("add-task", "building", { title: "Add a task" })]) => liveWith(() => [], { stage, features });

    it("names the feature in progress", () => {
      expect(quiet("features").now).toEqual({ kind: "between_steps", text: "Running the checks on “Add a task”", missionId: ID, featureId: "add-task", since: null, sinceText: null, exact: false });
      expect(quiet("features", [featureWith("add-task", "reviewing", { title: "Add a task" })]).now?.text).toBe("Running the checks on “Add a task”");
    });
    it("says what the final steps are", () => {
      expect(quiet("gate_c", [featureWith("add-task", "done")]).now?.text).toBe("Running the final tests");
      expect(quiet("finalize", [featureWith("add-task", "done")]).now?.text).toBe("Writing the report");
    });
    it("otherwise says the next step is being got ready", () => {
      expect(quiet("init", []).now?.text).toBe("Getting the next step ready");
      expect(quiet("features", [featureWith("a", "pending")]).now?.text).toBe("Getting the next step ready");
    });
  });

  it("has a label kind for every row of the label table", () => {
    expect(new Set(AGENT_LABEL_KINDS).size).toBe(13);
    expect(readLabel("build-x", new Set(["x"]))).toEqual({ kind: "build", featureId: "x" });
    expect(readLabel("gate-c", new Set())).toEqual({ kind: "gate-c", featureId: null });
    expect(readLabel("gate-c-fix-1", new Set(["gate-c-fix-1"]))).toEqual({ kind: "other", featureId: null });
    expect(readLabel("buildx", new Set(["x"]))).toEqual({ kind: "other", featureId: null });
  });

  it("follows the mission that owns the newest open run", () => {
    const a = missionAt(MID, "2026-10-11-a", { status: "running", features: [featureWith("fa", "building", { title: "Fa" })] });
    const b = missionAt(MID, "2026-10-11-b", { status: "running", features: [featureWith("fb", "building", { title: "Fb" })] });
    const home = buildHome(
      {
        missions: [
          { mission: a, events: runEvents(a.id, MID - 30 * SECOND, "build-fa") },
          { mission: b, events: runEvents(b.id, MID - 10 * SECOND, "build-fb") },
        ],
        lock: { at: iso(MID - 10 * MINUTE) },
      },
      MID,
    );
    expect(snap(home, MID).now).toMatchObject({ missionId: b.id, featureId: "fb" });
  });
});

describe("T-STATE: the mission table (spec 4.2)", () => {
  const live = (home: string, at = iso(MID - 10 * MINUTE)) => withLock(home, { at, ageMs: 15 * SECOND, now: MID });
  const one = (over: Parameters<typeof missionAt>[2], o: { live?: boolean; events?: ReturnType<typeof runEvents> } = {}) => {
    const home = buildHome({ missions: [{ mission: missionAt(MID, "2026-10-11-a", { stage: "features", ...over }), events: o.events ?? [] }] }, MID);
    if (o.live) live(home);
    return snap(home, MID).missions[0];
  };

  it.each<[string, Parameters<typeof missionAt>[2], boolean, MissionStateId, string | null]>([
    ["queued", { status: "queued", stage: "spec" }, false, "not_started", null],
    ["queued, run live", { status: "queued", stage: "spec" }, true, "not_started", null],
    ["running, run live", { status: "running" }, true, "working", null],
    ["running, no run", { status: "running" }, false, "paused", "unexpected"],
    ["waiting without events, run live", { status: "waiting" }, true, "waiting", null],
    ["waiting, no run", { status: "waiting" }, false, "paused", "unexpected"],
    ["stopped", { status: "stopped" }, false, "paused", "unknown"],
    ["done at stage complete", { status: "done", stage: "complete" }, false, "done", null],
    ["done at stage finalize, no run", { status: "done", stage: "finalize" }, false, "paused", "unexpected"],
    ["done at stage finalize, run live", { status: "done", stage: "finalize" }, true, "working", null],
    ["done at stage gate_c, run live", { status: "done", stage: "gate_c" }, true, "working", null],
    ["partial at stage complete", { status: "partial", stage: "complete" }, false, "partly_done", null],
    ["partial at stage features (the run cap), no run", { status: "partial", stage: "features" }, false, "paused", "unexpected"],
    ["failed", { status: "failed" }, false, "needs_you", null],
    ["failed, run live", { status: "failed" }, true, "needs_you", null],
    ["an unknown status", { status: "hibernating" as never }, false, "unknown", null],
    ["an unknown status, run live", { status: "hibernating" as never }, true, "unknown", null],
  ])("%s", (_name, over, isLive, state, why) => {
    const m = one(over, { live: isLive });
    expect(m?.state).toBe(state);
    expect(m?.pausedWhy).toBe(why);
  });

  it("an unknown stage makes the mission 'Needs a look', with every step still to do (E5)", () => {
    const m = one({ status: "running", stage: "dreaming" as never }, { live: true });
    expect(m).toMatchObject({ state: "unknown", word: "Needs a look", sentence: "This page does not know this state.", progressWord: "" });
    expect(m?.progress.every((p) => p.state === "todo")).toBe(true);
  });

  it("a failed mission stays 'Needs you' even if its stage has a name this page does not know", () => {
    expect(one({ status: "failed", stage: "dreaming" as never })?.state).toBe("needs_you");
  });

  it.each([
    ["The disk is almost full", "the disk is almost full (0.4 GB free)", "disk"],
    ["no space left", "ENOSPC: no space left on device", "disk"],
    ["failing agents", "the AI command lines keep failing (spawn claude ENOENT)", "ai_failing"],
    ["refusing work", "claude kept refusing work (usage limits or overload, 6 runs in a row): x", "ai_failing"],
    ["a deadline", "no provider is free before the deadline (next chance 2026-10-12T05:00:45.000Z)", "deadline"],
    ["a stop request", "stop requested", "stop_requested"],
    ["something else", "the moon is in the wrong phase", "unknown"],
  ])("a stopped mission paused because of %s is paused with '%s'", (_name, reason, why) => {
    const m = one({ status: "stopped" }, { events: [makeEvent("2026-10-11-a", MID - 5000, "mission.stopped", { stage: "features", reason })] });
    expect(m).toMatchObject({ state: "paused", pausedWhy: why });
  });

  it("uses the latest mission.stopped event", () => {
    const m = one({ status: "stopped" }, { events: [makeEvent("2026-10-11-a", MID - 9000, "mission.stopped", { reason: "stop requested" }), makeEvent("2026-10-11-a", MID - 5000, "mission.stopped", { reason: "the disk is almost full" })] });
    expect(m?.pausedWhy).toBe("disk");
  });

  describe("asleep (spec 4.2)", () => {
    const UNTIL = Date.parse("2026-10-11T12:59:10.596Z");

    // The run started before the mission's first event, as a real one does: otherwise the mission would look like
    // a leftover of an earlier night after a few minutes.
    function waitingAt(now: number) {
      const home = copyHome("limit-waiting");
      withLock(home, { at: "2026-10-11T09:58:00.000Z", ageMs: 15_000, now });
      return snap(home, now).missions[0];
    }

    it("is asleep until the end of the wait, and for the grace after it", () => {
      expect(waitingAt(MID)).toMatchObject({ state: "waiting", waiting: { cause: "limits", untilText: "12:59" } });
      expect(waitingAt(UNTIL + WAIT_OVER_GRACE_MS)?.state).toBe("waiting");
      expect(waitingAt(UNTIL + WAIT_OVER_GRACE_MS + 1)).toMatchObject({ state: "working", waiting: null });
    });

    it("without a run, a wait that is long over is Paused (unexpected), not working (E42)", () => {
      const home = copyHome("limit-waiting");
      const s = snap(home, UNTIL + WAIT_OVER_GRACE_MS + 1);
      expect(s.missions[0]).toMatchObject({ state: "paused", pausedWhy: "unexpected", waiting: null });
      expect(s.run.active).toBe(false);
    });

    it("is awake once an agent started after the wait, whatever the saved status says", () => {
      const m = missionAt(MID, "2026-10-11-a", { status: "waiting" });
      const home = buildHome(
        {
          missions: [
            {
              mission: m,
              events: [
                makeEvent(m.id, MID - 60 * SECOND, "limit.wait", { until: iso(MID + HOUR), reason: "x: session limit until y" }),
                ...runEvents(m.id, MID - 5 * SECOND, "spec", { end: true }),
              ],
            },
          ],
          lock: { at: iso(MID - 10 * MINUTE) },
        },
        MID,
      );
      expect(snap(home, MID).missions[0]).toMatchObject({ state: "working", waiting: null });
    });

    it("a wait with no event at all is asleep for an unknown cause (E29)", () => {
      const m = missionAt(MID, "2026-10-11-a", { status: "waiting" });
      const home = buildHome({ missions: [{ mission: m, events: [] }], lock: { at: iso(MID - 10 * MINUTE) } }, MID);
      const s = snap(home, MID);
      expect(s.missions[0]).toMatchObject({ state: "waiting", waiting: { until: 0, untilText: "", cause: "unknown", text: "Waiting. Mission Control cannot tell why." } });
      expect(s.lamp.reasons.map((r) => r.code)).toEqual(["wait_unknown"]);
    });

    it("a wait whose time cannot be read is asleep for an unknown cause", () => {
      const m = missionAt(MID, "2026-10-11-a", { status: "waiting" });
      const home = buildHome({ missions: [{ mission: m, events: [makeEvent(m.id, MID - 5000, "limit.wait", { until: "tomorrow", reason: "x: session limit until y" })] }], lock: { at: iso(MID - 10 * MINUTE) } }, MID);
      expect(snap(home, MID).missions[0]).toMatchObject({ state: "waiting", waiting: { cause: "unknown" } });
    });

    it("uses the newest wait", () => {
      const m = missionAt(MID, "2026-10-11-a", { status: "waiting" });
      const reason = (at: number) => `gpt-6.1-sol: session limit until ${iso(at)}`;
      const home = buildHome(
        {
          missions: [
            {
              mission: m,
              events: [
                makeEvent(m.id, MID - 50 * SECOND, "limit.wait", { until: iso(MID + 30 * MINUTE), reason: reason(MID + 29 * MINUTE) }),
                makeEvent(m.id, MID - 5 * SECOND, "limit.wait", { until: iso(MID + 2 * HOUR), reason: reason(MID + 2 * HOUR - 45_000) }),
              ],
            },
          ],
          lock: { at: iso(MID - 10 * MINUTE) },
        },
        MID,
      );
      expect(snap(home, MID).missions[0]?.waiting?.untilText).toBe("11:58");
    });
  });

  describe("savedBusy and the stage complete (spec 1.8)", () => {
    it("isSavedBusy: running, waiting, and done or partial before the stage is complete", () => {
      const busy = (status: string, stage: string): boolean => isSavedBusy(missionAt(MID, "x", { status: status as never, stage: stage as never }));
      expect(busy("running", "features")).toBe(true);
      expect(busy("waiting", "gate_a")).toBe(true);
      expect(busy("done", "finalize")).toBe(true);
      expect(busy("partial", "gate_c")).toBe(true);
      expect(busy("done", "complete")).toBe(false);
      expect(busy("partial", "complete")).toBe(false);
      expect(busy("queued", "spec")).toBe(false);
      expect(busy("stopped", "features")).toBe(false);
      expect(busy("failed", "features")).toBe(false);
    });

    it("finalize-cut-off is working with a run and paused without one (E43)", () => {
      const home = copyHome("finalize-cut-off");
      const without = snap(home, MID);
      expect(without.missions[0]).toMatchObject({ state: "paused", pausedWhy: "unexpected" });
      expect(without.lamp.reasons.map((r) => r.code)).toEqual(["run_gone_pending"]);
      expect(without.needsYou).toEqual([]);
      const later = snap(home, MID + MINUTE);
      expect(later.lamp.reasons.map((r) => r.code)).toEqual(["run_gone"]);
      expect(later.needsYou.map((c) => c.kind)).toEqual(["run_stopped"]);
      withLock(home, { at: "2026-10-11T09:58:00.000Z", ageMs: 15_000, now: MID });
      const withRun = snap(home, MID);
      expect(withRun.missions[0]).toMatchObject({ state: "working", sentence: "Landing the work and writing the report." });
      expect(withRun.now?.text).toBe("A helper AI is writing the report");
    });
  });

  describe("a leftover under a live run (spec 4.2, E44)", () => {
    const LOCK_AT = Date.parse("2026-10-11T09:50:00.000Z");
    const stale = (now: number) => {
      const home = copyHome("stale-busy-under-live-run");
      withLock(home, { at: iso(LOCK_AT), ageMs: 15_000, now });
      return snap(home, now);
    };

    it("is paused once the run has been live for STALE_BUSY_AFTER_MS and has not touched it", () => {
      const s = stale(LOCK_AT + STALE_BUSY_AFTER_MS);
      const killed = s.missions.find((m) => m.id === "2026-10-10-killed-night");
      expect(killed).toMatchObject({ state: "paused", pausedWhy: "unexpected", sentence: "Paused: its earlier run stopped unexpectedly. It continues when its turn comes." });
      expect(killed?.features.find((f) => f.id === "two")).toMatchObject({ state: "paused", reason: { text: "Paused. It continues on the next run.", author: "engine" } });
    });

    it("is working one millisecond before that", () => {
      const s = stale(LOCK_AT + STALE_BUSY_AFTER_MS - 1);
      expect(s.missions.find((m) => m.id === "2026-10-10-killed-night")?.state).toBe("working");
    });

    it("is not the worked mission: the mission that owns the open run is, and the last activity follows it", () => {
      const now = LOCK_AT + 8 * MINUTE + 30 * SECOND;
      const s = stale(now);
      expect(s.now).toMatchObject({ kind: "agent", missionId: "2026-10-09-first-in-line", text: "An AI is writing the plan" });
      expect(s.run.line).toBe("First in line (new app), running 8 min");
      // The newest sign of life of the worked mission, not of the leftover (which was last saved at 01:00).
      expect(s.run.lastActivityAt).toBe(Date.parse("2026-10-11T09:58:10.000Z"));
      expect(s.lamp.state).toBe("on_track");
      expect(s.lamp.reasons.map((r) => r.code)).toEqual(["queued", "working"]);
    });

    it("an open start of the killed night is not this run's", () => {
      const s = stale(LOCK_AT + 8 * MINUTE);
      const killed = s.missions.find((m) => m.id === "2026-10-10-killed-night");
      expect(killed?.state).toBe("paused");
      expect(s.now?.missionId).not.toBe("2026-10-10-killed-night");
    });

    it("becomes run_gone when the run ends without reaching it", () => {
      const home = copyHome("stale-busy-under-live-run");
      const s = snap(home, MID);
      expect(s.missions.every((m) => m.state !== "working")).toBe(true);
      expect(s.lamp.reasons.map((r) => r.code)).toContain("run_gone");
    });
  });

  it("restart-midnight keeps the earlier work in tonight (E48)", () => {
    const home = copyHome("restart-midnight");
    const now = Date.parse("2026-10-12T03:20:00.000Z");
    withLock(home, { at: "2026-10-12T03:10:00.000Z", ageMs: 15_000, now });
    const s = snap(home, now);
    expect(s.missions.map((m) => [m.id, m.scope, m.state])).toEqual([
      ["2026-10-11-fitness-log", "tonight", "done"],
      ["2026-10-11-recipe-finder", "tonight", "working"],
    ]);
    expect(s.debrief?.missions.map((d) => d.missionId)).toEqual(["2026-10-11-fitness-log"]);
    expect(s.timeline.items.some((i) => i.missionId === "2026-10-11-fitness-log")).toBe(true);
    expect(s.now).toMatchObject({ missionId: "2026-10-11-recipe-finder", featureId: "filters" });
  });
});

describe("T-STATE: features (spec 4.3)", () => {
  function featureStates(missionStatus: string, stage: string, isLive: boolean, statuses: string[]): FeatureStateId[] {
    const features = statuses.map((status, i) => featureWith(`f${i}`, status as never));
    const home = buildHome({ missions: [{ mission: missionAt(MID, "2026-10-11-a", { status: missionStatus as never, stage: stage as never, features }) }] }, MID);
    if (isLive) withLock(home, { at: iso(MID - 10 * MINUTE), ageMs: 15_000, now: MID });
    return snap(home, MID).missions[0]?.features.map((f) => f.state) ?? [];
  }
  const IN_PROGRESS = ["testing", "building", "reviewing"];

  it("pending is waiting its turn, done is done, blocked is stuck, skipped is left out", () => {
    expect(featureStates("running", "features", true, ["pending", "done", "blocked", "skipped"])).toEqual(["waiting_turn", "done", "stuck", "left_out"]);
  });

  it("an unknown status is unknown", () => {
    expect(featureStates("running", "features", true, ["daydreaming"])).toEqual(["unknown"]);
  });

  it("testing and building are being built, reviewing is being reviewed, while the mission works or waits", () => {
    expect(featureStates("running", "features", true, IN_PROGRESS)).toEqual(["being_built", "being_built", "being_reviewed"]);
  });

  it.each([
    ["stopped", "features", false, "paused"],
    ["failed", "features", false, "paused"],
    ["queued", "features", false, "paused"],
    ["running", "features", false, "paused"],
    ["done", "complete", false, "unknown"],
    ["partial", "complete", false, "unknown"],
    ["hibernating", "features", false, "unknown"],
  ])("a feature in progress in a %s mission at %s (live %s) is %s", (status, stage, isLive, expected) => {
    expect(featureStates(status, stage, isLive, IN_PROGRESS)).toEqual([expected, expected, expected]);
  });

  it("carries on as being built in a mission that sleeps", () => {
    const home = copyHome("limit-waiting");
    withLock(home, { at: "2026-10-11T09:58:25.597Z", ageMs: 15_000, now: MID });
    expect(snap(home, MID).missions[0]?.features.map((f) => f.state)).toEqual(["waiting_turn", "waiting_turn"]);
  });

  it("explains a feature on hold by the wait (spec 4.3)", () => {
    const m = missionAt(MID, "2026-10-11-a", { status: "waiting", features: [featureWith("a", "building"), featureWith("b", "reviewing")] });
    const reasonOf = (reason: string, untilMs: number) => {
      const home = buildHome({ missions: [{ mission: m, events: [makeEvent(m.id, MID - 5 * SECOND, "limit.wait", { until: iso(untilMs), reason })] }], lock: { at: iso(MID - 10 * MINUTE) } }, MID);
      return snap(home, MID).missions[0]?.features.map((f) => f.reason);
    };
    expect(reasonOf(`gpt-6.1-sol: session limit until ${iso(MID + HOUR - 45_000)}`, MID + HOUR)).toEqual([
      { text: "On hold until 10:58, waiting for allowance.", author: "engine" },
      { text: "On hold until 10:58, waiting for allowance.", author: "engine" },
    ]);
    expect(reasonOf(`gpt-6.1-sol: codex keeps failing (x), trying again at ${iso(MID + HOUR)}`, MID + HOUR)?.[0]?.text).toBe("On hold until 10:58, waiting for the AI team.");
    expect(reasonOf("every provider is paused", MID + HOUR)?.[0]?.text).toBe("On hold. Mission Control cannot tell why.");
  });

  it("steps used: first try 1 of 5, partial fixture 3 of 5, none 0 of 5 (spec 1.6)", () => {
    const done = snap(copyHome("done"), FIN).missions[0]?.features ?? [];
    expect(done.map((f) => [f.steps.used, f.steps.total, f.reinforcements, f.recovered])).toEqual([[1, 5, 0, false], [1, 5, 0, false], [1, 5, 0, false], [1, 5, 0, false]]);
    expect(done[0]?.steps.caption).toBe("Tried 1 time (1 build try)");
    const partial = snap(copyHome("partial-blocked"), FIN).missions[0]?.features ?? [];
    const signup = partial.find((f) => f.id === "signup");
    expect(signup).toMatchObject({ steps: { used: 3, total: 5, caption: "Tried 3 times (2 build tries and 1 expert diagnosis)" }, reinforcements: 2, recovered: false, state: "stuck" });
    expect(partial.find((f) => f.id === "pay-subscription")).toMatchObject({ steps: { used: 0, total: 5, caption: "No tries yet" }, reinforcements: 0, state: "left_out" });
    expect(partial.find((f) => f.id === "settings")?.acceptanceTests).toBe(1);
  });

  it("counts a fix after review in the caption but not as a step", () => {
    const f = featureWith("a", "done", {
      attempts: [
        { rung: 0, action: "build", provider: "codex", model: "m", effort: "low", outcome: "pass", summary: "", at: "x" },
        { rung: 0, action: "fix", provider: "codex", model: "m", effort: "low", outcome: "pass", summary: "", at: "x" },
        { rung: 0, action: "fix", provider: "codex", model: "m", effort: "low", outcome: "fail", summary: "", at: "x" },
      ],
    });
    const home = buildHome({ missions: [{ mission: missionAt(MID, "2026-10-11-a", { status: "done", stage: "complete", features: [f] }) }] }, MID);
    expect(snap(home, MID).missions[0]?.features[0]).toMatchObject({ steps: { used: 1, total: 5, caption: "Tried 1 time (1 build try, 2 fixes after review)" }, reinforcements: 0, recovered: false });
  });

  it("caps the steps at the ladder size, and reads the size from the settings by the feature's kind", () => {
    const attempts = Array.from({ length: 9 }, () => ({ rung: 0, action: "build" as const, provider: "codex" as const, model: "m", effort: "low" as const, outcome: "fail" as const, summary: "", at: "x" }));
    const home = buildHome({ missions: [{ mission: missionAt(MID, "2026-10-11-a", { status: "partial", stage: "complete", features: [featureWith("a", "blocked", { attempts }), featureWith("b", "blocked", { attempts, kind: "mechanical" })] }) }] }, MID);
    const settings = { ...builtInSettings(), ladders: { standard: 5, mechanical: 4 } };
    const [a, b] = snap(home, MID, { settings }).missions[0]?.features ?? [];
    expect(a?.steps).toMatchObject({ used: 5, total: 5 });
    expect(b?.steps).toMatchObject({ used: 4, total: 4 });
    expect(a?.reinforcements).toBe(4);
  });

  it("marks a feature that passed after a failed build as recovered; a first-pass one is not (spec 1.6)", () => {
    const failed = { rung: 0, action: "build" as const, provider: "codex" as const, model: "m", effort: "low" as const, outcome: "fail" as const, summary: "", at: "x" };
    const passed = { ...failed, outcome: "pass" as const };
    const home = buildHome(
      {
        missions: [
          {
            mission: missionAt(MID, "2026-10-11-a", {
              status: "done",
              stage: "complete",
              features: [
                featureWith("a", "done", { attempts: [failed, passed] }),
                featureWith("b", "done", { attempts: [passed] }),
                featureWith("c", "building", { attempts: [failed] }),
                featureWith("d", "done", { attempts: [{ ...failed, action: "diagnose" }, passed] }),
              ],
            }),
          },
        ],
      },
      MID,
    );
    const features = snap(home, MID).missions[0]?.features ?? [];
    expect(features.map((f) => f.recovered)).toEqual([true, false, false, false]);
    expect(features[0]?.reason).toEqual({ text: "Built and checked after a retry.", author: "engine" });
    expect(features[1]?.reason).toBeNull();
  });

  it("recognises a repair feature by its id", () => {
    const home = buildHome({ missions: [{ mission: missionAt(MID, "2026-10-11-a", { status: "done", stage: "complete", features: [featureWith("gate-c-fix-1", "done"), featureWith("gate-c-fixed", "done")] }) }] }, MID);
    expect(snap(home, MID).missions[0]?.features.map((f) => f.isRepair)).toEqual([true, false]);
  });

  it("repair-lap: the repair feature is marked, and a finished mission is no longer in a repair round", () => {
    const m = snap(copyHome("repair-lap"), MID).missions[0];
    expect(m?.features.map((f) => [f.id, f.isRepair])).toEqual([["add-expense", false], ["gate-c-fix-1", true]]);
    expect(m?.repairLap).toBe(false);
  });
});

describe("T-STATE: the progress line (spec 4.4)", () => {
  const stepsOf = (status: string, stage: string, gateCRounds = 0) => {
    const home = buildHome({ missions: [{ mission: missionAt(MID, "2026-10-11-a", { status: status as never, stage: stage as never, gateCRounds }) }] }, MID);
    const m = snap(home, MID).missions[0];
    return { states: m?.progress.map((p) => p.state), word: m?.progressWord, ids: m?.progress.map((p) => p.id), words: m?.progress.map((p) => p.word), repairLap: m?.repairLap };
  };

  it("has the five steps in order", () => {
    const r = stepsOf("running", "spec");
    expect(r.ids).toEqual(["plan", "plan_check", "build", "final_check", "landed"]);
    expect(r.words).toEqual(["Plan", "Plan check", "Build", "Final check", "Landed"]);
  });

  it.each([
    ["onboard", ["current", "todo", "todo", "todo", "todo"], "Plan"],
    ["spec", ["current", "todo", "todo", "todo", "todo"], "Plan"],
    ["gate_a", ["done", "current", "todo", "todo", "todo"], "Plan check"],
    ["init", ["done", "done", "current", "todo", "todo"], "Build"],
    ["features", ["done", "done", "current", "todo", "todo"], "Build"],
    ["gate_c", ["done", "done", "done", "current", "todo"], "Final check"],
    ["finalize", ["done", "done", "done", "done", "current"], "Landed"],
    ["complete", ["done", "done", "done", "done", "done"], "Landed"],
  ])("stage %s", (stage, states, word) => {
    const r = stepsOf("running", stage);
    expect(r.states).toEqual(states);
    expect(r.word).toBe(word);
  });

  it("a mission that has not started shows every step still to do", () => {
    expect(stepsOf("queued", "spec").states).toEqual(["todo", "todo", "todo", "todo", "todo"]);
    expect(stepsOf("queued", "spec").word).toBe("");
  });

  it("is a repair round only at stage features after the final check sent the team back", () => {
    expect(stepsOf("running", "features", 1).repairLap).toBe(true);
    expect(stepsOf("running", "features", 0).repairLap).toBe(false);
    expect(stepsOf("running", "gate_c", 1).repairLap).toBe(false);
  });
});

describe("T-SCOPE: tonight and before (spec 12)", () => {
  const NOW = Date.parse("2026-10-11T10:00:00.000Z");
  const idsBy = (s: Snapshot, scope: string) => s.missions.filter((m) => m.scope === scope).map((m) => m.id);

  it("no run: tonight is the last 18 hours; older unresolved ones are before; old finished ones are hidden", () => {
    const s = snap(copyHome("scope-mix"), NOW);
    expect(idsBy(s, "tonight")).toEqual(["2026-10-11-tonight-work"]);
    expect(idsBy(s, "before")).toEqual(["2026-10-06-queued-long-ago", "2026-10-10-older-partial", "2026-10-10-login-lapsed"]);
    expect(s.missions.map((m) => m.openFromBefore)).toEqual([false, true, true, true]);
    expect(s.counts).toMatchObject({ tonightMissions: 1, openFromBefore: 3, olderNeedYou: 1, olderWaitingForYou: 1, olderMissionsHidden: 1 });
  });

  it("the three kinds of 'before' are told apart (a failed one, a finished one with leftovers, any other)", () => {
    const s = snap(copyHome("scope-mix"), NOW);
    const byId = Object.fromEntries(s.missions.map((m) => [m.id, m]));
    expect(byId["2026-10-10-login-lapsed"]?.state).toBe("needs_you");
    expect(byId["2026-10-10-older-partial"]?.state).toBe("partly_done");
    expect(byId["2026-10-06-queued-long-ago"]?.state).toBe("not_started");
  });

  it("with a run on, work that is left becomes tonight's, a finished old mission stays before", () => {
    const home = copyHome("scope-mix");
    withLock(home, { at: "2026-10-11T09:55:00.000Z", ageMs: 15_000, now: NOW });
    const s = snap(home, NOW);
    expect(idsBy(s, "tonight")).toEqual(["2026-10-06-queued-long-ago", "2026-10-10-login-lapsed", "2026-10-11-tonight-work"]);
    expect(idsBy(s, "before")).toEqual(["2026-10-10-older-partial"]);
  });

  it("orders each group oldest first, then by id", () => {
    const a = missionAt(NOW, "2026-10-11-b", { createdAt: iso(NOW - 5 * HOUR), updatedAt: iso(NOW - HOUR) });
    const b = missionAt(NOW, "2026-10-11-a", { createdAt: iso(NOW - 5 * HOUR), updatedAt: iso(NOW - HOUR) });
    const c = missionAt(NOW, "2026-10-11-c", { createdAt: iso(NOW - 9 * HOUR), updatedAt: iso(NOW - 2 * HOUR) });
    const home = buildHome({ missions: [{ mission: a }, { mission: b }, { mission: c }] }, NOW);
    expect(snap(home, NOW).missions.map((m) => m.id)).toEqual(["2026-10-11-c", "2026-10-11-a", "2026-10-11-b"]);
  });

  it("the window is 18 hours to the millisecond", () => {
    const at = (age: number) => {
      const home = buildHome({ missions: [{ mission: missionAt(NOW, "2026-10-11-a", { status: "partial", stage: "complete", age, features: [featureWith("x", "blocked")] }) }] }, NOW);
      return snap(home, NOW).missions[0]?.scope;
    };
    expect(at(TONIGHT_WINDOW_MS)).toBe("tonight");
    expect(at(TONIGHT_WINDOW_MS + 1)).toBe("before");
  });

  it("a finished mission with nothing left is hidden once it is old, and counted", () => {
    const home = buildHome({ missions: [{ mission: missionAt(NOW, "2026-10-11-a", { status: "done", stage: "complete", age: 30 * HOUR, features: [featureWith("x", "done")] }) }] }, NOW);
    const s = snap(home, NOW);
    expect(s.missions).toEqual([]);
    expect(s.counts.olderMissionsHidden).toBe(1);
    expect(s.lamp.state).toBe("idle");
  });

  it.each([
    ["a decision", { decisionsNeeded: ["Which colour?"] }],
    ["a blocked feature", { features: [featureWith("x", "blocked")] }],
    ["a skipped feature", { features: [featureWith("x", "skipped")] }],
    ["a broken baseline", { baselineBroken: true }],
  ])("a finished old mission with %s is before, not hidden", (_name, over) => {
    const home = buildHome({ missions: [{ mission: missionAt(NOW, "2026-10-11-a", { status: "partial", stage: "complete", age: 30 * HOUR, ...over }) }] }, NOW);
    const s = snap(home, NOW);
    expect(s.missions[0]).toMatchObject({ scope: "before", openFromBefore: true });
    expect(s.counts).toMatchObject({ olderWaitingForYou: 1, olderNeedYou: 0 });
  });

  it("an unreadable mission is always tonight, whatever the age of its file", () => {
    const home = copyHome("unreadable-mission");
    touch(join(home, "missions", "2026-10-11-broken", "mission.json"), NOW - 400 * HOUR);
    const s = snap(home, NOW);
    expect(s.missions.find((m) => m.id === "2026-10-11-broken")).toMatchObject({ readable: false, scope: "tonight", state: "unknown", word: "Needs a look", sentence: "Its file cannot be read.", title: "2026-10-11-broken" });
    expect(s.counts.unreadableMissions).toBe(1);
  });

  it("a folder without mission.json is not a mission (E49)", () => {
    const s = snap(copyHome("no-mission-json"), MID);
    expect(s.missions.map((m) => m.id)).toEqual(["2026-10-11-calendar"]);
    expect(s.counts.unreadableMissions).toBe(0);
    expect(s.lamp.state).toBe("on_track");
  });

  it("a mission file that appears between two polls is picked up, and one that was half-created never flashes amber", () => {
    const home = copyHome("no-mission-json");
    const before = snap(home, MID);
    writeFileSync(join(home, "missions", "2026-10-11-half-created", "mission.json"), JSON.stringify(missionAt(MID, "2026-10-11-half-created", { status: "queued", stage: "spec" })));
    const after = snap(home, MID);
    expect(before.missions).toHaveLength(1);
    expect(after.missions.map((m) => m.id)).toContain("2026-10-11-half-created");
    rmSync(join(home, "missions", "2026-10-11-half-created", "mission.json"));
    expect(snap(home, MID).lamp.state).toBe("on_track");
  });

  it("many old missions cost no more than a count (E27)", () => {
    const missions = Array.from({ length: 300 }, (_, i) => ({
      mission: missionAt(NOW, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}-m${i}`, { status: "done", stage: "complete", age: 30 * HOUR + i * HOUR, features: [featureWith("x", "done")] }),
    }));
    const home = buildHome({ missions }, NOW);
    const started = Date.now();
    const s = snap(home, NOW);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(s.missions).toEqual([]);
    expect(s.counts.olderMissionsHidden).toBe(300);
  });
});
