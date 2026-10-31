// The engine and the dashboard must say the same thing about why a feature stops for the owner (W2e-R8).
//
// The engine's rule is `lookReason` (src/checked-by.ts), with `shownLookReason` for the words the report and the phone use. The dashboard has
// its own copy of the rule on purpose (`lookWhy`, src/dashboard/modes.ts), so a card cannot say one thing while the report says another only
// if the two are held against each other. The first test does that on every combination of the facts that the rule reads. The second runs a
// mixed mission (a feature checked by tests and a guide the owner approves) to the second showing of the final review's repair, which is
// where the two used to differ: the engine said the owner had sent it back, and the card said it changed approved work.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentHandler, buildOutput, checkerBehavior, finding, MissionHarness, planSource, review, finalReview, writeFile } from "./fixtures/mission-harness.js";
import { applyAnswer, parkedNotice } from "../src/checkpoint.js";
import { shownLookReason } from "../src/checked-by.js";
import { clearReadCache } from "../src/dashboard/read.js";
import { buildSnapshot } from "../src/dashboard/snapshot.js";
import { lookWhy, timesSentBack } from "../src/dashboard/modes.js";
import type { CheckpointRecord, Feature, FeatureChecked, Mission } from "../src/types.js";
import { assertSnapshotShape, copyHomeOf } from "./dashboard-helpers.js";

// ───────────────────────────── The same rule on every combination ─────────────────────────────

/** The record of the second AI's check of a feature with one check, as the engine writes it: one result for the check, and `unjudged` counted from them. */
const checked = (kind: "clean" | "unjudged" | "unfinished" | "none" | "nopicture"): FeatureChecked | undefined => {
  if (kind === "none") return undefined;
  const base: FeatureChecked = { round: 1, reviewer: "claude", results: [{ n: 1, result: "pass", evidence: "x", basis: "text" }], unjudged: 0, scripted: { problems: [], facts: [] }, pictures: { taken: 0 } };
  if (kind === "unfinished") return { ...base, results: [], unfinished: true };
  if (kind === "unjudged") return { ...base, results: [{ n: 1, result: "cannot_judge", evidence: "x", basis: "text" }], unjudged: 1 };
  if (kind === "nopicture") return { ...base, pictures: { taken: 0, why: "no_browser" } };
  return base;
};

const log = (scope: string, decision: CheckpointRecord["decision"], round: number): CheckpointRecord => ({ id: `${scope}#${round}`, scope, kind: "feature", round, decision, at: "2026-10-12T13:30:00.000Z" });

function feature(id: string, fields: Partial<Feature> = {}): Feature {
  return {
    id,
    title: `Title of ${id}`,
    story: "As a user.",
    acceptance: ["Check 1."],
    kind: "standard",
    deps: [],
    status: "reviewing",
    rung: 0,
    attempts: [],
    frozenTests: [],
    reviewRounds: 0,
    openFindings: [],
    ...fields,
  };
}

/** The features that can stop: id, and whether it has a mode (the engine adds a repair or a change checked by tests in a mixed mission). */
const SUBJECTS = [
  { name: "a feature checked by tests", id: "a", modes: [undefined] },
  { name: "a feature checked by reading", id: "a", modes: ["review", "owner"] as const },
  { name: "the final review's repair", id: "gate-c-fix-1", modes: [undefined, "review", "owner"] as const },
  { name: "the change after a send-back at the final stop", id: "owner-change-1", modes: [undefined, "review", "owner"] as const },
];

describe("the engine's reason for a stop and the dashboard's are the same, on every combination of the facts the rule reads", () => {
  it("holds for sent back or not, the flag, --checkpoint feature, how the second AI's check came out, and approved work that a repair changed", () => {
    let combinations = 0;
    const seen = new Map<string, number>();
    const disagreements: string[] = [];
    for (const subject of SUBJECTS) {
      for (const mode of subject.modes) {
        for (const state of ["clean", "unjudged", "unfinished", "none", "nopicture"] as const) {
          if (mode === undefined && state !== "clean") continue; // a feature checked by tests has no record of a second AI's check
          for (const sends of [0, 1, 2]) {
            for (const ownerStops of [undefined, false] as const) {
              for (const checkpoints of [undefined, ["plan"], ["feature"], ["plan", "feature"]] as const) {
                // What a repair changed: nothing, approved work (a feature the owner approved, checked by reading or by tests, or an earlier repair), or work not approved.
                for (const touched of ["nothing", "approved-reading", "approved-tests", "approved-repair", "not-approved", "named-but-missing"] as const) {
                  if (touched !== "nothing" && !subject.id.startsWith("gate-c-fix") && !subject.id.startsWith("owner-change")) continue;
                  const f = feature(subject.id, {
                    ...(mode !== undefined && { mode, checked: checked(state) }),
                    ...(touched !== "nothing" && { changesApproved: touched === "approved-repair" ? ["gate-c-fix-0"] : touched === "named-but-missing" ? ["gone"] : ["earlier"] }),
                  });
                  const earlier = feature("earlier", { status: "done", ...(touched === "approved-reading" || touched === "not-approved" ? { mode: "owner" as const, checked: checked("clean") } : {}) });
                  const firstRepair = feature("gate-c-fix-0", { status: "done" });
                  const features = [earlier, ...(touched === "approved-repair" ? [firstRepair] : []), f];
                  const approvals = touched === "not-approved" ? [] : touched === "approved-repair" ? [log("feature:gate-c-fix-0", "approve", 1)] : [log("feature:earlier", "approve", 1)];
                  const sendBacks = Array.from({ length: sends }, (_, i) => log(`feature:${subject.id}`, "send_back", i + 1));
                  const m = {
                    features,
                    checkpointLog: [...approvals, ...sendBacks],
                    ...(ownerStops === false && { ownerStops }),
                    ...(checkpoints !== undefined && { checkpoints: [...checkpoints] as never }),
                  };
                  const engine = shownLookReason(m, f);
                  const dashboard = lookWhy(m, f, timesSentBack(m, f));
                  combinations++;
                  seen.set(String(engine), (seen.get(String(engine)) ?? 0) + 1);
                  if (engine !== dashboard) {
                    disagreements.push(`${subject.name} (${subject.id}, mode ${mode}, ${state}, sent back ${sends}, ownerStops ${ownerStops}, checkpoints ${checkpoints?.join("+")}, touched ${touched}): engine ${engine}, dashboard ${dashboard}`);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
    // Every reason, and no reason at all, came up, so the comparison compared something.
    expect([...seen.keys()].sort()).toEqual(["no_pictures", "not_judged", "owner", "repair", "sent_back", "undefined", "unfinished"].sort());
    expect(combinations).toBeGreaterThan(1500);
  });

  it("says that the repair of a mixed mission is shown again because it was sent back, whether or not it has a mode", () => {
    const original = feature("guide", { status: "done", mode: "owner", checked: checked("clean") });
    const repairByTests = feature("gate-c-fix-1", { changesApproved: ["guide"] });
    const repairByReading = feature("gate-c-fix-1", { changesApproved: ["guide"], mode: "review", checked: checked("clean") });
    for (const repair of [repairByTests, repairByReading]) {
      const first = { features: [original, repair], checkpointLog: [log("feature:guide", "approve", 1)] };
      expect(shownLookReason(first, repair), "the first showing").toBe("repair");
      expect(lookWhy(first, repair, 0), "the first showing").toBe("repair");
      const again = { ...first, checkpointLog: [...first.checkpointLog, log("feature:gate-c-fix-1", "send_back", 1)] };
      expect(shownLookReason(again, repair), "the second showing").toBe("sent_back");
      expect(lookWhy(again, repair, 1), "the second showing").toBe("sent_back");
      // ... also with --checkpoint feature, which never covered a repair: the owner did not ask for this stop
      const flagged = { ...again, checkpoints: ["feature" as const] };
      expect(shownLookReason(flagged, repair)).toBe("sent_back");
      expect(lookWhy(flagged, repair, 1)).toBe("sent_back");
    }
  });
});

// ───────────────────────────── A mixed mission, to the second showing of the repair ─────────────────────────────

let h: MissionHarness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

const PLAN = `mc-plan 1
name: Fixture app
request: Write the documents of the fixture app.
app-name: Fixture App
summary: Documents for the fixture app.
assumption: The documents are in English.

feature: greet
title: Feature greet
story: As a user I want greet.
check: answer in src/greet.mjs returns greet

feature: guide
title: Setup guide
story: As a reader I can follow a short guide.
mode: owner
check: The guide says how to start the app.
check: The guide says what the reader should see.
check: The guide names the answer.
`;
const REWRITE = "# guide\n\nThe guide says how to start the app.\n\nThe guide says what the reader should see.\n\nThe guide names the answer.\n\nA whole new paragraph that the owner never saw.\n";

describe("a mixed mission whose repair is sent back", () => {
  it("is shown again for the same reason in the look, the report, the phone notice and the dashboard's card", async () => {
    const blockingOnce: AgentHandler = (job, call) => {
      if (call.label === "gate-c" && call.n === 1) return { structured: finalReview([finding("major", "The guide contradicts itself in step two", "docs/guide.md")]) };
      return call.label.startsWith("review-") ? checkerBehavior(job) : hh.defaults.reviewer(job, call);
    };
    const repairing: AgentHandler = async (job, call) => {
      const base = await hh.defaults.engineer(job, call);
      if (call.label !== "build-gate-c-fix-1" && call.label !== "fix-gate-c-fix-1") return base;
      return { ...base, edit: async (cwd, j) => { await base.edit?.(cwd, j); writeFile(cwd, "docs/guide.md", REWRITE); }, structured: buildOutput("repaired") };
    };
    const hh: MissionHarness = new MissionHarness({ agents: { reviewer: blockingOnce, engineer: repairing } });
    h = hh;
    const id = hh.createMission("greenfield", { plan: planSource(PLAN) }).id;
    const answer = (decision: "approve" | "send_back", note?: string): void => {
      expect(applyAnswer(hh.store, id, { decision, ...(note !== undefined && { note }) }, hh.clock.now()).ok).toBe(true);
    };
    const card = (): { happened: string; lines: string[] } => {
      const home = copyHomeOf(hh.home);
      clearReadCache();
      const snapshot = buildSnapshot({ home, now: Date.now(), timeZone: "UTC" });
      assertSnapshotShape(snapshot);
      const [one] = snapshot.needsYou;
      expect(snapshot.needsYou).toHaveLength(1);
      return { happened: one?.happened.text ?? "", lines: (one?.lines ?? []).map((l) => l.text) };
    };
    const report = (): string => readFileSync(hh.store.reportPath(id), "utf8");

    await hh.run(id);
    answer("approve"); // the owner's stop at the guide
    const first: Mission = await hh.run(id);
    const repair = first.features.find((f) => f.id === "gate-c-fix-1")!;
    expect(repair.mode).toBeUndefined(); // a mixed mission: the repair is checked by tests
    expect(repair.changesApproved).toEqual(["guide"]);
    expect(first.checkpoint).toMatchObject({ scope: "feature:gate-c-fix-1", round: 1, state: "pending" });
    expect(first.checkpoint?.look.lines).toContain("You are asked because this repair changes work you approved earlier: “Setup guide”.");
    expect(report()).toContain("because the repair “Fix problems found in the final review” changes work you approved earlier");
    expect(card().happened).toBe("The team stopped here because this repair changes work you approved earlier, so you look at it first.");

    answer("send_back", "Please leave the second step as it was.");
    const again: Mission = await hh.run(id);
    expect(again.checkpoint).toMatchObject({ scope: "feature:gate-c-fix-1", round: 2, state: "pending" });
    // The engine: the look and the report.
    expect(again.checkpoint?.look.lines).toContain("You are asked again because you sent it back.");
    expect(report()).toContain("because you sent “Fix problems found in the final review” back and it is shown again");
    expect(parkedNotice(again, again.checkpoint!).message).toContain("The team stopped because you sent “Fix problems found in the final review” back and it is shown again.");
    // The dashboard: the card says the same thing.
    expect(card().happened).toBe("The team stopped here again because you sent this feature back, so you look at the changed work.");
    expect(card().lines).toContain("You are asked again because you sent it back.");
  });
});
