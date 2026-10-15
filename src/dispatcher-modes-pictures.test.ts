// A page feature whose second AI was shown no picture (docs/modes-spec.md, M11 and 7.3, and the review of Wave 2).
//
// The spec says that when no picture could be taken or shown, every check that needs one is "not judged" and the owner is shown the
// feature in every case. The engine cannot tell which checks need a picture, so it used to rely on the second AI marking them: a second AI
// that passed the layout checks from the text anyway let the feature merge with no stop and no sentence anywhere. Now "a page was expected
// and the second AI was shown no picture of it" is a reason to stop of its own (unless the plan was queued without the stops for the
// owner's look, and then every surface says that no picture was shown).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentHandler, buildOutput, checkerBehavior, checksInBrief, fakeRenderer, MissionHarness, planSource, writeDeliverable, writeFile } from "../test/fixtures/mission-harness.js";
import { applyAnswer } from "./checkpoint.js";
import type { Mission } from "./types.js";

let h: MissionHarness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const PAGE =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Landing</title>\n</head>\n<body>\n<h1>Get started</h1>\n<p>The fixture app answers.</p>\n</body>\n</html>\n';
const CHECKS = ["The page has a headline.", "The page has a button.", "On a phone the page is one column."];
const PLAN = (lines: string): string => `mc-plan 1
name: Fixture app
request: Make a page for the fixture app.
app-name: Fixture App
summary: A page for the fixture app.
assumption: The page is in English.

feature: guide
title: Landing page
story: As a visitor I can see what the app does.
${lines}
${CHECKS.map((c) => `check: ${c}`).join("\n")}
`;

/** The builder makes the page and the file of the checks; the second AI passes every check from the text, with no picture (the lazy answer). */
function team(opts: ConstructorParameters<typeof MissionHarness>[0] = {}): MissionHarness {
  const engineer: AgentHandler = (job, call) =>
    call.label === "build-guide" || call.label === "fix-guide"
      ? { edit: (cwd) => { writeFile(cwd, "index.html", PAGE); writeDeliverable(cwd, "guide", checksInBrief(job.prompt)); }, structured: buildOutput("made the page") }
      : hh.defaults.engineer(job, call);
  const reviewer: AgentHandler = (job, call) => (call.label.startsWith("review-") ? checkerBehavior(job, undefined, { openPictures: true }) : hh.defaults.reviewer(job, call));
  const hh = new MissionHarness({ agents: { engineer, reviewer }, ...opts });
  h = hh;
  return hh;
}

const answer = (hh: MissionHarness, id: string, decision: "approve" | "send_back"): void => {
  expect(applyAnswer(hh.store, id, { decision }, hh.clock.now()).ok).toBe(true);
};
const report = (hh: MissionHarness, id: string): string => readFileSync(hh.store.reportPath(id), "utf8");
const parkedIds = (hh: MissionHarness, id: string): string[] => hh.store.readEvents(id).filter((e) => e.type === "checkpoint.parked").map((e) => String(e.data.id));
const guideOf = (m: Mission) => m.features.find((f) => f.id === "guide")!;

describe("a page feature whose second AI was shown no picture", () => {
  it.each([
    ["no_tool", "No pictures were taken: the picture tool is not available."],
    ["no_browser", "No pictures were taken: no browser was found in the container."],
    ["start_failed", "No pictures were taken: the browser could not start."],
    ["too_slow", "No pictures were taken: the page took too long to load."],
    ["not_plain_file", "No pictures were taken: a page is not a plain file inside the project."],
  ] as const)("stops for the owner when no picture could be taken (%s), although the second AI passed every check from the text", async (why, said) => {
    const hh = team({ renderer: fakeRenderer({ why }) });
    const id = hh.createMission("greenfield", { plan: planSource(PLAN("mode: review")) }).id;
    const stopped = await hh.run(id);

    expect(guideOf(stopped).checked).toMatchObject({ unjudged: 0, pictures: { taken: 0, why } });
    expect(guideOf(stopped).checked?.results.map((r) => r.result)).toEqual(["pass", "pass", "pass"]); // the lazy answer: nothing was "not judged"
    expect(stopped.status).toBe("stopped");
    expect(stopped.checkpoint).toMatchObject({ kind: "feature", featureId: "guide", round: 1, state: "pending" });
    expect(stopped.checkpoint?.look.lines).toContain(said);
    expect(stopped.checkpoint?.look.lines).toContain("You are asked because the second AI was shown no picture of the page.");
    expect(report(hh, id)).toContain("because the second AI was shown no picture of “Landing page”");

    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(parkedIds(hh, id)).toEqual(["feature:guide#1"]);
    expect(report(hh, id)).toContain("Checked: 1 feature by a second AI against your list and approved by you.");
  });

  it("stops when the pictures were taken but could not be given to the second AI (a reviewer pinned to Codex)", async () => {
    const hh = team();
    const id = hh.createMission("greenfield", { plan: planSource(PLAN("mode: review")), roleOverrides: [{ role: "reviewer", family: "codex" }] }).id;
    const stopped = await hh.run(id);
    expect(guideOf(stopped).checked).toMatchObject({ unjudged: 0, pictures: { taken: 2, why: "reviewer" } });
    expect(stopped.checkpoint).toMatchObject({ kind: "feature", featureId: "guide", state: "pending" });
    expect(stopped.checkpoint?.look.lines).toContain("The second AI could not look at the pictures (it runs on a different tool). Please look at them yourself.");
    expect(stopped.checkpoint?.look.lines).toContain("You are asked because the second AI was shown no picture of the page.");
  });

  it("does not stop when the pictures were taken and given to a Claude second AI, or when the feature has no page", async () => {
    const withPictures = team();
    const a = withPictures.createMission("greenfield", { plan: planSource(PLAN("mode: review")) }).id;
    const m = await withPictures.run(a);
    expect(m.status).toBe("done");
    expect(guideOf(m).checked?.pictures).toEqual({ taken: 2 });
    expect(parkedIds(withPictures, a)).toEqual([]);
    withPictures.cleanup();

    const noPage = new MissionHarness({ agents: { reviewer: (job, call) => (call.label.startsWith("review-") ? checkerBehavior(job) : noPage.defaults.reviewer(job, call)) } });
    h = noPage;
    const b = noPage.createMission("greenfield", { plan: planSource(PLAN("mode: review")) }).id;
    const done = await noPage.run(b);
    expect(done.status).toBe("done"); // the default builder writes a document, not a page: nothing was expected
    expect(guideOf(done).checked?.pictures).toEqual({ taken: 0 });
  });

  it("with the plan queued without the stops for the owner's look it does not stop, and the report, the table and the line say that no picture was shown", async () => {
    const hh = team({ renderer: fakeRenderer({ why: "no_browser" }) });
    const id = hh.createMission("greenfield", { plan: planSource(PLAN("mode: review")), ownerStops: false }).id;
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(parkedIds(hh, id)).toEqual([]);
    const text = report(hh, id);
    expect(text).toContain("Checked: 1 feature by a second AI against your list (it was queued without a stop for your look; no picture was shown to the second AI).");
    expect(text).toContain("Built; a second AI checked it against your list (3 of 3 passed); it was queued without a stop for your look; no picture was shown to the second AI");
    expect(text).not.toContain("approved by you");
  });

  it("an owner feature stops as before, with its own reason, and says no more", async () => {
    const hh = team({ renderer: fakeRenderer({ why: "no_browser" }) });
    const id = hh.createMission("greenfield", { plan: planSource(PLAN("mode: owner")) }).id;
    const stopped = await hh.run(id);
    expect(stopped.checkpoint?.look.lines).toContain("You are asked because the plan marks this feature for your look.");
    expect(stopped.checkpoint?.look.lines).toContain("No pictures were taken: no browser was found in the container.");
    expect(stopped.checkpoint?.look.lines.join("\n")).not.toContain("shown no picture");
  });
});
