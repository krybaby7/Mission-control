// Shared test helpers of the dashboard (docs/dashboard-spec.md 2.2): fixture homes, locks, hashing the home, and the
// shape check of a snapshot. Used by the dashboard's own tests, the server tests and the page tests.
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { afterAll } from "vitest";
import { MAX_CARDS_SHOWN, MAX_MISSIONS_SHOWN, MAX_SNAPSHOT_BYTES } from "../src/dashboard/constants.js";
import {
  CARD_KINDS,
  FEATURE_STATES,
  HEARTBEATS,
  LAMP_REASON_CODES,
  LAMP_SEVERITIES,
  LAMP_STATES,
  MISSION_STATES,
  NOW_KINDS,
  PAUSED_WHY,
  PILL_STATES,
  PROGRESS_STEPS,
  SCHEMA_VERSION,
  SCOPES,
  TICK_IDS,
  TICK_STATES,
  TONES,
  VERDICT_IDS,
  AUTHORS,
  type Snapshot,
} from "../src/dashboard/types.js";
import type { Feature, Mission, MissionEvent } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = join(HERE, "fixtures", "dashboard");

/** The mtime every file of a copied fixture gets, so a test never depends on when the repository was checked out. */
export const FIXTURE_MTIME_MS = Date.parse("2026-10-11T09:58:00.000Z");

const temps: string[] = [];

function freshFolder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Removes every folder this module made. It runs after the test file that imported this module, and at exit. */
export function cleanupHomes(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}
process.on("exit", cleanupHomes);
// A forked test worker is ended by a signal, which skips the exit handler: the hook below is the one that counts.
afterAll(cleanupHomes);

/** Folders left by a run that was killed: older than this they cannot belong to a test that is still going. */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
try {
  for (const entry of readdirSync(tmpdir())) {
    const path = join(tmpdir(), entry);
    if (entry.startsWith("mc-dash-") && Date.now() - lstatSync(path).mtimeMs > STALE_AFTER_MS) rmSync(path, { recursive: true, force: true });
  }
} catch {
  // another test run may be deleting the same folders; nothing to do
}

function setTreeMtime(dir: string, mtimeMs: number): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) setTreeMtime(path, mtimeMs);
    else touch(path, mtimeMs);
  }
  touch(dir, mtimeMs);
}

/** Copies test/fixtures/dashboard/<name>/ into a fresh temp folder and returns its absolute path. Mtimes are FIXTURE_MTIME_MS. */
export function copyHome(name: string): string {
  const source = join(FIXTURE_ROOT, name);
  if (!existsSync(source)) throw new Error(`no dashboard fixture named "${name}" (looked in ${FIXTURE_ROOT})`);
  const home = join(freshFolder("mc-dash-"), "home");
  cpSync(source, home, { recursive: true });
  setTreeMtime(home, FIXTURE_MTIME_MS);
  return home;
}

/**
 * Copies a home somebody else wrote (the real engine's, in test/checkpoint-dashboard.test.ts) into a fresh temp folder, with
 * the mtimes it had: unlike a fixture, its files are dated by the engine's own clock.
 */
export function copyHomeOf(source: string): string {
  const home = join(freshFolder("mc-dash-"), "home");
  cpSync(source, home, { recursive: true, preserveTimestamps: true });
  return home;
}

/** A fresh temp folder with an empty missions/ folder. */
export function emptyHome(): string {
  const home = join(freshFolder("mc-dash-"), "home");
  mkdirSync(join(home, "missions"), { recursive: true });
  return home;
}

/** A path that does not exist, inside a fresh temp folder. */
export function missingHome(): string {
  return join(freshFolder("mc-dash-"), "no-such-home");
}

/** Writes mc.lock = {pid, at, host} and sets its mtime to `now - ageMs` (the run's heartbeat). */
export function withLock(home: string, o: { at: string; ageMs: number; now: number; pid?: number; host?: string }): void {
  mkdirSync(home, { recursive: true });
  const file = join(home, "mc.lock");
  writeFileSync(file, JSON.stringify({ pid: o.pid ?? 4242, at: o.at, host: o.host ?? "mission-control-run" }));
  touch(file, o.now - o.ageMs);
}

/** Writes the STOP file. */
export function withStop(home: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "STOP"), "2026-10-11T09:58:00.000Z\n");
}

/** Sets a file's (or folder's) access and modification time. */
export function touch(path: string, mtimeMs: number): void {
  const t = new Date(mtimeMs);
  utimesSync(path, t, t);
}

/**
 * sha256 over the sorted list of "relative path, kind, size, mtimeMs, sha256 of the contents" for every file and
 * folder under `dir` (and `dir` itself). Equal before and after means nothing was created, changed, removed or touched.
 */
export function hashTree(dir: string): string {
  const lines: string[] = [];
  const walk = (path: string): void => {
    const st = lstatSync(path);
    const rel = relative(dir, path) || ".";
    const kind = st.isDirectory() ? "dir" : st.isFile() ? "file" : st.isSymbolicLink() ? "link" : "other";
    const content = st.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "-";
    lines.push(`${rel}\t${kind}\t${st.size}\t${st.mtimeMs}\t${content}`);
    if (st.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(dir);
  return createHash("sha256").update(lines.sort().join("\n")).digest("hex");
}

// ───────────────────────────── Building homes in code (the programmatic fixtures of spec 14.2) ─────────────────────────────

const CREATED = "2026-10-11T09:58:09.047Z";

/** A valid mission file; override any field. Defaults: a greenfield mission, running at stage features, no features. */
export function makeMission(o: Partial<Mission> & { id: string }): Mission {
  return {
    kind: "greenfield",
    title: o.id,
    request: "Build me something",
    repoPath: "/fixture/mc-apps/app",
    baseBranch: "main",
    integrationBranch: `mc/${o.id}`,
    profile: "mixed",
    roleOverrides: [],
    status: "running",
    stage: "features",
    createdAt: CREATED,
    updatedAt: CREATED,
    features: [],
    baselineBroken: false,
    baselineFailures: [],
    decisionsNeeded: [],
    gateCRounds: 0,
    agentRuns: 0,
    notes: [],
    ...o,
  };
}

/** A valid feature; override any field. */
export function makeFeature(o: Partial<Feature> & { id: string }): Feature {
  return {
    title: o.id,
    story: "A story.",
    acceptance: ["It works."],
    kind: "standard",
    deps: [],
    status: "pending",
    rung: 0,
    attempts: [],
    frozenTests: [],
    reviewRounds: 0,
    openFindings: [],
    ...o,
  };
}

/** One events.jsonl record. */
export function makeEvent(missionId: string, at: string | number, type: string, data: Record<string, unknown> = {}): MissionEvent {
  return { at: typeof at === "number" ? new Date(at).toISOString() : at, missionId, type, data };
}

/** Writes missions/<id>/mission.json (+ events.jsonl and dispatch.json when given) into a home and returns the mission's folder. */
export function writeMission(home: string, mission: Mission, extra: { events?: MissionEvent[]; dispatch?: unknown } = {}): string {
  const dir = join(home, "missions", mission.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mission.json"), JSON.stringify(mission, null, 2) + "\n");
  if (extra.events !== undefined) writeFileSync(join(dir, "events.jsonl"), extra.events.map((e) => JSON.stringify(e)).join("\n") + (extra.events.length > 0 ? "\n" : ""));
  if (extra.dispatch !== undefined) writeFileSync(join(dir, "dispatch.json"), JSON.stringify(extra.dispatch, null, 2) + "\n");
  return dir;
}

// ───────────────────────────── The shape of a snapshot (T-SHAPE) ─────────────────────────────

type Errors = string[];
type Check = (v: unknown, path: string, errs: Errors) => void;

/** What a snapshot string must not hold: controls, line separators, every format character and the blank fillers and selectors (src/dashboard/sanitize.ts). */
const CONTROL =
  /[\u{0}-\u{8}\u{b}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}\u{34f}\u{115f}\u{1160}\u{17b4}\u{17b5}\u{180b}-\u{180f}\u{3164}\u{fe00}-\u{fe0f}\u{ffa0}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}\p{Cf}]/u;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const str: Check = (v, path, errs) => {
  if (typeof v !== "string") errs.push(`${path}: expected a string, got ${describe(v)}`);
};
const text: Check = (v, path, errs) => {
  if (typeof v !== "string" || v.trim() === "") errs.push(`${path}: expected a non-empty string, got ${describe(v)}`);
};
const num: Check = (v, path, errs) => {
  if (typeof v !== "number" || !Number.isFinite(v)) errs.push(`${path}: expected a finite number, got ${describe(v)}`);
};
const count: Check = (v, path, errs) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) errs.push(`${path}: expected a whole number of 0 or more, got ${describe(v)}`);
};
const bool: Check = (v, path, errs) => {
  if (typeof v !== "boolean") errs.push(`${path}: expected true or false, got ${describe(v)}`);
};
const lit =
  (list: readonly (string | number)[]): Check =>
  (v, path, errs) => {
    if (typeof v !== "string" && typeof v !== "number") errs.push(`${path}: expected one of ${list.join(", ")}, got ${describe(v)}`);
    else if (!list.includes(v)) errs.push(`${path}: "${String(v)}" is not one of ${list.join(", ")}`);
  };
const nullable =
  (check: Check): Check =>
  (v, path, errs) => {
    if (v !== null) check(v, path, errs);
  };
const arr =
  (item: Check): Check =>
  (v, path, errs) => {
    if (!Array.isArray(v)) errs.push(`${path}: expected a list, got ${describe(v)}`);
    else v.forEach((x, i) => item(x, `${path}[${i}]`, errs));
  };
/** `optional` keys may be absent (never undefined: that would not survive a JSON round trip); when present they are checked. */
const obj =
  (fields: Record<string, Check>, optional: Record<string, Check> = {}): Check =>
  (v, path, errs) => {
    if (!isRecord(v)) {
      errs.push(`${path}: expected an object, got ${describe(v)}`);
      return;
    }
    for (const [key, check] of Object.entries(fields)) {
      if (!(key in v)) errs.push(`${path}.${key}: missing`);
      else check(v[key], `${path}.${key}`, errs);
    }
    for (const [key, check] of Object.entries(optional)) if (key in v) check(v[key], `${path}.${key}`, errs);
    for (const key of Object.keys(v)) if (!(key in fields) && !(key in optional)) errs.push(`${path}.${key}: not part of the contract`);
  };

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a list";
  return typeof v === "string" ? `"${v.length > 30 ? v.slice(0, 30) + "..." : v}"` : typeof v === "object" ? "an object" : String(v);
}

const said = obj({ text: text, author: lit(AUTHORS) });
const lampReason = obj({ code: lit(LAMP_REASON_CODES), severity: lit(LAMP_SEVERITIES), text: text, missionId: nullable(str), featureId: nullable(str) });
const lamp = obj({ state: lit(LAMP_STATES), word: text, sentence: text, reasons: arr(lampReason) });
const waitInfo = obj({ until: num, untilText: str, cause: lit(["limits", "trouble", "login", "unknown"]), text: text });
const progressStep = obj({ id: lit(PROGRESS_STEPS), word: text, state: lit(["done", "current", "todo"]) });
const featureEvidence = obj({review:arr(text),tests:arr(text)});
const missionEvidence = obj({plan:arr(text),application:arr(text)});
const feature = obj(
  {
    id: text,
    title: text,
    state: lit(FEATURE_STATES),
    word: text,
    reason: nullable(said),
    steps: obj({ used: count, total: count, caption: text }),
    reinforcements: count,
    recovered: bool,
    acceptanceTests: count,
    isRepair: bool,
    cardId: nullable(text),
    tellLeader: text,
  },
  // Only for a feature checked by a second AI (docs/modes-spec.md, 11.5): the checks on its list, and, once done, how it was checked.
  { modeChecks: count, checkedBy: text, reviewRecord:featureEvidence },
);
const mission = obj({
  id: text,
  title: text,
  readable: bool,
  kind: lit(["new_app", "change"]),
  kindWord: text,
  scope: lit(SCOPES),
  openFromEarlier: bool,
  state: lit(MISSION_STATES),
  word: text,
  sentence: text,
  pausedWhy: nullable(lit(PAUSED_WHY)),
  progress: arr(progressStep),
  progressWord: str,
  repairLap: bool,
  featuresDone: count,
  featuresTotal: count,
  featuresLine: text,
  waiting: nullable(waitInfo),
  features: arr(feature),
  updatedAt: count,
  tellLeader: text,
}, {reviewRecord:missionEvidence});
const card = obj({
  id: text,
  kind: lit(CARD_KINDS),
  severity: lit(["now", "look"]),
  missionId: text,
  missionTitle: text,
  fromEarlier: bool,
  featureId: nullable(text),
  title: text,
  happened: said,
  summary: nullable(text),
  ifNothing: text,
  whatToDo: nullable(said),
  tellLeader: text,
},
{
  // only on a checkpoint card
  lines: arr(said),
  answers: obj({ approve: text, sendBack: text }),
});
const allowanceWindow = obj({
  id: text,
  label: text,
  usedFraction: num,
  usedPercent: num,
  fill: num,
  overage: bool,
  resetsAt: num,
  resetsText: text,
  pauseAt: nullable(num),
  text: text,
});
const providerAllowance = obj({
  id: text,
  label: text,
  pill: obj({ state: lit(PILL_STATES), word: text }),
  windows: arr(allowanceWindow),
  note: nullable(text),
  limitedUntil: nullable(num),
  limitedText: nullable(text),
}, { uncertainty: text });
const timelineItem = obj({
  at: num,
  time: text,
  day: text,
  missionId: text,
  featureId: nullable(str),
  tone: lit(TONES),
  text: text,
  note: nullable(said),
  author: lit(AUTHORS),
  count: count,
});
const tick = obj({ id: lit(TICK_IDS), label: text, state: lit(TICK_STATES), why: text, caveat: nullable(text) });
const verdict = obj({ id: lit(VERDICT_IDS), word: text, sentence: text });
const debriefFeature = obj({ featureId: text, title: text, note: nullable(said), attempts: count }, { checkedBy: text,reviewRecord:featureEvidence });
const missionDebrief = obj({
  missionId: text,
  title: text,
  verdict,
  plannedLine: text,
  got: arr(debriefFeature),
  leftOut: arr(debriefFeature),
  recovered: arr(debriefFeature),
  ticks: arr(tick),
  agentTimeText: nullable(text),
  agentRuns: nullable(count),
  tellLeader: text,
}, {reviewRecord:missionEvidence});

const snapshotShape = obj({
  schemaVersion: lit([SCHEMA_VERSION]),
  generatedAt: num,
  generatedAtText: (v, path, errs) => {
    if (typeof v !== "string" || !/^\d\d:\d\d:\d\d$/.test(v)) errs.push(`${path}: expected HH:MM:SS, got ${describe(v)}`);
  },
  freshness: obj({ pollEveryMs: num, staleAfterMs: num, notRespondingAfterMs: num, notUpdatingText: text, notUpdating: lamp, notResponding: lamp }),
  lamp,
  run: obj({
    active: bool,
    heartbeat: lit(HEARTBEATS),
    startedAt: nullable(num),
    startedAtText: nullable(text),
    runningMs: nullable(num),
    runningText: nullable(text),
    heartbeatAgeMs: nullable(num),
    heartbeatText: nullable(text),
    stopRequested: bool,
    lastActivityAt: nullable(num),
    lastActivityText: nullable(text),
    deadline: nullable(obj({ at: num, atText: text, leftMs: num, leftText: text })),
    line: text,
    activityLine: nullable(text),
  }),
  now: nullable(obj({ kind: lit(NOW_KINDS), text: text, missionId: nullable(text), featureId: nullable(text), since: nullable(num), sinceText: nullable(text), exact: bool })),
  missions: arr(mission),
  needsYou: arr(card),
  allowance: obj({ providers: arr(providerAllowance), waiting: nullable(waitInfo), fileChangedAt: nullable(num), fileChangedText: nullable(text) }, { policyText: text }),
  timeline: obj({ items: arr(timelineItem), earlierNotShown: count }),
  debrief: nullable(obj({ verdict, missions: arr(missionDebrief), allowanceNote: text, honestyNote: text })),
  counts: obj({
    unreadableMissions: count,
    openFromEarlier: count,
    earlierNeedYou: count,
    earlierWaitingForYou: count,
    recentMissions: count,
    featuresDone: count,
    featuresTotal: count,
    featuresLine: text,
    questions: count,
    stuckFeatures: count,
    olderMissionsHidden: count,
    missionsNotShown: count,
    cardsNotShown: count,
  }),
  leader: obj({ quickPhrases: arr(text), globalSentence: text, stopSentence: text, pasteHint: text, copyFailHint: text, aiNotice: text, canDo: text, stopNote: text }),
});

/** Every string free of control, bidi and zero-width characters; every number finite; nothing but plain JSON. */
function walkValues(v: unknown, path: string, errs: Errors): void {
  if (typeof v === "string") {
    if (CONTROL.test(v)) errs.push(`${path}: contains a control, bidi or zero-width character`);
  } else if (typeof v === "number") {
    if (!Number.isFinite(v)) errs.push(`${path}: is not a finite number`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => walkValues(x, `${path}[${i}]`, errs));
  } else if (isRecord(v)) {
    for (const [k, x] of Object.entries(v)) walkValues(x, `${path}.${k}`, errs);
  } else if (v !== null && typeof v !== "boolean") {
    errs.push(`${path}: ${typeof v} is not JSON`);
  }
}

const SEVERITY_ORDER = ["now", "look", "info", "ok"] as const;

function lampErrors(l: Record<string, unknown>, path: string, errs: Errors): void {
  const reasons = (Array.isArray(l.reasons) ? l.reasons : []).filter(isRecord);
  const severities = reasons.map((r) => r.severity);
  const codes = reasons.map((r) => r.code);
  const expected = severities.includes("now")
    ? "needs_you_now"
    : severities.includes("look")
      ? "needs_look"
      : codes.includes("working") || codes.includes("all_done")
        ? "on_track"
        : "idle";
  if (l.state !== expected) errs.push(`${path}.state: "${String(l.state)}" does not match its reasons (expected "${expected}")`);
  const ranks = severities.map((s) => SEVERITY_ORDER.indexOf(s as (typeof SEVERITY_ORDER)[number]));
  if (ranks.some((r) => r < 0)) errs.push(`${path}.reasons: unknown severity`);
  const okCount = severities.filter((s) => s === "ok").length;
  if (okCount !== 1 && !severities.some((s) => s === "now" || s === "look")) errs.push(`${path}.reasons: a calm lamp has exactly one ok reason, found ${okCount}`);
  if (okCount > 0 && severities.some((s) => s === "now" || s === "look")) errs.push(`${path}.reasons: an ok reason next to a problem`);
}

function crossErrors(s: Record<string, unknown>, errs: Errors): void {
  const missions = (Array.isArray(s.missions) ? s.missions : []).filter(isRecord);
  const cards = (Array.isArray(s.needsYou) ? s.needsYou : []).filter(isRecord);
  const counts = isRecord(s.counts) ? s.counts : {};
  const missionIds = new Set(missions.map((m) => m.id));
  if (missionIds.size !== missions.length) errs.push("missions: an id appears twice");
  const cardIds = new Set(cards.map((c) => c.id));
  if (cardIds.size !== cards.length) errs.push("needsYou: a card id appears twice");
  for (const c of cards) if (!missionIds.has(c.missionId)) errs.push(`needsYou ${String(c.id)}: mission "${String(c.missionId)}" is not in missions`);
  for (const c of cards) if (c.kind !== "checkpoint" && ("lines" in c || "answers" in c)) errs.push(`needsYou ${String(c.id)}: only a checkpoint card has lines and answers`);
  for (const m of missions) {
    const features = (Array.isArray(m.features) ? m.features : []).filter(isRecord);
    if (Array.isArray(m.progress) && m.progress.length !== PROGRESS_STEPS.length) errs.push(`missions ${String(m.id)}: progress has ${m.progress.length} steps`);
    for (const f of features) if (f.cardId !== null && !cardIds.has(f.cardId)) errs.push(`feature ${String(f.id)}: cardId "${String(f.cardId)}" is not a card`);
    if (m.readable === true && typeof m.featuresTotal === "number" && m.featuresTotal < features.length) errs.push(`missions ${String(m.id)}: featuresTotal is below the features shown`);
  }
  // Counts cover every mission; the list is cut at MAX_MISSIONS_SHOWN and then the counts may be higher (never lower).
  const cut = counts.missionsNotShown;
  if (typeof cut !== "number" || cut < 0) errs.push("counts.missionsNotShown must be 0 or more");
  const agrees = (name: string, shown: number): void => {
    const total = counts[name];
    const ok = cut === 0 ? total === shown : typeof total === "number" && typeof cut === "number" && total >= shown && total <= shown + cut;
    if (!ok) errs.push(`counts.${name} (${String(total)}) does not match the missions (${shown} shown, ${String(cut)} not shown)`);
  };
  agrees("unreadableMissions", missions.filter((m) => m.readable === false).length);
  agrees("openFromEarlier", missions.filter((m) => m.scope === "earlier").length);
  agrees("recentMissions", missions.filter((m) => m.scope === "recent" && m.readable === true).length);
  if (missions.length > MAX_MISSIONS_SHOWN) errs.push(`missions: ${missions.length} listed, over the limit of ${MAX_MISSIONS_SHOWN}`);
  if (cards.length > MAX_CARDS_SHOWN) errs.push(`needsYou: ${cards.length} cards, over the limit of ${MAX_CARDS_SHOWN}`);
  const debrief = isRecord(s.debrief) ? s.debrief : null;
  if (debrief !== null) {
    for (const d of (Array.isArray(debrief.missions) ? debrief.missions : []).filter(isRecord)) {
      const ticks = Array.isArray(d.ticks) ? d.ticks : [];
      if (ticks.length !== TICK_IDS.length) errs.push(`debrief ${String(d.missionId)}: ${ticks.length} ticks, expected ${TICK_IDS.length}`);
      else TICK_IDS.forEach((id, i) => isRecord(ticks[i]) && ticks[i].id !== id && errs.push(`debrief ${String(d.missionId)}: tick ${i} is "${String(ticks[i].id)}", expected "${id}"`));
      if (!missionIds.has(d.missionId)) errs.push(`debrief: mission "${String(d.missionId)}" is not in missions`);
    }
  }
}

/**
 * Throws one Error that lists every problem found; returns normally when `s` is a valid Snapshot (T-SHAPE): the exact
 * keys and types of src/dashboard/types.ts, every id in its `as const` list, valid authors, four ticks, a lamp that
 * matches its reasons, no control or bidi characters, only finite numbers, an identical JSON round trip, under 200 KB.
 */
export function assertSnapshotShape(s: unknown): asserts s is Snapshot {
  const errs: Errors = [];
  snapshotShape(s, "snapshot", errs);
  if (isRecord(s)) {
    walkValues(s, "snapshot", errs);
    if (isRecord(s.lamp)) lampErrors(s.lamp, "lamp", errs);
    if (isRecord(s.freshness)) {
      const f = s.freshness;
      const stale = isRecord(f.notUpdating) ? f.notUpdating : {};
      const gone = isRecord(f.notResponding) ? f.notResponding : {};
      if (stale.state !== "needs_look" || !JSON.stringify(stale.reasons).includes('"page_stale"')) errs.push("freshness.notUpdating must be needs_look with the reason page_stale");
      if (gone.state !== "not_responding" || !JSON.stringify(gone.reasons).includes('"no_news"')) errs.push("freshness.notResponding must be not_responding with the reason no_news");
    }
    crossErrors(s, errs);
    let json: string | undefined;
    try {
      json = JSON.stringify(s);
    } catch (err) {
      errs.push(`the snapshot cannot be serialised: ${(err as Error).message}`);
    }
    if (json !== undefined) {
      if (!isDeepStrictEqual(JSON.parse(json), s)) errs.push("the snapshot changes in a JSON round trip (an undefined value, a Date or a function?)");
      const bytes = Buffer.byteLength(json);
      if (bytes > MAX_SNAPSHOT_BYTES) errs.push(`the snapshot is ${bytes} bytes, over the limit of ${MAX_SNAPSHOT_BYTES}`);
    }
  }
  if (errs.length > 0) throw new Error(`The snapshot is not valid (${errs.length} problem${errs.length === 1 ? "" : "s"}):\n- ${errs.join("\n- ")}`);
}
