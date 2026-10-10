// Asks Codex's app server (`codex app-server`, JSON-RPC over stdio) how Codex is logged in and how much of its
// usage windows is used, the way the Codex app reads them (account/read, account/rateLimits/read; codex 0.162.0).
import { spawn } from "node:child_process";
import type { Utilization } from "../types.js";
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
  utilization: Utilization[];
}

export interface CodexAccountQuery {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
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
  return new Promise((resolve) => {
    const answers = new Map<number, Json>();
    const expected = query.account ? [ACCOUNT_ID, RATE_LIMITS_ID] : [RATE_LIMITS_ID];
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(query.command, ["app-server"], { cwd: query.cwd, env: query.env, stdio: "pipe", detached: true });
    } catch {
      resolve(undefined);
      return;
    }
    const running = (): boolean => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.end(); // codex exits on EOF; one that doesn't is killed shortly after
      if (running()) {
        const kill = setTimeout(() => running() && killTree(child.pid ?? 0, "SIGKILL"), EXIT_GRACE_MS);
        kill.unref();
        child.once("exit", () => clearTimeout(kill));
      }
      resolve(answers.size === 0 ? undefined : reading(answers, query.account));
    };
    const timer = setTimeout(() => {
      if (running()) killTree(child.pid ?? 0, "SIGKILL"); // it is hung
      finish();
    }, query.timeoutMs);
    child.on("error", finish);
    child.on("close", finish);
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

function reading(answers: Map<number, Json>, askedAccount: boolean): CodexAccountReading {
  const out: CodexAccountReading = { utilization: usageWindows(asRecord(answers.get(RATE_LIMITS_ID)?.result)) };
  const result = asRecord(answers.get(ACCOUNT_ID)?.result);
  if (askedAccount && result && "account" in result) {
    const account = asRecord(result.account);
    out.accountType = account ? (typeof account.type === "string" ? account.type : "unknown") : null;
    if (typeof account?.planType === "string") out.planType = account.planType;
  }
  return out;
}

/** The main bucket's windows: usedPercent is 0-100, resetsAt unix seconds, the window length in minutes. */
function usageWindows(result: Json | undefined): Utilization[] {
  const snapshot = asRecord(result?.rateLimits);
  const windows: Utilization[] = [];
  for (const raw of [snapshot?.primary, snapshot?.secondary]) {
    const w = asRecord(raw);
    const used = w?.usedPercent;
    const window = windowName(w?.windowDurationMins);
    if (typeof used !== "number" || !Number.isFinite(used) || window === undefined) continue;
    const resetsAt = typeof w?.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : undefined;
    windows.push({ provider: "codex", window, utilization: used / 100, ...(resetsAt !== undefined && { resetsAt }) });
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
