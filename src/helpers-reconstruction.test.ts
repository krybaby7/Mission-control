import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOutput, createFixtureRepo, diagnosis, feature, featureTestPath, implementFeature, labelOf, MissionHarness, specOutput, writeFeatureTest } from "../test/fixtures/mission-harness.js";
import { applyAnswer } from "./checkpoint.js";
import { main } from "./cli.js";
import { defaultConfig, loadConfig } from "./config.js";
import { buildReportFacts, renderReport } from "./report.js";
import { MissionStore } from "./state.js";
import type { HelperSettings } from "./types.js";

const ON: HelperSettings = { contextPack: true, failureDigest: true, reportProse: true };
const OFF: HelperSettings = { contextPack: false, failureDigest: false, reportProse: false };
const roots: string[] = [];
let h: MissionHarness | undefined;
afterEach(() => { vi.unstubAllEnvs(); h?.cleanup(); h = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function folder(): string { const root = mkdtempSync(join(tmpdir(), "mc-helpers-reconstruction-")); roots.push(root); return root; }
function settings(text: string) { const file = join(folder(), "config.yaml"); writeFileSync(file, text); return loadConfig(file); }
function create(store: MissionStore, helpers?: HelperSettings) {
  return store.createMission({ kind: "greenfield", title: "Helpers", request: "Build the fixture", repoPath: "", baseBranch: "main", profile: "mixed", helpers, nowMs: Date.now() });
}

describe("P4 helper settings and saved snapshots", () => {
  it("defaults omitted section and keys to true", () => {
    expect(defaultConfig().helpers).toEqual(ON);
    expect(settings("").helpers).toEqual(ON);
    expect(settings("helpers:\n  contextPack: false\n").helpers).toEqual({ ...ON, contextPack: false });
  });
  it.each(["helpers: null", "helpers: false", "helpers: []", "helpers:\n  contextPack: null", "helpers:\n  failureDigest: yes", "helpers:\n  reportProse: 0", "helpers:\n  surprise: false"])("rejects malformed helper settings: %s", (text) => {
    expect(() => settings(text)).toThrow(/helpers/iu);
  });
  it("stores a detached resolved snapshot and defaults the convenience path", () => {
    const store = new MissionStore(folder());
    const supplied = { ...OFF };
    const m = create(store, supplied);
    supplied.contextPack = true;
    expect(m.helpers).toEqual(OFF);
    expect(store.load(m.id).helpers).toEqual(OFF);
    expect(create(store).helpers).toEqual(ON);
  });
  it.each([null, {}, { ...ON, reportProse: "false" }, { ...ON, unexpected: false }])("refuses damaged saved snapshot %j", (helpers) => {
    const store = new MissionStore(folder());
    const m = create(store);
    writeFileSync(join(store.missionDir(m.id), "mission.json"), JSON.stringify({ ...m, helpers }));
    expect(() => store.load(m.id)).toThrow(/helpers/iu);
  });
  it("reports legacy all-on and recorded settings without reading global config", () => {
    const store = new MissionStore(folder());
    const m = create(store, OFF);
    expect(buildReportFacts(m, [])).toContain("Optional helpers: context suggestions off; failure summaries off; report prose off.");
    expect(renderReport(m, { prose: null, usage: [], screenshots: [], generatedAt: m.updatedAt })).toContain("Optional helpers: context suggestions off; failure summaries off; report prose off.");
    delete m.helpers;
    expect(buildReportFacts(m, [])).toContain("Optional helpers: context suggestions on; failure summaries on; report prose on.");
  });
});

const combinations = Array.from({ length: 8 }, (_, mask) => ({ contextPack: Boolean(mask & 1), failureDigest: Boolean(mask & 2), reportProse: Boolean(mask & 4) }));
describe("P4 dispatcher required work with optional helpers", () => {
  it.each(combinations)("runs the required two-feature sequence for helpers %j", async (helpers) => {
    h = new MissionHarness();
    const hh = h;
    hh.agents.engineer = (job, call) => call.label === "build-greet" && call.n === 1
      ? { edit: (cwd) => implementFeature(cwd, "greet", "wrong"), structured: buildOutput("first attempt") }
      : hh.defaults.engineer(job, call);
    const m = create(hh.store, helpers);
    const result = await hh.run(m.id);
    expect(result.status).toBe("done");
    const labels = hh.jobs.map(labelOf);
    for (const required of ["spec", "gate-a", "init", "test-greet", "build-greet", "review-greet", "test-farewell", "build-farewell", "review-farewell", "gate-c"]) expect(labels, required).toContain(required);
    expect(hh.jobsLabeled("context-greet")).toHaveLength(helpers.contextPack ? 1 : 0);
    expect(hh.jobsLabeled("context-farewell")).toHaveLength(helpers.contextPack ? 1 : 0);
    expect(hh.jobsLabeled("digest-greet")).toHaveLength(helpers.failureDigest ? 1 : 0);
    expect(hh.jobsLabeled("report-prose")).toHaveLength(helpers.reportProse ? 1 : 0);
    expect(hh.jobsLabeled("build-greet")[1]?.prompt).toContain("wrong");
    expect(result.agentRuns).toBe(hh.jobs.length);
    expect(hh.store.readUsage()).toHaveLength(hh.jobs.length);
    expect(hh.jobsFor("scout").every((job) => job.model === "claude-haiku-5-5")).toBe(true);
    expect(readFileSync(hh.store.reportPath(m.id), "utf8")).toContain(`context suggestions ${helpers.contextPack ? "on" : "off"}`);
  });
  it("keeps a legacy mission all-on after global settings change", async () => {
    h = new MissionHarness({ configure: (c) => { c.helpers = { ...OFF }; }, features: [feature("greet")] });
    const m = create(h.store);
    delete m.helpers;
    h.store.save(m);
    expect((await h.run(m.id)).status).toBe("done");
    expect(h.jobsLabeled("context-greet")).toHaveLength(1);
    expect(h.jobsLabeled("report-prose")).toHaveLength(1);
  });
  it("retains the saved settings and pending owner stop across restart", async () => {
    h = new MissionHarness({ features: [feature("greet")] });
    const m = create(h.store, OFF);
    m.checkpoints = ["plan"];
    h.store.save(m);
    const parked = await h.run(m.id);
    expect(parked.checkpoint?.state).toBe("pending");
    const count = h.jobs.length;
    h.config.helpers = { ...ON };
    const resumed = await h.run(m.id);
    expect(resumed.helpers).toEqual(OFF);
    expect(resumed.checkpoint?.state).toBe("pending");
    expect(h.jobs).toHaveLength(count);
    expect(applyAnswer(h.store, m.id, { decision: "approve" }, h.clock.now()).ok).toBe(true);
    expect((await h.run(m.id)).status).toBe("done");
    expect(h.jobsFor("scout")).toEqual([]);
  });
  it("keeps the mechanical Haiku build and escalation when helpers are off", async () => {
    h = new MissionHarness({ features: [feature("greet", [], "mechanical")] });
    const hh = h;
    hh.agents.engineer = (job, call) => call.label === "build-greet" && call.n === 1
      ? { edit: (cwd) => implementFeature(cwd, "greet", "wrong"), structured: buildOutput() }
      : hh.defaults.engineer(job, call);
    const m = create(hh.store, OFF);
    expect((await hh.run(m.id)).status).toBe("done");
    expect(hh.jobsLabeled("build-greet")[0]?.model).toBe("claude-haiku-5-5");
    expect(hh.jobsLabeled("build-greet")[1]?.model).not.toBe("claude-haiku-5-5");
    expect(hh.jobsFor("scout")).toEqual([]);
  });
  it("still diagnoses and amends a disputed test with every helper disabled", async () => {
    h = new MissionHarness({ features: [feature("greet")] });
    const hh = h;
    hh.agents.test_author = (job, call) => call.n === 1
      ? { edit: (cwd) => writeFeatureTest(cwd, "greet", "GREET"), structured: { testFiles: [featureTestPath("greet")], notes: "" } }
      : hh.defaults.test_author(job, call);
    hh.agents.engineer = (job, call) => call.label === "build-greet" && call.n === 1
      ? { edit: (cwd) => implementFeature(cwd, "greet"), structured: buildOutput("implemented", { file: featureTestPath("greet"), reason: "Expected lowercase greet." }) }
      : hh.defaults.engineer(job, call);
    hh.agents.architect = (job, call) => call.label === "diagnose-greet"
      ? { structured: diagnosis("amend_tests", "Keep the implementation.", "Expected lowercase greet.") }
      : hh.defaults.architect(job, call);
    const m = create(hh.store, OFF);
    expect((await hh.run(m.id)).status).toBe("done");
    expect(hh.jobsLabeled("diagnose-greet")).toHaveLength(1);
    expect(hh.jobsLabeled("diagnose-greet")[0]?.prompt).toContain("Expected lowercase greet.");
    expect(hh.jobsLabeled("test-greet")).toHaveLength(2);
    expect(hh.jobsFor("scout")).toEqual([]);
  });
  it("reuses a supplied plan and retains plan approval and final review with helpers off", async () => {
    h = new MissionHarness({ features: [feature("greet")] });
    const m = create(h.store, OFF);
    m.plan = { spec: specOutput([feature("greet")]), sha256: "a".repeat(64), at: m.createdAt };
    m.checkpoints = ["plan"]; // the production plan queue entry point supplies this stop
    h.store.save(m);
    expect((await h.run(m.id)).checkpoint?.state).toBe("pending");
    expect(h.jobs.map(labelOf)).toEqual(["gate-a"]);
    expect(applyAnswer(h.store, m.id, { decision: "approve" }, h.clock.now()).ok).toBe(true);
    expect((await h.run(m.id)).status).toBe("done");
    expect(h.jobsLabeled("spec")).toEqual([]);
    expect(h.jobsLabeled("gate-c")).toHaveLength(1);
    expect(h.jobsFor("scout")).toEqual([]);
  });
  it("omits maker context without losing the required rubric check", async () => {
    const notes = { ...feature("notes"), mode: "review" as const, acceptance: ["The note explains the feature clearly."] };
    h = new MissionHarness({ features: [notes] });
    const m = create(h.store, OFF);
    // Modes enter through supplied plans, not the planner's deliberately strict tests-only output schema.
    m.plan = { spec: specOutput([notes]), sha256: "b".repeat(64), at: m.createdAt };
    h.store.save(m);
    const result = await h.run(m.id);
    expect(result.status).toBe("done");
    expect(h.jobsLabeled("context-notes")).toEqual([]);
    expect(h.jobs.some((job) => job.systemPrompt.startsWith("# Role: checker"))).toBe(true);
    expect(h.jobsLabeled("gate-c")).toHaveLength(1);
  });
  it("captures helpers at all three production queue entry points", async () => {
    h = new MissionHarness();
    const config = join(h.root, "config.yaml");
    writeFileSync(config, `home: ${h.home}\nworkspaceRoot: ${h.workspace}\nhelpers:\n  contextPack: false\n  failureDigest: false\n  reportProse: false\n`);
    vi.stubEnv("MC_CONFIG", config);
    const repo = join(h.workspace, "existing");
    await createFixtureRepo(h.git, repo);
    let error = "";
    const io = { stdout: () => {}, stderr: (text: string) => { error += text; } };
    expect(await main(["node", "mc", "new", "A new app"], io), error).toBe(0);
    expect(await main(["node", "mc", "feature", repo, "A small change"], io), error).toBe(0);
    const plan = "mc-plan 1\nname: Supplied\nrequest: A small app\napp-name: Supplied\nsummary: A small app\ncontract: One answer\n\nfeature: greet\ntitle: Greet\nstory: Give an answer\ncheck: The answer says greet\n";
    expect(await main(["node", "mc", "plan", "queue", "-"], { ...io, stdin: async () => plan }), error).toBe(0);
    expect(h.store.list()).toHaveLength(3);
    expect(h.store.list().every((m) => JSON.stringify(m.helpers) === JSON.stringify(OFF))).toBe(true);
  });
});
