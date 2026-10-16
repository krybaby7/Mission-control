// Real run R6 (the final smoke run), defects 1 to 3, as far as they are in the report and the rule that finds a file made too early. Two features: the
// first is checked by tests, the second is the owner's notes file, checked by reading. Nothing here calls an AI. The flow through the whole
// engine on the mock team is in real-run-fixes-r6-flow.test.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feature, mission } from "../test/fixtures/modes/prompt-inputs.js";
import { alsoMadeSentence, alsoMadeSentences, laterFeatureFiles } from "./later-files.js";
import { packageRoot } from "./prompts.js";
import { buildReportFacts, renderReport } from "./report.js";
import type { Feature, Mission, ReportProseOutput, Spec } from "./types.js";

const WINDOWS = "\\\\wsl.localhost\\Ubuntu\\home\\<your Ubuntu name>\\mc-apps\\word-tools";
const NOTES_TITLE = "Notes on what word-tools is for and where it stops";

/** The plan of R6: the contract names the notes file and its headings; the checks of the notes feature name `NOTES.md` and not the whole path. */
const R6_SPEC: Spec = {
  appName: "word-tools",
  summary: "Adds a wordCount function, then a short notes file.",
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
      title: NOTES_TITLE,
      story: "As a new reader I can read a short notes file that says what word-tools is for and what it cannot do.",
      acceptance: [
        "The notes are saved as NOTES.md in the docs folder of the project.",
        "The Purpose section says what word-tools is for and names both of its functions, capitalize and wordCount.",
        "The Limits section says that wordCount splits words only at spaces.",
        "The notes read as friendly and short enough to read in a minute (the CEO decides).",
      ],
      kind: "standard",
      deps: ["word-count"],
      mode: "owner",
    },
  ],
  assumptions: ["Text that is empty, or only spaces, has zero words."],
  uiContract: "The function is called wordCount and takes one argument, the text.\nThe notes are the file docs/NOTES.md, with a heading called Purpose and a heading called Limits.",
};

const result = (n: number, r: "pass" | "fail" | "cannot_judge") => ({ n, result: r, evidence: "e", basis: "text" as const });
const approve = (scope: string) => ({ id: `${scope}#1`, scope, kind: "feature" as const, round: 1, decision: "approve" as const, at: "2026-10-16T05:50:00.000Z" });

/** The finished mission of R6: a change to word-tools with no start script, `npm test` as the project's own check. */
function r6(over: Partial<Mission> = {}): Mission {
  const tests = feature({ ...R6_SPEC.features[0]!, status: "done", frozenTests: [{ path: "src/wordCount.test.js", sha256: "a".repeat(64) }] });
  const notes = feature({
    ...R6_SPEC.features[1]!,
    status: "done",
    frozenTests: [],
    checked: {
      round: 1,
      reviewer: "claude",
      results: [result(1, "pass"), result(2, "pass"), result(3, "pass"), result(4, "cannot_judge")],
      unjudged: 1,
      scripted: { problems: [], facts: [] },
      pictures: { taken: 0 },
      files: ["docs/NOTES.md"],
    },
  });
  return mission({
    kind: "feature",
    title: "Word count and notes",
    request: "In word-tools, add a wordCount(text) function, then a notes file.",
    repoPath: "/home/pwuser/mc-apps/word-tools",
    integrationBranch: "mc/2026-10-16-word-count-and-notes",
    status: "done",
    stage: "complete",
    spec: R6_SPEC,
    features: [tests, notes],
    verify: { install: null as unknown as string, full: "npm test", tests: "node --test {files}", testGlobs: ["src/**/*.test.js", "test/**"] },
    checkpointLog: [approve("feature:notes")],
    ...over,
  });
}

const render = (m: Mission, prose: ReportProseOutput | null = null): string =>
  renderReport(m, { prose, usage: [], screenshots: [], generatedAt: "2026-10-16T05:50:49.802Z", inContainer: true });

/** The text of one "## <title>" section, without its heading. */
function sectionText(report: string, title: string): string {
  const start = report.indexOf(`\n## ${title}\n`);
  expect(start, `section "${title}" is missing`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + `\n## ${title}\n`.length;
  const next = report.indexOf("\n## ", bodyStart);
  return report.slice(bodyStart, next === -1 ? undefined : next).trim();
}

beforeEach(() => {
  vi.stubEnv("HOME", "/home/pwuser");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ───────────────────────────── R6-2: the first paragraph and the Checked line ─────────────────────────────

/** The narrative of the finished report of R6, word for word. */
const R6_NARRATIVE =
  "The word-tools project now has a word counting feature that reports how many words a text has, treating any run of spaces as a single separator. Empty text, or text made only of spaces, counts as zero words, and a value that isn't text is refused with an error, the same way the existing capitalize feature refuses it. A short notes page was also added that explains what word-tools is for and what it cannot do, written for someone who has never used it. The word counting feature has no record of how it was checked, so it should be confirmed before you rely on it. The notes page was checked by a second AI and approved by you, and one more check is left for you to do. No automated tests were written for the notes. The project's main description page still lists only the capitalize feature and does not mention word counting; this was not part of your request, so it was left alone. You don't need to make any decisions to finish this work.";
const R6_PROSE: ReportProseOutput = {
  narrative: R6_NARRATIVE,
  whatYouCanDo: ["Count how many words a text has, with words separated by spaces.", "Read the short notes page that says what word-tools is for and where it stops."],
};
const NO_RECORD_SENTENCE = "The word counting feature has no record of how it was checked, so it should be confirmed before you rely on it.";

describe("R6-2: the fact sheet says how a feature checked by tests was checked, in a mission that has a feature checked by reading", () => {
  it("gives the feature the line `Checked by: tests written first.`, and the other feature the line it always had", () => {
    const facts = buildReportFacts(r6(), []);
    expect(facts).toContain(`- word-count "Count the words of a text" [done]: As a user of word-tools I can find out how many words a text has. Checked by: tests written first.\n`);
    expect(facts).toContain(`- notes "${NOTES_TITLE}" [done]: As a new reader I can read a short notes file that says what word-tools is for and what it cannot do. Checked by: a second AI against your list; 1 check left for you; approved by you. No tests were written for it.\n`);
  });

  it("says what is true for the other ways a feature that tests check can stand: approved by the owner, or no test was written", () => {
    const approved = r6({ checkpointLog: [approve("feature:notes"), approve("feature:word-count")] });
    expect(buildReportFacts(approved, [])).toContain("Checked by: tests written first, and approved by you.\n");
    const noTests = r6();
    noTests.features[0] = { ...noTests.features[0]!, frozenTests: [] };
    const facts = buildReportFacts(noTests, []);
    expect(facts).toContain("Checked by: the project's own checks only (no tests were written for it).\n");
    expect(facts).not.toContain("tests written first");
  });

  it("is the same wording as the Checked line of the report", () => {
    const report = render(r6());
    expect(report).toContain("Checked: 1 feature by tests; 1 feature by a second AI against your list; 1 check left for you; approved by you.");
  });

  it("changes nothing for a mission with no feature checked by reading, and for a feature that is not finished", () => {
    const plain = r6();
    plain.features = plain.features.map((f) => ({ ...f, mode: undefined, checked: undefined }));
    expect(buildReportFacts(plain, [])).toContain(`- word-count "Count the words of a text" [done]: As a user of word-tools I can find out how many words a text has.\n`);
    expect(buildReportFacts(plain, [])).not.toContain("Checked by:");
    const unfinished = r6();
    unfinished.features[0] = { ...unfinished.features[0]!, status: "building" };
    expect(buildReportFacts(unfinished, [])).toContain(`- word-count "Count the words of a text" [building]: not finished\n`);
  });
});

describe("R6-2: a sentence that says there is no record of how a feature was checked is dropped when the Checked line has it", () => {
  it("drops the sentence of the real report and keeps every other sentence, in order", () => {
    const report = render(r6(), R6_PROSE);
    expect(report).not.toContain("no record of how it was checked");
    expect(report).not.toContain("should be confirmed before you rely on it");
    expect(report).toContain("Checked: 1 feature by tests;");
    // the sentences before and after it stand, and the paragraph still reads as one
    expect(report).toContain("written for someone who has never used it. The notes page was checked by a second AI and approved by you, and one more check is left for you to do.");
    expect(report).toContain("No automated tests were written for the notes.");
    expect(report).toContain("You don't need to make any decisions to finish this work.");
    // the AI's list of things to do is kept too
    expect(report).toContain("- Count how many words a text has, with words separated by spaces.");
  });

  it("drops the other ways of saying it", () => {
    const said = [
      "There is no record of how the word counting feature was checked.",
      "No information is kept about how it was checked.",
      "It was not recorded how the first feature was checked.",
      "How the first feature was checked is not recorded.",
      "How the first feature was checked is unknown.",
      "It is unclear how the word counting was checked.",
      "Nothing records how the first feature was tested.",
      "The first feature has no record of being checked.",
    ];
    for (const sentence of said) {
      const report = render(r6(), { narrative: `The words are counted. ${sentence} The notes are written.`, whatYouCanDo: ["Count words."] });
      expect(report, sentence).toContain("The words are counted. The notes are written.");
      expect(report, sentence).not.toContain(sentence);
    }
  });

  it("drops an item of the list that says it, and keeps the rest", () => {
    const report = render(r6(), { narrative: "The words are counted.", whatYouCanDo: ["Count words.", "Know that the counting has no record of how it was checked."] });
    expect(report).toContain("- Count words.");
    expect(report).not.toContain("no record");
  });

  it("falls back to the plain summary when nothing is left of the paragraph", () => {
    const report = render(r6(), { narrative: "The first feature has no record of how it was checked.", whatYouCanDo: ["Count words."] });
    expect(report).toContain("I worked on your request for word-tools: “Word count and notes”.");
    expect(report).not.toContain("no record");
  });

  it("keeps a paragraph that has none of these sentences exactly as the AI wrote it, with its line breaks", () => {
    const narrative = "The words are counted.\n\nThe notes are written, and nothing needs a decision.";
    expect(render(r6(), { narrative, whatYouCanDo: ["Count words."] })).toContain(narrative);
  });

  it("does not stand in for the guard on the words of the never-say list: a claim of a test still sends the whole paragraph away", () => {
    const report = render(r6(), { narrative: `${NO_RECORD_SENTENCE} The tests passed for the notes.`, whatYouCanDo: ["Count words."] });
    expect(report).toContain("I worked on your request for word-tools");
    expect(report).not.toContain("The tests passed for the notes.");
    expect(report).toContain("was left out");
  });

  it("applies only when the Checked line is there: with no finished feature checked by reading, the sentence is the AI's own and stays", () => {
    const stuck = r6();
    stuck.features[1] = { ...stuck.features[1]!, status: "blocked", blockedReason: "x", checked: undefined };
    expect(render(stuck, R6_PROSE)).not.toContain("Checked:");
    expect(render(stuck, R6_PROSE)).toContain(NO_RECORD_SENTENCE);
    // a mission with no mode feature at all is not touched
    const plain = r6();
    plain.features = plain.features.map((f) => ({ ...f, mode: undefined, checked: undefined }));
    expect(render(plain, R6_PROSE)).toContain(NO_RECORD_SENTENCE);
  });
});

// ───────────────────────────── R6-3: how to try it, and the file to open ─────────────────────────────

describe("R6-3: the finished report of a mission with code and a notes file names the file to open, first", () => {
  it("lists the steps that go to the version, then the file to open, then the project's own checks as an extra", () => {
    const text = sectionText(render(r6()), "How to try it");
    expect(text).toContain("1. `cd ~/mc-apps/word-tools`: go to the app's folder");
    expect(text).toMatch(/\n2\. `git checkout mc\/2026-10-16-word-count-and-notes`: switch to the version with the new work\n/);
    expect(text).not.toMatch(/\n3\./);
    expect(text).toContain(`Then open \`docs/NOTES.md\` in your app folder (in Windows File Explorer: \`${WINDOWS}\\docs\\NOTES.md\`).`);
    expect(text).toContain("The project's own checks do not cover `docs/NOTES.md`. If you also want to run them, run `npm test`.");
    expect(text.indexOf("Then open")).toBeLessThan(text.indexOf("`npm test`"));
    // nothing about starting an app that has no start script
    expect(text).not.toContain("start your app");
    expect(text).toContain("When you're done, put the folder back on your own version with `git checkout main` and type `exit`.");
  });

  it("says to install first when the project has an install command", () => {
    const m = r6();
    m.verify = { ...m.verify!, install: "npm ci" };
    expect(sectionText(render(m), "How to try it")).toContain("If you also want to run them, run `npm ci` first, and then `npm test`.");
  });

  it("names several files, and says so when a page is among them", () => {
    const m = r6();
    m.features[1] = { ...m.features[1]!, checked: { ...m.features[1]!.checked!, files: ["docs/NOTES.md", "site/index.html"] } };
    const text = sectionText(render(m), "How to try it");
    expect(text).toContain("Then open `docs/NOTES.md` and `site/index.html` in your app folder.");
    expect(text).toContain("Open `site/index.html` in your browser.");
    expect(text).toContain("The project's own checks do not cover `docs/NOTES.md` and `site/index.html`.");
  });

  it("with an app that has a start script, keeps the steps that start it and names the file after them", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-r6-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "node server.js" } }));
      const m = r6({ repoPath: dir });
      m.verify = { ...m.verify!, install: "npm install" };
      const text = sectionText(render(m), "How to try it");
      expect(text).toContain("`npm run dev`: start the app");
      expect(text).toContain("Then open the address it prints (often http://localhost:3000) in your browser.");
      expect(text).toContain("Also open `docs/NOTES.md` in your app folder.");
      expect(text.indexOf("Then open the address")).toBeLessThan(text.indexOf("Also open"));
      expect(text).not.toContain("The project's own checks do not cover");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names no file when the files of the feature are not all documents, pages or data files, or are not known", () => {
    const code = r6();
    code.features[1] = { ...code.features[1]!, checked: { ...code.features[1]!.checked!, files: ["docs/NOTES.md", "src/index.js"] } };
    expect(sectionText(render(code), "How to try it")).not.toContain("Then open");
    const old = r6();
    old.features[1] = { ...old.features[1]!, checked: { ...old.features[1]!.checked!, files: undefined } };
    expect(sectionText(render(old), "How to try it")).not.toContain("Then open");
  });

  it("says the same to the AI that writes the summary", () => {
    const facts = buildReportFacts(r6(), []);
    const how = facts.slice(facts.indexOf("How to try it:"));
    expect(how).toContain("Then open docs/NOTES.md in your app folder. The project's own checks (npm test) are an extra: they do not cover docs/NOTES.md.");
    expect(how).not.toContain("- npm test");
  });

  it("changes nothing for a mission with no feature checked by reading", () => {
    const plain = r6();
    plain.features = plain.features.map((f) => ({ ...f, mode: undefined, checked: undefined }));
    const text = sectionText(render(plain), "How to try it");
    expect(text).toContain("3. `npm test`: run the project's own checks");
    expect(text).toContain("Then start your app the way you usually do.");
    expect(text).not.toContain("Then open");
  });
});

describe("R6-3: the look at the notes feature puts the file first and shows the project's own checks as an extra", () => {
  function looking(over: Partial<Mission> = {}): Mission {
    const m = r6({ status: "stopped", stage: "features", ...over });
    m.features[1] = { ...m.features[1]!, status: "reviewing" };
    m.checkpoint = {
      id: "feature:notes#1",
      scope: "feature:notes",
      kind: "feature",
      featureId: "notes",
      round: 1,
      state: "pending",
      parkedAt: "2026-10-16T05:48:19.000Z",
      look: { headline: `Check “${NOTES_TITLE}” before it is added`, lines: ["It is built."], branch: "mc/2026-10-16-word-count-and-notes--notes", files: ["docs/NOTES.md"], existingFiles: ["docs/NOTES.md"] },
    };
    return m;
  }

  it("is the look of R6: two steps, then the file, then `npm test` as an extra that does not cover the feature", () => {
    const report = render(looking());
    const text = report.slice(report.indexOf("To look at it yourself:"), report.indexOf("\n## ", report.indexOf("To look at it yourself:")) === -1 ? undefined : report.indexOf("\n## ", report.indexOf("To look at it yourself:")));
    expect(text).toContain("1. `cd ~/mc-apps/word-tools`: go to the app's folder");
    expect(text).toContain("2. `git checkout --detach mc/2026-10-16-word-count-and-notes--notes`: switch to the version with the new work");
    expect(text).not.toMatch(/\n3\./);
    expect(text).toContain(`Then open \`docs/NOTES.md\` in your app folder (in Windows File Explorer: \`${WINDOWS}\\docs\\NOTES.md\`).`);
    expect(text).toContain("The project's own checks do not cover this feature. If you also want to run them, run `npm test`.");
    expect(text.indexOf("Then open")).toBeLessThan(text.indexOf("npm test"));
    expect(text).not.toContain("run the project's own checks\n");
  });

  it("names the file and no check when the project has no command for its own checks", () => {
    const m = looking();
    m.verify = undefined;
    const report = render(m);
    expect(report).toContain("Then open `docs/NOTES.md` in your app folder");
    expect(report).not.toContain("The project's own checks do not cover this feature");
  });
});

// ───────────────────────────── R6-1: a file made for a later feature ─────────────────────────────

describe("R6-1: laterFeatureFiles finds a file that a later feature is planned to make", () => {
  const plan = (): Mission => {
    const m = r6();
    m.features = m.features.map((f) => ({ ...f, status: "pending" as const }));
    return m;
  };
  const first = (m: Mission): Feature => m.features[0]!;

  it("finds docs/NOTES.md in the files of the first feature of R6: the contract holds the path and the checks of the notes feature hold the file's own name", () => {
    const m = plan();
    expect(laterFeatureFiles(m, first(m), ["docs/NOTES.md", "src/wordCount.js", "src/wordCount.test.js", "test/notes.test.js"])).toEqual([{ file: "docs/NOTES.md", belongsTo: "notes" }]);
  });

  it("matches as plain text and ignores case, slashes and spaces", () => {
    const m = plan();
    m.spec = { ...m.spec!, uiContract: "THE NOTES ARE THE FILE   Docs\\Notes.MD with two headings." };
    expect(laterFeatureFiles(m, first(m), ["docs/NOTES.md"])).toEqual([{ file: "docs/NOTES.md", belongsTo: "notes" }]);
  });

  it("finds a path that stands whole in a check of the later feature, without the contract", () => {
    const m = plan();
    m.spec = { ...m.spec!, uiContract: "" };
    m.features[1] = { ...m.features[1]!, acceptance: ["The notes are saved as docs/NOTES.md."] };
    expect(laterFeatureFiles(m, first(m), ["docs/NOTES.md"])).toEqual([{ file: "docs/NOTES.md", belongsTo: "notes" }]);
  });

  it("finds nothing when only the file's own name is in the checks and no contract line holds the path (too weak to say)", () => {
    const m = plan();
    m.spec = { ...m.spec!, uiContract: "The function is called wordCount." };
    expect(laterFeatureFiles(m, first(m), ["docs/NOTES.md"])).toEqual([]);
  });

  it("does not count a name inside a longer name", () => {
    const m = plan();
    m.features[1] = { ...m.features[1]!, acceptance: ["The page my.notes.md and the file docs/NOTES.mdx are not it, and neither is xdocs/NOTES.md."] };
    m.spec = { ...m.spec!, uiContract: "xdocs/NOTES.md and docs/NOTES.mdx" };
    expect(laterFeatureFiles(m, first(m), ["docs/NOTES.md"])).toEqual([]);
  });

  it("does not count a file that the words of the feature itself name", () => {
    const m = plan();
    m.features[0] = { ...m.features[0]!, acceptance: [...m.features[0]!.acceptance, "The notes in NOTES.md also mention wordCount."] };
    expect(laterFeatureFiles(m, first(m), ["docs/NOTES.md"])).toEqual([]);
  });

  it("looks only at features that have not started, and only after this one", () => {
    const m = plan();
    m.features[1] = { ...m.features[1]!, status: "done" };
    expect(laterFeatureFiles(m, first(m), ["docs/NOTES.md"])).toEqual([]);
    const earlier = plan();
    earlier.features.reverse();
    expect(laterFeatureFiles(earlier, earlier.features[1]!, ["docs/NOTES.md"])).toEqual([]);
  });

  it("finds nothing for a mission with no feature checked by reading, for a feature that is checked by reading, or for a feature the mission does not have", () => {
    const old = plan();
    old.features = old.features.map((f) => ({ ...f, mode: undefined }));
    expect(laterFeatureFiles(old, first(old), ["docs/NOTES.md"])).toEqual([]);
    const m = plan();
    expect(laterFeatureFiles(m, m.features[1]!, ["docs/NOTES.md"])).toEqual([]);
    expect(laterFeatureFiles(m, { ...first(m), id: "unknown" }, ["docs/NOTES.md"])).toEqual([]);
  });

  it("keeps at most five files, once each, and the first later feature whose checks name a file", () => {
    const m = plan();
    const files = Array.from({ length: 8 }, (_, i) => `docs/part${i}.md`);
    m.spec = { ...m.spec!, uiContract: files.join(" ") };
    m.features[1] = { ...m.features[1]!, acceptance: files.map((f) => `The file ${f} exists.`) };
    const found = laterFeatureFiles(m, first(m), [...files, ...files]);
    expect(found.map((a) => a.file)).toEqual(files.slice(0, 5));
  });

  it("uses the words of the plan as text only: a hostile line is never a path, and the module opens and runs nothing", () => {
    const m = plan();
    m.spec = { ...m.spec!, uiContract: "../../etc/passwd $(rm -rf /) `id` ; docs/NOTES.md" };
    m.features[1] = { ...m.features[1]!, acceptance: ["Read /etc/passwd then ../../secret.txt and NOTES.md"] };
    // only a name that git listed can be found: the words of the plan are compared with it and never opened
    expect(laterFeatureFiles(m, first(m), ["docs/NOTES.md", "src/wordCount.js"])).toEqual([{ file: "docs/NOTES.md", belongsTo: "notes" }]);
    expect(laterFeatureFiles(m, first(m), ["src/wordCount.js"])).toEqual([]);
    // text only: no file system, no process, no module loading in the module that decides
    const source = readFileSync(join(packageRoot(), "src", "later-files.ts"), "utf8");
    expect(source).not.toMatch(/node:fs|node:child_process|node:path|readFile|readdir|existsSync|spawn|exec[A-Z(]|import\(|require\(|eval\(|new Function/);
    // damaged input does not throw
    expect(() => laterFeatureFiles({ features: [{ ...first(m), acceptance: undefined as never }, { ...m.features[1]!, acceptance: 5 as never }], spec: undefined }, first(m), [3 as never, "", "a.md"])).not.toThrow();
  });
});

describe("R6-1: the words for the file that was made too early", () => {
  it("is the sentence of the report and the look", () => {
    expect(alsoMadeSentence("docs/NOTES.md", NOTES_TITLE)).toBe(`It also made “docs/NOTES.md”, which belongs to the later feature “${NOTES_TITLE}”.`);
  });

  it("is made from what is recorded on the feature, with a clean file name and title, and skips what cannot be said", () => {
    const m = r6();
    m.features[0] = { ...m.features[0]!, alsoMade: [{ file: "docs/NOTES.md", belongsTo: "notes" }, { file: "x.md", belongsTo: "gone" }, { file: 5 as never, belongsTo: "notes" }] };
    expect(alsoMadeSentences(m, m.features[0]!)).toEqual([`It also made “docs/NOTES.md”, which belongs to the later feature “${NOTES_TITLE}”.`]);
    m.features[1] = { ...m.features[1]!, title: "Notes\n\nwith\u0007 a break" };
    expect(alsoMadeSentences(m, m.features[0]!)[0]).toBe("It also made “docs/NOTES.md”, which belongs to the later feature “Notes with a break”.");
    expect(alsoMadeSentences(m, { alsoMade: undefined })).toEqual([]);
    expect(alsoMadeSentences(m, { alsoMade: "no" as never })).toEqual([]);
  });

  it("is in the Features table and in the facts for the summary writer, for a finished feature", () => {
    const m = r6();
    m.features[0] = { ...m.features[0]!, alsoMade: [{ file: "docs/NOTES.md", belongsTo: "notes" }] };
    const sentence = `It also made “docs/NOTES.md”, which belongs to the later feature “${NOTES_TITLE}”.`;
    expect(render(m)).toContain(`| ✅ | Count the words of a text | Built and checked. ${sentence} |`);
    expect(buildReportFacts(m, [])).toContain(`Checked by: tests written first. ${sentence}\n`);
    // a feature with nothing recorded has the table cell it always had
    expect(render(r6())).toContain("| ✅ | Count the words of a text | Built and checked |");
    // a feature that is not finished does not say it
    m.features[0] = { ...m.features[0]!, status: "blocked", blockedReason: "x" };
    expect(render(m)).not.toContain("It also made");
  });
});
