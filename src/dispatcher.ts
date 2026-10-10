// Dispatcher: drives one mission through its stages (onboard → spec → gate A → init → features → gate C → finalize).
// Every step works from the persisted Mission and saves after each state change, so a stopped or crashed run
// resumes where it left off. Prompt context and progress that are not part of the Mission (last failure output, the last
// passing verify tail, unit installs, init attempts, the final verify result) live next to it in <missionDir>/dispatch.json.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { resolveFamily } from "./config.js";
import { AuthUnavailableError, DeadlineError, type ExecResult, type RoleExecutor, StopRequestedError } from "./executor.js";
import type { Git } from "./git.js";
import type { Notifier } from "./notify.js";
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
import { type MissionStore, slugify } from "./state.js";
import type {
  Access,
  Attempt,
  BuildOutput,
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
  GateOutput,
  InitOutput,
  JsonSchema,
  Logger,
  Mission,
  MissionStatus,
  OnboardOutput,
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
import { expandHome, readJsonOr, writeJsonAtomic } from "./util/fs.js";
import { runProcess } from "./util/process.js";
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
const BASELINE_LINES = 20;
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

/** Errors that end a feature step and must reach the mission loop instead of blocking the feature. */
function isMissionLevel(err: unknown): boolean {
  return (
    err instanceof StopRequestedError ||
    err instanceof DeadlineError ||
    err instanceof AuthUnavailableError ||
    err instanceof BudgetExhaustedError ||
    err instanceof MissionFailedError
  );
}

function isStop(err: unknown): err is StopRequestedError | DeadlineError {
  return err instanceof StopRequestedError || err instanceof DeadlineError;
}

interface AgentCall {
  role: Role;
  label: string;
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
    try {
      this.begin();
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

  private begin(): void {
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
    // Running a failed mission again is a retry: the scaffold gets its full ladder again.
    if (m.status === "failed" && m.stage === "init") this.scratch.updateUnit(INIT_UNIT, { attempts: 0 });
    const resumed = m.status !== "queued";
    m.status = "running";
    this.event(resumed ? "mission.resume" : "mission.start", { stage: m.stage });
    this.save();
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

  private runStage(stage: Stage): Promise<void> {
    switch (stage) {
      case "onboard":
        return this.onboard();
      case "spec":
        return this.specStage();
      case "gate_a":
        return this.gateA();
      case "init":
        return this.init();
      case "features":
        return this.featuresStage();
      case "gate_c":
        return this.gateC();
      case "finalize":
        return this.finalize();
      case "complete":
        return Promise.resolve();
    }
  }

  private async end(err: unknown): Promise<void> {
    if (isStop(err)) return this.stop(err.message);
    if (err instanceof AuthUnavailableError) {
      return this.fail(`No model could run: ${err.message}.`, `Log in again: ${err.message}. Then run the mission again.`);
    }
    if (err instanceof MissionFailedError) return this.fail(err.message, err.decision);
    const message = errorMessage(err);
    this.deps.logger.error(`mission ${this.m.id} failed in stage ${this.m.stage}: ${message}`, { missionId: this.m.id });
    this.event("error", { stage: this.m.stage, message });
    return this.fail(`Internal error in stage ${this.m.stage}: ${message}`);
  }

  private async stop(reason: string): Promise<void> {
    this.m.status = "stopped";
    this.event("mission.stopped", { stage: this.m.stage, reason });
    this.save();
    await this.writeReport(null);
  }

  private async fail(reason: string, decision?: string): Promise<void> {
    const { m } = this;
    m.status = "failed";
    this.noteOnce(reason);
    if (decision && !m.decisionsNeeded.includes(decision)) m.decisionsNeeded.push(decision);
    this.event("mission.failed", { stage: m.stage, reason });
    this.save();
    const report = await this.writeReport(null);
    const message = [decision ?? reason, report && `Report: ${report}`].filter(Boolean).join("\n");
    await this.deps.notifier.notify(`${m.title}: failed`, message, { priority: "high", tags: ["warning"] });
  }

  private checkStop(): void {
    const { stopCheck, deadline, clock } = this.deps;
    if (stopCheck()) throw new StopRequestedError();
    if (deadline !== undefined && clock.now() >= deadline) throw new DeadlineError(deadline, "the deadline for this run has passed");
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

  /** One guarded agent run: stop and budget checks first; counts the run and persists it. */
  private async run<T>(call: AgentCall): Promise<AgentAnswer<T> | null> {
    this.checkStop();
    const cap = this.deps.config.limits.maxAgentRunsPerMission;
    if (this.m.agentRuns >= cap) {
      if (call.optional) return null;
      throw new BudgetExhaustedError(`Stopped early: this mission used its safety cap of ${cap} agent runs.`);
    }
    const exec = await this.exec(call);
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

  /** Runs one verify command and logs it. A failure while a stop is pending ends the run instead (the stop may be its cause). */
  private async verify(label: string, run: (label: string) => Promise<VerifyResult>, feature?: string): Promise<VerifyResult> {
    const r = await run(label);
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
    if (!r.ok) this.checkStop();
    return r;
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
    if (m.integrationWorktree && isCheckout(m.integrationWorktree)) return m.integrationWorktree;
    const base = need(m.baseSha, "the mission's base commit");
    const path = join(this.deps.store.worktreesDir(m.id), INTEGRATION_DIR);
    await this.deps.git.addWorktree(m.repoPath, path, m.integrationBranch, base); // creates the branch at base if needed
    m.integrationWorktree = path;
    this.save();
    return path;
  }

  /** The unit's worktree, (re)created from its branch when missing, with its dependencies installed. */
  private async ensureUnitWorktree(f: Feature): Promise<string> {
    const wt = f.worktree && f.branch && isCheckout(f.worktree) ? f.worktree : await this.addUnitWorktree(f);
    await this.installUnit(f, wt);
    return wt;
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
      args: ["-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      cwd,
      timeoutMs: REPO_FILES_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) return [];
    return [...new Set(r.stdout.split("\0").filter((p) => p !== ""))].sort();
  }

  private missionDir(): string {
    return this.deps.store.missionDir(this.m.id);
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
        `The folder ${repo || "(none given)"} is not a git repository. Point the mission at the main folder of a git checkout of your project.`,
      );
    }
    if (await git.isShallow(repo)) {
      throw new MissionFailedError(
        `The repository ${repo} is a shallow clone.`,
        `The repository ${repo} only has part of its history (a shallow clone). Run \`git fetch --unshallow\` in it, then run the mission again.`,
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
    throw new MissionFailedError(
      `Could not work out how to check this project: ${problem}`,
      "I couldn't work out how to run this project's checks (tests, lint, build). Add a short note on how to run them to the README or AGENTS.md, then run the mission again.",
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
        "This project's own checks already fail before any change, and I found no way to run single test files, so I couldn't check new work. Fix the failing checks, or describe in the README or AGENTS.md how to run one test file, then run the mission again.",
      );
    }
    this.m.verify = { ...vc, tests };
    this.save();
  }

  // ───────────── Stage: spec ─────────────

  private async specStage(): Promise<void> {
    const { spec, problems } = await this.writeSpec(SPEC_ATTEMPTS);
    if (!spec) {
      throw new MissionFailedError(
        `The plan could not be made usable: ${problems.join(" ")}`,
        "I couldn't turn your request into a workable plan. Try describing it again in a few plain sentences, then queue it again.",
      );
    }
    this.adoptSpec(spec);
    this.setStage("gate_a");
  }

  /** Asks the architect for a spec until one passes validation; problems are sent back on a retry. */
  private async writeSpec(
    attempts: number,
    revise?: { previous: SpecOutput; issues: string[] },
  ): Promise<{ spec: SpecOutput | null; problems: string[] }> {
    const greenfield = this.m.kind === "greenfield";
    const brief = specPrompt(this.m, greenfield ? this.stackDoc() : null, revise);
    let problems: string[] = [];
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
      if (answer.out && problems.length === 0) return { spec: answer.out, problems };
    }
    return { spec: null, problems };
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
    if (!answer.out) this.noteOnce("The plan review did not finish, so the plan was used as written.");
    else if (answer.out.verdict === "revise" && answer.out.issues.length > 0) await this.reviseSpec(spec, answer.out.issues);
    this.setStage(this.m.kind === "greenfield" ? "init" : "features");
  }

  private async reviseSpec(previous: SpecOutput, issues: string[]): Promise<void> {
    const { spec } = await this.writeSpec(1, { previous, issues });
    if (spec) this.adoptSpec(spec);
    else this.noteOnce(`The plan reviewer asked for changes that could not be applied: ${issues.join(" ")}`);
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
          "I couldn't get the basic app skeleton to pass its own checks, so no features were built. Try simplifying the request, then queue it again.",
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

  /** Freezes `files` and makes HEAD the tests commit: where a diagnosis resets to and the anti-cheat scan starts. */
  private async freezeTests(f: Feature, wt: string, files: string[]): Promise<void> {
    f.frozenTests = await hashFiles(wt, files);
    f.testsCommit = await this.deps.git.headSha(wt);
    this.event("tests.frozen", { feature: f.id, files: f.frozenTests.map((t) => t.path), commit: f.testsCommit });
    this.save();
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
    await this.freezeTests(f, wt, files);
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
      assignment: this.assign("test_author", this.engineerFamily()),
      cwd: wt,
      prompt: testAuthorPrompt(this.m, f, { fileList: await this.repoFiles(wt), ...ctx }),
      schema: SCHEMAS.testAuthor,
      access: "workspace-write",
    });
    const globs = this.requireVerify().testGlobs;
    const changed = await this.deps.git.changedFiles(wt, base);
    await this.revertNonTestChanges(f, wt, base, changed.filter((p) => !isTestPath(p, globs)));
    const eligible = new Set([...changed.filter((p) => isTestPath(p, globs)), ...f.frozenTests.map((t) => t.path)]);
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
      assignment,
      cwd: wt,
      prompt: buildPrompt(this.m, f, { rung: f.rung, fileList, contextPack, hint: f.hint, lastFailure: this.scratch.unit(f.id).lastFailure }),
      schema: SCHEMAS.build,
      access: "workspace-write",
      maxTurns: this.deps.config.limits.buildMaxTurns,
    });
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
    const frozenViolations = await this.restoreFrozenTests(f, wt, testsCommit);
    const diff = await this.deps.git.diff(wt, testsCommit, "HEAD");
    const antiCheat = scanAntiCheat(diff, this.requireVerify().testGlobs)
      .filter((x) => x.severity === "blocker")
      .map((x) => `${x.file}: ${x.rule} (${x.line.trim()})`);
    const verify = await this.verifyUnit(f, wt, label);
    return { pass: verify.ok && antiCheat.length === 0, verify, antiCheat, frozenViolations };
  }

  /** Puts back frozen test files the engineer touched (committing the revert); returns their paths. */
  private async restoreFrozenTests(f: Feature, wt: string, testsCommit: string): Promise<string[]> {
    if (f.frozenTests.length === 0) return [];
    const { modified, missing } = await checkFrozen(wt, f.frozenTests);
    const touched = [...modified, ...missing];
    if (touched.length === 0) return [];
    await this.deps.git.restorePaths(wt, testsCommit, touched);
    await this.deps.git.commitAll(wt, "revert frozen test edits");
    this.event("frozen.reverted", { feature: f.id, files: touched });
    return touched;
  }

  /** With the project's own checks already red, only the feature's frozen tests, run on their own, can judge it. */
  private uncheckable(f: Feature): boolean {
    return this.m.baselineBroken && (f.frozenTests.length === 0 || !this.requireVerify().tests);
  }

  /** The frozen tests, then the full verification, which a red baseline leaves out (see uncheckable). */
  private async verifyUnit(f: Feature, wt: string, label: string): Promise<UnitCheck["verify"]> {
    const vc = this.requireVerify();
    const paths = f.frozenTests.map((t) => t.path);
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
   * consumes), else right after this rung.
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
    this.scratch.updateUnit(f.id, { lastFailure });
    const dispute = answer.out?.testDispute ?? null;
    const diagnoseAt = dispute ? nextDiagnoseIndex(ladder, f.rung) : undefined;
    const repeated = agentOk && signature !== undefined && signature === previous?.signature;
    f.rung = dispute ? (diagnoseAt ?? f.rung + 1) : nextRung(ladder, f.rung, repeated);
    this.save();

    if (check.verify.outputTail) {
      const prompt = failureDigestPrompt(check.verify.outputTail);
      const digest = await this.scout<FailureDigestOutput>(`digest-${f.id}`, prompt, SCHEMAS.failureDigest, need(f.worktree, "the unit worktree"));
      if (digest) this.scratch.updateUnit(f.id, { lastFailure: { ...lastFailure, digest } });
    }
    if (!dispute) return;
    await this.diagnose(f, dispute);
    if (diagnoseAt !== undefined) {
      f.rung = diagnoseAt + 1;
      this.save();
    }
  }

  /** The architect decides what the failing unit needs: a hint, rewritten tests, or a human. */
  private async diagnose(f: Feature, dispute: { file: string; reason: string } | null): Promise<void> {
    const { git } = this.deps;
    const wt = need(f.worktree, "the unit worktree");
    const testsCommit = need(f.testsCommit, "the tests commit");
    const assignment = this.assign("architect");
    const answer = await this.agent<DiagnosisOutput>({
      role: "architect",
      label: `diagnose-${f.id}`,
      assignment,
      cwd: wt,
      prompt: diagnosisPrompt(this.m, f, {
        lastOutputTail: this.scratch.unit(f.id).lastFailure?.outputTail ?? "",
        diff: await git.diff(wt, testsCommit, "HEAD", CAPS.diff),
        dispute,
      }),
      schema: SCHEMAS.diagnosis,
      access: "read-only",
    });
    const out = answer.out;
    this.recordAttempt(f, {
      ...attemptRun(f.rung, "diagnose", answer, assignment),
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
      const findings = await this.review(f, wt);
      if (!findings) {
        this.noteOnce(`The review of "${f.title}" did not finish, so it was merged after passing its checks.`);
        break;
      }
      this.keepOpen(f, findings.filter((x) => !isBlocking(x)));
      const blocking = findings.filter(isBlocking);
      if (blocking.length === 0) break;
      if (f.reviewRounds >= this.deps.config.limits.maxReviewRounds || !(await this.fixFindings(f, wt, blocking))) {
        this.keepOpen(f, blocking);
        break;
      }
      f.reviewRounds++;
      this.save();
    }
    await this.merge(f);
  }

  private async review(f: Feature, wt: string): Promise<Finding[] | null> {
    const answer = await this.agent<ReviewOutput>({
      role: "reviewer",
      label: `review-${f.id}`,
      assignment: this.assign("reviewer", f.builtBy ?? this.engineerFamily()),
      cwd: wt,
      prompt: reviewPrompt(this.m, f, {
        diff: await this.deps.git.diff(wt, this.m.integrationBranch, "HEAD", CAPS.diff),
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
      assignment,
      cwd: wt,
      prompt: buildPrompt(this.m, f, { rung: f.rung, fileList: await this.repoFiles(wt), hint: f.hint, reviewFindings: findings }),
      schema: SCHEMAS.build,
      access: "workspace-write",
      maxTurns: this.deps.config.limits.buildMaxTurns,
    });
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

  private async merge(f: Feature): Promise<void> {
    const { git } = this.deps;
    const target = await this.ensureIntegrationWorktree();
    if (!(await git.isClean(target))) await git.resetHard(target, "HEAD"); // leftovers of an earlier verify run
    const result = await git.merge(target, need(f.branch, "the unit branch"), `feat(${f.id}): ${f.title}`);
    if (!result.ok) {
      return this.blockFeature(f, result.conflict ? "its changes conflicted with work merged earlier (merge conflict)" : `merging it failed: ${result.error}`);
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
    const findings = (await this.finalReview(wt, full)) ?? [];
    // Only once the review ran: a mission stopped before it (by the run cap) must not count as checked.
    this.scratch.setFinalVerify({ ok: full.ok, head: await this.deps.git.headSha(wt) });
    const blocking = findings.filter(isBlocking);
    // Failures of a baseline that was already red are not the mission's to fix.
    const verifyRed = !full.ok && !m.baselineBroken;
    for (const finding of findings.filter((x) => !isBlocking(x))) this.noteFinding(finding);
    if ((blocking.length > 0 || verifyRed) && m.gateCRounds < this.deps.config.limits.maxGateCRounds) {
      this.addFixFeature(blocking, verifyRed);
      m.gateCRounds++;
      return this.setStage("features");
    }
    for (const finding of blocking) this.noteFinding(finding);
    if (verifyRed) this.noteOnce("The final check of the whole app did not pass.");
    this.setStage("finalize");
  }

  private noteFinding(finding: Finding): void {
    this.noteOnce(`Final review (${finding.severity}): ${describeFinding(finding)}`);
  }

  /** The reviewer at frontier tier, from the family that did NOT build most of the done features. */
  private async finalReview(wt: string, full: VerifyResult): Promise<Finding[] | null> {
    const builder = majorityBuilder(this.m.features);
    const reviewer = this.assign("reviewer", builder);
    const answer = await this.agent<ReviewOutput>({
      role: "reviewer",
      label: "gate-c",
      assignment: { ...reviewer, tier: roleOverride(this.m, "reviewer").tier ?? "frontier" },
      cwd: wt,
      prompt: gateCPrompt(this.m, {
        diff: await this.deps.git.diff(wt, need(this.m.baseSha, "the mission's base commit"), "HEAD", CAPS.diff),
        verifyTail: full.outputTail,
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
    const acceptance = [...blocking.map(describeFinding), ...(verifyRed ? ["The full verification passes."] : [])];
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
    if (this.m.status === "done") await this.removeIntegrationWorktree();
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

  /** done when every feature is done and gate C passed on the current integration head; a run-cap stop stays partial. */
  private async settleStatus(): Promise<void> {
    const { m } = this;
    if (m.status === "failed" || m.status === "stopped" || m.status === "partial") return;
    const allDone = m.features.length > 0 && m.features.every((f) => f.status === "done");
    m.status = allDone && (await this.finalVerifyPassed()) ? "done" : "partial";
    this.save();
  }

  private async finalVerifyPassed(): Promise<boolean> {
    const final = this.scratch.finalVerify();
    if (!final || !(await this.hasIntegrationBranch())) return false;
    const head = await this.deps.git.headSha(this.m.repoPath, this.m.integrationBranch);
    // A baseline that was red before the mission is not the mission's failure.
    return final.head === head && (final.ok || this.m.baselineBroken);
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
      if (isStop(err)) return null; // the report is written anyway, from the template
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

  private async notifyFinished(report: string | undefined): Promise<void> {
    const { m } = this;
    const done = m.features.filter((f) => f.status === "done").length;
    const title = `${m.title}: ${STATUS_WORD[m.status]} (${done}/${m.features.length} features)`;
    const priority = m.status === "done" ? "default" : "high";
    await this.deps.notifier.notify(title, report ? `Report: ${report}` : "The report could not be written; see the logs.", { priority });
  }
}

// ───────────────────────────── Side state (dispatch.json) ─────────────────────────────

interface LastFailure {
  outputTail: string;
  digest?: FailureDigestOutput | null;
  antiCheat?: string[];
  frozenViolations?: string[];
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
}

interface ScratchData {
  units: Record<string, UnitScratch>;
  /** Gate C's full verification and the integration head it ran on. */
  finalVerify?: { ok: boolean; head: string };
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

  finalVerify(): ScratchData["finalVerify"] {
    return this.data.finalVerify;
  }

  setFinalVerify(value: NonNullable<ScratchData["finalVerify"]>): void {
    this.data.finalVerify = value;
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
