import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "./config.js";
import {
  AuthUnavailableError,
  DeadlineError,
  type ExecRequest,
  type ExecResult,
  ProvidersFailingError,
  RoleExecutor,
  type RoleExecutorDeps,
  StopRequestedError,
} from "./executor.js";
import { QuotaGovernor } from "./quota.js";
import { type MockBehavior, MockRunner } from "./runners/mock.js";
import { MissionStore } from "./state.js";
import type { AgentJob, AgentRunner, Config, Provider, RunEvent, RunOptions, RunResult } from "./types.js";
import { FakeClock } from "./util/clock.js";
import { nullLogger } from "./util/logger.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const MARGIN = 45_000;
const MISSION = "2026-01-01-test";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const ASTRA = "gpt-6-astra";
const SOL = "gpt-6.1-sol";

// ───────────── A tiny scripted runner (stands in for MockRunner) ─────────────

const MAX_STUB_CALLS = 20;

interface StubStep {
  result?: Partial<RunResult>;
  events?: RunEvent[];
  /** Run until the signal aborts, then return outcome "aborted". */
  hang?: boolean;
  /** How long the run takes on the fake clock. */
  elapse?: number;
}

class StubRunner implements AgentRunner {
  readonly calls: AgentJob[] = [];

  constructor(
    readonly provider: Provider,
    private readonly script: (job: AgentJob, call: number) => StubStep = () => ({}),
  ) {}

  async run(job: AgentJob, opts: RunOptions = {}): Promise<RunResult> {
    // A retry loop that never waits would spin on microtasks forever; fail the test instead of hanging the worker.
    if (this.calls.length >= MAX_STUB_CALLS) throw new Error(`runaway retry loop: ${this.provider} ran ${MAX_STUB_CALLS} times`);
    const step = this.script(job, this.calls.length);
    this.calls.push(job);
    for (const event of step.events ?? []) opts.onEvent?.(event);
    if (step.elapse) await clock.advance(step.elapse);
    if (step.hang) await abortOf(opts.signal);
    return {
      outcome: step.hang ? "aborted" : "ok",
      text: `${job.model} done`,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      durationMs: 1234,
      exitCode: 0,
      ...step.result,
    };
  }

  models(): string[] {
    return this.calls.map((j) => j.model);
  }
}

function abortOf(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

const ok = (): StubStep => ({});
const limited = (info: Omit<RunResult["limit"] & object, "provider"> & { provider?: Provider }): StubStep => ({
  result: { outcome: "limited", error: "usage limit", limit: { provider: "claude", ...info } },
});
const authFailure = (): StubStep => ({ result: { outcome: "auth", error: "401 Unauthorized" } });

// ───────────── Fixture ─────────────

let home: string;
let savedHome: string | undefined;
let clock: FakeClock;
let config: Config;
let quota: QuotaGovernor;
let store: MissionStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mc-exec-"));
  savedHome = process.env.MC_HOME;
  process.env.MC_HOME = home;
  clock = new FakeClock();
  config = defaultConfig();
  quota = new QuotaGovernor({ clock, config });
  store = new MissionStore(home);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MC_HOME;
  else process.env.MC_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function executor(runners: RoleExecutorDeps["runners"], extra: Partial<RoleExecutorDeps> = {}): RoleExecutor {
  return new RoleExecutor({ config, runners, quota, clock, store, logger: nullLogger, ...extra });
}

function request(overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    missionId: MISSION,
    role: "engineer",
    label: "build-login",
    family: "codex",
    tier: "frontier",
    effort: "high",
    allowFailover: true,
    cwd: home,
    systemPrompt: "You are the engineer.",
    prompt: "Build the login page.",
    access: "workspace-write",
    maxTurns: 80,
    ...overrides,
  };
}

function runners(claudeScript?: (job: AgentJob, call: number) => StubStep, codexScript?: (job: AgentJob, call: number) => StubStep) {
  return { claude: new StubRunner("claude", claudeScript), codex: new StubRunner("codex", codexScript) };
}

/** Follows a promise without awaiting it (and without leaving a rejection unhandled). */
function track<T>(promise: Promise<T>): { done: boolean; value?: T; error?: unknown } {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  promise.then(
    (value) => Object.assign(state, { done: true, value }),
    (error: unknown) => Object.assign(state, { done: true, error }),
  );
  return state;
}

/** Lets pending promise chains (stub runs, file writes) reach their next clock.sleep. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

// ───────────── Tests ─────────────

describe("RoleExecutor: running a job", () => {
  it("runs the requested family and tier and returns what ran", async () => {
    const r = runners();
    const res = await executor(r).exec(request());

    expect(res).toMatchObject({ skipped: false, provider: "codex", model: ASTRA, family: "codex" });
    expect(res.result).toMatchObject({ outcome: "ok", text: `${ASTRA} done` });
    expect(r.claude.calls).toEqual([]);
    expect(r.codex.calls).toEqual([
      {
        id: "build-login-1",
        role: "engineer",
        provider: "codex",
        model: ASTRA,
        effort: "high",
        cwd: home,
        systemPrompt: "You are the engineer.",
        prompt: "Build the login page.",
        access: "workspace-write",
        limits: { maxTurns: 80, timeoutMs: config.limits.agentTimeoutMs },
        logFile: join(store.logsDir(MISSION), "build-login-1.ndjson"),
      },
    ]);
  });

  it("passes the output schema, noTools and a timeout override", async () => {
    const r = runners();
    const schema = { type: "object", properties: {}, required: [], additionalProperties: false };
    await executor(r).exec(
      request({ family: "claude", role: "reviewer", access: "read-only", noTools: true, outputSchema: schema, timeoutMs: 5_000, maxTurns: 40 }),
    );
    expect(r.claude.calls[0]).toMatchObject({ outputSchema: schema, noTools: true, access: "read-only", limits: { maxTurns: 40, timeoutMs: 5_000 } });
  });

  it("passes the folders a read-only run may open files from to the job, and nothing when there are none", async () => {
    const r = runners();
    await executor(r).exec(request({ family: "claude", role: "reviewer", access: "read-only", readDirs: ["/home/u/missions/m1/screenshots"] }));
    expect(r.claude.calls[0]?.readDirs).toEqual(["/home/u/missions/m1/screenshots"]);
    const none = runners();
    await executor(none).exec(request({ family: "claude", role: "reviewer", access: "read-only" }));
    await executor(none).exec(request({ family: "claude", role: "reviewer", access: "read-only", readDirs: [] }));
    for (const call of none.claude.calls) expect(Object.keys(call)).not.toContain("readDirs");
  });

  it("records usage and run events in the mission", async () => {
    clock = new FakeClock(Date.UTC(2026, 9, 10, 2, 0, 0));
    quota = new QuotaGovernor({ clock, config });
    await executor(runners()).exec(request({ effort: "xhigh" }));

    expect(store.readUsage()).toEqual([
      {
        at: "2026-10-10T02:00:00.000Z",
        missionId: MISSION,
        role: "engineer",
        provider: "codex",
        model: ASTRA,
        effort: "xhigh",
        outcome: "ok",
        durationMs: 1234,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
    const events = store.readEvents(MISSION);
    expect(events.map((e) => e.type)).toEqual(["run.start", "run.end"]);
    expect(events[0]?.data).toEqual({ label: "build-login", jobId: "build-login-1", role: "engineer", provider: "codex", model: ASTRA, effort: "xhigh" });
    expect(events[1]?.data).toEqual({ label: "build-login", jobId: "build-login-1", provider: "codex", model: ASTRA, outcome: "ok", durationMs: 1234 });
  });

  it("numbers jobs per label and never reuses a log file already on disk", async () => {
    const r = runners();
    const exec = executor(r);
    await exec.exec(request());
    await exec.exec(request());
    await exec.exec(request({ label: "review" }));
    await exec.exec(request({ label: "a/../b c" }));
    expect(r.codex.calls.map((j) => j.id)).toEqual(["build-login-1", "build-login-2", "review-1", "a-..-b-c-1"]);

    // A restarted executor (new instance) continues after the logs a previous run left behind.
    writeFileSync(join(store.logsDir(MISSION), "build-login-1.ndjson"), "");
    writeFileSync(join(store.logsDir(MISSION), "build-login-2.ndjson"), "");
    await executor(r).exec(request());
    expect(r.codex.calls.at(-1)?.id).toBe("build-login-3");
  });

  it("returns a failed run as is, without retrying: the agent answered, so the job judges it", async () => {
    const r = runners(undefined, () => ({ result: { outcome: "failed", error: "invalid structured output: boom" } }));
    const success = vi.spyOn(quota, "recordSuccess");
    const res = await executor(r).exec(request());
    expect(res).toMatchObject({ skipped: false, provider: "codex", result: { outcome: "failed", error: "invalid structured output: boom" } });
    expect(r.codex.calls).toHaveLength(1);
    expect(success).not.toHaveBeenCalled();
    expect(quota.state("codex")).toEqual({ status: "ok" });
    expect(store.readEvents(MISSION).at(-1)?.data).toMatchObject({ outcome: "failed", error: "invalid structured output: boom" });
  });

  it("returns a run that timed out after showing progress as is: the agent was too slow", async () => {
    const r = runners(undefined, () => ({ events: [{ type: "progress", text: "Edit src/app.ts" }], result: { outcome: "timeout", error: "timed out" } }));
    const res = await executor(r).exec(request());
    expect(res).toMatchObject({ provider: "codex", result: { outcome: "timeout" } });
    expect(r.codex.calls).toHaveLength(1);
    expect(quota.state("codex")).toEqual({ status: "ok" });
  });

  it("records a success, which resets the provider's throttle backoff", async () => {
    quota.recordLimit({ provider: "codex", kind: "throttle", raw: "429" });
    quota.recordLimit({ provider: "codex", kind: "throttle", raw: "429" });
    await clock.advance(2 * MIN);
    await executor(runners()).exec(request());
    quota.recordLimit({ provider: "codex", kind: "throttle", raw: "429" });
    expect(quota.availableAt("codex")).toBe(clock.now() + MIN);
  });

  it("logs agent progress at debug level", async () => {
    const debug = vi.fn();
    const r = runners(undefined, () => ({ events: [{ type: "progress", text: "Edit src/app.ts" }] }));
    await executor(r, { logger: { ...nullLogger, debug } }).exec(request());
    expect(debug).toHaveBeenCalledWith("[build-login-1] Edit src/app.ts", { jobId: "build-login-1" });
  });
});

describe("RoleExecutor: candidates and failover", () => {
  it("fails over to the other family at the same tier when the run hits a limit", async () => {
    const resetsAt = clock.now() + 10 * MIN;
    const r = runners(undefined, () => limited({ provider: "codex", kind: "session", resetsAt, raw: "Try again at 2:10 AM" }));
    const res = await executor(r).exec(request());

    expect(res).toMatchObject({ provider: "claude", model: OPUS, family: "claude", result: { outcome: "ok" } });
    expect(r.codex.models()).toEqual([ASTRA]);
    expect(r.claude.models()).toEqual([OPUS]);
    expect(quota.state("codex")).toEqual({ status: "limited", kind: "session", until: resetsAt, raw: "Try again at 2:10 AM" });
    expect(store.readUsage().map((u) => [u.provider, u.outcome])).toEqual([
      ["codex", "limited"],
      ["claude", "ok"],
    ]);
    expect(r.claude.calls[0]?.id).toBe("build-login-2");
  });

  it("goes straight to the other family while the requested one is limited", async () => {
    quota.recordLimit({ provider: "codex", kind: "weekly", raw: "weekly" });
    const r = runners();
    const res = await executor(r).exec(request({ tier: "standard" }));
    expect(res).toMatchObject({ provider: "claude", model: SONNET, family: "claude" });
    expect(r.codex.calls).toEqual([]);
  });

  it.each([
    ["the request does not allow it", { allowFailover: false }, true],
    ["failover is disabled in the config", { allowFailover: true }, false],
  ] as const)("waits instead of failing over when %s", async (_why, overrides, failoverEnabled) => {
    config.failover.enabled = failoverEnabled;
    const resetsAt = clock.now() + 10 * MIN;
    quota.recordLimit({ provider: "codex", kind: "session", resetsAt, raw: "limit" });
    const r = runners();
    const onWaiting = vi.fn();
    const run = track(executor(r, { onWaiting }).exec(request(overrides)));
    await settle();

    expect(onWaiting).toHaveBeenCalledWith(resetsAt + MARGIN, expect.stringContaining(ASTRA), "limits");
    await clock.advance(10 * MIN + MARGIN - 1);
    expect(run.done).toBe(false);
    await clock.advance(1);
    await settle();
    expect(run.value).toMatchObject({ provider: "codex", model: ASTRA });
    expect(r.claude.calls).toEqual([]);
  });

  it("runs light work on the light model and reports that model's family", async () => {
    const r = runners();
    const res = await executor(r).exec(request({ role: "scout", tier: "light", effort: "low", family: "codex", access: "read-only" }));
    expect(res).toMatchObject({ provider: "claude", model: HAIKU, family: "claude" });
    expect(r.claude.calls[0]).toMatchObject({ model: HAIKU, effort: "low" });
  });

  it("falls back from the light model to the family's standard model, then the other family's", async () => {
    quota.recordLimit({ provider: "claude", kind: "model", model: "haiku", raw: "haiku limit" });
    const r = runners();
    const exec = executor(r);
    const light = request({ tier: "light", family: "codex", effort: "medium" });

    expect(await exec.exec(light)).toMatchObject({ provider: "codex", model: SOL, family: "codex" });
    quota.recordLimit({ provider: "codex", kind: "session", raw: "limit" });
    expect(await exec.exec(light)).toMatchObject({ provider: "claude", model: SONNET, family: "claude" });
  });

  it("keeps light work on the light model and the family's standard model without failover", async () => {
    quota.recordLimit({ provider: "claude", kind: "model", model: "haiku", raw: "haiku limit" });
    quota.recordLimit({ provider: "codex", kind: "session", resetsAt: clock.now() + HOUR, raw: "limit" });
    const onWaiting = vi.fn();
    const run = track(executor(runners(), { onWaiting }).exec(request({ tier: "light", allowFailover: false })));
    await settle();
    expect(run.done).toBe(false);
    expect(onWaiting.mock.calls[0]?.[1]).toBe(
      `${HAIKU}: model limit until ${new Date(clock.now() + 6 * HOUR).toISOString()}; ${SOL}: session limit until ${new Date(clock.now() + HOUR).toISOString()}`,
    );
    expect(onWaiting.mock.calls[0]?.[0]).toBe(clock.now() + HOUR + MARGIN);
  });

  it("skips optional work at once when the light model is unavailable: no fallback, no waiting", async () => {
    quota.recordLimit({ provider: "claude", kind: "model", model: "haiku", raw: "haiku limit" });
    const r = runners();
    const onWaiting = vi.fn();
    const res = await executor(r, { onWaiting }).exec(request({ tier: "light", optional: true }));
    expect(res).toEqual({ skipped: true, result: null, provider: null, model: null, family: null });
    expect(r.claude.calls).toEqual([]);
    expect(r.codex.calls).toEqual([]);
    expect(onWaiting).not.toHaveBeenCalled();
    expect(clock.pendingSleeps()).toBe(0);
  });

  it("skips optional work when every candidate is limited, and runs it when one is free", async () => {
    quota.recordLimit({ provider: "codex", kind: "session", raw: "limit" });
    quota.recordLimit({ provider: "claude", kind: "session", raw: "limit" });
    const r = runners();
    expect(await executor(r).exec(request({ optional: true }))).toMatchObject({ skipped: true });
    await clock.advance(HOUR);
    expect(await executor(r).exec(request({ optional: true }))).toMatchObject({ skipped: false, provider: "codex" });
  });

  it("skips an optional run that hits a limit when nothing else is free", async () => {
    const r = runners((job) => limited({ kind: "session", raw: job.model }));
    const res = await executor(r).exec(request({ tier: "light", optional: true }));
    expect(res).toMatchObject({ skipped: true });
    expect(r.claude.models()).toEqual([HAIKU]);
  });

  it("passes over candidates that have no runner", async () => {
    const claude = new StubRunner("claude");
    const res = await executor({ claude }).exec(request());
    expect(res).toMatchObject({ provider: "claude", model: OPUS });
  });

  it("throws when no candidate has a runner, but skips optional work", async () => {
    const claude = new StubRunner("claude");
    await expect(executor({ claude }).exec(request({ allowFailover: false }))).rejects.toThrow(/no runner/);
    expect(await executor({ claude }).exec(request({ allowFailover: false, optional: true }))).toMatchObject({ skipped: true });
  });

  it("runs a model on the provider its family names (e.g. a mock family)", async () => {
    config.families.codex.provider = "mock";
    const mock = new StubRunner("mock");
    const res = await executor({ mock, claude: new StubRunner("claude") }).exec(request());
    expect(res).toMatchObject({ provider: "mock", model: ASTRA, family: "codex" });
  });
});

describe("RoleExecutor: waiting for limits", () => {
  it("waits until the earliest candidate frees up, plus 45 s", async () => {
    quota.recordLimit({ provider: "codex", kind: "session", resetsAt: clock.now() + 10 * MIN, raw: "codex" });
    quota.recordLimit({ provider: "claude", kind: "session", resetsAt: clock.now() + 30 * MIN, raw: "claude" });
    const r = runners();
    const onWaiting = vi.fn();
    const start = clock.now();
    const run = track(executor(r, { onWaiting }).exec(request()));
    await settle();

    expect(onWaiting).toHaveBeenCalledTimes(1);
    const [until, reason] = onWaiting.mock.calls[0] as [number, string];
    expect(until).toBe(start + 10 * MIN + MARGIN);
    expect(reason).toContain(ASTRA);
    expect(reason).toContain(OPUS);
    await clock.advance(10 * MIN + MARGIN);
    await settle();
    expect(run.value).toMatchObject({ provider: "codex", model: ASTRA });
  });

  it("waits again when a candidate is still blocked after waking", async () => {
    quota.recordLimit({ provider: "codex", kind: "session", resetsAt: clock.now() + 10 * MIN, raw: "codex" });
    const r = runners();
    const onWaiting = vi.fn();
    const run = track(executor(r, { onWaiting }).exec(request({ allowFailover: false })));
    await settle();
    // Another limit arrives while waiting (e.g. reported by a run of another executor).
    quota.recordLimit({ provider: "codex", kind: "weekly", resetsAt: clock.now() + 2 * HOUR, raw: "weekly" });
    await clock.advance(10 * MIN + MARGIN);
    expect(run.done).toBe(false);
    expect(onWaiting).toHaveBeenCalledTimes(2);
    await clock.advance(2 * HOUR);
    await settle();
    expect(run.value).toMatchObject({ provider: "codex" });
  });

  it("checks for a stop at least once a minute during a long wait", async () => {
    quota.recordLimit({ provider: "codex", kind: "weekly", resetsAt: clock.now() + 3 * HOUR, raw: "weekly" });
    let stop = false;
    const stopCheck = vi.fn(() => stop);
    const r = runners();
    const run = track(executor(r, { stopCheck }).exec(request({ allowFailover: false })));
    await settle();
    expect(clock.pendingSleeps()).toBe(1);

    const before = stopCheck.mock.calls.length;
    await clock.advance(10 * MIN);
    expect(stopCheck.mock.calls.length - before).toBeGreaterThanOrEqual(10);
    expect(run.done).toBe(false);

    stop = true;
    await clock.advance(MIN);
    expect(run.error).toBeInstanceOf(StopRequestedError);
    expect(r.codex.calls).toEqual([]);
    expect(clock.pendingSleeps()).toBe(0);
  });

  it("stops when the abort signal fires during a wait", async () => {
    quota.recordLimit({ provider: "codex", kind: "weekly", raw: "weekly" });
    const controller = new AbortController();
    const run = track(executor(runners(), { signal: controller.signal }).exec(request({ allowFailover: false })));
    await settle();
    controller.abort();
    await settle();
    expect(run.error).toBeInstanceOf(StopRequestedError);
  });

  it("throws DeadlineError when the wait would end after the deadline", async () => {
    const resetsAt = clock.now() + 2 * HOUR;
    quota.recordLimit({ provider: "codex", kind: "session", resetsAt, raw: "limit" });
    const onWaiting = vi.fn();
    const exec = executor(runners(), { deadline: clock.now() + HOUR, onWaiting });
    const err = await exec.exec(request({ allowFailover: false })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeadlineError);
    expect((err as DeadlineError).until).toBe(resetsAt + MARGIN);
    expect(onWaiting).not.toHaveBeenCalled();
    expect(clock.pendingSleeps()).toBe(0);
  });

  it.each([
    ["required", false],
    ["optional", true],
  ])("starts no %s run once the deadline has passed", async (_kind, optional) => {
    const r = runners();
    const deadline = clock.now() - 1;
    const err = await executor(r, { deadline }).exec(request({ optional })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeadlineError);
    expect((err as DeadlineError).until).toBe(clock.now());
    expect((err as Error).message).toBe(`the deadline ${new Date(deadline).toISOString()} has passed`);
    expect(r.codex.calls).toEqual([]);
  });

  it("starts no retry once a limited run has outlasted the deadline", async () => {
    const r = runners(undefined, () => ({ ...limited({ provider: "codex", kind: "session", raw: "limit" }), elapse: 45 * MIN }));
    const err = await executor(r, { deadline: clock.now() + 30 * MIN }).exec(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeadlineError);
    expect(r.codex.calls).toHaveLength(1);
    expect(r.claude.calls).toEqual([]);
  });

  it("may start a run at the deadline itself", async () => {
    const r = runners();
    expect(await executor(r, { deadline: clock.now() }).exec(request())).toMatchObject({ provider: "codex" });
  });

  it("waits when the wait ends before the deadline", async () => {
    quota.recordLimit({ provider: "codex", kind: "session", resetsAt: clock.now() + 10 * MIN, raw: "limit" });
    const run = track(executor(runners(), { deadline: clock.now() + HOUR }).exec(request({ allowFailover: false })));
    await clock.advance(0);
    await settle();
    await clock.advance(10 * MIN + MARGIN);
    await settle();
    expect(run.value).toMatchObject({ provider: "codex" });
  });
});

describe("RoleExecutor: stopping", () => {
  it("stops before a run when a stop was requested", async () => {
    const r = runners();
    await expect(executor(r, { stopCheck: () => true }).exec(request())).rejects.toBeInstanceOf(StopRequestedError);
    expect(r.codex.calls).toEqual([]);
  });

  it("stops before a run when the signal already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = runners();
    await expect(executor(r, { signal: controller.signal }).exec(request())).rejects.toBeInstanceOf(StopRequestedError);
    expect(r.codex.calls).toEqual([]);
  });

  it("turns an aborted run into StopRequestedError, after recording it", async () => {
    const controller = new AbortController();
    const r = runners(undefined, () => ({ hang: true }));
    const run = track(executor(r, { signal: controller.signal }).exec(request()));
    await settle();
    expect(r.codex.calls).toHaveLength(1);
    controller.abort();
    await settle();
    expect(run.error).toBeInstanceOf(StopRequestedError);
    expect(store.readUsage().map((u) => u.outcome)).toEqual(["aborted"]);
  });

  it("checks for a stop before retrying after a limited run", async () => {
    let stop = false;
    const r = runners(undefined, () => {
      stop = true;
      return limited({ provider: "codex", kind: "session", raw: "limit" });
    });
    await expect(executor(r, { stopCheck: () => stop }).exec(request())).rejects.toBeInstanceOf(StopRequestedError);
    expect(r.claude.calls).toEqual([]);
  });
});

describe("RoleExecutor: login failures", () => {
  it("fails over when the requested provider needs a login", async () => {
    const r = runners(undefined, authFailure);
    const res = await executor(r).exec(request());
    expect(res).toMatchObject({ provider: "claude", result: { outcome: "ok" } });
    expect(quota.state("codex")).toEqual({ status: "auth", raw: "401 Unauthorized" });
  });

  it("throws AuthUnavailableError when every candidate needs a login", async () => {
    const r = runners(authFailure, authFailure);
    const err = await executor(r).exec(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthUnavailableError);
    expect((err as AuthUnavailableError).providers).toEqual(["codex", "claude"]);
    expect((err as Error).message).toBe("codex and claude need a new login");
    expect(r.codex.calls).toHaveLength(1);
    expect(r.claude.calls).toHaveLength(1);
  });

  it("throws AuthUnavailableError without failover even if the other provider works", async () => {
    const r = runners(undefined, authFailure);
    await expect(executor(r).exec(request({ allowFailover: false }))).rejects.toThrow("codex needs a new login");
    expect(r.claude.calls).toEqual([]);
  });

  it("waits for a limited candidate rather than giving up while another needs a login", async () => {
    quota.recordAuthFailure("codex", "401");
    quota.recordLimit({ provider: "claude", kind: "session", resetsAt: clock.now() + 10 * MIN, raw: "limit" });
    const onWaiting = vi.fn();
    const run = track(executor(runners(), { onWaiting }).exec(request()));
    await settle();
    expect(onWaiting.mock.calls[0]?.[1]).toContain(`${ASTRA}: codex needs a new login`);
    await clock.advance(10 * MIN + MARGIN);
    await settle();
    expect(run.value).toMatchObject({ provider: "claude" });
  });

  it("checks a failed login again with a real run after 30 minutes", async () => {
    const r = runners(undefined, (_job, call) => (call === 0 ? authFailure() : ok()));
    const exec = executor(r);
    await expect(exec.exec(request({ allowFailover: false }))).rejects.toBeInstanceOf(AuthUnavailableError);
    await clock.advance(30 * MIN - 1);
    await expect(exec.exec(request({ allowFailover: false }))).rejects.toBeInstanceOf(AuthUnavailableError);
    expect(r.codex.calls).toHaveLength(1);
    await clock.advance(1);
    expect(await exec.exec(request({ allowFailover: false }))).toMatchObject({ provider: "codex", result: { outcome: "ok" } });
  });

  it("can be built without arguments", () => {
    const err = new AuthUnavailableError();
    expect(err).toMatchObject({ name: "AuthUnavailableError", message: "every candidate provider needs a new login", providers: [] });
  });

  it("skips optional work instead of failing on logins", async () => {
    const r = runners(authFailure, authFailure);
    expect(await executor(r).exec(request({ optional: true }))).toMatchObject({ skipped: true });
  });
});

describe("RoleExecutor: quota signals from runs", () => {
  it("routes utilization events to the quota, which then paces the provider", async () => {
    const resetsAt = clock.now() + HOUR;
    const r = runners(() => ({
      events: [{ type: "utilization", info: { provider: "claude", window: "five_hour", utilization: 0.99, resetsAt } }],
    }));
    const exec = executor(r);
    expect(await exec.exec(request({ family: "claude" }))).toMatchObject({ provider: "claude", result: { outcome: "ok" } });
    expect(quota.availableAt("claude")).toBe(resetsAt);
    expect(await exec.exec(request({ family: "claude" }))).toMatchObject({ provider: "codex" });
  });

  it("records a limit reported both as an event and in the result only once", async () => {
    const throttle = { provider: "codex" as const, kind: "throttle" as const, raw: "429" };
    const r = runners(undefined, () => ({ events: [{ type: "limit", info: throttle }], result: { outcome: "limited", limit: throttle } }));
    const record = vi.spyOn(quota, "recordLimit");
    await executor(r).exec(request());
    expect(record).toHaveBeenCalledTimes(1);
    expect(quota.availableAt("codex")).toBe(clock.now() + MIN);
  });

  it.each([
    ["later", 4 * HOUR],
    ["earlier", 10 * MIN],
  ])("takes the reset time from the result when the limit event had none (%s than the default)", async (_when, ahead) => {
    config.failover.enabled = false;
    const resetsAt = clock.now() + ahead;
    const event = { provider: "claude" as const, kind: "session" as const, raw: '{"status":"rejected"}' };
    const r = runners((_job, call) =>
      call === 0 ? { events: [{ type: "limit", info: event }], result: { outcome: "limited", limit: { ...event, resetsAt } } } : ok(),
    );
    const onWaiting = vi.fn();
    const run = track(executor(r, { onWaiting }).exec(request({ family: "claude" })));
    await settle();
    expect(quota.availableAt("claude")).toBe(resetsAt);
    expect(onWaiting.mock.calls[0]?.[0]).toBe(resetsAt + MARGIN);
    await clock.advance(ahead + MARGIN);
    await settle();
    expect(run.value).toMatchObject({ provider: "claude", result: { outcome: "ok" } });
    expect(r.claude.calls).toHaveLength(2);
  });

  it("takes a model limit's reset time from the result when the event had none", async () => {
    const resetsAt = clock.now() + 2 * HOUR;
    const event = { provider: "claude" as const, kind: "model" as const, model: "opus", raw: "seven_day_opus" };
    const r = runners(() => ({ events: [{ type: "limit", info: event }], result: { outcome: "limited", limit: { ...event, resetsAt } } }));
    await executor(r).exec(request({ family: "claude" }));
    expect(quota.snapshot().modelBlocks).toEqual({ "claude:opus": resetsAt });
  });

  it("keeps the event's reset time when the result's limit has none", async () => {
    const resetsAt = clock.now() + 10 * MIN;
    const event = { provider: "codex" as const, kind: "session" as const, resetsAt, raw: "limit" };
    const r = runners(undefined, () => ({ events: [{ type: "limit", info: event }], result: { outcome: "limited", limit: { ...event, resetsAt: undefined } } }));
    await executor(r).exec(request());
    expect(quota.availableAt("codex")).toBe(resetsAt);
  });

  it("records an unknown limit when a limited run gives no details", async () => {
    const r = runners(undefined, () => ({ result: { outcome: "limited", error: "limited somehow" } }));
    await executor(r).exec(request());
    expect(quota.state("codex")).toEqual({ status: "limited", kind: "unknown", until: clock.now() + 30 * MIN, raw: "limited somehow" });
  });

  it("blocks only the limited model: Opus fails over while Sonnet keeps running on Claude", async () => {
    const resetsAt = clock.now() + 24 * HOUR;
    const opusLimit = { provider: "claude" as const, kind: "model" as const, model: "opus", resetsAt, raw: "seven_day_opus" };
    const r = runners((job) =>
      job.model === OPUS ? { events: [{ type: "limit", info: opusLimit }], result: { outcome: "limited", limit: opusLimit } } : ok(),
    );
    const exec = executor(r);

    expect(await exec.exec(request({ family: "claude", tier: "frontier" }))).toMatchObject({ provider: "codex", model: ASTRA });
    expect(await exec.exec(request({ family: "claude", tier: "standard" }))).toMatchObject({ provider: "claude", model: SONNET });
    expect(await exec.exec(request({ family: "claude", tier: "frontier" }))).toMatchObject({ provider: "codex", model: ASTRA });
    expect(r.claude.models()).toEqual([OPUS, SONNET]);
    expect(quota.snapshot().modelBlocks).toEqual({ "claude:opus": resetsAt });
    expect(quota.state("claude")).toEqual({ status: "ok" });
  });

  it("waits for Opus without failover while Sonnet stays available", async () => {
    quota.recordLimit({ provider: "claude", kind: "model", model: "opus", resetsAt: clock.now() + HOUR, raw: "opus" });
    const r = runners();
    const exec = executor(r);
    const frontier = track(exec.exec(request({ family: "claude", allowFailover: false, label: "frontier" })));
    await settle();
    expect(frontier.done).toBe(false);
    expect(await exec.exec(request({ family: "claude", tier: "standard", allowFailover: false }))).toMatchObject({ model: SONNET });
    await clock.advance(HOUR + MARGIN);
    await settle();
    expect(frontier.value).toMatchObject({ model: OPUS });
  });

  it("charges a model limit that names no model to the model that ran", async () => {
    const r = runners(() => ({ events: [{ type: "limit", info: { provider: "claude", kind: "model", raw: "model limit" } }], result: { outcome: "limited" } }));
    await executor(r).exec(request({ family: "claude" }));
    expect(quota.snapshot().modelBlocks).toEqual({ [`claude:${OPUS}`]: clock.now() + 6 * HOUR });
    expect(quota.isAvailable("claude", SONNET)).toBe(true);
  });

  it("still moves on when a limit names a different model than the one that ran", async () => {
    const r = runners(() => limited({ kind: "model", model: "fable", raw: "You've hit your Fable limit" }));
    const res = await executor(r).exec(request({ family: "claude" }));
    expect(res).toMatchObject({ provider: "codex" });
    expect(Object.keys(quota.snapshot().modelBlocks).sort()).toEqual([`claude:${OPUS}`, "claude:fable"]);
  });

  it("charges limits to the provider that ran, whatever the runner calls itself", async () => {
    const impostor = new StubRunner("mock", () => limited({ provider: "mock", kind: "session", raw: "limit" }));
    const res = await executor({ codex: impostor, claude: new StubRunner("claude") }).exec(request());
    expect(res).toMatchObject({ provider: "claude" });
    expect(quota.state("codex")).toMatchObject({ status: "limited", kind: "session" });
    expect(quota.state("mock")).toEqual({ status: "ok" });
  });

  it("gives up after 8 runs that hit limits with ProvidersFailingError: such a run never counts as the job's answer", async () => {
    const throttled = (job: AgentJob) => limited({ provider: job.provider, kind: "throttle", raw: `429 on ${job.model}` });
    const r = runners(throttled, throttled);
    const warn = vi.fn();
    const run = track(executor(r, { logger: { ...nullLogger, warn } }).exec(request()));
    for (let minutes = 0; !run.done && minutes < 8 * HOUR / MIN; minutes++) {
      await clock.advance(MIN);
      await settle();
    }
    expect(r.codex.calls.length + r.claude.calls.length).toBe(8);
    expect(run.error).toBeInstanceOf(ProvidersFailingError);
    expect(run.error).toMatchObject({ providers: ["codex", "claude"], detail: "usage limit" });
    expect((run.error as Error).message).toBe("codex and claude kept refusing work (usage limits or overload, 8 runs in a row): usage limit");
    expect(store.readUsage()).toHaveLength(8);
    expect(warn).toHaveBeenCalledWith("giving up on build-login after 8 runs that hit usage limits", { label: "build-login" });
  });


  it("does not count a limited run as the result: the retry's result is returned", async () => {
    const r = runners(undefined, (_job, call) => (call === 0 ? limited({ provider: "codex", kind: "throttle", raw: "429" }) : ok()));
    const run = track(executor(r).exec(request({ allowFailover: false })));
    await settle();
    await clock.advance(MIN + MARGIN);
    await settle();
    const res = run.value as ExecResult;
    expect(res.result?.outcome).toBe("ok");
    expect(r.codex.calls.map((j) => j.id)).toEqual(["build-login-1", "build-login-2"]);
  });
});

describe("RoleExecutor: runs that fail for reasons outside the job", () => {
  const crash = (text = "codex exited with code 1 without completing the turn: error: unknown option '--permission-prompts'"): StubStep => ({
    result: { outcome: "crashed", error: text, exitCode: 1 },
  });
  /** A CLI that hung: no sign of work until the timeout. */
  const hung = (): StubStep => ({ result: { outcome: "timeout", error: "timed out after 2700000 ms", exitCode: null } });

  it.each([
    ["crashed", () => crash()],
    ["hung without a sign of work", hung],
  ] as const)("does not hand back a run that %s: the other family takes the job, and the CLI rests", async (_, step) => {
    const r = runners(undefined, () => step());
    const res = await executor(r).exec(request());
    expect(res).toMatchObject({ provider: "claude", model: OPUS, result: { outcome: "ok" } });
    expect(r.codex.calls).toHaveLength(1);
    expect(quota.state("codex")).toMatchObject({ status: "failing", until: clock.now() + MIN });
    expect(quota.isAvailable("codex", SOL)).toBe(false);
  });

  it("retries the same provider after a backoff when failover is off, and a success ends the backoff", async () => {
    const r = runners(undefined, (_job, call) => (call < 2 ? crash() : ok()));
    const onWaiting = vi.fn();
    const run = track(executor(r, { onWaiting }).exec(request({ allowFailover: false })));
    await settle();
    expect(onWaiting).toHaveBeenLastCalledWith(clock.now() + MIN + MARGIN, expect.stringContaining(`${ASTRA}: codex keeps failing (codex exited with code 1`), "trouble");
    await clock.advance(MIN + MARGIN);
    await settle();
    expect(onWaiting).toHaveBeenLastCalledWith(clock.now() + 2 * MIN + MARGIN, expect.any(String), "trouble"); // backs off
    await clock.advance(2 * MIN + MARGIN);
    await settle();
    expect(run.value).toMatchObject({ provider: "codex", result: { outcome: "ok" } });
    expect(r.codex.calls).toHaveLength(3);
    expect(r.claude.calls).toEqual([]);
    expect(quota.state("codex")).toEqual({ status: "ok" });
    expect(store.readUsage().map((u) => u.outcome)).toEqual(["crashed", "crashed", "ok"]);
  });

  it("gives up with ProvidersFailingError naming the real error once the CLIs have failed for half an hour", async () => {
    const r = runners(() => crash("claude exited with code 1 without a result: Error: boom\n    at main (cli.js:1:1)\nTypeError: x is not a function"), () => crash());
    const warn = vi.fn();
    const start = clock.now();
    const run = track(executor(r, { logger: { ...nullLogger, warn } }).exec(request()));
    for (let minutes = 0; !run.done && minutes < 2 * HOUR / MIN; minutes++) {
      await clock.advance(MIN);
      await settle();
    }
    expect(run.error).toBeInstanceOf(ProvidersFailingError);
    const err = run.error as ProvidersFailingError;
    expect(err.providers).toEqual(["codex", "claude"]);
    expect(err.message).toMatch(/^codex and claude keep failing: /);
    expect(err.detail).toMatch(/exited with code 1/);
    // Retried with growing pauses for about half an hour, alternating between the families.
    const runs = r.codex.calls.length + r.claude.calls.length;
    expect(runs).toBeGreaterThanOrEqual(6);
    expect(runs).toBeLessThanOrEqual(16);
    expect(clock.now() - start).toBeGreaterThanOrEqual(30 * MIN);
    expect(clock.now() - start).toBeLessThan(HOUR);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^giving up on build-login after \d+ runs that failed for reasons outside the job$/), { label: "build-login" });
  });

  it("keeps the first and last line of a long error, where CLIs put the cause", async () => {
    config.failover.enabled = false;
    const r = runners(undefined, () => crash("codex exited with code 1 without completing the turn: warning: x\nmore\nError: the real cause"));
    const run = track(executor(r).exec(request()));
    for (let minutes = 0; !run.done && minutes < 2 * HOUR / MIN; minutes++) {
      await clock.advance(MIN);
      await settle();
    }
    expect((run.error as ProvidersFailingError).detail).toBe("codex exited with code 1 without completing the turn: warning: x … Error: the real cause");
  });

  it("stops waiting for a failing CLI at the deadline", async () => {
    const r = runners(undefined, () => crash());
    const err = await executor(r, { deadline: clock.now() + 30_000 }).exec(request({ allowFailover: false })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeadlineError);
    expect(r.codex.calls).toHaveLength(1);
  });

  it("returns a failing run of optional work as is, without blocking the provider for the required work", async () => {
    const r = runners(() => crash("claude exited with code 1"));
    const res = await executor(r).exec(request({ family: "claude", tier: "light", role: "scout", optional: true }));
    expect(res).toMatchObject({ skipped: false, provider: "claude", model: HAIKU, result: { outcome: "crashed" } });
    expect(r.claude.calls).toHaveLength(1);
    expect(quota.state("claude")).toEqual({ status: "ok" });
  });

  it("tells a wait for usage limits apart from a wait for providers in trouble", async () => {
    const onWaiting = vi.fn();
    quota.recordLimit({ provider: "codex", kind: "session", resetsAt: clock.now() + 10 * MIN, raw: "limit" });
    const first = track(executor(runners(), { onWaiting }).exec(request({ allowFailover: false })));
    await settle();
    expect(onWaiting).toHaveBeenLastCalledWith(clock.now() + 10 * MIN + MARGIN, expect.stringContaining("session limit"), "limits");
    await clock.advance(10 * MIN + MARGIN);
    await settle();
    expect(first.done).toBe(true);

    quota.recordLimit({ provider: "codex", kind: "throttle", raw: "API Error: Connection refused (ECONNREFUSED)" });
    const second = track(executor(runners(), { onWaiting }).exec(request({ allowFailover: false })));
    await settle();
    expect(onWaiting).toHaveBeenLastCalledWith(clock.now() + MIN + MARGIN, expect.stringContaining("throttle limit"), "trouble");
    await clock.advance(MIN + MARGIN);
    await settle();
    expect(second.done).toBe(true);
  });
});

describe("RoleExecutor with MockRunner", () => {
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };

  type Script = (job: AgentJob, call: number) => MockBehavior;

  function mocks(codex: Script, claude: Script = () => ({})) {
    return {
      claude: new MockRunner((job, call) => ({ structured: { ok: true }, ...claude(job, call) }), { provider: "claude" }),
      codex: new MockRunner((job, call) => ({ structured: { ok: true }, ...codex(job, call) }), { provider: "codex" }),
    };
  }

  it("fails over to claude when codex is limited, and the quota shows codex limited", async () => {
    const resetsAt = clock.now() + 10 * MIN;
    const r = mocks(() => ({ limit: { kind: "session", resetsAt } }));
    const res = await executor(r).exec(request({ outputSchema: schema }));
    expect(res).toMatchObject({ provider: "claude", model: OPUS, family: "claude", result: { outcome: "ok", structured: { ok: true } } });
    expect(quota.state("codex")).toMatchObject({ status: "limited", kind: "session", until: resetsAt });
  });

  it("waits for codex with failover off, then resumes after the reset", async () => {
    config.failover.enabled = false;
    const resetsAt = clock.now() + 10 * MIN;
    const r = mocks((_job, call) => (call === 0 ? { limit: { kind: "session", resetsAt } } : {}));
    const run = track(executor(r).exec(request({ outputSchema: schema })));
    await vi.waitFor(() => expect(clock.pendingSleeps()).toBe(1));
    await clock.advance(10 * MIN + MARGIN);
    await vi.waitFor(() => expect(run.done).toBe(true));
    expect(run.value).toMatchObject({ provider: "codex", result: { outcome: "ok", structured: { ok: true } } });
    expect(r.codex.calls).toHaveLength(2);
    expect(r.claude.calls).toHaveLength(0);
  });

  it("records a throttle MockRunner reports as event and result once", async () => {
    const r = mocks((_job, call) => (call === 0 ? { limit: { kind: "throttle" } } : {}));
    await executor(r).exec(request());
    expect(quota.availableAt("codex")).toBe(clock.now() + MIN);
  });

  it("returns a schema mismatch as a failed run without retrying", async () => {
    const r = mocks(() => ({ structured: { ok: "yes" } }));
    const res = await executor(r).exec(request({ outputSchema: schema }));
    expect(res.result).toMatchObject({ outcome: "failed", error: expect.stringContaining("invalid structured output") });
    expect(r.codex.calls).toHaveLength(1);
  });
});
