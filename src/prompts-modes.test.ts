import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { feature, mission, oldWayPrompts, SPEC } from "../test/fixtures/modes/prompt-inputs.js";
import { gateAPrompt, gateCPrompt, loadRolePrompt, loadVariantPrompt, makePrompt, packageRoot, reportProsePrompt, rubricPrompt, specPrompt } from "./prompts.js";
import type { Feature, Mission, Spec } from "./types.js";

const GOLDEN_DIR = join(import.meta.dirname, "..", "test", "fixtures", "modes", "prompts");
/** A long dash (two kinds), a zero-width or direction-changing mark, or a byte order mark: none may be in a prompt. */
const HIDDEN_OR_LONG_DASH = new RegExp(`[${[0x2013, 0x2014, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0xfeff].map((c) => String.fromCodePoint(c)).join("")}]`, "u");

// ───────────────────────────── A mission with no mode feature: every prompt is the text of the end of wave 1 (spec 15, item 4) ─────────────────────────────

describe("the prompts of a mission with no mode feature", () => {
  const now = oldWayPrompts();

  it("have a golden text for every prompt, and no other", () => {
    expect(readdirSync(GOLDEN_DIR).map((f) => f.replace(/\.txt$/, "")).sort()).toEqual(Object.keys(now).sort());
  });

  it.each(Object.keys(now))("%s is exactly the text of the end of wave 1", (name) => {
    expect(now[name]).toBe(readFileSync(join(GOLDEN_DIR, `${name}.txt`), "utf8"));
  });
});

// ───────────────────────────── The two prompt files (spec 8.1 and 8.2) ─────────────────────────────

/** The first fenced block after the heading that starts with `heading`, in the design document. */
function blockAfter(doc: string, heading: string): string {
  const at = doc.indexOf(heading);
  expect(at, heading).toBeGreaterThanOrEqual(0);
  const match = /```\n([\s\S]*?)\n```/.exec(doc.slice(at));
  expect(match, `the block after ${heading}`).not.toBeNull();
  return match![1]!;
}

describe("prompts/maker.md and prompts/checker.md", () => {
  const spec = readFileSync(join(packageRoot(), "docs", "modes-spec.md"), "utf8");
  const files = { maker: loadVariantPrompt("maker"), checker: loadVariantPrompt("checker") };
  // Written with a bracket in each word so that this file does not hold the words it forbids.
  const timeOfDay = /n[i]ght|mor[n]ing/i;

  it.each(["maker", "checker"] as const)("%s is the block of the design document", (name) => {
    expect(files[name]).toBe(blockAfter(spec, name === "maker" ? "### 8.1 " : "### 8.2 ").trim());
  });

  it.each(["maker", "checker"] as const)("%s is concise, provider-neutral and calm, like the other role prompts", (name) => {
    const text = files[name];
    expect(text.startsWith("# Role:")).toBe(true);
    expect(text.split("\n").length).toBeLessThanOrEqual(65);
    expect(text).not.toMatch(/claude|codex|gpt|anthropic|openai|opus|sonnet|haiku/i);
    const shouting = (text.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !["JSON", "HTTP", "HTML", "AGENTS", "CRUD", "README"].includes(w));
    expect(shouting).toEqual([]);
    expect(text.replace(/midn[i]ght/gi, "")).not.toMatch(timeOfDay);
    expect(text).not.toMatch(HIDDEN_OR_LONG_DASH);
  });

  it("hold their key sentences", () => {
    expect(files.maker).toContain("A text value never starts with =, +, - or @, or with a tab, because a spreadsheet may run it as a formula.");
    expect(files.maker).toContain("Set `testDispute` to null.");
    expect(files.maker).toContain("Never invent names, numbers, quotes, links or file names.");
    expect(files.checker).toContain("`basis`: `text` when your judgement rests on the words of the files, `picture` when it rests on a picture you opened.");
    expect(files.checker).toContain("`cannot_judge`");
    expect(files.checker).toContain("Quotes must be exact.");
  });

  it("are not the prompts of the five roles", () => {
    for (const role of ["architect", "engineer", "test_author", "reviewer", "scout"] as const) {
      expect(loadRolePrompt(role)).not.toBe(files.maker);
      expect(loadRolePrompt(role)).not.toBe(files.checker);
    }
  });

  it("loadVariantPrompt refuses any other name, so a path can never be built from one", () => {
    for (const name of ["engineer", "reviewer", "../package", "maker.md", "", "MAKER"]) expect(() => loadVariantPrompt(name as never)).toThrow(/Unknown prompt/);
  });
});

// ───────────────────────────── The builder's brief ─────────────────────────────

const checked = (overrides: Partial<Feature> = {}): Feature =>
  feature({
    id: "setup-guide",
    title: "Setup guide",
    story: "As a new user I can follow a short guide.",
    acceptance: ["The guide is a list of numbered steps.", 'The guide says how to start the app, for example "npm start".'],
    frozenTests: [],
    mode: "review",
    ...overrides,
  });

describe("makePrompt", () => {
  const m = mission();

  it("names the task, the checks word for word, the plan's own checks and the script, and nothing about frozen tests or verify commands", () => {
    const f = checked({ expect: { headings: ["Install", "Add your first habit"], mentions: ["Habit tracker"], words: [200, 500] } });
    const text = makePrompt(m, f, { rung: 0, fileList: ["README.md"] });
    expect(text).toContain("# Mission: Habit tracker");
    expect(text).toContain("Make the deliverable for feature `setup-guide`. A script, and then a second AI, will check it against the numbered checks below. No tests are written for it.");
    expect(text).toContain("Answer with JSON: `summary`, `filesChanged`, `testDispute` (always null) and `notes`.");
    expect(text).toContain("Checks the second AI will judge, one by one:\n1. The guide is a list of numbered steps.\n2. The guide says how to start the app, for example \"npm start\".");
    expect(text).toContain("It has the headings “Install”, “Add your first habit”.");
    expect(text).toContain("Its visible text contains the words “Habit tracker”, written exactly like that.");
    expect(text).toContain("Its new text is 200 to 500 words long.");
    expect(text).toContain("the script checks that some file changed, that no file is empty or very large, that nothing is left as a placeholder, that no key or password is in a file, that no table cell starts like a formula, and that links to files in the project work.");
    expect(text).toContain("If you make a web page, it also checks a title, a viewport line, a description for each picture, no sideways scrolling at phone width, and nothing loaded from the internet.");
    expect(text).toContain("it also checks that the project's own checks pass");
    expect(text).toContain("```\nREADME.md\n```");
    expect(text).not.toMatch(/frozen|acceptance test|verify|escalation step/i);
    expect(text).not.toContain("Earlier attempts");
  });

  it("says nothing about the plan's checks when the plan has none, and has no stray empty parts", () => {
    const text = makePrompt(m, checked(), { rung: 0, fileList: [] });
    expect(text).not.toContain("The plan asks for this");
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/\n{3,}/);
  });

  it("from the second rung on tells the builder that earlier attempts failed and shows the problems", () => {
    const text = makePrompt(m, checked(), { rung: 1, fileList: [], lastProblems: ["“docs/setup.md” is empty.", "The text has no heading called “Install”."] });
    expect(text).toContain("Earlier attempts failed the engine's checks (this is escalation step 2). Earlier work may already be committed on this branch, so open the files before you change them.");
    expect(text).toContain("## The previous attempt failed");
    expect(text).toContain("- “docs/setup.md” is empty.\n- The text has no heading called “Install”.");
  });

  it("in a fix round lists the problems with the evidence and the finding of the owner", () => {
    const text = makePrompt(m, checked(), {
      rung: 0,
      fileList: [],
      fixes: [
        { severity: "major", file: null, description: "Check 2 is not met: The guide says how to start the app. The second AI found: it never says what the reader should see.", suggestedTest: null },
        { severity: "major", file: null, description: "The owner looked at this and asked: make it shorter", suggestedTest: null },
      ],
    });
    expect(text).toContain("## Problems to fix");
    expect(text).toContain("1. **major**: Check 2 is not met: The guide says how to start the app.");
    expect(text).toContain("2. **major**: The owner looked at this and asked: make it shorter");
    expect(text).toContain("The checks that passed must stay true.");
  });

  it("carries the plan's names, the context pack and the file list, and leaves the contract out when there is none", () => {
    const withContract = makePrompt(m, checked(), { rung: 0, fileList: ["a.md"], contextPack: { files: [{ path: "README.md", why: "the conventions" }], notes: "Start there." } });
    expect(withContract).toContain("UI-CONTRACT-MARKER");
    expect(withContract).toContain("## Files to read first");
    expect(withContract).toContain("`README.md`: the conventions");
    const without = makePrompt(mission({ spec: { ...SPEC, uiContract: "  " } }), checked(), { rung: 0, fileList: [] });
    expect(without).not.toContain("## UI contract");
  });

  it("names the features it builds on, and leaves its inputs untouched", () => {
    const frozen = Object.freeze(checked({ deps: ["track-habit"] }));
    expect(makePrompt(Object.freeze(mission()), frozen, { rung: 0, fileList: Object.freeze([]) as unknown as string[] })).toContain("Builds on: `track-habit`");
  });
});

// ───────────────────────────── The checker's brief ─────────────────────────────

describe("rubricPrompt", () => {
  const m = mission();
  const base = { facts: [], pictures: [], files: ["docs/setup.md"], diff: "diff --git a/docs/setup.md b/docs/setup.md\n+Install\n" };

  it("holds the task, the checks word for word, what the script found, the changed files and the diff", () => {
    const f = checked({ expect: { headings: ["Install"] } });
    const text = rubricPrompt(m, f, { ...base, facts: ["It also changed files of other kinds: “a.bin”."] });
    expect(text).toContain("Judge the finished feature `setup-guide` against the numbered checks below. No tests were written for it. The changed files are checked out in your working folder: open them.");
    expect(text).toContain("Answer for every check with `pass`, `fail` or `cannot_judge` and evidence, as your instructions say. Answer with JSON: `verdict`, `results`, `seen` and `notes`.");
    expect(text).toContain("## Checks\n\n1. The guide is a list of numbered steps.\n2. The guide says how to start the app, for example \"npm start\".");
    expect(text).toContain("All the script's checks passed.");
    expect(text).toContain("It has the headings “Install”.");
    expect(text).toContain("- It also changed files of other kinds: “a.bin”.");
    expect(text).toContain("## Changed files\n\n- `docs/setup.md`");
    expect(text).toContain("```diff\ndiff --git a/docs/setup.md");
    expect(text).not.toMatch(/frozen|verify command/i);
    expect(text).not.toContain("## The last round");
  });

  it("lists the pictures to open, or says why there are none, or says nothing for a feature with no page", () => {
    const given = rubricPrompt(m, checked(), { ...base, pictures: [{ path: "/m/screenshots/look__setup-guide__1__index__phone.png", label: "index.html, phone width" }] });
    expect(given).toContain("## Pictures\n\n- /m/screenshots/look__setup-guide__1__index__phone.png: index.html, phone width\n\nOpen each one with the Read tool.");
    const none = rubricPrompt(m, checked(), { ...base, noPictures: "Pictures: none. No browser was found in the container." });
    expect(none).toContain("## Pictures\n\nPictures: none. No browser was found in the container.");
    expect(rubricPrompt(m, checked(), base)).not.toContain("## Pictures");
  });

  it("cuts the list of files at 20, leaves out an empty diff, and tells a later round which checks failed", () => {
    const files = Array.from({ length: 23 }, (_, i) => `docs/f${i}.md`);
    const text = rubricPrompt(m, checked(), { ...base, files, diff: "", lastFailed: [2] });
    expect(text).toContain("`docs/f19.md`");
    expect(text).not.toContain("docs/f20.md");
    expect(text).toContain("… (3 more files changed)");
    expect(text).not.toContain("## Diff");
    expect(text).toContain("## The last round\n\nLast time check 2 failed. The files have changed since then. Judge every check again from the files, and not from this note.");
    expect(rubricPrompt(m, checked(), { ...base, lastFailed: [1, 3] })).toContain("Last time checks 1, 3 failed.");
  });

  it("cuts a very long diff to the same cap as the review of code", () => {
    const text = rubricPrompt(m, checked(), { ...base, diff: `diff --git a/x b/x\n${"+x\n".repeat(60_000)}` });
    expect(text.length).toBeLessThan(75_000);
    expect(text).toContain("chars omitted");
  });
});

// ───────────────────────────── The existing briefs, changed only for a mission that has a mode (spec 8.5) ─────────────────────────────

describe("the briefs of a mission that has a mode feature", () => {
  const modeSpec: Spec = {
    ...SPEC,
    features: [
      { ...SPEC.features[0]!, mode: "owner", effort: "deep" },
      { ...SPEC.features[1]!, mode: "review", effort: "light" },
      { id: "tests-one", title: "Checked by tests", story: "As a user.", acceptance: ["It works"], kind: "standard", deps: [] },
    ],
  };
  const m: Mission = mission({ spec: modeSpec });

  it("gate A says how each feature is judged and gives each feature its line", () => {
    const text = gateAPrompt(m);
    expect(text).toContain("each feature fits one focused build session, and its checks can be judged: by an automated test for a feature marked as checked by tests, and by reading the result for a feature marked as checked by a second AI (it opens the files and, for a page, pictures);");
    expect(text).not.toContain("its acceptance criteria can be checked by an automated test");
    expect(text).toContain("Checked by: a second AI against its list of checks, and then by the owner, no tests.\nEffort: deep.");
    expect(text).toContain("Checked by: a second AI against its list of checks, no tests.\nEffort: light.");
    expect(text).toContain("Checked by: tests, written first.");
  });

  it("the revision names the ids that must stay, and says nothing of the kind for a plan with no mode", () => {
    const text = specPrompt(m, null, { previous: { ...modeSpec, summary: "s" }, issues: ["Split it"] });
    expect(text).toContain("Some features are judged by reading the result and not by tests. Their ids are: `track-habit`, `about-page`. Keep every one of these ids, do not split, merge or drop these features, and write their checks as statements a reader can judge from the files, not as tests.");
    expect(specPrompt(m, null, { previous: SPEC, issues: ["Split it"] })).not.toContain("judged by reading the result");
  });

  it("gate C gets the added paragraph only when a done feature has a mode, and says how each done feature was checked", () => {
    const done = [{ ...feature({ ...modeSpec.features[0]!, status: "done", frozenTests: [] }), checked: { round: 1, reviewer: "claude" as const, results: [{ n: 1, result: "pass" as const, evidence: "ok", basis: "text" as const }, { n: 2, result: "pass" as const, evidence: "ok", basis: "text" as const }], unjudged: 0, scripted: { problems: [], facts: [] }, pictures: { taken: 0 } } }, feature({ id: "tests-one", status: "done" })];
    const text = gateCPrompt(m, { diff: "d", verifyTail: "t", features: done });
    expect(text).toContain("Some features here are documents, pages or data files that no test judged. The feature list says how each was checked: by a second AI against the owner's list, or by Mission Control's own checks only. Read them as a reader would. Look for false statements, broken links, pages that cannot be used, and numbers that do not add up.");
    expect(text).toContain("Checked by a second AI against your list. No tests were written for it.");
    const notDone = gateCPrompt(m, { diff: "d", verifyTail: "t", features: [feature({ ...modeSpec.features[0]!, status: "blocked", frozenTests: [] })] });
    expect(notDone).not.toContain("no test judged");
  });

  it("the report writer is told to say how each feature was checked only when a done feature has a mode", () => {
    const withMode = mission({ features: [feature({ ...modeSpec.features[0]!, status: "done", frozenTests: [] })] });
    expect(reportProsePrompt(withMode, "facts")).toContain("Say how each feature was checked exactly as the facts say. Never say that tests passed for a feature whose line says it was checked another way.");
    expect(reportProsePrompt(mission({ features: [feature({ status: "done" })] }), "facts")).not.toContain("Say how each feature was checked");
    expect(reportProsePrompt(withMode, "facts")).toBe(reportProsePrompt(withMode, "facts"));
  });

  it("no new brief speaks of a night or a morning", () => {
    const timeOfDay = /n[i]ght|mor[n]ing/i;
    const f = checked();
    for (const text of [makePrompt(m, f, { rung: 1, fileList: [], lastProblems: ["x"] }), rubricPrompt(m, f, { facts: ["f"], pictures: [], files: ["a.md"], diff: "d" }), gateAPrompt(m), loadVariantPrompt("maker"), loadVariantPrompt("checker")]) {
      expect(text.replace(/midn[i]ght/gi, "")).not.toMatch(timeOfDay);
    }
  });
});
