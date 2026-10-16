import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { World } from "../test/e2e-world.js";
import { createFixtureRepo, type HarnessOptions, labelOf, MissionHarness, planSource } from "../test/fixtures/mission-harness.js";
import { applyAnswer } from "./checkpoint.js";
import { indentWrapped } from "./dispatcher.js";
import type { SpecOutput } from "./types.js";

let h: MissionHarness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function harness(opts: HarnessOptions = {}): MissionHarness {
  h = new MissionHarness(opts);
  return h;
}

/** A plan with the two features the harness' fixture app knows how to build (greet, then farewell). */
const TWO = `mc-plan 1
name: Fixture app
request: Build a tiny app that answers.
app-name: Fixture App
summary: A tiny app used by tests.
assumption: Answers are plain strings.
contract: Each feature module has an answer function.

feature: greet
title: Feature greet
story: As a user I want greet.
check: answer in src/greet.mjs returns greet

feature: farewell
title: Feature farewell
story: As a user I want farewell.
needs: greet
check: answer in src/farewell.mjs returns farewell
check: answer in src/farewell.mjs does not return greet
`;

const ONE = TWO.slice(0, TWO.indexOf("\nfeature: farewell"));

const labels = (hh: MissionHarness): string[] => hh.jobs.map(labelOf);
const count = (hh: MissionHarness, label: string): number => hh.jobsLabeled(label).length;
const eventTypes = (hh: MissionHarness, id: string): string[] => hh.store.readEvents(id).map((e) => e.type);
const answer = (hh: MissionHarness, id: string, decision: "approve" | "send_back", note?: string): void => {
  const result = applyAnswer(hh.store, id, { decision, ...(note !== undefined && { note }) }, hh.clock.now());
  expect(result.ok, JSON.stringify(result)).toBe(true);
};
/** The plan the team's planner writes when it revises: one feature, greet. */
const revised = (summary: string, check: string): SpecOutput => ({
  appName: "Fixture App",
  summary,
  features: [{ id: "greet", title: "Feature greet", story: "As a user I want greet.", acceptance: [check], kind: "standard", deps: [] }],
  assumptions: [],
  uiContract: "x",
});
const defaults = (): MissionHarness["defaults"] => (h as MissionHarness).defaults;

// ───────────────────────────── A plan the leader wrote ─────────────────────────────

describe("a mission queued with a plan written outside the team", () => {
  it("adopts the plan with no planner call, has it read once, stops at the plan, and builds it once approved", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(TWO), checkpoints: ["plan"] }).id;
    const parked = await hh.run(id);

    expect(labels(hh)).toEqual(["gate-a"]); // no spec job: the planner is skipped; gate A reads the plan
    expect(eventTypes(hh, id).filter((t) => t === "spec")).toHaveLength(1);
    expect(parked).toMatchObject({ status: "stopped", stage: "init", plan: { review: { outcome: "approved", issues: [] } } });
    expect(parked.features.map((f) => f.id)).toEqual(["greet", "farewell"]);
    expect(parked.spec).toEqual(parked.plan?.spec);
    expect(parked.notes).toContain("Answers are plain strings.");
    const look = parked.checkpoint?.look;
    expect(look?.headline).toBe("Check the plan for “Fixture app”");
    expect(look?.lines[0]).toBe("This plan was written by the leader, not by the team's planner.");
    expect(look?.lines[1]).toBe("The team's plan reviewer read it and asked for no changes.");
    // everything the owner needs to read is there as lines of its own
    expect(look?.lines).toEqual(
      expect.arrayContaining([
        "App name: Fixture App (the new app goes in a new folder called fixture-app, or the next free name)",
        // each feature's id is on the line that introduces it (it reaches the AIs and the branch names)
        "“Feature greet” (id: greet): As a user I want greet.",
        "“Feature farewell” (id: farewell): As a user I want farewell.",
        "Check for “Feature farewell”: answer in src/farewell.mjs returns farewell",
        "Check for “Feature farewell”: answer in src/farewell.mjs does not return greet",
        "Needs first for “Feature farewell”: “Feature greet”.",
        "Choice made for you: Answers are plain strings.",
        "Name the tests and the code must agree on: Each feature module has an answer function.",
      ]),
    );
    expect(look?.lines.every((line) => line.length <= 300)).toBe(true);
    // the phone and the report send the owner to the command that prints all of it, not to the 40 lines of the report
    expect(hh.notifications[0]?.message).toContain(`The team stopped because the leader wrote this plan, and you look at such a plan first. Read all of it with: mc plan show ${id}. Then run: mc approve ${id}`);
    expect(hh.notifications[0]?.message).not.toContain("mc report");
    const report = readFileSync(hh.store.reportPath(id), "utf8");
    expect(report).toContain(`The team stopped here on purpose, because the leader wrote this plan, and you look at such a plan first. Read all of it with: mc plan show ${id}. Nothing else is waiting`);
    expect(report).toContain(`Plan: written by the leader (plan code ${parked.plan?.sha256.slice(0, 8)}); the team's plan reviewer asked for no changes.`);

    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done).toMatchObject({ status: "done", stage: "complete" });
    expect(count(hh, "gate-a")).toBe(1);
    expect(count(hh, "gate-c")).toBe(1); // every plan mission gets the review of the whole app, like any other
    expect(labels(hh)).not.toContain("spec");
    expect(done.plan?.spec.features.map((f) => f.id)).toEqual(["greet", "farewell"]); // the leader's plan is kept as it was
    expect(readFileSync(hh.store.reportPath(id), "utf8")).toContain("Plan: written by the leader");
  });

  it("changes an existing app the same way: onboard, then no planner, gate A, the stop, and the review of the whole app", async () => {
    const hh = harness();
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo);
    const id = hh.createMission("feature", { repoPath: repo, baseBranch: "main", plan: planSource(ONE), checkpoints: ["plan"] }).id;
    const parked = await hh.run(id);
    expect(labels(hh)).toEqual(["onboard", "gate-a"]);
    expect(parked.checkpoint?.look.lines[0]).toBe("This plan was written by the leader, not by the team's planner.");
    answer(hh, id, "approve");
    expect((await hh.run(id)).status).toBe("done");
    expect(count(hh, "spec")).toBe(0);
    expect(count(hh, "gate-c")).toBe(1);
  });

  it("runs straight through when no stop was chosen, with no checkpoint event at all", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(TWO) }).id;
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(eventTypes(hh, id).some((t) => t.startsWith("checkpoint."))).toBe(false);
    expect("checkpoints" in done).toBe(false);
    expect(done.plan?.review?.outcome).toBe("approved");
  });

  it("uses the revised plan when its reviewer asks for changes, and says so in the look", async () => {
    const issues = ["Name the label of the greeting.", "Say what farewell returns."];
    const hh = harness({
      agents: {
        reviewer: (job, call) => (call.label === "gate-a" ? { structured: { verdict: "revise", issues } } : defaults().reviewer(job, call)),
        architect: (job, call) => (call.label === "spec" ? { structured: revised("Revised.", "Revised check.") } : defaults().architect(job, call)),
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(TWO), checkpoints: ["plan"] }).id;
    const parked = await hh.run(id);
    expect(labels(hh)).toEqual(["gate-a", "spec"]);
    expect(parked.plan?.review).toEqual({ outcome: "revised", issues });
    expect(parked.plan?.spec.features.map((f) => f.id)).toEqual(["greet", "farewell"]); // what the leader wrote is kept
    expect(parked.features.map((f) => f.id)).toEqual(["greet"]); // what the team works from is the revision
    expect(parked.checkpoint?.look.lines.slice(0, 2)).toEqual([
      "This plan was written by the leader, not by the team's planner.",
      "The team's plan reviewer asked for changes, so the team's planner revised the plan. This is the revised plan. It asked: Name the label of the greeting. Say what farewell returns.",
    ]);
    expect(parked.checkpoint?.look.lines).toContain("Check for “Feature greet”: Revised check.");
    expect(readFileSync(hh.store.reportPath(id), "utf8")).toContain("the team's plan reviewer asked for changes and the planner revised it.");
  });

  // R3-8 of the real runs: a long answer of the plan reviewer is wrapped into several lines without a lead of their own, and the report made a bullet of each.
  it("indents the pieces of a long answer of the plan reviewer, so the report keeps them under one bullet", async () => {
    const issues = [1, 2, 3].map((n) => `Point ${n} is long. ${"alpha ".repeat(40)}end.`);
    const hh = harness({
      agents: {
        reviewer: (job, call) => (call.label === "gate-a" ? { structured: { verdict: "revise", issues } } : defaults().reviewer(job, call)),
        architect: (job, call) => (call.label === "spec" ? { structured: revised("Revised.", "Revised check.") } : defaults().architect(job, call)),
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(TWO), checkpoints: ["plan"] }).id;
    const parked = await hh.run(id);
    const lines = parked.checkpoint?.look.lines ?? [];
    const first = lines.findIndex((l) => l.startsWith("The team's plan reviewer asked for changes"));
    const asked = lines.findIndex((l) => l.startsWith("You asked:"));
    // The revised plan has other checks than the leader's, so a line about that follows the answer (it is a line of its own, not a piece of the answer).
    const counted = lines.findIndex((l) => l.startsWith("Compared with the plan the leader wrote"));
    expect(counted).toBeGreaterThan(first);
    expect(first).toBe(1);
    expect(counted).toBeGreaterThan(first + 2); // the answer needs more than one line
    for (const line of lines.slice(first + 1, counted)) expect(line).toMatch(/^ {2}\S/u);
    expect(lines.slice(0, first + 1).some((l) => l.startsWith(" "))).toBe(false);
    expect(lines.slice(asked).some((l) => l.startsWith(" "))).toBe(false); // the lines of a fact keep their lead and are not indented
    const report = readFileSync(hh.store.reportPath(id), "utf8").split("\n");
    const at = report.findIndex((l) => l.startsWith("- The team's plan reviewer asked for changes"));
    expect(at).toBeGreaterThan(-1);
    for (const piece of lines.slice(first + 1, counted)) {
      expect(report).toContain(`  ${piece.trim()}`);
      expect(report).not.toContain(`- ${piece.trim()}`);
    }
    expect(report[at + 1]).toMatch(/^ {2}\S/u);
  });

  it("indentWrapped leaves the first line, the owner's send-back line and a single line alone", () => {
    expect(indentWrapped(["one", "two", "three"], false)).toEqual(["one", "  two", "  three"]);
    expect(indentWrapped(["one", "two", "You sent the plan back once."], true)).toEqual(["one", "  two", "You sent the plan back once."]);
    expect(indentWrapped(["only"], false)).toEqual(["only"]);
    expect(indentWrapped(["You sent the plan back once."], true)).toEqual(["You sent the plan back once."]);
    expect(indentWrapped([], false)).toEqual([]);
  });

  it("keeps the plan as the leader wrote it when the changes cannot be made, and says what was asked", async () => {
    const hh = harness({
      agents: {
        reviewer: (job, call) => (call.label === "gate-a" ? { structured: { verdict: "revise", issues: ["Add a check."] } } : defaults().reviewer(job, call)),
        architect: (job, call) => (call.label === "spec" ? { outcome: "failed", error: "no plan" } : defaults().architect(job, call)),
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(TWO), checkpoints: ["plan"] }).id;
    const parked = await hh.run(id);
    expect(parked.plan?.review).toEqual({ outcome: "not_applied", issues: ["Add a check."] });
    expect(parked.features.map((f) => f.id)).toEqual(["greet", "farewell"]);
    expect(parked.checkpoint?.look.lines[1]).toBe("The team's plan reviewer asked for changes that could not be applied, so the plan is as the leader wrote it. It asked: Add a check.");
    expect(parked.notes).toContain("The plan reviewer asked for changes that could not be applied: Add a check.");
  });

  it("says the plan reviewer did not finish when it gave no answer", async () => {
    const hh = harness({ agents: { reviewer: (job, call) => (call.label === "gate-a" ? { outcome: "failed", error: "no answer" } : defaults().reviewer(job, call)) } });
    const id = hh.createMission("greenfield", { plan: planSource(TWO), checkpoints: ["plan"] }).id;
    const parked = await hh.run(id);
    expect(parked.plan?.review).toEqual({ outcome: "unfinished", issues: [] });
    expect(parked.checkpoint?.look.lines[1]).toBe("The team's plan reviewer did not finish, so the plan is as the leader wrote it.");
    expect(parked.notes).toContain("The plan review did not finish, so the plan was used as written.");
  });

  it("revises the leader's plan with the owner's note after a send-back, and the second look says whose note did it", async () => {
    const hh = harness({
      agents: {
        architect: (job, call) => (call.label === "spec" ? { structured: revised("Smaller.", "It greets.") } : defaults().architect(job, call)),
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(TWO), checkpoints: ["plan"] }).id;
    await hh.run(id);
    answer(hh, id, "send_back", "only the greeting, please");
    const second = await hh.run(id);

    expect(labels(hh)).toEqual(["gate-a", "spec"]); // one planner call, made for the owner's note
    expect(hh.jobsLabeled("spec")[0]?.prompt).toContain("The owner asked for this change to the plan: only the greeting, please");
    expect(second.checkpoint).toMatchObject({ id: "plan#2", round: 2, state: "pending" });
    expect(second.features.map((f) => f.id)).toEqual(["greet"]);
    expect(second.plan?.spec.features.map((f) => f.id)).toEqual(["greet", "farewell"]); // still what the leader wrote
    expect(second.plan?.review?.outcome).toBe("approved");
    expect(second.checkpoint?.look.lines.slice(0, 3)).toEqual([
      "This plan was written by the leader, not by the team's planner.",
      "The team's plan reviewer read it and asked for no changes.",
      "You sent the plan back once. This is the plan as it stands now.",
    ]);
    expect(hh.notifications.filter((n) => n.title.includes("please check")).map((n) => n.message)).toEqual([
      expect.stringContaining(`mc plan show ${id}`),
      expect.stringContaining(`mc plan show ${id}`),
    ]);
  });

  it("does not make the features twice when it stops after the plan was adopted and before gate A", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(TWO), checkpoints: ["plan"] }).id;
    // The first run is cut off right after the plan is adopted (the stage change to gate A fails once).
    const append = hh.store.appendEvent.bind(hh.store);
    let cut = true;
    hh.store.appendEvent = (missionId, type, data, nowMs) => {
      if (cut && type === "stage" && data?.to === "gate_a") {
        cut = false;
        throw new Error("cut off");
      }
      return append(missionId, type, data, nowMs);
    };
    const first = await hh.run(id);
    expect(first.status).toBe("failed");
    expect(first.stage).toBe("spec");
    expect(first.features.map((f) => f.id)).toEqual(["greet", "farewell"]);

    const again = await hh.run(id);
    expect(again.status).toBe("stopped");
    expect(again.features.map((f) => f.id)).toEqual(["greet", "farewell"]);
    expect(again.notes.filter((n) => n === "Answers are plain strings.")).toHaveLength(1);
    expect(labels(hh)).toEqual(["gate-a"]);
  });

  it("goes on safely when gate A is run again after it revised the plan: the revision stays on record", async () => {
    const hh = harness({
      agents: {
        reviewer: (job, call) => (call.label === "gate-a" ? { structured: { verdict: call.n === 1 ? "revise" : "approve", issues: call.n === 1 ? ["Add a check."] : [] } } : defaults().reviewer(job, call)),
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(TWO), checkpoints: ["plan"] }).id;
    await hh.run(id);
    // As if the run had been cut off just before gate A's stage change: the stage goes back to gate A.
    const m = hh.load(id);
    m.stage = "gate_a";
    delete m.checkpoint;
    m.status = "stopped";
    hh.store.save(m);
    const again = await hh.run(id);
    expect(count(hh, "gate-a")).toBe(2);
    expect(again.plan?.review).toEqual({ outcome: "revised", issues: ["Add a check."] });
  });

  it("treats a damaged plan field as no plan: the team's planner writes the plan", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(TWO) }).id;
    const m = hh.load(id);
    (m as unknown as { plan: unknown }).plan = { spec: "nonsense" };
    hh.store.save(m);
    await hh.run(id);
    expect(count(hh, "spec")).toBe(1);
  });
});

// ───────────────────────────── Missions queued the old way ─────────────────────────────

describe("a mission queued the old way", () => {
  // The event types of a two-feature new app, as recorded before plans existed (the same list as dispatcher-checkpoint.test.ts).
  const GREENFIELD =
    "mission.start run.start run.end spec stage run.start run.end stage run.start run.end verify verify attempt stage verify feature.status " +
    "run.start run.end verify tests.frozen feature.status run.start run.end run.start run.end verify verify attempt feature.status run.start " +
    "run.end merge feature.status verify feature.status run.start run.end verify tests.frozen feature.status run.start run.end run.start run.end " +
    "verify verify attempt feature.status run.start run.end merge feature.status stage verify verify run.start run.end stage run.start run.end " +
    "report mission.end stage";

  it("gives the same events and files as before: nothing of a plan appears anywhere", async () => {
    const hh = harness();
    const done = await hh.run(hh.createMission("greenfield").id);
    expect(eventTypes(hh, done.id).join(" ")).toBe(GREENFIELD);
    expect(done.status).toBe("done");
    expect("plan" in done).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(join(hh.store.missionDir(done.id), "mission.json"), "utf8")))).not.toContain("plan");
    expect(readFileSync(join(hh.store.missionDir(done.id), "dispatch.json"), "utf8")).not.toContain("plan");
    expect(readFileSync(hh.store.reportPath(done.id), "utf8")).not.toContain("Plan: written by the leader");
  });

  it("stops at the plan in the owner's own words: the look, the phone and the report are unchanged", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { checkpoints: ["plan"] }).id;
    const parked = await hh.run(id);
    expect(parked.checkpoint?.look.lines).toEqual([
      "A tiny app used by tests.",
      "The plan has 2 features: Feature greet, Feature farewell.",
      "“Feature greet”: As a user I want greet.",
      "“Feature farewell”: As a user I want farewell.",
      "Choices made for you: Answers are plain strings.",
    ]);
    expect(hh.notifications[0]?.message).toBe(
      `The team stopped because you asked to look at the plan first. Read it with: mc report ${id}. Then run: mc approve ${id}, or: mc send-back ${id} --note "what to change". Nothing else is waiting on this; other work carries on.`,
    );
    expect(readFileSync(hh.store.reportPath(id), "utf8")).toContain("The team stopped here on purpose, because you asked to look at the plan first. Nothing else is waiting on this mission; other work carries on.");
  });
});

// ───────────────────────────── What a run says about a plan that waits ─────────────────────────────

describe("the night summary and notice for a plan the leader wrote", () => {
  it("send the owner to mc plan show, not to the 40 lines of the report, and say it the old way for a plan the team wrote", async () => {
    const w = new World();
    try {
      const mine = w.store().createMission({ kind: "greenfield", title: "Leader plan", request: "Build it.", repoPath: "", baseBranch: "main", profile: w.config.defaultProfile, checkpoints: ["plan"], plan: planSource(TWO), nowMs: w.clock.now() });
      const theirs = w.queueGreenfield("Team plan", "Build it too.", ["plan"]);
      const first = await w.night();
      const summary = readFileSync(first.summaryPath, "utf8");
      expect(summary).toContain(`- **Leader plan** is waiting for your check (the plan). Look at it with \`mc plan show ${mine.id}\`, then run \`mc approve ${mine.id}\``);
      expect(summary).toContain(`- **Team plan** is waiting for your check (the plan). Look at it with \`mc report ${theirs.id}\`, then run`);
      const second = await w.night();
      expect(second.waitingForCheck.map((m) => m.id)).toEqual([mine.id, theirs.id]);
      const body = w.notifications().filter((n) => n.title === "Run finished").at(-1)?.body ?? "";
      expect(body).toContain(`Leader plan: waiting for your check (mc plan show ${mine.id})`);
      expect(body).toContain(`Team plan: waiting for your check (mc report ${theirs.id})`);
    } finally {
      w.cleanup();
    }
  });
});
