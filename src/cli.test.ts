import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeEvent, followEvents, formatCheck, main, missionTitle } from "./cli.js";
import { configTemplateYaml } from "./config.js";
import { MissionStore } from "./state.js";
import type { Mission, MissionEvent } from "./types.js";
import { controllerGitEnv } from "./util/launch-env.js";
import { runProcess } from "./util/process.js";

let root: string;
let home: string;
let out: string;
let err: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-cli-"));
  home = join(root, "home");
  out = "";
  err = "";
  vi.stubEnv("MC_HOME", home);
  vi.stubEnv("MC_CONFIG", "");
  vi.stubEnv("MC_IN_CONTAINER", "");
  // Defaults such as ~/mc-apps and ~/.claude must never reach the real home folder.
  vi.stubEnv("HOME", join(root, "user-home"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude-config"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function mc(...args: string[]): Promise<number> {
  out = "";
  err = "";
  return main(["node", "mc", ...args], { stdout: (t) => (out += t), stderr: (t) => (err += t) });
}

function store(): MissionStore {
  return new MissionStore(home);
}

function queue(title: string, profile = "mixed"): Mission {
  return store().createMission({ kind: "greenfield", title, request: title, repoPath: "", baseBranch: "main", profile, nowMs: Date.now() });
}

function onlyMission(): Mission {
  const missions = store().list();
  expect(missions).toHaveLength(1);
  return missions[0] as Mission;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runProcess({ env: controllerGitEnv({ isolatedConfig: true }), command: "git", args, cwd, timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function makeRepo(name = "app"): Promise<string> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  return dir;
}

describe("mc (program)", () => {
  it("shows help with every command and examples, and exits 0", async () => {
    expect(await mc("--help")).toBe(0);
    for (const command of ["init", "config", "doctor", "new", "feature", "run", "status", "report", "stop", "logs"]) {
      expect(out).toContain(command);
    }
    expect(out).toContain("Examples:");
    expect(out).toContain("mc run --until 17:00");
  });

  it("says run, and never frames the work around a time of day, in its help and in what stop prints", async () => {
    // Written with a bracket in each word so that this file does not hold the words it forbids.
    const timeOfDay = /n[i]ght|mor[n]ing/i;
    for (const args of [["--help"], ["run", "--help"], ["new", "--help"], ["plan", "--help"]]) {
      expect(await mc(...args)).toBe(0);
      expect(out, args.join(" ")).not.toMatch(timeOfDay);
    }
    expect(await mc("--help")).toBe(0);
    expect(out).toContain("Mission Control builds and improves apps with Claude Code and Codex.");
    expect(out).toContain("mc run --until 17:00");
    expect(await mc("run", "--help")).toBe(0);
    expect(out).toContain("use this profile for this run");
    expect(out).toContain("change one role for this run");
    expect(await mc("stop")).toBe(0);
    expect(out).toContain("Stop requested. A run that is going cancels the AI step it is working on");
    expect(out).not.toMatch(timeOfDay);
  });

  it("shows the version", async () => {
    expect(await mc("--version")).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exits 1 on an unknown command or a missing argument, with a hint", async () => {
    expect(await mc("fly")).toBe(1);
    expect(err).toContain("unknown command 'fly'");
    expect(err).toContain("mc --help");
    expect(await mc("new")).toBe(1);
    expect(err).toContain("missing required argument");
  });
});

describe("mc init / config", () => {
  const file = () => join(home, "config.yaml");

  it("writes the settings template once and prints its path", async () => {
    expect(await mc("init")).toBe(0);
    expect(out.trim()).toBe(`Created your settings file: ${file()}`);
    expect(readFileSync(file(), "utf8")).toBe(configTemplateYaml());

    writeFileSync(file(), "git:\n  push: true\n");
    expect(await mc("init")).toBe(0);
    expect(out).toContain("already exists");
    expect(readFileSync(file(), "utf8")).toBe("git:\n  push: true\n");
  });

  it("gets values, groups and unset values", async () => {
    expect(await mc("config", "get", "notify.ntfyUrl")).toBe(0);
    expect(out.trim()).toBe("(not set)");
    expect(await mc("config", "get", "limits.maxReviewRounds")).toBe(0);
    expect(out.trim()).toBe("2");
    expect(await mc("config", "get", "home")).toBe(0);
    expect(out.trim()).toBe(home);
    expect(await mc("config", "get", "git")).toBe(0);
    expect(out).toBe("push: false\nbranchPrefix: mc\n");
    expect(await mc("config", "get", "nope.nothing")).toBe(1);
    expect(err).toContain('There is no setting called "nope.nothing"');
    expect(await mc("config", "get", "git..push")).toBe(1);
    expect(err).toContain("Separate its parts with dots");
  });

  it("sets values with the right type, keeping the file's comments, and creating it when missing", async () => {
    expect(await mc("config", "set", "notify.ntfyUrl", "https://ntfy.sh/my-topic")).toBe(0);
    expect(out).toContain("Saved: notify.ntfyUrl = https://ntfy.sh/my-topic");
    expect(await mc("config", "set", "git.push", "yes")).toBe(0);
    expect(await mc("config", "set", "limits.maxReviewRounds", "3")).toBe(0);
    expect(await mc("config", "set", "cli.claudeVersion", "2.2")).toBe(0);

    const text = readFileSync(file(), "utf8");
    expect(text).toContain("# Phone notifications through the free ntfy app");
    expect(text).toContain('ntfyUrl: "https://ntfy.sh/my-topic"');
    expect(text).toMatch(/push: true +# true = upload/);

    expect(await mc("config", "get", "notify.ntfyUrl")).toBe(0);
    expect(out.trim()).toBe("https://ntfy.sh/my-topic");
    expect(await mc("config", "get", "git.push")).toBe(0);
    expect(out.trim()).toBe("true");
    expect(await mc("config", "get", "limits.maxReviewRounds")).toBe(0);
    expect(out.trim()).toBe("3");
    expect(await mc("config", "get", "cli.claudeVersion")).toBe(0);
    expect(out.trim()).toBe("2.2"); // still text, not the number 2.2
  });

  it("reads lists and groups as YAML", async () => {
    const models = "[claude-opus-5-5, claude-sonnet-5-5, gpt-6-astra, gpt-6.1-sol, claude-haiku-5-5, gpt-6.2-nova]";
    expect(await mc("config", "set", "allowedModels", models)).toBe(0);
    expect(await mc("config", "set", "roles.reviewer", "{ tier: standard, effort: max }")).toBe(0);
    expect(await mc("config", "get", "allowedModels")).toBe(0);
    expect(out).toContain("- gpt-6.2-nova");
    expect(await mc("config", "get", "roles.reviewer.effort")).toBe(0);
    expect(out.trim()).toBe("max");
  });

  it("refuses values that would break the settings and changes nothing", async () => {
    await mc("init");
    const before = readFileSync(file(), "utf8");
    expect(await mc("config", "set", "git.push", "maybe")).toBe(1);
    expect(err).toContain("Nothing was changed");
    expect(err).toContain("git.push must be true or false");
    expect(err).not.toContain(".draft");
    // Only what is wrong with the new value: nothing suggests the (untouched) file is broken or needs editing.
    expect(err).toContain("Your settings file is as it was. Correct the value and try again.");
    expect(err).not.toMatch(/has a problem|Fix it in the file/);
    expect(await mc("config", "set", "notify.ntfyUrl", "ntfy.sh/mc-abc")).toBe(1);
    expect(err.trim().split("\n")).toEqual([
      "Nothing was changed, because the new value doesn't work:",
      expect.stringMatching(/^ {2}- notify\.ntfyUrl must be a web address .* but it is "ntfy\.sh\/mc-abc"\.$/),
      "Your settings file is as it was. Correct the value and try again.",
    ]);
    expect(await mc("config", "set", "colour", "blue")).toBe(1);
    expect(err).toContain("not a setting Mission Control knows");
    expect(await mc("config", "set", "git.push.deeper", "x")).toBe(1);
    expect(err).toContain("single value");
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("saves a fix while other settings still have problems from before, and lists those", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(file(), "git:\n  push: maybe\nnotify:\n  ntfyUrl: ntfy.sh/x\n");
    expect(await mc("config", "set", "git.push", "false")).toBe(0);
    expect(out).toContain("Saved: git.push = false");
    expect(out).toContain("Your settings still have a problem from before:");
    expect(out).toContain("notify.ntfyUrl must be a web address");
    expect(readFileSync(file(), "utf8")).toContain("push: false");
    expect(await mc("config", "set", "notify.ntfyUrl", "https://ntfy.sh/x")).toBe(0);
    expect(out).not.toContain("from before");
  });

  it("in the container, refuses to point a folder setting where the container keeps nothing", async () => {
    vi.stubEnv("MC_IN_CONTAINER", "1");
    await mc("init");
    const before = readFileSync(file(), "utf8");
    expect(await mc("config", "set", "workspaceRoot", "~/apps")).toBe(1);
    expect(err).toContain("Nothing was changed");
    expect(err).toContain("which the Mission Control container doesn't keep: your apps would be deleted when each command ends");
    expect(readFileSync(file(), "utf8")).toBe(before);
    expect(await mc("config", "set", "workspaceRoot", "~/mc-apps/work")).toBe(0);
  });

  it("won't edit a settings file that isn't valid YAML", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(file(), "git: [unclosed\n");
    expect(await mc("config", "set", "git.push", "true")).toBe(1);
    expect(err).toContain("not valid YAML");
  });
});

describe("mc doctor", () => {
  function fakeCli(name: string, table: Record<string, { out?: string; code?: number }>): string {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const path = join(bin, name);
    writeFileSync(
      path,
      `#!/usr/bin/env node
const hit = ${JSON.stringify(table)}[process.argv.slice(2).join(" ")] ?? { code: 2 };
process.stdout.write(hit.out ?? "");
process.exit(hit.code ?? 0);
`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  function setup(codexLogin: { out?: string; code?: number }): void {
    const claude = fakeCli("claude", { "--version": { out: "2.1.295 (Claude Code)" }, "auth status": {} });
    const codex = fakeCli("codex", {
      "--version": { out: "codex-cli 0.162.0" },
      "login status": codexLogin,
      "debug models": { out: "gpt-6-astra\ngpt-6.1-sol\n" },
    });
    // The folders the container keeps (mc-docker.sh mounts them), in the test's home.
    const keptHome = join(root, "user-home", ".mission-control");
    vi.stubEnv("MC_HOME", keptHome);
    mkdirSync(keptHome, { recursive: true });
    writeFileSync(
      join(keptHome, "config.yaml"),
      `workspaceRoot: ~/mc-apps\nnotify:\n  ntfyUrl: https://ntfy.sh/t\ncli:\n  claudeCommand: ${claude}\n  codexCommand: ${codex}\n`,
    );
    vi.stubEnv("MC_IN_CONTAINER", "1");
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
      vi.stubEnv(name, "");
    }
  }

  it("prints one marked line per check and exits 0 without errors", async () => {
    setup({ out: "Logged in using ChatGPT" });
    expect(await mc("doctor")).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines.some((l) => l.startsWith("✓ Codex login: logged in"))).toBe(true);
    expect(lines.some((l) => l.startsWith("✓ Settings: "))).toBe(true);
    expect(out).toMatch(/Everything looks good\.|0 problems to fix, \d+ warnings?\./);
  });

  it("exits 1 when a check fails, with the fix under it", async () => {
    setup({ out: "Not logged in", code: 1 });
    expect(await mc("doctor")).toBe(1);
    expect(out).toContain("✗ Codex login: Codex is not logged in.\n    How to fix: In Ubuntu, run: mc login-codex");
    expect(out).toMatch(/1 problem to fix, \d+ warnings?\./);
  });

  it("formats warnings and multi-line details", () => {
    expect(formatCheck({ name: "Notifications", ok: false, severity: "warn", detail: "off", fix: "turn them on" })).toBe(
      "! Notifications: off\n    How to fix: turn them on\n",
    );
    expect(formatCheck({ name: "Settings", ok: false, severity: "error", detail: "2 problems:\n- a\n- b" })).toBe(
      "✗ Settings: 2 problems:\n    - a\n    - b\n",
    );
    expect(formatCheck({ name: "Git", ok: true, severity: "error", detail: "git 2.43", fix: "never shown" })).toBe("✓ Git: git 2.43\n");
  });
});

describe("mc new / feature", () => {
  it("queues a new app with its name, profile and role overrides, and prints its id", async () => {
    expect(await mc("new", "A habit tracker with streaks", "--name", "Habit tracker", "--profile", "claude", "--role", "engineer=codex:frontier", "--role", "reviewer=claude")).toBe(0);
    const m = onlyMission();
    expect(m).toMatchObject({
      kind: "greenfield",
      title: "Habit tracker",
      request: "A habit tracker with streaks",
      repoPath: "",
      baseBranch: "main",
      profile: "claude",
      status: "queued",
      roleOverrides: [
        { role: "engineer", family: "codex", tier: "frontier" },
        { role: "reviewer", family: "claude" },
      ],
    });
    expect(m.id).toMatch(/^\d{4}-\d{2}-\d{2}-habit-tracker$/);
    expect(out).toContain(`Mission id: ${m.id}`);
  });

  it("puts curly quote marks around the title in what it prints", async () => {
    expect(await mc("new", "A habit tracker with streaks", "--name", "Habit tracker")).toBe(0);
    expect(out).toContain("Queued your new app “Habit tracker”.\n");
    expect(out).not.toContain('"Habit tracker"');
    const repo = await makeRepo();
    expect(await mc("feature", repo, "Add a dark mode")).toBe(0);
    expect(out).toContain(`Queued a change to ${repo}: “Add a dark mode” (starting from branch main).`);
    expect(out).not.toContain('"Add a dark mode"');
  });

  it("takes an idea or a request typed without quotes as one description", async () => {
    expect(await mc("new", "A", "habit", "tracker", "with", "streaks", "--name", "Habits")).toBe(0);
    expect(onlyMission()).toMatchObject({ request: "A habit tracker with streaks", title: "Habits" });
    const repo = await makeRepo();
    expect(await mc("feature", repo, "Add", "a", "dark", "mode")).toBe(0);
    expect(store().list().find((m) => m.kind === "feature")).toMatchObject({ request: "Add a dark mode", title: "Add a dark mode" });
  });

  it("uses the default profile and names the app after the idea", async () => {
    expect(await mc("new", "A notes app. It syncs nothing.")).toBe(0);
    expect(onlyMission()).toMatchObject({ title: "A notes app", profile: "mixed", roleOverrides: [] });
  });

  it("refuses an empty idea, an unknown profile or a bad role, creating nothing", async () => {
    expect(await mc("new", "   ")).toBe(1);
    expect(err).toContain("Describe the app");
    expect(await mc("new", "An app", "--profile", "fast")).toBe(1);
    expect(err).toContain('There is no profile called "fast"');
    expect(await mc("new", "An app", "--role", "engineer=luna")).toBe(1);
    expect(err).toContain("Invalid role setting");
    expect(store().list()).toHaveLength(0);
  });

  it("queues a change to an existing repository on its current branch", async () => {
    const repo = await makeRepo();
    expect(await mc("feature", repo, "Add a dark mode", "--profile", "codex")).toBe(0);
    expect(onlyMission()).toMatchObject({
      kind: "feature",
      title: "Add a dark mode",
      request: "Add a dark mode",
      repoPath: realpathSync(repo),
      baseBranch: "main",
      profile: "codex",
      stage: "onboard",
    });
    expect(out).toContain("starting from branch main");
  });

  it("takes --base, and needs it when no branch is checked out", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "develop");
    expect(await mc("feature", repo, "Add search", "--base", "develop")).toBe(0);
    expect(onlyMission().baseBranch).toBe("develop");

    expect(await mc("feature", repo, "Add search", "--base", "nope")).toBe(1);
    expect(err).toContain('There is no branch called "nope"');

    await git(repo, "checkout", "-q", "--detach");
    expect(await mc("feature", repo, "Add search")).toBe(1);
    expect(err).toContain("--base <branch>");
  });

  it("on a folder left on a version to try, says how to get back to the branch the last mission there started from", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "develop");
    await git(repo, "checkout", "-q", "develop");
    expect(await mc("feature", repo, "Add search")).toBe(0);
    // As a report's "How to try it" leaves it: a detached checkout of the mission's work.
    await git(repo, "checkout", "-q", "--detach");
    expect(await mc("feature", repo, "Add a dark mode")).toBe(1);
    expect(err).toContain("is still on a version you were trying");
    expect(err).toContain(`Put it back on your branch first: git -C ${realpathSync(repo)} checkout develop.`);
    expect(err).toContain("--base <branch>");
    await git(repo, "checkout", "-q", "develop");
    expect(await mc("feature", repo, "Add a dark mode")).toBe(0);
  });

  it("in the container, explains a missing folder: only ~/mc-apps is shared with it", async () => {
    vi.stubEnv("MC_IN_CONTAINER", "1");
    expect(await mc("feature", "/home/adam/projects/myapp", "Add a dark mode")).toBe(1);
    expect(err).toContain("There is no folder at /home/adam/projects/myapp. Mission Control works in a container that only sees your ~/mc-apps folder.");
    expect(err).toContain('mc feature ~/mc-apps/<app-folder> "<your request>"');
    expect(await mc("feature", join(root, "user-home", "mc-apps", "gone"), "x")).toBe(1);
    expect(err).not.toContain("only sees your ~/mc-apps");
  });

  it("refuses folders that aren't the top of a full git repository", async () => {
    expect(await mc("feature", join(root, "missing"), "x")).toBe(1);
    expect(err).toContain("There is no folder at");

    mkdirSync(join(root, "plain"));
    expect(await mc("feature", join(root, "plain"), "x")).toBe(1);
    expect(err).toContain("is not a git repository");

    const repo = await makeRepo();
    mkdirSync(join(repo, "src"));
    expect(await mc("feature", join(repo, "src"), "x")).toBe(1);
    expect(err).toContain("is inside the git repository");

    const shallow = join(root, "shallow");
    await git(root, "clone", "-q", "--depth", "1", `file://${repo}`, shallow);
    expect(await mc("feature", shallow, "x")).toBe(1);
    expect(err).toContain("fetch --unshallow");

    expect(await mc("feature", repo, "  ")).toBe(1);
    expect(err).toContain("Describe the change");
    expect(store().list()).toHaveLength(0);
  });

  it("names a mission after the first sentence of the request, cut at a word", () => {
    expect(missionTitle(" My  Title ", "ignored")).toBe("My Title");
    expect(missionTitle(undefined, "Add a dark mode! Make it pretty.")).toBe("Add a dark mode");
    const long = missionTitle(undefined, "A tracker for my daily habits where I can tick off each one and see a weekly chart");
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long).toBe("A tracker for my daily habits where I can tick off each one…");
  });
});

describe("mc status / stop / report / logs", () => {
  it("says when there are no missions", async () => {
    expect(await mc("status")).toBe(0);
    expect(out).toContain("No missions yet");
    expect(await mc("status", "--json")).toBe(0);
    expect(JSON.parse(out)).toEqual([]);
  });

  it("shows a table, or JSON, with progress and the wait time", async () => {
    const a = queue("Habit tracker");
    const b = queue("Notes app");
    const s = store();
    const m = s.load(b.id);
    m.status = "waiting";
    m.stage = "features";
    m.features = [
      { id: "one", title: "One", story: "", acceptance: [], kind: "standard", deps: [], status: "done", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] },
      { id: "two", title: "Two", story: "", acceptance: [], kind: "standard", deps: [], status: "blocked", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] },
      { id: "three", title: "Three", story: "", acceptance: [], kind: "standard", deps: [], status: "pending", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] },
    ];
    s.save(m);
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    s.appendEvent(b.id, "limit.wait", { until, reason: "session limit" });

    expect(await mc("status")).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines[0]).toMatch(/^MISSION +KIND +STATUS +STAGE +FEATURES DONE +BLOCKED +WAITING UNTIL$/);
    expect(lines[1]).toMatch(new RegExp(`^${a.id} +new app +queued +spec +0/0 +0 +-$`));
    // Saved as waiting, but no run holds the lock: the last run was cut off.
    expect(lines[2]).toMatch(new RegExp(`^${b.id} +new app +interrupted +features +1/3 +1 +\\S`));
    expect(out).toContain('interrupted: the last run ended without finishing');

    expect(await mc("status", "--json")).toBe(0);
    const rows = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(rows[1]).toEqual({
      id: b.id,
      title: "Notes app",
      kind: "greenfield",
      status: "waiting",
      stage: "features",
      featuresDone: 1,
      featuresTotal: 3,
      blocked: 1,
      waitingUntil: until,
      interrupted: true,
      checkpoint: null,
    });
    expect(rows[0]?.waitingUntil).toBeNull();
    expect(rows[0]?.interrupted).toBe(false);

    // While a run holds the lock, the mission really is waiting.
    const release = store().acquireLock();
    try {
      expect(await mc("status")).toBe(0);
      expect(out.trim().split("\n")[2]).toMatch(new RegExp(`^${b.id} +new app +waiting +features`));
      expect(out).not.toContain("interrupted");
    } finally {
      release();
    }
  });

  it("says how to move on a mission that failed: by itself after a new login, else with mc run --mission", async () => {
    const stuck = queue("Habit tracker");
    const loggedOut = queue("Notes app");
    const s = store();
    s.save({ ...s.load(stuck.id), status: "failed", failure: { reason: "Not a repo.", retryable: false } });
    s.save({ ...s.load(loggedOut.id), status: "failed", failure: { reason: "No model could run.", retryable: true } });

    expect(await mc("status")).toBe(0);
    expect(out).toContain(`${stuck.id} needs your help: see what with "mc report ${stuck.id}", then run "mc run --mission ${stuck.id}".`);
    expect(out).toContain(`${loggedOut.id} carries on by itself on the next run, once you have logged in again (see mc report ${loggedOut.id}).`);
  });

  it("requests a stop and shows it in the status", async () => {
    queue("Habit tracker");
    expect(await mc("stop")).toBe(0);
    expect(out).toContain("Stop requested");
    expect(existsSync(join(home, "STOP"))).toBe(true);
    await mc("status");
    expect(out).toContain("A stop has been requested");
  });

  it("prints the latest report's path and its first 40 lines", async () => {
    expect(await mc("report")).toBe(0);
    expect(out).toContain("No reports yet");

    const older = queue("Old app");
    const newer = queue("New app");
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    writeFileSync(store().reportPath(newer.id), `${lines.join("\n")}\n`);
    writeFileSync(store().reportPath(older.id), "# Old\n");
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    utimesSync(store().reportPath(older.id), hourAgo, hourAgo); // written before the newer one

    expect(await mc("report")).toBe(0);
    expect(out).toContain(`Report: ${store().reportPath(newer.id)}`);
    expect(out).toContain("line 40\n");
    expect(out).not.toContain("line 41\n");
    expect(out).toContain("10 more lines");

    expect(await mc("report", older.id)).toBe(0);
    expect(out).toContain("# Old");
  });

  it("shows the night's summary when the last night worked on several missions, with each mission's command", async () => {
    const a = queue("Habit tracker");
    const b = queue("Notes app");
    writeFileSync(store().reportPath(a.id), "# Habit tracker\n");
    writeFileSync(store().reportPath(b.id), "# Notes app\n");
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    for (const id of [a.id, b.id]) utimesSync(store().reportPath(id), hourAgo, hourAgo);
    mkdirSync(join(home, "reports"), { recursive: true });
    const summary = join(home, "reports", "night-2026-10-10.md");
    writeFileSync(
      summary,
      `# Run summary for 2026-10-10\n\n## Missions\n\n- **Habit tracker**: Done. [Read the report](../missions/${a.id}/report.md)\n` +
        `- **Notes app**: Partly done. [Read the report](../missions/${b.id}/report.md)\n\n## Needs your decision\n\n- **Notes app**: pick a colour\n`,
    );

    expect(await mc("report")).toBe(0);
    expect(out).toContain(`Run summary: ${summary}`);
    expect(out).toContain("- **Notes app**: pick a colour");
    expect(out).toContain(`Each mission's own report: mc report <mission>, for example: mc report ${a.id}`);
    expect(await mc("report", b.id)).toBe(0);
    expect(out).toContain("# Notes app");

    // The run summary is found under either file name: run-<date>.md, as a run writes it now, or night-<date>.md, as earlier runs did.
    const runSummary = join(home, "reports", "run-2026-10-11.md");
    writeFileSync(runSummary, readFileSync(summary, "utf8").replace("2026-10-10", "2026-10-11"));
    const newer = new Date(Date.now() + 1000);
    utimesSync(runSummary, newer, newer);
    expect(await mc("report")).toBe(0);
    expect(out).toContain(`Run summary: ${runSummary}`);
    const older = new Date(Date.now() - 5000);
    utimesSync(runSummary, older, older);
    expect(await mc("report")).toBe(0);
    expect(out).toContain(`Run summary: ${summary}`);
    rmSync(runSummary);

    // A mission report written after that night (or a night with one mission) is shown itself.
    const halfHourAgo = new Date(Date.now() - 30 * 60_000);
    utimesSync(summary, halfHourAgo, halfHourAgo);
    writeFileSync(store().reportPath(b.id), "# Notes app, again\n");
    expect(await mc("report")).toBe(0);
    expect(out).toContain(`Report: ${store().reportPath(b.id)}`);
    writeFileSync(summary, `# Run summary\n\n- **Notes app**: Done. [Read the report](../missions/${b.id}/report.md)\n`);
    const later = new Date(Date.now() + 60_000);
    utimesSync(summary, later, later);
    expect(await mc("report")).toBe(0);
    expect(out).toContain("# Notes app, again");
  });

  it("never prints control characters from agent text (report, logs), so they can't drive the terminal", async () => {
    const m = queue("Habit tracker");
    const osc52 = "\x1b]52;c;Y3VybCBldmlsLnNoIHwgc2gK\x07";
    writeFileSync(store().reportPath(m.id), `# Habit tracker\n\n- A finding ${osc52} with a title \x1b]0;pwned\x07\n`);
    store().appendEvent(m.id, "attempt", { feature: "f1", model: "gpt-6.1-sol", outcome: "fail", summary: `2 tests failed ${osc52}` });
    store().appendEvent(m.id, "run.end", { label: "build", outcome: "failed", durationMs: 1000, error: `boom \x9b2J` });
    expect(await mc("report", m.id)).toBe(0);
    expect(out).toContain("- A finding ]52;c;Y3VybCBldmlsLnNoIHwgc2gK with a title ]0;pwned");
    expect(await mc("logs", m.id)).toBe(0);
    expect(out).toContain("2 tests failed ]52;c;");
    expect(out).toContain("(boom 2J)");
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });

  it("says plainly when a queued mission has no log yet", async () => {
    const m = queue("Habit tracker");
    expect(await mc("logs", m.id)).toBe(0);
    expect(out).toContain("Nothing has happened in this mission yet");
  });

  it("explains a missing mission or report with exit code 1", async () => {
    expect(await mc("report", "nope")).toBe(1);
    expect(err).toContain('There is no mission called "nope"');
    const m = queue("Habit tracker");
    expect(await mc("report", m.id)).toBe(1);
    expect(out).toContain("has no report yet");
    expect(await mc("logs", "nope")).toBe(1);
    expect(err).toContain("mc status");
  });

  it("says a mission's file is broken instead of saying the mission doesn't exist", async () => {
    const m = queue("Habit tracker");
    const file = join(home, "missions", m.id, "mission.json");
    writeFileSync(file, "{ not json");
    for (const command of [["logs", m.id], ["report", m.id], ["run", "--mission", m.id]]) {
      expect(await mc(...command), command.join(" ")).toBe(1);
      expect(err).toContain(`Mission ${m.id} exists, but its file can't be read: invalid JSON in ${file}`);
    }
  });

  it("still stops and shows the missions while the settings file has a problem, with a warning", async () => {
    queue("Habit tracker");
    writeFileSync(join(home, "config.yaml"), "limits:\n  agentTimeoutMs: 45min\n"); // e.g. edited during the night
    expect(await mc("stop")).toBe(0);
    expect(existsSync(join(home, "STOP"))).toBe(true);
    expect(out).toContain("Stop requested");
    expect(err).toContain(`Warning: The config file ${join(home, "config.yaml")} has a problem`);
    expect(err).toContain(`Using the Mission Control folder ${home} anyway.`);
    expect(await mc("status", "--json")).toBe(0);
    expect(JSON.parse(out)).toHaveLength(1);
  });

  it("without MC_HOME, finds the folder from the broken settings file's own `home`, else the default one", async () => {
    vi.stubEnv("MC_HOME", "");
    const file = join(root, "settings.yaml");
    vi.stubEnv("MC_CONFIG", file);
    writeFileSync(file, `home: ${home}\nlimits:\n  agentTimeoutMs: 45min\n`);
    expect(await mc("stop")).toBe(0);
    expect(existsSync(join(home, "STOP"))).toBe(true);

    writeFileSync(file, "home: [unclosed\n");
    expect(await mc("stop")).toBe(0);
    expect(existsSync(join(root, "user-home", ".mission-control", "STOP"))).toBe(true);
  });

  it("prints a mission's events in readable lines", async () => {
    const m = queue("Habit tracker");
    const s = store();
    s.appendEvent(m.id, "mission.start", { stage: "spec" });
    s.appendEvent(m.id, "run.start", { label: "spec", jobId: "spec-1", role: "architect", provider: "claude", model: "claude-opus-5-5", effort: "high" });
    s.appendEvent(m.id, "run.end", { label: "spec", jobId: "spec-1", outcome: "ok", durationMs: 95_000 });
    s.appendEvent(m.id, "custom.thing", { answer: 42, nested: { a: 1 } });
    expect(await mc("logs", m.id)).toBe(0);
    const lines = out.trim().split("\n");
    expect(lines[0]).toMatch(/^-- .+ --$/);
    expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d {2}mission started at stage spec$/);
    expect(lines[2]).toContain("architect started on claude-opus-5-5 (high effort) [spec-1]");
    expect(lines[3]).toContain("spec ended: ok after 2 min");
    expect(lines[4]).toContain('custom.thing: answer=42, nested={"a":1}');
  });
});

describe("describeEvent", () => {
  const event = (type: string, data: Record<string, unknown>): MissionEvent => ({ at: new Date().toISOString(), missionId: "m", type, data });

  it.each([
    [event("stage", { from: "spec", to: "gate_a" }), "stage spec -> gate_a"],
    [event("feature.status", { feature: "add-todo", from: "building", to: "blocked", reason: "tried every step" }), "add-todo: building -> blocked (tried every step)"],
    [event("attempt", { feature: "add-todo", model: "gpt-6.1-sol", outcome: "fail", summary: "2 tests failed" }), "add-todo: attempt with gpt-6.1-sol: fail (2 tests failed)"],
    [event("verify", { feature: "add-todo", label: "full", ok: true, durationMs: 4000 }), 'add-todo: checks "full" passed after 4 s'],
    [event("merge", { feature: "add-todo", commit: "abc" }), "add-todo: merged"],
    [event("mission.stopped", { stage: "features", reason: "stop requested" }), "mission paused at stage features (stop requested)"],
    [event("mission.failed", { stage: "spec", reason: "login" }), "mission failed at stage spec (login)"],
    [event("mission.end", { status: "done" }), "mission ended: done"],
    [event("report", { path: "/x/report.md" }), "report written: /x/report.md"],
    [event("error", { message: "boom" }), "error: boom"],
    [event("ping", {}), "ping"],
  ])("%#: %s", (e, expected) => {
    expect(describeEvent(e)).toBe(expected);
  });

  it("shortens long values to one line", () => {
    const text = describeEvent(event("error", { message: `${"x".repeat(200)}\nmore` }));
    expect(text.length).toBeLessThan(140);
    expect(text).not.toContain("\n");
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("followEvents", () => {
  const line = (type: string) => `${JSON.stringify({ at: new Date().toISOString(), missionId: "m", type, data: {} })}\n`;

  it("prints existing events, then new complete lines as they arrive, until aborted", async () => {
    const file = join(root, "events.jsonl");
    writeFileSync(file, line("first"));
    let printed = "";
    const stop = new AbortController();
    const following = followEvents(file, (t) => (printed += t), stop.signal, 10);

    await vi.waitFor(() => expect(printed).toContain("first"));
    appendFileSync(file, line("second") + line("third").slice(0, 20)); // the third is still being written
    await vi.waitFor(() => expect(printed).toContain("second"));
    expect(printed).not.toContain("third");
    appendFileSync(file, line("third").slice(20) + "not json\n");
    await vi.waitFor(() => expect(printed).toContain("third"));

    stop.abort();
    await following;
    expect(printed.match(/first|second|third/g)).toEqual(["first", "second", "third"]);
  });

  it("waits for a file that doesn't exist yet, and starts over when it shrinks", async () => {
    const file = join(root, "later.jsonl");
    let printed = "";
    const stop = new AbortController();
    const following = followEvents(file, (t) => (printed += t), stop.signal, 10);
    writeFileSync(file, line("aaaaaaaaaaaaaaaaaaaa") + line("bbbbbbbbbbbbbbbbbbbbbb"));
    await vi.waitFor(() => expect(printed).toContain("bbbb"));
    writeFileSync(file, line("c"));
    await vi.waitFor(() => expect(printed).toMatch(/\d {2}c\n/));
    stop.abort();
    await following;
  });
});

describe("mc run", () => {
  it("runs the night and prints where its summary is", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true); // the night's own log lines
    expect(await mc("run")).toBe(0);
    expect(out).toContain("Nothing was queued");
    expect(out).toMatch(/Run summary: .*reports\/run-\d{4}-\d{2}-\d{2}\.md/);
  });

  it("does not say nothing was queued when a failed mission waits, and gives the command that continues it", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stuck = queue("Habit tracker");
    store().save({ ...store().load(stuck.id), status: "failed" });

    expect(await mc("run")).toBe(0);
    expect(out).not.toContain("Nothing was queued");
    expect(out).toContain(`- Habit tracker needs your help: see what with "mc report ${stuck.id}", then run "mc run --mission ${stuck.id}"`);
  });

  it("runs only the given mission, with tonight's profile and roles, and keeps the mission's own", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Stands in for both AI command lines: logged out, so the mission ends quickly.
    const ai = join(root, "logged-out-ai");
    writeFileSync(ai, '#!/usr/bin/env node\nprocess.stderr.write("Not logged in. Please run /login\\n");\nprocess.exit(1);\n');
    chmodSync(ai, 0o755);
    mkdirSync(join(root, "apps"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), `workspaceRoot: ${join(root, "apps")}\ncli:\n  claudeCommand: ${ai}\n  codexCommand: ${ai}\n`);
    const other = queue("Other app");
    const target = queue("Habit tracker", "codex");

    expect(await mc("run", "--mission", target.id, "--profile", "claude", "--role", "architect=standard")).toBe(0);
    expect(out).toContain("- Habit tracker: Stopped, needs your help");
    expect(out).not.toContain("Other app");
    // Tonight's profile put the architect on Claude, at the tier tonight's --role chose.
    expect(store().readEvents(target.id).find((e) => e.type === "run.start")?.data).toMatchObject({ role: "architect", model: "claude-sonnet-5-5" });
    expect(store().load(target.id)).toMatchObject({ status: "failed", profile: "codex", roleOverrides: [] });
    expect(store().load(other.id).status).toBe("queued");
  });

  it("explains bad options and a run that is already active", async () => {
    expect(await mc("run", "--until", "7am")).toBe(1);
    expect(err).toContain('"7am" is not a time of day');
    expect(await mc("run", "--role", "nobody=codex")).toBe(1);
    expect(err).toContain("is not a role");

    const release = store().acquireLock();
    try {
      expect(await mc("run")).toBe(1);
      expect(err).toMatch(/^A Mission Control run is already active \(pid \d+\)\. Check it with "mc status", or stop it with "mc stop"\.\n$/);
    } finally {
      release();
    }

    // A run in another container is judged by its heartbeat, so a run cut off there blocks for up to 5 minutes.
    writeFileSync(join(home, "mc.lock"), JSON.stringify({ pid: 7, at: new Date().toISOString(), host: "3f2a1b2c3d4e" }));
    expect(await mc("run")).toBe(1);
    expect(err).toContain("A Mission Control run is already active (pid 7 on host 3f2a1b2c3d4e).");
    expect(err).toContain(`If no run is working (in Ubuntu, "docker ps" doesn't list mission-control-run), the last one was cut off: wait 5 minutes, then try again.`);
  });
});
