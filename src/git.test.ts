import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Git, GitError } from "./git.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const savedEnv = { ...process.env };
let configDir: string;
let globalConfig: string;
const tempDirs: string[] = [];
const git = new Git();

// Hermetic git: no system config and an empty global config (the machine's may sign commits or set an identity).
beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "mc-git-config-"));
  globalConfig = join(configDir, "gitconfig");
  writeFileSync(globalConfig, "");
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
    delete process.env[key];
  }
});

afterAll(() => {
  process.env = savedEnv;
  rmSync(configDir, { recursive: true, force: true });
});

afterEach(() => {
  writeFileSync(globalConfig, "");
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-git-"));
  tempDirs.push(dir);
  return dir;
}

/** Raw git for test setup, with a throwaway identity so it works in repos that have none. */
function sh(cwd: string, ...args: string[]): string {
  const setup = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.quotepath=off"];
  return execFileSync("git", [...setup, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(dir: string, rel: string, content: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), "utf8");
}

function commitFile(dir: string, rel: string, content: string, message = `edit ${rel}`): string {
  write(dir, rel, content);
  sh(dir, "add", "--", rel);
  sh(dir, "commit", "-q", "-m", message);
  return sh(dir, "rev-parse", "HEAD").trim();
}

function rev(dir: string, ref: string): string {
  return sh(dir, "rev-parse", ref).trim();
}

function installHook(repo: string, name: string, body: string): void {
  const hook = join(repo, ".git", "hooks", name);
  writeFileSync(hook, `#!/bin/sh\n${body}\n`);
  chmodSync(hook, 0o755);
}

async function newRepo(): Promise<string> {
  const repo = join(tempDir(), "repo");
  await git.ensureRepo(repo);
  return repo;
}

/** A repository created by an agent inside another one (a scaffolder's `git init`), optionally with a commit. */
function nestedRepo(dir: string, files: Record<string, string>, commit: boolean): void {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  if (commit) {
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "scaffold");
  }
}

/** Runs `fn` with a fake `git` first on PATH. */
async function withFakeGit<T>(script: string, fn: () => Promise<T>): Promise<T> {
  const bin = join(tempDir(), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = path;
  }
}

describe("GitError", () => {
  it("carries git's stderr", async () => {
    const repo = await newRepo();
    const error = await git.checkout(repo, "no-such-branch").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).name).toBe("GitError");
    expect((error as GitError).stderr).toMatch(/no-such-branch/);
    expect((error as GitError).message).toMatch(/git checkout/);
  });
});

describe("ensureRepo", () => {
  it("creates missing directories, inits main with a local identity and one empty commit", async () => {
    const repo = join(tempDir(), "a", "b", "app");
    await git.ensureRepo(repo);
    expect(await git.isRepo(repo)).toBe(true);
    expect(await git.currentBranch(repo)).toBe("main");
    expect(sh(repo, "rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(rev(repo, "HEAD^{tree}")).toBe(EMPTY_TREE);
    expect(sh(repo, "config", "--local", "user.name").trim()).toBe("Mission Control");
    expect(sh(repo, "config", "--local", "user.email").trim()).toBe("mission-control@localhost");
  });

  it("honors initialBranch", async () => {
    const repo = join(tempDir(), "app");
    await git.ensureRepo(repo, { initialBranch: "trunk" });
    expect(await git.currentBranch(repo)).toBe("trunk");
  });

  it("is idempotent and leaves an existing repository's history and identity alone", async () => {
    const repo = await newRepo();
    sh(repo, "config", "user.name", "Someone");
    commitFile(repo, "a.txt", "a");
    const head = rev(repo, "HEAD");
    await git.ensureRepo(repo);
    expect(rev(repo, "HEAD")).toBe(head);
    expect(sh(repo, "config", "--local", "user.name").trim()).toBe("Someone");
  });

  it("does not write a local identity when one is configured globally", async () => {
    writeFileSync(globalConfig, "[user]\n\tname = Global\n\temail = global@example.com\n");
    const repo = await newRepo();
    expect(() => sh(repo, "config", "--local", "user.name")).toThrow();
    expect(sh(repo, "log", "-1", "--format=%an").trim()).toBe("Global");
  });

  it("gives a directory inside another repository its own repository", async () => {
    const outer = await newRepo();
    const inner = join(outer, "apps", "inner");
    await git.ensureRepo(inner);
    expect(sh(inner, "rev-parse", "--show-toplevel").trim()).toBe(inner);
    expect(sh(inner, "rev-parse", "--absolute-git-dir").trim()).toBe(join(inner, ".git"));
    expect(await git.isClean(outer)).toBe(false); // the outer repository just sees an untracked directory
  });

  it("adds the initial commit to an initialized repository without commits", async () => {
    const repo = join(tempDir(), "app");
    mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "dev");
    await git.ensureRepo(repo);
    expect(await git.currentBranch(repo)).toBe("dev");
    expect(sh(repo, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });
});

describe("isRepo / isShallow / currentBranch / headSha", () => {
  it("isRepo is true at the root and in subdirectories, false for plain dirs, files and missing paths", async () => {
    const repo = await newRepo();
    mkdirSync(join(repo, "sub"));
    write(repo, "file.txt", "x");
    const plain = tempDir();
    expect(await git.isRepo(repo)).toBe(true);
    expect(await git.isRepo(join(repo, "sub"))).toBe(true);
    expect(await git.isRepo(plain)).toBe(false);
    expect(await git.isRepo(join(repo, "file.txt"))).toBe(false);
    expect(await git.isRepo(join(plain, "missing"))).toBe(false);
  });

  it("isShallow tells a shallow clone from a full repository", async () => {
    const repo = await newRepo();
    commitFile(repo, "a.txt", "1");
    commitFile(repo, "a.txt", "2");
    const clone = join(tempDir(), "clone");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${repo}`, clone], { stdio: "ignore" });
    expect(await git.isShallow(repo)).toBe(false);
    expect(await git.isShallow(clone)).toBe(true);
  });

  it("currentBranch follows checkouts and throws on a detached HEAD", async () => {
    const repo = await newRepo();
    sh(repo, "checkout", "-q", "-b", "feature");
    expect(await git.currentBranch(repo)).toBe("feature");
    sh(repo, "checkout", "-q", "--detach");
    await expect(git.currentBranch(repo)).rejects.toThrow(/detached HEAD/);
  });

  it("currentBranch returns the plain branch name when a tag has the same name", async () => {
    const repo = await newRepo();
    sh(repo, "tag", "main");
    expect(await git.currentBranch(repo)).toBe("main");
  });

  it("headSha resolves HEAD and other refs, and throws for unknown or option-like refs", async () => {
    const repo = await newRepo();
    const first = rev(repo, "HEAD");
    const second = commitFile(repo, "a.txt", "a");
    expect(await git.headSha(repo)).toBe(second);
    expect(await git.headSha(repo, "HEAD~1")).toBe(first);
    expect(await git.headSha(repo, "main")).toBe(second);
    await expect(git.headSha(repo, "nope")).rejects.toThrow(GitError);
    await expect(git.headSha(repo, "--all")).rejects.toThrow(/invalid git revision/);
  });

  it("throws GitError when the directory is not a repository", async () => {
    await expect(git.headSha(tempDir())).rejects.toThrow(GitError);
  });
});

describe("branches", () => {
  it("ensureBranch creates the branch at fromRef and never moves an existing one", async () => {
    const repo = await newRepo();
    const base = rev(repo, "HEAD");
    expect(await git.branchExists(repo, "mc/x")).toBe(false);
    await git.ensureBranch(repo, "mc/x", "main");
    expect(await git.branchExists(repo, "mc/x")).toBe(true);
    expect(rev(repo, "mc/x")).toBe(base);
    commitFile(repo, "a.txt", "a");
    await git.ensureBranch(repo, "mc/x", "main");
    expect(rev(repo, "mc/x")).toBe(base);
  });

  it("branchExists ignores tags and remote-tracking names", async () => {
    const repo = await newRepo();
    sh(repo, "tag", "v1");
    expect(await git.branchExists(repo, "v1")).toBe(false);
    expect(await git.branchExists(repo, "main")).toBe(true);
  });

  it("branchExists takes exact branch names only, not revision syntax", async () => {
    const repo = await newRepo();
    commitFile(repo, "a.txt", "a");
    for (const name of ["main~1", "main@{0}", "main^", "HEAD"]) expect(await git.branchExists(repo, name), name).toBe(false);
    await expect(git.ensureBranch(repo, "main~1", "main")).rejects.toThrow(GitError);
  });

  it("checkout switches branches and refuses unknown ones", async () => {
    const repo = await newRepo();
    await git.ensureBranch(repo, "other", "main");
    await git.checkout(repo, "other");
    expect(await git.currentBranch(repo)).toBe("other");
    await expect(git.checkout(repo, "missing")).rejects.toThrow(GitError);
  });

  it("checkout of a branch named like a file switches the branch, not the file", async () => {
    const repo = await newRepo();
    commitFile(repo, "docs", "content");
    await git.ensureBranch(repo, "docs", "main");
    write(repo, "docs", "changed");
    await git.checkout(repo, "docs");
    expect(await git.currentBranch(repo)).toBe("docs");
    expect(read(repo, "docs")).toBe("changed");
  });
});

describe("worktrees", () => {
  it("addWorktree creates a new branch from fromRef in a new directory", async () => {
    const repo = await newRepo();
    const base = commitFile(repo, "a.txt", "base");
    commitFile(repo, "a.txt", "newer");
    const path = join(tempDir(), "worktrees", "m1", "_integration");
    await git.addWorktree(repo, path, "mc/m1", base);
    expect(read(path, "a.txt")).toBe("base");
    expect(await git.currentBranch(path)).toBe("mc/m1");
    expect(await git.branchExists(repo, "mc/m1")).toBe(true);
  });

  it("addWorktree reuses an existing branch instead of resetting it to fromRef", async () => {
    const repo = await newRepo();
    await git.ensureBranch(repo, "mc/m1--feat", "main");
    sh(repo, "checkout", "-q", "mc/m1--feat");
    const work = commitFile(repo, "feat.txt", "work");
    sh(repo, "checkout", "-q", "main");
    const path = join(tempDir(), "feat");
    await git.addWorktree(repo, path, "mc/m1--feat", "main");
    expect(await git.headSha(path)).toBe(work);
    expect(read(path, "feat.txt")).toBe("work");
  });

  it("addWorktree replaces a worktree already registered at the path", async () => {
    const repo = await newRepo();
    const path = join(tempDir(), "feat");
    await git.addWorktree(repo, path, "mc/a", "main");
    write(path, "scratch.txt", "uncommitted");
    await git.addWorktree(repo, path, "mc/a", "main");
    expect(existsSync(join(path, "scratch.txt"))).toBe(false);
    expect(await git.currentBranch(path)).toBe("mc/a");
  });

  it("addWorktree recovers when a worktree directory was deleted by hand", async () => {
    const repo = await newRepo();
    const root = tempDir();
    const path = join(root, "feat");
    await git.addWorktree(repo, path, "mc/a", "main");
    rmSync(path, { recursive: true, force: true });
    await git.addWorktree(repo, path, "mc/a", "main");
    expect(await git.currentBranch(path)).toBe("mc/a");
    // The branch is still "checked out" in the vanished worktree until pruned; a new path must work too.
    rmSync(path, { recursive: true, force: true });
    const elsewhere = join(root, "elsewhere");
    await git.addWorktree(repo, elsewhere, "mc/a", "main");
    expect(await git.currentBranch(elsewhere)).toBe("mc/a");
  });

  it("addWorktree refuses a branch that is checked out in another live worktree", async () => {
    const repo = await newRepo();
    const root = tempDir();
    await git.addWorktree(repo, join(root, "one"), "mc/a", "main");
    await expect(git.addWorktree(repo, join(root, "two"), "mc/a", "main")).rejects.toThrow(GitError);
  });

  it("removeWorktree removes the directory (with local and ignored files) and its registration", async () => {
    const repo = await newRepo();
    commitFile(repo, ".gitignore", "node_modules/\n");
    const path = join(tempDir(), "feat");
    await git.addWorktree(repo, path, "mc/a", "main");
    write(path, "untracked.txt", "x");
    write(path, "node_modules/pkg/index.js", "x");
    write(path, ".gitignore", "changed\n");
    await git.removeWorktree(repo, path);
    expect(existsSync(path)).toBe(false);
    expect(sh(repo, "worktree", "list", "--porcelain")).not.toContain(path);
    expect(await git.branchExists(repo, "mc/a")).toBe(true);
  });

  it("removeWorktree tolerates missing, already-removed and never-registered paths", async () => {
    const repo = await newRepo();
    const path = join(tempDir(), "feat");
    await git.addWorktree(repo, path, "mc/a", "main");
    rmSync(path, { recursive: true, force: true });
    await git.removeWorktree(repo, path);
    expect(sh(repo, "worktree", "list", "--porcelain")).not.toContain(path);
    await git.removeWorktree(repo, path);
    await git.removeWorktree(repo, join(tempDir(), "never-added"));
  });

  it("removeWorktree never deletes the main worktree", async () => {
    const repo = await newRepo();
    await expect(git.removeWorktree(repo, repo)).rejects.toThrow(GitError);
    expect(await git.isRepo(repo)).toBe(true);
  });

  // `git worktree add` killed mid-checkout leaves its worktree locked with the reason "initializing".
  it("addWorktree and removeWorktree get past a worktree left locked by a crash", async () => {
    const repo = await newRepo();
    const path = join(tempDir(), "feat");
    await git.addWorktree(repo, path, "mc/a", "main");
    sh(repo, "worktree", "lock", "--reason", "initializing", path);
    write(path, "partial.txt", "x");
    await git.addWorktree(repo, path, "mc/a", "main");
    expect(existsSync(join(path, "partial.txt"))).toBe(false);
    expect(await git.currentBranch(path)).toBe("mc/a");
    sh(repo, "worktree", "lock", "--reason", "initializing", path);
    await git.removeWorktree(repo, path);
    expect(existsSync(path)).toBe(false);
    expect(sh(repo, "worktree", "list", "--porcelain")).not.toContain(path);
  });

  it("a locked registration whose directory is gone holds neither its path nor its branch", async () => {
    const repo = await newRepo();
    const root = tempDir();
    const path = join(root, "feat");
    await git.addWorktree(repo, path, "mc/a", "main");
    sh(repo, "worktree", "lock", "--reason", "initializing", path);
    rmSync(path, { recursive: true, force: true });
    const elsewhere = join(root, "elsewhere");
    await git.addWorktree(repo, elsewhere, "mc/a", "main");
    expect(await git.currentBranch(elsewhere)).toBe("mc/a");
    sh(repo, "worktree", "lock", "--reason", "initializing", elsewhere);
    rmSync(elsewhere, { recursive: true, force: true });
    await git.addWorktree(repo, elsewhere, "mc/a", "main");
    expect(await git.currentBranch(elsewhere)).toBe("mc/a");
  });

  it("recovers a worktree whose .git file was deleted, registered or already pruned", async () => {
    const repo = await newRepo();
    const path = join(tempDir(), "feat");
    await git.addWorktree(repo, path, "mc/a", "main");
    rmSync(join(path, ".git"));
    write(path, "work.txt", "x");
    await git.removeWorktree(repo, path);
    expect(existsSync(path)).toBe(false);
    expect(sh(repo, "worktree", "list", "--porcelain")).not.toContain(path);

    await git.addWorktree(repo, path, "mc/a", "main");
    rmSync(join(path, ".git"));
    await git.addWorktree(repo, path, "mc/a", "main");
    expect(await git.currentBranch(path)).toBe("mc/a");

    rmSync(join(path, ".git"));
    sh(repo, "worktree", "prune"); // forgets the registration but leaves the directory
    write(path, "work.txt", "x");
    await git.addWorktree(repo, path, "mc/a", "main");
    expect(await git.currentBranch(path)).toBe("mc/a");
    expect(existsSync(join(path, "work.txt"))).toBe(false);
  });

  it("addWorktree never deletes a directory that holds a checkout", async () => {
    const repo = await newRepo();
    const other = join(tempDir(), "other");
    await git.ensureRepo(other);
    await expect(git.addWorktree(repo, other, "mc/a", "main")).rejects.toThrow(/holds a git checkout/);
    expect(await git.isRepo(other)).toBe(true);
    const unit = join(tempDir(), "worktrees", "feat");
    await git.addWorktree(repo, unit, "mc/b", "main");
    await expect(git.addWorktree(repo, dirname(unit), "mc/c", "main")).rejects.toThrow(/holds a git checkout/);
    await expect(git.addWorktree(repo, dirname(repo), "mc/c", "main")).rejects.toThrow(/holds a git checkout/);
    expect(await git.currentBranch(unit)).toBe("mc/b");
    expect(await git.isRepo(repo)).toBe(true);
  });
});

describe("isClean / commitAll", () => {
  it("isClean sees modified, staged and untracked files but not ignored ones", async () => {
    const repo = await newRepo();
    commitFile(repo, ".gitignore", "ignored/\n");
    commitFile(repo, "a.txt", "a");
    expect(await git.isClean(repo)).toBe(true);
    write(repo, "ignored/x.txt", "x");
    expect(await git.isClean(repo)).toBe(true);
    write(repo, "new.txt", "n");
    expect(await git.isClean(repo)).toBe(false);
    rmSync(join(repo, "new.txt"));
    write(repo, "a.txt", "changed");
    expect(await git.isClean(repo)).toBe(false);
    sh(repo, "add", "a.txt");
    expect(await git.isClean(repo)).toBe(false);
  });

  it("isClean sees untracked files even when the repository's status settings hide them", async () => {
    const repo = await newRepo();
    sh(repo, "config", "status.showUntrackedFiles", "no");
    write(repo, "new.txt", "n");
    expect(await git.isClean(repo)).toBe(false);
  });

  it("commitAll returns null when there is nothing to commit", async () => {
    const repo = await newRepo();
    const head = rev(repo, "HEAD");
    expect(await git.commitAll(repo, "nothing")).toBeNull();
    expect(rev(repo, "HEAD")).toBe(head);
  });

  it("commitAll commits additions, modifications, deletions and untracked files", async () => {
    const repo = await newRepo();
    commitFile(repo, "keep.txt", "1");
    commitFile(repo, "gone.txt", "bye");
    write(repo, "keep.txt", "2");
    rmSync(join(repo, "gone.txt"));
    write(repo, "dir/new file ü.txt", "new");
    const sha = await git.commitAll(repo, "wip(feat): attempt 1");
    expect(sha).toBe(rev(repo, "HEAD"));
    expect(await git.isClean(repo)).toBe(true);
    expect(sh(repo, "show", "--name-status", "--format=", "HEAD").trim().split("\n").sort()).toEqual([
      "A\tdir/new file ü.txt",
      "D\tgone.txt",
      "M\tkeep.txt",
    ]);
    expect(sh(repo, "log", "-1", "--format=%s").trim()).toBe("wip(feat): attempt 1");
  });

  it("commitAll keeps multi-line messages and messages that start with a dash", async () => {
    const repo = await newRepo();
    write(repo, "a.txt", "a");
    await git.commitAll(repo, "-n looks like a flag\n\nbody line\n# not a comment");
    expect(sh(repo, "log", "-1", "--format=%B").trimEnd()).toBe("-n looks like a flag\n\nbody line\n# not a comment");
  });

  it("commitAll skips hooks and commit signing configured in the repository", async () => {
    const repo = await newRepo();
    installHook(repo, "pre-commit", "exit 1");
    installHook(repo, "commit-msg", "exit 1");
    sh(repo, "config", "commit.gpgsign", "true");
    sh(repo, "config", "gpg.program", "false");
    write(repo, "a.txt", "a");
    expect(await git.commitAll(repo, "commit anyway")).toBe(rev(repo, "HEAD"));
  });

  it("commits and merges in a repository without any identity, without writing one to its config", async () => {
    const repo = join(tempDir(), "bare-identity");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    write(repo, "a.txt", "a");
    await git.commitAll(repo, "first");
    sh(repo, "checkout", "-q", "-b", "side");
    write(repo, "b.txt", "b");
    await git.commitAll(repo, "second");
    sh(repo, "checkout", "-q", "main");
    const merged = await git.merge(repo, "side", "merge side");
    expect(merged.ok).toBe(true);
    expect(sh(repo, "log", "-3", "--format=%an <%ae>").trim().split("\n")).toEqual(
      Array(3).fill("Mission Control <mission-control@localhost>"),
    );
    expect(() => sh(repo, "config", "--local", "user.name")).toThrow();
  });

  it("times out a hanging git command with a GitError", async () => {
    const repo = await newRepo();
    sh(repo, "config", "filter.slow.clean", "sleep 10"); // `git add` waits for the filter
    write(repo, ".gitattributes", "*.txt filter=slow\n");
    write(repo, "a.txt", "a");
    const quick = new Git({ timeoutMs: 300 });
    await expect(quick.commitAll(repo, "slow")).rejects.toThrow(/timed out/);
  });

  it("commitAll commits repositories an agent created inside the worktree as plain files", async () => {
    const repo = await newRepo();
    nestedRepo(join(repo, "web"), { "index.js": "app" }, true);
    nestedRepo(join(repo, "web", "vendor", "lib"), { "lib.js": "lib" }, false); // nested in a nested one
    nestedRepo(join(repo, "packages", "fresh"), { "a.js": "a" }, false); // no commit: `git add` would fail
    expect(await git.changedFiles(repo, "HEAD")).toEqual(["packages/fresh/", "web/"]);
    await git.commitAll(repo, "scaffold");
    expect(sh(repo, "ls-tree", "-r", "HEAD").trim().split("\n").map((line) => line.split("\t")[1])).toEqual([
      "packages/fresh/a.js",
      "web/index.js",
      "web/vendor/lib/lib.js",
    ]);
    expect(sh(repo, "ls-tree", "-r", "HEAD")).not.toContain("160000"); // no gitlinks
    expect(existsSync(join(repo, "web", ".git"))).toBe(false);
    expect(await git.isClean(repo)).toBe(true);
  });

  it("commitAll leaves ignored nested repositories alone", async () => {
    const repo = await newRepo();
    commitFile(repo, ".gitignore", "vendor/\n");
    nestedRepo(join(repo, "vendor", "dep"), { "dep.js": "dep" }, true);
    write(repo, "a.txt", "a");
    await git.commitAll(repo, "work");
    expect(existsSync(join(repo, "vendor", "dep", ".git"))).toBe(true);
    expect(sh(repo, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n")).toEqual([".gitignore", "a.txt"]);
  });

  it("never falls through to an enclosing repository when a worktree lost its .git", async () => {
    const outer = await newRepo();
    write(outer, "precious.txt", "untracked in the outer repository");
    const lost = join(outer, "worktrees", "feat");
    write(lost, "work.txt", "x");
    const head = rev(outer, "HEAD");
    await expect(git.commitAll(lost, "wip")).rejects.toThrow(/not a git repository/);
    await expect(git.resetHard(lost, "HEAD")).rejects.toThrow(/not a git repository/);
    await expect(git.restorePaths(lost, "HEAD", ["work.txt"])).rejects.toThrow(/not a git repository/);
    expect(await git.merge(lost, "main", "merge")).toMatchObject({ ok: false, conflict: false });
    expect(rev(outer, "HEAD")).toBe(head);
    expect(sh(outer, "status", "--porcelain")).toBe("?? precious.txt\n?? worktrees/\n");
    expect(read(lost, "work.txt")).toBe("x");
  });
});

describe("changedFiles", () => {
  it("lists committed, staged, unstaged, deleted, renamed and untracked files, repo-relative and sorted", async () => {
    const repo = await newRepo();
    commitFile(repo, ".gitignore", "ignored/\n");
    commitFile(repo, "committed.txt", "1");
    commitFile(repo, "staged.txt", "1");
    commitFile(repo, "unstaged.txt", "1");
    commitFile(repo, "deleted.txt", "1");
    commitFile(repo, "old-name.txt", "rename me");
    commitFile(repo, "same.txt", "1");
    const base = rev(repo, "HEAD");
    commitFile(repo, "committed.txt", "2");
    write(repo, "staged.txt", "2");
    sh(repo, "add", "staged.txt");
    write(repo, "unstaged.txt", "2");
    rmSync(join(repo, "deleted.txt"));
    sh(repo, "mv", "old-name.txt", "new-name.txt");
    write(repo, "tests/ü ber.test.ts", "untracked");
    write(repo, "ignored/skip.txt", "ignored");
    const expected = [
      "committed.txt",
      "deleted.txt",
      "new-name.txt",
      "old-name.txt",
      "staged.txt",
      "tests/ü ber.test.ts",
      "unstaged.txt",
    ];
    expect(await git.changedFiles(repo, base)).toEqual(expected);
    mkdirSync(join(repo, "sub"));
    expect(await git.changedFiles(join(repo, "sub"), base)).toEqual(expected);
  });

  it("returns an empty list when nothing changed", async () => {
    const repo = await newRepo();
    expect(await git.changedFiles(repo, "HEAD")).toEqual([]);
  });

  it("does not quote unusual file names", async () => {
    const repo = await newRepo();
    write(repo, 'quote"tab\there.txt', "x");
    expect(await git.changedFiles(repo, "HEAD")).toEqual(['quote"tab\there.txt']);
  });

  it("fails rather than return a partial list when the output exceeds maxOutputBytes", async () => {
    const repo = await newRepo();
    for (let i = 0; i < 100; i++) write(repo, `${String(i).padStart(3, "0")}-${"x".repeat(60)}.ts`, "x");
    await expect(new Git({ maxOutputBytes: 4096 }).changedFiles(repo, "HEAD")).rejects.toThrow(/more than 4096 bytes/);
    expect(await new Git({ maxOutputBytes: 64 * 1024 }).changedFiles(repo, "HEAD")).toHaveLength(100);
  });
});

describe("diff", () => {
  it("diffs two refs and a ref against the working tree", async () => {
    const repo = await newRepo();
    const base = commitFile(repo, "a.txt", "one\n");
    const next = commitFile(repo, "a.txt", "one\ntwo\n");
    const between = await git.diff(repo, base, next);
    expect(between).toContain("diff --git a/a.txt b/a.txt");
    expect(between).toContain("+two");
    write(repo, "a.txt", "one\ntwo\nthree\n");
    const working = await git.diff(repo, next);
    expect(working).toContain("+three");
    expect(working).not.toContain("+two");
    expect(await git.diff(repo, next, next)).toBe("");
  });

  it("keeps the standard a/ b/ prefixes and reports renames as delete + add whatever the config says", async () => {
    const repo = await newRepo();
    sh(repo, "config", "diff.noprefix", "true");
    sh(repo, "config", "diff.renames", "true");
    const base = commitFile(repo, "tests/a.test.ts", "expect(1).toBe(1);\n");
    mkdirSync(join(repo, "src"));
    sh(repo, "mv", "tests/a.test.ts", "src/a.ts");
    sh(repo, "commit", "-q", "-m", "move");
    const out = await git.diff(repo, base, "HEAD");
    expect(out).toContain("diff --git a/tests/a.test.ts b/tests/a.test.ts");
    expect(out).toContain("-expect(1).toBe(1);");
    expect(out).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(out).not.toContain("rename from");
  });

  it("truncates to maxChars with a marker that counts the omitted characters", async () => {
    const repo = await newRepo();
    const base = rev(repo, "HEAD");
    write(repo, "big.txt", Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n");
    await git.commitAll(repo, "big");
    const full = await git.diff(repo, base, "HEAD");
    const cut = await git.diff(repo, base, "HEAD", 100);
    expect(cut.startsWith(full.slice(0, 100))).toBe(true);
    expect(cut.endsWith(`[diff truncated: ${full.length - 100} chars omitted]\n`)).toBe(true);
    expect(cut.length).toBeLessThan(160);
    expect(await git.diff(repo, base, "HEAD", full.length)).toBe(full);
  });

  it("throws for an unknown ref", async () => {
    const repo = await newRepo();
    await expect(git.diff(repo, "does-not-exist")).rejects.toThrow(GitError);
  });

  it("returns git's output byte for byte, carriage returns included", async () => {
    const repo = await newRepo();
    const base = commitFile(repo, "win.txt", "one\ntwo\n");
    commitFile(repo, "win.txt", "one\r\ntwo\r\n");
    const raw = sh(repo, "diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", base, "HEAD");
    const out = await git.diff(repo, base, "HEAD");
    expect(out).toContain("-one\n-two\n+one\r\n+two\r\n");
    expect(out).toBe(raw);
    expect(await git.diff(repo, base, "HEAD", 10)).toBe(`${raw.slice(0, 10)}\n[diff truncated: ${raw.length - 10} chars omitted]\n`);
  });

  it("names non-ASCII files verbatim in its headers", async () => {
    const repo = await newRepo();
    const base = rev(repo, "HEAD");
    write(repo, "dir/über.txt", "x\n");
    await git.commitAll(repo, "add");
    const out = await git.diff(repo, base, "HEAD");
    expect(out).toContain("diff --git a/dir/über.txt b/dir/über.txt\n");
    expect(out).toContain("+++ b/dir/über.txt\n");
  });
});

describe("restorePaths / resetHard", () => {
  it("restores files from ref and deletes files that do not exist there", async () => {
    const repo = await newRepo();
    commitFile(repo, "tests/a.test.ts", "frozen");
    const base = commitFile(repo, "src/x.ts", "original");
    write(repo, "tests/a.test.ts", "tampered");
    rmSync(join(repo, "src/x.ts"));
    write(repo, "src/new.ts", "untracked");
    write(repo, "src/staged.ts", "staged");
    sh(repo, "add", "src/staged.ts");
    await git.commitAll(repo, "agent work");
    write(repo, "src/after.ts", "uncommitted");
    await git.restorePaths(repo, base, ["tests/a.test.ts", "src/x.ts", "src/new.ts", "src/staged.ts", "src/after.ts"]);
    expect(read(repo, "tests/a.test.ts")).toBe("frozen");
    expect(read(repo, "src/x.ts")).toBe("original");
    for (const gone of ["src/new.ts", "src/staged.ts", "src/after.ts"]) expect(existsSync(join(repo, gone))).toBe(false);
    await git.commitAll(repo, "revert");
    expect(await git.changedFiles(repo, base)).toEqual([]);
  });

  it("treats paths literally rather than as globs", async () => {
    const repo = await newRepo();
    commitFile(repo, "t*.ts", "star");
    const base = commitFile(repo, "tx.ts", "x");
    write(repo, "t*.ts", "changed");
    write(repo, "tx.ts", "changed");
    write(repo, "ty.ts", "untracked");
    await git.restorePaths(repo, base, ["t*.ts"]);
    expect(read(repo, "t*.ts")).toBe("star");
    expect(read(repo, "tx.ts")).toBe("changed");
    expect(existsSync(join(repo, "ty.ts"))).toBe(true);
  });

  it("restores a directory that exists at ref instead of deleting it", async () => {
    const repo = await newRepo();
    const base = commitFile(repo, "src/a.ts", "a");
    write(repo, "src/a.ts", "changed");
    await git.restorePaths(repo, base, ["src"]);
    expect(read(repo, "src/a.ts")).toBe("a");
  });

  it("refuses paths outside the worktree and does nothing for an empty list", async () => {
    const repo = await newRepo();
    const outside = join(dirname(repo), "outside.txt");
    writeFileSync(outside, "keep");
    await expect(git.restorePaths(repo, "HEAD", ["../outside.txt"])).rejects.toThrow(/outside the worktree/);
    await expect(git.restorePaths(repo, "HEAD", [outside])).rejects.toThrow(/outside the worktree/);
    expect(read(dirname(repo), "outside.txt")).toBe("keep");
    await git.restorePaths(repo, "no-such-ref", []);
  });

  it("accepts any spelling of a path inside the worktree", async () => {
    const repo = await newRepo();
    commitFile(repo, "tests/t.test.ts", "t");
    const base = commitFile(repo, "src/x.ts", "orig");
    for (const spelling of ["./src/x.ts", "src//x.ts", "src/../src/x.ts", join(repo, "src", "x.ts"), "src/", "./src"]) {
      write(repo, "src/x.ts", "tampered");
      await git.restorePaths(repo, base, [spelling]);
      expect(read(repo, "src/x.ts"), spelling).toBe("orig");
      expect(sh(repo, "status", "--porcelain"), spelling).toBe("");
    }
    write(repo, "tests/t.test.ts", "tampered");
    write(repo, "tests/extra.test.ts", "untracked");
    await git.restorePaths(repo, base, ["tests/", "./tests/extra.test.ts", join(repo, "src", "new.ts")]);
    expect(read(repo, "tests/t.test.ts")).toBe("t");
    expect(existsSync(join(repo, "tests/extra.test.ts"))).toBe(false);
  });

  it("looks up only the requested paths at ref, however large the tree", async () => {
    const repo = await newRepo();
    for (let i = 0; i < 100; i++) write(repo, `files/${String(i).padStart(3, "0")}-${"x".repeat(60)}.ts`, "x");
    write(repo, "0-first.ts", "orig");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "many files");
    write(repo, "0-first.ts", "tampered");
    await new Git({ maxOutputBytes: 4096 }).restorePaths(repo, "HEAD", ["0-first.ts"]); // all names: ~7 KB
    expect(read(repo, "0-first.ts")).toBe("orig");
  });

  it("handles more paths than fit on one command line", { timeout: 60_000 }, async () => {
    const repo = await newRepo();
    // Restored and deleted paths each take ~2.2 MB, beyond Linux's 2 MiB limit on one command's arguments.
    const dir = ["d", "e", "f"].map((letter) => letter.repeat(240)).join("/");
    const names = Array.from({ length: 4800 }, (_, i) => `${dir}/${String(i).padStart(4, "0")}-${"g".repeat(200)}.txt`);
    const tracked = names.slice(0, 2400);
    const untracked = names.slice(2400);
    for (const name of tracked) write(repo, name, "orig");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "tracked");
    const base = rev(repo, "HEAD");
    for (const name of tracked) write(repo, name, "tampered");
    for (const name of untracked) write(repo, name, "new");
    await git.restorePaths(repo, base, names);
    expect(readdirSync(join(repo, dir)).sort()).toEqual(tracked.map((name) => name.slice(dir.length + 1)));
    expect(read(repo, tracked[0] ?? "")).toBe("orig");
    expect(read(repo, tracked.at(-1) ?? "")).toBe("orig");
    expect(sh(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses to delete through a symbolic link that leaves the worktree", async () => {
    const repo = await newRepo();
    const outside = join(dirname(repo), "outside");
    write(outside, "victim.txt", "keep");
    symlinkSync(outside, join(repo, "link"));
    await expect(git.restorePaths(repo, "HEAD", ["new.txt", "link/victim.txt"])).rejects.toThrow(/symbolic link/);
    expect(read(outside, "victim.txt")).toBe("keep");
    await git.restorePaths(repo, "HEAD", ["link"]); // the link itself is an ordinary untracked path
    expect(existsSync(join(repo, "link"))).toBe(false);
    expect(read(outside, "victim.txt")).toBe("keep");
  });

  it("restores a file whose directory an agent replaced with a link, without writing through the link", async () => {
    const repo = await newRepo();
    const base = commitFile(repo, "tests/a.test.ts", "frozen");
    const outside = join(dirname(repo), "outside");
    write(outside, "a.test.ts", "outside");
    rmSync(join(repo, "tests"), { recursive: true });
    symlinkSync(outside, join(repo, "tests"));
    await git.restorePaths(repo, base, ["tests/a.test.ts"]);
    expect(lstatSync(join(repo, "tests")).isDirectory()).toBe(true);
    expect(read(repo, "tests/a.test.ts")).toBe("frozen");
    expect(read(outside, "a.test.ts")).toBe("outside");
  });

  it("deletes nothing for a path under a file", async () => {
    const repo = await newRepo();
    const base = commitFile(repo, "a.txt", "a");
    await git.restorePaths(repo, base, ["a.txt/child"]);
    expect(read(repo, "a.txt")).toBe("a");
  });

  it("resetHard also removes nested repositories an agent created", async () => {
    const repo = await newRepo();
    nestedRepo(join(repo, "web"), { "index.js": "app" }, true);
    nestedRepo(join(repo, "fresh"), { "a.js": "a" }, false);
    await git.resetHard(repo, "HEAD");
    expect(existsSync(join(repo, "web"))).toBe(false);
    expect(existsSync(join(repo, "fresh"))).toBe(false);
    expect(await git.isClean(repo)).toBe(true);
  });

  it("resetHard restores tracked files and removes untracked ones but keeps ignored files", async () => {
    const repo = await newRepo();
    commitFile(repo, ".gitignore", "node_modules/\n");
    const base = commitFile(repo, "a.txt", "a");
    commitFile(repo, "b.txt", "later");
    write(repo, "a.txt", "dirty");
    write(repo, "untracked/deep/file.txt", "x");
    write(repo, "loose.txt", "x");
    write(repo, "node_modules/pkg/index.js", "kept");
    await git.resetHard(repo, base);
    expect(rev(repo, "HEAD")).toBe(base);
    expect(read(repo, "a.txt")).toBe("a");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    expect(existsSync(join(repo, "untracked"))).toBe(false);
    expect(existsSync(join(repo, "loose.txt"))).toBe(false);
    expect(read(repo, "node_modules/pkg/index.js")).toBe("kept");
  });
});

describe("merge", () => {
  /** A repo with an integration worktree on mc/m and a unit branch mc/m--f, both starting at the same commit. */
  async function setup(): Promise<{ repo: string; integration: string; unit: string }> {
    const repo = await newRepo();
    commitFile(repo, "shared.txt", "base\n");
    const root = tempDir();
    const integration = join(root, "_integration");
    const unit = join(root, "f");
    await git.addWorktree(repo, integration, "mc/m", "main");
    await git.addWorktree(repo, unit, "mc/m--f", "mc/m");
    return { repo, integration, unit };
  }

  it("creates a merge commit with the given message", async () => {
    const { integration, unit } = await setup();
    write(unit, "feature.txt", "feature");
    const unitHead = await git.commitAll(unit, "feat work");
    write(integration, "other.txt", "other");
    const integrationHead = await git.commitAll(integration, "other work");
    const result = await git.merge(integration, "mc/m--f", "feat(f): The feature");
    expect(result).toEqual({ ok: true, sha: rev(integration, "HEAD") });
    expect(sh(integration, "log", "-1", "--format=%P").trim().split(" ")).toEqual([integrationHead, unitHead]);
    expect(sh(integration, "log", "-1", "--format=%s").trim()).toBe("feat(f): The feature");
    expect(read(integration, "feature.txt")).toBe("feature");
  });

  it("still creates a merge commit when a fast-forward would be possible (--no-ff)", async () => {
    const { integration, unit } = await setup();
    write(unit, "feature.txt", "feature");
    await git.commitAll(unit, "feat work");
    const result = await git.merge(integration, "mc/m--f", "feat(f): ff");
    expect(result.ok).toBe(true);
    expect(sh(integration, "log", "-1", "--format=%P").trim().split(" ")).toHaveLength(2);
  });

  it("ignores pre-merge-commit and commit-msg hooks", async () => {
    const { repo, integration, unit } = await setup();
    installHook(repo, "pre-merge-commit", "exit 1");
    installHook(repo, "commit-msg", "exit 1");
    write(unit, "feature.txt", "feature");
    await git.commitAll(unit, "feat work");
    expect((await git.merge(integration, "mc/m--f", "merge")).ok).toBe(true);
  });

  it("reports a conflict and aborts the merge, leaving the worktree clean", async () => {
    const { integration, unit } = await setup();
    write(unit, "shared.txt", "unit\n");
    await git.commitAll(unit, "unit edit");
    write(integration, "shared.txt", "integration\n");
    const before = await git.commitAll(integration, "integration edit");
    const result = await git.merge(integration, "mc/m--f", "feat(f): conflict");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict).toBe(true);
    expect(result.error).toMatch(/CONFLICT/);
    expect(rev(integration, "HEAD")).toBe(before);
    expect(await git.isClean(integration)).toBe(true);
    expect(() => sh(integration, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toThrow();
    expect(read(integration, "shared.txt")).toBe("integration\n");
  });

  it("reports other failures as non-conflicts", async () => {
    const { integration, unit } = await setup();
    const unknown = await git.merge(integration, "mc/does-not-exist", "merge");
    expect(unknown).toMatchObject({ ok: false, conflict: false });
    write(unit, "shared.txt", "unit\n");
    await git.commitAll(unit, "unit edit");
    write(integration, "shared.txt", "uncommitted local edit\n");
    const dirty = await git.merge(integration, "mc/m--f", "merge");
    expect(dirty).toMatchObject({ ok: false, conflict: false });
    if (!dirty.ok) expect(dirty.error).toMatch(/overwritten/);
    expect(read(integration, "shared.txt")).toBe("uncommitted local edit\n");
  });

  it("aborts a merge left in progress (e.g. by a crash) instead of reporting it as a conflict", async () => {
    const { repo, integration, unit } = await setup();
    write(unit, "shared.txt", "unit\n");
    await git.commitAll(unit, "unit edit");
    write(integration, "shared.txt", "integration\n");
    await git.commitAll(integration, "integration edit");
    expect(() => sh(integration, "merge", "--no-edit", "mc/m--f")).toThrow(); // conflicted and never aborted
    const other = join(tempDir(), "g");
    await git.addWorktree(repo, other, "mc/m--g", "mc/m");
    write(other, "g.txt", "g");
    await git.commitAll(other, "g work");
    const result = await git.merge(integration, "mc/m--g", "feat(g): G");
    expect(result.ok).toBe(true);
    expect(read(integration, "shared.txt")).toBe("integration\n");
    expect(read(integration, "g.txt")).toBe("g");
  });

  it("succeeds without a new commit when already up to date", async () => {
    const { integration } = await setup();
    const head = rev(integration, "HEAD");
    expect(await git.merge(integration, "mc/m--f", "noop")).toEqual({ ok: true, sha: head });
  });
});

describe("fastForward", () => {
  /** main at the initial commit; mc/m two commits ahead, in a linked integration worktree. */
  async function setup(): Promise<{ repo: string; integration: string; tip: string }> {
    const repo = await newRepo();
    const integration = join(tempDir(), "_integration");
    await git.addWorktree(repo, integration, "mc/m", "main");
    write(integration, "app.js", "v1");
    await git.commitAll(integration, "one");
    write(integration, "app.js", "v2");
    const tip = (await git.commitAll(integration, "two")) ?? "";
    return { repo, integration, tip };
  }

  it("fast-forwards a branch checked out in the repo and updates its files", async () => {
    const { repo, tip } = await setup();
    await git.fastForward(repo, "main", "mc/m");
    expect(rev(repo, "main")).toBe(tip);
    expect(read(repo, "app.js")).toBe("v2");
    expect(await git.isClean(repo)).toBe(true);
  });

  it("moves a branch that is not checked out without touching the current checkout", async () => {
    const { repo, tip } = await setup();
    sh(repo, "checkout", "-q", "-b", "parking");
    await git.fastForward(repo, "main", "mc/m");
    expect(rev(repo, "main")).toBe(tip);
    expect(await git.currentBranch(repo)).toBe("parking");
    expect(existsSync(join(repo, "app.js"))).toBe(false);
  });

  it("fast-forwards a branch checked out in a linked worktree there", async () => {
    const { repo, integration, tip } = await setup();
    const unit = join(tempDir(), "unit");
    await git.addWorktree(repo, unit, "mc/m--f", "main");
    await git.fastForward(repo, "mc/m--f", "mc/m");
    expect(rev(repo, "mc/m--f")).toBe(tip);
    expect(read(unit, "app.js")).toBe("v2");
    expect(rev(integration, "HEAD")).toBe(tip);
  });

  it("is a no-op when the branch already contains toRef", async () => {
    const { repo, tip } = await setup();
    await git.fastForward(repo, "main", "mc/m");
    await git.fastForward(repo, "main", "main~1");
    expect(rev(repo, "main")).toBe(tip);
  });

  it("refuses diverged histories and leaves the branch alone", async () => {
    const { repo } = await setup();
    const local = commitFile(repo, "local.txt", "main-only");
    await expect(git.fastForward(repo, "main", "mc/m")).rejects.toThrow(/cannot fast-forward/);
    expect(rev(repo, "main")).toBe(local);
  });
});

describe("remotes and push", () => {
  async function withRemote(): Promise<{ repo: string; remote: string }> {
    const repo = await newRepo();
    const remote = join(tempDir(), "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    sh(repo, "remote", "add", "origin", remote);
    return { repo, remote };
  }

  it("hasRemote checks origin by default, or a named remote", async () => {
    const repo = await newRepo();
    expect(await git.hasRemote(repo)).toBe(false);
    sh(repo, "remote", "add", "upstream", "/nowhere");
    expect(await git.hasRemote(repo)).toBe(false);
    expect(await git.hasRemote(repo, "upstream")).toBe(true);
    sh(repo, "remote", "add", "origin", "/nowhere");
    expect(await git.hasRemote(repo)).toBe(true);
  });

  it("refuses branches outside the prefix before touching the network", async () => {
    const { repo, remote } = await withRemote();
    await git.ensureBranch(repo, "mcx/feature", "main");
    for (const branch of ["main", "mcx/feature", "feature/mc/x"]) {
      const result = await git.push(repo, branch, "mc");
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/refusing to push/);
    }
    expect(sh(remote, "for-each-ref").trim()).toBe("");
  });

  it('returns "no remote" when origin is missing', async () => {
    const repo = await newRepo();
    await git.ensureBranch(repo, "mc/m", "main");
    expect(await git.push(repo, "mc/m", "mc")).toEqual({ ok: false, error: "no remote" });
  });

  it("pushes a prefixed branch under the same name", async () => {
    const { repo, remote } = await withRemote();
    await git.ensureBranch(repo, "mc/m", "main");
    expect(await git.push(repo, "mc/m", "mc")).toEqual({ ok: true });
    expect(rev(remote, "refs/heads/mc/m")).toBe(rev(repo, "mc/m"));
  });

  it("never force-pushes: a non-fast-forward push fails and leaves the remote alone", async () => {
    const { repo, remote } = await withRemote();
    sh(repo, "checkout", "-q", "-b", "mc/m");
    commitFile(repo, "a.txt", "pushed");
    expect((await git.push(repo, "mc/m", "mc")).ok).toBe(true);
    const pushed = rev(remote, "refs/heads/mc/m");
    sh(repo, "reset", "-q", "--hard", "HEAD~1");
    commitFile(repo, "a.txt", "rewritten");
    const result = await git.push(repo, "mc/m", "mc");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rejected|fetch first|non-fast-forward/);
    expect(rev(remote, "refs/heads/mc/m")).toBe(pushed);
  });

  it("runs the repository's pre-push hook and returns its failure", async () => {
    const { repo, remote } = await withRemote();
    installHook(repo, "pre-push", "echo 'pre-push says no' >&2; exit 1");
    await git.ensureBranch(repo, "mc/m", "main");
    const result = await git.push(repo, "mc/m", "mc");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pre-push says no/);
    expect(sh(remote, "for-each-ref").trim()).toBe("");
  });

  it("returns the error when the remote is unreachable", async () => {
    const repo = await newRepo();
    sh(repo, "remote", "add", "origin", join(tempDir(), "missing.git"));
    await git.ensureBranch(repo, "mc/m", "main");
    const result = await git.push(repo, "mc/m", "mc");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("log", () => {
  it("lists commits in a range, newest first, honoring max", async () => {
    const repo = await newRepo();
    const base = rev(repo, "HEAD");
    const one = commitFile(repo, "a.txt", "1", "feat: one | with pipe");
    const two = commitFile(repo, "a.txt", "2", "fix: twö\n\nbody is not part of the subject");
    expect(await git.log(repo, `${base}..HEAD`)).toEqual([
      { sha: two, subject: "fix: twö" },
      { sha: one, subject: "feat: one | with pipe" },
    ]);
    expect(await git.log(repo, "HEAD", 1)).toEqual([{ sha: two, subject: "fix: twö" }]);
    expect(await git.log(repo, "HEAD..HEAD")).toEqual([]);
  });

  it("keeps subjects holding carriage returns or Unicode line separators", async () => {
    const repo = await newRepo();
    const one = commitFile(repo, "a.txt", "1", "feat: a\u2028b");
    const two = commitFile(repo, "a.txt", "2", "feat: c\rd \u2029e");
    write(repo, "a.txt", "3");
    const three = await git.commitAll(repo, "feat(x): title\u2028with separator");
    expect(await git.log(repo, "HEAD", 3)).toEqual([
      { sha: three, subject: "feat(x): title\u2028with separator" },
      { sha: two, subject: "feat: c\rd \u2029e" },
      { sha: one, subject: "feat: a\u2028b" },
    ]);
  });

  it("ignores extra output such as signature checks", async () => {
    const repo = await newRepo();
    sh(repo, "config", "log.showSignature", "true");
    expect(await git.log(repo, "HEAD")).toEqual([{ sha: rev(repo, "HEAD"), subject: "Initial commit" }]);
  });
});

describe("environment", () => {
  it("ignores GIT_DIR / GIT_INDEX_FILE inherited from a git hook", async () => {
    const repo = await newRepo();
    const other = await newRepo();
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_INDEX_FILE = join(other, ".git", "index");
    try {
      write(repo, "a.txt", "a");
      await git.commitAll(repo, "in the right repo");
      expect(await git.log(repo, "HEAD", 1)).toEqual([{ sha: expect.any(String), subject: "in the right repo" }]);
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_INDEX_FILE;
    }
    expect(sh(other, "log", "-1", "--format=%s").trim()).toBe("Initial commit");
  });

  it("runs git with quotepath off, no terminal prompts, no editor and no hooks", async () => {
    const repo = await newRepo();
    const record = join(tempDir(), "record");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const script = `printf '%s\\n' "$@" > "${record}.args"; env > "${record}.env"; exec "${realGit}" "$@"`;
    await withFakeGit(script, () => git.isClean(repo));
    const args = readFileSync(`${record}.args`, "utf8");
    expect(args).toMatch(/^(-c\n[^\n]+\n)*-c\ncore\.quotepath=off\n(-c\n[^\n]+\n)*status\n/);
    expect(args).toMatch(/^(-c\n[^\n]+\n)*-c\ncore\.hooksPath=\/dev\/null\n(-c\n[^\n]+\n)*status\n/);
    const env = readFileSync(`${record}.env`, "utf8").split("\n");
    expect(env).toContain("GIT_TERMINAL_PROMPT=0");
    expect(env).toContain("GIT_EDITOR=true");
  });

  it("never runs repository hooks, which could fail or hang after an operation took effect", async () => {
    const repo = await newRepo();
    const ran = join(tempDir(), "hooks-ran");
    for (const name of ["pre-commit", "post-commit", "post-checkout", "post-merge", "reference-transaction"]) {
      installHook(repo, name, `echo ${name} >> "${ran}"; sleep 5; exit 2`);
    }
    write(repo, "a.txt", "a");
    await git.commitAll(repo, "commit");
    await git.ensureBranch(repo, "other", "main");
    await git.checkout(repo, "other");
    await git.checkout(repo, "main");
    const unit = join(tempDir(), "unit");
    await git.addWorktree(repo, unit, "mc/a", "main");
    write(unit, "b.txt", "b");
    await git.commitAll(unit, "unit");
    expect((await git.merge(repo, "mc/a", "merge")).ok).toBe(true);
    await git.resetHard(repo, "HEAD~1");
    await git.removeWorktree(repo, unit);
    expect(existsSync(ran)).toBe(false);
  });

  it("reports a missing git binary as a GitError", async () => {
    const repo = await newRepo();
    const path = process.env.PATH;
    process.env.PATH = join(tempDir(), "empty-bin");
    try {
      await expect(git.isClean(repo)).rejects.toThrow(/git not found/);
    } finally {
      process.env.PATH = path;
    }
  });
});
