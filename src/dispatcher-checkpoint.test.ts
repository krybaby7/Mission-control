import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentHandler,
  buildOutput,
  createFixtureRepo,
  feature,
  finding,
  type HarnessOptions,
  implementFeature,
  labelOf,
  MissionHarness,
  review,
  writeFile,
} from "../test/fixtures/mission-harness.js";
import { applyAnswer } from "./checkpoint.js";
import type { CheckpointKind, Mission, MissionEvent, PendingCheckpoint } from "./types.js";
import { sha256 } from "./util/fs.js";

let h: MissionHarness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function harness(opts: HarnessOptions = {}): MissionHarness {
  h = new MissionHarness(opts);
  return h;
}

/** A greenfield mission that stops for the owner at `checkpoints`. */
function queue(hh: MissionHarness, ...checkpoints: CheckpointKind[]): string {
  return hh.createMission("greenfield", { checkpoints }).id;
}

/** The owner answers (the idle path of `mc approve` / `mc send-back`, without the command line). */
function answer(hh: MissionHarness, id: string, decision: "approve" | "send_back", note?: string): void {
  const result = applyAnswer(hh.store, id, { decision, ...(note !== undefined && { note }) }, hh.clock.now());
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

const labels = (hh: MissionHarness): string[] => hh.jobs.map(labelOf);
const count = (hh: MissionHarness, label: string): number => hh.jobsLabeled(label).length;
const events = (hh: MissionHarness, id: string, type: string): MissionEvent[] => hh.store.readEvents(id).filter((e) => e.type === type);
const checkpointOf = (hh: MissionHarness, id: string): PendingCheckpoint | undefined => hh.load(id).checkpoint;
const featureOf = (m: Mission, id: string) => m.features.find((f) => f.id === id);

/** Edits the saved mission the way a hand edit (or a test of one) would, while no run is going. */
function edit(hh: MissionHarness, id: string, change: (m: Mission) => void): void {
  const m = hh.load(id);
  change(m);
  hh.store.save(m);
}

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

function inBranch(repo: string, branch: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "cat-file", "-e", `${branch}:${path}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function byDefault(role: "architect" | "engineer" | "reviewer"): AgentHandler {
  return (job, call) => {
    if (!h) throw new Error("no harness");
    return h.defaults[role](job, call);
  };
}

/** An engineer whose fix rounds change something every time (so a change the owner asked for lands). */
const fixing: AgentHandler = (job, call) =>
  call.label.startsWith("fix-")
    ? { edit: (cwd) => writeFile(cwd, `src/touched-${call.n}.mjs`, `export const n = ${call.n};\n`), structured: buildOutput("changed it") }
    : byDefault("engineer")(job, call);

// ───────────────────────────── A mission without checkpoints ─────────────────────────────

describe("a mission that chose no checkpoint runs exactly as before", () => {
  // The event types of these two runs, recorded from the code before checkpoints existed (commit f45cd27).
  const GREENFIELD =
    "mission.start run.start run.end spec stage run.start run.end stage run.start run.end verify verify attempt stage verify feature.status " +
    "run.start run.end verify tests.frozen feature.status run.start run.end run.start run.end verify verify attempt feature.status run.start " +
    "run.end merge feature.status verify feature.status run.start run.end verify tests.frozen feature.status run.start run.end run.start run.end " +
    "verify verify attempt feature.status run.start run.end merge feature.status stage verify verify run.start run.end stage run.start run.end " +
    "report mission.end stage";
  const FEATURE =
    "mission.start run.start run.end verify verify stage run.start run.end spec stage run.start run.end stage verify feature.status run.start " +
    "run.end verify tests.frozen feature.status run.start run.end run.start run.end verify verify attempt feature.status run.start run.end " +
    "run.start run.end verify verify attempt run.start run.end merge feature.status verify feature.status run.start run.end verify tests.frozen " +
    "feature.status run.start run.end run.start run.end verify verify attempt feature.status run.start run.end merge feature.status stage verify " +
    "verify run.start run.end stage run.start run.end report mission.end stage";

  const types = (hh: MissionHarness, id: string): string => hh.store.readEvents(id).map((e) => e.type).join(" ");

  it("gives a new app the same events, and its mission file no checkpoint key", async () => {
    const hh = harness();
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(types(hh, m.id)).toBe(GREENFIELD);
    expect(m.status).toBe("done");
    for (const key of ["checkpoints", "checkpoint", "checkpointLog"]) expect(key in hh.load(m.id)).toBe(false);
    expect(JSON.parse(readFileSync(join(hh.store.missionDir(m.id), "dispatch.json"), "utf8"))).not.toHaveProperty("checkpoint");
  });

  it("gives a change with a review fix and an unfinished review the same events", async () => {
    const hh = harness({
      agents: {
        reviewer: (job, call) => {
          if (call.feature === "greet" && call.n === 1) return { structured: review([finding("major", "greet is not polite")]) };
          if (call.feature === "farewell" && call.label.startsWith("review-")) return { outcome: "failed", error: "no answer" };
          return byDefault("reviewer")(job, call);
        },
        engineer: (job, call) => (call.label === "fix-greet" ? { edit: (cwd) => implementFeature(cwd, "greet"), structured: buildOutput("polite now") } : byDefault("engineer")(job, call)),
      },
    });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo);
    const m = await hh.run(hh.createMission("feature", { repoPath: repo, baseBranch: "main" }).id);
    expect(types(hh, m.id)).toBe(FEATURE);
    expect(count(hh, "review-greet")).toBe(2);
    expect(hh.load(m.id).features.map((f) => f.status)).toEqual(["done", "done"]);
  });

  it("chose-nothing is the same as an empty list: no checkpoint key is written", () => {
    const hh = harness();
    expect("checkpoints" in hh.createMission("greenfield", { checkpoints: [] })).toBe(false);
  });
});

// ───────────────────────────── The plan ─────────────────────────────

describe("the plan checkpoint", () => {
  it("stops after the plan is checked and before anything is built, then carries on once approved", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    const parked = await hh.run(id);

    expect(labels(hh)).toEqual(["spec", "gate-a"]); // no scaffold, no tests, no build
    expect(parked).toMatchObject({ status: "stopped", stage: "init", repoPath: "" });
    expect(parked.checkpoint).toMatchObject({ id: "plan#1", scope: "plan", kind: "plan", round: 1, state: "pending" });
    expect(parked.checkpoint?.notifiedAt).toBeDefined();
    expect(parked.checkpoint?.look.headline).toBe("Check the plan for “Fixture app”");
    expect(parked.checkpoint?.look.lines).toEqual(
      expect.arrayContaining(["The plan has 2 features: Feature greet, Feature farewell.", "“Feature greet”: As a user I want greet.", "Choices made for you: Answers are plain strings."]),
    );
    expect(existsSync(join(hh.workspace, "fixture-app"))).toBe(false);
    // It is a stop on purpose, not a pause: no "mission.stopped" event, and the phone is told with the commands that answer it.
    expect(hh.store.readEvents(id).some((e) => e.type === "mission.stopped")).toBe(false);
    expect(events(hh, id, "checkpoint.parked").map((e) => e.data)).toEqual([{ id: "plan#1", kind: "plan", round: 1 }]);
    expect(hh.notifications).toEqual([
      {
        title: "Fixture app: please check the plan",
        message: expect.stringContaining(`mc approve ${id}, or: mc send-back ${id} --note "what to change"`),
        opts: { priority: "high", tags: ["eyes"] },
      },
    ]);
    const report = readFileSync(hh.store.reportPath(id), "utf8");
    expect(report.startsWith("## Waiting for your check\n")).toBe(true);
    expect(report).toContain("**Waiting for your check**");

    // Running it again changes nothing: not a job, not an event, not a byte of the mission file.
    const file = readFileSync(join(hh.store.missionDir(id), "mission.json"), "utf8");
    const eventCount = hh.store.readEvents(id).length;
    await hh.run(id);
    expect(labels(hh)).toEqual(["spec", "gate-a"]);
    expect(hh.store.readEvents(id)).toHaveLength(eventCount);
    expect(readFileSync(join(hh.store.missionDir(id), "mission.json"), "utf8")).toBe(file);

    answer(hh, id, "approve", "plan is fine");
    const done = await hh.run(id);
    expect(done).toMatchObject({ status: "done", stage: "complete" });
    expect(count(hh, "spec")).toBe(1);
    expect(count(hh, "gate-a")).toBe(1); // gate A is not repeated
    expect(done.checkpoint).toBeUndefined();
    expect(done.checkpointLog).toEqual([expect.objectContaining({ id: "plan#1", decision: "approve", note: "plan is fine" })]);
    const sequence = hh.store.readEvents(id).map((e) => e.type).filter((t) => t.startsWith("checkpoint."));
    expect(sequence).toEqual(["checkpoint.parked", "checkpoint.answered", "checkpoint.passed"]);
    expect(readFileSync(hh.store.reportPath(id), "utf8")).toMatch(/## Your checks\n\n\| What you checked[^\n]*\n\|---\|---\|---\|---\|\n\| The plan \| Approved \| [^|]+ \| plan is fine \|/);
  });

  it("revises the plan with the owner's note, shows it again, and the note reaches only that one request", async () => {
    const hh = harness({
      agents: {
        // The revised plan has one feature fewer.
        architect: (job, call) =>
          call.label === "spec" && call.n > 1
            ? { structured: { appName: "Fixture App", summary: "Smaller.", features: [feature("greet")], assumptions: [], uiContract: "x" } }
            : byDefault("architect")(job, call),
      },
    });
    const id = queue(hh, "plan");
    await hh.run(id);
    answer(hh, id, "send_back", "only the greeting, please");
    const second = await hh.run(id);

    expect(second).toMatchObject({ status: "stopped" });
    expect(second.checkpoint).toMatchObject({ id: "plan#2", round: 2, state: "pending" });
    expect(second.features.map((f) => f.id)).toEqual(["greet"]);
    expect(second.checkpoint?.look.lines[0]).toBe("Smaller.");
    expect(labels(hh)).toEqual(["spec", "gate-a", "spec"]);
    expect(hh.jobsLabeled("spec")[1]?.prompt).toContain("The owner asked for this change to the plan: only the greeting, please");
    expect(hh.jobs.filter((j) => j.prompt.includes("only the greeting, please")).map(labelOf)).toEqual(["spec"]);
    expect(hh.jobs.some((j) => /checkpoint/i.test(j.prompt))).toBe(false);
    expect(events(hh, id, "checkpoint.reworked").map((e) => e.data)).toEqual([{ id: "plan#1", kind: "plan", ok: true }]);
    expect(second.checkpointLog).toEqual([expect.objectContaining({ id: "plan#1", decision: "send_back", note: "only the greeting, please" })]);
    expect(hh.notifications.filter((n) => n.title.includes("please check"))).toHaveLength(2);

    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(done.features.map((f) => [f.id, f.status])).toEqual([["greet", "done"]]);
    expect(count(hh, "build-farewell")).toBe(0);
  });

  it("keeps the old plan and says so when the architect cannot make the change, and still asks again", async () => {
    const hh = harness({
      agents: { architect: (job, call) => (call.label === "spec" && call.n > 1 ? { outcome: "failed", error: "no plan" } : byDefault("architect")(job, call)) },
    });
    const id = queue(hh, "plan");
    await hh.run(id);
    answer(hh, id, "send_back", "make it different");
    const again = await hh.run(id);
    expect(again.checkpoint).toMatchObject({ id: "plan#2", state: "pending" });
    expect(again.checkpoint?.look.lines[0]).toBe("Your change could not be made, so this is the earlier plan.");
    expect(again.features.map((f) => f.id)).toEqual(["greet", "farewell"]);
    expect(again.notes).toContain("A requested change to the plan could not be made, so the earlier plan was kept.");
    expect(events(hh, id, "checkpoint.reworked").map((e) => e.data.ok)).toEqual([false]);
  });

  it("ends the mission, honestly, when the plan is sent back a third time", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    await hh.run(id);
    answer(hh, id, "send_back", "one");
    await hh.run(id);
    answer(hh, id, "send_back", "two");
    const third = await hh.run(id);
    expect(third.checkpoint).toMatchObject({ id: "plan#3", round: 3 });
    expect(third.checkpoint?.look.lines.at(-1)).toBe("You have sent this back 2 times. If you send it back again, the work stops here: nothing will be built. You can still approve.");
    answer(hh, id, "send_back", "three");
    const failed = await hh.run(id);

    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.failure).toMatchObject({
      reason: "You asked for changes to the plan twice and sent it back a third time, so Mission Control stopped before building anything.",
      retryable: false,
    });
    expect(failed.failure?.decision).toContain("Queue it again with a clearer description");
    expect(failed.checkpoint).toBeUndefined();
    expect(failed.checkpointLog?.map((r) => r.decision)).toEqual(["send_back", "send_back", "send_back"]);
    expect(events(hh, id, "checkpoint.limit")).toHaveLength(1);
    expect(labels(hh).filter((l) => l !== "spec" && l !== "gate-a")).toEqual([]); // nothing was ever built
    expect(hh.notifications.at(-1)).toMatchObject({ title: "Fixture app: failed", opts: { priority: "high" } });
  });
});

// ───────────────────────────── A feature ─────────────────────────────

describe("the feature checkpoint", () => {
  it("stops after a feature is reviewed and before it is merged; approving merges it without a second review", async () => {
    const hh = harness({ features: [feature("greet"), feature("farewell", ["greet"])] });
    const id = queue(hh, "feature");
    const parked = await hh.run(id);
    const repo = parked.repoPath;

    expect(parked).toMatchObject({ status: "stopped", stage: "features" });
    expect(parked.checkpoint).toMatchObject({ id: "feature:greet#1", kind: "feature", featureId: "greet", state: "pending" });
    expect(featureOf(parked, "greet")?.status).toBe("reviewing");
    expect(labels(hh)).toEqual(["spec", "gate-a", "init", "test-greet", "context-greet", "build-greet", "review-greet"]);
    expect(inBranch(repo, parked.integrationBranch, "src/greet.mjs")).toBe(false); // not added yet
    const look = parked.checkpoint?.look;
    expect(look?.headline).toBe("Check “Feature greet” before it is added");
    expect(look?.lines[0]).toBe("“Feature greet” is built and passed its checks, and was reviewed.");
    expect(look?.branch).toBe(`${parked.integrationBranch}--greet`);
    expect(look?.commit).toBe(featureOf(parked, "greet")?.passingCommit?.slice(0, 10));
    expect(look?.files).toEqual(expect.arrayContaining(["src/greet.mjs", "tests/greet.test.mjs"]));
    expect(hh.notifications[0]?.title).toBe("Fixture app: please check “Feature greet” before it is added");
    // The steps the report gives work: the unit branch (checked out in its own worktree) opens detached in the app folder.
    git(repo, "checkout", "--detach", look?.branch as string);
    expect(existsSync(join(repo, "src/greet.mjs"))).toBe(true);
    git(repo, "checkout", "main");

    answer(hh, id, "approve");
    const second = await hh.run(id);
    expect(inBranch(repo, parked.integrationBranch, "src/greet.mjs")).toBe(true);
    expect(second.checkpoint).toMatchObject({ id: "feature:farewell#1", featureId: "farewell" });
    expect(count(hh, "review-greet")).toBe(1); // the resume did not ask the reviewer again
    expect(featureOf(second, "greet")?.status).toBe("done");

    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(done.checkpointLog?.map((r) => r.scope)).toEqual(["feature:greet", "feature:farewell"]);
    expect(count(hh, "review-greet")).toBe(1);
    expect(count(hh, "review-farewell")).toBe(1);
  });

  it("lets the engineer change the work with the owner's note, reviews it again, and asks again", async () => {
    const hh = harness({ features: [feature("greet")], agents: { engineer: fixing } });
    const id = queue(hh, "feature");
    await hh.run(id);
    const before = featureOf(hh.load(id), "greet")?.passingCommit;
    answer(hh, id, "send_back", "make it louder");
    const again = await hh.run(id);

    expect(again.checkpoint).toMatchObject({ id: "feature:greet#2", round: 2, state: "pending" });
    expect(count(hh, "fix-greet")).toBe(1);
    expect(hh.jobsLabeled("fix-greet")[0]?.prompt).toContain("The owner looked at this and asked: make it louder");
    expect(hh.jobs.filter((j) => j.prompt.includes("make it louder")).map(labelOf)).toEqual(["fix-greet"]); // no other AI reads the note
    expect(count(hh, "review-greet")).toBe(2);
    const greet = featureOf(again, "greet");
    expect(greet?.passingCommit).not.toBe(before);
    expect(greet?.reviewRounds).toBe(0); // the owner's change does not use up the review rounds
    expect(greet?.attempts.at(-1)).toMatchObject({ action: "fix", outcome: "pass" });
    expect(events(hh, id, "checkpoint.reworked").map((e) => e.data)).toEqual([{ id: "feature:greet#1", kind: "feature", feature: "greet", ok: true }]);

    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(readFileSync(join(done.repoPath, "src/touched-1.mjs"), "utf8")).toContain("n = 1");
  });

  it("rolls back a change that fails its checks and shows the unchanged work, saying so", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: { engineer: (job, call) => (call.label.startsWith("fix-") ? { edit: (cwd) => implementFeature(cwd, "greet", "wrong"), structured: buildOutput("broke it") } : byDefault("engineer")(job, call)) },
    });
    const id = queue(hh, "feature");
    await hh.run(id);
    const before = featureOf(hh.load(id), "greet")?.passingCommit;
    answer(hh, id, "send_back", "change it");
    const again = await hh.run(id);

    expect(featureOf(again, "greet")?.passingCommit).toBe(before);
    expect(again.checkpoint).toMatchObject({ id: "feature:greet#2" });
    expect(again.checkpoint?.look.lines[0]).toBe("Your change could not be made, so this is the earlier version.");
    expect(count(hh, "review-greet")).toBe(1); // the work did not change, so it is not reviewed again
    expect(events(hh, id, "checkpoint.reworked").map((e) => e.data.ok)).toEqual([false]);
  });

  it("sets the feature aside when it is sent back a third time, and carries on with the rest", async () => {
    const hh = harness({ features: [feature("greet"), feature("solo")], agents: { engineer: fixing } });
    const id = queue(hh, "feature");
    await hh.run(id);
    answer(hh, id, "send_back", "one");
    await hh.run(id);
    answer(hh, id, "send_back", "two");
    const third = await hh.run(id);
    expect(third.checkpoint).toMatchObject({ id: "feature:greet#3" });
    expect(third.checkpoint?.look.lines.at(-1)).toContain("the work stops here: this feature is set aside and the rest carries on");
    answer(hh, id, "send_back", "three");
    const next = await hh.run(id);

    const greet = featureOf(next, "greet");
    expect(greet).toMatchObject({ status: "blocked", blockedReason: "you asked for changes twice and it still was not right" });
    expect(greet?.branch).toBeDefined(); // the branch keeps the work
    expect(next.decisionsNeeded).toContain('"Feature greet": you asked for changes twice and it still was not right');
    expect(events(hh, id, "checkpoint.limit").map((e) => e.data)).toEqual([{ kind: "feature", feature: "greet" }]);
    expect(next.checkpoint).toMatchObject({ id: "feature:solo#1" }); // the other feature still gets its turn

    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done.status).toBe("partial");
    expect(done.features.map((f) => [f.id, f.status])).toEqual([["greet", "blocked"], ["solo", "done"]]);
  });

  it("does not stop for the features the engine adds by itself", async () => {
    let reviewed = 0;
    const hh = harness({
      features: [feature("greet")],
      agents: {
        reviewer: (job, call) => {
          if (call.label === "gate-c" && ++reviewed === 1) return { structured: review([finding("blocker", "greet is broken")]) };
          return byDefault("reviewer")(job, call);
        },
      },
    });
    const id = queue(hh, "feature");
    await hh.run(id);
    answer(hh, id, "approve");
    const done = await hh.run(id); // gate C adds gate-c-fix-1, which is built and merged without a stop
    expect(done.status).toBe("done");
    expect(done.features.map((f) => f.id)).toEqual(["greet", "gate-c-fix-1"]);
    expect(done.checkpointLog?.map((r) => r.scope)).toEqual(["feature:greet"]);
  });
});

// ───────────────────────────── The finished app ─────────────────────────────

describe("the final checkpoint", () => {
  it("stops after the final checks and before anything is finished or published", async () => {
    const hh = harness({ features: [feature("greet")] });
    const id = queue(hh, "final");
    const parked = await hh.run(id);

    expect(parked).toMatchObject({ status: "stopped", stage: "finalize" });
    expect(parked.checkpoint).toMatchObject({ id: "final#1", kind: "final", state: "pending" });
    expect(labels(hh)).toEqual(["spec", "gate-a", "init", "test-greet", "context-greet", "build-greet", "review-greet", "gate-c"]);
    expect(await hh.git.headSha(parked.repoPath, "main")).toBe(parked.baseSha); // main has not moved
    expect(parked.integrationWorktree).toBeDefined(); // kept while it waits
    const look = parked.checkpoint?.look;
    expect(look?.headline).toBe("Check the finished app “Fixture app”");
    expect(look?.lines).toEqual(["The 1 feature is built.", "The final checks passed."]);
    expect(look?.branch).toBe(parked.integrationBranch);
    expect(look?.files).toEqual(expect.arrayContaining(["src/greet.mjs"]));
    const report = readFileSync(hh.store.reportPath(id), "utf8");
    expect(report).toContain("git checkout --detach");
    expect(report).toContain(`mc approve ${id}`);
    git(parked.repoPath, "checkout", "--detach", parked.integrationBranch); // the kept integration worktree does not stop it
    expect(existsSync(join(parked.repoPath, "src/greet.mjs"))).toBe(true);
    git(parked.repoPath, "checkout", "main");

    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(await hh.git.headSha(done.repoPath, "main")).toBe(await hh.git.headSha(done.repoPath, done.integrationBranch));
    expect(readFileSync(hh.store.reportPath(id), "utf8")).toContain("| The finished app | Approved |");
  });

  it("counts the built features in plain words: all of several, and how many of them when one is set aside", async () => {
    // Two features, both built.
    const two = harness();
    const twoId = queue(two, "final");
    const parkedTwo = await two.run(twoId);
    expect(parkedTwo.features).toHaveLength(2);
    expect(parkedTwo.checkpoint?.look.lines[0]).toBe("All 2 features are built.");
    h?.cleanup();

    // Two features, one set aside after three send-backs: the line counts the built ones.
    const some = harness({ features: [feature("greet"), feature("solo")], agents: { engineer: fixing } });
    const someId = queue(some, "feature", "final");
    await some.run(someId);
    for (const note of ["one", "two", "three"]) {
      answer(some, someId, "send_back", note);
      await some.run(someId);
    }
    answer(some, someId, "approve"); // the other feature
    const parkedSome = await some.run(someId);
    expect(parkedSome.features.map((f) => [f.id, f.status])).toEqual([["greet", "blocked"], ["solo", "done"]]);
    expect(parkedSome.checkpoint).toMatchObject({ kind: "final" });
    expect(parkedSome.checkpoint?.look.lines[0]).toBe("1 of 2 features are built.");
  });

  it("adds the owner's change as a feature, builds and checks it, and asks again", async () => {
    const hh = harness({ features: [feature("greet")] });
    const id = queue(hh, "feature", "final");
    await hh.run(id);
    answer(hh, id, "approve");
    await hh.run(id);
    expect(checkpointOf(hh, id)?.id).toBe("final#1");
    answer(hh, id, "send_back", "add a farewell too");
    const again = await hh.run(id);

    const change = featureOf(again, "owner-change-1");
    expect(change).toMatchObject({ status: "done", title: "The change you asked for", story: "add a farewell too" });
    expect(change?.acceptance).toEqual(["The change the owner asked for is in place: add a farewell too", "The full verification still passes."]);
    expect(again.checkpoint).toMatchObject({ id: "final#2", round: 2 });
    expect(count(hh, "gate-c")).toBe(2);
    expect(again.gateCRounds).toBe(0);
    expect(hh.jobsLabeled("test-owner-change-1")[0]?.prompt).toContain("add a farewell too");
    expect(events(hh, id, "checkpoint.parked").map((e) => e.data.id)).toEqual(["feature:greet#1", "final#1", "final#2"]);
    // The engine's own feature did not stop for a look of its own.
    expect(again.checkpointLog?.map((r) => r.scope)).toEqual(["feature:greet", "final"]);

    answer(hh, id, "approve");
    expect((await hh.run(id)).status).toBe("done");
  });

  it("finalizes what there is, partly done, when the finished app is sent back a third time", async () => {
    const hh = harness({ features: [feature("greet")] });
    const id = queue(hh, "final");
    await hh.run(id);
    answer(hh, id, "send_back", "one");
    await hh.run(id);
    answer(hh, id, "send_back", "two");
    const third = await hh.run(id);
    expect(third.checkpoint?.look.lines.at(-1)).toBe("You have sent this back 2 times. If you send it back again, the work stops here: the finished result is kept as it is. You can still approve.");
    answer(hh, id, "send_back", "three");
    const end = await hh.run(id);

    expect(end).toMatchObject({ status: "partial", stage: "complete" });
    expect(end.features.map((f) => f.id)).toEqual(["greet", "owner-change-1", "owner-change-2"]); // no third one
    expect(end.decisionsNeeded).toContain("You sent the finished result back twice; it was finalized as it is.");
    expect(end.checkpointLog?.filter((r) => r.decision === "send_back")).toHaveLength(3);
    expect(events(hh, id, "checkpoint.limit").map((e) => e.data)).toEqual([{ kind: "final" }]);
    expect(await hh.git.headSha(end.repoPath, "main")).toBe(await hh.git.headSha(end.repoPath, end.integrationBranch));
  });
});

// ───────────────────────────── Resuming, and not trusting the file ─────────────────────────────

describe("resuming and idempotency", () => {
  it("passes an approved check once, even when the run that was to continue stopped first", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    await hh.run(id);
    answer(hh, id, "approve");
    hh.store.requestStop();
    const stopped = await hh.run(id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.checkpoint).toMatchObject({ state: "answered" });
    expect(events(hh, id, "checkpoint.passed")).toHaveLength(0);
    hh.store.clearStop();

    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(events(hh, id, "checkpoint.passed")).toHaveLength(1);
    expect(done.checkpointLog).toHaveLength(1);
    expect(count(hh, "gate-a")).toBe(1);
  });

  it("does not ask the architect again when the plan was already changed before the stop", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    const parked = await hh.run(id);
    answer(hh, id, "send_back", "change the plan");
    // The state a crash right after the architect's answer was adopted leaves behind: a new plan, the old one's fingerprint.
    edit(hh, id, (m) => {
      m.checkpoint = { ...(m.checkpoint as PendingCheckpoint), reworkFrom: sha256(JSON.stringify(parked.spec)) };
      m.spec = { ...(m.spec as NonNullable<Mission["spec"]>), summary: "Changed before the crash." };
    });
    const again = await hh.run(id);
    expect(count(hh, "spec")).toBe(1);
    expect(again.checkpoint).toMatchObject({ id: "plan#2", state: "pending" });
    expect(again.checkpoint?.look.lines[0]).toBe("Changed before the crash.");
  });

  it("does not run the engineer again when the feature was already changed before the stop", async () => {
    const hh = harness({ features: [feature("greet")], agents: { engineer: fixing } });
    const id = queue(hh, "feature");
    await hh.run(id);
    const unit = hh.load(id);
    const greet = featureOf(unit, "greet");
    const old = greet?.passingCommit as string;
    answer(hh, id, "send_back", "change it");
    // The change landed (a new passing commit) but the stop came before the answer was handled.
    writeFile(greet?.worktree as string, "src/landed.mjs", "export const landed = true;\n");
    await hh.git.commitAll(greet?.worktree as string, "fix(greet): landed");
    const landed = await hh.git.headSha(greet?.worktree as string);
    edit(hh, id, (m) => {
      (featureOf(m, "greet") as NonNullable<ReturnType<typeof featureOf>>).passingCommit = landed;
      m.checkpoint = { ...(m.checkpoint as PendingCheckpoint), reworkFrom: old };
    });
    const again = await hh.run(id);
    expect(count(hh, "fix-greet")).toBe(0);
    expect(count(hh, "review-greet")).toBe(2); // the changed work is reviewed again
    expect(again.checkpoint).toMatchObject({ id: "feature:greet#2" });
    expect(again.checkpoint?.look.commit).toBe(landed.slice(0, 10));
  });

  it("does not add a second feature when the owner's change was already added before the stop", async () => {
    const hh = harness({ features: [feature("greet")] });
    const id = queue(hh, "final");
    await hh.run(id);
    answer(hh, id, "send_back", "add more");
    edit(hh, id, (m) => {
      m.checkpoint = { ...(m.checkpoint as PendingCheckpoint), reworkFrom: "owner-change-1" };
      m.features.push({ ...feature("owner-change-1"), story: "add more", status: "pending", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] });
    });
    const again = await hh.run(id);
    expect(again.features.map((f) => f.id)).toEqual(["greet", "owner-change-1"]);
    expect(featureOf(again, "owner-change-1")?.status).toBe("done");
    expect(again.checkpoint).toMatchObject({ id: "final#2" });
  });

  it("leaves a waiting mission alone whatever its status word says", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    await hh.run(id);
    edit(hh, id, (m) => {
      m.status = "running"; // as a hand edit, or an older version of the file, might leave it
    });
    const jobs = hh.jobs.length;
    await hh.run(id);
    expect(hh.jobs).toHaveLength(jobs);
    expect(checkpointOf(hh, id)).toMatchObject({ state: "pending" });
  });
});

describe("an answer that was not given through the commands is not trusted", () => {
  it("throws out a hand-edited approval, asks again, and tells the phone loudly", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    await hh.run(id);
    edit(hh, id, (m) => {
      m.checkpoint = { ...(m.checkpoint as PendingCheckpoint), state: "answered", answer: { decision: "approve", at: new Date().toISOString() } };
    });
    const jobs = hh.jobs.length;
    const m = await hh.run(id);

    expect(m).toMatchObject({ status: "stopped" });
    expect(m.checkpoint).toMatchObject({ id: "plan#1", state: "pending" });
    expect(m.checkpoint?.answer).toBeUndefined();
    expect(hh.jobs).toHaveLength(jobs); // nothing went on
    expect(events(hh, id, "checkpoint.rejected").map((e) => e.data)).toEqual([{ id: "plan#1", reason: "no_record" }]);
    expect(hh.notifications).toHaveLength(2);
    expect(hh.notifications[1]).toMatchObject({ opts: { priority: "high" } });
    expect(hh.notifications[1]?.message).toContain("was ignored");
    expect(m.checkpointLog ?? []).toEqual([]);
  });

  it("throws out an answer whose event says something else", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    await hh.run(id);
    answer(hh, id, "send_back", "real answer"); // the event records a send-back...
    edit(hh, id, (m) => {
      (m.checkpoint as PendingCheckpoint).answer = { decision: "approve", at: (m.checkpoint as PendingCheckpoint).answer?.at as string }; // ...the file says approve
    });
    const m = await hh.run(id);
    expect(m.checkpoint).toMatchObject({ state: "pending", round: 1 });
    expect(events(hh, id, "checkpoint.rejected")).toHaveLength(1);
    expect(count(hh, "spec")).toBe(1);
  });

  it("drops a check that belongs to somewhere else and asks the right one", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    edit(hh, id, (m) => {
      m.checkpoint = { id: "final#1", scope: "final", kind: "final", round: 1, state: "answered", parkedAt: "2026-10-12T13:00:00.000Z", look: { headline: "x", lines: [] }, answer: { decision: "approve", at: "2026-10-12T13:30:00.000Z" } };
    });
    const m = await hh.run(id);
    expect(m.checkpoint).toMatchObject({ id: "plan#1", state: "pending" });
    expect(events(hh, id, "checkpoint.rejected").map((e) => e.data)).toEqual([{ id: "final#1", reason: "stale" }]);
  });

  it("throws out a damaged check record the same way", async () => {
    const hh = harness();
    const id = queue(hh, "plan");
    edit(hh, id, (m) => {
      m.checkpoint = { id: "plan#1" } as PendingCheckpoint;
    });
    const m = await hh.run(id); // damaged is not "waiting", so the run takes the mission and the gate replaces the record
    expect(m.checkpoint).toMatchObject({ id: "plan#1", state: "pending", kind: "plan" });
    expect(events(hh, id, "checkpoint.rejected").map((e) => e.data.reason)).toEqual(["shape"]);
  });
});
