import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CreateMissionInit, MissionStore, slugify } from "./state.js";
import type { RoleOverride, UsageRecord } from "./types.js";
import { sha256 } from "./util/fs.js";

let home: string;
let store: MissionStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mc-state-"));
  store = new MissionStore(home);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

/** 2026-10-09 14:30 in the process local zone. */
const NOW = new Date(2026, 9, 9, 14, 30, 0).getTime();

function init(overrides: Partial<CreateMissionInit> = {}): CreateMissionInit {
  return {
    kind: "greenfield",
    title: "Habit Tracker",
    request: "Build me a habit tracker",
    repoPath: "",
    baseBranch: "main",
    profile: "mixed",
    nowMs: NOW,
    ...overrides,
  };
}

const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("slugify", () => {
  it.each([
    ["Habit Tracker", "habit-tracker"],
    ["  Hello,   World!!  ", "hello-world"],
    ["a---b___c", "a-b-c"],
    ["--edge--", "edge"],
    ["Café Crème Brûlée", "cafe-creme-brulee"],
    ["Bob's To-Do List", "bobs-to-do-list"],
    ["Rock’n’Roll Quiz", "rocknroll-quiz"],
    ["Version 2.0 (beta)", "version-2-0-beta"],
    ["ＦＵＬＬ ｗｉｄｔｈ", "full-width"],
    ["ÉCOLE", "ecole"],
    // Compatibility letters without a lowercase form decompose to ASCII capitals, which must be kept.
    ["𝐇𝐞𝐥𝐥𝐨 𝐖𝐨𝐫𝐥𝐝", "hello-world"],
    ["ℌello", "hello"],
    ["ℝeal ℂomplex", "real-complex"],
    ["𝓗𝓪𝓫𝓲𝓽", "habit"],
    ["İstanbul", "istanbul"],
  ])("%j → %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it.each(["", "   ", "!!!", "日本語", "🚀🚀"])("falls back to 'mission' when nothing usable remains (%j)", (input) => {
    expect(slugify(input)).toBe("mission");
  });

  it("caps the length at 40 by default", () => {
    expect(slugify("a".repeat(100))).toBe("a".repeat(40));
  });

  it("never ends with a dash after truncation", () => {
    const input = `${"a".repeat(39)} tail`; // the cut lands right after the dash
    expect(slugify(input)).toBe("a".repeat(39));
  });

  it("honors a custom maxLen", () => {
    expect(slugify("the quick brown fox", 9)).toBe("the-quick");
    expect(slugify("the quick brown fox", 10)).toBe("the-quick");
    expect(slugify("the quick brown fox", 100)).toBe("the-quick-brown-fox");
  });

  it("truncates the fallback when maxLen is shorter than it", () => {
    expect(slugify("???", 3)).toBe("mis");
  });

  it.each([0, -1, 2.5, Number.NaN])("rejects maxLen %s", (maxLen) => {
    expect(() => slugify("x", maxLen)).toThrow(RangeError);
  });

  it("always yields a non-empty [a-z0-9-] slug without dash runs", () => {
    const inputs = ["Ünïcödé — test", "a/b\\c..d", "\t\nline\nbreaks\t", "x".repeat(41) + "-y", "-".repeat(50), "MiXeD CaSe 123"];
    for (const input of inputs) {
      const slug = slugify(input);
      expect(slug).toMatch(SLUG_SHAPE);
      expect(slug.length).toBeLessThanOrEqual(40);
    }
  });
});

describe("MissionStore construction and paths", () => {
  it("requires an absolute, expanded home", () => {
    expect(() => new MissionStore("relative/home")).toThrow(/absolute/);
    expect(() => new MissionStore("~/.mission-control")).toThrow(/absolute/);
    expect(store.home).toBe(home);
  });

  it("does not touch the disk until something is written", () => {
    const fresh = join(home, "not-yet");
    const s = new MissionStore(fresh);
    expect(s.list()).toEqual([]);
    expect(s.stopRequested()).toBe(false);
    expect(s.readUsage()).toEqual([]);
    expect(existsSync(fresh)).toBe(false);
  });

  it("derives mission paths under the home", () => {
    expect(store.missionDir("m1")).toBe(join(home, "missions", "m1"));
    expect(store.reportPath("m1")).toBe(join(home, "missions", "m1", "report.md"));
    expect(store.worktreesDir("m1")).toBe(join(home, "worktrees", "m1"));
    expect(existsSync(store.worktreesDir("m1"))).toBe(false);
  });

  it("creates the logs directory on demand", () => {
    const logs = store.logsDir("m1");
    expect(logs).toBe(join(home, "missions", "m1", "logs"));
    expect(existsSync(logs)).toBe(true);
    expect(store.logsDir("m1")).toBe(logs); // idempotent
  });

  it.each(["", ".", "..", "../escape", "a/b", "a\\b", "nul\0byte"])("rejects unsafe mission id %j", (id) => {
    expect(() => store.missionDir(id)).toThrow(/invalid mission id/);
    expect(() => store.worktreesDir(id)).toThrow(/invalid mission id/);
    expect(() => store.load(id)).toThrow(/invalid mission id/);
    expect(() => store.appendEvent(id, "x")).toThrow(/invalid mission id/);
  });
});

describe("createMission", () => {
  it("creates a queued greenfield mission at the spec stage and persists it", () => {
    const m = store.createMission(init());
    const at = new Date(NOW).toISOString();
    expect(m).toEqual({
      id: "2026-10-09-habit-tracker",
      kind: "greenfield",
      title: "Habit Tracker",
      request: "Build me a habit tracker",
      repoPath: "",
      baseBranch: "main",
      integrationBranch: "mc/2026-10-09-habit-tracker",
      profile: "mixed",
      roleOverrides: [],
      status: "queued",
      helpers: { contextPack: true, failureDigest: true, reportProse: true },
      stage: "spec",
      createdAt: at,
      updatedAt: at,
      features: [],
      baselineBroken: false,
      baselineFailures: [],
      decisionsNeeded: [],
      gateCRounds: 0,
      agentRuns: 0,
      notes: [],
    });
    const file = join(home, "missions", m.id, "mission.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(m);
    expect(store.load(m.id)).toEqual(m);
  });

  it("starts feature missions at the onboard stage and copies role overrides", () => {
    const overrides: RoleOverride[] = [{ role: "engineer", family: "codex", tier: "frontier" }];
    const m = store.createMission(
      init({ kind: "feature", title: "Add dark mode", repoPath: "/repos/app", baseBranch: "develop", roleOverrides: overrides }),
    );
    expect(m.stage).toBe("onboard");
    expect(m.repoPath).toBe("/repos/app");
    expect(m.baseBranch).toBe("develop");
    expect(m.roleOverrides).toEqual(overrides);
    expect(m.roleOverrides).not.toBe(overrides);
    expect(m.roleOverrides[0]).not.toBe(overrides[0]);
    overrides[0]!.tier = "light";
    expect(store.load(m.id).roleOverrides[0]?.tier).toBe("frontier");
  });

  it("adds -2, -3… when the id is taken", () => {
    const ids = [1, 2, 3].map(() => store.createMission(init()).id);
    expect(ids).toEqual(["2026-10-09-habit-tracker", "2026-10-09-habit-tracker-2", "2026-10-09-habit-tracker-3"]);
    // Different titles with the same slug collide too, and existing missions are never overwritten.
    const other = store.createMission(init({ title: "habit   tracker!", request: "another" }));
    expect(other.id).toBe("2026-10-09-habit-tracker-4");
    expect(store.load(ids[0]!).request).toBe("Build me a habit tracker");
    expect(store.list().map((m) => m.integrationBranch)).toEqual(ids.concat(other.id).map((id) => `mc/${id}`));
  });

  it("skips over suffixes already taken by other titles", () => {
    store.createMission(init({ title: "Habit Tracker 2" })); // slug "habit-tracker-2"
    store.createMission(init()); // "habit-tracker"
    expect(store.createMission(init()).id).toBe("2026-10-09-habit-tracker-3");
  });

  it("treats a leftover empty mission directory as taken", () => {
    mkdirSync(join(home, "missions", "2026-10-09-habit-tracker"), { recursive: true });
    expect(store.createMission(init()).id).toBe("2026-10-09-habit-tracker-2");
  });

  it("uses 'mission' for titles without usable characters", () => {
    expect(store.createMission(init({ title: "???" })).id).toBe("2026-10-09-mission");
  });

  it("dates the id in the local time zone, not UTC", () => {
    const savedTz = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      const lateUtc = Date.UTC(2026, 9, 9, 12, 0, 0); // already Oct 10 in Kiritimati
      expect(store.createMission(init({ nowMs: lateUtc })).id).toBe("2026-10-10-habit-tracker");
      process.env.TZ = "America/Los_Angeles"; // UTC-7 in October
      const earlyUtc = Date.UTC(2026, 9, 9, 3, 0, 0); // still Oct 8 in Los Angeles
      expect(store.createMission(init({ nowMs: earlyUtc })).id).toBe("2026-10-08-habit-tracker");
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  it("zero-pads month and day", () => {
    const jan5 = new Date(2027, 0, 5, 0, 1).getTime();
    expect(store.createMission(init({ nowMs: jan5 })).id).toBe("2027-01-05-habit-tracker");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1e20])("rejects nowMs %s without reserving an id", (nowMs) => {
    expect(() => store.createMission(init({ nowMs }))).toThrow(/invalid timestamp/);
    expect(() => store.createMission(init({ nowMs }))).toThrow(RangeError);
    const missions = join(home, "missions");
    expect(existsSync(missions) ? readdirSync(missions) : []).toEqual([]);
    expect(store.createMission(init()).id).toBe("2026-10-09-habit-tracker"); // no suffix used up
  });

  it("keeps long titles to a 40-character slug", () => {
    const m = store.createMission(init({ title: "Build a habit tracker with streaks, reminders and charts" }));
    expect(m.id).toBe("2026-10-09-build-a-habit-tracker-with-streaks-remin");
    expect(m.id.length).toBe("2026-10-09-".length + 40);
  });
});

describe("load / save", () => {
  it("throws a clear error for an unknown mission", () => {
    expect(() => store.load("2026-01-01-nope")).toThrow(/no mission with id "2026-01-01-nope"/);
  });

  it("throws on a corrupt or foreign mission file", () => {
    const dir = join(home, "missions", "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mission.json"), "{ not json");
    expect(() => store.load("bad")).toThrow(/invalid JSON/);
    writeFileSync(join(dir, "mission.json"), "[]");
    expect(() => store.load("bad")).toThrow(/not a valid mission/);
    writeFileSync(join(dir, "mission.json"), "null");
    expect(() => store.load("bad")).toThrow(/not a valid mission/);
    const other = store.createMission(init({ title: "other" }));
    writeFileSync(join(dir, "mission.json"), JSON.stringify(other));
    expect(() => store.load("bad")).toThrow(`holds mission "${other.id}", expected "bad"`);
  });

  it.each([
    ["features", undefined],
    ["features", {}],
    ["notes", "none"],
    ["decisionsNeeded", null],
    ["baselineFailures", undefined],
    ["roleOverrides", undefined],
    ["status", 3],
    ["stage", undefined],
    ["kind", undefined],
    ["integrationBranch", undefined],
    ["createdAt", "yesterday"],
    ["baselineBroken", "no"],
    ["gateCRounds", "0"],
  ])("rejects a mission file whose %s is %j, naming the field", (field, value) => {
    const m = store.createMission(init());
    const file = join(store.missionDir(m.id), "mission.json");
    writeFileSync(file, JSON.stringify({ ...m, [field]: value }));
    expect(() => store.load(m.id)).toThrow(`is not a valid mission file (bad or missing ${field})`);
    expect(store.list()).toEqual([]);
  });

  it("accepts a mission with its optional fields set", () => {
    const m = store.createMission(init());
    m.baseSha = "abc123";
    m.integrationWorktree = "/tmp/wt";
    store.save(m, NOW);
    expect(store.load(m.id)).toEqual(m);
  });

  it("sets updatedAt from nowMs and persists every change", () => {
    const m = store.createMission(init());
    m.status = "running";
    m.notes.push("started");
    store.save(m, NOW + 60_000);
    expect(m.updatedAt).toBe(new Date(NOW + 60_000).toISOString());
    const loaded = store.load(m.id);
    expect(loaded.status).toBe("running");
    expect(loaded.notes).toEqual(["started"]);
    expect(loaded.updatedAt).toBe(m.updatedAt);
    expect(loaded.createdAt).toBe(new Date(NOW).toISOString());
  });

  it("rejects an invalid nowMs without touching the mission", () => {
    const m = store.createMission(init());
    m.notes.push("unsaved");
    expect(() => store.save(m, Number.NaN)).toThrow(/invalid timestamp: NaN/);
    expect(m.updatedAt).toBe(new Date(NOW).toISOString());
    expect(store.load(m.id).notes).toEqual([]);
  });

  it("defaults updatedAt to the current time", () => {
    const m = store.createMission(init());
    const before = Date.now();
    store.save(m);
    const updated = Date.parse(m.updatedAt);
    expect(updated).toBeGreaterThanOrEqual(before);
    expect(updated).toBeLessThanOrEqual(Date.now());
  });

  it("writes atomically without leaving temp files behind", () => {
    const m = store.createMission(init());
    for (let i = 0; i < 5; i++) store.save(m, NOW + i);
    expect(readdirSync(store.missionDir(m.id))).toEqual(["mission.json"]);
  });
});

describe("list", () => {
  it("returns [] when there are no missions", () => {
    expect(store.list()).toEqual([]);
    mkdirSync(join(home, "missions"));
    expect(store.list()).toEqual([]);
  });

  it("sorts by createdAt ascending regardless of id order", () => {
    const late = store.createMission(init({ title: "aaa", nowMs: NOW + 2_000 }));
    const early = store.createMission(init({ title: "zzz", nowMs: NOW }));
    const middle = store.createMission(init({ title: "mmm", nowMs: NOW + 1_000 }));
    expect(store.list().map((m) => m.id)).toEqual([early.id, middle.id, late.id]);
  });

  it("orders missions created in the same millisecond by id", () => {
    const b = store.createMission(init({ title: "b" }));
    const a = store.createMission(init({ title: "a" }));
    expect(store.list().map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it("skips unreadable directories, malformed missions and stray files", () => {
    const good = store.createMission(init());
    const missions = join(home, "missions");
    mkdirSync(join(missions, "empty-dir"));
    mkdirSync(join(missions, "corrupt"));
    writeFileSync(join(missions, "corrupt", "mission.json"), "{");
    mkdirSync(join(missions, "2026-10-09-habit"));
    writeFileSync(
      join(missions, "2026-10-09-habit", "mission.json"),
      JSON.stringify({ id: "2026-10-09-habit", createdAt: new Date(NOW).toISOString() }), // no features, status…
    );
    mkdirSync(join(missions, "renamed"));
    writeFileSync(join(missions, "renamed", "mission.json"), JSON.stringify(good));
    mkdirSync(join(missions, ".hidden"));
    writeFileSync(join(missions, "stray.txt"), "hello");
    expect(store.list().map((m) => m.id)).toEqual([good.id]);
  });
});

describe("events", () => {
  it("appends events in order and reads them back", () => {
    store.appendEvent("m1", "stage", { from: "spec", to: "gate_a" }, NOW);
    store.appendEvent("m1", "run.end", { outcome: "ok" }, NOW + 5);
    expect(store.readEvents("m1")).toEqual([
      { at: new Date(NOW).toISOString(), missionId: "m1", type: "stage", data: { from: "spec", to: "gate_a" } },
      { at: new Date(NOW + 5).toISOString(), missionId: "m1", type: "run.end", data: { outcome: "ok" } },
    ]);
    expect(existsSync(join(home, "missions", "m1", "events.jsonl"))).toBe(true);
  });

  it("defaults data to {} and at to now", () => {
    const before = Date.now();
    store.appendEvent("m1", "error");
    const [event] = store.readEvents("m1");
    expect(event?.data).toEqual({});
    expect(Date.parse(event!.at)).toBeGreaterThanOrEqual(before);
  });

  it("keeps events per mission and returns [] for none", () => {
    store.appendEvent("m1", "a", {}, NOW);
    store.appendEvent("m2", "b", {}, NOW);
    expect(store.readEvents("m1").map((e) => e.type)).toEqual(["a"]);
    expect(store.readEvents("m2").map((e) => e.type)).toEqual(["b"]);
    expect(store.readEvents("m3")).toEqual([]);
  });

  it("survives a torn line from a crash", () => {
    store.appendEvent("m1", "a", {}, NOW);
    writeFileSync(join(home, "missions", "m1", "events.jsonl"), '{"at":"x","missionId":"m1","type":"torn', { flag: "a" });
    store.appendEvent("m1", "b", {}, NOW);
    expect(store.readEvents("m1").map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("skips lines that parse but are not events", () => {
    store.appendEvent("m1", "a", {}, NOW);
    const junk = ["42", '"str"', "null", "[]", '{"at":"x","type":"t"}', '{"at":1,"type":"t","data":{}}', '{"at":"x","data":{}}'];
    writeFileSync(join(home, "missions", "m1", "events.jsonl"), junk.join("\n") + "\n", { flag: "a" });
    store.appendEvent("m1", "b", {}, NOW);
    expect(store.readEvents("m1").map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("rejects an invalid nowMs without writing", () => {
    expect(() => store.appendEvent("m1", "a", {}, Number.NaN)).toThrow(RangeError);
    expect(store.readEvents("m1")).toEqual([]);
  });
});

describe("usage ledger", () => {
  function record(atMs: number, model = "claude-sonnet-5-5"): UsageRecord {
    return {
      at: new Date(atMs).toISOString(),
      missionId: "m1",
      role: "engineer",
      provider: "claude",
      model,
      effort: "medium",
      outcome: "ok",
      durationMs: 1000,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0.01, turns: 3 },
    };
  }

  it("returns [] before anything is recorded", () => {
    expect(store.readUsage()).toEqual([]);
    expect(store.readUsage(0)).toEqual([]);
  });

  it("appends to <home>/usage.jsonl and reads everything back", () => {
    const recs = [record(NOW), record(NOW + 1000, "gpt-6.1-sol")];
    recs.forEach((r) => store.appendUsage(r));
    expect(store.readUsage()).toEqual(recs);
    expect(readFileSync(join(home, "usage.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("filters by sinceMs inclusively", () => {
    [NOW - 1, NOW, NOW + 1].forEach((t) => store.appendUsage(record(t)));
    expect(store.readUsage(NOW).map((r) => r.at)).toEqual([new Date(NOW).toISOString(), new Date(NOW + 1).toISOString()]);
    expect(store.readUsage(NOW + 2)).toEqual([]);
  });

  it("skips lines that parse but are not usage records, with or without sinceMs", () => {
    store.appendUsage(record(NOW));
    const junk = ["null", "42", '"str"', "[]", "{}", '{"at":5,"usage":{}}', `{"at":"${new Date(NOW).toISOString()}"}`];
    writeFileSync(join(home, "usage.jsonl"), junk.join("\n") + "\n", { flag: "a" });
    store.appendUsage(record(NOW + 1));
    expect(store.readUsage()).toEqual([record(NOW), record(NOW + 1)]);
    expect(store.readUsage(0)).toEqual([record(NOW), record(NOW + 1)]);
    expect(store.readUsage(NOW + 1)).toEqual([record(NOW + 1)]);
  });

  it("drops records with an unparseable time only when filtering", () => {
    store.appendUsage({ ...record(NOW), at: "garbage" });
    expect(store.readUsage()).toHaveLength(1);
    expect(store.readUsage(0)).toEqual([]);
  });
});

describe("STOP file", () => {
  it("requests, detects and clears a stop", () => {
    expect(store.stopRequested()).toBe(false);
    store.requestStop();
    expect(existsSync(join(home, "STOP"))).toBe(true);
    expect(store.stopRequested()).toBe(true);
    store.requestStop(); // idempotent
    store.clearStop();
    expect(store.stopRequested()).toBe(false);
    expect(() => store.clearStop()).not.toThrow();
  });

  it("creates the home when requesting a stop before any run", () => {
    const s = new MissionStore(join(home, "fresh"));
    s.requestStop();
    expect(s.stopRequested()).toBe(true);
  });

  it("notices a STOP file created by another process", () => {
    writeFileSync(join(home, "STOP"), "");
    expect(store.stopRequested()).toBe(true);
  });
});

describe("acquireLock", () => {
  const lockPath = () => join(home, "mc.lock");
  const writeLock = (content: unknown) =>
    writeFileSync(lockPath(), typeof content === "string" ? content : JSON.stringify(content));
  const readLock = () => JSON.parse(readFileSync(lockPath(), "utf8")) as { pid: number; at: string; host: string; start?: string };
  /** The guard a contender creates while deleting a stale lock with this content (or this successor key). */
  const guardPath = (key: string) => `${lockPath()}.${sha256(key).slice(0, 16)}.takeover`;

  it("writes {pid, at, host, start} and removes the lock on release", () => {
    const before = Date.now();
    const release = store.acquireLock();
    const lock = readLock();
    expect(Object.keys(lock).sort()).toEqual(HAS_PROC ? ["at", "host", "pid", "start"] : ["at", "host", "pid"]);
    expect(lock.pid).toBe(process.pid);
    expect(lock.host).toBe(hostname());
    if (HAS_PROC) expect(lock.start).toBe(procStart(process.pid));
    expect(Date.parse(lock.at)).toBeGreaterThanOrEqual(before);
    release();
    expect(existsSync(lockPath())).toBe(false);
    expect(() => release()).not.toThrow();
    expect(readdirSync(home)).toEqual([]); // no temp files left
  });

  it("creates a missing home", () => {
    const s = new MissionStore(join(home, "a", "b"));
    const release = s.acquireLock();
    expect(existsSync(join(home, "a", "b", "mc.lock"))).toBe(true);
    release();
  });

  it("can be acquired again after release", () => {
    store.acquireLock()();
    const release = store.acquireLock();
    expect(readLock().pid).toBe(process.pid);
    release();
  });

  it("refuses when a live other process holds it", () => {
    const content = JSON.stringify({ pid: process.ppid, at: "2026-10-09T00:00:00.000Z", host: hostname() });
    writeLock(content);
    expect(() => store.acquireLock()).toThrow(`another mc run is active (pid ${process.ppid})`);
    expect(readFileSync(lockPath(), "utf8")).toBe(content);
    expect(readdirSync(home)).toEqual(["mc.lock"]);
  });

  it("refuses a second acquisition within this process, from any store instance", () => {
    const release = store.acquireLock();
    expect(() => store.acquireLock()).toThrow(`another mc run is active (pid ${process.pid})`);
    expect(() => new MissionStore(home).acquireLock()).toThrow(/another mc run is active/);
    release();
    new MissionStore(home).acquireLock()();
  });

  it("takes over a lock left by a dead process, leaving no guard or temp files", () => {
    writeLock({ pid: deadPid(), at: "2026-10-08T00:00:00.000Z", host: hostname() });
    const release = store.acquireLock();
    expect(readLock().pid).toBe(process.pid);
    expect(readdirSync(home)).toEqual(["mc.lock"]);
    release();
    expect(existsSync(lockPath())).toBe(false);
  });

  it("takes over a lock carrying our pid that this process does not hold (pid reused after a crash)", () => {
    writeLock({ pid: process.pid, at: "2026-10-08T00:00:00.000Z", host: hostname() });
    const release = store.acquireLock();
    expect(readLock().at).not.toBe("2026-10-08T00:00:00.000Z");
    release();
  });

  it.each([
    ["corrupt JSON", "{ pid: "],
    ["an empty file", ""],
    ["null", "null"],
    ["an array", "[4242]"],
    ["no pid", { at: "x" }],
    ["pid 0", { pid: 0, at: "x" }],
    ["a negative pid", { pid: -1, at: "x" }],
    ["a fractional pid", { pid: 1.5, at: "x" }],
    ["a string pid", { pid: String(process.ppid), at: "x" }],
    ["no pid on another host", { at: "x", host: "other-container" }],
  ])("treats a lock with %s as stale without probing it", (_label, content) => {
    const kill = vi.spyOn(process, "kill");
    writeLock(content);
    const release = store.acquireLock();
    expect(readLock().pid).toBe(process.pid);
    expect(kill).not.toHaveBeenCalled();
    release();
  });

  it.runIf(HAS_PROC)("takes over a lock whose pid now belongs to a process that started later (pid reused)", () => {
    // process.ppid is alive, but it is not the process that wrote this lock: that one started at another time.
    writeLock({ pid: process.ppid, at: "2026-01-01T00:00:00.000Z", host: hostname(), start: "another-boot:12345" });
    const release = store.acquireLock();
    expect(readLock().pid).toBe(process.pid);
    release();
  });

  it.runIf(HAS_PROC)("refuses while the process that wrote the lock (same pid, same start) is alive", () => {
    const content = JSON.stringify({ pid: process.ppid, at: "2026-01-01T00:00:00.000Z", host: hostname(), start: procStart(process.ppid) });
    writeLock(content);
    expect(() => store.acquireLock()).toThrow(`another mc run is active (pid ${process.ppid})`);
    expect(readFileSync(lockPath(), "utf8")).toBe(content);
  });

  it("counts EPERM as a live process", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    });
    writeLock({ pid: 4242, at: "x", host: hostname() });
    expect(() => store.acquireLock()).toThrow("another mc run is active (pid 4242)");
  });

  it.each([
    ["this host", hostname()],
    ["no host (a lock from before hosts were recorded)", undefined],
  ])("probes the pid of a lock from %s with signal 0", (_label, host) => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });
    writeLock({ pid: 4242, at: "x", host });
    store.acquireLock()();
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });

  it("release leaves a lock that now belongs to someone else", () => {
    const release = store.acquireLock();
    const foreign = JSON.stringify({ pid: process.ppid, at: "2026-10-09T01:00:00.000Z", host: hostname() });
    writeLock(foreign);
    release();
    expect(readFileSync(lockPath(), "utf8")).toBe(foreign);
  });

  it("release tolerates a lock that was already removed", () => {
    const release = store.acquireLock();
    rmSync(lockPath());
    expect(() => release()).not.toThrow();
  });

  describe("held from another host (another Docker container), whose pid cannot be probed", () => {
    const foreignLock = { pid: process.ppid, at: "x", host: "other-container" }; // the pid even exists here

    it("refuses while the holder's heartbeat is recent", () => {
      const kill = vi.spyOn(process, "kill");
      writeLock(foreignLock);
      backdate(lockPath(), 4 * 60_000);
      expect(() => store.acquireLock()).toThrow(`another mc run is active (pid ${process.ppid} on host other-container)`);
      expect(readLock()).toEqual(foreignLock);
      expect(kill).not.toHaveBeenCalled();
    });

    it("takes over once the heartbeat is more than five minutes old", () => {
      const kill = vi.spyOn(process, "kill");
      writeLock(foreignLock);
      backdate(lockPath(), 5 * 60_000 + 1_000);
      const release = store.acquireLock();
      expect(readLock().pid).toBe(process.pid);
      expect(kill).not.toHaveBeenCalled();
      release();
    });
  });

  describe("activeRun (read-only probe)", () => {
    it("is undefined without a lock, or with a stale or corrupt one, and never changes the lock", () => {
      expect(store.activeRun()).toBeUndefined();
      writeLock({ pid: deadPid(), at: "x", host: hostname() });
      expect(store.activeRun()).toBeUndefined();
      writeLock({ pid: 7, at: "x", host: "other-container" });
      backdate(lockPath(), 5 * 60_000 + 1_000);
      expect(store.activeRun()).toBeUndefined();
      writeLock("{ pid: ");
      expect(store.activeRun()).toBeUndefined();
      expect(readFileSync(lockPath(), "utf8")).toBe("{ pid: ");
    });

    it("describes a live holder: this process, another one here, or a run in another container with a fresh heartbeat", () => {
      const release = store.acquireLock();
      expect(store.activeRun()).toBe(`pid ${process.pid}`);
      release();
      writeLock({ pid: process.ppid, at: "x", host: hostname() });
      expect(store.activeRun()).toBe(`pid ${process.ppid}`);
      writeLock({ pid: 7, at: "x", host: "3f2a1b2c3d4e" });
      expect(store.activeRun()).toBe("pid 7 on host 3f2a1b2c3d4e");
      expect(existsSync(lockPath())).toBe(true);
    });
  });

  describe("heartbeat", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("refreshes the lock's mtime every minute while held, and stops on release", () => {
      const release = store.acquireLock();
      backdate(lockPath(), 10 * 60_000);
      vi.advanceTimersByTime(60_000);
      expect(Math.abs(statSync(lockPath()).mtimeMs - Date.now())).toBeLessThan(1_000);
      release();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves a lock that now belongs to someone else untouched", () => {
      const release = store.acquireLock();
      const foreign = JSON.stringify({ pid: 4242, at: "x", host: "other-container" });
      writeLock(foreign);
      backdate(lockPath(), 10 * 60_000);
      const mtime = statSync(lockPath()).mtimeMs;
      vi.advanceTimersByTime(3 * 60_000);
      expect(statSync(lockPath()).mtimeMs).toBe(mtime);
      release();
      expect(readFileSync(lockPath(), "utf8")).toBe(foreign);
    });

    it("tolerates the lock disappearing", () => {
      const release = store.acquireLock();
      rmSync(lockPath());
      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
      expect(existsSync(lockPath())).toBe(false);
      release();
    });
  });

  describe("takeover guard", () => {
    it("backs off while another contender is removing the same stale lock", () => {
      const stale = JSON.stringify({ pid: deadPid(), at: "x", host: hostname() });
      writeLock(stale);
      writeFileSync(guardPath(stale), JSON.stringify({ pid: 4242, at: "x", host: hostname() }));
      expect(() => store.acquireLock()).toThrow(/could not acquire .*mc\.lock: it keeps changing/);
      expect(readFileSync(lockPath(), "utf8")).toBe(stale);
      rmSync(guardPath(stale)); // the contender finishes
      store.acquireLock()();
    });

    it("competes for successor guards when contenders died holding the guard", () => {
      const stale = JSON.stringify({ pid: deadPid(), at: "x", host: hostname() });
      writeLock(stale);
      const firstGuard = JSON.stringify({ pid: 4242, at: "a", host: hostname() });
      const secondGuard = JSON.stringify({ pid: 4243, at: "b", host: hostname() });
      writeFileSync(guardPath(stale), firstGuard);
      writeFileSync(guardPath(`${stale}\n${firstGuard}`), secondGuard);
      backdate(guardPath(stale), 11_000);
      backdate(guardPath(`${stale}\n${firstGuard}`), 11_000);
      const release = store.acquireLock();
      expect(readLock().pid).toBe(process.pid);
      // Abandoned guards are left alone (deleting one could delete a live successor); ours is gone.
      const leftovers = [guardPath(stale), guardPath(`${stale}\n${firstGuard}`)].map((p) => basename(p));
      expect(readdirSync(home).sort()).toEqual(["mc.lock", ...leftovers].sort());
      release();
    });
  });
});

describe("acquireLock across processes", () => {
  /** Lets a plain node child import this repo's TypeScript: types are stripped, "./x.js" falls back to "./x.ts". */
  const TS_RESOLVE_HOOK = `export async function resolve(spec, ctx, next) {
    try { return await next(spec, ctx); } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND" && spec.endsWith(".js")) return next(spec.slice(0, -3) + ".ts", ctx);
      throw err;
    }
  }`;
  const NODE_ARGS = [
    "--no-warnings",
    "--experimental-strip-types",
    "--import",
    dataUrl(`import { register } from "node:module"; register(${JSON.stringify(dataUrl(TS_RESOLVE_HOOK))});`),
  ];
  const STATE_URL = new URL("./state.ts", import.meta.url).href;

  /** Holds the lock and exits without releasing it, like a crashed run. */
  const HOLDER_SCRIPT = `
    const [stateUrl, home] = process.argv.slice(2);
    const { MissionStore } = await import(stateUrl);
    new MissionStore(home).acquireLock();
    console.log(process.pid);
  `;

  /**
   * Until runMs passes: acquire, prove exclusive ownership with an O_EXCL marker file, release, and often
   * leave a dead process's lock behind (written atomically, like a real one) so the others race to take it over.
   */
  const CONTENDER_SCRIPT = `
    import { closeSync, linkSync, openSync, rmSync, writeFileSync } from "node:fs";
    import { hostname } from "node:os";
    import { join } from "node:path";
    const [stateUrl, home, deadPid, startAt, runMs] = process.argv.slice(2);
    const { MissionStore } = await import(stateUrl);
    const store = new MissionStore(home);
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
    const lockFile = join(home, "mc.lock");
    const marker = join(home, "holder");
    const stats = { acquired: 0, overlaps: 0, planted: 0 };
    sleep(Number(startAt) - Date.now());
    while (Date.now() < Number(startAt) + Number(runMs)) {
      let release;
      try { release = store.acquireLock(); } catch { continue; }
      stats.acquired++;
      try { closeSync(openSync(marker, "wx")); } catch { stats.overlaps++; }
      sleep(1);
      rmSync(marker, { force: true });
      release();
      if (Math.random() < 0.7) {
        const tmp = lockFile + "." + process.pid + ".plant";
        writeFileSync(tmp, JSON.stringify({ pid: Number(deadPid), at: new Date().toISOString(), host: hostname(), planter: process.pid, n: stats.planted }));
        try { linkSync(tmp, lockFile); stats.planted++; } catch {}
        rmSync(tmp, { force: true });
      }
    }
    console.log(JSON.stringify(stats));
  `;

  let scripts: string;
  beforeEach(() => {
    scripts = mkdtempSync(join(tmpdir(), "mc-state-scripts-"));
    writeFileSync(join(scripts, "holder.mjs"), HOLDER_SCRIPT);
    writeFileSync(join(scripts, "contender.mjs"), CONTENDER_SCRIPT);
  });
  afterEach(() => {
    rmSync(scripts, { recursive: true, force: true });
  });

  function runNode(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...NODE_ARGS, join(scripts, script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  it("does not keep the process alive, and a crashed holder's lock is taken over", async () => {
    const child = await runNode("holder.mjs", [STATE_URL, home]);
    expect(child.stderr).toBe("");
    expect(child.code).toBe(0); // exited on its own although the lock (and its heartbeat timer) was never released
    const lockPid = () => (JSON.parse(readFileSync(join(home, "mc.lock"), "utf8")) as { pid: number }).pid;
    expect(lockPid()).toBe(Number(child.stdout.trim()));
    const release = store.acquireLock();
    expect(lockPid()).toBe(process.pid);
    release();
  }, 20_000);

  it("never has two holders, even with several processes racing to take over stale locks", async () => {
    const contenders = 4;
    const startAt = Date.now() + 1_500; // once every child has started
    const runs = await Promise.all(
      Array.from({ length: contenders }, () => runNode("contender.mjs", [STATE_URL, home, String(deadPid()), String(startAt), "1500"])),
    );
    for (const run of runs) expect(run).toMatchObject({ code: 0, stderr: "" });
    const stats = runs.map((run) => JSON.parse(run.stdout) as { acquired: number; overlaps: number; planted: number });
    expect(stats.map((s) => s.overlaps)).toEqual(Array(contenders).fill(0));
    expect(stats.reduce((n, s) => n + s.planted, 0)).toBeGreaterThan(10); // the race was really exercised
    expect(stats.filter((s) => s.acquired > 0).length).toBeGreaterThan(1);
    expect(readdirSync(home).filter((f) => f !== "mc.lock")).toEqual([]); // no guard or temp file leaked
  }, 30_000);
});

function dataUrl(code: string): string {
  return `data:text/javascript,${encodeURIComponent(code)}`;
}

/** A pid that just exited (and so is almost certainly not alive). */
/** Linux /proc, where locks record when their holder started. */
const HAS_PROC = existsSync("/proc/self/stat");

/** What the lock records as process `pid`'s start: boot id and start time in ticks (field 22 of /proc/<pid>/stat). */
function procStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  expect(child.pid).toBeGreaterThan(0);
  return child.pid!;
}

/** Sets a file's mtime this far in the past, as if its holder stopped its heartbeat that long ago. */
function backdate(file: string, ms: number): void {
  const then = new Date(Date.now() - ms);
  utimesSync(file, then, then);
}
