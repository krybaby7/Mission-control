// Child processes: spawn in a fresh process group, stream lines, cap output, and kill whole trees.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { LineSplitter } from "./ndjson.js";

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  /** Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is closed. When undefined, stdin is closed immediately (never left open). */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Complete lines, without the trailing "\n" ("\r\n" handled). An unterminated last line is delivered at exit. */
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Append raw stdout to this file (its directory is created if needed). */
  teeStdoutTo?: string;
  /** Cap for captured stdout and stderr; the LAST bytes are kept. Default 8 MiB for stdout, 256 KiB for stderr. */
  maxBufferBytes?: number;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** Capped tails. */
  stdout: string;
  stderr: string;
  durationMs: number;
  /** e.g. "ENOENT: claude not found". */
  spawnError?: string;
}

/** SIGTERM → SIGKILL escalation delay. */
const KILL_GRACE_MS = 5_000;
/** After the main process exits, how long leftover descendants may keep our pipes open before we give up on them. */
const STDIO_GRACE_MS = 2_000;
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
/** setTimeout silently turns larger delays into 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Variables that would make the CLIs bill an API account (or misbehave as a nested session) instead of using the subscription login. */
const SCRUBBED_ENV_VARS = [
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
] as const;

/** Returns a copy of `env` without the API-key / provider-routing variables. */
export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of SCRUBBED_ENV_VARS) delete clean[key];
  return clean;
}

/**
 * Signals the process group led by `pid` (or just `pid` if it leads no group), plus any descendants
 * that moved to another group (e.g. via setsid). Never throws.
 */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  // 0, 1 and negative ids address our own group or every process: never allowed.
  if (!Number.isInteger(pid) || pid <= 1) return;
  const escaped = descendantsOutsideGroup(pid); // snapshot before the tree falls apart
  if (!sendSignal(-pid, signal)) sendSignal(pid, signal);
  // Group members already got the signal; signalling them twice can trigger "second signal = force quit" handlers.
  for (const child of escaped) sendSignal(child, signal);
}

function sendSignal(target: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function groupAlive(pgid: number): boolean {
  return sendSignal(-pgid, 0);
}

interface ProcEntry {
  pid: number;
  ppid: number;
  pgrp: number;
}

/** Descendants of rootPid whose process group is not rootPid's. Linux /proc only; [] elsewhere. */
function descendantsOutsideGroup(rootPid: number): number[] {
  const childrenOf = new Map<number, ProcEntry[]>();
  for (const entry of readProcTable()) {
    const siblings = childrenOf.get(entry.ppid) ?? [];
    siblings.push(entry);
    childrenOf.set(entry.ppid, siblings);
  }
  const escaped: number[] = [];
  const queue = [rootPid];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const child of childrenOf.get(parent) ?? []) {
      queue.push(child.pid);
      if (child.pgrp !== rootPid) escaped.push(child.pid);
    }
  }
  return escaped;
}

function readProcTable(): ProcEntry[] {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  const table: ProcEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // "pid (comm) state ppid pgrp …": comm may contain spaces and parentheses.
      const [, ppid, pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      table.push({ pid: Number(name), ppid: Number(ppid), pgrp: Number(pgrp) });
    } catch {
      // the process exited while we were scanning
    }
  }
  return table;
}

/**
 * Runs a command without a shell, in its own process group. Never rejects: spawn failures are
 * reported in `spawnError`. On timeout or abort the whole group is sent SIGTERM, then SIGKILL after 5 s.
 */
export function runProcess(spec: SpawnSpec): Promise<SpawnResult> {
  const startedAt = Date.now();
  if (spec.signal?.aborted) return Promise.resolve(emptyResult({ aborted: true }));
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      detached: true,
      shell: false,
      stdio: "pipe",
    });
  } catch (err) {
    return Promise.resolve(emptyResult({ durationMs: Date.now() - startedAt, spawnError: describeSpawnError(err, spec) }));
  }
  return new Promise((resolve) => supervise(child, spec, startedAt, resolve));
}

function emptyResult(fields: Partial<SpawnResult>): SpawnResult {
  return { exitCode: null, signal: null, timedOut: false, aborted: false, stdout: "", stderr: "", durationMs: 0, ...fields };
}

function supervise(
  child: ChildProcessWithoutNullStreams,
  spec: SpawnSpec,
  startedAt: number,
  resolve: (result: SpawnResult) => void,
): void {
  const stdout = new StreamCapture(spec.maxBufferBytes ?? DEFAULT_MAX_STDOUT_BYTES, spec.onStdoutLine);
  const stderr = new StreamCapture(spec.maxBufferBytes ?? DEFAULT_MAX_STDERR_BYTES, spec.onStderrLine);
  const tee = spec.teeStdoutTo === undefined ? undefined : openTee(spec.teeStdoutTo);
  const pid = child.pid;
  let stopReason: "timeout" | "abort" | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let pipeTimer: NodeJS.Timeout | undefined;
  let settled = false;

  // Signal only while the group exists: Linux never reuses a pid that is still a live process-group id,
  // so a stale pid can never hit an unrelated process.
  const terminate = () => {
    if (pid === undefined || killTimer || !groupAlive(pid)) return;
    killTree(pid, "SIGTERM");
    killTimer = setTimeout(() => {
      if (groupAlive(pid)) killTree(pid, "SIGKILL");
    }, KILL_GRACE_MS);
  };
  const stop = (reason: "timeout" | "abort") => {
    stopReason ??= reason;
    terminate();
  };
  const onAbort = () => stop("abort");
  const timeoutTimer = Number.isFinite(spec.timeoutMs)
    ? setTimeout(() => stop("timeout"), Math.min(Math.max(spec.timeoutMs, 0), MAX_TIMER_MS))
    : undefined;
  spec.signal?.addEventListener("abort", onAbort, { once: true });

  const settle = (spawnError?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutTimer);
    clearTimeout(pipeTimer);
    spec.signal?.removeEventListener("abort", onAbort);
    // Don't hold the event loop open for a SIGKILL that has nothing left to kill.
    if (killTimer && pid !== undefined && !groupAlive(pid)) clearTimeout(killTimer);
    const result: SpawnResult = {
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
      timedOut: stopReason === "timeout",
      aborted: stopReason === "abort",
      stdout: stdout.finish(),
      stderr: stderr.finish(),
      durationMs: Date.now() - startedAt,
      ...(spawnError === undefined ? {} : { spawnError }),
    };
    void (tee ? tee.close() : Promise.resolve()).then(() => resolve(result));
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
    tee?.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  // EPIPE when the child exits without reading its input: expected, not a failure of ours.
  child.stdin.on("error", () => {});
  child.stdin.end(spec.stdin);

  child.on("error", (err) => {
    // Without a pid the process never started; other errors (e.g. a failed kill) are not fatal.
    if (child.pid === undefined) settle(describeSpawnError(err, spec));
  });
  child.on("exit", (code, signal) => {
    exit = { code, signal };
    clearTimeout(timeoutTimer);
    spec.signal?.removeEventListener("abort", onAbort);
    // A leftover background descendant may hold stdout/stderr open forever; don't wait on it.
    pipeTimer = setTimeout(() => {
      terminate();
      child.stdout.destroy();
      child.stderr.destroy();
      settle();
    }, STDIO_GRACE_MS);
  });
  child.on("close", (code, signal) => {
    exit ??= { code, signal };
    settle();
  });
}

function describeSpawnError(err: unknown, spec: SpawnSpec): string {
  const { code, message } = err as NodeJS.ErrnoException;
  if (code === "ENOENT") {
    return existsSync(spec.cwd) ? `ENOENT: ${spec.command} not found` : `ENOENT: working directory ${spec.cwd} does not exist`;
  }
  return `${code ?? "ERROR"}: ${message}`;
}

/** Captures the last `maxBytes` of a stream and optionally feeds complete lines to a callback. */
class StreamCapture {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private truncated = false;
  private readonly decoder = new StringDecoder("utf8");
  private readonly lines = new LineSplitter();

  constructor(
    private readonly maxBytes: number,
    private readonly onLine?: (line: string) => void,
  ) {}

  push(chunk: Buffer): void {
    this.keepTail(chunk);
    if (this.onLine) this.deliver(this.lines.push(this.decoder.write(chunk)));
  }

  /** Delivers the unterminated last line, if any, and returns the captured text. */
  finish(): string {
    if (this.onLine) this.deliver([...this.lines.push(this.decoder.end()), ...this.lines.flush()]);
    const buf = Buffer.concat(this.chunks);
    return (this.truncated ? buf.subarray(firstCharBoundary(buf)) : buf).toString("utf8");
  }

  private keepTail(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes) {
      this.truncated = true;
      const head = this.chunks[0];
      if (!head) break;
      const excess = this.bytes - this.maxBytes;
      if (head.length <= excess) {
        this.chunks.shift();
        this.bytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  private deliver(lines: string[]): void {
    for (const line of lines) {
      try {
        this.onLine?.(line);
      } catch {
        // A throwing callback runs inside a stream event and would crash the process; drop the error.
      }
    }
  }
}

/** Skips UTF-8 continuation bytes left at the start of a truncated buffer. */
function firstCharBoundary(buf: Buffer): number {
  let i = 0;
  while (i < Math.min(buf.length, 3) && ((buf[i] ?? 0) & 0xc0) === 0x80) i++;
  return i;
}

interface Tee {
  write(chunk: Buffer): void;
  close(): Promise<void>;
}

/** Best-effort append-only copy of a stream; a broken log file never fails the run. */
function openTee(path: string): Tee {
  let stream: WriteStream | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    stream = createWriteStream(path, { flags: "a" });
    stream.on("error", () => {});
  } catch {
    stream = undefined;
  }
  return {
    write: (chunk) => {
      if (stream && !stream.destroyed) stream.write(chunk);
    },
    close: async () => {
      if (!stream) return;
      stream.end();
      await finished(stream).catch(() => {});
    },
  };
}
