import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreWorktree, snapshotWorktree } from "./worktree-guard.js";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

let dir: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8" }).trim();
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** Everything a read-only run must leave as it was. */
function state(cwd: string): Record<string, unknown> {
  return {
    status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all"),
    head: git(cwd, "rev-parse", "HEAD"),
    branch: git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
    staged: git(cwd, "diff", "--cached"),
    unstaged: git(cwd, "diff"),
    files: Object.fromEntries(
      git(cwd, "ls-files", "--cached", "--others", "--exclude-standard")
        .split("\n")
        .filter(Boolean)
        .map((f) => [f, existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), "utf8") : null]),
    ),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-guard-test-"));
  repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  write(join(repo, "src", "app.ts"), "export const app = 1;\n");
  write(join(repo, "README.md"), "# App\n");
  write(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "initial");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("snapshotWorktree / restoreWorktree", () => {
  it("does nothing outside a git working tree", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    expect(await snapshotWorktree(plain)).toBeUndefined();
  });

  it("reports nothing when the run changed nothing", async () => {
    const before = state(repo);
    const snap = await snapshotWorktree(join(repo, "src"));
    expect(snap).toBeDefined();
    expect(await restoreWorktree(snap!)).toEqual([]);
    expect(state(repo)).toEqual(before);
  });

  it("undoes edits, deletions, new files, staged changes and commits", async () => {
    const before = state(repo);
    const snap = await snapshotWorktree(repo);
    write(join(repo, "src", "app.ts"), "export const app = 2; // reviewer 'fix'\n");
    rmSync(join(repo, "README.md"));
    write(join(repo, "src", "new.ts"), "export {};\n");
    write(join(repo, "notes", "todo.md"), "todo\n");
    git(repo, "add", "src/new.ts");
    git(repo, "commit", "-q", "-m", "reviewer commit");
    write(join(repo, "src", "app.ts"), "export const app = 3;\n");

    const undone = await restoreWorktree(snap!);
    expect(undone).toEqual(expect.arrayContaining(["HEAD", "src/app.ts", "README.md", "src/new.ts", "notes/todo.md"]));
    expect(state(repo)).toEqual(before);
  });

  it("restores the uncommitted state the run started from, not the last commit", async () => {
    write(join(repo, "src", "app.ts"), "export const app = 'work in progress';\n");
    write(join(repo, "draft.md"), "draft\n");
    git(repo, "add", "draft.md");
    write(join(repo, "scratch.txt"), "untracked before the run\n");
    const before = state(repo);
    const snap = await snapshotWorktree(repo);

    write(join(repo, "src", "app.ts"), "export const app = 'changed again';\n");
    rmSync(join(repo, "scratch.txt"));
    git(repo, "reset", "-q");
    git(repo, "stash", "-u", "-q");

    expect((await restoreWorktree(snap!)).length).toBeGreaterThan(0);
    expect(state(repo)).toEqual(before);
  });

  it("puts HEAD back on its branch after the run switched branches", async () => {
    const before = state(repo);
    const snap = await snapshotWorktree(repo);
    git(repo, "checkout", "-q", "-b", "elsewhere");
    write(join(repo, "src", "app.ts"), "export const app = 9;\n");
    git(repo, "commit", "-q", "-am", "on another branch");

    expect(await restoreWorktree(snap!)).toContain("HEAD");
    expect(state(repo)).toEqual(before);
  });

  it("guards a linked worktree, whose index lives in the main repository", async () => {
    const wt = join(dir, "unit");
    git(repo, "worktree", "add", "-q", "-b", "unit", wt);
    const before = state(wt);
    const snap = await snapshotWorktree(wt);
    write(join(wt, "src", "app.ts"), "export const app = 5;\n");
    git(wt, "commit", "-q", "-am", "edit in the unit");

    expect(await restoreWorktree(snap!)).toEqual(expect.arrayContaining(["HEAD", "src/app.ts"]));
    expect(state(wt)).toEqual(before);
    expect(state(repo).branch).toBe("main");
  });

  it("leaves files git ignores alone", async () => {
    const snap = await snapshotWorktree(repo);
    write(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    expect(await restoreWorktree(snap!)).toEqual([]);
    expect(existsSync(join(repo, "node_modules", "pkg", "index.js"))).toBe(true);
  });
});
