// The one vocabulary of the dashboard (docs/dashboard-spec.md, 4): every word and sentence a person reads, and the
// time formatter. No other module contains user-facing prose. Nothing in here reads a file or a clock.
//
// The detail modules (timeline, allowance, debrief and the wait text) keep their wording in vocabulary-details.ts, which
// is re-exported here, so there is still one vocabulary.
import { DATE_FORM_AFTER_MS, MAX_TIME_MS } from "./constants.js";
import type {
  FeatureStateId,
  Lamp,
  LampStateId,
  MissionStateId,
  PausedWhy,
  ProgressStepId,
  WaitInfo,
} from "./types.js";
import { PAUSED_NO_AI_BEFORE_STOP, PAUSED_WHEN_TOLD_TO_STOP, RESUMES_BY_ITSELF, waitLead } from "./vocabulary-details.js";

export * from "./vocabulary-details.js";

// ───────────────────────────── Time ─────────────────────────────

export interface Formatter {
  /** "09:58" (24-hour, midnight is "00:05"). */
  time(ms: number): string;
  /** "09:58:30". */
  clock(ms: number): string;
  /** "Sun 11 Oct". */
  day(ms: number): string;
  /** "Sun": the short weekday. */
  weekday(ms: number): string;
  /** Whether `ms` falls on the same local day as `now`. */
  sameDay(ms: number, now: number): boolean;
  /**
   * The one rule of every wait, reset and change time: "15:26" when `ms` is on the same local day as `now` (the
   * snapshot's generatedAt), else the weekday and the time, "Wed 15:26" (a wait can last days, and "until 15:26" reads
   * as today). From DATE_FORM_AFTER_MS (6 days) away, in either direction, the date too: "Mon 19 Oct 10:03", because
   * a weekday alone repeats every week.
   */
  when(ms: number, now: number): string;
  /** An age as "12 s ago", "2 min ago", "2 h 43 min ago". Takes the age in milliseconds. */
  ago(ms: number): string;
  /** A length of time as "45 s", "9 min", "2 h 43 min". Takes milliseconds; negative counts as 0. */
  span(ms: number): string;
}

/** Every time text of the snapshot is made here, in one time zone (the process one when none is given). */
export function makeFormatter(timeZone?: string): Formatter {
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const hms = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" });
  const weekdayFormat = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" });
  // The year is part of the key: the same weekday and date a year apart are not the same day.
  const dayKey = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  const span = (ms: number): string => {
    const total = Math.max(0, Math.floor(ms / 1000));
    if (total < 60) return `${total} s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  };
  // Intl throws a RangeError for a time a date cannot hold; a text that cannot be made is "" and never takes the page down.
  const shows = (ms: number): boolean => Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_MS;
  const sameDay = (ms: number, now: number): boolean => shows(ms) && shows(now) && dayKey.format(ms) === dayKey.format(now);
  const weekday = (ms: number): string => (shows(ms) ? weekdayFormat.format(ms).replace(",", "") : "");
  return {
    time: (ms) => (shows(ms) ? hm.format(ms) : ""),
    clock: (ms) => (shows(ms) ? hms.format(ms) : ""),
    // en-GB prints "Sun, 11 Oct" in some ICU versions: the comma is dropped so the text is the same everywhere.
    day: (ms) => (shows(ms) ? dayFormat.format(ms).replace(",", "") : ""),
    weekday,
    sameDay,
    when: (ms, now) => {
      if (!shows(ms)) return "";
      if (sameDay(ms, now)) return hm.format(ms);
      const dateForm = shows(now) && Math.abs(ms - now) >= DATE_FORM_AFTER_MS;
      return `${dateForm ? dayFormat.format(ms).replace(",", "") : weekday(ms)} ${hm.format(ms)}`;
    },
    ago: (ms) => `${span(ms)} ago`,
    span,
  };
}

// ───────────────────────────── Small helpers ─────────────────────────────

/** A mission or feature title is a name, so it gets curly quotes in every displayed sentence. */
function quoted(title: string): string {
  return `“${title}”`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The first letter upper-cased when it is a lowercase letter ("“Recipe box” needs..." stays as it is). */
export function capitalise(text: string): string {
  return text.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

// ───────────────────────────── The lamp (spec 4.1, 5.5) ─────────────────────────────

export const LAMP_WORDS: Record<LampStateId, string> = {
  on_track: "On track",
  needs_look: "Needs a look",
  needs_you_now: "Needs you now",
  idle: "Idle",
  not_responding: "Not responding",
};

export const NOT_UPDATING_TEXT = "Not updating";

/** The two lamps the page shows on its own clock (spec 5.5). The server's lamp is never one of them. */
export function pageLamps(): { notUpdating: Lamp; notResponding: Lamp } {
  return {
    notUpdating: {
      state: "needs_look",
      word: LAMP_WORDS.needs_look,
      sentence: "Not updating. The page has had no news for a while.",
      reasons: [{ code: "page_stale", severity: "look", text: "the page has had no news for a while", missionId: null, featureId: null }],
    },
    notResponding: {
      state: "not_responding",
      word: LAMP_WORDS.not_responding,
      sentence: "No news for 5 minutes. The last known state is shown greyed out.",
      reasons: [{ code: "no_news", severity: "look", text: "no news for 5 minutes", missionId: null, featureId: null }],
    },
  };
}

// ───────────────────────────── Missions and features (spec 4.2 to 4.6) ─────────────────────────────

export const MISSION_WORDS: Record<MissionStateId, string> = {
  not_started: "Not started",
  working: "Working",
  waiting: "Waiting",
  paused: "Paused",
  done: "Done",
  partly_done: "Partly done",
  needs_you: "Needs you",
  unknown: "Needs a look",
};

export const FEATURE_WORDS: Record<FeatureStateId, string> = {
  waiting_turn: "Waiting its turn",
  being_built: "Being built",
  being_reviewed: "Being reviewed",
  done: "Done",
  stuck: "Stuck",
  left_out: "Left out",
  paused: "Paused",
  unknown: "Needs a look",
};

export const PROGRESS_WORDS: Record<ProgressStepId, string> = {
  plan: "Plan",
  plan_check: "Plan check",
  build: "Build",
  final_check: "Final check",
  landed: "Landed",
};

export function kindWord(kind: "new_app" | "change"): string {
  return kind === "new_app" ? "new app" : "change";
}

export const SENTENCE_UNREADABLE = "Its file cannot be read.";
export const SENTENCE_UNKNOWN = "This page does not know this state.";

export interface MissionSentenceFacts {
  state: MissionStateId;
  stage: string;
  pausedWhy: PausedWhy | null;
  /** A saved busy mission left over from an earlier run, under a live run (spec 4.2). */
  staleBusy: boolean;
  /** WaitInfo.text, for the state waiting. */
  waitText: string | null;
  /** Features, the position of the one in progress, features not built yet, done, stuck and left out. */
  n: number;
  k: number;
  u: number;
  d: number;
  stuck: number;
  leftOut: number;
  /** The checkpoint of a mission saved as stopped on one (pausedWhy checkpoint); null otherwise. */
  checkpoint?: CheckpointWords | null;
}

/** What the words about a checkpoint need to know (the dashboard's CheckpointFacts fits). */
export interface CheckpointWords {
  state: "pending" | "answered";
  kind: "plan" | "feature" | "final";
  /** The title of the feature a feature checkpoint is about; null when there is none or the file has no such feature. */
  featureTitle: string | null;
}

/** What is being looked at, for a sentence: "the plan", "“Add shout”", "the finished app". */
function checkpointSubject(kind: CheckpointWords["kind"], featureTitle: string | null): string {
  return kind === "plan" ? "the plan" : kind === "final" ? "the finished app" : featureTitle === null ? "a feature" : quoted(featureTitle);
}

const WORKING_SENTENCES: Record<string, string> = {
  onboard: "Reading the existing project.",
  spec: "Writing the plan.",
  gate_a: "Checking the plan.",
  init: "Setting up the app's foundation.",
  gate_c: "Doing the final check of the whole app.",
  finalize: "Landing the work and writing the report.",
};

function waitingForRun(u: number, n: number): string {
  return `${u} of ${n} ${n === 1 ? "feature is" : "features are"} waiting for the next run.`;
}

/** One line on a mission (spec 4.6). */
export function missionSentence(x: MissionSentenceFacts): string {
  switch (x.state) {
    case "not_started":
      return "It starts with the next run.";
    case "working":
      if (x.stage === "features") return x.n === 0 ? "Building the features." : `Building feature ${x.k} of ${x.n}.`;
      return (Object.hasOwn(WORKING_SENTENCES, x.stage) ? WORKING_SENTENCES[x.stage] : undefined) ?? "Working.";
    case "waiting":
      return x.waitText ?? "Waiting.";
    case "paused":
      switch (x.pausedWhy) {
        case "deadline":
          return x.u === 0 ? `${PAUSED_NO_AI_BEFORE_STOP} It continues on the next run.` : `${PAUSED_NO_AI_BEFORE_STOP} ${waitingForRun(x.u, x.n)}`;
        case "stop_requested":
          return x.u === 0 ? `${PAUSED_WHEN_TOLD_TO_STOP} It continues on the next run.` : `${PAUSED_WHEN_TOLD_TO_STOP} ${waitingForRun(x.u, x.n)}`;
        case "disk":
          return "Paused: the disk is almost full.";
        case "ai_failing":
          return "Paused: the AI team kept failing.";
        case "checkpoint":
          return x.checkpoint?.state === "answered"
            ? "You answered. It continues on the next run."
            : x.checkpoint
              ? `Waiting for your check of ${checkpointSubject(x.checkpoint.kind, x.checkpoint.featureTitle)}.`
              : "Paused. It continues on the next run.";
        case "unexpected":
          return x.staleBusy
            ? "Paused: its earlier run stopped unexpectedly. It continues when its turn comes."
            : "Paused: the run stopped unexpectedly. The work so far is kept and continues on the next run.";
        default:
          return "Paused. It continues on the next run.";
      }
    case "done":
      return x.n === 1 ? "The feature is built and checked." : `All ${x.n} features are built and checked.`;
    case "partly_done": {
      if (x.n === 0) return "Nothing was built.";
      if (x.d === x.n) return "Every feature is built, but the final check left something open.";
      const parts = [`${x.d} of ${x.n} features are built and checked.`];
      if (x.stuck > 0) parts.push(`${x.stuck} ${x.stuck === 1 ? "feature is" : "features are"} stuck.`);
      if (x.leftOut > 0) parts.push(`${x.leftOut} ${x.leftOut === 1 ? "feature was" : "features were"} left out.`);
      return parts.join(" ");
    }
    case "needs_you":
      return "It needs your help.";
    case "unknown":
      return SENTENCE_UNKNOWN;
  }
}

/** "2 of 4 features done"; "No features planned yet" without any. */
export function featuresLine(done: number, total: number): string {
  return total === 0 ? "No features planned yet" : `${done} of ${total} ${total === 1 ? "feature" : "features"} done`;
}

export const REASON_PAUSED = "Paused. It continues on the next run.";
/** A feature of a mission that waits for the owner's check. */
export const REASON_PAUSED_FOR_CHECK = "Paused while the mission waits for your check.";
export const REASON_RECOVERED = "Built and checked after a retry.";
export const REASON_STUCK_FALLBACK = "It could not be finished.";
export const REASON_LEFT_OUT_FALLBACK = "It was left out.";

/** A feature in progress inside a mission that is asleep (spec 4.3). `untilText` is "" when no time is known. */
export function reasonOnHold(cause: WaitInfo["cause"], untilText: string): string {
  if (cause === "unknown" || untilText === "") return "On hold. Mission Control cannot tell why.";
  return cause === "trouble" ? `On hold until ${untilText}, waiting for the AI team.` : `On hold until ${untilText}, waiting for allowance.`;
}

/** The caption of the steps line (spec 6.2): "Tried 3 times (2 build tries and 1 expert diagnosis)". */
export function stepsCaption(builds: number, diagnoses: number, fixes: number, used: number): string {
  if (used === 0 && fixes === 0) return "No tries yet";
  const inside: string[] = [];
  const work: string[] = [];
  if (builds > 0) work.push(plural(builds, "build try", "build tries"));
  if (diagnoses > 0) work.push(plural(diagnoses, "expert diagnosis", "expert diagnoses"));
  if (work.length > 0) inside.push(work.join(" and "));
  if (fixes > 0) inside.push(plural(fixes, "fix", "fixes") + " after review");
  return `Tried ${plural(used, "time")}${inside.length > 0 ? ` (${inside.join(", ")})` : ""}`;
}

// ───────────────────────────── The now line and the run line (spec 6.1) ─────────────────────────────

export const AGENT_LABEL_KINDS = ["onboard", "spec", "gate-a", "init", "gate-c", "report-prose", "test", "build", "review", "fix", "diagnose", "context", "digest"] as const;
export type AgentLabelKind = (typeof AGENT_LABEL_KINDS)[number];
/** The labels with no feature in them. */
export const STAGE_LABEL_KINDS: readonly AgentLabelKind[] = ["onboard", "spec", "gate-a", "init", "gate-c", "report-prose"];

/** What the open agent run is doing. `title` is the feature's title, or null when no feature matches. */
export function agentRunText(kind: AgentLabelKind | "other", title: string | null): string {
  const f = title === null ? "a feature" : quoted(title);
  switch (kind) {
    case "onboard":
      return "An AI is reading the existing project";
    case "spec":
      return "An AI is writing the plan";
    case "gate-a":
      return "A second AI is checking the plan";
    case "init":
      return "An AI is setting up the app's foundation";
    case "gate-c":
      return "A second AI is doing the final check of the whole app";
    case "report-prose":
      return "A helper AI is writing the report";
    case "test":
      return `An AI is writing the checks for ${f}`;
    case "build":
      return `An AI is building ${f}`;
    case "review":
      return `A second AI is reviewing ${f}`;
    case "fix":
      return `An AI is fixing what the review found in ${f}`;
    case "diagnose":
      return `An expert AI is working out why ${f} keeps failing`;
    case "context":
      return `A helper AI is reading up on ${f}`;
    case "digest":
      return `A helper AI is summarising why ${f} failed`;
    case "other":
      return "An AI is working";
  }
}

export const NOW_FINAL_TESTS = "Running the final tests";
export const NOW_REPORT = "Writing the report";
export const NOW_NEXT_STEP = "Getting the next step ready";
export function nowChecks(title: string): string {
  return `Running the checks on ${quoted(title)}`;
}
export function sinceLine(f: Formatter, ageMs: number): string {
  return `${f.span(ageMs)} so far`;
}

export const RUN_NONE = "No run is working right now.";
export function runStoppedAnswering(time: string): string {
  return `The last run stopped answering at ${time}.`;
}
/** The line under the lamp while a run is live. Pieces that are not known are left out. */
export function runLiveLine(o: { title: string | null; kindWord: string; runningText: string | null; deadline: { atText: string; leftText: string } | null }): string {
  const subject = o.title === null ? "A run is on, between missions" : `${o.title} (${o.kindWord})`;
  const running = o.runningText === null ? "" : `, running ${o.runningText}`;
  const stops = o.deadline === null ? "" : `, stops ${o.deadline.atText} (${o.deadline.leftText})`;
  return `${subject}${running}${stops}`;
}
export function deadlineLeftText(f: Formatter, leftMs: number): string {
  return leftMs < 0 ? "past the stop time" : `${f.span(leftMs)} left`;
}
export function activityLine(lastActivityText: string): string {
  return `Last activity ${lastActivityText}`;
}

// ───────────────────────────── Lamp clauses and sentences (spec 5.3, 5.4) ─────────────────────────────
// A clause is one short lowercase phrase with no semicolon and no inner "and"; the composer joins clauses with "and".

export const CLAUSE = {
  missionFailed: (n: number, title: string | null) => (n === 1 && title !== null ? `${quoted(title)} needs your help` : `${n} missions need your help`),
  runGone: "the run stopped unexpectedly",
  runGonePending: "checking whether the run is still going",
  homeUnreadable: "Mission Control's files cannot be read",
  unreadableMissions: (n: number) => (n === 1 ? "1 mission file cannot be read" : `${n} mission files cannot be read`),
  unknownState: "something is in a state this page does not know",
  pausedDisk: "work paused because the disk is almost full",
  pausedAiFailing: "work paused because the AI team keeps failing",
  stuck: (n: number) => (n === 1 ? "1 feature is stuck" : `${n} features are stuck`),
  leftOut: (n: number) => (n === 1 ? "1 feature was left out" : `${n} features were left out`),
  questions: (n: number) => (n === 1 ? "1 question is waiting for you" : `${n} questions are waiting for you`),
  login: "one AI needs a new login",
  /** One check waiting names its mission; several are counted. */
  checkpoint: (n: number, title: string | null) => (n === 1 && title !== null ? `${quoted(title)} is waiting for your check` : n === 1 ? "1 check is waiting for you" : `${n} checks are waiting for you`),
  checksFailing: "the project's own checks were already failing",
  /** `unbuilt` of `total` features (U > 0), or k missions that are paused with nothing left to build. */
  pausedUnbuilt: (unbuilt: number, total: number, missions: number) =>
    unbuilt > 0
      ? `${unbuilt} of ${total} ${total === 1 ? "feature is" : "features are"} waiting for the next run`
      : missions === 1
        ? "1 mission is paused until the next run"
        : `${missions} missions are paused until the next run`,
  partial: (title: string) => `${quoted(title)} finished partly done`,
  earlierFailed: (n: number) => (n === 1 ? "1 earlier mission needs your help" : `${n} earlier missions need your help`),
  waitUnknown: "the run is waiting for an unknown reason",
  waitUntil: (cause: "limits" | "trouble", untilText: string) => (cause === "limits" ? `waiting for allowance until ${untilText}` : `waiting for the AI team until ${untilText}`),
  heartbeatLate: (minutes: number) => `the run has not reported in for ${minutes} min`,
  quiet: (minutes: number) => `the run has been quiet for ${minutes} min`,
  stopRequested: "a stop was requested",
  queued: (n: number) => (n === 1 ? "1 mission waits for the next run" : `${n} missions wait for the next run`),
  earlierItems: (n: number) => (n === 1 ? "1 earlier mission still waits for you" : `${n} earlier missions still wait for you`),
  working: "the run is working and nothing needs a look",
  allDone: "everything is done",
  nothingRunning: "nothing is running",
} as const;

/**
 * Red or amber: the first clause (first letter capital), "and" the second, "N more things need a look" for the rest.
 * `resumesByItself`: the one clause is a wait of known cause, so the sentence says that nothing has to be done for it.
 * With other clauses next to it, "it" would be unclear, so the tail is only added to a sentence of that one clause.
 */
export function problemSentence(clauses: string[], restIsOnTrack: boolean, resumesByItself = false): string {
  const [first, second] = clauses;
  if (first === undefined) return "";
  let sentence = second === undefined ? `${capitalise(first)}.` : `${capitalise(first)} and ${second}.`;
  if (clauses.length > 2) {
    const more = clauses.length - 2;
    sentence += more === 1 ? " 1 more thing needs a look." : ` ${more} more things need a look.`;
  } else if (restIsOnTrack) {
    sentence += " The rest is on track.";
  } else if (resumesByItself && second === undefined) {
    sentence += ` ${RESUMES_BY_ITSELF}`;
  }
  return sentence;
}

export interface CalmFacts {
  /** Features done and all features over the recent missions. */
  done: number;
  total: number;
  /** A short wait of a known cause, if one is on. */
  shortWait: { cause: "limits" | "trouble"; untilText: string } | null;
  /** Earlier finished missions that still hold something for the owner (L23). */
  earlierWaiting: number;
  /** Recent queued missions (L22). */
  queued: number;
}

function earlierLine(n: number): string {
  return `${CLAUSE.earlierItems(n).replace(/^./, (c) => c.toUpperCase())} (see below).`;
}

function calmTail(x: CalmFacts): string {
  return x.earlierWaiting > 0 ? ` Nothing new needs you. ${earlierLine(x.earlierWaiting)}` : " Nothing needs you.";
}

/** L24: a live run with nothing to look at. */
export function workingSentence(x: CalmFacts): string {
  const { done: d, total: t } = x;
  let sentence: string;
  if (t === 0) sentence = "Working on the plan.";
  else if (t === 1) sentence = d === 0 ? "The feature is being worked on." : "The feature is done. The final steps are running.";
  else if (d === 0) sentence = `${t} features planned. No problems so far.`;
  else if (d < t) sentence = `${d} of ${t} features done. No problems so far.`;
  else sentence = `All ${t} features done. The final steps are running.`;
  if (x.shortWait !== null) sentence += ` ${waitLead(x.shortWait.cause, x.shortWait.untilText)} ${RESUMES_BY_ITSELF}`;
  return sentence + calmTail(x);
}

/** L25: nothing is running and the recent work is all done. */
export function allDoneSentence(x: CalmFacts & { missions: number }): string {
  let sentence = x.missions === 1 ? (x.total === 1 ? "The feature is done." : `All ${x.total} features are done.`) : `Everything is done: ${x.missions} missions, ${x.total} features.`;
  sentence += calmTail(x);
  if (x.queued > 0) sentence += x.queued === 1 ? " 1 more mission waits for the next run." : ` ${x.queued} more missions wait for the next run.`;
  return sentence;
}

/** L26: nothing is running. `otherEarlier` counts earlier missions that only wait for the next run. */
export function nothingSentence(x: { queued: number; earlierWaiting: number; otherEarlier: number }): string {
  const parts: string[] = [];
  if (x.queued > 0) parts.push(`${x.queued === 1 ? "1 mission waits" : `${x.queued} missions wait`} for the next run.`);
  if (x.earlierWaiting > 0) parts.push(earlierLine(x.earlierWaiting));
  if (x.otherEarlier > 0) parts.push(`${x.otherEarlier === 1 ? "1 earlier mission waits" : `${x.otherEarlier} earlier missions wait`} for the next run (see below).`);
  return parts.length === 0 ? "Nothing is running and nothing is queued." : `Nothing is running. ${parts.join(" ")}`;
}

// ───────────────────────────── Needs-you cards (spec 9.1) ─────────────────────────────

export const CARD_TEXT = {
  failedTitle: (title: string, fromEarlier: boolean) => (fromEarlier ? `${quoted(title)} still needs your help` : `${quoted(title)} needs your help`),
  failedIfRetryable: "It stays stopped until someone logs in again on the PC. After that the next run carries on by itself.",
  failedWhatToDoOther: "Ask the leader what went wrong. If it can be fixed, start the team working again with the leader.",
  failedIfNot: "Nothing happens. It stays stopped until someone restarts it.",
  failedFallbackReason: "It stopped and needs your help.",
  stoppedTitle: (title: string) => `${quoted(title)} stopped unexpectedly`,
  stoppedHappened: "The run stopped without finishing. The work so far is kept.",
  stoppedIfNothing: "The next run carries on from the last saved step.",
  stoppedWhatToDo: "Tell the leader to start the team working again.",
  pausedTitle: (title: string) => `${quoted(title)} is paused`,
  diskHappened: "The disk is almost full, so work paused.",
  diskIfNothing: "Work stays paused until there is free space. The next run carries on where it stopped.",
  diskWhatToDo: "Free some space on the PC, then tell the leader to carry on.",
  aiFailingHappened: "The AI team kept failing, so work paused. This is not a problem with the work.",
  aiFailingIfNothing: "The next run carries on where it stopped.",
  stuckTitle: (title: string) => `${quoted(title)} is stuck`,
  checksTitle: (title: string) => `${quoted(title)}: the project's own checks were already failing`,
  checksHappened: "The project's own checks were already failing before this mission started, so the new work was checked by its own new tests only.",
  checksIfNothing: "Nothing changes. Someone may want to look at the older failures.",
  loginTitle: "One AI needs a new login",
  loginIfNothing:
    "The login stays expired until someone logs in again. The run carries on with the other AI when it can. If both need a login, the mission stops and needs your help.",
  checkpointTitle: (title: string, kind: CheckpointWords["kind"], featureTitle: string | null) =>
    `${quoted(title)}: please check ${kind === "feature" ? `${checkpointSubject(kind, featureTitle)} before it is added` : checkpointSubject(kind, featureTitle)}`,
  checkpointHappened: "The team stopped here because you asked to look at it first.",
  checkpointIfNothing: "Nothing happens. This mission waits for you. Other work carries on.",
  checkpointWhatToDo: "Look at it as the report describes, then tell the leader to approve it or send it back.",
  decisionTitleConcerns: "Have someone check the app",
  decisionTitleQuestion: "A question for you",
  decisionIfConcerns: "Nothing changes. The mission stays Partly done.",
  decisionIfOther: "Nothing happens. The question stays open.",
} as const;

/**
 * The line under a checkpoint card's title. `branch` is the name the work is saved under (feature and final). `sentBack` is how
 * many times the owner has sent this check back: from the cap on, the card says what the next send-back does (checkpoints spec, 5.4).
 */
export function checkpointSummary(kind: CheckpointWords["kind"], branch: string | null, sentBack: number, cap: number): string {
  const base =
    kind === "plan"
      ? "Nothing is built yet. The report has the whole plan."
      : branch === null
        ? "The report says how to open it."
        : `The work is saved under the name ${branch}. The report says how to open it.`;
  if (sentBack < cap) return base;
  // The engine's own words for the three end states (src/checkpoint.ts, endState), so the card, the report and `mc send-back` agree.
  const end = kind === "plan" ? "nothing will be built" : kind === "feature" ? "this feature is set aside and the rest carries on" : "the finished result is kept as it is";
  return `${base} You have sent this back ${sentBack} ${sentBack === 1 ? "time" : "times"}. If you send it back again, the work stops here: ${end}. You can still approve.`;
}

/** The title of a question card; `of` is how many question cards the mission has. */
export function decisionTitle(kind: "concerns" | "question", position: number, of: number): string {
  const base = kind === "concerns" ? CARD_TEXT.decisionTitleConcerns : CARD_TEXT.decisionTitleQuestion;
  return of >= 2 ? `${base} (${position} of ${of})` : base;
}

/** `<Names> needs a new login on the PC.` and when the run wakes up. `names` are the AIs the wait names (may be empty). */
export function loginHappened(names: string[], untilText: string): string {
  const who = names.length === 0 ? "One AI needs" : `${names.join(" and ")} ${names.length === 1 ? "needs" : "need"}`;
  return `${who} a new login on the PC.${untilText === "" ? "" : ` The run is waiting until ${untilText} and then carries on with the other AI.`}`;
}

/** The first step for an expired login, for the card that waits for one (null names: no AI the engine knows). */
export function loginWhatToDo(names: string[]): string {
  return names.length === 0 ? "Log in again on the PC to the AI that needs it, then tell the leader." : `Log in again to ${names.join(" and ")} on the PC, then tell the leader.`;
}

export type StuckOutlook = "carries_on" | "stopped" | "finished" | "unknown";

/** What happens to a stuck feature if nobody does anything, and which features were left out because of it. */
export function stuckIfNothing(outlook: StuckOutlook, leftOutTitles: string[]): string {
  const base =
    outlook === "carries_on"
      ? "The rest carries on. This feature stays out, and the mission ends Partly done."
      : outlook === "stopped"
        ? "The mission has stopped, so nothing carries on until it is restarted."
        : outlook === "finished"
          ? "It stays out. Nothing tries it again unless you ask."
          : "Mission Control cannot tell what happens next.";
  const [a, b] = leftOutTitles;
  if (a === undefined) return base;
  if (leftOutTitles.length === 1) return `${base} ${quoted(a)} needed it, so that stays out too.`;
  if (leftOutTitles.length === 2 && b !== undefined) return `${base} ${quoted(a)} and ${quoted(b)} needed it, so those stay out too.`;
  return `${base} ${leftOutTitles.length} features needed it, so those stay out too.`;
}

/** The engine's concerns decision (src/dispatcher.ts, settleStatus), matched in full (spec 9.3). */
const CONCERN_PART1 = "the final review of the whole app did not finish, so nobody reviewed it as a whole";
const CONCERN_PART2 = "the final review found \\d+ serious problems? that (?:was|were) not fixed";
const CONCERN_PART3 = "the reviewers' \\d+ serious findings? on [^;]+? (?:was|were) not fixed";
const CONCERN_ANY = `(?:${CONCERN_PART1}|${CONCERN_PART2}|${CONCERN_PART3})`;
export const CONCERNS_ENTRY = new RegExp(
  `^Have someone check the app before you rely on it: (${CONCERN_ANY}(?:; ${CONCERN_ANY})*)\\. “Review notes” and “Technical details” list what the reviewers found\\.$`,
);

/** The concerns of an entry the engine wrote, or null when the entry is not exactly that. */
export function concernsOf(entry: string): string | null {
  return CONCERNS_ENTRY.exec(entry)?.[1] ?? null;
}

export function concernsHappened(concerns: string): string {
  return `Have someone check the app before you rely on it: ${concerns}.`;
}

// ───────────────────────────── Tell the leader (spec 8) ─────────────────────────────

export const LEADER_PLACEHOLDER = "<your answer here>";

/** A title inside a sentence that is pasted into a chat: no double quote can end the quote early. */
export function leaderTitle(title: string): string {
  return title.replace(/"/g, "'");
}

/** How a mission and a feature are named in a pasted sentence; ids are added only when two titles are alike (spec 8). */
export interface LeaderNames {
  /** `"Habit tracker"`, or `"Habit tracker" (mission <id>)`. */
  missionQuoted(m: { id: string; title: string }): string;
  /** `Habit tracker`, or `Habit tracker (mission <id>)`. */
  missionBare(m: { id: string; title: string }): string;
  /** `"Weekly chart"`, or `"Weekly chart" (feature <id>)`. */
  featureQuoted(m: { id: string }, f: { id: string; title: string }): string;
}

export function makeLeaderNames(missions: { id: string; title: string; features: { id: string; title: string }[] }[]): LeaderNames {
  const missionTitles = new Map<string, number>();
  for (const m of missions) missionTitles.set(leaderTitle(m.title), (missionTitles.get(leaderTitle(m.title)) ?? 0) + 1);
  const featureTitles = new Map<string, Map<string, number>>();
  for (const m of missions) {
    const counts = new Map<string, number>();
    for (const f of m.features) counts.set(leaderTitle(f.title), (counts.get(leaderTitle(f.title)) ?? 0) + 1);
    featureTitles.set(m.id, counts);
  }
  const clash = (title: string): boolean => (missionTitles.get(leaderTitle(title)) ?? 0) > 1;
  return {
    missionQuoted: (m) => `"${leaderTitle(m.title)}"${clash(m.title) ? ` (mission ${m.id})` : ""}`,
    missionBare: (m) => `${leaderTitle(m.title)}${clash(m.title) ? ` (mission ${m.id})` : ""}`,
    featureQuoted: (m, f) => `"${leaderTitle(f.title)}"${(featureTitles.get(m.id)?.get(leaderTitle(f.title)) ?? 0) > 1 ? ` (feature ${f.id})` : ""}`,
  };
}

export const LEADER = {
  feature: (n: LeaderNames, m: { id: string; title: string }, f: { id: string; title: string }) => `About ${n.featureQuoted(m, f)} in ${n.missionBare(m)}: ${LEADER_PLACEHOLDER}`,
  mission: (n: LeaderNames, m: { id: string; title: string }) => `About ${n.missionQuoted(m)}: ${LEADER_PLACEHOLDER}`,
  stuck: (n: LeaderNames, m: { id: string; title: string }, f: { id: string; title: string }) =>
    `About ${n.featureQuoted(m, f)} in ${n.missionBare(m)}, which is stuck: ${LEADER_PLACEHOLDER}`,
  question: (n: LeaderNames, m: { id: string; title: string }, position: number, of: number) =>
    of >= 2 ? `About question ${position} of ${of} in ${n.missionQuoted(m)}: ${LEADER_PLACEHOLDER}` : `About the question in ${n.missionQuoted(m)}: ${LEADER_PLACEHOLDER}`,
  failed: (n: LeaderNames, m: { id: string; title: string }) => `About ${n.missionQuoted(m)}, which stopped: ${LEADER_PLACEHOLDER}`,
  runStopped: (n: LeaderNames, m: { id: string; title: string }) => `About ${n.missionQuoted(m)}, which stopped unexpectedly: ${LEADER_PLACEHOLDER}`,
  paused: (n: LeaderNames, m: { id: string; title: string }) => `About ${n.missionQuoted(m)}, which is paused: ${LEADER_PLACEHOLDER}`,
  checks: (n: LeaderNames, m: { id: string; title: string }) => `About ${n.missionQuoted(m)}, whose own checks were already failing: ${LEADER_PLACEHOLDER}`,
  login: (n: LeaderNames, m: { id: string; title: string }) => `About the login that expired during ${n.missionQuoted(m)}: ${LEADER_PLACEHOLDER}`,
  checkpoint: (n: LeaderNames, m: { id: string; title: string }) => `About the check of ${n.missionQuoted(m)}: ${LEADER_PLACEHOLDER}`,
  /** The two answers of a check. The page only copies them; the leader asks the CEO before it acts on either (leader/CLAUDE.md). */
  approve: (n: LeaderNames, m: { id: string; title: string }, what: LeaderCheck) => `About the check of ${n.missionQuoted(m)} (${leaderCheck(n, m, what)}): approved, go ahead.`,
  sendBack: (n: LeaderNames, m: { id: string; title: string }, what: LeaderCheck) =>
    `About the check of ${n.missionQuoted(m)} (${leaderCheck(n, m, what)}): send it back. What to change: ${LEADER_PLACEHOLDER}`,
} as const;

/** Which check an answer is about. A feature check names the feature. */
export type LeaderCheck = { kind: "plan" } | { kind: "final" } | { kind: "feature"; feature: { id: string; title: string } };

function leaderCheck(n: LeaderNames, m: { id: string }, what: LeaderCheck): string {
  return what.kind === "plan" ? "the plan" : what.kind === "final" ? "the finished app" : `the feature ${n.featureQuoted(m, what.feature)}`;
}

/** The words of the "Tell the leader" sheet (spec 8). The page sends nothing anywhere; these are sentences to paste. */
export function leaderHelp(): {
  quickPhrases: string[];
  globalSentence: string;
  stopSentence: string;
  pasteHint: string;
  copyFailHint: string;
  aiNotice: string;
  canDo: string;
  stopNote: string;
} {
  return {
    quickPhrases: ["Your call", "Leave it out", "Try again", "What is going on?"],
    globalSentence: `About the current work: ${LEADER_PLACEHOLDER}`,
    stopSentence: "Please stop the current run.",
    pasteHint: "Paste this into your chat with the leader.",
    copyFailHint: "Select the text and copy it",
    aiNotice: "The AI wrote this. Do not run commands from it.",
    canDo:
      "The leader can look at progress and reports, stop the run, add new work, start the team working through the queued work, and approve or send back a check. It cannot change a plan or reopen a stuck feature.",
    stopNote: "Stopping cancels the AI step that is running, and up to 45 minutes of its work is redone. Restarting needs the PC or the next scheduled run.",
  };
}
