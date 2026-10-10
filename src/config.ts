// Configuration: built-in defaults, the commented YAML template, loading + validation,
// and the small family/model/permission resolvers every other module relies on.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isScalar, parseDocument } from "yaml";
import type { Config, Effort, Family, FamilyChoice, ModelRef, Profile, Role, RoleOverride, Rung, Tier } from "./types.js";
import { expandHome } from "./util/fs.js";

type ClaudeWriteMode = Config["permissions"]["claudeWriteMode"];
type CodexWriteSandbox = Config["permissions"]["codexWriteSandbox"];

const FAMILIES = ["claude", "codex"] as const satisfies readonly Family[];
const FAMILY_CHOICES = ["claude", "codex", "other"] as const satisfies readonly FamilyChoice[];
const TIERS = ["frontier", "standard", "light"] as const satisfies readonly Tier[];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly Effort[];
const ROLES = ["architect", "engineer", "test_author", "reviewer", "scout"] as const satisfies readonly Role[];
const CLAUDE_WRITE_MODES = ["bypassPermissions", "acceptEdits", "auto"] as const satisfies readonly ClaudeWriteMode[];
const CODEX_WRITE_SANDBOXES = ["danger-full-access", "workspace-write"] as const satisfies readonly CodexWriteSandbox[];

const DEFAULT_HOME = "~/.mission-control";
const FOLDER_SETTINGS = ["home", "workspaceRoot"] as const;
const DOCKERENV = "/.dockerenv";
/** Node timers overflow (and fire immediately) above this many milliseconds. */
const MAX_TIMER_MS = 2_147_483_647;
/** No agent or test run finishes in under a minute; a smaller value is a time written in minutes or seconds. */
const MIN_TIMER_MS = 60_000;

// ───────────────────────────── Defaults and template ─────────────────────────────

export function defaultConfig(): Config {
  const families: Config["families"] = {
    claude: { provider: "claude", frontier: "claude-opus-5-5", standard: "claude-sonnet-5-5" },
    codex: { provider: "codex", frontier: "gpt-6-astra", standard: "gpt-6.1-sol" },
  };
  const light: ModelRef = { provider: "claude", model: "claude-haiku-5-5" };
  return {
    version: 1,
    home: DEFAULT_HOME,
    workspaceRoot: "~/mc-apps",
    families,
    light,
    allowedModels: [
      families.claude.frontier,
      families.claude.standard,
      families.codex.frontier,
      families.codex.standard,
      light.model,
    ],
    defaultProfile: "mixed",
    profiles: {
      claude: singleFamilyProfile("claude"),
      codex: singleFamilyProfile("codex"),
      mixed: { architect: "claude", engineer: "codex", test_author: "other", reviewer: "other", crossFamily: true },
    },
    ladders: {
      standard: [
        buildRung("standard", "medium", "same"),
        buildRung("standard", "high", "same"),
        { action: "diagnose" },
        buildRung("frontier", "high", "other"),
        buildRung("frontier", "high", "same"),
      ],
      mechanical: [
        buildRung("light", "medium", "same"),
        buildRung("standard", "medium", "same"),
        buildRung("standard", "high", "same"),
        { action: "diagnose" },
        buildRung("frontier", "high", "other"),
      ],
    },
    roles: {
      architect: { tier: "frontier", effort: "high" },
      test_author: { tier: "standard", effort: "high" },
      reviewer: { tier: "frontier", effort: "high" },
      scout: { tier: "light", effort: "low" },
    },
    limits: {
      buildMaxTurns: 80,
      otherMaxTurns: 40,
      agentTimeoutMs: 45 * 60_000,
      verifyTimeoutMs: 20 * 60_000,
      maxReviewRounds: 2,
      maxGateCRounds: 1,
      maxAgentRunsPerMission: 150,
    },
    failover: { enabled: true },
    pacing: { maxFiveHourUtilization: 0.97, maxWeeklyUtilization: 0.85 },
    notify: { ntfyUrl: "" },
    git: { push: false, branchPrefix: "mc" },
    permissions: {
      claudeWriteMode: "bypassPermissions",
      codexWriteSandbox: "danger-full-access",
      requireContainerForBypass: true,
    },
    cli: { claudeCommand: "claude", codexCommand: "codex", claudeVersion: "2.1.295", codexVersion: "0.162.0" },
  };
}

function singleFamilyProfile(family: Family): Profile {
  return { architect: family, engineer: family, test_author: family, reviewer: family, crossFamily: false };
}

function buildRung(tier: Tier, effort: Effort, family: "same" | "other"): Rung {
  return { action: "build", tier, effort, family };
}

/** The file `mc init` writes. Parsing it yields exactly defaultConfig() (enforced by the tests). */
export function configTemplateYaml(): string {
  return CONFIG_TEMPLATE;
}

const CONFIG_TEMPLATE = `# Mission Control settings
#
# This file controls how Mission Control works while you sleep.
# Lines that start with "#" are notes for you; Mission Control ignores them.
#
# How to edit this file safely:
#   - Change only the value after the colon, for example  push: false  ->  push: true
#   - Keep the spaces at the start of each line exactly as they are.
#   - Delete a setting to go back to its built-in default.
#   - After saving, run "mc doctor" to check that everything is fine.

# Format version of this file. Leave it as 1.
version: 1

# Where Mission Control keeps its records: missions, logs, reports and the STOP file.
# "~" means your home folder. The MC_HOME environment variable, when set, replaces this setting.
home: ~/.mission-control

# Folder where new apps are created, one sub-folder per app.
workspaceRoot: ~/mc-apps


# ---------------------------------------------------------------------------
# AI models
# ---------------------------------------------------------------------------

# Two families of AI agents do the work: Claude (Anthropic) and Codex (OpenAI).
#   frontier = the strongest model (slower, uses the most of your plan)
#   standard = fast and capable, used for most of the work
families:
  claude:
    provider: claude
    frontier: claude-opus-5-5
    standard: claude-sonnet-5-5
  codex:
    provider: codex
    frontier: gpt-6-astra
    standard: gpt-6.1-sol

# Quick helper jobs (file lists, failure summaries, the morning report text)
# always use this small Claude model.
light:
  provider: claude
  model: claude-haiku-5-5

# Safety list: Mission Control refuses to run any model that is not listed here.
# Luna models are never allowed.
allowedModels:
  - claude-opus-5-5
  - claude-sonnet-5-5
  - gpt-6-astra
  - gpt-6.1-sol
  - claude-haiku-5-5


# ---------------------------------------------------------------------------
# Who does what
# ---------------------------------------------------------------------------

# A profile decides which family plays each role:
#   architect   - plans the app and checks the plan
#   engineer    - writes the code
#   test_author - writes the tests that prove a feature works, before it is built
#   reviewer    - checks the finished code
# "other" means "the family that did NOT write the code", so the tests and the
# review get a second opinion from a different AI. With crossFamily: false,
# "other" stays in the same family.

# The profile used when you don't pick one with --profile.
defaultProfile: mixed

profiles:
  # Everything runs on Claude.
  claude:
    architect: claude
    engineer: claude
    test_author: claude
    reviewer: claude
    crossFamily: false
  # Everything runs on Codex.
  codex:
    architect: codex
    engineer: codex
    test_author: codex
    reviewer: codex
    crossFamily: false
  # Claude plans, Codex builds, and the other family writes the tests and reviews.
  mixed:
    architect: claude
    engineer: codex
    test_author: other
    reviewer: other
    crossFamily: true

# How strong a model, and how much thinking, each supporting role gets.
#   tier:   frontier (strongest), standard, or light (the quick helper model)
#   effort: low, medium, high, xhigh or max (more effort = slower, uses more of your plan)
# The engineer is not listed here: the ladders below decide its tier and effort.
roles:
  architect: { tier: frontier, effort: high }
  test_author: { tier: standard, effort: high }
  reviewer: { tier: frontier, effort: high }
  scout: { tier: light, effort: low }


# ---------------------------------------------------------------------------
# Escalation ladders
# ---------------------------------------------------------------------------

# When a feature's tests keep failing, the engineer tries again one step
# further down its ladder, with a stronger setup each time:
#   build    - build again with this tier and effort;
#              family "same" keeps the usual engineer, "other" switches family
#   diagnose - the architect studies the failure and writes a hint for the next try
# If every step fails, the feature is set aside and explained in the morning report.
ladders:
  # Used for most features.
  standard:
    - { action: build, tier: standard, effort: medium, family: same }
    - { action: build, tier: standard, effort: high, family: same }
    - { action: diagnose }
    - { action: build, tier: frontier, effort: high, family: other }
    - { action: build, tier: frontier, effort: high, family: same }
  # Used for simple, boilerplate features: starts with the quick helper model.
  mechanical:
    - { action: build, tier: light, effort: medium, family: same }
    - { action: build, tier: standard, effort: medium, family: same }
    - { action: build, tier: standard, effort: high, family: same }
    - { action: diagnose }
    - { action: build, tier: frontier, effort: high, family: other }


# ---------------------------------------------------------------------------
# Safety limits
# ---------------------------------------------------------------------------

# Times are in milliseconds: 60000 = 1 minute.
limits:
  buildMaxTurns: 80              # most steps one engineer attempt may take
  otherMaxTurns: 40              # most steps any other role may take
  agentTimeoutMs: 2700000        # time limit for one agent run (45 minutes)
  verifyTimeoutMs: 1200000       # time limit for one test run (20 minutes)
  maxReviewRounds: 2             # times a reviewer may send a feature back for fixes
  maxGateCRounds: 1              # extra fix rounds after the final whole-app review
  maxAgentRunsPerMission: 150    # hard stop for one mission, protects your plan

# If one family hits its usage limit, let the other family take over its work.
failover:
  enabled: true

# Leave some of your plan for yourself: no new work starts on a family once its
# usage reaches these levels (0.97 = 97%).
pacing:
  maxFiveHourUtilization: 0.97   # of the 5-hour window
  maxWeeklyUtilization: 0.85     # of the weekly window


# ---------------------------------------------------------------------------
# Notifications, git and safety
# ---------------------------------------------------------------------------

# Phone notifications through the free ntfy app (https://ntfy.sh).
# Put your topic address between the quotes, for example
#   ntfyUrl: "https://ntfy.sh/my-secret-topic"
# Leave it as "" to turn notifications off.
notify:
  ntfyUrl: ""

git:
  push: false        # true = upload finished work to the "origin" remote (only Mission Control branches, never forced)
  branchPrefix: mc   # start of the names of branches Mission Control creates (no "/")

# What agents are allowed to do on this computer. Full autonomy is only used
# inside the Mission Control container, by its normal (non-root) user. Outside
# the container Mission Control switches to safer modes on its own while
# requireContainerForBypass is true, and as root Claude always gets "auto".
permissions:
  claudeWriteMode: bypassPermissions      # bypassPermissions, acceptEdits or auto
  codexWriteSandbox: danger-full-access   # danger-full-access or workspace-write
  requireContainerForBypass: true         # keep this true

# The command-line tools Mission Control drives, and the versions it was tested
# with. "mc doctor" warns when the installed versions differ.
# A command is either a plain name (found the usual way) or a full path such as
# ~/bin/claude or /usr/local/bin/claude.
cli:
  claudeCommand: claude
  codexCommand: codex
  claudeVersion: "2.1.295"
  codexVersion: "0.162.0"
`;

// ───────────────────────────── Loading ─────────────────────────────

/** $MC_CONFIG, else <home>/config.yaml where home = $MC_HOME or ~/.mission-control. */
export function configPath(): string {
  const file = process.env.MC_CONFIG;
  if (file) return resolve(expandHome(file));
  return join(envHome() ?? expandHome(DEFAULT_HOME), "config.yaml");
}

/** $MC_HOME as an absolute path, when set. */
function envHome(): string | undefined {
  const home = process.env.MC_HOME;
  return home ? resolve(expandHome(home)) : undefined;
}

/**
 * Reads the YAML config over the defaults (objects merge, lists replace) and validates it.
 * A missing file means "all defaults" (the first run, before `mc init`; `mc doctor` points it out).
 * Paths come back with "~" expanded, and $MC_HOME, when set, decides `home` (over the file) so that
 * the config file and Mission Control's records live in the same place.
 */
export function loadConfig(path?: string): Config {
  const file = resolve(expandHome(path ?? configPath()));
  const settings = readSettingsFile(file);
  const merged = mergeSettings(defaultConfig(), settings) as Config;
  const problems = validateConfig(merged);
  if (problems.length > 0) throw new Error(describeProblems(file, problems));
  return {
    ...merged,
    home: envHome() ?? expandHome(merged.home),
    workspaceRoot: expandHome(merged.workspaceRoot),
    cli: {
      ...merged.cli,
      claudeCommand: expandHome(merged.cli.claudeCommand),
      codexCommand: expandHome(merged.cli.codexCommand),
    },
  };
}

/** The settings written in the file: {} when the file is missing, empty or only comments. */
function readSettingsFile(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    if (code === "EISDIR") throw new Error(`The config path ${file} is a folder, not a file. Point it at a .yaml file.`);
    throw new Error(`Mission Control could not read the config file ${file}: ${(err as Error).message}`, { cause: err });
  }
  const data = parseYaml(file, text);
  if (data === null || data === undefined) return {};
  if (!isPlainObject(data)) {
    throw new Error(
      `The config file ${file} should contain named settings such as "workspaceRoot: ~/mc-apps", ` +
        `but it contains ${describe(data)}.`,
    );
  }
  return data;
}

function parseYaml(file: string, text: string): unknown {
  const yamlProblem = (details: string[]) =>
    new Error(
      `The config file ${file} is not valid YAML, so Mission Control cannot read it:\n` +
        details.map((d) => `  - ${d.trim()}`).join("\n") +
        `\nTip: check the spaces at the start of the line and that every quote is closed.`,
    );
  // Plain YAML 1.2 values only, even under a "%YAML 1.1" line: no dates, sets, ordered maps or binary data,
  // which would otherwise slip through as objects that are not groups of settings.
  const doc = parseDocument(text, { schema: "core", resolveKnownTags: false });
  if (doc.errors.length > 0) throw yamlProblem(doc.errors.map((e) => e.message));
  // YAML reads a bare ~ as "blank", but for a folder it means the home folder ("workspaceRoot: ~").
  // Everywhere else it stays blank, like an empty value or null.
  for (const key of FOLDER_SETTINGS) {
    const node = doc.get(key, true);
    if (isScalar(node) && node.value === null && node.source === "~") node.value = "~";
  }
  try {
    return doc.toJS();
  } catch (err) {
    // e.g. too many aliases ("billion laughs")
    throw yamlProblem([(err as Error).message]);
  }
}

/**
 * Deep-merges `override` onto `base`: objects merge key by key; lists and single values replace.
 * A blank YAML value (null) keeps a section's defaults but unsets a single value.
 */
function mergeSettings(base: unknown, override: unknown): unknown {
  if (override === null) return isPlainObject(base) ? base : undefined;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const next = mergeSettings(Object.hasOwn(base, key) ? base[key] : undefined, value);
    if (next === undefined) delete merged[key];
    // defineProperty keeps a "__proto__" key as plain data (validation then reports it) instead of a prototype.
    else Object.defineProperty(merged, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return merged;
}

function describeProblems(file: string, problems: string[]): string {
  const count = problems.length === 1 ? "a problem" : `${problems.length} problems`;
  return (
    `The config file ${file} has ${count}:\n` +
    problems.map((p) => `  - ${p}`).join("\n") +
    `\nFix ${problems.length === 1 ? "it" : "them"} in the file (deleting a setting brings back its default), ` +
    `then run "mc doctor" to check.`
  );
}

// ───────────────────────────── Validation ─────────────────────────────

/** Every problem with the config, in plain language. Empty when the config is usable. */
export function validateConfig(c: Config): string[] {
  const root: unknown = c;
  if (!isPlainObject(root)) {
    return [`The settings must be named values such as "workspaceRoot: ~/mc-apps", but they are ${describe(root)}.`];
  }
  const check = new Checker();
  check.unknownKeys("", root, Object.keys(defaultConfig()));
  check.require("version", root.version, root.version === 1, "1 (leave it as 1)");
  for (const key of FOLDER_SETTINGS) checkFolder(check, key, root[key]);
  checkModels(check, root);
  checkProfiles(check, root);
  checkLadders(check, root.ladders);
  checkRoles(check, root.roles);
  checkLimits(check, root.limits);
  checkSwitches(check, root);
  checkNotify(check, root.notify);
  checkGit(check, root.git);
  checkPermissions(check, root.permissions);
  checkCli(check, root.cli);
  return check.problems;
}

/** Collects plain-language problems; each check returns whether the value passed. */
class Checker {
  readonly problems: string[] = [];

  add(problem: string): void {
    this.problems.push(problem);
  }

  /** Records "<path> must be <requirement>" unless `ok`. */
  require(path: string, value: unknown, ok: boolean, requirement: string): boolean {
    if (ok) return true;
    if (value === undefined || value === null) this.add(`${path} is missing: it must be ${requirement}.`);
    else if (value === "") this.add(`${path} is empty: it must be ${requirement}.`);
    else this.add(`${path} must be ${requirement}, but it is ${describe(value)}.`);
    return false;
  }

  /** A group of settings with a fixed set of names; unknown names are reported. */
  section(path: string, value: unknown, knownKeys: readonly string[]): Record<string, unknown> | undefined {
    if (!this.require(path, value, isPlainObject(value), `a group of settings (${knownKeys.join(", ")})`)) return undefined;
    const settings = value as Record<string, unknown>;
    this.unknownKeys(path, settings, knownKeys);
    return settings;
  }

  /** A group of named entries (any names) such as `profiles`. */
  namedGroup(path: string, value: unknown, example: string): Record<string, unknown> | undefined {
    const ok = isPlainObject(value) && Object.keys(value).length > 0;
    return this.require(path, value, ok, `a group of one or more named entries (for example ${example})`)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  unknownKeys(path: string, value: Record<string, unknown>, knownKeys: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (knownKeys.includes(key)) continue;
      const match = knownKeys.find((known) => looseName(known) === looseName(key));
      const advice = match ? `Did you mean ${childPath(path, match)}?` : `Settings allowed here: ${knownKeys.join(", ")}.`;
      this.add(`${childPath(path, key)} is not a setting Mission Control knows (check the spelling). ${advice}`);
    }
  }

  text(path: string, value: unknown, requirement = "some text"): value is string {
    return this.require(path, value, typeof value === "string" && value.trim() !== "", requirement);
  }

  optionalText(path: string, value: unknown, requirement: string): boolean {
    return value === undefined || this.require(path, value, typeof value === "string", requirement);
  }

  bool(path: string, value: unknown): value is boolean {
    return this.require(path, value, typeof value === "boolean", "true or false");
  }

  oneOf<T extends string>(path: string, value: unknown, allowed: readonly T[]): value is T {
    return this.require(path, value, isOneOf(allowed, value), `one of: ${allowed.join(", ")}`);
  }

  effort(path: string, value: unknown): void {
    if (value === "ultra") {
      this.add(
        `${path} is "ultra", which Mission Control never uses (it fans out to many sub-agents and burns ` +
          `through your plan). Use one of: ${EFFORTS.join(", ")}.`,
      );
    } else {
      this.oneOf(path, value, EFFORTS);
    }
  }

  wholeNumber(path: string, value: unknown, min: number, max: number, requirement: string): void {
    const ok = Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
    this.require(path, value, ok, requirement);
  }
}

function checkFolder(check: Checker, path: string, value: unknown): void {
  const requirement = `a full folder path such as ~/mc-apps or /home/you/mc-apps`;
  if (!check.text(path, value, requirement)) return;
  check.require(path, value, value === "~" || value.startsWith("~/") || value.startsWith("/"), requirement);
}

function checkModels(check: Checker, root: Record<string, unknown>): void {
  const allowed = checkAllowedModels(check, root.allowedModels);
  const families = check.section("families", root.families, FAMILIES);
  for (const family of families ? FAMILIES : []) {
    const path = `families.${family}`;
    const models = check.section(path, families?.[family], ["provider", "frontier", "standard"]);
    if (!models) continue;
    // "mock" is the scripted test double; real configs always name their own provider.
    check.require(`${path}.provider`, models.provider, models.provider === family || models.provider === "mock", `"${family}"`);
    checkModelName(check, `${path}.frontier`, models.frontier, allowed);
    checkModelName(check, `${path}.standard`, models.standard, allowed);
  }
  const light = check.section("light", root.light, ["provider", "model"]);
  if (light) {
    const ok = light.provider === "claude" || light.provider === "mock";
    check.require("light.provider", light.provider, ok, `"claude" (quick helper work always runs on Claude Haiku)`);
    checkModelName(check, "light.model", light.model, allowed);
  }
}

/**
 * Returns the usable allowed-model names, or undefined when there are none (the list's own problems are
 * already reported, and checking each model against an empty list would only add noise).
 */
function checkAllowedModels(check: Checker, value: unknown): string[] | undefined {
  if (!check.require("allowedModels", value, Array.isArray(value) && value.length > 0, "a list of one or more model names")) {
    return undefined;
  }
  const names: string[] = [];
  (value as unknown[]).forEach((entry, i) => {
    const path = `allowedModels (item ${i + 1})`;
    if (!check.text(path, entry, "a model name such as claude-sonnet-5-5")) return;
    if (isLuna(entry)) check.add(`${path} is "${entry}": Luna models are disabled by user preference.`);
    else names.push(entry);
  });
  return names.length > 0 ? names : undefined;
}

function checkModelName(check: Checker, path: string, value: unknown, allowed: string[] | undefined): void {
  if (!check.text(path, value, "a model name such as claude-sonnet-5-5")) return;
  if (isLuna(value)) {
    check.add(`${path} is "${value}": Luna models are disabled by user preference.`);
  } else if (allowed && !allowed.includes(value)) {
    check.add(
      `${path} is "${value}", which is not in allowedModels. Use one of: ${allowed.join(", ")} ` +
        `(or add it to allowedModels if you really want it).`,
    );
  }
}

function isLuna(model: string): boolean {
  return /luna/i.test(model);
}

function checkProfiles(check: Checker, root: Record<string, unknown>): void {
  const profiles = check.namedGroup("profiles", root.profiles, "mixed");
  for (const [name, profile] of Object.entries(profiles ?? {})) {
    const path = `profiles.${name}`;
    const fields = check.section(path, profile, ["architect", "engineer", "test_author", "reviewer", "crossFamily"]);
    if (!fields) continue;
    check.oneOf(`${path}.architect`, fields.architect, FAMILIES);
    check.oneOf(`${path}.engineer`, fields.engineer, FAMILIES);
    check.oneOf(`${path}.test_author`, fields.test_author, FAMILY_CHOICES);
    check.oneOf(`${path}.reviewer`, fields.reviewer, FAMILY_CHOICES);
    check.bool(`${path}.crossFamily`, fields.crossFamily);
  }
  const wanted = root.defaultProfile;
  if (check.text("defaultProfile", wanted, "the name of one of your profiles") && profiles && !Object.hasOwn(profiles, wanted)) {
    check.add(
      `defaultProfile is "${wanted}", but there is no profile with that name. ` +
        `Choose one of: ${Object.keys(profiles).join(", ")}.`,
    );
  }
}

function checkLadders(check: Checker, value: unknown): void {
  const names = ["standard", "mechanical"] as const;
  const ladders = check.section("ladders", value, names);
  for (const name of ladders ? names : []) {
    const path = `ladders.${name}`;
    const rungs = ladders?.[name];
    if (!check.require(path, rungs, Array.isArray(rungs) && rungs.length > 0, "a list of one or more steps")) continue;
    (rungs as unknown[]).forEach((rung, i) => checkRung(check, `${path} (step ${i + 1})`, rung));
    if ((rungs as unknown[]).every((rung) => isPlainObject(rung) && rung.action === "diagnose")) {
      check.add(`${path} needs at least one build step: diagnose steps alone never change any code.`);
    }
  }
}

function checkRung(check: Checker, path: string, rung: unknown): void {
  const example = "a step such as { action: build, tier: standard, effort: medium, family: same } or { action: diagnose }";
  if (!check.require(path, rung, isPlainObject(rung), example)) return;
  const step = rung as Record<string, unknown>;
  if (!check.oneOf(`${path}.action`, step.action, ["build", "diagnose"] as const)) return;
  if (step.action === "diagnose") {
    check.unknownKeys(path, step, ["action"]);
    return;
  }
  check.unknownKeys(path, step, ["action", "tier", "effort", "family"]);
  check.oneOf(`${path}.tier`, step.tier, TIERS);
  check.effort(`${path}.effort`, step.effort);
  check.oneOf(`${path}.family`, step.family, ["same", "other"] as const);
}

function checkRoles(check: Checker, value: unknown): void {
  const roleNames = ["architect", "test_author", "reviewer", "scout"] as const;
  const roles = check.section("roles", value, roleNames);
  for (const role of roles ? roleNames : []) {
    const settings = check.section(`roles.${role}`, roles?.[role], ["tier", "effort"]);
    if (!settings) continue;
    check.oneOf(`roles.${role}.tier`, settings.tier, TIERS);
    check.effort(`roles.${role}.effort`, settings.effort);
  }
}

function checkLimits(check: Checker, value: unknown): void {
  const names = Object.keys(defaultConfig().limits);
  const limits = check.section("limits", value, names);
  if (!limits) return;
  const timers = ["agentTimeoutMs", "verifyTimeoutMs"];
  for (const name of names) {
    const path = `limits.${name}`;
    if (timers.includes(name)) {
      const requirement =
        `a time in milliseconds from ${MIN_TIMER_MS} (1 minute) to ${MAX_TIMER_MS} (about 24 days), ` +
        `for example 2700000 for 45 minutes`;
      check.wholeNumber(path, limits[name], MIN_TIMER_MS, MAX_TIMER_MS, requirement);
    } else {
      check.wholeNumber(path, limits[name], 1, Number.MAX_SAFE_INTEGER, "a whole number greater than 0");
    }
  }
}

function checkSwitches(check: Checker, root: Record<string, unknown>): void {
  const failover = check.section("failover", root.failover, ["enabled"]);
  if (failover) check.bool("failover.enabled", failover.enabled);
  const thresholds = ["maxFiveHourUtilization", "maxWeeklyUtilization"];
  const pacing = check.section("pacing", root.pacing, thresholds);
  for (const name of pacing ? thresholds : []) {
    const v = pacing?.[name];
    const ok = typeof v === "number" && v > 0 && v <= 1.5;
    check.require(`pacing.${name}`, v, ok, "a number above 0 and at most 1.5 (for example 0.9 means 90%)");
  }
}

function checkNotify(check: Checker, value: unknown): void {
  const notify = check.section("notify", value, ["ntfyUrl"]);
  if (!notify || notify.ntfyUrl === undefined || notify.ntfyUrl === "") return;
  check.require(
    "notify.ntfyUrl",
    notify.ntfyUrl,
    typeof notify.ntfyUrl === "string" && isTopicAddress(notify.ntfyUrl),
    `a web address with your topic, such as "https://ntfy.sh/my-secret-topic" (or "" to turn notifications off)`,
  );
}

function isTopicAddress(s: string): boolean {
  if (!URL.canParse(s)) return false;
  const url = new URL(s);
  return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "" && url.pathname.length > 1;
}

function checkGit(check: Checker, value: unknown): void {
  const git = check.section("git", value, ["push", "branchPrefix"]);
  if (!git) return;
  check.bool("git.push", git.push);
  const prefix = git.branchPrefix;
  const ok = typeof prefix === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix) && !/\.\.|\.lock$|\.$/.test(prefix);
  check.require("git.branchPrefix", prefix, ok, `a short name made of letters, numbers, ".", "_" or "-", without "/" (for example mc)`);
}

function checkPermissions(check: Checker, value: unknown): void {
  const permissions = check.section("permissions", value, ["claudeWriteMode", "codexWriteSandbox", "requireContainerForBypass"]);
  if (!permissions) return;
  check.oneOf("permissions.claudeWriteMode", permissions.claudeWriteMode, CLAUDE_WRITE_MODES);
  check.oneOf("permissions.codexWriteSandbox", permissions.codexWriteSandbox, CODEX_WRITE_SANDBOXES);
  check.bool("permissions.requireContainerForBypass", permissions.requireContainerForBypass);
}

function checkCli(check: Checker, value: unknown): void {
  const cli = check.section("cli", value, ["claudeCommand", "codexCommand", "claudeVersion", "codexVersion"]);
  if (!cli) return;
  checkCommand(check, "cli.claudeCommand", cli.claudeCommand, "Claude Code", "claude");
  checkCommand(check, "cli.codexCommand", cli.codexCommand, "Codex", "codex");
  check.optionalText("cli.claudeVersion", cli.claudeVersion, `a version in quotes, such as "2.1.295"`);
  check.optionalText("cli.codexVersion", cli.codexVersion, `a version in quotes, such as "0.162.0"`);
}

/**
 * A command name found on PATH, or a full path. Agents run inside other folders (git worktrees),
 * so a relative path such as ./bin/claude would not be found there.
 */
function checkCommand(check: Checker, path: string, value: unknown, tool: string, name: string): void {
  const requirement = `the command that starts ${tool}: a name such as ${name}, or a full path such as ~/bin/${name}`;
  if (!check.text(path, value, requirement)) return;
  const nameOrFullPath = !value.includes("/") || value.startsWith("/") || value.startsWith("~/");
  check.require(path, value, nameOrFullPath, requirement);
}

// ───────────────────────────── Role overrides ─────────────────────────────

/**
 * Parses a `--role` value: "<role>=<choices>", where choices are ":"-separated and each is a
 * family (claude, codex), a tier (frontier, standard, light) or an effort (low … max), at most one of each.
 * Examples: "engineer=codex", "engineer=codex:frontier", "reviewer=claude:standard:high", "engineer=frontier".
 */
export function parseRoleOverride(s: string): RoleOverride {
  function fail(why: string): never {
    throw new Error(
      `Invalid role setting "${s}": ${why} ` +
        `Examples: engineer=codex, engineer=codex:frontier, reviewer=claude:standard:high, engineer=frontier.`,
    );
  }
  const eq = s.indexOf("=");
  if (eq < 0) fail(`write it as role=choice.`);
  const written = s.slice(0, eq).trim();
  const role = written.toLowerCase().replaceAll("-", "_");
  if (!isOneOf(ROLES, role)) fail(`"${written}" is not a role. Roles: ${ROLES.join(", ")}.`);
  const override: RoleOverride = { role };
  const choices = s.slice(eq + 1).split(":").map((part) => part.trim().toLowerCase());
  if (choices.some((part) => part === "")) fail(`something is missing after "=" or between ":".`);
  for (const choice of choices) {
    if (isOneOf(FAMILIES, choice)) override.family = once(override.family, choice, "family", fail);
    else if (isOneOf(TIERS, choice)) override.tier = once(override.tier, choice, "tier", fail);
    else if (isOneOf(EFFORTS, choice)) override.effort = once(override.effort, choice, "effort", fail);
    else if (choice === "other") fail(`"other" only works inside a profile; name the family here (claude or codex).`);
    else if (choice === "ultra") fail(`"ultra" effort is never used (it fans out to many sub-agents).`);
    else {
      fail(
        `"${choice}" is not a family (${FAMILIES.join(", ")}), a tier (${TIERS.join(", ")}) ` +
          `or an effort (${EFFORTS.join(", ")}).`,
      );
    }
  }
  return override;
}

function once<T>(current: T | undefined, next: T, what: string, fail: (why: string) => never): T {
  if (current !== undefined) fail(`it names more than one ${what}.`);
  return next;
}

// ───────────────────────────── Resolution ─────────────────────────────

export function otherFamily(f: Family): Family {
  return f === "claude" ? "codex" : "claude";
}

/** "other" means the family not used by `relativeTo` (the engineer), but only in cross-family profiles. */
export function resolveFamily(choice: FamilyChoice, relativeTo: Family, profile: Profile): Family {
  if (choice !== "other") return choice;
  return profile.crossFamily ? otherFamily(relativeTo) : relativeTo;
}

/** The model for a family and tier. The light tier is always `c.light`, whatever the family. */
export function resolveModel(c: Config, family: Family, tier: Tier): ModelRef {
  if (tier === "light") return { ...c.light };
  const models = c.families[family];
  return { provider: models.provider, model: models[tier] };
}

export function inContainer(env: NodeJS.ProcessEnv = process.env, markerFile = DOCKERENV): boolean {
  return env.MC_IN_CONTAINER === "1" || existsSync(markerFile);
}

export interface EffectivePermissions {
  claudeWriteMode: ClaudeWriteMode;
  codexWriteSandbox: CodexWriteSandbox;
  downgraded: boolean;
  /** Only when downgraded: what changed and why, in plain language (for the warning and `mc doctor`). */
  reason?: string;
}

/**
 * The modes agents really get. Outside a container (while the config requires one), the full-autonomy
 * modes become safer ones. As root, Claude's bypass mode always becomes "auto", whatever the config says:
 * Claude Code refuses bypassPermissions as root (it exits at startup), and root agents could change
 * Mission Control itself.
 */
export function effectivePermissions(
  c: Config,
  containerized: boolean = inContainer(),
  runningAsRoot: boolean = process.getuid?.() === 0,
): EffectivePermissions {
  const { claudeWriteMode, codexWriteSandbox, requireContainerForBypass } = c.permissions;
  const wantsClaudeBypass = claudeWriteMode === "bypassPermissions";
  const wantsCodexFullAccess = codexWriteSandbox === "danger-full-access";
  const outsideContainer = requireContainerForBypass && !containerized;
  const claudeDowngraded = wantsClaudeBypass && (outsideContainer || runningAsRoot);
  const codexDowngraded = wantsCodexFullAccess && outsideContainer;
  const result: EffectivePermissions = {
    claudeWriteMode: claudeDowngraded ? "auto" : claudeWriteMode,
    codexWriteSandbox: codexDowngraded ? "workspace-write" : codexWriteSandbox,
    downgraded: claudeDowngraded || codexDowngraded,
  };
  if (!result.downgraded) return result;
  const changes = [
    claudeDowngraded && `Claude uses "auto" instead of "bypassPermissions"`,
    codexDowngraded && `Codex uses "workspace-write" instead of "danger-full-access"`,
  ];
  const causes = [
    outsideContainer && `Mission Control is not running inside its container`,
    claudeDowngraded && runningAsRoot && `Mission Control is running as root (Claude Code refuses bypassPermissions as root)`,
  ];
  const reason = `${changes.filter(Boolean).join(" and ")}, because ${causes.filter(Boolean).join(" and ")}.`;
  return { ...result, reason };
}

// ───────────────────────────── Helpers ─────────────────────────────

/** A group of named settings: a plain object, not a list, date, map, set or other special object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Case, "-" and "_" insensitive name, for "did you mean" suggestions. */
function looseName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, "");
}

function childPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

/** How a wrong value reads in a message. */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "a list";
  if (isPlainObject(value)) return "a group of settings";
  if (typeof value === "object" && value !== null) return "a special value Mission Control cannot use";
  return String(value);
}
