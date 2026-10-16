#!/usr/bin/env node
// `mc`: the Mission Control command line. Every command prints plain language; the exit code is 0 when it worked
// and 1 when it didn't.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { answerCounts, hasModeFeature, howChecked, imagesShownWords, isModeFeature, leftForYouChecks, ownerSentences, pictureReason, unjudgedSplit } from "./checked-by.js";
import { type AnswerInput, type AnswerProblem, answerNotice, answerProblem, applyAnswer, CHECKPOINT_KINDS, cleanNote, didWhat, endState, isCheckpointShape, isWaitingForCheck, localClock, lookCommand, MAX_NOTE_CHARS, MAX_SEND_BACKS, sendBacks, shown, waitingWhat } from "./checkpoint.js";
import { parsePort, runDashboard } from "./dashboard/command.js";
import { DEFAULT_PORT } from "./dashboard/constants.js";
import { builtInSettings, settingsFromConfig } from "./dashboard/snapshot.js";
import { ConfigProblemsError, configPath, configTemplateYaml, defaultConfig, inContainer, loadConfig, parseRoleOverride } from "./config.js";
import { type DoctorCheck, runDoctor, unkeptFolderProblems } from "./doctor.js";
import { Git } from "./git.js";
import { createNotifier, type Notifier } from "./notify.js";
import { checkChangeLines, checkChanges, describePlan, PLAN_MAX_CHARS, PLAN_PROBLEMS_SHOWN, parsePlan, reviewLines } from "./plan.js";
import { packageRoot } from "./prompts.js";
import { renderReport } from "./report.js";
import { findMission, missionOutcome, runNight } from "./run.js";
import { MissionStore, planOf } from "./state.js";
import type { CheckpointKind, Config, Feature, Mission, MissionEvent, MissionStatus, PictureWhy, RoleOverride, SpecFeature } from "./types.js";
import { cleanAiText } from "./util/ai-text.js";
import { ensureDir, expandHome } from "./util/fs.js";
import { runProcess } from "./util/process.js";
import { stripControlChars } from "./util/terminal.js";

/** Where the CLI writes, and what it reads from standard input; tests capture and feed them. */
export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** The text sent in with the command (`mc plan preview -`). Default: standard input, read to the end. Read only when a command asks for it. */
  stdin?: () => Promise<string>;
  /** Whether standard input is a terminal, where nothing was sent in. Default: the real one; false when `stdin` is given. */
  stdinIsTerminal?: () => boolean;
}

const processIO: CliIO = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

const REPORT_PREVIEW_LINES = 40;
const TITLE_MAX_CHARS = 60;
const FOLLOW_POLL_MS = 1_000;
const EVENT_VALUE_MAX_CHARS = 120;

const CHECKPOINT_HELP =
  "stop for your check at this point: plan (before building), feature (before each feature is added), final (before finishing). Can be repeated.";

const NO_PLAN_CHECKPOINT_HELP = "do not stop for your check of the plan (only when you said you do not want to look at it first)";

const NO_OWNER_CHECKPOINT_HELP =
  "do not stop for your look at the features marked “owner” or that the second AI could not fully judge (only when you said you do not want to look at them first)";

const EXAMPLES = `
Examples:
  mc init                                   create your settings file
  mc doctor                                 check that everything is set up
  mc new "A habit tracker with a weekly streak chart" --name "Habit tracker"
  mc feature ~/mc-apps/habit-tracker "Add a dark mode"
  mc run --until 07:00                      stop working at 07:00 (24-hour clock)
  mc status                                 see how every mission is doing
  mc report                                 read the latest report
  mc stop                                   stop a run after its current step`;

/** Runs `mc` with the given argv (as in process.argv) and returns the exit code. */
export async function main(argv: string[], given: CliIO = processIO): Promise<number> {
  // Agents write much of what mc prints (report prose, findings, run errors, event summaries): control characters
  // in it could drive the terminal (OSC 52 writes the clipboard), so they never reach it.
  const io: CliIO = {
    stdout: (text) => given.stdout(stripControlChars(text)),
    stderr: (text) => given.stderr(stripControlChars(text)),
    // Copied as they are: input is read, not printed, and a field left out here would make the tests read the real standard input.
    ...(given.stdin && { stdin: given.stdin }),
    ...(given.stdinIsTerminal && { stdinIsTerminal: given.stdinIsTerminal }),
  };
  let exitCode = 0;
  const program = buildProgram(io, (code) => {
    exitCode = Math.max(exitCode, code);
  });
  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode; // commander has already explained it
    io.stderr(`${friendlyError(err)}\n`);
    return 1;
  }
}

function buildProgram(io: CliIO, setExit: (code: number) => void): Command {
  const program = new Command("mc")
    .description("Mission Control builds and improves apps with Claude Code and Codex.")
    .version(packageVersion(), "-V, --version", "show the Mission Control version")
    .helpOption("-h, --help", "show help")
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .exitOverride()
    .showHelpAfterError('(run "mc --help" to see every command)')
    .addHelpText("after", EXAMPLES);

  program
    .command("init")
    .description("create your settings file if it doesn't exist yet, and show where it is")
    .action(() => initCommand(io));

  const config = program.command("config").description("show or change one setting");
  config
    .command("get <setting>")
    .description("show a setting, for example: mc config get notify.ntfyUrl")
    .action((key: string) => configGet(io, key));
  config
    .command("set <setting> <value>")
    .description("change a setting, for example: mc config set notify.ntfyUrl https://ntfy.sh/my-topic")
    .action((key: string, value: string) => configSet(io, key, value));

  program
    .command("doctor")
    .description("check that everything Mission Control needs is set up")
    .option("--live", "also make one tiny real request to each AI (uses a little of your plans)")
    .action(async (opts: { live?: boolean }) => setExit(await doctorCommand(io, opts.live === true)));

  // The description is variadic: `mc new A habit tracker` (quotes forgotten) means the same as with quotes.
  program
    .command("new <idea...>")
    .description('queue a new app, described in your own words (best in quotes: mc new "A habit tracker")')
    .option("--name <title>", "a short name for the app")
    .option("--profile <profile>", "which AI does what: claude, codex or mixed (see your settings)")
    .option("--role <setting>", "change one role, e.g. engineer=codex:frontier (can be repeated)", collect, [])
    .option("--checkpoint <kind>", CHECKPOINT_HELP, collect, [])
    .action((idea: string[], opts: MissionOptions) => newCommand(io, idea.join(" "), opts));

  program
    .command("feature <app-folder> <request...>")
    .description("queue a change to an app that already exists")
    .option("--base <branch>", "the branch to start from (default: the one checked out)")
    .option("--name <title>", "a short name for the change")
    .option("--profile <profile>", "which AI does what: claude, codex or mixed (see your settings)")
    .option("--role <setting>", "change one role, e.g. reviewer=claude (can be repeated)", collect, [])
    .option("--checkpoint <kind>", CHECKPOINT_HELP, collect, [])
    .action((folder: string, request: string[], opts: FeatureOptions) => featureCommand(io, folder, request.join(" "), opts));

  const plan = program.command("plan").description("preview, queue and read plans written outside the team (by the leader)");
  plan
    .command("preview [file]")
    .description("show a plan in plain words and make sure it can be used; nothing is queued. Give a file, or write - to read the plan sent in with the command")
    .option("--checkpoint <kind>", CHECKPOINT_HELP, collect, [])
    .option("--no-plan-checkpoint", NO_PLAN_CHECKPOINT_HELP)
    .option("--no-owner-checkpoint", NO_OWNER_CHECKPOINT_HELP)
    .action(async (file: string | undefined, opts: PlanOptions) => setExit(await planIntakeCommand(io, "preview", file, opts)));
  plan
    .command("queue [file]")
    .description(
      "queue a plan. The team's planner is skipped and a second AI still reads the plan first. By default the mission stops for your check of the plan before anything is built. The same plan is not queued again until its mission has finished",
    )
    .option("--checkpoint <kind>", CHECKPOINT_HELP, collect, [])
    .option("--no-plan-checkpoint", NO_PLAN_CHECKPOINT_HELP)
    .option("--no-owner-checkpoint", NO_OWNER_CHECKPOINT_HELP)
    .action(async (file: string | undefined, opts: PlanOptions) => setExit(await planIntakeCommand(io, "queue", file, opts)));
  plan
    .command("show <mission>")
    .description("show the plan of a mission in plain words, all of it")
    .action((id: string) => setExit(planShowCommand(io, id)));

  program
    .command("run")
    .description("work through the queued missions")
    .option("--until <HH:MM>", "stop at this time of day (24-hour clock, your local time)")
    .option("--mission <id>", "work only on this mission")
    .option("--profile <profile>", "use this profile for this run (each mission keeps its own for later runs)")
    .option("--role <setting>", "change one role for this run, e.g. engineer=frontier (can be repeated; not saved)", collect, [])
    .action((opts: RunOptions) => runCommand(io, opts));

  program
    .command("approve <mission>")
    .description("let a mission that stopped for your check carry on (it continues on the next run)")
    .option("--note <text>", "a note for your own records; it is kept in the report")
    .action(async (id: string, opts: { note?: string }) => setExit(await answerCommand(io, "approve", id, opts.note)));

  program
    .command("send-back <mission>")
    .description("send a mission that stopped for your check back, with what to change; it asks you again")
    .option("--note <text>", "what to change (required)")
    .action(async (id: string, opts: { note?: string }) => setExit(await answerCommand(io, "send_back", id, opts.note)));

  program
    .command("status")
    .description("show every mission and how far it got")
    .option("--json", "print the list as JSON")
    .action((opts: { json?: boolean }) => statusCommand(io, opts.json === true));

  program
    .command("report [mission]")
    .description("show where a mission's report is, and its first lines (default: the latest report)")
    .action((id: string | undefined) => setExit(reportCommand(io, id)));

  program
    .command("stop")
    .description("stop the current run after its current step; its progress is kept")
    .action(() => stopCommand(io));

  program
    .command("logs <mission>")
    .description("show what happened in a mission, step by step")
    .option("--follow", "keep showing new steps as they happen (Ctrl+C to stop)")
    .action((id: string, opts: { follow?: boolean }) => logsCommand(io, id, opts.follow === true));

  program
    .command("dashboard")
    .description("show the team's progress on a web page (read-only)")
    .option("--host <address>", "the address to listen on (default: this computer only; inside the container, every address)")
    .option("--port <number>", `the port to listen on (default: ${DEFAULT_PORT})`)
    .option("--until <HH:MM>", "a stop time to show: how long is left until this time (give the same time you gave mc run)")
    .action((opts: DashboardOptions) => dashboardCommand(io, opts));

  return program;
}

interface MissionOptions {
  name?: string;
  profile?: string;
  role: string[];
  checkpoint: string[];
}

interface FeatureOptions extends MissionOptions {
  base?: string;
}

interface PlanOptions {
  checkpoint: string[];
  /** False with --no-plan-checkpoint. */
  planCheckpoint: boolean;
  /** False with --no-owner-checkpoint. Only a plan with a "review" or "owner" feature records it (as `ownerStops: false`); any other plan ignores it. */
  ownerCheckpoint?: boolean;
}

interface RunOptions {
  until?: string;
  mission?: string;
  profile?: string;
  role: string[];
}

interface DashboardOptions {
  host?: string;
  port?: string;
  until?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Store-level messages, reworded for the person at the keyboard. */
function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lock = /another mc run is active \((.+)\)/.exec(message);
  if (!lock) return message;
  const text = `A Mission Control run is already active (${lock[1]}). Check it with "mc status", or stop it with "mc stop".`;
  // A run in another container can't be checked from here: its lock counts until its heartbeat is 5 minutes old.
  if (!lock[1]?.includes(" on host ")) return text;
  return `${text} If no run is working (in Ubuntu, "docker ps" doesn't list mission-control-run), the last one was cut off: wait 5 minutes, then try again.`;
}

function say(write: (text: string) => void, ...lines: string[]): void {
  write(`${lines.join("\n")}\n`);
}

function openStore(config: Config): MissionStore {
  return new MissionStore(config.home);
}

/**
 * The store for commands that only need the Mission Control folder (stop above all), so they keep working while
 * the settings file has a problem: the folder then comes from $MC_HOME, the file's `home`, or the default.
 */
function lenientStore(io: CliIO): MissionStore {
  try {
    return openStore(loadConfig());
  } catch (err) {
    const home = fallbackHome();
    say(io.stderr, `Warning: ${friendlyError(err)}`, `Using the Mission Control folder ${home} anyway.`, "");
    return new MissionStore(home);
  }
}

function fallbackHome(): string {
  const home = process.env.MC_HOME || homeInSettingsFile() || defaultConfig().home;
  return resolve(expandHome(home));
}

/** The `home` written in the settings file, read without checking anything else. */
function homeInSettingsFile(): string | undefined {
  try {
    const settings = parseYaml(readFileSync(configPath(), "utf8")) as { home?: unknown } | null;
    return typeof settings?.home === "string" ? settings.home.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ───────────────────────────── init / config ─────────────────────────────

function initCommand(io: CliIO): void {
  const file = configPath();
  if (existsSync(file)) {
    say(io.stdout, `Your settings file already exists: ${file}`);
    return;
  }
  ensureDir(dirname(file));
  writeFileSync(file, configTemplateYaml());
  say(io.stdout, `Created your settings file: ${file}`);
}

function configGet(io: CliIO, key: string): void {
  const value = settingAt(loadConfig(), settingPath(key));
  if (value === undefined) throw new Error(`There is no setting called "${key}". Top-level settings: ${Object.keys(defaultConfig()).join(", ")}.`);
  if (value === "") say(io.stdout, "(not set)");
  else if (typeof value === "object" && value !== null) io.stdout(stringifyYaml(value));
  else say(io.stdout, String(value));
}

/** Changes one setting in the settings file, keeping its comments, and refuses values that would break it. */
function configSet(io: CliIO, key: string, raw: string): void {
  const file = configPath();
  const path = settingPath(key);
  const doc = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : configTemplateYaml());
  if (doc.errors.length > 0) {
    throw new Error(`Your settings file ${file} is not valid YAML, so it can't be changed safely. Fix it by hand first; "mc doctor" shows the problem.`);
  }
  try {
    doc.setIn(path, settingValue(path, raw));
  } catch {
    throw new Error(`"${key}" can't be set: part of that name is a single value, not a group of settings.`);
  }
  const leftOver = saveIfValid(file, doc.toString());
  say(io.stdout, `Saved: ${key} = ${raw}`, `Settings file: ${file}`);
  if (leftOver.length > 0) {
    say(
      io.stdout,
      "",
      `Your settings still have ${leftOver.length === 1 ? "a problem" : `${leftOver.length} problems`} from before:`,
      ...leftOver.map((p) => `  - ${p}`),
      'Fix it the same way (mc config set <setting> <value>), then run "mc doctor" to check.',
    );
  }
}

function settingPath(key: string): string[] {
  const path = key.split(".");
  if (path.some((part) => part.trim() === "")) {
    throw new Error(`"${key}" is not a setting name. Separate its parts with dots, for example: notify.ntfyUrl`);
  }
  return path;
}

function settingAt(root: unknown, path: string[]): unknown {
  let value = root;
  for (const part of path) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** The typed value to store: text, a number or true/false like the built-in default, else read as YAML. */
function settingValue(path: string[], raw: string): unknown {
  const current = settingAt(defaultConfig(), path);
  switch (typeof current) {
    case "string":
      return raw;
    case "number":
      return raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    case "boolean":
      if (/^(true|yes|on)$/i.test(raw)) return true;
      if (/^(false|no|off)$/i.test(raw)) return false;
      return raw;
    default:
      // A list, a group, or a name only your file has (such as your own profile): written like YAML.
      try {
        return parseYaml(raw) as unknown;
      } catch {
        return raw;
      }
  }
}

/**
 * Writes the new settings next to the file, checks them like `mc run` would, then swaps them in. Refuses a change
 * that adds a problem, saying only what is wrong with the new value: the file itself is untouched. A change that
 * adds none is saved even while other settings still have problems (so they can be fixed one at a time); those are
 * returned.
 */
function saveIfValid(file: string, text: string): string[] {
  ensureDir(dirname(file));
  const draft = `${file}.${process.pid}.draft`;
  writeFileSync(draft, text);
  let problems: string[];
  try {
    problems = settingsProblems(draft);
  } catch (err) {
    rmSync(draft, { force: true });
    const why = (err instanceof Error ? err.message : String(err)).replaceAll(draft, file);
    throw new Error(`Nothing was changed, because the new value doesn't work:\n${why}`);
  }
  const before = existsSync(file) ? settingsProblemsOrNone(file) : [];
  const added = problems.filter((p) => !before.includes(p));
  if (added.length > 0) {
    rmSync(draft, { force: true });
    throw new Error(
      [
        "Nothing was changed, because the new value doesn't work:",
        ...added.map((p) => `  - ${p}`),
        "Your settings file is as it was. Correct the value and try again.",
      ].join("\n"),
    );
  }
  renameSync(draft, file);
  return problems;
}

/**
 * The problems of the settings in `file`, one plain sentence each ([] when they are fine). Inside the container a
 * folder setting pointing where nothing is kept counts too. Throws when the file can't be read as settings at all.
 */
function settingsProblems(file: string): string[] {
  let config: Config;
  try {
    config = loadConfig(file);
  } catch (err) {
    if (err instanceof ConfigProblemsError) return err.problems;
    throw err;
  }
  return unkeptFolderProblems(config);
}

function settingsProblemsOrNone(file: string): string[] {
  try {
    return settingsProblems(file);
  } catch {
    return [];
  }
}

// ───────────────────────────── doctor ─────────────────────────────

async function doctorCommand(io: CliIO, live: boolean): Promise<number> {
  if (live) say(io.stdout, "Making one tiny request to each AI. This can take a minute or two...");
  const checks = await runDoctor({ live });
  for (const check of checks) io.stdout(formatCheck(check));
  const errors = checks.filter((c) => !c.ok && c.severity === "error").length;
  const warnings = checks.filter((c) => !c.ok && c.severity === "warn").length;
  if (errors === 0 && warnings === 0) say(io.stdout, "", "Everything looks good.");
  else say(io.stdout, "", `${plural(errors, "problem")} to fix, ${plural(warnings, "warning")}.`);
  return errors > 0 ? 1 : 0;
}

export function formatCheck(check: DoctorCheck): string {
  const mark = check.ok ? "✓" : check.severity === "error" ? "✗" : "!";
  const [first = "", ...rest] = check.detail.split("\n");
  const lines = [`${mark} ${check.name}: ${first}`, ...rest.map((line) => `    ${line}`)];
  if (!check.ok && check.fix) lines.push(`    How to fix: ${check.fix}`);
  return `${lines.join("\n")}\n`;
}

// ───────────────────────────── new / feature ─────────────────────────────

function newCommand(io: CliIO, idea: string, opts: MissionOptions): void {
  const request = idea.trim();
  if (request === "") throw new Error('Describe the app in a few words, for example: mc new "A habit tracker with a weekly chart"');
  const config = loadConfig();
  const checkpoints = checkpointChoices(opts.checkpoint);
  const mission = openStore(config).createMission({
    kind: "greenfield",
    title: missionTitle(opts.name, request),
    request,
    repoPath: "", // decided when the app is created
    baseBranch: "main",
    ...missionChoices(config, opts),
    ...(checkpoints.length > 0 && { checkpoints }),
    nowMs: Date.now(),
  });
  say(
    io.stdout,
    `Queued your new app “${mission.title}”.`,
    `Mission id: ${mission.id}`,
    ...stopLine(checkpoints),
    `It starts on the next run, for example: mc run --until 07:00`,
  );
}

async function featureCommand(io: CliIO, folder: string, requestText: string, opts: FeatureOptions): Promise<void> {
  const request = requestText.trim();
  if (request === "") throw new Error('Describe the change in a few words, for example: mc feature ~/mc-apps/my-app "Add a dark mode"');
  const config = loadConfig();
  const choices = missionChoices(config, opts);
  const checkpoints = checkpointChoices(opts.checkpoint);
  const repoPath = await checkRepo(resolve(expandHome(folder)));
  const store = openStore(config);
  const baseBranch = await checkBaseBranch(repoPath, opts.base, store);
  const mission = store.createMission({
    kind: "feature",
    title: missionTitle(opts.name, request),
    request,
    repoPath,
    baseBranch,
    ...choices,
    ...(checkpoints.length > 0 && { checkpoints }),
    nowMs: Date.now(),
  });
  say(
    io.stdout,
    `Queued a change to ${repoPath}: “${mission.title}” (starting from branch ${baseBranch}).`,
    `Mission id: ${mission.id}`,
    ...stopLine(checkpoints),
    `It starts on the next run, for example: mc run --until 07:00`,
  );
}

function missionChoices(config: Config, opts: MissionOptions): { profile: string; roleOverrides: RoleOverride[] } {
  const profile = opts.profile ?? config.defaultProfile;
  if (!Object.hasOwn(config.profiles, profile)) {
    throw new Error(`There is no profile called "${profile}". Choose one of: ${Object.keys(config.profiles).join(", ")}.`);
  }
  return { profile, roleOverrides: opts.role.map(parseRoleOverride) };
}

/** The kinds asked for with --checkpoint, each once, in the order the owner meets them. */
function checkpointChoices(given: string[]): CheckpointKind[] {
  for (const kind of given) {
    if (!CHECKPOINT_KINDS.includes(kind as CheckpointKind)) {
      throw new Error(`“${kind}” is not a checkpoint. Choose from: ${CHECKPOINT_KINDS.join(", ")}.`);
    }
  }
  return CHECKPOINT_KINDS.filter((kind) => given.includes(kind));
}

/** The queue output's extra line: where the mission will stop. */
function stopLine(kinds: CheckpointKind[]): string[] {
  if (kinds.length === 0) return [];
  const words: Record<CheckpointKind, string> = { plan: "the plan", feature: "each feature, before it is added", final: "the finished app" };
  return [`It will stop for your check: ${kinds.map((kind) => words[kind]).join(", ")}.`];
}

/** The given name, else the request's first sentence, shortened at a word boundary. */
export function missionTitle(name: string | undefined, request: string): string {
  const given = name?.replace(/\s+/g, " ").trim();
  if (given) return given;
  const sentence = (request.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "").replace(/[.!?]+$/, "");
  if (sentence.length <= TITLE_MAX_CHARS) return sentence;
  const cut = sentence.slice(0, TITLE_MAX_CHARS);
  const atWord = cut.lastIndexOf(" ") > 0 ? cut.slice(0, cut.lastIndexOf(" ")) : cut;
  return `${atWord.replace(/[\s,;:-]+$/, "")}…`;
}

/** Who is asking about a folder: `mc feature` (the texts name its command and flag) or a plan (they name its lines). */
type Asker = "command" | "plan";

/** The app folder must be the top folder of a git repository with its full history. Returns its canonical path. */
async function checkRepo(dir: string, asker: Asker = "command"): Promise<string> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const apps = join(homedir(), "mc-apps");
    const outside = inContainer() && dir !== apps && !dir.startsWith(`${apps}/`);
    // In the container a folder elsewhere on the computer looks missing: only ~/mc-apps is shared with it.
    const hint = outside
      ? " Mission Control works in a container that only sees your ~/mc-apps folder. Put the app's folder there, then give its path, " +
        'for example: mc feature ~/mc-apps/<app-folder> "<your request>"'
      : "";
    throw new Error(`There is no folder at ${dir}.${hint}`);
  }
  const git = new Git();
  const notRepo = `${dir} is not a git repository. Mission Control needs the app's git history to change it safely. ` +
    `Inside that folder, run "git init", then commit your files.`;
  if (!(await git.isRepo(dir))) throw new Error(notRepo);
  const top = await runProcess({ command: "git", args: ["rev-parse", "--show-toplevel"], cwd: dir, timeoutMs: 30_000 });
  const root = top.stdout.trim();
  if (top.exitCode !== 0 || root === "") throw new Error(notRepo);
  if (realpathSync(root) !== realpathSync(dir)) {
    const instead = asker === "plan" ? "Use the app's top folder for “folder” instead." : `Give the app's top folder instead: mc feature ${root} "..."`;
    throw new Error(`${dir} is inside the git repository ${root}. ${instead}`);
  }
  if (await git.isShallow(dir)) {
    throw new Error(`${dir} only has part of its git history (a shallow clone). Get the full history first: git -C ${dir} fetch --unshallow`);
  }
  return realpathSync(dir);
}

async function checkBaseBranch(repo: string, given: string | undefined, store: MissionStore, asker: Asker = "command"): Promise<string> {
  const git = new Git();
  let branch = given;
  if (branch === undefined) {
    try {
      branch = await git.currentBranch(repo);
    } catch {
      throw new Error(await detachedHint(git, repo, store, asker));
    }
  }
  if (!(await git.branchExists(repo, branch))) throw new Error(`There is no branch called "${branch}" in ${repo}.`);
  return branch;
}

/**
 * Why `mc feature` needs --base on a folder without a branch checked out, and how to get out of it. A report's
 * "How to try it" can leave the folder there (a detached checkout of a mission's work), so the branch that folder
 * was on before, as the last mission on it recorded it, is the way back.
 */
async function detachedHint(git: Git, repo: string, store: MissionStore, asker: Asker = "command"): Promise<string> {
  const previous = store.list().filter((m) => m.repoPath === repo && m.baseBranch !== "").at(-1)?.baseBranch;
  const candidates = [previous, "main", "master"].filter((b): b is string => b !== undefined);
  let back: string | undefined;
  for (const candidate of candidates) {
    if (await git.branchExists(repo, candidate).catch(() => false)) {
      back = candidate;
      break;
    }
  }
  const choose = asker === "plan" ? "Choose the branch to start from with a “base” line." : "Choose the branch to start from with --base <branch>.";
  if (back === undefined) return `${repo} has no branch checked out. ${choose}`;
  return (
    `${repo} has no branch checked out: it is still on a version you were trying (as a report's "How to try it" leaves it). ` +
    `Put it back on your branch first: git -C ${shownPath(repo)} checkout ${back}. Or ${choose[0]?.toLowerCase()}${choose.slice(1)}`
  );
}

/** A path as the owner can type it: inside the container, paths in its home are written with "~", which also works in Ubuntu. */
function shownPath(path: string): string {
  const home = homedir();
  if (inContainer() && path.startsWith(`${home}/`)) return `~/${shellWord(path.slice(home.length + 1))}`;
  return shellWord(path);
}

function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// ───────────────────────────── plan ─────────────────────────────

/** A plan sent in on standard input or kept in a file is read up to this many bytes: more than that cannot be a plan of 30,000 characters. */
const PLAN_READ_MAX_BYTES = 4 * PLAN_MAX_CHARS + 16;

/** The folder ~/mc-apps: the only one the container shares with the PC, and where a plan's app and plan files live. */
function appsDir(): string {
  return join(homedir(), "mc-apps");
}

/**
 * `mc plan preview` and `mc plan queue`: read a plan, check it and the app folder it names, and show it in plain words.
 * `preview` stops there; `queue` also makes the mission. Anything wrong is listed (up to 12) and nothing is queued.
 */
async function planIntakeCommand(io: CliIO, mode: "preview" | "queue", file: string | undefined, opts: PlanOptions): Promise<number> {
  // Problems with the command itself come first and alone; the plan is read only when the command is right.
  const checkpoints = planCheckpoints(opts.checkpoint, opts.planCheckpoint);
  const parsed = parsePlan(await readPlanText(io, file), { quoteFirstLine: file === "-" });
  if (!parsed.ok) return planProblems(io, parsed.problems);
  const { envelope, spec } = parsed;
  // A preview needs no settings and writes nothing; a queue makes the mission.
  const queue = mode === "queue" ? { config: loadConfig() } : undefined;
  const store = queue ? openStore(queue.config) : lenientStore(io);
  // The same plan is queued once while its mission is alive. A queue is refused; a preview, which only reads, says it as a note.
  const twin = queue ? liveMissionWithPlan(store, parsed.sha256) : liveMissionWithPlanOrNone(store, parsed.sha256);
  if (twin && queue) {
    say(io.stderr, samePlanSentence(twin));
    return 1;
  }
  let target: { repoPath: string; baseBranch: string } | undefined;
  if (envelope.folder !== undefined) {
    try {
      target = await checkPlanFolder(envelope.folder, envelope.base, store);
    } catch (err) {
      return planProblems(io, [err instanceof Error ? err.message : String(err)]);
    }
  }
  const quoted = `“${envelope.name}”`;
  const subject = target ? `a change to ~/mc-apps/${envelope.folder}, starting from branch ${target.baseBranch}` : "a new app";
  const stop = planStopLines(checkpoints, spec.features, opts.ownerCheckpoint);
  const noOwnerLook = opts.ownerCheckpoint === false && !checkpoints.includes("feature");
  const block = describePlan(spec, { request: envelope.request, style: "text", newApp: target === undefined, ...(noOwnerLook && { ownerStops: false as const }) });
  if (!queue) {
    say(
      io.stdout,
      "This plan can be used. Nothing was queued.",
      ...(twin ? [samePlanSentence(twin)] : []),
      "",
      `Plan ${quoted}: ${subject}.`,
      `Plan code: ${parsed.code} (the same plan always gets the same code).`,
      ...block,
      "",
      "What happens next:",
      "- The team's planner is skipped. This plan is used as written.",
      "- A second AI reads the plan first and may ask for changes.",
      ...stop.map((line) => `- ${line}`),
      ...checkingLines(spec.features, noOwnerLook).map((line) => `- ${line}`),
      "",
      'To queue it, run the same command with "plan queue" instead of "plan preview".',
    );
    return 0;
  }
  const now = Date.now();
  const mission = store.createMission({
    kind: target ? "feature" : "greenfield",
    title: envelope.name,
    request: envelope.request,
    repoPath: target?.repoPath ?? "", // a new app's folder is decided when it is created
    baseBranch: target?.baseBranch ?? "main",
    ...missionChoices(queue.config, { role: [], checkpoint: [] }),
    ...(checkpoints.length > 0 && { checkpoints }),
    ...(opts.ownerCheckpoint === false && spec.features.some((f) => f.mode !== undefined) && { ownerStops: false as const }),
    plan: { spec, sha256: parsed.sha256, at: new Date(now).toISOString() },
    nowMs: now,
  });
  say(
    io.stdout,
    target ? `Queued the plan ${quoted}: ${subject}.` : `Queued the plan ${quoted} for a new app.`,
    `Mission id: ${mission.id}`,
    `Plan code: ${parsed.code} (compare it with the code the preview showed).`,
    ...stop,
    `It starts on the next run, for example: mc run --mission ${mission.id}`,
    "",
    ...block,
  );
  return 0;
}

/**
 * A mission that is still alive and was queued with this very plan (the same SHA-256 of the plan in its fixed form, which
 * is what the plan code is the start of). Alive means it has not finished: queued, running, waiting for a limit, or
 * stopped (that includes a mission parked at a check), and also failed in a way the next run retries (a login that
 * expired). A mission that is done, partly done or failed for good never runs by itself again, so the same plan is a
 * fair new attempt then.
 */
function liveMissionWithPlan(store: MissionStore, sha256: string): Mission | undefined {
  return store.list().find((m) => isLive(m) && planOf(m)?.sha256 === sha256);
}

/** The same, for a preview, which only reads: a folder that cannot be listed is no reason to fail. */
function liveMissionWithPlanOrNone(store: MissionStore, sha256: string): Mission | undefined {
  try {
    return liveMissionWithPlan(store, sha256);
  } catch {
    return undefined;
  }
}

function isLive(m: Mission): boolean {
  return m.status === "queued" || m.status === "running" || m.status === "waiting" || m.status === "stopped" || (m.status === "failed" && m.failure?.retryable === true);
}

/** What the owner is told about a plan that is already queued (the leader's text quotes this sentence). */
function samePlanSentence(m: Mission): string {
  return `This plan is already queued as “${shown(m.title)}” (${m.id}). See it with: mc status`;
}

const NO_STOP_AT_ALL = "It will not stop for your check.";

/**
 * Where a plan's mission will stop, as sentences (a preview puts a hyphen in front of each; a queue does not). A plan with
 * no "review" or "owner" feature gets exactly the old lines. With one, the sentence "It will not stop for your check." would sit
 * next to a stop line and say the opposite, so it is replaced by one that is true (docs/modes-spec.md 9.2). When the owner
 * asked to stop at every feature the look lines are left out: every feature stops anyway.
 */
function planStopLines(checkpoints: CheckpointKind[], features: readonly SpecFeature[], ownerCheckpoint: boolean | undefined): string[] {
  const modes = features.filter((f) => f.mode !== undefined);
  if (modes.length === 0) return checkpoints.length > 0 ? stopLine(checkpoints) : [NO_STOP_AT_ALL];
  const skip = ownerCheckpoint === false;
  const base = checkpoints.length > 0 ? stopLine(checkpoints) : skip ? [NO_STOP_AT_ALL] : ["It will not stop for your check of the plan or of the finished app."];
  if (checkpoints.includes("feature")) return base;
  if (skip) {
    return [...base, "It will not stop for your look at features marked “owner” or at features the second AI could not fully judge. They are checked by a second AI only."];
  }
  const owner = modes.filter((f) => f.mode === "owner").map((f) => f.title);
  const review = modes.filter((f) => f.mode === "review").map((f) => f.title);
  return [
    ...base,
    ...(owner.length > 0 ? [`It will stop for your look at ${titleList(owner)}, before ${owner.length === 1 ? "it is" : "each is"} added.`] : []),
    ...(review.length > 0
      ? [`If the second AI cannot judge a check of ${titleList(review)}, it will stop for your look at ${review.length === 1 ? "that feature" : "those features"}.`]
      : []),
  ];
}

/** “A”, “A” and “B”, “A”, “B” and “C”; with more than three, the first three and "and N more". */
function titleList(titles: string[]): string {
  // A curly mark inside a title is shown as a straight one, so the marks around the titles stay in pairs.
  const quoted = titles.map((t) => `“${shown(t, 80).replace(/[“”]/g, '"')}”`);
  if (quoted.length <= 1) return quoted[0] ?? "";
  if (quoted.length <= 3) return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
  return `${quoted.slice(0, 3).join(", ")} and ${quoted.length - 3} more`;
}

// "a second AI", not "a different AI": in the Claude-only or Codex-only profile the reviewer is another session of the same company's AI
// (real run R1). This is the one sentence of a plan with no mode feature that changed on purpose (real-run defect R1-2).
const CHECKED_BY_TESTS =
  "the checks are written first, the work is done until they pass, and a second AI reviews it.";

/** What a feature checked by reading goes through, in the words every one of its preview lines starts with. */
const READING_STEPS = "the work is done, Mission Control checks it with scripts, and a second AI judges each check as passed or not, with a reason.";

/**
 * Whether the text of a feature that is checked by reading talks about a web page (the word page, a file ending in .html or .htm, a style
 * sheet, a web site, a browser). Only then does the preview say anything about pictures. The engine decides for real when the work is done,
 * from the files that changed; a plan has none yet, so this is a guess from its words, and it errs on the side of saying the line.
 */
const PAGE_WORDS = /\.html?\b|\.css\b|\b(?:pages?|html|css|stylesheets?|web ?sites?|sites?|browsers?)\b/iu;

function planTalksOfAPage(features: readonly SpecFeature[]): boolean {
  return features.some((f) => {
    if (f.mode === undefined) return false;
    const expect = f.expect;
    const texts = [f.title, f.story, ...f.acceptance, ...(expect?.headings ?? []), ...(expect?.mentions ?? [])];
    return texts.some((t) => PAGE_WORDS.test(t));
  });
}

/**
 * What the preview says about how each feature is checked. A plan with no "review" or "owner" feature gets the one old line;
 * otherwise one line for each way of checking that the plan uses, then the line about pictures. `noOwnerLook`: the owner
 * asked for no stop at the features marked for a look (and not for a stop at every feature, which would stop them anyway).
 */
function checkingLines(features: readonly SpecFeature[], noOwnerLook: boolean): string[] {
  const count = (mode: SpecFeature["mode"]): number => features.filter((f) => f.mode === mode).length;
  const [tests, review, owner] = [count(undefined), count("review"), count("owner")];
  if (review + owner === 0) return [`For each feature ${CHECKED_BY_TESTS}`];
  return [
    ...(tests > 0 ? [`Checked by tests (${tests}): ${CHECKED_BY_TESTS}`] : []),
    ...(review > 0 ? [`Checked by a second AI (${review}): ${READING_STEPS} No tests are written.`] : []),
    ...(owner > 0
      ? [
          noOwnerLook
            ? `Checked by a second AI and then by you (${owner}): ${READING_STEPS} It will be queued without a stop for your look. No tests are written.`
            : `Checked by a second AI and then by you (${owner}): ${READING_STEPS} Then the team stops for your look before the feature is added. No tests are written.`,
        ]
      : []),
    ...(planTalksOfAPage(features)
      ? ["For web pages Mission Control tries to take pictures at phone width and desktop width, and the second AI is asked to look at them. If it cannot, it says so."]
      : []),
  ];
}

/** The kinds asked for with --checkpoint, plus the plan unless --no-plan-checkpoint, in the order the owner meets them. */
function planCheckpoints(given: string[], planStop: boolean): CheckpointKind[] {
  const asked = checkpointChoices(given);
  return CHECKPOINT_KINDS.filter((kind) => asked.includes(kind) || (kind === "plan" && planStop));
}

/** The problems of a plan, up to 12, on standard error. Returns the exit code. */
function planProblems(io: CliIO, problems: string[]): number {
  const more = problems.length - PLAN_PROBLEMS_SHOWN;
  say(
    io.stderr,
    "This plan can't be used yet. Fix these and preview it again:",
    ...problems.slice(0, PLAN_PROBLEMS_SHOWN).map((p) => `- ${p}`),
    ...(more > 0 ? [`- ... and ${more} more.`] : []),
  );
  return 1;
}

/** The plan text: the file named, or with `-` what was sent in with the command. Standard input is never read unless the file is `-`. */
async function readPlanText(io: CliIO, file: string | undefined): Promise<string> {
  if (file === undefined) throw new Error("There is no plan to read. Give a file name, or write - to read the plan sent in with the command.");
  if (file === "-") {
    const terminal = io.stdinIsTerminal ?? (io.stdin ? () => false : () => process.stdin.isTTY === true);
    if (terminal()) throw new Error("Nothing was sent in. Send the plan with the command, or give a file name.");
    return (io.stdin ?? (() => readCapped(process.stdin)))();
  }
  const path = resolve(expandHome(file));
  const missing = new Error(`There is no plan file at ${path}. A file must be inside ~/mc-apps to be seen from the container; or send the plan in and write - instead.`);
  let real: string;
  try {
    real = realpathSync(path);
    if (!statSync(real).isFile() || !isInside(realpathSync(appsDir()), real)) throw missing;
  } catch {
    throw missing; // a file elsewhere in the container is not for a plan to read (its Claude login lives there)
  }
  const fd = openSync(real, "r");
  try {
    const buffer = Buffer.alloc(PLAN_READ_MAX_BYTES + 1);
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Reads a stream to its end, or until it has sent more than a plan can hold (the reader then says the plan is too long). */
export async function readCapped(source: AsyncIterable<Buffer | string>, maxBytes = PLAN_READ_MAX_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    chunks.push(buffer);
    size += buffer.length;
    if (size > maxBytes) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Whether `path` is a strict descendant of `parent` (both already real paths). */
function isInside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The folder a plan names, checked as `mc feature` checks an app folder (in the plan's words). Returns its real path and branch. */
async function checkPlanFolder(folder: string, base: string | undefined, store: MissionStore): Promise<{ repoPath: string; baseBranch: string }> {
  const dir = join(appsDir(), folder);
  if (existsSync(dir)) {
    let inside = false;
    try {
      inside = isInside(realpathSync(appsDir()), realpathSync(dir));
    } catch {
      // unreadable: treated as leading outside
    }
    if (!inside) throw new Error(`The folder “${folder}” leads outside ~/mc-apps, so it can't be used.`);
  }
  const repoPath = await checkRepo(dir, "plan");
  return { repoPath, baseBranch: await checkBaseBranch(repoPath, base, store, "plan") };
}

/** `mc plan show`: the plan a mission holds, in plain words, all of it, and who wrote it and who changed it. */
function planShowCommand(io: CliIO, id: string): number {
  const store = lenientStore(io);
  const m = findMission(store, id);
  const plan = planOf(m);
  const spec = m.spec ?? plan?.spec;
  if (!spec) {
    say(io.stderr, `“${shown(m.title)}” has no plan yet. The team's planner writes it when the mission starts.`);
    return 1;
  }
  const apps = appsDir();
  const where =
    m.kind === "greenfield"
      ? "a new app"
      : `a change to ${m.repoPath.startsWith(`${apps}${sep}`) ? `~/mc-apps/${m.repoPath.slice(apps.length + 1)}` : shownPath(m.repoPath)}`;
  // A mission file can be damaged (by hand, or by a program that crashed): the plan is shown as far as it can be, as it always was,
  // and what cannot be shown is said in a plain sentence, never as the text of a program error.
  const planned = Array.isArray(spec.features) ? spec.features.filter((f): f is SpecFeature => typeof f === "object" && f !== null) : [];
  let lines: string[];
  try {
    lines = [
      `Plan for “${shown(m.title)}” (mission ${m.id}): ${where}.`,
      plan ? `Written by the leader. Plan code ${plan.sha256.slice(0, 8)} (of the plan as the leader wrote it).` : "Written by the team's planner.",
      // A long answer of the plan reviewer stays one line here (the terminal wraps it), and the checks the team changed are listed (real runs R3b and R4).
      ...reviewLines(plan?.review, sendBacks(m, "plan"), false),
      ...checkChangeLines(plan ? checkChanges(plan.spec, spec) : [], "text"),
      "",
      ...describePlan(spec, { request: m.request, style: "text", newApp: m.kind === "greenfield" && m.repoPath === "", ...(noOwnerLookIn(m) && { ownerStops: false as const }) }),
      ...howEachWasChecked(m, planned, store),
    ];
  } catch {
    say(io.stderr, `The plan of “${shown(m.title)}” (mission ${m.id}) cannot be shown, because its file is damaged. Fix the file, or remove the mission's folder.`);
    return 1;
  }
  say(io.stdout, ...lines);
  return 0;
}

/** The mission was queued without the stops for the owner's look, and the owner did not ask for a stop at every feature (which would stop them anyway). */
function noOwnerLookIn(m: Pick<Mission, "ownerStops" | "checkpoints">): boolean {
  return m.ownerStops === false && m.checkpoints?.includes("feature") !== true;
}

/** Whether a check of the project's own was run for the feature, from its last `deliverable.checked` event: "passed", "failed" or nothing. */
function projectChecksOf(events: MissionEvent[], featureId: string): "passed" | "failed" | undefined {
  for (const e of events.toReversed()) {
    if (e.type !== "deliverable.checked" || e.data.feature !== featureId) continue;
    if (e.data.projectChecks === "passed" || e.data.projectChecks === "failed") return e.data.projectChecks;
  }
  return undefined;
}

const SHOW_CHECK_CHARS = 120;
const SHOW_EVIDENCE_CHARS = 300;
const SHOW_PROBLEMS = 3;

/**
 * The last section of `mc plan show`, only for a plan with a feature that no test checks: for each feature, in plan order,
 * how it was checked and what was found, check by check (docs/modes-spec.md 9.4). Evidence is AI-written text and goes through `cleanAiText`.
 */
function howEachWasChecked(m: Mission, planned: readonly SpecFeature[], store: MissionStore): string[] {
  if (!hasModeFeature(planned)) return [];
  let events: MissionEvent[] = [];
  try {
    events = store.readEvents(m.id);
  } catch {
    // the record of events could not be read: the section is shown without what it would add
  }
  // In the order of the plan. A feature the team has not taken up yet (a mission that was only queued) is one that nothing has checked.
  const features = planned.map((sf): Feature => m.features.find((f) => f.id === sf.id) ?? { ...sf, status: "pending", rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] });
  return ["", "How each feature was checked:", ...features.flatMap((f) => featureCheckLines(m, f, events))];
}

function featureCheckLines(m: Mission, f: Feature, events: MissionEvent[]): string[] {
  const title = `“${shown(typeof f.title === "string" ? f.title : String(f.id))}”`;
  const notDone = f.status === "blocked" || f.status === "skipped" ? "not finished, so it was not checked." : "not checked yet.";
  if (!isModeFeature(f)) {
    if (f.status !== "done") return [`- ${title}: ${notDone}`];
    const h = howChecked(m, f);
    const words = h.row === 2 ? "checked by the project's own checks only; no tests were written for it." : "checked by tests.";
    return [`- ${title}: ${words}`, ...ownerSentences(h).map((line) => `  ${line}`)];
  }
  const c = f.checked;
  if (c === undefined && f.status !== "done") return [`- ${title}: ${notDone}`];
  const h = howChecked(m, f);
  if (c === undefined || c.unfinished === true) {
    // The second AI's answer never came: only Mission Control's own checks ran, and the sentences below say so.
    return [`- ${title}: checked by Mission Control's own checks only.`, ...(c ? scriptedLines(f, c, events) : []), ...ownerSentences(h).map((line) => `  ${line}`)];
  }
  const round = Number.isInteger(c.round) && c.round > 1 ? c.round : 1;
  const times = round === 1 ? "once" : `${round} times`;
  // A taste check (it ends “(the CEO decides)”) is left for the owner, not "not judged"; unless the feature was queued without a stop for the owner's look.
  const split = unjudgedSplit(h);
  const leftForYou = new Set(split.left > 0 ? leftForYouChecks(f) : []);
  const lines = [`- ${title}: a second AI checked it against your list (checked ${times}). ${answerCounts(h.passed, h.failed, h.unjudged, split.left)}`];
  const results = Array.isArray(c.results) ? c.results : [];
  (Array.isArray(f.acceptance) ? f.acceptance : []).forEach((check, i) => {
    const r = results.find((x) => x?.n === i + 1);
    const word = r?.result === "pass" ? "passed" : r?.result === "fail" ? "failed" : leftForYou.has(i + 1) ? "left for you" : "not judged";
    const evidence = typeof r?.evidence === "string" && r.evidence.trim() !== "" ? `Evidence: ${cleanAiText(r.evidence, SHOW_EVIDENCE_CHARS)}` : "";
    lines.push(`    ${i + 1}. ${[`${word}:`, shown(typeof check === "string" ? check : "", SHOW_CHECK_CHARS), evidence].filter((part) => part !== "").join(" ")}`);
  });
  lines.push(...scriptedLines(f, c, events), ...ownerSentences(h).map((line) => `  ${line}`));
  return lines;
}

/** Mission Control's own checks, the project's own checks (when they ran) and the pictures of one checked feature. */
function scriptedLines(f: Feature, c: NonNullable<Feature["checked"]>, events: MissionEvent[]): string[] {
  const problems = Array.isArray(c.scripted?.problems) ? c.scripted.problems.filter((p): p is string => typeof p === "string") : [];
  const shownProblems = problems.slice(0, SHOW_PROBLEMS).map((p) => shown(p, 200));
  const more = problems.length > SHOW_PROBLEMS ? ` and ${problems.length - SHOW_PROBLEMS} more` : "";
  const own = shownProblems.length === 0 ? "passed." : `found: ${shownProblems.join("; ")}${more}.`;
  const project = projectChecksOf(events, f.id);
  const taken = c.pictures?.taken ?? 0;
  const images = Number.isInteger(c.pictures?.images) ? (c.pictures?.images as number) : 0;
  const why: PictureWhy | undefined = c.pictures?.why;
  // A feature that changes only a picture file has no page to draw: the images are what the second AI was given.
  const pictures =
    images > 0
      ? `  Pictures: ${taken > 0 ? `${taken} taken (phone and desktop width). ` : ""}${imagesShownWords(images)}`
      : taken > 0
        ? `  Pictures: ${taken} taken (phone and desktop width).`
        : `  Pictures: none (${pictureReason(why)}).`;
  return [`  Mission Control's own checks: ${own}${project === undefined ? "" : ` The project's own checks ${project}.`}`, pictures];
}

// ───────────────────────────── run / stop ─────────────────────────────

async function runCommand(io: CliIO, opts: RunOptions): Promise<void> {
  const parked = opts.mission === undefined ? undefined : parkedMission(opts.mission);
  if (parked?.checkpoint) {
    // Nothing to start: the mission waits for its owner, so no run (and no run summary or phone notice) is made for it.
    say(io.stdout, `“${parked.title}” is still waiting for your check (${waitingWhat(parked, parked.checkpoint)}). Nothing was started.`);
    return;
  }
  const { missions, summaryPath, waitingForYou, waitingForCheck } = await runNight({
    ...(opts.until !== undefined && { until: opts.until }),
    ...(opts.mission !== undefined && { missionId: opts.mission }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
    roleOverrides: opts.role.map(parseRoleOverride),
  });
  const lines = missions.map((m) => `- ${m.title}: ${missionOutcome(m)}`);
  // A failed mission is not "nothing queued": it waits for its owner, who needs the command that continues it.
  const help = waitingForYou.map((m) => `- ${m.title} needs your help: see what with "mc report ${m.id}", then run "mc run --mission ${m.id}"`);
  // A mission that stopped on purpose for the owner's check is not "nothing queued" either.
  const checks = waitingForCheck.flatMap((m) =>
    m.checkpoint
      ? [
          `- ${m.title} is waiting for your check (${waitingWhat(m, m.checkpoint)}). Look at it with: ${lookCommand(m, m.checkpoint)}. ` +
            `Then: mc approve ${m.id}   or   mc send-back ${m.id} --note "what to change".`,
        ]
      : [],
  );
  const nothing = waitingForYou.length > 0 || waitingForCheck.length > 0 ? "No mission could run by itself:" : "Nothing was queued. Add work with: mc new \"<your idea>\"";
  say(
    io.stdout,
    missions.length === 0 ? nothing : "Run finished:",
    ...lines,
    ...help,
    ...checks,
    `Run summary: ${summaryPath}`,
    ...(missions.length > 0 ? ["Read the report: mc report"] : []),
  );
}

/** The mission `mc run --mission` names, when it waits for its owner's check; undefined when it doesn't, or can't be read. */
function parkedMission(id: string): Mission | undefined {
  try {
    const m = openStore(loadConfig()).load(id);
    return isWaitingForCheck(m) ? m : undefined;
  } catch {
    return undefined; // runNight explains what is wrong
  }
}

function stopCommand(io: CliIO): void {
  lenientStore(io).requestStop();
  say(
    io.stdout,
    "Stop requested. A run that is going stops its current step, saves its progress, writes the report and notifies you.",
    'The next "mc run" continues where it stopped.',
  );
}

// ───────────────────────────── approve / send-back ─────────────────────────────

/**
 * Records the owner's answer to a check. It takes the run lock, the same one `mc run` takes, so it only ever writes
 * the mission file while no run holds its own copy of it; while a run is going it says so and records nothing.
 */
async function answerCommand(io: CliIO, decision: AnswerInput["decision"], id: string, note: string | undefined): Promise<number> {
  const input: AnswerInput = { decision, ...(note !== undefined && { note }) };
  if (decision === "send_back" && cleanNote(note ?? "") === "") {
    throw new Error(`Say what to change, for example: mc send-back ${id} --note "make the buttons bigger"`);
  }
  const store = lenientStore(io);
  const before = findMission(store, id);
  const early = answerProblem(before, input);
  if (early) throw new Error(problemText(before, early));
  let release: () => void;
  try {
    release = store.acquireLock();
  } catch (err) {
    if (err instanceof Error && /another mc run is active/.test(err.message)) {
      throw new Error("A run is going right now, so the answer can't be recorded safely. Wait until it ends (see: mc status), then try again.");
    }
    throw err;
  }
  let result: ReturnType<typeof applyAnswer>;
  try {
    result = applyAnswer(store, id, input, Date.now());
  } finally {
    release();
  }
  if (!result.ok) throw new Error(problemText(before, result));
  const { mission, answer } = result;
  const cp = mission.checkpoint;
  if (!cp) return 0;
  refreshReport(store, mission);
  const notice = answerNotice(mission, cp, answer);
  await notifierFor().notify(notice.title, notice.message);
  if (decision === "approve") {
    say(io.stdout, `Recorded: ${didWhat(mission, cp, decision)}.`, `It continues on the next run, for example: mc run --mission ${id}`);
  } else if (result.limit) {
    say(io.stdout, `Recorded. You have sent this back twice before, so the work stops here: ${endState(cp.kind)}. The report says what to do next.`);
  } else {
    say(io.stdout, `Recorded: ${didWhat(mission, cp, decision)}.`, `${afterSendBack(cp.kind)} (change ${result.change} of ${MAX_SEND_BACKS}).`);
  }
  return 0;
}

/**
 * Rewrites report.md so `mc report` shows that the answer is recorded, not the "waiting" block it had at the stop. The
 * stop's report was written from the template (no scout prose), so nothing is lost. Best effort: the next run writes it again.
 */
function refreshReport(store: MissionStore, m: Mission): void {
  try {
    const dir = join(store.missionDir(m.id), "screenshots");
    const screenshots = existsSync(dir) ? readdirSync(dir).filter((n) => /\.(png|jpe?g|gif|webp)$/i.test(n)).sort().map((n) => join(dir, n)) : [];
    writeFileSync(store.reportPath(m.id), renderReport(m, { prose: null, usage: store.readUsage(), screenshots, generatedAt: new Date().toISOString() }));
  } catch {
    // the answer is recorded either way
  }
}

function afterSendBack(kind: CheckpointKind): string {
  switch (kind) {
    case "plan":
      return "The planner revises it with your note and asks you again";
    case "feature":
      return "The engineer changes it with your note, the reviewer looks again, and it asks you again";
    case "final":
      return "The team adds your change as a new feature, checks it, and asks you again";
  }
}

function problemText(m: Mission, problem: AnswerProblem): string {
  switch (problem.reason) {
    case "not_waiting":
      return `“${m.title}” is not waiting for your check, so there is nothing to answer. See what it is doing with: mc status`;
    case "already_answered":
      return `You already answered this check (${problem.decision === "approve" ? "approved" : "sent back"} at ${localClock(problem.at)}). It continues on the next run.`;
    case "no_note":
      return `Say what to change, for example: mc send-back ${m.id} --note "make the buttons bigger"`;
    case "note_too_long":
      return `Your note is too long (at most ${MAX_NOTE_CHARS} characters). Shorten it and try again.`;
    case "damaged":
      return `This check can't be answered because its record is damaged. Ask the owner to run: mc run --mission ${m.id}`;
  }
}

/** The phone notifier from the settings; silent when the settings can't be read. */
function notifierFor(): Notifier {
  try {
    return createNotifier(loadConfig().notify.ntfyUrl);
  } catch {
    return { notify: async () => {} };
  }
}

// ───────────────────────────── status ─────────────────────────────

interface StatusRow {
  id: string;
  title: string;
  kind: Mission["kind"];
  status: MissionStatus;
  stage: Mission["stage"];
  featuresDone: number;
  featuresTotal: number;
  blocked: number;
  /** ISO time the mission waits for usage limits until, while it is waiting. */
  waitingUntil: string | null;
  /** Saved as running or waiting, but no run is working: the last run was cut off. The next run continues it. */
  interrupted: boolean;
  /** The owner's check the mission stops for or has just been answered; null when it has none. */
  checkpoint: null | {
    kind: CheckpointKind;
    featureId: string | null;
    round: number;
    state: "pending" | "answered";
    decision: "approve" | "send_back" | null;
  };
}

function statusCommand(io: CliIO, json: boolean): void {
  const store = lenientStore(io);
  const runActive = activeRunOf(store) !== undefined;
  const rows = store.list().map((m) => statusRow(store, m, runActive));
  if (json) {
    say(io.stdout, JSON.stringify(rows, null, 2));
    return;
  }
  // A mission whose file cannot be used is left out of the table; it is named below, so a mission that will not run is never a mystery.
  const damaged = store.damaged();
  if (rows.length === 0 && damaged.length === 0) {
    say(io.stdout, 'No missions yet. Queue one with: mc new "<your idea>"');
    return;
  }
  const table = [
    ["MISSION", "KIND", "STATUS", "STAGE", "FEATURES DONE", "BLOCKED", "WAITING UNTIL"],
    ...rows.map((r) => [
      r.id,
      r.kind === "greenfield" ? "new app" : "change",
      r.interrupted ? "interrupted" : r.checkpoint ? (r.checkpoint.state === "pending" ? "needs your check" : "answered") : r.status,
      r.stage,
      `${r.featuresDone}/${r.featuresTotal}`,
      String(r.blocked),
      r.waitingUntil ? localDateTime(Date.parse(r.waitingUntil)) : "-",
    ]),
  ];
  if (rows.length > 0) say(io.stdout, ...formatTable(table));
  damaged.forEach((d, i) =>
    say(io.stdout, ...(rows.length > 0 || i > 0 ? [""] : []), `${d.id} was left out of this list and will not run: ${d.reason}. Fix its file or remove its folder.`),
  );
  if (rows.some((r) => r.interrupted)) {
    say(
      io.stdout,
      "",
      "interrupted: the last run ended without finishing (it was stopped with docker stop, or the computer or Docker restarted). " +
        'Nothing is lost: the next "mc run" continues it.',
    );
  }
  for (const m of store.list()) {
    const cp = m.stage !== "complete" && isCheckpointShape(m.checkpoint) ? m.checkpoint : undefined;
    if (!cp) continue;
    say(
      io.stdout,
      "",
      cp.state === "pending"
        ? `“${m.title}” is waiting for your check (${waitingWhat(m, cp)}). Read it: ${lookCommand(m, cp)}. Then: mc approve ${m.id}  or  mc send-back ${m.id} --note "..."`
        : `${capitalize(didWhat(m, cp, cp.answer?.decision ?? "approve"))}. It continues on the next run: mc run`,
    );
  }
  // A failed mission waits for its owner (unless only a login expired: the next run retries that one by itself).
  for (const m of store.list().filter((x) => x.status === "failed" && x.stage !== "complete")) {
    say(
      io.stdout,
      "",
      m.failure?.retryable
        ? `${m.id} carries on by itself on the next run, once you have logged in again (see mc report ${m.id}).`
        : `${m.id} needs your help: see what with "mc report ${m.id}", then run "mc run --mission ${m.id}".`,
    );
  }
  if (store.stopRequested()) say(io.stdout, "", "A stop has been requested (mc stop).");
}

function statusRow(store: MissionStore, m: Mission, runActive: boolean): StatusRow {
  return {
    id: m.id,
    title: m.title,
    kind: m.kind,
    status: m.status,
    stage: m.stage,
    featuresDone: m.features.filter((f) => f.status === "done").length,
    featuresTotal: m.features.length,
    blocked: m.features.filter((f) => f.status === "blocked").length,
    waitingUntil: m.status === "waiting" ? lastWaitUntil(store, m.id) : null,
    interrupted: (m.status === "running" || m.status === "waiting") && !runActive,
    checkpoint: checkpointRow(m),
  };
}

/** A hand-damaged checkpoint is left out of the listing. */
function checkpointRow(m: Mission): StatusRow["checkpoint"] {
  const cp = m.checkpoint;
  if (!isCheckpointShape(cp)) return null;
  return { kind: cp.kind, featureId: cp.featureId ?? null, round: cp.round, state: cp.state, decision: cp.answer?.decision ?? null };
}

function capitalize(s: string): string {
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

/** The `mc run` holding the lock ("pid 7 on host …"), or undefined; an unreadable lock counts as no run. */
function activeRunOf(store: MissionStore): string | undefined {
  try {
    return store.activeRun();
  } catch {
    return undefined;
  }
}

function lastWaitUntil(store: MissionStore, id: string): string | null {
  const until = store.readEvents(id).findLast((e) => e.type === "limit.wait")?.data.until;
  return typeof until === "string" && !Number.isNaN(Date.parse(until)) ? until : null;
}

function formatTable(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? "").length))) ?? [];
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col] ?? 0)).join("  ").trimEnd());
}

// ───────────────────────────── report ─────────────────────────────

function reportCommand(io: CliIO, id: string | undefined): number {
  const store = lenientStore(io);
  if (id !== undefined) findMission(store, id);
  const latest = id === undefined ? latestReport(store) : undefined;
  // After a run that worked on several missions, its summary lists them all, with what each needs from you.
  const summary = id === undefined ? latestRunSummary(store, latest?.at) : undefined;
  if (summary !== undefined) {
    printPreview(io, "Run summary", summary.path);
    say(io.stdout, "", `Each mission's own report: mc report <mission>, for example: mc report ${summary.missions[0]}`);
    return 0;
  }
  const path = id === undefined ? latest?.path : store.reportPath(id);
  if (path === undefined || !existsSync(path)) {
    say(io.stdout, id === undefined ? "No reports yet. A report is written when a run finishes or stops." : `Mission ${id} has no report yet. It gets one when a run finishes or stops.`);
    return id === undefined ? 0 : 1;
  }
  printPreview(io, "Report", path);
  return 0;
}

function printPreview(io: CliIO, label: string, path: string): void {
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  say(io.stdout, `${label}: ${path}`, "", ...lines.slice(0, REPORT_PREVIEW_LINES));
  if (lines.length > REPORT_PREVIEW_LINES) say(io.stdout, "", `... ${lines.length - REPORT_PREVIEW_LINES} more lines. The full report is in: ${path}`);
  // Notepad shows a report's pictures as text; copy-reports copies them next to it as picture files.
  if (inContainer()) say(io.stdout, "To read the reports in Windows, with the screenshots as picture files next to them, run in Ubuntu: mc copy-reports");
}

/** The most recently written mission report (on a tie, the newer mission's). */
function latestReport(store: MissionStore): { path: string; at: number } | undefined {
  const reports = store
    .list()
    .reverse()
    .map((m) => store.reportPath(m.id))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, at: statSync(path).mtimeMs }));
  return reports.sort((a, b) => b.at - a.at)[0];
}

/**
 * The latest run summary (<home>/reports/run-*.md, or night-*.md as earlier runs named it), when it was written after the
 * latest mission report and that run worked on several missions: the missions it links, in order.
 */
function latestRunSummary(store: MissionStore, latestReportAt: number | undefined): { path: string; missions: string[] } | undefined {
  const dir = join(store.home, "reports");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^(?:run|night)-.*\.md$/.test(name));
  } catch {
    return undefined;
  }
  const newest = names
    .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0];
  if (newest === undefined || (latestReportAt !== undefined && newest.at < latestReportAt)) return undefined;
  const missions = [...readFileSync(newest.path, "utf8").matchAll(/\]\(\.\.\/missions\/([^/)]+)\/report\.md\)/g)].map((match) => safeDecode(match[1] ?? ""));
  return missions.length >= 2 ? { path: newest.path, missions } : undefined;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ───────────────────────────── logs ─────────────────────────────

async function logsCommand(io: CliIO, id: string, follow: boolean): Promise<void> {
  const store = lenientStore(io);
  findMission(store, id);
  const file = join(store.missionDir(id), "events.jsonl");
  if (!follow) {
    if (!existsSync(file) || statSync(file).size === 0) {
      io.stdout("Nothing has happened in this mission yet. It starts on the next `mc run`.\n");
      return;
    }
    await followEvents(file, io.stdout, AbortSignal.abort());
    return;
  }
  const stop = new AbortController();
  const onInterrupt = () => stop.abort();
  process.once("SIGINT", onInterrupt);
  try {
    await followEvents(file, io.stdout, stop.signal);
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

/**
 * Prints the events in `file` as readable lines, then keeps printing new ones until `signal` aborts (an already
 * aborted signal prints what is there and returns).
 */
export async function followEvents(file: string, write: (text: string) => void, signal: AbortSignal, pollMs = FOLLOW_POLL_MS): Promise<void> {
  const printer = new EventPrinter(write);
  let offset = 0;
  for (;;) {
    offset = printNewLines(file, offset, (line) => printer.print(line));
    if (signal.aborted) return;
    try {
      await delay(pollMs, undefined, { signal });
    } catch {
      return; // aborted
    }
  }
}

/** Reads complete lines added to `file` since byte `offset`; returns the new offset. Starts over if the file shrank. */
function printNewLines(file: string, offset: number, onLine: (line: string) => void): number {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return 0; // not created yet
  }
  try {
    const size = fstatSync(fd).size;
    const from = size < offset ? 0 : offset;
    const buffer = Buffer.alloc(size - from);
    const read = readSync(fd, buffer, 0, buffer.length, from);
    const end = buffer.subarray(0, read).lastIndexOf(0x0a) + 1; // an unfinished last line waits for the next poll
    for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) if (line.trim() !== "") onLine(line);
    return from + end;
  } finally {
    closeSync(fd);
  }
}

/** Turns event lines into "HH:MM:SS what happened", with a date line whenever the day changes. */
class EventPrinter {
  private day: string | undefined;

  constructor(private readonly write: (text: string) => void) {}

  print(line: string): void {
    const event = parseEvent(line);
    if (!event) return;
    const at = new Date(event.at);
    const day = Number.isNaN(at.getTime()) ? "" : at.toDateString();
    if (day !== "" && day !== this.day) {
      this.day = day;
      this.write(`-- ${day} --\n`);
    }
    const time = Number.isNaN(at.getTime()) ? event.at : at.toTimeString().slice(0, 8);
    this.write(`${time}  ${describeEvent(event)}\n`);
  }
}

function parseEvent(line: string): MissionEvent | undefined {
  try {
    const value = JSON.parse(line) as Partial<MissionEvent>;
    const ok = typeof value.at === "string" && typeof value.type === "string" && typeof value.data === "object" && value.data !== null;
    return ok ? (value as MissionEvent) : undefined;
  } catch {
    return undefined; // a corrupt or half-written line
  }
}

/** One event in a few words. Known types get a sentence; others list their data. */
export function describeEvent(event: MissionEvent): string {
  const d = event.data;
  const feature = typeof d.feature === "string" ? `${d.feature}: ` : "";
  const why = (value: unknown) => (value ? ` (${text(value)})` : "");
  switch (event.type) {
    case "mission.start":
    case "mission.resume":
      return `mission ${event.type === "mission.start" ? "started" : "resumed"} at stage ${text(d.stage)}`;
    case "mission.stopped":
      return `mission paused at stage ${text(d.stage)}${why(d.reason)}`;
    case "mission.failed":
      return `mission failed at stage ${text(d.stage)}${why(d.reason)}`;
    case "mission.end":
      return `mission ended: ${text(d.status)}`;
    case "stage":
      return `stage ${text(d.from)} -> ${text(d.to)}`;
    case "feature.status":
      return `${feature}${text(d.from)} -> ${text(d.to)}${why(d.reason)}`;
    case "attempt":
      return `${feature}attempt with ${text(d.model)}: ${text(d.outcome)}${why(d.summary)}`;
    case "verify":
      return `${feature}checks "${text(d.label)}" ${d.ok === true ? "passed" : "failed"} after ${seconds(d.durationMs)}`;
    case "merge":
      return `${feature}merged`;
    case "run.start":
      return `${text(d.role)} started on ${text(d.model)} (${text(d.effort)} effort) [${text(d.jobId)}]`;
    case "run.end":
      return `${text(d.label)} ended: ${text(d.outcome)} after ${seconds(d.durationMs)}${why(d.error)}`;
    case "limit.wait":
      return `waiting for usage limits until ${typeof d.until === "string" ? localDateTime(Date.parse(d.until)) : "?"}`;
    case "report":
      return `report written: ${text(d.path)}`;
    case "error":
      return `${feature}error: ${text(d.message)}`;
    case "checkpoint.parked":
      return `waiting for your check of ${checkpointWords(d)}${d.round !== undefined && d.round !== 1 ? ` (shown ${text(d.round)} times)` : ""}`;
    case "checkpoint.answered":
      return d.decision === "approve" ? `you approved ${checkpointWords(d)}` : `you sent ${checkpointWords(d)} back`;
    case "checkpoint.reworked":
      return d.ok === false ? `your change to ${checkpointWords(d)} could not be made; the earlier version is shown again` : `${checkpointWords(d)} was changed after your note`;
    case "checkpoint.passed":
      return `your answer was applied: ${text(d.id)}`;
    case "checkpoint.limit":
      return `you sent ${checkpointWords(d)} back twice before, so the work stops there`;
    case "checkpoint.rejected":
      return `an answer to the check ${text(d.id)} was ignored (${text(d.reason)}); the check is still waiting`;
    case "deliverable.checked": {
      const found = typeof d.problems === "number" && Number.isFinite(d.problems) ? d.problems : 0;
      const project = d.projectChecks === "passed" || d.projectChecks === "failed" ? `. The project's own checks ${d.projectChecks}.` : "";
      return `${feature}Mission Control's own checks ${d.ok === true ? "passed" : `found ${found} ${found === 1 ? "problem" : "problems"}`} (${attemptWords(d.label)})${project}`;
    }
    case "pictures.taken": {
      const taken = typeof d.taken === "number" && Number.isFinite(d.taken) ? d.taken : 0;
      if (taken > 0) return `${feature}took ${taken} ${taken === 1 ? "picture" : "pictures"} of the page`;
      return `${feature}no pictures were taken (${pictureReason(isPictureWhy(d.why) ? d.why : undefined)})`;
    }
    case "rubric.checked": {
      const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
      const downgraded = n(d.downgraded);
      const trust = downgraded > 0 ? ` (${downgraded} ${downgraded === 1 ? "answer was" : "answers were"} not trusted)` : "";
      return `${feature}a second AI checked it against the list (round ${n(d.round)}): ${n(d.pass)} passed, ${n(d.fail)} failed, ${n(d.unjudged)} could not be judged${trust}`;
    }
    default: {
      const details = Object.entries(d).map(([key, value]) => `${key}=${text(value)}`);
      return details.length > 0 ? `${event.type}: ${details.join(", ")}` : event.type;
    }
  }
}

/** "attempt 2" for the label `a2`, "fix round 1" for `fix1`; anything else as written. */
function attemptWords(label: unknown): string {
  const text = typeof label === "string" ? label : "";
  const attempt = /^a([0-9]{1,3})$/.exec(text);
  if (attempt) return `attempt ${attempt[1]}`;
  const fix = /^fix([0-9]{1,3})$/.exec(text);
  return fix ? `fix round ${fix[1]}` : `attempt ${text === "" ? "?" : text.slice(0, 20)}`;
}

function isPictureWhy(x: unknown): x is PictureWhy {
  return x === "no_tool" || x === "no_browser" || x === "start_failed" || x === "too_slow" || x === "reviewer" || x === "not_plain_file";
}

/** What a checkpoint event is about, from its data: the plan, a feature, the finished app. Never the owner's note. */
function checkpointWords(d: Record<string, unknown>): string {
  switch (d.kind) {
    case "plan":
      return "the plan";
    case "feature":
      return `${text(d.feature)} (before it is added)`;
    case "final":
      return "the finished app";
    default:
      return text(d.id);
  }
}

function text(value: unknown): string {
  const s = typeof value === "string" ? value : value === undefined ? "?" : JSON.stringify(value);
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > EVENT_VALUE_MAX_CHARS ? `${flat.slice(0, EVENT_VALUE_MAX_CHARS - 1)}…` : flat;
}

function seconds(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "?";
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

// ───────────────────────────── dashboard ─────────────────────────────

/** Serves the read-only dashboard until Ctrl+C (or a stop signal from Docker). It never writes into the home. */
async function dashboardCommand(io: CliIO, opts: DashboardOptions): Promise<void> {
  const port = opts.port === undefined ? DEFAULT_PORT : parsePort(opts.port);
  const store = lenientStore(io);
  let settings = builtInSettings();
  try {
    settings = settingsFromConfig(loadConfig());
  } catch {
    // lenientStore has already said what is wrong with the settings; the page uses the built-in ones
  }
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await runDashboard({
      home: store.home,
      settings,
      host: opts.host ?? (inContainer() ? "0.0.0.0" : "127.0.0.1"),
      port,
      ...(opts.until !== undefined && { until: opts.until }),
      say: (line) => say(io.stdout, line),
      signal: stop.signal,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

// ───────────────────────────── Helpers ─────────────────────────────

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "HH:MM" today, else "YYYY-MM-DD HH:MM", in local time. */
function localDateTime(ms: number): string {
  if (Number.isNaN(ms)) return "?";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** True when this file is the program being run (also through the `mc` symlink npm creates). */
function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // Not "node": an agent's `pkill node` or `killall node` (say, to free a port) must not take Mission Control down.
  process.title = "mission-control";
  // `mc report | head` closes the pipe early; that is not an error.
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
  });
  process.exitCode = await main(process.argv);
}
