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

// Records argv as JSON lines. `info` fails FAKE_INFO_FAILURES times, `info --format` prints FAKE_MEM_TOTAL (8 GiB
// unless set), `image inspect` fails when FAKE_IMAGE_MISSING is set, `container inspect` prints FAKE_RUN_STATE (or fails
// when it is unset), and a container running `mc config get notify.ntfyUrl` prints FAKE_NTFY_URL ("(not set)" unless
// set), or fails when FAKE_CONFIG_FAILS is set.
const FAKE_DOCKER = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const log = process.env.FAKE_DOCKER_LOG;
fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const [command, sub] = args;
if (command === "info" && args.includes("--format")) {
  console.log(process.env.FAKE_MEM_TOTAL ?? "8589934592");
  process.exit(0);
}
if (command === "run" && args.slice(-4).join(" ") === "mc config get notify.ntfyUrl") {
  if (process.env.FAKE_CONFIG_FAILS) process.exit(1);
  console.log(process.env.FAKE_NTFY_URL ?? "(not set)");
  process.exit(0);
}
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
// Records argv as JSON lines, like the fake docker.
const FAKE_CURL = `#!${process.execPath}
require("node:fs").appendFileSync(process.env.FAKE_CURL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
`;
const NTFY_URL = "https://ntfy.sh/mc-k3v9x0q2m7b1t8zp";

interface WrapperResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Every docker invocation, in order. */
  calls: string[][];
  /** The last `docker run` invocation (the one the wrapper hands over to), if any. */
  run: string[] | undefined;
  sleeps: string[];
  /** Every curl invocation (notifications), in order. */
  curls: string[][];
}

let tmp: string;
let home: string;
let bin: string;

function writeExecutable(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, { mode: 0o755 });
}

/** A PATH with the fakes but no docker command, for "Docker isn't available". */
function noDockerPath(): string {
  const dir = path.join(tmp, "no-docker");
  fs.mkdirSync(dir);
  for (const name of ["id", "sleep", "curl"]) fs.copyFileSync(path.join(bin, name), path.join(dir, name));
  const dirname = ["/usr/bin/dirname", "/bin/dirname"].find((p) => fs.existsSync(p));
  fs.symlinkSync(dirname!, path.join(dir, "dirname"));
  return dir;
}

/** The copy of the notification address the wrapper keeps outside the container. */
function notifyUrlFile(): string {
  return path.join(home, ".config", "mission-control", "ntfy-url");
}

function rememberNotifyUrl(url: string): void {
  fs.mkdirSync(path.dirname(notifyUrlFile()), { recursive: true });
  fs.writeFileSync(notifyUrlFile(), `${url}\n`);
}

function readLines(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

/** Runs the wrapper with only the fakes and the system directories on PATH. `undefined` removes a variable. */
function wrapper(args: string[], opts: { env?: Record<string, string | undefined>; cwd?: string; path?: string } = {}): WrapperResult {
  const dockerLog = path.join(tmp, "docker.log");
  const sleepLog = path.join(tmp, "sleep.log");
  const curlLog = path.join(tmp, "curl.log");
  for (const file of [dockerLog, `${dockerLog}.info-count`, sleepLog, curlLog]) fs.rmSync(file, { force: true });
  const env: Record<string, string> = {};
  const entries = {
    PATH: opts.path ?? `${bin}:/usr/bin:/bin`,
    HOME: home,
    TZ: "America/New_York",
    FAKE_DOCKER_LOG: dockerLog,
    FAKE_SLEEP_LOG: sleepLog,
    FAKE_CURL_LOG: curlLog,
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
    run: calls.filter((call) => call[0] === "run").at(-1),
    sleeps: readLines(sleepLog),
    curls: readLines(curlLog).map((line) => JSON.parse(line) as string[]),
  };
}

/** The argument following `flag` in a docker invocation. */
function valueAfter(args: string[] | undefined, flag: string): string | undefined {
  const index = args?.indexOf(flag) ?? -1;
  return index === -1 ? undefined : args?.[index + 1];
}

/** The limits every container gets, with the fake Docker's 8 GiB of memory. */
const LIMITS = [
  "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "8192",
  "--memory", "6144m", "--memory-swap", "-1",
];

/** The docker run arguments every container gets (no terminal, timezone from TZ), then `extra`, the image and the command. */
function expectedRun(extra: string[], command: string[]): string[] {
  return [
    "run", "--rm", "--init", "--shm-size=1g",
    ...LIMITS,
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
  writeExecutable(bin, "curl", FAKE_CURL);
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

  it.each([
    ["missing", false],
    // What Docker Desktop's WSL integration leaves while Docker Desktop is stopped: a link into it that points nowhere.
    ["a link to a stopped Docker Desktop", true],
  ])("says to start Docker Desktop first, then to check WSL integration, when the docker command is %s", (_, dangling) => {
    const noDocker = noDockerPath();
    if (dangling) fs.symlinkSync("/mnt/wsl/docker-desktop/cli-tools/usr/bin/docker", path.join(noDocker, "docker"));
    const r = wrapper(["status"], { path: noDocker });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker isn't available in Ubuntu. Docker Desktop is probably not running: start it");
    expect(r.stderr).toContain("If it is already running, open its Settings > Resources > WSL integration");
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

  it("stops `feature` with what to do when the app folder exists outside ~/mc-apps, which the container can't see", () => {
    const outside = path.join(home, "projects", "myapp");
    fs.mkdirSync(outside, { recursive: true });
    for (const args of [
      ["feature", outside, "Add dark mode"],
      ["feature", "--base", "main", outside, "Add dark mode"],
    ]) {
      const r = wrapper(args);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr).toContain("Mission Control can only change apps inside ~/mc-apps");
      expect(r.stderr).toContain(`mv "${outside}" ~/mc-apps/`);
      expect(r.stderr).toContain('mc feature ~/mc-apps/myapp "<your request>"');
      expect(r.run).toBeUndefined();
    }
    // A relative path from outside ~/mc-apps too.
    expect(wrapper(["feature", ".", "Add dark mode"], { cwd: outside }).status).toBe(1);
  });

  it("lets mc explain a feature folder that doesn't exist at all, and accepts folders inside ~/mc-apps", () => {
    const missing = wrapper(["feature", path.join(home, "nowhere"), "Add dark mode"]);
    expect(missing.status).toBe(0);
    expect(missing.run?.slice(-3)).toEqual(["feature", path.join(home, "nowhere"), "Add dark mode"]);

    fs.mkdirSync(path.join(home, "mc-apps", "habit-tracker"), { recursive: true });
    const inside = wrapper(["feature", "--name", "Dark", `${home}/mc-apps/habit-tracker`, "Add dark mode"]);
    expect(inside.status).toBe(0);
    expect(inside.run?.slice(-5)).toEqual(["feature", "--name", "Dark", "/home/pwuser/mc-apps/habit-tracker", "Add dark mode"]);
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
    // Only the two capabilities chown needs come back.
    expect(r.run).toEqual(expectedRun(
      ["--user", "root", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--entrypoint", "chown"],
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
  const RUN_FLAGS = ["--name", "mission-control-run", "--hostname", "mission-control-run"];

  it("runs mc run in the fixed-name container, with a fixed hostname so a killed run's lock is judged by its pid", () => {
    const r = wrapper(["run", "--until", "07:00"]);
    expect(r.status).toBe(0);
    expect(r.run).toEqual(expectedRun(RUN_FLAGS, ["mc", "run", "--until", "07:00"]));
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
    expect(r.run).toEqual(expectedRun(RUN_FLAGS, ["mc", "run", "--until", "07:00"]));
  });

  it("gives up after 5 minutes when Docker never starts", () => {
    const r = wrapper(["run", "--until", "07:00"], { env: { FAKE_INFO_FAILURES: "1000" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker isn't running");
    expect(r.sleeps).toHaveLength(30);
    expect(r.run).toBeUndefined();
  });
});

describe("mc-docker.sh: container limits", () => {
  it("drops every capability, blocks privilege gain, caps processes and gives three quarters of Docker's memory", () => {
    const r = wrapper(["status"], { env: { FAKE_MEM_TOTAL: String(16 * 1024 ** 3) } });
    expect(r.status).toBe(0);
    expect(r.calls).toContainEqual(["info", "--format", "{{.MemTotal}}"]);
    expect(valueAfter(r.run, "--cap-drop")).toBe("ALL");
    expect(valueAfter(r.run, "--security-opt")).toBe("no-new-privileges");
    expect(valueAfter(r.run, "--pids-limit")).toBe("8192");
    expect(valueAfter(r.run, "--memory")).toBe("12288m");
    expect(valueAfter(r.run, "--memory-swap")).toBe("-1");
    // The limits come before the command, so they are docker's flags, not the command's arguments.
    expect(r.run!.indexOf("--pids-limit")).toBeLessThan(r.run!.indexOf(IMAGE));
  });

  it.each(["", "unknown", "0"])("keeps the other limits but sets no memory limit when Docker reports %j", (memTotal) => {
    const r = wrapper(["status"], { env: { FAKE_MEM_TOTAL: memTotal } });
    expect(r.status).toBe(0);
    expect(r.run).not.toContain("--memory");
    expect(r.run).not.toContain("--memory-swap");
    expect(valueAfter(r.run, "--pids-limit")).toBe("8192");
    expect(valueAfter(r.run, "--cap-drop")).toBe("ALL");
  });

  it("applies them to the night run as well", () => {
    const r = wrapper(["run", "--until", "07:00"]);
    expect(r.run).toEqual(expectedRun(
      ["--name", "mission-control-run", "--hostname", "mission-control-run"],
      ["mc", "run", "--until", "07:00"],
    ));
  });
});

describe("mc-docker.sh: telling the iPad when a night run can't start", () => {
  const PROBE = ["mc", "config", "get", "notify.ntfyUrl"];
  const isProbe = (call: string[]) => call[0] === "run" && call.slice(-4).join(" ") === PROBE.join(" ");

  it("keeps a private copy of the notification address each time a night run starts", () => {
    const r = wrapper(["run", "--until", "07:00"], { env: { FAKE_NTFY_URL: NTFY_URL } });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(notifyUrlFile(), "utf8")).toBe(`${NTFY_URL}\n`);
    expect(fs.statSync(notifyUrlFile()).mode & 0o777).toBe(0o600);
    // Read in a container of its own (same volumes and limits, no name), before the night's container starts.
    const probe = r.calls.findIndex(isProbe);
    expect(r.calls[probe]).toEqual(["run", "--rm", "--init", "--shm-size=1g", ...LIMITS, ...STANDARD_VOLUMES,
      "--volume", `${home}/mc-apps:/home/pwuser/mc-apps`, IMAGE, ...PROBE]);
    expect(r.calls.indexOf(r.run!)).toBeGreaterThan(probe);
    expect(r.run?.slice(-4)).toEqual(["mc", "run", "--until", "07:00"]);
    expect(r.curls).toEqual([]);
  });

  it("forgets the address once it is no longer set, and keeps it when the settings can't be read", () => {
    rememberNotifyUrl(NTFY_URL);
    expect(wrapper(["run"], { env: { FAKE_CONFIG_FAILS: "1" } }).status).toBe(0);
    expect(fs.readFileSync(notifyUrlFile(), "utf8")).toBe(`${NTFY_URL}\n`);
    // Anything but a single address (say, a warning printed first) isn't taken either.
    expect(wrapper(["run"], { env: { FAKE_NTFY_URL: `a warning\nhttps://ntfy.sh/other` } }).status).toBe(0);
    expect(fs.readFileSync(notifyUrlFile(), "utf8")).toBe(`${NTFY_URL}\n`);
    expect(wrapper(["run"]).status).toBe(0); // "(not set)"
    expect(fs.existsSync(notifyUrlFile())).toBe(false);
  });

  it("only refreshes the address for night runs", () => {
    const r = wrapper(["status"], { env: { FAKE_NTFY_URL: NTFY_URL } });
    expect(r.calls.some(isProbe)).toBe(false);
    expect(fs.existsSync(notifyUrlFile())).toBe(false);
  });

  /** The one notification sent: its address and body, with the title and priority checked. */
  function sentNotification(r: WrapperResult): { url: string | undefined; body: string | undefined } {
    expect(r.curls).toHaveLength(1);
    const call = r.curls[0]!;
    expect(call).toContain("Title: Mission Control: the night run didn't start");
    expect(call).toContain("Priority: 4");
    return { url: call.at(-1), body: valueAfter(call, "--data-binary") };
  }

  it("sends why when Docker never started", () => {
    rememberNotifyUrl(NTFY_URL);
    const r = wrapper(["run", "--until", "07:00"], { env: { FAKE_INFO_FAILURES: "1000" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Docker isn't running");
    const sent = sentNotification(r);
    expect(sent.url).toBe(NTFY_URL);
    expect(sent.body).toContain("Docker isn't running. Start Docker Desktop");
  });

  it("sends why when Docker Desktop is stopped and Ubuntu's docker command points nowhere", () => {
    rememberNotifyUrl(NTFY_URL);
    const noDocker = noDockerPath();
    fs.symlinkSync("/mnt/wsl/docker-desktop/cli-tools/usr/bin/docker", path.join(noDocker, "docker"));
    const r = wrapper(["run", "--until", "07:00"], { path: noDocker });
    expect(r.status).toBe(1);
    expect(r.sleeps).toHaveLength(30);
    expect(sentNotification(r).body).toContain("Docker Desktop is probably not running");
  });

  it("sends why when the image is missing", () => {
    rememberNotifyUrl(NTFY_URL);
    const r = wrapper(["run"], { env: { FAKE_IMAGE_MISSING: "1" } });
    expect(r.status).toBe(1);
    expect(sentNotification(r).body).toContain("the Mission Control image isn't built yet. Run: mc build");
    expect(r.run).toBeUndefined();
  });

  it("stays quiet when another run is already working, for other commands, and without an address", () => {
    rememberNotifyUrl(NTFY_URL);
    const active = wrapper(["run"], { env: { FAKE_RUN_STATE: "true" } });
    expect(active.status).toBe(1);
    expect(active.curls).toEqual([]);

    const status = wrapper(["status"], { env: { FAKE_INFO_FAILURES: "1000" } });
    expect(status.status).toBe(1);
    expect(status.curls).toEqual([]);

    fs.rmSync(notifyUrlFile());
    const unknown = wrapper(["run"], { env: { FAKE_IMAGE_MISSING: "1" } });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("isn't built yet");
    expect(unknown.curls).toEqual([]);
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
