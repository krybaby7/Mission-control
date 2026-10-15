// Which features are checked by reading, and how each finished one was checked (docs/modes-spec.md, 10.1 and 11). Pure logic over
// the cleaned mission file, and no prose: the words are in vocabulary-details.ts. The engine has its own copy of the same table
// (src/checked-by.ts) in longer words; the two are separate on purpose (spec 16, "The interface between them", item 5).
//
// A mode feature is one with `mode` set ("review" or "owner"). A mission with none of them is shown exactly as before: every
// caller guards on `hasModeFeature` first.
import type { Feature, Mission } from "../types.js";
import { cleanId } from "./sanitize.js";

/** The parts of a mission these functions read. A whole cleaned `Mission` fits. */
export type ModeMission = Pick<Mission, "features" | "ownerStops" | "checkpoints" | "checkpointLog">;

export function isModeFeature(f: Pick<Feature, "mode">): boolean {
  return f.mode !== undefined;
}

/** Whether any feature of the mission is checked by reading. Every change of wording in the dashboard is guarded by this. */
export function hasModeFeature(m: Pick<Mission, "features">): boolean {
  return m.features.some(isModeFeature);
}

/**
 * Whether no feature that was finished is checked by tests, in a mission that has a mode feature (spec 11.5: "when no done
 * feature is checked by tests"). Then no sentence of the mission may talk about tests. A mixed mission keeps the old words.
 */
export function noTestsDone(m: Pick<Mission, "features">): boolean {
  return hasModeFeature(m) && m.features.every((f) => f.status !== "done" || isModeFeature(f));
}

/** Features the engine added by itself (`gate-c-fix-N` after the final check, `owner-change-N` after a send-back at the final stop). They never stop for the owner. */
const DERIVED = /^(?:gate-c-fix|owner-change)-/;
/** The repair the final review adds. The change a send-back at the final stop adds is not one: the owner asked for it. */
const FINAL_REPAIR = /^gate-c-fix-/;

// ───────────────────────────── The checkpoint log ─────────────────────────────

/** The checkpoint log holds an "approve" for the feature. This is all "approved by you" ever means (spec M26). */
export function isApproved(m: Pick<Mission, "checkpointLog">, f: Pick<Feature, "id">): boolean {
  const scope = cleanId(`feature:${f.id}`);
  return (m.checkpointLog ?? []).some((r) => r.scope === scope && r.decision === "approve");
}

/** How many times the owner sent the feature back. */
export function timesSentBack(m: Pick<Mission, "checkpointLog">, f: Pick<Feature, "id">): number {
  const scope = cleanId(`feature:${f.id}`);
  return (m.checkpointLog ?? []).filter((r) => r.scope === scope && r.decision === "send_back").length;
}

// ───────────────────────────── How a done feature was checked (spec 10.1, 11.4) ─────────────────────────────

/** The row of the table in spec 10.1 that fits first. */
export type CheckedRow = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface CheckedFacts {
  /** 1 tests, approved. 2 tests, and no test was written. 3 tests. 4 the second AI's check did not finish. 5 checks left unmet. 6 checks not judged. 7 every check judged and met. */
  row: CheckedRow;
  /** Checks left unmet (row 5) and checks nobody judged (rows 4 to 6); 0 for rows 1 to 3. */
  unmet: number;
  unjudged: number;
  approved: boolean;
  /** Rows 4 to 7, not approved, `ownerStops` is false and the feature is an "owner" one or has checks not judged (or its review did not finish, or no picture was shown). */
  queuedWithoutLook: boolean;
  /** A page was expected and the second AI was shown no picture of it (rows 5 to 7). Absent when it is not so. */
  noPicture?: boolean;
}

/**
 * The row and the facts for one feature of `m`. Nothing is trusted that is not there: a mode feature with no record of the second AI's
 * answer, or with an unfinished one, is row 4. One choice beyond the table: a `tests` feature whose test author wrote no test is row 2
 * even when the owner approved it (row 1 would say "checked by tests" for a feature that no test checked), and the approval then shows
 * as the ending of row 2.
 */
export function checkedFacts(m: ModeMission, f: Feature): CheckedFacts {
  const approved = isApproved(m, f);
  if (!isModeFeature(f)) {
    const noTests = f.frozenTests.length === 0;
    return { row: noTests ? 2 : approved ? 1 : 3, unmet: 0, unjudged: 0, approved, queuedWithoutLook: false };
  }
  const checked = f.checked;
  const unfinished = checked === undefined || checked.unfinished === true;
  const results = unfinished || !Array.isArray(checked.results) ? [] : checked.results;
  const unmet = results.filter((r) => r.result === "fail").length;
  const unjudged = unfinished ? 0 : checked.unjudged;
  const row: CheckedRow = unfinished ? 4 : unmet > 0 ? 5 : unjudged > 0 ? 6 : 7;
  const noPicture = !unfinished && checked.pictures?.why !== undefined;
  const queuedWithoutLook = !approved && m.ownerStops === false && (f.mode === "owner" || unjudged > 0 || unfinished || noPicture);
  return { row, unmet, unjudged, approved, queuedWithoutLook, ...(noPicture && { noPicture }) };
}

/** A finished feature has no test that checked it: rows 2 and 4 to 7 (the caveat "N features have no tests"). */
export function hasNoTests(h: CheckedFacts): boolean {
  return h.row === 2 || h.row >= 4;
}

/** The finished features of the mission, in file order, with how each was checked. */
export function checkedList(m: ModeMission): CheckedFacts[] {
  return m.features.filter((f) => f.status === "done").map((f) => checkedFacts(m, f));
}

/** The titles of the features whose approval the checkpoint log holds, in file order. */
export function approvedTitles(m: ModeMission): string[] {
  return m.features.filter((f) => isApproved(m, f)).map((f) => f.title);
}

// ───────────────────────────── Why a feature stop happened (spec 5.2 step 8, 10.2, 11.3) ─────────────────────────────

/** Why the team stops at a feature, when the owner did not ask for it with `--checkpoint feature`. */
export type LookWhy = "owner" | "not_judged" | "unfinished" | "sent_back" | "repair" | "no_pictures";

/**
 * The reason for the stop at feature `f`, or undefined when the old words fit: the owner asked for it (`--checkpoint feature`), the
 * feature has no mode, or no rule of the spec applies. `sentBack` is how many times the owner sent this stop back. When several rules
 * apply: sent back first, then "owner", then the review that did not finish, then the checks not judged, then no picture shown (the engine's order too).
 */
export function lookWhy(m: ModeMission, f: Feature, sentBack: number): LookWhy | undefined {
  // The final review's repair stops when it changed a file of work the owner approved (the engine's rule (d), `changesApproved`).
  // `--checkpoint feature` does not cover it, and neither does the flag that turns the other stops off.
  if (FINAL_REPAIR.test(f.id)) {
    if (isModeFeature(f) && sentBack > 0) return "sent_back";
    const changed = new Set(Array.isArray(f.changesApproved) ? f.changesApproved : []);
    if (m.features.some((x) => x.id !== f.id && changed.has(x.id) && (isModeFeature(x) || DERIVED.test(x.id)) && isApproved(m, x))) return "repair";
  }
  if (m.checkpoints?.includes("feature") === true) return undefined;
  if (!isModeFeature(f) || DERIVED.test(f.id)) return undefined;
  if (sentBack > 0) return "sent_back";
  if (m.ownerStops === false) return undefined;
  if (f.mode === "owner") return "owner";
  const checked = f.checked;
  if (checked === undefined || checked.unfinished === true) return "unfinished";
  if (checked.unjudged > 0) return "not_judged";
  return checked.pictures?.why !== undefined ? "no_pictures" : undefined;
}
