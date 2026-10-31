// The allowance (usage left in the owner's plans), from quota.json (docs/dashboard-spec.md, section 10).
// Pure: it gets the parsed file and the clock. It never sends the provider's own text (`raw` is dropped by read.ts).
import { assessAllowance, legacyAllowanceObservations, restoreObservations, type AllowanceUnknownReason } from "../allowance.js";
import type { Provider } from "../types.js";
import { ID_MAX_CHARS, PILL_GETTING_LOW, PILL_NEARLY_OUT, WAIT_MARGIN_MS } from "./constants.js";
import type { QuotaData } from "./read.js";
import { clean } from "./sanitize.js";
import type { DashboardSettings } from "./snapshot.js";
import type { Allowance, AllowanceWindow, PillStateId, ProviderAllowance, WaitInfo } from "./types.js";
import {
  fileChangedLine,
  limitedLine,
  noteModelLimited,
  NOTE_NO_FIVE_HOUR,
  NOTE_NO_READING,
  PILL_WORDS,
  providerLabel,
  resetsLine,
  resumeWhen,
  windowLabel,
  windowSummary,
} from "./vocabulary-details.js";
import type { Formatter } from "./vocabulary.js";

/** The windows the engine paces against (src/quota.ts): it stops new work on a provider at their cap. */
const PACED_KINDS: Record<string, "session" | "weekly"> = { five_hour: "session", seven_day: "weekly" };

/** The block kind of a window id; own entries only, because the id came from a file ("constructor" is not a window). */
function pacedKind(id: string): "session" | "weekly" | undefined {
  return Object.hasOwn(PACED_KINDS, id) ? PACED_KINDS[id] : undefined;
}

interface Block {
  end: number;
  kind: string;
  /** A `limits` entry wins a tie against a pacing block, because it carries the real kind. */
  fromLimit: boolean;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** The order of the rows: five_hour, seven_day, then the rest by name. */
function windowRank(id: string): number {
  return id === "five_hour" ? 0 : id === "seven_day" ? 1 : 2;
}

function pauseAtFor(id: string, s: DashboardSettings): number | null {
  if (id === "five_hour") return s.pacing.maxFiveHourUtilization;
  if (id === "seven_day") return s.pacing.maxWeeklyUtilization;
  return null;
}

export function buildAllowance(
  q: QuotaData | null,
  quotaMtimeMs: number | null,
  s: DashboardSettings,
  wait: WaitInfo | null,
  now: number,
  f: Formatter,
): Allowance {
  const ids = providerIds(q, s);
  const observations = q && Object.hasOwn(q, "observations") ? restoreObservations(q.observations) : legacyAllowanceObservations(q?.utilization);
  const policy = s.pacing.unknownAllowance ?? "warn";
  // One rule for every time here: the clock time on the day of the snapshot, else the weekday and the time (the date too from 6 days away).
  const when = (ms: number): string => f.when(ms, now);

  const providers = ids.map((id): ProviderAllowance => {
    const windows = readWindows(q, id, now, s, when);
    const blocks = blocksFor(q, id, s, now);
    const last = blocks.reduce<Block | null>((best, b) => (best === null || b.end > best.end || (b.end === best.end && b.fromLimit && !best.fromLimit) ? b : best), null);
    const limitedUntil = last === null ? null : last.end;
    const resume = last === null ? 0 : last.end + WAIT_MARGIN_MS;
    let limitedText = last === null ? null : limitedLine(last.kind, resumeWhen(f.sameDay(resume, now), when(resume)));

    const assessment = assessAllowance(id as Provider, observations, now);
    const highest = windows.reduce((m, w) => Math.max(m, w.usedFraction), 0);
    let state: PillStateId = "plenty";
    if (limitedUntil !== null) state = "waiting_reset";
    else if (windows.length === 0) state = "no_reading";
    else if (highest >= PILL_NEARLY_OUT) state = "nearly_out";
    else if (highest >= PILL_GETTING_LOW) state = "getting_low";

    if (!assessment.usable) {
      if (limitedText !== null) limitedText = limitedText.replace("Work resumes", "A new allowance check can be made");
      if (state === "plenty") state = "no_reading";
      for (const window of windows) window.text = "Retained restriction: " + window.text + "; latest observation unconfirmed";
    }
    const unknown = assessment.windows.filter(w => !w.usable);
    const uncertainty = assessment.usable ? undefined : "Allowance could not be confirmed: " +
      unknown.map(w => windowLabel(w.window) + ": " + w.reasons.map(r => UNKNOWN_WORDS[r]).join(", ") +
        (w.receivedAt !== undefined ? "; last observed " + when(w.receivedAt) : "")).join(". ") +
      ". The reserve is not assured. In stop mode, unknown readings prevent a new AI job; in warn mode, existing usage limits still apply.";
    return { id, label: providerLabel(id), pill: { state, word: state === "no_reading" && windows.length > 0 ? "Allowance unconfirmed" : PILL_WORDS[state] },
      windows, note: noteFor(q, id, windows, now, when), limitedUntil, limitedText, ...(uncertainty && { uncertainty }) };
  });

  const hasFile = q !== null && quotaMtimeMs !== null;
  return {
    policyText: "Configuration when this dashboard opened: allowance policy " + policy + ". Each run records its own policy on the mission below.",
    providers,
    // Copied field by field: the caller's object may carry more than the snapshot is allowed to show.
    waiting: wait === null ? null : { until: wait.until, untilText: wait.untilText, cause: wait.cause, text: wait.text },
    fileChangedAt: hasFile ? quotaMtimeMs : null,
    fileChangedText: hasFile ? fileChangedLine(when(quotaMtimeMs)) : null,
  };
}

/** Claude and Codex always (the configured providers), then any other provider the file mentions, in the order found. */
function providerIds(q: QuotaData | null, s: DashboardSettings): string[] {
  const out: string[] = [];
  const add = (raw: unknown): void => {
    if (typeof raw !== "string" || raw === "") return;
    const id = clean(raw, ID_MAX_CHARS);
    if (id !== "" && !out.includes(id)) out.push(id);
  };
  for (const p of s.providers) add(p);
  if (q !== null) {
    for (const l of q.limits) add(l.provider);
    for (const b of q.modelBlocks) add(b.provider);
    for (const u of q.utilization) add(u.provider);
    for (const o of q.observations ?? []) add(o.provider);
  }
  return out;
}

/** Valid readings only: a finite non-negative number, a window name, and a reset time still ahead. The highest retained numeric reading is shown with its own reset; no fabricated combined row. */
function readWindows(
  q: QuotaData | null,
  provider: string,
  now: number,
  s: DashboardSettings,
  when: (ms: number) => string,
): AllowanceWindow[] {
  if (q === null) return [];
  const byWindow = new Map<string, AllowanceWindow>();
  for (const u of q.utilization) {
    if (typeof u.provider !== "string" || u.provider !== provider) continue;
    if (typeof u.window !== "string" || u.window === "" || !finite(u.utilization) || u.utilization < 0 || !finite(u.resetsAt) || u.resetsAt <= now) continue;
    const id = clean(u.window, ID_MAX_CHARS);
    const usedPercent = Math.round(u.utilization * 100);
    const resetsText = resetsLine(when(u.resetsAt));
    const previous = byWindow.get(id);
    if (previous && (previous.usedFraction > u.utilization ||
        (previous.usedFraction === u.utilization && previous.resetsAt >= u.resetsAt))) continue;
    byWindow.set(id, {
      id,
      label: windowLabel(id),
      usedFraction: u.utilization,
      usedPercent,
      fill: Math.min(1, u.utilization),
      overage: u.utilization > 1,
      resetsAt: u.resetsAt,
      resetsText,
      pauseAt: pauseAtFor(id, s),
      text: windowSummary(usedPercent, resetsText),
    });
  }
  return [...byWindow.values()].sort((a, b) => windowRank(a.id) - windowRank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Both ways the engine blocks a provider: a `limits` entry, and a paced window at or above its pause cap. The second
 * has no `limits` entry (src/quota.ts keeps the block in memory), so the pill would read "Plenty" without this.
 */
function blocksFor(q: QuotaData | null, provider: string, settings: DashboardSettings, now: number): Block[] {
  const blocks: Block[] = [];
  if (q !== null) {
    for (const l of q.limits) {
      if (typeof l.provider === "string" && l.provider === provider && finite(l.until) && l.until > now) {
        blocks.push({ end: l.until, kind: typeof l.kind === "string" ? l.kind : "unknown", fromLimit: true });
      }
    }
  }
  // Quota can retain multiple non-dominated rows for one window. Evaluate every real row independently.
  for (const u of q?.utilization ?? []) {
    if (u.provider !== provider || !finite(u.utilization) || u.utilization < 0 || !finite(u.resetsAt) || u.resetsAt <= now) continue;
    const kind = pacedKind(u.window);
    const cap = pauseAtFor(u.window, settings);
    if (kind !== undefined && cap !== null && u.utilization >= cap) blocks.push({ end: u.resetsAt, kind, fromLimit: false });
  }
  return blocks;
}

function noteFor(q: QuotaData | null, provider: string, windows: AllowanceWindow[], now: number, when: (ms: number) => string): string | null {
  let note: string | null = null;
  if (windows.length === 0) note = NOTE_NO_READING;
  else if (!windows.some((w) => w.id === "five_hour")) note = NOTE_NO_FIVE_HOUR;
  if (q !== null) {
    const ends = q.modelBlocks
      .filter((b) => typeof b.provider === "string" && b.provider === provider && finite(b.until) && b.until > now)
      .map((b) => b.until);
    if (ends.length > 0) {
      const sentence = noteModelLimited(when(Math.max(...ends)));
      note = note === null ? sentence : `${note} ${sentence}`;
    }
  }
  return note;
}

const UNKNOWN_WORDS: Record<AllowanceUnknownReason, string> = {
  missing: "reading is missing", ambiguous: "conflicting readings", malformed_utilization: "invalid usage reading",
  reset_missing: "reset time is missing", malformed_reset: "invalid reset time", implausible_reset: "implausible reset time",
  expired: "reset time has passed", missing_receipt: "receipt time was not recorded", malformed_receipt: "invalid receipt time",
  clock_rollback: "clock moved backwards", stale: "reading is older than 10 minutes",
};
