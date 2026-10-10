import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentHandler,
  type AgentScript,
  buildOutput,
  createFixtureRepo,
  diagnosis,
  feature,
  featureTestPath,
  finding,
  FIXTURE_VERIFY,
  type HarnessOptions,
  implementFeature,
  labelOf,
  MissionHarness,
  review,
  specOutput,
  writeFeatureTest,
  writeFile,
  writeScaffold,
} from "../test/fixtures/mission-harness.js";
import { defaultConfig } from "./config.js";
import { assign, roleFamily, validateSpec } from "./dispatcher.js";
import type { AgentJob, Attempt, Mission, MissionEvent, Role, SpecFeature } from "./types.js";
import { FakeClock } from "./util/clock.js";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";
const ASTRA = "gpt-6-astra";
const SOL = "gpt-6.1-sol";
const MIN = 60_000;
const WAIT_MARGIN_MS = 45_000;
/** A test file that passes whether or not the feature exists. */
const VACUOUS_TEST = 'import test from "node:test";\n\ntest("greet", () => {});\n';
const DOCUMENTED_GREET = '/** The answer. */\nexport function answer() {\n  return "greet";\n}\n';

// ───────────────────────────── Pure helpers ─────────────────────────────

function bareMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "2026-01-01-x",
    kind: "greenfield",
    title: "x",
    request: "x",
    repoPath: "",
    baseBranch: "main",
    integrationBranch: "mc/2026-01-01-x",
    profile: "mixed",
    roleOverrides: [],
    status: "queued",
    stage: "spec",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    features: [],
    baselineBroken: false,
    baselineFailures: [],
    decisionsNeeded: [],
    gateCRounds: 0,
    agentRuns: 0,
    notes: [],
    ...overrides,
  };
}

describe("roleFamily and assign", () => {
  const c = defaultConfig();

  it("follows the mixed profile: other = the family the role is relative to", () => {
    const m = bareMission();
    expect(roleFamily(c, m, "architect")).toBe("claude");
    expect(roleFamily(c, m, "engineer")).toBe("codex");
    expect(roleFamily(c, m, "test_author")).toBe("claude"); // other than the engineer
    expect(roleFamily(c, m, "reviewer", "claude")).toBe("codex");
    expect(roleFamily(c, m, "scout")).toBe("claude");
  });

  it("keeps every role on one family in single-family profiles", () => {
    const m = bareMission({ profile: "codex" });
    expect(roleFamily(c, m, "reviewer", "codex")).toBe("codex");
    expect(assign(c, m, "test_author")).toEqual({ family: "codex", tier: "standard", effort: "high" });
  });

  it("applies role overrides over the profile and the role settings", () => {
    const m = bareMission({
      roleOverrides: [
        { role: "engineer", family: "claude" },
        { role: "reviewer", tier: "standard" },
        { role: "reviewer", effort: "max" },
      ],
    });
    expect(roleFamily(c, m, "engineer")).toBe("claude");
    expect(roleFamily(c, m, "test_author")).toBe("codex"); // other than the overridden engineer
    expect(assign(c, m, "reviewer", "claude")).toEqual({ family: "codex", tier: "standard", effort: "max" });
    expect(assign(c, m, "architect")).toEqual({ family: "claude", tier: "frontier", effort: "high" });
  });

  it("rejects an unknown profile", () => {
    expect(() => roleFamily(c, bareMission({ profile: "nope" }), "architect")).toThrow(/unknown profile "nope"/);
  });
});

describe("validateSpec", () => {
  const check = (features: SpecFeature[]) => validateSpec(specOutput(features));

  it("accepts a well-formed plan", () => {
    expect(check([feature("a"), feature("b", ["a"]), feature("c", ["a", "b"])])).toEqual([]);
  });

  it("requires 1 to 25 features", () => {
    expect(check([])).toEqual([expect.stringMatching(/between 1 and 25/)]);
    expect(check(Array.from({ length: 26 }, (_, i) => feature(`f${i}`)))).toEqual([expect.stringMatching(/has 26/)]);
  });

  it("requires unique kebab-case ids", () => {
    const problems = check([feature("Add_Todo"), feature("dup"), feature("dup"), feature("a--b"), feature("x".repeat(61))]).join("\n");
    expect(problems).toMatch(/"Add_Todo" must be kebab-case/);
    expect(problems).toMatch(/"dup" is used more than once/);
    expect(problems).toMatch(/"a--b" must be kebab-case/);
    expect(problems).toMatch(/"x{61}" must be kebab-case .* at most 60 characters/);
  });

  it("rejects unknown deps and cycles", () => {
    expect(check([feature("a", ["ghost"])])).toEqual([expect.stringMatching(/"a" depends on "ghost"/)]);
    expect(check([feature("a", ["c"]), feature("b", ["a"]), feature("c", ["b"])])).toEqual([expect.stringMatching(/cycle: a → c → b → a/)]);
    expect(check([feature("self", ["self"])])).toEqual([expect.stringMatching(/cycle: self → self/)]);
  });
});

// ───────────────────────────── Mission fixtures ─────────────────────────────

let h: MissionHarness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function harness(opts: HarnessOptions = {}): MissionHarness {
  h = new MissionHarness(opts);
  return h;
}

/** The default handler of `role` in the running test's harness. */
function byDefault(role: Role): AgentHandler {
  return (job, call) => {
    if (!h) throw new Error("no harness");
    return h.defaults[role](job, call);
  };
}

/** An engineer whose first `times` builds of `id` return a wrong answer. */
function failingBuilds(times: number, id = "greet"): AgentHandler {
  return (job, call) =>
    call.label === `build-${id}` && call.n <= times
      ? { edit: (cwd) => implementFeature(cwd, id, "wrong"), structured: buildOutput("tried") }
      : byDefault("engineer")(job, call);
}

/** Handlers for every role that answer "usage limit" whenever they run on codex. */
function codexLimitedUntil(resetsAt: number): AgentScript {
  const roles: Role[] = ["architect", "engineer", "test_author", "reviewer", "scout"];
  return Object.fromEntries(
    roles.map((role): [Role, AgentHandler] => [
      role,
      (job, call) => (job.provider === "codex" ? { outcome: "limited", limit: { kind: "session", resetsAt } } : byDefault(role)(job, call)),
    ]),
  );
}

/** [label, model, effort] of every job, in order. */
function runs(jobs: AgentJob[]): [string, string, string][] {
  return jobs.map((j) => [labelOf(j), j.model, j.effort]);
}

function attempts(m: Mission, index = 0): [number, Attempt["action"], string, string, Attempt["outcome"]][] {
  return (m.features[index]?.attempts ?? []).map((a) => [a.rung, a.action, a.model, a.effort, a.outcome]);
}

function events(hh: MissionHarness, id: string, type: string): MissionEvent[] {
  return hh.store.readEvents(id).filter((e) => e.type === type);
}

function readReport(hh: MissionHarness, id: string): string {
  return readFileSync(hh.store.reportPath(id), "utf8");
}

function prompt(hh: MissionHarness, label: string, index = 0): string {
  return hh.jobsLabeled(label)[index]?.prompt ?? "";
}

// ───────────────────────────── Greenfield ─────────────────────────────

describe("Dispatcher: greenfield", () => {
  it("builds the app end to end: spec, gate A, init, tests first, build, review, gate C, finalize", async () => {
    const hh = harness({ configure: (c) => (c.git.branchPrefix = "night") });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m).toMatchObject({ status: "done", stage: "complete", integrationBranch: `night/${m.id}` });
    expect(m.repoPath).toBe(join(hh.workspace, "fixture-app"));
    expect(m.verify).toEqual({ full: FIXTURE_VERIFY.full, tests: FIXTURE_VERIFY.tests, testGlobs: ["tests/**"] });
    expect(m.features.map((f) => [f.id, f.status, f.builtBy, f.attempts.map((a) => a.outcome)])).toEqual([
      ["greet", "done", "codex", ["pass"]],
      ["farewell", "done", "codex", ["pass"]],
    ]);
    expect(m.features.every((f) => f.commit && !f.worktree && !f.branch)).toBe(true);
    expect(m.features[0]?.frozenTests.map((t) => t.path)).toEqual([featureTestPath("greet")]);
    expect(m.notes).toContain("Answers are plain strings.");

    // Who ran what: the mixed profile keeps every check in the family that did not do the work.
    expect(runs(hh.jobs)).toEqual([
      ["spec", OPUS, "high"],
      ["gate-a", ASTRA, "high"],
      ["init", SOL, "medium"],
      ["test-greet", SONNET, "high"],
      ["context-greet", HAIKU, "low"],
      ["build-greet", SOL, "medium"],
      ["review-greet", OPUS, "high"],
      ["test-farewell", SONNET, "high"],
      ["context-farewell", HAIKU, "low"],
      ["build-farewell", SOL, "medium"],
      ["review-farewell", OPUS, "high"],
      ["gate-c", OPUS, "high"],
      ["report-prose", HAIKU, "low"],
    ]);
    expect(hh.jobsLabeled("spec")[0]).toMatchObject({ access: "read-only", noTools: true });
    expect(hh.jobsLabeled("gate-a")[0]).toMatchObject({ access: "read-only", noTools: true });
    expect(hh.jobsLabeled("build-greet")[0]).toMatchObject({ access: "workspace-write", limits: { maxTurns: 80 } });
    expect(hh.jobsLabeled("review-greet")[0]).toMatchObject({ access: "read-only", limits: { maxTurns: 40 } });
    expect(hh.jobsLabeled("review-greet")[0]?.noTools).toBeUndefined();
    expect(prompt(hh, "build-greet")).toContain("**You must not modify these files**");
    expect(m.agentRuns).toBe(hh.jobs.length);
    expect(hh.store.readUsage().filter((u) => u.missionId === m.id)).toHaveLength(hh.jobs.length);

    // main was fast-forwarded to the integrated work and is checked out in the app folder.
    expect(await hh.git.headSha(m.repoPath, "main")).toBe(await hh.git.headSha(m.repoPath, m.integrationBranch));
    expect(await hh.git.currentBranch(m.repoPath)).toBe("main");
    expect(readFileSync(join(m.repoPath, "src/farewell.mjs"), "utf8")).toContain('"farewell"');
    const subjects = (await hh.git.log(m.repoPath, "main")).map((c) => c.subject);
    expect(subjects).toEqual(
      expect.arrayContaining(["chore: scaffold app", "test(greet): acceptance tests", "wip(greet): attempt 1", "feat(greet): Feature greet", "feat(farewell): Feature farewell"]),
    );

    // Done: the integration worktree is gone, the report and the notification exist.
    expect(m.integrationWorktree).toBeUndefined();
    expect(existsSync(join(hh.store.worktreesDir(m.id), "_integration"))).toBe(false);
    expect(readReport(hh, m.id)).toContain("Tonight I built the fixture app.");
    expect(hh.notifications).toEqual([{ title: "Fixture app: done (2/2 features)", message: `Report: ${hh.store.reportPath(m.id)}`, opts: { priority: "default" } }]);

    expect(events(hh, m.id, "stage").map((e) => e.data.to)).toEqual(["gate_a", "init", "features", "gate_c", "finalize", "complete"]);
    expect(events(hh, m.id, "feature.status").map((e) => `${e.data.feature}:${e.data.to}`)).toEqual([
      "greet:testing",
      "greet:building",
      "greet:reviewing",
      "greet:done",
      "farewell:testing",
      "farewell:building",
      "farewell:reviewing",
      "farewell:done",
    ]);
    expect(hh.load(m.id)).toEqual(m);
  });

  it("does nothing for a mission that is already complete", async () => {
    const hh = harness({ features: [feature("greet")] });
    const m = await hh.run(hh.createMission("greenfield").id);
    const jobs = hh.jobs.length;
    expect(await hh.run(m.id)).toEqual(m);
    expect(hh.jobs).toHaveLength(jobs);
  });

  it("fails the mission when the scaffold never passes, and retries the scaffold when run again", async () => {
    let scaffoldWorks = false;
    const hh = harness({
      features: [feature("greet")],
      configure: (c) => (c.ladders.standard = [{ action: "build", tier: "standard", effort: "medium", family: "same" }]),
      agents: {
        engineer: (job, call) => {
          if (call.label !== "init" || scaffoldWorks) return byDefault("engineer")(job, call);
          return { edit: (cwd) => writeFeatureTest(cwd, "smoke"), structured: { summary: "scaffolded", verify: FIXTURE_VERIFY, notes: [] } };
        },
      },
    });
    const id = hh.createMission("greenfield").id;
    const failed = await hh.run(id);
    expect(failed).toMatchObject({ status: "failed", stage: "init" });
    expect(failed.decisionsNeeded).toEqual([expect.stringMatching(/couldn't get the basic app skeleton to pass its own checks/)]);
    expect(events(hh, id, "attempt").map((e) => [e.data.feature, e.data.outcome])).toEqual([["_init", "fail"]]);
    expect(hh.notifications).toEqual([expect.objectContaining({ title: "Fixture app: failed", opts: { priority: "high", tags: ["warning"] } })]);

    scaffoldWorks = true;
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(hh.jobsLabeled("init")).toHaveLength(2);
    expect(prompt(hh, "init", 1)).toContain("## The previous attempt failed");
  });

  it("fails a mission whose profile is not in the config", async () => {
    const hh = harness();
    const m = await hh.run(hh.createMission("greenfield", { profile: "turbo" }).id);
    expect(m).toMatchObject({ status: "failed", stage: "spec" });
    expect(m.decisionsNeeded).toEqual([expect.stringMatching(/profile "turbo", which is not in the config \(available: claude, codex, mixed\)/)]);
    expect(hh.jobs).toHaveLength(0);
  });

  it("puts the app in <slug>-2 when the <slug> folder already holds something else", async () => {
    const hh = harness({ features: [feature("greet")] });
    writeFile(hh.workspace, "fixture-app/notes.txt", "not ours\n");
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("done");
    expect(m.repoPath).toBe(join(hh.workspace, "fixture-app-2"));
    expect(readFileSync(join(hh.workspace, "fixture-app/notes.txt"), "utf8")).toBe("not ours\n");
    expect(existsSync(join(hh.workspace, "fixture-app/.git"))).toBe(false);
  });

  it("forces an engineer override's family and tier onto every rung", async () => {
    const hh = harness({ features: [feature("greet")] });
    const id = hh.createMission("greenfield", { roleOverrides: [{ role: "engineer", family: "claude", tier: "frontier" }] }).id;
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(runs(hh.jobs.filter((j) => j.role !== "scout" && j.role !== "architect"))).toEqual([
      ["gate-a", ASTRA, "high"],
      ["init", OPUS, "medium"],
      ["test-greet", SOL, "high"], // the test author is the other family relative to the claude engineer
      ["build-greet", OPUS, "medium"],
      ["review-greet", ASTRA, "high"],
      ["gate-c", ASTRA, "high"],
    ]);
  });
});

// ───────────────────────────── Spec and gate A ─────────────────────────────

describe("Dispatcher: spec and gate A", () => {
  it("sends spec problems back to the architect once, then fails the mission", async () => {
    const hh = harness({ agents: { architect: () => ({ structured: specOutput([feature("a", ["b"]), feature("b", ["a"])]) }) } });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m).toMatchObject({ status: "failed", stage: "spec" });
    expect(hh.jobsLabeled("spec")).toHaveLength(2);
    expect(prompt(hh, "spec", 1)).toContain("## Your previous answer could not be used");
    expect(prompt(hh, "spec", 1)).toContain("The deps form a cycle: a → b → a.");
    expect(m.decisionsNeeded).toEqual([expect.stringMatching(/couldn't turn your request into a workable plan/)]);
    expect(hh.notifications).toEqual([expect.objectContaining({ title: "Fixture app: failed", opts: { priority: "high", tags: ["warning"] } })]);
    expect(existsSync(hh.store.reportPath(m.id))).toBe(true);
  });

  it("accepts a spec corrected on the retry", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: {
        architect: (job, call) =>
          call.label === "spec" && call.n === 1 ? { structured: specOutput([feature("Greet!")]) } : byDefault("architect")(job, call),
        reviewer: (job, call) => {
          h?.store.requestStop(); // enough once the plan is approved
          return byDefault("reviewer")(job, call);
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m).toMatchObject({ status: "stopped", stage: "init" });
    expect(m.features.map((f) => f.id)).toEqual(["greet"]);
    expect(prompt(hh, "spec", 1)).toContain('Feature id "Greet!" must be kebab-case');
  });

  it("revises the spec when gate A asks for changes", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: {
        reviewer: () => ({ structured: { verdict: "revise", issues: ["Also say goodbye."] } }),
        architect: (job, call) => {
          if (call.label !== "spec" || call.n === 1) return byDefault("architect")(job, call);
          h?.store.requestStop();
          return { structured: specOutput([feature("greet"), feature("farewell", ["greet"])]) };
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m).toMatchObject({ status: "stopped", stage: "init" });
    expect(m.features.map((f) => f.id)).toEqual(["greet", "farewell"]);
    expect(prompt(hh, "spec", 1)).toContain("## Revise your previous spec");
    expect(prompt(hh, "spec", 1)).toContain("Also say goodbye.");
  });

  it("keeps the original spec when the revision is unusable", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: {
        reviewer: () => ({ structured: { verdict: "revise", issues: ["Split greet."] } }),
        architect: (job, call) => {
          if (call.label !== "spec" || call.n === 1) return byDefault("architect")(job, call);
          h?.store.requestStop();
          return { structured: specOutput([feature("greet", ["ghost"])]) };
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.stage).toBe("init");
    expect(m.features.map((f) => f.id)).toEqual(["greet"]);
    expect(m.notes).toContain("The plan reviewer asked for changes that could not be applied: Split greet.");
  });
});

// ───────────────────────────── Escalation ─────────────────────────────

describe("Dispatcher: escalation", () => {
  it("climbs the ladder: same failure twice → diagnosis hint → frontier rung of the other family", async () => {
    let startedFresh: boolean | undefined;
    const hh = harness({
      features: [feature("greet")],
      agents: {
        engineer: (job, call) => {
          if (call.label === "build-greet" && call.n === 3) startedFresh = !existsSync(join(job.cwd, "src/greet.mjs"));
          return failingBuilds(2)(job, call);
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("done");
    expect(attempts(m)).toEqual([
      [0, "build", SOL, "medium", "fail"],
      [1, "build", SOL, "high", "fail"],
      [2, "diagnose", OPUS, "high", "pass"],
      [3, "build", OPUS, "high", "pass"],
    ]);
    const [first, second] = m.features[0]?.attempts ?? [];
    expect(first?.signature).toMatch(/^[0-9a-f]{12}$/);
    expect(second?.signature).toBe(first?.signature);
    expect(m.features[0]).toMatchObject({ hint: "Return the feature id from answer().", builtBy: "claude", rung: 3 });
    expect(startedFresh).toBe(true); // the diagnosis abandoned the failed code

    // Each rung sees the previous failure, its digest and the hint.
    expect(prompt(hh, "build-greet", 1)).toContain("'wrong' !== 'greet'");
    expect(prompt(hh, "build-greet", 1)).toContain("digest: the answer is wrong");
    expect(prompt(hh, "diagnose-greet")).toContain("'wrong' !== 'greet'");
    expect(hh.jobsLabeled("diagnose-greet")[0]).toMatchObject({ access: "read-only", role: "architect" });
    expect(prompt(hh, "build-greet", 2)).toContain("Return the feature id from answer().");
    expect(hh.jobsLabeled("context-greet")).toHaveLength(1);
    expect(hh.jobsLabeled("digest-greet")).toHaveLength(2);
    // Reviewed by the family that did not build the passing version.
    expect(hh.jobsLabeled("review-greet")[0]?.model).toBe(ASTRA);
  });

  it("jumps straight to the diagnose rung when a failure repeats (mechanical ladder)", async () => {
    const hh = harness({ features: [feature("greet", [], "mechanical")], agents: { engineer: failingBuilds(2) } });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("done");
    expect(attempts(m)).toEqual([
      [0, "build", HAIKU, "medium", "fail"],
      [1, "build", SOL, "medium", "fail"],
      [3, "diagnose", OPUS, "high", "pass"], // rung 2 (standard/high) skipped: same failure again
      [4, "build", OPUS, "high", "pass"],
    ]);
  });

  it("reverts edits to frozen tests: a cheating attempt fails, an honest one that also touched them passes", async () => {
    const cheat = 'import test from "node:test";\n\ntest("greet gives its answer", () => {});\n';
    const hh = harness({
      features: [feature("greet")],
      agents: {
        engineer: (job, call) => {
          if (call.label !== "build-greet") return byDefault("engineer")(job, call);
          if (call.n === 1) return { edit: (cwd) => writeFile(cwd, featureTestPath("greet"), cheat), structured: buildOutput("made the test pass") };
          return {
            edit: (cwd) => {
              implementFeature(cwd, "greet");
              rmSync(join(cwd, featureTestPath("greet")));
            },
            structured: buildOutput("implemented"),
          };
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("done");
    const [cheated, honest] = m.features[0]?.attempts ?? [];
    expect(cheated).toMatchObject({ outcome: "fail", summary: expect.stringContaining(`edited frozen tests (reverted): ${featureTestPath("greet")}`) });
    expect(honest).toMatchObject({ outcome: "pass", summary: expect.stringContaining("edits to frozen tests were reverted") });
    expect(events(hh, m.id, "frozen.reverted").map((e) => e.data.files)).toEqual([[featureTestPath("greet")], [featureTestPath("greet")]]);
    expect(prompt(hh, "build-greet", 1)).toContain("It modified frozen test files, which were restored");
    expect(readFileSync(join(m.repoPath, featureTestPath("greet")), "utf8")).toContain('assert.equal(answer(), "greet")');
  });

  it("fails an attempt that weakens the tests even when verification passes", async () => {
    const extra = "tests/extra.test.mjs";
    const hh = harness({
      features: [feature("greet")],
      agents: {
        engineer: (job, call) => {
          if (call.label !== "build-greet") return byDefault("engineer")(job, call);
          const skipping = call.n === 1;
          return {
            edit: (cwd) => {
              implementFeature(cwd, "greet");
              if (skipping) writeFile(cwd, extra, 'import test from "node:test";\n\ntest.skip("slow check", () => {});\n');
              else rmSync(join(cwd, extra));
            },
            structured: buildOutput(),
          };
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("done");
    const [weakened, clean] = m.features[0]?.attempts ?? [];
    expect(weakened).toMatchObject({ outcome: "fail", summary: expect.stringMatching(/^weakened the tests: tests\/extra\.test\.mjs: test-skip/) });
    expect(weakened?.signature).toBeUndefined();
    expect(clean?.outcome).toBe("pass");
    expect(prompt(hh, "build-greet", 1)).toContain("These changes were rejected as weakening the tests");
  });

  it("blocks a feature when the ladder runs out and skips the features that depend on it", async () => {
    const hh = harness({
      features: [feature("alpha"), feature("beta", ["alpha"]), feature("gamma")],
      configure: (c) => (c.ladders.standard = [{ action: "build", tier: "standard", effort: "medium", family: "same" }, { action: "diagnose" }]),
      agents: { engineer: failingBuilds(Infinity, "alpha") },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("partial");
    const [alpha, beta, gamma] = m.features;
    expect(alpha).toMatchObject({
      status: "blocked",
      blockedReason: "tried every escalation step, but its checks still failed",
      branch: `mc/${m.id}--alpha`,
    });
    expect(alpha?.worktree).toBeUndefined();
    expect(existsSync(join(hh.store.worktreesDir(m.id), "alpha"))).toBe(false);
    expect(await hh.git.branchExists(m.repoPath, `mc/${m.id}--alpha`)).toBe(true); // the work so far is kept
    expect(beta).toMatchObject({ status: "skipped", blockedReason: 'waiting on "Feature alpha", which was blocked' });
    expect(gamma?.status).toBe("done");
    expect(hh.jobs.some((j) => labelOf(j).endsWith("-beta"))).toBe(false);

    // Partly done: main still gets the finished work, the integration worktree stays, the report explains.
    expect(existsSync(join(m.repoPath, "src/gamma.mjs"))).toBe(true);
    expect(m.integrationWorktree).toBeDefined();
    const report = readReport(hh, m.id);
    expect(report).toContain("Stuck: tried every escalation step, but its checks still failed (tried 2 times)");
    expect(report).toContain('Skipped: waiting on "Feature alpha", which was blocked');
    expect(hh.notifications).toEqual([expect.objectContaining({ title: "Fixture app: partly done (1/3 features)", opts: { priority: "high" } })]);
  });

  it("blocks a feature the diagnosis says needs its owner, and asks for that decision", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: {
        engineer: failingBuilds(Infinity),
        architect: (job, call) =>
          call.label === "diagnose-greet" ? { structured: diagnosis("block", "", "It needs a paid weather API key.") } : byDefault("architect")(job, call),
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("partial");
    expect(m.features[0]).toMatchObject({ status: "blocked", blockedReason: "It needs a paid weather API key." });
    expect(m.decisionsNeeded).toEqual(['"Feature greet": It needs a paid weather API key.']);
    expect(hh.jobsLabeled("gate-c")).toHaveLength(0); // nothing was done, so there is nothing to review
  });

  it("diagnoses a disputed test at once and lets the test author rewrite it", async () => {
    let keptCode: boolean | undefined;
    const hh = harness({
      features: [feature("greet")],
      agents: {
        test_author: (job, call) =>
          call.n === 1
            ? { edit: (cwd) => writeFeatureTest(cwd, "greet", "GREET"), structured: { testFiles: [featureTestPath("greet")], notes: "" } }
            : byDefault("test_author")(job, call),
        engineer: (job, call) => {
          if (call.label !== "build-greet") return byDefault("engineer")(job, call);
          if (call.n === 2) keptCode = existsSync(join(job.cwd, "src/greet.mjs"));
          const dispute = call.n === 1 ? { file: featureTestPath("greet"), reason: "The criteria say the answer is lowercase." } : null;
          return { edit: (cwd) => implementFeature(cwd, "greet"), structured: buildOutput("implemented", dispute) };
        },
        architect: (job, call) =>
          call.label === "diagnose-greet"
            ? { structured: diagnosis("amend_tests", "Keep the implementation.", "The test expects GREET; the criteria say greet.") }
            : byDefault("architect")(job, call),
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("done");
    expect(attempts(m)).toEqual([
      [0, "build", SOL, "medium", "fail"],
      [2, "diagnose", OPUS, "high", "pass"], // the next diagnose rung, run at once
      [3, "build", OPUS, "high", "pass"],
    ]);
    expect(prompt(hh, "diagnose-greet")).toContain("The engineer disputes a test");
    expect(prompt(hh, "diagnose-greet")).toContain("The criteria say the answer is lowercase.");
    expect(prompt(hh, "test-greet", 1)).toContain("The test expects GREET; the criteria say greet.");
    expect(keptCode).toBe(true); // amending the tests keeps the attempt's code
    const frozen = events(hh, m.id, "tests.frozen");
    expect(frozen).toHaveLength(2);
    expect(frozen[1]?.data.commit).not.toBe(frozen[0]?.data.commit);
    expect(m.features[0]?.testsCommit).toBe(frozen[1]?.data.commit);
    expect(events(hh, m.id, "verify").filter((e) => e.data.label === "greet-red")).toHaveLength(1); // rewritten tests may pass already
    expect(readFileSync(join(m.repoPath, featureTestPath("greet")), "utf8")).toContain('assert.equal(answer(), "greet")');
  });

  it.each([true, false])(
    "still rejects a failed attempt's test weakening after the diagnosis amends the tests (rewrite usable: %s)",
    async (usable) => {
      const skipped = 'import test from "node:test";\n\ntest.skip("the app has a name", () => {});\n';
      const hh = harness({
        features: [feature("greet")],
        agents: {
          test_author: (job, call) => (call.n === 1 || usable ? byDefault("test_author")(job, call) : { structured: { testFiles: [], notes: "" } }),
          engineer: (job, call) => {
            if (call.label !== "build-greet") return byDefault("engineer")(job, call);
            if (call.n === 1) {
              const dispute = { file: featureTestPath("greet"), reason: "The test is wrong." };
              return {
                edit: (cwd) => {
                  implementFeature(cwd, "greet", "wrong");
                  writeFile(cwd, "tests/smoke.test.mjs", skipped);
                },
                structured: buildOutput("tried", dispute),
              };
            }
            if (call.n === 2) return byDefault("engineer")(job, call); // right code, but the skipped smoke test stays
            return {
              edit: (cwd) => {
                implementFeature(cwd, "greet");
                writeScaffold(cwd);
              },
              structured: buildOutput("restored the smoke test"),
            };
          },
          architect: (job, call) =>
            call.label === "diagnose-greet" ? { structured: diagnosis("amend_tests", "", "The test is wrong.") } : byDefault("architect")(job, call),
        },
      });
      const m = await hh.run(hh.createMission("greenfield").id);

      expect(m.status).toBe("done");
      expect(attempts(m)).toEqual([
        [0, "build", SOL, "medium", "fail"],
        [2, "diagnose", OPUS, "high", "pass"],
        [3, "build", OPUS, "high", "fail"],
        [4, "build", ASTRA, "high", "pass"],
      ]);
      expect(m.features[0]?.attempts[2]?.summary).toMatch(/^weakened the tests: tests\/smoke\.test\.mjs: test-skip/);
      expect(readFileSync(join(m.repoPath, "tests/smoke.test.mjs"), "utf8")).not.toContain("skip");
      expect(events(hh, m.id, "tests.frozen")).toHaveLength(usable ? 2 : 1);
      const testsCommit = m.features[0]?.testsCommit ?? "";
      // The tests commit holds tests only: the attempt's code sits on top of it, where the scan sees it.
      expect(() => execFileSync("git", ["-C", m.repoPath, "cat-file", "-e", `${testsCommit}:src/greet.mjs`], { stdio: "ignore" })).toThrow();
      if (!usable) expect(m.notes).toContain('The rewritten tests for "Feature greet" could not be used, so its earlier tests stayed in place.');
    },
  );

  it("diagnoses a disputed test right after the attempt when no diagnose rung is ahead", async () => {
    const hh = harness({
      features: [feature("greet")],
      configure: (c) =>
        (c.ladders.standard = [
          { action: "build", tier: "standard", effort: "medium", family: "same" },
          { action: "build", tier: "frontier", effort: "high", family: "other" },
        ]),
      agents: {
        engineer: (job, call) =>
          call.label === "build-greet" && call.n === 1
            ? {
                edit: (cwd) => implementFeature(cwd, "greet", "wrong"),
                structured: buildOutput("tried", { file: featureTestPath("greet"), reason: "The test looks wrong to me." }),
              }
            : byDefault("engineer")(job, call),
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("done");
    expect(attempts(m)).toEqual([
      [0, "build", SOL, "medium", "fail"],
      [1, "diagnose", OPUS, "high", "pass"],
      [1, "build", OPUS, "high", "pass"],
    ]);
    expect(prompt(hh, "diagnose-greet")).toContain("The test looks wrong to me.");
    expect(prompt(hh, "build-greet", 1)).toContain("Return the feature id from answer().");
  });
});

// ───────────────────────────── Tests first, review, gate C ─────────────────────────────

describe("Dispatcher: tests, review and gate C", () => {
  it("asks again for tests that pass without the feature, and undoes test-author edits outside the tests", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: {
        test_author: (job, call) => {
          if (call.n > 1) return byDefault("test_author")(job, call);
          return {
            edit: (cwd) => {
              writeFile(cwd, featureTestPath("greet"), VACUOUS_TEST);
              writeFile(cwd, "app.mjs", "hacked\n");
            },
            structured: { testFiles: [featureTestPath("greet"), "app.mjs"], notes: "" },
          };
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("done");
    expect(hh.jobsLabeled("test-greet")).toHaveLength(2);
    expect(prompt(hh, "test-greet", 1)).toContain("Your previous tests passed without the feature");
    expect(events(hh, m.id, "verify").filter((e) => e.data.label === "greet-red").map((e) => e.data.ok)).toEqual([true, false]);
    expect(m.notes).toContain('The test author for "Feature greet" also changed files outside the test folders (app.mjs); those changes were undone.');
    expect(readFileSync(join(m.repoPath, "app.mjs"), "utf8")).toBe('export const name = "fixture app";\n');
    expect(m.features[0]?.frozenTests.map((t) => t.path)).toEqual([featureTestPath("greet")]);
  });

  it("goes on without frozen tests when the test author writes none", async () => {
    const hh = harness({ features: [feature("greet")], agents: { test_author: () => ({ structured: { testFiles: [], notes: "" } }) } });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("done");
    expect(hh.jobsLabeled("test-greet")).toHaveLength(2);
    expect(m.features[0]?.frozenTests).toEqual([]);
    expect(m.notes).toContain('No acceptance tests were written for "Feature greet", so only the full verification checked it.');
  });

  it("gives an empty answer and tests that already pass one retry each", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: {
        test_author: (job, call) => {
          if (call.n === 1) return { structured: { testFiles: [], notes: "" } };
          if (call.n === 2) return { edit: (cwd) => writeFile(cwd, featureTestPath("greet"), VACUOUS_TEST), structured: { testFiles: [featureTestPath("greet")], notes: "" } };
          return byDefault("test_author")(job, call);
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("done");
    expect(hh.jobsLabeled("test-greet")).toHaveLength(3);
    expect(prompt(hh, "test-greet", 2)).toContain("Your previous tests passed without the feature");
    expect(events(hh, m.id, "verify").filter((e) => e.data.label === "greet-red").map((e) => e.data.ok)).toEqual([true, false]);
    expect(m.features[0]?.frozenTests.map((t) => t.path)).toEqual([featureTestPath("greet")]);
  });

  it("drops the earlier rounds' test files when the last round lists none", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: {
        test_author: (_job, call) =>
          call.n === 1
            ? { edit: (cwd) => writeFile(cwd, featureTestPath("greet"), VACUOUS_TEST), structured: { testFiles: [featureTestPath("greet")], notes: "" } }
            : { structured: { testFiles: [], notes: "" } },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("done");
    expect(hh.jobsLabeled("test-greet")).toHaveLength(3); // the first answer, the retry for passing tests, the retry for an empty answer
    expect(m.features[0]?.frozenTests).toEqual([]);
    expect(existsSync(join(m.repoPath, featureTestPath("greet")))).toBe(false);
    expect(m.notes).toContain('No acceptance tests were written for "Feature greet", so only the full verification checked it.');
  });

  it("lets the engineer fix review findings: a green fix is kept, a red one is rolled back", async () => {
    const hh = harness({
      agents: {
        reviewer: (job, call) => {
          if (call.label === "review-greet" && call.n === 1) {
            return { structured: review([finding("major", "answer() lacks a doc comment", "src/greet.mjs"), finding("minor", "name could be clearer")]) };
          }
          if (call.label === "review-farewell") return { structured: review([finding("blocker", "farewell must be polite", "src/farewell.mjs")]) };
          return byDefault("reviewer")(job, call);
        },
        engineer: (job, call) => {
          if (call.label === "fix-greet") return { edit: (cwd) => writeFile(cwd, "src/greet.mjs", DOCUMENTED_GREET), structured: buildOutput("documented") };
          if (call.label === "fix-farewell") return { edit: (cwd) => implementFeature(cwd, "farewell", "bye"), structured: buildOutput("polite now") };
          return byDefault("engineer")(job, call);
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("done");
    const [greet, farewell] = m.features;
    expect(greet).toMatchObject({ reviewRounds: 1, openFindings: [finding("minor", "name could be clearer")] });
    expect(greet?.attempts.map((a) => [a.action, a.model, a.effort, a.outcome])).toEqual([
      ["build", SOL, "medium", "pass"],
      ["fix", SOL, "medium", "pass"], // same family, tier and effort as the passing build
    ]);
    expect(hh.jobsLabeled("review-greet")).toHaveLength(2);
    expect(prompt(hh, "fix-greet")).toContain("## Review findings to fix");
    expect(prompt(hh, "fix-greet")).toContain("answer() lacks a doc comment");
    expect(readFileSync(join(m.repoPath, "src/greet.mjs"), "utf8")).toBe(DOCUMENTED_GREET);

    expect(farewell).toMatchObject({ reviewRounds: 0, openFindings: [finding("blocker", "farewell must be polite", "src/farewell.mjs")] });
    expect(farewell?.attempts.map((a) => a.outcome)).toEqual(["pass", "fail"]);
    expect(hh.jobsLabeled("review-farewell")).toHaveLength(1);
    expect(readFileSync(join(m.repoPath, "src/farewell.mjs"), "utf8")).toContain('"farewell"'); // the red fix was rolled back
    expect(readReport(hh, m.id)).toContain("farewell must be polite");
  });

  it("merges with the findings open once the review rounds are used up, even after a green fix", async () => {
    const major = finding("major", "answer() lacks a doc comment", "src/greet.mjs");
    const hh = harness({
      features: [feature("greet")],
      configure: (c) => (c.limits.maxReviewRounds = 1),
      agents: {
        reviewer: (job, call) => (call.label === "review-greet" ? { structured: review([major]) } : byDefault("reviewer")(job, call)),
        engineer: (job, call) =>
          call.label === "fix-greet" ? { edit: (cwd) => writeFile(cwd, "src/greet.mjs", DOCUMENTED_GREET), structured: buildOutput("documented") } : byDefault("engineer")(job, call),
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("done");
    expect(m.features[0]).toMatchObject({ status: "done", reviewRounds: 1, openFindings: [major] });
    expect(hh.jobsLabeled("review-greet")).toHaveLength(2);
    expect(hh.jobsLabeled("fix-greet")).toHaveLength(1);
    expect(readFileSync(join(m.repoPath, "src/greet.mjs"), "utf8")).toBe(DOCUMENTED_GREET);
  });

  it("blocks a feature whose branch no longer merges cleanly", async () => {
    const motto = (word: string) => `export const name = "fixture app";\nexport const motto = "${word}";\n`;
    const hh = harness({
      features: [feature("greet")],
      agents: {
        engineer: (job, call) =>
          call.label === "build-greet"
            ? {
                edit: (cwd) => {
                  implementFeature(cwd, "greet");
                  writeFile(cwd, "app.mjs", motto("hi"));
                },
                structured: buildOutput(),
              }
            : byDefault("engineer")(job, call),
        reviewer: async (job, call) => {
          if (call.label === "review-greet") {
            const integration = join(dirname(job.cwd), "_integration"); // someone changed the mission branch meanwhile
            writeFile(integration, "app.mjs", motto("hello"));
            await h?.git.commitAll(integration, "a change made meanwhile");
          }
          return byDefault("reviewer")(job, call);
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("partial");
    expect(m.features[0]).toMatchObject({ status: "blocked", blockedReason: "its changes conflicted with work merged earlier (merge conflict)", worktree: undefined });
    expect(await hh.git.branchExists(m.repoPath, `mc/${m.id}--greet`)).toBe(true);
    expect(readFileSync(join(m.repoPath, "app.mjs"), "utf8")).toBe(motto("hello"));
    expect(await hh.git.isClean(join(hh.store.worktreesDir(m.id), "_integration"))).toBe(true); // the merge was aborted
  });

  it("turns blocking gate C findings into one more feature, then reviews again", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: {
        reviewer: (job, call) =>
          call.label === "gate-c" && call.n === 1
            ? { structured: review([finding("blocker", "greet ignores the app name", "src/greet.mjs"), finding("minor", "tidy the imports")]) }
            : byDefault("reviewer")(job, call),
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m).toMatchObject({ status: "done", gateCRounds: 1 });
    expect(m.features.map((f) => [f.id, f.status])).toEqual([
      ["greet", "done"],
      ["gate-c-fix-1", "done"],
    ]);
    expect(m.features[1]?.acceptance).toEqual(["greet ignores the app name (src/greet.mjs)"]);
    expect(m.notes).toContain("Final review (minor): tidy the imports");
    expect(hh.jobsLabeled("gate-c")).toHaveLength(2);
    expect(hh.jobsLabeled("build-gate-c-fix-1")).toHaveLength(1);
    expect(events(hh, m.id, "stage").map((e) => e.data.to)).toEqual(["gate_a", "init", "features", "gate_c", "features", "gate_c", "finalize", "complete"]);
  });

  it("adds a fix feature when the final full verification is red, even without findings", async () => {
    const sentinel = "node_modules/.gate-red"; // ignored, so only the integration worktree has it
    const verify = { ...FIXTURE_VERIFY, full: `test ! -e ${sentinel} && ${FIXTURE_VERIFY.full}` };
    const hh = harness({
      features: [feature("greet")],
      agents: {
        engineer: (job, call) => {
          const integration = join(dirname(job.cwd), "_integration");
          if (call.label === "init") return { edit: writeScaffold, structured: { summary: "scaffolded", verify, notes: [] } };
          if (call.label !== "build-gate-c-fix-1") return byDefault("engineer")(job, call);
          return {
            edit: (cwd) => {
              implementFeature(cwd, "gate-c-fix-1");
              rmSync(join(integration, sentinel), { force: true });
            },
            structured: buildOutput("fixed the full verification"),
          };
        },
        reviewer: (job, call) => {
          if (call.label === "review-greet") writeFile(join(dirname(job.cwd), "_integration"), sentinel, "");
          return byDefault("reviewer")(job, call);
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m).toMatchObject({ status: "done", gateCRounds: 1 });
    expect(m.features.map((f) => [f.id, f.status, f.acceptance])).toEqual([
      ["greet", "done", feature("greet").acceptance],
      ["gate-c-fix-1", "done", ["The full verification passes."]],
    ]);
    expect(events(hh, m.id, "verify").filter((e) => e.data.label === "gate-c").map((e) => e.data.ok)).toEqual([false, true]);
    expect(hh.jobsLabeled("gate-c")).toHaveLength(2);
  });

  it("records findings as notes once the gate C rounds are used up", async () => {
    const hh = harness({
      features: [feature("greet")],
      configure: (c) => (c.limits.maxGateCRounds = 0),
      agents: {
        reviewer: (job, call) =>
          call.label === "gate-c" ? { structured: review([finding("major", "no input validation", "app.mjs")]) } : byDefault("reviewer")(job, call),
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("done");
    expect(m.features).toHaveLength(1);
    expect(m.notes).toContain("Final review (major): no input validation (app.mjs)");
  });

  it("blocks only the feature whose step throws, and carries on with the others", async () => {
    const hh = harness({
      features: [feature("alpha"), feature("gamma")],
      agents: {
        test_author: (job, call) =>
          call.feature === "alpha"
            ? {
                edit: () => {
                  throw new Error("disk on fire");
                },
              }
            : byDefault("test_author")(job, call),
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("partial");
    expect(m.features.map((f) => [f.id, f.status, f.blockedReason])).toEqual([
      ["alpha", "blocked", "internal error: disk on fire"],
      ["gamma", "done", undefined],
    ]);
    expect(events(hh, m.id, "error")).toEqual([expect.objectContaining({ data: { feature: "alpha", message: "disk on fire" } })]);
  });
});

// ───────────────────────────── Stop, limits, budget ─────────────────────────────

describe("Dispatcher: stopping, limits and budget", () => {
  it("stops when STOP appears mid-feature and resumes where it left off", async () => {
    const hh = harness({
      agents: {
        engineer: (job, call) => {
          if (call.label === "build-greet") h?.store.requestStop();
          return byDefault("engineer")(job, call);
        },
      },
    });
    const id = hh.createMission("greenfield").id;
    const stopped = await hh.run(id);

    expect(stopped).toMatchObject({ status: "stopped", stage: "features" });
    expect(stopped.features.map((f) => f.status)).toEqual(["reviewing", "pending"]);
    expect(hh.load(id)).toEqual(stopped);
    expect(events(hh, id, "mission.stopped")).toHaveLength(1);
    expect(readReport(hh, id)).toContain("Fixture app"); // an interim report for the morning
    expect(hh.notifications).toEqual([]);

    // The unit worktree vanished meanwhile: resuming re-creates it from the unit branch.
    rmSync(stopped.features[0]?.worktree ?? "", { recursive: true, force: true });
    hh.store.clearStop();
    const m = await hh.run(id);

    expect(m.status).toBe("done");
    expect(hh.jobsLabeled("test-greet")).toHaveLength(1);
    expect(hh.jobsLabeled("build-greet")).toHaveLength(1);
    expect(hh.jobsLabeled("review-greet")).toHaveLength(1);
    expect(events(hh, id, "mission.resume")).toHaveLength(1);
  });

  it("stops when a stop aborts an agent run mid-way, and reruns the same rung on resume", async () => {
    const stop = new AbortController();
    const hh = harness({
      features: [feature("greet")],
      agents: {
        engineer: (job, call) => {
          if (call.label !== "build-greet" || call.n > 1) return byDefault("engineer")(job, call);
          stop.abort(); // what `mc stop` does to a running agent
          return { edit: (cwd) => writeFile(cwd, "src/greet.mjs", "// half done\n"), outcome: "aborted" };
        },
      },
    });
    const id = hh.createMission("greenfield").id;
    const stopped = await hh.run(id, { signal: stop.signal });

    expect(stopped).toMatchObject({ status: "stopped", stage: "features", agentRuns: hh.jobs.length - 1 }); // the aborted run is not counted
    expect(stopped.features[0]).toMatchObject({ status: "building", rung: 0, attempts: [] });
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(attempts(m)).toEqual([[0, "build", SOL, "medium", "pass"]]);
    expect(hh.jobsLabeled("build-greet")).toHaveLength(2);
  });

  it("stops at the deadline", async () => {
    const hh = harness({ features: [feature("greet")] });
    const id = hh.createMission("greenfield").id;
    const m = await hh.run(id, { deadline: Date.now() - 1 });
    expect(m).toMatchObject({ status: "stopped", stage: "spec" });
    expect(hh.jobs).toHaveLength(0);
  });

  it("stops when the next free model only comes after the deadline, and resumes later", async () => {
    const clock = new FakeClock(Date.now());
    const start = clock.now();
    const hh = harness({ clock, features: [feature("greet")], configure: (c) => (c.failover.enabled = false) });
    hh.agents.reviewer = (job, call) =>
      job.provider === "codex" && call.n === 1 ? { outcome: "limited", limit: { kind: "session", resetsAt: start + 10 * MIN } } : byDefault("reviewer")(job, call);
    const id = hh.createMission("greenfield").id;

    const stopped = await hh.run(id, { deadline: start + 5 * MIN });
    expect(stopped).toMatchObject({ status: "stopped", stage: "gate_a" });
    expect(events(hh, id, "mission.stopped")).toEqual([
      expect.objectContaining({ data: { stage: "gate_a", reason: expect.stringContaining("no provider is free before the deadline") } }),
    ]);
    expect(events(hh, id, "limit.wait")).toEqual([]);

    await clock.advance(11 * MIN);
    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(hh.jobsLabeled("gate-a").map((j) => j.model)).toEqual([ASTRA, ASTRA]);
  });

  it("installs a unit's dependencies again on resume when a stop interrupted the install", async () => {
    const hh = harness({ features: [feature("greet")] });
    const tried = join(hh.root, "greet-install-tried");
    const stopFile = join(hh.home, "STOP");
    const installed = "test -e node_modules/.installed";
    const verify = {
      // The first install in the greet worktree is cut short by a stop.
      install: `if [ "$(basename "$PWD")" = greet ] && [ ! -e '${tried}' ]; then touch '${tried}' '${stopFile}'; exit 1; fi; mkdir -p node_modules && touch node_modules/.installed`,
      full: `${installed} && ${FIXTURE_VERIFY.full}`,
      tests: `${installed} && ${FIXTURE_VERIFY.tests}`,
      testGlobs: ["tests/**"],
    };
    hh.agents.engineer = (job, call) =>
      call.label === "init" ? { edit: writeScaffold, structured: { summary: "scaffolded", verify, notes: [] } } : byDefault("engineer")(job, call);
    const id = hh.createMission("greenfield").id;

    const stopped = await hh.run(id);
    expect(stopped).toMatchObject({ status: "stopped", stage: "features" });
    expect(stopped.features[0]?.status).toBe("pending");
    hh.store.clearStop();
    const m = await hh.run(id);

    expect(m.status).toBe("done");
    expect(events(hh, id, "verify").filter((e) => e.data.label === "install-greet").map((e) => e.data.ok)).toEqual([false, true]);
    expect(attempts(m).map((a) => a[4])).toEqual(["pass"]);
  });

  it("retries a failed unit install once, then goes on with a note", async () => {
    const hh = harness({ features: [feature("greet")] });
    const verify = { ...FIXTURE_VERIFY, install: `[ "$(basename "$PWD")" != greet ]` };
    hh.agents.engineer = (job, call) =>
      call.label === "init" ? { edit: writeScaffold, structured: { summary: "scaffolded", verify, notes: [] } } : byDefault("engineer")(job, call);
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m.status).toBe("done");
    expect(events(hh, m.id, "verify").filter((e) => e.data.label === "install-greet").map((e) => e.data.ok)).toEqual([false, false]);
    expect(m.notes).toContain('Installing the dependencies of "Feature greet" failed, so its checks may fail for that reason.');
  });

  it("fails over to the other family while a provider is limited", async () => {
    const resetsAt = Date.now() + 10 * MIN;
    const hh = harness({ features: [feature("greet")], agents: codexLimitedUntil(resetsAt) });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("done");
    expect(hh.codex.calls.map((j) => labelOf(j))).toEqual(["gate-a"]); // limited once, then skipped while limited
    expect(runs(hh.claude.calls).filter(([label]) => label !== "report-prose" && !label.startsWith("context"))).toEqual([
      ["spec", OPUS, "high"],
      ["gate-a", OPUS, "high"],
      ["init", SONNET, "medium"],
      ["test-greet", SONNET, "high"],
      ["build-greet", SONNET, "medium"],
      ["review-greet", OPUS, "high"],
      ["gate-c", OPUS, "high"],
    ]);
    expect(m.features[0]?.builtBy).toBe("claude");
    expect(hh.quota.state("codex")).toMatchObject({ status: "limited", kind: "session", until: resetsAt });
    expect(hh.store.readUsage().filter((u) => u.outcome === "limited").map((u) => u.provider)).toEqual(["codex"]);
  });

  it("waits for the limit to reset when failover is off, marking the mission waiting", async () => {
    const clock = new FakeClock(Date.now());
    const start = clock.now();
    const hh = harness({ clock, features: [feature("greet")], configure: (c) => (c.failover.enabled = false) });
    hh.agents.reviewer = (job, call) =>
      job.provider === "codex" && call.n === 1 ? { outcome: "limited", limit: { kind: "session", resetsAt: start + 10 * MIN } } : byDefault("reviewer")(job, call);
    const id = hh.createMission("greenfield").id;

    const running = hh.run(id);
    await vi.waitFor(() => expect(hh.load(id).status).toBe("waiting"), { timeout: 10_000 });
    expect(events(hh, id, "limit.wait")).toEqual([
      expect.objectContaining({ data: { until: new Date(start + 10 * MIN + WAIT_MARGIN_MS).toISOString(), reason: expect.stringContaining(ASTRA) } }),
    ]);
    await clock.advance(11 * MIN);
    const m = await running;

    expect(m.status).toBe("done");
    expect(hh.jobsLabeled("gate-a").map((j) => j.model)).toEqual([ASTRA, ASTRA]);
    expect(hh.claude.calls.some((j) => labelOf(j) === "gate-a")).toBe(false);
  });

  it("fails the mission and asks for a login when every provider needs one", async () => {
    const hh = harness({ configure: (c) => (c.failover.enabled = false), agents: { architect: () => ({ outcome: "auth", error: "Please run /login" }) } });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m).toMatchObject({ status: "failed", stage: "spec", agentRuns: 0 });
    expect(m.decisionsNeeded).toEqual(["Log in again: claude needs a new login. Then run the mission again."]);
    expect(hh.notifications).toEqual([expect.objectContaining({ title: "Fixture app: failed", opts: { priority: "high", tags: ["warning"] } })]);
    expect(existsSync(hh.store.reportPath(m.id))).toBe(true);
  });

  it("stops at the agent-run cap and finalizes what it has", async () => {
    const hh = harness({ configure: (c) => (c.limits.maxAgentRunsPerMission = 3) });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(m).toMatchObject({ status: "partial", stage: "complete", agentRuns: 3 });
    expect(hh.jobs.map(labelOf)).toEqual(["spec", "gate-a", "init"]); // the report prose scout is skipped too
    expect(m.notes).toContain("Stopped early: this mission used its safety cap of 3 agent runs.");
    expect(hh.notifications).toEqual([expect.objectContaining({ title: "Fixture app: partly done (0/2 features)" })]);

    // Nothing resumes a complete mission: the unfinished unit gives up its worktree and keeps its branch.
    const [greet, farewell] = m.features;
    expect(greet).toMatchObject({ status: "blocked", blockedReason: "the mission reached its safety cap of 3 agent runs before this feature was finished" });
    expect(greet?.worktree).toBeUndefined();
    expect(farewell?.status).toBe("pending");
    expect(existsSync(join(hh.store.worktreesDir(m.id), "greet"))).toBe(false);
    expect(execFileSync("git", ["-C", m.repoPath, "worktree", "list"]).toString()).not.toContain("--greet");
    expect(await hh.git.branchExists(m.repoPath, `mc/${m.id}--greet`)).toBe(true);
  });

  it("ends partly done when the run cap stops it before the final review", async () => {
    const hh = harness({ features: [feature("greet")], configure: (c) => (c.limits.maxAgentRunsPerMission = 7) });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(hh.jobs.map(labelOf)).toEqual(["spec", "gate-a", "init", "test-greet", "context-greet", "build-greet", "review-greet"]);
    expect(m).toMatchObject({ status: "partial", stage: "complete", agentRuns: 7 });
    expect(m.features.map((f) => f.status)).toEqual(["done"]);
    expect(m.notes).toContain("Stopped early: this mission used its safety cap of 7 agent runs.");
  });
});

// ───────────────────────────── Feature missions ─────────────────────────────

describe("Dispatcher: feature missions", () => {
  it("onboards an existing repository and builds on a mission branch, leaving the base branch alone", async () => {
    const hh = harness({ features: [feature("greet")] });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo);
    const base = await hh.git.headSha(repo, "main");
    const m = await hh.run(hh.createMission("feature", { repoPath: repo, request: "Add a greeting." }).id);

    expect(m).toMatchObject({ status: "done", baseSha: base, baselineBroken: false, baselineFailures: [] });
    expect(m.verify).toEqual({ full: FIXTURE_VERIFY.full, tests: FIXTURE_VERIFY.tests, testGlobs: ["tests/**"] });
    expect(hh.jobs.map(labelOf)).toEqual(["onboard", "spec", "gate-a", "test-greet", "context-greet", "build-greet", "review-greet", "gate-c", "report-prose"]);
    const integration = join(hh.store.worktreesDir(m.id), "_integration");
    expect(hh.jobsLabeled("onboard")[0]).toMatchObject({ access: "read-only", cwd: integration });
    expect(prompt(hh, "onboard")).toContain("lib.mjs");
    expect(hh.jobsLabeled("spec")[0]).toMatchObject({ access: "read-only", cwd: integration });
    expect(hh.jobsLabeled("spec")[0]?.noTools).toBeUndefined(); // the architect may read the code
    expect(m.notes).toContain("Stack: Node ESM project tested with node --test.");

    expect(await hh.git.headSha(repo, "main")).toBe(base);
    expect(await hh.git.currentBranch(repo)).toBe("main");
    expect((await hh.git.log(repo, `main..${m.integrationBranch}`)).map((c) => c.subject)).toContain("feat(greet): Feature greet");
    expect(m.integrationWorktree).toBeUndefined(); // done: the user can check the branch out
  });

  it("records a broken baseline and judges features by their own tests", async () => {
    const hh = harness({ features: [feature("greet")] });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo, { broken: true });
    const m = await hh.run(hh.createMission("feature", { repoPath: repo }).id);

    expect(m.baselineBroken).toBe(true);
    expect(m.baselineFailures.length).toBeGreaterThan(0);
    expect(m.baselineFailures.length).toBeLessThanOrEqual(20);
    expect(m.notes).toContain("The project's own checks were already failing before this mission started, so features were judged by their new tests.");
    const labels = events(hh, m.id, "verify").map((e) => String(e.data.label));
    expect(labels).toContain("greet-tests-a1");
    expect(labels.some((l) => l.startsWith("greet-full"))).toBe(false);
    // The red final verification predates the mission: no fix feature, and the mission is done.
    expect(m.features.map((f) => f.id)).toEqual(["greet"]);
    expect(m.status).toBe("done");
  });

  it("asks how to run single test files when the project's own checks already fail", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: {
        architect: (job, call) =>
          call.label === "onboard" && call.n === 1
            ? { structured: { stackSummary: "Node", verify: { ...FIXTURE_VERIFY, tests: null }, notes: [] } }
            : byDefault("architect")(job, call),
      },
    });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo, { broken: true });
    const m = await hh.run(hh.createMission("feature", { repoPath: repo }).id);

    expect(m.status).toBe("done");
    expect(hh.jobsLabeled("onboard")).toHaveLength(2);
    expect(prompt(hh, "onboard", 1)).toContain("already fails on the unchanged code");
    expect(m.verify?.tests).toBe(FIXTURE_VERIFY.tests);
    expect(m.features[0]?.attempts.map((a) => a.outcome)).toEqual(["pass"]);
  });

  it("fails a mission whose checks already fail when single test files cannot be run", async () => {
    const hh = harness({
      agents: {
        architect: (job, call) =>
          call.label === "onboard" ? { structured: { stackSummary: "Node", verify: { ...FIXTURE_VERIFY, tests: null }, notes: [] } } : byDefault("architect")(job, call),
      },
    });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo, { broken: true });
    const m = await hh.run(hh.createMission("feature", { repoPath: repo }).id);
    expect(m).toMatchObject({ status: "failed", stage: "onboard" });
    expect(m.decisionsNeeded).toEqual([expect.stringContaining("I found no way to run single test files")]);
    expect(hh.jobs.map(labelOf)).toEqual(["onboard", "onboard"]);
  });

  it("blocks a feature nothing can check: no tests were written and the project's checks already fail", async () => {
    const hh = harness({ features: [feature("greet")], agents: { test_author: () => ({ structured: { testFiles: [], notes: "" } }) } });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo, { broken: true });
    const m = await hh.run(hh.createMission("feature", { repoPath: repo }).id);
    expect(m.status).toBe("partial");
    expect(m.features[0]).toMatchObject({
      status: "blocked",
      blockedReason: "no acceptance tests could be written for it, and the project's own checks were already failing, so nothing could check it",
    });
    expect(hh.jobsLabeled("build-greet")).toHaveLength(0);
    expect(m.notes.some((n) => n.startsWith("No acceptance tests were written"))).toBe(false);
  });

  it("pushes the mission branch to origin when git.push is on", async () => {
    const hh = harness({ features: [feature("greet")], configure: (c) => (c.git.push = true) });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo);
    const origin = join(hh.workspace, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
    const m = await hh.run(hh.createMission("feature", { repoPath: repo }).id);

    expect(m.status).toBe("done");
    const pushed = execFileSync("git", ["-C", origin, "for-each-ref", "--format=%(refname) %(objectname)"]).toString().trim();
    expect(pushed).toBe(`refs/heads/${m.integrationBranch} ${await hh.git.headSha(repo, m.integrationBranch)}`);
  });

  it("refuses a shallow clone, whose missing history an agent could lose", async () => {
    const hh = harness();
    const origin = join(hh.workspace, "origin");
    await createFixtureRepo(hh.git, origin);
    const clone = join(hh.workspace, "clone");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${origin}`, clone]);
    const m = await hh.run(hh.createMission("feature", { repoPath: clone }).id);
    expect(m).toMatchObject({ status: "failed", stage: "onboard" });
    expect(m.decisionsNeeded).toEqual([expect.stringContaining("git fetch --unshallow")]);
    expect(hh.jobs).toHaveLength(0);
  });

  it("fails a mission whose folder is not a git repository, without running any agent", async () => {
    const hh = harness();
    const dir = join(hh.workspace, "plain");
    mkdirSync(dir, { recursive: true });
    const m = await hh.run(hh.createMission("feature", { repoPath: dir }).id);
    expect(m).toMatchObject({ status: "failed", stage: "onboard" });
    expect(m.decisionsNeeded).toEqual([expect.stringMatching(/is not a git repository/)]);
    expect(hh.jobs).toHaveLength(0);
  });
});
