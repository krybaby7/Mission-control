// Outages and broken agent CLIs: runs that end for reasons outside the job (a crash, a hang, a dead connection) are
// retried and, when they keep failing, pause the mission so the next run carries on. They never count as the
// agent's failed attempt: no ladder rung, spec, onboard or init attempt is used up, and no feature is blocked.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import type { MockBehavior } from "../src/runners/mock.js";
import { MockRunner } from "../src/runners/mock.js";
import { runNight } from "../src/run.js";
import { MissionStore } from "../src/state.js";
import type { AgentJob, Config, Mission } from "../src/types.js";
import { FakeClock } from "../src/util/clock.js";
import { nullLogger } from "../src/util/logger.js";
import { type AgentScript, feature, type HarnessOptions, labelOf, MissionHarness, specOutput } from "./fixtures/mission-harness.js";

const MIN = 60_000;
const BROKEN_CLI = "codex exited with code 1 without completing the turn: error: unexpected argument '--permission-prompts' found";

let h: MissionHarness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function harness(opts: HarnessOptions): MissionHarness {
  h = new MissionHarness(opts);
  return h;
}

/** Runs the mission, moving the fake clock on only while the executor sleeps (git and the checks run in real time). */
async function drive(hh: MissionHarness, clock: FakeClock, id: string): Promise<Mission> {
  let done = false;
  const run = hh.run(id).finally(() => (done = true));
  while (!done) {
    if (clock.pendingSleeps() > 0) await clock.advance(MIN);
    else await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return run;
}

/** Every role's runs crash, as when a CLI update broke the command line, while `broken.on`. */
function crashWhile(broken: { on: boolean }, hh: MissionHarness): AgentScript {
  const crashing =
    (role: keyof AgentScript) =>
    (job: AgentJob, call: Parameters<NonNullable<AgentScript[typeof role]>>[1]): MockBehavior | Promise<MockBehavior> =>
      broken.on ? { outcome: "crashed", error: BROKEN_CLI } : hh.defaults[role](job, call);
  return {
    architect: crashing("architect"),
    reviewer: crashing("reviewer"),
    test_author: crashing("test_author"),
    engineer: crashing("engineer"),
    scout: crashing("scout"),
  };
}

describe("a broken agent CLI", () => {
  it("pauses the mission with the real error, instead of failing it and asking to rephrase the request", async () => {
    const clock = new FakeClock(Date.now());
    const broken = { on: true };
    const hh = harness({ clock, features: [feature("greet")] });
    hh.agents = crashWhile(broken, hh);
    const id = hh.createMission("greenfield").id;

    const paused = await drive(hh, clock, id);

    expect(paused).toMatchObject({ status: "stopped", stage: "spec", agentRuns: hh.jobs.length });
    expect(paused.decisionsNeeded.join("\n")).not.toMatch(/describ|rephrase|plain sentences/i);
    expect(paused.notes.join("\n")).toContain("AI invocations still count toward the mission safety cap");
    expect(paused.notes.join("\n")).toContain("unexpected argument '--permission-prompts'");
    expect(hh.notifications).toEqual([
      expect.objectContaining({ title: "Fixture app: paused, the AI isn't working", message: expect.stringContaining("--permission-prompts"), opts: expect.objectContaining({ priority: "high" }) }),
    ]);
    // Retried with growing pauses for about half an hour, on both families, before giving up.
    expect(hh.jobsLabeled("spec").length).toBeGreaterThan(2);
    expect(new Set(hh.jobsLabeled("spec").map((j) => j.provider))).toEqual(new Set(["claude", "codex"]));

    // Once the CLI works again, the same mission carries on (a plain `mc run` picks up stopped missions).
    broken.on = false;
    const m = await drive(hh, clock, id);
    expect(m.status).toBe("done");
    expect(m.features.map((f) => [f.id, f.status, f.attempts.map((a) => a.outcome)])).toEqual([["greet", "done", ["pass"]]]);
  });

  it("never blocks a feature for it: an outage during a build uses up no rung", async () => {
    const clock = new FakeClock(Date.now());
    const outage = { on: false };
    const hh = harness({ clock, features: [feature("greet"), feature("farewell", ["greet"])] });
    const defaults = hh.defaults;
    hh.agents = {
      ...crashWhile(outage, hh),
      engineer: (job, call) => {
        // The network goes down at the first build of greet and comes back 10 minutes later.
        if (call.label === "build-greet" && call.n === 1) {
          outage.on = true;
          const back = clock.now() + 10 * MIN;
          const end = setInterval(() => {
            if (clock.now() >= back) {
              outage.on = false;
              clearInterval(end);
            }
          }, 1);
        }
        return outage.on ? { outcome: "crashed", error: "codex exited with code 1: error sending request: Temporary failure in name resolution" } : defaults.engineer(job, call);
      },
    };
    const id = hh.createMission("greenfield").id;

    const m = await drive(hh, clock, id);

    expect(m.status).toBe("done");
    for (const f of m.features) {
      expect(f.status).toBe("done");
      expect(f.rung).toBe(0);
      expect(f.attempts.map((a) => [a.action, a.outcome])).toEqual([["build", "pass"]]);
    }
    expect(hh.jobsLabeled("build-greet").length).toBeGreaterThan(1); // the crashed runs were retried, not counted
    expect(hh.jobs.some((j) => labelOf(j).startsWith("diagnose-"))).toBe(false);
  });

  it("says plainly that the AI never answered when its answers could not be used, without asking to rephrase", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: { architect: () => ({ outcome: "failed", error: "invalid structured output: the final message holds no JSON object" }) },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m).toMatchObject({ status: "failed", stage: "spec" });
    expect(hh.jobsLabeled("spec")).toHaveLength(2);
    const decision = m.decisionsNeeded.join("\n");
    expect(decision).toContain("didn't give a usable answer");
    expect(decision).toContain("invalid structured output");
    expect(decision).toContain(`mc run --mission ${m.id}`);
    expect(decision).not.toMatch(/describ|rephrase|plain sentences/i);
  });

  it("ends the night only once every AI command line keeps failing, not after a single crash", () => {
    const hh = harness({ features: [feature("greet")] });
    const dispatcher = hh.dispatcher({ freeBytes: () => 1e12 });
    hh.quota.recordFailure("claude", "claude exited with code 1");
    expect(dispatcher.noWorkPossible()).toBeUndefined();
    for (let i = 0; i < 3; i++) hh.quota.recordFailure("codex", BROKEN_CLI);
    expect(dispatcher.noWorkPossible()).toBeUndefined(); // Claude failed only once: it may well work now
    hh.quota.recordFailure("claude", "claude exited with code 1");
    hh.quota.recordFailure("claude", "claude exited with code 1");
    expect(dispatcher.noWorkPossible()).toBe("the AI command lines keep failing (claude exited with code 1)");
    hh.quota.recordSuccess("claude");
    expect(dispatcher.noWorkPossible()).toBeUndefined();
  });

  it("still asks to rephrase when the AI's plans themselves were unusable", async () => {
    const hh = harness({ agents: { architect: () => ({ structured: specOutput([feature("a", ["b"]), feature("b", ["a"])]) }) } });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m).toMatchObject({ status: "failed", stage: "spec" });
    expect(m.decisionsNeeded.join("\n")).toMatch(/couldn't turn your request into a workable plan/);
  });
});

// ───────────────────────────── The night ─────────────────────────────

describe("the night run during an outage", () => {
  let root: string;
  let home: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-outage-"));
    home = join(root, "home");
    vi.stubEnv("MC_HOME", home);
    fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  function config(): Config {
    const c = defaultConfig();
    c.home = home;
    c.workspaceRoot = join(root, "apps");
    c.notify.ntfyUrl = "https://ntfy.example/topic";
    return c;
  }

  function notifications(): { title: string; body: string }[] {
    return fetchMock.mock.calls.map(([, init]) => {
      const { headers, body } = init as { headers: Record<string, string>; body: string };
      return { title: headers.Title ?? "", body };
    });
  }

  it("tells the phone the AIs aren't responding, not that they are at a usage limit, and keeps the missions resumable", async () => {
    const clock = new FakeClock(Date.now());
    const store = new MissionStore(home);
    const queued = [1, 2].map((n) =>
      store.createMission({ kind: "greenfield", title: `App ${n}`, request: `Build app ${n}`, repoPath: "", baseBranch: "main", profile: "mixed", nowMs: clock.now() + n }),
    );
    const offline = (): MockBehavior => ({ outcome: "crashed", error: "claude exited with code 1 without a result: getaddrinfo EAI_AGAIN api.anthropic.com" });
    const runners = { claude: new MockRunner(offline, { provider: "claude" }), codex: new MockRunner(offline, { provider: "codex" }) };

    let done = false;
    const night = runNight({ config: config(), clock, logger: nullLogger, runners }).finally(() => (done = true));
    while (!done) {
      if (clock.pendingSleeps() > 0) await clock.advance(MIN);
      else await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const result = await night;

    // The first mission pauses; the night then ends instead of waiting out the same failing CLIs for the next one.
    expect(queued.map((m) => store.load(m.id).status)).toEqual(["stopped", "queued"]);
    expect(store.load(queued[0]?.id ?? "")).toMatchObject({ stage: "spec", agentRuns: runners.claude.calls.length + runners.codex.calls.length });
    expect(result.missions.map((m) => m.id)).toEqual([queued[0]?.id]);
    const summary = readFileSync(result.summaryPath, "utf8");
    expect(summary).toContain("Ended early because the AI command lines keep failing");
    expect(summary).toContain("EAI_AGAIN");
    const titles = notifications().map((n) => n.title);
    expect(titles).toContain("Waiting for the AIs to respond");
    expect(titles).not.toContain("Waiting for usage limits");
    const waiting = notifications().find((n) => n.title === "Waiting for the AIs to respond");
    expect(waiting?.body).toContain("not a usage limit");
    expect(summary).not.toContain("Nothing was queued");

    // Back online: a plain run carries on with both.
    const working = (job: AgentJob): MockBehavior => ({ outcome: "failed", error: `still checking ${job.id}` });
    const next = { claude: new MockRunner(working, { provider: "claude" }), codex: new MockRunner(working, { provider: "codex" }) };
    const night2 = await runNight({ config: config(), clock, logger: nullLogger, runners: next });
    expect(night2.missions.map((m) => m.id)).toEqual(queued.map((m) => m.id));
  });
});
