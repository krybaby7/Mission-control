import { execFileSync } from "node:child_process";
import { controllerGitEnv } from "./util/launch-env.js";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Git } from "./git.js";
import { captureWorktree, captureCommittedTree } from "./work-capture.js";
import * as processes from "./util/process.js";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(format?: "sha256") {
  const root = mkdtempSync(join(tmpdir(), "mc-capture-")); roots.push(root);
  if (format) execFileSync("git", ["init", "--object-format=" + format, "--initial-branch=capture-fixture"], { cwd: root, env: controllerGitEnv(), stdio: "pipe" });
  const git = new Git(); await git.ensureRepo(root, { initialBranch: "capture-fixture" }); return { root, git };
}
const scope = { kind: "feature", featureId: "greet" } as const;
describe("bounded worktree capture", () => {
  it("rejects a new source path appearing during the final HEAD observation", async () => {
    const { root } = await fixture(); const original = processes.runProcess; let heads = 0;
    vi.spyOn(processes, "runProcess").mockImplementation(async spec => {
      const result = await original(spec);
      if (spec.args.includes("--verify") && ++heads === 2) writeFileSync(join(root, "late"), "late bytes");
      return result;
    });
    const result = await captureWorktree(root, scope);
    expect(result.complete).toBe(false); expect(result.files).toEqual([]);
  });
  it.each([{ kind: "feature", featureId: "" }, { kind: "feature", featureId: "bad\nname" }, { kind: "application", featureId: "stray" }, { kind: "other" }, { kind: "feature", featureId: "good", extra: true }])("rejects malformed scope %j before running Git", async raw => {
    const { root } = await fixture(); const run = vi.spyOn(processes, "runProcess");
    expect((await captureWorktree(root, raw as typeof scope)).complete).toBe(false); expect(run).not.toHaveBeenCalled();
  });
  it("uses the Git owner executable bit rather than group/other execute bits", async () => {
    const { root } = await fixture(); writeFileSync(join(root, "a"), "bytes"); chmodSync(join(root, "a"), 0o641);
    expect((await captureWorktree(root, scope)).files[0]?.mode).toBe("100644");
  });
  it.each([{ maxFiles: 0 }, { maxFileBytes: NaN }, { maxTotalBytes: -1 }, { timeoutMs: 30_001 }, { timeoutMs: undefined }])("rejects invalid options %j before Git", async limits => {
    const { root } = await fixture(); const run = vi.spyOn(processes, "runProcess");
    expect((await captureWorktree(root, scope, limits)).complete).toBe(false); expect(run).not.toHaveBeenCalled();
  });
  it("honors cancellation before any command", async () => {
    const { root } = await fixture(); const controller = new AbortController(); controller.abort();
    const run = vi.spyOn(processes, "runProcess");
    expect((await captureWorktree(root, scope, { signal: controller.signal })).complete).toBe(false); expect(run).not.toHaveBeenCalled();
  });
  it("uses monotonic duration even if wall time moves backward", async () => {
    const { root } = await fixture(); const original = processes.runProcess; let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(Date, "now").mockReturnValue(-100_000);
    vi.spyOn(processes, "runProcess").mockImplementation(async spec => {
      const result = await original(spec); elapsed = 101; return result;
    });
    expect((await captureWorktree(root, scope, { timeoutMs: 100 })).complete).toBe(false);
  });
  it("captures tracked and nonignored files, canonical scope/root, content hashes and executable modes", async () => {
    const { root, git } = await fixture();
    writeFileSync(join(root, ".gitignore"), "ignored/\n"); mkdirSync(join(root, "ignored"));
    writeFileSync(join(root, "ignored", "large"), "private fixture ignored content");
    writeFileSync(join(root, "tracked.txt"), "first"); await git.commitAll(root, "fixture tracked file");
    writeFileSync(join(root, "untracked.sh"), "echo fixture"); chmodSync(join(root, "untracked.sh"), 0o755);
    const capture = await captureWorktree(root, scope);
    expect(capture).toMatchObject({ complete: true, root, scope, universe: "git-source-v1", head: await git.headSha(root) });
    expect(capture.files.map(f => f.path)).toEqual([".gitignore", "tracked.txt", "untracked.sh"]);
    expect(capture.files.find(f => f.path === "tracked.txt")).toEqual({ path: "tracked.txt", sha256: createHash("sha256").update("first").digest("hex"), mode: "100644" });
    expect(capture.files.find(f => f.path === "untracked.sh")?.mode).toBe("100755");
  });
  it("changes content fingerprint for edits and preserves exact mode changes", async () => {
    const { root } = await fixture(); writeFileSync(join(root, "a"), "before");
    const before = await captureWorktree(root, scope); writeFileSync(join(root, "a"), "after"); chmodSync(join(root, "a"), 0o755);
    const after = await captureWorktree(root, scope);
    expect(before.complete && after.complete).toBe(true);
    expect(before.files[0]?.sha256).not.toBe(after.files[0]?.sha256); expect(after.files[0]?.mode).toBe("100755");
  });
  it("includes tracked files even if a later ignore rule would hide an untracked one", async () => {
    const { root, git } = await fixture(); writeFileSync(join(root, "kept"), "kept"); await git.commitAll(root, "fixture tracked");
    writeFileSync(join(root, ".gitignore"), "kept\n");
    expect((await captureWorktree(root, scope)).files.map(f => f.path)).toContain("kept");
  });
  it("marks a missing tracked file as a complete absence rather than silently keeping the old bytes", async () => {
    const { root, git } = await fixture(); writeFileSync(join(root, "gone"), "gone"); await git.commitAll(root, "fixture deleted"); unlinkSync(join(root, "gone"));
    const capture = await captureWorktree(root, scope);
    expect(capture.complete).toBe(true); expect(capture.files).toEqual([]);
  });
  it("does not follow a symlink or claim a complete empty source set", async () => {
    const { root } = await fixture(); symlinkSync("/does-not-exist-capture-fixture", join(root, "link"));
    const capture = await captureWorktree(root, scope); expect(capture.complete).toBe(false); expect(capture.files).toEqual([]);
  });
  it("refuses an enclosing repository when the supplied root has no own Git metadata", async () => {
    const { root } = await fixture(); const nested = join(root, "nested"); mkdirSync(nested);
    const capture = await captureWorktree(nested, scope); expect(capture.complete).toBe(false); expect(capture.head).toBeNull();
  });
  it.each([{ maxFiles: 1 }, { maxFileBytes: 2 }, { maxTotalBytes: 4 }])("does not present a truncated prefix as complete under %j", async limits => {
    const { root } = await fixture(); writeFileSync(join(root, "a"), "123"); writeFileSync(join(root, "b"), "456");
    const capture = await captureWorktree(root, scope, limits); expect(capture.complete).toBe(false); expect(capture.files).toEqual([]);
  });
  it("treats Git failure as unknown instead of an empty complete capture", async () => {
    const { root } = await fixture();
    vi.spyOn(processes, "runProcess").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "fixture failure", timedOut: false, aborted: false, durationMs: 0, signal: null });
    const capture = await captureWorktree(root, scope); expect(capture.complete).toBe(false); expect(capture.files).toEqual([]);
  });
  it("refuses a bounded-tail Git output that might have omitted earlier paths", async () => {
    const { root } = await fixture(); const original = processes.runProcess;
    vi.spyOn(processes, "runProcess").mockImplementation(async spec => spec.args.includes("ls-files")
      ? { exitCode: 0, stdout: "x".repeat(2 * 1024 * 1024), stderr: "", timedOut: false, aborted: false, durationMs: 0, signal: null }
      : original(spec));
    expect((await captureWorktree(root, scope)).complete).toBe(false);
  });
  it("refuses replacement-character Git paths instead of silently treating undecodable files as deleted", async () => {
    const { root } = await fixture(); const original = processes.runProcess;
    vi.spyOn(processes, "runProcess").mockImplementation(async spec => spec.args.includes("ls-files")
      ? { exitCode: 0, stdout: "\ufffd\0", stderr: "", timedOut: false, aborted: false, durationMs: 0, signal: null }
      : original(spec));
    const capture = await captureWorktree(root, scope);
    expect(capture.complete).toBe(false); expect(capture.files).toEqual([]);
  });
  it("keeps a changed HEAD during capture incomplete", async () => {
    const { root } = await fixture(); const original = processes.runProcess; let heads = 0;
    vi.spyOn(processes, "runProcess").mockImplementation(async spec => {
      const result = await original(spec);
      return spec.args.includes("--verify") && ++heads === 2 ? { ...result, stdout: "a".repeat(40) + "\n" } : result;
    });
    expect((await captureWorktree(root, scope)).complete).toBe(false);
  });
});

describe("exact committed source capture", () => {
  it("uses native SHA256 repository object hashing when declared by Git", async () => {
    const { root, git } = await fixture("sha256"); writeFileSync(join(root, "a"), Buffer.from([0, 255, 42]));
    await git.commitAll(root, "fixture sha256"); const sha = await git.headSha(root); expect(sha).toHaveLength(64);
    expect((await captureCommittedTree(root, scope, sha)).complete).toBe(true);
  });
  it("compares the exact committed objects despite local replacement refs", async () => {
    const { root, git } = await fixture(); writeFileSync(join(root, "a"), "old"); await git.commitAll(root, "fixture old");
    const old = await git.headSha(root); writeFileSync(join(root, "a"), "new"); await git.commitAll(root, "fixture new"); const current = await git.headSha(root);
    execFileSync("git", ["replace", current, old], { cwd: root, env: controllerGitEnv(), stdio: "pipe" });
    expect((await captureCommittedTree(root, scope, current)).complete).toBe(true);
  });
  it.each(["unknown", "sha256"])("rejects unsupported or inconsistent object format %s", async format => {
    const { root, git } = await fixture(); const sha = await git.headSha(root); const original = processes.runProcess;
    vi.spyOn(processes, "runProcess").mockImplementation(async spec => {
      const result = await original(spec); return spec.args.includes("--show-object-format") ? { ...result, stdout: format + "\n" } : result;
    });
    expect((await captureCommittedTree(root, scope, sha)).complete).toBe(false);
  });
  it("does not treat staged contents as a match for different accepted commit bytes", async () => {
    const { root, git } = await fixture(); writeFileSync(join(root, "a"), "committed"); await git.commitAll(root, "fixture tracked");
    writeFileSync(join(root, "a"), "staged"); execFileSync("git", ["add", "--", "a"], { cwd: root, env: controllerGitEnv(), stdio: "pipe" });
    expect((await captureCommittedTree(root, scope, await git.headSha(root))).complete).toBe(false);
  });

  it("matches regular committed binary bytes and Git modes without decoding blob contents", async () => {
    const { root, git } = await fixture();
    writeFileSync(join(root, "binary"), Buffer.from([0, 255, 128, 13, 10, 0, 42]));
    writeFileSync(join(root, "run"), "fixture"); chmodSync(join(root, "run"), 0o755);
    await git.commitAll(root, "fixture bytes");
    const capture = await captureCommittedTree(root, scope, await git.headSha(root));
    expect(capture).toEqual(await captureWorktree(root, scope)); expect(capture.complete).toBe(true);
  });
  it("supports an empty committed source tree", async () => {
    const { root, git } = await fixture();
    expect(await captureCommittedTree(root, scope, await git.headSha(root))).toMatchObject({ complete: true, files: [] });
  });
  it("refuses hidden filesystem edits even when Git status says clean", async () => {
    const { root, git } = await fixture(); writeFileSync(join(root, "a"), "committed"); await git.commitAll(root, "fixture tracked");
    execFileSync("git", ["update-index", "--assume-unchanged", "--", "a"], { cwd: root, env: controllerGitEnv(), stdio: "pipe" });
    writeFileSync(join(root, "a"), "hidden different bytes"); expect(await git.isClean(root)).toBe(true);
    expect((await captureCommittedTree(root, scope, await git.headSha(root))).complete).toBe(false);
  });
  it.each(["untracked", "deleted", "mode"])("rejects %s divergence from the exact tree", async kind => {
    const { root, git } = await fixture(); writeFileSync(join(root, "a"), "committed"); await git.commitAll(root, "fixture tracked");
    if (kind === "untracked") writeFileSync(join(root, "b"), "extra");
    if (kind === "deleted") unlinkSync(join(root, "a"));
    if (kind === "mode") chmodSync(join(root, "a"), 0o755);
    const capture = await captureCommittedTree(root, scope, await git.headSha(root));
    expect(capture.complete).toBe(false); expect(capture.files).toEqual([]);
  });
  it("refuses a commit other than current HEAD and invalid commit inputs before Git", async () => {
    const { root, git } = await fixture(); const old = await git.headSha(root);
    writeFileSync(join(root, "a"), "new"); await git.commitAll(root, "fixture new commit");
    expect((await captureCommittedTree(root, scope, old)).complete).toBe(false);
    const run = vi.spyOn(processes, "runProcess");
    expect((await captureCommittedTree(root, scope, "--all")).complete).toBe(false); expect(run).not.toHaveBeenCalled();
  });
  it.each([undefined, null, "", "abc"])("refuses missing or malformed committed identity %j before Git", async commit => {
    const { root } = await fixture(); const run = vi.spyOn(processes, "runProcess");
    expect((await captureCommittedTree(root, scope, commit as string)).complete).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it.each(["truncated", "unsupported", "duplicate", "empty_record", "overflow", "failure"])("refuses %s tree evidence", async kind => {
    const { root, git } = await fixture(); const sha = await git.headSha(root); const original = processes.runProcess;
    vi.spyOn(processes, "runProcess").mockImplementation(async spec => {
      if (!spec.args.includes("ls-tree")) return original(spec);
      const row = "100644 blob " + "a".repeat(40) + "\ta\0";
      return { exitCode: kind === "failure" ? 1 : 0, stdout: kind === "overflow" ? "x".repeat(2 * 1024 * 1024) : kind === "empty_record" ? "\0" : kind === "truncated" ? row.slice(0,-1) : kind === "unsupported" ? "160000 commit " + "a".repeat(40) + "\tsub\0" : row + row,
        stderr: "", timedOut: false, aborted: false, durationMs: 0, signal: null };
    });
    expect((await captureCommittedTree(root, scope, sha)).complete).toBe(false);
  });
});
