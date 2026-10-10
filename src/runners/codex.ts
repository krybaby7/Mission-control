// Codex CLI runner: drives `codex exec --json`, feeding the prompt on stdin and reading its JSONL event stream.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLimitText } from "../limits.js";
import { validateOutput } from "../schemas.js";
import type {
  AgentJob,
  AgentRunner,
  JsonSchema,
  LimitInfo,
  Logger,
  RunEvent,
  RunOptions,
  RunOutcome,
  RunResult,
  Usage,
} from "../types.js";
import { ensureDir } from "../util/fs.js";
import { parseJsonLine } from "../util/ndjson.js";
import { runProcess, scrubEnv, type SpawnResult } from "../util/process.js";

export interface CodexRunnerOptions {
  /** Default "codex". */
  command?: string;
  logger?: Logger;
  /** Sandbox for workspace-write jobs. */
  writeSandbox: "danger-full-access" | "workspace-write";
  /** Default process.env; always scrubbed of API keys so the ChatGPT login is used. */
  env?: NodeJS.ProcessEnv;
  /** Where per-run temp files (output schema, last message) go. Default os.tmpdir(). */
  tmpDir?: string;
  /** How long codex may keep running once its turn has ended before it is stopped. Default 30 s. */
  exitGraceMs?: number;
}

export interface CodexRunFiles {
  schemaFile?: string;
  lastMessageFile: string;
}

type Sandbox = "read-only" | "workspace-write" | "danger-full-access";

/** Separates the role instructions from the task brief on stdin (Codex has no system-prompt flag). */
export const PROMPT_SEPARATOR = "\n\n---\n\n";
const PROGRESS_CHARS = 300;
const ERROR_CHARS = 2_000;
const STDERR_TAIL_LINES = 20;
const DEFAULT_EXIT_GRACE_MS = 30_000;
/**
 * Login failures in codex's own error text, including an expired or reused ChatGPT refresh token. The status codes
 * are word-bounded, so a port such as :40123 is not mistaken for one.
 */
const AUTH_PATTERN = new RegExp(
  [
    String.raw`\b40[13]\b`,
    "unauthori[sz]ed",
    "forbidden",
    "not logged in",
    "login required",
    "authentication",
    "refresh token",
    "could not be refreshed",
    String.raw`(?:log(?:ging)?|sign(?:ing)?)\s+(?:in|out)\s+again`,
    String.raw`codex login\b`,
  ].join("|"),
  "i",
);
/** Stderr also logs unrelated warnings (e.g. an MCP server's OAuth), so only codex's own login wording counts there. */
const STDERR_AUTH_PATTERN = /not logged in|codex login\b|could not be refreshed|(?:log|sign)\s+in\s+again/i;

export class CodexRunner implements AgentRunner {
  readonly provider = "codex" as const;
  private readonly command: string;
  private readonly logger: Logger | undefined;
  private readonly writeSandbox: CodexRunnerOptions["writeSandbox"];
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly tmpDir: string;
  private readonly exitGraceMs: number;

  constructor(opts: CodexRunnerOptions) {
    this.command = opts.command ?? "codex";
    this.logger = opts.logger;
    this.writeSandbox = opts.writeSandbox;
    this.env = opts.env;
    this.tmpDir = opts.tmpDir ?? tmpdir();
    this.exitGraceMs = opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
  }

  /**
   * `exec [options] [resume <id>] -`. Every option goes before `resume`, where the exec command accepts all of
   * them; the sandbox goes through config on resume because `exec resume` rejects `-s`.
   */
  buildArgs(job: AgentJob, files: CodexRunFiles): string[] {
    const sandbox = this.sandboxFor(job);
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", job.cwd, "-m", job.model];
    args.push("-c", tomlSetting("model_reasoning_effort", job.effort), "-c", tomlSetting("approval_policy", "never"));
    if (job.resumeSessionId === undefined) args.push("-s", sandbox);
    else args.push("-c", tomlSetting("sandbox_mode", sandbox));
    if (sandbox === "workspace-write") args.push("-c", "sandbox_workspace_write.network_access=true");
    if (files.schemaFile !== undefined) args.push("--output-schema", files.schemaFile);
    args.push("-o", files.lastMessageFile);
    if (job.resumeSessionId !== undefined) args.push("resume", job.resumeSessionId);
    args.push("-");
    return args;
  }

  async run(job: AgentJob, opts: RunOptions = {}): Promise<RunResult> {
    let workDir: string;
    try {
      workDir = mkdtempSync(join(ensureDir(this.tmpDir), "mc-codex-"));
    } catch (err) {
      return crashedBeforeStart(`cannot create temp files for codex: ${errorMessage(err)}`);
    }
    try {
      return await this.runIn(workDir, job, opts);
    } finally {
      removeQuietly(workDir);
    }
  }

  private async runIn(workDir: string, job: AgentJob, opts: RunOptions): Promise<RunResult> {
    const emit = (event: RunEvent): void => {
      try {
        opts.onEvent?.(event);
      } catch (err) {
        this.logger?.warn("codex runner: onEvent handler threw", { job: job.id, error: errorMessage(err) });
      }
    };
    const files: CodexRunFiles = { lastMessageFile: join(workDir, "last-message.txt") };
    if (job.outputSchema !== undefined) {
      files.schemaFile = join(workDir, "output-schema.json");
      try {
        writeFileSync(files.schemaFile, JSON.stringify(job.outputSchema));
      } catch (err) {
        return crashedBeforeStart(`cannot write the output schema for codex: ${errorMessage(err)}`);
      }
    }

    const stream = new StreamState();
    const proc = await this.spawn(job, files, stream, emit, opts.signal);
    const text = readTextOr(files.lastMessageFile).trim() || stream.finalText;
    const callerAborted = proc.aborted && opts.signal?.aborted === true;
    const verdict = classify(job, proc, stream, text, callerAborted);
    if (verdict.limit) emit({ type: "limit", info: verdict.limit });
    this.logger?.info("codex run finished", {
      job: job.id,
      outcome: verdict.outcome,
      exitCode: proc.exitCode,
      durationMs: proc.durationMs,
    });
    return {
      outcome: verdict.outcome,
      text,
      ...(verdict.structured !== undefined && { structured: verdict.structured }),
      ...(stream.sessionId !== undefined && { sessionId: stream.sessionId }),
      usage: stream.usage,
      ...(verdict.limit !== undefined && { limit: verdict.limit }),
      ...(verdict.error !== undefined && { error: verdict.error }),
      durationMs: proc.durationMs,
      exitCode: proc.exitCode,
    };
  }

  /** Runs codex, stopping it if it outlives its ended turn by the exit grace (a hung shutdown, not more work). */
  private async spawn(
    job: AgentJob,
    files: CodexRunFiles,
    stream: StreamState,
    emit: (event: RunEvent) => void,
    callerSignal: AbortSignal | undefined,
  ): Promise<SpawnResult> {
    const lingering = new AbortController();
    let graceTimer: NodeJS.Timeout | undefined;
    const stopLingering = (): void => {
      const data = { job: job.id, graceMs: this.exitGraceMs };
      this.logger?.warn("codex did not exit after its turn ended; stopping it", data);
      lingering.abort();
    };
    try {
      return await runProcess({
        command: this.command,
        args: this.buildArgs(job, files),
        cwd: job.cwd,
        env: scrubEnv(this.env ?? process.env),
        stdin: fullPrompt(job),
        timeoutMs: job.limits.timeoutMs,
        signal: callerSignal === undefined ? lingering.signal : AbortSignal.any([callerSignal, lingering.signal]),
        ...(job.logFile !== undefined && { teeStdoutTo: job.logFile }),
        onStdoutLine: (line) => {
          for (const event of parseJsonLine(line)) handleEvent(event, stream, emit);
          if (stream.turnEnded) graceTimer ??= setTimeout(stopLingering, this.exitGraceMs);
        },
      });
    } finally {
      clearTimeout(graceTimer);
    }
  }

  /** Codex has no switch that turns its shell and file tools off; for a noTools job read-only is the closest thing. */
  private sandboxFor(job: AgentJob): Sandbox {
    return job.access === "workspace-write" && !job.noTools ? this.writeSandbox : "read-only";
  }
}

/** A `-c` override with a TOML string value: key="value". */
function tomlSetting(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`; // JSON string escapes are valid TOML basic-string escapes
}

function fullPrompt(job: AgentJob): string {
  return job.systemPrompt.trim() === "" ? job.prompt : `${job.systemPrompt}${PROMPT_SEPARATOR}${job.prompt}`;
}

// ───────────────────────────── Event stream ─────────────────────────────

/** What the JSONL event stream told us about the run. */
class StreamState {
  sessionId: string | undefined;
  /** Text of the last completed agent_message. */
  finalText = "";
  usage: Usage = emptyUsage();
  turnCompleted = false;
  turnFailure: string | undefined;
  /** The last `error` event (a retry notice) not followed by further progress, i.e. one that has not recovered. */
  pendingError: string | undefined;

  get turnEnded(): boolean {
    return this.turnCompleted || this.turnFailure !== undefined;
  }
}

type JsonObject = Record<string, unknown>;

function handleEvent(raw: unknown, s: StreamState, emit: (event: RunEvent) => void): void {
  if (!isObject(raw)) return;
  switch (raw.type) {
    case "thread.started":
      s.sessionId = stringOr(raw.thread_id, undefined);
      emit(s.sessionId === undefined ? { type: "started" } : { type: "started", sessionId: s.sessionId });
      break;
    case "item.started":
    case "item.updated":
      s.pendingError = undefined;
      break;
    case "item.completed":
      s.pendingError = undefined;
      if (isObject(raw.item)) handleCompletedItem(raw.item, s, emit);
      break;
    case "error": {
      const message = stringOr(raw.message, JSON.stringify(raw));
      s.pendingError = message;
      emit({ type: "progress", text: clip(message, PROGRESS_CHARS) });
      break;
    }
    case "turn.completed":
      s.turnCompleted = true;
      s.usage = usageFrom(raw.usage); // a thread total, so it replaces rather than adds
      emit({ type: "usage", usage: s.usage });
      break;
    case "turn.failed":
      s.turnFailure = stringOr(isObject(raw.error) ? raw.error.message : undefined, "codex reported a failed turn");
      break;
  }
}

function handleCompletedItem(item: JsonObject, s: StreamState, emit: (event: RunEvent) => void): void {
  switch (item.type) {
    case "agent_message":
      s.finalText = stringOr(item.text, "");
      if (s.finalText !== "") emit({ type: "progress", text: clip(s.finalText, PROGRESS_CHARS) });
      break;
    case "command_execution":
      emit({ type: "progress", text: clip(`$ ${stringOr(item.command, "")}`, PROGRESS_CHARS) });
      break;
    case "file_change":
      emit({ type: "progress", text: clip(describeFileChange(item), PROGRESS_CHARS) });
      break;
  }
}

/** "update src/app.ts, add src/new.ts" from a file_change item's `changes: [{path, kind}]`. */
function describeFileChange(item: JsonObject): string {
  const changes = Array.isArray(item.changes) ? item.changes.filter(isObject) : [];
  const parts = changes.map((c) => `${stringOr(c.kind, "change")} ${stringOr(c.path, "?")}`);
  return parts.length > 0 ? parts.join(", ") : "file change";
}

/**
 * Codex (like the OpenAI API) counts cached input inside input_tokens and reasoning inside output_tokens. Usage
 * follows Claude's meaning instead, where inputTokens excludes cache reads, so neither is counted twice.
 */
function usageFrom(raw: unknown): Usage {
  const u = isObject(raw) ? raw : {};
  const cacheReadTokens = count(u.cached_input_tokens);
  return {
    inputTokens: Math.max(0, count(u.input_tokens) - cacheReadTokens),
    outputTokens: count(u.output_tokens),
    cacheReadTokens,
    cacheWriteTokens: count(u.cache_write_input_tokens),
  };
}

// ───────────────────────────── Outcome ─────────────────────────────

interface Verdict {
  outcome: RunOutcome;
  error?: string;
  limit?: LimitInfo;
  structured?: unknown;
}

/**
 * Limit and auth wording is only trusted in failure text: an agent may well write "returns 429" (decision 1).
 * turn.failed carries codex's own reason (its last fatal error), so when there is one it alone decides: retry
 * notices that recovered and stderr warnings from earlier in the run must not turn an ordinary failure into a limit.
 */
function classify(job: AgentJob, proc: SpawnResult, s: StreamState, text: string, callerAborted: boolean): Verdict {
  // Whatever it printed while being stopped is beside the point.
  if (callerAborted) return { outcome: "aborted", error: "aborted" };
  if (s.turnFailure !== undefined) {
    return failureTextVerdict(s.turnFailure) ?? { outcome: "failed", error: clip(s.turnFailure, ERROR_CHARS) };
  }
  if (s.turnCompleted) return completedTurnVerdict(job, proc, s, text);
  return unfinishedTurnVerdict(job, proc, s);
}

/** A finished turn stands even when codex then had to be stopped; exiting with an error by itself is a crash. */
function completedTurnVerdict(job: AgentJob, proc: SpawnResult, s: StreamState, text: string): Verdict {
  const stoppedByUs = proc.aborted || proc.timedOut;
  if (!stoppedByUs && proc.exitCode !== 0) return { outcome: "crashed", error: crashMessage(proc, s) };
  return job.outputSchema === undefined ? { outcome: "ok" } : structuredVerdict(job.outputSchema, text);
}

function unfinishedTurnVerdict(job: AgentJob, proc: SpawnResult, s: StreamState): Verdict {
  // A retry notice nothing recovered from is why codex stopped, or what it was stuck on when the timeout hit.
  const stuck = s.pendingError === undefined ? undefined : failureTextVerdict(s.pendingError);
  if (stuck) return stuck;
  if (proc.timedOut) return { outcome: "timeout", error: `timed out after ${job.limits.timeoutMs} ms` };
  if (proc.spawnError !== undefined) {
    return { outcome: "crashed", error: `codex CLI not found or failed to start: ${proc.spawnError}` };
  }
  return stderrVerdict(proc.stderr) ?? { outcome: "crashed", error: crashMessage(proc, s) };
}

function failureTextVerdict(text: string): Verdict | undefined {
  const limit = detectLimitText(text, "codex", Date.now());
  if (limit) return { outcome: "limited", limit, error: limit.raw };
  if (AUTH_PATTERN.test(text)) return { outcome: "auth", error: lineMatching(text, AUTH_PATTERN) };
  return undefined;
}

/**
 * Stderr also logs retries that recovered and unrelated warnings, so only its last lines count, and only for a
 * provider limit (a throttle there is a logged retry) or codex's own login wording.
 */
function stderrVerdict(stderr: string): Verdict | undefined {
  const recent = lastLines(stderr, STDERR_TAIL_LINES);
  const limit = detectLimitText(recent, "codex", Date.now());
  if (limit && limit.kind !== "throttle") return { outcome: "limited", limit, error: limit.raw };
  if (STDERR_AUTH_PATTERN.test(recent)) return { outcome: "auth", error: lineMatching(recent, STDERR_AUTH_PATTERN) };
  return undefined;
}

function structuredVerdict(schema: JsonSchema, text: string): Verdict {
  const value = parseJsonLine(text).at(-1); // the whole message, else the last JSON object in it
  if (value === undefined) {
    const error = `invalid structured output: no JSON object in the final message: ${clip(text, 200)}`;
    return { outcome: "failed", error };
  }
  const checked = validateOutput(schema, value);
  if (!checked.ok) return { outcome: "failed", error: `invalid structured output: ${checked.errors}` };
  return { outcome: "ok", structured: checked.value };
}

function crashMessage(proc: SpawnResult, s: StreamState): string {
  const status = proc.exitCode !== null ? `code ${proc.exitCode}` : `signal ${proc.signal ?? "unknown"}`;
  const detail = proc.stderr.trim() || s.pendingError || "";
  const head = `codex exited with ${status} ${s.turnCompleted ? "after" : "without"} completing the turn`;
  return detail === "" ? head : `${head}: ${tail(detail, ERROR_CHARS)}`;
}

function crashedBeforeStart(error: string): RunResult {
  return { outcome: "crashed", text: "", usage: emptyUsage(), error, durationMs: 0, exitCode: null };
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

// ───────────────────────────── Small helpers ─────────────────────────────

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" ? value : fallback;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}

/** The trimmed line of `text` that matches `pattern`, capped. */
function lineMatching(text: string, pattern: RegExp): string {
  const line = text.split("\n").find((l) => pattern.test(l)) ?? text;
  return clip(line.trim(), ERROR_CHARS);
}

function readTextOr(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // a leftover temp dir is harmless
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
