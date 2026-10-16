import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkpointId, scopeOf } from "./checkpoint.js";
import { describeEvent, main } from "./cli.js";
import { renderReport } from "./report.js";
import { runNight } from "./run.js";
import { MissionStore } from "./state.js";
import type { CheckpointKind, CheckpointRecord, Mission, MissionEvent, PendingCheckpoint } from "./types.js";
import { runProcess } from "./util/process.js";

// `mc run` is called through to the real thing, except in the one test that needs a canned night.
vi.mock("./run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run.js")>();
  return { ...actual, runNight: vi.fn(actual.runNight) };
});

let root: string;
let home: string;
let out: string;
let err: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-cli-checkpoint-"));
  home = join(root, "home");
  out = "";
  err = "";
  vi.stubEnv("MC_HOME", home);
  vi.stubEnv("MC_CONFIG", "");
  vi.stubEnv("MC_IN_CONTAINER", "");
  vi.stubEnv("HOME", join(root, "user-home"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude-config"));
  fetchMock = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

async function mc(...args: string[]): Promise<number> {
  out = "";
  err = "";
  return main(["node", "mc", ...args], { stdout: (t) => (out += t), stderr: (t) => (err += t) });
}

function store(): MissionStore {
  return new MissionStore(home);
}

function pending(kind: CheckpointKind = "plan", round = 1, featureId?: string): PendingCheckpoint {
  const scope = scopeOf(kind, featureId);
  return { id: checkpointId(scope, round), scope, kind, ...(featureId !== undefined && { featureId }), round, state: "pending", parkedAt: "2026-10-12T13:00:00.000Z", look: { headline: "Check it", lines: ["a line"] } };
}

function sentBack(scope: string, round: number): CheckpointRecord {
  return { id: checkpointId(scope, round), scope, kind: scope === "plan" ? "plan" : scope === "final" ? "final" : "feature", round, decision: "send_back", note: "x", at: "2026-10-12T13:30:00.000Z" };
}

/** A mission stopped for the owner's check. */
function parked(title = "Shout", checkpoint: PendingCheckpoint = pending(), fields: Partial<Mission> = {}): Mission {
  const s = store();
  const m = s.createMission({ kind: "greenfield", title, request: title, repoPath: "", baseBranch: "main", profile: "mixed", checkpoints: ["plan", "feature", "final"], nowMs: Date.now() });
  Object.assign(m, { status: "stopped", stage: "features", checkpoint }, fields);
  s.save(m);
  return m;
}

function noticeCount(): number {
  return fetchMock.mock.calls.length;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

async function makeRepo(): Promise<string> {
  const dir = join(root, "app");
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  return dir;
}

describe("--checkpoint on mc new and mc feature", () => {
  it("is described in the help of both commands", async () => {
    for (const command of ["new", "feature"]) {
      expect(await mc(command, "--help")).toBe(0);
      expect(out).toContain("--checkpoint <kind>");
      // The help wraps long lines, so compare the words.
      expect(out.replace(/\s+/g, " ")).toContain("stop for your check at this point: plan (before building), feature (before each feature is added), final (before finishing). Can be repeated.");
    }
    expect(await mc("approve", "--help")).toBe(0);
    expect(out).toContain("--note <text>");
    expect(await mc("send-back", "--help")).toBe(0);
    expect(out).toContain("--note <text>");
  });

  it("saves the kinds once each, in the order the owner meets them, and says where it will stop", async () => {
    expect(await mc("new", "A habit tracker", "--checkpoint", "final", "--checkpoint", "plan", "--checkpoint", "final")).toBe(0);
    expect(store().list()[0]?.checkpoints).toEqual(["plan", "final"]);
    expect(out).toContain("It will stop for your check: the plan, the finished app.\n");
    expect(out.split("\n").indexOf("It will stop for your check: the plan, the finished app.")).toBe(2); // after the id, before "It starts"
  });

  it("words each kind", async () => {
    expect(await mc("new", "One", "--checkpoint", "feature")).toBe(0);
    expect(out).toContain("It will stop for your check: each feature, before it is added.");
    expect(await mc("new", "Two", "--checkpoint", "plan", "--checkpoint", "feature", "--checkpoint", "final")).toBe(0);
    expect(out).toContain("It will stop for your check: the plan, each feature, before it is added, the finished app.");
  });

  it("rejects an unknown kind in plain words and queues nothing", async () => {
    expect(await mc("new", "A habit tracker", "--checkpoint", "middle")).toBe(1);
    expect(err).toContain("“middle” is not a checkpoint. Choose from: plan, feature, final.");
    expect(store().list()).toHaveLength(0);
  });

  it("changes nothing for a mission that asked for none: no line, no key", async () => {
    expect(await mc("new", "A habit tracker")).toBe(0);
    expect(out).not.toContain("stop for your check");
    expect("checkpoints" in (store().list()[0] as Mission)).toBe(false);
  });

  it("works for a change to an existing app too", async () => {
    const repo = await makeRepo();
    expect(await mc("feature", repo, "Add a dark mode", "--checkpoint", "final")).toBe(0);
    expect(out).toContain("It will stop for your check: the finished app.");
    expect(store().list()[0]?.checkpoints).toEqual(["final"]);
    expect(await mc("feature", repo, "Add more", "--checkpoint", "nope")).toBe(1);
    expect(err).toContain("“nope” is not a checkpoint.");
    expect(store().list()).toHaveLength(1);
  });
});

describe("mc approve", () => {
  it("records the approval while no run is going, and says what happens next", async () => {
    const m = parked();
    expect(await mc("approve", m.id, "--note", "plan is fine")).toBe(0);
    expect(out).toBe(`Recorded: you approved the plan for “Shout”.\nIt continues on the next run, for example: mc run --mission ${m.id}\n`);
    const after = store().load(m.id);
    expect(after.checkpoint).toMatchObject({ state: "answered", answer: { decision: "approve", note: "plan is fine" } });
    expect(store().readEvents(m.id).filter((e) => e.type === "checkpoint.answered")).toHaveLength(1);
    expect(store().activeRun()).toBeUndefined(); // the lock was given back
  });

  it("rewrites the report, so `mc report` shows the recorded answer and no longer says the check is waiting", async () => {
    const m = parked();
    writeFileSync(store().reportPath(m.id), renderReport(store().load(m.id), { usage: [], screenshots: [], generatedAt: new Date().toISOString(), inContainer: false }));
    expect(readFileSync(store().reportPath(m.id), "utf8")).toContain("## Waiting for your check");
    expect(await mc("approve", m.id, "--note", "plan is fine")).toBe(0);
    const report = readFileSync(store().reportPath(m.id), "utf8");
    expect(report).not.toContain("## Waiting for your check");
    expect(report).toContain("Your answer is recorded");
    expect(report).not.toContain("plan is fine"); // the note stays out of the report's text, as before
  });

  it("names a feature and the finished app", async () => {
    const a = parked("Shout", pending("feature", 1, "add-shout"), { features: [{ id: "add-shout", title: "Add shout", story: "", acceptance: [], kind: "standard", deps: [], status: "reviewing", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] }] });
    expect(await mc("approve", a.id)).toBe(0);
    expect(out).toContain("Recorded: you approved “Add shout” for “Shout”.");
    const b = parked("Other", pending("final"));
    expect(await mc("approve", b.id)).toBe(0);
    expect(out).toContain("Recorded: you approved the finished app for “Other”.");
  });

  it("names a feature that has the mission's own title once, not “X” for “X” (real run R2)", async () => {
    const feature = { id: "usage-guide", title: "Usage guide", story: "", acceptance: [], kind: "standard" as const, deps: [], status: "reviewing" as const, rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] };
    const a = parked("Usage guide", pending("feature", 1, "usage-guide"), { features: [feature] });
    expect(await mc("approve", a.id)).toBe(0);
    expect(out).toBe(`Recorded: you approved “Usage guide”.\nIt continues on the next run, for example: mc run --mission ${a.id}\n`);
    const b = parked("Usage guide", pending("feature", 1, "usage-guide"), { features: [feature] });
    expect(await mc("send-back", b.id, "--note", "shorter")).toBe(0);
    expect(out).toContain("Recorded: you sent “Usage guide” back.");
    expect(out).not.toMatch(/for “Usage guide”/);
  });

  it("sends one phone notice of default priority, without the note", async () => {
    expect(await mc("config", "set", "notify.ntfyUrl", "https://ntfy.example/topic")).toBe(0);
    const m = parked();
    expect(await mc("approve", m.id, "--note", "private words")).toBe(0);
    expect(noticeCount()).toBe(1);
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(init.headers.Priority).toBe("3");
    expect(init.headers.Title).toBe("Shout: your answer was recorded");
    expect(init.body).toMatch(/^You approved the plan for “Shout” at \d\d:\d\d\. It continues on the next run\.$/);
  });

  it("refuses a mission that does not exist", async () => {
    expect(await mc("approve", "nope")).toBe(1);
    expect(err).toBe('There is no mission called "nope". See your missions with: mc status\n');
    expect(out).toBe("");
  });

  it("refuses a mission that is not waiting for a check, and one that is complete", async () => {
    const plain = parkedNothing();
    expect(await mc("approve", plain)).toBe(1);
    expect(err).toBe("“Plain” is not waiting for your check, so there is nothing to answer. See what it is doing with: mc status\n");
    const done = parked("Finished", pending(), { stage: "complete", status: "done" });
    expect(await mc("send-back", done.id, "--note", "x")).toBe(1);
    expect(err).toContain("“Finished” is not waiting for your check");
    expect(out).toBe("");
  });

  it("says when the check was already answered, and records nothing more", async () => {
    const m = parked();
    expect(await mc("approve", m.id)).toBe(0);
    expect(await mc("approve", m.id)).toBe(1);
    expect(err).toMatch(/^You already answered this check \(approved at \d\d:\d\d\)\. It continues on the next run\.\n$/);
    expect(await mc("send-back", m.id, "--note", "no, change it")).toBe(1);
    expect(err).toContain("You already answered this check (approved at");
    expect(store().readEvents(m.id).filter((e) => e.type === "checkpoint.answered")).toHaveLength(1);
  });

  it("records nothing and says so while a run is going", async () => {
    const m = parked();
    const release = store().acquireLock();
    try {
      expect(await mc("approve", m.id)).toBe(1);
    } finally {
      release();
    }
    expect(err).toBe("A run is going right now, so the answer can't be recorded safely. Wait until it ends (see: mc status), then try again.\n");
    expect(store().load(m.id).checkpoint?.state).toBe("pending");
    expect(noticeCount()).toBe(0);
    expect(await mc("approve", m.id)).toBe(0); // and works once the run is over
  });

  it("refuses a record that is damaged, with the way out", async () => {
    const m = parked("Shout", { id: "plan#1" } as PendingCheckpoint);
    expect(await mc("approve", m.id)).toBe(1);
    expect(err).toBe(`This check can't be answered because its record is damaged. Ask the owner to run: mc run --mission ${m.id}\n`);
  });

  it("refuses a note that is too long", async () => {
    const m = parked();
    expect(await mc("approve", m.id, "--note", "x".repeat(2001))).toBe(1);
    expect(err).toContain("Your note is too long (at most 2000 characters).");
  });
});

function parkedNothing(): string {
  return store().createMission({ kind: "greenfield", title: "Plain", request: "Plain", repoPath: "", baseBranch: "main", profile: "mixed", nowMs: Date.now() }).id;
}

describe("mc send-back", () => {
  it("asks for the note first", async () => {
    const m = parked();
    expect(await mc("send-back", m.id)).toBe(1);
    expect(err).toBe(`Say what to change, for example: mc send-back ${m.id} --note "make the buttons bigger"\n`);
    expect(await mc("send-back", m.id, "--note", "   ")).toBe(1);
    expect(store().load(m.id).checkpoint?.state).toBe("pending");
  });

  it.each([
    ["plan", pending("plan"), "Recorded: you sent the plan for “Shout” back.\nThe planner revises it with your note and asks you again (change 1 of 2).\n"],
    [
      "feature",
      pending("feature", 1, "add-shout"),
      "Recorded: you sent “add-shout” for “Shout” back.\nThe team changes it with your note, a second AI looks again, and it asks you again (change 1 of 2).\n",
    ],
    ["final", pending("final"), "Recorded: you sent the finished app for “Shout” back.\nThe team adds your change as a new feature, checks it, and asks you again (change 1 of 2).\n"],
  ])("says what happens to a %s that is sent back", async (_kind, checkpoint, expected) => {
    const m = parked("Shout", checkpoint);
    expect(await mc("send-back", m.id, "--note", "make the buttons bigger")).toBe(0);
    expect(out).toBe(expected);
    expect(store().load(m.id).checkpoint).toMatchObject({ state: "answered", answer: { decision: "send_back", note: "make the buttons bigger" } });
  });

  it("counts the change, and tells the third one that the work stops", async () => {
    const second = parked("Shout", pending("plan", 2), { checkpointLog: [sentBack("plan", 1)] });
    expect(await mc("send-back", second.id, "--note", "again")).toBe(0);
    expect(out).toContain("(change 2 of 2).");
    const third = parked("Shout", pending("plan", 3), { checkpointLog: [sentBack("plan", 1), sentBack("plan", 2)] });
    expect(await mc("send-back", third.id, "--note", "once more")).toBe(0);
    expect(out).toBe("Recorded. You have sent this back twice before, so the work stops here: nothing will be built. The report says what to do next.\n");
    const feature = parked("Shout", pending("feature", 3, "a"), { checkpointLog: [sentBack("feature:a", 1), sentBack("feature:a", 2)] });
    expect(await mc("send-back", feature.id, "--note", "x")).toBe(0);
    expect(out).toContain("the work stops here: this feature is set aside and the rest carries on.");
    const last = parked("Shout", pending("final", 3), { checkpointLog: [sentBack("final", 1), sentBack("final", 2)] });
    expect(await mc("send-back", last.id, "--note", "x")).toBe(0);
    expect(out).toContain("the work stops here: the finished result is kept as it is.");
  });

  it("keeps the note out of the notice and out of the events", async () => {
    expect(await mc("config", "set", "notify.ntfyUrl", "https://ntfy.example/topic")).toBe(0);
    const m = parked();
    expect(await mc("send-back", m.id, "--note", "secret words")).toBe(0);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("secret");
    expect(readFileSync(join(home, "missions", m.id, "events.jsonl"), "utf8")).not.toContain("secret");
  });
});

describe("mc status and mc run with a check waiting", () => {
  it("shows what waits for the owner and what was answered", async () => {
    const waiting = parked("Shout");
    const answered = parked("Notes", { ...pending("final"), state: "answered", answer: { decision: "send_back", note: "n", at: new Date().toISOString() } });
    parkedNothing();

    expect(await mc("status")).toBe(0);
    const lines = out.split("\n");
    expect(lines.find((l) => l.startsWith(waiting.id))).toMatch(/ +new app +needs your check +features +/);
    expect(lines.find((l) => l.startsWith(answered.id))).toMatch(/ +new app +answered +features +/);
    expect(out).toContain(`“Shout” is waiting for your check (the plan). Read it: mc report ${waiting.id}. Then: mc approve ${waiting.id}  or  mc send-back ${waiting.id} --note "..."`);
    expect(out).toMatch(/You sent the finished app for “Notes” back\. It continues on the next run: mc run\n/);
  });

  it("puts the check in the JSON rows, and null where there is none", async () => {
    const waiting = parked("Shout", pending("feature", 2, "add-shout"));
    const plain = parkedNothing();
    expect(await mc("status", "--json")).toBe(0);
    const rows = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.id === waiting.id)?.checkpoint).toEqual({ kind: "feature", featureId: "add-shout", round: 2, state: "pending", decision: null });
    expect(rows.find((r) => r.id === plain)?.checkpoint).toBeNull();
    expect(await mc("approve", waiting.id)).toBe(0);
    expect(await mc("status", "--json")).toBe(0);
    expect((JSON.parse(out) as Array<Record<string, unknown>>).find((r) => r.id === waiting.id)?.checkpoint).toEqual({ kind: "feature", featureId: "add-shout", round: 2, state: "answered", decision: "approve" });
  });

  it("shows the waiting check, and the commands that answer it, in the first lines of its report even for a long plan", async () => {
    const lines = Array.from({ length: 28 }, (_, i) => `“Feature number ${i + 1}”: a sentence about what it does.`);
    const m = parked("Shout", { ...pending(), look: { headline: "Check the plan for “Shout”", lines } });
    writeFileSync(store().reportPath(m.id), renderReport(store().load(m.id), { usage: [], screenshots: [], generatedAt: new Date().toISOString(), inContainer: false }));
    expect(await mc("report", m.id)).toBe(0);
    const shown = out.split("\n").slice(0, 3 + 40).join("\n"); // "Report: <path>", a blank line, then the first 40 lines
    expect(shown).toContain("## Waiting for your check");
    expect(shown).toContain(`mc approve ${m.id}`);
    expect(shown).toContain(`mc send-back ${m.id} --note "what to change"`);
  });

  it("runs nothing for a mission that still waits, and says so", async () => {
    const m = parked();
    vi.mocked(runNight).mockClear();
    expect(await mc("run", "--mission", m.id)).toBe(0);
    expect(out).toBe("“Shout” is still waiting for your check (the plan). Nothing was started.\n");
    expect(runNight).not.toHaveBeenCalled();
    expect(store().load(m.id)).toEqual(m);
  });

  it("ends a run with the commands that answer each waiting mission", async () => {
    const m = parked("Shout", pending("feature", 1, "add-shout"));
    vi.mocked(runNight).mockResolvedValueOnce({ missions: [], summaryPath: "/x/night.md", waitingForYou: [], waitingForCheck: [m] });
    expect(await mc("run")).toBe(0);
    expect(out).toBe(
      [
        "No mission could run by itself:",
        `- Shout is waiting for your check (“add-shout”, before it is added). Look at it with: mc report ${m.id}. Then: mc approve ${m.id}   or   mc send-back ${m.id} --note "what to change".`,
        "Run summary: /x/night.md",
        "",
      ].join("\n"),
    );
  });

  it("describes the checkpoint events in logs, never with the owner's note", () => {
    const at = "2026-10-12T14:05:00.000Z";
    const e = (type: string, data: Record<string, unknown>): MissionEvent => ({ at, missionId: "m", type, data });
    expect(describeEvent(e("checkpoint.parked", { id: "plan#1", kind: "plan", round: 1 }))).toBe("waiting for your check of the plan");
    expect(describeEvent(e("checkpoint.parked", { id: "feature:a#2", kind: "feature", feature: "a", round: 2 }))).toBe("waiting for your check of a (before it is added) (shown 2 times)");
    expect(describeEvent(e("checkpoint.answered", { id: "final#1", kind: "final", decision: "approve", round: 1, at }))).toBe("you approved the finished app");
    expect(describeEvent(e("checkpoint.answered", { id: "plan#1", kind: "plan", decision: "send_back", round: 1, at, note: "secret" }))).toBe("you sent the plan back");
    expect(describeEvent(e("checkpoint.reworked", { id: "plan#1", kind: "plan", ok: true }))).toBe("the plan was changed after your note");
    expect(describeEvent(e("checkpoint.reworked", { id: "plan#1", kind: "plan", ok: false }))).toBe("your change to the plan could not be made; the earlier version is shown again");
    expect(describeEvent(e("checkpoint.passed", { id: "plan#1" }))).toBe("your answer was applied: plan#1");
    expect(describeEvent(e("checkpoint.limit", { kind: "final" }))).toBe("you sent the finished app back twice before, so the work stops there");
    expect(describeEvent(e("checkpoint.rejected", { id: "plan#1", reason: "no_record" }))).toBe("an answer to the check plan#1 was ignored (no_record); the check is still waiting");
  });
});
