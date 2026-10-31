// The debrief (the page calls it Results): what the team delivered, in a verdict, three lists and four honest ticks
// (docs/dashboard-spec.md, section 11). Pure: it only reads what the other modules already built.
import { REASON_MAX_CHARS } from "./constants.js";
import type { MissionFacts } from "./missions.js";
import { approvedTitles, checkedFacts, checkedList, hasModeFeature, hasNoTests, noTestsDone } from "./modes.js";
import type { UsageRecord } from "./read.js";
import { clean } from "./sanitize.js";
import type { Debrief, DebriefFeature, FeatureView, MissionDebrief, NeedsYouCard, Said, Tick, TickState, Verdict, VerdictId } from "./types.js";
import {
  agentTimeLine,
  checkedByWords,
  DEBRIEF_ALLOWANCE_NOTE,
  deliveredWhy,
  finalReviewCaveat,
  type FinalReviewWhy,
  finalReviewWhy,
  honestyNoteFor,
  overallSentence,
  noReworkWhy,
  nothingOpenWhy,
  plannedLine,
  TICK_LABELS,
  UNFINISHED_REVIEW_NOTE,
  type VerdictFacts,
  verdictSentence,
  VERDICT_WORDS,
} from "./vocabulary-details.js";
import type { Formatter } from "./vocabulary.js";

/** Worst first: the overall verdict is the worst verdict of its missions. */
const WORST_FIRST: VerdictId[] = ["needs_you", "partly_done", "paused", "done"];

/** The cards that make up a mission's "open items" (spec 9.4): the one number the tick and the verdict share. */
const OPEN_CARD_KINDS = new Set<string>(["decision", "feature_stuck", "mission_failed"]);

/** A mission is in the debrief when it finished, stopped for a reason a person can read, or needs help. A dead run has a red card instead, and so has a mission that waits for the owner's check. */
function verdictOf(m: MissionFacts): VerdictId | null {
  if (!m.data.readable || m.data.mission === null || m.view.scope !== "recent") return null;
  switch (m.view.state) {
    case "done":
      return "done";
    case "partly_done":
      return "partly_done";
    case "needs_you":
      return "needs_you";
    case "paused":
      // A mission that waits for the owner's check has its card; "continues on the next run" would not be true of it yet.
      return m.view.pausedWhy === "unexpected" || m.checkpoint?.state === "pending" ? null : "paused";
    default:
      return null;
  }
}

function verdict(id: VerdictId, sentence: string): Verdict {
  return { id, word: VERDICT_WORDS[id], sentence };
}

export function buildDebrief(m: MissionFacts[], cards: NeedsYouCard[], usage: UsageRecord[] | null, _f: Formatter): Debrief | null {
  const entries = m.flatMap((facts) => {
    const id = verdictOf(facts);
    return id === null ? [] : [{ facts, id }];
  });
  if (entries.length === 0) return null;

  const missions = entries.map(({ facts, id }) => missionDebrief(facts, id, cards, usage));
  const counts: Record<VerdictId, number> = { done: 0, partly_done: 0, needs_you: 0, paused: 0 };
  for (const e of entries) counts[e.id] += 1;
  const worst = WORST_FIRST.find((id) => counts[id] > 0) ?? "done";
  const [only] = missions;
  const sentence = only !== undefined && missions.length === 1 ? only.verdict.sentence : overallSentence(counts);
  // The owner's approvals that the checkpoint logs hold, for the missions that have a feature checked by a second AI (docs/modes-spec.md, 11.4).
  const approved = entries.flatMap(({ facts }) => {
    const mission = facts.data.mission;
    return mission !== null && hasModeFeature(mission) ? approvedTitles(mission) : [];
  });
  return { verdict: verdict(worst, sentence), missions, allowanceNote: DEBRIEF_ALLOWANCE_NOTE, honestyNote: honestyNoteFor(approved) };
}

function missionDebrief(facts: MissionFacts, id: VerdictId, cards: NeedsYouCard[], usage: UsageRecord[] | null): MissionDebrief {
  const { view } = facts;
  const mission = facts.data.mission;
  const mine = cards.filter((c) => c.missionId === view.id);
  const openItems = mine.filter((c) => OPEN_CARD_KINDS.has(c.kind)).length;
  const questions = mine.filter((c) => c.kind === "decision").length;
  const stuck = view.features.filter((x) => x.state === "stuck").length;
  const leftOut = view.features.filter((x) => x.state === "left_out").length;
  const done = view.featuresDone;
  const total = view.featuresTotal;
  const recovered = view.features.filter((x) => x.recovered);

  const stories = new Map((mission?.features ?? []).map((x) => [x.id, x.story]));
  // A mission with a feature checked by a second AI says how each finished feature was checked (11.4). Every other mission is shown as before.
  const modes = mission !== null && hasModeFeature(mission);
  const byId = new Map((mission?.features ?? []).map((x) => [x.id, x]));
  const checkedBy = (x: FeatureView): { checkedBy?: string } => {
    const source = byId.get(x.id);
    return modes && mission !== null && source !== undefined ? { checkedBy: checkedByWords(checkedFacts(mission, source)) } : {};
  };
  const feature = (x: FeatureView, note: Said | null): DebriefFeature => ({ featureId: x.id, title: x.title, note, attempts: x.steps.used, ...(x.reviewRecord&&{reviewRecord:x.reviewRecord}) });
  const storyOf = (x: FeatureView): Said | null => {
    const story = stories.get(x.id);
    const text = typeof story === "string" ? clean(story, REASON_MAX_CHARS) : "";
    return text === "" ? null : { text, author: "ai" };
  };

  const facts4: VerdictFacts = { done, total, stuck, leftOut, questions, ...(modes && { modes: true }) };
  const ticks = [
    deliveredTick(facts, facts4),
    finalReviewTick(facts, done, total),
    { id: "nothing_open", label: TICK_LABELS.nothing_open, state: tickState(openItems === 0 && !facts.baselineBroken), why: nothingOpenWhy(openItems, facts.baselineBroken), caveat: null },
    { id: "no_rework", label: TICK_LABELS.no_rework, state: tickState((mission?.gateCRounds ?? 0) === 0), why: noReworkWhy((mission?.gateCRounds ?? 0) === 0, recovered.length), caveat: null },
  ] satisfies Tick[];

  const ledger = usage === null ? [] : usage.filter((u) => u.missionId === view.id);
  const agentMs = ledger.reduce((sum, u) => sum + (Number.isFinite(u.durationMs) && u.durationMs > 0 ? u.durationMs : 0), 0);

  return {
    missionId: view.id,
    ...(view.reviewRecord&&{reviewRecord:view.reviewRecord}),
    title: view.title,
    verdict: verdict(id, verdictSentence(id, facts4)),
    plannedLine: plannedLine(total),
    got: view.features.filter((x) => x.state === "done").map((x) => ({ ...feature(x, storyOf(x)), ...checkedBy(x) })),
    leftOut: view.features.filter((x) => x.state === "stuck" || x.state === "left_out").map((x) => feature(x, x.reason)),
    recovered: recovered.map((x) => feature(x, storyOf(x))),
    ticks,
    agentTimeText: ledger.length === 0 ? null : agentTimeLine(agentMs),
    agentRuns: ledger.length === 0 ? null : ledger.length,
    tellLeader: view.tellLeader,
  };
}

function tickState(yes: boolean): TickState {
  return yes ? "yes" : "no";
}

function deliveredTick(facts: MissionFacts, v: VerdictFacts): Tick {
  const yes = v.total > 0 && v.done === v.total;
  const paused = facts.view.state === "paused";
  const mission = facts.data.mission;
  const checked = v.modes === true && mission !== null ? checkedList(mission) : undefined;
  return {
    id: "delivered",
    label: TICK_LABELS.delivered,
    state: tickState(yes),
    why: deliveredWhy(yes, { ...v, unbuilt: facts.unbuilt, paused, ...(checked !== undefined && { checked }) }),
    caveat: null,
  };
}

/**
 * The only tick that can be `unknown`: it rests on dispatch.json, the one file read for a few values only. Missing or
 * unreadable data is never `yes` (spec 11). The caveats never change the state.
 */
function finalReviewTick(facts: MissionFacts, done: number, total: number): Tick {
  const mission = facts.data.mission;
  const dispatch = facts.data.dispatch;
  const picks = dispatch !== null && dispatch !== "unavailable" ? dispatch : null;
  const finalVerify = picks === null ? null : picks.finalVerify;

  let state: TickState;
  let why: FinalReviewWhy;
  if (done === 0 || mission === null || mission.stage !== "complete") {
    state = "no";
    why = { kind: "not_run" };
  } else if (picks === null) {
    state = "unknown";
    why = { kind: "unreadable" };
  } else if (finalVerify === null) {
    // A readable dispatch.json without finalVerify: the final check never completed.
    state = "no";
    why = { kind: "not_run" };
  } else if (finalVerify.reviewed === false) {
    state = "no";
    why = { kind: "review_unfinished" };
  } else if (!finalVerify.ok) {
    state = "no";
    why = { kind: "tests_failed", baselineBroken: facts.baselineBroken };
  } else if ((finalVerify.blocking ?? 0) > 0) {
    state = "no";
    why = { kind: "blocking", count: finalVerify.blocking ?? 0 };
  } else if (finalVerify.judged === false) {
    // The project's own checks were already failing and no test could stand in for them: nothing judged the final result (docs/modes-spec.md, 10.3).
    state = "no";
    why = { kind: "nothing_judged" };
  } else {
    state = "yes";
    why = { kind: "passed" };
  }

  const unreviewed = (mission?.notes ?? []).filter((n) => UNFINISHED_REVIEW_NOTE.test(n)).length;
  const coveredOnly = finalVerify !== null && done > 0 && done < total ? done : null;
  // For a mission with a feature checked by a second AI, the final check is not told as one of tests, and the caveat counts the finished
  // features that no test checked (11.4). Any other mission keeps its old words.
  const modes = mission !== null && hasModeFeature(mission);
  const noTests = mission !== null && modes ? checkedList(mission).filter(hasNoTests).length : 0;
  return {
    id: "final_review",
    label: TICK_LABELS.final_review,
    state,
    why: finalReviewWhy(why, mission !== null && noTestsDone(mission)),
    caveat: finalReviewCaveat(unreviewed, coveredOnly, noTests),
  };
}
