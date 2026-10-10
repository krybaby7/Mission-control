// Claude Code runner: drives `claude -p` with stream-json output and maps its event stream to a RunResult.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLimitText, limitKindFromClaudeType } from "../limits.js";
import { validateOutput } from "../schemas.js";
import type { AgentJob, AgentRunner, LimitInfo, Logger, RunEvent, RunOptions, RunResult, Usage } from "../types.js";
import { nullLogger } from "../util/logger.js";
import { parseJsonLine } from "../util/ndjson.js";
import { runProcess, scrubEnv, type SpawnResult } from "../util/process.js";
import { stripAnsi, tailLines } from "../verify.js";

export interface ClaudeRunnerOptions {
  /** Executable to run. Default "claude". */
  command?: string;
  logger?: Logger;
  /** Permission mode for workspace-write jobs. */
  writeMode: "bypassPermissions" | "acceptEdits" | "auto";
  /** Base environment (scrubbed of API keys before use). Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Where the per-run system prompt file is written. Default os.tmpdir(). */
  tmpDir?: string;
}

const READ_ONLY_TOOLS = "Read,Grep,Glob";
/**
 * Tools an unattended write job must not have: they fan out into multi-agent runs, schedule work past the run,
 * move the agent out of the unit worktree, or reach other sessions and the user's phone.
 */
const WRITE_DISALLOWED_TOOLS = [
  "Workflow",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "EnterWorktree",
  "ExitWorktree",
  "SendMessage",
  "ListAgents",
  "PushNotification",
].join(",");
const PROGRESS_CHARS = 300;
const ERROR_CHARS = 2_000;
/** Longest `raw` kept for a transient API failure, as limits.ts keeps for limit text. */
const RAW_CHARS = 500;
const STDERR_TAIL_LINES = 20;
/** Events are consumed line by line, so runProcess only needs to keep enough for the stderr tail. */
const CAPTURE_BYTES = 256 * 1024;
const AUTH_PATTERN = /(not logged in|please run \/login|authentication|unauthorized|oauth|invalid api key)/i;
const AUTH_STATUSES = new Set([401, 403]);
/**
 * A lost connection as CLI 2.1.296 words it once its retries are spent: "API Error: Connection refused — …
 * (ECONNREFUSED)", "API Error: Request timed out.", "API Error: Can't reach the API server — …". TLS setup
 * errors ("Unable to connect to API: SSL …") need a human, so they stay failures.
 */
const NETWORK_ERROR = new RegExp(
  String.raw`^API Error: (?:Connection\b|Request timed out|Can.t reach the API server|No internet route|` +
    String.raw`Unable to connect to API(?!: SSL)|.*\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|` +
    String.raw`ENETUNREACH|EHOSTUNREACH|fetch failed|socket hang up)\b)`,
  "im",
);

export class ClaudeRunner implements AgentRunner {
  readonly provider = "claude" as const;
  private readonly command: string;
  private readonly logger: Logger;
  private readonly writeMode: ClaudeRunnerOptions["writeMode"];
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly tmpDir: string;

  constructor(opts: ClaudeRunnerOptions) {
    this.command = opts.command ?? "claude";
    this.logger = opts.logger ?? nullLogger;
    this.writeMode = opts.writeMode;
    this.env = opts.env;
    this.tmpDir = opts.tmpDir ?? tmpdir();
  }

  buildArgs(job: AgentJob, systemPromptFile: string): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      job.model,
      "--effort",
      job.effort,
      "--max-turns",
      String(job.limits.maxTurns),
      "--append-system-prompt-file",
      systemPromptFile,
    ];
    if (job.outputSchema) args.push("--json-schema", JSON.stringify(job.outputSchema));
    if (job.resumeSessionId) args.push("--resume", job.resumeSessionId);
    args.push("--permission-mode", job.access === "workspace-write" ? this.writeMode : "dontAsk");
    if (job.noTools) args.push("--tools", "");
    else if (job.access === "read-only") args.push("--tools", READ_ONLY_TOOLS);
    else args.push("--disallowedTools", WRITE_DISALLOWED_TOOLS);
    args.push("--permission-prompts", "none");
    return args;
  }

  async run(job: AgentJob, opts: RunOptions = {}): Promise<RunResult> {
    let prompt: { dir: string; file: string };
    try {
      prompt = writeSystemPrompt(this.tmpDir, job.systemPrompt);
    } catch (err) {
      return setupFailure(`could not write the system prompt file: ${String(err)}`);
    }
    try {
      const emit = safeEmitter(opts.onEvent, this.logger);
      const stream = new ClaudeStream(emit);
      const proc = await runProcess({
        command: this.command,
        args: this.buildArgs(job, prompt.file),
        cwd: job.cwd,
        env: scrubEnv(this.env ?? process.env),
        stdin: job.prompt,
        timeoutMs: job.limits.timeoutMs,
        signal: opts.signal,
        onStdoutLine: (line) => stream.handleLine(line),
        teeStdoutTo: job.logFile,
        maxBufferBytes: CAPTURE_BYTES,
      });
      const result = buildResult(job, stream, proc, Date.now());
      // Reported once the outcome is known, so the event carries a reset time read from the result text.
      if (result.limit) emit({ type: "limit", info: result.limit });
      this.logger.info(`claude run ${job.id}: ${result.outcome}`, {
        model: job.model,
        durationMs: result.durationMs,
        ...(result.error !== undefined && { error: result.error }),
      });
      return result;
    } finally {
      rmSync(prompt.dir, { recursive: true, force: true });
    }
  }
}

/** Writes the system prompt into a private temp directory; the caller removes the directory. */
function writeSystemPrompt(tmpDir: string, text: string): { dir: string; file: string } {
  mkdirSync(tmpDir, { recursive: true });
  const dir = mkdtempSync(join(tmpDir, "mc-claude-"));
  const file = join(dir, "system-prompt.md");
  try {
    writeFileSync(file, text, { mode: 0o600 });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, file };
}

function setupFailure(error: string): RunResult {
  return { outcome: "crashed", text: "", usage: emptyUsage(), error, durationMs: 0, exitCode: null };
}

/** Handler errors must not break stream parsing. */
function safeEmitter(onEvent: RunOptions["onEvent"], logger: Logger): (event: RunEvent) => void {
  return (event) => {
    try {
      onEvent?.(event);
    } catch (err) {
      logger.warn("claude runner: onEvent handler threw", { error: String(err) });
    }
  };
}

// ───────────────────────────── Stream parsing ─────────────────────────────

type Json = Record<string, unknown>;

/** The final `result` event, normalized. */
interface FinalResult {
  subtype: string;
  isError: boolean;
  apiErrorStatus?: number;
  /** The `result` field: the final assistant text. */
  text?: string;
  /** `structured_output`, when present and not null. */
  structured?: unknown;
  errors: string[];
  usage: Usage;
  sessionId?: string;
}

/** Consumes stream-json lines, emits RunEvents, and keeps what the outcome depends on. */
class ClaudeStream {
  sessionId?: string;
  lastText = "";
  result?: FinalResult;
  /** The latest rejected rate_limit_event that extra usage did not cover, as a limit. */
  rejected?: LimitInfo;
  private usingExtraUsage = false;

  constructor(private readonly emit: (event: RunEvent) => void) {}

  handleLine(line: string): void {
    for (const value of parseJsonLine(line)) this.handleEvent(value as Json);
  }

  private handleEvent(event: Json): void {
    switch (event.type) {
      case "system":
        return this.onSystem(event);
      case "assistant":
        return this.onAssistant(event);
      case "rate_limit_event":
        return this.onRateLimit(event);
      case "result":
        return this.onResult(event);
    }
  }

  private onSystem(event: Json): void {
    if (event.subtype === "init") {
      this.sessionId = asString(event.session_id) ?? this.sessionId;
      this.emit({ type: "started", ...(this.sessionId !== undefined && { sessionId: this.sessionId }) });
    } else if (event.subtype === "api_retry") {
      const attempt = asNumber(event.attempt) ?? "?";
      const max = asNumber(event.max_retries) ?? "?";
      this.emit({ type: "progress", text: `API retry ${attempt}/${max} (${asNumber(event.error_status) ?? "no status"})` });
    }
  }

  private onAssistant(event: Json): void {
    const content = asRecord(event.message)?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      const block = asRecord(item);
      if (block?.type === "text") {
        const text = asString(block.text)?.trim();
        if (!text) continue;
        this.lastText = text;
        this.emit({ type: "progress", text: text.slice(0, PROGRESS_CHARS) });
      } else if (block?.type === "tool_use") {
        this.emit({ type: "progress", text: toolSummary(block) });
      }
    }
  }

  private onRateLimit(event: Json): void {
    const info = asRecord(event.rate_limit_info);
    if (!info) return;
    this.emitUtilization(info);
    if (info.status !== "rejected") return;
    if (coveredByExtraUsage(info)) return this.noteExtraUsage();
    this.rejected = rejectedLimit(info);
  }

  private noteExtraUsage(): void {
    if (this.usingExtraUsage) return;
    this.usingExtraUsage = true;
    this.emit({ type: "progress", text: "subscription limit reached: paid extra usage covers the rest of this run" });
  }

  /** One event per unified window, plus the top-level window when no unified entry already covers it. */
  private emitUtilization(info: Json): void {
    const windows = asRecord(info.unifiedWindows) ?? {};
    for (const [window, data] of Object.entries(windows)) this.emitWindow(window, asRecord(data));
    const topWindow = asString(info.rateLimitType);
    if (topWindow !== undefined && !Object.hasOwn(windows, topWindow)) this.emitWindow(topWindow, info);
  }

  private emitWindow(window: string, data: Json | undefined): void {
    const utilization = asNumber(data?.utilization);
    if (utilization === undefined) return;
    const resetsAt = secondsToMs(data?.resetsAt);
    this.emit({
      type: "utilization",
      info: { provider: "claude", window, utilization, ...(resetsAt !== undefined && { resetsAt }) },
    });
  }

  private onResult(event: Json): void {
    const sessionId = asString(event.session_id);
    const apiErrorStatus = asNumber(event.api_error_status);
    const structured = event.structured_output ?? undefined;
    this.result = {
      subtype: asString(event.subtype) ?? "unknown",
      isError: event.is_error === true,
      ...(apiErrorStatus !== undefined && { apiErrorStatus }),
      ...(typeof event.result === "string" && { text: event.result }),
      ...(structured !== undefined && { structured }),
      errors: Array.isArray(event.errors) ? event.errors.map(errorText) : [],
      usage: parseUsage(event),
      ...(sessionId !== undefined && { sessionId }),
    };
    this.sessionId ??= sessionId;
    this.emit({ type: "usage", usage: this.result.usage });
  }
}

function toolSummary(block: Json): string {
  const name = asString(block.name) ?? "tool";
  const input = asRecord(block.input);
  const detail = asString(input?.file_path) ?? asString(input?.command) ?? asString(input?.pattern);
  return (detail === undefined ? name : `${name} ${detail}`).trim().slice(0, PROGRESS_CHARS);
}

/**
 * A rejection that paid extra usage absorbs, so the CLI carries on (CLI 2.1.296 sets isUsingOverage exactly when
 * status is rejected and overageStatus is allowed or allowed_warning). If the CLI stops after all, its result
 * text still names the limit.
 */
function coveredByExtraUsage(info: Json): boolean {
  return info.isUsingOverage === true || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
}

function rejectedLimit(info: Json): LimitInfo {
  const rateLimitType = asString(info.rateLimitType);
  const kind = limitKindFromClaudeType(rateLimitType);
  const resetsAt = secondsToMs(info.resetsAt);
  // "seven_day_opus" → "opus": quota matches it as a substring of model ids.
  const model = kind === "model" ? rateLimitType?.replace(/^seven_day_/, "") : undefined;
  return {
    provider: "claude",
    kind,
    ...(resetsAt !== undefined && { resetsAt }),
    ...(model !== undefined && { model }),
    raw: JSON.stringify(info),
  };
}

function parseUsage(event: Json): Usage {
  const usage = asRecord(event.usage);
  const estCostUsd = asNumber(event.total_cost_usd);
  const turns = asNumber(event.num_turns);
  return {
    inputTokens: asNumber(usage?.input_tokens) ?? 0,
    outputTokens: asNumber(usage?.output_tokens) ?? 0,
    cacheReadTokens: asNumber(usage?.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: asNumber(usage?.cache_creation_input_tokens) ?? 0,
    ...(estCostUsd !== undefined && { estCostUsd }),
    ...(turns !== undefined && { turns }),
  };
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function secondsToMs(value: unknown): number | undefined {
  const seconds = asNumber(value);
  return seconds === undefined ? undefined : Math.round(seconds * 1000);
}

function errorText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

// ───────────────────────────── Outcome ─────────────────────────────

type Verdict = Pick<RunResult, "outcome" | "error" | "structured" | "limit">;

function buildResult(job: AgentJob, stream: ClaudeStream, proc: SpawnResult, nowMs: number): RunResult {
  return {
    ...decideOutcome(job, stream, proc, nowMs),
    text: stream.result?.text ?? stream.lastText,
    ...(stream.sessionId !== undefined && { sessionId: stream.sessionId }),
    usage: stream.result?.usage ?? emptyUsage(),
    durationMs: proc.durationMs,
    exitCode: proc.exitCode,
  };
}

function decideOutcome(job: AgentJob, stream: ClaudeStream, proc: SpawnResult, nowMs: number): Verdict {
  const { result } = stream;
  if (!result) {
    const limit = findLimit(stream.rejected, [proc.stderr], nowMs);
    return limit ? limitedVerdict(limit) : noResultOutcome(job, proc);
  }
  // A successful answer may well talk about "429" or rate limits, so only the rejected event counts there.
  if (result.subtype === "success" && !result.isError) {
    return stream.rejected ? limitedVerdict(stream.rejected) : structuredOutcome(job, result);
  }
  // The result says why the run ended; stderr may hold a stale retry notice ("API Error: 429 … (retrying)").
  const limit = findLimit(stream.rejected, resultErrorTexts(result), nowMs);
  if (limit) return limitedVerdict(limit);
  const transient = transientApiFailure(result);
  if (transient) return { outcome: "limited", limit: transient, error: clip(`API unavailable: ${transient.raw}`) };
  return errorOutcome(result);
}

function limitedVerdict(limit: LimitInfo): Verdict {
  return { outcome: "limited", limit, error: clip(`usage limit (${limit.kind}): ${limit.raw}`) };
}

function resultErrorTexts(result: FinalResult): string[] {
  return [result.text ?? "", ...result.errors].filter((text) => text.trim() !== "");
}

/** The rejected event is authoritative; text only fills in a reset time the event lacked. */
function findLimit(rejected: LimitInfo | undefined, texts: string[], nowMs: number): LimitInfo | undefined {
  const detected = firstDetectedLimit(texts, nowMs);
  if (!rejected) return detected;
  if (rejected.resetsAt !== undefined || detected?.resetsAt === undefined) return rejected;
  return { ...rejected, resetsAt: detected.resetsAt };
}

function firstDetectedLimit(texts: string[], nowMs: number): LimitInfo | undefined {
  for (const text of texts) {
    const limit = detectLimitText(text, "claude", nowMs);
    if (limit) return limit;
  }
  return undefined;
}

/**
 * A provider 5xx or a lost connection says nothing about the job. It is reported as a throttle, so the quota
 * governor backs off and the executor retries without counting the attempt against the work.
 */
function transientApiFailure(result: FinalResult): LimitInfo | undefined {
  if (!result.isError) return undefined;
  const texts = resultErrorTexts(result);
  const status = result.apiErrorStatus;
  const text =
    status !== undefined && status >= 500
      ? (texts[0] ?? `API error ${status}`)
      : texts.find((candidate) => NETWORK_ERROR.test(candidate));
  if (text === undefined) return undefined;
  return { provider: "claude", kind: "throttle", raw: text.trim().slice(0, RAW_CHARS) };
}

function structuredOutcome(job: AgentJob, result: FinalResult): Verdict {
  if (!job.outputSchema) return { outcome: "ok" };
  // structured_output, else the result text as JSON, else the last JSON object inside it.
  const candidate = result.structured ?? parseJsonLine(result.text ?? "").at(-1);
  if (candidate === undefined) {
    return { outcome: "failed", error: "invalid structured output: the final message holds no JSON object" };
  }
  const checked = validateOutput(job.outputSchema, candidate);
  if (!checked.ok) return { outcome: "failed", error: clip(`invalid structured output: ${checked.errors}`) };
  return { outcome: "ok", structured: checked.value };
}

function errorOutcome(result: FinalResult): Verdict {
  const message = clip(resultErrorTexts(result).join("\n"));
  const authStatus = result.apiErrorStatus !== undefined && AUTH_STATUSES.has(result.apiErrorStatus);
  if (result.isError && (authStatus || AUTH_PATTERN.test(message))) {
    return { outcome: "auth", error: message || `claude API error ${result.apiErrorStatus}` };
  }
  if (result.subtype === "error_max_turns") return { outcome: "failed", error: "max turns reached" };
  return { outcome: "failed", error: message || `claude finished with ${result.subtype}` };
}

function noResultOutcome(job: AgentJob, proc: SpawnResult): Verdict {
  if (proc.timedOut) return { outcome: "timeout", error: `timed out after ${job.limits.timeoutMs} ms` };
  if (proc.aborted) return { outcome: "aborted", error: "aborted" };
  if (proc.spawnError !== undefined) {
    return { outcome: "crashed", error: `claude CLI not found or failed to start: ${proc.spawnError}` };
  }
  const stderr = tailLines(stripAnsi(proc.stderr).trim(), STDERR_TAIL_LINES);
  if (AUTH_PATTERN.test(stderr)) return { outcome: "auth", error: clip(stderr) };
  const exit = proc.signal ? `claude was killed by ${proc.signal}` : `claude exited with code ${proc.exitCode}`;
  return { outcome: "crashed", error: clip(`${exit} without a result${stderr ? `: ${stderr}` : ""}`) };
}

/** Keeps errors short enough for mission state and reports, preferring the end where CLIs put the cause. */
function clip(text: string): string {
  return text.length <= ERROR_CHARS ? text : `…${text.slice(-ERROR_CHARS)}`;
}
