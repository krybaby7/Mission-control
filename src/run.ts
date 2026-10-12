// The night run behind `mc run`: takes the run lock, works through the queued missions one at a time until they
// are finished, a stop is requested or the deadline passes, then writes the night summary and notifies.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isWaitingForCheck, parkedNotice, waitingWhat } from "./checkpoint.js";
import { loadConfig } from "./config.js";
import { Dispatcher } from "./dispatcher.js";
import { RoleExecutor, type WaitCause } from "./executor.js";
import { Git } from "./git.js";
import { createNotifier, type Notifier } from "./notify.js";
import { QuotaGovernor } from "./quota.js";
import { renderReport } from "./report.js";
import { createRunners } from "./runners/index.js";
import { MissionStore } from "./state.js";
import type { AgentRunner, Clock, Config, Logger, Mission, MissionStatus, Provider, RoleOverride } from "./types.js";
import { systemClock } from "./util/clock.js";
import { ensureDir, expandHome } from "./util/fs.js";
import { createLogger, type LevelLogger } from "./util/logger.js";
import { killTree } from "./util/process.js";
import { Verifier } from "./verify.js";

export interface NightOptions {
  /** "HH:MM" local time: no work starts after it, and work still running then is stopped. */
  until?: string;
  /** Run only this mission (whatever its status). */
  missionId?: string;
  /** Use this profile for the missions run tonight; each keeps its own for later runs. */
  profile?: string;
  /** Role overrides for tonight, on top of each mission's own (a later override wins field by field). Not saved. */
  roleOverrides?: RoleOverride[];
  config?: Config;
  clock?: Clock;
  /** Default: info lines on the console, everything (agent progress included) in <home>/logs/night-<date>.log. */
  logger?: Logger;
  /** Tests: stand-ins for the CLI runners. */
  runners?: Partial<Record<Provider, AgentRunner>>;
}

export interface NightResult {
  /** Every mission worked on tonight, as it ended. */
  missions: Mission[];
  summaryPath: string;
  /** Failed missions that wait for their owner (see needsOwner), whether or not they ran tonight. */
  waitingForYou: Mission[];
  /** Missions stopped on purpose for the owner's check (see isWaitingForCheck), whether or not they ran tonight. */
  waitingForCheck: Mission[];
}

/** How often the STOP file and the deadline are checked while an agent or a test run is busy. */
const STOP_POLL_MS = 1_000;
/** Waits shorter than this are not worth a phone notification. */
const WAIT_NOTICE_MIN_MS = 10 * 60_000;
/**
 * The furthest a night's stop time may be. --until always means the next time the clock shows it, so a run started
 * just after that time (a morning test, a delayed scheduled start) would otherwise work about 24 hours, through
 * the owner's day. A run at 13:00 with --until 07:00 is still fine.
 */
const MAX_NIGHT_MS = 18 * 60 * 60_000;
/** Signals that stop the night gracefully (SIGHUP: the terminal was closed), with the exit code of a forced quit. */
const STOP_SIGNALS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** The next time the clock shows HH:MM (local time), strictly after nowMs. */
export function parseUntil(hhmm: string, nowMs: number): number {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(hhmm);
  const hours = Number(match?.[1]);
  const minutes = Number(match?.[2]);
  if (!match || hours > 23 || minutes > 59) {
    throw new Error(`"${hhmm}" is not a time of day. Write it as HH:MM in 24-hour time, for example 07:00 or 23:30.`);
  }
  const at = new Date(nowMs);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= nowMs) {
    at.setDate(at.getDate() + 1);
    at.setHours(hours, minutes, 0, 0); // again: a daylight-saving change in between shifts the hour
  }
  return at.getTime();
}

/** Works through the queue (or one mission) until done, stopped or out of time. Throws only for setup problems. */
export async function runNight(opts: NightOptions = {}): Promise<NightResult> {
  const config = withAbsolutePaths(opts.config ?? loadConfig());
  const clock = opts.clock ?? systemClock;
  const startedAt = clock.now();
  const deadline = opts.until === undefined ? undefined : parseUntil(opts.until, startedAt);
  if (opts.until !== undefined && deadline !== undefined) checkNightLength(opts.until, startedAt, deadline);
  checkProfile(config, opts.profile);
  const store = new MissionStore(config.home);
  if (opts.missionId !== undefined) findMission(store, opts.missionId);
  const logger = opts.logger ?? nightLogger(config.home, startedAt);
  const notifier = createNotifier(config.notify.ntfyUrl, logger);
  const release = store.acquireLock();
  const stop = new StopControl({ store, clock, deadline, logger, onForceExit: release });
  try {
    store.clearStop();
    logger.info(deadline === undefined ? "Working until the queue is done (no stop time given)." : `Working until ${describeDeadline(deadline, startedAt)}.`);
    const night: Night = { config, clock, store, logger, notifier, stop, deadline, startedAt, opts };
    await reportInterruptedRun(night);
    await repairCheckpointNotices(night);
    const dispatcher = buildDispatcher(night, opts.runners);
    const missions = await workThroughQueue(night, dispatcher, opts.missionId);
    const waitingForYou = store.list().filter(needsOwner);
    const waitingForCheck = store.list().filter(isWaitingForCheck);
    const summaryPath = writeSummary(night, missions, waitingForYou, waitingForCheck);
    logger.info(`Night finished. Summary: ${summaryPath}`);
    const priority = missions.some((m) => m.status === "failed") || waitingForYou.length > 0 || waitingForCheck.length > 0 ? "high" : "default";
    await notifier.notify("Night finished", nightMessage(missions, waitingForYou, waitingForCheck), { priority });
    return { missions, summaryPath, waitingForYou, waitingForCheck };
  } catch (err) {
    logger.error(`The night run stopped because of an error: ${errorText(err)}`);
    await notifier.notify("Mission Control stopped", `The night run stopped because of an error: ${errorText(err)}`, { priority: "high" });
    throw err;
  } finally {
    stop.dispose();
    release();
  }
}

// ───────────────────────────── Setup ─────────────────────────────

interface Night {
  /** Set when the night ended because no mission could do any work (see Dispatcher.noWorkPossible). */
  noWork?: string;
  config: Config;
  clock: Clock;
  store: MissionStore;
  logger: Logger;
  notifier: Notifier;
  stop: StopControl;
  deadline: number | undefined;
  startedAt: number;
  opts: NightOptions;
}

function withAbsolutePaths(c: Config): Config {
  return { ...c, home: resolve(expandHome(c.home)), workspaceRoot: resolve(expandHome(c.workspaceRoot)) };
}

/** Refuses a stop time that passed only a little while ago, which would mean working through the day. */
function checkNightLength(until: string, startedAt: number, deadline: number): void {
  if (deadline - startedAt <= MAX_NIGHT_MS) return;
  const hours = Math.round((deadline - startedAt) / 3_600_000);
  const suggestion = clockTime(startedAt + 4 * 3_600_000).replace(/:\d\d$/, ":00");
  throw new Error(
    `It's ${clockTime(startedAt)} now, already past ${until}, so this run would work until ${describeDeadline(deadline, startedAt)}: ` +
      `about ${hours} hours, through your day. Nothing was started. To work now anyway, give a stop time later today, ` +
      `for example: mc run --until ${suggestion}`,
  );
}

/** "07:00 tomorrow (Sun Oct 11)" or "23:30 today", in local time. */
function describeDeadline(deadline: number, startedAt: number): string {
  const day = localDate(deadline) === localDate(startedAt) ? "today" : `tomorrow (${new Date(deadline).toDateString().slice(0, 10)})`;
  return `${clockTime(deadline)} ${day}`;
}

function checkProfile(config: Config, profile: string | undefined): void {
  if (profile === undefined || Object.hasOwn(config.profiles, profile)) return;
  throw new Error(`There is no profile called "${profile}". Choose one of: ${Object.keys(config.profiles).join(", ")}.`);
}

/** Loads a mission named on the command line; says in plain words whether it is missing or its file is broken. */
export function findMission(store: MissionStore, id: string): Mission {
  if (!missionFileExists(store, id)) throw new Error(`There is no mission called "${id}". See your missions with: mc status`);
  try {
    return store.load(id);
  } catch (err) {
    throw new Error(`Mission ${id} exists, but its file can't be read: ${errorText(err)}`);
  }
}

function missionFileExists(store: MissionStore, id: string): boolean {
  try {
    return existsSync(join(store.missionDir(id), "mission.json"));
  } catch {
    return false; // not usable as a folder name, e.g. "../x"
  }
}

/** Info lines on the console; the log file also gets debug lines (agent progress). */
function nightLogger(home: string, startedAt: number): LevelLogger {
  const file = createLogger({ file: join(home, "logs", `night-${localDate(startedAt)}.log`), level: "debug" });
  const screen = createLogger({ console: true, level: "info" });
  return {
    debug: (msg, data) => file.debug(msg, data),
    info: (msg, data) => (file.info(msg, data), screen.info(msg, data)),
    warn: (msg, data) => (file.warn(msg, data), screen.warn(msg, data)),
    error: (msg, data) => (file.error(msg, data), screen.error(msg, data)),
  };
}

function buildDispatcher(night: Night, givenRunners: Partial<Record<Provider, AgentRunner>> | undefined): Dispatcher {
  const { config, clock, store, logger, stop, deadline } = night;
  const runners = givenRunners ?? createRunners(config, { logger });
  const quota = new QuotaGovernor({ clock, config, statePath: join(config.home, "quota.json"), logger });
  const stopCheck = () => stop.requested();
  // The executor reports limit waits; the dispatcher (created below) marks its mission "waiting".
  let dispatcher: Dispatcher | undefined;
  const executor = new RoleExecutor({
    config,
    runners,
    quota,
    clock,
    store,
    logger,
    signal: stop.signal,
    stopCheck,
    onWaiting: (until, reason, cause) => {
      dispatcher?.onWaiting(until, reason);
      announceWait(night, until, cause);
    },
    ...(deadline !== undefined && { deadline }),
  });
  dispatcher = new Dispatcher({
    config,
    store: new TonightStore(config.home, night.opts),
    git: new Git({ logger }),
    executor,
    quota,
    clock,
    logger,
    notifier: night.notifier,
    verifierFor: (missionId) =>
      new Verifier({ logsDir: store.logsDir(missionId), timeoutMs: config.limits.verifyTimeoutMs, logger, signal: stop.signal }),
    stopCheck,
    ...(deadline !== undefined && { deadline }),
  });
  return dispatcher;
}

/**
 * The store as the dispatcher sees it: a mission it loads carries tonight's --profile / --role choices on top of its
 * own, and every save writes the mission's own choices back, so tonight's never outlive the run (even a killed one).
 */
class TonightStore extends MissionStore {
  private readonly own = new Map<string, Pick<Mission, "profile" | "roleOverrides">>();

  constructor(
    home: string,
    private readonly choices: Pick<NightOptions, "profile" | "roleOverrides">,
  ) {
    super(home);
  }

  override load(id: string): Mission {
    const m = super.load(id);
    this.own.set(id, { profile: m.profile, roleOverrides: m.roleOverrides });
    // The dispatcher merges a role's overrides in order, field by field: tonight's come last, so they win.
    const roleOverrides = [...m.roleOverrides, ...(this.choices.roleOverrides ?? [])];
    return { ...m, profile: this.choices.profile ?? m.profile, roleOverrides };
  }

  override save(m: Mission, nowMs?: number): void {
    const stored = { ...m, ...this.own.get(m.id) };
    super.save(stored, nowMs);
    m.updatedAt = stored.updatedAt;
  }
}

/**
 * Tells the phone when no usable AI can work for a while: because of usage limits, or because the AIs are overloaded,
 * unreachable or failing (a network outage is not a usage limit). Waits never overlap, so each is told once.
 */
function announceWait(night: Night, until: number, cause: WaitCause): void {
  if (until - night.clock.now() < WAIT_NOTICE_MIN_MS) return;
  if (cause === "trouble") {
    void night.notifier.notify(
      "Waiting for the AIs to respond",
      `The AIs Mission Control may use are not responding or keep failing right now (a network or service problem, not a usage limit). It tries again at ${clockTime(until)}; if this goes on, it pauses the work and tells you.`,
    );
    return;
  }
  void night.notifier.notify(
    "Waiting for usage limits",
    `Every AI Mission Control may use is at its usage limit. It waits until ${clockTime(until)}, then carries on.`,
  );
}

// ───────────────────────────── Stopping ─────────────────────────────

type StopReason = "stop file" | "signal" | "deadline";

/**
 * Turns every reason to stop (the STOP file from `mc stop`, Ctrl+C, SIGTERM or a closed terminal, the deadline) into
 * one AbortSignal, which also aborts the running agent or test command. A second signal quits at once.
 */
class StopControl {
  reason: StopReason | undefined;
  private readonly controller = new AbortController();
  private readonly poller: NodeJS.Timeout;
  private signalsSeen = 0;

  constructor(
    private readonly deps: { store: MissionStore; clock: Clock; deadline: number | undefined; logger: Logger; onForceExit: () => void },
  ) {
    this.poller = setInterval(() => this.poll(), STOP_POLL_MS);
    this.poller.unref();
    for (const signal of stopSignals()) process.on(signal, this.onSignal);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  requested(): boolean {
    this.poll();
    return this.controller.signal.aborted;
  }

  dispose(): void {
    clearInterval(this.poller);
    for (const signal of stopSignals()) process.off(signal, this.onSignal);
  }

  private poll(): void {
    if (this.controller.signal.aborted) return;
    const { store, clock, deadline } = this.deps;
    if (store.stopRequested()) this.stop("stop file", "Stop requested: finishing up, saving progress and writing the report.");
    else if (deadline !== undefined && clock.now() >= deadline) this.stop("deadline", "It's time to stop: saving progress and writing the report.");
  }

  private stop(reason: StopReason, message: string): void {
    this.reason = reason;
    this.deps.logger.info(message);
    this.controller.abort();
  }

  private readonly onSignal = (signal: NodeJS.Signals): void => {
    if (++this.signalsSeen === 1) {
      this.stop("signal", "Stopping: saving progress and writing the report. Press Ctrl+C again to quit at once.");
      return;
    }
    this.deps.logger.warn("Quitting at once. Unfinished work continues on the next run.");
    // Their own SIGTERM-then-SIGKILL timer dies with this process, so a child ignoring SIGTERM would live on.
    for (const pid of childGroupLeaders()) killTree(pid, "SIGKILL");
    this.deps.onForceExit();
    process.exit(STOP_SIGNALS[signal] ?? 1);
  };
}

function stopSignals(): NodeJS.Signals[] {
  return Object.keys(STOP_SIGNALS) as NodeJS.Signals[];
}

/**
 * This process's children that lead their own process group: the agents and test commands (runProcess starts
 * each that way). Linux /proc only; [] elsewhere.
 */
function childGroupLeaders(): number[] {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  return names.filter((name) => /^\d+$/.test(name) && isChildGroupLeader(Number(name))).map(Number);
}

function isChildGroupLeader(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // "pid (comm) state ppid pgrp …": comm may contain spaces and parentheses.
    const [, ppid, pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return Number(ppid) === process.pid && Number(pgrp) === pid;
  } catch {
    return false; // it has exited
  }
}

// ───────────────────────────── Missions ─────────────────────────────

async function workThroughQueue(night: Night, dispatcher: Dispatcher, onlyId: string | undefined): Promise<Mission[]> {
  const worked: Mission[] = [];
  const seen = new Set<string>();
  while (!night.stop.requested()) {
    const next = nextMission(night.store, seen, onlyId);
    if (!next) break;
    seen.add(next.id);
    worked.push(await runOne(night, dispatcher, next));
    // Every login expired, every AI limited past the deadline, a full disk: the next mission would only set up its
    // worktrees and installs to stop again at once. It waits for the next run instead.
    const noWork = dispatcher.noWorkPossible();
    if (noWork !== undefined && nextMission(night.store, seen, onlyId)) {
      night.noWork = noWork;
      night.logger.warn(`Ending the night early: ${noWork}. The remaining missions wait for the next run.`);
      break;
    }
  }
  return worked;
}

/**
 * Missions left "running" or "waiting" mean the last run died without finishing (it was killed, the container or the
 * computer went down): it wrote no report and sent nothing, so the phone hears about it now. They carry on tonight.
 */
async function reportInterruptedRun(night: Night): Promise<void> {
  const interrupted = night.store.list().filter((m) => m.status === "running" || m.status === "waiting");
  if (interrupted.length === 0) return;
  const last = interrupted.map((m) => Date.parse(m.updatedAt)).reduce((a, b) => Math.max(a, b));
  const names = interrupted.map((m) => oneLine(m.title)).join(", ");
  const message = `The last run stopped unexpectedly around ${clockTime(last)} while working on ${names}, without writing its report. The work so far is kept and carries on now.`;
  night.logger.warn(message);
  await night.notifier.notify("Mission Control stopped unexpectedly", message, { priority: "high", tags: ["warning"] });
}

/**
 * A mission that stopped for its owner's check but never told the phone (Mission Control died between saving the check and
 * sending the notice) tells it now, and is marked as told only after the notice went out.
 */
async function repairCheckpointNotices(night: Night): Promise<void> {
  const { store, notifier, clock } = night;
  for (const m of store.list().filter(isWaitingForCheck)) {
    const cp = m.checkpoint;
    if (cp === undefined || cp.notifiedAt !== undefined) continue;
    const notice = parkedNotice(m, cp);
    await notifier.notify(notice.title, notice.message, { priority: "high", tags: ["eyes"] });
    cp.notifiedAt = new Date(clock.now()).toISOString();
    store.save(m, clock.now());
  }
}

/**
 * The given mission, or else the oldest one with work left, unless it already ran tonight. Read fresh each time,
 * so missions queued during the night run too.
 */
function nextMission(store: MissionStore, seen: Set<string>, onlyId: string | undefined): Mission | undefined {
  if (onlyId !== undefined) return seen.has(onlyId) ? undefined : store.load(onlyId);
  return store.list().find((m) => hasWorkLeft(m) && !seen.has(m.id));
}

/**
 * Not complete yet, and not failed, unless the failure was an expired login: the owner fixes that outside Mission
 * Control, so the next run simply tries again. Any other failed mission waits for its owner (`mc run --mission <id>`).
 * By stage, not status: a "done" or "partial" mission cut off while being finalized still needs its report and
 * notification. A mission stopped on purpose for its owner's check has nothing to do until they answer, so the run
 * moves on to the others (and ends when nothing else is left) instead of waiting.
 */
function hasWorkLeft(m: Mission): boolean {
  return m.stage !== "complete" && (m.status !== "failed" || m.failure?.retryable === true) && !isWaitingForCheck(m);
}

/** A failed mission only its owner can move on: what it needs is in its report, then `mc run --mission <id>`. */
function needsOwner(m: Mission): boolean {
  return m.stage !== "complete" && m.status === "failed" && m.failure?.retryable !== true;
}

async function runOne(night: Night, dispatcher: Dispatcher, m: Mission): Promise<Mission> {
  night.logger.info(`Working on "${m.title}" (${m.id})`);
  let ended: Mission;
  try {
    ended = await dispatcher.runMission(m.id); // writes the mission's report whenever it completes, stops or fails
  } catch (err) {
    ended = await recordCrash(night, m, err);
  }
  copyToLatest(night, ended.id);
  night.logger.info(`"${ended.title}": ${missionOutcome(ended)}`);
  return ended;
}

/**
 * The dispatcher handles its own failures, so this is a bug or a broken disk. The mission must not stay "running",
 * it still needs a report, and the other missions still get their turn.
 */
async function recordCrash(night: Night, before: Mission, err: unknown): Promise<Mission> {
  const { store, clock, logger, notifier } = night;
  const status: MissionStatus = night.stop.requested() ? "stopped" : "failed";
  const note = `Mission Control hit an internal error and stopped this mission: ${errorText(err)}`;
  logger.error(`Mission ${before.id} stopped because of an internal error: ${errorText(err)}`);
  let m: Mission = { ...before, status };
  try {
    m = store.load(before.id);
    m.status = status;
    m.notes.push(note);
    store.save(m, clock.now());
    store.appendEvent(m.id, "error", { message: errorText(err) }, clock.now());
    writeFileSync(store.reportPath(m.id), renderReport(m, { prose: null, usage: store.readUsage(), screenshots: [], generatedAt: new Date(clock.now()).toISOString() }));
  } catch (recordErr) {
    logger.error(`Could not record that in mission ${before.id}: ${errorText(recordErr)}`);
  }
  if (status === "failed") await notifier.notify(`${m.title}: failed`, note, { priority: "high" });
  return m;
}

// ───────────────────────────── Reports ─────────────────────────────

/** <home>/reports/latest.md: a copy of the mission's report whose relative links still work from reports/. */
function copyToLatest(night: Night, id: string): void {
  const { store, config, logger } = night;
  const source = store.reportPath(id);
  if (!existsSync(source)) return;
  try {
    const relinked = rebaseLinks(readFileSync(source, "utf8"), missionLinkBase(id));
    writeFileSync(join(ensureDir(reportsDir(config)), "latest.md"), relinked);
  } catch (err) {
    logger.warn(`Could not update latest.md: ${errorText(err)}`);
  }
}

/** Prefixes relative markdown link targets ("](screenshots/a.png)") with `base`; absolute ones and anchors stay. */
export function rebaseLinks(markdown: string, base: string): string {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (link, target: string) =>
    /^(#|\/|[a-z][a-z0-9+.-]*:)/i.test(target) ? link : `](${base}/${target})`,
  );
}

/** A mission's folder as seen from <home>/reports/ (Decision 6: links stay relative to it). */
function missionLinkBase(id: string): string {
  return `../missions/${encodeURIComponent(id)}`;
}

function reportsDir(config: Config): string {
  return join(config.home, "reports");
}

function writeSummary(night: Night, missions: Mission[], waitingForYou: Mission[], waitingForCheck: Mission[]): string {
  const dir = ensureDir(reportsDir(night.config));
  const base = `night-${localDate(night.startedAt)}`;
  let path = join(dir, `${base}.md`);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${base}-${n}.md`);
  writeFileSync(path, renderSummary(night, missions, waitingForYou, waitingForCheck));
  return path;
}

function renderSummary(night: Night, missions: Mission[], waitingForYou: Mission[], waitingForCheck: Mission[]): string {
  const { startedAt, clock } = night;
  const lines = [
    `# Night of ${localDate(startedAt)}`,
    "",
    `Started ${clockTime(startedAt)}, finished ${clockTime(clock.now())}. ${endingSentence(night, missions)}`,
    "",
    "## Missions",
    "",
    ...(missions.length > 0
      ? missions.map((m) => missionLine(m, existsSync(night.store.reportPath(m.id))))
      : [
          waitingForYou.length > 0 || waitingForCheck.length > 0
            ? `No mission could run by itself tonight: the ones left need ${waitingForCheck.length > 0 ? "you" : "your help"} first (below).`
            : 'Nothing was queued. Add work with: mc new "<your idea>"',
        ]),
  ];
  const decisions = missions.flatMap((m) => m.decisionsNeeded.map((d) => `- **${oneLine(m.title)}**: ${oneLine(d)}`));
  if (decisions.length > 0) lines.push("", "## Needs your decision", "", ...decisions);
  if (waitingForYou.length > 0) lines.push("", "## Waiting for you", "", ...waitingForYou.map(ownerLine));
  if (waitingForCheck.length > 0) lines.push("", "## Waiting for your check", "", ...waitingForCheck.map(checkLine));
  const queued = night.store.list().filter((m) => hasWorkLeft(m) && !missions.some((w) => w.id === m.id));
  if (queued.length > 0) lines.push("", `Still waiting in the queue: ${queued.length} mission(s). They start on the next run.`);
  return lines.join("\n") + "\n";
}

/** How the owner moves a failed mission on. */
function ownerLine(m: Mission): string {
  return `- **${oneLine(m.title)}** stopped and needs your help. See what it needs with \`mc report ${m.id}\`, then continue it with \`mc run --mission ${m.id}\`.`;
}

/** How the owner answers a check: read the report, then approve or send back. */
function checkLine(m: Mission): string {
  const what = m.checkpoint ? ` (${waitingWhat(m, m.checkpoint)})` : "";
  return `- **${oneLine(m.title)}** is waiting for your check${what}. Look at it with \`mc report ${m.id}\`, then run \`mc approve ${m.id}\` or \`mc send-back ${m.id} --note "what to change"\`.`;
}

function endingSentence(night: Night, missions: Mission[]): string {
  switch (night.stop.reason) {
    case "deadline":
      return `Stopped at ${night.opts.until} as planned.`;
    case "signal":
    case "stop file":
      return "Stopped early because you asked it to.";
    default:
      if (night.noWork !== undefined) return `Ended early because ${night.noWork}; the remaining missions start on the next run.`;
      if (missions.some((m) => m.status === "stopped" && !isWaitingForCheck(m))) {
        return "Some work is paused; it continues on the next run. Each report says why it paused.";
      }
      return "Every queued mission was worked on.";
  }
}

/** One mission's result; the command works in the terminal, where `mc report` shows this summary. */
function missionLine(m: Mission, hasReport: boolean): string {
  const line = `- **${oneLine(m.title)}**: ${missionOutcome(m)}.`;
  return hasReport ? `${line} [Read the report](${missionLinkBase(m.id)}/report.md), or run \`mc report ${m.id}\`` : line;
}

function nightMessage(missions: Mission[], waitingForYou: Mission[], waitingForCheck: Mission[]): string {
  if (missions.length === 0 && waitingForYou.length === 0 && waitingForCheck.length === 0) return 'Nothing was queued. Add work with: mc new "<your idea>"';
  const helped = new Set(missions.map((m) => m.id));
  return [
    ...missions.map((m) => `${oneLine(m.title)}: ${missionOutcome(m)}`),
    ...waitingForYou.filter((m) => !helped.has(m.id)).map((m) => `${oneLine(m.title)}: still needs your help (mc report ${m.id})`),
    ...waitingForCheck.filter((m) => !helped.has(m.id)).map((m) => `${oneLine(m.title)}: waiting for your check (mc report ${m.id})`),
    "Read the report: mc report",
  ].join("\n");
}

/** A mission's result in plain words, e.g. "Partly done, 4 of 6 features done". */
export function missionOutcome(m: Mission): string {
  return `${isWaitingForCheck(m) ? "Waiting for your check" : statusPhrase(m.status)}, ${featureCount(m)}`;
}

function statusPhrase(status: MissionStatus): string {
  switch (status) {
    case "done":
      return "Done";
    case "partial":
      return "Partly done";
    case "stopped":
      return "Paused, continues on the next run";
    case "failed":
      return "Stopped, needs your help";
    case "queued":
      return "Not started yet";
    default:
      return "Still in progress";
  }
}

function featureCount(m: Mission): string {
  if (m.features.length === 0) return "no features planned yet";
  return `${m.features.filter((f) => f.status === "done").length} of ${m.features.length} features done`;
}

// ───────────────────────────── Helpers ─────────────────────────────

/** YYYY-MM-DD in local time. */
function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** HH:MM in local time. */
function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
