// Clocks: the real one, and a manually advanced fake for deterministic tests.
import { setTimeout as delay } from "node:timers/promises";
import type { Clock } from "../types.js";

/** setTimeout silently turns larger delays into 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** FakeClock's default start: a fixed instant so tests are deterministic. */
export const FAKE_CLOCK_DEFAULT_START_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export const systemClock: Clock = {
  now: () => Date.now(),
  // node:timers/promises rejects with an Error named "AbortError" when the signal fires.
  sleep: async (ms, signal) => {
    if (Number.isNaN(ms)) throw nanDurationError();
    // Infinity waits as long as a timer can (~24.8 days), i.e. until aborted in practice.
    await delay(Math.min(Math.max(ms, 0), MAX_TIMER_MS), undefined, { signal });
  },
};

/** A NaN duration is a caller bug (e.g. arithmetic on an unparsed date); both clocks reject it the same way. */
function nanDurationError(): RangeError {
  return new RangeError("sleep: ms must be a number, got NaN");
}

interface Sleeper {
  deadline: number;
  seq: number;
  wake(): void;
}

/** A clock that only moves when advance() is called. */
export class FakeClock implements Clock {
  private current: number;
  private sleepers: Sleeper[] = [];
  private nextSeq = 0;

  constructor(startMs: number = FAKE_CLOCK_DEFAULT_START_MS) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  /** Resolves once advance() reaches now()+ms. A non-positive ms resolves immediately; NaN rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (Number.isNaN(ms)) return Promise.reject(nanDurationError());
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.sleepers = this.sleepers.filter((s) => s !== sleeper);
        reject(abortError(signal));
      };
      const sleeper: Sleeper = {
        deadline: this.current + ms,
        seq: this.nextSeq++,
        wake: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.sleepers.push(sleeper);
    });
  }

  /**
   * Moves time forward by ms. Due sleepers wake one at a time in deadline order (ties: first
   * registered first), with now() set to each one's deadline, and the code they resume runs
   * before the next wakes, so sleeps it schedules inside the window also fire.
   */
  async advance(ms: number): Promise<void> {
    if (!(ms >= 0)) throw new RangeError(`FakeClock.advance: ms must be >= 0, got ${ms}`);
    const target = this.current + ms;
    for (let next = this.nextDue(target); next; next = this.nextDue(target)) {
      this.sleepers = this.sleepers.filter((s) => s !== next);
      this.current = Math.max(this.current, next.deadline);
      next.wake();
      await drainMicrotasks();
    }
    this.current = target;
    await drainMicrotasks();
  }

  pendingSleeps(): number {
    return this.sleepers.length;
  }

  private nextDue(target: number): Sleeper | undefined {
    let best: Sleeper | undefined;
    for (const s of this.sleepers) {
      if (s.deadline > target) continue;
      if (!best || s.deadline < best.deadline || (s.deadline === best.deadline && s.seq < best.seq)) best = s;
    }
    return best;
  }
}

/** The microtask queue is fully drained before the next macrotask (setImmediate) runs. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function abortError(signal?: AbortSignal): Error {
  const err = new Error("The operation was aborted", { cause: signal?.reason });
  err.name = "AbortError";
  return err;
}
