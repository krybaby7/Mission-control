// The report: a warm, plain-language markdown summary of one mission for a non-programmer, the plain-text
// fact sheet the scout turns into prose, and collection of the app's Playwright screenshots.
import { createHash } from "node:crypto";
import { type Dirent, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { checkedLine, checkedWords, hasModeFeature, howChecked, isModeFeature, tableWords } from "./checked-by.js";
import { plainName } from "./checks.js";
import { endState, isCheckpointShape, isWaitingForCheck, localClock, MAX_SEND_BACKS, planReviewShort, sendBacks, shown, subjectOf, waitingWhat, whyStopped } from "./checkpoint.js";
import { inContainer } from "./config.js";
import { planOf } from "./state.js";
import type { Attempt, Feature, Finding, Mission, MissionStatus, PendingCheckpoint, Provider, ReportProseOutput, UsageRecord } from "./types.js";
import { cleanAiText } from "./util/ai-text.js";
import { stripControlChars } from "./util/terminal.js";
import { featuresDone } from "./util/words.js";

// ───────────────────────────── Usage ─────────────────────────────

export interface ModelUsage {
  provider: Provider;
  model: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}

export interface UsageSummary {
  /** One row per provider+model, most-used first. */
  byModel: ModelUsage[];
  totalRuns: number;
  /** Runs that a usage limit stopped. */
  limitedRuns: number;
}

// The ledger is hand-editable parsed JSON, so these functions guard against partial records instead of
// trusting the type: one bad line must never stop the report from being written.
export function usageSummary(usage: UsageRecord[]): UsageSummary {
  const records = usage.filter(isObject);
  const rows = new Map<string, ModelUsage>();
  for (const rec of records) {
    const model = typeof rec.model === "string" && rec.model.trim() !== "" ? rec.model : "unknown model";
    const key = `${rec.provider}\u0000${model}`;
    let row = rows.get(key);
    if (!row) {
      row = { provider: rec.provider, model, runs: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0 };
      rows.set(key, row);
    }
    row.runs++;
    row.inputTokens += finite(rec.usage?.inputTokens);
    row.outputTokens += finite(rec.usage?.outputTokens);
    row.estCostUsd += finite(rec.usage?.estCostUsd);
  }
  const byModel = [...rows.values()].sort(
    (a, b) => b.runs - a.runs || compare(String(a.provider), String(b.provider)) || compare(a.model, b.model),
  );
  return { byModel, totalRuns: records.length, limitedRuns: records.filter((r) => r.outcome === "limited").length };
}

function isObject(x: unknown): boolean {
  return typeof x === "object" && x !== null;
}

function finite(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** The ledger is global; a report only counts its own mission's runs. */
function missionUsage(m: Mission, usage: UsageRecord[]): UsageRecord[] {
  return usage.filter((r) => isObject(r) && r.missionId === m.id);
}

function totalDurationMs(usage: UsageRecord[]): number {
  return usage.reduce((sum, r) => sum + finite(r.durationMs), 0);
}

// ───────────────────────────── How to run ─────────────────────────────

export interface HowToRunOptions {
  /**
   * Written inside the Mission Control container (default: inContainer()). Paths in its home are then written with
   * "~": `~/mc-apps/<app>` works both in `mc shell` and in the Ubuntu window, where the container's own path doesn't.
   */
  inContainer?: boolean;
}

/**
 * No feature that counts is checked by tests: every feature that is in the result (not blocked, not skipped) has a mode. The project's own
 * checks (`npm test`) then check nothing the owner asked for, so the steps never send the owner to run them (real runs R2 and R3). A
 * mission with a feature checked by tests, or with no feature yet, is never one of these, so its steps are as they were.
 */
function noneCheckedByTests(m: Pick<Mission, "features">): boolean {
  const counted = m.features.filter((f) => f.status !== "blocked" && f.status !== "skipped");
  return counted.length > 0 && counted.every((f) => isModeFeature(f));
}

/** A file that is read: a document. */
const DOCUMENT_FILE = /\.(?:md|markdown|txt|rst|adoc)$/iu;
/** A file that is looked at in a browser: a page. */
const PAGE_FILE = /\.html?$/iu;
/** A file that is opened as it is: a data file (a table, a list of values), a picture or a PDF. Not a page, and not a file of code (real run R4: a table). */
const DATA_FILE = /\.(?:csv|tsv|json|jsonl|ndjson|ya?ml|xml|pdf|png|jpe?g|gif|webp|svg)$/iu;
/** A list of changed files this long may have been cut (the engine lists at most ten): it is not known to be all of them. */
const FILE_LIST_CAP = 10;

/** What the owner opens when the work is documents, pages and data files only (see `openFilesOf`). */
interface OpenFiles {
  files: string[];
  /** Every file is a page: it is opened in a browser. */
  pages: boolean;
  /** The files that are pages, when there are pages among other files: those are opened in a browser, the others in the app's folder (real run R3b). */
  pageFiles: string[];
}

/** The files to open, when `files` is the whole list of changed files and every one of them is a document, a page or a data file. Otherwise undefined. */
function openFilesOf(files: readonly unknown[]): OpenFiles | undefined {
  const names = [...new Set(files.filter((f): f is string => typeof f === "string" && f !== ""))];
  if (names.length === 0 || files.length >= FILE_LIST_CAP) return undefined;
  if (!names.every((f) => DOCUMENT_FILE.test(f) || PAGE_FILE.test(f) || DATA_FILE.test(f))) return undefined;
  const pageFiles = names.filter((f) => PAGE_FILE.test(f));
  return { files: names, pages: pageFiles.length === names.length, pageFiles };
}

/** The files of the finished mission, when it is documents, pages and data files only and no test checks any feature: what the owner opens. */
function filesToOpen(m: Mission): OpenFiles | undefined {
  if (!noneCheckedByTests(m)) return undefined;
  const done = m.features.filter((f) => f.status === "done" && isModeFeature(f));
  if (done.some((f) => !Array.isArray(f.checked?.files))) return undefined; // a feature whose files are not known: the files are not all known
  return openFilesOf(done.flatMap((f) => f.checked?.files ?? []));
}

/**
 * Shell commands that let the user try the result, or [] when no feature was finished (there is nothing new
 * to try, and a greenfield app may not even exist yet). Greenfield apps use the house Next.js stack. A changed app
 * is started with its own "dev" (or "start") script when its package.json has one, else its checks are run, unless no
 * feature is checked by tests. When the work is documents and pages only, there is nothing to install or start: the
 * owner opens the files (`filesToOpen`).
 */
export function howToRun(m: Mission, opts: HowToRunOptions = {}): string[] {
  if (!m.repoPath || !m.features.some((f) => f.status === "done")) return [];
  const steps = [`cd ${shownPath(m.repoPath, opts.inContainer ?? inContainer())}`];
  const checkout = checkoutStep(m);
  if (checkout) steps.push(checkout);
  const reads = filesToOpen(m) !== undefined;
  if (m.kind === "greenfield") return reads ? steps : [...steps, "npm install", "npm run dev", "open http://localhost:3000"];
  if (reads) return steps;
  if (m.verify?.install) steps.push(m.verify.install);
  const start = startCommand(m.repoPath);
  if (start) return [...steps, start];
  if (m.verify?.full && !noneCheckedByTests(m)) steps.push(m.verify.full);
  return steps;
}

/**
 * The sentence that names the files to open, with the Windows path of the app's folder that "How to try it" already uses:
 * Then open docs/USAGE.md in your app folder (in Windows File Explorer: \\wsl.localhost\Ubuntu\home\<your Ubuntu name>\mc-apps\word-tools\docs\USAGE.md).
 * `folder` is the app's folder under ~/mc-apps as seen from Ubuntu, when the container runs and it is there (`appsSubfolder`).
 * `folderSaid`: the sentence before this one already gave the Windows path of the folder. `lead` starts the sentence.
 */
function openText(open: OpenFiles, folder: string | undefined, folderSaid = false, lead = "Then open"): string {
  const named = open.files.slice(0, 5);
  const more = open.files.length - named.length;
  const list = listWords([...named.map((f) => code(f)), ...(more > 0 ? [`${more} more`] : [])]);
  const where = open.pages ? "in your browser" : "in your app folder";
  // A page among other files is opened in a browser, and the sentence says so, for the others are opened in the app's folder (real run R3b).
  const browser = !open.pages && open.pageFiles.length > 0 ? ` Open ${listWords(open.pageFiles.slice(0, 3).map((f) => code(f)))} in your browser.` : "";
  // Several files: the Windows path of the app's folder is not written twice when the sentence before this one already gave it (real run R3b).
  if (folder === undefined || (folderSaid && open.files.length > 1)) return `${lead} ${list} ${where}.${browser}`;
  const windows = `\\\\wsl.localhost\\Ubuntu\\home\\<your Ubuntu name>\\mc-apps\\${folder.replaceAll("/", "\\")}`;
  const first = open.files[0] ?? "";
  return open.files.length === 1
    ? `${lead} ${list} ${where} (in Windows File Explorer: ${code(`${windows}\\${first.replaceAll("/", "\\")}`)}).`
    : `${lead} ${list} ${where} (in Windows File Explorer, the app's folder is ${code(windows)}).${browser}`;
}

/** "npm run dev" or "npm start" when the app's package.json has that script; best effort, never throws. */
function startCommand(repoPath: string): string | undefined {
  try {
    const scripts = (JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts;
    if (typeof scripts?.dev === "string") return "npm run dev";
    if (typeof scripts?.start === "string") return "npm start";
  } catch {
    // no package.json, or not one npm can read
  }
  return undefined;
}

/** A path as the owner types it: inside the container, its home folder is written as "~" (see HowToRunOptions). */
function shownPath(path: string, container: boolean): string {
  const home = homedir();
  if (container && path.startsWith(`${home}/`)) return `~/${shellQuote(path.slice(home.length + 1))}`;
  return shellQuote(path);
}

/** The app's folder under ~/mc-apps as seen from Ubuntu ("habit-tracker"), when the container runs and it is there. */
function appsSubfolder(m: Mission, container: boolean): string | undefined {
  const apps = join(homedir(), "mc-apps");
  return container && m.repoPath.startsWith(`${apps}/`) ? m.repoPath.slice(apps.length + 1) : undefined;
}

/**
 * The git command that puts the mission's work in the user's app folder, if one is needed.
 * Finalize removes the mission's own checkout of its branch (the integration worktree) only when the mission is
 * done. Until then git refuses to check that branch out a second time, but a detached checkout of it works.
 */
function checkoutStep(m: Mission): string | undefined {
  const branch = shellQuote(m.integrationBranch);
  if (m.kind === "greenfield") {
    // Finalize fast-forwards main, which the app folder has checked out, to the mission's work. (Not yet while the
    // owner's check of the finished app is open: main has not moved.)
    const moved = (m.stage === "finalize" || m.stage === "complete") && m.checkpoint?.kind !== "final";
    return moved ? undefined : `git checkout --detach ${branch}`;
  }
  return m.status === "done" ? `git checkout ${branch}` : `git checkout --detach ${branch}`;
}

/** Whether the app folder holds an app: greenfield apps only exist once the init stage has scaffolded one. */
function appExists(m: Mission): boolean {
  if (m.kind === "feature") return true;
  return m.repoPath !== "" && m.stage !== "spec" && m.stage !== "gate_a" && m.stage !== "init";
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// ───────────────────────────── Fact sheet (input for the prose writer) ─────────────────────────────

/** Plain-text facts about the mission: the only input the scout gets for writing the narrative. */
export function buildReportFacts(m: Mission, usage: UsageRecord[]): string {
  const counts = countFeatures(m.features);
  const runs = missionUsage(m, usage);
  const summary = usageSummary(runs);
  const tokens = summary.byModel.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  const cost = summary.byModel.reduce((sum, r) => sum + r.estCostUsd, 0);

  const lines = [
    `Mission: ${oneLine(m.title)}`,
    `Kind: ${m.kind === "greenfield" ? "a brand-new app" : `a change to an existing app (${m.repoPath})`}`,
    `Request: ${m.request.trim()}`,
    `Status: ${statusLabel(m.status)} (${m.status}). ${featuresDone(counts.done, counts.total)}, ` +
      `${counts.blocked} blocked, ${counts.skipped} skipped, ${counts.unfinished} unfinished.`,
  ];
  if (m.status === "partial" && allFeaturesDone(counts)) {
    // Finalize also calls a mission partial when the last whole-app check fails; say so, or it reads as a contradiction.
    lines.push(
      "Why partly done: every feature is done, but the final checks or reviews of the whole app left problems open (see the decisions and Run notes).",
    );
  }
  if (m.spec?.summary) lines.push(`Plan summary: ${oneLine(m.spec.summary)}`);
  lines.push(
    ...factSection("Features", m.features.map((f) => featureFact(m, f))),
    ...factSection("Choices made for the user (assumptions)", m.spec?.assumptions ?? []),
    ...factSection("Decisions the user needs to make", m.decisionsNeeded),
    ...factSection("Open review findings", openFindings(m).map(({ feature, finding }) => findingFact(feature, finding))),
  );
  if (m.baselineBroken) {
    lines.push(...factSection("Checks that were already failing before the mission started", m.baselineFailures));
  }
  lines.push(
    ...factSection("Run notes", runNotes(m)),
    "",
    `Totals: ${summary.totalRuns} agent runs (${summary.limitedRuns} stopped by usage limits), ` +
      `${formatCount(tokens)} tokens, estimated list-price cost $${cost.toFixed(2)}, ` +
      `about ${formatDuration(totalDurationMs(runs))} of agent time.`,
    ...factSection("How to try it", [...howToRun(m), ...openFact(m)]),
  );
  return stripControlChars(lines.join("\n") + "\n");
}

/** For a mission that is documents and pages only: what is opened after the steps (the fact sheet has no Markdown, so the files are named plainly). */
function openFact(m: Mission): string[] {
  const open = filesToOpen(m);
  if (!open) return [];
  const browser = !open.pages && open.pageFiles.length > 0 ? ` Open ${open.pageFiles.slice(0, 3).join(", ")} in your browser.` : "";
  return [`Then open ${open.files.slice(0, 5).join(", ")} ${open.pages ? "in your browser" : "in your app folder"}.${browser} Nothing needs to be run.`];
}

function factSection(title: string, items: string[]): string[] {
  return ["", `${title}:`, ...(items.length > 0 ? items.map((i) => `- ${oneLine(i)}`) : ["- (none)"])];
}

function featureFact(m: Mission, f: Feature): string {
  const head = `${f.id} "${f.title}" [${f.status}]`;
  switch (f.status) {
    case "done":
      // A feature no test checked says how it was checked, so the writer of the summary cannot call it tested (docs/modes-spec.md 8.5).
      return !isModeFeature(f) ? `${head}: ${f.story}` : `${head}: ${sentence(f.story)} ${checkedByFact(m, f)}${picturesFact(f)}`;
    case "blocked": {
      const tries = f.attempts.length > 0 ? ` (after ${plural(f.attempts.length, "attempt")})` : "";
      return `${head}: ${f.blockedReason ?? "no reason recorded"}${tries}`;
    }
    case "skipped":
      return `${head}: ${f.blockedReason ?? "depends on a blocked feature"}`;
    default:
      return `${head}: not finished`;
  }
}

/** `Checked by: a second AI against your list and approved by you. No tests were written for it.` (the words of the `Checked:` line, without the leading "by "). */
function checkedByFact(m: Mission, f: Feature): string {
  return `Checked by: ${checkedWords(howChecked(m, f)).replace(/^by /, "")}. No tests were written for it.`;
}

/**
 * For a feature that has pictures of its page: that they were taken, and whether the second AI looked at them. Without it the writer of the
 * summary guesses how a page was looked at, and says that nothing was run in a browser (real run R3b), which the guard then has to throw away.
 * A feature with no pictures gets no sentence, and so says nothing about pictures.
 */
function picturesFact(f: Feature): string {
  const pictures = f.checked?.pictures;
  if (typeof pictures?.taken !== "number" || pictures.taken < 1) return "";
  return pictures.why === "reviewer"
    ? " Pictures of the page were taken at phone width and desktop width, but the second AI could not look at them."
    : " Pictures of the page were taken at phone width and desktop width, and the second AI looked at them.";
}

function findingFact(f: Feature, finding: Finding): string {
  const file = findingFile(f, finding);
  const where = file ? ` (${file})` : "";
  return `[${finding.severity}] ${f.id}${where}: ${findingText(f, finding)}`;
}

/** The longest finding the report prints: a check, then the evidence of the second AI, which is cut at 300 characters. */
const FINDING_CHARS = 2000;

/**
 * What a finding says. The findings of a feature checked by a second AI quote files that AI read, so they are cleaned once
 * more here (no hidden character, no picture or link, no web address; util/ai-text.ts): a mission file that holds older or
 * hand-made text cannot put them in the report. Other findings are printed as they were.
 */
function findingText(feature: Feature, finding: Finding): string {
  return isModeFeature(feature) ? cleanAiText(finding.description, FINDING_CHARS) : oneLine(finding.description);
}

/** The longest file name of a finding the report prints, after it is cleaned. */
const FILE_CHARS = 200;

/**
 * The file a finding is about. The note of a second AI names it, so, like the finding's words, it is cleaned once more here for a feature
 * checked by a second AI: a hidden character is shown as a code point, and a picture, a link or a web address is made plain. Other
 * findings keep the name they were given.
 */
function findingFile(feature: Feature, finding: Finding): string {
  const file = finding.file ?? "";
  return isModeFeature(feature) ? cleanAiText(plainName(file), FILE_CHARS) : file;
}

// ───────────────────────────── The report ─────────────────────────────

export interface RenderReportOptions {
  /** Narrative written by the scout; null/absent → a template narrative. */
  prose?: ReportProseOutput | null;
  usage: UsageRecord[];
  /** Paths returned by collectScreenshots, i.e. inside a folder next to report.md (or already relative to it). */
  screenshots: string[];
  generatedAt: string;
  /**
   * Folder the markdown will be saved in; absolute screenshot paths are linked relative to it. Defaults to the
   * folder that holds the screenshots folder (<missionDir>, where report.md lives). Pass it when saving elsewhere,
   * e.g. <home>/reports for latest.md.
   */
  reportDir?: string;
  /**
   * Written inside the Mission Control container (default: inContainer()): the app is tried in `mc shell` (Ubuntu
   * has no Node), and paths are written as the owner can type them (see HowToRunOptions).
   */
  inContainer?: boolean;
}

/**
 * The report as markdown. Plain language first; technical details last. The screenshots come after the
 * features table, so the first lines (what `mc report` shows) keep the decisions and the features.
 */
export function renderReport(m: Mission, opts: RenderReportOptions): string {
  const usage = missionUsage(m, opts.usage);
  const container = opts.inContainer ?? inContainer();
  const guarded = guardProse(m, opts.prose);
  const sections = [
    checkSection(m, container, opts.reportDir),
    headerSection(m, opts.generatedAt),
    narrative(m, guarded.prose, container),
    whatYouCanDoSection(m, guarded.prose),
    howToTrySection(m, container),
    decisionsSection(m, container),
    featuresSection(m),
    yourChecksSection(m),
    screenshotsSection(opts.screenshots, opts.reportDir),
    choicesSection(m),
    reviewNotesSection(m),
    usageSection(usage),
    technicalSection(m, opts.generatedAt, guarded.left),
  ];
  // Agents wrote much of this (prose, findings, summaries): no control characters reach a terminal that shows it.
  return stripControlChars(sections.filter((s) => s !== "").join("\n\n") + "\n");
}

function headerSection(m: Mission, generatedAt: string): string {
  const { done, total } = countFeatures(m.features);
  const progress = total === 0 ? "no features planned yet" : featuresDone(done, total);
  const header = `# ${oneLine(m.title)}\n\n**${statusLabel(m.status, m)}** · ${progress} · report written ${formatLocalTime(generatedAt)}`;
  // While a check waits, the waiting block (which comes first) already says it, above the look: it is not said twice.
  const line = isWaitingForCheck(m) ? "" : planLine(m);
  // Only when a finished feature is not checked by tests: how each finished feature was checked, in one line.
  const checked = checkedLine(m) ?? "";
  return [header, line, checked].filter((part) => part !== "").join("\n\n");
}

/**
 * The words docs/modes-spec.md 10.3 says are never used for work that no test checked: any form of "test", and the claims
 * of the "Never say" column (verified, approved by AI, guaranteed, correct; you looked at it, reviewed by you, signed off,
 * you chose not to look at it; passed with a warning, probably fine; the engine). Case does not matter; white space between
 * the words of a phrase may be any amount.
 */
const NEVER_SAY: readonly RegExp[] = [
  /\btest(?:s|ed|ing)?\b/iu,
  /\bverified\b/iu,
  /\bapproved\s+by\s+(?:the\s+|a\s+|an\s+)?(?:second\s+)?AI\b/iu,
  /\bguaranteed\b/iu,
  /\bcorrect\b/iu,
  /\byou\s+looked\s+at\s+it\b/iu,
  /\breviewed\s+by\s+you\b/iu,
  /\bsigned\s+off\b/iu,
  /\byou\s+chose\s+not\s+to\s+look\s+at\s+it\b/iu,
  /\bpassed\s+with\s+a\s+warning\b/iu,
  /\bprobably\s+fine\b/iu,
  /\bthe\s+engine\b/iu,
];

/** Words that may stand between "no" and "tests" in a denial: "no automated tests", "no new unit tests". A fixed list, so "no ... tests" cannot reach across a sentence. */
const DENIAL_QUALIFIER = String.raw`(?:(?:automated|new|extra|additional|separate|unit|real|actual|formal|written|browser|software|code|end-to-end|usual|specific|other|more)\s+)*`;

/**
 * Phrases in which the AI says that no test was written, run or claimed: "No automated tests were written for the guide", "rather than
 * on test results", "was not tested", "checked without tests". They hold the word "test" and say the opposite of what the list is
 * there to keep out (real run R2: an honest summary was thrown away for saying so). Each one is taken out of the text before the list is
 * applied, so a claim next to a denial still stands: "No tests were written, but it was tested twice" keeps "tested".
 * "No tests failed" is no denial: it says that tests ran.
 */
const DENIALS: readonly RegExp[] = [
  new RegExp(String.raw`\bno\s+${DENIAL_QUALIFIER}tests?\s+(?:(?:was|were|are|is|has\s+been|have\s+been|had\s+been|will\s+be)\s+(?:written|run|ran|added|made|used|needed|claimed|involved|done|created|included|available|possible|asked\s+for)|for|exist|exists|existed|at\s+all|here|yet)\b`, "giu"),
  new RegExp(String.raw`\b(?:no|any|the)\s+${DENIAL_QUALIFIER}tests?\s+(?:were|was|are|is)\s+not\s+(?:written|run|ran|claimed)\b`, "giu"),
  new RegExp(String.raw`\b(?:has|have|had|with)\s+no\s+${DENIAL_QUALIFIER}tests?\b`, "giu"),
  new RegExp(String.raw`\bwithout\s+(?:any\s+)?${DENIAL_QUALIFIER}tests?\b`, "giu"),
  new RegExp(String.raw`\b(?:not|never)\s+(?:been\s+)?tested\b`, "giu"),
  /\bnothing(?:\s+\w+){0,2}\s+(?:has\s+been|have\s+been|was|is|got)\s+tested\b/giu,
  /\bnone\s+of\s+(?:it|them|this|these|those|the\s+\w+)\s+(?:has\s+been|have\s+been|was|were|is|are)\s+tested\b/giu,
  new RegExp(String.raw`\b(?:not|never)\s+(?:been\s+)?checked\s+by\s+(?:any\s+)?${DENIAL_QUALIFIER}tests?\b`, "giu"),
  new RegExp(String.raw`\bnot\s+by\s+(?:any\s+|the\s+|an?\s+)?${DENIAL_QUALIFIER}tests?\b`, "giu"),
  new RegExp(String.raw`\b(?:rather\s+than|instead\s+of)\s+(?:on\s+|by\s+)?(?:the\s+|any\s+)?(?:test\s+results?|${DENIAL_QUALIFIER}tests?)\b`, "giu"),
  /\bno\s+test\s+results?\b/giu,
];

/** `text` without the phrases that deny a test (see `DENIALS`). */
function withoutDenials(text: string): string {
  return DENIALS.reduce((rest, re) => rest.replace(re, " "), text);
}

/** True when `text` holds a word or phrase of the never-say list, other than inside a phrase that says no test was written, run or claimed. */
export function holdsNeverSay(text: string): boolean {
  const rest = withoutDenials(text);
  return NEVER_SAY.some((re) => re.test(rest));
}

/**
 * The AI-written narrative and "what you can do" lines, unless the mission has a feature that no test checked and the AI
 * uses a word of the never-say list (tests, verified, guaranteed, ...): then both are left out (the plain narrative and the
 * feature list stand in) and `left` is true, so the technical details can say so. A rule in the prompt asks the AI not to;
 * this is the check that does not depend on it.
 */
function guardProse(m: Mission, prose: ReportProseOutput | null | undefined): { prose: ReportProseOutput | null | undefined; left: boolean } {
  if (!prose || !hasModeFeature(m.features)) return { prose, left: false };
  const texts = [prose.narrative, ...(Array.isArray(prose.whatYouCanDo) ? prose.whatYouCanDo : [])];
  return texts.some((t) => typeof t === "string" && holdsNeverSay(t)) ? { prose: null, left: true } : { prose, left: false };
}

/**
 * For a plan from outside: who wrote it, which one it is (the code `mc plan show` prints), and what the team's plan
 * reviewer did with it. Empty for a mission the team's planner planned.
 */
function planLine(m: Mission): string {
  const plan = planOf(m);
  if (!plan) return "";
  const answer = plan.review ? `; ${planReviewShort(plan.review)}` : ".";
  return `Plan: written by the leader (plan code ${plan.sha256.slice(0, 8)})${answer}`;
}

/**
 * The same words as the run summary and the notifications (run.ts statusPhrase). Given the mission, a stop for the
 * owner's check reads as that, not as a pause. (The fact sheet for the scout passes no mission: it never mentions checks.)
 */
function statusLabel(status: MissionStatus, m?: Mission): string {
  if (m && isWaitingForCheck(m)) return "Waiting for your check";
  switch (status) {
    case "done":
      return "Done";
    case "partial":
      return "Partly done";
    case "stopped":
      return "Paused, continues on the next run";
    case "failed":
      return "Stopped, needs your help";
    default:
      return "Still in progress";
  }
}

// ───────────────────────────── The owner's checks ─────────────────────────────

/** The block at the very top of the report (what `mc report` shows first) while a check waits, or after it was answered. */
function checkSection(m: Mission, container: boolean, reportDir: string | undefined): string {
  const cp = m.checkpoint;
  if (!isCheckpointShape(cp) || m.stage === "complete") return "";
  return cp.state === "pending" ? waitingSection(m, cp, container, reportDir) : answeredSection(m, cp);
}

function waitingSection(m: Mission, cp: PendingCheckpoint, container: boolean, reportDir: string | undefined): string {
  const { look } = cp;
  const sent = sendBacks(m, cp.scope);
  // The two answers come before the look: a long plan must not push them out of the first lines `mc report` shows.
  const parts = [
    `The team stopped here on purpose, because ${whyStopped(m, cp, waitingWhat(m, cp))}. Nothing else is waiting on this mission; other work carries on.`,
    [
      "What your answer does:",
      `- **Approve** lets the team carry on from here: ${code(`mc approve ${m.id}`)}. You can add ${code('--note "..."')}; it is kept in this report.`,
      `- **Send back** with what to change: ${code(`mc send-back ${m.id} --note "what to change"`)}. ${sendBackEffect(cp, sent)}`,
    ].join("\n"),
    // Above the look, so a long plan can never push it out of the first lines `mc report` shows.
    planLine(m),
    `**${oneLine(shown(look.headline))}**`,
    lookBullets(look.lines),
  ].filter((p) => p !== "");
  parts.push(...changedFilesParts(look));
  const howTo = lookHowTo(m, cp, container);
  if (howTo) parts.push(howTo);
  if (look.screenshots && look.screenshots.length > 0) {
    parts.push(look.screenshots.map((p) => `![${screenshotCaption(p)}](${imageLink(p, reportDir)})`).join("\n\n"));
  }
  return section("Waiting for your check", parts.join("\n\n"));
}

/**
 * The facts of a plan the owner reads as one paragraph each: what was asked, the app's name and the summary. Each appears once in the look of a
 * plan, so a second line that starts with the same lead is the rest of a long one that was wrapped (`wrapFact` starts every wrapped line with its lead, for
 * the card, which shows one line at a time).
 */
const PARAGRAPH_LEADS: readonly string[] = ["You asked:", "App name:", "Summary:"];

/**
 * The files of a look. A feature checked by reading lists the files it did not create apart from the new ones (`existingFiles`), so the owner
 * can see that it changed a file an earlier feature made (real run R4). Every other look is one sentence, as it always was.
 */
function changedFilesParts(look: PendingCheckpoint["look"]): string[] {
  const files = Array.isArray(look.files) ? look.files : [];
  if (files.length === 0) return [];
  const list = (xs: string[]): string => listWords(xs.map((p) => code(shown(p))));
  const older = Array.isArray(look.existingFiles) ? files.filter((f) => look.existingFiles?.includes(f)) : [];
  if (older.length === 0) return [`Files that changed: ${list(files)}.`];
  const fresh = files.filter((f) => !older.includes(f));
  return [...(fresh.length > 0 ? [`New in this feature: ${list(fresh)}.`] : []), `Changed, but already there before this feature: ${list(older)}.`];
}

/**
 * The lines of the owner's look as a list, one bullet to a line. A line that starts with a space goes on with the line before it (a long
 * sentence that was wrapped without a lead of its own): it stays under that bullet, indented as `mc plan show` indents a wrapped line, and
 * is not a bullet of its own (real run R3). A long paragraph fact that was wrapped with its lead on every line is put back under one bullet, without
 * the lead again (real run R4: "You asked: ..." was followed by a second bullet "You asked: ...").
 */
function lookBullets(lines: readonly unknown[]): string {
  let before: string | undefined; // the paragraph lead of the line before this one
  return lines
    .map((line, i) => {
      const text = String(line);
      const lead = PARAGRAPH_LEADS.find((l) => text.startsWith(`${l} `));
      const again = lead !== undefined && lead === before;
      before = lead;
      if (again) return `  ${shown(text.slice(lead.length + 1))}`;
      return i > 0 && /^\s/u.test(text) ? `  ${shown(text)}` : `- ${shown(text)}`;
    })
    .join("\n");
}

function sendBackEffect(cp: PendingCheckpoint, sent: number): string {
  if (sent >= MAX_SEND_BACKS) return `Sending it back again stops the work here: ${endState(cp.kind)}.`;
  const how: Record<PendingCheckpoint["kind"], string> = {
    plan: "The planner revises the plan with your note, then shows it to you again.",
    feature: "The engineer changes it with your note, the reviewer looks again, then it is shown to you again.",
    final: "The team adds your change as a new feature, checks everything again, then shows the result to you again.",
  };
  return `${how[cp.kind]} You can do this ${MAX_SEND_BACKS - sent === 1 ? "one more time" : `${MAX_SEND_BACKS - sent} more times`}.`;
}

/** How to open the work on its branch (a feature before it is added, or the finished app), like "How to try it". */
function lookHowTo(m: Mission, cp: PendingCheckpoint, container: boolean): string {
  const branch = cp.look.branch;
  if (cp.kind === "plan" || !branch || !m.repoPath) return "";
  const steps = [`cd ${shownPath(m.repoPath, container)}`, `git checkout --detach ${shellQuote(branch)}`];
  // Documents, pages and data files only, and no feature checked by tests: the owner opens the file(s) (real runs R2, R3 and R4); nothing is installed, started or run.
  const open = noneCheckedByTests(m) ? openFilesOf(cp.look.files ?? []) : undefined;
  // A mission that has a feature checked by tests keeps its steps, which run the project's own checks. When the feature looked at is checked by reading,
  // those checks do not cover it, so the file to open is named after them, in words of its own (real run R4: a table, and nothing said which file to open).
  const focus = cp.kind === "feature" ? m.features.find((f) => f.id === cp.featureId) : undefined;
  const alongside = open === undefined && focus !== undefined && isModeFeature(focus) ? openFilesOf(cp.look.files ?? []) : undefined;
  if (open === undefined) {
    if (m.kind === "greenfield") steps.push("npm install", "npm run dev", "open http://localhost:3000");
    else {
      if (m.verify?.install) steps.push(m.verify.install);
      const start = startCommand(m.repoPath);
      steps.push(...(start ? [start] : m.verify?.full && !noneCheckedByTests(m) ? [m.verify.full] : []));
    }
  }
  const starts = steps.some((cmd) => cmd === "npm run dev" || cmd === "npm start");
  const leave = [
    ...(starts ? ["press Ctrl+C to stop the app"] : []),
    `put the folder back on your own version with ${code(`git checkout ${shellQuote(m.baseBranch)}`)}`,
    ...(container ? ["type `exit`"] : []),
  ];
  return [
    "To look at it yourself:",
    container
      ? "In the Ubuntu window, run `mc shell` first: it opens a terminal inside Mission Control's container, which has everything the app needs. Then run these one at a time:"
      : "Open a terminal and run these one at a time:",
    steps.map((cmd, i) => `${i + 1}. ${describeStep(m, cmd)}`).join("\n"),
    ...(open ? [openText(open, appsSubfolder(m, container))] : []),
    ...(alongside ? [openText(alongside, appsSubfolder(m, container), false, "The project's own checks do not cover this feature. To look at it, open")] : []),
    `When you're done, ${listWords(leave)}.`,
  ].join("\n\n");
}

function answeredSection(m: Mission, cp: PendingCheckpoint): string {
  const answer = cp.answer;
  if (!answer) return "";
  const when = `at ${localClock(answer.at)}`;
  const text =
    answer.decision === "approve"
      ? `You approved ${subjectOf(m, cp)} ${when}. The mission carries on from there when it runs next: ${code(`mc run --mission ${m.id}`)}.`
      : `You sent ${subjectOf(m, cp)} back ${when}. The team makes the change and shows it to you again when the mission runs next: ${code(`mc run --mission ${m.id}`)}.`;
  return section("Your answer is recorded", text);
}

/** Every answer the owner gave, oldest first. */
function yourChecksSection(m: Mission): string {
  const log = m.checkpointLog ?? [];
  if (log.length === 0) return "";
  const rows = log.map((r) => {
    const what = r.kind === "plan" ? "The plan" : r.kind === "final" ? "The finished app" : `“${oneLine(shown(m.features.find((f) => f.id === r.featureId)?.title ?? r.featureId ?? "A feature"))}”`;
    return `| ${cell(what)} | ${r.decision === "approve" ? "Approved" : "Sent back"} | ${formatLocalTime(r.at)} | ${cell(shown(r.note ?? ""))} |`;
  });
  return section("Your checks", ["| What you checked | Your answer | When | Your note |", "|---|---|---|---|", ...rows].join("\n"));
}

function narrative(m: Mission, prose: ReportProseOutput | null | undefined, container: boolean): string {
  return prose?.narrative.trim() || templateNarrative(m, container);
}

function templateNarrative(m: Mission, container: boolean): string {
  const sentences = [
    m.kind === "greenfield"
      ? `I worked on your new app, “${oneLine(m.title)}”.`
      : `I worked on your request for ${basename(m.repoPath) || "your project"}: “${oneLine(m.title)}”.`,
  ];
  if (m.spec?.summary) sentences.push(`The plan: ${sentence(m.spec.summary)}`);
  const counts = countFeatures(m.features);
  const byReading = m.features.some((f) => f.status === "done" && isModeFeature(f));
  sentences.push(...progressSentences(counts, byReading), ...(isWaitingForCheck(m) ? ["I stopped here on purpose, so you can look at it before I go on."] : statusSentence(m.status, counts, byReading)));
  const decisions = decisionItems(m, container).length;
  if (decisions > 0) {
    sentences.push(
      `There ${decisions === 1 ? "is one thing" : `are ${decisions} things`} I need you to decide; see “Needs your decision”.`,
    );
  }
  return sentences.join(" ");
}

/**
 * `byReading`: a finished feature is not checked by tests, so "built and checked" would say more than is known. The
 * `Checked:` line and the Features table say how each was checked (docs/modes-spec.md 10.1).
 */
function progressSentences(c: FeatureCounts, byReading = false): string[] {
  if (c.total === 0) return ["I didn't get as far as planning the features."];
  if (allFeaturesDone(c)) {
    if (byReading) {
      return [
        c.total === 1
          ? "The feature is built. The Features table says how it was checked."
          : `All ${c.total} features are built. The “Checked” line and the Features table say how each was checked.`,
      ];
    }
    return [c.total === 1 ? "The feature is built and checked." : `All ${c.total} features are built and checked.`];
  }
  const sentences = [
    c.done === 0
      ? "None of the features are finished yet."
      : `${c.done} of the ${c.total} features ${c.done === 1 ? "is" : "are"} built${byReading ? "" : " and checked"}.`,
  ];
  if (c.blocked > 0) sentences.push(`${plural(c.blocked, "feature")} got stuck; the table below says why.`);
  if (c.skipped > 0) {
    sentences.push(`${plural(c.skipped, "feature")} depended on a stuck feature, so I skipped ${c.skipped === 1 ? "it" : "them"}.`);
  }
  if (c.unfinished > 0) sentences.push(`${plural(c.unfinished, "feature")} ${c.unfinished === 1 ? "isn't" : "aren't"} finished yet.`);
  return sentences;
}

function statusSentence(status: MissionStatus, c: FeatureCounts, byReading = false): string[] {
  switch (status) {
    case "done":
      return [byReading ? "The final checks of the whole app passed." : "Everything passed the final checks."];
    case "partial":
      return allFeaturesDone(c)
        ? [
            "But the final checks or reviews of the whole app left problems open, so some parts may not work right yet. " +
              "“Needs your decision” and “Technical details” say what they found.",
          ]
        : []; // the progress sentences already say which features aren't done
    case "stopped":
      return ["The run stopped before I could finish. I'll pick up where I left off next time."];
    case "failed":
      return ["I hit a problem I couldn't get past on my own, so I stopped."];
    default:
      return [];
  }
}

function whatYouCanDoSection(m: Mission, prose: ReportProseOutput | null | undefined): string {
  const fromProse = (prose?.whatYouCanDo ?? []).map((s) => oneLine(s)).filter((s) => s !== "");
  const items =
    fromProse.length > 0
      ? fromProse
      : m.features.filter((f) => f.status === "done").map((f) => `**${oneLine(f.title)}**: ${oneLine(f.story)}`);
  return section("What you can do now", bulletList(items, "Nothing new to try yet: none of the features were finished."));
}

function howToTrySection(m: Mission, container: boolean): string {
  const steps = howToRun(m, { inContainer: container });
  if (steps.length === 0) {
    const why = appExists(m) ? "none of the features were finished" : "the app wasn't created";
    return section("How to try it", `There's nothing to try yet: ${why}.`);
  }
  const parts: string[] = [];
  const folder = appsSubfolder(m, container);
  if (folder !== undefined) {
    const windows = `\\\\wsl.localhost\\Ubuntu\\home\\<your Ubuntu name>\\mc-apps\\${folder.replaceAll("/", "\\")}`;
    parts.push(`The app is in your folder ${code(`~/mc-apps/${folder}`)} (in Windows File Explorer: ${code(windows)}).`);
  }
  parts.push(
    container
      ? "In the Ubuntu window, run `mc shell` first: it opens a terminal inside Mission Control's container, which has " +
          "everything the app needs. Then run these one at a time:"
      : "Open a terminal and run these one at a time:",
    steps.map((cmd, i) => `${i + 1}. ${describeStep(m, cmd)}`).join("\n"),
  );
  const starts = steps.some((cmd) => cmd === "npm run dev" || cmd === "npm start");
  const open = filesToOpen(m);
  if (open) parts.push(openText(open, folder, true));
  else if (m.kind === "feature") {
    parts.push(starts ? "Then open the address it prints (often http://localhost:3000) in your browser." : "Then start your app the way you usually do.");
  }
  const leaveSteps = [
    ...(starts ? ["press Ctrl+C to stop the app"] : []),
    // A checkout of the mission's work leaves the folder off your own branch, and `mc feature` then needs it back.
    ...(checkoutStep(m) ? [`put the folder back on your own version with ${code(`git checkout ${shellQuote(m.baseBranch)}`)}`] : []),
    ...(container ? ["type `exit`"] : []),
  ];
  const keep = keepChangeText(m);
  if (keep) parts.push(keep);
  if (leaveSteps.length > 0) parts.push(`When you're done, ${listWords(leaveSteps)}.`);
  return section("How to try it", parts.join("\n\n"));
}

/**
 * A finished change to an existing app stays on its own branch: how to add it to the owner's version, or leave it.
 * (A new app's main branch already holds its work.)
 */
function keepChangeText(m: Mission): string | undefined {
  if (m.kind !== "feature" || m.stage !== "complete" || !m.features.some((f) => f.status === "done")) return undefined;
  const base = shellQuote(m.baseBranch);
  return (
    `To keep the change, add it to your own version (${code(m.baseBranch)}), in the app's folder: ` +
    `${code(`git checkout ${base} && git merge ${shellQuote(m.integrationBranch)}`)}. ` +
    "If you don't want it, do nothing: it stays apart, and your version doesn't have it."
  );
}

/** "a", "a and b", "a, b and c". */
function listWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** A command plus a short plain-language note on what it is for. */
function describeStep(m: Mission, cmd: string): string {
  const url = /^open (\S+)$/.exec(cmd)?.[1];
  if (url) return `Open ${url} in your browser.`;
  const hint = stepHint(m, cmd);
  return hint ? `${code(cmd)}: ${hint}` : code(cmd);
}

function stepHint(m: Mission, cmd: string): string | undefined {
  if (cmd.startsWith("cd ")) return "go to the app's folder";
  if (cmd.startsWith("git checkout ")) return "switch to the version with the new work";
  if (cmd === "npm run dev" || cmd === "npm start") return "start the app (leave this window open while you try it)";
  if (cmd === "npm install" || cmd === m.verify?.install) return "download what the app needs (slow the first time)";
  if (cmd === m.verify?.full) return "run the project's own checks";
  return undefined;
}

function screenshotsSection(screenshots: string[], reportDir: string | undefined): string {
  if (screenshots.length === 0) return "";
  const images = screenshots.map((p) => `![${screenshotCaption(p)}](${imageLink(p, reportDir)})`);
  return section("What it looks like", images.join("\n\n"));
}

/**
 * Relative link for a screenshot. collectScreenshots copies them into a folder next to report.md
 * (<missionDir>/screenshots), so by default an absolute path becomes "<folder>/<file>".
 */
function imageLink(path: string, reportDir: string | undefined): string {
  const rel = isAbsolute(path) ? relative(reportDir ?? dirname(dirname(path)), path) : path;
  // encodeURIComponent leaves parentheses alone, but some renderers end the link at ")".
  return rel
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/\(/g, "%28").replace(/\)/g, "%29"))
    .join("/");
}

function screenshotCaption(path: string): string {
  return basename(path, extname(path)).replace(/[-_]+/g, " ").replace(/[[\]]/g, "").trim() || "screenshot";
}

function decisionsSection(m: Mission, container: boolean): string {
  const items = decisionItems(m, container);
  // While the team waits for the owner's check, "Nothing. You don't need to do anything." under it would contradict the block above (real run R4).
  // A mission with no feature checked by reading keeps the section as it was.
  if (items.length === 0 && isWaitingForCheck(m) && hasModeFeature(m.features)) return "";
  return section("Needs your decision", bulletList(items, "Nothing. You don't need to do anything."));
}

/**
 * What the red project checks meant for this mission, as the report says it. A mission with no feature checked by a second AI keeps the
 * words it always had. Where a feature has no tests, saying that only the new tests were used would be false: nothing was tested
 * (docs/modes-spec.md, 10.3). The pull request text says the same three things in the same order.
 */
export function baselineBrokenSentence(m: Pick<Mission, "features">): string {
  if (!hasModeFeature(m.features)) {
    return "Your project's own checks were already failing before I started, so I only used the new tests to check my work.";
  }
  const lead = "Your project's own checks were already failing before I started, so they could not be used to check my work.";
  return m.features.some((f) => !isModeFeature(f))
    ? `${lead} The features checked by tests were judged by tests alone, and the others by Mission Control's own checks and a second AI.`
    : `${lead} Mission Control's own checks and a second AI checked it instead.`;
}

function decisionItems(m: Mission, container: boolean): string[] {
  const items = [...m.decisionsNeeded];
  if (m.baselineBroken) {
    items.push(`${baselineBrokenSentence(m)} You may want someone to look at those older failures (listed under “Technical details”).`);
  }
  const retry = retryItem(m, container);
  if (retry) items.push(retry);
  if (m.stage === "complete" && m.status === "partial" && allFeaturesDone(countFeatures(m.features)) && m.decisionsNeeded.length === 0) {
    items.push(
      "Every feature passed its own checks, but the final check of the whole app didn't, so some parts may not work " +
        "right yet (“Technical details” has what it found). Have someone look at the app before you rely on it.",
    );
  }
  return items;
}

/**
 * A finished mission never runs again, so its stuck and skipped features are dropped unless the owner queues them
 * again: the command that does, starting from the mission's work (main for a new app, the change's own branch).
 */
function retryItem(m: Mission, container: boolean): string | undefined {
  const left = m.stage === "complete" && m.repoPath !== "" ? m.features.filter((f) => f.status === "blocked" || f.status === "skipped") : [];
  if (left.length === 0) return undefined;
  const names = left.map((f) => `“${oneLine(f.title)}” (${f.status === "blocked" ? "got stuck" : "skipped: it needed a stuck feature"})`);
  const request = left.map((f) => `${oneLine(f.title)}: ${oneLine(f.story)}`).join(" ");
  const base = m.kind === "greenfield" ? m.baseBranch : m.integrationBranch;
  const command = `mc feature ${shownPath(m.repoPath, container)} ${shellQuote(request)} --base ${shellQuote(base)}`;
  return (
    `${left.length === 1 ? "1 feature wasn't" : `${left.length} features weren't`} finished, and I won't try again by myself: ` +
    `${listWords(names)}. The “Features” table says why. To have another go, queue ${left.length === 1 ? "it" : "them"} ` +
    `as a change to the app${container ? " (in the Ubuntu window)" : ""}: ${code(command)}. It starts on the next run.`
  );
}

function featuresSection(m: Mission): string {
  if (m.features.length === 0) return section("Features", "No features were planned yet.");
  const byReading = hasModeFeature(m.features);
  const rows = m.features.map((f) => `| ${featureIcon(f)} | ${cell(f.title)} | ${cell(featureOutcome(f, byReading ? m : undefined))} |`);
  return section("Features", ["|  | Feature | What happened |", "|---|---|---|", ...rows].join("\n"));
}

function featureIcon(f: Feature): string {
  if (f.status === "done") return "✅";
  if (f.status === "blocked" || f.status === "skipped") return "⛔";
  return "⏳";
}

/** `m` is given only for a mission that has a feature no test checked: the words then say how each finished feature was checked. */
function featureOutcome(f: Feature, m?: Mission): string {
  switch (f.status) {
    case "done": {
      const notes = f.openFindings.length;
      if (m) {
        const h = howChecked(m, f);
        const words = tableWords(h);
        // Unmet checks are the review notes, and the words already say so.
        if (notes === 0 || h.row === 5) return words;
        // Words that end in a bracket take the count into it: "(6 of 6 passed, 1 review note below)", not two brackets in a row (real run R3b).
        const below = plural(notes, "review note");
        return words.endsWith(")") ? `${words.slice(0, -1)}, ${below} below)` : `${words} (${below} below)`;
      }
      return notes > 0 ? `Built and checked (${plural(notes, "review note")} below)` : "Built and checked";
    }
    case "blocked": {
      const reason = f.blockedReason ?? "I couldn't get it to pass its checks";
      return f.attempts.length > 0 ? `Stuck: ${reason} (tried ${plural(f.attempts.length, "time")})` : `Stuck: ${reason}`;
    }
    case "skipped":
      return `Skipped: ${f.blockedReason ?? "it depends on a feature that got stuck"}`;
    case "pending":
      return "Not started yet";
    default:
      return "Started but not finished";
  }
}

function choicesSection(m: Mission): string {
  return section("Choices I made for you", bulletList(m.spec?.assumptions ?? [], "None. I followed your request as written."));
}

function reviewNotesSection(m: Mission): string {
  const items = openFindings(m).map(({ feature, finding }) => {
    const file = findingFile(feature, finding);
    const where = file ? ` (in ${code(file)})` : "";
    const check = finding.suggestedTest ? ` Suggested check: ${oneLine(finding.suggestedTest)}` : "";
    return `**${oneLine(feature.title)}** · ${SEVERITY_WORD[finding.severity]}: ${findingText(feature, finding)}${where}${check}`;
  });
  return section("Review notes", bulletList(items, "No open review notes."));
}

const SEVERITY_WORD: Record<Finding["severity"], string> = { blocker: "Serious", major: "Important", minor: "Small" };
const SEVERITY_RANK: Record<Finding["severity"], number> = { blocker: 0, major: 1, minor: 2 };

/** Open findings in feature order, most severe first within a feature. */
function openFindings(m: Mission): { feature: Feature; finding: Finding }[] {
  return m.features.flatMap((feature) =>
    [...feature.openFindings]
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
      .map((finding) => ({ feature, finding })),
  );
}

function usageSection(usage: UsageRecord[]): string {
  const summary = usageSummary(usage);
  if (summary.totalRuns === 0) return section("Usage", "No agent runs were recorded.");
  const rows = summary.byModel.map(
    (r) =>
      `| ${cell(r.model)} | ${providerName(r.provider)} | ${r.runs} | ${formatCount(r.inputTokens)} | ` +
      `${formatCount(r.outputTokens)} | ${formatCost(r.estCostUsd)} |`,
  );
  const total = summary.byModel.reduce(
    (t, r) => ({ input: t.input + r.inputTokens, output: t.output + r.outputTokens, cost: t.cost + r.estCostUsd }),
    { input: 0, output: 0, cost: 0 },
  );
  rows.push(
    `| **Total** |  | ${summary.totalRuns} | ${formatCount(total.input)} | ${formatCount(total.output)} | ${formatCost(total.cost)} |`,
  );
  const limited = summary.limitedRuns > 0 ? `, ${plural(summary.limitedRuns, "run")} paused by a usage limit` : "";
  const body = [
    `${plural(summary.totalRuns, "agent run")}${limited}, about ${formatDuration(totalDurationMs(usage))} of agent time.`,
    "",
    "| Model | Tool | Runs | Input tokens | Output tokens | Est. cost |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "_Est. cost is the list price the tools report, not what your subscription charges._",
  ];
  return section("Usage", body.join("\n"));
}

const PROVIDER_NAME: Record<Provider, string> = { claude: "Claude Code", codex: "Codex", mock: "mock" };

/** The tool's display name; a ledger line with an unknown or missing provider shows what it holds. */
function providerName(p: Provider): string {
  return Object.hasOwn(PROVIDER_NAME, p) ? PROVIDER_NAME[p] : cell(String(p ?? "unknown"));
}

function technicalSection(m: Mission, generatedAt: string, proseLeftOut = false): string {
  const facts = [
    `Mission id: ${code(m.id)} (${m.kind}, profile ${code(m.profile)})`,
    `Repository: ${m.repoPath ? code(m.repoPath) : "not created"}`,
    `Started from: ${code(m.baseBranch)}${m.baseSha ? ` at ${code(shortSha(m.baseSha))}` : ""}`,
    `Integration branch: ${code(m.integrationBranch)}`,
  ];
  if (m.integrationWorktree) facts.push(`Integration worktree: ${code(m.integrationWorktree)}`);
  if (m.verify) {
    facts.push(`Full check: ${code(m.verify.full)}${m.verify.tests ? ` · test files: ${code(m.verify.tests)}` : ""}`);
  }
  facts.push(
    `Stage: ${m.stage} · status: ${m.status} · agent runs: ${m.agentRuns} · gate C rounds: ${m.gateCRounds}`,
    // Relative to the home folder, so the pointer stays right in copies of this report (e.g. reports/latest.md).
    `Logs: ${code(`missions/${m.id}/logs/`)} and ${code(`missions/${m.id}/events.jsonl`)} in the Mission Control ` +
      `home folder; ${code(`mc logs ${m.id}`)} prints the event log`,
    `Report generated: ${generatedAt}`,
  );
  const parts = ["## Technical details", bulletList(facts, "")];
  if (m.features.length > 0) parts.push(featureCommitsTable(m.features));
  for (const f of m.features.filter((f) => f.status !== "done" && f.attempts.length > 0)) {
    parts.push(`### What was tried for ${code(f.id)}`, bulletList(f.attempts.map(attemptLine), ""));
  }
  if (m.baselineFailures.length > 0) {
    parts.push("### Checks failing before the mission", codeBlock(m.baselineFailures.join("\n")));
  }
  const notes = runNotes(m);
  if (notes.length > 0) parts.push("### Run notes", bulletList(notes, ""));
  if (proseLeftOut) {
    parts.push(
      "The AI-written summary was left out, because it described how the work was checked in words that Mission Control could not confirm from its own records. The summary at the top was written by Mission Control.",
    );
  }
  return parts.join("\n\n");
}

function featureCommitsTable(features: Feature[]): string {
  const rows = features.map((f) =>
    [
      code(f.id),
      f.status,
      f.commit ? code(shortSha(f.commit)) : "",
      f.branch ? code(f.branch) : "",
      f.builtBy ?? "",
      String(f.attempts.length),
    ].join(" | "),
  );
  return ["| Feature | Status | Commit | Branch | Built by | Attempts |", "|---|---|---|---|---|---|"]
    .concat(rows.map((r) => `| ${r} |`))
    .join("\n");
}

function attemptLine(a: Attempt): string {
  const signature = a.signature ? ` · signature ${code(a.signature)}` : "";
  const summary = a.summary ? `: ${oneLine(a.summary)}` : "";
  return `${a.at} · rung ${a.rung} ${a.action} · ${a.provider} ${code(a.model)} (${a.effort}) · ${a.outcome}${signature}${summary}`;
}

/** The architect's notes for the planner, which the dispatcher keeps in the mission's notes (`Onboarding: ...`). */
const ONBOARDING_NOTE = /^Onboarding: /u;

/**
 * Operator notes, minus the assumptions the dispatcher also copies into them (already shown above). For a mission whose plan came from the
 * leader, the architect's notes for the planner are also left out: they are guesses made before that plan was read, written for a planner
 * that is skipped, and the plan can have chosen the opposite (real run R1: the note said an empty text should probably give "!", the plan
 * said an empty text stays empty, and both were in one report).
 */
function runNotes(m: Mission): string[] {
  const assumptions = new Set(m.spec?.assumptions ?? []);
  const leaderPlan = planOf(m) !== undefined;
  return m.notes.filter((n) => !assumptions.has(n) && !(leaderPlan && ONBOARDING_NOTE.test(n)));
}

// ───────────────────────────── Small formatting helpers ─────────────────────────────

interface FeatureCounts {
  total: number;
  done: number;
  blocked: number;
  skipped: number;
  unfinished: number;
}

function countFeatures(features: Feature[]): FeatureCounts {
  const count = (status: Feature["status"]) => features.filter((f) => f.status === status).length;
  const done = count("done");
  const blocked = count("blocked");
  const skipped = count("skipped");
  return { total: features.length, done, blocked, skipped, unfinished: features.length - done - blocked - skipped };
}

function allFeaturesDone(c: FeatureCounts): boolean {
  return c.total > 0 && c.done === c.total;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

function bulletList(items: string[], empty: string): string {
  return items.length > 0 ? items.map((i) => `- ${oneLine(i)}`).join("\n") : empty;
}

/** Collapses whitespace runs (including newlines) so text stays inside one list item or table cell. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function cell(s: string): string {
  return oneLine(s).replace(/\|/g, "\\|");
}

/**
 * Inline code. The fence is longer than any run of backticks inside the text, so the text can never close the span early and what follows it
 * stays inside (a run of two backticks used to end the old two-backtick fence, and the rest of the line was live markdown). Text without a
 * backtick, and text with single backticks, come out as they always did.
 */
function code(s: string): string {
  const text = oneLine(s);
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return longestRun === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
}

/** A fenced block whose fence is longer than any backtick run inside the text. */
function codeBlock(text: string): string {
  const longestRun = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}\n${text}\n${fence}`;
}

function sentence(s: string): string {
  const text = oneLine(s);
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function formatCost(usd: number): string {
  if (usd <= 0) return "—";
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest > 0 ? ` ${rest} min` : ""}`;
}

/** "2026-10-10 07:02" in the local time zone; the raw text when it isn't a date. */
function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ───────────────────────────── Screenshots ─────────────────────────────

/** Where Playwright leaves screenshots, relative to the app's working tree. */
const SCREENSHOT_ROOTS = ["test-results", "playwright-report"];
const DEFAULT_MAX_SCREENSHOTS = 12;
const MAX_NAME_STEM = 80;

interface PngFile {
  path: string;
  /** Path relative to the app root, with "/" separators; used to build the flattened name. */
  rel: string;
  mtimeMs: number;
}

/**
 * Copies the newest distinct *.png files under fromDir/test-results and fromDir/playwright-report into destDir
 * with flattened, unique names. Returns the copied paths, newest first. Never throws for missing or unreadable files.
 */
export async function collectScreenshots(fromDir: string, destDir: string, max = DEFAULT_MAX_SCREENSHOTS): Promise<string[]> {
  if (max < 1) return [];
  const found: PngFile[] = [];
  for (const root of SCREENSHOT_ROOTS) await findPngs(join(fromDir, root), root, found);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || compare(a.rel, b.rel));

  const picked = await distinctByContent(found, max);
  if (picked.length === 0) return [];
  await mkdir(destDir, { recursive: true });
  const usedNames = new Set<string>();
  const copied: string[] = [];
  for (const file of picked) {
    const dest = join(destDir, uniqueName(flatName(file.rel), usedNames));
    try {
      await copyFile(file.path, dest);
      copied.push(dest);
    } catch {
      // vanished or unreadable since we scanned: leave it out
    }
  }
  return copied;
}

async function findPngs(dir: string, rel: string, out: PngFile[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable directory
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const relPath = `${rel}/${entry.name}`;
    // Symlinks are neither followed nor copied, so a link loop can't trap the walk.
    if (entry.isDirectory()) await findPngs(path, relPath, out);
    else if (entry.isFile() && /\.png$/i.test(entry.name)) {
      try {
        out.push({ path, rel: relPath, mtimeMs: (await stat(path)).mtimeMs });
      } catch {
        // vanished while scanning
      }
    }
  }
}

/** The HTML report keeps its own copies of test screenshots, so skip byte-identical duplicates. */
async function distinctByContent(files: PngFile[], max: number): Promise<PngFile[]> {
  const seen = new Set<string>();
  const picked: PngFile[] = [];
  for (const file of files) {
    if (picked.length >= max) break;
    let hash: string;
    try {
      hash = createHash("sha256").update(await readFile(file.path)).digest("hex");
    } catch {
      continue;
    }
    if (seen.has(hash)) continue;
    seen.add(hash);
    picked.push(file);
  }
  return picked;
}

/** "test-results/home-chromium/test-finished-1.png" → "home-chromium-test-finished-1.png". */
function flatName(rel: string): string {
  const withoutRoot = rel.split("/").slice(1).join("-");
  const stem = withoutRoot
    .slice(0, withoutRoot.length - extname(withoutRoot).length)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_NAME_STEM)
    .replace(/^[-.]+|[-.]+$/g, "");
  return `${stem || "screenshot"}.png`;
}

function uniqueName(name: string, used: Set<string>): string {
  const stem = name.slice(0, -".png".length);
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) candidate = `${stem}-${n}.png`;
  used.add(candidate);
  return candidate;
}
