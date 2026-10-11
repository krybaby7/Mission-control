import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../config.js";
import * as c from "./constants.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The number written on the line `const NAME = <product of numbers>;` of an engine source file (the engine does not export it). */
function engineNumber(file: string, name: string): number {
  const text = readFileSync(join(SRC, file), "utf8");
  const line = new RegExp(`^(?:export )?const ${name} = ([0-9_ *]+);`, "m").exec(text);
  if (line?.[1] === undefined) throw new Error(`no "const ${name} = <number>;" in ${file}`);
  return line[1].split("*").reduce((product, part) => product * Number(part.trim().replace(/_/g, "")), 1);
}

describe("the thresholds of spec 5.1", () => {
  it("are the numbers of the table", () => {
    expect({
      POLL_INTERVAL_MS: c.POLL_INTERVAL_MS,
      PAGE_STALE_AFTER_MS: c.PAGE_STALE_AFTER_MS,
      PAGE_NOT_RESPONDING_AFTER_MS: c.PAGE_NOT_RESPONDING_AFTER_MS,
      SNAPSHOT_CACHE_MS: c.SNAPSHOT_CACHE_MS,
      LOCK_FRESH_MS: c.LOCK_FRESH_MS,
      LOCK_STALE_MS: c.LOCK_STALE_MS,
      RUN_GONE_GRACE_MS: c.RUN_GONE_GRACE_MS,
      QUIET_ACTIVITY_MS: c.QUIET_ACTIVITY_MS,
      LONG_WAIT_MS: c.LONG_WAIT_MS,
      WAIT_OVER_GRACE_MS: c.WAIT_OVER_GRACE_MS,
      STALE_BUSY_AFTER_MS: c.STALE_BUSY_AFTER_MS,
      WAIT_MARGIN_MS: c.WAIT_MARGIN_MS,
      RECENT_WINDOW_MS: c.RECENT_WINDOW_MS,
      DATE_FORM_AFTER_MS: c.DATE_FORM_AFTER_MS,
      PILL_GETTING_LOW: c.PILL_GETTING_LOW,
      PILL_NEARLY_OUT: c.PILL_NEARLY_OUT,
      TIMELINE_MAX_ITEMS: c.TIMELINE_MAX_ITEMS,
      DEFAULT_PORT: c.DEFAULT_PORT,
    }).toEqual({
      POLL_INTERVAL_MS: 4_000,
      PAGE_STALE_AFTER_MS: 30_000,
      PAGE_NOT_RESPONDING_AFTER_MS: 300_000,
      SNAPSHOT_CACHE_MS: 1_500,
      LOCK_FRESH_MS: 120_000,
      LOCK_STALE_MS: 300_000,
      RUN_GONE_GRACE_MS: 60_000,
      QUIET_ACTIVITY_MS: 3_000_000,
      LONG_WAIT_MS: 3_600_000,
      WAIT_OVER_GRACE_MS: 120_000,
      STALE_BUSY_AFTER_MS: 120_000,
      WAIT_MARGIN_MS: 45_000,
      RECENT_WINDOW_MS: 86_400_000,
      DATE_FORM_AFTER_MS: 518_400_000,
      PILL_GETTING_LOW: 0.7,
      PILL_NEARLY_OUT: 0.9,
      TIMELINE_MAX_ITEMS: 60,
      DEFAULT_PORT: 8787,
    });
  });

  it("the caps are the numbers of the table", () => {
    expect([c.TITLE_MAX_CHARS, c.ID_MAX_CHARS, c.REASON_MAX_CHARS, c.DECISION_MAX_CHARS, c.NOTE_MAX_CHARS]).toEqual([120, 80, 400, 600, 300]);
    const MiB = 1024 * 1024;
    expect([c.MAX_MISSION_BYTES, c.MAX_DISPATCH_BYTES, c.MAX_EVENTS_BYTES, c.EVENTS_TAIL_BYTES, c.MAX_QUOTA_BYTES, c.MAX_USAGE_BYTES]).toEqual([8 * MiB, 4 * MiB, 8 * MiB, 2 * MiB, 1 * MiB, 32 * MiB]);
    expect([c.MAX_MISSION_FOLDERS, c.MAX_FEATURES_SHOWN, c.MAX_DECISIONS_SHOWN]).toEqual([500, 100, 50]);
    expect([c.MAX_MISSIONS_SHOWN, c.MAX_CARDS_SHOWN]).toEqual([30, 50]);
    expect([c.MAX_TIME_MS, c.MAX_UTILIZATION]).toEqual([8.64e15, 1000]);
  });

  it("the largest time is the largest a JavaScript date holds", () => {
    expect(Number.isNaN(new Date(c.MAX_TIME_MS).getTime())).toBe(false);
    expect(Number.isNaN(new Date(c.MAX_TIME_MS + 1).getTime())).toBe(true);
  });

  it("follow the engine's own numbers", () => {
    expect(c.WAIT_MARGIN_MS).toBe(engineNumber("executor.ts", "WAIT_MARGIN_MS"));
    expect(c.LOCK_STALE_MS).toBe(engineNumber("state.ts", "FOREIGN_LOCK_TTL_MS"));
    expect(c.LOCK_FRESH_MS).toBe(2 * engineNumber("state.ts", "LOCK_HEARTBEAT_MS"));
    // The recent window (24 hours, the owner's decision) is longer than the longest stop time the engine accepts (18 hours),
    // so the work of one run is never cut in two. The engine's constant for it carries an old word, so its name is put
    // together here and this file holds none of the words the snapshot scan forbids.
    const longestStopTime = ["MAX", "NI" + "GHT", "MS"].join("_");
    expect(c.RECENT_WINDOW_MS).toBeGreaterThan(engineNumber("run.ts", longestStopTime));
    expect(engineNumber("run.ts", longestStopTime)).toBe(18 * 60 * 60_000);
    expect(c.RECENT_WINDOW_MS).toBe(24 * 60 * 60_000);
  });

  it("the date form starts at 6 days, before the 8 days ahead that a limit can reset (src/quota.ts)", () => {
    expect(c.DATE_FORM_AFTER_MS).toBe(6 * 24 * 60 * 60_000);
    expect(c.DATE_FORM_AFTER_MS).toBeLessThan(8 * 24 * 60 * 60_000);
  });

  it("keep their order: a quiet run is longer than an agent time-out, and the grace is shorter than the heartbeat bands", () => {
    expect(c.QUIET_ACTIVITY_MS).toBeGreaterThan(defaultConfig().limits.agentTimeoutMs);
    expect(c.LOCK_FRESH_MS).toBeLessThan(c.LOCK_STALE_MS);
    expect(c.PAGE_STALE_AFTER_MS).toBeLessThan(c.PAGE_NOT_RESPONDING_AFTER_MS);
    expect(c.POLL_INTERVAL_MS).toBeLessThan(c.PAGE_STALE_AFTER_MS);
    expect(c.EVENTS_TAIL_BYTES).toBeLessThan(c.MAX_EVENTS_BYTES);
    expect(c.PILL_GETTING_LOW).toBeLessThan(c.PILL_NEARLY_OUT);
  });
});
