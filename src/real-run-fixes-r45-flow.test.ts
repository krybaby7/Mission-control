// The real runs R3b and R4 again, through the whole engine on the mock team: a plan whose checks the plan reviewer changed, a long request, the
// second showing after a send-back, a feature that changes a file an earlier feature made, and a table. The pure pieces are in
// real-run-fixes-r45.test.ts. Nothing here calls an AI.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildOutput, checksInBrief, feature, type HarnessOptions, isMaker, MissionHarness, planSource, specOutput, writeDeliverable, writeFile } from "../test/fixtures/mission-harness.js";
import { applyAnswer } from "./checkpoint.js";

let h: MissionHarness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function harness(opts: HarnessOptions = {}): MissionHarness {
  h = new MissionHarness(opts);
  return h;
}

const answer = (hh: MissionHarness, id: string, decision: "approve" | "send_back", note?: string): void => {
  const result = applyAnswer(hh.store, id, { decision, ...(note !== undefined && { note }) }, hh.clock.now());
  expect(result.ok, JSON.stringify(result)).toBe(true);
};
const reportOf = (hh: MissionHarness, id: string): string => readFileSync(hh.store.reportPath(id), "utf8");
/** The steps under "To look at it yourself:" in the block of the report that waits for the owner. */
const stepsOf = (report: string): string => {
  const at = report.indexOf("To look at it yourself:");
  return at < 0 ? "" : report.slice(at, report.indexOf("\n## ", at) < 0 ? undefined : report.indexOf("\n## ", at));
};

const HEAD = (request = "Write the documents of the fixture app."): string => `mc-plan 1
name: Fixture app
request: ${request}
app-name: Fixture App
summary: Documents for the fixture app.
assumption: The documents are in English.
`;

/** A feature checked by a second AI: its id, title, the lines that follow the story (mode, needs, keys) and its checks. */
function block(id: string, title: string, lines: string[], checks: string[]): string {
  return `\nfeature: ${id}\ntitle: ${title}\nstory: As a reader I can use ${title}.\n${lines.map((l) => `${l}\n`).join("")}${checks.map((c) => `check: ${c}\n`).join("")}`;
}

const GREET = `\nfeature: greet\ntitle: Feature greet\nstory: As a user I want greet.\ncheck: answer in src/greet.mjs returns greet\n`;

// ───────────────────────────── R4-2 and R4-7: a plan the plan reviewer changed ─────────────────────────────

describe("a plan whose checks the plan reviewer changed (real run R4)", () => {
  const TWO = `${HEAD()}${GREET}${`\nfeature: farewell\ntitle: Feature farewell\nstory: As a user I want farewell.\nneeds: greet\ncheck: answer in src/farewell.mjs returns farewell\ncheck: answer in src/farewell.mjs does not return greet\n`}`;
  const revisedPlan = (check: string) => specOutput([{ ...feature("greet"), acceptance: [check] }]);

  function reviewed(): MissionHarness {
    const hh = harness({
      agents: {
        reviewer: (job, call) => (call.label === "gate-a" ? { structured: { verdict: "revise", issues: ["Name the label of the greeting."] } } : hh.defaults.reviewer(job, call)),
        architect: (job, call) => (call.label === "spec" ? { structured: revisedPlan("Revised check.") } : hh.defaults.architect(job, call)),
      },
    });
    return hh;
  }

  it("says near the top how many checks were removed and added, and lists each one, in the look and in the report", async () => {
    const hh = reviewed();
    const id = hh.createMission("greenfield", { plan: planSource(TWO), checkpoints: ["plan"] }).id;
    const parked = await hh.run(id);
    const lines = parked.checkpoint?.look.lines ?? [];
    const said = "Compared with the plan the leader wrote, 3 checks were removed and 1 check was added. Every one is listed below the plan.";
    expect(lines).toContain(said);
    expect(lines.indexOf(said)).toBeLessThan(lines.findIndex((l) => l.startsWith("You asked:")));
    expect(lines).toEqual(
      expect.arrayContaining([
        "Check the team removed from “Feature greet”: answer in src/greet.mjs returns greet",
        "Check the team removed from “Feature farewell”: answer in src/farewell.mjs returns farewell",
        "Check the team removed from “Feature farewell”: answer in src/farewell.mjs does not return greet",
        "Check the team added to “Feature greet”: Revised check.",
      ]),
    );
    const report = reportOf(hh, id);
    expect(report).toContain(`- ${said}`);
    expect(report).toContain("- Check the team removed from “Feature farewell”: answer in src/farewell.mjs returns farewell");
    expect(report).toContain("- Check the team added to “Feature greet”: Revised check.");
    expect(report.indexOf("- Check the team removed from")).toBeGreaterThan(report.indexOf("- The plan has 1 feature"));
  });

  it("says nothing about changed checks when the plan reviewer asked for no change, or changed no check", async () => {
    const same = harness();
    const sameId = same.createMission("greenfield", { plan: planSource(TWO), checkpoints: ["plan"] }).id;
    const asIs = await same.run(sameId);
    expect((asIs.checkpoint?.look.lines ?? []).join("\n")).not.toMatch(/Compared with the plan|Check the team/);
    expect(reportOf(same, sameId)).not.toMatch(/Compared with the plan|Check the team/);
    expect(asIs.checkpoint?.look.lines[1]).toBe("The team's plan reviewer read it and asked for no changes.");
  });

  it("puts a long request under one bullet of the report, and loses none of its words", async () => {
    const long = Array.from({ length: 90 }, (_, i) => `word${i}`).join(" ");
    expect(long.length).toBeGreaterThan(560);
    const hh = harness();
    const id = hh.createMission("greenfield", { request: long, plan: planSource(`${HEAD(long)}${GREET}`), checkpoints: ["plan"] }).id;
    const parked = await hh.run(id);
    // the card shows one line at a time, so each line still says what it is about
    const pieces = (parked.checkpoint?.look.lines ?? []).filter((l) => l.startsWith("You asked: "));
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(pieces.map((l) => l.slice("You asked: ".length)).join(" ")).toBe(long);
    // the report has one bullet, and the rest of the words under it
    const report = reportOf(hh, id).split("\n");
    const at = report.findIndex((l) => l.startsWith("- You asked: "));
    expect(at).toBeGreaterThan(-1);
    expect(report.filter((l) => l.includes("You asked:") && l.startsWith("-"))).toHaveLength(1);
    const rest: string[] = [];
    for (let i = at + 1; /^ {2}\S/u.test(report[i] ?? ""); i++) rest.push(report[i]!.trim());
    expect(rest).toHaveLength(pieces.length - 1);
    expect([report[at]!.slice("- You asked: ".length), ...rest].join(" ")).toBe(long);
    expect(report.slice(at + 1 + rest.length).some((l) => l.startsWith("  ") && l.includes("word"))).toBe(false);
  });
});

// ───────────────────────────── R4-6: the second showing ─────────────────────────────

describe("the second showing of a feature checked by reading, after a send-back (real run R4)", () => {
  const PLAN = `${HEAD()}${block("guide", "Setup guide", ["mode: owner"], ["The guide says how to start the app.", "The guide says what the reader should see."])}`;
  const NOTE = "Make every Meaning one short sentence of at most 7 words.";

  it("repeats the owner's note and says that nobody checks it was followed, in the look and in the report; the first showing says neither", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(PLAN) }).id;
    const first = await hh.run(id);
    expect((first.checkpoint?.look.lines ?? []).join("\n")).not.toMatch(/Your note|was changed after your note/);
    answer(hh, id, "send_back", NOTE);
    const again = await hh.run(id);
    const lines = again.checkpoint?.look.lines ?? [];
    expect(again.checkpoint).toMatchObject({ round: 2, state: "pending" });
    expect(lines[0]).toMatch(/^“Setup guide” is built\./);
    expect(lines[1]).toBe(`Your note: “${NOTE}”`);
    expect(lines[2]).toBe("It was changed after your note and checked again by a second AI. Nothing checks that your note was followed, so please look.");
    // the first lines of the report are what `mc report` shows: the note and the sentence are among them
    const report = reportOf(hh, id).split("\n");
    expect(report.slice(0, 40)).toContain(`- Your note: “${NOTE}”`);
    expect(report.slice(0, 40)).toContain("- It was changed after your note and checked again by a second AI. Nothing checks that your note was followed, so please look.");
  });

  it("repeats the newest note at the third showing", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(PLAN) }).id;
    await hh.run(id);
    answer(hh, id, "send_back", NOTE);
    await hh.run(id);
    answer(hh, id, "send_back", "Now add a line about the colour.");
    const third = await hh.run(id);
    expect(third.checkpoint?.look.lines[1]).toBe("Your note: “Now add a line about the colour.”");
  });

  it("does not change the second showing of a feature that tests check", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(`${HEAD()}${GREET}`), checkpoints: ["feature"] }).id;
    await hh.run(id);
    answer(hh, id, "send_back", "Return the word hello.");
    const again = await hh.run(id);
    expect(again.checkpoint).toMatchObject({ scope: "feature:greet", round: 2 });
    expect((again.checkpoint?.look.lines ?? []).join("\n")).not.toMatch(/Your note|was changed after your note/);
  });
});

// ───────────────────────────── R4-1: a feature that changed a file an earlier feature made ─────────────────────────────

describe("the look at a feature that changed a file that was already there (real run R4)", () => {
  /** The second feature also rewrites the file of the first one, as the builder of column-notes had to when the file was already made. */
  function twoGuides(): MissionHarness {
    const hh = harness({
      agents: {
        engineer: (job, call) =>
          isMaker(job) && call.feature === "second"
            ? {
                edit: (cwd) => {
                  writeDeliverable(cwd, "second", checksInBrief(job.prompt));
                  writeFile(cwd, "docs/first.md", "# first\n\nThe first guide, reworded by the second feature.\n");
                },
                structured: buildOutput("made it"),
              }
            : hh.defaults.engineer(job, call),
      },
    });
    return hh;
  }
  const PLAN = `${HEAD()}${block("first", "First guide", ["mode: review"], ["The first guide is short."])}${block("second", "Second guide", ["mode: owner", "needs: first"], ["The second guide is short."])}`;

  it("lists the files it made apart from the files it changed, and the first feature's own files as the new ones it made", async () => {
    const hh = twoGuides();
    const id = hh.createMission("greenfield", { plan: planSource(PLAN) }).id;
    const parked = await hh.run(id);
    expect(parked.checkpoint?.scope).toBe("feature:second");
    expect(parked.checkpoint?.look.files).toEqual(["docs/first.md", "docs/second.md"]);
    expect(parked.checkpoint?.look.existingFiles).toEqual(["docs/first.md"]);
    const report = reportOf(hh, id);
    expect(report).toContain("New in this feature: `docs/second.md`.");
    expect(report).toContain("Changed, but already there before this feature: `docs/first.md`.");
    expect(report).not.toContain("Files that changed:");
  });

  it("keeps the one sentence when every file of the feature is new", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(`${HEAD()}${block("first", "First guide", ["mode: owner"], ["The first guide is short."])}`) }).id;
    const parked = await hh.run(id);
    expect(parked.checkpoint?.look.files).toEqual(["docs/first.md"]);
    expect(parked.checkpoint?.look).not.toHaveProperty("existingFiles");
    expect(reportOf(hh, id)).toContain("Files that changed: `docs/first.md`.");
  });

  it("names the file as one that was already there when it is the only one", async () => {
    const hh = harness({
      agents: {
        engineer: (job, call) =>
          isMaker(job) && call.feature === "second"
            ? { edit: (cwd) => writeFile(cwd, "docs/first.md", "# first\n\nReworded once more.\n"), structured: buildOutput("made it") }
            : hh.defaults.engineer(job, call),
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(PLAN) }).id;
    const parked = await hh.run(id);
    expect(parked.checkpoint?.look.existingFiles).toEqual(["docs/first.md"]);
    const report = reportOf(hh, id);
    expect(report).toContain("Changed, but already there before this feature: `docs/first.md`.");
    expect(report).not.toContain("New in this feature:");
  });

  it("leaves the look of a feature checked by tests as it was", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(`${HEAD()}${GREET}`), checkpoints: ["feature"] }).id;
    const parked = await hh.run(id);
    expect(parked.checkpoint?.look.files?.length).toBeGreaterThan(0);
    expect(parked.checkpoint?.look).not.toHaveProperty("existingFiles");
    expect(reportOf(hh, id)).toMatch(/Files that changed: /);
    expect(reportOf(hh, id)).not.toMatch(/New in this feature|already there before this feature/);
  });
});

// ───────────────────────────── R4-5: a data file ─────────────────────────────

describe("the look at a table names the file to open (real run R4)", () => {
  const TABLE = "Column,Meaning,Example\nRegion,The sales region name.,North\nUnits,The number of items sold.,120\nRevenue,The money earned from sales.,2400.50\n";
  const NOTES = block("column-notes", "Description of each column", ["mode: owner", "columns: Column, Meaning, Example", "rows: 3-3"], ["Every column has a row in the description."]);

  function tableMaker(): HarnessOptions["agents"] {
    return {
      engineer: (job, call) => (isMaker(job) ? { edit: (cwd) => writeFile(cwd, "data/columns.csv", TABLE), structured: buildOutput("made it") } : (h as MissionHarness).defaults.engineer(job, call)),
    };
  }

  it("when no feature is checked by tests: says which file to open, runs nothing, and does not say the owner has nothing to decide", async () => {
    const hh = harness({ agents: tableMaker() });
    const id = hh.createMission("greenfield", { plan: planSource(`${HEAD()}${NOTES}`) }).id;
    const parked = await hh.run(id);
    expect(parked.checkpoint?.look.files).toEqual(["data/columns.csv"]);
    const report = reportOf(hh, id);
    const steps = stepsOf(report);
    expect(steps).toContain("Then open `data/columns.csv` in your app folder.");
    expect(steps).not.toMatch(/npm|install|start your app|project's own checks/);
    // while the check waits, the report does not also say "Nothing. You don't need to do anything."
    expect(report).toContain("## Waiting for your check");
    expect(report).not.toContain("## Needs your decision");
    expect(report).not.toContain("Nothing. You don't need to do anything.");
  });

  it("brings the section back once the mission is done, as it always was", async () => {
    const hh = harness({ agents: tableMaker() });
    const id = hh.createMission("greenfield", { plan: planSource(`${HEAD()}${NOTES}`) }).id;
    await hh.run(id);
    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    const report = reportOf(hh, id);
    expect(report).toContain("## Needs your decision\n\nNothing. You don't need to do anything.");
    expect(report).toContain("Then open `data/columns.csv` in your app folder");
  });

  it("when a test checks another feature of the mission: the file to open comes first, and the project's own checks are an extra after it (real run R6)", async () => {
    const hh = harness({ agents: tableMaker() });
    const id = hh.createMission("greenfield", { plan: planSource(`${HEAD()}${GREET}${block("column-notes", "Description of each column", ["mode: owner", "needs: greet", "columns: Column, Meaning, Example", "rows: 3-3"], ["Every column has a row in the description."])}`) }).id;
    const parked = await hh.run(id);
    expect(parked.checkpoint?.scope).toBe("feature:column-notes");
    const steps = stepsOf(reportOf(hh, id));
    expect(steps).toContain("Then open `data/columns.csv` in your app folder.");
    expect(steps).toContain("The project's own checks do not cover this feature. If you also want to run them, run `node --test \"tests/**/*.test.mjs\"`.");
    expect(steps.indexOf("go to the app's folder")).toBeLessThan(steps.indexOf("Then open"));
    expect(steps.indexOf("Then open")).toBeLessThan(steps.indexOf("If you also want to run them"));
    // the project's own checks are no numbered step
    expect(steps).not.toMatch(/\n3\. /);
  });

  it("a mission with no mode feature keeps the section, and its look, as they were", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(`${HEAD()}${GREET}`), checkpoints: ["feature"] }).id;
    await hh.run(id);
    const report = reportOf(hh, id);
    expect(report).toContain("## Waiting for your check");
    expect(report).toContain("## Needs your decision\n\nNothing. You don't need to do anything.");
    expect(report).not.toContain("To look at it, open");
  });
});
