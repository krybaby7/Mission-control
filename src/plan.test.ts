import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalText, describePlan, parsePlan, PLAN_MAX_CHARS, planCode, reviewLines, wrapFact, wrapLine } from "./plan.js";
import type { SpecOutput } from "./types.js";

// ───────────────────────────── Plans to start from ─────────────────────────────

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "plans");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/** Example 1 of docs/plans-spec.md section 3.1: a change to an existing app (test/fixtures/plans/dark-mode.txt). */
const ONE = fixture("dark-mode.txt");

/** Example 2: a new app with three features, each needing the one before (test/fixtures/plans/reading-list.txt). */
const THREE = fixture("reading-list.txt");

/** The smallest plan there is: a new app with one feature. */
const SMALL = ["mc-plan 1", "name: Hello", "request: Say hello.", "app-name: Hello app", "summary: Says hello.", "", "feature: hello", "title: Say hello", "story: As a user I am greeted.", "check: The page shows Hello."];

/** SMALL with its lines edited: a function from the lines to the new lines. */
function edit(change: (lines: string[]) => string[], base: string[] = SMALL): string {
  return `${change([...base]).join("\n")}\n`;
}
const replaceLine = (from: string, to: string) => (lines: string[]) => lines.map((l) => (l === from ? to : l));
const without = (line: string) => (lines: string[]) => lines.filter((l) => l !== line);
const addAfter = (line: string, ...more: string[]) => (lines: string[]) => lines.flatMap((l) => (l === line ? [l, ...more] : [l]));
const addAtEnd = (...more: string[]) => (lines: string[]) => [...lines, ...more];

function problemsOf(text: string): string[] {
  const parsed = parsePlan(text);
  if (parsed.ok) throw new Error(`expected a problem, the plan was accepted:\n${text}`);
  return parsed.problems;
}

function accepted(text: string): Extract<ReturnType<typeof parsePlan>, { ok: true }> {
  const parsed = parsePlan(text);
  if (!parsed.ok) throw new Error(`expected the plan to be accepted:\n${parsed.problems.join("\n")}`);
  return parsed;
}


// ───────────────────────────── The examples and the real planner plans ─────────────────────────────

describe("the examples of the design", () => {
  it("accepts example 1 and turns it into the planner's own shape", () => {
    const parsed = accepted(ONE);
    expect(parsed.code).toBe("a4adaca5");
    expect(parsed.sha256).toMatch(/^a4adaca5[0-9a-f]{56}$/);
    expect(parsed.envelope).toEqual({
      name: "Dark mode",
      request: "On the settings page of the habit tracker, add a Dark mode switch. It should remember my choice.",
      folder: "habit-tracker",
      base: "main",
    });
    expect(parsed.spec).toEqual({
      appName: "Habit tracker",
      summary: "Adds a Dark mode switch to the settings page. The page turns dark when it is on, and the choice is remembered.",
      assumptions: ["The switch is off until the person turns it on, and the choice is kept for that person on the same device."],
      // the contract lines each after "- ", joined by new lines
      uiContract: "- The switch is on the settings page and its label is Dark mode.\n- The switch has the test id dark-mode-switch.",
      features: [
        {
          id: "dark-mode",
          title: "Dark mode switch on the settings page",
          story: "As a user I can switch the app to dark colours on the settings page, and it stays that way when I come back.",
          acceptance: [
            "The settings page shows a switch labelled Dark mode, and it is off by default.",
            "Turning the switch on makes the page background dark.",
            "Turning the switch off makes the page background light again.",
            "After the switch is turned on and the page is reloaded, the switch is still on and the page is dark.",
            "After the switch is turned off and the page is reloaded, the switch is off and the page is light.",
          ],
          kind: "standard",
          deps: [],
        },
      ],
    });
  });

  it("accepts example 2: a new app, three features, each needing the one before", () => {
    const parsed = accepted(THREE);
    expect(parsed.code).toBe("c5b7a589");
    expect(parsed.envelope).toEqual({ name: "Reading list", request: expect.stringContaining("reading list") });
    expect(parsed.spec.features.map((f) => [f.id, f.deps])).toEqual([
      ["add-book", []],
      ["mark-read", ["add-book"]],
      ["read-count", ["mark-read"]],
    ]);
    // a colon inside a text: only the first colon on a line ends the key
    expect(parsed.spec.features[2]?.acceptance[0]).toBe("With no books the page shows Books read: 0.");
    expect(parsed.spec.uiContract.split("\n")[3]).toBe("- The text Books read: followed by a number shows how many books are marked as read.");
  });

  it.each(["slugify.txt", "shout.txt", "whisper.txt"])("accepts the real planner plan %s, written the way a leader writes it", (name) => {
    const parsed = accepted(fixture(name));
    expect(parsed.spec.features.length).toBeGreaterThan(0);
    expect(parsed.spec.features.every((f) => f.acceptance.length >= 1)).toBe(true);
    expect(fixture(name).split("\n").filter((l) => l.trim() === "PLAN")).toEqual([]);
  });

  it("keeps the kind and the needs of the real plans", () => {
    const slugify = accepted(fixture("slugify.txt")).spec.features;
    expect(slugify.map((f) => [f.id, f.kind, f.deps])).toEqual([
      ["slugify-function", "standard", []],
      ["slugify-readme", "mechanical", ["slugify-function"]],
    ]);
  });
});

// ───────────────────────────── The messages ─────────────────────────────

describe("every message of the plan reader", () => {
  const FEATURE_ID = (k: number, id: string): string => `Feature ${k} (“${id}”)`;
  const USE_WORDS = (max: string): string => `Use plain words, up to ${max} characters, starting with a letter or a number, with no backticks and no web addresses.`;
  const USE_ID = "Use a feature id: lowercase letters, digits and single dashes, up to 60 characters, for example dark-mode.";

  const cases: [name: string, text: string, expected: string[]][] = [
    ["V02 too long", `${edit(replaceLine("check: The page shows Hello.", `check: ${"a".repeat(300)}`))}${"\n".repeat(PLAN_MAX_CHARS)}`, ["The plan is too long (more than 30,000 characters). Shorten it, or split the work into two plans."]],
    ["V05 curly bracket", edit(replaceLine("check: The page shows Hello.", "check: The page shows { Hello }.")), ["The plan has a curly bracket on line 10. Plans are plain lines of “key: value” text and never use curly brackets. Write the words without them."]],
    ["V06 not the first line", edit((l) => l.slice(1)), ["The first line of the plan must be exactly: mc-plan 1 (it is “name: Hello”)."]],
    ["V06 another version", edit(replaceLine("mc-plan 1", "mc-plan 2")), ["The first line of the plan must be exactly: mc-plan 1 (it is “mc-plan 2”)."]],
    ["V06 empty", "", ["The first line of the plan must be exactly: mc-plan 1 (the plan is empty)."]],
    ["V06 spaces only", " \n\n \n", ["The first line of the plan must be exactly: mc-plan 1 (the plan is empty)."]],
    ["V07 a wrapped text", edit(addAfter("summary: Says hello.", "and goes on here")), ["Line 6 is not a “key: value” line. Every line starts with a key, a colon and the text. Keep each text on one line; do not carry a long text over to the next line."]],
    ["V07 a line with no colon", edit(addAfter("summary: Says hello.", "PLAN")), ["Line 6 is not a “key: value” line. Every line starts with a key, a colon and the text. Keep each text on one line; do not carry a long text over to the next line."]],
    // The refused line leaves the feature with no check, which is a second message that follows from the first.
    ["V07 a space before the colon", edit(replaceLine("check: The page shows Hello.", "check : The page shows Hello.")), ["Line 10 is not a “key: value” line. Every line starts with a key, a colon and the text. Keep each text on one line; do not carry a long text over to the next line.", `${FEATURE_ID(1, "hello")} needs 1 to 20 “check” lines (it has 0).`]],
    ["V08 an unknown key", edit(addAfter("summary: Says hello.", "colour: blue")), ["Line 6: “colour” is not a key that can be used. For the whole plan: name, request, folder, base, app-name, summary, assumption, contract. For each feature: feature, title, story, kind, mode, effort, needs, check, heading, mention, words, columns, rows."]],
    ["V09 a plan key after a feature", edit(addAtEnd("name: Again")), ["Line 11: “name” is about the whole plan, so it goes before the first “feature” line."]],
    ["V09 a feature key before any feature", edit(addAfter("summary: Says hello.", "check: Early.")), ["Line 6: “check” belongs to a feature, so it goes after a “feature” line."]],
    ["V10 given twice", edit(addAfter("summary: Says hello.", "summary: Again.")), ["Line 6: “summary” is given a second time. It can be given only once."]],
    ["V10 given twice in a feature", edit(addAtEnd("title: Again")), ["Line 11: “title” is given a second time in feature 1 (“hello”). It can be given only once."]],
    ["V11 a plan line is missing", edit(without("summary: Says hello.")), ["“summary” is missing. Add a line that starts with “summary:”."]],
    ["V11 a feature line is missing", edit(without("story: As a user I am greeted.")), [`${FEATURE_ID(1, "hello")} has no “story” line. Add a line that starts with “story:”.`]],
    ["V11 after a misspelt key", edit(replaceLine("summary: Says hello.", "Summary: Says hello.")), ["Line 5: “Summary” is not a key that can be used. For the whole plan: name, request, folder, base, app-name, summary, assumption, contract. For each feature: feature, title, story, kind, mode, effort, needs, check, heading, mention, words, columns, rows.", "“summary” is missing. Add a line that starts with “summary:”."]],
    ["V12 a backtick", edit(replaceLine("title: Say hello", "title: Say `hello`")), [`Line 8 (the title of feature 1, “hello”) can't be used: it has a backtick. ${USE_WORDS("80")}`]],
    ["V12 empty", edit(replaceLine("summary: Says hello.", "summary:   ")), [`Line 5 (“summary”) can't be used: it is empty. ${USE_WORDS("400")}`]],
    ["V12 too long", edit(replaceLine("story: As a user I am greeted.", `story: ${"a".repeat(401)}`)), [`Line 9 (the story of feature 1, “hello”) can't be used: it is longer than 400 characters. ${USE_WORDS("400")}`]],
    ["V12 hidden", edit(replaceLine("check: The page shows Hello.", "check: The page\u200B shows Hello.")), [`Line 10 (check 1 of feature 1, “hello”) can't be used: it has a character that cannot be seen. ${USE_WORDS("300")}`]],
    ["V12 web address", edit(addAfter("summary: Says hello.", "assumption: Use https://example.org for it.")), [`Line 6 (assumption 1) can't be used: it has a web address. ${USE_WORDS("300")}`]],
    ["V12 backslash before a quote", edit(addAfter("summary: Says hello.", "contract: It says don\\'t.")), [`Line 6 (contract line 1) can't be used: it has a backslash before a quote mark. ${USE_WORDS("300")}`]],
    ["V12 does not start with a letter", edit(replaceLine("check: The page shows Hello.", "check: - The page shows Hello.")), [`Line 10 (check 1 of feature 1, “hello”) can't be used: it does not start with a letter or a number. ${USE_WORDS("300")}`]],
    ["V12 the request", edit(replaceLine("request: Say hello.", `request: ${"a".repeat(1001)}`)), ["Line 3 (“request”) can't be used: it is longer than 1,000 characters. Use plain words, up to 1,000 characters, with no backticks and no web addresses."]],
    ["V12 a feature id", edit(replaceLine("feature: hello", "feature: hel`lo")), [`Line 7 (the id of feature 1) can't be used: it has a backtick. ${USE_ID}`]],
    ["V12 an id in needs", edit(addAfter("story: As a user I am greeted.", "needs: a b, x\u200By")), [`Line 10 (an id in “needs” of feature 1, “hello”) can't be used: it has a character that cannot be seen. ${USE_ID}`]],
    ["V13 no feature", edit((l) => l.slice(0, 5)), ["The plan has no feature. Start each feature with a “feature:” line, followed by its “title:”, “story:” and “check:” lines."]],
    ["V13 eleven features", featuresPlan(11), ["The plan needs between 1 and 10 features (it has 11). For more, let the team's planner write the plan: queue it with mc new or mc feature."]],
    ["V14 a reserved id", edit(replaceLine("feature: hello", "feature: gate-c-fix-1")), ["Line 7: the feature id “gate-c-fix-1” is kept for the team's own repair work. Choose another id."]],
    ["V14 the other reserved id", edit(replaceLine("feature: hello", "feature: owner-change-2")), ["Line 7: the feature id “owner-change-2” is kept for the team's own repair work. Choose another id."]],
    ["V15 no check", edit(without("check: The page shows Hello.")), [`${FEATURE_ID(1, "hello")} needs 1 to 20 “check” lines (it has 0).`]],
    ["V15 twenty-one checks", edit(addAtEnd(...Array.from({ length: 20 }, (_, i) => `check: Check number ${i + 2}.`))), [`${FEATURE_ID(1, "hello")} needs 1 to 20 “check” lines (it has 21).`]],
    ["V16 kind", edit(addAfter("story: As a user I am greeted.", "kind: fast")), ["Line 10: “kind” must be standard or mechanical."]],
    ["V17 an empty needs entry", edit(addAfter("story: As a user I am greeted.", "needs: a,, b")), ["Line 10: “needs” must list feature ids separated by commas, at most 9, for example: needs: add-book, mark-read."]],
    ["V17 no ids", edit(addAfter("story: As a user I am greeted.", "needs:")), ["Line 10: “needs” must list feature ids separated by commas, at most 9, for example: needs: add-book, mark-read."]],
    ["V17 ten ids", edit(addAfter("story: As a user I am greeted.", "needs: a, b, c, d, e, f, g, h, i, j")), ["Line 10: “needs” must list feature ids separated by commas, at most 9, for example: needs: add-book, mark-read."]],
    ["V18 eleven assumptions", edit(addAfter("summary: Says hello.", ...Array.from({ length: 11 }, (_, i) => `assumption: Choice ${i + 1}.`))), ["The plan has 11 “assumption” lines; at most 10 are allowed."]],
    ["V18 forty-one contract lines", edit(addAfter("summary: Says hello.", ...Array.from({ length: 41 }, (_, i) => `contract: Name ${i + 1}.`))), ["The plan has 41 “contract” lines; at most 40 are allowed."]],
    ["V19 folder with a slash", edit(addAfter("summary: Says hello.", "folder: apps/habit-tracker")), ["Line 6: “folder” must be just the name of a folder inside ~/mc-apps, for example habit-tracker (no slashes). Leave the line out for a new app."]],
    ["V19 folder that starts with a dot", edit(addAfter("summary: Says hello.", "folder: ..")), ["Line 6: “folder” must be just the name of a folder inside ~/mc-apps, for example habit-tracker (no slashes). Leave the line out for a new app."]],
    ["V20 base", edit(addAfter("summary: Says hello.", "folder: app", "base: -x")), ["Line 7: “base” is not a branch name. Use letters, digits, dots, dashes, underscores and slashes, up to 100 characters, starting with a letter, a digit or an underscore."]],
    ["V21 base without folder", edit(addAfter("summary: Says hello.", "base: main")), ["Line 6: “base” only goes with “folder”: a new app has no branch to start from."]],
    ["V22 an id that is not kebab-case", edit(replaceLine("feature: hello", "feature: Hello World")), ['Feature id "Hello World" must be kebab-case (lowercase letters, digits, single dashes), at most 60 characters.']],
    ["V22 an id used twice", edit(addAtEnd("", "feature: hello", "title: Again", "story: Again.", "check: Again.")), ['Feature id "hello" is used more than once.']],
    ["V22 a need that is not in the plan", edit(addAfter("story: As a user I am greeted.", "needs: elsewhere")), ['Feature "hello" depends on "elsewhere", which is not in the spec.']],
    ["V22 a cycle", edit(addAtEnd("needs: second", "", "feature: second", "title: Second", "story: The second.", "needs: hello", "check: It works.")), ["The deps form a cycle: hello → second → hello."]],
    ["V22 a feature needing itself", edit(addAfter("story: As a user I am greeted.", "needs: hello")), ["The deps form a cycle: hello → hello."]],
  ];

  function featuresPlan(n: number): string {
    return edit(addAtEnd(...Array.from({ length: n - 1 }, (_, i) => [``, `feature: more-${i + 1}`, `title: More ${i + 1}`, `story: More ${i + 1}.`, `check: It works.`]).flat()));
  }

  it.each(cases)("%s", (_name, text, expected) => {
    expect(problemsOf(text)).toEqual(expected);
  });

  it("gives the curly bracket and the first line alone for the JSON of the first draft", () => {
    const json = '{"format":"mc-plan/1","name":"x","plan":{"features":[]}}';
    expect(problemsOf(json)).toEqual([
      "The plan has a curly bracket on line 1. Plans are plain lines of “key: value” text and never use curly brackets. Write the words without them.",
      `The first line of the plan must be exactly: mc-plan 1 (it is “${json.slice(0, 40)}…”).`,
    ]);
  });

  it("checks the whole text first: a curly bracket hides every other problem", () => {
    const text = edit((l) => [...l.map((x) => (x.startsWith("title") ? "title: `bad`" : x)), "oops {"]);
    expect(problemsOf(text)).toHaveLength(1);
    expect(problemsOf(text)[0]).toMatch(/^The plan has a curly bracket on line 11\./);
  });

  it("cuts a text quoted in a message at 40 characters, and shows a hidden character by its code", () => {
    const noCheck = (id: string): string => edit(replaceLine("feature: hello", `feature: ${id}`), SMALL.filter((l) => !l.startsWith("check")));
    expect(problemsOf(noCheck("x".repeat(50)))).toEqual([`Feature 1 (“${"x".repeat(40)}…”) needs 1 to 20 “check” lines (it has 0).`]);
    expect(problemsOf(noCheck("x".repeat(40)))).toEqual([`Feature 1 (“${"x".repeat(40)}”) needs 1 to 20 “check” lines (it has 0).`]);
    expect(problemsOf(noCheck("ab\u202Ecd"))[1]).toBe("Feature 1 (“ab<U+202E>cd”) needs 1 to 20 “check” lines (it has 0).");
    expect(problemsOf(edit(replaceLine("mc-plan 1", `mc-plan\u200B ${"y".repeat(60)}`)))[0]).toBe(
      `The first line of the plan must be exactly: mc-plan 1 (it is “mc-plan<U+200B> ${"y".repeat(31)}…”).`,
    );
  });

  it("lists every problem in the order of the lines, then the plan as a whole, then the planner's own checks last", () => {
    const text = edit((l) => [...l.map((x) => (x === "summary: Says hello." ? "colour: blue" : x)), "name: Twice", "check: ok"]);
    expect(problemsOf(text).map((p) => p.slice(0, 40))).toEqual([
      "Line 5: “colour” is not a key that can b",
      "Line 11: “name” is about the whole plan,",
      "“summary” is missing. Add a line that st",
    ]);
    // the planner's checks (V22) are only run when nothing else is wrong
    const cycle = edit(replaceLine("feature: hello", "feature: Hello World"), SMALL.filter((l) => !l.startsWith("summary")));
    expect(problemsOf(cycle)).toEqual(["“summary” is missing. Add a line that starts with “summary:”."]);
  });
});

// ───────────────────────────── Limits ─────────────────────────────

describe("every limit, at its edge and one over", () => {
  const long = (n: number): string => `W${"a".repeat(n - 1)}`;

  it.each([
    ["name", 60, "name: Hello", (v: string) => `name: ${v}`],
    ["request", 1000, "request: Say hello.", (v: string) => `request: ${v}`],
    ["app-name", 60, "app-name: Hello app", (v: string) => `app-name: ${v}`],
    ["summary", 400, "summary: Says hello.", (v: string) => `summary: ${v}`],
    ["title", 80, "title: Say hello", (v: string) => `title: ${v}`],
    ["story", 400, "story: As a user I am greeted.", (v: string) => `story: ${v}`],
    ["check", 300, "check: The page shows Hello.", (v: string) => `check: ${v}`],
    ["feature id", 60, "feature: hello", (v: string) => `feature: ${v.toLowerCase()}`],
  ])("%s: %i characters pass and one more is refused", (_key, max, from, to) => {
    expect(parsePlan(edit(replaceLine(from as string, (to as (v: string) => string)(long(max as number))))).ok).toBe(true);
    const over = parsePlan(edit(replaceLine(from as string, (to as (v: string) => string)(long((max as number) + 1)))));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.problems[0]).toContain(`it is longer than ${(max as number) === 1000 ? "1,000" : max} characters`);
  });

  it.each([
    ["assumption", 10, 300],
    ["contract", 40, 300],
  ])("%s: %i lines and %i characters pass, one more of either is refused", (key, lines, chars) => {
    const make = (n: number, len: number): string => edit(addAfter("summary: Says hello.", ...Array.from({ length: n }, () => `${key}: ${long(len)}`)));
    expect(parsePlan(make(lines as number, chars as number)).ok).toBe(true);
    expect(parsePlan(make((lines as number) + 1, chars as number)).ok).toBe(false);
    expect(parsePlan(make(1, (chars as number) + 1)).ok).toBe(false);
  });

  it("allows ten features, twenty checks in a feature, and nine needs", () => {
    const features = Array.from({ length: 10 }, (_, i) => [`feature: part-${i}`, `title: Part ${i}`, `story: Part ${i}.`, ...Array.from({ length: 20 }, (_c, c) => `check: Check ${c}.`), ""]).flat();
    const text = ["mc-plan 1", "name: Big", "request: Do a lot.", "app-name: Big", "summary: A lot.", "", ...features].join("\n");
    expect(accepted(text).spec.features).toHaveLength(10);
    const needs = ["mc-plan 1", "name: N", "request: N.", "app-name: N", "summary: N.", "", ...Array.from({ length: 10 }, (_, i) => [`feature: f-${i}`, `title: F ${i}`, `story: F ${i}.`, ...(i === 9 ? [`needs: ${Array.from({ length: 9 }, (_n, d) => `f-${d}`).join(", ")}`] : []), "check: Works.", ""]).flat()].join("\n");
    expect(accepted(needs).spec.features[9]?.deps).toHaveLength(9);
  });

  it("counts the 30,000 characters of the whole text: that many pass, one more is refused", () => {
    const pad = (n: number): string => `${ONE}${" ".repeat(n - ONE.length)}`;
    expect(pad(PLAN_MAX_CHARS).length).toBe(PLAN_MAX_CHARS);
    expect(parsePlan(pad(PLAN_MAX_CHARS)).ok).toBe(true);
    expect(problemsOf(pad(PLAN_MAX_CHARS + 1))).toEqual(["The plan is too long (more than 30,000 characters). Shorten it, or split the work into two plans."]);
  });
});

// ───────────────────────────── The line reader ─────────────────────────────

describe("the line reader", () => {
  const code = accepted(ONE).code;

  it("is not changed by CRLF line ends, a byte-order mark, indented lines or blank lines anywhere", () => {
    expect(accepted(ONE.replace(/\n/g, "\r\n")).code).toBe(code);
    expect(accepted(`\uFEFF${ONE}`).code).toBe(code);
    expect(accepted(ONE.replace(/^(check|contract|assumption)/gm, "    $1").replace(/\n/g, "\t \n")).code).toBe(code);
    expect(accepted(ONE.replace("mc-plan 1\n", "mc-plan 1\n\n\n").replace(/\n(?=feature)/g, "\n\n\n").replace(/\n(?=check)/g, "\n \n")).code).toBe(code);
  });

  it("takes the key from before the first colon: a colon in a text and no space after the colon are fine", () => {
    const parsed = accepted(edit(replaceLine("check: The page shows Hello.", "check:Books read: 0")));
    expect(parsed.spec.features[0]?.acceptance).toEqual(["Books read: 0"]);
  });

  it("does not show what a plan read from a file starts with, and still does for one that was sent in", () => {
    const text = "API_KEY=abc123\nname: Hello";
    expect(parsePlan(text).ok).toBe(false);
    expect(problemsOf(text)[0]).toBe("The first line of the plan must be exactly: mc-plan 1 (it is “API_KEY=abc123”).");
    const fromFile = parsePlan(text, { quoteFirstLine: false });
    expect(fromFile.ok === false && fromFile.problems[0]).toBe("The first line of the plan must be exactly: mc-plan 1.");
  });

  it("refuses the Mongolian free variation selector, which is invisible", () => {
    expect(problemsOf(edit(replaceLine("check: The page shows Hello.", "check: The page shows Hello\u180F."))).length).toBeGreaterThan(0);
  });

  it("reads a line with a long run of spaces in linear time", () => {
    const started = Date.now();
    problemsOf(edit(replaceLine("check: The page shows Hello.", `check: The page${" ".repeat(20000)}shows Hello.`)));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("refuses a first line that is not exactly mc-plan 1, and a blank line before it", () => {
    expect(problemsOf(`\n${ONE}`)[0]).toBe("The first line of the plan must be exactly: mc-plan 1 (it is “”).");
    expect(problemsOf(ONE.replace("mc-plan 1", "MC-PLAN 1"))[0]).toContain("it is “MC-PLAN 1”");
  });

  it.each(["Summary", "NAME", "constructor", "toString", "hasOwnProperty", "valueOf", "__proto__", "x-y_z"])("never finds the key %s by property access: it is refused", (key) => {
    const problems = problemsOf(edit(addAfter("summary: Says hello.", `${key}: boom`)));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^Line 6( is not a “key: value” line|: “.+” is not a key that can be used)/);
  });

  it("refuses a key in the wrong part: a feature key before the first feature, a plan key after it", () => {
    for (const line of ["title: T", "story: S", "kind: mechanical", "needs: a", "check: C"]) {
      expect(problemsOf(edit(addAfter("summary: Says hello.", line)))).toEqual([`Line 6: “${line.split(":")[0]}” belongs to a feature, so it goes after a “feature” line.`]);
    }
    for (const line of ["name: N", "request: R", "folder: f", "base: b", "app-name: A", "summary: S", "assumption: A", "contract: C"]) {
      expect(problemsOf(edit(addAtEnd(line)))).toEqual([`Line 11: “${line.split(":")[0]}” is about the whole plan, so it goes before the first “feature” line.`]);
    }
  });

  it("refuses each single-use key given twice, in the plan and inside a feature", () => {
    const withApp = ["mc-plan 1", "name: Hello", "request: Say hello.", "folder: app", "base: main", "app-name: Hello app", "summary: Says hello.", "", "feature: hello", "title: Say hello", "story: As a user I am greeted.", "check: The page shows Hello."];
    const second = (n: number, key: string): string => `Line ${n}: “${key}” is given a second time. It can be given only once.`;
    expect(problemsOf(edit(addAfter("name: Hello", "name: Again"), withApp))).toEqual([second(3, "name")]);
    expect(problemsOf(edit(addAfter("request: Say hello.", "request: Again."), withApp))).toEqual([second(4, "request")]);
    expect(problemsOf(edit(addAfter("folder: app", "folder: other"), withApp))).toEqual([second(5, "folder")]);
    expect(problemsOf(edit(addAfter("base: main", "base: dev"), withApp))).toEqual([second(6, "base")]);
    expect(problemsOf(edit(addAfter("app-name: Hello app", "app-name: Again"), withApp))).toEqual([second(7, "app-name")]);
    expect(problemsOf(edit(addAfter("summary: Says hello.", "summary: Again."), withApp))).toEqual([second(8, "summary")]);
    const inside = (...more: string[]): string[] => problemsOf(edit(addAtEnd(...more), withApp)).filter((p) => p.includes("second time"));
    const where = (n: number, key: string): string => `Line ${n}: “${key}” is given a second time in feature 1 (“hello”). It can be given only once.`;
    expect(inside("title: Two")).toEqual([where(13, "title")]);
    expect(inside("story: Two.")).toEqual([where(13, "story")]);
    expect(inside("kind: standard", "kind: mechanical")).toEqual([where(14, "kind")]);
    expect(inside("needs: other", "needs: another")).toEqual([where(14, "needs")]);
  });

  it("lets assumption, contract and check repeat, in the order written", () => {
    const parsed = accepted(edit(addAtEnd("check: Second.", "check: Third.")));
    expect(parsed.spec.features[0]?.acceptance).toEqual(["The page shows Hello.", "Second.", "Third."]);
  });

  it("refuses a line that is a lone carriage return inside a text", () => {
    expect(problemsOf(edit(replaceLine("check: The page shows Hello.", "check: One\rTwo")))[0]).toContain("it has a character that cannot be seen");
  });

  it("has no line in any accepted plan that could end the here-document early", () => {
    for (const text of [ONE, THREE, ...["slugify.txt", "shout.txt", "whisper.txt"].map(fixture)]) {
      expect(text.split("\n").filter((l) => l.trim() === "PLAN")).toEqual([]);
    }
    // a line of the plan cannot be the line PLAN: it has no key and no colon
    expect(problemsOf(edit(addAfter("summary: Says hello.", "PLAN")))[0]).toMatch(/^Line 6 is not a “key: value” line/);
  });
});

// ───────────────────────────── Plain words ─────────────────────────────

describe("plain words", () => {
  const places: [name: string, make: (v: string) => string, from: string][] = [
    ["a title", (v) => `title: ${v}`, "title: Say hello"],
    ["a story", (v) => `story: ${v}`, "story: As a user I am greeted."],
    ["a check", (v) => `check: ${v}`, "check: The page shows Hello."],
    ["a contract line", (v) => `contract: ${v}`, ""],
  ];
  const plan = (make: (v: string) => string, from: string, value: string): string =>
    from === "" ? edit(addAfter("summary: Says hello.", make(value))) : edit(replaceLine(from, make(value)));
  const refusedStarts = ["#", "-", '"', "*", "(", "“", " "];

  it.each(places)("refuses what hides text or breaks the structure in %s", (_name, make, from) => {
    const bad = ["a\tb", "a\u200Bb", "a\u202Eb", "a\u00ADb", "a `b`", "see https://x", "a\u00A0b", "a\u3000b", "a\u2028b", "a\u0000b", "a\u007Fb", "a\u0085b"];
    for (const value of bad) expect(parsePlan(plan(make, from, value)).ok, JSON.stringify(value)).toBe(false);
    for (const start of refusedStarts.filter((s) => s !== " ")) expect(parsePlan(plan(make, from, `${start}Hello`)).ok, start).toBe(false);
  });

  it("accepts the request starting with any character, the CEO's own words", () => {
    for (const start of ['"', "#", "-", "“", "(", "1"]) expect(parsePlan(edit(replaceLine("request: Say hello.", `request: ${start}Say hello`))).ok, start).toBe(true);
    expect(parsePlan(edit(replaceLine("request: Say hello.", "request: `Say` hello"))).ok).toBe(false);
  });

  it.each([
    ["U+FE0F", "a\uFE0F"],
    ["U+E0100", "a\u{E0100}"],
    ["U+3164", "a\u3164b"],
    ["U+115F", "a\u115Fb"],
    ["U+FFA0", "a\uFFA0b"],
    ["U+2800", "a\u2800b"],
    ["U+034F", "a\u034Fb"],
    ["U+17B4", "a\u17B4b"],
    ["U+180B", "a\u180Bb"],
    ["a lone surrogate", "a\uD800b"],
    ["a private use character", "a\uE000b"],
    ["an unassigned character", "a\u0378b"],
    ["50 stacked marks", `e${"\u0301".repeat(50)}`],
    ["three marks", "e\u0301\u0302\u0303"],
    ["a mark after a space", "a \u0301b"],
    ["a mark at the start of the value", "\u0301Hello"],
  ])("refuses %s", (_name, value) => {
    const problems = problemsOf(edit(replaceLine("check: The page shows Hello.", `check: Hello ${value}`)));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("it has a character that cannot be seen");
  });

  it.each([
    ["accents as one letter", "Café déjà vu"],
    ["accents as a letter and a mark", "Cafe\u0301 de\u0301ja\u0300 vu"],
    ["a Vietnamese letter with two marks", "Việt Nam"],
    ["Vietnamese with two marks as separate marks", "Vie\u0323\u0302t"],
    ["Hindi", "ह\u093Fन\u094Dद\u0940 भ\u093Eष\u093E"],
    ["Thai", "ภาษาไทย"],
    ["Cyrillic", "Привет мир"],
    ["an apostrophe", "It doesn't crash and the user's list stays."],
    ["a curly quote", "The label says “Add book” and it’s there."],
    ["a backslash alone", "The pattern is \\d and then \\p."],
    ["a colon and a slash", "The page /books shows Books read: 0."],
    ["a number first", "3 books are shown."],
    ["a dollar sign and brackets", "The cost is $5 (about) [five] <tag>."],
  ])("accepts %s", (_name, value) => {
    expect(parsePlan(edit(replaceLine("check: The page shows Hello.", `check: ${value}`))).ok).toBe(true);
  });

  it.each([
    ["\\'", "It says don\\'t."],
    ['\\"', 'It says \\"hi\\".'],
    ["the '\\'' slip", "The user'\\''s list stays."],
  ])("refuses a backslash before a quote mark: %s", (_name, value) => {
    const problems = problemsOf(edit(replaceLine("check: The page shows Hello.", `check: ${value}`)));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("it has a backslash before a quote mark");
  });

  it("refuses a curly bracket anywhere: in a value, in a key line, in the request, as a key", () => {
    for (const text of [
      edit(replaceLine("check: The page shows Hello.", "check: A { b")),
      edit(replaceLine("check: The page shows Hello.", "check: A } b")),
      edit(replaceLine("request: Say hello.", "request: Say {hello}.")),
      edit(addAfter("summary: Says hello.", "{key: value}")),
      edit(addAfter("summary: Says hello.", "k{ey: value")),
    ]) {
      const problems = problemsOf(text);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^The plan has a curly bracket on line \d+\./);
    }
  });

  it("names the reasons in the order: empty, long, hidden, backtick, address, backslash, start", () => {
    const reason = (value: string): string => (problemsOf(edit(replaceLine("check: The page shows Hello.", `check: ${value}`)))[0] ?? "").split("can't be used: ")[1]?.split(". Use plain")[0] ?? "";
    expect(reason("")).toBe("it is empty");
    expect(reason(`${"a".repeat(301)}\u200B`)).toBe("it is longer than 300 characters");
    expect(reason("`a`\u200B")).toBe("it has a character that cannot be seen");
    expect(reason("`a` https://x")).toBe("it has a backtick");
    expect(reason("see https://x \\'")).toBe("it has a web address");
    expect(reason("-x \\'")).toBe("it has a backslash before a quote mark");
    expect(reason("-x")).toBe("it does not start with a letter or a number");
  });
});

// ───────────────────────────── Ids ─────────────────────────────

describe("feature ids", () => {
  it("allows an id that only looks like one the engine keeps for its own repair work", () => {
    expect(parsePlan(edit(replaceLine("feature: hello", "feature: gate-c-fixer"))).ok).toBe(true);
    expect(parsePlan(edit(replaceLine("feature: hello", "feature: owner-changes"))).ok).toBe(true);
  });
});

// ───────────────────────────── The plan code ─────────────────────────────

describe("the plan code", () => {
  const code = accepted(ONE).code;

  it("changes with one changed character, and with the order of features or of one repeated key", () => {
    expect(accepted(ONE.replace("Dark mode switch", "Dark mode switcH")).code).not.toBe(code);
    expect(accepted(ONE.replace("check: Turning the switch on makes", "check: Turning the switch on make")).code).not.toBe(code);
    expect(accepted(ONE.replace("name: Dark mode", "name: Dark mod")).code).not.toBe(code);
    const swapped = ONE.replace(/(contract: .*\n)(contract: .*\n)/, "$2$1");
    expect(accepted(swapped).code).not.toBe(code);
    const features = THREE.split("\n\nfeature:");
    const reordered = [features[0], features[2]?.replace(/needs: .*\n/, ""), features[1]?.replace(/needs: .*\n/, "")].join("\n\nfeature:");
    expect(accepted(reordered).code).not.toBe(accepted(THREE).code);
  });

  it("stays the same when only spaces, blank lines, line ends or the order of lines inside a block change", () => {
    const reorderedBlock = ONE.replace(/(title: .*\n)(story: .*\n)/, "$2$1");
    expect(accepted(reorderedBlock).code).toBe(code);
    const reorderedHead = ONE.replace(/(name: .*\n)(request: .*\n)/, "$2$1");
    expect(accepted(reorderedHead).code).toBe(code);
    expect(accepted(ONE.replace(/: /g, ":    ")).code).toBe(code);
  });

  it("is the first 8 characters of the SHA-256 of the fixed written form, which the plan keeps", () => {
    const parsed = accepted(THREE);
    expect(planCode(parsed.envelope, parsed.spec)).toBe("c5b7a589");
    expect(canonicalText(parsed.envelope, parsed.spec)).toBe(THREE.replace(/\n\n/g, "\n"));
    expect(canonicalText(accepted(ONE).envelope, accepted(ONE).spec)).toBe(ONE.replace(/\n\n/g, "\n"));
  });

  it("writes kind only when mechanical, and needs with a comma and a space", () => {
    const text = edit(addAtEnd("", "feature: second", "title: Second", "story: The second.", "kind: mechanical", "needs:hello", "check: Works.", "", "feature: third", "title: Third", "story: The third.", "needs: hello,second", "check: Works."));
    const parsed = accepted(text);
    const written = canonicalText(parsed.envelope, parsed.spec);
    expect(written).toContain("feature: second\ntitle: Second\nstory: The second.\nkind: mechanical\nneeds: hello\ncheck: Works.\n");
    expect(written).toContain("feature: third\ntitle: Third\nstory: The third.\nneeds: hello, second\ncheck: Works.\n");
    expect(written.match(/kind:/g)).toHaveLength(1);
    expect(written.endsWith("\n")).toBe(true);
    expect(written).not.toMatch(/\n\n/);
  });
});

// ───────────────────────────── The plan in words ─────────────────────────────

describe("describePlan", () => {
  const ten: SpecOutput = {
    appName: "Big app",
    summary: "Does a lot.",
    assumptions: ["A choice."],
    uiContract: "- Name one.\n- Name two.",
    features: Array.from({ length: 10 }, (_, i) => ({
      id: `part-${i}`,
      title: `Part ${i}`,
      story: `Story ${i}.`,
      acceptance: Array.from({ length: 20 }, (_c, c) => `Part ${i} check ${c} ${"word ".repeat(70)}end`),
      kind: i % 2 === 0 ? ("mechanical" as const) : ("standard" as const),
      deps: i === 0 ? [] : [`part-${i - 1}`],
    })),
  };

  it("writes example 1 in words, as the preview prints it", () => {
    const parsed = accepted(ONE);
    expect(describePlan(parsed.spec, { request: parsed.envelope.request, style: "text" })).toEqual([
      "You asked: On the settings page of the habit tracker, add a Dark mode switch. It should remember my choice.",
      "App name: Habit tracker",
      "Summary: Adds a Dark mode switch to the settings page. The page turns dark when it is on, and the choice is remembered.",
      "",
      "1 feature:",
      "",
      "1. “Dark mode switch on the settings page” (id: dark-mode)",
      "   As a user I can switch the app to dark colours on the settings page, and it stays that way when I come back.",
      "   It counts as done when:",
      "   - The settings page shows a switch labelled Dark mode, and it is off by default.",
      "   - Turning the switch on makes the page background dark.",
      "   - Turning the switch off makes the page background light again.",
      "   - After the switch is turned on and the page is reloaded, the switch is still on and the page is dark.",
      "   - After the switch is turned off and the page is reloaded, the switch is off and the page is light.",
      "",
      "Choices made for you:",
      "- The switch is off until the person turns it on, and the choice is kept for that person on the same device.",
      "",
      "Names the tests and the code must agree on:",
      "- The switch is on the settings page and its label is Dark mode.",
      "- The switch has the test id dark-mode-switch.",
    ]);
  });

  it("says what a feature needs first and when it is routine work, and where a new app will go", () => {
    const parsed = accepted(edit(addAfter("story: As a user I am greeted.", "kind: mechanical"), SMALL));
    const lines = describePlan(parsed.spec, { request: "Say hello.", style: "text", newApp: true });
    expect(lines).toContain("App name: Hello app (the new app goes in a new folder called hello-app, or the next free name)");
    expect(lines).toContain("   Marked as routine work: the team tries its lightest AI first and moves up if the checks fail.");
    const three = describePlan(accepted(THREE).spec, { request: "x", style: "text" });
    expect(three).toContain("3 features:");
    expect(three).toContain("   Needs first: “Add a book to the list”.");
    expect(three).toContain("   Needs first: “Mark a book as read”.");
  });

  it("gives the owner's look one self-contained line for each fact", () => {
    const parsed = accepted(THREE);
    const lines = describePlan(parsed.spec, { request: parsed.envelope.request, style: "look" });
    expect(lines).toContain("The plan has 3 features: “Add a book to the list”, “Mark a book as read”, “Count of books read”.");
    expect(lines).toContain("“Mark a book as read” (id: mark-read): As a reader I can mark a book as read, so I can tell it apart from the books I have not read.");
    expect(lines).toContain("Check for “Count of books read”: With no books the page shows Books read: 0.");
    expect(lines).toContain("Needs first for “Mark a book as read”: “Add a book to the list”.");
    expect(lines).toContain("Choice made for you: A book with no title is not added.");
    expect(lines).toContain("Name the tests and the code must agree on: The page title is Reading list.");
    for (const f of parsed.spec.features) for (const c of f.acceptance) expect(lines).toContain(`Check for “${f.title}”: ${c}`);
    expect(lines.every((l) => l === l.trim())).toBe(true);
  });

  it("shows each feature's id next to its title, in the command's text and in the owner's look, so the owner can see what reaches the AIs and the branch names", () => {
    const parsed = accepted(THREE);
    const text = describePlan(parsed.spec, { request: parsed.envelope.request, style: "text" });
    expect(text).toContain("1. “Add a book to the list” (id: add-book)");
    expect(text).toContain("2. “Mark a book as read” (id: mark-read)");
    expect(text).toContain("3. “Count of books read” (id: read-count)");
    const look = describePlan(parsed.spec, { request: parsed.envelope.request, style: "look" });
    expect(look).toContain("“Add a book to the list” (id: add-book): As a reader I can add a book with its title and author and see it in my list.");
    expect(look).toContain("“Mark a book as read” (id: mark-read): As a reader I can mark a book as read, so I can tell it apart from the books I have not read.");
    expect(look).toContain("“Count of books read” (id: read-count): As a reader I can see how many of my books I have read.");
    // a plan the planner wrote or revised shows its ids the same way; a feature with no id (damaged file) shows none
    const noId = { ...parsed.spec, features: parsed.spec.features.map((f, i) => (i === 0 ? { ...f, id: "" } : f)) };
    expect(describePlan(noId, { request: "x", style: "text" })).toContain("1. “Add a book to the list”");
    expect(describePlan(noId, { request: "x", style: "look" })).toContain("“Add a book to the list”: As a reader I can add a book with its title and author and see it in my list.");
  });

  it("wraps a fact of 700 characters in the owner's look into lines that each start with the fact's lead again, and loses nothing", () => {
    const long = "abcdef ".repeat(100).trim(); // 699 characters
    const spec: SpecOutput = {
      appName: "Big check app",
      summary: long,
      assumptions: [long],
      uiContract: `- ${long}`,
      features: [{ id: "big-check", title: "Big check", story: long, acceptance: [long, "A short check."], kind: "standard", deps: [] }],
    };
    const look = describePlan(spec, { request: long, style: "look" });
    expect(look.every((l) => l.length <= 280)).toBe(true);
    const checks = look.filter((l) => l.startsWith("Check for “Big check”: "));
    expect(checks.length).toBeGreaterThanOrEqual(3 + 1); // the long check in at least three lines, and the short one
    expect(checks.at(-1)).toBe("Check for “Big check”: A short check.");
    expect(checks.slice(0, -1).map((l) => l.slice("Check for “Big check”: ".length)).join(" ")).toBe(long);
    // every other fact repeats its lead the same way
    for (const lead of ["You asked: ", "Summary: ", "“Big check” (id: big-check): ", "Choice made for you: ", "Name the tests and the code must agree on: "]) {
      const parts = look.filter((l) => l.startsWith(lead));
      expect(parts.length, lead).toBeGreaterThanOrEqual(3);
      expect(parts.map((l) => l.slice(lead.length)).join(" "), lead).toBe(long);
    }
    // for the command line the lead is not repeated: the lines are indented, and each fact is one item
    const text = describePlan(spec, { request: long, style: "text" });
    expect(text.some((l) => l.includes("Check for"))).toBe(false);
    expect(text.every((l) => l.length <= 280)).toBe(true);
  });

  it("keeps a very long title whole, with no line over the limit, and never loops", () => {
    const title = "T".repeat(150) + " " + "u".repeat(150);
    const check = "word ".repeat(120).trim();
    const spec: SpecOutput = { appName: "A", summary: "S", assumptions: [], uiContract: "", features: [{ id: "long-title", title, story: "s", acceptance: [check], kind: "standard", deps: [] }] };
    const look = describePlan(spec, { request: "x", style: "look" });
    expect(look.every((l) => l.length <= 300)).toBe(true);
    const flat = look.join(" ");
    expect(flat).toContain("T".repeat(150));
    expect(flat.match(/word/g)).toHaveLength(120);
  });

  it.each(["text", "look"] as const)("keeps every check, contract line, need, the app name and the routine mark of a ten-feature, twenty-check plan, in %s style, in lines of at most 300 characters", (style) => {
    const lines = describePlan(ten, { request: "Do it.", style });
    const joined = lines.join("\n");
    expect(lines.every((l) => l.length <= 300)).toBe(true);
    expect(joined).toContain("Big app");
    expect(joined).toContain("Name two.");
    expect(joined.match(/routine work/g)).toHaveLength(5);
    expect(joined.match(/Needs first/g)).toHaveLength(9);
    // every check is there, whole: the wrapped parts, put back together, are the check (in the look every part starts with its lead again)
    const rejoined = style === "look" ? joined.replace(/\nCheck for “[^”]*”: /g, " ") : joined.replace(/\n\s*(- )?/g, " ");
    for (const f of ten.features) {
      for (const c of f.acceptance.slice(0, 3)) {
        const words = c.split(" ");
        expect(rejoined).toContain(words.join(" "));
      }
    }
  });

  it.each(["slugify", "shout", "whisper"])("takes the real planner spec %s raw: nothing is cut and nothing throws", (name) => {
    const raw = JSON.parse(fixture(`${name}.raw.json`)) as { request: string; spec: SpecOutput };
    for (const style of ["text", "look"] as const) {
      const lines = describePlan(raw.spec, { request: raw.request, style });
      expect(lines.every((l) => l.length <= 300)).toBe(true);
      const flat = lines.join(" ").replace(/\s+/g, " ");
      for (const f of raw.spec.features) for (const c of f.acceptance) expect(flat).toContain(c.replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" "));
      // the contract is one string of many lines in the planner's plans; every line of it is there, without its list marker
      const contract = raw.spec.uiContract.split("\n").map((l) => l.replace(/\s+/g, " ").trim().replace(/^[-*•]\s+/, "")).filter((l) => l !== "");
      for (const line of contract) expect(flat).toContain(line.split(" ").slice(0, 6).join(" "));
    }
    // backticks and curly brackets are shown as they are
    expect(JSON.stringify(raw)).toMatch(/`/);
  });

  it("copes with damaged text: a missing field is an empty text, not a crash", () => {
    const damaged = { appName: undefined, summary: 5, features: [{ id: "a", title: undefined, story: null, acceptance: undefined, kind: "standard", deps: undefined }], assumptions: undefined, uiContract: undefined } as unknown as SpecOutput;
    expect(() => describePlan(damaged, { request: "x", style: "text" })).not.toThrow();
    expect(() => describePlan(damaged, { request: "x", style: "look" })).not.toThrow();
  });
});

describe("wrapLine", () => {
  it("leaves a short line alone and breaks a long one at spaces into lines of at most the width", () => {
    expect(wrapLine("short")).toEqual(["short"]);
    expect(wrapLine("")).toEqual([""]);
    const lines = wrapLine("word ".repeat(100).trim(), 50);
    expect(lines.every((l) => l.length <= 50)).toBe(true);
    expect(lines.join(" ")).toBe("word ".repeat(100).trim());
  });

  it("splits a word longer than a line, and keeps a character of two code units whole", () => {
    const lines = wrapLine(`start ${"x".repeat(25)} end`, 10);
    expect(lines.every((l) => l.length <= 10)).toBe(true);
    expect(lines.join("").replace(/ /g, "")).toBe(`start${"x".repeat(25)}end`);
    const emoji = wrapLine("😀".repeat(10), 5);
    expect(emoji.join("")).toBe("😀".repeat(10));
    expect(emoji.every((l) => !/[\uD800-\uDBFF]$/.test(l))).toBe(true);
  });
});

describe("wrapFact", () => {
  it("is the lead, a space and the words when they fit", () => {
    expect(wrapFact("Check for “A”:", "It works.")).toEqual(["Check for “A”: It works."]);
    expect(wrapFact("Check for “A”:", "")).toEqual(["Check for “A”: "]);
  });

  it("starts every line with the lead, in lines of at most the width, and the words put back together are the words", () => {
    const body = "word ".repeat(100).trim();
    const lines = wrapFact("Lead:", body, 120);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((l) => l.startsWith("Lead: ") && l.length <= 120)).toBe(true);
    expect(lines.map((l) => l.slice("Lead: ".length)).join(" ")).toBe(body);
  });

  it("does not repeat a lead that leaves too little room: the whole text is wrapped as one", () => {
    const lead = `${"L".repeat(150)}:`;
    const body = "word ".repeat(60).trim();
    const lines = wrapFact(lead, body, 200);
    expect(lines.every((l) => l.length <= 200)).toBe(true);
    expect(lines[0]?.startsWith(lead)).toBe(true);
    expect(lines.slice(1).some((l) => l.startsWith("L"))).toBe(false);
    expect(lines.join(" ")).toBe(`${lead} ${body}`);
  });
});

describe("reviewLines", () => {
  it("says nothing before gate A has run and nothing was sent back", () => {
    expect(reviewLines(undefined, 0)).toEqual([]);
  });

  it("gives the plan reviewer's answer for each outcome", () => {
    expect(reviewLines({ outcome: "approved", issues: [] }, 0)).toEqual(["The team's plan reviewer read it and asked for no changes."]);
    expect(reviewLines({ outcome: "revised", issues: ["Add a check for empty input.", "Name the label."] }, 0)).toEqual([
      "The team's plan reviewer asked for changes, so the team's planner revised the plan. This is the revised plan. It asked: Add a check for empty input. Name the label.",
    ]);
    expect(reviewLines({ outcome: "not_applied", issues: ["a", "b", "c", "d", "e"] }, 0)).toEqual([
      "The team's plan reviewer asked for changes that could not be applied, so the plan is as the leader wrote it. It asked: a; b; c and 2 more.",
    ]);
    expect(reviewLines({ outcome: "unfinished", issues: [] }, 0)).toEqual(["The team's plan reviewer did not finish, so the plan is as the leader wrote it."]);
  });

  it("adds the owner's send-backs from the count, once, twice, and more", () => {
    expect(reviewLines({ outcome: "approved", issues: [] }, 1)).toEqual([
      "The team's plan reviewer read it and asked for no changes.",
      "You sent the plan back once. This is the plan as it stands now.",
    ]);
    expect(reviewLines(undefined, 2)).toEqual(["You sent the plan back twice. This is the plan as it stands now."]);
    expect(reviewLines(undefined, 3)).toEqual(["You sent the plan back 3 times. This is the plan as it stands now."]);
  });

  it("cuts nothing of a long answer: the lines are wrapped", () => {
    const lines = reviewLines({ outcome: "revised", issues: ["w ".repeat(140).trim(), "x ".repeat(140).trim()] }, 0);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length <= 300)).toBe(true);
  });
});
