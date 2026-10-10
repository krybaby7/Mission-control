// Scripted AgentRunner for tests: a test-supplied script decides each run's outcome, answer and workspace edits.
import { setTimeout as delay } from "node:timers/promises";
import { validateOutput } from "../schemas.js";
import type {
  AgentJob,
  AgentRunner,
  LimitInfo,
  Provider,
  RunEvent,
  RunOptions,
  RunOutcome,
  RunResult,
  Usage,
} from "../types.js";

/**
 * What one scripted run does. Every field is optional: `{}` is a successful run with empty text and zero usage.
 *
 * A run goes through these steps:
 * 1. await the script;
 * 2. emit `started` (sessionId `mock-<provider>-<callIndex>`), then each of `events`, in order;
 * 3. await `edit(job.cwd, job)`;
 * 4. wait `delayMs`;
 * 5. emit `limit` (outcome "limited" only), then `usage`, and resolve.
 *
 * Like a real runner, it resolves with outcome "aborted" as soon as the signal fires during steps 1, 3 or 4, or
 * before them (an `onEvent` handler aborting in step 2 skips the edit). Like a killed agent's, a script or edit still
 * pending then is ignored, its late error included; edits already made stay.
 */
export interface MockBehavior {
  /** Default: "limited" when `limit` is set, else "ok". */
  outcome?: RunOutcome;
  /**
   * The agent's final JSON answer. Used only when the outcome is "ok" and the job has an outputSchema: it is
   * validated like the real runners do, and becomes `RunResult.structured` when valid. When it is invalid or
   * missing the run is "failed" ("invalid structured output: …"), so callers' tests catch schema drift.
   */
  structured?: unknown;
  /** Final assistant text. Default: `JSON.stringify(structured)` when `structured` is set, else "". */
  text?: string;
  /**
   * Fields of the limit reported for outcome "limited" (ignored for other outcomes). `provider` is always this
   * runner's provider, whatever is given here; `kind` defaults to "session" and `raw` to "mock <kind> limit".
   */
  limit?: Partial<LimitInfo>;
  /** Reported usage; token counts not given are 0. */
  usage?: Partial<Usage>;
  /**
   * Simulated run time in real milliseconds, after the edit. Aborting ends it early. Not capped by the job timeout.
   * `Infinity` models a hung agent: the run only ends when aborted.
   */
  delayMs?: number;
  /**
   * The agent's workspace changes. Runs whatever the job's access, read-only included, so tests can check that
   * callers catch read-only violations. An error thrown here rejects `run()`, unless the run was aborted first.
   */
  edit?: (cwd: string, job: AgentJob) => void | Promise<void>;
  /** `RunResult.error` for outcomes other than "ok". Default: a short description of the outcome. */
  error?: string;
  /** Extra events (e.g. `utilization` or `progress`) emitted right after `started`. */
  events?: RunEvent[];
}

/** Decides what the run for `job` does. `callIndex` counts this runner's run() calls from 0. */
export type MockScript = (job: AgentJob, callIndex: number) => MockBehavior | Promise<MockBehavior>;

/**
 * A scripted AgentRunner. It differs from the real runners in one deliberate way: errors thrown by the script, by
 * `edit` or by the caller's `onEvent` handler reject `run()` instead of being swallowed, so test bugs surface (except
 * a script or edit that fails after the run was aborted, see MockBehavior).
 */
export class MockRunner implements AgentRunner {
  /** Default "mock"; tests may impersonate "claude" or "codex". */
  readonly provider: Provider;
  /** Every job passed to run(), in call order, aborted ones included. */
  readonly calls: AgentJob[] = [];
  private readonly script: MockScript;

  constructor(script: MockScript, opts: { provider?: Provider } = {}) {
    this.script = script;
    this.provider = opts.provider ?? "mock";
  }

  async run(job: AgentJob, opts: RunOptions = {}): Promise<RunResult> {
    const startedAt = Date.now();
    const callIndex = this.calls.push(job) - 1;
    const { signal } = opts;
    const emit = (event: RunEvent) => opts.onEvent?.(event);

    const behavior = await unlessAborted(() => this.script(job, callIndex), signal);
    if (behavior === ABORTED) return abortedResult(startedAt);
    const sessionId = `mock-${this.provider}-${callIndex}`;
    emit({ type: "started", sessionId });
    for (const event of behavior.events ?? []) emit(event);
    const edited = await unlessAborted(() => behavior.edit?.(job.cwd, job), signal);
    if (edited === ABORTED || !(await waitUnlessAborted(behavior.delayMs ?? 0, signal))) {
      return abortedResult(startedAt, sessionId);
    }

    const verdict = this.decide(job, behavior);
    if (verdict.limit) emit({ type: "limit", info: verdict.limit });
    const usage: Usage = { ...emptyUsage(), ...behavior.usage };
    emit({ type: "usage", usage });
    return {
      ...verdict,
      text: behavior.text ?? (behavior.structured === undefined ? "" : JSON.stringify(behavior.structured)),
      sessionId,
      usage,
      durationMs: Date.now() - startedAt,
      exitCode: EXIT_CODES[verdict.outcome],
    };
  }

  private decide(job: AgentJob, behavior: MockBehavior): Verdict {
    const outcome = behavior.outcome ?? (behavior.limit ? "limited" : "ok");
    if (outcome === "ok") return structuredVerdict(job, behavior.structured);
    if (outcome !== "limited") return { outcome, error: behavior.error ?? defaultError(outcome, job) };
    const { kind = "session", raw = `mock ${kind} limit`, ...rest } = behavior.limit ?? {};
    const limit: LimitInfo = { ...rest, provider: this.provider, kind, raw };
    return { outcome, limit, error: behavior.error ?? `usage limit (${kind}): ${raw}` };
  }
}

type Verdict = Pick<RunResult, "outcome" | "error" | "structured" | "limit">;

/** Exit codes the real CLIs give: 0 on success, 1 on reported failures, none when killed. */
const EXIT_CODES: Record<RunOutcome, number | null> = {
  ok: 0,
  failed: 1,
  limited: 1,
  auth: 1,
  crashed: 1,
  timeout: null,
  aborted: null,
};

function structuredVerdict(job: AgentJob, structured: unknown): Verdict {
  if (!job.outputSchema) return { outcome: "ok" };
  // A JSON round trip, as the real runners parse their output: callers get a copy, never the script's own object.
  const json: string | undefined = JSON.stringify(structured);
  if (json === undefined) {
    return { outcome: "failed", error: "invalid structured output: the mock behavior gave no structured value" };
  }
  const checked = validateOutput(job.outputSchema, JSON.parse(json));
  if (!checked.ok) return { outcome: "failed", error: `invalid structured output: ${checked.errors}` };
  return { outcome: "ok", structured: checked.value };
}

function defaultError(outcome: Exclude<RunOutcome, "ok" | "limited">, job: AgentJob): string {
  switch (outcome) {
    case "failed":
      return "mock run failed";
    case "timeout":
      return `timed out after ${job.limits.timeoutMs} ms`;
    case "aborted":
      return "aborted";
    case "auth":
      return "mock CLI is not logged in";
    case "crashed":
      return "mock CLI crashed without a result";
  }
}

const ABORTED = Symbol("aborted");

/**
 * Runs `step` unless `signal` has fired, and settles with its result, or with ABORTED when the signal fires before
 * the step settles. A step still pending then is left to finish on its own, and a later rejection is ignored.
 */
async function unlessAborted<T>(step: () => T | Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof ABORTED> {
  if (signal?.aborted) return ABORTED;
  const pending = Promise.resolve(step());
  if (!signal) return pending;
  let onAbort = () => {};
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Checked first: a step that aborts synchronously has already settled, and would otherwise win the race.
    const winner = signal.aborted ? ABORTED : await Promise.race([pending, aborted]);
    if (winner === ABORTED) pending.catch(() => {});
    return winner;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Node fires a timer longer than this at once, so longer waits are chained. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Resolves true after `ms` (never for `Infinity`), or false as soon as `signal` aborts. */
async function waitUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  try {
    for (let left = ms; left > 0; left -= MAX_TIMER_MS) {
      await delay(Math.min(left, MAX_TIMER_MS), undefined, { signal });
    }
    return !signal?.aborted;
  } catch (err) {
    if (signal?.aborted) return false;
    throw err;
  }
}

function abortedResult(startedAt: number, sessionId?: string): RunResult {
  return {
    outcome: "aborted",
    text: "",
    ...(sessionId !== undefined && { sessionId }),
    usage: emptyUsage(),
    error: "aborted",
    durationMs: Date.now() - startedAt,
    exitCode: null,
  };
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
