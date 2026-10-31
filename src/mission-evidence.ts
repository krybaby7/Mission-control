// Raw persisted mission evidence must be interpreted before a lossy display projection.
import { createHash } from "node:crypto";
import { journalOf, type InvocationJournal, type InvocationEntry } from "./invocations.js";
import { pendingWrites, frozenSetId, type ScopeTracking } from "./retained-work.js";
import { readApplicationLedger, type ApplicationLedger } from "./application-ledger.js";
import { reviewDisclosure, testAuthorshipDisclosure } from "./review-disclosure.js";
import type { ProvenanceContext, WorkScope, WorkSubject } from "./provenance.js";

export interface MissionEvidenceView {
  plan: string[]; application: string[];
  features: Array<{ id: string; review: string[]; tests: string[] }>;
}
type Obj = Record<string, unknown>;
const record = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const own = (v: Obj, k: string): boolean => Object.hasOwn(v, k);
const safeId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._-]{1,200}$/u.test(v);
const rawId = (v: unknown): v is string => typeof v === "string" && v.length <= 200 && /\S/u.test(v) && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const commit = (v: unknown): v is string => typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v);
const ZERO = "0".repeat(40), HASH = "0".repeat(64);
const LIMITS = { maxEntries: 10_000, maxSnapshots: 4_000, maxReferences: 100_000 };
const QUALIFIER = "These statements describe the recorded version; the current repository has not been checked here.";
const context = (subject: WorkSubject, hasPendingWrites = true): ProvenanceContext => ({ ...LIMITS, subject, hasPendingWrites });

/** A cumulative preflight over selected raw fields: no getters, recursion, huge arrays or truncated-prefix credit. */
class Projection {
  nodes = 0; chars = 0; active = new Set<object>();
  clone(value: unknown, depth = 0): unknown {
    if (++this.nodes > 200_000 || depth > 32) throw Error("view_budget");
    if (typeof value === "string") { this.chars += value.length; if (this.chars > 4_000_000) throw Error("view_budget"); return value; }
    if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
    if (!record(value) && !Array.isArray(value)) throw Error("invalid_view");
    if (this.active.has(value) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) throw Error("invalid_view");
    this.active.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 20_000) throw Error("view_budget");
        const out: unknown[] = [];
        for (let i = 0; i < value.length; i++) out.push(this.clone(data(value, String(i), true), depth + 1));
        return out;
      }
      const keys = Object.keys(value); if (keys.length > 64) throw Error("view_budget");
      const out: Obj = Object.create(null) as Obj;
      for (const key of keys) {
        this.chars += key.length; if (this.chars > 4_000_000) throw Error("view_budget");
        out[key] = this.clone(data(value, key, true), depth + 1);
      }
      return out;
    } finally { this.active.delete(value); }
  }
  pick(value: unknown, keys: string[]): Obj {
    if (!record(value)) throw Error("invalid_view");
    const out: Obj = Object.create(null) as Obj;
    for (const key of keys) if (own(value, key)) out[key] = this.clone(data(value, key, true));
    return out;
  }
}
function data(value: object, key: string, required = false): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) { if (required) throw Error("invalid_view"); return undefined; }
  if (!Object.hasOwn(descriptor, "value")) throw Error("invalid_view");
  return descriptor.value;
}
function unknownView(): MissionEvidenceView {
  return { plan: reviewDisclosure(undefined, context({ kind: "plan", planHash: HASH })),
    application: [...reviewDisclosure(undefined, context({ kind: "application_commit", commit: ZERO })), QUALIFIER], features: [] };
}
function graphWithinBudget(mission: Obj, features: Obj[]): boolean {
  let entries = 0, snapshots = 0, references = features.length;
  const count = (value: unknown): number => Array.isArray(value) ? value.length : 0;
  if (record(mission.applicationLedger)) references += count(mission.applicationLedger.features);
  for (const f of features) references += count(f.frozenTests);
  for (const envelope of [mission.provenance, ...features.map(f => f.provenance)]) {
    if (!record(envelope)) continue;
    entries += count(envelope.entries); snapshots += count(envelope.retained);
    if (entries > LIMITS.maxEntries || snapshots > LIMITS.maxSnapshots) return false;
    if (Array.isArray(envelope.retained)) for (const row of envelope.retained) {
      if (!record(row)) continue;
      references += count(row.jobIds) + count(row.members) + count(row.featureRefs);
      if (Array.isArray(row.members)) for (const member of row.members) if (record(member)) references += count(member.jobIds);
      if (references > LIMITS.maxReferences) return false;
    }
  }
  return references <= LIMITS.maxReferences;
}
function sameScope(a: unknown, b: unknown): boolean {
  return record(a) && record(b) && a.kind === b.kind && (a.kind === "feature"
    ? Object.keys(a).length === 2 && Object.keys(b).length === 2 && a.featureId === b.featureId
    : Object.keys(a).length === 1 && Object.keys(b).length === 1);
}
function subjectKey(raw: unknown): string | undefined {
  if (!record(raw)) return undefined;
  if (raw.kind === "feature_commit") return JSON.stringify([raw.kind, raw.featureId, raw.commit]);
  if (raw.kind === "frozen_tests") return JSON.stringify([raw.kind, raw.featureId, raw.testSetId]);
  if (raw.kind === "application_commit") return JSON.stringify([raw.kind, raw.commit]);
  if (raw.kind === "plan") return JSON.stringify([raw.kind, raw.planHash]);
  return undefined;
}
function sameSubject(a: unknown, b: unknown): boolean {
  if (!record(a) || !record(b) || subjectKey(a) === undefined || subjectKey(a) !== subjectKey(b)) return false;
  const keys = a.kind === "feature_commit" ? ["kind", "featureId", "commit"] : a.kind === "frozen_tests"
    ? ["kind", "featureId", "testSetId"] : a.kind === "plan" ? ["kind", "planHash"] : ["kind", "commit"];
  return Object.keys(a).length === keys.length && Object.keys(b).length === keys.length && keys.every(k => own(a,k) && own(b,k));
}
function matchesEvidence(raw: unknown, entry: InvocationEntry | undefined): boolean {
  if (!record(raw) || !entry?.observation || entry.cleanedAt === undefined || own(entry as unknown as Obj, "restoration")
    || !sameScope(raw.scope, entry.scope) || raw.stage !== entry.stage || raw.at !== entry.observation.at || !record(raw.actual)) return false;
  const actual = entry.observation.actual;
  if (Object.keys(raw.actual).length !== 3 || raw.actual.provider !== actual.provider || raw.actual.family !== actual.family || raw.actual.model !== actual.model) return false;
  if (["review", "plan_review", "final_review"].includes(String(raw.stage))) {
    if (entry.access !== "read-only" || !sameSubject(raw.subject, entry.baseSubject)) return false;
    // An ok process can still produce an unusable/mutating review. Only completed audits earn review credit.
    return raw.outcome === "completed" ? entry.observation.outcome === "ok"
      : raw.outcome === "incomplete" || raw.outcome === "failed" && entry.observation.outcome !== "ok";
  }
  const outcome = entry.observation.outcome === "ok" ? "completed"
    : ["aborted", "thrown", "timeout"].includes(entry.observation.outcome) ? "incomplete" : "failed";
  return raw.outcome === outcome && ["build", "fix", "test_author"].includes(String(raw.stage)) && entry.access === "workspace-write";
}
function boundEnvelope(raw: unknown, collisions: Set<string>, entries: Map<string, InvocationEntry>): { envelope: unknown; incomplete: boolean } {
  if (!record(raw) || !Array.isArray(raw.entries)) return { envelope: raw, incomplete: true };
  let incomplete = false;
  const bound = raw.entries.filter(row => {
    const usable = record(row) && rawId(row.jobId) && !collisions.has(row.jobId) && matchesEvidence(row, entries.get(row.jobId));
    if (!usable && (!record(row) || !["review","plan_review","final_review"].includes(String(row.stage)))) incomplete = true;
    return usable;
  });
  return { envelope: { ...raw, entries: bound }, incomplete };
}
function incompleteEnvelope(raw: unknown): unknown {
  if (!record(raw) || !Array.isArray(raw.retained)) return raw;
  return { ...raw, retained: raw.retained.map(row => !record(row) ? row : { ...row, complete: false,
    ...(Array.isArray(row.members) ? { members: row.members.map(m => record(m) ? { ...m, complete: false } : m) } : {}) }) };
}
function frozenMembers(raw: unknown): Array<{ path: string; sha256: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const members: Array<{ path: string; sha256: string }> = [];
  for (const value of raw) {
    if (!record(value) || Object.keys(value).length !== 2 || !own(value, "path") || !own(value, "sha256")
      || typeof value.path !== "string" || typeof value.sha256 !== "string") return undefined;
    members.push({ path: value.path, sha256: value.sha256 });
  }
  try { frozenSetId(members); return members; } catch { return undefined; }
}
interface ScopeView { pending: boolean; incomplete: boolean; inconsistent: boolean; state?: ScopeTracking; }
function pending(raw: Obj, journal: InvocationJournal | undefined, scope: WorkScope): ScopeView {
  const active = journal?.entries.some(e => sameScope(e.scope, scope) && e.access === "workspace-write"
    && (e.cleanedAt === undefined && e.restoration === undefined || e.writeDisposition === "pending" || e.writeDisposition === "uncertain")) ?? false;
  if (!journal || !own(raw, "workTracking") || raw.workTracking === undefined)
    return { pending: active, incomplete: true, inconsistent: false };
  const result = pendingWrites(raw.workTracking, journal, scope);
  if (!result.ok) return { pending: active, incomplete: true, inconsistent: result.reason !== "missing_scope" };
  const selected = result.state.scopes.find(s => sameScope(s.scope, scope));
  return { pending: active || (selected?.intents.length ?? 0) > 0, incomplete: !result.complete || !selected?.capture.complete,
    inconsistent: false, state: selected };
}
function sameIds(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.every(rawId) || !b.every(rawId)) return false;
  const left = new Set(a), right = new Set(b);
  return left.size === a.length && right.size === b.length && a.every(id => right.has(id));
}
/** A strict read-only selection/binding check, never a salvaging mutation validator. */
function selectedSnapshot(raw: unknown, subject: unknown, kind: "writes" | "tests", revision?: number | null): Obj | undefined {
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.retained)) return undefined;
  const rows = raw.retained.filter((r): r is Obj => record(r) && r.kind === kind && subjectKey(r.subject) === subjectKey(subject));
  if (!rows.length) return undefined;
  for (const row of rows) {
    const allowed = kind === "writes" ? ["kind","subject","complete","jobIds","baseline","featureRefs","revision","supersedes"]
      : ["kind","subject","complete","jobIds","members","revision","supersedes"];
    if (Object.keys(row).some(k => !allowed.includes(k)) || !sameSubject(row.subject, subject) || typeof row.complete !== "boolean" || !sameIds(row.jobIds,row.jobIds)) return undefined;
    if (kind === "writes") {
      if ((own(row,"baseline") || own(row,"featureRefs")) && (!record(row.subject) || row.subject.kind !== "application_commit")) return undefined;
      if (own(row,"baseline") && (!record(row.baseline) || Object.keys(row.baseline).length !== 2
        || row.baseline.kind !== "recorded_baseline" || !own(row.baseline,"commit") || row.baseline.commit !== null && !commit(row.baseline.commit))) return undefined;
      if (own(row,"featureRefs")) {
        if (!Array.isArray(row.featureRefs)) return undefined;
        const features = new Set<string>();
        for (const ref of row.featureRefs) {
          if (!record(ref) || Object.keys(ref).length !== 4 || !rawId(ref.featureId) || features.has(ref.featureId)
            || !commit(ref.passingCommit) || !commit(ref.mergeCommit) || !own(ref,"snapshotRevision")
            || !(ref.snapshotRevision === null || typeof ref.snapshotRevision === "number" && Number.isSafeInteger(ref.snapshotRevision) && ref.snapshotRevision > 0)) return undefined;
          features.add(ref.featureId);
        }
      }
    }
    if (kind === "tests") {
      if (!Array.isArray(row.members)) return undefined;
      const paths = new Set<string>(), authors = new Set<string>();
      for (const member of row.members) {
        if (!record(member) || Object.keys(member).length !== 4 || !own(member,"path") || !own(member,"sha256")
          || typeof member.complete !== "boolean" || !sameIds(member.jobIds,member.jobIds)) return undefined;
        const files = frozenMembers([{path:member.path,sha256:member.sha256}]);
        if (!files || paths.has(files[0]!.path)) return undefined;
        paths.add(files[0]!.path); for (const id of member.jobIds as string[]) authors.add(id);
      }
      if (!sameIds(row.jobIds,[...authors])) return undefined;
    }
  }
  const legacy = rows.filter(r => !own(r,"revision") && !own(r,"supersedes"));
  if (legacy.length) return rows.length === 1 && (revision === undefined || revision === null) ? legacy[0] : undefined;
  const indexed = new Map<number,Obj>();
  for (const row of rows) {
    if (!own(row,"revision") || !own(row,"supersedes") || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1
      || row.supersedes !== (row.revision === 1 ? null : row.revision-1) || indexed.has(row.revision)) return undefined;
    indexed.set(row.revision,row);
  }
  if (!Array.from({length:rows.length},(_,i)=>i+1).every(r=>indexed.has(r))) return undefined;
  return indexed.get(revision === undefined ? rows.length : revision ?? -1);
}
function writes(raw: unknown, head: string, revision?: number | null): Obj | undefined {
  return selectedSnapshot(raw,{kind:"application_commit",commit:head},"writes",revision);
}
function checkpointBinding(state: ScopeTracking | undefined, raw: unknown): "known" | "legacy" | "inconsistent" {
  if (!state || state.checkpoints.length === 0) return "legacy";
  const cp = state.checkpoints.find(c => c.id === state.baseCheckpointId);
  if (!cp || !record(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) return "inconsistent";
  const subject = cp.selection.subject;
  const primary = selectedSnapshot(raw,subject,subject.kind === "frozen_tests" ? "tests" : "writes",cp.selection.revision);
  const written = primary?.kind === "writes" ? primary : cp.writesSelection
    ? selectedSnapshot(raw,cp.writesSelection.subject,"writes",cp.writesSelection.revision) : undefined;
  const target = state.scope.kind === "feature" ? {kind:"feature_commit",featureId:state.scope.featureId,commit:cp.capture.head}
    : {kind:"application_commit",commit:cp.capture.head};
  if (!primary || !written || !sameSubject(written.subject,target) || cp.complete && (primary.complete !== true || written.complete !== true)) return "inconsistent";
  if (state.scope.kind === "feature") {
    // Direct feature/test readers select terminal revisions; a retained historical application ref does not.
    const terminalPrimary = selectedSnapshot(raw,subject,primary.kind as "writes"|"tests");
    const terminalWrites = selectedSnapshot(raw,written.subject,"writes");
    const revision = (row: Obj | undefined): unknown => row && (own(row,"revision") ? row.revision : null);
    const writesRevision = primary.kind === "writes" ? cp.selection.revision : cp.writesSelection?.revision;
    if (!terminalPrimary || !terminalWrites || revision(terminalPrimary)!==cp.selection.revision || revision(terminalWrites)!==writesRevision) return "inconsistent";
  }
  const code: string[] = [], entries = new Map<string,Obj>(), ambiguous = new Set<string>();
  for (const entry of raw.entries) if (record(entry) && rawId(entry.jobId)) {
    if (entries.has(entry.jobId)) ambiguous.add(entry.jobId);
    entries.set(entry.jobId,entry);
  }
  const live = new Set(cp.liveWriterIds);
  for (const id of cp.liveWriterIds) {
    const entry = entries.get(id);
    if (ambiguous.has(id) || !entry || !sameScope(entry.scope,state.scope) || !["build","fix","test_author"].includes(String(entry.stage))) return "inconsistent";
    if (entry.stage !== "test_author") code.push(id);
  }
  if (!sameIds(code,written.jobIds)) return "inconsistent";
  const mapping = new Map(cp.members.map(m=>[m.path,m]));
  for (const member of cp.members) for (const id of member.jobIds) {
    const entry = entries.get(id);
    if (!live.has(id) || ambiguous.has(id) || !entry || entry.stage!=="test_author" || !sameScope(entry.scope,state.scope)) return "inconsistent";
  }
  if (primary.kind === "tests") {
    if (!sameSubject(primary.subject,{kind:"frozen_tests",featureId:state.scope.kind==="feature"?state.scope.featureId:"",testSetId:frozenSetId((primary.members as Obj[]).map(m=>({path:m.path as string,sha256:m.sha256 as string})))})) return "inconsistent";
    const files = new Map(cp.capture.files.map(f=>[f.path,f]));
    for (const member of primary.members as Obj[]) {
      const tracked = mapping.get(member.path as string), file = files.get(member.path as string);
      if (!tracked || !file || tracked.sha256 !== member.sha256 || file.sha256 !== member.sha256 || tracked.mode !== file.mode
        || tracked.complete !== member.complete || !sameIds(tracked.jobIds,member.jobIds)) return "inconsistent";
    }
  }
  return "known";
}
function applicationBinding(raw: Obj, ledger: ApplicationLedger, features: Obj[], envelope: unknown): boolean {
  if (raw.baseSha !== ledger.baseline.commit || ledger.pendingMerge
    || raw.integrationWorktree !== undefined && raw.integrationWorktree !== ledger.root) return false;
  const delivered = features.filter(f => f.status === "done");
  if (delivered.length !== ledger.features.length) return false;
  const byId = new Map(delivered.map(f => [f.id, f]));
  for (const ref of ledger.features) {
    const f = byId.get(ref.featureId);
    if (!f || f.passingCommit !== ref.passingCommit || f.commit !== ref.mergeCommit) return false;
  }
  const aggregate = writes(envelope, ledger.head);
  if (!aggregate) return false;
  if (!ledger.scaffold.hasRetainedAiWork) return Array.isArray(aggregate.jobIds) && aggregate.jobIds.length === 0;
  const scaffold = writes(envelope, ledger.scaffold.commit, ledger.scaffold.snapshotRevision);
  return !!scaffold && Array.isArray(scaffold.jobIds) && scaffold.jobIds.length > 0 && sameIds(aggregate.jobIds, scaffold.jobIds);
}

/** Fixed canonical wording, detached and bounded. No Git probes, routing inference, or model-name inference. */
export function missionEvidenceView(raw: unknown): MissionEvidenceView {
  try {
    const projection = new Projection();
    const mission = projection.pick(raw, ["spec", "baseSha", "repoPath", "integrationWorktree", "agentRuns", "invocations", "workTracking", "applicationLedger", "provenance"]);
    // Presence is the barrier; never inspect a possibly malformed reset/uncertainty payload.
    if (own(raw as Obj, "workRestore") || own(raw as Obj,"workRestack")) mission.workRestore = true;
    if (own(raw as Obj, "provenanceUncertain")) mission.provenanceUncertain = true;
    const rawFeatures = data(raw as object, "features");
    if (!Array.isArray(rawFeatures) || rawFeatures.length > 256) return unknownView();
    const features = rawFeatures.map(f => {
      const feature = projection.pick(f, ["id", "mode", "status", "passingCommit", "commit", "worktree", "frozenTests", "provenance"]);
      if (own(f as Obj, "provenanceUncertain")) feature.provenanceUncertain = true;
      return feature;
    });
    if (!graphWithinBudget(mission, features)) return unknownView();
    const featureIds = new Set<string>();
    for (const f of features) { if (!safeId(f.id) || featureIds.has(f.id)) return unknownView(); featureIds.add(f.id); }
    // Census before envelope-version validation, including every unreferenced feature.
    const counts = new Map<string, number>();
    for (const envelope of [mission.provenance, ...features.map(f => f.provenance)]) {
      if (record(envelope) && Array.isArray(envelope.entries)) for (const row of envelope.entries) {
        if (record(row) && rawId(row.jobId)) counts.set(row.jobId, (counts.get(row.jobId) ?? 0) + 1);
      }
    }
    const collisions = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
    let journal: InvocationJournal | undefined;
    if (own(mission, "invocations") && mission.invocations !== undefined) {
      try { journal = journalOf({ agentRuns: mission.agentRuns as number, invocations: mission.invocations as InvocationJournal }); } catch { /* unknown stays unknown */ }
    }
    const journalEntries = new Map((journal?.entries ?? []).map(e=>[e.jobId,e]));
    const bound = boundEnvelope(mission.provenance,collisions,journalEntries);
    const featureBounds = features.map(f=>boundEnvelope(f.provenance,collisions,journalEntries));
    const sticky = own(mission,"provenanceUncertain") || own(mission,"workRestore");
    const unattributed = journal?.entries.filter(e=>e.access==="workspace-write"&&(e.scope.kind==="controller"||e.scope.kind==="plan")) ?? [];
    const globalPending = sticky || unattributed.some(e=>e.writeDisposition==="pending"||e.writeDisposition==="uncertain"||e.cleanedAt===undefined&&e.restoration===undefined);
    const historicalGap = collisions.size>0 || !journal || (journal?.legacyAgentRuns ?? 0)>0 || unattributed.length>0
      || bound.incomplete || featureBounds.some(f=>f.incomplete);
    const featurePending = features.map(f=>{
      const scope = pending(mission,journal,{kind:"feature",featureId:f.id as string});
      const binding = checkpointBinding(scope.state,f.provenance);
      const inconsistent = scope.inconsistent || binding==="inconsistent"
        || !!scope.state && (scope.state.capture.head!==f.passingCommit || f.worktree!==undefined&&f.worktree!==scope.state.capture.root);
      return {...scope, blocked:globalPending || own(f,"provenanceUncertain") || !commit(f.passingCommit) || scope.pending || inconsistent,
        incomplete:scope.incomplete || binding!=="known" || historicalGap};
    });
    const appPending = pending(mission,journal,{kind:"application"});
    const appBinding = checkpointBinding(appPending.state,mission.provenance);
    const ledgerResult=readApplicationLedger(mission.applicationLedger);
    const ledger=ledgerResult.ok?ledgerResult.ledger:undefined;
    const explicitBaseline = ledger?.scaffold.hasRetainedAiWork === false && appPending.state?.complete === true
      && appPending.state.liveWriterIds.length === 0 && appPending.state.capture.head === ledger.baseline.commit;
    const appIncomplete = historicalGap || appPending.incomplete || appBinding==="legacy" && !explicitBaseline;
    const envelope=appIncomplete ? incompleteEnvelope(bound.envelope) : bound.envelope;
    const envelopes=featureBounds.map((f,i)=>featurePending[i]!.incomplete ? incompleteEnvelope(f.envelope) : f.envelope);
    const appBlocked=globalPending || !ledger || !applicationBinding(mission,ledger,features,mission.provenance)
      || appPending.pending || appPending.inconsistent || appBinding==="inconsistent" || !appPending.state
      || appPending.state.capture.head!==ledger.scaffold.commit || appPending.state.capture.root!==ledger.root
      || featurePending.some((f,i)=>features[i]!.status==="done"&&f.blocked);
    const appContext = context({ kind: "application_commit", commit: ledger?.head ?? ZERO }, appBlocked);
    if (ledger) appContext.application = {
      expectedIntegrationHead: ledger.head, observedHead: ledger.head, expectedBaseline: ledger.baseline,
      hasRetainedAiScaffold: ledger.scaffold.hasRetainedAiWork,
      expectedFeatureRefs: ledger.features.map(ref => ({ ...ref, hasPendingWrites: featurePending[features.findIndex(f => f.id === ref.featureId)]?.blocked ?? true })),
      featureEvidence: features.map((f, i) => ({ featureId: f.id as string, provenance: envelopes[i] })),
    };
    let planHash = HASH;
    if (record(mission.spec)) planHash = createHash("sha256").update(JSON.stringify(mission.spec)).digest("hex");
    const planBlocked = globalPending || !record(mission.spec);
    return {
      plan: reviewDisclosure(envelope, context({ kind: "plan", planHash }, planBlocked)),
      application: [...reviewDisclosure(envelope, appContext), QUALIFIER],
      features: features.map((f, i) => {
        const build = context({ kind: "feature_commit", featureId: f.id as string, commit: commit(f.passingCommit) ? f.passingCommit : ZERO }, featurePending[i]!.blocked);
        const members = frozenMembers(f.frozenTests);
        const tests = context({ kind: "frozen_tests", featureId: f.id as string, testSetId: members ? frozenSetId(members) : HASH }, featurePending[i]!.blocked || !members);
        if (members) tests.frozenMembers = members;
        return { id: f.id as string, review: reviewDisclosure(envelopes[i], build), tests: f.mode==="review"||f.mode==="owner"?[]:testAuthorshipDisclosure(envelopes[i], tests, build) };
      }),
    };
  } catch { return unknownView(); }
}
