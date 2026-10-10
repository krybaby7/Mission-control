import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  configPath,
  configTemplateYaml,
  defaultConfig,
  effectivePermissions,
  inContainer,
  loadConfig,
  otherFamily,
  parseRoleOverride,
  resolveFamily,
  resolveModel,
  validateConfig,
} from "./config.js";
import type { Config, Profile } from "./types.js";

const ENV_KEYS = ["MC_HOME", "MC_CONFIG", "MC_IN_CONTAINER"] as const;
let savedEnv: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "mc-config-test-"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(yamlText: string, name = "config.yaml"): string {
  const file = join(dir, name);
  writeFileSync(file, yamlText);
  return file;
}

/** The problems loadConfig reports for this YAML (fails the test if it loads cleanly). */
function loadError(yamlText: string): string {
  const file = writeConfig(yamlText);
  try {
    loadConfig(file);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected loadConfig to throw");
}

/** validateConfig on a default config changed by `edit` (which may break types on purpose). */
function problemsAfter(edit: (c: any) => void): string[] {
  const c = defaultConfig();
  edit(c);
  return validateConfig(c);
}

function expandedDefaults(): Config {
  const d = defaultConfig();
  return { ...d, home: join(homedir(), ".mission-control"), workspaceRoot: join(homedir(), "mc-apps") };
}

describe("defaultConfig", () => {
  it("has the exact values from the spec", () => {
    const c = defaultConfig();
    expect(c.version).toBe(1);
    expect(c.home).toBe("~/.mission-control");
    expect(c.workspaceRoot).toBe("~/mc-apps");
    expect(c.families).toEqual({
      claude: { provider: "claude", frontier: "claude-opus-5-5", standard: "claude-sonnet-5-5" },
      codex: { provider: "codex", frontier: "gpt-6-astra", standard: "gpt-6.1-sol" },
    });
    expect(c.light).toEqual({ provider: "claude", model: "claude-haiku-5-5" });
    expect([...c.allowedModels].sort()).toEqual(
      ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra", "gpt-6.1-sol"].sort(),
    );
    expect(c.defaultProfile).toBe("mixed");
    const all = (f: "claude" | "codex"): Profile => ({
      architect: f,
      engineer: f,
      test_author: f,
      reviewer: f,
      crossFamily: false,
    });
    expect(c.profiles).toEqual({
      claude: all("claude"),
      codex: all("codex"),
      mixed: { architect: "claude", engineer: "codex", test_author: "other", reviewer: "other", crossFamily: true },
    });
    expect(c.roles).toEqual({
      architect: { tier: "frontier", effort: "high" },
      test_author: { tier: "standard", effort: "high" },
      reviewer: { tier: "frontier", effort: "high" },
      scout: { tier: "light", effort: "low" },
    });
    expect(c.limits).toEqual({
      buildMaxTurns: 80,
      otherMaxTurns: 40,
      agentTimeoutMs: 45 * 60_000,
      verifyTimeoutMs: 20 * 60_000,
      maxReviewRounds: 2,
      maxGateCRounds: 1,
      maxAgentRunsPerMission: 150,
    });
    expect(c.failover).toEqual({ enabled: true });
    expect(c.pacing).toEqual({ maxFiveHourUtilization: 0.97, maxWeeklyUtilization: 0.85, maxWeeklySharePerNight: 0.35 });
    expect(c.notify).toEqual({ ntfyUrl: "" });
    expect(c.git).toEqual({ push: false, branchPrefix: "mc" });
    expect(c.permissions).toEqual({
      claudeWriteMode: "bypassPermissions",
      codexWriteSandbox: "danger-full-access",
      requireContainerForBypass: true,
    });
    expect(c.cli).toEqual({
      claudeCommand: "claude",
      codexCommand: "codex",
      claudeVersion: "2.1.295",
      codexVersion: "0.162.0",
    });
  });

  it("has the standard and mechanical ladders in order", () => {
    const b = (tier: string, effort: string, family: string) => ({ action: "build", tier, effort, family });
    const c = defaultConfig();
    expect(c.ladders.standard).toEqual([
      b("standard", "medium", "same"),
      b("standard", "high", "same"),
      { action: "diagnose" },
      b("frontier", "high", "other"),
      b("frontier", "high", "same"),
    ]);
    expect(c.ladders.mechanical).toEqual([
      b("light", "medium", "same"),
      b("standard", "medium", "same"),
      b("standard", "high", "same"),
      { action: "diagnose" },
      b("frontier", "high", "other"),
    ]);
  });

  it("is valid", () => {
    expect(validateConfig(defaultConfig())).toEqual([]);
  });

  it("returns a fresh object every call", () => {
    const a = defaultConfig();
    a.families.claude.frontier = "changed";
    a.allowedModels.push("changed");
    a.ladders.standard.length = 0;
    expect(defaultConfig().families.claude.frontier).toBe("claude-opus-5-5");
    expect(defaultConfig().allowedModels).not.toContain("changed");
    expect(defaultConfig().ladders.standard).toHaveLength(5);
  });
});

describe("configTemplateYaml", () => {
  it("parses to exactly defaultConfig()", () => {
    expect(parseYaml(configTemplateYaml())).toEqual(defaultConfig());
  });

  it("loads to the same config as a missing file", () => {
    const file = writeConfig(configTemplateYaml());
    expect(loadConfig(file)).toEqual(loadConfig(join(dir, "missing.yaml")));
  });

  it("explains itself with comments, including every top-level setting", () => {
    const text = configTemplateYaml();
    const lines = text.split("\n");
    expect(lines.filter((l) => l.trimStart().startsWith("#")).length).toBeGreaterThan(40);
    expect(text).toContain("mc doctor");
    expect(text).toContain("45 minutes");
    expect(text).toMatch(/Luna/);
    for (const key of Object.keys(defaultConfig())) {
      const at = lines.findIndex((l) => l.startsWith(`${key}:`));
      expect(at, key).toBeGreaterThan(0);
    }
    // Most top-level settings are introduced by a comment (section headers count).
    const commented = Object.keys(defaultConfig()).filter((key) => {
      const at = lines.findIndex((l) => l.startsWith(`${key}:`));
      return lines[at - 1]?.startsWith("#") || lines[at]?.includes(" # ");
    });
    expect(commented.length).toBeGreaterThanOrEqual(Object.keys(defaultConfig()).length - 2);
  });

  it("stays valid after editing a single value in place", () => {
    const edited = configTemplateYaml().replace(/^ {2}push: false/m, "  push: true");
    expect(edited).not.toBe(configTemplateYaml());
    const file = writeConfig(edited);
    expect(loadConfig(file).git.push).toBe(true);
  });
});

describe("configPath", () => {
  it("defaults to ~/.mission-control/config.yaml", () => {
    expect(configPath()).toBe(join(homedir(), ".mission-control", "config.yaml"));
  });

  it("uses $MC_HOME", () => {
    process.env.MC_HOME = dir;
    expect(configPath()).toBe(join(dir, "config.yaml"));
  });

  it("prefers $MC_CONFIG and expands ~", () => {
    process.env.MC_HOME = dir;
    process.env.MC_CONFIG = "~/elsewhere/mc.yaml";
    expect(configPath()).toBe(join(homedir(), "elsewhere", "mc.yaml"));
  });

  it("treats empty variables as unset", () => {
    process.env.MC_HOME = "";
    process.env.MC_CONFIG = "";
    expect(configPath()).toBe(join(homedir(), ".mission-control", "config.yaml"));
  });
});

describe("loadConfig", () => {
  it("returns the defaults, with ~ expanded, when the file is missing", () => {
    expect(loadConfig(join(dir, "nope.yaml"))).toEqual(expandedDefaults());
  });

  it("reads configPath() when no path is given", () => {
    process.env.MC_CONFIG = writeConfig("workspaceRoot: /srv/apps\n");
    expect(loadConfig().workspaceRoot).toBe("/srv/apps");
  });

  it("returns the defaults when the file $MC_CONFIG names is missing (before mc init)", () => {
    process.env.MC_CONFIG = join(dir, "not-yet.yaml");
    expect(loadConfig()).toEqual(expandedDefaults());
    expect(loadConfig(configPath())).toEqual(expandedDefaults());
  });

  it("returns the defaults when the file in the home folder is missing (the first run)", () => {
    process.env.MC_HOME = dir;
    expect(loadConfig()).toEqual({ ...expandedDefaults(), home: dir });
  });

  it("treats a link to a file that does not exist as a missing file", () => {
    const link = join(dir, "config.yaml");
    symlinkSync(join(dir, "gone.yaml"), link);
    expect(loadConfig(link)).toEqual(expandedDefaults());
  });

  it("reads the file a link points to", () => {
    const link = join(dir, "link.yaml");
    symlinkSync(writeConfig("git:\n  push: true\n", "real.yaml"), link);
    expect(loadConfig(link).git.push).toBe(true);
  });

  it("uses $MC_HOME as the home folder, even over the file", () => {
    process.env.MC_HOME = dir;
    expect(loadConfig().home).toBe(dir);
    writeConfig("home: /somewhere/else\n");
    expect(loadConfig().home).toBe(dir);
  });

  it("treats an empty or comment-only file as all defaults", () => {
    expect(loadConfig(writeConfig(""))).toEqual(expandedDefaults());
    expect(loadConfig(writeConfig("# nothing here yet\n"))).toEqual(expandedDefaults());
  });

  it("deep-merges partial sections over the defaults", () => {
    const c = loadConfig(
      writeConfig(`
limits:
  buildMaxTurns: 10
profiles:
  mixed:
    engineer: claude
families:
  codex:
    standard: gpt-6-astra
`),
    );
    expect(c.limits).toEqual({ ...defaultConfig().limits, buildMaxTurns: 10 });
    expect(c.profiles.mixed).toEqual({ ...defaultConfig().profiles.mixed, engineer: "claude" });
    expect(c.profiles.claude).toEqual(defaultConfig().profiles.claude);
    expect(c.families.codex).toEqual({ provider: "codex", frontier: "gpt-6-astra", standard: "gpt-6-astra" });
    expect(c.families.claude).toEqual(defaultConfig().families.claude);
  });

  it("replaces lists instead of merging them", () => {
    const c = loadConfig(
      writeConfig(`
allowedModels: [claude-opus-5-5, claude-sonnet-5-5, gpt-6-astra, gpt-6.1-sol, claude-haiku-5-5, extra-model]
ladders:
  standard:
    - { action: build, tier: frontier, effort: max, family: same }
`),
    );
    expect(c.allowedModels).toHaveLength(6);
    expect(c.ladders.standard).toEqual([{ action: "build", tier: "frontier", effort: "max", family: "same" }]);
    expect(c.ladders.mechanical).toEqual(defaultConfig().ladders.mechanical);
  });

  it("adds new profiles next to the built-in ones", () => {
    const c = loadConfig(
      writeConfig(`
defaultProfile: fast
profiles:
  fast: { architect: codex, engineer: claude, test_author: other, reviewer: codex, crossFamily: true }
`),
    );
    expect(c.defaultProfile).toBe("fast");
    expect(Object.keys(c.profiles).sort()).toEqual(["claude", "codex", "fast", "mixed"]);
  });

  it("keeps a section's defaults when it is left blank", () => {
    const c = loadConfig(writeConfig("notify:\nlimits:\n"));
    expect(c.notify).toEqual({ ntfyUrl: "" });
    expect(c.limits).toEqual(defaultConfig().limits);
  });

  it("unsets an optional value that is left blank", () => {
    const c = loadConfig(writeConfig("cli:\n  claudeVersion:\n"));
    expect(c.cli.claudeVersion).toBeUndefined();
    expect(c.cli.codexVersion).toBe("0.162.0");
  });

  it("reports a required value that is left blank", () => {
    expect(loadError("workspaceRoot:\n")).toMatch(/workspaceRoot is missing: it must be a full folder path/);
  });

  it("expands ~ in folders and commands", () => {
    const c = loadConfig(writeConfig("home: ~/mc\nworkspaceRoot: ~\ncli:\n  claudeCommand: ~/bin/claude\n"));
    expect(c.home).toBe(join(homedir(), "mc"));
    expect(c.workspaceRoot).toBe(homedir());
    expect(c.cli.claudeCommand).toBe(join(homedir(), "bin", "claude"));
    expect(c.cli.codexCommand).toBe("codex");
  });

  it("reads a bare ~ as the home folder for folders, not as a blank value", () => {
    expect(loadConfig(writeConfig("home: ~\n")).home).toBe(homedir());
    expect(loadConfig(writeConfig("workspaceRoot: ~\n")).workspaceRoot).toBe(homedir());
    expect(loadConfig(writeConfig('workspaceRoot: "~"\n')).workspaceRoot).toBe(homedir());
  });

  it("reads a bare ~ elsewhere as blank, like null", () => {
    const c = loadConfig(writeConfig("limits: ~\nnotify:\n  ntfyUrl: ~\ncli:\n  claudeVersion: ~\n"));
    expect(c.limits).toEqual(defaultConfig().limits);
    expect(c.notify.ntfyUrl).toBeUndefined();
    expect(c.cli.claudeVersion).toBeUndefined();
    expect(c.cli.codexVersion).toBe("0.162.0");
    expect(loadError("cli:\n  claudeCommand: ~\n")).toMatch(/cli\.claudeCommand is missing/);
  });

  it("lists every problem in one plain-language error", () => {
    const message = loadError(`
limits:
  buildMaxTurns: eighty
git:
  push: yes
`);
    expect(message).toContain(join(dir, "config.yaml"));
    expect(message).toContain("2 problems");
    expect(message).toContain('limits.buildMaxTurns must be a whole number greater than 0, but it is "eighty".');
    expect(message).toContain('git.push must be true or false, but it is "yes".');
    expect(message).toContain("mc doctor");
  });

  it("reports invalid YAML with its location", () => {
    const message = loadError("limits:\n  buildMaxTurns: 1\n  buildMaxTurns: 2\n");
    expect(message).toMatch(/not valid YAML/);
    expect(message).toMatch(/line 3/);
    expect(loadError("ladders: [\n")).toMatch(/not valid YAML/);
  });

  it("rejects a file that is not a group of settings", () => {
    expect(loadError("- one\n- two\n")).toMatch(/should contain named settings.*but it contains a list/);
    expect(loadError("just some words\n")).toMatch(/but it contains "just some words"/);
  });

  it("explains when the path is a folder", () => {
    const folder = join(dir, "folder.yaml");
    mkdirSync(folder);
    expect(() => loadConfig(folder)).toThrow(/is a folder, not a file/);
  });

  it("does not let __proto__ keys change any prototype", () => {
    const message = loadError("__proto__:\n  polluted: true\nlimits:\n  __proto__:\n    buildMaxTurns: 1\n");
    expect(message).toMatch(/__proto__ is not a setting Mission Control knows/);
    expect(message).toMatch(/limits\.__proto__ is not a setting/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reads plain YAML 1.2 values only, so YAML 1.1 tags cannot drop or disguise settings", () => {
    // Under YAML 1.1 these would be a Map, a Set, a Date and binary data, which used to merge as empty groups.
    expect(loadError("%YAML 1.1\n---\npermissions: !!omap [ claudeWriteMode: acceptEdits ]\n")).toMatch(
      /permissions must be a group of settings .*, but it is a list/,
    );
    expect(loadConfig(writeConfig("%YAML 1.1\n---\nlimits: !!set { buildMaxTurns: 10 }\n")).limits.buildMaxTurns).toBe(10);
    expect(loadError("%YAML 1.1\n---\nhome: 2001-12-14\n")).toMatch(/home must be a full folder path .*, but it is "2001-12-14"/);
    expect(loadError("families: !!binary aGVsbG8=\n")).toMatch(/families must be a group of settings .*, but it is "aGVsbG8="/);
    // YAML 1.1 booleans such as yes/no stay text, as in YAML 1.2.
    expect(loadError("%YAML 1.1\n---\ngit:\n  push: yes\n")).toMatch(/git\.push must be true or false, but it is "yes"/);
  });

  it("refuses YAML alias bombs", () => {
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 0; i < 8; i++) {
      const prev = String.fromCharCode(97 + i);
      const next = String.fromCharCode(98 + i);
      bomb.push(`${next}: &${next} [${Array(10).fill(`*${prev}`).join(", ")}]`);
    }
    expect(loadError(bomb.join("\n") + "\n")).toMatch(/not valid YAML/);
  });
});

describe("validateConfig", () => {
  it("rejects models that are not in allowedModels", () => {
    const problems = problemsAfter((c) => (c.families.codex.frontier = "gpt-7"));
    expect(problems).toEqual([expect.stringMatching(/^families\.codex\.frontier is "gpt-7", which is not in allowedModels/)]);
  });

  it("rejects Luna models anywhere, even when allowed", () => {
    const problems = problemsAfter((c) => {
      c.allowedModels.push("gpt-6-luna");
      c.families.codex.standard = "gpt-6-luna";
      c.light.model = "GPT-Luna-Mini";
    });
    expect(problems).toHaveLength(3);
    for (const p of problems) expect(p).toMatch(/Luna models are disabled by user preference/);
    expect(problems.join("\n")).toMatch(/allowedModels \(item 6\)/);
    expect(problems.join("\n")).toMatch(/families\.codex\.standard/);
    expect(problems.join("\n")).toMatch(/light\.model/);
  });

  it("requires a non-empty allowedModels list of names", () => {
    expect(problemsAfter((c) => (c.allowedModels = []))).toEqual([
      "allowedModels must be a list of one or more model names, but it is a list.",
    ]);
    expect(problemsAfter((c) => (c.allowedModels[1] = 5))).toContain(
      "allowedModels (item 2) must be a model name such as claude-sonnet-5-5, but it is 5.",
    );
  });

  it("does not check models against an allowedModels list with no usable names", () => {
    expect(problemsAfter((c) => (c.allowedModels = ["x-luna"]))).toEqual([
      'allowedModels (item 1) is "x-luna": Luna models are disabled by user preference.',
    ]);
    expect(problemsAfter((c) => (c.allowedModels = [7, ""]))).toHaveLength(2);
  });

  it("requires light work on Claude, allowing the mock provider in tests", () => {
    expect(problemsAfter((c) => (c.light.provider = "codex"))[0]).toMatch(/^light\.provider must be "claude"/);
    expect(problemsAfter((c) => (c.light.provider = "mock"))).toEqual([]);
  });

  it("requires each family to use its own provider (or mock)", () => {
    expect(problemsAfter((c) => (c.families.claude.provider = "codex"))).toEqual([
      'families.claude.provider must be "claude", but it is "codex".',
    ]);
    expect(problemsAfter((c) => (c.families.codex.provider = "mock"))).toEqual([]);
    expect(problemsAfter((c) => delete c.families.codex)).toEqual([
      "families.codex is missing: it must be a group of settings (provider, frontier, standard).",
    ]);
  });

  it("requires defaultProfile to name an existing profile", () => {
    expect(problemsAfter((c) => (c.defaultProfile = "fast"))).toEqual([
      'defaultProfile is "fast", but there is no profile with that name. Choose one of: claude, codex, mixed.',
    ]);
    // Names inherited from Object.prototype are not profiles.
    expect(problemsAfter((c) => (c.defaultProfile = "constructor"))).toHaveLength(1);
    expect(problemsAfter((c) => (c.profiles = {}))[0]).toMatch(/^profiles must be a group of one or more named entries/);
  });

  it("checks every profile field", () => {
    const problems = problemsAfter((c) => {
      c.profiles.mixed.engineer = "other";
      c.profiles.mixed.test_author = "gemini";
      c.profiles.mixed.crossFamily = "yes";
      delete c.profiles.codex.reviewer;
    });
    expect(problems).toEqual([
      'profiles.codex.reviewer is missing: it must be one of: claude, codex, other.',
      'profiles.mixed.engineer must be one of: claude, codex, but it is "other".',
      'profiles.mixed.test_author must be one of: claude, codex, other, but it is "gemini".',
      'profiles.mixed.crossFamily must be true or false, but it is "yes".',
    ]);
  });

  it("requires non-empty ladders of valid steps", () => {
    expect(problemsAfter((c) => (c.ladders.standard = []))).toEqual([
      "ladders.standard must be a list of one or more steps, but it is a list.",
    ]);
    const problems = problemsAfter((c) => {
      c.ladders.standard[0].tier = "huge";
      c.ladders.standard[1].effort = "ultra";
      c.ladders.standard[2] = { action: "think" };
      c.ladders.standard[3].family = "both";
      c.ladders.mechanical[3] = { action: "diagnose", tier: "frontier" };
      c.ladders.mechanical[4] = "build";
    });
    expect(problems).toEqual([
      'ladders.standard (step 1).tier must be one of: frontier, standard, light, but it is "huge".',
      expect.stringMatching(/^ladders\.standard \(step 2\)\.effort is "ultra", which Mission Control never uses/),
      'ladders.standard (step 3).action must be one of: build, diagnose, but it is "think".',
      'ladders.standard (step 4).family must be one of: same, other, but it is "both".',
      expect.stringMatching(/^ladders\.mechanical \(step 4\)\.tier is not a setting Mission Control knows/),
      expect.stringMatching(/^ladders\.mechanical \(step 5\) must be a step such as/),
    ]);
  });

  it("requires at least one build step in a ladder", () => {
    expect(problemsAfter((c) => (c.ladders.mechanical = [{ action: "diagnose" }]))).toEqual([
      "ladders.mechanical needs at least one build step: diagnose steps alone never change any code.",
    ]);
  });

  it("checks role tiers and efforts, never allowing ultra", () => {
    const problems = problemsAfter((c) => {
      c.roles.scout.tier = "tiny";
      c.roles.reviewer.effort = "ultra";
      c.roles.engineer = { tier: "frontier", effort: "high" };
    });
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^roles\.engineer is not a setting Mission Control knows.*architect, test_author, reviewer, scout/);
    expect(problems[1]).toMatch(/^roles\.reviewer\.effort is "ultra".*low, medium, high, xhigh, max/);
    expect(problems[2]).toBe('roles.scout.tier must be one of: frontier, standard, light, but it is "tiny".');
  });

  it("accepts utilization thresholds in (0, 1.5] only", () => {
    expect(problemsAfter((c) => (c.pacing.maxWeeklyUtilization = 1.5))).toEqual([]);
    expect(problemsAfter((c) => (c.pacing.maxWeeklyUtilization = 0.01))).toEqual([]);
    for (const bad of [0, -0.5, 1.51, "90%", Number.NaN]) {
      const problems = problemsAfter((c) => (c.pacing.maxFiveHourUtilization = bad));
      expect(problems, String(bad)).toHaveLength(1);
      expect(problems[0]).toMatch(/^pacing\.maxFiveHourUtilization must be a number above 0 and at most 1\.5/);
    }
  });

  it("accepts a per-night share of the weekly limit in (0, 1], or none", () => {
    expect(problemsAfter((c) => (c.pacing.maxWeeklySharePerNight = 1))).toEqual([]);
    expect(problemsAfter((c) => delete c.pacing.maxWeeklySharePerNight)).toEqual([]);
    for (const bad of [0, -0.1, 1.01, "35%", Number.NaN]) {
      const problems = problemsAfter((c) => ((c.pacing as Record<string, unknown>).maxWeeklySharePerNight = bad));
      expect(problems, String(bad)).toHaveLength(1);
      expect(problems[0]).toMatch(/^pacing\.maxWeeklySharePerNight must be a number above 0 and at most 1/);
    }
  });

  it("requires numeric limits to be positive whole numbers", () => {
    for (const bad of [0, -1, 1.5, "80", null]) {
      const problems = problemsAfter((c) => (c.limits.buildMaxTurns = bad));
      expect(problems, String(bad)).toHaveLength(1);
      expect(problems[0]).toMatch(/^limits\.buildMaxTurns (must be|is missing: it must be) a whole number greater than 0/);
    }
    const counts = Object.keys(defaultConfig().limits).filter((name) => !name.endsWith("TimeoutMs"));
    expect(counts).toHaveLength(5);
    for (const name of counts) {
      expect(problemsAfter((c) => (c.limits[name] = 0)), name).toEqual([
        expect.stringMatching(new RegExp(`^limits\\.${name} must be a whole number greater than 0`)),
      ]);
      expect(problemsAfter((c) => (c.limits[name] = 1)), name).toEqual([]);
    }
  });

  it("requires time limits in milliseconds, from 1 minute to the longest timer Node supports", () => {
    for (const name of ["agentTimeoutMs", "verifyTimeoutMs"]) {
      expect(problemsAfter((c) => (c.limits[name] = 60_000)), name).toEqual([]);
      expect(problemsAfter((c) => (c.limits[name] = 2_147_483_647)), name).toEqual([]);
      for (const bad of [0, 59_999, 2_147_483_648, 90_000.5, "45 minutes"]) {
        expect(problemsAfter((c) => (c.limits[name] = bad)), `${name}=${bad}`).toEqual([
          expect.stringMatching(
            new RegExp(`^limits\\.${name} must be a time in milliseconds from 60000 \\(1 minute\\) to 2147483647 \\(about 24 days\\)`),
          ),
        ]);
      }
    }
  });

  it("catches a time limit written in minutes or seconds instead of milliseconds", () => {
    const message = loadError("limits:\n  agentTimeoutMs: 45   # minutes\n  verifyTimeoutMs: 20\n");
    expect(message).toContain("2 problems");
    expect(message).toContain(
      "limits.agentTimeoutMs must be a time in milliseconds from 60000 (1 minute) to 2147483647 (about 24 days), " +
        "for example 2700000 for 45 minutes, but it is 45.",
    );
    expect(message).toMatch(/limits\.verifyTimeoutMs must be a time in milliseconds .*, but it is 20\./);
  });

  it("requires a simple branch prefix without /", () => {
    expect(problemsAfter((c) => (c.git.branchPrefix = "night-shift_1"))).toEqual([]);
    for (const bad of ["", "mc/x", "has space", "-x", "a..b", "x.lock", 7]) {
      const problems = problemsAfter((c) => (c.git.branchPrefix = bad));
      expect(problems, String(bad)).toHaveLength(1);
      expect(problems[0]).toMatch(/^git\.branchPrefix .*without "\/"/);
    }
  });

  it("checks the ntfy address only when one is set", () => {
    expect(problemsAfter((c) => (c.notify.ntfyUrl = "https://ntfy.sh/my-topic"))).toEqual([]);
    expect(problemsAfter((c) => delete c.notify.ntfyUrl)).toEqual([]);
    for (const bad of ["ntfy.sh/topic", "https://ntfy.sh", "https://ntfy.sh/", "ftp://ntfy.sh/topic", 42]) {
      const problems = problemsAfter((c) => (c.notify.ntfyUrl = bad));
      expect(problems, String(bad)).toHaveLength(1);
      expect(problems[0]).toMatch(/^notify\.ntfyUrl must be a web address with your topic/);
    }
  });

  it("checks permission modes", () => {
    const problems = problemsAfter((c) => {
      c.permissions.claudeWriteMode = "yolo";
      c.permissions.codexWriteSandbox = "read-only";
      c.permissions.requireContainerForBypass = "no";
    });
    expect(problems).toEqual([
      'permissions.claudeWriteMode must be one of: bypassPermissions, acceptEdits, auto, but it is "yolo".',
      'permissions.codexWriteSandbox must be one of: danger-full-access, workspace-write, but it is "read-only".',
      'permissions.requireContainerForBypass must be true or false, but it is "no".',
    ]);
  });

  it("checks the CLI commands and pinned versions", () => {
    const problems = problemsAfter((c) => {
      c.cli.claudeCommand = " ";
      c.cli.codexVersion = 0.162;
    });
    expect(problems).toEqual([
      'cli.claudeCommand must be the command that starts Claude Code: a name such as claude, or a full path such as ~/bin/claude, but it is " ".',
      'cli.codexVersion must be a version in quotes, such as "0.162.0", but it is 0.162.',
    ]);
    expect(problemsAfter((c) => delete c.cli.claudeVersion)).toEqual([]);
  });

  it("accepts command names and full paths, but not relative paths", () => {
    for (const ok of ["claude", "claude-2", "/usr/local/bin/claude", "~/bin/claude"]) {
      expect(problemsAfter((c) => (c.cli.claudeCommand = ok)), ok).toEqual([]);
    }
    for (const bad of ["./bin/claude", "bin/claude", "../claude"]) {
      expect(problemsAfter((c) => (c.cli.claudeCommand = bad)), bad).toEqual([
        `cli.claudeCommand must be the command that starts Claude Code: a name such as claude, or a full path such as ~/bin/claude, but it is "${bad}".`,
      ]);
    }
    expect(problemsAfter((c) => (c.cli.codexCommand = "tools/codex"))[0]).toMatch(
      /^cli\.codexCommand must be the command that starts Codex: a name such as codex, or a full path/,
    );
    expect(loadError("cli:\n  claudeCommand: ./bin/claude\n")).toMatch(/cli\.claudeCommand must be/);
  });

  it("checks the version and the folders", () => {
    expect(problemsAfter((c) => (c.version = 2))).toEqual(["version must be 1 (leave it as 1), but it is 2."]);
    expect(problemsAfter((c) => (c.home = "mc-home"))[0]).toMatch(/^home must be a full folder path/);
    expect(problemsAfter((c) => (c.workspaceRoot = "/abs/apps"))).toEqual([]);
  });

  it("reports unknown settings and suggests close spellings", () => {
    const problems = problemsAfter((c) => {
      c.workspaceroot = "~/x";
      c.limits.build_max_turns = 3;
      c.extra = true;
      c.families.gemini = { provider: "gemini" };
    });
    expect(problems).toEqual([
      "workspaceroot is not a setting Mission Control knows (check the spelling). Did you mean workspaceRoot?",
      expect.stringMatching(/^extra is not a setting Mission Control knows \(check the spelling\)\. Settings allowed here: version, /),
      "families.gemini is not a setting Mission Control knows (check the spelling). Settings allowed here: claude, codex.",
      "limits.build_max_turns is not a setting Mission Control knows (check the spelling). Did you mean limits.buildMaxTurns?",
    ]);
  });

  it("explains wrongly shaped sections instead of crashing", () => {
    const problems = problemsAfter((c) => {
      c.limits = 5;
      c.ladders = [];
      c.roles.architect = "frontier";
      c.families = null;
    });
    expect(problems).toEqual([
      expect.stringMatching(/^families is missing: it must be a group of settings \(claude, codex\)/),
      expect.stringMatching(/^ladders must be a group of settings \(standard, mechanical\), but it is a list/),
      expect.stringMatching(/^roles\.architect must be a group of settings \(tier, effort\), but it is "frontier"/),
      expect.stringMatching(/^limits must be a group of settings \(buildMaxTurns, .*\), but it is 5/),
    ]);
    expect(validateConfig(null as unknown as Config)[0]).toMatch(/^The settings must be named values/);
    expect(validateConfig([] as unknown as Config)[0]).toMatch(/but they are a list/);
  });

  it("does not treat dates, maps, sets or binary data as groups of settings", () => {
    const problems = problemsAfter((c) => {
      c.permissions = new Map([["claudeWriteMode", "acceptEdits"]]);
      c.limits = new Set(["a"]);
      c.families = new Uint8Array([1, 2]);
      c.home = new Date(0);
    });
    expect(problems).toEqual([
      "home must be a full folder path such as ~/mc-apps or /home/you/mc-apps, but it is a special value Mission Control cannot use.",
      expect.stringMatching(/^families must be a group of settings \(claude, codex\), but it is a special value/),
      expect.stringMatching(/^limits must be a group of settings .*, but it is a special value/),
      expect.stringMatching(/^permissions must be a group of settings .*, but it is a special value/),
    ]);
  });
});

describe("parseRoleOverride", () => {
  it("parses every documented form", () => {
    expect(parseRoleOverride("engineer=codex")).toEqual({ role: "engineer", family: "codex" });
    expect(parseRoleOverride("engineer=codex:frontier")).toEqual({ role: "engineer", family: "codex", tier: "frontier" });
    expect(parseRoleOverride("reviewer=claude:standard:high")).toEqual({
      role: "reviewer",
      family: "claude",
      tier: "standard",
      effort: "high",
    });
    expect(parseRoleOverride("engineer=frontier")).toEqual({ role: "engineer", tier: "frontier" });
  });

  it("accepts any order, effort alone, spaces, capitals and test-author", () => {
    expect(parseRoleOverride(" Test-Author = HIGH : codex ")).toEqual({ role: "test_author", family: "codex", effort: "high" });
    expect(parseRoleOverride("scout=max")).toEqual({ role: "scout", effort: "max" });
    expect(parseRoleOverride("architect=light")).toEqual({ role: "architect", tier: "light" });
  });

  it("rejects bad input with a plain explanation and examples", () => {
    const cases: [string, RegExp][] = [
      ["engineer", /write it as role=choice/],
      ["builder=codex", /"builder" is not a role\. Roles: architect, engineer, test_author, reviewer, scout/],
      ["engineer=", /something is missing/],
      ["engineer=codex:", /something is missing/],
      ["engineer=codex::high", /something is missing/],
      ["engineer=gemini", /"gemini" is not a family \(claude, codex\), a tier .* or an effort/],
      ["engineer=codex:claude", /more than one family/],
      ["engineer=frontier:standard", /more than one tier/],
      ["engineer=low:high", /more than one effort/],
      ["reviewer=other", /"other" only works inside a profile/],
      ["engineer=codex:ultra", /"ultra" effort is never used/],
    ];
    for (const [input, why] of cases) {
      expect(() => parseRoleOverride(input), input).toThrow(why);
      expect(() => parseRoleOverride(input), input).toThrow(/Examples: engineer=codex/);
    }
  });
});

describe("families and models", () => {
  const cross: Profile = defaultConfig().profiles.mixed!;
  const same: Profile = defaultConfig().profiles.claude!;

  it("otherFamily swaps claude and codex", () => {
    expect(otherFamily("claude")).toBe("codex");
    expect(otherFamily("codex")).toBe("claude");
  });

  it("resolveFamily maps other to the other family only in cross-family profiles", () => {
    expect(resolveFamily("other", "codex", cross)).toBe("claude");
    expect(resolveFamily("other", "claude", cross)).toBe("codex");
    expect(resolveFamily("other", "codex", same)).toBe("codex");
    expect(resolveFamily("claude", "claude", cross)).toBe("claude");
    expect(resolveFamily("codex", "claude", same)).toBe("codex");
  });

  it("resolveModel picks the family's model per tier", () => {
    const c = defaultConfig();
    expect(resolveModel(c, "claude", "frontier")).toEqual({ provider: "claude", model: "claude-opus-5-5" });
    expect(resolveModel(c, "claude", "standard")).toEqual({ provider: "claude", model: "claude-sonnet-5-5" });
    expect(resolveModel(c, "codex", "frontier")).toEqual({ provider: "codex", model: "gpt-6-astra" });
    expect(resolveModel(c, "codex", "standard")).toEqual({ provider: "codex", model: "gpt-6.1-sol" });
  });

  it("resolveModel always uses the light model for the light tier", () => {
    const c = defaultConfig();
    expect(resolveModel(c, "codex", "light")).toEqual({ provider: "claude", model: "claude-haiku-5-5" });
    expect(resolveModel(c, "claude", "light")).toEqual({ provider: "claude", model: "claude-haiku-5-5" });
  });

  it("resolveModel returns a copy that cannot change the config", () => {
    const c = defaultConfig();
    resolveModel(c, "codex", "light").model = "changed";
    expect(c.light.model).toBe("claude-haiku-5-5");
  });
});

describe("inContainer", () => {
  it("is true when MC_IN_CONTAINER=1", () => {
    expect(inContainer({ MC_IN_CONTAINER: "1" }, join(dir, "no-marker"))).toBe(true);
  });

  it("is true when the docker marker file exists", () => {
    const marker = join(dir, ".dockerenv");
    writeFileSync(marker, "");
    expect(inContainer({}, marker)).toBe(true);
  });

  it("is false otherwise", () => {
    expect(inContainer({}, join(dir, "no-marker"))).toBe(false);
    expect(inContainer({ MC_IN_CONTAINER: "0" }, join(dir, "no-marker"))).toBe(false);
  });

  it("reads process.env by default", () => {
    process.env.MC_IN_CONTAINER = "1";
    expect(inContainer()).toBe(true);
  });
});

describe("effectivePermissions", () => {
  it("keeps full autonomy inside a container as a normal user", () => {
    expect(effectivePermissions(defaultConfig(), true, false)).toEqual({
      claudeWriteMode: "bypassPermissions",
      codexWriteSandbox: "danger-full-access",
      downgraded: false,
    });
  });

  it("downgrades outside a container when required, and says why", () => {
    expect(effectivePermissions(defaultConfig(), false, false)).toEqual({
      claudeWriteMode: "auto",
      codexWriteSandbox: "workspace-write",
      downgraded: true,
      reason:
        'Claude uses "auto" instead of "bypassPermissions" and Codex uses "workspace-write" instead of ' +
        '"danger-full-access", because Mission Control is not running inside its container.',
    });
  });

  it("downgrades only Claude's bypass mode for root inside a container, and says why", () => {
    expect(effectivePermissions(defaultConfig(), true, true)).toEqual({
      claudeWriteMode: "auto",
      codexWriteSandbox: "danger-full-access",
      downgraded: true,
      reason:
        'Claude uses "auto" instead of "bypassPermissions", because Mission Control is running as root ' +
        "(Claude Code refuses bypassPermissions as root).",
    });
    const c = defaultConfig();
    c.permissions.claudeWriteMode = "acceptEdits";
    expect(effectivePermissions(c, true, true)).toEqual({
      claudeWriteMode: "acceptEdits",
      codexWriteSandbox: "danger-full-access",
      downgraded: false,
    });
  });

  it("names both causes when root runs outside a container", () => {
    const result = effectivePermissions(defaultConfig(), false, true);
    expect(result).toMatchObject({ claudeWriteMode: "auto", codexWriteSandbox: "workspace-write", downgraded: true });
    expect(result.reason).toMatch(/because Mission Control is not running inside its container and Mission Control is running as root/);
  });

  it("does not blame root when only Codex was downgraded", () => {
    const c = defaultConfig();
    c.permissions.claudeWriteMode = "acceptEdits";
    expect(effectivePermissions(c, false, true)).toEqual({
      claudeWriteMode: "acceptEdits",
      codexWriteSandbox: "workspace-write",
      downgraded: true,
      reason: 'Codex uses "workspace-write" instead of "danger-full-access", because Mission Control is not running inside its container.',
    });
  });

  it("does not require a container when the requirement is off, but still never bypasses as root", () => {
    const c = defaultConfig();
    c.permissions.requireContainerForBypass = false;
    expect(effectivePermissions(c, false, false)).toEqual({
      claudeWriteMode: "bypassPermissions",
      codexWriteSandbox: "danger-full-access",
      downgraded: false,
    });
    // Claude Code exits at startup in bypass mode as root, so every write run would fail.
    expect(effectivePermissions(c, false, true)).toEqual({
      claudeWriteMode: "auto",
      codexWriteSandbox: "danger-full-access",
      downgraded: true,
      reason:
        'Claude uses "auto" instead of "bypassPermissions", because Mission Control is running as root ' +
        "(Claude Code refuses bypassPermissions as root).",
    });
  });

  it("only reports a downgrade when something actually changed", () => {
    const c = defaultConfig();
    c.permissions.claudeWriteMode = "acceptEdits";
    c.permissions.codexWriteSandbox = "workspace-write";
    expect(effectivePermissions(c, false, true)).toEqual({
      claudeWriteMode: "acceptEdits",
      codexWriteSandbox: "workspace-write",
      downgraded: false,
    });
    expect(effectivePermissions(c, false, true)).not.toHaveProperty("reason");
  });

  it("detects the container and the user by default", () => {
    process.env.MC_IN_CONTAINER = "1";
    const asRoot = process.getuid?.() === 0;
    expect(effectivePermissions(defaultConfig())).toMatchObject({
      claudeWriteMode: asRoot ? "auto" : "bypassPermissions",
      codexWriteSandbox: "danger-full-access",
      downgraded: asRoot,
    });
  });
});
