// End-to-end test world: a temporary Mission Control home and workspace, real git, real `node --test` verification,
// and two scripted MockRunners impersonating the "claude" and "codex" CLIs. Missions run through the public
// entry point `runNight` (what `mc run` calls), so the run lock, STOP handling, the deadline, the quota file, the
// night summary and notifications are all exercised.
//
// The fake agents build a tiny Node app: each feature `<id>` lives in `src/<id>.mjs` and exports `run()`, which must
// return "<id> works". The test author writes `tests/<id>.test.mjs` asserting exactly that.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { Git } from "../src/git.js";
import { type NightOptions, type NightResult, runNight } from "../src/run.js";
import { type MockBehavior, MockRunner } from "../src/runners/mock.js";
import { MissionStore } from "../src/state.js";
import type {
  AgentJob,
  BuildOutput,
  CheckpointKind,
  Clock,
  Config,
  ContextPackOutput,
  DiagnosisOutput,
  FailureDigestOutput,
  Finding,
  GateOutput,
  InitOutput,
  Mission,
  MissionEvent,
  OnboardOutput,
  ReportProseOutput,
  ReviewOutput,
  Role,
  SpecFeature,
  SpecOutput,
  TestAuthorOutput,
  UsageRecord,
  VerifyConfigOutput,
} from "../src/types.js";
import { FakeClock } from "../src/util/clock.js";

export const OPUS = "claude-opus-5-5";
export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";
export const ASTRA = "gpt-6-astra";
export const SOL = "gpt-6.1-sol";
export const MIN = 60_000;
export const HOUR = 60 * MIN;
/** The executor waits this long past a limit's reset before trying again (src/executor.ts). */
export const WAIT_MARGIN_MS = 45_000;
export const NTFY_URL = "https://ntfy.invalid/mc-e2e-topic";

/**
 * The fixture app's verify config. Node 22 treats `node --test tests/` as a module path (always failing), so the
 * full run uses a glob, which `node --test` expands itself.
 */
export const APP_VERIFY: VerifyConfigOutput = {
  install: null,
  full: 'node --test "tests/**/*.test.mjs"',
  tests: "node --test {files}",
  testGlobs: ["tests/**"],
};

/** 23:00 local time on 2026-10-10: a typical start of the night. */
export function eveningOf(day = 10, hour = 23, minute = 0): number {
  return new Date(2026, 9, day, hour, minute, 0, 0).getTime();
}

// ───────────────────────────── The fixture app ─────────────────────────────

export function spec(id: string, deps: string[] = [], kind: SpecFeature["kind"] = "standard"): SpecFeature {
  return {
    id,
    title: `Feature ${id}`,
    story: `As a user I want ${id} to work.`,
    acceptance: [`run() in src/${id}.mjs returns "${id} works"`],
    kind,
    deps,
  };
}

export function writeIn(cwd: string, path: string, content: string): void {
  const file = join(cwd, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function testPath(id: string): string {
  return `tests/${id}.test.mjs`;
}

export function acceptanceTest(id: string): string {
  return [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    `import { run } from "../src/${id}.mjs";`,
    "",
    `test("${id} works", () => {`,
    `  assert.equal(run(), ${JSON.stringify(`${id} works`)});`,
    "});",
    "",
  ].join("\n");
}

/** A test that passes whatever the code does: what a cheating engineer would like the frozen test to be. */
export function vacuousTest(id: string): string {
  return `import test from "node:test";\n\ntest("${id} works", () => {});\n`;
}

export function implement(cwd: string, id: string, value = `${id} works`): void {
  writeIn(cwd, `src/${id}.mjs`, `export function run() {\n  return ${JSON.stringify(value)};\n}\n`);
}

export const SMOKE_TEST =
  'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { name } from "../app.mjs";\n\ntest("the app has a name", () => {\n  assert.equal(name, "fixture app");\n});\n';

export function scaffold(cwd: string): void {
  writeIn(cwd, ".gitignore", "node_modules/\n");
  writeIn(cwd, "app.mjs", 'export const name = "fixture app";\n');
  writeIn(cwd, "AGENTS.md", "# Fixture app\n\nRun the checks with `node --test`.\n");
  writeIn(cwd, "tests/smoke.test.mjs", SMOKE_TEST);
}

/** An existing project for feature missions: lib.mjs plus a test of it, already failing when `broken`. */
export async function existingProject(dir: string, opts: { broken?: boolean } = {}): Promise<string> {
  const git = new Git();
  await git.ensureRepo(dir);
  writeIn(dir, ".gitignore", "node_modules/\n");
  writeIn(dir, "lib.mjs", "export const ready = true;\n");
  writeIn(
    dir,
    "tests/lib.test.mjs",
    `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { ready } from "../lib.mjs";\n\ntest("lib is ready", () => {\n  assert.equal(ready, ${opts.broken ? "false" : "true"});\n});\n`,
  );
  await git.commitAll(dir, "existing project");
  return git.headSha(dir, "main");
}

// ───────────────────────────── Canned agent answers ─────────────────────────────

export function specOutput(features: SpecFeature[]): SpecOutput {
  return {
    appName: "Fixture App",
    summary: "A tiny app whose features each say that they work.",
    features,
    assumptions: ["Every feature answers with a short sentence."],
    uiContract: "Feature <id> lives in src/<id>.mjs and exports run().",
  };
}

export function built(summary = "implemented it", testDispute: BuildOutput["testDispute"] = null): BuildOutput {
  return { summary, filesChanged: [], testDispute, notes: "" };
}

export function verdict(findings: Finding[] = []): ReviewOutput {
  return { verdict: findings.some((f) => f.severity !== "minor") ? "changes" : "approve", findings };
}

export function diagnosis(action: DiagnosisOutput["action"], hint: string, reason = ""): DiagnosisOutput {
  return { action, hint, reason };
}

export const PROSE: ReportProseOutput = {
  narrative: "Overnight I built your fixture app, and every part of it now says that it works.",
  whatYouCanDo: ["Ask any feature whether it works"],
};

// ───────────────────────────── Scripted agents ─────────────────────────────

/** What a handler learns about a run besides its job. */
export interface Call {
  /** The executor label: the job id without its "-<n>" suffix, e.g. "build-greet", "spec", "gate-c". */
  label: string;
  /** The feature id for per-feature labels (test-, build-, fix-, review-, diagnose-, context-, digest-). */
  feature?: string;
  /** Runs of this label so far, this one included, across both runners and every night of the world. */
  n: number;
}

export type Handler = (job: AgentJob, call: Call) => MockBehavior | Promise<MockBehavior>;

const FEATURE_LABEL = /^(?:test|build|fix|review|diagnose|context|digest)-(.+)$/;

export function labelOf(job: AgentJob): string {
  return job.id.replace(/-\d+$/, "");
}

export interface WorldOptions {
  /** The spec the architect returns. Default: greet, then farewell (which depends on greet). */
  features?: SpecFeature[];
  configure?: (c: Config) => void;
  /** Default: a FakeClock at 23:00 on 2026-10-10 (it only moves when a test advances it). */
  clock?: Clock;
}

export interface Notification {
  title: string;
  body: string;
  /** ntfy priority header: "3" default, "4" high. */
  priority: string;
}

export interface LogLine {
  level: string;
  msg: string;
}

export class World {
  readonly root = mkdtempSync(join(tmpdir(), "mc-e2e-"));
  readonly home = join(this.root, "home");
  readonly workspace = join(this.root, "apps");
  readonly config: Config;
  readonly clock: Clock;
  readonly claude: MockRunner;
  readonly codex: MockRunner;
  readonly git = new Git();
  /** Every job either runner received, in call order, over every night. */
  readonly jobs: AgentJob[] = [];
  /** Per-role overrides of the default agents; a handler can delegate to `this.defaults[role]`. */
  agents: Partial<Record<Role, Handler>> = {};
  readonly defaults: Record<Role, Handler>;
  /** What the test author wrote for each feature, by test path (the latest version). */
  readonly authoredTests = new Map<string, string>();
  readonly logs: LogLine[] = [];
  readonly fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("ok"));
  private readonly labelCounts = new Map<string, number>();

  constructor(opts: WorldOptions = {}) {
    vi.stubEnv("MC_HOME", this.home);
    vi.stubGlobal("fetch", this.fetchMock);
    const c = defaultConfig();
    c.home = this.home;
    c.workspaceRoot = this.workspace;
    c.notify.ntfyUrl = NTFY_URL;
    c.limits.verifyTimeoutMs = 60_000;
    opts.configure?.(c);
    this.config = c;
    this.clock = opts.clock ?? new FakeClock(eveningOf());
    this.defaults = this.defaultAgents(opts.features ?? [spec("greet"), spec("farewell", ["greet"])]);
    this.claude = new MockRunner((job) => this.route(job), { provider: "claude" });
    this.codex = new MockRunner((job) => this.route(job), { provider: "codex" });
  }

  get fakeClock(): FakeClock {
    if (!(this.clock instanceof FakeClock)) throw new Error("this world runs on another clock");
    return this.clock;
  }

  store(): MissionStore {
    return new MissionStore(this.home);
  }

  queueGreenfield(title = "Fixture app", request = "Build me a tiny app whose features say that they work.", checkpoints?: CheckpointKind[]): Mission {
    return this.store().createMission({ kind: "greenfield", title, request, repoPath: "", baseBranch: "main", profile: this.config.defaultProfile, checkpoints, nowMs: this.clock.now() });
  }

  queueFeature(repoPath: string, title = "Add greetings", request = "Add a greeting feature.", baseBranch = "main", checkpoints?: CheckpointKind[]): Mission {
    return this.store().createMission({ kind: "feature", title, request, repoPath, baseBranch, profile: this.config.defaultProfile, checkpoints, nowMs: this.clock.now() });
  }

  /** One `mc run`, with this world's config, clock, runners and a capturing logger. */
  night(opts: Omit<NightOptions, "config" | "clock" | "runners" | "logger"> = {}): Promise<NightResult> {
    const capture = (level: string) => (msg: string) => void this.logs.push({ level, msg });
    const logger = { debug: capture("debug"), info: capture("info"), warn: capture("warn"), error: capture("error") };
    return runNight({ ...opts, config: this.config, clock: this.clock, runners: { claude: this.claude, codex: this.codex }, logger });
  }

  mission(id: string): Mission {
    return this.store().load(id);
  }

  events(id: string, type?: string): MissionEvent[] {
    const all = this.store().readEvents(id);
    return type === undefined ? all : all.filter((e) => e.type === type);
  }

  usage(id: string): UsageRecord[] {
    return this.store().readUsage().filter((u) => u.missionId === id);
  }

  report(id: string): string {
    return readFileSync(this.store().reportPath(id), "utf8");
  }

  labeled(label: string): AgentJob[] {
    return this.jobs.filter((j) => labelOf(j) === label);
  }

  jobsFor(role: Role): AgentJob[] {
    return this.jobs.filter((j) => j.role === role);
  }

  notifications(): Notification[] {
    return this.fetchMock.mock.calls.map(([, init]) => {
      const { headers, body } = (init ?? {}) as { headers?: Record<string, string>; body?: string };
      return { title: headers?.Title ?? "", body: String(body ?? ""), priority: headers?.Priority ?? "" };
    });
  }

  /** `git -C dir args…` output, trimmed. For the temp repos only. */
  gitOut(dir: string, args: string[]): string {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  /** Runs the app's own full check (`node --test` on every test file) in `dir`; true when it passes. */
  appChecksPass(dir: string): boolean {
    try {
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      execFileSync(process.execPath, ["--test", "tests/**/*.test.mjs"], { cwd: dir, stdio: "pipe", env });
      return true;
    } catch {
      return false;
    }
  }

  cleanup(): void {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(this.root, { recursive: true, force: true });
  }

  private route(job: AgentJob): MockBehavior | Promise<MockBehavior> {
    this.jobs.push(job);
    const label = labelOf(job);
    const n = (this.labelCounts.get(label) ?? 0) + 1;
    this.labelCounts.set(label, n);
    const call: Call = { label, n, feature: FEATURE_LABEL.exec(label)?.[1] };
    const handler = this.agents[job.role] ?? this.defaults[job.role];
    return handler(job, call);
  }

  private defaultAgents(features: SpecFeature[]): Record<Role, Handler> {
    return {
      architect: (_job, call) => {
        if (call.label === "spec") return { structured: specOutput(features) };
        if (call.label === "onboard") {
          return { structured: { stackSummary: "A Node ESM project checked with node --test.", verify: APP_VERIFY, notes: [] } satisfies OnboardOutput };
        }
        return { structured: diagnosis("retry_with_hint", `run() must return the text "${call.feature} works".`) };
      },
      reviewer: (_job, call) => {
        if (call.label === "gate-a") return { structured: { verdict: "approve", issues: [] } satisfies GateOutput };
        if (call.label === "gate-c") return { structured: { ...verdict(), resolutions: [] } };
        return { structured: verdict() };
      },
      test_author: (_job, call) => {
        const id = call.feature ?? "unknown";
        return {
          edit: (cwd) => {
            writeIn(cwd, testPath(id), acceptanceTest(id));
            this.authoredTests.set(testPath(id), acceptanceTest(id));
          },
          structured: { testFiles: [testPath(id)], notes: "" } satisfies TestAuthorOutput,
        };
      },
      engineer: (_job, call) => {
        if (call.label === "init") {
          return { edit: scaffold, structured: { summary: "scaffolded the app", verify: APP_VERIFY, notes: [] } satisfies InitOutput };
        }
        const id = call.feature ?? "unknown";
        return { edit: (cwd) => implement(cwd, id), structured: built() };
      },
      scout: (_job, call) => {
        if (call.label === "report-prose") return { structured: PROSE };
        if (call.label.startsWith("digest-")) {
          return { structured: { summary: "run() returns the wrong text", likelyCause: "a typo in run()", failingTests: [] } satisfies FailureDigestOutput };
        }
        return { structured: { files: [], notes: "" } satisfies ContextPackOutput };
      },
    };
  }
}

/** True when `path` exists inside `dir`. */
export function has(dir: string, path: string): boolean {
  return existsSync(join(dir, path));
}

/** The level-2 headings of a markdown document, in order. */
export function headings(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3).trim());
}

/** The body of the level-2 section `title` (up to the next level-2 heading). */
export function sectionOf(markdown: string, title: string): string {
  const start = markdown.indexOf(`\n## ${title}\n`);
  if (start < 0) return "";
  const rest = markdown.slice(start + title.length + 5);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}
