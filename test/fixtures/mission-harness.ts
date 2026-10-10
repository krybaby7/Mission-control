// Test harness for the Dispatcher: a temporary Mission Control home and workspace, real git, a Verifier running
// `node --test`, and two MockRunners impersonating "claude" and "codex". Agent answers come from per-role handlers;
// the defaults build a tiny Node app whose features each add `src/<id>.mjs` exporting `answer()`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig } from "../../src/config.js";
import { Dispatcher, type DispatcherDeps } from "../../src/dispatcher.js";
import { RoleExecutor } from "../../src/executor.js";
import { Git } from "../../src/git.js";
import type { Notifier, NotifyOptions } from "../../src/notify.js";
import { QuotaGovernor } from "../../src/quota.js";
import { type MockBehavior, MockRunner } from "../../src/runners/mock.js";
import { MissionStore } from "../../src/state.js";
import type {
  AgentJob,
  BuildOutput,
  Clock,
  Config,
  DiagnosisOutput,
  Finding,
  GateOutput,
  InitOutput,
  Mission,
  MissionKind,
  OnboardOutput,
  ReviewOutput,
  Role,
  RoleOverride,
  SpecFeature,
  SpecOutput,
  TestAuthorOutput,
  VerifyConfigOutput,
} from "../../src/types.js";
import { systemClock } from "../../src/util/clock.js";
import { nullLogger } from "../../src/util/logger.js";
import { Verifier } from "../../src/verify.js";

/**
 * The fixture app's verify config: plain `node --test`, no install step. The full run uses a glob because Node 22
 * treats a directory argument (`node --test tests/`) as a module to run, which always fails.
 */
export const FIXTURE_VERIFY: VerifyConfigOutput = {
  install: null,
  full: 'node --test "tests/**/*.test.mjs"',
  tests: "node --test {files}",
  testGlobs: ["tests/**"],
};

/** What a handler learns about the run besides the job. */
export interface AgentCallInfo {
  /** The executor label (job id without its "-<n>" suffix), e.g. "build-greet", "spec", "gate-c". */
  label: string;
  /** The feature id for per-feature labels ("test-", "build-", "fix-", "review-", "diagnose-", "context-", "digest-"). */
  feature?: string;
  /** How many runs used this label so far, this one included (counted across both runners). */
  n: number;
}

export type AgentHandler = (job: AgentJob, call: AgentCallInfo) => MockBehavior | Promise<MockBehavior>;
export type AgentScript = Partial<Record<Role, AgentHandler>>;

const FEATURE_LABELS = /^(?:test|build|fix|review|diagnose|context|digest)-(.+)$/;

export function feature(id: string, deps: string[] = [], kind: SpecFeature["kind"] = "standard"): SpecFeature {
  return {
    id,
    title: `Feature ${id}`,
    story: `As a user I want ${id}.`,
    acceptance: [`answer() in src/${id}.mjs returns "${id}"`],
    kind,
    deps,
  };
}

export function specOutput(features: SpecFeature[]): SpecOutput {
  return {
    appName: "Fixture App",
    summary: "A tiny app used by tests.",
    features,
    assumptions: ["Answers are plain strings."],
    uiContract: "Each feature module src/<id>.mjs exports answer().",
  };
}

// ───────────── Workspace edits the fake agents make ─────────────

export function writeFile(cwd: string, path: string, content: string): void {
  const file = join(cwd, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** The scaffold: app.mjs plus a passing smoke test. */
export function writeScaffold(cwd: string): void {
  writeFile(cwd, ".gitignore", "node_modules/\n");
  writeFile(cwd, "app.mjs", 'export const name = "fixture app";\n');
  writeFile(
    cwd,
    "tests/smoke.test.mjs",
    'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { name } from "../app.mjs";\n\ntest("the app has a name", () => {\n  assert.equal(name, "fixture app");\n});\n',
  );
}

export function featureTestPath(id: string): string {
  return `tests/${id}.test.mjs`;
}

/** A test that fails until src/<id>.mjs exports answer() returning `expected`. */
export function writeFeatureTest(cwd: string, id: string, expected = id): void {
  writeFile(
    cwd,
    featureTestPath(id),
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { answer } from "../src/${id}.mjs";\n\ntest("${id} gives its answer", () => {\n  assert.equal(answer(), ${JSON.stringify(expected)});\n});\n`,
  );
}

export function implementFeature(cwd: string, id: string, value = id): void {
  writeFile(cwd, `src/${id}.mjs`, `export function answer() {\n  return ${JSON.stringify(value)};\n}\n`);
}

// ───────────── Canned answers ─────────────

export function buildOutput(summary = "implemented", testDispute: BuildOutput["testDispute"] = null): BuildOutput {
  return { summary, filesChanged: [], testDispute, notes: "" };
}

export function review(findings: Finding[] = []): ReviewOutput {
  return { verdict: findings.some((f) => f.severity !== "minor") ? "changes" : "approve", findings };
}

export function finding(severity: Finding["severity"], description: string, file: string | null = null): Finding {
  return { severity, file, description, suggestedTest: null };
}

export function diagnosis(action: DiagnosisOutput["action"], hint: string, reason = ""): DiagnosisOutput {
  return { action, hint, reason };
}

/** Handlers that build the fixture app successfully, for `features` (the spec the architect returns). */
export function defaultAgents(features: SpecFeature[]): Required<AgentScript> {
  return {
    architect: (_job, call) => {
      if (call.label === "spec") return { structured: specOutput(features) };
      if (call.label === "onboard") {
        return { structured: { stackSummary: "Node ESM project tested with node --test.", verify: FIXTURE_VERIFY, notes: [] } satisfies OnboardOutput };
      }
      return { structured: diagnosis("retry_with_hint", "Return the feature id from answer().") };
    },
    reviewer: (_job, call) => {
      if (call.label === "gate-a") return { structured: { verdict: "approve", issues: [] } satisfies GateOutput };
      return { structured: review() };
    },
    test_author: (_job, call) => ({
      edit: (cwd) => writeFeatureTest(cwd, call.feature ?? "unknown"),
      structured: { testFiles: [featureTestPath(call.feature ?? "unknown")], notes: "" } satisfies TestAuthorOutput,
    }),
    engineer: (_job, call) => {
      if (call.label === "init") {
        return { edit: writeScaffold, structured: { summary: "scaffolded", verify: FIXTURE_VERIFY, notes: [] } satisfies InitOutput };
      }
      return { edit: (cwd) => implementFeature(cwd, call.feature ?? "unknown"), structured: buildOutput() };
    },
    scout: (_job, call) => {
      if (call.label === "report-prose") {
        return { structured: { narrative: "Tonight I built the fixture app.", whatYouCanDo: ["Ask each feature for its answer"] } };
      }
      if (call.label.startsWith("digest-")) {
        return { structured: { summary: "digest: the answer is wrong", likelyCause: "answer() returns the wrong value", failingTests: [] } };
      }
      return { structured: { files: [], notes: "" } };
    },
  };
}

// ───────────── Harness ─────────────

export interface Notification {
  title: string;
  message: string;
  opts?: NotifyOptions;
}

/** Dispatcher deps to override, plus the stop signal `mc run` would give the executor and the verifier. */
export type RunExtras = Partial<DispatcherDeps> & { signal?: AbortSignal };

export interface HarnessOptions {
  /** The spec the default architect returns. Default: greet, then farewell (which depends on greet). */
  features?: SpecFeature[];
  /** Handlers replacing the defaults, per role. */
  agents?: AgentScript;
  /** Tweaks applied to the test config (home and workspace are already temp dirs). */
  configure?: (c: Config) => void;
  clock?: Clock;
}

export class MissionHarness {
  readonly root = mkdtempSync(join(tmpdir(), "mc-dispatch-"));
  readonly home = join(this.root, "home");
  readonly workspace = join(this.root, "apps");
  readonly config: Config;
  readonly store: MissionStore;
  readonly git = new Git();
  readonly clock: Clock;
  readonly quota: QuotaGovernor;
  readonly claude: MockRunner;
  readonly codex: MockRunner;
  /** Every job either runner received, in call order. */
  readonly jobs: AgentJob[] = [];
  readonly notifications: Notification[] = [];
  readonly defaults: Required<AgentScript>;
  agents: AgentScript;
  private readonly labelCounts = new Map<string, number>();
  private readonly savedMcHome = process.env.MC_HOME;

  constructor(opts: HarnessOptions = {}) {
    process.env.MC_HOME = this.home;
    this.config = defaultConfig();
    this.config.home = this.home;
    this.config.workspaceRoot = this.workspace;
    opts.configure?.(this.config);
    this.store = new MissionStore(this.home);
    this.clock = opts.clock ?? systemClock;
    this.quota = new QuotaGovernor({ clock: this.clock, config: this.config });
    this.defaults = defaultAgents(opts.features ?? [feature("greet"), feature("farewell", ["greet"])]);
    this.agents = opts.agents ?? {};
    this.claude = new MockRunner((job) => this.route(job), { provider: "claude" });
    this.codex = new MockRunner((job) => this.route(job), { provider: "codex" });
  }

  /**
   * A fresh executor and dispatcher, as after a restart. `extra` overrides dispatcher deps; like `mc run`, its
   * `deadline` also bounds the executor, and `signal` (a stop) reaches the executor, the verifier and stopCheck.
   */
  dispatcher(extra: RunExtras = {}): Dispatcher {
    const { signal, ...deps } = extra;
    const stopCheck = () => signal?.aborted === true || this.store.stopRequested();
    let dispatcher: Dispatcher | undefined;
    const executor = new RoleExecutor({
      config: this.config,
      runners: { claude: this.claude, codex: this.codex },
      quota: this.quota,
      clock: this.clock,
      store: this.store,
      logger: nullLogger,
      signal,
      deadline: deps.deadline,
      stopCheck,
      onWaiting: (until, reason) => dispatcher?.onWaiting(until, reason),
    });
    const notifier: Notifier = {
      notify: async (title, message, opts) => {
        this.notifications.push({ title, message, opts });
      },
    };
    dispatcher = new Dispatcher({
      config: this.config,
      store: this.store,
      git: this.git,
      executor,
      quota: this.quota,
      clock: this.clock,
      logger: nullLogger,
      notifier,
      verifierFor: (id) => new Verifier({ logsDir: this.store.logsDir(id), timeoutMs: 60_000, signal }),
      stopCheck,
      ...deps,
    });
    return dispatcher;
  }

  createMission(
    kind: MissionKind,
    init: { request?: string; repoPath?: string; baseBranch?: string; profile?: string; roleOverrides?: RoleOverride[] } = {},
  ): Mission {
    return this.store.createMission({
      kind,
      title: "Fixture app",
      request: init.request ?? "Build a tiny app that answers.",
      repoPath: init.repoPath ?? "",
      baseBranch: init.baseBranch ?? "main",
      profile: init.profile ?? this.config.defaultProfile,
      roleOverrides: init.roleOverrides,
      nowMs: this.clock.now(),
    });
  }

  run(id: string, extra: RunExtras = {}): Promise<Mission> {
    return this.dispatcher(extra).runMission(id);
  }

  load(id: string): Mission {
    return this.store.load(id);
  }

  /** Jobs whose label (job id without "-<n>") is `label`. */
  jobsLabeled(label: string): AgentJob[] {
    return this.jobs.filter((j) => labelOf(j) === label);
  }

  jobsFor(role: Role): AgentJob[] {
    return this.jobs.filter((j) => j.role === role);
  }

  cleanup(): void {
    if (this.savedMcHome === undefined) delete process.env.MC_HOME;
    else process.env.MC_HOME = this.savedMcHome;
    rmSync(this.root, { recursive: true, force: true });
  }

  private route(job: AgentJob): MockBehavior | Promise<MockBehavior> {
    this.jobs.push(job);
    const label = labelOf(job);
    const n = (this.labelCounts.get(label) ?? 0) + 1;
    this.labelCounts.set(label, n);
    const call: AgentCallInfo = { label, n, feature: FEATURE_LABELS.exec(label)?.[1] };
    const handler = this.agents[job.role] ?? this.defaults[job.role];
    return handler(job, call);
  }
}

export function labelOf(job: AgentJob): string {
  return job.id.replace(/-\d+$/, "");
}

/** An existing project for feature missions: lib.mjs with a test that passes (or fails, when `broken`). */
export async function createFixtureRepo(git: Git, dir: string, opts: { broken?: boolean } = {}): Promise<void> {
  await git.ensureRepo(dir);
  writeFile(dir, ".gitignore", "node_modules/\n");
  writeFile(dir, "lib.mjs", "export const ready = true;\n");
  writeFile(
    dir,
    "tests/lib.test.mjs",
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { ready } from "../lib.mjs";\n\ntest("lib is ready", () => {\n  assert.equal(ready, ${opts.broken ? "false" : "true"});\n});\n`,
  );
  await git.commitAll(dir, "existing project");
}
