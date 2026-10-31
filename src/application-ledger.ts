import type { ApplicationFeatureRef } from "./provenance.js";
import type { WorkCapture } from "./work-capture.js";
export interface ApplicationLedger {
  version: 1; root: string; baseline: { kind: "recorded_baseline"; commit: string }; head: string;
  scaffold: { commit: string; snapshotRevision: number | null; hasRetainedAiWork: boolean };
  features: ApplicationFeatureRef[];
  pendingMerge?: { attemptId: string; featureId: string; passingCommit: string; snapshotRevision: number | null; beforeHead: string };
}
export type LedgerResult = { ok: true; ledger: ApplicationLedger } | { ok: false; reason: string };
export type Captured = { capture: WorkCapture; committed: WorkCapture };
export type MergeInput = Captured & { attemptId: string; featureId: string; passingCommit: string; snapshotRevision: number | null };
export type MergeReceipt = { attemptId: string; beforeHead: string; passingCommit: string; returnedHead: string; observedHead: string; successful: boolean; sourceIsAncestor: boolean; previousHeadIsAncestor: boolean };
const MAX_FEATURES = 2_000, MAX_FILES = 20_000;
type Obj = Record<string, unknown>;
const record = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Obj, allowed: string[], required = allowed) => Object.keys(v).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(v, k));
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && /\S/u.test(v) && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const commit = (v: unknown): v is string => typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v);
const revision = (v: unknown): v is number | null => v === null || typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const path = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\\\u0000-\u001f\u007f-\u009f\ufffd]/u.test(v) &&
  !v.startsWith("/") && !/^[a-z]:/iu.test(v) && v.split("/").every(p => p !== "" && p !== "." && p !== ".." && p !== ".git");
const root = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && path(v.slice(1));
class LedgerError extends Error { constructor(readonly code: string) { super(code); } }
function requireValid(v: unknown, reason = "invalid_ledger"): asserts v { if (!v) throw new LedgerError(reason); }
function safe(fn: () => ApplicationLedger): LedgerResult {
  try { const ledger = fn(); validate(ledger); return { ok: true, ledger }; }
  catch (error) { return { ok: false, reason: error instanceof LedgerError ? error.code : "invalid_ledger" }; }
}
function featureRef(v: unknown): v is ApplicationFeatureRef {
  return record(v) && exact(v, ["featureId", "passingCommit", "mergeCommit", "snapshotRevision"]) && text(v.featureId) &&
    commit(v.passingCommit) && commit(v.mergeCommit) && revision(v.snapshotRevision);
}
function validate(raw: unknown): asserts raw is ApplicationLedger {
  requireValid(record(raw) && exact(raw, ["version", "root", "baseline", "head", "scaffold", "features", "pendingMerge"], ["version", "root", "baseline", "head", "scaffold", "features"]) &&
    raw.version === 1 && root(raw.root) && commit(raw.head) && record(raw.baseline) && exact(raw.baseline, ["kind", "commit"]) &&
    raw.baseline.kind === "recorded_baseline" && commit(raw.baseline.commit) && record(raw.scaffold) && exact(raw.scaffold, ["commit", "snapshotRevision", "hasRetainedAiWork"]) &&
    commit(raw.scaffold.commit) && revision(raw.scaffold.snapshotRevision) && typeof raw.scaffold.hasRetainedAiWork === "boolean");
  requireValid(raw.scaffold.hasRetainedAiWork || (raw.scaffold.commit === raw.baseline.commit && raw.scaffold.snapshotRevision === null), "invalid_no_ai_baseline");
  requireValid(Array.isArray(raw.features) && raw.features.length <= MAX_FEATURES, "ledger_budget_exceeded");
  const ids = new Set<string>();
  for (const ref of raw.features) { requireValid(featureRef(ref) && !ids.has(ref.featureId)); ids.add(ref.featureId); }
  requireValid(raw.head === (raw.features.length ? (raw.features.at(-1) as ApplicationFeatureRef).mergeCommit : raw.scaffold.commit), "ledger_head_gap");
  if (Object.hasOwn(raw, "pendingMerge")) {
    const intent = raw.pendingMerge;
    requireValid(record(intent) && exact(intent, ["attemptId", "featureId", "passingCommit", "snapshotRevision", "beforeHead"]) &&
      text(intent.attemptId) && text(intent.featureId) && !ids.has(intent.featureId) && commit(intent.passingCommit) && revision(intent.snapshotRevision) &&
      intent.beforeHead === raw.head, "invalid_pending_merge");
  }
}
function copy(raw: unknown): ApplicationLedger { validate(raw); return structuredClone(raw); }
function validateCapture(v: unknown): asserts v is WorkCapture {
  requireValid(record(v) && exact(v, ["scope", "root", "universe", "head", "files", "complete"]) &&
    record(v.scope) && exact(v.scope, ["kind"]) && v.scope.kind === "application" && root(v.root) && v.universe === "git-source-v1" &&
    commit(v.head) && v.complete === true && Array.isArray(v.files) && v.files.length <= MAX_FILES, "invalid_committed_capture");
  let last = "";
  for (const file of v.files) {
    requireValid(record(file) && exact(file, ["path", "sha256", "mode"]) && path(file.path) && file.path > last &&
      typeof file.sha256 === "string" && /^[a-f0-9]{64}$/u.test(file.sha256) && (file.mode === "100644" || file.mode === "100755"), "invalid_committed_capture");
    last = file.path;
  }
}
function proof(args: Captured, ledger?: ApplicationLedger, head?: string): WorkCapture & { head: string } {
  validateCapture(args.capture); validateCapture(args.committed);
  const a = args.capture, b = args.committed;
  requireValid(a.root === b.root && a.head === b.head && a.files.length === b.files.length &&
    a.files.every((f, i) => f.path === b.files[i]!.path && f.sha256 === b.files[i]!.sha256 && f.mode === b.files[i]!.mode), "commit_capture_mismatch");
  requireValid((!ledger || a.root === ledger.root) && (head === undefined || a.head === head), "unexpected_integration_head");
  return a as WorkCapture & { head: string };
}
export function initializeApplicationLedger(args: Captured & { beforeMissionWrites: true; noRetainedAiWriters: true }): LedgerResult {
  return safe(() => {
    requireValid(args.beforeMissionWrites === true && args.noRetainedAiWriters === true, "missing_baseline_proof");
    const capture = proof(args);
    return { version: 1, root: capture.root, baseline: { kind: "recorded_baseline", commit: capture.head }, head: capture.head,
      scaffold: { commit: capture.head, snapshotRevision: null, hasRetainedAiWork: false }, features: [] };
  });
}
export function recordApplicationScaffold(raw: unknown, args: Captured & { beforeHead: string; snapshotRevision: number | null; hasRetainedAiWork: boolean; baselineIsAncestor: boolean }): LedgerResult {
  return safe(() => {
    const ledger = copy(raw), capture = proof(args, ledger);
    requireValid(!ledger.pendingMerge && ledger.features.length === 0 && args.beforeHead === ledger.head && args.baselineIsAncestor === true &&
      revision(args.snapshotRevision) && typeof args.hasRetainedAiWork === "boolean", "invalid_scaffold_transition");
    // A no-AI assertion is only the unchanged pre-write baseline; missing identities never grant it.
    requireValid(args.hasRetainedAiWork || (!ledger.scaffold.hasRetainedAiWork && capture.head === ledger.baseline.commit && args.snapshotRevision === null), "invalid_no_ai_baseline");
    ledger.head = capture.head; ledger.scaffold = { commit: capture.head, snapshotRevision: args.snapshotRevision, hasRetainedAiWork: args.hasRetainedAiWork };
    return ledger;
  });
}
export function beginApplicationMerge(raw: unknown, args: MergeInput): LedgerResult {
  return safe(() => {
    const ledger = copy(raw); proof(args, ledger, ledger.head);
    requireValid(text(args.attemptId) && text(args.featureId) && commit(args.passingCommit) && revision(args.snapshotRevision) &&
      !ledger.features.some(f => f.featureId === args.featureId) && ledger.features.length < MAX_FEATURES, "invalid_merge_intent");
    const pending = { attemptId: args.attemptId, featureId: args.featureId, passingCommit: args.passingCommit, snapshotRevision: args.snapshotRevision, beforeHead: ledger.head };
    requireValid(!ledger.pendingMerge || Object.entries(pending).every(([key, value]) => ledger.pendingMerge![key as keyof typeof pending] === value), "pending_merge_conflict");
    ledger.pendingMerge = pending; return ledger;
  });
}
/** Only an immediate fresh Git-operation receipt may finish this transition.
 * A resume must not fabricate a receipt from ancestry: an unrelated descendant can contain both ancestors.
 */
export function finishApplicationMerge(raw: unknown, args: Captured & { receipt: MergeReceipt }): LedgerResult {
  return safe(() => {
    const ledger = copy(raw), intent = ledger.pendingMerge, capture = proof(args, ledger), r: unknown = args.receipt;
    requireValid(intent && record(r) && exact(r, ["attemptId", "beforeHead", "passingCommit", "returnedHead", "observedHead", "successful", "sourceIsAncestor", "previousHeadIsAncestor"]) &&
      r.attemptId === intent.attemptId && r.beforeHead === intent.beforeHead && r.passingCommit === intent.passingCommit &&
      r.returnedHead === capture.head && r.observedHead === capture.head && r.successful === true && r.sourceIsAncestor === true && r.previousHeadIsAncestor === true,
      "merge_receipt_mismatch");
    ledger.features.push({ featureId: intent.featureId, passingCommit: intent.passingCommit, mergeCommit: capture.head, snapshotRevision: intent.snapshotRevision });
    ledger.head = capture.head; delete ledger.pendingMerge; return ledger;
  });
}
export function readApplicationLedger(raw: unknown): LedgerResult { return safe(() => copy(raw)); }
