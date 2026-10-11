// T-FIXTURE: the dashboard's fixtures are complete mini homes of json and jsonl files, with no path of the machine they
// were captured on and no secret (docs/dashboard-spec.md, 14.4).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_ROOT } from "./dashboard-helpers.js";
import { fixtureNames } from "./dashboard-kit.js";

interface Entry {
  synthetic: boolean;
  source: string;
  pins?: string;
}

const provenance = JSON.parse(readFileSync(join(FIXTURE_ROOT, "PROVENANCE.json"), "utf8")) as { engineCommit: string; fixtures: Record<string, Entry>; honestLimits: string[]; reductions: string[] };

/** Files that are not valid JSON on purpose, because the dashboard has to cope with them. */
const BROKEN_ON_PURPOSE = ["quota-corrupt/quota.json", "unreadable-mission/missions/2026-10-11-broken/mission.json"];

/** Where the captures were made and run: none of it may remain in a fixture. ("capture" alone is also a feature name.) */
const FORBIDDEN = ["/tmp/", "claude-0", "/root", "/home/user", "scratchpad", "/capture/", "capture/home"];

/** The one made-up token, in dispatch-with-secret, so a test can prove it never reaches the snapshot. */
const SENTINEL = "ghp_FAKE0123456789SENTINEL";

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

const fixtureFiles = fixtureNames().flatMap((name) => filesUnder(join(FIXTURE_ROOT, name)));

function parses(path: string, text: string): boolean {
  try {
    if (path.endsWith(".jsonl")) {
      for (const line of text.split("\n")) if (line.trim() !== "") JSON.parse(line);
    } else {
      JSON.parse(text);
    }
    return true;
  } catch {
    return false;
  }
}

describe("T-FIXTURE: the committed fixtures", () => {
  it("holds only .json and .jsonl files (and nothing a capture left behind)", () => {
    const stray = filesUnder(FIXTURE_ROOT).filter((f) => !/\.jsonl?$/.test(f));
    expect(stray.map((f) => relative(FIXTURE_ROOT, f))).toEqual([]);
    expect(fixtureFiles.length).toBeGreaterThan(100);
  });

  it("holds no report, log, guard, worktree or screenshot folder", () => {
    const names = new Set(filesUnder(FIXTURE_ROOT).flatMap((f) => relative(FIXTURE_ROOT, f).split("/")));
    for (const bad of ["reports", "logs", "guards", "worktrees", "report.md"]) expect(names.has(bad)).toBe(false);
  });

  it("every file is valid JSON, except the ones that are broken on purpose", () => {
    const invalid = fixtureFiles.map((f) => relative(FIXTURE_ROOT, f)).filter((f) => !parses(f, readFileSync(join(FIXTURE_ROOT, f), "utf8")));
    expect(invalid.sort()).toEqual([...BROKEN_ON_PURPOSE].sort());
  });

  it("no file holds a path of the machine it was captured on", () => {
    for (const file of fixtureFiles) {
      const text = readFileSync(file, "utf8");
      for (const bad of FORBIDDEN) expect(text, `${relative(FIXTURE_ROOT, file)} contains "${bad}"`).not.toContain(bad);
    }
  });

  it("no file holds a secret, except the made-up token of dispatch-with-secret", () => {
    for (const file of fixtureFiles) {
      const text = readFileSync(file, "utf8").split(SENTINEL).join("");
      expect(text, relative(FIXTURE_ROOT, file)).not.toMatch(/\b(?:ghp|gho|ghs|github_pat|sk|xox[bp]|AKIA)[_-][A-Za-z0-9_]{12,}/);
      if (!file.includes("dispatch-with-secret")) expect(text, relative(FIXTURE_ROOT, file)).not.toMatch(/https?:\/\/[^\s"]*:[^\s"@]*@/);
    }
    const withSentinel = fixtureFiles.filter((f) => readFileSync(f, "utf8").includes(SENTINEL)).map((f) => relative(FIXTURE_ROOT, f));
    expect(withSentinel).toEqual(["dispatch-with-secret/missions/2026-10-11-habit-tracker/dispatch.json"]);
  });

  it("every dispatch.json is reduced to what the dashboard reads, except the one that tests the reduction", () => {
    for (const file of fixtureFiles.filter((f) => f.endsWith("dispatch.json"))) {
      const rel = relative(FIXTURE_ROOT, file);
      const keys = Object.keys(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>);
      if (rel.startsWith("dispatch-with-secret/")) expect(keys).toEqual(expect.arrayContaining(["units", "gitSettings", "finalVerify"]));
      else expect(keys.filter((k) => k !== "finalVerify" && k !== "inflight"), rel).toEqual([]);
    }
  });

  it("every mission file sits in the folder of its id", () => {
    for (const file of fixtureFiles.filter((f) => f.endsWith("/mission.json") && !BROKEN_ON_PURPOSE.includes(relative(FIXTURE_ROOT, f)))) {
      const mission = JSON.parse(readFileSync(file, "utf8")) as { id: string; repoPath: string; integrationWorktree?: string };
      expect(file.split("/").at(-2), relative(FIXTURE_ROOT, file)).toBe(mission.id);
      for (const path of [mission.repoPath, mission.integrationWorktree ?? ""]) expect(path === "" || path.startsWith("/fixture/"), path).toBe(true);
    }
  });

  it("every fixture is a mini home: a folder of missions or a quota file", () => {
    for (const name of fixtureNames()) {
      const top = readdirSync(join(FIXTURE_ROOT, name));
      expect(top.some((t) => t === "missions" || t === "quota.json"), name).toBe(true);
    }
  });
});

describe("T-FIXTURE: the provenance", () => {
  it("names the engine commit the captures were made on and says what they cannot show", () => {
    expect(provenance.engineCommit).toBe("8342744");
    expect(provenance.honestLimits.join(" ")).toMatch(/scripted/);
    expect(provenance.honestLimits.join(" ")).toMatch(/usage reading/);
    expect(provenance.reductions.join(" ")).toMatch(/dispatch\.json/);
  });

  it("lists every fixture folder and no folder that is not there", () => {
    expect(Object.keys(provenance.fixtures).sort()).toEqual(fixtureNames());
  });

  it("says for every fixture whether it is authentic or made by hand, where it is from and what it pins", () => {
    for (const [name, entry] of Object.entries(provenance.fixtures)) {
      expect(typeof entry.synthetic, name).toBe("boolean");
      expect(entry.source.length, name).toBeGreaterThan(10);
      expect(entry.pins?.length ?? 0, name).toBeGreaterThan(5);
    }
  });

  it("the authentic fixtures are the ones of spec 14.1, and every other is marked synthetic", () => {
    const authentic = Object.entries(provenance.fixtures)
      .filter(([, e]) => !e.synthetic)
      .map(([name]) => name)
      .sort();
    expect(authentic).toEqual(["done", "failed-auth", "limit-then-done", "limit-waiting", "midrun-building", "midrun-reviewing", "midrun-testing", "multi-mission", "partial-blocked"]);
  });
});
