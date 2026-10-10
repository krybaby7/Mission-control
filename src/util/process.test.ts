import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killTree, runProcess, scrubEnv, type SpawnSpec } from "./process.js";

const NODE = process.execPath;
const hasProc = existsSync("/proc/self/stat");

let dir: string;
/** Every pid a test learns about; killed in afterEach so a failing test cannot leak processes. */
let spawned: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-process-"));
  spawned = [];
});

afterEach(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function runNode(script: string, extra: Partial<SpawnSpec> = {}) {
  return runProcess({ command: NODE, args: ["-e", script], cwd: dir, timeoutMs: 15_000, ...extra });
}

/** Alive and not a zombie (zombies linger until reaped, which a container's PID 1 may never do). */
function isAlive(pid: number): boolean {
  if (hasProc) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, withinMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

/** Picks "<label> <pid>" out of the child's output and remembers the pid for cleanup. */
function pidFrom(output: string, label: string): number {
  const match = new RegExp(`${label} (\\d+)`).exec(output);
  if (!match?.[1]) throw new Error(`no "${label} <pid>" in output: ${output}`);
  const pid = Number(match[1]);
  spawned.push(pid);
  return pid;
}

const HANG = "setInterval(() => {}, 1000);";
const spawnGrandchild = (label: string, options: string) =>
  `{ const g = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(HANG)}], ${options}); console.log("${label} " + g.pid); }`;

describe("runProcess: results", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const r = await runNode(`process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3;`);
    expect(r).toMatchObject({ exitCode: 3, signal: null, timedOut: false, aborted: false, stdout: "out", stderr: "err" });
    expect(r.spawnError).toBeUndefined();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports the signal when the child is killed by one", async () => {
    const r = await runNode(`process.kill(process.pid, "SIGKILL");`);
    expect(r).toMatchObject({ exitCode: null, signal: "SIGKILL", timedOut: false, aborted: false });
  });

  it("runs without a shell: arguments are passed literally", async () => {
    const r = await runProcess({
      command: NODE,
      args: ["-e", "console.log(process.argv.slice(1).join('|'))", "$HOME; echo hi", "*", "a b"],
      cwd: dir,
      timeoutMs: 15_000,
    });
    expect(r.stdout).toBe("$HOME; echo hi|*|a b\n");
  });

  it("runs in the given cwd", async () => {
    const r = await runNode(`process.stdout.write(process.cwd())`);
    expect(r.stdout).toBe(dir);
  });

  it.runIf(hasProc)("puts the child in its own process group", async () => {
    const r = await runNode(`
      const stat = require("node:fs").readFileSync("/proc/self/stat", "utf8");
      const [, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      console.log(process.pid === Number(pgrp) ? "leader" : "member");
    `);
    expect(r.stdout.trim()).toBe("leader");
  });
});

describe("runProcess: environment", () => {
  it("passes the given env", async () => {
    const r = await runNode(`process.stdout.write(String(process.env.MC_FOO) + "," + String(process.env.MC_ABSENT))`, {
      env: { PATH: process.env.PATH, MC_FOO: "bar" },
    });
    expect(r.stdout).toBe("bar,undefined");
  });

  it("defaults to process.env", async () => {
    vi.stubEnv("MC_PROCESS_TEST_VAR", "inherited");
    try {
      const r = await runNode(`process.stdout.write(process.env.MC_PROCESS_TEST_VAR ?? "missing")`);
      expect(r.stdout).toBe("inherited");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("runProcess: stdin", () => {
  const ECHO_STDIN = `
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => process.stdout.write("len=" + data.length + " head=" + data.slice(0, 12)));
  `;

  it("writes the stdin string and then closes stdin", async () => {
    const r = await runNode(ECHO_STDIN, { stdin: "héllo wörld ✓", timeoutMs: 10_000 });
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe("len=13 head=héllo wörld ");
  });

  it("delivers a large stdin in full", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const r = await runNode(ECHO_STDIN, { stdin: big });
    expect(r.stdout).toBe("len=3145728 head=xxxxxxxxxxxx");
  });

  it("closes stdin immediately when no stdin is given (a reader sees EOF, not a hang)", async () => {
    const r = await runNode(ECHO_STDIN, { timeoutMs: 10_000 });
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toBe("len=0 head=");
  });

  it("treats an empty stdin string like no input", async () => {
    const r = await runNode(ECHO_STDIN, { stdin: "", timeoutMs: 10_000 });
    expect(r.stdout).toBe("len=0 head=");
  });

  it("survives a child that exits without reading a large stdin (EPIPE)", async () => {
    const r = await runNode(`process.exit(0)`, { stdin: "y".repeat(8 * 1024 * 1024) });
    expect(r.exitCode).toBe(0);
    expect(r.spawnError).toBeUndefined();
  });
});

describe("runProcess: line callbacks", () => {
  it("delivers complete lines across chunk boundaries, handling \\r\\n and split UTF-8", async () => {
    const script = `
      const steps = [
        () => process.stdout.write("par"),
        () => process.stdout.write("tial\\nline2\\r\\n"),
        () => process.stdout.write(Buffer.from([0xc3])),
        () => process.stdout.write(Buffer.from([0xa9])),
        () => process.stdout.write("\\n\\nlast without newline"),
      ];
      steps.forEach((step, i) => setTimeout(step, i * 40));
    `;
    const lines: string[] = [];
    const r = await runNode(script, { onStdoutLine: (l) => lines.push(l) });
    expect(lines).toEqual(["partial", "line2", "é", "", "last without newline"]);
    expect(r.stdout).toBe("partial\nline2\r\né\n\nlast without newline");
  });

  it("delivers stderr lines separately", async () => {
    const out: string[] = [];
    const err: string[] = [];
    await runNode(`console.log("o1"); console.error("e1"); console.error("e2"); process.stdout.write("o2")`, {
      onStdoutLine: (l) => out.push(l),
      onStderrLine: (l) => err.push(l),
    });
    expect(out).toEqual(["o1", "o2"]);
    expect(err).toEqual(["e1", "e2"]);
  });

  it("delivers many lines in order", async () => {
    const lines: string[] = [];
    await runNode(`for (let i = 0; i < 20000; i++) console.log(JSON.stringify({ i }))`, {
      onStdoutLine: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(20000);
    expect(lines.every((l, i) => l === JSON.stringify({ i }))).toBe(true);
  });

  it("delivers every line even when the captured output is capped", async () => {
    const lines: string[] = [];
    const r = await runNode(`for (let i = 0; i < 100; i++) console.log("line " + i)`, {
      maxBufferBytes: 10,
      onStdoutLine: (l) => lines.push(l),
    });
    expect(lines).toHaveLength(100);
    expect(lines[99]).toBe("line 99");
    expect(r.stdout).toBe("line 98\nline 99\n".slice(-10));
  });

  it("survives a callback that throws", async () => {
    const r = await runNode(`console.log("a"); console.log("b")`, {
      onStdoutLine: () => {
        throw new Error("callback bug");
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("a\nb\n");
  });

  it("survives an async callback that rejects (no unhandled rejection)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const seen: string[] = [];
      const r = await runNode(`console.log("a"); console.log("b")`, {
        onStdoutLine: async (line) => {
          seen.push(line);
          throw new Error("async callback bug");
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(r.exitCode).toBe(0);
      expect(seen).toEqual(["a", "b"]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("runProcess: output caps", () => {
  it("keeps the last maxBufferBytes of stdout and stderr", async () => {
    const r = await runNode(
      `process.stdout.write("0123456789".repeat(1000) + "END"); process.stderr.write("abcdefghij".repeat(1000) + "ERR")`,
      { maxBufferBytes: 100 },
    );
    expect(r.stdout).toHaveLength(100);
    expect(r.stdout.endsWith("789END")).toBe(true);
    expect(r.stderr).toHaveLength(100);
    expect(r.stderr.endsWith("hijERR")).toBe(true);
  });

  it("does not start the tail in the middle of a UTF-8 character", async () => {
    const r = await runNode(`process.stdout.write("é".repeat(100))`, { maxBufferBytes: 51 });
    expect(r.stdout).toBe("é".repeat(25));
  });

  it("defaults to 8 MiB for stdout and 256 KiB for stderr", async () => {
    const size = 300 * 1024;
    const r = await runNode(`process.stdout.write("o".repeat(${size})); process.stderr.write("e".repeat(${size}))`);
    expect(r.stdout).toHaveLength(size);
    expect(r.stderr).toHaveLength(256 * 1024);
  });
});

describe("runProcess: teeStdoutTo", () => {
  it("appends raw stdout to the file, creating its directory", async () => {
    const log = join(dir, "logs", "nested", "run.ndjson");
    await runNode(`process.stdout.write("first\\n"); process.stderr.write("not teed")`, { teeStdoutTo: log });
    await runNode(`process.stdout.write("second\\r\\nno newline")`, { teeStdoutTo: log });
    expect(readFileSync(log, "utf8")).toBe("first\nsecond\r\nno newline");
  });

  it("keeps existing content", async () => {
    const log = join(dir, "existing.log");
    writeFileSync(log, "old\n");
    await runNode(`process.stdout.write("new")`, { teeStdoutTo: log });
    expect(readFileSync(log, "utf8")).toBe("old\nnew");
  });

  it("never fails the run when the tee file cannot be written", async () => {
    const blocker = join(dir, "regular-file");
    writeFileSync(blocker, "");
    const r = await runNode(`process.stdout.write("still captured")`, { teeStdoutTo: join(blocker, "x.log") });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("still captured");
  });
});

describe("runProcess: spawn errors (never rejects)", () => {
  it("reports a missing command", async () => {
    const r = await runProcess({ command: "mc-definitely-missing-binary", args: [], cwd: dir, timeoutMs: 5_000 });
    expect(r).toMatchObject({ exitCode: null, signal: null, timedOut: false, aborted: false, stdout: "", stderr: "" });
    expect(r.spawnError).toBe("ENOENT: mc-definitely-missing-binary not found");
  });

  it("reports a missing working directory", async () => {
    const missing = join(dir, "does-not-exist");
    const r = await runProcess({ command: NODE, args: ["-e", ""], cwd: missing, timeoutMs: 5_000 });
    expect(r.spawnError).toBe(`ENOENT: working directory ${missing} does not exist`);
  });

  it("reports a file that is not executable", async () => {
    const script = join(dir, "not-executable.sh");
    writeFileSync(script, "#!/bin/sh\necho hi\n");
    chmodSync(script, 0o644);
    const r = await runProcess({ command: script, args: [], cwd: dir, timeoutMs: 5_000 });
    expect(r.spawnError).toMatch(/^EACCES: /);
  });

  it("reports arguments the OS cannot accept instead of throwing", async () => {
    const r = await runProcess({ command: NODE, args: ["bad\0arg"], cwd: dir, timeoutMs: 5_000 });
    expect(r.spawnError).toBeDefined();
    expect(r.exitCode).toBeNull();
  });

  it("does not spawn at all when the signal is already aborted", async () => {
    const marker = join(dir, "ran");
    const ac = new AbortController();
    ac.abort();
    const r = await runNode(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`, { signal: ac.signal });
    expect(r).toMatchObject({ aborted: true, timedOut: false, exitCode: null, durationMs: 0 });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("runProcess: timeout and abort kill the whole tree", () => {
  it("on timeout, SIGTERMs the group, including a grandchild holding our pipes and one that does not", async () => {
    const script = `${spawnGrandchild("piped", `{ stdio: "inherit" }`)} ${spawnGrandchild("silent", `{ stdio: "ignore" }`)} ${HANG}`;
    const r = await runNode(script, { timeoutMs: 1_000 });
    expect(r).toMatchObject({ timedOut: true, aborted: false, exitCode: null, signal: "SIGTERM" });
    expect(r.durationMs).toBeGreaterThanOrEqual(900);
    expect(r.durationMs).toBeLessThan(5_000);
    expect(await waitUntilDead(pidFrom(r.stdout, "piped"))).toBe(true);
    expect(await waitUntilDead(pidFrom(r.stdout, "silent"))).toBe(true);
  });

  it.runIf(hasProc)("also kills a descendant that escaped into its own process group", async () => {
    const script = `${spawnGrandchild("escaped", `{ stdio: "ignore", detached: true }`)} ${HANG}`;
    const r = await runNode(script, { timeoutMs: 1_000 });
    expect(r.timedOut).toBe(true);
    expect(await waitUntilDead(pidFrom(r.stdout, "escaped"))).toBe(true);
  });

  it.runIf(hasProc)("SIGKILLs an escaped descendant that ignores SIGTERM, though the group is gone by then", async () => {
    const ac = new AbortController();
    const grandchild = `process.on("SIGTERM", () => {}); console.log("ready"); ${HANG}`;
    const script = `
      const g = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      g.stdout.once("data", () => console.log("escaped " + g.pid));
      ${HANG}`;
    const r = await runNode(script, {
      signal: ac.signal,
      onStdoutLine: (line) => {
        if (line.startsWith("escaped")) ac.abort();
      },
    });
    const escaped = pidFrom(r.stdout, "escaped");
    expect(r).toMatchObject({ aborted: true, signal: "SIGTERM" });
    expect(isAlive(escaped)).toBe(true); // it ignored the SIGTERM
    expect(await waitUntilDead(escaped, 8_000)).toBe(true);
  }, 20_000);

  it("escalates to SIGKILL after 5 s when SIGTERM is ignored", async () => {
    const r = await runNode(`process.on("SIGTERM", () => console.log("ignoring SIGTERM")); ${HANG}`, { timeoutMs: 200 });
    expect(r).toMatchObject({ timedOut: true, signal: "SIGKILL", exitCode: null });
    expect(r.stdout).toContain("ignoring SIGTERM");
    expect(r.durationMs).toBeGreaterThanOrEqual(5_000);
    expect(r.durationMs).toBeLessThan(10_000);
  }, 20_000);

  it("on abort, kills the group and reports aborted", async () => {
    const ac = new AbortController();
    const script = `${spawnGrandchild("grandchild", `{ stdio: "ignore" }`)} console.log("ready"); ${HANG}`;
    const r = await runNode(script, {
      signal: ac.signal,
      onStdoutLine: (line) => {
        if (line === "ready") ac.abort();
      },
    });
    expect(r).toMatchObject({ aborted: true, timedOut: false, signal: "SIGTERM" });
    expect(await waitUntilDead(pidFrom(r.stdout, "grandchild"))).toBe(true);
  });

  it("records only the first reason when a timeout is followed by an abort", async () => {
    const ac = new AbortController();
    const script = `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 400)); console.log("ready"); ${HANG}`;
    const pending = runNode(script, { signal: ac.signal, timeoutMs: 300 });
    setTimeout(() => ac.abort(), 500);
    const r = await pending;
    expect(r).toMatchObject({ timedOut: true, aborted: false, exitCode: 0 });
  });

  it("ignores an abort after the process has finished", async () => {
    const ac = new AbortController();
    const r = await runNode(`console.log("done")`, { signal: ac.signal });
    ac.abort();
    expect(r).toMatchObject({ aborted: false, exitCode: 0 });
  });

  it("does not wait forever on a leftover background process that holds stdout open", async () => {
    const script = `${spawnGrandchild("background", `{ stdio: "inherit" }`)} process.exit(0);`;
    const r = await runNode(script, { timeoutMs: 20_000 });
    expect(r).toMatchObject({ exitCode: 0, signal: null, timedOut: false, aborted: false });
    expect(r.durationMs).toBeLessThan(10_000);
    expect(await waitUntilDead(pidFrom(r.stdout, "background"))).toBe(true);
  }, 30_000);

  it("terminates leftover group members that do not hold our pipes once the command exits", async () => {
    const script = `${spawnGrandchild("background", `{ stdio: "ignore" }`)} process.exit(0);`;
    const r = await runNode(script);
    expect(r).toMatchObject({ exitCode: 0, signal: null, timedOut: false, aborted: false });
    expect(r.durationMs).toBeLessThan(2_000);
    expect(await waitUntilDead(pidFrom(r.stdout, "background"))).toBe(true);
  });

  it("escalates to SIGKILL for a leftover group member that ignores SIGTERM", async () => {
    const stubborn = `process.on("SIGTERM", () => {}); console.log("ready"); ${HANG}`;
    const script = `
      const g = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(stubborn)}], { stdio: ["ignore", "pipe", "ignore"] });
      g.stdout.once("data", () => { console.log("background " + g.pid); process.exit(0); });`;
    const r = await runNode(script);
    const leftover = pidFrom(r.stdout, "background");
    expect(r.exitCode).toBe(0);
    expect(await waitUntilDead(leftover, 8_000)).toBe(true);
  }, 20_000);
});

describe("scrubEnv", () => {
  const SCRUBBED = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "CODEX_API_KEY",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
  ];

  it("removes every API-key and routing variable and keeps the rest", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/home/u", CLAUDE_CONFIG_DIR: "/c", OTHER: "1" };
    for (const key of SCRUBBED) env[key] = "secret";
    const clean = scrubEnv(env);
    for (const key of SCRUBBED) expect(clean).not.toHaveProperty(key);
    expect(clean).toEqual({ PATH: "/usr/bin", HOME: "/home/u", CLAUDE_CONFIG_DIR: "/c", OTHER: "1" });
  });

  it("returns a new object and leaves the input untouched", () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "k", PATH: "/bin" };
    const clean = scrubEnv(env);
    expect(clean).not.toBe(env);
    expect(env.ANTHROPIC_API_KEY).toBe("k");
    clean.PATH = "/changed";
    expect(env.PATH).toBe("/bin");
  });

  it("is case-sensitive", () => {
    expect(scrubEnv({ anthropic_api_key: "lower", Openai_Api_Key: "mixed" })).toEqual({
      anthropic_api_key: "lower",
      Openai_Api_Key: "mixed",
    });
  });

  it("defaults to process.env", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "should-go");
    vi.stubEnv("MC_SCRUB_KEEP", "kept");
    try {
      const clean = scrubEnv();
      expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
      expect(clean.MC_SCRUB_KEEP).toBe("kept");
      expect(clean.PATH).toBe(process.env.PATH);
      expect(process.env.ANTHROPIC_API_KEY).toBe("should-go");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("killTree", () => {
  it("never signals our own group or every process", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    for (const pid of [0, 1, -1, -1234, 1.5, Number.NaN]) killTree(pid, "SIGKILL");
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not throw for a process that no longer exists", async () => {
    const r = await runNode(`console.log("pid " + process.pid)`);
    const pid = pidFrom(r.stdout, "pid");
    expect(() => killTree(pid)).not.toThrow();
  });

  it("kills a plain process that does not lead a process group", async () => {
    const child = spawn(NODE, ["-e", HANG], { stdio: "ignore" });
    const pid = child.pid;
    if (pid === undefined) throw new Error("spawn failed");
    spawned.push(pid);
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    killTree(pid);
    expect(await exited).toBe("SIGTERM");
  });

  it("kills a detached group and its members", async () => {
    const script = `${spawnGrandchild("member", `{ stdio: "ignore" }`)} ${HANG}`;
    const child = spawn(NODE, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    const pid = child.pid;
    if (pid === undefined) throw new Error("spawn failed");
    spawned.push(pid);
    const firstLine = await new Promise<string>((resolve) => child.stdout.once("data", (c: Buffer) => resolve(String(c))));
    const member = pidFrom(firstLine, "member");
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    killTree(pid, "SIGKILL");
    expect(await exited).toBe("SIGKILL");
    expect(await waitUntilDead(member)).toBe(true);
  });
});
