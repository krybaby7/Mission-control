import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliIO, main, readCapped } from "./cli.js";
import { parsePlan } from "./plan.js";
import { MissionStore } from "./state.js";
import type { Mission } from "./types.js";
import { runProcess } from "./util/process.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "plans");
/** Example 1 (a change to the app habit-tracker) and example 2 (a new app) of docs/plans-spec.md section 3.1. */
const ONE = readFileSync(join(FIXTURES, "dark-mode.txt"), "utf8");
const THREE = readFileSync(join(FIXTURES, "reading-list.txt"), "utf8");

let root: string;
let home: string;
let apps: string;
let out: string;
let err: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-cli-plan-"));
  home = join(root, "home");
  apps = join(root, "user-home", "mc-apps");
  mkdirSync(apps, { recursive: true });
  vi.stubEnv("MC_HOME", home);
  vi.stubEnv("MC_CONFIG", "");
  vi.stubEnv("MC_IN_CONTAINER", "");
  vi.stubEnv("HOME", join(root, "user-home"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude-config"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** Runs `mc` with the plan sent in on standard input (when `stdin` is a text). */
async function mc(args: string[], stdin?: string, io: Partial<CliIO> = {}): Promise<number> {
  out = "";
  err = "";
  return main(["node", "mc", ...args], { stdout: (t) => (out += t), stderr: (t) => (err += t), ...(stdin !== undefined && { stdin: async () => stdin }), ...io });
}

const store = (): MissionStore => new MissionStore(home);
const missions = (): Mission[] => store().list();
const noMissionFolder = (): boolean => !readdirSafe(join(home, "missions")).length;
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** The app folder ~/mc-apps/habit-tracker: a git repository on the branch main. */
async function habitTracker(name = "habit-tracker"): Promise<string> {
  const dir = join(apps, name);
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  return dir;
}

const BLOCK_ONE = `You asked: On the settings page of the habit tracker, add a Dark mode switch. It should remember my choice.
App name: Habit tracker
Summary: Adds a Dark mode switch to the settings page. The page turns dark when it is on, and the choice is remembered.

1 feature:

1. “Dark mode switch on the settings page” (id: dark-mode)
   As a user I can switch the app to dark colours on the settings page, and it stays that way when I come back.
   It counts as done when:
   - The settings page shows a switch labelled Dark mode, and it is off by default.
   - Turning the switch on makes the page background dark.
   - Turning the switch off makes the page background light again.
   - After the switch is turned on and the page is reloaded, the switch is still on and the page is dark.
   - After the switch is turned off and the page is reloaded, the switch is off and the page is light.

Choices made for you:
- The switch is off until the person turns it on, and the choice is kept for that person on the same device.

Names the tests and the code must agree on:
- The switch is on the settings page and its label is Dark mode.
- The switch has the test id dark-mode-switch.
`;

const NEXT = (stop: string): string => `
What happens next:
- The team's planner is skipped. This plan is used as written.
- A second AI reads the plan first and may ask for changes.
- ${stop}
- For each feature the checks are written first, the work is done until they pass, and a different AI reviews it.

To queue it, run the same command with "plan queue" instead of "plan preview".
`;

// ───────────────────────────── preview ─────────────────────────────

describe("mc plan preview", () => {
  it("shows a plan for an existing app in plain words, verbatim, and queues nothing", async () => {
    await habitTracker();
    expect(await mc(["plan", "preview", "-"], ONE)).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(
      `This plan can be used. Nothing was queued.

Plan “Dark mode”: a change to ~/mc-apps/habit-tracker, starting from branch main.
Plan code: a4adaca5 (the same plan always gets the same code).
${BLOCK_ONE}${NEXT("It will stop for your check: the plan.")}`,
    );
    expect(noMissionFolder()).toBe(true);
    expect(readdirSafe(home)).toEqual([]); // not even the Mission Control folder is made
  });

  it("shows a new app with the folder it will go in, and every feature with what it needs first", async () => {
    expect(await mc(["plan", "preview", "-"], THREE)).toBe(0);
    expect(out).toContain("Plan “Reading list”: a new app.\nPlan code: c5b7a589 (the same plan always gets the same code).\n");
    expect(out).toContain("App name: Reading list (the new app goes in a new folder called reading-list, or the next free name)\n");
    expect(out).toContain("\n3 features:\n\n1. “Add a book to the list” (id: add-book)\n");
    expect(out).toContain("   Needs first: “Mark a book as read”.\n");
    expect(noMissionFolder()).toBe(true);
  });

  it("says which stops it will have: none with --no-plan-checkpoint, and the plan and the finished app with --checkpoint final", async () => {
    await mc(["plan", "preview", "-", "--no-plan-checkpoint"], THREE);
    expect(out).toContain("- It will not stop for your check.\n");
    await mc(["plan", "preview", "-", "--checkpoint", "final"], THREE);
    expect(out).toContain("- It will stop for your check: the plan, the finished app.\n");
    await mc(["plan", "preview", "-", "--no-plan-checkpoint", "--checkpoint", "feature"], THREE);
    expect(out).toContain("- It will stop for your check: each feature, before it is added.\n");
  });

  it("lists what is wrong on standard error, 12 at most, then how many more, and exits 1", async () => {
    const lines = ONE.split("\n").filter((l) => !l.startsWith("check:") && !l.startsWith("assumption:"));
    const many = [...lines.slice(0, 5), ...Array.from({ length: 14 }, (_, i) => `colour${i}: blue`), ...lines.slice(5)].join("\n");
    expect(await mc(["plan", "preview", "-"], many)).toBe(1);
    expect(out).toBe("");
    const printed = err.trimEnd().split("\n");
    expect(printed[0]).toBe("This plan can't be used yet. Fix these and preview it again:");
    expect(printed).toHaveLength(14);
    expect(printed[1]).toBe("- Line 6: “colour0” is not a key that can be used. For the whole plan: name, request, folder, base, app-name, summary, assumption, contract. For each feature: feature, title, story, kind, needs, check.");
    expect(printed[13]).toBe("- ... and 3 more."); // 14 unknown keys and the feature with no check make 15 problems
    expect(noMissionFolder()).toBe(true);
  });

  it("prints a plan problem for a bracket and a first line alone", async () => {
    expect(await mc(["plan", "preview", "-"], '{"format":"mc-plan/1"}')).toBe(1);
    expect(err.trimEnd().split("\n")).toEqual([
      "This plan can't be used yet. Fix these and preview it again:",
      "- The plan has a curly bracket on line 1. Plans are plain lines of “key: value” text and never use curly brackets. Write the words without them.",
      "- The first line of the plan must be exactly: mc-plan 1 (it is “{\"format\":\"mc-plan/1\"}”).",
    ]);
  });
});

// ───────────────────────────── queue ─────────────────────────────

describe("mc plan queue", () => {
  it("queues a plan for a new app: the mission, the plan it keeps, and the default stop at the plan", async () => {
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(0);
    const [m] = missions() as [Mission];
    expect(missions()).toHaveLength(1);
    const [header, block] = out.split("\n\nYou asked:") as [string, string];
    expect(header).toBe(
      `Queued the plan “Reading list” for a new app.
Mission id: ${m.id}
Plan code: c5b7a589 (compare it with the code the preview showed).
It will stop for your check: the plan.
It starts on the next run, for example: mc run --mission ${m.id}`,
    );
    expect(block.startsWith(" I want a small web app to keep my reading list.")).toBe(true);
    expect(out).toContain("App name: Reading list (the new app goes in a new folder called reading-list, or the next free name)");
    expect(m).toMatchObject({
      kind: "greenfield",
      title: "Reading list",
      request: expect.stringContaining("keep my reading list"),
      repoPath: "",
      baseBranch: "main",
      status: "queued",
      stage: "spec",
      checkpoints: ["plan"],
      profile: "mixed",
      roleOverrides: [],
    });
    expect(m.plan?.sha256.slice(0, 8)).toBe("c5b7a589");
    expect(m.plan?.spec.features.map((f) => f.id)).toEqual(["add-book", "mark-read", "read-count"]);
    expect(m.plan?.spec.uiContract).toContain("- The page title is Reading list.");
    expect(m.plan?.review).toBeUndefined();
    expect(readdirSafe(store().missionDir(m.id))).toEqual(["mission.json"]); // no plan file, nothing but the mission
  });

  it("queues a change to an app in ~/mc-apps: the checked repository, its branch, and the onboard stage", async () => {
    const repo = await habitTracker();
    expect(await mc(["plan", "queue", "-"], ONE)).toBe(0);
    const [m] = missions() as [Mission];
    expect(out).toBe(
      `Queued the plan “Dark mode”: a change to ~/mc-apps/habit-tracker, starting from branch main.
Mission id: ${m.id}
Plan code: a4adaca5 (compare it with the code the preview showed).
It will stop for your check: the plan.
It starts on the next run, for example: mc run --mission ${m.id}

${BLOCK_ONE}`,
    );
    expect(m).toMatchObject({ kind: "feature", repoPath: realpathSync(repo), baseBranch: "main", stage: "onboard", checkpoints: ["plan"] });
    expect(m.plan?.sha256.slice(0, 8)).toBe("a4adaca5");
  });

  it("gives the preview's plan code and the queue's the same, and a plan that is not usable queues nothing", async () => {
    await mc(["plan", "preview", "-"], THREE);
    const previewed = /Plan code: (\w+)/.exec(out)?.[1];
    await mc(["plan", "queue", "-"], THREE);
    expect(/Plan code: (\w+)/.exec(out)?.[1]).toBe(previewed);
    expect(await mc(["plan", "queue", "-"], THREE.replace("name: Reading list", "nom: Reading list"))).toBe(1);
    expect(missions()).toHaveLength(1);
  });

  it("stops at the plan by default, and only a flag on the command line turns that off", async () => {
    let n = 0;
    const queued = async (...flags: string[]): Promise<Mission> => {
      // a different plan each time: one that is already queued is refused (see "the same plan twice")
      await mc(["plan", "queue", "-", ...flags], THREE.replace("name: Reading list", `name: Reading list ${++n}`));
      return store().load(/Mission id: (\S+)/.exec(out)?.[1] ?? "");
    };
    expect((await queued()).checkpoints).toEqual(["plan"]);
    const off = await queued("--no-plan-checkpoint");
    expect("checkpoints" in off).toBe(false); // no checkpoints key at all
    expect(out).toContain("It will not stop for your check.");
    expect((await queued("--checkpoint", "final")).checkpoints).toEqual(["plan", "final"]);
    expect((await queued("--checkpoint", "final", "--checkpoint", "feature")).checkpoints).toEqual(["plan", "feature", "final"]);
    expect((await queued("--no-plan-checkpoint", "--checkpoint", "plan")).checkpoints).toEqual(["plan"]);
    expect((await queued("--no-plan-checkpoint", "--checkpoint", "final")).checkpoints).toEqual(["final"]);
    // the plan text cannot turn the stop off, whatever it says
    expect(await mc(["plan", "queue", "-"], THREE.replace("name: Reading list", "no-plan-checkpoint: yes\nname: Reading list"))).toBe(1);
  });

  it("refuses a checkpoint that is not one, before it reads the plan", async () => {
    const stdin = vi.fn(async () => THREE);
    expect(await mc(["plan", "queue", "-", "--checkpoint", "x"], undefined, { stdin })).toBe(1);
    expect(err).toBe("“x” is not a checkpoint. Choose from: plan, feature, final.\n");
    expect(stdin).not.toHaveBeenCalled();
    expect(missions()).toEqual([]);
  });

  it("does not offer the AIs: the mission gets the default profile, and there is no --profile or --role", async () => {
    await mc(["plan", "queue", "-"], THREE);
    expect(missions()[0]?.profile).toBe("mixed");
    expect(await mc(["plan", "queue", "-", "--profile", "claude"], THREE)).toBe(1);
    expect(err).toContain("unknown option '--profile'");
  });
});

// ───────────────────────────── the same plan twice ─────────────────────────────

describe("the same plan twice", () => {
  const sentence = (m: Mission): string => `This plan is already queued as “${m.title}” (${m.id}). See it with: mc status`;
  /** Queues THREE, then sets the mission's status (and the failure that goes with a failed one). */
  async function queuedWith(status: Mission["status"], failure?: Mission["failure"]): Promise<Mission> {
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(0);
    const [m] = missions() as [Mission];
    store().save({ ...m, status, ...(failure && { failure }) });
    return m;
  }

  it("refuses to queue a plan that is already queued, says which mission has it, and queues and spends nothing", async () => {
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(0);
    const [first] = missions() as [Mission];
    const folders = readdirSafe(join(home, "missions"));
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(`${sentence(first)}\n`);
    expect(err).toBe(`This plan is already queued as “Reading list” (${first.id}). See it with: mc status\n`);
    expect(missions()).toHaveLength(1);
    expect(readdirSafe(join(home, "missions"))).toEqual(folders);
    expect(store().load(first.id)).toEqual(first); // the mission that holds the plan is as it was
    // the flags do not make it another plan, and neither do blank lines or the order of lines inside a block
    expect(await mc(["plan", "queue", "-", "--no-plan-checkpoint"], THREE)).toBe(1);
    expect(await mc(["plan", "queue", "-", "--checkpoint", "final"], THREE)).toBe(1);
    expect(await mc(["plan", "queue", "-"], THREE.replaceAll("\n\nfeature:", "\n\n\n\nfeature:"))).toBe(1);
    expect(await mc(["plan", "queue", "-"], THREE.replaceAll("\n", "\r\n"))).toBe(1);
    expect(err).toBe(`${sentence(first)}\n`);
    expect(missions()).toHaveLength(1);
  });

  it("refuses the plan of a change to an existing app the same way", async () => {
    await habitTracker();
    expect(await mc(["plan", "queue", "-"], ONE)).toBe(0);
    const [first] = missions() as [Mission];
    expect(await mc(["plan", "queue", "-"], ONE)).toBe(1);
    expect(err).toBe(`This plan is already queued as “Dark mode” (${first.id}). See it with: mc status\n`);
    expect(missions()).toHaveLength(1);
  });

  it("queues a plan that differs by one character, or another plan, beside it", async () => {
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(0);
    expect(await mc(["plan", "queue", "-"], THREE.replace("Adding a book with an empty title adds nothing", "Adding a book with a missing title adds nothing"))).toBe(0);
    expect(await mc(["plan", "queue", "-"], THREE.replace("name: Reading list", "name: Reading list two"))).toBe(0);
    expect(missions()).toHaveLength(3);
  });

  it.each(["queued", "running", "waiting", "stopped"] as const)("refuses it while the mission is %s", async (status) => {
    const m = await queuedWith(status);
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(1);
    expect(err).toBe(`${sentence(m)}\n`);
    expect(missions()).toHaveLength(1);
  });

  it("refuses it while the mission waits at a check, which is a stopped mission", async () => {
    const m = await queuedWith("stopped");
    const parked = store().load(m.id);
    store().save({
      ...parked,
      checkpoint: { id: "plan#1", scope: "plan", kind: "plan", round: 1, state: "pending", parkedAt: new Date().toISOString(), look: { headline: "Check the plan", lines: ["a line"] } },
    });
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(1);
    expect(err).toBe(`${sentence(m)}\n`);
  });

  it("refuses it while a failed mission is retried by the next run (a login that expired)", async () => {
    const m = await queuedWith("failed", { reason: "Every AI needs a new login.", retryable: true });
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(1);
    expect(err).toBe(`${sentence(m)}\n`);
  });

  it.each([
    ["done", undefined],
    ["partial", undefined],
    ["failed", undefined],
    ["failed", { reason: "It could not finish.", retryable: false }],
  ] as const)("queues it again once the mission is finished (%s %j): a fair new attempt", async (status, failure) => {
    const old = await queuedWith(status, failure as Mission["failure"] | undefined);
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(0);
    expect(err).toBe("");
    expect(missions()).toHaveLength(2);
    const fresh = missions().find((m) => m.id !== old.id) as Mission;
    expect(fresh).toMatchObject({ status: "queued", title: "Reading list" });
    expect(out).toContain(`Mission id: ${fresh.id}`);
    // now the new one is the live twin
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(1);
    expect(err).toBe(`${sentence(fresh)}\n`);
  });

  it("does not mistake a mission the team's planner planned for the same plan", async () => {
    // the same words, queued the old way: it holds no plan code
    expect(await mc(["new", "I want a small web app to keep my reading list.", "--name", "Reading list"])).toBe(0);
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(0);
    expect(missions()).toHaveLength(2);
  });

  it("only notes it in a preview, which still reads and queues nothing, and says nothing for a plan that is not queued", async () => {
    await mc(["plan", "preview", "-"], THREE);
    expect(out).not.toContain("already queued");
    expect(await mc(["plan", "queue", "-"], THREE)).toBe(0);
    const [m] = missions() as [Mission];
    expect(await mc(["plan", "preview", "-"], THREE)).toBe(0);
    expect(err).toBe("");
    expect(out.split("\n").slice(0, 4)).toEqual(["This plan can be used. Nothing was queued.", sentence(m), "", "Plan “Reading list”: a new app."]);
    expect(missions()).toHaveLength(1);
    // once the mission has finished the preview has no note
    store().save({ ...store().load(m.id), status: "done" });
    await mc(["plan", "preview", "-"], THREE);
    expect(out).not.toContain("already queued");
  });

  it("makes the leader's retry safe: queueing it a second time after a lost answer finds the first mission", async () => {
    await mc(["plan", "queue", "-"], THREE);
    const [m] = missions() as [Mission];
    for (let i = 0; i < 3; i++) expect(await mc(["plan", "queue", "-"], THREE)).toBe(1);
    expect(missions().map((x) => x.id)).toEqual([m.id]);
  });
});

// ───────────────────────────── the folder ─────────────────────────────

describe("the app folder of a plan", () => {
  const withFolder = (folder: string, base?: string): string =>
    ONE.replace("folder: habit-tracker", `folder: ${folder}`).replace("base: main\n", base === undefined ? "" : `base: ${base}\n`);
  const cannot = (...lines: string[]): string => `This plan can't be used yet. Fix these and preview it again:\n${lines.map((l) => `- ${l}\n`).join("")}`;

  it("is checked as mc feature checks it, in the plan's words, and nothing is queued", async () => {
    const dir = join(apps, "habit-tracker");
    expect(await mc(["plan", "preview", "-"], ONE)).toBe(1);
    expect(err).toBe(cannot(`There is no folder at ${dir}.`));
    mkdirSync(dir);
    expect(await mc(["plan", "queue", "-"], ONE)).toBe(1);
    expect(err).toBe(cannot(`${dir} is not a git repository. Mission Control needs the app's git history to change it safely. Inside that folder, run "git init", then commit your files.`));
    rmSync(dir, { recursive: true });
    const repo = await habitTracker();
    expect(await mc(["plan", "preview", "-"], withFolder("habit-tracker", "nope"))).toBe(1);
    expect(err).toBe(cannot(`There is no branch called "nope" in ${realpathSync(repo)}.`));
    expect(missions()).toEqual([]);
  });

  it("says the folder is inside another repository by naming the “folder” line, never mc feature", async () => {
    // the apps folder is itself a repository (its owner ran git init there), so an app folder in it is not a top folder
    mkdirSync(join(apps, "habit-tracker"));
    writeFileSync(join(apps, "habit-tracker", "README.md"), "hello\n");
    await git(apps, "init", "-q", "-b", "main");
    await git(apps, "add", "-A");
    await git(apps, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
    expect(await mc(["plan", "preview", "-"], ONE)).toBe(1);
    expect(err).toBe(cannot(`${join(apps, "habit-tracker")} is inside the git repository ${realpathSync(apps)}. Use the app's top folder for “folder” instead.`));
    // mc feature keeps its own words
    expect(await mc(["feature", join(apps, "habit-tracker"), "Add a thing"])).toBe(1);
    expect(err).toContain(`Give the app's top folder instead: mc feature ${realpathSync(apps)} "..."`);
  });

  it("uses the branch that is checked out when the plan has no base line", async () => {
    await habitTracker();
    await mc(["plan", "queue", "-"], withFolder("habit-tracker"));
    expect(out).toContain("starting from branch main.");
    expect(missions()[0]?.baseBranch).toBe("main");
  });

  it("asks for a base line, not --base, when no branch is checked out; mc feature still names its flag", async () => {
    const repo = await habitTracker();
    await git(repo, "checkout", "-q", "--detach");
    expect(await mc(["plan", "preview", "-"], withFolder("habit-tracker"))).toBe(1);
    expect(err).toContain(`- ${realpathSync(repo)} has no branch checked out`);
    expect(err).toContain("Or choose the branch to start from with a “base” line.");
    expect(err).not.toMatch(/--base|mc feature/);
    expect(await mc(["plan", "preview", "-"], withFolder("habit-tracker", "main"))).toBe(0); // with a base line it works
    expect(await mc(["feature", repo, "Add a thing"])).toBe(1);
    expect(err).toContain("Or choose the branch to start from with --base <branch>.");
  });

  it("refuses a folder that is a link leading out of ~/mc-apps", async () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(apps, "habit-tracker"));
    expect(await mc(["plan", "queue", "-"], ONE)).toBe(1);
    expect(err).toBe(cannot("The folder “habit-tracker” leads outside ~/mc-apps, so it can't be used."));
    expect(missions()).toEqual([]);
  });
});

// ───────────────────────────── where the plan comes from ─────────────────────────────

describe("where the plan comes from", () => {
  it("reads standard input only for -, and through the stdin that main() was given", async () => {
    const stdin = vi.fn(async () => THREE);
    expect(await mc(["plan", "preview", "-"], undefined, { stdin })).toBe(0);
    expect(stdin).toHaveBeenCalledTimes(1);
    expect(out).toContain("Plan code: c5b7a589");
  });

  it("with no file does not wait for standard input, and says what to do", async () => {
    const stdin = vi.fn(async () => THREE);
    expect(await mc(["plan", "preview"], undefined, { stdin })).toBe(1);
    expect(err).toBe("There is no plan to read. Give a file name, or write - to read the plan sent in with the command.\n");
    expect(stdin).not.toHaveBeenCalled();
  });

  it("says so when - is given on a terminal, where nothing was sent in", async () => {
    const stdin = vi.fn(async () => THREE);
    expect(await mc(["plan", "preview", "-"], undefined, { stdin, stdinIsTerminal: () => true })).toBe(1);
    expect(err).toBe("Nothing was sent in. Send the plan with the command, or give a file name.\n");
    expect(stdin).not.toHaveBeenCalled();
  });

  it("removes a byte-order mark, and refuses an empty text and a text over 30,000 characters", async () => {
    expect(await mc(["plan", "preview", "-"], `\uFEFF${THREE}`)).toBe(0);
    expect(out).toContain("Plan code: c5b7a589");
    expect(await mc(["plan", "preview", "-"], "")).toBe(1);
    expect(err).toContain("- The first line of the plan must be exactly: mc-plan 1 (the plan is empty).");
    expect(await mc(["plan", "preview", "-"], `${THREE}${" ".repeat(30_000)}`)).toBe(1);
    expect(err).toBe("This plan can't be used yet. Fix these and preview it again:\n- The plan is too long (more than 30,000 characters). Shorten it, or split the work into two plans.\n");
  });

  it("stops reading a stream that sends more than a plan can hold", async () => {
    const big = Readable.from([Buffer.alloc(100_000, 97), Buffer.alloc(100_000, 97), Buffer.alloc(100_000, 97)]);
    const text = await readCapped(big, 120_000);
    expect(text.length).toBeGreaterThan(120_000);
    expect(text.length).toBeLessThan(300_000);
    expect(await readCapped(Readable.from(["mc-plan 1\n", Buffer.from("name: x\n")]))).toBe("mc-plan 1\nname: x\n");
    expect(await readCapped(Readable.from([]))).toBe("");
  });

  it("reads a file inside ~/mc-apps, also through a path with ~", async () => {
    writeFileSync(join(apps, "plan.txt"), THREE);
    expect(await mc(["plan", "preview", join(apps, "plan.txt")])).toBe(0);
    expect(out).toContain("Plan code: c5b7a589");
    expect(await mc(["plan", "preview", "~/mc-apps/plan.txt"])).toBe(0);
  });

  it("does not show the first line of a file that is not a plan", async () => {
    writeFileSync(join(apps, "notes.env"), "API_KEY=abc123\nOTHER=1\n");
    expect(await mc(["plan", "preview", join(apps, "notes.env")])).toBe(1);
    expect(err + out).not.toContain("abc123");
    expect(err + out).toContain("The first line of the plan must be exactly: mc-plan 1.");
  });

  it("refuses a file that is missing, outside ~/mc-apps, a folder, or a link out of it", async () => {
    const outside = join(root, "plan.txt");
    writeFileSync(outside, THREE);
    symlinkSync(outside, join(apps, "link.txt"));
    mkdirSync(join(apps, "a-folder"));
    for (const file of [join(apps, "missing.txt"), outside, join(apps, "a-folder"), join(apps, "link.txt"), "/etc/passwd"]) {
      expect(await mc(["plan", "preview", file])).toBe(1);
      expect(err).toBe(`There is no plan file at ${file}. A file must be inside ~/mc-apps to be seen from the container; or send the plan in and write - instead.\n`);
    }
    expect(missions()).toEqual([]);
  });

  it("never prints text of a file it refused", async () => {
    writeFileSync(join(root, "secret.txt"), "the secret\n");
    expect(await mc(["plan", "preview", join(root, "secret.txt")])).toBe(1);
    expect(err + out).not.toContain("the secret");
  });
});

// ───────────────────────────── show ─────────────────────────────

describe("mc plan show", () => {
  const SHOW_HEAD = (id: string): string => `Plan for “Dark mode” (mission ${id}): a change to ~/mc-apps/habit-tracker.\n`;

  /** A queued plan mission, changed the way the engine changes it, while no run is going. */
  async function queued(change: (m: Mission) => void = () => {}): Promise<Mission> {
    await habitTracker();
    await mc(["plan", "queue", "-"], ONE);
    const m = missions()[0] as Mission;
    change(m);
    store().save(m);
    return m;
  }

  it("prints the plan of a queued plan mission, all of it, with the plan code and who wrote it", async () => {
    const m = await queued();
    expect(await mc(["plan", "show", m.id])).toBe(0);
    expect(out).toBe(
      `${SHOW_HEAD(m.id)}Written by the leader. Plan code a4adaca5 (of the plan as the leader wrote it).\n\n${BLOCK_ONE}`,
    );
  });

  it("shows the plan the mission holds now, and what the team's plan reviewer did with it", async () => {
    const m = await queued();
    const outcomes: [NonNullable<Mission["plan"]>["review"], string][] = [
      [{ outcome: "approved", issues: [] }, "The team's plan reviewer read it and asked for no changes."],
      [{ outcome: "revised", issues: ["Name the label.", "Add a check for off by default."] }, "The team's plan reviewer asked for changes, so the team's planner revised the plan. This is the revised plan. It asked: Name the label. Add a check for off by default."],
      [{ outcome: "not_applied", issues: ["Add a check."] }, "The team's plan reviewer asked for changes that could not be applied, so the plan is as the leader wrote it. It asked: Add a check."],
      [{ outcome: "unfinished", issues: [] }, "The team's plan reviewer did not finish, so the plan is as the leader wrote it."],
    ];
    for (const [review, line] of outcomes) {
      const x = store().load(m.id);
      if (x.plan) x.plan.review = review;
      // after adoption the mission holds the plan it works from: here a revision with another story
      x.spec = { ...(x.plan?.spec as NonNullable<Mission["spec"]>), features: (x.plan?.spec.features ?? []).map((f) => ({ ...f, story: "As a user I get a new story." })) };
      store().save(x);
      expect(await mc(["plan", "show", m.id])).toBe(0);
      expect(out.split("\n").slice(0, 3)).toEqual([SHOW_HEAD(m.id).trimEnd(), "Written by the leader. Plan code a4adaca5 (of the plan as the leader wrote it).", line]);
      expect(out).toContain("   As a user I get a new story.\n");
    }
  });

  it("says how many times the owner sent the plan back, from the checkpoint log", async () => {
    const m = await queued((x) => {
      if (x.plan) x.plan.review = { outcome: "approved", issues: [] };
      x.checkpointLog = [{ id: "plan#1", scope: "plan", kind: "plan", round: 1, decision: "send_back", note: "x", at: "2026-10-12T10:00:00.000Z" }];
    });
    await mc(["plan", "show", m.id]);
    expect(out).toContain("The team's plan reviewer read it and asked for no changes.\nYou sent the plan back once. This is the plan as it stands now.\n\nYou asked:");
    store().save({ ...store().load(m.id), checkpointLog: [...(store().load(m.id).checkpointLog ?? []), { id: "plan#2", scope: "plan", kind: "plan", round: 2, decision: "send_back", at: "2026-10-12T11:00:00.000Z" }] });
    await mc(["plan", "show", m.id]);
    expect(out).toContain("You sent the plan back twice.");
  });

  it("says the team's planner wrote it for a mission queued the old way, and has no plan code", async () => {
    const old = store().createMission({ kind: "greenfield", title: "Reading", request: "Make it", repoPath: "", baseBranch: "main", profile: "mixed", nowMs: Date.now() });
    const parsed = parsePlan(THREE);
    store().save({ ...old, spec: parsed.ok ? parsed.spec : undefined });
    expect(await mc(["plan", "show", old.id])).toBe(0);
    expect(out.split("\n").slice(0, 3)).toEqual([`Plan for “Reading” (mission ${old.id}): a new app.`, "Written by the team's planner.", ""]);
    expect(out).not.toContain("Plan code");
    expect(out).toContain("3 features:");
    // the id of each feature is shown for a plan the planner wrote too
    expect(out).toContain("\n1. “Add a book to the list” (id: add-book)\n");
    expect(out).toContain("\n3. “Count of books read” (id: read-count)\n");
  });

  it("says there is no plan yet when the team's planner has not written one, and no mission when the id is wrong", async () => {
    const old = store().createMission({ kind: "greenfield", title: "Reading", request: "Make it", repoPath: "", baseBranch: "main", profile: "mixed", nowMs: Date.now() });
    expect(await mc(["plan", "show", old.id])).toBe(1);
    expect(err).toBe("“Reading” has no plan yet. The team's planner writes it when the mission starts.\n");
    expect(out).toBe("");
    expect(await mc(["plan", "show", "nope"])).toBe(1);
    expect(err).toBe('There is no mission called "nope". See your missions with: mc status\n');
  });

  it("prints a plan from a mission file with text a person could not see as it is shown: control characters go", async () => {
    const m = await queued((x) => {
      if (x.plan) x.plan.spec.features[0]!.story = `Story\u001b[31m with escape`;
    });
    await mc(["plan", "show", m.id]);
    expect(out).not.toContain("\u001b");
  });

  it("is where mc status sends the owner at a plan stop, and mc report for any other stop", async () => {
    const stopped = (m: Mission, kind: "plan" | "final"): void => {
      m.status = "stopped";
      m.stage = "init";
      m.checkpoint = { id: `${kind}#1`, scope: kind, kind, round: 1, state: "pending", parkedAt: "2026-10-12T13:00:00.000Z", look: { headline: "Check it", lines: ["a line"] } };
      store().save(m);
    };
    const m = await queued((x) => stopped(x, "plan"));
    await mc(["status"]);
    expect(out).toContain(`is waiting for your check (the plan). Read it: mc plan show ${m.id}. Then: mc approve ${m.id}`);
    stopped(store().load(m.id), "final");
    await mc(["status"]);
    expect(out).toContain(`Read it: mc report ${m.id}. Then: mc approve ${m.id}`);
  });

  it("treats a damaged plan field as no plan, and never throws", async () => {
    const m = await queued();
    const file = join(store().missionDir(m.id), "mission.json");
    writeFileSync(file, JSON.stringify({ ...m, plan: "nonsense" }));
    expect(await mc(["plan", "show", m.id])).toBe(1);
    expect(err).toContain("has no plan yet");
  });
});

// ───────────────────────────── help ─────────────────────────────

describe("mc plan --help", () => {
  /** The help text on one line: commander wraps it at the width of a terminal. */
  const help = async (...args: string[]): Promise<string> => {
    expect(await mc([...args, "--help"])).toBe(0);
    return out.replace(/\s+/g, " ");
  };

  it("lists the three commands, and the flags of preview and queue", async () => {
    const all = await help("plan");
    expect(all).toContain("preview, queue and read plans written outside the team (by the leader)");
    for (const command of ["preview [options] [file]", "queue [options] [file]", "show <mission>"]) expect(all).toContain(command);
    for (const command of ["preview", "queue"]) {
      const text = await help("plan", command);
      expect(text).toContain("--checkpoint <kind>");
      expect(text).toContain("--no-plan-checkpoint do not stop for your check of the plan (only when you said you do not want to look at it first)");
    }
    expect(await help("plan", "queue")).toContain(
      "queue a plan. The team's planner is skipped and a second AI still reads the plan first. By default the mission stops for your check of the plan before anything is built. The same plan is not queued again until its mission has finished",
    );
    expect(await help("plan", "preview")).toContain("show a plan in plain words and make sure it can be used; nothing is queued. Give a file, or write - to read the plan sent in with the command");
    expect(await help("plan", "show")).toContain("show the plan of a mission in plain words, all of it");
  });

  it("has no --text, and mc --help lists plan", async () => {
    for (const args of [["plan", "--help"], ["plan", "preview", "--help"], ["plan", "queue", "--help"], ["plan", "show", "--help"]]) {
      await mc(args);
      expect(out).not.toContain("--text");
    }
    await mc(["--help"]);
    expect(out).toMatch(/\n\s+plan\b/);
  });
});
