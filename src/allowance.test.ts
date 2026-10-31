import { describe, expect, it } from "vitest";
import {
  ALLOWANCE_MAX_AGE_MS, ALLOWANCE_MAX_RESET_AHEAD_MS, assessAllowance, legacyAllowanceObservations,
  observeAllowance, observeAllowanceBatch, restoreObservations, type AllowanceInput, type AllowanceObservation,
} from "./allowance.js";

const NOW = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const sample = (window = "five_hour", utilization: unknown = 0.2, reset: AllowanceInput["reset"] = { kind: "supplied", value: NOW + HOUR }): AllowanceInput => ({ window, utilization, reset });
const obs = (window = "five_hour", at = NOW) => observeAllowance("codex", sample(window), at)!;
const assess = (rows: AllowanceObservation[], at = NOW) => assessAllowance("codex", rows, at);

describe("allowance receipt and normalization", () => {
  it("takes receipt solely from its controller argument", () => {
    const input = { ...sample(), receivedAt: NOW + HOUR, provider: "claude", ambiguous: true };
    expect(observeAllowance("codex", input, NOW)).toEqual({
      provider: "codex", window: "five_hour", utilization: 0.2, resetsAt: NOW + HOUR, receivedAt: NOW, resetState: "reported",
    });
  });
  it.each([0, 0.2, 1, 1.25])("keeps actual nonnegative finite utilization %s", (value) => {
    expect(observeAllowance("codex", sample("five_hour", value), NOW)?.utilization).toBe(value);
  });
  it.each([{ value: -1 }, { value: Number.NaN }, { value: Infinity }, { value: null }, { value: "synthetic-private" }, { value: undefined }])("marks malformed utilization $value without coercing it to zero", ({ value }) => {
    const row = observeAllowance("codex", { ...sample(), utilization: value }, NOW)!;
    expect(row.utilization).toBeNull();
    expect(JSON.stringify(row)).not.toContain("synthetic-private");
    expect(assess([row]).windows[0]!.reasons).toContain("malformed_utilization");
  });
  it("inherits a still-valid same-key reset only for omitted reset", () => {
    expect(observeAllowance("codex", sample("five_hour", 0.4, { kind: "omitted" }), NOW + 100, obs())).toMatchObject({
      resetsAt: NOW + HOUR, resetState: "inherited", receivedAt: NOW + 100,
    });
  });
  it.each([{ value: undefined }, { value: null }, { value: "synthetic-private" }, { value: NaN }, { value: Infinity }])("does not inherit supplied malformed reset $value", ({ value }) => {
    const row = observeAllowance("codex", sample("five_hour", 0.4, { kind: "supplied", value }), NOW, obs())!;
    expect(row).toMatchObject({ resetsAt: null, resetState: "malformed" });
    expect(JSON.stringify(row)).not.toContain("synthetic-private");
  });
  it("keeps implausible distinct after discarding the supplied value", () => {
    const row = observeAllowance("codex", sample("five_hour", 0.4, { kind: "supplied", value: NOW + ALLOWANCE_MAX_RESET_AHEAD_MS + 1 }), NOW, obs())!;
    expect(row).toMatchObject({ resetsAt: null, resetState: "implausible" });
    expect(assess([row]).windows[0]!.reasons).toContain("implausible_reset");
    expect(observeAllowance("codex", sample("five_hour", 0.4, { kind: "supplied", value: NOW + ALLOWANCE_MAX_RESET_AHEAD_MS }), NOW)?.resetState).toBe("reported");
  });
  it("retains a date-safe expired reset as expired, without inheritance", () => {
    const row = observeAllowance("codex", sample("five_hour", 0.4, { kind: "supplied", value: NOW - 1 }), NOW, obs())!;
    expect(row).toMatchObject({ resetsAt: NOW - 1, resetState: "reported" });
    expect(assess([row]).windows[0]!.reasons).toContain("expired");
  });
  it.each([
    { previous: { ...obs(), provider: "claude" } },
    { previous: obs("seven_day") },
    { previous: { ...obs(), resetsAt: NOW } },
    { previous: { ...obs(), ambiguous: true } },
    { previous: { ...obs(), resetState: "missing", resetsAt: NOW + HOUR } },
    { previous: { ...obs(), resetsAt: null } },
  ])("refuses invalid/cross-key inherited reset %#", ({ previous }) => {
    expect(observeAllowance("codex", sample("five_hour", 0.4, { kind: "omitted" }), NOW, previous as AllowanceObservation)?.resetState).toBe("missing");
  });
});

describe("required aggregate assessment", () => {
  it("requires both aggregate windows, never substituting model windows", () => {
    const result = assess([obs(), obs("seven_day_opus")]);
    expect(result.usable).toBe(false);
    expect(result.windows.find((w) => w.window === "seven_day")?.reasons).toContain("missing");
    expect(assess([obs(), obs("seven_day")]).usable).toBe(true);
  });
  it("uses the inclusive ten-minute age bound", () => {
    const rows = [obs(), obs("seven_day")];
    expect(assess(rows, NOW + ALLOWANCE_MAX_AGE_MS).usable).toBe(true);
    expect(assess(rows, NOW + ALLOWANCE_MAX_AGE_MS + 1).windows[0]!.reasons).toContain("stale");
  });
  it("does not use a future receipt after clock rollback", () => {
    expect(assess([obs(), obs("seven_day")], NOW - 1).windows[0]!.reasons).toContain("clock_rollback");
  });
  it("distinguishes legacy, malformed receipt, reset-less and missing observations", () => {
    const { receivedAt: _, ...legacy } = obs();
    expect(assess([legacy]).windows[0]!.reasons).toContain("missing_receipt");
    expect(assess([{ ...obs(), receivedAt: null }]).windows[0]!.reasons).toContain("malformed_receipt");
    const resetless = observeAllowance("codex", sample("five_hour", 0.2, { kind: "omitted" }), NOW)!;
    expect(assess([resetless]).windows[0]!.reasons).toContain("reset_missing");
    expect(assess([]).windows[0]!.reasons).toEqual(["missing"]);
  });
  it("never refreshes or mutates supplied stored observations", () => {
    const row = Object.freeze(obs());
    const rows = Object.freeze([row, Object.freeze(obs("seven_day"))]);
    expect(assessAllowance("codex", rows, NOW + 100).usable).toBe(true);
    expect(row.receivedAt).toBe(NOW);
  });
});

describe("batch ambiguity and storage validation", () => {
  it("collates duplicate live metadata windows into unknown, without last-wins credit", () => {
    const rows = observeAllowanceBatch("codex", [sample(), sample("five_hour", 0.01), sample("seven_day")], NOW);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.window === "five_hour")).toMatchObject({ ambiguous: true, utilization: null });
    expect(assess(rows).windows[0]!.reasons).toContain("ambiguous");
  });
  it("does not inherit from an ambiguous previous observation array", () => {
    const rows = observeAllowanceBatch("codex", [sample("five_hour", 0.3, { kind: "omitted" })], NOW, [obs(), { ...obs(), utilization: 0.4 }]);
    expect(rows[0]!.resetState).toBe("missing");
  });
  it("treats successive separate observations as actual refreshes", () => {
    const old = obs();
    const next = observeAllowance("codex", sample(), NOW + 10, old)!;
    expect(next.receivedAt).toBe(NOW + 10);
    expect(next.ambiguous).toBeUndefined();
  });
  it("preserves duplicate restored-row ambiguity including malformed members", () => {
    const rows = restoreObservations([obs(), { ...obs(), utilization: "bad" }, obs("seven_day")]);
    expect(assess(rows).windows[0]!.reasons).toContain("ambiguous");
  });
  it.each([
    { patch: { resetState: "reported", resetsAt: null } },
    { patch: { resetState: "inherited", resetsAt: "bad" } },
    { patch: { resetState: "missing", resetsAt: NOW + HOUR } },
    { patch: { resetState: "malformed", resetsAt: NOW + HOUR } },
    { patch: { resetState: "implausible", resetsAt: NOW + HOUR } },
    { patch: { ambiguous: false } },
    { patch: { ambiguous: "true" } },
  ])("does not accept inconsistent canonical state %#", ({ patch }) => {
    const rows = restoreObservations([{ ...obs(), ...patch }, obs("seven_day")]);
    expect(assess(rows).usable).toBe(false);
    expect(rows[0]!.utilization).toBeNull();
  });
  it("restores controller receipt without restamping and strips unknown properties", () => {
    expect(restoreObservations([{ ...obs(), ignored: "synthetic-private" }])).toEqual([obs()]);
  });
  it("normalizes malformed stored receipt rather than making it current", () => {
    const rows = restoreObservations([{ ...obs(), receivedAt: "bad" }]);
    expect(rows[0]!.receivedAt).toBeNull();
    expect(assess(rows).windows[0]!.reasons).toContain("malformed_receipt");
  });
  it("keeps legacy numeric rows without receipt and does not trust an added receipt property", () => {
    const rows = legacyAllowanceObservations([{ provider: "codex", window: "five_hour", utilization: 0.2, resetsAt: NOW + HOUR, receivedAt: NOW }]);
    expect(rows[0]).not.toHaveProperty("receivedAt");
    expect(assess(rows).windows[0]!.reasons).toContain("missing_receipt");
  });
  it.each(["", "five_hour\n", " five_hour", "five_hour\u0000", "a".repeat(129)])("never cleans a malformed raw ID into a required window %j", (window) => {
    expect(observeAllowance("codex", sample(window), NOW)).toBeUndefined();
    expect(restoreObservations([{ ...obs(), window }])).toEqual([]);
  });
});

describe("allowance storage bounds", () => {
  it("reserves aggregate slots even when a response contains additional windows only", () => {
    const rows = observeAllowanceBatch("codex", Array.from({ length: 90 }, (_, i) => sample("extra_" + i)), NOW);
    expect(rows).toHaveLength(62);
    const withAggregates = observeAllowanceBatch("codex", [...Array.from({ length: 90 }, (_, i) => sample("extra_" + i)), sample(), sample("seven_day")], NOW);
    expect(withAggregates).toHaveLength(64);
    expect(assess(withAggregates).usable).toBe(true);
  });
});
