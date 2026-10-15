// Role executor: turns a role request into one agent run. It picks the first provider/model the quota allows
// (failing over to the other family when permitted), waits out limits when nothing is available, runs the agent,
// and records usage, mission events and the quota signals the run reports. A run that ended for reasons outside the
// job (a crashed or hung CLI, limits that never clear) is retried, never handed back as the job's answer.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { otherFamily, resolveModel } from "./config.js";
import type { QuotaGovernor } from "./quota.js";
import type { MissionStore } from "./state.js";
import type {
  Access,
  AgentJob,
  AgentRunner,
  Clock,
  Config,
  Effort,
  Family,
  JsonSchema,
  LimitInfo,
  Logger,
  Provider,
  Role,
  RunEvent,
  RunResult,
  Tier,
} from "./types.js";

/** Extra time after a limit's reset before trying again, so the provider has really let go. */
const WAIT_MARGIN_MS = 45_000;
/** Long waits wake at least this often to notice a stop request. */
const MAX_SLEEP_SLICE_MS = 60_000;
/** A job whose runs keep hitting limits gives up after this many, so a misread failure cannot rerun forever. */
const MAX_LIMITED_RUNS = 8;
/**
 * A job whose runs keep failing for reasons outside it (crashed, hung) gives up once this long has passed since the
 * first such failure ended, or after MAX_FAILED_RUNS of them. The quota backs off 1, 2, 4… min between tries, so a
 * short outage passes unnoticed and a broken CLI stops the work within about half an hour.
 */
const FAILURE_PATIENCE_MS = 30 * 60_000;
const MAX_FAILED_RUNS = 16;
const FAMILIES: readonly Family[] = ["claude", "codex"];

/** Every candidate provider for a run needs a human to log in again. */
export class AuthUnavailableError extends Error {
  constructor(
    message = "every candidate provider needs a new login",
    readonly providers: Provider[] = [],
  ) {
    super(message);
    this.name = "AuthUnavailableError";
  }
}

/**
 * The agent CLIs keep failing for reasons that have nothing to do with the job: a CLI crashes or cannot start, hangs
 * without output, or the provider keeps refusing (limits or overload that never clear). Nothing an agent did caused
 * it, so the work must pause, not count as a failed attempt. `detail` is the last error, for the person who fixes it.
 */
export class ProvidersFailingError extends Error {
  constructor(
    message: string,
    readonly providers: Provider[] = [],
    readonly detail = "",
  ) {
    super(message);
    this.name = "ProvidersFailingError";
  }
}

/** The next possible run (at `until`) would start after the deadline. */
export class DeadlineError extends Error {
  constructor(
    public readonly until: number,
    message = `no provider is free before the deadline (next chance ${new Date(until).toISOString()})`,
  ) {
    super(message);
    this.name = "DeadlineError";
  }
}

/** A stop was requested (STOP file, signal) before or while the executor was waiting or running. */
export class StopRequestedError extends Error {
  constructor(message = "stop requested") {
    super(message);
    this.name = "StopRequestedError";
  }
}

export interface ExecRequest {
  missionId: string;
  role: Role;
  /** Names the job and its log file: "<label>-<n>". */
  label: string;
  family: Family;
  tier: Tier;
  effort: Effort;
  /** Honored only if config.failover.enabled. */
  allowFailover: boolean;
  /** If no candidate is available right now, return {skipped:true} instead of waiting. */
  optional?: boolean;
  cwd: string;
  systemPrompt: string;
  prompt: string;
  outputSchema?: JsonSchema;
  access: Access;
  noTools?: boolean;
  maxTurns: number;
  timeoutMs?: number;
}

export interface ExecResult {
  skipped: boolean;
  result: RunResult | null;
  provider: Provider | null;
  model: string | null;
  /** The family that actually ran the job (light-tier jobs run on the light model's family). */
  family: Family | null;
}

export interface RoleExecutorDeps {
  config: Config;
  runners: Partial<Record<Provider, AgentRunner>>;
  quota: QuotaGovernor;
  clock: Clock;
  store: MissionStore;
  /** Agent progress goes to debug when the logger has it (createLogger's loggers do). */
  logger: Logger & { debug?: (msg: string, data?: Record<string, unknown>) => void };
  signal?: AbortSignal;
  /** Epoch ms; no run starts after it, and waiting for a limit to reset past it throws DeadlineError. */
  deadline?: number;
  /** `cause` says whether the wait is for usage limits or for providers that fail or are overloaded right now. */
  onWaiting?: (until: number, reason: string, cause: WaitCause) => void;
  stopCheck?: () => boolean;
}

/** "limits": usage limits or pacing. "trouble": the providers waited for are overloaded, unreachable or failing. */
export type WaitCause = "limits" | "trouble";

interface Candidate {
  family: Family;
  tier: Tier;
  provider: Provider;
  model: string;
}

type Runnable = Candidate & { runner: AgentRunner };

const SKIPPED: ExecResult = { skipped: true, result: null, provider: null, model: null, family: null };

export class RoleExecutor {
  /** Last job number used per mission and label, so job ids (and log files) stay unique. */
  private readonly jobNumbers = new Map<string, number>();

  constructor(private readonly deps: RoleExecutorDeps) {}

  async exec(req: ExecRequest): Promise<ExecResult> {
    const candidates = this.runnable(this.candidates(req));
    if (candidates.length === 0) {
      if (req.optional) return SKIPPED;
      throw new Error(`no runner is configured for any model that can run "${req.label}"`);
    }
    let limitedRuns = 0;
    const failed = { runs: 0, since: 0 };
    for (;;) {
      this.checkStop();
      this.checkDeadline();
      const pick = candidates.find((c) => this.deps.quota.isAvailable(c.provider, c.model));
      if (!pick) {
        if (req.optional) return SKIPPED;
        await this.waitForCandidate(candidates);
        continue;
      }
      const { result, progressed } = await this.run(req, pick);
      const done: ExecResult = { skipped: false, result, provider: pick.provider, model: pick.model, family: pick.family };
      if (result.outcome === "auth") continue; // that login is blocked now: another model, or AuthUnavailableError
      if (result.outcome === "aborted") throw new StopRequestedError();
      if (result.outcome === "limited") {
        if (++limitedRuns < MAX_LIMITED_RUNS) continue; // another model, or after the reset
        this.deps.logger.warn(`giving up on ${req.label} after ${limitedRuns} runs that hit usage limits`, { label: req.label });
        if (req.optional) return done;
        throw new ProvidersFailingError(
          `${providersOf(candidates)} kept refusing work (usage limits or overload, ${limitedRuns} runs in a row): ${runError(result)}`,
          providerList(candidates),
          runError(result),
        );
      }
      if (isOutsideFailure(result, progressed)) {
        if (req.optional) return done; // optional work just goes without; it must not hold up the required work
        this.deps.quota.recordFailure(pick.provider, runError(result));
        if (failed.runs++ === 0) failed.since = this.deps.clock.now();
        if (failed.runs < MAX_FAILED_RUNS && this.deps.clock.now() - failed.since < FAILURE_PATIENCE_MS) continue;
        this.deps.logger.warn(`giving up on ${req.label} after ${failed.runs} runs that failed for reasons outside the job`, { label: req.label });
        const providers = providerList(candidates);
        throw new ProvidersFailingError(`${providers.join(" and ")} keep${providers.length === 1 ? "s" : ""} failing: ${runError(result)}`, providers, runError(result));
      }
      if (result.outcome === "ok") this.deps.quota.recordSuccess(pick.provider);
      return done;
    }
  }

  // ───────────── Candidates ─────────────

  private runnable(candidates: Candidate[]): Runnable[] {
    return candidates.flatMap((c) => {
      const runner = this.deps.runners[c.provider];
      return runner ? [{ ...c, runner }] : [];
    });
  }

  /** The models to try, in order: the requested family first, then the fallbacks the request allows. */
  private candidates(req: ExecRequest): Candidate[] {
    const failover = req.allowFailover && this.deps.config.failover.enabled;
    const other = otherFamily(req.family);
    const slots: { family: Family; tier: Tier }[] = [{ family: req.family, tier: req.tier }];
    if (req.tier === "light") {
      if (!req.optional) slots.push({ family: req.family, tier: "standard" });
      if (!req.optional && failover) slots.push({ family: other, tier: "standard" });
    } else if (failover) {
      slots.push({ family: other, tier: req.tier });
    }
    const unique = new Map<string, Candidate>();
    for (const slot of slots) {
      const candidate = this.candidate(slot.family, slot.tier);
      const key = `${candidate.provider}/${candidate.model}`;
      if (!unique.has(key)) unique.set(key, candidate);
    }
    return [...unique.values()];
  }

  private candidate(family: Family, tier: Tier): Candidate {
    const { provider, model } = resolveModel(this.deps.config, family, tier);
    return { family: tier === "light" ? this.lightFamily(family) : family, tier, provider, model };
  }

  /** The family whose provider runs the light model; the requested one when that is ambiguous (e.g. all "mock"). */
  private lightFamily(requested: Family): Family {
    const { families, light } = this.deps.config;
    const matches = FAMILIES.filter((f) => families[f].provider === light.provider);
    const [only] = matches;
    return only !== undefined && matches.length === 1 ? only : requested;
  }

  // ───────────── Waiting ─────────────

  private async waitForCandidate(candidates: Candidate[]): Promise<void> {
    const { quota, deadline } = this.deps;
    const times = candidates.map((c) => quota.availableAt(c.provider, c.model));
    const known = times.filter((t): t is number => t !== null);
    if (known.length === 0) {
      const providers = [...new Set(candidates.map((c) => c.provider))];
      throw new AuthUnavailableError(`${providers.join(" and ")} need${providers.length === 1 ? "s" : ""} a new login`, providers);
    }
    const until = Math.min(...known) + WAIT_MARGIN_MS;
    if (deadline !== undefined && until > deadline) throw new DeadlineError(until);
    const reason = this.waitReason(candidates);
    this.deps.logger.info(`waiting until ${new Date(until).toISOString()}: ${reason}`, { until });
    this.deps.onWaiting?.(until, reason, this.waitCause(candidates, until - WAIT_MARGIN_MS));
    await this.sleepUntil(until);
  }

  /** Whether the candidate that frees up first (at `at`) waits for a usage limit, or for a provider in trouble. */
  private waitCause(candidates: Candidate[], at: number): WaitCause {
    const { quota } = this.deps;
    const first = candidates.find((c) => quota.availableAt(c.provider, c.model) === at);
    const state = first && quota.state(first.provider);
    if (state?.status === "failing" && state.until === at) return "trouble";
    if (state?.status === "limited" && state.until === at && state.kind === "throttle") return "trouble";
    return "limits";
  }

  /** e.g. "gpt-6-astra: session limit until …; claude-opus-5-5: claude needs a new login". */
  private waitReason(candidates: Candidate[]): string {
    const { quota } = this.deps;
    return candidates
      .map((c) => {
        const state = quota.state(c.provider);
        if (state.status === "auth") return `${c.model}: ${c.provider} needs a new login`;
        const at = quota.availableAt(c.provider, c.model) ?? 0;
        const time = new Date(at).toISOString();
        if (state.status === "failing" && state.until === at) return `${c.model}: ${c.provider} keeps failing (${firstLine(state.raw)}), trying again at ${time}`;
        const kind = state.status === "limited" && state.until === at ? state.kind : "model";
        return `${c.model}: ${kind} limit until ${time}`;
      })
      .join("; ");
  }

  private async sleepUntil(until: number): Promise<void> {
    const { clock, signal } = this.deps;
    for (let left = until - clock.now(); left > 0; left = until - clock.now()) {
      try {
        await clock.sleep(Math.min(left, MAX_SLEEP_SLICE_MS), signal);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw new StopRequestedError();
        throw err;
      }
      this.checkStop();
    }
  }

  private checkStop(): void {
    if (this.deps.signal?.aborted || this.deps.stopCheck?.()) throw new StopRequestedError();
  }

  private checkDeadline(): void {
    const { deadline, clock } = this.deps;
    const now = clock.now();
    if (deadline !== undefined && now > deadline) {
      throw new DeadlineError(now, `the deadline ${new Date(deadline).toISOString()} has passed`);
    }
  }

  // ───────────── Running ─────────────

  /** One run; `progressed` tells whether the agent showed any sign of working (a progress event). */
  private async run(req: ExecRequest, candidate: Runnable): Promise<{ result: RunResult; progressed: boolean }> {
    const { store, clock, logger, signal } = this.deps;
    const job = this.buildJob(req, candidate);
    const reported: LimitInfo[] = [];
    let progressed = false;
    const runInfo = { label: req.label, jobId: job.id, role: req.role, provider: job.provider, model: job.model };
    logger.info(`run ${job.id}: ${job.role} on ${job.provider}/${job.model} (${job.effort})`, runInfo);
    store.appendEvent(req.missionId, "run.start", { ...runInfo, effort: job.effort }, clock.now());

    const result = await candidate.runner.run(job, {
      signal,
      onEvent: (event) => {
        if (event.type === "progress") progressed = true;
        this.onRunEvent(event, job, reported);
      },
    });

    this.recordRun(req, job, result);
    if (result.outcome === "limited") this.recordRunLimit(job, result, reported);
    if (result.outcome === "auth") this.deps.quota.recordAuthFailure(job.provider, result.error || result.text || "login required");
    return { result, progressed };
  }

  private buildJob(req: ExecRequest, candidate: Candidate): AgentJob {
    const { id, logFile } = this.nextJob(req.missionId, req.label);
    const job: AgentJob = {
      id,
      role: req.role,
      provider: candidate.provider,
      model: candidate.model,
      effort: req.effort,
      cwd: req.cwd,
      systemPrompt: req.systemPrompt,
      prompt: req.prompt,
      access: req.access,
      limits: { maxTurns: req.maxTurns, timeoutMs: req.timeoutMs ?? this.deps.config.limits.agentTimeoutMs },
      logFile,
    };
    if (req.outputSchema) job.outputSchema = req.outputSchema;
    if (req.noTools) job.noTools = true;
    return job;
  }

  /** "<label>-<n>" with n past every earlier job of this executor and every log file already on disk. */
  private nextJob(missionId: string, label: string): { id: string; logFile: string } {
    const base = label.replace(/[^A-Za-z0-9._-]+/g, "-") || "run";
    const dir = this.deps.store.logsDir(missionId);
    const key = `${missionId}/${base}`;
    let n = (this.jobNumbers.get(key) ?? 0) + 1;
    while (existsSync(join(dir, `${base}-${n}.ndjson`))) n++;
    this.jobNumbers.set(key, n);
    return { id: `${base}-${n}`, logFile: join(dir, `${base}-${n}.ndjson`) };
  }

  private onRunEvent(event: RunEvent, job: AgentJob, reported: LimitInfo[]): void {
    switch (event.type) {
      case "limit": {
        const info = this.ownLimit(event.info, job);
        reported.push(info);
        this.deps.quota.recordLimit(info);
        break;
      }
      case "utilization":
        this.deps.quota.recordUtilization({ ...event.info, provider: job.provider });
        break;
      case "progress":
        this.deps.logger.debug?.(`[${job.id}] ${event.text}`, { jobId: job.id });
        break;
    }
  }

  /**
   * A runner only reports limits about its own provider. A model limit that names no model is about the job's.
   * (Normalizing also keeps a runner registered under another provider name, like a mock, from blocking nothing.)
   */
  private ownLimit(info: LimitInfo, job: AgentJob): LimitInfo {
    const own: LimitInfo = { ...info, provider: job.provider };
    if (own.kind === "model" && !own.model) own.model = job.model;
    return own;
  }

  /** Makes sure the limit that stopped the run is recorded, and that it blocks the model that hit it. */
  private recordRunLimit(job: AgentJob, result: RunResult, reported: LimitInfo[]): void {
    const { quota, logger } = this.deps;
    const info = this.resultLimit(job, result, reported);
    if (info && !reported.some((event) => repeats(info, event))) quota.recordLimit(info);
    logger.info(`run ${job.id} hit a usage limit on ${job.provider}/${job.model}`, { jobId: job.id, error: result.error });
    if (quota.isAvailable(job.provider, job.model)) {
      // The limit names a different model than the one that hit it; block this one so the next try moves on
      // (otherwise the loop would rerun it at once, forever).
      const last = info ?? reported.at(-1);
      quota.recordLimit({ provider: job.provider, kind: "model", model: job.model, resetsAt: last?.resetsAt, raw: last?.raw ?? "" });
    }
  }

  /** The limit a limited result carries; undefined when only its events described it. */
  private resultLimit(job: AgentJob, result: RunResult, reported: LimitInfo[]): LimitInfo | undefined {
    if (result.limit) return this.ownLimit(result.limit, job);
    if (reported.length > 0) return undefined;
    return { provider: job.provider, kind: "unknown", raw: result.error || "usage limit without details" };
  }

  private recordRun(req: ExecRequest, job: AgentJob, result: RunResult): void {
    const { store, clock } = this.deps;
    const now = clock.now();
    store.appendUsage({
      at: new Date(now).toISOString(),
      missionId: req.missionId,
      role: req.role,
      provider: job.provider,
      model: job.model,
      effort: job.effort,
      outcome: result.outcome,
      durationMs: result.durationMs,
      usage: result.usage,
    });
    store.appendEvent(
      req.missionId,
      "run.end",
      {
        label: req.label,
        jobId: job.id,
        provider: job.provider,
        model: job.model,
        outcome: result.outcome,
        durationMs: result.durationMs,
        ...(result.error && { error: result.error }),
      },
      now,
    );
  }
}

/**
 * A run that ended for a reason outside the job: the CLI crashed or could not start, or it timed out without a single
 * sign of work (a hung CLI or a dead connection). Such a run says nothing about the job, so it is retried rather than
 * counted as the agent's failed attempt. A timeout after real progress is the agent's own (it was too slow).
 */
function isOutsideFailure(result: RunResult, progressed: boolean): boolean {
  return result.outcome === "crashed" || (result.outcome === "timeout" && !progressed);
}

/** The run's error on one line: its first line and, when the cause follows in a stderr tail, its last line. */
function runError(result: RunResult): string {
  const lines = (result.error || result.text || `the run ended "${result.outcome}"`)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const [first = "", last = first] = [lines[0], lines.at(-1)];
  return cap(first === last ? first : `${first} … ${last}`, 400);
}

/** The first non-empty line, capped. */
function firstLine(text: string): string {
  return cap(text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? text.trim(), 300);
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function providerList(candidates: Candidate[]): Provider[] {
  return [...new Set(candidates.map((c) => c.provider))];
}

/** "codex", "claude and codex". */
function providersOf(candidates: Candidate[]): string {
  return providerList(candidates).join(" and ");
}

/**
 * Whether a result's limit only repeats one an event already reported. A throttle must not be recorded twice (that
 * would double its backoff); any other limit is recorded again when its reset time differs, e.g. when the runner
 * read the reset from the result text because the event had none (the quota keeps the better information).
 */
function repeats(info: LimitInfo, event: LimitInfo): boolean {
  return info.kind === event.kind && info.model === event.model && (info.kind === "throttle" || info.resetsAt === event.resetsAt);
}
