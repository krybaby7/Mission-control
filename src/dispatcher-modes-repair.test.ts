// The final review's repair after the owner approved work (docs/modes-spec.md, M23, and the review of Wave 2).
//
// A feature marked `owner` is approved by the owner at its stop. If the final review then finds a serious problem, the team adds a repair
// feature (`gate-c-fix-N`), which never stopped for the owner. When that repair rewrote the approved file, the report still said "approved
// by you" for text the owner had never seen in its new form, and a plain `mc plan queue` has no final stop. Now the repair stops when it
// changed a file of work the owner approved, in a mission of any kind, and it does not stop when it left those files alone.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentHandler, buildOutput, checkerBehavior, finding, labelOf, MissionHarness, planSource, review, writeFile } from "../test/fixtures/mission-harness.js";
import { applyAnswer } from "./checkpoint.js";
import type { Mission } from "./types.js";

let h: MissionHarness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const PLAN_HEAD = `mc-plan 1
name: Fixture app
request: Write the documents of the fixture app.
app-name: Fixture App
summary: Documents for the fixture app.
assumption: The documents are in English.
`;
const CHECKS = ["The guide says how to start the app.", "The guide says what the reader should see.", "The guide names the answer."];
const guide = (lines = "mode: owner"): string => `feature: guide\ntitle: Setup guide\nstory: As a reader I can follow a short guide.\n${lines}\n${CHECKS.map((c) => `check: ${c}`).join("\n")}\n`;
const greet = (): string => "feature: greet\ntitle: Feature greet\nstory: As a user I want greet.\ncheck: answer in src/greet.mjs returns greet\n";
const plan = (...blocks: string[]): string => `${PLAN_HEAD}\n${blocks.join("\n")}`;

const REWRITE = "# guide\n\nThe guide says how to start the app.\n\nThe guide says what the reader should see.\n\nThe guide names the answer.\n\nA whole new paragraph that the owner never saw.\n";
const NEW_LINE = "A whole new paragraph that the owner never saw.";

/** Gate C answers once with a serious finding; the repair is written by `repairWrites`. */
function team(repairWrites: (cwd: string) => void): MissionHarness {
  const blockingOnce: AgentHandler = (job, call) => {
    if (call.label === "gate-c" && call.n === 1) return { structured: review([finding("major", "The guide contradicts itself in step two", "docs/guide.md")]) };
    return call.label.startsWith("review-") ? checkerBehavior(job) : hh.defaults.reviewer(job, call);
  };
  const repairing: AgentHandler = async (job, call) => {
    const base = await hh.defaults.engineer(job, call);
    if (call.label !== "build-gate-c-fix-1" && call.label !== "fix-gate-c-fix-1") return base;
    return { ...base, edit: async (cwd, j) => {
        await base.edit?.(cwd, j);
        repairWrites(cwd);
      }, structured: buildOutput("repaired") };
  };
  const hh = new MissionHarness({ agents: { reviewer: blockingOnce, engineer: repairing } });
  h = hh;
  return hh;
}

const answer = (hh: MissionHarness, id: string, decision: "approve" | "send_back", note?: string): void => {
  expect(applyAnswer(hh.store, id, { decision, ...(note !== undefined && { note }) }, hh.clock.now()).ok).toBe(true);
};
const parked = (hh: MissionHarness, id: string): string[] => hh.store.readEvents(id).filter((e) => e.type === "checkpoint.parked").map((e) => String(e.data.id));
const guideInBranch = (hh: MissionHarness, id: string): string => execFileSync("git", ["-C", hh.store.load(id).repoPath, "show", `mc/${id}:docs/guide.md`], { encoding: "utf8" });
const featureOf = (m: Mission, id: string) => m.features.find((f) => f.id === id)!;
const report = (hh: MissionHarness, id: string): string => readFileSync(hh.store.reportPath(id), "utf8");

describe("a repair that changes work the owner approved", () => {
  it("stops for the owner before it is added, says why, and keeps the approved text in the mission branch until the owner answers", async () => {
    const hh = team((cwd) => writeFile(cwd, "docs/guide.md", REWRITE));
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    await hh.run(id);
    answer(hh, id, "approve"); // the owner's stop at the guide
    const stopped = await hh.run(id);

    expect(stopped.status).toBe("stopped");
    expect(stopped.checkpoint).toMatchObject({ kind: "feature", scope: "feature:gate-c-fix-1", featureId: "gate-c-fix-1", round: 1, state: "pending" });
    expect(featureOf(stopped, "gate-c-fix-1")).toMatchObject({ mode: "review", changesApproved: ["guide"], status: "reviewing" });
    expect(stopped.checkpoint?.look.headline).toBe("Check “Fix problems found in the final review” before it is added");
    expect(stopped.checkpoint?.look.lines).toContain("You are asked because this repair changes work you approved earlier: “Setup guide”.");
    expect(stopped.checkpoint?.look.files).toContain("docs/guide.md");
    expect(guideInBranch(hh, id)).not.toContain(NEW_LINE); // not merged: the owner has not seen it
    // The report and the phone say why the team stopped, in the same words.
    expect(report(hh, id)).toContain("because the repair “Fix problems found in the final review” changes work you approved earlier");

    // Asking again while it waits repeats nothing.
    const reviews = hh.jobsLabeled("review-gate-c-fix-1").length;
    expect((await hh.run(id)).status).toBe("stopped");
    expect(hh.jobsLabeled("review-gate-c-fix-1")).toHaveLength(reviews);

    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done).toMatchObject({ status: "done", stage: "complete" });
    expect(guideInBranch(hh, id)).toContain(NEW_LINE);
    expect(parked(hh, id)).toEqual(["feature:guide#1", "feature:gate-c-fix-1#1"]);
    expect(done.checkpointLog?.map((r) => [r.scope, r.decision])).toEqual([["feature:guide", "approve"], ["feature:gate-c-fix-1", "approve"]]);
    // Both were approved by the owner, and the report says so of both: the second words are true now.
    expect(report(hh, id)).toContain("Checked: 2 features by a second AI against your list and approved by you.");
  });

  it("is sent back with a note like any other stop: the repair is changed, shown again as round 2, and the approved text is still not replaced", async () => {
    const hh = team((cwd) => writeFile(cwd, "docs/guide.md", REWRITE));
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    await hh.run(id);
    answer(hh, id, "approve");
    await hh.run(id);
    answer(hh, id, "send_back", "Please leave the second step as it was.");
    const again = await hh.run(id);
    expect(again.checkpoint).toMatchObject({ scope: "feature:gate-c-fix-1", round: 2, state: "pending" });
    expect(hh.jobs.map(labelOf)).toContain("fix-gate-c-fix-1");
    expect(guideInBranch(hh, id)).not.toContain(NEW_LINE);
    expect(again.checkpoint?.look.lines).toContain("You are asked again because you sent it back.");
  });

  it("stops in a mixed mission as well, where the repair is a feature checked by tests", async () => {
    const hh = team((cwd) => writeFile(cwd, "docs/guide.md", REWRITE));
    const id = hh.createMission("greenfield", { plan: planSource(plan(greet(), guide())) }).id;
    await hh.run(id);
    answer(hh, id, "approve");
    const stopped = await hh.run(id);
    expect(stopped.status).toBe("stopped");
    const repair = featureOf(stopped, "gate-c-fix-1");
    expect(repair.mode).toBeUndefined();
    expect(repair.changesApproved).toEqual(["guide"]);
    expect(stopped.checkpoint).toMatchObject({ scope: "feature:gate-c-fix-1", round: 1 });
    expect(stopped.checkpoint?.look.lines).toContain("You are asked because this repair changes work you approved earlier: “Setup guide”.");
    expect(guideInBranch(hh, id)).not.toContain(NEW_LINE);
    answer(hh, id, "approve");
    expect((await hh.run(id)).status).toBe("done");
    expect(guideInBranch(hh, id)).toContain(NEW_LINE);
  });

  it("is not switched off by the flag that removes the stops the plan asks for, since an approval is in the log only because the owner was asked", async () => {
    // The owner asked to look at every feature, and also queued the plan without the stops for the owner's look.
    const hh = team((cwd) => writeFile(cwd, "docs/guide.md", REWRITE));
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())), checkpoints: ["feature"], ownerStops: false }).id;
    await hh.run(id);
    answer(hh, id, "approve");
    const stopped = await hh.run(id);
    expect(stopped.checkpoint).toMatchObject({ scope: "feature:gate-c-fix-1", state: "pending" });
  });
});

describe("a repair that leaves the approved work alone", () => {
  it("does not stop: it is added as before, and nothing is recorded on it", async () => {
    const hh = team((cwd) => writeFile(cwd, "docs/other.md", "# other\n\nA note about something else.\n"));
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    await hh.run(id);
    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done).toMatchObject({ status: "done", stage: "complete" });
    expect(Object.keys(featureOf(done, "gate-c-fix-1"))).not.toContain("changesApproved");
    expect(parked(hh, id)).toEqual(["feature:guide#1"]);
    expect(report(hh, id)).toContain("Checked: 1 feature by a second AI against your list; 1 feature by a second AI against your list and approved by you.");
  });

  it("does not stop when the owner approved nothing, even if the repair rewrites a file the owner was never asked about", async () => {
    const hh = team((cwd) => writeFile(cwd, "docs/guide.md", REWRITE));
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: review"))) }).id;
    const done = await hh.run(id);
    expect(done).toMatchObject({ status: "done", stage: "complete" });
    expect(parked(hh, id)).toEqual([]);
    expect(Object.keys(featureOf(done, "gate-c-fix-1"))).not.toContain("changesApproved");
    expect(report(hh, id)).not.toContain("approved by you");
  });

  it("does not stop when the plan was queued without the stop for the owner's look: there is no approval to protect", async () => {
    const hh = team((cwd) => writeFile(cwd, "docs/guide.md", REWRITE));
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())), ownerStops: false }).id;
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(parked(hh, id)).toEqual([]);
    expect(report(hh, id)).toContain("it was queued without a stop for your look");
  });
});
