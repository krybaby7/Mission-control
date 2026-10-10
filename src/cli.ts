#!/usr/bin/env node
// `mc`: the Mission Control command line. Every command prints plain language; the exit code is 0 when it worked
// and 1 when it didn't.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { ConfigProblemsError, configPath, configTemplateYaml, defaultConfig, inContainer, loadConfig, parseRoleOverride } from "./config.js";
import { type DoctorCheck, runDoctor, unkeptFolderProblems } from "./doctor.js";
import { Git } from "./git.js";
import { packageRoot } from "./prompts.js";
import { findMission, missionOutcome, runNight } from "./run.js";
import { MissionStore } from "./state.js";
import type { Config, Mission, MissionEvent, MissionStatus, RoleOverride } from "./types.js";
import { ensureDir, expandHome } from "./util/fs.js";
import { runProcess } from "./util/process.js";
import { stripControlChars } from "./util/terminal.js";

/** Where the CLI writes; tests capture it. */
export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processIO: CliIO = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

const REPORT_PREVIEW_LINES = 40;
const TITLE_MAX_CHARS = 60;
const FOLLOW_POLL_MS = 1_000;
const EVENT_VALUE_MAX_CHARS = 120;

const EXAMPLES = `
Examples:
  mc init                                   create your settings file
  mc doctor                                 check that everything is set up
  mc new "A habit tracker with a weekly streak chart" --name "Habit tracker"
  mc feature ~/mc-apps/habit-tracker "Add a dark mode"
  mc run --until 07:00                      work until 7 in the morning
  mc status                                 see how every mission is doing
  mc report                                 read the latest report
  mc stop                                   stop a run after its current step`;

/** Runs `mc` with the given argv (as in process.argv) and returns the exit code. */
export async function main(argv: string[], given: CliIO = processIO): Promise<number> {
  // Agents write much of what mc prints (report prose, findings, run errors, event summaries): control characters
  // in it could drive the terminal (OSC 52 writes the clipboard), so they never reach it.
  const io: CliIO = { stdout: (text) => given.stdout(stripControlChars(text)), stderr: (text) => given.stderr(stripControlChars(text)) };
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
    .description("Mission Control builds and improves apps overnight with Claude Code and Codex.")
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
    .action((idea: string[], opts: MissionOptions) => newCommand(io, idea.join(" "), opts));

  program
    .command("feature <app-folder> <request...>")
    .description("queue a change to an app that already exists")
    .option("--base <branch>", "the branch to start from (default: the one checked out)")
    .option("--name <title>", "a short name for the change")
    .option("--profile <profile>", "which AI does what: claude, codex or mixed (see your settings)")
    .option("--role <setting>", "change one role, e.g. reviewer=claude (can be repeated)", collect, [])
    .action((folder: string, request: string[], opts: FeatureOptions) => featureCommand(io, folder, request.join(" "), opts));

  program
    .command("run")
    .description("work through the queued missions")
    .option("--until <HH:MM>", "stop at this time of day (24-hour clock, your local time)")
    .option("--mission <id>", "work only on this mission")
    .option("--profile <profile>", "use this profile tonight (each mission keeps its own for later runs)")
    .option("--role <setting>", "change one role tonight, e.g. engineer=frontier (can be repeated; not saved)", collect, [])
    .action((opts: RunOptions) => runCommand(io, opts));

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

  return program;
}

interface MissionOptions {
  name?: string;
  profile?: string;
  role: string[];
}

interface FeatureOptions extends MissionOptions {
  base?: string;
}

interface RunOptions {
  until?: string;
  mission?: string;
  profile?: string;
  role: string[];
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
  const mission = openStore(config).createMission({
    kind: "greenfield",
    title: missionTitle(opts.name, request),
    request,
    repoPath: "", // decided when the app is created
    baseBranch: "main",
    ...missionChoices(config, opts),
    nowMs: Date.now(),
  });
  say(io.stdout, `Queued your new app "${mission.title}".`, `Mission id: ${mission.id}`, `It starts on the next run, for example: mc run --until 07:00`);
}

async function featureCommand(io: CliIO, folder: string, requestText: string, opts: FeatureOptions): Promise<void> {
  const request = requestText.trim();
  if (request === "") throw new Error('Describe the change in a few words, for example: mc feature ~/mc-apps/my-app "Add a dark mode"');
  const config = loadConfig();
  const choices = missionChoices(config, opts);
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
    nowMs: Date.now(),
  });
  say(
    io.stdout,
    `Queued a change to ${repoPath}: "${mission.title}" (starting from branch ${baseBranch}).`,
    `Mission id: ${mission.id}`,
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

/** The app folder must be the top folder of a git repository with its full history. Returns its canonical path. */
async function checkRepo(dir: string): Promise<string> {
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
    throw new Error(`${dir} is inside the git repository ${root}. Give the app's top folder instead: mc feature ${root} "..."`);
  }
  if (await git.isShallow(dir)) {
    throw new Error(`${dir} only has part of its git history (a shallow clone). Get the full history first: git -C ${dir} fetch --unshallow`);
  }
  return realpathSync(dir);
}

async function checkBaseBranch(repo: string, given: string | undefined, store: MissionStore): Promise<string> {
  const git = new Git();
  let branch = given;
  if (branch === undefined) {
    try {
      branch = await git.currentBranch(repo);
    } catch {
      throw new Error(await detachedHint(git, repo, store));
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
async function detachedHint(git: Git, repo: string, store: MissionStore): Promise<string> {
  const previous = store.list().filter((m) => m.repoPath === repo && m.baseBranch !== "").at(-1)?.baseBranch;
  const candidates = [previous, "main", "master"].filter((b): b is string => b !== undefined);
  let back: string | undefined;
  for (const candidate of candidates) {
    if (await git.branchExists(repo, candidate).catch(() => false)) {
      back = candidate;
      break;
    }
  }
  const choose = "Choose the branch to start from with --base <branch>.";
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

// ───────────────────────────── run / stop ─────────────────────────────

async function runCommand(io: CliIO, opts: RunOptions): Promise<void> {
  const { missions, summaryPath, waitingForYou } = await runNight({
    ...(opts.until !== undefined && { until: opts.until }),
    ...(opts.mission !== undefined && { missionId: opts.mission }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
    roleOverrides: opts.role.map(parseRoleOverride),
  });
  const lines = missions.map((m) => `- ${m.title}: ${missionOutcome(m)}`);
  // A failed mission is not "nothing queued": it waits for its owner, who needs the command that continues it.
  const help = waitingForYou.map((m) => `- ${m.title} needs your help: see what with "mc report ${m.id}", then run "mc run --mission ${m.id}"`);
  const nothing = waitingForYou.length > 0 ? "No mission could run by itself:" : "Nothing was queued. Add work with: mc new \"<your idea>\"";
  say(
    io.stdout,
    missions.length === 0 ? nothing : "Night finished:",
    ...lines,
    ...help,
    `Night summary: ${summaryPath}`,
    ...(missions.length > 0 ? ["Read the report: mc report"] : []),
  );
}

function stopCommand(io: CliIO): void {
  lenientStore(io).requestStop();
  say(
    io.stdout,
    "Stop requested. A running night run stops its current step, saves its progress, writes the report and notifies you.",
    'The next "mc run" continues where it stopped.',
  );
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
}

function statusCommand(io: CliIO, json: boolean): void {
  const store = lenientStore(io);
  const runActive = activeRunOf(store) !== undefined;
  const rows = store.list().map((m) => statusRow(store, m, runActive));
  if (json) {
    say(io.stdout, JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    say(io.stdout, 'No missions yet. Queue one with: mc new "<your idea>"');
    return;
  }
  const table = [
    ["MISSION", "KIND", "STATUS", "STAGE", "FEATURES DONE", "BLOCKED", "WAITING UNTIL"],
    ...rows.map((r) => [
      r.id,
      r.kind === "greenfield" ? "new app" : "change",
      r.interrupted ? "interrupted" : r.status,
      r.stage,
      `${r.featuresDone}/${r.featuresTotal}`,
      String(r.blocked),
      r.waitingUntil ? localDateTime(Date.parse(r.waitingUntil)) : "-",
    ]),
  ];
  say(io.stdout, ...formatTable(table));
  if (rows.some((r) => r.interrupted)) {
    say(
      io.stdout,
      "",
      "interrupted: the last run ended without finishing (it was stopped with docker stop, or the computer or Docker restarted). " +
        'Nothing is lost: the next "mc run" continues it.',
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
  };
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
  // After a night that worked on several missions, its summary lists them all, with what each needs from you.
  const night = id === undefined ? latestNightSummary(store, latest?.at) : undefined;
  if (night !== undefined) {
    printPreview(io, "Night summary", night.path);
    say(io.stdout, "", `Each mission's own report: mc report <mission>, for example: mc report ${night.missions[0]}`);
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
 * The latest night summary (<home>/reports/night-*.md), when it was written after the latest mission report and
 * that night worked on several missions: the missions it links, in order.
 */
function latestNightSummary(store: MissionStore, latestReportAt: number | undefined): { path: string; missions: string[] } | undefined {
  const dir = join(store.home, "reports");
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^night-.*\.md$/.test(name));
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
    default: {
      const details = Object.entries(d).map(([key, value]) => `${key}=${text(value)}`);
      return details.length > 0 ? `${event.type}: ${details.join(", ")}` : event.type;
    }
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
