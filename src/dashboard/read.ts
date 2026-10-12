// The only module of the dashboard that touches the disk. It reads the Mission Control home and nothing else, never
// writes, creates, locks or touches anything under it (docs/dashboard-spec.md, 1.1 and 3.2), and hands the rest of the
// dashboard plain, validated, cleaned data. Parsed files are cached by (inode, size, mtime) in memory only.
//
// What it reads: mc.lock, STOP, quota.json, usage.jsonl, and per mission mission.json, events.jsonl and a few values
// of dispatch.json. It does not use MissionStore.list() (it hides unreadable missions), activeRun() (it probes a pid)
// or logsDir() (it creates a folder).
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { MissionStore } from "../state.js";
import type { Attempt, CheckpointKind, CheckpointRecord, Feature, Mission, MissionEvent, PendingCheckpoint } from "../types.js";
import {
  CHECKPOINT_LINES_MAX,
  CHECKPOINT_LOG_MAX,
  DECISION_MAX_CHARS,
  EVENTS_TAIL_BYTES,
  EVENT_FIELD_MAX_CHARS,
  EVENT_LIST_MAX_ITEMS,
  EVENT_REASON_MAX_CHARS,
  ID_MAX_CHARS,
  MAX_DISPATCH_BYTES,
  MAX_EVENTS_BYTES,
  MAX_LOCK_BYTES,
  MAX_MISSION_BYTES,
  MAX_MISSION_FOLDERS,
  MAX_QUOTA_BYTES,
  MAX_TIME_MS,
  MAX_USAGE_BYTES,
  MAX_UTILIZATION,
  NOTE_MAX_CHARS,
  REASON_MAX_CHARS,
  TITLE_MAX_CHARS,
  WAIT_MARGIN_MS,
} from "./constants.js";
import { clean, cleanId } from "./sanitize.js";

// ───────────────────────────── What it returns ─────────────────────────────

export interface HomeData {
  /** The Mission Control folder itself. */
  home: "ok" | "missing" | "unreadable";
  /** null: no mc.lock. valid: it parses and its pid is a positive integer (the engine's rule). */
  lock: { valid: boolean; at: number | null; mtimeMs: number } | null;
  stopRequested: boolean;
  /** null: absent, unreadable, over the cap, or not an object. */
  quota: QuotaData | null;
  quotaMtimeMs: number | null;
  /** null: the ledger is missing or over the cap. */
  usage: UsageRecord[] | null;
  /** Readable and unreadable missions, by folder name. Folders without a mission.json are not here. */
  missions: MissionData[];
  /** Folders over MAX_MISSION_FOLDERS that were not scanned (the oldest ones). */
  skippedFolders?: number;
}

/** `raw` text is dropped inside read.ts and never leaves it. */
export interface QuotaData {
  limits: { provider: string; kind: string; until: number }[];
  modelBlocks: { provider: string; model: string; until: number }[];
  utilization: { provider: string; window: string; utilization: number; resetsAt: number }[];
}

export interface UsageRecord {
  missionId: string;
  durationMs: number;
}

export interface MissionData {
  /** The folder name, cleaned. */
  folder: string;
  /** false: mission.json exists but is invalid, over the cap, or fails the deep checks. */
  readable: boolean;
  /**
   * Validated, every string cleaned. Fields the dashboard does not show (request, paths, models, summaries, the spec)
   * are blank, so a path or a model name cannot leak. Shared between builds: never change it.
   */
  mission: Mission | null;
  /** mtime of mission.json. */
  mtimeMs: number;
  /** Oldest first (file order). null until readDetails ran for this mission. */
  events: MissionEvent[] | null;
  /** null until read. "unavailable": missing, unparseable or over the cap. */
  dispatch: DispatchPicks | "unavailable" | null;
  dispatchMtimeMs: number | null;
}

/** The only values taken from dispatch.json (the rest holds absolute paths and a copy of the app's git settings). */
export interface DispatchPicks {
  /** null: the file has none (the final check did not complete). */
  finalVerify: { ok: boolean; reviewed: boolean | null; blocking: number | null } | null;
  inflight: { label: string; feature: string | null; at: number | null } | null;
}

// ───────────────────────────── Small checks ─────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/**
 * A time a date can show, with room for the engine's margin that the allowance adds to it. A number beyond it (a
 * time in the wrong unit, a corrupt file) would make every time text throw, and one bad entry must not blind the page.
 */
const isTime = (v: unknown): v is number => isNumber(v) && Math.abs(v) <= MAX_TIME_MS - WAIT_MARGIN_MS;

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

/** A file time as whole milliseconds: the disk keeps more digits than a clock reading has, and the JSON stays clean. */
const wholeMs = (st: Stats): number => Math.round(st.mtimeMs);

type Probe = { kind: "missing" } | { kind: "error" } | { kind: "ok"; st: Stats };

/** stat that tells "not there" (also a path through a file) from "cannot be looked at". */
function probe(path: string): Probe {
  try {
    return { kind: "ok", st: statSync(path) };
  } catch (err) {
    return code(err) === "ENOENT" || code(err) === "ENOTDIR" ? { kind: "missing" } : { kind: "error" };
  }
}

// ───────────────────────────── The cache ─────────────────────────────

interface Keyed {
  ino: number;
  size: number;
  mtimeMs: number;
  value: unknown;
}

const cache = new Map<string, Keyed>();
const CACHE_MAX_ENTRIES = 5000;

/** Forgets every parsed file. The tests call it after they rewrite a file in place. */
export function clearReadCache(): void {
  cache.clear();
}

function cached<T>(path: string, st: Stats, make: () => T): T {
  const hit = cache.get(path);
  if (hit !== undefined && hit.ino === st.ino && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value as T;
  const value = make();
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(path, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, value });
  return value;
}

// ───────────────────────────── Phase 1: the home ─────────────────────────────

/** Folder names the engine's own MissionStore.list() would visit: directories whose name does not start with ".". */
function missionFolders(missionsDir: string): string[] {
  return readdirSync(missionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/** Whether the home can be looked at, without reading anything in it (for /healthz). */
export function homeStatus(homePath: string): "readable" | "missing" | "unreadable" {
  const where = probe(resolve(homePath));
  if (where.kind === "missing") return "missing";
  return where.kind === "ok" && where.st.isDirectory() ? "readable" : "unreadable";
}

export function readHome(homePath: string): HomeData {
  const home = resolve(homePath);
  const data: HomeData = { home: "ok", lock: null, stopRequested: false, quota: null, quotaMtimeMs: null, usage: null, missions: [] };
  const where = probe(home);
  if (where.kind === "missing") return { ...data, home: "missing" };
  if (where.kind === "error" || !where.st.isDirectory()) return { ...data, home: "unreadable" };

  data.lock = readLock(join(home, "mc.lock"));
  data.stopRequested = probe(join(home, "STOP")).kind === "ok";
  const quota = readQuota(join(home, "quota.json"));
  data.quota = quota.quota;
  data.quotaMtimeMs = quota.mtimeMs;
  data.usage = readUsage(join(home, "usage.jsonl"));

  const missionsDir = join(home, "missions");
  let folders: string[];
  try {
    folders = missionFolders(missionsDir);
  } catch (err) {
    if (code(err) !== "ENOENT") data.home = "unreadable";
    return data;
  }
  if (folders.length > MAX_MISSION_FOLDERS) {
    const newestFirst = folders
      .map((name) => ({ name, mtimeMs: mtimeOf(join(missionsDir, name)) }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
    data.skippedFolders = folders.length - MAX_MISSION_FOLDERS;
    folders = newestFirst.slice(0, MAX_MISSION_FOLDERS).map((f) => f.name).sort();
  }
  const store = new MissionStore(home);
  for (const name of folders) {
    const entry = loadMissionData(store, home, name);
    if (entry !== null) data.missions.push(entry);
  }
  return data;
}

function mtimeOf(path: string): number {
  const where = probe(path);
  return where.kind === "ok" ? wholeMs(where.st) : 0;
}

function readLock(file: string): HomeData["lock"] {
  const where = probe(file);
  if (where.kind === "missing") return null;
  if (where.kind === "error") return { valid: false, at: null, mtimeMs: 0 };
  const { st } = where;
  if (!st.isFile() || st.size > MAX_LOCK_BYTES) return { valid: false, at: null, mtimeMs: wholeMs(st) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { valid: false, at: null, mtimeMs: wholeMs(st) };
  }
  if (!isRecord(parsed)) return { valid: false, at: null, mtimeMs: wholeMs(st) };
  // The engine's rule (src/state.ts, parseLockHolder): pid 0 and negative pids never identify a holder.
  const { pid, at } = parsed;
  const valid = typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
  return { valid, at: valid && isString(at) && Number.isFinite(Date.parse(at)) ? Date.parse(at) : null, mtimeMs: wholeMs(st) };
}

function readQuota(file: string): { quota: QuotaData | null; mtimeMs: number | null } {
  const where = probe(file);
  if (where.kind !== "ok" || !where.st.isFile() || where.st.size > MAX_QUOTA_BYTES) return { quota: null, mtimeMs: null };
  const { st } = where;
  const quota = cached(file, st, (): QuotaData | null => {
    try {
      return pickQuota(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  });
  return { quota, mtimeMs: quota === null ? null : wholeMs(st) };
}

/** The valid entries of quota.json; one bad entry never spoils the rest. `raw` provider text is dropped here. */
function pickQuota(parsed: unknown): QuotaData | null {
  if (!isRecord(parsed)) return null;
  const out: QuotaData = { limits: [], modelBlocks: [], utilization: [] };
  if (isRecord(parsed.limits)) {
    for (const [provider, v] of Object.entries(parsed.limits)) {
      if (isRecord(v) && isString(v.kind) && isTime(v.until)) out.limits.push({ provider: cleanId(provider), kind: cleanId(v.kind), until: v.until });
    }
  }
  if (Array.isArray(parsed.modelBlocks)) {
    for (const v of parsed.modelBlocks) {
      if (isRecord(v) && isString(v.provider) && isString(v.model) && isTime(v.until)) {
        out.modelBlocks.push({ provider: cleanId(v.provider), model: cleanId(v.model), until: v.until });
      }
    }
  }
  if (Array.isArray(parsed.utilization)) {
    for (const v of parsed.utilization) {
      if (isRecord(v) && isString(v.provider) && isString(v.window) && isNumber(v.utilization) && Math.abs(v.utilization) <= MAX_UTILIZATION && isTime(v.resetsAt)) {
        out.utilization.push({ provider: cleanId(v.provider), window: cleanId(v.window), utilization: v.utilization, resetsAt: v.resetsAt });
      }
    }
  }
  return out;
}

function readUsage(file: string): UsageRecord[] | null {
  const where = probe(file);
  if (where.kind !== "ok" || !where.st.isFile() || where.st.size > MAX_USAGE_BYTES) return null;
  const { st } = where;
  return cached(file, st, (): UsageRecord[] | null => {
    try {
      const records: UsageRecord[] = [];
      for (const v of parseLines(readFileSync(file, "utf8"))) {
        if (isRecord(v) && isString(v.missionId) && isNumber(v.durationMs) && v.durationMs >= 0) records.push({ missionId: cleanId(v.missionId), durationMs: v.durationMs });
      }
      return records;
    } catch {
      return null;
    }
  });
}

/** One JSON value per line; blank and torn lines are skipped (like readJsonl in the engine). */
function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn or corrupt line
    }
  }
  return out;
}

// ───────────────────────────── Missions ─────────────────────────────

/** The folder's real name, for reading its files. MissionData.folder is the cleaned one. */
const rawNames = new WeakMap<MissionData, string>();

function unreadable(name: string, mtimeMs: number): MissionData {
  const entry: MissionData = { folder: cleanId(name), readable: false, mission: null, mtimeMs, events: null, dispatch: null, dispatchMtimeMs: null };
  rawNames.set(entry, name);
  return entry;
}

/** null: the folder has no mission.json (half-created or stray), so it is not a mission. */
function loadMissionData(store: MissionStore, home: string, name: string): MissionData | null {
  const file = join(home, "missions", name, "mission.json");
  const where = probe(file);
  if (where.kind === "missing") return null;
  if (where.kind === "error") return unreadable(name, 0);
  const { st } = where;
  if (!st.isFile() || st.size > MAX_MISSION_BYTES) return unreadable(name, wholeMs(st));
  const mission = cached(file, st, () => parseMission(store, name));
  if (mission === null) return unreadable(name, wholeMs(st));
  const entry: MissionData = { folder: mission.id, readable: true, mission, mtimeMs: wholeMs(st), events: null, dispatch: null, dispatchMtimeMs: null };
  rawNames.set(entry, name);
  return entry;
}

function parseMission(store: MissionStore, name: string): Mission | null {
  try {
    return cleanMission(store.load(name));
  } catch {
    return null;
  }
}

const KINDS = new Set(["greenfield", "feature"]);
const ACTIONS = new Set(["build", "diagnose", "fix"]);
const OUTCOMES = new Set(["pass", "fail", "limited", "error"]);

/**
 * The deep checks of 3.2 on top of MissionStore.load's top-level ones, and the cleaning of every string. null when the
 * file is not usable. Anything the dashboard does not show is blanked.
 */
function cleanMission(m: Mission): Mission | null {
  const raw = m as unknown as Record<string, unknown>;
  if (!KINDS.has(m.kind)) return null;
  const id = cleanId(m.id);
  const features: Feature[] = [];
  for (const f of m.features as unknown[]) {
    if (!isRecord(f) || !isString(f.id) || !isString(f.title) || !isString(f.status)) return null;
    features.push(cleanFeature(f));
  }
  const created = new Date(Date.parse(m.createdAt)).toISOString();
  const updated = Number.isFinite(Date.parse(m.updatedAt)) ? new Date(Date.parse(m.updatedAt)).toISOString() : created;
  const failure = raw.failure;
  const checkpoints = checkpointKinds(raw.checkpoints);
  const checkpoint = cleanCheckpoint(raw.checkpoint);
  const checkpointLog = cleanCheckpointLog(raw.checkpointLog);
  return {
    id,
    kind: m.kind,
    title: clean(m.title, TITLE_MAX_CHARS) || id,
    request: "",
    repoPath: "",
    baseBranch: "",
    integrationBranch: "",
    profile: "",
    roleOverrides: [],
    status: cleanId(m.status) as Mission["status"],
    stage: cleanId(m.stage) as Mission["stage"],
    createdAt: created,
    updatedAt: updated,
    features,
    baselineBroken: m.baselineBroken,
    baselineFailures: [],
    decisionsNeeded: strings(m.decisionsNeeded, DECISION_MAX_CHARS),
    gateCRounds: isNumber(m.gateCRounds) ? m.gateCRounds : 0,
    agentRuns: isNumber(m.agentRuns) ? m.agentRuns : 0,
    notes: strings(m.notes, NOTE_MAX_CHARS),
    ...(isRecord(failure) && isString(failure.reason) && typeof failure.retryable === "boolean"
      ? {
          failure: {
            reason: clean(failure.reason, REASON_MAX_CHARS),
            ...(isString(failure.decision) && { decision: clean(failure.decision, DECISION_MAX_CHARS) }),
            retryable: failure.retryable,
          },
        }
      : {}),
    ...(checkpoints.length > 0 && { checkpoints }),
    ...(checkpoint !== undefined && { checkpoint }),
    ...(checkpointLog.length > 0 && { checkpointLog }),
  };
}

// ───────────────────────────── Checkpoints (docs/checkpoints-spec.md, 4 and 10) ─────────────────────────────
// The owner's note, the fingerprint a rework resumes from, the changed files and the screenshots are not read: the page
// shows none of them, and the note is the owner's own text, which never needs to travel.

const CHECKPOINT_KINDS = new Set<string>(["plan", "feature", "final"]);
const DECISIONS = new Set<string>(["approve", "send_back"]);

const isKind = (v: unknown): v is CheckpointKind => isString(v) && CHECKPOINT_KINDS.has(v);

function checkpointKinds(list: unknown): CheckpointKind[] {
  return Array.isArray(list) ? [...new Set(list.filter(isKind))] : [];
}

function isoOrNow(v: unknown): string {
  return isString(v) && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : new Date(0).toISOString();
}

/** The checkpoint of a mission file, or undefined when it is missing or not a checkpoint (it is then no checkpoint at all). */
function cleanCheckpoint(v: unknown): PendingCheckpoint | undefined {
  if (!isRecord(v) || !isKind(v.kind) || !isString(v.id) || !isString(v.scope)) return undefined;
  if (v.state !== "pending" && v.state !== "answered") return undefined;
  const look = isRecord(v.look) ? v.look : {};
  const answer = isRecord(v.answer) ? v.answer : null;
  return {
    id: cleanId(v.id),
    scope: cleanId(v.scope),
    kind: v.kind,
    ...(isString(v.featureId) && { featureId: cleanId(v.featureId) }),
    round: isNumber(v.round) && v.round >= 1 ? Math.floor(v.round) : 1,
    state: v.state,
    parkedAt: isoOrNow(v.parkedAt),
    look: {
      headline: isString(look.headline) ? clean(look.headline, TITLE_MAX_CHARS) : "",
      lines: strings(look.lines, REASON_MAX_CHARS).slice(0, CHECKPOINT_LINES_MAX),
      ...(isString(look.branch) && clean(look.branch, ID_MAX_CHARS) !== "" && { branch: clean(look.branch, ID_MAX_CHARS) }),
    },
    ...(answer !== null && isString(answer.decision) && DECISIONS.has(answer.decision) && { answer: { decision: answer.decision as "approve" | "send_back", at: isoOrNow(answer.at) } }),
  };
}

function cleanCheckpointLog(list: unknown): CheckpointRecord[] {
  if (!Array.isArray(list)) return [];
  const out: CheckpointRecord[] = [];
  for (const r of list) {
    if (!isRecord(r) || !isKind(r.kind) || !isString(r.id) || !isString(r.scope) || !isString(r.decision) || !DECISIONS.has(r.decision)) continue;
    out.push({
      id: cleanId(r.id),
      scope: cleanId(r.scope),
      kind: r.kind,
      ...(isString(r.featureId) && { featureId: cleanId(r.featureId) }),
      round: isNumber(r.round) && r.round >= 1 ? Math.floor(r.round) : 1,
      decision: r.decision as "approve" | "send_back",
      at: isoOrNow(r.at),
    });
  }
  return out.slice(-CHECKPOINT_LOG_MAX);
}

/** The strings of a list, cleaned; other entries are dropped. Empty strings are kept out: they say nothing. */
function strings(list: unknown, max: number): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isString).map((s) => clean(s, max)).filter((s) => s !== "");
}

function cleanFeature(f: Record<string, unknown>): Feature {
  const id = cleanId(f.id);
  const attempts: Attempt[] = [];
  if (Array.isArray(f.attempts)) {
    for (const a of f.attempts) {
      if (isRecord(a) && isString(a.action) && ACTIONS.has(a.action) && isString(a.outcome) && OUTCOMES.has(a.outcome)) {
        attempts.push({
          rung: isNumber(a.rung) ? a.rung : 0,
          action: a.action as Attempt["action"],
          provider: "mock",
          model: "",
          effort: "medium",
          outcome: a.outcome as Attempt["outcome"],
          summary: "",
          at: "",
        });
      }
    }
  }
  const blocked = isString(f.blockedReason) ? clean(f.blockedReason, REASON_MAX_CHARS) : "";
  return {
    id,
    title: clean(f.title, TITLE_MAX_CHARS) || id,
    story: isString(f.story) ? clean(f.story, REASON_MAX_CHARS) : "",
    acceptance: [],
    kind: f.kind === "mechanical" ? "mechanical" : "standard",
    deps: [],
    status: cleanId(f.status) as Feature["status"],
    rung: isNumber(f.rung) ? f.rung : 0,
    attempts,
    frozenTests: Array.isArray(f.frozenTests) ? f.frozenTests.map(() => ({ path: "", sha256: "" })) : [],
    reviewRounds: isNumber(f.reviewRounds) ? f.reviewRounds : 0,
    openFindings: [],
    ...(blocked !== "" && { blockedReason: blocked }),
  };
}

// ───────────────────────────── Phase 2: events and dispatch ─────────────────────────────

/** Fills in the events and the dispatch.json values of the missions named in `folders` (those in scope). */
export function readDetails(homePath: string, data: HomeData, folders: string[]): void {
  const home = resolve(homePath);
  const wanted = new Set(folders);
  for (const entry of data.missions) {
    if (!wanted.has(entry.folder)) continue;
    const name = rawNames.get(entry) ?? entry.folder;
    const dir = join(home, "missions", name);
    if (!entry.readable) {
      entry.events = [];
      entry.dispatch = "unavailable";
      continue;
    }
    entry.events = readEvents(join(dir, "events.jsonl"), entry.folder);
    const dispatch = readDispatch(join(dir, "dispatch.json"));
    entry.dispatch = dispatch.picks;
    entry.dispatchMtimeMs = dispatch.mtimeMs;
  }
}

function readEvents(file: string, folder: string): MissionEvent[] {
  const where = probe(file);
  if (where.kind !== "ok" || !where.st.isFile()) return [];
  const { st } = where;
  return cached(file, st, (): MissionEvent[] => {
    try {
      const text = st.size > MAX_EVENTS_BYTES ? readTail(file, EVENTS_TAIL_BYTES) : readFileSync(file, "utf8");
      const events: MissionEvent[] = [];
      for (const v of parseLines(text)) {
        const e = pickEvent(v, folder);
        if (e !== null) events.push(e);
      }
      return events;
    } catch {
      return [];
    }
  });
}

/** The last `bytes` of a file, starting on a line boundary (a partial first line is dropped). Opens read-only. */
function readTail(file: string, bytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    // One byte more than asked: when it is a newline, the line after it is whole.
    const start = Math.max(0, size - bytes - 1);
    const buf = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buf.length) {
      const n = readSync(fd, buf, filled, buf.length - filled, start + filled);
      if (n === 0) break;
      filled += n;
    }
    const text = buf.subarray(0, filled).toString("utf8");
    if (start === 0) return text;
    const firstBreak = text.indexOf("\n");
    return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
  } finally {
    closeSync(fd);
  }
}

/** The data keys the timeline and the now line use (spec 7.1 and 1.4). Every other key is dropped here. */
const EVENT_TEXT_KEYS = ["stage", "status", "from", "to", "action", "outcome", "role", "until", "kind", "decision"] as const;
const EVENT_LIST_KEYS = ["files", "features"] as const;

function pickEvent(v: unknown, folder: string): MissionEvent | null {
  if (!isRecord(v) || !isString(v.at) || !Number.isFinite(Date.parse(v.at)) || !isString(v.type) || !isRecord(v.data)) return null;
  const d = v.data;
  const data: Record<string, unknown> = {};
  for (const key of EVENT_TEXT_KEYS) if (isString(d[key])) data[key] = clean(d[key], EVENT_FIELD_MAX_CHARS);
  if (isString(d.reason)) data.reason = clean(d.reason, EVENT_REASON_MAX_CHARS);
  if (isString(d.feature)) data.feature = cleanId(d.feature);
  if (isString(d.label)) data.label = clean(d.label, EVENT_FIELD_MAX_CHARS);
  if (isString(d.jobId)) data.jobId = clean(d.jobId, EVENT_FIELD_MAX_CHARS);
  if (isNumber(d.rung)) data.rung = d.rung;
  if (typeof d.ok === "boolean") data.ok = d.ok;
  if (typeof d.timedOut === "boolean") data.timedOut = d.timedOut;
  for (const key of EVENT_LIST_KEYS) {
    // Only how many there are is shown, never the names (they are paths).
    if (Array.isArray(d[key])) data[key] = d[key].slice(0, EVENT_LIST_MAX_ITEMS).map(() => "");
  }
  return { at: new Date(Date.parse(v.at)).toISOString(), missionId: isString(v.missionId) ? cleanId(v.missionId) : folder, type: clean(v.type, ID_MAX_CHARS), data };
}

function readDispatch(file: string): { picks: DispatchPicks | "unavailable"; mtimeMs: number | null } {
  const where = probe(file);
  if (where.kind !== "ok" || !where.st.isFile() || where.st.size > MAX_DISPATCH_BYTES) return { picks: "unavailable", mtimeMs: null };
  const { st } = where;
  const picks = cached(file, st, (): DispatchPicks | "unavailable" => {
    try {
      return pickDispatch(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return "unavailable";
    }
  });
  return { picks, mtimeMs: picks === "unavailable" ? null : wholeMs(st) };
}

/** Keeps `finalVerify` and `inflight` and drops every other key of dispatch.json (spec 1.5). */
function pickDispatch(parsed: unknown): DispatchPicks | "unavailable" {
  if (!isRecord(parsed)) return "unavailable";
  const fv = parsed.finalVerify;
  const inflight = parsed.inflight;
  return {
    finalVerify:
      isRecord(fv) && typeof fv.ok === "boolean"
        ? { ok: fv.ok, reviewed: typeof fv.reviewed === "boolean" ? fv.reviewed : null, blocking: isNumber(fv.blocking) ? fv.blocking : null }
        : null,
    inflight:
      isRecord(inflight) && isString(inflight.label)
        ? {
            label: clean(inflight.label, EVENT_FIELD_MAX_CHARS),
            feature: isString(inflight.feature) ? cleanId(inflight.feature) : null,
            at: isString(inflight.at) && Number.isFinite(Date.parse(inflight.at)) ? Date.parse(inflight.at) : null,
          }
        : null,
  };
}

/** mtime of logs/<jobId>.ndjson, or null. Only looks (statSync); never creates logs/. */
export function jobLogMtime(homePath: string, folder: string, jobId: string): number | null {
  const safe = (name: string): boolean => /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
  if (!safe(jobId) || !safe(folder)) return null;
  const where = probe(join(resolve(homePath), "missions", folder, "logs", `${jobId}.ndjson`));
  return where.kind === "ok" && where.st.isFile() ? wholeMs(where.st) : null;
}
