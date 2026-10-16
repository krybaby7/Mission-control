// The command line for plans with a way of checking (docs/modes-spec.md section 9): the flag, the preview and the queue
// output, `mc plan show` after the second AI has answered, and the sentences of `mc logs`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliIO, describeEvent, main } from "./cli.js";
import { MissionStore } from "./state.js";
import type { CheckedResult, CheckpointRecord, Feature, FeatureChecked, Mission, MissionEvent } from "./types.js";
import { runProcess } from "./util/process.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "plans");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
/** Examples A, B and C of docs/modes-spec.md section 4.4, and example 1 of docs/plans-spec.md (no mode anywhere). */
const GUIDE = fixture("setup-guide.txt");
const LANDING = fixture("landing-page.txt");
const SALES = fixture("sales-totals.txt");
const DARK_MODE = fixture("dark-mode.txt");

let root: string;
let home: string;
let apps: string;
let out: string;
let err: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "mc-cli-modes-"));
  home = join(root, "home");
  apps = join(root, "user-home", "mc-apps");
  mkdirSync(apps, { recursive: true });
  vi.stubEnv("MC_HOME", home);
  vi.stubEnv("MC_CONFIG", "");
  vi.stubEnv("MC_IN_CONTAINER", "");
  vi.stubEnv("HOME", join(root, "user-home"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude-config"));
  for (const name of ["habit-tracker", "sales-data"]) await appFolder(name);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function mc(args: string[], stdin?: string, io: Partial<CliIO> = {}): Promise<number> {
  out = "";
  err = "";
  return main(["node", "mc", ...args], { stdout: (t) => (out += t), stderr: (t) => (err += t), ...(stdin !== undefined && { stdin: async () => stdin }), ...io });
}

const store = (): MissionStore => new MissionStore(home);

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** An app folder in ~/mc-apps: a git repository on the branch main. */
async function appFolder(name: string): Promise<void> {
  const dir = join(apps, name);
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
}

const NEXT_TAIL = `
To queue it, run the same command with "plan queue" instead of "plan preview".
`;
const PLANNER_LINES = `What happens next:
- The team's planner is skipped. This plan is used as written.
- A second AI reads the plan first and may ask for changes.
`;
const OLD_CHECK_LINE = "For each feature the checks are written first, the work is done until they pass, and a second AI reviews it.";
const TESTS_LINE = "Checked by tests (1): the checks are written first, the work is done until they pass, and a second AI reviews it.";
const REVIEW_LINE = (n: number): string =>
  `Checked by a second AI (${n}): the work is done, Mission Control checks it with scripts, and a second AI judges each check as passed or not, with a reason. No tests are written.`;
const OWNER_LINE = "Checked by a second AI and then by you (1): the work is done, Mission Control checks it with scripts, and a second AI judges each check as passed or not, with a reason. Then the team stops for your look before the feature is added. No tests are written.";
const OWNER_LINE_NO_LOOK = "Checked by a second AI and then by you (1): the work is done, Mission Control checks it with scripts, and a second AI judges each check as passed or not, with a reason. It will be queued without a stop for your look. No tests are written.";
const PICTURES_LINE = "For web pages Mission Control tries to take pictures at phone width and desktop width, and the second AI is asked to look at them. If it cannot, it says so.";
const NO_LOOK = "It will not stop for your look at features marked “owner” or at features the second AI could not fully judge. They are checked by a second AI only.";

/** What follows "What happens next:" in a preview. */
function next(out: string): string[] {
  const at = out.indexOf("What happens next:");
  return out.slice(at, out.indexOf(NEXT_TAIL)).split("\n").slice(3).filter((l) => l !== "");
}

// ───────────────────────────── Compatibility ─────────────────────────────

describe("a mission queued without any of the new keys", () => {
  // Made with the code of the end of wave 1 (test/fixtures/plans/golden/mission-keys.json).
  const before = JSON.parse(readFileSync(join(FIXTURES, "golden", "mission-keys.json"), "utf8")) as Record<string, { keys: string[]; planKeys?: string[]; specKeys?: string[]; featureKeys?: string[] }>;
  const keysOf = (m: Mission): Record<string, string[]> => {
    const file = JSON.parse(readFileSync(join(home, "missions", m.id, "mission.json"), "utf8")) as Record<string, any>;
    return { keys: Object.keys(file).sort(), planKeys: Object.keys(file.plan ?? {}).sort(), specKeys: Object.keys(file.plan?.spec ?? {}).sort(), featureKeys: Object.keys(file.plan?.spec?.features?.[0] ?? {}).sort() };
  };

  it.each([
    ["plan", ["plan", "queue", "-"]],
    ["plan", ["plan", "queue", "-", "--no-owner-checkpoint"]],
    ["plan-checkpoints", ["plan", "queue", "-", "--checkpoint", "feature", "--checkpoint", "final"]],
  ])("a plan mission (%s) has exactly the keys it had, whatever the new flag says", async (name, args) => {
    expect(await mc(args, DARK_MODE)).toBe(0);
    expect(keysOf(store().list()[0] as Mission)).toEqual(before[name as string]);
  });

  it("a mission queued with mc new has exactly the keys it had", async () => {
    expect(await mc(["new", "A habit tracker", "--name", "Habit tracker"])).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(join(home, "missions", (store().list()[0] as Mission).id, "mission.json"), "utf8"))).sort()).toEqual(before.new?.keys);
  });

  it("a plan with the new keys adds keys only to its features, and ownerStops only with the flag", async () => {
    await mc(["plan", "queue", "-"], GUIDE);
    const m = store().list()[0] as Mission;
    const file = JSON.parse(readFileSync(join(home, "missions", m.id, "mission.json"), "utf8")) as Record<string, any>;
    expect(Object.keys(file).sort()).toEqual(before.plan?.keys);
    expect(Object.keys(file.plan.spec.features[0]).sort()).toEqual(["acceptance", "deps", "expect", "id", "kind", "mode", "story", "title"]);
  });
});

// ───────────────────────────── The flag ─────────────────────────────

describe("--no-owner-checkpoint", () => {
  it("is listed by mc plan queue --help and mc plan preview --help", async () => {
    for (const command of ["queue", "preview"]) {
      expect(await mc(["plan", command, "--help"])).toBe(0);
      expect(out).toContain("--no-owner-checkpoint");
      // the help text wraps at the width of the screen
      expect(out.replace(/\s+/g, " ")).toContain("do not stop for your look at the features marked “owner” or that the second AI could not fully judge (only when you said you do not want to look at them first)");
    }
  });

  it("is stored on the mission as ownerStops false, only for a plan that has a review or owner feature", async () => {
    expect(await mc(["plan", "queue", "-", "--no-owner-checkpoint"], LANDING)).toBe(0);
    expect(await mc(["plan", "queue", "-", "--no-owner-checkpoint"], GUIDE)).toBe(0);
    expect(await mc(["plan", "queue", "-", "--no-owner-checkpoint"], SALES)).toBe(0);
    const stored = store().list();
    expect(stored).toHaveLength(3);
    for (const m of stored) expect(m.ownerStops).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "missions", stored[0]?.id as string, "mission.json"), "utf8")).ownerStops).toBe(false);
  });

  it("is not stored without the flag, and a plan with no mode feature ignores it silently", async () => {
    await mc(["plan", "queue", "-"], LANDING);
    await mc(["plan", "queue", "-", "--no-owner-checkpoint"], DARK_MODE);
    for (const m of store().list()) {
      expect(m.ownerStops).toBeUndefined();
      expect(Object.keys(JSON.parse(readFileSync(join(home, "missions", m.id, "mission.json"), "utf8")))).not.toContain("ownerStops");
    }
    expect(err).toBe("");
  });

  it("is said by the plan lines too: queue, preview and plan show never say that the owner looks at the feature", async () => {
    // the plan lines of the preview and of the queue
    expect(await mc(["plan", "queue", "-", "--no-owner-checkpoint"], LANDING)).toBe(0);
    expect(out).toContain("Checked by: a second AI, against its list of checks. It was queued without a stop for your look. No tests are written for it.");
    expect(out).toContain("It will not stop for your look at features marked “owner”");
    expect(out).not.toContain("and then by you");
    const id = store().list()[0]?.id as string;
    // plan show of the queued mission
    expect(await mc(["plan", "show", id])).toBe(0);
    expect(out).toContain("Checked by: a second AI, against its list of checks. It was queued without a stop for your look. No tests are written for it.");
    expect(out).not.toContain("and then by you");
    // without the flag the same plan says what it always said
    rmSync(join(home, "missions", id), { recursive: true });
    expect(await mc(["plan", "queue", "-"], LANDING)).toBe(0);
    expect(out).toContain("Checked by: a second AI, against its list of checks, and then by you. No tests are written for it.");
    // the owner who also asked for a stop at every feature is stopped at it, so the plan may say so
    rmSync(join(home, "missions", store().list()[0]?.id as string), { recursive: true });
    expect(await mc(["plan", "queue", "-", "--no-owner-checkpoint", "--checkpoint", "feature"], LANDING)).toBe(0);
    expect(out).toContain("Checked by: a second AI, against its list of checks, and then by you. No tests are written for it.");
  });

  it("is accepted by plan preview, which queues nothing", async () => {
    expect(await mc(["plan", "preview", "-", "--no-owner-checkpoint"], LANDING)).toBe(0);
    expect(store().list()).toEqual([]);
  });

  it("the plan file cannot turn the owner's stop off: its mission has no ownerStops key", async () => {
    await mc(["plan", "queue", "-"], LANDING.replace("mode: owner", "mode: owner\nowner-stop: no"));
    expect(err).toContain("“owner-stop” is not a key that can be used");
    expect(store().list()).toEqual([]);
  });

  it("refuses the same plan twice while its mission is alive, for a plan with modes as for any other", async () => {
    expect(await mc(["plan", "queue", "-"], GUIDE)).toBe(0);
    const id = store().list()[0]?.id;
    expect(await mc(["plan", "queue", "-"], GUIDE)).toBe(1);
    expect(err).toBe(`This plan is already queued as “Setup guide” (${id}). See it with: mc status\n`);
    expect(store().list()).toHaveLength(1);
  });
});

// ───────────────────────────── plan preview ─────────────────────────────

describe("mc plan preview with a way of checking", () => {
  const BLOCK_A = `You asked: Write a short setup guide for the habit tracker. A new user should be able to follow it in five minutes.
App name: Habit tracker
Summary: Adds a short setup guide for new users to the habit tracker's documents.

1 feature:

1. “Setup guide for new users” (id: setup-guide)
   As a new user I can follow a short guide to install the app and add my first habit.
   It counts as done when:
   - The guide is a list of numbered steps, and each step is one action.
   - The guide says how to start the app and what the reader should see when it works.
   - The guide explains how to add a first habit.
   - The guide does not name any file or setting that the project does not have.
   Checked by: a second AI, against its list of checks. No tests are written for it.
   Mission Control also checks, with no AI:
   - It has the headings “Install”, “Add your first habit”.
   - Its visible text contains the words “Habit tracker”, written exactly like that.
   - Its new text is 200 to 500 words long.

Choices made for you:
- The guide is written in English for someone who has never used the app.
`;

  it("prints example A verbatim: the block with its new lines, one stop line for the second AI's doubt, and one line about how it is checked", async () => {
    expect(await mc(["plan", "preview", "-"], GUIDE)).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(`This plan can be used. Nothing was queued.

Plan “Setup guide”: a change to ~/mc-apps/habit-tracker, starting from branch main.
Plan code: 5796d033 (the same plan always gets the same code).
${BLOCK_A}
${PLANNER_LINES}- It will stop for your check: the plan.
- If the second AI cannot judge a check of “Setup guide for new users”, it will stop for your look at that feature.
- ${REVIEW_LINE(1)}
${NEXT_TAIL}`);
    expect(store().list()).toEqual([]);
  });

  it("says nothing of tests in the preview or the queue output of a plan whose features no test checks", async () => {
    for (const text of [GUIDE, LANDING]) {
      for (const command of ["preview", "queue"]) {
        for (const flags of [[], ["--no-owner-checkpoint"], ["--no-plan-checkpoint"], ["--checkpoint", "feature"]]) {
          await mc(["plan", command, "-", ...flags], text);
          expect(err, `${command} ${flags.join(" ")}`).toBe("");
          expect(out.replaceAll("No tests are written.", "").replaceAll("No tests are written for it.", "")).not.toMatch(/\btest(s|ed|ing)?\b/i);
          expect(out).not.toMatch(/different AI|the engine|looked at it|—|–/);
          for (const m of store().list()) rmSync(join(home, "missions", m.id), { recursive: true, force: true });
        }
      }
    }
  });

  it("prints example A with the flag: one line that says the look is not asked for", async () => {
    expect(await mc(["plan", "preview", "-", "--no-owner-checkpoint"], GUIDE)).toBe(0);
    expect(out).toContain(`${PLANNER_LINES}- It will stop for your check: the plan.\n- ${NO_LOOK}\n- ${REVIEW_LINE(1)}\n`);
    expect(out).not.toContain(PICTURES_LINE);
    expect(out).not.toContain("If the second AI cannot judge");
  });

  it("prints example B: a stop at the owner feature, and the way it is checked", async () => {
    expect(await mc(["plan", "preview", "-"], LANDING)).toBe(0);
    expect(out).toContain("Plan code: aceddd4d (the same plan always gets the same code).\n");
    expect(out).toContain("   Effort: deep. The team's strongest AI builds it and checks it, and thinks longer.\n");
    expect(next(out)).toEqual([
      "- It will stop for your check: the plan.",
      "- It will stop for your look at “One-page landing page”, before it is added.",
      `- ${OWNER_LINE}`,
      `- ${PICTURES_LINE}`,
    ]);
    expect(await mc(["plan", "preview", "-", "--no-owner-checkpoint"], LANDING)).toBe(0);
    expect(next(out)).toEqual([
      "- It will stop for your check: the plan.",
      `- ${NO_LOOK}`,
      `- ${OWNER_LINE_NO_LOOK}`,
      `- ${PICTURES_LINE}`,
    ]);
  });

  it("prints example C: one line for each way of checking, in the order tests, second AI, second AI and you", async () => {
    expect(await mc(["plan", "preview", "-"], SALES)).toBe(0);
    expect(out).toContain("Plan code: c087c05b (the same plan always gets the same code).\n");
    expect(next(out)).toEqual([
      "- It will stop for your check: the plan.",
      "- If the second AI cannot judge a check of “Description of each column”, it will stop for your look at that feature.",
      `- ${TESTS_LINE}`,
      `- ${REVIEW_LINE(1)}`,
    ]);
    const three = SALES.replace("rows: 4-12\n", "rows: 4-12\n\nfeature: third\ntitle: Third\nstory: The third.\nmode: owner\ncheck: It reads well.\n");
    expect(await mc(["plan", "preview", "-"], three)).toBe(0);
    expect(next(out).slice(1)).toEqual([
      "- It will stop for your look at “Third”, before it is added.",
      "- If the second AI cannot judge a check of “Description of each column”, it will stop for your look at that feature.",
      `- ${TESTS_LINE}`,
      `- ${REVIEW_LINE(1)}`,
      `- ${OWNER_LINE}`,
    ]);
  });

  it("every line about a way of checking can be read alone: none of them points back at another line with the words “the same” (real run R2)", async () => {
    for (const text of [GUIDE, LANDING, SALES]) {
      for (const flags of [[], ["--no-owner-checkpoint"]]) {
        expect(await mc(["plan", "preview", "-", ...flags], text)).toBe(0);
        expect(next(out).join("\n")).not.toMatch(/\bthe same\b/);
      }
    }
    // a plan with only an owner feature reads whole: what is done, and what happens after it
    expect(await mc(["plan", "preview", "-"], LANDING)).toBe(0);
    expect(next(out)).toContain(`- ${OWNER_LINE}`);
    expect(OWNER_LINE).toContain("a second AI judges each check as passed or not, with a reason");
  });

  it("says the line about pictures only when a feature checked by reading talks about a web page (real run R2)", async () => {
    // a guide and a table have no page
    for (const text of [GUIDE, SALES]) {
      expect(await mc(["plan", "preview", "-"], text)).toBe(0);
      expect(out).not.toContain(PICTURES_LINE);
      expect(out).not.toMatch(/take pictures/);
    }
    // a page, or a file that ends in .html, or a style sheet, in the words of such a feature brings the line back
    for (const [what, text] of [
      ["a page", LANDING],
      ["a .html file", GUIDE.replace("heading: Install", "check: The guide is also saved as docs/setup.html.\nheading: Install")],
      ["a style sheet", GUIDE.replace("mention: Habit tracker", "mention: stylesheet")],
      ["a .css file", GUIDE.replace("heading: Install", "check: The look is set in docs/guide.css.\nheading: Install")],
    ] as const) {
      expect(await mc(["plan", "preview", "-"], text), what).toBe(0);
      expect(out, what).toContain(`- ${PICTURES_LINE}\n`);
    }
    // the word page in a feature checked by tests does not bring it
    expect(await mc(["plan", "preview", "-"], SALES.replace("The regions are in alphabetical order.", "The regions are in alphabetical order on the page."))).toBe(0);
    expect(out).not.toContain(PICTURES_LINE);
    // the line is at the end of the lines about checking, as before, and the queue prints none of it
    expect(await mc(["plan", "preview", "-"], LANDING)).toBe(0);
    expect(next(out).at(-1)).toBe(`- ${PICTURES_LINE}`);
    expect(await mc(["plan", "queue", "-"], LANDING)).toBe(0);
    expect(out).not.toContain("take pictures");
  });

  it("names at most three titles in a stop line, then how many more", async () => {
    const features = Array.from({ length: 5 }, (_, i) => `\nfeature: part-${i}\ntitle: Part ${i}\nstory: Part ${i}.\nmode: owner\ncheck: Part ${i} reads well.\n`).join("");
    expect(await mc(["plan", "preview", "-"], `${GUIDE.split("feature:")[0]}${features}`)).toBe(0);
    expect(next(out)[1]).toBe("- It will stop for your look at “Part 0”, “Part 1”, “Part 2” and 2 more, before each is added.");
    const two = `${GUIDE.split("feature:")[0]}${features.split("\nfeature:").slice(0, 3).join("\nfeature:")}`;
    expect(await mc(["plan", "preview", "-"], two)).toBe(0);
    expect(next(out)[1]).toBe("- It will stop for your look at “Part 0” and “Part 1”, before each is added.");
  });

  it("shows a curly mark inside a title as a straight one in the stop lines", async () => {
    expect(await mc(["plan", "preview", "-"], LANDING.replace("title: One-page landing page", "title: A”, “B"))).toBe(0);
    expect(next(out)[1]).toBe('- It will stop for your look at “A", "B”, before it is added.');
  });

  describe("the sentence that says there is no stop", () => {
    const OLD = "- It will not stop for your check.";
    const REPLACED = "- It will not stop for your check of the plan or of the finished app.";

    it("no checkpoint and no mode feature: the old sentence and the old line, unchanged", async () => {
      expect(await mc(["plan", "preview", "-", "--no-plan-checkpoint"], DARK_MODE)).toBe(0);
      expect(next(out)).toEqual([OLD, `- ${OLD_CHECK_LINE}`]);
      // the flag changes nothing for a plan with no mode feature
      expect(await mc(["plan", "preview", "-", "--no-plan-checkpoint", "--no-owner-checkpoint"], DARK_MODE)).toBe(0);
      expect(next(out)).toEqual([OLD, `- ${OLD_CHECK_LINE}`]);
    });

    it("no checkpoint and a look to come: the sentence is replaced by a true one, and the stop lines follow", async () => {
      expect(await mc(["plan", "preview", "-", "--no-plan-checkpoint"], SALES)).toBe(0);
      expect(next(out).slice(0, 2)).toEqual([REPLACED, "- If the second AI cannot judge a check of “Description of each column”, it will stop for your look at that feature."]);
      expect(out).not.toContain(`${OLD}\n`);
      expect(await mc(["plan", "preview", "-", "--no-plan-checkpoint"], LANDING)).toBe(0);
      expect(next(out).slice(0, 2)).toEqual([REPLACED, "- It will stop for your look at “One-page landing page”, before it is added."]);
    });

    it("no checkpoint and the flag: the old sentence stands, and the second line says no look is asked for", async () => {
      expect(await mc(["plan", "preview", "-", "--no-plan-checkpoint", "--no-owner-checkpoint"], SALES)).toBe(0);
      expect(next(out).slice(0, 2)).toEqual([OLD, `- ${NO_LOOK}`]);
    });

    it("--checkpoint feature: every feature stops anyway, so the look lines are left out", async () => {
      expect(await mc(["plan", "preview", "-", "--checkpoint", "feature"], LANDING)).toBe(0);
      expect(next(out)[0]).toBe("- It will stop for your check: the plan, each feature, before it is added.");
      expect(out).not.toMatch(/It will stop for your look|If the second AI cannot judge|It will not stop/);
      expect(await mc(["plan", "preview", "-", "--no-plan-checkpoint", "--checkpoint", "feature"], SALES)).toBe(0);
      expect(next(out)[0]).toBe("- It will stop for your check: each feature, before it is added.");
      expect(out).not.toMatch(/It will stop for your look|If the second AI cannot judge|It will not stop/);
    });

    it("--checkpoint feature together with the flag: still every feature, once, and no line that says otherwise", async () => {
      expect(await mc(["plan", "preview", "-", "--checkpoint", "feature", "--no-owner-checkpoint"], LANDING)).toBe(0);
      expect(next(out)).toEqual(["- It will stop for your check: the plan, each feature, before it is added.", `- ${OWNER_LINE}`, `- ${PICTURES_LINE}`]);
      expect(out).not.toMatch(/It will not stop|queued without a stop/);
    });

    it("a plan with no mode feature prints the old lines whatever the flags", async () => {
      for (const flags of [[], ["--checkpoint", "final"], ["--checkpoint", "feature", "--checkpoint", "final"]]) {
        expect(await mc(["plan", "preview", "-", ...flags], DARK_MODE)).toBe(0);
        expect(next(out).at(-1)).toBe(`- ${OLD_CHECK_LINE}`);
        expect(out).not.toMatch(/second AI judges|It will stop for your look|Checked by/);
      }
    });
  });
});

// ───────────────────────────── plan queue ─────────────────────────────

describe("mc plan queue with a way of checking", () => {
  it("prints the same stop lines without hyphens, then the block", async () => {
    expect(await mc(["plan", "queue", "-"], LANDING)).toBe(0);
    const id = store().list()[0]?.id as string;
    expect(out.split("\n").slice(0, 7)).toEqual([
      "Queued the plan “Landing page”: a change to ~/mc-apps/habit-tracker, starting from branch main.",
      `Mission id: ${id}`,
      "Plan code: aceddd4d (compare it with the code the preview showed).",
      "It will stop for your check: the plan.",
      "It will stop for your look at “One-page landing page”, before it is added.",
      `It starts on the next run, for example: mc run --mission ${id}`,
      "",
    ]);
    expect(await mc(["plan", "queue", "-", "--no-owner-checkpoint"], GUIDE)).toBe(0);
    expect(out.split("\n").slice(3, 6)).toEqual(["It will stop for your check: the plan.", NO_LOOK, expect.stringMatching(/^It starts on the next run/)]);
    expect(await mc(["plan", "queue", "-", "--no-plan-checkpoint"], SALES)).toBe(0);
    expect(out.split("\n").slice(3, 6)).toEqual([
      "It will not stop for your check of the plan or of the finished app.",
      "If the second AI cannot judge a check of “Description of each column”, it will stop for your look at that feature.",
      expect.stringMatching(/^It starts on the next run/),
    ]);
  });

  it("keeps the plan's modes, efforts and checks in the mission, and adds no key to a plan without them", async () => {
    await mc(["plan", "queue", "-"], SALES);
    await mc(["plan", "queue", "-"], DARK_MODE);
    const sales = store().list().find((m) => m.title === "Sales totals") as Mission;
    const dark = store().list().find((m) => m.title === "Dark mode") as Mission;
    expect(sales.plan?.spec.features.map((f) => [f.id, f.mode, f.effort, f.expect])).toEqual([
      ["region-totals", undefined, undefined, undefined],
      ["column-notes", "review", "light", { columns: ["Column", "Meaning", "Example"], rows: [4, 12] }],
    ]);
    expect(Object.keys(dark.plan?.spec.features[0] ?? {}).sort()).toEqual(["acceptance", "deps", "id", "kind", "story", "title"]);
  });
});

// ───────────────────────────── plan show ─────────────────────────────

describe("mc plan show: how each feature was checked", () => {
  const result = (n: number, result: CheckedResult["result"], evidence: string): CheckedResult => ({ n, result, evidence, basis: "text" });
  const log = (scope: string, decision: CheckpointRecord["decision"], round = 1): CheckpointRecord => ({ id: `${scope}#${round}`, scope, kind: "feature", round, decision, at: "2026-10-12T13:30:00.000Z" });

  /** Example C queued, then changed the way the engine changes it: both features adopted, the second one with `change`. */
  async function salesMission(change: (m: Mission, notes: Feature, totals: Feature) => void = () => {}): Promise<Mission> {
    await mc(["plan", "queue", "-"], SALES);
    const m = store().list()[0] as Mission;
    m.spec = m.plan?.spec as NonNullable<Mission["spec"]>;
    m.features = m.spec.features.map(
      (sf): Feature => ({ ...sf, status: "pending", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] }),
    );
    const [totals, notes] = m.features as [Feature, Feature];
    change(m, notes, totals);
    store().save(m);
    return m;
  }

  const checked = (results: CheckedResult[], extra: Partial<FeatureChecked> = {}): FeatureChecked => ({
    round: 2,
    reviewer: "claude",
    results,
    unjudged: results.filter((r) => r.result === "cannot_judge").length,
    scripted: { problems: [], facts: [] },
    pictures: { taken: 0 },
    ...extra,
  });

  const section = (): string[] => out.slice(out.indexOf("How each feature was checked:")).split("\n");

  it("prints nothing extra for a plan with no mode feature", async () => {
    await mc(["plan", "queue", "-"], DARK_MODE);
    expect(await mc(["plan", "show", (store().list()[0] as Mission).id])).toBe(0);
    expect(out).not.toContain("How each feature was checked");
    expect(out).not.toMatch(/second AI|Checked by|Mission Control also checks/);
  });

  it("for a mission that was only queued: every feature of the plan, in the plan's order, not checked yet", async () => {
    await mc(["plan", "queue", "-"], SALES);
    const m = store().list()[0] as Mission;
    expect(m.features).toEqual([]);
    expect(await mc(["plan", "show", m.id])).toBe(0);
    expect(section()).toEqual(["How each feature was checked:", "- “Totals for each region”: not checked yet.", "- “Description of each column”: not checked yet.", ""]);
  });

  it("before anything was checked: not checked yet, for the tests feature as for the other", async () => {
    const m = await salesMission();
    expect(await mc(["plan", "show", m.id])).toBe(0);
    expect(section()).toEqual(["How each feature was checked:", "- “Totals for each region”: not checked yet.", "- “Description of each column”: not checked yet.", ""]);
  });

  it("after the second AI answered: the counts, every check with its evidence, Mission Control's own checks, the pictures", async () => {
    const m = await salesMission((_m, notes, totals) => {
      totals.status = "done";
      totals.frozenTests = [{ path: "totals.test.ts", sha256: "x" }];
      notes.status = "done";
      notes.checked = checked([result(1, "pass", "“| Region | The sales region |” in docs/columns.md"), result(2, "fail", "It never says what the Units column means.")]);
    });
    expect(await mc(["plan", "show", m.id])).toBe(0);
    expect(section()).toEqual([
      "How each feature was checked:",
      "- “Totals for each region”: checked by tests.",
      "- “Description of each column”: a second AI checked it against your list (checked 2 times). 1 passed, 1 failed, 0 could not be judged.",
      "    1. passed: Every column of the sales file has a row in the description, with a plain meaning and an example value. Evidence: “| Region | The sales region |” in docs/columns.md",
      "    2. failed: The description does not say anything about a column that the sales file does not have. Evidence: It never says what the Units column means.",
      "  Mission Control's own checks: passed.",
      "  Pictures: none (this feature has no page).",
      "",
    ]);
  });

  // R2-5 of the real runs: a taste check (it ends "(the CEO decides)") is left for the owner, not "not judged".
  it("calls a taste check left for you, in the counts and on the check itself, and any other check that was not judged not judged", async () => {
    const m = await salesMission((_m, notes) => {
      notes.status = "done";
      notes.acceptance = ["First.", "Second (the CEO decides).", "Third."];
      notes.checked = checked([result(1, "pass", "a quote"), result(2, "cannot_judge", "A matter of taste."), result(3, "cannot_judge", "No file to read.")], { round: 1 });
    });
    expect(await mc(["plan", "show", m.id])).toBe(0);
    const lines = section();
    expect(lines[2]).toBe("- “Description of each column”: a second AI checked it against your list (checked once). 1 passed, 0 failed, 1 could not be judged, 1 left for you.");
    expect(lines[3]).toBe("    1. passed: First. Evidence: a quote");
    expect(lines[4]).toBe("    2. left for you: Second (the CEO decides). Evidence: A matter of taste.");
    expect(lines[5]).toBe("    3. not judged: Third. Evidence: No file to read.");
    // only taste checks: the counts name them alone
    rmSync(store().missionDir(m.id), { recursive: true, force: true });
    const only = await salesMission((_m, notes) => {
      notes.status = "done";
      notes.acceptance = ["First.", "Second (the CEO decides)."];
      notes.checked = checked([result(1, "pass", "a quote"), result(2, "cannot_judge", "A matter of taste.")], { round: 1 });
    });
    await mc(["plan", "show", only.id]);
    expect(section()[2]).toBe("- “Description of each column”: a second AI checked it against your list (checked once). 1 passed, 0 failed, 1 left for you.");
  });

  it("does not say a taste check is left for you when the plan was queued without a stop for the owner's look", async () => {
    const m = await salesMission((mm, notes) => {
      mm.ownerStops = false;
      notes.status = "done";
      notes.acceptance = ["First.", "Second (the CEO decides)."];
      notes.checked = checked([result(1, "pass", "a quote"), result(2, "cannot_judge", "A matter of taste.")], { round: 1 });
    });
    expect(await mc(["plan", "show", m.id])).toBe(0);
    const lines = section();
    expect(lines[2]).toBe("- “Description of each column”: a second AI checked it against your list (checked once). 1 passed, 0 failed, 1 could not be judged.");
    expect(lines[4]).toBe("    2. not judged: Second (the CEO decides). Evidence: A matter of taste.");
  });

  it("says once when it was checked once, cuts a long check at 120 characters, and shows what the script found", async () => {
    const m = await salesMission((_m, notes) => {
      notes.status = "done";
      notes.acceptance = [`${"Long check ".repeat(20)}end.`, "Second."];
      notes.checked = checked([result(1, "cannot_judge", "The file is binary."), result(2, "pass", "x")], {
        round: 1,
        scripted: { problems: ["“a.md” is empty.", "b", "c", "d"], facts: [] },
        pictures: { taken: 0, why: "no_browser" },
      });
    });
    await mc(["plan", "show", m.id]);
    const lines = section();
    expect(lines[2]).toBe("- “Description of each column”: a second AI checked it against your list (checked once). 1 passed, 0 failed, 1 could not be judged.");
    expect(lines[3]).toMatch(/^ {4}1\. not judged: Long check Long check .*… Evidence: The file is binary\.$/);
    expect((lines[3] ?? "").split(" Evidence:")[0]?.length).toBeLessThanOrEqual("    1. not judged: ".length + 120);
    expect(lines.slice(5, 7)).toEqual(["  Mission Control's own checks: found: “a.md” is empty.; b; c and 1 more.", "  Pictures: none (no browser was found in the container)."]);
  });

  it("V2-13: a feature that changed only a picture says the second AI was shown an image, not that the feature has no page", async () => {
    for (const [pictures, line] of [
      [{ taken: 0, images: 1 }, "  Pictures: The second AI was shown 1 changed image."],
      [{ taken: 0, images: 3 }, "  Pictures: The second AI was shown 3 changed images."],
      [{ taken: 2, images: 1 }, "  Pictures: 2 taken (phone and desktop width). The second AI was shown 1 changed image."],
      [{ taken: 2 }, "  Pictures: 2 taken (phone and desktop width)."],
      [{ taken: 0 }, "  Pictures: none (this feature has no page)."],
      [{ taken: 0, why: "reviewer" as const }, "  Pictures: none (the second AI could not look at the pictures, because it runs on a different tool)."],
    ] as const) {
      const m = await salesMission((_m, notes) => {
        notes.status = "done";
        notes.checked = checked([result(1, "pass", "a quote"), result(2, "pass", "a quote")], { pictures: { ...pictures } });
      });
      expect(await mc(["plan", "show", m.id])).toBe(0);
      expect(section().filter((l) => l.startsWith("  Pictures:")), JSON.stringify(pictures)).toEqual([line]);
      rmSync(store().missionDir(m.id), { recursive: true, force: true });
    }
  });

  it("V2-13: an odd number of images in a damaged record is read as none", async () => {
    const m = await salesMission((_m, notes) => {
      notes.status = "done";
      notes.checked = checked([result(1, "pass", "a quote"), result(2, "pass", "a quote")], { pictures: { taken: 0, images: "many" } as unknown as FeatureChecked["pictures"] });
    });
    expect(await mc(["plan", "show", m.id])).toBe(0);
    expect(section()).toContain("  Pictures: none (this feature has no page).");
  });

  it("shows evidence as one safe line: control characters and new lines are gone, and it is cut", async () => {
    const m = await salesMission((_m, notes) => {
      notes.status = "done";
      notes.checked = checked([result(1, "pass", `line one\nline two\u001b[2J ${"y".repeat(400)}`), result(2, "pass", "ok")]);
    });
    await mc(["plan", "show", m.id]);
    const line = section()[3] as string;
    expect(line).not.toMatch(/[\u0000-\u0008\u000B-\u001F]/);
    expect(line).toContain("Evidence: line one line two[2J yyy");
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(500);
  });

  it("reads a damaged record without failing: odd evidence, results, rounds and problems are shown as far as they can be", async () => {
    const m = await salesMission((_m, notes) => {
      notes.status = "done";
      notes.checked = { round: "x", reviewer: "claude", results: [{ n: 1, result: "pass", evidence: 42, basis: "text" }, null, { n: 2, result: "banana", evidence: "ok", basis: "text" }], unjudged: "none", scripted: { problems: [7, "a real one"], facts: [] }, pictures: { taken: "many" } } as unknown as FeatureChecked;
      (notes as { acceptance: unknown }).acceptance = ["Fine.", 5];
    });
    expect(await mc(["plan", "show", m.id]), err).toBe(0);
    expect(section().join("\n")).toContain("1. passed: Fine.\n");
    expect(section().join("\n")).toContain("2. not judged: Evidence: ok\n");
    expect(section().join("\n")).toContain("Mission Control's own checks: found: a real one.");
  });

  it("a mission file whose plan is damaged still prints the plan header and exits 0, as it did before ways of checking existed (V1-4)", async () => {
    // `spec` is not a plan: no features, a list with a hole, a bare word. Wave 1 printed what it could and exited 0; nothing here may print a raw error.
    for (const spec of [{ results: "x" }, [null], "owner ", { features: "owner" }, { features: {} }]) {
      const m = await salesMission();
      writeFileSync(join(store().missionDir(m.id), "mission.json"), JSON.stringify({ ...m, spec }));
      const code = await mc(["plan", "show", m.id]);
      expect(err, JSON.stringify(spec)).toBe("");
      expect(code, JSON.stringify(spec)).toBe(0);
      expect(out, JSON.stringify(spec)).toContain(`Plan for “${m.title}” (mission ${m.id})`);
      expect(out, JSON.stringify(spec)).not.toContain("How each feature was checked");
      rmSync(store().missionDir(m.id), { recursive: true, force: true });
    }
  });

  it("a plan with holes in its list of features exits 1 with a plain sentence, never the text of a program error (V1-4)", async () => {
    for (const features of [[null, 5, { id: "a", mode: "owner" }], [null]]) {
      const m = await salesMission();
      writeFileSync(join(store().missionDir(m.id), "mission.json"), JSON.stringify({ ...m, spec: { ...m.spec, features } }));
      const code = await mc(["plan", "show", m.id]);
      expect(code, JSON.stringify(features)).toBe(1);
      expect(out, JSON.stringify(features)).toBe("");
      expect(err, JSON.stringify(features)).toBe(`The plan of “${m.title}” (mission ${m.id}) cannot be shown, because its file is damaged. Fix the file, or remove the mission's folder.\n`);
      rmSync(store().missionDir(m.id), { recursive: true, force: true });
    }
  });

  it("adds the sentences from the log: asked and approved, sent back and then approved", async () => {
    const m = await salesMission((m2, notes) => {
      notes.status = "done";
      notes.mode = "owner";
      notes.checked = checked([result(1, "pass", "a quote"), result(2, "pass", "a quote")]);
      m2.checkpointLog = [log("feature:column-notes", "approve")];
    });
    await mc(["plan", "show", m.id]);
    expect(section().slice(1, 8)).toContain("  You were asked to look at it, and you approved it.");
    const again = store().load(m.id);
    again.checkpointLog = [log("feature:column-notes", "send_back"), log("feature:column-notes", "approve", 2)];
    store().save(again);
    await mc(["plan", "show", m.id]);
    expect(section().join("\n")).toContain("  You sent it back once, and then approved it.");
    expect(section().join("\n")).not.toContain("You were asked to look at it");
  });

  it("says when the second AI's check did not finish, and when the feature was queued without a stop for the look", async () => {
    const m = await salesMission((m2, notes) => {
      notes.status = "done";
      notes.checked = checked([], { unfinished: true, unjudged: 2, scripted: { problems: [], facts: [] } });
      m2.ownerStops = false;
    });
    await mc(["plan", "show", m.id]);
    expect(section()).toEqual([
      "How each feature was checked:",
      "- “Totals for each region”: not checked yet.",
      "- “Description of each column”: checked by Mission Control's own checks only.",
      "  Mission Control's own checks: passed.",
      "  Pictures: none (this feature has no page).",
      "  The second AI's check did not finish.",
      "  It was queued without a stop for your look.",
      "",
    ]);
    // a finished feature with no record at all reads the same, without the lines that need a record
    const bare = store().load(m.id);
    const notes = bare.features[1] as Feature;
    delete notes.checked;
    store().save(bare);
    await mc(["plan", "show", m.id]);
    expect(section().slice(2, 5)).toEqual(["- “Description of each column”: checked by Mission Control's own checks only.", "  The second AI's check did not finish.", "  It was queued without a stop for your look."]);
  });

  it("says that a tests feature with no test written is checked by the project's own checks only", async () => {
    const m = await salesMission((_m, _notes, totals) => {
      totals.status = "done";
    });
    await mc(["plan", "show", m.id]);
    expect(section()[1]).toBe("- “Totals for each region”: checked by the project's own checks only; no tests were written for it.");
  });

  it("says a feature that got stuck was not checked, and never calls it tested", async () => {
    const m = await salesMission((_m, notes, totals) => {
      totals.status = "blocked";
      notes.status = "skipped";
    });
    await mc(["plan", "show", m.id]);
    expect(section().slice(1, 3)).toEqual(["- “Totals for each region”: not finished, so it was not checked.", "- “Description of each column”: not finished, so it was not checked."]);
  });

  it("adds the result of the project's own checks from the last event of the feature", async () => {
    const m = await salesMission((_m, notes) => {
      notes.status = "done";
      notes.mode = "review";
      notes.checked = checked([result(1, "pass", "a quote"), result(2, "pass", "a quote")]);
    });
    store().appendEvent(m.id, "deliverable.checked", { feature: "column-notes", label: "a1", ok: true, problems: 0, projectChecks: "failed" });
    store().appendEvent(m.id, "deliverable.checked", { feature: "other", label: "a1", ok: true, problems: 0, projectChecks: "failed" });
    store().appendEvent(m.id, "deliverable.checked", { feature: "column-notes", label: "fix1", ok: true, problems: 0, projectChecks: "passed" });
    await mc(["plan", "show", m.id]);
    expect(section().join("\n")).toContain("  Mission Control's own checks: passed. The project's own checks passed.");
  });

  it("uses no word of tests for a feature that no test checked", async () => {
    const m = await salesMission((m2, notes) => {
      notes.status = "done";
      notes.checked = checked([result(1, "pass", "a quote"), result(2, "cannot_judge", "no picture")], { pictures: { taken: 2 } });
      m2.checkpointLog = [log("feature:column-notes", "approve")];
    });
    await mc(["plan", "show", m.id]);
    const own = section().filter((l) => l.startsWith("- “Description")).join("\n");
    expect(own).not.toMatch(/\btest(s|ed|ing)?\b/i);
    expect(section().join("\n")).toContain("  Pictures: 2 taken (phone and desktop width).");
  });
});

// ───────────────────────────── mc logs ─────────────────────────────

describe("describeEvent: the three new events", () => {
  const event = (type: string, data: Record<string, unknown>): MissionEvent => ({ at: "2026-10-12T13:30:00.000Z", missionId: "m", type, data });

  it("deliverable.checked, with the attempt or the fix round, and the project's own checks when they ran", () => {
    expect(describeEvent(event("deliverable.checked", { feature: "guide", label: "a1", ok: true, problems: 0 }))).toBe("guide: Mission Control's own checks passed (attempt 1)");
    expect(describeEvent(event("deliverable.checked", { feature: "guide", label: "a2", ok: false, problems: 3 }))).toBe("guide: Mission Control's own checks found 3 problems (attempt 2)");
    expect(describeEvent(event("deliverable.checked", { feature: "guide", label: "a2", ok: false, problems: 1 }))).toBe("guide: Mission Control's own checks found 1 problem (attempt 2)");
    expect(describeEvent(event("deliverable.checked", { feature: "guide", label: "fix1", ok: true, problems: 0 }))).toBe("guide: Mission Control's own checks passed (fix round 1)");
    expect(describeEvent(event("deliverable.checked", { feature: "guide", label: "a1", ok: true, problems: 0, projectChecks: "passed" }))).toBe(
      "guide: Mission Control's own checks passed (attempt 1). The project's own checks passed.",
    );
    expect(describeEvent(event("deliverable.checked", { feature: "guide", label: "fix2", ok: false, problems: 1, projectChecks: "failed" }))).toBe(
      "guide: Mission Control's own checks found 1 problem (fix round 2). The project's own checks failed.",
    );
  });

  it("pictures.taken, with the reason in words when there are none", () => {
    expect(describeEvent(event("pictures.taken", { feature: "page", taken: 2 }))).toBe("page: took 2 pictures of the page");
    expect(describeEvent(event("pictures.taken", { feature: "page", taken: 1 }))).toBe("page: took 1 picture of the page");
    expect(describeEvent(event("pictures.taken", { feature: "page", taken: 0, why: "no_browser" }))).toBe("page: no pictures were taken (no browser was found in the container)");
    expect(describeEvent(event("pictures.taken", { feature: "page", taken: 0, why: "too_slow" }))).toBe("page: no pictures were taken (the page took too long to load)");
  });

  it("rubric.checked, with how many answers were not trusted", () => {
    expect(describeEvent(event("rubric.checked", { feature: "guide", round: 1, pass: 3, fail: 1, unjudged: 0, downgraded: 0, reviewer: "claude" }))).toBe(
      "guide: a second AI checked it against the list (round 1): 3 passed, 1 failed, 0 could not be judged",
    );
    expect(describeEvent(event("rubric.checked", { feature: "guide", round: 2, pass: 2, fail: 0, unjudged: 2, downgraded: 2, reviewer: "claude" }))).toBe(
      "guide: a second AI checked it against the list (round 2): 2 passed, 0 failed, 2 could not be judged (2 answers were not trusted)",
    );
    expect(describeEvent(event("rubric.checked", { feature: "guide", round: 1, pass: 0, fail: 0, unjudged: 1, downgraded: 1 }))).toContain("(1 answer was not trusted)");
  });

  it("copes with damaged data and never claims a test", () => {
    for (const data of [{}, { feature: 5, ok: "yes", problems: "x", label: {}, projectChecks: 7 }, { taken: "x", why: "elsewhere" }, { pass: null, round: [] }]) {
      for (const type of ["deliverable.checked", "pictures.taken", "rubric.checked"]) {
        const line = describeEvent(event(type, data));
        expect(line).not.toMatch(/\btest(s|ed|ing)?\b/i);
        expect(line.length).toBeGreaterThan(5);
      }
    }
  });
});
