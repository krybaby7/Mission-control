// Asks Codex's app server (`codex app-server`, JSON-RPC over stdio) how Codex is logged in and how much of its
// usage windows is used, the way the Codex app reads them (account/read, account/rateLimits/read; codex 0.162.0).
import { spawn } from "node:child_process";
import type { AllowanceInput } from "../allowance.js";
import { validAllowanceTime, validAllowanceUsage } from "../allowance.js";
import { providerLaunchEnv, type ProviderLaunchOptions } from "../util/launch-env.js";
import { killTree } from "../util/process.js";
import { LineSplitter, parseJsonLine } from "../util/ndjson.js";

export interface CodexAccountReading {
  /**
   * account/read: "chatgpt" for a ChatGPT plan; "apiKey" or "amazonBedrock" bill elsewhere; null when not logged in;
   * undefined when not asked or not answered.
   */
  accountType?: string | null;
  /** The ChatGPT plan ("plus", "pro", …), when known. */
  planType?: string;
  /** account/rateLimits/read as usage windows (five_hour, seven_day, …); empty when unavailable. */
  observations: AllowanceInput[];
  /** All requested answers arrived and the child closed within the deadline. */
  complete: boolean;
}

export interface CodexAccountQuery {
  command: string;
  launch: ProviderLaunchOptions & { ownedDir: string };
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Also ask for the account type (account/read), not only the usage windows. */
  account: boolean;
}

const CLIENT_INFO = { name: "mission-control", title: "Mission Control", version: "1" };
const INITIALIZE_ID = 1;
const ACCOUNT_ID = 2;
const RATE_LIMITS_ID = 3;
const EXIT_GRACE_MS = 2_000;
const MINUTE = 1;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Json = Record<string, unknown>;

/**
 * One short app-server session. Undefined when the app server could not be asked (codex missing, an older codex
 * without it, a timeout before any answer); a question it answered with an error just leaves that part empty.
 * The session ends as soon as both answers are in; stdin stays open until then, since codex quits on EOF.
 */
export function readCodexAccount(query: CodexAccountQuery): Promise<CodexAccountReading | undefined> {
  if (!validMetadataTimeout(query.timeoutMs) || query.signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const answers = new Map<number, Json>();
    const expected = query.account ? [ACCOUNT_ID, RATE_LIMITS_ID] : [RATE_LIMITS_ID];
    let settled = false;
    let finishing = false;
    let interrupted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const env = providerLaunchEnv({ purpose: "provider-metadata", provider: "codex", ...query.launch });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(query.command, ["app-server"], { cwd: query.cwd, env, stdio: "pipe", detached: true });
    } catch {
      resolve(undefined);
      return;
    }
    const deliver = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      query.signal?.removeEventListener("abort", onAbort);
      resolve(answers.size === 0 ? undefined : reading(answers, query.account, !interrupted && expected.every((id) => answers.has(id))));
    };
    const finish = (): void => {
      if (finishing || settled) return;
      finishing = true;
      child.stdin?.end();
      if (child.pid === undefined) { deliver(); return; }
      // Retain the temporary home until close. EOF-ignoring processes and any
      // descendants holding their pipes are killed before the caller cleans it.
      killTimer = setTimeout(() => killTree(child.pid ?? 0, "SIGKILL"), EXIT_GRACE_MS);
      killTimer.unref();
    };
    const interrupt = (): void => {
      interrupted = true;
      if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
      finish();
    };
    const onAbort = (): void => interrupt();
    // The caller's bound covers shutdown too, including an EOF-ignoring child.
    const timer = setTimeout(interrupt, query.timeoutMs);
    query.signal?.addEventListener("abort", onAbort, { once: true });
    if (query.signal?.aborted) onAbort();
    child.on("error", () => { finish(); if (child.pid === undefined) deliver(); });
    child.on("close", () => {
      finish();
      if (child.pid !== undefined) killTree(child.pid, "SIGKILL");
      deliver();
    });
    child.stdin?.on("error", () => {}); // EPIPE when it exits first
    child.stderr?.resume();
    const lines = new LineSplitter();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of lines.push(chunk)) {
        for (const message of parseJsonLine(line)) {
          const id = (message as Json).id;
          if (typeof id === "number" && expected.includes(id)) answers.set(id, message as Json);
        }
      }
      if (expected.every((id) => answers.has(id))) finish();
    });
    const requests: Json[] = [
      { id: INITIALIZE_ID, method: "initialize", params: { clientInfo: CLIENT_INFO, capabilities: null } },
      { method: "initialized" },
      ...(query.account ? [{ id: ACCOUNT_ID, method: "account/read", params: { refreshToken: false } }] : []),
      { id: RATE_LIMITS_ID, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } },
    ];
    child.stdin?.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n");
  });
}

function reading(answers: Map<number, Json>, askedAccount: boolean, complete: boolean): CodexAccountReading {
  const out: CodexAccountReading = { observations: usageWindows(asRecord(answers.get(RATE_LIMITS_ID)?.result)), complete };
  const result = asRecord(answers.get(ACCOUNT_ID)?.result);
  if (askedAccount && result && "account" in result) {
    const account = asRecord(result.account);
    if (result.account === null) out.accountType = null;
    else if (account) out.accountType = ["chatgpt", "apiKey", "amazonBedrock"].includes(account.type as string) ? account.type as string : "unknown";
    if (typeof account?.planType === "string") out.planType = account.planType;
  }
  return out;
}

/** The main bucket's windows: usedPercent is 0-100, resetsAt unix seconds, the window length in minutes. */
function usageWindows(result: Json | undefined): AllowanceInput[] {
  const snapshot = asRecord(result?.rateLimits);
  const windows: AllowanceInput[] = [];
  for (const raw of [snapshot?.primary, snapshot?.secondary]) {
    const w = asRecord(raw);
    const used = w?.usedPercent;
    const window = windowName(w?.windowDurationMins);
    if (!w || window === undefined) continue;
    const convertedReset = typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null;
    windows.push({
      window, utilization: validAllowanceUsage(used) ? used / 100 : null,
      reset: Object.hasOwn(w, "resetsAt")
        ? { kind: "supplied", value: validAllowanceTime(convertedReset) ? convertedReset : null }
        : { kind: "omitted" },
    });
  }
  return windows;
}

/** Codex's five-hour and weekly windows by their length, under the names pacing knows; others keep their length. */
function windowName(minutes: unknown): string | undefined {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return undefined;
  if (minutes >= 4 * HOUR && minutes <= 6 * HOUR) return "five_hour";
  if (minutes >= 6 * DAY && minutes <= 8 * DAY) return "seven_day";
  return `${Math.round(minutes)}_minutes`;
}

function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

/** Node timers overflow above this range; invalid bounds must start no child. */
export function validMetadataTimeout(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 2_147_483_647;
}
