// The night lamp (docs/dashboard-spec.md, 5): one decision table, worst state wins. Every threshold is a named constant
// in constants.ts and every word is in vocabulary.ts. Unknown input is never green.
import { LONG_WAIT_MS, QUIET_ACTIVITY_MS } from "./constants.js";
import { type MissionFacts, workedMission } from "./missions.js";
import type { HomeData } from "./read.js";
import type { Counts, Lamp, LampReason, LampReasonCode, LampSeverity, LampStateId, NeedsYouCard, RunInfo } from "./types.js";
import { allDoneSentence, CLAUSE, LAMP_WORDS, nothingSentence, problemSentence, workingSentence } from "./vocabulary.js";

export interface LampInput {
  now: number;
  home: HomeData["home"];
  run: RunInfo;
  missions: MissionFacts[];
  cards: NeedsYouCard[];
  counts: Counts;
}

/** The look reasons that leave the rest of a live run "on track" in the sentence. */
const REST_IS_ON_TRACK = new Set<LampReasonCode>(["feature_stuck", "decision_waiting", "checks_failing_before", "mission_partial"]);

const minutes = (ms: number): number => Math.floor(Math.max(0, ms) / 60_000);

export function buildLamp(i: LampInput): Lamp {
  const live = i.run.active;
  const tonight = i.missions.filter((x) => x.view.scope === "tonight");
  const readable = tonight.filter((x) => x.view.readable);
  const reasons: LampReason[] = [];
  const add = (code: LampReasonCode, severity: LampSeverity, text: string, missionId: string | null = null, featureId: string | null = null): void => {
    reasons.push({ code, severity, text, missionId, featureId });
  };
  const only = (list: MissionFacts[]): string | null => (list.length === 1 ? (list[0]?.view.id ?? null) : null);

  // L1: a mission failed. This includes an expired login.
  const failed = readable.filter((x) => x.view.state === "needs_you");
  if (failed.length > 0) add("mission_failed", "now", CLAUSE.missionFailed(failed.length, failed[0]?.view.title ?? null), only(failed));
  // L2 and L3: the run is gone while a mission is saved as busy; the first minute is only amber.
  const gone = readable.filter((x) => x.runGone === "gone");
  if (gone.length > 0) add("run_gone", "now", CLAUSE.runGone, only(gone));
  const pending = readable.filter((x) => x.runGone === "pending");
  if (pending.length > 0) add("run_gone_pending", "look", CLAUSE.runGonePending, only(pending));
  // L4 and L5: files that cannot be read.
  if (i.home === "unreadable") add("home_unreadable", "look", CLAUSE.homeUnreadable);
  if (i.counts.unreadableMissions > 0) add("unreadable_mission", "look", CLAUSE.unreadableMissions(i.counts.unreadableMissions));
  // L6: a state this page does not know. An unreadable mission is already L5.
  const unknown = readable.filter((x) => x.view.state === "unknown" || x.view.features.some((f) => f.state === "unknown"));
  if (unknown.length > 0) add("unknown_state", "look", CLAUSE.unknownState, only(unknown));
  // L7 and L8: paused for a reason that is not the owner's.
  const disk = readable.filter((x) => x.view.state === "paused" && x.view.pausedWhy === "disk");
  if (disk.length > 0) add("paused_disk", "look", CLAUSE.pausedDisk, only(disk));
  const aiFailing = readable.filter((x) => x.view.state === "paused" && x.view.pausedWhy === "ai_failing");
  if (aiFailing.length > 0) add("paused_ai_failing", "look", CLAUSE.pausedAiFailing, only(aiFailing));
  // L9 and L10: stuck features and questions.
  const leftOut = readable.reduce((sum, x) => sum + x.view.features.filter((f) => f.state === "left_out").length, 0);
  if (i.counts.stuckFeatures > 0) add("feature_stuck", "look", CLAUSE.stuck(i.counts.stuckFeatures));
  else if (leftOut > 0) add("feature_stuck", "look", CLAUSE.leftOut(leftOut));
  if (i.counts.questions > 0) add("decision_waiting", "look", CLAUSE.questions(i.counts.questions));

  const waits = readable.filter((x) => x.view.state === "waiting" && x.wait !== null);
  // L11: one AI needs a new login, whatever the length of the wait.
  if (waits.some((x) => x.wait?.cause === "login")) add("login_needed", "look", CLAUSE.login, only(waits.filter((x) => x.wait?.cause === "login")));
  // L12: the project's own checks were already failing.
  const baseline = readable.filter((x) => x.baselineBroken);
  if (baseline.length > 0) add("checks_failing_before", "look", CLAUSE.checksFailing, only(baseline));
  // L13: paused missions are not retaken by the run that paused them.
  const unbuilt = readable.filter((x) => x.view.state === "paused" && (x.view.pausedWhy === "deadline" || x.view.pausedWhy === "stop_requested" || x.view.pausedWhy === "unknown"));
  if (unbuilt.length > 0) {
    const u = unbuilt.reduce((sum, x) => sum + x.unbuilt, 0);
    const n = unbuilt.reduce((sum, x) => sum + x.view.featuresTotal, 0);
    add("paused_unbuilt", "look", CLAUSE.pausedUnbuilt(u, n, unbuilt.length), only(unbuilt));
  }
  // L14: partly done, and nothing else in that mission already says why.
  for (const x of readable) {
    if (x.view.state !== "partly_done") continue;
    const explained = x.view.features.some((f) => f.state === "stuck" || f.state === "left_out") || i.cards.some((c) => c.kind === "decision" && c.missionId === x.view.id);
    if (!explained) add("mission_partial", "look", CLAUSE.partial(x.view.title), x.view.id);
  }
  // L15: a failed mission from before.
  if (i.counts.olderNeedYou > 0) add("older_failed", "look", CLAUSE.olderFailed(i.counts.olderNeedYou));
  // L16 and L17: waits of unknown cause, and long waits.
  const waitLeft = (x: MissionFacts): number => Math.max(0, (x.wait?.until ?? 0) - i.now);
  const unknownWaits = waits.filter((x) => x.wait?.cause === "unknown");
  if (unknownWaits.length > 0) add("wait_unknown", "look", CLAUSE.waitUnknown, only(unknownWaits));
  const known = waits.filter((x) => x.wait?.cause === "limits" || x.wait?.cause === "trouble");
  const longWait = known.find((x) => waitLeft(x) > LONG_WAIT_MS);
  if (longWait?.wait && (longWait.wait.cause === "limits" || longWait.wait.cause === "trouble")) {
    add("long_wait", "look", CLAUSE.waitUntil(longWait.wait.cause, longWait.wait.untilText), longWait.view.id);
  }
  // L18 to L20: the run itself.
  if (i.run.heartbeat === "late") add("heartbeat_late", "look", CLAUSE.heartbeatLate(minutes(i.run.heartbeatAgeMs ?? 0)));
  const worked = workedMission(i.missions);
  if (i.run.heartbeat === "fresh" && worked?.view.state === "working" && i.run.lastActivityAt !== null && i.now - i.run.lastActivityAt >= QUIET_ACTIVITY_MS) {
    add("quiet_run", "look", CLAUSE.quiet(minutes(i.now - i.run.lastActivityAt)), worked.view.id);
  }
  if (live && i.run.stopRequested) add("stop_requested", "look", CLAUSE.stopRequested);
  // L21 to L23: shown, but they change no colour.
  const shortWait = known.find((x) => waitLeft(x) <= LONG_WAIT_MS);
  if (shortWait?.wait && (shortWait.wait.cause === "limits" || shortWait.wait.cause === "trouble")) {
    add("short_wait", "info", CLAUSE.waitUntil(shortWait.wait.cause, shortWait.wait.untilText), shortWait.view.id);
  }
  const queued = readable.filter((x) => x.view.state === "not_started");
  if (queued.length > 0) add("queued", "info", CLAUSE.queued(queued.length), only(queued));
  if (i.counts.olderWaitingForYou > 0) add("older_items", "info", CLAUSE.olderItems(i.counts.olderWaitingForYou));

  // L24 to L26: what makes a calm lamp green or grey.
  const trouble = reasons.some((r) => r.severity === "now" || r.severity === "look");
  const allDone = tonight.length > 0 && tonight.some((x) => x.view.state === "done") && tonight.every((x) => x.view.state === "done" || x.view.state === "not_started");
  if (!trouble) {
    if (live) add("working", "ok", CLAUSE.working);
    else if (allDone) add("all_done", "ok", CLAUSE.allDone);
    else add("nothing_tonight", "ok", CLAUSE.nothingTonight);
  }

  const state: LampStateId = reasons.some((r) => r.severity === "now")
    ? "needs_you_now"
    : trouble
      ? "needs_look"
      : reasons.some((r) => r.code === "working" || r.code === "all_done")
        ? "on_track"
        : "idle";

  return { state, word: LAMP_WORDS[state], sentence: sentenceFor(state, reasons, i, { live, queued: queued.length, doneMissions: tonight.filter((x) => x.view.state === "done").length }), reasons };
}

function sentenceFor(state: LampStateId, reasons: LampReason[], i: LampInput, x: { live: boolean; queued: number; doneMissions: number }): string {
  if (state === "needs_you_now" || state === "needs_look") {
    const problems = reasons.filter((r) => r.severity === "now" || r.severity === "look");
    const restIsOnTrack = state === "needs_look" && x.live && problems.every((r) => REST_IS_ON_TRACK.has(r.code));
    return problemSentence(
      problems.map((r) => r.text),
      restIsOnTrack,
    );
  }
  const code = (c: LampReasonCode): boolean => reasons.some((r) => r.code === c);
  const wait = reasons.find((r) => r.code === "short_wait");
  const waitFacts = i.missions.find((m) => m.view.id === wait?.missionId)?.wait ?? null;
  const shortWait = waitFacts !== null && (waitFacts.cause === "limits" || waitFacts.cause === "trouble") ? { cause: waitFacts.cause, untilText: waitFacts.untilText } : null;
  const calm = { done: i.counts.featuresDone, total: i.counts.featuresTotal, shortWait, olderWaiting: code("older_items") ? i.counts.olderWaitingForYou : 0, queued: code("queued") ? x.queued : 0 };
  if (code("working")) return workingSentence(calm);
  if (code("all_done")) return allDoneSentence({ ...calm, missions: x.doneMissions });
  const otherOlder = Math.max(0, i.counts.openFromBefore - i.counts.olderNeedYou - i.counts.olderWaitingForYou);
  return nothingSentence({ queued: calm.queued, olderWaiting: calm.olderWaiting, otherOlder });
}
