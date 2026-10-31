import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { detectLimitText } from "./limits.js";
import { QuotaGovernor } from "./quota.js";
import type { Config, LimitInfo, Logger } from "./types.js";
import { FakeClock } from "./util/clock.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

let tmp: string;
let clock: FakeClock;
let config: Config;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "mc-quota-"));
  clock = new FakeClock();
  config = defaultConfig();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function governor(opts: { statePath?: string; logger?: Logger } = {}): QuotaGovernor {
  return new QuotaGovernor({ clock, config, ...opts });
}

function limit(provider: LimitInfo["provider"], kind: LimitInfo["kind"], extra: Partial<LimitInfo> = {}): LimitInfo {
  return { provider, kind, raw: `${kind} limit`, ...extra };
}

function recordingLogger(): Logger & { lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  return {
    lines,
    info: (msg) => lines.push({ level: "info", msg }),
    warn: (msg) => lines.push({ level: "warn", msg }),
    error: (msg) => lines.push({ level: "error", msg }),
  };
}

describe("QuotaGovernor: fresh state", () => {
  it("has every provider available now", () => {
    const q = governor();
    expect(q.isAvailable("claude")).toBe(true);
    expect(q.isAvailable("codex", "gpt-6-astra")).toBe(true);
    expect(q.availableAt("claude", OPUS)).toBe(clock.now());
    expect(q.state("codex")).toEqual({ status: "ok" });
  });

  it("lists the configured providers in the snapshot", () => {
    expect(governor().snapshot()).toEqual({
      providers: { claude: { status: "ok" }, codex: { status: "ok" } },
      modelBlocks: {},
      utilization: [],
    });
  });
});

describe("QuotaGovernor: usage limits", () => {
  it("blocks the provider until the reported reset, then clears itself", async () => {
    const q = governor();
    const resetsAt = clock.now() + 90 * MIN;
    q.recordLimit(limit("codex", "session", { resetsAt, raw: "You've hit your usage limit." }));

    expect(q.isAvailable("codex")).toBe(false);
    expect(q.isAvailable("codex", "gpt-6.1-sol")).toBe(false);
    expect(q.availableAt("codex")).toBe(resetsAt);
    expect(q.state("codex")).toEqual({ status: "limited", kind: "session", until: resetsAt, raw: "You've hit your usage limit." });
    expect(q.isAvailable("claude")).toBe(true);

    await clock.advance(90 * MIN - 1);
    expect(q.isAvailable("codex")).toBe(false);
    await clock.advance(1);
    expect(q.isAvailable("codex")).toBe(true);
    expect(q.state("codex")).toEqual({ status: "ok" });
    expect(q.availableAt("codex")).toBe(clock.now());
  });

  it.each([
    ["session", HOUR],
    ["weekly", 6 * HOUR],
    ["spend", 12 * HOUR],
    ["unknown", 30 * MIN],
  ] as const)("uses a default duration for a %s limit without a reset time", (kind, duration) => {
    const q = governor();
    q.recordLimit(limit("claude", kind));
    expect(q.availableAt("claude")).toBe(clock.now() + duration);
    expect(q.state("claude")).toMatchObject({ status: "limited", kind });
  });

  it("treats a reset time that already passed as unknown, so a stale time cannot cause a retry loop", () => {
    const q = governor();
    q.recordLimit(limit("codex", "session", { resetsAt: clock.now() - 5 * MIN }));
    expect(q.availableAt("codex")).toBe(clock.now() + HOUR);
  });

  it("keeps the longer limit when a shorter one arrives", () => {
    const q = governor();
    const weekly = clock.now() + 3 * 24 * HOUR;
    q.recordLimit(limit("claude", "weekly", { resetsAt: weekly }));
    q.recordLimit(limit("claude", "session", { resetsAt: clock.now() + HOUR }));
    q.recordLimit(limit("claude", "throttle"));
    expect(q.state("claude")).toMatchObject({ kind: "weekly", until: weekly });
  });

  it("extends the block when a later limit arrives", () => {
    const q = governor();
    q.recordLimit(limit("claude", "session", { resetsAt: clock.now() + HOUR }));
    const later = clock.now() + 5 * HOUR;
    q.recordLimit(limit("claude", "spend", { resetsAt: later }));
    expect(q.state("claude")).toMatchObject({ kind: "spend", until: later });
  });

  it("replaces an estimated end with a reported reset of the same limit, earlier or later", () => {
    const q = governor();
    q.recordLimit(limit("claude", "session"));
    q.recordLimit(limit("claude", "session", { resetsAt: clock.now() + 10 * MIN }));
    expect(q.availableAt("claude")).toBe(clock.now() + 10 * MIN);

    q.recordLimit(limit("codex", "weekly"));
    q.recordLimit(limit("codex", "weekly", { resetsAt: clock.now() + 30 * HOUR }));
    expect(q.availableAt("codex")).toBe(clock.now() + 30 * HOUR);
  });

  it("keeps a reported reset when the same limit arrives again without one", () => {
    const q = governor();
    q.recordLimit(limit("claude", "session", { resetsAt: clock.now() + 10 * MIN }));
    q.recordLimit(limit("claude", "session"));
    expect(q.state("claude")).toMatchObject({ kind: "session", until: clock.now() + 10 * MIN });
  });

  it("keeps an estimated longer limit when a shorter limit of another kind reports its reset", () => {
    const q = governor();
    q.recordLimit(limit("claude", "weekly"));
    q.recordLimit(limit("claude", "session", { resetsAt: clock.now() + 10 * MIN }));
    expect(q.state("claude")).toMatchObject({ kind: "weekly", until: clock.now() + 6 * HOUR });
  });

  it.each([
    ["weekly", 363 * DAY, 6 * HOUR],
    ["session", 9 * DAY, HOUR],
    ["spend", 40 * DAY, 12 * HOUR],
  ] as const)("ignores a %s reset implausibly far ahead and warns", (kind, ahead, fallback) => {
    const logger = recordingLogger();
    const q = governor({ logger });
    q.recordLimit(limit("claude", kind, { resetsAt: clock.now() + ahead }));
    expect(q.availableAt("claude")).toBe(clock.now() + fallback);
    expect(logger.lines[0]).toEqual({ level: "warn", msg: `ignoring the reset time of a claude ${kind} limit: ${Math.round(ahead / DAY)} days ahead is implausible` });
  });

  it("accepts resets up to a week ahead, and a spend cap's up to a month ahead", () => {
    const q = governor();
    q.recordLimit(limit("claude", "weekly", { resetsAt: clock.now() + 7 * DAY }));
    q.recordLimit(limit("codex", "spend", { resetsAt: clock.now() + 31 * DAY }));
    q.recordLimit(limit("codex", "model", { model: "astra", resetsAt: clock.now() + 7 * DAY }));
    expect(q.availableAt("claude")).toBe(clock.now() + 7 * DAY);
    expect(q.availableAt("codex")).toBe(clock.now() + 31 * DAY);
    expect(q.snapshot().modelBlocks).toEqual({ "codex:astra": clock.now() + 7 * DAY });
  });

  it("ignores implausible resets of model limits and throttles too", () => {
    const q = governor();
    q.recordLimit(limit("claude", "model", { model: "opus", resetsAt: clock.now() + 100 * DAY }));
    q.recordLimit(limit("codex", "throttle", { resetsAt: clock.now() + 100 * DAY }));
    expect(q.availableAt("claude", OPUS)).toBe(clock.now() + 6 * HOUR);
    expect(q.availableAt("codex")).toBe(clock.now() + MIN);
  });

  it("logs each recorded limit", () => {
    const logger = recordingLogger();
    const q = governor({ logger });
    q.recordLimit(limit("codex", "session"));
    expect(logger.lines).toEqual([{ level: "info", msg: expect.stringContaining("codex limited (session) until") }]);
  });
});

describe("QuotaGovernor: throttling", () => {
  it("backs off exponentially from 60 s, capped at 15 min", () => {
    const q = governor();
    const cooldowns: number[] = [];
    for (let i = 0; i < 7; i++) {
      q.recordLimit(limit("claude", "throttle"));
      cooldowns.push(q.availableAt("claude")! - clock.now());
    }
    // Each throttle replaces the previous cooldown because it ends later.
    expect(cooldowns).toEqual([1, 2, 4, 8, 15, 15, 15].map((m) => m * MIN));
    expect(q.state("claude")).toMatchObject({ status: "limited", kind: "throttle" });
  });

  it("grows across cooldowns that already ended", async () => {
    const q = governor();
    q.recordLimit(limit("codex", "throttle"));
    await clock.advance(MIN);
    expect(q.isAvailable("codex")).toBe(true);
    q.recordLimit(limit("codex", "throttle"));
    expect(q.availableAt("codex")).toBe(clock.now() + 2 * MIN);
  });

  it("starts over from 60 s after a success", async () => {
    const q = governor();
    q.recordLimit(limit("codex", "throttle"));
    q.recordLimit(limit("codex", "throttle"));
    await clock.advance(2 * MIN);
    q.recordSuccess("codex");
    q.recordLimit(limit("codex", "throttle"));
    expect(q.availableAt("codex")).toBe(clock.now() + MIN);
  });

  it("keeps a separate streak per provider", () => {
    const q = governor();
    q.recordLimit(limit("codex", "throttle"));
    q.recordLimit(limit("codex", "throttle"));
    q.recordLimit(limit("claude", "throttle"));
    expect(q.availableAt("claude")).toBe(clock.now() + MIN);
    expect(q.availableAt("codex")).toBe(clock.now() + 2 * MIN);
  });

  it("honors a reported reset later than the backoff", () => {
    const q = governor();
    const resetsAt = clock.now() + 10 * MIN;
    q.recordLimit(limit("claude", "throttle", { resetsAt }));
    expect(q.availableAt("claude")).toBe(resetsAt);
  });
});

describe("QuotaGovernor: model-specific limits", () => {
  it("blocks only the matching models of that provider", () => {
    const q = governor();
    const resetsAt = clock.now() + 2 * 24 * HOUR;
    q.recordLimit(limit("claude", "model", { model: "opus", resetsAt }));

    expect(q.isAvailable("claude", OPUS)).toBe(false);
    expect(q.availableAt("claude", OPUS)).toBe(resetsAt);
    expect(q.isAvailable("claude", SONNET)).toBe(true);
    expect(q.isAvailable("claude")).toBe(true);
    expect(q.state("claude")).toEqual({ status: "ok" });
    expect(q.isAvailable("codex", "gpt-6-astra")).toBe(true);
    expect(q.snapshot().modelBlocks).toEqual({ "claude:opus": resetsAt });
  });

  it("matches case-insensitively and accepts a full model id", () => {
    const q = governor();
    q.recordLimit(limit("claude", "model", { model: "Sonnet" }));
    q.recordLimit(limit("codex", "model", { model: "gpt-6-astra" }));
    expect(q.isAvailable("claude", "CLAUDE-SONNET-5-5")).toBe(false);
    expect(q.isAvailable("codex", "gpt-6-astra")).toBe(false);
    expect(q.isAvailable("codex", "gpt-6.1-sol")).toBe(true);
  });

  it("defaults to 6 hours and does not touch the other provider's models", () => {
    const q = governor();
    q.recordLimit(limit("codex", "model", { model: "opus" }));
    expect(q.isAvailable("claude", OPUS)).toBe(true);
    expect(q.availableAt("codex", "opus-like-model")).toBe(clock.now() + 6 * HOUR);
  });

  it("blocks the whole provider when a model limit names no model", () => {
    const q = governor();
    q.recordLimit(limit("claude", "model"));
    expect(q.isAvailable("claude", SONNET)).toBe(false);
    expect(q.state("claude")).toMatchObject({ status: "limited", kind: "model", until: clock.now() + 6 * HOUR });
  });

  it("combines with provider limits: the later end wins", () => {
    const q = governor();
    q.recordLimit(limit("claude", "model", { model: "opus", resetsAt: clock.now() + 3 * HOUR }));
    q.recordLimit(limit("claude", "session", { resetsAt: clock.now() + HOUR }));
    expect(q.availableAt("claude", OPUS)).toBe(clock.now() + 3 * HOUR);
    expect(q.availableAt("claude", SONNET)).toBe(clock.now() + HOUR);
  });

  it("replaces an estimated model block with a reported reset, and never the other way round", () => {
    const q = governor();
    q.recordLimit(limit("claude", "model", { model: "opus" }));
    q.recordLimit(limit("claude", "model", { model: "opus", resetsAt: clock.now() + 2 * HOUR }));
    expect(q.snapshot().modelBlocks).toEqual({ "claude:opus": clock.now() + 2 * HOUR });
    q.recordLimit(limit("claude", "model", { model: "opus" }));
    expect(q.snapshot().modelBlocks).toEqual({ "claude:opus": clock.now() + 2 * HOUR });
  });

  it("expires lazily", async () => {
    const q = governor();
    q.recordLimit(limit("claude", "model", { model: "opus", resetsAt: clock.now() + HOUR }));
    await clock.advance(HOUR);
    expect(q.isAvailable("claude", OPUS)).toBe(true);
    expect(q.snapshot().modelBlocks).toEqual({});
  });
});

describe("QuotaGovernor: login failures", () => {
  it("blocks the provider with no known end, then lets a run check the login again after 30 minutes", async () => {
    const logger = recordingLogger();
    const q = governor({ logger });
    q.recordAuthFailure("codex", "401 Unauthorized");

    expect(q.isAvailable("codex")).toBe(false);
    expect(q.availableAt("codex", "gpt-6-astra")).toBeNull();
    expect(q.state("codex")).toEqual({ status: "auth", raw: "401 Unauthorized" });
    expect(q.isAvailable("claude")).toBe(true);
    expect(logger.lines[0]).toMatchObject({ level: "warn", msg: expect.stringContaining("codex needs a new login") });

    await clock.advance(30 * MIN - 1);
    expect(q.availableAt("codex")).toBeNull();
    await clock.advance(1);
    expect(q.isAvailable("codex")).toBe(true);
    expect(q.state("codex")).toEqual({ status: "ok" });
  });

  it("is cleared at once by clearAuth", () => {
    const q = governor();
    q.recordAuthFailure("codex", "401");
    q.clearAuth("codex");
    expect(q.isAvailable("codex")).toBe(true);
    expect(q.state("codex")).toEqual({ status: "ok" });
  });

  it("takes precedence over usage limits", () => {
    const q = governor();
    q.recordLimit(limit("claude", "session"));
    q.recordAuthFailure("claude", "not logged in");
    expect(q.state("claude")).toEqual({ status: "auth", raw: "not logged in" });
    expect(q.availableAt("claude")).toBeNull();
    q.clearAuth("claude");
    expect(q.state("claude")).toMatchObject({ status: "limited", kind: "session" });
  });
});

describe("QuotaGovernor: CLI failures", () => {
  it("rests a provider whose CLI failed for 60 s, 120 s, 240 s… capped at 15 min, until a run succeeds", async () => {
    const logger = recordingLogger();
    const q = governor({ logger });
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      q.recordFailure("codex", "codex exited with code 1: unknown option");
      const until = q.availableAt("codex", "gpt-6.1-sol") ?? 0;
      waits.push((until - clock.now()) / MIN);
      await clock.advance(until - clock.now());
    }
    expect(waits).toEqual([1, 2, 4, 8, 15, 15]);
    expect(logger.lines[0]).toMatchObject({ level: "warn", msg: expect.stringContaining("codex failed for a reason outside the job") });

    q.recordFailure("codex", "boom");
    expect(q.state("codex")).toEqual({ status: "failing", until: clock.now() + 15 * MIN, raw: "boom" });
    expect(q.isAvailable("codex")).toBe(false);
    expect(q.isAvailable("claude")).toBe(true);
    // The streak outlasts the backoff, so a caller can tell a CLI that keeps failing from one resting after a blip.
    await clock.advance(15 * MIN);
    expect(q.state("codex")).toEqual({ status: "ok" });
    expect(q.failureStreak("codex")).toEqual({ count: 7, raw: "boom" });
    expect(q.failureStreak("claude")).toBeUndefined();
    q.recordSuccess("codex");
    expect(q.state("codex")).toEqual({ status: "ok" });
    expect(q.failureStreak("codex")).toBeUndefined();
    q.recordFailure("codex", "boom");
    expect(q.availableAt("codex")).toBe(clock.now() + MIN); // the streak started over
  });

  it("reports the block that ends later, a usage limit or a failure", () => {
    const q = governor();
    q.recordFailure("claude", "crash");
    expect(q.state("claude")).toMatchObject({ status: "failing" });
    q.recordLimit(limit("claude", "session", { resetsAt: clock.now() + HOUR }));
    expect(q.state("claude")).toMatchObject({ status: "limited", kind: "session" });
    expect(q.availableAt("claude")).toBe(clock.now() + HOUR);
    expect(q.snapshot().providers.claude).toMatchObject({ status: "limited" });
  });

  it("does not persist CLI failures, so a restart after a fix tries again", () => {
    const statePath = join(tmp, "quota.json");
    governor({ statePath }).recordFailure("codex", "crash");
    expect(governor({ statePath }).state("codex")).toEqual({ status: "ok" });
  });
});

describe("QuotaGovernor: codex per-model usage limit", () => {
  it("blocks only the model codex names, so its other model keeps working", () => {
    const q = governor();
    const now = Date.UTC(2026, 9, 10, 12, 0);
    const info = detectLimitText(
      "You’ve hit your usage limit for GPT-6-Astra. Switch to another model now, or try again at Oct 13th, 2026 4:38 AM.",
      "codex",
      now,
    );
    expect(info).toMatchObject({ kind: "model", model: "gpt-6-astra" });
    q.recordLimit({ ...(info as LimitInfo), resetsAt: clock.now() + 2 * DAY });
    expect(q.isAvailable("codex", "gpt-6-astra")).toBe(false);
    expect(q.isAvailable("codex", "gpt-6.1-sol")).toBe(true);
    expect(q.state("codex")).toEqual({ status: "ok" });
    expect(Object.keys(q.snapshot().modelBlocks)).toEqual(["codex:gpt-6-astra"]);
  });
});

describe("QuotaGovernor: pacing by utilization", () => {
  it("pauses a provider whose five-hour window is at the cap until that window resets", async () => {
    const q = governor();
    const resetsAt = clock.now() + 2 * HOUR;
    q.recordUtilization({ provider: "claude", window: "five_hour", utilization: 0.97, resetsAt });

    expect(q.isAvailable("claude", SONNET)).toBe(false);
    expect(q.availableAt("claude")).toBe(resetsAt);
    expect(q.state("claude")).toMatchObject({ status: "limited", kind: "session", until: resetsAt });
    expect(q.isAvailable("codex")).toBe(true);

    await clock.advance(2 * HOUR);
    expect(q.isAvailable("claude")).toBe(true);
    expect(q.snapshot().utilization).toEqual([]);
  });

  it("pauses on the weekly window at its own cap", () => {
    const q = governor();
    const resetsAt = clock.now() + 3 * 24 * HOUR;
    q.recordUtilization({ provider: "claude", window: "seven_day", utilization: 0.84, resetsAt });
    expect(q.isAvailable("claude")).toBe(true);
    q.recordUtilization({ provider: "claude", window: "seven_day", utilization: 0.85, resetsAt });
    expect(q.state("claude")).toMatchObject({ status: "limited", kind: "weekly", until: resetsAt });
  });

  it("stays available below the caps and ignores other windows", () => {
    const q = governor();
    const resetsAt = clock.now() + HOUR;
    q.recordUtilization({ provider: "claude", window: "five_hour", utilization: 0.96, resetsAt });
    q.recordUtilization({ provider: "claude", window: "seven_day_opus", utilization: 1.2, resetsAt });
    expect(q.isAvailable("claude", OPUS)).toBe(true);
  });

  it("uses the latest reading of a window", () => {
    const q = governor();
    const resetsAt = clock.now() + HOUR;
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 0.99, resetsAt });
    expect(q.isAvailable("codex")).toBe(false);
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 0.1, resetsAt });
    expect(q.isAvailable("codex")).toBe(true);
  });

  it("lets a reading without a reset time inherit the window's known reset", () => {
    const q = governor();
    const resetsAt = clock.now() + HOUR;
    q.recordUtilization({ provider: "claude", window: "five_hour", utilization: 0.5, resetsAt });
    q.recordUtilization({ provider: "claude", window: "five_hour", utilization: 0.99 });
    expect(q.availableAt("claude")).toBe(resetsAt);
  });

  it("treats an implausible window reset (e.g. seconds read as ms) as no reset time", () => {
    const q = governor();
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 1, resetsAt: clock.now() * 1000 });
    expect(q.isAvailable("codex")).toBe(true);
    expect(q.snapshot().utilization).toEqual([{ provider: "codex", window: "five_hour", utilization: 1 }]);
  });

  it("does not pace on a reading with no reset time at all", () => {
    const q = governor();
    q.recordUtilization({ provider: "claude", window: "five_hour", utilization: 1 });
    expect(q.isAvailable("claude")).toBe(true);
    expect(q.snapshot().utilization).toEqual([{ provider: "claude", window: "five_hour", utilization: 1 }]);
  });

  it("follows the configured caps", () => {
    config.pacing.maxFiveHourUtilization = 0.5;
    const q = governor();
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 0.6, resetsAt: clock.now() + HOUR });
    expect(q.isAvailable("codex")).toBe(false);
  });

  describe("a night's share of the weekly window", () => {
    const weekly = (utilization: number, resetsAt: number) => ({ provider: "claude" as const, window: "seven_day", utilization, resetsAt });

    beforeEach(() => {
      config.pacing.maxWeeklyUtilization = 1.5; // only the per-night share is under test
    });

    it("pauses a provider once this night has used its share, until the weekly reset", () => {
      const q = governor();
      const resetsAt = clock.now() + 3 * DAY;
      q.recordUtilization(weekly(0.2, resetsAt));
      q.recordUtilization(weekly(0.54, resetsAt));
      expect(q.isAvailable("claude")).toBe(true);
      q.recordUtilization(weekly(0.55, resetsAt));
      expect(q.isAvailable("claude")).toBe(false);
      expect(q.state("claude")).toMatchObject({ status: "limited", kind: "weekly", until: resetsAt });
      expect((q.state("claude") as { raw: string }).raw).toContain("this run's work used 35% of the weekly limit");
      expect(q.isAvailable("codex")).toBe(true);
    });

    it("counts from this night run's first reading, not from a reading an earlier run saved", () => {
      const statePath = join(tmp, "quota.json");
      const resetsAt = clock.now() + 3 * DAY;
      governor({ statePath }).recordUtilization(weekly(0.1, resetsAt)); // an earlier night
      const q = governor({ statePath });
      q.recordUtilization(weekly(0.4, resetsAt)); // the day's own use came in between
      expect(q.isAvailable("claude")).toBe(true);
      q.recordUtilization(weekly(0.74, resetsAt));
      expect(q.isAvailable("claude")).toBe(true);
      q.recordUtilization(weekly(0.75, resetsAt));
      expect(q.isAvailable("claude")).toBe(false);
    });

    it("counts afresh when the weekly window resets during the night", async () => {
      const q = governor();
      q.recordUtilization(weekly(0.6, clock.now() + HOUR));
      await clock.advance(HOUR);
      const next = clock.now() + 7 * DAY;
      q.recordUtilization(weekly(0.05, next));
      q.recordUtilization(weekly(0.39, next));
      expect(q.isAvailable("claude")).toBe(true);
      q.recordUtilization(weekly(0.4, next));
      expect(q.availableAt("claude")).toBe(next);
    });

    it("follows the configured share, and can be switched off", () => {
      config.pacing.maxWeeklySharePerNight = 0.1;
      const q = governor();
      const resetsAt = clock.now() + DAY;
      q.recordUtilization(weekly(0.3, resetsAt));
      q.recordUtilization(weekly(0.4, resetsAt));
      expect(q.isAvailable("claude")).toBe(false);

      delete config.pacing.maxWeeklySharePerNight;
      const unlimited = governor();
      unlimited.recordUtilization(weekly(0.1, resetsAt));
      unlimited.recordUtilization(weekly(1.2, resetsAt));
      expect(unlimited.isAvailable("claude")).toBe(true);
    });

    it("logs once when the night's share is used up", () => {
      const logger = recordingLogger();
      const q = governor({ logger });
      const resetsAt = clock.now() + DAY;
      for (const used of [0.1, 0.3, 0.46, 0.5]) q.recordUtilization(weekly(used, resetsAt));
      expect(logger.lines.map((l) => l.msg)).toEqual([expect.stringContaining("pausing new work on claude")]);
    });
  });

  it("logs once when pacing starts", () => {
    const logger = recordingLogger();
    const q = governor({ logger });
    const resetsAt = clock.now() + HOUR;
    q.recordUtilization({ provider: "claude", window: "five_hour", utilization: 0.5, resetsAt });
    q.recordUtilization({ provider: "claude", window: "five_hour", utilization: 0.98, resetsAt });
    q.recordUtilization({ provider: "claude", window: "five_hour", utilization: 0.99, resetsAt });
    expect(logger.lines.map((l) => l.msg)).toEqual([expect.stringContaining("pausing new work on claude")]);
  });

  it("reports the latest readings in the snapshot", () => {
    const q = governor();
    const resetsAt = clock.now() + HOUR;
    q.recordUtilization({ provider: "claude", window: "five_hour", utilization: 0.4, resetsAt });
    q.recordUtilization({ provider: "claude", window: "five_hour", utilization: 0.5, resetsAt });
    q.recordUtilization({ provider: "claude", window: "seven_day", utilization: 0.2, resetsAt: resetsAt + 24 * HOUR });
    expect(q.snapshot().utilization).toEqual([
      { provider: "claude", window: "five_hour", utilization: 0.5, resetsAt },
      { provider: "claude", window: "seven_day", utilization: 0.2, resetsAt: resetsAt + 24 * HOUR },
    ]);
  });
});

describe("QuotaGovernor: snapshot", () => {
  it("reports every provider's state, active model blocks and readings", () => {
    const q = governor();
    const t = clock.now();
    q.recordLimit(limit("codex", "session", { resetsAt: t + HOUR, raw: "usage limit" }));
    q.recordLimit(limit("claude", "model", { model: "opus", resetsAt: t + 2 * HOUR }));
    q.recordAuthFailure("mock", "no login");
    expect(q.snapshot()).toEqual({
      providers: {
        claude: { status: "ok" },
        codex: { status: "limited", kind: "session", until: t + HOUR, raw: "usage limit" },
        mock: { status: "auth", raw: "no login" },
      },
      modelBlocks: { "claude:opus": t + 2 * HOUR },
      utilization: [],
    });
  });

  it("includes providers named only by the config", () => {
    config.families.codex.provider = "mock";
    expect(Object.keys(governor().snapshot().providers).sort()).toEqual(["claude", "mock"]);
  });
});

describe("QuotaGovernor: persistence", () => {
  it("remembers limits, model blocks and pacing across instances", () => {
    const statePath = join(tmp, "quota.json");
    const t = clock.now();
    const first = governor({ statePath });
    first.recordLimit(limit("codex", "weekly", { resetsAt: t + 30 * HOUR, raw: "weekly" }));
    first.recordLimit(limit("claude", "model", { model: "opus", resetsAt: t + 5 * HOUR, raw: "opus" }));
    first.recordUtilization({ provider: "claude", window: "five_hour", utilization: 0.99, resetsAt: t + 2 * HOUR });

    const second = governor({ statePath });
    expect(second.state("codex")).toEqual({ status: "limited", kind: "weekly", until: t + 30 * HOUR, raw: "weekly" });
    expect(second.availableAt("claude", OPUS)).toBe(t + 5 * HOUR);
    expect(second.availableAt("claude", SONNET)).toBe(t + 2 * HOUR);
    expect(second.snapshot()).toEqual(first.snapshot());
  });

  it("does not restore what has expired by the time it starts", async () => {
    const statePath = join(tmp, "quota.json");
    const first = governor({ statePath });
    first.recordLimit(limit("codex", "session", { resetsAt: clock.now() + HOUR }));
    first.recordLimit(limit("claude", "model", { model: "opus", resetsAt: clock.now() + HOUR }));
    first.recordUtilization({ provider: "claude", window: "seven_day", utilization: 1, resetsAt: clock.now() + HOUR });
    first.recordLimit(limit("claude", "spend", { resetsAt: clock.now() + 3 * HOUR }));

    await clock.advance(2 * HOUR);
    const second = governor({ statePath });
    expect(second.snapshot()).toEqual({
      providers: { claude: { status: "limited", kind: "spend", until: clock.now() + HOUR, raw: "spend limit" }, codex: { status: "ok" } },
      modelBlocks: {},
      utilization: [],
      observations: [{ provider: "claude", window: "seven_day", utilization: 1, resetsAt: clock.now() - HOUR, receivedAt: clock.now() - 2 * HOUR, resetState: "reported" }],
    });
  });

  it("restores a throttle cooldown but starts a new backoff streak", async () => {
    const statePath = join(tmp, "quota.json");
    const first = governor({ statePath });
    first.recordLimit(limit("codex", "throttle"));
    first.recordLimit(limit("codex", "throttle"));

    const second = governor({ statePath });
    expect(second.availableAt("codex")).toBe(clock.now() + 2 * MIN);
    await clock.advance(2 * MIN);
    second.recordLimit(limit("codex", "throttle"));
    expect(second.availableAt("codex")).toBe(clock.now() + MIN);
    // The first instance's streak goes on: it would back off 4 min.
    first.recordLimit(limit("codex", "throttle"));
    expect(first.availableAt("codex")).toBe(clock.now() + 4 * MIN);
  });

  it("remembers that a limit's end was only estimated", () => {
    const statePath = join(tmp, "quota.json");
    governor({ statePath }).recordLimit(limit("claude", "session"));
    const second = governor({ statePath });
    second.recordLimit(limit("claude", "session", { resetsAt: clock.now() + 10 * MIN }));
    expect(second.availableAt("claude")).toBe(clock.now() + 10 * MIN);
  });

  it("drops restored entries that end implausibly far ahead", () => {
    const statePath = join(tmp, "quota.json");
    const t = clock.now();
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        limits: { claude: { kind: "weekly", until: t + 363 * DAY, raw: "misread" }, codex: { kind: "spend", until: t + 20 * DAY, raw: "monthly" } },
        modelBlocks: [{ provider: "claude", model: "opus", until: t + 30 * DAY, raw: "misread" }],
        utilization: [{ provider: "claude", window: "seven_day", utilization: 1, resetsAt: t * 1000 }],
      }),
    );
    expect(governor({ statePath }).snapshot()).toEqual({
      providers: { claude: { status: "ok" }, codex: { status: "limited", kind: "spend", until: t + 20 * DAY, raw: "monthly" } },
      modelBlocks: {},
      utilization: [],
      observations: [{ provider: "claude", window: "seven_day", utilization: 1, resetsAt: t * 1000, resetState: "reported" }],
    });
  });

  it("does not persist login failures, so a restart after logging in tries again", () => {
    const statePath = join(tmp, "quota.json");
    const first = governor({ statePath });
    first.recordAuthFailure("codex", "401");
    first.recordLimit(limit("claude", "session"));
    expect(governor({ statePath }).state("codex")).toEqual({ status: "ok" });
  });

  it("saves a readable JSON file after each change", () => {
    const statePath = join(tmp, "nested", "quota.json");
    const q = governor({ statePath });
    q.recordLimit(limit("codex", "session", { resetsAt: clock.now() + HOUR, raw: "r" }));
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    expect(saved).toMatchObject({ version: 1, limits: { codex: { kind: "session", until: clock.now() + HOUR, raw: "r" } } });
  });

  it("starts fresh, with a warning, from a corrupt file", () => {
    const statePath = join(tmp, "quota.json");
    writeFileSync(statePath, "{not json");
    const logger = recordingLogger();
    const q = governor({ statePath, logger });
    expect(q.isAvailable("claude")).toBe(true);
    expect(logger.lines).toEqual([{ level: "warn", msg: expect.stringContaining("ignoring unreadable quota state") }]);
    q.recordLimit(limit("claude", "session"));
    expect(governor({ statePath }).state("claude")).toMatchObject({ status: "limited" });
  });

  it("skips malformed entries and keeps valid ones", () => {
    const statePath = join(tmp, "quota.json");
    const until = clock.now() + HOUR;
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        limits: { claude: { kind: "bogus", until, raw: "" }, codex: { kind: "session", until, raw: "ok" }, other: { kind: "session", until, raw: "" } },
        modelBlocks: [{ provider: "claude", model: "", until, raw: "" }, { provider: "claude", model: "Opus", until, raw: "x" }, "junk"],
        utilization: [{ provider: "claude", window: "five_hour", utilization: "high", resetsAt: until }, null],
      }),
    );
    const q = governor({ statePath });
    expect(q.snapshot()).toEqual({
      providers: { claude: { status: "ok" }, codex: { status: "limited", kind: "session", until, raw: "ok" } },
      modelBlocks: { "claude:opus": until },
      utilization: [],
      observations: [{ provider: "claude", window: "five_hour", utilization: null, resetsAt: until, resetState: "reported" }],
    });
  });

  it("keeps working in memory when the state file cannot be written", () => {
    const statePath = join(tmp, "is-a-dir");
    mkdirSync(statePath);
    const logger = recordingLogger();
    const q = governor({ statePath, logger });
    q.recordLimit(limit("codex", "session"));
    expect(q.isAvailable("codex")).toBe(false);
    expect(logger.lines.some((l) => l.level === "warn" && l.msg.includes("could not save quota state"))).toBe(true);
  });
});

describe("QuotaGovernor: malformed latest observation", () => {
  it("does not let a supplied malformed reset borrow the previous reset and release its live cap", () => {
    const q = governor();
    const resetsAt = clock.now() + HOUR;
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 0.99, resetsAt });
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 0.1, resetsAt: Number.NaN });
    expect(q.availableAt("codex")).toBe(resetsAt);
  });
  it("does not let a malformed numeric usage release a live cap", () => {
    const q = governor();
    const resetsAt = clock.now() + HOUR;
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 0.99, resetsAt });
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: -1, resetsAt });
    expect(q.availableAt("codex")).toBe(resetsAt);
  });
});

describe("QuotaGovernor: controller allowance evidence", () => {
  const input = (window: string, utilization: unknown, resetsAt: number) => ({ window, utilization, reset: { kind: "supplied" as const, value: resetsAt } });
  it("stamps controller receipt and refreshes identical readings in persisted state", async () => {
    const statePath = join(tmp, "quota.json");
    const q = governor({ statePath });
    const resetsAt = clock.now() + HOUR;
    const first = clock.now();
    q.recordAllowanceBatch("codex", [input("five_hour", 0.2, resetsAt), input("seven_day", 0.2, resetsAt)]);
    expect(q.allowance("codex").usable).toBe(true);
    expect(q.snapshot().observations?.[0]?.receivedAt).toBe(first);
    await clock.advance(MIN);
    q.recordAllowanceBatch("codex", [input("five_hour", 0.2, resetsAt), input("seven_day", 0.2, resetsAt)]);
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    expect(saved.observations.every((r: { receivedAt: number }) => r.receivedAt === clock.now())).toBe(true);
    expect(governor({ statePath }).allowance("codex").usable).toBe(true);
  });
  it("ignores receipt fields supplied through old utilization input", () => {
    const q = governor();
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 0.2, resetsAt: clock.now() + HOUR, receivedAt: clock.now() + HOUR } as Parameters<QuotaGovernor["recordUtilization"]>[0]);
    expect(q.snapshot().observations?.[0]?.receivedAt).toBe(clock.now());
  });
  it("restores original receipt without refreshing stale data and detects rollback", async () => {
    const statePath = join(tmp, "quota.json");
    const q = governor({ statePath });
    const at = clock.now();
    q.recordAllowanceBatch("codex", [input("five_hour", 0.2, at + HOUR), input("seven_day", 0.2, at + HOUR)]);
    await clock.advance(10 * MIN + 1);
    const restored = governor({ statePath });
    expect(restored.allowance("codex").windows[0]?.reasons).toContain("stale");
    expect(restored.snapshot().observations?.[0]?.receivedAt).toBe(at);
    const rollback = new QuotaGovernor({ config, clock: new FakeClock(at - 1), statePath });
    expect(rollback.allowance("codex").windows[0]?.reasons).toContain("clock_rollback");
  });
  it("keeps expired observation reasons while removing the old block", async () => {
    const q = governor();
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 0.99, resetsAt: clock.now() + MIN });
    await clock.advance(MIN);
    expect(q.isAvailable("codex")).toBe(true);
    expect(q.allowance("codex").windows[0]?.reasons).toContain("expired");
    expect(q.snapshot().utilization).toEqual([]);
  });
  it("preserves malformed and reset-less observations in JSON without coercion", () => {
    const statePath = join(tmp, "quota.json");
    const q = governor({ statePath });
    q.recordAllowanceBatch("codex", [
      { window: "five_hour", utilization: "synthetic-private", reset: { kind: "supplied", value: "synthetic-private-reset" } },
      { window: "seven_day", utilization: 0.2, reset: { kind: "omitted" } },
    ]);
    const json = readFileSync(statePath, "utf8");
    expect(json).not.toContain("synthetic-private");
    const restored = governor({ statePath });
    expect(restored.allowance("codex").windows[0]?.reasons).toContain("malformed_utilization");
    expect(restored.allowance("codex").windows[1]?.reasons).toContain("reset_missing");
    expect(restored.snapshot().observations?.find((r) => r.window === "five_hour")?.utilization).toBeNull();
  });
  it("marks live duplicate metadata unknown while retaining its valid high restriction", () => {
    const q = governor();
    const until = clock.now() + HOUR;
    q.recordAllowanceBatch("codex", [input("five_hour", 0.99, until), input("five_hour", 0.01, until), input("seven_day", 0.1, until)]);
    expect(q.allowance("codex").windows[0]?.reasons).toContain("ambiguous");
    expect(q.availableAt("codex")).toBe(until);
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 0.1, resetsAt: until });
    expect(q.allowance("codex").usable).toBe(true);
    expect(q.isAvailable("codex")).toBe(true);
  });
  it("retains non-dominated legacy constraints across restart without inventing a combined row", () => {
    const statePath = join(tmp, "quota.json");
    const now = clock.now();
    writeFileSync(statePath, JSON.stringify({ version: 1, utilization: [
      { provider: "codex", window: "five_hour", utilization: 0.99, resetsAt: now + HOUR },
      { provider: "codex", window: "five_hour", utilization: 0.98, resetsAt: now + 2 * HOUR },
      { provider: "codex", window: "five_hour", utilization: 0.1, resetsAt: now + 3 * HOUR },
      { provider: "codex", window: "five_hour", utilization: "bad", resetsAt: now + 4 * HOUR },
    ] }));
    const q = governor({ statePath });
    expect(q.availableAt("codex")).toBe(now + 2 * HOUR);
    expect(q.allowance("codex").windows[0]?.reasons).toContain("ambiguous");
    q.recordLimit(limit("claude", "session"));
    const rows = JSON.parse(readFileSync(statePath, "utf8")).utilization;
    expect(rows).not.toContainEqual(expect.objectContaining({ utilization: 0.99, resetsAt: now + 3 * HOUR }));
    config.pacing.maxFiveHourUtilization = 0.985;
    expect(governor({ statePath }).availableAt("codex")).toBe(now + HOUR);
  });
  it("does not let unknown latest data lower the weekly-share baseline", () => {
    config.pacing.maxWeeklyUtilization = 1.5;
    const q = governor();
    const until = clock.now() + HOUR;
    q.recordUtilization({ provider: "codex", window: "seven_day", utilization: 0.2, resetsAt: until });
    q.recordUtilization({ provider: "codex", window: "seven_day", utilization: 0.1, resetsAt: Number.NaN });
    q.recordUtilization({ provider: "codex", window: "seven_day", utilization: 0.54, resetsAt: until });
    expect(q.isAvailable("codex")).toBe(true);
    q.recordUtilization({ provider: "codex", window: "seven_day", utilization: 0.55, resetsAt: until });
    expect(q.availableAt("codex")).toBe(until);
  });
  it("can strengthen an existing restriction without giving malformed-reset data usable credit", () => {
    const q = governor();
    const until = clock.now() + HOUR;
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 0.2, resetsAt: until });
    q.recordAllowance("codex", { window: "five_hour", utilization: 0.99, reset: { kind: "supplied", value: null } });
    expect(q.availableAt("codex")).toBe(until);
    expect(q.allowance("codex").windows[0]?.reasons).toContain("malformed_reset");
  });
  it("retains known hard-limit/auth rules even with both usable aggregate windows", () => {
    const q = governor();
    const until = clock.now() + HOUR;
    q.recordLimit(limit("codex", "weekly", { resetsAt: until }));
    q.recordAllowanceBatch("codex", [input("five_hour", 0.1, until), input("seven_day", 0.1, until)]);
    expect(q.allowance("codex").usable).toBe(true);
    expect(q.availableAt("codex")).toBe(until);
    q.recordAuthFailure("codex", "synthetic login failure");
    expect(q.availableAt("codex")).toBeNull();
  });
});

describe("QuotaGovernor: missing canonical observations cannot erase constraints", () => {
  it("retains a valid restored cap after an unrelated receipt when the new observation array is absent/corrupt", () => {
    const statePath = join(tmp, "quota.json");
    const until = clock.now() + HOUR;
    writeFileSync(statePath, JSON.stringify({ version: 1, observations: [], utilization: [{ provider: "codex", window: "five_hour", utilization: 0.99, resetsAt: until }] }));
    const q = governor({ statePath });
    expect(q.availableAt("codex")).toBe(until);
    q.recordUtilization({ provider: "claude", window: "seven_day", utilization: 0.1 });
    expect(q.availableAt("codex")).toBe(until);
    expect(q.allowance("codex").usable).toBe(false);
  });
});

describe("QuotaGovernor: restore bounds and invalid controller clock", () => {
  it("bounds numeric legacy keys while preserving both aggregates and model blocks", () => {
    const statePath = join(tmp, "quota.json");
    const until = clock.now() + HOUR;
    const rows = Array.from({ length: 90 }, (_, i) => ({ provider: "codex", window: "extra_" + i, utilization: 0.5, resetsAt: until }));
    rows.push({ provider: "codex", window: "five_hour", utilization: 0.99, resetsAt: until }, { provider: "codex", window: "seven_day", utilization: 0.2, resetsAt: until });
    writeFileSync(statePath, JSON.stringify({ version: 1, utilization: rows, modelBlocks: [{ provider: "claude", model: "opus", until, raw: "synthetic model limit" }] }));
    const q = governor({ statePath });
    expect(new Set(q.snapshot().utilization.map((r) => r.window)).size).toBe(64);
    expect(q.availableAt("codex")).toBe(until);
    expect(q.availableAt("claude", OPUS)).toBe(until);
    expect(q.snapshot().utilization.some((r) => r.window === "seven_day")).toBe(true);
  });
  it.each([Number.NaN, Infinity])("does not clear known constraints or refresh evidence while clock is %s", (invalidNow) => {
    const at = clock.now();
    let now = at;
    const q = new QuotaGovernor({ config, clock: { now: () => now, sleep: clock.sleep.bind(clock) } });
    q.recordUtilization({ provider: "codex", window: "five_hour", utilization: 0.99, resetsAt: at + HOUR });
    q.recordLimit(limit("claude", "session", { resetsAt: at + 2 * HOUR }));
    now = invalidNow;
    q.snapshot();
    q.recordAllowance("codex", { window: "five_hour", utilization: 0.1, reset: { kind: "supplied", value: null } });
    expect(q.snapshot().observations?.find((r) => r.window === "five_hour")?.receivedAt).toBeNull();
    now = at;
    expect(q.availableAt("codex")).toBe(at + HOUR);
    expect(q.availableAt("claude")).toBe(at + 2 * HOUR);
    expect(q.allowance("codex").usable).toBe(false);
  });
  it("treats oversized quota state as unavailable with a diagnostic, never a free reading", () => {
    const statePath = join(tmp, "quota.json");
    writeFileSync(statePath, JSON.stringify({ pad: "x".repeat(1024 * 1024), utilization: [{ provider: "codex", window: "five_hour", utilization: 0.1, resetsAt: clock.now() + HOUR }] }));
    const logger = recordingLogger();
    const q = governor({ statePath, logger });
    expect(q.allowance("codex").usable).toBe(false);
    expect(q.snapshot().utilization).toEqual([]);
    expect(logger.lines.some((line) => line.level === "warn" && /too large/.test(line.msg))).toBe(true);
  });
});

describe("QuotaGovernor: deferred restore time validation", () => {
  it("retains loaded constraints during invalid clock and validates their bounds once clock recovers", () => {
    const statePath = join(tmp, "quota.json");
    const at = clock.now();
    let now = Number.NaN;
    writeFileSync(statePath, JSON.stringify({ version: 1,
      limits: { claude: { kind: "session", until: at + HOUR, raw: "synthetic limit" } },
      utilization: [
        { provider: "codex", window: "five_hour", utilization: 0.99, resetsAt: at + HOUR },
        { provider: "codex", window: "seven_day", utilization: 0.99, resetsAt: at + 40 * DAY },
      ],
    }));
    const q = new QuotaGovernor({ config, statePath, clock: { now: () => now, sleep: clock.sleep.bind(clock) } });
    expect(q.allowance("codex").usable).toBe(false);
    now = at;
    expect(q.availableAt("codex")).toBe(at + HOUR);
    expect(q.availableAt("claude")).toBe(at + HOUR);
    expect(q.snapshot().utilization.some((row) => row.resetsAt === at + 40 * DAY)).toBe(false);
  });
});
