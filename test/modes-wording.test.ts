// T-MODES-WORDING: the wording rule of docs/modes-spec.md 10.3, applied to the real output of every surface.
//
// A mission whose features all have a mode (examples A and B) and a mixed one (example C) are queued through the command line
// and run by the mock team to the end, through every stop. The text of each surface is collected as the owner would meet it:
// the plan preview and queue output, `mc plan show`, `mc logs`, the report (as written at each stop and at the end), the phone
// notices, the dashboard (the timeline, the mission sentence, the card at a stop and the Results page), and the text of the
// draft pull request that `publish` writes (through the real host script, with stand-ins for Docker, GitHub and gh).
// Then the rule holds: a feature that no test checked is never said to be tested, and no line says "the engine", puts straight
// quote marks around a title, uses a long dash or a time-of-day word. Nothing calls an AI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Snapshot } from "../src/dashboard/types.js";
import { FIXTURE_VERIFY } from "./fixtures/mission-harness.js";
import { pullRequestBody as pullRequestBodyOf } from "./modes-pr-kit.js";
import { CODE_A, CODE_B, CODE_C, EXAMPLE_A, EXAMPLE_B, EXAMPLE_C, openWorld, TITLE, type World } from "./modes-real-kit.js";

let w: World;
const cleanups: (() => void)[] = [];
afterEach(() => {
  w?.cleanup();
  for (const undo of cleanups.splice(0)) undo();
});

// ───────────────────────────── The rules ─────────────────────────────

const u = (...codes: number[]): string => String.fromCodePoint(...codes);
const TEST_WORD = /\btest(s|ed|ing)?\b/i;
const INVISIBLE = new RegExp(`[${u(0x200b)}-${u(0x200f)}${u(0x202a)}-${u(0x202e)}${u(0x2060)}${u(0x2066)}-${u(0x2069)}${u(0xfeff)}${u(0xfe00)}-${u(0xfe0f)}${u(0x3164)}]`);
const LONG_DASH = new RegExp(`[${u(0x2014)}${u(0x2013)}]`);
const TIME_OF_DAY = /\b(night|nights|tonight|overnight|morning)\b/i;

/** The report's last block lists the project's own commands and the notes of the AI that set it up; it makes no claim about a feature. */
const withoutTechnicalDetails = (text: string): string => text.split("## Technical details")[0] ?? text;

/** A sentence claims a test unless it holds only the allowed phrases: `no tests`, a code span (a command), and, in a mixed mission, `by tests`. */
function claimsATest(line: string, allowByTests = false): boolean {
  const plain = line.replace(/`[^`]*`/g, "").replace(/\bno tests\b/gi, "");
  return TEST_WORD.test(allowByTests ? plain.replace(/\bby tests\b/gi, "") : plain);
}

/** A cell that holds only a long dash is a table's empty value, not an aside. */
const withoutEmptyCells = (line: string): string => line.replace(new RegExp(`\\|\\s*[${u(0x2014)}${u(0x2013)}]\\s*(?=\\|)`, "g"), "|");

interface Surface {
  name: string;
  /** One owner-visible line (or sentence) at a time. */
  lines: string[];
}

const surface = (name: string, text: string): Surface => ({ name, lines: text.split("\n").filter((l) => l.trim() !== "") });

/** Every sentence of a dashboard snapshot. The two sentences that the page copies to the leader (`tellLeader`, `answers`) are templates with straight marks on purpose. */
function dashboardLines(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) dashboardLines(v, out);
  else if (typeof value === "object" && value !== null) {
    for (const [key, v] of Object.entries(value)) if (key !== "tellLeader" && key !== "answers") dashboardLines(v, out);
  }
  return out;
}

/** The wording rules that hold for every surface of every mission. */
function commonProblems(s: Surface, titles: string[]): string[] {
  const problems: string[] = [];
  for (const line of s.lines) {
    const here = (what: string): number => problems.push(`${s.name}: ${what}: ${line.slice(0, 160)}`);
    if (/\bthe engine\b/i.test(line)) here("says “the engine”");
    if (LONG_DASH.test(withoutEmptyCells(line))) here("has a long dash");
    if (TIME_OF_DAY.test(line)) here("has a time-of-day word");
    if (/\bobjectives?\b/i.test(line)) here("says “objective”");
    if (INVISIBLE.test(line)) here("has an invisible character");
    if (/looked at it|you looked|reviewed by you|signed off|chose not to look/i.test(line)) here("says what the log cannot know");
    for (const title of titles) if (line.includes(`"${title}"`)) here(`has straight marks around “${title}”`);
  }
  return problems;
}

// ───────────────────────────── Collecting every surface ─────────────────────────────

interface Collected {
  surfaces: Surface[];
  /** Titles of the mission and of its features, to look for straight marks around them. */
  titles: string[];
  id: string;
  stops: number;
}

/** Previews, queues and runs a plan through every stop to the end; collects the text of every surface on the way. */
async function collect(plan: string, app: string, missionTitle: string): Promise<Collected> {
  const surfaces: Surface[] = [];
  const preview = await w.mc(["plan", "preview", "-"], plan);
  expect(preview.code, preview.err).toBe(0);
  surfaces.push(surface("plan preview", preview.out));
  const { id, said } = await w.queue(plan);
  surfaces.push(surface("plan queue", said.out));

  let stops = 0;
  for (;;) {
    const m = await w.run(id);
    if (m.status !== "stopped") {
      expect(m.status).toBe("done");
      break;
    }
    stops++;
    surfaces.push(surface(`report at stop ${stops}`, withoutTechnicalDetails(w.report(id))));
    surfaces.push(surface(`plan show at stop ${stops}`, (await w.mc(["plan", "show", id])).out));
    surfaces.push({ name: `dashboard at stop ${stops}`, lines: dashboardLines(w.snapshot()) });
    await w.approve(id);
    expect(stops).toBeLessThan(5);
  }
  surfaces.push(surface("report", withoutTechnicalDetails(w.report(id))));
  surfaces.push(surface("plan show", (await w.mc(["plan", "show", id])).out));
  surfaces.push(surface("mc logs", (await w.mc(["logs", id])).out));
  surfaces.push(surface("mc report", (await w.mc(["report", id])).out));
  surfaces.push({ name: "dashboard", lines: dashboardLines(w.snapshot()) });
  surfaces.push(surface("phone notices", w.h.notifications.map((n) => `${n.title}\n${n.message}`).join("\n")));
  surfaces.push(surface("pull request text", pullRequestBodyOf(w, id, app, (undo) => cleanups.push(undo))));
  const mission = w.h.load(id);
  return { surfaces, titles: [missionTitle, ...mission.features.map((f) => f.title)], id, stops };
}

const lineOf = (c: Collected, name: string): string[] => c.surfaces.find((s) => s.name === name)?.lines ?? [];

// ───────────────────────────── Tests ─────────────────────────────

describe("a mission whose features all have a mode (examples A and B)", () => {
  it.each([
    ["A, a guide checked by a second AI", EXAMPLE_A, "habit-tracker", "Setup guide", CODE_A, 1],
    ["B, a page marked for the owner's look", EXAMPLE_B, "habit-tracker", "Landing page", CODE_B, 2],
  ] as const)("%s: no line of any surface claims a test, says the engine, or breaks the wording rules", async (_name, plan, app, title, code, stops) => {
    w = await openWorld();
    const c = await collect(plan, app, title);
    expect(c.stops).toBe(stops);
    expect(c.surfaces.map((s) => s.name)).toEqual(expect.arrayContaining(["plan preview", "plan queue", "plan show", "mc logs", "report", "mc report", "dashboard", "phone notices", "pull request text"]));
    for (const s of c.surfaces) expect(s.lines.length, s.name).toBeGreaterThan(0);
    expect(lineOf(c, "plan preview").join("\n")).toContain(code);
    // The surfaces really hold the sentences the rule is about: the Results page and the timeline at the end, and, for a page marked for the owner's look, the card at the stop.
    const dashboard = lineOf(c, "dashboard").join("\n");
    expect(dashboard).toContain("The feature is built. The list below says how it was checked.");
    expect(dashboard).toContain("against your list");
    if (stops === 2) expect(lineOf(c, "dashboard at stop 2").join("\n")).toContain("The team stopped here because this feature is marked for your look, and you look at it first.");

    expect(c.surfaces.flatMap((s) => commonProblems(s, c.titles))).toEqual([]);
    // The rule of 10.3: after the allowed phrases are taken out, no line holds a test word. The pull request text is looked at below.
    const claims = c.surfaces.filter((s) => s.name !== "pull request text").flatMap((s) => s.lines.filter((l) => claimsATest(l)).map((l) => `${s.name}: ${l.slice(0, 160)}`));
    expect(claims).toEqual([]);
  });

  it("the pull request text says the features were not checked by tests, copies the Checked line, and claims no test for them", async () => {
    w = await openWorld();
    const c = await collect(EXAMPLE_A, "habit-tracker", "Setup guide");
    const body = lineOf(c, "pull request text").join("\n");
    expect(body).toContain("- Tests: the team wrote tests before the code for 0 of 1 finished features. The rest were not checked by tests. The Checked line below says how each was checked.");
    expect(body).toContain("- Checked: 1 feature by a second AI against your list.");
    expect(body).not.toContain("A feature counts as finished only when its tests");
    // Every other line of the text is free of test words: the one sentence above is the only place that names tests, and it denies them.
    const others = lineOf(c, "pull request text").filter((l) => !l.startsWith("- Tests:") && claimsATest(l));
    expect(others).toEqual([]);
  });
});

describe("a mixed mission (example C: one feature checked by tests, one by a second AI)", () => {
  it("every sentence that names the feature checked by a second AI holds no test word, and the other wording rules hold everywhere", async () => {
    w = await openWorld();
    const c = await collect(EXAMPLE_C, "sales-data", "Sales totals");
    expect(lineOf(c, "plan preview").join("\n")).toContain(CODE_C);
    expect(c.surfaces.flatMap((s) => commonProblems(s, c.titles))).toEqual([]);

    const names = (line: string): boolean => line.includes(TITLE.notes) || line.includes("column-notes") || /second AI/i.test(line);
    const about = c.surfaces.flatMap((s) => s.lines.filter(names).map((l) => ({ surface: s.name, line: l })));
    expect(about.length).toBeGreaterThan(10);
    // In a mixed mission "by tests" may appear in a sentence that also counts the features checked by tests.
    expect(about.filter((a) => claimsATest(a.line, true)).map((a) => `${a.surface}: ${a.line.slice(0, 160)}`)).toEqual([]);

    // And the feature that has tests is still said to have them: nothing was taken away from it.
    expect(lineOf(c, "report").join("\n")).toContain(`| ✅ | ${TITLE.totals} | Built and checked |`);
    expect(lineOf(c, "report").join("\n")).toContain("Checked: 1 feature by tests; 1 feature by a second AI against your list.");
    // In the pull request text the Tests line must not say that the features of the Checked line were not checked by tests: that line counts one that was.
    expect(lineOf(c, "pull request text").join("\n")).toContain("- Tests: the team wrote tests before the code for 1 of 2 finished features. The rest were not checked by tests. The Checked line below says how each was checked.");
    expect(lineOf(c, "plan show").join("\n")).toContain(`- “${TITLE.totals}”: checked by tests.`);
  });
});

describe("a mission whose project's own checks were already failing (a red baseline)", () => {
  /** The words that say the new tests were what judged the work: false for a feature that no test checked. */
  const NEW_TESTS = /only used the new tests|judged by their new tests\.|checked by its own new tests only/;
  /** The card of the dashboard for a mission with a feature checked by tests and a feature checked by a second AI (the report says the second sentence too). */
  const MIXED_CARD =
    "The project's own checks were already failing before this mission started, so they could not be used to judge the new work. The features checked by tests were judged by tests alone, and the others by Mission Control's own checks and a second AI.";

  it("example A: the report, the run notes and every other surface say the work was not judged by tests", async () => {
    w = await openWorld({ broken: true });
    const c = await collect(EXAMPLE_A, "habit-tracker", "Setup guide");
    const report = lineOf(c, "report").join("\n");
    expect(report).toContain("Your project's own checks were already failing before I started, so they could not be used to check my work. Mission Control's own checks and a second AI checked it instead.");
    expect(w.h.load(c.id).notes).toContain("The project's own checks were already failing before this mission started, so they could not be used to judge the new work. Mission Control's own checks and a second AI judged it instead.");
    for (const s of c.surfaces) expect(s.lines.filter((l) => NEW_TESTS.test(l)), s.name).toEqual([]);
    expect(c.surfaces.flatMap((s) => commonProblems(s, c.titles))).toEqual([]);
    // the rule of 10.3 holds here too: not one line of any surface claims a test (the pull request text is looked at in the other test)
    const claims = c.surfaces.filter((s) => s.name !== "pull request text").flatMap((s) => s.lines.filter((l) => claimsATest(l)).map((l) => `${s.name}: ${l.slice(0, 160)}`));
    expect(claims).toEqual([]);
    expect(c.surfaces.find((s) => s.name === "dashboard")?.lines).toContain("The project's own checks were already failing before this mission started, so they could not be used to judge the new work.");
  });

  it("example C, with one feature checked by tests: the tests are named only for that feature", async () => {
    w = await openWorld({ broken: true });
    const c = await collect(EXAMPLE_C, "sales-data", "Sales totals");
    const report = lineOf(c, "report").join("\n");
    expect(report).toContain("so they could not be used to check my work. The features checked by tests were judged by tests alone, and the others by Mission Control's own checks and a second AI.");
    expect(report).not.toContain("so I only used the new tests");
    expect(w.h.load(c.id).notes.join("\n")).toContain("The features checked by tests were judged by tests alone, and the others by Mission Control's own checks and a second AI.");
    expect(c.surfaces.flatMap((s) => commonProblems(s, c.titles))).toEqual([]);
    const names = (line: string): boolean => line.includes(TITLE.notes) || line.includes("column-notes") || /second AI/i.test(line);
    expect(c.surfaces.flatMap((s) => s.lines.filter((l) => names(l) && claimsATest(l, true)).map((l) => `${s.name}: ${l.slice(0, 160)}`))).toEqual([]);
    // One feature of this mission was checked by a second AI and no test, so no surface may say that the new tests judged the new work (finding R1).
    for (const s of c.surfaces) expect(s.lines.filter((l) => NEW_TESTS.test(l)), s.name).toEqual([]);
    // The card of the dashboard says the mixed sentence, like the report (the sentence is the same on both).
    expect(c.surfaces.find((s) => s.name === "dashboard")?.lines).toContain(MIXED_CARD);
  });

  it("example A when the architect finds no command for single files: the mission goes on, and no surface claims a test (the fixer's finding)", async () => {
    w = await openWorld({
      broken: true,
      agents: { architect: (job, call) => (call.label === "onboard" ? { structured: { stackSummary: "Node", verify: { ...FIXTURE_VERIFY, tests: null }, notes: [] } } : w.h.defaults.architect(job, call)) },
    });
    const c = await collect(EXAMPLE_A, "habit-tracker", "Setup guide");
    const note = "The team did not look for a way to run single files of the project's own checks, because every feature of this plan is checked by a second AI.";
    expect(w.h.load(c.id).notes).toContain(note);
    expect(note).not.toMatch(TEST_WORD);
    expect(w.h.jobsLabeled("onboard")).toHaveLength(1);
    expect(c.surfaces.flatMap((s) => commonProblems(s, c.titles))).toEqual([]);
    const claims = c.surfaces.filter((s) => s.name !== "pull request text").flatMap((s) => s.lines.filter((l) => claimsATest(l)).map((l) => `${s.name}: ${l.slice(0, 160)}`));
    expect(claims).toEqual([]);
    expect(lineOf(c, "report").join("\n")).toContain("Your project's own checks were already failing before I started, so they could not be used to check my work. Mission Control's own checks and a second AI checked it instead.");
  });

  it("a plan with no mode keeps the words it always had", async () => {
    w = await openWorld({ broken: true });
    const dark = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "plans", "dark-mode.txt"), "utf8");
    const { id } = await w.queue(dark);
    await w.run(id);
    const report = w.report(id);
    expect(report).toContain("Your project's own checks were already failing before I started, so I only used the new tests to check my work.");
    expect(w.h.load(id).notes).toContain("The project's own checks were already failing before this mission started, so features were judged by their new tests.");
  });
});

describe("the rule itself", () => {
  it("finds a claim, and lets the allowed phrases through", () => {
    expect(claimsATest("All 3 features were tested.")).toBe(true);
    expect(claimsATest("The final tests of the whole app passed.")).toBe(true);
    expect(claimsATest("It passed its tests.")).toBe(true);
    expect(claimsATest("1 feature has no tests. The list below says how it was checked.")).toBe(false);
    expect(claimsATest("No tests are written for it.")).toBe(false);
    expect(claimsATest("3. `node --test \"tests/**/*.test.mjs\"`: run the project's own checks")).toBe(false);
    expect(claimsATest("Checked: 1 feature by tests; 1 feature by a second AI against your list.")).toBe(true);
    expect(claimsATest("Checked: 1 feature by tests; 1 feature by a second AI against your list.", true)).toBe(false);
    expect(claimsATest("Attestation of the contest")).toBe(false);
  });

  it("finds each of the other faults", () => {
    const check = (line: string, titles: string[] = ["Setup guide"]): string[] => commonProblems(surface("x", line), titles);
    expect(check("The engine checked it.")).toHaveLength(1);
    expect(check(`It is built ${u(0x2014)} and checked.`)).toHaveLength(1);
        expect(check("| claude | 3 | 0 | 0 | " + u(0x2014) + " |")).toEqual([]); // an empty table cell is not an aside
    expect(check("Tonight I built it.")).toHaveLength(1);
    expect(check("It was reviewed in the morning.")).toHaveLength(1);
    expect(check('Working on "Setup guide" now.')).toHaveLength(1);
    expect(check(`Working on ${u(0x201c)}Setup guide${u(0x201d)} now.`)).toEqual([]);
    expect(check(`Zero${u(0x200b)}width.`)).toHaveLength(1);
    expect(check("You looked at it and signed off.")).toHaveLength(1);
    expect(check("The team checked the feature. Nothing else is waiting.")).toEqual([]);
  });

  it("leaves out of the dashboard's sentences only the two that the page copies to the leader", () => {
    const snapshot = { missions: [{ sentence: "A", tellLeader: 'About "X"' }], needsYou: [{ title: "T", tellLeader: 'About "X"', answers: { approve: 'About "X"' } }] } as unknown as Snapshot;
    expect(dashboardLines(snapshot)).toEqual(["A", "T"]);
  });
});
