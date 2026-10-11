// Every threshold and cap of the dashboard, named once (docs/dashboard-spec.md, 5.1). The lamp rules, the readers and
// the server import these; no other file of src/dashboard holds a bare threshold.

// ───────────── The page and the server ─────────────

/** How often the page asks for a new snapshot (3 to 5 s as decided). Sent in `freshness.pollEveryMs`. */
export const POLL_INTERVAL_MS = 4_000;
/** After this long without an answer the page shows "Not updating". */
export const PAGE_STALE_AFTER_MS = 30_000;
/** After this long the page shows the lamp "Not responding" and greys the content. */
export const PAGE_NOT_RESPONDING_AFTER_MS = 300_000;
/** A snapshot is built at most once in this time; concurrent requests share one build. */
export const SNAPSHOT_CACHE_MS = 1_500;
export const DEFAULT_PORT = 8787;

// ───────────── The run lock ─────────────

/** Two missed beats of the engine's 60 s heartbeat (`LOCK_HEARTBEAT_MS` in src/state.ts). Under this the lock is fresh. */
export const LOCK_FRESH_MS = 120_000;
/** The engine's own number for a holder in another container (`FOREIGN_LOCK_TTL_MS`). At this age the holder is gone. */
export const LOCK_STALE_MS = 300_000;
/** After a run disappears the lamp is amber (not red) for this long after the mission was last saved, so it never flashes red for one poll. */
export const RUN_GONE_GRACE_MS = 60_000;
/** Longer than the 45-minute agent time-out: a live run with no activity for this long is "quiet". */
export const QUIET_ACTIVITY_MS = 3_000_000;
/** Fuel that will not return for longer than this is amber. */
export const LONG_WAIT_MS = 3_600_000;
/** After a wait ends the next `run.start` follows within seconds; later than this a `waiting` mission with no newer `run.start` is not asleep. */
export const WAIT_OVER_GRACE_MS = 120_000;
/** A run that has been live this long and has not touched a saved busy mission is not working on it. */
export const STALE_BUSY_AFTER_MS = 120_000;
/** The engine's `WAIT_MARGIN_MS` (src/executor.ts:29, not exported, so copied; a test compares the number). */
export const WAIT_MARGIN_MS = 45_000;
/**
 * A mission is recent when it was saved within this long (24 hours), or when a live run still has work for it. A day is
 * longer than the 18 hours the engine allows for a stop time (src/run.ts), so the work of one run is never cut in two.
 */
export const RECENT_WINDOW_MS = 86_400_000;
/**
 * A wait, reset or change time 6 days or more from the snapshot is worded with its date ("Mon 19 Oct 10:03"). A weekday
 * alone ("Mon 10:03") repeats every week, and a limit can reset up to 8 days ahead (src/quota.ts).
 */
export const DATE_FORM_AFTER_MS = 518_400_000;

// ───────────── Allowance ─────────────

export const PILL_GETTING_LOW = 0.7;
export const PILL_NEARLY_OUT = 0.9;
/** The latest time (and the earliest, negated) a JavaScript date can hold. Beyond it Intl.DateTimeFormat throws. */
export const MAX_TIME_MS = 8.64e15;
/** The highest utilization reading believed: 1000 is 100 000 percent. A reading beyond it is a file in the wrong unit. */
export const MAX_UTILIZATION = 1_000;

// ───────────── Sizes and caps ─────────────

export const TIMELINE_MAX_ITEMS = 60;
export const TITLE_MAX_CHARS = 120;
export const ID_MAX_CHARS = 80;
export const REASON_MAX_CHARS = 400;
export const DECISION_MAX_CHARS = 600;
export const NOTE_MAX_CHARS = 300;

const MIB = 1024 * 1024;
export const MAX_MISSION_BYTES = 8 * MIB;
export const MAX_DISPATCH_BYTES = 4 * MIB;
export const MAX_EVENTS_BYTES = 8 * MIB;
/** An `events.jsonl` over MAX_EVENTS_BYTES is read from its last this-many bytes only. */
export const EVENTS_TAIL_BYTES = 2 * MIB;
export const MAX_QUOTA_BYTES = 1 * MIB;
export const MAX_USAGE_BYTES = 32 * MIB;
/** The mission lock file is tiny; anything bigger is not a lock. */
export const MAX_LOCK_BYTES = 64 * 1024;

/** Caps for the values read from an event (the translation table names a few short keys). */
export const EVENT_FIELD_MAX_CHARS = 200;
/** A wait reason lists up to one part per AI; a part may quote the AI's own failure text. */
export const EVENT_REASON_MAX_CHARS = 1_000;
export const EVENT_LIST_MAX_ITEMS = 1_000;

export const MAX_MISSION_FOLDERS = 500;
export const MAX_FEATURES_SHOWN = 100;
export const MAX_DECISIONS_SHOWN = 50;
/** At most this many missions are listed in the snapshot (the lamp and the counts still cover all of them). */
export const MAX_MISSIONS_SHOWN = 30;
/** At most this many Needs-you cards are listed (red ones first). */
export const MAX_CARDS_SHOWN = 50;

/** The snapshot JSON stays under this size (the shape check asserts it). */
export const MAX_SNAPSHOT_BYTES = 200 * 1024;
