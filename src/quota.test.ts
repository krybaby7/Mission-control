import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
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
