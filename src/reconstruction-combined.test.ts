// Integrated cross-package acceptance cases; real execution receipts are recorded in the reconstruction ledger.
// Stand-in runners only. The proposal writer did not execute this file; the integrator owns validation.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MissionHarness, buildOutput, feature, finding, finalReview, labelOf,
  planSource, review, writeFile,
} from "../test/fixtures/mission-harness.js";
import { ALLOWANCE_MAX_AGE_MS } from "./allowance.js";
import { applyAnswer } from "./checkpoint.js";
import { main } from "./cli.js";
import { clearReadCache } from "./dashboard/read.js";
import { buildSnapshot, builtInSettings } from "./dashboard/snapshot.js";
import { findingId } from "./finding-resolution.js";
import { interpretProvenance } from "./provenance.js";
import type { Mission } from "./types.js";
import { FakeClock } from "./util/clock.js";

let h: MissionHarness | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearReadCache();
  h?.cleanup();
  h = undefined;
});

const SAME_CODEX = "Built and reviewed by Codex in separate jobs; this was not a review by another AI family.";
const OTHER_CLAUDE = "Reviewed by Claude in a separate job from the recorded builders; the reviewer belongs to another AI family.";
const OFF = { contextPack: false, failureDigest: false, reportProse: false };

function queue(hh: MissionHarness, init: Parameters<MissionHarness["createMission"]>[1] = {}): Mission {
  const m = hh.createMission("greenfield", init);
  m.helpers = { ...OFF };
  hh.store.save(m);
  return m;
}

function expectAccountedOnce(hh: MissionHarness, m: Mission): void {
  const ids = hh.jobs.map(j => j.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(m.agentRuns).toBe(ids.length);
  expect(m.invocations?.entries.map(e => e.jobId).sort()).toEqual([...ids].sort());
  for (const row of m.invocations?.entries ?? []) {
    expect(row.observation).toBeDefined();
    expect(row.cleanedAt).toBeDefined();
  }
}

async function currentOwnerSurfaces(hh: MissionHarness, m: Mission, featureId: string) {
  const report = readFileSync(hh.store.reportPath(m.id), "utf8");
  let cli = "";
  vi.stubEnv("MC_CONFIG", "");
  expect(await main(["node", "mc", "plan", "show", m.id], {
    stdout: text => { cli += text; }, stderr: text => { cli += text; },
  })).toBe(0);
  clearReadCache();
  const snapshot = buildSnapshot({
    home: hh.home, now: Date.parse(m.updatedAt) + 1000,
    timeZone: "UTC", settings: builtInSettings(),
  });
  const shown = snapshot.missions.find(row => row.id === m.id)!;
  expect(shown).toBeDefined();
  const f = shown.features.find(row => row.id === featureId) as unknown as {
    reviewRecord: { review: string[]; tests: string[] };
  };
  expect(f).toBeDefined();
  return { report, cli, featureLines: f.reviewRecord.review };
}

describe("combined reconstruction acceptance stand-ins", () => {
  it("SC03: actual reviewer auth fallback continues with concrete same-family wording on every current owner surface", async () => {
    h = new MissionHarness({ features: [feature("greet")] });
    const hh = h;
    hh.agents.reviewer = (job, call) =>
      call.label === "review-greet" && call.n === 1
        ? { outcome: "auth" }
        : hh.defaults.reviewer(job, call);
    const m = await hh.run(queue(hh).id);

    expect(m.status).toBe("done");
    expect(m.features[0]?.status).toBe("done");
    const builder = hh.jobsLabeled("build-greet");
    const reviewers = hh.jobsLabeled("review-greet");
    expect(builder).toHaveLength(1);
    expect(builder[0]?.provider).toBe("codex");
    expect(reviewers.map(j => j.provider)).toEqual(["claude", "codex"]);
    const completed = m.features[0]?.provenance?.entries.filter(e => e.stage === "review" && e.outcome === "completed");
    expect(completed).toHaveLength(1);
    expect(completed?.[0]).toMatchObject({ jobId: reviewers[1]!.id, actual: { family: "codex" } });
    const surfaces = await currentOwnerSurfaces(hh, m, "greet");
    expect(surfaces.featureLines).toContain(SAME_CODEX);
    expect(surfaces.featureLines).not.toContain(OTHER_CLAUDE);
    for (const text of [surfaces.report, surfaces.cli]) {
      expect(text).toContain(SAME_CODEX);
      expect(text).not.toContain(OTHER_CLAUDE);
    }
    expectAccountedOnce(hh, m);
  }, 120_000);

  it("SC04: a kept repair retains the first review as history but current disclosure uses only the repaired version's actual review", async () => {
    h = new MissionHarness({ features: [feature("greet")] });
    const hh = h;
    let beforeRepair = "";
    hh.agents.reviewer = async (job, call) => {
      if (call.label === "review-greet" && call.n === 1) {
        beforeRepair = await hh.git.headSha(job.cwd);
        return { structured: review([finding("major", "Keep a source note explaining the greeting.", "src/greet.mjs")]) };
      }
      if (call.label === "review-greet" && call.n === 2) return { outcome: "auth" };
      return hh.defaults.reviewer(job, call);
    };
    hh.agents.engineer = (job, call) => call.label === "fix-greet"
      ? {
          edit: cwd => writeFile(cwd, "src/repair-note.mjs", 'export const note = "The greeting is intentional.";\n'),
          structured: buildOutput("Kept the requested source note."),
        }
      : hh.defaults.engineer(job, call);
    const m = await hh.run(queue(hh).id);
    const f = m.features[0]!;
    const reviews = hh.jobsLabeled("review-greet");
    const repairs = hh.jobsLabeled("fix-greet");

    expect(m.status).toBe("done");
    expect(repairs).toHaveLength(1);
    expect(reviews.map(j => j.provider)).toEqual(["claude", "claude", "codex"]);
    expect(beforeRepair).toMatch(/^[a-f0-9]{40,64}$/u);
    expect(f.passingCommit).not.toBe(beforeRepair);
    expect(f.provenance?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ jobId: reviews[0]!.id, stage: "review", outcome: "completed",
        subject: { kind: "feature_commit", featureId: "greet", commit: beforeRepair } }),
      expect.objectContaining({ jobId: repairs[0]!.id, stage: "fix", actual: expect.objectContaining({ family: "codex" }) }),
      expect.objectContaining({ jobId: reviews[2]!.id, stage: "review", outcome: "completed",
        subject: { kind: "feature_commit", featureId: "greet", commit: f.passingCommit } }),
    ]));
    const current = interpretProvenance(f.provenance, {
      subject: { kind: "feature_commit", featureId: "greet", commit: f.passingCommit! },
      hasPendingWrites: false, maxEntries: 10_000, maxSnapshots: 4_000, maxReferences: 100_000,
    });
    expect(current.currentReviews.map(row => row.jobId)).toEqual([reviews[2]!.id]);
    const surfaces = await currentOwnerSurfaces(hh, m, "greet");
    expect(surfaces.featureLines).toContain(SAME_CODEX);
    expect(surfaces.featureLines).not.toContain(OTHER_CLAUDE);
    for (const text of [surfaces.report, surfaces.cli]) {
      expect(text).toContain(SAME_CODEX);
      expect(text).not.toContain(OTHER_CLAUDE);
    }
    expectAccountedOnce(hh, m);
  }, 120_000);

  it("SC06: missing and stale strict allowance stop at zero calls, then fresh strict resume preserves an unanswered owner stop and charges each launch once", async () => {
    const clock = new FakeClock(Date.UTC(2026, 9, 31, 12));
    h = new MissionHarness({ features: [feature("greet")], clock });
    const hh = h;
    hh.config.pacing.unknownAllowance = "stop";
    const id = queue(hh, { checkpoints: ["plan"] }).id;
    const fresh = () => {
      const resetsAt = clock.now() + 60 * 60_000; // canonical milliseconds, not provider transport text
      for (const provider of ["claude", "codex"] as const)
        for (const window of ["five_hour", "seven_day"])
          hh.quota.recordAllowance(provider, { window, utilization: 0, reset: { kind: "supplied", value: resetsAt } });
    };

    const missing = await hh.run(id);
    expect(missing).toMatchObject({ status: "stopped", stage: "spec", agentRuns: 0, allowancePolicy: "stop",
      pause: { kind: "allowance_unknown" } });
    expect(hh.jobs).toHaveLength(0);
    expect(missing.invocations?.entries ?? []).toEqual([]);
    fresh();
    await clock.advance(ALLOWANCE_MAX_AGE_MS + 1);
    const stale = await hh.run(id);
    expect(stale).toMatchObject({ status: "stopped", stage: "spec", agentRuns: 0, allowancePolicy: "stop",
      pause: { kind: "allowance_unknown" } });
    expect(hh.jobs).toHaveLength(0);
    expect(stale.invocations?.entries ?? []).toEqual([]);

    expect(stale.pause?.reason).toContain("stale");
    fresh();
    const parked = await hh.run(id);
    expect(parked.status).toBe("stopped");
    expect(parked.allowancePolicy).toBe("stop");
    expect(parked.pause).toBeUndefined();
    expect(parked.checkpoint).toMatchObject({ kind: "plan", state: "pending" });
    expect(hh.jobs.map(labelOf)).toEqual(["spec", "gate-a"]);
    expectAccountedOnce(hh, parked);
    const ownerStop = structuredClone(parked.checkpoint);
    await clock.advance(ALLOWANCE_MAX_AGE_MS + 1);
    const stillParked = await hh.run(id);
    expect(stillParked.checkpoint).toEqual(ownerStop);
    expect(stillParked.checkpoint?.answer).toBeUndefined();
    expect(stillParked.agentRuns).toBe(2);
    expect(hh.jobs).toHaveLength(2);

    fresh();
    expect(applyAnswer(hh.store, id, { decision: "approve" }, clock.now()).ok).toBe(true);
    const done = await hh.run(id);
    expect(done.status).toBe("done");
    expect(done.allowancePolicy).toBe("stop");
    expect(hh.config.pacing.unknownAllowance).toBe("stop");
    expect(done.pause).toBeUndefined();
    for (const label of ["spec", "gate-a", "init", "test-greet", "build-greet", "review-greet", "gate-c"])
      expect(hh.jobsLabeled(label), label).toHaveLength(1);
    expect(done.checkpointLog?.filter(row => row.kind === "plan" && row.decision === "approve")).toHaveLength(1);
    expectAccountedOnce(hh, done);
  }, 120_000);

  it("SC07: a supplied mixed plan retains its checks, reports code and document checking separately, and closes only the explicitly reassessed finding while retaining useful prose", async () => {
    const notesChecks = ["The notes explain setup.", "The notes describe a limit."];
    const supplied = planSource([
      "mc-plan 1",
      "name: Mixed fixture",
      "request: Build a greeting and useful notes.",
      "app-name: Fixture App",
      "summary: A greeting with setup notes.",
      "assumption: The documents are in English.",
      "",
      "feature: greet",
      "title: Greeting code",
      "story: As a user I can request a greeting.",
      "check: answer in src/greet.mjs returns greet",
      "",
      "feature: notes",
      "title: Setup notes",
      "story: As a reader I can understand setup.",
      "needs: greet",
      "mode: review",
      "check: The notes explain setup.",
      "check: The notes describe a limit.",
      "",
    ].join("\n"));
    h = new MissionHarness();
    const hh = h;
    hh.config.limits.maxReviewRounds = 0;
    hh.config.limits.maxGateCRounds = 0;
    const closed = finding("major", "The greeting concern is explicitly reassessed.", "src/greet.mjs");
    const open = finding("major", "The second concern still needs an assessment.", "src/greet.mjs");
    const closedId = findingId("greet", closed);
    const openId = findingId("greet", open);
    hh.agents.reviewer = (job, call) =>
      call.label === "review-greet" ? { structured: review([closed, open]) }
      : call.label === "gate-c" ? { structured: finalReview([], [
          { id: closedId, outcome: "resolved", evidence: "src/greet.mjs returns greet and its acceptance test passes at this reviewed version." },
        ]) }
      : hh.defaults.reviewer(job, call);
    hh.agents.scout = (job, call) => call.label === "report-prose"
      ? { structured: {
          narrative: "The notes explain setup. Every feature was tested. The code answers a greeting.",
          whatYouCanDo: ["Read the notes. Everything is guaranteed. Browse the examples.", "Call the greeting module."],
        } }
      : hh.defaults.scout(job, call);
    const initial = queue(hh, { plan: supplied, checkpoints: ["plan"] });
    initial.helpers = { contextPack: false, failureDigest: false, reportProse: true };
    hh.store.save(initial);
    const parked = await hh.run(initial.id);
    expect(parked.checkpoint).toMatchObject({ kind: "plan", state: "pending" });
    expect(parked.plan?.spec).toEqual(supplied.spec);
    expect(hh.jobsLabeled("init")).toHaveLength(0);
    expect(applyAnswer(hh.store, initial.id, { decision: "approve" }, hh.clock.now()).ok).toBe(true);
    const m = await hh.run(initial.id);
    const code = m.features.find(f => f.id === "greet")!;
    const notes = m.features.find(f => f.id === "notes")!;

    expect(m.status).toBe("partial");
    expect(code.status).toBe("done");
    expect(m.plan?.sha256).toBe(supplied.sha256);
    expect(m.plan?.spec).toEqual(supplied.spec);
    expect(notes.mode).toBe("review");
    expect(notes.acceptance).toEqual(notesChecks);
    expect(m.spec?.features.find(f => f.id === "notes")?.acceptance).toEqual(notesChecks);
    expect(hh.jobsLabeled("spec")).toHaveLength(0);
    expect(hh.jobsLabeled("test-notes")).toHaveLength(0);
    expect(code.frozenTests.length).toBeGreaterThan(0);
    expect(notes.frozenTests).toEqual([]);
    expect(notes.checked).toBeDefined();
    expect(notes.status).toBe("done");
    expect(code.openFindings).toEqual([open]);
    const gate = hh.jobsLabeled("gate-c");
    expect(gate).toHaveLength(1);
    expect(gate[0]!.prompt).toContain(closedId);
    expect(gate[0]!.prompt).toContain(openId);
    const records = code.findingHistory?.records ?? [];
    expect(records.find(row => row.id === closedId)?.assessments).toEqual([
      expect.objectContaining({ jobId: gate[0]!.id, actual: expect.objectContaining({ provider: gate[0]!.provider }), outcome: "resolved" }),
    ]);
    expect(records.find(row => row.id === openId)?.assessments).toEqual([]);

    const report = readFileSync(hh.store.reportPath(m.id), "utf8");
    expect(report).toContain("1 feature by tests");
    expect(report).toContain("1 feature by a second AI against your list");
    expect(report).toContain("The notes explain setup. The code answers a greeting.");
    expect(report).toContain("Read the notes. Browse the examples.");
    expect(report).toContain("Call the greeting module.");
    expect(report).not.toContain("Every feature was tested.");
    expect(report).not.toContain("Everything is guaranteed.");
    expect(report.split("## Recorded checking facts")).toHaveLength(2);
    expect(report.split("Checking claims in the AI-written summary were replaced with recorded facts.")).toHaveLength(2);
    expect(report).toContain("reviewer reported this concern resolved");
    expect(report).toContain(open.description);
    expect(hh.jobsLabeled("report-prose")).toHaveLength(1);
    expectAccountedOnce(hh, m);
  }, 120_000);
});
