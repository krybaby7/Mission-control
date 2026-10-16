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

/**
 * A mode feature is one that is not checked by tests: its `mode` is `review` or `owner` (spec 16, "The interface between them", item 2).
 * Any other value is not a mode: a mission file that holds one is refused when it is loaded (`MissionStore.load`), so it never gets here,
 * and a value that did would be read as "checked by tests", which keeps the test author and the frozen tests, never as a quiet pass.
 */
export function isModeFeature(f: Pick<SpecFeature, "mode"> | null | undefined): boolean {
  return f?.mode === "review" || f?.mode === "owner";
}

/** Whether any feature has a mode. Every change of wording or behaviour in this step is guarded by this. */
export function hasModeFeature(features: readonly (Pick<SpecFeature, "mode"> | null | undefined)[] | null | undefined): boolean {
  return Array.isArray(features) && features.some((f) => isModeFeature(f));
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
function resultCounts(f: Feature): { total: number; passed: number; failed: number; unjudged: number; unfinished: boolean; noPicture: boolean } {
  const total = Array.isArray(f.acceptance) ? f.acceptance.length : 0;
  const checked = f.checked;
  if (checked === undefined || checked.unfinished === true) return { total, passed: 0, failed: 0, unjudged: total, unfinished: true, noPicture: false };
  const results = Array.isArray(checked.results) ? checked.results : [];
  const passed = results.filter((r) => r?.result === "pass").length;
  const failed = results.filter((r) => r?.result === "fail").length;
  // `pictures.why` is stored only when a page was expected and the second AI was shown no picture of it (it could not be taken, or it could not be given).
  const noPicture = typeof checked.pictures?.why === "string";
  return { total, passed, failed, unjudged: Math.max(0, total - passed - failed), unfinished: false, noPicture };
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
  /**
   * A page was expected and the second AI was shown no picture of it. The engine cannot tell which checks need a picture, so it cannot count
   * them: a second AI that judged a layout check from the text alone would otherwise pass it unseen (docs/modes-spec.md, M11 and 7.3).
   */
  noPicture: boolean;
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
  if (!isModeFeature(f)) {
    const noTests = !Array.isArray(f.frozenTests) || f.frozenTests.length === 0;
    const row: CheckedRow = noTests ? 2 : approved ? 1 : 3;
    return { row, approved, sentBack, queuedWithoutLook: false, total: 0, passed: 0, failed: 0, unjudged: 0, unfinished: false, noPicture: false };
  }
  const c = resultCounts(f);
  const row: CheckedRow = c.unfinished ? 4 : c.failed > 0 ? 5 : c.unjudged > 0 ? 6 : 7;
  const queuedWithoutLook = !approved && m.ownerStops === false && (f.mode === "owner" || c.unjudged > 0 || c.unfinished || c.noPicture);
  return { row, approved, sentBack, queuedWithoutLook, ...c };
}

const QUEUED_WITHOUT_LOOK = "it was queued without a stop for your look";
const NO_PICTURE_SHOWN = "no picture was shown to the second AI";

/** The words for a feature that was not shown to the owner: when the second AI saw no picture of a page, that is said too, since nobody saw one. */
function queuedText(h: HowChecked): string {
  return h.noPicture ? `${QUEUED_WITHOUT_LOOK}; ${NO_PICTURE_SHOWN}` : QUEUED_WITHOUT_LOOK;
}

/**
 * The words the `Checked:` line uses for one feature (spec 10.1, middle column, with the endings), always starting with
 * "by": for example `by tests`, `by a second AI against your list and approved by you`,
 * `by a second AI against your list (2 checks not met)`, `by a second AI against your list (it was queued without a stop for your look)`.
 */
export function checkedWords(h: HowChecked): string {
  const ending = h.approved ? " and approved by you" : h.queuedWithoutLook ? ` (${queuedText(h)})` : "";
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
  const ending = h.approved ? "; approved by you" : h.queuedWithoutLook ? `; ${queuedText(h)}` : "";
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
      return `Built, but ${h.failed} of ${h.total} ${h.total === 1 ? "check" : "checks"} ${h.failed === 1 ? "was" : "were"} not met (see the review notes)${left}${ending}`;
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
  if (h.queuedWithoutLook && h.noPicture) out.push("No picture was shown to the second AI.");
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

/**
 * What is said of the changed images that the second AI was given (a feature that changes a picture file has no page to draw,
 * but its images are copied for the owner and offered to the second AI): `The second AI was shown 1 changed image.`
 */
export function imagesShownWords(n: number): string {
  return `The second AI was shown ${n === 1 ? "1 changed image" : `${n} changed images`}.`;
}

// ───────────────────────────── Why the owner is asked (spec 5.2 step 8, and 10.2 line 8) ─────────────────────────────

/** Why the team stops at a feature when the stop is not one `--checkpoint feature` asked for. */
export type LookReason = "owner" | "not_judged" | "unfinished" | "sent_back" | "repair" | "no_pictures";

/** The repair feature that the final review's findings add (`gate-c-fix-N`). The change a send-back at the final stop adds is not one: the owner asked for it. */
const FINAL_REPAIR = /^gate-c-fix-/;

/**
 * The features whose work the owner approved at their own stop, other than `f`: a feature checked by reading with an "approve" in the
 * checkpoint log, or a repair that the owner approved the same way. A feature checked by tests that the owner approved because they
 * asked to look at every feature is not one of them: this rule is about the words "approved by you" on work that no test checked.
 */
export function approvedWork(m: Pick<CheckedMission, "features" | "checkpointLog">, f: Pick<Feature, "id">): Feature[] {
  return (Array.isArray(m.features) ? m.features : []).filter((x) => x.id !== f.id && (isModeFeature(x) || isDerivedFeature(x.id)) && logHas(m, x, "approve") > 0);
}

/** The approved work that the final repair `f` changed a file of (`Feature.changesApproved`), as features of `m`. Empty for any other feature. */
export function changedApprovedWork(m: Pick<CheckedMission, "features" | "checkpointLog">, f: Pick<Feature, "id" | "changesApproved">): Feature[] {
  const ids = Array.isArray(f.changesApproved) ? f.changesApproved : [];
  return approvedWork(m, f).filter((x) => ids.includes(x.id));
}

/** Rule (b) of `asksForLook`, and the reason it gives. */
function ownerReason(m: CheckedMission, f: Feature): "owner" | "not_judged" | "unfinished" | "no_pictures" | undefined {
  if (m.ownerStops === false || !isModeFeature(f) || isDerivedFeature(f.id)) return undefined;
  if (f.mode === "owner") return "owner";
  const c = resultCounts(f);
  return c.unfinished ? "unfinished" : c.unjudged > 0 ? "not_judged" : c.noPicture ? "no_pictures" : undefined;
}

/**
 * The rule `asked(f)` of spec 5.2, step 8. True when ANY of these holds: (a) `m.checkpoints` lists "feature" and `f` is not
 * a feature the engine added itself (`gate-c-fix-N`, `owner-change-N`); (b) `m.ownerStops` is not false, `f` has a mode
 * and is not a derived feature, and either it is "owner", or it is "review" and a check was not judged, its review did
 * not finish, or the second AI was shown no picture of a page it was expected to look at; (c) `f` has a mode (or is the final review's repair) and the checkpoint log already holds a send-back for its scope; (d) `f` is the repair that the
 * final review added (`gate-c-fix-N`) and it changed a file of work the owner approved (`f.changesApproved`; work that no test checked). The flag
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
 * several apply: `sent_back` first, then `repair`, then `owner`, then `unfinished`, then `not_judged` (an unfinished review has every
 * check unjudged, so `unfinished` is the more exact word), then `no_pictures`.
 */
export function lookReason(m: CheckedMission, f: Feature): LookReason | undefined {
  if ((isModeFeature(f) || FINAL_REPAIR.test(f.id)) && logHas(m, f, "send_back") > 0) return "sent_back";
  // The final review's repair changed a file of work that the owner approved. Nothing ties the new text to the approval, so the owner looks
  // at the repair too. The flag `--no-owner-checkpoint` does not remove this: it removes the stops the plan asks for, and an approval is
  // in the log only because the owner was asked.
  if (FINAL_REPAIR.test(f.id) && changedApprovedWork(m, f).length > 0) return "repair";
  return ownerReason(m, f);
}

/**
 * The reason the owner is told for a stop at feature `f` ("The team stopped because ..."): `lookReason`, except that the old words
 * (`you asked to look at ... first`, which `whyStopped` then uses) stay for a feature the engine did not add itself when `--checkpoint feature`
 * is on, since that stop is the owner's own. A repair or a change the engine added is never covered by that flag, so it always says its own
 * reason, whether that is the work it changed or a send-back. The dashboard's `lookWhy` (src/dashboard/modes.ts) is the same rule in the
 * dashboard's own copy of the table; test/modes-look-agree.test.ts checks the two against each other on every combination.
 */
export function shownLookReason(m: CheckedMission, f: Feature): LookReason | undefined {
  const reason = lookReason(m, f);
  if (reason === undefined) return undefined;
  return isDerivedFeature(f.id) || m.checkpoints?.includes("feature") !== true ? reason : undefined;
}

/**
 * The look's line 8 (spec 10.2): `You are asked because the plan marks this feature for your look.`,
 * `You are asked because the second AI could not judge <u> of the checks.`, `You are asked because the second AI's check did not
 * finish.`, `You are asked again because you sent it back.` `unjudged` is used only for "not_judged".
 */
export function askedBecause(reason: LookReason, unjudged: number, approvedTitles: readonly string[] = []): string {
  switch (reason) {
    case "repair":
      return `You are asked because this repair changes work you approved earlier${approvedTitles.length > 0 ? `: ${approvedTitles.map((t) => `“${t}”`).join(", ")}` : ""}.`;
    case "no_pictures":
      return "You are asked because the second AI was shown no picture of the page.";
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
 * `you sent “<title>” back and it is shown again`, `the repair “<title>” changes work you approved earlier`. `title` must already be cleaned by the caller (`shown()`); the function adds the curly marks.
 */
export function stoppedBecause(reason: LookReason, title: string): string {
  switch (reason) {
    case "repair":
      return `the repair “${title}” changes work you approved earlier`;
    case "no_pictures":
      return `the second AI was shown no picture of “${title}”`;
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
