// Dispatcher safeguards against agents that don't do as they are told and against an unattended night going wrong:
// branch switches, edits to what judges the work, a red baseline hiding regressions, disputes lost to a stop, open
// review problems, a full disk, crashes of Mission Control itself, stale git locks, and git settings that run commands.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentHandler,
  buildOutput,
  createFixtureRepo,
  diagnosis,
  feature,
  featureTestPath,
  type HarnessOptions,
  implementFeature,
  MissionHarness,
  writeFeatureTest,
  writeFile,
  writeScaffold,
} from "../test/fixtures/mission-harness.js";
import { condenseDiff } from "./dispatcher.js";
import type { InitOutput, Mission, MissionEvent, Role, TestAuthorOutput } from "./types.js";
import { orphanTrees, reapingApplies } from "./util/reap.js";

const GB = 1024 ** 3;

let h: MissionHarness | undefined;

afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function harness(opts: HarnessOptions = {}): MissionHarness {
  h = new MissionHarness(opts);
  return h;
}

function byDefault(role: Role): AgentHandler {
  return (job, call) => {
    if (!h) throw new Error("no harness");
    return h.defaults[role](job, call);
  };
}

/** git as an agent with a shell runs it in its worktree. */
function agentGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Agent", "-c", "user.email=agent@localhost", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function events(hh: MissionHarness, id: string, type: string): MissionEvent[] {
  return hh.store.readEvents(id).filter((e) => e.type === type);
}

function outcomes(m: Mission, id: string): string[] {
  return (m.features.find((f) => f.id === id)?.attempts ?? []).map((a) => `${a.action}:${a.outcome}`);
}

function scratchFile(hh: MissionHarness, id: string): string {
  return join(hh.store.missionDir(id), "dispatch.json");
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

// ───────────────────────────── Branches ─────────────────────────────

describe("Dispatcher: an agent that moves its worktree off the unit branch", () => {
  it("merges the checked work even when the engineer leaves HEAD detached", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: {
        engineer: (job, call) =>
          call.label === "build-greet"
            ? {
                edit: (cwd) => {
                  agentGit(cwd, ["checkout", "-q", "--detach"]);
                  implementFeature(cwd, "greet");
                },
                structured: buildOutput(),
              }
            : byDefault("engineer")(job, call),
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("done");
    expect(existsSync(join(m.repoPath, "src/greet.mjs"))).toBe(true);
    expect(events(hh, m.id, "branch.restored").map((e) => e.data.branch)).toEqual([`mc/${m.id}--greet`]);
    // The merge brought in the commit that was checked.
    const greet = m.features[0];
    expect(execFileSync("git", ["-C", m.repoPath, "merge-base", "--is-ancestor", greet?.commit ?? "", "main"]).toString()).toBe("");
  });
});

// ───────────────────────────── What judges the work ─────────────────────────────

/** A scaffold whose checks run through package.json scripts and a test runner script, as the house stack's do. */
const RUN_TESTS = 'import { spawnSync } from "node:child_process";\nconst r = spawnSync(process.execPath, ["--test", ...process.argv.slice(2)], { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n';
const PACKAGE_JSON = `${JSON.stringify({ name: "fixture-app", private: true, type: "module", scripts: { verify: 'node --test "tests/**/*.test.mjs"', dev: "node app.mjs" } }, null, 2)}\n`;
const SCRIPTED_VERIFY = { install: null, full: "npm run --silent verify", tests: "node scripts/run-tests.mjs {files}", testGlobs: ["tests/**"] };

function scriptedInit(): AgentHandler {
  return () => ({
    edit: (cwd) => {
      writeScaffold(cwd);
      writeFile(cwd, "package.json", PACKAGE_JSON);
      writeFile(cwd, "scripts/run-tests.mjs", RUN_TESTS);
    },
    structured: { summary: "scaffolded", verify: SCRIPTED_VERIFY, notes: [] } satisfies InitOutput,
  });
}

describe("Dispatcher: what judges the engineer's work stays as it was", () => {
  it("puts back an earlier feature's tests, the test runner script and the package.json scripts the checks call", async () => {
    const hh = harness({
      agents: {
        engineer: (job, call) => {
          if (call.label === "init") return scriptedInit()(job, call);
          if (call.label === "build-farewell" && call.n === 1) {
            return {
              edit: (cwd) => {
                implementFeature(cwd, "farewell");
                implementFeature(cwd, "greet", "BROKEN"); // breaks the feature merged before…
                writeFile(cwd, featureTestPath("greet"), 'import test from "node:test";\n\ntest("greet", () => {});\n'); // …and its test
                writeFile(cwd, "scripts/run-tests.mjs", "process.exit(0);\n");
                const pkg = JSON.parse(read(join(cwd, "package.json")));
                pkg.scripts.verify = "echo all checks passed";
                pkg.scripts.extra = "echo a new script is fine";
                writeFile(cwd, "package.json", `${JSON.stringify(pkg, null, 2)}\n`);
              },
              structured: buildOutput("done, honestly"),
            };
          }
          if (call.label === "build-farewell") {
            return {
              edit: (cwd) => {
                implementFeature(cwd, "greet");
                implementFeature(cwd, "farewell");
              },
              structured: buildOutput("fixed greet again"),
            };
          }
          return byDefault("engineer")(job, call);
        },
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("done");
    expect(outcomes(m, "farewell")).toEqual(["build:fail", "build:pass"]);
    const firstTry = m.features[1]?.attempts[0]?.summary ?? "";
    expect(firstTry).toContain("edited frozen tests (reverted): tests/greet.test.mjs, scripts/run-tests.mjs, package.json (scripts.verify)");
    // Nothing of the cheat reached the app.
    expect(read(join(m.repoPath, featureTestPath("greet")))).toContain('assert.equal(answer(), "greet")');
    expect(read(join(m.repoPath, "scripts/run-tests.mjs"))).toBe(RUN_TESTS);
    const scripts = JSON.parse(read(join(m.repoPath, "package.json"))).scripts;
    expect(scripts.verify).toBe('node --test "tests/**/*.test.mjs"');
    expect(scripts.extra).toBe("echo a new script is fine"); // scripts the checks don't call are the engineer's
    expect(read(join(m.repoPath, "src/greet.mjs"))).toContain('"greet"');
  });

  it("undoes a test author's edits to the tests of features already finished", async () => {
    const hh = harness({
      agents: {
        test_author: (job, call) =>
          call.label === "test-farewell"
            ? {
                edit: (cwd) => {
                  writeFeatureTest(cwd, "farewell");
                  writeFile(cwd, featureTestPath("greet"), 'import test from "node:test";\n\ntest("greet", () => {});\n');
                },
                structured: { testFiles: [featureTestPath("farewell"), featureTestPath("greet")], notes: "" } satisfies TestAuthorOutput,
              }
            : byDefault("test_author")(job, call),
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("done");
    expect(m.features[1]?.frozenTests.map((t) => t.path)).toEqual([featureTestPath("farewell")]);
    expect(m.notes).toContain('The test author for “Feature farewell” also changed the tests of features already finished (tests/greet.test.mjs); those changes were undone.');
    expect(read(join(m.repoPath, featureTestPath("greet")))).toContain('assert.equal(answer(), "greet")');
  });

  it("keeps a feature's earlier test files frozen when a diagnosis has its tests rewritten", async () => {
    const extra = "tests/greet-extra.test.mjs";
    const hh = harness({
      features: [feature("greet")],
      agents: {
        test_author: (job, call) =>
          call.label === "test-greet" && call.n === 1
            ? {
                edit: (cwd) => {
                  writeFeatureTest(cwd, "greet", "GREET");
                  writeFile(cwd, extra, read(join(cwd, featureTestPath("greet"))).replace("gives its answer", "answers"));
                },
                structured: { testFiles: [featureTestPath("greet"), extra], notes: "" } satisfies TestAuthorOutput,
              }
            : call.label === "test-greet"
              ? {
                  // Fixes both files, but lists only the one the dispute was about.
                  edit: (cwd) => {
                    writeFeatureTest(cwd, "greet");
                    writeFile(cwd, extra, read(join(cwd, featureTestPath("greet"))).replace("gives its answer", "answers"));
                  },
                  structured: { testFiles: [featureTestPath("greet")], notes: "" } satisfies TestAuthorOutput,
                }
              : byDefault("test_author")(job, call),
        engineer: (job, call) =>
          call.label === "build-greet" && call.n === 1
            ? { edit: (cwd) => implementFeature(cwd, "greet"), structured: buildOutput("tried", { file: featureTestPath("greet"), reason: "It wants GREET; the criteria say greet." }) }
            : byDefault("engineer")(job, call),
        architect: (job, call) =>
          call.label === "diagnose-greet" ? { structured: diagnosis("amend_tests", "", "The tests want GREET.") } : byDefault("architect")(job, call),
      },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.status).toBe("done");
    expect(m.features[0]?.frozenTests.map((t) => t.path).sort()).toEqual([extra, featureTestPath("greet")].sort());
  });
});

// ───────────────────────────── A red baseline ─────────────────────────────

describe("Dispatcher: a project whose own checks were already failing", () => {
  it("runs the finished features' tests with each later feature, so breaking one fails the attempt", async () => {
    const hh = harness({
      agents: {
        engineer: (job, call) => {
          if (call.label === "build-farewell" && call.n === 1) {
            return {
              edit: (cwd) => {
                implementFeature(cwd, "farewell");
                implementFeature(cwd, "greet", "BROKEN");
              },
              structured: buildOutput(),
            };
          }
          if (call.label === "build-farewell") {
            return {
              edit: (cwd) => {
                implementFeature(cwd, "farewell");
                implementFeature(cwd, "greet");
              },
              structured: buildOutput("repaired greet"),
            };
          }
          return byDefault("engineer")(job, call);
        },
      },
    });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo, { broken: true });
    const m = await hh.run(hh.createMission("feature", { repoPath: repo }).id);

    expect(m.baselineBroken).toBe(true);
    expect(m.status).toBe("done");
    expect(outcomes(m, "farewell")).toEqual(["build:fail", "build:pass"]);
    expect(m.features[1]?.attempts[0]?.summary).toContain("verification failed");
    const verifies = events(hh, m.id, "verify").map((e) => [e.data.label, e.data.ok]);
    expect(verifies).toContainEqual(["farewell-tests-a1", false]);
    expect(verifies).toContainEqual(["gate-c-features", true]);
    const greetOnBranch = execFileSync("git", ["-C", repo, "show", `${m.integrationBranch}:src/greet.mjs`]).toString();
    expect(greetOnBranch).toContain('"greet"');
  });
});

// ───────────────────────────── Disputes, reviews ─────────────────────────────

describe("Dispatcher: test disputes and open review problems", () => {
  it("still diagnoses a disputed test, with the dispute, when a stop comes before the diagnosis", async () => {
    const dispute = { file: featureTestPath("greet"), reason: "The criteria say the answer is lowercase." };
    const hh = harness({
      features: [feature("greet")],
      agents: {
        engineer: (job, call) =>
          call.label === "build-greet" && call.n === 1
            ? { edit: (cwd) => implementFeature(cwd, "greet", "GREET"), structured: buildOutput("tried", dispute) }
            : byDefault("engineer")(job, call),
        scout: (job, call) => {
          if (call.label === "digest-greet") h?.store.requestStop(); // `mc stop` while the failure is digested
          return byDefault("scout")(job, call);
        },
      },
    });
    const id = hh.createMission("greenfield").id;
    const stopped = await hh.run(id);
    expect(stopped.status).toBe("stopped");
    expect(hh.jobsLabeled("diagnose-greet")).toHaveLength(0);

    hh.store.clearStop();
    const m = await hh.run(id);

    expect(m.status).toBe("done");
    expect(hh.jobsLabeled("diagnose-greet")).toHaveLength(1);
    expect(hh.jobsLabeled("diagnose-greet")[0]?.prompt).toContain("The criteria say the answer is lowercase.");
    expect(m.features[0]?.attempts.map((a) => [a.rung, a.action, a.outcome])).toEqual([
      [0, "build", "fail"],
      [2, "diagnose", "pass"],
      [3, "build", "pass"],
    ]);
  });

  it("is only partly done when the final review of the whole app did not finish", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: { reviewer: (job, call) => (call.label === "gate-c" ? { outcome: "failed", error: "gave up" } : byDefault("reviewer")(job, call)) },
    });
    const m = await hh.run(hh.createMission("greenfield").id);

    expect(m.features[0]?.status).toBe("done");
    expect(m.status).toBe("partial");
    expect(m.decisionsNeeded).toEqual([
      "Have someone check the app before you rely on it: the final review of the whole app did not finish, so nobody reviewed it as a whole. “Review notes” and “Technical details” list what the reviewers found.",
    ]);
    expect(h?.notifications.at(-1)?.title).toBe("Fixture app: partly done (1/1 feature)");
  });
});

// ───────────────────────────── Disk space ─────────────────────────────

describe("Dispatcher: a full disk", () => {
  it("pauses before any work when the disk is almost full, and carries on once there is room", async () => {
    const hh = harness({ features: [feature("greet")] });
    const id = hh.createMission("greenfield").id;
    const paused = await hh.run(id, { freeBytes: () => 1 * GB });

    expect(paused.status).toBe("stopped");
    expect(hh.jobs).toHaveLength(0);
    expect(paused.notes.some((n) => n.startsWith("Paused because the disk is almost full (1.0 GB free"))).toBe(true);
    expect(hh.notifications).toEqual([expect.objectContaining({ title: "Fixture app: paused, the disk is almost full", opts: { priority: "high", tags: ["warning"] } })]);

    const m = await hh.run(id, { freeBytes: () => 50 * GB });
    expect(m.status).toBe("done");
  });

  it("does not count a check that ran out of disk space against the feature", async () => {
    const hh = harness({
      features: [feature("greet")],
      agents: {
        engineer: (job, call) =>
          call.label === "build-greet" && call.n === 1
            ? { edit: (cwd) => writeFile(cwd, "src/greet.mjs", 'export function answer() {\n  throw new Error("ENOSPC: no space left on device, write");\n}\n'), structured: buildOutput() }
            : byDefault("engineer")(job, call),
      },
    });
    const id = hh.createMission("greenfield").id;
    const paused = await hh.run(id);
    expect(paused.status).toBe("stopped");
    expect(paused.features[0]?.attempts).toEqual([]);
    expect(paused.features[0]?.rung).toBe(0);

    const m = await hh.run(id);
    expect(m.status).toBe("done");
    expect(m.features[0]?.attempts.map((a) => [a.rung, a.outcome])).toEqual([[0, "pass"]]);
  });
});

// ───────────────────────────── Mission Control itself dying ─────────────────────────────

describe("Dispatcher: a run cut short by Mission Control itself dying", () => {
  /**
   * Runs the mission until its review run is under way, stops there, then makes it look like Mission Control died
   * during that run: the run's marker is left behind and the mission still says "running".
   */
  async function crashDuringReview(hh: MissionHarness, interruptionsBefore = 0, legacy = true): Promise<string> {
    const stop = new AbortController();
    hh.agents.reviewer = (job, call) => {
      if (call.label !== "review-greet" || call.n !== 1) return byDefault("reviewer")(job, call);
      setTimeout(() => stop.abort(), 20);
      return { delayMs: 60_000 };
    };
    const id = hh.createMission("greenfield").id;
    expect((await hh.run(id, { signal: stop.signal })).features[0]?.status).toBe("reviewing");
    hh.agents = {};
    const scratch = JSON.parse(read(scratchFile(hh, id)));
    scratch.inflight = { label: "review-greet", feature: "greet", at: "2026-10-11T02:13:00.000Z" };
    if (interruptionsBefore > 0) scratch.interruptions = { "review-greet": interruptionsBefore };
    writeFileSync(scratchFile(hh, id), JSON.stringify(scratch));
    const m = hh.load(id);
    // A scratch-only legacy mission predates the whole evidence bundle, not only its journal.
    // Retaining modern tracking while removing its journal is damaged modern state, covered separately.
    delete m.invocations;
    if (legacy) for (const key of ["workEvidenceVersion","workTracking","applicationLedger","provenance","provenanceUncertain","workRestore","workRestack"] as const) delete m[key];
    if (legacy) for (const f of m.features) { delete f.provenance; delete f.provenanceUncertain; }
    m.status = "running";
    hh.store.save(m);
    return id;
  }

  it("counts the interrupted run and notes it, then carries on", async () => {
    const hh = harness({ features: [feature("greet")] });
    const id = await crashDuringReview(hh);
    const runsBefore = hh.load(id).agentRuns;
    const jobsBefore = hh.jobs.length;

    const m = await hh.run(id);

    expect(m.status).toBe("done");
    expect(m.notes).toContain('Mission Control stopped unexpectedly while "review-greet" was running (it started at 2026-10-11T02:13:00.000Z); that step was tried again.');
    expect(events(hh, id, "run.interrupted")).toEqual([expect.objectContaining({ data: expect.objectContaining({ label: "review-greet", count: 1 }) })]);
    expect(m.agentRuns).toBe(runsBefore + 1 + (hh.jobs.length - jobsBefore)); // the interrupted run counts too
    expect(JSON.parse(read(scratchFile(hh, id))).inflight).toBeUndefined();
  });

  it("stops and preserves modern tracking when its referenced journal has been lost", async () => {
    const hh=harness({features:[feature("greet")]});
    const id=await crashDuringReview(hh,0,false),before=hh.load(id);
    const tracking=structuredClone(before.workTracking),provenance=structuredClone(before.features[0]?.provenance);
    const jobs=hh.jobs.length,result=await hh.run(id);
    expect(result.status).toBe("stopped");
    expect(result.workTracking).toEqual(tracking);expect(result.features[0]?.provenance).toEqual(provenance);
    expect(result.workRestore).toBeDefined();expect(result.features[0]?.status).toBe("reviewing");
    expect(hh.jobs).toHaveLength(jobs);
  });

  it("sets a feature aside when runs on it took Mission Control down three times", async () => {
    const hh = harness({ features: [feature("greet")] });
    const id = await crashDuringReview(hh, 2);

    const m = await hh.run(id);

    expect(m.features[0]).toMatchObject({ status: "blocked" });
    expect(m.features[0]?.blockedReason).toMatch(/^Mission Control stopped unexpectedly 3 times while working on it/);
    expect(m.status).toBe("partial");
  });
});

// ───────────────────────────── The app repository's .git ─────────────────────────────

describe("Dispatcher: the app repository's git settings", () => {
  it("removes git lock files a killed git process left behind", async () => {
    const hh = harness({ features: [feature("greet")] });
    const repo = join(hh.workspace, "existing");
    await createFixtureRepo(hh.git, repo);
    const lock = join(repo, ".git", "index.lock");
    writeFileSync(lock, "");
    const hourAgo = Date.now() / 1000 - 3600;
    utimesSync(lock, hourAgo, hourAgo);

    const m = await hh.run(hh.createMission("feature", { repoPath: repo }).id);

    expect(existsSync(lock)).toBe(false);
    expect(events(hh, m.id, "git.locks.removed").map((e) => e.data.files)).toEqual([["index.lock"]]);
    expect(m.status).toBe("done");
  });

  it("undoes config entries and hooks that make git run commands, and keeps harmless changes", async () => {
    const hh = harness({ features: [feature("greet")] });
    const repo = join(hh.workspace, "existing");
    const marker = join(hh.root, "PWNED");
    hh.agents = {
      test_author: async (job, call) => {
        const answer = await byDefault("test_author")(job, call);
        return {
          ...answer,
          edit: async (cwd, j) => {
            agentGit(cwd, ["remote", "add", "backup", "https://example.invalid/backup.git"]); // harmless
            await answer.edit?.(cwd, j);
          },
        };
      },
      engineer: (job, call) =>
        call.label === "build-greet"
          ? {
              edit: (cwd) => {
                implementFeature(cwd, "greet");
                agentGit(cwd, ["config", "core.fsmonitor", `touch ${marker}; false #`]); // lands in the shared .git/config
                writeFileSync(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
              },
              structured: buildOutput(),
            }
          : byDefault("engineer")(job, call),
    };
    await createFixtureRepo(hh.git, repo);
    const m = await hh.run(hh.createMission("feature", { repoPath: repo }).id);

    expect(m.status).toBe("done");
    expect(events(hh, m.id, "git.settings.restored").map((e) => e.data.changes)).toEqual([["config core.fsmonitor", "hook post-checkout"]]);
    expect(m.notes.some((n) => n.startsWith("Something an agent ran changed the app repository's git settings"))).toBe(true);
    // The owner's own git in the app folder runs nothing an agent planted.
    execFileSync("git", ["-C", repo, "status"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "checkout", "-q", m.integrationBranch]);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(repo, ".git", "hooks", "post-checkout"))).toBe(false);
    expect(execFileSync("git", ["-C", repo, "remote"]).toString()).toContain("backup");
  });
});

// ───────────────────────────── Between missions ─────────────────────────────

describe("Dispatcher.noWorkPossible", () => {
  it("says why no mission can work now: every login expired, every AI busy past the deadline, a full disk", () => {
    const hh = harness();
    expect(hh.dispatcher().noWorkPossible()).toBeUndefined();
    expect(hh.dispatcher({ freeBytes: () => 0.5 * GB }).noWorkPossible()).toMatch(/^the disk is almost full \(0\.5 GB free/);

    const now = Date.now();
    hh.quota.recordLimit({ provider: "claude", kind: "session", resetsAt: now + 3 * 3_600_000, raw: "limit" });
    hh.quota.recordLimit({ provider: "codex", kind: "session", resetsAt: now + 3 * 3_600_000, raw: "limit" });
    expect(hh.dispatcher().noWorkPossible()).toBeUndefined(); // no deadline: the run waits
    expect(hh.dispatcher({ deadline: now + 3_600_000 }).noWorkPossible()).toBe("no AI is free again before the time this run has to stop");
    expect(hh.dispatcher({ deadline: now + 5 * 3_600_000 }).noWorkPossible()).toBeUndefined();

    hh.quota.recordAuthFailure("claude", "Please run /login");
    hh.quota.recordAuthFailure("codex", "401");
    expect(hh.dispatcher().noWorkPossible()).toBe("every AI needs a new login");
  });
});

// ───────────────────────────── Leftover processes ─────────────────────────────

describe("leftover processes", () => {
  it("kills what agents and checks left running before and after every run and check", async () => {
    let calls = 0;
    const hh = harness({ features: [feature("greet")] });
    const m = await hh.run(hh.createMission("greenfield").id, {
      reapOrphans: async () => (++calls === 3 ? [4242] : []),
    });
    expect(m.status).toBe("done");
    expect(calls).toBeGreaterThan(2 * hh.jobs.length); // before and after each agent run, and before each check
    expect(events(hh, m.id, "processes.reaped").map((e) => e.data.pids)).toEqual([[4242]]);
  });

  it("picks every child of init but mc itself, with all their descendants", () => {
    const table = [
      { pid: 1, ppid: 0 }, // init (tini)
      { pid: 10, ppid: 1 }, // mc
      { pid: 11, ppid: 10 }, // mc's own child: a run it waits for
      { pid: 20, ppid: 1 }, // a dev server an agent left behind
      { pid: 21, ppid: 20 },
      { pid: 22, ppid: 21 },
      { pid: 30, ppid: 1 }, // a Playwright web server whose test run died
      { pid: 40, ppid: 0 }, // `docker exec` shell: not a child of init
      { pid: 41, ppid: 40 },
    ];
    expect(orphanTrees(table, 10)).toEqual([20, 21, 22, 30]);
  });

  it("only reaps as the container's main process", () => {
    expect(reapingApplies({ MC_IN_CONTAINER: "1" }, 1)).toBe(true);
    expect(reapingApplies({ MC_IN_CONTAINER: "1" }, 4321)).toBe(false); // e.g. run from a shell inside the container
    expect(reapingApplies({}, 1)).toBe(false);
  });
});

// ───────────────────────────── Diffs for prompts ─────────────────────────────

describe("condenseDiff", () => {
  function section(path: string, body: string): string {
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n${body}\n`;
  }

  it("leaves a small diff alone", () => {
    const diff = section("src/a.ts", "+export const a = 1;");
    expect(condenseDiff(diff, 10_000)).toBe(diff);
  });

  it("shrinks lockfiles to one line, so the code that sorts after them is shown", () => {
    const lock = section("package-lock.json", `+${"x".repeat(300_000)}`);
    const code = section("src/app/page.tsx", "+export default function Page() {}");
    const test = section("tests/e2e/home.spec.ts", "+test('home', () => {});");
    const out = condenseDiff(lock + code + test, 60_000);
    expect(out.length).toBeLessThan(60_000);
    expect(out).toContain("[package-lock.json: ");
    expect(out).toContain("export default function Page() {}");
    expect(out).toContain("test('home', () => {});");
  });

  it("gives every file a fair share when the code itself is too long, keeping small files whole", () => {
    const big1 = section("src/big1.ts", `+${"a".repeat(50_000)}`);
    const big2 = section("src/big2.ts", `+${"b".repeat(50_000)}`);
    const small = section("src/small.ts", "+export const small = true;");
    const out = condenseDiff(big1 + big2 + small, 20_000);
    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(out).toContain("diff --git a/src/big1.ts");
    expect(out).toContain("diff --git a/src/big2.ts");
    expect(out).toContain("export const small = true;");
    expect(out.match(/more chars of this file's changes left out/g)).toHaveLength(2);
    expect(out.indexOf("src/big1.ts")).toBeLessThan(out.indexOf("src/big2.ts")); // git's order is kept
  });
});

