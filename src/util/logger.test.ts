import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, nullLogger } from "./logger.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-logger-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function readLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function captureStderr(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  return written;
}

describe("createLogger: file", () => {
  it("writes JSON lines {at, level, msg, ...data}, creating the directory", () => {
    const file = join(dir, "nested", "mc.log");
    const log = createLogger({ file });
    log.info("hello", { mission: "m1", n: 2 });
    log.warn("careful");
    log.error("boom", { code: 7 });
    const lines = readLines(file);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ level: "info", msg: "hello", mission: "m1", n: 2 });
    expect(Object.keys(lines[0] ?? {}).slice(0, 3)).toEqual(["at", "level", "msg"]);
    expect(new Date(String(lines[0]?.at)).toISOString()).toBe(lines[0]?.at);
    expect(lines[1]).toMatchObject({ level: "warn", msg: "careful" });
    expect(lines[2]).toMatchObject({ level: "error", msg: "boom", code: 7 });
  });

  it("filters by level (default info)", () => {
    const file = join(dir, "a.log");
    const log = createLogger({ file });
    log.debug("hidden");
    log.info("shown");
    expect(readLines(file).map((l) => l.msg)).toEqual(["shown"]);

    const warnFile = join(dir, "b.log");
    const warnOnly = createLogger({ file: warnFile, level: "warn" });
    warnOnly.info("no");
    warnOnly.warn("yes");
    warnOnly.error("yes too");
    expect(readLines(warnFile).map((l) => l.msg)).toEqual(["yes", "yes too"]);
  });

  it("includes debug messages at level debug", () => {
    const file = join(dir, "d.log");
    createLogger({ file, level: "debug" }).debug("progress", { step: 1 });
    expect(readLines(file)).toEqual([expect.objectContaining({ level: "debug", msg: "progress", step: 1 })]);
  });

  it("does not let data overwrite the standard keys", () => {
    const file = join(dir, "r.log");
    createLogger({ file }).info("real", { msg: "fake", level: "error", at: "never", extra: true });
    const [line] = readLines(file);
    expect(line).toMatchObject({ level: "info", msg: "real", extra: true });
    expect(line?.at).not.toBe("never");
  });

  it("serializes Errors and bigints, and survives circular data", () => {
    const file = join(dir, "s.log");
    const log = createLogger({ file });
    log.error("failed", { err: new Error("bad thing"), big: 10n });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.warn("loop", { circular })).not.toThrow();
    const [first, second] = readLines(file);
    expect(first).toMatchObject({ err: { name: "Error", message: "bad thing" }, big: "10" });
    expect(second).toMatchObject({ level: "warn", msg: "loop" });
    expect(String(second?.dataError)).toMatch(/circular/i);
  });

  it("never throws when the file cannot be written", () => {
    const blocker = join(dir, "regular-file");
    writeFileSync(blocker, "");
    // A regular file used as a directory makes both the mkdir and every append fail.
    const log = createLogger({ file: join(blocker, "inner.log") });
    expect(() => log.error("still fine")).not.toThrow();
  });
});

describe("createLogger: console", () => {
  it("prints one concise line 'HH:MM:SS level msg' to stderr", () => {
    const written = captureStderr();
    const log = createLogger({ console: true });
    log.info("starting mission", { ignored: "data" });
    log.warn("multi\nline\r\n  message");
    expect(written).toHaveLength(2);
    expect(written[0]).toMatch(/^\d{2}:\d{2}:\d{2} info starting mission\n$/);
    expect(written[1]).toMatch(/^\d{2}:\d{2}:\d{2} warn multi line message\n$/);
  });

  it("is silent on the console unless asked", () => {
    const written = captureStderr();
    const file = join(dir, "only-file.log");
    createLogger({ file }).info("quiet");
    expect(written).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });

  it("keeps running and logging to the file after the console reader goes away (EPIPE)", async () => {
    const file = join(dir, "epipe.log");
    const script = `
      const { createLogger } = await import(process.argv[1]);
      const log = createLogger({ console: true, file: process.argv[2] });
      for (let i = 0; i < 3; i++) { log.info("tick " + i); await new Promise((r) => setTimeout(r, 50)); }`;
    const loggerModule = fileURLToPath(new URL("./logger.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script, loggerModule, file],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr.destroy(); // the reader vanishes, as when `| head` exits
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(readLines(file).map((line) => line.msg)).toEqual(["tick 0", "tick 1", "tick 2"]);
  });

  it("skips the console once stderr is no longer writable", () => {
    const written = captureStderr();
    // restoreAllMocks does not undo getter spies, so restore this one by hand.
    const writable = vi.spyOn(process.stderr, "writable", "get").mockReturnValue(false);
    try {
      const file = join(dir, "still-file.log");
      createLogger({ console: true, file }).info("after console died");
      expect(written).toEqual([]);
      expect(readLines(file).map((line) => line.msg)).toEqual(["after console died"]);
    } finally {
      writable.mockRestore();
    }
  });

  it("applies the level to the console too", () => {
    const written = captureStderr();
    const log = createLogger({ console: true, level: "error" });
    log.warn("skip");
    log.error("show");
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("error show");
  });
});

describe("nullLogger", () => {
  it("accepts every level and does nothing", () => {
    const written = captureStderr();
    expect(() => {
      nullLogger.debug("a", { x: 1 });
      nullLogger.info("b");
      nullLogger.warn("c");
      nullLogger.error("d");
    }).not.toThrow();
    expect(written).toEqual([]);
  });
});
