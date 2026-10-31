// Observational source fingerprints, not an OS protection or proof that a process never wrote.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { WorkScope } from "./provenance.js";
import { controllerGitEnv } from "./util/launch-env.js";
import { runProcess } from "./util/process.js";
export interface WorkCapture {
  scope: WorkScope; root: string; universe: "git-source-v1"; head: string | null;
  files: Array<{ path: string; sha256: string; mode: "100644" | "100755" }>; complete: boolean;
}
export interface CaptureOptions { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number; timeoutMs?: number; signal?: AbortSignal; }
const MAX_OUTPUT = 2 * 1024 * 1024;
const DEFAULTS = { maxFiles: 20_000, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024, timeoutMs: 30_000 };
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const pathIsCanonical = (path: string) => path.length > 0 && path.length <= 4096 && !isAbsolute(path) && !path.includes("\ufffd") && !/^[a-z]:/iu.test(path) &&
  !/[\\\u0000-\u001f\u007f-\u009f]/u.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== ".." && part !== ".git");
const validScope = (scope: unknown): scope is WorkScope => {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return false;
  const value = scope as Record<string, unknown>;
  if (value.kind === "application" || value.kind === "plan") return Object.keys(value).length === 1;
  return value.kind === "feature" && Object.keys(value).length === 2 && typeof value.featureId === "string" &&
    value.featureId.length > 0 && value.featureId.length <= 200 && value.featureId.trim() === value.featureId && !/[\u0000-\u001f\u007f-\u009f]/u.test(value.featureId);
};
const sameStat = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** A failed, partial or moving capture returns no positive file-prefix facts. */
export async function captureWorktree(cwd: string, scope: WorkScope, options: CaptureOptions = {}): Promise<WorkCapture> {
  return capture(cwd, scope, options);
}
/** Exact raw blob/mode/tree match, independently of the staging index or status flags.
 * Filters, submodules, symlinks and uncertain observations fail closed rather than inventing commit credit.
 */
export async function captureCommittedTree(cwd: string, scope: WorkScope, commit: string, options: CaptureOptions = {}): Promise<WorkCapture> {
  return capture(cwd, scope, options, typeof commit === "string" ? commit : "");
}
async function capture(cwd: string, scope: WorkScope, options: CaptureOptions, committed?: string): Promise<WorkCapture> {
  const result: WorkCapture = { scope: structuredClone(scope), root: resolve(cwd), universe: "git-source-v1", head: null, files: [], complete: false };
  try {
    if (committed !== undefined && (typeof committed !== "string" || !COMMIT.test(committed))) return result;
    if (!validScope(scope)) return result;
    const limits = { ...DEFAULTS, ...options };
    for (const key of Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > DEFAULTS[key]) return result;
    }
    result.root = realpathSync(cwd);
    const root = result.root;
    const deadline = performance.now() + limits.timeoutMs;
    const check = () => { if (options.signal?.aborted || performance.now() >= deadline) throw Error("capture stopped"); };
    const git = async (args: string[]): Promise<string> => {
      check();
      const run = await runProcess({ command: "git", args: ["--no-replace-objects", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], cwd: root,
        env: controllerGitEnv({ ceilingDirectory: dirname(root) }), timeoutMs: Math.max(1, deadline - performance.now()), signal: options.signal, maxBufferBytes: MAX_OUTPUT });
      check();
      if (run.exitCode !== 0 || run.timedOut || run.aborted || run.spawnError || Buffer.byteLength(run.stdout) >= MAX_OUTPUT - 3) throw Error("incomplete Git capture");
      return run.stdout;
    };
    if (realpathSync((await git(["rev-parse", "--show-toplevel"])).trim()) !== root) return result;
    const head = async () => {
      const sha = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      if (!COMMIT.test(sha)) throw Error("unknown HEAD"); return sha;
    };
    const names = async () => {
      const raw = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
      if (raw !== "" && !raw.endsWith("\0")) throw Error("incomplete path list");
      const paths = [...new Set(raw === "" ? [] : raw.slice(0, -1).split("\0"))].sort();
      if (paths.length > limits.maxFiles || paths.some(path => !pathIsCanonical(path))) throw Error("unsupported path universe");
      return paths;
    };
    result.head = await head();
    if (committed !== undefined && result.head !== committed) return result;
    const tree = new Map<string, { mode: string; oid: string }>();
    let objectFormat: "sha1" | "sha256" = "sha1";
    if (committed !== undefined) {
      const format = (await git(["rev-parse", "--show-object-format"])).trim();
      if ((format !== "sha1" && format !== "sha256") || committed.length !== (format === "sha1" ? 40 : 64)) throw Error("unsupported object format");
      objectFormat = format;
      const raw = await git(["ls-tree", "-r", "-z", "--full-tree", committed]);
      if (raw !== "" && !raw.endsWith("\0")) throw Error("incomplete committed tree");
      for (const row of raw === "" ? [] : raw.slice(0, -1).split("\0")) {
        const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/u.exec(row);
        if (!match || match[2]!.length !== committed.length || !pathIsCanonical(match[3]!) || tree.has(match[3]!) || tree.size >= limits.maxFiles) throw Error("unsupported committed tree");
        tree.set(match[3]!, { mode: match[1]!, oid: match[2]! });
      }
    }
    const listed = await names();
    const scan = (): WorkCapture["files"] => {
      const files: WorkCapture["files"] = []; let total = 0;
      for (const path of listed) {
        check(); let current = root; let missing = false; const parts = path.split("/");
        for (const part of parts.slice(0, -1)) {
          current = join(current, part);
          try { if (!lstatSync(current).isDirectory()) throw Error("non-directory ancestor"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { missing = true; break; } throw error; }
        }
        if (missing) continue; // stable tracked deletion is an observed absence, checked again below
        const full = join(root, path); let before: Stats;
        try { before = lstatSync(full); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (!before.isFile() || before.size > limits.maxFileBytes || total + before.size > limits.maxTotalBytes) throw Error("unsupported file capture");
        let fd: number | undefined;
        try {
          fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const opened = fstatSync(fd);
          if (!opened.isFile() || !sameStat(before, opened)) throw Error("file changed before capture");
          const objectHash = committed === undefined ? undefined : createHash(objectFormat).update("blob " + before.size + "\0");
          const hash = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024); let bytes = 0;
          for (;;) {
            check(); const count = readSync(fd, buffer, 0, buffer.length, null); if (count === 0) break;
            bytes += count; if (bytes > limits.maxFileBytes || total + bytes > limits.maxTotalBytes) throw Error("capture bound exceeded");
            hash.update(buffer.subarray(0, count)); objectHash?.update(buffer.subarray(0, count));
          }
          if (bytes !== before.size || !sameStat(before, fstatSync(fd)) || !sameStat(before, lstatSync(full))) throw Error("file changed during capture");
          const mode = before.mode & 0o100 ? "100755" : "100644";
          if (objectHash) {
            const entry = tree.get(path);
            if (!entry || entry.mode !== mode || entry.oid !== objectHash.digest("hex")) throw Error("working bytes differ from committed tree");
          }
          total += bytes;
          files.push({ path, sha256: hash.digest("hex"), mode });
        } finally { if (fd !== undefined) closeSync(fd); }
      }
      if (committed !== undefined && files.length !== tree.size) throw Error("incomplete committed tree coverage");
      return files;
    };
    const first = scan();
    if (JSON.stringify(listed) !== JSON.stringify(await names())) return result;
    const second = scan();
    if (JSON.stringify(first) !== JSON.stringify(second) || await head() !== result.head) return result;
    if (JSON.stringify(listed) !== JSON.stringify(await names()) || realpathSync(cwd) !== root) return result;
    check(); result.files = second; result.complete = true;
  } catch { /* Unknown is preserved as an incomplete empty capture, never a successful empty baseline. */ }
  return result;
}

