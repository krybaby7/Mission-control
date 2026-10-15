// Quota governor: what each provider may start right now (usage limits, throttling, model-specific limits,
// pacing by reported utilization, failed logins, a CLI that keeps failing) and when a blocked provider or model frees up.
// Limits are saved to statePath so a restart remembers them.
import { existsSync } from "node:fs";
import type { Clock, Config, LimitInfo, LimitKind, Logger, Provider, Utilization } from "./types.js";
import { readJson, writeJsonAtomic } from "./util/fs.js";
import { nullLogger } from "./util/logger.js";

export type ProviderState =
  | { status: "ok" }
  | { status: "limited"; kind: LimitKind; until: number; raw: string }
  /** Its CLI failed for a reason outside the job (it crashed or hung); tried again from `until`. */
  | { status: "failing"; until: number; raw: string }
  | { status: "auth"; raw: string };

export interface QuotaSnapshot {
  providers: Record<string, ProviderState>;
  /** "<provider>:<model substring>" → epoch ms when that model's block ends. */
  modelBlocks: Record<string, number>;
  /** The latest reading per provider and window. */
  utilization: Utilization[];
}

export interface QuotaGovernorOptions {
  clock: Clock;
  config: Config;
  /** JSON file the limits are saved to and restored from. Without it, state lives in memory only. */
  statePath?: string;
  logger?: Logger;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const THROTTLE_BASE_MS = MINUTE_MS;
const THROTTLE_MAX_MS = 15 * MINUTE_MS;
/** A failed login blocks the provider this long; then one run may check it again, since a 401 can be transient. */
const AUTH_RECHECK_MS = 30 * MINUTE_MS;
/** A CLI that crashed or hung is tried again after 60 s, 120 s, 240 s… (capped), until a run succeeds. */
const FAILURE_BASE_MS = MINUTE_MS;
const FAILURE_MAX_MS = 15 * MINUTE_MS;

/**
 * How far ahead a reported reset may lie: usage windows last at most a week, a spend cap a month. A later time was
 * misread (a past date rolled into next year, seconds taken for ms) and counts as not given.
 */
const MAX_RESET_AHEAD_MS = 8 * DAY_MS;
const MAX_SPEND_RESET_AHEAD_MS = 32 * DAY_MS;

/** How long a limit lasts when the provider did not say when it resets. */
const DEFAULT_DURATION_MS: Record<Exclude<LimitKind, "throttle">, number> = {
  session: HOUR_MS,
  weekly: 6 * HOUR_MS,
  model: 6 * HOUR_MS,
  spend: 12 * HOUR_MS,
  unknown: 30 * MINUTE_MS,
};

/** Usage windows that pace new work: the setting that caps each, and the limit kind a pacing block reports. */
const PACED_WINDOWS = [
  { window: "five_hour", setting: "maxFiveHourUtilization", kind: "session" },
  { window: "seven_day", setting: "maxWeeklyUtilization", kind: "weekly" },
] as const satisfies readonly { window: string; setting: keyof Config["pacing"]; kind: LimitKind }[];

/** The usage window a run's share of the week is measured in. */
const WEEKLY_WINDOW = "seven_day";
/** Readings are fractions such as 0.65 - 0.3; this keeps a share exactly at the cap from slipping under it. */
const SHARE_EPSILON = 1e-9;

const PROVIDERS: readonly Provider[] = ["claude", "codex", "mock"];
const LIMIT_KINDS: readonly LimitKind[] = ["session", "weekly", "model", "spend", "throttle", "unknown"];
const STATE_VERSION = 1;

/** When a block ends. */
interface Timed {
  until: number;
  /** Set when the provider gave no reset time, so `until` is a default guess. */
  estimated?: true;
}

interface Block extends Timed {
  kind: LimitKind;
  raw: string;
}

interface ModelBlock extends Timed {
  provider: Provider;
  /** Lowercased; blocks every model id of the provider that contains it ("opus" → claude-opus-5-5). */
  model: string;
  raw: string;
}

interface AuthBlock {
  raw: string;
  /** When a run may check the login again. */
  until: number;
}

interface FailureBlock {
  raw: string;
  /** When a run may try the provider again. */
  until: number;
}

/**
 * The statePath file. Login and CLI failures are deliberately not saved: a restart usually follows a fresh login
 * or a fix.
 */
interface PersistedState {
  version: number;
  limits: Partial<Record<Provider, Block>>;
  modelBlocks: ModelBlock[];
  utilization: Utilization[];
}

export class QuotaGovernor {
  private readonly clock: Clock;
  private readonly config: Config;
  private readonly statePath: string | undefined;
  private readonly logger: Logger;
  private readonly limits = new Map<Provider, Block>();
  private readonly modelBlocks = new Map<string, ModelBlock>();
  /** Latest reading per "<provider>:<window>". */
  private readonly utilization = new Map<string, Utilization>();
  /**
   * Per provider, the 7-day utilization when this governor (one run) first read it, lowered when the window
   * resets or old usage rolls out of it: this run's share of the week counts from here. Memory only, so every
   * run starts afresh.
   */
  private readonly nightStart = new Map<Provider, number>();
  private readonly auth = new Map<Provider, AuthBlock>();
  /** Consecutive throttles per provider since its last success; drives the exponential backoff. */
  private readonly throttleStreak = new Map<Provider, number>();
  private readonly failures = new Map<Provider, FailureBlock>();
  /** Consecutive CLI failures per provider since its last success, and the last one's text; drives their backoff. */
  private readonly failureStreaks = new Map<Provider, { count: number; raw: string }>();

  constructor(opts: QuotaGovernorOptions) {
    this.clock = opts.clock;
    this.config = opts.config;
    this.statePath = opts.statePath;
    this.logger = opts.logger ?? nullLogger;
    if (this.statePath !== undefined) this.restore(this.statePath);
  }

  recordLimit(info: LimitInfo): void {
    const now = this.prune();
    if (info.kind === "model" && info.model) this.blockModel(info, info.model, now);
    else this.limitProvider(info, now);
    this.save();
  }

  recordAuthFailure(provider: Provider, raw: string): void {
    const until = this.clock.now() + AUTH_RECHECK_MS;
    this.auth.set(provider, { raw, until });
    this.logger.warn(`${provider} needs a new login (checking again at ${iso(until)}): ${raw}`, { provider });
  }

  clearAuth(provider: Provider): void {
    if (this.auth.delete(provider)) this.logger.info(`${provider} login marked as working again`, { provider });
  }

  /**
   * The provider's CLI failed for a reason that says nothing about the job: it crashed, could not start, or hung
   * without output. New work waits 60 s, then 120 s, 240 s… (capped at 15 min) until a run on it succeeds, so other
   * providers take over when they may. Kept in memory only.
   */
  recordFailure(provider: Provider, raw: string): void {
    const now = this.prune();
    const streak = (this.failureStreaks.get(provider)?.count ?? 0) + 1;
    this.failureStreaks.set(provider, { count: streak, raw });
    const until = now + Math.min(FAILURE_BASE_MS * 2 ** (streak - 1), FAILURE_MAX_MS);
    this.failures.set(provider, { raw, until });
    this.logger.warn(`${provider} failed for a reason outside the job (trying it again at ${iso(until)}): ${raw}`, { provider, streak });
  }

  recordUtilization(u: Utilization): void {
    const now = this.prune();
    const key = windowKey(u.provider, u.window);
    const previous = this.utilization.get(key);
    // A reading without a reset time belongs to the same window as the previous one, so it shares its reset.
    const resetsAt = futureTime(u.resetsAt, now, MAX_RESET_AHEAD_MS) ?? previous?.resetsAt;
    const reading: Utilization = { provider: u.provider, window: u.window, utilization: u.utilization };
    if (resetsAt !== undefined) reading.resetsAt = resetsAt;
    const sharedBefore = this.nightShareBlock(u.provider);
    if (u.window === WEEKLY_WINDOW) this.noteNightStart(u.provider, u.utilization);
    if (previous && sameReading(previous, reading)) return;
    this.utilization.set(key, reading);
    const pacing = this.pacingBlock(reading);
    const newlyPaced = pacing && !(previous && this.pacingBlock(previous)) ? pacing : undefined;
    const started = newlyPaced ?? (sharedBefore ? undefined : this.nightShareBlock(u.provider));
    if (started) {
      this.logger.info(`pausing new work on ${u.provider} until ${iso(started.until)} (${started.raw})`, {
        provider: u.provider,
        window: u.window,
        utilization: u.utilization,
      });
    }
    this.save();
  }

  /**
   * The provider's CLI failures since its last successful run (see recordFailure), with the last one's text; undefined
   * when it has not failed since. Unlike state(), this outlasts the current backoff.
   */
  failureStreak(provider: Provider): { count: number; raw: string } | undefined {
    const streak = this.failureStreaks.get(provider);
    return streak && { ...streak };
  }

  /** A success ends the provider's throttle and failure streaks, so the next backoff starts from the base delay again. */
  recordSuccess(provider: Provider): void {
    this.throttleStreak.delete(provider);
    this.failureStreaks.delete(provider);
    this.failures.delete(provider);
  }

  /** Whether new work may start on the provider (and, when given, this model of it). */
  isAvailable(provider: Provider, model?: string): boolean {
    const now = this.prune();
    const at = this.freeAt(provider, model);
    return at !== null && at <= now;
  }

  /** now when available; the epoch ms when every block ends; null while the provider needs a human login. */
  availableAt(provider: Provider, model?: string): number | null {
    const now = this.prune();
    const at = this.freeAt(provider, model);
    return at === null ? null : Math.max(now, at);
  }

  /** Provider-wide state; model blocks are reported by snapshot() only. Of a limit and a failure, the later end wins. */
  state(provider: Provider): ProviderState {
    this.prune();
    const auth = this.auth.get(provider);
    if (auth) return { status: "auth", raw: auth.raw };
    const block = longest(this.providerBlocks(provider));
    const failure = this.failures.get(provider);
    if (failure && !(block && block.until > failure.until)) return { status: "failing", until: failure.until, raw: failure.raw };
    return block ? { status: "limited", kind: block.kind, until: block.until, raw: block.raw } : { status: "ok" };
  }

  snapshot(): QuotaSnapshot {
    this.prune();
    const providers: Record<string, ProviderState> = {};
    for (const provider of this.knownProviders()) providers[provider] = this.state(provider);
    const modelBlocks: Record<string, number> = {};
    for (const [key, block] of this.modelBlocks) modelBlocks[key] = block.until;
    const utilization = [...this.utilization.values()].map((u) => ({ ...u }));
    return { providers, modelBlocks, utilization };
  }

  // ───────────── Recording ─────────────

  private limitProvider(info: LimitInfo, now: number): void {
    const end = info.kind === "throttle" ? { until: this.throttleUntil(info, now) } : this.limitEnd(info, info.kind, now);
    const block: Block = { kind: info.kind, raw: info.raw, ...end };
    const current = this.limits.get(info.provider);
    if (current && !replaces(block, current, block.kind === current.kind)) return;
    this.limits.set(info.provider, block);
    this.logger.info(`${info.provider} limited (${info.kind}) until ${iso(block.until)}${block.estimated ? " (estimated)" : ""}`, {
      provider: info.provider,
      kind: info.kind,
      until: block.until,
      raw: info.raw,
    });
  }

  private throttleUntil(info: LimitInfo, now: number): number {
    const streak = (this.throttleStreak.get(info.provider) ?? 0) + 1;
    this.throttleStreak.set(info.provider, streak);
    const backoff = Math.min(THROTTLE_BASE_MS * 2 ** (streak - 1), THROTTLE_MAX_MS);
    return Math.max(now + backoff, this.reportedReset(info, "throttle", now) ?? 0);
  }

  /** The reported reset when there is a plausible one, else the kind's default duration (an estimate). */
  private limitEnd(info: LimitInfo, kind: Exclude<LimitKind, "throttle">, now: number): Timed {
    const resetsAt = this.reportedReset(info, kind, now);
    return resetsAt !== undefined ? { until: resetsAt } : { until: now + DEFAULT_DURATION_MS[kind], estimated: true };
  }

  private reportedReset(info: LimitInfo, kind: LimitKind, now: number): number | undefined {
    const resetsAt = futureTime(info.resetsAt, now, Infinity);
    if (resetsAt === undefined || resetsAt - now <= maxResetAhead(kind)) return resetsAt;
    const days = Math.round((resetsAt - now) / DAY_MS);
    this.logger.warn(`ignoring the reset time of a ${info.provider} ${kind} limit: ${days} days ahead is implausible`, {
      provider: info.provider,
      resetsAt,
    });
    return undefined;
  }

  private blockModel(info: LimitInfo, model: string, now: number): void {
    const block: ModelBlock = { provider: info.provider, model: model.toLowerCase(), raw: info.raw, ...this.limitEnd(info, "model", now) };
    const key = modelKey(block.provider, block.model);
    const current = this.modelBlocks.get(key);
    if (current && !replaces(block, current, true)) return;
    this.modelBlocks.set(key, block);
    this.logger.info(`${block.provider} model "${block.model}" limited until ${iso(block.until)}`, {
      provider: block.provider,
      model: block.model,
      until: block.until,
      raw: block.raw,
    });
  }

  // ───────────── Queries ─────────────

  /** The time every block on provider (and model) has ended, or null while it needs a login. */
  private freeAt(provider: Provider, model: string | undefined): number | null {
    if (this.auth.has(provider)) return null;
    const blocks = [...this.providerBlocks(provider), ...this.modelBlocksFor(provider, model)];
    return Math.max(longest(blocks)?.until ?? 0, this.failures.get(provider)?.until ?? 0);
  }

  private providerBlocks(provider: Provider): Block[] {
    const blocks: Block[] = [];
    const limit = this.limits.get(provider);
    if (limit) blocks.push(limit);
    for (const { window } of PACED_WINDOWS) {
      const reading = this.utilization.get(windowKey(provider, window));
      const pacing = reading && this.pacingBlock(reading);
      if (pacing) blocks.push(pacing);
    }
    const share = this.nightShareBlock(provider);
    if (share) blocks.push(share);
    return blocks;
  }

  private modelBlocksFor(provider: Provider, model: string | undefined): Block[] {
    if (model === undefined) return [];
    const id = model.toLowerCase();
    return [...this.modelBlocks.values()]
      .filter((b) => b.provider === provider && id.includes(b.model))
      .map((b) => ({ kind: "model", until: b.until, raw: b.raw }));
  }

  private noteNightStart(provider: Provider, utilization: number): void {
    const start = this.nightStart.get(provider);
    if (start === undefined || utilization < start) this.nightStart.set(provider, utilization);
  }

  /** Blocks the provider until its weekly reset once this run has used the configured share of its week. */
  private nightShareBlock(provider: Provider): Block | undefined {
    const cap = this.config.pacing.maxWeeklySharePerNight;
    const start = this.nightStart.get(provider);
    const latest = this.utilization.get(windowKey(provider, WEEKLY_WINDOW));
    if (cap === undefined || start === undefined || latest?.resetsAt === undefined) return undefined;
    const used = latest.utilization - start;
    if (used + SHARE_EPSILON < cap) return undefined;
    return {
      kind: "weekly",
      until: latest.resetsAt,
      raw: `pacing: this run's work used ${percent(used)} of the weekly limit, the most one run may use (${percent(cap)})`,
    };
  }

  private pacingBlock(reading: Utilization): Block | undefined {
    const rule = PACED_WINDOWS.find((r) => r.window === reading.window);
    if (!rule || reading.resetsAt === undefined) return undefined; // without a reset time there is nothing to wait for
    const cap = this.config.pacing[rule.setting];
    if (reading.utilization < cap) return undefined;
    return {
      kind: rule.kind,
      until: reading.resetsAt,
      raw: `pacing: ${reading.window} utilization ${percent(reading.utilization)} is at or above the ${percent(cap)} cap`,
    };
  }

  private knownProviders(): Set<Provider> {
    const { families, light } = this.config;
    return new Set<Provider>([
      families.claude.provider,
      families.codex.provider,
      light.provider,
      ...this.limits.keys(),
      ...this.auth.keys(),
      ...this.failures.keys(),
      ...[...this.modelBlocks.values()].map((b) => b.provider),
      ...[...this.utilization.values()].map((u) => u.provider),
    ]);
  }

  /** Drops limits, model blocks and readings whose time has passed; returns now. */
  private prune(): number {
    const now = this.clock.now();
    for (const [provider, block] of this.limits) if (block.until <= now) this.limits.delete(provider);
    for (const [key, block] of this.modelBlocks) if (block.until <= now) this.modelBlocks.delete(key);
    for (const [provider, block] of this.auth) if (block.until <= now) this.auth.delete(provider);
    for (const [provider, block] of this.failures) if (block.until <= now) this.failures.delete(provider);
    for (const [key, reading] of this.utilization) {
      if (reading.resetsAt !== undefined && reading.resetsAt <= now) this.utilization.delete(key);
    }
    return now;
  }

  // ───────────── Persistence ─────────────

  private save(): void {
    if (this.statePath === undefined) return;
    const state: PersistedState = {
      version: STATE_VERSION,
      limits: Object.fromEntries(this.limits),
      modelBlocks: [...this.modelBlocks.values()],
      // A reading without a reset time can never expire, so it is not carried over to a later run.
      utilization: [...this.utilization.values()].filter((u) => u.resetsAt !== undefined),
    };
    try {
      writeJsonAtomic(this.statePath, state);
    } catch (err) {
      this.logger.warn(`could not save quota state to ${this.statePath}: ${errorMessage(err)}`);
    }
  }

  /**
   * Loads a previous run's state; whatever has expired since is pruned on first use. An unreadable file (with a
   * warning), a malformed entry, or one ending implausibly far ahead is ignored.
   */
  private restore(path: string): void {
    if (!existsSync(path)) return;
    let data: unknown;
    try {
      data = readJson<unknown>(path);
    } catch (err) {
      this.logger.warn(`ignoring unreadable quota state ${path}: ${errorMessage(err)}`);
      return;
    }
    const state = isRecord(data) ? data : {};
    const now = this.clock.now();
    const plausible = (until: number, maxAhead: number) => until - now <= maxAhead;
    for (const [provider, block] of Object.entries(isRecord(state.limits) ? state.limits : {})) {
      if (!isProvider(provider) || !isBlock(block) || !plausible(block.until, maxResetAhead(block.kind))) continue;
      this.limits.set(provider, { kind: block.kind, until: block.until, raw: block.raw, ...(block.estimated && { estimated: true }) });
    }
    for (const { provider, model, until, raw, estimated } of arrayOf(state.modelBlocks, isModelBlock)) {
      if (!plausible(until, MAX_RESET_AHEAD_MS)) continue;
      const id = model.toLowerCase();
      this.modelBlocks.set(modelKey(provider, id), { provider, model: id, until, raw, ...(estimated && { estimated: true }) });
    }
    for (const { provider, window, utilization, resetsAt } of arrayOf(state.utilization, isUtilization)) {
      if (resetsAt !== undefined && plausible(resetsAt, MAX_RESET_AHEAD_MS)) {
        this.utilization.set(windowKey(provider, window), { provider, window, utilization, resetsAt });
      }
    }
  }
}

// ───────────── Helpers ─────────────

function windowKey(provider: Provider, window: string): string {
  return `${provider}:${window}`;
}

function modelKey(provider: Provider, model: string): string {
  return `${provider}:${model}`;
}

/**
 * t when it is a valid time after now and at most maxAhead later. A reset time already in the past says nothing
 * about the next reset.
 */
function futureTime(t: number | undefined, now: number, maxAhead: number): number | undefined {
  return t !== undefined && Number.isFinite(t) && t > now && t - now <= maxAhead ? t : undefined;
}

function maxResetAhead(kind: LimitKind): number {
  return kind === "spend" ? MAX_SPEND_RESET_AHEAD_MS : MAX_RESET_AHEAD_MS;
}

/**
 * Whether a new block replaces the current one. For the same limit, a reported reset beats an estimated one,
 * earlier or not, and is never replaced by one; otherwise the later end wins.
 */
function replaces(next: Timed, current: Timed, sameLimit: boolean): boolean {
  if (sameLimit && Boolean(next.estimated) !== Boolean(current.estimated)) return !next.estimated;
  return next.until > current.until;
}

function longest(blocks: Block[]): Block | undefined {
  let best: Block | undefined;
  for (const b of blocks) if (!best || b.until > best.until) best = b;
  return best;
}

function sameReading(a: Utilization, b: Utilization): boolean {
  return a.utilization === b.utilization && a.resetsAt === b.resetsAt;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function arrayOf<T>(x: unknown, guard: (item: unknown) => item is T): T[] {
  return Array.isArray(x) ? x.filter(guard) : [];
}

function isProvider(x: unknown): x is Provider {
  return PROVIDERS.includes(x as Provider);
}

function isTime(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isTimed(x: Record<string, unknown>): boolean {
  return isTime(x.until) && (x.estimated === undefined || x.estimated === true);
}

function isBlock(x: unknown): x is Block {
  return isRecord(x) && LIMIT_KINDS.includes(x.kind as LimitKind) && isTimed(x) && typeof x.raw === "string";
}

function isModelBlock(x: unknown): x is ModelBlock {
  return isRecord(x) && isProvider(x.provider) && typeof x.model === "string" && x.model !== "" && isTimed(x) && typeof x.raw === "string";
}

function isUtilization(x: unknown): x is Utilization {
  return (
    isRecord(x) &&
    isProvider(x.provider) &&
    typeof x.window === "string" &&
    isTime(x.utilization) &&
    (x.resetsAt === undefined || isTime(x.resetsAt))
  );
}
