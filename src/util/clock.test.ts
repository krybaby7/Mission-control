import { describe, expect, it } from "vitest";
import { FAKE_CLOCK_DEFAULT_START_MS, FakeClock, systemClock } from "./clock.js";

describe("systemClock", () => {
  it("reports the current time", () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("sleeps for roughly the requested time", async () => {
    const started = Date.now();
    await systemClock.sleep(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it("resolves immediately-ish for zero and negative durations", async () => {
    await expect(systemClock.sleep(0)).resolves.toBeUndefined();
    await expect(systemClock.sleep(-5)).resolves.toBeUndefined();
  });

  it("rejects with an AbortError when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(systemClock.sleep(10_000, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects a NaN duration with a RangeError instead of sleeping for weeks", async () => {
    await expect(systemClock.sleep(Number.NaN)).rejects.toBeInstanceOf(RangeError);
  });

  it("treats an infinite duration as 'until aborted'", async () => {
    const ac = new AbortController();
    const sleeping = systemClock.sleep(Number.POSITIVE_INFINITY, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await expect(sleeping).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with an AbortError when aborted mid-sleep", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const sleeping = systemClock.sleep(10_000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    const err = await sleeping.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("FakeClock", () => {
  it("starts at a fixed default or the given time", () => {
    expect(new FakeClock().now()).toBe(FAKE_CLOCK_DEFAULT_START_MS);
    expect(new FakeClock(1234).now()).toBe(1234);
  });

  it("only moves time on advance", async () => {
    const clock = new FakeClock(0);
    await clock.advance(500);
    expect(clock.now()).toBe(500);
    await clock.advance(0);
    expect(clock.now()).toBe(500);
  });

  it("resolves a sleep only once advance passes its deadline", async () => {
    const clock = new FakeClock(0);
    let woke = false;
    void clock.sleep(1000).then(() => {
      woke = true;
    });
    expect(clock.pendingSleeps()).toBe(1);
    await clock.advance(999);
    expect(woke).toBe(false);
    await clock.advance(1);
    expect(woke).toBe(true);
    expect(clock.pendingSleeps()).toBe(0);
  });

  it("wakes sleepers in deadline order (ties by registration) with now() at each deadline", async () => {
    const clock = new FakeClock(0);
    const seen: string[] = [];
    const sleepAs = (name: string, ms: number) => clock.sleep(ms).then(() => seen.push(`${name}@${clock.now()}`));
    void sleepAs("c", 300);
    void sleepAs("a", 100);
    void sleepAs("b1", 200);
    void sleepAs("b2", 200);
    await clock.advance(1000);
    expect(seen).toEqual(["a@100", "b1@200", "b2@200", "c@300"]);
    expect(clock.now()).toBe(1000);
  });

  it("also fires sleeps scheduled by woken code inside the same window", async () => {
    const clock = new FakeClock(0);
    const ticks: number[] = [];
    const loop = async () => {
      for (let i = 0; i < 3; i++) {
        await clock.sleep(100);
        ticks.push(clock.now());
      }
    };
    const done = loop();
    await clock.advance(250);
    expect(ticks).toEqual([100, 200]);
    await clock.advance(50);
    await done;
    expect(ticks).toEqual([100, 200, 300]);
  });

  it("lets awaiting code run before advance returns", async () => {
    const clock = new FakeClock(0);
    let finished = false;
    void (async () => {
      await clock.sleep(10);
      await Promise.resolve();
      await new Promise<void>((r) => queueMicrotask(r));
      await Promise.resolve();
      finished = true;
    })();
    await clock.advance(10);
    expect(finished).toBe(true);
  });

  it("resolves non-positive sleeps immediately without registering them", async () => {
    const clock = new FakeClock(0);
    await expect(clock.sleep(0)).resolves.toBeUndefined();
    await expect(clock.sleep(-10)).resolves.toBeUndefined();
    expect(clock.pendingSleeps()).toBe(0);
  });

  it("rejects a NaN duration with a RangeError, like systemClock", async () => {
    const clock = new FakeClock(0);
    await expect(clock.sleep(Number.NaN)).rejects.toBeInstanceOf(RangeError);
    expect(clock.pendingSleeps()).toBe(0);
  });

  it("never wakes an infinite sleep on a finite advance", async () => {
    const clock = new FakeClock(0);
    let woke = false;
    void clock.sleep(Number.POSITIVE_INFINITY).then(() => (woke = true));
    await clock.advance(1e12);
    expect(woke).toBe(false);
    expect(clock.pendingSleeps()).toBe(1);
  });

  it("rejects an aborted sleep with an AbortError and forgets it", async () => {
    const clock = new FakeClock(0);
    const ac = new AbortController();
    const sleeping = clock.sleep(1000, ac.signal);
    expect(clock.pendingSleeps()).toBe(1);
    ac.abort(new Error("stop"));
    const err = await sleeping.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");
    expect((err as Error).cause).toEqual(new Error("stop"));
    expect(clock.pendingSleeps()).toBe(0);
    await clock.advance(5000);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const clock = new FakeClock(0);
    const ac = new AbortController();
    ac.abort();
    await expect(clock.sleep(1000, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(clock.pendingSleeps()).toBe(0);
  });

  it("ignores an abort after the sleep already resolved", async () => {
    const clock = new FakeClock(0);
    const ac = new AbortController();
    const sleeping = clock.sleep(10, ac.signal);
    await clock.advance(10);
    ac.abort();
    await expect(sleeping).resolves.toBeUndefined();
  });

  it("refuses to move time backwards", async () => {
    const clock = new FakeClock(0);
    await expect(clock.advance(-1)).rejects.toBeInstanceOf(RangeError);
    await expect(clock.advance(Number.NaN)).rejects.toBeInstanceOf(RangeError);
    expect(clock.now()).toBe(0);
  });
});
