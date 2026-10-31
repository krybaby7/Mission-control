import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ActualIdentity, WorkEvidence, WorkScope, WorkSubject } from "./provenance.js";
import type { Access, Role, RunOutcome } from "./types.js";

export type InvocationScope = WorkScope | { kind: "controller" };
export type InvocationStage = WorkEvidence["stage"] | "other";
export interface Reservation {
  jobId: string; label: string; role: Role; access: Access;
  feature?: string; optional?: true;
  scope: InvocationScope; stage: InvocationStage; baseSubject?: WorkSubject;
  reservedAt: string; candidate: Required<ActualIdentity>;
}
export interface InvocationEntry extends Reservation {
  restoration?: RestorationProof;
  observation?: { at: string; actual: Required<ActualIdentity>; outcome: RunOutcome | "thrown" };
  cleanedAt?: string;
  writeDisposition: "none" | "pending" | "adopted" | "reverted" | "uncertain";
}
export interface RecoveryRecord {
  key: string; jobId?: string; label: string; feature?: string; optional?: true; legacyMarker?: InflightMarker;
  at: string; count: number; handled?: true; resetRequested?: true; clearedCount?: true;
}
export interface InvocationJournal {
  version: 1; legacyAgentRuns: number; legacyInterruptionCounts: Record<string, number>; entries: InvocationEntry[];
  recoveries: RecoveryRecord[]; interruptionCounts: Record<string, number>;
}
export interface InvocationState { agentRuns: number; invocations?: InvocationJournal; }
export interface InflightMarker { jobId?: string; label: string; feature?: string; optional?: boolean; at: string; }
export interface RecoveryNotice extends RecoveryRecord { fresh: boolean; }
export const MAX_INVOCATIONS = 100_000;
export class InvocationPersistenceError extends Error {
  constructor(message = "Invocation history could not be saved or validated; no further AI run can start.", options?: ErrorOptions) {
    super(message, options); this.name = "InvocationPersistenceError";
  }
}
type Obj = Record<string, unknown>;
const keys = (v: Obj, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const record = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && /\S/u.test(v) && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const id = (v: unknown): v is string => text(v) && /^[A-Za-z0-9._-]+$/u.test(v);
const at = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const family = (v: unknown) => v === "claude" || v === "codex";
function identity(v: unknown): v is Required<ActualIdentity> {
  return record(v) && keys(v, ["provider", "model", "family"]) && (family(v.provider) || v.provider === "mock") && family(v.family) && text(v.model);
}
const sameIdentity = (a: Required<ActualIdentity>, b: Required<ActualIdentity>) => a.provider === b.provider && a.model === b.model && a.family === b.family;
function requireValid(ok: unknown): asserts ok { if (!ok) throw new InvocationPersistenceError(); }
function scope(v: unknown): v is InvocationScope {
  return record(v) && keys(v, v.kind === "feature" ? ["kind", "featureId"] : ["kind"]) && ((typeof v.kind === "string" && ["application", "plan", "controller"].includes(v.kind)) || (v.kind === "feature" && text(v.featureId)));
}
function subject(v: unknown, s: InvocationScope): v is WorkSubject {
  if (!record(v) || !keys(v, v.kind === "frozen_tests" ? ["kind", "featureId", "testSetId"] : v.kind === "feature_commit" ? ["kind", "featureId", "commit"] : v.kind === "plan" ? ["kind", "planHash"] : ["kind", "commit"])) return false;
  if (s.kind === "feature" && v.featureId !== s.featureId) return false;
  if (s.kind === "feature" && v.kind === "frozen_tests") return typeof v.testSetId === "string" && /^[a-f0-9]{64}$/u.test(v.testSetId);
  if (s.kind === "plan" && v.kind === "plan") return typeof v.planHash === "string" && /^[a-f0-9]{64}$/u.test(v.planHash);
  return ((s.kind === "feature" && v.kind === "feature_commit") || (s.kind === "application" && v.kind === "application_commit")) &&
    typeof v.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v.commit);
}
function validReservation(v: unknown): v is Reservation {
  if (!record(v) || !keys(v, ["jobId", "label", "role", "access", "feature", "optional", "scope", "stage", "baseSubject", "reservedAt", "candidate", "observation", "cleanedAt", "writeDisposition", "restoration"]) || !id(v.jobId) || !text(v.label) || (typeof v.role !== "string" || !["architect", "engineer", "test_author", "reviewer", "scout"].includes(v.role)) ||
      (typeof v.access !== "string" || !["read-only", "workspace-write"].includes(v.access)) || !scope(v.scope) || !at(v.reservedAt) || !identity(v.candidate)) return false;
  if (v.feature !== undefined && !text(v.feature)) return false;
  if (v.optional !== undefined && v.optional !== true) return false;
  const stages = v.scope.kind === "controller" ? ["other"] : v.scope.kind === "plan" ? ["plan_review", "other"] :
    v.scope.kind === "application" ? ["build", "fix", "final_review", "other"] : ["test_author", "build", "fix", "review", "other"];
  if (typeof v.stage !== "string" || !stages.includes(v.stage)) return false;
  if (v.scope.kind === "feature" && v.feature !== undefined && v.feature !== v.scope.featureId) return false;
  return v.baseSubject === undefined || subject(v.baseSubject, v.scope);
}
function validCounts(v: unknown): v is Record<string, number> {
  return record(v) && Object.keys(v).length <= MAX_INVOCATIONS && Object.entries(v).every(([k, n]) => text(k) && integer(n));
}
function validMarker(v: unknown): v is InflightMarker {
  return record(v) && keys(v, ["jobId", "label", "feature", "optional", "at"]) && text(v.label) && at(v.at) && (v.jobId === undefined || id(v.jobId)) &&
    (v.feature === undefined || text(v.feature)) && (v.optional === undefined || typeof v.optional === "boolean");
}
function legacyKey(m: InflightMarker): string {
  return "legacy:" + createHash("sha256").update(JSON.stringify([m.label, m.feature ?? null, m.at]), "utf8").digest("hex");
}
function count(j: InvocationJournal): number {
  const n = j.legacyAgentRuns + j.entries.length + j.recoveries.filter(r => r.jobId === undefined).length;
  requireValid(integer(n)); return n;
}
/** Present malformed history is never replaced with an empty history. Returned data is detached. */
export function journalOf(m: InvocationState, baselineCounts: Record<string, number> = {}): InvocationJournal {
  requireValid(integer(m.agentRuns));
  if (m.invocations === undefined) {
    requireValid(validCounts(baselineCounts));
    return { version: 1, legacyAgentRuns: m.agentRuns, legacyInterruptionCounts: { ...baselineCounts }, entries: [], recoveries: [], interruptionCounts: { ...baselineCounts } };
  }
  const raw: unknown = m.invocations;
  requireValid(record(raw) && keys(raw, ["version", "legacyAgentRuns", "legacyInterruptionCounts", "entries", "recoveries", "interruptionCounts"]) && validCounts(raw.legacyInterruptionCounts) && raw.version === 1 && integer(raw.legacyAgentRuns) && Array.isArray(raw.entries) &&
    raw.entries.length <= MAX_INVOCATIONS && Array.isArray(raw.recoveries) && raw.recoveries.length <= MAX_INVOCATIONS && validCounts(raw.interruptionCounts));
  const jobs = new Map<string, InvocationEntry>();
  for (const entry of raw.entries) {
    requireValid(validReservation(entry) && record(entry) && !jobs.has(entry.jobId));
    requireValid(entry.access === "read-only" ? entry.writeDisposition === "none" :
      typeof entry.writeDisposition === "string" && ["pending", "adopted", "reverted", "uncertain"].includes(entry.writeDisposition));
    if (entry.observation !== undefined) {
      const o = entry.observation;
      requireValid(record(o) && keys(o, ["at", "actual", "outcome"]) && at(o.at) && o.at >= entry.reservedAt && identity(o.actual) && sameIdentity(o.actual, entry.candidate) &&
        typeof o.outcome === "string" && ["ok", "failed", "limited", "timeout", "aborted", "auth", "crashed", "thrown"].includes(o.outcome));
    }
    if (entry.cleanedAt !== undefined) requireValid(at(entry.cleanedAt) && record(entry.observation) && entry.cleanedAt >= String(entry.observation.at));
    if (Object.hasOwn(entry, "restoration")) requireValid(validRestoration(entry.restoration, entry) &&
      entry.access === "workspace-write" && entry.writeDisposition === "reverted" && entry.cleanedAt === undefined);
    if (entry.writeDisposition === "adopted" || entry.writeDisposition === "reverted") requireValid(entry.cleanedAt !== undefined || entry.restoration !== undefined);
    jobs.set(entry.jobId, entry as unknown as InvocationEntry);
  }
  const recoveryKeys = new Set<string>();
  let expectedCounts = { ...raw.legacyInterruptionCounts };
  let priorRecoveryAt = "";
  const resetPending = new Set<string>();
  const unhandledLabels = new Set<string>();
  for (const r of raw.recoveries) {
    requireValid(record(r) && keys(r, ["key", "jobId", "label", "feature", "optional", "legacyMarker", "at", "count", "handled", "resetRequested", "clearedCount"]) && text(r.label) && at(r.at) && integer(r.count) && r.count > 0 && typeof r.key === "string" && !recoveryKeys.has(r.key) &&
      (r.feature === undefined || text(r.feature)) && (r.optional === undefined || r.optional === true) && (r.handled === undefined || r.handled === true) && (r.clearedCount === undefined || (r.clearedCount === true && r.handled === true)) && (r.resetRequested === undefined || (r.resetRequested === true && r.handled === true)));
    requireValid(r.at >= priorRecoveryAt); priorRecoveryAt = r.at;
    const preceding = Object.hasOwn(expectedCounts, r.label) ? expectedCounts[r.label]! : 0;
    requireValid(r.count === preceding + 1);
    if (!r.handled) unhandledLabels.add(r.label);
    if (r.resetRequested) resetPending.add(r.label);
    if (r.clearedCount) {
      requireValid(resetPending.has(r.label) && !unhandledLabels.has(r.label));
      resetPending.delete(r.label);
    }
    expectedCounts = { ...expectedCounts, [r.label]: r.clearedCount ? 0 : r.count };
    if (r.jobId !== undefined) {
      requireValid(id(r.jobId));
      const e = jobs.get(r.jobId);
      requireValid(e && r.key === "job:" + r.jobId && r.label === e.label && r.feature === e.feature && r.optional === e.optional &&
        r.at >= (e.observation?.at ?? e.reservedAt) && r.legacyMarker === undefined && e.cleanedAt === undefined && (e.access === "read-only" || e.writeDisposition === "uncertain" || (e.writeDisposition === "reverted" && e.restoration !== undefined && e.restoration.at >= r.at)));
    } else requireValid(validMarker(r.legacyMarker) && r.legacyMarker.jobId === undefined && r.key === legacyKey(r.legacyMarker) && r.label === r.legacyMarker.label && r.feature === r.legacyMarker.feature && !!r.optional === !!r.legacyMarker.optional && r.at >= r.legacyMarker.at);
    recoveryKeys.add(r.key);
  }
  const recordedCounts = raw.interruptionCounts;
  requireValid(Object.keys(recordedCounts).length === Object.keys(expectedCounts).length && Object.entries(expectedCounts).every(([label, value]) => Object.hasOwn(recordedCounts, label) && recordedCounts[label] === value));
  const journal = raw as unknown as InvocationJournal;
  requireValid(count(journal) === m.agentRuns);
  return structuredClone(journal);
}
function transaction<T>(m: InvocationState, save: () => void, edit: (j: InvocationJournal) => T, baselineCounts = {}): T {
  const previous = m.invocations; const oldCount = m.agentRuns;
  const journal = journalOf(m, baselineCounts);
  try {
    const result = edit(journal);
    m.invocations = journal; m.agentRuns = count(journal);
    journalOf(m); save(); return result;
  } catch (cause) {
    if (previous === undefined) delete m.invocations; else m.invocations = previous;
    m.agentRuns = oldCount;
    if (cause instanceof InvocationPersistenceError) throw cause;
    throw new InvocationPersistenceError(undefined, { cause });
  }
}
export function reserveInvocation(m: InvocationState, r: Reservation, cap: number, save: () => void): boolean {
  const j = journalOf(m); // corruption must not turn into an optional skip
  requireValid(integer(cap) && validReservation(r) && !["observation", "cleanedAt", "writeDisposition", "restoration"].some(k => Object.hasOwn(r, k)) && !j.entries.some(e => e.jobId === r.jobId));
  if (m.agentRuns >= cap) return false;
  requireValid(j.entries.length < MAX_INVOCATIONS);
  return transaction(m, save, next => { next.entries.push({ ...structuredClone(r), writeDisposition: r.access === "read-only" ? "none" : "pending" }); return true; });
}
function entry(j: InvocationJournal, jobId: string): InvocationEntry {
  const e = j.entries.find(e => e.jobId === jobId); requireValid(e); return e;
}
export function observeInvocation(m: InvocationState, jobId: string, actual: Required<ActualIdentity>, outcome: RunOutcome | "thrown", time: string, save: () => void): void {
  transaction(m, save, j => {
    const e = entry(j, jobId); requireValid(e.observation === undefined && e.cleanedAt === undefined && e.restoration === undefined);
    e.observation = { actual: { ...actual }, outcome, at: time };
  });
}
export function cleanInvocation(m: InvocationState, jobId: string, time: string, save: () => void): void {
  transaction(m, save, j => {
    const e = entry(j, jobId); requireValid(e.observation !== undefined && e.cleanedAt === undefined && e.restoration === undefined && !j.recoveries.some(r => r.jobId === jobId));
    e.cleanedAt = time;
  });
}
/** Replays unacknowledged decisions, but accounts their attempt/tally exactly once. */
export function recoverInvocations(m: InvocationState, marker: InflightMarker | undefined, baselineCounts: Record<string, number>, time: string, save: () => void): RecoveryNotice[] {
  requireValid(at(time) && (marker === undefined || validMarker(marker)));
  const current = journalOf(m, baselineCounts);
  if (marker?.jobId !== undefined) {
    const e = current.entries.find(e => e.jobId === marker.jobId);
    requireValid(e && e.label === marker.label && e.feature === marker.feature && e.reservedAt === marker.at && !!e.optional === !!marker.optional);
  }
  const fresh = new Set<string>();
  const candidates = current.entries.filter(e => e.cleanedAt === undefined && e.restoration === undefined && !current.recoveries.some(r => r.jobId === e.jobId));
  const legacy = marker && marker.jobId === undefined && !current.recoveries.some(r => r.key === legacyKey(marker)) ? marker : undefined;
  if (candidates.length || legacy || m.invocations === undefined) {
    transaction(m, save, j => {
      const add = (key: string, label: string, details: Pick<RecoveryRecord, "jobId" | "feature" | "optional" | "legacyMarker">) => {
        requireValid(j.recoveries.length < MAX_INVOCATIONS);
        const n = (Object.hasOwn(j.interruptionCounts, label) ? j.interruptionCounts[label]! : 0) + 1;
        requireValid(integer(n));
        j.interruptionCounts = { ...j.interruptionCounts, [label]: n };
        j.recoveries.push({ key, label, ...details, at: time, count: n }); fresh.add(key);
      };
      for (const old of candidates) {
        const e = entry(j, old.jobId);
        if (e.access === "workspace-write") e.writeDisposition = "uncertain";
        add("job:" + e.jobId, e.label, { jobId: e.jobId, ...(e.feature !== undefined && { feature: e.feature }), ...(e.optional && { optional: true }) });
      }
      if (legacy) add(legacyKey(legacy), legacy.label, { legacyMarker: { ...legacy }, ...(legacy.feature !== undefined && { feature: legacy.feature }), ...(legacy.optional && { optional: true }) });
    }, baselineCounts);
  }
  return journalOf(m).recoveries.filter(r => !r.handled).map(r => ({ ...r, fresh: fresh.has(r.key) }));
}
/** Called only after the controller's recovery decision/effect was durably completed. */
export function settleRecovery(m: InvocationState, key: string, resetCount: boolean, save: () => void): void {
  transaction(m, save, j => {
    const r = j.recoveries.find(r => r.key === key); requireValid(r);
    r.handled = true;
    if (resetCount) r.resetRequested = true;
    const related = j.recoveries.filter(x => x.label === r.label);
    const last = related.at(-1)!;
    const sinceClear = related.slice(related.findLastIndex(x => x.clearedCount) + 1);
    if (related.every(x => x.handled) && sinceClear.some(x => x.resetRequested)) {
      last.clearedCount = true;
      j.interruptionCounts = { ...j.interruptionCounts, [r.label]: 0 };
    }
  });
}

/** Controller-owned proof of an exact full checkpoint restore after cleanup; never an AI observation. */
export interface RestorationProof {
  at: string; checkpointId: string; subject: Extract<WorkSubject, { kind: "feature_commit" | "application_commit" }>; cleanupComplete: true;
}
function validRestoration(v: unknown, entry: Reservation & { observation?: InvocationEntry["observation"] }): v is RestorationProof {
  return record(v) && keys(v, ["at", "checkpointId", "subject", "cleanupComplete"]) && at(v.at) && v.at >= entry.reservedAt &&
    (entry.observation === undefined || v.at >= entry.observation.at) && typeof v.checkpointId === "string" && /^[a-f0-9]{64}$/u.test(v.checkpointId) &&
    v.cleanupComplete === true && subject(v.subject, entry.scope) && (v.subject.kind === "feature_commit" || v.subject.kind === "application_commit") &&
    (entry.scope.kind === "feature" || entry.scope.kind === "application");
}
/** Only after controller reap and a successful exact full checkpoint restore. Never a provider observation. */
export function restoreUnsettledInvocations(m: InvocationState, jobIds: string[], proof: RestorationProof, save: () => void): void {
  requireValid(Array.isArray(jobIds) && jobIds.length > 0 && jobIds.length <= MAX_INVOCATIONS && jobIds.every(id) && new Set(jobIds).size === jobIds.length);
  transaction(m, save, j => {
    const indexed = new Map(j.entries.map(e => [e.jobId, e]));
    const rows = jobIds.map(id => {
      const e = indexed.get(id);
      requireValid(e && e.access === "workspace-write" && e.cleanedAt === undefined && validRestoration(proof, e) &&
        (e.restoration === undefined ? e.writeDisposition === "pending" || e.writeDisposition === "uncertain" : e.writeDisposition === "reverted" && isDeepStrictEqual(e.restoration, proof)));
      requireValid(j.recoveries.every(r => r.jobId !== id || proof.at >= r.at));
      return e;
    });
    for (const e of rows) { e.restoration = structuredClone(proof); e.writeDisposition = "reverted"; }
  });
}
