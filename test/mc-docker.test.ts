// Tests for scripts/mc-docker.sh, the wrapper users run from WSL. A fake `docker` on PATH records each call,
// so no Docker, TTY or network is needed; stdin and stdout are pipes, as under Windows Task Scheduler.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = path.join(REPO_DIR, "scripts", "mc-docker.sh");
const BASH = ["/usr/bin/bash", "/bin/bash"].find((p) => fs.existsSync(p)) ?? "bash";
const IMAGE = "mission-control:local";
const STANDARD_VOLUMES = [
  "--volume", "mc-claude:/home/pwuser/.claude",
  "--volume", "mc-codex:/home/pwuser/.codex",
  "--volume", "mc-home:/home/pwuser/.mission-control",
  "--volume", "mc-browsers:/ms-playwright",
];

// Records argv as JSON lines. `info` fails FAKE_INFO_FAILURES times, `image inspect` fails when
// FAKE_IMAGE_MISSING is set, and `container inspect` prints FAKE_RUN_STATE (or fails when it is unset).
const FAKE_DOCKER = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const [command, sub] = args;
if (command === "info") {
  const counter = log + ".info-count";
  const calls = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(calls + 1));
  process.exit(calls < Number(process.env.FAKE_INFO_FAILURES ?? "0") ? 1 : 0);
}
if (command === "image" && sub === "inspect") process.exit(process.env.FAKE_IMAGE_MISSING ? 1 : 0);
if (command === "container" && sub === "inspect") {
  if (!process.env.FAKE_RUN_STATE) process.exit(1);
  console.log(process.env.FAKE_RUN_STATE);
}
`;
const FAKE_ID = `#!/bin/sh\necho "\${FAKE_UID:-1000}"\n`;
const FAKE_SLEEP = `#!/bin/sh\necho "$1" >> "$FAKE_SLEEP_LOG"\n`;
const FAKE_READLINK = `#!/bin/sh\n[ -n "$FAKE_LOCALTIME" ] || exit 1\necho "$FAKE_LOCALTIME"\n`;

interface WrapperResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Every docker invocation, in order. */
  calls: string[][];
  /** The `docker run` invocation, if any. */
  run: string[] | undefined;
  sleeps: string[];
}

let tmp: string;
let home: string;
let bin: string;

function writeExecutable(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, { mode: 0o755 });
}

function readLines(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

/** Runs the wrapper with only the fakes and the system directories on PATH. `undefined` removes a variable. */
function wrapper(args: string[], opts: { env?: Record<string, string | undefined>; cwd?: string; path?: string } = {}): WrapperResult {
  const dockerLog = path.join(tmp, "docker.log");
  const sleepLog = path.join(tmp, "sleep.log");
  for (const file of [dockerLog, `${dockerLog}.info-count`, sleepLog]) fs.rmSync(file, { force: true });
  const env: Record<string, string> = {};
  const entries = {
    PATH: opts.path ?? `${bin}:/usr/bin:/bin`,
    HOME: home,
    TZ: "America/New_York",
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_SLEEP_LOG: sleepLog,
    ...opts.env,
  };
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) env[key] = value;
  const result = spawnSync(BASH, [SCRIPT, ...args], { cwd: opts.cwd ?? home, env, input: "", encoding: "utf8" });
  const calls = readLines(dockerLog).map((line) => JSON.parse(line) as string[]);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls,
    run: calls.find((call) => call[0] === "run"),
    sleeps: readLines(sleepLog),
  };
}

/** The argument following `flag` in a docker invocation. */
function valueAfter(args: string[] | undefined, flag: string): string | undefined {
  const index = args?.indexOf(flag) ?? -1;
  return index === -1 ? undefined : args?.[index + 1];
}

/** The docker run arguments every container gets (no terminal, timezone from TZ), then `extra`, the image and the command. */
function expectedRun(extra: string[], command: string[]): string[] {
  return [
    "run", "--rm", "--init", "--shm-size=1g",
    ...STANDARD_VOLUMES,
    "--volume", `${home}/mc-apps:/home/pwuser/mc-apps`,
    ...extra,
    "--env", "TZ=America/New_York",
    IMAGE,
    ...command,
  ];
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-docker-test-")));
  home = path.join(tmp, "home");
  bin = path.join(tmp, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  writeExecutable(bin, "docker", FAKE_DOCKER);
  writeExecutable(bin, "id", FAKE_ID);
  writeExecutable(bin, "sleep", FAKE_SLEEP);
  writeExecutable(bin, "readlink", FAKE_READLINK);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("mc-docker.sh: help and preconditions", () => {
  it.each([[[]], [["help"]]])("prints the command list without touching Docker for %j", (args) => {
    const r = wrapper(args);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: mc-docker.sh <command>");
    expect(r.stdout).toContain("login-codex");
    expect(r.calls).toEqual([]);
  });

  it("refuses to run as root", () => {
    const r = wrapper(["status"], { env: { FAKE_UID: "0" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("without sudo");
    expect(r.calls).toEqual([]);
  });

  it("explains how to connect Docker to Ubuntu when the docker command is missing", () => {
    const noDocker = path.join(tmp, "no-docker");
    fs.mkdirSync(noDocker);
    writeExecutable(noDocker, "id", FAKE_ID);
    const dirname = ["/usr/bin/dirname", "/bin/dirname"].find((p) => fs.existsSync(p));
    fs.symlinkSync(dirname!, path.join(noDocker, "dirname"));
    const r = wrapper(["status"], { path: noDocker });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker isn't available in Ubuntu");
    expect(r.stderr).toContain("WSL integration");
  });

  it("fails at once when Docker isn't running and the command isn't a night run", () => {
    const r = wrapper(["status"], { env: { FAKE_INFO_FAILURES: "1000" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker isn't running");
    expect(r.sleeps).toEqual([]);
    expect(r.run).toBeUndefined();
  });

  it("tells you to build the image when it is missing", () => {
    const r = wrapper(["status"], { env: { FAKE_IMAGE_MISSING: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("image isn't built yet. Run: mc build");
    expect(r.run).toBeUndefined();
  });
});

describe("mc-docker.sh: containers", () => {
  it("runs mc commands with the volumes, init, shared memory and timezone, and no terminal flags", () => {
    const r = wrapper(["doctor", "--live"]);
    expect(r.status).toBe(0);
    expect(r.calls[0]).toEqual(["info"]);
    expect(r.calls).toContainEqual(["image", "inspect", IMAGE]);
    expect(r.run).toEqual(expectedRun([], ["mc", "doctor", "--live"]));
    expect(r.run).not.toContain("--interactive");
    expect(r.run).not.toContain("--tty");
    expect(r.run).not.toContain("-it");
    // Created by the wrapper, so Docker doesn't create it owned by root.
    expect(fs.statSync(path.join(home, "mc-apps")).isDirectory()).toBe(true);
  });

  it("passes idea text through untouched, spaces and quotes included", () => {
    const idea = `A "habit" tracker; with $HOME and ~/mc-apps in the text`;
    const r = wrapper(["new", idea, "--name", "Habit tracker"]);
    expect(r.run?.slice(-5)).toEqual(["mc", "new", idea, "--name", "Habit tracker"]);
  });

  it("points arguments inside ~/mc-apps at the same folder in the container", () => {
    const r = wrapper(["feature", `${home}/mc-apps/habit-tracker`, "Add dark mode", `${home}/mc-apps`, `${home}/mc-apps-old/x`]);
    expect(r.run?.slice(-6)).toEqual([
      "mc", "feature", "/home/pwuser/mc-apps/habit-tracker", "Add dark mode", "/home/pwuser/mc-apps", `${home}/mc-apps-old/x`,
    ]);
  });

  it("starts in the matching container folder when run from inside ~/mc-apps, so relative paths work", () => {
    const appDir = path.join(home, "mc-apps", "habit-tracker");
    fs.mkdirSync(appDir, { recursive: true });
    const r = wrapper(["feature", ".", "Add dark mode"], { cwd: appDir });
    expect(r.status).toBe(0);
    expect(valueAfter(r.run, "--workdir")).toBe("/home/pwuser/mc-apps/habit-tracker");
    expect(r.run?.slice(-4)).toEqual(["mc", "feature", ".", "Add dark mode"]);
  });

  it("keeps the image's working folder when run from outside ~/mc-apps", () => {
    fs.mkdirSync(path.join(home, "mc-apps-old"));
    const r = wrapper(["status"], { cwd: path.join(home, "mc-apps-old") });
    expect(r.run).toEqual(expectedRun([], ["mc", "status"]));
  });

  it("logs in to Codex with a device code", () => {
    const r = wrapper(["login-codex"]);
    expect(r.status).toBe(0);
    expect(r.run).toEqual(expectedRun([], ["codex", "login", "--device-auth"]));
  });

  it.each(["login-claude", "shell"])("refuses %s without a terminal", (command) => {
    const r = wrapper([command]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`"${command}" is interactive`);
    expect(r.run).toBeUndefined();
  });

  it("repairs the volumes' ownership as root", () => {
    const r = wrapper(["fix-permissions"]);
    expect(r.status).toBe(0);
    expect(r.run).toEqual(expectedRun(
      ["--user", "root", "--entrypoint", "chown"],
      ["-R", "pwuser:pwuser", "/home/pwuser/.claude", "/home/pwuser/.codex", "/home/pwuser/.mission-control"],
    ));
  });

  it("copies reports into ~/mc-reports and prints the folder's Windows address", () => {
    const r = wrapper(["copy-reports"], { env: { WSL_DISTRO_NAME: "Ubuntu-24.04" } });
    expect(r.status).toBe(0);
    expect(fs.statSync(path.join(home, "mc-reports")).isDirectory()).toBe(true);
    expect(r.stdout).toContain(`\\\\wsl.localhost\\Ubuntu-24.04${home.replaceAll("/", "\\")}\\mc-reports`);
    const run = r.run!;
    expect(run.slice(0, -3)).toEqual(expectedRun(["--volume", `${home}/mc-reports:/home/pwuser/mc-reports`], []));
    expect(run.slice(-3, -1)).toEqual(["bash", "-c"]);
    expect(run.at(-1)).toContain('dest="$HOME/mc-reports"');
  });
});

describe("mc-docker.sh: build", () => {
  it("builds mission-control:local with your user and group ids, passing extra flags through", () => {
    const r = wrapper(["build", "--no-cache"], { env: { FAKE_IMAGE_MISSING: "1" } });
    expect(r.status).toBe(0);
    const repo = REPO_DIR.replace(/\/$/, "");
    expect(r.calls).toEqual([
      ["info"],
      ["build", "--file", `${repo}/docker/Dockerfile`, "--tag", IMAGE, "--build-arg", "MC_UID=1000", "--build-arg", "MC_GID=1000", "--no-cache", repo],
    ]);
    expect(r.stdout).toContain("the image is ready.");
  });
});

describe("mc-docker.sh: night run", () => {
  it("runs mc run in the fixed-name container", () => {
    const r = wrapper(["run", "--until", "07:00"]);
    expect(r.status).toBe(0);
    expect(r.run).toEqual(expectedRun(["--name", "mission-control-run"], ["mc", "run", "--until", "07:00"]));
  });

  it("refuses a second run while one is active", () => {
    const r = wrapper(["run", "--until", "07:00"], { env: { FAKE_RUN_STATE: "true" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("a Mission Control run is already active. To stop it, run: mc stop");
    expect(r.run).toBeUndefined();
  });

  it("removes a run container left behind by a crash before starting", () => {
    const r = wrapper(["run"], { env: { FAKE_RUN_STATE: "false" } });
    expect(r.status).toBe(0);
    const rm = r.calls.findIndex((call) => call.join(" ") === "container rm mission-control-run");
    expect(rm).toBeGreaterThan(-1);
    expect(r.calls.indexOf(r.run!)).toBeGreaterThan(rm);
  });

  it("waits for Docker Desktop to start when run unattended", () => {
    const r = wrapper(["run", "--until", "07:00"], { env: { FAKE_INFO_FAILURES: "3" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("waiting for Docker to start (up to 5 minutes)");
    expect(r.sleeps).toEqual(["10", "10", "10"]);
    expect(r.run).toEqual(expectedRun(["--name", "mission-control-run"], ["mc", "run", "--until", "07:00"]));
  });

  it("gives up after 5 minutes when Docker never starts", () => {
    const r = wrapper(["run", "--until", "07:00"], { env: { FAKE_INFO_FAILURES: "1000" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker isn't running");
    expect(r.sleeps).toHaveLength(30);
    expect(r.run).toBeUndefined();
  });
});

describe("mc-docker.sh: timezone", () => {
  const tzFlag = (r: WrapperResult) => valueAfter(r.run, "--env");

  it("uses TZ when it is set", () => {
    expect(tzFlag(wrapper(["status"], { env: { TZ: "Asia/Tokyo" } }))).toBe("TZ=Asia/Tokyo");
  });

  it("reads the zone from the /etc/localtime link", () => {
    const r = wrapper(["status"], { env: { TZ: undefined, FAKE_LOCALTIME: "/usr/share/zoneinfo/Europe/Paris" } });
    expect(tzFlag(r)).toBe("TZ=Europe/Paris");
    expect(r.stderr).not.toContain("timezone");
  });

  it("falls back to /etc/timezone, or warns that times mean UTC", () => {
    const r = wrapper(["status"], { env: { TZ: undefined, FAKE_LOCALTIME: "/etc/not-a-zone-file" } });
    expect(r.status).toBe(0);
    const etcTimezone = fs.existsSync("/etc/timezone") ? fs.readFileSync("/etc/timezone", "utf8").trim() : "";
    if (etcTimezone) {
      expect(tzFlag(r)).toBe(`TZ=${etcTimezone}`);
    } else {
      expect(tzFlag(r)).toBeUndefined();
      expect(r.stderr).toContain("couldn't tell your timezone, so times such as 07:00 mean UTC");
    }
  });
});
