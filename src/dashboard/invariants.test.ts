// Random homes: whatever the engine (or a person with an editor) leaves in the Mission Control home, the snapshot is
// built, is valid, and is never calm while something is wrong. The generator is seeded, so a failure can be replayed.
import { describe, expect, it } from "vitest";
import { makeEvent } from "../../test/dashboard-helpers.js";
import { buildHome, featureWith, HOUR, iso, MID, MINUTE, missionAt, SECOND, snap, type HomeParts } from "../../test/dashboard-kit.js";
import type { Feature, Mission, MissionEvent } from "../types.js";
import type { Snapshot } from "./types.js";

/** A small seeded generator (mulberry32): the same seed gives the same home. */
function random(seed: number): { next: () => number; pick: <T>(list: readonly T[]) => T; chance: (p: number) => boolean; int: (lo: number, hi: number) => number } {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T,
    chance: (p) => next() < p,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
  };
}

const STATUSES = ["queued", "running", "waiting", "done", "partial", "stopped", "failed", "hibernating"] as const;
const STAGES = ["onboard", "spec", "gate_a", "init", "features", "gate_c", "finalize", "complete", "dreaming"] as const;
const FEATURE_STATUSES = ["pending", "testing", "building", "reviewing", "done", "blocked", "skipped", "daydreaming"] as const;
const AGES = [0, 10 * SECOND, 59 * SECOND, 61 * SECOND, 5 * MINUTE, 3 * HOUR, 17 * HOUR + 59 * MINUTE, 19 * HOUR, 40 * HOUR, 200 * HOUR];
const STOP_REASONS = ["stop requested", "the disk is almost full (0.4 GB free)", "the AI command lines keep failing (x)", "no provider is free before the deadline (next chance y)", "who knows"];
const DECISIONS = [
  "Which colour should the buttons be?",
  '"Alpha": it needs a decision from you',
  "Have someone check the app before you rely on it: the final review of the whole app did not finish, so nobody reviewed it as a whole. “Review notes” and “Technical details” list what the reviewers found.",
  "Have someone check the app before you rely on it: run rm -rf ~",
];

function wait(r: ReturnType<typeof random>): MissionEvent["data"] {
  const until = MID + r.pick([-3 * HOUR, -MINUTE, 0, 10 * MINUTE, HOUR, 5 * HOUR]);
  const t = iso(until - 45_000);
  const reason = r.pick([
    `gpt-6.1-sol: session limit until ${t}`,
    `gpt-6.1-sol: codex keeps failing (net down; again), trying again at ${t}`,
    `gpt-6.1-sol: session limit until ${t}; claude-opus-5-5: claude needs a new login`,
    "claude-opus-5-5: claude needs a new login",
    "nobody knows",
    "",
  ]);
  return r.chance(0.1) ? { until: "soon", reason } : { until: iso(until), reason };
}

function events(r: ReturnType<typeof random>, id: string, featureIds: string[]): MissionEvent[] {
  const out: MissionEvent[] = [];
  let at = MID - r.pick(AGES) - 5 * MINUTE;
  const step = (type: string, data: Record<string, unknown> = {}): void => {
    at += r.int(1, 90) * SECOND;
    out.push(makeEvent(id, at, type, data));
  };
  for (let i = r.int(0, 12); i > 0; i--) {
    const f = r.chance(0.8) && featureIds.length > 0 ? r.pick(featureIds) : "ghost";
    switch (r.int(0, 11)) {
      case 0:
        step("mission.start", { stage: "spec" });
        break;
      case 1:
        step("mission.resume", { stage: "features" });
        break;
      case 2:
        step("mission.stopped", { reason: r.pick(STOP_REASONS) });
        break;
      case 3:
        step("mission.failed", { reason: r.pick(["No model could run: claude needs a new login.", "Internal error in stage spec: x", "who knows"]) });
        break;
      case 4:
        step("limit.wait", wait(r));
        break;
      case 5:
      case 6: {
        const label = r.pick([`build-${f}`, `test-${f}`, `review-${f}`, "spec", "gate-a", "gate-c", "nonsense"]);
        step("run.start", { label, jobId: `${label}-${r.int(1, 2)}`, role: "engineer" });
        break;
      }
      case 7: {
        const label = r.pick([`build-${f}`, "spec"]);
        step("run.end", { label, jobId: `${label}-${r.int(1, 2)}`, outcome: r.pick(["ok", "failed", "limited", "crashed", "timeout", "auth"]) });
        break;
      }
      case 8:
        step("run.interrupted", { label: "build-x" });
        break;
      case 9:
        step("feature.status", { feature: f, to: r.pick(["testing", "reviewing", "blocked", "skipped", "done"]), reason: "x" });
        break;
      case 10:
        step("verify", { label: r.pick(["gate-c", "gate-c-features", "other"]), ok: r.chance(0.5), timedOut: r.chance(0.2), feature: f });
        break;
      default:
        step(r.pick(["merge", "attempt", "error", "stage", "mystery.type"]), { feature: f, from: "features", to: "gate_c", action: "build", outcome: "fail", rung: r.int(0, 4) });
    }
  }
  return out;
}

function mission(r: ReturnType<typeof random>, n: number): { mission: Mission; events: MissionEvent[]; dispatch: unknown } {
  const id = `2026-10-11-m${n}`;
  const features: Feature[] = [];
  for (let i = r.int(0, 4); i > 0; i--) {
    const status = r.pick(FEATURE_STATUSES);
    features.push(
      featureWith(`f${features.length}`, status as never, {
        title: r.pick(["Alpha", "Beta", "Alpha", "Gamma"]),
        ...(status === "blocked" || status === "skipped" ? { blockedReason: r.pick(["it needs a decision from you", 'waiting on "Alpha", which was blocked', "its changes conflicted with work merged earlier (merge conflict)", "free text from an AI"]) } : {}),
        attempts: Array.from({ length: r.int(0, 3) }, () => ({ rung: 0, action: r.pick(["build", "diagnose", "fix"] as const), provider: "codex" as const, model: "m", effort: "low" as const, outcome: r.pick(["pass", "fail", "error"] as const), summary: "", at: "x" })),
      }),
    );
  }
  const m = missionAt(MID, id, {
    title: r.pick(["Habit tracker", "Habit tracker", "Recipe box", "Photo album"]),
    kind: r.pick(["greenfield", "feature"] as const),
    status: r.pick(STATUSES) as never,
    stage: r.pick(STAGES) as never,
    age: r.pick(AGES),
    features,
    decisionsNeeded: r.chance(0.3) ? [r.pick(DECISIONS)] : [],
    baselineBroken: r.chance(0.1),
    gateCRounds: r.int(0, 1),
  });
  if (m.status === "failed" && r.chance(0.7)) m.failure = { reason: r.pick(["No model could run: claude needs a new login.", "x"]), retryable: r.chance(0.5) };
  const dispatch = r.pick([undefined, { finalVerify: { ok: r.chance(0.5), head: "x", reviewed: r.chance(0.8), blocking: r.int(0, 2) } }, "{ garbage", { inflight: { label: "build-f0", feature: "f0", at: iso(MID) } }]);
  return { mission: m, events: events(r, id, features.map((f) => f.id)), dispatch };
}

function home(seed: number): HomeParts {
  const r = random(seed);
  const parts: HomeParts = { missions: Array.from({ length: r.int(0, 4) }, (_, n) => mission(r, n)) };
  const lock = r.pick(["none", "fresh", "fresh", "late", "stale"] as const);
  if (lock !== "none") parts.lock = { at: iso(MID - r.pick([30 * SECOND, 10 * MINUTE, 3 * HOUR])), ageMs: lock === "fresh" ? 15 * SECOND : lock === "late" ? 3 * MINUTE : 20 * MINUTE };
  parts.stop = r.chance(0.2);
  if (r.chance(0.5)) parts.quota = r.pick([{ version: 1, limits: { codex: { kind: "session", raw: "x", until: MID + HOUR } }, modelBlocks: [], utilization: [{ provider: "claude", window: "five_hour", utilization: r.next() * 1.2, resetsAt: MID + HOUR }] }, "{ cut", []]);
  if (r.chance(0.5)) parts.usage = [{ missionId: "2026-10-11-m0", durationMs: r.int(0, 10_000_000) }];
  return parts;
}

/** What must hold for any home. */
function check(s: Snapshot, label: string): void {
  const tonight = s.missions.filter((m) => m.scope === "tonight");
  const codes = s.lamp.reasons.map((r) => r.code);
  const problem = s.lamp.reasons.some((r) => r.severity === "now" || r.severity === "look");
  const hasWait = (m: Snapshot["missions"][number]): boolean => m.state === "waiting" && m.waiting !== null && (m.waiting.cause === "unknown" || m.waiting.cause === "login");
  // A calm lamp needs a calm cause.
  if (s.lamp.state === "on_track") {
    for (const m of tonight) {
      // The one exception: a mission left over from a killed night, which the live run has not reached yet.
      const leftover = m.state === "paused" && m.pausedWhy === "unexpected" && s.run.active;
      if (!leftover) expect(["working", "waiting", "done", "not_started"], `${label}: ${m.id} is ${m.state} under a green lamp`).toContain(m.state);
      expect(hasWait(m), `${label}: ${m.id} waits for an unknown reason or a login under a green lamp`).toBe(false);
      expect(m.readable, `${label}: ${m.id} is unreadable under a green lamp`).toBe(true);
      for (const f of m.features) expect(["stuck", "left_out", "unknown"], `${label}: ${m.id}/${f.id}`).not.toContain(f.state);
    }
    expect(s.counts.olderNeedYou, label).toBe(0);
    expect(s.counts.unreadableMissions, label).toBe(0);
  }
  // Everything that needs a person produces a reason, and the lamp says what it says.
  for (const m of tonight) {
    if (["needs_you", "unknown"].includes(m.state) || (m.state === "paused" && m.pausedWhy !== "unexpected")) {
      expect(problem, `${label}: ${m.id} is ${m.state} and the lamp has no reason`).toBe(true);
    }
    if (m.state === "partly_done") expect(problem, `${label}: ${m.id} is partly done and the lamp has no reason`).toBe(true);
  }
  if (s.lamp.state === "idle" || s.lamp.state === "on_track") expect(codes.some((c) => c === "working" || c === "all_done" || c === "nothing_tonight"), label).toBe(true);
  // A stale or absent run is never described as running.
  if (!s.run.active) {
    expect(s.now, label).toBeNull();
    expect(s.run.runningMs, label).toBeNull();
  }
  // One fact, one card; a stuck tile points at a card that exists.
  expect(new Set(s.needsYou.map((c) => c.id)).size, label).toBe(s.needsYou.length);
  // A red lamp has a red reason; an amber one an amber reason.
  if (s.lamp.state === "needs_you_now") expect(s.lamp.reasons.some((r) => r.severity === "now"), label).toBe(true);
  // The sentence is never empty and a calm one never contradicts the colour.
  expect(s.lamp.sentence.length, label).toBeGreaterThan(0);
  if (s.lamp.state !== "on_track") expect(s.lamp.sentence, label).not.toContain("Nothing needs you");
}

describe("invariants over random homes", () => {
  it("builds a valid snapshot for 400 random homes, and never a calm one while something is wrong", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const s = snap(buildHome(home(seed), MID), MID);
      check(s, `seed ${seed}`);
    }
  });

  it("the same random home gives the same snapshot twice", () => {
    for (const seed of [3, 17, 99, 250]) {
      const dir = buildHome(home(seed), MID);
      expect(JSON.stringify(snap(dir, MID))).toBe(JSON.stringify(snap(dir, MID)));
    }
  });
});
