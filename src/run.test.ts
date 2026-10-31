import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { type MockBehavior, MockRunner, type MockScript } from "./runners/mock.js";
import { missionOutcome, parseUntil, rebaseLinks, runNight } from "./run.js";
import { MissionStore } from "./state.js";
import type { AgentJob, Config, Mission, MissionStatus, RoleOverride } from "./types.js";
import { FakeClock } from "./util/clock.js";
import { nullLogger } from "./util/logger.js";
import { controllerGitEnv } from "./util/launch-env.js";
import { runProcess } from "./util/process.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NTFY = "https://ntfy.example/night-topic";

let root: string;
let home: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-run-"));
  home = join(root, "home");
  vi.stubEnv("MC_HOME", home);
  fetchMock = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function testConfig(): Config {
  const c = defaultConfig();
  c.home = home;
  c.workspaceRoot = join(root, "apps");
  c.notify.ntfyUrl = NTFY;
  return c;
}

function store(): MissionStore {
  return new MissionStore(home);
}

let createdAt = Date.now() - HOUR;

function queue(title: string, fields: Partial<Pick<Mission, "status" | "stage" | "profile">> = {}): Mission {
  const s = store();
  const m = s.createMission({ kind: "greenfield", title, request: `Build ${title}`, repoPath: "", baseBranch: "main", profile: "mixed", nowMs: (createdAt += 1000) });
  Object.assign(m, fields);
  s.save(m, Date.now());
  return m;
}

function runners(script: MockScript) {
  return { claude: new MockRunner(script, { provider: "claude" }), codex: new MockRunner(script, { provider: "codex" }) };
}

/** Every login has expired: a mission fails fast with a "log in again" decision, and the night ends there. */
const loggedOut = (): MockBehavior => ({ outcome: "auth", error: "Please run /login" });
/** No usable plan, ever: each mission fails fast (two spec runs), for its owner to look at; the next one still runs. */
const noPlan = (): MockBehavior => ({ outcome: "failed", error: "no usable plan" });
/** An agent that never finishes on its own. */
const hung = (): MockBehavior => ({ delayMs: Infinity });

function allCalls(r: ReturnType<typeof runners>): AgentJob[] {
  return [...r.claude.calls, ...r.codex.calls];
}

function notifications(): { title: string; body: string; priority: string }[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const { headers, body } = init as { headers: Record<string, string>; body: string };
    return { title: headers.Title ?? "", body, priority: headers.Priority ?? "" };
  });
}

function statusOf(id: string): MissionStatus {
  return store().load(id).status;
}

describe("parseUntil", () => {
  const at = (h: number, m: number, dayOffset = 0) => {
    const d = new Date(2026, 9, 10 + dayOffset, h, m, 0, 0);
    return d.getTime();
  };

  it("returns the next occurrence of the time, today or tomorrow", () => {
    expect(parseUntil("07:00", at(23, 0))).toBe(at(7, 0, 1));
    expect(parseUntil("23:30", at(22, 0))).toBe(at(23, 30));
    expect(parseUntil("7:05", at(6, 0))).toBe(at(7, 5));
    expect(parseUntil(" 00:00 ", at(23, 59))).toBe(at(0, 0, 1));
  });

  it("is strictly after now", () => {
    expect(parseUntil("07:00", at(7, 0))).toBe(at(7, 0, 1));
  });

  it.each(["7", "07:60", "24:00", "7am", "", "07:00:00", "-1:00"])("rejects %j in plain words", (text) => {
    expect(() => parseUntil(text, at(12, 0))).toThrow(/is not a time of day.*HH:MM/);
  });
});

describe("rebaseLinks", () => {
  it("points relative links at the mission folder and leaves the rest alone", () => {
    const md = [
      "![home page](screenshots/home%20page.png)",
      "[docs](https://example.com/a) [top](#top) [abs](/tmp/x.png) [mail](mailto:a@b.c)",
    ].join("\n");
    expect(rebaseLinks(md, "../missions/m1")).toBe(
      ["![home page](../missions/m1/screenshots/home%20page.png)", "[docs](https://example.com/a) [top](#top) [abs](/tmp/x.png) [mail](mailto:a@b.c)"].join("\n"),
    );
  });
});

describe("runNight", () => {
  it("writes a summary and notifies even when nothing is queued", async () => {
    const r = runners(loggedOut);
    const result = await runNight({ config: testConfig(), logger: nullLogger, runners: r });
    expect(result.missions).toEqual([]);
    expect(result.summaryPath).toMatch(/reports\/run-\d{4}-\d{2}-\d{2}\.md$/);
    expect(readFileSync(result.summaryPath, "utf8")).toContain("Nothing was queued");
    expect(allCalls(r)).toHaveLength(0);
    expect(notifications()).toEqual([expect.objectContaining({ title: "Run finished", priority: "3" })]);
  });

  it("names the summary and the log of a run run-<date>, a second summary of the same day with -2, and leaves night-<date> files of earlier runs alone", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true); // the run's own log lines
    const clock = new FakeClock(new Date(2026, 9, 10, 12, 0).getTime());
    mkdirSync(join(home, "reports"), { recursive: true });
    mkdirSync(join(home, "logs"), { recursive: true });
    writeFileSync(join(home, "reports", "night-2026-10-10.md"), "an earlier run\n");
    writeFileSync(join(home, "logs", "night-2026-10-10.log"), "an earlier log\n");
    const first = await runNight({ config: testConfig(), clock, runners: runners(loggedOut) });
    const second = await runNight({ config: testConfig(), clock, runners: runners(loggedOut) });
    expect(first.summaryPath).toBe(join(home, "reports", "run-2026-10-10.md"));
    expect(second.summaryPath).toBe(join(home, "reports", "run-2026-10-10-2.md"));
    expect(readFileSync(join(home, "logs", "run-2026-10-10.log"), "utf8")).toContain("Run finished. Summary:");
    expect(existsSync(join(home, "logs", "night-2026-10-10.log"))).toBe(true);
    expect(readFileSync(join(home, "reports", "night-2026-10-10.md"), "utf8")).toBe("an earlier run\n");
  });

  it("puts curly quote marks around a mission's title in the log", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const clock = new FakeClock(new Date(2026, 9, 10, 12, 0).getTime());
    const m = queue("Habit tracker");
    await runNight({ config: testConfig(), clock, runners: runners(loggedOut) });
    const log = readFileSync(join(home, "logs", "run-2026-10-10.log"), "utf8");
    expect(log).toContain(`Working on “Habit tracker” (${m.id})`);
    expect(log).toContain("“Habit tracker”: Stopped, needs your help, no features planned yet");
    expect(log).not.toMatch(/Working on "|"Habit tracker":/);
  });

  it("says one feature, not 1 features, in the summary and in the phone notice", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const m = queue("One feature app", { status: "stopped", stage: "features" });
    const waiting = store().load(m.id);
    waiting.features = [{ id: "only", title: "Only", story: "s", acceptance: ["a"], kind: "standard", deps: [], status: "pending", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] }];
    store().save(waiting);
    const result = await runNight({ config: testConfig(), runners: runners(loggedOut) });
    expect(readFileSync(result.summaryPath, "utf8")).toMatch(/- \*\*One feature app\*\*: [A-Za-z, ]+, 0 of 1 feature done\. /);
    const finished = notifications().find((n) => n.title === "Run finished");
    expect(finished?.body).toMatch(/One feature app: [A-Za-z, ]+, 0 of 1 feature done/);
    expect(finished?.body).not.toContain("1 features");
    expect(missionOutcome({ ...waiting, status: "done", features: [{ ...waiting.features[0]!, status: "done" }] })).toBe("Done, 1 of 1 feature done");
    expect(missionOutcome({ ...waiting, features: [waiting.features[0]!, { ...waiting.features[0]!, id: "second" }] })).toMatch(/, 0 of 2 features done$/);
  });

  it("works through resumable missions in creation order and leaves finished ones alone", async () => {
    const first = queue("First app");
    const stopped = queue("Stopped app", { status: "stopped" });
    const done = queue("Done app", { status: "done", stage: "complete" });
    const failed = queue("Failed app", { status: "failed" });
    const running = queue("Crashed run app", { status: "running" });
    const waiting = queue("Waiting app", { status: "waiting" });
    const partial = queue("Partial app", { status: "partial", stage: "complete" });

    const result = await runNight({ config: testConfig(), logger: nullLogger, runners: runners(noPlan) });

    expect(result.missions.map((m) => m.id)).toEqual([first.id, stopped.id, running.id, waiting.id]);
    for (const m of result.missions) expect(m.status).toBe("failed"); // no usable plan
    expect(statusOf(done.id)).toBe("done");
    expect(statusOf(failed.id)).toBe("failed");
    expect(statusOf(partial.id)).toBe("partial");
    expect(store().readEvents(failed.id).some((e) => e.type === "mission.resume")).toBe(false);
  });

  it("finishes a mission cut off while it was being finalized, so it still gets its report and notification", async () => {
    const partial = queue("Partial app", { status: "partial", stage: "finalize" }); // e.g. power lost after settling
    const done = queue("Done app", { status: "done", stage: "finalize" });

    const result = await runNight({ config: testConfig(), logger: nullLogger, runners: runners(loggedOut) });

    expect(result.missions.map((m) => m.id)).toEqual([partial.id, done.id]);
    for (const m of [partial, done]) {
      expect(store().load(m.id).stage).toBe("complete");
      expect(existsSync(join(home, "missions", m.id, "report.md"))).toBe(true);
      expect(store().readEvents(m.id).some((e) => e.type === "mission.end")).toBe(true);
    }
    expect(notifications().filter((n) => n.title.startsWith("Partial app:"))).toHaveLength(1);
  });

  it("links every mission report relatively in the summary, lists decisions, and copies the last report to latest.md", async () => {
    const a = queue("Habit tracker");
    const b = queue("Notes app");
    const result = await runNight({ config: testConfig(), logger: nullLogger, runners: runners(noPlan) });

    const summary = readFileSync(result.summaryPath, "utf8");
    expect(summary).toContain(`[Read the report](../missions/${a.id}/report.md), or run \`mc report ${a.id}\``);
    expect(summary).toContain(`[Read the report](../missions/${b.id}/report.md), or run \`mc report ${b.id}\``);
    expect(summary).toContain("**Habit tracker**: Stopped, needs your help, no features planned yet.");
    expect(summary).toContain("## Needs your decision");
    expect(summary).toContain("Every queued mission was worked on.");
    // Failed missions wait for their owner, who is told how to continue them.
    expect(summary).toContain("## Waiting for you");
    expect(summary).toContain(`\`mc run --mission ${a.id}\``);
    expect(result.waitingForYou.map((m) => m.id)).toEqual([a.id, b.id]);
    for (const m of [a, b]) expect(existsSync(join(home, "missions", m.id, "report.md"))).toBe(true);

    expect(readFileSync(join(home, "reports", "latest.md"), "utf8")).toContain("# Notes app");
  });

  it("points the relative links of latest.md back into the mission folder", async () => {
    const m = queue("Habit tracker");
    vi.spyOn(Dispatcher.prototype, "runMission").mockImplementation(async (id: string) => {
      writeFileSync(store().reportPath(id), "# Habit tracker\n\n![home page](screenshots/home.png)\n[more](https://example.com/a)\n");
      return store().load(id);
    });
    await runNight({ config: testConfig(), logger: nullLogger, runners: runners(loggedOut) });
    const latest = readFileSync(join(home, "reports", "latest.md"), "utf8");
    expect(latest).toContain(`![home page](../missions/${m.id}/screenshots/home.png)`);
    expect(latest).toContain("[more](https://example.com/a)");
  });

  it("notifies the night's result, with high priority when a mission failed", async () => {
    queue("Habit tracker");
    await runNight({ config: testConfig(), logger: nullLogger, runners: runners(loggedOut) });
    const night = notifications().find((n) => n.title === "Run finished");
    expect(night?.priority).toBe("4");
    expect(night?.body).toContain("Habit tracker: Stopped, needs your help");
    expect(night?.body).toContain("mc report");
  });

  it("names a second summary of the same day differently", async () => {
    const first = await runNight({ config: testConfig(), logger: nullLogger, runners: runners(loggedOut) });
    const second = await runNight({ config: testConfig(), logger: nullLogger, runners: runners(loggedOut) });
    expect(second.summaryPath).toBe(first.summaryPath.replace(/\.md$/, "-2.md"));
  });

  it("runs only the given mission, whatever its status", async () => {
    queue("Other app");
    const target = queue("Retry me", { status: "failed" });
    const result = await runNight({ config: testConfig(), logger: nullLogger, runners: runners(loggedOut), missionId: target.id });
    expect(result.missions.map((m) => m.id)).toEqual([target.id]);
    expect(store().readEvents(target.id).some((e) => e.type === "mission.resume")).toBe(true);
  });

  it("refuses an unknown mission or profile in plain words, without taking the lock", async () => {
    await expect(runNight({ config: testConfig(), logger: nullLogger, missionId: "nope" })).rejects.toThrow('There is no mission called "nope"');
    await expect(runNight({ config: testConfig(), logger: nullLogger, profile: "fast" })).rejects.toThrow(
      'There is no profile called "fast". Choose one of: claude, codex, mixed.',
    );
    await expect(runNight({ config: testConfig(), logger: nullLogger, until: "7am" })).rejects.toThrow("is not a time of day");
    store().acquireLock()(); // free
  });

  it("tells a broken mission file apart from a missing mission", async () => {
    const m = queue("Habit tracker");
    const file = join(home, "missions", m.id, "mission.json");
    const { notes: _, ...withoutNotes } = store().load(m.id);
    writeFileSync(file, JSON.stringify(withoutNotes)); // e.g. edited by hand
    await expect(runNight({ config: testConfig(), logger: nullLogger, missionId: m.id })).rejects.toThrow(
      `Mission ${m.id} exists, but its file can't be read: ${file} is not a valid mission file (bad or missing notes)`,
    );
    await expect(runNight({ config: testConfig(), logger: nullLogger, missionId: "../x" })).rejects.toThrow('There is no mission called "../x"');
  });

  it("refuses to start while another run holds the lock", async () => {
    const release = store().acquireLock();
    try {
      await expect(runNight({ config: testConfig(), logger: nullLogger, runners: runners(loggedOut) })).rejects.toThrow(/another mc run is active/);
    } finally {
      release();
    }
  });

  it("uses tonight's profile and role overrides on top of each mission's own, without ever saving them", async () => {
    const own: RoleOverride[] = [{ role: "architect", tier: "standard" }];
    const m = queue("Habit tracker", { profile: "codex" });
    store().save({ ...store().load(m.id), roleOverrides: own });
    const r = runners(hung);
    const night = runNight({ config: testConfig(), logger: nullLogger, runners: r, profile: "claude", roleOverrides: [{ role: "architect", effort: "max" }] });
    await vi.waitFor(() => expect(allCalls(r)).toHaveLength(1));

    // Tonight's profile picks Claude, the mission's own override keeps the standard tier, tonight's adds the effort.
    expect(r.claude.calls[0]).toMatchObject({ role: "architect", model: "claude-sonnet-5-5", effort: "max" });
    // Even mid-run (a run killed now), the file holds the mission's own choices.
    expect(store().load(m.id)).toMatchObject({ status: "running", profile: "codex", roleOverrides: own });

    store().requestStop();
    await night;
    expect(store().load(m.id)).toMatchObject({ status: "stopped", profile: "codex", roleOverrides: own });
  });

  it("clears an old STOP file at the start, then stops on `mc stop`: the agent is aborted and progress is kept", async () => {
    store().requestStop(); // left over from an earlier night
    const m = queue("Habit tracker");
    const next = queue("Notes app");
    const r = runners(hung);
    const night = runNight({ config: testConfig(), logger: nullLogger, runners: r });
    await vi.waitFor(() => expect(allCalls(r)).toHaveLength(1));

    store().requestStop();
    const result = await night;

    expect(result.missions.map((x) => x.id)).toEqual([m.id]); // the next mission waits for the next run
    expect(statusOf(m.id)).toBe("stopped");
    expect(statusOf(next.id)).toBe("queued");
    const summary = readFileSync(result.summaryPath, "utf8");
    expect(summary).toContain("Stopped early because you asked it to.");
    expect(summary).toContain("Paused, continues on the next run");
    expect(summary).toContain("Still waiting in the queue: 1 mission(s).");
    expect(existsSync(join(home, "missions", m.id, "report.md"))).toBe(true);
    expect(readFileSync(join(home, "reports", "latest.md"), "utf8")).toContain("# Habit tracker");
    store().acquireLock()(); // the lock was released
  });

  it("stops at the deadline, aborting the running agent", async () => {
    const clock = new FakeClock(new Date(2026, 9, 10, 23, 0).getTime());
    const m = queue("Habit tracker");
    const r = runners(hung);
    const night = runNight({ config: testConfig(), clock, logger: nullLogger, runners: r, until: "07:00" });
    await vi.waitFor(() => expect(allCalls(r)).toHaveLength(1));

    await clock.advance(8 * HOUR + MIN);
    const result = await night;

    expect(statusOf(m.id)).toBe("stopped");
    expect(readFileSync(result.summaryPath, "utf8")).toContain("Stopped at 07:00 as planned.");
    expect(result.summaryPath).toContain("run-2026-10-10");
  });

  it("refuses a stop time that passed a little while ago, instead of working about 24 hours through the day", async () => {
    const clock = new FakeClock(new Date(2026, 9, 10, 7, 20).getTime()); // Saturday 07:20, a morning test with the usual command
    const m = queue("Habit tracker");
    const r = runners(hung);
    await expect(runNight({ config: testConfig(), clock, logger: nullLogger, runners: r, until: "07:00" })).rejects.toThrow(
      "It's 07:20 now, already past 07:00, so this run would work until 07:00 tomorrow (Sun Oct 11): about 24 hours, " +
        "through your day. Nothing was started. To work now anyway, give a stop time later today, for example: mc run --until 11:00",
    );
    expect(allCalls(r)).toHaveLength(0);
    expect(statusOf(m.id)).toBe("queued");
    expect(notifications()).toEqual([]);
    store().acquireLock()(); // never taken
  });

  it("says when the night will stop as it starts, for a night or an afternoon start", async () => {
    for (const [hour, expected] of [
      [23, "Working until 07:00 tomorrow (Sun Oct 11)."],
      [13, "Working until 07:00 tomorrow (Sun Oct 11)."], // 18 hours: still allowed
      [5, "Working until 07:00 today."],
    ] as const) {
      const lines: string[] = [];
      const logger = { info: (msg: string) => void lines.push(msg), warn: () => {}, error: () => {} };
      const clock = new FakeClock(new Date(2026, 9, 10, hour, 0).getTime());
      await runNight({ config: testConfig(), clock, logger, runners: runners(loggedOut), until: "07:00" });
      expect(lines[0], `start at ${hour}:00`).toBe(expected);
    }
    const lines: string[] = [];
    await runNight({ config: testConfig(), logger: { info: (msg: string) => void lines.push(msg), warn: () => {}, error: () => {} }, runners: runners(loggedOut) });
    expect(lines[0]).toBe("Working until the queue is done (no stop time given).");
  });

  it.each([
    ["Ctrl+C", "SIGINT", 130],
    ["docker stop", "SIGTERM", 143],
    ["a closed terminal", "SIGHUP", 129],
  ] as const)("stops gracefully on %s (%s), quits with code %i on the second, releasing the lock first", async (_, signal, code) => {
    const before = new Set(process.listeners(signal));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const m = queue("Habit tracker");
    const r = runners(hung);
    const night = runNight({ config: testConfig(), logger: nullLogger, runners: r });
    await vi.waitFor(() => expect(allCalls(r)).toHaveLength(1));
    const handler = process.listeners(signal).find((l) => !before.has(l));
    expect(handler).toBeDefined();

    handler?.(signal);
    expect(exit).not.toHaveBeenCalled();
    handler?.(signal);
    expect(exit).toHaveBeenCalledWith(code);
    store().acquireLock()(); // released before quitting

    const result = await night;
    expect(statusOf(m.id)).toBe("stopped");
    expect(readFileSync(result.summaryPath, "utf8")).toContain("Stopped early because you asked it to.");
    expect(process.listeners(signal).filter((l) => !before.has(l))).toHaveLength(0);
  });

  it("kills the agents' process groups before quitting on the second signal, even one that ignores SIGTERM", async () => {
    const before = new Set(process.listeners("SIGTERM"));
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    queue("Habit tracker");
    const r = runners(hung);
    const night = runNight({ config: testConfig(), logger: nullLogger, runners: r });
    await vi.waitFor(() => expect(allCalls(r)).toHaveLength(1));
    // Started the way runners start an agent (its own process group), and deaf to SIGTERM.
    const ready = join(root, "ready");
    const script = `process.on("SIGTERM", () => {}); require("fs").writeFileSync(${JSON.stringify(ready)}, ""); setInterval(() => {}, 1000);`;
    const agent = runProcess({ env: controllerGitEnv({ isolatedConfig: true }), command: process.execPath, args: ["-e", script], cwd: root, timeoutMs: 30_000 });
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));

    const handler = process.listeners("SIGTERM").find((l) => !before.has(l));
    handler?.("SIGTERM");
    handler?.("SIGTERM");
    expect(await agent).toMatchObject({ signal: "SIGKILL", timedOut: false });
    await night;
  });

  it("marks a mission waiting while every AI is at its limit, remembers the limits, and tells the phone about long waits", async () => {
    const clock = new FakeClock(Date.now());
    const m = queue("Habit tracker");
    let resetIn = 2 * HOUR;
    const r = runners(() => ({ outcome: "limited", limit: { kind: "session", resetsAt: clock.now() + resetIn } }));
    const night = runNight({ config: testConfig(), clock, logger: nullLogger, runners: r });
    const waits = () => store().readEvents(m.id).filter((e) => e.type === "limit.wait").length;
    const told = () => notifications().filter((n) => n.title === "Waiting for usage limits").length;

    await vi.waitFor(() => expect(statusOf(m.id)).toBe("waiting"));
    expect(waits()).toBe(1);
    await vi.waitFor(() => expect(told()).toBe(1));
    // Saved, so a restart tonight still knows both AIs are at their limit.
    const saved = JSON.parse(readFileSync(join(home, "quota.json"), "utf8")) as { limits: Record<string, unknown> };
    expect(saved.limits).toMatchObject({ claude: { kind: "session" }, codex: { kind: "session" } });

    resetIn = 5 * MIN; // a short wait: not worth a notification
    await clock.advance(2 * HOUR + MIN);
    await vi.waitFor(() => expect(waits()).toBe(2));
    resetIn = 3 * HOUR; // the next long wait is told again
    await clock.advance(10 * MIN);
    await vi.waitFor(() => expect(waits()).toBe(3));
    await vi.waitFor(() => expect(told()).toBe(2));

    store().requestStop();
    await night;
    expect(statusOf(m.id)).toBe("stopped");
  });

  it("picks up a mission queued during the night", async () => {
    queue("First app");
    let late: Mission | undefined;
    const r = runners((_job, call) => {
      if (call === 0 && !late) late = queue("Queued at midnight");
      return noPlan();
    });
    const result = await runNight({ config: testConfig(), logger: nullLogger, runners: r });
    expect(result.missions.map((m) => m.title)).toEqual(["First app", "Queued at midnight"]);
  });

  it("ends the night once every login has expired: the next missions stay queued, and the failed one is retried next run", async () => {
    const first = queue("First app");
    const second = queue("Second app");
    const r = runners(loggedOut);

    const result = await runNight({ config: testConfig(), logger: nullLogger, runners: r });

    expect(result.missions.map((m) => [m.id, m.status])).toEqual([[first.id, "failed"]]);
    expect(statusOf(second.id)).toBe("queued"); // never started: it would only have failed too
    expect(allCalls(r).every((j) => j.cwd !== join(home, "missions", second.id))).toBe(true);
    const summary = readFileSync(result.summaryPath, "utf8");
    expect(summary).toContain("Ended early because every AI needs a new login");
    expect(summary).toContain("Still waiting in the queue: 1 mission(s).");
    expect(summary).not.toContain("## Waiting for you");
    expect(result.waitingForYou).toEqual([]);

    // After the owner logs in, a plain run takes both up again, the failed one first.
    const again = await runNight({ config: testConfig(), logger: nullLogger, runners: runners(noPlan) });
    expect(again.missions.map((m) => m.id)).toEqual([first.id, second.id]);
  });

  it("calls a run a run in everything a person reads: the log lines, the summary heading, the phone notices and the error", async () => {
    const lines: string[] = [];
    const logger = { info: (msg: string) => void lines.push(msg), warn: (msg: string) => void lines.push(msg), error: (msg: string) => void lines.push(msg) };
    queue("First app");
    queue("Second app");
    const result = await runNight({ config: testConfig(), logger, runners: runners(loggedOut) });
    const summary = readFileSync(result.summaryPath, "utf8");

    expect(lines.some((l) => l.startsWith("Ending the run early: every AI needs a new login"))).toBe(true);
    expect(lines).toContain(`Run finished. Summary: ${result.summaryPath}`);
    expect(summary.split("\n")[0]).toMatch(/^# Run summary for \d{4}-\d{2}-\d{2}$/);
    expect(notifications().map((n) => n.title)).toEqual(["First app: failed", "Run finished"]);
    // The words a person reads (the file name of the summary is the one place the older word stays).
    const wording = (text: string): string => text.split(result.summaryPath).join("<path>");
    for (const text of [...lines, summary, ...notifications().map((n) => `${n.title}\n${n.body}`)]) {
      expect(wording(text)).not.toMatch(/night|tonight|overnight|morning/i);
    }

    // A run that stops because of an error says so in the same words, in the log and on the phone.
    rmSync(join(home, "missions"), { recursive: true, force: true });
    writeFileSync(join(home, "missions"), "a file where the missions folder should be");
    fetchMock.mockClear();
    lines.length = 0;
    await expect(runNight({ config: testConfig(), logger, runners: runners(loggedOut) })).rejects.toThrow();
    expect(lines.find((l) => l.startsWith("The run stopped because of an error:"))).toBeDefined();
    expect(notifications().at(-1)).toMatchObject({ title: "Mission Control stopped" });
    expect(notifications().at(-1)?.body).toMatch(/^The run stopped because of an error: /);
  });

  it("tells the phone when the last run died without finishing, and carries on with its missions", async () => {
    const crashed = queue("Crashed app", { status: "running", stage: "spec" });

    const result = await runNight({ config: testConfig(), logger: nullLogger, runners: runners(noPlan) });

    expect(result.missions.map((m) => m.id)).toEqual([crashed.id]);
    const notice = notifications()[0];
    expect(notice).toMatchObject({ title: "Mission Control stopped unexpectedly", priority: "4" });
    expect(notice?.body).toContain("Crashed app");
  });

  it("does not say nothing was queued when a failed mission waits for its owner", async () => {
    const stuck = queue("Stuck app", { status: "failed" });

    const result = await runNight({ config: testConfig(), logger: nullLogger, runners: runners(noPlan) });

    expect(result.missions).toEqual([]);
    expect(result.waitingForYou.map((m) => m.id)).toEqual([stuck.id]);
    const summary = readFileSync(result.summaryPath, "utf8");
    expect(summary).not.toContain("Nothing was queued");
    expect(summary).toContain(`\`mc report ${stuck.id}\``);
    expect(summary).toContain(`\`mc run --mission ${stuck.id}\``);
    expect(notifications()).toEqual([expect.objectContaining({ title: "Run finished", priority: "4" })]);
    expect(notifications()[0]?.body).toContain(`Stuck app: still needs your help (mc report ${stuck.id})`);
  });

  it("records an unexpected dispatcher crash as a failed mission with a report, and goes on with the next", async () => {
    const broken = queue("Broken app");
    const next = queue("Next app");
    const real = Dispatcher.prototype.runMission;
    vi.spyOn(Dispatcher.prototype, "runMission").mockImplementation(async function (this: Dispatcher, id: string) {
      if (id === broken.id) throw new Error("disk on fire");
      return real.call(this, id);
    });

    const result = await runNight({ config: testConfig(), logger: nullLogger, runners: runners(loggedOut) });

    expect(result.missions.map((m) => m.id)).toEqual([broken.id, next.id]);
    const saved = store().load(broken.id);
    expect(saved.status).toBe("failed");
    expect(saved.notes.at(-1)).toContain("disk on fire");
    expect(readFileSync(join(home, "missions", broken.id, "report.md"), "utf8")).toContain("# Broken app");
    expect(notifications().some((n) => n.title === "Broken app: failed" && n.priority === "4")).toBe(true);
  });
});

it("strict unknown allowance pauses each mission once and records the invocation policy without an owner approval", async () => {
  const m = queue("Unknown allowance");
  const config = testConfig(); config.pacing.unknownAllowance = "stop";
  const r = runners(noPlan);
  const result = await runNight({ config, logger: nullLogger, runners: r });
  expect(result.missions).toHaveLength(1);
  expect(result.missions[0]).toMatchObject({ id: m.id, status: "stopped", stage: "spec", agentRuns: 0, allowancePolicy: "stop", pause: { kind: "allowance_unknown" } });
  expect(allCalls(r)).toHaveLength(0);
  expect(result.waitingForCheck).toEqual([]); expect(result.waitingForYou).toEqual([]);
  const summary = readFileSync(result.summaryPath, "utf8");
  expect(summary).toContain("Allowance policy for this run: stop.");
  expect(summary).toContain("Paused: allowance could not be confirmed");
});
