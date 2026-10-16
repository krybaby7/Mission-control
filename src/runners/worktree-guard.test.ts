import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

// A change of the same size, made in the same second the index was written, is the one change that git's saved file times and sizes cannot
// show. Git guards against it by distrusting any entry whose file time is not older than the index file's own time. The guard works on a
// copy of the index, and a copy made now is newer than every entry, so it lost that protection: under load, with the second boundary falling
// between the change and the copy, the change was taken as no change and a read-only run's edit survived the undo (a flaky failure of
// "undoes edits, deletions, ..." in the full run: `src/app.ts` was missing from the paths that were undone). These tests set the times
// by hand, so they fail every time on the old code and need no luck; `core.checkstat=minimal` and `core.trustctime=false` (set in many
// users' git settings, and in this container's) make git compare only the whole second and the size, so the result does not depend on
// the git build either.
describe("a change of the same size in the same second the index was written", () => {
  const SECOND = 1_700_000_000; // a second long past
  const WRITTEN = SECOND + 0.1; // when app.ts was last written, as the index knows it
  const INDEX_WRITTEN = SECOND + 0.5; // when the index file was written: the same second, a little later
  const CHANGED = SECOND + 0.8; // when app.ts was changed again, with the same number of bytes: the same second, later still
  /** The owner's own unsaved work in app.ts, with as many bytes as the saved version. */
  const WIP = "export const app = 5;\n";
  const saved: Record<string, string | undefined> = {};
  const SETTINGS = { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.checkstat", GIT_CONFIG_VALUE_0: "minimal", GIT_CONFIG_KEY_1: "core.trustctime", GIT_CONFIG_VALUE_1: "false" };

  beforeEach(() => {
    for (const [key, value] of Object.entries(SETTINGS)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterEach(() => {
    for (const key of Object.keys(SETTINGS)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  /** git without the opportunistic rewrite of the index that `git status` does, so a look at the state does not change the index file. */
  function look(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8" }).trim();
  }

  /** app.ts as the index knows it (written at WRITTEN) and the index file with the time INDEX_WRITTEN. Nothing may read the state through `git status` after this. */
  function setTimes(): void {
    utimesSync(join(repo, "src", "app.ts"), WRITTEN, WRITTEN);
    git(repo, "update-index", "--really-refresh");
    utimesSync(join(repo, ".git", "index"), INDEX_WRITTEN, INDEX_WRITTEN);
  }

  function change(text: string): void {
    write(join(repo, "src", "app.ts"), text);
    utimesSync(join(repo, "src", "app.ts"), CHANGED, CHANGED);
  }

  it("is found, and undone, by the guard", async () => {
    const before = state(repo);
    setTimes();
    const snap = await snapshotWorktree(repo);
    change("export const app = 3;\n"); // 22 bytes, as "export const app = 1;\n" is

    expect(await restoreWorktree(snap!)).toEqual(["src/app.ts"]);
    expect(readFileSync(join(repo, "src", "app.ts"), "utf8")).toBe("export const app = 1;\n");
    expect(state(repo)).toEqual(before);
  });

  it("is found by the guard when it was made before the snapshot, so a run that deletes the file cannot take the owner's work with it", async () => {
    setTimes();
    change(WIP); // the owner's own unsaved work, 22 bytes: git sees it, because the index is not older than the file
    const snap = await snapshotWorktree(repo);
    rmSync(join(repo, "src", "app.ts"));

    expect(await restoreWorktree(snap!)).toEqual(["src/app.ts"]);
    expect(readFileSync(join(repo, "src", "app.ts"), "utf8")).toBe(WIP);
  });

  it("puts the index back with the time it had, so git still sees the owner's own change that the run did not touch", async () => {
    setTimes();
    change(WIP);
    const shown = look(repo, "status", "--porcelain=v1");
    expect(shown).toBe("M src/app.ts"); // git sees it, because the index file is not older than app.ts (the trim took the leading space)
    const snap = await snapshotWorktree(repo);

    write(join(repo, "README.md"), "# changed by the run\n");
    git(repo, "add", "README.md"); // the run rewrites the index

    expect(await restoreWorktree(snap!)).toEqual(expect.arrayContaining(["README.md"]));
    expect(look(repo, "status", "--porcelain=v1")).toBe(shown);
    expect(statSync(join(repo, ".git", "index")).mtimeMs).toBeCloseTo(INDEX_WRITTEN * 1000, -1);
  });
});
