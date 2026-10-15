// How a feature was checked, in words (docs/modes-spec.md sections 10.1 and 10.2, decision M26). The one table of the
// engine's words, written once and used by report.ts, cli.ts, checkpoint.ts and, through an import, by `buildLook` in
// dispatcher.ts. The dashboard keeps its own copy in shorter words (spec 11.4) on purpose.
//
// This file imports types only and no other module of the engine, so checkpoint.ts, report.ts and cli.ts can all
// import it without a cycle. Because of that it holds the one definition of "a feature the engine added itself"
// (`isDerivedFeature`); checkpoint.ts re-exports it under the same name.
//
// Rules for the words (spec 10.3): never "tested", "passed its tests" or "you looked at it" for a mode feature; say
// "approved by you" for an approval in the checkpoint log, "it was queued without a stop for your look" for
// `ownerStops: false`, "a second AI" and never "a different AI", "Mission Control's own checks" for the scripts.
import type { Feature, Mission, PictureWhy, SpecFeature } from "./types.js";

/** The parts of a mission these functions read. A whole `Mission` fits. */
export type CheckedMission = Pick<Mission, "features" | "ownerStops" | "checkpoints" | "checkpointLog">;

// ───────────────────────────── Mode features ─────────────────────────────

/** A mode feature is one that is not checked by tests: `f.mode !== undefined` (spec 16, "The interface between them", item 2). */
export function isModeFeature(f: Pick<SpecFeature, "mode">): boolean {
  return f.mode !== undefined;
}

/** Whether any feature has a mode. Every change of wording or behaviour in this step is guarded by this. */
export function hasModeFeature(features: readonly Pick<SpecFeature, "mode">[]): boolean {
  return features.some(isModeFeature);
}

/** Features the engine adds by itself (gate C's repair, the change after a send-back at the final stop): the owner is not asked about them. */
const DERIVED_FEATURE = /^(?:gate-c-fix|owner-change)-/;

export function isDerivedFeature(id: string): boolean {
  return DERIVED_FEATURE.test(id);
}

// ───────────────────────────── What the log and the record say ─────────────────────────────

function scopeOfFeature(f: Pick<Feature, "id">): string {
  return `feature:${f.id}`;
}

function logHas(m: Pick<CheckedMission, "checkpointLog">, f: Pick<Feature, "id">, decision: "approve" | "send_back"): number {
  const scope = scopeOfFeature(f);
  return (Array.isArray(m.checkpointLog) ? m.checkpointLog : []).filter((r) => r?.scope === scope && r.decision === decision).length;
}

/** How the second AI's answer came out, counted from the stored results. Nothing is trusted that is not there: a check with no result is a check nobody judged. */
function resultCounts(f: Feature): { total: number; passed: number; failed: number; unjudged: number; unfinished: boolean } {
  const total = Array.isArray(f.acceptance) ? f.acceptance.length : 0;
  const checked = f.checked;
  if (checked === undefined || checked.unfinished === true) return { total, passed: 0, failed: 0, unjudged: total, unfinished: true };
  const results = Array.isArray(checked.results) ? checked.results : [];
  const passed = results.filter((r) => r?.result === "pass").length;
  const failed = results.filter((r) => r?.result === "fail").length;
  return { total, passed, failed, unjudged: Math.max(0, total - passed - failed), unfinished: false };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ───────────────────────────── The table of spec 10.1 ─────────────────────────────

/** The row of the table in spec 10.1 that fits a done feature first (1 to 7). */
export type CheckedRow = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * The facts that decide the words for one feature. Counts are 0 for a feature checked by tests (rows 1 to 3).
 * Rows: 1 tests and approved; 2 tests, and no test was written; 3 tests; 4 a mode feature with no `checked` or an
 * unfinished one; 5 checks left unmet; 6 checks not judged; 7 every check judged and met.
 */
export interface HowChecked {
  row: CheckedRow;
  /** The checkpoint log holds an "approve" for the scope `feature:<id>`. This is all "approved by you" means. */
  approved: boolean;
  /** How many times the owner sent the feature back (the log's "send_back" entries for that scope). */
  sentBack: number;
  /** Rows 4 to 7, not approved: `ownerStops` is false and the feature is "owner" or has checks not judged (or its review did not finish). */
  queuedWithoutLook: boolean;
  /** The number of written checks (`acceptance.length`), and how they came out at the last answer. */
  total: number;
  passed: number;
  /** Checks left unmet after the rounds. */
  failed: number;
  /** Checks nobody judged. */
  unjudged: number;
  /** A mode feature with no `checked`, or with `checked.unfinished`: the second AI's check did not finish. */
  unfinished: boolean;
}

/**
 * Reads the row and the facts from the mission file. `f` is a done feature of `m`.
 *
 * One choice beyond the table: a `tests` feature whose test author wrote no test reads as row 2 even when the owner
 * approved it (the table would give row 1 and say "checked by tests" for a feature no test checked). The approval then
 * shows as the ending of row 2.
 */
export function howChecked(m: CheckedMission, f: Feature): HowChecked {
  const approved = logHas(m, f, "approve") > 0;
  const sentBack = logHas(m, f, "send_back");
  if (f.mode === undefined) {
    const noTests = !Array.isArray(f.frozenTests) || f.frozenTests.length === 0;
    const row: CheckedRow = noTests ? 2 : approved ? 1 : 3;
    return { row, approved, sentBack, queuedWithoutLook: false, total: 0, passed: 0, failed: 0, unjudged: 0, unfinished: false };
  }
  const c = resultCounts(f);
  const row: CheckedRow = c.unfinished ? 4 : c.failed > 0 ? 5 : c.unjudged > 0 ? 6 : 7;
  const queuedWithoutLook = !approved && m.ownerStops === false && (f.mode === "owner" || c.unjudged > 0 || c.unfinished);
  return { row, approved, sentBack, queuedWithoutLook, ...c };
}

const QUEUED_WITHOUT_LOOK = "it was queued without a stop for your look";

/**
 * The words the `Checked:` line uses for one feature (spec 10.1, middle column, with the endings), always starting with
 * "by": for example `by tests`, `by a second AI against your list and approved by you`,
 * `by a second AI against your list (2 checks not met)`, `by a second AI against your list (it was queued without a stop for your look)`.
 */
export function checkedWords(h: HowChecked): string {
  const ending = h.approved ? " and approved by you" : h.queuedWithoutLook ? ` (${QUEUED_WITHOUT_LOOK})` : "";
  switch (h.row) {
    case 1:
      return "by tests, and approved by you";
    case 2:
      return `by the project's own checks only (no tests were written for it)${h.approved ? ", and approved by you" : ""}`;
    case 3:
      return "by tests";
    case 4:
      return `by Mission Control's own checks only (the second AI's check did not finish)${ending}`;
    case 5:
      return `by a second AI against your list (${plural(h.failed, "check", "checks")} not met)${ending}`;
    case 6:
      return `by a second AI against your list, except ${plural(h.unjudged, "check", "checks")} it could not judge${ending}`;
    case 7:
      return `by a second AI against your list${ending}`;
  }
}

/**
 * The text for the Features table (spec 10.1, right-hand column, with the endings): `Built and checked` (row 3, as today),
 * `Built; a second AI checked it against your list (3 of 3 passed); approved by you`, and so on.
 */
export function tableWords(h: HowChecked): string {
  const ending = h.approved ? "; approved by you" : h.queuedWithoutLook ? `; ${QUEUED_WITHOUT_LOOK}` : "";
  switch (h.row) {
    case 1:
      return "Built and checked by tests; approved by you";
    case 2:
      return `Built; checked by the project's own checks only, because no tests were written for it${h.approved ? "; approved by you" : ""}`;
    case 3:
      return "Built and checked";
    case 4:
      return `Built; the second AI's check did not finish, so only Mission Control's own checks ran${ending}`;
    case 5: {
      const left = h.unjudged > 0 ? `, and ${h.unjudged} ${h.unjudged === 1 ? "was" : "were"} not judged by anyone` : "";
      return `Built, but ${h.failed} of ${plural(h.total, "check was", "checks were")} not met (see the review notes)${left}${ending}`;
    }
    case 6:
      return `Built; ${plural(h.unjudged, "check was", "checks were")} not judged by anyone${ending}`;
    case 7:
      return `Built; a second AI checked it against your list (${h.passed} of ${h.total} passed)${ending}`;
  }
}

/** The place of a row among the groups of the `Checked:` line: row 1 sits with its base, row 3 ("by tests"). */
function groupRank(h: HowChecked): number {
  return h.row === 1 ? 3 : h.row;
}

/**
 * The `Checked:` line for the report header: `Checked: 2 features by tests; 1 feature by a second AI against your list; ...`,
 * ending with a full stop. It counts the DONE features by `checkedWords`, groups equal words, lists the groups in the order
 * of the rows (an approved group straight after its own base group). Returns undefined when no done feature has a mode,
 * so a mission with no mode gets no new line.
 */
export function checkedLine(m: CheckedMission): string | undefined {
  const done = (Array.isArray(m.features) ? m.features : []).filter((f) => f.status === "done");
  if (!done.some(isModeFeature)) return undefined;
  const groups = new Map<string, { rank: number; approved: boolean; queued: boolean; count: number }>();
  for (const f of done) {
    const h = howChecked(m, f);
    const words = checkedWords(h);
    const group = groups.get(words);
    if (group) group.count++;
    else groups.set(words, { rank: groupRank(h), approved: h.approved, queued: h.queuedWithoutLook, count: 1 });
  }
  const parts = [...groups.entries()]
    .sort(([wa, a], [wb, b]) => a.rank - b.rank || Number(a.approved) - Number(b.approved) || Number(a.queued) - Number(b.queued) || (wa < wb ? -1 : wa > wb ? 1 : 0))
    .map(([words, g]) => `${plural(g.count, "feature", "features")} ${words}`);
  return `Checked: ${parts.join("; ")}.`;
}

/**
 * The sentences `mc plan show` adds after a feature's checks (spec 9.4), in the order they are printed, empty when
 * there is nothing to add: `You were asked to look at it, and you approved it.` or `You sent it back <n> time(s), and then
 * approved it.`; `The second AI's check did not finish.`; `It was queued without a stop for your look.`
 */
export function ownerSentences(h: HowChecked): string[] {
  const out: string[] = [];
  if (h.approved) {
    const times = h.sentBack === 1 ? "once" : h.sentBack === 2 ? "twice" : `${h.sentBack} times`;
    out.push(h.sentBack > 0 ? `You sent it back ${times}, and then approved it.` : "You were asked to look at it, and you approved it.");
  }
  if (h.row >= 4 && h.unfinished) out.push("The second AI's check did not finish.");
  if (h.queuedWithoutLook) out.push("It was queued without a stop for your look.");
  return out;
}

// ───────────────────────────── Why no picture was taken (spec 7.3) ─────────────────────────────

/** The reason a feature has no picture, in words that follow "no pictures were taken" and "Pictures: none". */
export function pictureReason(why: PictureWhy | undefined): string {
  switch (why) {
    case "no_tool":
      return "the picture tool is not available";
    case "no_browser":
      return "no browser was found in the container";
    case "start_failed":
      return "the browser could not start";
    case "too_slow":
      return "the page took too long to load";
    case "reviewer":
      return "the second AI could not look at the pictures, because it runs on a different tool";
    case "not_plain_file":
      return "a page is not a plain file inside the project";
    default:
      return "this feature has no page";
  }
}

// ───────────────────────────── Why the owner is asked (spec 5.2 step 8, and 10.2 line 8) ─────────────────────────────

/** Why the team stops at a feature when the stop is not one `--checkpoint feature` asked for. */
export type LookReason = "owner" | "not_judged" | "unfinished" | "sent_back";

/** Rule (b) of `asksForLook`, and the reason it gives. */
function ownerReason(m: CheckedMission, f: Feature): "owner" | "not_judged" | "unfinished" | undefined {
  if (m.ownerStops === false || f.mode === undefined || isDerivedFeature(f.id)) return undefined;
  if (f.mode === "owner") return "owner";
  const c = resultCounts(f);
  return c.unfinished ? "unfinished" : c.unjudged > 0 ? "not_judged" : undefined;
}

/**
 * The rule `asked(f)` of spec 5.2, step 8. True when ANY of these holds: (a) `m.checkpoints` lists "feature" and `f` is not
 * a feature the engine added itself (`gate-c-fix-N`, `owner-change-N`); (b) `m.ownerStops` is not false, `f` has a mode
 * and is not a derived feature, and either it is "owner", or it is "review" and a check was not judged or its review did
 * not finish; (c) `f` has a mode and the checkpoint log already holds a send-back for its scope. The flag
 * `--no-owner-checkpoint` removes (b) and nothing else. The dispatcher's `checkpointGate`, `looksAt` and `reviewSettled`
 * and `nextCheckpointState`'s fifth parameter all use this one function.
 *
 * A mode feature that has no `checked` yet counts as "its review did not finish", so call this after the second AI has
 * answered (or has failed to), not before.
 */
export function asksForLook(m: CheckedMission, f: Feature): boolean {
  if (m.checkpoints?.includes("feature") === true && !isDerivedFeature(f.id)) return true;
  return lookReason(m, f) !== undefined;
}

/**
 * The reason to say for a stop by rules (b) or (c) of `asksForLook`; undefined when neither applies (a stop that only
 * `--checkpoint feature` asked for keeps the old words, which `whyStopped` decides by looking at `m.checkpoints`). When
 * several apply: `sent_back` first, then `owner`, then `unfinished`, then `not_judged` (an unfinished review has every
 * check unjudged, so `unfinished` is the more exact word).
 */
export function lookReason(m: CheckedMission, f: Feature): LookReason | undefined {
  if (f.mode !== undefined && logHas(m, f, "send_back") > 0) return "sent_back";
  return ownerReason(m, f);
}

/**
 * The look's line 8 (spec 10.2): `You are asked because the plan marks this feature for your look.`,
 * `You are asked because the second AI could not judge <u> of the checks.`, `You are asked because the second AI's check did not
 * finish.`, `You are asked again because you sent it back.` `unjudged` is used only for "not_judged".
 */
export function askedBecause(reason: LookReason, unjudged: number): string {
  switch (reason) {
    case "owner":
      return "You are asked because the plan marks this feature for your look.";
    case "not_judged":
      return `You are asked because the second AI could not judge ${unjudged} of the checks.`;
    case "unfinished":
      return "You are asked because the second AI's check did not finish.";
    case "sent_back":
      return "You are asked again because you sent it back.";
  }
}

/**
 * The clause `whyStopped` puts after "The team stopped because " (spec 10.2, line 8): `the plan marks “<title>” for your look`,
 * `the second AI could not judge every check of “<title>”`, `the second AI's check of “<title>” did not finish`,
 * `you sent “<title>” back and it is shown again`. `title` must already be cleaned by the caller (`shown()`); the function adds the curly marks.
 */
export function stoppedBecause(reason: LookReason, title: string): string {
  switch (reason) {
    case "owner":
      return `the plan marks “${title}” for your look`;
    case "not_judged":
      return `the second AI could not judge every check of “${title}”`;
    case "unfinished":
      return `the second AI's check of “${title}” did not finish`;
    case "sent_back":
      return `you sent “${title}” back and it is shown again`;
  }
}
