// Tests for the two commands of scripts/mc-docker.sh that run on the PC with the owner's own GitHub login, and never
// in the container: `get` (download a repository) and `publish` (upload a mission's branch, open a draft pull request).
//
// Real GitHub cannot be reached from here, so GitHub is a stand-in: a folder of bare git repositories, wired in through
// the owner's own git settings (`url.<folder>.insteadOf https://github.com/`, written to the test's ~/.gitconfig). That
// is how a real owner could redirect git too, so the product code has no test switch at all and nothing a mission or an
// AI wrote can reach one. `gh` is a fake program on PATH that records its arguments and the pull request body.
// No Docker daemon is needed: a fake `docker` runs the real script that reads a mission's record, against a fixture.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO_DIR, "scripts", "mc-docker.sh");
const BASH = ["/usr/bin/bash", "/bin/bash"].find((p) => fs.existsSync(p)) ?? "bash";
const REAL_GIT = ["/usr/bin/git", "/usr/local/bin/git", "/bin/git"].find((p) => fs.existsSync(p)) ?? "git";
const IMAGE = "mission-control:local";
/** The system programs the script needs. The test's PATH holds only these (as links), the fakes, and a fake gh when asked. */
const SYSTEM_TOOLS = ["bash", "sh", "env", "mktemp", "rm", "mkdir", "mv", "install", "cat", "tr", "cut", "tail", "head", "wc", "dirname", "basename", "sed", "grep", "sort", "uniq", "readlink", "ln", "chmod", "cp", "touch", "ls", "tee"];

// Stand-in docker: `info` and `image inspect` answer, and the one `docker run --entrypoint node` that `publish` makes to
// read a mission's record runs the real script it was given, with FAKE_MC_HOME as the Mission Control folder.
const FAKE_DOCKER = `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + "\\n");
const [command, sub] = args;
if (command === "info") process.exit(Number(process.env.FAKE_INFO_FAILS ?? "0"));
if (command === "image" && sub === "inspect") process.exit(process.env.FAKE_IMAGE_MISSING ? 1 : 0);
const entry = args.indexOf("--entrypoint");
if (command === "run" && entry !== -1 && args[entry + 1] === "node") {
  if (process.env.FAKE_FACTS_STATUS) process.exit(Number(process.env.FAKE_FACTS_STATUS));
  const result = spawnSync(process.execPath, args.slice(args.indexOf("${IMAGE}") + 1), {
    env: { ...process.env, MC_HOME: process.env.FAKE_MC_HOME },
    encoding: "utf8",
  });
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}
`;
const FAKE_ID = `#!/bin/sh\necho "\${FAKE_UID:-1000}"\n`;
// Records the folder, arguments and the settings that matter as a JSON line, then runs the real git.
const FAKE_GIT = `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GIT_LOG, JSON.stringify({
  cwd: process.cwd(),
  args,
  prompt: process.env.GIT_TERMINAL_PROMPT,
  ssh: process.env.GIT_SSH_COMMAND,
}) + "\\n");
const result = spawnSync(${JSON.stringify(REAL_GIT)}, args, { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
`;
// Records its arguments, folder and the pull request body file (read now, it is deleted later).
const FAKE_GH = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const bodyArg = args.find((a) => a.startsWith("--body-file="));
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({
  cwd: process.cwd(),
  args,
  body: bodyArg ? fs.readFileSync(bodyArg.slice("--body-file=".length), "utf8") : null,
  prompts: process.env.GH_PROMPT_DISABLED,
}) + "\\n");
if (process.env.FAKE_GH_EXISTS) {
  console.error('a pull request for branch "x" into branch "main" already exists:');
  console.error(process.env.FAKE_GH_EXISTS);
  process.exit(1);
}
if (process.env.FAKE_GH_FAIL) {
  console.error(process.env.FAKE_GH_FAIL);
  process.exit(1);
}
console.log(process.env.FAKE_GH_URL ?? "https://github.com/acme/widgets/pull/7");
`;

/** A string made of the given code points (so this file holds no escapes for odd characters). */
const u = (...codes: number[]): string => String.fromCodePoint(...codes);
const BEL = u(7);
const ESC = u(27);

/** True when the text has a control character other than a line break, or an invisible or direction-changing one. */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp < 32 && cp !== 10) || cp === 127 || (cp >= 0x80 && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || cp === 0xfeff) return true;
  }
  return false;
}

interface GitCall {
  cwd: string;
  args: string[];
  prompt?: string;
  ssh?: string;
}
interface GhCall {
  cwd: string;
  args: string[];
  body: string | null;
  prompts?: string;
}
interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
  docker: string[][];
  git: GitCall[];
  gh: GhCall[];
}

let tmp: string;
let home: string;
let fakeBin: string;
let ghBin: string;
let tools: string;
let hub: string;
let mcHome: string;
let tmpDir: string;

function readJsonLines<T>(file: string): T[] {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];
}

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o755 });
}

/** Runs the real git for building fixtures, as the owner (so the owner's ~/.gitconfig applies). */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(REAL_GIT, args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "tester@example.com",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "tester@example.com",
    },
  });
  expect(result.status, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

interface RunOptions {
  /** Put the fake gh on PATH (default: yes). */
  gh?: boolean;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/** Runs the wrapper with only the fakes and the system programs on PATH. */
function run(args: string[], opts: RunOptions = {}): Result {
  const logs = ["docker", "git", "gh"].map((name) => path.join(tmp, `${name}.log`));
  for (const log of logs) fs.rmSync(log, { force: true });
  const env: Record<string, string> = {
    PATH: `${fakeBin}:${opts.gh === false ? "" : `${ghBin}:`}${tools}`,
    HOME: home,
    TZ: "America/New_York",
    TMPDIR: tmpDir,
    FAKE_DOCKER_LOG: logs[0]!,
    FAKE_GIT_LOG: logs[1]!,
    FAKE_GH_LOG: logs[2]!,
    FAKE_MC_HOME: mcHome,
  };
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(BASH, [SCRIPT, ...args], { cwd: opts.cwd ?? home, env, input: "", encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    docker: readJsonLines<string[]>(logs[0]!),
    git: readJsonLines<GitCall>(logs[1]!),
    gh: readJsonLines<GhCall>(logs[2]!),
  };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-github-test-")));
  home = path.join(tmp, "home");
  fakeBin = path.join(tmp, "bin");
  ghBin = path.join(tmp, "gh-bin");
  tools = path.join(tmp, "tools");
  hub = path.join(tmp, "hub");
  mcHome = path.join(tmp, "mc-home");
  tmpDir = path.join(tmp, "tmpdir");
  for (const dir of [home, fakeBin, ghBin, tools, hub, mcHome, tmpDir]) fs.mkdirSync(dir);
  writeExecutable(path.join(fakeBin, "docker"), FAKE_DOCKER);
  writeExecutable(path.join(fakeBin, "id"), FAKE_ID);
  writeExecutable(path.join(fakeBin, "git"), FAKE_GIT);
  writeExecutable(path.join(ghBin, "gh"), FAKE_GH);
  for (const name of SYSTEM_TOOLS) {
    const found = ["/usr/bin", "/bin"].map((dir) => path.join(dir, name)).find((p) => fs.existsSync(p));
    if (found) fs.symlinkSync(found, path.join(tools, name));
  }
  // The stand-in for GitHub: every https://github.com/ and git@github.com: address goes to a folder in the test.
  fs.writeFileSync(path.join(home, ".gitconfig"), `[url "file://${hub}/"]\n\tinsteadOf = https://github.com/\n\tinsteadOf = git@github.com:\n`);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A bare repository for owner/repo in the stand-in GitHub, with a first commit on main. */
function addHubRepo(owner: string, repo: string): string {
  const bare = path.join(hub, owner, `${repo}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, "init", "--bare", "-q", "-b", "main");
  const seed = path.join(tmp, `seed-${owner}-${repo.replace(/\W/g, "_")}`);
  git(tmp, "init", "-q", "-b", "main", seed);
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "first");
  git(seed, "push", "-q", bare, "main");
  fs.rmSync(seed, { recursive: true, force: true });
  return bare;
}

describe("get: what it accepts", () => {
  /** The addresses the product accepts and what each one downloads. */
  const GOOD: [string, string][] = [
    ["acme/widgets", "https://github.com/acme/widgets.git"],
    ["https://github.com/acme/widgets", "https://github.com/acme/widgets.git"],
    ["https://github.com/acme/widgets.git", "https://github.com/acme/widgets.git"],
    ["https://github.com/acme/widgets/", "https://github.com/acme/widgets.git"],
    ["git@github.com:acme/widgets.git", "git@github.com:acme/widgets.git"],
    ["git@github.com:acme/widgets", "git@github.com:acme/widgets.git"],
  ];

  it.each(GOOD)("downloads %s with the owner's own git settings and prints the next steps", (input, url) => {
    addHubRepo("acme", "widgets");
    const r = run(["get", input]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(home, "mc-apps", "widgets", "README.md"), "utf8")).toBe("hello\n");
    expect(r.stdout).toContain("mc-docker: downloaded acme/widgets into ~/mc-apps/widgets.");
    expect(r.stdout).toContain('mc feature ~/mc-apps/widgets "<what you want changed>"');
    expect(r.stdout).toContain("mc plan preview");
    // The one clone: an array of arguments, with -- before the address and the folder, prompts off, no hooks.
    const clones = r.git.filter((c) => c.args.includes("clone"));
    expect(clones).toHaveLength(1);
    const clone = clones[0]!;
    expect(clone.args.slice(clone.args.indexOf("clone"))).toEqual(["clone", "--quiet", "--", url, path.join(home, "mc-apps", "widgets")]);
    expect(clone.args).toContain("core.hooksPath=/dev/null");
    expect(clone.prompt).toBe("0");
    expect(clone.ssh).toContain("BatchMode=yes");
    // It never touched Docker: it works with Docker stopped.
    expect(r.docker).toEqual([]);
  });

  it("works while Docker is stopped, and makes the apps folder itself", () => {
    addHubRepo("acme", "widgets");
    const r = run(["get", "acme/widgets"], { env: { FAKE_INFO_FAILS: "1" } });
    expect(r.status).toBe(0);
    expect(r.docker).toEqual([]);
    expect(fs.statSync(path.join(home, "mc-apps")).isDirectory()).toBe(true);
  });

  it("works when the home folder has a space in its name", () => {
    addHubRepo("acme", "widgets");
    const spaced = path.join(tmp, "my home dir");
    fs.renameSync(home, spaced);
    home = spaced;
    const r = run(["get", "acme/widgets"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(spaced, "mc-apps", "widgets", "README.md"))).toBe(true);
  });

  it("uses the folder name it is given", () => {
    addHubRepo("acme", "widgets");
    const r = run(["get", "acme/widgets", "my-widgets_2.0"]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(home, "mc-apps", "my-widgets_2.0", "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, "mc-apps", "widgets"))).toBe(false);
    expect(r.stdout).toContain("into ~/mc-apps/my-widgets_2.0.");
  });

  it("keeps the repository's own git history and address, and nothing else from this PC", () => {
    addHubRepo("acme", "widgets");
    run(["get", "acme/widgets"]);
    const config = fs.readFileSync(path.join(home, "mc-apps", "widgets", ".git", "config"), "utf8");
    expect(config).toContain("url = https://github.com/acme/widgets.git");
    expect(config).not.toMatch(/token|password|credential|@github\.com/i);
  });

  it("asks for a folder name when the repository's name can't be one, and accepts one", () => {
    addHubRepo("acme", ".dotfiles");
    const refused = run(["get", "acme/.dotfiles"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("can't be used as a folder name here");
    expect(refused.stderr).toContain("mc get acme/.dotfiles my-app");
    expect(refused.git).toEqual([]);
    const ok = run(["get", "acme/.dotfiles", "dotfiles"]);
    expect(ok.status).toBe(0);
    expect(fs.existsSync(path.join(home, "mc-apps", "dotfiles", "README.md"))).toBe(true);
  });
});

describe("get: what it refuses", () => {
  it("never overwrites: a folder, a file or a link that exists is left exactly as it is", () => {
    addHubRepo("acme", "widgets");
    const apps = path.join(home, "mc-apps");
    fs.mkdirSync(path.join(apps, "widgets"), { recursive: true });
    fs.writeFileSync(path.join(apps, "widgets", "mine.txt"), "keep me\n");
    fs.writeFileSync(path.join(apps, "afile"), "x");
    fs.symlinkSync(path.join(tmp, "nowhere"), path.join(apps, "alink"));
    for (const name of ["widgets", "afile", "alink"]) {
      const r = run(["get", "acme/widgets", name]);
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toContain(`~/mc-apps/${name} already exists, so I downloaded nothing and left it as it is.`);
      expect(r.git, name).toEqual([]);
    }
    expect(fs.readFileSync(path.join(apps, "widgets", "mine.txt"), "utf8")).toBe("keep me\n");
    expect(fs.readFileSync(path.join(apps, "afile"), "utf8")).toBe("x");
    expect(fs.readlinkSync(path.join(apps, "alink"))).toBe(path.join(tmp, "nowhere"));
  });

  it("says how to log in when the download fails, and leaves no folder behind", () => {
    const r = run(["get", "acme/not-there"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("I could not download acme/not-there. Git said:");
    expect(r.stderr).toContain("gh auth login");
    expect(r.stderr).toContain("gh auth setup-git");
    expect(r.stderr).toContain("docs/github-setup.md");
    expect(fs.existsSync(path.join(home, "mc-apps", "not-there"))).toBe(false);
    // Nothing in the message can move the cursor or change colors.
    expect(hasControl(r.stderr)).toBe(false);
  });

  it("refuses to run as root, and needs one or two arguments", () => {
    const root = run(["get", "acme/widgets"], { env: { FAKE_UID: "0" } });
    expect(root.status).toBe(1);
    expect(root.stderr).toContain("without sudo");
    for (const args of [["get"], ["get", "acme/widgets", "a", "b"]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr).toContain("get needs a GitHub repository");
      expect(r.git).toEqual([]);
    }
  });

  const HOSTILE_ADDRESSES: [string, RegExp][] = [
    ["--upload-pack=touch /tmp/pwned", /I don't understand/],
    ["-c", /I don't understand/],
    ["-c core.sshCommand=touch", /I don't understand/],
    ["--help", /I don't understand/],
    ["acme/widgets --upload-pack=x", /I don't understand/],
    ["acme/widgets;touch /tmp/pwned", /I don't understand/],
    ["acme/widgets && touch /tmp/pwned", /I don't understand/],
    ["acme/$(touch /tmp/pwned)", /I don't understand/],
    ["acme/`touch /tmp/pwned`", /I don't understand/],
    ["acme/widgets|cat", /I don't understand/],
    ["acme/wid gets", /I don't understand/],
    ["acme/widgets\ntouch /tmp/pwned", /I don't understand/],
    ["acme/widgets\n", /I don't understand/],
    ["\nacme/widgets", /I don't understand/],
    [" acme/widgets", /I don't understand/],
    ["acme/widgets ", /I don't understand/],
    ["acme\\widgets", /I don't understand/],
    ["", /I don't understand/],
    ["/", /I don't understand/],
    ["acme/", /I don't understand/],
    ["/widgets", /I don't understand/],
    ["acme/widgets/extra", /I don't understand/],
    ["acme//widgets", /I don't understand/],
    ["./widgets", /I don't understand/],
    ["../widgets", /I don't understand/],
    ["acme/..", /I don't understand/],
    ["acme/.", /I don't understand/],
    ["acme/.git", /I don't understand/],
    ["../../etc/passwd", /I don't understand/],
    ["/etc/passwd", /I don't understand/],
    ["~/widgets", /I don't understand/],
    ["ext::sh -c touch% /tmp/pwned", /I don't understand/],
    ["fd::17/foo", /I don't understand/],
    ["github.com/acme/widgets", /I don't understand/],
    ["www.github.com/acme/widgets", /I don't understand/],
    ["https://github.com/acme", /I don't understand/],
    ["https://github.com/acme/widgets/tree/main", /I don't understand/],
    ["https://github.com/acme/widgets?x=1", /I don't understand/],
    ["https://github.com/acme/widgets#readme", /I don't understand/],
    ["https://github.com/acme/widgets.git/extra", /I don't understand/],
    ["https://github.com/-acme/widgets", /I don't understand/],
    ["-acme/widgets", /I don't understand/],
    ["acme_corp/widgets", /I don't understand/],
    ["https://github.com//widgets", /I don't understand/],
    ["git@github.com:/acme/widgets.git", /I don't understand/],
    ["git@github.com:acme/widgets.git/", /I don't understand/],
    // Other hosts and other ways to name a place: the message names github.com.
    ["https://gitlab.com/acme/widgets", /only works with github\.com/],
    ["https://github.com.evil.example/acme/widgets", /only works with github\.com/],
    ["https://evil.example/github.com/acme/widgets", /only works with github\.com/],
    ["https://github.com@evil.example/acme/widgets", /only works with github\.com/],
    ["https://user:secret@github.com/acme/widgets", /only works with github\.com/],
    ["https://token@github.com/acme/widgets", /only works with github\.com/],
    ["http://github.com/acme/widgets", /only works with github\.com/],
    ["https://GITHUB.com/acme/widgets", /only works with github\.com/],
    ["https://github.com:443/acme/widgets", /only works with github\.com/],
    ["ssh://git@github.com/acme/widgets.git", /only works with github\.com/],
    ["git://github.com/acme/widgets.git", /only works with github\.com/],
    ["git@gitlab.com:acme/widgets.git", /only works with github\.com/],
    ["git@github.com.evil.example:acme/widgets.git", /only works with github\.com/],
    ["root@github.com:acme/widgets.git", /only works with github\.com/],
    ["file:///etc/passwd", /only works with github\.com/],
    ["file://localhost/etc/passwd", /only works with github\.com/],
    ["ftp://github.com/acme/widgets", /only works with github\.com/],
    // Look-alikes: Cyrillic letters, a full-width slash, invisible and direction-changing characters, accents.
    [`acme/widg${u(0x435)}ts`, /I don't understand/],
    [`${u(0x430)}cme/widgets`, /I don't understand/],
    [`acme${u(0xff0f)}widgets`, /I don't understand/],
    [`acme/widgets${u(0x200b)}`, /I don't understand/],
    [`acme/${u(0x202e)}widgets`, /I don't understand/],
    [`acme/wid${u(0x301)}gets`, /I don't understand/],
    [`acme/caf${u(0xe9)}`, /I don't understand/],
    [`https://github.com/acme/widg${u(0x435)}ts`, /I don't understand/],
    [`${u(0x2028)}acme/widgets`, /I don't understand/],
    // Too long.
    [`${"a".repeat(40)}/widgets`, /I don't understand/],
    [`acme/${"w".repeat(101)}`, /I don't understand/],
    [`https://github.com/acme/${"w".repeat(5000)}`, /I don't understand/],
    ["a".repeat(100000), /I don't understand/],
  ];

  it.each(HOSTILE_ADDRESSES)("refuses the address %j with a plain sentence and runs no git", (address, message) => {
    const r = run(["get", address]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(message);
    expect(r.stderr).toMatch(/owner\/repo/);
    expect(r.git).toEqual([]);
    expect(r.docker).toEqual([]);
    expect(fs.existsSync(path.join(home, "mc-apps"))).toBe(false);
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
    // What it echoes back is plain ASCII, at most 60 characters, so it can't hide anything.
    expect(r.stderr).not.toMatch(/[^\n\x20-\x7e]/);
    for (const line of r.stderr.split("\n")) expect(line.length).toBeLessThan(400);
  });

  const HOSTILE_FOLDERS = [
    "../evil",
    "..",
    ".",
    "a/b",
    "/abs",
    "a/../b",
    "a..b",
    "-x",
    "--upload-pack=x",
    ".hidden",
    "_x",
    "a b",
    "a;b",
    "a$(b)",
    "a`b`",
    "a\nb",
    "",
    "w".repeat(62),
    `${u(0x430)}bc`,
    `caf${u(0xe9)}`,
    `a${u(0x200b)}b`,
    `a${u(0x202e)}b`,
  ];

  it.each(HOSTILE_FOLDERS)("refuses the folder name %j and downloads nothing", (name) => {
    addHubRepo("acme", "widgets");
    const r = run(["get", "acme/widgets", name]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("can't be used as a folder name");
    expect(r.git).toEqual([]);
    expect(fs.existsSync(path.join(home, "mc-apps"))).toBe(false);
    expect(fs.existsSync(path.join(home, "evil"))).toBe(false);
    expect(r.stderr).not.toMatch(/[^\n\x20-\x7e]/);
  });

  it("accepts the longest folder name and refuses one more character", () => {
    addHubRepo("acme", "widgets");
    expect(run(["get", "acme/widgets", "w".repeat(61)]).status).toBe(0);
    expect(run(["get", "acme/widgets", "w".repeat(62)]).status).toBe(1);
  });
});

describe("the address checks on their own (the script loaded without running it)", () => {
  /** Runs one check from the script and prints its answer: the return code, then owner, repo and address. */
  function parse(text: string): { code: number; owner: string; repo: string; url: string } {
    const r = spawnSync(
      BASH,
      ["-c", 'source "$1"; c=0; parse_github_address "$2" || c=$?; printf "%s\\n%s\\n%s\\n%s\\n" "$c" "$GH_OWNER" "$GH_REPO" "$GH_URL"', "_", SCRIPT, text],
      { encoding: "utf8", env: { PATH: `${fakeBin}:${tools}`, HOME: home } },
    );
    expect(r.status, r.stderr).toBe(0);
    const [code, owner, repo, url] = r.stdout.split("\n");
    return { code: Number(code), owner: owner ?? "", repo: repo ?? "", url: url ?? "" };
  }

  it("takes apart each accepted form into owner, repository and a clean address", () => {
    expect(parse("Acme-1/Widgets.v2_x")).toEqual({ code: 0, owner: "Acme-1", repo: "Widgets.v2_x", url: "https://github.com/Acme-1/Widgets.v2_x.git" });
    expect(parse("https://github.com/a/b.git/")).toEqual({ code: 0, owner: "a", repo: "b", url: "https://github.com/a/b.git" });
    expect(parse("git@github.com:a/b.git")).toEqual({ code: 0, owner: "a", repo: "b", url: "git@github.com:a/b.git" });
    expect(parse("a/b.git.git").repo).toBe("b.git");
  });

  it("uses the limits of the owner pattern (39) and the repository pattern (100), and not . or ..", () => {
    expect(parse(`${"o".repeat(39)}/r`).code).toBe(0);
    expect(parse(`${"o".repeat(40)}/r`).code).toBe(2);
    expect(parse(`o/${"r".repeat(100)}`).code).toBe(0);
    expect(parse(`o/${"r".repeat(101)}`).code).toBe(2);
    expect(parse("o/...").code).toBe(0);
    expect(parse("o/..").code).toBe(2);
    expect(parse("o/.").code).toBe(2);
    expect(parse("o/.git").code).toBe(2);
  });

  it("sets nothing when it refuses", () => {
    expect(parse("https://evil.example/a/b")).toEqual({ code: 1, owner: "", repo: "", url: "" });
    expect(parse("not an address")).toEqual({ code: 2, owner: "", repo: "", url: "" });
  });
});

// ───────────────────────────── publish ─────────────────────────────

const ID = "test-dark-mode";
/** What publish needs to upload for real: the repository the person named after seeing it (the preview prints it). */
const TO = ["--to", "acme/widgets"];

interface World {
  app: string;
  bare: string;
  mainSha: string;
  branchSha: string;
}

/**
 * A repository acme/widgets in the stand-in GitHub, the owner's copy of it in ~/mc-apps/widgets with its address set
 * the usual way, and the branch mc/<ID> with one new commit.
 */
function makeWorld(opts: { branch?: boolean; origin?: string | null } = {}): World {
  const bare = addHubRepo("acme", "widgets");
  const app = path.join(home, "mc-apps", "widgets");
  fs.mkdirSync(path.dirname(app), { recursive: true });
  git(tmp, "clone", "-q", bare, app);
  if (opts.origin === null) git(app, "remote", "remove", "origin");
  else git(app, "remote", "set-url", "origin", opts.origin ?? "https://github.com/acme/widgets.git");
  const mainSha = git(app, "rev-parse", "main");
  if (opts.branch !== false) {
    git(app, "checkout", "-q", "-b", `mc/${ID}`);
    fs.writeFileSync(path.join(app, "dark.css"), "body { background: black; }\n");
    git(app, "add", "-A");
    git(app, "commit", "-q", "-m", "Add dark mode");
    git(app, "checkout", "-q", "main");
  }
  const branchSha = opts.branch === false ? mainSha : git(app, "rev-parse", `mc/${ID}`);
  return { app, bare, mainSha, branchSha };
}

function missionRecord(world: World, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    kind: "feature",
    title: "Dark mode",
    request: "Add a dark mode",
    repoPath: "/home/pwuser/mc-apps/widgets",
    baseBranch: "main",
    integrationBranch: `mc/${ID}`,
    baseSha: world.mainSha,
    profile: "mixed",
    roleOverrides: [],
    status: "done",
    stage: "complete",
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z",
    features: [{ id: "dark-mode", title: "Dark mode switch", status: "done", frozenTests: [{ path: "tests/dark.test.ts", sha256: "0".repeat(64) }], attempts: [], reviewRounds: 0, openFindings: [] }],
    baselineBroken: false,
    baselineFailures: [],
    decisionsNeeded: [],
    gateCRounds: 0,
    agentRuns: 5,
    notes: [],
    ...extra,
  };
}

function writeMission(world: World, extra: Record<string, unknown> = {}, id: string = ID): string {
  const dir = path.join(mcHome, "missions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mission.json"), JSON.stringify(missionRecord(world, extra), null, 2));
  return dir;
}

/** What the stand-in GitHub holds: the head of a branch, or undefined. */
function hubHead(bare: string, branch: string): string | undefined {
  const r = spawnSync(REAL_GIT, ["--git-dir", bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function pushes(r: Result): GitCall[] {
  return r.git.filter((c) => c.args.includes("push"));
}

function setup(extra: Record<string, unknown> = {}, opts: { branch?: boolean; origin?: string | null } = {}): World {
  const world = makeWorld(opts);
  writeMission(world, extra);
  return world;
}

describe("publish: the pull request", () => {
  it("uploads only mc/<id>, opens a draft pull request with gh from a clean copy, and prints its address", () => {
    const world = setup();
    const r = run(["publish", ID, ...TO]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    // GitHub (the stand-in) got the branch, at the right commit, and main did not move.
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
    expect(hubHead(world.bare, "main")).toBe(world.mainSha);
    expect(r.stdout).toContain(`mc-docker: mc/${ID} is now on github.com/acme/widgets. The base branch "main" was not changed.`);
    expect(r.stdout).toContain("mc-docker: draft pull request: https://github.com/acme/widgets/pull/7");
    expect(r.stdout).toContain("nothing is merged until you merge it on github.com");
    // gh: one call, every value its own argument, a draft, aimed at this repository, this branch and the base.
    expect(r.gh).toHaveLength(1);
    const gh = r.gh[0]!;
    expect(gh.args.slice(0, 2)).toEqual(["pr", "create"]);
    expect(gh.args).toEqual(expect.arrayContaining(["--draft", "--repo", "acme/widgets", "--head", `mc/${ID}`, "--base", "main", "--title=Dark mode"]));
    expect(gh.args.find((a) => a.startsWith("--body-file="))).toMatch(/\/body\.md$/);
    expect(gh.prompts).toBe("1");
    // gh ran in the temporary copy, never in the app folder.
    expect(gh.cwd.startsWith(tmpDir)).toBe(true);
    expect(gh.cwd.startsWith(world.app)).toBe(false);
  });

  it("pushes exactly one branch, with one plain refusing-to-overwrite refspec, and never forces anything", () => {
    const world = setup();
    const r = run(["publish", ID, ...TO]);
    expect(r.status).toBe(0);
    const [push, ...more] = pushes(r);
    expect(more).toEqual([]);
    const args = push!.args.slice(push!.args.indexOf("push"));
    expect(args).toEqual(["push", "--quiet", "origin", `refs/mc-publish/branch:refs/heads/mc/${ID}`]);
    for (const call of r.git) {
      for (const arg of call.args) {
        expect(arg, call.args.join(" ")).not.toMatch(/^(--force|--force-with-lease.*|-f|--mirror|--all|--tags|--delete|-d|--prune)$/);
        expect(arg.startsWith("+"), call.args.join(" ")).toBe(false);
      }
    }
    expect(hubHead(world.bare, "master")).toBeUndefined();
    expect(push!.prompt).toBe("0");
    expect(push!.args).toContain("core.hooksPath=/dev/null");
    expect(push!.args).toContain("core.fsmonitor=false");
  });

  it("runs git only in a copy it made itself, never inside the app folder", () => {
    const world = setup();
    const r = run(["publish", ID, ...TO]);
    expect(r.status).toBe(0);
    for (const call of r.git) {
      expect(call.cwd.startsWith(world.app), call.args.join(" ")).toBe(false);
      const index = call.args.indexOf("-C");
      if (index !== -1) expect(call.args[index + 1]!.startsWith(world.app), call.args.join(" ")).toBe(false);
    }
    // The only mentions of the app folder: its saved settings, read as a plain file, and where the branch is copied from.
    for (const call of r.git.filter((c) => c.args.some((a) => a.includes(world.app)))) {
      if (call.args.includes("config")) {
        expect(call.args.slice(call.args.indexOf("config"))).toEqual(["config", "--file", path.join(world.app, ".git", "config"), expect.stringMatching(/^(--get-all|--get)$/), expect.stringMatching(/^(remote\.origin\.url|core\.hooksPath)$/)]);
      } else {
        const fetch = call.args.slice(call.args.indexOf("fetch"));
        expect(fetch.slice(0, 5)).toEqual(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--"]);
        expect(fetch[5]).toBe(world.app);
        expect(fetch[6]).toMatch(/^refs\/heads\/[^:]+:refs\/mc-publish\/(branch|base)$/);
      }
    }
    // The app folder is as it was: still on main, nothing new in it.
    expect(git(world.app, "branch", "--show-current")).toBe("main");
    expect(git(world.app, "status", "--porcelain")).toBe("");
  });

  it("removes its temporary folder, after a success and after a refusal", () => {
    const world = setup();
    expect(run(["publish", ID, ...TO]).status).toBe(0);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(run(["publish", ID, ...TO], { env: { FAKE_GH_FAIL: "boom" } }).status).toBe(1);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    writeMission(world, { status: "queued" });
    expect(run(["publish", ID]).status).toBe(1);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("reads the mission in a small box: read-only, no network, no logins, one read-only mount, no variables", () => {
    setup();
    const r = run(["publish", ID, ...TO]);
    const facts = r.docker.find((call) => call[0] === "run");
    expect(facts).toBeDefined();
    const call = facts!;
    expect(call).toEqual(expect.arrayContaining(["--rm", "--init", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges"]));
    expect(call[call.indexOf("--network") + 1]).toBe("none");
    const volumes = call.flatMap((arg, i) => (call[i - 1] === "--volume" ? [arg] : []));
    expect(volumes).toEqual(["mc-home:/home/pwuser/.mission-control:ro"]);
    expect(call).not.toContain("--env");
    expect(call).not.toContain("--publish");
    expect(call.join(" ")).not.toMatch(/mc-claude|mc-codex|mc-apps|token|GH_|GITHUB/);
    expect(call[call.indexOf("--entrypoint") + 1]).toBe("node");
    expect(call.at(-2)).toBe("--");
    expect(call.at(-1)).toBe(ID);
    // Docker is asked first whether it runs and whether the image exists, like for every other command.
    expect(r.docker[0]).toEqual(["info"]);
    expect(r.docker[1]).toEqual(["image", "inspect", IMAGE]);
  });

  it("opens a draft with the mission's title, and the leader's plan code when the leader wrote the plan", () => {
    setup({ plan: { sha256: "ab".repeat(32), at: "2000-01-01T00:00:00.000Z" } });
    const body = run(["publish", ID, ...TO]).gh[0]!.body!;
    expect(body).toContain("This is a draft pull request opened by Mission Control. Nothing is merged until you merge it.");
    expect(body).toContain(`- Mission: “Dark mode” (\`${ID}\`)`);
    expect(body).toContain(`- Branch: \`mc/${ID}\`, to be merged into \`main\``);
    expect(body).toContain("- Plan: written by the leader (plan code abababab)");
  });

  it("works when the home folder has a space in its name", () => {
    const spaced = path.join(tmp, "my home dir");
    fs.renameSync(home, spaced);
    home = spaced;
    const world = setup();
    const r = run(["publish", ID, ...TO]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
  });

  it("names no plan when the team's own planner wrote it", () => {
    setup();
    expect(run(["publish", ID, ...TO]).gh[0]!.body).not.toContain("- Plan:");
  });

  it("says plainly when nobody looked, and counts tests only for the features that have them", () => {
    setup({
      features: [
        { id: "a", title: "A", status: "done", frozenTests: [{ path: "t", sha256: "0" }] },
        { id: "b", title: "B", status: "done", frozenTests: [] },
        { id: "c", title: "C", status: "done" },
      ],
    });
    const body = run(["publish", ID, ...TO]).gh[0]!.body!;
    expect(body).toContain("- Tests: the team wrote tests before the code for 1 of 3 finished features. A feature counts as finished only when its tests and the app's own checks pass.");
    expect(body).toContain("- People: nobody looked at this before it was published. No stop for the owner's look was asked for.");
    expect(body).not.toContain("the owner answered");
    expect(body).not.toMatch(/\b(nobody|no one) (ran|tried|opened)\b/i);
  });

  it("lists the stops the owner answered, once each, and says Mission Control cannot tell what was looked at", () => {
    setup({
      checkpoints: ["plan", "final"],
      checkpointLog: [
        { id: "plan#1", scope: "plan", kind: "plan", round: 1, decision: "send_back", note: "SECRET NOTE", at: "2000-01-01T00:00:00.000Z" },
        { id: "plan#2", scope: "plan", kind: "plan", round: 2, decision: "approve", at: "2000-01-01T00:00:00.000Z" },
        { id: "feature:dark-mode#1", scope: "feature:dark-mode", kind: "feature", featureId: "dark-mode", round: 1, decision: "approve", at: "2000-01-01T00:00:00.000Z" },
        { id: "final#1", scope: "final", kind: "final", round: 1, decision: "approve", at: "2000-01-01T00:00:00.000Z" },
      ],
    });
    const body = run(["publish", ID, ...TO]).gh[0]!.body!;
    expect(body).toContain("- People: the owner answered at these stops: the plan: sent back; the plan: approved; the feature “Dark mode switch”: approved; the finished app: approved. Mission Control records each answer. It cannot tell what the owner looked at.");
    expect(body).not.toContain("nobody looked");
    expect(body).not.toContain("SECRET NOTE");
  });

  it("says when a stop was asked for and no approval is recorded", () => {
    setup({ checkpoints: ["plan", "final"], checkpointLog: [{ id: "plan#1", scope: "plan", kind: "plan", round: 1, decision: "approve", at: "2000-01-01T00:00:00.000Z" }] });
    const body = run(["publish", ID, ...TO]).gh[0]!.body!;
    expect(body).toContain("the owner answered at these stops: the plan: approved.");
    expect(body).toContain("- People: a stop at the finished app was asked for, but no approval is recorded.");
  });

  it("reports unfinished reviews and checks that were already failing, from the mission's own notes", () => {
    setup({
      baselineBroken: true,
      notes: ['The review of "Dark mode switch" did not finish, so it was merged after passing its checks.', "Something else."],
    });
    const body = run(["publish", ID, ...TO]).gh[0]!.body!;
    expect(body).toContain("- The app's own checks were already failing before this work started, so only the new tests judged the new work.");
    expect(body).toContain("- Review: a separate AI reviewer reads each feature before it is added. 1 review(s) did not finish. Those features were added after their tests passed.");
  });

  it("a partly done mission is published as a draft with its unfinished features listed", () => {
    const world = setup();
    writeMission(world, {
      status: "partial",
      features: [
        { id: "a", title: "Dark mode switch", status: "done", frozenTests: [{ path: "t", sha256: "0" }] },
        { id: "b", title: "Remember my choice", status: "blocked" },
        { id: "c", title: "Follow the system setting", status: "skipped" },
        { id: "d", title: "Last one", status: "pending" },
      ],
    });
    const r = run(["publish", ID, ...TO]);
    expect(r.status).toBe(0);
    expect(r.gh[0]!.args).toContain("--draft");
    const body = r.gh[0]!.body!;
    expect(body).toContain("**This mission is only partly done.** 1 of 4 features are finished.");
    expect(body).toContain("## Not finished");
    expect(body).toContain("- “Remember my choice” (stuck)");
    expect(body).toContain("- “Follow the system setting” (left out)");
    expect(body).toContain("- “Last one” (not finished)");
    expect(body).not.toContain("“Dark mode switch” (");
  });

  it("puts the first lines of the report in the body, without the steps for this PC and without pictures, in a fence the text can't close", () => {
    const world = setup();
    const report = [
      "# Dark mode",
      "",
      "**Done** · 1 of 1 features done",
      "",
      "I worked on your request for widgets.",
      "",
      "## How to try it",
      "",
      "1. cd /home/pwuser/mc-apps/widgets",
      "2. git checkout --detach mc/test-dark-mode",
      "",
      "## Needs your decision",
      "",
      "Nothing. @everyone see #12 and <b>this</b> ~~~~ ``` stay as they are inside the fence.",
      "![shot](screenshots/a.png)",
      `	A tab and a bell ${BEL} and an escape ${ESC}[31m are cleaned.`,
      "## Usage",
      "tokens: 12",
    ].join("\n");
    fs.writeFileSync(path.join(mcHome, "missions", ID, "report.md"), report);
    void world;
    const body = run(["publish", ID, ...TO]).gh[0]!.body!;
    const fenced = body.split("## From the report\n\n")[1]!;
    expect(fenced.startsWith("~~~~~\n")).toBe(true);
    expect(fenced.trimEnd().endsWith("\n~~~~~")).toBe(true);
    expect(fenced).toContain("# Dark mode");
    expect(fenced).toContain("## Needs your decision");
    expect(fenced).toContain("Nothing. @everyone see #12 and <b>this</b> ~~~~ ``` stay as they are inside the fence.");
    expect(fenced).not.toContain("How to try it");
    expect(fenced).not.toContain("cd /home/pwuser");
    expect(fenced).not.toContain("![shot]");
    expect(fenced).not.toContain("tokens: 12");
    expect(fenced).toContain("  A tab and a bell   and an escape  [31m are cleaned.");
    expect(hasControl(body)).toBe(false);
  });

  it("says so when the mission has no report", () => {
    setup();
    expect(run(["publish", ID, ...TO]).gh[0]!.body).toContain("No report was written for this mission.");
  });

  it("makes a title safe: no control or invisible characters, at most 100 characters, one argument that can't be read as an option", () => {
    const world = setup();
    const long = `${"x".repeat(150)}`;
    writeMission(world, { title: `--force${BEL}${ESC}[31m${u(0x202e, 0x200b)}Dark
	mode ${long}` });
    const r = run(["publish", ID, ...TO]);
    expect(r.status).toBe(0);
    const title = r.gh[0]!.args.find((a) => a.startsWith("--title="))!;
    expect(title.startsWith("--title=--force")).toBe(true);
    expect(r.gh[0]!.args).not.toContain("--force");
    const text = title.slice("--title=".length);
    expect(Array.from(text).length).toBeLessThanOrEqual(100);
    expect(text).toContain("--force [31mDark mode");
    expect(hasControl(text)).toBe(false);
    expect(r.gh[0]!.args.filter((a) => a.startsWith("--title="))).toHaveLength(1);
  });

  it("leaves out of the body the characters that would tag a person, link an issue or a web address, or add HTML", () => {
    const world = setup();
    writeMission(world, {
      title: "Hi @everyone fix #12 <img src=x> see https://evil.example/x `code`",
      features: [{ id: "a", title: "Thanks @octocat", status: "blocked" }],
      status: "partial",
    });
    const body = run(["publish", ID, ...TO]).gh[0]!.body!;
    const head = body.split("## From the report")[0]!;
    for (const left of ["@everyone", "#12", "<img", "@octocat", "`code`", "://"]) expect(head, left).not.toContain(left);
    expect(head).toContain("“Hi everyone fix 12 img src=x see https:evil.example/x code”");
    expect(head).toContain("“Thanks octocat”");
  });

  it("without gh, it uploads the branch and prints the address to open the pull request yourself", () => {
    const world = setup();
    const r = run(["publish", ID, ...TO], { gh: false });
    expect(r.status).toBe(0);
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
    expect(r.gh).toEqual([]);
    expect(r.stdout).toContain("the GitHub tool gh is not installed here, so I did not open the pull request.");
    expect(r.stdout).toContain(`open it yourself: https://github.com/acme/widgets/compare/main...mc/${ID}?expand=1`);
  });

  it("when gh fails, the branch stays uploaded, it prints what gh said and the address to open it yourself, and exits 1", () => {
    const world = setup();
    const r = run(["publish", ID, ...TO], { env: { FAKE_GH_FAIL: "To authenticate, please run: gh auth login" } });
    expect(r.status).toBe(1);
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
    expect(r.stderr).toContain("the branch is on GitHub, but I could not open the draft pull request. gh said:");
    expect(r.stderr).toContain("To authenticate, please run: gh auth login");
    expect(r.stderr).toContain(`open it yourself: https://github.com/acme/widgets/compare/main...mc/${ID}?expand=1`);
    expect(r.stderr).toContain("gh auth login");
  });

  it("when a pull request for the branch exists already, it prints that address and succeeds", () => {
    setup();
    const r = run(["publish", ID, ...TO], { env: { FAKE_GH_EXISTS: "https://github.com/acme/widgets/pull/3" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("a pull request for this branch already exists: https://github.com/acme/widgets/pull/3");
  });

  it("does not trust an address in gh's answer that is not for this repository", () => {
    setup();
    const r = run(["publish", ID, ...TO], { env: { FAKE_GH_URL: "https://evil.example/acme/widgets/pull/7\nhttps://github.com/other/thing/pull/9" } });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("evil.example");
    expect(r.stderr).toContain("open it yourself:");
  });

  it("works for the ssh form of the address", () => {
    const world = setup({}, { origin: "git@github.com:acme/widgets.git" });
    const r = run(["publish", ID, ...TO]);
    expect(r.status).toBe(0);
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
    const remote = r.git.find((c) => c.args.includes("remote") && c.args.includes("add"))!;
    expect(remote.args.slice(-2)).toEqual(["origin", "git@github.com:acme/widgets.git"]);
    expect(remote.ssh).toContain("BatchMode=yes");
  });

  it("publishes again after more work: the same branch, a plain fast-forward", () => {
    const world = setup();
    expect(run(["publish", ID, ...TO]).status).toBe(0);
    git(world.app, "checkout", "-q", `mc/${ID}`);
    fs.writeFileSync(path.join(world.app, "more.css"), "a {}\n");
    git(world.app, "add", "-A");
    git(world.app, "commit", "-q", "-m", "More");
    git(world.app, "checkout", "-q", "main");
    const second = run(["publish", ID, ...TO], { env: { FAKE_GH_EXISTS: "https://github.com/acme/widgets/pull/7" } });
    expect(second.status).toBe(0);
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(git(world.app, "rev-parse", `mc/${ID}`));
  });
});

describe("publish: what it refuses, with a plain sentence for each, and what stays untouched", () => {
  /** Checks a refusal: status 1, the message, and that nothing was uploaded and gh never ran. */
  function expectRefused(r: Result, message: string | RegExp, world?: World): void {
    expect(r.status).toBe(1);
    const flat = r.stderr.replace(/\nmc-docker: /g, " ");
    expect(flat).toMatch(message instanceof RegExp ? message : new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(pushes(r)).toEqual([]);
    expect(r.gh).toEqual([]);
    if (world) expect(hubHead(world.bare, `mc/${ID}`)).toBeUndefined();
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  }

  it("a mission that does not exist", () => {
    setup();
    expectRefused(run(["publish", "no-such-mission"]), 'I can\'t find a mission called "no-such-mission". See the names with: mc status');
  });

  it.each([
    ["queued", /is not finished \(its state is "queued"\), so I did not publish it/],
    ["running", /is not finished \(its state is "running"\)/],
    ["waiting", /is not finished \(its state is "waiting"\)/],
    ["stopped", /is not finished \(its state is "stopped"\)/],
    ["failed", /stopped and needs your help, so I did not publish it\. Read what it needs with: mc report test-dark-mode/],
  ])("a %s mission", (status, message) => {
    const world = setup({ status });
    expectRefused(run(["publish", ID]), message, world);
  });

  it("a state it does not know", () => {
    const world = setup({ status: "banana; rm -rf /" });
    expectRefused(run(["publish", ID]), /is not finished \(its state is "banana; rm -rf \/"\)/, world);
  });

  it("a branch with no new work", () => {
    const world = setup({}, { branch: false });
    git(world.app, "branch", `mc/${ID}`);
    expectRefused(run(["publish", ID]), `There is nothing to publish: mc/${ID} has no new work compared with "main".`, world);
  });

  it("a branch that is not in the app folder", () => {
    const world = setup({}, { branch: false });
    expectRefused(run(["publish", ID]), `I could not read the branch mc/${ID} in ~/mc-apps/widgets, so there is nothing to publish. Git said:`, world);
  });

  it("an app folder that is gone, is a link, or is not a git folder", () => {
    const world = setup();
    const moved = `${world.app}-moved`;
    fs.renameSync(world.app, moved);
    expectRefused(run(["publish", ID]), "~/mc-apps/widgets is not a folder here, so I did not publish.", world);
    fs.symlinkSync(moved, world.app);
    expectRefused(run(["publish", ID]), "~/mc-apps/widgets is not a folder here, so I did not publish.", world);
    fs.rmSync(world.app);
    fs.mkdirSync(world.app);
    expectRefused(run(["publish", ID]), "~/mc-apps/widgets is not a plain git folder", world);
  });

  it("an app folder whose .git is a link or a file", () => {
    const world = setup();
    const dotGit = path.join(world.app, ".git");
    fs.renameSync(dotGit, path.join(tmp, "real-dot-git"));
    fs.symlinkSync(path.join(tmp, "real-dot-git"), dotGit);
    expectRefused(run(["publish", ID]), "is not a plain git folder", world);
    fs.rmSync(dotGit);
    fs.writeFileSync(dotGit, `gitdir: ${path.join(tmp, "real-dot-git")}\n`);
    expectRefused(run(["publish", ID]), "is not a plain git folder", world);
  });

  it("an app with no GitHub address yet, with the steps to give it one", () => {
    const world = setup({}, { origin: null });
    const r = run(["publish", ID]);
    expectRefused(r, "~/mc-apps/widgets has no GitHub address yet (no \"origin\"), so I did not publish.", world);
    expect(r.stderr).toContain("git -C ~/mc-apps/widgets remote add origin https://github.com/<owner>/<repo>.git");
    expect(r.stderr).toContain("git -C ~/mc-apps/widgets push origin main");
  });

  it.each([
    ["another host", "https://gitlab.com/acme/widgets.git"],
    ["a look-alike host", "https://github.com.evil.example/acme/widgets.git"],
    ["a login inside the address", "https://acme:github_pat_SECRET@github.com/acme/widgets.git"],
    ["the long ssh form", "ssh://git@github.com/acme/widgets.git"],
    ["a folder on this PC", "/tmp/somewhere"],
    ["a file address", "file:///tmp/somewhere"],
    ["an ext address", "ext::sh -c touch% /tmp/pwned"],
    ["plain http", "http://github.com/acme/widgets.git"],
    ["a path under the repository", "https://github.com/acme/widgets/tree/main"],
  ])("an origin that is %s", (_name, origin) => {
    const world = setup({}, { origin });
    const r = run(["publish", ID]);
    expectRefused(r, "The GitHub address of ~/mc-apps/widgets is not a plain github.com address, so I did not publish.", world);
    expect(r.stderr).toContain("with no login or password inside it");
    expect(r.stderr).not.toContain("SECRET");
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
  });

  it("two origin addresses", () => {
    const world = setup();
    git(world.app, "config", "--add", "remote.origin.url", "https://github.com/acme/other.git");
    expectRefused(run(["publish", ID]), "is not a plain github.com address", world);
  });

  it("a base branch that is not on GitHub yet, with the one command that fixes it", () => {
    const world = setup();
    git(world.bare, "branch", "-m", "main", "trunk");
    const r = run(["publish", ID, ...TO]);
    expectRefused(r, 'The branch "main" is not on GitHub in acme/widgets yet', world);
    expect(r.stderr).toContain("git -C ~/mc-apps/widgets push origin main");
  });

  it("a repository on GitHub that cannot be reached", () => {
    const world = setup({}, { origin: "https://github.com/acme/gone.git" });
    const r = run(["publish", ID, "--to", "acme/gone"]);
    expectRefused(r, "I could not reach acme/gone on GitHub. Git said:", world);
    expect(r.stderr).toContain("gh auth login");
  });

  it("a branch that already exists on GitHub with other work: never overwritten, never forced", () => {
    const world = setup();
    // Someone else made mc/<id> on GitHub from main with a different commit.
    const other = path.join(tmp, "other");
    git(tmp, "clone", "-q", world.bare, other);
    git(other, "checkout", "-q", "-b", `mc/${ID}`);
    fs.writeFileSync(path.join(other, "theirs.txt"), "theirs\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "Theirs");
    git(other, "push", "-q", "origin", `mc/${ID}`);
    const theirs = git(other, "rev-parse", "HEAD");
    const r = run(["publish", ID, ...TO]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`GitHub already has a branch called mc/${ID} with other work on it. I never overwrite it.`);
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(theirs);
    expect(r.gh).toEqual([]);
    expect(pushes(r)).toHaveLength(1);
    expect(pushes(r)[0]!.args.join(" ")).not.toMatch(/force|\+/);
  });

  it.each([
    ["a pre-push hook in the app", (app: string) => {
      fs.writeFileSync(path.join(app, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }],
    ["a hooks folder set in the app's settings", (app: string) => {
      git(app, "config", "core.hooksPath", ".husky");
    }],
    ["Git LFS in a file the branch has", (app: string) => {
      git(app, "checkout", "-q", `mc/${ID}`);
      fs.writeFileSync(path.join(app, ".gitattributes"), "*.psd filter=lfs diff=lfs merge=lfs -text\n");
      git(app, "add", "-A");
      git(app, "commit", "-q", "-m", "lfs");
      git(app, "checkout", "-q", "main");
    }],
    ["Git LFS in a folder of the branch", (app: string) => {
      git(app, "checkout", "-q", `mc/${ID}`);
      fs.mkdirSync(path.join(app, "assets"));
      fs.writeFileSync(path.join(app, "assets", ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
      git(app, "add", "-A");
      git(app, "commit", "-q", "-m", "lfs");
      git(app, "checkout", "-q", "main");
    }],
  ])("%s: never run, so it does not upload and says how to do it by hand", (_name, change) => {
    const world = setup();
    change(world.app);
    const r = run(["publish", ID]);
    expectRefused(r, "uses git hooks or Git LFS (big-file storage), which Mission Control never runs, so I did not publish.", world);
    expect(r.stderr).toContain(`git -C ~/mc-apps/widgets push origin mc/${ID}`);
  });

  it("a record whose branch is not mc/<id>, such as main", () => {
    const world = setup();
    writeMission(world, { integrationBranch: "main" });
    expectRefused(run(["publish", ID]), `the branch in the record of "${ID}" is not mc/${ID}, so I did not publish.`, world);
    for (const branch of ["master", "mc/other", `mc/${ID}/x`, "mc/../main", "refs/heads/main", ""]) {
      writeMission(world, { integrationBranch: branch });
      expect(run(["publish", ID]).status, branch).toBe(1);
    }
    expect(hubHead(world.bare, "main")).toBe(world.mainSha);
  });

  it.each([
    "--upload-pack=touch /tmp/pwned",
    "-x",
    "..",
    ".",
    "../main",
    "main..x",
    "a//b",
    "main/",
    "x.lock",
    "x.",
    "a b",
    "a;b",
    "a$(b)",
    "a\nb",
    "",
    `caf${u(0xe9)}`,
    "b".repeat(200),
  ])("a record whose base branch is %j", (base) => {
    const world = setup();
    writeMission(world, { baseBranch: base });
    expectRefused(run(["publish", ID]), `the base branch in the record of "${ID}" is not a plain branch name, so I did not publish.`, world);
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
  });

  it.each([
    ["a folder outside ~/mc-apps", "/etc"],
    ["the apps folder itself", "/home/pwuser/mc-apps"],
    ["a folder beside it", "/home/pwuser/mc-apps-old/widgets"],
    ["a way out of it", "/home/pwuser/mc-apps/../.ssh"],
    ["a deeper folder", "/home/pwuser/mc-apps/group/widgets"],
    ["a dotted name", "/home/pwuser/mc-apps/.ssh"],
    ["a name with a space", "/home/pwuser/mc-apps/my app"],
    ["a name with a dollar sign", "/home/pwuser/mc-apps/$HOME"],
    ["an option as a name", "/home/pwuser/mc-apps/--upload-pack=x"],
    ["an empty path", ""],
  ])("a record whose app folder is %s", (_name, repoPath) => {
    const world = setup();
    writeMission(world, { repoPath });
    const r = run(["publish", ID]);
    expectRefused(r, /not inside ~\/mc-apps|has characters that publish does not accept|is not a folder here/, world);
    expect(r.git.filter((c) => c.args.includes("fetch"))).toEqual([]);
  });

  it("a base branch with a slash in its name works", () => {
    const world = setup();
    git(world.app, "branch", "release/1.0", "main");
    git(world.app, "push", "-q", "origin", "release/1.0");
    git(world.app, "checkout", "-q", `mc/${ID}`);
    git(world.app, "rebase", "-q", "--onto", "release/1.0", "main");
    git(world.app, "checkout", "-q", "main");
    writeMission(world, { baseBranch: "release/1.0", baseSha: git(world.app, "rev-parse", "release/1.0") });
    const r = run(["publish", ID, ...TO]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.gh[0]!.args).toEqual(expect.arrayContaining(["--base", "release/1.0"]));
    expect(r.stdout).toContain('The base branch "release/1.0" was not changed.');
  });

  it("a record that belongs to another mission, is not a plain file, or can't be read", () => {
    const world = setup();
    writeMission(world, { id: "someone-else" });
    expectRefused(run(["publish", ID]), `the record in the mission folder "${ID}" belongs to another mission`, world);
    const file = path.join(mcHome, "missions", ID, "mission.json");
    fs.rmSync(file);
    fs.symlinkSync(path.join(tmp, "elsewhere.json"), file);
    expectRefused(run(["publish", ID]), /I (could not read the record|can't find a mission)/, world);
    fs.rmSync(file);
    fs.writeFileSync(file, "{ not json");
    expectRefused(run(["publish", ID]), `I could not read the record of the mission "${ID}".`, world);
    fs.writeFileSync(file, "[]");
    expectRefused(run(["publish", ID]), "I could not read the record", world);
    expectRefused(run(["publish", ID], { env: { FAKE_FACTS_STATUS: "125" } }), "I could not read the record", world);
  });

  it("a report that is a link to another file is not read", () => {
    setup();
    const secret = path.join(tmp, "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET\n");
    fs.symlinkSync(secret, path.join(mcHome, "missions", ID, "report.md"));
    const r = run(["publish", ID, ...TO]);
    expect(r.status).toBe(0);
    expect(r.gh[0]!.body).not.toContain("TOP SECRET");
    expect(r.gh[0]!.body).toContain("No report was written for this mission.");
  });

  it("needs Docker and the image like every other command that reads missions, and refuses root", () => {
    setup();
    const stopped = run(["publish", ID], { env: { FAKE_INFO_FAILS: "1" } });
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain("Docker isn't running");
    const noImage = run(["publish", ID], { env: { FAKE_IMAGE_MISSING: "1" } });
    expect(noImage.status).toBe(1);
    expect(noImage.stderr).toContain("the Mission Control image isn't built yet. Run: mc build");
    const root = run(["publish", ID], { env: { FAKE_UID: "0" } });
    expect(root.status).toBe(1);
    expect(root.stderr).toContain("without sudo");
    expect(root.docker).toEqual([]);
  });

  const HOSTILE_IDS = [
    "--force",
    "-f",
    "--upload-pack=touch /tmp/pwned",
    "..",
    ".",
    "../x",
    "a/b",
    "/etc/passwd",
    "a..b",
    "a b",
    "a;touch /tmp/pwned",
    "a&&b",
    "a|b",
    "$(touch /tmp/pwned)",
    "`touch /tmp/pwned`",
    "a\nb",
    "a\n",
    "",
    "main",
    "mc/main",
    `${u(0x430)}bc`,
    `caf${u(0xe9)}`,
    `a${u(0x200b)}b`,
    `a${u(0x202e)}b`,
    ".hidden",
    "_x",
    "x".repeat(129),
  ];

  it.each(HOSTILE_IDS)("refuses the mission name %j before it touches Docker or git", (id) => {
    setup();
    const r = run(["publish", id]);
    expect(r.status).toBe(1);
    if (id === "main") {
      // A well-formed name that is simply not a mission.
      expect(r.stderr).toContain("I can't find a mission called");
    } else if (id === "mc/main") {
      expect(r.stderr).toContain("is not a mission name");
    } else {
      expect(r.stderr).toContain("is not a mission name. A mission name uses letters, digits, dots and dashes");
      expect(r.docker).toEqual([]);
    }
    expect(r.git).toEqual([]);
    expect(r.gh).toEqual([]);
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
    expect(r.stderr).not.toMatch(/[^\n\x20-\x7e]/);
  });

  it("needs exactly one mission name", () => {
    for (const args of [["publish"], ["publish", ID, "extra"], ["publish", "--force", ID]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr).toContain("publish needs the name of one mission");
      expect(r.docker).toEqual([]);
    }
  });
});

describe("publish: an app folder that an AI could have written git settings and hooks into", () => {
  it("does not run any command those settings or hooks name, and does not follow their addresses", () => {
    const world = setup();
    const marker = path.join(tmp, "MARKER");
    const bomb = path.join(tmp, "bomb.sh");
    fs.writeFileSync(bomb, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    const extra = path.join(tmp, "extra.config");
    fs.writeFileSync(extra, `[core]\n\tfsmonitor = ${bomb}\n[remote "origin"]\n\turl = https://evil.example/acme/widgets.git\n`);
    const config = fs.readFileSync(path.join(world.app, ".git", "config"), "utf8");
    fs.writeFileSync(
      path.join(world.app, ".git", "config"),
      `${config}
[core]
	fsmonitor = ${bomb}
	sshCommand = ${bomb}
	gitProxy = ${bomb}
	pager = ${bomb}
	editor = ${bomb}
	askPass = ${bomb}
	alternateRefsCommand = ${bomb}
[credential]
	helper = !${bomb}
[uploadpack]
	packObjectsHook = ${bomb}
[url "https://evil.example/"]
	insteadOf = https://github.com/
[remote "origin"]
	pushurl = https://evil.example/acme/widgets.git
	receivepack = ${bomb}
	uploadpack = ${bomb}
[alias]
	push = !${bomb}
	fetch = !${bomb}
[include]
	path = ${extra}
[includeIf "gitdir:${world.app}/.git"]
	path = ${extra}
[diff]
	external = ${bomb}
[filter "lfs"]
	process = ${bomb}
	clean = ${bomb}
`,
    );
    for (const hook of ["post-checkout", "post-merge", "post-commit", "reference-transaction", "pre-auto-gc", "post-rewrite", "fsmonitor-watchman"]) {
      fs.writeFileSync(path.join(world.app, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    }
    const r = run(["publish", ID, ...TO]);
    expect(fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "").toBe(false);
    expect(r.status, r.stderr).toBe(0);
    // It went to the address in "origin", and to no address the settings named.
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
    expect(r.stdout).not.toContain("evil.example");
    expect(r.git.some((c) => c.args.some((a) => a.includes("evil.example")))).toBe(false);
  });
});

// ───────────────────────────── where publish may upload to (finding F2 of the Wave 1 check) ─────────────────────────────
//
// The AI team writes in the app folder, so the address in its .git/config can be changed to another repository the owner
// can write to. publish must therefore never take that address on trust: `get` saves the repository it downloaded from in
// a note outside the container, publish refuses an address that differs from the note, and publish only uploads where the
// person named the repository, after seeing it in the preview.

/** The note `get` and `publish` keep, outside the container, of the repository an app folder belongs to. */
const noteFile = (app = "widgets"): string => path.join(home, ".config", "mission-control", "origins", app);

/** A world made the way an owner makes one: `get` downloads the repository, then a mission adds the branch mc/<ID>. */
function viaGet(): World {
  const bare = addHubRepo("acme", "widgets");
  expect(run(["get", "acme/widgets"]).status).toBe(0);
  const app = path.join(home, "mc-apps", "widgets");
  const mainSha = git(app, "rev-parse", "main");
  git(app, "checkout", "-q", "-b", `mc/${ID}`);
  fs.writeFileSync(path.join(app, "dark.css"), "body { background: black; }\n");
  git(app, "add", "-A");
  git(app, "commit", "-q", "-m", "Add dark mode");
  git(app, "checkout", "-q", "main");
  const world = { app, bare, mainSha, branchSha: git(app, "rev-parse", `mc/${ID}`) };
  writeMission(world);
  return world;
}

/** What the AI team could do: point the app's "origin" at another repository on github.com. */
function redirect(world: World, to: string): void {
  git(world.app, "remote", "set-url", "origin", `https://github.com/${to}.git`);
}

/** A refusal: status 1, the words in the message (the lines of stderr joined), and nothing uploaded. */
function refused(r: Result, message: string, others: string[] = []): void {
  expect(r.status, r.stdout + r.stderr).toBe(1);
  const flat = r.stderr.replace(/\nmc-docker: /g, " ");
  expect(flat).toContain(message);
  expect(pushes(r)).toEqual([]);
  expect(r.gh).toEqual([]);
  for (const other of others) expect(hubHead(other, `mc/${ID}`)).toBeUndefined();
  expect(fs.readdirSync(tmpDir)).toEqual([]);
}

describe("get: it remembers which repository the folder came from", () => {
  it("saves a note outside the apps folder and says what it means", () => {
    addHubRepo("acme", "widgets");
    const r = run(["get", "acme/widgets"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("mc-docker: Mission Control will publish finished work from ~/mc-apps/widgets only to acme/widgets.");
    expect(fs.readFileSync(noteFile(), "utf8")).toBe("acme/widgets\n");
    expect(noteFile().startsWith(path.join(home, "mc-apps"))).toBe(false);
  });

  it("names the note like the folder, and writes the same owner and repository for the ssh form", () => {
    addHubRepo("acme", "widgets");
    expect(run(["get", "git@github.com:acme/widgets.git", "my-widgets"]).status).toBe(0);
    expect(fs.readFileSync(noteFile("my-widgets"), "utf8")).toBe("acme/widgets\n");
    expect(fs.existsSync(noteFile("widgets"))).toBe(false);
  });

  it("still downloads when the note can't be saved, and says so", () => {
    addHubRepo("acme", "widgets");
    fs.writeFileSync(path.join(home, ".config"), "not a folder");
    const r = run(["get", "acme/widgets"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("I could not save a note of where ~/mc-apps/widgets came from. Publishing from it will ask you to name the repository.");
    expect(r.stdout).not.toContain("only to acme/widgets");
    expect(fs.existsSync(path.join(home, "mc-apps", "widgets", "README.md"))).toBe(true);
  });

  it("changes no note when it refuses", () => {
    addHubRepo("acme", "widgets");
    fs.mkdirSync(path.join(home, "mc-apps", "widgets"), { recursive: true });
    fs.mkdirSync(path.dirname(noteFile()), { recursive: true });
    fs.writeFileSync(noteFile(), "other/thing\n");
    expect(run(["get", "acme/widgets"]).status).toBe(1);
    expect(run(["get", "https://evil.example/acme/widgets", "widgets"]).status).toBe(1);
    expect(fs.readFileSync(noteFile(), "utf8")).toBe("other/thing\n");
  });

  it("replaces an old note when a repository is downloaded again into a folder that was removed", () => {
    addHubRepo("acme", "widgets");
    addHubRepo("acme", "gadgets");
    expect(run(["get", "acme/widgets", "app"]).status).toBe(0);
    fs.rmSync(path.join(home, "mc-apps", "app"), { recursive: true, force: true });
    expect(run(["get", "acme/gadgets", "app"]).status).toBe(0);
    expect(fs.readFileSync(noteFile("app"), "utf8")).toBe("acme/gadgets\n");
  });
});

describe("publish-preview: where the work would go, and nothing uploaded", () => {
  it("says the repository, that nothing was uploaded, and the exact line to upload", () => {
    const world = setup();
    const r = run(["publish-preview", ID]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean)).toEqual([
      `mc-docker: “Dark mode” (${ID}) is ready to publish.`,
      `mc-docker: It would go to github.com/acme/widgets: the branch mc/${ID}, and then a draft pull request into "main".`,
      "mc-docker: Mission Control does not know where ~/mc-apps/widgets came from, and the AI team can change its GitHub address. Check that acme/widgets is the repository you mean.",
      "mc-docker: Nothing has been uploaded.",
      `mc-docker: To upload it: mc publish ${ID} --to acme/widgets`,
    ]);
    expect(hubHead(world.bare, `mc/${ID}`)).toBeUndefined();
  });

  it("does not touch GitHub, does not push, does not run gh, does not save a note, and leaves no temporary folder", () => {
    setup();
    const r = run(["publish-preview", ID]);
    expect(r.status).toBe(0);
    expect(pushes(r)).toEqual([]);
    expect(r.git.filter((c) => c.args.includes("ls-remote") || c.args.includes("remote") || c.args.includes("clone"))).toEqual([]);
    expect(r.gh).toEqual([]);
    expect(fs.existsSync(noteFile())).toBe(false);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    // It reads the mission in the same small box as publish does.
    expect(r.docker.filter((call) => call[0] === "run")).toHaveLength(1);
  });

  it("says when the folder was set up for this repository", () => {
    viaGet();
    const r = run(["publish-preview", ID]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("mc-docker: Mission Control set up ~/mc-apps/widgets for acme/widgets, and that is where it points.");
    expect(r.stdout).not.toContain("does not know where");
  });

  it("previews a partly finished mission too", () => {
    setup({ status: "partial" });
    const r = run(["publish-preview", ID]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("is ready to publish.");
  });

  it("refuses what publish refuses, with the same sentences, and prints nothing on stdout", () => {
    const cases: [string, Record<string, unknown>, { branch?: boolean; origin?: string | null }, string][] = [
      ["a mission that is not finished", { status: "queued" }, {}, 'is not finished (its state is "queued"), so I did not publish it.'],
      ["a mission that needs help", { status: "failed" }, {}, "stopped and needs your help, so I did not publish it."],
      ["a branch with no new work", {}, { branch: false }, `There is nothing to publish: mc/${ID} has no new work compared with "main".`],
      ["no GitHub address", {}, { origin: null }, '~/mc-apps/widgets has no GitHub address yet (no "origin"), so I did not publish.'],
      ["an address on another site", {}, { origin: "https://evil.example/acme/widgets.git" }, "is not a plain github.com address, so I did not publish."],
    ];
    for (const [name, extra, opts, message] of cases) {
      for (const dir of [path.join(home, "mc-apps"), hub, mcHome]) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
      }
      const world = setup(extra, opts);
      if (name === "a branch with no new work") git(world.app, "branch", `mc/${ID}`);
      const got = run(["publish-preview", ID]);
      expect(got.status, name).toBe(1);
      expect(got.stdout, name).toBe("");
      expect(got.stderr.replace(/\nmc-docker: /g, " "), name).toContain(message);
      expect(pushes(got), name).toEqual([]);
      expect(fs.readdirSync(tmpDir), name).toEqual([]);
    }
  });

  it("refuses an app that uses hooks or Git LFS, before it says anything about where the work would go", () => {
    const world = setup();
    fs.writeFileSync(path.join(world.app, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = run(["publish-preview", ID]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("uses git hooks or Git LFS (big-file storage), which Mission Control never runs, so I did not publish.");
  });

  it("takes one mission name and no --to", () => {
    setup();
    for (const args of [["publish-preview"], ["publish-preview", ID, "extra"], ["publish-preview", ID, "--to", "acme/widgets"], ["publish-preview", "--to", "acme/widgets", ID]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain("publish-preview needs the name of one mission");
      expect(r.docker, args.join(" ")).toEqual([]);
    }
  });

  it("refuses a hostile mission name before it touches Docker or git", () => {
    for (const id of ["../etc", "a/b", "-rf", "a;touch /tmp/pwned-preview", "$(touch /tmp/pwned-preview)", "a b", ""]) {
      const r = run(["publish-preview", id]);
      expect(r.status, id).toBe(1);
      expect(r.stderr, id).toContain("is not a mission name");
      expect(r.docker, id).toEqual([]);
      expect(r.git, id).toEqual([]);
    }
    expect(fs.existsSync("/tmp/pwned-preview")).toBe(false);
  });
});

describe("publish: it uploads only to the repository the person names", () => {
  it("without --to it shows where the work would go, uploads nothing and exits 1", () => {
    const world = setup();
    const r = run(["publish", ID]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("mc-docker: It would go to github.com/acme/widgets:");
    expect(r.stdout).toContain("mc-docker: Nothing has been uploaded.");
    expect(r.stderr).toBe(`mc-docker: publish uploads only where you tell it to, so I stopped here. To go on: mc publish ${ID} --to acme/widgets\n`);
    expect(pushes(r)).toEqual([]);
    expect(r.gh).toEqual([]);
    expect(hubHead(world.bare, `mc/${ID}`)).toBeUndefined();
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("uploads when --to names the repository, before or after the mission name", () => {
    const world = setup();
    const first = run(["publish", ID, "--to", "acme/widgets"]);
    expect(first.status, first.stderr).toBe(0);
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
    const second = run(["publish", "--to", "acme/widgets", ID], { env: { FAKE_GH_EXISTS: "https://github.com/acme/widgets/pull/7" } });
    expect(second.status, second.stderr).toBe(0);
  });

  it("matches the name without regard to capital letters", () => {
    const world = setup();
    const r = run(["publish", ID, "--to", "ACME/Widgets"]);
    expect(r.status, r.stderr).toBe(0);
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
  });

  it("refuses a repository other than the one the app points to, and names both", () => {
    const world = setup();
    const other = addHubRepo("acme", "other");
    const r = run(["publish", ID, "--to", "acme/other"]);
    refused(r, "You asked me to upload to acme/other, but ~/mc-apps/widgets points to acme/widgets, so I did not publish. See where the work would go with: mc publish-preview " + ID, [world.bare, other]);
  });

  it.each([
    ["only an owner", "acme"],
    ["no repository", "acme/"],
    ["no owner", "/widgets"],
    ["a third part", "acme/widgets/extra"],
    ["a web address", "https://github.com/acme/widgets"],
    ["the ssh form", "git@github.com:acme/widgets.git"],
    ["a dot repository", "acme/."],
    ["two dots", "acme/.."],
    ["an owner starting with a dash", "-x/widgets"],
    ["a space", "acme/wid gets"],
    ["a semicolon", "acme/widgets;touch /tmp/pwned-to"],
    ["a command in dollar brackets", "acme/$(touch /tmp/pwned-to)"],
    ["backticks", "acme/`touch /tmp/pwned-to`"],
    ["an option", "--force"],
    ["a look-alike letter", `acme/widg${u(0x435)}ts`],
    ["a zero-width space", `acme/widgets${u(0x200b)}`],
    ["a new line", "acme/widgets\nother/repo"],
    ["an over-long repository", `acme/${"a".repeat(101)}`],
    ["an empty text", ""],
  ])("refuses --to with %s before it touches Docker or git", (_name, value) => {
    setup();
    const r = run(["publish", ID, "--to", value]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not the name of a GitHub repository.");
    expect(r.stderr).toContain(`The name to use is the one mc publish-preview ${ID} prints.`);
    expect(r.docker).toEqual([]);
    expect(r.git).toEqual([]);
    expect(r.gh).toEqual([]);
    expect(r.stderr).not.toMatch(/[^\n\x20-\x7e]/);
    expect(fs.existsSync("/tmp/pwned-to")).toBe(false);
  });

  it.each([
    ["--to twice", ["publish", ID, "--to", "acme/widgets", "--to", "acme/widgets"]],
    ["--to without a repository", ["publish", ID, "--to"]],
    ["--to with an equals sign", ["publish", ID, "--to=acme/widgets"]],
    ["no mission name", ["publish", "--to", "acme/widgets"]],
    ["two mission names", ["publish", ID, "--to", "acme/widgets", "other"]],
  ])("needs one mission name and at most one --to: %s", (_name, args) => {
    setup();
    const r = run(args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("publish needs the name of one mission");
    expect(r.stderr).toContain("First see where the work would go: mc publish-preview");
    expect(r.docker).toEqual([]);
    expect(r.git).toEqual([]);
  });
});

describe("publish: the AI team changes the GitHub address of the app", () => {
  it("an address nobody set up a note for: the preview shows the new repository, and an upload needs that name", () => {
    const world = setup();
    const playground = addHubRepo("acme", "public-playground");
    redirect(world, "acme/public-playground");
    // What the repository the owner meant is told: --to acme/widgets does not go to the playground.
    refused(run(["publish", ID, "--to", "acme/widgets"]), "You asked me to upload to acme/widgets, but ~/mc-apps/widgets points to acme/public-playground, so I did not publish.", [world.bare, playground]);
    // Without --to nothing is uploaded either, and the preview shows where it would have gone.
    const bare = run(["publish", ID]);
    expect(bare.status).toBe(1);
    expect(bare.stdout).toContain("It would go to github.com/acme/public-playground:");
    expect(bare.stdout).toContain("does not know where ~/mc-apps/widgets came from");
    expect(pushes(bare)).toEqual([]);
    const preview = run(["publish-preview", ID]);
    expect(preview.stdout).toContain("It would go to github.com/acme/public-playground:");
    expect(hubHead(playground, `mc/${ID}`)).toBeUndefined();
    expect(hubHead(world.bare, `mc/${ID}`)).toBeUndefined();
  });

  it("a folder `get` downloaded: an address that differs from the note is refused, with the old name, the new name and what to do", () => {
    const world = viaGet();
    const playground = addHubRepo("acme", "public-playground");
    redirect(world, "acme/public-playground");
    const preview = run(["publish-preview", ID]);
    refused(preview, "~/mc-apps/widgets was set up for acme/widgets, but its GitHub address now says acme/public-playground, so I did not publish.", [world.bare, playground]);
    expect(preview.stdout).toBe("");
    // Even when the person names the new repository, because the note is the owner's record, not the AI team's.
    const named = run(["publish", ID, "--to", "acme/public-playground"]);
    refused(named, "~/mc-apps/widgets was set up for acme/widgets, but its GitHub address now says acme/public-playground, so I did not publish.", [world.bare, playground]);
    expect(named.stderr).toContain("The AI team can write in that folder, so a person has to check this before anything is uploaded.");
    expect(named.stderr).toContain("To see what the folder says: cat ~/mc-apps/widgets/.git/config");
    expect(named.stderr).toContain("If you changed the address on purpose, remove the old note and publish again: rm ~/.config/mission-control/origins/widgets");
    expect(fs.readFileSync(noteFile(), "utf8")).toBe("acme/widgets\n");
    expect(hubHead(playground, `mc/${ID}`)).toBeUndefined();
  });

  it("the owner can move a folder on purpose: remove the note, then name the new repository", () => {
    const world = viaGet();
    const playground = addHubRepo("acme", "public-playground");
    redirect(world, "acme/public-playground");
    fs.rmSync(noteFile());
    const r = run(["publish", ID, "--to", "acme/public-playground"], { env: { FAKE_GH_URL: "https://github.com/acme/public-playground/pull/7" } });
    expect(r.status, r.stderr).toBe(0);
    expect(hubHead(playground, `mc/${ID}`)).toBe(world.branchSha);
    expect(fs.readFileSync(noteFile(), "utf8")).toBe("acme/public-playground\n");
  });

  it("a folder `get` downloaded uploads normally, and the note does not change", () => {
    const world = viaGet();
    const r = run(["publish", ID, ...TO]);
    expect(r.status, r.stderr).toBe(0);
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
    expect(r.stdout).not.toContain("from now on");
    expect(fs.readFileSync(noteFile(), "utf8")).toBe("acme/widgets\n");
  });

  it("the first upload saves a note, and from then on a changed address is refused", () => {
    const world = setup();
    expect(fs.existsSync(noteFile())).toBe(false);
    const first = run(["publish", ID, ...TO]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("mc-docker: Mission Control will publish finished work from ~/mc-apps/widgets only to acme/widgets from now on.");
    expect(fs.readFileSync(noteFile(), "utf8")).toBe("acme/widgets\n");
    const playground = addHubRepo("acme", "public-playground");
    redirect(world, "acme/public-playground");
    refused(run(["publish", ID, "--to", "acme/public-playground"]), "was set up for acme/widgets, but its GitHub address now says acme/public-playground", [playground]);
  });

  it("a note that fails to be saved does not undo the upload", () => {
    const world = setup();
    fs.writeFileSync(path.join(home, ".config"), "not a folder");
    const r = run(["publish", ID, ...TO]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("I could not save a note of which repository ~/mc-apps/widgets belongs to.");
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
  });

  it("compares the note and the address without regard to capital letters", () => {
    const world = setup();
    fs.mkdirSync(path.dirname(noteFile()), { recursive: true });
    fs.writeFileSync(noteFile(), "ACME/Widgets\n");
    const r = run(["publish", ID, "--to", "Acme/WIDGETS"]);
    expect(r.status, r.stderr).toBe(0);
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
  });

  it("a note that is not a plain repository name counts as no note; a note that is a link is not followed", () => {
    const world = setup();
    fs.mkdirSync(path.dirname(noteFile()), { recursive: true });
    for (const text of ["not a repo!!\n", "acme/widgets/extra\n", "\n", "acme/other\nacme/widgets\n"]) {
      fs.writeFileSync(noteFile(), text);
      const preview = run(["publish-preview", ID]);
      // "acme/other" as a first line is a valid note for another repository: that one is refused.
      if (text.startsWith("acme/other")) expect(preview.status, text).toBe(1);
      else expect(preview.stdout, text).toContain("does not know where ~/mc-apps/widgets came from");
    }
    fs.rmSync(noteFile());
    const target = path.join(tmp, "elsewhere");
    fs.writeFileSync(target, "acme/other\n");
    fs.symlinkSync(target, noteFile());
    const preview = run(["publish-preview", ID]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("does not know where ~/mc-apps/widgets came from");
    const r = run(["publish", ID, ...TO]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("acme/other\n");
    expect(fs.lstatSync(noteFile()).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(noteFile(), "utf8")).toBe("acme/widgets\n");
    expect(hubHead(world.bare, `mc/${ID}`)).toBe(world.branchSha);
  });

  it("the container never sees the notes: the small box has one read-only mount, and no volume in the script names the config folder", () => {
    setup();
    const r = run(["publish-preview", ID]);
    const facts = r.docker.find((call) => call[0] === "run")!;
    const volumes = facts.flatMap((arg, i) => (facts[i - 1] === "--volume" ? [arg] : []));
    expect(volumes).toEqual(["mc-home:/home/pwuser/.mission-control:ro"]);
    expect(facts.join(" ")).not.toMatch(/\.config|origins|mission-control\/origins/);
    for (const line of fs.readFileSync(SCRIPT, "utf8").split("\n").filter((l) => l.includes("--volume"))) {
      expect(line, line).not.toMatch(/CONFIG_DIR|ORIGINS_DIR|\.config|origins/);
    }
  });
});

describe("publish: a new app, where the engine has moved main onto the finished work", () => {
  /** The shape of a real new-app mission, made by the real engine on the mock harness (test/fixtures/publish). */
  const REAL = JSON.parse(fs.readFileSync(path.join(REPO_DIR, "test", "fixtures", "publish", "real-greenfield-mission.json"), "utf8")) as Record<string, unknown> & { id: string; title: string };
  const GID = REAL.id;
  interface Fresh {
    app: string;
    firstSha: string;
    branchSha: string;
  }

  /**
   * An app Mission Control built from nothing: a first commit, the features on mc/<id>, and (as the engine does when a
   * new app is finished) main moved onto the branch, so both are the same commit. `lagging` leaves main where it was.
   */
  function freshWorld(opts: { origin?: string | null; lagging?: boolean; record?: Record<string, unknown> } = {}): Fresh {
    const app = path.join(home, "mc-apps", "fresh");
    fs.mkdirSync(app, { recursive: true });
    git(tmp, "init", "-q", "-b", "main", app);
    fs.writeFileSync(path.join(app, "README.md"), "# Fresh app\n");
    git(app, "add", "-A");
    git(app, "commit", "-q", "-m", "Initial commit");
    const firstSha = git(app, "rev-parse", "HEAD");
    git(app, "checkout", "-q", "-b", `mc/${GID}`);
    for (const feature of ["greet", "farewell"]) {
      fs.mkdirSync(path.join(app, "src"), { recursive: true });
      fs.writeFileSync(path.join(app, "src", `${feature}.mjs`), `export function run() {\n  return "${feature} works";\n}\n`);
      git(app, "add", "-A");
      git(app, "commit", "-q", "-m", `feat(${feature}): Feature ${feature}`);
    }
    const branchSha = git(app, "rev-parse", "HEAD");
    git(app, "checkout", "-q", "main");
    if (!opts.lagging) git(app, "merge", "-q", "--ff-only", `mc/${GID}`);
    if (opts.origin) git(app, "remote", "add", "origin", opts.origin);
    const record = { ...REAL, repoPath: "/home/pwuser/mc-apps/fresh", baseSha: firstSha, ...opts.record };
    const dir = path.join(mcHome, "missions", GID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mission.json"), JSON.stringify(record, null, 2));
    return { app, firstSha, branchSha };
  }

  /** An empty repository on the stand-in GitHub, like the one an owner makes on github.com for a new app. */
  function emptyHubRepo(owner: string, repo: string): string {
    const bare = path.join(hub, owner, `${repo}.git`);
    fs.mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare", "-q", "-b", "main");
    return bare;
  }

  function expectNoUpload(r: Result): void {
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(pushes(r)).toEqual([]);
    expect(r.git.filter((c) => c.args.includes("ls-remote"))).toEqual([]);
    expect(r.gh).toEqual([]);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(r.stderr).not.toContain("There is nothing to publish");
  }

  /** The fake gh prints this address for the pull request it opens. */
  const FRESH_PR = { FAKE_GH_URL: "https://github.com/acme/fresh/pull/7" };
  const NEW_APP = `mc-docker: “Fresh app” is a new app, and what was built is on the branch "main" in ~/mc-apps/fresh already.`;
  const WHOLE = "mc-docker: A new app goes to GitHub as a whole, once. A pull request needs work that GitHub does not have yet, and here there is none, so I have nothing to publish.";

  it("is built like the real thing: main and mc/<id> are the same commit, the record is a finished new app", () => {
    const f = freshWorld();
    expect(git(f.app, "rev-parse", "main")).toBe(f.branchSha);
    expect(git(f.app, "rev-parse", `mc/${GID}`)).toBe(f.branchSha);
    expect(REAL.kind).toBe("greenfield");
    expect(REAL.status).toBe("done");
  });

  it("with no GitHub address yet: says it is a new app and gives the steps that work, instead of 'nothing to publish'", () => {
    freshWorld();
    const r = run(["publish-preview", GID]);
    expectNoUpload(r);
    expect(r.stderr.split("\n").filter(Boolean)).toEqual([
      NEW_APP,
      WHOLE,
      "mc-docker: ~/mc-apps/fresh has no GitHub address yet. To put the app on GitHub, do this once, in your own Ubuntu window:",
      "mc-docker:   1. On github.com, create an empty repository (leave README, .gitignore and license off).",
      "mc-docker:   2. git -C ~/mc-apps/fresh remote add origin https://github.com/<owner>/<repo>.git",
      "mc-docker:   3. git -C ~/mc-apps/fresh push -u origin main",
      "mc-docker: After that, every later change to the app goes to GitHub with mc publish. The steps are in docs/github-setup.md.",
    ]);
  });

  it("says the same for publish, with or without --to, and never uploads", () => {
    freshWorld();
    for (const args of [["publish", GID], ["publish", GID, "--to", "acme/fresh"]]) {
      const r = run(args);
      expectNoUpload(r);
      expect(r.stderr, args.join(" ")).toContain(NEW_APP);
      expect(r.stderr, args.join(" ")).toContain("git -C ~/mc-apps/fresh push -u origin main");
    }
  });

  it("with a GitHub address: names the repository and gives the one upload command", () => {
    freshWorld({ origin: "https://github.com/acme/fresh.git" });
    const r = run(["publish-preview", GID]);
    expectNoUpload(r);
    expect(r.stderr.split("\n").filter(Boolean)).toEqual([
      NEW_APP,
      WHOLE,
      "mc-docker: The GitHub address of ~/mc-apps/fresh is github.com/acme/fresh. If that is the empty repository you made for this app, upload the app once, in your own Ubuntu window:",
      "mc-docker:   git -C ~/mc-apps/fresh push -u origin main",
      "mc-docker: If you did that already, there is nothing more to do. Later changes to the app go to GitHub with mc publish. The steps are in docs/github-setup.md.",
    ]);
  });

  it("with an address that is not a plain github.com address: says how to set it right", () => {
    for (const origin of ["https://evil.example/acme/fresh.git", "https://user:secret@github.com/acme/fresh.git"]) {
      fs.rmSync(path.join(home, "mc-apps"), { recursive: true, force: true });
      fs.rmSync(mcHome, { recursive: true, force: true });
      fs.mkdirSync(mcHome);
      freshWorld({ origin });
      const r = run(["publish-preview", GID]);
      expectNoUpload(r);
      expect(r.stderr).toContain("The GitHub address of ~/mc-apps/fresh is not a plain github.com address, or there is more than one.");
      expect(r.stderr).toContain("git -C ~/mc-apps/fresh remote set-url origin https://github.com/<owner>/<repo>.git");
      expect(r.stderr).toContain("Then upload the app once: git -C ~/mc-apps/fresh push -u origin main");
      expect(r.stderr).not.toContain("secret");
    }
  });

  it("the route in the guide works end to end: the owner uploads main once, and a later change is published as a draft pull request", () => {
    const f = freshWorld();
    // Step 1 to 3 of the message, done by the owner with real git and the stand-in GitHub.
    const bare = emptyHubRepo("acme", "fresh");
    git(f.app, "remote", "add", "origin", "https://github.com/acme/fresh.git");
    git(f.app, "push", "-q", "-u", "origin", "main");
    expect(hubHead(bare, "main")).toBe(f.branchSha);
    // The new app is on GitHub as a whole. The same sentences as before now say there is nothing more to do.
    const again = run(["publish", GID]);
    expectNoUpload(again);
    expect(again.stderr).toContain("If you did that already, there is nothing more to do.");
    // Later: a change to the app, as a feature mission makes it.
    const later = "2026-10-20-add-wave";
    git(f.app, "checkout", "-q", "-b", `mc/${later}`);
    fs.writeFileSync(path.join(f.app, "src", "wave.mjs"), 'export function run() {\n  return "wave works";\n}\n');
    git(f.app, "add", "-A");
    git(f.app, "commit", "-q", "-m", "feat(wave): Feature wave");
    git(f.app, "checkout", "-q", "main");
    const dir = path.join(mcHome, "missions", later);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "mission.json"),
      JSON.stringify({ ...REAL, id: later, kind: "feature", title: "Add wave", repoPath: "/home/pwuser/mc-apps/fresh", baseSha: f.branchSha, integrationBranch: `mc/${later}`, features: [] }),
    );
    const preview = run(["publish-preview", later]);
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("It would go to github.com/acme/fresh:");
    const r = run(["publish", later, "--to", "acme/fresh"], { env: FRESH_PR });
    expect(r.status, r.stderr).toBe(0);
    expect(hubHead(bare, `mc/${later}`)).toBe(git(f.app, "rev-parse", `mc/${later}`));
    expect(hubHead(bare, "main")).toBe(f.branchSha);
    expect(r.gh[0]!.args).toEqual(expect.arrayContaining(["--draft", "--repo", "acme/fresh", "--head", `mc/${later}`, "--base", "main"]));
    expect(fs.readFileSync(noteFile("fresh"), "utf8")).toBe("acme/fresh\n");
  });

  it("a new app whose main did not move onto the branch still publishes as before, once main is on GitHub", () => {
    const f = freshWorld({ lagging: true, origin: "https://github.com/acme/fresh.git" });
    expect(git(f.app, "rev-parse", "main")).toBe(f.firstSha);
    // Not on GitHub yet: the old sentence, with the command that fixes it.
    const bare = emptyHubRepo("acme", "fresh");
    const early = run(["publish", GID, "--to", "acme/fresh"]);
    expect(early.status).toBe(1);
    expect(early.stderr.replace(/\nmc-docker: /g, " ")).toContain('The branch "main" is not on GitHub in acme/fresh yet');
    git(f.app, "push", "-q", "origin", "main");
    const r = run(["publish", GID, "--to", "acme/fresh"], { env: FRESH_PR });
    expect(r.status, r.stderr).toBe(0);
    expect(hubHead(bare, `mc/${GID}`)).toBe(f.branchSha);
    expect(hubHead(bare, "main")).toBe(f.firstSha);
  });

  it("a new app that is not on its base branch and has no address gets the older steps, which end in publish", () => {
    freshWorld({ lagging: true });
    const r = run(["publish", GID, "--to", "acme/fresh"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('~/mc-apps/fresh has no GitHub address yet (no "origin"), so I did not publish.');
    expect(r.stderr).toContain("git -C ~/mc-apps/fresh push origin main");
    expect(r.stderr).toContain("Then publish again.");
  });

  it("a feature mission with nothing new still gets 'nothing to publish', also when the app has no address", () => {
    const world = setup({ kind: "feature" }, { branch: false, origin: null });
    git(world.app, "branch", `mc/${ID}`);
    const r = run(["publish", ID]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`There is nothing to publish: mc/${ID} has no new work compared with "main".`);
    expect(r.stderr).not.toContain("is a new app");
  });

  it("a record with a kind the engine does not write is treated like a feature mission", () => {
    freshWorld({ record: { kind: "banana; touch /tmp/pwned-kind" } });
    const r = run(["publish", GID]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`There is nothing to publish: mc/${GID} has no new work compared with "main".`);
    expect(r.stderr).not.toContain("is a new app");
    expect(fs.existsSync("/tmp/pwned-kind")).toBe(false);
  });
});
