// T-PLAN-REAL: a plan written outside the team, from the command line to the dashboard (docs/plans-spec.md, 10).
//
// The plan is queued through main() (`mc plan queue -`, the text arriving as the leader's here-document does), the mock team
// runs it to the plan stop, and the dashboard builds its snapshot from a copy of what the engine wrote. Then the owner
// answers through main() (`mc approve`), the team finishes, and the report and the plan code are checked. The last test
// pins which plan commands the leader may run without asking and which it must ask about.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliIO, main } from "../src/cli.js";
import { clearReadCache } from "../src/dashboard/read.js";
import { buildSnapshot } from "../src/dashboard/snapshot.js";
import type { NeedsYouCard, Snapshot } from "../src/dashboard/types.js";
import { assertSnapshotShape, copyHomeOf, hashTree } from "./dashboard-helpers.js";
import { MissionHarness } from "./fixtures/mission-harness.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A new app of two features, the ones the harness' mock team knows how to build (greet, then farewell). */
const PLAN = `mc-plan 1
name: Fixture app
request: Build a tiny app that answers.
app-name: Fixture App
summary: A tiny app used by tests.
assumption: Answers are plain strings.
contract: Each feature module has an answer function.

feature: greet
title: Feature greet
story: As a user I want greet.
check: answer in src/greet.mjs returns greet
check: answer in src/greet.mjs returns a string

feature: farewell
title: Feature farewell
story: As a user I want farewell.
needs: greet
check: answer in src/farewell.mjs returns farewell
check: answer in src/farewell.mjs does not return greet
`;

const CHECKS = [...PLAN.matchAll(/^check: (.*)$/gm)].map((m) => m[1] ?? "");

let h: MissionHarness;

beforeEach(() => {
  h = new MissionHarness(); // sets MC_HOME to the harness' home, which is where `mc` queues
  vi.stubEnv("MC_CONFIG", "");
  vi.stubEnv("MC_IN_CONTAINER", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  h.cleanup();
});

interface Said {
  code: number;
  out: string;
  err: string;
}

/** Runs `mc` as the command line does; `stdin` is what a here-document would send. */
async function mc(args: string[], stdin?: string): Promise<Said> {
  const said: Said = { code: 0, out: "", err: "" };
  const io: CliIO = { stdout: (t) => (said.out += t), stderr: (t) => (said.err += t), ...(stdin !== undefined && { stdin: async () => stdin }) };
  said.code = await main(["node", "mc", ...args], io);
  return said;
}

/** The dashboard's snapshot of a copy of the harness' home (the engine's own home is not touched). */
function snapshotOf(): Snapshot {
  const home = copyHomeOf(h.home);
  const before = hashTree(home);
  clearReadCache(); // the cache is keyed by inode and size; a new copy can reuse both
  const s = buildSnapshot({ home, now: Date.now(), timeZone: "UTC" });
  assertSnapshotShape(s);
  expect(hashTree(home), "the dashboard left the home as it found it").toBe(before);
  return s;
}

const cards = (s: Snapshot): NeedsYouCard[] => s.needsYou.filter((c) => c.kind === "checkpoint");

describe("a plan from the leader, from the command line to the dashboard", () => {
  it("is queued, stops at the plan with every check on show, is approved, and finishes with its plan code in the report", async () => {
    // Queue it: nothing is spent, and the mission holds the plan and the default stop.
    const queued = await mc(["plan", "queue", "-"], PLAN);
    expect(queued.code, queued.err).toBe(0);
    const id = /^Mission id: (\S+)$/m.exec(queued.out)?.[1] ?? "";
    const code = /^Plan code: ([0-9a-f]{8}) /m.exec(queued.out)?.[1] ?? "";
    expect(id).not.toBe("");
    expect(code).toHaveLength(8);
    expect(queued.out).toContain("It will stop for your check: the plan.");
    const waiting = h.load(id);
    expect(waiting).toMatchObject({ kind: "greenfield", stage: "spec", status: "queued", checkpoints: ["plan"] });
    expect(waiting.plan?.sha256.slice(0, 8)).toBe(code);
    expect(h.jobs).toEqual([]);

    // Run: the team's planner is skipped, the plan reviewer reads the plan, and the team stops for the owner's look.
    const parked = await h.run(id);
    expect(h.jobs.map((j) => j.id.replace(/-\d+$/, ""))).toEqual(["gate-a"]);
    expect(parked).toMatchObject({ status: "stopped", checkpoint: { kind: "plan", state: "pending" }, plan: { review: { outcome: "approved" } } });
    const look = parked.checkpoint?.look.lines ?? [];
    expect(look[0]).toBe("This plan was written by the leader, not by the team's planner.");
    // Every check is a line of the look, word for word, under the name of its feature.
    const titles = ["Feature greet", "Feature greet", "Feature farewell", "Feature farewell"];
    CHECKS.forEach((check, i) => expect(look, check).toContain(`Check for “${titles[i]}”: ${check}`));

    // `mc plan show` prints the same plan, whole, with the code the queue printed.
    const shown = await mc(["plan", "show", id]);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain(`Written by the leader. Plan code ${code} `);
    for (const check of CHECKS) expect(shown.out, check).toContain(`- ${check}`);

    // The report's first lines say who wrote the plan and how to read all of it, before the lines of the plan itself.
    const preview = (await mc(["report", id])).out.split("\n");
    const first = preview.slice(0, 40).join("\n");
    expect(first).toContain(`Plan: written by the leader (plan code ${code}); the team's plan reviewer asked for no changes.`);
    expect(first).toContain(`because the leader wrote this plan, and you look at such a plan first. Read all of it with: mc plan show ${id}.`);
    expect(first).toContain(`mc approve ${id}`);
    expect(h.notifications.at(-1)?.message).toContain(`Read all of it with: mc plan show ${id}.`);

    // The dashboard: one card, one lamp reason, one timeline line, worded for a plan the leader wrote.
    const s = snapshotOf();
    const [card, ...others] = cards(s);
    expect(others).toEqual([]);
    expect(s.needsYou).toHaveLength(1);
    expect(card).toMatchObject({
      kind: "checkpoint",
      severity: "look",
      missionId: id,
      title: "“Fixture app”: please check the plan",
      happened: expect.objectContaining({ text: "The team stopped here because the leader wrote this plan, and you look at it first." }),
      summary: "Nothing is built yet. Ask the leader to show you every check of the plan, word for word. The owner can also print all of it at the PC.",
    });
    // The card holds the first lines of the look, as the engine wrote them; it is not the place for the whole plan.
    expect(card?.lines?.map((l) => l.text)).toEqual(look.slice(0, 12));
    expect(s.missions[0]).toMatchObject({ id, state: "paused", pausedWhy: "checkpoint", sentence: "Waiting for your check of the plan." });
    expect(s.lamp).toMatchObject({ state: "needs_look", word: "Needs a look" });
    expect(s.lamp.reasons.filter((r) => r.code === "checkpoint_waiting")).toHaveLength(1);
    expect(s.timeline.items.at(-1)).toMatchObject({ missionId: id, tone: "warn", text: "Waiting for your check of the plan for “Fixture app”." });
    // The page never carries the plan itself: only that there is one, blank, for the card's wording.
    expect(JSON.stringify(s)).not.toContain(code);

    // The owner approves through the command line; the team builds both features, checks the whole app and is done.
    const approved = await mc(["approve", id]);
    expect(approved.code, approved.err).toBe(0);
    const done = await h.run(id);
    expect(done).toMatchObject({ status: "done", stage: "complete" });
    expect(h.jobsLabeled("gate-a")).toHaveLength(1);
    expect(h.jobsLabeled("gate-c")).toHaveLength(1); // a plan mission gets the review of the whole app like any other
    expect(h.jobsLabeled("spec")).toHaveLength(0);
    expect(done.plan?.sha256.slice(0, 8)).toBe(code); // the plan the leader wrote is kept as it was
    expect(done.features.map((f) => f.status)).toEqual(["done", "done"]);
    expect(readFileSync(h.store.reportPath(id), "utf8")).toContain(`Plan: written by the leader (plan code ${code});`);

    const end = snapshotOf();
    expect(cards(end)).toEqual([]);
    expect(end.missions[0]).toMatchObject({ id, state: "done" });
  });

  it("changes nothing for a mission queued the old way: the same words, no plan anywhere", async () => {
    const id = h.createMission("greenfield", { checkpoints: ["plan"] }).id;
    const parked = await h.run(id);
    expect(parked.checkpoint?.look.lines[0]).not.toContain("leader");
    expect("plan" in parked).toBe(false);
    const s = snapshotOf();
    expect(cards(s)[0]).toMatchObject({
      happened: expect.objectContaining({ text: "The team stopped here because you asked to look at it first." }),
      summary: "Nothing is built yet. The report has the whole plan.",
    });
    const report = readFileSync(h.store.reportPath(id), "utf8");
    expect(report).not.toContain("Plan: written by the leader");
    expect(report).toContain(`because you asked to look at the plan first.`);
    expect(JSON.stringify(h.load(id))).not.toContain('"plan":{');
  });
});

describe("what the leader may run on its own", () => {
  it("reads plans without asking, asks before it queues one, and still cannot write files or run git", () => {
    const settings = JSON.parse(readFileSync(join(ROOT, "leader", ".claude", "settings.json"), "utf8")) as { permissions: { allow: string[]; ask: string[]; deny: string[] } };
    const wrapper = (command: string): string => `Bash(../scripts/mc-docker.sh ${command}:*)`;
    const { allow, ask, deny } = settings.permissions;
    expect(allow).toEqual(["status", "logs", "report", "plan preview", "plan show"].map(wrapper));
    expect(ask).toEqual(["stop", "new", "feature", "plan queue", "run", "approve", "send-back"].map(wrapper));
    // `plan queue` is asked about and never allowed, whatever order the rules are in; the files and git stay out of reach.
    expect(allow.some((rule) => rule.includes("plan queue"))).toBe(false);
    expect(deny).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit", "Bash(git:*)"]));
  });
});
