// A stored way of checking that is not one of the known words fails closed (docs/modes-spec.md, M4 and the review of Wave 2).
//
// `mode` is `review` or `owner`, or absent; `effort` is `light` or `deep`, or absent. A mission file that holds anything else (a
// hand edit, a damaged file, a file from another version) used to be read as "checked by reading" with no stop for the owner and no
// tests, and the report said it was checked by a second AI. Now such a file is refused when it is loaded, in plain words, and
// `mc status` names it, so a mission that will not run is never a mystery. The control cases show that the known words still load.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionHarness, checkerBehavior, planSource } from "../test/fixtures/mission-harness.js";
import { isModeFeature } from "./checked-by.js";
import { type CliIO, main } from "./cli.js";
import { MissionStore, planOf } from "./state.js";
import type { Mission } from "./types.js";

// ───────────────────────────── The store ─────────────────────────────

let home: string;
let store: MissionStore;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mc-damaged-"));
  store = new MissionStore(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const NOW = new Date(2026, 9, 9, 14, 30, 0).getTime();

const FEATURE = { id: "guide", title: "Guide", story: "As a reader I can read it.", acceptance: ["It says how to start."], kind: "standard", deps: [] };

/** A queued mission whose features, spec and plan all hold the feature `guide` with the given extra keys. */
function written(extra: Record<string, unknown>): string {
  const m = store.createMission({ kind: "greenfield", title: "Guide app", request: "Write a guide", repoPath: "", baseBranch: "main", profile: "mixed", nowMs: NOW });
  const spec = { appName: "Guide app", summary: "A guide.", features: [{ ...FEATURE, ...extra }], assumptions: [], uiContract: "" };
  const raw = { ...JSON.parse(readFileSync(join(store.missionDir(m.id), "mission.json"), "utf8")), features: [], spec, plan: { sha256: "a".repeat(64), at: new Date(NOW).toISOString(), spec } };
  writeFileSync(join(store.missionDir(m.id), "mission.json"), JSON.stringify(raw));
  return m.id;
}

/** Puts `extra` into the one feature of each of the three places that can hold it. */
function inPlace(m: string, place: "features" | "spec.features" | "plan.spec.features", extra: Record<string, unknown>): void {
  const file = join(store.missionDir(m), "mission.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  const feature = { ...FEATURE, ...extra };
  if (place === "features") raw.features = [{ ...feature, status: "pending", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] }];
  else if (place === "spec.features") raw.spec.features = [feature];
  else raw.plan.spec.features = [feature];
  writeFileSync(file, JSON.stringify(raw));
}

const ODD_MODES: [string, unknown][] = [
  ["null", null],
  ["a number", 5],
  ["true", true],
  ["an empty string", ""],
  ["Owner", "Owner"],
  ["OWNER", "OWNER"],
  ["owner with a space", "owner "],
  ["a list", ["owner"]],
  ["an object", { x: 1 }],
  ["tests", "tests"],
];
const PLACES = ["features", "spec.features", "plan.spec.features"] as const;

describe("a stored mode or effort that is not a known word", () => {
  it.each(PLACES.flatMap((place) => ODD_MODES.map(([name, value]) => [place, name, value] as const)))("is refused at %s when mode is %s", (place, _name, value) => {
    const id = written({});
    inPlace(id, place, { mode: value });
    expect(() => store.load(id)).toThrow(`is not a valid mission file (bad or missing ${place}[0].mode)`);
    expect(store.list()).toEqual([]);
    expect(store.damaged()).toEqual([{ id, reason: `its file is not a valid mission file (bad or missing ${place}[0].mode)` }]);
  });

  it.each(PLACES.flatMap((place) => [null, "deep ", "Light", 2, "standard", "tests", ["light"]].map((value) => [place, value] as const)))("is refused at %s when effort is %j", (place, value) => {
    const id = written({});
    inPlace(id, place, { mode: "review", effort: value });
    expect(() => store.load(id)).toThrow(`(bad or missing ${place}[0].effort)`);
  });

  it.each(PLACES.flatMap((place) => [["review", "light"], ["review", "deep"], ["owner", "deep"], ["owner", undefined], [undefined, "deep"], [undefined, undefined]].map(([mode, effort]) => [place, mode, effort] as const)))(
    "still loads at %s with mode %j and effort %j",
    (place, mode, effort) => {
      const id = written({});
      inPlace(id, place, { ...(mode !== undefined && { mode }), ...(effort !== undefined && { effort }) });
      expect(store.load(id).id).toBe(id);
      expect(store.damaged()).toEqual([]);
    },
  );

  it("names the first damaged place and says nothing about a folder with no file", () => {
    const id = written({});
    inPlace(id, "plan.spec.features", { mode: "Owner" });
    inPlace(id, "features", { mode: 7 });
    mkdirSync(join(home, "missions", "half-made"), { recursive: true });
    expect(store.damaged().map((d) => d.id)).toEqual([id]);
    expect(() => store.load(id)).toThrow("(bad or missing features[0].mode)");
  });

  it("makes a plan with an odd mode count as no plan for the code that reads it without loading", () => {
    const id = written({ mode: "owner" });
    const ok = JSON.parse(readFileSync(join(store.missionDir(id), "mission.json"), "utf8")) as Mission;
    expect(planOf(ok)?.spec.features[0]?.mode).toBe("owner");
    const odd = structuredClone(ok);
    (odd.plan!.spec.features[0] as { mode: unknown }).mode = "OWNER";
    expect(planOf(odd)).toBeUndefined();
  });

  it("is never read as a way of checking by the rest of the engine", () => {
    for (const [, value] of ODD_MODES) expect(isModeFeature({ mode: value as never })).toBe(false);
    expect(isModeFeature({ mode: "review" })).toBe(true);
    expect(isModeFeature({ mode: "owner" })).toBe(true);
    expect(isModeFeature({})).toBe(false);
  });
});

// ───────────────────────────── The command line ─────────────────────────────

describe("what the owner sees", () => {
  let root: string;
  let out = "";
  let err = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-damaged-cli-"));
    vi.stubEnv("MC_HOME", join(root, "home"));
    vi.stubEnv("MC_CONFIG", "");
    vi.stubEnv("MC_IN_CONTAINER", "");
    vi.stubEnv("HOME", join(root, "user-home"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const mc = async (args: string[]): Promise<number> => {
    out = "";
    err = "";
    const io: CliIO = { stdout: (t) => (out += t), stderr: (t) => (err += t) };
    return main(["node", "mc", ...args], io);
  };

  it("mc status names the mission it left out, and prints nothing new when every file can be used", async () => {
    const s = new MissionStore(join(root, "home"));
    expect(await mc(["status"])).toBe(0);
    expect(out).toBe('No missions yet. Queue one with: mc new "<your idea>"\n');

    const m = s.createMission({ kind: "greenfield", title: "Guide app", request: "Write a guide", repoPath: "", baseBranch: "main", profile: "mixed", nowMs: NOW });
    expect(await mc(["status"])).toBe(0);
    expect(out).not.toContain("left out");

    const file = join(s.missionDir(m.id), "mission.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...raw, features: [{ ...FEATURE, mode: "Owner", status: "pending", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] }] }));
    expect(await mc(["status"])).toBe(0);
    expect(out).toBe(`${m.id} was left out of this list and will not run: its file is not a valid mission file (bad or missing features[0].mode). Fix its file or remove its folder.\n`);
    expect(await mc(["status", "--json"])).toBe(0);
    expect(JSON.parse(out)).toEqual([]);
  });
});

// ───────────────────────────── The mock team ─────────────────────────────

describe("a run of the mock team on a plan whose stored mode was damaged", () => {
  let h: MissionHarness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });
  const PLAN = `mc-plan 1
name: Fixture app
request: Write the documents of the fixture app.
app-name: Fixture App
summary: Documents for the fixture app.
assumption: The documents are in English.

feature: guide
title: Setup guide
story: As a reader I can follow a short guide.
mode: owner
check: The guide says how to start the app.
check: The guide says what the reader should see.
`;

  it.each(ODD_MODES)("refuses to start when the plan's mode is %s: nothing is built, nothing is checked, no stop is skipped", async (_name, value) => {
    h = new MissionHarness({ agents: { reviewer: (job, call) => (call.label.startsWith("review-") ? checkerBehavior(job) : h!.defaults.reviewer(job, call)) } });
    const id = h.createMission("greenfield", { plan: planSource(PLAN) }).id;
    const file = join(h.store.missionDir(id), "mission.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { plan: { spec: { features: { mode: unknown }[] } } };
    raw.plan.spec.features[0]!.mode = value;
    writeFileSync(file, JSON.stringify(raw));
    await expect(h.run(id)).rejects.toThrow("is not a valid mission file (bad or missing plan.spec.features[0].mode)");
    expect(h.jobs).toEqual([]);
  });

  it("control: the word owner stops for the owner, as before", async () => {
    h = new MissionHarness({ agents: { reviewer: (job, call) => (call.label.startsWith("review-") ? checkerBehavior(job) : h!.defaults.reviewer(job, call)) } });
    const id = h.createMission("greenfield", { plan: planSource(PLAN) }).id;
    const m = await h.run(id);
    expect(m.checkpoint).toMatchObject({ kind: "feature", featureId: "guide", state: "pending" });
  });
});
