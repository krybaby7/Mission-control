// m3: the snapshot is bounded as a whole, not only per mission. Many missions, many questions and a very large home
// are cut at fixed caps, the cuts are counted, and what needs a look is kept first. The lamp and the counts still look
// at everything, so a cut never turns a red mission calm.
import { describe, expect, it } from "vitest";
import { assertSnapshotShape, makeEvent } from "../../test/dashboard-helpers.js";
import { buildHome, featureWith, fixtureNames, fixtureSnapshot, HOUR, iso, MID, MINUTE, missionAt, SECOND, snap } from "../../test/dashboard-kit.js";
import { MAX_CARDS_SHOWN, MAX_FEATURES_SHOWN, MAX_MISSIONS_SHOWN, MAX_SNAPSHOT_BYTES, TIMELINE_MAX_ITEMS } from "./constants.js";
import { pickFeatures } from "./missions.js";
import type { Snapshot } from "./types.js";

const bytes = (s: Snapshot): number => Buffer.byteLength(JSON.stringify(s));
const id = (i: number): string => `2026-10-11-m${String(i).padStart(3, "0")}`;

describe("the caps are named and sit where the size limit needs them", () => {
  it("are a fraction of the size limit", () => {
    expect(MAX_MISSIONS_SHOWN).toBe(30);
    expect(MAX_CARDS_SHOWN).toBe(50);
    expect(MAX_SNAPSHOT_BYTES).toBe(200 * 1024);
  });
});

describe("a normal home is never cut", () => {
  it.each(fixtureNames())("%s", (name) => {
    const s = fixtureSnapshot(name);
    expect([s.counts.missionsNotShown, s.counts.cardsNotShown]).toEqual([0, 0]);
  });
});

describe("pickFeatures", () => {
  const list = [
    featureWith("d1", "done"),
    featureWith("p1", "pending"),
    featureWith("b1", "blocked", { blockedReason: "x" }),
    featureWith("d2", "done"),
    featureWith("w1", "building"),
    featureWith("s1", "skipped"),
    featureWith("u1", "hibernating" as never),
    featureWith("d3", "done"),
  ];

  it("keeps everything up to the cap, in the file order", () => {
    expect(pickFeatures(list, 8)).toBe(list);
    expect(pickFeatures(list, 99)).toBe(list);
  });

  it("over the cap keeps stuck, left-out and unknown first, then the one in progress, then waiting, then done, in the file order", () => {
    expect(pickFeatures(list, 3).map((f) => f.id)).toEqual(["b1", "s1", "u1"]);
    expect(pickFeatures(list, 4).map((f) => f.id)).toEqual(["b1", "w1", "s1", "u1"]);
    expect(pickFeatures(list, 5).map((f) => f.id)).toEqual(["p1", "b1", "w1", "s1", "u1"]);
    expect(pickFeatures(list, 6).map((f) => f.id)).toEqual(["d1", "p1", "b1", "w1", "s1", "u1"]);
    expect(pickFeatures(list, 0)).toEqual([]);
  });
});

describe("more missions than MAX_MISSIONS_SHOWN", () => {
  const total = MAX_MISSIONS_SHOWN + 10;

  function many(failed: number[]): Snapshot {
    const missions = Array.from({ length: total }, (_, i) => ({
      mission: missionAt(MID, id(i), {
        title: `Mission ${i}`,
        createdAt: iso(MID - (total - i) * MINUTE - 3 * HOUR),
        ...(failed.includes(i) ? { status: "failed" as const, failure: { reason: "The moon was in the wrong phase.", retryable: false } } : { status: "done" as const, stage: "complete" as const, features: [featureWith("a", "done")] }),
      }),
    }));
    return snap(buildHome({ missions }, MID), MID);
  }

  it("lists MAX_MISSIONS_SHOWN, counts the rest, and keeps the missions that need a look", () => {
    const failed = [total - 1, total - 2, total - 3, total - 4];
    const s = many(failed);
    expect(s.missions).toHaveLength(MAX_MISSIONS_SHOWN);
    expect(s.counts.missionsNotShown).toBe(10);
    expect(s.counts.recentMissions).toBe(total);
    expect(s.counts.cardsNotShown).toBe(0);
    for (const i of failed) expect(s.missions.map((m) => m.id)).toContain(id(i));
    expect(s.needsYou.map((c) => c.kind)).toEqual(["mission_failed", "mission_failed", "mission_failed", "mission_failed"]);
    // The listed missions stay in their own order, oldest first.
    expect(s.missions.map((m) => m.id)).toEqual([...s.missions.map((m) => m.id)].sort());
  });

  it("the lamp still looks at every mission, so a cut never makes a red mission calm", () => {
    const s = many([total - 1]);
    expect(s.lamp).toMatchObject({ state: "needs_you_now", sentence: "“Mission 39” needs your help." });
    expect(s.missions.map((m) => m.title)).toContain("Mission 39");
  });

  it("the lamp also sees the missions that are not listed", () => {
    // 35 finished missions, then 5 stopped ones with work left. The stopped ones have no card and are the last in
    // the order, so they are not listed, but "work is waiting for the next run" still reaches the lamp.
    const finished = Array.from({ length: 35 }, (_, i) => ({ mission: missionAt(MID, id(i), { createdAt: iso(MID - (60 - i) * MINUTE - 3 * HOUR), status: "done", stage: "complete", features: [featureWith("a", "done")] }) }));
    const stopped = Array.from({ length: 5 }, (_, i) => {
      const m = missionAt(MID, id(35 + i), { createdAt: iso(MID - (20 - i) * MINUTE - 3 * HOUR), status: "stopped", stage: "features", features: [featureWith("a", "done"), featureWith("b", "pending")] });
      return { mission: m, events: [makeEvent(m.id, MID - 30 * SECOND, "mission.stopped", { stage: "features", reason: "stop requested" })] };
    });
    const s = snap(buildHome({ missions: [...finished, ...stopped] }, MID), MID);
    expect(s.missions).toHaveLength(MAX_MISSIONS_SHOWN);
    expect(s.missions.some((m) => m.state === "paused")).toBe(false);
    expect(s.counts.missionsNotShown).toBe(10);
    expect(s.lamp.reasons.map((r) => r.code)).toEqual(["paused_unbuilt"]);
    expect(s.lamp.sentence).toBe("5 of 10 features are waiting for the next run.");
  });

  it("nothing is cut at exactly MAX_MISSIONS_SHOWN", () => {
    const missions = Array.from({ length: MAX_MISSIONS_SHOWN }, (_, i) => ({ mission: missionAt(MID, id(i), { status: "done", stage: "complete", features: [featureWith("a", "done")] }) }));
    const s = snap(buildHome({ missions }, MID), MID);
    expect(s.missions).toHaveLength(MAX_MISSIONS_SHOWN);
    expect(s.counts.missionsNotShown).toBe(0);
  });

  it("the mission the run is working on is listed, whatever its place in the order", () => {
    const missions = Array.from({ length: total }, (_, i) => ({
      mission: missionAt(MID, id(i), { title: `Mission ${i}`, createdAt: iso(MID - (total - i) * MINUTE - 3 * HOUR), status: i === total - 1 ? "running" : "done", stage: i === total - 1 ? "features" : "complete", features: [featureWith("a", i === total - 1 ? "building" : "done")] }),
      events: i === total - 1 ? [makeEvent(id(i), MID - 5 * SECOND, "run.start", { label: "build-a", jobId: "build-a-1", role: "engineer" })] : [],
    }));
    const s = snap(buildHome({ missions, lock: { at: iso(MID - 10 * MINUTE) } }, MID), MID);
    expect(s.now?.missionId).toBe(id(total - 1));
    expect(s.missions.map((m) => m.id)).toContain(id(total - 1));
  });
});

describe("more cards than MAX_CARDS_SHOWN", () => {
  function questions(perMission: number, missionCount: number, extra: ReturnType<typeof missionAt>[] = []): Snapshot {
    const missions = Array.from({ length: missionCount }, (_, i) => ({
      mission: missionAt(MID, id(i), { title: `Mission ${i}`, status: "partial", stage: "complete", features: [featureWith("a", "done")], decisionsNeeded: Array.from({ length: perMission }, (_, k) => `Question ${k} of mission ${i}?`) }),
    }));
    return snap(buildHome({ missions: [...missions, ...extra.map((mission) => ({ mission }))] }, MID), MID);
  }

  it("lists MAX_CARDS_SHOWN and counts the rest", () => {
    const s = questions(30, 3);
    expect(s.needsYou).toHaveLength(MAX_CARDS_SHOWN);
    expect(s.counts.cardsNotShown).toBe(90 - MAX_CARDS_SHOWN);
    expect(s.counts.questions).toBe(90);
    expect(s.lamp.sentence).toContain("90 questions are waiting for you");
  });

  it("red cards come first, so a failed mission is never the card that is cut", () => {
    const failed = missionAt(MID, id(9), { title: "Failed one", status: "failed", failure: { reason: "The moon was in the wrong phase.", retryable: false } });
    const s = questions(30, 3, [failed]);
    expect(s.needsYou[0]).toMatchObject({ kind: "mission_failed", severity: "now" });
    expect(s.needsYou).toHaveLength(MAX_CARDS_SHOWN);
  });

  it("the debrief's Nothing open tick counts every open item, also the cards that were cut", () => {
    const s = questions(30, 3);
    // The first 50 of the 90 cards are listed: all of mission 0's and 20 of mission 1's. None of mission 2's is.
    const listed = (missionIndex: number): number => s.needsYou.filter((c) => c.missionId === id(missionIndex)).length;
    expect([listed(0), listed(1), listed(2)]).toEqual([30, 20, 0]);
    for (const i of [0, 1, 2]) {
      const tick = s.debrief?.missions[i]?.ticks.find((t) => t.id === "nothing_open");
      expect(tick, `mission ${i}`).toMatchObject({ state: "no", why: "30 items are waiting for you." });
    }
  });

  it("a mission whose question cards were all cut is still explained by them: the lamp does not call it 'finished partly done' (L14)", () => {
    const s = questions(30, 3);
    expect(s.lamp.reasons.map((r) => r.code)).toEqual(["decision_waiting"]);
    expect(s.lamp.sentence).toBe("90 questions are waiting for you.");
  });

  it("is not cut at exactly MAX_CARDS_SHOWN", () => {
    const s = questions(MAX_CARDS_SHOWN, 1);
    expect(s.needsYou).toHaveLength(MAX_CARDS_SHOWN);
    expect(s.counts.cardsNotShown).toBe(0);
  });

  it("every feature's card link points at a card that is listed", () => {
    // 60 stuck features in one mission: 60 cards, 50 listed. A tile whose card was cut must not point at it.
    const features = Array.from({ length: 60 }, (_, i) => featureWith(`f${String(i).padStart(2, "0")}`, "blocked", { blockedReason: `needs a choice ${i}` }));
    const s = snap(buildHome({ missions: [{ mission: missionAt(MID, id(0), { status: "partial", stage: "complete", features }) }] }, MID), MID);
    assertSnapshotShape(s);
    const cardIds = new Set(s.needsYou.map((c) => c.id));
    expect(s.needsYou).toHaveLength(MAX_CARDS_SHOWN);
    const linked = s.missions[0]?.features.filter((f) => f.cardId !== null) ?? [];
    expect(linked).toHaveLength(MAX_CARDS_SHOWN);
    for (const f of linked) expect(cardIds.has(f.cardId ?? "")).toBe(true);
    expect(s.counts.stuckFeatures).toBe(60);
  });
});

describe("the whole snapshot stays under MAX_SNAPSHOT_BYTES", () => {
  const long = (n: number, c: string): string => c.repeat(n);

  /** `count` missions, each with 130 features (every third one, from the third, stuck, with long reasons), 60 long questions and 80 long events. */
  function hugeHome(count: number, ch: { title: string; text: string }): string {
    const missions = Array.from({ length: count }, (_, i) => {
      const features = Array.from({ length: 130 }, (_, j) =>
        featureWith(`f${j}`, j % 3 === 2 ? "blocked" : j % 3 === 0 ? "done" : "pending", {
          title: `${long(110, ch.title)}${j}`,
          ...(j % 3 === 2 && { blockedReason: `${long(390, ch.text)}${j}` }),
          story: long(390, ch.text),
        }),
      );
      const mission = missionAt(MID, id(i), { title: `${long(115, ch.title)}${i}`, status: "partial", stage: "complete", features, decisionsNeeded: Array.from({ length: 60 }, (_, k) => `${long(590, ch.text)}${k}`) });
      const events = Array.from({ length: 80 }, (_, k) => makeEvent(id(i), MID - (k + 1) * MINUTE, "feature.status", { feature: `f${(k * 3 + 2) % 130}`, to: "blocked", reason: `${long(390, ch.text)}${k}` }));
      return { mission, events };
    });
    return buildHome({ missions }, MID);
  }

  it.each([
    ["plain letters", { title: "T", text: "r" }],
    ["three-byte characters (every character is three bytes in the JSON)", { title: String.fromCodePoint(0x65e5), text: String.fromCodePoint(0x672c) }],
  ])("a huge home of %s is cut to fit, and the cuts are counted", (_name, ch) => {
    const s = snap(hugeHome(MAX_MISSIONS_SHOWN + 5, ch), MID);
    expect(bytes(s)).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    assertSnapshotShape(s);
    // Everything is still counted: the lamp and the counts looked at the whole home.
    expect(s.counts.recentMissions).toBe(MAX_MISSIONS_SHOWN + 5);
    expect(s.counts.missionsNotShown).toBeGreaterThanOrEqual(5);
    expect(s.counts.stuckFeatures).toBeGreaterThan(0);
    expect(s.lamp.state).toBe("needs_look");
    expect(s.missions.every((m) => m.featuresTotal === 130)).toBe(true);
    // What needs a look is what stayed: when a mission lists fewer features than it has, the stuck ones are listed first.
    for (const m of s.missions) {
      if (m.features.length < m.featuresTotal) expect(m.features.filter((f) => f.state === "stuck")).toHaveLength(Math.min(43, m.features.length));
    }
  });

  it("each later try keeps less, down to one mission with one card, and never throws", () => {
    const home = hugeHome(MAX_MISSIONS_SHOWN + 5, { title: "T", text: "r" });
    const limits = [190_000, 120_000, 60_000, 30_000, 12_000, 5_000, 1];
    const snaps = limits.map((maxBytes) => {
      const s = snap(home, MID, { maxBytes });
      assertSnapshotShape(s);
      return s;
    });
    const results = snaps.map((s) => ({ size: bytes(s), missions: s.missions.length, cards: s.needsYou.length }));
    // The limit is met whenever some try can meet it, and the tries keep less and less.
    results.forEach((r, i) => i < 5 && expect(r.size, `${limits[i]} bytes`).toBeLessThanOrEqual(limits[i] as number));
    results.forEach((r, i) => i > 0 && expect(r.size).toBeLessThanOrEqual((results[i - 1] as { size: number }).size));
    // The lists get shorter with every limit, never longer, and the normal try stays within the caps.
    results.forEach((r, i) => {
      if (i === 0) return;
      const before = results[i - 1] as { missions: number; cards: number };
      expect(r.missions).toBeLessThanOrEqual(before.missions);
      expect(r.cards).toBeLessThanOrEqual(before.cards);
    });
    expect(results[0]?.missions).toBeLessThanOrEqual(MAX_MISSIONS_SHOWN);
    expect(results[0]?.cards).toBeLessThanOrEqual(MAX_CARDS_SHOWN);
    expect(results[3]?.missions).toBeLessThanOrEqual(8);
    // 12 000 bytes need one mission and one card, and a limit nothing can meet gives that smallest try too.
    expect(results.slice(4).map((r) => [r.missions, r.cards])).toEqual([
      [1, 1],
      [1, 1],
      [1, 1],
    ]);
    // A limit nothing can meet gives the smallest try, which is still a valid snapshot.
    expect((results.at(-1) as { size: number }).size).toBeGreaterThan(5_000);
    // Making the output smaller never changes what the lamp and the counts say: they are made from the whole home.
    const [first] = snaps as [Snapshot];
    const total = first.counts.cardsNotShown + first.needsYou.length;
    for (const s of snaps) {
      expect(s.lamp).toEqual(first.lamp);
      expect({ ...s.counts, missionsNotShown: 0, cardsNotShown: 0 }).toEqual({ ...first.counts, missionsNotShown: 0, cardsNotShown: 0 });
      expect(s.counts.missionsNotShown).toBe(MAX_MISSIONS_SHOWN + 5 - s.missions.length);
      expect(s.counts.cardsNotShown).toBe(total - s.needsYou.length);
    }
    expect(first.counts.stuckFeatures).toBe(35 * 43);
    expect(first.counts.questions).toBe(35 * 50);
    expect(first.lamp.sentence).toContain("1505 features are stuck");
  });

  it("a smaller try lists fewer features, the stuck ones first, but featuresTotal stays and so do the stuck cards", () => {
    const home = hugeHome(3, { title: "T", text: "r" });
    const full = snap(home, MID);
    const small = snap(home, MID, { maxBytes: 20_000 });
    assertSnapshotShape(small);
    expect(full.missions[0]?.features.length).toBeGreaterThan(small.missions[0]?.features.length ?? 0);
    for (const m of small.missions) {
      expect(m.featuresTotal).toBe(130);
      expect(m.features.length).toBeLessThan(130);
      expect(m.features.filter((f) => f.state === "stuck")).toHaveLength(Math.min(43, m.features.length));
      // The file order is kept: the listed features are in the order of the file.
      const ids = m.features.map((f) => Number(f.id.slice(1)));
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    }
    expect(small.counts.stuckFeatures).toBe(full.counts.stuckFeatures);
    expect(small.needsYou.map((c) => c.kind)).toEqual(full.needsYou.slice(0, small.needsYou.length).map((c) => c.kind));
    // The debrief keeps its verdict and ticks, and the cut lists are the first of the full ones.
    expect(small.debrief?.verdict).toEqual(full.debrief?.verdict);
    expect(small.debrief?.missions.map((d) => d.ticks)).toEqual(full.debrief?.missions.map((d) => d.ticks));
    for (const [i, d] of (small.debrief?.missions ?? []).entries()) expect(d.got.length).toBeLessThanOrEqual((full.debrief?.missions[i]?.got.length ?? 0));
  });

  it("a normal home is not trimmed: all features and the whole timeline stay", () => {
    const features = Array.from({ length: MAX_FEATURES_SHOWN }, (_, j) => featureWith(`f${j}`, "done"));
    const events = Array.from({ length: TIMELINE_MAX_ITEMS + 5 }, (_, k) => makeEvent(id(0), MID - (k + 1) * MINUTE, "merge", { feature: `f${k}` }));
    const s = snap(buildHome({ missions: [{ mission: missionAt(MID, id(0), { status: "done", stage: "complete", features }), events }] }, MID), MID);
    expect(s.missions[0]?.features).toHaveLength(MAX_FEATURES_SHOWN);
    expect(s.timeline.items).toHaveLength(TIMELINE_MAX_ITEMS);
    expect(s.timeline.earlierNotShown).toBe(5);
    expect(bytes(s)).toBeLessThan(MAX_SNAPSHOT_BYTES);
  });
});
