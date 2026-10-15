// What test/modes-dashboard.test.ts and test/modes-wording.test.ts share: the three example plans of docs/modes-spec.md (4.4),
// run through the real command line (`mc plan queue -`) and the mock team, the way the leader's plan would be. The documents
// the mock builders write are real ones (they have the headings, the words and the columns the plan asks for), so every
// scripted check of Mission Control runs on them for real. Nothing here calls an AI.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { type CliIO, main } from "../src/cli.js";
import { clearReadCache } from "../src/dashboard/read.js";
import { buildSnapshot } from "../src/dashboard/snapshot.js";
import type { Snapshot } from "../src/dashboard/types.js";
import type { Mission } from "../src/types.js";
import { assertSnapshotShape, copyHomeOf, hashTree } from "./dashboard-helpers.js";
import { buildOutput, checkerBehavior, createFixtureRepo, type FakeRenderer, fakeRenderer, type HarnessOptions, isChecker, isMaker, MissionHarness, writeFile } from "./fixtures/mission-harness.js";

const PLANS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "plans");
const planText = (name: string): string => readFileSync(join(PLANS, name), "utf8");

/** Example A (a guide, checked by a second AI), B (a landing page, checked by a second AI and then by the owner), C (a script with tests and a described table). */
export const EXAMPLE_A = planText("setup-guide.txt");
export const EXAMPLE_B = planText("landing-page.txt");
export const EXAMPLE_C = planText("sales-totals.txt");
export const CODE_A = "5796d033";
export const CODE_B = "aceddd4d";
export const CODE_C = "c087c05b";

/** The titles the examples give their features, in the owner's words. */
export const TITLE = { guide: "Setup guide for new users", page: "One-page landing page", totals: "Totals for each region", notes: "Description of each column" } as const;

// ───────────────────────────── The documents the mock builders write ─────────────────────────────

const GUIDE = `# Habit tracker setup guide

This guide helps a new user start the Habit tracker in about five minutes. Follow the steps in order. Each step is one action, and the last line of each part says what you should see.

## Install

1. Open a terminal in the folder of the app.
2. Run the install command and wait until it says that it has finished.
3. Start the app with the start command.
4. Open the address that the terminal prints in your web browser.

When it works, you see the Habit tracker home page. It shows an empty list of habits and a button with the words Add habit on it.

## Add your first habit

1. Press the button with the words Add habit on it.
2. Type a name for the habit, for example Drink water.
3. Press the Save button.
4. The new habit appears in the list, with a box next to its name.
5. Tick the box on each day that you have done the habit.

The list keeps your habits when you close the page, so you can come back tomorrow and tick the box again. A habit that you tick every day builds a streak, and the page shows the length of the streak next to the name of the habit.

## If something goes wrong

If the page does not open, check that the terminal is still running and try the address again. If a step fails, read the message that the terminal prints, fix what it names, and run the same step once more. Nothing you have saved is lost when a step fails.
`;

const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Habit tracker</title>
<style>
body { font-family: sans-serif; margin: 0; padding: 1rem; }
.benefits { display: flex; flex-wrap: wrap; gap: 1rem; }
.benefit { flex: 1 1 12rem; }
</style>
</head>
<body>
<h1>Keep your habits going</h1>
<p>The Habit tracker shows in one look what you did today and what is left.</p>
<button type="button">Get started</button>
<div class="benefits">
<div class="benefit"><h2>See your day</h2><p>One list shows every habit and whether you did it.</p></div>
<div class="benefit"><h2>Build a streak</h2><p>The page counts the days in a row that you ticked a habit.</p></div>
<div class="benefit"><h2>Stay private</h2><p>Your habits stay on your own computer.</p></div>
</div>
</body>
</html>
`;

const NOTES = `Column,Meaning,Example
Region,The sales region the row belongs to,North
Units,How many units were sold in that region,12
Revenue,The money taken for those units,340.50
Day,The day of the week the sales were recorded,Monday
`;

/** What the mock builder writes for a feature that is checked by reading, and a sentence the mock second AI can quote from it. */
export const MADE: Record<string, { path: string; text: string; quote: string }> = {
  "setup-guide": { path: "docs/setup-guide.md", text: GUIDE, quote: "Add your first habit" },
  "landing-page": { path: "landing.html", text: LANDING, quote: "Keep your habits going" },
  "column-notes": { path: "docs/column-notes.csv", text: NOTES, quote: "The sales region the row belongs to" },
};

// ───────────────────────────── The world: the mock team, the command line and an apps folder ─────────────────────────────

export interface Said {
  code: number;
  out: string;
  err: string;
}

export interface World {
  h: MissionHarness;
  renderer: FakeRenderer;
  /** The owner's home folder: ~/mc-apps/habit-tracker and ~/mc-apps/sales-data are git folders on main. */
  userHome: string;
  /** Runs `mc` as the command line does; `stdin` is what a here-document would send. */
  mc(args: string[], stdin?: string): Promise<Said>;
  /** The dashboard's snapshot of a copy of the engine's home (the engine's own home is not touched). */
  snapshot(): Snapshot;
  /** Queues a plan through `mc plan queue -`; returns the mission id and the plan code. */
  queue(plan: string, flags?: string[]): Promise<{ id: string; code: string; said: Said }>;
  /** Answers a stop through the command line. */
  approve(id: string): Promise<Said>;
  /** Runs the mission with the mock team until the next stop or the end. */
  run(id: string): Promise<Mission>;
  report(id: string): string;
  cleanup(): void;
}

/**
 * A mock team whose builders of documents write the documents above, and whose second AI quotes them. `pictureText` is the
 * visible text the fake picture tool reports for a page.
 */
export async function openWorld(opts: HarnessOptions & { pictureText?: string; broken?: boolean } = {}): Promise<World> {
  const renderer = fakeRenderer({ text: () => opts.pictureText ?? "Habit tracker. Keep your habits going. Get started." });
  const { pictureText: _text, broken: _broken, ...harnessOptions } = opts;
  const h: MissionHarness = new MissionHarness({
    renderer,
    ...harnessOptions,
    agents: {
      engineer: (job, call) => {
        const made = isMaker(job) && call.feature !== undefined ? MADE[call.feature] : undefined;
        return made ? { edit: (cwd) => writeFile(cwd, made.path, made.text), structured: buildOutput("wrote it") } : h.defaults.engineer(job, call);
      },
      reviewer: (job, call) => {
        const made = isChecker(job) && call.feature !== undefined ? MADE[call.feature] : undefined;
        if (!made) return h.defaults.reviewer(job, call);
        return checkerBehavior(job, (results) => {
          for (const r of results) r.evidence = `The file says “${made.quote}” in ${made.path}.`;
        });
      },
      // The harness' own report text says "Tonight"; these tests look at the engine's words, so the report writer says something plain.
      scout: (job, call) => (call.label === "report-prose" ? { structured: { narrative: "I built the examples as the plan asked.", whatYouCanDo: ["Open the files the plan named"] } } : h.defaults.scout(job, call)),
      ...opts.agents,
    },
  }); // sets MC_HOME to the harness' home, which is where `mc` queues
  const userHome = join(h.root, "user-home");
  vi.stubEnv("HOME", userHome);
  vi.stubEnv("MC_CONFIG", "");
  vi.stubEnv("MC_IN_CONTAINER", "");
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(h.root, "claude-config"));
  // `broken`: the apps' own checks already fail before the mission starts (a red baseline).
  for (const app of ["habit-tracker", "sales-data"]) await createFixtureRepo(h.git, join(userHome, "mc-apps", app), { broken: opts.broken === true });

  const mc = async (args: string[], stdin?: string): Promise<Said> => {
    const said: Said = { code: 0, out: "", err: "" };
    const io: CliIO = { stdout: (t) => (said.out += t), stderr: (t) => (said.err += t), ...(stdin !== undefined && { stdin: async () => stdin }) };
    said.code = await main(["node", "mc", ...args], io);
    return said;
  };
  return {
    h,
    renderer,
    userHome,
    mc,
    snapshot() {
      const home = copyHomeOf(h.home);
      const before = hashTree(home);
      clearReadCache(); // the cache is keyed by inode and size; a new copy can reuse both
      const s = buildSnapshot({ home, now: Date.now(), timeZone: "UTC" });
      assertSnapshotShape(s);
      expect(hashTree(home), "the dashboard left the home as it found it").toBe(before);
      return s;
    },
    async queue(plan, flags = []) {
      const said = await mc(["plan", "queue", "-", ...flags], plan);
      expect(said.code, said.err).toBe(0);
      const id = /^Mission id: (\S+)$/m.exec(said.out)?.[1] ?? "";
      const code = /^Plan code: ([0-9a-f]{8}) /m.exec(said.out)?.[1] ?? "";
      expect(id).not.toBe("");
      return { id, code, said };
    },
    async approve(id) {
      const said = await mc(["approve", id]);
      expect(said.code, said.err).toBe(0);
      return said;
    },
    run: (id) => h.run(id),
    report: (id) => readFileSync(h.store.reportPath(id), "utf8"),
    cleanup() {
      vi.unstubAllEnvs();
      h.cleanup();
    },
  };
}

/** Every string value of a value, without the keys. */
export function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) stringsOf(v, out);
  return out;
}
