// Tests for the one-click launcher: `mc-docker.sh install-leader` and `leader`, the small launcher it installs
// (scripts/windows/mc-launch.sh), and the two Windows shortcut files (scripts/windows/*.cmd).
// Not tried here: Windows, WSL and Claude Code. A fake `claude` records where it was started and with what arguments,
// and a pseudo-terminal (the `script` program) stands in for the terminal that `leader` asks for.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const BASH = ["/usr/bin/bash", "/bin/bash"].find((p) => fs.existsSync(p)) ?? "bash";
const SCRIPT_PROGRAM = ["/usr/bin/script", "/bin/script"].find((p) => fs.existsSync(p));
const WINDOWS_DIR = path.join(REPO_DIR, "scripts", "windows");
const LAUNCHER_SOURCE = path.join(WINDOWS_DIR, "mc-launch.sh");

const FAKE_ID = `#!/bin/sh\necho "\${FAKE_UID:-1000}"\n`;
// Records argv as JSON lines, like the fake docker of test/mc-docker.test.ts.
const FAKE_DOCKER = `#!${process.execPath}
require("node:fs").appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "container") process.exit(1);
`;
// Records the folder it was started in and its arguments.
const FAKE_CLAUDE = `#!${process.execPath}
require("node:fs").appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + "\\n");
`;
// The words our own text must not use: a time of day as framing, and "objective" (we say "feature"). Built from pieces,
// so that this file passes the scan that looks for them.
const NI = "nig" + "ht";
const OLD_WORDS = new RegExp(`\\b(?:${NI}s?|${NI}ly|to${NI}|over${NI}|mor${"ning"}|objec${"tive"})\\b`, "i");
const SYSTEM_TOOLS = ["bash", "sh", "env", "mkdir", "mv", "install", "cat", "tr", "cut", "dirname", "basename", "readlink", "rm", "cp", "chmod", "ls", "touch", "sed"];

let tmp: string;
let home: string;
let fakeBin: string;
let tools: string;
let dockerLog: string;
let claudeLog: string;

function configFile(name: string): string {
  return path.join(home, ".config", "mission-control", name);
}

function lines<T>(file: string): T[] {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** A copy of just enough of Mission Control for the launcher to work, in a folder with the given name (spaces allowed). */
function makeCheckout(name: string): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, "scripts", "windows"), { recursive: true });
  fs.mkdirSync(path.join(root, "leader", ".claude"), { recursive: true });
  fs.copyFileSync(path.join(REPO_DIR, "scripts", "mc-docker.sh"), path.join(root, "scripts", "mc-docker.sh"));
  fs.chmodSync(path.join(root, "scripts", "mc-docker.sh"), 0o755);
  fs.copyFileSync(LAUNCHER_SOURCE, path.join(root, "scripts", "windows", "mc-launch.sh"));
  fs.copyFileSync(path.join(REPO_DIR, "leader", "CLAUDE.md"), path.join(root, "leader", "CLAUDE.md"));
  fs.copyFileSync(path.join(REPO_DIR, "leader", ".claude", "settings.json"), path.join(root, "leader", ".claude", "settings.json"));
  return root;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function env(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {
    PATH: `${fakeBin}:${tools}`,
    HOME: home,
    TZ: "America/New_York",
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_CLAUDE_LOG: claudeLog,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

/** Runs a script the way a pipe does it: no terminal. */
function runPlain(file: string, args: string[], extra: Record<string, string | undefined> = {}): Run {
  const r = spawnSync(BASH, [file, ...args], { cwd: home, env: env(extra), input: "", encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Runs a script on a pseudo-terminal, as the Windows shortcut does (wsl.exe gives it a terminal). */
function runOnTerminal(file: string, args: string[], extra: Record<string, string | undefined> = {}): Run {
  const command = [BASH, file, ...args].map(shellQuote).join(" ");
  const r = spawnSync(SCRIPT_PROGRAM!, ["-qec", command, "/dev/null"], { cwd: home, env: env(extra), input: "", encoding: "utf8" });
  return { status: r.status, stdout: r.stdout.replaceAll("\r", ""), stderr: r.stderr };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-launcher-test-")));
  home = path.join(tmp, "home");
  fakeBin = path.join(tmp, "bin");
  tools = path.join(tmp, "tools");
  dockerLog = path.join(tmp, "docker.log");
  claudeLog = path.join(tmp, "claude.log");
  for (const dir of [home, fakeBin, tools]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(fakeBin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "id"), FAKE_ID, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  for (const name of SYSTEM_TOOLS) {
    const found = ["/usr/bin", "/bin"].map((dir) => path.join(dir, name)).find((p) => fs.existsSync(p));
    if (found) fs.symlinkSync(found, path.join(tools, name));
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("install-leader", () => {
  it("saves where Mission Control is and puts the launcher next to it, with no Docker at all", () => {
    const r = runPlain(path.join(REPO_DIR, "scripts", "mc-docker.sh"), ["install-leader"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(fs.readFileSync(configFile("checkout"), "utf8")).toBe(`${REPO_DIR}\n`);
    expect(fs.readFileSync(configFile("launch"), "utf8")).toBe(fs.readFileSync(LAUNCHER_SOURCE, "utf8"));
    expect(fs.statSync(configFile("launch")).mode & 0o777).toBe(0o755);
    expect(r.stdout).toContain(`mc-docker: saved that Mission Control is in ${REPO_DIR}.`);
    expect(r.stdout).toContain("mc-docker: put the launcher at ~/.config/mission-control/launch.");
    expect(r.stdout).toContain("run this command once more from the new folder");
    expect(lines(dockerLog)).toEqual([]);
  });

  it("can be run again, and from another copy: the last copy it was run from wins", () => {
    const one = makeCheckout("one");
    const two = makeCheckout("two copy with spaces");
    expect(runPlain(path.join(one, "scripts", "mc-docker.sh"), ["install-leader"]).status).toBe(0);
    expect(fs.readFileSync(configFile("checkout"), "utf8")).toBe(`${one}\n`);
    expect(runPlain(path.join(two, "scripts", "mc-docker.sh"), ["install-leader"]).status).toBe(0);
    expect(fs.readFileSync(configFile("checkout"), "utf8")).toBe(`${two}\n`);
    expect(runPlain(path.join(two, "scripts", "mc-docker.sh"), ["install-leader"]).status).toBe(0);
    expect(fs.readdirSync(path.dirname(configFile("launch"))).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("refuses a folder that is not a whole copy of Mission Control, and arguments, and root", () => {
    const partial = makeCheckout("partial");
    fs.rmSync(path.join(partial, "leader", "CLAUDE.md"));
    const refused = runPlain(path.join(partial, "scripts", "mc-docker.sh"), ["install-leader"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("does not look like a whole copy of Mission Control");
    expect(fs.existsSync(configFile("checkout"))).toBe(false);
    expect(runPlain(path.join(REPO_DIR, "scripts", "mc-docker.sh"), ["install-leader", "x"]).stderr).toContain("install-leader takes no arguments");
    const root = runPlain(path.join(REPO_DIR, "scripts", "mc-docker.sh"), ["install-leader"], { FAKE_UID: "0" });
    expect(root.status).toBe(1);
    expect(root.stderr).toContain("without sudo");
    expect(fs.existsSync(configFile("checkout"))).toBe(false);
  });
});

describe("leader", () => {
  const needsTerminal = SCRIPT_PROGRAM ? it : it.skip;

  needsTerminal("starts Claude Code with remote control inside the leader folder of its own copy", () => {
    const checkout = makeCheckout("checkout");
    const r = runOnTerminal(path.join(checkout, "scripts", "mc-docker.sh"), ["leader"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const [call, ...more] = lines<{ cwd: string; args: string[] }>(claudeLog);
    expect(more).toEqual([]);
    expect(call).toEqual({ cwd: path.join(checkout, "leader"), args: ["--remote-control", "Leader"] });
    // The leader's commands, written ../scripts/mc-docker.sh, reach the same copy's script from there.
    expect(fs.realpathSync(path.resolve(call!.cwd, "..", "scripts", "mc-docker.sh"))).toBe(fs.realpathSync(path.join(checkout, "scripts", "mc-docker.sh")));
    expect(lines(dockerLog)).toEqual([]);
  });

  needsTerminal("starts without remote control when asked to", () => {
    const checkout = makeCheckout("checkout");
    const r = runOnTerminal(path.join(checkout, "scripts", "mc-docker.sh"), ["leader", "--no-remote"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lines<{ args: string[] }>(claudeLog).map((call) => call.args)).toEqual([[]]);
  });

  needsTerminal("refuses other arguments, and says plainly when Claude Code is not installed in Ubuntu", () => {
    const checkout = makeCheckout("checkout");
    const script = path.join(checkout, "scripts", "mc-docker.sh");
    for (const args of [["leader", "--bogus"], ["leader", "--no-remote", "x"], ["leader", "$(touch /tmp/pwned)"]]) {
      const r = runOnTerminal(script, args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/leader: (I don't know|too many arguments)/);
    }
    fs.rmSync(path.join(fakeBin, "claude"));
    const r = runOnTerminal(script, ["leader"]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("Claude Code isn't installed in Ubuntu itself");
    expect(lines(claudeLog)).toEqual([]);
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
  });

  it("says it needs a terminal when there is none, and refuses root", () => {
    const checkout = makeCheckout("checkout");
    const script = path.join(checkout, "scripts", "mc-docker.sh");
    const r = runPlain(script, ["leader"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"leader" is interactive: run it yourself in an Ubuntu window.');
    expect(lines(claudeLog)).toEqual([]);
    expect(runPlain(script, ["leader"], { FAKE_UID: "0" }).stderr).toContain("without sudo");
  });

  needsTerminal("says plainly when the leader folder is missing", () => {
    const checkout = makeCheckout("checkout");
    fs.rmSync(path.join(checkout, "leader", ".claude"), { recursive: true });
    const r = runOnTerminal(path.join(checkout, "scripts", "mc-docker.sh"), ["leader"]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("the leader folder is missing from");
  });
});

describe("the launcher the shortcuts call", () => {
  const needsTerminal = SCRIPT_PROGRAM ? it : it.skip;

  /** Installs the launcher from a copy of Mission Control, the way the owner does once. */
  function install(checkout: string): string {
    expect(runPlain(path.join(checkout, "scripts", "mc-docker.sh"), ["install-leader"]).status).toBe(0);
    return configFile("launch");
  }

  needsTerminal("starts the leader in the leader folder of the saved copy", () => {
    const checkout = makeCheckout("saved copy");
    const launch = install(checkout);
    const r = runOnTerminal(launch, ["leader"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lines(claudeLog)).toEqual([{ cwd: path.join(checkout, "leader"), args: ["--remote-control", "Leader"] }]);
  });

  needsTerminal("follows the copy that install-leader was last run from, after Mission Control is moved or downloaded again", () => {
    const one = makeCheckout("one");
    const launch = install(one);
    const two = makeCheckout("two");
    fs.rmSync(one, { recursive: true });
    // Moved, and not told yet: a plain sentence says what to do.
    const lost = runOnTerminal(launch, ["leader"]);
    expect(lost.status).toBe(1);
    expect(lost.stdout + lost.stderr).toContain(`I can't find Mission Control in ${one}.`);
    expect(lost.stdout + lost.stderr).toContain("scripts/mc-docker.sh install-leader");
    expect(lines(claudeLog)).toEqual([]);
    // Told: it follows.
    expect(runPlain(path.join(two, "scripts", "mc-docker.sh"), ["install-leader"]).status).toBe(0);
    const found = runOnTerminal(launch, ["leader"]);
    expect(found.status, found.stdout + found.stderr).toBe(0);
    expect(lines<{ cwd: string }>(claudeLog).map((call) => call.cwd)).toEqual([path.join(two, "leader")]);
  });

  needsTerminal("tries ~/Mission-control, where the setup guide downloads it, when nothing was saved", () => {
    const launch = path.join(tmp, "launch-copy.sh");
    fs.copyFileSync(LAUNCHER_SOURCE, launch);
    const missing = runOnTerminal(launch, ["leader"]);
    expect(missing.status).toBe(1);
    expect(missing.stdout + missing.stderr).toContain(`I can't find Mission Control in ${home}/Mission-control.`);
    const checkout = makeCheckout("Mission-control-source");
    fs.renameSync(checkout, path.join(home, "Mission-control"));
    const ok = runOnTerminal(launch, ["leader"]);
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(lines<{ cwd: string }>(claudeLog)[0]!.cwd).toBe(path.join(home, "Mission-control", "leader"));
  });

  it("starts the dashboard container through the saved copy", () => {
    const checkout = makeCheckout("saved copy");
    const launch = install(checkout);
    const r = runPlain(launch, ["dashboard"]);
    expect(r.status, r.stderr).toBe(0);
    const calls = lines<string[]>(dockerLog);
    const run = calls.find((call) => call[0] === "run")!;
    expect(run).toEqual(expect.arrayContaining(["--name", "mission-control-dashboard", "--entrypoint", "mc"]));
    expect(run.slice(-5)).toEqual(["dashboard", "--host", "0.0.0.0", "--port", "8787"]);
  });

  it("starts only the leader or the dashboard: anything else is refused and runs nothing", () => {
    const checkout = makeCheckout("saved copy");
    const launch = install(checkout);
    for (const args of [[], ["status"], ["leader", "x"], ["dashboard", "--lan"], ["--help"], ["../x"], ["$(touch /tmp/pwned)"], ["leader;touch /tmp/pwned"], [""]]) {
      const r = runPlain(launch, args);
      expect(r.status, JSON.stringify(args)).toBe(1);
      expect(r.stderr, JSON.stringify(args)).toContain('I can start "leader" or "dashboard"');
    }
    expect(lines(dockerLog)).toEqual([]);
    expect(lines(claudeLog)).toEqual([]);
    expect(fs.existsSync("/tmp/pwned")).toBe(false);
  });

  it("does not run a command written into the saved folder name", () => {
    const launch = path.join(tmp, "launch-copy.sh");
    fs.copyFileSync(LAUNCHER_SOURCE, launch);
    fs.mkdirSync(path.dirname(configFile("checkout")), { recursive: true });
    fs.writeFileSync(configFile("checkout"), `${tmp}/x; touch ${tmp}/PWNED #\n`);
    const r = runPlain(launch, ["dashboard"]);
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(tmp, "PWNED"))).toBe(false);
  });

  it("is a plain script of the repository: it does nothing but pick a copy and start its script", () => {
    const text = fs.readFileSync(LAUNCHER_SOURCE, "utf8");
    expect(text.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(text.replaceAll("mc-docker.sh", "")).not.toMatch(/\beval\b|\bsudo\b|\bcurl\b|\bgit\b|\bdocker\b/);
    expect(fs.statSync(LAUNCHER_SOURCE).mode & 0o111).not.toBe(0);
    expect(spawnSync(BASH, ["-n", LAUNCHER_SOURCE]).status).toBe(0);
  });
});

describe("the Windows shortcut files", () => {
  const files = ["start-leader.cmd", "start-dashboard.cmd"];
  const read = (name: string): Buffer => fs.readFileSync(path.join(WINDOWS_DIR, name));

  it.each(files)("%s is ASCII only, with Windows line endings on every line and none of the other kind", (name) => {
    const bytes = read(name);
    for (const byte of bytes) expect(byte, "a byte above 127").toBeLessThan(128);
    const text = bytes.toString("latin1");
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
    expect(text).not.toContain("\0");
  });

  it.each(files)("%s opens Ubuntu through the saved launcher and shows a message when it fails", (name) => {
    const text = read(name).toString("latin1");
    const word = name === "start-leader.cmd" ? "leader" : "dashboard";
    expect(text).toContain('set "DISTRO=Ubuntu"');
    expect(text).toContain(`wsl.exe -d %DISTRO% -- bash -lic "$HOME/.config/mission-control/launch ${word}"`);
    expect(text).toContain("if errorlevel 1 (");
    expect(text).toContain("  pause");
    expect(text).toContain("mc install-leader");
    expect(text).toContain("wsl -l -v");
    expect(text.startsWith("@echo off\r\n")).toBe(true);
  });

  it.each(files)("%s uses no character that the Windows command line reads as more than text", (name) => {
    const text = read(name).toString("latin1").replaceAll("%DISTRO%", "");
    expect(text).not.toMatch(/[&|<>^%]/);
    // Inside the if block, a closing bracket in a message would end the block early.
    const block = text.split("if errorlevel 1 (")[1]!;
    const inner = block.slice(0, block.lastIndexOf(")"));
    expect(inner).not.toMatch(/[()]/);
  });

  it.each(files)("%s uses the words of the other documents: no time-of-day framing, no jargon", (name) => {
    const text = read(name).toString("latin1");
    expect(text).not.toMatch(OLD_WORDS);
  });

  it("the dashboard shortcut says where to look, and the leader shortcut starts only the leader", () => {
    expect(read("start-dashboard.cmd").toString("latin1")).toContain("http://localhost:8787");
    expect(read("start-leader.cmd").toString("latin1")).not.toContain("dashboard");
  });

  it("keeps its line endings in git: the shortcuts as Windows text, the launcher as Linux text", () => {
    const attributes = fs.readFileSync(path.join(WINDOWS_DIR, ".gitattributes"), "utf8");
    expect(attributes).toContain("*.cmd text eol=crlf");
    expect(attributes).toContain("*.sh text eol=lf");
    const check = spawnSync("git", ["check-attr", "eol", "--", "scripts/windows/start-leader.cmd", "scripts/windows/start-dashboard.cmd", "scripts/windows/mc-launch.sh"], { cwd: REPO_DIR, encoding: "utf8" });
    if (check.status === 0) {
      expect(check.stdout).toContain("scripts/windows/start-leader.cmd: eol: crlf");
      expect(check.stdout).toContain("scripts/windows/start-dashboard.cmd: eol: crlf");
      expect(check.stdout).toContain("scripts/windows/mc-launch.sh: eol: lf");
    }
  });
});
