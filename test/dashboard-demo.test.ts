// T-DEMO: the golden demo snapshots (docs/dashboard-spec.md, 14.5 and 17.2).
//
// dashboard/demo/<name>.json is built here from a named fixture with a pinned clock and the UTC time zone, so its
// words come from the same code as a real snapshot and cannot drift from it. dashboard/demo.html is dashboard/index.html
// with one data block inserted. Nothing else writes these files:
//
//   UPDATE_DEMO=1 npx vitest run test/dashboard-demo.test.ts
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clearReadCache } from "../src/dashboard/read.js";
import { buildSnapshot } from "../src/dashboard/snapshot.js";
import type { Snapshot } from "../src/dashboard/types.js";
import { assertSnapshotShape, copyHome, emptyHome, FIXTURE_MTIME_MS, FIXTURE_ROOT, touch, withLock } from "./dashboard-helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_DIR = join(ROOT, "dashboard", "demo");
const INDEX_HTML = join(ROOT, "dashboard", "index.html");
const DEMO_HTML = join(ROOT, "dashboard", "demo.html");
const UPDATE = process.env.UPDATE_DEMO === "1";

/** The capture's own clock: its events are at 09:58, and the mid-run scenarios are looked at 30 seconds in (spec 14.3). */
const MIDRUN = Date.parse("2026-10-11T09:58:30.000Z");
const FINISHED = Date.parse("2026-10-11T10:03:30.000Z");

function createdAt(home: string, mission: string): string {
  const file = join(home, "missions", mission, "mission.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { createdAt: string }).createdAt;
}

/** A run that started with the mission and last reported in 15 seconds before `now`. */
function runningSince(home: string, mission: string, now: number): void {
  withLock(home, { at: createdAt(home, mission), ageMs: 15_000, now });
}

interface Demo {
  name: string;
  /** What the demo shows (spec 14.5). */
  shows: string;
  build: () => Snapshot;
}

function snapshotOf(home: string, now: number): Snapshot {
  clearReadCache(); // the files of a fresh copy are new, but the cache is keyed by inode and size
  return buildSnapshot({ home, now, timeZone: "UTC" });
}

const DEMOS: Demo[] = [
  { name: "done", shows: "green, all done, the debrief with four ticks yes", build: () => snapshotOf(copyHome("done"), FINISHED) },
  { name: "partial-blocked", shows: "amber, one stuck feature, Not finished, two ticks not met, the caveat", build: () => snapshotOf(copyHome("partial-blocked"), FINISHED) },
  {
    name: "working-midrun",
    shows: "green, the Now line, the running time",
    build: () => {
      const home = copyHome("midrun-reviewing");
      runningSince(home, "2026-10-11-task-board", MIDRUN);
      return snapshotOf(home, MIDRUN);
    },
  },
  {
    name: "waiting-long",
    shows: "amber long wait, Codex waiting for reset",
    build: () => {
      const home = copyHome("limit-waiting");
      runningSince(home, "2026-10-11-reader", MIDRUN);
      return snapshotOf(home, MIDRUN);
    },
  },
  {
    name: "login-wait",
    shows: "amber, the login card",
    build: () => {
      const home = copyHome("login-wait");
      const folder = readdirSync(join(home, "missions"))[0] ?? "";
      runningSince(home, folder, MIDRUN);
      return snapshotOf(home, MIDRUN);
    },
  },
  { name: "failed-auth", shows: "red, one card, retryable", build: () => snapshotOf(copyHome("failed-auth"), FINISHED) },
  { name: "multi-mission", shows: "five missions, red and amber together, the Needs-you list", build: () => snapshotOf(copyHome("multi-mission"), FINISHED) },
  {
    name: "allowance-readings",
    shows: "gauges with pause ticks (synthetic readings)",
    build: () => {
      const home = copyHome("midrun-testing");
      cpSync(join(FIXTURE_ROOT, "quota-readings", "quota.json"), join(home, "quota.json"));
      touch(join(home, "quota.json"), FIXTURE_MTIME_MS);
      runningSince(home, "2026-10-11-task-board", MIDRUN);
      return snapshotOf(home, MIDRUN);
    },
  },
  { name: "idle", shows: "grey, nothing is running and nothing is queued", build: () => snapshotOf(emptyHome(), FINISHED) },
  { name: "hostile-strings", shows: "cleaned and capped strings", build: () => snapshotOf(copyHome("hostile-strings"), MIDRUN) },
];

const NAMES = DEMOS.map((d) => d.name);

/** How a snapshot is stored: the spec's JSON.stringify(snapshot, null, 2), and a newline at the end of the file. */
function goldenText(snapshot: Snapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function goldenFile(name: string): string {
  return join(DEMO_DIR, `${name}.json`);
}

/** dashboard/index.html with the data block of spec 17.2 inserted immediately before its first <script tag. */
function demoPage(index: string, snapshots: Record<string, Snapshot>): string {
  const at = index.indexOf("<script");
  if (at < 0) throw new Error("dashboard/index.html has no <script tag to put the demo data before");
  const json = JSON.stringify(snapshots).replace(/</g, "\\u003c");
  return `${index.slice(0, at)}<script type="application/json" id="mc-demo">${json}</script>\n${index.slice(at)}`;
}

const built = new Map<string, Snapshot>();
function snapshotFor(demo: Demo): Snapshot {
  let snapshot = built.get(demo.name);
  if (snapshot === undefined) {
    snapshot = demo.build();
    built.set(demo.name, snapshot);
  }
  return snapshot;
}

describe("T-DEMO the golden snapshots", () => {
  if (UPDATE) {
    it("UPDATE_DEMO=1: rewrites the golden files", () => {
      mkdirSync(DEMO_DIR, { recursive: true });
      for (const demo of DEMOS) writeFileSync(goldenFile(demo.name), goldenText(snapshotFor(demo)));
      if (existsSync(INDEX_HTML)) {
        writeFileSync(DEMO_HTML, demoPage(readFileSync(INDEX_HTML, "utf8"), Object.fromEntries(DEMOS.map((d) => [d.name, snapshotFor(d)]))));
      }
      expect(existsSync(goldenFile("done"))).toBe(true);
    });
  }

  it("has the ten demos of the spec, and no other file in dashboard/demo", () => {
    expect(NAMES).toEqual(["done", "partial-blocked", "working-midrun", "waiting-long", "login-wait", "failed-auth", "multi-mission", "allowance-readings", "idle", "hostile-strings"]);
    expect(existsSync(DEMO_DIR)).toBe(true);
    expect(readdirSync(DEMO_DIR).sort()).toEqual(NAMES.map((n) => `${n}.json`).sort());
  });

  it.each(DEMOS.map((d) => [d.name, d] as const))("%s is the snapshot of its fixture and has a valid shape", (_name, demo) => {
    const snapshot = snapshotFor(demo);
    assertSnapshotShape(snapshot);
    expect(readFileSync(goldenFile(demo.name), "utf8")).toBe(goldenText(snapshot));
  });

  const SHOWS: Record<string, (s: Snapshot) => void> = {
    done: (s) => {
      expect(s.lamp.state).toBe("on_track");
      expect(s.debrief?.missions[0]?.ticks.map((t) => t.state)).toEqual(["yes", "yes", "yes", "yes"]);
    },
    "partial-blocked": (s) => {
      expect(s.lamp.state).toBe("needs_look");
      expect(s.needsYou.map((c) => c.kind)).toEqual(["feature_stuck"]);
      expect(s.debrief?.missions[0]?.ticks.map((t) => t.state)).toEqual(["no", "yes", "no", "yes"]);
      expect(s.debrief?.missions[0]?.ticks[1]?.caveat).not.toBeNull();
    },
    "working-midrun": (s) => {
      expect(s.lamp.state).toBe("on_track");
      expect(s.now?.kind).toBe("agent");
      expect(s.run.active).toBe(true);
      expect(s.run.runningText).not.toBeNull();
    },
    "waiting-long": (s) => {
      expect(s.lamp.state).toBe("needs_look");
      expect(s.lamp.reasons.map((r) => r.code)).toContain("long_wait");
      expect(s.allowance.providers.find((p) => p.id === "codex")?.pill.state).toBe("waiting_reset");
    },
    "login-wait": (s) => {
      expect(s.lamp.reasons.map((r) => r.code)).toContain("login_needed");
      expect(s.needsYou.map((c) => c.kind)).toEqual(["login_needed"]);
    },
    "failed-auth": (s) => {
      expect(s.lamp.state).toBe("needs_you_now");
      expect(s.needsYou).toHaveLength(1);
      expect(s.needsYou[0]?.severity).toBe("now");
    },
    "multi-mission": (s) => {
      expect(s.missions).toHaveLength(5);
      expect(s.lamp.state).toBe("needs_you_now");
      expect(new Set(s.needsYou.map((c) => c.severity))).toEqual(new Set(["now", "look"]));
    },
    "allowance-readings": (s) => {
      const claude = s.allowance.providers.find((p) => p.id === "claude");
      expect(claude?.windows.map((w) => [w.id, w.pauseAt])).toEqual([["five_hour", 0.97], ["seven_day", 0.85]]);
      expect(s.lamp.state).toBe("on_track");
    },
    idle: (s) => {
      expect(s.lamp.state).toBe("idle");
      expect(s.missions).toEqual([]);
    },
    "hostile-strings": (s) => {
      expect(s.lamp.state).toBe("needs_look");
      expect(s.missions[0]?.title.length).toBeLessThanOrEqual(120);
      expect(s.needsYou.some((c) => c.happened.author === "ai")).toBe(true);
    },
  };

  it.each(DEMOS.map((d) => [d.name, d] as const))("%s shows what the spec says it shows", (name, demo) => {
    const show = SHOWS[name];
    if (show === undefined) throw new Error(`no expectation for the demo ${name}`);
    show(snapshotFor(demo));
  });

  it("the demo snapshots are built from the clock they are pinned to, not from the wall clock", () => {
    for (const demo of DEMOS) {
      const { generatedAt, generatedAtText } = snapshotFor(demo);
      expect([MIDRUN, FINISHED]).toContain(generatedAt);
      expect(generatedAtText).toBe(generatedAt === MIDRUN ? "09:58:30" : "10:03:30");
    }
  });
});

describe("T-DEMO the page with the demo data", () => {
  it.skipIf(!existsSync(INDEX_HTML))("dashboard/demo.html is dashboard/index.html with the demo block before its first script", () => {
    const expected = demoPage(readFileSync(INDEX_HTML, "utf8"), Object.fromEntries(DEMOS.map((d) => [d.name, snapshotFor(d)])));
    expect(readFileSync(DEMO_HTML, "utf8")).toBe(expected);
  });

  it.skipIf(!existsSync(INDEX_HTML))("the block holds the ten snapshots, escapes every '<', and index.html itself has no block", () => {
    const page = readFileSync(DEMO_HTML, "utf8");
    const match = /<script type="application\/json" id="mc-demo">([^]*?)<\/script>/.exec(page);
    expect(match).not.toBeNull();
    const json = match?.[1] ?? "";
    expect(json).not.toContain("<");
    expect(Object.keys(JSON.parse(json) as Record<string, unknown>)).toEqual(NAMES);
    expect(readFileSync(INDEX_HTML, "utf8")).not.toContain('id="mc-demo"');
    expect(page.indexOf('id="mc-demo"')).toBeLessThan(page.indexOf("<script", page.indexOf("</script>")));
  });

  it("demoPage puts the block immediately before the first script tag and escapes '<'", () => {
    const html = '<html><body><p>hi</p>\n<script>run()</script></body></html>';
    const page = demoPage(html, { x: { a: "</script><!--" } as unknown as Snapshot });
    expect(page).toBe('<html><body><p>hi</p>\n<script type="application/json" id="mc-demo">{"x":{"a":"\\u003c/script>\\u003c!--"}}</script>\n<script>run()</script></body></html>');
    expect(() => demoPage("<html></html>", {})).toThrow(/no <script/);
  });
});
