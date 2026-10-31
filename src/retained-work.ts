// Detached retained-work transitions. The controller owns scanning and atomic persistence.
import { createHash } from "node:crypto";
import { journalOf, type InvocationEntry, type InvocationJournal } from "./invocations.js";
import type { ActualIdentity, ApplicationBaseline, ApplicationFeatureRef, FrozenMember, Provenance, RetainedSnapshot, WorkEvidence, WorkScope, WorkSubject } from "./provenance.js";

export type FileMode = "100644" | "100755";
export interface WorkCapture {
  scope: WorkScope; root: string; universe: "git-source-v1"; head: string | null;
  files: { path: string; sha256: string; mode: FileMode }[]; complete: boolean;
}
export type WriterStage = "build" | "fix" | "test_author";
export interface TrackedMember {
  path: string; sha256: string | null; mode: FileMode | null; jobIds: string[]; complete: boolean;
}
export interface WriterIntent {
  jobId: string; stage: WriterStage; before: WorkCapture; frozenPaths: string[];
  phase: "active" | "finished"; retention?: "none" | "possible" | "unknown";
  /** Controller-reaped interruption; carries no actual identity or cleanup acknowledgement. */
  recovery?: { key: string; at: string; captureDigest: string };
}
export interface RetainedCheckpoint {
  id: string; capture: WorkCapture; liveWriterIds: string[]; members: TrackedMember[]; complete: boolean;
  selection: { subject: WorkSubject; revision: number | null };
  writesSelection?: { subject: WorkSubject; revision: number | null };
  /** Exact pending intent membership at this capture; absence is a legacy checkpoint. */
  unresolvedWriterIds?: string[];
}
export interface ScopeTracking {
  scope: WorkScope; capture: WorkCapture; liveWriterIds: string[]; members: TrackedMember[];
  complete: boolean; intents: WriterIntent[]; checkpoints: RetainedCheckpoint[]; baseCheckpointId?: string;
}
export interface TrackingState { version: 1; scopes: ScopeTracking[]; }
export interface TrackingLimits {
  maxScopes: number; maxJobs: number; maxFiles: number; maxCheckpoints: number; maxReferences: number;
}
export type TrackingPlan<T extends object = object> =
  | ({ ok: true; state: TrackingState } & T)
  | { ok: false; reason: string };
export type Disposition = { jobId: string; disposition: "adopted" | "reverted" };
export interface FreshBaselineProof { head: string; beforeMissionWrites: true; noRetainedAiWriters: true; }
type Obj = Record<string, unknown>;

const DEFAULT_LIMITS: TrackingLimits = { maxScopes: 64, maxJobs: 10_000, maxFiles: 100_000, maxCheckpoints: 2_000, maxReferences: 200_000 };
const record = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (v: Obj, k: string) => Object.hasOwn(v, k);
const exact = (v: Obj, allowed: string[], required = allowed) => Object.keys(v).every(k => allowed.includes(k)) && required.every(k => own(v, k));
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && /\S/u.test(v) && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const id = (v: unknown): v is string => text(v) && /^[A-Za-z0-9._-]+$/u.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const commit = (v: unknown): v is string => typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v);
const path = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && /\S/u.test(v) && !/[\\\u0000-\u001f\u007f-\u009f]/u.test(v) && !v.startsWith("/") && !/^[a-z]:/iu.test(v) && v.split("/").every(p => p !== "" && p !== "." && p !== "..");
const root = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && path(v.slice(1));
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const stage = (v: unknown): v is WriterStage => v === "build" || v === "fix" || v === "test_author";
const mode = (v: unknown): v is FileMode => v === "100644" || v === "100755";
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const scopeKey = (v: WorkScope): string => v.kind === "feature" ? "feature:" + v.featureId : v.kind;
function validScope(v: unknown): v is WorkScope {
  return record(v) && (v.kind === "application" ? exact(v, ["kind"]) : v.kind === "feature" && exact(v, ["kind", "featureId"]) && text(v.featureId));
}
class InvalidTracking extends Error { constructor(readonly code: string) { super(code); } }
function requireValid(v: unknown, code = "invalid_tracking"): asserts v { if (!v) throw new InvalidTracking(code); }
function bounds(raw: Partial<TrackingLimits> = {}): TrackingLimits {
  requireValid(record(raw) && Object.keys(raw).every(k => Object.hasOwn(DEFAULT_LIMITS, k)), "invalid_limits");
  const out = { ...DEFAULT_LIMITS, ...raw };
  for (const value of Object.values(out)) requireValid(positive(value), "invalid_limits");
  return out;
}
class Budget {
  scopes = 0; jobs = 0; files = 0; checkpoints = 0; references = 0;
  constructor(readonly limits: TrackingLimits) {}
  charge(kind: "scopes" | "jobs" | "files" | "checkpoints" | "references", count: number): void {
    const maximum = this.limits[{ scopes: "maxScopes", jobs: "maxJobs", files: "maxFiles", checkpoints: "maxCheckpoints", references: "maxReferences" }[kind] as keyof TrackingLimits];
    requireValid(Number.isSafeInteger(count) && count >= 0 && count <= maximum - this[kind], "tracking_budget_exceeded");
    this[kind] += count;
  }
  array(v: unknown, kind: "scopes" | "jobs" | "files" | "checkpoints" | "references"): asserts v is unknown[] {
    requireValid(Array.isArray(v)); this.charge(kind, v.length);
  }
}
function strings(v: unknown, budget: Budget, validate: (v: unknown) => boolean = id): asserts v is string[] {
  budget.array(v, "references");
  requireValid(v.every(validate) && new Set(v).size === v.length);
}
function validateCapture(v: unknown, budget: Budget): asserts v is WorkCapture {
  requireValid(record(v) && exact(v, ["scope", "root", "universe", "head", "files", "complete"]) && validScope(v.scope)
    && root(v.root) && v.universe === "git-source-v1" && (v.head === null || commit(v.head)) && typeof v.complete === "boolean"
    && (!v.complete || v.head !== null), "invalid_capture");
  budget.array(v.files, "files");
  let previous = "";
  for (const f of v.files) {
    requireValid(record(f) && exact(f, ["path", "sha256", "mode"]) && path(f.path) && hash(f.sha256) && mode(f.mode) && f.path > previous, "invalid_capture");
    previous = f.path;
  }
}
function boundTo(a: WorkCapture, b: WorkCapture): boolean {
  return scopeKey(a.scope) === scopeKey(b.scope) && a.root === b.root && a.universe === b.universe;
}
function sameFile(a: WorkCapture["files"][number] | undefined, b: WorkCapture["files"][number] | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.path === b.path && a.sha256 === b.sha256 && a.mode === b.mode;
}
function sameFiles(a: WorkCapture, b: WorkCapture): boolean {
  return boundTo(a, b) && a.files.length === b.files.length && a.files.every((file, i) => sameFile(file, b.files[i]));
}
function identical(a: WorkCapture, b: WorkCapture): boolean { return a.complete && b.complete && a.head === b.head && sameFiles(a, b); }
function validateMembers(v: unknown, budget: Budget): asserts v is TrackedMember[] {
  budget.array(v, "files"); let previous = "";
  for (const member of v) {
    requireValid(record(member) && exact(member, ["path", "sha256", "mode", "jobIds", "complete"]) && path(member.path) && member.path > previous
      && ((member.sha256 === null && member.mode === null) || (hash(member.sha256) && mode(member.mode))) && typeof member.complete === "boolean");
    strings(member.jobIds, budget); previous = member.path;
  }
}
function validateSubject(v: unknown, scope: WorkScope): v is WorkSubject {
  if (!record(v)) return false;
  if (scope.kind === "application") return exact(v, ["kind", "commit"]) && v.kind === "application_commit" && commit(v.commit);
  return v.featureId === (scope.kind === "feature" ? scope.featureId : undefined) &&
    (v.kind === "feature_commit" ? exact(v, ["kind", "featureId", "commit"]) && commit(v.commit) :
      v.kind === "frozen_tests" && exact(v, ["kind", "featureId", "testSetId"]) && hash(v.testSetId));
}
function tracking(raw: unknown, budget: Budget): TrackingState {
  requireValid(record(raw) && exact(raw, ["version", "scopes"]) && raw.version === 1);
  budget.array(raw.scopes, "scopes"); const scopeIds = new Set<string>(), jobs = new Set<string>(), checkpoints = new Set<string>();
  for (const value of raw.scopes) {
    requireValid(record(value) && exact(value, ["scope", "capture", "liveWriterIds", "members", "complete", "intents", "checkpoints", "baseCheckpointId"], ["scope", "capture", "liveWriterIds", "members", "complete", "intents", "checkpoints"])
      && validScope(value.scope) && typeof value.complete === "boolean");
    const key = scopeKey(value.scope); requireValid(!scopeIds.has(key)); scopeIds.add(key);
    validateCapture(value.capture, budget); requireValid(scopeKey(value.capture.scope) === key);
    strings(value.liveWriterIds, budget); validateMembers(value.members, budget);
    budget.array(value.intents, "jobs");
    for (const intent of value.intents) {
      requireValid(record(intent) && exact(intent, ["jobId", "stage", "before", "frozenPaths", "phase", "retention", "recovery"], ["jobId", "stage", "before", "frozenPaths", "phase"])
        && id(intent.jobId) && !jobs.has(intent.jobId) && stage(intent.stage) && (value.scope.kind === "feature" || intent.stage !== "test_author")
        && (intent.phase === "active" ? !own(intent, "retention") : intent.phase === "finished" && ["none", "possible", "unknown"].includes(String(intent.retention))));
      if (own(intent,"recovery")) requireValid(intent.phase==="finished" && intent.retention==="unknown" && record(intent.recovery)
        && exact(intent.recovery,["key","at","captureDigest"]) && intent.recovery.key==="job:"+intent.jobId && instant(intent.recovery.at) && hash(intent.recovery.captureDigest));
      jobs.add(intent.jobId); validateCapture(intent.before, budget); requireValid(boundTo(value.capture, intent.before)); strings(intent.frozenPaths, budget, path);
    }
    budget.array(value.checkpoints, "checkpoints");
    for (const cp of value.checkpoints) {
      requireValid(record(cp) && exact(cp, ["id", "capture", "liveWriterIds", "members", "complete", "selection", "writesSelection", "unresolvedWriterIds"], ["id", "capture", "liveWriterIds", "members", "complete", "selection"]) && hash(cp.id) && !checkpoints.has(cp.id)
        && typeof cp.complete === "boolean" && record(cp.selection) && exact(cp.selection, ["subject", "revision"]) && validateSubject(cp.selection.subject, value.scope)
        && (cp.selection.revision === null || positive(cp.selection.revision)));
      if (own(cp, "writesSelection")) requireValid(record(cp.writesSelection) && exact(cp.writesSelection, ["subject", "revision"])
        && validateSubject(cp.writesSelection.subject, value.scope) && cp.writesSelection.subject.kind === "feature_commit"
        && (cp.writesSelection.revision === null || positive(cp.writesSelection.revision)));
      if (own(cp,"unresolvedWriterIds")) {
        strings(cp.unresolvedWriterIds,budget); requireValid(cp.unresolvedWriterIds.length===0 || cp.complete===false);
      }
      checkpoints.add(cp.id); validateCapture(cp.capture, budget); requireValid(boundTo(value.capture, cp.capture));
      strings(cp.liveWriterIds, budget); validateMembers(cp.members, budget);
      requireValid(cp.id === checkpointId(cp as unknown as RetainedCheckpoint), "invalid_checkpoint");
      const checkpointJobs = new Set(cp.liveWriterIds as string[]);
      requireValid((cp.members as TrackedMember[]).every(m => m.jobIds.every(id => checkpointJobs.has(id))));
    }
    const scopes = value as unknown as ScopeTracking;
    let basis: RetainedCheckpoint | undefined;
    if (scopes.checkpoints.length > 0) {
      requireValid(own(value, "baseCheckpointId") && hash(value.baseCheckpointId));
      basis = scopes.checkpoints.find(cp => cp.id === value.baseCheckpointId); requireValid(basis);
    } else requireValid(!own(value, "baseCheckpointId"));
    if (basis?.unresolvedWriterIds?.length) requireValid(!scopes.complete && basis.unresolvedWriterIds.every(id=>scopes.intents.some(i=>i.jobId===id)));
    if (scopes.intents.some(i=>i.recovery)) requireValid(!scopes.complete);
    const captured = scopes.intents.filter(i => i.phase === "finished" && i.retention !== "none").map(i => i.jobId);
    const live = new Set(scopes.liveWriterIds), permitted = new Set([...(basis?.liveWriterIds ?? []), ...captured]);
    requireValid((basis?.liveWriterIds ?? []).every(id => live.has(id)) && captured.every(id => live.has(id)) &&
      scopes.liveWriterIds.every(id => permitted.has(id)));
    requireValid(scopes.members.every(m => m.jobIds.every(id => live.has(id))));
    if (basis) {
      // Known linkage survives changes and tombstones; only full restoration changes this basis.
      const current = new Map(scopes.members.map(m => [m.path, { member: m, authors: new Set(m.jobIds) }]));
      for (const member of basis.members) {
        const carried = current.get(member.path);
        requireValid(carried && member.jobIds.every(id => carried.authors.has(id)) && (member.complete || !carried.member.complete));
      }
      if (scopes.complete && scopes.intents.length === 0) requireValid(identical(scopes.capture, basis.capture)
        && same(canonicalMembers(scopes.members), canonicalMembers(basis.members)));
    }
  }
  return structuredClone(raw) as unknown as TrackingState;
}
function selected(state: TrackingState, scope: WorkScope): ScopeTracking {
  requireValid(validScope(scope), "invalid_scope");
  const found = state.scopes.find(v => scopeKey(v.scope) === scopeKey(scope));
  requireValid(found, "missing_scope"); return found;
}
function validatedJournal(raw: InvocationJournal, budget: Budget): InvocationJournal {
  requireValid(record(raw) && Array.isArray(raw.entries) && Array.isArray(raw.recoveries), "invalid_journal");
  budget.array(raw.entries, "jobs"); budget.array(raw.recoveries, "references");
  for (const values of [raw.legacyInterruptionCounts, raw.interruptionCounts]) {
    requireValid(record(values), "invalid_journal"); budget.charge("references", Object.keys(values).length);
  }
  let parsed: InvocationJournal;
  try { parsed = journalOf({ agentRuns: raw.legacyAgentRuns + raw.entries.length + raw.recoveries.filter(r => r.jobId === undefined).length, invocations: raw }); }
  catch { throw new InvalidTracking("invalid_journal"); }
  for (const entry of parsed.entries) if (entry.observation) {
    const actual = entry.observation.actual;
    requireValid(actual.provider === "mock" || actual.provider === actual.family, "invalid_actual_identity");
  }
  return parsed;
}
function observed(entries: ReadonlyMap<string, InvocationEntry>, jobId: string, scope: WorkScope, writerStage?: WriterStage): InvocationEntry {
  const entry = entries.get(jobId);
  requireValid(entry && entry.access === "workspace-write" && scopeKey(entry.scope as WorkScope) === scopeKey(scope) && stage(entry.stage)
    && (writerStage === undefined || entry.stage === writerStage) && entry.observation, "missing_writer_observation");
  return entry;
}
function safe<T extends object>(limits: Partial<TrackingLimits> | undefined, action: (budget: Budget) => TrackingPlan<T>): TrackingPlan<T> {
  try { return action(new Budget(bounds(limits))); }
  catch (e) { return { ok: false, reason: e instanceof InvalidTracking ? e.code : "invalid_tracking" }; }
}
function output<T extends object>(state: TrackingState, budget: Budget, extra: T): TrackingPlan<T> {
  tracking(state, new Budget(budget.limits)); return { ok: true, state, ...extra };
}
function unique(values: string[]): string[] { return [...new Set(values)]; }
function sortMembers(values: TrackedMember[]): TrackedMember[] { return values.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
export function initializeTracking(capture: WorkCapture, opts: { state?: unknown; freshBaseline?: FreshBaselineProof } = {}, limits?: Partial<TrackingLimits>): TrackingPlan {
  return safe(limits, (budget: Budget) => {
    validateCapture(capture, budget); requireValid(record(opts) && exact(opts, ["state", "freshBaseline"], []), "invalid_initialization");
    const state = own(opts, "state") ? tracking(opts.state, budget) : { version: 1 as const, scopes: [] };
    requireValid(!state.scopes.some(s => scopeKey(s.scope) === scopeKey(capture.scope)), "scope_already_initialized");
    const proof = opts.freshBaseline;
    if (own(opts, "freshBaseline")) requireValid(record(proof) && exact(proof, ["head", "beforeMissionWrites", "noRetainedAiWriters"])
      && proof.beforeMissionWrites === true && proof.noRetainedAiWriters === true && commit(proof.head) && proof.head === capture.head && capture.complete, "invalid_baseline_proof");
    state.scopes.push({ scope: structuredClone(capture.scope), capture: structuredClone(capture), liveWriterIds: [], members: [], complete: proof !== undefined,
      intents: [], checkpoints: [] });
    return output(state, budget, {});
  });
}
export function beginWriter(raw: unknown, args: { jobId: string; scope: WorkScope; stage: string; before: WorkCapture; frozenPaths: string[] }, limits?: Partial<TrackingLimits>): TrackingPlan {
  return safe(limits, (budget: Budget) => {
    const state = tracking(raw, budget); validateCapture(args.before, budget); strings(args.frozenPaths, budget, path);
    requireValid(id(args.jobId) && validScope(args.scope) && stage(args.stage) && (args.scope.kind === "feature" || args.stage !== "test_author"), "invalid_writer");
    const scope = selected(state, args.scope);
    requireValid(boundTo(scope.capture, args.before) && scopeKey(args.scope) === scopeKey(args.before.scope), "capture_binding_mismatch");
    requireValid(!state.scopes.some(s => s.intents.some(i => i.jobId === args.jobId) || s.liveWriterIds.includes(args.jobId)
      || s.checkpoints.some(cp => cp.liveWriterIds.includes(args.jobId) || cp.unresolvedWriterIds?.includes(args.jobId))), "conflicting_job_id");
    requireValid(!scope.intents.some(i => i.phase === "active"), "writer_already_active");
    if (!identical(scope.capture, args.before)) scope.complete = false;
    scope.capture = structuredClone(args.before);
    scope.intents.push({ jobId: args.jobId, stage: args.stage, before: structuredClone(args.before), frozenPaths: [...args.frozenPaths], phase: "active" });
    return output(state, budget, {});
  });
}
export function finishWriter(raw: unknown, args: { jobId: string; after: WorkCapture; journal: InvocationJournal; testPaths?: string[] }, limits?: Partial<TrackingLimits>): TrackingPlan<{ retention: "none" | "possible" | "unknown" }> {
  return safe(limits, (budget: Budget) => {
    const state = tracking(raw, budget); validateCapture(args.after, budget);
    const journal = validatedJournal(args.journal, budget);
    const entries = new Map(journal.entries.map(e => [e.jobId, e]));
    if (args.testPaths !== undefined) strings(args.testPaths, budget, path);
    const scope = state.scopes.find(s => s.intents.some(i => i.jobId === args.jobId));
    requireValid(scope, "missing_writer_intent");
    const intent = scope.intents.find(i => i.jobId === args.jobId)!;
    requireValid(intent.phase === "active", "writer_already_finished");
    observed(entries, args.jobId, scope.scope, intent.stage);
    requireValid(boundTo(scope.capture, args.after) && boundTo(intent.before, args.after), "capture_binding_mismatch");
    const retention = identical(intent.before, args.after) ? "none" : intent.before.complete && args.after.complete ? "possible" : "unknown";
    if (retention === "unknown") scope.complete = false;
    if (retention !== "none") scope.liveWriterIds = unique([...scope.liveWriterIds, args.jobId]);
    const oldFiles = new Map(intent.before.files.map(f => [f.path, f]));
    const newFiles = new Map(args.after.files.map(f => [f.path, f]));
    const members = new Map(scope.members.map(m => [m.path, m]));
    const testPaths = new Set(args.testPaths ?? []), frozenPaths = new Set(intent.frozenPaths);
    const generated = new Budget(budget.limits);
    const priorByContent = new Map<string, { authors: Set<string>; complete: boolean }>();
    for (const member of scope.members) {
      if (!testPaths.has(member.path)) continue;
      const key = member.sha256 + ":" + member.mode;
      const group = priorByContent.get(key) ?? { authors: new Set<string>(), complete: true };
      for (const id of member.jobIds) group.authors.add(id);
      group.complete &&= member.complete; priorByContent.set(key, group);
    }
    for (const p of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
      const old = oldFiles.get(p), next = newFiles.get(p);
      if (sameFile(old, next)) continue;
      const prior = members.get(p);
      const source = !old && next ? priorByContent.get(next.sha256 + ":" + next.mode) : undefined;
      generated.charge("references", (prior?.jobIds.length ?? 0) + (source?.authors.size ?? 0) + 1);
      const oldAuthors = unique([...(prior?.jobIds ?? []), ...(source?.authors ?? [])]);
      const isAuthor = intent.stage === "test_author" && testPaths.has(p);
      if (intent.stage === "test_author" && !isAuthor) scope.complete = false;
      const complete = retention !== "unknown" && prior?.complete !== false
        && (old === undefined && source === undefined || prior?.complete === true || source?.complete === true) && isAuthor;
      members.set(p, { path: p, sha256: next?.sha256 ?? null, mode: next?.mode ?? null,
        jobIds: unique([...oldAuthors, ...(isAuthor ? [args.jobId] : [])]), complete });
      if (!isAuthor && frozenPaths.has(p)) { members.get(p)!.complete = false; scope.complete = false; }
    }
    scope.members = sortMembers([...members.values()]); scope.capture = structuredClone(args.after);
    intent.phase = "finished"; intent.retention = retention;
    return output(state, budget, { retention });
  });
}

function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}
function validActual(v: unknown): v is ActualIdentity {
  return record(v) && exact(v, ["provider", "model", "family"], []) &&
    (!own(v, "provider") || ["claude", "codex", "mock"].includes(String(v.provider))) &&
    (!own(v, "model") || text(v.model)) && (!own(v, "family") || v.family === "claude" || v.family === "codex") &&
    (!own(v, "provider") || !own(v, "family") || v.provider === "mock" || v.provider === v.family);
}
function completeActual(v: ActualIdentity | undefined): v is Required<ActualIdentity> {
  return v?.provider !== undefined && v.model !== undefined && v.family !== undefined && validActual(v);
}
function historyScope(v: unknown): v is WorkScope {
  return validScope(v) || record(v) && exact(v, ["kind"]) && v.kind === "plan";
}
function historySubject(v: unknown, scope: WorkScope): v is WorkSubject {
  return scope.kind === "plan" ? record(v) && exact(v, ["kind", "planHash"]) && v.kind === "plan" && hash(v.planHash) : validateSubject(v, scope);
}
function subjectScope(v: WorkSubject): WorkScope {
  return v.kind === "feature_commit" || v.kind === "frozen_tests" ? { kind: "feature", featureId: v.featureId } : { kind: v.kind === "plan" ? "plan" : "application" };
}
function canonicalSubject(v: WorkSubject): WorkSubject {
  if (v.kind === "feature_commit") return { kind: v.kind, featureId: v.featureId, commit: v.commit };
  if (v.kind === "frozen_tests") return { kind: v.kind, featureId: v.featureId, testSetId: v.testSetId };
  if (v.kind === "application_commit") return { kind: v.kind, commit: v.commit };
  return { kind: v.kind, planHash: v.planHash };
}
function sameSubject(a: WorkSubject, b: WorkSubject): boolean { return same(canonicalSubject(a), canonicalSubject(b)); }
function revisionOf(v: RetainedSnapshot): number | null { return Object.hasOwn(v, "revision") ? v.revision! : null; }
function mutationProvenance(raw: unknown, budget: Budget): Provenance {
  if (raw === undefined) return { version: 1, entries: [], retained: [] };
  requireValid(record(raw) && exact(raw, ["version", "entries", "retained"], ["version", "entries"]) && raw.version === 1, "invalid_provenance");
  budget.array(raw.entries, "jobs"); const entries = new Map<string, WorkEvidence>();
  for (const value of raw.entries) {
    requireValid(record(value) && exact(value, ["jobId", "scope", "stage", "actual", "outcome", "at", "subject"], ["jobId", "scope", "stage", "outcome", "at"])
      && id(value.jobId) && !entries.has(value.jobId) && historyScope(value.scope) && instant(value.at)
      && ["completed", "incomplete", "failed"].includes(String(value.outcome)), "invalid_provenance");
    const allowed = value.scope.kind === "plan" ? ["plan_review"] : value.scope.kind === "application" ? ["build", "fix", "final_review"] : ["build", "fix", "test_author", "review"];
    requireValid(allowed.includes(String(value.stage)) && (!own(value, "actual") || validActual(value.actual))
      && (!own(value, "subject") || historySubject(value.subject, value.scope)) && (value.outcome !== "completed" || own(value, "subject")), "invalid_provenance");
    if (own(value, "subject")) {
      const queried = value.subject as WorkSubject;
      requireValid(value.stage === "test_author" ? queried.kind === "frozen_tests" : value.scope.kind !== "feature" || queried.kind === "feature_commit", "invalid_provenance");
    }
    entries.set(value.jobId, value as unknown as WorkEvidence);
  }
  const retained = own(raw, "retained") ? raw.retained : [];
  budget.array(retained, "checkpoints");
  const groups = new Map<string, RetainedSnapshot[]>();
  const references = (values: unknown, scope: WorkScope, kind: string): string[] => {
    strings(values, budget);
    for (const jobId of values) {
      const e = entries.get(jobId);
      requireValid(e && scopeKey(e.scope) === scopeKey(scope) && (kind === "tests" ? e.stage === "test_author" : e.stage === "build" || e.stage === "fix"), "invalid_provenance_reference");
    }
    return values;
  };
  for (const snapshot of retained) {
    requireValid(record(snapshot) && (snapshot.kind === "writes" || snapshot.kind === "tests")
      && exact(snapshot, ["kind", "subject", "complete", "jobIds", ...(snapshot.kind === "tests" ? ["members"] : ["baseline", "featureRefs"]), "revision", "supersedes"],
        ["kind", "subject", "complete", "jobIds", ...(snapshot.kind === "tests" ? ["members"] : [])])
      && record(snapshot.subject) && typeof snapshot.complete === "boolean", "invalid_provenance");
    const queried = snapshot.subject as unknown as WorkSubject;
    const scope = subjectScope(queried);
    requireValid(validScope(scope) && validateSubject(queried, scope) && (snapshot.kind === "tests" ? queried.kind === "frozen_tests" :
      queried.kind === "feature_commit" || queried.kind === "application_commit"), "invalid_provenance");
    const ids = references(snapshot.jobIds, scope, snapshot.kind);
    const revision = own(snapshot, "revision"), supersedes = own(snapshot, "supersedes");
    requireValid(!revision && !supersedes || revision && supersedes && positive(snapshot.revision) && snapshot.supersedes === (snapshot.revision === 1 ? null : snapshot.revision - 1), "invalid_provenance_revision");
    if (snapshot.kind === "tests") {
      budget.array(snapshot.members, "files");
      const paths = new Set<string>(), union = new Set<string>();
      for (const member of snapshot.members) {
        requireValid(record(member) && exact(member, ["path", "sha256", "jobIds", "complete"]) && path(member.path) && !paths.has(member.path)
          && hash(member.sha256) && typeof member.complete === "boolean", "invalid_provenance");
        paths.add(member.path);
        for (const jobId of references(member.jobIds, scope, "tests")) union.add(jobId);
      }
      requireValid(ids.length === union.size && ids.every(v => union.has(v)), "invalid_provenance_reference");
    }
    if (own(snapshot, "baseline") || own(snapshot, "featureRefs")) requireValid(queried.kind === "application_commit", "invalid_provenance");
    if (own(snapshot, "baseline")) requireValid(record(snapshot.baseline) && exact(snapshot.baseline, ["kind", "commit"])
      && snapshot.baseline.kind === "recorded_baseline" && (snapshot.baseline.commit === null || commit(snapshot.baseline.commit)), "invalid_provenance");
    if (own(snapshot, "featureRefs")) {
      budget.array(snapshot.featureRefs, "references"); const features = new Set<string>();
      for (const ref of snapshot.featureRefs) {
        requireValid(record(ref) && exact(ref, ["featureId", "passingCommit", "mergeCommit", "snapshotRevision"]) && text(ref.featureId) && !features.has(ref.featureId)
          && commit(ref.passingCommit) && commit(ref.mergeCommit) && (ref.snapshotRevision === null || positive(ref.snapshotRevision)), "invalid_provenance_reference");
        features.add(ref.featureId);
      }
    }
    const key = JSON.stringify([snapshot.kind, canonicalSubject(queried)]);
    const group = groups.get(key) ?? []; group.push(snapshot as unknown as RetainedSnapshot); groups.set(key, group);
  }
  for (const rows of groups.values()) {
    const legacy = rows.filter(v => revisionOf(v) === null);
    requireValid(legacy.length === 0 || rows.length === 1, "invalid_provenance_revision");
    if (legacy.length) continue;
    const revisions = new Set(rows.map(v => v.revision));
    requireValid(revisions.size === rows.length, "invalid_provenance_revision");
    for (let n = 1; n <= rows.length; n++) requireValid(revisions.has(n), "invalid_provenance_revision");
  }
  return structuredClone(raw) as unknown as Provenance;
}

function checkCheckpoints(scope: ScopeTracking, provenance: Provenance): void {
  const entries = new Map(provenance.entries.map(e => [e.jobId, e]));
  const key = (selection: RetainedCheckpoint["selection"]) => JSON.stringify([canonicalSubject(selection.subject), selection.revision]);
  const snapshots = new Map((provenance.retained ?? []).map(snapshot => [key({ subject: snapshot.subject, revision: revisionOf(snapshot) }), snapshot]));
  const resolve = (selection: RetainedCheckpoint["selection"]) => {
    const result = snapshots.get(key(selection)); requireValid(result, "invalid_checkpoint_selection"); return result;
  };
  for (const cp of scope.checkpoints) {
    const primary = resolve(cp.selection);
    requireValid(scopeKey(subjectScope(primary.subject)) === scopeKey(scope.scope) && (!cp.complete || primary.complete)
      && primary.jobIds.every(id => cp.liveWriterIds.includes(id)), "invalid_checkpoint_selection");
    const writes = primary.kind === "writes" ? primary : cp.writesSelection ? resolve(cp.writesSelection) : undefined;
    requireValid(writes?.kind === "writes" && (writes.subject.kind === "feature_commit" || writes.subject.kind === "application_commit")
      && writes.subject.commit === cp.capture.head && (!cp.complete || writes.complete), "invalid_checkpoint_selection");
    const codeIds = cp.liveWriterIds.filter(id => entries.get(id)?.stage === "build" || entries.get(id)?.stage === "fix");
    const written = new Set(writes.jobIds);
    requireValid(codeIds.length === writes.jobIds.length && codeIds.every(id => written.has(id)), "invalid_checkpoint_selection");
    for (const id of cp.liveWriterIds) requireValid(entries.has(id), "invalid_checkpoint_selection");
    if (primary.kind === "tests") {
      const mapping = new Map(cp.members.map(m => [m.path, m]));
      const files = new Map(cp.capture.files.map(f => [f.path, f]));
      for (const member of primary.members) {
        const mapped = mapping.get(member.path);
        requireValid(mapped && files.get(member.path)?.sha256 === member.sha256 && mapped.sha256 === member.sha256
          && mapped.complete === member.complete && same(mapped.jobIds, member.jobIds), "invalid_checkpoint_selection");
      }
    }
  }
}
type SnapshotPayload = Omit<Extract<RetainedSnapshot, {kind:"writes"}>, "revision" | "supersedes"> | Omit<Extract<RetainedSnapshot, {kind:"tests"}>, "revision" | "supersedes">;
function canonicalMembers(members: TrackedMember[]): TrackedMember[] {
  return sortMembers(members.map(m => ({ path: m.path, sha256: m.sha256, mode: m.mode,
    jobIds: [...m.jobIds].sort(), complete: m.complete })));
}
function canonicalSnapshot(value: SnapshotPayload): unknown {
  const shared = { kind: value.kind, subject: canonicalSubject(value.subject), complete: value.complete, jobIds: [...value.jobIds].sort() };
  if (value.kind === "tests") return { ...shared, members: value.members.map(m => ({
    path: m.path, sha256: m.sha256, complete: m.complete, jobIds: [...m.jobIds].sort(),
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  return { ...shared, ...(value.baseline && { baseline: { kind: value.baseline.kind, commit: value.baseline.commit } }),
    ...(value.featureRefs && { featureRefs: value.featureRefs.map(r => ({ featureId: r.featureId,
      passingCommit: r.passingCommit, mergeCommit: r.mergeCommit, snapshotRevision: r.snapshotRevision }))
      .sort((a, b) => a.featureId < b.featureId ? -1 : a.featureId > b.featureId ? 1 : 0) }) };
}
function appendSnapshot(provenance: Provenance, value: SnapshotPayload): RetainedSnapshot {
  const rows = (provenance.retained ?? []).filter(v => sameSubject(v.subject, value.subject) && v.kind === value.kind);
  const last = rows.find(v => revisionOf(v) === null) ?? rows.reduce<RetainedSnapshot | undefined>((last, next) => !last || next.revision! > last.revision! ? next : last, undefined);
  if (last) {
    if (same(canonicalSnapshot(last), canonicalSnapshot(value))) return last;
    requireValid(revisionOf(last) !== null, "legacy_revision_conflict");
  }
  const revision = last ? last.revision! + 1 : 1;
  const next = { ...structuredClone(value), revision, supersedes: revision === 1 ? null : revision - 1 } as RetainedSnapshot;
  (provenance.retained ??= []).push(next); return next;
}
function evidenceOutcome(entry: InvocationEntry): WorkEvidence["outcome"] {
  return entry.observation!.outcome === "ok" ? "completed" : ["aborted", "thrown", "timeout"].includes(entry.observation!.outcome) ? "incomplete" : "failed";
}
function appendEvidence(provenance: Provenance, entry: InvocationEntry, subject: WorkSubject, index: Map<string, WorkEvidence>): void {
  const expected = { actual: entry.observation!.actual, scope: entry.scope, stage: entry.stage, outcome: evidenceOutcome(entry), at: entry.observation!.at };
  const existing = index.get(entry.jobId);
  if (existing) {
    requireValid(completeActual(existing.actual) && existing.actual.provider === expected.actual.provider && existing.actual.model === expected.actual.model && existing.actual.family === expected.actual.family && scopeKey(existing.scope) === scopeKey(entry.scope as WorkScope)
      && existing.stage === entry.stage && existing.outcome === expected.outcome && existing.at === expected.at, "conflicting_job_evidence");
    return;
  }
  provenance.entries.push({ jobId: entry.jobId, scope: structuredClone(entry.scope as WorkScope), stage: entry.stage as WriterStage,
    actual: { ...expected.actual }, outcome: expected.outcome, at: expected.at, subject: canonicalSubject(subject) });
  index.set(entry.jobId, provenance.entries[provenance.entries.length - 1]!);
}
function checkpointId(cp: Omit<RetainedCheckpoint, "id">): string {
  const capture = { scope: cp.capture.scope.kind === "feature" ? { kind: "feature", featureId: cp.capture.scope.featureId } : { kind: cp.capture.scope.kind },
    root: cp.capture.root, universe: cp.capture.universe, head: cp.capture.head, complete: cp.capture.complete,
    files: cp.capture.files.map(f => ({ path: f.path, sha256: f.sha256, mode: f.mode })) };
  return createHash("sha256").update(JSON.stringify({ capture, liveWriterIds: cp.liveWriterIds,
    members: cp.members.map(m => ({ path: m.path, sha256: m.sha256, mode: m.mode, jobIds: m.jobIds, complete: m.complete })),
    complete: cp.complete, selection: { subject: canonicalSubject(cp.selection.subject), revision: cp.selection.revision },
    ...(Object.hasOwn(cp,"unresolvedWriterIds") && { unresolvedWriterIds: cp.unresolvedWriterIds }),
    ...(cp.writesSelection && { writesSelection: { subject: canonicalSubject(cp.writesSelection.subject), revision: cp.writesSelection.revision } }) }), "utf8").digest("hex");
}
export function adoptRetained(raw: unknown, args: { scope: WorkScope; capture: WorkCapture; committed: WorkCapture; subject: WorkSubject; at: string; journal: InvocationJournal; provenance: unknown; frozenMembers?: FrozenMember[] }, limits?: Partial<TrackingLimits>): TrackingPlan<{ provenance: Provenance; dispositions: Disposition[]; checkpointId: string }> {
  return safe(limits, (budget: Budget) => {
    const state = tracking(raw, budget), scope = selected(state, args.scope), journal = validatedJournal(args.journal, budget);
    const entries = new Map(journal.entries.map(e => [e.jobId, e]));
    validateCapture(args.capture, budget); validateCapture(args.committed, budget);
    requireValid(identical(args.capture, args.committed), "commit_capture_mismatch");
    requireValid(sameFiles(scope.capture, args.capture) && boundTo(scope.capture, args.capture), "capture_anchor_gap");
    requireValid(validateSubject(args.subject, args.scope) && args.subject.kind !== "plan" && instant(args.at)
      && (args.subject.kind === "frozen_tests" || args.subject.commit === args.capture.head), "invalid_adoption_subject");
    const provenance = mutationProvenance(args.provenance, budget); checkCheckpoints(scope, provenance);
    const evidenceIndex = new Map(provenance.entries.map(e => [e.jobId, e]));
    const recovered = new Set<string>();
    for (const intent of scope.intents) if (intent.recovery) {
      validateRecovered(intent,scope.scope,journal); recovered.add(intent.jobId);
    }
    const knownLiveIds = scope.liveWriterIds.filter(id=>!recovered.has(id));
    let complete = scope.complete && scope.capture.complete;
    const dispositions: Disposition[] = [], settled = new Set<string>();
    const accounted = new Set(scope.intents.filter(i => i.phase === "finished").map(i => i.jobId));
    const historical = new Set(scope.checkpoints.flatMap(cp => cp.liveWriterIds));
    for (const entry of journal.entries) if (entry.access === "workspace-write" && scopeKey(entry.scope as WorkScope) === scopeKey(scope.scope)) {
      if ((entry.writeDisposition === "pending" || entry.writeDisposition === "uncertain") && !accounted.has(entry.jobId)) complete = false;
      if (entry.writeDisposition === "adopted" && !historical.has(entry.jobId)) complete = false;
    }
    if (scope.intents.some(i => i.phase === "active" || i.retention === "unknown")) complete = false;
    const writeSubject: Extract<WorkSubject,{kind:"feature_commit"|"application_commit"}> = args.scope.kind === "feature"
      ? { kind: "feature_commit", featureId: args.scope.featureId, commit: args.capture.head! }
      : { kind: "application_commit", commit: args.capture.head! };
    const included: string[] = [];
    for (const jobId of knownLiveIds) {
      const entry = observed(entries, jobId, scope.scope);
      requireValid(entry.cleanedAt !== undefined, "writer_cleanup_not_acknowledged");
      if (entry.stage === "test_author") {
        if (args.subject.kind === "frozen_tests") appendEvidence(provenance, entry, args.subject, evidenceIndex);
        else requireValid(evidenceIndex.get(jobId)?.stage === "test_author", "unaccounted_test_author");
      } else { appendEvidence(provenance, entry, writeSubject, evidenceIndex); included.push(jobId); }
    }
    for (const intent of scope.intents) {
      if (intent.phase !== "finished") continue;
      if (intent.recovery) { complete=false; continue; }
      const entry = observed(entries, intent.jobId, scope.scope, intent.stage);
      if (entry.cleanedAt === undefined) { complete = false; continue; }
      if (intent.retention === "unknown") continue;
      if (intent.retention === "none" || evidenceIndex.get(intent.jobId)?.stage === intent.stage) {
        dispositions.push({ jobId: intent.jobId, disposition: intent.retention === "none" ? "reverted" : "adopted" }); settled.add(intent.jobId);
      } else complete = false;
    }
    const writes = appendSnapshot(provenance, { kind: "writes", subject: writeSubject, complete, jobIds: included });
    let primary = writes;
    if (args.subject.kind === "frozen_tests") {
      budget.array(args.frozenMembers, "files");
      requireValid(args.subject.testSetId === frozenSetId(args.frozenMembers as FrozenMember[]), "invalid_frozen_identity");
      const mapped = new Map(scope.members.map(m => [m.path, m])), files = new Map(args.capture.files.map(f => [f.path, f]));
      const members = (args.frozenMembers as FrozenMember[]).map(file => {
        requireValid(files.get(file.path)?.sha256 === file.sha256, "invalid_frozen_members");
        const tracked = mapped.get(file.path);
        const jobIds = tracked?.sha256 === file.sha256 && tracked.mode === files.get(file.path)?.mode ? tracked.jobIds.filter(id=>!recovered.has(id)) : [];
        for (const id of jobIds) {
          const actual = observed(entries, id, scope.scope, "test_author");
          requireValid(actual.cleanedAt !== undefined, "writer_cleanup_not_acknowledged");
          appendEvidence(provenance, actual, args.subject, evidenceIndex);
        }
        return { path: file.path, sha256: file.sha256, jobIds, complete: tracked?.complete === true && jobIds.length > 0 && jobIds.length === tracked.jobIds.length };
      });
      const authors = unique(members.flatMap(m => m.jobIds));
      primary = appendSnapshot(provenance, { kind: "tests", subject: canonicalSubject(args.subject) as Extract<WorkSubject,{kind:"frozen_tests"}>,
        complete: complete && members.every(m => m.complete), jobIds: authors, members });
    }
    scope.capture = structuredClone(args.capture); scope.complete = complete;
    scope.intents = scope.intents.filter(i => !settled.has(i.jobId));
    const checkpointJobs=new Set(knownLiveIds);
    const data: Omit<RetainedCheckpoint, "id"> = { capture: structuredClone(args.capture), liveWriterIds: knownLiveIds,
      members: scope.members.map(m=>({...m,jobIds:m.jobIds.filter(id=>checkpointJobs.has(id)),
        complete:m.complete && m.jobIds.every(id=>checkpointJobs.has(id))})),
      unresolvedWriterIds:scope.intents.map(i=>i.jobId), complete: primary.complete && writes.complete,
      selection: { subject: canonicalSubject(primary.subject), revision: revisionOf(primary) },
      ...(primary.kind === "tests" && { writesSelection: { subject: canonicalSubject(writes.subject), revision: revisionOf(writes) } }) };
    const id = checkpointId(data);
    if (!scope.checkpoints.some(cp => cp.id === id)) scope.checkpoints.push({ id, ...data });
    scope.baseCheckpointId = id;
    mutationProvenance(provenance, new Budget(budget.limits)); checkCheckpoints(scope, provenance);
    return output(state, budget, { provenance, dispositions, checkpointId: id });
  });
}
export function reconcileRestore(raw: unknown, args: { scope: WorkScope; checkpointId: string; after: WorkCapture; provenance: unknown; paths?: string[] }, limits?: Partial<TrackingLimits>): TrackingPlan<{ dispositions: Disposition[] }> {
  return safe(limits, (budget: Budget) => {
    const state = tracking(raw, budget), scope = selected(state, args.scope), provenance = mutationProvenance(args.provenance, budget);
    checkCheckpoints(scope, provenance); validateCapture(args.after, budget);
    requireValid(hash(args.checkpointId), "invalid_restore");
    const cp = scope.checkpoints.find(v => v.id === args.checkpointId); requireValid(cp && boundTo(cp.capture, args.after), "invalid_checkpoint");
    const dispositions: Disposition[] = [];
    if (args.paths === undefined) {
      requireValid(identical(cp.capture, args.after), "restore_capture_mismatch");
      requireValid(Object.hasOwn(cp,"unresolvedWriterIds") || cp.complete || scope.intents.length===0,"unknown_checkpoint_intents");
      const pendingIds=new Set(cp.unresolvedWriterIds ?? []);
      const intents=scope.intents.filter(i=>pendingIds.has(i.jobId));
      requireValid(intents.length===pendingIds.size,"missing_checkpoint_intent");
      const kept = new Set([...cp.liveWriterIds,...pendingIds]);
      for (const id of unique([...scope.liveWriterIds, ...scope.intents.map(i => i.jobId)])) if (!kept.has(id)) dispositions.push({ jobId: id, disposition: "reverted" });
      scope.liveWriterIds = unique([...cp.liveWriterIds,...intents.filter(i=>i.phase==="finished"&&i.retention!=="none").map(i=>i.jobId)]);
      scope.members = structuredClone(cp.members); scope.complete = cp.complete && pendingIds.size===0; scope.baseCheckpointId = cp.id;
      scope.intents = intents;
    } else {
      requireValid(!scope.intents.some(i => i.phase === "active"), "invalid_restore");
      strings(args.paths, budget, path); requireValid(scope.capture.complete && cp.capture.complete && args.after.complete && scope.capture.head === args.after.head
        && boundTo(scope.capture, args.after), "restore_capture_mismatch");
      const paths = new Set(args.paths), target = new Map(cp.capture.files.map(f => [f.path, f])), current = new Map(scope.capture.files.map(f => [f.path, f]));
      const expected = new Map(current);
      for (const p of paths) { const at = target.get(p); if (at) expected.set(p, at); else expected.delete(p); }
      const files = [...expected.values()].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      requireValid(sameFiles({ ...scope.capture, files }, args.after), "restore_capture_mismatch");
      const mapping = new Map(scope.members.map(m => [m.path, m])), targetMembers = new Map(cp.members.map(m => [m.path, m]));
      for (const p of paths) {
        const member = targetMembers.get(p), prior = mapping.get(p), file = target.get(p);
        // A partial restore cannot prove that an entire writer's contribution disappeared.
        if (member || prior) {
          budget.charge("references", (member?.jobIds.length ?? 0) + (prior?.jobIds.length ?? 0));
          mapping.set(p, { path: p, sha256: file?.sha256 ?? null, mode: file?.mode ?? null,
            jobIds: unique([...(prior?.jobIds ?? []), ...(member?.jobIds ?? [])]), complete: false });
        }
      }
      scope.members = sortMembers([...mapping.values()]);
      scope.liveWriterIds = unique([...scope.liveWriterIds, ...cp.liveWriterIds]); scope.complete = false;
    }
    scope.capture = structuredClone(args.after);
    return output(state, budget, { dispositions });
  });
}
export function pendingWrites(raw: unknown, journalInput: InvocationJournal, scopeInput: WorkScope, limits?: Partial<TrackingLimits>): TrackingPlan<{ pendingJobIds: string[]; complete: boolean }> {
  return safe(limits, (budget: Budget) => {
    const state = tracking(raw, budget), scope = selected(state, scopeInput), journal = validatedJournal(journalInput, budget);
    const entries = new Map(journal.entries.map(e => [e.jobId, e]));
    const missing = scope.liveWriterIds.filter(id => {
      const entry = entries.get(id);
      return !entry?.observation || entry.cleanedAt === undefined || entry.access !== "workspace-write" || scopeKey(entry.scope as WorkScope) !== scopeKey(scopeInput);
    });
    const historical = new Set(scope.checkpoints.flatMap(cp => cp.liveWriterIds));
    const ids = unique([...missing, ...scope.intents.map(i => i.jobId), ...journal.entries.filter(e => e.access === "workspace-write" && scopeKey(e.scope as WorkScope) === scopeKey(scopeInput)
      && (e.writeDisposition === "pending" || e.writeDisposition === "uncertain" || e.writeDisposition === "adopted" && !historical.has(e.jobId))).map(e => e.jobId)]);
    return output(state, budget, { pendingJobIds: ids, complete: scope.complete && ids.length === 0 });
  });
}

/** Canonical frozen-member identity shared with controller adoption; does not infer authors. */
export function frozenSetId(members: FrozenMember[]): string {
  const budget: Budget = new Budget(bounds());
  budget.array(members, "files"); let previous = "";
  for (const member of members) {
    requireValid(record(member) && exact(member, ["path", "sha256"]) && path(member.path) && member.path > previous && hash(member.sha256), "invalid_frozen_members");
    previous = member.path;
  }
  return createHash("sha256").update(JSON.stringify(members.map(m => ({ path: m.path, sha256: m.sha256 }))), "utf8").digest("hex");
}
export type EvidenceAppendPlan = { ok: true; provenance: Provenance } | { ok: false; reason: string };
/** Root supplies actual observed identity and exact review-credit proof. This only appends validated evidence. */
export function appendReviewEvidence(raw: unknown, entry: WorkEvidence, limits?: Partial<TrackingLimits>): EvidenceAppendPlan {
  try {
    const budget = new Budget(bounds(limits));
    const provenance = mutationProvenance(raw, budget);
    const checked = mutationProvenance({ version: 1, entries: [entry], retained: [] }, budget).entries[0]!;
    requireValid(["review", "plan_review", "final_review"].includes(checked.stage) &&
      (checked.outcome !== "completed" || completeActual(checked.actual)), "invalid_review_evidence");
    const existing = provenance.entries.find(e => e.jobId === checked.jobId);
    const canonical = (e: WorkEvidence) => ({ jobId: e.jobId, scope: e.scope.kind === "feature" ? { kind: "feature", featureId: e.scope.featureId } : { kind: e.scope.kind },
      stage: e.stage, ...(e.actual && { actual: { ...(e.actual.provider && { provider: e.actual.provider }), ...(e.actual.model && { model: e.actual.model }), ...(e.actual.family && { family: e.actual.family }) } }),
      outcome: e.outcome, at: e.at, ...(e.subject && { subject: canonicalSubject(e.subject) }) });
    if (existing) requireValid(same(canonical(existing), canonical(checked)), "conflicting_job_evidence");
    else provenance.entries.push(checked);
    mutationProvenance(provenance, new Budget(budget.limits));
    return { ok: true, provenance };
  } catch (error) { return { ok: false, reason: error instanceof InvalidTracking ? error.code : "invalid_provenance" }; }
}

export interface ApplicationSnapshotInput {
  kind: "writes"; subject: Extract<WorkSubject, {kind:"application_commit"}>; complete: boolean; jobIds: string[];
  baseline: ApplicationBaseline; featureRefs: ApplicationFeatureRef[];
}
export type ApplicationSnapshotPlan = { ok: true; provenance: Provenance; revision: number | null } | { ok: false; reason: string };
/** Root supplies independently verified ledger facts. No graph truth or writer identity is inferred here. */
export function appendApplicationSnapshot(raw: unknown, snapshot: ApplicationSnapshotInput, limits?: Partial<TrackingLimits>): ApplicationSnapshotPlan {
  try {
    const budget = new Budget(bounds(limits));
    const provenance = mutationProvenance(raw, budget);
    requireValid(record(snapshot) && exact(snapshot, ["kind", "subject", "complete", "jobIds", "baseline", "featureRefs"])
      && snapshot.kind === "writes" && record(snapshot.subject) && snapshot.subject.kind === "application_commit", "invalid_application_snapshot");
    const checked = mutationProvenance({ version: 1, entries: provenance.entries, retained: [snapshot] }, budget).retained![0]!;
    requireValid(checked.kind === "writes" && checked.subject.kind === "application_commit", "invalid_application_snapshot");
    const next = appendSnapshot(provenance, checked);
    mutationProvenance(provenance, new Budget(budget.limits));
    return { ok: true, provenance, revision: revisionOf(next) };
  } catch (error) { return { ok: false, reason: error instanceof InvalidTracking ? error.code : "invalid_provenance" }; }
}

export interface ReapReceipt { jobId: string; recoveryKey: string; at: string; }
function captureDigest(capture: WorkCapture): string {
  return createHash("sha256").update(JSON.stringify({
    scope:capture.scope.kind==="feature"?{kind:"feature",featureId:capture.scope.featureId}:{kind:capture.scope.kind},
    root:capture.root,universe:capture.universe,head:capture.head,complete:capture.complete,
    files:capture.files.map(f=>({path:f.path,sha256:f.sha256,mode:f.mode})),
  }),"utf8").digest("hex");
}
function validateRecovered(intent: WriterIntent, scope: WorkScope, journal: InvocationJournal): InvocationEntry {
  const marker=intent.recovery;
  const entry=journal.entries.find(e=>e.jobId===intent.jobId);
  const recovery=journal.recoveries.find(r=>r.key===marker?.key && r.jobId===intent.jobId);
  requireValid(marker && recovery && entry && entry.access==="workspace-write" && scopeKey(entry.scope as WorkScope)===scopeKey(scope)
    && entry.stage===intent.stage && entry.cleanedAt===undefined && entry.restoration===undefined
    && (entry.writeDisposition==="pending" || entry.writeDisposition==="uncertain")
    && Date.parse(marker.at)>=Date.parse(recovery.at),"invalid_recovery_receipt");
  return entry;
}
/** Root supplies a receipt only after physical reaping and a fresh complete recapture. No process operations or journal edits here. */
export function recoverInterruptedWriter(raw: unknown, args: {
  jobId: string; after: WorkCapture; journal: InvocationJournal; reap: ReapReceipt; testPaths: string[];
}, limits?: Partial<TrackingLimits>): TrackingPlan<{ retention: "unknown"; replayed: boolean }> {
  return safe(limits,budget=>{
    const state=tracking(raw,budget), journal=validatedJournal(args.journal,budget);
    validateCapture(args.after,budget); strings(args.testPaths,budget,path);
    requireValid(record(args.reap) && exact(args.reap,["jobId","recoveryKey","at"]) && args.reap.jobId===args.jobId
      && args.reap.recoveryKey==="job:"+args.jobId && instant(args.reap.at) && args.after.complete,"invalid_recovery_receipt");
    const scope=state.scopes.find(s=>s.intents.some(i=>i.jobId===args.jobId));
    requireValid(scope,"missing_writer_intent");
    const intent=scope.intents.find(i=>i.jobId===args.jobId)!;
    requireValid(boundTo(scope.capture,args.after) && boundTo(intent.before,args.after),"capture_binding_mismatch");
    const digest=captureDigest(args.after);
    if (intent.recovery) {
      validateRecovered(intent,scope.scope,journal);
      validateRecovered({...intent,recovery:{...intent.recovery,at:args.reap.at}},scope.scope,journal);
      requireValid(intent.recovery.key===args.reap.recoveryKey && intent.recovery.captureDigest===digest,"conflicting_recovery");
      return output(state,budget,{retention:"unknown" as const,replayed:true});
    }
    requireValid(scope.intents.at(-1)===intent && !scope.intents.some(i=>i!==intent&&i.phase==="active"),"recovery_capture_gap");
    const marker={key:args.reap.recoveryKey,at:args.reap.at,captureDigest:digest};
    validateRecovered({...intent,recovery:marker},scope.scope,journal);
    if (intent.phase==="finished") requireValid(identical(scope.capture,args.after),"recovery_capture_gap");
    const old=new Map(intent.before.files.map(f=>[f.path,f])), after=new Map(args.after.files.map(f=>[f.path,f]));
    const members=new Map(scope.members.map(m=>[m.path,m])), tests=new Set(args.testPaths);
    const byContent=new Map<string,Set<string>>();
    for (const member of scope.members) if (member.sha256!==null && member.mode!==null && tests.has(member.path)) {
      const key=member.sha256+":"+member.mode, authors=byContent.get(key) ?? new Set<string>();
      for (const id of member.jobIds) authors.add(id); byContent.set(key,authors);
    }
    for (const p of new Set([...old.keys(),...after.keys()])) {
      if (intent.before.complete && sameFile(old.get(p),after.get(p))) continue;
      const prior=members.get(p), file=after.get(p), author=intent.stage==="test_author" && tests.has(p);
      const carried=!old.has(p) && file && tests.has(p) ? byContent.get(file.sha256+":"+file.mode) : undefined;
      budget.charge("references",(prior?.jobIds.length ?? 0)+(carried?.size ?? 0)+1);
      members.set(p,{path:p,sha256:file?.sha256 ?? null,mode:file?.mode ?? null,
        jobIds:unique([...(prior?.jobIds ?? []),...(carried ?? []),...(author?[args.jobId]:[])]),complete:false});
    }
    scope.members=sortMembers([...members.values()]); scope.capture=structuredClone(args.after); scope.complete=false;
    scope.liveWriterIds=unique([...scope.liveWriterIds,args.jobId]);
    intent.phase="finished"; intent.retention="unknown"; intent.recovery=marker;
    return output(state,budget,{retention:"unknown" as const,replayed:false});
  });
}
