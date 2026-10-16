// Shared contracts for Mission Control.
// Every module codes against these types. Change them only through the integrator.

// ───────────────────────────── Providers, models, roles ─────────────────────────────

/** The CLI that executes an agent run. "mock" is a scripted test double. */
export type Provider = "claude" | "codex" | "mock";

/** A model family. Profiles assign a family to each role. */
export type Family = "claude" | "codex";

/** Capability tier. `light` is always Haiku 5.5 (Claude), regardless of family. */
export type Tier = "frontier" | "standard" | "light";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Role =
  | "architect" // spec, gates, diagnosis
  | "engineer" // initializer + feature builds
  | "test_author" // writes frozen acceptance tests before the build
  | "reviewer" // read-only review of a diff
  | "scout"; // one-shot light-tier helper functions (context pack, failure digest, report prose)

export type Access = "read-only" | "workspace-write";

export interface ModelRef {
  provider: Provider;
  model: string;
}

/** Minimal JSON Schema type. Schemas must be "strict-compatible" (see docs/mvp-spec.md §Schemas). */
export type JsonSchema = Record<string, unknown>;

// ───────────────────────────── Agent runs ─────────────────────────────

export interface AgentJob {
  /** Unique id for this run, used in log file names and events. */
  id: string;
  role: Role;
  provider: Provider;
  model: string;
  effort: Effort;
  /** Working directory (a git worktree or the mission repo). */
  cwd: string;
  /** Provider-neutral role instructions. Claude: --append-system-prompt. Codex: prepended to the prompt. */
  systemPrompt: string;
  /** The task brief. */
  prompt: string;
  /** When set, the final answer must be JSON matching this schema; RunResult.structured carries it. */
  outputSchema?: JsonSchema;
  access: Access;
  /** Disable all tools (pure one-shot function call). Only meaningful with access "read-only". */
  noTools?: boolean;
  limits: { maxTurns: number; timeoutMs: number };
  resumeSessionId?: string;
  /** If set, the raw provider stdout stream (NDJSON) is appended here. */
  logFile?: string;
  /**
   * Extra folders a read-only run may open files from (Claude: one `--add-dir` each). It lets the second AI open pictures
   * that live outside its working folder. Absent = none. Runners that cannot use it (Codex, the mock) ignore it.
   */
  readDirs?: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Provider's own cost estimate in USD (Claude reports list-price estimates even on subscriptions). */
  estCostUsd?: number;
  turns?: number;
}

export type LimitKind =
  | "session" // 5-hour window
  | "weekly" // 7-day window
  | "model" // model-specific weekly bucket (e.g. seven_day_opus)
  | "spend" // extra-usage / overage cap
  | "throttle" // transient 429/overload that the CLI could not absorb
  | "unknown";

export interface LimitInfo {
  provider: Provider;
  kind: LimitKind;
  /** Epoch milliseconds when the limit resets, if known. */
  resetsAt?: number;
  /** For kind "model": the model the limit applies to, if known. */
  model?: string;
  /** The raw text or JSON that triggered detection (for the logs and report). */
  raw: string;
}

/** Usage-window telemetry reported by a provider (Claude rate_limit_event, Codex app-server). */
export interface Utilization {
  provider: Provider;
  /** e.g. "five_hour", "seven_day", "seven_day_opus". */
  window: string;
  /** 0..1 (may exceed 1 when running into overage). */
  utilization: number;
  /** Epoch milliseconds. */
  resetsAt?: number;
}

export type RunEvent =
  | { type: "started"; sessionId?: string }
  | { type: "progress"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "limit"; info: LimitInfo }
  | { type: "utilization"; info: Utilization };

export type RunOutcome =
  | "ok" // finished; if outputSchema was given, structured is present and valid
  | "failed" // the agent finished but reported an error / invalid output / max turns
  | "limited" // a usage limit stopped the run (see RunResult.limit)
  | "timeout" // wall-clock limit hit, process killed
  | "aborted" // AbortSignal fired (STOP file, shutdown)
  | "auth" // not logged in / 401: needs a human to re-login
  | "crashed"; // CLI missing, spawn failure, unparseable stream, non-zero exit without a result

export interface RunResult {
  outcome: RunOutcome;
  /** Final assistant text (may be empty). */
  text: string;
  /** Parsed final JSON when outputSchema was given and validation passed. */
  structured?: unknown;
  sessionId?: string;
  usage: Usage;
  limit?: LimitInfo;
  /** Human-readable reason when outcome !== "ok". */
  error?: string;
  durationMs: number;
  exitCode: number | null;
  /**
   * Claude runs: the `file_path` of each `Read` tool call the run made, at most 200 paths of at most 300 characters each.
   * Absent when the run opened nothing or the runner cannot tell (Codex, the mock), so an old result is unchanged.
   */
  opened?: string[];
}

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

export interface AgentRunner {
  readonly provider: Provider;
  run(job: AgentJob, opts?: RunOptions): Promise<RunResult>;
}

// ───────────────────────────── Configuration ─────────────────────────────

export interface FamilyModels {
  provider: Provider; // "claude" for the claude family, "codex" for codex (tests may use "mock")
  frontier: string; // claude-opus-5-5 | gpt-6-astra
  standard: string; // claude-sonnet-5-5 | gpt-6.1-sol
}

/** A role's family assignment: a concrete family, or "other" = the family NOT used by the engineer of the unit. */
export type FamilyChoice = Family | "other";

export interface Profile {
  architect: Family;
  engineer: Family;
  test_author: FamilyChoice;
  reviewer: FamilyChoice;
  /** When false, "other" resolves to the same family and ladder rungs with family "other" stay on the same family. */
  crossFamily: boolean;
}

export type Rung =
  | { action: "build"; tier: Tier; effort: Effort; family: "same" | "other" }
  | { action: "diagnose" };

export interface RoleSettings {
  tier: Tier;
  effort: Effort;
}

export interface Config {
  version: 1;
  /** Directory where new app repositories are created (supports ~). */
  workspaceRoot: string;
  /** Mission Control home: missions, logs, reports, STOP file (supports ~). */
  home: string;
  families: Record<Family, FamilyModels>;
  /** The light tier model used for ALL light work (Haiku 5.5). */
  light: ModelRef;
  /** Guard: every configured model must be in this list (user rule: no Luna). */
  allowedModels: string[];
  defaultProfile: string;
  profiles: Record<string, Profile>;
  /** Escalation ladders. Index 0 is the first attempt. */
  ladders: { standard: Rung[]; mechanical: Rung[] };
  /** Tier/effort for the non-engineer roles. */
  roles: {
    architect: RoleSettings;
    test_author: RoleSettings;
    reviewer: RoleSettings;
    scout: RoleSettings;
  };
  limits: {
    /** Max agent turns per build attempt. */
    buildMaxTurns: number;
    /** Max agent turns for other roles. */
    otherMaxTurns: number;
    /** Wall-clock timeout per agent run. */
    agentTimeoutMs: number;
    /** Timeout for one verify command run. */
    verifyTimeoutMs: number;
    /** Max reviewer→fix rounds per feature. */
    maxReviewRounds: number;
    /** Max gate C fix rounds per mission. */
    maxGateCRounds: number;
    /** Hard cap on agent runs per mission (runaway guard). */
    maxAgentRunsPerMission: number;
  };
  failover: {
    /** When a family's provider is limited, run its roles on the other family. */
    enabled: boolean;
  };
  pacing: {
    /** Don't START new work on a provider whose 5-hour utilization is above this (0..1). */
    maxFiveHourUtilization: number;
    /** Don't START new work on a provider whose 7-day utilization is above this (0..1). */
    maxWeeklyUtilization: number;
    /**
     * Don't START new work on a provider once its 7-day utilization has grown by this much (0..1) since this
     * run first read it, leaving the rest of the week for the user. Unset: no per-run cap. (The setting's name keeps
     * its older word, "Night": it is a stable setting.)
     */
    maxWeeklySharePerNight?: number;
  };
  notify: {
    /** e.g. https://ntfy.sh/my-secret-topic ; empty = disabled. */
    ntfyUrl?: string;
  };
  git: {
    /** Push the mission branch to "origin" when done (only mc/* branches, never force). */
    push: boolean;
    branchPrefix: string; // "mc"
  };
  permissions: {
    /** Claude permission mode for workspace-write runs. bypassPermissions only inside a container as non-root. */
    claudeWriteMode: "bypassPermissions" | "acceptEdits" | "auto";
    /** Codex sandbox for workspace-write runs. danger-full-access only inside a container. */
    codexWriteSandbox: "danger-full-access" | "workspace-write";
    /** When true and not running inside a container (MC_IN_CONTAINER=1 or /.dockerenv), bypass/danger modes are
     *  downgraded to claude "auto" and codex "workspace-write" (+network) with a warning. */
    requireContainerForBypass: boolean;
  };
  /** Pinned CLI versions; `mc doctor` warns on mismatch. */
  cli: {
    claudeCommand: string; // "claude"
    codexCommand: string; // "codex"
    claudeVersion?: string;
    codexVersion?: string;
  };
}

/** Per-run role override from the CLI: `--role engineer=codex:frontier`. */
export interface RoleOverride {
  role: Role;
  family?: Family;
  tier?: Tier;
  effort?: Effort;
}

// ───────────────────────────── Missions ─────────────────────────────

export type MissionKind = "greenfield" | "feature";

export type MissionStatus =
  | "queued"
  | "running"
  | "waiting" // all needed providers limited; sleeping until reset
  | "done" // every feature done and gate C passed
  | "partial" // finished the run but some features blocked
  | "stopped" // STOP file / deadline
  | "failed"; // unrecoverable error (e.g. auth on every provider, init never went green)

export type Stage = "onboard" | "spec" | "gate_a" | "init" | "features" | "gate_c" | "finalize" | "complete";

export interface SpecFeature {
  /** kebab-case, unique within the mission, e.g. "add-todo". */
  id: string;
  title: string;
  /** Plain-language user story. */
  story: string;
  /** Concrete, testable acceptance criteria. */
  acceptance: string[];
  /** "mechanical" = narrow/boilerplate work suited to the light tier first. */
  kind: "standard" | "mechanical";
  /** ids of features that must be done first. */
  deps: string[];
  /**
   * How the feature is checked when tests do not do it. Absent = by tests, written first (today's way). Only "review"
   * and "owner" are ever stored; a plan that says `mode: tests` leaves the field out. "owner" also stops for the owner's look.
   */
  mode?: "review" | "owner";
  /** How hard the team thinks about the feature. Absent = standard. Only "light" and "deep" are ever stored. */
  effort?: "light" | "deep";
  /** Checks that Mission Control's own script runs on the files of a "review" or "owner" feature. Never present on a tests feature. */
  expect?: FeatureExpect;
}

/** The script-checked parts of a plan feature (docs/modes-spec.md 4.1). Plain words and numbers only: nothing here is a path or a command. */
export interface FeatureExpect {
  /** Headings the text must have, 0 to 12, each 1 to 80 characters. */
  headings?: string[];
  /** Words or names the visible text must contain, written exactly, 0 to 12, each 1 to 80 characters. */
  mentions?: string[];
  /** How many words the feature adds, [first, second]: 1 <= first <= second <= 99999. */
  words?: [number, number];
  /** The column names of a table, in order, 1 to 30, all different, each 1 to 40 characters. */
  columns?: string[];
  /** How many data rows a table has, [first, second]: 0 <= first <= second <= 999999. */
  rows?: [number, number];
}

export interface Spec {
  appName: string;
  /** Plain-language summary for a non-programmer. */
  summary: string;
  features: SpecFeature[];
  /** Decisions the architect made on the user's behalf (shown in the report). */
  assumptions: string[];
  /** UI conventions test authors and engineers must share (labels, routes, test ids). */
  uiContract: string;
}

export type FeatureStatus = "pending" | "testing" | "building" | "reviewing" | "done" | "blocked" | "skipped";

export interface Finding {
  severity: "blocker" | "major" | "minor";
  file: string | null;
  description: string;
  suggestedTest: string | null;
}

export interface Attempt {
  rung: number;
  action: "build" | "diagnose" | "fix";
  provider: Provider;
  model: string;
  effort: Effort;
  outcome: "pass" | "fail" | "limited" | "error";
  /** Verify failure signature (sha1 of normalized failing output). */
  signature?: string;
  summary: string;
  at: string; // ISO time
  usage?: Usage;
}

export interface FrozenFile {
  path: string; // repo-relative, forward slashes
  sha256: string;
}

export interface Feature extends SpecFeature {
  status: FeatureStatus;
  /** Index into the ladder for the next build attempt. */
  rung: number;
  attempts: Attempt[];
  frozenTests: FrozenFile[];
  /** Branch and worktree of the in-progress unit (cleared after merge/block). */
  branch?: string;
  worktree?: string;
  /** Hint from a diagnosis rung, passed to later rungs. */
  hint?: string;
  reviewRounds: number;
  /** Non-blocking findings left after review (go to the report). */
  openFindings: Finding[];
  blockedReason?: string;
  /** Integration commit after merge. */
  commit?: string;
  /** Family of the engineer that built the merged version (drives "other" reviewer). */
  builtBy?: Family;
  /** Commit in the unit branch that contains the frozen acceptance tests (reset target after a diagnosis). */
  testsCommit?: string;
  /** Last commit in the unit branch that passed verification (fallback if a review fix breaks things). */
  passingCommit?: string;
  /** Only a "review" or "owner" feature: what the second AI and Mission Control's own script found at the last check. Saved after every answer of the second AI. */
  checked?: FeatureChecked;
  /**
   * Only the repair that the final review adds (`gate-c-fix-N`), and only when it changed a file of work the owner approved: the ids of those
   * features. The owner then looks at the repair before it is added, because nothing else ties the new text to the approval they gave.
   * Absent when the repair touched no approved file. Set at the repair's own review, again after every change of it.
   */
  changesApproved?: string[];
}

/** One verdict of the second AI on one written check. "cannot_judge" is never a pass. */
export type CheckResult = "pass" | "fail" | "cannot_judge";

/** What a verdict rests on: the words of the files, or a picture the second AI opened. */
export type CheckBasis = "text" | "picture";

/** Why no picture was taken (docs/modes-spec.md 7.3), as a short code. The sentence for each is written by whoever shows it. */
export type PictureWhy = "no_tool" | "no_browser" | "start_failed" | "too_slow" | "reviewer" | "not_plain_file";

/** The second AI's verdict on one check, as stored on the feature (the check's own text is `acceptance[n - 1]`). */
export interface CheckedResult {
  /** The number of the check in the list, from 1. */
  n: number;
  result: CheckResult;
  /** AI-written text: control characters removed, at most 300 characters. Show it only through `shown()`. */
  evidence: string;
  basis: CheckBasis;
}

/** The record of the last check of a "review" or "owner" feature (docs/modes-spec.md 8.3, point 8). Absent until the second AI has been asked. */
export interface FeatureChecked {
  /** How many times the second AI has answered for this feature, counted from 1. */
  round: number;
  /** The family that really answered the last time (after any failover). When it never answered: the family it was asked on. */
  reviewer: Family;
  /** One entry per check, in order, after the engine's own corrections. Empty when `unfinished` is set. */
  results: CheckedResult[];
  /** How many checks nobody judged (`cannot_judge`). With `unfinished`, every check. */
  unjudged: number;
  /** True only when the answer of the second AI was unusable twice, or it did not run: the review did not finish. Left out otherwise. */
  unfinished?: true;
  /** What Mission Control's own script found in the last attempt: the problems left (at most 10, each at most 200 characters) and the facts. */
  scripted: { problems: string[]; facts: string[] };
  /**
   * The files the feature changed that the second AI could read (repo-relative, at most 10, each at most 200 characters). The report names
   * them when it tells the owner what to open: a guide or a page is read by opening its file, not by running the app. Absent when there
   * were none, and in a mission file written before this key existed.
   */
  files?: string[];
  /**
   * The pictures of the page as it first loads (`taken`). `why` is set only when none were taken and a page was expected.
   * `images` is the number of changed raster images that were copied for the owner and given to the second AI; it is left out
   * when there were none or the second AI was not given them.
   */
  pictures: { taken: number; images?: number; why?: PictureWhy };
}

export interface VerifyConfig {
  /** Install dependencies (run once per worktree before verifying), e.g. "npm ci". */
  install?: string;
  /** Full verification: lint + typecheck + unit + e2e. Must exit 0 when green. */
  full: string;
  /** Run specific test files; "{files}" is replaced by space-separated repo-relative paths. */
  tests?: string;
  /** Globs (repo-relative) that identify test files, e.g. ["tests/**", "e2e/**", "**\/*.test.ts"]. */
  testGlobs: string[];
}

export interface VerifyResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Last ~200 lines of combined output, ANSI stripped. */
  outputTail: string;
  /** Stable hash of the normalized failure (empty string when ok). */
  signature: string;
  /** Full output log path. */
  logFile: string;
}

export interface Mission {
  id: string; // e.g. "2026-10-09-habit-tracker"
  kind: MissionKind;
  title: string;
  /** The user's original request, verbatim. */
  request: string;
  /** Absolute path to the app repository. */
  repoPath: string;
  /** Branch the mission started from (feature missions) or "main" (greenfield). */
  baseBranch: string;
  /** mc/<mission-id> — all merged work lands here. */
  integrationBranch: string;
  /** Worktree (outside the repo) where the integration branch is checked out; units merge here. */
  integrationWorktree?: string;
  /** Commit the mission started from (initial commit for greenfield, baseBranch head for feature missions). */
  baseSha?: string;
  profile: string;
  roleOverrides: RoleOverride[];
  status: MissionStatus;
  stage: Stage;
  createdAt: string;
  updatedAt: string;
  spec?: Spec;
  features: Feature[];
  /** Feature missions: full verification already failed before we started. Gating then uses only feature tests. */
  baselineBroken: boolean;
  /** Short description of pre-existing failures (feature missions); never blamed on us. */
  baselineFailures: string[];
  verify?: VerifyConfig;
  /** Plain-language questions/decisions for the human (shown in the report). */
  decisionsNeeded: string[];
  gateCRounds: number;
  agentRuns: number;
  /** Free-form operator notes appended by the dispatcher (shown in report). */
  notes: string[];
  /**
   * Set while the mission is "failed": the note and the decision that failure added (both removed again when the
   * mission runs again), and whether a plain `mc run` retries it by itself (an expired login, which the owner fixes
   * outside Mission Control). Absent on missions saved before it existed, and on missions that never failed.
   */
  failure?: MissionFailure;
  /** Where the owner asked to look before the mission goes on (chosen when queued). Absent = none: the mission runs straight through. */
  checkpoints?: CheckpointKind[];
  /** Present only while the mission is parked for the owner's look (`status` is "stopped") or answered and not yet continued. */
  checkpoint?: PendingCheckpoint;
  /** Finished checkpoints, newest last, at most 50. A scope is passed when this holds an "approve" entry for it. */
  checkpointLog?: CheckpointRecord[];
  /** Set only when the plan was handed in with `mc plan queue` (written outside the team, by the leader). Absent = the team's planner writes it. */
  plan?: PlanSource;
  /**
   * Set only to `false`, and only when the owner queued a plan with a "review" or "owner" feature using `--no-owner-checkpoint`:
   * the team does not stop for the owner's look at those features. Absent = it stops. A plan file can never set it.
   */
  ownerStops?: false;
}

/** A plan written outside the team: what the team adopts instead of calling its own planner, and how it was received. */
export interface PlanSource {
  /** The plan as the leader wrote it. `Mission.spec` is the plan the team works from (the same, or a revision). */
  spec: SpecOutput;
  /** Hex SHA-256 of the plan in its fixed written form (src/plan.ts canonicalText); its first 8 characters are the plan code. */
  sha256: string;
  at: string; // ISO
  /** What the team's plan reviewer (gate A) did with it; absent until gate A has run. */
  review?: PlanReview;
}

/** The outcome of gate A for a plan from outside: it asked for no change, its change was made, its change could not be made, or it did not answer. */
export interface PlanReview {
  outcome: "approved" | "revised" | "not_applied" | "unfinished";
  /** What the reviewer asked for (empty unless it asked for changes). */
  issues: string[];
}

/** Where the owner looks: before building (plan), before one feature is added (feature), before finishing (final). */
export type CheckpointKind = "plan" | "feature" | "final";

/** What the owner is shown. Plain text; lines that come from AI output are cleaned by whoever displays them. */
export interface CheckpointLook {
  headline: string;
  lines: string[];
  /** feature/final: the branch to open. */
  branch?: string;
  /** feature: the checked commit (short sha). */
  commit?: string;
  /** feature/final: changed files, at most 10. */
  files?: string[];
  /** final: paths under the mission folder, for example "screenshots/home.png". */
  screenshots?: string[];
}

export interface CheckpointAnswer {
  decision: "approve" | "send_back";
  /** Owner text, at most 2000 characters, control characters removed. Required for send_back. No AI reads it. */
  note?: string;
  at: string; // ISO
}

export interface PendingCheckpoint {
  /** "<scope>#<round>", for example "feature:add-shout#2". */
  id: string;
  /** "plan" | "feature:<feature id>" | "final". */
  scope: string;
  kind: CheckpointKind;
  featureId?: string;
  /** 1-based: how many times this scope has been shown. */
  round: number;
  state: "pending" | "answered";
  parkedAt: string; // ISO
  /** Set once the phone notice went out. */
  notifiedAt?: string;
  look: CheckpointLook;
  answer?: CheckpointAnswer;
  /** Fingerprint of what a send-back changes (spec hash, passing commit, or owner-change feature id): a resume skips rework that already happened. */
  reworkFrom?: string;
}

export interface CheckpointRecord {
  id: string;
  scope: string;
  kind: CheckpointKind;
  featureId?: string;
  round: number;
  decision: "approve" | "send_back";
  note?: string;
  at: string; // ISO
}

export interface MissionFailure {
  /** The note the failure added to `notes`. */
  reason: string;
  /** The entry the failure added to `decisionsNeeded`, if any. */
  decision?: string;
  /** A plain `mc run` picks the mission up again (only `mc run --mission <id>` does otherwise). */
  retryable: boolean;
}

/** One line in <home>/missions/<id>/events.jsonl. */
export interface MissionEvent {
  at: string; // ISO
  missionId: string;
  type: string; // e.g. "stage", "run.start", "run.end", "verify", "limit", "feature.status", "error"
  data: Record<string, unknown>;
}

/** One line in <home>/usage.jsonl (global ledger across missions). */
export interface UsageRecord {
  at: string;
  missionId: string;
  role: Role;
  provider: Provider;
  model: string;
  effort: Effort;
  outcome: RunOutcome;
  durationMs: number;
  usage: Usage;
}

// ───────────────────────────── Structured agent outputs ─────────────────────────────
// Each has a matching JSON Schema in src/schemas.ts. Optional values are `T | null`
// (strict schemas require every key to be present).

export interface SpecOutput {
  appName: string;
  summary: string;
  features: SpecFeature[];
  assumptions: string[];
  uiContract: string;
}

export interface GateOutput {
  verdict: "approve" | "revise";
  issues: string[];
}

/** A verify config as agents return it: strict schemas express optional commands as null.
 *  Convert with normalizeVerifyConfig (src/schemas.ts) before storing it as Mission.verify. */
export interface VerifyConfigOutput {
  install: string | null;
  full: string;
  tests: string | null;
  testGlobs: string[];
}

export interface OnboardOutput {
  stackSummary: string;
  verify: VerifyConfigOutput;
  notes: string[];
}

export interface InitOutput {
  summary: string;
  verify: VerifyConfigOutput;
  notes: string[];
}

export interface TestAuthorOutput {
  /** Repo-relative paths of the test files written for this feature. */
  testFiles: string[];
  notes: string;
}

export interface BuildOutput {
  summary: string;
  filesChanged: string[];
  /** Set when the engineer believes a frozen test is wrong/impossible. */
  testDispute: { file: string; reason: string } | null;
  notes: string;
}

export interface ReviewOutput {
  verdict: "approve" | "changes";
  findings: Finding[];
}

/** The second AI's answer for a "review" or "owner" feature: a verdict on every written check (SCHEMAS.rubric, docs/modes-spec.md 8.3). The engine checks it and recomputes the verdict. */
export interface RubricOutput {
  verdict: "approve" | "changes";
  results: RubricResult[];
  /** The files and pictures the AI says it opened, as the brief names them. */
  seen: string[];
  /** Problems outside the list that would mislead or hurt a reader. */
  notes: RubricNote[];
}

export interface RubricResult {
  /** The number of the check in the list, from 1. */
  number: number;
  /** The check, copied from the list. */
  check: string;
  result: CheckResult;
  evidence: string;
  basis: CheckBasis;
}

export interface RubricNote {
  severity: "major" | "minor";
  file: string | null;
  description: string;
}

export interface DiagnosisOutput {
  action: "retry_with_hint" | "amend_tests" | "block";
  /** Root-cause analysis + concrete guidance for the next engineer. */
  hint: string;
  /** For amend_tests: why the frozen tests are wrong. The dispatcher re-runs the test author. */
  reason: string;
}

export interface ContextPackOutput {
  files: { path: string; why: string }[];
  notes: string;
}

export interface FailureDigestOutput {
  summary: string;
  likelyCause: string;
  failingTests: string[];
}

export interface ReportProseOutput {
  /** 3–8 sentence plain-language narrative of the work for a non-programmer. */
  narrative: string;
  /** Plain-language bullet list of what the user can now do in the app. */
  whatYouCanDo: string[];
}

// ───────────────────────────── Service interfaces (dependency injection) ─────────────────────────────

export interface Clock {
  now(): number; // epoch ms
  /** Resolves after ms, or early (rejecting with an AbortError) when signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}
