import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionHarness, feature, labelOf, writeFile, review, planSource } from "../test/fixtures/mission-harness.js";
import * as captures from "./review-capture.js";
import { RoleExecutor } from "./executor.js";
import type { Mission, Feature, RunResult } from "./types.js";
import type { Provenance } from "./provenance.js";
const modePlan = planSource("mc-plan 1\nname: Fixture guide\nrequest: Write a greeting guide.\napp-name: Fixture\nsummary: A guide.\nassumption: English.\n\nfeature: greet\ntitle: Greeting guide\nstory: As a reader I can read a greeting.\nmode: review\ncheck: The guide says hello.\n");
let h: MissionHarness | undefined;
afterEach(() => { vi.restoreAllMocks(); h?.cleanup(); h = undefined; });
function harness(mode = false) {
  h = new MissionHarness({ features: [mode ? { ...feature("greet"), mode: "review" as const, acceptance: ["The guide says hello."] } : feature("greet")] });
  h.config.limits.maxReviewRounds = 0; h.config.limits.maxGateCRounds = 0; return h;
}
function provenance(record: Mission | Feature | undefined): Provenance | undefined { return (record as unknown as { provenance?: Provenance } | undefined)?.provenance; }
function completed(record: Mission | Feature | undefined) { const entries = provenance(record)?.entries; return Array.isArray(entries) ? entries.filter(e => e.outcome === "completed") : []; }
describe("actual review evidence integration", () => {
  it("rechecks strict allowance after the awaited pre-review capture without reserving or querying again", async () => {
    let now = Date.parse("2026-10-31T00:00:00.000Z");
    h = new MissionHarness({ features: [feature("greet")], configure: c => { c.pacing.unknownAllowance = "stop"; },
      clock: { now: () => now, sleep: async ms => { now += ms; } } });
    const hh = h;
    for (const provider of ["claude", "codex"] as const) hh.quota.recordAllowanceBatch(provider,
      (["five_hour", "seven_day"] as const).map(window => ({ window, utilization: 0.1, reset: { kind: "supplied", value: now + 3_600_000 } })));
    const readAllowance = vi.fn(async () => ({ status: "unavailable" as const }));
    Object.assign(hh.claude, { readAllowance }); Object.assign(hh.codex, { readAllowance });
    const capture = captures.captureReviewSubject; let reached = false;
    vi.spyOn(captures, "captureReviewSubject").mockImplementation(async (...args) => {
      const result = await capture(...args);
      if (!reached && args[1].kind === "feature") { reached = true; now += 600_001; }
      return result;
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(reached).toBe(true); expect(m.status).toBe("stopped"); expect(m.pause?.kind).toBe("allowance_unknown");
    expect(hh.jobsLabeled("review-greet")).toEqual([]);
    expect(m.invocations?.entries.filter(e => e.label === "review-greet")).toEqual([]);
    expect(readAllowance).not.toHaveBeenCalled();
  });
  it("warns when a fresh allowance receipt ages out during pre-review capture under warn policy", async () => {
    let now = Date.parse("2026-10-31T00:00:00.000Z");
    h = new MissionHarness({ features: [feature("greet")], clock: { now: () => now, sleep: async ms => { now += ms; } } });
    const hh = h; const warn = vi.fn();
    for (const provider of ["claude", "codex"] as const) hh.quota.recordAllowanceBatch(provider,
      (["five_hour", "seven_day"] as const).map(window => ({ window, utilization: 0.1, reset: { kind: "supplied", value: now + 3_600_000 } })));
    const capture = captures.captureReviewSubject; let reached = false;
    vi.spyOn(captures, "captureReviewSubject").mockImplementation(async (...args) => {
      const result = await capture(...args);
      if (!reached && args[1].kind === "feature") { reached = true; now += 600_001; }
      return result;
    });
    await hh.run(hh.createMission("greenfield").id, { logger: { info() {}, warn, error() {} } });
    expect(hh.jobsLabeled("review-greet")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith("Allowance could not be confirmed; the reserve is not assured.", expect.objectContaining({ policy: "warn" }));
  });
  it("does not buy another rubric call solely for unavailable committed-capture proof", async () => {
    const hh = harness(true); const capture = captures.captureReviewSubject;
    vi.spyOn(captures, "captureReviewSubject").mockImplementation(async (...args) => {
      const result = await capture(...args); return args[1].kind === "feature" ? { ...result, complete: false } : result;
    });
    const m = await hh.run(hh.createMission("greenfield", { plan: modePlan }).id);
    expect(hh.jobsLabeled("review-greet")).toHaveLength(1);
    expect(m.features[0]?.checked?.unfinished).toBe(true);
    expect(m.status).toBe("stopped"); expect(m.checkpoint?.kind).toBe("feature"); expect(m.features[0]?.status).not.toBe("done");
    expect(completed(m.features[0]).filter(e => e.stage === "review")).toEqual([]);
  });
  it.each(["stop", "deadline"])("does not reserve or launch when %s arrives during pre-review capture", async kind => {
    let now = Date.parse("2026-10-31T00:00:00.000Z");
    h = new MissionHarness({ features: [feature("greet")], clock: { now: () => now, sleep: async ms => { now += ms; } } });
    const hh = h; const controller = new AbortController(); const deadline = now + 60_000;
    const capture = captures.captureReviewSubject; let reached = false;
    vi.spyOn(captures, "captureReviewSubject").mockImplementation(async (...args) => {
      const result = await capture(...args);
      if (!reached && args[1].kind === "feature") { reached = true; if (kind === "stop") controller.abort(); else now = deadline; }
      return result;
    });
    const m = await hh.run(hh.createMission("greenfield").id, { signal: controller.signal, deadline });
    expect(reached).toBe(true); expect(m.status).toBe("stopped");
    expect(hh.jobsLabeled("review-greet")).toEqual([]);
    expect(m.invocations?.entries.filter(e => e.label === "review-greet")).toEqual([]);
  });
  it.each(["first", "last"])("uses only the final fallback capture when %s pre-capture is incomplete", async badAttempt => {
    const hh = harness(); let calls = 0; const capture = captures.captureReviewSubject;
    vi.spyOn(captures, "captureReviewSubject").mockImplementation(async (...args) => {
      const result = await capture(...args);
      if (args[1].kind === "feature" && ++calls === (badAttempt === "first" ? 1 : 3)) return { ...result, files: [], complete: false };
      return result;
    });
    hh.agents.reviewer = (job, call) => call.label === "review-greet" && call.n === 1 ? { outcome: "auth" } : hh.defaults.reviewer(job, call);
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(hh.jobsLabeled("review-greet")).toHaveLength(2);
    const current = completed(m.features[0]).filter(e => e.stage === "review");
    expect(current).toHaveLength(badAttempt === "first" ? 1 : 0);
    if (current.length) expect(current[0]?.jobId).toBe(hh.jobsLabeled("review-greet")[1]?.id);
  });

  it("records feature, plan and final review actual jobs with exact distinct subjects", async () => {
    const hh = harness(); const m = await hh.run(hh.createMission("greenfield").id); const f = m.features[0]!;
    const featureJob = hh.jobsLabeled("review-greet").at(-1)!;
    const finalJob = hh.jobsLabeled("gate-c").at(-1)!; const planJob = hh.jobsLabeled("gate-a").at(-1)!;
    expect(completed(f)).toContainEqual(expect.objectContaining({ jobId: featureJob.id, stage: "review", scope: { kind: "feature", featureId: "greet" },
      actual: expect.objectContaining({ provider: featureJob.provider, model: featureJob.model }), subject: { kind: "feature_commit", featureId: "greet", commit: f.passingCommit } }));
    expect(completed(m)).toContainEqual(expect.objectContaining({ jobId: planJob.id, stage: "plan_review", scope: { kind: "plan" }, subject: { kind: "plan", planHash: expect.stringMatching(/^[a-f0-9]{64}$/u) } }));
    expect(completed(m)).toContainEqual(expect.objectContaining({ jobId: finalJob.id, stage: "final_review", scope: { kind: "application" }, subject: { kind: "application_commit", commit: f.commit } }));
    for (const row of [...completed(f), ...completed(m)]) {
      const invocation = m.invocations?.entries.find(e => e.jobId === row.jobId)!;
      expect(invocation.scope).toEqual(row.scope); expect(invocation.stage).toBe(row.stage);
      expect(invocation.observation?.actual).toEqual(row.actual);
      expect(invocation.cleanedAt).toBeDefined();
    }
  });
  it("records actual rubric checking separately from a requested family", async () => {
    const hh = harness(true); const m = await hh.run(hh.createMission("greenfield", { ownerStops: false, plan: modePlan }).id);
    expect(completed(m.features[0])).toContainEqual(expect.objectContaining({ stage: "review", jobId: hh.jobsLabeled("review-greet").at(-1)!.id }));
    expect(m.features[0]?.checked?.unfinished).not.toBe(true);
  });
  it("uses the final fallback invocation without crediting its failed predecessor", async () => {
    const hh = harness(); hh.agents.reviewer = (job, call) => call.label === "review-greet" && call.n === 1 ? { outcome: "auth" } : hh.defaults.reviewer(job, call);
    const m = await hh.run(hh.createMission("greenfield").id); const calls = hh.jobsLabeled("review-greet");
    expect(calls).toHaveLength(2); expect(calls[0]?.provider).not.toBe(calls[1]?.provider);
    expect(completed(m.features[0]).filter(e => e.stage === "review").map(e => e.jobId)).toEqual([calls[1]!.id]);
    expect(completed(m.features[0]).find(e => e.stage === "review")?.actual?.provider).toBe(calls[1]!.provider);
  });
  it.each(["feature", "rubric", "final", "plan"])("does not credit a malformed %s answer", async which => {
    const hh = harness(which === "rubric");
    const label = which === "final" ? "gate-c" : which === "plan" ? "gate-a" : "review-greet";
    hh.agents.reviewer = (job, call) => call.label === label ? { structured: {} } : hh.defaults.reviewer(job, call);
    const m = await hh.run(hh.createMission("greenfield", { ownerStops: false, ...(which === "rubric" && { plan: modePlan }) }).id);
    const ids = hh.jobsLabeled(label).map(j => j.id);
    expect([...completed(m), ...completed(m.features[0])].filter(e => ids.includes(e.jobId))).toEqual([]);
    expect(provenance(which === "final" || which === "plan" ? m : m.features[0])?.entries.some(e => ids.includes(e.jobId) && e.outcome === "incomplete")).toBe(true);
  });
  it.each(["restored", "unknown"] as const)("denies completed feature review with readonlyMutation %s", async readonlyMutation => {
    const hh = harness();
    for (const runner of [hh.claude, hh.codex]) {
      const run = runner.run.bind(runner);
      vi.spyOn(runner, "run").mockImplementation(async (job, options): Promise<RunResult> => {
        const r = await run(job, options); return labelOf(job) === "review-greet" ? { ...r, readonlyMutation } : r;
      });
    }
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(completed(m.features[0]).filter(e => e.stage === "review")).toEqual([]);
    expect(provenance(m.features[0])?.entries.some(e => e.stage === "review" && e.outcome === "incomplete")).toBe(true);
  });
  it.each(["dirty", "committed"])("denies completed review of %s mutated source", async kind => {
    const hh = harness();
    hh.agents.reviewer = (job, call) => call.label === "review-greet" ? { structured: review(), edit: async cwd => {
      writeFile(cwd, "review-changed.txt", "changed"); if (kind === "committed") await hh.git.commitAll(cwd, "fixture reviewer changed");
    } } : hh.defaults.reviewer(job, call);
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(completed(m.features[0]).filter(e => e.stage === "review")).toEqual([]);
    expect(provenance(m.features[0])?.entries.some(e => e.stage === "review" && e.outcome === "incomplete")).toBe(true);
  });
  it("never invents a completed job identity when the executor omits its final ID", async () => {
    const run = RoleExecutor.prototype.exec;
    vi.spyOn(RoleExecutor.prototype, "exec").mockImplementation(async function (this: RoleExecutor, request) {
      const result = await run.call(this, request); return request.label === "review-greet" ? { ...result, jobId: undefined } : result;
    });
    const hh = harness(); const m = await hh.run(hh.createMission("greenfield").id);
    expect(completed(m.features[0]).filter(e => e.stage === "review")).toEqual([]);
  });
  it("preserves damaged provenance instead of replacing it with a successful empty history", async () => {
    const hh = harness(); const save = hh.store.save.bind(hh.store); let injected = false;
    vi.spyOn(hh.store, "save").mockImplementation((m, now) => {
      if (!injected && m.features[0]?.status === "reviewing") {
        injected = true; (m.features[0] as unknown as { provenance: unknown }).provenance = { version: 999, retain: "raw fixture" };
      } return save(m, now);
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(injected).toBe(true); expect(provenance(m.features[0])).toEqual({ version: 999, retain: "raw fixture" });
    expect(m.features[0]).toHaveProperty("provenanceUncertain", true);
  });
  it("rolls back completed review adoption on save failure before stopping", async () => {
    const hh = harness(); const save = hh.store.save.bind(hh.store); let failed = false;
    vi.spyOn(hh.store, "save").mockImplementation((m, now) => {
      if (!failed && completed(m.features[0]).some(e => e.stage === "review")) { failed = true; throw Error("fixture evidence save failure"); }
      return save(m, now);
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(failed).toBe(true); expect(m.status).toBe("stopped"); expect(m.features[0]?.status).toBe("reviewing");
    expect(completed(m.features[0]).filter(e => e.stage === "review")).toEqual([]);
    expect(completed(hh.load(m.id).features[0]).filter(e => e.stage === "review")).toEqual([]);
  });
});
