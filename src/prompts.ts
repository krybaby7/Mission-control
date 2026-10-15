// Agent briefs: compact markdown prompts for every stage, plus loaders for the role prompts and stack docs.
// Builders are pure functions of their inputs. Size caps keep briefs within context and price limits.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkedWords, hasModeFeature, howChecked, isModeFeature } from "./checked-by.js";
import type { ContextPackOutput, FailureDigestOutput, Feature, FeatureExpect, Finding, Mission, Role, Spec, SpecFeature, SpecOutput, VerifyConfig } from "./types.js";

export const CAPS = {
  diff: 60_000,
  outputTail: 15_000,
  fileList: 1_500,
  /** Scout briefs must stay under 250 000 chars including the scout system prompt, so Haiku stays in its ≤100K-token price band. */
  scoutPrompt: 240_000,
  /** The user's request inside scout briefs, so a huge request can't crowd out the instructions. */
  scoutRequest: 20_000,
  /** Report facts are the only unbounded input of the report-prose scout brief. */
  reportFacts: 100_000,
} as const;

// ───────────────────────────── Package assets ─────────────────────────────

let cachedRoot: string | undefined;

/** The directory containing package.json: the repo root from src/ (tests) and from dist/ (built CLI). */
export function packageRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  const start = dirname(fileURLToPath(import.meta.url));
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return (cachedRoot = dir);
    if (dirname(dir) === dir) throw new Error(`Cannot find package.json in ${start} or any parent directory`);
  }
}

/** The provider-neutral system prompt for a role (prompts/<role>.md). */
export function loadRolePrompt(role: Role): string {
  return readAsset(join(packageRoot(), "prompts", `${role}.md`), `role prompt "${role}"`);
}

/** The two prompt files for features that are not checked by tests: the maker builds a document, a page or a data file, the checker judges it (docs/modes-spec.md 8.1, 8.2, 8.4). */
export type VariantPrompt = "maker" | "checker";

export function loadVariantPrompt(name: VariantPrompt): string {
  if (name !== "maker" && name !== "checker") throw new Error(`Unknown prompt "${String(name)}": use "maker" or "checker"`);
  return readAsset(join(packageRoot(), "prompts", `${name}.md`), `prompt "${name}"`);
}

/** A house stack document (stacks/<name>.md). */
export function loadStack(name = "nextjs"): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid stack name "${name}": use lowercase letters, digits and dashes`);
  const dir = join(packageRoot(), "stacks");
  const file = join(dir, `${name}.md`);
  if (!existsSync(file)) {
    const available = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)) : [];
    throw new Error(`Unknown stack "${name}". Available stacks: ${available.join(", ") || "none"}`);
  }
  return readAsset(file, `stack "${name}"`);
}

function readAsset(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err) {
    throw new Error(`Cannot read ${what} at ${path}: ${(err as Error).message}`);
  }
}

// ───────────────────────────── Size helpers ─────────────────────────────

/** Keeps the start and end of `s`, replacing the middle with a marker, so the result is at most `maxChars` long. */
export function truncateMiddle(s: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (s.length <= limit) return s;
  const marker = (omitted: number) => `\n… [${omitted} chars omitted] …\n`;
  // Budget with the widest possible marker, so the real one always fits.
  const room = limit - marker(s.length).length;
  if (room <= 0) return s.slice(0, limit);
  const head = Math.ceil(room / 2);
  return s.slice(0, head) + marker(s.length - room) + s.slice(s.length - (room - head));
}

/** Room kept for the "more files omitted" note when a file list is capped by characters. */
const OMITTED_NOTE_ROOM = 40;

/** One path per line, capped at `max` entries and about `maxChars` characters, with a note about the rest. */
export function formatFileList(paths: string[], max: number = CAPS.fileList, maxChars = Number.POSITIVE_INFINITY): string {
  if (paths.length === 0) return "(no files)";
  const room = maxChars - OMITTED_NOTE_ROOM;
  const shown: string[] = [];
  let used = 0;
  for (const path of paths.slice(0, Math.max(0, max))) {
    used += path.length + 1;
    if (used > room) break;
    shown.push(path);
  }
  const omitted = paths.length - shown.length;
  return [...shown, ...(omitted > 0 ? [`… (${omitted} more files omitted)`] : [])].join("\n");
}

// ───────────────────────────── Spec stage ─────────────────────────────

export function specPrompt(m: Mission, stackDoc: string | null, revise?: { previous: SpecOutput; issues: string[] }): string {
  const task =
    m.kind === "greenfield"
      ? [
          "Write the spec for this new app: the features to build, in build order.",
          "There is no repository yet, so plan from the request and the house stack below. An initializer scaffolds the project (tooling, test setup, AGENTS.md) before feature work starts, so don't plan setup work.",
        ]
      : [
          "Write the spec for this change to an existing codebase: the features to build, in build order.",
          "The repository is checked out in your working directory. Explore it with your read-only tools before planning, follow its conventions, and plan only what the request asks for. The UI contract must cover both the existing UI the tests will touch and the new UI.",
          ...existingRepoFacts(m),
        ];
  return brief(
    missionHeader(m),
    section("Your task", [
      ...task,
      "Plan between 1 and 25 features with unique kebab-case ids. `deps` may name only ids from this spec, with no cycles.",
      "Answer with JSON matching the output schema.",
    ]),
    stackDoc && section("House stack", [stackDoc]),
    revise && revisionSection(revise),
  );
}

function existingRepoFacts(m: Mission): string[] {
  const facts: string[] = [];
  if (m.verify) facts.push(`Its full verification runs ${code(m.verify.full)}, and test files match ${globList(m.verify)}.`);
  if (m.baselineBroken) facts.push("Its full verification already fails before any change; don't plan work to fix that unless the request asks for it.");
  return facts;
}

function revisionSection(revise: { previous: SpecOutput; issues: string[] }): string {
  const modeIds = revise.previous.features.filter(isModeFeature).map((f) => f.id);
  return section("Revise your previous spec", [
    "A reviewer asked for changes. Address every issue below and keep what was fine.",
    modeIds.length > 0 &&
      `Some features are judged by reading the result and not by tests. Their ids are: ${modeIds.map(code).join(", ")}. Keep every one of these ids, do not split, merge or drop these features, and write their checks as statements a reader can judge from the files, not as tests.`,
    bullets(revise.issues),
    "Previous spec:",
    fence(JSON.stringify(revise.previous, null, 2), "json"),
  ]);
}

export function gateAPrompt(m: Mission): string {
  const spec = requireSpec(m);
  // With a feature that is judged by reading, the check bullet says how each kind of feature is judged (spec 8.5).
  const checkable = hasModeFeature(spec.features)
    ? "each feature fits one focused build session, and its checks can be judged: by an automated test for a feature marked as checked by tests, and by reading the result for a feature marked as checked by a second AI (it opens the files and, for a page, pictures);"
    : "each feature fits one focused build session and its acceptance criteria can be checked by an automated test;";
  return brief(
    missionHeader(m),
    section("Your task", [
      "Review this spec before any code is written. Judge it from the request and the spec alone.",
      "Approve unless a problem would lead to a wrong or unbuildable app. Check that:",
      bullets([
        "it delivers what the user asked for, without costly extras nobody requested;",
        checkable,
        "the UI contract names every route, label and test id the criteria rely on, so tests and code written separately will agree;",
        "deps are correct and the first feature delivers the core user flow;",
        "nothing needs paid services, API keys or accounts the request didn't provide.",
      ]),
      'Answer with JSON: `verdict` ("approve" or "revise") and `issues`, each a concrete change to make (empty when approving).',
    ]),
    section("Spec", [renderSpec(spec)]),
  );
}

function renderSpec(spec: Spec): string {
  const modes = hasModeFeature(spec.features);
  const features = spec.features.map((f, i) => `### ${i + 1}. ${featureTitle(f)} (${f.kind})\n\n${featureBody(f)}${modes ? modeLines(f) : ""}`);
  return [
    `**App:** ${spec.appName}`,
    `**Summary:** ${spec.summary}`,
    ...features,
    "### Assumptions",
    bullets(spec.assumptions),
    "### UI contract",
    spec.uiContract.trim() || "(none)",
  ].join("\n\n");
}

// ───────────────────────────── Onboarding and init ─────────────────────────────

export function onboardPrompt(m: Mission, fileList: string[]): string {
  return brief(
    missionHeader(m),
    section("Your task", [
      "Onboard this existing repository so the team can verify changes automatically. You are in its root; read whatever you need, but don't change anything.",
      "Work out:",
      bullets([
        "`stackSummary`: languages, frameworks, test tools and layout, in a few sentences an engineer can act on.",
        "`verify.install`: the command that installs dependencies, matching the lockfile (for example `npm ci` or `pnpm install --frozen-lockfile`), or null when nothing needs installing.",
        "`verify.full`: one command that runs every existing check (lint, typecheck, unit and e2e tests), chained with `&&`, exiting 0 only when all pass.",
        "`verify.tests`: a command that runs only the given test files, with `{files}` where the space-separated paths go (for example `npx vitest run {files}`), or null when the tools can't run single files.",
        "`verify.testGlobs`: repo-relative globs that match the test files, including where new tests for this request belong.",
        "`notes`: what the team must know, such as required services or environment variables, slow or flaky suites, or missing test tooling.",
      ]),
      "The orchestrator runs these commands non-interactively with `bash -lc` from the repository root and CI=1. Prefer the repository's own scripts, and don't invent ones that don't exist. If there are no tests at all, make `full` the strongest existing check (such as a build or typecheck) and say so in notes.",
    ]),
    fileListSection(fileList),
  );
}

export function initPrompt(m: Mission, stackDoc: string, failure?: { outputTail: string; attempt: number }): string {
  const spec = requireSpec(m);
  return brief(
    missionHeader(m),
    section("Your task", [
      `Scaffold the app "${spec.appName}" exactly as the house stack below describes, until its full verification passes. Write AGENTS.md as the stack describes, with the UI contract below copied in verbatim.`,
      "Don't implement any planned feature; they are built one at a time after the scaffold is committed. Don't commit: the orchestrator commits once verification passes.",
      "Answer with JSON: `summary`, the `verify` config the stack document specifies, and `notes` (anything unusual, such as a workaround you needed).",
    ]),
    section("The app", [spec.summary, "Planned features, for context only:", bullets(spec.features.map(featureTitle))]),
    uiContractSection(m),
    section("House stack", [stackDoc]),
    failure &&
      section("The previous attempt failed", [
        `Attempt ${failure.attempt} ended with failing verification. Its files are probably still in the working tree, so check \`git status\` first, then fix the cause instead of starting over.`,
        fence(truncateMiddle(failure.outputTail, CAPS.outputTail)),
      ]),
  );
}

// ───────────────────────────── Feature stages ─────────────────────────────

export function testAuthorPrompt(
  m: Mission,
  f: Feature,
  ctx: { fileList: string[]; amendReason?: string; previousTestFiles?: string[]; vacuous?: boolean },
): string {
  const previous = ctx.previousTestFiles ?? [];
  return brief(
    missionHeader(m),
    section("Your task", [
      `Write the acceptance tests for feature ${code(f.id)} before it is implemented.`,
      bullets([
        `Put tests only in files matching ${m.verify ? globList(m.verify) : "the project's test directories"}. Changes anywhere else are discarded.`,
        runTestsInstruction(m.verify),
        "Answer with JSON: `testFiles` (every test file you created or changed, repo-relative) and `notes`.",
      ]),
    ]),
    ctx.amendReason &&
      section("Rewrite the current tests", [
        `An architect judged this feature's current acceptance tests wrong: ${ctx.amendReason}`,
        "Fix that and keep the parts that were right.",
        previous.length > 0 && pathList(previous),
      ]),
    ctx.vacuous &&
      section("Your previous tests passed without the feature", [
        "They pass against the current code, so they don't check this feature. Make them fail until the feature exists, for example by asserting the new behavior from the acceptance criteria and the UI contract.",
        previous.length > 0 && pathList(previous),
      ]),
    featureSection(f),
    uiContractSection(m),
    fileListSection(ctx.fileList),
  );
}

export function buildPrompt(
  m: Mission,
  f: Feature,
  ctx: {
    rung: number;
    fileList: string[];
    contextPack?: ContextPackOutput | null;
    hint?: string | null;
    lastFailure?: { outputTail: string; digest?: FailureDigestOutput | null; antiCheat?: string[]; frozenViolations?: string[] } | null;
    reviewFindings?: Finding[] | null;
  },
): string {
  const findings = ctx.reviewFindings ?? [];
  const task =
    findings.length > 0
      ? `A reviewer found problems in the implementation of feature ${code(f.id)}. Fix the blocker and major findings below. The tests pass now and must keep passing.`
      : `Implement feature ${code(f.id)} so that its acceptance tests and the full verification pass.`;
  return brief(
    missionHeader(m),
    section("Your task", [
      task,
      ctx.rung > 0 &&
        `Earlier attempts at this feature failed (this is escalation step ${ctx.rung + 1}). Earlier work may already be committed on this branch, so inspect the current code before changing it.`,
      "Answer with JSON: `summary`, `filesChanged`, `testDispute` (null unless a frozen test is genuinely wrong) and `notes`.",
    ]),
    featureSection(f),
    uiContractSection(m),
    frozenTestsSection(f),
    verifySection(m, f),
    findings.length > 0 && section("Review findings to fix", [renderFindings(findings)]),
    ctx.hint && section("Guidance from a diagnosis of earlier attempts", [ctx.hint]),
    ctx.lastFailure && lastFailureSection(ctx.lastFailure),
    ctx.contextPack && contextPackSection(ctx.contextPack),
    fileListSection(ctx.fileList),
  );
}

function frozenTestsSection(f: Feature): string {
  if (f.frozenTests.length === 0) {
    return section("Tests", [
      "No acceptance tests were written for this feature, so the acceptance criteria and the full verification are the bar.",
      "Don't modify existing tests: they guard features that are already done.",
    ]);
  }
  return section("Frozen acceptance tests", [
    "The test author wrote these files before you started. **You must not modify these files**: they are checksummed, any edit is reverted automatically, and the attempt then counts as failed. Existing tests from earlier features are off limits too.",
    pathList(f.frozenTests.map((t) => t.path)),
  ]);
}

function verifySection(m: Mission, f: Feature): string {
  const vc = m.verify;
  if (!vc) return section("Verify your work", ["No verify commands are configured; see AGENTS.md for how to run the checks."]);
  const files = f.frozenTests.map((t) => t.path);
  const steps: string[] = [];
  if (vc.install) steps.push(`Dependencies install with ${code(vc.install)}; run it again after adding a dependency.`);
  if (vc.tests && files.length > 0) steps.push(`Feature tests: ${code(withFiles(vc.tests, files))}. Run these first and iterate until they pass.`);
  steps.push(
    m.baselineBroken
      ? `Full verification: ${code(vc.full)}. It was already failing before this mission started, so only the feature tests decide this attempt; don't spend time on the pre-existing failures.`
      : `Full verification: ${code(vc.full)}. Run it once the feature tests pass; it must pass too.`,
  );
  return section("Verify your work", [
    numbered(steps),
    m.baselineBroken && m.baselineFailures.length > 0 && `Pre-existing failures:\n${bullets(m.baselineFailures)}`,
    "The orchestrator runs the same commands from the repository root with CI=1 after you finish, and only a green result counts.",
  ]);
}

function lastFailureSection(failure: { outputTail: string; digest?: FailureDigestOutput | null; antiCheat?: string[]; frozenViolations?: string[] }): string {
  const { digest, antiCheat = [], frozenViolations = [] } = failure;
  return section("The previous attempt failed", [
    frozenViolations.length > 0 && `It modified frozen test files, which were restored:\n${pathList(frozenViolations)}`,
    antiCheat.length > 0 && `These changes were rejected as weakening the tests:\n${bullets(antiCheat)}`,
    digest &&
      [`**Summary:** ${digest.summary}`, `**Likely cause:** ${digest.likelyCause}`, digest.failingTests.length > 0 && `**Failing tests:**\n${bullets(digest.failingTests)}`]
        .filter(Boolean)
        .join("\n"),
    "Verification output (end):",
    fence(truncateMiddle(failure.outputTail, CAPS.outputTail)),
  ]);
}

function contextPackSection(pack: ContextPackOutput): string {
  return section("Files to read first", [
    pack.files.length > 0 ? bullets(pack.files.map((f) => `${code(f.path)}: ${f.why}`)) : "(none suggested)",
    pack.notes.trim() || false,
  ]);
}

export function reviewPrompt(m: Mission, f: Feature, ctx: { diff: string; verifyTail: string }): string {
  return brief(
    missionHeader(m),
    section("Your task", [
      `Review the implementation of feature ${code(f.id)}. ${checksPassed(m, f)}`,
      "The change is checked out in your working directory; read the changed files for context, especially if the diff below is truncated.",
      'Answer with JSON: `verdict` ("approve" when there is no blocker or major finding, otherwise "changes") and `findings`.',
    ]),
    featureSection(f),
    uiContractSection(m),
    testListSection(f),
    baselineSection(m),
    section("Diff", [fence(truncateMiddle(ctx.diff, CAPS.diff), "diff")]),
    section("Verification output (end)", [fence(truncateMiddle(ctx.verifyTail, CAPS.outputTail))]),
  );
}

/** Which automated checks gated the feature before review: the dispatcher skips full verification on a broken baseline. */
function checksPassed(m: Mission, f: Feature): string {
  const hasTests = f.frozenTests.length > 0;
  if (!m.baselineBroken) {
    return hasTests ? "Its frozen acceptance tests and the full verification pass (output below)." : "No acceptance tests were written for it; the full verification passes (output below).";
  }
  const skipped = "The full verification did not gate it, because it was already failing before this mission (see below).";
  return hasTests
    ? `Its frozen acceptance tests pass (output below). ${skipped}`
    : `No acceptance tests were written for it. ${skipped} No automated check covers it, so check it against the acceptance criteria with extra care.`;
}

export function diagnosisPrompt(m: Mission, f: Feature, ctx: { lastOutputTail: string; diff: string; dispute?: { file: string; reason: string } | null }): string {
  return brief(
    missionHeader(m),
    section("Your task", [
      `Feature ${code(f.id)} keeps failing. Find the root cause and decide the next step. The attempt is checked out in your working directory; read the tests and the code.`,
      bullets([
        "`retry_with_hint`: the tests are right and the feature is buildable. `hint` tells the next engineer exactly what is wrong (files, functions, the actual mistake) and what to do instead.",
        "`amend_tests`: a frozen test contradicts the acceptance criteria or the UI contract, is nondeterministic, or checks something impossible. `reason` says exactly what is wrong with which test.",
        "`block`: the feature cannot be built without the owner, for example missing credentials or contradictory requirements. `reason` explains it in plain language.",
      ]),
      "Answer with JSON: `action`, `hint` and `reason` (empty when it doesn't apply).",
    ]),
    ctx.dispute &&
      section("The engineer disputes a test", [
        `The last engineer reported ${code(ctx.dispute.file)} as wrong: ${ctx.dispute.reason}`,
        "Decide whether they are right. If they are, choose `amend_tests`; if not, explain in `hint` why the test is right and how to satisfy it.",
      ]),
    featureSection(f),
    uiContractSection(m),
    testListSection(f),
    f.attempts.length > 0 && section("Attempts so far", [numbered(f.attempts.map(describeAttempt))]),
    f.hint && section("Earlier diagnosis hint", [f.hint]),
    section("Last verification output (end)", [fence(truncateMiddle(ctx.lastOutputTail, CAPS.outputTail))]),
    section("Diff of the attempt since the tests were committed", [fence(truncateMiddle(ctx.diff, CAPS.diff), "diff")]),
  );
}

function describeAttempt(a: Feature["attempts"][number]): string {
  const signature = a.signature ? `, failure ${a.signature}` : "";
  return `${a.action} with ${a.model} (${a.effort}): ${a.outcome}${signature}. ${a.summary}`.trim();
}

// ───────────────────────────── Features that are not checked by tests (docs/modes-spec.md 8.4) ─────────────────────────────

/** What the maker is given besides the feature. */
export interface MakeContext {
  /** The step of the ladder this attempt is on, from 0. */
  rung: number;
  fileList: string[];
  contextPack?: ContextPackOutput | null;
  /** A fix round: the checks that are not met (with what the second AI found), or the owner's note. */
  fixes?: Finding[] | null;
  /** What the script found wrong in the last attempt that failed, one problem each. */
  lastProblems?: string[] | null;
}

/** The brief for the builder of a document, a page or a data file: an attempt, or a fix round. It names no frozen test and no verify command. */
export function makePrompt(m: Mission, f: Feature, ctx: MakeContext): string {
  const fixes = ctx.fixes ?? [];
  const problems = ctx.lastProblems ?? [];
  return brief(
    missionHeader(m),
    section("Your task", [
      `Make the deliverable for feature ${code(f.id)}. A script, and then a second AI, will check it against the numbered checks below. No tests are written for it.`,
      fixes.length > 0 && "It was checked, and the problems listed below were found. Fix each one. The checks that passed must stay true.",
      ctx.rung > 0 &&
        `Earlier attempts failed the engine's checks (this is escalation step ${ctx.rung + 1}). Earlier work may already be committed on this branch, so open the files before you change them.`,
      "Answer with JSON: `summary`, `filesChanged`, `testDispute` (always null) and `notes`.",
    ]),
    modeFeatureSection(f),
    section("What the script also checks", [
      expectSentences(f.expect).length > 0 && `The plan asks for this:\n${bullets(expectSentences(f.expect))}`,
      "Whatever you make, the script checks that some file changed, that no file is empty or very large, that nothing is left as a placeholder, that no key or password is in a file, that no table cell starts like a formula, and that links to files in the project work.",
      "If you make a web page, it also checks a title, a viewport line, a description for each picture, no sideways scrolling at phone width, and nothing loaded from the internet.",
      "If you change anything but documents, pages, images and data files, it also checks that the project's own checks pass.",
    ]),
    modeContractSection(m),
    fixes.length > 0 && section("Problems to fix", [renderFindings(fixes)]),
    problems.length > 0 &&
      section("The previous attempt failed", [
        "The script found these problems. The files of that attempt are probably still in the working tree, so open them first and fix each problem.",
        bullets(problems),
      ]),
    ctx.contextPack && contextPackSection(ctx.contextPack),
    fileListSection(ctx.fileList),
  );
}

/** What the checker is given besides the feature. */
export interface RubricContext {
  /** Mission Control's own facts (docs/modes-spec.md 6.2, "Facts"), one each. */
  facts: string[];
  /** The pictures it is offered: the absolute path of each and what it shows. */
  pictures: { path: string; label: string }[];
  /** Why no picture is given (spec 7.3, "The checker is told"). Absent when pictures are given or the feature has no page. */
  noPictures?: string;
  /** The files the feature changed that can be read; the first 20 are listed. */
  files: string[];
  /** The condensed diff, or "" when only binary files changed. */
  diff: string;
  /** From the second round: the numbers of the checks that failed last time. */
  lastFailed?: number[];
}

/** The brief for the second AI that judges every written check of a feature that no test checked. */
export function rubricPrompt(m: Mission, f: Feature, ctx: RubricContext): string {
  const listed = ctx.files.slice(0, 20);
  const left = ctx.files.length - listed.length;
  const engine = expectSentences(f.expect);
  return brief(
    missionHeader(m),
    section("Your task", [
      `Judge the finished feature ${code(f.id)} against the numbered checks below. No tests were written for it. The changed files are checked out in your working folder: open them. Answer for every check with \`pass\`, \`fail\` or \`cannot_judge\` and evidence, as your instructions say. Answer with JSON: \`verdict\`, \`results\`, \`seen\` and \`notes\`.`,
    ]),
    section("Feature", [featureTitle(f), f.story]),
    section("Checks", [numbered(f.acceptance)]),
    section("What the engine's script found", [
      "All the script's checks passed.",
      engine.length > 0 && `They included what the plan asked for:\n${bullets(engine)}`,
      ctx.facts.length > 0 && bullets(ctx.facts),
    ]),
    ctx.pictures.length > 0
      ? section("Pictures", [bullets(ctx.pictures.map((p) => `${p.path}: ${p.label}`)), "Open each one with the Read tool."])
      : ctx.noPictures !== undefined && section("Pictures", [ctx.noPictures]),
    section("Changed files", [listed.length > 0 ? `${pathList(listed)}${left > 0 ? `\n… (${left} more files changed)` : ""}` : "(none that can be read)"]),
    ctx.diff !== "" && section("Diff", [fence(truncateMiddle(ctx.diff, CAPS.diff), "diff")]),
    ctx.lastFailed &&
      ctx.lastFailed.length > 0 &&
      section("The last round", [
        `Last time ${ctx.lastFailed.length === 1 ? "check" : "checks"} ${ctx.lastFailed.join(", ")} failed. The files have changed since then. Judge every check again from the files, and not from this note.`,
      ]),
  );
}

/** The feature as the maker reads it: the checks are a list that the second AI will judge one by one. */
function modeFeatureSection(f: SpecFeature): string {
  const deps = f.deps.length > 0 ? `\n\nBuilds on: ${f.deps.map(code).join(", ")}` : "";
  return `## Feature ${featureTitle(f)}\n\n${f.story}\n\nChecks the second AI will judge, one by one:\n${numbered(f.acceptance)}${deps}`;
}

/** The plan's names, when it gives any (the same text as the UI contract of the other briefs). */
function modeContractSection(m: Mission): string | false {
  const contract = m.spec?.uiContract.trim();
  return !!contract && section("UI contract", ["Shared by the work and its checks: names, labels and file names must match exactly.", contract]);
}

/** How the plan's own checks read, in the words of `mc plan show` (docs/modes-spec.md 4.4). A damaged value is read as far as it can be. */
function expectSentences(expect: FeatureExpect | undefined): string[] {
  if (typeof expect !== "object" || expect === null) return [];
  const e = expect as Record<string, unknown>;
  const values = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.replace(/\s+/g, " ").trim().replace(/[“”]/g, '"')) : []);
  const range = (x: unknown): [number, number] | undefined =>
    Array.isArray(x) && x.length === 2 && x.every((v) => typeof v === "number" && Number.isFinite(v)) ? [x[0] as number, x[1] as number] : undefined;
  const quoted = (xs: string[]): string => xs.map((x) => `“${x}”`).join(", ");
  const headings = values(e.headings);
  const mentions = values(e.mentions);
  const columns = values(e.columns);
  const words = range(e.words);
  const rows = range(e.rows);
  return [
    ...(headings.length > 0 ? [`It has the headings ${quoted(headings)}.`] : []),
    ...(mentions.length > 0 ? [`Its visible text contains the words ${quoted(mentions)}, written exactly like that.`] : []),
    ...(words ? [`Its new text is ${words[0]} to ${words[1]} words long.`] : []),
    ...(columns.length > 0 ? [`The table has the columns ${columns.join(", ")}.`] : []),
    ...(rows ? [`The table has ${rows[0]} to ${rows[1]} rows.`] : []),
  ];
}

/** Under a feature's criteria in the brief for gate A: how it is checked and how hard the team thinks (docs/modes-spec.md 8.5). Only called when the plan has a mode feature. */
function modeLines(f: SpecFeature): string {
  const how =
    f.mode === "owner"
      ? "Checked by: a second AI against its list of checks, and then by the owner, no tests."
      : f.mode === "review"
        ? "Checked by: a second AI against its list of checks, no tests."
        : "Checked by: tests, written first.";
  const effort = f.effort === "light" || f.effort === "deep" ? `\nEffort: ${f.effort}.` : "";
  return `\n\n${how}${effort}`;
}

// ───────────────────────────── Gate C ─────────────────────────────

export function gateCPrompt(m: Mission, ctx: { diff: string; verifyTail: string; features: Feature[] }): string {
  const verifyFailures = m.baselineBroken ? "new failures in the full verification below" : "anything the full verification below reports as failing";
  const read = ctx.features.some((f) => f.status === "done" && isModeFeature(f));
  return brief(
    missionHeader(m),
    section("Your task", [
      "Do the final review of everything built in this mission before the owner sees it. Features were built and merged one at a time; check that together they deliver the request.",
      `Look for broken flows between features, regressions, security holes, data loss, and ${verifyFailures}. Blocked or skipped features are known gaps, not findings.`,
      read &&
        "Some features here are documents, pages or data files that no test judged. The feature list says how each was checked: by a second AI against the owner's list, or by Mission Control's own checks only. Read them as a reader would. Look for false statements, broken links, pages that cannot be used, and numbers that do not add up.",
      "Blocker and major findings become fix-up work right away, so report only real problems, each with a file and a suggested test. The integrated code is in your working directory; read it as needed, especially if the diff is truncated.",
      'Answer with JSON: `verdict` ("approve" when there is no blocker or major finding, otherwise "changes") and `findings`.',
    ]),
    m.spec && section("The app", [m.spec.summary]),
    section("Features", [ctx.features.length > 0 ? ctx.features.map((f) => describeFeatureStatus(m, f)).join("\n\n") : "(none)"]),
    uiContractSection(m),
    baselineSection(m),
    section("Full verification output (end)", [fence(truncateMiddle(ctx.verifyTail, CAPS.outputTail))]),
    section("Diff of the whole mission", [fence(truncateMiddle(ctx.diff, CAPS.diff), "diff")]),
  );
}

function describeFeatureStatus(m: Mission, f: Feature): string {
  const head = `**${featureTitle(f)}**: ${f.status}`;
  if (f.status === "done") {
    const how = isModeFeature(f) ? `\nChecked ${checkedWords(howChecked(m, f))}. No tests were written for it.` : "";
    return `${head}\n${numbered(f.acceptance)}${how}`;
  }
  return f.blockedReason ? `${head} (${f.blockedReason})` : head;
}

// ───────────────────────────── Scout briefs ─────────────────────────────

export function contextPackPrompt(m: Mission, f: Feature, fileList: string[]): string {
  const parts = [
    missionHeader(m, CAPS.scoutRequest),
    section("Your task", [
      "An engineer is about to implement the feature below. From the file list, pick up to 15 existing files they should read first: files the feature will change, and files whose patterns it should follow (pages, components, data access, schema, related tests). Give a short reason for each.",
      "Use only paths from the list. In `notes`, add one or two sentences of orientation, such as where similar code lives, or leave it empty.",
      "Answer with JSON: `files` (each with `path` and `why`) and `notes`.",
    ]),
    featureSection(f),
    uiContractSection(m),
    testListSection(f),
  ];
  // The file list is the bulk of this brief, so it gets whatever room the rest leaves under the scout cap.
  const room = CAPS.scoutPrompt - brief(...parts).length - SECTION_FRAME_ROOM;
  return scoutBrief(...parts, fileListSection(fileList, room));
}

export function failureDigestPrompt(outputTail: string): string {
  return scoutBrief(
    "# Failure digest",
    section("Your task", [
      "Summarize this failing verification output for the engineer who will fix it.",
      bullets([
        "`summary`: what failed, in one or two sentences.",
        '`likelyCause`: the most likely root cause, as specific as the output allows (file, line, message), or "unclear from the output".',
        "`failingTests`: the names or files of the failing tests, copied from the output.",
      ]),
    ]),
    section("Output (end)", [fence(truncateMiddle(outputTail, CAPS.outputTail))]),
  );
}

export function reportProsePrompt(m: Mission, facts: string): string {
  const modes = m.features.some((f) => f.status === "done" && isModeFeature(f));
  return scoutBrief(
    missionHeader(m, CAPS.scoutRequest),
    section("Your task", [
      "Write the summary of this mission for its owner, who is not a programmer, using only the facts below.",
      bullets([
        "`narrative`: 3 to 8 plain sentences covering what was built, what works, what didn't get done and why, and anything the owner needs to decide. No jargon, file names or model names.",
        '`whatYouCanDo`: short items, each something the owner can now do in the app (for example "Add a habit and tick it off each day"). Include only features the facts show as done.',
      ]),
      "Don't invent features or outcomes the facts don't show.",
      modes && "Say how each feature was checked exactly as the facts say. Never say that tests passed for a feature whose line says it was checked another way.",
    ]),
    section("Facts", [fence(truncateMiddle(facts, CAPS.reportFacts))]),
  );
}

// ───────────────────────────── Shared sections ─────────────────────────────

type Part = string | false | null | undefined;

function brief(...parts: Part[]): string {
  return `${parts.filter(isText).join("\n\n")}\n`;
}

/** A scout brief under the scout cap. Builders cap the request and budget their bulk input, so the middle cut here is
 *  only a last resort for absurdly long spec text; it keeps the start, where the request and instructions sit. */
function scoutBrief(...parts: Part[]): string {
  return truncateMiddle(brief(...parts), CAPS.scoutPrompt);
}

/** Room for a section's heading, fences and separators when budgeting its body. */
const SECTION_FRAME_ROOM = 100;

function section(title: string, parts: Part[]): string {
  return [`## ${title}`, ...parts.filter(isText)].join("\n\n");
}

function isText(part: Part): part is string {
  return typeof part === "string" && part !== "";
}

function missionHeader(m: Mission, maxRequestChars = Number.POSITIVE_INFINITY): string {
  const kind = m.kind === "greenfield" ? "builds a new app" : "changes an existing codebase";
  return `# Mission: ${m.title}\n\nThis mission ${kind}. The user's request, verbatim:\n\n${fence(truncateMiddle(m.request, maxRequestChars))}`;
}

function featureTitle(f: SpecFeature): string {
  return `${code(f.id)} ${f.title}`;
}

function featureBody(f: SpecFeature): string {
  const deps = f.deps.length > 0 ? `\n\nBuilds on: ${f.deps.map(code).join(", ")}` : "";
  return `${f.story}\n\nAcceptance criteria:\n${numbered(f.acceptance)}${deps}`;
}

function featureSection(f: SpecFeature): string {
  return `## Feature ${featureTitle(f)}\n\n${featureBody(f)}`;
}

function uiContractSection(m: Mission): string {
  return section("UI contract", [
    "Shared by the tests and the implementation: routes, labels and test ids must match exactly.",
    m.spec?.uiContract.trim() || "(none defined)",
  ]);
}

function testListSection(f: Feature): string | false {
  return f.frozenTests.length > 0 && section("Acceptance tests (frozen)", [pathList(f.frozenTests.map((t) => t.path))]);
}

function fileListSection(paths: string[], maxChars?: number): string {
  return section("Files in the repository", [fence(formatFileList(paths, CAPS.fileList, maxChars))]);
}

/** For a broken baseline: the failures that predate the mission, which reviewers must not blame on it. */
function baselineSection(m: Mission): string | false {
  return (
    m.baselineBroken &&
    section("Failures from before this mission", [
      "The full verification was already failing before this mission started. Those failures are not findings unless this mission's changes made them worse.",
      m.baselineFailures.length > 0 && bullets(m.baselineFailures),
    ])
  );
}

function renderFindings(findings: Finding[]): string {
  return numbered(
    findings.map((f) => {
      const where = f.file ? ` in ${code(f.file)}` : "";
      const test = f.suggestedTest ? `\n   Suggested test: ${f.suggestedTest}` : "";
      return `**${f.severity}**${where}: ${f.description}${test}`;
    }),
  );
}

function runTestsInstruction(vc: VerifyConfig | undefined): string {
  if (!vc?.tests) return "Run your tests with the project's test command (see AGENTS.md) and confirm they fail because the feature is missing.";
  return `Run them with ${code(vc.tests)}, replacing \`{files}\` with your test file paths, and confirm they fail because the feature is missing, not because of a mistake in the tests.`;
}

function globList(vc: VerifyConfig): string {
  return vc.testGlobs.length > 0 ? vc.testGlobs.map(code).join(", ") : "(no test globs configured)";
}

function requireSpec(m: Mission): Spec {
  if (!m.spec) throw new Error(`Mission ${m.id} has no spec yet`);
  return m.spec;
}

// ───────────────────────────── Markdown and shell helpers ─────────────────────────────

function bullets(items: string[]): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "(none)";
}

function numbered(items: string[]): string {
  return items.length > 0 ? items.map((item, i) => `${i + 1}. ${item}`).join("\n") : "(none)";
}

function pathList(paths: string[]): string {
  return bullets(paths.map(code));
}

function code(s: string): string {
  return s.includes("`") ? `\`\` ${s} \`\`` : `\`${s}\``;
}

/** A fenced block whose fence is longer than any backtick run inside, so content can never close it early. */
function fence(body: string, lang = ""): string {
  const longestRun = (body.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}${lang}\n${body.replace(/\n+$/, "")}\n${ticks}`;
}

/** Same substitution the Verifier performs, so the command shown to agents is the command that runs. */
function withFiles(template: string, files: string[]): string {
  const quoted = files.map(shellQuote).join(" ");
  return template.includes("{files}") ? template.replaceAll("{files}", () => quoted) : `${template} ${quoted}`;
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}
