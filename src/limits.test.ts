import { afterEach, describe, expect, it, vi } from "vitest";
import { detectLimitText, limitKindFromClaudeType, parseResetTime } from "./limits.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** UTC epoch ms; `month` is 1-based to keep the expectations readable. */
function utc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

// Friday 2026-10-09 18:00 UTC = 14:00 in New York (EDT, UTC-4) = 20:00 in Paris (CEST, UTC+2).
const NOW = utc(2026, 10, 9, 18, 0);
const NY = "America/New_York";
const PARIS = "Europe/Paris";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseResetTime: clock times without a date", () => {
  it.each([
    ["resets 3:45pm", "UTC", utc(2026, 10, 10, 15, 45)], // 15:45 UTC already passed today
    ["resets 3:45pm", NY, utc(2026, 10, 9, 19, 45)], // later today in New York
    ["resets 3:45pm", PARIS, utc(2026, 10, 10, 13, 45)], // 20:00 in Paris: tomorrow
    ["resets 3pm", NY, utc(2026, 10, 9, 19, 0)],
    ["resets at 15:45", NY, utc(2026, 10, 9, 19, 45)],
    ["resets at 15:45", "UTC", utc(2026, 10, 10, 15, 45)],
    ["Try again at 3:45 PM.", NY, utc(2026, 10, 9, 19, 45)],
    ["resets 12am", NY, utc(2026, 10, 10, 4, 0)],
    ["resets 12pm", NY, utc(2026, 10, 10, 16, 0)], // noon already passed in New York
    ["resets 15:45:30", "UTC", utc(2026, 10, 10, 15, 45, 30)],
    ["resets 3:45 PM", NY, utc(2026, 10, 9, 19, 45)], // narrow no-break space from Intl formatting
    ["Try again at 3:45 p.m. today", NY, utc(2026, 10, 9, 19, 45)],
  ])("%s in %s", (text, zone, expected) => {
    expect(parseResetTime(text, NOW, zone)).toBe(expected);
  });

  it("picks the next occurrence, but keeps a reset shown for the current minute instead of moving it a day", () => {
    const atReset = utc(2026, 10, 9, 19, 45); // 15:45 in New York
    expect(parseResetTime("resets 3:45pm", atReset - 1_000, NY)).toBe(atReset);
    // Resets are shown to the minute: "3:45 PM" read at 15:45:20 is the reset happening now, not tomorrow's.
    expect(parseResetTime("resets 3:45pm", atReset, NY)).toBe(atReset);
    expect(parseResetTime("resets 3:45pm", atReset + 20_000, NY)).toBe(atReset);
    expect(parseResetTime("resets 3:45pm", atReset + 2 * MINUTE - 1, NY)).toBe(atReset);
    expect(parseResetTime("resets 3:45pm", atReset + 2 * MINUTE, NY)).toBe(atReset + DAY);
  });

  it("keeps a time that passed just before midnight on the previous day", () => {
    expect(parseResetTime("resets 11:59pm", utc(2026, 10, 10, 0, 0, 30), "UTC")).toBe(utc(2026, 10, 9, 23, 59));
  });

  it("uses the calendar day of the zone, not of UTC", () => {
    const lateEvening = utc(2026, 10, 10, 2, 0); // Oct 10 in UTC, still 22:00 on Oct 9 in New York
    expect(parseResetTime("resets 11pm", lateEvening, NY)).toBe(utc(2026, 10, 10, 3, 0));
  });

  it("rolls over to the next day across a DST change", () => {
    const beforeFallBack = utc(2026, 11, 1, 3, 0); // Oct 31 23:00 EDT; clocks go back on Nov 1
    expect(parseResetTime("resets 3pm", beforeFallBack, NY)).toBe(utc(2026, 11, 1, 20, 0)); // 15:00 EST
  });

  it("uses the offset in force at the reset, not at the naive guess, around a DST change", () => {
    // New York falls back at 06:00 UTC on Nov 1, 2026: 3am that day is EST.
    expect(parseResetTime("resets 3am", utc(2026, 11, 1, 4, 0), NY)).toBe(utc(2026, 11, 1, 8, 0));
    // Paris springs forward at 01:00 UTC on Mar 28, 2027: 1:30am that day is still CET.
    expect(parseResetTime("resets 1:30am", utc(2027, 3, 27, 22, 0), PARIS)).toBe(utc(2027, 3, 28, 0, 30));
  });

  it("finds the next occurrence of a time that a fall-back change repeats", () => {
    // New York repeats 1:00-2:00 on Nov 1, 2026: 1:30 is first 05:30Z (EDT), then 06:30Z (EST).
    expect(parseResetTime("resets 1:30am", utc(2026, 11, 1, 5, 0), NY)).toBe(utc(2026, 11, 1, 5, 30));
    expect(parseResetTime("resets 1:30am", utc(2026, 11, 1, 6, 10), NY)).toBe(utc(2026, 11, 1, 6, 30));
    expect(parseResetTime("resets 1:30am", utc(2026, 11, 1, 7, 0), NY)).toBe(utc(2026, 11, 2, 6, 30));
    // Paris repeats 2:00-3:00 on Oct 25, 2026: 2:01 is first 00:01Z (CEST), then 01:01Z (CET).
    expect(parseResetTime("resets 2:01am", utc(2026, 10, 24, 23, 38), PARIS)).toBe(utc(2026, 10, 25, 0, 1));
    expect(parseResetTime("resets 2:01am", utc(2026, 10, 25, 0, 30), PARIS)).toBe(utc(2026, 10, 25, 1, 1));
  });

  it("reads a time skipped by a spring-forward gap with the offset from before the gap", () => {
    // Paris jumps from 2:00 to 3:00 on Mar 28, 2027, so 2:30 does not exist; it is read as 2:30 CET = 3:30 CEST.
    expect(parseResetTime("resets 2:30am", utc(2027, 3, 27, 22, 0), PARIS)).toBe(utc(2027, 3, 28, 1, 30));
  });

  it("rolls over month and year ends", () => {
    expect(parseResetTime("resets 1am", utc(2026, 12, 31, 23, 30), "UTC")).toBe(utc(2027, 1, 1, 1, 0));
  });
});

describe("parseResetTime: dates", () => {
  it.each([
    ["Try again at Oct 10th, 2026 3:45 PM.", NY, utc(2026, 10, 10, 19, 45)],
    ["resets Oct 10, 3pm", PARIS, utc(2026, 10, 10, 13, 0)],
    ["resets Oct 10 at 3:45 PM", "UTC", utc(2026, 10, 10, 15, 45)],
    ["resets Jan 2, 2027, 3pm", NY, utc(2027, 1, 2, 20, 0)], // Claude's format when the year differs
    ["resets October 12 at 9:00 AM", "UTC", utc(2026, 10, 12, 9, 0)],
    ["try again at Nov 1st, 2026 1:30 AM", "UTC", utc(2026, 11, 1, 1, 30)],
    ["resets on Oct 22nd at 3:45pm", "UTC", utc(2026, 10, 22, 15, 45)],
  ])("%s in %s", (text, zone, expected) => {
    expect(parseResetTime(text, NOW, zone)).toBe(expected);
  });

  it("takes a yearless date in the next year when it has passed", () => {
    expect(parseResetTime("resets Jan 2, 3pm", utc(2026, 12, 30, 12), "UTC")).toBe(utc(2027, 1, 2, 15));
    expect(parseResetTime("resets Oct 5, 3pm", NOW, "UTC")).toBe(utc(2027, 10, 5, 15));
  });

  it("keeps a yearless date that passed within the last day instead of jumping a year", () => {
    expect(parseResetTime("resets Oct 9, 1pm", NOW, "UTC")).toBe(utc(2026, 10, 9, 13));
    expect(parseResetTime("resets Dec 31, 11pm", utc(2027, 1, 1, 0, 30), "UTC")).toBe(utc(2026, 12, 31, 23));
  });

  it("resolves a dated time in a repeated hour to the occurrence that has not passed", () => {
    expect(parseResetTime("resets Nov 1, 1:30am", utc(2026, 11, 1, 5, 0), NY)).toBe(utc(2026, 11, 1, 5, 30));
    expect(parseResetTime("resets Nov 1, 1:30am", utc(2026, 11, 1, 6, 10), NY)).toBe(utc(2026, 11, 1, 6, 30));
    expect(parseResetTime("Try again at Nov 1st, 2026 1:30 AM.", NOW, NY)).toBe(utc(2026, 11, 1, 5, 30));
    expect(parseResetTime("Try again at Nov 1st, 2026 1:30 AM.", utc(2026, 11, 1, 6, 10), NY)).toBe(utc(2026, 11, 1, 6, 30));
  });

  it("finds the next Feb 29", () => {
    expect(parseResetTime("resets Feb 29, 3pm", NOW, "UTC")).toBe(utc(2028, 2, 29, 15));
  });

  it("keeps an explicit year even when it is in the past", () => {
    expect(parseResetTime("Try again at Oct 1st, 2026 3:45 PM.", NOW, "UTC")).toBe(utc(2026, 10, 1, 15, 45));
  });

  it("rejects impossible dates", () => {
    expect(parseResetTime("resets Feb 30, 3pm", NOW, "UTC")).toBeUndefined();
    expect(parseResetTime("Try again at Feb 30th, 2026 3:45 PM.", NOW, "UTC")).toBeUndefined();
  });
});

describe("parseResetTime: time zones", () => {
  it("lets a trailing IANA zone in parentheses override the timeZone argument", () => {
    expect(parseResetTime("resets 3pm (Europe/Paris)", NOW, NY)).toBe(utc(2026, 10, 10, 13, 0));
    expect(parseResetTime("resets Oct 12, 3pm (America/New_York)", NOW, "UTC")).toBe(utc(2026, 10, 12, 19, 0));
    expect(parseResetTime("resets 3:45pm (UTC)", NOW, NY)).toBe(utc(2026, 10, 10, 15, 45));
  });

  it("ignores a parenthesized word that is not a zone", () => {
    expect(parseResetTime("resets 3pm (Mars/Olympus)", NOW, NY)).toBe(utc(2026, 10, 9, 19, 0));
    expect(parseResetTime("resets 3pm (approximately)", NOW, NY)).toBe(utc(2026, 10, 9, 19, 0));
  });

  it("defaults to the process time zone", () => {
    vi.stubEnv("TZ", "Asia/Tokyo"); // now is 03:00 on Oct 10 in Tokyo
    expect(parseResetTime("resets 3pm", NOW)).toBe(utc(2026, 10, 10, 6, 0));
  });

  it("falls back to the process time zone when the timeZone argument is invalid", () => {
    vi.stubEnv("TZ", NY);
    expect(parseResetTime("resets 3pm", NOW, "Not/AZone")).toBe(utc(2026, 10, 9, 19, 0));
  });
});

describe("parseResetTime: relative times", () => {
  it.each([
    ["resets in 2 hours", 2 * HOUR],
    ["in 45 minutes", 45 * MINUTE],
    ["in 1h 30m", 90 * MINUTE],
    ["in 1h30m", 90 * MINUTE],
    ["Try again in 2 hours and 15 minutes.", 135 * MINUTE],
    ["resets in 3 days", 3 * DAY],
    ["in 1 day, 2 hrs", DAY + 2 * HOUR],
    ["in 1.5 hours", 90 * MINUTE],
    ["in 30s", 30_000],
    ["in 90 seconds", 90_000],
    ["in 5 mins", 5 * MINUTE],
  ])("%s", (text, offset) => {
    expect(parseResetTime(text, NOW, "UTC")).toBe(NOW + offset);
  });

  it("prefers an absolute time over a relative one", () => {
    expect(parseResetTime("in 10 minutes · resets 3pm (UTC)", NOW)).toBe(utc(2026, 10, 10, 15, 0));
  });

  it("skips a keyword with no time after it and keeps looking", () => {
    expect(parseResetTime("resets soon; resets 3pm (UTC)", NOW)).toBe(utc(2026, 10, 10, 15, 0));
    expect(parseResetTime("resets in 20 minutes", NOW)).toBe(NOW + 20 * MINUTE);
  });
});

describe("parseResetTime: huge inputs", () => {
  // Unbounded repetitions used to overflow the regexp backtracking stack on a few MB, under the 8 MiB capture cap.
  it("parses long duration lists and zone-like text without throwing", () => {
    expect(parseResetTime(`in ${"1h ".repeat(1_000_000)}`, NOW, "UTC")).toBe(NOW + 6 * HOUR); // at most six parts
    expect(parseResetTime(`resets 3pm (${"a/".repeat(3_500_000)})`, NOW, NY)).toBe(utc(2026, 10, 9, 19, 0));
  });
});

describe("parseResetTime: unparseable text", () => {
  it.each([
    "",
    "resets soon",
    "resets 25:00",
    "resets 13pm",
    "resets 0am",
    "resets 3:75pm",
    "resets 15",
    "resets at 1530",
    "resets Oct 10", // a date without a time
    "at handler (src/app.ts:3:45)",
    "took 3:45 pm",
    "in a few minutes",
    "within 5 minutes",
    "fixed in 2026",
    "found in 3 messages",
  ])("%j", (text) => {
    expect(parseResetTime(text, NOW, "UTC")).toBeUndefined();
  });
});

describe("detectLimitText: Claude", () => {
  it("detects the session limit with its reset time", () => {
    const text = "You've hit your session limit · resets 3:45pm (America/New_York)";
    expect(detectLimitText(text, "claude", NOW)).toEqual({
      provider: "claude",
      kind: "session",
      resetsAt: utc(2026, 10, 9, 19, 45),
      raw: text,
    });
  });

  it("detects the weekly limit", () => {
    const info = detectLimitText("You've hit your weekly limit · resets Oct 12, 3pm (America/New_York) · progress saved", "claude", NOW);
    expect(info).toMatchObject({ kind: "weekly", resetsAt: utc(2026, 10, 12, 19, 0) });
    expect(info?.model).toBeUndefined();
  });

  it.each([
    ["You've hit your Opus limit · resets Oct 12, 3pm (America/New_York)", "opus"],
    ["You've hit your Sonnet limit · resets Oct 12, 3pm (America/New_York)", "sonnet"],
    ["You've reached your Fable limit. Switch to another model to continue.", "fable"],
    ["You've hit your Haiku limit", "haiku"],
    ["Opus weekly limit: you've hit your Opus weekly limit", "opus"],
  ])("detects a model limit: %s", (text, model) => {
    expect(detectLimitText(text, "claude", NOW)).toMatchObject({ kind: "model", model });
  });

  it("detects the older 5-hour limit wording", () => {
    expect(detectLimitText("5-hour limit reached ∙ resets 2pm (UTC)", "claude", NOW)).toMatchObject({
      kind: "session",
      resetsAt: utc(2026, 10, 10, 14, 0),
    });
  });

  it("treats the generic 'hit your limit' like a usage limit", () => {
    expect(detectLimitText("You've hit your limit · resets 3pm (America/New_York)", "claude", NOW)).toMatchObject({
      kind: "session",
      resetsAt: utc(2026, 10, 9, 19, 0),
    });
  });

  it("is case-insensitive", () => {
    const info = detectLimitText("YOU'VE HIT YOUR SESSION LIMIT · RESETS 3:45PM (AMERICA/NEW_YORK)", "claude", NOW);
    expect(info).toMatchObject({ kind: "session", resetsAt: utc(2026, 10, 9, 19, 45) });
  });

  it("keeps only the triggering line as raw and reads the reset from it", () => {
    const stderr = [
      "Error: something earlier happened at 1:00pm",
      "You've hit your session limit · resets 3:45pm (America/New_York)",
      "Try again in 5 minutes",
    ].join("\n");
    expect(detectLimitText(stderr, "claude", NOW)).toEqual({
      provider: "claude",
      kind: "session",
      resetsAt: utc(2026, 10, 9, 19, 45),
      raw: "You've hit your session limit · resets 3:45pm (America/New_York)",
    });
  });

  it("caps raw on a huge line while keeping the trigger", () => {
    const text = `${"x".repeat(2_000)} · You've hit your session limit · resets in 2 hours ${"y".repeat(2_000)}`;
    const info = detectLimitText(text, "claude", NOW);
    expect(info?.kind).toBe("session");
    expect(info?.resetsAt).toBe(NOW + 2 * HOUR);
    expect(info?.raw.length).toBeLessThanOrEqual(500);
    expect(info?.raw).toContain("hit your session limit");
  });

  it("does not overflow the regexp stack on a huge line", () => {
    const text = `You've hit your session limit in ${"1h ,  ".repeat(1_400_000)}!`; // 8 MiB
    expect(detectLimitText(text, "claude", NOW)).toMatchObject({ kind: "session", resetsAt: NOW + 6 * HOUR });
  });

  it("reports an unrecognized 'hit your … limit' as a limit of unknown kind", () => {
    expect(detectLimitText("You've hit your daily limit · resets 3pm (UTC)", "claude", NOW)).toEqual({
      provider: "claude",
      kind: "unknown",
      resetsAt: utc(2026, 10, 10, 15, 0),
      raw: "You've hit your daily limit · resets 3pm (UTC)",
    });
    expect(detectLimitText("You've hit your fast mode limit · 429 Too Many Requests", "claude", NOW)?.kind).toBe("unknown");
  });

  it("passes the provider through", () => {
    expect(detectLimitText("You've hit your session limit", "mock", NOW)?.provider).toBe("mock");
  });
});

describe("detectLimitText: Codex usage limit", () => {
  // Codex prints reset times in the machine's local zone without naming it.
  const codex = (text: string) => {
    vi.stubEnv("TZ", NY);
    return detectLimitText(text, "codex", NOW);
  };

  it("is a session limit when it resets within 6 hours", () => {
    const text =
      "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:45 PM.";
    expect(codex(text)).toEqual({ provider: "codex", kind: "session", resetsAt: utc(2026, 10, 9, 19, 45), raw: text });
  });

  it("is a weekly limit when it resets later", () => {
    const text =
      "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 14th, 2026 9:00 AM.";
    expect(codex(text)).toMatchObject({ kind: "weekly", resetsAt: utc(2026, 10, 14, 13, 0) });
  });

  it("is a session limit when the reset is unknown", () => {
    const info = codex("You’ve hit your usage limit.");
    expect(info).toEqual({ provider: "codex", kind: "session", raw: "You’ve hit your usage limit." });
  });

  it("switches from session to weekly at exactly 6 hours", () => {
    expect(codex("You've hit your usage limit. Try again in 5 hours 59 minutes.")?.kind).toBe("session");
    expect(codex("You've hit your usage limit. Try again in 6 hours.")?.kind).toBe("weekly");
  });

  it("detects the limit inside a turn.failed event line", () => {
    const line = '{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Try again at 3:45 PM."}}';
    expect(codex(`{"type":"turn.started"}\n${line}\n`)).toMatchObject({
      kind: "session",
      resetsAt: utc(2026, 10, 9, 19, 45),
      raw: line,
    });
  });

  it("stays a session limit when read in the minute of its reset", () => {
    vi.stubEnv("TZ", NY);
    const now = utc(2026, 10, 9, 19, 45, 20); // 15:45:20 in New York
    const text = "You've hit your usage limit. Upgrade to Pro or try again at 3:45 PM.";
    expect(detectLimitText(text, "codex", now)).toMatchObject({ kind: "session", resetsAt: utc(2026, 10, 9, 19, 45) });
  });

  it("reads the reset of the limit message, not of an unrelated event glued before it", () => {
    const glued =
      '{"type":"item.completed","item":{"type":"agent_message","text":"The quota counter resets at 2:00 AM nightly."}}' +
      '{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Try again at 3:45 PM."}}';
    expect(codex(glued)).toMatchObject({ kind: "session", resetsAt: utc(2026, 10, 9, 19, 45) });
  });

  it("reads a reset after a JSON-escaped newline in a raw event line", () => {
    // Escapes as a JSON encoder that writes ASCII only would leave them.
    const line = String.raw`{"type":"turn.failed","error":{"message":"You\u2019ve hit your usage limit.\nTry again at Oct 14th, 2026 9:00 AM."}}`;
    expect(line).toContain("\\n");
    expect(codex(line)).toMatchObject({ kind: "weekly", resetsAt: utc(2026, 10, 14, 13, 0) });
  });

  it("reads the reset from the next line when the message spans lines", () => {
    // As a runner sees it after parsing the event's JSON.
    expect(codex("You’ve hit your usage limit.\nTry again at Oct 14th, 2026 9:00 AM.")).toEqual({
      provider: "codex",
      kind: "weekly",
      resetsAt: utc(2026, 10, 14, 13, 0),
      raw: "You’ve hit your usage limit.",
    });
    expect(codex("You’ve hit your usage limit.\n\nTry again at 3:45 PM.")?.resetsAt).toBe(utc(2026, 10, 9, 19, 45));
    // Only the next two lines belong to the message.
    expect(codex("You’ve hit your usage limit.\n\n\nTry again at Oct 14th, 2026 9:00 AM.")?.resetsAt).toBeUndefined();
  });

  it("falls back to a reset earlier on the line when none follows the trigger", () => {
    expect(codex("Weekly window resets Oct 14th, 2026 9:00 AM · You’ve hit your usage limit.")).toMatchObject({
      kind: "weekly",
      resetsAt: utc(2026, 10, 14, 13, 0),
    });
  });

  it("treats a per-model usage limit as a provider-wide one", () => {
    const info = codex(
      "You’ve hit your usage limit for GPT-6 Astra. Switch to another model now, or try again at Oct 14th, 2026 9:00 AM.",
    );
    expect(info).toMatchObject({ kind: "weekly", resetsAt: utc(2026, 10, 14, 13, 0) });
    expect(info?.model).toBeUndefined();
  });
});

describe("detectLimitText: spend limits", () => {
  it.each([
    "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage",
    "You've hit your org's monthly spend limit · ask your admin to raise it",
    "You've hit your channel's monthly spend limit.",
    "You've hit your org's monthly usage limit",
    "You've hit your team's shared budget · raise it at https://claude.ai/admin",
    "You've hit your usage credit limit",
    "You're out of usage credits",
    "You're out of extra usage",
    "Extra usage is required for long context",
    "Your org is out of usage · contact your admin",
    "Your workspace is out of credits. Add credits to continue.",
    "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
    "You've hit your extra usage limit · resets 3pm (UTC)",
    "Monthly spend limit reached",
    "Spend limit exceeded for this workspace",
    "Your spend limit has been reached",
    "Error: your org's spend limit was reached",
    "Extra usage limit reached · raise it at https://claude.ai/settings/usage",
    "Your organization is out of credits",
  ])("%s", (text) => {
    expect(detectLimitText(text, "claude", NOW)?.kind).toBe("spend");
  });

  it("reads the reset time of the window behind the spend limit", () => {
    const text =
      "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage · your weekly limit resets Oct 12, 3pm (America/New_York)";
    expect(detectLimitText(text, "claude", NOW)).toMatchObject({ kind: "spend", resetsAt: utc(2026, 10, 12, 19, 0) });
    expect(detectLimitText("You've hit your extra usage limit · resets 3pm (UTC)", "claude", NOW)?.resetsAt).toBe(
      utc(2026, 10, 10, 15, 0),
    );
    expect(detectLimitText("You're out of usage credits · resets 3pm (UTC)", "claude", NOW)).toMatchObject({
      kind: "spend",
      resetsAt: utc(2026, 10, 10, 15, 0),
    });
  });
});

describe("detectLimitText: throttling", () => {
  it.each([
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}',
    "API Error: Repeated 529 Overloaded errors",
    "API Error: Overloaded",
    'API Error (529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}})',
    '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    '{"error":{"code":"rate_limit_exceeded"}}',
    "exceeded retry limit, last status: 429 Too Many Requests",
    "ERROR codex_core::codex: stream error: exceeded retry limit, last status: 529",
    "unexpected status 429 Too Many Requests: Rate limit reached for requests",
    "stream error: rate limit exceeded: please slow down",
    "Error: 429",
    "Error: 529 Overloaded",
    "529 Overloaded",
    "429 Too Many Requests",
    '{"type":"system","subtype":"api_retry","attempt":10,"max_retries":10,"error_status":529}',
  ])("%s", (text) => {
    expect(detectLimitText(text, "claude", NOW)?.kind).toBe("throttle");
  });

  it("includes a relative retry time when given", () => {
    expect(detectLimitText("stream error: rate limit exceeded. Try again in 30 seconds.", "codex", NOW)).toMatchObject({
      kind: "throttle",
      resetsAt: NOW + 30_000,
    });
  });

  it("prefers a usage limit anywhere in the text over a throttle", () => {
    const text = "rate limit exceeded\nYou've hit your session limit · resets 3:45pm (America/New_York)";
    expect(detectLimitText(text, "claude", NOW)).toMatchObject({
      kind: "session",
      resetsAt: utc(2026, 10, 9, 19, 45),
      raw: "You've hit your session limit · resets 3:45pm (America/New_York)",
    });
    expect(detectLimitText("You've hit your session limit (429 Too Many Requests)", "claude", NOW)?.kind).toBe("session");
  });

  it("never reports a throttle for text that says 'hit your'", () => {
    expect(detectLimitText("When you hit your daily cap the server answers:\nAPI Error: 429", "claude", NOW)).toBeUndefined();
    expect(detectLimitText("API Error: 429", "claude", NOW)?.kind).toBe("throttle");
  });
});

describe("detectLimitText: unrelated text", () => {
  it.each([
    "",
    "FAIL  src/pagination.test.ts > list > respects the page limit\nAssertionError: expected 11 to be less than or equal to 10",
    "Error: limit must be a positive integer (got -1)",
    "AssertionError: expected rate to equal 0.5",
    " ✓ src/rate-limiter.test.ts > rate limiter > blocks the 6th request within a minute",
    "AssertionError: expected 429 to be 200 // Object.is equality",
    "    at handler (src/app.ts:429:17)",
    "Tests  429 passed (429)",
    "Request failed with status code 404",
    "src/app.ts(12,5): error TS2769: No overload matches this call.",
    "Added rate limiting middleware; all 42 tests pass.",
    "Error: Timeout of 5000ms exceeded. Increase the timeout limit.",
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "Error: Reached max turns (40)",
    "You've used 90% of your session limit · resets 3pm",
    "Approaching 5-hour limit",
    "Now using extra usage",
    "Extra usage is now covering your requests",
    "When you hit your daily limit the Add button is disabled",
    "expected 'You have reached the free plan limit' to be visible",
    // Agent summaries and test output about the app's own rate limits, quotas and credits
    "The /login endpoint is now rate-limited (5 attempts per minute). All tests pass.",
    "Implemented per-IP throttling: clients that exceed 100 req/min now receive 429 Too Many Requests.",
    "Added retry on HTTP status 429 and 529 responses.",
    "Handled the case where the upstream API is overloaded.",
    "Wrapped the OpenAI client so overloaded errors are retried with backoff.",
    "We hit a rate limit while scraping, so I added exponential backoff.",
    "curl -i shows HTTP/1.1 429 Too Many Requests after the 6th request",
    'Returns { code: "rate_limit_exceeded" } with status 429',
    "Show an 'Out of credits' banner when the user runs out of credits.",
    "Users who are out of usage get a 402.",
    "The billing page warns when the monthly spend limit is exceeded.",
    'Added a modal: "You\'ve reached your limit of 5 projects. Upgrade to add more."',
    'Users see "You\'ve reached your session limit of 3 devices" on a fourth login.',
    "AssertionError: expected 'You’ve hit your usage limit' to be visible",
    "If you've hit your plan's project limit, the New button is disabled.",
  ])("%j", (text) => {
    expect(detectLimitText(text, "claude", NOW)).toBeUndefined();
  });
});

describe("limitKindFromClaudeType", () => {
  it.each([
    ["five_hour", "session"],
    ["seven_day", "weekly"],
    ["seven_day_opus", "model"],
    ["seven_day_sonnet", "model"],
    ["overage", "spend"],
    ["seven_day_overage_included", "spend"],
    ["something_new", "unknown"],
    ["", "unknown"],
    [undefined, "unknown"],
  ] as const)("%s → %s", (type, kind) => {
    expect(limitKindFromClaudeType(type)).toBe(kind);
  });
});
