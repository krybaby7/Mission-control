// Plans written outside the team (by the leader): the line format, its strict reader, and the plan in plain words.
//
// A plan is plain text, one `key: value` fact per line, and its first line is `mc-plan 1`. `parsePlan` turns it into the
// planner's own `SpecOutput` plus a small envelope (name, request, folder, base) and a plan code, or lists everything
// wrong with it in words that say what to do. `describePlan` writes a plan back in words for `mc plan preview`, `queue`
// and `show` and for the owner's check, so the owner sees exactly what the team will build from. The grammar, every limit
// and every message are in docs/plans-spec.md (sections 3.1 to 3.3).
//
// Plan text is untrusted: it has no key that is run, opened or followed, no curly bracket and no backtick, and each value
// is plain words (no hidden characters). Free text can still say "run this"; the owner's check and the leader's rules
// are the defence for that, not this file.
import { isDerivedFeature, oneLine, planReviewSentence } from "./checkpoint.js";
// The one import cycle in the engine: the dispatcher shows plans through `describePlan`, and a plan is checked with the
// dispatcher's own `validateSpec`. Neither module uses the other while it loads, only inside functions.
import { validateSpec } from "./dispatcher.js";
import { slugify } from "./state.js";
import type { PlanReview, SpecFeature, SpecOutput } from "./types.js";
import { sha256 } from "./util/fs.js";

export const PLAN_FIRST_LINE = "mc-plan 1";
export const PLAN_MAX_CHARS = 30_000;
/** The most problems a preview prints; the rest are counted ("... and N more."). */
export const PLAN_PROBLEMS_SHOWN = 12;
/** Lines of a plan shown to a person are cut here (the report and the card cut at 300), so nothing the plan says is lost. */
const WRAP_AT = 280;
/** A look line keeps its lead on every line it wraps into only if at least this much room is left for the words after it. */
const FACT_ROOM_MIN = 80;
const QUOTE_MAX = 40;
const MAX_FEATURES = 10;
const MAX_CHECKS = 20;
const MAX_ASSUMPTIONS = 10;
const MAX_CONTRACT = 40;
const MAX_NEEDS = 9;
const ID_MAX = 60;
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BASE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,99}$/;
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const PLAN_KEYS = "name, request, folder, base, app-name, summary, assumption, contract";
const FEATURE_KEYS = "feature, title, story, kind, needs, check";
const ROUTINE_WORK = "the team tries its lightest AI first and moves up if the checks fail.";

// ───────────────────────────── Keys ─────────────────────────────

/** Which part of the plan a key belongs to; `feature` itself starts a block and may appear anywhere after the head. */
interface KeyRule {
  part: "plan" | "feature";
  once: boolean;
  /** The plain-words limit of the value; absent = checked later by its own message (folder, base, kind, needs). */
  max?: number;
  /** The value may start with any character (the CEO's own words). */
  anyStart?: boolean;
}

// A Map, never a plain object: `constructor` and `toString` must be unknown keys.
const KEYS = new Map<string, KeyRule>([
  ["name", { part: "plan", once: true, max: 60 }],
  ["request", { part: "plan", once: true, max: 1000, anyStart: true }],
  ["folder", { part: "plan", once: true }],
  ["base", { part: "plan", once: true }],
  ["app-name", { part: "plan", once: true, max: 60 }],
  ["summary", { part: "plan", once: true, max: 400 }],
  ["assumption", { part: "plan", once: false, max: 300 }],
  ["contract", { part: "plan", once: false, max: 300 }],
  ["feature", { part: "feature", once: false, max: ID_MAX }],
  ["title", { part: "feature", once: true, max: 80 }],
  ["story", { part: "feature", once: true, max: 400 }],
  ["kind", { part: "feature", once: true }],
  ["needs", { part: "feature", once: true }],
  ["check", { part: "feature", once: false, max: 300 }],
]);

// ───────────────────────────── Plain words ─────────────────────────────

/** Control, format, private-use, unassigned, surrogate and separator characters, odd spaces, variation selectors, blank-looking letters. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]|(?! )\p{Zs}|[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]|[\u115F\u1160\u3164\uFFA0\u2800\u034F\u17B4\u17B5\u180B-\u180D\u180F]/u;
const MARK = /\p{M}/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const STARTS_WITH_WORD = /^[\p{L}\p{N}]/u;

function chars(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** A combining mark that follows nothing it can belong to, or a stack of more than two marks. */
function hasStrayMarks(s: string): boolean {
  let before: "start" | "base" | "mark" | "other" = "start";
  let run = 0;
  for (const ch of s) {
    if (MARK.test(ch)) {
      if (before === "start" || before === "other") return true;
      run++;
      if (run > 2) return true;
      before = "mark";
    } else {
      run = 0;
      before = LETTER_OR_NUMBER.test(ch) ? "base" : "other";
    }
  }
  return false;
}

/** Why `value` is not plain words (the first reason that applies), or undefined when it is. */
function wordsProblem(value: string, max: number, anyStart: boolean): string | undefined {
  if (value === "") return "it is empty";
  if (chars(value) > max) return `it is longer than ${count(max)} characters`;
  if (HIDDEN.test(value) || hasStrayMarks(value)) return "it has a character that cannot be seen";
  if (value.includes("`")) return "it has a backtick";
  if (value.includes("://")) return "it has a web address";
  if (/\\['"]/.test(value)) return "it has a backslash before a quote mark";
  if (!anyStart && !STARTS_WITH_WORD.test(value)) return "it does not start with a letter or a number";
  return undefined;
}

function count(n: number): string {
  return n >= 1000 ? `${Math.floor(n / 1000)},${String(n % 1000).padStart(3, "0")}` : String(n);
}

/** Plan text inside a message: cut at 40 characters, and what cannot be seen shown as its code point. */
function quote(text: string): string {
  const all = Array.from(text);
  const cut = all.slice(0, QUOTE_MAX).join("");
  const shownText = Array.from(cut)
    .map((ch) => (HIDDEN.test(ch) ? `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}>` : ch))
    .join("");
  return all.length > QUOTE_MAX ? `${shownText}…` : shownText;
}

/** The value of a line without the spaces and tabs at either end. */
function trimBlanks(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s[start] === " " || s[start] === "\t")) start++;
  while (end > start && (s[end - 1] === " " || s[end - 1] === "\t")) end--;
  return s.slice(start, end);
}

// ───────────────────────────── The reader ─────────────────────────────

export interface PlanEnvelope {
  name: string;
  request: string;
  /** A folder name inside ~/mc-apps; absent = a new app. */
  folder?: string;
  /** The branch to start from; only with `folder`. */
  base?: string;
}

export type PlanParse =
  | {
      ok: true;
      envelope: PlanEnvelope;
      spec: SpecOutput;
      /** The first 8 hexadecimal characters of `sha256`. */
      code: string;
      /** SHA-256 of the plan in its fixed written form (`canonicalText`). */
      sha256: string;
    }
  | { ok: false; problems: string[] };

interface Entry {
  n: number;
  value: string;
}

interface Block {
  n: number;
  id: string;
  once: Map<string, Entry>;
  checks: Entry[];
}

/** Reads a plan. Pure: nothing is read from disk and nothing is queued. Lists every problem it finds (the preview prints 12). */
export function parsePlan(input: string, opts: { quoteFirstLine?: boolean } = {}): PlanParse {
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  // A text of more than twice as many code units has more than 30,000 characters whatever they are (no need to count a huge one).
  if (text.length > 2 * PLAN_MAX_CHARS || chars(text) > PLAN_MAX_CHARS) return bad(["The plan is too long (more than 30,000 characters). Shorten it, or split the work into two plans."]);
  const lines = text.split(/\r?\n/);

  // The whole text first: a pasted block of code or the wrong format would only make noise below.
  const opening: string[] = [];
  const bracket = lines.findIndex((l) => /[{}]/.test(l));
  if (bracket >= 0) {
    opening.push(`The plan has a curly bracket on line ${bracket + 1}. Plans are plain lines of “key: value” text and never use curly brackets. Write the words without them.`);
  }
  const first = trimBlanks(lines[0] ?? "");
  if (first !== PLAN_FIRST_LINE) {
    // A plan read from a file never shows what the file starts with: the leader may point this at any file in the apps folder.
    const seen = text.trim() === "" ? " (the plan is empty)" : opts.quoteFirstLine === false ? "" : ` (it is “${quote(first)}”)`;
    opening.push(`The first line of the plan must be exactly: ${PLAN_FIRST_LINE}${seen}.`);
  }
  if (opening.length > 0) return bad(opening);

  const problems: string[] = [];
  const head = { once: new Map<string, Entry>(), assumptions: [] as Entry[], contract: [] as Entry[] };
  const blocks: Block[] = [];
  let block: Block | undefined;

  for (let i = 1; i < lines.length; i++) {
    const n = i + 1;
    const line = trimBlanks(lines[i] ?? "");
    if (line === "") continue;
    const colon = line.indexOf(":");
    const key = colon > 0 ? line.slice(0, colon) : "";
    if (!KEY_SHAPE.test(key)) {
      problems.push(`Line ${n} is not a “key: value” line. Every line starts with a key, a colon and the text. Keep each text on one line; do not carry a long text over to the next line.`);
      continue;
    }
    const value = trimBlanks(line.slice(colon + 1));
    const rule = KEYS.get(key);
    if (!rule) {
      problems.push(`Line ${n}: “${quote(key)}” is not a key that can be used. For the whole plan: ${PLAN_KEYS}. For each feature: ${FEATURE_KEYS}.`);
      continue;
    }
    if (rule.part === "plan" && block) {
      problems.push(`Line ${n}: “${key}” is about the whole plan, so it goes before the first “feature” line.`);
      continue;
    }
    if (rule.part === "feature" && key !== "feature" && !block) {
      problems.push(`Line ${n}: “${key}” belongs to a feature, so it goes after a “feature” line.`);
      continue;
    }

    if (key === "feature") {
      block = { n, id: value, once: new Map(), checks: [] };
      blocks.push(block);
      const where = `Line ${n} (the id of feature ${blocks.length})`;
      const why = wordsProblem(value, ID_MAX, false);
      if (why) problems.push(`${where} can't be used: ${why}. Use a feature id: lowercase letters, digits and single dashes, up to ${ID_MAX} characters, for example dark-mode.`);
      else if (isDerivedFeature(value)) problems.push(`Line ${n}: the feature id “${quote(value)}” is kept for the team's own repair work. Choose another id.`);
      continue;
    }

    const k = blocks.length;
    const kept = block ? block.once : head.once;
    if (rule.once && kept.has(key)) {
      problems.push(`Line ${n}: “${key}” is given a second time${block ? ` in feature ${k} (“${quote(block.id)}”)` : ""}. It can be given only once.`);
      continue;
    }
    const entry: Entry = { n, value };
    const of = block ? `feature ${k}, “${quote(block.id)}”` : ""; // "check 3 of feature 1, “dark-mode”"
    let where = `Line ${n} (“${key}”)`;
    if (rule.once) kept.set(key, entry);
    else if (key === "assumption") where = `Line ${n} (assumption ${head.assumptions.push(entry)})`;
    else if (key === "contract") where = `Line ${n} (contract line ${head.contract.push(entry)})`;
    else if (block) where = `Line ${n} (check ${block.checks.push(entry)} of ${of})`;
    if (block && (key === "title" || key === "story")) where = `Line ${n} (the ${key} of ${of})`;

    if (key === "needs") {
      for (const dep of value.split(",").map(trimBlanks).filter((d) => d !== "")) {
        const why = wordsProblem(dep, ID_MAX, false);
        if (why) {
          problems.push(
            `Line ${n} (an id in “needs” of ${of}) can't be used: ${why}. Use a feature id: lowercase letters, digits and single dashes, up to ${ID_MAX} characters, for example dark-mode.`,
          );
        }
      }
    } else if (rule.max !== undefined) {
      const why = wordsProblem(value, rule.max, rule.anyStart === true);
      if (why) {
        const use = rule.anyStart
          ? `Use plain words, up to ${count(rule.max)} characters, with no backticks and no web addresses.`
          : `Use plain words, up to ${count(rule.max)} characters, starting with a letter or a number, with no backticks and no web addresses.`;
        problems.push(`${where} can't be used: ${why}. ${use}`);
      }
    }
  }

  // The plan as a whole.
  for (const key of ["name", "request", "app-name", "summary"]) {
    if (!head.once.has(key)) problems.push(`“${key}” is missing. Add a line that starts with “${key}:”.`);
  }
  blocks.forEach((b, i) => {
    for (const key of ["title", "story"]) {
      if (!b.once.has(key)) problems.push(`Feature ${i + 1} (“${quote(b.id)}”) has no “${key}” line. Add a line that starts with “${key}:”.`);
    }
  });
  if (blocks.length === 0) {
    problems.push("The plan has no feature. Start each feature with a “feature:” line, followed by its “title:”, “story:” and “check:” lines.");
  } else if (blocks.length > MAX_FEATURES) {
    problems.push(`The plan needs between 1 and ${MAX_FEATURES} features (it has ${blocks.length}). For more, let the team's planner write the plan: queue it with mc new or mc feature.`);
  }
  blocks.forEach((b, i) => {
    if (b.checks.length < 1 || b.checks.length > MAX_CHECKS) {
      problems.push(`Feature ${i + 1} (“${quote(b.id)}”) needs 1 to ${MAX_CHECKS} “check” lines (it has ${b.checks.length}).`);
    }
  });
  for (const b of blocks) {
    const kind = b.once.get("kind");
    if (kind && kind.value !== "standard" && kind.value !== "mechanical") problems.push(`Line ${kind.n}: “kind” must be standard or mechanical.`);
  }
  for (const b of blocks) {
    const needs = b.once.get("needs");
    if (!needs) continue;
    const deps = needs.value.split(",").map(trimBlanks);
    if (deps.some((d) => d === "") || deps.length > MAX_NEEDS) {
      problems.push(`Line ${needs.n}: “needs” must list feature ids separated by commas, at most ${MAX_NEEDS}, for example: needs: add-book, mark-read.`);
    }
  }
  if (head.assumptions.length > MAX_ASSUMPTIONS) problems.push(`The plan has ${head.assumptions.length} “assumption” lines; at most ${MAX_ASSUMPTIONS} are allowed.`);
  if (head.contract.length > MAX_CONTRACT) problems.push(`The plan has ${head.contract.length} “contract” lines; at most ${MAX_CONTRACT} are allowed.`);
  const folder = head.once.get("folder");
  const base = head.once.get("base");
  if (folder && !FOLDER.test(folder.value)) {
    problems.push(`Line ${folder.n}: “folder” must be just the name of a folder inside ~/mc-apps, for example habit-tracker (no slashes). Leave the line out for a new app.`);
  }
  if (base && !BASE.test(base.value)) {
    problems.push(
      `Line ${base.n}: “base” is not a branch name. Use letters, digits, dots, dashes, underscores and slashes, up to 100 characters, starting with a letter, a digit or an underscore.`,
    );
  }
  if (base && !folder) problems.push(`Line ${base.n}: “base” only goes with “folder”: a new app has no branch to start from.`);
  if (problems.length > 0) return bad(problems);

  const envelope: PlanEnvelope = {
    name: head.once.get("name")?.value ?? "",
    request: head.once.get("request")?.value ?? "",
    ...(folder && { folder: folder.value }),
    ...(base && { base: base.value }),
  };
  const spec: SpecOutput = {
    appName: head.once.get("app-name")?.value ?? "",
    summary: head.once.get("summary")?.value ?? "",
    features: blocks.map(
      (b): SpecFeature => ({
        id: b.id,
        title: b.once.get("title")?.value ?? "",
        story: b.once.get("story")?.value ?? "",
        acceptance: b.checks.map((c) => c.value),
        kind: b.once.get("kind")?.value === "mechanical" ? "mechanical" : "standard",
        deps: (b.once.get("needs")?.value ?? "").split(",").map(trimBlanks).filter((d) => d !== ""),
      }),
    ),
    assumptions: head.assumptions.map((a) => a.value),
    uiContract: head.contract.map((c) => `- ${c.value}`).join("\n"),
  };
  // Only now, when nothing else is wrong: the planner's own checks (kebab-case ids, duplicates, unknown needs, cycles).
  const spoken = validateSpec(spec);
  if (spoken.length > 0) return bad(spoken);
  const hash = sha256(canonicalText(envelope, spec));
  return { ok: true, envelope, spec, code: hash.slice(0, 8), sha256: hash };
}

function bad(problems: string[]): PlanParse {
  return { ok: false, problems };
}

// ───────────────────────────── The fixed form and the plan code ─────────────────────────────

/** The contract lines of a plan's `uiContract` (each was written after "- "). */
function contractLines(uiContract: string): string[] {
  return uiContract === "" ? [] : uiContract.split("\n").map((l) => l.replace(/^- /, ""));
}

/**
 * The plan written back in one fixed form: one `key: value` per line, a line feed after each (the last too), no blank
 * lines. Spaces, blank lines, line ends and the order of lines inside a block do not change it; every changed character does.
 */
export function canonicalText(envelope: PlanEnvelope, spec: SpecOutput): string {
  const lines = [
    PLAN_FIRST_LINE,
    `name: ${envelope.name}`,
    `request: ${envelope.request}`,
    ...(envelope.folder !== undefined ? [`folder: ${envelope.folder}`] : []),
    ...(envelope.base !== undefined ? [`base: ${envelope.base}`] : []),
    `app-name: ${spec.appName}`,
    `summary: ${spec.summary}`,
    ...spec.assumptions.map((a) => `assumption: ${a}`),
    ...contractLines(spec.uiContract).map((c) => `contract: ${c}`),
  ];
  for (const f of spec.features) {
    lines.push(`feature: ${f.id}`, `title: ${f.title}`, `story: ${f.story}`);
    if (f.kind === "mechanical") lines.push("kind: mechanical");
    if (f.deps.length > 0) lines.push(`needs: ${f.deps.join(", ")}`);
    for (const c of f.acceptance) lines.push(`check: ${c}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The first 8 hexadecimal characters of the SHA-256 of the fixed form: the same plan always has the same code. */
export function planCode(envelope: PlanEnvelope, spec: SpecOutput): string {
  return sha256(canonicalText(envelope, spec)).slice(0, 8);
}

// ───────────────────────────── The plan in words ─────────────────────────────

/** What `describePlan` needs besides the plan: the CEO's words, and who reads the lines. */
export interface DescribeOptions {
  /** `Mission.request`. */
  request: string;
  /** "text": for the command line, with indented lists. "look": one self-contained line per fact, for the owner's check. */
  style: "text" | "look";
  /** A new app whose folder is not made yet: the app name line says where it will go. */
  newApp?: boolean;
}

/** The parts of a plan that `describePlan` reads; `Spec` (the planner's, after adoption) has the same shape. */
type Describable = Pick<SpecOutput, "appName" | "summary" | "features" | "assumptions" | "uiContract">;

/**
 * The plan in plain words, every fact of it: the request, app name, summary, each feature with its story, every check,
 * what it needs first and whether it is routine work, then the choices made and the names the tests and the code must
 * agree on. It also takes the planner's own plans (after a revision), which the limits of a leader's plan do not cover:
 * any number of features, backticks and curly brackets, a contract of many lines in one string, long lines. Each text is
 * made one line as `shown` does, but never cut; a line over 280 characters is wrapped, so nothing is lost on its way to
 * the report or the card. Each feature shows its id next to its title (it reaches the AIs and the branch names). In the
 * owner's look, which is read one line at a time, a wrapped fact starts every line with its lead again (`wrapFact`).
 */
export function describePlan(spec: Describable, opts: DescribeOptions): string[] {
  const text = (x: unknown): string => (typeof x === "string" ? oneLine(x) : "");
  const texts = (x: unknown): string[] => (Array.isArray(x) ? x.map(text).filter((s) => s !== "") : []);
  const features = (Array.isArray(spec.features) ? spec.features : []).map((f) => ({
    id: text(f.id),
    title: text(f.title),
    story: text(f.story),
    checks: texts(f.acceptance),
    deps: texts(f.deps),
    routine: f.kind === "mechanical",
  }));
  const titleOf = (id: string): string => features.find((f) => f.id === id)?.title || id;
  const needs = (deps: string[]): string => deps.map((d) => `“${titleOf(d)}”`).join(", ");
  const choices = texts(spec.assumptions);
  // The planner writes the contract as one string of lines, often with list markers; a leader's plan has "- " lines.
  const names = (typeof spec.uiContract === "string" ? spec.uiContract : "")
    .split(/\r?\n/)
    .map((l) => text(l).replace(/^[-*•]\s+/, ""))
    .filter((l) => l !== "");
  const where = opts.newApp === true ? ` (the new app goes in a new folder called ${slugify(text(spec.appName))}, or the next free name)` : "";
  const total = features.length === 1 ? "1 feature" : `${features.length} features`;
  const out: string[] = [];
  const add = (line: string, indent = ""): void => {
    for (const part of wrapLine(line, WRAP_AT - indent.length)) out.push(indent + part);
  };
  const bullets = (items: string[], indent = ""): void => {
    for (const item of items) wrapLine(item, WRAP_AT - indent.length - 2).forEach((part, i) => out.push(`${indent}${i === 0 ? "- " : "  "}${part}`));
  };
  // The owner's look shows one line at a time, so every line a long fact wraps into starts with the same lead.
  const fact = (lead: string, body: string): void => {
    for (const line of wrapFact(lead, body)) out.push(line);
  };
  const head = (lead: string, body: string): void => (opts.style === "look" ? fact(lead, body) : add(`${lead} ${body}`));

  head("You asked:", text(opts.request));
  head("App name:", `${text(spec.appName)}${where}`);
  head("Summary:", text(spec.summary));
  if (opts.style === "look") {
    // One fact to a line, each saying what it is about: the report and the card show these lines one by one.
    fact(`The plan has ${total}:`, `${features.map((f) => `“${f.title}”`).join(", ")}.`);
    for (const f of features) {
      fact(`“${f.title}”${f.id === "" ? "" : ` (id: ${f.id})`}:`, f.story);
      for (const check of f.checks) fact(`Check for “${f.title}”:`, check);
      if (f.deps.length > 0) fact(`Needs first for “${f.title}”:`, `${needs(f.deps)}.`);
      if (f.routine) fact(`Marked as routine work for “${f.title}”:`, ROUTINE_WORK);
    }
    for (const c of choices) fact("Choice made for you:", c);
    for (const n of names) fact("Name the tests and the code must agree on:", n);
    return out;
  }
  out.push("", `${total}:`, "");
  features.forEach((f, i) => {
    add(`${i + 1}. “${f.title}”${f.id === "" ? "" : ` (id: ${f.id})`}`);
    add(f.story, "   ");
    out.push("   It counts as done when:");
    bullets(f.checks, "   ");
    if (f.deps.length > 0) add(`Needs first: ${needs(f.deps)}.`, "   ");
    if (f.routine) add(`Marked as routine work: ${ROUTINE_WORK}`, "   ");
  });
  if (choices.length > 0) {
    out.push("", "Choices made for you:");
    bullets(choices);
  }
  if (names.length > 0) {
    out.push("", "Names the tests and the code must agree on:");
    bullets(names);
  }
  return out;
}

/**
 * A fact for the owner's look: `lead`, a space and `body`, in lines of at most `max` characters. When it takes more than
 * one line, every line starts with `lead` again, so a line shown on its own still says what it is about. A lead so long
 * that too little room is left for the words (a very long title in a plan the planner wrote) is not repeated: the whole
 * text is wrapped as one, so nothing is lost and no line is too long.
 */
export function wrapFact(lead: string, body: string, max = WRAP_AT): string[] {
  const room = max - lead.length - 1;
  if (room < FACT_ROOM_MIN) return wrapLine(`${lead} ${body}`, max);
  return wrapLine(body, room).map((part) => `${lead} ${part}`);
}

/** The plan reviewer's answer and the owner's send-backs, as lines: what changed the plan, and who changed it. */
export function reviewLines(review: PlanReview | undefined, sendBacks: number): string[] {
  const lines = review ? wrapLine(planReviewSentence(review)) : [];
  if (sendBacks > 0) {
    const times = sendBacks === 1 ? "once" : sendBacks === 2 ? "twice" : `${sendBacks} times`;
    lines.push(`You sent the plan back ${times}. This is the plan as it stands now.`);
  }
  return lines;
}

/** `text` as lines of at most `max` characters, broken at spaces (a longer word is split). Always at least one line. */
export function wrapLine(text: string, max = WRAP_AT): string[] {
  if (text.length <= max) return [text];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    let rest = word;
    while (rest.length > max) {
      // A word longer than a line is split, keeping a character made of two code units whole.
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      const end = rest.charCodeAt(max - 1) >= 0xd800 && rest.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
      lines.push(rest.slice(0, end));
      rest = rest.slice(end);
    }
    if (current === "") current = rest;
    else if (current.length + 1 + rest.length <= max) current += ` ${rest}`;
    else {
      lines.push(current);
      current = rest;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}
