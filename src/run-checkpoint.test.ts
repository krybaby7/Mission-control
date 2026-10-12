import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { existingProject, headings, labelOf, World, type WorldOptions } from "../test/e2e-world.js";
import { applyAnswer } from "./checkpoint.js";
import { main } from "./cli.js";
import { missionOutcome } from "./run.js";
import type { Mission } from "./types.js";

let current: World | undefined;

function world(opts: WorldOptions = {}): World {
  current = new World(opts);
  return current;
}

afterEach(() => {
  current?.cleanup();
  current = undefined;
});

/** The phone notices that ask for a check, apart from the night's own. */
function checkNotices(w: World) {
  return w.notifications().filter((n) => n.title.includes("please check"));
}

function summaryOf(path: string): string {
  return readFileSync(path, "utf8");
}

function approve(w: World, id: string): void {
  const result = applyAnswer(w.store(), id, { decision: "approve" }, w.clock.now());
  expect(result.ok).toBe(true);
}

describe("a mission that waits for its owner's check", () => {
  it("does not hold up the others, ends the run without waiting, and is listed in the summary and the notice", async () => {
    const w = world();
    const parked = w.queueGreenfield("A parked app", "Build a parked app", ["plan"]);
    const plain = w.queueGreenfield("B plain app");

    const night = await w.night();

    expect(night.missions.map((m) => [m.id, m.status])).toEqual([
      [parked.id, "stopped"],
      [plain.id, "done"],
    ]);
    expect(night.waitingForCheck.map((m) => m.id)).toEqual([parked.id]);
    expect(night.waitingForYou).toEqual([]);
    expect(w.mission(parked.id).checkpoint).toMatchObject({ id: "plan#1", state: "pending" });
    expect(w.events(parked.id, "limit.wait")).toHaveLength(0); // it moved on, it did not wait
    expect(w.mission(parked.id)).toMatchObject({ repoPath: "", stage: "init" }); // stopped before its scaffold was built
    expect(w.mission(parked.id).features.every((f) => f.status === "pending")).toBe(true);
    expect(w.mission(plain.id).features.map((f) => f.status)).toEqual(["done", "done"]);

    const summary = summaryOf(night.summaryPath);
    expect(headings(summary)).toEqual(["Missions", "Waiting for your check"]);
    expect(summary).toContain(`- **A parked app**: Waiting for your check, 0 of 2 features done.`);
    expect(summary).toContain(
      `- **A parked app** is waiting for your check (the plan). Look at it with \`mc report ${parked.id}\`, then run \`mc approve ${parked.id}\` or \`mc send-back ${parked.id} --note "what to change"\`.`,
    );
    expect(summary).toContain("Every queued mission was worked on."); // a check is not a pause
    expect(summary).not.toContain("Still waiting in the queue");

    // One high-priority notice for the check, and the night's own, also high because something waits for the owner.
    expect(checkNotices(w)).toEqual([expect.objectContaining({ title: "A parked app: please check the plan", priority: "4" })]);
    const finished = w.notifications().find((n) => n.title === "Night finished");
    expect(finished?.priority).toBe("4");
    expect(finished?.body).toContain("A parked app: Waiting for your check, 0 of 2 features done");
  });

  it("is left alone by the next runs, then carries on after the owner approves", async () => {
    const w = world();
    const parked = w.queueGreenfield("A parked app", "Build a parked app", ["plan"]);
    await w.night();
    const jobs = w.jobs.length;

    const again = await w.night();
    expect(again.missions).toEqual([]); // nothing to do: it is not "queued work"
    expect(again.waitingForCheck.map((m) => m.id)).toEqual([parked.id]);
    expect(w.jobs).toHaveLength(jobs);
    expect(summaryOf(again.summaryPath)).toContain("No mission could run by itself tonight: the ones left need you first (below).");
    expect(checkNotices(w)).toHaveLength(1); // the owner is told once, not on every run
    expect(w.notifications().filter((n) => n.title === "Night finished").at(-1)?.body).toContain("A parked app: waiting for your check");

    // `mc run --mission` on it is a no-op for the dispatcher.
    const only = await w.night({ missionId: parked.id });
    expect(only.missions.map((m) => m.checkpoint?.state)).toEqual(["pending"]);
    expect(w.jobs).toHaveLength(jobs);

    approve(w, parked.id);
    const night = await w.night();
    expect(night.missions.map((m) => [m.id, m.status])).toEqual([[parked.id, "done"]]);
    expect(night.waitingForCheck).toEqual([]);
    expect(w.notifications().filter((n) => n.title === "Night finished").at(-1)?.priority).toBe("3");
    expect(w.report(parked.id)).toContain("| The plan | Approved |");
  });

  it("carries on after the real `mc approve` command, and asks again after `mc send-back`", async () => {
    const w = world();
    const parked = w.queueGreenfield("A parked app", "Build a parked app", ["plan"]);
    await w.night();
    let out = "";
    let err = "";
    const mc = (...args: string[]) => main(["node", "mc", ...args], { stdout: (t) => (out += t), stderr: (t) => (err += t) });

    expect(await mc("send-back", parked.id, "--note", "only the greeting")).toBe(0);
    const again = await w.night();
    expect(again.missions[0]?.checkpoint).toMatchObject({ id: "plan#2", state: "pending" });
    expect(w.labeled("spec")[1]?.prompt).toContain("only the greeting");

    expect(await mc("approve", parked.id, "--note", "now it is right")).toBe(0);
    expect(err).toBe("");
    const done = await w.night();
    expect(done.missions.map((m) => [m.id, m.status])).toEqual([[parked.id, "done"]]);
    expect(w.mission(parked.id).checkpointLog?.map((r) => [r.id, r.decision])).toEqual([
      ["plan#1", "send_back"],
      ["plan#2", "approve"],
    ]);
    expect(w.events(parked.id, "checkpoint.rejected")).toEqual([]); // the engine believed both answers
  });

  it("tells the phone at the start of a run when Mission Control died before the notice went out, and only once", async () => {
    const w = world();
    const parked = w.queueGreenfield("A parked app", "Build a parked app", ["plan"]);
    await w.night();
    expect(checkNotices(w)).toHaveLength(1);

    // The state a crash between saving the check and sending its notice leaves behind.
    const m = w.mission(parked.id);
    delete m.checkpoint?.notifiedAt;
    w.store().save(m);

    await w.night();
    expect(checkNotices(w)).toHaveLength(2);
    expect(checkNotices(w)[1]).toMatchObject({ title: "A parked app: please check the plan", priority: "4" });
    expect(w.mission(parked.id).checkpoint?.notifiedAt).toBeDefined();
    await w.night();
    expect(checkNotices(w)).toHaveLength(2);
  });

  it("reads as waiting for a check in a mission's one-line result, and as a pause once answered", async () => {
    const w = world();
    const parked = w.queueGreenfield("A parked app", "Build a parked app", ["plan"]);
    const night = await w.night();
    const waiting = night.missions[0] as Mission;
    expect(missionOutcome(waiting)).toBe("Waiting for your check, 0 of 2 features done");
    approve(w, parked.id);
    expect(missionOutcome(w.mission(parked.id))).toBe("Paused, continues on the next run, 0 of 2 features done");
  });

  it("stops at the owner's look in a change to an existing app as well, before the first test is written", async () => {
    const w = world();
    const repo = `${w.workspace}/existing`;
    await existingProject(repo);
    const m = w.queueFeature(repo, "Add greetings", "Add a greeting feature.", "main", ["plan"]);
    const night = await w.night();
    expect(night.missions[0]).toMatchObject({ id: m.id, status: "stopped", stage: "features" });
    expect(w.jobs.map(labelOf)).toEqual(["onboard", "spec", "gate-a"]);
    expect(w.mission(m.id).checkpoint).toMatchObject({ id: "plan#1", kind: "plan" });
  });
});
