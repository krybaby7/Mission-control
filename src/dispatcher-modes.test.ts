import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentHandler,
  buildOutput,
  checkerBehavior,
  checksInBrief,
  createFixtureRepo,
  type FakeRenderer,
  fakeRenderer,
  feature,
  finding,
  type HarnessOptions,
  labelOf,
  MissionHarness,
  picturesInBrief,
  planSource,
  review,
  specOutput,
  writeDeliverable,
  writeFile,
} from "../test/fixtures/mission-harness.js";
import { type Recording, runScenario, SCENARIOS } from "../test/fixtures/modes/scenarios.js";
import { applyAnswer } from "./checkpoint.js";
import { carryModes } from "./dispatcher.js";
import type { AgentJob, Mission, MissionEvent, RubricResult, SpecOutput } from "./types.js";

const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, "..", "test", "fixtures", "modes", "events-wave1.json"), "utf8")) as Record<string, Recording>;

// ───────────────────────────── A mission with no mode feature: nothing changes (spec 15, items 1 and 2) ─────────────────────────────

describe("a mission queued the old way", () => {
  it("has a recording for every scenario, and no other", () => {
    expect(Object.keys(GOLDEN).sort()).toEqual(Object.keys(SCENARIOS).sort());
  });

  it.each(Object.keys(SCENARIOS))("%s: the same events in the same order, the same agent runs, the same keys, as at the end of wave 1", async (name) => {
    const now = await runScenario(name);
    const then = GOLDEN[name]!;
    expect(now.events).toEqual(then.events);
    expect(now.labels).toEqual(then.labels);
    expect(now.eventKeys).toEqual(then.eventKeys);
    expect(now.missionKeys).toEqual(then.missionKeys);
    expect(now.featureKeys).toEqual(then.featureKeys);
    expect({ status: now.status, stage: now.stage, features: now.features }).toEqual({ status: then.status, stage: then.stage, features: then.features });
  });

  it("holds no mode, effort, expect, checked or ownerStops key, and writes no picture and none of the three new events", async () => {
    for (const name of Object.keys(SCENARIOS)) {
      const rec = GOLDEN[name]!;
      expect(rec.missionKeys, name).not.toContain("ownerStops");
      for (const key of ["mode", "effort", "expect", "checked"]) expect(rec.featureKeys, name).not.toContain(key);
      for (const type of ["deliverable.checked", "pictures.taken", "rubric.checked"]) expect(rec.events, name).not.toContain(type);
    }
  });
});

// ───────────────────────────── Helpers ─────────────────────────────

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const ASTRA = "gpt-6-astra";
const SOL = "gpt-6.1-sol";

let h: MissionHarness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function harness(opts: HarnessOptions = {}): MissionHarness {
  h = new MissionHarness(opts);
  return h;
}

/** A plan with the given feature blocks (see `guide`). */
function plan(...blocks: string[]): string {
  return `mc-plan 1
name: Fixture app
request: Write the documents of the fixture app.
app-name: Fixture App
summary: Documents for the fixture app.
assumption: The documents are in English.

${blocks.join("\n")}`;
}

const CHECKS = ["The guide says how to start the app.", "The guide says what the reader should see.", "The guide names the answer."];

/** A feature block of the plan: `mode: review` unless `lines` says otherwise. */
function guide(lines = "mode: review", id = "guide", needs = ""): string {
  return `feature: ${id}\ntitle: Setup guide\nstory: As a reader I can follow a short guide.\n${needs}${lines}\n${CHECKS.map((c) => `check: ${c}`).join("\n")}\n`;
}

/** A feature block that is checked by tests (the fixture app knows how to build `greet`). */
function greet(lines = ""): string {
  return `feature: greet\ntitle: Feature greet\nstory: As a user I want greet.\n${lines}check: answer in src/greet.mjs returns greet\n`;
}

const labels = (hh: MissionHarness): string[] => hh.jobs.map(labelOf);
const count = (hh: MissionHarness, label: string): number => hh.jobsLabeled(label).length;
const eventsOf = (hh: MissionHarness, id: string, type?: string): MissionEvent[] => hh.store.readEvents(id).filter((e) => type === undefined || e.type === type);
const types = (hh: MissionHarness, id: string): string[] => eventsOf(hh, id).map((e) => e.type);
const reportOf = (hh: MissionHarness, id: string): string => readFileSync(hh.store.reportPath(id), "utf8");
const runsOf = (jobs: AgentJob[]): [string, string, string][] => jobs.map((j) => [labelOf(j), j.model, j.effort]);
const featureOf = (m: Mission, id = "guide") => m.features.find((f) => f.id === id)!;

const answer = (hh: MissionHarness, id: string, decision: "approve" | "send_back", note?: string): void => {
  const result = applyAnswer(hh.store, id, { decision, ...(note !== undefined && { note }) }, hh.clock.now());
  expect(result.ok, JSON.stringify(result)).toBe(true);
};

/** A checker whose first answers are changed by `tweak` (a run of the same label with `call.n` up to `times`). */
function checkerTweaked(tweak: (results: RubricResult[]) => void, times = Number.POSITIVE_INFINITY, opts: { openPictures?: boolean } = {}): AgentHandler {
  return (job, call) => {
    if (call.label === "gate-a") return { structured: { verdict: "approve", issues: [] } };
    if (call.label === "gate-c") return { structured: review() };
    return checkerBehavior(job, call.n <= times ? tweak : undefined, opts);
  };
}

/** Check `n` (from 1) fails, with a reason. */
const fails = (n: number) => (results: RubricResult[]) => {
  results[n - 1] = { ...results[n - 1]!, result: "fail", evidence: "It never says what the reader should see." };
};
/** Check `n` (from 1) could not be judged. */
const cannot = (n: number) => (results: RubricResult[]) => {
  results[n - 1] = { ...results[n - 1]!, result: "cannot_judge", evidence: "The check is about taste, which cannot be seen." };
};

const missionDir = (hh: MissionHarness, id: string): string => hh.store.missionDir(id);

// ───────────────────────────── The path of a feature that is checked by reading (spec 5.2) ─────────────────────────────

describe("a feature checked by a second AI (mode review)", () => {
  it("(1) has no test author, one builder and one checker, writes its events, saves what was found, and is on the Checked line", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);

    expect(m).toMatchObject({ status: "done", stage: "complete" });
    // Nothing but the scout, one maker and one checker for the feature: no test author, no digest, no diagnosis.
    expect(labels(hh).filter((l) => l.endsWith("guide"))).toEqual(["context-guide", "build-guide", "review-guide"]);
    expect(labels(hh).some((l) => l.startsWith("test-") || l.startsWith("diagnose-") || l.startsWith("digest-"))).toBe(false);
    expect(hh.jobsLabeled("build-guide")[0]?.systemPrompt.startsWith("# Role: maker")).toBe(true);
    expect(hh.jobsLabeled("review-guide")[0]?.systemPrompt.startsWith("# Role: checker")).toBe(true);
    const f = featureOf(m);
    expect(f.status).toBe("done");
    expect(f.frozenTests).toEqual([]);
    expect(f.checked).toMatchObject({ round: 1, reviewer: "claude", unjudged: 0, scripted: { problems: [] }, pictures: { taken: 0 } });
    expect(f.checked?.results.map((r) => [r.n, r.result, r.basis])).toEqual([[1, "pass", "text"], [2, "pass", "text"], [3, "pass", "text"]]);
    expect(eventsOf(hh, id, "deliverable.checked").map((e) => e.data)).toEqual([{ feature: "guide", label: "a1", ok: true, problems: 0 }]);
    expect(eventsOf(hh, id, "rubric.checked").map((e) => e.data)).toEqual([{ feature: "guide", round: 1, pass: 3, fail: 0, unjudged: 0, downgraded: 0, reviewer: "claude" }]);
    expect(eventsOf(hh, id, "feature.status").map((e) => [e.data.from, e.data.to])).toEqual([["pending", "building"], ["building", "reviewing"], ["reviewing", "done"]]);
    expect(reportOf(hh, id)).toContain("Checked: 1 feature by a second AI against your list.");
    expect(reportOf(hh, id)).toContain("Built; a second AI checked it against your list (3 of 3 passed)");
  });

  it("the builder's brief names the checks and the script, and not a frozen test or a verify command", async () => {
    const hh = harness();
    await hh.run(hh.createMission("greenfield", { plan: planSource(plan(guide("mode: review\nheading: guide\nmention: guide\nwords: 1-500"))) }).id);
    const brief = hh.jobsLabeled("build-guide")[0]?.prompt ?? "";
    expect(brief).toContain("Make the deliverable for feature `guide`");
    CHECKS.forEach((c, i) => expect(brief).toContain(`${i + 1}. ${c}`));
    expect(brief).toContain("Checks the second AI will judge, one by one:");
    expect(brief).toContain("It has the headings “guide”.");
    expect(brief).toContain("Its new text is 1 to 500 words long.");
    expect(brief).not.toMatch(/frozen|acceptance test|verify/i);
    expect(hh.jobsLabeled("build-guide")[0]?.access).toBe("workspace-write");
    expect(hh.jobsLabeled("review-guide")[0]?.access).toBe("read-only");
  });

  it("(2) climbs to the next rung when Mission Control's checks find a problem, with the problems in the next brief and no digest or diagnosis", async () => {
    const hh = harness({
      agents: {
        engineer: (job, call) => (call.label === "build-guide" && call.n === 1 ? { edit: (cwd) => writeFile(cwd, "docs/guide.md", ""), structured: buildOutput("tried") } : hh.defaults.engineer(job, call)),
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);

    expect(m.status).toBe("done");
    expect(featureOf(m).attempts.map((a) => [a.rung, a.action, a.outcome, a.model, a.effort])).toEqual([
      [0, "build", "fail", SOL, "medium"],
      [1, "build", "pass", SOL, "high"],
    ]);
    expect(featureOf(m).attempts[0]?.summary).toBe("“docs/guide.md” is empty.");
    expect(hh.jobsLabeled("build-guide")[0]?.prompt).not.toContain("The previous attempt failed");
    expect(hh.jobsLabeled("build-guide")[1]?.prompt).toContain("## The previous attempt failed");
    expect(hh.jobsLabeled("build-guide")[1]?.prompt).toContain("- “docs/guide.md” is empty.");
    expect(hh.jobsLabeled("build-guide")[1]?.prompt).toContain("escalation step 2");
    expect(count(hh, "digest-guide") + count(hh, "diagnose-guide")).toBe(0);
    expect(eventsOf(hh, id, "deliverable.checked").map((e) => [e.data.label, e.data.ok, e.data.problems])).toEqual([["a1", false, 1], ["a2", true, 0]]);
  });

  it("(3) sets the feature aside when the ladder is used up: four build rungs, no diagnose, and the mission is partly done", async () => {
    const hh = harness({ agents: { engineer: (job, call) => (call.label === "build-guide" ? { edit: (cwd) => writeFile(cwd, "docs/guide.md", ""), structured: buildOutput("tried") } : hh.defaults.engineer(job, call)) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);

    expect(count(hh, "build-guide")).toBe(4);
    expect(featureOf(m)).toMatchObject({ status: "blocked", blockedReason: "tried every escalation step, but Mission Control's own checks still failed: “docs/guide.md” is empty." });
    expect(m.status).toBe("partial");
    expect(count(hh, "review-guide")).toBe(0);
    expect(runsOf(hh.jobsLabeled("build-guide")).map(([, model, effort]) => `${model} ${effort}`)).toEqual([`${SOL} medium`, `${SOL} high`, `${OPUS} high`, `${ASTRA} high`]);
  });

  it("(4) sends a failed check back to the builder, checks the fix with Mission Control's checks, and asks the checker again", async () => {
    const hh = harness({ agents: { reviewer: checkerTweaked(fails(2), 1) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);

    expect(m.status).toBe("done");
    expect(labels(hh).filter((l) => l.endsWith("guide"))).toEqual(["context-guide", "build-guide", "review-guide", "fix-guide", "review-guide"]);
    const fixBrief = hh.jobsLabeled("fix-guide")[0]?.prompt ?? "";
    expect(fixBrief).toContain("## Problems to fix");
    expect(fixBrief).toContain("Check 2 is not met: The guide says what the reader should see.");
    expect(fixBrief).toContain("It never says what the reader should see.");
    expect(hh.jobsLabeled("fix-guide")[0]?.systemPrompt.startsWith("# Role: maker")).toBe(true);
    expect(eventsOf(hh, id, "deliverable.checked").map((e) => e.data.label)).toEqual(["a1", "fix1"]);
    expect(eventsOf(hh, id, "rubric.checked").map((e) => [e.data.round, e.data.pass, e.data.fail])).toEqual([[1, 2, 1], [2, 3, 0]]);
    expect(featureOf(m).checked?.round).toBe(2);
    expect(featureOf(m).reviewRounds).toBe(1);
    expect(hh.jobsLabeled("review-guide")[1]?.prompt).toContain("Last time check 2 failed.");
  });

  it("(5) merges after the rounds are used up (2, and 3 at deep), keeps the unmet check as a serious finding, and ends partly done", async () => {
    const hh = harness({ agents: { reviewer: checkerTweaked(fails(1)) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);

    expect(count(hh, "review-guide")).toBe(3);
    expect(count(hh, "fix-guide")).toBe(2);
    expect(featureOf(m).status).toBe("done");
    expect(featureOf(m).openFindings.map((x) => [x.severity, x.description.startsWith("Check 1 is not met: The guide says how to start the app.")])).toEqual([["major", true]]);
    expect(m.status).toBe("partial");
    expect(m.decisionsNeeded.join(" ")).toContain("serious finding");
    expect(reportOf(hh, id)).toContain("Built, but 1 of 3 checks were not met (see the review notes)");
    expect(reportOf(hh, id)).toContain("Checked: 1 feature by a second AI against your list (1 check not met).");

    const deep = harness({ agents: { reviewer: checkerTweaked(fails(1)) } });
    const deepId = deep.createMission("greenfield", { plan: planSource(plan(guide("mode: review\neffort: deep"))) }).id;
    await deep.run(deepId);
    expect(count(deep, "review-guide")).toBe(4);
    expect(count(deep, "fix-guide")).toBe(3);
  });

  it("(6) stops for the owner's look when a check could not be judged, merges on approval, and does not stop with ownerStops false", async () => {
    const hh = harness({ agents: { reviewer: checkerTweaked(cannot(2)) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const parked = await hh.run(id);

    expect(parked).toMatchObject({ status: "stopped", stage: "features" });
    expect(parked.checkpoint).toMatchObject({ scope: "feature:guide", kind: "feature", round: 1, state: "pending" });
    const lines = parked.checkpoint?.look.lines ?? [];
    expect(lines).toContain("You are asked because the second AI could not judge 1 of the checks.");
    expect(lines).toContain("Check 2 (not judged): The guide says what the reader should see. The check is about taste, which cannot be seen.");
    expect(featureOf(parked).checked?.unjudged).toBe(1);
    expect(hh.notifications.at(-1)?.message).toContain("the second AI could not judge every check of “Setup guide”");
    expect(hh.notifications.at(-1)?.message).not.toContain("you asked to look");

    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(count(hh, "review-guide")).toBe(1); // the stop was found again without asking the checker a second time
    expect(reportOf(hh, id)).toContain("Checked: 1 feature by a second AI against your list, except 1 check it could not judge and approved by you.");

    const flagged = harness({ agents: { reviewer: checkerTweaked(cannot(2)) } });
    const flaggedId = flagged.createMission("greenfield", { plan: planSource(plan(guide())), ownerStops: false }).id;
    const m = await flagged.run(flaggedId);
    expect(m.status).toBe("done");
    expect(types(flagged, flaggedId).some((t) => t.startsWith("checkpoint."))).toBe(false);
    expect(reportOf(flagged, flaggedId)).toContain("Built; 1 check was not judged by anyone; it was queued without a stop for your look");
    expect(reportOf(flagged, flaggedId)).toContain("(it was queued without a stop for your look)");
  });
});

describe("a feature the plan marks for the owner's look (mode owner)", () => {
  it("(7) always stops, shows the look in the order of the spec, merges on approval, and does not ask the checker twice", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: owner"))) }).id;
    const parked = await hh.run(id);

    expect(parked.checkpoint).toMatchObject({ scope: "feature:guide", round: 1, state: "pending" });
    expect(parked.checkpoint?.look.headline).toBe("Check “Setup guide” before it is added");
    expect(parked.checkpoint?.look.lines).toEqual([
      "“Setup guide” is built. No tests were written for it. A second AI checked it against your list.",
      "The second AI's answers: 3 passed, 0 failed, 0 could not be judged.",
      "Mission Control's own checks passed.",
      "You are asked because the plan marks this feature for your look.",
    ]);
    expect(parked.checkpoint?.look.branch).toBeDefined();
    expect(parked.checkpoint?.look.files).toEqual(["docs/guide.md"]);
    expect(hh.notifications.at(-1)?.message).toContain("the plan marks “Setup guide” for your look");
    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(count(hh, "review-guide")).toBe(1);
    expect(reportOf(hh, id)).toContain("Checked: 1 feature by a second AI against your list and approved by you.");
  });

  it("(7) a send-back runs a fix with the note and the checker again, and stops again at round 2; the third send-back sets the feature aside", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: owner"))) }).id;
    await hh.run(id);
    answer(hh, id, "send_back", "Please add a line about the colour.");
    const again = await hh.run(id);

    expect(again.checkpoint).toMatchObject({ scope: "feature:guide", round: 2, state: "pending" });
    expect(count(hh, "fix-guide")).toBe(1);
    expect(hh.jobsLabeled("fix-guide")[0]?.prompt).toContain("The owner looked at this and asked: Please add a line about the colour.");
    expect(count(hh, "review-guide")).toBe(2);
    expect(again.checkpoint?.look.lines).toContain("You are asked again because you sent it back.");
    expect(again.checkpoint?.look.lines.some((l) => l.startsWith("The second AI's answers:") && l.endsWith("It checked 2 times."))).toBe(true);

    answer(hh, id, "send_back", "And one about the size.");
    const third = await hh.run(id);
    expect(third.checkpoint).toMatchObject({ round: 3, state: "pending" });
    expect(third.checkpoint?.look.lines.at(-1)).toContain("You have sent this back 2 times.");
    answer(hh, id, "send_back", "One more thing.");
    const aside = await hh.run(id);
    expect(featureOf(aside)).toMatchObject({ status: "blocked", blockedReason: "you asked for changes twice and it still was not right" });
    expect(aside.status).toBe("partial");
  });

  it("(7) with ownerStops false no checkpoint event is written; with --checkpoint feature it stops once, and with both it still stops at every feature, once", async () => {
    const quiet = harness();
    const quietId = quiet.createMission("greenfield", { plan: planSource(plan(guide("mode: owner"))), ownerStops: false }).id;
    const m = await quiet.run(quietId);
    expect(m.status).toBe("done");
    expect(types(quiet, quietId).some((t) => t.startsWith("checkpoint."))).toBe(false);
    expect(reportOf(quiet, quietId)).toContain("Checked: 1 feature by a second AI against your list (it was queued without a stop for your look).");

    const both = harness();
    const bothId = both.createMission("greenfield", { plan: planSource(plan(greet(), guide("mode: owner"))), checkpoints: ["feature"] }).id;
    let parked = await both.run(bothId);
    const stops: string[] = [];
    for (let i = 0; i < 6 && parked.checkpoint !== undefined; i++) {
      stops.push(parked.checkpoint.scope);
      answer(both, bothId, "approve");
      parked = await both.run(bothId);
    }
    expect(stops).toEqual(["feature:greet", "feature:guide"]);
    expect(parked.status).toBe("done");

    const flagged = harness();
    const flaggedId = flagged.createMission("greenfield", { plan: planSource(plan(greet(), guide("mode: owner"))), checkpoints: ["feature"], ownerStops: false }).id;
    const seen: string[] = [];
    let run = await flagged.run(flaggedId);
    for (let i = 0; i < 6 && run.checkpoint !== undefined; i++) {
      seen.push(run.checkpoint.scope);
      answer(flagged, flaggedId, "approve");
      run = await flagged.run(flaggedId);
    }
    expect(seen).toEqual(["feature:greet", "feature:guide"]);
  });
});

describe("the engine reads the second AI's answer with care (spec 8.3)", () => {
  it("(8) asks again once when the answer is incomplete, and counts two unusable answers as a check that did not finish", async () => {
    const once = harness({ agents: { reviewer: checkerTweaked((r) => void r.pop(), 1) } });
    const onceId = once.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const done = await once.run(onceId);
    expect(done.status).toBe("done");
    expect(count(once, "review-guide")).toBe(2);
    expect(once.jobsLabeled("review-guide")[1]?.prompt).toContain("## Your previous answer could not be used");
    expect(once.jobsLabeled("review-guide")[1]?.prompt).toContain("exactly one result for each of the 3 checks");

    const twice = harness({ agents: { reviewer: checkerTweaked((r) => void r.pop()) } });
    const twiceId = twice.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const parked = await twice.run(twiceId);
    expect(count(twice, "review-guide")).toBe(2);
    expect(featureOf(parked).checked).toMatchObject({ unfinished: true, unjudged: 3, results: [] });
    expect(parked.notes).toContain("The review of “Setup guide” did not finish, so it was merged after passing Mission Control's own checks only.");
    expect(parked.checkpoint?.look.lines[0]).toBe("“Setup guide” is built. No tests were written for it. The second AI's check did not finish.");
    expect(parked.checkpoint?.look.lines).toContain("You are asked because the second AI's check did not finish.");
    expect(eventsOf(twice, twiceId, "rubric.checked")).toEqual([]);
  });

  it("(8) turns a pass with a quote that is not in the files into a check nobody judged, and says how many answers were not trusted", async () => {
    const quote = (results: RubricResult[]) => {
      results[0] = { ...results[0]!, evidence: "The file says “this sentence is nowhere in the files at all” in docs/guide.md." };
    };
    const hh = harness({ agents: { reviewer: checkerTweaked(quote) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const parked = await hh.run(id);
    expect(featureOf(parked).checked?.results[0]).toMatchObject({ n: 1, result: "cannot_judge" });
    expect(featureOf(parked).checked?.results[0]?.evidence.startsWith("The quote was not found in the files.")).toBe(true);
    expect(eventsOf(hh, id, "rubric.checked")[0]?.data).toMatchObject({ pass: 2, fail: 0, unjudged: 1, downgraded: 1 });
    expect(parked.checkpoint?.look.lines).toContain("You are asked because the second AI could not judge 1 of the checks.");
  });

  it("(8) keeps only the files the run really opened: a Claude run that opened nothing gives an answer that is asked for again", async () => {
    const hh = harness({ agents: { reviewer: (job, call) => (call.label === "review-guide" ? { ...checkerBehavior(job), opened: [] } : hh.defaults.reviewer(job, call)) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);
    expect(count(hh, "review-guide")).toBe(2);
    expect(hh.jobsLabeled("review-guide")[1]?.prompt).toContain("at least one of the changed files that you really opened");
    expect(featureOf(m).checked?.unfinished).toBe(true);
  });

  it("(8) takes a Codex checker's list of opened files as stated, and says so in the look", async () => {
    const hh = harness({ roleOverrides: undefined } as HarnessOptions);
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: owner"))), roleOverrides: [{ role: "reviewer", family: "codex" }] }).id;
    const parked = await hh.run(id);
    expect(hh.jobsLabeled("review-guide")[0]?.provider).toBe("codex");
    expect(featureOf(parked).checked?.reviewer).toBe("codex");
    expect(parked.checkpoint?.look.lines).toContain("What the second AI opened could not be checked.");
  });

  it("(9) puts back an edit to a test file of the project and says so", async () => {
    const hh = harness({
      agents: {
        engineer: (job, call) =>
          call.label === "build-guide"
            ? {
                edit: (cwd) => {
                  writeFile(cwd, "tests/smoke.test.mjs", "// weakened\n");
                  writeDeliverable(cwd, "guide", checksInBrief(job.prompt));
                },
                structured: buildOutput("made it too"),
              }
            : hh.defaults.engineer(job, call),
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(readFileSync(join(m.repoPath, "tests", "smoke.test.mjs"), "utf8")).toContain("the app has a name");
    expect(featureOf(m).checked?.scripted.facts).toContain("The checks put back tests/smoke.test.mjs (the project's own tests or check scripts).");
    expect(eventsOf(hh, id, "frozen.reverted")).toHaveLength(1);
  });
});

// ───────────────────────────── How hard the team thinks (spec 5.3) ─────────────────────────────

describe("effort", () => {
  it("(10) light starts on the light tier, is checked on the standard tier at medium effort, and keeps the two rounds", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: review\neffort: light"))) }).id;
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    // The light model belongs to Claude, so Claude built it and the other family (Codex) checks it, on the standard tier.
    expect(runsOf(hh.jobsLabeled("build-guide"))).toEqual([["build-guide", HAIKU, "medium"]]);
    expect(runsOf(hh.jobsLabeled("review-guide"))).toEqual([["review-guide", SOL, "medium"]]);
    expect(featureOf(m).builtBy).toBe("claude");
    expect(featureOf(m).checked?.reviewer).toBe("codex");
  });

  it("(10) deep starts on the frontier tier, is checked at xhigh, and gets three rounds", async () => {
    const hh = harness({ agents: { reviewer: checkerTweaked(fails(1)) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: review\neffort: deep"))) }).id;
    await hh.run(id);
    expect(runsOf(hh.jobsLabeled("build-guide"))).toEqual([["build-guide", ASTRA, "high"]]);
    expect(runsOf(hh.jobsLabeled("review-guide")).map(([, model, effort]) => `${model} ${effort}`)).toEqual([`${OPUS} xhigh`, `${OPUS} xhigh`, `${OPUS} xhigh`, `${OPUS} xhigh`]);
    expect(count(hh, "fix-guide")).toBe(3);
  });

  it("(10) deep lifts every build rung to the frontier tier, one step up, never beyond xhigh, and leaves out the diagnose rung", async () => {
    const hh = harness({ agents: { engineer: (job, call) => (call.label === "build-guide" ? { edit: (cwd) => writeFile(cwd, "docs/guide.md", ""), structured: buildOutput("tried") } : hh.defaults.engineer(job, call)) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: review\neffort: deep"))) }).id;
    const m = await hh.run(id);
    expect(featureOf(m).status).toBe("blocked");
    expect(runsOf(hh.jobsLabeled("build-guide")).map(([, model, effort]) => `${model} ${effort}`)).toEqual([`${ASTRA} high`, `${ASTRA} xhigh`, `${OPUS} xhigh`, `${ASTRA} xhigh`]);
  });

  it("(10) a --role override of the reviewer beats the table", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", {
      plan: planSource(plan(guide("mode: review\neffort: deep"))),
      roleOverrides: [{ role: "reviewer", family: "claude", tier: "standard", effort: "high" }],
    }).id;
    await hh.run(id);
    expect(runsOf(hh.jobsLabeled("review-guide"))).toEqual([["review-guide", SONNET, "high"]]);
  });

  it("(10) a feature checked by tests takes the table too: a deep test author is on the frontier tier, a deep reviewer at xhigh, with three rounds", async () => {
    const hh = harness({ agents: { reviewer: (job, call) => (call.label === "review-greet" ? { structured: review([finding("major", "still wrong", "src/greet.mjs")]) } : hh.defaults.reviewer(job, call)) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(greet("effort: deep\n"))) }).id;
    await hh.run(id);
    expect(runsOf(hh.jobsLabeled("test-greet"))).toEqual([["test-greet", OPUS, "high"]]);
    expect(runsOf(hh.jobsLabeled("build-greet"))).toEqual([["build-greet", ASTRA, "high"]]);
    expect(runsOf(hh.jobsLabeled("review-greet")).map(([, model, effort]) => `${model} ${effort}`)).toEqual(Array(4).fill(`${OPUS} xhigh`));
    expect(count(hh, "fix-greet")).toBe(3);
  });

  it("(10) a light feature checked by tests takes the mechanical ladder; kind mechanical alone is unchanged", async () => {
    const light = harness();
    const lightId = light.createMission("greenfield", { plan: planSource(plan(greet("effort: light\n"))) }).id;
    await light.run(lightId);
    expect(runsOf(light.jobsLabeled("build-greet"))).toEqual([["build-greet", HAIKU, "medium"]]);
    expect(runsOf(light.jobsLabeled("test-greet"))).toEqual([["test-greet", SONNET, "medium"]]);

    const mechanical = harness();
    const mechanicalId = mechanical.createMission("greenfield", { plan: planSource(plan(greet("kind: mechanical\n"))) }).id;
    await mechanical.run(mechanicalId);
    expect(runsOf(mechanical.jobsLabeled("build-greet"))).toEqual([["build-greet", HAIKU, "medium"]]);
    expect(runsOf(mechanical.jobsLabeled("test-greet"))).toEqual([["test-greet", SONNET, "high"]]);
  });
});

// ───────────────────────────── The plan's brief to the team (spec 8.5) ─────────────────────────────

describe("the briefs of a mission that has a mode feature", () => {
  it("(11) gate A is told how each feature is judged; a plan with no mode gets the old bullet", async () => {
    const hh = harness();
    await hh.run(hh.createMission("greenfield", { plan: planSource(plan(greet(), guide("mode: owner\neffort: deep"))) }).id);
    const brief = hh.jobsLabeled("gate-a")[0]?.prompt ?? "";
    expect(brief).toContain("each feature fits one focused build session, and its checks can be judged: by an automated test for a feature marked as checked by tests, and by reading the result for a feature marked as checked by a second AI (it opens the files and, for a page, pictures);");
    expect(brief).not.toContain("its acceptance criteria can be checked by an automated test;");
    expect(brief).toContain("Checked by: a second AI against its list of checks, and then by the owner, no tests.\nEffort: deep.");
    expect(brief).toContain("Checked by: tests, written first.");

    const plain = harness();
    await plain.run(plain.createMission("greenfield", { plan: planSource(plan(greet())) }).id);
    expect(plain.jobsLabeled("gate-a")[0]?.prompt).toContain("each feature fits one focused build session and its acceptance criteria can be checked by an automated test;");
    expect(plain.jobsLabeled("gate-a")[0]?.prompt).not.toContain("Checked by");
  });

  it("(14) gate C gets the added paragraph, the report writer is told how each feature was checked, and the final look has the added line", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(plan(greet(), guide())), checkpoints: ["final"] }).id;
    const parked = await hh.run(id);
    const gateC = hh.jobsLabeled("gate-c")[0]?.prompt ?? "";
    expect(gateC).toContain("Some features here are documents, pages or data files that no test judged.");
    expect(gateC).toContain("Checked by a second AI against your list. No tests were written for it.");
    expect(parked.checkpoint?.look.lines.slice(0, 2)).toEqual(["All 2 features are built.", "1 feature is not checked by tests: “Setup guide”. The report says how each was checked."]);
    answer(hh, id, "approve");
    await hh.run(id);
    const prose = hh.jobsLabeled("report-prose")[0]?.prompt ?? "";
    expect(prose).toContain("Checked by: a second AI against your list. No tests were written for it.");
    expect(prose).toContain("Say how each feature was checked exactly as the facts say.");

    const plain = harness();
    await plain.run(plain.createMission("greenfield", { plan: planSource(plan(greet())) }).id);
    expect(plain.jobsLabeled("gate-c")[0]?.prompt).not.toContain("documents, pages or data files");
    expect(plain.jobsLabeled("report-prose")[0]?.prompt).not.toContain("Say how each feature was checked");
  });
});

// ───────────────────────────── Pictures (spec 7) ─────────────────────────────

const PAGE =
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Landing</title>\n</head>\n<body>\n<h1>Get started</h1>\n<p>The fixture app answers.</p>\n</body>\n</html>\n';

/** A builder that makes the page `index.html` and the checks' file. */
function pageMaker(hh: () => MissionHarness): AgentHandler {
  return (job, call) =>
    call.label === "build-guide" || call.label === "fix-guide"
      ? { edit: (cwd) => { writeFile(cwd, "index.html", PAGE); writeDeliverable(cwd, "guide", checksInBrief(job.prompt)); }, structured: buildOutput("made the page") }
      : hh().defaults.engineer(job, call);
}

/** A checker that judges check 3 on a picture. */
const picturePass = (results: RubricResult[]): void => {
  results[2] = { ...results[2]!, basis: "picture", evidence: "The picture of the page at phone width shows one column of text." };
};

describe("pictures of a page", () => {
  it("(12) a page is drawn at both widths after the checks pass; a Claude checker is given the folder and the absolute path of each picture; the owner's look lists them", async () => {
    const hh = harness({ agents: { engineer: pageMaker(() => h!), reviewer: checkerTweaked(picturePass, Number.POSITIVE_INFINITY, { openPictures: true }) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: owner"))) }).id;
    const parked = await hh.run(id);

    const names = readdirSync(join(missionDir(hh, id), "screenshots")).sort();
    expect(names).toEqual(["look__guide__1__index__desktop.png", "look__guide__1__index__phone.png"]);
    expect((hh.renderer as FakeRenderer).requests).toHaveLength(1);
    expect((hh.renderer as FakeRenderer).requests[0]?.pages).toEqual([{ path: "index.html", n: 1 }]);
    expect(eventsOf(hh, id, "pictures.taken").map((e) => e.data)).toEqual([{ feature: "guide", taken: 2 }]);
    const job = hh.jobsLabeled("review-guide")[0]!;
    expect(job.provider).toBe("claude");
    expect(job.readDirs).toEqual([join(missionDir(hh, id), "screenshots")]);
    expect(picturesInBrief(job.prompt).sort()).toEqual(names.map((n) => join(missionDir(hh, id), "screenshots", n)));
    expect(job.prompt).toContain("Open each one with the Read tool.");
    expect(featureOf(parked).checked).toMatchObject({ pictures: { taken: 2 } });
    expect(featureOf(parked).checked?.results[2]).toMatchObject({ result: "pass", basis: "picture" });
    expect(parked.checkpoint?.look.screenshots).toEqual(["screenshots/look__guide__1__index__desktop.png", "screenshots/look__guide__1__index__phone.png"]);
    expect(parked.checkpoint?.look.lines).toContain("Pictures of the page as it first loads: 2 taken, at phone width and desktop width. To see them in Windows, run mc copy-reports in Ubuntu, then open the screenshots folder.");
    expect(reportOf(hh, id)).toContain("![look guide 1 index phone](screenshots/look__guide__1__index__phone.png)");
    expect(reportOf(hh, id).match(/look__guide__1__index__phone\.png/g)).toHaveLength(1); // shown once, in the waiting block
  });

  it("(12) in the mixed profile a light page feature built by Claude is checked by Claude, not by Codex (M27)", async () => {
    const hh = harness({ agents: { engineer: pageMaker(() => h!), reviewer: checkerTweaked(picturePass, Number.POSITIVE_INFINITY, { openPictures: true }) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: review\neffort: light"))) }).id;
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(featureOf(m).builtBy).toBe("claude");
    expect(runsOf(hh.jobsLabeled("review-guide"))).toEqual([["review-guide", SONNET, "medium"]]);
    expect(hh.jobsLabeled("review-guide")[0]?.provider).toBe("claude");
    expect(featureOf(m).checked?.reviewer).toBe("claude");
    expect(featureOf(m).checked?.results[2]?.result).toBe("pass");
  });

  it("(12) a --role reviewer=codex override wins: no folder, no pictures, and every picture check cannot be judged", async () => {
    const hh = harness({ agents: { engineer: pageMaker(() => h!), reviewer: checkerTweaked(picturePass, Number.POSITIVE_INFINITY, { openPictures: true }) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: review\neffort: light"))), roleOverrides: [{ role: "reviewer", family: "codex" }] }).id;
    const parked = await hh.run(id);
    const job = hh.jobsLabeled("review-guide")[0]!;
    expect(job.provider).toBe("codex");
    expect(job.readDirs).toBeUndefined();
    expect(job.prompt).toContain("Pictures: none are given to you; you cannot open them.");
    expect(picturesInBrief(job.prompt)).toEqual([]);
    expect(featureOf(parked).checked?.results[2]).toMatchObject({ result: "cannot_judge", evidence: "No picture was opened by the second AI." });
    expect(featureOf(parked).checked?.pictures).toEqual({ taken: 2, why: "reviewer" });
    expect(parked.checkpoint?.look.lines).toContain("The second AI could not look at the pictures (it runs on a different tool). Please look at them yourself.");
    expect(eventsOf(hh, id, "rubric.checked")[0]?.data).toMatchObject({ downgraded: 1 });
  });

  it("(12) a picture tool that fails gives the reasons of spec 7.3 and every picture check cannot be judged", async () => {
    const hh = harness({ renderer: fakeRenderer({ why: "no_browser" }), agents: { engineer: pageMaker(() => h!), reviewer: checkerTweaked(picturePass, Number.POSITIVE_INFINITY, { openPictures: true }) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const parked = await hh.run(id);
    expect(hh.jobsLabeled("review-guide")[0]?.prompt).toContain("Pictures: none. No browser was found in the container.");
    expect(eventsOf(hh, id, "pictures.taken").map((e) => e.data)).toEqual([{ feature: "guide", taken: 0, why: "no_browser" }]);
    expect(featureOf(parked).checked).toMatchObject({ pictures: { taken: 0, why: "no_browser" } });
    expect(featureOf(parked).checked?.results[2]).toMatchObject({ result: "cannot_judge" });
    expect(parked.checkpoint?.look.lines).toContain("No pictures were taken: no browser was found in the container.");
    expect(parked.checkpoint?.look.screenshots).toBeUndefined();
  });

  it.each([
    ["no_tool", "Pictures: none. The picture tool is not available.", "No pictures were taken: the picture tool is not available."],
    ["start_failed", "Pictures: none. The browser could not start.", "No pictures were taken: the browser could not start."],
    ["too_slow", "Pictures: none. The page took too long to load.", "No pictures were taken: the page took too long to load."],
    ["not_plain_file", "Pictures: none. A page is not a plain file inside the project, so it was not drawn.", "No pictures were taken: a page is not a plain file inside the project."],
  ] as const)("(12) the reason %s is told to the checker and to the owner in the words of spec 7.3", async (why, told, said) => {
    const hh = harness({ renderer: fakeRenderer({ why }), agents: { engineer: pageMaker(() => h!) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: owner"))) }).id;
    const parked = await hh.run(id);
    expect(hh.jobsLabeled("review-guide")[0]?.prompt).toContain(told);
    expect(parked.checkpoint?.look.lines).toContain(said);
    expect(featureOf(parked).checked?.pictures).toEqual({ taken: 0, why });
  });

  it("(12) a failover that hands the call to Codex after the brief promised pictures turns every picture pass into a check nobody judged", async () => {
    const hh = harness({
      agents: {
        engineer: pageMaker(() => h!),
        reviewer: (job, call) => {
          if (call.label === "review-guide" && job.provider === "claude") return { outcome: "limited", limit: { kind: "session", resetsAt: Date.now() + 10 * 60_000 } };
          return checkerTweaked(picturePass, Number.POSITIVE_INFINITY, { openPictures: true })(job, call);
        },
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: review\neffort: light"))) }).id;
    const parked = await hh.run(id);
    expect(hh.jobsLabeled("review-guide").map((j) => j.provider)).toEqual(["claude", "codex"]);
    expect(featureOf(parked).checked?.reviewer).toBe("codex");
    expect(featureOf(parked).checked?.results[2]).toMatchObject({ result: "cannot_judge", evidence: "No picture was opened by the second AI." });
    expect(parked.checkpoint).toBeDefined();
  });

  it("(12) a page that scrolls sideways at phone width fails the attempt with the message of S24", async () => {
    const hh = harness({ renderer: fakeRenderer({ sideways: true }), agents: { engineer: pageMaker(() => h!) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);
    expect(featureOf(m).attempts[0]).toMatchObject({ outcome: "fail", summary: expect.stringContaining("At phone width (390 pixels), “index.html” is wider than the screen (900 pixels), so it scrolls sideways.") });
  });
});

// ───────────────────────────── Stopping and starting again ─────────────────────────────

describe("resume", () => {
  it("(13) a stop right after the builder passed: the checks are made again from the commit, and the builder is not asked twice", async () => {
    const hh = harness({ agents: { engineer: (job, call) => { if (call.label === "build-guide") h?.store.requestStop(); return hh.defaults.engineer(job, call); } } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const stopped = await hh.run(id);
    expect(stopped).toMatchObject({ status: "stopped", stage: "features" });
    expect(featureOf(stopped).status).toBe("reviewing");
    hh.store.clearStop();
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(count(hh, "build-guide")).toBe(1);
    expect(count(hh, "review-guide")).toBe(1);
    expect(eventsOf(hh, id, "deliverable.checked").map((e) => e.data.label)).toEqual(["a1", "review"]);
  });

  it("(13) a stop at the owner's stop: the answer is found again, the checker is not asked a second time, and the work merges", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: owner"))) }).id;
    await hh.run(id);
    const again = await hh.run(id); // nothing is answered: the mission stays where it is
    expect(again.checkpoint?.state).toBe("pending");
    answer(hh, id, "approve");
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(count(hh, "review-guide")).toBe(1);
    expect(count(hh, "build-guide")).toBe(1);
  });

  it("(13) a stop during the checker's call: the call is made again once", async () => {
    const stop = new AbortController();
    const hh = harness({
      agents: {
        reviewer: (job, call) => {
          if (call.label === "review-guide" && call.n === 1) {
            stop.abort();
            return { outcome: "aborted" };
          }
          return hh.defaults.reviewer(job, call);
        },
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const stopped = await hh.run(id, { signal: stop.signal });
    expect(stopped.status).toBe("stopped");
    expect(featureOf(stopped).checked).toBeUndefined();
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(count(hh, "review-guide")).toBe(2);
    expect(count(hh, "build-guide")).toBe(1);
    expect(featureOf(m).checked?.round).toBe(1);
  });
});

// ───────────────────────────── Features the engine adds itself (spec M23) ─────────────────────────────

describe("repair features", () => {
  const blockingGateC: AgentHandler = (job, call) => {
    if (call.label === "gate-c" && call.n === 1) return { structured: review([finding("major", "The guide contradicts itself", "docs/guide.md")]) };
    return h!.defaults.reviewer(job, call);
  };

  it("(15) gate C's repair is checked by reading when no finished feature is checked by tests, runs the project's own checks, and never stops for the owner", async () => {
    const hh = harness({ agents: { reviewer: blockingGateC } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: owner"))) }).id;
    await hh.run(id);
    answer(hh, id, "approve");
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    const fix = featureOf(m, "gate-c-fix-1");
    expect(fix).toMatchObject({ mode: "review", status: "done" });
    expect(labels(hh).filter((l) => l.endsWith("gate-c-fix-1"))).toEqual(["context-gate-c-fix-1", "build-gate-c-fix-1", "review-gate-c-fix-1"]);
    expect(hh.jobsLabeled("build-gate-c-fix-1")[0]?.systemPrompt.startsWith("# Role: maker")).toBe(true);
    expect(eventsOf(hh, id, "verify").some((e) => e.data.label === "gate-c-fix-1-full-a1")).toBe(true);
    expect(eventsOf(hh, id, "deliverable.checked").filter((e) => e.data.feature === "gate-c-fix-1").map((e) => e.data.projectChecks)).toEqual(["passed"]);
    expect(types(hh, id).filter((t) => t === "checkpoint.parked")).toHaveLength(1); // the owner feature only
    expect(fix.acceptance).toEqual(["The guide contradicts itself (docs/guide.md)"]);
  });

  it("(15) in a mixed mission it stays a feature checked by tests", async () => {
    const hh = harness({ agents: { reviewer: blockingGateC } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(greet(), guide())) }).id;
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(featureOf(m, "gate-c-fix-1").mode).toBeUndefined();
    expect(count(hh, "test-gate-c-fix-1")).toBe(1);
    expect(hh.jobsLabeled("build-gate-c-fix-1")[0]?.systemPrompt.startsWith("# Role: maker")).toBe(false);
  });

  it("(15) the feature a send-back at the final stop adds follows the same rule, and does not stop", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())), checkpoints: ["final"] }).id;
    await hh.run(id);
    answer(hh, id, "send_back", "Please add a line about the colour.");
    const parked = await hh.run(id);
    expect(featureOf(parked, "owner-change-1")).toMatchObject({ mode: "review", status: "done" });
    expect(parked.checkpoint).toMatchObject({ scope: "final", round: 2 });
    expect(types(hh, id).filter((t) => t === "checkpoint.parked")).toHaveLength(2); // the final stop, twice; no stop for the new feature
    answer(hh, id, "approve");
    expect((await hh.run(id)).status).toBe("done");

    const mixed = harness();
    const mixedId = mixed.createMission("greenfield", { plan: planSource(plan(greet(), guide())), checkpoints: ["final"] }).id;
    await mixed.run(mixedId);
    answer(mixed, mixedId, "send_back", "Please add a line about the colour.");
    const again = await mixed.run(mixedId);
    expect(featureOf(again, "owner-change-1").mode).toBeUndefined();
  });
});

// ───────────────────────────── The project's own checks (spec 6.4, M24) ─────────────────────────────

describe("the project's own checks", () => {
  /** A builder that also changes code: the first time it breaks `app.mjs`, which the project's smoke test reads; later it adds a harmless helper. */
  function changesCode(): AgentHandler {
    return (job, call) =>
      call.label === "build-guide"
        ? {
            edit: (cwd) => {
              writeDeliverable(cwd, "guide", checksInBrief(job.prompt));
              if (call.n === 1) writeFile(cwd, "app.mjs", 'export const name = "broken app";\n');
              else {
                writeFile(cwd, "app.mjs", 'export const name = "fixture app";\n');
                writeFile(cwd, "lib/helper.mjs", "export const helper = 1;\n");
              }
            },
            structured: buildOutput("changed the code too"),
          }
        : h!.defaults.engineer(job, call);
  }

  it("(16) a feature that changes code has them run, and a red result fails the attempt with the first lines they print", async () => {
    const hh = harness({ agents: { engineer: changesCode() } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(featureOf(m).attempts.map((a) => a.outcome)).toEqual(["fail", "pass"]);
    expect(featureOf(m).attempts[0]?.summary.startsWith("The project's own checks fail after this change. The first lines they print:")).toBe(true);
    expect(eventsOf(hh, id, "deliverable.checked").map((e) => [e.data.label, e.data.ok, e.data.projectChecks])).toEqual([["a1", false, "failed"], ["a2", true, "passed"]]);
    expect(hh.jobsLabeled("build-guide")[1]?.prompt).toContain("The project's own checks fail after this change.");
    expect(featureOf(m).checked?.scripted.facts).toContain("The project's own checks passed.");
  });

  it("(16) a feature that changes only documents does not run them; a feature the engine added itself always does", async () => {
    const hh = harness();
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    await hh.run(id);
    expect(eventsOf(hh, id, "verify").some((e) => String(e.data.label).startsWith("guide-full"))).toBe(false);
    expect(eventsOf(hh, id, "deliverable.checked")[0]?.data).not.toHaveProperty("projectChecks");
  });

  it("(16) with the project's checks red before the work, they are not run, and a fact says so", async () => {
    const hh = harness({ features: [feature("unused")] });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo, { broken: true });
    const id = hh.createMission("feature", { repoPath: repo, baseBranch: "main", plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);
    expect(m.baselineBroken).toBe(true);
    expect(featureOf(m).status).toBe("done");
    expect(featureOf(m).checked?.scripted.facts).not.toContain("The project's own checks were already failing before this work, so they were not used to judge it."); // documents only: nothing to run
  });

  it("(16) the red baseline fact is written when the feature changes code", async () => {
    const hh = harness({ agents: { engineer: (job, call) => (call.label === "build-guide" ? { edit: (cwd) => { writeDeliverable(cwd, "guide", checksInBrief(job.prompt)); writeFile(cwd, "lib/helper.mjs", "export const helper = 1;\n"); }, structured: buildOutput("added code") } : h!.defaults.engineer(job, call)) } });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo, { broken: true });
    const id = hh.createMission("feature", { repoPath: repo, baseBranch: "main", plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);
    expect(featureOf(m).checked?.scripted.facts).toContain("The project's own checks were already failing before this work, so they were not used to judge it.");
    expect(eventsOf(hh, id, "verify").some((e) => String(e.data.label).startsWith("guide-full"))).toBe(false);
  });
});

// ───────────────────────────── A send-back at a review stop (spec 5.2 step 8, rule c) ─────────────────────────────

describe("(17) a send-back at the stop of a feature checked by a second AI", () => {
  it("shows the feature again at round 2 even though every check is judged now, and does not merge it unseen", async () => {
    const hh = harness({ agents: { reviewer: checkerTweaked(cannot(2), 1) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const first = await hh.run(id);
    expect(first.checkpoint).toMatchObject({ round: 1 });
    answer(hh, id, "send_back", "Please make the second step clearer.");
    const again = await hh.run(id);
    expect(count(hh, "fix-guide")).toBe(1);
    expect(count(hh, "review-guide")).toBe(2);
    expect(featureOf(again).checked?.unjudged).toBe(0); // every check is judged now
    expect(again).toMatchObject({ status: "stopped" });
    expect(again.checkpoint).toMatchObject({ scope: "feature:guide", round: 2, state: "pending" });
    expect(again.checkpoint?.look.lines).toContain("You are asked again because you sent it back.");
    expect(featureOf(again).status).toBe("reviewing");
    answer(hh, id, "approve");
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(reportOf(hh, id)).toContain("Checked: 1 feature by a second AI against your list and approved by you.");
  });
});

// ───────────────────────────── A revision of the plan that loses a mode (spec M16) ─────────────────────────────

describe("(18) a revision of the plan", () => {
  const OWNER = guide("mode: owner\neffort: deep\nheading: guide\nwords: 1-500", "guide");
  it("is refused when it renames a feature that is checked by a second AI: the plan is kept as it was, with a note", async () => {
    const hh = harness({
      agents: {
        reviewer: (job, call) => (call.label === "gate-a" ? { structured: { verdict: "revise", issues: ["Split the guide in two."] } } : hh.defaults.reviewer(job, call)),
        architect: (job, call) => (call.label === "spec" ? { structured: specOutput([feature("setup"), feature("tour")]) } : hh.defaults.architect(job, call)),
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(plan(OWNER)), checkpoints: ["plan"] }).id;
    const parked = await hh.run(id);
    expect(parked.plan?.review).toEqual({ outcome: "not_applied", issues: ["Split the guide in two."] });
    expect(parked.notes).toContain("The plan reviewer's changed plan dropped a feature that is checked by a second AI, so the plan was used as written.");
    expect(parked.features.map((f) => [f.id, f.mode, f.effort])).toEqual([["guide", "owner", "deep"]]);
    expect(parked.features[0]?.expect).toEqual({ headings: ["guide"], words: [1, 500] });
  });

  it("is refused when it drops the feature, or has fewer features with a mode", async () => {
    const dropped = harness({
      agents: {
        reviewer: (job, call) => (call.label === "gate-a" ? { structured: { verdict: "revise", issues: ["Remove the guide."] } } : dropped.defaults.reviewer(job, call)),
        architect: (job, call) => (call.label === "spec" ? { structured: specOutput([feature("greet")]) } : dropped.defaults.architect(job, call)),
      },
    });
    const id = dropped.createMission("greenfield", { plan: planSource(plan(greet(), guide("mode: owner", "guide"))), checkpoints: ["plan"] }).id;
    const parked = await dropped.run(id);
    expect(parked.plan?.review?.outcome).toBe("not_applied");
    expect(parked.features.map((f) => [f.id, f.mode])).toEqual([["greet", undefined], ["guide", "owner"]]);
  });

  it("keeps the modes, efforts and checks by feature id when the ids stay, and a feature with a new id is checked by tests", async () => {
    const hh = harness({
      agents: {
        reviewer: (job, call) => (call.label === "gate-a" ? { structured: { verdict: "revise", issues: ["Add a second feature."] } } : hh.defaults.reviewer(job, call)),
        architect: (job, call) => (call.label === "spec" ? { structured: specOutput([feature("guide"), feature("extra")]) } : hh.defaults.architect(job, call)),
      },
    });
    const id = hh.createMission("greenfield", { plan: planSource(plan(OWNER)), checkpoints: ["plan"] }).id;
    const parked = await hh.run(id);
    expect(parked.plan?.review?.outcome).toBe("revised");
    expect(parked.features.map((f) => [f.id, f.mode, f.effort])).toEqual([["guide", "owner", "deep"], ["extra", undefined, undefined]]);
    expect(parked.features[0]?.expect).toEqual({ headings: ["guide"], words: [1, 500] });
  });

  it("is refused too when the owner sends the plan back and the planner's answer would lose a mode", async () => {
    const hh = harness({ agents: { architect: (job, call) => (call.label === "spec" ? { structured: specOutput([feature("renamed")]) } : hh.defaults.architect(job, call)) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(OWNER)), checkpoints: ["plan"] }).id;
    await hh.run(id);
    answer(hh, id, "send_back", "Please rename the guide.");
    const again = await hh.run(id);
    expect(again.features.map((f) => [f.id, f.mode])).toEqual([["guide", "owner"]]);
    expect(again.notes).toContain("The changed plan dropped a feature that is checked by a second AI, so the plan you sent back was kept as it was.");
    expect(again.checkpoint?.look.lines[0]).toBe("Your change could not be made, so this is the earlier plan.");
  });

  it("carryModes: nothing changes for a plan with no mode, and the answer is returned as it came", () => {
    const next = specOutput([feature("a")]);
    const previous = specOutput([feature("a"), feature("b")]);
    const carried = carryModes(previous, next);
    expect(carried).toEqual({ ok: true, spec: next });
    expect(carried.ok && carried.spec).toBe(next);
  });
});

// ───────────────────────────── A review that did not finish, merged with the flag (spec 5.4) ─────────────────────────────

describe("(19) an unfinished review merged with the flag", () => {
  it("is merged with the note, reads as row 4, and is still counted by the host script", async () => {
    const hh = harness({ agents: { reviewer: checkerTweaked((r) => void r.pop()) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())), ownerStops: false }).id;
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(m.notes.filter((n) => /^The review of .* did not finish/.test(n))).toEqual(["The review of “Setup guide” did not finish, so it was merged after passing Mission Control's own checks only."]);
    expect(featureOf(m).checked).toMatchObject({ unfinished: true });
    expect(types(hh, id).some((t) => t.startsWith("checkpoint."))).toBe(false);
    const report = reportOf(hh, id);
    expect(report).toContain("Checked: 1 feature by Mission Control's own checks only (the second AI's check did not finish) (it was queued without a stop for your look).");
    expect(report).toContain("Built; the second AI's check did not finish, so only Mission Control's own checks ran; it was queued without a stop for your look");
  });

  it("a feature checked by tests whose review did not finish gets the same note with curly marks and its old ending", async () => {
    const hh = harness({ features: [feature("greet")], agents: { reviewer: (job, call) => (call.label === "review-greet" ? { outcome: "failed", error: "no answer" } : hh.defaults.reviewer(job, call)) } });
    const id = hh.createMission("greenfield").id;
    const m = await hh.run(id);
    expect(m.notes).toContain("The review of “Feature greet” did not finish, so it was merged after passing its checks.");
  });
});

// ───────────────────────────── More about pictures (spec 7.1) ─────────────────────────────

/** One byte-exact 1 by 1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("which files are pictured", () => {
  const writeBytes = (cwd: string, path: string, bytes: Buffer): void => {
    writeFile(cwd, path, "");
    writeFileSync(join(cwd, path), bytes);
  };

  it("draws at most four pages, in sorted order, and names each by its place in the list", async () => {
    const pages = ["a.html", "b.html", "c.html", "d.html", "e.html", "f.html"];
    const hh = harness({
      agents: { engineer: (job, call) => (call.label === "build-guide" ? { edit: (cwd) => { for (const p of pages) writeFile(cwd, p, PAGE); writeDeliverable(cwd, "guide", checksInBrief(job.prompt)); }, structured: buildOutput("pages") } : hh.defaults.engineer(job, call)) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    await hh.run(id);
    expect((hh.renderer as FakeRenderer).requests[0]?.pages).toEqual([{ path: "a.html", n: 1 }, { path: "b.html", n: 2 }, { path: "c.html", n: 3 }, { path: "d.html", n: 4 }]);
    expect(readdirSync(join(missionDir(hh, id), "screenshots"))).toHaveLength(8);
  });

  it("copies a changed picture for the owner under the name of spec 7.1 and offers it to the checker by its path in the working folder", async () => {
    const hh = harness({
      agents: { engineer: (job, call) => (call.label === "build-guide" ? { edit: (cwd) => { writeBytes(cwd, "images/logo.png", PNG); writeDeliverable(cwd, "guide", checksInBrief(job.prompt)); }, structured: buildOutput("a logo") } : hh.defaults.engineer(job, call)) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide("mode: owner"))) }).id;
    const parked = await hh.run(id);
    expect(readdirSync(join(missionDir(hh, id), "screenshots"))).toEqual(["look__guide__image1__images-logo.png"]);
    expect(hh.jobsLabeled("review-guide")[0]?.prompt).toContain("- images/logo.png: image");
    expect(hh.jobsLabeled("review-guide")[0]?.readDirs).toBeUndefined(); // it opens the file where it is
    expect((hh.renderer as FakeRenderer).requests).toEqual([]); // a picture needs no drawing
    expect(parked.checkpoint?.look.screenshots).toEqual(["screenshots/look__guide__image1__images-logo.png"]);
  });

  it("draws the page of the project that nothing changed in when the feature changed a style sheet, and then a problem of that page is only a fact", async () => {
    const hh = harness({
      renderer: fakeRenderer({ text: () => "" }),
      agents: { engineer: (job, call) => (call.label === "build-guide" ? { edit: (cwd) => { writeFile(cwd, "styles.css", "body { margin: 0; }\n"); writeDeliverable(cwd, "guide", checksInBrief(job.prompt)); }, structured: buildOutput("css") } : hh.defaults.engineer(job, call)) } });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo);
    writeFileSync(join(repo, "index.html"), PAGE);
    await hh.git.commitAll(repo, "a page");
    const id = hh.createMission("feature", { repoPath: repo, baseBranch: "main", plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect((hh.renderer as FakeRenderer).requests[0]?.pages).toEqual([{ path: "index.html", n: 1 }]);
    expect(featureOf(m).attempts.map((a) => a.outcome)).toEqual(["pass"]);
    expect(featureOf(m).checked?.scripted.facts).toContain("“index.html” shows nothing: the page is blank.");
  });

  it("does not draw the project's page for a feature that only wrote documents", async () => {
    const hh = harness();
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo);
    writeFileSync(join(repo, "index.html"), PAGE);
    await hh.git.commitAll(repo, "a page");
    const id = hh.createMission("feature", { repoPath: repo, baseBranch: "main", plan: planSource(plan(guide())) }).id;
    await hh.run(id);
    expect((hh.renderer as FakeRenderer).requests).toEqual([]);
    expect(eventsOf(hh, id, "pictures.taken")).toEqual([]);
  });

  it("in the codex profile, where the owner chose to use only Codex, the pictures are not given to the checker", async () => {
    const hh = harness({ agents: { engineer: pageMaker(() => h!) } });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())), profile: "codex" }).id;
    const parked = await hh.run(id);
    expect(hh.jobsLabeled("review-guide")[0]?.provider).toBe("codex");
    expect(hh.jobsLabeled("review-guide")[0]?.prompt).toContain("Pictures: none are given to you; you cannot open them.");
    expect(featureOf(parked).checked?.pictures).toEqual({ taken: 2, why: "reviewer" });
  });

  it("a picture of a page is taken again from the work that stays when a fix is rolled back", async () => {
    const hh = harness({
      agents: {
        engineer: (job, call) => (call.label === "fix-guide" ? { edit: (cwd) => { writeFile(cwd, "index.html", PAGE.replace("<h1>Get started</h1>", "<h1>Get started now</h1>")); writeDeliverable(cwd, "guide", checksInBrief(job.prompt)); }, structured: buildOutput("a wide one") } : pageMaker(() => h!)(job, call)),
        reviewer: checkerTweaked(fails(1), 1),
      },
      renderer: fakeRenderer({ sideways: (call) => call === 2 }),
    });
    const id = hh.createMission("greenfield", { plan: planSource(plan(guide())) }).id;
    const m = await hh.run(id);
    // The fix made the page too wide at phone width, so Mission Control's checks rolled it back; the first work stays, and so do its pictures.
    expect(featureOf(m).attempts.map((a) => [a.action, a.outcome])).toEqual([["build", "pass"], ["fix", "fail"]]);
    expect(readFileSync(join(m.repoPath, "index.html"), "utf8")).toContain("<h1>Get started</h1>");
    expect((hh.renderer as FakeRenderer).requests).toHaveLength(3); // the first work, the fix, and the first work again
    expect(eventsOf(hh, id, "pictures.taken")).toHaveLength(3);
  });
});

describe("carryModes", () => {
  const withModes = (): SpecOutput => ({
    ...specOutput([feature("a"), feature("b"), feature("c")]),
    features: [
      { ...feature("a"), mode: "review", effort: "deep", expect: { headings: ["Install"], words: [1, 9] } },
      { ...feature("b"), mode: "owner" },
      feature("c"),
    ],
  });

  it("gives mode, effort and expect back by id, strips them from a new id, and copies the expect rather than sharing it", () => {
    const previous = withModes();
    const next = specOutput([{ ...feature("a"), mode: "owner" }, feature("b"), feature("d")]);
    const carried = carryModes(previous, next);
    expect(carried.ok).toBe(true);
    if (!carried.ok) return;
    expect(carried.spec.features.map((f) => [f.id, f.mode, f.effort])).toEqual([["a", "review", "deep"], ["b", "owner", undefined], ["d", undefined, undefined]]);
    expect(carried.spec.features[0]?.expect).toEqual({ headings: ["Install"], words: [1, 9] });
    expect(carried.spec.features[0]?.expect).not.toBe(previous.features[0]?.expect);
  });

  it("refuses a revision that renames, drops, splits or merges a feature that has a mode, and one that only drops a feature checked by tests is fine", () => {
    expect(carryModes(withModes(), specOutput([feature("a"), feature("c")])).ok).toBe(false);
    expect(carryModes(withModes(), specOutput([feature("a"), feature("b2")])).ok).toBe(false);
    expect(carryModes(withModes(), specOutput([feature("a-1"), feature("a-2"), feature("b"), feature("c")])).ok).toBe(false);
    expect(carryModes(withModes(), specOutput([feature("a"), feature("b")])).ok).toBe(true);
  });
});
