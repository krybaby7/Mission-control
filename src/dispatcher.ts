// Dispatcher: drives one mission through its stages (onboard → spec → gate A → init → features → gate C → finalize).
// Every step works from the persisted Mission and saves after each state change, so a stopped or crashed run
// resumes where it left off. Prompt context and progress that are not part of the Mission (last failure output, the last
// passing verify tail, unit installs, init attempts, the final verify result) live next to it in <missionDir>/dispatch.json.
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  answerIsRecorded,
  checkpointId,
  endState,
  isCheckpointShape,
  isDerivedFeature,
  isWaitingForCheck,
  MAX_SEND_BACKS,
  nextCheckpointState,
  parkedNotice,
  scopeOf,
  sendBacks,
  shown,
  trimLog,
} from "./checkpoint.js";
import { resolveFamily } from "./config.js";
import { AuthUnavailableError, DeadlineError, type ExecResult, ProvidersFailingError, type RoleExecutor, StopRequestedError } from "./executor.js";
import type { Git } from "./git.js";
import type { Notifier } from "./notify.js";
import { describePlan, reviewLines } from "./plan.js";
import {
  buildPrompt,
  CAPS,
  contextPackPrompt,
  diagnosisPrompt,
  failureDigestPrompt,
  gateAPrompt,
  gateCPrompt,
  initPrompt,
  loadRolePrompt,
  loadStack,
  onboardPrompt,
  reportProsePrompt,
  reviewPrompt,
  specPrompt,
  testAuthorPrompt,
} from "./prompts.js";
import type { QuotaGovernor } from "./quota.js";
import { buildReportFacts, collectScreenshots, renderReport } from "./report.js";
import { normalizeVerifyConfig, SCHEMAS } from "./schemas.js";
import { type MissionStore, planOf, slugify } from "./state.js";
import type {
  Access,
  Attempt,
  BuildOutput,
  CheckpointKind,
  CheckpointLook,
  CheckpointRecord,
  Clock,
  Config,
  ContextPackOutput,
  DiagnosisOutput,
  Effort,
  Family,
  Feature,
  FeatureStatus,
  FailureDigestOutput,
  Finding,
  FrozenFile,
  GateOutput,
  InitOutput,
  JsonSchema,
  Logger,
  Mission,
  MissionStatus,
  OnboardOutput,
  PendingCheckpoint,
  PlanReview,
  Profile,
  Provider,
  ReportProseOutput,
  ReviewOutput,
  Role,
  RoleOverride,
  Rung,
  RunResult,
  SpecFeature,
  SpecOutput,
  Stage,
  TestAuthorOutput,
  Tier,
  VerifyConfig,
  VerifyResult,
} from "./types.js";
import { expandHome, readJsonOr, sha256, writeJsonAtomic } from "./util/fs.js";
import { runProcess } from "./util/process.js";
import { reapOrphans } from "./util/reap.js";
import { checkFrozen, hashFiles, isTestPath, scanAntiCheat, type Verifier } from "./verify.js";

export interface DispatcherDeps {
  config: Config;
  store: MissionStore;
  git: Git;
  executor: RoleExecutor;
  quota: QuotaGovernor;
  clock: Clock;
  logger: Logger;
  notifier: Notifier;
  verifierFor: (missionId: string) => Verifier;
  stopCheck: () => boolean;
  /** Epoch ms; past it the mission stops (and resumes on the next run). */
  deadline?: number;
  /** House stack for greenfield apps (stacks/<name>.md). Default "nextjs". */
  stackName?: string;
  /** Free bytes on the file system that holds `path` (an existing directory). Default: statfs. */
  freeBytes?: (path: string) => number;
  /**
   * Kills processes that agents and test commands left running (servers holding ports). Runs before every agent run
   * and every verification. Default: util/reap.ts, which only acts inside the container.
   */
  reapOrphans?: () => Promise<number[]>;
}

const INTEGRATION_DIR = "_integration";
/** Key of the greenfield scaffold in dispatch.json; not a valid feature id, so it never collides with one. */
const INIT_UNIT = "_init";
const SPEC_ATTEMPTS = 2;
/** Tries at installing a unit's dependencies; a stop that cuts an install short does not count. */
const MAX_INSTALL_TRIES = 2;
const MAX_FEATURES = 25;
const MAX_FEATURE_ID_LENGTH = 60;
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** strerror(ENOSPC). Not the bare code: "ENOSPC: System limit for number of file watchers reached" is not about disk space. */
const NO_SPACE = /no space left on device/i;
const BASELINE_LINES = 20;
/** Below this much free disk space no new step starts: installs, builds and tests would fail for the wrong reason. */
const MIN_FREE_BYTES = 2 * 1024 ** 3;
/** Runs cut short this many times by Mission Control itself dying (a crash, a power cut) set their step aside. */
const MAX_INTERRUPTIONS = 3;
/** Git lock files at least this old when a mission starts were left by a git process that was killed. */
const STALE_LOCK_MS = 60_000;
/** The executor waits this long past a limit's reset (src/executor.ts). */
const EXEC_WAIT_MARGIN_MS = 45_000;
/** CLI failures in a row (since its last success) after which a provider counts as failing between missions. */
const FAILING_STREAK = 3;
/** How much of a diff is read before it is condensed for a prompt (bounds memory on huge diffs). */
const RAW_DIFF_CHARS = 20_000_000;
const MAX_LISTED_FILES = 10;
const REPO_FILES_TIMEOUT_MS = 60_000;
const UNCHECKABLE =
  "no acceptance tests could be written for it, and the project's own checks were already failing, so nothing could check it";
const FINISHED: ReadonlySet<FeatureStatus> = new Set(["done", "blocked", "skipped"]);
const IN_PROGRESS: ReadonlySet<FeatureStatus> = new Set(["testing", "building", "reviewing"]);
const STATUS_WORD: Record<MissionStatus, string> = {
  queued: "queued",
  running: "running",
  waiting: "waiting",
  done: "done",
  partial: "partly done",
  stopped: "stopped",
  failed: "failed",
};

// ───────────────────────────── Role assignment ─────────────────────────────

export interface Assignment {
  family: Family;
  tier: Tier;
  effort: Effort;
}

/** Roles with their own tier/effort settings (the engineer's come from the escalation ladder). */
export type SettingsRole = keyof Config["roles"];

/**
 * The family a role runs on: a role override's family, else the mission profile's. "other" (test author, reviewer)
 * is resolved against `relativeTo`, by default the engineer's family.
 */
export function roleFamily(c: Config, m: Mission, role: Role, relativeTo?: Family): Family {
  const forced = roleOverride(m, role).family;
  if (forced) return forced;
  const profile = profileOf(c, m);
  switch (role) {
    case "architect":
    case "scout":
      return profile.architect;
    case "engineer":
      return profile.engineer;
    case "test_author":
    case "reviewer":
      return resolveFamily(profile[role], relativeTo ?? roleFamily(c, m, "engineer"), profile);
  }
}

/** Family, tier and effort of a role: config.roles, with the mission's overrides on top. */
export function assign(c: Config, m: Mission, role: SettingsRole, relativeTo?: Family): Assignment {
  const forced = roleOverride(m, role);
  const settings = c.roles[role];
  return { family: roleFamily(c, m, role, relativeTo), tier: forced.tier ?? settings.tier, effort: forced.effort ?? settings.effort };
}

/** Every override for `role`, merged in order: a later one wins field by field. */
function roleOverride(m: Mission, role: Role): Omit<RoleOverride, "role"> {
  const merged: Omit<RoleOverride, "role"> = {};
  for (const o of m.roleOverrides) {
    if (o.role !== role) continue;
    if (o.family) merged.family = o.family;
    if (o.tier) merged.tier = o.tier;
    if (o.effort) merged.effort = o.effort;
  }
  return merged;
}

function profileOf(c: Config, m: Mission): Profile {
  const profile = c.profiles[m.profile];
  if (!profile) throw new Error(`unknown profile "${m.profile}" (configured: ${Object.keys(c.profiles).join(", ")})`);
  return profile;
}

// ───────────────────────────── Spec validation ─────────────────────────────

/** Problems that make a spec unusable, each fit to send back to the architect; empty when it is fine. */
export function validateSpec(spec: SpecOutput): string[] {
  const problems: string[] = [];
  const count = spec.features.length;
  if (count < 1 || count > MAX_FEATURES) problems.push(`Plan between 1 and ${MAX_FEATURES} features (this spec has ${count}).`);
  const ids = new Set<string>();
  for (const f of spec.features) {
    if (!KEBAB_ID.test(f.id) || f.id.length > MAX_FEATURE_ID_LENGTH) {
      problems.push(`Feature id "${f.id}" must be kebab-case (lowercase letters, digits, single dashes), at most ${MAX_FEATURE_ID_LENGTH} characters.`);
    }
    if (ids.has(f.id)) problems.push(`Feature id "${f.id}" is used more than once.`);
    ids.add(f.id);
  }
  for (const f of spec.features) {
    for (const dep of f.deps) if (!ids.has(dep)) problems.push(`Feature "${f.id}" depends on "${dep}", which is not in the spec.`);
  }
  const cycle = findCycle(spec.features);
  if (cycle) problems.push(`The deps form a cycle: ${cycle.join(" → ")}.`);
  return problems;
}

/** A dependency cycle as a list of ids (first id repeated at the end), or undefined. */
function findCycle(features: SpecFeature[]): string[] | undefined {
  const deps = new Map(features.map((f) => [f.id, f.deps]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done" || !deps.has(id)) return undefined;
    if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "visiting");
    path.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const f of features) {
    const cycle = visit(f.id);
    if (cycle) return cycle;
  }
  return undefined;
}

// ───────────────────────────── Dispatcher ─────────────────────────────

export class Dispatcher {
  private active: MissionRun | undefined;

  constructor(private readonly deps: DispatcherDeps) {}

  /** Drives the mission from its persisted stage until it is complete, stopped or failed. Never leaves it "running". */
  async runMission(id: string): Promise<Mission> {
    const run = new MissionRun(this.deps, this.deps.store.load(id));
    this.active = run;
    try {
      await run.drive();
    } finally {
      this.active = undefined;
    }
    return run.m;
  }

  /** Wire into RoleExecutor's onWaiting: marks the running mission "waiting" until its next run starts. */
  onWaiting(until: number, reason: string): void {
    this.active?.waiting(until, reason);
  }

  /**
   * Why no mission can do any work now, in plain words, or undefined when one can. Asked between missions: when
   * every login has expired, every AI is at its limit until after the deadline, or the disk is full, the next
   * mission would only start (worktrees, installs) to stop again at once.
   */
  noWorkPossible(): string | undefined {
    const { config, quota, deadline } = this.deps;
    const disk = lowDisk(this.deps, [expandHome(config.home), expandHome(config.workspaceRoot)]);
    if (disk) return disk;
    const providers = unique([config.families.claude.provider, config.families.codex.provider, config.light.provider]);
    const times = providers.map((p) => quota.availableAt(p));
    if (times.every((t) => t === null)) return "every AI needs a new login";
    // Every AI command line has failed since it last worked (or needs a login): each mission would wait out the same
    // failures again before pausing (see ProvidersFailingError).
    // A single crash hours ago is not "keeps failing": the executor gives up only after several in a row.
    const streaks = providers.map((p) => quota.failureStreak(p)).map((s) => (s && s.count >= FAILING_STREAK ? s : undefined));
    const failing = streaks.find((s) => s !== undefined);
    if (failing && providers.every((p, i) => streaks[i] !== undefined || quota.state(p).status === "auth")) {
      return `the AI command lines keep failing (${failing.raw})`;
    }
    if (deadline !== undefined && times.every((t) => t === null || t + EXEC_WAIT_MARGIN_MS > deadline)) {
      return "no AI is free again before the time this run has to stop";
    }
    return undefined;
  }
}

/** Why work cannot go on for lack of disk space where any of `paths` live, or undefined. */
function lowDisk(deps: Pick<DispatcherDeps, "freeBytes">, paths: string[]): string | undefined {
  for (const path of paths) {
    const dir = existingAncestor(resolve(path));
    let free: number;
    try {
      free = (deps.freeBytes ?? statfsFree)(dir);
    } catch {
      continue; // unknown: never stop work on a guess
    }
    if (free < MIN_FREE_BYTES) {
      return `the disk is almost full (${(free / 1024 ** 3).toFixed(1)} GB free where ${dir} is kept; at least ${MIN_FREE_BYTES / 1024 ** 3} GB are needed)`;
    }
  }
  return undefined;
}

function statfsFree(dir: string): number {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

function existingAncestor(path: string): string {
  let dir = path;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/** Not enough agent runs left in the mission's budget. */
class BudgetExhaustedError extends Error {
  override readonly name = "BudgetExhaustedError";
}

/** The mission cannot go on without its owner; `decision` tells them what to do. */
class MissionFailedError extends Error {
  override readonly name = "MissionFailedError";
  constructor(
    message: string,
    readonly decision?: string,
  ) {
    super(message);
  }
}

/** The disk is (almost) full: work would fail for that reason, and be blamed on the code. The mission pauses. */
class DiskSpaceError extends Error {
  override readonly name = "DiskSpaceError";
}

/**
 * The mission stops on purpose: its owner asked to look at something first (a checkpoint). Not a failure; `end` parks the
 * mission, and a run leaves it alone until the owner answers. `ignored`: an answer found in the mission file was not trusted.
 */
class CheckpointParked extends Error {
  override readonly name = "CheckpointParked";
  constructor(
    readonly cp: PendingCheckpoint,
    readonly ignored?: "no_record",
  ) {
    super(`waiting for the owner's check (${cp.scope})`);
  }
}

/** Errors that end a feature step and must reach the mission loop instead of blocking the feature. */
function isMissionLevel(err: unknown): boolean {
  return (
    err instanceof CheckpointParked ||
    err instanceof StopRequestedError ||
    err instanceof DeadlineError ||
    err instanceof AuthUnavailableError ||
    err instanceof ProvidersFailingError ||
    err instanceof BudgetExhaustedError ||
    err instanceof MissionFailedError ||
    err instanceof DiskSpaceError
  );
}

function isStop(err: unknown): err is StopRequestedError | DeadlineError {
  return err instanceof StopRequestedError || err instanceof DeadlineError;
}

interface AgentCall {
  role: Role;
  label: string;
  /** The feature the run works on, if any: set aside when runs on it keep taking Mission Control down. */
  feature?: string;
  assignment: Assignment;
  cwd: string;
  prompt: string;
  schema: JsonSchema;
  access: Access;
  noTools?: boolean;
  /** Skipped (null) when no model is free right now or the run budget is spent. */
  optional?: boolean;
  maxTurns?: number;
}

interface AgentAnswer<T> {
  /** The validated structured answer; null unless the run ended "ok". */
  out: T | null;
  result: RunResult;
  provider: Provider;
  model: string;
  /** The family that actually ran the job (after any failover). */
  family: Family;
}

/** The verification of one build or fix attempt. */
interface UnitCheck {
  pass: boolean;
  verify: Pick<VerifyResult, "ok" | "outputTail" | "signature">;
  antiCheat: string[];
  frozenViolations: string[];
}

type BuildRung = Extract<Rung, { action: "build" }>;

class MissionRun {
  private readonly scratch: Scratch;
  private readonly verifier: Verifier;
  private readonly rolePrompts = new Map<Role, string>();

  constructor(
    private readonly deps: DispatcherDeps,
    readonly m: Mission,
  ) {
    this.scratch = new Scratch(join(deps.store.missionDir(m.id), "dispatch.json"));
    this.verifier = deps.verifierFor(m.id);
  }

  // ───────────── Driving ─────────────

  async drive(): Promise<void> {
    if (this.m.stage === "complete") return;
    if (isWaitingForCheck(this.m)) return; // stopped on purpose for the owner's look: nothing to do until they answer
    try {
      await this.begin();
      while (!this.ended()) {
        if (this.m.stage !== "finalize") this.checkStop(); // finalize is quick and leaves a complete report
        await this.runStageWithinBudget(this.m.stage);
      }
    } catch (err) {
      await this.end(err);
    }
  }

  private ended(): boolean {
    return this.m.stage === "complete" || this.m.status === "failed";
  }

  waiting(until: number, reason: string): void {
    this.m.status = "waiting";
    this.event("limit.wait", { until: new Date(until).toISOString(), reason });
    this.save();
  }

  private async begin(): Promise<void> {
    const { m } = this;
    const { config } = this.deps;
    if (!config.profiles[m.profile]) {
      const available = Object.keys(config.profiles).join(", ");
      throw new MissionFailedError(
        `Unknown profile "${m.profile}".`,
        `This mission asks for the profile "${m.profile}", which is not in the config (available: ${available}). Queue it again with one of those.`,
      );
    }
    // Decision 3: branches honor the configured prefix, until the integration branch is in use.
    if (!m.integrationWorktree) m.integrationBranch = `${config.git.branchPrefix}/${m.id}`;
    if (m.status === "failed") {
      // Running a failed mission again is a retry: the scaffold gets its full ladder again, and the failure's note
      // and decision go (the events keep them), so a mission that then finishes doesn't still ask for a fix.
      if (m.stage === "init") this.scratch.updateUnit(INIT_UNIT, { attempts: 0 });
      this.clearFailure(true);
    }
    const resumed = m.status !== "queued";
    m.status = "running";
    this.event(resumed ? "mission.resume" : "mission.start", { stage: m.stage });
    this.save();
    this.removeStaleGitLocks();
    await this.guardGitSettings();
    await this.recoverInterruptedRun();
  }

  /** Takes back the note and the decision the last failure added. */
  private clearFailure(retrying: boolean): void {
    const { m } = this;
    const old = m.failure;
    if (!old) return;
    if (old.decision !== undefined) m.decisionsNeeded = m.decisionsNeeded.filter((d) => d !== old.decision);
    m.notes = m.notes.filter((n) => n !== old.reason);
    delete m.failure;
    if (retrying) this.event("mission.retry", { failure: old.reason });
  }

  /**
   * An agent run that was going when Mission Control itself died (killed, a crash, a power cut) left its marker. It
   * counts toward the run cap, and a step that keeps taking Mission Control down is set aside instead of tried forever.
   */
  private async recoverInterruptedRun(): Promise<void> {
    const marker = this.scratch.inflight();
    if (!marker) return;
    this.scratch.setInflight(undefined);
    const count = this.scratch.recordInterruption(marker.label);
    this.m.agentRuns++;
    this.event("run.interrupted", { ...marker, count });
    this.noteOnce(`Mission Control stopped unexpectedly while "${marker.label}" was running (it started at ${marker.at}); that step was tried again.`);
    if (count < MAX_INTERRUPTIONS || marker.optional) return; // a helper's run: the step goes on without it soon enough
    const why = `Mission Control stopped unexpectedly ${count} times while working on it (a crash, the computer restarting, or a command that took it down)`;
    const f = marker.feature === undefined ? undefined : this.feature(marker.feature);
    if (f) {
      this.scratch.clearInterruptions(marker.label);
      if (!FINISHED.has(f.status)) await this.blockFeature(f, why);
      return;
    }
    this.scratch.clearInterruptions(marker.label);
    throw new MissionFailedError(
      `${why}, at the step "${marker.label}".`,
      `${why}, at the step "${marker.label}". Check that the computer stays on overnight and that Docker Desktop keeps running, then run: \`${this.resumeCommand()}\``,
    );
  }

  /** The command that runs this mission again. */
  private resumeCommand(): string {
    return `mc run --mission ${this.m.id}`;
  }

  private async runStageWithinBudget(stage: Stage): Promise<void> {
    try {
      await this.runStage(stage);
    } catch (err) {
      if (!(err instanceof BudgetExhaustedError)) throw err;
      this.noteOnce(err.message);
      this.m.status = "partial";
      await this.closeUnfinished();
      this.setStage("finalize");
    }
  }

  /** Nothing resumes a mission the run cap ended: its unfinished unit gives up its worktree and keeps its branch. */
  private async closeUnfinished(): Promise<void> {
    const reason = `the mission reached its safety cap of ${this.deps.config.limits.maxAgentRunsPerMission} agent runs before this feature was finished`;
    for (const f of this.m.features) if (IN_PROGRESS.has(f.status)) await this.blockFeature(f, reason);
  }

  private async runStage(stage: Stage): Promise<void> {
    switch (stage) {
      case "onboard":
        return this.onboard();
      case "spec":
        return this.specStage();
      case "gate_a":
        return this.gateA();
      case "init":
        await this.checkpointGate("plan"); // stops here, before the scaffold, if the owner wants to see the plan
        return this.init();
      case "features":
        await this.checkpointGate("plan"); // the first of the two stages reached asks; this one finds it passed
        return this.featuresStage();
      case "gate_c":
        return this.gateC();
      case "finalize":
        if (this.m.features.some((f) => f.status === "done") && (await this.checkpointGate("final")) === "leave") return;
        return this.finalize();
      case "complete":
        return;
    }
  }

  private async end(err: unknown): Promise<void> {
    if (err instanceof CheckpointParked) return this.park(err);
    if (isStop(err)) return this.stop(err.message);
    if (err instanceof DiskSpaceError) return this.pauseForDisk(err.message);
    if (err instanceof ProvidersFailingError) return this.pauseForFailingAgents(err);
    if (err instanceof AuthUnavailableError) {
      // A login is fixed outside Mission Control, so the next plain `mc run` retries the mission by itself.
      const decision =
        `Log in again: ${err.message}. In the Ubuntu window run ${loginCommands(err.providers)}. ` +
        `The next \`mc run\` then carries on with this mission by itself; to carry on right away, run \`${this.resumeCommand()}\`.`;
      return this.fail(`No model could run: ${err.message}.`, decision, true);
    }
    if (err instanceof MissionFailedError) return this.fail(err.message, err.decision);
    const message = errorMessage(err);
    this.deps.logger.error(`mission ${this.m.id} failed in stage ${this.m.stage}: ${message}`, { missionId: this.m.id });
    this.event("error", { stage: this.m.stage, message });
    return this.fail(
      `Internal error in stage ${this.m.stage}: ${message}`,
      `Mission Control ran into an internal error (see “Technical details”). To try again, run: \`${this.resumeCommand()}\``,
    );
  }

  private async stop(reason: string): Promise<void> {
    this.m.status = "stopped";
    this.event("mission.stopped", { stage: this.m.stage, reason });
    this.save();
    await this.writeReport(null);
  }

  /**
   * Stopped on purpose for the owner's look. Unlike `stop` it records no "paused" event (nothing went wrong), and the
   * phone hears about it with the commands that answer. The notice is sent after the checkpoint is saved and marked
   * only once it went out, so a crash in between is repaired by the next run (run.ts).
   */
  private async park(parked: CheckpointParked): Promise<void> {
    const { m } = this;
    m.status = "stopped";
    this.save();
    await this.writeReport(null);
    const cp = m.checkpoint;
    if (cp === undefined || cp.state !== "pending" || cp.notifiedAt !== undefined) return;
    const notice = parkedNotice(m, cp, parked.ignored !== undefined);
    await this.deps.notifier.notify(notice.title, notice.message, { priority: "high", tags: ["eyes"] });
    cp.notifiedAt = new Date(this.deps.clock.now()).toISOString();
    this.save();
  }

  /** Out of disk space: stopped (the next run carries on), with a note and a loud notification saying what to do. */
  private async pauseForDisk(reason: string): Promise<void> {
    const note = `Paused because ${reason}. Free some space (for example delete apps you no longer need from ~/mc-apps), then run Mission Control again; it carries on where it stopped.`;
    this.noteOnce(note);
    await this.stop(reason);
    await this.deps.notifier.notify(`${this.m.title}: paused, the disk is almost full`, note, { priority: "high", tags: ["warning"] });
  }

  /**
   * The AI command lines kept failing for reasons outside the work (a crash, a hang, an outage, limits that never
   * cleared): nothing was counted against the mission, so it is stopped and the next run carries on where it stopped.
   * The note names the real error; the notification says what to check.
   */
  private async pauseForFailingAgents(err: ProvidersFailingError): Promise<void> {
    const note =
      `Paused because ${err.message}. This was not a problem with the work, so nothing was counted against it. ` +
      "Check that the computer is online and run `mc doctor --live`; the next `mc run` carries on where this stopped.";
    this.noteOnce(note);
    await this.stop(err.message);
    await this.deps.notifier.notify(`${this.m.title}: paused, the AI isn't working`, note, { priority: "high", tags: ["warning"] });
  }

  /** `retryable`: a plain `mc run` picks the mission up again (else only `mc run --mission <id>` does). */
  private async fail(reason: string, decision?: string, retryable = false): Promise<void> {
    const { m } = this;
    this.clearFailure(false);
    m.status = "failed";
    this.noteOnce(reason);
    if (decision && !m.decisionsNeeded.includes(decision)) m.decisionsNeeded.push(decision);
    m.failure = { reason, ...(decision && { decision }), retryable };
    this.event("mission.failed", { stage: m.stage, reason });
    this.save();
    const report = await this.writeReport(null);
    const message = [decision ?? reason, report && `Read the report: mc report ${m.id}`].filter(Boolean).join("\n");
    await this.deps.notifier.notify(`${m.title}: failed`, message, { priority: "high", tags: ["warning"] });
  }

  private checkStop(): void {
    const { stopCheck, deadline, clock } = this.deps;
    if (stopCheck()) throw new StopRequestedError();
    if (deadline !== undefined && clock.now() >= deadline) throw new DeadlineError(deadline, "the deadline for this run has passed");
    this.checkDisk();
  }

  private checkDisk(): void {
    const { config } = this.deps;
    const low = lowDisk(this.deps, [expandHome(config.home), this.m.repoPath || expandHome(config.workspaceRoot)]);
    if (low) throw new DiskSpaceError(low);
  }

  // ───────────── Persistence and events ─────────────

  private save(): void {
    this.deps.store.save(this.m, this.deps.clock.now());
  }

  private event(type: string, data: Record<string, unknown> = {}): void {
    this.deps.store.appendEvent(this.m.id, type, data, this.deps.clock.now());
  }

  private setStage(stage: Stage): void {
    this.deps.logger.info(`${this.m.id}: stage ${this.m.stage} → ${stage}`, { missionId: this.m.id });
    this.event("stage", { from: this.m.stage, to: stage });
    this.m.stage = stage;
    this.save();
  }

  private noteOnce(text: string): void {
    if (this.m.notes.includes(text)) return;
    this.m.notes.push(text);
    this.save();
  }

  private setStatus(f: Feature, status: FeatureStatus, reason?: string): void {
    const from = f.status;
    f.status = status;
    if (reason !== undefined) f.blockedReason = reason;
    this.deps.logger.info(`${this.m.id}: feature ${f.id} ${from} → ${status}${reason ? ` (${reason})` : ""}`, { missionId: this.m.id });
    this.event("feature.status", { feature: f.id, from, to: status, ...(reason !== undefined && { reason }) });
    this.save();
  }

  private recordAttempt(f: Feature, attempt: Omit<Attempt, "at">): void {
    const recorded: Attempt = { ...attempt, at: new Date(this.deps.clock.now()).toISOString() };
    f.attempts.push(recorded);
    this.event("attempt", { feature: f.id, ...recorded });
    this.save();
  }

  // ───────────── Agents ─────────────

  private assign(role: SettingsRole, relativeTo?: Family): Assignment {
    return assign(this.deps.config, this.m, role, relativeTo);
  }

  private roleFamily(role: Role, relativeTo?: Family): Family {
    return roleFamily(this.deps.config, this.m, role, relativeTo);
  }

  /** The engineer's base family E: the ladder's "same" family. */
  private engineerFamily(): Family {
    return this.roleFamily("engineer");
  }

  /** A build rung's assignment; an engineer override forces its tier and effort onto every rung. */
  private rungAssignment(rung: BuildRung): Assignment {
    const forced = roleOverride(this.m, "engineer");
    const base = this.engineerFamily();
    const family = rung.family === "same" ? base : resolveFamily("other", base, profileOf(this.deps.config, this.m));
    return { family, tier: forced.tier ?? rung.tier, effort: forced.effort ?? rung.effort };
  }

  private rolePrompt(role: Role): string {
    let prompt = this.rolePrompts.get(role);
    if (prompt === undefined) {
      prompt = loadRolePrompt(role);
      this.rolePrompts.set(role, prompt);
    }
    return prompt;
  }

  /**
   * One guarded agent run: stop, disk and budget checks first; counts the run and persists it. A marker saved for the
   * run's duration tells the next start that Mission Control died during it (see recoverInterruptedRun). Afterwards,
   * whatever the agent left running is killed and the repository's git settings are checked.
   */
  private async run<T>(call: AgentCall): Promise<AgentAnswer<T> | null> {
    this.checkStop();
    const cap = this.deps.config.limits.maxAgentRunsPerMission;
    if (this.m.agentRuns >= cap) {
      if (call.optional) return null;
      throw new BudgetExhaustedError(`Stopped early: this mission used its safety cap of ${cap} agent runs.`);
    }
    await this.reap();
    this.scratch.setInflight({
      label: call.label,
      ...(call.feature !== undefined && { feature: call.feature }),
      ...(call.optional && { optional: true }),
      at: new Date(this.deps.clock.now()).toISOString(),
    });
    let exec: ExecResult;
    try {
      exec = await this.exec(call);
    } finally {
      this.scratch.setInflight(undefined);
      await this.reap();
      if (call.access === "workspace-write") await this.guardGitSettings();
    }
    if (exec.skipped || !exec.result || !exec.provider || !exec.model) return null;
    this.m.agentRuns++;
    this.save();
    const { result } = exec;
    return {
      out: result.outcome === "ok" ? (result.structured as T) : null,
      result,
      provider: exec.provider,
      model: exec.model,
      family: exec.family ?? call.assignment.family,
    };
  }

  private async exec(call: AgentCall): Promise<ExecResult> {
    const { family, tier, effort } = call.assignment;
    try {
      return await this.deps.executor.exec({
        missionId: this.m.id,
        role: call.role,
        label: call.label,
        family,
        tier,
        effort,
        allowFailover: true,
        optional: call.optional,
        cwd: call.cwd,
        systemPrompt: this.rolePrompt(call.role),
        prompt: call.prompt,
        outputSchema: call.schema,
        access: call.access,
        noTools: call.noTools,
        maxTurns: call.maxTurns ?? this.deps.config.limits.otherMaxTurns,
      });
    } finally {
      if (this.m.status === "waiting") {
        this.m.status = "running";
        this.save();
      }
    }
  }

  /** A required agent run (never skipped). */
  private async agent<T>(call: Omit<AgentCall, "optional">): Promise<AgentAnswer<T>> {
    const answer = await this.run<T>(call);
    if (!answer) throw new Error(`the required run "${call.label}" was skipped`);
    return answer;
  }

  /** An optional light-tier helper; null when skipped or unsuccessful. */
  private async scout<T>(label: string, prompt: string, schema: JsonSchema, cwd: string): Promise<T | null> {
    const call: AgentCall = { role: "scout", label, assignment: this.assign("scout"), cwd, prompt, schema, access: "read-only", noTools: true, optional: true };
    return (await this.run<T>(call))?.out ?? null;
  }

  // ───────────── Verification ─────────────

  private requireVerify(): VerifyConfig {
    if (!this.m.verify) throw new Error("the mission has no verify configuration");
    return this.m.verify;
  }

  /**
   * Runs one verify command and logs it. A failure while a stop is pending ends the run instead (the stop may be its
   * cause), and so does one for lack of disk space, which says nothing about the code. The command runs code agents
   * wrote, so leftover processes go first and the git settings are checked afterwards.
   */
  private async verify(label: string, run: (label: string) => Promise<VerifyResult>, feature?: string): Promise<VerifyResult> {
    this.checkDisk();
    await this.reap();
    const r = await run(label);
    await this.guardGitSettings();
    this.event("verify", {
      label,
      ...(feature !== undefined && { feature }),
      ok: r.ok,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      signature: r.signature,
      logFile: r.logFile,
    });
    if (!r.ok) {
      if (NO_SPACE.test(r.outputTail)) throw new DiskSpaceError(`a check ran out of disk space ("no space left on device")`);
      this.checkStop();
    }
    return r;
  }

  /** Kills processes earlier agents and checks left running (see util/reap.ts). */
  private async reap(): Promise<void> {
    const pids = await (this.deps.reapOrphans ?? reapOrphans)();
    if (pids.length > 0) {
      this.deps.logger.warn(`stopped ${pids.length} leftover process(es) that earlier steps left running`, { pids });
      this.event("processes.reaped", { pids });
    }
  }

  private async install(cwd: string, label: string): Promise<VerifyResult> {
    const vc = this.requireVerify();
    const r = await this.verify(`install-${label}`, () => this.verifier.install(cwd, vc));
    if (!r.ok) this.deps.logger.warn(`installing dependencies failed in ${cwd}`, { logFile: r.logFile });
    return r;
  }

  /** install, then the full verification (skipped when install fails). */
  private async installAndVerify(cwd: string, label: string): Promise<VerifyResult> {
    const vc = this.requireVerify();
    const installed = await this.install(cwd, label);
    if (!installed.ok) return installed;
    return this.verify(label, (l) => this.verifier.runFull(cwd, vc, l));
  }

  // ───────────── Git helpers ─────────────

  private async ensureIntegrationWorktree(): Promise<string> {
    const { m } = this;
    if (m.integrationWorktree && isCheckout(m.integrationWorktree)) {
      await this.keepOnBranch(m.integrationWorktree, m.integrationBranch);
      return m.integrationWorktree;
    }
    const base = need(m.baseSha, "the mission's base commit");
    const path = join(this.deps.store.worktreesDir(m.id), INTEGRATION_DIR);
    await this.deps.git.addWorktree(m.repoPath, path, m.integrationBranch, base); // creates the branch at base if needed
    m.integrationWorktree = path;
    this.save();
    return path;
  }

  /** The unit's worktree, (re)created from its branch when missing, with its dependencies installed. */
  private async ensureUnitWorktree(f: Feature): Promise<string> {
    let wt: string;
    if (f.worktree && f.branch && isCheckout(f.worktree)) {
      wt = f.worktree;
      await this.keepOnBranch(wt, f.branch); // an agent interrupted by a stop may have left it elsewhere
    } else {
      wt = await this.addUnitWorktree(f);
    }
    await this.installUnit(f, wt);
    return wt;
  }

  /**
   * Agents are told not to switch branches, but nothing stops them: a worktree whose HEAD an agent moved to a branch of
   * its own (or detached) goes back on `branch`, files untouched, so the next commit, the checks, the review and the
   * merge all see the same work, on the branch the mission follows.
   */
  private async keepOnBranch(wt: string, branch: string): Promise<void> {
    if (!(await this.deps.git.keepOnBranch(wt, branch))) return;
    this.deps.logger.warn(`an agent moved ${wt} off ${branch}; put it back, keeping its files`, { missionId: this.m.id });
    this.event("branch.restored", { worktree: wt, branch });
  }

  private async addUnitWorktree(f: Feature): Promise<string> {
    await this.ensureIntegrationWorktree();
    const path = join(this.deps.store.worktreesDir(this.m.id), f.id);
    const branch = f.branch ?? `${this.m.integrationBranch}--${f.id}`;
    await this.deps.git.addWorktree(this.m.repoPath, path, branch, this.m.integrationBranch);
    f.branch = branch;
    f.worktree = path;
    this.scratch.updateUnit(f.id, { installed: false, installFailures: 0 }); // a fresh checkout has no dependencies
    this.save();
    return path;
  }

  /**
   * Installs the unit's dependencies until that has worked once. An install a stop cut short runs again on resume;
   * a failing one is tried again at the unit's next step, up to MAX_INSTALL_TRIES, then the unit goes on without it.
   */
  private async installUnit(f: Feature, wt: string): Promise<void> {
    const { installed, installFailures = 0 } = this.scratch.unit(f.id);
    if (installed || installFailures >= MAX_INSTALL_TRIES) return;
    if ((await this.install(wt, f.id)).ok) {
      this.scratch.updateUnit(f.id, { installed: true });
      return;
    }
    this.scratch.updateUnit(f.id, { installFailures: installFailures + 1 });
    if (installFailures + 1 >= MAX_INSTALL_TRIES) {
      this.noteOnce(`Installing the dependencies of "${f.title}" failed, so its checks may fail for that reason.`);
    }
  }

  private async removeUnitWorktree(f: Feature): Promise<void> {
    if (!f.worktree) return;
    try {
      await this.deps.git.removeWorktree(this.m.repoPath, f.worktree);
    } catch (err) {
      this.deps.logger.warn(`could not remove the worktree of ${f.id}: ${errorMessage(err)}`, { worktree: f.worktree });
    }
    f.worktree = undefined;
    this.save();
  }

  /** Tracked and untracked (not ignored) files, for briefs; empty when git cannot list them. */
  private async repoFiles(cwd: string): Promise<string[]> {
    const r = await runProcess({
      command: "git",
      // No fsmonitor or hooks: agents can write the repository's config (see Git's BASE_ARGS).
      args: ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      cwd,
      timeoutMs: REPO_FILES_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) return [];
    return [...new Set(r.stdout.split("\0").filter((p) => p !== ""))].sort();
  }

  private missionDir(): string {
    return this.deps.store.missionDir(this.m.id);
  }

  /** The diff from `from` to HEAD for a prompt: lockfiles left out, every file its fair share (see condenseDiff). */
  private async promptDiff(wt: string, from: string): Promise<string> {
    return condenseDiff(await this.deps.git.diff(wt, from, "HEAD", RAW_DIFF_CHARS), CAPS.diff);
  }

  /**
   * Lock files a killed git process left in the app repository (index.lock and the like) make every later commit or
   * merge there fail. Nothing of this mission runs git now, so old ones go.
   */
  private removeStaleGitLocks(): void {
    const dir = this.m.repoPath ? gitCommonDir(this.m.repoPath) : undefined;
    if (!dir) return;
    const removed: string[] = [];
    for (const lock of gitLockFiles(dir)) {
      try {
        if (Date.now() - statSync(lock).mtimeMs < STALE_LOCK_MS) continue; // maybe a git command running right now
        rmSync(lock, { force: true });
        removed.push(relative(dir, lock));
      } catch {
        // gone meanwhile
      }
    }
    if (removed.length === 0) return;
    this.deps.logger.warn(`removed git lock files left by an interrupted run: ${removed.join(", ")}`, { missionId: this.m.id });
    this.event("git.locks.removed", { files: removed });
  }

  /**
   * Agents, and the installs and tests they write, run with full rights in worktrees that share the app repository's
   * .git: its config and hooks. A command put there (core.fsmonitor, core.hooksPath, a filter or merge driver, an
   * include, a hook) would run with every later git command, including the owner's own git in the app folder,
   * outside the container. The settings are recorded before any agent runs; when something adds a dangerous entry,
   * the recorded config goes back (other changes, like a remote the owner adds, stay), and new or changed hooks too.
   */
  private async guardGitSettings(): Promise<void> {
    const dir = this.m.repoPath ? gitCommonDir(this.m.repoPath) : undefined;
    if (!dir) return;
    try {
      const saved = this.scratch.gitSettings();
      if (!saved) {
        this.scratch.setGitSettings(await readGitSettings(dir));
        return;
      }
      const undone = await restoreGitSettings(dir, saved);
      if (undone.length === 0) {
        // Harmless changes (a remote the owner added) become the new baseline, so a later undo keeps them.
        const config = readText(join(dir, "config"));
        if (config !== undefined && config !== saved.config) {
          this.scratch.setGitSettings({ ...saved, config, entries: (await gitConfigEntries(join(dir, "config"))) ?? saved.entries });
        }
        return;
      }
      this.deps.logger.warn(`undid changes to the app repository's git settings: ${undone.join(", ")}`, { missionId: this.m.id });
      this.event("git.settings.restored", { changes: undone });
      this.noteOnce(
        `Something an agent ran changed the app repository's git settings (${listFiles(undone)}), which would make git run commands. The change was undone.`,
      );
    } catch (err) {
      this.deps.logger.warn(`could not check the app repository's git settings: ${errorMessage(err)}`, { missionId: this.m.id });
    }
  }

  // ───────────── Stage: onboard (feature missions) ─────────────

  private async onboard(): Promise<void> {
    await this.checkExistingRepo();
    await this.ensureBase();
    const wt = await this.ensureIntegrationWorktree();
    if (!this.m.verify) {
      this.m.verify = await this.askHowToVerify(wt);
      this.save();
    }
    await this.checkBaseline(wt);
    if (this.m.baselineBroken && !this.m.verify.tests) await this.askForTestsCommand(wt);
    this.setStage("spec");
  }

  private async checkExistingRepo(): Promise<void> {
    const { git } = this.deps;
    const repo = this.m.repoPath;
    if (!repo || !(await git.isRepo(repo))) {
      throw new MissionFailedError(
        `The folder ${repo || "(none given)"} is not a git repository.`,
        `The folder ${repo || "(none given)"} is not a git repository. Queue the change again with \`mc feature <folder> "<what to change>"\`, pointing at the main folder of a git checkout of your project.`,
      );
    }
    if (await git.isShallow(repo)) {
      throw new MissionFailedError(
        `The repository ${repo} is a shallow clone.`,
        `The repository ${repo} only has part of its history (a shallow clone). Run \`git fetch --unshallow\` in it, then run: \`${this.resumeCommand()}\``,
      );
    }
  }

  private async ensureBase(): Promise<void> {
    const { m } = this;
    if (!m.baseBranch) m.baseBranch = await this.deps.git.currentBranch(m.repoPath);
    m.baseSha ??= await this.deps.git.headSha(m.repoPath, m.baseBranch);
    this.save();
  }

  /** Asks the architect how the repository verifies itself; one retry when the answer is unusable. */
  private async askHowToVerify(wt: string): Promise<VerifyConfig> {
    const brief = onboardPrompt(this.m, await this.repoFiles(wt));
    let problem = "";
    let answered = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const answer = await this.agent<OnboardOutput>({
        role: "architect",
        label: "onboard",
        assignment: this.assign("architect"),
        cwd: wt,
        prompt: attempt === 1 ? brief : withProblems(brief, [problem]),
        schema: SCHEMAS.onboard,
        access: "read-only",
      });
      if (answer.out) {
        answered = true;
        try {
          const vc = normalizeVerifyConfig(answer.out.verify);
          this.noteOnce(`Stack: ${answer.out.stackSummary}`);
          for (const note of answer.out.notes) this.noteOnce(`Onboarding: ${note}`);
          return vc;
        } catch (err) {
          problem = errorMessage(err);
        }
      } else {
        problem = runFailure(answer.result);
      }
    }
    if (!answered) throw new MissionFailedError(`Could not work out how to check this project: ${problem}`, this.noAnswerDecision(problem));
    throw new MissionFailedError(
      `Could not work out how to check this project: ${problem}`,
      `I couldn't work out how to run this project's checks (tests, lint, build). Add a short note on how to run them to the README or AGENTS.md, then run: \`${this.resumeCommand()}\``,
    );
  }

  /**
   * The decision when the AI never gave a usable answer (its runs ended "failed", e.g. with invalid output): that says
   * nothing about the request, so the user is not asked to rephrase it, only to try again.
   */
  private noAnswerDecision(problem: string): string {
    return (
      `The AI didn't give a usable answer, twice (${problem.replace(/\.$/, "")}). That is not about your request. ` +
      `Try again with: \`${this.resumeCommand()}\`. If it happens again, run \`mc doctor --live\`.`
    );
  }

  /** Records whether the project's own checks already fail, so those failures are never blamed on the mission. */
  private async checkBaseline(wt: string): Promise<void> {
    const { m } = this;
    const result = await this.installAndVerify(wt, "baseline");
    m.baselineBroken = !result.ok;
    m.baselineFailures = result.ok ? [] : lastLines(result.outputTail, BASELINE_LINES);
    this.save();
    if (!result.ok) {
      this.noteOnce("The project's own checks were already failing before this mission started, so features were judged by their new tests.");
    }
  }

  /**
   * With the project's own checks already red, only a feature's own tests can judge it, which takes a command that
   * runs single test files. Without one no feature could ever pass, so the mission fails.
   */
  private async askForTestsCommand(wt: string): Promise<void> {
    const vc = this.requireVerify();
    const answer = await this.agent<OnboardOutput>({
      role: "architect",
      label: "onboard",
      assignment: this.assign("architect"),
      cwd: wt,
      prompt: withProblems(onboardPrompt(this.m, await this.repoFiles(wt)), [
        `\`verify.full\` (\`${vc.full}\`) already fails on the unchanged code, so new features can only be judged by running their own test files. Give a \`verify.tests\` command that runs just the given files, with \`{files}\` where their paths go. Keep the other commands as they are.`,
      ]),
      schema: SCHEMAS.onboard,
      access: "read-only",
    });
    const tests = answer.out?.verify.tests?.trim();
    if (!tests) {
      throw new MissionFailedError(
        "The project's own checks already fail, and there is no command that runs single test files.",
        `This project's own checks already fail before any change, and I found no way to run single test files, so I couldn't check new work. Fix the failing checks, or describe in the README or AGENTS.md how to run one test file, then run: \`${this.resumeCommand()}\``,
      );
    }
    this.m.verify = { ...vc, tests };
    this.save();
  }

  // ───────────── Stage: spec ─────────────

  private async specStage(): Promise<void> {
    const plan = planOf(this.m);
    if (plan) {
      // A plan written outside the team (mc plan queue): the team's planner is not asked. Safe to repeat after a stop,
      // since adoptSpec replaces the features and none has started.
      this.adoptSpec(structuredClone(plan.spec));
      this.setStage("gate_a");
      return;
    }
    const { spec, problems, answered } = await this.writeSpec(SPEC_ATTEMPTS);
    if (!spec && !answered) throw new MissionFailedError(`The plan could not be made: ${problems.join(" ")}`, this.noAnswerDecision(problems.join(" ")));
    if (!spec) {
      throw new MissionFailedError(
        `The plan could not be made usable: ${problems.join(" ")}`,
        'I couldn\'t turn your request into a workable plan. Describe it again in a few plain sentences and queue it again with `mc new "<your idea>"`.',
      );
    }
    this.adoptSpec(spec);
    this.setStage("gate_a");
  }

  /** Asks the architect for a spec until one passes validation; problems are sent back on a retry. */
  private async writeSpec(
    attempts: number,
    revise?: { previous: SpecOutput; issues: string[] },
  ): Promise<{ spec: SpecOutput | null; problems: string[]; answered: boolean }> {
    const greenfield = this.m.kind === "greenfield";
    const brief = specPrompt(this.m, greenfield ? this.stackDoc() : null, revise);
    let problems: string[] = [];
    let answered = false; // some run gave a plan (valid or not), so the problems are about the plan
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const answer = await this.agent<SpecOutput>({
        role: "architect",
        label: "spec",
        assignment: this.assign("architect"),
        cwd: await this.planningCwd(),
        prompt: problems.length > 0 ? withProblems(brief, problems) : brief,
        schema: SCHEMAS.spec,
        access: "read-only",
        noTools: greenfield, // there is no repository to look at yet
      });
      problems = answer.out ? validateSpec(answer.out) : [runFailure(answer.result)];
      answered ||= answer.out !== null;
      if (answer.out && problems.length === 0) return { spec: answer.out, problems, answered };
    }
    return { spec: null, problems, answered };
  }

  private adoptSpec(spec: SpecOutput): void {
    const { m } = this;
    const stale = new Set(m.spec?.assumptions ?? []);
    m.notes = m.notes.filter((n) => !stale.has(n));
    m.spec = { ...spec };
    m.features = spec.features.map(newFeature);
    for (const assumption of spec.assumptions) if (!m.notes.includes(assumption)) m.notes.push(assumption);
    this.event("spec", { appName: spec.appName, features: spec.features.map((f) => f.id) });
    this.save();
  }

  private stackDoc(): string {
    return loadStack(this.deps.stackName ?? "nextjs");
  }

  /** Where planning agents run: the repository for feature missions; greenfield has none yet. */
  private async planningCwd(): Promise<string> {
    return this.m.kind === "greenfield" ? this.missionDir() : this.ensureIntegrationWorktree();
  }

  // ───────────── Stage: gate A ─────────────

  private async gateA(): Promise<void> {
    const spec = need(this.m.spec, "the spec");
    const answer = await this.agent<GateOutput>({
      role: "reviewer",
      label: "gate-a",
      assignment: this.assign("reviewer", this.roleFamily("architect")),
      cwd: await this.planningCwd(),
      prompt: gateAPrompt(this.m),
      schema: SCHEMAS.gate,
      access: "read-only",
      noTools: true,
    });
    if (!answer.out) {
      this.noteOnce("The plan review did not finish, so the plan was used as written.");
      this.setPlanReview("unfinished", []);
    } else if (answer.out.verdict === "revise" && answer.out.issues.length > 0) {
      await this.reviseSpec(spec, answer.out.issues);
    } else {
      this.setPlanReview("approved", []);
    }
    this.setStage(this.m.kind === "greenfield" ? "init" : "features");
  }

  private async reviseSpec(previous: SpecOutput, issues: string[]): Promise<void> {
    const { spec } = await this.writeSpec(1, { previous, issues });
    if (spec) {
      this.setPlanReview("revised", issues); // saved together with the new plan
      this.adoptSpec(spec);
    } else {
      this.setPlanReview("not_applied", issues);
      this.noteOnce(`The plan reviewer asked for changes that could not be applied: ${issues.join(" ")}`);
    }
  }

  /**
   * A plan from outside (mc plan queue) keeps what its reviewer did with it, for the owner's look. Not saved here: the
   * caller's next save does it. A revision made by an earlier, cut-off pass of gate A stays on record.
   */
  private setPlanReview(outcome: PlanReview["outcome"], issues: string[]): void {
    const plan = planOf(this.m);
    if (!plan || (outcome !== "revised" && plan.review?.outcome === "revised")) return;
    this.m.plan = { ...plan, review: { outcome, issues } };
  }

  // ───────────── Stage: init (greenfield) ─────────────

  private async init(): Promise<void> {
    await this.ensureAppRepo();
    const wt = await this.ensureIntegrationWorktree();
    const rungs = this.deps.config.ladders.standard.filter(isBuildRung);
    for (let n = this.scratch.unit(INIT_UNIT).attempts ?? 0; ; n++) {
      const rung = rungs[n];
      if (!rung) {
        throw new MissionFailedError(
          `The app scaffold never passed its checks (${n} attempts).`,
          `I couldn't get the basic app skeleton to pass its own checks, so no features were built. Simplify the request and queue it again with \`mc new "<your idea>"\`, or try the skeleton once more with: \`${this.resumeCommand()}\``,
        );
      }
      const failure = await this.initAttempt(wt, rung, n);
      if (failure === null) break;
      this.scratch.updateUnit(INIT_UNIT, { attempts: n + 1, lastFailure: { outputTail: failure } });
    }
    await this.deps.git.commitAll(wt, "chore: scaffold app");
    this.setStage("features");
  }

  /** The app folder: <workspaceRoot>/<slug>, or -2, -3… when that is taken by something else. */
  private async ensureAppRepo(): Promise<void> {
    const { m } = this;
    if (!m.repoPath) {
      m.repoPath = this.freeAppDir(slugify(need(m.spec, "the spec").appName));
      this.save();
    }
    m.baseBranch ||= "main";
    await this.deps.git.ensureRepo(m.repoPath, { initialBranch: m.baseBranch });
    m.baseSha ??= await this.deps.git.headSha(m.repoPath, m.baseBranch);
    this.save();
    await this.guardGitSettings(); // records the settings before any agent works in the new repository
  }

  private freeAppDir(slug: string): string {
    const root = resolve(expandHome(this.deps.config.workspaceRoot));
    for (let n = 1; ; n++) {
      const dir = join(root, n === 1 ? slug : `${slug}-${n}`);
      if (!existsSync(dir) || readdirSync(dir).length === 0) return dir;
    }
  }

  /** One scaffold attempt; null when it passed, else the failure to show the next attempt. */
  private async initAttempt(wt: string, rung: BuildRung, n: number): Promise<string | null> {
    const last = this.scratch.unit(INIT_UNIT).lastFailure;
    const answer = await this.agent<InitOutput>({
      role: "engineer",
      label: "init",
      assignment: this.rungAssignment(rung),
      cwd: wt,
      prompt: initPrompt(this.m, this.stackDoc(), last && { outputTail: last.outputTail, attempt: n }),
      schema: SCHEMAS.init,
      access: "workspace-write",
      maxTurns: this.deps.config.limits.buildMaxTurns,
    });
    await this.keepOnBranch(wt, this.m.integrationBranch);
    const problem = this.adoptInitOutput(answer);
    const result = this.m.verify ? await this.installAndVerify(wt, `init-${n + 1}`) : null;
    const passed = result?.ok === true;
    this.event("attempt", {
      feature: INIT_UNIT,
      rung: n,
      provider: answer.provider,
      model: answer.model,
      effort: rung.effort,
      outcome: passed ? "pass" : answer.out ? "fail" : "error",
      ...(result?.signature && { signature: result.signature }),
    });
    if (passed) return null;
    return [problem, result?.outputTail].filter(Boolean).join("\n\n") || "No verification ran.";
  }

  /** Stores the scaffold's verify config; returns why it is unusable, or null. */
  private adoptInitOutput(answer: AgentAnswer<InitOutput>): string | null {
    if (!answer.out) return runFailure(answer.result);
    try {
      this.m.verify = normalizeVerifyConfig(answer.out.verify);
    } catch (err) {
      return errorMessage(err);
    }
    for (const note of answer.out.notes) this.noteOnce(`Setup: ${note}`);
    this.save();
    return null;
  }

  // ───────────── Stage: features ─────────────

  private async featuresStage(): Promise<void> {
    for (let f = this.nextFeature(); f; f = this.nextFeature()) await this.runFeature(f);
    this.setStage("gate_c");
  }

  /** An unfinished unit first (resume), else the first feature in spec order whose deps are all done. */
  private nextFeature(): Feature | undefined {
    this.skipOrphans();
    const open = this.m.features.filter((f) => !FINISHED.has(f.status));
    return open.find((f) => IN_PROGRESS.has(f.status)) ?? open.find((f) => f.deps.every((d) => this.feature(d)?.status === "done"));
  }

  /** Skips features waiting on a blocked or skipped one, until nothing changes. */
  private skipOrphans(): void {
    for (let changed = true; changed; ) {
      changed = false;
      for (const f of this.m.features) {
        if (FINISHED.has(f.status)) continue;
        const dead = f.deps.map((d) => this.feature(d)).find((d) => d?.status === "blocked" || d?.status === "skipped");
        if (!dead) continue;
        this.setStatus(f, "skipped", `waiting on "${dead.title}", which was ${dead.status}`);
        changed = true;
      }
    }
  }

  private feature(id: string): Feature | undefined {
    return this.m.features.find((f) => f.id === id);
  }

  /** Walks a feature to done/blocked; an unexpected error blocks just this feature. */
  private async runFeature(f: Feature): Promise<void> {
    try {
      while (!FINISHED.has(f.status)) {
        this.checkStop();
        await this.featureStep(f);
      }
    } catch (err) {
      if (isMissionLevel(err)) throw err;
      const message = errorMessage(err);
      this.deps.logger.error(`feature ${f.id} failed unexpectedly: ${message}`, { missionId: this.m.id, feature: f.id });
      this.event("error", { feature: f.id, message });
      await this.blockFeature(f, `internal error: ${message}`);
    }
  }

  private featureStep(f: Feature): Promise<void> {
    switch (f.status) {
      case "pending":
        return this.startUnit(f);
      case "testing":
        return this.testStep(f);
      case "building":
        return this.buildStep(f);
      case "reviewing":
        return this.reviewStep(f);
      default:
        return Promise.resolve();
    }
  }

  private async blockFeature(f: Feature, reason: string): Promise<void> {
    await this.removeUnitWorktree(f); // the branch stays, with the work so far
    this.setStatus(f, "blocked", reason);
  }

  // ── pending ──

  private async startUnit(f: Feature): Promise<void> {
    const wt = await this.ensureUnitWorktree(f);
    f.testsCommit = await this.deps.git.headSha(wt);
    this.setStatus(f, "testing");
  }

  // ── testing ──

  /** The test author writes the acceptance tests, which are committed and frozen before anything is built. */
  private async testStep(f: Feature): Promise<void> {
    const { git } = this.deps;
    const wt = await this.ensureUnitWorktree(f);
    const base = need(f.testsCommit, "the unit's start commit");
    const files = await this.writeTests(f, wt, base);
    if (files.length > 0) {
      await git.commitAll(wt, `test(${f.id}): acceptance tests`);
    } else {
      await git.resetHard(wt, base); // drops test files that earlier rounds left behind
      if (!this.m.baselineBroken) this.noteOnce(`No acceptance tests were written for "${f.title}", so only the full verification checked it.`);
    }
    await this.freezeTests(f, wt, files);
    this.setStatus(f, "building");
  }

  /**
   * Test-author rounds until it lists test files it really wrote that fail before the feature exists (rewritten tests,
   * with amendReason, may pass against the attempt already). An empty answer gets one retry, and so do tests that
   * already pass; those are accepted the second time, with a note. Returns [] when no round gave usable files.
   */
  private async writeTests(f: Feature, wt: string, base: string, amendReason?: string): Promise<string[]> {
    let previousTestFiles = f.frozenTests.map((t) => t.path);
    let emptyRetry = true;
    let vacuous = false;
    for (;;) {
      const files = await this.runTestAuthor(f, wt, base, { amendReason, vacuous, previousTestFiles });
      if (files.length === 0) {
        if (!emptyRetry) return [];
        emptyRetry = false;
      } else if (amendReason !== undefined || !(await this.testsPassAlready(f, wt, files))) {
        return files;
      } else if (vacuous) {
        this.noteOnce(`The tests for "${f.title}" already passed before it was built, so they may not check it fully.`);
        return files;
      } else {
        vacuous = true;
        previousTestFiles = files;
      }
    }
  }

  /**
   * Freezes `files` and makes HEAD the tests commit: where a diagnosis resets to and the anti-cheat scan starts. Also
   * records what else the engineer must leave alone (see recordGuard).
   */
  private async freezeTests(f: Feature, wt: string, files: string[]): Promise<void> {
    f.frozenTests = await hashFiles(wt, files);
    f.testsCommit = await this.deps.git.headSha(wt);
    await this.recordGuard(f, wt);
    this.event("tests.frozen", { feature: f.id, files: f.frozenTests.map((t) => t.path), commit: f.testsCommit });
    this.save();
  }

  /**
   * Besides its own frozen tests, an engineer must not change what judges its work: every other test file already
   * there (earlier features' acceptance tests, the scaffold's smoke tests, the project's own tests), the files the
   * verify commands run (scripts/mc-test.mjs, a checks script), the test runners' configs, and the package.json
   * scripts the verify commands call. All of it is hashed here, at the tests commit, and put back by checkUnit.
   */
  private async recordGuard(f: Feature, wt: string): Promise<void> {
    const vc = this.requireVerify();
    const own = new Set(f.frozenTests.map((t) => t.path));
    const files = await this.repoFiles(wt);
    const scripts = protectedScripts(readPackageScripts(wt), verifyCommands(vc));
    const harness = harnessFiles(files, [...verifyCommands(vc), ...Object.values(scripts)]).filter((p) => !isTestPath(p, vc.testGlobs));
    const guard: Guard = {
      tests: await hashFiles(wt, files.filter((p) => isTestPath(p, vc.testGlobs) && !own.has(p))),
      files: await hashFiles(wt, harness),
      scripts,
    };
    // Its own file: a big project's test list would make dispatch.json, rewritten around every agent run, heavy.
    writeJsonAtomic(this.guardFile(f), guard);
  }

  private guardFile(f: Feature): string {
    return join(this.missionDir(), "guards", `${f.id}.json`);
  }

  private loadGuard(f: Feature): Guard | undefined {
    const g = readJsonOr<Partial<Guard> | null>(this.guardFile(f), null);
    if (!isRecord(g) || !Array.isArray(g.tests) || !Array.isArray(g.files) || !isRecord(g.scripts)) return undefined;
    return g as Guard;
  }

  /**
   * amend_tests: the test author rewrites the tests on top of the failed attempt. The result is then restacked as a
   * tests commit (the old one plus the rewrite) with the attempt's code on top, so everything an engineer changed
   * stays after testsCommit, where the anti-cheat scan, the next diagnosis and a reset to the tests all see it.
   */
  private async amendTests(f: Feature, reason: string): Promise<void> {
    const { git } = this.deps;
    const wt = need(f.worktree, "the unit worktree");
    const oldTests = need(f.testsCommit, "the tests commit");
    await git.resetHard(wt, "HEAD"); // the attempt as committed, without leftovers of its verification
    const attempt = await git.headSha(wt);
    const attemptChanged = await git.changedFiles(wt, oldTests);
    const files = await this.writeTests(f, wt, attempt, reason);
    if (files.length === 0) {
      await git.resetHard(wt, attempt);
      this.noteOnce(`The rewritten tests for "${f.title}" could not be used, so its earlier tests stayed in place.`);
      return;
    }
    const authored = await git.changedFiles(wt, attempt);
    await git.commitAll(wt, `test(${f.id}): rewritten tests`);
    const rewrite = await git.headSha(wt);
    // A file both changed stays with the attempt, where a weakening in it is still scanned, unless it is one of the tests.
    const testPaths = unique([...files, ...f.frozenTests.map((t) => t.path), ...authored.filter((p) => !attemptChanged.includes(p))]);
    const carried = unique([...attemptChanged, ...authored]).filter((p) => !testPaths.includes(p));
    await git.resetHard(wt, oldTests);
    await git.restorePaths(wt, rewrite, testPaths);
    await git.commitAll(wt, `test(${f.id}): acceptance tests`);
    // The earlier tests the rewrite kept stay frozen too, or the engineer could change them freely from now on.
    const kept = f.frozenTests.map((t) => t.path).filter((p) => existsSync(join(wt, p)));
    await this.freezeTests(f, wt, unique([...files, ...kept]));
    await git.restorePaths(wt, rewrite, carried);
    await git.commitAll(wt, `wip(${f.id}): earlier attempt, kept for the rewritten tests`);
  }

  /** One test-author run; returns the test files it listed that it really changed (or kept from the frozen set). */
  private async runTestAuthor(
    f: Feature,
    wt: string,
    base: string,
    ctx: { amendReason: string | undefined; vacuous: boolean; previousTestFiles: string[] },
  ): Promise<string[]> {
    const answer = await this.agent<TestAuthorOutput>({
      role: "test_author",
      label: `test-${f.id}`,
      feature: f.id,
      assignment: this.assign("test_author", this.engineerFamily()),
      cwd: wt,
      prompt: testAuthorPrompt(this.m, f, { fileList: await this.repoFiles(wt), ...ctx }),
      schema: SCHEMAS.testAuthor,
      access: "workspace-write",
    });
    await this.keepOnBranch(wt, need(f.branch, "the unit branch"));
    const globs = this.requireVerify().testGlobs;
    const changed = await this.deps.git.changedFiles(wt, base);
    await this.revertNonTestChanges(f, wt, base, changed.filter((p) => !isTestPath(p, globs)));
    // Finished features' acceptance tests are theirs: rewriting them could hide that this feature breaks them.
    const theirs = new Set(this.doneFrozenPaths(f));
    const touchedTheirs = changed.filter((p) => theirs.has(p));
    if (touchedTheirs.length > 0) {
      await this.deps.git.restorePaths(wt, base, touchedTheirs);
      this.event("tests.stray", { feature: f.id, files: touchedTheirs });
      this.noteOnce(`The test author for "${f.title}" also changed the tests of features already finished (${listFiles(touchedTheirs)}); those changes were undone.`);
    }
    const eligible = new Set([...changed.filter((p) => isTestPath(p, globs) && !theirs.has(p)), ...f.frozenTests.map((t) => t.path)]);
    const listed = (answer.out?.testFiles ?? []).map((p) => repoRelative(wt, p));
    return [...new Set(listed)].filter((p) => eligible.has(p) && existsSync(join(wt, p)));
  }

  private async revertNonTestChanges(f: Feature, wt: string, base: string, stray: string[]): Promise<void> {
    if (stray.length === 0) return;
    await this.deps.git.restorePaths(wt, base, stray);
    this.event("tests.stray", { feature: f.id, files: stray });
    this.noteOnce(`The test author for "${f.title}" also changed files outside the test folders (${listFiles(stray)}); those changes were undone.`);
  }

  private async testsPassAlready(f: Feature, wt: string, files: string[]): Promise<boolean> {
    const vc = this.requireVerify();
    return (await this.verify(`${f.id}-red`, (l) => this.verifier.runTests(wt, vc, files, l), f.id)).ok;
  }

  // ── building ──

  private ladder(f: Feature): Rung[] {
    return this.deps.config.ladders[f.kind === "mechanical" ? "mechanical" : "standard"];
  }

  private async buildStep(f: Feature): Promise<void> {
    if (this.scratch.unit(f.id).pendingDiagnosis) {
      // A disputed test is diagnosed before anything else, even when a stop came between the dispute and its diagnosis.
      await this.ensureUnitWorktree(f);
      return this.runPendingDiagnosis(f);
    }
    const rung = this.ladder(f)[f.rung];
    if (!rung) return this.blockFeature(f, "tried every escalation step, but its checks still failed");
    if (this.uncheckable(f)) return this.blockFeature(f, UNCHECKABLE);
    await this.ensureUnitWorktree(f);
    if (rung.action === "diagnose") {
      await this.diagnose(f, null);
      f.rung++;
      this.save();
      return;
    }
    await this.buildAttempt(f, rung);
  }

  private async buildAttempt(f: Feature, rung: BuildRung): Promise<void> {
    const wt = need(f.worktree, "the unit worktree");
    const firstBuild = !f.attempts.some((a) => a.action === "build");
    const fileList = await this.repoFiles(wt);
    const contextPack = firstBuild ? await this.scout<ContextPackOutput>(`context-${f.id}`, contextPackPrompt(this.m, f, fileList), SCHEMAS.contextPack, wt) : null;
    const assignment = this.rungAssignment(rung);
    const answer = await this.agent<BuildOutput>({
      role: "engineer",
      label: `build-${f.id}`,
      feature: f.id,
      assignment,
      cwd: wt,
      prompt: buildPrompt(this.m, f, { rung: f.rung, fileList, contextPack, hint: f.hint, lastFailure: this.scratch.unit(f.id).lastFailure }),
      schema: SCHEMAS.build,
      access: "workspace-write",
      maxTurns: this.deps.config.limits.buildMaxTurns,
    });
    await this.keepOnBranch(wt, need(f.branch, "the unit branch"));
    const n = f.attempts.filter((a) => a.action === "build").length + 1;
    await this.deps.git.commitAll(wt, `wip(${f.id}): attempt ${n}`);
    const check = await this.checkUnit(f, `a${n}`);
    if (check.pass) return this.passBuild(f, answer, assignment, check);
    await this.failBuild(f, answer, assignment, check);
  }

  /** Frozen-test guard, anti-cheat scan and verification of the unit's current HEAD. */
  private async checkUnit(f: Feature, label: string): Promise<UnitCheck> {
    const wt = need(f.worktree, "the unit worktree");
    const testsCommit = need(f.testsCommit, "the tests commit");
    const frozenViolations = await this.restoreGuarded(f, wt, testsCommit);
    const diff = await this.deps.git.diff(wt, testsCommit, "HEAD");
    const antiCheat = scanAntiCheat(diff, this.requireVerify().testGlobs)
      .filter((x) => x.severity === "blocker")
      .map((x) => `${x.file}: ${x.rule} (${x.line.trim()})`);
    const verify = await this.verifyUnit(f, wt, label);
    return { pass: verify.ok && antiCheat.length === 0, verify, antiCheat, frozenViolations };
  }

  /**
   * Puts back what the engineer must not change (its frozen tests and the guard of recordGuard) and commits the
   * revert; returns what was put back.
   */
  private async restoreGuarded(f: Feature, wt: string, testsCommit: string): Promise<string[]> {
    const guard = this.loadGuard(f) ?? this.legacyGuard(f);
    const { modified, missing } = await checkFrozen(wt, [...f.frozenTests, ...guard.tests, ...guard.files]);
    const files = [...modified, ...missing];
    if (files.length > 0) await this.deps.git.restorePaths(wt, testsCommit, files);
    const scripts = restoreScripts(wt, guard.scripts);
    const touched = [...files, ...scripts.map((name) => `package.json (scripts.${name})`)];
    if (touched.length === 0) return [];
    await this.deps.git.commitAll(wt, "revert frozen test edits");
    this.event("frozen.reverted", { feature: f.id, files: touched });
    return touched;
  }

  /** A unit frozen before guards were recorded: at least the finished features' acceptance tests are kept as they were. */
  private legacyGuard(f: Feature): Guard {
    const own = new Set(f.frozenTests.map((t) => t.path));
    const tests = this.m.features.filter((x) => x.status === "done").flatMap((x) => x.frozenTests).filter((t) => !own.has(t.path));
    return { tests, files: [], scripts: {} };
  }

  /** The acceptance tests of the features already done (merged), except `except`'s. */
  private doneFrozenPaths(except?: Feature): string[] {
    const done = this.m.features.filter((x) => x.status === "done" && x !== except);
    return unique(done.flatMap((x) => x.frozenTests.map((t) => t.path)));
  }

  /** With the project's own checks already red, only the feature's frozen tests, run on their own, can judge it. */
  private uncheckable(f: Feature): boolean {
    return this.m.baselineBroken && (f.frozenTests.length === 0 || !this.requireVerify().tests);
  }

  /**
   * The frozen tests, then the full verification. A red baseline leaves the full verification out (see uncheckable),
   * so then the acceptance tests of every feature already merged run too: nothing else would notice this feature
   * breaking one of them.
   */
  private async verifyUnit(f: Feature, wt: string, label: string): Promise<UnitCheck["verify"]> {
    const vc = this.requireVerify();
    const own = f.frozenTests.map((t) => t.path);
    const paths = this.m.baselineBroken ? unique([...own, ...this.doneFrozenPaths(f).filter((p) => existsSync(join(wt, p)))]) : own;
    if (paths.length > 0 && vc.tests) {
      const tests = await this.verify(`${f.id}-tests-${label}`, (l) => this.verifier.runTests(wt, vc, paths, l), f.id);
      if (!tests.ok || this.m.baselineBroken) return tests;
    }
    return this.verify(`${f.id}-full-${label}`, (l) => this.verifier.runFull(wt, vc, l), f.id);
  }

  private async passBuild(f: Feature, answer: AgentAnswer<BuildOutput>, assignment: Assignment, check: UnitCheck): Promise<void> {
    this.recordAttempt(f, {
      ...attemptRun(f.rung, "build", answer, assignment),
      outcome: "pass",
      summary: passSummary(answer, check),
    });
    f.passingCommit = await this.deps.git.headSha(need(f.worktree, "the unit worktree"));
    f.builtBy = answer.family;
    this.scratch.updateUnit(f.id, { passTail: check.verify.outputTail, lastFailure: undefined });
    this.setStatus(f, "reviewing");
  }

  /**
   * Records the failure and moves to the next rung before any optional work, so a stop during the digest resumes on
   * the right rung. A disputed test is diagnosed at once: on the next diagnose rung when one is ahead (which it
   * consumes), else right after this rung. The dispute is saved with the rung, so a stop before or during that
   * diagnosis still has it diagnosed, with the dispute, first thing on resume (see buildStep).
   */
  private async failBuild(f: Feature, answer: AgentAnswer<BuildOutput>, assignment: Assignment, check: UnitCheck): Promise<void> {
    const ladder = this.ladder(f);
    const signature = check.verify.signature || undefined;
    const previous = f.attempts.filter((a) => a.action === "build").at(-1);
    const agentOk = answer.result.outcome === "ok";
    this.recordAttempt(f, {
      ...attemptRun(f.rung, "build", answer, assignment),
      outcome: agentOk ? "fail" : answer.result.outcome === "limited" ? "limited" : "error",
      ...(signature && { signature }),
      summary: failureSummary(answer.result, check),
    });
    const lastFailure: LastFailure = { outputTail: failureOutput(answer.result, check), antiCheat: check.antiCheat, frozenViolations: check.frozenViolations };
    const dispute = answer.out?.testDispute ?? null;
    const diagnoseAt = dispute ? nextDiagnoseIndex(ladder, f.rung) : undefined;
    const repeated = agentOk && signature !== undefined && signature === previous?.signature;
    // The diagnosis of a dispute stands for the diagnose rung ahead (consumed), else it comes between two build rungs.
    const diagnosisRung = diagnoseAt ?? f.rung + 1;
    this.scratch.updateUnit(f.id, { lastFailure, ...(dispute && { pendingDiagnosis: { dispute, rung: diagnosisRung } }) });
    f.rung = dispute ? (diagnoseAt !== undefined ? diagnoseAt + 1 : diagnosisRung) : nextRung(ladder, f.rung, repeated);
    this.save();

    if (check.verify.outputTail) {
      const prompt = failureDigestPrompt(check.verify.outputTail);
      const digest = await this.scout<FailureDigestOutput>(`digest-${f.id}`, prompt, SCHEMAS.failureDigest, need(f.worktree, "the unit worktree"));
      if (digest) this.scratch.updateUnit(f.id, { lastFailure: { ...lastFailure, digest } });
    }
    await this.runPendingDiagnosis(f);
  }

  /** The diagnosis a disputed test is owed, if any; once it ran (whatever it decided), it is no longer owed. */
  private async runPendingDiagnosis(f: Feature): Promise<void> {
    const pending = this.scratch.unit(f.id).pendingDiagnosis;
    if (!pending) return;
    await this.diagnose(f, pending.dispute, pending.rung);
    this.scratch.updateUnit(f.id, { pendingDiagnosis: undefined });
  }

  /** The architect decides what the failing unit needs: a hint, rewritten tests, or a human. */
  private async diagnose(f: Feature, dispute: Dispute | null, rung = f.rung): Promise<void> {
    const { git } = this.deps;
    const wt = need(f.worktree, "the unit worktree");
    const testsCommit = need(f.testsCommit, "the tests commit");
    const assignment = this.assign("architect");
    const answer = await this.agent<DiagnosisOutput>({
      role: "architect",
      label: `diagnose-${f.id}`,
      feature: f.id,
      assignment,
      cwd: wt,
      prompt: diagnosisPrompt(this.m, f, {
        lastOutputTail: this.scratch.unit(f.id).lastFailure?.outputTail ?? "",
        diff: await this.promptDiff(wt, testsCommit),
        dispute,
      }),
      schema: SCHEMAS.diagnosis,
      access: "read-only",
    });
    const out = answer.out;
    this.recordAttempt(f, {
      ...attemptRun(rung, "diagnose", answer, assignment),
      outcome: out ? "pass" : "error",
      summary: out ? `${out.action}: ${out.hint || out.reason}` : runFailure(answer.result),
    });
    if (!out) return;
    switch (out.action) {
      case "retry_with_hint":
        f.hint = out.hint;
        await git.resetHard(wt, testsCommit); // the next rung starts fresh from the tests
        this.save();
        return;
      case "amend_tests":
        if (out.hint) f.hint = out.hint;
        this.save();
        return this.amendTests(f, out.reason || out.hint);
      case "block": {
        const reason = out.reason || out.hint || "it needs a decision from you";
        this.m.decisionsNeeded.push(`"${f.title}": ${reason}`);
        return this.blockFeature(f, reason);
      }
    }
  }

  // ── reviewing ──

  private async reviewStep(f: Feature): Promise<void> {
    const wt = await this.ensureUnitWorktree(f);
    await this.deps.git.resetHard(wt, need(f.passingCommit, "the passing commit")); // drops a fix interrupted mid-way
    for (;;) {
      // The work the owner is about to look at was reviewed once already; a resume must not ask the reviewer again.
      if (!this.reviewSettled(f)) {
        const finished = await this.reviewAndFix(f, wt);
        if (this.looksAt(f)) this.scratch.updateUnit(f.id, { reviewedCommit: f.passingCommit, reviewSkipped: !finished });
      }
      const gate = await this.checkpointGate("feature", f);
      if (gate === "leave") return;
      if (gate === "go") break;
      // "again": the engineer changed the work after the owner's note; it is reviewed again and shown again
    }
    await this.merge(f);
  }

  /** The review and fix rounds; false when the review did not finish. */
  private async reviewAndFix(f: Feature, wt: string): Promise<boolean> {
    for (;;) {
      const findings = await this.review(f, wt);
      if (!findings) {
        this.noteOnce(`The review of "${f.title}" did not finish, so it was merged after passing its checks.`);
        return false;
      }
      this.keepOpen(f, findings.filter((x) => !isBlocking(x)));
      const blocking = findings.filter(isBlocking);
      if (blocking.length === 0) return true;
      if (f.reviewRounds >= this.deps.config.limits.maxReviewRounds || !(await this.fixFindings(f, wt, blocking))) {
        this.keepOpen(f, blocking);
        return true;
      }
      f.reviewRounds++;
      this.save();
    }
  }

  private async review(f: Feature, wt: string): Promise<Finding[] | null> {
    const answer = await this.agent<ReviewOutput>({
      role: "reviewer",
      label: `review-${f.id}`,
      feature: f.id,
      assignment: this.assign("reviewer", f.builtBy ?? this.engineerFamily()),
      cwd: wt,
      prompt: reviewPrompt(this.m, f, {
        diff: await this.promptDiff(wt, this.m.integrationBranch),
        verifyTail: this.scratch.unit(f.id).passTail ?? "",
      }),
      schema: SCHEMAS.review,
      access: "read-only",
    });
    return answer.out?.findings ?? null;
  }

  private keepOpen(f: Feature, findings: Finding[]): void {
    const known = new Set(f.openFindings.map(findingKey));
    for (const finding of findings) {
      if (known.has(findingKey(finding))) continue;
      known.add(findingKey(finding));
      f.openFindings.push(finding);
    }
    this.save();
  }

  /** A fix round by the engineer that passed; true when it is green again (new passingCommit), else rolled back. */
  private async fixFindings(f: Feature, wt: string, findings: Finding[]): Promise<boolean> {
    const assignment = this.passingAssignment(f);
    const answer = await this.agent<BuildOutput>({
      role: "engineer",
      label: `fix-${f.id}`,
      feature: f.id,
      assignment,
      cwd: wt,
      prompt: buildPrompt(this.m, f, { rung: f.rung, fileList: await this.repoFiles(wt), hint: f.hint, reviewFindings: findings }),
      schema: SCHEMAS.build,
      access: "workspace-write",
      maxTurns: this.deps.config.limits.buildMaxTurns,
    });
    await this.keepOnBranch(wt, need(f.branch, "the unit branch"));
    const round = f.reviewRounds + 1;
    await this.deps.git.commitAll(wt, `fix(${f.id}): review round ${round}`);
    const check = await this.checkUnit(f, `fix${round}`);
    const signature = check.verify.signature || undefined;
    this.recordAttempt(f, {
      ...attemptRun(f.rung, "fix", answer, assignment),
      outcome: check.pass ? "pass" : "fail",
      ...(signature && { signature }),
      summary: check.pass ? passSummary(answer, check) : failureSummary(answer.result, check),
    });
    if (!check.pass) {
      await this.deps.git.resetHard(wt, need(f.passingCommit, "the passing commit"));
      return false;
    }
    f.passingCommit = await this.deps.git.headSha(wt);
    this.scratch.updateUnit(f.id, { passTail: check.verify.outputTail });
    this.save();
    return true;
  }

  /** Same family, tier and effort as the attempt that passed. */
  private passingAssignment(f: Feature): Assignment {
    const family = f.builtBy ?? this.engineerFamily();
    const passed = f.attempts.filter((a) => a.outcome === "pass" && a.action !== "diagnose").at(-1);
    if (!passed) return { family, tier: "standard", effort: "high" };
    return { family, tier: tierOfModel(this.deps.config, family, passed.model), effort: passed.effort };
  }

  // ── merge ──

  /**
   * Merges the commit that was checked and reviewed (not whatever the unit branch name points at now), and makes sure
   * it really is in the mission branch afterwards: a feature is never "done" without its work.
   */
  private async merge(f: Feature): Promise<void> {
    const { git } = this.deps;
    const target = await this.ensureIntegrationWorktree();
    if (!(await git.isClean(target))) await git.resetHard(target, "HEAD"); // leftovers of an earlier verify run
    const source = f.passingCommit ?? need(f.branch, "the unit branch");
    const result = await git.merge(target, source, `feat(${f.id}): ${f.title}`);
    if (!result.ok) {
      return this.blockFeature(f, result.conflict ? "its changes conflicted with work merged earlier (merge conflict)" : `merging it failed: ${result.error}`);
    }
    if (!(await git.isAncestor(target, source, "HEAD"))) {
      return this.blockFeature(f, "its checked work did not end up in the mission branch when it was merged");
    }
    f.commit = result.sha;
    this.event("merge", { feature: f.id, commit: result.sha });
    await this.removeUnitWorktree(f);
    f.branch = undefined;
    this.setStatus(f, "done");
  }

  // ───────────── Stage: gate C ─────────────

  private async gateC(): Promise<void> {
    const { m } = this;
    if (!m.features.some((f) => f.status === "done")) return this.setStage("finalize");
    const wt = await this.ensureIntegrationWorktree();
    const full = await this.installAndVerify(wt, "gate-c");
    // Failures of a baseline that was already red are not the mission's to fix; the finished features' own
    // acceptance tests, run together on the merged result, are what must pass then.
    const regression = m.baselineBroken ? await this.regressionCheck(wt) : null;
    const ok = m.baselineBroken ? regression?.ok !== false : full.ok;
    const tail =
      regression && !regression.ok
        ? `The finished features' acceptance tests, run together on the merged result, FAILED:\n${regression.outputTail}\n\nThe project's own full check (already failing before this mission):\n${full.outputTail}`
        : full.outputTail;
    const findings = await this.finalReview(wt, tail);
    const blocking = (findings ?? []).filter(isBlocking);
    // Only once the review ran: a mission stopped before it (by the run cap) must not count as checked.
    this.scratch.setFinalVerify({ ok, head: await this.deps.git.headSha(wt), reviewed: findings !== null, blocking: blocking.length });
    const verifyRed = !ok;
    for (const finding of (findings ?? []).filter((x) => !isBlocking(x))) this.noteFinding(finding);
    if ((blocking.length > 0 || verifyRed) && m.gateCRounds < this.deps.config.limits.maxGateCRounds) {
      this.addFixFeature(blocking, verifyRed);
      m.gateCRounds++;
      return this.setStage("features");
    }
    for (const finding of blocking) this.noteFinding(finding);
    if (verifyRed) {
      this.noteOnce(m.baselineBroken ? "The acceptance tests of the finished features did not all pass together on the final result." : "The final check of the whole app did not pass.");
    }
    this.setStage("finalize");
  }

  /** The acceptance tests of every finished feature, run together on the merged result (red-baseline missions). */
  private async regressionCheck(wt: string): Promise<VerifyResult | null> {
    const vc = this.requireVerify();
    const paths = this.doneFrozenPaths().filter((p) => existsSync(join(wt, p)));
    if (paths.length === 0 || !vc.tests) return null;
    return this.verify("gate-c-features", (l) => this.verifier.runTests(wt, vc, paths, l));
  }

  private noteFinding(finding: Finding): void {
    this.noteOnce(`Final review (${finding.severity}): ${describeFinding(finding)}`);
  }

  /** The reviewer at frontier tier, from the family that did NOT build most of the done features. */
  private async finalReview(wt: string, verifyTail: string): Promise<Finding[] | null> {
    const builder = majorityBuilder(this.m.features);
    const reviewer = this.assign("reviewer", builder);
    const answer = await this.agent<ReviewOutput>({
      role: "reviewer",
      label: "gate-c",
      assignment: { ...reviewer, tier: roleOverride(this.m, "reviewer").tier ?? "frontier" },
      cwd: wt,
      prompt: gateCPrompt(this.m, {
        diff: await this.promptDiff(wt, need(this.m.baseSha, "the mission's base commit")),
        verifyTail,
        features: this.m.features,
      }),
      schema: SCHEMAS.review,
      access: "read-only",
    });
    if (!answer.out) this.noteOnce("The final review did not finish.");
    return answer.out?.findings ?? null;
  }

  private addFixFeature(blocking: Finding[], verifyRed: boolean): void {
    const { m } = this;
    let n = m.gateCRounds + 1;
    while (this.feature(`gate-c-fix-${n}`)) n++;
    const redCheck = m.baselineBroken
      ? `The acceptance tests of the finished features pass again: ${this.doneFrozenPaths().join(", ")}.`
      : "The full verification passes.";
    const acceptance = [...blocking.map(describeFinding), ...(verifyRed ? [redCheck] : [])];
    const fix = newFeature({
      id: `gate-c-fix-${n}`,
      title: "Fix problems found in the final review",
      story: "As the owner, I want the problems the final review found fixed, so the app works as a whole.",
      acceptance,
      kind: "standard",
      deps: [],
    });
    m.features.push(fix);
    this.event("feature.added", { feature: fix.id, acceptance });
    this.save();
  }

  // ───────────── Stage: finalize ─────────────

  private async finalize(): Promise<void> {
    if (this.m.kind === "greenfield") await this.publishToMain();
    if (this.deps.config.git.push) await this.pushBranch();
    await this.settleStatus();
    const screenshots = await this.screenshots();
    // A finalized mission never runs again, and its branch keeps everything: the checkout (with its node_modules)
    // would only fill the disk, and while it exists git refuses to check the branch out in the app folder.
    await this.removeIntegrationWorktree();
    await this.guardGitSettings(); // the app folder is the owner's from here on
    const report = await this.writeReport(await this.reportProse(), screenshots);
    await this.notifyFinished(report);
    this.event("mission.end", { status: this.m.status });
    this.setStage("complete");
  }

  /** Greenfield: main follows the integration branch, so `cd <app> && npm run dev` runs the result. */
  private async publishToMain(): Promise<void> {
    const { git } = this.deps;
    const { m } = this;
    if (!(await this.hasIntegrationBranch())) return;
    try {
      await git.fastForward(m.repoPath, m.baseBranch, m.integrationBranch);
      await git.checkout(m.repoPath, m.baseBranch);
    } catch (err) {
      this.noteOnce(`Could not move ${m.baseBranch} to the finished work: ${errorMessage(err)}`);
    }
  }

  private async pushBranch(): Promise<void> {
    if (!(await this.hasIntegrationBranch())) return;
    const pushed = await this.deps.git.push(this.m.repoPath, this.m.integrationBranch, this.deps.config.git.branchPrefix);
    if (!pushed.ok) this.noteOnce(`Could not push ${this.m.integrationBranch}: ${pushed.error ?? "unknown error"}`);
  }

  private async hasIntegrationBranch(): Promise<boolean> {
    const { m } = this;
    return m.repoPath !== "" && (await this.deps.git.isRepo(m.repoPath)) && (await this.deps.git.branchExists(m.repoPath, m.integrationBranch));
  }

  /**
   * done when every feature is done, gate C's checks passed on the current integration head, and no serious review
   * problem was left open (nor the final review left undone); a run-cap stop stays partial. The reviews only advise,
   * but "Done" tells the owner everything is fine, so open serious findings make it partly done, with a decision.
   */
  private async settleStatus(): Promise<void> {
    const { m } = this;
    if (m.status === "failed" || m.status === "stopped" || m.status === "partial") return;
    const allDone = m.features.length > 0 && m.features.every((f) => f.status === "done");
    const verified = allDone && (await this.finalVerifyPassed());
    const concerns = verified ? this.openReviewConcerns() : [];
    m.status = verified && concerns.length === 0 ? "done" : "partial";
    if (concerns.length > 0) {
      const decision = `Have someone check the app before you rely on it: ${concerns.join("; ")}. “Review notes” and “Technical details” list what the reviewers found.`;
      this.noteOnce(`Marked partly done although every feature passed its checks: ${concerns.join("; ")}.`);
      if (!m.decisionsNeeded.includes(decision)) m.decisionsNeeded.push(decision);
    }
    this.save();
  }

  /** Gate C's checks ran on the current integration head and passed (for a red baseline: the features' tests did). */
  private async finalVerifyPassed(): Promise<boolean> {
    const final = this.scratch.finalVerify();
    if (!final || !(await this.hasIntegrationBranch())) return false;
    const head = await this.deps.git.headSha(this.m.repoPath, this.m.integrationBranch);
    return final.head === head && final.ok;
  }

  /** Why the reviews keep the mission from "done", in plain words; empty when nothing serious is open. */
  private openReviewConcerns(): string[] {
    const concerns: string[] = [];
    const final = this.scratch.finalVerify();
    if (final?.reviewed === false) concerns.push("the final review of the whole app did not finish, so nobody reviewed it as a whole");
    else if ((final?.blocking ?? 0) > 0) concerns.push(`the final review found ${plural(final?.blocking ?? 0, "serious problem")} that ${final?.blocking === 1 ? "was" : "were"} not fixed`);
    const open = this.m.features.flatMap((f) => f.openFindings.filter(isBlocking).map(() => f.title));
    if (open.length > 0) concerns.push(`the reviewers' ${plural(open.length, "serious finding")} on ${listFiles(unique(open))} ${open.length === 1 ? "was" : "were"} not fixed`);
    return concerns;
  }

  private async removeIntegrationWorktree(): Promise<void> {
    const { m } = this;
    if (!m.integrationWorktree) return;
    try {
      await this.deps.git.removeWorktree(m.repoPath, m.integrationWorktree);
      m.integrationWorktree = undefined;
      this.save();
    } catch (err) {
      this.deps.logger.warn(`could not remove the integration worktree: ${errorMessage(err)}`, { missionId: m.id });
    }
  }

  private async screenshots(): Promise<string[]> {
    const wt = this.m.integrationWorktree;
    return wt && existsSync(wt) ? collectScreenshots(wt, join(this.missionDir(), "screenshots")) : [];
  }

  private async reportProse(): Promise<ReportProseOutput | null> {
    const facts = buildReportFacts(this.m, this.deps.store.readUsage());
    try {
      return await this.scout<ReportProseOutput>("report-prose", reportProsePrompt(this.m, facts), SCHEMAS.reportProse, this.missionDir());
    } catch (err) {
      if (isStop(err) || err instanceof DiskSpaceError) return null; // the report is written anyway, from the template
      throw err;
    }
  }

  /** Writes report.md; returns its path, or undefined when it could not be written. */
  private async writeReport(prose: ReportProseOutput | null, screenshots?: string[]): Promise<string | undefined> {
    const { store, clock, logger } = this.deps;
    try {
      const path = store.reportPath(this.m.id);
      const markdown = renderReport(this.m, {
        prose,
        usage: store.readUsage(),
        screenshots: screenshots ?? (await this.screenshots()),
        generatedAt: new Date(clock.now()).toISOString(),
      });
      writeFileSync(path, markdown);
      this.event("report", { path });
      return path;
    } catch (err) {
      logger.error(`could not write the report of ${this.m.id}: ${errorMessage(err)}`, { missionId: this.m.id });
      return undefined;
    }
  }

  /**
   * The phone gets what it can show: what got stuck, what needs the owner, and the command that shows the report
   * (the report's own path is inside the container, so it means nothing on the phone).
   */
  private async notifyFinished(report: string | undefined): Promise<void> {
    const { m } = this;
    const done = m.features.filter((f) => f.status === "done").length;
    const title = `${m.title}: ${STATUS_WORD[m.status]} (${done}/${m.features.length} features)`;
    const priority = m.status === "done" ? "default" : "high";
    const stuck = m.features.filter((f) => f.status === "blocked").map((f) => oneLine(f.title));
    const lines = [
      ...(stuck.length > 0 ? [`Stuck: ${listFiles(stuck)}`] : []),
      ...(m.decisionsNeeded.length > 0 ? [`Needs your decision: ${m.decisionsNeeded.length === 1 ? oneLine(m.decisionsNeeded[0] ?? "") : `${m.decisionsNeeded.length} things`}`] : []),
      report ? `Read the report: mc report ${m.id}` : "The report could not be written; see the logs.",
    ];
    await this.deps.notifier.notify(title, lines.join("\n"), { priority });
  }

  // ───────────── Checkpoints: stopping for the owner's look ─────────────

  /** Whether the owner looks at this feature before it is merged. Features the engine adds by itself are not asked about. */
  private looksAt(f: Feature): boolean {
    return this.m.checkpoints?.includes("feature") === true && !isDerivedFeature(f.id);
  }

  /** The feature was reviewed at the commit that is about to be shown or merged (tracked only when the owner looks at it). */
  private reviewSettled(f: Feature): boolean {
    return this.looksAt(f) && f.passingCommit !== undefined && this.scratch.unit(f.id).reviewedCommit === f.passingCommit;
  }

  /**
   * The gate of one kind of checkpoint, at the entry of the work it guards (so a resume comes back here and never repeats
   * the work before it). "go": carry on. "again" (feature): the work was changed after the owner's note, so it is
   * reviewed and shown again. "leave": the work this gate guards is no longer here (the feature was set aside, or the
   * final send-back added a feature and went back to building). Otherwise it throws CheckpointParked.
   * A mission that did not choose this kind returns at once and changes nothing: it runs as it always did.
   */
  private async checkpointGate(kind: CheckpointKind, f?: Feature): Promise<"go" | "again" | "leave"> {
    const { m } = this;
    if (!m.checkpoints?.includes(kind)) return "go";
    const cp = m.checkpoint;
    // An answer is believed only if the event that records it exists (see answerIsRecorded).
    const recorded = cp?.state === "answered" && isCheckpointShape(cp) && answerIsRecorded(cp, this.deps.store.readEvents(m.id));
    const step = nextCheckpointState(m, kind, f?.id, recorded);
    switch (step.step) {
      case "go":
        return "go";
      case "ask":
        if (step.drop !== undefined && cp !== undefined) {
          this.event("checkpoint.rejected", { id: typeof cp.id === "string" ? cp.id : "?", reason: step.drop });
          delete m.checkpoint;
          this.save();
        }
        return this.startCheckpoint(kind, f, step.round);
      case "stay":
        throw new CheckpointParked(need(m.checkpoint, "the checkpoint"));
      case "forged": {
        const waiting = need(m.checkpoint, "the checkpoint");
        this.event("checkpoint.rejected", { id: waiting.id, reason: "no_record" });
        const reset: PendingCheckpoint = { ...waiting, state: "pending" };
        delete reset.answer;
        delete reset.notifiedAt;
        delete reset.reworkFrom;
        m.checkpoint = reset;
        m.status = "stopped";
        this.save();
        throw new CheckpointParked(reset, "no_record");
      }
      case "pass": {
        const approved = need(m.checkpoint, "the checkpoint");
        this.event("checkpoint.passed", { id: approved.id });
        this.commitCheckpoint(approved);
        return "go";
      }
      case "rework":
        return this.rework(kind, f, need(m.checkpoint, "the checkpoint"));
      case "limit":
        return this.limitReached(kind, f, need(m.checkpoint, "the checkpoint"));
    }
  }

  /** Shows the work to the owner: saves the checkpoint, stops the mission in the same save, and throws to park it. */
  private async startCheckpoint(kind: CheckpointKind, f: Feature | undefined, round: number): Promise<never> {
    const { m } = this;
    const scope = scopeOf(kind, f?.id);
    const cp: PendingCheckpoint = {
      id: checkpointId(scope, round),
      scope,
      kind,
      ...(f && { featureId: f.id }),
      round,
      state: "pending",
      parkedAt: new Date(this.deps.clock.now()).toISOString(),
      look: await this.buildLook(kind, f, scope),
    };
    this.event("checkpoint.parked", { id: cp.id, kind, ...(f && { feature: f.id }), round });
    m.checkpoint = cp;
    m.status = "stopped"; // in the same save: a mission with a pending check is never saved as "running"
    this.save();
    throw new CheckpointParked(cp);
  }

  /** What the owner is shown (see CheckpointLook). Never fails: a look without file names is still a look. */
  private async buildLook(kind: CheckpointKind, f: Feature | undefined, scope: string): Promise<CheckpointLook> {
    const { m } = this;
    const key = f?.id ?? `_${kind}`;
    const failed = this.scratch.unit(key).reworkFailed === true;
    if (failed) this.scratch.updateUnit(key, { reworkFailed: undefined });
    const warning = sendBacks(m, scope) >= MAX_SEND_BACKS ? [`You have sent this back ${sendBacks(m, scope)} times. If you send it back again, the work stops here: ${endState(kind)}. You can still approve.`] : [];
    const title = shown(m.title);
    switch (kind) {
      case "plan": {
        const plan = planOf(m);
        if (plan) {
          // The leader wrote this plan: the owner gets every fact of it, the reviewer's answer and who changed it.
          return {
            headline: `Check the plan for “${title}”`,
            lines: [
              ...(failed ? ["Your change could not be made, so this is the earlier plan."] : []),
              "This plan was written by the leader, not by the team's planner.",
              ...reviewLines(plan.review, sendBacks(m, "plan")),
              ...describePlan(m.spec ?? plan.spec, { request: m.request, style: "look", newApp: m.kind === "greenfield" && m.repoPath === "" }),
              ...warning,
            ],
          };
        }
        const features = m.features;
        const choices = (m.spec?.assumptions ?? []).map((a) => shown(a)).join(" ");
        return {
          headline: `Check the plan for “${title}”`,
          lines: [
            ...(failed ? ["Your change could not be made, so this is the earlier plan."] : []),
            ...(m.spec?.summary ? [shown(m.spec.summary)] : []),
            `The plan has ${plural(features.length, "feature")}: ${features.map((x) => shown(x.title)).join(", ")}.`,
            ...features.map((x) => `“${shown(x.title)}”: ${shown(x.story)}`),
            ...(choices !== "" ? [`Choices made for you: ${choices}`] : []),
            ...warning,
          ],
        };
      }
      case "feature": {
        const feature = need(f, "the feature");
        const built = feature.attempts.filter((a) => a.outcome === "pass" && a.action !== "diagnose").at(-1)?.summary;
        const unreviewed = this.scratch.unit(feature.id).reviewSkipped === true;
        const notes = feature.openFindings;
        const files = await this.changedFilesOf(feature.worktree, m.integrationBranch);
        return {
          headline: `Check “${shown(feature.title)}” before it is added`,
          lines: [
            ...(failed ? ["Your change could not be made, so this is the earlier version."] : []),
            `“${shown(feature.title)}” is built and passed its checks${unreviewed ? ", but its review did not finish" : ", and was reviewed"}.`,
            ...(built ? [`What was built: ${shown(built)}`] : []),
            ...(notes.length > 0 ? [`The reviewer left ${plural(notes.length, notes.every((n) => n.severity === "minor") ? "small note" : "note")}: ${notes.slice(0, 3).map((n) => shown(n.description)).join("; ")}${notes.length > 3 ? ` and ${notes.length - 3} more` : ""}.`] : []),
            ...warning,
          ],
          ...(feature.branch !== undefined && { branch: feature.branch }),
          ...(feature.passingCommit !== undefined && { commit: feature.passingCommit.slice(0, 10) }),
          ...(files.length > 0 && { files: files.map((p) => shown(p)) }),
        };
      }
      case "final": {
        const done = m.features.filter((x) => x.status === "done").length;
        const stuck = m.features.filter((x) => x.status === "blocked");
        const verify = this.scratch.finalVerify();
        const open = m.features.flatMap((x) => x.openFindings);
        const files = await this.changedFilesOf(m.integrationWorktree, m.baseSha);
        const shots = (await this.screenshots()).map((p) => relative(this.missionDir(), p).split(/[\\/]/).join("/"));
        return {
          headline: `Check the finished app “${title}”`,
          lines: [
            done === m.features.length ? `All ${plural(done, "feature")} ${done === 1 ? "is" : "are"} built.` : `${done} of ${m.features.length} features are built.`,
            verify === undefined ? "The final checks did not run." : verify.ok ? "The final checks passed." : "The final checks did not pass.",
            ...(verify?.reviewed === false ? ["The final review did not finish."] : []),
            ...((verify?.blocking ?? 0) > 0 ? [`The final review found ${plural(verify?.blocking ?? 0, "serious problem")} that ${verify?.blocking === 1 ? "was" : "were"} not fixed.`] : []),
            ...(stuck.length > 0 ? [`${plural(stuck.length, "feature")} got stuck: ${stuck.map((x) => shown(x.title)).join(", ")}.`] : []),
            ...(open.length > 0 ? [`The reviewers left ${plural(open.length, "note")}: ${open.slice(0, 3).map((n) => shown(n.description)).join("; ")}${open.length > 3 ? ` and ${open.length - 3} more` : ""}.`] : []),
            ...warning,
          ],
          branch: m.integrationBranch,
          ...(files.length > 0 && { files: files.map((p) => shown(p)) }),
          ...(shots.length > 0 && { screenshots: shots }),
        };
      }
    }
  }

  private async changedFilesOf(cwd: string | undefined, from: string | undefined): Promise<string[]> {
    if (!cwd || !from || !existsSync(cwd)) return [];
    try {
      return (await this.deps.git.changedFiles(cwd, from)).slice(0, MAX_LISTED_FILES);
    } catch {
      return [];
    }
  }

  /**
   * One atomic save: the answer goes into the log and the checkpoint is cleared (and, for a final send-back, the stage was
   * set just before). So an answer is never applied twice, and a crash leaves it either still answered or fully handled.
   */
  private commitCheckpoint(cp: PendingCheckpoint): void {
    const { m } = this;
    const answer = need(cp.answer, "the answer");
    const record: CheckpointRecord = {
      id: cp.id,
      scope: cp.scope,
      kind: cp.kind,
      ...(cp.featureId !== undefined && { featureId: cp.featureId }),
      round: cp.round,
      decision: answer.decision,
      ...(answer.note !== undefined && { note: answer.note }),
      at: answer.at,
    };
    m.checkpointLog = trimLog([...(m.checkpointLog ?? []), record]);
    delete m.checkpoint;
    this.save();
  }

  /**
   * The owner sent the work back with a note: change it, record that, and show it again (plan: now; feature: after it is
   * reviewed again; final: after the new feature is built and checked). What changed is fingerprinted first
   * (`reworkFrom`), so a resume never runs the same step twice.
   */
  private async rework(kind: CheckpointKind, f: Feature | undefined, cp: PendingCheckpoint): Promise<"again" | "leave"> {
    let ok = true;
    switch (kind) {
      case "plan":
        ok = await this.reworkPlan(cp);
        break;
      case "feature":
        ok = await this.reworkFeature(need(f, "the feature"), cp);
        break;
      case "final":
        this.reworkFinal(cp);
        break;
    }
    this.event("checkpoint.reworked", { id: cp.id, kind, ...(f && { feature: f.id }), ok });
    this.commitCheckpoint(cp);
    if (kind === "plan") return this.startCheckpoint("plan", undefined, sendBacks(this.m, "plan") + 1);
    return kind === "final" ? "leave" : "again";
  }

  /** The architect revises the plan with the owner's note (nothing is built yet, so nothing is lost). False if it could not. */
  private async reworkPlan(cp: PendingCheckpoint): Promise<boolean> {
    const { m } = this;
    const previous = need(m.spec, "the spec");
    cp.reworkFrom ??= sha256(JSON.stringify(previous));
    this.save();
    if (sha256(JSON.stringify(m.spec)) !== cp.reworkFrom) return true; // the architect already changed it before a stop
    const { spec } = await this.writeSpec(1, { previous, issues: [`The owner asked for this change to the plan: ${cp.answer?.note ?? ""}`] });
    if (spec) {
      this.adoptSpec(spec);
      return true;
    }
    this.noteOnce("A requested change to the plan could not be made, so the earlier plan was kept.");
    this.scratch.updateUnit("_plan", { reworkFailed: true });
    return false;
  }

  /** The engineer that passed the feature changes it with the owner's note; a change that cannot pass its checks is rolled back. */
  private async reworkFeature(f: Feature, cp: PendingCheckpoint): Promise<boolean> {
    cp.reworkFrom ??= need(f.passingCommit, "the passing commit");
    this.save();
    if (f.passingCommit === cp.reworkFrom) {
      const wt = await this.ensureUnitWorktree(f);
      const asked: Finding = { severity: "major", file: null, description: `The owner looked at this and asked: ${cp.answer?.note ?? ""}`, suggestedTest: null };
      await this.fixFindings(f, wt, [asked]);
    }
    const landed = f.passingCommit !== cp.reworkFrom;
    if (!landed) this.scratch.updateUnit(f.id, { reworkFailed: true });
    return landed;
  }

  /** The owner's change becomes a feature of its own, built through the normal pipeline; the stage goes back to building. */
  private reworkFinal(cp: PendingCheckpoint): void {
    const { m } = this;
    const note = cp.answer?.note ?? "";
    if (cp.reworkFrom === undefined) {
      let n = 1;
      while (this.feature(`owner-change-${n}`)) n++;
      cp.reworkFrom = `owner-change-${n}`;
      this.save();
    }
    const id = cp.reworkFrom;
    if (!this.feature(id)) {
      const change = newFeature({
        id,
        title: "The change you asked for",
        story: note,
        acceptance: [`The change the owner asked for is in place: ${note}`, "The full verification still passes."],
        kind: "standard",
        deps: [],
      });
      m.features.push(change);
      this.event("feature.added", { feature: id, acceptance: change.acceptance });
      this.save();
    }
    this.event("stage", { from: m.stage, to: "features" });
    m.stage = "features"; // saved together with the log entry, in commitCheckpoint
  }

  /** The owner sent this back once too often: the work stops here, honestly, instead of going round again. */
  private async limitReached(kind: CheckpointKind, f: Feature | undefined, cp: PendingCheckpoint): Promise<"go" | "leave"> {
    const { m } = this;
    this.event("checkpoint.limit", { kind, ...(f && { feature: f.id }) });
    switch (kind) {
      case "plan":
        this.commitCheckpoint(cp);
        throw new MissionFailedError(
          "You asked for changes to the plan twice and sent it back a third time, so Mission Control stopped before building anything.",
          'Queue it again with a clearer description of what you want, for example: mc new "<your idea>"',
        );
      case "feature": {
        const feature = need(f, "the feature");
        const reason = "you asked for changes twice and it still was not right";
        m.decisionsNeeded.push(`"${feature.title}": ${reason}`);
        this.commitCheckpoint(cp);
        await this.blockFeature(feature, reason); // its branch keeps the work; the mission carries on and ends partly done
        return "leave";
      }
      case "final":
        m.status = "partial";
        m.decisionsNeeded.push("You sent the finished result back twice; it was finalized as it is.");
        this.commitCheckpoint(cp);
        return "go";
    }
  }
}

// ───────────────────────────── Side state (dispatch.json) ─────────────────────────────

interface LastFailure {
  outputTail: string;
  digest?: FailureDigestOutput | null;
  antiCheat?: string[];
  frozenViolations?: string[];
}

type Dispute = NonNullable<BuildOutput["testDispute"]>;

/** What the engineer must leave as it was at the tests commit, besides the feature's own frozen tests. */
interface Guard {
  /** Every other test file. */
  tests: FrozenFile[];
  /** Files the verify commands run, and the test runners' configs. */
  files: FrozenFile[];
  /** package.json scripts the verify commands call (directly or through each other), name → command. */
  scripts: Record<string, string>;
}

/** An agent run in progress (see MissionRun.run): still there on the next start means Mission Control died during it. */
interface InflightRun {
  label: string;
  feature?: string;
  optional?: boolean;
  at: string;
}

/** The repository's git settings as they were before any agent ran (see guardGitSettings). */
interface GitSettings {
  /** The config file's text. */
  config: string;
  /** Its entries as `git config --list` gives them ("key\nvalue"). */
  entries: string[];
  /** Hook file name → content (sample hooks left out). */
  hooks: Record<string, string>;
}

interface UnitScratch {
  /** What went wrong in the last failed attempt, for the next brief and the diagnosis. */
  lastFailure?: LastFailure;
  /** Verify output of the last passing check, for the reviewer. */
  passTail?: string;
  /** The unit worktree's dependencies were installed successfully. */
  installed?: boolean;
  /** Failed installs in the current unit worktree. */
  installFailures?: number;
  /** Init only: scaffold attempts made so far. */
  attempts?: number;
  /** A test dispute still to be diagnosed, and the rung that diagnosis is recorded on. */
  pendingDiagnosis?: { dispute: Dispute | null; rung: number };
  /** Only for a feature the owner looks at: the commit the review and fix rounds ended on (a resume then asks, not reviews). */
  reviewedCommit?: string;
  /** The review of that commit did not finish. */
  reviewSkipped?: boolean;
  /** The owner's last change could not be made; the next look says so (keys "_plan" and "_final" stand for those checks). */
  reworkFailed?: boolean;
}

interface FinalCheck {
  /** Gate C's checks passed (the full verification; for a red baseline, the finished features' acceptance tests). */
  ok: boolean;
  /** The integration head they ran on. */
  head: string;
  /** The final review finished (absent in files written before this was recorded: counts as finished). */
  reviewed?: boolean;
  /** Blocker/major findings of that review. */
  blocking?: number;
}

interface ScratchData {
  units: Record<string, UnitScratch>;
  finalVerify?: FinalCheck;
  inflight?: InflightRun;
  /** Agent runs cut short by Mission Control dying, by label, until the step is set aside. */
  interruptions?: Record<string, number>;
  gitSettings?: GitSettings;
}

/** Prompt context that must survive a restart but has no place in the Mission. Missing or corrupt → empty. */
class Scratch {
  private readonly data: ScratchData;

  constructor(private readonly file: string) {
    const loaded = readJsonOr<Partial<ScratchData> | null>(file, null);
    this.data = { units: {}, ...(isRecord(loaded) ? loaded : {}) };
    if (!isRecord(this.data.units)) this.data.units = {};
  }

  unit(id: string): UnitScratch {
    return this.data.units[id] ?? {};
  }

  updateUnit(id: string, patch: UnitScratch): void {
    this.data.units[id] = { ...this.unit(id), ...patch };
    this.write();
  }

  finalVerify(): FinalCheck | undefined {
    return this.data.finalVerify;
  }

  setFinalVerify(value: FinalCheck): void {
    this.data.finalVerify = value;
    this.write();
  }

  inflight(): InflightRun | undefined {
    const marker = this.data.inflight;
    return isRecord(marker) && typeof marker.label === "string" ? marker : undefined;
  }

  setInflight(marker: InflightRun | undefined): void {
    if (marker === undefined && this.data.inflight === undefined) return;
    this.data.inflight = marker;
    this.write();
  }

  /** Counts one more interruption of `label`; returns the count. */
  recordInterruption(label: string): number {
    const counts = isRecord(this.data.interruptions) ? this.data.interruptions : {};
    const count = (typeof counts[label] === "number" ? counts[label] : 0) + 1;
    this.data.interruptions = { ...counts, [label]: count };
    this.write();
    return count;
  }

  clearInterruptions(label: string): void {
    if (!this.data.interruptions) return;
    const { [label]: _, ...rest } = this.data.interruptions;
    this.data.interruptions = rest;
    this.write();
  }

  gitSettings(): GitSettings | undefined {
    const g = this.data.gitSettings;
    return isRecord(g) && typeof g.config === "string" && isRecord(g.hooks) ? g : undefined;
  }

  setGitSettings(value: GitSettings): void {
    this.data.gitSettings = value;
    this.write();
  }

  private write(): void {
    writeJsonAtomic(this.file, this.data);
  }
}

// ───────────────────────────── Small helpers ─────────────────────────────

function newFeature(sf: SpecFeature): Feature {
  return { ...sf, status: "pending", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isBuildRung(rung: Rung): rung is BuildRung {
  return rung.action === "build";
}

function nextDiagnoseIndex(ladder: Rung[], after: number): number | undefined {
  const index = ladder.findIndex((r, i) => i > after && r.action === "diagnose");
  return index >= 0 ? index : undefined;
}

/** The rung after `current`; a repeated failure jumps ahead to the next diagnose rung (unless that is next anyway). */
function nextRung(ladder: Rung[], current: number, repeated: boolean): number {
  const next = current + 1;
  if (!repeated || ladder[next]?.action === "diagnose") return next;
  return nextDiagnoseIndex(ladder, current) ?? next;
}

function attemptRun(rung: number, action: Attempt["action"], answer: AgentAnswer<unknown>, assignment: Assignment): Omit<Attempt, "outcome" | "summary" | "at"> {
  return { rung, action, provider: answer.provider, model: answer.model, effort: assignment.effort, usage: answer.result.usage };
}

function passSummary(answer: AgentAnswer<BuildOutput>, check: UnitCheck): string {
  const reverted = check.frozenViolations.length > 0 ? ` (edits to frozen tests were reverted: ${listFiles(check.frozenViolations)})` : "";
  return `${answer.out?.summary || "verification passed"}${reverted}`;
}

function failureSummary(result: RunResult, check: UnitCheck): string {
  const parts: string[] = [];
  if (result.outcome !== "ok") parts.push(`the agent run ended "${result.outcome}"${result.error ? `: ${result.error}` : ""}`);
  if (check.frozenViolations.length > 0) parts.push(`edited frozen tests (reverted): ${listFiles(check.frozenViolations)}`);
  if (check.antiCheat.length > 0) parts.push(`weakened the tests: ${check.antiCheat.join("; ")}`);
  if (!check.verify.ok) parts.push("verification failed");
  return parts.join("; ");
}

/** The failure output shown to the next attempt: the verify tail, or why there is none. */
function failureOutput(result: RunResult, check: UnitCheck): string {
  if (check.verify.outputTail) return check.verify.outputTail;
  return failureSummary(result, check) || "the attempt failed without output";
}

function runFailure(result: RunResult): string {
  return `The run ended "${result.outcome}"${result.error ? `: ${result.error}` : " without a valid answer"}.`;
}

function withProblems(prompt: string, problems: string[]): string {
  const list = problems.map((p) => `- ${p}`).join("\n");
  return `${prompt}\n## Your previous answer could not be used\n\n${list}\n\nFix these problems in your new answer.\n`;
}

function isBlocking(finding: Finding): boolean {
  return finding.severity === "blocker" || finding.severity === "major";
}

function findingKey(finding: Finding): string {
  return `${finding.severity}\u0000${finding.file ?? ""}\u0000${finding.description}`;
}

function describeFinding(finding: Finding): string {
  return finding.file ? `${finding.description} (${finding.file})` : finding.description;
}

/** The family that built most done features; undefined on a tie (or none). */
function majorityBuilder(features: Feature[]): Family | undefined {
  const counts = new Map<Family, number>();
  for (const f of features) if (f.status === "done" && f.builtBy) counts.set(f.builtBy, (counts.get(f.builtBy) ?? 0) + 1);
  const [first, second] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!first || (second && second[1] === first[1])) return undefined;
  return first[0];
}

function tierOfModel(c: Config, family: Family, model: string): Tier {
  if (model === c.light.model) return "light";
  return model === c.families[family].frontier ? "frontier" : "standard";
}

function isCheckout(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function repoRelative(root: string, path: string): string {
  const rel = isAbsolute(path) ? relative(root, path) : path;
  return rel.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

function lastLines(text: string, n: number): string[] {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .slice(-n);
}

function listFiles(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_FILES).join(", ");
  return paths.length > MAX_LISTED_FILES ? `${shown} and ${paths.length - MAX_LISTED_FILES} more` : shown;
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is missing`);
  return value;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The `mc` commands that log `providers` in again. */
function loginCommands(providers: Provider[]): string {
  const commands = unique(providers.flatMap((p) => (p === "claude" ? ["`mc login-claude`"] : p === "codex" ? ["`mc login-codex`"] : [])));
  return commands.length > 0 ? commands.join(" and ") : "`mc login-claude` and `mc login-codex`";
}

// ───────────────────────────── Diffs for prompts ─────────────────────────────

/** Lockfiles and generated files: long diffs that tell a reviewer nothing. */
const NOISE_FILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.(?:snap|min\.js|min\.css|map)$|(?:^|\/)(?:drizzle|migrations)\/meta\/[^/]+\.json$/;
/** Room kept per file for the line that says how much of it was left out. */
const OMISSION_NOTE_CHARS = 80;

interface DiffSection {
  path: string;
  text: string;
}

/**
 * A diff for a prompt, at most about `max` chars. Lockfiles and generated files shrink to one line saying they
 * changed. If the rest is still too long, every file gets an equal share of the room (files smaller than their share
 * stay whole and leave the rest to the others), so one big file never crowds out the rest: git lists files by path,
 * and keeping only the head would show the scaffold's configs and lockfile and none of the app's code.
 */
export function condenseDiff(diff: string, max: number): string {
  const { head, sections } = splitDiff(diff);
  const shown = sections.map((sec) =>
    NOISE_FILE.test(sec.path) ? { ...sec, text: `${firstLine(sec.text)}\n[${sec.path}: ${sec.text.length} chars of changes left out (a lockfile or generated file)]\n` } : sec,
  );
  const total = head.length + shown.reduce((sum, sec) => sum + sec.text.length, 0);
  if (total <= max) return head + shown.map((sec) => sec.text).join("");
  let room = Math.max(0, max - head.length - shown.length * OMISSION_NOTE_CHARS);
  const order = shown.map((sec, i) => ({ i, length: sec.text.length })).sort((a, b) => a.length - b.length);
  const kept = shown.map((sec) => sec.text);
  order.forEach(({ i, length }, k) => {
    const share = Math.floor(room / (order.length - k));
    if (length <= share) {
      room -= length;
      return;
    }
    const text = shown[i]?.text ?? "";
    const cut = Math.max(share, firstLine(text).length + 1);
    kept[i] = `${text.slice(0, cut)}${text.slice(0, cut).endsWith("\n") ? "" : "\n"}[… ${text.length - cut} more chars of this file's changes left out]\n`;
    room -= Math.min(room, cut);
  });
  return head + kept.join("");
}

function splitDiff(diff: string): { head: string; sections: DiffSection[] } {
  const starts: number[] = [];
  const header = /^diff --git /gm;
  for (let match = header.exec(diff); match; match = header.exec(diff)) starts.push(match.index);
  if (starts.length === 0) return { head: diff, sections: [] };
  const sections = starts.map((start, i) => {
    const text = diff.slice(start, starts[i + 1] ?? diff.length);
    const path = / b\/(.*)$/.exec(firstLine(text))?.[1] ?? "";
    return { path, text };
  });
  return { head: diff.slice(0, starts[0]), sections };
}

function firstLine(text: string): string {
  const end = text.indexOf("\n");
  return end < 0 ? text : text.slice(0, end);
}

// ───────────────────────────── What judges the engineer's work ─────────────────────────────

/** Test runner configs: they decide which tests run and how. */
const TEST_RUNNER_CONFIG = /(?:^|\/)(?:(?:vitest|playwright|jest)[\w.-]*\.(?:config|workspace)\b[\w.-]*\.(?:[cm]?[jt]s|json)|pytest\.ini|tox\.ini)$/;
/** What `make` reads when a verify command runs it. */
const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"];

function verifyCommands(vc: VerifyConfig): string[] {
  return [vc.full, ...(vc.tests ? [vc.tests] : [])];
}

/** The words of a shell command, unquoted, without a leading "./". */
function commandWords(command: string): string[] {
  return command
    .split(/[\s;&|()<>]+/)
    .map((w) => w.replace(/^['"]+|['"]+$/g, "").replace(/^(?:\.\/)+/, ""))
    .filter((w) => w !== "");
}

/**
 * The package.json scripts `commands` call, directly or through each other ("npm run verify" → verify → lint, …),
 * with their pre/post scripts; `name*` words (run-s "test:*") match by prefix. Name → command.
 */
function protectedScripts(scripts: Record<string, string>, commands: string[]): Record<string, string> {
  const kept: Record<string, string> = {};
  const queue = [...commands];
  for (let command = queue.pop(); command !== undefined; command = queue.pop()) {
    for (const word of commandWords(command)) {
      const names = word.endsWith("*") ? Object.keys(scripts).filter((n) => n.startsWith(word.slice(0, -1))) : [word];
      for (const name of names.flatMap((n) => [n, `pre${n}`, `post${n}`])) {
        const script = scripts[name];
        if (typeof script !== "string" || !Object.hasOwn(scripts, name) || Object.hasOwn(kept, name)) continue;
        kept[name] = script;
        queue.push(script);
      }
    }
  }
  return kept;
}

/** Repository files the commands name (a checks script, scripts/mc-test.mjs, the Makefile they `make`), plus every test runner config. */
function harnessFiles(files: string[], commands: string[]): string[] {
  const present = new Set(files);
  const words = commands.flatMap(commandWords);
  const named = [...words, ...(words.includes("make") ? MAKEFILES : [])].filter((w) => present.has(w));
  const configs = files.filter((p) => TEST_RUNNER_CONFIG.test(p));
  return unique([...named, ...configs]).sort();
}

function readPackageScripts(wt: string): Record<string, string> {
  const pkg = readPackageJson(wt);
  if (!pkg || !isRecord(pkg.json.scripts)) return {};
  return Object.fromEntries(Object.entries(pkg.json.scripts).filter((e): e is [string, string] => typeof e[1] === "string"));
}

function readPackageJson(wt: string): { text: string; json: Record<string, unknown> } | undefined {
  try {
    const text = readFileSync(join(wt, "package.json"), "utf8");
    const json: unknown = JSON.parse(text);
    return isRecord(json) ? { text, json } : undefined;
  } catch {
    return undefined; // none, or broken: the verification itself fails then
  }
}

/** Puts the protected package.json scripts back as they were; returns the names it had to restore. */
function restoreScripts(wt: string, saved: Record<string, string>): string[] {
  const names = Object.keys(saved);
  if (names.length === 0) return [];
  const pkg = readPackageJson(wt);
  if (!pkg) return [];
  const scripts: Record<string, unknown> = isRecord(pkg.json.scripts) ? { ...pkg.json.scripts } : {};
  const changed = names.filter((n) => scripts[n] !== saved[n]);
  if (changed.length === 0) return [];
  for (const n of changed) scripts[n] = saved[n];
  const indent = /^[ \t]+(?=")/m.exec(pkg.text)?.[0] ?? "  ";
  writeFileSync(join(wt, "package.json"), `${JSON.stringify({ ...pkg.json, scripts }, null, indent)}${pkg.text.endsWith("\n") ? "\n" : ""}`);
  return changed;
}

// ───────────────────────────── The app repository's .git ─────────────────────────────

/** The repository's common git directory (where config, hooks and the worktrees' admin files live), or undefined. */
function gitCommonDir(repo: string): string | undefined {
  const dotGit = join(repo, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!pointer) return undefined;
    const gitDir = resolve(repo, pointer);
    const common = join(gitDir, "commondir");
    return existsSync(common) ? resolve(gitDir, readFileSync(common, "utf8").trim()) : gitDir;
  } catch {
    return undefined;
  }
}

/** Lock files git may leave behind when killed: in the git dir, in each worktree's admin dir, and under refs/. */
function gitLockFiles(dir: string): string[] {
  const locks: string[] = [];
  const scan = (d: string, recursive: boolean) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(d, e.name);
      if (e.isFile() && e.name.endsWith(".lock")) locks.push(path);
      else if (recursive && e.isDirectory()) scan(path, true);
    }
  };
  scan(dir, false);
  scan(join(dir, "refs"), true);
  let worktrees: string[] = [];
  try {
    worktrees = readdirSync(join(dir, "worktrees"));
  } catch {
    // no linked worktrees
  }
  for (const name of worktrees) scan(join(dir, "worktrees", name), false);
  return locks;
}

/**
 * Config keys that make git run a command, read another config file, or send work somewhere else (lowercased
 * section and key, as `git config --list` prints them).
 */
const DANGEROUS_GIT_KEY = new RegExp(
  [
    "^core\\.(?:fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy|attributesfile|worktree|alternaterefscommand)$",
    "^include\\.path$",
    "^includeif\\..+\\.path$",
    "^extensions\\.",
    "^filter\\..+\\.(?:clean|smudge|process)$",
    "^merge\\..+\\.driver$",
    "^diff\\.external$",
    "^diff\\..+\\.(?:textconv|command)$",
    "^(?:difftool|mergetool|man|browser|web|credential|gpg|ssh|pager|alias|protocol)\\.",
    "^sequence\\.editor$",
    "^uploadpack\\.",
    "^remote\\..+\\.(?:uploadpack|receivepack|proxy|vcs)$",
    "^submodule\\..+\\.update$",
    "^url\\..+\\.(?:insteadof|pushinsteadof)$",
  ].join("|"),
);

async function readGitSettings(dir: string): Promise<GitSettings> {
  const config = readText(join(dir, "config")) ?? "";
  return { config, entries: (await gitConfigEntries(join(dir, "config"))) ?? [], hooks: readHooks(dir) };
}

/**
 * Undoes dangerous changes since `saved`: the config goes back when an entry with a dangerous key was added (or it no
 * longer parses), and hooks added or changed since go away or back. Returns what it undid.
 */
async function restoreGitSettings(dir: string, saved: GitSettings): Promise<string[]> {
  const undone: string[] = [];
  const configFile = join(dir, "config");
  const config = readText(configFile);
  if (config !== saved.config) {
    const entries = config === undefined ? null : await gitConfigEntries(configFile);
    const before = new Set(saved.entries);
    const added = entries === null ? ["(unreadable config)"] : entries.filter((e) => !before.has(e) && DANGEROUS_GIT_KEY.test(configKey(e)));
    if (added.length > 0) {
      replaceFile(configFile, saved.config, 0o644);
      undone.push(...unique(added.map(configKey)).map((k) => `config ${k}`));
    }
  }
  const hooksDir = join(dir, "hooks");
  for (const [name, content] of Object.entries(readHooks(dir))) {
    const original = saved.hooks[name];
    if (original === content) continue;
    if (original === undefined) rmSync(join(hooksDir, name), { force: true });
    else replaceFile(join(hooksDir, name), original, 0o755);
    undone.push(`hook ${name}`);
  }
  return undone;
}

function configKey(entry: string): string {
  const end = entry.indexOf("\n");
  return (end < 0 ? entry : entry.slice(0, end)).toLowerCase();
}

/** `git config --list` of one file, without following its includes; null when git cannot read it. */
async function gitConfigEntries(file: string): Promise<string[] | null> {
  const r = await runProcess({
    command: "git",
    args: ["config", "--file", file, "--no-includes", "--null", "--list"],
    cwd: dirname(file),
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    timeoutMs: REPO_FILES_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) return null;
  return r.stdout.split("\0").filter((e) => e !== "");
}

/** Hook name → content ("latin1", so any bytes survive), or "-> target" for a symbolic link. */
function readHooks(dir: string): Record<string, string> {
  const hooks: Record<string, string> = {};
  const hooksDir = join(dir, "hooks");
  let names: string[] = [];
  try {
    names = readdirSync(hooksDir);
  } catch {
    return hooks;
  }
  for (const name of names) {
    if (name.endsWith(".sample")) continue;
    const path = join(hooksDir, name);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) hooks[name] = `-> ${readlinkSync(path)}`;
      else if (st.isFile()) hooks[name] = readFileSync(path, "latin1");
    } catch {
      // gone meanwhile
    }
  }
  return hooks;
}

/** A fresh file at `path` (never writing through a symbolic link someone put there). */
function replaceFile(path: string, content: string, mode: number): void {
  rmSync(path, { force: true });
  writeFileSync(path, content, { encoding: "latin1", mode });
}

/** A file's text ("latin1": bytes kept as they are), or undefined when it can't be read as a regular file. */
function readText(path: string): string | undefined {
  try {
    return lstatSync(path).isFile() ? readFileSync(path, "latin1") : undefined;
  } catch {
    return undefined;
  }
}
