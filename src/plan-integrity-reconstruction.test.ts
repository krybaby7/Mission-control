import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feature, mission } from "../test/fixtures/modes/prompt-inputs.js";
import { buildOutput, checksInBrief, implementFeature, MissionHarness, planSource, writeDeliverable, writeFile } from "../test/fixtures/mission-harness.js";
import { applyAnswer } from "./checkpoint.js";
import { main } from "./cli.js";
import { reconcileSuppliedPlan } from "./plan-integrity.js";
import { buildReportFacts } from "./report.js";
import { planOf } from "./state.js";
import { laterFeatureFiles } from "./later-files.js";
import { buildPrompt, makePrompt, specPrompt, testAuthorPrompt } from "./prompts.js";
import { normalizeSpecText } from "./schemas.js";
import type { SpecOutput } from "./types.js";

const TEXT = `mc-plan 1
name: Integrity
request: Build the fixture
app-name: Fixture App
summary: Original wording
feature: greet
title: Greeting
story: Make a greeting
check: answer in src/greet.mjs returns greet
check: Keep the second check exactly
feature: farewell
title: Farewell
story: Make a farewell
needs: greet
check: answer in src/farewell.mjs returns farewell
`;
const original = () => planSource(TEXT).spec;
let h: MissionHarness | undefined;
afterEach(() => { vi.unstubAllEnvs(); h?.cleanup(); h = undefined; });

describe("P6 automatic revisions preserve supplied requirements", () => {
  async function revise(change: (spec: SpecOutput) => void) {
    const plan = planSource(TEXT);
    const candidate = structuredClone(plan.spec);
    change(candidate);
    h = new MissionHarness({ agents: {
      reviewer: () => ({ structured: { verdict: "revise", issues: ["Clarify the technical wording"] } }),
      architect: () => ({ structured: candidate }),
    } });
    const m = h.createMission("greenfield", { plan, checkpoints: ["plan"] });
    const result = await h.run(m.id);
    expect(result.checkpoint?.state).toBe("pending");
    expect(result.plan?.spec).toEqual(original());
    expect(result.plan?.sha256).toBe(plan.sha256);
    return result;
  }
  it("keeps tests-mode checks byte for byte while applying technical wording", async () => {
    const m = await revise((s) => { s.summary = "Clearer implementation wording"; s.features[0]!.acceptance = ["Weaker check"]; });
    expect(m.spec?.summary).toBe("Clearer implementation wording");
    expect(m.features[0]?.acceptance).toEqual(original().features[0]!.acceptance);
    expect(m.plan?.review).toMatchObject({ outcome: "revised", latestRevision: "partly_rejected" });
    expect(m.plan?.review).toHaveProperty("rejectedChanges");
    expect(m.checkpoint?.look.lines.join("\n")).toContain("retained");
    expect(readFileSync(h!.store.reportPath(m.id), "utf8")).toContain("rejected");
  });
  it("does not describe a check-only rejected edit as applied", async () => {
    const m = await revise((s) => { s.features[0]!.acceptance.reverse(); });
    expect(m.spec).toEqual(original());
    expect(m.plan?.review).toMatchObject({ outcome: "not_applied", latestRevision: "not_applied" });
  });
  it.each(["drop", "add", "rename", "dependencies", "duplicate", "unknown dependency", "cycle"])("rejects an incompatible %s edit", async (kind) => {
    const m = await revise((s) => {
      s.summary = "This should not apply";
      if (kind === "drop") s.features.pop();
      if (kind === "add") s.features.push({ ...s.features[0]!, id: "extra" });
      if (kind === "rename") s.features[1]!.id = "renamed";
      if (kind === "dependencies") s.features[1]!.deps = [];
      if (kind === "duplicate") s.features[1]!.id = "greet";
      if (kind === "unknown dependency") s.features[1]!.deps = ["missing"];
      if (kind === "cycle") s.features[0]!.deps = ["farewell"];
    });
    expect(m.spec).toEqual(original());
    expect(m.plan?.review?.outcome).toBe("not_applied");
  });
  it("keeps the immutable reference after an interrupted gate A and a second rejected proposal", async () => {
    const first = await revise((s) => { s.summary = "Accepted wording"; s.features[0]!.acceptance = ["Weakened"]; });
    const hh = h!;
    const candidate = original(); candidate.features.pop();
    hh.agents.architect = () => ({ structured: candidate });
    const interrupted = hh.load(first.id);
    interrupted.stage = "gate_a"; interrupted.status = "stopped"; delete interrupted.checkpoint;
    hh.store.save(interrupted);
    const again = await hh.run(first.id);
    expect(again.spec?.summary).toBe("Accepted wording");
    expect(again.plan?.spec).toEqual(original());
    expect(again.features[0]?.acceptance).toEqual(original().features[0]!.acceptance);
    expect(again.plan?.review).toMatchObject({ outcome: "revised", latestRevision: "not_applied" });
    expect(again.checkpoint?.look.lines.join("\n")).toContain("latest proposed changes were not applied");
    expect(again.checkpoint?.state).toBe("pending");
  });
  it("refuses an unusable original before launching a planning job", async () => {
    h = new MissionHarness(); const plan = planSource(TEXT); plan.spec.features[0]!.deps = ["missing"];
    const m = h.createMission("greenfield", { plan, checkpoints: ["plan"] });
    const result = await h.run(m.id);
    expect(result.status).not.toBe("done");
    expect(result.decisionsNeeded.join(" ")).toContain("missing");
    expect(h.jobs).toEqual([]);
  });
  it("does not manufacture an applied revision from object property order", async () => {
    const m = await revise((s) => { s.features = s.features.map((f) => ({ deps: f.deps, kind: f.kind, acceptance: f.acceptance, story: f.story, title: f.title, id: f.id })); });
    expect(m.plan?.review).toMatchObject({ outcome: "not_applied", latestRevision: "not_applied" });
  });
});

describe("P6 conservative reconciliation details", () => {
  it.each(["whitespace", "duplicate", "literal", "order"])("retains exact checks after %s edits and copies metadata without aliases", (kind) => {
    const source = original(); const f = source.features[0]!;
    f.mode = "owner"; f.effort = "deep"; f.kind = "mechanical"; f.expect = { headings: ["One"], words: [1, 40] };
    const before = structuredClone(source); const candidate = structuredClone(source);
    const c = candidate.features[0]!; delete c.mode; delete c.effort; delete c.expect; c.title = "Clearer title"; c.kind = "standard";
    if (kind === "whitespace") c.acceptance[0] += " ";
    if (kind === "duplicate") c.acceptance.push(c.acceptance[0]!);
    if (kind === "literal") c.acceptance[0] += String.raw`\n`;
    if (kind === "order") c.acceptance.reverse();
    candidate.features.reverse();
    const result = reconcileSuppliedPlan(source, source, candidate);
    expect(result.latestRevision).toBe("partly_rejected");
    expect(result.spec.features.map((f) => f.id)).toEqual(source.features.map((f) => f.id));
    expect(result.spec.features[0]).toEqual({ ...f, title: "Clearer title" });
    expect(result.rejectedChanges.join(" ")).toContain("acceptance edits at positions");
    expect(result.rejectedChanges.join(" ")).not.toContain("proposed mode");
    result.spec.features[0]!.acceptance.push("mutation"); result.spec.features[0]!.expect!.headings!.push("mutation");
    expect(source).toEqual(before);
  });
  it("falls back to the original if an earlier effective plan already drifted", () => {
    const source = original(); const drift = structuredClone(source); drift.features[0]!.acceptance = ["weakened"];
    const invalid = structuredClone(source); invalid.features.pop();
    expect(reconcileSuppliedPlan(source, drift, invalid).spec).toEqual(source);
  });
  it.each([["applied"], [["applied"]], "future", 1, null].map((latestRevision) => ({ latestRevision })))("does not trust damaged reconciliation metadata %j", ({ latestRevision }) => {
    const plan = planSource(TEXT);
    (plan as unknown as { review: unknown }).review = { outcome: "revised", issues: [], latestRevision };
    expect(planOf({ plan })?.review).toBeUndefined();
    expect(planOf({ plan })?.spec).toBe(plan.spec);
  });
});

describe("P6 overlap disclosure through the engine", () => {
  it.each([false, true])("persists overlap in look, plan details and report; maker=%s", async (maker) => {
    h = new MissionHarness(); const hh = h;
    hh.agents.engineer = (job, call) => call.label === "build-greet" ? { edit: (cwd) => {
      if (maker) writeDeliverable(cwd, "greet", checksInBrief(job.prompt)); else implementFeature(cwd, "greet");
      writeFile(cwd, "docs/LATER.md", "# Later\n\nThis belongs to the later feature.\n");
    }, structured: buildOutput() } : hh.defaults.engineer(job, call);
    const plan = planSource(TEXT); plan.spec.features[1]!.acceptance.push("Create docs/LATER.md");
    if (maker) { plan.spec.features[0]!.mode = "review"; plan.spec.features[0]!.acceptance = ["The greeting document explains its purpose."]; }
    const m = hh.createMission("greenfield", { plan, checkpoints: ["feature"] });
    const parked = await hh.run(m.id);
    const line = "It also made “docs/LATER.md”, which belongs to the later feature “Farewell”.";
    expect(parked.features[0]?.alsoMade).toEqual([{ file: "docs/LATER.md", belongsTo: "farewell" }]);
    expect(parked.checkpoint?.look.lines).toContain(line);
    const config = join(hh.root, "config.yaml"); writeFileSync(config, `home: ${hh.home}\nworkspaceRoot: ${hh.workspace}\n`); vi.stubEnv("MC_CONFIG", config);
    let output = ""; const io = { stdout: (text: string) => { output += text; }, stderr: () => {} };
    expect(await main(["node", "mc", "plan", "show", m.id], io)).toBe(0);
    expect(output).toContain(line);
    expect(applyAnswer(hh.store, m.id, { decision: "approve" }, hh.clock.now()).ok).toBe(true);
    const next = await hh.run(m.id);
    expect(next.features[0]?.status).toBe("done");
    expect(buildReportFacts(next, [])).toContain(line);
    expect(readFileSync(hh.store.reportPath(m.id), "utf8")).toContain(line);
  });
});

describe("P6 scope applies to every multi-feature work brief", () => {
  it.each([undefined, "review", "owner"] as const)("restricts a %s maker or builder to its own feature", (mode) => {
    const first = feature({ ...original().features[0]!, mode });
    const later = feature({ ...original().features[1]!, status: "pending" });
    const m = mission({ features: [first, later], spec: original() });
    const prompts = mode ? [makePrompt(m, first, { rung: 0, fileList: [] })] : [testAuthorPrompt(m, first, { fileList: [] }), buildPrompt(m, first, { rung: 0, fileList: [] })];
    for (const p of prompts) {
      expect(p).toContain("## The contract and the other features");
      expect(p).toContain("whole plan");
      expect(p).toContain("another feature");
      expect(p).toContain("`farewell`");
      if (mode) expect(p).not.toContain("frozen tests");
    }
  });
  it.each([undefined, "review", "owner"] as const)("records text-only overlap for %s work", (mode) => {
    const first = feature({ ...original().features[0]!, mode });
    const later = feature({ ...original().features[1]!, status: "pending", acceptance: ["Create docs/LATER.md"] });
    const m = mission({ features: [first, later], spec: original() });
    expect(laterFeatureFiles(m, first, ["docs/LATER.md"])).toEqual([{ file: "docs/LATER.md", belongsTo: "farewell" }]);
    expect(laterFeatureFiles({ ...m, features: [first] }, first, ["docs/LATER.md"])).toEqual([]);
    expect(laterFeatureFiles(m, { ...first, acceptance: ["Use docs/LATER.md"] }, ["docs/LATER.md"])).toEqual([]);
  });
  it("adds no scope warning to a single feature", () => {
    const f = feature();
    const m = mission({ features: [f] });
    expect(buildPrompt(m, f, { rung: 0, fileList: [] })).not.toContain("## The contract and the other features");
  });
});

describe("P6 JSON text is parsed exactly once", () => {
  it("preserves literal backslashes, quotes, paths and real newlines in every plan field", () => {
    const literal = String.raw`C:\new\notes; a\nb\nc; \"one\" and \"two\"; /\n/` + "\nA real line";
    const s = original();
    s.appName = literal; s.summary = literal; s.uiContract = literal; s.assumptions = [literal];
    s.features[0] = { ...s.features[0]!, title: literal, story: literal, acceptance: [literal] };
    const parsed = JSON.parse(JSON.stringify(s)) as SpecOutput;
    expect(normalizeSpecText(parsed)).toEqual(s);
    expect(normalizeSpecText({ ...s, summary: String.raw`a\nb\nc` }).summary).toBe(String.raw`a\nb\nc`);
  });
  it("tells the planner to use JSON escaping once", () => {
    expect(specPrompt(mission(), null)).toContain("JSON escaping once");
  });
});
