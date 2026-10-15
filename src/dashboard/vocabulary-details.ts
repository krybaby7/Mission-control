// The words of the detail modules: the wait text, the timeline, the allowance and the debrief (the results).
// vocabulary.ts re-exports this file, so there is still one vocabulary. Nothing in here reads a file or a clock; times
// arrive already formatted, so these functions are plain string builders.
import type { CheckedFacts } from "./modes.js";
import type { PillStateId, Said, TickId, Tone, VerdictId, WaitInfo } from "./types.js";

const open = "“";
const close = "”";

/**
 * `text` in curly quotes. A text that already starts with an opening mark or ends with a closing one carries its own, and
 * a second pair would give a doubled mark (““Title”: story”), so it is left as it is.
 */
export function inCurlyQuotes(text: string): string {
  const t = text.trim();
  return t.startsWith(open) || t.endsWith(close) ? text : `${open}${text}${close}`;
}

/** A name in curly quotes (feature and mission titles are names, not sentences). */
function name(title: string): string {
  return inCurlyQuotes(title);
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ───────────────────────────── Waiting (spec 4.6) ─────────────────────────────

export type WaitCauseId = WaitInfo["cause"];

export interface ParsedWait {
  cause: WaitCauseId;
  /** The AIs named by "needs a new login" parts ("Claude", "Codex"); empty when none is recognised. */
  loginAis: string[];
  /** What the sleep is for: the cause of the non-login parts (limits unless one of them is trouble). */
  base: "limits" | "trouble";
}

// One part of the reason: "<model>: <provider> needs a new login", "<model>: <provider> keeps failing (<text>), trying
// again at <ISO>" or "<model>: <kind> limit until <ISO>". The parts are joined with "; ", and the failure text of the
// second shape is free text that may hold a "; " itself, so the reason is read part by part and not split.
const ISO = "\\S+?";
const PART = new RegExp(
  `^(?:[^;]*?: (?<login>\\S+) needs a new login` +
    `|[^;]*?: \\S+ keeps failing \\(.*?\\), trying again at ${ISO}(?<trouble>)` +
    `|[^;]*?: (?<kind>session|weekly|model|spend|throttle|unknown) limit until ${ISO})(?:; |$)`,
);
const PROVIDER_WORDS: Record<string, string> = { claude: "Claude", codex: "Codex" };

/**
 * A table entry for a key that came from a file. `table[key]` would also answer for "constructor", "toString" or
 * "__proto__" (members of Object.prototype), so only the table's own entries count.
 */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** "Claude" or "Codex" for the provider ids the engine knows; undefined for any other word. */
export function aiName(provider: string): string | undefined {
  return own(PROVIDER_WORDS, provider);
}

/**
 * The cause of a wait, read from the shape of the `limit.wait` reason (src/executor.ts, waitReason). The engine does
 * not save a structured cause, so anything that does not match one of the three shapes is `unknown`.
 */
export function parseWaitReason(reason: string | null): ParsedWait {
  const unknown: ParsedWait = { cause: "unknown", loginAis: [], base: "limits" };
  if (reason === null || reason === "") return unknown;
  let login = false;
  let trouble = false;
  const loginAis: string[] = [];
  for (let rest = reason; rest !== ""; ) {
    const part = PART.exec(rest);
    if (part === null) return unknown;
    const groups = part.groups ?? {};
    if (groups.login !== undefined) {
      login = true;
      const word = aiName(groups.login);
      if (word !== undefined && !loginAis.includes(word)) loginAis.push(word);
    } else if (groups.trouble !== undefined || groups.kind === "throttle") {
      trouble = true;
    }
    rest = rest.slice(part[0].length);
  }
  loginAis.sort((a, b) => a.localeCompare(b));
  const base = trouble ? "trouble" : "limits";
  return { cause: login ? "login" : base, loginAis, base };
}

/** "Claude also needs a new login." / "Claude and Codex also need a new login." / "One AI also needs a new login." */
function loginSentence(loginAis: string[]): string {
  if (loginAis.length === 0) return "One AI also needs a new login.";
  return `${loginAis.join(" and ")} also ${loginAis.length === 1 ? "needs" : "need"} a new login.`;
}

export const RESUMES_BY_ITSELF = "It resumes by itself.";

/** "Waiting for allowance until 12:59." / "Waiting for the AI team to respond until 12:59." The time is already worded by the one time rule. */
export function waitLead(base: "limits" | "trouble", untilText: string): string {
  return base === "trouble" ? `Waiting for the AI team to respond until ${untilText}.` : `Waiting for allowance until ${untilText}.`;
}

/** The text of a wait. `untilText` is "" when no wake-up time is known (then the cause is unknown). */
export function waitText(parsed: ParsedWait, untilText: string): string {
  if (parsed.cause === "unknown" || untilText === "") {
    return untilText === "" ? "Waiting. Mission Control cannot tell why." : `Waiting until ${untilText}. Mission Control cannot tell why.`;
  }
  const lead = waitLead(parsed.base, untilText);
  if (parsed.cause === "login") return `${lead} ${loginSentence(parsed.loginAis)}`;
  return `${lead} ${RESUMES_BY_ITSELF}`;
}

/**
 * The WaitInfo of one `limit.wait` event (data.until ISO, data.reason). Without a usable time the wait is `unknown`
 * with until 0, as for a wait with no event at all. The raw reason is read here and never leaves this function.
 * `when` words the wake-up time by the one rule: "12:59" on the day of the snapshot, else "Wed 15:26", or "Mon 19 Oct 10:03"
 * from 6 days away (a wait can last days).
 */
export function waitInfoFromEvent(data: Record<string, unknown> | null, when: (ms: number) => string): WaitInfo & { loginAis: string[] } {
  const until = data !== null && typeof data.until === "string" ? Date.parse(data.until) : Number.NaN;
  if (!Number.isFinite(until)) return { until: 0, untilText: "", cause: "unknown", text: waitText({ cause: "unknown", loginAis: [], base: "limits" }, ""), loginAis: [] };
  const reason = data !== null && typeof data.reason === "string" ? data.reason : null;
  const parsed = parseWaitReason(reason);
  const untilText = when(until);
  return { until, untilText, cause: parsed.cause, text: waitText(parsed, untilText), loginAis: parsed.loginAis };
}

// ───────────────────────────── Allowance (spec 10) ─────────────────────────────


export const PILL_WORDS: Record<PillStateId, string> = {
  plenty: "Plenty",
  getting_low: "Getting low",
  nearly_out: "Nearly out",
  waiting_reset: "Waiting for reset",
  no_reading: "No reading yet",
};

/** Neutral, never a fault: the engine saves no reading until a runner reports one. */
export const NOTE_NO_READING = "No usage reading yet.";
/** A plan may have no 5-hour limit at all. */
export const NOTE_NO_FIVE_HOUR = "No 5-hour limit reported.";

export function noteModelLimited(untilText: string): string {
  return `One kind of model is limited until ${untilText}.`;
}

const PROVIDER_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", mock: "Test AI" };

/** `cleanedId` is the provider key from quota.json after cleaning; an unknown provider is shown as its id. */
export function providerLabel(cleanedId: string): string {
  return own(PROVIDER_LABELS, cleanedId) ?? cleanedId;
}

/** Window names are the runners' (no model names are ever shown). */
export function windowLabel(id: string): string {
  if (id === "five_hour") return "Next 5 hours";
  if (id === "seven_day") return "This week";
  if (id.startsWith("seven_day_")) return "This week, one kind of model";
  const minutes = /^(\d+)_minutes$/.exec(id);
  if (minutes !== null) {
    const n = Number(minutes[1]);
    if (n > 0 && n % 60 === 0) return `Next ${count(n / 60, "hour")}`;
    if (n > 0) return `Next ${count(n, "minute")}`;
  }
  return "Another limit";
}

export function resetsLine(when: string): string {
  return `resets ${when}`;
}

export function windowSummary(usedPercent: number, resets: string): string {
  return `${usedPercent}% used, ${resets}`;
}

const BLOCK_WHAT: Record<string, string> = {
  session: "the 5-hour limit",
  weekly: "the weekly limit",
  model: "a model limit",
  spend: "the spending cap",
  unknown: "a usage limit",
};

/**
 * "at 12:59" on the day of the snapshot, else the one time rule's text ("Thu 09:00", or "Mon 19 Oct 10:03" from 6 days
 * away). `when` is the Formatter's text of the block's end plus the engine's margin.
 */
export function resumeWhen(sameDay: boolean, when: string): string {
  return sameDay ? `at ${when}` : when;
}

export function limitedLine(kind: string, when: string): string {
  if (kind === "throttle") return `Waiting because the service is busy. Work resumes ${when}.`;
  return `Waiting for ${own(BLOCK_WHAT, kind) ?? BLOCK_WHAT.unknown} to reset. Work resumes ${when}.`;
}

/** `when` is the file's time by the one rule: "01:38" on the day of the snapshot, else "Wed 01:38", or "Mon 5 Oct 01:38" from 6 days away. */
export function fileChangedLine(when: string): string {
  return `Usage figures last changed at ${when}`;
}

// ───────────────────────────── The debrief, shown as the results (spec 11) ─────────────────────────────

export const VERDICT_WORDS: Record<VerdictId, string> = {
  done: "Done",
  partly_done: "Partly done",
  needs_you: "Needs you",
  paused: "Paused",
};

export const TICK_LABELS: Record<TickId, string> = {
  delivered: "Delivered",
  final_review: "Final review passed",
  nothing_open: "Nothing open",
  no_rework: "No rework",
};

export const DEBRIEF_ALLOWANCE_NOTE =
  "The AI work runs on your existing Claude and Codex plans, so there is no separate bill. This page cannot show your share of the week yet.";
export const DEBRIEF_HONESTY_NOTE = "These are the AI team's own checks, not a human review.";

/**
 * The honesty note when the checkpoint log of a mission with a feature checked by a second AI holds the owner's approval of one or
 * more features (docs/modes-spec.md, 11.4). `titles` are those features' titles, in file order. It says what the log holds, never that
 * the owner opened anything (M26). With no title the note is the constant above.
 */
export function honestyNoteFor(titles: readonly string[]): string {
  const [first, second] = titles;
  if (first === undefined) return DEBRIEF_HONESTY_NOTE;
  const one = titles.length === 1;
  const who = one ? name(first) : titles.length === 2 && second !== undefined ? `${name(first)} and ${name(second)}` : `${name(first)}, ${name(second ?? "")} and ${titles.length - 2} more`;
  return `These are the AI team's own checks. You were asked to look at ${who} and approved ${one ? "it" : "them"}.`;
}

export interface VerdictFacts {
  /** Features done, and all features. */
  done: number;
  total: number;
  stuck: number;
  leftOut: number;
  /** Question cards of the mission. */
  questions: number;
  /**
   * True only for a mission that has a feature checked by a second AI. Its sentences then say "built", and the list of results says
   * how each feature was checked, because "built and checked" would claim tests for a feature that no test checked. Absent otherwise.
   */
  modes?: boolean;
}

export function verdictSentence(id: VerdictId, v: VerdictFacts): string {
  switch (id) {
    case "done":
      if (v.total === 0) return "No features were planned.";
      if (v.modes === true) return v.total === 1 ? "The feature is built. The list below says how it was checked." : `All ${v.total} features are built. The list below says how each was checked.`;
      return v.total === 1 ? "The feature is built and checked." : `All ${v.total} features are built and checked.`;
    case "partly_done": {
      const built = v.modes === true ? `${v.done} of ${v.total} features are built.` : `${v.done} of ${v.total} features are built and checked.`;
      const parts = [v.done === v.total ? "Every feature is built, but the final check left something open." : built];
      if (v.stuck > 0) parts.push(`${v.stuck} ${v.stuck === 1 ? "feature is" : "features are"} stuck.`);
      if (v.stuck === 0 && v.leftOut > 0) parts.push(`${v.leftOut} ${v.leftOut === 1 ? "feature was" : "features were"} left out.`);
      if (v.questions > 0) parts.push(`${v.questions} ${v.questions === 1 ? "question is" : "questions are"} waiting for you.`);
      return parts.join(" ");
    }
    case "needs_you":
      return "It needs your help.";
    case "paused":
      return "Paused. It continues on the next run.";
  }
}

/** "3 missions: 1 done, 1 partly done, 1 needs your help." The counts are of the missions in the debrief. */
export function overallSentence(counts: Record<VerdictId, number>): string {
  const total = counts.done + counts.partly_done + counts.paused + counts.needs_you;
  const parts: string[] = [];
  if (counts.done > 0) parts.push(`${counts.done} done`);
  if (counts.partly_done > 0) parts.push(`${counts.partly_done} partly done`);
  if (counts.paused > 0) parts.push(`${counts.paused} paused`);
  if (counts.needs_you > 0) parts.push(`${counts.needs_you} ${counts.needs_you === 1 ? "needs" : "need"} your help`);
  return `${total} missions: ${parts.join(", ")}.`;
}

export function plannedLine(total: number): string {
  return total === 0 ? "No features planned" : `${count(total, "feature")} planned`;
}

export interface DeliveredFacts extends VerdictFacts {
  /** Features not built yet in a paused mission. */
  unbuilt: number;
  paused: boolean;
  /** How each finished feature was checked; only for a mission that has a feature checked by a second AI (then `modes` is true). */
  checked?: readonly CheckedFacts[];
}

export function deliveredWhy(yes: boolean, v: DeliveredFacts): string {
  if (v.total === 0) return "No features were planned.";
  const how = v.modes === true && v.checked !== undefined ? v.checked : null;
  if (yes) {
    if (how !== null && how.length > 0) {
      const [only] = how;
      return only !== undefined && how.length === 1 && v.total === 1
        ? `The feature was built. It was checked ${checkedGroupWords(only)}.`
        : `All ${v.total} features were built. How they were checked: ${checkedSummary(how)}.`;
    }
    return v.total === 1 ? "The feature was built and checked." : `All ${v.total} features were built and checked.`;
  }
  const parts = [v.modes === true ? `${v.done} of ${v.total} features were built.` : `${v.done} of ${v.total} features were built and checked.`];
  if (how !== null && how.length > 0) parts.push(`How the finished ones were checked: ${checkedSummary(how)}.`);
  if (v.stuck > 0) parts.push(`${v.stuck} ${v.stuck === 1 ? "is" : "are"} stuck.`);
  if (v.leftOut > 0) parts.push(`${v.leftOut} ${v.leftOut === 1 ? "was" : "were"} left out.`);
  if (v.paused && v.unbuilt > 0) parts.push(`${v.unbuilt} not finished yet.`);
  return parts.join(" ");
}

export type FinalReviewWhy =
  | { kind: "passed" }
  | { kind: "not_run" }
  | { kind: "unreadable" }
  | { kind: "review_unfinished" }
  | { kind: "tests_failed"; baselineBroken: boolean }
  | { kind: "blocking"; count: number };

/** `noTests`: no finished feature of the mission is checked by tests, so the final check is not told as one of tests (docs/modes-spec.md, 10.3). */
export function finalReviewWhy(w: FinalReviewWhy, noTests = false): string {
  switch (w.kind) {
    case "passed":
      return "The final review ran and found no serious problem.";
    case "not_run":
      return "The final check did not run.";
    case "unreadable":
      return "The result of the final check could not be read.";
    case "review_unfinished":
      return "The final review did not finish, so nobody reviewed the whole app.";
    case "tests_failed":
      // With a red baseline the engine judges the final check by the regression run of the new features' tests.
      if (noTests) return w.baselineBroken ? "The project's checks did not all pass together on the final result." : "The final checks of the whole app did not all pass.";
      return w.baselineBroken ? "The new features' tests did not all pass together on the final result." : "The final tests of the whole app did not all pass.";
    case "blocking":
      return `The final review found ${w.count} serious ${w.count === 1 ? "problem that was" : "problems that were"} not fixed.`;
  }
}

/**
 * The caveat on the Final review passed tick; null when no part applies. `unreviewed` is the count of features merged without their own
 * review. `noTests` is how many finished features no test checked, counted only for a mission that has a feature checked by a second AI
 * (docs/modes-spec.md, 11.4); it adds the sentence that sends the reader to the list of results.
 */
export function finalReviewCaveat(unreviewed: number, coveredOnly: number | null, noTests = 0): string | null {
  const parts: string[] = [];
  if (unreviewed > 0) parts.push(`${unreviewed} ${unreviewed === 1 ? "feature was" : "features were"} merged without ${unreviewed === 1 ? "its" : "their"} own review.`);
  if (coveredOnly !== null) parts.push(`It covered only the ${coveredOnly} ${coveredOnly === 1 ? "feature" : "features"} that ${coveredOnly === 1 ? "was" : "were"} built.`);
  if (noTests > 0) parts.push(noTests === 1 ? "1 feature has no tests. The list below says how it was checked." : `${noTests} features have no tests. The list below says how each was checked.`);
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * The notes the engine writes when a feature's own review did not finish (src/dispatcher.ts): "The review of “Title” did not finish, so
 * it was merged after passing its checks." and, for a feature checked by a second AI, "... after passing Mission Control's own checks
 * only." Straight or curly marks around the title, either ending (docs/modes-spec.md, 11.1).
 */
export const UNFINISHED_REVIEW_NOTE = /^The review of ["\u201C].*["\u201D] did not finish, so it was merged after passing (?:its checks|Mission Control's own checks only)\.$/;

export function nothingOpenWhy(openItems: number, baselineBroken: boolean): string {
  if (openItems === 0 && !baselineBroken) return "Nothing is waiting for you.";
  const parts: string[] = [];
  if (openItems > 0) parts.push(openItems === 1 ? "1 item is waiting for you." : `${openItems} items are waiting for you.`);
  if (baselineBroken) parts.push("The project's own checks were already failing.");
  return parts.join(" ");
}

export function noReworkWhy(yes: boolean, recovered: number): string {
  if (!yes) return "The final check sent the team back for a repair round.";
  const base = "The final check did not send the team back for a repair round.";
  return recovered > 0 ? `${base} ${recovered} ${recovered === 1 ? "feature needed" : "features needed"} a retry first.` : base;
}

/** "about 35 min of AI work", "about 2 h 10 min of AI work", "less than a minute of AI work". */
export function agentTimeLine(ms: number): string {
  if (ms < 60_000) return "less than a minute of AI work";
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `about ${m} min of AI work`;
  return m === 0 ? `about ${h} h of AI work` : `about ${h} h ${m} min of AI work`;
}

// ───────────────────────────── How a feature was checked (docs/modes-spec.md, 10.1 and 11.4) ─────────────────────────────
// The dashboard's own copy of the engine's table (src/checked-by.ts), in shorter words. The rule for every line: never "tested" or
// "passed its tests" for a feature that no test checked; "approved by you" is what the checkpoint log holds, never "you looked at it";
// "a second AI", never "a different AI"; "Mission Control's own checks" for the scripts and "the project's own checks" for the app's.

const QUEUED_WITHOUT_LOOK = "queued without a stop for your look";

/** The line under a finished feature in "What you got". */
export function checkedByWords(h: CheckedFacts): string {
  const ending = h.approved ? "; approved by you" : h.queuedWithoutLook ? `; ${QUEUED_WITHOUT_LOOK}` : "";
  switch (h.row) {
    case 1:
      return "Checked by tests; approved by you";
    case 2:
      return `Checked by the project's own checks only; no tests were written${h.approved ? "; approved by you" : ""}`;
    case 3:
      return "Checked by tests";
    case 4:
      return `Checked by Mission Control's own checks only; the second AI's check did not finish${ending}`;
    case 5:
      return `Checked by a second AI against your list; ${count(h.unmet, "check was", "checks were")} not met${ending}`;
    case 6:
      return `Checked by a second AI against your list; ${count(h.unjudged, "check was", "checks were")} not judged${ending}`;
    case 7:
      return `Checked by a second AI against your list${ending}`;
  }
}

/**
 * The same facts as a phrase that follows "It was checked" or a count ("2 by tests"): no semicolon and no comma inside, so a list of
 * groups reads cleanly. A row 7 feature that the owner approved is "by a second AI and approved by you".
 */
export function checkedGroupWords(h: CheckedFacts): string {
  const approved = h.approved ? " and approved by you" : "";
  const queued = !h.approved && h.queuedWithoutLook ? QUEUED_WITHOUT_LOOK : null;
  const inBrackets = (...parts: (string | null)[]): string => {
    const kept = parts.filter((p): p is string => p !== null);
    return kept.length === 0 ? "" : ` (${kept.join("; ")})`;
  };
  switch (h.row) {
    case 1:
      return "by tests and approved by you";
    case 2:
      return `by the project's own checks only${approved}`;
    case 3:
      return "by tests";
    case 4:
      return `by Mission Control's own checks only${inBrackets(queued)}${approved}`;
    case 5:
      return `by a second AI against your list${inBrackets(`${count(h.unmet, "check", "checks")} not met`, queued)}${approved}`;
    case 6:
      return `by a second AI against your list${inBrackets(`${count(h.unjudged, "check", "checks")} not judged`, queued)}${approved}`;
    case 7:
      return h.approved ? "by a second AI and approved by you" : `by a second AI against your list${inBrackets(queued)}`;
  }
}

/**
 * "1 by tests, 1 by a second AI against your list, 1 by a second AI and approved by you": the groups of equal words with their counts,
 * in the order of the rows (an approved group of row 1 sits with its base, row 3; an approved group follows its unapproved one).
 */
export function checkedSummary(list: readonly CheckedFacts[]): string {
  const groups = new Map<string, { rank: number; approved: boolean; n: number }>();
  for (const h of list) {
    const words = checkedGroupWords(h);
    const group = groups.get(words);
    if (group === undefined) groups.set(words, { rank: h.row === 1 ? 3 : h.row, approved: h.approved, n: 1 });
    else group.n += 1;
  }
  return [...groups.entries()]
    .sort(([wa, a], [wb, b]) => a.rank - b.rank || Number(a.approved) - Number(b.approved) || (wa < wb ? -1 : wa > wb ? 1 : 0))
    .map(([words, g]) => `${g.n} ${words}`)
    .join(", ");
}

// ───────────────────────────── Reasons (spec 4.5, 9.2, 9.3) ─────────────────────────────
// The timeline shows why a feature is stuck and why a mission failed. A text is the engine's only when it matches a
// string the engine writes in full; the default is `ai`, which the page labels.

const FEATURE_REASONS: { exact?: string; start?: RegExp; shown: string }[] = [
  { exact: "tried every escalation step, but its checks still failed", shown: "The AI team tried every step it has, and the checks still failed." },
  // A feature checked by a second AI (docs/modes-spec.md, 5.2 and 11.1). The first problem that follows the colon is plan or file text and is never shown.
  { start: /^tried every escalation step, but Mission Control's own checks still failed/, shown: "The AI team tried every step it has, and Mission Control's own checks still failed." },
  {
    exact: "no acceptance tests could be written for it, and the project's own checks were already failing, so nothing could check it",
    shown: "It could not be checked: no tests could be written, and the project's own checks were already failing.",
  },
  { exact: "its changes conflicted with work merged earlier (merge conflict)", shown: "Its changes clashed with work that was already put together." },
  { start: /^merging it failed: /, shown: "Putting it together with the rest failed." },
  { exact: "its checked work did not end up in the mission branch when it was merged", shown: "Its checked work did not make it into the app." },
  { start: /^internal error: /, shown: "Something went wrong inside Mission Control while working on it." },
  {
    start: /^Mission Control stopped unexpectedly \d+ times while working on it/,
    shown: "Mission Control kept stopping while it worked on this (for example a restart or a failure).",
  },
  { start: /^the mission reached its safety cap of \d+ agent runs/, shown: "The mission used up its safety limit of AI runs before this was finished." },
  { exact: "it needs a decision from you", shown: "The AI team needs a decision from you." },
  // A feature the owner sent back once too often (src/dispatcher.ts, limitReached).
  { exact: "you asked for changes twice and it still was not right", shown: "You asked for changes twice and it still was not right, so it was set aside." },
];

/** The engine writes curly marks around the title now (`waiting on “Title”, which was blocked`); missions from before wrote straight ones. */
const WAITING_ON = /^waiting on ["“](.+)["”], which was (blocked|skipped)$/;

/** `reason` is a feature's blockedReason, already cleaned. */
export function explainFeatureReason(reason: string): Said {
  for (const row of FEATURE_REASONS) {
    if ((row.exact !== undefined && reason === row.exact) || (row.start !== undefined && row.start.test(reason))) return { text: row.shown, author: "engine" };
  }
  const waiting = WAITING_ON.exec(reason);
  if (waiting !== null) {
    return { text: `It needed ${name(waiting[1] ?? "")}, which ${waiting[2] === "blocked" ? "is stuck" : "was left out"}.`, author: "engine" };
  }
  return { text: reason, author: "ai" };
}

/** The engine's failure when no AI can run because of logins (src/dispatcher.ts, end()): "No model could run: claude and codex need a new login." */
const LOGIN_FAILURE = /^No model could run: (.+) needs? a new login\.$/;

/** The AIs a login failure names ("Claude", "Codex"); empty when it names none the engine knows. Not a login failure: null. */
export function loginFailureAis(reason: string): string[] | null {
  const m = LOGIN_FAILURE.exec(reason);
  if (m === null) return null;
  const names = (m[1] ?? "").split(" and ").flatMap((p) => aiName(p.trim()) ?? []);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

const FAILURE_REASONS: { test: RegExp; shown: string }[] = [
  { test: /^Unknown profile /, shown: "The mission asks for an AI setup that does not exist." },
  { test: /is not a git repository\.$/, shown: "The app's folder is not set up for version history." },
  { test: /is a shallow clone\.$/, shown: "The app's folder only has part of its version history." },
  { test: /^Could not work out how to check this project/, shown: "The AI could not work out how to run this project's checks." },
  { test: /^The plan could not be made/, shown: "The AI could not make a workable plan from the request." },
  { test: /^The app scaffold never passed its checks/, shown: "The app's foundation never passed its checks." },
  { test: /^The project's own checks already fail/, shown: "The project's own checks already fail, and they could not be used to check new work." },
  { test: /^Mission Control stopped unexpectedly \d+ times/, shown: "Mission Control kept stopping at one step (for example a restart or a failure)." },
  { test: /^Internal error in stage /, shown: "Something went wrong inside Mission Control. The work so far is kept." },
  // The plan was sent back once too often (src/dispatcher.ts, limitReached): the engine's own plain sentence, shown as it is.
  {
    test: /^You asked for changes to the plan twice and sent it back a third time/,
    shown: "You asked for changes to the plan twice and sent it back a third time, so Mission Control stopped before building anything.",
  },
];

/** `reason` is a mission's failure reason, already cleaned. */
export function explainFailureReason(reason: string): Said {
  const logins = loginFailureAis(reason);
  if (logins !== null) {
    const who = logins.length === 0 ? "Claude or Codex has" : `${logins.join(" and ")} ${logins.length === 1 ? "has" : "have"}`;
    return { text: `A login has expired. ${who} to be logged in again on the PC.`, author: "engine" };
  }
  const row = FAILURE_REASONS.find((r) => r.test.test(reason));
  return row === undefined ? { text: reason, author: "ai" } : { text: row.shown, author: "engine" };
}

export type StopKind = "deadline" | "stop_requested" | "disk" | "ai_failing" | "unknown";

/**
 * The engine records the reason "stop requested" for a stop file, a signal AND the stop time of `mc run --until`: the
 * run's stop control aborts on all three and every check throws the same error first (src/run.ts, StopControl.poll).
 * So the data cannot tell a request from the clock, and the words must not either.
 */
export const PAUSED_WHEN_TOLD_TO_STOP = "Paused because a stop was requested or the stop time came.";
/** Only the wait that would end after the stop time writes the reason "deadline" (src/executor.ts, waitForCandidate). */
export const PAUSED_NO_AI_BEFORE_STOP = "Paused: no AI would be free before the stop time.";

/** Why a mission paused, from the reason of its `mission.stopped` event (case-insensitive; the first row that matches wins). */
export function stopReasonKind(reason: unknown): StopKind {
  if (typeof reason !== "string") return "unknown";
  const r = reason.toLowerCase();
  if (r.includes("disk is almost full") || r.includes("no space left")) return "disk";
  if (r.includes("keep failing") || r.includes("keeps failing") || r.includes("kept refusing")) return "ai_failing";
  if (r.includes("deadline")) return "deadline";
  if (r.includes("stop requested")) return "stop_requested";
  return "unknown";
}

// ───────────────────────────── Timeline (spec 7.1) ─────────────────────────────
// One sentence per event type. `t` is a mission title and `f` a feature title; both are names and get curly quotes here.

export const A_FEATURE = "a feature";

export const TL = {
  missionStart: (t: string) => `Started working on ${name(t)}.`,
  missionResume: (t: string) => `Picked ${name(t)} up again where it left off.`,
  missionRetry: (t: string) => `Trying ${name(t)} again.`,
  missionStopped(kind: StopKind, t: string): { text: string; tone: Tone } {
    switch (kind) {
      case "deadline":
        return { text: `${PAUSED_NO_AI_BEFORE_STOP} ${name(t)} continues on the next run.`, tone: "warn" };
      case "stop_requested":
        return { text: `${PAUSED_WHEN_TOLD_TO_STOP} ${name(t)} continues on the next run.`, tone: "warn" };
      case "disk":
        return { text: `Paused: the disk is almost full. ${name(t)} continues once there is space.`, tone: "bad" };
      case "ai_failing":
        return { text: `Paused: the AI team kept failing. ${name(t)} continues on the next run.`, tone: "bad" };
      case "unknown":
        return { text: `Paused. ${name(t)} continues on the next run.`, tone: "warn" };
    }
  },
  missionFailed: (t: string) => `${name(t)} needs your help.`,
  missionEnd(status: unknown, t: string): { text: string; tone: Tone } {
    if (status === "done") return { text: `Finished ${name(t)}: done.`, tone: "good" };
    if (status === "partial") return { text: `Finished ${name(t)}: partly done.`, tone: "warn" };
    return { text: `Finished ${name(t)}.`, tone: "info" };
  },
  buildingFinished: "The building is finished. Starting the final check.",
  repairRound: "The final check found problems. Starting a repair round.",
  buildingSkipped: "Skipped the rest of the building and moved on to the final steps.",
  featureStarted: (f: string) => `Started on ${name(f)}.`,
  featureBuilt: (f: string) => `${name(f)} is built. A second AI is reviewing it.`,
  featureStuck: (f: string) => `${name(f)} is stuck.`,
  featureLeftOut: (f: string) => `${name(f)} was left out because it needed a stuck feature.`,
  foundationReady: "The app's foundation is ready.",
  foundationRetry: "The first try at the app's foundation did not pass. Trying again.",
  /**
   * `step` is the ladder step the failed attempt used (its recorded rung plus one: the attempt says so itself) and `of`
   * the ladder's size; null when the attempt or the feature is not known. The next step is not stated: the engine can
   * jump ahead to the diagnosis step after a repeated failure, so it cannot be told from this event.
   */
  reinforcements(f: string, step: number | null, of: number | null): string {
    const lead = `${name(f)} did not pass its checks`;
    if (step === null || of === null) return `${lead}. Calling in reinforcements.`;
    return step >= of ? `${lead} (step ${of} of ${of}). All steps are used.` : `${lead} (step ${Math.max(1, step)} of ${of}). Calling in reinforcements.`;
  },
  diagnosed: (f: string) => `An expert AI looked at why ${name(f)} keeps failing.`,
  diagnosisFailed: (f: string) => `The expert diagnosis of ${name(f)} did not finish.`,
  fixFailed: (f: string) => `A fix for the review's concerns on ${name(f)} did not pass and was undone.`,
  finalTestsPassed: "The final tests of the whole app passed.",
  finalTestsFailed: "The final tests of the whole app failed.",
  baselineSuiteFailed: "The project's own full test suite failed. It was already failing before this work started.",
  newFeatureTestsPassed: "The tests of the new features passed together on the final result.",
  newFeatureTestsFailed: "The tests of the new features did not all pass together on the final result.",
  // The same final steps for a mission that has features checked by a second AI and none checked by tests (docs/modes-spec.md, 11.5).
  finalChecksPassed: "The final checks of the whole app passed.",
  finalChecksFailed: "The final checks of the whole app failed.",
  baselineChecksFailed: "The project's own full check failed. It was already failing before this work started.",
  projectChecksPassed: "The project's checks passed on the final result.",
  projectChecksFailed: "The project's checks did not all pass together on the final result.",
  checkTimedOut: (f: string | null) => (f === null ? "A check took too long and was stopped." : `A check on ${name(f)} took too long and was stopped.`),
  merged: (f: string) => `${name(f)} is built and checked.`,
  /** A feature checked by a second AI: it was not checked by tests, so the row only says it was added. */
  mergedByReading: (f: string) => `${name(f)} is added.`,
  aiStepUnfinished: (f: string | null) =>
    f === null ? "An AI step did not finish. It ran too long or stopped working." : `An AI step on ${name(f)} did not finish. It ran too long or stopped working.`,
  loginExpired: "A login has expired.",
  internalError: (f: string | null) =>
    f === null
      ? "Something went wrong inside Mission Control. The work so far is kept."
      : `Something went wrong inside Mission Control while working on ${name(f)}. The work so far is kept.`,
  planReady: (n: number, revised: boolean) => `The plan ${revised ? "was revised" : "is ready"}: ${count(n, "feature")}.`,
  testsWritten: (f: string, files: number) =>
    files === 1
      ? `Wrote 1 check that ${name(f)} must pass. The AI that builds it cannot change it.`
      : `Wrote ${files} checks that ${name(f)} must pass. The AI that builds it cannot change them.`,
  testsStray: (f: string) => `While writing the checks for ${name(f)}, an AI changed files it should not. The changes were undone.`,
  frozenReverted: (f: string) => `While building ${name(f)}, an AI changed the checks it must pass. The change was undone.`,
  repairFeatureAdded: "The final check found problems, so a repair feature was added.",
  runInterrupted: "Work was cut off by a restart or a failure. That step is tried again.",
  versionSettingsRestored: "An AI changed the app's version-control settings. The change was undone.",
  // The checks the owner asked for (docs/checkpoints-spec.md, 12). `f` is a feature title, null when the file does not have it.
  // The owner's note and the proof of an answer are never part of a sentence.
  checkpointParked(kind: string, t: string, f: string | null): string {
    return kind === "plan" ? `Waiting for your check of the plan for ${name(t)}.` : kind === "final" ? "Waiting for your check of the finished app." : `Waiting for your check of ${f === null ? A_FEATURE : name(f)} before it is added.`;
  },
  checkpointAnswered(decision: unknown, kind: string, t: string, f: string | null): { text: string; tone: Tone } {
    const subject = kind === "plan" ? "the plan" : kind === "final" ? "the finished app" : f === null ? A_FEATURE : name(f);
    if (decision === "approve") return { text: `You approved ${subject}. ${name(t)} carries on when the next run starts.`, tone: "good" };
    const then = kind === "plan" ? "It is revised and shown to you again." : kind === "final" ? "Your change is added and shown to you again." : "It is changed and shown to you again.";
    return { text: `You sent ${subject} back. ${then}`, tone: "info" };
  },
  checkpointReworked(ok: boolean, kind: string, f: string | null): { text: string; tone: Tone } {
    if (!ok) return { text: "Your change could not be made. The earlier version is shown again.", tone: "warn" };
    return { text: kind === "plan" ? "The plan was revised after your note." : kind === "final" ? "A new feature was added for your change." : `${f === null ? "A feature" : name(f)} was changed after your note.`, tone: "info" };
  },
  checkpointLimit: (t: string, kind?: string, f?: string | null) =>
    kind === "feature" && f != null ? `You sent ${name(f)} back twice before, so it is set aside. The rest carries on. The report says what to do.` : `You sent this back twice before, so ${name(t)} stops here. The report says what to do.`,
  checkpointRejected: (t: string) => `An answer to the check of ${name(t)} was ignored because it did not match. The check is still waiting.`,
  // A feature checked by a second AI (docs/modes-spec.md, 11.2). Counts only, never a check, a file name or the AI's words.
  deliverableProblems: (f: string) => `Mission Control's own checks of ${name(f)} found problems. The AI is asked to fix them.`,
  rubricAnswered(f: string, pass: number, fail: number, unjudged: number): { text: string; tone: Tone } {
    const total = pass + fail + unjudged;
    let text = `A second AI checked ${name(f)} against your list: ${pass} of ${total} ${total === 1 ? "check" : "checks"} passed.`;
    if (fail > 0) text += ` ${fail} ${fail === 1 ? "needs" : "need"} a fix.`;
    if (unjudged > 0) text += ` ${unjudged} could not be judged.`;
    return { text, tone: fail === 0 && unjudged === 0 && total > 0 ? "good" : "warn" };
  },
  picturesTaken: (f: string) => `Pictures of ${name(f)} were taken at phone width and desktop width.`,
  picturesNone: (f: string) => `No pictures of ${name(f)} could be taken.`,
} as const;
