// The Needs-you cards (docs/dashboard-spec.md, 9): what the AI team could not settle alone. One fact, one card.
// Pure: it reads the mission views and the cleaned mission files. The words are in vocabulary.ts.
import { CHECKPOINT_LINES_MAX, CHECKPOINT_SEND_BACK_CAP, MAX_DECISIONS_SHOWN } from "./constants.js";
import type { MissionFacts } from "./missions.js";
import { lookWhy, noTestsDone } from "./modes.js";
import type { CardKind, FeatureView, NeedsYouCard, Said } from "./types.js";
import { CARD_KINDS } from "./types.js";
import {
  CARD_TEXT,
  checkpointSummary,
  concernsHappened,
  concernsOf,
  decisionTitle,
  explainFailureReason,
  LEADER,
  loginFailureAis,
  makeLeaderNames,
  type Formatter,
  type LeaderCheck,
  loginHappened,
  loginWhatToDo,
  stuckIfNothing,
  type LeaderNames,
  type StuckOutlook,
} from "./vocabulary.js";

const WAITING_ON = /^waiting on "(.+)", which was (?:blocked|skipped)$/;
const ARCHITECT_BLOCK = /^"(.+?)": (.*)$/s;

interface Draft {
  card: NeedsYouCard;
  /** Position of the mission in the list, then of the kind, then of the feature or entry: the order of 9. */
  order: [number, number, number];
}

type MissionRef = { id: string; title: string };

function outlookOf(state: MissionFacts["view"]["state"]): StuckOutlook {
  switch (state) {
    case "working":
    case "waiting":
    case "paused":
    case "not_started":
      return "carries_on";
    case "needs_you":
      return "stopped";
    case "done":
    case "partly_done":
      return "finished";
    case "unknown":
      return "unknown";
  }
}

/** Titles of the features left out because of the stuck one, directly or through another left-out feature. */
function leftOutBecause(x: MissionFacts, stuck: FeatureView): string[] {
  const reasons = new Map<string, string>(); // left-out feature title -> the title it waited on
  for (const f of x.view.features) {
    if (f.state !== "left_out") continue;
    const waiting = WAITING_ON.exec(rawBlockedReason(x, f.id));
    if (waiting?.[1] !== undefined) reasons.set(f.title, waiting[1]);
  }
  const out = new Set<string>();
  const roots = new Set([stuck.title]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [title, on] of reasons) {
      if (roots.has(on) && !out.has(title)) {
        out.add(title);
        roots.add(title);
        changed = true;
      }
    }
  }
  return [...out];
}

function rawBlockedReason(x: MissionFacts, featureId: string): string {
  return x.data.mission?.features.find((f) => f.id === featureId)?.blockedReason ?? "";
}

/** The failure reason as written: the mission's own, else the last mission.failed event's. "" when there is none. */
function rawFailureReason(x: MissionFacts): string {
  const mission = x.data.mission;
  const fromFile = mission?.failure?.reason;
  const failed = [...(x.data.events ?? [])].reverse().find((e) => e.type === "mission.failed");
  return fromFile ?? (typeof failed?.data.reason === "string" ? failed.data.reason : "");
}

function failureReason(x: MissionFacts): Said {
  const reason = rawFailureReason(x);
  return reason === "" ? { text: CARD_TEXT.failedFallbackReason, author: "engine" } : explainFailureReason(reason);
}

/** What a person does about a failed mission: log in again when that is the cause, else ask the leader (spec 9.1). */
function failureWhatToDo(x: MissionFacts): Said {
  const logins = loginFailureAis(rawFailureReason(x));
  return { text: logins === null ? CARD_TEXT.failedWhatToDoOther : loginWhatToDo(logins), author: "engine" };
}

function engineSays(text: string): Said {
  return { text, author: "engine" };
}

function missionLevel(
  x: MissionFacts,
  o: { kind: CardKind; severity: "now" | "look"; fromEarlier: boolean; title: string; happened: Said; ifNothing: string; whatToDo: Said | null; tellLeader: string },
): NeedsYouCard {
  return {
    id: `${o.kind}:${x.view.id}:0`,
    kind: o.kind,
    severity: o.severity,
    missionId: x.view.id,
    missionTitle: x.view.title,
    fromEarlier: o.fromEarlier,
    featureId: null,
    title: o.title,
    happened: o.happened,
    summary: null,
    ifNothing: o.ifNothing,
    whatToDo: o.whatToDo,
    tellLeader: o.tellLeader,
  };
}

/** The question cards of one mission: the decisions nobody else has taken (spec 9.4). */
function decisionCards(x: MissionFacts, names: LeaderNames, rank: number): Draft[] {
  const mission = x.data.mission;
  if (mission === null) return [];
  const blockedTitles = new Set(mission.features.filter((f) => f.status === "blocked").map((f) => f.title));
  const open: { entry: string; index: number }[] = [];
  mission.decisionsNeeded.forEach((entry, index) => {
    if (mission.failure?.decision !== undefined && entry === mission.failure.decision) return;
    const architect = ARCHITECT_BLOCK.exec(entry);
    if (architect?.[1] !== undefined && blockedTitles.has(architect[1])) return;
    open.push({ entry, index });
  });
  const shown = open.slice(0, MAX_DECISIONS_SHOWN);
  const ref: MissionRef = { id: x.view.id, title: x.view.title };
  return shown.map(({ entry, index }, i): Draft => {
    const concerns = concernsOf(entry);
    const position = i + 1;
    return {
      order: [rank, CARD_KINDS.indexOf("decision"), index],
      card: {
        id: `decision:${x.view.id}:${index}`,
        kind: "decision",
        severity: "look",
        missionId: x.view.id,
        missionTitle: x.view.title,
        fromEarlier: false,
        featureId: null,
        title: decisionTitle(concerns === null ? "question" : "concerns", position, shown.length),
        happened: concerns === null ? { text: entry, author: "ai" } : { text: concernsHappened(concerns), author: "engine" },
        summary: null,
        ifNothing: concerns === null ? CARD_TEXT.decisionIfOther : CARD_TEXT.decisionIfConcerns,
        whatToDo: null,
        tellLeader: LEADER.question(names, ref, position, shown.length),
      },
    };
  });
}

/**
 * The card of a mission that waits for the owner's check (checkpoints spec, 10). The engine's look at the work is shown line
 * by line and never parsed; every line is labelled as the AI's, because the engine's own lines and the AI's are mixed in it.
 */
function checkpointCard(x: MissionFacts, names: LeaderNames): NeedsYouCard | null {
  const mission = x.data.mission;
  const cp = mission?.checkpoint;
  const facts = x.checkpoint;
  if (mission === null || cp === undefined || facts === null || facts.state !== "pending") return null;
  const ref: MissionRef = { id: x.view.id, title: x.view.title };
  const feature = cp.kind === "feature" ? mission.features.find((f) => f.id === cp.featureId) : undefined;
  // A feature check whose feature is not in the file has no sentence that names it, so it gets no answers (the page shows no buttons).
  const what: LeaderCheck | null = cp.kind === "plan" ? { kind: "plan" } : cp.kind === "final" ? { kind: "final" } : feature === undefined ? null : { kind: "feature", feature: { id: feature.id, title: feature.title } };
  const sentBack = (mission.checkpointLog ?? []).filter((r) => r.scope === cp.scope && r.decision === "send_back").length;
  // A plan stop of a mission whose plan came in with `mc plan queue`: it stops by default, not because the owner asked to.
  const leaderPlan = cp.kind === "plan" && mission.plan !== undefined;
  // A stop at a feature checked by a second AI that the owner did not ask for: the card says why the team stopped (docs/modes-spec.md, 11.3).
  const why = cp.kind === "feature" && feature !== undefined ? lookWhy(mission, feature, sentBack) : undefined;
  return {
    id: `checkpoint:${x.view.id}:0`,
    kind: "checkpoint",
    severity: "look",
    missionId: x.view.id,
    missionTitle: x.view.title,
    fromEarlier: false,
    featureId: cp.kind === "feature" && feature !== undefined ? feature.id : null,
    title: CARD_TEXT.checkpointTitle(x.view.title, cp.kind, facts.featureTitle),
    happened: engineSays(why !== undefined ? CARD_TEXT.checkpointHappenedLook[why] : leaderPlan ? CARD_TEXT.checkpointHappenedLeaderPlan : CARD_TEXT.checkpointHappened),
    summary: checkpointSummary(cp.kind, cp.look.branch ?? null, sentBack, CHECKPOINT_SEND_BACK_CAP, leaderPlan, why !== undefined),
    ifNothing: CARD_TEXT.checkpointIfNothing,
    whatToDo: engineSays(CARD_TEXT.checkpointWhatToDo),
    tellLeader: LEADER.checkpoint(names, ref),
    ...(cp.look.lines.length > 0 && { lines: cp.look.lines.slice(0, CHECKPOINT_LINES_MAX).map((text): Said => ({ text, author: "ai" })) }),
    ...(what !== null && { answers: { approve: LEADER.approve(names, ref, what), sendBack: LEADER.sendBack(names, ref, what) } }),
  };
}

function cardsOf(x: MissionFacts, names: LeaderNames, rank: number): Draft[] {
  const { view } = x;
  const ref: MissionRef = { id: view.id, title: view.title };
  const drafts: Draft[] = [];
  const at = (kind: CardKind, index = 0): [number, number, number] => [rank, CARD_KINDS.indexOf(kind), index];

  if (view.state === "needs_you") {
    drafts.push({
      order: at("mission_failed"),
      card: missionLevel(x, {
        kind: "mission_failed",
        severity: "now",
        fromEarlier: false,
        title: CARD_TEXT.failedTitle(view.title, false),
        happened: failureReason(x),
        ifNothing: x.data.mission?.failure?.retryable === true ? CARD_TEXT.failedIfRetryable : CARD_TEXT.failedIfNot,
        whatToDo: failureWhatToDo(x),
        tellLeader: LEADER.failed(names, ref),
      }),
    });
  }
  if (x.runGone === "gone") {
    drafts.push({
      order: at("run_stopped"),
      card: missionLevel(x, {
        kind: "run_stopped",
        severity: "now",
        fromEarlier: false,
        title: CARD_TEXT.stoppedTitle(view.title),
        happened: { text: CARD_TEXT.stoppedHappened, author: "engine" },
        ifNothing: CARD_TEXT.stoppedIfNothing,
        whatToDo: engineSays(CARD_TEXT.stoppedWhatToDo),
        tellLeader: LEADER.runStopped(names, ref),
      }),
    });
  }
  const check = checkpointCard(x, names);
  if (check !== null) drafts.push({ order: at("checkpoint"), card: check });
  if (view.state === "paused" && view.pausedWhy === "disk") {
    drafts.push({
      order: at("paused_disk"),
      card: missionLevel(x, {
        kind: "paused_disk",
        severity: "look",
        fromEarlier: false,
        title: CARD_TEXT.pausedTitle(view.title),
        happened: { text: CARD_TEXT.diskHappened, author: "engine" },
        ifNothing: CARD_TEXT.diskIfNothing,
        whatToDo: engineSays(CARD_TEXT.diskWhatToDo),
        tellLeader: LEADER.paused(names, ref),
      }),
    });
  }
  if (view.state === "paused" && view.pausedWhy === "ai_failing") {
    drafts.push({
      order: at("paused_ai_failing"),
      card: missionLevel(x, {
        kind: "paused_ai_failing",
        severity: "look",
        fromEarlier: false,
        title: CARD_TEXT.pausedTitle(view.title),
        happened: { text: CARD_TEXT.aiFailingHappened, author: "engine" },
        ifNothing: CARD_TEXT.aiFailingIfNothing,
        whatToDo: null,
        tellLeader: LEADER.paused(names, ref),
      }),
    });
  }
  view.features.forEach((f, i) => {
    if (f.state !== "stuck") return;
    drafts.push({
      order: at("feature_stuck", i),
      card: {
        id: `feature_stuck:${view.id}:${f.id}`,
        kind: "feature_stuck",
        severity: "look",
        missionId: view.id,
        missionTitle: view.title,
        fromEarlier: false,
        featureId: f.id,
        title: CARD_TEXT.stuckTitle(f.title),
        happened: f.reason ?? { text: CARD_TEXT.failedFallbackReason, author: "engine" },
        summary: `${f.steps.caption}.`,
        ifNothing: stuckIfNothing(outlookOf(view.state), leftOutBecause(x, f)),
        whatToDo: null,
        tellLeader: LEADER.stuck(names, ref, f),
      },
    });
  });
  drafts.push(...decisionCards(x, names, rank));
  if (x.baselineBroken) {
    drafts.push({
      order: at("checks_failing"),
      card: missionLevel(x, {
        kind: "checks_failing",
        severity: "look",
        fromEarlier: false,
        title: CARD_TEXT.checksTitle(view.title),
        happened: { text: x.data.mission !== null && noTestsDone(x.data.mission) ? CARD_TEXT.checksHappenedByReading : CARD_TEXT.checksHappened, author: "engine" },
        ifNothing: CARD_TEXT.checksIfNothing,
        whatToDo: null,
        tellLeader: LEADER.checks(names, ref),
      }),
    });
  }
  if (view.state === "waiting" && x.wait !== null && x.wait.cause === "login") {
    drafts.push({
      order: at("login_needed"),
      card: missionLevel(x, {
        kind: "login_needed",
        severity: "look",
        fromEarlier: false,
        title: CARD_TEXT.loginTitle,
        happened: { text: loginHappened(x.wait.loginAis, x.wait.untilText), author: "engine" },
        ifNothing: CARD_TEXT.loginIfNothing,
        whatToDo: engineSays(loginWhatToDo(x.wait.loginAis)),
        tellLeader: LEADER.login(names, ref),
      }),
    });
  }
  return drafts;
}

/**
 * The cards for recent missions (red ones first), plus one amber mission_failed card for each earlier mission that
 * failed. Order: severity now first, then the missions in the order given, then the order of CARD_KINDS, then the
 * features or entries in file order.
 */
export function buildCards(m: MissionFacts[], _f?: Formatter): NeedsYouCard[] {
  const names = makeLeaderNames(m.map((x) => ({ id: x.view.id, title: x.view.title, features: x.view.features })));
  const drafts: Draft[] = [];
  m.forEach((x, rank) => {
    if (!x.view.readable) return;
    if (x.view.scope === "recent") drafts.push(...cardsOf(x, names, rank));
    else if (x.view.state === "needs_you") {
      drafts.push({
        order: [rank, CARD_KINDS.indexOf("mission_failed"), 0],
        card: missionLevel(x, {
          kind: "mission_failed",
          severity: "look",
          fromEarlier: true,
          title: CARD_TEXT.failedTitle(x.view.title, true),
          happened: failureReason(x),
          ifNothing: x.data.mission?.failure?.retryable === true ? CARD_TEXT.failedIfRetryable : CARD_TEXT.failedIfNot,
          whatToDo: failureWhatToDo(x),
          tellLeader: LEADER.failed(names, { id: x.view.id, title: x.view.title }),
        }),
      });
    }
  });
  const severity = (d: Draft): number => (d.card.severity === "now" ? 0 : 1);
  drafts.sort((a, b) => severity(a) - severity(b) || a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2]);
  return drafts.map((d) => d.card);
}

/** Points every stuck feature's tile at its card (FeatureView.cardId). */
export function attachCardIds(m: MissionFacts[], cards: NeedsYouCard[]): void {
  for (const card of cards) {
    if (card.kind !== "feature_stuck" || card.featureId === null) continue;
    const mission = m.find((x) => x.view.id === card.missionId);
    const feature = mission?.view.features.find((f) => f.id === card.featureId);
    if (feature !== undefined) feature.cardId = card.id;
  }
}
