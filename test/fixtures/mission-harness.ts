// Test harness for the Dispatcher: a temporary Mission Control home and workspace, real git, a Verifier running
// `node --test`, and two MockRunners impersonating "claude" and "codex". Agent answers come from per-role handlers;
// the defaults build a tiny Node app whose features each add `src/<id>.mjs` exporting `answer()`. For a feature that is
// checked by reading (docs/modes-spec.md), the maker writes `docs/<id>.md` from the checks in its brief, the checker passes
// every check with a real quote and says it opened the file, and a fake picture tool takes the pictures.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig } from "../../src/config.js";
import { Dispatcher, type DispatcherDeps } from "../../src/dispatcher.js";
import { RoleExecutor } from "../../src/executor.js";
import { Git } from "../../src/git.js";
import type { Notifier, NotifyOptions } from "../../src/notify.js";
import { parsePlan } from "../../src/plan.js";
import { QuotaGovernor } from "../../src/quota.js";
import { pictureName, type RenderRequest, type RenderResult, type RenderedPage, type Renderer } from "../../src/render.js";
import { type MockBehavior, MockRunner, type MockScript } from "../../src/runners/mock.js";
import { MissionStore } from "../../src/state.js";
import type {
  AgentJob,
  BuildOutput,
  CheckpointKind,
  Clock,
  Config,
  DiagnosisOutput,
  Finding,
  GateOutput,
  InitOutput,
  Mission,
  MissionKind,
  OnboardOutput,
  PictureWhy,
  PlanSource,
  ReviewOutput,
  Role,
  RoleOverride,
  RubricOutput,
  RubricResult,
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

/**
 * What a handler returns: a MockBehavior, plus `opened`, the files the run says it opened. Only a run on the "claude"
 * runner reports it (the Claude stream does; Codex and the plain mock cannot tell), so the checker's answer can be
 * checked against it (docs/modes-spec.md 8.3, point 2).
 */
export type AgentBehavior = MockBehavior & { opened?: string[] };
export type AgentHandler = (job: AgentJob, call: AgentCallInfo) => AgentBehavior | Promise<AgentBehavior>;
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

// ───────────── Features that are checked by reading ─────────────

/** The job is a builder of a document, a page or a data file (the role prompt starts "# Role: maker"). */
export function isMaker(job: AgentJob): boolean {
  return job.systemPrompt.startsWith("# Role: maker");
}

/** The job is the second AI that judges a feature against its checks (the role prompt starts "# Role: checker"). */
export function isChecker(job: AgentJob): boolean {
  return job.systemPrompt.startsWith("# Role: checker");
}

/** The lines `1. ...`, `2. ...` that follow `heading` in a brief, without their numbers. */
function numberedAfter(prompt: string, heading: string): string[] {
  const lines = prompt.split("\n");
  const at = lines.findIndex((l) => l.trim() === heading);
  const out: string[] = [];
  for (let i = at + 1; at >= 0 && i < lines.length; i++) {
    const m = /^\d+\. (.*)$/.exec(lines[i] ?? "");
    if (!m) {
      if ((lines[i] ?? "").trim() === "" && out.length === 0) continue;
      break;
    }
    out.push(m[1] ?? "");
  }
  return out;
}

/** The checks in a maker's brief ("Checks the second AI will judge, one by one:") or in a checker's brief ("## Checks"). */
export function checksInBrief(prompt: string): string[] {
  const made = numberedAfter(prompt, "Checks the second AI will judge, one by one:");
  return made.length > 0 ? made : numberedAfter(prompt, "## Checks");
}

/** The paths under "## Changed files" in a checker's brief. */
export function changedFilesInBrief(prompt: string): string[] {
  const lines = prompt.split("\n");
  const at = lines.indexOf("## Changed files");
  const out: string[] = [];
  for (let i = at + 1; at >= 0 && i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) break;
    const m = /^- `(.+)`$/.exec(line);
    if (m) out.push(m[1] ?? "");
  }
  return out;
}

/** The path the default maker writes for feature `id`. */
export function deliverablePath(id: string): string {
  return `docs/${id}.md`;
}

/** The default maker: writes docs/<id>.md, a title and each check of the brief as a plain sentence of its own, then a line for each problem it was asked to fix. */
export function writeDeliverable(cwd: string, id: string, checks: string[], fixes: string[] = []): void {
  writeFile(cwd, deliverablePath(id), `# ${id}\n\n${checks.map((c) => `${c}\n`).join("\n")}${fixes.map((x) => `\nFixed: ${x}\n`).join("")}`);
}

/** The lines `1. ...` under "## Problems to fix" in a maker's brief, without their numbers. */
export function problemsInBrief(prompt: string): string[] {
  const lines = prompt.split("\n");
  const at = lines.indexOf("## Problems to fix");
  const out: string[] = [];
  for (let i = at + 1; at >= 0 && i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) break;
    const m = /^\d+\. (.*)$/.exec(line);
    if (m) out.push((m[1] ?? "").replace(/\*\*/g, ""));
  }
  return out;
}

export function makerBehavior(job: AgentJob, id: string): AgentBehavior {
  const checks = checksInBrief(job.prompt);
  const fixes = problemsInBrief(job.prompt);
  return { edit: (cwd) => writeDeliverable(cwd, id, checks, fixes), structured: buildOutput("made it") };
}

/** The absolute paths of the pictures a checker's brief offers (the lines `- <path>: <what it shows>` under "## Pictures"). */
export function picturesInBrief(prompt: string): string[] {
  const lines = prompt.split("\n");
  const at = lines.indexOf("## Pictures");
  const out: string[] = [];
  for (let i = at + 1; at >= 0 && i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) break;
    const m = /^- (.+?): .+$/.exec(line);
    if (m) out.push(m[1] ?? "");
  }
  return out;
}

/** The default checker's answer: every check passes, with the first words of the check as the quote, naming the first changed file it was given. */
export function checkerResults(job: AgentJob): RubricResult[] {
  const file = changedFilesInBrief(job.prompt)[0];
  return checksInBrief(job.prompt).map((check, i) => ({
    number: i + 1,
    check,
    result: "pass" as const,
    evidence: file ? `The file says “${check.slice(0, 60)}” in ${file}.` : `Read the files and found the proof for check ${i + 1}.`,
    basis: "text" as const,
  }));
}

/**
 * A checker's answer for `job`: by default every check passes. `tweak` changes the results before they are sent (for
 * example to fail check 2 or to make it `cannot_judge`). It opened the first changed file, and says so (`opened`, which
 * only a run on the "claude" runner reports); with `openPictures` it opened every picture the brief offers as well.
 */
export function checkerBehavior(job: AgentJob, tweak?: (results: RubricResult[], job: AgentJob) => void, opts: { openPictures?: boolean } = {}): AgentBehavior {
  const results = checkerResults(job);
  tweak?.(results, job);
  const file = changedFilesInBrief(job.prompt)[0];
  const pictures = opts.openPictures === true ? picturesInBrief(job.prompt).map((p) => (p.startsWith("/") ? p : join(job.cwd, p))) : [];
  const answer: RubricOutput = {
    verdict: results.every((r) => r.result === "pass") ? "approve" : "changes",
    results,
    seen: [...(file ? [file] : []), ...pictures],
    notes: [],
  };
  return { structured: answer, opened: [...(file ? [join(job.cwd, file)] : []), ...pictures] };
}

/** One byte-exact 1 by 1 PNG, so a "picture" is a real picture file. */
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export interface FakeRendererOptions {
  /** Nothing can be drawn, for this reason. */
  why?: PictureWhy;
  /** The visible text of a page (default: a sentence). */
  text?: (path: string) => string;
  /** The page is wider than a phone screen: always, or for the calls (counted from 1) this function says yes to. */
  sideways?: boolean | ((call: number) => boolean);
}

export type FakeRenderer = Renderer & { requests: RenderRequest[] };

/** A picture tool that needs no browser: it writes a tiny PNG for each page and width, and reports plausible facts. */
export function fakeRenderer(opts: FakeRendererOptions = {}): FakeRenderer {
  const requests: RenderRequest[] = [];
  return {
    requests,
    async render(request: RenderRequest): Promise<RenderResult> {
      requests.push(request);
      const wide = typeof opts.sideways === "function" ? opts.sideways(requests.length) : opts.sideways === true;
      if (opts.why !== undefined) return { pages: [], taken: 0, why: opts.why };
      mkdirSync(request.outDir, { recursive: true });
      let taken = 0;
      const pages: RenderedPage[] = request.pages.map((page) => {
        const facts = (width: number) => ({
          title: page.path,
          hasViewport: true,
          documentWidth: wide && width === 390 ? 900 : width,
          windowWidth: width,
          text: opts.text?.(page.path) ?? `The page ${page.path} shows a visible sentence.`,
          brokenImages: 0,
          failedRequests: [],
          errors: [],
        });
        const shot = (width: "phone" | "desktop") => {
          const file = join(request.outDir, pictureName(request.featureId, page.n, page.path, width));
          writeFileSync(file, PNG_1X1);
          taken++;
          return { width, file, facts: facts(width === "phone" ? 390 : 1280) };
        };
        return { path: page.path, n: page.n, phone: shot("phone"), desktop: shot("desktop") };
      });
      return { pages, taken };
    },
  };
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
    reviewer: (job, call) => {
      if (call.label === "gate-a") return { structured: { verdict: "approve", issues: [] } satisfies GateOutput };
      if (isChecker(job)) return checkerBehavior(job);
      return { structured: review() };
    },
    test_author: (_job, call) => ({
      edit: (cwd) => writeFeatureTest(cwd, call.feature ?? "unknown"),
      structured: { testFiles: [featureTestPath(call.feature ?? "unknown")], notes: "" } satisfies TestAuthorOutput,
    }),
    engineer: (job, call) => {
      if (call.label === "init") {
        return { edit: writeScaffold, structured: { summary: "scaffolded", verify: FIXTURE_VERIFY, notes: [] } satisfies InitOutput };
      }
      if (isMaker(job)) return makerBehavior(job, call.feature ?? "unknown");
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

/** The plan source `mc plan queue` stores for `text` (a plan in the line format); throws if the plan cannot be used. */
export function planSource(text: string): PlanSource {
  const parsed = parsePlan(text);
  if (!parsed.ok) throw new Error(`planSource: ${parsed.problems.join(" ")}`);
  return { spec: parsed.spec, sha256: parsed.sha256, at: "2026-10-12T09:00:00.000Z" };
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
  /** The picture tool. Default: `fakeRenderer()`. */
  renderer?: Renderer;
}

/** A mock runner that, like the Claude runner, reports the files a run opened (the plain mock cannot). */
class HarnessRunner extends MockRunner {
  constructor(
    script: MockScript,
    opts: { provider: "claude" | "codex" },
    private readonly openedBy: Map<string, string[]>,
  ) {
    super(script, opts);
  }

  override async run(...args: Parameters<MockRunner["run"]>): ReturnType<MockRunner["run"]> {
    const result = await super.run(...args);
    const opened = this.openedBy.get(args[0].id);
    return opened !== undefined && this.provider === "claude" ? { ...result, opened } : result;
  }
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
  /** The picture tool the dispatchers get (a fake: no browser is started). Replace it, or pass `renderer` in `run`'s extras. */
  renderer: Renderer;
  /** Every job either runner received, in call order. */
  readonly jobs: AgentJob[] = [];
  readonly notifications: Notification[] = [];
  readonly defaults: Required<AgentScript>;
  agents: AgentScript;
  private readonly labelCounts = new Map<string, number>();
  /** The files a run says it opened, by job id, for the runner that reports them. */
  private readonly openedBy = new Map<string, string[]>();
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
    this.renderer = opts.renderer ?? fakeRenderer();
    this.claude = new HarnessRunner((job) => this.route(job), { provider: "claude" }, this.openedBy);
    this.codex = new HarnessRunner((job) => this.route(job), { provider: "codex" }, this.openedBy);
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
      renderer: this.renderer,
      ...deps,
    });
    return dispatcher;
  }

  createMission(
    kind: MissionKind,
    init: {
      request?: string;
      repoPath?: string;
      baseBranch?: string;
      profile?: string;
      roleOverrides?: RoleOverride[];
      /** Where the owner looks before the mission goes on; absent = a mission that runs straight through. */
      checkpoints?: CheckpointKind[];
      /** A plan written outside the team (see `planSource`); the mission adopts it instead of asking the planner. */
      plan?: PlanSource;
      /** `false`: queued with `--no-owner-checkpoint`, so no stop for the owner's look at a feature the plan marks or the second AI could not judge. */
      ownerStops?: false;
    } = {},
  ): Mission {
    return this.store.createMission({
      kind,
      title: "Fixture app",
      request: init.request ?? "Build a tiny app that answers.",
      repoPath: init.repoPath ?? "",
      baseBranch: init.baseBranch ?? "main",
      profile: init.profile ?? this.config.defaultProfile,
      roleOverrides: init.roleOverrides,
      checkpoints: init.checkpoints,
      plan: init.plan,
      ownerStops: init.ownerStops,
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
    const behavior = handler(job, call);
    return behavior instanceof Promise ? behavior.then((b) => this.keepOpened(job, b)) : this.keepOpened(job, behavior);
  }

  private keepOpened(job: AgentJob, behavior: AgentBehavior): MockBehavior {
    const { opened, ...rest } = behavior;
    if (opened !== undefined) this.openedBy.set(job.id, opened);
    return rest;
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
