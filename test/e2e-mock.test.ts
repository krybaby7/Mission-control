// End-to-end missions through the public entry point `runNight` (what `mc run` calls): two scripted MockRunners
// impersonate the Claude Code and Codex CLIs, while git, the `node --test` verification, the mission store, the quota
// file, the run lock, the STOP file, reports, the night summary and notifications are all real. See test/e2e-world.ts.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MockBehavior } from "../src/runners/mock.js";
import type { AgentJob, Mission, Role } from "../src/types.js";
import { FakeClock } from "../src/util/clock.js";
import {
  acceptanceTest,
  APP_VERIFY,
  ASTRA,
  built,
  diagnosis,
  eveningOf,
  existingProject,
  type Handler,
  has,
  headings,
  HAIKU,
  HOUR,
  implement,
  labelOf,
  MIN,
  OPUS,
  PROSE,
  scaffold,
  sectionOf,
  SOL,
  SONNET,
  spec,
  testPath,
  vacuousTest,
  WAIT_MARGIN_MS,
  World,
  type WorldOptions,
  writeIn,
} from "./e2e-world.js";

const ROLES: Role[] = ["architect", "engineer", "test_author", "reviewer", "scout"];
const WAIT = { timeout: 20_000, interval: 20 };

let current: World | undefined;

function world(opts: WorldOptions = {}): World {
  current = new World(opts);
  return current;
}

afterEach(() => {
  current?.cleanup();
  current = undefined;
});

/** Puts `pre` in front of every role's agent: when it returns a behavior, that is what the run does. */
function intercept(w: World, pre: (job: AgentJob, call: Parameters<Handler>[1]) => MockBehavior | undefined): void {
  for (const role of ROLES) {
    const next = w.agents[role] ?? w.defaults[role];
    w.agents[role] = (job, call) => pre(job, call) ?? next(job, call);
  }
}

/** [label, provider, model, effort] of each job. */
function runsOf(jobs: AgentJob[]): [string, string, string, string][] {
  return jobs.map((j) => [labelOf(j), j.provider, j.model, j.effort]);
}

/** [rung, action, provider, model, effort, outcome] of each attempt at a feature. */
function attemptsOf(m: Mission, id: string): [number, string, string, string, string, string][] {
  const f = m.features.find((x) => x.id === id);
  return (f?.attempts ?? []).map((a) => [a.rung, a.action, a.provider, a.model, a.effort, a.outcome]);
}

function featureOf(m: Mission, id: string) {
  const f = m.features.find((x) => x.id === id);
  if (!f) throw new Error(`no feature ${id}`);
  return f;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

// ───────────────────────────── 1. Happy greenfield ─────────────────────────────

describe("e2e: a new app, start to finish", () => {
  it("builds it overnight: done, main fast-forwarded, a plain-language report, usage for both families, a night summary", async () => {
    const w = world();
    const queued = w.queueGreenfield();

    const night = await w.night();

    expect(night.missions.map((m) => [m.id, m.status, m.stage])).toEqual([[queued.id, "done", "complete"]]);
    const m = w.mission(queued.id);
    expect(m.features.map((f) => [f.id, f.status, f.attempts.map((a) => a.outcome)])).toEqual([
      ["greet", "done", ["pass"]],
      ["farewell", "done", ["pass"]],
    ]);
    expect(m.decisionsNeeded).toEqual([]);

    // The app folder: main holds all the work, is checked out and clean, and the app's own checks pass on it.
    const repo = m.repoPath;
    expect(repo).toBe(join(w.workspace, "fixture-app"));
    expect(await w.git.currentBranch(repo)).toBe("main");
    expect(await w.git.headSha(repo, "main")).toBe(await w.git.headSha(repo, m.integrationBranch));
    expect(await w.git.isClean(repo)).toBe(true);
    for (const path of ["app.mjs", "src/greet.mjs", "src/farewell.mjs", testPath("greet"), testPath("farewell")]) {
      expect(has(repo, path), path).toBe(true);
    }
    expect(w.appChecksPass(repo)).toBe(true);
    const subjects = (await w.git.log(repo, "main")).map((c) => c.subject);
    expect(subjects).toEqual(
      expect.arrayContaining(["chore: scaffold app", "test(greet): acceptance tests", "feat(greet): Feature greet", "feat(farewell): Feature farewell"]),
    );
    // No mission checkouts are left behind once the mission is done.
    const worktrees = w.gitOut(repo, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "));
    expect(worktrees).toEqual([`worktree ${repo}`]);
    expect(m.integrationWorktree).toBeUndefined();

    // The mixed profile: codex builds, claude writes the tests first and reviews codex's work.
    expect(w.jobsFor("engineer").map((j) => [labelOf(j), j.provider, j.model])).toEqual([
      ["init", "codex", SOL],
      ["build-greet", "codex", SOL],
      ["build-farewell", "codex", SOL],
    ]);
    expect(w.jobsFor("test_author").map((j) => [labelOf(j), j.provider])).toEqual([
      ["test-greet", "claude"],
      ["test-farewell", "claude"],
    ]);
    expect(runsOf(w.labeled("review-greet"))).toEqual([["review-greet", "claude", OPUS, "high"]]);
    // Tests came before code: each feature's tests commit precedes its first build commit.
    expect(subjects.indexOf("test(greet): acceptance tests")).toBeGreaterThan(subjects.indexOf("wip(greet): attempt 1"));

    // The usage ledger: one record per agent run, from both families.
    const usage = w.usage(m.id);
    expect(usage).toHaveLength(w.jobs.length);
    expect(usage).toHaveLength(m.agentRuns);
    expect([...new Set(usage.map((u) => u.provider))].sort()).toEqual(["claude", "codex"]);
    expect(usage.every((u) => u.outcome === "ok")).toBe(true);
    expect(usage.filter((u) => u.provider === "codex").map((u) => u.role)).toEqual(["reviewer", "engineer", "engineer", "engineer"]);

    // The morning report: plain language first, in the promised order, technical details last.
    const report = w.report(m.id);
    expect(report.split("\n")[0]).toBe("# Fixture app");
    expect(report).toContain("**Done** · 2 of 2 features done");
    expect(headings(report)).toEqual([
      "What you can do now",
      "How to try it",
      "Needs your decision",
      "Features",
      "Choices I made for you",
      "Review notes",
      "Usage",
      "Technical details",
    ]);
    expect(report).toContain(PROSE.narrative);
    expect(sectionOf(report, "What you can do now")).toContain("Ask any feature whether it works");
    expect(sectionOf(report, "How to try it")).toContain(`cd ${repo}`);
    expect(sectionOf(report, "Needs your decision")).toBe("Nothing. You don't need to do anything.");
    expect(sectionOf(report, "Features")).toContain("| ✅ | Feature greet | Built and checked |");
    expect(sectionOf(report, "Features")).toContain("| ✅ | Feature farewell | Built and checked |");
    expect(sectionOf(report, "Choices I made for you")).toContain("Every feature answers with a short sentence.");
    expect(sectionOf(report, "Usage")).toContain(`| ${SOL} | Codex | 3 |`);
    expect(sectionOf(report, "Usage")).toContain(`| ${OPUS} | Claude Code |`);
    const plainPart = report.slice(0, report.indexOf("## Technical details"));
    expect(plainPart).not.toContain(m.integrationBranch);
    expect(plainPart).not.toMatch(/\b[0-9a-f]{10,40}\b/); // no commit hashes before the technical details
    expect(sectionOf(report, "Technical details")).toContain(m.integrationBranch);

    // The night summary links the report relatively; latest.md is the last mission's report.
    expect(night.summaryPath).toBe(join(w.home, "reports", "night-2026-10-10.md"));
    const summary = read(night.summaryPath);
    expect(summary).toContain(`- **Fixture app**: Done, 2 of 2 features done. [Read the report](../missions/${m.id}/report.md)`);
    expect(summary).toContain("Every queued mission was worked on.");
    expect(existsSync(join(dirname(night.summaryPath), "..", "missions", m.id, "report.md"))).toBe(true);
    expect(read(join(w.home, "reports", "latest.md"))).toContain("**Done** · 2 of 2 features done");

    expect(w.notifications().map((n) => [n.title, n.priority])).toEqual([
      ["Fixture app: done (2/2 features)", "3"],
      ["Night finished", "3"],
    ]);
    expect(w.logs.filter((l) => l.level === "error")).toEqual([]);
    expect(w.events(m.id, "error")).toEqual([]);
    w.store().acquireLock()(); // the run released its lock
  });
});

// ───────────────────────────── 2. Escalation ladder ─────────────────────────────

describe("e2e: the escalation ladder", () => {
  /** An engineer whose first `wrong` builds of greet return the wrong text; later builds are correct. */
  function wrongThenRight(w: World, wrong: number, seen: { cleanStart: boolean[] }): void {
    w.agents.engineer = (job, call) => {
      if (call.label !== "build-greet") return w.defaults.engineer(job, call);
      if (call.n <= wrong) return { edit: (cwd) => implement(cwd, "greet", "greet is broken"), structured: built("tried my best") };
      return {
        edit: (cwd) => {
          seen.cleanStart.push(!has(cwd, "src/greet.mjs"));
          implement(cwd, "greet");
        },
        structured: built(),
      };
    };
  }

  it("standard ladder: two identical failures, a diagnosis, then the other family's frontier model passes", async () => {
    const w = world({ features: [spec("greet")] });
    const seen = { cleanStart: [] as boolean[] };
    wrongThenRight(w, 2, seen);
    const queued = w.queueGreenfield();

    await w.night();

    const m = w.mission(queued.id);
    expect(m.status).toBe("done");
    expect(attemptsOf(m, "greet")).toEqual([
      [0, "build", "codex", SOL, "medium", "fail"],
      [1, "build", "codex", SOL, "high", "fail"],
      [2, "diagnose", "claude", OPUS, "high", "pass"],
      [3, "build", "claude", OPUS, "high", "pass"],
    ]);
    const [first, second] = featureOf(m, "greet").attempts;
    expect(first?.signature).toMatch(/^[0-9a-f]{12}$/);
    expect(second?.signature).toBe(first?.signature);
    // Exactly these agent runs, on exactly these models.
    expect(runsOf(w.labeled("build-greet"))).toEqual([
      ["build-greet", "codex", SOL, "medium"],
      ["build-greet", "codex", SOL, "high"],
      ["build-greet", "claude", OPUS, "high"],
    ]);
    expect(runsOf(w.labeled("diagnose-greet"))).toEqual([["diagnose-greet", "claude", OPUS, "high"]]);
    expect(w.labeled("diagnose-greet")[0]?.access).toBe("read-only");
    // The diagnosis saw the failure; its hint reached the next engineer, who started from the frozen tests alone.
    expect(w.labeled("diagnose-greet")[0]?.prompt).toContain("greet is broken");
    expect(w.labeled("build-greet")[2]?.prompt).toContain('run() must return the text "greet works".');
    expect(seen.cleanStart).toEqual([true]);
    expect(featureOf(m, "greet").builtBy).toBe("claude");
    // Claude built it, so codex reviews it.
    expect(runsOf(w.labeled("review-greet"))).toEqual([["review-greet", "codex", ASTRA, "high"]]);
    expect(read(join(m.repoPath, "src/greet.mjs"))).toContain('"greet works"');
    expect(w.appChecksPass(m.repoPath)).toBe(true);
  });

  it("mechanical ladder: Haiku first, and a repeated failure jumps straight to the diagnosis", async () => {
    const w = world({ features: [spec("greet", [], "mechanical")] });
    const seen = { cleanStart: [] as boolean[] };
    wrongThenRight(w, 2, seen);
    const queued = w.queueGreenfield();

    await w.night();

    const m = w.mission(queued.id);
    expect(m.status).toBe("done");
    // Rung 2 (Sol at high effort) is skipped: the same failure twice goes to the diagnosis at once.
    expect(attemptsOf(m, "greet")).toEqual([
      [0, "build", "claude", HAIKU, "medium", "fail"],
      [1, "build", "codex", SOL, "medium", "fail"],
      [3, "diagnose", "claude", OPUS, "high", "pass"],
      [4, "build", "claude", OPUS, "high", "pass"],
    ]);
    expect(runsOf(w.labeled("build-greet"))).toEqual([
      ["build-greet", "claude", HAIKU, "medium"],
      ["build-greet", "codex", SOL, "medium"],
      ["build-greet", "claude", OPUS, "high"],
    ]);
    expect(seen.cleanStart).toEqual([true]);
  });

  it("a disputed test is diagnosed at once; the test author rewrites it and the next rung builds against the new test", async () => {
    const w = world({ features: [spec("greet")] });
    const tooStrict = acceptanceTest("greet").replace('assert.equal(run(), "greet works")', 'assert.equal(run(), "greet works!!")');
    w.agents.test_author = (_job, call) => ({
      edit: (cwd) => writeIn(cwd, testPath("greet"), call.n === 1 ? tooStrict : acceptanceTest("greet")),
      structured: { testFiles: [testPath("greet")], notes: "" },
    });
    const dispute = { file: testPath("greet"), reason: "The acceptance criteria say 'greet works', with no exclamation marks." };
    w.agents.engineer = (job, call) =>
      call.label === "build-greet" ? { edit: (cwd) => implement(cwd, "greet"), structured: call.n === 1 ? built("done", dispute) : built() } : w.defaults.engineer(job, call);
    const amendReason = "The test demands exclamation marks that the acceptance criteria never asked for.";
    w.agents.architect = (job, call) =>
      call.label === "diagnose-greet" ? { structured: diagnosis("amend_tests", "", amendReason) } : w.defaults.architect(job, call);
    const queued = w.queueGreenfield();

    await w.night();

    const m = w.mission(queued.id);
    expect(m.status).toBe("done");
    // The dispute skips rung 1 and uses the diagnose rung at once; the next build is the cross-family frontier rung.
    expect(attemptsOf(m, "greet")).toEqual([
      [0, "build", "codex", SOL, "medium", "fail"],
      [2, "diagnose", "claude", OPUS, "high", "pass"],
      [3, "build", "claude", OPUS, "high", "pass"],
    ]);
    expect(w.labeled("diagnose-greet")[0]?.prompt).toContain(dispute.reason);
    expect(w.labeled("test-greet")).toHaveLength(2);
    expect(w.labeled("test-greet")[1]?.prompt).toContain(amendReason);
    // The rewritten test is the frozen one, and it is what main holds.
    expect(read(join(m.repoPath, testPath("greet")))).toBe(acceptanceTest("greet"));
    expect(featureOf(m, "greet").frozenTests.map((t) => t.path)).toEqual([testPath("greet")]);
    expect(w.appChecksPass(m.repoPath)).toBe(true);
  });
});

// ───────────────────────────── 3. Frozen tests ─────────────────────────────

describe("e2e: frozen acceptance tests", () => {
  it("reverts an engineer's edits to frozen tests, so cheating never passes, and merges the test author's tests", async () => {
    const w = world({ features: [spec("greet"), spec("farewell")] });
    w.agents.engineer = (job, call) => {
      const id = call.feature;
      if (!id || !call.label.startsWith("build-")) return w.defaults.engineer(job, call);
      const firstTry = call.n === 1;
      if (firstTry && id === "greet") {
        // Cheat: make the test pass whatever the code does, and ship code that does not work.
        return { edit: (cwd) => (writeIn(cwd, testPath(id), vacuousTest(id)), implement(cwd, id, "not done yet")), structured: built("all tests pass") };
      }
      if (firstTry && id === "farewell") {
        // Cheat: delete the test, and ship code that does not work.
        return { edit: (cwd) => (rmSync(join(cwd, testPath(id))), implement(cwd, id, "not done yet")), structured: built("all tests pass") };
      }
      // Honest code that also "tidies" the frozen test: the edit is reverted, and the honest code passes on its own.
      return { edit: (cwd) => (writeIn(cwd, testPath(id), `// tidied\n${acceptanceTest(id)}`), implement(cwd, id)), structured: built() };
    };
    const queued = w.queueGreenfield();

    await w.night();

    const m = w.mission(queued.id);
    expect(m.status).toBe("done");
    for (const id of ["greet", "farewell"]) {
      const f = featureOf(m, id);
      expect(attemptsOf(m, id)).toEqual([
        [0, "build", "codex", SOL, "medium", "fail"],
        [1, "build", "codex", SOL, "high", "pass"],
      ]);
      expect(f.attempts[0]?.summary).toContain(`edited frozen tests (reverted): ${testPath(id)}`);
      expect(f.attempts[0]?.summary).toContain("verification failed");
      expect(f.attempts[1]?.summary).toContain(`edits to frozen tests were reverted: ${testPath(id)}`);
      // What was merged is the test author's test, byte for byte.
      expect(read(join(m.repoPath, testPath(id)))).toBe(w.authoredTests.get(testPath(id)));
      expect(read(join(m.repoPath, `src/${id}.mjs`))).toContain(`"${id} works"`);
    }
    expect(w.events(m.id, "frozen.reverted").map((e) => e.data.files)).toEqual([
      [testPath("greet")],
      [testPath("greet")],
      [testPath("farewell")],
      [testPath("farewell")],
    ]);
    expect((await w.git.log(m.repoPath, "main")).map((c) => c.subject)).toContain("revert frozen test edits");
    expect(w.appChecksPass(m.repoPath)).toBe(true);
  });
});

// ───────────────────────────── 3b. Agents that use git themselves ─────────────────────────────

describe("e2e: agents that run git themselves", () => {
  /** git in an agent's worktree, as an agent with a shell would run it. */
  function agentGit(cwd: string, args: string[]): void {
    execFileSync("git", ["-c", "user.name=Agent", "-c", "user.email=agent@localhost", ...args], { cwd, stdio: "ignore" });
  }

  /** The done features whose code or acceptance test is missing from main: work reported as finished but lost. */
  function lostOnMain(m: Mission): string[] {
    return m.features
      .filter((f) => f.status === "done")
      .filter((f) => !has(m.repoPath, `src/${f.id}.mjs`) || !has(m.repoPath, testPath(f.id)))
      .map((f) => f.id);
  }

  it("an engineer that commits its own work (even a frozen-test edit) is checked and merged like any other", async () => {
    const w = world({ features: [spec("greet")] });
    w.agents.engineer = (job, call) =>
      call.label === "build-greet"
        ? {
            edit: (cwd) => {
              writeIn(cwd, testPath("greet"), vacuousTest("greet"));
              implement(cwd, "greet");
              agentGit(cwd, ["add", "-A"]);
              agentGit(cwd, ["commit", "-qm", "feat: greet"]);
            },
            structured: built(),
          }
        : w.defaults.engineer(job, call);
    const queued = w.queueGreenfield();

    await w.night();

    const m = w.mission(queued.id);
    expect(m.status).toBe("done");
    expect(lostOnMain(m)).toEqual([]);
    expect(read(join(m.repoPath, testPath("greet")))).toBe(w.authoredTests.get(testPath("greet")));
    expect((await w.git.log(m.repoPath, "main")).map((c) => c.subject)).toEqual(expect.arrayContaining(["feat: greet", "revert frozen test edits"]));
    expect(w.appChecksPass(m.repoPath)).toBe(true);
  });

  it("an engineer that switches to a branch of its own: the verified work is what gets merged", async () => {
    const w = world({ features: [spec("greet")] });
    w.agents.engineer = (job, call) =>
      call.label === "build-greet"
        ? {
            edit: (cwd) => {
              agentGit(cwd, ["checkout", "-q", "-b", "feature/greet"]);
              implement(cwd, "greet");
              agentGit(cwd, ["add", "-A"]);
              agentGit(cwd, ["commit", "-qm", "Add greet"]);
            },
            structured: built(),
          }
        : w.defaults.engineer(job, call);
    const queued = w.queueGreenfield();

    await w.night();

    const m = w.mission(queued.id);
    expect(attemptsOf(m, "greet").map((a) => a[5])).toContain("pass"); // the work was verified…
    expect(featureOf(m, "greet").status).toBe("done");
    expect(lostOnMain(m)).toEqual([]); // …so a feature reported done must be on main
    expect(m.status).toBe("done");
    expect(w.appChecksPass(m.repoPath)).toBe(true);
  });

  it("a test author that switches to a branch of its own: the mission is not reported done without the feature", async () => {
    const w = world({ features: [spec("greet")] });
    const testAuthor = w.defaults.test_author;
    w.agents.test_author = async (job, call) => {
      const answer = await testAuthor(job, call);
      return { ...answer, edit: async (cwd, j) => (agentGit(cwd, ["checkout", "-q", "-b", "tests/greet"]), await answer.edit?.(cwd, j)) };
    };
    const queued = w.queueGreenfield();

    await w.night();

    const m = w.mission(queued.id);
    expect(m.features.map((f) => [f.id, f.status])).toEqual([["greet", "done"]]);
    expect(lostOnMain(m)).toEqual([]);
    expect(read(join(m.repoPath, testPath("greet")))).toBe(w.authoredTests.get(testPath("greet")));
  });

  it("an initializer that switches to a branch of its own: the scaffold and the features still reach main", async () => {
    const w = world({ features: [spec("greet")] });
    w.agents.engineer = (job, call) =>
      call.label === "init"
        ? { edit: (cwd) => (agentGit(cwd, ["checkout", "-q", "-b", "scaffold"]), scaffold(cwd)), structured: { summary: "scaffolded", verify: APP_VERIFY, notes: [] } }
        : w.defaults.engineer(job, call);
    const queued = w.queueGreenfield();

    await w.night();

    const m = w.mission(queued.id);
    expect(m.features.map((f) => [f.id, f.status])).toEqual([["greet", "done"]]);
    expect(has(m.repoPath, "app.mjs")).toBe(true);
    expect(lostOnMain(m)).toEqual([]);
    expect(m.status).toBe("done");
  });
});

// ───────────────────────────── 4. Usage limits ─────────────────────────────

describe("e2e: usage limits", () => {
  it("fails over to claude while codex is at its limit, and remembers the limit in quota.json", async () => {
    const w = world();
    const reset = w.clock.now() + 10 * MIN;
    intercept(w, (job) => (job.provider === "codex" ? { outcome: "limited", limit: { kind: "session", resetsAt: reset } } : undefined));
    const queued = w.queueGreenfield();

    await w.night();

    const m = w.mission(queued.id);
    expect(m.status).toBe("done");
    // Codex was tried once (the plan review), then every codex job ran on claude at the same tier.
    expect(runsOf(w.codex.calls)).toEqual([["gate-a", "codex", ASTRA, "high"]]);
    expect(runsOf(w.labeled("gate-a"))).toEqual([
      ["gate-a", "codex", ASTRA, "high"],
      ["gate-a", "claude", OPUS, "high"],
    ]);
    expect(w.jobsFor("engineer").map((j) => [labelOf(j), j.provider, j.model])).toEqual([
      ["init", "claude", SONNET],
      ["build-greet", "claude", SONNET],
      ["build-farewell", "claude", SONNET],
    ]);
    expect(m.features.map((f) => [f.id, f.builtBy])).toEqual([
      ["greet", "claude"],
      ["farewell", "claude"],
    ]);
    const quota = JSON.parse(read(join(w.home, "quota.json"))) as { limits: Record<string, { kind: string; until: number }> };
    expect(quota.limits.codex).toMatchObject({ kind: "session", until: reset });
    expect(quota.limits.claude).toBeUndefined();
    expect(w.usage(m.id).filter((u) => u.outcome === "limited").map((u) => [u.provider, u.model])).toEqual([["codex", ASTRA]]);
    expect(sectionOf(w.report(m.id), "Usage")).toContain("1 run paused by a usage limit");
  });

  it("with failover off, waits for codex's limit to reset (marked waiting), then carries on with codex", async () => {
    const clock = new FakeClock(eveningOf());
    const w = world({ clock, configure: (c) => (c.failover.enabled = false) });
    const reset = clock.now() + 10 * MIN;
    intercept(w, (job) => (job.provider === "codex" && clock.now() < reset ? { outcome: "limited", limit: { kind: "session", resetsAt: reset } } : undefined));
    const queued = w.queueGreenfield();

    const night = w.night();
    await vi.waitFor(() => expect(w.mission(queued.id).status).toBe("waiting"), WAIT);
    expect(clock.pendingSleeps()).toBe(1);
    expect(w.events(queued.id, "limit.wait").map((e) => e.data.until)).toEqual([new Date(reset + WAIT_MARGIN_MS).toISOString()]);
    expect(w.claude.calls.filter((j) => j.role === "reviewer")).toEqual([]); // no failover to claude
    await vi.waitFor(() => expect(w.notifications().map((n) => n.title)).toContain("Waiting for usage limits"), WAIT);

    await clock.advance(10 * MIN + WAIT_MARGIN_MS);
    const result = await night;

    expect(result.missions.map((m) => m.status)).toEqual(["done"]);
    const m = w.mission(queued.id);
    expect(runsOf(w.labeled("gate-a"))).toEqual([
      ["gate-a", "codex", ASTRA, "high"],
      ["gate-a", "codex", ASTRA, "high"],
    ]);
    expect(w.jobsFor("engineer").every((j) => j.provider === "codex" && j.model === SOL)).toBe(true);
    expect(m.features.every((f) => f.status === "done" && f.builtBy === "codex")).toBe(true);
    expect(w.usage(m.id).filter((u) => u.outcome === "limited")).toHaveLength(1);
  });

  it("pauses new work on claude once it reports its 5-hour window nearly used up, moving that work to codex", async () => {
    const w = world();
    const resetsAt = w.clock.now() + 2 * HOUR;
    const architect = w.defaults.architect;
    w.agents.architect = async (job, call) => {
      const answer = await architect(job, call);
      if (call.label !== "spec") return answer;
      return { ...answer, events: [{ type: "utilization", info: { provider: "claude", window: "five_hour", utilization: 0.99, resetsAt } }] };
    };
    const queued = w.queueGreenfield();

    await w.night();

    const m = w.mission(queued.id);
    expect(m.status).toBe("done");
    expect(w.claude.calls.map(labelOf)).toEqual(["spec"]); // nothing new started on claude after it reported 99%
    expect(w.jobsFor("test_author").map((j) => [j.provider, j.model])).toEqual([
      ["codex", SOL],
      ["codex", SOL],
    ]);
    expect(runsOf(w.labeled("gate-c"))).toEqual([["gate-c", "codex", ASTRA, "high"]]);
    expect(w.jobsFor("scout")).toEqual([]); // optional helpers are skipped rather than waited for
    const quota = JSON.parse(read(join(w.home, "quota.json"))) as { utilization: unknown[] };
    expect(quota.utilization).toEqual([{ provider: "claude", window: "five_hour", utilization: 0.99, resetsAt }]);
    expect(w.appChecksPass(m.repoPath)).toBe(true);
  });
});

// ───────────────────────────── 5. Stop and resume ─────────────────────────────

describe("e2e: stop and resume", () => {
  it("stops on `mc stop` while an engineer is working; the next night resumes where it stopped and finishes", async () => {
    const w = world();
    w.agents.engineer = (job, call) =>
      call.label === "build-greet" && call.n === 1
        ? { edit: (cwd) => implement(cwd, "greet", "half done"), delayMs: Infinity } // still working when the stop comes
        : w.defaults.engineer(job, call);
    const queued = w.queueGreenfield();

    const first = w.night();
    await vi.waitFor(() => expect(w.labeled("build-greet")).toHaveLength(1), WAIT);
    w.store().requestStop(); // `mc stop`
    const night1 = await first;

    const stopped = w.mission(queued.id);
    expect(stopped).toMatchObject({ status: "stopped", stage: "features" });
    expect(stopped.features.map((f) => [f.id, f.status, f.attempts.length])).toEqual([
      ["greet", "building", 0],
      ["farewell", "pending", 0],
    ]);
    expect(w.report(queued.id)).toContain("**Paused, continues on the next run**");
    expect(read(night1.summaryPath)).toContain("Stopped early because you asked it to.");
    expect(read(night1.summaryPath)).toContain("**Fixture app**: Paused, continues on the next run");

    const night2 = await w.night();

    expect(night2.missions.map((m) => [m.id, m.status])).toEqual([[queued.id, "done"]]);
    const m = w.mission(queued.id);
    // Nothing finished before the stop ran again.
    expect(["spec", "gate-a", "init", "test-greet"].map((l) => w.labeled(l).length)).toEqual([1, 1, 1, 1]);
    expect(w.labeled("build-greet")).toHaveLength(2);
    // The interrupted run did not use up a rung.
    expect(attemptsOf(m, "greet")).toEqual([[0, "build", "codex", SOL, "medium", "pass"]]);
    expect(w.events(m.id).map((e) => e.type)).toEqual(expect.arrayContaining(["mission.stopped", "mission.resume"]));
    expect(w.usage(m.id).filter((u) => u.outcome === "aborted")).toHaveLength(1);
    expect(read(join(m.repoPath, "src/greet.mjs"))).toContain('"greet works"');
    expect(w.appChecksPass(m.repoPath)).toBe(true);
  });

  it("a stop also ends a test run that hangs, and the next night rebuilds that rung", async () => {
    const w = world({ features: [spec("greet")] });
    const hangs = 'await new Promise((resolve) => setTimeout(resolve, 10 * 60_000));\nexport function run() {\n  return "greet works";\n}\n';
    w.agents.engineer = (job, call) =>
      call.label === "build-greet" && call.n === 1 ? { edit: (cwd) => writeIn(cwd, "src/greet.mjs", hangs), structured: built() } : w.defaults.engineer(job, call);
    const queued = w.queueGreenfield();
    const verifyLog = () => join(w.store().logsDir(queued.id), "verify-greet-tests-a1.log");

    const startedAt = Date.now();
    const first = w.night();
    await vi.waitFor(() => expect(existsSync(verifyLog())).toBe(true), WAIT);
    w.store().requestStop();
    await first;

    expect(Date.now() - startedAt).toBeLessThan(15_000); // the hanging test run was killed, not waited for
    expect(w.mission(queued.id)).toMatchObject({ status: "stopped", stage: "features" });
    expect(featureOf(w.mission(queued.id), "greet").attempts).toEqual([]);
    expect(read(verifyLog())).toContain("aborted");

    await w.night();

    const m = w.mission(queued.id);
    expect(m.status).toBe("done");
    expect(attemptsOf(m, "greet")).toEqual([[0, "build", "codex", SOL, "medium", "pass"]]);
    expect(read(join(m.repoPath, "src/greet.mjs"))).not.toContain("setTimeout");
  }, 45_000);

  it("a stop while waiting for a limit ends the wait at once; after the reset the next night finishes", async () => {
    const clock = new FakeClock(eveningOf());
    const w = world({ clock, configure: (c) => (c.failover.enabled = false) });
    const reset = clock.now() + 2 * HOUR;
    intercept(w, (job) => (job.provider === "codex" && clock.now() < reset ? { outcome: "limited", limit: { kind: "session", resetsAt: reset } } : undefined));
    const queued = w.queueGreenfield();

    const first = w.night();
    await vi.waitFor(() => expect(w.mission(queued.id).status).toBe("waiting"), WAIT);
    w.store().requestStop();
    const night1 = await first; // the fake clock never moved: only the stop ended the wait

    expect(w.mission(queued.id)).toMatchObject({ status: "stopped", stage: "gate_a" });
    expect(clock.pendingSleeps()).toBe(0);
    expect(read(night1.summaryPath)).toContain("Stopped early because you asked it to.");

    await clock.advance(2 * HOUR + MIN);
    const night2 = await w.night();
    expect(night2.missions.map((m) => [m.id, m.status])).toEqual([[queued.id, "done"]]);
    expect(runsOf(w.labeled("gate-a"))).toEqual([
      ["gate-a", "codex", ASTRA, "high"],
      ["gate-a", "codex", ASTRA, "high"],
    ]);
  });
});

// ───────────────────────────── 6. Blocked feature ─────────────────────────────

describe("e2e: a feature that cannot be built", () => {
  it("blocks it once the ladder runs out, skips what depends on it, finishes the rest, and explains why", async () => {
    const w = world({ features: [spec("greet"), spec("farewell", ["greet"]), spec("extra")] });
    w.agents.engineer = (job, call) =>
      call.label === "build-greet" ? { edit: (cwd) => implement(cwd, "greet", "greet is broken"), structured: built("tried") } : w.defaults.engineer(job, call);
    w.agents.scout = (job, call) => (call.label === "report-prose" ? { outcome: "failed" } : w.defaults.scout(job, call)); // template narrative
    const queued = w.queueGreenfield();

    const night = await w.night();

    const m = w.mission(queued.id);
    expect(m).toMatchObject({ status: "partial", stage: "complete" });
    const greet = featureOf(m, "greet");
    expect(greet.status).toBe("blocked");
    expect(greet.blockedReason).toBe("tried every escalation step, but its checks still failed");
    expect(attemptsOf(m, "greet")).toEqual([
      [0, "build", "codex", SOL, "medium", "fail"],
      [1, "build", "codex", SOL, "high", "fail"],
      [2, "diagnose", "claude", OPUS, "high", "pass"],
      [3, "build", "claude", OPUS, "high", "fail"],
      [4, "build", "codex", ASTRA, "high", "fail"],
    ]);
    expect(featureOf(m, "farewell")).toMatchObject({ status: "skipped", blockedReason: 'waiting on "Feature greet", which was blocked' });
    expect(featureOf(m, "extra").status).toBe("done");
    expect(w.labeled("test-farewell")).toEqual([]); // nothing was spent on the skipped feature
    expect(w.labeled("build-farewell")).toEqual([]);

    // The blocked work is kept on its branch; its checkout is gone. main has what was finished.
    expect(await w.git.branchExists(m.repoPath, `${m.integrationBranch}--greet`)).toBe(true);
    expect(existsSync(join(w.home, "worktrees", m.id, "greet"))).toBe(false);
    expect(has(m.repoPath, "src/extra.mjs")).toBe(true);
    expect(has(m.repoPath, "src/greet.mjs")).toBe(false);
    expect(w.appChecksPass(m.repoPath)).toBe(true);

    const report = w.report(m.id);
    expect(report).toContain("**Partly done** · 1 of 3 features done");
    expect(report).toContain("1 of the 3 features is built and checked.");
    expect(report).toContain("1 feature got stuck; the table below says why.");
    expect(report).toContain("1 feature depended on a stuck feature, so I skipped it.");
    const table = sectionOf(report, "Features");
    expect(table).toContain("| ⛔ | Feature greet | Stuck: tried every escalation step, but its checks still failed (tried 5 times) |");
    expect(table).toContain('| ⛔ | Feature farewell | Skipped: waiting on "Feature greet", which was blocked |');
    expect(table).toContain("| ✅ | Feature extra | Built and checked |");
    expect(report).toContain("### What was tried for `greet`");

    expect(read(night.summaryPath)).toContain("**Fixture app**: Partly done, 1 of 3 features done.");
    expect(w.notifications().map((n) => [n.title, n.priority])).toEqual([
      ["Fixture app: partly done (1/3 features)", "4"],
      ["Night finished", "3"],
    ]);
  });
});

// ───────────────────────────── 7. Feature mission, broken baseline ─────────────────────────────

describe("e2e: a feature for an existing project", () => {
  it("works around a test that was already failing: judges the feature by its new tests and never touches the user's branch", async () => {
    const w = world({ features: [spec("greet")] });
    const repo = join(w.root, "existing-app");
    const base = await existingProject(repo, { broken: true });
    writeFileSync(join(repo, "notes.txt"), "my own uncommitted notes\n"); // the user's work in progress
    const queued = w.queueFeature(repo);

    await w.night();

    const m = w.mission(queued.id);
    expect(m).toMatchObject({ kind: "feature", status: "done", stage: "complete", baselineBroken: true, gateCRounds: 0 });
    expect(m.baselineFailures.length).toBeGreaterThan(0);
    expect(m.features.map((f) => [f.id, f.status])).toEqual([["greet", "done"]]);
    expect(m.notes).toContain("The project's own checks were already failing before this mission started, so features were judged by their new tests.");
    // The architect looked at the project read-only, and the feature was judged by its own tests only.
    expect(runsOf(w.labeled("onboard"))).toEqual([["onboard", "claude", OPUS, "high"]]);
    expect(w.labeled("onboard")[0]?.access).toBe("read-only");
    expect(w.labeled("spec")[0]?.noTools).toBeUndefined(); // a feature mission's planner may read the code
    const verifyLabels = w.events(m.id, "verify").map((e) => String(e.data.label));
    expect(verifyLabels).toContain("greet-tests-a1");
    expect(verifyLabels.filter((l) => l.startsWith("greet-full"))).toEqual([]);
    expect(w.events(m.id, "verify").find((e) => e.data.label === "gate-c")?.data.ok).toBe(false); // still red, not blamed

    // The user's branch, checkout and uncommitted work are untouched; the work is on the mission branch.
    expect(await w.git.headSha(repo, "main")).toBe(base);
    expect(await w.git.currentBranch(repo)).toBe("main");
    expect(read(join(repo, "notes.txt"))).toBe("my own uncommitted notes\n");
    expect(w.gitOut(repo, ["status", "--porcelain"])).toBe("?? notes.txt");
    expect(w.gitOut(repo, ["show", `${m.integrationBranch}:src/greet.mjs`])).toContain('"greet works"');
    expect(w.gitOut(repo, ["diff", base, m.integrationBranch, "--", "lib.mjs", "tests/lib.test.mjs"])).toBe(""); // nobody "fixed" the old test

    const report = w.report(m.id);
    expect(report).toContain("**Done** · 1 of 1 features done");
    expect(sectionOf(report, "Needs your decision")).toContain("already failing before I started");
    expect(report).toContain("### Checks failing before the mission");
    expect(sectionOf(report, "How to try it")).toContain(`git checkout ${m.integrationBranch}`);
    // Following "How to try it" works: the mission no longer holds the branch checked out.
    w.gitOut(repo, ["checkout", m.integrationBranch]);
    expect(has(repo, "src/greet.mjs")).toBe(true);
  });
});

// ───────────────────────────── 8. Deadline while waiting on limits ─────────────────────────────

describe("e2e: --until while waiting for limits", () => {
  it("waits out one limit, stops when the next reset is after the deadline, and finishes on the next night", async () => {
    const clock = new FakeClock(eveningOf(10, 23, 0));
    const w = world({ clock, features: [spec("greet")] });
    const sessionReset = eveningOf(11, 2, 0); // 02:00
    const weeklyReset = eveningOf(11, 12, 0); // noon, after the 07:00 deadline
    let weeklyHit = false;
    intercept(w, (_job, call) => {
      const now = clock.now();
      if (now < sessionReset) return { outcome: "limited", limit: { kind: "session", resetsAt: sessionReset } };
      if (call.label === "build-greet" && now < weeklyReset) weeklyHit = true;
      if (weeklyHit && now < weeklyReset) return { outcome: "limited", limit: { kind: "weekly", resetsAt: weeklyReset } };
      return undefined;
    });
    const queued = w.queueGreenfield();

    // Night 1, until 07:00. Both AIs are at their session limit at once: wait.
    const first = w.night({ until: "07:00" });
    await vi.waitFor(() => expect(w.mission(queued.id).status).toBe("waiting"), WAIT);
    expect(w.events(queued.id, "limit.wait").map((e) => e.data.until)).toEqual([new Date(sessionReset + WAIT_MARGIN_MS).toISOString()]);
    await vi.waitFor(() => expect(w.notifications().map((n) => n.title)).toContain("Waiting for usage limits"), WAIT);
    await clock.advance(3 * HOUR + MIN); // 02:01: the wait is over, work goes on until both hit their weekly limit
    const night1 = await first;

    const stopped = w.mission(queued.id);
    expect(stopped).toMatchObject({ status: "stopped", stage: "features" });
    expect(featureOf(stopped, "greet")).toMatchObject({ status: "building", attempts: [] });
    expect(w.events(queued.id, "limit.wait")).toHaveLength(1); // no wait past the deadline
    expect(String(w.events(queued.id, "mission.stopped")[0]?.data.reason)).toMatch(/deadline/);
    expect(runsOf(w.labeled("build-greet"))).toEqual([
      ["build-greet", "codex", SOL, "medium"],
      ["build-greet", "claude", SONNET, "medium"],
    ]);
    const summary1 = read(night1.summaryPath);
    expect(summary1).toContain("Some work is paused; it continues on the next run. Each report says why it paused.");
    expect(summary1).toContain("**Fixture app**: Paused, continues on the next run");
    const quota = JSON.parse(read(join(w.home, "quota.json"))) as { limits: Record<string, { kind: string; until: number }> };
    expect(quota.limits).toMatchObject({ claude: { kind: "weekly", until: weeklyReset }, codex: { kind: "weekly", until: weeklyReset } });

    // Night 2: the next evening, after the reset.
    await clock.advance(eveningOf(11, 23, 0) - clock.now());
    const night2 = await w.night({ until: "07:00" });

    expect(night2.missions.map((m) => [m.id, m.status])).toEqual([[queued.id, "done"]]);
    expect(night2.summaryPath).toBe(join(w.home, "reports", "night-2026-10-11.md"));
    expect(runsOf(w.labeled("build-greet")).at(-1)).toEqual(["build-greet", "codex", SOL, "medium"]);
    expect(["gate-a", "init", "test-greet"].map((l) => w.labeled(l).length)).toEqual([1, 1, 1]);
    expect(attemptsOf(w.mission(queued.id), "greet")).toEqual([[0, "build", "codex", SOL, "medium", "pass"]]);
  });
});

// ───────────────────────────── 9. Logins expired ─────────────────────────────

describe("e2e: every login has expired", () => {
  /** From the first build of greet on (while `expire.armed`), every run on every provider answers "not logged in". */
  function loginsExpireAtFirstBuild(w: World): { armed: boolean; expired: boolean } {
    const state = { armed: true, expired: false };
    intercept(w, (job, call) => {
      if (state.armed && call.label === "build-greet") state.expired = true;
      if (!state.expired) return undefined;
      return { outcome: "auth", error: job.provider === "claude" ? "Not logged in · Please run /login" : "unexpected status 401 Unauthorized" };
    });
    return state;
  }

  it("fails the mission with a plain 'log in again' decision, and finishes it once the user has logged in", async () => {
    const w = world();
    const logins = loginsExpireAtFirstBuild(w);
    const queued = w.queueGreenfield();

    const night1 = await w.night();

    const failed = w.mission(queued.id);
    expect(failed).toMatchObject({ status: "failed", stage: "features" });
    expect(runsOf(w.labeled("build-greet"))).toEqual([
      ["build-greet", "codex", SOL, "medium"],
      ["build-greet", "claude", SONNET, "medium"],
    ]);
    expect(failed.decisionsNeeded).toHaveLength(1);
    const decision = failed.decisionsNeeded[0] ?? "";
    expect(decision).toMatch(/^Log in again\b/);
    expect(decision).toMatch(/claude/);
    expect(decision).toMatch(/codex/);
    expect(sectionOf(w.report(queued.id), "Needs your decision")).toContain(decision);
    expect(w.report(queued.id)).toContain("**Stopped, needs your help**");
    const summary1 = read(night1.summaryPath);
    expect(summary1).toContain("**Fixture app**: Stopped, needs your help");
    expect(sectionOf(summary1, "Needs your decision")).toContain("Log in again");
    expect(w.notifications().map((n) => [n.title, n.priority])).toEqual([
      ["Fixture app: failed", "4"],
      ["Night finished", "4"],
    ]);
    expect(w.notifications()[0]?.body).toContain("Log in again");

    // An expired login is fixed outside Mission Control: once logged in, the next plain `mc run` (the scheduled one)
    // carries on where the mission stopped, without the owner having to know its id.
    logins.armed = false;
    logins.expired = false;
    const night2 = await w.night();

    expect(night2.missions.map((m) => [m.id, m.status])).toEqual([[queued.id, "done"]]);
    expect(["spec", "gate-a", "init", "test-greet"].map((l) => w.labeled(l).length)).toEqual([1, 1, 1, 1]);
    expect(featureOf(w.mission(queued.id), "greet").attempts.map((a) => a.outcome)).toEqual(["pass"]);
  });

  it("does not keep asking the user to log in once the mission has finished after a new login", async () => {
    const w = world({ features: [spec("greet")] });
    const logins = loginsExpireAtFirstBuild(w);
    const queued = w.queueGreenfield();
    await w.night();
    expect(w.mission(queued.id).status).toBe("failed");

    logins.armed = false;
    logins.expired = false;
    const night = await w.night({ missionId: queued.id });

    const m = w.mission(queued.id);
    expect(m.status).toBe("done");
    const report = w.report(m.id);
    expect(report).toContain("**Done** · 1 of 1 features done");
    // The login problem was solved: the morning report and the night summary must not tell the user to log in again.
    expect(sectionOf(report, "Needs your decision")).not.toContain("Log in again");
    expect(read(night.summaryPath)).not.toContain("Log in again");
  });

  it("tells the user how to continue after logging in, instead of a later `mc run` claiming nothing is queued", async () => {
    const w = world({ features: [spec("greet")] });
    const logins = loginsExpireAtFirstBuild(w);
    const queued = w.queueGreenfield();
    await w.night();
    const decision = w.mission(queued.id).decisionsNeeded[0] ?? "";

    // The user logs in again and, as the decision says, runs Mission Control again the usual way.
    logins.armed = false;
    logins.expired = false;
    const night2 = await w.night();

    const summary2 = read(night2.summaryPath);
    // Either this run picked the mission up again, or the user was told the command that does.
    const resumed = night2.missions.some((m) => m.id === queued.id);
    const toldHow = decision.includes(`mc run --mission ${queued.id}`) || summary2.includes(`mc run --mission ${queued.id}`);
    expect(resumed || toldHow, `decision: ${decision}\nnight summary:\n${summary2}`).toBe(true);
    // The mission still needs work, so the night must not report an empty queue.
    expect(summary2).not.toContain("Nothing was queued");
  });
});
