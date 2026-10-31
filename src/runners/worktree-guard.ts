// Keeps a read-only agent run read-only where no sandbox can: snapshots the git working tree it runs in, and
// afterwards puts back whatever the run changed (files, the index, the branch and its commits).
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { controllerGitEnv } from "../util/launch-env.js";
import { runProcess } from "../util/process.js";

export interface WorktreeSnapshot {
  root: string;
  /** The branch HEAD points to ("refs/heads/…"), or null when HEAD is detached. */
  branch: string | null;
  /** The commit HEAD resolved to, or null on an unborn branch. */
  head: string | null;
  /** The working tree's content (tracked files, and untracked ones unless there were too many) as a git tree. */
  tree: string;
  /** Whether `tree` includes untracked files. */
  withUntracked: boolean;
  indexPath: string;
  /** The index file's bytes, or null when there was none. */
  index: Buffer | null;
  /** The index file's modification time, in milliseconds (rounded down), or null when there was no index. Git needs it to be put back with the bytes. */
  indexMtimeMs: number | null;
}

/**
 * Above this many untracked (not ignored) files only tracked files are guarded: hashing them all, say an
 * unignored node_modules, would take long and fill the object store.
 */
const MAX_UNTRACKED_FILES = 2_000;
const GIT_TIMEOUT_MS = 2 * 60_000;
/** As in git.ts: raw paths, no colors, and no fsmonitor or hook commands from a config the agent may have written. */
const SAFE_ARGS = ["-c", "core.quotepath=off", "-c", "color.ui=false", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

/** The state of the git working tree around `cwd`; undefined when it is not in one, or git fails. */
export async function snapshotWorktree(cwd: string): Promise<WorktreeSnapshot | undefined> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || top.out.trim() === "") return undefined;
  const root = top.out.trim();
  const indexOut = await git(root, ["rev-parse", "--git-path", "index"]);
  if (!indexOut.ok) return undefined;
  const indexPath = resolve(root, indexOut.out.trim());
  const untracked = await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const withUntracked = untracked.ok && untracked.out.split("\0").filter(Boolean).length <= MAX_UNTRACKED_FILES;
  const tree = await contentTree(root, indexPath, withUntracked);
  if (tree === undefined) return undefined;
  const index = readIndex(indexPath);
  return { root, ...(await headState(root)), tree, withUntracked, indexPath, index: index.bytes, indexMtimeMs: index.mtimeMs };
}

/**
 * Puts the working tree back as the snapshot found it and returns the paths that had changed (plus "HEAD" when the
 * branch or its commits had), or [] when nothing had. Files git ignores are left alone.
 */
export async function restoreWorktree(snap: WorktreeSnapshot): Promise<string[]> {
  const { root } = snap;
  const now = await headState(root);
  const tree = await contentTree(root, snap.indexPath, snap.withUntracked);
  const index = readIfExists(snap.indexPath);
  const headMoved = now.branch !== snap.branch || now.head !== snap.head;
  const indexChanged = !sameBytes(index, snap.index);
  if (!headMoved && tree === snap.tree && !indexChanged) return [];

  const changed: string[] = [];
  if (headMoved) {
    await restoreHead(root, snap);
    changed.push("HEAD");
  }
  if (tree !== snap.tree) changed.push(...(await restoreFiles(root, snap.tree, tree)));
  if (indexChanged) {
    if (snap.index === null) rmSync(snap.indexPath, { force: true });
    else {
      writeFileSync(snap.indexPath, snap.index);
      setModified(snap.indexPath, snap.indexMtimeMs);
    }
    if (changed.length === 0) changed.push("(the git index)");
  }
  return changed;
}

async function headState(root: string): Promise<{ branch: string | null; head: string | null }> {
  const branch = await git(root, ["symbolic-ref", "-q", "HEAD"]);
  const head = await git(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  return { branch: branch.ok ? branch.out.trim() : null, head: head.ok ? head.out.trim() : null };
}

/** The branch HEAD was on, at the commit it was at: commits made since become unreachable. */
async function restoreHead(root: string, snap: WorktreeSnapshot): Promise<void> {
  if (snap.branch === null) {
    if (snap.head !== null) await git(root, ["update-ref", "--no-deref", "HEAD", snap.head]);
    return;
  }
  if (snap.head !== null) await git(root, ["update-ref", snap.branch, snap.head]);
  await git(root, ["symbolic-ref", "HEAD", snap.branch]);
}

/** Rewrites changed and deleted files from the snapshot's tree and deletes added ones; returns the paths. */
async function restoreFiles(root: string, before: string, after: string | undefined): Promise<string[]> {
  // Without the later tree, every snapshot file is rewritten; files added since cannot be told apart.
  const differing = after === undefined ? await treePaths(root, before) : await diffPaths(root, before, after);
  const added = new Set(after === undefined ? [] : await diffPaths(root, before, after, "A"));
  // First, so a directory the run turned into a link is a directory again before files are written into it.
  for (const path of added) removeFile(join(root, path));
  const rewrite = differing.filter((path) => !added.has(path));
  if (rewrite.length > 0) {
    await withTempIndex(async (env) => {
      await git(root, ["read-tree", before], env);
      await git(root, ["checkout-index", "-f", "-z", "--stdin"], env, rewrite.join("\0"));
    });
  }
  return differing;
}

/**
 * The working tree's content as a tree object, via a copy of the index (git's stat cache keeps this fast). The copy keeps the original's
 * modification time: see `copyIndex`.
 */
async function contentTree(root: string, indexPath: string, withUntracked: boolean): Promise<string | undefined> {
  return withTempIndex(async (env, tempIndex) => {
    if (existsSync(indexPath)) copyIndex(indexPath, tempIndex);
    const add = await git(root, ["add", withUntracked ? "-A" : "-u"], env);
    if (!add.ok) return undefined;
    const tree = await git(root, ["write-tree"], env);
    return tree.ok ? tree.out.trim() : undefined;
  });
}

/**
 * Copies the index file and gives the copy the original's modification time.
 *
 * For each file, the index saves the file's size and time. Git takes a file as unchanged when the file still has them, except for a
 * file whose saved time is in the same second as the index file's own time, or later: that file could have been changed again, with the
 * same size, in the second the index was written, so git reads it again. A copy made now is newer than every saved time, so with a copy
 * that second look never happened: a file changed with the same size in the second the index was written looked unchanged once the
 * second was over (the flaky failure of worktree-guard.test.ts in a full run). Giving the copy the original's time makes git treat it
 * as it treats the original.
 */
function copyIndex(from: string, to: string): void {
  const before = statSync(from);
  copyFileSync(from, to);
  setModified(to, Math.min(before.mtimeMs, statSync(from).mtimeMs));
}

/** Sets the modification time of `path` to `ms` milliseconds, rounded down (earlier is the safe side: git then reads more files again). Does nothing for null. */
function setModified(path: string, ms: number | null): void {
  if (ms === null) return;
  try {
    const seconds = Math.floor(ms) / 1000;
    utimesSync(path, seconds, seconds);
  } catch {
    // the time is a safeguard against a missed change; without it the guard works as it did
  }
}

/** The index file's bytes and modification time (rounded down; the older of the two readings when the file was rewritten meanwhile), or nulls when there is none. */
function readIndex(path: string): { bytes: Buffer | null; mtimeMs: number | null } {
  try {
    const before = statSync(path).mtimeMs;
    const bytes = readFileSync(path);
    return { bytes, mtimeMs: Math.floor(Math.min(before, statSync(path).mtimeMs)) };
  } catch {
    return { bytes: null, mtimeMs: null };
  }
}

async function diffPaths(root: string, from: string, to: string, filter?: string): Promise<string[]> {
  const args = ["diff-tree", "-r", "-z", "--name-only", "--no-renames", ...(filter ? [`--diff-filter=${filter}`] : []), from, to];
  const out = await git(root, args);
  return out.ok ? out.out.split("\0").filter(Boolean) : [];
}

async function treePaths(root: string, tree: string): Promise<string[]> {
  const out = await git(root, ["ls-tree", "-r", "-z", "--name-only", tree]);
  return out.ok ? out.out.split("\0").filter(Boolean) : [];
}

async function withTempIndex<T>(use: (env: { indexFile: string }, indexFile: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join("/tmp", "mc-guard-"));
  const indexFile = join(dir, "index");
  try {
    return await use({ indexFile }, indexFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: string[], extraEnv: { indexFile?: string } = {}, stdin?: string): Promise<{ ok: boolean; out: string }> {
  const env = controllerGitEnv({ indexFile: extraEnv.indexFile });
  const result = await runProcess({
    command: "git",
    args: [...SAFE_ARGS, ...args],
    cwd,
    env,
    timeoutMs: GIT_TIMEOUT_MS,
    ...(stdin !== undefined && { stdin }),
  });
  return { ok: result.exitCode === 0, out: result.stdout };
}

function removeFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // a directory where the snapshot had none: git ignores empty ones, and a full one is the agent's mess, not ours
  }
}

function readIfExists(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}
