import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionHarness, feature, finding, review, writeFile, labelOf } from "../test/fixtures/mission-harness.js";
import * as findingRules from "./finding-resolution.js";
import { findingId } from "./finding-resolution.js";
import { Verifier } from "./verify.js";
import { RoleExecutor } from "./executor.js";
import { SCHEMAS, validateOutput } from "./schemas.js";
import type { Mission, RunResult } from "./types.js";

let h: MissionHarness | undefined;
afterEach(() => { vi.restoreAllMocks(); h?.cleanup(); h = undefined; });
const concern = finding("major", "The older concern needs an explicit assessment.", "src/greet.mjs");
const id = findingId("greet", concern);
const resolved = { id, outcome: "resolved", evidence: "src/greet.mjs now returns greet as its acceptance test requires." };
function harness() {
  h = new MissionHarness({ features: [feature("greet")] });
  h.config.limits.maxReviewRounds = 0; h.config.limits.maxGateCRounds = 0;
  const hh = h;
  hh.agents.reviewer = (job, call) => call.label === "review-greet" ? { structured: review([concern]) }
    : call.label === "gate-c" ? { structured: { ...review(), resolutions: [resolved] } }
    : hh.defaults.reviewer(job, call);
  return hh;
}
function history(m: Mission) { return (m.features[0] as unknown as { findingHistory?: { records: Array<{ id: string; assessments: Array<{ jobId: string; reviewedCommit: string; actual: { provider: string }; outcome: string }> }> } })?.findingHistory; }
describe("finding resolution runtime", () => {
  it("uses a distinct required final schema while ordinary feature reviews stay unchanged", () => {
    const schema = (SCHEMAS as unknown as Record<string, import("./types.js").JsonSchema>).finalReview;
    expect(schema).toBeDefined();
    expect(validateOutput(schema!, { ...review(), resolutions: [resolved] }).ok).toBe(true);
    expect(validateOutput(schema!, review()).ok).toBe(false);
    expect(validateOutput(SCHEMAS.review, review()).ok).toBe(true);
  });
  it("piggybacks current finding IDs on one final review and saves actual review identity with audit text", async () => {
    const hh = harness(); const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.features[0]?.openFindings).toEqual([]); expect(m.status).toBe("done");
    const job = hh.jobs.find(j => labelOf(j) === "gate-c")!;
    expect(job.prompt).toContain(id); expect(job.prompt).toContain(concern.description);
    expect(hh.jobs.filter(j => labelOf(j) === "gate-c")).toHaveLength(1);
    expect(history(m)?.records[0]?.assessments[0]).toMatchObject({ jobId: job.id, actual: { provider: job.provider }, outcome: "resolved" });
    expect(readFileSync(hh.store.reportPath(m.id), "utf8")).toContain("reviewer reported this concern resolved");
  });
  it.each([
    ["omission", []], ["unknown", [{ ...resolved, id: "f".repeat(64) }]],
    ["duplicate", [resolved, { ...resolved, evidence: "second" }]], ["empty", [{ ...resolved, evidence: "  " }]],
    ["open", [{ ...resolved, outcome: "open" }]], ["cannot judge", [{ ...resolved, outcome: "cannot_judge" }]],
  ])("keeps an old concern visible for %s", async (_label, resolutions) => {
    const hh = harness(); hh.agents.reviewer = (job, call) => call.label === "review-greet" ? { structured: review([concern]) }
      : call.label === "gate-c" ? { structured: { ...review(), resolutions } } : hh.defaults.reviewer(job, call);
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.features[0]?.openFindings).toEqual([concern]); expect(m.status).toBe("partial");
  });
  it.each(["dirty", "committed"])("rejects closure and check credit when final review leaves %s changes", async kind => {
    const hh = harness(); hh.agents.reviewer = (job, call) => call.label === "review-greet" ? { structured: review([concern]) }
      : call.label === "gate-c" ? { structured: { ...review(), resolutions: [resolved] }, edit: async cwd => {
        writeFile(cwd, "new-review-write.txt", "changed"); if (kind === "committed") await hh.git.commitAll(cwd, "fixture review change");
      } } : hh.defaults.reviewer(job, call);
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.features[0]?.openFindings).toEqual([concern]); expect(m.status).toBe("partial");
    expect(history(m)?.records[0]?.assessments).toEqual([]);
  });
  it.each(["restored", "unknown"] as const)("does not accept a read-only mutation flagged %s even on a clean unchanged head", async readonlyMutation => {
    const hh = harness();
    for (const runner of [hh.claude, hh.codex]) {
      const original = runner.run.bind(runner);
      vi.spyOn(runner, "run").mockImplementation(async (job, options): Promise<RunResult> => {
        const r = await original(job, options); return labelOf(job) === "gate-c" ? { ...r, readonlyMutation } : r;
      });
    }
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.features[0]?.openFindings).toEqual([concern]); expect(m.status).toBe("partial");
    expect(history(m)?.records[0]?.assessments).toEqual([]);
  });
  it("requires the actual final job ID instead of reconstructing one from a label", async () => {
    const original = RoleExecutor.prototype.exec;
    vi.spyOn(RoleExecutor.prototype, "exec").mockImplementation(async function (this: RoleExecutor, request) {
      const r = await original.call(this, request); return request.label === "gate-c" ? { ...r, jobId: undefined } : r;
    });
    const hh = harness(); const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.features[0]?.openFindings).toEqual([concern]); expect(history(m)?.records[0]?.assessments).toEqual([]);
  });
  it("rolls back history and open projection together when the adoption save fails", async () => {
    const hh = harness(); const initial = hh.createMission("greenfield"); let failed = false;
    const save = hh.store.save.bind(hh.store);
    vi.spyOn(hh.store, "save").mockImplementation((m, now) => {
      if (!failed && history(m)?.records.some(r => r.assessments.some(a => a.outcome === "resolved"))) { failed = true; throw Error("synthetic finding save failure"); }
      return save(m, now);
    });
    const m = await hh.run(initial.id);
    expect(failed).toBe(true); expect(m.status).toBe("stopped"); expect(m.stage).toBe("gate_c");
    expect(m.features[0]?.openFindings).toEqual([concern]); expect(history(m)?.records[0]?.assessments).toEqual([]);
    expect(hh.load(m.id).features[0]?.openFindings).toEqual([concern]);
  });

  it("records the actual fallback reviewer rather than the requested family", async () => {
    const hh = harness();
    hh.agents.reviewer = (job, call) => call.label === "review-greet" ? { structured: review([concern]) }
      : call.label === "gate-c" ? call.n === 1 ? { outcome: "auth" } : { structured: { ...review(), resolutions: [resolved] } }
      : hh.defaults.reviewer(job, call);
    const m = await hh.run(hh.createMission("greenfield").id);
    const calls = hh.jobsLabeled("gate-c");
    expect(calls).toHaveLength(2); expect(calls[0]?.provider).not.toBe(calls[1]?.provider);
    expect(history(m)?.records[0]?.assessments[0]).toMatchObject({ jobId: calls[1]!.id, actual: { provider: calls[1]!.provider } });
    expect(m.features[0]?.openFindings).toEqual([]);
  });
  it.each(["failed", "changed-head"] as const)("does not close a blocker when final verification is %s", async behavior => {
    const hh = harness(); const original = Verifier.prototype.runFull;
    vi.spyOn(Verifier.prototype, "runFull").mockImplementation(async function (this: Verifier, cwd, config, label) {
      const result = await original.call(this, cwd, config, label);
      if (label?.startsWith("gate-c")) {
        if (behavior === "failed") return { ...result, ok: false, exitCode: 1 };
        writeFile(cwd, "verification-change.txt", "changed");
        await hh.git.commitAll(cwd, "fixture verification changed HEAD");
      }
      return result;
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.features[0]?.openFindings).toEqual([concern]); expect(m.status).toBe("partial");
    expect(history(m)?.records[0]?.assessments).toEqual([]);
  });
  it("does not let a contradictory final resolution conceal a newly repeated concern", async () => {
    const hh = harness();
    hh.agents.reviewer = (job, call) => call.label === "review-greet" ? { structured: review([concern]) }
      : call.label === "gate-c" ? { structured: { ...review([concern]), resolutions: [resolved] } }
      : hh.defaults.reviewer(job, call);
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.features[0]?.openFindings).toEqual([concern]); expect(m.status).toBe("partial");
    expect(history(m)?.records[0]?.assessments).toEqual([]);
  });
  it("reopens a recorded closure when the integration branch changes before a restart", async () => {
    const hh = harness(); const first = await hh.run(hh.createMission("greenfield").id);
    expect(first.features[0]?.openFindings).toEqual([]);
    await hh.git.checkout(first.repoPath, first.integrationBranch);
    writeFile(first.repoPath, "later.txt", "later integration");
    await hh.git.commitAll(first.repoPath, "fixture later integration");
    await hh.git.checkout(first.repoPath, first.baseBranch);
    first.stage = "gate_c"; first.status = "stopped"; hh.store.save(first);
    hh.agents.reviewer = (job, call) => call.label === "gate-c"
      ? { structured: { ...review(), resolutions: [] } } : hh.defaults.reviewer(job, call);
    const m = await hh.run(first.id);
    expect(m.features[0]?.openFindings).toEqual([concern]); expect(m.status).toBe("partial");
    expect(history(m)?.records[0]?.assessments).toHaveLength(1);
    expect(hh.jobsLabeled("gate-c").at(-1)?.prompt).toContain(id);
  });
  it("retains damaged history bytes and open concerns without manufacturing a replacement", async () => {
    const hh = harness();
    const save = hh.store.save.bind(hh.store); let damaged = false;
    vi.spyOn(hh.store, "save").mockImplementation((m, now) => {
      if (!damaged && m.stage === "gate_c") { damaged = true; (m.features[0] as unknown as { findingHistory: unknown }).findingHistory = { version: 999, saved: "retain" }; }
      return save(m, now);
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(damaged).toBe(true); expect(m.features[0]?.openFindings).toEqual([concern]);
    expect(m.features[0]?.findingHistory).toEqual({ version: 999, saved: "retain" }); expect(m.status).toBe("partial");
    m.stage = "gate_c"; m.status = "stopped"; hh.store.save(m);
    const again = await hh.run(m.id);
    expect(again.features[0]?.findingHistory).toEqual({ version: 999, saved: "retain" });
    expect(again.features[0]?.openFindings).toEqual([concern]);
  });

  it.each(["missing job", "read-only mutation"])("keeps newly reported concerns visible with %s even though the review gets no credit", async invalid => {
    const fresh = finding("minor", "A new concern from the final review.");
    const hh = harness();
    hh.agents.reviewer = (job, call) => call.label === "gate-c" ? { structured: { ...review([fresh]), resolutions: [] } } : hh.defaults.reviewer(job, call);
    const original = RoleExecutor.prototype.exec;
    vi.spyOn(RoleExecutor.prototype, "exec").mockImplementation(async function (this: RoleExecutor, request) {
      const result = await original.call(this, request);
      return request.label !== "gate-c" ? result : invalid === "missing job" ? { ...result, jobId: undefined }
        : { ...result, result: { ...result.result!, readonlyMutation: "restored" } };
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.notes.join("\n")).toContain(fresh.description); expect(m.status).toBe("partial");
  });
  it("reopens a concern reported again at the SAME SHA and retains its earlier resolution audit", async () => {
    const hh = harness(); const first = await hh.run(hh.createMission("greenfield").id);
    first.stage = "gate_c"; first.status = "stopped"; hh.store.save(first);
    hh.agents.reviewer = (job, call) => call.label === "gate-c"
      ? { structured: { ...review([concern]), resolutions: [resolved] } } : hh.defaults.reviewer(job, call);
    const m = await hh.run(first.id);
    expect(m.features[0]?.openFindings).toEqual([concern]); expect(history(m)?.records[0]?.assessments).toHaveLength(1);
    expect(m.features[0]?.findingHistory?.records[0]?.reopens).toHaveLength(1);
  });
  it("preserves a durable uncertainty barrier if a rediscovery cannot fit its audit budget", async () => {
    const hh = harness(); const first = await hh.run(hh.createMission("greenfield").id);
    const prior = structuredClone(first.features[0]?.findingHistory);
    first.stage = "gate_c"; first.status = "stopped"; hh.store.save(first);
    hh.agents.reviewer = (job, call) => call.label === "gate-c"
      ? { structured: { ...review([concern]), resolutions: [resolved] } } : hh.defaults.reviewer(job, call);
    vi.spyOn(findingRules, "rediscoverFindings").mockReturnValue(undefined);
    const m = await hh.run(first.id);
    expect(m.features[0]?.openFindings).toEqual([concern]); expect(m.features[0]).toHaveProperty("findingHistoryUncertain", true);
    expect(m.features[0]?.findingHistory).toEqual(prior);
    vi.restoreAllMocks(); m.stage = "gate_c"; m.status = "stopped"; hh.store.save(m);
    hh.agents.reviewer = (job, call) => call.label === "gate-c" ? { structured: { ...review(), resolutions: [resolved] } } : hh.defaults.reviewer(job, call);
    const again = await hh.run(m.id);
    expect(again.features[0]?.openFindings).toEqual([concern]); expect(again.features[0]).toHaveProperty("findingHistoryUncertain", true);
  });
  it("does not persist an old closed projection if saving a new-head reopen fails", async () => {
    const hh = harness(); const first = await hh.run(hh.createMission("greenfield").id);
    await hh.git.checkout(first.repoPath, first.integrationBranch); writeFile(first.repoPath, "later.txt", "later");
    await hh.git.commitAll(first.repoPath, "fixture later head"); await hh.git.checkout(first.repoPath, first.baseBranch);
    first.stage = "gate_c"; first.status = "stopped"; hh.store.save(first);
    const save = hh.store.save.bind(hh.store); let failed = false;
    vi.spyOn(hh.store, "save").mockImplementation((m, now) => {
      if (!failed && m.features[0]?.openFindings.length) { failed = true; throw Error("synthetic reopen save failure"); }
      return save(m, now);
    });
    const m = await hh.run(first.id);
    expect(failed).toBe(true); expect(m.status).toBe("stopped"); expect(m.features[0]?.openFindings).toEqual([concern]);
    expect(m.features[0]).toHaveProperty("findingHistoryUncertain", true);
    expect(hh.load(m.id).features[0]?.openFindings).toEqual([concern]);
  });

  it("does not treat a red baseline with no regression test as passing proof for an old blocker", async () => {
    const hh = harness();
    hh.agents.reviewer = (job, call) => call.label === "review-greet" ? { structured: review([concern]) }
      : call.label === "gate-c" ? { structured: { ...review(), resolutions: [] } } : hh.defaults.reviewer(job, call);
    const first = await hh.run(hh.createMission("greenfield").id);
    first.stage = "gate_c"; first.status = "stopped"; first.baselineBroken = true;
    first.features[0]!.frozenTests = []; if (first.verify) delete first.verify.tests;
    hh.store.save(first);
    const original = Verifier.prototype.runFull;
    vi.spyOn(Verifier.prototype, "runFull").mockImplementation(async function (this: Verifier, cwd, config, label) {
      const result = await original.call(this, cwd, config, label);
      return label?.startsWith("gate-c") ? { ...result, ok: false, exitCode: 1 } : result;
    });
    hh.agents.reviewer = (job, call) => call.label === "gate-c" ? { structured: { ...review(), resolutions: [resolved] } } : hh.defaults.reviewer(job, call);
    const m = await hh.run(first.id);
    expect(m.features[0]?.openFindings).toEqual([concern]); expect(history(m)?.records[0]?.assessments).toEqual([]);
    expect(m.status).toBe("partial");
  });
  it("retains distinct original null/empty paths and suggested-test strings through keepOpen", async () => {
    const hh = harness(); const concerns = [finding("minor", "Same text", null), finding("minor", "Same text", ""), { ...finding("minor", "Same text", null), suggestedTest: "specific check" }];
    hh.agents.reviewer = (job, call) => call.label === "review-greet" ? { structured: review([...concerns, concerns[0]!]) } : hh.defaults.reviewer(job, call);
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.features[0]?.openFindings).toEqual(concerns);
    expect(m.features[0]?.findingHistory?.records.map(row => row.id)).toEqual(concerns.map(f => findingId("greet", f)));
  });
});
