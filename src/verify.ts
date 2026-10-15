// Verification: run the app's verify commands, fingerprint failures, guard frozen tests, and scan diffs for test cheating.
import { createHash } from "node:crypto";
import { closeSync, constants, createWriteStream, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import type { FrozenFile, Logger, VerifyConfig, VerifyResult } from "./types.js";
import { ensureDir } from "./util/fs.js";
import { nullLogger } from "./util/logger.js";
import { runProcess, scrubEnv, type SpawnResult } from "./util/process.js";

// ───────────────────────────── Running verify commands ─────────────────────────────

const TAIL_LINES = 200;
/** Longer output lines are cut in the tail (it goes into prompts) and before computing signatures. */
const MAX_LINE_CHARS = 4096;
/** Output is collected line by line through callbacks, so runProcess only needs to keep a small copy. */
const CAPTURE_BYTES = 64 * 1024;

export interface VerifierOptions {
  /** Directory for the full `verify-<label>.log` files (created on demand). */
  logsDir: string;
  /** Timeout for one verify command run. */
  timeoutMs: number;
  logger?: Logger;
  /** Base environment (default process.env); API-key variables are scrubbed. */
  env?: NodeJS.ProcessEnv;
  /** Aborting it (e.g. on `mc stop` or shutdown) kills a running verify command's whole process group. */
  signal?: AbortSignal;
}

/** Where one run's full output goes; a no-op when the log file cannot be created. */
interface RunLog {
  file: string;
  write(text: string): void;
  close(): Promise<void>;
}

export class Verifier {
  private readonly logger: Logger;

  constructor(private readonly opts: VerifierOptions) {
    this.logger = opts.logger ?? nullLogger;
  }

  /** Runs `vc.install`; passes immediately (without a log) when no install command is configured. */
  async install(cwd: string, vc: VerifyConfig): Promise<VerifyResult> {
    if (!isCommand(vc.install)) {
      return { ok: true, exitCode: 0, timedOut: false, durationMs: 0, outputTail: "", signature: "", logFile: "" };
    }
    return this.run(cwd, vc.install, "install");
  }

  runFull(cwd: string, vc: VerifyConfig, label?: string): Promise<VerifyResult> {
    return this.run(cwd, vc.full, label);
  }

  /** Runs `vc.tests` for the given files; falls back to runFull when there is no tests command or no files. */
  runTests(cwd: string, vc: VerifyConfig, files: string[], label?: string): Promise<VerifyResult> {
    if (!isCommand(vc.tests) || files.length === 0) return this.runFull(cwd, vc, label);
    return this.run(cwd, withFiles(vc.tests, files), label);
  }

  /** Never rejects: a missing command, a failed spawn or an unwritable log all end in a result. */
  private async run(cwd: string, command: string | undefined, label: string | undefined): Promise<VerifyResult> {
    const log = this.openLog(label);
    try {
      log.write(`$ ${command ?? ""}\n# cwd: ${cwd}\n# started: ${new Date().toISOString()}\n\n`);
      const tail = new LastLines(TAIL_LINES);
      const signature = new SignatureBuilder();
      const onLine = (line: string) => {
        log.write(line + "\n");
        tail.push(capLine(cleanLine(line)));
        signature.add(line);
      };

      // An empty command would "pass" without checking anything.
      const spawned = isCommand(command)
        ? await runProcess({
            command: "bash",
            // No login or rc files: they live outside the repository, where agents can write (~/.bash_profile with
            // "exit 0" would pass every check) and no diff, scan or reviewer looks. PATH comes from our env.
            args: ["--noprofile", "--norc", "-c", command],
            cwd,
            env: { ...scrubEnv(this.opts.env ?? process.env), CI: "1", FORCE_COLOR: "0" },
            timeoutMs: this.opts.timeoutMs,
            signal: this.opts.signal,
            onStdoutLine: onLine,
            onStderrLine: onLine,
            maxBufferBytes: CAPTURE_BYTES,
          })
        : undefined;
      const status = spawned
        ? describeOutcome(spawned, this.opts.timeoutMs)
        : "[mc] error: no verify command is configured";
      log.write(status + "\n");
      tail.push(status);
      signature.addStatus(status);

      const ok =
        spawned !== undefined && spawned.exitCode === 0 && !spawned.timedOut && spawned.spawnError === undefined;
      const result: VerifyResult = {
        ok,
        exitCode: spawned?.exitCode ?? null,
        timedOut: spawned?.timedOut ?? false,
        durationMs: spawned?.durationMs ?? 0,
        outputTail: tail.toArray().join("\n"),
        signature: ok ? "" : signature.digest(),
        logFile: log.file,
      };
      this.logger.info(`verify ${ok ? "passed" : "failed"}`, {
        command,
        cwd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        logFile: log.file,
      });
      return result;
    } finally {
      await log.close();
    }
  }

  /** A broken log must not fail verification: without one, the run goes ahead with logFile "". */
  private openLog(label: string | undefined): RunLog {
    let opened: { file: string; fd: number };
    try {
      opened = this.createLogFile(label);
    } catch (err) {
      this.logger.warn("verify log unavailable; running without one", {
        logsDir: this.opts.logsDir,
        error: String(err),
      });
      return { file: "", write: () => {}, close: async () => {} };
    }
    const stream = createWriteStream(opened.file, { fd: opened.fd });
    stream.on("error", () => {});
    return {
      file: opened.file,
      write: (text) => void stream.write(text),
      close: async () => {
        stream.end();
        await finished(stream).catch(() => {});
      },
    };
  }

  /** Creates `<logsDir>/verify-<label|timestamp>.log`, adding -2, -3… instead of overwriting an earlier run's log. */
  private createLogFile(label: string | undefined): { file: string; fd: number } {
    ensureDir(this.opts.logsDir);
    const base = `verify-${safeFileLabel(label) ?? new Date().toISOString().replace(/[:.]/g, "-")}`;
    for (let n = 1; ; n++) {
      const file = join(this.opts.logsDir, n === 1 ? `${base}.log` : `${base}-${n}.log`);
      try {
        return { file, fd: openSync(file, "wx") };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }
}

/** Configs come from agents and persisted state, so a "string" field may in fact be null or missing. */
function isCommand(command: unknown): command is string {
  return typeof command === "string" && command.trim() !== "";
}

/** The final status line for the log and tail; it only shapes a signature when the output has no failure lines. */
function describeOutcome(r: SpawnResult, timeoutMs: number): string {
  if (r.spawnError !== undefined) return `[mc] error: could not start the verify command: ${r.spawnError}`;
  if (r.timedOut) return `[mc] timeout: verify command killed after ${timeoutMs / 1000}s`;
  if (r.aborted) return "[mc] verify command aborted: Mission Control is stopping";
  if (r.exitCode === 0) return "[mc] verify command passed";
  if (r.exitCode === null) return `[mc] verify command failed: killed by ${r.signal ?? "a signal"}`;
  return `[mc] verify command failed with exit code ${r.exitCode}`;
}

/** Substitutes `{files}` with the shell-quoted paths, or appends them when the template has no placeholder. */
function withFiles(template: string, files: string[]): string {
  const quoted = files.map(shellQuote).join(" ");
  return template.includes("{files}") ? template.replaceAll("{files}", () => quoted) : `${template} ${quoted}`;
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

function safeFileLabel(label: string | undefined): string | undefined {
  const safe = label
    ?.replace(/[^\w.-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 100);
  return safe || undefined;
}

/** Cuts a line to MAX_LINE_CHARS, saying how much was dropped. */
function capLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)} … [${line.length - MAX_LINE_CHARS} chars cut]`;
}

/** Keeps the last `capacity` items pushed. */
class LastLines {
  private readonly items: string[] = [];
  private next = 0;

  constructor(private readonly capacity: number) {}

  push(item: string): void {
    if (this.items.length < this.capacity) this.items.push(item);
    else this.items[this.next] = item;
    this.next = (this.next + 1) % this.capacity;
  }

  toArray(): string[] {
    return [...this.items.slice(this.next), ...this.items.slice(0, this.next)];
  }
}

// ───────────────────────────── Output text helpers ─────────────────────────────

/** OSC strings (e.g. hyperlinks), CSI sequences (colors, cursor moves), and other two-byte escapes. */
const ANSI_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

/** The last `n` lines of `s` (a single trailing newline does not count as a line). */
export function tailLines(s: string, n: number): string {
  if (n <= 0) return "";
  const text = s.endsWith("\n") ? s.slice(0, -1) : s;
  let start = text.length;
  for (let count = 0; count < n; count++) {
    if (start <= 0) return text;
    const newline = text.lastIndexOf("\n", start - 1);
    if (newline < 0) return text;
    start = newline;
  }
  return text.slice(start + 1);
}

/** ANSI-free text as a terminal would finally show it: progress output redraws a line with "\r". */
function cleanLine(raw: string): string {
  const visible = stripAnsi(raw).replace(/\r+$/, "");
  return visible.slice(visible.lastIndexOf("\r") + 1);
}

// ───────────────────────────── Failure signatures ─────────────────────────────

const FAILURE_LINE = /(error|fail|failed|assert|expected|received|exception|cannot|undefined|not found|timeout)/i;
/**
 * Lines naming WHAT failed, which often carry no failure keyword: failed-test symbols (vitest ×, jest ✕/●,
 * node --test ✖), numbered failure headers (mocha, Playwright "1) [chromium] › …"), and Playwright locators.
 * Applied after normalization, which rewrites the header number to "N)".
 */
const FAILED_TEST_LINE = /^(?:[×✕✖✗✘●]|N\) )|\b[Ll]ocator:/;
const MAX_SIGNATURE_LINES = 60;
const FALLBACK_LINES = 30;
/** Bounds memory on enormous outputs; identical outputs still yield identical signatures. */
const MAX_DISTINCT_FAILURE_LINES = 10_000;

/** "  2) [chromium] › …": the number depends on the order parallel workers finished in. */
const FAILURE_NUMBER = /^\s*\d+\)\s+/;
const FILE_URL_PREFIX = /file:\/\/(?=\/)/g;
const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
/** Not preceded by ":" or a digit, so the "12:15" of "file.ts:12:15" stays a line:col. */
const CLOCK_TIME = /(?<![\d:.])\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AaPp][Mm]\b)?/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Two or more segments (so routes like "/login" survive), not part of a relative path or URL. */
const ABSOLUTE_PATH = /(?<![\w.~/:-])~?(?:\/[\w.@+%~-]+){2,}/g;
const TEMP_DIR = /^(?:\/private)?\/(?:tmp|var\/tmp|dev\/shm|var\/folders\/[^/]+\/[^/]+\/T)\/[^/]+$/;
const LINE_COL = /:\d+:\d+\b/g;
const PORT = /:\d{4,5}\b/g;
/** One separator alternative per branch: "\s*[:=]?\s*" would backtrack quadratically on long runs of spaces. */
const DURATION_FIELD = /\b(duration(?:_ms)?)["']?(?:\s*[:=]\s*|\s+)\d+(?:\.\d+)?/gi;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s|m|h|secs?|seconds?|mins?|minutes?)\b/gi;
const HEX = /\b(?:0x)?[0-9a-f]{8,}\b/gi;

/**
 * A 12-hex fingerprint of a failure that ignores run-to-run noise (durations, times, paths, ports, line:col, hashes).
 * Uses the distinct failure-looking lines (sorted, so parallel test output order doesn't matter; at most 60), or
 * the last 30 lines when none look like failures. "" when there is no output.
 */
export function failureSignature(output: string): string {
  const builder = new SignatureBuilder();
  for (const line of output.split("\n")) builder.add(line);
  return builder.digest();
}

/** Accumulates a signature line by line, so the Verifier never has to hold a whole run's output. */
class SignatureBuilder {
  private readonly failureLines = new Set<string>();
  private readonly recent = new LastLines(FALLBACK_LINES);

  add(rawLine: string): void {
    const line = normalizeLine(rawLine);
    if (line === "") return;
    this.recent.push(line);
    const failureLike = FAILURE_LINE.test(line) || FAILED_TEST_LINE.test(line);
    if (failureLike && this.failureLines.size < MAX_DISTINCT_FAILURE_LINES) this.failureLines.add(line);
  }

  /**
   * A line about the run rather than from it ("failed with exit code 1"). It only joins the last-lines fallback:
   * as a failure line it would always be present, so every failure without keyword lines would look the same.
   */
  addStatus(rawLine: string): void {
    const line = normalizeLine(rawLine);
    if (line !== "") this.recent.push(line);
  }

  digest(): string {
    const kept =
      this.failureLines.size > 0 ? [...this.failureLines].sort().slice(0, MAX_SIGNATURE_LINES) : this.recent.toArray();
    if (kept.length === 0) return "";
    return createHash("sha1").update(kept.join("\n")).digest("hex").slice(0, 12);
  }
}

function normalizeLine(raw: string): string {
  return cleanLine(raw)
    .slice(0, MAX_LINE_CHARS)
    .replace(FAILURE_NUMBER, "N) ")
    .replace(FILE_URL_PREFIX, "")
    .replace(ISO_TIMESTAMP, "<TIME>")
    .replace(CLOCK_TIME, "<TIME>")
    .replace(UUID, "<UUID>")
    .replace(ABSOLUTE_PATH, normalizePath)
    .replace(LINE_COL, ":L:C")
    .replace(PORT, ":<PORT>")
    .replace(DURATION_FIELD, "$1 <DUR>")
    .replace(DURATION, "<DUR>")
    .replace(HEX, "<HEX>")
    .trim();
}

/** A temp directory itself becomes "<TMP>"; any other absolute path keeps only its basename. */
function normalizePath(path: string): string {
  return TEMP_DIR.test(path) ? "<TMP>" : path.slice(path.lastIndexOf("/") + 1);
}

// ───────────────────────────── Frozen test files ─────────────────────────────

/**
 * SHA-256 of each regular file, keyed by repo-relative path (sorted, de-duplicated). Missing paths, directories and
 * anything that is not a readable regular file (symlinks, FIFOs, devices) are skipped.
 */
export async function hashFiles(cwd: string, paths: string[]): Promise<FrozenFile[]> {
  const unique = [...new Set(paths.map((p) => toRepoRelative(cwd, p)))].sort();
  const frozen: FrozenFile[] = [];
  for (const path of unique) {
    const state = inspectFile(join(cwd, path));
    if (state.kind === "file") frozen.push({ path, sha256: state.sha256 });
  }
  return frozen;
}

/** A frozen path that no longer holds a readable regular file (e.g. now a symlink or FIFO) counts as modified. */
export async function checkFrozen(
  cwd: string,
  frozen: FrozenFile[],
): Promise<{ ok: boolean; modified: string[]; missing: string[] }> {
  const modified: string[] = [];
  const missing: string[] = [];
  for (const file of frozen) {
    const state = inspectFile(join(cwd, file.path));
    if (state.kind === "missing") missing.push(file.path);
    else if (state.kind === "other" || state.sha256 !== file.sha256) modified.push(file.path);
  }
  return { ok: modified.length === 0 && missing.length === 0, modified, missing };
}

function toRepoRelative(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(cwd, path)).split(sep).join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`not a file path inside the repository: ${path}`);
  }
  return rel;
}

type FileState = { kind: "file"; sha256: string } | { kind: "missing" } | { kind: "other" };

/**
 * What a path holds, looked at without following a final symlink or blocking on a FIFO, since an agent may have
 * planted either. Only regular files are read (in bounded memory). Nothing there, or a directory, is "missing";
 * a symlink, FIFO, device, socket or unreadable file is "other".
 */
function inspectFile(absPath: string): FileState {
  let fd: number;
  try {
    fd = openSync(absPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "other" };
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isDirectory()) return { kind: "missing" };
    return stat.isFile() ? { kind: "file", sha256: sha256Fd(fd) } : { kind: "other" };
  } catch {
    return { kind: "other" };
  } finally {
    closeSync(fd);
  }
}

function sha256Fd(fd: number): string {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  for (let n = readSync(fd, chunk); n > 0; n = readSync(fd, chunk)) hash.update(chunk.subarray(0, n));
  return hash.digest("hex");
}

// ───────────────────────────── Globs ─────────────────────────────

const globCache = new Map<string, RegExp>();

/**
 * Glob match with `**`, `*`, `?` and `{a,b}`. A glob containing "/" is anchored at the repo root ("tests/**",
 * "src/*.ts"); one without "/" matches any path segment, like .gitignore ("*.test.ts" anywhere, "e2e" = that dir).
 */
export function matchesGlob(path: string, glob: string): boolean {
  let regex = globCache.get(glob);
  if (!regex) {
    regex = compileGlob(glob);
    globCache.set(glob, regex);
  }
  return regex.test(path.replace(/^\.\//, ""));
}

export function isTestPath(path: string, testGlobs: string[]): boolean {
  return testGlobs.some((glob) => matchesGlob(path, glob));
}

function compileGlob(glob: string): RegExp {
  let pattern = glob.replace(/^\.\//, "");
  if (pattern.endsWith("/")) pattern += "**";
  if (pattern.startsWith("/")) return new RegExp(`^${globBody(pattern.slice(1))}$`);
  if (pattern.includes("/")) return new RegExp(`^${globBody(pattern)}$`);
  return new RegExp(`(?:^|/)${globBody(pattern)}(?:/|$)`);
}

function globBody(glob: string): string {
  const braces = bracesBalanced(glob);
  let depth = 0;
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch === "*" && glob[i + 1] === "*") {
      // Each brace alternative starts and ends a segment too: "{tests/**,e2e/**}".
      const inAlternative = braces && depth > 0;
      const before = glob[i - 1];
      const after = glob[i + 2];
      const segmentStart =
        before === undefined || before === "/" || (inAlternative && (before === "{" || before === ","));
      const segmentEnd = after === undefined || (inAlternative && (after === "," || after === "}"));
      i++;
      if (segmentStart && after === "/") {
        out += "(?:[^/]*/)*"; // "**/": zero or more directories
        i++;
      } else if (segmentStart && segmentEnd) {
        out += ".*"; // trailing "**": everything below
      } else {
        out += "[^/]*";
      }
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (braces && ch === "{") {
      out += "(?:";
      depth++;
    } else if (braces && ch === "}") {
      out += ")";
      depth--;
    } else if (braces && ch === "," && depth > 0) out += "|";
    else out += ch.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
  }
  return out;
}

function bracesBalanced(glob: string): boolean {
  let depth = 0;
  for (const ch of glob) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

// ───────────────────────────── Anti-cheat diff scan ─────────────────────────────

export interface AntiCheatFinding {
  file: string;
  line: string;
  rule: string;
  severity: "blocker" | "warn";
}

interface LineRule {
  rule: string;
  severity: "blocker" | "warn";
  pattern: RegExp;
  testFilesOnly: boolean;
}

const LINE_RULES: LineRule[] = [
  {
    rule: "test-skip",
    severity: "blocker",
    testFilesOnly: true,
    // Also modifier chains (".skip.each(", "xit.each("), conditional runs (".runIf(") and module-level pytest marks.
    // Chains are bounded ({0,3}): an unbounded repeat backtracks quadratically on a long ".skip.skip…" line.
    pattern: /\.skip(?:If|Unless)?(?:\.\w+){0,3}\(|\bx(?:it|describe|test)(?:\.\w+){0,3}\(|\.runIf\(|\bpytest\.mark\.skip|\bpytest\.importorskip\(/,
  },
  { rule: "test-only", severity: "blocker", testFilesOnly: true, pattern: /\.only(?:\.\w+){0,3}\(/ },
  {
    rule: "test-todo",
    severity: "blocker",
    testFilesOnly: true,
    pattern: /\b(?:it|test|describe)\.(?:todo|fixme)(?:\.\w+){0,3}\(/,
  },
  {
    rule: "expected-failure",
    severity: "blocker",
    testFilesOnly: true,
    pattern: /\bpytest\.(?:mark\.)?xfail\b|\b(?:it|test)\.fails?(?:\.\w+){0,3}\(|\bexpectedFailure\b/,
  },
  {
    rule: "vacuous-assertion",
    severity: "blocker",
    testFilesOnly: true,
    pattern: /\bexpect\(\s*true\s*\)|\bassert\s+True\b|\bassert(?:\.ok)?\(\s*true\s*\)/,
  },
  {
    rule: "test-discovery",
    severity: "blocker",
    testFilesOnly: false,
    pattern: /\btestIgnore\b|\btestPathIgnorePatterns\b|--passWithNoTests\b|\bpassWithNoTests["']?\s*:\s*true\b/,
  },
  { rule: "ts-nocheck", severity: "warn", testFilesOnly: false, pattern: /@ts-nocheck/ },
  { rule: "eslint-disable", severity: "warn", testFilesOnly: false, pattern: /eslint-disable/ },
  { rule: "istanbul-ignore", severity: "warn", testFilesOnly: false, pattern: /istanbul ignore/ },
];

const ASSERTION_LINE = /\bexpect(?:\.\w+)?\(|\bassert/;
/** A commented-out assertion checks nothing, so comment-only lines never count as assertions. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/;
/** Net assertion lines that may disappear from test files before it counts as weakening the tests. */
const MAX_NET_ASSERTIONS_REMOVED = 2;
/** Test files by naming convention, even outside testGlobs (e.g. pre-existing tests in a feature mission). */
const CONVENTIONAL_TEST_FILE = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.py$/;
const TEST_CONFIG_FILE = /(?:^|\/)(?:vitest|vite|playwright|jest)[\w.-]*\.(?:config|workspace)\b[\w.-]*\.(?:[cm]?[jt]s|json)$/;
const MAX_FINDING_LINE_CHARS = 200;

/** Test-runner config keys that decide which test files run (Vitest/Vite, Playwright, Jest). */
const DISCOVERY_KEY = /["']?\b(?:include|exclude|testDir|testMatch|testRegex|testIgnore|testPathIgnorePatterns|grep|grepInvert)\b["']?\s*:/g;
/** Lists of tests to leave out: adding an entry can hide tests. */
const SKIPPING_LISTS = new Set(["exclude", "testIgnore", "testPathIgnorePatterns"]);
/** Lists of tests to run: removing an entry can hide tests. */
const SELECTING_LISTS = new Set(["include", "testMatch", "testRegex"]);
/** Config sections whose include/exclude pick source files or dependencies, not tests. */
const NON_TEST_SECTIONS = new Set([
  "coverage",
  "optimizeDeps",
  "build",
  "rollupOptions",
  "server",
  "preview",
  "resolve",
  "ssr",
  "css",
  "worker",
  "deps",
  "esbuild",
  "fs",
  "watch",
  "webServer",
  "use",
]);
/**
 * String literals and comments, whose brackets don't nest anything. An unterminated one runs to the end of the
 * line, so every attempt that starts matching succeeds and the scan stays linear.
 */
const STRING_OR_COMMENT = /(["'`])(?:\\.|\\$|(?!\1)[^\\])*(?:\1|$)|\/\/.*|\/\*.*?(?:\*\/|$)/g;

interface ScannedFile {
  change: FileChange;
  isTest: boolean;
  isTestConfig: boolean;
}

/** Scans a unified diff for changes that skip, weaken or hide tests (blockers) or silence checks (warnings). */
export function scanAntiCheat(diff: string, testGlobs: string[]): AntiCheatFinding[] {
  const files: ScannedFile[] = parseUnifiedDiff(diff).map((change) => ({
    change,
    isTest: isTestPath(change.path, testGlobs) || CONVENTIONAL_TEST_FILE.test(change.path),
    isTestConfig: TEST_CONFIG_FILE.test(change.path),
  }));
  const fresh = freshAddedLines(files);
  const findings = files.flatMap((file) => [
    ...lineRuleFindings(file, fresh),
    ...(file.isTestConfig ? testConfigFindings(file.change) : []),
  ]);
  findings.push(...assertionRemovalFindings(files.filter((file) => file.isTest).map((file) => file.change)));
  return uniqueFindings(findings);
}

function lineRuleFindings({ change, isTest }: ScannedFile, fresh: ReadonlySet<DiffLine>): AntiCheatFinding[] {
  const findings: AntiCheatFinding[] = [];
  for (const line of linesOf(change, "+")) {
    if (!fresh.has(line)) continue;
    for (const { rule, severity, pattern, testFilesOnly } of LINE_RULES) {
      if ((isTest || !testFilesOnly) && pattern.test(line.text)) {
        findings.push(finding(change.path, line.text, rule, severity));
      }
    }
  }
  return findings;
}

/**
 * Added lines that are not a removed line moved elsewhere: first within the same file (re-indented or reordered),
 * then across files of the same kind, test or not (a renamed or split file, since diffs come without renames).
 */
function freshAddedLines(files: ScannedFile[]): Set<DiffLine> {
  const leftovers = { test: new LineBag(), other: new LineBag() };
  const unmatched: { line: DiffLine; kind: "test" | "other" }[] = [];
  for (const { change, isTest } of files) {
    const kind = isTest ? "test" : "other";
    const removed = new LineBag(linesOf(change, "-").map((line) => line.text));
    for (const line of linesOf(change, "+")) if (!removed.take(line.text)) unmatched.push({ line, kind });
    leftovers[kind].addAll(removed);
  }
  return new Set(unmatched.filter(({ line, kind }) => !leftovers[kind].take(line.text)).map(({ line }) => line));
}

/**
 * Flags test files that lost assertion lines, once more than MAX_NET_ASSERTIONS_REMOVED are gone in total.
 * Within a file, rewritten assertions offset removed ones. Across files only verbatim moves do, so assertions
 * deleted from one test cannot be paid for with unrelated new assertions in another.
 */
function assertionRemovalFindings(testFiles: FileChange[]): AntiCheatFinding[] {
  const tallies = testFiles.map((change) => {
    const added = new LineBag(assertionLines(change, "+"));
    const removed = assertionLines(change, "-").filter((line) => !added.take(line));
    return { path: change.path, added, removed };
  });
  for (const tally of tallies) {
    tally.removed = tally.removed.filter((line) => !tallies.some((other) => other.added.take(line)));
  }
  const losses = tallies
    .map(({ path, added, removed }) => ({ path, lost: removed.length - added.size }))
    .filter(({ lost }) => lost > 0);
  const total = losses.reduce((sum, { lost }) => sum + lost, 0);
  if (total <= MAX_NET_ASSERTIONS_REMOVED) return [];
  return losses.map(({ path, lost }) => ({
    file: path,
    line: `${lost} assertion line(s) removed (net ${total} across test files)`,
    rule: "assertions-removed",
    severity: "blocker" as const,
  }));
}

function assertionLines(change: FileChange, kind: "+" | "-"): string[] {
  return linesOf(change, kind)
    .map((line) => line.text)
    .filter((text) => ASSERTION_LINE.test(text) && !COMMENT_LINE.test(text));
}

/**
 * Test-runner config edits that can drop tests: setting a discovery key, adding an entry to an existing list of
 * tests to leave out, or removing one from an existing list of tests to run. Brackets are tracked through the
 * lines a hunk shows, so `coverage.exclude` and the like are told apart; a key whose section is out of view counts.
 * Moved lines are not exempt here: moving an entry from one list to another changes what runs.
 */
function testConfigFindings(change: FileChange): AntiCheatFinding[] {
  const findings: AntiCheatFinding[] = [];
  const readded = new LineBag(linesOf(change, "+").map((line) => line.text));
  for (const hunk of change.hunks) {
    visitWithOpenBrackets(
      hunk.filter((line) => line.kind !== "-"),
      (line, openAt) => {
        if (line.kind === "+" && addsTestFilter(line.text, openAt)) {
          findings.push(finding(change.path, line.text, "test-discovery", "blocker"));
        }
      },
    );
    visitWithOpenBrackets(
      hunk.filter((line) => line.kind !== "+"),
      (line, openAt) => {
        if (line.kind === "-" && removesSelectedTests(line.text, openAt) && !readded.take(line.text)) {
          findings.push(finding(change.path, `(removed) ${line.text.trim()}`, "test-discovery", "blocker"));
        }
      },
    );
  }
  return findings;
}

/** A bracket still open at some point of a hunk, linked to the one enclosing it. */
interface OpenBracket {
  /** The key it belongs to ("test: {" → "test"), or "" when unnamed. */
  key: string;
  /** The line that opened it. */
  line: DiffLine;
  /** It, or a bracket around it, belongs to a non-test section such as `coverage`. */
  inNonTestSection: boolean;
  parent: OpenBracket | undefined;
}

/** The innermost bracket open at a column of the line being visited. */
type OpenAt = (column: number) => OpenBracket | undefined;

function addsTestFilter(text: string, openAt: OpenAt): boolean {
  const keyColumns = discoveryKeyColumns(text);
  if (keyColumns.length > 0) return keyColumns.some((column) => !openAt(column)?.inNonTestSection);
  return hasContent(text) && isExistingList(openAt(0), SKIPPING_LISTS);
}

function removesSelectedTests(text: string, openAt: OpenAt): boolean {
  return hasContent(text) && discoveryKeyColumns(text).length === 0 && isExistingList(openAt(0), SELECTING_LISTS);
}

function discoveryKeyColumns(text: string): number[] {
  return [...text.matchAll(DISCOVERY_KEY)].map((match) => match.index);
}

/** A list of one of these kinds, opened on an unchanged line, outside non-test sections. */
function isExistingList(list: OpenBracket | undefined, kinds: ReadonlySet<string>): boolean {
  return list !== undefined && kinds.has(list.key) && list.line.kind === " " && !list.inNonTestSection;
}

/** False for lines of only brackets and punctuation, such as the "]," closing a list. */
function hasContent(text: string): boolean {
  return /[\w"'`/]/.test(text);
}

/** Visits each line of a hunk (old or new side) with a way to get the bracket open at any of its columns. */
function visitWithOpenBrackets(view: DiffLine[], visit: (line: DiffLine, openAt: OpenAt) => void): void {
  let open: OpenBracket | undefined;
  for (const line of view) {
    const openAt = bracketCursor(open, line);
    visit(line, openAt);
    open = openAt(Infinity);
  }
}

/** Reads `line` from its start, given the bracket open there; cheapest when asked for columns in increasing order. */
function bracketCursor(start: OpenBracket | undefined, line: DiffLine): OpenAt {
  const code = line.text.replace(STRING_OR_COMMENT, (match) => " ".repeat(match.length));
  let open = start;
  let read = 0;
  return (column) => {
    if (column < read) [open, read] = [start, 0];
    for (; read < Math.min(column, code.length); read++) {
      const ch = code.charAt(read);
      if (ch === "{" || ch === "[" || ch === "(") {
        open = openBracket(open, keyBefore(line.text.slice(Math.max(0, read - 80), read)), line);
      } else if (ch === "}" || ch === "]" || ch === ")") {
        open = open?.parent;
      }
    }
    return open;
  };
}

function openBracket(parent: OpenBracket | undefined, key: string, line: DiffLine): OpenBracket {
  return { key, line, parent, inNonTestSection: NON_TEST_SECTIONS.has(key) || (parent?.inNonTestSection ?? false) };
}

/** The name an opening bracket belongs to: "test: {" → "test", "defineConfig({" → "defineConfig", "[" → "". */
function keyBefore(prefix: string): string {
  return /([\w$]+)["']?\s*[:=]?\s*\(?\s*$/.exec(prefix)?.[1] ?? "";
}

function finding(file: string, text: string, rule: string, severity: AntiCheatFinding["severity"]): AntiCheatFinding {
  return { file, line: text.trim().slice(0, MAX_FINDING_LINE_CHARS), rule, severity };
}

/** One finding per file, rule and line (a line can match both a line rule and the config check). */
function uniqueFindings(findings: AntiCheatFinding[]): AntiCheatFinding[] {
  const seen = new Set<string>();
  return findings.filter(({ file, rule, line }) => {
    const key = JSON.stringify([file, rule, line]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A multiset of lines, compared by their trimmed text. */
class LineBag {
  private readonly counts = new Map<string, number>();
  private total = 0;

  constructor(lines: Iterable<string> = []) {
    for (const line of lines) this.add(line);
  }

  get size(): number {
    return this.total;
  }

  add(line: string, count = 1): void {
    const key = line.trim();
    this.counts.set(key, (this.counts.get(key) ?? 0) + count);
    this.total += count;
  }

  addAll(other: LineBag): void {
    for (const [key, count] of other.counts) if (count > 0) this.add(key, count);
  }

  /** Removes one copy of `line`; false when there is none left. */
  take(line: string): boolean {
    const key = line.trim();
    const count = this.counts.get(key) ?? 0;
    if (count === 0) return false;
    this.counts.set(key, count - 1);
    this.total--;
    return true;
  }
}

type LineKind = "+" | "-" | " ";

interface DiffLine {
  kind: LineKind;
  text: string;
}

interface FileChange {
  path: string;
  hunks: DiffLine[][];
}

function linesOf(change: FileChange, kind: LineKind): DiffLine[] {
  return change.hunks.flatMap((hunk) => hunk.filter((line) => line.kind === kind));
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Splits a unified diff (git or plain) into per-file hunks. Hunk line counts decide where a hunk ends, so
 * "+++"/"---" content lines are never mistaken for file headers.
 */
function parseUnifiedDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let current: FileChange | undefined;
  let hunk: DiffLine[] = [];
  let oldPath: string | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  const startFile = (path: string): FileChange => {
    const file: FileChange = { path, hunks: [] };
    files.push(file);
    return file;
  };

  for (const rawLine of diff.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (oldLeft > 0 || newLeft > 0) {
      const marker = line.charAt(0);
      if (marker === "+" || marker === "-" || marker === " " || line === "") {
        hunk.push({ kind: marker === "+" || marker === "-" ? marker : " ", text: line.slice(1) });
        if (marker !== "+") oldLeft--;
        if (marker !== "-") newLeft--;
        continue;
      }
      if (marker === "\\") continue; // "\ No newline at end of file"
      oldLeft = newLeft = 0; // truncated or malformed hunk: treat the line as a header
    }

    const hunkHeader = HUNK_HEADER.exec(line);
    if (line.startsWith("diff --git ")) {
      current = startFile(pathFromGitHeader(line));
    } else if (line.startsWith("--- ")) {
      oldPath = headerPath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      const path = headerPath(line.slice(4)) ?? oldPath ?? "(unknown)"; // "+++ /dev/null": a deleted file
      if (!current || current.hunks.length > 0) current = startFile(path);
      else current.path = path;
    } else if (hunkHeader) {
      current ??= startFile(oldPath ?? "(unknown)");
      hunk = [];
      current.hunks.push(hunk);
      oldLeft = Number(hunkHeader[1] ?? 1);
      newLeft = Number(hunkHeader[2] ?? 1);
    }
  }
  return files;
}

/** Best effort for "diff --git a/x b/x"; the "+++"/"---" lines refine it whenever the file has hunks. */
function pathFromGitHeader(line: string): string {
  const rest = line.slice("diff --git ".length);
  const split = rest.lastIndexOf(" b/");
  return split >= 0 ? rest.slice(split + 3).replace(/"$/, "") : rest;
}

/** "a/src/x.ts\t<timestamp>" → "src/x.ts"; "/dev/null" → undefined. */
function headerPath(raw: string): string | undefined {
  const path = unquote(raw.split("\t")[0] ?? "");
  if (path === "/dev/null") return undefined;
  return path.replace(/^[ab]\//, "");
}

/** Git C-quotes paths with special characters: "a/my \"file\".ts". */
function unquote(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  return s.slice(1, -1).replace(/\\(.)/g, (_, ch: string) => (ch === "t" ? "\t" : ch === "n" ? "\n" : ch));
}
