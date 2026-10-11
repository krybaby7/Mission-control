// T-ALLOW: the allowance rows, pills, blocks and notes (docs/dashboard-spec.md, section 10).
import { describe, expect, it } from "vitest";
import { copyHome, emptyHome, FIXTURE_MTIME_MS, makeEvent, makeFeature, makeMission, withLock, writeMission } from "../../test/dashboard-helpers.js";
import { buildAllowance } from "./allowance.js";
import { WAIT_MARGIN_MS } from "./constants.js";
import { readHome, type QuotaData } from "./read.js";
import { builtInSettings, buildSnapshot, type DashboardSettings } from "./snapshot.js";
import type { Allowance, ProviderAllowance, WaitInfo } from "./types.js";
import { makeFormatter } from "./vocabulary.js";

const f = makeFormatter("UTC");
/** The default clock of the mid-run scenarios (spec 14.3). */
const NOW = Date.parse("2026-10-11T09:58:30.000Z");
const at = (iso: string): number => Date.parse(iso);
const settings = builtInSettings();

const empty: QuotaData = { limits: [], modelBlocks: [], utilization: [] };
function quota(o: Partial<QuotaData>): QuotaData {
  return { ...empty, ...o };
}
const reading = (provider: string, window: string, utilization: number, resetsAt: string) => ({ provider, window, utilization, resetsAt: at(resetsAt) });

function build(q: QuotaData | null, o: { mtime?: number | null; wait?: WaitInfo | null; now?: number; settings?: DashboardSettings } = {}): Allowance {
  return buildAllowance(q, o.mtime === undefined ? FIXTURE_MTIME_MS : o.mtime, o.settings ?? settings, o.wait ?? null, o.now ?? NOW, f);
}

function row(a: Allowance, id: string): ProviderAllowance {
  const found = a.providers.find((p) => p.id === id);
  if (found === undefined) throw new Error(`no row for ${id}: ${a.providers.map((p) => p.id).join(", ")}`);
  return found;
}

const RESET_TODAY = "2026-10-11T12:20:00.000Z";
const RESET_THU = "2026-10-15T09:00:00.000Z";

describe("T-ALLOW rows and the missing file", () => {
  it("without a usage file Claude and Codex both say there is no reading yet", () => {
    const a = build(null, { mtime: null });
    expect(a.providers.map((p) => [p.id, p.label, p.pill.state, p.pill.word, p.note, p.windows])).toEqual([
      ["claude", "Claude", "no_reading", "No reading yet", "No usage reading yet.", []],
      ["codex", "Codex", "no_reading", "No reading yet", "No usage reading yet.", []],
    ]);
    expect(a.fileChangedAt).toBeNull();
    expect(a.fileChangedText).toBeNull();
    expect(a.waiting).toBeNull();
    expect(a.providers.every((p) => p.limitedUntil === null && p.limitedText === null)).toBe(true);
  });

  it("a file that could not be read counts as absent even when it has a time", () => {
    const a = build(null, { mtime: FIXTURE_MTIME_MS });
    expect(a.fileChangedAt).toBeNull();
    expect(a.fileChangedText).toBeNull();
  });

  it("the time of the file is worded as when the figures last changed, never as of", () => {
    const a = build(empty, { mtime: at("2026-10-11T01:38:12.000Z") });
    expect(a.fileChangedAt).toBe(at("2026-10-11T01:38:12.000Z"));
    expect(a.fileChangedText).toBe("Usage figures last changed at 01:38");
  });

  // M3: quota.json can be days old, and "last changed at 01:38" would read as this morning.
  it("the time of the file follows the one time rule: a file changed on another day names the weekday", () => {
    expect(build(empty, { mtime: at("2026-10-11T00:00:00.000Z") }).fileChangedText).toBe("Usage figures last changed at 00:00");
    expect(build(empty, { mtime: at("2026-10-10T23:59:59.000Z") }).fileChangedText).toBe("Usage figures last changed at Sat 23:59");
    expect(build(empty, { mtime: at("2026-10-08T01:38:12.000Z") }).fileChangedText).toBe("Usage figures last changed at Thu 01:38");
    // A time in the future of the snapshot (a clock that is off) is worded by the same rule.
    expect(build(empty, { mtime: at("2026-10-12T01:38:12.000Z") }).fileChangedText).toBe("Usage figures last changed at Mon 01:38");
  });

  it("a provider other than the configured ones gets a row, and the Test AI has its own name", () => {
    const a = build(quota({ utilization: [reading("mock", "five_hour", 0.1, RESET_TODAY)], limits: [{ provider: "zeta", kind: "weekly", until: at(RESET_THU) }] }));
    expect(a.providers.map((p) => [p.id, p.label])).toEqual([
      ["claude", "Claude"],
      ["codex", "Codex"],
      ["zeta", "zeta"],
      ["mock", "Test AI"],
    ]);
  });

  it("the rows follow the configured providers", () => {
    const only: DashboardSettings = { ...settings, providers: ["claude"] };
    expect(build(null, { settings: only }).providers.map((p) => p.id)).toEqual(["claude"]);
  });

  it("a provider id is cleaned and capped before it is shown", () => {
    const hostile = `evil‮\u0007${"x".repeat(200)}`;
    const a = build(quota({ utilization: [reading(hostile, "five_hour", 0.2, RESET_TODAY)] }));
    const extra = a.providers[2];
    expect(extra).toBeDefined();
    expect(extra?.id).not.toMatch(/[‮\u0007]/);
    expect(extra?.id.length).toBeLessThanOrEqual(80);
    expect(extra?.label).toBe(extra?.id);
  });

  it("the banner copies only the fields of a WaitInfo", () => {
    const wait = { until: at("2026-10-11T12:59:10.000Z"), untilText: "12:59", cause: "limits" as const, text: "Waiting for allowance until 12:59. It resumes by itself.", loginAis: ["Claude"] };
    const a = build(null, { wait });
    expect(a.waiting).toEqual({ until: wait.until, untilText: "12:59", cause: "limits", text: wait.text });
    expect(Object.keys(a.waiting ?? {})).not.toContain("loginAis");
  });
});

describe("T-ALLOW windows", () => {
  it("one entry per valid reading with the percent, the fill and the reset", () => {
    const a = build(quota({ utilization: [reading("claude", "five_hour", 0.62, RESET_TODAY), reading("claude", "seven_day", 0.41, RESET_THU)] }));
    const claude = row(a, "claude");
    expect(claude.windows).toEqual([
      {
        id: "five_hour",
        label: "Next 5 hours",
        usedFraction: 0.62,
        usedPercent: 62,
        fill: 0.62,
        overage: false,
        resetsAt: at(RESET_TODAY),
        resetsText: "resets 12:20",
        pauseAt: 0.97,
        text: "62% used, resets 12:20",
      },
      {
        id: "seven_day",
        label: "This week",
        usedFraction: 0.41,
        usedPercent: 41,
        fill: 0.41,
        overage: false,
        resetsAt: at(RESET_THU),
        resetsText: "resets Thu 09:00",
        pauseAt: 0.85,
        text: "41% used, resets Thu 09:00",
      },
    ]);
    expect(claude.pill).toEqual({ state: "plenty", word: "Plenty" });
    expect(claude.note).toBeNull();
    expect(claude.limitedUntil).toBeNull();
  });

  it("the pause caps follow the settings", () => {
    const custom: DashboardSettings = { ...settings, pacing: { maxFiveHourUtilization: 0.5, maxWeeklyUtilization: 0.6 } };
    const a = build(quota({ utilization: [reading("claude", "five_hour", 0.4, RESET_TODAY), reading("claude", "seven_day", 0.3, RESET_THU), reading("claude", "240_minutes", 0.3, RESET_TODAY)] }), { settings: custom });
    expect(row(a, "claude").windows.map((w) => [w.id, w.pauseAt])).toEqual([
      ["five_hour", 0.5],
      ["seven_day", 0.6],
      ["240_minutes", null],
    ]);
  });

  it("the rows are ordered five_hour, seven_day, then the rest by name", () => {
    const a = build(
      quota({
        utilization: [reading("claude", "seven_day_opus", 0.1, RESET_THU), reading("claude", "seven_day", 0.1, RESET_THU), reading("claude", "180_minutes", 0.1, RESET_TODAY), reading("claude", "five_hour", 0.1, RESET_TODAY)],
      }),
    );
    expect(row(a, "claude").windows.map((w) => w.id)).toEqual(["five_hour", "seven_day", "180_minutes", "seven_day_opus"]);
  });

  it("the same window twice: the later entry wins", () => {
    const a = build(quota({ utilization: [reading("claude", "five_hour", 0.2, RESET_TODAY), reading("claude", "five_hour", 0.3, RESET_TODAY)] }));
    expect(row(a, "claude").windows.map((w) => w.usedPercent)).toEqual([30]);
  });

  it.each([
    ["five_hour", "Next 5 hours"],
    ["seven_day", "This week"],
    ["seven_day_sonnet", "This week, one kind of model"],
    ["seven_day_opus", "This week, one kind of model"],
    ["60_minutes", "Next 1 hour"],
    ["120_minutes", "Next 2 hours"],
    ["300_minutes", "Next 5 hours"],
    ["90_minutes", "Next 90 minutes"],
    ["1_minutes", "Next 1 minute"],
    ["0_minutes", "Another limit"],
    ["monthly", "Another limit"],
  ])("the window %s is called %s and no model is named", (id, label) => {
    const a = build(quota({ utilization: [reading("claude", id, 0.1, RESET_TODAY)] }));
    expect(row(a, "claude").windows[0]?.label).toBe(label);
  });

  it("a reset on another day names the weekday, one today does not", () => {
    const a = build(quota({ utilization: [reading("claude", "five_hour", 0.1, "2026-10-11T23:59:00.000Z"), reading("claude", "seven_day", 0.1, "2026-10-12T00:01:00.000Z")] }));
    expect(row(a, "claude").windows.map((w) => w.resetsText)).toEqual(["resets 23:59", "resets Mon 00:01"]);
  });

  it("a reading that already reset is dropped, and so is any invalid entry", () => {
    const a = build(
      quota({
        utilization: [
          reading("claude", "five_hour", 0.95, "2026-10-11T08:00:00.000Z"),
          reading("claude", "seven_day", 0.3, RESET_THU),
          { provider: "claude", window: "", utilization: 0.2, resetsAt: at(RESET_THU) },
          { provider: "claude", window: "x_a", utilization: Number.NaN, resetsAt: at(RESET_THU) },
          { provider: "claude", window: "x_b", utilization: -0.1, resetsAt: at(RESET_THU) },
          { provider: "claude", window: "x_c", utilization: 0.2, resetsAt: Number.NaN },
          { provider: "claude", window: "x_d", utilization: 0.2, resetsAt: NOW },
        ],
      }),
    );
    expect(row(a, "claude").windows.map((w) => w.id)).toEqual(["seven_day"]);
  });

  it("a reading above 100 percent is an overage: the bar stops at full and the percent shows the truth", () => {
    const a = build(quota({ utilization: [reading("codex", "180_minutes", 1.2, RESET_TODAY)] }));
    const w = row(a, "codex").windows[0];
    expect(w).toMatchObject({ usedFraction: 1.2, usedPercent: 120, fill: 1, overage: true, label: "Next 3 hours", pauseAt: null });
    expect(row(a, "codex").pill.state).toBe("nearly_out");
  });
});

describe("T-ALLOW the pill", () => {
  const pillFor = (window: string, value: number, reset = RESET_TODAY) => row(build(quota({ utilization: [reading("claude", window, value, reset)] })), "claude").pill;

  it.each([
    [0.69, "plenty", "Plenty"],
    [0.7, "getting_low", "Getting low"],
    [0.89, "getting_low", "Getting low"],
    [0.9, "nearly_out", "Nearly out"],
    [0.96, "nearly_out", "Nearly out"],
  ])("a 5-hour reading of %s is %s", (value, state, word) => {
    expect(pillFor("five_hour", value)).toEqual({ state, word });
  });

  it.each([
    [0.969, "nearly_out"],
    [0.97, "waiting_reset"],
    [1, "waiting_reset"],
  ])("a 5-hour reading of %s is %s: the engine stops new work at 0.97", (value, state) => {
    expect(pillFor("five_hour", value).state).toBe(state);
  });

  it.each([
    [0.84, "getting_low"],
    [0.85, "waiting_reset"],
  ])("a weekly reading of %s is %s: the engine stops new work at 0.85", (value, state) => {
    expect(pillFor("seven_day", value, RESET_THU).state).toBe(state);
  });

  it("the highest window of a provider decides", () => {
    const a = build(quota({ utilization: [reading("claude", "five_hour", 0.1, RESET_TODAY), reading("claude", "seven_day", 0.8, RESET_THU)] }));
    expect(row(a, "claude").pill.state).toBe("getting_low");
  });

  it("a provider with no valid reading has no reading, even when another provider has one", () => {
    const a = build(quota({ utilization: [reading("codex", "seven_day", 0.18, RESET_THU)] }));
    expect(row(a, "claude").pill.state).toBe("no_reading");
    expect(row(a, "codex").pill.state).toBe("plenty");
  });
});

describe("T-ALLOW blocks, resume time and wording", () => {
  it("a paced window at its cap blocks the provider although the file has no limit entry (the weekly case)", () => {
    const a = build(quota({ utilization: [reading("claude", "seven_day", 0.9, "2026-10-15T08:59:15.000Z")] }));
    const claude = row(a, "claude");
    expect(claude.pill).toEqual({ state: "waiting_reset", word: "Waiting for reset" });
    expect(claude.limitedUntil).toBe(at("2026-10-15T08:59:15.000Z"));
    expect(claude.limitedText).toBe("Waiting for the weekly limit to reset. Work resumes Thu 09:00.");
  });

  it("a paced 5-hour window at its cap blocks too, and today's resume time says 'at'", () => {
    const a = build(quota({ utilization: [reading("claude", "five_hour", 0.98, "2026-10-11T12:58:25.000Z")] }));
    expect(row(a, "claude").limitedText).toBe("Waiting for the 5-hour limit to reset. Work resumes at 12:59.");
  });

  it("the resume time is the end plus the engine's margin, the same minute as the wait banner", () => {
    const end = at("2026-10-11T12:58:25.596Z");
    const a = build(quota({ limits: [{ provider: "codex", kind: "session", until: end }] }));
    const codex = row(a, "codex");
    expect(codex.limitedUntil).toBe(end);
    expect(codex.limitedText).toBe("Waiting for the 5-hour limit to reset. Work resumes at 12:59.");
    expect(WAIT_MARGIN_MS).toBe(45_000);
    // The minute can differ from the end's minute and must match the margin, not the end.
    const early = build(quota({ limits: [{ provider: "codex", kind: "session", until: at("2026-10-11T12:58:10.000Z") }] }));
    expect(row(early, "codex").limitedText).toContain("at 12:58.");
  });

  it.each([
    ["session", "Waiting for the 5-hour limit to reset. Work resumes at 12:59."],
    ["weekly", "Waiting for the weekly limit to reset. Work resumes at 12:59."],
    ["model", "Waiting for a model limit to reset. Work resumes at 12:59."],
    ["spend", "Waiting for the spending cap to reset. Work resumes at 12:59."],
    ["unknown", "Waiting for a usage limit to reset. Work resumes at 12:59."],
    ["something-new", "Waiting for a usage limit to reset. Work resumes at 12:59."],
    ["throttle", "Waiting because the service is busy. Work resumes at 12:59."],
  ])("a %s limit reads: %s", (kind, text) => {
    const a = build(quota({ limits: [{ provider: "claude", kind, until: at("2026-10-11T12:58:25.000Z") }] }));
    expect(row(a, "claude").limitedText).toBe(text);
    expect(row(a, "claude").pill.state).toBe("waiting_reset");
  });

  it("a limit that has ended is ignored", () => {
    const a = build(quota({ limits: [{ provider: "claude", kind: "session", until: NOW }, { provider: "codex", kind: "weekly", until: NOW - 1000 }] }));
    expect(a.providers.map((p) => p.limitedUntil)).toEqual([null, null]);
  });

  it("the block that ends last decides the wording", () => {
    const a = build(
      quota({
        limits: [{ provider: "claude", kind: "session", until: at("2026-10-11T12:58:25.000Z") }],
        utilization: [reading("claude", "seven_day", 0.9, "2026-10-15T08:59:15.000Z")],
      }),
    );
    const claude = row(a, "claude");
    expect(claude.limitedUntil).toBe(at("2026-10-15T08:59:15.000Z"));
    expect(claude.limitedText).toContain("weekly limit");
  });

  it("on a tie the kind of the limit entry wins over a pacing block", () => {
    const end = at("2026-10-11T12:58:25.000Z");
    const a = build(quota({ limits: [{ provider: "claude", kind: "model", until: end }], utilization: [reading("claude", "five_hour", 0.99, "2026-10-11T12:58:25.000Z")] }));
    expect(row(a, "claude").limitedText).toContain("a model limit");
  });

  it("only the provider that is blocked waits", () => {
    const a = build(quota({ limits: [{ provider: "claude", kind: "weekly", until: at("2026-10-14T18:30:00.000Z") }], utilization: [reading("codex", "five_hour", 0.3, RESET_TODAY)] }));
    expect(row(a, "claude").pill.state).toBe("waiting_reset");
    expect(row(a, "codex").pill.state).toBe("plenty");
  });
});

describe("T-ALLOW notes", () => {
  it("Codex without a 5-hour window says so, in a sentence", () => {
    const a = build(quota({ utilization: [reading("codex", "seven_day", 0.18, RESET_THU)] }));
    expect(row(a, "codex").note).toBe("No 5-hour limit reported.");
    expect(row(a, "codex").pill.state).toBe("plenty");
  });

  it("a provider with a 5-hour window has no note", () => {
    expect(row(build(quota({ utilization: [reading("claude", "five_hour", 0.2, RESET_TODAY)] })), "claude").note).toBeNull();
  });

  it("a model-specific block is mentioned without naming the model", () => {
    const a = build(quota({ modelBlocks: [{ provider: "codex", model: "gpt-6.1-sol", until: at("2026-10-11T11:15:00.000Z") }], utilization: [reading("codex", "five_hour", 0.3, RESET_TODAY)] }));
    expect(row(a, "codex").note).toBe("One kind of model is limited until 11:15.");
    expect(JSON.stringify(a)).not.toContain("gpt-6.1-sol");
    expect(row(a, "codex").pill.state).toBe("plenty");
  });

  it("a model block that ends on another day says the weekday (M3)", () => {
    const a = build(quota({ modelBlocks: [{ provider: "claude", model: "m", until: at("2026-10-14T15:26:00.000Z") }], utilization: [reading("claude", "five_hour", 0.2, RESET_TODAY)] }));
    expect(row(a, "claude").note).toBe("One kind of model is limited until Wed 15:26.");
  });

  it("the model sentence follows the first sentence that applies", () => {
    const a = build(quota({ modelBlocks: [{ provider: "claude", model: "m", until: at("2026-10-11T11:15:00.000Z") }] }));
    expect(row(a, "claude").note).toBe("No usage reading yet. One kind of model is limited until 11:15.");
  });

  it("a model block that has ended is ignored, and the latest of several is shown", () => {
    const a = build(
      quota({
        modelBlocks: [
          { provider: "claude", model: "a", until: NOW - 1 },
          { provider: "claude", model: "b", until: at("2026-10-11T10:30:00.000Z") },
          { provider: "claude", model: "c", until: at("2026-10-11T11:15:00.000Z") },
        ],
        utilization: [reading("claude", "five_hour", 0.2, RESET_TODAY)],
      }),
    );
    expect(row(a, "claude").note).toBe("One kind of model is limited until 11:15.");
  });
});

// m2: provider names, window ids and block kinds come from a file. A word that is also a member of Object.prototype must
// be an ordinary unknown word, not a function.
describe("T-ALLOW words that are also members of Object.prototype (m2)", () => {
  const WORDS = ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"];

  it.each(WORDS)("%s as a provider is an extra row named after itself, with no function text", (word) => {
    const a = build(quota({ limits: [{ provider: word, kind: "weekly", until: at(RESET_THU) }], utilization: [reading(word, "five_hour", 0.3, RESET_TODAY)] }));
    const extra = a.providers.find((p) => p.id === word);
    expect(extra?.label).toBe(word);
    expect(extra?.limitedText).toBe("Waiting for the weekly limit to reset. Work resumes Thu 09:00.");
    expect(JSON.stringify(a)).not.toMatch(/function|native code/);
  });

  it.each(WORDS)("%s as a block kind is a usage limit", (word) => {
    const a = build(quota({ limits: [{ provider: "claude", kind: word, until: at(RESET_THU) }] }));
    expect(row(a, "claude").limitedText).toBe("Waiting for a usage limit to reset. Work resumes Thu 09:00.");
  });

  it.each(WORDS)("%s as a window id is no paced window: it never blocks and has no pause mark", (word) => {
    const a = build(quota({ utilization: [reading("claude", word, 0.99, RESET_THU)] }));
    expect(row(a, "claude").windows.map((w) => [w.id, w.pauseAt])).toEqual([[word, null]]);
    expect(row(a, "claude").limitedUntil).toBeNull();
    expect(row(a, "claude").pill.state).toBe("nearly_out");
  });
});

describe("T-ALLOW on the fixtures", () => {
  function fromFixture(name: string, now = NOW): Allowance {
    const data = readHome(copyHome(name));
    return buildAllowance(data.quota, data.quotaMtimeMs, settings, null, now, f);
  }

  it("quota-readings: Claude 62% and 41%, Codex 18% on the week only", () => {
    const a = fromFixture("quota-readings");
    expect(row(a, "claude").windows.map((w) => w.text)).toEqual(["62% used, resets 12:20", "41% used, resets Thu 09:00"]);
    expect(row(a, "codex").windows.map((w) => w.text)).toEqual(["18% used, resets Wed 18:30"]);
    expect(row(a, "codex").note).toBe("No 5-hour limit reported.");
    expect(a.providers.map((p) => p.pill.state)).toEqual(["plenty", "plenty"]);
    expect(a.fileChangedAt).toBe(FIXTURE_MTIME_MS);
  });

  it("quota-nearly-out: 91% in the 5-hour window is nearly out, the weekly 80% is only getting low", () => {
    const a = fromFixture("quota-nearly-out");
    expect(row(a, "claude").pill).toEqual({ state: "nearly_out", word: "Nearly out" });
    expect(row(a, "codex").pill.state).toBe("getting_low");
    expect(row(a, "claude").limitedUntil).toBeNull();
  });

  it("quota-expired: readings and limits that have ended are gone", () => {
    const a = fromFixture("quota-expired");
    expect(row(a, "claude").windows.map((w) => w.id)).toEqual(["seven_day"]);
    expect(row(a, "codex").limitedUntil).toBeNull();
    expect(row(a, "codex").pill.state).toBe("no_reading");
  });

  it("quota-overage: the paced window waits for its reset, the other is nearly out", () => {
    const a = fromFixture("quota-overage");
    expect(row(a, "claude").windows[0]).toMatchObject({ usedPercent: 104, fill: 1, overage: true });
    expect(row(a, "claude").pill.state).toBe("waiting_reset");
    expect(row(a, "codex").pill.state).toBe("nearly_out");
  });

  it("quota-limited: a weekly limit entry and a model block, with no raw provider text", () => {
    const a = fromFixture("quota-limited");
    expect(row(a, "claude").limitedText).toBe("Waiting for the weekly limit to reset. Work resumes Wed 18:30.");
    expect(row(a, "claude").pill.state).toBe("waiting_reset");
    expect(row(a, "codex").note).toBe("One kind of model is limited until 11:15.");
    expect(JSON.stringify(a)).not.toContain("weekly limit reached");
    expect(JSON.stringify(a)).not.toContain("model limit");
  });

  it("quota-corrupt: a file that is not JSON counts as absent", () => {
    const a = fromFixture("quota-corrupt");
    expect(a.providers.map((p) => p.pill.state)).toEqual(["no_reading", "no_reading"]);
    expect(a.fileChangedAt).toBeNull();
  });

  it("quota-paced: the weekly cap blocks Claude although the file's limits are empty (E47)", () => {
    const a = fromFixture("quota-paced");
    const claude = row(a, "claude");
    expect(claude.pill.state).toBe("waiting_reset");
    expect(claude.limitedUntil).toBe(at("2026-10-15T08:59:15.000Z"));
    expect(claude.limitedText).toBe("Waiting for the weekly limit to reset. Work resumes Thu 09:00.");
    expect(row(a, "codex").pill.state).toBe("plenty");
  });

  it("limit-waiting: the Codex row and the banner name the same minute (12:59)", () => {
    const home = copyHome("limit-waiting");
    withLock(home, { at: "2026-10-11T09:58:10.000Z", ageMs: 15_000, now: NOW });
    const snapshot = buildSnapshot({ home, now: NOW, timeZone: "UTC" });
    const codex = row(snapshot.allowance, "codex");
    expect(codex.pill.state).toBe("waiting_reset");
    expect(codex.note).toBe("No usage reading yet.");
    expect(codex.limitedText).toBe("Waiting for the 5-hour limit to reset. Work resumes at 12:59.");
    expect(snapshot.allowance.waiting?.untilText).toBe("12:59");
    expect(snapshot.allowance.waiting?.text).toBe("Waiting for allowance until 12:59. It resumes by itself.");
    expect(row(snapshot.allowance, "claude").pill.state).toBe("no_reading");
  });

  it("a mission that is awake gives no banner even when the file still holds a limit", () => {
    const home = emptyHome();
    const m = makeMission({ id: "2026-10-11-awake", title: "Awake", status: "waiting", stage: "gate_a", features: [makeFeature({ id: "one", title: "One" })], updatedAt: "2026-10-11T09:58:20.000Z" });
    writeMission(home, m, {
      events: [
        makeEvent(m.id, "2026-10-11T09:58:10.000Z", "limit.wait", { until: "2026-10-11T09:58:20.000Z", reason: "gpt-6-astra: session limit until 2026-10-11T09:57:35.000Z" }),
        makeEvent(m.id, "2026-10-11T09:58:21.000Z", "run.start", { label: "gate-a", jobId: "gate-a-1", role: "reviewer" }),
      ],
    });
    withLock(home, { at: "2026-10-11T09:58:00.000Z", ageMs: 5_000, now: NOW });
    expect(buildSnapshot({ home, now: NOW, timeZone: "UTC" }).allowance.waiting).toBeNull();
  });

  it("the whole allowance of a snapshot is plain JSON with no provider text", () => {
    const snapshot = buildSnapshot({ home: copyHome("multi-mission"), now: NOW, timeZone: "UTC" });
    expect(JSON.stringify(snapshot.allowance)).not.toContain("mock session limit");
  });
});
