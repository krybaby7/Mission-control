// Mission persistence under the Mission Control home: missions, events, usage ledger, STOP file, run lock.
//
// Layout:
//   <home>/missions/<id>/mission.json   one Mission (atomic writes)
//   <home>/missions/<id>/events.jsonl   MissionEvent lines
//   <home>/missions/<id>/logs/          agent and verify logs
//   <home>/missions/<id>/report.md      report
//   <home>/worktrees/<id>/              git worktrees of the mission
//   <home>/usage.jsonl                  global UsageRecord ledger
//   <home>/STOP                         graceful-stop request
//   <home>/mc.lock                      {pid, at, host, start} of the active `mc run`; its mtime is a heartbeat
//   <home>/mc.lock.<hash>.takeover      short-lived guard while a stale lock is being removed
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CheckpointKind, Mission, MissionEvent, MissionKind, PlanSource, RoleOverride, UsageRecord } from "./types.js";
import { appendJsonl, ensureDir, readJson, readJsonl, sha256, writeJsonAtomic } from "./util/fs.js";

const DEFAULT_SLUG_MAX = 40;
const SLUG_FALLBACK = "mission";

/** Lowercase ASCII slug of [a-z0-9-]: runs of other characters become one dash, no leading/trailing dash, never empty. */
export function slugify(s: string, maxLen: number = DEFAULT_SLUG_MAX): string {
  if (!Number.isInteger(maxLen) || maxLen < 1) throw new RangeError(`slugify: maxLen must be a positive integer, got ${maxLen}`);
  const slug = s
    .normalize("NFKD") // before lowercasing: "𝐇" and "ℌ" only become "H" here
    .toLowerCase()
    .replace(/\p{M}/gu, "") // drop diacritics left over from decomposition: "café" → "cafe"
    .replace(/['’]/g, "") // "bob's" → "bobs", not "bob-s"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
  return slug || SLUG_FALLBACK.slice(0, maxLen);
}

export interface CreateMissionInit {
  kind: MissionKind;
  title: string;
  request: string;
  repoPath: string;
  baseBranch: string;
  profile: string;
  roleOverrides?: RoleOverride[];
  /** Where the owner wants to look before the mission goes on; absent or empty = nowhere. */
  checkpoints?: CheckpointKind[];
  /** A plan written outside the team (mc plan queue); the mission adopts it instead of asking the planner. */
  plan?: PlanSource;
  /** `false` only: the owner chose `--no-owner-checkpoint`. It is copied into the mission only when it is `false`, so every other mission gets no new key. */
  ownerStops?: false;
  nowMs: number;
}

interface LockContent {
  pid: number;
  at: string;
  /** os.hostname() of the holder: the container id under Docker, where pids of other containers mean nothing. */
  host: string;
  /**
   * When the holder process started (see processStart), where /proc tells. A live process with the holder's pid but
   * another start time took the pid over after the holder died (after a restart, or in a new container).
   */
  start?: string;
}

/** What a lock file says about its holder; host and start are undefined in locks that predate them. */
interface LockHolder {
  pid: number;
  host: string | undefined;
  start: string | undefined;
}

/** Lock files this process currently holds, so a second acquisition in the same process is refused too. */
const locksHeldByThisProcess = new Set<string>();

const MAX_LOCK_ATTEMPTS = 5;
/**
 * A pid from another host or container cannot be probed, so a holder there proves it is alive by touching its
 * lock every LOCK_HEARTBEAT_MS, and its lock counts as stale once untouched for FOREIGN_LOCK_TTL_MS.
 */
const LOCK_HEARTBEAT_MS = 60_000;
const FOREIGN_LOCK_TTL_MS = 5 * 60_000;
/** A takeover guard is held for a few syscalls; one this old was left by a process that died holding it. */
const TAKEOVER_GUARD_TTL_MS = 10_000;

export class MissionStore {
  readonly home: string;

  constructor(home: string) {
    if (!isAbsolute(home)) throw new Error(`MissionStore: home must be an absolute path, got "${home}"`);
    this.home = home;
  }

  // ───────────── Missions ─────────────

  createMission(init: CreateMissionInit): Mission {
    const at = isoTime(init.nowMs); // validates nowMs before an id is reserved on disk
    const id = this.reserveMissionId(`${localDate(init.nowMs)}-${slugify(init.title)}`);
    const mission: Mission = {
      id,
      kind: init.kind,
      title: init.title,
      request: init.request,
      repoPath: init.repoPath,
      baseBranch: init.baseBranch,
      integrationBranch: `mc/${id}`,
      profile: init.profile,
      roleOverrides: init.roleOverrides?.map((o) => ({ ...o })) ?? [],
      status: "queued",
      stage: init.kind === "greenfield" ? "spec" : "onboard",
      createdAt: at,
      updatedAt: at,
      features: [],
      baselineBroken: false,
      baselineFailures: [],
      decisionsNeeded: [],
      gateCRounds: 0,
      agentRuns: 0,
      notes: [],
      ...(init.checkpoints?.length ? { checkpoints: [...init.checkpoints] } : {}),
      ...(init.plan ? { plan: init.plan } : {}),
      ...(init.ownerStops === false ? { ownerStops: false as const } : {}),
    };
    try {
      this.save(mission, init.nowMs);
    } catch (err) {
      rmSync(this.missionDir(id), { recursive: true, force: true }); // release the reserved id
      throw err;
    }
    return mission;
  }

  load(id: string): Mission {
    const file = this.missionFile(id);
    if (!existsSync(file)) throw new Error(`no mission with id "${id}" (looked for ${file})`);
    const data = readJson<unknown>(file);
    const badField = invalidMissionField(data);
    if (badField !== undefined) throw new Error(`${file} is not a valid mission file (bad or missing ${badField})`);
    const mission = data as Mission;
    if (mission.id !== id) throw new Error(`${file} holds mission "${mission.id}", expected "${id}"`);
    return mission;
  }

  /** Sets m.updatedAt and atomically rewrites the mission file. */
  save(m: Mission, nowMs: number = Date.now()): void {
    m.updatedAt = isoTime(nowMs);
    writeJsonAtomic(this.missionFile(m.id), m);
  }

  /** Every readable mission, oldest first. Directories without a valid mission file are skipped. */
  list(): Mission[] {
    const missions: Mission[] = [];
    for (const id of this.missionDirNames()) {
      try {
        missions.push(this.load(id));
      } catch {
        // half-created or corrupt mission directory
      }
    }
    return missions.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || compareStrings(a.id, b.id));
  }

  missionDir(id: string): string {
    return join(this.missionsRoot(), assertSafeId(id));
  }

  logsDir(id: string): string {
    return ensureDir(join(this.missionDir(id), "logs"));
  }

  reportPath(id: string): string {
    return join(this.missionDir(id), "report.md");
  }

  worktreesDir(missionId: string): string {
    return join(this.home, "worktrees", assertSafeId(missionId));
  }

  // ───────────── Events and usage ─────────────

  appendEvent(missionId: string, type: string, data: Record<string, unknown> = {}, nowMs: number = Date.now()): void {
    const event: MissionEvent = { at: isoTime(nowMs), missionId, type, data };
    appendJsonl(this.eventsFile(missionId), event);
  }

  /** The mission's events in append order; lines that are not event-shaped are skipped like corrupt ones. */
  readEvents(missionId: string): MissionEvent[] {
    return readJsonl<unknown>(this.eventsFile(missionId)).filter(isEventLike);
  }

  appendUsage(rec: UsageRecord): void {
    appendJsonl(this.usageFile(), rec);
  }

  /** The usage ledger, optionally only records at or after sinceMs. Lines that are not usage-shaped are skipped. */
  readUsage(sinceMs?: number): UsageRecord[] {
    const records = readJsonl<unknown>(this.usageFile()).filter(isUsageLike);
    if (sinceMs === undefined) return records;
    return records.filter((r) => Date.parse(r.at) >= sinceMs);
  }

  // ───────────── STOP file ─────────────

  stopRequested(): boolean {
    return existsSync(this.stopFile());
  }

  requestStop(): void {
    ensureDir(this.home);
    writeFileSync(this.stopFile(), `${new Date().toISOString()}\n`);
  }

  clearStop(): void {
    rmSync(this.stopFile(), { force: true });
  }

  // ───────────── Run lock ─────────────

  /**
   * Takes <home>/mc.lock for this process. Throws when a live process (another one, or this one through an
   * earlier acquisition) holds it; a lock left by a dead process, or unreadable, is taken over. While held, a
   * heartbeat keeps the lock fresh for runs in other containers. Returns an idempotent release function.
   */
  acquireLock(): () => void {
    ensureDir(this.home);
    const lockFile = this.lockFile();
    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
      const content = newLockContent();
      if (createExclusive(lockFile, content)) return holdLock(lockFile, content);
      const existing = readLockFile(lockFile);
      if (existing === undefined) continue; // vanished in between: retry
      const holder = parseLockHolder(existing);
      if (holder !== undefined && isLiveHolder(holder, lockFile)) {
        throw new Error(`another mc run is active (${describeHolder(holder)})`);
      }
      removeStaleLock(lockFile, existing);
    }
    throw new Error(`could not acquire ${lockFile}: it keeps changing (another mc run starting?)`);
  }

  /**
   * The `mc run` holding the lock right now, described like the refusal of acquireLock ("pid 7", "pid 7 on host
   * 3f2a…"), or undefined when none does. Only reads: commands that must not disturb a run (or say whether one is
   * on) use it. A run in another container counts while its heartbeat is fresh.
   */
  activeRun(): string | undefined {
    const lockFile = this.lockFile();
    const existing = readLockFile(lockFile);
    const holder = existing === undefined ? undefined : parseLockHolder(existing);
    return holder !== undefined && isLiveHolder(holder, lockFile) ? describeHolder(holder) : undefined;
  }

  // ───────────── Paths and helpers ─────────────

  private missionsRoot(): string {
    return join(this.home, "missions");
  }

  private missionFile(id: string): string {
    return join(this.missionDir(id), "mission.json");
  }

  private eventsFile(id: string): string {
    return join(this.missionDir(id), "events.jsonl");
  }

  private usageFile(): string {
    return join(this.home, "usage.jsonl");
  }

  private stopFile(): string {
    return join(this.home, "STOP");
  }

  private lockFile(): string {
    return join(this.home, "mc.lock");
  }

  /** Atomically claims the first free id among base, base-2, base-3… by creating its directory. */
  private reserveMissionId(base: string): string {
    ensureDir(this.missionsRoot());
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      try {
        mkdirSync(this.missionDir(id));
        return id;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }

  private missionDirNames(): string[] {
    try {
      return readdirSync(this.missionsRoot(), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
}

/** Rejects ids that would escape the missions directory when used as a path segment. */
function assertSafeId(id: string): string {
  if (id === "" || id === "." || id === ".." || /[/\\\0]/.test(id)) throw new Error(`invalid mission id "${id}"`);
  return id;
}

const MISSION_FIELD_CHECKS = {
  id: isString,
  kind: isString,
  title: isString,
  request: isString,
  repoPath: isString,
  baseBranch: isString,
  integrationBranch: isString,
  profile: isString,
  roleOverrides: Array.isArray,
  status: isString,
  stage: isString,
  createdAt: (v: unknown) => isString(v) && !Number.isNaN(Date.parse(v)),
  updatedAt: isString,
  features: Array.isArray,
  baselineBroken: (v: unknown) => typeof v === "boolean",
  baselineFailures: Array.isArray,
  decisionsNeeded: Array.isArray,
  gateCRounds: isNumber,
  agentRuns: isNumber,
  notes: Array.isArray,
} satisfies Partial<Record<keyof Mission, (v: unknown) => boolean>>;

/**
 * The first required Mission field that is missing or has the wrong type, or undefined when the shape is fine.
 * Shallow on purpose: it keeps a hand-edited or outdated file from crashing code that reads those fields.
 */
function invalidMissionField(data: unknown): string | undefined {
  if (!isRecord(data)) return "object";
  return Object.entries(MISSION_FIELD_CHECKS).find(([field, check]) => !check(data[field]))?.[0];
}

const PLAN_OUTCOMES: readonly unknown[] = ["approved", "revised", "not_applied", "unfinished"];

/**
 * The plan a mission was queued with by `mc plan queue`, or undefined for a mission the team's planner writes (and for
 * a hand-damaged `plan`, which counts as none, so nothing that reads it can throw). A damaged `review` is left out.
 */
export function planOf(m: Pick<Mission, "plan">): PlanSource | undefined {
  const plan: unknown = m.plan;
  if (!isRecord(plan) || !isString(plan.sha256) || !isString(plan.at) || !isSpecShape(plan.spec)) return undefined;
  const review = plan.review;
  if (review === undefined || (isRecord(review) && PLAN_OUTCOMES.includes(review.outcome) && isStringList(review.issues))) return m.plan;
  const { review: _damaged, ...rest } = plan;
  return rest as unknown as PlanSource;
}

function isSpecShape(x: unknown): boolean {
  if (!isRecord(x) || !isString(x.appName) || !isString(x.summary) || !isString(x.uiContract) || !isStringList(x.assumptions)) return false;
  if (!Array.isArray(x.features)) return false;
  return x.features.every(
    (f) =>
      isRecord(f) &&
      isString(f.id) &&
      isString(f.title) &&
      isString(f.story) &&
      isStringList(f.acceptance) &&
      (f.kind === "standard" || f.kind === "mechanical") &&
      isStringList(f.deps),
  );
}

function isStringList(x: unknown): boolean {
  return Array.isArray(x) && x.every(isString);
}

function isEventLike(x: unknown): x is MissionEvent {
  return isRecord(x) && isString(x.at) && isString(x.type) && isRecord(x.data);
}

function isUsageLike(x: unknown): x is UsageRecord {
  return isRecord(x) && isString(x.at) && isRecord(x.usage);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isNumber(x: unknown): x is number {
  return typeof x === "number";
}

/** YYYY-MM-DD in the process local time zone. */
function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isoTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) throw new RangeError(`invalid timestamp: ${ms}`);
  return date.toISOString();
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ───────────── Lock file primitives ─────────────

/**
 * Creates `file` with `content` only if it does not exist. The content is written to a temp file first and
 * hard-linked into place, so other processes never observe a half-written lock.
 */
function createExclusive(file: string, content: string): boolean {
  const tmp = uniqueSibling(file, "tmp");
  writeFileSync(tmp, content);
  try {
    linkSync(tmp, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function readLockFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function newLockContent(): string {
  const start = processStart(process.pid);
  const content: LockContent = { pid: process.pid, at: new Date().toISOString(), host: hostname(), ...(start !== undefined && { start }) };
  return JSON.stringify(content);
}

/**
 * When process `pid` started: the boot it started in and its start time in clock ticks since that boot (field 22
 * of /proc/<pid>/stat). Two processes that ever had the same pid differ in it. Undefined without /proc (not Linux)
 * or when the process is gone.
 */
function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // "pid (comm) state ppid …": comm may contain spaces and parentheses, so count fields after its last ")".
    const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (startTicks === undefined || !/^\d+$/.test(startTicks)) return undefined;
    return `${bootId() ?? "boot"}:${startTicks}`;
  } catch {
    return undefined;
  }
}

function bootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The holder recorded in a lock file, or undefined when the file is corrupt (treated as stale). */
function parseLockHolder(text: string): LockHolder | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  const { pid, host, start } = data;
  // pid 0 and negative pids address process groups in kill(2), so they never identify a holder.
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, host: isString(host) ? host : undefined, start: isString(start) ? start : undefined };
}

function isForeign(holder: LockHolder): boolean {
  return holder.host !== undefined && holder.host !== hostname();
}

function describeHolder(holder: LockHolder): string {
  return isForeign(holder) ? `pid ${holder.pid} on host ${holder.host}` : `pid ${holder.pid}`;
}

/**
 * A holder on another host (another container) is judged by its heartbeat, since its pid means nothing here.
 * Our own pid only counts as a holder while this process really holds the lock: a lock file carrying our pid
 * but not held here was left by a crashed run whose pid got reused (common in containers). Another live process
 * with the holder's pid is the holder only if it started when the holder did (when both start times are known).
 */
function isLiveHolder(holder: LockHolder, lockFile: string): boolean {
  if (isForeign(holder)) return msSinceModified(lockFile) < FOREIGN_LOCK_TTL_MS;
  if (holder.pid === process.pid) return locksHeldByThisProcess.has(lockFile);
  if (!isProcessAlive(holder.pid)) return false;
  const now = holder.start === undefined ? undefined : processStart(holder.pid);
  return now === undefined || now === holder.start;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Milliseconds since `file` was last modified; 0 when it is gone (it was just replaced or released). */
function msSinceModified(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

/**
 * Deletes the lock if it still holds `staleContent`. Reading and deleting are two steps, so contenders
 * serialize them with a guard file named after the stale content: only one deletes a given stale lock, and as
 * every lock's content is unique, a fresh lock that replaced it never matches.
 */
function removeStaleLock(lockFile: string, staleContent: string): void {
  const guard = claimTakeoverGuard(lockFile, staleContent);
  if (guard === undefined) return; // another contender is removing it: the caller retries
  try {
    if (readLockFile(lockFile) === staleContent) rmSync(lockFile, { force: true });
  } finally {
    rmSync(guard, { force: true });
  }
}

/**
 * Creates the takeover guard for `staleContent` and returns its path, or undefined while another contender
 * holds it. A guard abandoned by a crashed contender is never deleted, since that could delete a live successor;
 * contenders compete for a successor guard named after it instead.
 */
function claimTakeoverGuard(lockFile: string, staleContent: string): string | undefined {
  for (let key = staleContent; ; ) {
    const guard = `${lockFile}.${sha256(key).slice(0, 16)}.takeover`;
    if (createExclusive(guard, newLockContent())) return guard;
    const holder = readLockFile(guard);
    // Read before stat: if the guard was replaced in between, the stat sees the fresh one and we back off.
    if (holder === undefined || msSinceModified(guard) < TAKEOVER_GUARD_TTL_MS) return undefined;
    key += `\n${holder}`;
  }
}

/** Marks the lock held and starts its heartbeat; returns the release function. */
function holdLock(lockFile: string, content: string): () => void {
  locksHeldByThisProcess.add(lockFile);
  const heartbeat = setInterval(() => touchIfOurs(lockFile, content), LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    locksHeldByThisProcess.delete(lockFile);
    if (readLockFile(lockFile) === content) rmSync(lockFile, { force: true });
  };
}

/** Heartbeat: refreshes the lock's mtime, unless the lock is no longer ours. */
function touchIfOurs(lockFile: string, content: string): void {
  try {
    if (readLockFile(lockFile) !== content) return;
    const now = new Date();
    utimesSync(lockFile, now, now);
  } catch {
    // Best effort, and a timer callback must not throw: the next beat tries again.
  }
}

function uniqueSibling(file: string, suffix: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString("hex")}.${suffix}`;
}
