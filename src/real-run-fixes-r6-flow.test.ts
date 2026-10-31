// Real run R6, defect 1, through the whole engine on the mock team: a plan whose contract names the notes file, a first feature checked by tests whose
// test author and engineer make that file, and a second feature (the owner's notes) that was meant to make it. Nothing here calls an AI.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildOutput, implementFeature, isMaker, MissionHarness, planSource, writeFile } from "../test/fixtures/mission-harness.js";
import { applyAnswer } from "./checkpoint.js";

let h: MissionHarness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const answer = (hh: MissionHarness, id: string, decision: "approve" | "send_back"): void => {
  const result = applyAnswer(hh.store, id, { decision }, hh.clock.now());
  expect(result.ok, JSON.stringify(result)).toBe(true);
};
const reportOf = (hh: MissionHarness, id: string): string => readFileSync(hh.store.reportPath(id), "utf8");

const NOTES_TITLE = "Notes on what the fixture app is for";
const NOTES_FILE = "docs/NOTES.md";
const NOTES_TEXT = "# Notes\n\n## Purpose\n\nThe fixture app gives answers.\n\n## Limits\n\nIt gives only plain strings.\n";
const SENTENCE = `It also made “${NOTES_FILE}”, which belongs to the later feature “${NOTES_TITLE}”.`;

const PLAN = (contract: string[]): string => `mc-plan 1
name: Fixture app
request: Add greet, then a short notes file.
app-name: Fixture App
summary: Greet, then notes.
assumption: The notes are in English.
${contract.map((c) => `contract: ${c}\n`).join("")}
feature: greet
title: Feature greet
story: As a user I want greet.
check: answer in src/greet.mjs returns greet

feature: notes
title: ${NOTES_TITLE}
story: As a new reader I can read a short notes file.
needs: greet
mode: owner
check: The notes are saved as NOTES.md in the docs folder of the project.
check: The notes read as friendly (the CEO decides).
heading: Purpose
heading: Limits
`;

const NOTES_CONTRACT = ["The notes are the file docs/NOTES.md, with a heading called Purpose and a heading called Limits."];

/** The maker of the notes feature writes the notes file with its two headings, as the real maker did. */
function notesMaker(hh: MissionHarness, job: Parameters<MissionHarness["defaults"]["engineer"]>[0], call: Parameters<MissionHarness["defaults"]["engineer"]>[1]) {
  return isMaker(job) && call.feature === "notes" ? { edit: (cwd: string) => writeFile(cwd, NOTES_FILE, `${NOTES_TEXT}\nIt is short.\n`), structured: buildOutput("wrote the notes") } : hh.defaults.engineer(job, call);
}

/** A team that makes only what its feature asks for. */
function plainTeam(): MissionHarness {
  const hh = new MissionHarness({ agents: { engineer: (job, call) => notesMaker(hh, job, call) } });
  h = hh;
  return hh;
}

/**
 * The team of R6: the test author of `greet` also writes a test of the notes file, and the engineer of `greet` makes the notes file so that it passes.
 * (`tests/` is where the fixture app keeps its tests.)
 */
function eagerTeam(): MissionHarness {
  const hh = new MissionHarness({
    agents: {
      test_author: (job, call) =>
        call.feature === "greet"
          ? {
              edit: (cwd) => {
                hh.defaults.test_author(job, call);
                writeFile(cwd, "tests/greet.test.mjs", `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { answer } from "../src/greet.mjs";\n\ntest("greet gives its answer", () => {\n  assert.equal(answer(), "greet");\n});\n`);
                writeFile(
                  cwd,
                  "tests/notes.test.mjs",
                  `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\n\ntest("the notes have a Purpose and a Limits heading", () => {\n  const text = readFileSync(new URL("../docs/NOTES.md", import.meta.url), "utf8");\n  assert.match(text, /^## Purpose$/m);\n  assert.match(text, /^## Limits$/m);\n});\n`,
                );
              },
              structured: { testFiles: ["tests/greet.test.mjs", "tests/notes.test.mjs"], notes: "" },
            }
          : hh.defaults.test_author(job, call),
      engineer: (job, call) =>
        call.feature === "greet" && !isMaker(job) && call.label !== "init"
          ? {
              edit: (cwd) => {
                implementFeature(cwd, "greet");
                writeFile(cwd, NOTES_FILE, NOTES_TEXT);
              },
              structured: buildOutput("made greet and the notes"),
            }
          : notesMaker(hh, job, call),
    },
  });
  h = hh;
  return hh;
}

describe("R6-1: the plan of R6, run on a team that does what the real team did", () => {
  it("tells the test author and the engineer of the tests feature that the contract is for the whole plan, and names the later feature", async () => {
    const hh = eagerTeam();
    const id = hh.createMission("greenfield", { plan: planSource(PLAN(NOTES_CONTRACT)), checkpoints: ["feature"] }).id;
    await hh.run(id);
    const author = hh.jobsFor("test_author").find((j) => j.prompt.includes("Write the acceptance tests for feature `greet`"));
    expect(author?.prompt).toContain("## The contract and the other features");
    expect(author?.prompt).toContain("Write tests only for the acceptance criteria of feature `greet`. Never create a file, and never test a file, that only another feature's checks name.");
    expect(author?.prompt).toContain(`- \`notes\` ${NOTES_TITLE}`);
    const engineer = hh.jobsFor("engineer").find((j) => j.prompt.includes("Implement feature `greet`"));
    expect(engineer?.prompt).toContain("## The contract and the other features");
    expect(engineer?.prompt).toContain("Never create a file that only another feature's checks name, even when a line of the contract describes it.");
    // Makers receive the same scope boundary under P6.
    for (const job of hh.jobsFor("engineer").filter((j) => j.prompt.includes("Make the deliverable for feature"))) expect(job.prompt).toContain("## The contract and the other features");
  });

  it("records the notes file on the first feature, and says so in the look, in the report and in the facts", async () => {
    const hh = eagerTeam();
    const id = hh.createMission("greenfield", { plan: planSource(PLAN(NOTES_CONTRACT)), checkpoints: ["feature"] }).id;
    const parked = await hh.run(id);
    expect(parked.checkpoint?.scope).toBe("feature:greet");
    // the file was made, and the test of it was frozen: nothing is undone, and the engine says what it saw
    expect(parked.checkpoint?.look.files).toEqual(expect.arrayContaining([NOTES_FILE, "tests/notes.test.mjs"]));
    expect(parked.features[0]?.alsoMade).toEqual([{ file: NOTES_FILE, belongsTo: "notes" }]);
    const lines = parked.checkpoint?.look.lines ?? [];
    expect(lines).toContain(SENTENCE);
    expect(lines[0]).toMatch(/^“Feature greet” is built and passed its checks/);
    expect(lines.indexOf(SENTENCE)).toBe(1);
    // the report that waits for the owner has it in the look; the finished report has it in the Features table
    expect(reportOf(hh, id)).toContain(`- ${SENTENCE}`);
    answer(hh, id, "approve");
    const next = await hh.run(id);
    expect(next.checkpoint?.scope).toBe("feature:notes");
    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(done.features[0]?.alsoMade).toEqual([{ file: NOTES_FILE, belongsTo: "notes" }]);
    const report = reportOf(hh, id);
    expect(report).toContain(`| ✅ | Feature greet | Built and checked by tests; approved by you. ${SENTENCE} |`);
    expect(report).toContain("Checked: 1 feature by tests, and approved by you; 1 feature by a second AI against your list");
    const facts = hh.jobsFor("scout").find((j) => j.prompt.includes("## Facts"))?.prompt ?? "";
    expect(facts).toContain("Checked by: tests written first, and approved by you.");
    expect(facts).toContain(SENTENCE);
  });

  it("says it without a stop for the owner too: in the Features table of the report", async () => {
    const hh = eagerTeam();
    const id = hh.createMission("greenfield", { plan: planSource(PLAN(NOTES_CONTRACT)), ownerStops: false }).id;
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(done.features[0]?.alsoMade).toEqual([{ file: NOTES_FILE, belongsTo: "notes" }]);
    expect(reportOf(hh, id)).toContain(`| ✅ | Feature greet | Built and checked. ${SENTENCE} |`);
  });

  it("says nothing when the plan has no contract line that names the file and no check that holds its path", async () => {
    const hh = eagerTeam();
    const id = hh.createMission("greenfield", { plan: planSource(PLAN([])), ownerStops: false }).id;
    const done = await hh.run(id);
    expect(done.features[0]).not.toHaveProperty("alsoMade");
    expect(reportOf(hh, id)).not.toContain("It also made");
  });

  it("says nothing for a team that makes only what its feature asks for", async () => {
    const hh = plainTeam();
    const id = hh.createMission("greenfield", { plan: planSource(PLAN(NOTES_CONTRACT)), ownerStops: false }).id;
    const done = await hh.run(id);
    expect(done.features[0]).not.toHaveProperty("alsoMade");
    expect(reportOf(hh, id)).not.toContain("It also made");
  });

  it("records and discloses the same overlap when every feature is checked by tests", async () => {
    const hh = eagerTeam();
    const plain = PLAN(NOTES_CONTRACT).replace("mode: owner\n", "").replace("heading: Purpose\n", "").replace("heading: Limits\n", "").replace("check: The notes read as friendly (the CEO decides).\n", "check: answer in src/notes.mjs returns notes\n");
    const id = hh.createMission("greenfield", { plan: planSource(plain) }).id;
    const done = await hh.run(id);
    expect(done.features.every((f) => f.mode === undefined)).toBe(true);
    expect(done.features[0]?.alsoMade).toEqual([{ file: NOTES_FILE, belongsTo: "notes" }]);
    expect(reportOf(hh, id)).toContain(SENTENCE);
    for (const job of [...hh.jobsFor("test_author"), ...hh.jobsFor("engineer")].filter((j) => !j.prompt.includes("Scaffold"))) {
      if (job.prompt.includes("feature `")) expect(job.prompt).toContain("## The contract and the other features");
    }
  });
});
