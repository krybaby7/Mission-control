import { spawn } from "node:child_process";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { detectLimitText, parseResetTime } from "../limits.js";
import type { AgentJob, JsonSchema, RunEvent } from "../types.js";
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

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

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
  const runner = new CodexRunner({
    command: fakeCodex,
    writeSandbox: "danger-full-access",
    tmpDir: tmp,
    env: { ...process.env, FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_RECORD: recordFile, ...opts.env },
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
  return { result, events, record, dir, tmp };
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
      env: { ...process.env, FAKE_CODEX_SCENARIO: SUCCESS },
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

  it("scrubs API keys from the environment and runs in the job's cwd", async () => {
    const { record, dir } = await runScenario(SUCCESS, {
      env: { OPENAI_API_KEY: "sk-test", CODEX_API_KEY: "ck-test", ANTHROPIC_API_KEY: "ak-test", KEEP_ME: "yes" },
    });
    expect(record!.env.OPENAI_API_KEY).toBeUndefined();
    expect(record!.env.CODEX_API_KEY).toBeUndefined();
    expect(record!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(record!.env.KEEP_ME).toBe("yes");
    expect(record!.env.PATH).toBe(process.env.PATH);
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
