// Codex CLI runner: drives `codex exec --json`, feeding the prompt on stdin and reading its JSONL event stream.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AllowanceReadOptions, AllowanceReadResult } from "../allowance.js";
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
import { providerLaunchEnv, validateTempRoot, type ProviderLaunchOptions } from "../util/launch-env.js";
import { runProcess, type SpawnResult } from "../util/process.js";
import { readCodexAccount, validMetadataTimeout, type CodexAccountReading } from "./codex-app-server.js";
import { restoreWorktree, snapshotWorktree, type WorktreeSnapshot } from "./worktree-guard.js";


export interface CodexRunnerOptions extends ProviderLaunchOptions {
  /** Default "codex". */
  command?: string;
  logger?: Logger;
  /** Sandbox for workspace-write jobs. */
  writeSandbox: "danger-full-access" | "workspace-write";
  /** Where per-run temp files (output schema, last message) go. Default /tmp. */
  tmpDir?: string;
  /** How long codex may keep running once its turn has ended before it is stopped. Default 30 s. */
  exitGraceMs?: number;
  /**
   * How long codex may keep retrying a lost connection or an overloaded server, with no progress in between, before
   * it is stopped and the run reported as a throttle (codex itself waits for the network indefinitely). Default 5 min.
   */
  stallMs?: number;
  /** How long one question to codex's app server (how it is logged in, how much usage is left) may take. Default 15 s. */
  appServerTimeoutMs?: number;
  /** Usage windows are read after a run at most this often. Default 60 s. */
  usagePollIntervalMs?: number;
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
const DEFAULT_STALL_MS = 5 * 60_000;
const DEFAULT_APP_SERVER_TIMEOUT_MS = 15_000;
const DEFAULT_USAGE_POLL_INTERVAL_MS = 60_000;
const SANDBOX_PROBE_TIMEOUT_MS = 30_000;
/**
 * Told to a read-only job that runs without codex's own sandbox (see readOnlySandbox): only the brief and the
 * worktree guard keep it from changing files.
 */
const NO_SANDBOX_NOTICE =
  "This is a read-only task, and nothing here technically stops you from writing, so it is up to you: do not create, " +
  "change or delete any file, and do not run commands that do (no installs, builds, formatters, git add, commit, " +
  "checkout or stash). Read files and run read-only commands only, such as cat, ls, rg, git log, git show or git diff. " +
  "Anything you change is undone after the run.";
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
/**
 * A lost connection or an overloaded or failing provider in codex's own failure text (turn.failed, or a retry notice
 * nothing recovered from), as codex 0.162.0 words them: "stream disconnected before completion: …", "Reconnecting...
 * waiting for network (Connection failed: error sending request)", DNS and connection errors, "unexpected status 503
 * Service Unavailable", "exceeded retry limit, last status: 500 …", and its text for an HTTP 500: "We’re currently
 * experiencing high demand, which may cause temporary errors."
 */
const NETWORK_ERROR = new RegExp(
  [
    "stream disconnected before completion",
    String.raw`error sending request\b`,
    "waiting for network",
    "connection failed",
    String.raw`\bdns error\b`,
    "failed to lookup address",
    "temporary failure in name resolution",
    "name or service not known",
    "connection (?:refused|reset|closed before)",
    "(?:request|connection|operation) timed out",
    "network is unreachable",
    "no route to host",
    String.raw`\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|NOTFOUND|AI_AGAIN|NETUNREACH|HOSTUNREACH)\b`,
    String.raw`unexpected status 5\d\d\b`,
    String.raw`exceeded retry limit, last status:? 5\d\d\b`,
    "we.re currently experiencing high demand",
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
  private readonly launch: ProviderLaunchOptions;
  private readonly tmpDir: string;
  private readonly exitGraceMs: number;
  private readonly stallMs: number;
  private readonly appServerTimeoutMs: number;
  private readonly usagePollIntervalMs: number;
  /** First-query preparation is shared; only the known billing identity is cached. */
  private loginChecked: Promise<void> | undefined;
  /** A missing later answer cannot forget a previously known billing identity. */
  private knownAccountType: string | null | undefined;
  private lastUsageReadAt = -Infinity;
  /** The sandbox read-only jobs get, once probed (see readOnlySandbox). */
  private readOnlyMode: Promise<Sandbox> | undefined;

  constructor(opts: CodexRunnerOptions) {
    this.command = opts.command ?? "codex";
    this.logger = opts.logger;
    this.writeSandbox = opts.writeSandbox;
    this.launch = { path: opts.path, configHome: opts.configHome };
    this.tmpDir = opts.tmpDir ?? "/tmp";
    this.exitGraceMs = opts.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;
    this.stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    this.appServerTimeoutMs = opts.appServerTimeoutMs ?? DEFAULT_APP_SERVER_TIMEOUT_MS;
    this.usagePollIntervalMs = opts.usagePollIntervalMs ?? DEFAULT_USAGE_POLL_INTERVAL_MS;
  }

  /**
   * `exec [options] [resume <id>] -`. Every option goes before `resume`, where the exec command accepts all of
   * them; the sandbox goes through config on resume because `exec resume` rejects `-s`. `readOnlySandbox` is what
   * read-only jobs get (see readOnlySandbox).
   */
  buildArgs(job: AgentJob, files: CodexRunFiles, readOnlySandbox: Sandbox = "read-only"): string[] {
    const sandbox = this.sandboxFor(job, readOnlySandbox);
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
      validateTempRoot(this.tmpDir);
      workDir = mkdtempSync(join(ensureDir(this.tmpDir), "mc-codex-"));
    } catch (err) {
      return crashedBeforeStart(`cannot create temp files for codex: ${errorMessage(err)}`);
    }
    try {
      return await this.runIn(workDir, job, opts);
    } catch (err) {
      return crashedBeforeStart(errorMessage(err));
    } finally {
      removeQuietly(workDir);
    }
  }

  private async runIn(workDir: string, job: AgentJob, opts: RunOptions): Promise<RunResult> {
    const env = providerLaunchEnv({ purpose: "worker", provider: "codex", ownedDir: workDir, ...this.launch });
    const emit = (event: RunEvent): void => {
      try {
        opts.onEvent?.(event);
      } catch (err) {
        this.logger?.warn("codex runner: onEvent handler threw", { job: job.id, error: errorMessage(err) });
      }
    };
    // An aborted run starts nothing (runProcess sees the signal), so it needs no preparation either.
    const aborted = opts.signal?.aborted === true;
    const refusal = aborted ? undefined : await this.loginRefusal(job, emit, opts.signal);
    if (refusal) return refusal;
    const readOnlySandbox = opts.signal?.aborted ? "read-only" : await this.readOnlySandbox();
    const unsandboxedReadOnly = job.access === "read-only" && this.sandboxFor(job, readOnlySandbox) === "danger-full-access";
    const files: CodexRunFiles = { lastMessageFile: join(workDir, "last-message.txt") };
    if (job.outputSchema !== undefined) {
      files.schemaFile = join(workDir, "output-schema.json");
      try {
        writeFileSync(files.schemaFile, JSON.stringify(job.outputSchema));
      } catch (err) {
        return crashedBeforeStart(`cannot write the output schema for codex: ${errorMessage(err)}`);
      }
    }

    const guard = unsandboxedReadOnly ? await snapshotWorktree(job.cwd) : undefined;
    const stream = new StreamState();
    const proc = await this.spawn(job, files, stream, emit, opts.signal, readOnlySandbox, unsandboxedReadOnly, env);
    const readonlyMutation = guard ? await this.undoChanges(job, guard, emit) : unsandboxedReadOnly ? "unknown" : undefined;
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
    if (!callerAborted && proc.spawnError === undefined) await this.readUsage(emit, opts.signal);
    return {
      outcome: verdict.outcome,
      ...(readonlyMutation !== undefined && { readonlyMutation }),
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

  /**
   * Runs codex, stopping it if it outlives its ended turn by the exit grace (a hung shutdown, not more work), or once
   * it has been retrying a lost connection or a failing server for the stall time without any progress: codex waits
   * for the network indefinitely, and the outage is the quota's to wait out (see classify), not this run's.
   */
  private async spawn(
    job: AgentJob,
    files: CodexRunFiles,
    stream: StreamState,
    emit: (event: RunEvent) => void,
    callerSignal: AbortSignal | undefined,
    readOnlySandbox: Sandbox,
    unsandboxedReadOnly: boolean,
    env: NodeJS.ProcessEnv,
  ): Promise<SpawnResult> {
    const ourStop = new AbortController();
    let graceTimer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;
    const stop = (message: string, data: Record<string, unknown>): void => {
      if (ourStop.signal.aborted) return;
      this.logger?.warn(message, { job: job.id, ...data });
      ourStop.abort();
    };
    try {
      return await runProcess({
        command: this.command,
        args: this.buildArgs(job, files, readOnlySandbox),
        cwd: job.cwd,
        env,
        stdin: fullPrompt(job, unsandboxedReadOnly),
        timeoutMs: job.limits.timeoutMs,
        signal: callerSignal === undefined ? ourStop.signal : AbortSignal.any([callerSignal, ourStop.signal]),
        ...(job.logFile !== undefined && { teeStdoutTo: job.logFile }),
        onStdoutLine: (line) => {
          for (const event of parseJsonLine(line)) handleEvent(event, stream, emit);
          if (stream.turnEnded) {
            graceTimer ??= setTimeout(() => stop("codex did not exit after its turn ended; stopping it", { graceMs: this.exitGraceMs }), this.exitGraceMs);
          }
          if (stream.pendingError !== undefined && isTransientFailure(stream.pendingError)) {
            const error = stream.pendingError;
            stallTimer ??= setTimeout(() => stop("codex is stuck retrying a connection or server problem; stopping it", { stallMs: this.stallMs, error }), this.stallMs);
          } else {
            clearTimeout(stallTimer);
            stallTimer = undefined;
          }
        },
      });
    } finally {
      clearTimeout(graceTimer);
      clearTimeout(stallTimer);
    }
  }

  /**
   * Codex has no switch that turns its shell and file tools off; for a noTools job read-only is the closest thing,
   * and a sandbox that fails every command is closer still.
   */
  private sandboxFor(job: AgentJob, readOnlySandbox: Sandbox): Sandbox {
    if (job.noTools) return "read-only";
    return job.access === "workspace-write" ? this.writeSandbox : readOnlySandbox;
  }

  /**
   * The sandbox for read-only jobs. Codex's read-only sandbox runs every command through bubblewrap, which needs user
   * namespaces; Docker's default seccomp profile forbids them, so inside the Mission Control container every command
   * a read-only agent runs (cat, rg, ls) would fail and the agent would work blind. Where write jobs already rely on
   * the container (danger-full-access), one probe tells whether the read-only sandbox works; if not, read-only jobs
   * run without it, told so in the brief, and the worktree guard undoes whatever they change.
   */
  private readOnlySandbox(): Promise<Sandbox> {
    if (this.writeSandbox !== "danger-full-access") return Promise.resolve("read-only");
    this.readOnlyMode ??= this.probeReadOnlySandbox();
    return this.readOnlyMode;
  }

  private async probeReadOnlySandbox(): Promise<Sandbox> {
    const ownedDir = mkdtempSync(join(ensureDir(this.tmpDir), "mc-codex-probe-"));
    try {
      const probe = await runProcess({
        command: this.command,
        args: ["sandbox", "-c", tomlSetting("sandbox_mode", "read-only"), "--", "true"],
        cwd: ownedDir,
        env: providerLaunchEnv({ purpose: "provider-metadata", provider: "codex", ownedDir, ...this.launch }),
        timeoutMs: SANDBOX_PROBE_TIMEOUT_MS,
      });
      // A missing codex is reported by the run itself.
      if (probe.exitCode === 0 || probe.spawnError !== undefined) return "read-only";
      const detail = clip(lastLines(probe.stderr, 3).trim() || (probe.timedOut ? "it did not answer" : `exit code ${probe.exitCode}`), 500);
      this.logger?.warn("codex's read-only sandbox does not work here; read-only jobs run without it, and changes they make are undone", { detail });
      return "danger-full-access";
    } finally { removeQuietly(ownedDir); }
  }

  /** Puts back whatever an unsandboxed read-only run changed in its worktree. */
  private async undoChanges(job: AgentJob, guard: WorktreeSnapshot, emit: (event: RunEvent) => void): Promise<RunResult["readonlyMutation"]> {
    try {
      const undone = await restoreWorktree(guard);
      if (undone.length === 0) return;
      const paths = undone.slice(0, 20).join(", ") + (undone.length > 20 ? `, … (${undone.length} in all)` : "");
      this.logger?.warn("a read-only codex run changed files; they were put back", { job: job.id, paths });
      emit({ type: "progress", text: clip(`read-only run changed files, put back: ${paths}`, PROGRESS_CHARS) });
      return "restored";
    } catch (err) {
      this.logger?.warn("could not check what a read-only codex run changed", { job: job.id, error: errorMessage(err) });
      return "unknown";
    }
  }

  /**
   * Before the first run: how codex is logged in, from its app server. An API-key (or Bedrock) login bills
   * pay-per-use credits, not the ChatGPT plan, so no run starts on it; it needs a human, like a lost login. The same
   * reading gives the first usage windows. Unknown (an older codex, a timeout) lets the run go ahead.
   */
  private async loginRefusal(job: AgentJob, emit: (event: RunEvent) => void, signal?: AbortSignal): Promise<RunResult | undefined> {
    this.loginChecked ??= this.askAppServer(true, { signal }).then((reading) => this.emitAllowance(reading, emit));
    await this.loginChecked;
    const error = billingLoginError(this.knownAccountType);
    if (error === undefined) return undefined;
    this.logger?.warn("codex run refused: its login needs attention", { job: job.id, account: this.knownAccountType });
    return { outcome: "auth", text: "", usage: emptyUsage(), error, durationMs: 0, exitCode: null };
  }

  /** Explicit controller refresh: a new transport query, never a receipt replay. */
  async readAllowance(opts: AllowanceReadOptions = {}): Promise<AllowanceReadResult> {
    if (opts.signal?.aborted) return { status: "aborted" };
    if (!validMetadataTimeout(this.appServerTimeoutMs) ||
      (opts.timeoutMs !== undefined && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0))) return { status: "unavailable" };
    const timeoutMs = Math.min(this.appServerTimeoutMs, opts.timeoutMs ?? this.appServerTimeoutMs);
    // Even an unavailable explicit query consumes first-login preparation. A worker
    // must not secretly repeat admission's query or restamp its cached samples.
    const pending = this.askAppServer(true, { ...opts, timeoutMs });
    this.loginChecked ??= pending.then(() => {});
    const reading = await pending;
    if (opts.signal?.aborted) return { status: "aborted" };
    const error = billingLoginError(this.knownAccountType);
    if (error !== undefined) return { status: "auth", error };
    if (!reading?.complete || reading.accountType !== "chatgpt") return { status: "unavailable" };
    return { status: "observed", observations: reading.observations };
  }

  private rememberAccount(reading: CodexAccountReading | undefined): void {
    const account = reading?.accountType;
    if (account === "chatgpt" || account === "apiKey" || account === "amazonBedrock" || account === null) this.knownAccountType = account;
  }

  private emitAllowance(reading: CodexAccountReading | undefined, emit: (event: RunEvent) => void): void {
    if (reading?.complete && reading.observations.length > 0) emit({ type: "allowance", observations: reading.observations });
  }

  /** After a run, at most every usagePollIntervalMs: one batch per actual response. */
  private async readUsage(emit: (event: RunEvent) => void, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || Date.now() - this.lastUsageReadAt < this.usagePollIntervalMs) return;
    const reading = await this.askAppServer(false, { signal });
    this.emitAllowance(reading, emit);
  }

  private async askAppServer(account: boolean, opts: AllowanceReadOptions = {}): Promise<CodexAccountReading | undefined> {
    this.lastUsageReadAt = Date.now();
    let ownedDir: string | undefined;
    try {
      const timeoutMs = opts.timeoutMs ?? this.appServerTimeoutMs;
      if (!validMetadataTimeout(timeoutMs) || opts.signal?.aborted) return undefined;
      validateTempRoot(this.tmpDir);
      ownedDir = mkdtempSync(join(ensureDir(this.tmpDir), "mc-codex-metadata-"));
      const reading = await readCodexAccount({
        command: this.command,
        launch: { ownedDir, ...this.launch },
        cwd: ownedDir,
        timeoutMs,
        signal: opts.signal,
        account,
      });
      if (account) this.rememberAccount(reading);
      return reading;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Invalid child environment setting:")) this.logger?.warn(err.message);
      return undefined;
    } finally {
      if (ownedDir !== undefined) removeQuietly(ownedDir);
    }
  }
}

/** Why a login that bills somewhere other than the ChatGPT plan must not run, or undefined for any other login. */
function billingLoginError(accountType: string | null | undefined): string | undefined {
  const fix = "Log out of Codex (codex logout) and log in with your ChatGPT account (codex login --device-auth).";
  if (accountType === "apiKey") {
    return `Codex is logged in with an API key, which bills pay-per-use API credits instead of your ChatGPT plan, so the run was not started. ${fix}`;
  }
  if (accountType === "amazonBedrock") {
    return `Codex is set up to use Amazon Bedrock, which bills your AWS account instead of your ChatGPT plan, so the run was not started. ${fix}`;
  }
  if (accountType === null) return "Codex is not logged in. Log in with your ChatGPT account (codex login --device-auth).";
  return undefined;
}

/** A `-c` override with a TOML string value: key="value". */
function tomlSetting(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`; // JSON string escapes are valid TOML basic-string escapes
}

function fullPrompt(job: AgentJob, unsandboxedReadOnly = false): string {
  const instructions = unsandboxedReadOnly ? [job.systemPrompt.trim(), NO_SANDBOX_NOTICE].filter(Boolean).join("\n\n") : job.systemPrompt;
  return instructions.trim() === "" ? job.prompt : `${instructions}${PROMPT_SEPARATOR}${job.prompt}`;
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
  if (NETWORK_ERROR.test(text)) {
    // A lost connection or a server error says nothing about the job: a throttle, as the Claude runner reports it,
    // so the quota backs off and the executor retries without counting the attempt against the work.
    const raw = lineMatching(text, NETWORK_ERROR);
    return { outcome: "limited", limit: { provider: "codex", kind: "throttle", raw }, error: raw };
  }
  return undefined;
}

/** A retry notice about the connection or an overloaded provider, which waiting may fix: not a limit, not a login. */
function isTransientFailure(text: string): boolean {
  const verdict = failureTextVerdict(text);
  return verdict?.outcome === "limited" && verdict.limit?.kind === "throttle";
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
