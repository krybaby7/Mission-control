// buildSnapshot: reads the Mission Control home (read-only) and builds the JSON the page shows (docs/dashboard-spec.md,
// 2.2 and 3.1). Each step is a pure function over what the step before produced; only step 1 touches the disk.
// It never throws: any failure inside becomes a degraded snapshot whose lamp says "Needs a look".
import { defaultConfig } from "../config.js";
import { parseUntil } from "../run.js";
import type { Config } from "../types.js";
import { buildAllowance } from "./allowance.js";
import { attachCardIds, buildCards } from "./cards.js";
import {
  LOCK_FRESH_MS,
  LOCK_STALE_MS,
  MAX_CARDS_SHOWN,
  MAX_FEATURES_SHOWN,
  MAX_MISSIONS_SHOWN,
  MAX_SNAPSHOT_BYTES,
  PAGE_NOT_RESPONDING_AFTER_MS,
  PAGE_STALE_AFTER_MS,
  POLL_INTERVAL_MS,
  TIMELINE_MAX_ITEMS,
} from "./constants.js";
import { buildDebrief } from "./debrief.js";
import { buildLamp } from "./lamp.js";
import { buildMissions, buildNow, type MissionFacts, missionActivityAt, pickFeatureViews, scopeMissions, workedMission } from "./missions.js";
import { type HomeData, jobLogMtime, readDetails, readHome } from "./read.js";
import { buildTimeline } from "./timeline.js";
import {
  type Counts,
  type Debrief,
  type Deadline,
  type HeartbeatId,
  type NeedsYouCard,
  type RunInfo,
  SCHEMA_VERSION,
  type Snapshot,
  type WaitInfo,
} from "./types.js";
import {
  activityLine,
  deadlineLeftText,
  featuresLine,
  type Formatter,
  leaderHelp,
  makeFormatter,
  NOT_UPDATING_TEXT,
  pageLamps,
  RUN_NONE,
  runLiveLine,
  runStoppedAnswering,
} from "./vocabulary.js";

export interface DashboardSettings {
  /** config.ladders.<kind>.length */
  ladders: { standard: number; mechanical: number };
  pacing: { maxFiveHourUtilization: number; maxWeeklyUtilization: number };
  /** Unique providers of config.families and config.light. */
  providers: string[];
  /** built_in when the config could not be read. */
  source: "saved" | "built_in";
}

export interface SnapshotOptions {
  /** Absolute path of the Mission Control home. */
  home: string;
  /** Epoch ms, default Date.now(). */
  now?: number;
  /** "HH:MM", from --until. */
  until?: string;
  /** Default builtInSettings(). */
  settings?: DashboardSettings;
  /** IANA name for every time text; default: the process time zone. */
  timeZone?: string;
  /** Called with the error when the build failed and a degraded snapshot was returned instead (for a log line). */
  onError?: (err: unknown) => void;
  /** The size the snapshot's JSON must fit, default MAX_SNAPSHOT_BYTES. A test passes less to reach the later, smaller tries. */
  maxBytes?: number;
}

export function settingsFromConfig(c: Pick<Config, "ladders" | "pacing" | "families" | "light">): DashboardSettings {
  const providers = [...new Set<string>([c.families.claude.provider, c.families.codex.provider, c.light.provider])];
  return {
    ladders: { standard: c.ladders.standard.length, mechanical: c.ladders.mechanical.length },
    pacing: { maxFiveHourUtilization: c.pacing.maxFiveHourUtilization, maxWeeklyUtilization: c.pacing.maxWeeklyUtilization },
    providers,
    source: "saved",
  };
}

export function builtInSettings(): DashboardSettings {
  return { ...settingsFromConfig(defaultConfig()), source: "built_in" };
}

// ───────────────────────────── The run (spec 6.1) ─────────────────────────────

function heartbeatOf(lock: HomeData["lock"], now: number): { heartbeat: HeartbeatId; ageMs: number | null } {
  if (lock === null) return { heartbeat: "none", ageMs: null };
  if (!lock.valid) return { heartbeat: "unreadable", ageMs: null };
  const ageMs = Math.max(0, now - lock.mtimeMs); // a lock touched "in the future" counts as just touched
  return { heartbeat: ageMs < LOCK_FRESH_MS ? "fresh" : ageMs < LOCK_STALE_MS ? "late" : "stale", ageMs };
}

/** The run as far as the lock and the STOP file say; the line, the activity and the deadline come once the missions are built. */
function runFromLock(data: HomeData, now: number, f: Formatter): RunInfo {
  const { heartbeat, ageMs } = heartbeatOf(data.lock, now);
  const active = heartbeat === "fresh" || heartbeat === "late";
  const startedAt = data.lock?.valid ? data.lock.at : null;
  const runningMs = active && startedAt !== null ? Math.max(0, now - startedAt) : null;
  return {
    active,
    heartbeat,
    startedAt,
    startedAtText: startedAt === null ? null : f.time(startedAt),
    runningMs,
    runningText: runningMs === null ? null : f.span(runningMs),
    heartbeatAgeMs: ageMs,
    heartbeatText: ageMs === null ? null : f.ago(ageMs),
    stopRequested: data.stopRequested,
    lastActivityAt: null,
    lastActivityText: null,
    deadline: null,
    line: RUN_NONE,
    activityLine: null,
  };
}

function deadlineOf(run: RunInfo, until: string | undefined, now: number, f: Formatter): Deadline | null {
  if (until === undefined || !run.active || run.startedAt === null) return null;
  try {
    const at = parseUntil(until, run.startedAt);
    const leftMs = at - now;
    return { at, atText: f.time(at), leftMs, leftText: deadlineLeftText(f, leftMs) };
  } catch {
    return null; // the command checks --until before it starts; a bad value here only means no countdown
  }
}

/** The line under the lamp, the time of the last sign of life, and the deadline (spec 6.1). */
function finishRun(run: RunInfo, facts: MissionFacts[], data: HomeData, opts: SnapshotOptions, now: number, f: Formatter): RunInfo {
  const worked = run.active ? workedMission(facts) : null;
  let lastActivityAt: number | null = null;
  if (worked !== null) {
    const log = worked.openRun === null ? null : jobLogMtime(opts.home, worked.data.folder, worked.openRun.jobId);
    lastActivityAt = Math.min(now, Math.max(missionActivityAt(worked), log ?? 0));
  }
  const deadline = deadlineOf(run, opts.until, now, f);
  const lastActivityText = lastActivityAt === null ? null : f.ago(now - lastActivityAt);
  let line = RUN_NONE;
  if (run.active) {
    line = runLiveLine({ title: worked?.view.title ?? null, kindWord: worked?.view.kindWord ?? "", runningText: run.runningText, deadline });
  } else if (run.heartbeat === "stale" && data.lock !== null) {
    line = runStoppedAnswering(f.when(data.lock.mtimeMs, now));
  }
  return { ...run, lastActivityAt, lastActivityText, deadline, line, activityLine: lastActivityText === null ? null : activityLine(lastActivityText) };
}

// ───────────────────────────── Counts (spec 6.3, 12) ─────────────────────────────

function countsOf(facts: MissionFacts[], cards: ReturnType<typeof buildCards>, data: HomeData, hidden: number, cut: { missions: number; cards: number }): Counts {
  const recent = facts.filter((x) => x.view.scope === "recent" && x.view.readable);
  const earlier = facts.filter((x) => x.view.scope === "earlier");
  const done = recent.reduce((sum, x) => sum + x.view.featuresDone, 0);
  const total = recent.reduce((sum, x) => sum + x.view.featuresTotal, 0);
  const earlierNeedYou = earlier.filter((x) => x.view.state === "needs_you").length;
  const earlierWaitingForYou = earlier.filter((x) => x.view.state !== "needs_you" && x.data.mission?.stage === "complete").length;
  return {
    unreadableMissions: facts.filter((x) => !x.view.readable).length,
    openFromEarlier: earlier.length,
    earlierNeedYou,
    earlierWaitingForYou,
    recentMissions: recent.length,
    featuresDone: done,
    featuresTotal: total,
    featuresLine: featuresLine(done, total),
    questions: cards.filter((c) => c.kind === "decision" && !c.fromEarlier).length,
    stuckFeatures: recent.reduce((sum, x) => sum + x.view.features.filter((feature) => feature.state === "stuck").length, 0),
    olderMissionsHidden: hidden + (data.skippedFolders ?? 0),
    missionsNotShown: cut.missions,
    cardsNotShown: cut.cards,
  };
}

// ───────────────────────────── The snapshot ─────────────────────────────

function safeFormatter(timeZone: string | undefined): Formatter {
  try {
    return makeFormatter(timeZone);
  } catch {
    return makeFormatter(); // an unknown time zone name: use the process one
  }
}

function freshness(): Snapshot["freshness"] {
  return {
    pollEveryMs: POLL_INTERVAL_MS,
    staleAfterMs: PAGE_STALE_AFTER_MS,
    notRespondingAfterMs: PAGE_NOT_RESPONDING_AFTER_MS,
    notUpdatingText: NOT_UPDATING_TEXT,
    ...pageLamps(),
  };
}

function plainWait(wait: (WaitInfo & { loginAis?: string[] }) | null): WaitInfo | null {
  return wait === null ? null : { until: wait.until, untilText: wait.untilText, cause: wait.cause, text: wait.text };
}

/** Which missions are listed when there are more than `max`: the ones that need a look first, in their own order. */
function pickShown(facts: MissionFacts[], cards: NeedsYouCard[], worked: MissionFacts | null, max: number): MissionFacts[] {
  if (facts.length <= max) return facts;
  const red = new Set(cards.filter((c) => c.severity === "now").map((c) => c.missionId));
  const withCard = new Set(cards.map((c) => c.missionId));
  const rank = (x: MissionFacts): number => {
    const needsLook = x === worked || !x.view.readable || x.view.state === "needs_you" || x.view.state === "unknown" || red.has(x.view.id);
    return needsLook ? 0 : withCard.has(x.view.id) ? 1 : 2;
  };
  return facts
    .map((x, index) => ({ x, index, rank: rank(x) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((c) => c.x);
}

/** The debrief with its three lists of features cut to `cap` each (the verdict, the ticks and the counts stay exact). */
function shortenDebrief(debrief: Debrief | null, cap: number): Debrief | null {
  if (debrief === null || debrief.missions.every((d) => d.got.length <= cap && d.leftOut.length <= cap && d.recovered.length <= cap)) return debrief;
  return { ...debrief, missions: debrief.missions.map((d) => ({ ...d, got: d.got.slice(0, cap), leftOut: d.leftOut.slice(0, cap), recovered: d.recovered.slice(0, cap) })) };
}

/**
 * How much of the lists a build keeps. The first try keeps everything the caps allow; a smaller try is made only to fit
 * MAX_SNAPSHOT_BYTES. It only shortens what is listed: the lamp, the cards, the counts and the ticks are made from the
 * whole home first, so a smaller try never turns a problem into a calm lamp.
 */
interface Keep {
  features: number;
  timeline: number;
  missions: number;
  cards: number;
}

function build(opts: SnapshotOptions, now: number, f: Formatter, keep: Keep): Snapshot {
  const settings = opts.settings ?? builtInSettings();
  const data = readHome(opts.home);
  const lockRun = runFromLock(data, now, f);
  const scopes = scopeMissions(data, lockRun.active, now);
  const hidden = [...scopes.values()].filter((s) => s === "hidden").length;
  readDetails(
    opts.home,
    data,
    data.missions.filter((m) => scopes.get(m) !== "hidden").map((m) => m.folder),
  );

  // The lamp, the counts and the debrief's open items look at everything; only the lists below are cut (and counted).
  const facts = buildMissions(data, lockRun, now, f, settings);
  const allCards = buildCards(facts, f);
  const run = finishRun(lockRun, facts, data, opts, now, f);
  const shown = pickShown(facts, allCards, run.active ? workedMission(facts) : null, keep.missions);
  const shownIds = new Set(shown.map((x) => x.view.id));
  const cards = allCards.filter((c) => shownIds.has(c.missionId)).slice(0, keep.cards);
  attachCardIds(shown, cards);
  const counts = countsOf(facts, allCards, data, hidden, { missions: facts.length - shown.length, cards: allCards.length - cards.length });
  const banner = facts.find((x) => x.view.scope === "recent" && x.view.state === "waiting" && x.wait !== null);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    generatedAtText: f.clock(now),
    freshness: freshness(),
    lamp: buildLamp({ now, home: data.home, run, missions: facts, cards: allCards, counts }),
    run,
    now: buildNow(facts, run, f, now),
    missions: shown.map((x) => (x.view.features.length <= keep.features ? x.view : { ...x.view, features: pickFeatureViews(x.view.features, keep.features) })),
    needsYou: cards,
    allowance: buildAllowance(data.quota, data.quotaMtimeMs, settings, plainWait(banner?.wait ?? null), now, f),
    timeline: buildTimeline(shown, now, f, keep.timeline),
    debrief: shortenDebrief(buildDebrief(shown, allCards, data.usage, f), keep.features),
    counts,
    leader: leaderHelp(),
  };
}

/**
 * Each try keeps less than the one before. A normal home fits the first try; only a home with very many features,
 * questions and missions needs a later one, and then the cuts are counted (featuresTotal, earlierNotShown,
 * counts.missionsNotShown, counts.cardsNotShown) and what needs a look is kept first (pickFeatures, pickShown, the
 * red cards). The last try holds one mission and one card, which is always small.
 */
const KEEP_TRIES: readonly Keep[] = [
  { features: MAX_FEATURES_SHOWN, timeline: TIMELINE_MAX_ITEMS, missions: MAX_MISSIONS_SHOWN, cards: MAX_CARDS_SHOWN },
  { features: 30, timeline: 20, missions: MAX_MISSIONS_SHOWN, cards: MAX_CARDS_SHOWN },
  { features: 10, timeline: 8, missions: MAX_MISSIONS_SHOWN, cards: MAX_CARDS_SHOWN },
  { features: 3, timeline: 3, missions: MAX_MISSIONS_SHOWN, cards: MAX_CARDS_SHOWN },
  { features: 1, timeline: 0, missions: MAX_MISSIONS_SHOWN, cards: MAX_CARDS_SHOWN },
  { features: 1, timeline: 0, missions: 15, cards: 25 },
  { features: 0, timeline: 0, missions: 8, cards: 12 },
  { features: 0, timeline: 0, missions: 3, cards: 5 },
  { features: 0, timeline: 0, missions: 1, cards: 1 },
];

function sizeOf(s: Snapshot): number {
  return Buffer.byteLength(JSON.stringify(s));
}

/** What the page can still show when the build itself failed: an amber lamp that says the files cannot be read. */
function degraded(now: number, f: Formatter): Snapshot {
  const run: RunInfo = {
    active: false,
    heartbeat: "none",
    startedAt: null,
    startedAtText: null,
    runningMs: null,
    runningText: null,
    heartbeatAgeMs: null,
    heartbeatText: null,
    stopRequested: false,
    lastActivityAt: null,
    lastActivityText: null,
    deadline: null,
    line: RUN_NONE,
    activityLine: null,
  };
  const counts: Counts = {
    unreadableMissions: 0,
    openFromEarlier: 0,
    earlierNeedYou: 0,
    earlierWaitingForYou: 0,
    recentMissions: 0,
    featuresDone: 0,
    featuresTotal: 0,
    featuresLine: featuresLine(0, 0),
    questions: 0,
    stuckFeatures: 0,
    olderMissionsHidden: 0,
    missionsNotShown: 0,
    cardsNotShown: 0,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    generatedAtText: f.clock(now),
    freshness: freshness(),
    lamp: buildLamp({ now, home: "unreadable", run, missions: [], cards: [], counts }),
    run,
    now: null,
    missions: [],
    needsYou: [],
    allowance: { providers: [], waiting: null, fileChangedAt: null, fileChangedText: null },
    timeline: { items: [], earlierNotShown: 0 },
    debrief: null,
    counts,
    leader: leaderHelp(),
  };
}

export function buildSnapshot(opts: SnapshotOptions): Snapshot {
  const now = opts.now !== undefined && Number.isFinite(opts.now) ? opts.now : Date.now();
  const f = safeFormatter(opts.timeZone);
  const maxBytes = opts.maxBytes ?? MAX_SNAPSHOT_BYTES;
  try {
    let snapshot = build(opts, now, f, KEEP_TRIES[0] as Keep);
    for (const keep of KEEP_TRIES.slice(1)) {
      if (sizeOf(snapshot) <= maxBytes) break;
      snapshot = build(opts, now, f, keep);
    }
    return snapshot;
  } catch (err) {
    opts.onError?.(err);
    return degraded(now, f);
  }
}
