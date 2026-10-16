// Real run R6, defect 1: a line of the plan's contract that names a file another feature makes. The test author and the engineer of a
// feature checked by tests are told that the contract is for the whole plan, in a mission that has a feature checked by reading.
import { describe, expect, it } from "vitest";
import { feature, mission, oldWayPrompts, SPEC } from "../test/fixtures/modes/prompt-inputs.js";
import { buildPrompt, makePrompt, testAuthorPrompt } from "./prompts.js";
import type { Feature, Mission, Spec } from "./types.js";

const HEADING = "## The contract and the other features";
/** A long dash (two kinds) or a hidden character: none may be in a brief. */
const HIDDEN_OR_LONG_DASH = new RegExp(`[${[0x2013, 0x2014, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0xfeff].map((c) => String.fromCodePoint(c)).join("")}]`, "u");

/** The plan of R6: a feature checked by tests, then a feature of notes that the owner looks at, and a contract line that names the notes file. */
const R6_SPEC: Spec = {
  appName: "word-tools",
  summary: "Adds wordCount, then a short notes file.",
  features: [
    {
      id: "word-count",
      title: "Count the words of a text",
      story: "As a user of word-tools I can find out how many words a text has.",
      acceptance: ["wordCount of hello returns 1.", "wordCount of an empty string returns 0."],
      kind: "standard",
      deps: [],
    },
    {
      id: "notes",
      title: "Notes on what word-tools is for and where it stops",
      story: "As a new reader I can read a short notes file.",
      acceptance: ["The notes are saved as NOTES.md in the docs folder of the project.", "The notes read as friendly (the CEO decides)."],
      kind: "standard",
      deps: ["word-count"],
      mode: "owner",
    },
  ],
  assumptions: [],
  uiContract: "The function is called wordCount and takes one argument, the text.\nThe notes are the file docs/NOTES.md, with a heading called Purpose and a heading called Limits.",
};

function r6(): { m: Mission; tests: Feature; notes: Feature } {
  const tests = feature({ ...R6_SPEC.features[0]!, frozenTests: [{ path: "src/wordCount.test.js", sha256: "a".repeat(64) }] });
  const notes = feature({ ...R6_SPEC.features[1]!, status: "pending", frozenTests: [] });
  return { m: mission({ spec: R6_SPEC, features: [tests, notes] }), tests, notes };
}

describe("R6-1: the briefs of a feature checked by tests, in a mission that has a feature checked by reading", () => {
  it("the test author is told that the contract is for the whole plan, to test only this feature's checks, and what comes later", () => {
    const { m, tests } = r6();
    const text = testAuthorPrompt(m, tests, { fileList: ["package.json"] });
    expect(text).toContain(HEADING);
    expect(text).toContain("The UI contract above is for the whole plan. A line of it may describe a file or a name that another feature makes.");
    expect(text).toContain("Write tests only for the acceptance criteria of feature `word-count`. Never create a file, and never test a file, that only another feature's checks name.");
    expect(text).toContain("The features that come after this one are made by other agents later. Their files are not yours:\n- `notes` Notes on what word-tools is for and where it stops");
    // the contract itself is still given in full: the function name must be agreed
    expect(text).toContain("The function is called wordCount and takes one argument, the text.");
    // it sits after the contract and before the file list
    expect(text.indexOf("## UI contract")).toBeLessThan(text.indexOf(HEADING));
    expect(text.indexOf(HEADING)).toBeLessThan(text.indexOf("## Files in the repository"));
  });

  it("the engineer is told the same, in its own words, for a build and for a fix round", () => {
    const { m, tests } = r6();
    for (const text of [
      buildPrompt(m, tests, { rung: 0, fileList: [] }),
      buildPrompt(m, tests, { rung: 0, fileList: [], reviewFindings: [{ severity: "major", file: null, description: "x", suggestedTest: null }] }),
    ]) {
      expect(text).toContain(HEADING);
      expect(text).toContain("Make only what the acceptance criteria of feature `word-count` ask for, and what its frozen tests need. Never create a file that only another feature's checks name, even when a line of the contract describes it.");
      expect(text).toContain("- `notes` Notes on what word-tools is for and where it stops");
      expect(text.indexOf("## UI contract")).toBeLessThan(text.indexOf(HEADING));
      expect(text.indexOf(HEADING)).toBeLessThan(text.indexOf("## Frozen acceptance tests"));
    }
  });

  it("the last feature has nothing after it to name, and still gets the rule", () => {
    const early = feature({ ...R6_SPEC.features[1]!, id: "late", mode: undefined, status: "building" });
    const first = feature({ ...R6_SPEC.features[0]!, status: "done" });
    const m = mission({ spec: R6_SPEC, features: [first, feature({ ...R6_SPEC.features[1]!, mode: "review", status: "done", frozenTests: [] }), early] });
    const text = buildPrompt(m, early, { rung: 0, fileList: [] });
    expect(text).toContain(HEADING);
    expect(text).not.toContain("The features that come after this one");
  });

  it("only a feature checked by tests gets it: the brief of the maker of a document does not", () => {
    const { m, notes } = r6();
    expect(makePrompt(m, notes, { rung: 0, fileList: [] })).not.toContain(HEADING);
  });

  it("a mission with no feature checked by reading gets neither the section nor any change: its briefs are the ones they always were", () => {
    const plain = mission({ spec: SPEC, features: [feature(), feature({ ...SPEC.features[1]!, frozenTests: [], status: "pending" })] });
    const f = plain.features[0]!;
    expect(testAuthorPrompt(plain, f, { fileList: [] })).not.toContain(HEADING);
    expect(buildPrompt(plain, f, { rung: 0, fileList: [] })).not.toContain(HEADING);
    expect(testAuthorPrompt(plain, f, { fileList: [] })).not.toMatch(/other feature/);
    // and the golden texts of the end of wave 1 still stand for every prompt of such a mission
    for (const name of ["testAuthor", "testAuthor-amend", "build", "build-second-rung", "build-no-tests", "build-fix", "build-broken-baseline"]) {
      expect(oldWayPrompts()[name], name).not.toContain(HEADING);
    }
  });

  it("is plain: no long dash, no hidden character, no time of day, never the word objective", () => {
    const { m, tests } = r6();
    for (const text of [testAuthorPrompt(m, tests, { fileList: [] }), buildPrompt(m, tests, { rung: 0, fileList: [] })]) {
      expect(text).not.toMatch(HIDDEN_OR_LONG_DASH);
      expect(text).not.toMatch(/objective/i);
      expect(text.replace(/midn[i]ght/gi, "")).not.toMatch(/n[i]ght|mor[n]ing/i);
    }
  });
});
