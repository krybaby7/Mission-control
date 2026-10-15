// Scenarios for the compatibility test of docs/modes-spec.md section 15, items 1 and 2: missions queued the old way
// (no mode, no effort, no owner flag), run on the mock harness. The list of event types, the labels of the agent runs and the
// keys of mission.json they leave behind were recorded with the code of the end of wave 1 (see wave1-tip.txt in the
// scratchpad) and stored in events-wave1.json. `src/dispatcher-modes.test.ts` runs the same scenarios again and the
// recording must come out identical: a mission with no mode feature behaves and logs exactly as it did.
//
// This file uses only what the harness of wave 1 already had, so it runs unchanged against both trees. To make the recording
// again (only if wave 1's behaviour is meant to change): copy a clean checkout of the end of wave 1, copy this file into it
// at the same place, and in that checkout write the result of `runScenario(name)` for every name in SCENARIOS to a JSON file
// with a throwaway test. The recording was also made with the code of the base commit (8aae86f) and came out identical.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyAnswer } from "../../../src/checkpoint.js";
import type { CheckpointKind, Mission, SpecFeature } from "../../../src/types.js";
import { createFixtureRepo, feature, finding, implementFeature, labelOf, MissionHarness, planSource, review } from "../mission-harness.js";

/** What one scenario leaves behind. Time stamps and ids are not part of it. */
export interface Recording {
  /** The type of every event of the mission, in order. */
  events: string[];
  /** For each event type, the sorted keys that its data held, over the whole run. */
  eventKeys: Record<string, string[]>;
  /** The label of every agent run, in order. */
  labels: string[];
  /** The sorted keys of mission.json as written to disk. */
  missionKeys: string[];
  /** The sorted keys that any feature of the mission held. */
  featureKeys: string[];
  /** Final status and stage, and the status of each feature. */
  status: string;
  stage: string;
  features: Record<string, string>;
}

function record(h: MissionHarness, id: string): Recording {
  const events = h.store.readEvents(id);
  const eventKeys: Record<string, Set<string>> = {};
  for (const e of events) {
    const keys = (eventKeys[e.type] ??= new Set());
    for (const k of Object.keys(e.data ?? {})) keys.add(k);
  }
  const raw = JSON.parse(readFileSync(join(h.store.missionDir(id), "mission.json"), "utf8")) as Mission;
  const featureKeys = new Set<string>();
  for (const f of raw.features) for (const k of Object.keys(f)) featureKeys.add(k);
  return {
    events: events.map((e) => e.type),
    eventKeys: Object.fromEntries(Object.entries(eventKeys).map(([type, keys]) => [type, [...keys].sort()])),
    labels: h.jobs.map(labelOf),
    missionKeys: Object.keys(raw).sort(),
    featureKeys: [...featureKeys].sort(),
    status: raw.status,
    stage: raw.stage,
    features: Object.fromEntries(raw.features.map((f) => [f.id, f.status])),
  };
}

type Decide = (cp: NonNullable<Mission["checkpoint"]>) => { decision: "approve" | "send_back"; note?: string };

/** Runs a mission, answering each stop with `decide`, until it is complete (at most 12 stops). */
async function runThrough(h: MissionHarness, id: string, decide: Decide): Promise<Mission> {
  let m = await h.run(id);
  for (let i = 0; i < 12 && m.checkpoint !== undefined; i++) {
    const answer = decide(m.checkpoint);
    const result = applyAnswer(h.store, id, answer, h.clock.now());
    if (!result.ok) throw new Error(`scenario: the answer was refused: ${JSON.stringify(result)}`);
    m = await h.run(id);
  }
  return m;
}

const approveAll: Decide = () => ({ decision: "approve" });

const TWO_PLAN = `mc-plan 1
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

type Scenario = (h: MissionHarness) => Promise<string>;

const ALL_STOPS: CheckpointKind[] = ["plan", "feature", "final"];

/** Every scenario: a name and the function that runs it (it returns the id of the mission to record). */
export const SCENARIOS: Record<string, { features?: SpecFeature[]; run: Scenario }> = {
  "greenfield, two features, no stops": {
    run: async (h) => {
      const id = h.createMission("greenfield").id;
      await h.run(id);
      return id;
    },
  },
  "an existing app, one feature": {
    features: [feature("greet")],
    run: async (h) => {
      const repo = join(h.workspace, "existing");
      await createFixtureRepo(h.git, repo);
      const id = h.createMission("feature", { repoPath: repo, baseBranch: "main" }).id;
      await h.run(id);
      return id;
    },
  },
  "every stop, approved": {
    run: async (h) => {
      const id = h.createMission("greenfield", { checkpoints: ALL_STOPS }).id;
      await runThrough(h, id, approveAll);
      return id;
    },
  },
  "a plan from the leader, tests only": {
    run: async (h) => {
      const id = h.createMission("greenfield", { plan: planSource(TWO_PLAN), checkpoints: ["plan"] }).id;
      await runThrough(h, id, approveAll);
      return id;
    },
  },
  "a review finding, a fix round, a send-back at a feature stop": {
    features: [feature("greet")],
    run: async (h) => {
      h.agents.reviewer = (_job, call) => {
        if (call.label === "gate-a") return { structured: { verdict: "approve", issues: [] } };
        if (call.label === "review-greet" && call.n === 1) return { structured: review([finding("major", "greet is not clear", "src/greet.mjs")]) };
        return { structured: review() };
      };
      const id = h.createMission("greenfield", { checkpoints: ["feature"] }).id;
      let sent = false;
      await runThrough(h, id, () => {
        if (sent) return { decision: "approve" };
        sent = true;
        return { decision: "send_back", note: "Please make greet say hello." };
      });
      return id;
    },
  },
  "a build that fails twice, a diagnosis, then passes": {
    features: [feature("greet")],
    run: async (h) => {
      h.agents.engineer = (_job, call) => {
        if (call.label === "init") return h.defaults.engineer(_job, call);
        return { edit: (cwd) => implementFeature(cwd, call.feature ?? "unknown", call.n >= 3 ? call.feature : "wrong"), structured: { summary: "tried", filesChanged: [], testDispute: null, notes: "" } };
      };
      const id = h.createMission("greenfield").id;
      await h.run(id);
      return id;
    },
  },
  "a feature that never passes": {
    features: [feature("greet")],
    run: async (h) => {
      h.agents.engineer = (_job, call) => {
        if (call.label === "init") return h.defaults.engineer(_job, call);
        return { edit: (cwd) => implementFeature(cwd, call.feature ?? "unknown", `wrong ${call.n}`), structured: { summary: "tried", filesChanged: [], testDispute: null, notes: "" } };
      };
      const id = h.createMission("greenfield").id;
      await h.run(id);
      return id;
    },
  },
  "the final review finds a serious problem": {
    features: [feature("greet")],
    run: async (h) => {
      h.agents.reviewer = (_job, call) => {
        if (call.label === "gate-a") return { structured: { verdict: "approve", issues: [] } };
        if (call.label === "gate-c" && call.n === 1) return { structured: review([finding("major", "the whole does not hold together", "src/greet.mjs")]) };
        return { structured: review() };
      };
      const id = h.createMission("greenfield").id;
      await h.run(id);
      return id;
    },
  },
  "a send-back at the final stop": {
    features: [feature("greet")],
    run: async (h) => {
      const id = h.createMission("greenfield", { checkpoints: ["final"] }).id;
      let sent = false;
      await runThrough(h, id, () => {
        if (sent) return { decision: "approve" };
        sent = true;
        return { decision: "send_back", note: "Please also add a second thing." };
      });
      return id;
    },
  },
};

/** Runs one scenario on a fresh harness and returns what it left behind. */
export async function runScenario(name: string): Promise<Recording> {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`no scenario called "${name}"`);
  const h = new MissionHarness(scenario.features ? { features: scenario.features } : {});
  try {
    const id = await scenario.run(h);
    return record(h, id);
  } finally {
    h.cleanup();
  }
}
