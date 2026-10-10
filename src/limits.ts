// Usage-limit detection for provider CLI output, and parsing of the human-readable reset times in it.

import type { LimitInfo, LimitKind, Provider } from "./types.js";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// ───────────────────────────── Reset times ─────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Words that introduce an absolute reset time: "resets 3pm", "Try again at 3:45 PM", "resets on Oct 10". */
const RESET_KEYWORD = /\b(?:resets?|try\s+again|retry|available(?:\s+again)?|until)(?:\s+(?:at|on))?\s+/gi;

/**
 * An optional date, a clock time and an optional IANA zone, anchored (sticky) where a keyword ends:
 * "Oct 10th, 2026 3:45 PM", "Oct 10, 3pm", "Oct 10 at 3:45 PM", "15:45", "3pm (Europe/Paris)".
 * Repetitions are bounded so huge inputs cannot overflow the regexp backtracking stack.
 */
const CLOCK_TIME = new RegExp(
  String.raw`(?:(?<month>${MONTHS.join("|")})[a-z]*\.?\s+(?<day>\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s+(?<year>\d{4}))?,?\s+(?:at\s+)?)?` +
    String.raw`(?<hour>\d{1,2})(?!\d)(?::(?<minute>\d{2}))?(?::(?<second>\d{2}))?(?:\s*(?<meridiem>[ap])\.?m\.?(?![a-z]))?` +
    String.raw`(?:\s*\((?<zone>[a-z][\w+-]{0,40}(?:\/[\w+-]{1,40}){0,3})\))?`,
  "iy",
);

const DURATION_UNIT = String.raw`(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])(?![a-z])`;
/** "in 2 hours", "in 45 minutes", "in 1h 30m", "in 2 hours and 15 minutes". */
const RELATIVE_TIME = new RegExp(
  String.raw`\bin\s+((?:\d+(?:\.\d+)?\s*${DURATION_UNIT}(?:\s*,?\s*(?:and\s+)?)?){1,6})`,
  "i",
);
const DURATION_PART = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(${DURATION_UNIT})`, "gi");

/**
 * Reset times are shown to the minute, so a time this recently past is the reset happening right now
 * ("try again at 3:45 PM" read at 3:45:20), not tomorrow's.
 */
const JUST_PASSED_MS = 2 * MINUTE_MS;

/**
 * A yearless date this recently past is taken as this year's (already passed) reset rather than next year's:
 * a reset that just happened must not turn into a year-long block.
 */
const RECENT_PAST_MS = DAY_MS;

interface CalendarDate {
  year: number;
  month: number; // 1..12
  day: number;
}

interface TimeOfDay {
  hour: number;
  minute: number;
  second: number;
}

/**
 * Parses a reset time from limit text and returns it as epoch ms, or undefined when there is none.
 * Absolute times ("resets 3pm", "Try again at Oct 10th, 2026 3:45 PM") win over relative ones ("in 1h 30m").
 * Clock times are read in the zone named in trailing parentheses, else `timeZone`, else the process zone.
 * A time or yearless date resolves to its next occurrence, except that one that passed within the last two
 * minutes (yearless date: the last day) is kept, since it is the reset that is happening now.
 */
export function parseResetTime(text: string, nowMs: number, timeZone?: string): number | undefined {
  return parseClockTime(text, nowMs, timeZone) ?? parseRelativeTime(text, nowMs);
}

function parseClockTime(text: string, nowMs: number, timeZone: string | undefined): number | undefined {
  for (const keyword of text.matchAll(RESET_KEYWORD)) {
    CLOCK_TIME.lastIndex = keyword.index + keyword[0].length;
    const groups = CLOCK_TIME.exec(text)?.groups;
    const resolved = groups && resolveClockTime(groups, nowMs, timeZone);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

function resolveClockTime(
  groups: Record<string, string | undefined>,
  nowMs: number,
  timeZone: string | undefined,
): number | undefined {
  const time = toTimeOfDay(groups.hour, groups.minute, groups.second, groups.meridiem);
  if (!time) return undefined;
  const zone = resolveZone(groups.zone, timeZone);
  if (groups.month === undefined) return nextTimeOfDay(time, nowMs, zone);

  const month = MONTHS.indexOf(groups.month.toLowerCase()) + 1;
  const day = Number(groups.day);
  if (groups.year !== undefined) {
    const date = { year: Number(groups.year), month, day };
    return isValidDate(date) ? upcomingOrLast(zonedTimeToEpochs(date, time, zone), nowMs) : undefined;
  }
  return nextDateOccurrence(month, day, time, nowMs, zone);
}

function toTimeOfDay(
  hourText: string | undefined,
  minuteText: string | undefined,
  secondText: string | undefined,
  meridiem: string | undefined,
): TimeOfDay | undefined {
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  const second = Number(secondText ?? 0);
  if (minute > 59 || second > 59) return undefined;
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0);
  } else if (minuteText === undefined || hour > 23) {
    return undefined; // a bare number ("resets 15") is not a time
  }
  return { hour, minute, second };
}

/** The next moment the zone's wall clock shows `time`; yesterday is included for a time that has only just passed. */
function nextTimeOfDay(time: TimeOfDay, nowMs: number, zone: Zone): number | undefined {
  const today = calendarDateAt(nowMs, zone);
  const instants = [-1, 0, 1].flatMap((days) => zonedTimeToEpochs(addDays(today, days), time, zone));
  return instants.find((at) => at > nowMs - JUST_PASSED_MS);
}

function nextDateOccurrence(month: number, day: number, time: TimeOfDay, nowMs: number, zone: Zone): number | undefined {
  const { year } = calendarDateAt(nowMs, zone);
  // Start a year back so "Dec 31" read just after New Year stays in the old year; look ahead far enough for Feb 29.
  for (let candidateYear = year - 1; candidateYear <= year + 4; candidateYear++) {
    const date = { year: candidateYear, month, day };
    if (!isValidDate(date)) continue;
    const instants = zonedTimeToEpochs(date, time, zone);
    if (instants.some((at) => at > nowMs - RECENT_PAST_MS)) return upcomingOrLast(instants, nowMs);
  }
  return undefined;
}

/** Of the (ascending) instants a wall time can mean, the first that has not passed, else the last one. */
function upcomingOrLast(instants: number[], nowMs: number): number | undefined {
  return instants.find((at) => at > nowMs - JUST_PASSED_MS) ?? instants.at(-1);
}

function parseRelativeTime(text: string, nowMs: number): number | undefined {
  const duration = RELATIVE_TIME.exec(text)?.[1];
  if (duration === undefined) return undefined;
  let totalMs = 0;
  for (const [, amount, unit] of duration.matchAll(DURATION_PART)) {
    totalMs += Number(amount) * unitMs(unit ?? "");
  }
  return nowMs + Math.round(totalMs);
}

function unitMs(unit: string): number {
  switch (unit.charAt(0).toLowerCase()) {
    case "d":
      return DAY_MS;
    case "h":
      return HOUR_MS;
    case "m":
      return MINUTE_MS;
    default:
      return SECOND_MS;
  }
}

// ── Time zone math (Intl offsets, no libraries). A zone is represented by its wall-clock formatter. ──

type Zone = Intl.DateTimeFormat;

function createZone(name: string): Zone {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: name,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
}

const UTC_ZONE = createZone("UTC");
const zoneCache = new Map<string, Zone>();

function zoneNamed(name: string): Zone | undefined {
  let zone = zoneCache.get(name);
  if (!zone) {
    try {
      zone = createZone(name);
    } catch {
      return undefined; // RangeError: not a zone Intl knows
    }
    zoneCache.set(name, zone);
  }
  return zone;
}

/** The first valid zone among the names, else the process zone. */
function resolveZone(...names: (string | undefined)[]): Zone {
  for (const name of [...names, Intl.DateTimeFormat().resolvedOptions().timeZone]) {
    const zone = name === undefined ? undefined : zoneNamed(name);
    if (zone) return zone;
  }
  return UTC_ZONE;
}

/** The zone's wall-clock reading at an instant, expressed as if it were a UTC epoch. */
function wallClockAsUtc(epochMs: number, zone: Zone): number {
  const parts = zone.formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}

/** Milliseconds the zone is ahead of UTC at an instant (negative west of Greenwich). */
function zoneOffsetMs(epochMs: number, zone: Zone): number {
  return wallClockAsUtc(epochMs, zone) - Math.floor(epochMs / SECOND_MS) * SECOND_MS;
}

/**
 * The instants, ascending, at which the zone's wall clock shows `time` on `date`: two in a repeated fall-back hour,
 * and for a time skipped by a spring-forward gap, the instant read with the pre-gap offset (2:30 becomes 3:30).
 */
function zonedTimeToEpochs(date: CalendarDate, time: TimeOfDay, zone: Zone): number[] {
  const asUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, time.second);
  // An offset changes at most once in two days, so the offsets a day either side are the only candidates.
  const offsetBefore = zoneOffsetMs(asUtc - DAY_MS, zone);
  const offsetAfter = zoneOffsetMs(asUtc + DAY_MS, zone);
  const exact = [...new Set([asUtc - offsetBefore, asUtc - offsetAfter])]
    .filter((at) => wallClockAsUtc(at, zone) === asUtc)
    .sort((a, b) => a - b);
  return exact.length > 0 ? exact : [asUtc - offsetBefore];
}

function calendarDateAt(epochMs: number, zone: Zone): CalendarDate {
  const wall = new Date(wallClockAsUtc(epochMs, zone));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Whether the day exists in its month (Feb 30 does not); `month` is always 1..12 here. */
function isValidDate({ year, month, day }: CalendarDate): boolean {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

// ───────────────────────────── Limit text ─────────────────────────────

/** A Codex "usage limit" resetting further away than this is the weekly window rather than the 5-hour one. */
const SESSION_WINDOW_MS = 6 * HOUR_MS;
/** Longest `raw` excerpt kept for logs and the report. */
const MAX_RAW_CHARS = 500;
/** How far from the trigger the reset time is looked for; it also bounds the regexp work on huge output. */
const RESET_SCAN_CHARS = 1_000;
/** Lines after the triggering one that may hold its reset ("…your usage limit.\nTry again at 3:45 PM."). */
const RESET_SCAN_NEXT_LINES = 2;

/** "usage" is an unqualified limit (Codex "usage limit", Claude "hit your limit"): session or weekly by reset distance. */
type DetectedKind = LimitKind | "usage";

/** Finds a limit phrase in text. */
type PhraseMatcher = (text: string) => RegExpExecArray | undefined;

interface LimitRule {
  kind: DetectedKind;
  patterns: PhraseMatcher[];
  /** For kind "model": the model the matched message names (a substring of the model ids it blocks). */
  model?: (match: RegExpExecArray) => string | undefined;
}

/**
 * What may come right before a CLI message: the start of the text or of a line, or punctuation such as `"`, `:`,
 * `·`, `]` or `(`, then at most four spaces. Agent prose and test output that merely talk about limits put a word,
 * comma or single quote there instead ("when you hit your…", "expected 'You've hit your usage limit' to be visible").
 */
const MESSAGE_LEAD = /(?:^|[\r\n]|[^\w\s,'‘`])[ \t\u00a0]{0,4}$/;
const MESSAGE_LEAD_CHARS = 5;

function isMessageStart(text: string, index: number): boolean {
  return MESSAGE_LEAD.test(text.slice(Math.max(0, index - MESSAGE_LEAD_CHARS), index));
}

/** Matches `source` only where a CLI message starts (see MESSAGE_LEAD). */
function cliMessage(source: string): PhraseMatcher {
  const regex = new RegExp(source, "gi");
  return (text) => {
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match; match = regex.exec(text)) {
      if (isMessageStart(text, match.index)) return match;
      regex.lastIndex = match.index + 1;
    }
    return undefined;
  };
}

/** Matches machine-readable output (a JSON field) wherever it appears. */
function anywhere(regex: RegExp): PhraseMatcher {
  return (text) => regex.exec(text) ?? undefined;
}

const YOU_HIT_YOUR = String.raw`you(?:['’]ve|\s+have)?\s+(?:hit|reached)\s+your\s+`;
const YOU_ARE_OUT_OF = String.raw`(?:you(?:['’]re|\s+are)|your\s+(?:org(?:anization)?|workspace|team|account)\s+is)\s+out\s+of\s+`;
/** Ends a limit name; "your limit of 5 projects" is an app's own limit, not the provider's. */
const LIMIT_END = String.raw`\b(?!\s+of\b)`;
/**
 * Codex's per-model limit: "You’ve hit your usage limit for GPT-6-Astra. Switch to another model now, or try again at
 * …". The name is a display name ("GPT-6 Astra" or "GPT-6-Astra"), read up to codex's ". Switch to another model";
 * without that sentence, only a single word with a digit in it counts as a model name ("… limit for gpt-6-astra.").
 */
const CODEX_MODEL_LIMIT = String.raw`${YOU_HIT_YOUR}usage\s+limit\s+for\s+(?:([^\n]{1,60}?)\.?\s+switch\s+to\s+another\s+model\b|([a-z][\w.-]*\d[\w.-]*?)\.?(?=\s|$))`;

// Ordered: the first rule with a matching pattern decides the kind.
// Claude: "You've hit your session limit · resets 3:45pm (America/New_York)", "… weekly / Opus / Sonnet limit",
// "You've reached your Fable limit", "You've hit your monthly spend limit", "You're out of usage credits".
// Codex: "You’ve hit your usage limit. … try again at 3:45 PM.", "Your workspace is out of credits", "You hit your spend cap".
const LIMIT_RULES: LimitRule[] = [
  {
    kind: "model",
    patterns: [cliMessage(String.raw`${YOU_HIT_YOUR}(opus|sonnet|fable|haiku)\s+(?:weekly\s+)?limit${LIMIT_END}`)],
    model: (match) => match[1]?.toLowerCase(),
  },
  // Before "usage": a usage limit for one model leaves the provider's other models usable.
  { kind: "model", patterns: [cliMessage(CODEX_MODEL_LIMIT)], model: (match) => modelIdFromName(match[1] ?? match[2] ?? "") },
  {
    kind: "session",
    patterns: [
      cliMessage(String.raw`${YOU_HIT_YOUR}(?:session|5[- ]hour)\s+limit${LIMIT_END}`),
      cliMessage(String.raw`5[- ]hour\s+limit\s+(?:reached|hit|exceeded)\b`),
    ],
  },
  { kind: "weekly", patterns: [cliMessage(String.raw`${YOU_HIT_YOUR}weekly\s+limit${LIMIT_END}`)] },
  {
    kind: "spend",
    patterns: [
      cliMessage(
        String.raw`${YOU_HIT_YOUR}[\w'’ -]{0,40}?\b(?:spend\s+(?:limit|cap)|extra\s+usage\s+(?:limit|cap)|usage\s+credit\s+limit|shared\s+budget|monthly\s+(?:usage\s+)?limit)${LIMIT_END}`,
      ),
      cliMessage(String.raw`${YOU_ARE_OUT_OF}(?:usage\s+credits|credits|extra\s+usage|usage)\b`),
      // "Monthly spend limit reached", "Your spend limit has been reached", "Extra usage limit exceeded"
      cliMessage(
        String.raw`(?:(?:your|the|monthly|workspace|org(?:anization)?['’]s|team['’]s)\s+){0,3}(?:spend|extra\s+usage)\s+(?:limit|cap)\s+(?:has\s+been\s+|was\s+)?(?:reached|hit|exceeded)\b`,
      ),
      cliMessage(String.raw`extra\s+usage\s+is\s+required\b`),
    ],
  },
  { kind: "usage", patterns: [cliMessage(String.raw`${YOU_HIT_YOUR}(?:usage\s+)?limit${LIMIT_END}`)] },
  // A limit this module does not know yet ("You've hit your daily limit"): still a limit, of unknown kind.
  { kind: "unknown", patterns: [cliMessage(String.raw`${YOU_HIT_YOUR}(?:[\w'’-]+\s+){1,3}?(?:limit|cap)${LIMIT_END}`)] },
];

const HIT_YOUR = /\bhit\s+your\b/i;

const THROTTLE_SIGNAL = String.raw`(?:429|529|rate[\s_-]?limit|too\s+many\s+requests|overloaded)`;

// Transient overload/429 that the CLI could not absorb. Agents write "rate-limited", "429 Too Many Requests" and
// "overloaded" in ordinary summaries and test output, so each signal needs the CLI's own error framing.
const THROTTLE_PATTERNS: PhraseMatcher[] = [
  // Claude: "API Error: 429 {…rate_limit_error…}", "API Error: Repeated 529 Overloaded errors", "API Error: Overloaded"
  cliMessage(String.raw`api\s+error\s*[:(][^\n]{0,80}?\b${THROTTLE_SIGNAL}`),
  // Codex: "stream error: rate limit exceeded", "unexpected status 429 Too Many Requests: …"
  cliMessage(String.raw`stream\s+error\b[^\n]{0,80}?\b${THROTTLE_SIGNAL}`),
  cliMessage(String.raw`unexpected\s+status\s+(?:429|529)\b`),
  cliMessage(String.raw`exceeded\s+retry\s+limit,\s+last\s+status:?\s*(?:429|529)\b`),
  // A bare status as the message: "Error: 429", "Error: 529 Overloaded", "529 Overloaded", "429 Too Many Requests"
  cliMessage(String.raw`(?:error:\s*(?:429|529)|429\s+too\s+many\s+requests|529\s+overloaded)\b`),
  // api_retry `"error_status":529`, `{"type":"overloaded_error"}`, OpenAI `{"code":"rate_limit_exceeded"}`
  anywhere(/"error_status"\s*:\s*(?:429|529)\b/),
  anywhere(/"(?:type|code)"\s*:\s*"(?:rate_limit_error|overloaded_error|rate_limit_exceeded)"/),
];

interface Detection {
  kind: DetectedKind;
  /** Where the triggering phrase starts in the text. */
  index: number;
  model?: string;
}

/**
 * Recognizes usage-limit and throttling messages in provider output (result text, errors, stderr, raw NDJSON).
 * Returns undefined for unrelated text. JSON string escapes are decoded first, so `raw` is the decoded line that
 * triggered detection. The reset time is read from the triggering message (see findResetTime).
 */
export function detectLimitText(text: string, provider: Provider, nowMs: number): LimitInfo | undefined {
  const plain = decodeJsonEscapes(text);
  const detection = detectLimitPhrase(plain);
  if (!detection) return undefined;

  const resetsAt = findResetTime(plain, detection.index, nowMs);
  const kind = detection.kind === "usage" ? usageLimitKind(resetsAt, nowMs) : detection.kind;
  return {
    provider,
    kind,
    ...(resetsAt !== undefined && { resetsAt }),
    ...(detection.model !== undefined && { model: detection.model }),
    raw: rawExcerpt(plain, detection.index),
  };
}

const JSON_ESCAPE = /\\(?:u[0-9a-fA-F]{4}|[nrt"\\/])/g;
const ESCAPED_CHARS: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", "/": "/" };

/** Decodes JSON string escapes, so a raw event line reads like the message it carries ("…limit.\nTry again…"). */
function decodeJsonEscapes(text: string): string {
  return text.replace(JSON_ESCAPE, (escape) => {
    if (escape.length === 6) return String.fromCharCode(Number.parseInt(escape.slice(2), 16)); // \uXXXX
    return ESCAPED_CHARS[escape.charAt(1)] ?? escape;
  });
}

function detectLimitPhrase(text: string): Detection | undefined {
  for (const rule of LIMIT_RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern(text);
      if (!match) continue;
      const model = rule.model?.(match);
      return { kind: rule.kind, index: match.index, ...(model !== undefined && { model }) };
    }
  }
  if (HIT_YOUR.test(text)) return undefined; // "hit your …" is never a throttle
  for (const pattern of THROTTLE_PATTERNS) {
    const match = pattern(text);
    if (match) return { kind: "throttle", index: match.index };
  }
  return undefined;
}

/**
 * A model id as the quota matches it, from a display name: "GPT-6 Astra" and "GPT-6-Astra" → "gpt-6-astra",
 * "GPT-6.1 Sol" → "gpt-6.1-sol". Parenthesized notes are dropped. Undefined when nothing is left, so the limit
 * falls back to the model of the run that hit it.
 */
function modelIdFromName(name: string): string | undefined {
  const id = name
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return id === "" ? undefined : id;
}

function usageLimitKind(resetsAt: number | undefined, nowMs: number): LimitKind {
  return resetsAt === undefined || resetsAt - nowMs < SESSION_WINDOW_MS ? "session" : "weekly";
}

/**
 * The reset time of the message that starts at `index`: read from the rest of its line, then from the next lines,
 * and only then from earlier on the line, which may hold unrelated events glued onto it.
 */
function findResetTime(text: string, index: number, nowMs: number): number | undefined {
  const { start, end } = lineBounds(text, index);
  const nextLines = text.slice(end + 1, end + 1 + RESET_SCAN_CHARS).split("\n").slice(0, RESET_SCAN_NEXT_LINES);
  const places = [
    text.slice(index, Math.min(end, index + RESET_SCAN_CHARS)),
    ...nextLines,
    text.slice(Math.max(start, index - RESET_SCAN_CHARS), index),
  ];
  for (const place of places) {
    const resetsAt = parseResetTime(place, nowMs);
    if (resetsAt !== undefined) return resetsAt;
  }
  return undefined;
}

/** The line containing `index`, trimmed and capped at MAX_RAW_CHARS around the trigger. */
function rawExcerpt(text: string, index: number): string {
  const { start, end } = lineBounds(text, index);
  const line = text.slice(start, end).trim();
  if (line.length <= MAX_RAW_CHARS) return line;
  const excerptStart = Math.max(start, index - MAX_RAW_CHARS / 5);
  return text.slice(excerptStart, Math.min(end, excerptStart + MAX_RAW_CHARS)).trim();
}

/** Start and end (exclusive, before the newline) of the line containing `index`. */
function lineBounds(text: string, index: number): { start: number; end: number } {
  const newline = text.indexOf("\n", index);
  return { start: text.lastIndexOf("\n", index) + 1, end: newline === -1 ? text.length : newline };
}

// ───────────────────────────── Claude rate_limit_event ─────────────────────────────

/** Maps a Claude `rate_limit_info.rateLimitType` to a limit kind. */
export function limitKindFromClaudeType(rateLimitType: string | undefined): LimitKind {
  switch (rateLimitType) {
    case "five_hour":
      return "session";
    case "seven_day":
      return "weekly";
    case "seven_day_opus":
    case "seven_day_sonnet":
      return "model";
    case "overage":
    case "seven_day_overage_included":
      return "spend";
    default:
      return "unknown";
  }
}
