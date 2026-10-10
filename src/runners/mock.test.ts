import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEMAS } from "../schemas.js";
import type { AgentJob, RunEvent, RunOptions } from "../types.js";
import { MockRunner, type MockBehavior } from "./mock.js";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "mc-mock-runner-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: "build-1",
    role: "engineer",
    provider: "mock",
    model: "mock-model",
    effort: "medium",
    cwd,
    systemPrompt: "system",
    prompt: "do the thing",
    access: "workspace-write",
    limits: { maxTurns: 10, timeoutMs: 60_000 },
    ...overrides,
  };
}

/** Runs one job with the given behavior and returns the result plus every emitted event. */
async function runOnce(behavior: MockBehavior, j: AgentJob = job(), opts: Omit<RunOptions, "onEvent"> = {}) {
  const runner = new MockRunner(() => behavior);
  const events: RunEvent[] = [];
  const result = await runner.run(j, { ...opts, onEvent: (e) => events.push(e) });
  return { runner, result, events };
}

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("MockRunner basics", () => {
  it("defaults to a successful run with empty text and zero usage", async () => {
    const { result, events } = await runOnce({});
    expect(result).toEqual({
      outcome: "ok",
      text: "",
      sessionId: "mock-mock-0",
      usage: zeroUsage,
      durationMs: expect.any(Number),
      exitCode: 0,
    });
    expect(events).toEqual([
      { type: "started", sessionId: "mock-mock-0" },
      { type: "usage", usage: zeroUsage },
    ]);
  });

  it("uses provider mock by default and can impersonate a real provider", async () => {
    expect(new MockRunner(() => ({})).provider).toBe("mock");
    const codex = new MockRunner(() => ({}), { provider: "codex" });
    expect(codex.provider).toBe("codex");
    expect((await codex.run(job())).sessionId).toBe("mock-codex-0");
  });

  it("works without run options", async () => {
    const runner = new MockRunner(() => ({ text: "hi" }));
    expect((await runner.run(job())).text).toBe("hi");
  });

  it("records every job and passes a per-runner call index to the script", async () => {
    const seen: [string, number][] = [];
    const runner = new MockRunner((j, i) => {
      seen.push([j.id, i]);
      return { text: `call ${i}` };
    });
    const first = job({ id: "a" });
    const second = job({ id: "b" });
    const results = [await runner.run(first), await runner.run(second)];
    expect(seen).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    expect(runner.calls).toEqual([first, second]);
    expect(runner.calls[0]).toBe(first);
    expect(results.map((r) => r.text)).toEqual(["call 0", "call 1"]);
    expect(results.map((r) => r.sessionId)).toEqual(["mock-mock-0", "mock-mock-1"]);
  });

  it("accepts an async script", async () => {
    const runner = new MockRunner(async () => {
      await Promise.resolve();
      return { text: "later" };
    });
    expect(await runner.run(job())).toMatchObject({ outcome: "ok", text: "later" });
  });

  it("merges partial usage over zeros and emits it", async () => {
    const usage = { inputTokens: 120, outputTokens: 30, estCostUsd: 0.5, turns: 3 };
    const { result, events } = await runOnce({ usage });
    expect(result.usage).toEqual({ ...zeroUsage, ...usage });
    expect(events.at(-1)).toEqual({ type: "usage", usage: { ...zeroUsage, ...usage } });
  });

  it("emits scripted events right after started, in order", async () => {
    const scripted: RunEvent[] = [
      { type: "utilization", info: { provider: "claude", window: "five_hour", utilization: 0.9, resetsAt: 1000 } },
      { type: "progress", text: "Edit src/app.ts" },
    ];
    const { events } = await runOnce({ events: scripted });
    expect(events.map((e) => e.type)).toEqual(["started", "utilization", "progress", "usage"]);
    expect(events.slice(1, 3)).toEqual(scripted);
  });

  it("measures the delay as run time", async () => {
    const { result } = await runOnce({ delayMs: 60 });
    expect(result.outcome).toBe("ok");
    expect(result.durationMs).toBeGreaterThanOrEqual(50);
  });
});

describe("MockRunner text and structured output", () => {
  const approve = { verdict: "approve", issues: [] };

  it("returns valid structured output for a job with a schema", async () => {
    const { result } = await runOnce({ structured: approve }, job({ outputSchema: SCHEMAS.gate }));
    expect(result).toMatchObject({ outcome: "ok", structured: approve, text: JSON.stringify(approve), exitCode: 0 });
    expect(result.error).toBeUndefined();
  });

  it("keeps an explicit text next to the structured value", async () => {
    const { result } = await runOnce({ structured: approve, text: "done" }, job({ outputSchema: SCHEMAS.gate }));
    expect(result.text).toBe("done");
    expect(result.structured).toEqual(approve);
  });

  it("fails a run whose structured value does not match the schema", async () => {
    const { result } = await runOnce(
      { structured: { verdict: "maybe", issues: [], extra: 1 } },
      job({ outputSchema: SCHEMAS.gate }),
    );
    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.structured).toBeUndefined();
    expect(result.error).toMatch(/^invalid structured output: /);
    expect(result.error).toContain("/verdict must be one of");
    expect(result.error).toContain('unexpected property "extra"');
  });

  it("fails a run with a schema but no structured value", async () => {
    const { result } = await runOnce({ text: "plain words" }, job({ outputSchema: SCHEMAS.gate }));
    expect(result).toMatchObject({ outcome: "failed", text: "plain words" });
    expect(result.error).toMatch(/^invalid structured output: /);
  });

  it("returns a copy of the structured value, so callers cannot change the script's behavior", async () => {
    const behavior = { structured: { verdict: "approve", issues: [] as string[] } };
    const runner = new MockRunner(() => behavior);
    const gateJob = job({ outputSchema: SCHEMAS.gate });
    const first = await runner.run(gateJob);
    expect(first.structured).toEqual(behavior.structured);
    expect(first.structured).not.toBe(behavior.structured);
    (first.structured as { issues: string[] }).issues.push("mutated by caller");

    const second = await runner.run(gateJob);
    expect(behavior.structured.issues).toEqual([]);
    expect(second.structured).toEqual({ verdict: "approve", issues: [] });
    expect(second.text).toBe(JSON.stringify({ verdict: "approve", issues: [] }));
  });

  it("does not report structured output when the job has no schema", async () => {
    const { result } = await runOnce({ structured: approve });
    expect(result.outcome).toBe("ok");
    expect(result.structured).toBeUndefined();
    expect(result.text).toBe(JSON.stringify(approve));
  });

  it("does not validate or return structured output for unsuccessful outcomes", async () => {
    const { result } = await runOnce(
      { outcome: "failed", structured: { verdict: "nope" } },
      job({ outputSchema: SCHEMAS.gate }),
    );
    expect(result).toMatchObject({ outcome: "failed", error: "mock run failed" });
    expect(result.structured).toBeUndefined();
  });
});

describe("MockRunner limits", () => {
  it("reports a session limit for this provider by default and emits it", async () => {
    const runner = new MockRunner(() => ({ outcome: "limited" }), { provider: "codex" });
    const events: RunEvent[] = [];
    const result = await runner.run(job(), { onEvent: (e) => events.push(e) });
    const limit = { provider: "codex", kind: "session", raw: "mock session limit" };
    expect(result).toMatchObject({ outcome: "limited", limit, exitCode: 1 });
    expect(result.error).toBe("usage limit (session): mock session limit");
    expect(events.map((e) => e.type)).toEqual(["started", "limit", "usage"]);
    expect(events[1]).toEqual({ type: "limit", info: limit });
  });

  it("fills a partial limit, always with this runner's provider", async () => {
    const resetsAt = Date.UTC(2026, 9, 10, 15, 45);
    const raw = "You've hit your Opus limit";
    const limit = { provider: "codex", kind: "model", model: "opus", resetsAt, raw } as const;
    const runner = new MockRunner(() => ({ outcome: "limited", limit }), { provider: "claude" });
    const result = await runner.run(job());
    expect(result.limit).toEqual({ provider: "claude", kind: "model", model: "opus", resetsAt, raw });
  });

  it("treats a behavior with a limit and no outcome as limited", async () => {
    const { result } = await runOnce({ limit: { kind: "weekly" } });
    expect(result.outcome).toBe("limited");
    expect(result.limit).toEqual({ provider: "mock", kind: "weekly", raw: "mock weekly limit" });
  });

  it("ignores the limit for other explicit outcomes", async () => {
    const { result, events } = await runOnce({ outcome: "failed", limit: { kind: "weekly" } });
    expect(result.outcome).toBe("failed");
    expect(result.limit).toBeUndefined();
    expect(events.some((e) => e.type === "limit")).toBe(false);
  });

  it("uses a scripted error message for a limited run", async () => {
    const { result } = await runOnce({ outcome: "limited", error: "You've hit your usage limit." });
    expect(result.error).toBe("You've hit your usage limit.");
  });
});

describe("MockRunner other outcomes", () => {
  it.each([
    ["failed", "mock run failed", 1],
    ["auth", "mock CLI is not logged in", 1],
    ["crashed", "mock CLI crashed without a result", 1],
    ["timeout", "timed out after 60000 ms", null],
    ["aborted", "aborted", null],
  ] as const)("reports %s with a default error and exit code", async (outcome, error, exitCode) => {
    const { result } = await runOnce({ outcome, text: "partial" });
    expect(result).toMatchObject({ outcome, error, exitCode, text: "partial" });
    expect(result.limit).toBeUndefined();
  });

  it("uses a scripted error message", async () => {
    const { result } = await runOnce({ outcome: "auth", error: "401 Unauthorized" });
    expect(result.error).toBe("401 Unauthorized");
  });

  it("ignores a scripted error on success", async () => {
    const { result } = await runOnce({ error: "unused" });
    expect(result.outcome).toBe("ok");
    expect(result.error).toBeUndefined();
  });
});

describe("MockRunner edits", () => {
  it("applies the edit in the job's cwd before resolving", async () => {
    const edit = vi.fn((dir: string, j: AgentJob) => writeFileSync(join(dir, "app.mjs"), `// ${j.id}\n`));
    const j = job();
    const { result } = await runOnce({ edit }, j);
    expect(result.outcome).toBe("ok");
    expect(edit).toHaveBeenCalledWith(cwd, j);
    expect(readFileSync(join(cwd, "app.mjs"), "utf8")).toBe("// build-1\n");
  });

  it("awaits an async edit", async () => {
    const edit = async (dir: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(join(dir, "late.txt"), "x");
    };
    await runOnce({ edit });
    expect(existsSync(join(cwd, "late.txt"))).toBe(true);
  });

  it("still runs the edit for read-only jobs so callers can catch violations", async () => {
    const edit = (dir: string) => writeFileSync(join(dir, "sneaky.txt"), "x");
    await runOnce({ edit }, job({ role: "reviewer", access: "read-only" }));
    expect(existsSync(join(cwd, "sneaky.txt"))).toBe(true);
  });

  it("applies the edit with any outcome", async () => {
    const edit = (dir: string) => writeFileSync(join(dir, "half-done.txt"), "x");
    const { result } = await runOnce({ outcome: "limited", edit });
    expect(result.outcome).toBe("limited");
    expect(existsSync(join(cwd, "half-done.txt"))).toBe(true);
  });

  it("rejects when the edit throws", async () => {
    const edit = () => {
      throw new Error("edit bug");
    };
    await expect(runOnce({ edit })).rejects.toThrow("edit bug");
  });
});

describe("MockRunner errors from tests", () => {
  it("rejects when the script throws, after recording the job", async () => {
    const runner = new MockRunner(() => {
      throw new Error("unexpected job");
    });
    await expect(runner.run(job())).rejects.toThrow("unexpected job");
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects when the onEvent handler throws", async () => {
    const runner = new MockRunner(() => ({}));
    const onEvent = () => {
      throw new Error("handler bug");
    };
    await expect(runner.run(job(), { onEvent })).rejects.toThrow("handler bug");
  });
});

describe("MockRunner abort", () => {
  it("returns aborted without running the script when the signal already fired", async () => {
    const script = vi.fn(() => ({ text: "never" }));
    const runner = new MockRunner(script);
    const events: RunEvent[] = [];
    const result = await runner.run(job(), { signal: AbortSignal.abort(), onEvent: (e) => events.push(e) });
    expect(result).toEqual({
      outcome: "aborted",
      text: "",
      usage: zeroUsage,
      error: "aborted",
      durationMs: expect.any(Number),
      exitCode: null,
    });
    expect(script).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(runner.calls).toHaveLength(1);
  });

  it("returns aborted when the signal fires while the script runs, before any edit", async () => {
    const controller = new AbortController();
    const edit = vi.fn();
    const runner = new MockRunner(() => {
      controller.abort();
      return { edit };
    });
    const result = await runner.run(job(), { signal: controller.signal });
    expect(result.outcome).toBe("aborted");
    expect(result.sessionId).toBeUndefined();
    expect(edit).not.toHaveBeenCalled();
  });

  it("stops the delay as soon as the signal fires, keeping the edits made so far", async () => {
    const controller = new AbortController();
    const edit = (dir: string) => writeFileSync(join(dir, "partial.txt"), "x");
    const events: RunEvent[] = [];
    const runner = new MockRunner(() => ({ delayMs: 30_000, edit, structured: { verdict: "approve", issues: [] } }));
    setTimeout(() => controller.abort(), 20);
    const result = await runner.run(job({ outputSchema: SCHEMAS.gate }), {
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });
    expect(result).toMatchObject({ outcome: "aborted", error: "aborted", exitCode: null, sessionId: "mock-mock-0" });
    expect(result.structured).toBeUndefined();
    expect(result.durationMs).toBeLessThan(5_000);
    expect(existsSync(join(cwd, "partial.txt"))).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["started"]);
  });

  it("returns aborted when the signal fires during the edit", async () => {
    const controller = new AbortController();
    const runner = new MockRunner(() => ({ edit: () => controller.abort(), outcome: "limited" }));
    const events: RunEvent[] = [];
    const result = await runner.run(job(), { signal: controller.signal, onEvent: (e) => events.push(e) });
    expect(result.outcome).toBe("aborted");
    expect(result.limit).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["started"]);
  });

  it("returns aborted without editing when an event handler aborts", async () => {
    const controller = new AbortController();
    const edit = vi.fn();
    const runner = new MockRunner(() => ({ edit, events: [{ type: "progress", text: "working" }] }));
    const events: RunEvent[] = [];
    const onEvent = (e: RunEvent) => {
      events.push(e);
      if (e.type === "started") controller.abort();
    };
    const result = await runner.run(job(), { signal: controller.signal, onEvent });
    expect(result).toMatchObject({ outcome: "aborted", sessionId: "mock-mock-0" });
    expect(edit).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(["started", "progress"]);
  });

  it("returns aborted as soon as the signal fires while an async script is pending", async () => {
    const controller = new AbortController();
    const runner = new MockRunner(() => new Promise<MockBehavior>(() => {}));
    setTimeout(() => controller.abort(), 10);
    const result = await runner.run(job(), { signal: controller.signal });
    expect(result.outcome).toBe("aborted");
    expect(result.sessionId).toBeUndefined();
  });

  it("returns aborted as soon as the signal fires while an async edit is pending, ignoring its late failure", async () => {
    const controller = new AbortController();
    let failEdit = (_err: Error) => {};
    const edit = () =>
      new Promise<void>((_resolve, reject) => {
        failEdit = reject;
      });
    const runner = new MockRunner(() => ({ edit }));
    const events: RunEvent[] = [];
    setTimeout(() => controller.abort(), 10);
    const result = await runner.run(job(), { signal: controller.signal, onEvent: (e) => events.push(e) });
    expect(result).toMatchObject({ outcome: "aborted", sessionId: "mock-mock-0" });
    expect(events.map((e) => e.type)).toEqual(["started"]);
    // Rejecting after the run ended must not surface as an unhandled rejection.
    failEdit(new Error("late edit failure"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it.each([Infinity, 2 ** 31])("waits for the abort with delayMs %s instead of firing at once", async (delayMs) => {
    const controller = new AbortController();
    const runner = new MockRunner(() => ({ delayMs }));
    setTimeout(() => controller.abort(), 40);
    const result = await runner.run(job(), { signal: controller.signal });
    expect(result.outcome).toBe("aborted");
    expect(result.durationMs).toBeGreaterThanOrEqual(30);
  });

  it("completes normally when the signal never fires", async () => {
    const controller = new AbortController();
    const { result } = await runOnce({ delayMs: 5 }, job(), { signal: controller.signal });
    expect(result.outcome).toBe("ok");
  });
});
