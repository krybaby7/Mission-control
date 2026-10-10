// `mc doctor`: checks that this computer is ready for a night of work (tools, logins, settings, folders, disk
// space), and with `live` makes one tiny real request to each AI. Every check catches its own errors, so the
// doctor always finishes and reports, whatever is broken.
import { accessSync, constants, existsSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configPath, defaultConfig, effectivePermissions, inContainer, loadConfig, resolveModel, validateConfig } from "./config.js";
import { RoleExecutor } from "./executor.js";
import { QuotaGovernor } from "./quota.js";
import { createRunners } from "./runners/index.js";
import { MissionStore } from "./state.js";
import type { AgentRunner, Config, Family, JsonSchema, Provider, Tier } from "./types.js";
import { systemClock } from "./util/clock.js";
import { ensureDir, expandHome } from "./util/fs.js";
import { nullLogger } from "./util/logger.js";
import { runProcess, scrubEnv, type SpawnResult } from "./util/process.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** What was found, in plain language. */
  detail: string;
  /** What to do about it, when not ok. */
  fix?: string;
  /** How serious a failure of this check is: errors stop a night from working, warnings don't. */
  severity: "error" | "warn";
}

export interface DoctorOptions {
  /** The settings to check against. Default: the settings file, whose own problems become a check. */
  config?: Config;
  /** Also make one tiny real request per AI family and the light model (uses a little of each plan). */
  live?: boolean;
  /** Stand-ins for the CLI runners used by the live checks (tests). Default: the real CLIs. */
  runners?: Partial<Record<Provider, AgentRunner>>;
}

type Severity = DoctorCheck["severity"];

const MIN_NODE = { major: 22, minor: 12 };
const COMMAND_TIMEOUT_MS = 30_000;
const MODEL_LIST_TIMEOUT_MS = 60_000;
const LIVE_TIMEOUT_MS = 3 * 60_000;
const MIN_FREE_BYTES = 5 * 1024 ** 3;
const GB = 1024 ** 3;

/** Variables that make the CLIs bill pay-per-use API credits (or another cloud) instead of the subscriptions. */
const BILLING_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
];

const LIVE_SCHEMA: JsonSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

/** Runs every check and returns them in display order. Never throws. */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const settings = settingsCheck(opts.config);
  const c = settings.config;
  // A night run uses the same logins. Codex refreshes its login in place, and two codex processes refreshing it at
  // once can log Codex out for the night (design-v1 §2.1), so commands that may talk to the servers wait for the run.
  const nightRun = activeNightRun(c);
  // One codex process at a time, for the same reason.
  const codexLogin = guarded("Codex login", "error", () => (nightRun ? skippedDuringRun("Codex login", nightRun) : codexLoginCheck(c)));
  const codexModels = codexLogin.then(() => guarded("Codex models", "error", () => (nightRun ? [] : codexModelsCheck(c))));
  const groups = await Promise.all([
    guarded("Node.js", "error", () => nodeCheck(process.versions.node)),
    guarded("Git", "error", () => gitChecks()),
    [settings.check],
    guarded("Claude Code", "error", () => cliVersionCheck(claudeTool(c))),
    guarded("Claude login", "error", () => claudeLoginCheck(c)),
    guarded("Codex", "error", () => cliVersionCheck(codexTool(c))),
    codexLogin,
    codexModels,
    guarded("API keys", "error", () => apiKeyCheck()),
    guarded("Container", "warn", () => containerCheck(c)),
    guarded("Mission Control folder", "error", () => folderCheck("Mission Control folder", c.home, homeFolderFix(c.home), keptFolder("home"))),
    guarded("Apps folder", "error", () => folderCheck("Apps folder", c.workspaceRoot, appsFolderFix(c.workspaceRoot), keptFolder("workspaceRoot"))),
    guarded("Disk space", "warn", () => diskChecks(c)),
    guarded("Notifications", "warn", () => notifyCheck(c)),
  ]);
  const checks = groups.flat();
  if (opts.live) {
    const live = nightRun ? [skippedDuringRun("Live check", nightRun)] : await guarded("Live check", "error", () => liveChecks(c, opts.runners));
    checks.push(...live);
  }
  return checks;
}

/** The `mc run` working right now ("pid 7 on host …"), or undefined. Read-only: the doctor never touches the lock. */
function activeNightRun(c: Config): string | undefined {
  try {
    return new MissionStore(c.home).activeRun();
  } catch {
    return undefined; // an unreadable lock: the folder checks report the folder's problem
  }
}

function skippedDuringRun(name: string, run: string): DoctorCheck {
  return fail(
    name,
    "warn",
    `Not checked: a night run is working right now (${run}), and this check would use the same logins at the same time, which can log Codex out for the rest of the night.`,
    `Run "mc doctor${name === "Live check" ? " --live" : ""}" again after the run ends ("mc status" shows what it is doing; "mc stop" ends it early).`,
  );
}

/** Node's version string (e.g. "22.12.0") is at least the minimum Mission Control needs. */
export function isSupportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

/** Runs one check; an unexpected exception becomes a failed check instead of crashing the doctor. */
async function guarded(name: string, severity: Severity, check: () => DoctorCheck | DoctorCheck[] | Promise<DoctorCheck | DoctorCheck[]>): Promise<DoctorCheck[]> {
  try {
    return [await check()].flat();
  } catch (err) {
    return [fail(name, severity, `Mission Control could not run this check: ${errorText(err)}`)];
  }
}

function pass(name: string, detail: string, severity: Severity = "error"): DoctorCheck {
  return { name, ok: true, detail, severity };
}

function fail(name: string, severity: Severity, detail: string, fix?: string): DoctorCheck {
  return fix === undefined ? { name, ok: false, detail, severity } : { name, ok: false, detail, fix, severity };
}

// ───────────────────────────── Settings ─────────────────────────────

const SETTINGS_FIX = `Fix it, then run "mc doctor" again. Show a setting: mc config get <name>. Change one: mc config set <name> <value>.`;

/** The settings check, plus the settings the other checks use (the defaults when the given ones are unusable). */
function settingsCheck(given: Config | undefined): { check: DoctorCheck; config: Config } {
  const name = "Settings";
  try {
    return given ? givenSettingsCheck(name, given) : fileSettingsCheck(name);
  } catch (err) {
    const fallback = withAbsolutePaths({ ...defaultConfig(), home: process.env.MC_HOME || defaultConfig().home });
    return { check: fail(name, "error", errorText(err), SETTINGS_FIX), config: fallback };
  }
}

function givenSettingsCheck(name: string, given: Config): { check: DoctorCheck; config: Config } {
  const config = withAbsolutePaths(given);
  const problems = validateConfig(given);
  if (problems.length === 0) return { check: pass(name, "the settings are valid"), config };
  const detail = `The settings have ${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`;
  return { check: fail(name, "error", detail, SETTINGS_FIX), config };
}

function fileSettingsCheck(name: string): { check: DoctorCheck; config: Config } {
  const file = configPath();
  const config = loadConfig(file);
  if (!existsSync(file)) {
    return { check: fail(name, "warn", "There is no settings file yet, so the built-in defaults are used.", "Create it: mc init"), config };
  }
  return { check: pass(name, `${file} is valid`), config };
}

function withAbsolutePaths(c: Config): Config {
  return { ...c, home: absolute(c.home), workspaceRoot: absolute(c.workspaceRoot) };
}

function absolute(p: string): string {
  return resolve(expandHome(p));
}

// ───────────────────────────── Tools ─────────────────────────────

function nodeCheck(version: string): DoctorCheck {
  if (isSupportedNode(version)) return pass("Node.js", `version ${version}`);
  const min = `${MIN_NODE.major}.${MIN_NODE.minor}`;
  return fail("Node.js", "error", `version ${version} is too old: Mission Control needs ${min} or newer.`, `Install Node.js ${min} or newer, or use the Mission Control container (it has the right version).`);
}

async function gitChecks(): Promise<DoctorCheck[]> {
  const version = await runCli("git", ["--version"]);
  if (version.spawnError || version.exitCode !== 0) {
    const fix = "Install git (on Ubuntu: sudo apt install git). The Mission Control container already has it.";
    return [fail("Git", "error", `git is not installed or doesn't start: ${problemText(version)}`, fix)];
  }
  const name = (await runCli("git", ["config", "--get", "user.name"])).stdout.trim();
  const email = (await runCli("git", ["config", "--get", "user.email"])).stdout.trim();
  const identity =
    name && email
      ? pass("Git identity", `commits are signed as ${name} <${email}>`, "warn")
      : fail(
          "Git identity",
          "warn",
          `git has no name or email for commits, so Mission Control signs its commits as "Mission Control".`,
          `Optional: git config --global user.name "Your Name" && git config --global user.email "you@example.com"`,
        );
  return [pass("Git", firstLine(version.stdout)), identity];
}

interface Tool {
  name: string;
  command: string;
  pinned: string | undefined;
  npmPackage: string;
}

function claudeTool(c: Config): Tool {
  return { name: "Claude Code", command: c.cli.claudeCommand, pinned: c.cli.claudeVersion, npmPackage: "@anthropic-ai/claude-code" };
}

function codexTool(c: Config): Tool {
  return { name: "Codex", command: c.cli.codexCommand, pinned: c.cli.codexVersion, npmPackage: "@openai/codex" };
}

async function cliVersionCheck(tool: Tool): Promise<DoctorCheck> {
  const result = await runCli(tool.command, ["--version"]);
  if (result.spawnError) {
    return fail(tool.name, "error", `${tool.name} isn't installed: the command "${tool.command}" was not found.`, installFix(tool));
  }
  if (result.exitCode !== 0) {
    return fail(tool.name, "error", `"${tool.command} --version" failed: ${problemText(result)}`, installFix(tool));
  }
  const version = /\d+\.\d+\.\d+[\w.+-]*/.exec(commandOutput(result))?.[0];
  if (!version) return fail(tool.name, "warn", `couldn't read the version from: ${firstLine(commandOutput(result))}`);
  if (!tool.pinned || version === tool.pinned) return pass(tool.name, `version ${version}`);
  return fail(
    tool.name,
    "warn",
    `version ${version} is installed, but Mission Control was tested with ${tool.pinned}. It may still work.`,
    installFix(tool),
  );
}

function installFix(tool: Tool): string {
  if (inContainer()) return "Rebuild the Mission Control image: in Ubuntu, run: mc build";
  return `Install it: npm install -g ${tool.npmPackage}@${tool.pinned ?? "latest"} (or use the Mission Control container).`;
}

// ───────────────────────────── Logins ─────────────────────────────

async function claudeLoginCheck(c: Config): Promise<DoctorCheck> {
  const name = "Claude login";
  const credentials = join(claudeConfigDir(), ".credentials.json");
  if (isNonEmptyFile(credentials)) return pass(name, "logged in");
  const status = await runCli(c.cli.claudeCommand, ["auth", "status"]);
  if (status.spawnError) return fail(name, "error", "Can't check: Claude Code isn't installed.", installFix(claudeTool(c)));
  if (status.exitCode === 0) return pass(name, "logged in");
  return fail(name, "error", "Claude Code is not logged in.", loginFix("claude"));
}

/** Where Claude Code keeps its login: $CLAUDE_CONFIG_DIR (set in the container), else ~/.claude. */
function claudeConfigDir(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? absolute(dir) : join(homedir(), ".claude");
}

async function codexLoginCheck(c: Config): Promise<DoctorCheck> {
  const name = "Codex login";
  const status = await runCli(c.cli.codexCommand, ["login", "status"]);
  if (status.spawnError) return fail(name, "error", "Can't check: Codex isn't installed.", installFix(codexTool(c)));
  if (status.exitCode !== 0) return fail(name, "error", "Codex is not logged in.", loginFix("codex"));
  if (/api key/i.test(commandOutput(status))) {
    // Never echo the output here: it can contain part of the key.
    return fail(
      name,
      "error",
      "Codex is logged in with an API key, which bills pay-per-use API credits instead of your ChatGPT plan, so Mission Control won't start Codex on it.",
      `Log out with "codex logout", then log in with ChatGPT: ${loginFix("codex")}`,
    );
  }
  return pass(name, "logged in");
}

function loginFix(family: Family): string {
  if (inContainer()) return `In Ubuntu, run: mc login-${family}`;
  return family === "claude" ? "Run claude, type /login and follow the steps." : "Run: codex login --device-auth";
}

async function codexModelsCheck(c: Config): Promise<DoctorCheck[]> {
  const { provider, frontier, standard } = c.families.codex;
  if (provider !== "codex") return [];
  const name = "Codex models";
  const result = await runCli(c.cli.codexCommand, ["debug", "models"], MODEL_LIST_TIMEOUT_MS);
  if (result.spawnError) return [fail(name, "warn", "Can't check: Codex isn't installed.")];
  if (result.exitCode !== 0) return [fail(name, "warn", `"codex debug models" failed: ${problemText(result)}`)];
  const listed = commandOutput(result);
  const missing = [frontier, standard].filter((model) => !mentionsModel(listed, model));
  if (missing.length === 0) return [pass(name, `${frontier} and ${standard} are available`)];
  return [
    fail(
      name,
      "error",
      `Codex doesn't offer ${missing.join(" or ")}, which your settings use (families.codex).`,
      `Run "codex debug models" to see the names it offers, then update the settings, for example: ` +
        `mc config set families.codex.standard <name> (and add the name to allowedModels).`,
    ),
  ];
}

/** The model id appears as a whole name, not as part of a longer one ("gpt-6" is not in "gpt-6.1-sol"). */
function mentionsModel(text: string, model: string): boolean {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`).test(text);
}

// ───────────────────────────── Environment ─────────────────────────────

function apiKeyCheck(): DoctorCheck {
  const set = BILLING_VARS.filter((name) => (process.env[name] ?? "") !== "");
  if (set.length === 0) return pass("API keys", "none set, so both AIs use your subscriptions");
  return fail(
    "API keys",
    "error",
    `${set.join(", ")} ${set.length === 1 ? "is" : "are"} set. These make Claude Code or Codex bill pay-per-use API ` +
      `credits instead of your subscriptions. Mission Control removes them before starting its agents, but other ` +
      `programs you run would still use them.`,
    `Remove ${set.length === 1 ? "it" : "them"} from your shell setup (~/.bashrc, ~/.profile) or the container's ` +
      `environment, then open a new terminal.`,
  );
}

function containerCheck(c: Config): DoctorCheck {
  const name = "Container";
  const containerized = inContainer();
  const permissions = effectivePermissions(c, containerized);
  if (containerized) {
    if (!permissions.downgraded) return pass(name, "running inside the Mission Control container", "warn");
    return fail(name, "warn", `Running inside the container, but agents get safer, slower permissions: ${permissions.reason}`, "Run Mission Control as the container's normal user (scripts/mc-docker.sh does this).");
  }
  const useContainer = "Run Mission Control through scripts/mc-docker.sh (see docs/setup-windows.md).";
  if (permissions.downgraded) {
    return fail(name, "warn", `Not running inside the Mission Control container, so agents get safer, slower permissions: ${permissions.reason}`, useContainer);
  }
  if (!c.permissions.requireContainerForBypass && c.permissions.claudeWriteMode === "bypassPermissions") {
    return fail(
      name,
      "warn",
      "Not running inside the Mission Control container, and permissions.requireContainerForBypass is false: agents can change anything on this computer.",
      `${useContainer} Or turn the safety back on: mc config set permissions.requireContainerForBypass true`,
    );
  }
  return fail(name, "warn", "Not running inside the Mission Control container.", useContainer);
}

/** A folder the Mission Control container keeps between commands, and the setting that points there. */
interface KeptFolder {
  setting: "home" | "workspaceRoot";
  /** As the user writes it ("~/mc-apps"). */
  shown: string;
  dir: string;
}

/**
 * Inside the container, the folder `setting` must stay in (mc-docker.sh mounts only these two, and each command's
 * container is deleted when it ends); undefined outside the container.
 */
function keptFolder(setting: KeptFolder["setting"], containerized = inContainer()): KeptFolder | undefined {
  if (!containerized) return undefined;
  const shown = setting === "home" ? "~/.mission-control" : "~/mc-apps";
  return { setting, shown, dir: join(homedir(), shown.slice(2)) };
}

/**
 * Inside the container, why the settings' folders would lose their contents (a folder the container doesn't keep),
 * one plain sentence per folder; [] outside the container or when both are kept.
 */
export function unkeptFolderProblems(c: Pick<Config, "home" | "workspaceRoot">, containerized = inContainer()): string[] {
  const problems: string[] = [];
  for (const setting of ["home", "workspaceRoot"] as const) {
    const kept = keptFolder(setting, containerized);
    const dir = absolute(c[setting]);
    if (kept && !isInside(dir, kept.dir)) problems.push(unkeptText(setting, dir, kept));
  }
  return problems;
}

function unkeptText(setting: KeptFolder["setting"], dir: string, kept: KeptFolder): string {
  const what = setting === "home" ? "Mission Control's records (missions, reports)" : "your apps";
  return (
    `${setting} is ${dir}, which the Mission Control container doesn't keep: ${what} would be deleted when each ` +
    `command ends. Inside the container only ~/mc-apps and ~/.mission-control are kept, so ${setting} must be ${kept.shown} or a folder inside it.`
  );
}

function isInside(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(`${root}/`);
}

function folderCheck(name: string, folder: string, fix: string, kept?: KeptFolder): DoctorCheck {
  const dir = absolute(folder);
  if (kept && !isInside(dir, kept.dir)) {
    const reset = process.env.MC_HOME && kept.setting === "home" ? `Unset MC_HOME, or point it inside ${kept.shown}.` : `Put it back: mc config set ${kept.setting} ${kept.shown}`;
    return fail(name, "error", unkeptText(kept.setting, dir, kept), reset);
  }
  const existing = nearestExisting(dir);
  if (!statSync(existing).isDirectory()) return fail(name, "error", `${existing} is a file, not a folder.`, fix);
  try {
    if (existing !== dir) {
      accessSync(existing, constants.W_OK);
      return pass(name, `${dir} will be created when needed`);
    }
    // A real write: access() says yes to root even on read-only mounts.
    const probe = join(dir, `.mc-doctor-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return pass(name, `${dir} is writable`);
  } catch {
    return fail(name, "error", `Mission Control can't write to ${existing === dir ? dir : existing}.`, fix);
  }
}

function homeFolderFix(home: string): string {
  if (inContainer()) return "In Ubuntu, run: mc fix-permissions";
  return `Make sure your user can write to ${absolute(home)}, or set MC_HOME to another folder.`;
}

function appsFolderFix(workspaceRoot: string): string {
  if (inContainer()) return `In Ubuntu, run: sudo chown -R "$USER": ~/mc-apps && mc build`;
  return `Make sure your user can write to ${absolute(workspaceRoot)}, or choose another folder: mc config set workspaceRoot ~/mc-apps`;
}

/**
 * Free space for the apps, and for the Mission Control folder, where each mission's worktrees get their own
 * downloads (npm ci). In Docker these are different disks: a folder shared from Ubuntu and a Docker volume.
 */
function diskChecks(c: Config): DoctorCheck[] {
  const apps = nearestExisting(absolute(c.workspaceRoot));
  const home = nearestExisting(absolute(c.home));
  if (statSync(apps).dev === statSync(home).dev) return [diskCheck("Disk space", apps)];
  return [diskCheck("Disk space (apps folder)", apps), diskCheck("Disk space (Mission Control folder)", home)];
}

function diskCheck(name: string, dir: string): DoctorCheck {
  const stats = statfsSync(dir);
  const free = stats.bavail * stats.bsize;
  const amount = `${(free / GB).toFixed(1)} GB free in ${dir}`;
  if (free >= MIN_FREE_BYTES) return pass(name, amount, "warn");
  return fail(
    name,
    "warn",
    `Only ${amount}. Each app and its downloads need a few GB; Mission Control recommends at least ${MIN_FREE_BYTES / GB} GB.`,
    "Free up some disk space (with Docker Desktop also check Settings > Resources > Disk image size).",
  );
}

function notifyCheck(c: Config): DoctorCheck {
  const url = c.notify.ntfyUrl?.trim() ?? "";
  if (url === "") {
    return fail(
      "Notifications",
      "warn",
      "Phone notifications are off.",
      "Install the ntfy app, pick a secret topic, then run: mc config set notify.ntfyUrl https://ntfy.sh/<your-secret-topic>",
    );
  }
  // The topic in the address works like a password, so only the server is shown.
  return pass("Notifications", `on, sent through ${hostOf(url)}`, "warn");
}

// ───────────────────────────── Live checks ─────────────────────────────

interface LiveTarget {
  label: string;
  family: Family;
  tier: Tier;
}

const LIVE_TARGETS: LiveTarget[] = [
  { label: "Claude", family: "claude", tier: "standard" },
  { label: "Codex", family: "codex", tier: "standard" },
  { label: "Haiku", family: "claude", tier: "light" },
];

/** One tiny structured request per family plus the light model, one after the other. */
async function liveChecks(c: Config, given: Partial<Record<Provider, AgentRunner>> | undefined): Promise<DoctorCheck[]> {
  const runners = given ?? createRunners(c, { logger: nullLogger });
  const store = new MissionStore(join(c.home, "doctor"));
  // In memory only: a limit seen here must not hold back tonight's run.
  const quota = new QuotaGovernor({ clock: systemClock, config: c });
  const executor = new RoleExecutor({ config: c, runners, quota, clock: systemClock, store, logger: nullLogger });
  const checks: DoctorCheck[] = [];
  for (const target of LIVE_TARGETS) {
    const { provider, model } = resolveModel(c, target.family, target.tier);
    const name = `Live: ${target.label} (${model})`;
    checks.push(...(await guarded(name, "error", () => liveCheck(name, target, { provider, model }, { executor, quota, store, runners }))));
  }
  return checks;
}

interface LiveDeps {
  executor: RoleExecutor;
  quota: QuotaGovernor;
  store: MissionStore;
  runners: Partial<Record<Provider, AgentRunner>>;
}

const LIVE_MISSION = "live-check";

async function liveCheck(name: string, target: LiveTarget, ref: { provider: Provider; model: string }, deps: LiveDeps): Promise<DoctorCheck> {
  if (!deps.runners[ref.provider]) return fail(name, "error", `No way to run ${ref.provider} models is set up.`);
  const exec = await deps.executor.exec({
    missionId: LIVE_MISSION,
    role: "scout",
    label: `live-${target.label.toLowerCase()}`,
    family: target.family,
    tier: target.tier,
    effort: "low",
    allowFailover: false,
    // Never wait for a limit to reset: a skipped run means a limit or a login problem, read from the quota below.
    optional: true,
    cwd: ensureDir(deps.store.home),
    systemPrompt: "You are a connectivity check. Answer only with the requested JSON.",
    prompt: 'Return {"ok": true}',
    outputSchema: LIVE_SCHEMA,
    access: "read-only",
    noTools: true,
    maxTurns: 3,
    timeoutMs: LIVE_TIMEOUT_MS,
  });
  const logs = `Logs: ${deps.store.logsDir(LIVE_MISSION)}`;
  if (exec.skipped || !exec.result) return blockedLiveCheck(name, target, ref, deps.quota);
  const { result } = exec;
  if (result.outcome === "ok" && (result.structured as { ok?: unknown } | undefined)?.ok === true) {
    return pass(name, `answered in ${(result.durationMs / 1000).toFixed(1)} s`);
  }
  const why = result.outcome === "ok" ? "it answered, but not with the expected reply" : (result.error ?? result.outcome);
  return fail(name, "error", `The request failed: ${why}`, `${liveFix(target.family)} ${logs}`);
}

/** The run was skipped: the quota knows whether the login or a usage limit stopped it. */
function blockedLiveCheck(name: string, target: LiveTarget, ref: { provider: Provider; model: string }, quota: QuotaGovernor): DoctorCheck {
  const state = quota.state(ref.provider);
  if (state.status === "auth") return fail(name, "error", `Not logged in: ${firstLine(state.raw)}`, loginFix(target.family));
  const until = quota.availableAt(ref.provider, ref.model);
  const when = until === null ? "for now" : `until ${clockTime(until)}`;
  return fail(
    name,
    "warn",
    `The login works, but ${ref.model} has reached its usage limit ${when}. Mission Control waits for limits on its own.`,
  );
}

function liveFix(family: Family): string {
  return `Check the login (${loginFix(family)}) and the model names in your settings (mc config get families), then run "mc doctor --live" again.`;
}

// ───────────────────────────── Helpers ─────────────────────────────

function runCli(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<SpawnResult> {
  // Scrubbed like the agents' own environment, so logins are checked the way the agents will use them.
  return runProcess({ command: expandHome(command), args, cwd: tmpdir(), env: scrubEnv(), timeoutMs });
}

function commandOutput(r: SpawnResult): string {
  return `${r.stdout}\n${r.stderr}`.trim();
}

function problemText(r: SpawnResult): string {
  if (r.spawnError) return r.spawnError;
  if (r.timedOut) return "it didn't answer in time";
  return firstLine(commandOutput(r)) || `exit code ${r.exitCode}`;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

function isNonEmptyFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

/** The path itself, or its closest parent that exists. */
function nearestExisting(path: string): string {
  let dir = path;
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : "the address in your settings";
}

/** "07:45" today, or "Oct 11 07:45" on another day, in local time. */
function clockTime(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
