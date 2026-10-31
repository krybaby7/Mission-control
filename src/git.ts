// Git operations for missions (repos, branches, worktrees, commits, merges, pushes), shelling out to the `git` CLI.
import { accessSync, constants as fsConstants, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "./types.js";
import { nullLogger } from "./util/logger.js";
import { controllerGitEnv, type ControllerGitOptions } from "./util/launch-env.js";
import { runProcess, type SpawnResult } from "./util/process.js";


const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Identity used when a repository has none configured (e.g. inside the container, which has no global git config). */
const FALLBACK_IDENTITY: ReadonlyArray<readonly [key: string, value: string]> = [
  ["user.name", "Mission Control"],
  ["user.email", "mission-control@localhost"],
];
/**
 * Prepended to every command: raw (unquoted) non-ASCII paths, and no color codes in output we parse. No fsmonitor
 * either: `core.fsmonitor` names a command git runs on status, add and commit, and agents can write the repo's config.
 */
// Exact objects are shared by ancestry, merge operations and the independent committed source capture.
const BASE_ARGS = ["--no-replace-objects", "-c", "core.quotepath=off", "-c", "color.ui=false", "-c", "core.fsmonitor=false"];
/**
 * Also prepended (except to read where the hooks are): no command runs a hook. `--no-verify` leaves post-checkout,
 * post-commit, post-merge and reference-transaction hooks running, and one that fails or hangs would fail an operation
 * that already happened; and agents can write the hooks, and the config naming their folder.
 */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
/** Stdout kept in memory, for error messages, while a diff streams to a file. */
const DIFF_CAPTURE_BYTES = 256 * 1024;
/** Paths passed as arguments per command, in bytes: well below Linux's 2 MiB limit on arguments plus environment. */
const MAX_PATH_ARG_BYTES = 256 * 1024;
const MAX_ERROR_LINES = 20;
/** `s`: a subject may contain "\r", U+2028 or U+2029, which `.` would not match. */
const COMMIT_LINE = /^([0-9a-f]{40,64})\x1f(.*)$/s;

export class GitError extends Error {
  override name = "GitError";

  constructor(
    message: string,
    readonly stderr: string = "",
  ) {
    super(message);
  }
}

export type MergeResult = { ok: true; sha: string } | { ok: false; conflict: boolean; error: string };

export interface GitOptions extends Pick<ControllerGitOptions, "path" | "home" | "globalConfig" | "isolatedConfig"> {
  logger?: Logger;
  /** Per-command timeout. Default 10 minutes. */
  timeoutMs?: number;
  /** Most output one command may print (file lists, mostly); more fails the command. Default 64 MiB. */
  maxOutputBytes?: number;
}

interface RunOptions {
  stdin?: string;
  /** Raw stdout goes to this file; only a short tail is kept in memory, for error messages. */
  stdoutFile?: string;
  onStdoutLine?: (line: string) => void;
  /** Exit codes that are not a failure. Default [0]. */
  allow?: number[] | "any";
  /**
   * Leave `core.hooksPath` as the repository sets it, for reading where its hooks are. No command Mission Control
   * runs may run a hook: agents can write them.
   */
  repoHooksPath?: boolean;
  /** Only `cwd` itself may hold the repository: a worktree that lost its .git never reaches an enclosing one. */
  rootOnly?: boolean;
}

interface Worktree {
  path: string;
  /** Short name of the checked-out branch; undefined when detached. */
  branch?: string;
  locked: boolean;
}

/**
 * Every method is async and throws GitError on an unexpected failure. Paths returned and accepted as file lists
 * are repo-relative with forward slashes; `cwd` arguments are expected to be a worktree root.
 */
export class Git {
  private readonly logger: Logger;
  private readonly launch: ControllerGitOptions;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(opts: GitOptions = {}) {
    this.launch = { path: opts.path, home: opts.home, globalConfig: opts.globalConfig, isolatedConfig: opts.isolatedConfig };
    this.logger = opts.logger ?? nullLogger;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  /** Makes `path` the root of a repository with an identity and at least one commit (an empty one on `main`). */
  async ensureRepo(path: string, opts: { initialBranch?: string } = {}): Promise<void> {
    const dir = resolve(path);
    mkdirSync(dir, { recursive: true });
    // A directory inside some other repository (e.g. a dotfiles repo in $HOME) still gets its own.
    if (!(await this.isRepoRoot(dir))) await this.git(dir, ["init", "-q", "-b", refArg(opts.initialBranch ?? "main")]);
    for (const [key, value] of await this.missingIdentity(dir)) await this.git(dir, ["config", "--local", key, value]);
    if ((await this.resolveCommit(dir, "HEAD")) === undefined) {
      await this.git(dir, ["commit", "-q", "--allow-empty", "--no-verify", "--no-gpg-sign", "-m", "Initial commit"]);
    }
  }

  /** True when `path` is inside a git work tree. */
  async isRepo(path: string): Promise<boolean> {
    if (!isDirectory(path)) return false;
    const args = ["rev-parse", "--is-inside-work-tree"];
    const result = await this.run(path, args, { allow: [0, 128] });
    if (result.exitCode === 0) return result.stdout.trim() === "true";
    if (/not a git repository/i.test(result.stderr)) return false;
    throw gitFailure(path, args, result); // e.g. "detected dubious ownership"
  }

  async isShallow(repo: string): Promise<boolean> {
    return (await this.git(repo, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
  }

  /** The checked-out branch; throws when HEAD is detached. */
  async currentBranch(repo: string): Promise<string> {
    // The full ref, not --short: that answers "heads/main" when a tag is also named "main".
    const result = await this.run(repo, ["symbolic-ref", "-q", "HEAD"], { allow: [0, 1] });
    const ref = result.stdout.trim();
    if (!ref.startsWith("refs/heads/")) throw new GitError(`${repo} is not on a branch (detached HEAD)`, result.stderr);
    return ref.slice("refs/heads/".length);
  }

  /**
   * Puts the worktree at `cwd` back on `branch` when HEAD is on another branch or detached (an agent ran `git checkout
   * -b`, `git switch` or checked out a commit), without touching its files or index: the next commit records the files
   * as they are, on top of `branch`. A missing `branch` is created at HEAD. Returns false when HEAD was on `branch`.
   */
  async keepOnBranch(cwd: string, branch: string): Promise<boolean> {
    const ref = `refs/heads/${refArg(branch)}`;
    const head = await this.run(cwd, ["symbolic-ref", "-q", "HEAD"], { allow: [0, 1], rootOnly: true });
    if (head.stdout.trim() === ref) return false;
    if (!(await this.branchExists(cwd, branch))) await this.git(cwd, ["branch", "--no-track", refArg(branch), "HEAD"], { rootOnly: true });
    await this.git(cwd, ["symbolic-ref", "HEAD", ref], { rootOnly: true });
    return true;
  }

  async headSha(cwd: string, ref = "HEAD"): Promise<string> {
    const sha = await this.resolveCommit(cwd, refArg(ref));
    if (sha === undefined) throw new GitError(`unknown revision "${ref}" in ${cwd}`);
    return sha;
  }

  /** True only for an exact branch name: revision syntax such as "main~1" names no branch. */
  async branchExists(repo: string, branch: string): Promise<boolean> {
    const args = ["show-ref", "--verify", "--quiet", `refs/heads/${refArg(branch)}`];
    return (await this.run(repo, args, { allow: [0, 1] })).exitCode === 0;
  }

  /** Creates `branch` at `fromRef` unless it already exists (an existing branch is left where it is). */
  async ensureBranch(repo: string, branch: string, fromRef: string): Promise<void> {
    if (await this.branchExists(repo, branch)) return;
    await this.git(repo, ["branch", "--no-track", refArg(branch), refArg(fromRef)]);
  }

  /**
   * Checks out `branch` in a new worktree at `path`, creating the branch from `fromRef` if needed. Whatever is at
   * `path` goes first: a registered worktree (uncommitted changes there are lost, even when locked or damaged) or
   * a leftover directory, unless that holds a checkout. A registration whose directory vanished releases `branch`.
   */
  async addWorktree(repo: string, path: string, branch: string, fromRef: string): Promise<void> {
    const target = resolve(path);
    await this.removeWorktree(repo, target);
    // `worktree prune` keeps locked registrations, so one left by a crash would keep `branch` "checked out".
    const vanished = (await this.listWorktrees(repo)).find((wt) => wt.branch === branch && !existsSync(wt.path));
    if (vanished) await this.removeWorktree(repo, vanished.path);
    if (existsSync(target)) await this.discardLeftover(repo, target);
    const args = (await this.branchExists(repo, branch))
      ? ["worktree", "add", target, refArg(branch)]
      : ["worktree", "add", "--no-track", "-b", refArg(branch), target, refArg(fromRef)];
    await this.git(repo, args);
  }

  /**
   * Removes the linked worktree registered at `path`, with any local changes, even when it is locked or git can no
   * longer validate it, then prunes stale registrations. Nothing registered there is fine; the main worktree is refused.
   */
  async removeWorktree(repo: string, path: string): Promise<void> {
    const target = resolve(path);
    // Looked up before pruning: prune forgets a worktree whose .git file is gone, though its directory remains.
    const worktrees = await this.listWorktrees(repo);
    const index = worktrees.findIndex((worktree) => canonicalPath(worktree.path) === canonicalPath(target));
    if (index === 0) throw new GitError(`refusing to remove the main worktree ${target}`);
    const worktree = worktrees[index];
    if (worktree) {
      // `worktree add` killed mid-checkout leaves its worktree locked, and `remove --force` refuses locked ones.
      if (worktree.locked) await this.git(repo, ["worktree", "unlock", worktree.path]);
      const result = await this.run(repo, ["worktree", "remove", "--force", target], { allow: "any" });
      if (result.exitCode !== 0 && existsSync(target)) {
        // E.g. an agent deleted its .git file; it is still a linked worktree of this repository, so ours to delete.
        this.logger.warn("git could not remove a worktree; deleting its directory", { repo, path: target, error: outputTail(result) });
        deleteTree(target);
      }
    }
    await this.git(repo, ["worktree", "prune"]);
  }

  /** No staged, unstaged or untracked (non-ignored) changes, even where `status.showUntrackedFiles` hides untracked files. */
  async isClean(cwd: string): Promise<boolean> {
    return (await this.git(cwd, ["status", "--porcelain", "--untracked-files=normal"])).trim() === "";
  }

  /**
   * Stages everything and commits it, skipping hooks. Returns the new commit, or null when there was nothing to commit.
   * A repository an agent created inside the worktree (a scaffolder's `git init`, a clone) loses its .git first, so its
   * files are committed rather than a gitlink to commits that exist nowhere else.
   */
  async commitAll(cwd: string, message: string): Promise<string | null> {
    await this.flattenNestedRepos(cwd);
    await this.git(cwd, ["add", "-A"], { rootOnly: true });
    const staged = await this.run(cwd, ["diff", "--cached", "--quiet"], { allow: [0, 1] });
    if (staged.exitCode === 0) return null;
    const identity = await this.identityArgs(cwd);
    const commit = [...identity, "commit", "-q", "--no-verify", "--no-gpg-sign", "-F", "-"];
    await this.git(cwd, commit, { stdin: message, rootOnly: true });
    return this.headSha(cwd);
  }

  /**
   * Files that differ from `fromRef`: committed, staged and unstaged changes (both sides of a rename),
   * plus untracked files that are not ignored (an untracked nested repository is listed as "dir/").
   * Repo-relative, sorted, unique.
   */
  async changedFiles(cwd: string, fromRef: string): Promise<string[]> {
    const tracked = await this.git(cwd, ["diff", "--name-only", "-z", "--no-renames", refArg(fromRef), "--"]);
    const untracked = await this.git(cwd, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"]);
    return [...new Set([...splitNul(tracked), ...splitNul(untracked)])].sort();
  }

  /**
   * The same files as `changedFiles`, told apart: `added` are the files that `fromRef` does not have (git status A, and untracked files that
   * are not ignored); `existing` are the files that it has and that were changed or removed. Repo-relative, sorted, unique.
   */
  async changedFilesByKind(cwd: string, fromRef: string): Promise<{ added: string[]; existing: string[] }> {
    const parts = splitNul(await this.git(cwd, ["diff", "--name-status", "-z", "--no-renames", refArg(fromRef), "--"]));
    const added = new Set<string>();
    const existing = new Set<string>();
    // `-z` prints the status and the path as two entries, one after the other.
    for (let i = 0; i + 1 < parts.length; i += 2) (parts[i]!.startsWith("A") ? added : existing).add(parts[i + 1]!);
    for (const path of splitNul(await this.git(cwd, ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"]))) {
      if (!existing.has(path)) added.add(path);
    }
    return { added: [...added].sort(), existing: [...existing].sort() };
  }

  /**
   * The files that `commit` changed compared with its first parent: for a merge commit made with `--no-ff`, the files the merged work
   * brought in. Repo-relative, sorted, unique (both sides of a rename). Throws when `commit` has no parent.
   */
  async filesChangedBy(cwd: string, commit: string): Promise<string[]> {
    const out = await this.git(cwd, ["diff", "--name-only", "-z", "--no-renames", `${refArg(commit)}^1`, refArg(commit), "--"]);
    return [...new Set(splitNul(out))].sort();
  }

  /**
   * Unified diff from `fromRef` to `toRef`, or to the working tree (tracked files only: commit first to include new
   * files), byte for byte as git prints it. With `maxChars`, the head is kept and a "[diff truncated: N chars omitted]"
   * line is appended.
   */
  async diff(cwd: string, fromRef: string, toRef?: string, maxChars = Infinity): Promise<string> {
    const revisions = toRef === undefined ? [refArg(fromRef)] : [refArg(fromRef), refArg(toRef)];
    // Fixed a/ b/ prefixes and no renames/textconv, whatever the user's config: verify.ts parses this output.
    const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];
    const dir = makeTempDir();
    try {
      // Through a file, not line callbacks (they drop "\r"), and read back so only `maxChars` stay in memory.
      const file = join(dir, "diff");
      let lines = 0;
      await this.run(cwd, [...args, ...revisions, "--"], { stdoutFile: file, onStdoutLine: () => lines++ });
      const { head, omitted, lineCount } = await readHead(file, maxChars);
      if (lineCount !== lines) throw new GitError(`the diff in ${cwd} could not be buffered in ${dir} (disk full?)`);
      if (omitted === 0) return head;
      const separator = head === "" || head.endsWith("\n") ? "" : "\n";
      return `${head}${separator}[diff truncated: ${omitted} chars omitted]\n`;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Restores `paths` (files or directories) to their content at `ref`; paths that do not exist at `ref` are deleted
   * from the index and the working tree. Paths are taken literally (no glob matching) and may be spelled any way that
   * stays inside the worktree. Paths outside it, and deletions beyond a symbolic link, are refused before anything changes.
   */
  async restorePaths(cwd: string, ref: string, paths: string[]): Promise<void> {
    const wanted = [...new Set(paths.map((path) => worktreePath(cwd, path)))];
    if (wanted.length === 0) return;
    const atRef = await this.pathsAtRef(cwd, ref, wanted);
    const present = wanted.filter((path) => atRef.has(path));
    const absent = wanted.filter((path) => !atRef.has(path));
    for (const path of absent) assertNoLinkOnTheWay(cwd, path);
    // Paths go through stdin: thousands of them would overflow the command line.
    const fromStdin = ["--pathspec-from-file=-", "--pathspec-file-nul"];
    if (present.length > 0) {
      const checkout = ["--literal-pathspecs", "checkout", refArg(ref), ...fromStdin];
      await this.git(cwd, checkout, { stdin: present.join("\0"), rootOnly: true });
    }
    if (absent.length > 0) {
      const rm = ["--literal-pathspecs", "rm", "-r", "-q", "--cached", "--ignore-unmatch", ...fromStdin];
      await this.git(cwd, rm, { stdin: absent.join("\0"), rootOnly: true });
      for (const path of absent) deleteTree(join(cwd, path));
    }
  }

  /**
   * Resets to `ref` and deletes untracked files and directories, nested repositories included; ignored files
   * (node_modules, build output) stay.
   */
  async resetHard(cwd: string, ref: string): Promise<void> {
    await this.git(cwd, ["reset", "-q", "--hard", refArg(ref)], { rootOnly: true });
    await this.git(cwd, ["clean", "-q", "-f", "-f", "-d"], { rootOnly: true }); // a single -f skips nested repositories
  }

  /**
   * Merges `source` into the checked-out branch with a merge commit. A conflicted merge is aborted, and so is a merge
   * left in progress beforehand (e.g. by a crash), which would otherwise pass for a conflict of this one.
   */
  /** Observational confirmation of this controller's --no-ff merge form; never ancestry-only gap recovery. */
  async confirmMergeReceipt(cwd: string, before: string, source: string, returned: string): Promise<boolean> {
    const exact = (v: unknown): v is string => typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v);
    if (![before, source, returned].every(exact) || before.length !== source.length || before.length !== returned.length) return false;
    try {
      const head = async () => (await this.git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], { rootOnly: true })).trim();
      if (await head() !== returned) return false;
      if (returned === before) {
        const ancestry = await this.run(cwd, ["merge-base", "--is-ancestor", source, before], { allow: [0, 1], rootOnly: true });
        if (ancestry.exitCode !== 0) return false;
      } else {
        const parents = (await this.git(cwd, ["show", "-s", "--format=%P", returned, "--"], { rootOnly: true })).trim();
        if (parents !== before + " " + source || source === before) return false;
      }
      return await head() === returned;
    } catch { return false; } // A failed observation cannot confer operation credit.
  }

  async merge(cwd: string, source: string, message: string): Promise<MergeResult> {
    if ((await this.resolveCommit(cwd, "MERGE_HEAD")) !== undefined) {
      this.logger.warn("aborting a merge that was left in progress", { cwd });
      await this.git(cwd, ["merge", "--abort"], { rootOnly: true });
    }
    const identity = await this.identityArgs(cwd);
    const args = [...identity, "merge", "--no-ff", "--no-edit", "--no-verify", "--no-gpg-sign", "-m", message, refArg(source)];
    const result = await this.run(cwd, args, { allow: "any", rootOnly: true });
    if (result.exitCode === 0) return { ok: true, sha: await this.headSha(cwd) };
    // A merge that stopped on conflicts leaves MERGE_HEAD; failures before merging (unknown ref, dirty tree) do not.
    const conflict = (await this.resolveCommit(cwd, "MERGE_HEAD")) !== undefined;
    if (conflict) await this.git(cwd, ["merge", "--abort"], { rootOnly: true });
    return { ok: false, conflict, error: outputTail(result) };
  }

  /**
   * Moves `branch` forward to `toRef`. Where the branch is checked out (in `repo` or a linked worktree) this is
   * `merge --ff-only` there, so the files follow; elsewhere the ref is moved. Throws when the histories diverged.
   */
  async fastForward(repo: string, branch: string, toRef: string): Promise<void> {
    const target = await this.headSha(repo, toRef);
    const current = await this.headSha(repo, `refs/heads/${refArg(branch)}`);
    if (await this.isAncestor(repo, target, current)) return; // already contains toRef
    if (!(await this.isAncestor(repo, current, target))) {
      throw new GitError(`cannot fast-forward ${branch} to ${toRef}: ${branch} has commits that ${toRef} does not`);
    }
    const checkout = (await this.listWorktrees(repo)).find((worktree) => worktree.branch === branch);
    if (checkout) await this.git(checkout.path, ["merge", "-q", "--ff-only", target]);
    else await this.git(repo, ["branch", "-f", branch, target]);
  }

  async checkout(repo: string, branch: string): Promise<void> {
    await this.git(repo, ["checkout", "-q", refArg(branch), "--"]);
  }

  async hasRemote(repo: string, name = "origin"): Promise<boolean> {
    const remotes = await this.git(repo, ["remote"]);
    return remotes.split("\n").some((remote) => remote.trim() === name);
  }

  /**
   * Pushes `branch` to origin under the same name. Only `<prefix>/…` branches, never forced; failures are returned.
   * No hook runs: agents can write the hooks and the config naming their folder, and a hook would run with the push's
   * credentials in reach. A repository with a pre-push hook (Git LFS uploads files there, husky runs checks) is not
   * pushed, since skipping the hook could push something it would have stopped; the error says how to push by hand.
   */
  async push(repo: string, branch: string, prefix: string): Promise<{ ok: boolean; error?: string }> {
    if (prefix === "" || !branch.startsWith(`${prefix}/`)) {
      return { ok: false, error: `refusing to push "${branch}": only ${prefix}/* branches are pushed` };
    }
    try {
      if (!(await this.hasRemote(repo))) return { ok: false, error: "no remote" };
      const hook = await this.prePushHook(repo);
      if (hook !== undefined) {
        return {
          ok: false,
          error: `the repository has a pre-push hook (${hook}), which Mission Control does not run, so it did not push. To push, run in the app's folder: git push origin ${branch}`,
        };
      }
      const refspec = `refs/heads/${branch}:refs/heads/${branch}`; // no "+": a non-fast-forward push is rejected
      const result = await this.run(repo, ["push", "--quiet", "origin", refspec], { allow: "any" });
      return result.exitCode === 0 ? { ok: true } : { ok: false, error: outputTail(result) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Commits in `range` (e.g. "base..HEAD"), newest first. */
  async log(cwd: string, range: string, max?: number): Promise<{ sha: string; subject: string }[]> {
    const limit = max === undefined ? [] : [`--max-count=${max}`];
    const out = await this.git(cwd, ["log", "--format=%H%x1f%s", ...limit, refArg(range), "--"]);
    // Matching the format (not just splitting lines) skips anything a config like log.showSignature adds.
    // A subject never holds "\n": %s joins the lines of the message's first paragraph.
    return out.split("\n").flatMap((line) => {
      const match = COMMIT_LINE.exec(line);
      return match ? [{ sha: match[1] ?? "", subject: match[2] ?? "" }] : [];
    });
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Runs git and returns stdout; any non-zero exit throws. */
  private async git(cwd: string, args: string[], opts: RunOptions = {}): Promise<string> {
    return (await this.run(cwd, args, opts)).stdout;
  }

  /**
   * Runs git; a spawn failure, a timeout, an exit code outside `opts.allow`, or more output than `maxOutputBytes`
   * throws a GitError.
   */
  private async run(cwd: string, args: string[], opts: RunOptions = {}): Promise<SpawnResult> {
    const captureBytes = opts.stdoutFile === undefined ? this.maxOutputBytes : DIFF_CAPTURE_BYTES;
    const result = await runProcess({
      command: "git",
      args: [...BASE_ARGS, ...(opts.repoHooksPath ? [] : NO_HOOKS), ...args],
      cwd,
      env: gitEnv(opts.rootOnly ? cwd : undefined, this.launch),
      stdin: opts.stdin,
      timeoutMs: this.timeoutMs,
      onStdoutLine: opts.onStdoutLine,
      teeStdoutTo: opts.stdoutFile,
      maxBufferBytes: captureBytes,
    });
    const allow = opts.allow ?? [0];
    const exitAllowed = allow === "any" || (result.exitCode !== null && allow.includes(result.exitCode));
    if (result.spawnError !== undefined || result.timedOut || !exitAllowed) throw gitFailure(cwd, args, result);
    // A full capture keeps only its last bytes (minus up to 3 of a cut character): a partial file list is never returned.
    if (opts.stdoutFile === undefined && Buffer.byteLength(result.stdout) >= captureBytes - 3) {
      throw new GitError(`git ${describeCommand(args)} printed more than ${captureBytes} bytes in ${cwd}`);
    }
    return result;
  }

  /** The commit `rev` names, or undefined when it names none. */
  private async resolveCommit(cwd: string, rev: string): Promise<string | undefined> {
    const result = await this.run(cwd, ["rev-parse", "-q", "--verify", `${rev}^{commit}`], { allow: [0, 1] });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  /**
   * The executable pre-push hook git would run in `repo` (in the folder `core.hooksPath` names, else `.git/hooks`), as
   * git prints its path (relative to `repo` when inside it); undefined when there is none.
   */
  private async prePushHook(repo: string): Promise<string | undefined> {
    const path = (await this.git(repo, ["rev-parse", "--git-path", "hooks/pre-push"], { repoHooksPath: true })).trim();
    if (path === "") return undefined;
    try {
      const full = resolve(repo, path);
      if (!statSync(full).isFile()) return undefined;
      accessSync(full, fsConstants.X_OK);
      return path;
    } catch {
      return undefined; // none, or not executable (git skips it too)
    }
  }

  /** True when `ancestor` is `descendant` or one of its ancestors. */
  async isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.run(repo, ["merge-base", "--is-ancestor", ancestor, descendant], { allow: [0, 1] });
    return result.exitCode === 0;
  }

  private async isRepoRoot(dir: string): Promise<boolean> {
    const result = await this.run(dir, ["rev-parse", "--show-toplevel"], { allow: "any" });
    return result.exitCode === 0 && canonicalPath(result.stdout.trim()) === canonicalPath(dir);
  }

  /** Identity keys that no config level sets (or sets to an empty value), paired with their fallback values. */
  private async missingIdentity(cwd: string): Promise<Array<readonly [string, string]>> {
    const result = await this.run(cwd, ["config", "--get-regexp", "^user\\.(name|email)$"], { allow: [0, 1] });
    const configured = new Set(
      result.stdout
        .split("\n")
        .map((line) => /^(\S+) +\S/.exec(line)?.[1])
        .filter((key) => key !== undefined),
    );
    return FALLBACK_IDENTITY.filter(([key]) => !configured.has(key));
  }

  /** `-c user.*` arguments so commits work in repositories without an identity, without writing to their config. */
  private async identityArgs(cwd: string): Promise<string[]> {
    return (await this.missingIdentity(cwd)).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
  }

  private async listWorktrees(repo: string): Promise<Worktree[]> {
    const worktrees: Worktree[] = [];
    for (const line of (await this.git(repo, ["worktree", "list", "--porcelain"])).split("\n")) {
      if (line.startsWith("worktree ")) worktrees.push({ path: line.slice("worktree ".length), locked: false });
      const current = worktrees.at(-1);
      if (!current) continue;
      if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length);
      if (line === "locked" || line.startsWith("locked ")) current.locked = true;
    }
    return worktrees;
  }

  /** Deletes an unregistered leftover at `target` (e.g. a worktree whose registration was pruned) unless it holds a checkout. */
  private async discardLeftover(repo: string, target: string): Promise<void> {
    const holdsCheckout =
      existsSync(join(target, ".git")) ||
      (await this.listWorktrees(repo)).some((worktree) => isSameOrInside(canonicalPath(worktree.path), canonicalPath(target)));
    if (holdsCheckout) throw new GitError(`cannot add a worktree at ${target}: it holds a git checkout`);
    this.logger.warn("deleting a leftover directory where a worktree goes", { repo, path: target });
    deleteTree(target);
  }

  /** Deletes the .git of untracked repositories inside the worktree, outermost first (git lists each as "dir/"). */
  private async flattenNestedRepos(cwd: string): Promise<void> {
    const listNested = async () => {
      const untracked = await this.git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], { rootOnly: true });
      return splitNul(untracked).filter((entry) => entry.endsWith("/"));
    };
    for (let nested = await listNested(); nested.length > 0; nested = await listNested()) {
      for (const dir of nested) {
        const dotGit = join(cwd, dir, ".git");
        // Never loops forever: each round deletes at least one .git, or throws.
        if (entryAt(dotGit) === undefined) throw new GitError(`cannot commit ${dir} in ${cwd}: git sees a nested repository there`);
        this.logger.warn("committing a nested repository as plain files: deleting its .git", { cwd, path: dir });
        deleteTree(dotGit);
      }
    }
  }

  /** Which of `paths` (relative to the worktree root `cwd`) exist at `ref`, as files or directories. */
  private async pathsAtRef(cwd: string, ref: string, paths: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of argumentChunks(paths)) {
      // Not recursive: lists each path's own entry, or the entries under it when another path goes deeper.
      const args = ["--literal-pathspecs", "ls-tree", "-z", "--name-only", refArg(ref), "--", ...chunk];
      for (const entry of splitNul(await this.git(cwd, args))) {
        for (let path = entry; path !== "." && !found.has(path); path = dirname(path)) found.add(path);
      }
    }
    return found;
  }
}

/**
 * Explicit controller environment, with prompts/editors disabled and messages in English.
 * With `root`, git looks for the repository in `root` only, not in the directories above it.
 */
function gitEnv(root: string | undefined, launch: ControllerGitOptions): NodeJS.ProcessEnv {
  return controllerGitEnv({ ...launch, ...(root !== undefined && { ceilingDirectory: dirname(canonicalPath(root)) }) });
}

/** Refuses revisions git would read as options: branch names and refs may come from model output. */
function refArg(ref: string): string {
  if (ref === "" || ref.startsWith("-")) throw new GitError(`invalid git revision "${ref}"`);
  return ref;
}

/** `path` (relative to `cwd` or absolute) as a worktree path with forward slashes; throws when it is outside `cwd`. */
function worktreePath(cwd: string, path: string): string {
  const rel = relative(resolve(cwd), resolve(cwd, path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new GitError(`path "${path}" is outside the worktree ${cwd}`);
  }
  return rel.split(sep).join("/");
}

/** Throws when a directory on the way to `path` is a symbolic link: deleting through it could reach outside `cwd`. */
function assertNoLinkOnTheWay(cwd: string, path: string): void {
  let dir = resolve(cwd);
  for (const part of path.split("/").slice(0, -1)) {
    dir = join(dir, part);
    const entry = entryAt(dir);
    if (entry === undefined) return; // nothing further down exists to delete
    if (entry.isSymbolicLink()) throw new GitError(`path "${path}" is beyond a symbolic link in ${cwd}`);
  }
}

/** Splits `paths` into groups that each fit on one command line. */
function argumentChunks(paths: string[]): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (chunk.length > 0 && bytes + size > MAX_PATH_ARG_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(path);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function makeTempDir(): string {
  try {
    return mkdtempSync(join(tmpdir(), "mc-git-diff-"));
  } catch (err) {
    throw new GitError(`could not create a temporary directory for a diff: ${(err as Error).message}`);
  }
}

/** Streams a UTF-8 file: its first `maxChars` characters, how many follow, and its line count as LineSplitter counts. */
async function readHead(file: string, maxChars: number): Promise<{ head: string; omitted: number; lineCount: number }> {
  const decoder = new StringDecoder("utf8");
  let head = "";
  let omitted = 0;
  let newlines = 0;
  let endsWithNewline = true;
  const take = (text: string) => {
    const keep = Math.max(0, Math.min(text.length, maxChars - head.length));
    head += text.slice(0, keep);
    omitted += text.length - keep;
  };
  try {
    for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
      for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, i + 1)) newlines++;
      endsWithNewline = chunk.at(-1) === 0x0a;
      take(decoder.write(chunk));
    }
  } catch (err) {
    throw new GitError(`could not read the diff back from ${file}: ${(err as Error).message}`);
  }
  take(decoder.end());
  return { head, omitted, lineCount: newlines + (endsWithNewline ? 0 : 1) };
}

function deleteTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOTDIR") return; // a parent is a file: nothing there to delete
    throw new GitError(`could not delete ${path}: ${(err as Error).message}`);
  }
}

/** What is at `path`, without following a final symbolic link; undefined when nothing is (or it cannot be reached). */
function entryAt(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function isSameOrInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Real path when it exists (worktree paths may be registered through symlinks), else the absolute path. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function splitNul(text: string): string[] {
  return text.split("\0").filter((entry) => entry !== "");
}

/** The last lines of a command's combined output, for error messages. */
function outputTail(result: SpawnResult): string {
  const lines = `${result.stdout}\n${result.stderr}`.trim().split("\n");
  return lines.slice(-MAX_ERROR_LINES).join("\n");
}

function describeCommand(args: string[]): string {
  const command = args.join(" ");
  return command.length > 200 ? `${command.slice(0, 200)}…` : command;
}

function gitFailure(cwd: string, args: string[], result: SpawnResult): GitError {
  const reason =
    result.spawnError ??
    (result.timedOut ? `timed out after ${result.durationMs} ms` : result.signal ? `killed by ${result.signal}` : `exit code ${result.exitCode}`);
  const output = outputTail(result);
  return new GitError(`git ${describeCommand(args)} failed in ${cwd} (${reason})${output ? `: ${output}` : ""}`, result.stderr);
}
