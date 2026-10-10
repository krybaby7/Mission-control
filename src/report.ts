// Morning report: a warm, plain-language markdown summary of one mission for a non-programmer, the plain-text
// fact sheet the scout turns into prose, and collection of the app's Playwright screenshots.
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import type { Attempt, Feature, Finding, Mission, MissionStatus, Provider, ReportProseOutput, UsageRecord } from "./types.js";

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

/**
 * Shell commands that let the user try the result, or [] when no feature was finished (there is nothing new
 * to try, and a greenfield app may not even exist yet). Greenfield apps use the house Next.js stack.
 */
export function howToRun(m: Mission): string[] {
  if (!m.repoPath || !m.features.some((f) => f.status === "done")) return [];
  const steps = [`cd ${shellQuote(m.repoPath)}`];
  const checkout = checkoutStep(m);
  if (checkout) steps.push(checkout);
  if (m.kind === "greenfield") return [...steps, "npm install", "npm run dev", "open http://localhost:3000"];
  if (m.verify?.install) steps.push(m.verify.install);
  if (m.verify?.full) steps.push(m.verify.full);
  return steps;
}

/**
 * The git command that puts the mission's work in the user's app folder, if one is needed.
 * Finalize removes the mission's own checkout of its branch (the integration worktree) only when the mission is
 * done. Until then git refuses to check that branch out a second time, but a detached checkout of it works.
 */
function checkoutStep(m: Mission): string | undefined {
  const branch = shellQuote(m.integrationBranch);
  if (m.kind === "greenfield") {
    // Finalize fast-forwards main, which the app folder has checked out, to the mission's work.
    return m.stage === "finalize" || m.stage === "complete" ? undefined : `git checkout --detach ${branch}`;
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
    `Status: ${statusLabel(m.status)} (${m.status}). ${counts.done} of ${counts.total} features done, ` +
      `${counts.blocked} blocked, ${counts.skipped} skipped, ${counts.unfinished} unfinished.`,
  ];
  if (m.status === "partial" && allFeaturesDone(counts)) {
    // Finalize also calls a mission partial when the last whole-app check fails; say so, or it reads as a contradiction.
    lines.push("Why partly done: every feature is done, but the final check of the whole app did not fully pass (see Run notes).");
  }
  if (m.spec?.summary) lines.push(`Plan summary: ${oneLine(m.spec.summary)}`);
  lines.push(
    ...factSection("Features", m.features.map(featureFact)),
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
    ...factSection("How to try it", howToRun(m)),
  );
  return lines.join("\n") + "\n";
}

function factSection(title: string, items: string[]): string[] {
  return ["", `${title}:`, ...(items.length > 0 ? items.map((i) => `- ${oneLine(i)}`) : ["- (none)"])];
}

function featureFact(f: Feature): string {
  const head = `${f.id} "${f.title}" [${f.status}]`;
  switch (f.status) {
    case "done":
      return `${head}: ${f.story}`;
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

function findingFact(f: Feature, finding: Finding): string {
  const where = finding.file ? ` (${finding.file})` : "";
  return `[${finding.severity}] ${f.id}${where}: ${finding.description}`;
}

// ───────────────────────────── Morning report ─────────────────────────────

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
}

/** The morning report as markdown. Plain language first; technical details last. */
export function renderReport(m: Mission, opts: RenderReportOptions): string {
  const usage = missionUsage(m, opts.usage);
  const sections = [
    headerSection(m, opts.generatedAt),
    narrative(m, opts.prose),
    whatYouCanDoSection(m, opts.prose),
    howToTrySection(m),
    screenshotsSection(opts.screenshots, opts.reportDir),
    decisionsSection(m),
    featuresSection(m),
    choicesSection(m),
    reviewNotesSection(m),
    usageSection(usage),
    technicalSection(m, opts.generatedAt),
  ];
  return sections.filter((s) => s !== "").join("\n\n") + "\n";
}

function headerSection(m: Mission, generatedAt: string): string {
  const { done, total } = countFeatures(m.features);
  const progress = total === 0 ? "no features planned yet" : `${done} of ${total} features done`;
  return `# ${oneLine(m.title)}\n\n**${statusLabel(m.status)}** · ${progress} · report written ${formatLocalTime(generatedAt)}`;
}

function statusLabel(status: MissionStatus): string {
  switch (status) {
    case "done":
      return "Done";
    case "partial":
      return "Partly done";
    case "stopped":
    case "failed":
      return "Stopped";
    default:
      return "Still in progress";
  }
}

function narrative(m: Mission, prose: ReportProseOutput | null | undefined): string {
  return prose?.narrative.trim() || templateNarrative(m);
}

function templateNarrative(m: Mission): string {
  const sentences = [
    m.kind === "greenfield"
      ? `I worked on your new app, “${oneLine(m.title)}”.`
      : `I worked on your request for ${basename(m.repoPath) || "your project"}: “${oneLine(m.title)}”.`,
  ];
  if (m.spec?.summary) sentences.push(`The plan: ${sentence(m.spec.summary)}`);
  const counts = countFeatures(m.features);
  sentences.push(...progressSentences(counts), ...statusSentence(m.status, counts));
  const decisions = decisionItems(m).length;
  if (decisions > 0) {
    sentences.push(
      `There ${decisions === 1 ? "is one thing" : `are ${decisions} things`} I need you to decide; see “Needs your decision”.`,
    );
  }
  return sentences.join(" ");
}

function progressSentences(c: FeatureCounts): string[] {
  if (c.total === 0) return ["I didn't get as far as planning the features."];
  if (allFeaturesDone(c)) {
    return [c.total === 1 ? "The feature is built and checked." : `All ${c.total} features are built and checked.`];
  }
  const sentences = [
    c.done === 0
      ? "None of the features are finished yet."
      : `${c.done} of the ${c.total} features ${c.done === 1 ? "is" : "are"} built and checked.`,
  ];
  if (c.blocked > 0) sentences.push(`${plural(c.blocked, "feature")} got stuck; the table below says why.`);
  if (c.skipped > 0) {
    sentences.push(`${plural(c.skipped, "feature")} depended on a stuck feature, so I skipped ${c.skipped === 1 ? "it" : "them"}.`);
  }
  if (c.unfinished > 0) sentences.push(`${plural(c.unfinished, "feature")} ${c.unfinished === 1 ? "isn't" : "aren't"} finished yet.`);
  return sentences;
}

function statusSentence(status: MissionStatus, c: FeatureCounts): string[] {
  switch (status) {
    case "done":
      return ["Everything passed the final checks."];
    case "partial":
      return allFeaturesDone(c)
        ? [
            "But the final check of the whole app didn't fully pass, so some parts may not work together yet. " +
              "“Technical details” at the end says what it found.",
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

function howToTrySection(m: Mission): string {
  const steps = howToRun(m);
  if (steps.length === 0) {
    const why = appExists(m) ? "none of the features were finished" : "the app wasn't created";
    return section("How to try it", `There's nothing to try yet: ${why}.`);
  }
  const list = steps.map((cmd, i) => `${i + 1}. ${describeStep(m, cmd)}`).join("\n");
  const after = m.kind === "feature" ? "\n\nThen start your app the way you usually do." : "";
  return section("How to try it", `Open a terminal and run these one at a time:\n\n${list}${after}`);
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
  if (cmd === "npm run dev") return "start the app (leave this window open while you try it)";
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

function decisionsSection(m: Mission): string {
  return section("Needs your decision", bulletList(decisionItems(m), "Nothing. You don't need to do anything."));
}

function decisionItems(m: Mission): string[] {
  const items = [...m.decisionsNeeded];
  if (m.baselineBroken) {
    items.push(
      "Your project's own checks were already failing before I started, so I only used the new tests to check " +
        "my work. You may want someone to look at those older failures (listed under “Technical details”).",
    );
  }
  return items;
}

function featuresSection(m: Mission): string {
  if (m.features.length === 0) return section("Features", "No features were planned yet.");
  const rows = m.features.map((f) => `| ${featureIcon(f)} | ${cell(f.title)} | ${cell(featureOutcome(f))} |`);
  return section("Features", ["|  | Feature | What happened |", "|---|---|---|", ...rows].join("\n"));
}

function featureIcon(f: Feature): string {
  if (f.status === "done") return "✅";
  if (f.status === "blocked" || f.status === "skipped") return "⛔";
  return "⏳";
}

function featureOutcome(f: Feature): string {
  switch (f.status) {
    case "done": {
      const notes = f.openFindings.length;
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
    const where = finding.file ? ` (in ${code(finding.file)})` : "";
    const check = finding.suggestedTest ? ` Suggested check: ${oneLine(finding.suggestedTest)}` : "";
    return `**${oneLine(feature.title)}** · ${SEVERITY_WORD[finding.severity]}: ${oneLine(finding.description)}${where}${check}`;
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

function technicalSection(m: Mission, generatedAt: string): string {
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

/** Operator notes, minus the assumptions the dispatcher also copies into them (already shown above). */
function runNotes(m: Mission): string[] {
  const assumptions = new Set(m.spec?.assumptions ?? []);
  return m.notes.filter((n) => !assumptions.has(n));
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

function code(s: string): string {
  const text = oneLine(s);
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
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
