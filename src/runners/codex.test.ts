import { execFileSync, spawn } from "node:child_process";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { detectLimitText, parseResetTime } from "../limits.js";
import type { AgentJob, JsonSchema, RunEvent } from "../types.js";
import * as worktreeGuard from "./worktree-guard.js";
import { CodexRunner, PROMPT_SEPARATOR, type CodexRunnerOptions } from "./codex.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const HOUR_MS = 3_600_000;
/** Fixture steps (see fake-codex.mjs), joined by "+". */
const SUCCESS = "start+work+finish";
/** Codex's usage for every finished fake turn, as the runner should report it. */
const FAKE_USAGE = { inputTokens: 400, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 50 };
const INVALID_TOOL_CALL = "The model produced an invalid tool call";

const SCHEMA: JsonSchema = {
  type: "object",
  properties: { ok: { type: "boolean" }, note: { type: ["string", "null"] } },
  required: ["ok", "note"],
  additionalProperties: false,
};

interface FakeRecord {
  argv: string[];
  cwd: string;
  stdin: string;
  env: Record<string, string>;
  schema: unknown;
  pid: number;
}

let root: string;
let fakeCodex: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mc-codex-test-"));
  mkdirSync(join(root, "bin"));
  fakeCodex = join(root, "bin", "codex");
  copyFileSync(FIXTURE, fakeCodex);
  chmodSync(fakeCodex, 0o755);
});

afterEach(() => { vi.unstubAllEnvs(); });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixtureOptions(values: NodeJS.ProcessEnv) {
  const configHome = mkdtempSync(join(root, "provider-config-"));
  writeFileSync(join(configHome, "mc-fixture.json"), JSON.stringify(Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith("FAKE_")))));
  return { configHome, path: [dirname(process.execPath), "/usr/bin", "/bin"] };
}

function makeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: "job-1",
    role: "engineer",
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    cwd: "/work/unit",
    systemPrompt: "You are the engineer.",
    prompt: "Implement the feature.",
    access: "workspace-write",
    limits: { maxTurns: 40, timeoutMs: 20_000 },
    ...overrides,
  };
}

interface ScenarioOptions {
  job?: Partial<AgentJob>;
  runner?: Partial<CodexRunnerOptions>;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

/** Runs the fake codex with a scenario, in a fresh temp dir that is the job's cwd. */
async function runScenario(scenario: string, opts: ScenarioOptions = {}) {
  const dir = mkdtempSync(join(root, "run-"));
  const recordFile = join(dir, "record.json");
  const tmp = join(dir, "tmp");
  const envRecord = join(dir, "env-record.ndjson");
  const runner = new CodexRunner({
    command: fakeCodex,
    writeSandbox: "danger-full-access",
    tmpDir: tmp,
    ...fixtureOptions({ FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_RECORD: recordFile, FAKE_CODEX_ENV_RECORD: envRecord, ...opts.env }),
    ...opts.runner,
  });
  const events: RunEvent[] = [];
  const result = await runner.run(makeJob({ cwd: dir, ...opts.job }), {
    onEvent: (event) => {
      events.push(event);
      opts.onEvent?.(event);
    },
    ...(opts.signal !== undefined && { signal: opts.signal }),
  });
  const record = existsSync(recordFile) ? (JSON.parse(readFileSync(recordFile, "utf8")) as FakeRecord) : undefined;
  return { result, events, record, dir, tmp, envRecord };
}

function progressTexts(events: RunEvent[]): string[] {
  return events.flatMap((e) => (e.type === "progress" ? [e.text] : []));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("CodexRunner.buildArgs", () => {
  const files = { lastMessageFile: "/tmp/x/last-message.txt" };

  it("builds a read-only exec with the prompt on stdin", () => {
    const runner = new CodexRunner({ writeSandbox: "danger-full-access" });
    const args = runner.buildArgs(makeJob({ access: "read-only", effort: "medium" }), files);
    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "/work/unit",
      "-m",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="medium"',
      "-c",
      'approval_policy="never"',
      "-s",
      "read-only",
      "-o",
      "/tmp/x/last-message.txt",
      "-",
    ]);
  });

  it("uses the configured write sandbox for workspace-write jobs", () => {
    const runner = new CodexRunner({ writeSandbox: "danger-full-access" });
    const args = runner.buildArgs(makeJob(), files);
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", "danger-full-access"]);
    expect(args.join(" ")).not.toContain("network_access");
  });

  it("enables network access when the write sandbox is workspace-write", () => {
    const runner = new CodexRunner({ writeSandbox: "workspace-write" });
    const args = runner.buildArgs(makeJob(), files);
    const s = args.indexOf("-s");
    expect(args.slice(s, s + 4)).toEqual(["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"]);
  });

  it("does not enable network access for read-only jobs", () => {
    const runner = new CodexRunner({ writeSandbox: "workspace-write" });
    const args = runner.buildArgs(makeJob({ access: "read-only" }), files);
    expect(args).toContain("read-only");
    expect(args.join(" ")).not.toContain("network_access");
  });

  it("runs noTools jobs in the read-only sandbox, whatever their access", () => {
    const runner = new CodexRunner({ writeSandbox: "workspace-write" });
    const args = runner.buildArgs(makeJob({ access: "workspace-write", noTools: true }), files);
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", "read-only"]);
    expect(args.join(" ")).not.toContain("network_access");
    const resumed = runner.buildArgs(makeJob({ noTools: true, resumeSessionId: "t" }), files);
    expect(resumed).toContain('sandbox_mode="read-only"');
  });

  it("passes the output schema before -o and keeps max effort as max", () => {
    const runner = new CodexRunner({ writeSandbox: "danger-full-access" });
    const args = runner.buildArgs(makeJob({ effort: "max" }), { ...files, schemaFile: "/tmp/x/schema.json" });
    expect(args).toContain('model_reasoning_effort="max"');
    expect(args.slice(-5)).toEqual(["--output-schema", "/tmp/x/schema.json", "-o", "/tmp/x/last-message.txt", "-"]);
  });

  it("resumes with the same -m/-c flags and the sandbox as config", () => {
    const runner = new CodexRunner({ writeSandbox: "workspace-write" });
    const args = runner.buildArgs(makeJob({ resumeSessionId: "thread-42" }), files);
    expect(args).not.toContain("-s");
    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      "/work/unit",
      "-m",
      "gpt-6.1-sol",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-o",
      "/tmp/x/last-message.txt",
      "resume",
      "thread-42",
      "-",
    ]);
  });

  it("writes every -c override as key=<TOML value>, strings double-quoted", () => {
    const runner = new CodexRunner({ writeSandbox: "workspace-write" });
    for (const job of [makeJob(), makeJob({ access: "read-only" }), makeJob({ resumeSessionId: "t" })]) {
      const args = runner.buildArgs(job, files);
      const overrides = args.flatMap((a, i) => (args[i - 1] === "-c" ? [a] : []));
      expect(overrides.length).toBeGreaterThanOrEqual(2);
      for (const value of overrides) expect(value).toMatch(/^[a-z_.]+=("[a-z-]+"|true)$/);
    }
  });
});

describe("fake codex fixture", () => {
  it("blocks until stdin is closed, like the real CLI", async () => {
    const child = spawn(process.execPath, [FIXTURE, "exec", "--json", "-"], {
      env: { CODEX_HOME: fixtureOptions({ FAKE_CODEX_SCENARIO: SUCCESS }).configHome },
      stdio: "pipe",
    });
    try {
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(child.exitCode).toBeNull();
      expect(stdout).toBe("");
      child.stdin.end("the prompt");
      expect(await closed).toBe(0);
      expect(stdout).toContain('"type":"thread.started"');
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("CodexRunner.run", () => {
  it("returns ok for a successful run, even when the agent's message talks about limits (decision 1)", async () => {
    const { result, events, record } = await runScenario(SUCCESS);
    expect(result.outcome).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("thread-123");
    expect(result.text).toContain("You've hit your usage limit");
    expect(detectLimitText(result.text, "codex", Date.now())).toBeDefined(); // would be a limit if we scanned it
    expect(result.limit).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.usage).toEqual(FAKE_USAGE);
    expect(events[0]).toEqual({ type: "started", sessionId: "thread-123" });
    expect(progressTexts(events)).toEqual([
      "$ bash -lc 'npm test'",
      "update src/app.ts, add src/limit.ts",
      expect.stringContaining("Added the quota banner"),
    ]);
    expect(events.filter((e) => e.type === "usage")).toEqual([{ type: "usage", usage: result.usage }]);
    expect(events.some((e) => e.type === "limit")).toBe(false);
    expect(isAlive(record!.pid)).toBe(false);
  });

  it("sends the system prompt and the job prompt on stdin, then closes it", async () => {
    const prompt = `Implement it.\n${"x".repeat(300_000)}`; // above Linux's 128 KiB argv string cap
    const { result, record } = await runScenario(SUCCESS, { job: { systemPrompt: "SYSTEM RULES", prompt } });
    expect(result.outcome).toBe("ok"); // the fake would hang (→ timeout) had stdin stayed open
    expect(record!.stdin).toBe(`SYSTEM RULES${PROMPT_SEPARATOR}${prompt}`);
    expect(PROMPT_SEPARATOR).toBe("\n\n---\n\n");
    expect(record!.argv.at(-1)).toBe("-");
    expect(record!.argv.some((a) => a.includes("Implement it."))).toBe(false);
  });

  it("sends only the job prompt when there is no system prompt", async () => {
    const { record } = await runScenario(SUCCESS, { job: { systemPrompt: "  ", prompt: "Just this." } });
    expect(record!.stdin).toBe("Just this.");
  });

  it("omits API keys and unrelated values and runs in the job's cwd", async () => {
    for (const [name, value] of Object.entries({ OPENAI_API_KEY: "sk-test", CODEX_API_KEY: "ck-test", ANTHROPIC_API_KEY: "ak-test", KEEP_ME: "yes" })) vi.stubEnv(name, value);
    const { record, dir } = await runScenario(SUCCESS, {
      env: { OPENAI_API_KEY: "sk-test", CODEX_API_KEY: "ck-test", ANTHROPIC_API_KEY: "ak-test", KEEP_ME: "yes" },
    });
    expect(record!.env.OPENAI_API_KEY).toBeUndefined();
    expect(record!.env.CODEX_API_KEY).toBeUndefined();
    expect(record!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(record!.env.KEEP_ME).toBeUndefined();
    expect(record!.env.PATH).toBe([dirname(process.execPath), "/usr/bin", "/bin"].join(":"));
    expect(realpathSync(record!.cwd)).toBe(realpathSync(dir));
    expect(record!.argv.slice(3, 5)).toEqual(["-C", dir]);
  });

  it("tees the raw event stream to the job's log file", async () => {
    const dir = mkdtempSync(join(root, "log-"));
    const logFile = join(dir, "logs", "job-1.ndjson");
    const { result } = await runScenario(SUCCESS, { job: { logFile } });
    expect(result.outcome).toBe("ok");
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(JSON.parse(lines[0]!)).toEqual({ type: "thread.started", thread_id: "thread-123" });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: "turn.completed" });
  });

  it("treats Reconnecting error events that recover as progress, not failure", async () => {
    const { result, events } = await runScenario("start+throttled-retries+work+finish");
    expect(result.outcome).toBe("ok");
    expect(result.limit).toBeUndefined();
    expect(progressTexts(events).slice(0, 2)).toEqual([
      "Reconnecting... 1/5 (stream error: rate limit exceeded; retrying in 1s)",
      "Reconnecting... 2/5 (unexpected status 429 Too Many Requests)",
    ]);
  });

  it("parses events glued onto one line with junk before them", async () => {
    const { result, events } = await runScenario("glued");
    expect(result.outcome).toBe("ok");
    expect(result.sessionId).toBe("thread-glued");
    expect(result.usage).toEqual(FAKE_USAGE);
    expect(events[0]).toEqual({ type: "started", sessionId: "thread-glued" });
  });

  describe("structured output", () => {
    it("writes the schema to a temp file, reads the -o file and validates it", async () => {
      const message = '{"ok": true, "note": "all green"}';
      const { result, record, tmp } = await runScenario("start+finish", {
        job: { outputSchema: SCHEMA },
        env: { FAKE_CODEX_MESSAGE: message },
      });
      expect(result.outcome).toBe("ok");
      expect(result.structured).toEqual({ ok: true, note: "all green" });
      expect(result.text).toBe(message);
      expect(record!.schema).toEqual(SCHEMA);
      const schemaFlag = record!.argv.indexOf("--output-schema");
      expect(record!.argv[schemaFlag + 2]).toBe("-o");
      expect(readdirSync(tmp)).toEqual([]); // per-run temp files are removed
    });

    it("falls back to the final agent message when the -o file was not written", async () => {
      const { result } = await runScenario("start+finish-without-file", {
        job: { outputSchema: SCHEMA },
        env: { FAKE_CODEX_MESSAGE: '{"ok": false, "note": null}' },
      });
      expect(result.outcome).toBe("ok");
      expect(result.structured).toEqual({ ok: false, note: null });
    });

    it("fails on invalid JSON in the -o file", async () => {
      const { result } = await runScenario("start+finish", {
        job: { outputSchema: SCHEMA },
        env: { FAKE_CODEX_MESSAGE: '{"ok": tru' },
      });
      expect(result.outcome).toBe("failed");
      expect(result.error).toMatch(/^invalid structured output: no JSON object/);
      expect(result.structured).toBeUndefined();
    });

    it("fails when the JSON does not match the schema", async () => {
      const { result } = await runScenario("start+finish", {
        job: { outputSchema: SCHEMA },
        env: { FAKE_CODEX_MESSAGE: '{"ok": "yes"}' },
      });
      expect(result.outcome).toBe("failed");
      expect(result.error).toMatch(/^invalid structured output: /);
      expect(result.error).toContain("ok");
    });

    it("does not pass --output-schema without a schema", async () => {
      const { record } = await runScenario(SUCCESS);
      expect(record!.argv).not.toContain("--output-schema");
      expect(record!.schema).toBeNull();
    });
  });

  describe("failures", () => {
    it("reports a usage-limit turn.failed as limited with the reset time", async () => {
      const before = Date.now();
      const { result, events } = await runScenario("start+usage-limit");
      expect(result.outcome).toBe("limited");
      expect(result.exitCode).toBe(1);
      const limit = result.limit!;
      expect(limit.provider).toBe("codex");
      expect(limit.raw).toContain("You've hit your usage limit");
      expect(limit.resetsAt).toBe(parseResetTime("try again at 3:45 PM.", before));
      expect(limit.kind).toBe(limit.resetsAt! - before < 6 * HOUR_MS ? "session" : "weekly");
      expect(result.error).toBe(limit.raw);
      expect(events.filter((e) => e.type === "limit")).toEqual([{ type: "limit", info: limit }]);
    });

    it("reports a limit carried only by an error event once the run has failed", async () => {
      const { result } = await runScenario("start+usage-limit-error");
      expect(result.outcome).toBe("limited");
      expect(result.limit?.raw).toContain("usage limit");
    });

    it("reports a 401 as auth", async () => {
      const { result } = await runScenario("start+auth");
      expect(result.outcome).toBe("auth");
      expect(result.error).toContain("401 Unauthorized");
      expect(result.limit).toBeUndefined();
    });

    it("reports a login error on stderr as auth", async () => {
      const { result } = await runScenario("not-logged-in");
      expect(result.outcome).toBe("auth");
      expect(result.error).toBe("Error: Not logged in. Run `codex login` first.");
    });

    it("reports a usage limit printed only on stderr as limited", async () => {
      const { result } = await runScenario("start+usage-limit-stderr");
      expect(result.outcome).toBe("limited");
      expect(result.limit?.raw).toContain("You've hit your usage limit");
      expect(result.limit?.resetsAt).toBeDefined();
    });

    it("reports an expired refresh token as auth", async () => {
      const { result } = await runScenario("start+refresh-token");
      expect(result.outcome).toBe("auth");
      expect(result.error).toContain("could not be refreshed");
    });

    it("reports a 403 as auth", async () => {
      const { result } = await runScenario("start+forbidden");
      expect(result.outcome).toBe("auth");
      expect(result.error).toContain("403 Forbidden");
    });

    it.each([
      ["a lost connection", "start+work+offline", "stream disconnected before completion: error sending request for url"],
      ["a server error", "start+server-error", "unexpected status 503 Service Unavailable"],
      ["an HTTP 500 (codex's high-demand text)", "start+high-demand", "We’re currently experiencing high demand"],
      ["spent retries on a 500", "start+retry-limit-500", "exceeded retry limit, last status: 500"],
    ])("reports %s as a throttle, not as the agent's failure", async (_, scenario, text) => {
      const { result, events } = await runScenario(scenario);
      expect(result.outcome).toBe("limited");
      expect(result.limit).toMatchObject({ provider: "codex", kind: "throttle", raw: expect.stringContaining(text) });
      expect(result.error).toContain(text);
      expect(events.filter((e) => e.type === "limit")).toHaveLength(1);
    });

    it("reports any other turn.failed as failed", async () => {
      const { result } = await runScenario("start+work+turn-failed");
      expect(result.outcome).toBe("failed");
      expect(result.error).toBe(INVALID_TOOL_CALL);
    });

    describe("turn.failed decides over earlier noise", () => {
      it("ignores throttled retries that recovered, though stderr still shows them", async () => {
        const { result } = await runScenario("start+throttled-retries+work+turn-failed");
        expect(result.outcome).toBe("failed");
        expect(result.error).toBe(INVALID_TOOL_CALL);
        expect(result.limit).toBeUndefined();
      });

      it("ignores a 429 retry notice that came right before it", async () => {
        const { result, events } = await runScenario("start+retry-429+turn-failed");
        expect(result.outcome).toBe("failed");
        expect(result.error).toBe(INVALID_TOOL_CALL);
        expect(events.some((e) => e.type === "limit")).toBe(false);
      });

      it("ignores unrelated authentication warnings on stderr", async () => {
        const { result } = await runScenario("mcp-auth-warning+start+work+turn-failed");
        expect(result.outcome).toBe("failed");
        expect(result.error).toBe(INVALID_TOOL_CALL);
      });
    });

    it("reports a crash without turn.failed as crashed, with the stderr tail", async () => {
      const { result } = await runScenario("start+work+panic");
      expect(result.outcome).toBe("crashed");
      expect(result.exitCode).toBe(101);
      expect(result.error).toMatch(/^codex exited with code 101 without completing the turn: .*panicked/s);
    });

    it("does not mistake a 401 inside a port number for a login failure", async () => {
      const { result } = await runScenario("start+work+panic");
      expect(result.error).toContain(":40123");
      expect(result.outcome).toBe("crashed");
    });

    it("reports a crash after recovered throttled retries as crashed, not limited", async () => {
      const { result } = await runScenario("start+throttled-retries+work+panic");
      expect(result.outcome).toBe("crashed");
      expect(result.limit).toBeUndefined();
      expect(result.error).toContain("panicked");
    });

    it("does not read an MCP server's authentication warning as a login failure", async () => {
      const { result } = await runScenario("mcp-auth-warning+start+work+panic");
      expect(result.outcome).toBe("crashed");
      expect(result.error).toContain("requires OAuth authentication");
    });

    it("says so when codex exits with an error after completing the turn", async () => {
      const { result } = await runScenario("start+work+finish+exit-error");
      expect(result.outcome).toBe("crashed");
      expect(result.error).toBe(
        "codex exited with code 1 after completing the turn: Error: failed to write last message file",
      );
    });

    it("reports exit 0 without turn.completed as crashed", async () => {
      const { result } = await runScenario("thread-only");
      expect(result.outcome).toBe("crashed");
      expect(result.sessionId).toBe("thread-short");
      expect(result.error).toBe("codex exited with code 0 without completing the turn");
    });

    it("rejects an unquoted -c override (the fake checks TOML syntax like the real CLI)", async () => {
      const child = spawn(process.execPath, [FIXTURE, "exec", "-c", "model_reasoning_effort=high", "-"], { stdio: "pipe" });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.stdin.end("prompt");
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(code).toBe(2);
      expect(stderr).toContain("invalid -c override");
    });
  });

  describe("process control", () => {
    it("times out and kills a hung codex", async () => {
      const { result, record } = await runScenario("start+hang", { job: { limits: { maxTurns: 1, timeoutMs: 500 } } });
      expect(result.outcome).toBe("timeout");
      expect(result.error).toBe("timed out after 500 ms");
      expect(result.sessionId).toBe("thread-123");
      expect(isAlive(record!.pid)).toBe(false);
    });

    it("reports a timeout after recovered throttled retries as timeout, not limited", async () => {
      const { result } = await runScenario("start+throttled-retries+work+hang", {
        job: { limits: { maxTurns: 1, timeoutMs: 500 } },
      });
      expect(result.outcome).toBe("timeout");
      expect(result.limit).toBeUndefined();
    });

    describe("a codex waiting for the network", () => {
      it("is stopped after the stall time and reported as a throttle, not left to time out", async () => {
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const { result, record } = await runScenario("start+work+waiting-for-network", {
          job: { limits: { maxTurns: 1, timeoutMs: 20_000 } },
          runner: { stallMs: 300, logger },
        });
        expect(result.outcome).toBe("limited");
        expect(result.limit).toMatchObject({ provider: "codex", kind: "throttle", raw: expect.stringContaining("waiting for network") });
        expect(result.durationMs).toBeLessThan(10_000);
        expect(isAlive(record!.pid)).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(
          "codex is stuck retrying a connection or server problem; stopping it",
          expect.objectContaining({ job: "job-1", stallMs: 300 }),
        );
      });

      it("is reported as a throttle when the job timeout hits first", async () => {
        const { result } = await runScenario("start+waiting-for-network", { job: { limits: { maxTurns: 1, timeoutMs: 500 } } });
        expect(result.outcome).toBe("limited");
        expect(result.limit).toMatchObject({ provider: "codex", kind: "throttle" });
      });

      it("keeps going when the connection comes back before the stall time, however long the run then takes", async () => {
        // The outage starts the stall clock (1.5 s); the progress at 250 ms stops it, so the 1.8 s of quiet work after it is safe.
        const { result } = await runScenario("start+brief-outage+work+pause+finish", { runner: { stallMs: 1_500 } });
        expect(result.outcome).toBe("ok");
        expect(result.limit).toBeUndefined();
      });
    });

    it("reports a codex still retrying a 429 when the timeout hits as throttled", async () => {
      const { result } = await runScenario("start+retry-429+hang", { job: { limits: { maxTurns: 1, timeoutMs: 500 } } });
      expect(result.outcome).toBe("limited");
      expect(result.limit).toMatchObject({ provider: "codex", kind: "throttle" });
    });

    describe("a codex that does not exit after its turn ended", () => {
      const LINGER = { maxTurns: 1, timeoutMs: 20_000 };

      it("is stopped after the exit grace, and the finished turn stands", async () => {
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        const { result, record } = await runScenario("start+finish+hang", {
          job: { outputSchema: SCHEMA, limits: LINGER },
          runner: { exitGraceMs: 200, logger },
          env: { FAKE_CODEX_MESSAGE: '{"ok": true, "note": null}' },
        });
        expect(result.outcome).toBe("ok");
        expect(result.structured).toEqual({ ok: true, note: null });
        expect(result.usage).toEqual(FAKE_USAGE);
        expect(result.durationMs).toBeLessThan(LINGER.timeoutMs);
        expect(isAlive(record!.pid)).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(
          "codex did not exit after its turn ended; stopping it",
          expect.objectContaining({ job: "job-1" }),
        );
      });

      it("keeps the finished turn when the job timeout hits first", async () => {
        const { result } = await runScenario("start+finish+hang", {
          job: { limits: { maxTurns: 1, timeoutMs: 500 } },
          runner: { exitGraceMs: 60_000 },
        });
        expect(result.outcome).toBe("ok");
        expect(result.error).toBeUndefined();
      });

      it("is stopped after a failed turn too, which still decides the outcome", async () => {
        const { result } = await runScenario("start+turn-failed+hang", {
          job: { limits: LINGER },
          runner: { exitGraceMs: 200 },
        });
        expect(result.outcome).toBe("failed");
        expect(result.error).toBe(INVALID_TOOL_CALL);
        expect(result.durationMs).toBeLessThan(LINGER.timeoutMs);
      });

      it("reports a caller's abort as aborted", async () => {
        const controller = new AbortController();
        const { result } = await runScenario("start+finish+hang", {
          job: { limits: LINGER },
          runner: { exitGraceMs: 60_000 },
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "usage") controller.abort();
          },
        });
        expect(result.outcome).toBe("aborted");
      });
    });

    it("aborts a running codex when the signal fires", async () => {
      const controller = new AbortController();
      const { result, record } = await runScenario("start+hang", {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "started") controller.abort();
        },
      });
      expect(result.outcome).toBe("aborted");
      expect(isAlive(record!.pid)).toBe(false);
    });

    it("does not start codex when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const { result, record } = await runScenario(SUCCESS, { signal: controller.signal });
      expect(result.outcome).toBe("aborted");
      expect(record).toBeUndefined();
    });

    it("reports a missing CLI as crashed", async () => {
      const { result } = await runScenario(SUCCESS, { runner: { command: join(root, "bin", "no-such-codex") } });
      expect(result.outcome).toBe("crashed");
      expect(result.error).toMatch(/^codex CLI not found or failed to start: ENOENT/);
    });

    it("reports unusable temp space as crashed without starting codex", async () => {
      const blocker = join(root, "not-a-dir");
      writeFileSync(blocker, "");
      const { result, record } = await runScenario(SUCCESS, { runner: { tmpDir: join(blocker, "tmp") } });
      expect(result.outcome).toBe("crashed");
      expect(result.error).toMatch(/^cannot create temp files for codex/);
      expect(record).toBeUndefined();
    });

    it("reports an unwritable output schema as crashed without starting codex", async () => {
      const { result, record } = await runScenario("start+finish", { job: { outputSchema: { type: "object", bad: 1n } } });
      expect(result.outcome).toBe("crashed");
      expect(result.error).toMatch(/^cannot write the output schema for codex/);
      expect(record).toBeUndefined();
    });

    it("survives an onEvent handler that throws, and logs it", async () => {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const { result } = await runScenario(SUCCESS, {
        runner: { logger },
        onEvent: () => {
          throw new Error("listener bug");
        },
      });
      expect(result.outcome).toBe("ok");
      expect(result.usage).toEqual(FAKE_USAGE);
      expect(logger.warn).toHaveBeenCalledWith("codex runner: onEvent handler threw", {
        job: "job-1",
        error: "listener bug",
      });
      expect(logger.info).toHaveBeenCalledWith("codex run finished", expect.objectContaining({ outcome: "ok" }));
    });
  });
});

describe("CodexRunner: read-only jobs where codex's sandbox cannot start (the Docker container)", () => {
  /** A git repository with one tracked file, as a unit worktree. */
  function gitRepo(): string {
    const repo = mkdtempSync(join(root, "repo-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "app.ts"), "export const app = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "initial");
    return repo;
  }

  function runnerFor(env: Record<string, string>, opts: Partial<CodexRunnerOptions> = {}) {
    const dir = mkdtempSync(join(root, "ro-"));
    const record = join(dir, "record.json");
    const calls = join(dir, "calls.log");
    const runner = new CodexRunner({
      command: fakeCodex,
      writeSandbox: "danger-full-access",
      tmpDir: join(dir, "tmp"),
      ...fixtureOptions({ FAKE_CODEX_RECORD: record, FAKE_CODEX_CALLS: calls, ...env }),
      ...opts,
    });
    return {
      runner,
      record: () => JSON.parse(readFileSync(record, "utf8")) as FakeRecord,
      calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
    };
  }

  const readOnlyJob = (cwd: string): AgentJob => makeJob({ access: "read-only", cwd, role: "reviewer" });

  it("runs them without codex's sandbox, says so in the brief, and puts back what they change", async () => {
    const repo = gitRepo();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { runner, record } = runnerFor(
      { FAKE_CODEX_SCENARIO: "start+write-file+finish", FAKE_CODEX_SANDBOX: "broken", FAKE_CODEX_WRITE_FILE: "app.ts" },
      { logger },
    );
    const events: RunEvent[] = [];
    const result = await runner.run(readOnlyJob(repo), { onEvent: (e) => events.push(e) });
    expect(result.outcome).toBe("ok");
    const argv = record().argv;
    expect(argv.slice(argv.indexOf("-s"), argv.indexOf("-s") + 2)).toEqual(["-s", "danger-full-access"]);
    expect(record().stdin).toContain("do not create, change or delete any file");
    expect(readFileSync(join(repo, "app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(progressTexts(events)).toContain("read-only run changed files, put back: app.ts");
    expect(result.readonlyMutation).toBe("restored");
    expect(logger.warn).toHaveBeenCalledWith(
      "codex's read-only sandbox does not work here; read-only jobs run without it, and changes they make are undone",
      { detail: expect.stringContaining("bwrap: No permissions to create a new namespace") },
    );
  });

  it("probes the sandbox once per runner", async () => {
    const repo = gitRepo();
    const { runner, calls } = runnerFor({ FAKE_CODEX_SCENARIO: SUCCESS, FAKE_CODEX_SANDBOX: "broken" });
    expect((await runner.run(readOnlyJob(repo))).readonlyMutation).toBeUndefined();
    expect((await runner.run(readOnlyJob(repo))).readonlyMutation).toBeUndefined();
    expect(calls().filter((c) => c.startsWith("sandbox"))).toEqual(['sandbox -c sandbox_mode="read-only" -- true']);
  });

  it("marks an unsandboxed read-only run unknown without a worktree guard", async () => {
    const plain = mkdtempSync(join(root, "unguarded-"));
    const { runner } = runnerFor({ FAKE_CODEX_SCENARIO: SUCCESS, FAKE_CODEX_SANDBOX: "broken" });
    const result = await runner.run(readOnlyJob(plain));
    expect(result).toMatchObject({ outcome: "ok", readonlyMutation: "unknown" });
  });

  it("marks restoration failure unknown without changing the existing run outcome", async () => {
    const repo = gitRepo();
    const spy = vi.spyOn(worktreeGuard, "restoreWorktree").mockRejectedValueOnce(new Error("synthetic restore failure"));
    try {
      const { runner } = runnerFor({ FAKE_CODEX_SCENARIO: SUCCESS, FAKE_CODEX_SANDBOX: "broken" });
      expect(await runner.run(readOnlyJob(repo))).toMatchObject({ outcome: "ok", readonlyMutation: "unknown" });
    } finally { spy.mockRestore(); }
  });

  it("keeps codex's read-only sandbox where it works", async () => {
    const repo = gitRepo();
    const { runner, record } = runnerFor({ FAKE_CODEX_SCENARIO: "start+write-file+finish", FAKE_CODEX_WRITE_FILE: "new.txt" });
    expect((await runner.run(readOnlyJob(repo))).outcome).toBe("ok");
    expect(record().argv).toContain("read-only");
    expect(record().stdin).not.toContain("do not create, change or delete any file");
    // The fake ignores the sandbox; nothing is undone, because codex's own sandbox is trusted to block it.
    expect(existsSync(join(repo, "new.txt"))).toBe(true);
  });

  it("does not probe when write jobs use codex's own sandbox too (outside the container)", async () => {
    const repo = gitRepo();
    const { runner, record, calls } = runnerFor({ FAKE_CODEX_SCENARIO: SUCCESS, FAKE_CODEX_SANDBOX: "broken" }, { writeSandbox: "workspace-write" });
    await runner.run(readOnlyJob(repo));
    expect(record().argv).toContain("read-only");
    expect(calls().some((c) => c.startsWith("sandbox"))).toBe(false);
  });

  it("leaves write jobs and noTools jobs as they were", async () => {
    const repo = gitRepo();
    const { runner, record } = runnerFor({ FAKE_CODEX_SCENARIO: SUCCESS, FAKE_CODEX_SANDBOX: "broken" });
    await runner.run(makeJob({ cwd: repo }));
    expect(record().argv).toContain("danger-full-access");
    expect(record().stdin).not.toContain("read-only task");
    await runner.run(makeJob({ cwd: repo, access: "read-only", noTools: true }));
    expect(record().argv).toContain("read-only");
    expect(record().stdin).not.toContain("read-only task");
  });
});

describe("CodexRunner: login and usage windows from codex's app server", () => {
  const RATE_LIMITS = {
    limitId: "codex",
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1791600000 },
    secondary: { usedPercent: 17.5, windowDurationMins: 10080, resetsAt: 1792000000 },
  };
  const WINDOWS = [
    { window: "five_hour", utilization: 0.42, reset: { kind: "supplied", value: 1791600000000 } },
    { window: "seven_day", utilization: 0.175, reset: { kind: "supplied", value: 1792000000000 } },
  ];

  function runnerFor(env: Record<string, string>, opts: Partial<CodexRunnerOptions> = {}) {
    const dir = mkdtempSync(join(root, "as-"));
    const record = join(dir, "record.json");
    const calls = join(dir, "calls.log");
    const runner = new CodexRunner({
      command: fakeCodex,
      writeSandbox: "workspace-write",
      tmpDir: join(dir, "tmp"),
      ...fixtureOptions({ FAKE_CODEX_SCENARIO: SUCCESS, FAKE_CODEX_RECORD: record, FAKE_CODEX_CALLS: calls, ...env }),
      ...opts,
    });
    const run = async (signal?: AbortSignal) => {
      const events: RunEvent[] = [];
      const result = await runner.run(makeJob({ cwd: dir }), { onEvent: (e) => events.push(e), ...(signal && { signal }) });
      return { result, events, allowance: events.flatMap((e) => (e.type === "allowance" ? e.observations : [])) };
    };
    return {
      run,
      started: () => existsSync(record),
      calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []),
    };
  }

  it.each([
    ["an API key", "apiKey", "logged in with an API key"],
    ["Amazon Bedrock", "amazonBedrock", "Amazon Bedrock"],
    ["no login", "none", "not logged in"],
  ])("refuses to run on %s, which bills outside the ChatGPT plan, as a login problem", async (_, account, text) => {
    const { run, started, calls } = runnerFor({ FAKE_CODEX_ACCOUNT: account });
    const first = await run();
    expect(first.result.outcome).toBe("auth");
    expect(first.result.error).toContain(text);
    expect(first.result.error).toContain("codex login --device-auth");
    expect(started()).toBe(false);
    expect((await run()).result.outcome).toBe("auth");
    expect(calls().filter((c) => c === "app-server account/read")).toHaveLength(1); // asked once per runner
  });

  it.each([
    ["a ChatGPT login", { FAKE_CODEX_ACCOUNT: "chatgpt" }],
    ["a codex without the app server", { FAKE_CODEX_APP_SERVER: "missing" }],
  ])("runs on %s", async (_, env) => {
    const { run, started } = runnerFor(env);
    expect((await run()).result.outcome).toBe("ok");
    expect(started()).toBe(true);
  });

  it("does not wait long for an app server that never answers", async () => {
    const { run, started } = runnerFor({ FAKE_CODEX_APP_SERVER: "hang" }, { appServerTimeoutMs: 300 });
    const begun = Date.now();
    expect((await run()).result.outcome).toBe("ok");
    expect(started()).toBe(true);
    expect(Date.now() - begun).toBeLessThan(10_000);
  });

  it("reports the usage windows before the first run and after each run, so pacing covers codex", async () => {
    const { run, calls } = runnerFor({ FAKE_CODEX_RATE_LIMITS: JSON.stringify(RATE_LIMITS) }, { usagePollIntervalMs: 0 });
    const first = await run();
    expect(first.events.filter((e) => e.type === "allowance")).toHaveLength(2);
    expect(first.events.filter((e) => e.type === "utilization")).toEqual([]);
    expect(first.allowance).toEqual([...WINDOWS, ...WINDOWS]); // before the run (with the login check), and after it
    expect((await run()).allowance).toEqual(WINDOWS);
    expect(calls().filter((c) => c === "app-server account/rateLimits/read")).toHaveLength(3);
    expect(calls().filter((c) => c === "app-server account/read")).toHaveLength(1);
  });

  it("reads the usage windows after a run at most once per poll interval", async () => {
    const { run } = runnerFor({ FAKE_CODEX_RATE_LIMITS: JSON.stringify(RATE_LIMITS) });
    expect((await run()).allowance).toEqual(WINDOWS); // the reading taken with the login check is fresh enough
    expect((await run()).allowance).toEqual([]);
  });

  it("names windows by their length and skips readings it cannot place", async () => {
    const limits = {
      primary: { usedPercent: 99, windowDurationMins: 10080, resetsAt: null },
      secondary: { usedPercent: 5, windowDurationMins: null, resetsAt: 1792000000 },
    };
    const { run } = runnerFor({ FAKE_CODEX_RATE_LIMITS: JSON.stringify(limits) });
    expect((await run()).allowance).toEqual([{ window: "seven_day", utilization: 0.99, reset: { kind: "supplied", value: null } }]);
  });

  it("asks nothing when the run is aborted before it starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, calls } = runnerFor({ FAKE_CODEX_RATE_LIMITS: JSON.stringify(RATE_LIMITS) }, { usagePollIntervalMs: 0 });
    expect((await run(controller.signal)).result.outcome).toBe("aborted");
    expect(calls()).toEqual([]);
  });
});

describe("Codex positive launch policy", () => {
  it("omits unrelated parent values from the actual worker", async () => {
    vi.stubEnv("MC_UNRELATED_SECRET", "synthetic-secret");
    const { record } = await runScenario(SUCCESS, { env: { MC_UNRELATED_SECRET: "synthetic-secret" } });
    expect(record!.env).not.toHaveProperty("MC_UNRELATED_SECRET");
    expect(record!.env).not.toHaveProperty("FAKE_CODEX_SCENARIO");
  });
});

describe("Codex launch lifecycle", () => {
  it("keeps metadata home until the app server has actually closed", async () => {
    const { result, envRecord } = await runScenario(SUCCESS, { env: { FAKE_CODEX_APP_SERVER: "delayed-eof" } });
    expect(result.outcome).toBe("ok");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const records = readFileSync(envRecord, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((entry) => entry.phase === "after-eof")).toHaveLength(1);
    expect(records.find((entry) => entry.phase === "after-eof")).toMatchObject({ homeExists: true, tmpExists: true });
  });

  it("gives worker, probe and metadata separate private homes and omits parent credentials", async () => {
    for (const name of ["MC_UNRELATED_SECRET", "NODE_OPTIONS", "OPENAI_API_KEY", "GH_TOKEN", "SSH_AUTH_SOCK", "BASH_ENV"]) vi.stubEnv(name, "synthetic-secret");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/synthetic-other-provider");
    const { result, envRecord, tmp } = await runScenario(SUCCESS);
    expect(result.outcome).toBe("ok");
    const records = readFileSync(envRecord, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.some((entry) => entry.command === "app-server")).toBe(true);
    expect(records.some((entry) => entry.command === "sandbox")).toBe(true);
    expect(records.some((entry) => entry.command === "exec")).toBe(true);
    const homes = records.map((entry) => entry.env.HOME);
    expect(new Set(homes).size).toBe(records.length);
    for (const entry of records) {
      expect(entry).toMatchObject({ homeExists: true, tmpExists: true });
      for (const name of ["MC_UNRELATED_SECRET", "NODE_OPTIONS", "OPENAI_API_KEY", "GH_TOKEN", "SSH_AUTH_SOCK", "BASH_ENV", "CLAUDE_CONFIG_DIR"]) expect(entry.env).not.toHaveProperty(name);
      expect(entry.env.CODEX_HOME).toBeDefined();
      expect(existsSync(entry.env.HOME)).toBe(false);
      expect(existsSync(entry.env.TMPDIR)).toBe(false);
    }
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("returns a local structured failure and launches nothing for invalid launch settings", async () => {
    const { result, record, envRecord, tmp } = await runScenario(SUCCESS, { runner: { path: ["/mnt/c/synthetic-private-value"] } });
    expect(result.outcome).toBe("crashed");
    expect(result.error).toContain("path[0]");
    expect(result.error).not.toContain("synthetic-private-value");
    expect(record).toBeUndefined();
    expect(existsSync(envRecord)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });
});

describe("Codex metadata-only allowance", () => {
  function metadataRunner(values: Record<string, string> = {}, options: Partial<CodexRunnerOptions> = {}) {
    const dir = mkdtempSync(join(root, "allowance-"));
    const calls = join(dir, "calls.log");
    const record = join(dir, "worker.json");
    const environmentRecord = join(dir, "env.ndjson");
    const fixture = fixtureOptions({ FAKE_CODEX_RECORD: record, FAKE_CODEX_CALLS: calls, FAKE_CODEX_ENV_RECORD: environmentRecord, FAKE_CODEX_RATE_LIMITS: JSON.stringify({
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1793440000 },
      secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1794000000 },
    }), ...values });
    const runner = new CodexRunner({ command: fakeCodex, writeSandbox: "workspace-write", tmpDir: join(dir, "tmp"), ...fixture, ...options });
    return { runner, dir, calls, record, fixture, environmentRecord, lines: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [] };
  }
  it("queries fresh on each metadata call, never launches a model or replays cached receipt", async () => {
    const h = metadataRunner();
    const first = await h.runner.readAllowance();
    expect(first.status).toBe("observed");
    expect(existsSync(h.record)).toBe(false);
    const second = await h.runner.readAllowance();
    expect(second.status).toBe("observed");
    expect(h.lines().filter((line) => line === "app-server account/rateLimits/read")).toHaveLength(2);
    const events: RunEvent[] = [];
    const result = await h.runner.run(makeJob({ cwd: h.dir }), { onEvent: (event) => events.push(event) });
    expect(result.outcome).toBe("ok");
    expect(events.filter((event) => event.type === "allowance" || event.type === "utilization")).toEqual([]);
    expect(h.lines().filter((line) => line === "app-server account/read")).toHaveLength(2);
    expect(readdirSync(join(h.dir, "tmp"))).toEqual([]);
  });
  it("preserves duplicate aggregates as one batch and discards malformed raw values", async () => {
    const h = metadataRunner({ FAKE_CODEX_RATE_LIMITS: JSON.stringify({
      primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1793440000 },
      secondary: { usedPercent: "synthetic-private-usage", windowDurationMins: 300, resetsAt: "synthetic-private-reset" },
    }) });
    const result = await h.runner.readAllowance();
    expect(result.status).toBe("observed");
    if (result.status !== "observed") return;
    expect(result.observations).toHaveLength(2);
    expect(result.observations.map((row) => row.window)).toEqual(["five_hour", "five_hour"]);
    expect(result.observations[1]).toEqual({ window: "five_hour", utilization: null, reset: { kind: "supplied", value: null } });
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  });
  it.each(["apiKey", "amazonBedrock", "none"])("reports known %s account auth without a model call", async (account) => {
    const h = metadataRunner({ FAKE_CODEX_ACCOUNT: account });
    expect((await h.runner.readAllowance()).status).toBe("auth");
    expect(existsSync(h.record)).toBe(false);
  });
  it("aborts before query without creating a provider child", async () => {
    const h = metadataRunner();
    const controller = new AbortController();
    controller.abort();
    expect(await h.runner.readAllowance({ signal: controller.signal })).toEqual({ status: "aborted" });
    expect(h.lines()).toEqual([]);
  });
  it("kills an active metadata query on abort and cleans its private home", async () => {
    const h = metadataRunner({ FAKE_CODEX_APP_SERVER: "hang" });
    const controller = new AbortController();
    const pending = h.runner.readAllowance({ signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toEqual({ status: "aborted" });
    expect(readdirSync(join(h.dir, "tmp"))).toEqual([]);
    expect(existsSync(h.record)).toBe(false);
  });
  it.each([0, -1, Number.NaN, Infinity])("rejects invalid metadata timeout %s without a child", async (timeoutMs) => {
    const h = metadataRunner();
    expect(await h.runner.readAllowance({ timeoutMs })).toEqual({ status: "unavailable" });
    expect(h.lines()).toEqual([]);
  });
  it("does not let a missing later account answer forget a forbidden billing identity", async () => {
    const h = metadataRunner({ FAKE_CODEX_ACCOUNT: "apiKey" });
    expect(await h.runner.readAllowance()).toMatchObject({ status: "auth" });
    const fixture = JSON.parse(readFileSync(join(h.fixture.configHome, "mc-fixture.json"), "utf8"));
    writeFileSync(join(h.fixture.configHome, "mc-fixture.json"), JSON.stringify({ ...fixture, FAKE_CODEX_ACCOUNT: "missing" }));
    expect(await h.runner.readAllowance()).toMatchObject({ status: "auth" });
    expect((await h.runner.run(makeJob({ cwd: h.dir }))).outcome).toBe("auth");
    expect(existsSync(h.record)).toBe(false);
  });
  it("does not let an unknown account type forget a forbidden billing identity", async () => {
    const h = metadataRunner({ FAKE_CODEX_ACCOUNT: "apiKey" });
    expect(await h.runner.readAllowance()).toMatchObject({ status: "auth" });
    const fixture = JSON.parse(readFileSync(join(h.fixture.configHome, "mc-fixture.json"), "utf8"));
    writeFileSync(join(h.fixture.configHome, "mc-fixture.json"), JSON.stringify({ ...fixture, FAKE_CODEX_ACCOUNT: "future-login-shape" }));
    expect(await h.runner.readAllowance()).toMatchObject({ status: "auth" });
    expect((await h.runner.run(makeJob({ cwd: h.dir }))).outcome).toBe("auth");
    expect(existsSync(h.record)).toBe(false);
  });
  it("keeps an unknown account type unavailable despite valid windows", async () => {
    const h = metadataRunner({ FAKE_CODEX_ACCOUNT: "future-login-shape" });
    expect(await h.runner.readAllowance()).toEqual({ status: "unavailable" });
  });
  it("uses a genuinely fresh known ChatGPT identity after an earlier forbidden reading", async () => {
    const h = metadataRunner({ FAKE_CODEX_ACCOUNT: "apiKey" });
    expect(await h.runner.readAllowance()).toMatchObject({ status: "auth" });
    const fixture = JSON.parse(readFileSync(join(h.fixture.configHome, "mc-fixture.json"), "utf8"));
    writeFileSync(join(h.fixture.configHome, "mc-fixture.json"), JSON.stringify({ ...fixture, FAKE_CODEX_ACCOUNT: "chatgpt" }));
    expect(await h.runner.readAllowance()).toMatchObject({ status: "observed" });
    expect((await h.runner.run(makeJob({ cwd: h.dir }))).outcome).toBe("ok");
  });
  it("keeps missing account truth unavailable even when windows answered", async () => {
    const h = metadataRunner({ FAKE_CODEX_ACCOUNT: "missing" });
    expect(await h.runner.readAllowance()).toEqual({ status: "unavailable" });
  });
  it("preserves a known billing refusal from a partial timed-out metadata response", async () => {
    const h = metadataRunner({ FAKE_CODEX_APP_SERVER: "account-only", FAKE_CODEX_ACCOUNT: "apiKey" },
      { appServerTimeoutMs: 250 });
    expect(await h.runner.readAllowance()).toMatchObject({ status: "auth" });
    expect((await h.runner.run(makeJob({ cwd: h.dir }))).outcome).toBe("auth");
    expect(existsSync(h.record)).toBe(false);
    expect(readdirSync(join(h.dir, "tmp"))).toEqual([]);
  });
  it("shortens the transport deadline and includes an EOF-ignoring shutdown", async () => {
    const h = metadataRunner({ FAKE_CODEX_APP_SERVER: "ignore-eof" }, { appServerTimeoutMs: 1500 });
    const start = Date.now();
    expect(await h.runner.readAllowance({ timeoutMs: 250 })).toEqual({ status: "unavailable" });
    expect(Date.now() - start).toBeLessThan(900);
    expect(readdirSync(join(h.dir, "tmp"))).toEqual([]);
  });
  it("does not extend the configured transport deadline", async () => {
    const h = metadataRunner({ FAKE_CODEX_APP_SERVER: "hang" }, { appServerTimeoutMs: 250 });
    const start = Date.now();
    expect(await h.runner.readAllowance({ timeoutMs: 10000 })).toEqual({ status: "unavailable" });
    expect(Date.now() - start).toBeLessThan(900);
  });

  it("aborts runtime first-login metadata without starting the worker", async () => {
    const h = metadataRunner({ FAKE_CODEX_APP_SERVER: "hang" }, { appServerTimeoutMs: 1500 });
    const controller = new AbortController();
    const start = Date.now();
    const pending = h.runner.run(makeJob({ cwd: h.dir }), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect((await pending).outcome).toBe("aborted");
    expect(Date.now() - start).toBeLessThan(900);
    expect(existsSync(h.record)).toBe(false);
    expect(readdirSync(join(h.dir, "tmp"))).toEqual([]);
  });

  it("does not duplicate a failed preflight inside the first warn-mode worker run", async () => {
    const h = metadataRunner({ FAKE_CODEX_APP_SERVER: "missing" });
    expect(await h.runner.readAllowance()).toEqual({ status: "unavailable" });
    const result = await h.runner.run(makeJob({ cwd: h.dir }));
    expect(result.outcome).toBe("ok");
    expect(h.lines().filter((line) => line === "app-server initialize")).toEqual([]);
    expect(h.lines().filter((line) => line.includes("app-server"))).toEqual([]);
    expect(existsSync(h.record)).toBe(true);
    const starts = readFileSync(h.environmentRecord, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(starts.filter((entry) => entry.command === "app-server")).toHaveLength(1);
  });
});
