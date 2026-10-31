// Pure retained invocation evidence; runtime adoption and integration facts remain controller-owned.
import type { Family, Provider } from "./types.js";

export type ActualIdentity = { provider?: Provider; model?: string; family?: Family };
export type WorkScope = { kind: "feature"; featureId: string } | { kind: "application" } | { kind: "plan" };
export type WorkSubject =
  | { kind: "feature_commit"; featureId: string; commit: string }
  | { kind: "frozen_tests"; featureId: string; testSetId: string }
  | { kind: "application_commit"; commit: string }
  | { kind: "plan"; planHash: string };
export type WorkEvidence = {
  jobId: string;
  scope: WorkScope;
  stage: "test_author" | "build" | "fix" | "review" | "plan_review" | "final_review";
  actual?: ActualIdentity;
  outcome: "completed" | "incomplete" | "failed";
  at: string;
  subject?: WorkSubject;
};
export type FrozenMember = { path: string; sha256: string };
export type RetainedMember = FrozenMember & { jobIds: string[]; complete: boolean };
export type SnapshotRevision =
  | { revision?: never; supersedes?: never }
  | { revision: number; supersedes: number | null };
export type ApplicationBaseline = { kind: "recorded_baseline"; commit: string | null };
export type ApplicationFeatureRef = {
  featureId: string; passingCommit: string; mergeCommit: string; snapshotRevision: number | null;
};
export type ApplicationProvenanceContext = {
  /** Independent durable integration ledger, checked against the captured current HEAD. */
  expectedIntegrationHead: string;
  observedHead: string;
  expectedBaseline: ApplicationBaseline;
  hasRetainedAiScaffold: boolean;
  expectedFeatureRefs: (ApplicationFeatureRef & { hasPendingWrites: boolean })[];
  /** Include unreferenced feature envelopes too, for global job-ID collision auditing. */
  featureEvidence: { featureId: string; provenance: unknown }[];
};
export type RetainedSnapshot = SnapshotRevision & (
  | { kind: "writes"; subject: Extract<WorkSubject, { kind: "feature_commit" | "application_commit" }>; complete: boolean; jobIds: string[]; baseline?: ApplicationBaseline; featureRefs?: ApplicationFeatureRef[] }
  | { kind: "tests"; subject: Extract<WorkSubject, { kind: "frozen_tests" }>; complete: boolean; jobIds: string[]; members: RetainedMember[] });
export type Provenance = { version: 1; entries: WorkEvidence[]; retained?: RetainedSnapshot[] };
export type ProvenanceContext = {
  subject: WorkSubject;
  hasPendingWrites: boolean;
  frozenMembers?: FrozenMember[];
  maxEntries: number;
  maxSnapshots: number;
  /** Cumulative nested references/members; default maxEntries + maxSnapshots. */
  maxReferences?: number;
  application?: ApplicationProvenanceContext;
};
export type ReviewFact = {
  jobId: string;
  actual: Required<ActualIdentity>;
  subject: WorkSubject;
  at: string;
  relationship: "same_family" | "different_family" | "unknown";
  overlappingFamilies: Family[];
};
/** Contributors are builders for commit queries and test authors for frozen-set queries.
 * Current review means usable recorded AI review, never a passing check or owner approval.
 * Uncertainties are fixed codes only. Application comparisons concern retained mission
 * AI build/fix/scaffold contributions, never authorship of a preexisting repository.
 */
export type ProvenanceSummary = {
  contributorJobIds: string[];
  contributorFamilies: Family[];
  contributionsComplete: boolean;
  currentReviews: ReviewFact[];
  uncertainties: string[];
  applicationCoverage?: "mission_retained_ai";
};

type RecordValue = Record<string, unknown>;
type ParsedEvidence = WorkEvidence & { knownFamily?: Family; identity?: Required<ActualIdentity> };
const IDENTIFIER_MAX = 200;
const PATH_MAX = 4096;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const HASH = /^[a-f0-9]{64}$/u;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const STAGES = new Set(["test_author", "build", "fix", "review", "plan_review", "final_review"]);
const OUTCOMES = new Set(["completed", "incomplete", "failed"]);
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length <= IDENTIFIER_MAX && /\S/u.test(value) && !CONTROL.test(value);
const family = (value: unknown): value is Family => value === "claude" || value === "codex";
const provider = (value: unknown): value is Provider => family(value) || value === "mock";
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function subject(value: unknown): value is WorkSubject {
  if (!record(value)) return false;
  switch (value.kind) {
    case "feature_commit": return identifier(value.featureId) && typeof value.commit === "string" && COMMIT.test(value.commit);
    case "application_commit": return typeof value.commit === "string" && COMMIT.test(value.commit);
    case "frozen_tests": return identifier(value.featureId) && typeof value.testSetId === "string" && HASH.test(value.testSetId);
    case "plan": return typeof value.planHash === "string" && HASH.test(value.planHash);
    default: return false;
  }
}

function scope(value: unknown): value is WorkScope {
  return record(value) && (value.kind === "application" || value.kind === "plan" || (value.kind === "feature" && identifier(value.featureId)));
}

function subjectScope(value: WorkSubject): WorkScope {
  return value.kind === "feature_commit" || value.kind === "frozen_tests"
    ? { kind: "feature", featureId: value.featureId }
    : { kind: value.kind === "plan" ? "plan" : "application" };
}

function sameScope(left: WorkScope, right: WorkScope): boolean {
  return left.kind === right.kind && (left.kind !== "feature" || (right.kind === "feature" && left.featureId === right.featureId));
}

function sameSubject(left: WorkSubject, right: WorkSubject): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "feature_commit": return right.kind === left.kind && left.featureId === right.featureId && left.commit === right.commit;
    case "frozen_tests": return right.kind === left.kind && left.featureId === right.featureId && left.testSetId === right.testSetId;
    case "application_commit": return right.kind === left.kind && left.commit === right.commit;
    case "plan": return right.kind === left.kind && left.planHash === right.planHash;
  }
}

/** Copy only identity fields; optional persisted data must not escape or alias input. */
function copySubject(value: WorkSubject): WorkSubject {
  switch (value.kind) {
    case "feature_commit": return { kind: value.kind, featureId: value.featureId, commit: value.commit };
    case "frozen_tests": return { kind: value.kind, featureId: value.featureId, testSetId: value.testSetId };
    case "application_commit": return { kind: value.kind, commit: value.commit };
    case "plan": return { kind: value.kind, planHash: value.planHash };
  }
}

function validPair(workScope: WorkScope, stage: string, workSubject?: WorkSubject): boolean {
  if (workSubject !== undefined && !sameScope(workScope, subjectScope(workSubject))) return false;
  switch (workScope.kind) {
    case "feature":
      return stage === "test_author"
        ? workSubject === undefined || workSubject.kind === "frozen_tests"
        : ["build", "fix", "review"].includes(stage) && (workSubject === undefined || workSubject.kind === "feature_commit");
    case "application": return ["build", "fix", "final_review"].includes(stage) && (workSubject === undefined || workSubject.kind === "application_commit");
    case "plan": return stage === "plan_review" && (workSubject === undefined || workSubject.kind === "plan");
  }
}

/** Require an actual calendar instant, not Date.parse's normalization of impossible dates. */
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

function actual(value: unknown): { knownFamily?: Family; identity?: Required<ActualIdentity> } {
  if (!record(value)) return {};
  const validProvider = value.provider === undefined || provider(value.provider);
  const known = family(value.family) && validProvider && (value.provider === undefined || value.provider === "mock" || value.provider === value.family)
    ? value.family : undefined;
  return {
    ...(known !== undefined && { knownFamily: known }),
    ...(known !== undefined && provider(value.provider) && identifier(value.model)
      ? { identity: { provider: value.provider, model: value.model, family: known } } : {}),
  };
}

function evidence(value: unknown): ParsedEvidence | undefined {
  if (!record(value) || !identifier(value.jobId) || !scope(value.scope) || typeof value.stage !== "string" || !STAGES.has(value.stage)
    || typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome) || !instant(value.at)) return undefined;
  if (value.subject !== undefined && !subject(value.subject)) return undefined;
  if (value.outcome === "completed" && value.subject === undefined) return undefined;
  if (!validPair(value.scope, value.stage, value.subject)) return undefined;
  // Copy only interpreted fields; persisted unknown optional fields remain irrelevant.
  return {
    jobId: value.jobId, scope: value.scope, stage: value.stage as WorkEvidence["stage"],
    outcome: value.outcome as WorkEvidence["outcome"], at: value.at,
    ...(value.subject !== undefined && { subject: copySubject(value.subject) }), ...actual(value.actual),
  };
}

function canonicalPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= PATH_MAX && /\S/u.test(value) && !CONTROL.test(value)
    && !value.includes("\\") && !value.startsWith("/") && !/^[a-z]:/iu.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function frozenMember(value: unknown): value is FrozenMember {
  return record(value) && canonicalPath(value.path) && typeof value.sha256 === "string" && HASH.test(value.sha256);
}

type Source = { raw: unknown; featureId?: string; ambiguous?: boolean; usable?: boolean };
const own = (value: RecordValue, key: string): boolean => Object.hasOwn(value, key);
const commit = (value: unknown): value is string => typeof value === "string" && COMMIT.test(value);
function baseline(value: unknown): value is ApplicationBaseline {
  return record(value) && value.kind === "recorded_baseline" && (value.commit === null || commit(value.commit));
}
function featureReference(value: unknown): value is ApplicationFeatureRef {
  return record(value) && identifier(value.featureId) && commit(value.passingCommit) && commit(value.mergeCommit)
    && (value.snapshotRevision === null || positiveInteger(value.snapshotRevision));
}
function sameReference(a: ApplicationFeatureRef, b: ApplicationFeatureRef): boolean {
  return a.featureId === b.featureId && a.passingCommit === b.passingCommit && a.mergeCommit === b.mergeCommit && a.snapshotRevision === b.snapshotRevision;
}
function snapshotShape(value: unknown): value is RecordValue & { subject: WorkSubject } {
  return record(value) && subject(value.subject) && typeof value.complete === "boolean"
    && ((value.kind === "writes" && ["feature_commit", "application_commit"].includes(value.subject.kind))
      || (value.kind === "tests" && value.subject.kind === "frozen_tests" && Array.isArray(value.members)))
    && (value.subject.kind === "application_commit" || (!own(value, "baseline") && !own(value, "featureRefs")));
}

/** No I/O, mutation, model-name inference or requested-identity fallback. */
export function interpretProvenance(envelope: unknown, context: ProvenanceContext): ProvenanceSummary {
  const result: ProvenanceSummary = { contributorJobIds: [], contributorFamilies: [], contributionsComplete: false, currentReviews: [], uncertainties: [] };
  const reasons = new Set<string>();
  const uncertain = (reason: string): void => { reasons.add(reason); };
  const finish = (): ProvenanceSummary => ({ ...result, uncertainties: [...reasons] });
  if (!record(context) || !subject(context.subject) || typeof context.hasPendingWrites !== "boolean"
    || !positiveInteger(context.maxEntries) || !positiveInteger(context.maxSnapshots)
    || (own(context, "maxReferences") && !positiveInteger(context.maxReferences))
    || (own(context, "application") && context.subject.kind !== "application_commit")) {
    uncertain("invalid_context"); return finish();
  }
  const referenceLimit = context.maxReferences ?? Math.min(Number.MAX_SAFE_INTEGER, context.maxEntries + context.maxSnapshots);
  const app = record(context.application) ? context.application : undefined;
  const wrappers = Array.isArray(app?.featureEvidence) ? app.featureEvidence : [];
  const sources: Source[] = [{ raw: envelope }];
  let entryCount = 0, snapshotCount = 0, referenceCount = 0;
  let overflow = false;
  const charge = (values: unknown, kind: "entries" | "snapshots" | "references"): void => {
    if (!Array.isArray(values)) return;
    if (kind === "entries") { entryCount += values.length; overflow ||= entryCount > context.maxEntries; }
    else if (kind === "snapshots") { snapshotCount += values.length; overflow ||= snapshotCount > context.maxSnapshots; }
    else { referenceCount += values.length; overflow ||= referenceCount > referenceLimit; }
  };
  charge(wrappers, "references");
  charge(app?.expectedFeatureRefs, "references");
  charge(context.frozenMembers, "references");
  if (overflow) { uncertain("graph_budget_exceeded"); return finish(); }
  const wrapperCounts = new Map<string, number>();
  for (const wrapper of wrappers) {
    if (record(wrapper) && identifier(wrapper.featureId)) wrapperCounts.set(wrapper.featureId, (wrapperCounts.get(wrapper.featureId) ?? 0) + 1);
    sources.push({ raw: record(wrapper) ? wrapper.provenance : undefined,
      ...(record(wrapper) && identifier(wrapper.featureId) ? { featureId: wrapper.featureId } : { ambiguous: true }) });
  }
  for (const source of sources.slice(1)) if (source.featureId && wrapperCounts.get(source.featureId) !== 1) source.ambiguous = true;
  // Count graph work before collecting any positive facts, including damaged containers.
  for (const source of sources) {
    if (!record(source.raw)) continue;
    charge(source.raw.entries, "entries"); charge(source.raw.retained, "snapshots");
    if (overflow) break;
    if (Array.isArray(source.raw.retained)) for (const snapshot of source.raw.retained) {
      if (!record(snapshot)) continue;
      charge(snapshot.jobIds, "references"); charge(snapshot.featureRefs, "references"); charge(snapshot.members, "references");
      if (overflow) break;
      if (Array.isArray(snapshot.members)) for (const member of snapshot.members) {
        if (record(member)) charge(member.jobIds, "references");
        if (overflow) break;
      }
      if (overflow) break;
    }
    if (overflow) break;
  }
  if (overflow) { uncertain("graph_budget_exceeded"); return finish(); }

  const target = context.subject;
  const targetScope = subjectScope(target);
  let complete = true;
  const fail = (reason: string): void => { complete = false; uncertain(reason); };
  const entries = new Map<string, ParsedEvidence>();
  const mainEntries: ParsedEvidence[] = [];
  const seen = new Set<string>(), duplicates = new Set<string>();
  // Raw recognizable IDs are audited first, even in unsupported/damaged envelopes.
  for (const source of sources) if (record(source.raw) && Array.isArray(source.raw.entries)) for (const raw of source.raw.entries) {
    if (record(raw) && identifier(raw.jobId)) {
      if (seen.has(raw.jobId)) duplicates.add(raw.jobId);
      seen.add(raw.jobId);
    }
  }
  for (const [sourceIndex, source] of sources.entries()) {
    const value = source.raw;
    source.usable = record(value) && value.version === 1 && Array.isArray(value.entries)
      && (value.retained === undefined || Array.isArray(value.retained)) && !source.ambiguous;
    if (!source.usable) { fail(source.ambiguous ? "ambiguous_feature_evidence" : sourceIndex === 0 && value === undefined ? "identity_not_recorded" : "invalid_envelope"); continue; }
    const valid = value as RecordValue & { entries: unknown[] };
    for (const raw of valid.entries) {
      const parsed = evidence(raw);
      if (!parsed || (sourceIndex === 0 && target.kind === "application_commit" && parsed.scope.kind === "feature")
        || (source.featureId !== undefined && (parsed.scope.kind !== "feature" || parsed.scope.featureId !== source.featureId))) {
        fail("invalid_entry"); continue;
      }
      if (!duplicates.has(parsed.jobId)) {
        entries.set(parsed.jobId, parsed);
        if (sourceIndex === 0) mainEntries.push(parsed);
      }
    }
  }
  if (duplicates.size > 0) fail("duplicate_job_id");
  if (!sources[0]!.usable) return finish();

  const ids = new Set<string>(), families = new Set<Family>();
  const addReferences = (raw: unknown, contributionSubject: WorkSubject, allowEmpty = false): void => {
    if (!Array.isArray(raw)) { fail("invalid_contributor_list"); return; }
    const local = new Set<string>();
    if (raw.length === 0 && !allowEmpty) fail("empty_contributors");
    for (const id of raw) {
      if (!identifier(id)) { fail("invalid_contributor_id"); continue; }
      if (local.has(id)) fail("duplicate_contributor_id");
      local.add(id);
      const entry = entries.get(id);
      const rightStage = contributionSubject.kind === "frozen_tests" ? entry?.stage === "test_author" : entry?.stage === "build" || entry?.stage === "fix";
      if (!entry || !rightStage || !sameScope(entry.scope, subjectScope(contributionSubject))) { fail("unresolved_contributor"); continue; }
      ids.add(id);
      if (entry.knownFamily !== undefined) families.add(entry.knownFamily);
      if (entry.identity === undefined) fail("incomplete_actual_identity");
    }
  };
  const snapshotsFor = (source: Source): unknown[] => source.usable && record(source.raw) && Array.isArray(source.raw.retained) ? source.raw.retained : [];
  type Chain = { legacy?: RecordValue; versions?: Map<number, RecordValue>; size: number };
  const chains = new Map<Source, Map<string, Chain>>();
  const chainKey = (queried: WorkSubject, kind = queried.kind === "frozen_tests" ? "tests" : "writes"): string =>
    JSON.stringify([kind, copySubject(queried)]);
  // Each snapshot is grouped/validated once; repeated source resolution is map lookup.
  for (const source of sources) {
    const groups = new Map<string, RecordValue[]>();
    for (const raw of snapshotsFor(source)) {
      if (!record(raw) || !subject(raw.subject)) { fail("invalid_snapshot"); continue; }
      const key = chainKey(raw.subject, typeof raw.kind === "string" ? raw.kind : "");
      const rows = groups.get(key) ?? [];
      rows.push(raw); groups.set(key, rows);
    }
    const index = new Map<string, Chain>();
    chains.set(source, index);
    for (const [key, rows] of groups) {
      if (rows.some((raw) => !snapshotShape(raw) || (source.featureId !== undefined &&
        (subjectScope(raw.subject).kind !== "feature" || ("featureId" in raw.subject && raw.subject.featureId !== source.featureId))))) {
        fail("invalid_snapshot"); continue;
      }
      if (rows.some((raw) => !Array.isArray(raw.jobIds))) fail("invalid_snapshot");
      const legacy = rows.filter((raw) => !own(raw, "revision") && !own(raw, "supersedes"));
      if (legacy.length > 0) {
        if (rows.length !== 1 || legacy.length !== 1) fail("ambiguous_snapshot");
        else index.set(key, { legacy: legacy[0], size: 1 });
        continue;
      }
      const versions = new Map<number, RecordValue>();
      let valid = true;
      for (const row of rows) {
        if (!own(row, "revision") || !own(row, "supersedes") || !positiveInteger(row.revision)
          || row.supersedes !== (row.revision === 1 ? null : row.revision - 1) || versions.has(row.revision)) { valid = false; break; }
        versions.set(row.revision, row);
      }
      if (valid) for (let revision = 1; revision <= rows.length; revision++) if (!versions.has(revision)) { valid = false; break; }
      if (!valid) fail("ambiguous_snapshot");
      else index.set(key, { versions, size: rows.length });
    }
  }
  const select = (source: Source, queried: WorkSubject, requested?: number | null): RecordValue | undefined => {
    const chain = chains.get(source)?.get(chainKey(queried));
    if (!chain) { fail("missing_snapshot"); return; }
    if (chain.legacy && (requested === undefined || requested === null)) return chain.legacy;
    const chosen = requested === undefined ? chain.size : requested;
    const selected = chosen === null ? undefined : chain.versions?.get(chosen);
    if (!selected) fail("missing_snapshot_revision");
    return selected;
  };

  const collect = (snapshot: RecordValue, contributionSubject: WorkSubject, allowEmpty = false): void => {
    if (snapshot.complete !== true) fail("incomplete_snapshot");
    if (contributionSubject.kind !== "frozen_tests") { addReferences(snapshot.jobIds, contributionSubject, allowEmpty); return; }
    const expected = new Map<string, string>();
    if (!Array.isArray(context.frozenMembers) || context.frozenMembers.length === 0) {
      complete = false; uncertain("invalid_frozen_members");
    } else for (const member of context.frozenMembers) {
      if (!frozenMember(member) || expected.has(member.path)) { complete = false; uncertain("invalid_frozen_members"); }
      else expected.set(member.path, member.sha256);
    }
    const members = snapshot.members;
    const memberIds = new Set<string>();
    const paths = new Set<string>();
    const pathCounts = new Map<string, number>();
    if (!Array.isArray(members) || members.length > expected.size) { complete = false; uncertain("invalid_test_members"); }
    // Do not traverse an oversized member array; this is conservative, not truncation for credit.
    if (Array.isArray(members) && members.length <= expected.size) for (const member of members) {
      if (record(member) && canonicalPath(member.path)) pathCounts.set(member.path, (pathCounts.get(member.path) ?? 0) + 1);
    }
    if (Array.isArray(members) && members.length <= expected.size) for (const member of members) {
      if (!frozenMember(member) || pathCounts.get(member.path) !== 1 || expected.get(member.path) !== member.sha256) {
        complete = false; uncertain("invalid_test_member"); continue;
      }
      paths.add(member.path);
      const raw = member as FrozenMember & RecordValue;
      if (raw.complete !== true) { complete = false; uncertain("incomplete_test_authorship"); }
      addReferences(raw.jobIds, contributionSubject);
      if (Array.isArray(raw.jobIds) && raw.jobIds.length <= context.maxEntries) {
        for (const id of raw.jobIds) if (identifier(id)) memberIds.add(id);
      }
    }
    if (paths.size !== expected.size) { complete = false; uncertain("incomplete_test_members"); }
    if (!Array.isArray(snapshot.jobIds) || snapshot.jobIds.length > context.maxEntries
      || snapshot.jobIds.length !== memberIds.size || new Set(snapshot.jobIds).size !== snapshot.jobIds.length
      || snapshot.jobIds.some((id) => !identifier(id) || !memberIds.has(id))) {
      complete = false; uncertain("test_author_union_mismatch");
    }
  };

  let appReviewAllowed = true;
  const currentSnapshot = target.kind === "plan" ? undefined : select(sources[0]!, target);
  if (target.kind === "plan") fail("plan_has_no_builder_claim");
  if (currentSnapshot) {
    const allowEmpty = target.kind === "application_commit" && app?.hasRetainedAiScaffold === false
      && baseline(app.expectedBaseline) && baseline(currentSnapshot.baseline) && app.expectedBaseline.commit === currentSnapshot.baseline.commit;
    collect(currentSnapshot, target, allowEmpty);
  }
  if (target.kind === "application_commit") {
    if (!app) fail("application_aggregation_unavailable");
    else {
      const structuralFailure = (reason: string): void => { fail(reason); appReviewAllowed = false; };
      if (!commit(app.expectedIntegrationHead) || !commit(app.observedHead) || app.expectedIntegrationHead !== target.commit || app.observedHead !== app.expectedIntegrationHead)
        structuralFailure("unexpected_integration_head");
      if (!baseline(app.expectedBaseline) || !currentSnapshot || !baseline(currentSnapshot.baseline) || app.expectedBaseline.commit !== currentSnapshot.baseline.commit)
        structuralFailure("invalid_application_baseline");
      else result.applicationCoverage = "mission_retained_ai";
      if (typeof app.hasRetainedAiScaffold !== "boolean" || !Array.isArray(app.featureEvidence) || !Array.isArray(app.expectedFeatureRefs))
        structuralFailure("invalid_application_context");
      if (app.hasRetainedAiScaffold === true && (!Array.isArray(currentSnapshot?.jobIds) || currentSnapshot.jobIds.length === 0))
        structuralFailure("missing_scaffold_contributors");
      const expectedRows = Array.isArray(app.expectedFeatureRefs) ? app.expectedFeatureRefs : [];
      const actualRows = Array.isArray(currentSnapshot?.featureRefs) ? currentSnapshot.featureRefs : [];
      if (!Array.isArray(currentSnapshot?.featureRefs)) structuralFailure("invalid_feature_references");
      const expectedCounts = new Map<string, number>(), actualCounts = new Map<string, number>();
      const expectedById = new Map<string, unknown>();
      const sourceById = new Map(sources.filter((source) => source.featureId !== undefined && !source.ambiguous).map((source) => [source.featureId!, source]));
      for (const row of expectedRows) if (record(row) && identifier(row.featureId)) { expectedCounts.set(row.featureId, (expectedCounts.get(row.featureId) ?? 0) + 1); expectedById.set(row.featureId, row); }
      for (const row of actualRows) if (record(row) && identifier(row.featureId)) actualCounts.set(row.featureId, (actualCounts.get(row.featureId) ?? 0) + 1);
      if (actualRows.length !== expectedRows.length) structuralFailure("feature_reference_coverage");
      for (const row of actualRows) {
        if (!featureReference(row) || actualCounts.get(row.featureId) !== 1) { structuralFailure("invalid_feature_reference"); continue; }
        const expected = expectedById.get(row.featureId);
        const pending = record(expected) ? expected.hasPendingWrites : undefined;
        if (!featureReference(expected) || expectedCounts.get(row.featureId) !== 1 || !sameReference(row, expected)
          || typeof pending !== "boolean") { structuralFailure("invalid_feature_reference"); continue; }
        if (pending) structuralFailure("pending_feature_writes");
        const source = sourceById.get(row.featureId);
        if (!source?.usable || wrapperCounts.get(row.featureId) !== 1) { structuralFailure("missing_feature_evidence"); continue; }
        const queried: WorkSubject = { kind: "feature_commit", featureId: row.featureId, commit: row.passingCommit };
        const selected = select(source, queried, row.snapshotRevision);
        if (!selected) { structuralFailure("missing_feature_snapshot"); continue; }
        collect(selected, queried);
      }
      for (const row of expectedRows) if (!featureReference(row) || !record(row) || typeof row.hasPendingWrites !== "boolean"
        || expectedCounts.get(row.featureId) !== 1 || actualCounts.get(row.featureId) !== 1) structuralFailure("feature_reference_coverage");
    }
  }
  if (context.hasPendingWrites) fail("pending_writes");
  result.contributorJobIds = [...ids];
  result.contributorFamilies = [...families];
  result.contributionsComplete = complete && ids.size > 0;
  for (const entry of mainEntries) {
    const reviewStage = target.kind === "plan" ? entry.stage === "plan_review"
      : target.kind === "application_commit" ? entry.stage === "final_review" : target.kind === "feature_commit" && entry.stage === "review";
    if (!reviewStage || !sameScope(entry.scope, targetScope)) continue;
    if (entry.outcome !== "completed" || entry.identity === undefined || entry.subject === undefined) { uncertain("incomplete_review"); continue; }
    if (!sameSubject(entry.subject, target)) { uncertain("stale_review"); continue; }
    if (context.hasPendingWrites || !appReviewAllowed) continue;
    const overlap = families.has(entry.identity.family) ? [entry.identity.family] : [];
    result.currentReviews.push({
      jobId: entry.jobId, actual: { ...entry.identity }, subject: copySubject(entry.subject), at: entry.at,
      relationship: overlap.length > 0 ? "same_family" : result.contributionsComplete ? "different_family" : "unknown",
      overlappingFamilies: overlap,
    });
  }
  return finish();
}
