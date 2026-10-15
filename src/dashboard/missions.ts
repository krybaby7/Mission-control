// Scope, mission and feature views, the open agent run and the now line (docs/dashboard-spec.md, 1.4, 4, 6.1, 12).
// Pure: it gets the data read by read.ts, the run facts and the clock. It never touches the disk.
import type { CheckpointKind, Feature, Mission, MissionEvent } from "../types.js";
import { MAX_FEATURES_SHOWN, RECENT_WINDOW_MS, RUN_GONE_GRACE_MS, STALE_BUSY_AFTER_MS, WAIT_OVER_GRACE_MS } from "./constants.js";
import { checkedFacts, hasModeFeature, isModeFeature, noTestsDone } from "./modes.js";
import type { DispatchPicks, HomeData, MissionData } from "./read.js";
import type { DashboardSettings } from "./snapshot.js";
import { checkedByWords } from "./vocabulary-details.js";
import {
  agentRunText,
  type AgentLabelKind,
  explainFeatureReason,
  FEATURE_WORDS,
  featuresLine,
  kindWord,
  LEADER,
  makeLeaderNames,
  type Formatter,
  MISSION_WORDS,
  missionSentence,
  NOW_FINAL_CHECKS,
  NOW_FINAL_TESTS,
  NOW_NEXT_STEP,
  NOW_REPORT,
  nowChecks,
  PROGRESS_WORDS,
  REASON_LEFT_OUT_FALLBACK,
  REASON_PAUSED,
  REASON_PAUSED_FOR_CHECK,
  REASON_RECOVERED,
  REASON_RECOVERED_BUILT,
  REASON_STUCK_FALLBACK,
  reasonOnHold,
  SENTENCE_UNREADABLE,
  sinceLine,
  STAGE_LABEL_KINDS,
  stepsCaption,
  stopReasonKind,
  waitInfoFromEvent,
} from "./vocabulary.js";
import {
  PROGRESS_STEPS,
  type FeatureStateId,
  type FeatureView,
  type MissionStateId,
  type MissionView,
  type NowLine,
  type PausedWhy,
  type ProgressStep,
  type RunInfo,
  type Scope,
  type WaitInfo,
} from "./types.js";

/** The run facts the views need. A full RunInfo fits. */
export type RunFacts = Pick<RunInfo, "active" | "startedAt" | "heartbeat">;

/** The checkpoint of a stopped mission (docs/checkpoints-spec.md, 16: pending or answered, nothing else is one). */
export interface CheckpointFacts {
  state: "pending" | "answered";
  kind: CheckpointKind;
  /** The title of the feature a `feature` checkpoint is about; null for the other kinds, and when the file has no such feature. */
  featureTitle: string | null;
}

export interface MissionFacts {
  data: MissionData;
  view: MissionView;
  /** The mission is busy as saved: running, waiting, or done or partial before the stage is complete (spec 4.2). */
  savedBusy: boolean;
  /** A leftover of an earlier run that was killed, which the live run has not reached yet (spec 4.2). */
  staleBusy: boolean;
  /** Saved as waiting, and no agent has started since its latest wait began (spec 4.2). */
  asleep: boolean;
  /** The latest wait of a mission that is asleep (state waiting); the cause names which AIs need a login. */
  wait: (WaitInfo & { loginAis: string[] }) | null;
  /** The agent run this mission has open in the live run (spec 1.4); null when no run is live. */
  openRun: { jobId: string; label: string; role: string; at: number; featureId: string | null } | null;
  /** Features pending, testing, building or reviewing. */
  unbuilt: number;
  baselineBroken: boolean;
  /** Saved busy with no live run: "pending" inside RUN_GONE_GRACE_MS of the last save, "gone" after it (spec 5.3, L2 and L3). */
  runGone: "pending" | "gone" | null;
  /** Saved as stopped with a checkpoint: waiting for the owner's look, or answered and not continued yet. null otherwise. */
  checkpoint: CheckpointFacts | null;
}

// ───────────────────────────── Small checks ─────────────────────────────

const BUSY_STATUSES = new Set(["running", "waiting"]);

/** Saved as busy: the run is, or was, working on it (spec 4.2). Only the stage `complete` means finished. */
export function isSavedBusy(m: Mission): boolean {
  return BUSY_STATUSES.has(m.status) || ((m.status === "done" || m.status === "partial") && m.stage !== "complete");
}

/** The engine's rule for "work left" (src/run.ts, hasWorkLeft): by stage, not status. */
function hasWorkLeft(m: Mission): boolean {
  return m.stage !== "complete" && (m.status !== "failed" || m.failure?.retryable === true);
}

/** Still holds something for the owner, or is not finished (spec 12.1). */
function unresolved(m: Mission): boolean {
  if (m.stage !== "complete") return true;
  return m.decisionsNeeded.length > 0 || m.baselineBroken || m.features.some((f) => f.status === "blocked" || f.status === "skipped");
}

function ms(iso: string): number {
  return Date.parse(iso);
}

/** The checkpoint of a mission that is stopped on one. Pending = stopped and pending, answered = stopped and answered (checkpoints spec, 16). */
export function checkpointOf(m: Mission): CheckpointFacts | null {
  const cp = m.checkpoint;
  if (m.status !== "stopped" || cp === undefined) return null;
  const featureTitle = cp.kind === "feature" && cp.featureId !== undefined ? (m.features.find((f) => f.id === cp.featureId)?.title ?? null) : null;
  return { state: cp.state, kind: cp.kind, featureTitle };
}

/** The newest `at` of a list of events (0 for none). Not the last one: the file order is the append order, not a sort. */
function newestAt(events: MissionEvent[]): number {
  let newest = 0;
  for (const e of events) newest = Math.max(newest, ms(e.at));
  return newest;
}

function lastOfType(events: MissionEvent[], type: string): MissionEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e !== undefined && e.type === type) return e;
  }
  return null;
}

// ───────────────────────────── Scope (spec 12) ─────────────────────────────

export type ScopeId = Scope | "hidden";

/** Recent, earlier, or hidden, for every mission of the home. `live` is whether a run is on. */
export function scopeMissions(d: HomeData, live: boolean, now: number): Map<MissionData, ScopeId> {
  const recentStart = now - RECENT_WINDOW_MS;
  const out = new Map<MissionData, ScopeId>();
  for (const entry of d.missions) {
    const m = entry.mission;
    if (!entry.readable || m === null) {
      out.set(entry, "recent"); // unknown data is never green, and its age is not reliable
    } else if (ms(m.updatedAt) >= recentStart || (live && hasWorkLeft(m)) || checkpointOf(m)?.state === "pending") {
      // A mission that waits for the owner's check stays recent however long it waits: its card and its lamp reason must not age out.
      out.set(entry, "recent");
    } else {
      out.set(entry, unresolved(m) ? "earlier" : "hidden");
    }
  }
  return out;
}

// ───────────────────────────── The open agent run (spec 1.4) ─────────────────────────────

/** Events after which no agent run of the mission can still be going (the process that wrote the start is gone). */
const RUN_BOUNDARIES = new Set(["mission.start", "mission.resume", "mission.stopped", "mission.failed", "mission.end", "run.interrupted"]);

const FEATURE_LABEL_PREFIXES = ["test", "build", "review", "fix", "diagnose", "context", "digest"] as const;

/** The kind of an agent run from its label, and the feature id when the label names one of the mission's features. */
export function readLabel(label: string, featureIds: ReadonlySet<string>): { kind: AgentLabelKind | "other"; featureId: string | null } {
  for (const kind of STAGE_LABEL_KINDS) if (label === kind) return { kind, featureId: null };
  for (const prefix of FEATURE_LABEL_PREFIXES) {
    if (!label.startsWith(`${prefix}-`)) continue;
    const rest = label.slice(prefix.length + 1);
    return { kind: prefix, featureId: featureIds.has(rest) ? rest : null };
  }
  return { kind: "other", featureId: null };
}

function strOf(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * The agent run left open by the events, in file order: every run.start is added by its jobId and removed by the
 * run.end of the same jobId; the boundaries above clear them all. A start older than the live run's own start was
 * written by an earlier process, so it is not this run's.
 */
function findOpenRun(events: MissionEvent[], startedAt: number | null, featureIds: ReadonlySet<string>, dispatch: DispatchPicks | "unavailable" | null): MissionFacts["openRun"] {
  const open = new Map<string, { jobId: string; label: string; role: string; at: number }>();
  for (const e of events) {
    if (RUN_BOUNDARIES.has(e.type)) {
      open.clear();
    } else if (e.type === "run.start") {
      const jobId = strOf(e.data.jobId);
      if (jobId !== null) open.set(jobId, { jobId, label: strOf(e.data.label) ?? "", role: strOf(e.data.role) ?? "", at: ms(e.at) });
    } else if (e.type === "run.end") {
      const jobId = strOf(e.data.jobId);
      if (jobId !== null) open.delete(jobId);
    }
  }
  const last = [...open.values()].at(-1);
  if (last === undefined || (startedAt !== null && last.at < startedAt)) return null;
  let featureId = readLabel(last.label, featureIds).featureId;
  if (featureId === null && dispatch !== null && dispatch !== "unavailable") {
    const marker = dispatch.inflight;
    if (marker !== null && marker.label === last.label && marker.feature !== null && featureIds.has(marker.feature)) featureId = marker.feature;
  }
  return { ...last, featureId };
}

// ───────────────────────────── Mission state (spec 4.2) ─────────────────────────────

const MAP_STOP: Record<ReturnType<typeof stopReasonKind>, PausedWhy> = {
  deadline: "deadline",
  stop_requested: "stop_requested",
  disk: "disk",
  ai_failing: "ai_failing",
  unknown: "unknown",
};

interface StateInput {
  m: Mission;
  live: boolean;
  savedBusy: boolean;
  asleep: boolean;
  staleBusy: boolean;
  events: MissionEvent[];
}

/** A stage the engine knows (src/types.ts). One this page does not know makes the mission "Needs a look" (E5). */
function isKnownStage(stage: string): boolean {
  return Object.hasOwn(STAGE_STEPS, stage);
}

function stateOf(x: StateInput): { state: MissionStateId; pausedWhy: PausedWhy | null } {
  const { m } = x;
  // A failed mission stays "Needs you" whatever its stage is called: its red card must not be turned into an amber guess.
  if (!isKnownStage(m.stage) && m.status !== "failed") return { state: "unknown", pausedWhy: null };
  if (m.status === "queued") return { state: "not_started", pausedWhy: null };
  if (x.savedBusy && x.live && x.staleBusy) return { state: "paused", pausedWhy: "unexpected" };
  if (m.status === "waiting" && x.live && x.asleep) return { state: "waiting", pausedWhy: null };
  if (x.savedBusy && x.live) return { state: "working", pausedWhy: null };
  if (x.savedBusy) return { state: "paused", pausedWhy: "unexpected" };
  if (checkpointOf(m) !== null) return { state: "paused", pausedWhy: "checkpoint" };
  if (m.status === "stopped") {
    const stopped = lastOfType(x.events, "mission.stopped");
    return { state: "paused", pausedWhy: stopped === null ? "unknown" : MAP_STOP[stopReasonKind(stopped.data.reason)] };
  }
  if (m.status === "done" && m.stage === "complete") return { state: "done", pausedWhy: null };
  if (m.status === "partial" && m.stage === "complete") return { state: "partly_done", pausedWhy: null };
  if (m.status === "failed") return { state: "needs_you", pausedWhy: null };
  return { state: "unknown", pausedWhy: null };
}

// ───────────────────────────── Progress (spec 4.4) ─────────────────────────────

type StepStates = [ProgressStep["state"], ProgressStep["state"], ProgressStep["state"], ProgressStep["state"], ProgressStep["state"]];

const STAGE_STEPS: Record<string, StepStates> = {
  onboard: ["current", "todo", "todo", "todo", "todo"],
  spec: ["current", "todo", "todo", "todo", "todo"],
  gate_a: ["done", "current", "todo", "todo", "todo"],
  init: ["done", "done", "current", "todo", "todo"],
  features: ["done", "done", "current", "todo", "todo"],
  gate_c: ["done", "done", "done", "current", "todo"],
  finalize: ["done", "done", "done", "done", "current"],
  complete: ["done", "done", "done", "done", "done"],
};
const ALL_TODO: StepStates = ["todo", "todo", "todo", "todo", "todo"];

function progressOf(stage: string, state: MissionStateId): { progress: ProgressStep[]; progressWord: string } {
  // The stage came from a file: only the table's own entries count ("constructor" is not a stage).
  const steps = state === "not_started" || !Object.hasOwn(STAGE_STEPS, stage) ? ALL_TODO : (STAGE_STEPS[stage] ?? ALL_TODO);
  const progress = PROGRESS_STEPS.map((id, i): ProgressStep => ({ id, word: PROGRESS_WORDS[id], state: steps[i] ?? "todo" }));
  const current = progress.find((p) => p.state === "current");
  const landed = progress.every((p) => p.state === "done");
  return { progress, progressWord: landed ? PROGRESS_WORDS.landed : (current?.word ?? "") };
}

// ───────────────────────────── Features (spec 4.3, 6.2) ─────────────────────────────

const IN_PROGRESS = new Set(["testing", "building", "reviewing"]);
const UNBUILT = new Set(["pending", "testing", "building", "reviewing"]);

function featureState(status: string, mission: MissionStateId): FeatureStateId {
  switch (status) {
    case "pending":
      return "waiting_turn";
    case "testing":
    case "building":
    case "reviewing": {
      const built = status === "reviewing" ? "being_reviewed" : "being_built";
      if (mission === "working" || mission === "waiting") return built;
      if (mission === "paused" || mission === "needs_you" || mission === "not_started") return "paused";
      return "unknown";
    }
    case "done":
      return "done";
    case "blocked":
      return "stuck";
    case "skipped":
      return "left_out";
    default:
      return "unknown";
  }
}

/**
 * How many steps the feature's ladder has. A feature checked by tests climbs the standard or the mechanical ladder as it is. A feature
 * checked by a second AI climbs the same ladder without its diagnosis steps (docs/modes-spec.md, 5.2 and 11.1): the lightweight ladder
 * when its effort is `light` (or it is the older `mechanical` kind), the standard one otherwise. `deep` lifts the steps and does not add any.
 * Settings that do not say how many diagnosis steps a ladder has (a hand-written one) are taken to have one each, as the built-in ladders do.
 */
export function ladderTotal(f: Feature, settings: DashboardSettings): number {
  const lightweight = f.kind === "mechanical" || (isModeFeature(f) && f.effort === "light");
  const length = lightweight ? settings.ladders.mechanical : settings.ladders.standard;
  if (!isModeFeature(f)) return f.kind === "mechanical" ? settings.ladders.mechanical : settings.ladders.standard;
  const diagnose = settings.diagnoseSteps?.[lightweight ? "mechanical" : "standard"] ?? 1;
  return Math.max(1, length - diagnose);
}

function featureView(
  f: Feature,
  state: FeatureStateId,
  mission: { state: MissionStateId; wait: WaitInfo | null; checkpoint: CheckpointFacts | null },
  settings: DashboardSettings,
  whole: Pick<Mission, "features" | "ownerStops" | "checkpoints" | "checkpointLog">,
): FeatureView {
  const builds = f.attempts.filter((a) => a.action === "build").length;
  const diagnoses = f.attempts.filter((a) => a.action === "diagnose").length;
  const fixes = f.attempts.filter((a) => a.action === "fix").length;
  const total = ladderTotal(f, settings);
  const used = Math.min(builds + diagnoses, total);
  const recovered = f.status === "done" && f.attempts.some((a) => a.action === "build" && a.outcome !== "pass");
  let reason: FeatureView["reason"] = null;
  if (state === "stuck") reason = f.blockedReason === undefined ? { text: REASON_STUCK_FALLBACK, author: "engine" } : explainFeatureReason(f.blockedReason);
  else if (state === "left_out") reason = f.blockedReason === undefined ? { text: REASON_LEFT_OUT_FALLBACK, author: "engine" } : explainFeatureReason(f.blockedReason);
  else if (state === "paused") reason = { text: mission.checkpoint?.state === "pending" ? REASON_PAUSED_FOR_CHECK : REASON_PAUSED, author: "engine" };
  else if ((state === "being_built" || state === "being_reviewed") && mission.state === "waiting") {
    reason = { text: reasonOnHold(mission.wait?.cause ?? "unknown", mission.wait?.untilText ?? ""), author: "engine" };
  } else if (state === "done" && recovered) reason = { text: isModeFeature(f) ? REASON_RECOVERED_BUILT : REASON_RECOVERED, author: "engine" };
  // A feature checked by a second AI has no test files: the tile says how many checks are on its list and, once it is done, how they came out
  // (docs/modes-spec.md, 11.5). Every other feature keeps the keys it always had.
  const byReading = isModeFeature(f)
    ? { modeChecks: f.acceptance.length, ...(state === "done" && { checkedBy: checkedByWords(checkedFacts(whole, f)) }) }
    : {};
  return {
    id: f.id,
    title: f.title,
    state,
    word: FEATURE_WORDS[state],
    reason,
    steps: { used, total, caption: stepsCaption(builds, diagnoses, fixes, used) },
    reinforcements: Math.max(0, used - 1),
    recovered,
    acceptanceTests: f.frozenTests.length,
    ...byReading,
    isRepair: f.id.startsWith("gate-c-fix-"),
    cardId: null,
    tellLeader: "",
  };
}

// ───────────────────────────── The views ─────────────────────────────

interface Context {
  live: boolean;
  run: RunFacts;
  now: number;
  f: Formatter;
  settings: DashboardSettings;
  /** How many features of one mission are built into its view (the rest are counted in featuresTotal). */
  featureCap: number;
}

const KNOWN_FEATURE_STATUSES = new Set(["pending", "testing", "building", "reviewing", "done", "blocked", "skipped"]);

/** The first `cap` of a list when it is longer, chosen by rank (lowest first, then the file order) and then put back in file order. */
export function pickByRank<T>(list: T[], cap: number, rank: (item: T) => number): T[] {
  if (list.length <= cap) return list;
  return list
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, Math.max(0, cap))
    .sort((a, b) => a.index - b.index)
    .map((c) => c.item);
}

/**
 * The features that are listed when a mission has more than `cap`: the ones that need a look come first (stuck, left out,
 * unknown), then the ones in progress, then those waiting, then the done ones. The file order is kept inside the list.
 */
export function pickFeatures(features: Feature[], cap: number): Feature[] {
  return pickByRank(features, cap, (f) =>
    f.status === "blocked" || f.status === "skipped" || !KNOWN_FEATURE_STATUSES.has(f.status) ? 0 : IN_PROGRESS.has(f.status) ? 1 : f.status === "pending" ? 2 : 3,
  );
}

/** The same choice for the views that are already built (the output is made smaller after the lamp and the cards looked at everything). */
export function pickFeatureViews(views: FeatureView[], cap: number): FeatureView[] {
  return pickByRank(views, cap, (v) => (v.state === "stuck" || v.state === "left_out" || v.state === "unknown" ? 0 : v.state === "done" ? 3 : v.state === "waiting_turn" ? 2 : 1));
}

function unreadableFacts(data: MissionData): MissionFacts {
  const view: MissionView = {
    id: data.folder,
    title: data.folder,
    readable: false,
    kind: "change",
    kindWord: kindWord("change"),
    scope: "recent",
    openFromEarlier: false,
    state: "unknown",
    word: MISSION_WORDS.unknown,
    sentence: SENTENCE_UNREADABLE,
    pausedWhy: null,
    progress: PROGRESS_STEPS.map((id) => ({ id, word: PROGRESS_WORDS[id], state: "todo" as const })),
    progressWord: "",
    repairLap: false,
    featuresDone: 0,
    featuresTotal: 0,
    featuresLine: featuresLine(0, 0),
    waiting: null,
    features: [],
    updatedAt: 0,
    tellLeader: "",
  };
  return { data, view, savedBusy: false, staleBusy: false, asleep: false, wait: null, openRun: null, unbuilt: 0, baselineBroken: false, runGone: null, checkpoint: null };
}

function factsFor(data: MissionData, scope: Scope, cx: Context): MissionFacts {
  const m = data.mission;
  if (!data.readable || m === null) return unreadableFacts(data);
  const events = data.events ?? [];
  const featureIds = new Set(m.features.map((f) => f.id));
  const updatedAt = ms(m.updatedAt);
  const savedBusy = isSavedBusy(m);
  const openRun = cx.live ? findOpenRun(events, cx.run.startedAt, featureIds, data.dispatch) : null;

  // Asleep: saved as waiting, no agent running, and no agent started since the latest wait began (spec 4.2).
  const lastWaitIndex = events.findLastIndex((e) => e.type === "limit.wait");
  const lastWait = lastWaitIndex === -1 ? null : (events[lastWaitIndex] ?? null);
  let asleep = false;
  if (m.status === "waiting" && openRun === null) {
    if (lastWait === null) {
      asleep = true;
    } else {
      const startedSince = events.slice(lastWaitIndex + 1).some((e) => e.type === "run.start");
      const until = typeof lastWait.data.until === "string" ? Date.parse(lastWait.data.until) : Number.NaN;
      asleep = !startedSince && (!Number.isFinite(until) || cx.now <= until + WAIT_OVER_GRACE_MS);
    }
  }

  const lastEventAt = newestAt(events);
  const startedAt = cx.run.startedAt;
  const staleBusy =
    cx.live &&
    savedBusy &&
    openRun === null &&
    startedAt !== null &&
    cx.now - startedAt >= STALE_BUSY_AFTER_MS &&
    updatedAt < startedAt &&
    lastEventAt < startedAt;

  const { state, pausedWhy } = stateOf({ m, live: cx.live, savedBusy, asleep, staleBusy, events });
  const wait = asleep ? waitInfoFromEvent(lastWait === null ? null : lastWait.data, (at) => cx.f.when(at, cx.now)) : null;
  const waitingNow = state === "waiting" ? wait : null;

  const n = m.features.length;
  const done = m.features.filter((f) => f.status === "done").length;
  const stuck = m.features.filter((f) => f.status === "blocked").length;
  const leftOut = m.features.filter((f) => f.status === "skipped").length;
  const unbuilt = m.features.filter((f) => UNBUILT.has(f.status)).length;
  const firstInProgress = m.features.findIndex((f) => IN_PROGRESS.has(f.status));
  const finished = m.features.filter((f) => f.status === "done" || f.status === "blocked" || f.status === "skipped").length;
  const k = Math.min(n, firstInProgress === -1 ? finished + 1 : firstInProgress + 1);

  const checkpoint = checkpointOf(m);
  const { progress, progressWord } = progressOf(m.stage, state);
  const features = pickFeatures(m.features, cx.featureCap).map((f) => featureView(f, featureState(f.status, state), { state, wait: waitingNow, checkpoint }, cx.settings, m));
  const view: MissionView = {
    id: m.id,
    title: m.title,
    readable: true,
    kind: m.kind === "greenfield" ? "new_app" : "change",
    kindWord: kindWord(m.kind === "greenfield" ? "new_app" : "change"),
    scope,
    openFromEarlier: scope === "earlier",
    state,
    word: MISSION_WORDS[state],
    sentence: missionSentence({ state, stage: m.stage, pausedWhy, staleBusy, waitText: waitingNow?.text ?? null, n, k, u: unbuilt, d: done, stuck, leftOut, checkpoint, ...(hasModeFeature(m) && { modes: true }) }),
    pausedWhy,
    progress,
    progressWord,
    repairLap: m.stage === "features" && m.gateCRounds > 0,
    featuresDone: done,
    featuresTotal: n,
    featuresLine: featuresLine(done, n),
    waiting: waitingNow === null ? null : { until: waitingNow.until, untilText: waitingNow.untilText, cause: waitingNow.cause, text: waitingNow.text },
    features,
    updatedAt,
    tellLeader: "",
  };
  const runGone = savedBusy && !cx.live ? (cx.now - updatedAt >= RUN_GONE_GRACE_MS ? "gone" : "pending") : null;
  return { data, view, savedBusy, staleBusy, asleep, wait: waitingNow, openRun, unbuilt, baselineBroken: m.baselineBroken, runGone, checkpoint };
}

function createdAt(x: MissionFacts): number {
  return x.data.mission === null ? Number.POSITIVE_INFINITY : ms(x.data.mission.createdAt);
}

/** `mc status` order: oldest first, then by id (spec 12.3). */
function byCreation(a: MissionFacts, b: MissionFacts): number {
  const diff = createdAt(a) - createdAt(b);
  if (diff !== 0 && !Number.isNaN(diff)) return diff;
  return a.view.id < b.view.id ? -1 : a.view.id > b.view.id ? 1 : 0;
}

/**
 * One MissionFacts per mission that is shown: the recent ones first, then the earlier ones still open (hidden ones are left out).
 * The events and dispatch.json values of the shown missions must have been read (readDetails).
 */
export function buildMissions(d: HomeData, run: RunFacts, now: number, f: Formatter, s: DashboardSettings, featureCap = MAX_FEATURES_SHOWN): MissionFacts[] {
  const cx: Context = { live: run.active, run, now, f, settings: s, featureCap };
  const scopes = scopeMissions(d, cx.live, now);
  const facts: MissionFacts[] = [];
  for (const entry of d.missions) {
    const scope = scopes.get(entry);
    if (scope === undefined || scope === "hidden") continue;
    facts.push(factsFor(entry, scope, cx));
  }
  const ordered = [...facts.filter((x) => x.view.scope === "recent").sort(byCreation), ...facts.filter((x) => x.view.scope === "earlier").sort(byCreation)];
  const names = makeLeaderNames(ordered.map((x) => ({ id: x.view.id, title: x.view.title, features: x.view.features })));
  for (const x of ordered) {
    const mission = { id: x.view.id, title: x.view.title };
    x.view.tellLeader = LEADER.mission(names, mission);
    for (const feature of x.view.features) feature.tellLeader = LEADER.feature(names, mission, feature);
  }
  return ordered;
}

// ───────────────────────────── The worked mission and the now line (spec 6.1) ─────────────────────────────

/** The newest sign of life of a mission: its last event, its last save, its dispatch.json. */
export function missionActivityAt(x: MissionFacts): number {
  return Math.max(newestAt(x.data.events ?? []), x.view.updatedAt, x.data.dispatchMtimeMs ?? 0);
}

/**
 * The mission the live run is working on: the one that owns the open agent run; else the one asleep; else the one
 * that is working with the newest activity. A leftover under a live run is never it (spec 6.1).
 */
export function workedMission(m: MissionFacts[]): MissionFacts | null {
  const recent = m.filter((x) => x.view.scope === "recent" && x.view.readable);
  const withRun = recent.filter((x) => x.openRun !== null).sort((a, b) => (b.openRun?.at ?? 0) - (a.openRun?.at ?? 0));
  if (withRun[0] !== undefined) return withRun[0];
  const waiting = recent.find((x) => x.view.state === "waiting");
  if (waiting !== undefined) return waiting;
  const working = recent.filter((x) => x.view.state === "working" && !x.staleBusy).sort((a, b) => missionActivityAt(b) - missionActivityAt(a));
  return working[0] ?? null;
}

/** What is happening right now; null when no run is live or nothing can be said. */
export function buildNow(m: MissionFacts[], run: RunFacts, f: Formatter, now: number): NowLine | null {
  if (!run.active) return null;
  const owner = workedMission(m);
  if (owner === null) return null;
  const open = owner.openRun;
  if (open !== null) {
    const mission = owner.data.mission;
    const featureIds = new Set((mission?.features ?? []).map((x) => x.id));
    const { kind } = readLabel(open.label, featureIds);
    const title = open.featureId === null ? null : (owner.view.features.find((x) => x.id === open.featureId)?.title ?? null);
    return {
      kind: "agent",
      text: agentRunText(kind, title),
      missionId: owner.view.id,
      featureId: open.featureId,
      since: open.at,
      sinceText: sinceLine(f, now - open.at),
      exact: true,
    };
  }
  if (owner.view.state === "waiting" && owner.wait !== null) {
    return { kind: "waiting", text: owner.wait.text, missionId: owner.view.id, featureId: null, since: null, sinceText: null, exact: true };
  }
  if (owner.view.state !== "working") return null;
  const inProgress = owner.view.features.find((x) => x.state === "being_built" || x.state === "being_reviewed");
  const stage = owner.data.mission?.stage;
  const noTests = owner.data.mission !== null && noTestsDone(owner.data.mission);
  const text = inProgress !== undefined ? nowChecks(inProgress.title) : stage === "gate_c" ? (noTests ? NOW_FINAL_CHECKS : NOW_FINAL_TESTS) : stage === "finalize" ? NOW_REPORT : NOW_NEXT_STEP;
  return { kind: "between_steps", text, missionId: owner.view.id, featureId: inProgress?.id ?? null, since: null, sinceText: null, exact: false };
}
