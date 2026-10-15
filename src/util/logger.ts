// Logger: JSON lines to a file and/or one short human line per message on stderr.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogData = Record<string, unknown>;
export type LevelLogger = Logger & { debug(msg: string, data?: LogData): void };

export interface LoggerOptions {
  /** Append JSON lines `{at, level, msg, ...data}` here. */
  file?: string;
  /** Print `HH:MM:SS level msg` to stderr (stdout stays free for command output). */
  console?: boolean;
  /** Minimum level written to every sink. Default "info". */
  level?: LogLevel;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(opts: LoggerOptions): LevelLogger {
  const minRank = LEVEL_RANK[opts.level ?? "info"];
  const file = opts.file;
  if (file) tryMkdir(dirname(file));
  if (opts.console) ignoreStderrErrors();

  const log = (level: LogLevel, msg: string, data?: LogData): void => {
    if (LEVEL_RANK[level] < minRank) return;
    const now = new Date();
    if (file) appendQuietly(file, fileLine(now, level, msg, data));
    if (opts.console) writeConsole(consoleLine(now, level, msg));
  };

  return {
    debug: (msg, data) => log("debug", msg, data),
    info: (msg, data) => log("info", msg, data),
    warn: (msg, data) => log("warn", msg, data),
    error: (msg, data) => log("error", msg, data),
  };
}

export const nullLogger: LevelLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function fileLine(now: Date, level: LogLevel, msg: string, data?: LogData): string {
  const head = { at: now.toISOString(), level, msg };
  // Spreading `head` last keeps data from overwriting the standard keys; they stay first in the line.
  const entry = { ...head, ...data, ...head };
  try {
    return JSON.stringify(entry, jsonSafe) + "\n";
  } catch (err) {
    // e.g. a circular structure: keep the message, drop the data
    return JSON.stringify({ ...head, dataError: String(err) }) + "\n";
  }
}

/** JSON replacer for values JSON.stringify mangles or rejects. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === "bigint") return value.toString();
  return value;
}

function consoleLine(now: Date, level: LogLevel, msg: string): string {
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  return `${time} ${level} ${msg.replace(/\s*\r?\n\s*/g, " ")}\n`;
}

// Logging must never take the orchestrator down, so console and file errors are ignored.

function ignoreError(): void {}

/** A vanished reader (e.g. `mc run 2>&1 | tee run.log` after tee dies) makes stderr emit EPIPE, fatal without a listener. */
function ignoreStderrErrors(): void {
  if (!process.stderr.listeners("error").includes(ignoreError)) process.stderr.on("error", ignoreError);
}

function writeConsole(line: string): void {
  // After an error the stream is destroyed; writing to it would only raise another one.
  if (process.stderr.destroyed || !process.stderr.writable) return;
  process.stderr.write(line);
}

function appendQuietly(file: string, line: string): void {
  try {
    appendFileSync(file, line);
  } catch {
    // ignored: see above
  }
}

function tryMkdir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignored: appendQuietly will fail quietly too
  }
}
