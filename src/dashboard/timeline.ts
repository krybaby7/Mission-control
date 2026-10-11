// The night in plain sentences, from each mission's events.jsonl through the translation table
// (docs/dashboard-spec.md, section 7). Pure: it gets the missions the other modules built and the clock.
//
// Every event type the engine writes is listed in the table. A type that is not listed is hidden and never shown raw
// (the CLI's own fallback prints the event data, which can hold paths, commits and AI text).
import { cleanId, clean } from "./sanitize.js";
import { REASON_MAX_CHARS, TIMELINE_MAX_ITEMS, TONIGHT_WINDOW_MS } from "./constants.js";
import { type MissionFacts, readLabel } from "./missions.js";
import type { Said, Timeline, TimelineItem, Tone } from "./types.js";
import { A_FEATURE, explainFailureReason, explainFeatureReason, stopReasonKind, TL, waitInfoFromEvent } from "./vocabulary-night.js";
import type { Formatter } from "./vocabulary.js";

/** M: a milestone, always kept. D: a detail, kept only as the newest still-open step of its feature (spec 7.2). */
type RowClass = "M" | "D";

interface Row {
  at: number;
  cls: RowClass;
  featureId: string | null;
  tone: Tone;
  text: string;
  note: Said | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** What the translation needs to know about one mission. */
interface Context {
  title: string;
  /** feature id -> title, from mission.json. */
  titles: Map<string, string>;
  /** feature id -> size of its ladder, from the snapshot's feature views. */
  ladder: Map<string, number>;
  baselineBroken: boolean;
}

function contextOf(facts: MissionFacts): Context {
  const titles = new Map<string, string>();
  for (const feature of facts.data.mission?.features ?? []) titles.set(feature.id, feature.title);
  for (const feature of facts.view.features) if (!titles.has(feature.id)) titles.set(feature.id, feature.title);
  const ladder = new Map(facts.view.features.map((feature) => [feature.id, feature.steps.total]));
  return { title: facts.view.title, titles, ladder, baselineBroken: facts.baselineBroken };
}

/** The feature an event is about: the id as written (cleaned) and the title to show. Null when the event names none. */
function featureOf(data: Record<string, unknown>, ctx: Context): { id: string; title: string } | null {
  const raw = text(data.feature);
  if (raw === null) return null;
  const id = cleanId(raw);
  return { id, title: ctx.titles.get(id) ?? A_FEATURE };
}

/** The feature an agent run was for, from its label ("build-add-task"); null for stage-level runs and unknown ids. */
function featureOfLabel(label: unknown, ctx: Context): { id: string; title: string } | null {
  if (typeof label !== "string") return null;
  const id = readLabel(label, new Set(ctx.titles.keys())).featureId;
  const title = id === null ? undefined : ctx.titles.get(id);
  return id === null || title === undefined ? null : { id, title };
}

function row(at: number, cls: RowClass, tone: Tone, line: string, featureId: string | null = null, note: Said | null = null): Row {
  return { at, cls, featureId, tone, text: line, note };
}

/** One event as a row, or null when the table hides it. `revised` is true when an earlier `spec` event is in the window. */
function translate(type: string, data: Record<string, unknown>, at: number, ctx: Context, f: Formatter, now: number, revised: boolean): Row | null {
  const t = ctx.title;
  switch (type) {
    case "mission.start":
      return row(at, "M", "info", TL.missionStart(t));
    case "mission.resume":
      return row(at, "M", "info", TL.missionResume(t));
    case "mission.retry":
      return row(at, "M", "info", TL.missionRetry(t));
    case "mission.stopped": {
      const { text: line, tone } = TL.missionStopped(stopReasonKind(data.reason), t);
      return row(at, "M", tone, line);
    }
    case "mission.failed": {
      const reason = text(data.reason);
      return row(at, "M", "bad", TL.missionFailed(t), null, reason === null ? null : explainFailureReason(clean(reason, REASON_MAX_CHARS)));
    }
    case "mission.end": {
      const { text: line, tone } = TL.missionEnd(data.status, t);
      return row(at, "M", tone, line);
    }
    case "stage":
      return translateStage(data, at);
    case "feature.status":
      return translateFeatureStatus(data, at, ctx);
    case "attempt":
      return translateAttempt(data, at, ctx);
    case "verify":
      return translateVerify(data, at, ctx);
    case "merge": {
      const feature = featureOf(data, ctx);
      return feature === null ? null : row(at, "M", "good", TL.merged(feature.title), feature.id);
    }
    case "run.end": {
      const outcome = data.outcome;
      if (outcome === "timeout" || outcome === "crashed") {
        const feature = featureOfLabel(data.label, ctx);
        return row(at, "M", "warn", TL.aiStepUnfinished(feature === null ? null : feature.title), feature === null ? null : feature.id);
      }
      if (outcome === "auth") return row(at, "M", "bad", TL.loginExpired);
      return null;
    }
    case "limit.wait":
      return row(at, "M", "warn", waitInfoFromEvent(data, (ms) => f.when(ms, now)).text);
    case "error": {
      const feature = featureOf(data, ctx);
      return row(at, "M", "bad", TL.internalError(feature === null ? null : feature.title), feature === null ? null : feature.id);
    }
    case "spec": {
      const n = Array.isArray(data.features) ? data.features.length : 0;
      return row(at, "M", "info", TL.planReady(n, revised));
    }
    case "tests.frozen": {
      const feature = featureOf(data, ctx);
      if (feature === null || !Array.isArray(data.files)) return null;
      return row(at, "D", "info", TL.testsWritten(feature.title, data.files.length), feature.id);
    }
    case "tests.stray": {
      const feature = featureOf(data, ctx);
      return feature === null ? null : row(at, "M", "warn", TL.testsStray(feature.title), feature.id);
    }
    case "frozen.reverted": {
      const feature = featureOf(data, ctx);
      return feature === null ? null : row(at, "M", "warn", TL.frozenReverted(feature.title), feature.id);
    }
    case "feature.added":
      return row(at, "M", "warn", TL.repairFeatureAdded);
    case "run.interrupted":
      return row(at, "M", "warn", TL.runInterrupted);
    case "git.settings.restored":
      return row(at, "M", "warn", TL.versionSettingsRestored);
    default:
      // run.start powers the Now line; report, processes.reaped, branch.restored and git.locks.removed are noise;
      // anything else is not in the table.
      return null;
  }
}

function translateStage(data: Record<string, unknown>, at: number): Row | null {
  const pair = `${String(data.from)}>${String(data.to)}`;
  if (pair === "features>gate_c") return row(at, "M", "info", TL.buildingFinished);
  if (pair === "gate_c>features") return row(at, "M", "warn", TL.repairRound);
  if (pair === "features>finalize") return row(at, "M", "warn", TL.buildingSkipped);
  return null;
}

function translateFeatureStatus(data: Record<string, unknown>, at: number, ctx: Context): Row | null {
  const feature = featureOf(data, ctx);
  if (feature === null) return null;
  switch (data.to) {
    case "testing":
      return row(at, "D", "info", TL.featureStarted(feature.title), feature.id);
    case "reviewing":
      return row(at, "D", "info", TL.featureBuilt(feature.title), feature.id);
    case "blocked": {
      const reason = text(data.reason);
      const cleaned = reason === null ? "" : clean(reason, REASON_MAX_CHARS);
      return row(at, "M", "bad", TL.featureStuck(feature.title), feature.id, cleaned === "" ? null : explainFeatureReason(cleaned));
    }
    case "skipped":
      return row(at, "M", "warn", TL.featureLeftOut(feature.title), feature.id);
    default:
      // building and pending are hidden; done is told by the merge event.
      return null;
  }
}

function translateAttempt(data: Record<string, unknown>, at: number, ctx: Context): Row | null {
  const passed = data.outcome === "pass";
  if (data.feature === "_init") {
    return passed ? row(at, "M", "good", TL.foundationReady) : row(at, "M", "warn", TL.foundationRetry);
  }
  const feature = featureOf(data, ctx);
  if (feature === null) return null;
  switch (data.action) {
    case "build": {
      if (passed) return null;
      const rung = typeof data.rung === "number" && Number.isInteger(data.rung) && data.rung >= 0 ? data.rung : null;
      const of = ctx.ladder.get(feature.id) ?? null;
      return row(at, "M", "warn", TL.reinforcements(feature.title, rung === null ? null : rung + 1, of), feature.id);
    }
    case "diagnose":
      return passed ? row(at, "D", "info", TL.diagnosed(feature.title), feature.id) : row(at, "M", "warn", TL.diagnosisFailed(feature.title), feature.id);
    case "fix":
      return passed ? null : row(at, "M", "warn", TL.fixFailed(feature.title), feature.id);
    default:
      return null;
  }
}

function translateVerify(data: Record<string, unknown>, at: number, ctx: Context): Row | null {
  const ok = data.ok === true;
  if (data.label === "gate-c") {
    if (ok) return row(at, "M", "good", TL.finalTestsPassed);
    // With a red baseline the engine judges the final check by the regression run, so this failure is not news.
    return ctx.baselineBroken ? row(at, "M", "info", TL.baselineSuiteFailed) : row(at, "M", "warn", TL.finalTestsFailed);
  }
  if (data.label === "gate-c-features") {
    return ok ? row(at, "M", "good", TL.newFeatureTestsPassed) : row(at, "M", "warn", TL.newFeatureTestsFailed);
  }
  if (data.timedOut === true) {
    const feature = featureOf(data, ctx);
    return row(at, "M", "warn", TL.checkTimedOut(feature === null ? null : feature.title), feature === null ? null : feature.id);
  }
  // A red check before a build is expected, and a green one is told by the merge.
  return null;
}

/** Spec 7.2, rule 2: of a feature's detail rows, only the newest one after its last milestone stays. */
function dropSuperseded(rows: Row[]): Row[] {
  const lastMilestone = new Map<string, number>();
  const newestDetail = new Map<string, number>();
  rows.forEach((r, i) => {
    if (r.featureId === null) return;
    if (r.cls === "M") lastMilestone.set(r.featureId, i);
    else newestDetail.set(r.featureId, i);
  });
  return rows.filter((r, i) => {
    if (r.cls === "M" || r.featureId === null) return true;
    return i > (lastMilestone.get(r.featureId) ?? -1) && i === newestDetail.get(r.featureId);
  });
}

interface Merged extends Row {
  count: number;
}

/** Spec 7.2, rule 3: consecutive identical sentences of one mission become one. The notes must match too, so no AI text is lost. */
function mergeRepeats(rows: Row[]): Merged[] {
  const out: Merged[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    const sameNote = last !== undefined && last.note?.text === r.note?.text && last.note?.author === r.note?.author;
    if (last !== undefined && last.text === r.text && last.tone === r.tone && sameNote) last.count += 1;
    else out.push({ ...r, count: 1 });
  }
  return out;
}

/** `max` is the most items kept (TIMELINE_MAX_ITEMS unless the snapshot has to be made smaller). */
export function buildTimeline(m: MissionFacts[], now: number, f: Formatter, max = TIMELINE_MAX_ITEMS): Timeline {
  const windowStart = now - TONIGHT_WINDOW_MS;
  const items: (TimelineItem & { order: number })[] = [];
  let order = 0;

  for (const facts of m) {
    if (!facts.data.readable || facts.view.scope !== "tonight") continue;
    const ctx = contextOf(facts);
    const rows: Row[] = [];
    let specSeen = false;
    for (const event of facts.data.events ?? []) {
      const at = Date.parse(event.at);
      if (!Number.isFinite(at) || at < windowStart) continue;
      const data = isRecord(event.data) ? event.data : {};
      const translated = translate(event.type, data, at, ctx, f, now, specSeen);
      if (event.type === "spec") specSeen = true;
      if (translated !== null) rows.push(translated);
    }
    for (const r of mergeRepeats(dropSuperseded(rows))) {
      items.push({
        at: r.at,
        time: f.time(r.at),
        day: f.day(r.at),
        missionId: facts.view.id,
        featureId: r.featureId,
        tone: r.tone,
        text: r.text,
        note: r.note,
        author: r.note?.author === "ai" ? "ai" : "engine",
        count: r.count,
        order: order++,
      });
    }
  }

  // Oldest first; two events at the same instant stay in the order they were read (missions in order, then the file).
  items.sort((a, b) => a.at - b.at || a.order - b.order);
  const cut = Math.max(0, items.length - max);
  return {
    items: items.slice(cut).map(({ order: _order, ...item }) => item),
    earlierNotShown: cut,
  };
}
