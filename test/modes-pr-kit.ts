// The draft pull request text that `publish` writes, produced by the real host script (scripts/mc-docker.sh) with stand-ins for Docker,
// GitHub and gh. Shared by test/modes-wording.test.ts and test/modes-hostile-evidence.test.ts. Nothing here calls an AI or reaches GitHub.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { World } from "./modes-real-kit.js";

// ───────────────────────────── The pull request text, through the real host script ─────────────────────────────

const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO_DIR, "scripts", "mc-docker.sh");
const BASH = ["/usr/bin/bash", "/bin/bash"].find((p) => existsSync(p)) ?? "bash";
const REAL_GIT = ["/usr/bin/git", "/usr/local/bin/git", "/bin/git"].find((p) => existsSync(p)) ?? "git";
const IMAGE = "mission-control:local";
const SYSTEM_TOOLS = ["bash", "sh", "env", "mktemp", "rm", "mkdir", "mv", "install", "cat", "tr", "cut", "tail", "head", "wc", "dirname", "basename", "sed", "grep", "sort", "uniq", "readlink", "ln", "chmod", "cp", "touch", "ls", "tee", "git"];
// Stand-ins, as in test/mc-docker-github.test.ts: docker runs the script that reads a mission's record against FAKE_MC_HOME, gh keeps the body.
const FAKE_DOCKER = `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const [command, sub] = args;
if (command === "info") process.exit(0);
if (command === "image" && sub === "inspect") process.exit(0);
const entry = args.indexOf("--entrypoint");
if (command === "run" && entry !== -1 && args[entry + 1] === "node") {
  const result = spawnSync(process.execPath, args.slice(args.indexOf("${IMAGE}") + 1), { env: { ...process.env, MC_HOME: process.env.FAKE_MC_HOME }, encoding: "utf8" });
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}
`;
const FAKE_GH = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const bodyArg = args.find((a) => a.startsWith("--body-file="));
fs.writeFileSync(process.env.FAKE_GH_BODY, bodyArg ? fs.readFileSync(bodyArg.slice("--body-file=".length), "utf8") : "");
console.log("https://github.com/acme/widgets/pull/7");
`;

/**
 * The draft pull request body that `publish` writes for the finished mission `id` of the world `w`. The mission's own files
 * (record and report) are the engine's; only the app folder's address is pointed at a stand-in for GitHub.
 */
export function pullRequestBody(world: World, id: string, app: string, onCleanup: (undo: () => void) => void): string {
  const tmp = mkdtempSync(join(tmpdir(), "mc-wording-pr-"));
  onCleanup(() => rmSync(tmp, { recursive: true, force: true }));
  const [fakeBin, ghBin, tools, hub, mcHome, tmpDir] = ["bin", "gh-bin", "tools", "hub", "mc-home", "tmpdir"].map((name) => join(tmp, name)) as [string, string, string, string, string, string];
  for (const dir of [fakeBin, ghBin, tools, hub, tmpDir, join(mcHome, "missions", id)]) mkdirSync(dir, { recursive: true });
  const exe = (file: string, text: string): void => writeFileSync(file, text, { mode: 0o755 });
  exe(join(fakeBin, "docker"), FAKE_DOCKER);
  exe(join(fakeBin, "id"), `#!/bin/sh\necho 1000\n`);
  exe(join(ghBin, "gh"), FAKE_GH);
  for (const name of SYSTEM_TOOLS) {
    const found = ["/usr/bin", "/bin"].map((dir) => join(dir, name)).find((p) => existsSync(p));
    if (found) symlinkSync(found, join(tools, name));
  }
  // The mission as the engine wrote it, with the app's path as the container sees it.
  const record = JSON.parse(readFileSync(join(world.h.home, "missions", id, "mission.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(mcHome, "missions", id, "mission.json"), JSON.stringify({ ...record, repoPath: `/home/pwuser/mc-apps/${app}` }));
  cpSync(world.h.store.reportPath(id), join(mcHome, "missions", id, "report.md"));
  // The stand-in for GitHub: a bare repository that already holds main, and the app's address pointed at it.
  const appDir = join(world.userHome, "mc-apps", app);
  const bare = join(hub, "acme", "widgets.git");
  mkdirSync(bare, { recursive: true });
  const git = (cwd: string, ...args: string[]): void => {
    const r = spawnSync(REAL_GIT, args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: world.userHome, GIT_CONFIG_NOSYSTEM: "1" } });
    expect(r.status, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
  };
  git(bare, "init", "--bare", "-q", "-b", "main");
  git(appDir, "push", "-q", bare, "main");
  git(appDir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  writeFileSync(join(world.userHome, ".gitconfig"), `[url "file://${hub}/"]\n\tinsteadOf = https://github.com/\n`);
  const bodyFile = join(tmp, "body.md");
  const run = spawnSync(BASH, [SCRIPT, "publish", id, "--to", "acme/widgets"], {
    cwd: world.userHome,
    input: "",
    encoding: "utf8",
    env: { PATH: `${fakeBin}:${ghBin}:${tools}`, HOME: world.userHome, TMPDIR: tmpDir, FAKE_GH_BODY: bodyFile, FAKE_MC_HOME: mcHome },
  });
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  return readFileSync(bodyFile, "utf8");
}

