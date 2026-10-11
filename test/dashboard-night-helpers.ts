// Small stand-ins for the night modules' unit tests (timeline, debrief): a MissionFacts built by hand from a mission and
// its events, so those tests do not depend on how the mission views are computed. The whole path is covered by the
// tests that build a snapshot from a fixture.
import type { MissionFacts } from "../src/dashboard/missions.js";
import { type DispatchPicks, readDetails, readHome } from "../src/dashboard/read.js";
import type { FeatureStateId, FeatureView, MissionStateId, MissionView, NeedsYouCard, PausedWhy, Scope } from "../src/dashboard/types.js";
import { explainFeatureReason } from "../src/dashboard/vocabulary-night.js";
import type { Feature, Mission, MissionEvent } from "../src/types.js";
import { copyHome } from "./dashboard-helpers.js";

const FEATURE_STATE: Record<string, FeatureStateId> = {
  pending: "waiting_turn",
  testing: "being_built",
  building: "being_built",
  reviewing: "being_reviewed",
  done: "done",
  blocked: "stuck",
  skipped: "left_out",
};

export const LADDER_SIZE = 5;

function featureView(f: Feature): FeatureView {
  const tries = f.attempts.filter((a) => a.action === "build" || a.action === "diagnose").length;
  return {
    id: f.id,
    title: f.title,
    state: FEATURE_STATE[f.status] ?? "unknown",
    word: f.status,
    reason: f.blockedReason === undefined ? null : explainFeatureReason(f.blockedReason),
    steps: { used: Math.min(tries, LADDER_SIZE), total: LADDER_SIZE, caption: `${tries} tries` },
    reinforcements: Math.max(0, tries - 1),
    recovered: f.status === "done" && f.attempts.some((a) => a.action === "build" && a.outcome !== "pass"),
    acceptanceTests: f.frozenTests.length,
    isRepair: f.id.startsWith("gate-c-fix-"),
    cardId: null,
    tellLeader: `About "${f.title}" in ${f.id}: <your answer here>`,
  };
}

export interface FakeFactsOptions {
  events?: MissionEvent[] | null;
  dispatch?: DispatchPicks | "unavailable" | null;
  state?: MissionStateId;
  pausedWhy?: PausedWhy | null;
  scope?: Scope;
  unbuilt?: number;
  baselineBroken?: boolean;
  readable?: boolean;
}

const STATE_OF_STATUS: Record<string, MissionStateId> = {
  queued: "not_started",
  running: "working",
  waiting: "waiting",
  stopped: "paused",
  done: "done",
  partial: "partly_done",
  failed: "needs_you",
};

/** A MissionFacts with only the fields the night modules read. Everything else is a placeholder. */
export function fakeFacts(mission: Mission, o: FakeFactsOptions = {}): MissionFacts {
  const features = mission.features.map(featureView);
  const view = {
    id: mission.id,
    title: mission.title,
    readable: o.readable ?? true,
    kind: "new_app",
    kindWord: "new app",
    scope: o.scope ?? "tonight",
    openFromBefore: o.scope === "before",
    state: o.state ?? STATE_OF_STATUS[mission.status] ?? "unknown",
    word: "",
    sentence: "",
    pausedWhy: o.pausedWhy ?? null,
    progress: [],
    progressWord: "",
    repairLap: false,
    featuresDone: mission.features.filter((f) => f.status === "done").length,
    featuresTotal: mission.features.length,
    featuresLine: "",
    waiting: null,
    features,
    updatedAt: Date.parse(mission.updatedAt),
    tellLeader: `About "${mission.title}": <your answer here>`,
  } satisfies MissionView;
  return {
    data: {
      folder: mission.id,
      readable: o.readable ?? true,
      mission,
      mtimeMs: Date.parse(mission.updatedAt),
      events: o.events === undefined ? [] : o.events,
      dispatch: o.dispatch === undefined ? null : o.dispatch,
      dispatchMtimeMs: null,
    },
    view,
    savedBusy: false,
    staleBusy: false,
    asleep: false,
    wait: null,
    openRun: null,
    unbuilt: o.unbuilt ?? mission.features.filter((f) => ["pending", "testing", "building", "reviewing"].includes(f.status)).length,
    baselineBroken: o.baselineBroken ?? mission.baselineBroken,
    runGone: null,
  };
}

/** A card with only the fields the debrief reads. */
export function fakeCard(missionId: string, kind: NeedsYouCard["kind"], featureId: string | null = null): NeedsYouCard {
  return {
    id: `${kind}:${missionId}:${featureId ?? 0}`,
    kind,
    severity: "look",
    missionId,
    missionTitle: missionId,
    fromBefore: false,
    featureId,
    title: "A card",
    happened: { text: "It happened.", author: "engine" },
    summary: null,
    ifNothing: "Nothing happens.",
    whatToDo: null,
    tellLeader: 'About "x": <your answer here>',
  };
}

/** The facts of every mission of a fixture, read from a fresh copy (events and dispatch.json included). */
export function fixtureFacts(name: string, o: FakeFactsOptions = {}): MissionFacts[] {
  const home = copyHome(name);
  const data = readHome(home);
  readDetails(home, data, data.missions.map((m) => m.folder));
  return data.missions.flatMap((m) => (m.mission === null ? [] : [fakeFacts(m.mission, { events: m.events, dispatch: m.dispatch, ...o })]));
}
