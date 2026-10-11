import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { copyHome, emptyHome, hashTree, makeEvent, makeFeature, makeMission, missingHome, touch, withLock, writeMission } from "../../test/dashboard-helpers.js";
import { buildHome, iso, missionAt } from "../../test/dashboard-kit.js";
import { EVENTS_TAIL_BYTES, MAX_DISPATCH_BYTES, MAX_EVENTS_BYTES, MAX_MISSION_BYTES, MAX_MISSION_FOLDERS, MAX_QUOTA_BYTES, MAX_USAGE_BYTES } from "./constants.js";
import { clearReadCache, homeStatus, jobLogMtime, readDetails, readHome } from "./read.js";

const NOW = Date.parse("2026-10-11T09:58:30.000Z");
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);

beforeEach(() => clearReadCache());

function readAll(home: string) {
  const data = readHome(home);
  readDetails(home, data, data.missions.map((m) => m.folder));
  return data;
}

describe("the home", () => {
  it("a home that does not exist is missing, not an error", () => {
    const data = readHome(missingHome());
    expect(data.home).toBe("missing");
    expect(data.missions).toEqual([]);
    expect(data.lock).toBeNull();
    expect(homeStatus(missingHome())).toBe("missing");
  });

  it("a home that is a file cannot be read", () => {
    const home = emptyHome();
    const file = join(home, "a-file");
    writeFileSync(file, "x");
    expect(readHome(file).home).toBe("unreadable");
    expect(homeStatus(file)).toBe("unreadable");
  });

  it("a missions folder that is a file makes the home unreadable", () => {
    const home = emptyHome();
    rmSync(join(home, "missions"), { recursive: true });
    writeFileSync(join(home, "missions"), "x");
    expect(readHome(home).home).toBe("unreadable");
  });

  it("an empty home, and a home with no missions folder, are fine", () => {
    const home = emptyHome();
    expect(readHome(home).home).toBe("ok");
    expect(homeStatus(home)).toBe("readable");
    rmSync(join(home, "missions"), { recursive: true });
    const data = readHome(home);
    expect(data.home).toBe("ok");
    expect(data.missions).toEqual([]);
  });

  it("reads the five missions, the ledger and the quota file of the multi-mission home", () => {
    const data = readHome(copyHome("multi-mission"));
    expect(data.home).toBe("ok");
    expect(data.missions.map((m) => m.folder)).toEqual([
      "2026-10-11-habit-tracker",
      "2026-10-11-members-site",
      "2026-10-11-reader",
      "2026-10-11-recipe-box",
      "2026-10-11-task-board",
    ]);
    expect(data.missions.every((m) => m.readable && m.mission !== null)).toBe(true);
    expect(data.usage?.length).toBeGreaterThan(50);
    expect(data.usage?.[0]).toEqual({ missionId: expect.any(String), durationMs: expect.any(Number) });
    expect(data.quota?.limits).toEqual([{ provider: "codex", kind: "session", until: 1791723505596 }]);
    expect(data.quotaMtimeMs).not.toBeNull();
  });

  it("ignores folders that start with a dot and files in missions/", () => {
    const home = emptyHome();
    writeMission(home, makeMission({ id: "2026-10-11-a" }));
    mkdirSync(join(home, "missions", ".hidden"));
    writeFileSync(join(home, "missions", ".hidden", "mission.json"), "{}");
    writeFileSync(join(home, "missions", "stray.txt"), "x");
    expect(readHome(home).missions.map((m) => m.folder)).toEqual(["2026-10-11-a"]);
  });

  it("scans at most MAX_MISSION_FOLDERS folders, the newest first, and says how many it skipped", () => {
    const home = emptyHome();
    const total = MAX_MISSION_FOLDERS + 20;
    for (let i = 0; i < total; i++) {
      const id = `2026-10-11-m${String(i).padStart(4, "0")}`;
      writeMission(home, makeMission({ id }));
      touch(join(home, "missions", id), Date.parse("2026-01-01T00:00:00.000Z") + i * 1000);
    }
    const data = readHome(home);
    expect(data.missions).toHaveLength(MAX_MISSION_FOLDERS);
    expect(data.skippedFolders).toBe(20);
    expect(data.missions.some((m) => m.folder === "2026-10-11-m0000")).toBe(false);
    expect(data.missions.some((m) => m.folder === `2026-10-11-m${String(total - 1).padStart(4, "0")}`)).toBe(true);
  });
});

describe("a mission file", () => {
  it("a folder with no mission.json is not a mission", () => {
    const home = emptyHome();
    mkdirSync(join(home, "missions", "2026-10-11-half-created"));
    writeFileSync(join(home, "missions", "2026-10-11-half-created", "events.jsonl"), "");
    expect(readHome(home).missions).toEqual([]);
  });

  it.each([
    ["is not valid JSON", '{"id": "2026-10-11-x", '],
    ["is not an object", "[1, 2, 3]"],
    ["is empty", ""],
  ])("a mission.json that %s is an unreadable mission", (_name, text) => {
    const home = emptyHome();
    mkdirSync(join(home, "missions", "2026-10-11-x"));
    writeFileSync(join(home, "missions", "2026-10-11-x", "mission.json"), text);
    const [entry] = readHome(home).missions;
    expect(entry).toMatchObject({ folder: "2026-10-11-x", readable: false, mission: null });
  });

  it("a mission whose id is not its folder, or that lacks a required field, is unreadable", () => {
    const home = emptyHome();
    writeMission(home, makeMission({ id: "2026-10-11-a" }));
    writeFileSync(join(home, "missions", "2026-10-11-a", "mission.json"), JSON.stringify(makeMission({ id: "2026-10-11-other" })));
    const noStatus: Record<string, unknown> = { ...makeMission({ id: "2026-10-11-b" }) };
    delete noStatus.status;
    mkdirSync(join(home, "missions", "2026-10-11-b"));
    writeFileSync(join(home, "missions", "2026-10-11-b", "mission.json"), JSON.stringify(noStatus));
    expect(readHome(home).missions.map((m) => m.readable)).toEqual([false, false]);
  });

  it("a mission.json over the cap is unreadable", () => {
    const home = emptyHome();
    writeMission(home, makeMission({ id: "2026-10-11-big" }));
    writeFileSync(join(home, "missions", "2026-10-11-big", "mission.json"), JSON.stringify(makeMission({ id: "2026-10-11-big", request: "x".repeat(MAX_MISSION_BYTES) })));
    expect(readHome(home).missions[0]?.readable).toBe(false);
  });

  it.each([
    ["a feature that is not an object", { features: [42] }],
    ["a feature without a title", { features: [{ id: "a", status: "pending" }] }],
    ["a feature without a status", { features: [{ id: "a", title: "A" }] }],
    ["a feature with a number as its id", { features: [{ id: 7, title: "A", status: "pending" }] }],
    ["a kind this page does not know", { kind: "hologram" }],
  ])("the deep checks refuse %s", (_name, patch) => {
    const home = emptyHome();
    writeMission(home, { ...makeMission({ id: "2026-10-11-a" }), ...patch } as never);
    expect(readHome(home).missions[0]?.readable).toBe(false);
  });

  it("keeps an unknown status or stage as it is: the views turn it into 'Needs a look'", () => {
    const home = emptyHome();
    writeMission(home, makeMission({ id: "2026-10-11-a", status: "hibernating" as never, stage: "dreaming" as never, features: [makeFeature({ id: "f", status: "daydreaming" as never })] }));
    const mission = readHome(home).missions[0]?.mission;
    expect(mission).toMatchObject({ status: "hibernating", stage: "dreaming" });
    expect(mission?.features[0]?.status).toBe("daydreaming");
  });

  it("cleans and caps every string and blanks what the dashboard never shows", () => {
    const home = emptyHome();
    const bad = `<b>${ch(0x202e)}evil${ch(0x200b)}${ch(0x07)}</b>`;
    writeMission(
      home,
      makeMission({
        id: "2026-10-11-a",
        title: `${bad} ${"t".repeat(500)}`,
        request: "secret request",
        repoPath: "/home/someone/app",
        integrationWorktree: "/home/someone/wt",
        notes: [`note ${bad}`, "x".repeat(900)],
        decisionsNeeded: [bad, "d".repeat(2000), 7 as never, null as never],
        features: [makeFeature({ id: "f", title: bad, story: bad, blockedReason: `${bad} ${"r".repeat(900)}`, status: "blocked" })],
      }),
    );
    const mission = readHome(home).missions[0]?.mission;
    expect(mission).not.toBeNull();
    expect(mission?.title).toBe(`<b>evil</b> ${"t".repeat(120 - "<b>evil</b> ".length - 1)}…`);
    expect(mission?.request).toBe("");
    expect(mission?.repoPath).toBe("");
    expect(mission?.integrationWorktree).toBeUndefined();
    expect(mission?.decisionsNeeded).toHaveLength(2);
    expect(mission?.decisionsNeeded[0]).toBe("<b>evil</b>");
    expect(Array.from(mission?.decisionsNeeded[1] ?? "")).toHaveLength(600);
    expect(mission?.notes.map((n) => Array.from(n).length)).toEqual([`note <b>evil</b>`.length, 300]);
    expect(mission?.features[0]?.title).toBe("<b>evil</b>");
    expect(Array.from(mission?.features[0]?.blockedReason ?? "")).toHaveLength(400);
  });

  it("falls back to the folder name for an empty title and to createdAt for a bad updatedAt", () => {
    const home = emptyHome();
    writeMission(home, makeMission({ id: "2026-10-11-a", title: `${ch(0x200b)} `, createdAt: "2026-10-11T08:00:00.000Z", updatedAt: "not a time" }));
    const mission = readHome(home).missions[0]?.mission;
    expect(mission?.title).toBe("2026-10-11-a");
    expect(mission?.updatedAt).toBe("2026-10-11T08:00:00.000Z");
  });

  it("counts an attempts or frozenTests list that is not a list as empty, and keeps only known attempts", () => {
    const home = emptyHome();
    writeMission(home, makeMission({
      id: "2026-10-11-a",
      features: [
        makeFeature({ id: "a", attempts: "oops" as never, frozenTests: 5 as never }),
        makeFeature({
          id: "b",
          attempts: [
            { rung: 0, action: "build", outcome: "fail", provider: "codex", model: "m", effort: "low", summary: "s", at: "x" },
            { rung: 1, action: "teleport", outcome: "pass" } as never,
          ],
          frozenTests: [{ path: "tests/a.mjs", sha256: "abc" }, { path: "tests/b.mjs", sha256: "def" }],
        }),
      ],
    }));
    const [a, b] = readHome(home).missions[0]?.mission?.features ?? [];
    expect(a?.attempts).toEqual([]);
    expect(a?.frozenTests).toEqual([]);
    expect(b?.attempts.map((x) => `${x.action}:${x.outcome}`)).toEqual(["build:fail"]);
    expect(b?.attempts[0]?.model).toBe("");
    expect(b?.frozenTests).toHaveLength(2);
    expect(b?.frozenTests[0]?.path).toBe("");
  });

  it("keeps a well-formed failure and ignores a malformed one", () => {
    const home = emptyHome();
    writeMission(home, makeMission({ id: "2026-10-11-a", status: "failed", failure: { reason: "No model could run.", decision: "Log in.", retryable: true } }));
    writeMission(home, makeMission({ id: "2026-10-11-b", status: "failed", failure: { reason: 5, retryable: "yes" } as never }));
    const [a, b] = readHome(home).missions;
    expect(a?.mission?.failure).toEqual({ reason: "No model could run.", decision: "Log in.", retryable: true });
    expect(b?.mission?.failure).toBeUndefined();
  });
});

describe("the run lock", () => {
  it("is null without a file", () => {
    expect(readHome(emptyHome()).lock).toBeNull();
  });

  it("reads the start time and the file's modification time", () => {
    const home = emptyHome();
    withLock(home, { at: "2026-10-11T09:50:00.000Z", ageMs: 15_000, now: NOW });
    expect(readHome(home).lock).toEqual({ valid: true, at: Date.parse("2026-10-11T09:50:00.000Z"), mtimeMs: NOW - 15_000 });
  });

  it.each([
    ["not JSON", "not json"],
    ["a list", "[1]"],
    ["no pid", JSON.stringify({ at: "2026-10-11T09:50:00.000Z" })],
    ["pid 0", JSON.stringify({ pid: 0, at: "2026-10-11T09:50:00.000Z" })],
    ["a negative pid", JSON.stringify({ pid: -4, at: "2026-10-11T09:50:00.000Z" })],
    ["a fractional pid", JSON.stringify({ pid: 4.5, at: "2026-10-11T09:50:00.000Z" })],
    ["a pid as text", JSON.stringify({ pid: "4242", at: "2026-10-11T09:50:00.000Z" })],
  ])("a file that is %s is not a lock", (_name, text) => {
    const home = emptyHome();
    writeFileSync(join(home, "mc.lock"), text);
    expect(readHome(home).lock).toMatchObject({ valid: false, at: null });
  });

  it("is a lock whose start time is unknown when `at` is not a time", () => {
    const home = emptyHome();
    writeFileSync(join(home, "mc.lock"), JSON.stringify({ pid: 4242, at: "yesterday", host: "x" }));
    expect(readHome(home).lock).toMatchObject({ valid: true, at: null });
  });

  it("sees the STOP file", () => {
    const home = emptyHome();
    expect(readHome(home).stopRequested).toBe(false);
    writeFileSync(join(home, "STOP"), "");
    expect(readHome(home).stopRequested).toBe(true);
  });
});

describe("quota.json", () => {
  it("keeps the valid entries, skips the bad ones, and never keeps the provider's own text", () => {
    const home = buildHome(
      {
        quota: {
          version: 1,
          limits: { codex: { kind: "session", raw: "mock session limit with secret words", until: 1000 }, bad: { kind: 5, until: 1 }, worse: "no" },
          modelBlocks: [{ provider: "claude", model: "claude-opus-5-5", raw: "raw", until: 2000 }, { provider: "claude" }, 7],
          utilization: [
            { provider: "claude", window: "five_hour", utilization: 0.62, resetsAt: 3000 },
            { provider: "claude", window: "seven_day", utilization: "high", resetsAt: 4000 },
            { provider: "claude", window: "seven_day", utilization: 0.4 },
          ],
        },
      },
      NOW,
    );
    const { quota } = readHome(home);
    expect(quota).toEqual({
      limits: [{ provider: "codex", kind: "session", until: 1000 }],
      modelBlocks: [{ provider: "claude", model: "claude-opus-5-5", until: 2000 }],
      utilization: [{ provider: "claude", window: "five_hour", utilization: 0.62, resetsAt: 3000 }],
    });
    expect(JSON.stringify(quota)).not.toContain("raw");
    expect(JSON.stringify(quota)).not.toContain("secret");
  });

  it.each([
    ["is cut off", '{"version":1,"limits":{"claude":{"kind":"sess'],
    ["is a list", "[]"],
    ["is a number", "5"],
  ])("a file that %s counts as absent, with no modification time", (_name, text) => {
    const home = buildHome({ quota: text }, NOW);
    expect(readHome(home)).toMatchObject({ quota: null, quotaMtimeMs: null });
  });

  it("a file over the cap counts as absent", () => {
    const home = buildHome({ quota: JSON.stringify({ version: 1, limits: {}, pad: "x".repeat(MAX_QUOTA_BYTES) }) }, NOW);
    expect(readHome(home).quota).toBeNull();
  });

  it("an object with no lists is an empty quota, with its modification time", () => {
    const home = buildHome({ quota: {}, quotaMtimeMs: NOW - 5000 }, NOW);
    expect(readHome(home)).toMatchObject({ quota: { limits: [], modelBlocks: [], utilization: [] }, quotaMtimeMs: NOW - 5000 });
  });
});

describe("usage.jsonl", () => {
  it("keeps the mission and the duration of each good line", () => {
    const home = buildHome({ usage: [{ missionId: "a", durationMs: 1500, usage: { inputTokens: 1 }, model: "m" }, { missionId: "b" }, { durationMs: 5 }, { missionId: "c", durationMs: -3 }] }, NOW);
    appendFileSync(join(home, "usage.jsonl"), '{"missionId": "torn", "dura');
    expect(readHome(home).usage).toEqual([{ missionId: "a", durationMs: 1500 }]);
  });

  it("is null when the ledger is missing or over the cap", () => {
    expect(readHome(emptyHome()).usage).toBeNull();
    const home = emptyHome();
    writeFileSync(join(home, "usage.jsonl"), `${"x".repeat(MAX_USAGE_BYTES + 1)}\n`);
    expect(readHome(home).usage).toBeNull();
  });

  it("is an empty list for an empty ledger", () => {
    const home = emptyHome();
    writeFileSync(join(home, "usage.jsonl"), "");
    expect(readHome(home).usage).toEqual([]);
  });
});

describe("events", () => {
  it("are null until readDetails has run, then in file order", () => {
    const home = copyHome("done");
    const data = readHome(home);
    expect(data.missions[0]?.events).toBeNull();
    readDetails(home, data, ["2026-10-11-habit-tracker"]);
    const events = data.missions[0]?.events ?? [];
    expect(events).toHaveLength(101);
    expect(events[0]?.type).toBe("mission.start");
    expect(events.at(-1)?.type).toBe("stage");
  });

  it("are read only for the missions named", () => {
    const home = copyHome("multi-mission");
    const data = readHome(home);
    readDetails(home, data, ["2026-10-11-reader"]);
    expect(data.missions.filter((m) => m.events !== null).map((m) => m.folder)).toEqual(["2026-10-11-reader"]);
  });

  it("skip a torn last line and lines that are not events", () => {
    const home = emptyHome();
    const dir = writeMission(home, makeMission({ id: "2026-10-11-a" }));
    writeFileSync(
      join(dir, "events.jsonl"),
      [
        JSON.stringify(makeEvent("2026-10-11-a", NOW, "mission.start", { stage: "spec" })),
        "not json",
        JSON.stringify({ at: "not a time", type: "x", data: {} }),
        JSON.stringify({ at: iso(NOW), type: 5, data: {} }),
        JSON.stringify({ at: iso(NOW), type: "no.data" }),
        JSON.stringify(makeEvent("2026-10-11-a", NOW + 1000, "stage", { from: "spec", to: "gate_a" })),
        '{"at": "2026-10-11T09:58:31.000Z", "type": "torn',
      ].join("\n"),
    );
    expect(readAll(home).missions[0]?.events?.map((e) => e.type)).toEqual(["mission.start", "stage"]);
  });

  it("are an empty list when the file is missing or empty", () => {
    const home = emptyHome();
    writeMission(home, makeMission({ id: "2026-10-11-a" }));
    writeMission(home, makeMission({ id: "2026-10-11-b" }), { events: [] });
    expect(readAll(home).missions.map((m) => m.events)).toEqual([[], []]);
  });

  it("keep only the keys the translation uses, cleaned, and never a path, a model or a message", () => {
    const home = emptyHome();
    writeMission(home, makeMission({ id: "2026-10-11-a" }), {
      events: [
        makeEvent("2026-10-11-a", NOW, "verify", { label: "gate-c", ok: false, timedOut: true, logFile: "/fixture/log", exitCode: 1, signature: "abc", feature: `f${ch(0x202e)}1` }),
        makeEvent("2026-10-11-a", NOW + 1, "report", { path: "/fixture/report.md" }),
        makeEvent("2026-10-11-a", NOW + 2, "tests.frozen", { feature: "f", files: ["tests/a.mjs", "tests/b.mjs"], commit: "1".repeat(40) }),
        makeEvent("2026-10-11-a", NOW + 3, "error", { feature: "f", message: "boom at /fixture/x" }),
        makeEvent("2026-10-11-a", NOW + 4, "run.start", { label: "build-f", jobId: "build-f-1", role: "engineer", provider: "codex", model: "gpt-6.1-sol", effort: "medium" }),
      ],
    });
    const events = readAll(home).missions[0]?.events ?? [];
    expect(events[0]?.data).toEqual({ label: "gate-c", ok: false, timedOut: true, feature: "f1" });
    expect(events[1]?.data).toEqual({});
    expect(events[2]?.data).toEqual({ feature: "f", files: ["", ""] });
    expect(events[3]?.data).toEqual({ feature: "f" });
    expect(events[4]?.data).toEqual({ label: "build-f", jobId: "build-f-1", role: "engineer" });
    expect(JSON.stringify(events)).not.toMatch(/fixture|gpt-6|boom|1111/);
  });

  it("read only the tail of a file over the cap, from a line boundary", () => {
    const home = emptyHome();
    const dir = writeMission(home, makeMission({ id: "2026-10-11-a" }));
    const line = (i: number): string => JSON.stringify(makeEvent("2026-10-11-a", NOW + i, "feature.status", { feature: `f${i}`, to: "testing", pad: "p".repeat(100) }));
    const lines: string[] = [];
    let size = 0;
    for (let i = 0; size <= MAX_EVENTS_BYTES + 1000; i++) {
      lines.push(line(i));
      size += lines[i]?.length ?? 0 + 1;
    }
    writeFileSync(join(dir, "events.jsonl"), lines.join("\n") + "\n");
    const events = readAll(home).missions[0]?.events ?? [];
    expect(events.length).toBeGreaterThan(1000);
    expect(events.length).toBeLessThan(lines.length);
    const first = Number((events[0]?.data.feature as string).slice(1));
    expect(first).toBeGreaterThan(0);
    // The first line kept is a whole one, the last one is the file's last, and nothing is skipped in between.
    expect(events.at(-1)?.data.feature).toBe(`f${lines.length - 1}`);
    expect(events.map((e) => (e.data.feature as string).slice(1)).map(Number)).toEqual(Array.from({ length: events.length }, (_, i) => first + i));
    expect(events.length * (lines[0]?.length ?? 0)).toBeLessThan(EVENTS_TAIL_BYTES * 1.1);
  });
});

describe("dispatch.json", () => {
  const FINAL = { ok: true, head: "abc", reviewed: true, blocking: 0 };

  function picks(dispatch: unknown) {
    const home = emptyHome();
    writeMission(home, makeMission({ id: "2026-10-11-a" }), { dispatch: typeof dispatch === "string" ? undefined : dispatch });
    if (typeof dispatch === "string") writeFileSync(join(home, "missions", "2026-10-11-a", "dispatch.json"), dispatch);
    const data = readAll(home);
    return data.missions[0]?.dispatch;
  }

  it("keeps finalVerify and inflight and nothing else", () => {
    const result = picks({ units: { f: { lastFailure: { outputTail: "/fixture/x" } } }, gitSettings: { config: "ghp_FAKE0123456789SENTINEL" }, finalVerify: FINAL, interruptions: 3, inflight: { label: "build-f", feature: "f", optional: true, at: "2026-10-11T09:58:00.000Z" } });
    expect(result).toEqual({ finalVerify: { ok: true, reviewed: true, blocking: 0 }, inflight: { label: "build-f", feature: "f", at: Date.parse("2026-10-11T09:58:00.000Z") } });
    expect(JSON.stringify(result)).not.toMatch(/ghp_|fixture|abc/);
  });

  it("reads the real dispatch.json with a secret in it without keeping the secret", () => {
    const home = copyHome("dispatch-with-secret");
    const data = readAll(home);
    expect(data.missions[0]?.dispatch).toEqual({ finalVerify: { ok: true, reviewed: true, blocking: 0 }, inflight: null });
    expect(JSON.stringify(data)).not.toContain("ghp_FAKE0123456789SENTINEL");
  });

  it("treats a missing `reviewed` and `blocking` as unknown, and no finalVerify as none", () => {
    expect(picks({ finalVerify: { ok: false, head: "x" } })).toEqual({ finalVerify: { ok: false, reviewed: null, blocking: null }, inflight: null });
    expect(picks({ units: {} })).toEqual({ finalVerify: null, inflight: null });
    expect(picks({ finalVerify: { ok: "yes" }, inflight: { label: 7 } })).toEqual({ finalVerify: null, inflight: null });
  });

  it("is unavailable when missing, unparseable, not an object, or over the cap", () => {
    expect(picks(undefined)).toBe("unavailable");
    expect(picks("{ not json")).toBe("unavailable");
    expect(picks("[1]")).toBe("unavailable");
    expect(picks(JSON.stringify({ finalVerify: FINAL, pad: "x".repeat(MAX_DISPATCH_BYTES) }))).toBe("unavailable");
  });

  it("records the file's modification time only when it was usable", () => {
    const home = copyHome("done");
    touch(join(home, "missions", "2026-10-11-habit-tracker", "dispatch.json"), NOW - 7000);
    expect(readAll(home).missions[0]?.dispatchMtimeMs).toBe(NOW - 7000);
    const bare = emptyHome();
    writeMission(bare, makeMission({ id: "2026-10-11-a" }));
    expect(readAll(bare).missions[0]?.dispatchMtimeMs).toBeNull();
  });
});

describe("jobLogMtime", () => {
  it("is the modification time of logs/<jobId>.ndjson, or null", () => {
    const home = emptyHome();
    const dir = writeMission(home, makeMission({ id: "2026-10-11-a" }));
    mkdirSync(join(dir, "logs"));
    writeFileSync(join(dir, "logs", "build-f-1.ndjson"), "{}\n");
    touch(join(dir, "logs", "build-f-1.ndjson"), NOW - 3000);
    expect(jobLogMtime(home, "2026-10-11-a", "build-f-1")).toBe(NOW - 3000);
    expect(jobLogMtime(home, "2026-10-11-a", "build-f-2")).toBeNull();
    expect(jobLogMtime(home, "2026-10-11-nope", "build-f-1")).toBeNull();
  });

  it("never creates a logs folder and refuses an id that could leave it", () => {
    const home = emptyHome();
    const dir = writeMission(home, makeMission({ id: "2026-10-11-a" }));
    const before = hashTree(home);
    expect(jobLogMtime(home, "2026-10-11-a", "build-f-1")).toBeNull();
    expect(jobLogMtime(home, "2026-10-11-a", "../mission")).toBeNull();
    expect(jobLogMtime(home, "..", "x")).toBeNull();
    expect(jobLogMtime(home, "2026-10-11-a", "..")).toBeNull();
    expect(hashTree(home)).toBe(before);
    expect(readFileSync(join(dir, "mission.json"), "utf8")).toContain("2026-10-11-a");
  });
});

describe("the cache", () => {
  it("returns the same parsed mission while the file is unchanged", () => {
    const home = copyHome("done");
    const first = readHome(home).missions[0]?.mission;
    const second = readHome(home).missions[0]?.mission;
    expect(second).toBe(first);
  });

  it("reads again when the file changes size or is replaced", () => {
    const home = emptyHome();
    writeMission(home, makeMission({ id: "2026-10-11-a", title: "First" }));
    expect(readHome(home).missions[0]?.mission?.title).toBe("First");
    writeMission(home, makeMission({ id: "2026-10-11-a", title: "A much longer second title" }));
    expect(readHome(home).missions[0]?.mission?.title).toBe("A much longer second title");
  });

  it("forgets everything on clearReadCache", () => {
    const home = copyHome("done");
    const first = readHome(home).missions[0]?.mission;
    clearReadCache();
    expect(readHome(home).missions[0]?.mission).not.toBe(first);
    expect(readHome(home).missions[0]?.mission).toEqual(first);
  });
});

describe("reading never changes the home", () => {
  it("leaves every file, size and modification time as it was", () => {
    const home = copyHome("multi-mission");
    withLock(home, { at: "2026-10-11T09:50:00.000Z", ageMs: 1000, now: NOW });
    writeFileSync(join(home, "STOP"), "");
    const before = hashTree(home);
    const data = readAll(home);
    jobLogMtime(home, data.missions[0]?.folder ?? "", "spec-1");
    expect(hashTree(home)).toBe(before);
  });
});

describe("a mission made in code reads as written", () => {
  it("round-trips the fields the views use", () => {
    const home = buildHome({ missions: [{ mission: missionAt(NOW, "2026-10-11-a", { status: "partial", stage: "complete", gateCRounds: 2, baselineBroken: true, decisionsNeeded: ["Q?"], notes: ["n"] }) }] }, NOW);
    expect(readHome(home).missions[0]?.mission).toMatchObject({ status: "partial", stage: "complete", gateCRounds: 2, baselineBroken: true, decisionsNeeded: ["Q?"], notes: ["n"] });
  });
});
