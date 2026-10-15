// T-MODES-REAL: the work modes from the command line to the dashboard (docs/modes-spec.md, section 15, "The integrator").
//
// The fixtures of the dashboard are written by hand to the types. This test replaces trust in them with the real engine's
// output: example A and example B of the spec are queued through `mc plan queue -`, the mock team builds them (a real guide
// and a real page, so Mission Control's own checks run for real), and the dashboard builds its snapshot from a copy of what
// the engine wrote. Nothing calls an AI.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildOutput, checkerBehavior, finding, isChecker, isMaker, review, writeFile } from "./fixtures/mission-harness.js";
import { CODE_A, CODE_B, EXAMPLE_A, EXAMPLE_B, MADE, openWorld, TITLE, type World } from "./modes-real-kit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let w: World;
afterEach(() => w?.cleanup());

const missionJson = (id: string): Record<string, unknown> => JSON.parse(readFileSync(join(w.h.home, "missions", id, "mission.json"), "utf8")) as Record<string, unknown>;

describe("example A: a guide checked by a second AI, run to the end", () => {
  it("is queued with its plan code, stops only for the plan, and the Results page, the tag and the report line say how it was checked", async () => {
    w = await openWorld();
    const { id, code, said } = await w.queue(EXAMPLE_A);
    expect(code).toBe(CODE_A);
    expect(said.out).toContain("It will stop for your check: the plan.");
    expect(said.out).not.toContain("It will stop for your look at “");
    expect(Object.keys(missionJson(id))).not.toContain("ownerStops");

    expect((await w.run(id)).status).toBe("stopped"); // the plan stop, as for every plan the leader writes
    await w.approve(id);
    const done = await w.run(id);
    expect(done).toMatchObject({ status: "done", stage: "complete" });
    const [guide] = done.features;
    expect(guide).toMatchObject({ id: "setup-guide", mode: "review", status: "done", frozenTests: [] });
    expect(guide?.checked).toMatchObject({ round: 1, unjudged: 0, scripted: { problems: [] }, pictures: { taken: 0 } });
    expect(guide?.checked?.results.map((r) => r.result)).toEqual(["pass", "pass", "pass", "pass"]);

    // The report: the Checked line and the Features table, in the words of the table of spec 10.1 (row 7).
    const report = w.report(id);
    expect(report).toContain("\nChecked: 1 feature by a second AI against your list.\n");
    expect(report).toContain(`| ✅ | ${TITLE.guide} | Built; a second AI checked it against your list (4 of 4 passed) |`);
    expect(report).not.toContain("Built and checked");

    // The dashboard, built from a copy of what the engine wrote: the sentence of the Results page, the tag of the feature and the ticks.
    const s = w.snapshot();
    const [mission] = s.debrief?.missions ?? [];
    expect(mission?.verdict).toEqual({ id: "done", word: "Done", sentence: "The feature is built. The list below says how it was checked." });
    expect(mission?.got.map((f) => [f.title, f.checkedBy])).toEqual([[TITLE.guide, "Checked by a second AI against your list"]]);
    expect(mission?.ticks.find((t) => t.id === "delivered")?.why).toBe("The feature was built. It was checked by a second AI against your list.");
    expect(mission?.ticks.find((t) => t.id === "final_review")?.caveat).toBe("1 feature has no tests. The list below says how it was checked.");
    expect(s.debrief?.honestyNote).toBe("These are the AI team's own checks, not a human review."); // nobody was asked to look at a feature
    expect(s.missions[0]).toMatchObject({ state: "done", sentence: "The feature is built." });
    const timeline = s.timeline.items.map((i) => i.text);
    expect(timeline).toContain(`A second AI checked “${TITLE.guide}” against your list: 4 of 4 checks passed.`);
    expect(timeline).toContain(`“${TITLE.guide}” is added.`);
    expect(JSON.stringify(s)).not.toMatch(/built and checked|were tested/);
    expect(s.needsYou).toEqual([]);
  });
});

describe("example B: a page marked for the owner's look, run to the owner's stop", () => {
  it("stops at the feature with the card of spec 11.3, and after the owner's answer the Results page says it was approved", async () => {
    w = await openWorld();
    const { id, code, said } = await w.queue(EXAMPLE_B);
    expect(code).toBe(CODE_B);
    expect(said.out).toContain(`It will stop for your look at “${TITLE.page}”, before it is added.`);
    await w.run(id); // the plan stop
    await w.approve(id);
    const parked = await w.run(id);
    expect(parked).toMatchObject({ status: "stopped", checkpoint: { kind: "feature", featureId: "landing-page", state: "pending" } });
    expect(parked.features[0]).toMatchObject({ mode: "owner", effort: "deep", status: "reviewing" });
    expect(w.renderer.requests).toHaveLength(1); // the page was drawn once, at both widths
    expect(parked.checkpoint?.look.screenshots).toHaveLength(2);

    const s = w.snapshot();
    expect(s.needsYou).toHaveLength(1);
    const [card] = s.needsYou;
    expect(card).toMatchObject({
      kind: "checkpoint",
      severity: "look",
      missionId: id,
      featureId: "landing-page",
      title: `“Landing page”: please check “${TITLE.page}” before it is added`,
      happened: { text: "The team stopped here because this feature is marked for your look, and you look at it first.", author: "engine" },
      summary: `The second AI's answer on each check is in the report, and so are the pictures when there are any. The work is saved under the name mc/${id}--landing-page.`,
    });
    // The first lines of the look are the engine's, in the order of spec 10.2: what was built, the answers, the scripted checks, the pictures, why the owner is asked.
    expect(card?.lines?.map((l) => l.text)).toEqual([
      `“${TITLE.page}” is built. No tests were written for it. A second AI checked it against your list.`,
      "The second AI's answers: 4 passed, 0 failed, 0 could not be judged.",
      "Mission Control's own checks passed.",
      "Pictures of the page as it first loads: 2 taken, at phone width and desktop width. To see them in Windows, run mc copy-reports in Ubuntu, then open the screenshots folder.",
      "You are asked because the plan marks this feature for your look.",
    ]);
    expect(s.missions[0]).toMatchObject({ state: "paused", pausedWhy: "checkpoint", sentence: `Waiting for your check of “${TITLE.page}”.` });
    expect(s.lamp).toMatchObject({ state: "needs_look", word: "Needs a look" });

    // The owner approves through the command line; the team adds the feature and finishes.
    await w.approve(id);
    const done = await w.run(id);
    expect(done).toMatchObject({ status: "done", stage: "complete" });
    const end = w.snapshot();
    expect(end.needsYou).toEqual([]);
    expect(end.debrief?.missions[0]?.got.map((f) => f.checkedBy)).toEqual(["Checked by a second AI against your list; approved by you"]);
    expect(end.debrief?.honestyNote).toBe(`These are the AI team's own checks. You were asked to look at “${TITLE.page}” and approved it.`);
    expect(end.timeline.items.map((i) => i.text)).toContain(`“${TITLE.page}” is added.`);
    expect(w.report(id)).toContain("\nChecked: 1 feature by a second AI against your list and approved by you.\n");
  });

  it("queued with --no-owner-checkpoint it runs straight through, and every surface says the stop was left out, never that the owner chose not to look", async () => {
    w = await openWorld();
    const { id, said } = await w.queue(EXAMPLE_B, ["--no-owner-checkpoint"]);
    expect(said.out).toContain("It will not stop for your look at features marked “owner” or at features the second AI could not fully judge.");
    expect(missionJson(id).ownerStops).toBe(false);
    const planStop = await w.run(id); // the plan stop: the stop where the owner decides, so it must not promise a look that will not happen
    const planLines = (planStop.checkpoint?.look.lines ?? []).join("\n");
    expect(planLines).toContain("Checked by for “One-page landing page”: a second AI, against its list of checks. It was queued without a stop for your look. No tests are written for it.");
    expect(planLines).toContain("How the features are checked: 1 by a second AI, queued without a stop for your look.");
    expect(planLines).not.toContain("and then by you");
    await w.approve(id);
    const done = await w.run(id);
    expect(done.status).toBe("done");
    expect(done.checkpointLog?.map((c) => c.scope)).toEqual(["plan"]); // no answer about the feature was asked for
    expect(w.report(id)).toContain("\nChecked: 1 feature by a second AI against your list (it was queued without a stop for your look).\n");
    const s = w.snapshot();
    expect(s.debrief?.missions[0]?.got.map((f) => f.checkedBy)).toEqual(["Checked by a second AI against your list; queued without a stop for your look"]);
    expect(s.debrief?.honestyNote).toBe("These are the AI team's own checks, not a human review.");
    expect(JSON.stringify(s)).not.toMatch(/chose not to look|looked at it/);
  });
});

describe("example B: the final review's repair rewrites the page the owner approved", () => {
  it("stops for the owner before it is added, and the card, the lamp and the report say why", async () => {
    const page = MADE["landing-page"]!;
    const world: { w?: World } = {};
    w = world.w = await openWorld({
      agents: {
        engineer: (job, call) => {
          if (isMaker(job) && call.feature === "landing-page") return { edit: (cwd) => writeFile(cwd, page.path, page.text), structured: buildOutput("wrote it") };
          if (isMaker(job) && call.feature === "gate-c-fix-1") {
            return { edit: (cwd) => writeFile(cwd, page.path, page.text.replace("<h1>Keep your habits going</h1>", "<h1>Keep your habits going, every day</h1>")), structured: buildOutput("repaired") };
          }
          return world.w!.h.defaults.engineer(job, call);
        },
        reviewer: (job, call) => {
          if (call.label === "gate-c" && call.n === 1) return { structured: review([finding("major", "The headline is too short", page.path)]) };
          if (isChecker(job)) return checkerBehavior(job, (results) => results.forEach((r) => (r.evidence = `The file says “${page.quote}” in ${page.path}.`)));
          return world.w!.h.defaults.reviewer(job, call);
        },
      },
    });
    const { id } = await w.queue(EXAMPLE_B);
    await w.run(id); // the plan stop
    await w.approve(id);
    await w.run(id); // the owner's stop at the page
    await w.approve(id);
    const parked = await w.run(id);
    expect(parked).toMatchObject({ status: "stopped", checkpoint: { kind: "feature", featureId: "gate-c-fix-1", round: 1, state: "pending" } });
    expect(parked.features.find((f) => f.id === "gate-c-fix-1")?.changesApproved).toEqual(["landing-page"]);

    const s = w.snapshot();
    expect(s.needsYou).toHaveLength(1);
    expect(s.needsYou[0]).toMatchObject({
      kind: "checkpoint",
      severity: "look",
      featureId: "gate-c-fix-1",
      title: "“Landing page”: please check “Fix problems found in the final review” before it is added",
      happened: { text: "The team stopped here because this repair changes work you approved earlier, so you look at it first.", author: "engine" },
    });
    expect(s.needsYou[0]?.lines?.map((l) => l.text)).toContain(`You are asked because this repair changes work you approved earlier: “${TITLE.page}”.`);
    expect(s.needsYou[0]?.summary).toBe(`The work is saved under the name mc/${id}--gate-c-fix-1. The report says how to open it.`);
    expect(s.lamp).toMatchObject({ state: "needs_look" });
    expect(w.report(id)).toContain("because the repair “Fix problems found in the final review” changes work you approved earlier");

    await w.approve(id);
    const done = await w.run(id);
    expect(done).toMatchObject({ status: "done", stage: "complete" });
    expect(w.report(id)).toContain("Checked: 2 features by a second AI against your list and approved by you.");
    expect(w.snapshot().debrief?.missions[0]?.got.map((f) => f.checkedBy)).toEqual([
      "Checked by a second AI against your list; approved by you",
      "Checked by a second AI against your list; approved by you",
    ]);
  });
});

describe("example A when the project's own checks were already failing", () => {
  it("never says the final checks passed: the look at the final stop, the Results page and the timeline agree that nothing could judge the result", async () => {
    w = await openWorld({ broken: true });
    const { id } = await w.queue(EXAMPLE_A, ["--checkpoint", "final"]);
    await w.run(id); // the plan stop
    await w.approve(id);
    const parked = await w.run(id);
    expect(parked).toMatchObject({ status: "stopped", checkpoint: { kind: "final", state: "pending" } });
    const lines = parked.checkpoint?.look.lines ?? [];
    expect(lines).toContain("The project's own checks were already failing, so no final check could judge the result.");
    expect(lines.join("\n")).not.toMatch(/final checks passed/i);
    // the same card, as the dashboard shows it
    expect(w.snapshot().needsYou[0]?.lines?.map((l) => l.text)).toContain("The project's own checks were already failing, so no final check could judge the result.");

    await w.approve(id);
    const done = await w.run(id);
    expect(done).toMatchObject({ status: "done", stage: "complete" }); // nothing failed, so nothing is repaired and the mission is not held back
    expect(done.features.map((f) => f.id)).toEqual(["setup-guide"]); // no repair feature was added for a failure that predates the mission
    expect(JSON.parse(readFileSync(join(w.h.home, "missions", id, "dispatch.json"), "utf8")).finalVerify).toMatchObject({ ok: true, judged: false, reviewed: true });
    const end = w.snapshot();
    const tick = end.debrief?.missions[0]?.ticks.find((t) => t.id === "final_review");
    expect(tick).toMatchObject({ state: "no", why: "No final check could judge the result, because the project's own checks were already failing." });
    expect(end.timeline.items.map((i) => i.text)).toContain("The project's own full check failed. It was already failing before this work started.");
    expect(JSON.stringify(end)).not.toMatch(/final checks (of the whole app )?passed/i);
  });

  it("a plan with no mode keeps what it always did: the final check counts as passed and nothing new is recorded", async () => {
    w = await openWorld({ broken: true });
    const dark = readFileSync(join(__dirname, "fixtures", "plans", "dark-mode.txt"), "utf8");
    const { id } = await w.queue(dark, ["--checkpoint", "final"]);
    await w.run(id);
    await w.approve(id);
    const parked = await w.run(id);
    expect(parked.checkpoint?.look.lines).toContain("The final checks passed.");
    expect(JSON.parse(readFileSync(join(w.h.home, "missions", id, "dispatch.json"), "utf8")).finalVerify).not.toHaveProperty("judged");
  });
});
