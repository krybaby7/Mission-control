// Builders for the dashboard's own tests: a home made in code, and a snapshot that must be valid. The fixtures are in
// test/fixtures/dashboard; this file is for the cases a fixture would only get in the way of.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearReadCache } from "../src/dashboard/read.js";
import { buildSnapshot, type SnapshotOptions } from "../src/dashboard/snapshot.js";
import type { Snapshot } from "../src/dashboard/types.js";
import type { Feature, Mission, MissionEvent } from "../src/types.js";
import { assertSnapshotShape, copyHome, emptyHome, FIXTURE_ROOT, makeEvent, makeFeature, makeMission, touch, withLock, withStop } from "./dashboard-helpers.js";

/** The capture's own clock for mid-run scenarios (spec 14.3): events are at 09:58, a run looked at 30 seconds in. */
export const MID = Date.parse("2026-10-11T09:58:30.000Z");
/** Five minutes later, for finished scenarios. */
export const FIN = Date.parse("2026-10-11T10:03:30.000Z");
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Builds a snapshot at `now` in UTC, makes sure it is a valid one, and fails when the build itself broke (a degraded
 * snapshot would otherwise look like a calm amber lamp). The read cache is cleared: a test may rewrite a file in place.
 */
export function snap(home: string, now: number, o: Partial<SnapshotOptions> = {}): Snapshot {
  clearReadCache();
  const s = buildSnapshot({
    home,
    now,
    timeZone: "UTC",
    onError: (err) => {
      throw err;
    },
    ...o,
  });
  assertSnapshotShape(s);
  return s;
}

export interface MissionParts {
  mission: Mission;
  events?: MissionEvent[];
  dispatch?: unknown;
}

export interface HomeParts {
  missions?: MissionParts[];
  /** A run lock: its start, and how long ago it was last touched. */
  lock?: { at: string; ageMs?: number; pid?: number; host?: string };
  stop?: boolean;
  /** quota.json (an object is written as JSON, a string as it is). */
  quota?: unknown;
  quotaMtimeMs?: number;
  /** usage.jsonl lines. */
  usage?: unknown[];
}

/** A home made in code. `now` is only used to date the lock's heartbeat. */
export function buildHome(parts: HomeParts, now: number): string {
  const home = emptyHome();
  for (const m of parts.missions ?? []) {
    const dir = join(home, "missions", m.mission.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mission.json"), JSON.stringify(m.mission, null, 2) + "\n");
    if (m.events !== undefined) writeFileSync(join(dir, "events.jsonl"), m.events.map((e) => JSON.stringify(e)).join("\n") + (m.events.length > 0 ? "\n" : ""));
    if (m.dispatch !== undefined) writeFileSync(join(dir, "dispatch.json"), typeof m.dispatch === "string" ? m.dispatch : JSON.stringify(m.dispatch));
  }
  if (parts.lock !== undefined) withLock(home, { at: parts.lock.at, ageMs: parts.lock.ageMs ?? 15 * SECOND, now, pid: parts.lock.pid, host: parts.lock.host });
  if (parts.stop === true) withStop(home);
  if (parts.quota !== undefined) {
    const file = join(home, "quota.json");
    writeFileSync(file, typeof parts.quota === "string" ? parts.quota : JSON.stringify(parts.quota));
    if (parts.quotaMtimeMs !== undefined) touch(file, parts.quotaMtimeMs);
  }
  if (parts.usage !== undefined) {
    mkdirSync(dirname(join(home, "usage.jsonl")), { recursive: true });
    writeFileSync(join(home, "usage.jsonl"), parts.usage.map((u) => JSON.stringify(u)).join("\n") + "\n");
  }
  return home;
}

/** A mission saved `age` ago, created three hours before that. Override anything. */
export function missionAt(now: number, id: string, o: Partial<Mission> & { age?: number } = {}): Mission {
  const { age = 10 * SECOND, ...rest } = o;
  return makeMission({ title: id, createdAt: iso(now - age - 3 * HOUR), updatedAt: iso(now - age), ...rest, id });
}

/** A feature in the given status; `done` ones carry one passing build. */
export function featureWith(id: string, status: Feature["status"], o: Partial<Feature> = {}): Feature {
  return makeFeature({
    title: id,
    status,
    ...(status === "done" ? { attempts: [{ rung: 0, action: "build", provider: "codex", model: "gpt-6.1-sol", effort: "medium", outcome: "pass", summary: "", at: "2026-10-11T09:58:00.000Z" }] } : {}),
    ...o,
    id,
  });
}

/** run.start / run.end events with the data the engine writes. */
export function runEvents(missionId: string, at: number, label: string, o: { end?: boolean; outcome?: string; n?: number; role?: string } = {}): MissionEvent[] {
  const n = o.n ?? 1;
  const base = { label, jobId: `${label}-${n}`, provider: "codex", model: "gpt-6.1-sol" };
  const out = [makeEvent(missionId, at, "run.start", { ...base, role: o.role ?? "engineer", effort: "medium" })];
  if (o.end === true) out.push(makeEvent(missionId, at + 1000, "run.end", { ...base, outcome: o.outcome ?? "ok", durationMs: 1000 }));
  return out;
}

// ───────────── The fixtures, each looked at on its own clock ─────────────

export interface FixtureCase {
  now: number;
  /** The start of the run lock to put in a copy (a mid-run capture has none; the capture driver held the lock in memory). */
  lockAt?: string;
}

/** The clock each fixture is looked at (spec 14.3); every other fixture is looked at five minutes after the capture. */
export const FIXTURE_CASES: Record<string, FixtureCase> = {
  "midrun-testing": { now: MID, lockAt: "2026-10-11T09:58:19.844Z" },
  "midrun-building": { now: MID, lockAt: "2026-10-11T09:58:19.844Z" },
  "midrun-reviewing": { now: MID, lockAt: "2026-10-11T09:58:19.844Z" },
  "limit-waiting": { now: MID, lockAt: "2026-10-11T09:58:00.000Z" },
  "login-wait": { now: MID, lockAt: "2026-10-11T09:58:00.000Z" },
  "trouble-wait": { now: MID, lockAt: "2026-10-11T09:58:00.000Z" },
  "unknown-wait": { now: MID, lockAt: "2026-10-11T09:58:00.000Z" },
  "feature-mission-labels": { now: MID, lockAt: "2026-10-11T09:58:00.000Z" },
  "modes-review-round": { now: Date.parse("2026-10-11T09:58:30.000Z"), lockAt: "2026-10-11T09:58:00.000Z" },
  "waiting-then-running": { now: Date.parse("2026-10-11T12:59:40.000Z"), lockAt: "2026-10-11T09:58:25.597Z" },
  "stale-busy-under-live-run": { now: MID, lockAt: "2026-10-11T09:50:00.000Z" },
  "restart-midnight": { now: Date.parse("2026-10-12T03:20:00.000Z"), lockAt: "2026-10-12T03:10:00.000Z" },
  "scope-mix": { now: Date.parse("2026-10-11T10:00:00.000Z") },
  "limit-then-done": { now: Date.parse("2026-10-11T13:03:30.000Z") },
  "multi-mission": { now: Date.parse("2026-10-11T13:03:30.000Z") },
  "hostile-strings": { now: MID },
};

/** The names of the committed fixtures. */
export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** A copy of the fixture, with its lock when it needs one, looked at on its own clock. */
export function fixtureSnapshot(name: string): Snapshot {
  const c = FIXTURE_CASES[name] ?? { now: FIN };
  const home = copyHome(name);
  if (c.lockAt !== undefined) withLock(home, { at: c.lockAt, ageMs: 15 * SECOND, now: c.now });
  return snap(home, c.now);
}
