import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { detectLimitText } from "../limits.js";
import { SCHEMAS } from "../schemas.js";
import type { AgentJob, Logger, RunEvent, RunOptions, RunResult } from "../types.js";
import { claudeAllowanceInput, ClaudeRunner, type ClaudeRunnerOptions } from "./claude.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const NODE_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const HOUR_MS = 3_600_000;
const WRITE_TOOLS =
  "Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,WebFetch,WebSearch,Task,TaskCreate,TaskGet,TaskList,TaskUpdate,TaskStop,Monitor,Skill,ToolSearch";
/** Tools of CLI 2.1.295 that act beyond the run and the worktree: on the account, other sessions or the phone. */
const ESCAPING_TOOLS = [
  "RemoteTrigger",
  "DesignSync",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "Workflow",
  "EnterWorktree",
  "ExitWorktree",
  "SendMessage",
  "ListAgents",
  "PushNotification",
];

interface Recorded {
  argv: string[];
  stdin: string;
  cwd: string;
  env: Record<string, string>;
  pid: number;
  systemPromptFile: string | null;
  systemPrompt: string | null;
}

let suiteDir: string;
let fakeClaude: string;
let dir: string;
let workDir: string;
let promptTmp: string;
let recordPath: string;

beforeAll(() => {
  // A copy with the executable bit, independent of how the repository checkout stores file modes.
  suiteDir = mkdtempSync(join(tmpdir(), "mc-claude-runner-bin-"));
  fakeClaude = join(suiteDir, "claude");
  copyFileSync(FIXTURE, fakeClaude);
  chmodSync(fakeClaude, 0o755);
});

afterAll(() => {
  rmSync(suiteDir, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-claude-runner-"));
  workDir = join(dir, "work");
  promptTmp = join(dir, "tmp");
  recordPath = join(dir, "record.json");
  mkdirSync(workDir);
  mkdirSync(promptTmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (existsSync(recordPath)) killQuietly(recorded().pid);
  rmSync(dir, { recursive: true, force: true });
});

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function makeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: "job-1",
    role: "engineer",
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: "high",
    cwd: workDir,
    systemPrompt: "You are the engineer.\nFollow AGENTS.md.",
    prompt: "Implement the feature.",
    access: "workspace-write",
    limits: { maxTurns: 80, timeoutMs: 20_000 },
    ...overrides,
  };
}

function scenarioEnv(scenario: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: NODE_PATH, FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_RECORD: recordPath, ...extra };
}

function fixtureOptions(values: NodeJS.ProcessEnv) {
  const configHome = mkdtempSync(join(dir, "provider-config-"));
  writeFileSync(join(configHome, "mc-fixture.json"), JSON.stringify(Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith("FAKE_")))));
  return { configHome, path: [dirname(process.execPath), "/usr/bin", "/bin"] };
}

function makeRunner(scenario: string, opts: Partial<ClaudeRunnerOptions> & { env?: NodeJS.ProcessEnv } = {}): ClaudeRunner {
  const { env, ...options } = opts;
  return new ClaudeRunner({
    command: fakeClaude,
    writeMode: "bypassPermissions",
    tmpDir: promptTmp,
    ...fixtureOptions(env ?? scenarioEnv(scenario)),
    ...options,
  });
}

async function play(
  scenario: string,
  overrides: Partial<AgentJob> = {},
  runOpts: RunOptions = {},
): Promise<{ result: RunResult; events: RunEvent[] }> {
  return playOn(makeRunner(scenario), overrides, runOpts);
}

async function playOn(
  runner: ClaudeRunner,
  overrides: Partial<AgentJob> = {},
  runOpts: RunOptions = {},
): Promise<{ result: RunResult; events: RunEvent[] }> {
  const events: RunEvent[] = [];
  const result = await runner.run(makeJob(overrides), { onEvent: (e) => events.push(e), ...runOpts });
  return { result, events };
}

/** Plays the CLI giving up on the API with this message and status. */
function playApiError(status: number | null, message: string): Promise<{ result: RunResult; events: RunEvent[] }> {
  const extra = { FAKE_CLAUDE_API_ERROR: message, ...(status !== null && { FAKE_CLAUDE_API_STATUS: String(status) }) };
  return playOn(makeRunner("api-error", { env: scenarioEnv("api-error", extra) }));
}

function recorded(): Recorded {
  return JSON.parse(readFileSync(recordPath, "utf8")) as Recorded;
}

function ofType<T extends RunEvent["type"]>(events: RunEvent[], type: T): Extract<RunEvent, { type: T }>[] {
  return events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
}

function progressTexts(events: RunEvent[]): string[] {
  return ofType(events, "progress").map((e) => e.text);
}

function isAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

function recordingLogger(): Logger & { lines: { level: string; msg: string; data?: Record<string, unknown> }[] } {
  const lines: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const at = (level: string) => (msg: string, data?: Record<string, unknown>) => lines.push({ level, msg, data });
  return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

/** Asserts a reset time computed from "in <duration>" text read between `before` and `after`. */
function expectResetIn(resetsAt: number | undefined, durationMs: number, before: number, after: number): void {
  expect(resetsAt).toBeGreaterThanOrEqual(before + durationMs);
  expect(resetsAt).toBeLessThanOrEqual(after + durationMs);
}

describe("buildArgs", () => {
  const head = (file: string) => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "claude-sonnet-5-5",
    "--effort",
    "high",
    "--max-turns",
    "80",
    "--append-system-prompt-file",
    file,
  ];

  const tail = (mode: string, tools: string) => [
    "--permission-mode",
    mode,
    "--tools",
    tools,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--permission-prompts",
    "none",
  ];
  const writeTail = (mode: string) => tail(mode, WRITE_TOOLS);

  it("runs workspace-write jobs in the configured write mode, with an allowlist of tools", () => {
    const args = makeRunner("success").buildArgs(makeJob(), "/tmp/sp.md");
    expect(args).toEqual([...head("/tmp/sp.md"), ...writeTail("bypassPermissions")]);
  });

  it("gives write jobs no tool that acts beyond the run, and no deny-list that new tools would slip past", () => {
    const args = makeRunner("success").buildArgs(makeJob(), "/tmp/sp.md");
    const tools = (args[args.indexOf("--tools") + 1] ?? "").split(",");
    expect(tools).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "Task", "Skill"]));
    for (const tool of ESCAPING_TOOLS) expect(tools).not.toContain(tool);
    expect(args).not.toContain("--disallowedTools");
  });

  it.each([
    ["write", {}],
    ["read-only", { access: "read-only" }],
    ["noTools", { access: "read-only", noTools: true }],
  ] as const)("loads no settings file and no MCP server for %s jobs", (_, job) => {
    const args = makeRunner("success").buildArgs(makeJob(job), "/tmp/sp.md");
    const sources = args.indexOf("--setting-sources");
    expect(sources).toBeGreaterThan(0);
    expect(args[sources + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
  });

  it.each(["acceptEdits", "auto"] as const)("passes write mode %s through", (writeMode) => {
    const args = makeRunner("success", { writeMode }).buildArgs(makeJob(), "/tmp/sp.md");
    expect(args.slice(-9)).toEqual(writeTail(writeMode));
  });

  it("limits read-only jobs to Read, Grep and Glob without prompting", () => {
    const args = makeRunner("success").buildArgs(makeJob({ access: "read-only" }), "/tmp/sp.md");
    expect(args).toEqual([...head("/tmp/sp.md"), ...tail("dontAsk", "Read,Grep,Glob")]);
  });

  it("disables every tool for noTools jobs", () => {
    const args = makeRunner("success").buildArgs(makeJob({ access: "read-only", noTools: true }), "/tmp/sp.md");
    expect(args).toEqual([...head("/tmp/sp.md"), ...tail("dontAsk", "")]);
  });

  it("adds the JSON schema and the session to resume, in that order", () => {
    const job = makeJob({ outputSchema: SCHEMAS.gate, resumeSessionId: "sess-9", model: "claude-opus-5-5", effort: "max" });
    const args = makeRunner("success").buildArgs(job, "/tmp/sp.md");
    const schemaAt = args.indexOf("--json-schema");
    expect(args.slice(0, 12)).toContain("claude-opus-5-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("max");
    expect(schemaAt).toBe(12);
    expect(JSON.parse(args[schemaAt + 1] ?? "")).toEqual(SCHEMAS.gate);
    expect(args.slice(14)).toEqual(["--resume", "sess-9", ...writeTail("bypassPermissions")]);
  });

  it("passes --add-dir once for each folder a read-only job may open files from, before the permission mode", () => {
    const job = makeJob({ access: "read-only", readDirs: ["/home/u/.mc/missions/m1/screenshots", "/home/u/other"] });
    const args = makeRunner("success").buildArgs(job, "/tmp/sp.md");
    expect(args).toEqual([...head("/tmp/sp.md"), "--add-dir", "/home/u/.mc/missions/m1/screenshots", "--add-dir", "/home/u/other", ...tail("dontAsk", "Read,Grep,Glob")]);
    expect(args.indexOf("--add-dir")).toBeLessThan(args.indexOf("--permission-mode"));
    // after the session to resume, as the other options are
    const resumed = makeRunner("success").buildArgs(makeJob({ access: "read-only", readDirs: ["/a"], resumeSessionId: "sess-9" }), "/tmp/sp.md");
    expect(resumed.slice(12)).toEqual(["--resume", "sess-9", "--add-dir", "/a", ...tail("dontAsk", "Read,Grep,Glob")]);
  });

  it("builds the old argument list when readDirs is absent or empty", () => {
    const base = makeRunner("success").buildArgs(makeJob({ access: "read-only" }), "/tmp/sp.md");
    expect(makeRunner("success").buildArgs(makeJob({ access: "read-only", readDirs: [] }), "/tmp/sp.md")).toEqual(base);
    expect(base).not.toContain("--add-dir");
    expect(base).toEqual([...head("/tmp/sp.md"), ...tail("dontAsk", "Read,Grep,Glob")]);
  });

  it("passes only absolute folders: a relative one could be read as a flag", () => {
    const job = makeJob({ access: "read-only", readDirs: ["--dangerously-skip-permissions", "-x", "relative/dir", "", "/ok/dir"] });
    const args = makeRunner("success").buildArgs(job, "/tmp/sp.md");
    expect(args.filter((a) => a === "--add-dir")).toHaveLength(1);
    expect(args).toContain("/ok/dir");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("relative/dir");
  });

  it("never passes the prompt or --bare on the command line", () => {
    const args = makeRunner("success").buildArgs(makeJob({ prompt: "SECRET PROMPT" }), "/tmp/sp.md");
    expect(args).not.toContain("SECRET PROMPT");
    expect(args).not.toContain("--bare");
  });
});

describe("ClaudeRunner.run: process handling", () => {
  it("sends the prompt on stdin and runs the built args in the job's cwd", async () => {
    const prompt = `Implement ✓ the feature.\n${"x".repeat(300 * 1024)}`;
    const job = makeJob({ prompt });
    const { result } = await play("success", { prompt });
    const rec = recorded();
    expect(result.outcome).toBe("ok");
    expect(rec.stdin).toBe(prompt);
    expect(rec.argv).toEqual(makeRunner("success").buildArgs(job, rec.systemPromptFile ?? ""));
    expect(rec.cwd).toBe(realpathSync(workDir));
  });

  it("writes the system prompt to a temp file that is deleted afterwards", async () => {
    await play("success");
    const rec = recorded();
    expect(rec.systemPrompt).toBe("You are the engineer.\nFollow AGENTS.md.");
    expect(rec.systemPromptFile?.startsWith(promptTmp)).toBe(true);
    expect(existsSync(rec.systemPromptFile ?? "")).toBe(false);
    expect(readdirSync(promptTmp)).toEqual([]);
  });

  it("creates a missing tmpDir", async () => {
    const nested = join(dir, "not", "yet");
    const result = await makeRunner("success", { tmpDir: nested }).run(makeJob());
    expect(result.outcome).toBe("ok");
    expect(recorded().systemPromptFile?.startsWith(nested)).toBe(true);
    expect(readdirSync(nested)).toEqual([]);
  });

  it("omits API keys and unrelated values from the child environment", async () => {
    const env = {
      PATH: NODE_PATH,
      FAKE_CLAUDE_SCENARIO: "success",
      FAKE_CLAUDE_RECORD: recordPath,
      ANTHROPIC_API_KEY: "sk-ant-test",
      CLAUDECODE: "1",
      OPENAI_API_KEY: "sk-test",
      MC_MARKER: "kept",
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const result = await makeRunner("success", { env }).run(makeJob());
    const rec = recorded();
    expect(result.outcome).toBe("ok");
    expect(rec.env.MC_MARKER).toBeUndefined();
    expect(rec.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(rec.env).not.toHaveProperty("CLAUDECODE");
    expect(rec.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
  });

  it("selects only the provider config from controller settings at run time", async () => {
    const runner = new ClaudeRunner({ command: fakeClaude, writeMode: "auto", tmpDir: promptTmp });
    const fixture = fixtureOptions(scenarioEnv("success"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", fixture.configHome);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("MC_UNRELATED_SECRET", "synthetic-secret");
    const result = await runner.run(makeJob());
    expect(result.outcome).toBe("ok");
    const rec = recorded();
    expect(rec.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(rec.env).not.toHaveProperty("MC_UNRELATED_SECRET");
    expect(rec.argv).toContain("auto");
  });

  it("tees the raw stream to the job's log file", async () => {
    const logFile = join(dir, "logs", "job-1.ndjson");
    await play("success", { logFile });
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ type: "system", subtype: "init" });
    expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({ type: "result", result: "All tests pass." });
  });

  it("times out a hung CLI, kills it and still removes the prompt file", async () => {
    const { result, events } = await play("hang", { limits: { maxTurns: 5, timeoutMs: 400 } });
    const rec = recorded();
    expect(result.outcome).toBe("timeout");
    expect(result.error).toBe("timed out after 400 ms");
    expect(ofType(events, "started")).toEqual([{ type: "started", sessionId: "sess-fake-1" }]);
    expect(result.sessionId).toBe("sess-fake-1");
    expect(isAlive(rec.pid)).toBe(false);
    expect(readdirSync(promptTmp)).toEqual([]);
  });

  it("aborts a running CLI when the signal fires", async () => {
    const controller = new AbortController();
    const onEvent = (e: RunEvent) => {
      if (e.type === "started") controller.abort();
    };
    const { result } = await play("hang", {}, { signal: controller.signal, onEvent });
    expect(result.outcome).toBe("aborted");
    expect(isAlive(recorded().pid)).toBe(false);
    expect(readdirSync(promptTmp)).toEqual([]);
  });

  it("does not start the CLI when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await play("success", {}, { signal: controller.signal });
    expect(result.outcome).toBe("aborted");
    expect(existsSync(recordPath)).toBe(false);
    expect(readdirSync(promptTmp)).toEqual([]);
  });

  it("reports a missing CLI as crashed", async () => {
    const result = await makeRunner("success", { command: join(dir, "no-such-claude") }).run(makeJob());
    expect(result.outcome).toBe("crashed");
    expect(result.error).toMatch(/^claude CLI not found or failed to start: ENOENT/);
    expect(result.exitCode).toBeNull();
    expect(readdirSync(promptTmp)).toEqual([]);
  });

  it("reports an unwritable tmpDir as crashed without running the CLI", async () => {
    const notADir = join(dir, "file");
    writeFileSync(notADir, "");
    const result = await makeRunner("success", { tmpDir: notADir }).run(makeJob());
    expect(result.outcome).toBe("crashed");
    expect(result.error).toMatch(/^could not write the system prompt file/);
    expect(existsSync(recordPath)).toBe(false);
  });

  it("survives an onEvent handler that throws, and logs the run", async () => {
    const logger = recordingLogger();
    const runner = makeRunner("success", { logger });
    const result = await runner.run(makeJob(), {
      onEvent: () => {
        throw new Error("handler bug");
      },
    });
    expect(result.outcome).toBe("ok");
    expect(result.usage.turns).toBe(3);
    expect(logger.lines.some((l) => l.level === "warn" && String(l.data?.error).includes("handler bug"))).toBe(true);
    expect(logger.lines).toContainEqual(expect.objectContaining({ level: "info", msg: "claude run job-1: ok" }));
  });
});

describe("ClaudeRunner.run: stream parsing", () => {
  it("maps a successful run: session, progress, usage and final text", async () => {
    const { result, events } = await play("success");
    expect(result).toMatchObject({ outcome: "ok", text: "All tests pass.", sessionId: "sess-fake-1", exitCode: 0 });
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 5000,
      cacheWriteTokens: 700,
      estCostUsd: 0.0123,
      turns: 3,
    });
    expect(events[0]).toEqual({ type: "started", sessionId: "sess-fake-1" });
    expect(progressTexts(events)).toEqual([
      "I will start by reading the code. ".repeat(20).trim().slice(0, 300),
      "Read src/app.ts",
      "Bash npm test",
      "Grep TODO",
      "TodoWrite",
      "All tests pass.",
    ]);
    expect(ofType(events, "usage")).toEqual([{ type: "usage", usage: result.usage }]);
    expect(ofType(events, "limit")).toEqual([]);
  });

  it("parses glued, truncated and garbage lines defensively", async () => {
    const { result, events } = await play("glued");
    expect(result).toMatchObject({ outcome: "ok", text: "Glued but fine.", sessionId: "sess-fake-1" });
    expect(ofType(events, "started")).toHaveLength(1);
    expect(progressTexts(events)).toEqual(["Working on it.", "Edit src/kept.ts"]);
    expect(ofType(events, "utilization")).toEqual([
      { type: "utilization", info: { provider: "claude", window: "five_hour", utilization: 0.4, resetsAt: 1791600000000 } },
    ]);
  });

  it("reports API retries as progress", async () => {
    const { result, events } = await play("api-retry");
    expect(result.outcome).toBe("ok");
    expect(progressTexts(events)).toEqual(["API retry 1/10 (529)", "API retry 2/10 (no status)"]);
  });

  it("emits utilization for every unified window and the top-level window", async () => {
    const { result, events } = await play("utilization");
    expect(result.outcome).toBe("ok");
    expect(ofType(events, "utilization").map((e) => e.info)).toEqual([
      { provider: "claude", window: "five_hour", utilization: 0.42, resetsAt: 1791590000000 },
      { provider: "claude", window: "seven_day", utilization: 0.77, resetsAt: 1792000000000 },
      { provider: "claude", window: "seven_day_opus", utilization: 0.81, resetsAt: 1791700000000 },
      { provider: "claude", window: "five_hour", utilization: 0.43, resetsAt: 1791590000000 },
    ]);
    expect(ofType(events, "limit")).toEqual([]);
  });

  it("uses the last text block when the result carries no text", async () => {
    const { result } = await play("no-result-text");
    expect(result).toMatchObject({ outcome: "failed", text: "Final words from the assistant." });
    expect(result.error).toBe("claude finished with error_during_execution");
  });
});

describe("ClaudeRunner.run: the files a run opened", () => {
  /** A fake CLI that plays the events in $FAKE_STREAM, as the real one prints them. */
  let streamCli: string;
  beforeAll(() => {
    streamCli = join(suiteDir, "claude-stream");
    writeFileSync(
      streamCli,
      '#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on("end", () => {\n  for (const e of JSON.parse(JSON.parse(require("node:fs").readFileSync(process.env.CLAUDE_CONFIG_DIR + "/mc-fixture.json", "utf8")).FAKE_STREAM)) process.stdout.write(JSON.stringify(e) + "\\n");\n});\n',
    );
    chmodSync(streamCli, 0o755);
  });

  const init = { type: "system", subtype: "init", session_id: "s1", model: "m", tools: [] };
  const done = { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "Done.", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: "s1" };
  const assistant = (...content: unknown[]) => ({ type: "assistant", message: { content }, session_id: "s1" });
  const read = (file_path: unknown) => ({ type: "tool_use", id: "t", name: "Read", input: { file_path } });

  async function opened(events: unknown[]): Promise<RunResult> {
    const runner = new ClaudeRunner({ command: streamCli, writeMode: "bypassPermissions", tmpDir: promptTmp, ...fixtureOptions({ FAKE_STREAM: JSON.stringify([init, ...events, done]) }) });
    return runner.run(makeJob({ access: "read-only" }));
  }

  it.each([{ payload: null }, { payload: "private-window-payload" }, { payload: [] }])(
    "replaces prior fresh known-window truth with a malformed payload marker: %j", async ({ payload }) => {
      const frames = [
        { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: {
          five_hour: { utilization: 0.4, resetsAt: 1793440000 },
        } } },
        { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: payload } } },
      ];
      const runner = new ClaudeRunner({ command: streamCli, writeMode: "bypassPermissions", tmpDir: promptTmp,
        ...fixtureOptions({ FAKE_STREAM: JSON.stringify([init, ...frames, done]) }) });
      const { result, events } = await playOn(runner);
      expect(result.outcome).toBe("ok");
      const allowanceEvents = events.filter((event) => event.type === "utilization" || event.type === "allowance");
      expect(allowanceEvents).toEqual([
        { type: "utilization", info: { provider: "claude", window: "five_hour", utilization: 0.4, resetsAt: 1793440000000 } },
        { type: "allowance", observations: [{ window: "five_hour", utilization: null, reset: { kind: "omitted" } }] },
      ]);
      expect(JSON.stringify(allowanceEvents)).not.toContain("private-window-payload");
    },
  );

  it.each([
    { utilization: "private-usage", resetsAt: 1793440000 },
    { utilization: -1, resetsAt: 1793440000 },
    { utilization: 0.4, resetsAt: "private-reset" },
    { utilization: 0.4, resetsAt: null },
  ])("preserves malformed allowance without a normal utilization event: %j", async (sample) => {
    const runner = new ClaudeRunner({ command: streamCli, writeMode: "bypassPermissions", tmpDir: promptTmp,
      ...fixtureOptions({ FAKE_STREAM: JSON.stringify([init, { type: "rate_limit_event", rate_limit_info: {
        status: "allowed", rateLimitType: "five_hour", ...sample,
      } }, done]) }) });
    const { result, events } = await playOn(runner);
    expect(result.outcome).toBe("ok");
    expect(ofType(events, "utilization")).toEqual([]);
    expect(ofType(events, "allowance")).toEqual([{ type: "allowance", observations: [{
      window: "five_hour", utilization: typeof sample.utilization === "number" && sample.utilization >= 0 ? sample.utilization : null,
      reset: { kind: "supplied", value: typeof sample.resetsAt === "number" ? sample.resetsAt * 1000 : null },
    }] }]);
    expect(JSON.stringify(ofType(events, "allowance"))).not.toContain("private-");
  });

  it("keeps the file_path of each Read call, and nothing from Bash, Grep, Glob, Edit or a text block", async () => {
    const result = await opened([
      assistant({ type: "text", text: "I read /etc/passwd and /secret.txt" }, read("/work/docs/setup.md")),
      assistant({ type: "tool_use", id: "b", name: "Bash", input: { command: "cat /work/other.md", file_path: "/work/bash.md" } }),
      assistant({ type: "tool_use", id: "g", name: "Grep", input: { pattern: "TODO", path: "/work/grep" } }, { type: "tool_use", id: "e", name: "Edit", input: { file_path: "/work/edit.md" } }),
      assistant(read("/work/screenshots/look__a__1__index__phone.png")),
    ]);
    expect(result.outcome).toBe("ok");
    expect(result.opened).toEqual(["/work/docs/setup.md", "/work/screenshots/look__a__1__index__phone.png"]);
  });

  it("is absent when the run opened nothing, so a result is as it was", async () => {
    const result = await opened([assistant({ type: "text", text: "Nothing to read." }), assistant({ type: "tool_use", id: "g", name: "Glob", input: { pattern: "*.md" } })]);
    expect(Object.keys(result)).not.toContain("opened");
    const bare = await opened([]);
    expect(Object.keys(bare)).not.toContain("opened");
    // the old scenario that reads one file still gives its path, and the Bash and Grep calls of it add nothing
    expect((await play("success")).result.opened).toEqual(["src/app.ts"]);
  });

  it("lists a file once, ignores a Read without a usable path, and cuts a long path at 300 characters", async () => {
    const long = `/${"d".repeat(400)}`;
    const result = await opened([assistant(read("/a.md"), read("/a.md"), read(""), read(42), read(undefined), { type: "tool_use", id: "x", name: "Read" }, read(long))]);
    expect(result.opened).toEqual(["/a.md", long.slice(0, 300)]);
  });

  it("keeps at most 200 paths", async () => {
    const result = await opened([assistant(...Array.from({ length: 260 }, (_, i) => read(`/f/${i}.md`)))]);
    expect(result.opened).toHaveLength(200);
    expect(result.opened?.[0]).toBe("/f/0.md");
    expect(result.opened?.[199]).toBe("/f/199.md");
  });
});

describe("ClaudeRunner.run: usage limits", () => {
  it("treats a rejected rate_limit_event as a limit, with resetsAt converted from seconds", async () => {
    const { result, events } = await play("rate-limit-rejected");
    const expected = { provider: "claude", kind: "session", resetsAt: 1791600000000 };
    expect(result.outcome).toBe("limited");
    expect(result.limit).toMatchObject(expected);
    expect(result.limit?.raw).toContain('"status":"rejected"');
    expect(result.error).toMatch(/^usage limit \(session\)/);
    const limits = ofType(events, "limit");
    expect(limits).toHaveLength(1);
    expect(limits[0]?.info).toEqual(result.limit);
    expect(ofType(events, "utilization").map((e) => e.info.utilization)).toEqual([1.02]);
  });

  it("names the model of a model limit and takes the reset from the text when the event has none", async () => {
    const before = Date.now();
    const { result, events } = await play("rate-limit-rejected-no-reset", { model: "claude-opus-5-5" });
    const after = Date.now();
    expect(result.outcome).toBe("limited");
    expect(result.limit).toMatchObject({ provider: "claude", kind: "model", model: "opus" });
    expectResetIn(result.limit?.resetsAt, 2 * HOUR_MS, before, after);
    // The executor records the limit from the event, so the event must carry the reset read from the text.
    expect(ofType(events, "limit")).toEqual([{ type: "limit", info: result.limit }]);
  });

  it("lets a rejected event win over a success result", async () => {
    const { result, events } = await play("rejected-then-success");
    expect(result).toMatchObject({ outcome: "limited", text: "Finished anyway." });
    expect(result.limit).toMatchObject({ kind: "spend", resetsAt: 1791600000000 });
    expect(result.limit).not.toHaveProperty("model");
    expect(ofType(events, "limit")).toEqual([{ type: "limit", info: result.limit }]);
  });

  it("stops a run that would go on with paid extra usage, and reports the subscription's limit", async () => {
    const { result, events } = await play("extra-usage-continues");
    expect(result.outcome).toBe("limited");
    expect(result.durationMs).toBeLessThan(10_000); // stopped, not left running until the 20 s timeout
    expect(isAlive(recorded().pid)).toBe(false);
    expect(result.limit).toMatchObject({ provider: "claude", kind: "session", resetsAt: 1791600000000 });
    expect(result.limit?.raw).toContain('"isUsingOverage":true');
    expect(ofType(events, "limit")).toEqual([{ type: "limit", info: result.limit }]);
    expect(progressTexts(events)).toContain("subscription limit reached: stopping instead of going on with paid extra usage");
    expect(ofType(events, "utilization").map((e) => e.info)).toEqual([
      { provider: "claude", window: "five_hour", utilization: 1.01, resetsAt: 1791600000000 },
    ]);
  });

  it("stops on extra usage even when the event carries no utilization or reset time (older shape)", async () => {
    const { result, events } = await play("extra-usage-continues-old-shape");
    expect(result.outcome).toBe("limited");
    expect(result.durationMs).toBeLessThan(10_000);
    // Recorded as a limit, so later runs don't start on extra usage either: the quota blocks the session window.
    expect(result.limit).toMatchObject({ provider: "claude", kind: "session" });
    expect(ofType(events, "utilization")).toEqual([]);
    expect(ofType(events, "limit")).toEqual([{ type: "limit", info: result.limit }]);
  });

  it("does not keep the answer of a run that finished on paid extra usage", async () => {
    const job = { outputSchema: SCHEMAS.gate, access: "read-only", noTools: true } as const;
    const { result } = await play("extra-usage-success", job);
    expect(result.outcome).toBe("limited");
    expect(result.limit).toMatchObject({ kind: "session", resetsAt: 1791600000000 });
    expect(result.structured).toBeUndefined();
  });

  it("treats running out of extra usage as a spend limit", async () => {
    const { result, events } = await play("extra-usage-exhausted");
    expect(result.outcome).toBe("limited");
    expect(result.limit).toMatchObject({ provider: "claude", kind: "spend", resetsAt: 1792000000000 });
    expect(result.limit?.raw).toContain('"isUsingOverage":false');
    expect(ofType(events, "limit")).toEqual([{ type: "limit", info: result.limit }]);
  });

  it("trusts a rejected event even without a result", async () => {
    const { result } = await play("rejected-no-result");
    expect(result).toMatchObject({ outcome: "limited", exitCode: 1 });
    expect(result.limit).toMatchObject({ kind: "weekly", resetsAt: 1792000000000 });
  });

  it("detects limit text in an error result", async () => {
    const before = Date.now();
    const { result, events } = await play("limit-text");
    const after = Date.now();
    expect(result.outcome).toBe("limited");
    expect(result.limit).toMatchObject({ provider: "claude", kind: "weekly" });
    expect(result.limit?.raw).toContain("hit your weekly limit");
    expectResetIn(result.limit?.resetsAt, 72 * HOUR_MS, before, after);
    expect(ofType(events, "usage")).toHaveLength(1);
  });

  it("detects limit text in the result's errors", async () => {
    const before = Date.now();
    const { result } = await play("limit-errors");
    const after = Date.now();
    expect(result.outcome).toBe("limited");
    expect(result.limit?.kind).toBe("session");
    expectResetIn(result.limit?.resetsAt, 45 * 60_000, before, after);
  });

  it("detects a throttle on stderr when no result arrives", async () => {
    const { result } = await play("limit-stderr");
    expect(result).toMatchObject({ outcome: "limited", exitCode: 1 });
    expect(result.limit?.kind).toBe("throttle");
  });

  it("keeps a successful run ok even when its text and stderr mention 429 / rate limits", async () => {
    const text = "API Error: 429 Too Many Requests is what the new middleware returns once the rate limit is exceeded.";
    // The same text in an error would be a throttle: the runner must not look for limits in a success.
    expect(detectLimitText(text, "claude", Date.now())?.kind).toBe("throttle");
    const { result, events } = await play("success-mentions-429");
    expect(result).toMatchObject({ outcome: "ok", text });
    expect(result.limit).toBeUndefined();
    expect(ofType(events, "limit")).toEqual([]);
    expect(progressTexts(events)).toContain("API retry 1/10 (429)");
  });
});

describe("ClaudeRunner.run: transient API failures", () => {
  it.each([
    ["a refused connection", null, "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)"],
    ["a dropped connection", null, "API Error: Connection dropped (ECONNRESET)"],
    ["a request timeout", null, "API Error: Request timed out."],
    ["an unreachable server", null, "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"],
    ["a failed fetch", null, "API Error: fetch failed"],
    ["a server error", 500, "API Error: 500 Internal server error. This is a server-side issue, usually temporary."],
    ["a 5xx whose text mentions authentication", 503, "API Error: 503 authentication backend unavailable"],
  ])("backs off on %s instead of failing the job", async (_, status, message) => {
    const { result, events } = await playApiError(status, message);
    expect(result).toMatchObject({ outcome: "limited", error: `API unavailable: ${message}`, exitCode: 1 });
    expect(result.limit).toEqual({ provider: "claude", kind: "throttle", raw: message });
    expect(ofType(events, "limit")).toEqual([{ type: "limit", info: result.limit }]);
  });

  it("names the status of a server error that carries no text", async () => {
    const { result } = await playApiError(502, "");
    expect(result.limit).toEqual({ provider: "claude", kind: "throttle", raw: "API error 502" });
  });
});

describe("ClaudeRunner.run: structured output", () => {
  const schemaJob = { outputSchema: SCHEMAS.gate, access: "read-only", noTools: true } as const;

  it("returns structured_output when it validates", async () => {
    const { result } = await play("structured", schemaJob);
    expect(result).toMatchObject({ outcome: "ok", structured: { verdict: "approve", issues: [] } });
    expect(recorded().argv).toContain("--json-schema");
  });

  it("parses the result text as JSON when structured_output is absent", async () => {
    const { result } = await play("structured-text", schemaJob);
    expect(result).toMatchObject({ outcome: "ok", structured: { verdict: "revise", issues: ["missing tests"] } });
  });

  it("falls back to the last JSON object inside the result text", async () => {
    const { result } = await play("structured-embedded", schemaJob);
    expect(result).toMatchObject({ outcome: "ok", structured: { verdict: "revise", issues: ["final"] } });
  });

  it("fails on structured output that does not match the schema", async () => {
    const { result } = await play("structured-invalid", schemaJob);
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/^invalid structured output: .*verdict/);
    expect(result.structured).toBeUndefined();
  });

  it("fails when the answer holds no JSON at all", async () => {
    const { result } = await play("structured-missing", schemaJob);
    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/^invalid structured output/);
  });

  it("ignores JSON in the answer when no schema was requested", async () => {
    const { result } = await play("structured-text");
    expect(result.outcome).toBe("ok");
    expect(result.structured).toBeUndefined();
  });
});

describe("ClaudeRunner.run: failures", () => {
  it("maps a 401 result to auth", async () => {
    const { result } = await play("auth");
    expect(result.outcome).toBe("auth");
    expect(result.error).toContain("Failed to authenticate");
  });

  it("maps a 403 status to auth even without auth wording", async () => {
    const { result } = await play("auth-status-only");
    expect(result).toMatchObject({ outcome: "auth", error: "Request not allowed" });
  });

  it("maps OAuth wording in an error result to auth", async () => {
    const { result } = await play("auth-text");
    expect(result.outcome).toBe("auth");
  });

  it("maps a login error on stderr without a result to auth", async () => {
    const { result } = await play("auth-stderr");
    expect(result).toMatchObject({ outcome: "auth", exitCode: 1 });
    expect(result.error).toContain("Not logged in");
  });

  it("maps error_max_turns to failed", async () => {
    const { result } = await play("max-turns");
    expect(result).toMatchObject({ outcome: "failed", error: "max turns reached", text: "Still working..." });
    expect(result.usage.turns).toBe(40);
  });

  it("does not let a retry notice left on stderr turn a max-turns result into a throttle", async () => {
    const { result, events } = await play("max-turns-after-retry");
    expect(result).toMatchObject({ outcome: "failed", error: "max turns reached" });
    expect(result.limit).toBeUndefined();
    expect(ofType(events, "limit")).toEqual([]);
  });

  it("does not let a retry notice left on stderr hide an auth failure", async () => {
    const { result } = await play("auth-after-retry");
    expect(result.outcome).toBe("auth");
    expect(result.error).toContain("Failed to authenticate");
  });

  it("reports other errors with their text", async () => {
    const { result } = await play("error");
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe('Tool permission stream closed unexpectedly\n{"code":"E_TOOL"}');
  });

  it.each([
    ["a bad request", 400, "API Error: 400 messages: bad thing"],
    ["a TLS setup error", null, "API Error: Unable to connect to API: SSL certificate verification failed"],
  ])("keeps %s, which retrying cannot fix, a plain failure", async (_, status, message) => {
    const { result, events } = await playApiError(status, message);
    expect(result).toMatchObject({ outcome: "failed", error: message, exitCode: 1 });
    expect(result.limit).toBeUndefined();
    expect(ofType(events, "limit")).toEqual([]);
  });

  it("reports a crash with the exit code and the ANSI-free stderr tail", async () => {
    const { result } = await play("crash");
    expect(result).toMatchObject({ outcome: "crashed", exitCode: 3, sessionId: "sess-fake-1" });
    expect(result.error).toBe(
      "claude exited with code 3 without a result: TypeError: x is not a function\n    at main (cli.js:1:1)",
    );
  });

  it("reports output without any result event as crashed", async () => {
    const { result } = await play("garbage");
    expect(result).toMatchObject({ outcome: "crashed", exitCode: 0, text: "" });
    expect(result.error).toBe("claude exited with code 0 without a result");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });
});

describe("ClaudeRunner.run: billing guard", () => {
  it.each(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"])(
    "stops a run whose login would bill an API key (%s), as a login problem",
    async (keySource) => {
      const runner = makeRunner("api-key", { env: scenarioEnv("api-key", { FAKE_CLAUDE_KEY_SOURCE: keySource }) });
      const { result, events } = await playOn(runner);
      expect(result.outcome).toBe("auth");
      expect(result.error).toContain(`API key (${keySource})`);
      expect(result.error).toContain("Claude subscription");
      expect(result.durationMs).toBeLessThan(10_000); // stopped at once, not left running until the timeout
      expect(isAlive(recorded().pid)).toBe(false);
      expect(ofType(events, "limit")).toEqual([]);
    },
  );

  it("runs normally when the init event names the subscription login", async () => {
    const { result } = await play("subscription-login");
    expect(result).toMatchObject({ outcome: "ok", text: "Done." });
  });
});

describe("ClaudeRunner.run: a CLI that stays alive after its result", () => {
  const LINGER = { maxTurns: 5, timeoutMs: 20_000 };

  it("is stopped after the exit grace, and the result stands", async () => {
    const logger = recordingLogger();
    const runner = makeRunner("linger", { exitGraceMs: 200, logger });
    const { result } = await playOn(runner, { limits: LINGER });
    expect(result).toMatchObject({ outcome: "ok", text: "Finished; the dev server is still running." });
    expect(result.error).toBeUndefined();
    expect(result.durationMs).toBeLessThan(10_000);
    expect(isAlive(recorded().pid)).toBe(false);
    expect(logger.lines).toContainEqual(
      expect.objectContaining({ level: "warn", msg: "stopping claude run job-1: it did not exit within 200 ms of its result" }),
    );
  });

  it("lets a new turn after the result run past the grace, and keeps its later result", async () => {
    const runner = makeRunner("result-then-new-turn", { exitGraceMs: 1_500 });
    const { result } = await playOn(runner, { limits: LINGER });
    expect(result).toMatchObject({ outcome: "ok", text: "Second answer.", exitCode: 0 });
  });

  it("still reports a caller's abort after the result as the result", async () => {
    const controller = new AbortController();
    const onEvent = (e: RunEvent) => {
      if (e.type === "usage") controller.abort();
    };
    const runner = makeRunner("linger", { exitGraceMs: 60_000 });
    const { result } = await playOn(runner, { limits: LINGER }, { signal: controller.signal, onEvent });
    expect(result.outcome).toBe("ok");
    expect(isAlive(recorded().pid)).toBe(false);
  });
});

describe("Claude positive launch policy", () => {
  it("omits unrelated parent values from the actual worker", async () => {
    vi.stubEnv("MC_UNRELATED_SECRET", "synthetic-secret");
    await makeRunner("success", { env: scenarioEnv("success", { MC_UNRELATED_SECRET: "synthetic-secret" }) }).run(makeJob());
    expect(recorded().env).not.toHaveProperty("MC_UNRELATED_SECRET");
    expect(recorded().env).not.toHaveProperty("FAKE_CLAUDE_SCENARIO");
  });
});

describe("Claude environment preparation failure", () => {
  it("returns a local structured failure without launching or echoing the invalid value", async () => {
    const result = await makeRunner("success", { path: ["/mnt/c/synthetic-private-value"] }).run(makeJob());
    expect(result.outcome).toBe("crashed");
    expect(result.error).toContain("path[0]");
    expect(result.error).not.toContain("synthetic-private-value");
    expect(existsSync(recordPath)).toBe(false);
    expect(readdirSync(promptTmp)).toEqual([]);
  });
});

describe("Claude temporary-root validation", () => {
  it("rejects traversal in controller temp settings before normalization", async () => {
    const result = await makeRunner("success", { tmpDir: promptTmp + "/../" + basename(promptTmp) }).run(makeJob());
    expect(result.outcome).toBe("crashed");
    expect(result.error).toContain("tmpDir");
    expect(existsSync(recordPath)).toBe(false);
  });
});

describe("Claude allowance field normalization", () => {
  it.each([{ value: undefined }, { value: null }, { value: "private-payload" }, { value: [] }, { value: 3 }])(
    "keeps an exact known window with non-record payload unknown: %j", ({ value }) => {
      expect(claudeAllowanceInput("five_hour", value)).toEqual({
        window: "five_hour", utilization: null, reset: { kind: "omitted" },
      });
    },
  );
  it.each([undefined, null, "private-reset", Number.NaN, Infinity])("keeps an own malformed reset %s supplied", (resetsAt) => {
    expect(claudeAllowanceInput("five_hour", { utilization: 0.4, resetsAt })).toEqual({
      window: "five_hour", utilization: 0.4, reset: { kind: "supplied", value: null },
    });
  });
  it("keeps reset omission distinct and finite implausible values numeric", () => {
    expect(claudeAllowanceInput("five_hour", { utilization: 0.4 })).toEqual({
      window: "five_hour", utilization: 0.4, reset: { kind: "omitted" },
    });
    expect(claudeAllowanceInput("five_hour", { utilization: 0.4, resetsAt: 1 })).toEqual({
      window: "five_hour", utilization: 0.4, reset: { kind: "supplied", value: 1000 },
    });
  });
  it.each(["Five_hour", "five/hour", " five_hour", "five_hour\u0000"])("rejects the raw window identity %j", (window) => {
    expect(claudeAllowanceInput(window, { utilization: 0.4 })).toBeUndefined();
  });
});
