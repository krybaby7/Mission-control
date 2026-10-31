// Allowance evidence is separate from quota constraints. Only the controller
// supplies receipt time; provider frames and restored files cannot refresh it.
import type { Provider } from "./types.js";

export const ALLOWANCE_MAX_AGE_MS = 10 * 60_000;
export const ALLOWANCE_MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60_000;
export const REQUIRED_ALLOWANCE_WINDOWS = ["five_hour", "seven_day"] as const;
export type RequiredAllowanceWindow = typeof REQUIRED_ALLOWANCE_WINDOWS[number];
const MAX_WINDOWS_PER_PROVIDER = 64;
const PROVIDERS: readonly Provider[] = ["claude", "codex", "mock"];

export interface AllowanceInput {
  window: string;
  utilization: unknown;
  reset: { kind: "omitted" } | { kind: "supplied"; value: unknown };
}
export interface AllowanceObservation {
  provider: Provider;
  window: string;
  /** null is malformed, never a zero-usage substitute. */
  utilization: number | null;
  resetsAt: number | null;
  /** Absent means legacy; null means a malformed clock/receipt. */
  receivedAt?: number | null;
  resetState: "reported" | "inherited" | "missing" | "malformed" | "implausible";
  ambiguous?: true;
}
export type AllowanceUnknownReason =
  | "missing" | "ambiguous" | "malformed_utilization" | "reset_missing" | "malformed_reset"
  | "implausible_reset" | "expired" | "missing_receipt" | "malformed_receipt" | "clock_rollback" | "stale";
export interface AllowanceWindowAssessment {
  window: RequiredAllowanceWindow;
  usable: boolean;
  reasons: AllowanceUnknownReason[];
  utilization?: number;
  resetsAt?: number;
  receivedAt?: number;
}
export interface ProviderAllowanceAssessment {
  provider: Provider;
  usable: boolean;
  windows: AllowanceWindowAssessment[];
}
export interface AllowanceReadOptions { signal?: AbortSignal; timeoutMs?: number; }
export type AllowanceReadResult =
  | { status: "observed"; observations: AllowanceInput[] }
  | { status: "auth"; error: string }
  | { status: "unavailable" }
  | { status: "aborted" };

export function validAllowanceUsage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function validAllowanceTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
}
export function validAllowanceIdentity(provider: unknown, window: unknown): window is string {
  return PROVIDERS.includes(provider as Provider) && typeof window === "string" && /^[a-z0-9_]{1,128}$/u.test(window);
}
export function futureAllowanceReset(value: unknown, now: number): value is number {
  return validAllowanceTime(value) && validAllowanceTime(now) && value > now && value - now <= ALLOWANCE_MAX_RESET_AHEAD_MS;
}

export function observeAllowance(
  provider: Provider, input: AllowanceInput, receivedAt: number, previous?: AllowanceObservation,
): AllowanceObservation | undefined {
  if (!input || !validAllowanceIdentity(provider, input.window)) return undefined;
  const row: AllowanceObservation = {
    provider, window: input.window, utilization: validAllowanceUsage(input.utilization) ? input.utilization : null,
    resetsAt: null, receivedAt: validAllowanceTime(receivedAt) ? receivedAt : null, resetState: "missing",
  };
  if (input.reset?.kind === "omitted") {
    if (row.utilization !== null && previous && previous.provider === provider && previous.window === input.window &&
      canonical(previous) && !previous.ambiguous && (previous.resetState === "reported" || previous.resetState === "inherited") &&
      futureAllowanceReset(previous.resetsAt, receivedAt)) {
      row.resetsAt = previous.resetsAt;
      row.resetState = "inherited";
    }
  } else if (input.reset?.kind === "supplied") {
    const value = input.reset.value;
    if (!validAllowanceTime(value)) row.resetState = "malformed";
    else if (validAllowanceTime(receivedAt) && value - receivedAt > ALLOWANCE_MAX_RESET_AHEAD_MS) row.resetState = "implausible";
    else { row.resetsAt = value; row.resetState = "reported"; }
  } else row.resetState = "malformed";
  return row;
}

/** Collate before recording: two rows in one response never become last-wins green. */
export function observeAllowanceBatch(
  provider: Provider, inputs: readonly AllowanceInput[], receivedAt: number,
  previous: readonly AllowanceObservation[] = [],
): AllowanceObservation[] {
  const prior = new Map(restoreObservations(previous).filter((r) => r.provider === provider).map((r) => [r.window, r]));
  const rows = inputs.flatMap((input) => {
    const row = observeAllowance(provider, input, receivedAt, prior.get(input?.window));
    return row ? [row] : [];
  });
  return collate(rows);
}

/** Storage validation never stamps the current time or copies unknown fields. */
export function restoreObservations(raw: unknown): AllowanceObservation[] {
  if (!Array.isArray(raw)) return [];
  const rows: AllowanceObservation[] = [];
  for (const value of raw) {
    if (!record(value) || !validAllowanceIdentity(value.provider, value.window)) continue;
    if (!canonical(value)) {
      rows.push(unknownRow(value.provider as Provider, value.window, null));
      continue;
    }
    const row: AllowanceObservation = {
      provider: value.provider as Provider, window: value.window, utilization: value.utilization as number | null,
      resetsAt: value.resetsAt as number | null, resetState: value.resetState as AllowanceObservation["resetState"],
    };
    if (Object.hasOwn(value, "receivedAt")) row.receivedAt = validAllowanceTime(value.receivedAt) ? value.receivedAt : null;
    if (value.ambiguous === true) row.ambiguous = true;
    rows.push(row);
  }
  return collate(rows);
}

/** Old quota rows have no trusted receipt, even if they contain an unrelated extra property. */
export function legacyAllowanceObservations(raw: unknown): AllowanceObservation[] {
  if (!Array.isArray(raw)) return [];
  return collate(raw.flatMap((value): AllowanceObservation[] => {
    if (!record(value) || !validAllowanceIdentity(value.provider, value.window)) return [];
    const row: AllowanceObservation = {
      provider: value.provider as Provider, window: value.window,
      utilization: validAllowanceUsage(value.utilization) ? value.utilization : null,
      resetsAt: validAllowanceTime(value.resetsAt) ? value.resetsAt : null,
      resetState: !Object.hasOwn(value, "resetsAt") ? "missing" : validAllowanceTime(value.resetsAt) ? "reported" : "malformed",
    };
    return [row];
  }));
}

export function assessAllowance(
  provider: Provider, observations: readonly AllowanceObservation[], now: number,
): ProviderAllowanceAssessment {
  const rows = restoreObservations(observations);
  const windows = REQUIRED_ALLOWANCE_WINDOWS.map((window): AllowanceWindowAssessment => {
    const row = rows.find((r) => r.provider === provider && r.window === window);
    if (!row) return { window, usable: false, reasons: ["missing"] };
    const reasons: AllowanceUnknownReason[] = [];
    if (row.ambiguous) reasons.push("ambiguous");
    if (!validAllowanceUsage(row.utilization)) reasons.push("malformed_utilization");
    if (row.resetState === "missing") reasons.push("reset_missing");
    else if (row.resetState === "malformed") reasons.push("malformed_reset");
    else if (row.resetState === "implausible") reasons.push("implausible_reset");
    else if (row.resetsAt !== null) {
      if (!validAllowanceTime(now)) reasons.push("malformed_receipt");
      else if (row.resetsAt <= now) reasons.push("expired");
      else if (row.resetsAt - now > ALLOWANCE_MAX_RESET_AHEAD_MS) reasons.push("implausible_reset");
    }
    if (row.receivedAt === undefined) reasons.push("missing_receipt");
    else if (!validAllowanceTime(row.receivedAt) || !validAllowanceTime(now)) {
      if (!reasons.includes("malformed_receipt")) reasons.push("malformed_receipt");
    } else if (row.receivedAt > now) reasons.push("clock_rollback");
    else if (now - row.receivedAt > ALLOWANCE_MAX_AGE_MS) reasons.push("stale");
    return {
      window, usable: reasons.length === 0, reasons,
      ...(validAllowanceUsage(row.utilization) && { utilization: row.utilization }),
      ...(validAllowanceTime(row.resetsAt) && { resetsAt: row.resetsAt }),
      ...(validAllowanceTime(row.receivedAt) && { receivedAt: row.receivedAt }),
    };
  });
  return { provider, usable: windows.every((w) => w.usable), windows };
}

function canonical(value: unknown): value is AllowanceObservation {
  if (!record(value) || !validAllowanceIdentity(value.provider, value.window) ||
    !(value.utilization === null || validAllowanceUsage(value.utilization)) ||
    (Object.hasOwn(value, "ambiguous") && value.ambiguous !== true)) return false;
  const numeric = value.resetState === "reported" || value.resetState === "inherited";
  const empty = value.resetState === "missing" || value.resetState === "malformed" || value.resetState === "implausible";
  return (numeric && validAllowanceTime(value.resetsAt)) || (empty && value.resetsAt === null);
}
function unknownRow(provider: Provider, window: string, receivedAt: number | null): AllowanceObservation {
  return { provider, window, utilization: null, resetsAt: null, receivedAt, resetState: "malformed" };
}
function collate(rows: readonly AllowanceObservation[]): AllowanceObservation[] {
  const out = new Map<string, AllowanceObservation>();
  for (const row of rows) {
    const key = row.provider + ":" + row.window;
    const old = out.get(key);
    out.set(key, old ? { ...unknownRow(row.provider, row.window, row.receivedAt ?? null), ambiguous: true } : { ...row });
  }
  const ordered = [...out.values()].sort((a, b) => {
    const requiredA = REQUIRED_ALLOWANCE_WINDOWS.includes(a.window as RequiredAllowanceWindow);
    const requiredB = REQUIRED_ALLOWANCE_WINDOWS.includes(b.window as RequiredAllowanceWindow);
    return Number(requiredB) - Number(requiredA);
  });
  const extras = new Map<Provider, number>();
  return ordered.filter((row) => {
    if (REQUIRED_ALLOWANCE_WINDOWS.includes(row.window as RequiredAllowanceWindow)) return true;
    const count = extras.get(row.provider) ?? 0;
    extras.set(row.provider, count + 1);
    return count < MAX_WINDOWS_PER_PROVIDER - REQUIRED_ALLOWANCE_WINDOWS.length;
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
