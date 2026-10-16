// Mission Control's own checks of documents, pages and data files, and the engine's check of the second AI's answer
// (docs/modes-spec.md sections 6 and 8.3). Pure functions over text, no shell, no network, no AI, no `eval`.
//
// Rules that hold for every function here (spec 6.1 and 6.5):
//  * The engine opens only regular files (never a symbolic link) inside the feature's worktree whose real path is also
//    inside it. The paths come from git's changed list, plus the link targets that rules S06 and S07 test under the same
//    rules. No value from a plan is ever opened as a path: a plan value is only ever searched for, as plain text.
//  * No scanner takes more than linear time in the length of its input. Link and heading scanners are small loops with
//    a stack and a bounded look-ahead, not lazy or negated runs against a missing end (docs/modes-spec.md 2.7).
//    A markdown line over 2,000 characters is not given to the link, heading, comment or tag scanners, and the fact
//    `A very long line ... was not scanned` is added. The work is done one file at a time with a turn for the event
//    loop between files and between phases, so the run lock's heartbeat keeps going.
//  * Every name that reaches a message, a brief, an event or `mission.json` goes through `plainName` first.
//  * A message never prints the text of a key, a password or a table cell.
//  * At most 10 problems of at most 200 characters are kept, then `and <n> more.`
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import type { RenderedPage } from "./render.js";
import type { CheckedResult, Family, FeatureExpect, Finding, RubricOutput } from "./types.js";
import { cleanAiText, hasWords, isHiddenChar, writtenLength } from "./util/ai-text.js";

// ───────────────────────────── Limits ─────────────────────────────

/** Problems kept in a message (spec 6.2), then `and <n> more.` */
const MAX_PROBLEMS = 10;
const MAX_PROBLEM_CHARS = 200;
const MAX_FACTS = 30;
const MAX_FACT_CHARS = 300;
/** A markdown line longer than this is not given to the link, heading, comment or tag scanners (spec 6.5). */
const LINE_CAP = 2000;
/** A text file over 1 MB, or any other file over 5 MB, is reported (S03) and not read. */
const TEXT_LIMIT = 1024 * 1024;
const OTHER_LIMIT = 5 * 1024 * 1024;
/** At most this much text in all, and at most this many files, are looked at (spec 6.1). */
const TOTAL_LIMIT = 12 * 1024 * 1024;
const MAX_FILES = 60;
/** S29: the checks took longer than this in all. */
const TIME_LIMIT_MS = 60_000;
/** How far a link destination or a tag is searched for its end. A longer one is not a link or a tag here. */
const DEST_CAP = 300;
const TAG_CAP_MARKDOWN = 4000;
/** Slices of a long line for the key patterns (spec 6.2a). */
const SLICE = 2000;
const SLICE_OVERLAP = 200;

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ───────────────────────────── Small helpers ─────────────────────────────

/** True for a character that cannot be seen: the class the plan reader bans, in util/ai-text.ts. */
const isHidden = isHiddenChar;

function hex4(cp: number): string {
  return cp.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * A file name, link target or column name made safe for a message, a brief, an event or `mission.json`: control, format and
 * hidden characters (the class the plan reader bans) become `<U+XXXX>`, and the result is cut at `max` characters, with a
 * closing `…` when something was cut. The result is never longer than `max`.
 */
export function plainName(name: string, max = 80): string {
  const limit = Math.max(2, Math.floor(max));
  const tokens: string[] = [];
  let used = 0;
  let over = false;
  for (const ch of name) {
    const token = isHidden(ch) ? `<U+${hex4(ch.codePointAt(0) ?? 0)}>` : ch;
    tokens.push(token);
    used += token.length;
    if (used > limit) {
      over = true;
      break;
    }
  }
  if (!over) return tokens.join("");
  while (tokens.length > 0 && used > limit - 1) used -= tokens.pop()!.length;
  return tokens.join("") + "…";
}

/** A name as shown inside curly quote marks: cleaned, and a curly mark inside it shown as a straight one so the marks stay in pairs. */
function shown(name: string, max = 80): string {
  return plainName(name, max).replace(/[“”]/gu, '"');
}

function nfc(s: string): string {
  return s.normalize("NFC");
}

function collapse(s: string): string {
  // Only runs of white space and white space that is not a plain space need a change: most spaces stay as they are.
  return s.replace(/\s{2,}|[^\S ]/g, " ").trim();
}

/** Cuts to at most `max` code units (a closing `…` when cut) without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return s.slice(0, end) + "…";
}

/**
 * Adds every item of `list` to `target`, one by one. `target.push(...list)` hands the whole list to the call as arguments and throws
 * a RangeError when the list holds more than about 125,000 items (a file with that many findings of one kind).
 */
function pushAll<T>(target: T[], list: readonly T[]): void {
  for (const item of list) target.push(item);
}

function sameWords(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The text a heading or a word is compared by: NFC, no backticks or stars, capitals and spaces do not matter. */
function normalizeHeading(s: string): string {
  return collapse(nfc(s).replace(/[`*]/gu, "")).toLowerCase();
}

/** The plan's term or the page's text compared letter for letter, with white space collapsed. */
function normalizeTerm(s: string): string {
  return collapse(nfc(s));
}

/** Problems with their rule number, so that the first ten kept are the lowest rules (spec 6.2), deduplicated. */
class Problems {
  private readonly seen = new Set<string>();
  private readonly items: { rule: number; msg: string }[] = [];
  private extra = 0;

  add(rule: number, msg: string): void {
    if (this.seen.has(msg)) return;
    if (this.seen.size >= 50_000) {
      this.extra++;
      return;
    }
    this.seen.add(msg);
    this.items.push({ rule, msg });
  }

  get size(): number {
    return this.items.length + this.extra;
  }

  done(): string[] {
    const sorted = [...this.items].sort((a, b) => a.rule - b.rule);
    const total = sorted.length + this.extra;
    const out = sorted.slice(0, MAX_PROBLEMS).map((p) => cut(p.msg, MAX_PROBLEM_CHARS));
    if (total > MAX_PROBLEMS) out.push(`and ${total - MAX_PROBLEMS} more.`);
    return out;
  }
}

/** Facts, deduplicated, each cut, at most 30. */
class Facts {
  private readonly seen = new Set<string>();
  readonly list: string[] = [];

  add(fact: string): void {
    if (this.seen.has(fact) || this.list.length >= MAX_FACTS) return;
    this.seen.add(fact);
    this.list.push(cut(fact, MAX_FACT_CHARS));
  }
}

const MORE_LINE = /^and (\d+) more\.$/;

/**
 * Puts several outcomes together, in the order given: identical problems and facts once, at most 10 problems of at most
 * 200 characters, then `and <n> more.` A trailing `and <n> more.` of an input is counted, not repeated. For the dispatcher,
 * which has the problems of `checkDeliverables`, of `checkPageRendered` for each page (a text can be missing from both the
 * files and the drawn page: the same message is kept once) and the problem of rule S28.
 */
export function mergeOutcomes(...outcomes: RuleOutcome[]): RuleOutcome {
  const seen = new Set<string>();
  const problems: string[] = [];
  let extra = 0;
  for (const o of outcomes) {
    for (const p of o.problems) {
      const more = MORE_LINE.exec(p);
      if (more) {
        extra += Number(more[1]);
        continue;
      }
      if (seen.has(p)) continue;
      seen.add(p);
      problems.push(p);
    }
  }
  const total = problems.length + extra;
  const kept = problems.slice(0, MAX_PROBLEMS).map((p) => cut(p, MAX_PROBLEM_CHARS));
  if (total > MAX_PROBLEMS) kept.push(`and ${total - MAX_PROBLEMS} more.`);
  const facts = new Facts();
  for (const o of outcomes) for (const f of o.facts) facts.add(f);
  return { problems: kept, facts: facts.list };
}

// ───────────────────────────── Reading the files (spec 6.1) ─────────────────────────────

/**
 * The kind of a file, from its extension (spec 6.1): markdown (`.md`, `.markdown`), text (`.txt`), page (`.html`, `.htm`),
 * table (`.csv`), style sheet (`.css`), drawing (`.svg`), binary (`.png .jpg .jpeg .gif .webp .pdf .xlsx .docx .zip`:
 * its size is checked and nothing more), other (only S04 and the size run on it).
 */
export type FileKind = "markdown" | "text" | "page" | "table" | "style" | "drawing" | "binary" | "other";

/** One changed file that was read. */
export interface DeliverableFile {
  /** Repo-relative path as git reports it. Never shown without `plainName`. */
  path: string;
  kind: FileKind;
  /** Size in bytes. */
  size: number;
  /** True when the file did not exist at the start of the feature. */
  isNew: boolean;
  /** The text of the file now. Text kinds only; absent for binary files. */
  text?: string;
  /** The text of the file at the start of the feature (`git show <testsCommit>:<path>`). Absent for a new file and for non-text kinds. */
  before?: string;
  /** The lines the feature added; all the lines for a new file. Text kinds only. `words` (S10) counts over these. */
  added?: string[];
}

/** Why a changed file was not read (it is named in a fact or a problem). */
export interface SkippedFile {
  path: string;
  why:
    | "too_big" // S03: a text file over 1 MB, any other over 5 MB
    | "not_plain_file" // a symbolic link, or a real path outside the worktree
    | "removed" // deleted or renamed away
    | "left_out" // node_modules, test-results, playwright-report, .git, lock files
    | "not_looked_at"; // beyond the 60 files or the 12 MB in all
}

/** What the feature changed, read under the rules of spec 6.1. */
export interface Deliverables {
  /** The files that were read: sorted, at most 60, at most 12 MB of text in all. */
  files: DeliverableFile[];
  skipped: SkippedFile[];
  /** True when the feature only deleted or renamed files (S01 passes with a fact). */
  onlyRemoved: boolean;
  /** Facts found while reading (spec 6.2, "Facts"), already cleaned. */
  facts: string[];
  /**
   * The worktree the files were read from (as given to `readDeliverables`). The link rules S06 and S07 look at the disk
   * under it, with the reading rules of spec 6.1. Without it those two rules cannot run and are skipped.
   */
  worktree?: string;
}

/** Where `readDeliverables` gets git's answers from; the build passes the dispatcher's `Git`, tests pass a fake. */
export interface DeliverableSource {
  /** Absolute path of the feature's worktree. */
  worktree: string;
  /** What git reports as changed since the start of the feature (`Git.changedFiles(worktree, testsCommit)`): repo-relative, sorted, unique. */
  changed: string[];
  /** The text of a file at the start of the feature, or undefined when it did not exist then. */
  before(path: string): Promise<string | undefined>;
  /** The lines the feature added to a file, or undefined when the whole file is new. */
  added(path: string): Promise<string[] | undefined>;
}

const KIND_BY_EXT = new Map<string, FileKind>([
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".txt", "text"],
  [".html", "page"],
  [".htm", "page"],
  [".csv", "table"],
  [".css", "style"],
  [".svg", "drawing"],
  [".png", "binary"],
  [".jpg", "binary"],
  [".jpeg", "binary"],
  [".gif", "binary"],
  [".webp", "binary"],
  [".pdf", "binary"],
  [".xlsx", "binary"],
  [".docx", "binary"],
  [".zip", "binary"],
]);

/** The file kind of a path (spec 6.1). */
export function fileKind(path: string): FileKind {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "other";
  return KIND_BY_EXT.get(base.slice(dot).toLowerCase()) ?? "other";
}

function isTextKind(kind: FileKind): boolean {
  return kind !== "binary";
}

const LEFT_OUT_DIRS = new Set(["node_modules", "test-results", "playwright-report", ".git"]);
const LEFT_OUT_FILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);

function isLeftOut(rel: string): boolean {
  const parts = rel.split("/");
  for (let i = 0; i < parts.length - 1; i++) if (LEFT_OUT_DIRS.has(parts[i]!)) return true;
  const last = parts[parts.length - 1]!;
  return LEFT_OUT_FILES.has(last);
}

/** A path from git: relative, no empty, `.` or `..` part, no NUL. Anything else is never opened. */
function safeRel(rel: string): boolean {
  if (rel === "" || rel.startsWith("/") || rel.includes("\0")) return false;
  for (const part of rel.split("/")) if (part === "" || part === "." || part === "..") return false;
  return true;
}

type PlainRead =
  | { ok: true; size: number; text: string }
  | { ok: false; why: "removed" | "not_plain_file" | "too_big" };

/**
 * The one way a file is opened: the path must be safe, `lstat` must say it is a regular file (a symbolic link is never
 * followed), its real path must be inside the worktree's real path, and it must be small enough. `readText` false leaves
 * the content unread (a binary file: its size only).
 */
async function readPlain(root: string | undefined, rel: string, limit: number, readText: boolean): Promise<PlainRead> {
  if (root === undefined || !safeRel(rel)) return { ok: false, why: "not_plain_file" };
  const abs = join(root, ...rel.split("/"));
  let st;
  try {
    st = await lstat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, why: code === "ENOENT" || code === "ENOTDIR" ? "removed" : "not_plain_file" };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, why: "not_plain_file" };
  try {
    const real = await realpath(abs);
    if (real !== join(root, ...rel.split("/")) && !real.startsWith(root + sep)) return { ok: false, why: "not_plain_file" };
  } catch {
    return { ok: false, why: "not_plain_file" };
  }
  if (st.size > limit) return { ok: false, why: "too_big" };
  if (!readText) return { ok: true, size: st.size, text: "" };
  let handle;
  try {
    handle = await open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return { ok: false, why: "not_plain_file" };
  }
  try {
    const now = await handle.stat();
    if (!now.isFile() || (st.ino !== 0 && (now.ino !== st.ino || now.dev !== st.dev))) return { ok: false, why: "not_plain_file" };
    const buffer = Buffer.allocUnsafe(Math.min(st.size, limit) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > limit) return { ok: false, why: "too_big" };
    return { ok: true, size: filled, text: buffer.toString("utf8", 0, filled) };
  } catch {
    return { ok: false, why: "not_plain_file" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const UNREADABLE_BY_AI = new Map<string, string>([[".xlsx", "spreadsheet"], [".docx", "Word"], [".zip", "zip"], [".pdf", "PDF"]]);

/** Reads the changed files under the rules of spec 6.1. Never throws on a hostile file: it is skipped and named. */
export async function readDeliverables(source: DeliverableSource): Promise<Deliverables> {
  const files: DeliverableFile[] = [];
  const skipped: SkippedFile[] = [];
  const facts = new Facts();
  let root: string | undefined;
  try {
    root = await realpath(source.worktree);
  } catch {
    root = undefined;
  }
  const unique = [...new Set(source.changed)].sort();
  let totalText = 0;
  let notLooked = 0;
  const otherKinds: string[] = [];
  for (const rel of unique) {
    if (isLeftOut(rel)) {
      skipped.push({ path: rel, why: "left_out" });
      continue;
    }
    if (files.length >= MAX_FILES) {
      skipped.push({ path: rel, why: "not_looked_at" });
      notLooked++;
      continue;
    }
    const kind = fileKind(rel);
    const text = isTextKind(kind);
    const limit = text ? TEXT_LIMIT : OTHER_LIMIT;
    const read = await readPlain(root, rel, limit, text);
    if (!read.ok) {
      skipped.push({ path: rel, why: read.why });
      if (read.why === "not_plain_file") facts.add(`“${shown(rel)}” is not a plain file inside the project, so it was not read.`);
      continue;
    }
    if (text && totalText + read.size > TOTAL_LIMIT) {
      skipped.push({ path: rel, why: "not_looked_at" });
      notLooked++;
      continue;
    }
    if (text) totalText += read.size;
    let added: string[] | undefined;
    try {
      added = await source.added(rel);
    } catch {
      added = undefined;
    }
    const isNew = added === undefined;
    const file: DeliverableFile = { path: rel, kind, size: read.size, isNew };
    if (text) {
      file.text = read.text;
      file.added = isNew ? read.text.split(/\r\n|\r|\n/) : added!.slice(0, 500_000);
      if (!isNew) {
        let before: string | undefined;
        try {
          before = await source.before(rel);
        } catch {
          before = undefined;
        }
        if (before !== undefined && before.length <= TEXT_LIMIT) file.before = before;
      }
    }
    files.push(file);
    if (kind === "other") otherKinds.push(rel);
    const dot = rel.lastIndexOf(".");
    const word = dot >= 0 ? UNREADABLE_BY_AI.get(rel.slice(dot).toLowerCase()) : undefined;
    if (word !== undefined) facts.add(`“${shown(rel)}” is a ${word} file, which the second AI cannot read.`);
    await tick();
  }
  if (notLooked > 0) facts.add(`${notLooked} more ${sameWords(notLooked, "file", "files")} changed and ${sameWords(notLooked, "was", "were")} not looked at.`);
  if (otherKinds.length > 0) {
    const names = otherKinds.slice(0, 8).map((p) => `“${shown(p)}”`);
    facts.add(`It also changed files of other kinds: ${names.join(", ")}${otherKinds.length > 8 ? ` and ${otherKinds.length - 8} more` : ""}.`);
  }
  const onlyRemoved =
    files.length === 0 && skipped.some((s) => s.why === "removed") && skipped.every((s) => s.why === "removed" || s.why === "left_out");
  if (onlyRemoved) facts.add("It only removed files.");
  return { files, skipped, onlyRemoved, facts: facts.list, worktree: source.worktree };
}

// ───────────────────────────── The key patterns (spec 6.2a) ─────────────────────────────

/** A place where a line matches one of the ten key patterns of spec 6.2a. */
export interface SecretHit {
  /** From 1. */
  line: number;
  /** Which pattern, 1 to 10, in the order of spec 6.2a. */
  pattern: number;
  /** The matched text. For comparing a file with its earlier text (M25) only: NEVER print it or store it. */
  match: string;
}

// Every repeat has an upper bound, and none can run away: see the note on pattern 8 below.
const P1_PRIVATE_KEY = /-----BEGIN[ A-Z0-9]{0,40}PRIVATE KEY/g;
const P2_AWS = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const P3_GITHUB = /\bgh[pousr]_[A-Za-z0-9]{36,255}|\bgithub_pat_[A-Za-z0-9_]{22,255}/g;
const P4_SK = /\bsk-[A-Za-z0-9_-]{20,255}/g;
const P5_STRIPE = /\b(?:sk|rk)_live_[A-Za-z0-9]{16,255}/g;
const P6_SLACK = /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g;
const P7_GOOGLE = /\bAIza[A-Za-z0-9_-]{35}/g;
const P9_NAMED = /(?:password|passwd|pwd|secret|api_key|api-key|apikey|access_token|auth_token)["']?[ \t]{0,3}[:=][ \t]{0,3}["']?([^\s"']{8,255})/gi;
const P10_CREDENTIALS_IN_URL = /:\/\/[^\s/:@]{1,64}:([^\s/@]{3,64})@/g;

const PLACEHOLDER_START = /^(?:your|example|changeme|xxx|process\.env|os\.environ|getenv|import\.meta\.env)/i;

/** A value that is plainly a stand-in (`<token>`, `$TOKEN`, `{{ value }}`, `%VALUE%`, `*****`, `your-...`) and not a secret. */
function isPlaceholderValue(value: string): boolean {
  return "<${%*[".includes(value.charAt(0)) || /^&(?:lt|#0*60|#x0*3c);/i.test(value) || PLACEHOLDER_START.test(value);
}

function isUrlSafe(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 45 || code === 95;
}

/**
 * Pattern 8, a web token: three parts joined by dots, the first two starting `eyJ`, each part 8 or more URL-safe
 * characters. Written as a loop and not as one pattern: a pattern with a long run before a dot is tried again from every
 * `eyJ` inside a long run and costs a square of the run's length. Here a run is read once.
 */
function webTokens(slice: string): string[] {
  const found: string[] = [];
  let i = slice.indexOf("eyJ");
  while (i >= 0) {
    let end = i;
    while (end < slice.length && end - i < 2100 && isUrlSafe(slice.charCodeAt(end))) end++;
    if (slice.charCodeAt(end) === 46 && end - i >= 8 && slice.startsWith("eyJ", end + 1)) {
      let end2 = end + 1;
      while (end2 < slice.length && end2 - end < 2100 && isUrlSafe(slice.charCodeAt(end2))) end2++;
      if (slice.charCodeAt(end2) === 46 && end2 - end - 1 >= 8) {
        let end3 = end2 + 1;
        while (end3 < slice.length && end3 - end2 < 2100 && isUrlSafe(slice.charCodeAt(end3))) end3++;
        if (end3 - end2 - 1 >= 8) {
          found.push(slice.slice(i, end3));
          i = slice.indexOf("eyJ", end3);
          continue;
        }
      }
    }
    // Every `eyJ` inside this run would fail the same way, so go on from the end of the run.
    i = slice.indexOf("eyJ", Math.max(end, i + 3));
  }
  return found;
}

const SIMPLE_PATTERNS: [number, RegExp][] = [
  [1, P1_PRIVATE_KEY],
  [2, P2_AWS],
  [3, P3_GITHUB],
  [4, P4_SK],
  [5, P5_STRIPE],
  [6, P6_SLACK],
  [7, P7_GOOGLE],
];

function scanSlice(slice: string, lineNo: number, seen: Set<string>, hits: SecretHit[]): void {
  const push = (pattern: number, match: string): void => {
    const key = `${lineNo}|${pattern}|${match}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ line: lineNo, pattern, match });
  };
  for (const [pattern, re] of SIMPLE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(slice)) !== null) {
      push(pattern, m[0]);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  for (const token of webTokens(slice)) push(8, token);
  P9_NAMED.lastIndex = 0;
  let named: RegExpExecArray | null;
  while ((named = P9_NAMED.exec(slice)) !== null) {
    if (!isPlaceholderValue(named[1] ?? "")) push(9, named[0]);
  }
  P10_CREDENTIALS_IN_URL.lastIndex = 0;
  let address: RegExpExecArray | null;
  while ((address = P10_CREDENTIALS_IN_URL.exec(slice)) !== null) {
    if (!isPlaceholderValue(address[1] ?? "")) push(10, address[0]);
  }
}

/** Scans text for the ten patterns (long lines in slices of 2,000 characters that overlap by 200). Rule S04. */
export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length < 8) continue;
    if (line.length <= SLICE) {
      scanSlice(line, i + 1, seen, hits);
    } else {
      for (let start = 0; start < line.length; start += SLICE - SLICE_OVERLAP) {
        scanSlice(line.slice(start, start + SLICE), i + 1, seen, hits);
        if (start + SLICE >= line.length) break;
      }
    }
  }
  return hits;
}

// ───────────────────────────── Markdown ─────────────────────────────

/** A heading found in markdown. `text` has its inline marks taken out; `line` counts from 1. */
export interface MarkdownHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  line: number;
}

const K_PROSE = 0;
const K_CODE = 1;
const K_FENCE = 2;

interface MdModel {
  /** The lines with HTML comments taken out; the lines of a code block as they are. */
  lines: string[];
  kinds: Uint8Array;
  /** Numbers (from 1) of the lines over the cap, which the scanners did not look at. */
  longLines: number[];
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** The line without its HTML comments; `inComment` carries over to the next line. Linear: the position only moves forward. */
function stripComments(line: string, inComment: boolean): { text: string; inComment: boolean } {
  const parts: string[] = [];
  let pos = 0;
  let open = inComment;
  for (;;) {
    if (open) {
      const end = line.indexOf("-->", pos);
      if (end < 0) return { text: parts.join(""), inComment: true };
      pos = end + 3;
      open = false;
      parts.push(" ");
    } else {
      const start = line.indexOf("<!--", pos);
      if (start < 0) {
        parts.push(line.slice(pos));
        return { text: parts.join(""), inComment: false };
      }
      parts.push(line.slice(pos, start));
      pos = start + 4;
      open = true;
    }
  }
}

function parseMarkdown(text: string): MdModel {
  // A byte-order mark in front of the first heading would hide it.
  const raw = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r\n|\r|\n/);
  const lines = new Array<string>(raw.length);
  const kinds = new Uint8Array(raw.length);
  const longLines: number[] = [];
  let fence: { ch: string; len: number } | null = null;
  let inComment = false;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]!.charAt(0) === fence.ch && close[1]!.length >= fence.len) {
        fence = null;
        kinds[i] = K_FENCE;
        lines[i] = "";
      } else {
        kinds[i] = K_CODE;
        lines[i] = line;
      }
      continue;
    }
    if (line.length > LINE_CAP) {
      lines[i] = line;
      kinds[i] = K_PROSE;
      longLines.push(i + 1);
      continue;
    }
    const stripped = stripComments(line, inComment);
    inComment = stripped.inComment;
    lines[i] = stripped.text;
    kinds[i] = K_PROSE;
    const open = FENCE_OPEN.exec(stripped.text);
    if (open && !(open[1]!.charAt(0) === "`" && open[2]!.includes("`"))) {
      fence = { ch: open[1]!.charAt(0), len: open[1]!.length };
      kinds[i] = K_FENCE;
      lines[i] = "";
    }
  }
  return { lines, kinds, longLines };
}

interface InlineLink {
  target: string;
  image: boolean;
}

interface InlineScan {
  links: InlineLink[];
  /** The line with link syntax and code marks taken out; `<` inside code is kept as the private mark U+E000 so that it is not read as a tag. */
  plain: string;
  /** The line with the inside of code spans blanked (placeholder rules do not look inside code). */
  noCode: string;
}

const CODE_LT = String.fromCodePoint(0xe000);

/** The destination of an inline link that starts right after `(`; undefined when it is not a link or does not end within the cap. */
function linkDestination(line: string, from: number): { target: string; end: number } | undefined {
  let j = from;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  const limit = Math.min(line.length, j + DEST_CAP);
  let target: string;
  if (line.charAt(j) === "<") {
    const close = line.indexOf(">", j + 1);
    if (close < 0 || close >= limit) return undefined;
    target = line.slice(j + 1, close);
    j = close + 1;
  } else {
    let depth = 0;
    const start = j;
    while (j < limit) {
      const c = line.charCodeAt(j);
      if (c === 92 /* \ */) {
        j += 2;
        continue;
      }
      // A square bracket ends the search: a destination that holds one is rare, and stopping here keeps the work linear.
      if (c === 32 || c === 9 || c === 91 || c === 93 || c === 60) break;
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    target = line.slice(start, j);
  }
  let k = j;
  while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  if (line.charCodeAt(k) === 41) return { target, end: k + 1 };
  // An optional title in quotes or parentheses, then the closing parenthesis. Anything else is not a link.
  const open = line.charAt(k);
  if (k > j && (open === '"' || open === "'" || open === "(")) {
    const close = line.indexOf(open === "(" ? ")" : open, k + 1);
    if (close < 0 || close - k > DEST_CAP) return undefined;
    k = close + 1;
    while (k < line.length && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
    if (line.charCodeAt(k) === 41) return { target, end: k + 1 };
  }
  return undefined;
}

const QUICK_SPECIAL = /[[\]`<\\]/;

/**
 * One pass over a line: the links (inline, image and reference), the plain text, and the line without code. A stack of open
 * brackets and a bounded look-ahead keep it linear (spec 6.5). The caller does not pass a line over the cap.
 */
function scanInline(line: string): InlineScan {
  if (!QUICK_SPECIAL.test(line)) return { links: [], plain: line, noCode: line };
  const n = line.length;
  const deleted = new Uint8Array(n);
  const blank = new Uint8Array(n);
  const inCode = new Uint8Array(n);
  // Code spans: a run of backticks closes at the next run of the same length.
  for (let i = 0; i < n; ) {
    if (line.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let runEnd = i;
    while (runEnd < n && line.charCodeAt(runEnd) === 96) runEnd++;
    const len = runEnd - i;
    let j = runEnd;
    let found = -1;
    while (j < n) {
      const next = line.indexOf("`", j);
      if (next < 0) break;
      let end = next;
      while (end < n && line.charCodeAt(end) === 96) end++;
      if (end - next === len) {
        found = next;
        break;
      }
      j = end;
    }
    if (found < 0) {
      i = runEnd;
      continue;
    }
    for (let k = i; k < runEnd; k++) deleted[k] = 1;
    for (let k = found; k < found + len; k++) deleted[k] = 1;
    for (let k = runEnd; k < found; k++) {
      inCode[k] = 1;
      blank[k] = 1;
    }
    i = found + len;
  }
  const links: InlineLink[] = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inCode[i] === 1 || deleted[i] === 1) continue;
    const c = line.charCodeAt(i);
    if (c === 92) {
      i++;
    } else if (c === 91) {
      if (stack.length < LINE_CAP) stack.push(i);
    } else if (c === 93 && stack.length > 0) {
      const open = stack.pop()!;
      const next = line.charCodeAt(i + 1);
      if (next === 40) {
        const dest = linkDestination(line, i + 2);
        if (dest) {
          const image = open > 0 && line.charCodeAt(open - 1) === 33;
          links.push({ target: dest.target, image });
          deleted[open] = 1;
          if (image) deleted[open - 1] = 1;
          for (let k = i; k < dest.end; k++) deleted[k] = 1;
          i = dest.end - 1;
        }
      } else if (next === 91) {
        const limit = Math.min(n, i + 102);
        let close = -1;
        for (let k = i + 2; k < limit; k++) {
          if (line.charCodeAt(k) === 93) {
            close = k;
            break;
          }
        }
        if (close > 0) {
          deleted[open] = 1;
          for (let k = i; k <= close; k++) deleted[k] = 1;
          i = close;
        }
      }
    }
  }
  const plain: string[] = [];
  const noCode: string[] = [];
  for (let i = 0; i < n; i++) {
    const ch = line.charAt(i);
    if (blank[i] === 1) noCode.push(" ");
    else if (deleted[i] !== 1) noCode.push(ch);
    if (deleted[i] === 1) continue;
    plain.push(inCode[i] === 1 && ch === "<" ? CODE_LT : ch);
  }
  return { links, plain: plain.join(""), noCode: noCode.join("") };
}

/** The marks of emphasis taken out of a line: stars and tildes next to words, underscores that start or end a word. */
function stripEmphasis(s: string): string {
  return s
    .replace(/\*{1,3}(?=\S)|(?<=\S)\*{1,3}/gu, "")
    .replace(/~~/gu, "")
    .replace(/(?<![\p{L}\p{N}_])_{1,2}(?=[^\s_])|(?<=[^\s_])_{1,2}(?![\p{L}\p{N}_])/gu, "");
}

/** The text of a heading with its inline marks taken out: link text kept, code marks and emphasis removed. */
function headingText(raw: string): string {
  const plain = raw.length > LINE_CAP ? raw : scanInline(raw).plain.replaceAll(CODE_LT, "<");
  return collapse(decodeEntities(stripEmphasis(plain)));
}

const BLOCK_HTML_START = /^ {0,3}<(?:div|details|table|pre|section|article|aside|ul|ol|p|center|figure|nav|header|footer|main|blockquote|dl|form|iframe|script|style|h[1-6])(?=[\s/>]|$)/i;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_OR_QUOTE = /^ {0,3}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|>)/;
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;

function headingsOf(model: MdModel): MarkdownHeading[] {
  const out: MarkdownHeading[] = [];
  let para: { start: number; lines: string[] } | null = null;
  let htmlBlock = false;
  for (let i = 0; i < model.lines.length; i++) {
    if (model.kinds[i] !== K_PROSE) {
      para = null;
      htmlBlock = false;
      continue;
    }
    const line = model.lines[i]!;
    if (line.length > LINE_CAP) {
      para = null;
      continue;
    }
    if (line.trim() === "") {
      para = null;
      htmlBlock = false;
      continue;
    }
    if (htmlBlock) continue;
    if (BLOCK_HTML_START.test(line)) {
      htmlBlock = true;
      para = null;
      continue;
    }
    // ATX: up to three spaces, one to six #, then a space or the end.
    let indent = 0;
    while (indent < line.length && line.charCodeAt(indent) === 32) indent++;
    if (indent <= 3 && line.charCodeAt(indent) === 35) {
      let level = 0;
      while (indent + level < line.length && line.charCodeAt(indent + level) === 35) level++;
      const after = line.charAt(indent + level);
      if (level <= 6 && (after === "" || after === " " || after === "\t")) {
        let content = line.slice(indent + level).trim();
        let end = content.length;
        while (end > 0 && content.charCodeAt(end - 1) === 35) end--;
        if (end < content.length && (end === 0 || content.charAt(end - 1) === " " || content.charAt(end - 1) === "\t")) content = content.slice(0, end).trim();
        out.push({ level: level as MarkdownHeading["level"], text: headingText(content), line: i + 1 });
        para = null;
        continue;
      }
    }
    const underline = SETEXT_UNDERLINE.exec(line);
    if (underline) {
      if (para !== null) {
        out.push({ level: underline[1]!.charAt(0) === "=" ? 1 : 2, text: headingText(para.lines.join(" ")), line: para.start });
        para = null;
        continue;
      }
      para = null;
      continue;
    }
    if (THEMATIC.test(line) || LIST_OR_QUOTE.test(line) || indent >= 4) {
      para = null;
      continue;
    }
    if (para === null) para = { start: i + 1, lines: [] };
    para.lines.push(line.trim());
  }
  return out;
}

/** The headings of a markdown text (`#` and underlined), skipping code fences, HTML comments and raw HTML. Linear in the text. */
export function markdownHeadings(text: string): MarkdownHeading[] {
  return headingsOf(parseMarkdown(text));
}

/** GitHub's anchor for each heading text, in order: lowercase, punctuation removed, spaces to dashes, `-1`, `-2` for repeats. */
export function githubSlugs(headings: string[]): string[] {
  const used = new Set<string>();
  const counts = new Map<string, number>();
  const out: string[] = [];
  for (const heading of headings) {
    const base = nfc(heading).trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "").replace(/ /gu, "-");
    let slug = base;
    let n = counts.get(base) ?? 0;
    if (used.has(slug)) {
      do {
        n++;
        slug = `${base}-${n}`;
      } while (used.has(slug));
    }
    counts.set(base, n);
    used.add(slug);
    out.push(slug);
  }
  return out;
}

// ───────────────────────────── HTML (pages, and raw HTML in markdown) ─────────────────────────────

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TAGS = new Set(["script", "style", "title"]);
const INVISIBLE_TAGS = new Set(["head", "noscript", "template", "select", "datalist"]);
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "br", "caption", "dd", "details", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary",
  "table", "td", "th", "tr", "ul",
]);
const RAW_CLOSE: Record<string, RegExp> = {
  script: /<\/script(?=[\s/>]|$)/gi,
  style: /<\/style(?=[\s/>]|$)/gi,
  title: /<\/title(?=[\s/>]|$)/gi,
};
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: String.fromCodePoint(0xa9),
  hellip: String.fromCodePoint(0x2026),
  mdash: String.fromCodePoint(0x2014),
  ndash: String.fromCodePoint(0x2013),
  rsquo: String.fromCodePoint(0x2019),
  lsquo: String.fromCodePoint(0x2018),
  ldquo: String.fromCodePoint(0x201c),
  rdquo: String.fromCodePoint(0x201d),
  middot: String.fromCodePoint(0xb7),
  bull: String.fromCodePoint(0x2022),
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/gu, (whole, dec: string | undefined, hexa: string | undefined, name: string | undefined) => {
    if (name !== undefined) return Object.hasOwn(NAMED_ENTITIES, name.toLowerCase()) ? NAMED_ENTITIES[name.toLowerCase()]! : whole;
    const cp = dec !== undefined ? Number(dec) : parseInt(hexa ?? "", 16);
    if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
    return String.fromCodePoint(cp);
  });
}

function isAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

interface HtmlTag {
  name: string;
  attrs: Map<string, string>;
  selfClosing: boolean;
  end: number;
}

/** Reads one start tag at `start` (the `<`). Every character is read once. undefined when it does not end before `limit`. */
function parseOpenTag(s: string, start: number, limit: number): HtmlTag | undefined {
  let j = start + 1;
  while (j < limit) {
    const c = s.charCodeAt(j);
    if (isAlpha(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95) j++;
    else break;
  }
  const name = s.slice(start + 1, j).toLowerCase();
  const attrs = new Map<string, string>();
  let selfClosing = false;
  while (j < limit) {
    const c = s.charCodeAt(j);
    if (isSpace(c)) {
      j++;
      continue;
    }
    if (c === 62 /* > */) return { name, attrs, selfClosing, end: j + 1 };
    if (c === 47 /* / */) {
      if (s.charCodeAt(j + 1) === 62) selfClosing = true;
      j++;
      continue;
    }
    let k = j;
    while (k < limit) {
      const d = s.charCodeAt(k);
      if (isSpace(d) || d === 61 || d === 62 || d === 47) break;
      k++;
    }
    if (k === j) {
      j++;
      continue;
    }
    const attr = s.slice(j, k).toLowerCase();
    j = k;
    while (j < limit && isSpace(s.charCodeAt(j))) j++;
    let value = "";
    if (s.charCodeAt(j) === 61) {
      j++;
      while (j < limit && isSpace(s.charCodeAt(j))) j++;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        const close = s.indexOf(String.fromCharCode(q), j + 1);
        if (close < 0 || close >= limit) return undefined;
        value = s.slice(j + 1, close);
        j = close + 1;
      } else {
        let v = j;
        while (v < limit) {
          const d = s.charCodeAt(v);
          if (isSpace(d) || d === 62) break;
          v++;
        }
        value = s.slice(j, v);
        j = v;
      }
    }
    if (!attrs.has(attr) && attrs.size < 64) attrs.set(attr, value.length > 4000 ? value.slice(0, 4000) : value);
  }
  return undefined;
}

/** A thing a page or a markdown text points at: the tag, the attribute, the value, and a `link` tag's `rel`. */
interface HtmlRef {
  tag: string;
  attr: string;
  value: string;
  rel?: string;
}

interface HtmlSummary {
  title: string | undefined;
  hasViewport: boolean;
  imgNoAlt: number;
  refs: HtmlRef[];
  headings: { level: number; text: string }[];
  ids: Set<string>;
  /** Style sheets: the inside of every `<style>` and every `style` attribute. */
  css: string[];
  /** The `content` of every `<meta http-equiv="refresh">`. */
  refresh: string[];
}

const REF_ATTRS: Record<string, string[]> = {
  a: ["href"], area: ["href"], link: ["href"], img: ["src", "srcset"], script: ["src"], iframe: ["src"], video: ["src", "poster"], audio: ["src"],
  source: ["src", "srcset"], embed: ["src"], track: ["src"], input: ["src"], object: ["data"], form: ["action"], image: ["href", "xlink:href"], use: ["href", "xlink:href"],
  feimage: ["href", "xlink:href"],
};

/**
 * A scanner for HTML that keeps a stack of open elements, so that text inside a comment, a script, a style, a head or an
 * element marked hidden is not counted as visible text (spec M28). Every character is read once. Text can be fed in
 * pieces (the lines of a markdown file); `maxTag` bounds how far a tag is looked for its end in that case.
 */
class HtmlScanner {
  readonly summary: HtmlSummary = { title: undefined, hasViewport: false, imgNoAlt: 0, refs: [], headings: [], ids: new Set(), css: [], refresh: [] };
  private readonly parts: string[] = [];
  private readonly stack: { name: string; invisible: boolean }[] = [];
  private readonly counts = new Map<string, number>();
  private raw: string | undefined;
  private rawBuf: string[] = [];
  private heading: { level: number; parts: string[] } | undefined;

  constructor(private readonly maxTag: number = Infinity) {}

  private invisible(): boolean {
    return this.stack.length > 0 && this.stack[this.stack.length - 1]!.invisible;
  }

  private addText(t: string): void {
    if (t === "" || this.invisible()) return;
    const d = decodeEntities(t);
    this.parts.push(d);
    this.heading?.parts.push(d);
  }

  private endRaw(): void {
    const name = this.raw;
    this.raw = undefined;
    const content = this.rawBuf.join("");
    this.rawBuf = [];
    if (name === "style") this.summary.css.push(content.length > TEXT_LIMIT ? content.slice(0, TEXT_LIMIT) : content);
    if (name === "title" && this.summary.title === undefined) this.summary.title = collapse(decodeEntities(content));
  }

  private finishHeading(): void {
    if (!this.heading) return;
    this.summary.headings.push({ level: this.heading.level, text: collapse(this.heading.parts.join("")) });
    this.heading = undefined;
  }

  private open(tag: HtmlTag): void {
    const { name, attrs } = tag;
    if (BLOCK_TAGS.has(name)) this.addText("\n");
    const id = attrs.get("id");
    if (id !== undefined && id !== "") this.summary.ids.add(id);
    if (name === "a") {
      const anchorName = attrs.get("name");
      if (anchorName !== undefined && anchorName !== "") this.summary.ids.add(anchorName);
    }
    const style = attrs.get("style");
    if (style !== undefined && style !== "") this.summary.css.push(style);
    const refAttrs = Object.hasOwn(REF_ATTRS, name) ? REF_ATTRS[name] : undefined;
    if (refAttrs) {
      for (const attr of refAttrs) {
        const value = attrs.get(attr);
        if (value !== undefined && value !== "") {
          const ref: HtmlRef = { tag: name, attr, value };
          const rel = attrs.get("rel");
          if (rel !== undefined) ref.rel = rel;
          this.summary.refs.push(ref);
        }
      }
    }
    if (name === "img" && !attrs.has("alt")) this.summary.imgNoAlt++;
    if (name === "meta") {
      if ((attrs.get("name") ?? "").trim().toLowerCase() === "viewport") this.summary.hasViewport = true;
      if ((attrs.get("http-equiv") ?? "").trim().toLowerCase() === "refresh") this.summary.refresh.push(attrs.get("content") ?? "");
    }
    const hiddenHere =
      attrs.has("hidden") || INVISIBLE_TAGS.has(name) || /display\s*:\s*none|visibility\s*:\s*hidden/i.test((style ?? "").slice(0, 2000));
    const invisible = this.invisible() || hiddenHere;
    if (/^h[1-6]$/.test(name)) {
      this.finishHeading();
      if (!invisible) this.heading = { level: Number(name.charAt(1)), parts: [] };
    }
    if (!VOID_TAGS.has(name) && !tag.selfClosing) {
      this.stack.push({ name, invisible });
      this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    }
    if (RAW_TAGS.has(name) && !tag.selfClosing) {
      this.raw = name;
      this.rawBuf = [];
    }
  }

  private close(name: string): void {
    if (/^h[1-6]$/.test(name) && this.heading?.level === Number(name.charAt(1))) this.finishHeading();
    if (BLOCK_TAGS.has(name)) this.addText("\n");
    if ((this.counts.get(name) ?? 0) <= 0) return;
    for (;;) {
      const top = this.stack.pop();
      if (!top) return;
      this.counts.set(top.name, (this.counts.get(top.name) ?? 1) - 1);
      if (top.name === name) return;
    }
  }

  feed(s: string): void {
    const n = s.length;
    let i = 0;
    while (i < n) {
      if (this.raw !== undefined) {
        const re = RAW_CLOSE[this.raw]!;
        re.lastIndex = i;
        const m = re.exec(s);
        const keep = this.raw !== "script";
        if (!m) {
          if (keep && this.rawBuf.length < 5000) this.rawBuf.push(s.slice(i));
          return;
        }
        if (keep) this.rawBuf.push(s.slice(i, m.index));
        const gt = s.indexOf(">", m.index);
        i = gt < 0 ? n : gt + 1;
        const closed = this.raw;
        this.endRaw();
        this.close(closed);
        continue;
      }
      const lt = s.indexOf("<", i);
      if (lt < 0) {
        this.addText(s.slice(i));
        return;
      }
      if (lt > i) this.addText(s.slice(i, lt));
      const c1 = s.charCodeAt(lt + 1);
      if (c1 === 33 || c1 === 63) {
        if (s.startsWith("<!--", lt)) {
          const end = s.indexOf("-->", lt + 4);
          i = end < 0 ? n : end + 3;
        } else {
          const end = s.indexOf(">", lt + 2);
          i = end < 0 ? n : end + 1;
        }
        continue;
      }
      if (c1 === 47 && isAlpha(s.charCodeAt(lt + 2))) {
        let j = lt + 2;
        while (j < n && (isAlpha(s.charCodeAt(j)) || (s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) || s.charCodeAt(j) === 45 || s.charCodeAt(j) === 58)) j++;
        const name = s.slice(lt + 2, j).toLowerCase();
        const gt = s.indexOf(">", j);
        if (gt < 0 || gt - lt > this.maxTag) {
          if (Number.isFinite(this.maxTag)) {
            this.addText(s.slice(lt));
            return;
          }
          i = n;
          this.close(name);
          continue;
        }
        this.close(name);
        i = gt + 1;
        continue;
      }
      if (isAlpha(c1)) {
        const limit = Number.isFinite(this.maxTag) ? Math.min(n, lt + this.maxTag) : n;
        const tag = parseOpenTag(s, lt, limit);
        if (!tag) {
          if (Number.isFinite(this.maxTag)) {
            // The rest of this piece is text: looking again from every later "<" could cost a square.
            this.addText(s.slice(lt));
            return;
          }
          i = n;
          continue;
        }
        this.open(tag);
        i = tag.end;
        continue;
      }
      this.addText("<");
      i = lt + 1;
    }
  }

  finish(): void {
    if (this.raw !== undefined) this.endRaw();
    this.finishHeading();
  }

  text(): string {
    return collapse(this.parts.join(""));
  }
}

function scanHtml(text: string): { summary: HtmlSummary; text: string } {
  const scanner = new HtmlScanner();
  scanner.feed(text);
  scanner.finish();
  return { summary: scanner.summary, text: scanner.text() };
}

// ───────────────────────────── CSV (spec S11 to S17, S27) ─────────────────────────────

/** A CSV text read by RFC 4180. A leading byte-order mark, CRLF and a final blank line are fine. */
export interface CsvParse {
  rows: string[][];
  /** True when a quote mark was opened and never closed (S11). */
  unclosedQuote: boolean;
}

export function parseCsv(text: string): CsvParse {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  const n = src.length;
  let row: string[] = [];
  let i = 0;
  let unclosed = false;
  let rowOpen = false;
  while (i < n) {
    // One field.
    rowOpen = true;
    let value: string;
    if (src.charCodeAt(i) === 34) {
      const parts: string[] = [];
      i++;
      let closed = false;
      while (i < n) {
        const q = src.indexOf('"', i);
        if (q < 0) {
          parts.push(src.slice(i));
          i = n;
          break;
        }
        parts.push(src.slice(i, q));
        if (src.charCodeAt(q + 1) === 34) {
          parts.push('"');
          i = q + 2;
        } else {
          i = q + 1;
          closed = true;
          break;
        }
      }
      if (!closed) unclosed = true;
      // Anything between the closing quote and the separator is kept as it is.
      let tailEnd = i;
      while (tailEnd < n) {
        const c = src.charCodeAt(tailEnd);
        if (c === 44 || c === 10 || c === 13) break;
        tailEnd++;
      }
      parts.push(src.slice(i, tailEnd));
      i = tailEnd;
      value = parts.join("");
    } else {
      let end = i;
      while (end < n) {
        const c = src.charCodeAt(end);
        if (c === 44 || c === 10 || c === 13) break;
        end++;
      }
      value = src.slice(i, end);
      i = end;
    }
    row.push(value);
    const c = src.charCodeAt(i);
    if (c === 44) {
      i++;
      if (i >= n) {
        row.push("");
        rows.push(row);
        row = [];
        rowOpen = false;
      }
      continue;
    }
    if (c === 13 && src.charCodeAt(i + 1) === 10) i += 2;
    else if (c === 10 || c === 13) i++;
    rows.push(row);
    row = [];
    rowOpen = false;
  }
  if (rowOpen && row.length > 0) rows.push(row);
  // A final blank line is not a row.
  const last = rows[rows.length - 1];
  if (last !== undefined && last.length === 1 && last[0] === "" && rows.length > 0 && /(?:\r\n|\r|\n)$/.test(src)) {
    // "a\n\n": the empty last record came from a blank last line.
    rows.pop();
  }
  return { rows, unclosedQuote: unclosed };
}

const PLAIN_NUMBER = /^[+-]?(?:\d+|\d{1,3}(?:[,. ]\d{3})+)(?:[.,]\d+)?(?:[eE][+-]?\d+)?%?$/;

/** Whether a spreadsheet may run this cell as a formula (S27). */
function looksLikeFormula(cell: string): boolean {
  const first = cell.charAt(0);
  if (first === "=" || first === "@" || first === "\t" || first === "\r") return true;
  if (first === "+" || first === "-") {
    if (cell.length === 1) return false;
    if (cell.length > 80) return true;
    return !PLAIN_NUMBER.test(cell);
  }
  return false;
}

// ───────────────────────────── Links (S06, S07) ─────────────────────────────

type LinkTarget = { kind: "skip" } | { kind: "external" } | { kind: "local"; path: string; anchor: string; rootRelative: boolean };

/** What a link or picture target points at. Linear in the target; only its first 2,000 characters are read. */
function classifyTarget(value: string): LinkTarget {
  let v = value.length > LINE_CAP ? value.slice(0, LINE_CAP) : value;
  v = v.replace(/[\t\n\r]/gu, "").trim();
  if (v === "") return { kind: "skip" };
  if (/^[\\/]{2}/.test(v)) return { kind: "external" };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]{0,20}):/.exec(v);
  if (scheme) return /^https?$/i.test(scheme[1]!) ? { kind: "external" } : { kind: "skip" };
  let anchor = "";
  const hash = v.indexOf("#");
  if (hash >= 0) {
    anchor = v.slice(hash + 1);
    v = v.slice(0, hash);
  }
  const query = v.indexOf("?");
  if (query >= 0) v = v.slice(0, query);
  let path = v;
  try {
    path = decodeURIComponent(v);
  } catch {
    path = v;
  }
  const rootRelative = path.startsWith("/");
  if (rootRelative) path = path.replace(/^\/+/u, "");
  return { kind: "local", path, anchor, rootRelative };
}

function resolveTarget(fromFile: string, target: { path: string; rootRelative: boolean }): string | undefined {
  if (target.path.includes("\0")) return undefined;
  if (target.path === "") return target.rootRelative ? "." : fromFile;
  const joined = target.rootRelative ? posix.normalize(target.path) : posix.normalize(posix.join(posix.dirname(fromFile), target.path));
  if (joined === ".." || joined.startsWith("../") || joined.startsWith("/")) return undefined;
  return joined.replace(/\/+$/u, "") || ".";
}

function hasExtension(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9]{1,8}$/.test(base);
}

// ───────────────────────────── The rules ─────────────────────────────

/** What a rule set found. A problem fails the attempt; a fact is shown to the second AI and the owner and never fails. */
export interface RuleOutcome {
  /** The messages of spec 6.2, verbatim, at most 10 of at most 200 characters, then `and <n> more.` */
  problems: string[];
  facts: string[];
}

/** What `checkDeliverables` found: `pass` is `problems.length === 0`. */
export interface DeliverableCheck extends RuleOutcome {
  pass: boolean;
}

export interface CheckInput {
  deliverables: Deliverables;
  /** The plan's script-checked keys (`heading`, `mention`, `words`, `columns`, `rows`). Absent = none. */
  expect?: FeatureExpect;
  /** A clock in milliseconds, for the 60-second limit of S29. Default: `Date.now`. */
  now?: () => number;
}

/** One thing a rule found in one text. `key` is what makes two findings "the same" for rule M25. */
interface Found {
  rule: number;
  key: string;
  message: string;
}

/** The fixed words of the messages (spec 6.2). */
const MSG = {
  noFiles: "It changed no files.",
  empty: (f: string) => `“${f}” is empty.`,
  tooBig: (f: string, mb: number) => `“${f}” is larger than ${mb} MB, which is too big for a document, a page or a data file.`,
  secret: (f: string, line: number) => `“${f}” has text that looks like a key or a password (line ${line}). Remove it.`,
  placeholder: (f: string, what: string) => `“${f}” still has placeholder text (“${what}”).`,
  deadLink: (target: string, f: string) => `The link to “${target}” in “${f}” does not lead to a file in the project.`,
  deadAnchor: (anchor: string, f: string) => `The link to the heading “#${anchor}” in “${f}” does not lead to a heading.`,
  deadAnchorElsewhere: (anchor: string, target: string, f: string) => `The link to the heading “#${anchor}” in “${target}” (from “${f}”) does not lead to a heading.`,
  noHeading: (h: string) => `The text has no heading called “${h}”.`,
  noMention: (t: string) => `The visible text does not contain “${t}”.`,
  words: (n: number, a: number, b: number) => `The new text has ${n} ${sameWords(n, "word", "words")}; it should have ${a} to ${b}.`,
  csvQuote: (f: string) => `“${f}” is not a valid table: a quote mark is opened and never closed.`,
  csvNoHeader: (f: string) => `“${f}” has no header row.`,
  csvEmptyName: (f: string) => `“${f}” has a column with no name in its first row.`,
  csvDuplicate: (f: string, name: string) => `“${f}” has two columns called “${name}”.`,
  csvRagged: (row: number, f: string, a: number, b: number) => `Row ${row} of “${f}” has ${a} ${sameWords(a, "value", "values")}, but the first row has ${b}.`,
  csvRaggedMore: (k: number, f: string) => `${k} more ${sameWords(k, "row", "rows")} of “${f}” ${sameWords(k, "has", "have")} the wrong number of values.`,
  csvColumns: (f: string, a: string, b: string) => `“${f}” has the columns ${a}, but the plan asks for ${b}.`,
  csvRows: (f: string, n: number, a: number, b: number) => `“${f}” has ${n} ${sameWords(n, "row", "rows")}; it should have ${a} to ${b}.`,
  noTable: "The plan asks for a table with columns or rows, but no table file changed.",
  noTitle: (f: string) => `“${f}” has no title.`,
  noViewport: (f: string) => `“${f}” has no setting for phone screens (a viewport line).`,
  noAlt: (f: string, n: number) => `“${f}” has ${n} ${sameWords(n, "picture", "pictures")} with no description (alt text).`,
  fromInternet: (f: string, host: string) => `“${f}” loads something from the internet (“${host}”). A page must work without the internet.`,
  blank: (f: string) => `“${f}” shows nothing: the page is blank.`,
  wide: (f: string, w: number) => `At phone width (390 pixels), “${f}” is wider than the screen (${w} pixels), so it scrolls sideways.`,
  notLoaded: (f: string, n: number, first: string) => `“${f}” could not load ${n} of the files it uses (${first}), so it will look different from what was meant.`,
  pageError: (f: string, e: string) => `“${f}” shows an error when it loads: ${e}.`,
  formula: (row: number, col: string, f: string) => `Row ${row}, column “${col}” of “${f}” starts with a character that a spreadsheet may run as a formula. Start it with a letter.`,
  tooSlow: "Checking the files took too long (over 60 seconds). Make the files smaller or fewer.",
  alreadyHad: (f: string, message: string) => `“${f}” already had this before the feature: ${message.replace(/\.$/u, "")}.`,
  longLine: (f: string, line: number) => `A very long line of “${f}” was not scanned (line ${line}).`,
};

// S04 --------------------------------------------------------------------------------------------------

function secretFindings(file: string, text: string): Found[] {
  const out: Found[] = [];
  const lines = new Set<number>();
  for (const hit of findSecrets(text)) {
    if (lines.has(hit.line * 100 + hit.pattern)) continue;
    lines.add(hit.line * 100 + hit.pattern);
    out.push({ rule: 4, key: `${hit.pattern}|${hit.match}`, message: MSG.secret(file, hit.line) });
  }
  return out;
}

// S05 --------------------------------------------------------------------------------------------------

const LOREM = /lorem[ \t\r\n]{1,4}ipsum/i;
const LINE_MARKER = /^[ \t]{0,8}(?:(?:[-*+][ \t]+|\d{1,3}[.)][ \t]+|>[ \t]*|\/\/[ \t]*|<!--[ \t]*|#[ \t]+)){0,4}(TODO|FIXME|TBD)(?![A-Za-z0-9_])/;
const BRACKET_BLANK = /\[(?:insert|your)(?:[ \t][^\]\n]{0,60})?\](?![([:])|\[(?:name|date)\](?![([:])/i;

/**
 * S05 on a text. A page passes its visible text as `pageVisible`: a blank in square brackets is looked for there, because in the
 * script of a page `names[name]` is code and not a blank to fill in.
 */
function placeholderFindings(file: string, text: string, model: MdModel | undefined, pageVisible?: string): Found[] {
  const found: Found[] = [];
  const lorem = LOREM.exec(text);
  if (lorem) found.push({ rule: 5, key: lorem[0].toLowerCase().replace(/\s+/gu, " "), message: MSG.placeholder(file, "Lorem ipsum") });
  const lines = model ? model.lines : text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (model && model.kinds[i] !== K_PROSE) continue;
    const line = lines[i]!;
    if (line.length === 0) continue;
    const marker = LINE_MARKER.exec(line.length > 200 ? line.slice(0, 200) : line);
    if (marker) {
      found.push({ rule: 5, key: `line|${line.trim().slice(0, 60)}`, message: MSG.placeholder(file, cut(shown(line.trim(), 40), 40)) });
      continue;
    }
    if (line.length > LINE_CAP || pageVisible !== undefined) continue;
    const blank = BRACKET_BLANK.exec(model ? scanInline(line).noCode : line);
    if (blank) found.push({ rule: 5, key: `blank|${blank[0].toLowerCase()}`, message: MSG.placeholder(file, cut(shown(blank[0], 40), 40)) });
  }
  if (pageVisible !== undefined) {
    const blank = BRACKET_BLANK.exec(pageVisible);
    if (blank) found.push({ rule: 5, key: `blank|${blank[0].toLowerCase()}`, message: MSG.placeholder(file, cut(shown(blank[0], 40), 40)) });
  }
  return found;
}

// S19 to S22 -------------------------------------------------------------------------------------------

/** The host of an address that starts with `http:`, `https:` or `//`, or undefined for anything that stays in the project. */
function externalHost(value: string): string | undefined {
  const v = (value.length > 400 ? value.slice(0, 400) : value).replace(/[\t\n\r]/gu, "").trim();
  let rest: string | undefined;
  if (/^[\\/]{2}/.test(v)) rest = v.slice(2);
  else {
    const m = /^https?:[\\/]*/i.exec(v);
    if (m) rest = v.slice(m[0].length);
  }
  if (rest === undefined) return undefined;
  const host = rest.split(/[\\/?#]/u, 1)[0] ?? "";
  const bare = host.slice(host.lastIndexOf("@") + 1).replace(/:\d*$/u, "");
  return bare === "" ? "(no name)" : plainName(bare, 60);
}

/** Every address that a style sheet loads: `url(...)` and `@import`. Reads only the start of each, so it is linear. */
function cssLoads(css: string): string[] {
  const out: string[] = [];
  const urlRe = /url\(/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(css)) !== null) {
    let j = m.index + m[0].length;
    while (j < css.length && (isSpace(css.charCodeAt(j)) || css.charCodeAt(j) === 34 || css.charCodeAt(j) === 39)) j++;
    out.push(css.slice(j, j + 120));
  }
  const importRe = /@import/gi;
  while ((m = importRe.exec(css)) !== null) {
    let j = m.index + m[0].length;
    while (j < css.length && (isSpace(css.charCodeAt(j)) || css.charCodeAt(j) === 34 || css.charCodeAt(j) === 39)) j++;
    if (css.slice(j, j + 4).toLowerCase() !== "url(") out.push(css.slice(j, j + 120));
  }
  return out;
}

const LOAD_ATTRS = new Set(["img:src", "script:src", "iframe:src", "video:src", "audio:src", "source:src", "embed:src", "object:data", "form:action", "img:srcset", "source:srcset", "video:poster"]);
const LOAD_RELS = new Set(["stylesheet", "icon", "preload", "modulepreload", "apple-touch-icon"]);

function loadsFrom(summary: HtmlSummary, drawing: boolean): string[] {
  const hosts: string[] = [];
  const consider = (value: string): void => {
    const host = externalHost(value);
    if (host !== undefined) hosts.push(host);
  };
  for (const ref of summary.refs) {
    const id = `${ref.tag}:${ref.attr}`;
    if (drawing) {
      if (["image", "use", "feimage", "script"].includes(ref.tag)) consider(ref.value);
      continue;
    }
    if (ref.attr === "srcset") {
      for (const candidate of ref.value.slice(0, LINE_CAP).split(",")) consider(candidate.trim().split(/\s+/u, 1)[0] ?? "");
    } else if (LOAD_ATTRS.has(id)) consider(ref.value);
    else if (ref.tag === "link" && ref.attr === "href" && ref.rel !== undefined && ref.rel.toLowerCase().split(/\s+/u).some((r) => LOAD_RELS.has(r))) consider(ref.value);
  }
  for (const css of summary.css) for (const target of cssLoads(css)) consider(target);
  for (const content of summary.refresh) {
    const at = content.toLowerCase().indexOf("url=");
    if (at >= 0) consider(content.slice(at + 4).replace(/^["']/u, ""));
  }
  return hosts;
}

function pageFindings(file: string, text: string, kind: FileKind): { found: Found[]; summary: HtmlSummary; visible: string } {
  const { summary, text: visible } = scanHtml(text);
  const found: Found[] = [];
  if (kind === "page") {
    if (summary.title === undefined || summary.title === "") found.push({ rule: 19, key: "title", message: MSG.noTitle(file) });
    if (!summary.hasViewport) found.push({ rule: 20, key: "viewport", message: MSG.noViewport(file) });
    if (summary.imgNoAlt > 0) found.push({ rule: 21, key: `alt|${summary.imgNoAlt}`, message: MSG.noAlt(file, summary.imgNoAlt) });
  }
  for (const host of new Set(loadsFrom(summary, kind === "drawing"))) found.push({ rule: 22, key: `host|${host}`, message: MSG.fromInternet(file, host) });
  return { found, summary, visible };
}

/** Sorts findings into new problems and facts: a finding that the text had before the feature is a fact (spec M25). */
function splitByBefore(file: string, now: Found[], before: Found[] | undefined): { problems: Found[]; facts: string[] } {
  if (before === undefined) return { problems: now, facts: [] };
  const old = new Set(before.map((f) => `${f.rule}|${f.key}`));
  const problems: Found[] = [];
  const facts: string[] = [];
  for (const f of now) {
    if (old.has(`${f.rule}|${f.key}`)) facts.push(MSG.alreadyHad(file, f.message));
    else problems.push(f);
  }
  return { problems, facts };
}

/** Rules S19 to S22 on the text of one page (title, viewport line, picture descriptions, nothing loaded from the internet). New problems only. */
export function checkPageStatic(file: DeliverableFile): RuleOutcome {
  const name = shown(file.path);
  const text = file.text ?? "";
  const now = pageFindings(name, text, file.kind === "drawing" ? "drawing" : "page").found;
  const before = file.before !== undefined && !file.isNew ? pageFindings(name, file.before, file.kind === "drawing" ? "drawing" : "page").found : undefined;
  const split = splitByBefore(name, now, before);
  const problems = new Problems();
  for (const f of split.problems) problems.add(f.rule, f.message);
  const facts = new Facts();
  for (const f of split.facts) facts.add(f);
  return { problems: problems.done(), facts: facts.list };
}

/**
 * Rules S23 to S26 on a page that was drawn, and S08 and S09 again on the text the browser shows. With `factsOnly` (a page
 * found by the fallback of spec 7.1, not changed by the feature) every finding is a fact and none fails the attempt.
 */
export function checkPageRendered(page: RenderedPage, options: { expect?: FeatureExpect; factsOnly?: boolean } = {}): RuleOutcome {
  const shots = [page.phone, page.desktop].filter((s): s is NonNullable<typeof s> => s !== undefined);
  if (shots.length === 0) return { problems: [], facts: [] };
  const name = shown(page.path);
  const problems = new Problems();
  if (shots.some((s) => s.facts.text.trim() === "")) problems.add(23, MSG.blank(name));
  const phone = page.phone;
  if (phone && phone.facts.documentWidth > phone.facts.windowWidth) problems.add(24, MSG.wide(name, Math.round(phone.facts.documentWidth)));
  const failed = [...new Set(shots.flatMap((s) => s.facts.failedRequests))];
  if (failed.length > 0) problems.add(25, MSG.notLoaded(name, failed.length, failed.slice(0, 2).map((f) => shown(f)).join(", ")));
  const errors = shots.flatMap((s) => s.facts.errors);
  if (errors.length > 0) problems.add(26, MSG.pageError(name, cut(plainName(errors[0]!, 100), 100)));
  const expect = options.expect;
  if (expect) {
    const text = normalizeTerm(shots.map((s) => s.facts.text).join("\n"));
    const headings = new Set<string>();
    let haveHeadings = false;
    for (const s of shots) {
      if (s.facts.headings !== undefined) {
        haveHeadings = true;
        for (const h of s.facts.headings) headings.add(normalizeHeading(h));
      }
    }
    for (const h of expect.headings ?? []) {
      const wanted = normalizeHeading(h);
      const ok = haveHeadings ? headings.has(wanted) : normalizeHeading(text).includes(wanted);
      if (!ok) problems.add(8, MSG.noHeading(shown(h)));
    }
    for (const term of expect.mentions ?? []) if (!text.includes(normalizeTerm(term))) problems.add(9, MSG.noMention(shown(term)));
  }
  const list = problems.done();
  return options.factsOnly === true ? { problems: [], facts: list } : { problems: list, facts: [] };
}

// ───────────────────────────── Per-file analysis ─────────────────────────────

interface Ctx {
  /** The real path of the worktree, or undefined when the link rules cannot run. */
  root: string | undefined;
  files: Map<string, DeliverableFile>;
  alive: Map<string, boolean>;
  slugs: Map<string, Set<string> | undefined>;
  external: { count: number };
  facts: Facts;
}

async function targetAlive(ctx: Ctx, rel: string): Promise<boolean> {
  if (rel === ".") return ctx.root !== undefined;
  const known = ctx.alive.get(rel);
  if (known !== undefined) return known;
  let ok = false;
  if (ctx.root !== undefined && safeRel(rel)) {
    try {
      const abs = join(ctx.root, ...rel.split("/"));
      const st = await lstat(abs);
      if (!st.isSymbolicLink()) {
        const real = await realpath(abs);
        ok = real === ctx.root || real.startsWith(ctx.root + sep);
      }
    } catch {
      ok = false;
    }
  }
  ctx.alive.set(rel, ok);
  return ok;
}

/** The anchors a markdown file offers: GitHub's heading slugs and the `id` or `name` of an HTML element. undefined when the file may not be read. */
async function anchorsOf(ctx: Ctx, rel: string): Promise<Set<string> | undefined> {
  if (ctx.slugs.has(rel)) return ctx.slugs.get(rel);
  let text = ctx.files.get(rel)?.text;
  if (text === undefined) {
    const read = await readPlain(ctx.root, rel, TEXT_LIMIT, true);
    text = read.ok ? read.text : undefined;
  }
  let result: Set<string> | undefined;
  if (text !== undefined) {
    const model = parseMarkdown(text);
    result = new Set(githubSlugs(headingsOf(model).map((h) => h.text)));
    for (let i = 0; i < model.lines.length; i++) {
      const line = model.lines[i]!;
      if (model.kinds[i] === K_PROSE && line.length <= LINE_CAP && line.includes("=")) {
        for (const m of line.matchAll(/\b(?:id|name)=["']([^"']{1,100})["']/gu)) result.add(m[1]!);
      }
    }
  }
  ctx.slugs.set(rel, result);
  return result;
}

interface RefToCheck {
  value: string;
  /** Markdown only: the anchor is looked for in the target markdown file. */
  anchors: boolean;
}

async function linkFindings(ctx: Ctx, file: DeliverableFile, name: string, refs: RefToCheck[], ownAnchors: () => Set<string>, isOld: boolean): Promise<Found[]> {
  const found: Found[] = [];
  let checked = 0;
  for (const ref of refs) {
    const target = classifyTarget(ref.value);
    if (target.kind === "skip") continue;
    if (target.kind === "external") {
      if (!isOld) ctx.external.count++;
      continue;
    }
    if (target.path === "" && target.anchor === "") continue;
    if (target.path === "") {
      // A link to a heading of the same file.
      if (!ref.anchors || target.anchor === "" || target.anchor === "top") continue;
      const anchor = safeDecode(target.anchor);
      const own = ownAnchors();
      if (!own.has(anchor.toLowerCase()) && !own.has(anchor)) found.push({ rule: 7, key: `#${anchor}`, message: MSG.deadAnchor(anchor.length > 0 ? shown(anchor) : "", name) });
      continue;
    }
    if (ctx.root === undefined) continue;
    if (target.rootRelative && !hasExtension(target.path)) continue;
    const rel = resolveTarget(file.path, target);
    let alive = false;
    if (rel !== undefined) {
      alive = await targetAlive(ctx, rel);
      if (!alive && target.rootRelative && hasExtension(rel)) {
        for (const prefix of ["public", "static"]) if (!alive) alive = await targetAlive(ctx, `${prefix}/${rel}`);
      }
    }
    if (!alive) {
      found.push({ rule: 6, key: ref.value, message: MSG.deadLink(shown(ref.value), name) });
    } else if (ref.anchors && target.anchor !== "" && target.anchor !== "top" && rel !== undefined && /\.(?:md|markdown)$/i.test(rel)) {
      const anchors = await anchorsOf(ctx, rel);
      const anchor = safeDecode(target.anchor);
      if (anchors !== undefined && !anchors.has(anchor.toLowerCase()) && !anchors.has(anchor)) {
        found.push({ rule: 7, key: `${rel}#${anchor}`, message: MSG.deadAnchorElsewhere(shown(anchor), shown(rel), name) });
      }
    }
    if (++checked % 200 === 0) await tick();
  }
  return found;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

interface FileView {
  /** Headings as compared (S08), visible only. */
  headings: string[];
  /** Whether a plan word is in the visible text of the file (S09), letter for letter, in either form of the text. */
  hasMention(wanted: string): boolean;
  /** The words of the added visible text (S10). */
  words: number;
}

/**
 * The visible text of a markdown model: link syntax, code marks, comments and raw tags taken out, hidden raw HTML left out
 * (spec M28). Code blocks are kept when `includeCode`.
 */
function markdownVisible(model: MdModel, includeCode: boolean): string {
  const scanner = new HtmlScanner(TAG_CAP_MARKDOWN);
  for (let i = 0; i < model.lines.length; i++) {
    const kind = model.kinds[i];
    const line = model.lines[i]!;
    if (kind === K_CODE) {
      if (includeCode) scanner.feed(line.replaceAll("<", CODE_LT) + "\n");
      continue;
    }
    if (kind !== K_PROSE || line === "") {
      scanner.feed("\n");
      continue;
    }
    let work = line;
    if (work.length <= LINE_CAP) {
      work = work.replace(/^ {0,3}(?:#{1,6}[ \t]+|>+[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/, "");
      work = work.replace(/^ {0,3}(?:>+[ \t]?|[-*+][ \t]+)/, "");
      if (/^\[[^\]\n]{1,200}\]:[ \t]/.test(work)) continue;
      work = scanInline(work).plain;
    }
    scanner.feed(work + "\n");
  }
  scanner.finish();
  return scanner.text().replaceAll(CODE_LT, "<");
}

const WORD = /[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu;

function countWords(text: string): number {
  WORD.lastIndex = 0;
  let n = 0;
  while (WORD.test(text)) n++;
  return n;
}

function viewOf(file: DeliverableFile, model: MdModel | undefined, needHeadings: boolean, needMentions: boolean, needWords: boolean): FileView {
  const text = file.text ?? "";
  let headings: string[] = [];
  let words = 0;
  let hasMention = (_wanted: string): boolean => false;
  const wholeFile = file.isNew || file.added === undefined;
  const addedText = (): string => (file.added ?? text.split(/\r\n|\r|\n/)).join("\n");
  if (file.kind === "markdown") {
    const md = model ?? parseMarkdown(text);
    if (needHeadings) headings = headingsOf(md).map((h) => normalizeHeading(h.text));
    if (needMentions) {
      const raw = nfc(markdownVisible(md, true));
      let stripped: string | undefined;
      hasMention = (wanted) => raw.includes(wanted) || (stripped ??= nfc(collapse(stripEmphasis(raw)))).includes(wanted);
    }
    if (needWords) words = countWords(markdownVisible(wholeFile ? md : parseMarkdown(addedText()), false));
  } else if (file.kind === "page") {
    const page = scanHtml(text);
    if (needHeadings) headings = page.summary.headings.map((h) => normalizeHeading(h.text));
    if (needMentions) {
      const visible = nfc(page.text);
      hasMention = (wanted) => visible.includes(wanted);
    }
    if (needWords) words = countWords(wholeFile ? page.text : scanHtml(addedText()).text);
  } else if (file.kind === "text") {
    if (needMentions) {
      const visible = normalizeTerm(text);
      hasMention = (wanted) => visible.includes(wanted);
    }
    if (needWords) words = countWords(addedText());
  }
  return { headings, hasMention, words };
}

async function fileFindings(ctx: Ctx, file: DeliverableFile, name: string, text: string, isOld: boolean, parsed?: MdModel): Promise<Found[]> {
  const found: Found[] = [];
  const kind = file.kind;
  pushAll(found, secretFindings(name, text));
  await tick();
  if (kind === "markdown" || kind === "text" || kind === "page") {
    if (kind === "markdown") {
      const model = parsed ?? parseMarkdown(text);
      if (!isOld) for (const line of model.longLines.slice(0, 3)) ctx.facts.add(MSG.longLine(name, line));
      pushAll(found, placeholderFindings(name, text, model));
      await tick();
      const refs: RefToCheck[] = [];
      let own: Set<string> | undefined;
      const html = new HtmlScanner(TAG_CAP_MARKDOWN);
      for (let i = 0; i < model.lines.length; i++) {
        if (model.kinds[i] !== K_PROSE) continue;
        const line = model.lines[i]!;
        if (line.length > LINE_CAP || line === "") continue;
        if (line.includes("[") || line.includes("`")) {
          const scan = scanInline(line);
          for (const link of scan.links) refs.push({ value: link.target, anchors: true });
          const def = /^ {0,3}\[(?!\^)[^\]\n]{1,200}\]:[ \t]*(<[^>\n]{1,300}>|\S{1,300})/u.exec(line);
          if (def) refs.push({ value: def[1]!.replace(/^<|>$/gu, ""), anchors: true });
        }
        if (line.includes("<")) html.feed(line + "\n");
        if (i % 500 === 499) await tick();
      }
      html.finish();
      for (const r of html.summary.refs) if (["a", "img", "link", "script", "source", "video", "audio", "iframe", "embed", "area"].includes(r.tag)) refs.push({ value: r.value, anchors: true });
      const ownAnchors = (): Set<string> => {
        if (own) return own;
        own = new Set(githubSlugs(headingsOf(model).map((h) => h.text)));
        for (const id of html.summary.ids) own.add(id);
        return own;
      };
      pushAll(found, await linkFindings(ctx, file, name, refs, ownAnchors, isOld));
    } else if (kind === "text") {
      pushAll(found, placeholderFindings(name, text, undefined));
    } else {
      const page = pageFindings(name, text, "page");
      pushAll(found, placeholderFindings(name, text, undefined, page.visible));
      await tick();
      pushAll(found, page.found);
      await tick();
      const refs: RefToCheck[] = page.summary.refs
        .filter((r) => (r.tag === "link" ? r.attr === "href" : true) && r.attr !== "srcset")
        .map((r) => ({ value: r.value, anchors: false }));
      pushAll(found, await linkFindings(ctx, file, name, refs, () => new Set(), isOld));
    }
  } else if (kind === "drawing") {
    pushAll(found, pageFindings(name, text, "drawing").found);
  } else if (kind === "style") {
    const hosts = new Set<string>();
    for (const target of cssLoads(text)) {
      const host = externalHost(target);
      if (host !== undefined) hosts.add(host);
    }
    for (const host of hosts) found.push({ rule: 22, key: `host|${host}`, message: MSG.fromInternet(name, host) });
  } else if (kind === "table") {
    const csv = parseCsv(text);
    const header = csv.rows[0] ?? [];
    for (let r = 0; r < csv.rows.length; r++) {
      const row = csv.rows[r]!;
      for (let c = 0; c < row.length; c++) {
        const cell = row[c]!;
        if (cell !== "" && looksLikeFormula(cell)) {
          const col = (header[c] ?? "").trim();
          found.push({ rule: 27, key: cell.slice(0, 200), message: MSG.formula(r + 1, col === "" ? "(no name)" : shown(col, 40), name) });
        }
      }
      if (r % 2000 === 1999) await tick();
    }
  }
  return found;
}

// ───────────────────────────── checkDeliverables ─────────────────────────────

/** Whether a table's header and rows agree with the plan, for the "some table matches" test of S16 and S17. */
function sameColumns(header: string[], wanted: string[]): boolean {
  if (header.length !== wanted.length) return false;
  return header.every((h, i) => h.trim() === wanted[i]!.trim());
}

/**
 * Rules S01 to S18, S27 and S29 over the files, calling `checkPageStatic` for every page. Problems that a file already
 * had at the start of the feature are facts, not failures (spec M25). Async because it gives the event loop a turn
 * between files (spec 6.5).
 */
export async function checkDeliverables(input: CheckInput): Promise<DeliverableCheck> {
  const { deliverables: d, expect } = input;
  const now = input.now ?? Date.now;
  const started = now();
  const problems = new Problems();
  const facts = new Facts();
  for (const f of d.facts) facts.add(f);
  // S01
  const counted = d.files.length + d.skipped.filter((s) => s.why !== "left_out").length;
  if (counted === 0) problems.add(1, MSG.noFiles);
  // S03
  for (const s of d.skipped) {
    if (s.why === "too_big") problems.add(3, MSG.tooBig(shown(s.path), isTextKind(fileKind(s.path)) ? 1 : 5));
  }
  let root: string | undefined;
  if (d.worktree !== undefined) {
    try {
      root = await realpath(d.worktree);
    } catch {
      root = undefined;
    }
  }
  const ctx: Ctx = { root, files: new Map(d.files.map((f) => [f.path, f])), alive: new Map(), slugs: new Map(), external: { count: 0 }, facts };
  const wantHeadings = (expect?.headings?.length ?? 0) > 0;
  const wantMentions = (expect?.mentions?.length ?? 0) > 0;
  const wantWords = expect?.words !== undefined;
  const headings = new Set<string>();
  const mentionsFound = new Set<string>();
  const wantedMentions = (expect?.mentions ?? []).map((m) => normalizeTerm(m));
  let words = 0;
  let timedOut = false;
  const tables: { name: string; rows: string[][] }[] = [];
  for (const file of d.files) {
    if (now() - started > TIME_LIMIT_MS) {
      problems.add(29, MSG.tooSlow);
      timedOut = true;
      break;
    }
    const name = shown(file.path);
    if (!isTextKind(file.kind)) {
      if (file.size === 0) problems.add(2, MSG.empty(name));
      continue;
    }
    const text = file.text ?? "";
    if (text.trim() === "") {
      problems.add(2, MSG.empty(name));
      continue;
    }
    // The rules that look for defects: new problems only (M25).
    const model = file.kind === "markdown" ? parseMarkdown(text) : undefined;
    const nowFound = await fileFindings(ctx, file, name, text, false, model);
    const beforeFound = file.before !== undefined && !file.isNew ? await fileFindings(ctx, file, name, file.before, true) : undefined;
    const split = splitByBefore(name, nowFound, beforeFound);
    for (const f of split.problems) problems.add(f.rule, f.message);
    for (const f of split.facts) facts.add(f);
    await tick();
    // The table rules.
    if (file.kind === "table") {
      const csv = parseCsv(text);
      if (csv.unclosedQuote) problems.add(11, MSG.csvQuote(name));
      const header = csv.rows[0];
      if (header === undefined || header.every((h) => h.trim() === "")) {
        problems.add(12, MSG.csvNoHeader(name));
      } else {
        if (header.some((h) => h.trim() === "")) problems.add(13, MSG.csvEmptyName(name));
        const seen = new Set<string>();
        for (const h of header) {
          const t = h.trim();
          if (t === "") continue;
          if (seen.has(t)) problems.add(14, MSG.csvDuplicate(name, shown(t, 40)));
          seen.add(t);
        }
        let ragged = 0;
        for (let r = 1; r < csv.rows.length; r++) {
          const row = csv.rows[r]!;
          if (row.length !== header.length) {
            ragged++;
            if (ragged <= 3) problems.add(15, MSG.csvRagged(r + 1, name, row.length, header.length));
          }
        }
        if (ragged > 3) problems.add(15, MSG.csvRaggedMore(ragged - 3, name));
      }
      tables.push({ name, rows: csv.rows });
    }
    // The plan's words, headings and word range.
    if (wantHeadings || wantMentions || wantWords) {
      const view = viewOf(file, model, wantHeadings, wantMentions, wantWords);
      for (const h of view.headings) headings.add(h);
      for (const w of wantedMentions) if (!mentionsFound.has(w) && view.hasMention(w)) mentionsFound.add(w);
      words += view.words;
    }
    await tick();
  }
  if (!timedOut && expect) {
    for (const h of expect.headings ?? []) if (!headings.has(normalizeHeading(h))) problems.add(8, MSG.noHeading(shown(h)));
    for (const term of expect.mentions ?? []) if (!mentionsFound.has(normalizeTerm(term))) problems.add(9, MSG.noMention(shown(term)));
    if (expect.words !== undefined) {
      const [a, b] = expect.words;
      if (words < a || words > b) problems.add(10, MSG.words(words, a, b));
    }
    const hasTableFile = tables.length > 0 || d.skipped.some((s) => s.why !== "left_out" && s.why !== "removed" && /\.csv$/i.test(s.path));
    if ((expect.columns !== undefined || expect.rows !== undefined) && !hasTableFile) problems.add(18, MSG.noTable);
    if (expect.columns !== undefined && tables.length > 0 && !tables.some((t) => t.rows[0] !== undefined && sameColumns(t.rows[0], expect.columns!))) {
      for (const t of tables) {
        const header = (t.rows[0] ?? []).map((h) => h.trim());
        problems.add(16, MSG.csvColumns(t.name, header.map((h) => shown(h, 40)).join(", "), expect.columns.map((h) => shown(h, 40)).join(", ")));
      }
    }
    if (expect.rows !== undefined && tables.length > 0) {
      const [a, b] = expect.rows;
      const counts = tables.map((t) => Math.max(0, t.rows.length - 1));
      if (!counts.some((c) => c >= a && c <= b)) {
        tables.forEach((t, i) => problems.add(17, MSG.csvRows(t.name, counts[i]!, a, b)));
      }
    }
  }
  if (ctx.external.count > 0) {
    const n = ctx.external.count;
    facts.add(`${n} ${sameWords(n, "link to a web address was", "links to web addresses were")} not followed, because Mission Control does not use the internet.`);
  }
  const list = problems.done();
  return { problems: list, facts: facts.list, pass: list.length === 0 };
}

/**
 * The problem of rule S28, for the dispatcher to add when the project's own full checks fail after a change that touched
 * more than documents, pages and data (spec 6.4): `The project's own checks fail after this change. The first lines they
 * print: <up to 300 characters>.` The output is AI-influenced text, so its hidden characters are shown as code points.
 */
export function projectChecksProblem(output: string): string {
  const lines: string[] = [];
  for (const line of output.split(/\r\n|\r|\n/, 200)) {
    const t = line.trim();
    if (t !== "") lines.push(plainName(t, 300));
    if (lines.join(" ").length >= 300) break;
  }
  const first = cut(lines.join(" "), 300).replace(/[“”]/gu, '"').replace(/\.$/u, "");
  return `The project's own checks fail after this change. The first lines they print: ${first === "" ? "(nothing was printed)" : first}.`;
}

// ───────────────────────────── Judging the second AI's answer (spec 8.3) ─────────────────────────────

export interface RubricInput {
  /** The answer as the AI gave it (already valid against `SCHEMAS.rubric`). */
  answer: RubricOutput;
  /** The written checks in order: `f.acceptance`. The number of checks is `checks.length`. */
  checks: string[];
  /** Repo-relative paths of the readable files the feature changed, as the brief names them. */
  changedFiles: string[];
  /** The text of the changed text files (search text, part a). */
  changedText: string[];
  /** The visible text of the pages that were drawn (search text, part c). */
  pageText: string[];
  /** Reads a file that `seen` names, under the rules of spec 6.1; undefined when it may not be read. Called for at most 20 files (search text, part b). */
  readSeen?: (name: string) => string | undefined;
  /** The family that really answered (`AgentAnswer.family`, after any failover). */
  family: Family;
  /** `RunResult.opened` of the answering run. Absent when the runner cannot tell (Codex): `seen` is then taken as stated. */
  opened?: string[];
  /** The working folder of the run, taken off a path before two paths are compared. */
  worktree: string;
  /** Absolute paths of the pictures offered to this run. Empty = none were offered. */
  pictures: string[];
}

/** What the engine makes of the answer. */
export type RubricJudgement =
  | {
      ok: true;
      /** One entry per check, in order, after points 3 to 5 of spec 8.3 (evidence cleaned and cut at 300 characters). */
      results: CheckedResult[];
      /** How many are `cannot_judge`. */
      unjudged: number;
      /** How many passes were turned into `cannot_judge` (the `downgraded` of the event). */
      downgraded: number;
      /** Computed, never read from the answer: `approve` only when every result is `pass`. */
      verdict: "approve" | "changes";
      /** For the fix round: a major finding for each `fail` and each `major` note. */
      findings: Finding[];
      /** Kept as small open findings: the `minor` notes. */
      minorFindings: Finding[];
      /** `seen` cut down to what the run really opened (Claude), else as stated. */
      seen: string[];
      /** Sentences for the owner's look: `The second AI named a file it did not open.`, `What the second AI opened could not be checked.` */
      lookNotes: string[];
    }
  /** Unusable: asked once more with `problem` added to the brief; a second one means "the review did not finish". */
  | { ok: false; problem: string };

const EVIDENCE_MAX = 300;
/** The longest file name of a note of the second AI that is kept (after the cleaning that makes it plain). */
const FILE_NAME_MAX = 200;
const MIN_EVIDENCE = 12;
const MIN_QUOTE = 8;
const MAX_SEEN_READS = 20;

/** Evidence is AI-written, and may quote a hostile file: cleaned by `cleanAiText` (nothing hidden, no picture or link, no web address), one line, at most 300 characters. */
function cleanEvidence(s: string): string {
  return cleanAiText(s, EVIDENCE_MAX);
}

/**
 * The file a note of the second AI names. It is the AI's word, not a path Mission Control checked, so it is made safe like a file name
 * (hidden characters shown as code points, cut at 80 characters) and then plain like the rest of the AI's words: a picture, a link or a web
 * address in it becomes words. It is cut at 200 characters, because a web address is longer than the words that stand for it.
 */
function cleanFileName(name: string): string {
  return cleanAiText(plainName(name), FILE_NAME_MAX);
}

/** `text` as a sentence: it gets a full stop unless it already ends with one (a check the leader wrote usually does), or with `!`, `?` or `…`. */
function withFullStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The text a quote is looked for in, and the quote itself, made alike: marks of markdown and tags out, white space collapsed, NFC, one kind of quote mark. */
function normalizeForSearch(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (line.length > LINE_CAP) {
      out.push(line);
      continue;
    }
    out.push(stripEmphasis(scanInline(line).plain.replaceAll(CODE_LT, "<")));
  }
  return collapse(stripTags(nfc(out.join(" "))))
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"');
}

/**
 * The text a quote is looked for in, and the quote itself, made alike but not read as a page: white space collapsed, NFC, one kind of
 * quote mark, and nothing else changed. Tags, attribute values, markdown marks and link addresses stay, so a quote of markup can be
 * found where it stands in the file (`<a class="button" href="../README.md">`), which the visible text cannot show.
 */
function normalizeRaw(text: string): string {
  return collapse(nfc(text))
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"');
}

/** True for a quote of markup that holds an attribute (`<div class=`, `<a href="x">`): only the file itself can show it, not the visible text. */
function hasTagAttribute(raw: string): boolean {
  return /<[A-Za-z][^<>]*\s[\w:-]+\s*=/u.test(raw);
}

/** Removes `<...>` tags (not their text) in one pass. */
function stripTags(s: string): string {
  if (!s.includes("<")) return s;
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      parts.push(s.slice(i));
      break;
    }
    parts.push(s.slice(i, lt));
    const c = s.charCodeAt(lt + 1);
    if (isAlpha(c) || c === 47 || c === 33 || c === 63) {
      const gt = s.indexOf(">", lt + 1);
      if (gt >= 0 && gt - lt <= 4000) {
        parts.push(" ");
        i = gt + 1;
        continue;
      }
    }
    parts.push("<");
    i = lt + 1;
  }
  return parts.join("");
}

/** A double quotation mark of the evidence: where it stands (a backslash before it counts), and which kind it is. */
interface QuoteMark {
  start: number;
  end: number;
  kind: "straight" | "open" | "close";
}

/**
 * The double quotation marks of an evidence text, straight or curly. A straight mark after a backslash (`\"`) belongs to the quoted
 * words, as it does when an answer is written like JSON, unless the whole text is written that way: then those are its marks.
 */
function quoteMarks(evidence: string): QuoteMark[] {
  const plain: QuoteMark[] = [];
  const escaped: QuoteMark[] = [];
  for (let k = 0; k < evidence.length; k++) {
    const c = evidence.charAt(k);
    if (c === '"') {
      if (k > 0 && evidence.charAt(k - 1) === "\\") escaped.push({ start: k - 1, end: k + 1, kind: "straight" });
      else plain.push({ start: k, end: k + 1, kind: "straight" });
    } else if (c === "“") plain.push({ start: k, end: k + 1, kind: "open" });
    else if (c === "”") plain.push({ start: k, end: k + 1, kind: "close" });
  }
  return plain.length > 0 ? plain : escaped;
}

/** How many closing marks after an opening one are tried as the end of a quote that holds marks of its own (a tag with up to eight attributes). */
const MAX_QUOTE_ENDS = 16;
/** How many stretches of one evidence text are looked for in the files at most. An honest answer needs a few dozen; text built to be slow gets "not found". */
const MAX_QUOTE_SPANS = 1500;

/**
 * Whether every quote of the evidence is real, as `verdict` judges each piece of one (a quote is cut at `...` and `…`, and each piece
 * is looked for on its own).
 *
 * A quote that holds quotation marks of its own is one quote. The marks of an attribute (`class="button"`, a mark right after `=`) come
 * in pairs inside the quote, so `"<a class="button" href="x">Go</a>"` runs from the first mark to the one that is left over, and all of
 * its text must be real: a made-up value cannot hide between two pieces. Other quotes with marks inside them (`"font-family: "Segoe UI",
 * serif"`) run to the closing mark that gives the longest text that is real. When no such text is real, the nearest closing mark ends
 * the quote, as it always did, and its text is the one that is held to the files. A text with more stretches than MAX_QUOTE_SPANS is
 * not real.
 */
function quotesAreReal(evidence: string, verdict: (piece: string) => "skip" | "found" | "missing"): boolean {
  const marks = quoteMarks(evidence);
  const textBetween = (open: QuoteMark, close: QuoteMark): string => evidence.slice(open.end, close.start).replaceAll('\\"', '"');
  let spans = 0;
  const real = (open: QuoteMark, close: QuoteMark): boolean => ++spans <= MAX_QUOTE_SPANS && textBetween(open, close).split(/\.\.\.|…/u).every((piece) => verdict(piece) !== "missing");
  const startsValue = (mark: QuoteMark): boolean => mark.kind === "straight" && mark.start > 0 && evidence.charAt(mark.start - 1) === "=";
  let i = 0;
  while (i < marks.length) {
    const open = marks[i]!;
    if (open.kind === "straight") {
      // The mark that is left over once every attribute value inside has been opened and closed ends the quote.
      let depth = 0;
      let outer = -1;
      for (let j = i + 1; j < marks.length && outer < 0; j++) {
        const mark = marks[j]!;
        if (mark.kind !== "straight") continue;
        if (startsValue(mark)) depth++;
        else if (depth > 0) depth--;
        else outer = j;
      }
      if (outer > i + 1) {
        if (!real(open, marks[outer]!)) return false;
        i = outer + 1;
        continue;
      }
    }
    // A curly opening mark is closed by a curly closing one, or by a straight one when there is none; a straight one by a straight one.
    const ends: number[] = [];
    for (let j = i + 1; j < marks.length; j++) if (open.kind === "open" ? marks[j]!.kind === "close" : marks[j]!.kind === "straight") ends.push(j);
    if (ends.length === 0 && open.kind === "open") for (let j = i + 1; j < marks.length; j++) if (marks[j]!.kind === "straight") ends.push(j);
    if (ends.length === 0) break;
    const tried = ends.slice(0, MAX_QUOTE_ENDS);
    let taken = -1;
    for (let t = tried.length - 1; t >= 0; t--) {
      if (real(open, marks[tried[t]!]!)) {
        taken = tried[t]!;
        break;
      }
    }
    if (taken < 0) return false;
    i = taken + 1;
  }
  return true;
}

function stripWorktree(path: string, worktree: string): string {
  const base = worktree.replace(/\/+$/u, "");
  return base !== "" && path.startsWith(base + "/") ? path.slice(base.length + 1) : path;
}

function endsWithPath(a: string, b: string): boolean {
  return a === b || a.endsWith("/" + b);
}

function samePath(a: string, b: string): boolean {
  return endsWithPath(a, b) || endsWithPath(b, a);
}

/** Checks the second AI's answer and turns it into results the engine can trust (spec 8.3, points 1 to 8). Pure. */
export function judgeRubric(input: RubricInput): RubricJudgement {
  const { answer, checks } = input;
  const total = checks.length;
  // 1. Complete: each number from 1 to N exactly once.
  const count = new Map<number, number>();
  for (const r of answer.results) count.set(r.number, (count.get(r.number) ?? 0) + 1);
  const missing: number[] = [];
  for (let n = 1; n <= total; n++) if (!count.has(n)) missing.push(n);
  const repeated = [...count.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  const extra = [...count.keys()].filter((n) => !Number.isInteger(n) || n < 1 || n > total);
  if (missing.length > 0 || repeated.length > 0 || extra.length > 0 || answer.results.length !== total) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`no result for check ${missing.slice(0, 10).join(", ")}`);
    if (repeated.length > 0) parts.push(`more than one result for check ${repeated.slice(0, 10).join(", ")}`);
    if (extra.length > 0) parts.push(`results for numbers that are not in the list: ${extra.slice(0, 10).join(", ")}`);
    if (parts.length === 0) parts.push("the number of results does not match the number of checks");
    return { ok: false, problem: `Your answer must have exactly one result for each of the ${total} checks, numbered 1 to ${total}. It had ${parts.join("; ")}.` };
  }
  // 2. Opened something, and only what was opened.
  const lookNotes: string[] = [];
  let seen: string[];
  const statedSeen = answer.seen.map((s) => stripWorktree(s, input.worktree));
  if (input.opened !== undefined) {
    const opened = input.opened.map((o) => stripWorktree(o, input.worktree));
    seen = statedSeen.filter((s) => opened.some((o) => samePath(s, o)));
    if (seen.length < statedSeen.length) lookNotes.push("The second AI named a file it did not open.");
  } else {
    seen = statedSeen;
    lookNotes.push("What the second AI opened could not be checked.");
  }
  if (input.changedFiles.length > 0 && !input.changedFiles.some((c) => seen.some((s) => samePath(s, c)))) {
    return {
      ok: false,
      problem: `Your answer must name, in "seen", at least one of the changed files that you really opened: ${input.changedFiles.slice(0, 5).map((c) => plainName(c)).join(", ")}.`,
    };
  }
  // The text a quote is looked for in: the changed files, the files `seen` names, and the drawn pages. It is made twice, and only when a
  // quote needs it: the visible text (tags, markdown marks and link addresses taken out), and the raw text (nothing taken out), because
  // an honest answer may quote what a reader sees, and also a rule of the style sheet or a tag as the file has it.
  let chunks: string[] | undefined;
  const searchChunks = (): string[] => {
    if (chunks !== undefined) return chunks;
    chunks = [...input.changedText, ...input.pageText];
    if (input.readSeen) {
      const done = new Set<string>();
      for (const name of seen) {
        if (done.size >= MAX_SEEN_READS) break;
        if (done.has(name) || input.pictures.some((p) => samePath(stripWorktree(p, input.worktree), name))) continue;
        done.add(name);
        const text = input.readSeen(name);
        if (text !== undefined) chunks.push(text);
      }
    }
    return chunks;
  };
  let searchText: string | undefined;
  const search = (): string => (searchText ??= normalizeForSearch(searchChunks().join("\n")));
  let searchRawText: string | undefined;
  const searchRaw = (): string => (searchRawText ??= normalizeRaw(searchChunks().join("\n")));
  const knownNames = [...input.changedFiles, ...seen].map((s) => normalizeForSearch(s));
  /** One piece of a quote: too short to hold to the files ("skip"), in them ("found"), or not ("missing"). Said once for each piece. */
  const verdicts = new Map<string, "skip" | "found" | "missing">();
  const quoteVerdict = (piece: string): "skip" | "found" | "missing" => {
    const known = verdicts.get(piece);
    if (known !== undefined) return known;
    const quote = normalizeForSearch(piece);
    const raw = normalizeRaw(piece);
    // A quote of markup with an attribute is held to the file as it stands: the visible text of a page has no attribute in it.
    const markup = raw.length >= MIN_QUOTE && hasTagAttribute(raw);
    let verdict: "skip" | "found" | "missing";
    if (quote.length < MIN_QUOTE && !markup) verdict = "skip";
    else if (quote.length >= MIN_QUOTE && knownNames.some((k) => k !== "" && (k === quote || k.endsWith("/" + quote) || quote.endsWith("/" + k)))) verdict = "found";
    else if (markup) verdict = searchRaw().includes(raw) ? "found" : "missing";
    else verdict = (quote.length >= MIN_QUOTE && search().includes(quote)) || (raw.length >= MIN_QUOTE && searchRaw().includes(raw)) ? "found" : "missing";
    verdicts.set(piece, verdict);
    return verdict;
  };
  const pictureNames = input.pictures.map((p) => stripWorktree(p, input.worktree));
  const openedPictures = (input.opened ?? []).map((o) => stripWorktree(o, input.worktree));
  const pictureWasOpened = input.family === "claude" && input.opened !== undefined && pictureNames.some((p) => openedPictures.some((o) => samePath(p, o)));

  let downgraded = 0;
  const byNumber = new Map<number, RubricOutput["results"][number]>();
  for (const r of answer.results) byNumber.set(r.number, r);
  const results: CheckedResult[] = [];
  for (let n = 1; n <= total; n++) {
    const r = byNumber.get(n)!;
    let result = r.result;
    let evidence = cleanEvidence(r.evidence);
    const basis = r.basis;
    if (result === "pass") {
      if (writtenLength(r.evidence) < MIN_EVIDENCE || !hasWords(r.evidence)) {
        // 3. A pass needs evidence. How much was written is measured before the cleaning (the words that stand for a web address are
        // not writing), and a text that says nothing once its addresses, links and tags are taken out is no evidence at all.
        result = "cannot_judge";
        evidence = "No evidence was given.";
        downgraded++;
      } else if (basis === "picture") {
        // 5. A judgement on a picture needs a picture that was opened.
        if (input.pictures.length === 0 || !pictureWasOpened) {
          result = "cannot_judge";
          evidence = "No picture was opened by the second AI.";
          downgraded++;
        }
      } else {
        // 4. Quotes are real.
        if (!quotesAreReal(r.evidence, quoteVerdict)) {
          result = "cannot_judge";
          evidence = cut(`The quote was not found in the files. ${evidence}`, EVIDENCE_MAX);
          downgraded++;
        }
      }
    }
    results.push({ n, result, evidence, basis });
  }
  const unjudged = results.filter((r) => r.result === "cannot_judge").length;
  const verdict = results.every((r) => r.result === "pass") ? "approve" : "changes";
  const findings: Finding[] = [];
  for (const r of results) {
    if (r.result === "fail") {
      findings.push({
        severity: "major",
        file: null,
        description: `Check ${r.n} is not met: ${withFullStop(checks[r.n - 1] ?? "")} The second AI found: ${r.evidence}`,
        suggestedTest: null,
      });
    }
  }
  const minorFindings: Finding[] = [];
  for (const note of answer.notes) {
    const finding: Finding = { severity: note.severity, file: note.file === null ? null : cleanFileName(note.file), description: cleanEvidence(note.description), suggestedTest: null };
    if (note.severity === "major") findings.push(finding);
    else minorFindings.push(finding);
  }
  return { ok: true, results, unjudged, downgraded, verdict, findings, minorFindings, seen, lookNotes };
}
