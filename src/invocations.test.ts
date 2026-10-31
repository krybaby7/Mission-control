import { describe, expect, it, vi } from "vitest";
import {
  cleanInvocation, InvocationPersistenceError, journalOf, observeInvocation,
  recoverInvocations, reserveInvocation, settleRecovery, type InvocationState, type Reservation,
} from "./invocations.js";

const AT = "2026-10-31T01:00:00.000Z";
const LATER = "2026-10-31T01:01:00.000Z";
const identity = { provider: "codex", family: "codex", model: "existing-model" } as const;
const input = (id = "build-1"): Reservation => ({
  jobId: id, label: "build", role: "engineer", access: "workspace-write",
  scope: { kind: "controller" }, stage: "other", reservedAt: AT, candidate: identity,
});
const state = (agentRuns = 0): InvocationState => ({ agentRuns });

describe("durable invocation accounting", () => {
  it("preserves a legacy baseline and reserves before any actual identity is known", () => {
    const m = state(7);
    const save = vi.fn(() => expect(m.agentRuns).toBe(8));
    expect(reserveInvocation(m, input(), 10, save)).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(m.invocations).toMatchObject({ version: 1, legacyAgentRuns: 7, entries: [{ jobId: "build-1", writeDisposition: "pending" }] });
    expect(m.invocations!.entries[0]!.observation).toBeUndefined();
  });
  it("does not truncate history or launch when today's cap is below preserved usage", () => {
    const m = state(7);
    reserveInvocation(m, input(), 10, () => {});
    const before = structuredClone(m);
    const save = vi.fn();
    expect(reserveInvocation(m, input("build-2"), 3, save)).toBe(false);
    expect(m).toEqual(before);
    expect(save).not.toHaveBeenCalled();
  });
  it("rolls back a failed reservation so no in-memory success can later be saved", () => {
    const m = state(2);
    expect(() => reserveInvocation(m, input(), 10, () => { throw Error("disk"); })).toThrow(InvocationPersistenceError);
    expect(m).toEqual({ agentRuns: 2 });
  });
  it("keeps pending state after observation or cleanup persistence fails", () => {
    const m = state();
    reserveInvocation(m, input(), 10, () => {});
    const fail = () => { throw Error("disk"); };
    expect(() => observeInvocation(m, "build-1", identity, "failed", LATER, fail)).toThrow(InvocationPersistenceError);
    expect(m.invocations!.entries[0]!.observation).toBeUndefined();
    observeInvocation(m, "build-1", identity, "failed", LATER, () => {});
    expect(() => cleanInvocation(m, "build-1", LATER, fail)).toThrow(InvocationPersistenceError);
    expect(m.invocations!.entries[0]!.cleanedAt).toBeUndefined();
    expect(m.invocations!.entries[0]!.writeDisposition).toBe("pending");
  });
  it("records thrown invocation as actual, while cleanup does not adopt writes", () => {
    const m = state();
    reserveInvocation(m, input(), 10, () => {});
    observeInvocation(m, "build-1", identity, "thrown", LATER, () => {});
    cleanInvocation(m, "build-1", LATER, () => {});
    expect(m.invocations!.entries[0]).toMatchObject({ observation: { actual: identity, outcome: "thrown" }, cleanedAt: LATER, writeDisposition: "pending" });
  });
  it("rejects cleanup of an unobserved reservation", () => {
    const m = state();
    reserveInvocation(m, input(), 10, () => {});
    expect(() => cleanInvocation(m, "build-1", LATER, () => {})).toThrow(InvocationPersistenceError);
  });
  it("rejects duplicated reservation IDs", () => {
    const m = state();
    reserveInvocation(m, input(), 10, () => {});
    expect(() => reserveInvocation(m, input(), 10, () => {})).toThrow(InvocationPersistenceError);
    expect(m.agentRuns).toBe(1);
  });
  it.each([null, {}, { version: 2 }, { version: 1, entries: [] }])("blocks malformed present journal without resetting it: %j", (raw) => {
    const m = { agentRuns: 3, invocations: raw } as unknown as InvocationState;
    const original = structuredClone(m);
    expect(() => reserveInvocation(m, input(), 10, () => {})).toThrow(InvocationPersistenceError);
    expect(m).toEqual(original);
  });
  it("rejects count drift and unknown enums without inventing missing attempts", () => {
    const m = state(); reserveInvocation(m, input(), 10, () => {});
    m.agentRuns = 9;
    expect(() => journalOf(m)).toThrow(InvocationPersistenceError);
    m.agentRuns = 1;
    (m.invocations!.entries[0] as unknown as { role: string }).role = "unknown";
    expect(() => journalOf(m)).toThrow(InvocationPersistenceError);
  });
  it("detaches caller-owned reservation data", () => {
    const m = state(); const r = input();
    reserveInvocation(m, r, 10, () => {});
    r.candidate.model = "changed";
    expect(m.invocations!.entries[0]!.candidate.model).toBe("existing-model");
  });
  it.each([
    { role: ["engineer"] }, { stage: ["other"] }, { scope: { kind: ["controller"] } },
    { access: ["workspace-write"] }, { reservedAt: "2026-02-30T01:00:00.000Z" },
    { baseSubject: { kind: "application_commit", commit: "a".repeat(40) } },
  ])("rejects malformed reservation metadata %j without a save", patch => {
    const m = state(); const save = vi.fn();
    expect(() => reserveInvocation(m, { ...input(), ...patch } as unknown as Reservation, 10, save)).toThrow(InvocationPersistenceError);
    expect(save).not.toHaveBeenCalled(); expect(m.agentRuns).toBe(0);
  });
  it("rejects impossible chronology and a different observed identity", () => {
    const m = state(); reserveInvocation(m, input(), 10, () => {});
    expect(() => observeInvocation(m, "build-1", identity, "ok", "2026-10-30T01:00:00.000Z", () => {})).toThrow(InvocationPersistenceError);
    expect(() => observeInvocation(m, "build-1", { ...identity, family: "claude" }, "ok", LATER, () => {})).toThrow(InvocationPersistenceError);
    expect(m.invocations!.entries[0]!.observation).toBeUndefined();
  });
});

describe("idempotent recovery", () => {
  it("accounts a reserved crash once even without a scratch marker or job log", () => {
    const m = state(); reserveInvocation(m, input(), 10, () => {});
    expect(recoverInvocations(m, undefined, {}, LATER, () => {})).toMatchObject([{ label: "build", count: 1, fresh: true }]);
    expect(m.agentRuns).toBe(1);
    expect(m.invocations!.entries[0]).toMatchObject({ writeDisposition: "uncertain" });
    expect(m.invocations!.entries[0]!.observation).toBeUndefined();
    expect(recoverInvocations(m, undefined, {}, LATER, () => {})).toMatchObject([{ count: 1, fresh: false }]);
    settleRecovery(m, "job:build-1", false, () => {});
    expect(recoverInvocations(m, undefined, {}, LATER, () => {})).toEqual([]);
    expect(m.invocations!.recoveries).toHaveLength(1);
  });
  it("saves legacy recovery key, baseline tally and count in one transaction", () => {
    const m = state(4);
    const marker = { label: "review-x", feature: "x", at: AT };
    const save = vi.fn(() => {
      expect(m.agentRuns).toBe(5);
      expect(m.invocations!.recoveries).toHaveLength(1);
      expect(m.invocations!.interruptionCounts["review-x"]).toBe(3);
    });
    const first = recoverInvocations(m, marker, { "review-x": 2 }, LATER, save);
    expect(first).toMatchObject([{ count: 3, fresh: true }]);
    const second = recoverInvocations(m, marker, { "review-x": 2 }, LATER, () => {});
    expect(second).toMatchObject([{ count: 3, fresh: false }]);
    expect(m.agentRuns).toBe(5);
  });
  it("failed recovery save preserves the original marker-accounting state for retry", () => {
    const m = state(4); const marker = { label: "review-x", at: AT };
    expect(() => recoverInvocations(m, marker, {}, LATER, () => { throw Error("disk"); })).toThrow(InvocationPersistenceError);
    expect(m).toEqual({ agentRuns: 4 });
    recoverInvocations(m, marker, {}, LATER, () => {});
    expect(m.agentRuns).toBe(5);
  });
  it("observed but uncleaned writers stay uncertain; cleaned writers are not interrupted", () => {
    const m = state(); reserveInvocation(m, input(), 10, () => {});
    observeInvocation(m, "build-1", identity, "ok", LATER, () => {});
    recoverInvocations(m, undefined, {}, LATER, () => {});
    expect(m.invocations!.entries[0]!.writeDisposition).toBe("uncertain");
    const clean = state(); reserveInvocation(clean, input(), 10, () => {});
    observeInvocation(clean, "build-1", identity, "ok", LATER, () => {});
    cleanInvocation(clean, "build-1", LATER, () => {});
    expect(recoverInvocations(clean, undefined, {}, LATER, () => {})).toEqual([]);
  });
  it.each([{ jobId: "unknown" }, { label: "other" }, { feature: "wrong" }, { at: LATER }])("refuses a mismatched durable marker %j without adding a legacy count", patch => {
    const m = state(); reserveInvocation(m, input(), 10, () => {});
    const before = structuredClone(m);
    expect(() => recoverInvocations(m, { jobId: "build-1", label: "build", at: AT, ...patch }, {}, LATER, () => {})).toThrow(InvocationPersistenceError);
    expect(m).toEqual(before);
  });
  it("rejects a lowered recovery tally and recovery earlier than its observation", () => {
    const m = state(); reserveInvocation(m, input(), 10, () => {});
    observeInvocation(m, "build-1", identity, "ok", LATER, () => {});
    expect(() => recoverInvocations(m, undefined, {}, AT, () => {})).toThrow(InvocationPersistenceError);
    recoverInvocations(m, undefined, {}, LATER, () => {});
    m.invocations!.recoveries[0]!.count = 2;
    expect(() => journalOf(m)).toThrow(InvocationPersistenceError);
  });
  it("retains baseline and handled tally resets as a validated sequence", () => {
    const m = state(); const marker = { label: "build", at: AT };
    const first = recoverInvocations(m, marker, { build: 2 }, LATER, () => {});
    expect(first[0]?.count).toBe(3);
    m.invocations!.recoveries[0]!.count = 1;
    expect(() => journalOf(m)).toThrow(InvocationPersistenceError);
    m.invocations!.recoveries[0]!.count = 3;
    settleRecovery(m, first[0]!.key, true, () => {});
    const next = recoverInvocations(m, { ...marker, at: LATER }, {}, LATER, () => {});
    expect(next[0]?.count).toBe(1); expect(journalOf(m).interruptionCounts.build).toBe(1);
  });
  it("refuses unexpected raw payloads in scratch instead of copying them into history", () => {
    const m = state();
    const marker = { label: "build", at: AT, rawOutput: "synthetic unbounded data" };
    expect(() => recoverInvocations(m, marker, {}, LATER, () => {})).toThrow(InvocationPersistenceError);
    expect(m).toEqual({ agentRuns: 0 });
  });
  it("handles multiple unresolved same-label reservations before clearing their shared tally", () => {
    const m = state();
    reserveInvocation(m, input(), 10, () => {});
    reserveInvocation(m, input("build-2"), 10, () => {});
    m.invocations!.legacyInterruptionCounts = { build: 2 };
    m.invocations!.interruptionCounts = { build: 2 };
    const notices = recoverInvocations(m, undefined, {}, LATER, () => {});
    expect(notices.map(n => n.count)).toEqual([3, 4]);
    settleRecovery(m, notices[0]!.key, true, () => {});
    expect(journalOf(m).interruptionCounts.build).toBe(4);
    settleRecovery(m, notices[1]!.key, true, () => {});
    expect(journalOf(m).interruptionCounts.build).toBe(0);
    expect(recoverInvocations(m, undefined, {}, LATER, () => {})).toEqual([]);
  });
  it("refuses prepopulated observed or cleaned data on a new reservation", () => {
    for (const fields of [{ observation: { at: AT, actual: identity, outcome: "ok" } }, { cleanedAt: AT }, { writeDisposition: "adopted" }]) {
      const m = state();
      expect(() => reserveInvocation(m, { ...input(), ...fields }, 10, () => {})).toThrow(InvocationPersistenceError);
      expect(m).toEqual({ agentRuns: 0 });
    }
  });
});
