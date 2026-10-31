// Human checkpoints: a place where one mission stops on purpose, shows its owner what to look at, and carries on only
// after the owner answers (approve, or send back with a note). This file holds the parts that need no running
// mission: the state machine the dispatcher follows at a gate, the one function that records an answer, and the
// plain-language texts the command line, the report and the phone notices share. The dispatcher (dispatcher.ts)
// does the stopping, the reworking and the carrying on.
import { isDerivedFeature, shownLookReason, stoppedBecause } from "./checked-by.js";
import { type MissionStore, planOf } from "./state.js";
import type { CheckpointAnswer, CheckpointKind, CheckpointRecord, Mission, MissionEvent, PendingCheckpoint, PlanReview } from "./types.js";
import { stripControlChars } from "./util/terminal.js";

/** In the order the owner meets them in a mission. */
export const CHECKPOINT_KINDS: readonly CheckpointKind[] = ["plan", "feature", "final"];
/** How many times the owner may send one thing back; one more send-back ends in an honest stop, not another round. */
export const MAX_SEND_BACKS = 2;
export const MAX_NOTE_CHARS = 2000;
/** The log keeps this many entries (see trimLog). */
export const MAX_LOG_ENTRIES = 50;
const MAX_TEXT_CHARS = 300;

// Features the engine adds by itself (the owner is not asked about them) are told apart in checked-by.ts, which holds the
// one rule for who is asked; it is exported from here as before.
export { isDerivedFeature };

export function isCheckpointKind(x: unknown): x is CheckpointKind {
  return CHECKPOINT_KINDS.includes(x as CheckpointKind);
}

/** "plan", "feature:<id>" or "final". */
export function scopeOf(kind: CheckpointKind, featureId?: string): string {
  return kind === "feature" ? `feature:${featureId ?? ""}` : kind;
}

/** "<scope>#<round>", for example "feature:add-shout#2". */
export function checkpointId(scope: string, round: number): string {
  return `${scope}#${round}`;
}

/** The owner's note as stored: one line, no control characters. */
export function cleanNote(raw: string): string {
  return oneLine(raw);
}

/** One line: whitespace runs become one space and control characters go. */
export function oneLine(text: string): string {
  return stripControlChars(text.replace(/\s+/g, " ")).replace(/\s+/g, " ").trim();
}

/** Text that came from an AI or from the owner, made safe to show on one line. */
export function shown(text: string, max = MAX_TEXT_CHARS): string {
  const flat = oneLine(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ───────────────────────────── State ─────────────────────────────

/** A checkpoint record with every field the engine and the readers rely on; anything else is treated as damaged. */
export function isCheckpointShape(x: unknown): x is PendingCheckpoint {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const c = x as Record<string, unknown>;
  const look = c.look as Record<string, unknown> | null | undefined;
  const answer = c.answer as Record<string, unknown> | null | undefined;
  return (
    typeof c.id === "string" &&
    typeof c.scope === "string" &&
    isCheckpointKind(c.kind) &&
    typeof c.round === "number" &&
    Number.isInteger(c.round) &&
    c.round >= 1 &&
    (c.state === "pending" || c.state === "answered") &&
    typeof c.parkedAt === "string" &&
    typeof look === "object" &&
    look !== null &&
    typeof look.headline === "string" &&
    Array.isArray(look.lines) &&
    (answer === undefined || (typeof answer === "object" && answer !== null && isDecision(answer.decision) && typeof answer.at === "string"))
  );
}

function isDecision(x: unknown): x is CheckpointAnswer["decision"] {
  return x === "approve" || x === "send_back";
}

/** The mission is stopped on purpose and waits for its owner's answer (what `mc run` leaves alone). */
export function isWaitingForCheck(m: Pick<Mission, "stage" | "checkpoint">): boolean {
  return m.stage !== "complete" && isCheckpointShape(m.checkpoint) && m.checkpoint.state === "pending";
}

/** How many times the owner has sent this scope back (and the engine has handled it). */
export function sendBacks(m: Pick<Mission, "checkpointLog">, scope: string): number {
  return (m.checkpointLog ?? []).filter((r) => r.scope === scope && r.decision === "send_back").length;
}

/** A scope is passed when the owner approved it. */
export function isPassed(m: Pick<Mission, "checkpointLog">, scope: string): boolean {
  return (m.checkpointLog ?? []).some((r) => r.scope === scope && r.decision === "approve");
}

/**
 * Keeps the newest MAX_LOG_ENTRIES entries. What goes first are the oldest feature entries: a finished feature never
 * comes back to its gate, while "plan" and "final" approvals must stay (a later pass through the same stage asks
 * about the plan again if its approval is gone).
 */
export function trimLog(log: CheckpointRecord[]): CheckpointRecord[] {
  let extra = log.length - MAX_LOG_ENTRIES;
  if (extra <= 0) return log;
  return log.filter((r) => {
    if (extra > 0 && r.kind === "feature") {
      extra--;
      return false;
    }
    return true;
  });
}

/**
 * Whether the log of events holds the answer this checkpoint says it got. `applyAnswer` appends that event before it
 * saves the mission, so an "answered" checkpoint without one was written by hand (or by an agent) and is not trusted.
 */
export function answerIsRecorded(cp: PendingCheckpoint, events: readonly MissionEvent[]): boolean {
  const answer = cp.answer;
  if (answer === undefined) return false;
  return events.some((e) => e.type === "checkpoint.answered" && e.data.id === cp.id && e.data.decision === answer.decision && e.data.at === answer.at);
}

/** What the dispatcher does when a mission reaches a gate. */
export type GateStep =
  /** Not chosen, a feature the engine added itself, or already approved: carry on. */
  | { step: "go" }
  /** Nothing is waiting for this scope: show it. `drop` says the checkpoint that was in the way is thrown out first. */
  | { step: "ask"; round: number; drop?: "stale" | "shape" }
  /** It is already waiting (the mission was resumed in an odd state): park again. */
  | { step: "stay" }
  /** Answered, but no record of the answer: hand-edited. Ask again. */
  | { step: "forged" }
  /** Approved: log it and carry on. */
  | { step: "pass" }
  /** Sent back, and the owner may still do that: change the work, then ask again. `change` is 1 or 2. */
  | { step: "rework"; change: number }
  /** Sent back once too often: the honest end state. */
  | { step: "limit" };

/**
 * The state machine at a gate, as a pure function of the mission. `recorded` is `answerIsRecorded(...)` (the caller reads
 * the events only when a checkpoint is answered). `asked` says whether this gate stops at all. It defaults to the old rule,
 * that the owner chose this kind of check; a feature gate passes `asksForLook(m, f)`, which also covers the features the
 * plan marks for the owner's look (docs/modes-spec.md 5.2, step 8).
 */
export function nextCheckpointState(
  m: Pick<Mission, "checkpoints" | "checkpoint" | "checkpointLog">,
  kind: CheckpointKind,
  featureId: string | undefined,
  recorded: boolean,
  asked: boolean = m.checkpoints?.includes(kind) === true,
  repairLook: boolean = false,
): GateStep {
  if (!asked) return { step: "go" };
  // A feature the engine added itself is not asked about, except the final repair that changed work the owner approved (`repairLook`:
  // the caller says so when `asked` came from that rule or from a send-back of the repair).
  if (kind === "feature" && (featureId === undefined || (isDerivedFeature(featureId) && !repairLook))) return { step: "go" };
  const scope = scopeOf(kind, featureId);
  if (isPassed(m, scope)) return { step: "go" };
  const sent = sendBacks(m, scope);
  const cp = m.checkpoint;
  if (cp === undefined) return { step: "ask", round: sent + 1 };
  if (!isCheckpointShape(cp)) return { step: "ask", round: sent + 1, drop: "shape" };
  if (cp.scope !== scope) return { step: "ask", round: sent + 1, drop: "stale" };
  if (cp.state === "pending") return { step: "stay" };
  if (!recorded || cp.answer === undefined) return { step: "forged" };
  if (cp.answer.decision === "approve") return { step: "pass" };
  return sent >= MAX_SEND_BACKS ? { step: "limit" } : { step: "rework", change: sent + 1 };
}

// ───────────────────────────── Answers ─────────────────────────────

export interface AnswerInput {
  decision: CheckpointAnswer["decision"];
  note?: string;
}

/** Why an answer can't be recorded. */
export type AnswerProblem =
  | { reason: "not_waiting" }
  | { reason: "already_answered"; decision: CheckpointAnswer["decision"]; at: string }
  | { reason: "no_note" }
  | { reason: "note_too_long" }
  | { reason: "damaged" };

export type AnswerResult =
  | {
      ok: true;
      mission: Mission;
      answer: CheckpointAnswer;
      /** For a send-back: which change this is (1 or 2), and whether it is one too many. */
      change: number;
      limit: boolean;
    }
  | ({ ok: false } & AnswerProblem);

/** Why `input` can't be recorded for `m` right now, or undefined when it can. */
export function answerProblem(m: Pick<Mission, "stage" | "checkpoint" | "checkpointLog">, input: AnswerInput): AnswerProblem | undefined {
  const cp = m.checkpoint;
  if (cp === undefined || m.stage === "complete") return { reason: "not_waiting" };
  if (!isCheckpointShape(cp)) return { reason: "damaged" };
  if (cp.state === "answered") return cp.answer ? { reason: "already_answered", decision: cp.answer.decision, at: cp.answer.at } : { reason: "damaged" };
  const note = cleanNote(input.note ?? "");
  if (input.decision === "send_back" && note === "") return { reason: "no_note" };
  if (note.length > MAX_NOTE_CHARS) return { reason: "note_too_long" };
  return undefined;
}

/**
 * Records the owner's answer: the only code that moves a checkpoint from pending to answered. The caller must hold the
 * run lock (`store.acquireLock()`), so no run holds its own copy of the mission that a later save would overwrite.
 *
 * The event is appended before the mission is saved. A crash between the two leaves the check waiting (the owner
 * answers again); the other order could leave an answer with no record, and the dispatcher distrusts exactly that.
 */
export function applyAnswer(store: MissionStore, missionId: string, input: AnswerInput, nowMs: number): AnswerResult {
  const m = store.load(missionId);
  const problem = answerProblem(m, input);
  if (problem) return { ok: false, ...problem };
  const cp = m.checkpoint as PendingCheckpoint; // answerProblem checked its shape
  const note = cleanNote(input.note ?? "");
  const answer: CheckpointAnswer = { decision: input.decision, ...(note !== "" && { note }), at: new Date(nowMs).toISOString() };
  store.appendEvent(
    m.id,
    "checkpoint.answered",
    { id: cp.id, kind: cp.kind, ...(cp.featureId !== undefined && { feature: cp.featureId }), decision: answer.decision, round: cp.round, at: answer.at },
    nowMs,
  );
  m.checkpoint = { ...cp, state: "answered", answer };
  store.save(m, nowMs);
  const earlier = sendBacks(m, cp.scope);
  return { ok: true, mission: m, answer, change: earlier + 1, limit: input.decision === "send_back" && earlier >= MAX_SEND_BACKS };
}

// ───────────────────────────── Texts ─────────────────────────────

function title(m: Pick<Mission, "title">): string {
  return shown(m.title);
}

function featureTitle(m: Pick<Mission, "features">, featureId: string | undefined): string {
  return shown(m.features.find((f) => f.id === featureId)?.title ?? featureId ?? "this feature");
}

/** What the check is about: "the plan", “Add shout”, "the finished app". */
export function subjectOf(m: Pick<Mission, "features">, cp: Pick<PendingCheckpoint, "kind" | "featureId">): string {
  switch (cp.kind) {
    case "plan":
      return "the plan";
    case "feature":
      return `“${featureTitle(m, cp.featureId)}”`;
    case "final":
      return "the finished app";
  }
}

/** Where the mission stands, for "(…)" after "waiting for your check": “Add shout”, before it is added. */
export function waitingWhat(m: Pick<Mission, "features">, cp: Pick<PendingCheckpoint, "kind" | "featureId">): string {
  return cp.kind === "feature" ? `${subjectOf(m, cp)}, before it is added` : subjectOf(m, cp);
}

/** "the plan", “Add shout” before it is added, "the finished app". */
function lookAt(m: Pick<Mission, "features">, cp: Pick<PendingCheckpoint, "kind" | "featureId">): string {
  return cp.kind === "feature" ? `${subjectOf(m, cp)} before it is added` : subjectOf(m, cp);
}

/** The two commands that answer a check. */
export function answerCommands(id: string): string {
  return `mc approve ${id}, or: mc send-back ${id} --note "what to change"`;
}

/** The plan stop of a mission whose plan the leader wrote (queued with `mc plan queue`): such a plan is looked at first, whatever else was chosen. */
export function isLeaderPlanStop(m: Pick<Mission, "plan">, cp: Pick<PendingCheckpoint, "kind">): boolean {
  return cp.kind === "plan" && planOf(m) !== undefined;
}

/**
 * Why the team stopped, for "The team stopped because ...": the owner asked to look at `what` (the place, in the words of
 * the caller), or the leader wrote this plan. The second names the command that prints all of the plan, because
 * `mc report` shows only its first 40 lines.
 */
export function whyStopped(
  m: Pick<Mission, "id" | "plan" | "features"> & Partial<Pick<Mission, "ownerStops" | "checkpoints" | "checkpointLog">>,
  cp: Pick<PendingCheckpoint, "kind" | "featureId">,
  what = lookAt(m, cp),
): string {
  if (isLeaderPlanStop(m, cp)) return `the leader wrote this plan, and you look at such a plan first. Read all of it with: mc plan show ${m.id}`;
  // A feature stop the owner did not ask for with `--checkpoint feature` says why it stops: the plan marks the feature, the second AI could not judge it, ...
  // The repair of the final review (and the change a send-back at the final stop adds) is never covered by `--checkpoint feature`, so it always says its own reason.
  if (cp.kind === "feature") {
    const f = m.features.find((x) => x.id === cp.featureId);
    const reason = f ? shownLookReason(m, f) : undefined;
    if (reason !== undefined) return stoppedBecause(reason, featureTitle(m, cp.featureId));
  }
  return `you asked to look at ${what} first`;
}

/** The command that shows what a check is about: all of a leader's plan, else the report. */
export function lookCommand(m: Pick<Mission, "id" | "plan">, cp: Pick<PendingCheckpoint, "kind"> | undefined): string {
  return cp && isLeaderPlanStop(m, cp) ? `mc plan show ${m.id}` : `mc report ${m.id}`;
}

/** The phone notice when a mission stops for a check (high priority). `ignored`: an answer found in the file was not trusted. */
export function parkedNotice(m: Mission, cp: PendingCheckpoint, ignored = false): { title: string; message: string } {
  const lead = ignored ? "An answer was found in this mission's file that was not given with mc approve or mc send-back, so it was ignored. " : "";
  const read = isLeaderPlanStop(m, cp) ? "" : ` Read it with: mc report ${m.id}.`;
  return {
    title: `${title(m)}: please check ${lookAt(m, cp)}`,
    message: `${lead}The team stopped because ${whyStopped(m, cp)}.${read} Then run: ${answerCommands(m.id)}. Nothing else is waiting on this; other work carries on.`,
  };
}

// ───────────────────────────── The plan reviewer's answer (plans from outside) ─────────────────────────────

/** What the team's plan reviewer (gate A) did with a plan the leader wrote, in full: the owner's look and `mc plan show`. */
export function planReviewSentence(review: PlanReview): string {
  if (review.latestRevision !== undefined) {
    const latest = review.latestRevision === "applied" ? "The requested technical wording was applied."
      : review.latestRevision === "partly_rejected" ? "Some technical wording was applied; changes to supplied requirements were rejected."
        : "The latest proposed changes were not applied.";
    const retained = review.outcome === "revised" ? " Earlier usable wording remains where applicable." : " The original usable plan was retained.";
    return `${latest}${retained} Supplied checks, feature identities and dependencies were retained.${asked(review.issues)}`;
  }
  switch (review.outcome) {
    case "approved":
      return "The team's plan reviewer read it and asked for no changes.";
    case "revised":
      return `The team's plan reviewer asked for changes, so the team's planner revised the plan. This is the revised plan.${asked(review.issues)}`;
    case "not_applied":
      return `The team's plan reviewer asked for changes that could not be applied, so the plan is as the leader wrote it.${asked(review.issues)}`;
    case "unfinished":
      return "The team's plan reviewer did not finish, so the plan is as the leader wrote it.";
  }
}

/** The same, shortened for the report's header line. */
export function planReviewShort(review: PlanReview): string {
  if (review.latestRevision === "partly_rejected") return "technical wording was revised; changes to supplied requirements were rejected.";
  if (review.latestRevision === "not_applied") return `the latest proposed changes were rejected; ${review.outcome === "revised" ? "earlier usable wording remains" : "the original plan was retained"}.`;
  if (review.latestRevision === "applied") return "technical wording was revised; supplied requirements were retained.";
  switch (review.outcome) {
    case "approved":
      return "the team's plan reviewer asked for no changes.";
    case "revised":
      return "the team's plan reviewer asked for changes and the planner revised it.";
    case "not_applied":
      return "the team's plan reviewer asked for changes that could not be applied.";
    case "unfinished":
      return "the team's plan reviewer did not finish.";
  }
}

/** The longest answer of the plan reviewer that is shown whole. A longer one is cut at the end of a sentence (see `issueShown`). */
export const ISSUE_MAX_CHARS = 400;
/** A sentence end earlier than this is not worth cutting at: a single short sentence would be left (the cut is then made at a word). */
const ISSUE_SENTENCE_MIN = 60;

/**
 * A point the plan reviewer made, made safe to show on one line and kept whole up to `max` characters. A longer one is cut at the end of the
 * last sentence that fits and ends with an ellipsis (the result is never longer than `max`). When no sentence ends in time, it is cut at a
 * space. It is not cut in the middle of a word (real runs R3b and R4 showed "... the single fi…." and "... is checked by tests w….").
 */
export function issueShown(text: string, max = ISSUE_MAX_CHARS): string {
  const flat = oneLine(text);
  if (flat.length <= max) return flat;
  let end = -1;
  for (let i = max - 3; i >= ISSUE_SENTENCE_MIN; i--) {
    if (/[.!?]/u.test(flat.charAt(i)) && flat.charAt(i + 1) === " ") {
      end = i + 1;
      break;
    }
  }
  if (end > 0) return `${flat.slice(0, end)} …`;
  const space = flat.lastIndexOf(" ", max - 1);
  return `${flat.slice(0, space > 0 ? space : max - 1).trimEnd()}…`;
}

/** " It asked: a; b; c and 2 more." (sentences that end in a full stop follow each other without the semicolon). The points are AI-written text, so each goes through `issueShown`. */
function asked(issues: string[]): string {
  if (issues.length === 0) return "";
  const points = issues.slice(0, 3).map((i) => issueShown(i));
  const text = points.reduce((all, point) => (all === "" ? point : `${all}${/[.!?…]$/.test(all) ? " " : "; "}${point}`), "");
  const more = issues.length > 3 ? ` and ${issues.length - 3} more` : "";
  return ` It asked: ${text}${more}${/[.!?…]$/.test(`${text}${more}`) ? "" : "."}`;
}

/** What the owner did, in the words of the confirmations: "you approved the plan for “Shout”". */
export function didWhat(m: Mission, cp: Pick<PendingCheckpoint, "kind" | "featureId">, decision: CheckpointAnswer["decision"]): string {
  const subject = subjectOf(m, cp);
  // A feature that has the mission's own title is named once: "you approved “Usage guide”", not "... “Usage guide” for “Usage guide”" (real run R2).
  const forMission = subject === `“${title(m)}”` ? "" : ` for “${title(m)}”`;
  return decision === "approve" ? `you approved ${subject}${forMission}` : `you sent ${subject}${forMission} back`;
}

/** The phone notice after an answer was recorded (default priority), so an answer you did not give shows up. */
export function answerNotice(m: Mission, cp: PendingCheckpoint, answer: CheckpointAnswer): { title: string; message: string } {
  const did = didWhat(m, cp, answer.decision);
  return {
    title: `${title(m)}: your answer was recorded`,
    message: `${did.charAt(0).toUpperCase()}${did.slice(1)} at ${localClock(answer.at)}. It continues on the next run.`,
  };
}

/** How the work ends when the owner sends something back once too often. */
export function endState(kind: CheckpointKind): string {
  switch (kind) {
    case "plan":
      return "nothing will be built";
    case "feature":
      return "this feature is set aside and the rest carries on";
    case "final":
      return "the finished result is kept as it is";
  }
}

/** HH:MM in local time; the raw text when it isn't a date. */
export function localClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
