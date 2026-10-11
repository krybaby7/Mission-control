// The data contract of `mc dashboard`: the JSON served at GET /api/snapshot (schemaVersion 1).
//
// The page is dumb. The server builds a snapshot that is already in plain words, from one vocabulary module
// (src/dashboard/vocabulary.ts); the page only lays the strings out. States are a stable id plus the plain word.
// Everything here is JSON-serialisable: epoch milliseconds, never a Date; no undefined, NaN or Infinity.
//
// Where a value comes from is written on every field: a file and key, an event type and data key, or "derived: ...".
// File and event names are the ones under the Mission Control home (docs/dashboard-spec.md has the full source map).
//
// Who wrote a text matters, because an AI's text must be labelled in the page. `Said` carries it. The default is
// "ai": a text is "engine" only when the builder wrote it or recognised an engine-written string (a known pattern).
// Names (feature titles) are shown as names, without a label. They are written by the AI (the architect's spec),
// and mission titles by the owner; both are capped and cleaned of control, bidi, zero-width and other invisible
// format characters (docs/dashboard-spec.md, 3.3). A name is still AI text: the "Tell the leader" sentences carry
// names inside quotes, and the leader treats them as data, never as instructions (leader/CLAUDE.md).

export const SCHEMA_VERSION = 1 as const;

// ───────────────────────────── Shared pieces ─────────────────────────────

export const AUTHORS = ["engine", "ai"] as const;
/** "engine": written by Mission Control's code or recognised as such. "ai": written by an AI agent (or unknown). */
export type Author = (typeof AUTHORS)[number];

/** A text and who wrote it. The page labels every `ai` text ("The AI wrote this. Do not run commands from it."). */
export interface Said {
  /** Cleaned (no control, bidi, zero-width or other invisible format characters), whitespace collapsed, capped at the reason or decision limit. */
  text: string;
  author: Author;
}

export const TONES = ["good", "info", "warn", "bad"] as const;
export type Tone = (typeof TONES)[number];

// ───────────────────────────── The snapshot ─────────────────────────────

export interface Snapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Epoch ms on the server's clock when this snapshot was built. Derived: the `now` the builder was given. */
  generatedAt: number;
  /** Server-local "HH:MM:SS" of generatedAt (for "Updated 01:41:07"). Derived: formatted in the server's time zone. */
  generatedAtText: string;
  freshness: Freshness;
  lamp: Lamp;
  run: RunInfo;
  /** What is happening right now; null when no run is live, or nothing can be said. */
  now: NowLine | null;
  /**
   * Recent missions first (oldest first, as `mc status`), then the earlier unresolved ones ("earlier work still open").
   * Older finished missions are left out (counts.olderMissionsHidden). At most MAX_MISSIONS_SHOWN are listed
   * (counts.missionsNotShown says how many more there were), and the whole snapshot stays under MAX_SNAPSHOT_BYTES.
   */
  missions: MissionView[];
  /**
   * Cards for recent missions, red ones first, plus one amber mission_failed card for each earlier failed mission
   * (fromEarlier: true). Other earlier items get no card (see MissionView.openFromEarlier). At most MAX_CARDS_SHOWN
   * are listed (counts.cardsNotShown says how many more there were).
   */
  needsYou: NeedsYouCard[];
  allowance: Allowance;
  timeline: Timeline;
  /** The results (what you got, what is not finished, four ticks); null while no recent mission has finished or paused. */
  debrief: Debrief | null;
  counts: Counts;
  leader: LeaderHelp;
}

// ───────────────────────────── Freshness (the page's own checks) ─────────────────────────────

/**
 * The thresholds and fallback words the PAGE applies on its own clock, because only the page knows when it last
 * heard from the server. It measures time since its last successful response (not generatedAt against its own clock,
 * which may differ from the server's).
 */
export interface Freshness {
  /** How often the page asks for a new snapshot. Constant POLL_INTERVAL_MS (4 s). */
  pollEveryMs: number;
  /** After this long without an answer the page shows `notUpdatingText`. Constant PAGE_STALE_AFTER_MS (30 s). */
  staleAfterMs: number;
  /** After this long the page shows `notResponding` as the lamp and greys the content. PAGE_NOT_RESPONDING_AFTER_MS (5 min). */
  notRespondingAfterMs: number;
  /** "Not updating". Shown next to "Updated hh:mm:ss" once staleAfterMs has passed. Vocabulary constant. */
  notUpdatingText: string;
  /**
   * The lamp shown after staleAfterMs: amber (needs_look, reason page_stale). It replaces the server's lamp unless
   * that one is red; a stale page never keeps its last colour. Vocabulary constant.
   */
  notUpdating: Lamp;
  /** The lamp shown after notRespondingAfterMs: grey and hatched (not_responding, reason no_news); the content is greyed. Vocabulary constant. */
  notResponding: Lamp;
}

// ───────────────────────────── The lamp ─────────────────────────────

export const LAMP_STATES = ["on_track", "needs_look", "needs_you_now", "idle", "not_responding"] as const;
export type LampStateId = (typeof LAMP_STATES)[number];

export const LAMP_REASON_CODES = [
  // red (needs_you_now)
  "mission_failed",
  "run_gone",
  // amber (needs_look)
  "run_gone_pending",
  "feature_stuck",
  "decision_waiting",
  "login_needed",
  "checks_failing_before",
  "mission_partial",
  "paused_unbuilt",
  "paused_disk",
  "paused_ai_failing",
  "long_wait",
  "wait_unknown",
  "heartbeat_late",
  "quiet_run",
  "unreadable_mission",
  "unknown_state",
  "stop_requested",
  "home_unreadable",
  "earlier_failed",
  // no colour change (info)
  "short_wait",
  "queued",
  "earlier_items",
  // the reason a green or grey lamp is green or grey
  "working",
  "all_done",
  "nothing_running",
  // only in Freshness.notUpdating and Freshness.notResponding (the page applies them, never the server's lamp)
  "page_stale",
  "no_news",
] as const;
export type LampReasonCode = (typeof LAMP_REASON_CODES)[number];

export const LAMP_SEVERITIES = ["now", "look", "info", "ok"] as const;
/** now = red, look = amber, info = shown but changes nothing, ok = explains a green or grey lamp. */
export type LampSeverity = (typeof LAMP_SEVERITIES)[number];

export interface LampReason {
  /** The rule that fired (docs/dashboard-spec.md, "Lamp rules"). Derived: lamp rule table. */
  code: LampReasonCode;
  severity: LampSeverity;
  /**
   * One short lowercase phrase without a final period, e.g. "1 feature is stuck". It has no semicolon and no inner
   * "and" (the sentence composer joins clauses with "and"). Titles inside are in curly quotes. Engine-written
   * (vocabulary lamp clauses).
   */
  text: string;
  missionId: string | null;
  featureId: string | null;
}

export interface Lamp {
  /** Derived: the worst severity among `reasons`; see the lamp rule table. Unknown input is never on_track. */
  state: LampStateId;
  /** "On track" | "Needs a look" | "Needs you now" | "Idle" | "Not responding". Vocabulary: lamp table. */
  word: string;
  /** One or two short plain sentences. Derived: the highest-priority reason clauses joined by the sentence rules. Engine. */
  sentence: string;
  /** Every rule that fired, highest priority first. */
  reasons: LampReason[];
}

// ───────────────────────────── The run ─────────────────────────────

export const HEARTBEATS = ["none", "fresh", "late", "stale", "unreadable"] as const;
/**
 * The run lock's heartbeat. none: no mc.lock file. fresh: touched less than LOCK_FRESH_MS ago. late: LOCK_FRESH_MS to
 * LOCK_STALE_MS. stale: LOCK_STALE_MS or more (the holder is gone). unreadable: the file's content is not a lock.
 */
export type HeartbeatId = (typeof HEARTBEATS)[number];

export interface RunInfo {
  /** Derived: mc.lock exists, parses, and its mtime is less than LOCK_STALE_MS old (heartbeat fresh or late). Never uses the pid. */
  active: boolean;
  heartbeat: HeartbeatId;
  /** mc.lock content key `at` (ISO, written when the run starts) as epoch ms. null without a lock, or when `at` is not a time. */
  startedAt: number | null;
  /** Server-local "HH:MM" of startedAt. Derived. */
  startedAtText: string | null;
  /** Derived: generatedAt - startedAt, only while `active`. */
  runningMs: number | null;
  /** "2 h 43 min". Derived from runningMs. Engine. */
  runningText: string | null;
  /** Derived: generatedAt - mtime of mc.lock (the engine touches it every 60 s while it runs), clamped to >= 0. */
  heartbeatAgeMs: number | null;
  /** "12 s ago". Derived from heartbeatAgeMs. Engine. */
  heartbeatText: string | null;
  /** The file STOP exists in the home (probed directly, not through MissionStore.stopRequested). It is cleared when the next run starts. */
  stopRequested: boolean;
  /**
   * Derived: the newest of the last event's `at` and `updatedAt` of the worked mission (spec 6.1: the mission that
   * owns the open agent run, else the one asleep or being worked), the mtime of its dispatch.json, and the mtime of
   * logs/<jobId>.ndjson of the open agent run. null without a live run or without a worked mission.
   */
  lastActivityAt: number | null;
  /** "2 min ago". Derived. Engine. */
  lastActivityText: string | null;
  /** Only when the owner gave `mc dashboard --until HH:MM` and a run is live. The engine does not save its deadline. */
  deadline: Deadline | null;
  /**
   * The line under the lamp, e.g. "Habit tracker (new app), running 2 h 43 min, stops 07:00 (5 h 19 min left)", or
   * "No run is working right now." Derived from the missions being worked, runningText and deadline. Engine.
   */
  line: string;
  /** "Last activity 2 min ago". Derived from lastActivityText; null when it is. Engine. */
  activityLine: string | null;
}

export interface Deadline {
  /** Derived: parseUntil(--until, startedAt) from src/run.ts, the same function `mc run --until` used. Epoch ms. */
  at: number;
  /** "07:00". Server-local. */
  atText: string;
  /** Derived: at - generatedAt; negative once the time has passed. */
  leftMs: number;
  /** "5 h 19 min left", or "past the stop time". Engine. */
  leftText: string;
}

export const NOW_KINDS = ["agent", "waiting", "between_steps"] as const;
/** agent: an AI run is open. waiting: a mission is asleep until a limit ends (spec 4.2). between_steps: a run is live but no AI run is open. */
export type NowKind = (typeof NOW_KINDS)[number];

export interface NowLine {
  kind: NowKind;
  /**
   * Starts with a capital, no final period, e.g. `A second AI is reviewing “Daily check-off”`. Derived: for kind
   * agent, the label and role of the latest events.jsonl `run.start` with no `run.end` of the same `jobId`
   * (data keys label, jobId, role) through the label table; for waiting, the latest `limit.wait` of a mission that
   * is asleep (data keys until, reason); for between_steps, the status of the feature in progress. Engine; the title
   * inside is a name.
   */
  text: string;
  missionId: string | null;
  /**
   * Derived: the open run's label is "<prefix>-<featureId>" (test-, build-, review-, fix-, diagnose-, context-,
   * digest-) and the rest is a feature id of that mission; dispatch.json `inflight.feature` is used when it agrees.
   * null for stage-level runs (onboard, spec, gate-a, init, gate-c, report-prose) and when nothing matches.
   * For kind between_steps it is the feature in progress whose title the text carries (null when there is none).
   */
  featureId: string | null;
  /** The open run.start's `at` as epoch ms; null for waiting and between_steps. */
  since: number | null;
  /** "9 min so far". Derived from since. Engine. */
  sinceText: string | null;
  /** false for between_steps (a guess from the feature's status), true otherwise. */
  exact: boolean;
}

// ───────────────────────────── Missions and features ─────────────────────────────

export const MISSION_STATES = ["not_started", "working", "waiting", "paused", "done", "partly_done", "needs_you", "unknown"] as const;
export type MissionStateId = (typeof MISSION_STATES)[number];

export const FEATURE_STATES = ["waiting_turn", "being_built", "being_reviewed", "done", "stuck", "left_out", "paused", "unknown"] as const;
export type FeatureStateId = (typeof FEATURE_STATES)[number];

export const PAUSED_WHY = ["deadline", "stop_requested", "disk", "ai_failing", "unexpected", "unknown"] as const;
/** Why a paused mission paused. Derived: the last `mission.stopped` event's data.reason through the stop table; "unexpected" for a mission saved as running or waiting with no live run. */
export type PausedWhy = (typeof PAUSED_WHY)[number];

export const SCOPES = ["recent", "earlier"] as const;
export type Scope = (typeof SCOPES)[number];

export const PROGRESS_STEPS = ["plan", "plan_check", "build", "final_check", "landed"] as const;
export type ProgressStepId = (typeof PROGRESS_STEPS)[number];

export interface ProgressStep {
  id: ProgressStepId;
  /** "Plan" | "Plan check" | "Build" | "Final check" | "Landed". Vocabulary. */
  word: string;
  /** Derived from mission.json `stage` (and `status`): see the stage table. The checks only advise; none is drawn as a hold. */
  state: "done" | "current" | "todo";
}

export interface MissionView {
  /** mission.json `id` (the folder name). For an unreadable mission: the folder name, cleaned. */
  id: string;
  /** mission.json `title` (the owner's `--name` or the request's first sentence). The folder name when unreadable. */
  title: string;
  /** false when mission.json could not be read or is not a mission; the other fields are then placeholders. */
  readable: boolean;
  /** mission.json `kind`: greenfield -> new_app, feature -> change. */
  kind: "new_app" | "change";
  /** "new app" | "change". Vocabulary. */
  kindWord: string;
  /** recent, or earlier ("earlier work still open"). Derived: the scoping rule (docs/dashboard-spec.md, 12). */
  scope: Scope;
  /**
   * scope === "earlier". Shown in the quiet row. It changes the lamp only for a failed mission (amber, earlier_failed);
   * unreadable missions are always recent.
   */
  openFromEarlier: boolean;
  /**
   * Derived: mission.json `status` and `stage` (+ live run, + events) through the mission table (spec 4.2). A mission
   * saved as busy (running, waiting, or done or partial before the stage is complete) with no live run is paused.
   * The saved status "waiting" only reads as `waiting` while the mission is asleep: the engine leaves it set while the
   * agent runs after the wait, and then the state is `working`.
   */
  state: MissionStateId;
  /** "Not started" | "Working" | "Waiting" | "Paused" | "Done" | "Partly done" | "Needs you" | "Needs a look". Vocabulary. */
  word: string;
  /** One line, e.g. "Building feature 2 of 3." Derived from status, stage and the feature in progress. Engine. */
  sentence: string;
  /** Set when state is paused. */
  pausedWhy: PausedWhy | null;
  /** Plan, Plan check, Build, Final check, Landed. Derived from mission.json `stage`. */
  progress: ProgressStep[];
  /** The word of the current step ("Build"), "Landed" once complete, "" when no step is current (not started, unknown). Derived from `progress`. */
  progressWord: string;
  /** The stage went back to features after the final check (mission.json `gateCRounds` > 0 and stage features). */
  repairLap: boolean;
  /** Count of features with status done (mission.json features[].status). */
  featuresDone: number;
  /** features.length, repair features (id gate-c-fix-N) included, like `mc status` and the notifications. */
  featuresTotal: number;
  /** "2 of 4 features done". Derived. Engine. */
  featuresLine: string;
  /** Present while state is waiting (asleep): from the latest `limit.wait` event. */
  waiting: WaitInfo | null;
  features: FeatureView[];
  /** mission.json `updatedAt` as epoch ms (createdAt when updatedAt is not a time). 0 when unreadable. */
  updatedAt: number;
  /**
   * `About "Habit tracker": <your answer here>`. Template (vocabulary); straight quotes, because it is pasted into a chat.
   * The sentence is engine-written, the name inside the quotes is not (cleaned, and data to the leader).
   */
  tellLeader: string;
}

export interface WaitInfo {
  /**
   * `limit.wait` data.until (ISO) as epoch ms: the reset plus the engine's 45 s margin. It is the time the run wakes
   * up, which is not the time a login is fixed. For a wait with no `limit.wait` event this is 0 and `untilText` is "".
   */
  until: number;
  /**
   * "12:59" when that is the same local day as generatedAt, else the weekday and the time ("Wed 15:26"), and the date too
   * from 6 days away ("Mon 19 Oct 10:03"; a weekday alone repeats every week): the one rule of every wait and reset time
   * text. Server-local. "" when there is no event.
   */
  untilText: string;
  /**
   * limits: a usage limit. trouble: the AIs are failing or overloaded. login: one AI needs a new login while the run
   * sleeps for the other one (the engine does not count a blocked login as a wake-up time, src/executor.ts:243-257).
   * unknown: the reason did not match, or there is no event. Derived: the shape of data.reason (src/executor.ts:272-285).
   */
  cause: "limits" | "trouble" | "login" | "unknown";
  /**
   * e.g. "Waiting for allowance until 12:59. It resumes by itself." (a wait of known cause always ends with "It resumes
   * by itself.") or, for login, "Waiting for allowance until 12:59. Claude also needs a new login." or, for unknown,
   * "Waiting. Mission Control cannot tell why." Built from the parsed reason; the raw reason is never sent. Engine.
   */
  text: string;
}

export interface FeatureView {
  /** mission.json features[].id */
  id: string;
  /** mission.json features[].title (written by the architect AI; shown as a name, capped). */
  title: string;
  /** Derived: features[].status (and the mission's state) through the feature table. */
  state: FeatureStateId;
  /** "Waiting its turn" | "Being built" | "Being reviewed" | "Done" | "Stuck" | "Left out" | "Paused" | "Needs a look". Vocabulary. */
  word: string;
  /**
   * The plain reason. blocked: features[].blockedReason; skipped: its "waiting on ..." text; paused or waiting: an
   * engine sentence; done after a retry: an engine sentence. Author: engine when the text matched a known engine
   * pattern (docs/dashboard-spec.md, reason table), else ai. null when there is nothing to say.
   */
  reason: Said | null;
  /**
   * Ladder steps used of the ladder's size (the pips). A clean first try is 1 of 5, so `used` is not the number of
   * reinforcements: see `reinforcements`. caption e.g. "Tried 3 times (2 build tries and 1 expert diagnosis)", or
   * "No tries yet".
   */
  steps: { used: number; total: number; caption: string };
  /** Reinforcements called in: max(0, steps.used - 1). The first try is not a reinforcement. The page labels this number. */
  reinforcements: number;
  /** Derived: status done and an attempt with action build and outcome other than pass. Worded "Recovered after a retry". */
  recovered: boolean;
  /** features[].frozenTests.length: acceptance test FILES, not test cases. */
  acceptanceTests: number;
  /** Derived: id starts with "gate-c-fix-" (added by the final check's repair lap, src/dispatcher.ts:1935). */
  isRepair: boolean;
  /** The id of the NeedsYouCard about this feature, or null. */
  cardId: string | null;
  /**
   * `About "Weekly progress chart" in Habit tracker: <your answer here>`. Template; straight quotes. The names inside are
   * AI text (cleaned; data to the leader), the rest is engine-written.
   */
  tellLeader: string;
}

// ───────────────────────────── Needs you ─────────────────────────────

export const CARD_KINDS = [
  "mission_failed",
  "feature_stuck",
  "decision",
  "checks_failing",
  "run_stopped",
  "paused_disk",
  "paused_ai_failing",
  "login_needed",
] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export interface NeedsYouCard {
  /** Derived: "<kind>:<missionId>:<featureId or index>". Stable between polls. */
  id: string;
  kind: CardKind;
  /** now = red (a recent failed mission, a run that died), look = amber (everything else, and an earlier failed mission). */
  severity: "now" | "look";
  missionId: string;
  missionTitle: string;
  /** The mission's scope is "earlier": only an earlier failed mission gets a card (kind mission_failed, severity look). */
  fromEarlier: boolean;
  featureId: string | null;
  /** The headline, e.g. "“Weekly progress chart” is stuck". Engine. */
  title: string;
  /** What happened, in a sentence the CEO can read: the feature's reason, the decision text, or an engine sentence. Author says which. */
  happened: Said;
  /** An engine sentence on the effort so far, e.g. "Tried 3 times (2 build tries and 1 expert diagnosis)."; null when not a feature. */
  summary: string | null;
  /** What happens if nobody does anything. Engine (the if-nothing table). */
  ifNothing: string;
  /**
   * The next step for a person, in one or two plain sentences, when the engine knows it: "Log in again to Claude on the
   * PC, then tell the leader." (an expired login), "Free some space on the PC, then tell the leader to carry on."
   * (a full disk), "Tell the leader to start the team working again." (a run that died). Always engine-written (author
   * "engine"), and null for the kinds where the step is the owner's own call (a question, a stuck feature) or where
   * nothing is needed. The first sentence stands alone and holds no name, so the page can show it as a short line.
   */
  whatToDo: Said | null;
  /**
   * One sentence per card kind, e.g. `About "Weekly progress chart" in Habit tracker, which is stuck: <your answer here>`
   * or `About "Recipe box", which stopped: <your answer here>` (spec 8). Two question cards of one mission read
   * `About question 1 of 2 in "Members site": <your answer here>`. Template; straight quotes. The sentence is
   * engine-written but the names inside the quotes are not: feature titles are AI text and mission titles may be too.
   * They are cleaned (invisible characters removed, double quotes replaced), and the leader treats them as data.
   */
  tellLeader: string;
}

// ───────────────────────────── Allowance ─────────────────────────────

export const PILL_STATES = ["plenty", "getting_low", "nearly_out", "waiting_reset", "no_reading"] as const;
export type PillStateId = (typeof PILL_STATES)[number];

export interface Allowance {
  /** Claude and Codex always (from the config's families), plus any other provider found in quota.json. */
  providers: ProviderAllowance[];
  /** Set while a mission is asleep (state waiting: status waiting and no run started since its latest limit.wait). The sanitised reason, never the raw one. */
  waiting: WaitInfo | null;
  /** mtime of quota.json, epoch ms; null without the file. NOT a reading time: an unchanged reading is not rewritten (src/quota.ts:187). */
  fileChangedAt: number | null;
  /** "Usage figures last changed at 01:38", or "... at Wed 01:38" when that is not the day of the snapshot, or "... at Mon 5 Oct 01:38" from 6 days away. Engine. null without the file. */
  fileChangedText: string | null;
}

export interface ProviderAllowance {
  /** quota.json `utilization[].provider` / `limits` key: claude | codex | mock | any other key found. */
  id: string;
  /** "Claude" | "Codex" | "Test AI" | the id. Vocabulary. */
  label: string;
  pill: { state: PillStateId; word: string };
  /** Readings whose reset time is still ahead (quota.json `utilization[]`); empty means "no reading yet". */
  windows: AllowanceWindow[];
  /** "No usage reading yet." | "No 5-hour limit reported." | null. Engine. (The final period lets a model-block sentence follow it.) */
  note: string | null;
  /**
   * When the provider's block ends, epoch ms (the reset itself, without the 45 s margin); null when it is not blocked.
   * The later of: quota.json `limits.<id>.until` while in the future, and the `resetsAt` of a paced window (five_hour,
   * seven_day) whose reading is at or above its pause cap. The engine blocks a provider at the cap but saves no
   * `limits` entry for it (src/quota.ts:358-369). Drives the waiting_reset pill.
   */
  limitedUntil: number | null;
  /**
   * "Waiting for the 5-hour limit to reset. Work resumes at 12:59." (another day: "Work resumes Thu 09:00."; from 6 days
   * away: "Work resumes Mon 19 Oct 10:03."). Built from the kind of the block that ends last (limits.<id>.kind, or
   * session / weekly for a paced window) and limitedUntil plus the engine's 45 s margin, the same minute the wait
   * banner shows. The raw text is never sent.
   */
  limitedText: string | null;
}

export interface AllowanceWindow {
  /** quota.json utilization[].window: five_hour, seven_day, seven_day_<model>, <minutes>_minutes. */
  id: string;
  /** "Next 5 hours" | "This week" | "Another limit". Vocabulary window table (no model names). */
  label: string;
  /** quota.json utilization[].utilization, 0..1 (may exceed 1 in overage). */
  usedFraction: number;
  /** Math.round(usedFraction * 100). */
  usedPercent: number;
  /** usedFraction clamped to 0..1, for the bar. */
  fill: number;
  /** usedFraction > 1. */
  overage: boolean;
  /** quota.json utilization[].resetsAt, epoch ms. Readings without one are not saved by the engine (src/quota.ts:406). */
  resetsAt: number;
  /** "resets 03:20" on the day of the snapshot, else "resets Thu 09:00", or "resets Mon 19 Oct 10:03" from 6 days away. Server-local. Engine. */
  resetsText: string;
  /** The cap where the engine stops starting new work: config pacing.maxFiveHourUtilization / maxWeeklyUtilization; null for other windows. */
  pauseAt: number | null;
  /** "62% used, resets 03:20". Engine. */
  text: string;
}

// ───────────────────────────── Timeline ─────────────────────────────

export interface Timeline {
  /** Oldest first. At most TIMELINE_MAX_ITEMS. */
  items: TimelineItem[];
  /** How many older items were cut by the cap. */
  earlierNotShown: number;
}

export interface TimelineItem {
  /** events.jsonl `at` as epoch ms. */
  at: number;
  /** Server-local "HH:MM". */
  time: string;
  /** Server-local "Sat 11 Oct", so the page can draw a day heading when it changes. */
  day: string;
  /** events.jsonl `missionId`. */
  missionId: string;
  /** events.jsonl data.feature when the translation uses it. */
  featureId: string | null;
  tone: Tone;
  /** The plain sentence, from the translation table. Engine-written; feature and mission titles inside are names. */
  text: string;
  /** Extra detail in quotes under the sentence (e.g. why a feature is stuck); null when none. */
  note: Said | null;
  /** "ai" when `note` is AI-written, else "engine". Lets the page label a row at a glance. */
  author: Author;
  /** Consecutive identical sentences of one mission are merged; this is how many were. */
  count: number;
}

// ───────────────────────────── Results ─────────────────────────────

export const VERDICT_IDS = ["done", "partly_done", "needs_you", "paused"] as const;
export type VerdictId = (typeof VERDICT_IDS)[number];

export interface Verdict {
  id: VerdictId;
  /** "Done" | "Partly done" | "Needs you" | "Paused". Vocabulary. */
  word: string;
  /** e.g. "3 of 4 features are built and checked. 1 feature is stuck." Engine. */
  sentence: string;
}

export const TICK_IDS = ["delivered", "final_review", "nothing_open", "no_rework"] as const;
export type TickId = (typeof TICK_IDS)[number];

export const TICK_STATES = ["yes", "no", "unknown"] as const;
/** unknown: the data to decide is missing or unreadable. A tick is never `yes` on missing data. */
export type TickState = (typeof TICK_STATES)[number];

export interface Tick {
  id: TickId;
  /** "Delivered" | "Final review passed" | "Nothing open" | "No rework". Vocabulary. */
  label: string;
  state: TickState;
  /** The honest reason, e.g. "3 of 4 features were built and checked." Engine. */
  why: string;
  /**
   * An extra warning, e.g. "1 feature was merged without its own review. It covered only the 3 features that were
   * built."; null when none. Engine. Only the Final review passed tick has one; it never changes the tick's state.
   */
  caveat: string | null;
}

export interface DebriefFeature {
  featureId: string;
  title: string;
  /** For left-out features: the reason. For built ones: the feature's one-line story (features[].story, AI-written). null when absent. */
  note: Said | null;
  /** Ladder steps used (see FeatureView.steps). */
  attempts: number;
}

export interface MissionDebrief {
  missionId: string;
  title: string;
  verdict: Verdict;
  /** "4 features planned". The architect sets the scope, so a small plan ticks easily. Derived: features.length. Engine. */
  plannedLine: string;
  /** Features with status done. */
  got: DebriefFeature[];
  /** Features blocked or skipped. The page's heading for this list is "Not finished" (a stuck feature is not "left out" in the CEO's words). */
  leftOut: DebriefFeature[];
  /** Features done after a failed build attempt ("Recovered after a retry"). */
  recovered: DebriefFeature[];
  /** Always four ticks, in the order of TICK_IDS. */
  ticks: Tick[];
  /** "about 2 h 10 min of AI work". Derived: sum of usage.jsonl `durationMs` for this missionId. null when the ledger has none. Engine. */
  agentTimeText: string | null;
  /** Count of usage.jsonl records for this missionId; null when the ledger is missing or empty. */
  agentRuns: number | null;
  /** `About "Members site": <your answer here>`. Template; straight quotes. The name inside is data to the leader. */
  tellLeader: string;
}

export interface Debrief {
  /** The worst verdict of the missions below. */
  verdict: Verdict;
  missions: MissionDebrief[];
  /** The allowance sentence. The share of the week cannot be shown (the engine keeps it in memory only). Engine. */
  allowanceNote: string;
  /** "These are the AI team's own checks, not a human review." Constant. */
  honestyNote: string;
}

// ───────────────────────────── Counts and help ─────────────────────────────

export interface Counts {
  /** Mission folders whose mission.json could not be read or is not a mission. Counted in the lamp. */
  unreadableMissions: number;
  /** Missions with scope earlier (the quiet row "Earlier work still open (N)"). */
  openFromEarlier: number;
  /** Missions with scope earlier and state needs_you (an earlier failed mission). Colours the lamp amber (earlier_failed). */
  earlierNeedYou: number;
  /** Missions with scope earlier and stage complete that still hold a decision, a stuck or left-out feature, or a failed baseline. Info only (earlier_items). */
  earlierWaitingForYou: number;
  /** Missions with scope recent (readable ones). */
  recentMissions: number;
  /** Over recent missions (mission.json features[].status === "done", and features.length). */
  featuresDone: number;
  featuresTotal: number;
  /** "1 of 4 features done" over recent missions; "No features planned yet" when the total is 0. Derived. Engine. */
  featuresLine: string;
  /** Recent cards of kind decision (the question cards). A decision the engine wrote about a stuck or failed item is part of that item's card, not a question. */
  questions: number;
  /** Features of recent missions with state stuck. */
  stuckFeatures: number;
  /** Older finished missions left out of `missions`. */
  olderMissionsHidden: number;
  /**
   * Missions that are in the lamp and the counts above but were cut from `missions` because there were more than
   * MAX_MISSIONS_SHOWN (the ones with a card or an unknown state are kept first). 0 on any normal day.
   */
  missionsNotShown: number;
  /** Cards cut from `needsYou` for the same reason (more than MAX_CARDS_SHOWN, red ones kept first). 0 on any normal day. */
  cardsNotShown: number;
}

/** The words and sentences the page needs for "Tell the leader". The page never sends anything anywhere. */
export interface LeaderHelp {
  /** ["Your call", "Leave it out", "Try again", "What is going on?"] */
  quickPhrases: string[];
  /** `About the current work: <your answer here>` */
  globalSentence: string;
  /** "Please stop the current run." (a sentence to paste, not a button that acts) */
  stopSentence: string;
  /** "Paste this into your chat with the leader." */
  pasteHint: string;
  /** "Select the text and copy it" (when the clipboard is not available) */
  copyFailHint: string;
  /** "The AI wrote this. Do not run commands from it." */
  aiNotice: string;
  /**
   * What the leader can and cannot do, shown in the sheet: "The leader can look at progress and reports, stop
   * the run, add new work and start the team working through the queued work. It cannot change a plan or reopen a stuck feature." The leader only has the mc commands status, logs, report, stop, new, feature and run.
   */
  canDo: string;
  /**
   * What stopping costs, shown with stopSentence: "Stopping cancels the AI step that is running, and up to 45 minutes
   * of its work is redone. Restarting needs the PC or the next scheduled run."
   */
  stopNote: string;
}
