// Small synchronous file helpers: atomic JSON, JSON lines, hashing, paths.
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Writes JSON via a temp file in the same directory + fsync + rename, so readers never see a partial file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const json = JSON.stringify(data, null, 2);
  if (json === undefined) throw new TypeError(`writeJsonAtomic: value for ${path} is not JSON-serializable`);
  const dir = ensureDir(dirname(path));
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const fd = openSync(tmp, "w");
    try {
      // Unlike a single writeSync, this retries short writes and throws (e.g. ENOSPC, EFBIG) instead of
      // leaving a truncated temp file that would then be renamed over the good one.
      writeFileSync(fd, json + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  syncDirectory(dir);
}

/** Persists the rename itself (best effort: some filesystems refuse to fsync a directory). */
function syncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Durability nicety only; the data file itself is already synced.
  }
}

/** Reads and parses a JSON file. Throws if it is missing or not valid JSON. */
export function readJson<T>(path: string): T {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`invalid JSON in ${path}: ${(err as Error).message}`, { cause: err });
  }
}

/** Like readJson, but returns `fallback` when the file is missing or not valid JSON. */
export function readJsonOr<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    if (err instanceof SyntaxError || (err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

/** Appends one JSON record as a line, creating the file (and its directory) if needed. */
export function appendJsonl(path: string, obj: unknown): void {
  ensureDir(dirname(path));
  // A crash mid-append can leave a partial last line; start on a fresh line so this record stays intact.
  const separator = endsWithPartialLine(path) ? "\n" : "";
  appendFileSync(path, separator + JSON.stringify(obj) + "\n");
}

function endsWithPartialLine(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Reads a JSON-lines file. A missing file yields []; blank and corrupt lines are skipped. */
export function readJsonl<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // corrupt line (e.g. torn by a crash): skip it
    }
  }
  return records;
}

/** Expands a leading "~" or "~/" to the current user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** mkdir -p; returns the path. */
export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

/** Hex SHA-256 of a file's bytes. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Hex SHA-256 of a UTF-8 string. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
