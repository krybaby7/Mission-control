// T-MODES-REAL: the work modes from the command line to the dashboard (docs/modes-spec.md, section 15, "The integrator").
//
// The fixtures of the dashboard are written by hand to the types. This test replaces trust in them with the real engine's
// output: example A and example B of the spec are queued through `mc plan queue -`, the mock team builds them (a real guide
// and a real page, so Mission Control's own checks run for real), and the dashboard builds its snapshot from a copy of what
// the engine wrote. Nothing calls an AI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_A, CODE_B, EXAMPLE_A, EXAMPLE_B, openWorld, TITLE, type World } from "./modes-real-kit.js";

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
    await w.run(id); // the plan stop
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
