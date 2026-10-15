// The plan keys of docs/modes-spec.md section 4: mode, effort, heading, mention, words, columns, rows. Compatibility
// first (a plan that uses none of them is read, coded and described exactly as before), then every message, every
// limit, hostile input, and a seeded fuzz of the reader.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalText, describePlan, parsePlan, planCode } from "./plan.js";
import type { SpecOutput } from "./types.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "plans");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const golden = (name: string): string => readFileSync(join(FIXTURES, "golden", name), "utf8");

const DARK_MODE = fixture("dark-mode.txt");
const READING_LIST = fixture("reading-list.txt");
/** Examples A, B and C of docs/modes-spec.md section 4.4. */
const GUIDE = fixture("setup-guide.txt");
const LANDING = fixture("landing-page.txt");
const SALES = fixture("sales-totals.txt");

function accepted(text: string): Extract<ReturnType<typeof parsePlan>, { ok: true }> {
  const parsed = parsePlan(text);
  if (!parsed.ok) throw new Error(`expected the plan to be accepted:\n${parsed.problems.join("\n")}\n${text}`);
  return parsed;
}

function problemsOf(text: string): string[] {
  const parsed = parsePlan(text);
  if (parsed.ok) throw new Error(`expected a problem, the plan was accepted:\n${text}`);
  return parsed.problems;
}

/** The smallest plan with a feature that is checked by a second AI: 11 lines, the mode on line 11. */
const BASE = ["mc-plan 1", "name: Hello", "request: Say hello.", "app-name: Hello app", "summary: Says hello.", "", "feature: hello", "title: Say hello", "story: As a user I am greeted.", "check: The page shows Hello."];
const REVIEW = [...BASE, "mode: review"];

/** `base` with more lines at its end (inside the last feature). */
function plan(base: string[], ...more: string[]): string {
  return `${[...base, ...more].join("\n")}\n`;
}

const USE_WORDS = (max: number): string => `Use plain words, up to ${max} characters, starting with a letter or a number, with no backticks and no web addresses.`;

// ───────────────────────────── Compatibility first ─────────────────────────────

describe("a plan that uses none of the new keys", () => {
  it.each([
    ["dark-mode", "a4adaca5"],
    ["reading-list", "c5b7a589"],
    ["slugify", undefined],
    ["shout", undefined],
    ["whisper", undefined],
  ])("%s keeps its plan code, its fixed form, its plan and its words, byte for byte (golden files from the end of wave 1)", (name, code) => {
    const parsed = accepted(fixture(`${name}.txt`));
    if (code !== undefined) expect(parsed.code).toBe(code);
    const before = JSON.parse(golden(`${name}.spec.json`)) as { code: string };
    expect(parsed.code).toBe(before.code);
    expect(canonicalText(parsed.envelope, parsed.spec)).toBe(golden(`${name}.canonical.txt`));
    expect(JSON.parse(JSON.stringify({ envelope: parsed.envelope, spec: parsed.spec, code: parsed.code, sha256: parsed.sha256 }))).toEqual(JSON.parse(golden(`${name}.spec.json`)));
    for (const style of ["text", "look"] as const) {
      const lines = describePlan(parsed.spec, { request: parsed.envelope.request, style, newApp: parsed.envelope.folder === undefined });
      expect(`${lines.join("\n")}\n`, style).toBe(golden(`${name}.${style}.txt`));
    }
  });

  it("makes features with exactly the old keys: no mode, effort or expect", () => {
    for (const text of [DARK_MODE, READING_LIST, ...["slugify.txt", "shout.txt", "whisper.txt"].map(fixture)]) {
      for (const f of accepted(text).spec.features) expect(Object.keys(f).sort()).toEqual(["acceptance", "deps", "id", "kind", "story", "title"]);
    }
  });

  it("says nothing about modes in a plan whose features are all checked by tests, even when it sets an effort", () => {
    const parsed = accepted(plan(BASE.slice(0), "effort: deep"));
    const text = describePlan(parsed.spec, { request: "Say hello.", style: "text" });
    expect(text.join("\n")).toContain("   Effort: deep. The team's strongest AI builds it and checks it, and thinks longer.");
    expect(text.join("\n")).not.toMatch(/Checked by|second AI|Mission Control also checks/);
    const look = describePlan(parsed.spec, { request: "Say hello.", style: "look" });
    expect(look.join("\n")).not.toMatch(/Checked by|How the features are checked/);
    expect(look).toContain("Effort for “Say hello”: deep. The team's strongest AI builds it and checks it, and thinks longer.");
  });

  it("the explicit defaults are the same as leaving the lines out: mode tests and effort standard", () => {
    const old = accepted(plan(BASE));
    const explicit = accepted(plan(BASE, "mode: tests", "effort: standard"));
    expect(explicit.code).toBe(old.code);
    expect(explicit.sha256).toBe(old.sha256);
    expect(explicit.spec).toEqual(old.spec);
    expect(Object.keys(explicit.spec.features[0] ?? {})).not.toContain("mode");
  });
});

// ───────────────────────────── The three examples ─────────────────────────────

describe("the three examples of the design", () => {
  it.each([
    ["A, a document", GUIDE, "5796d033"],
    ["B, a web page", LANDING, "aceddd4d"],
    ["C, data with two modes", SALES, "c087c05b"],
  ])("example %s is accepted with the plan code the design quotes", (_name, text, code) => {
    const parsed = accepted(text);
    expect(parsed.code).toBe(code);
    // it comes back from its own fixed form with the same code
    expect(accepted(canonicalText(parsed.envelope, parsed.spec)).code).toBe(code);
  });

  it("writes examples A and B back as they are, apart from the blank lines", () => {
    for (const text of [GUIDE, LANDING]) {
      const parsed = accepted(text);
      expect(canonicalText(parsed.envelope, parsed.spec)).toBe(text.replace(/\n\n/g, "\n"));
    }
  });

  it("turns example A into a review feature that carries its script-checked words", () => {
    expect(accepted(GUIDE).spec.features).toEqual([
      {
        id: "setup-guide",
        title: "Setup guide for new users",
        story: "As a new user I can follow a short guide to install the app and add my first habit.",
        acceptance: [
          "The guide is a list of numbered steps, and each step is one action.",
          "The guide says how to start the app and what the reader should see when it works.",
          "The guide explains how to add a first habit.",
          "The guide does not name any file or setting that the project does not have.",
        ],
        kind: "standard",
        deps: [],
        mode: "review",
        expect: { headings: ["Install", "Add your first habit"], mentions: ["Habit tracker"], words: [200, 500] },
      },
    ]);
  });

  it("turns example B into an owner feature at deep effort, and example C into one feature with tests and one light review feature", () => {
    const [landing] = accepted(LANDING).spec.features;
    expect([landing?.mode, landing?.effort, landing?.expect]).toEqual(["owner", "deep", { mentions: ["Get started"] }]);
    const [totals, notes] = accepted(SALES).spec.features;
    expect(Object.keys(totals ?? {}).sort()).toEqual(["acceptance", "deps", "id", "kind", "story", "title"]);
    expect([notes?.mode, notes?.effort, notes?.expect, notes?.deps]).toEqual(["review", "light", { columns: ["Column", "Meaning", "Example"], rows: [4, 12] }, ["region-totals"]]);
  });

  it("describes example A in words, as the design prints it (the command-line style)", () => {
    const parsed = accepted(GUIDE);
    expect(describePlan(parsed.spec, { request: parsed.envelope.request, style: "text" })).toEqual([
      "You asked: Write a short setup guide for the habit tracker. A new user should be able to follow it in five minutes.",
      "App name: Habit tracker",
      "Summary: Adds a short setup guide for new users to the habit tracker's documents.",
      "",
      "1 feature:",
      "",
      "1. “Setup guide for new users” (id: setup-guide)",
      "   As a new user I can follow a short guide to install the app and add my first habit.",
      "   It counts as done when:",
      "   - The guide is a list of numbered steps, and each step is one action.",
      "   - The guide says how to start the app and what the reader should see when it works.",
      "   - The guide explains how to add a first habit.",
      "   - The guide does not name any file or setting that the project does not have.",
      "   Checked by: a second AI, against its list of checks. No tests are written for it.",
      "   Mission Control also checks, with no AI:",
      "   - It has the headings “Install”, “Add your first habit”.",
      "   - Its visible text contains the words “Habit tracker”, written exactly like that.",
      "   - Its new text is 200 to 500 words long.",
      "",
      "Choices made for you:",
      "- The guide is written in English for someone who has never used the app.",
    ]);
  });

  it("describes example A in the owner's look: one fact to a line, with the summary line among the first eight", () => {
    const parsed = accepted(GUIDE);
    const look = describePlan(parsed.spec, { request: parsed.envelope.request, style: "look" });
    expect(look.slice(0, 5)).toEqual([
      "You asked: Write a short setup guide for the habit tracker. A new user should be able to follow it in five minutes.",
      "App name: Habit tracker",
      "Summary: Adds a short setup guide for new users to the habit tracker's documents.",
      "How the features are checked: 1 by a second AI.",
      "The plan has 1 feature: “Setup guide for new users”.",
    ]);
    expect(look.slice(5)).toEqual([
      "“Setup guide for new users” (id: setup-guide): As a new user I can follow a short guide to install the app and add my first habit.",
      "Check for “Setup guide for new users”: The guide is a list of numbered steps, and each step is one action.",
      "Check for “Setup guide for new users”: The guide says how to start the app and what the reader should see when it works.",
      "Check for “Setup guide for new users”: The guide explains how to add a first habit.",
      "Check for “Setup guide for new users”: The guide does not name any file or setting that the project does not have.",
      "Checked by for “Setup guide for new users”: a second AI, against its list of checks. No tests are written for it.",
      "Mission Control's own check for “Setup guide for new users”: It has the headings “Install”, “Add your first habit”.",
      "Mission Control's own check for “Setup guide for new users”: Its visible text contains the words “Habit tracker”, written exactly like that.",
      "Mission Control's own check for “Setup guide for new users”: Its new text is 200 to 500 words long.",
      "Choice made for you: The guide is written in English for someone who has never used the app.",
    ]);
  });

  it("counts how the features of a mixed plan are checked, and names the way for the feature that has tests", () => {
    const parsed = accepted(SALES);
    const look = describePlan(parsed.spec, { request: parsed.envelope.request, style: "look" });
    expect(look[3]).toBe("How the features are checked: 1 by tests, 1 by a second AI.");
    expect(look).toContain("Checked by for “Totals for each region”: tests, written first.");
    expect(look).toContain("Effort for “Description of each column”: light. The team's lightest AI builds it first and a lighter AI checks it.");
    expect(look).toContain("Mission Control's own check for “Description of each column”: The table has the columns Column, Meaning, Example.");
    expect(look).toContain("Mission Control's own check for “Description of each column”: The table has 4 to 12 rows.");
    const landing = accepted(LANDING);
    const owner = describePlan(landing.spec, { request: landing.envelope.request, style: "look" });
    expect(owner[3]).toBe("How the features are checked: 1 by a second AI and then by you.");
    expect(owner).toContain("Checked by for “One-page landing page”: a second AI, against its list of checks, and then by you. No tests are written for it.");
    const three = accepted(plan(SALES.split("\n").slice(0, -1), "", "feature: third", "title: Third", "story: The third.", "mode: owner", "check: It reads well."));
    expect(describePlan(three.spec, { request: "x", style: "look" })[3]).toBe("How the features are checked: 1 by tests, 1 by a second AI, 1 by a second AI and then by you.");
  });

  it("does not say the owner looks at a feature marked “owner” when the plan is queued without the stop for the owner's look", () => {
    const landing = accepted(LANDING);
    for (const style of ["text", "look"] as const) {
      const words = describePlan(landing.spec, { request: landing.envelope.request, style, ownerStops: false });
      const joined = words.join("\n");
      expect(joined, style).toContain("a second AI, against its list of checks. It was queued without a stop for your look. No tests are written for it.");
      expect(joined, style).not.toContain("and then by you");
    }
    const look = describePlan(landing.spec, { request: landing.envelope.request, style: "look", ownerStops: false });
    expect(look[3]).toBe("How the features are checked: 1 by a second AI, queued without a stop for your look.");
    const three = accepted(plan(SALES.split("\n").slice(0, -1), "", "feature: third", "title: Third", "story: The third.", "mode: owner", "check: It reads well."));
    expect(describePlan(three.spec, { request: "x", style: "look", ownerStops: false })[3]).toBe("How the features are checked: 1 by tests, 1 by a second AI, 1 by a second AI, queued without a stop for your look.");
    // a plan with no feature marked “owner” has nothing to change, and the option leaves the plan as it was
    const guide = accepted(GUIDE);
    expect(describePlan(guide.spec, { request: guide.envelope.request, style: "text", ownerStops: false })).toEqual(describePlan(guide.spec, { request: guide.envelope.request, style: "text" }));
    // the option is only ever the word false: leaving it out says what it always said
    expect(describePlan(landing.spec, { request: landing.envelope.request, style: "look" })[3]).toBe("How the features are checked: 1 by a second AI and then by you.");
  });

  it("says nothing of tests for a plan whose features no test checks, and keeps to the wording rules", () => {
    for (const text of [GUIDE, LANDING]) {
      const parsed = accepted(text);
      for (const style of ["text", "look"] as const) {
        const words = describePlan(parsed.spec, { request: parsed.envelope.request, style }).join("\n");
        expect(words.replaceAll("No tests are written for it.", ""), style).not.toMatch(/\btest(s|ed|ing)?\b/i);
        expect(words).not.toMatch(/different AI|the engine|looked at it|\bnight\b|tonight|overnight|morning|objective/i);
        expect(words).not.toMatch(/—|–/);
      }
    }
  });

  it("calls the names a plan fixes names for the work and its checks when no test checks any feature, and keeps the old heading otherwise", () => {
    const owner = accepted(LANDING);
    expect(describePlan(owner.spec, { request: "x", style: "text" })).toContain("Names the work and its checks must agree on:");
    expect(describePlan(owner.spec, { request: "x", style: "look" })).toContain("Name the work and its checks must agree on: The button is labelled Get started.");
    const mixed = accepted(SALES);
    expect(describePlan(mixed.spec, { request: "x", style: "text" })).toContain("Names the tests and the code must agree on:");
    expect(describePlan(mixed.spec, { request: "x", style: "look" })).toContain("Name the tests and the code must agree on: The totals file is reports/totals.csv and its columns are Region, Units and Revenue.");
  });

  it("wraps a long engine line at 280 characters, each line keeping its lead", () => {
    const many = Array.from({ length: 12 }, (_, i) => `heading: ${"Section".padEnd(70, "x")}${i}`);
    const parsed = accepted(plan(REVIEW, ...many));
    const look = describePlan(parsed.spec, { request: "Say hello.", style: "look" }).filter((l) => l.startsWith("Mission Control's own check for"));
    expect(look.length).toBeGreaterThan(1);
    for (const line of look) {
      expect(line.length).toBeLessThanOrEqual(280);
      expect(line.startsWith("Mission Control's own check for “Say hello”: ")).toBe(true);
    }
  });

  it("shows a curly quote mark inside a value as a straight one, so the marks around the values stay in pairs", () => {
    const parsed = accepted(plan(REVIEW, "heading: Install”, “Add your first habit", "mention: say “hi”"));
    expect(parsed.spec.features[0]?.expect?.headings).toEqual(["Install”, “Add your first habit"]);
    const text = describePlan(parsed.spec, { request: "Say hello.", style: "text" }).join("\n");
    expect(text).toContain('- It has the headings “Install", "Add your first habit”.');
    expect(text).toContain('- Its visible text contains the words “say "hi"”, written exactly like that.');
    const look = describePlan(parsed.spec, { request: "Say hello.", style: "look" }).join("\n");
    expect(look).toContain(`Mission Control's own check for “Say hello”: It has the headings “Install", "Add your first habit”.`);
    // the fixed form keeps the value as it was written
    expect(canonicalText(parsed.envelope, parsed.spec)).toContain("heading: Install”, “Add your first habit\n");
  });

  it("copes with a damaged mission: an unknown mode or effort prints no line, and nothing throws", () => {
    const spec = {
      appName: "A",
      summary: "S",
      assumptions: [],
      uiContract: "",
      features: [
        { id: "a", title: "A", story: "As.", acceptance: ["It works."], kind: "standard", deps: [], mode: "banana", effort: 7, expect: "oops" },
        { id: "b", title: "B", story: "Bs.", acceptance: ["It works."], kind: "standard", deps: [], mode: null, expect: { headings: [1, null, "ok"], mentions: "x", words: ["1", 2], rows: [1], columns: [{}] } },
      ],
    } as unknown as SpecOutput;
    for (const style of ["text", "look"] as const) {
      const out = describePlan(spec, { request: "x", style }).join("\n");
      expect(out).not.toMatch(/Checked by|Effort|banana|How the features are checked/);
      expect(out).toContain("It has the headings “ok”.");
      expect(out).not.toContain("words long");
    }
  });
});

// ───────────────────────────── The plan code ─────────────────────────────

describe("the plan code of a plan with the new keys", () => {
  const code = accepted(GUIDE).code;

  it("does not change with spaces, blank lines, line ends, or the order of lines inside the block", () => {
    expect(accepted(GUIDE.replace(/\n/g, "\r\n")).code).toBe(code);
    expect(accepted(GUIDE.replace(/^(heading|mention|words|mode|check)/gm, "   $1")).code).toBe(code);
    expect(accepted(GUIDE.replace("\nmode: review\n", "\n\nmode: review\n\n")).code).toBe(code);
    // mode, words and the mention moved to the front of the block
    const lines = GUIDE.trimEnd().split("\n");
    const start = lines.indexOf("feature: setup-guide") + 1;
    const rest = lines.slice(start);
    const moved = [...lines.slice(0, start), "words: 200-500", "mention: Habit tracker", "mode: review", ...rest.filter((l) => !/^(mode|words|mention):/.test(l))];
    expect(moved).not.toEqual(lines);
    expect(accepted(`${moved.join("\n")}\n`).code).toBe(code);
  });

  it("changes with a heading, with the order of the headings, and with any other new line", () => {
    const codes = new Set([
      code,
      accepted(GUIDE.replace("heading: Install", "heading: Installing")).code,
      accepted(GUIDE.replace("heading: Install\nheading: Add your first habit", "heading: Add your first habit\nheading: Install")).code,
      accepted(GUIDE.replace("mention: Habit tracker", "mention: Habit Tracker")).code,
      accepted(GUIDE.replace("words: 200-500", "words: 200-501")).code,
      accepted(GUIDE.replace("mode: review", "mode: owner")).code,
      accepted(GUIDE.replace("mode: review", "mode: review\neffort: deep")).code,
      accepted(GUIDE.replace("mode: review", "mode: review\neffort: light")).code,
    ]);
    expect(codes.size).toBe(8);
  });

  it("writes the new lines after the checks, in the order the design gives", () => {
    const text = canonicalText(accepted(SALES).envelope, accepted(SALES).spec).split("\n");
    const at = text.indexOf("feature: column-notes");
    expect(text.slice(at, at + 9)).toEqual([
      "feature: column-notes",
      "title: Description of each column",
      "story: As the owner I can read what each column of the sales file means.",
      "mode: review",
      "effort: light",
      "needs: region-totals",
      "check: Every column of the sales file has a row in the description, with a plain meaning and an example value.",
      "check: The description does not say anything about a column that the sales file does not have.",
      "columns: Column, Meaning, Example",
    ]);
    expect(text.slice(at + 9, at + 11)).toEqual(["rows: 4-12", ""]);
  });
});

// ───────────────────────────── Every message ─────────────────────────────

describe("every new message of the plan reader, word for word", () => {
  const cases: [name: string, text: string, expected: string[]][] = [
    ["V08 an unknown key, with the new key list", plan(REVIEW, "colour: blue"), ["Line 12: “colour” is not a key that can be used. For the whole plan: name, request, folder, base, app-name, summary, assumption, contract. For each feature: feature, title, story, kind, mode, effort, needs, check, heading, mention, words, columns, rows."]],
    ["V08 a key that would turn the stop off", plan(REVIEW, "owner-stop: no"), ["Line 12: “owner-stop” is not a key that can be used. For the whole plan: name, request, folder, base, app-name, summary, assumption, contract. For each feature: feature, title, story, kind, mode, effort, needs, check, heading, mention, words, columns, rows."]],
    ["V08 another key that would turn the stop off", plan(REVIEW, "skip-look: yes"), ["Line 12: “skip-look” is not a key that can be used. For the whole plan: name, request, folder, base, app-name, summary, assumption, contract. For each feature: feature, title, story, kind, mode, effort, needs, check, heading, mention, words, columns, rows."]],
    ["V12 a heading", plan(REVIEW, "heading: Install `now`"), [`Line 12 (heading 1 of feature 1, “hello”) can't be used: it has a backtick. ${USE_WORDS(80)}`]],
    ["V12 the second heading", plan(REVIEW, "heading: Install", "heading: - Add"), [`Line 13 (heading 2 of feature 1, “hello”) can't be used: it does not start with a letter or a number. ${USE_WORDS(80)}`]],
    ["V12 a mention", plan(REVIEW, "mention: Hello", "mention: see https://x.example"), [`Line 13 (mention 2 of feature 1, “hello”) can't be used: it has a web address. ${USE_WORDS(80)}`]],
    ["V12 an empty mention", plan(REVIEW, "mention:"), [`Line 12 (mention 1 of feature 1, “hello”) can't be used: it is empty. ${USE_WORDS(80)}`]],
    ["V12 a column name", plan(REVIEW, "columns: Item, `Units`"), [`Line 12 (a column name in “columns” of feature 1, “hello”) can't be used: it has a backtick. ${USE_WORDS(40)}`]],
    ["V12 a column name that is too long", plan(REVIEW, `columns: Item, ${"U".repeat(41)}`), [`Line 12 (a column name in “columns” of feature 1, “hello”) can't be used: it is longer than 40 characters. ${USE_WORDS(40)}`]],
    ["V26 a mode that is not one of the three", plan(BASE, "mode: fast"), ["Line 11: “mode” must be tests, review or owner."]],
    ["V26 capitals", plan(BASE, "mode: Review"), ["Line 11: “mode” must be tests, review or owner."]],
    ["V26 empty", plan(BASE, "mode:"), ["Line 11: “mode” must be tests, review or owner."]],
    ["V26 a tab inside", plan(BASE, "mode: re\tview"), ["Line 11: “mode” must be tests, review or owner."]],
    ["V26 a hidden character", plan(BASE, "mode: review\u200B"), ["Line 11: “mode” must be tests, review or owner."]],
    ["V26 alone: the scripted keys that follow are not reported again", plan(BASE, "mode: fast", "heading: Install", "words: 1-2"), ["Line 11: “mode” must be tests, review or owner."]],
    ["V27 an effort that is not one of the three", plan(BASE, "effort: max"), ["Line 11: “effort” must be light, standard or deep."]],
    ["V27 a hidden character", plan(BASE, "effort: deep\u200B"), ["Line 11: “effort” must be light, standard or deep."]],
    ["V28 mechanical and deep", plan(BASE, "kind: mechanical", "effort: deep"), ["Feature 1 (“hello”) has “kind: mechanical” and “effort: deep”. “mechanical” is for light work. Leave out “kind”, or use “effort: light”."]],
    ["V29 words with spaces", plan(REVIEW, "words: 5 - 10"), ["Line 12: “words” must be two whole numbers with a dash between them, for example: words: 300-600. The first is at least 1 and not more than the second, and both are at most 99999."]],
    ["V29 words in the wrong order", plan(REVIEW, "words: 10-5"), ["Line 12: “words” must be two whole numbers with a dash between them, for example: words: 300-600. The first is at least 1 and not more than the second, and both are at most 99999."]],
    ["V29 words that start at 0", plan(REVIEW, "words: 0-5"), ["Line 12: “words” must be two whole numbers with a dash between them, for example: words: 300-600. The first is at least 1 and not more than the second, and both are at most 99999."]],
    ["V29 words over the top", plan(REVIEW, "words: 1-100000"), ["Line 12: “words” must be two whole numbers with a dash between them, for example: words: 300-600. The first is at least 1 and not more than the second, and both are at most 99999."]],
    ["V30 rows with spaces", plan(REVIEW, "rows: 1 -2"), ["Line 12: “rows” must be two whole numbers with a dash between them, for example: rows: 10-50. The first may be 0 and is not more than the second, and both are at most 999999."]],
    ["V30 rows in the wrong order", plan(REVIEW, "rows: 1-0"), ["Line 12: “rows” must be two whole numbers with a dash between them, for example: rows: 10-50. The first may be 0 and is not more than the second, and both are at most 999999."]],
    ["V30 rows over the top", plan(REVIEW, "rows: 0-1000000"), ["Line 12: “rows” must be two whole numbers with a dash between them, for example: rows: 10-50. The first may be 0 and is not more than the second, and both are at most 999999."]],
    ["V31 an empty column name", plan(REVIEW, "columns: Item, , Price"), ["Line 12: “columns” must list column names separated by commas, at most 30, all different, for example: columns: Item, Units, Price."]],
    ["V31 no names", plan(REVIEW, "columns:"), ["Line 12: “columns” must list column names separated by commas, at most 30, all different, for example: columns: Item, Units, Price."]],
    ["V31 two names that are the same", plan(REVIEW, "columns: A, A"), ["Line 12: “columns” must list column names separated by commas, at most 30, all different, for example: columns: Item, Units, Price."]],
    ["V31 the same name in other capitals", plan(REVIEW, "columns: Item, ITEM"), ["Line 12: “columns” must list column names separated by commas, at most 30, all different, for example: columns: Item, Units, Price."]],
    ["V31 the same name with other spaces", plan(REVIEW, "columns: Unit price, UnitPrice"), ["Line 12: “columns” must list column names separated by commas, at most 30, all different, for example: columns: Item, Units, Price."]],
    ["V31 thirty-one names", plan(REVIEW, `columns: ${Array.from({ length: 31 }, (_, i) => `C${i}`).join(", ")}`), ["Line 12: “columns” must list column names separated by commas, at most 30, all different, for example: columns: Item, Units, Price."]],
    ["V32 thirteen headings", plan(REVIEW, ...Array.from({ length: 13 }, (_, i) => `heading: Part ${i}`)), ["Feature 1 (“hello”) has 13 “heading” lines; at most 12 are allowed."]],
    ["V32 thirteen mentions", plan(REVIEW, ...Array.from({ length: 13 }, (_, i) => `mention: Word ${i}`)), ["Feature 1 (“hello”) has 13 “mention” lines; at most 12 are allowed."]],
    ["V32 both", plan(REVIEW, ...Array.from({ length: 14 }, (_, i) => `heading: Part ${i}`), ...Array.from({ length: 15 }, (_, i) => `mention: Word ${i}`)), ["Feature 1 (“hello”) has 14 “heading” lines; at most 12 are allowed.", "Feature 1 (“hello”) has 15 “mention” lines; at most 12 are allowed."]],
    ["V33 a heading in a feature checked by tests", plan(BASE, "heading: Install"), ["Line 11: “heading” is only for a feature that uses “mode: review” or “mode: owner”. A feature checked by tests is judged by its tests."]],
    ["V33 a mention", plan(BASE, "mention: Hello"), ["Line 11: “mention” is only for a feature that uses “mode: review” or “mode: owner”. A feature checked by tests is judged by its tests."]],
    ["V33 words", plan(BASE, "words: 1-2"), ["Line 11: “words” is only for a feature that uses “mode: review” or “mode: owner”. A feature checked by tests is judged by its tests."]],
    ["V33 columns", plan(BASE, "columns: A, B"), ["Line 11: “columns” is only for a feature that uses “mode: review” or “mode: owner”. A feature checked by tests is judged by its tests."]],
    ["V33 rows", plan(BASE, "rows: 1-2"), ["Line 11: “rows” is only for a feature that uses “mode: review” or “mode: owner”. A feature checked by tests is judged by its tests."]],
    ["V33 with mode tests written out", plan(BASE, "mode: tests", "rows: 1-2"), ["Line 12: “rows” is only for a feature that uses “mode: review” or “mode: owner”. A feature checked by tests is judged by its tests."]],
    ["V33 names the line of the first such key", plan(BASE, "words: 1-2", "heading: Install", "rows: 1-2"), ["Line 11: “words” is only for a feature that uses “mode: review” or “mode: owner”. A feature checked by tests is judged by its tests."]],
    ["V33 once for each feature", plan(BASE, "heading: Install", "", "feature: second", "title: Second", "story: The second.", "check: It works.", "rows: 1-2"), ["Line 11: “heading” is only for a feature that uses “mode: review” or “mode: owner”. A feature checked by tests is judged by its tests.", "Line 17: “rows” is only for a feature that uses “mode: review” or “mode: owner”. A feature checked by tests is judged by its tests."]],
    ["V33 after a misspelt key: V08 and V33 together", plan(BASE, "Mode: review", "heading: Install"), ["Line 11: “Mode” is not a key that can be used. For the whole plan: name, request, folder, base, app-name, summary, assumption, contract. For each feature: feature, title, story, kind, mode, effort, needs, check, heading, mention, words, columns, rows.", "Line 12: “heading” is only for a feature that uses “mode: review” or “mode: owner”. A feature checked by tests is judged by its tests."]],
    ["V10 mode given twice", plan(BASE, "mode: owner", "mode: owner"), ["Line 12: “mode” is given a second time in feature 1 (“hello”). It can be given only once."]],
    ["V10 effort given twice", plan(REVIEW, "effort: deep", "effort: light"), ["Line 13: “effort” is given a second time in feature 1 (“hello”). It can be given only once."]],
    ["V10 words, columns and rows given twice", plan(REVIEW, "words: 1-2", "words: 1-3", "columns: A", "columns: B", "rows: 1-2", "rows: 1-3"), [
      "Line 13: “words” is given a second time in feature 1 (“hello”). It can be given only once.",
      "Line 15: “columns” is given a second time in feature 1 (“hello”). It can be given only once.",
      "Line 17: “rows” is given a second time in feature 1 (“hello”). It can be given only once.",
    ]],
    ["V09 a mode before any feature", `${BASE.slice(0, 5).join("\n")}\nmode: owner\n${BASE.slice(5).join("\n")}\n`, ["Line 6: “mode” belongs to a feature, so it goes after a “feature” line."]],
  ];

  it.each(cases)("%s", (_name, text, expected) => {
    expect(problemsOf(text)).toEqual(expected);
  });

  it("puts the new checks after the others, in the order V26 to V33, feature by feature", () => {
    const text = plan(BASE, "mode: fast", "effort: max", "kind: mechanical", "words: 9-1", "rows: 9-1", "columns: A, A", ...Array.from({ length: 13 }, (_, i) => `heading: H${i}`));
    expect(problemsOf(text).map((p) => p.slice(0, 22))).toEqual([
      "Line 11: “mode” must b",
      "Line 12: “effort” must",
      "Line 14: “words” must ",
      "Line 15: “rows” must b",
      "Line 16: “columns” mus",
      "Feature 1 (“hello”) ha",
    ]);
  });

  it("lists a problem of the lines themselves before the problems of the whole plan", () => {
    const text = plan(BASE, "mode: fast", "heading: Install `now`");
    expect(problemsOf(text).map((p) => p.slice(0, 31))).toEqual(["Line 12 (heading 1 of feature 1", "Line 11: “mode” must be tests, "]);
  });

  it("stays within the twelve problems the preview prints: a plan with many wrong lines still lists them all and says nothing is thrown", () => {
    const text = plan(BASE, ...Array.from({ length: 40 }, (_, i) => `heading: Part ${i} \`x\``));
    expect(problemsOf(text).length).toBeGreaterThan(12);
  });
});

// ───────────────────────────── Limits ─────────────────────────────

describe("every limit of the new keys, at its edge and one over", () => {
  const ok = (...more: string[]): ReturnType<typeof accepted> => accepted(plan(REVIEW, ...more));
  const refused = (...more: string[]): string[] => problemsOf(plan(REVIEW, ...more));

  it("allows twelve headings and twelve mentions, and refuses a thirteenth of either", () => {
    expect(ok(...Array.from({ length: 12 }, (_, i) => `heading: Part ${i}`)).spec.features[0]?.expect?.headings).toHaveLength(12);
    expect(ok(...Array.from({ length: 12 }, (_, i) => `mention: Word ${i}`)).spec.features[0]?.expect?.mentions).toHaveLength(12);
    expect(refused(...Array.from({ length: 13 }, (_, i) => `heading: Part ${i}`))).toHaveLength(1);
    expect(refused(...Array.from({ length: 13 }, (_, i) => `mention: Word ${i}`))).toHaveLength(1);
  });

  it("allows thirty column names, each of 40 characters, and refuses 31 or a name of 41", () => {
    expect(ok(`columns: ${Array.from({ length: 30 }, (_, i) => `C${i}`).join(", ")}`).spec.features[0]?.expect?.columns).toHaveLength(30);
    expect(ok(`columns: ${"U".repeat(40)}`).spec.features[0]?.expect?.columns).toEqual(["U".repeat(40)]);
    expect(refused(`columns: ${"U".repeat(41)}`)[0]).toContain("it is longer than 40 characters");
  });

  it("allows a heading and a mention of 80 characters and refuses 81", () => {
    expect(ok(`heading: ${"H".repeat(80)}`, `mention: ${"M".repeat(80)}`).spec.features[0]?.expect).toEqual({ headings: ["H".repeat(80)], mentions: ["M".repeat(80)] });
    expect(refused(`heading: ${"H".repeat(81)}`)[0]).toContain("it is longer than 80 characters");
    expect(refused(`mention: ${"M".repeat(81)}`)[0]).toContain("it is longer than 80 characters");
    expect(refused(`heading: ${"H".repeat(1000)}`)).toHaveLength(1);
  });

  it.each([
    ["1-1", [1, 1]],
    ["1-99999", [1, 99999]],
    ["200-500", [200, 500]],
    ["00005-9", [5, 9]],
  ] as [string, [number, number]][])("words: %s is accepted", (value, range) => {
    expect(ok(`words: ${value}`).spec.features[0]?.expect?.words).toEqual(range);
  });

  it.each(["0-5", "5-1", "1-100000", "1e3-5", "0x10-20", "+5-9", "-5", "5-", "5", "5 - 10", " 5-10 x", "１-５", "١-٥", "5\u200B-9", "5--9", "5-9-12", "1.5-9", "five-ten"])("words: %s is refused", (value) => {
    expect(refused(`words: ${value}`)[0]).toMatch(/^Line 12: “words” must be two whole numbers/);
  });

  it.each([
    ["0-0", [0, 0]],
    ["0-1", [0, 1]],
    ["4-12", [4, 12]],
    ["0-999999", [0, 999999]],
  ] as [string, [number, number]][])("rows: %s is accepted", (value, range) => {
    expect(ok(`rows: ${value}`).spec.features[0]?.expect?.rows).toEqual(range);
  });

  it.each(["1-0", "0-1000000", "1e3-5", "+1-2", "１-５", "-1-2", "1 -2", "1- 2", "x"])("rows: %s is refused", (value) => {
    expect(refused(`rows: ${value}`)[0]).toMatch(/^Line 12: “rows” must be two whole numbers/);
  });

  it("accepts a range that the file size limits make unreachable: the checks say what they find", () => {
    expect(ok("rows: 500000-999999").spec.features[0]?.expect?.rows).toEqual([500000, 999999]);
    expect(ok("words: 90000-99999").spec.features[0]?.expect?.words).toEqual([90000, 99999]);
  });

  it("mechanical with deep is refused; mechanical with standard or light is accepted, and means light work", () => {
    const mechanical = accepted(plan(BASE, "kind: mechanical"));
    expect(accepted(plan(BASE, "kind: mechanical", "effort: standard")).code).toBe(mechanical.code);
    expect(accepted(plan(BASE, "kind: mechanical", "effort: standard")).spec).toEqual(mechanical.spec);
    const light = accepted(plan(BASE, "kind: mechanical", "effort: light"));
    expect(light.spec.features[0]).toMatchObject({ kind: "mechanical", effort: "light" });
    expect(light.code).not.toBe(mechanical.code);
    expect(problemsOf(plan(BASE, "kind: mechanical", "effort: deep"))).toHaveLength(1);
    expect(accepted(plan(BASE, "effort: deep")).spec.features[0]?.effort).toBe("deep");
  });

  it("stores a mode and an effort only when they are not the defaults", () => {
    const fields = (...more: string[]): unknown => {
      const f = accepted(plan(BASE, ...more)).spec.features[0];
      return [f?.mode, f?.effort, f?.expect];
    };
    expect(fields()).toEqual([undefined, undefined, undefined]);
    expect(fields("mode: tests", "effort: standard")).toEqual([undefined, undefined, undefined]);
    expect(fields("mode: review")).toEqual(["review", undefined, undefined]);
    expect(fields("mode: owner", "effort: light")).toEqual(["owner", "light", undefined]);
    expect(fields("mode: owner", "effort: deep", "words: 1-2")).toEqual(["owner", "deep", { words: [1, 2] }]);
  });
});

// ───────────────────────────── Hostile input ─────────────────────────────

describe("hostile input in the new keys", () => {
  const heading = (value: string): string => plan(REVIEW, `heading: ${value}`);

  it.each(["C:\\x", "C:\\Windows\\System32", "www.example.com", "mailto:a@b.c", "javascript:alert(1)", "data:text/html,x", "etc/passwd", "rm -rf x", "My File.md", "a/../b", "x; y", "Ünïcödé ✓", "a'b", 'say "hi"', "Install”, “Add your first habit", "100%"])(
    "accepts %s as plain text, to be looked for and never opened",
    (value) => {
      expect(accepted(heading(value)).spec.features[0]?.expect?.headings).toEqual([value]);
      expect(accepted(plan(REVIEW, `mention: ${value}`)).spec.features[0]?.expect?.mentions).toEqual([value]);
      // a column name stops at a comma
      if (!value.includes(",")) expect(accepted(plan(REVIEW, `columns: Item, ${value}`)).spec.features[0]?.expect?.columns).toEqual(["Item", value].map((v) => v.slice(0, 40)));
    },
  );

  it.each([
    ["../../etc/passwd", "it does not start with a letter or a number"],
    ["/etc/passwd", "it does not start with a letter or a number"],
    ["//evil.example/x", "it does not start with a letter or a number"],
    [".hidden", "it does not start with a letter or a number"],
    ["$(whoami)", "it does not start with a letter or a number"],
    ["<script>alert(1)</script>", "it does not start with a letter or a number"],
    ["-rf", "it does not start with a letter or a number"],
    ["# Install", "it does not start with a letter or a number"],
    ["https://x.example", "it has a web address"],
    ["see http://x", "it has a web address"],
    ["a `b`", "it has a backtick"],
    ["a\u200Bb", "it has a character that cannot be seen"],
    ["a\u202Eb", "it has a character that cannot be seen"],
    ["a\uFE0Fb", "it has a character that cannot be seen"],
    ["a\u3164b", "it has a character that cannot be seen"],
    ["a\u0000b", "it has a character that cannot be seen"],
    ["a\tb", "it has a character that cannot be seen"],
    ["a\u00A0b", "it has a character that cannot be seen"],
    ["don\\'t", "it has a backslash before a quote mark"],
    ["x".repeat(1000), "it is longer than 80 characters"],
  ])("refuses %s with a reason", (value, reason) => {
    const problems = problemsOf(heading(value));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`can't be used: ${reason}.`);
    expect(problems[0]).not.toContain(value.slice(0, 5) === "x".repeat(5) ? "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" : "\u0000");
  });

  it("refuses a curly bracket anywhere with the one message about curly brackets, alone", () => {
    const problems = problemsOf(heading("a { b"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^The plan has a curly bracket on line 12\./);
    expect(problemsOf(plan(REVIEW, "columns: A, }"))[0]).toMatch(/^The plan has a curly bracket on line 12\./);
  });

  it("never finds a key by property access: constructor, toString, __proto__ and capitals are not keys", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "Mode", "EFFORT", "Heading", "WORDS"]) {
      const problems = problemsOf(plan(REVIEW, `${key}: x`));
      expect(problems[0]).toMatch(/^Line 12: “.+” is not a key that can be used\./);
    }
    expect(problemsOf(plan(REVIEW, "__proto__: x"))[0]).toMatch(/^Line 12 is not a “key: value” line/);
  });

  it("has no key that turns the owner's look off: the plan can only add looks", () => {
    for (const line of ["owner-stop: no", "skip-look: yes", "look: no", "stop: none", "ownerStops: false", "checkpoint: none"]) {
      expect(problemsOf(plan(REVIEW, line))[0]).toMatch(/is not a key that can be used/);
    }
    // and an owner feature stays an owner feature whatever else the block says
    expect(accepted(plan(BASE, "mode: owner", "effort: light", "mention: Hello")).spec.features[0]?.mode).toBe("owner");
  });

  it("accepts a file name written in a check, as before: it is plain words, and nothing opens it", () => {
    const parsed = accepted(plan(REVIEW, "check: The guide is saved in docs/guide.md and links to ../README.md."));
    expect(parsed.spec.features[0]?.acceptance[1]).toBe("The guide is saved in docs/guide.md and links to ../README.md.");
  });

  it("reads 200 heading lines in linear time and refuses them once", () => {
    const started = Date.now();
    const problems = problemsOf(plan(REVIEW, ...Array.from({ length: 200 }, (_, i) => `heading: Part ${i}`)));
    expect(problems).toEqual(["Feature 1 (“hello”) has 200 “heading” lines; at most 12 are allowed."]);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

// ───────────────────────────── A seeded fuzz of the reader ─────────────────────────────

describe("a seeded fuzz of the reader with the new keys", () => {
  /** A small seeded generator (mulberry32), so a failure can be repeated. */
  function random(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const VALUES = [
    "Install", "Add your first habit", "Habit tracker", "Get started", "A", "a", "Item", "Units", "Price", "Part 1", "x".repeat(80), "x".repeat(81), "x".repeat(1000),
    "../../etc/passwd", "/etc/passwd", "C:\\x", "https://x.example", "www.example.com", "//evil.example/x", "mailto:a@b.c", "javascript:alert(1)", "data:text/html,x", "etc/passwd", "rm -rf x",
    "a `b`", "a { b", "a } b", "a\u200Bb", "a\u202Eb", "a\uFE0Fb", "a\u3164b", "a\tb", "a\u0000b", "\u0301x", "don\\'t", "-x", ".x", "# x", "My File.md", "say “hi”", "Install”, “Add", "",
    "1-2", "0-5", "5-1", "1-99999", "1-100000", "0-0", "0-999999", "0-1000000", "1e3-5", "0x10-20", "+5-9", "5 - 10", "１-５", "١-٥", "200-500", "A, B, C", "A, A", "A, , B", "a b, ab", "C0, C1, C2",
    "review", "owner", "tests", "light", "standard", "deep", "Review", "fast", "max", "mechanical", "standard",
  ];
  const KEYS = ["mode", "effort", "heading", "mention", "words", "columns", "rows", "check", "title", "story", "kind", "needs", "assumption", "contract", "summary", "name", "folder", "base", "Mode", "constructor", "__proto__", "owner-stop", "feature", "mc-plan", "x y", "", "a-very-long-key-".repeat(5)];
  const GOOD = ["mode: review", "mode: owner", "mode: tests", "effort: deep", "effort: light", "effort: standard", "heading: Install", "heading: Add your first habit", "mention: Habit tracker", "words: 200-500", "columns: Item, Units, Price", "rows: 0-10", "check: It works.", "kind: mechanical"];

  function generate(next: () => number): string {
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const lines = [...BASE];
    const extra = Math.floor(next() * 14);
    for (let i = 0; i < extra; i++) {
      const roll = next();
      const line = roll < 0.45 ? pick(GOOD) : roll < 0.9 ? `${pick(KEYS)}${next() < 0.1 ? " " : ""}: ${pick(VALUES)}` : pick(["", "feature: second", "title: Second", "story: The second.", "needs: hello", "mc-plan 1", "{", "x", "check:"]);
      lines.splice(Math.floor(next() * (lines.length + 1)), 0, line);
    }
    if (next() < 0.1) lines.splice(Math.floor(next() * lines.length), 1);
    return `${lines.join(next() < 0.15 ? "\r\n" : "\n")}\n`;
  }

  /** Every refusal has one of these shapes. */
  const SHAPES = [
    /^The plan is too long /,
    /^The plan has a curly bracket on line \d+\./,
    /^The first line of the plan must be exactly: mc-plan 1/,
    /^Line \d+ is not a “key: value” line\./,
    /^Line \d+: “[^”]*” is not a key that can be used\. /,
    /^Line \d+: “[a-z-]+” is about the whole plan, /,
    /^Line \d+: “[a-z-]+” belongs to a feature, /,
    /^Line \d+: “[a-z-]+” is given a second time( in feature \d+ \(“.*”\))?\. It can be given only once\.$/,
    /^Line \d+ \([^)]*\) can't be used: it (is empty|is longer than [\d,]+ characters|has a character that cannot be seen|has a backtick|has a web address|has a backslash before a quote mark|does not start with a letter or a number)\. Use /,
    /^Line \d+: the feature id “.*” is kept for the team's own repair work\./,
    /^“[a-z-]+” is missing\. Add a line that starts with “[a-z-]+:”\.$/,
    /^Feature \d+ \(“.*”\) has no “(title|story)” line\./,
    /^The plan has no feature\./,
    /^The plan needs between 1 and 10 features /,
    /^Feature \d+ \(“.*”\) needs 1 to 20 “check” lines \(it has \d+\)\.$/,
    /^Line \d+: “kind” must be standard or mechanical\.$/,
    /^Line \d+: “mode” must be tests, review or owner\.$/,
    /^Line \d+: “effort” must be light, standard or deep\.$/,
    /^Feature \d+ \(“.*”\) has “kind: mechanical” and “effort: deep”\. /,
    /^Line \d+: “words” must be two whole numbers /,
    /^Line \d+: “rows” must be two whole numbers /,
    /^Line \d+: “columns” must list column names /,
    /^Feature \d+ \(“.*”\) has \d+ “(heading|mention)” lines; at most 12 are allowed\.$/,
    /^Line \d+: “(heading|mention|words|columns|rows)” is only for a feature that uses “mode: review” or “mode: owner”\. /,
    /^Line \d+: “needs” must list feature ids /,
    /^The plan has \d+ “(assumption|contract)” lines; /,
    /^Line \d+: “folder” must be just the name of a folder /,
    /^Line \d+: “base” (is not a branch name|only goes with “folder”)/,
    /^Feature id "[^"]*" (must be kebab-case|is used more than once)/,
    /^Feature "[^"]*" depends on "[^"]*", which is not in the spec\.$/,
    /^The deps form a cycle: /,
  ];

  // Characters no accepted value may hold (the reader's own rule, written again here on purpose).
  const BANNED = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]|(?! )\p{Zs}|[\uFE00-\uFE0F]|[\u115F\u1160\u3164\uFFA0\u2800\u034F\u17B4\u17B5\u180B-\u180D\u180F]|`|:\/\/|[{}]/u;

  /** What a plan wrote under each feature's heading and mention lines, read again without the reader. */
  function writtenValues(text: string): { headings: string[]; mentions: string[] }[] {
    const out: { headings: string[]; mentions: string[] }[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/^[ \t]+|[ \t]+$/g, "");
      const colon = line.indexOf(":");
      const key = colon > 0 ? line.slice(0, colon) : "";
      const value = line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "");
      if (key === "feature") out.push({ headings: [], mentions: [] });
      else if (key === "heading") out.at(-1)?.headings.push(value);
      else if (key === "mention") out.at(-1)?.mentions.push(value);
    }
    return out;
  }

  it("2,000 generated plans: the reader never throws, answers the same twice, refuses in known shapes, and keeps what it accepts", () => {
    const next = random(20260515);
    let acceptedCount = 0;
    let refusedCount = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const text = generate(next);
      let first: ReturnType<typeof parsePlan>;
      try {
        first = parsePlan(text);
      } catch (err) {
        throw new Error(`the reader threw on plan ${i}: ${String(err)}\n${text}`);
      }
      expect(parsePlan(text), `plan ${i} read twice`).toEqual(first);
      if (!first.ok) {
        refusedCount++;
        expect(first.problems.length, `plan ${i}`).toBeGreaterThan(0);
        for (const problem of first.problems) {
          expect(SHAPES.some((shape) => shape.test(problem)), `plan ${i}: an unknown message shape: ${problem}\n${text}`).toBe(true);
          expect(problem, `plan ${i}`).not.toMatch(/[\n\r\u0000-\u0008\u000B-\u001F]/);
          seen.add(problem.replace(/\d+/g, "N").slice(0, 50));
        }
        continue;
      }
      acceptedCount++;
      // it comes back from its fixed form with the same code and the same plan
      const fixed = canonicalText(first.envelope, first.spec);
      const again = accepted(fixed);
      expect(again.code, `plan ${i}`).toBe(first.code);
      expect(again.spec, `plan ${i}`).toEqual(first.spec);
      expect(canonicalText(again.envelope, again.spec), `plan ${i}`).toBe(fixed);
      expect(planCode(first.envelope, first.spec)).toBe(first.code);
      // no accepted value holds a character of a banned class
      const values = [first.envelope.name, first.envelope.request, ...first.spec.features.flatMap((f) => [f.id, f.title, f.story, ...f.acceptance, ...(f.expect?.headings ?? []), ...(f.expect?.mentions ?? []), ...(f.expect?.columns ?? [])])];
      for (const v of values) expect(BANNED.test(v), `plan ${i}: ${JSON.stringify(v)}`).toBe(false);
      // expect holds exactly what was written, in order, and only on a feature with a mode
      const written = writtenValues(text);
      first.spec.features.forEach((f, k) => {
        expect(f.expect?.headings ?? [], `plan ${i} feature ${k}`).toEqual(written[k]?.headings);
        expect(f.expect?.mentions ?? [], `plan ${i} feature ${k}`).toEqual(written[k]?.mentions);
        if (f.expect !== undefined) expect(f.mode, `plan ${i} feature ${k}`).toBeDefined();
        if (f.mode !== undefined) expect(["review", "owner"]).toContain(f.mode);
        if (f.effort !== undefined) expect(["light", "deep"]).toContain(f.effort);
        if (f.expect?.words) expect(f.expect.words[0]).toBeLessThanOrEqual(f.expect.words[1]);
      });
    }
    // the generator reaches both outcomes and many different messages
    expect(acceptedCount).toBeGreaterThan(100);
    expect(refusedCount).toBeGreaterThan(500);
    expect(seen.size).toBeGreaterThan(25);
  });
});
