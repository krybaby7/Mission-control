// Pure finding audit/closure rules. No requested-model inference or runtime I/O.
import { createHash } from "node:crypto";
import type { ActualIdentity } from "./provenance.js";
import type { Finding } from "./types.js";

export interface FindingAssessment {
  outcome: "resolved" | "open" | "cannot_judge";
  evidence: string; reviewedCommit: string; jobId: string;
  actual: Required<ActualIdentity>; at: string;
  /** Exact verified SHA, or null. Never an account/profile-derived assurance. */
  verificationPassedAtCommit: string | null;
}
export interface FindingRecord {
  id: string; originFeatureId: string; finding: Finding; assessments: FindingAssessment[];
  /** Controller retention audit, not an AI assessment. Logical count orders rediscovery. */
  reopens?: Array<{ afterAssessmentCount: number; at: string }>;
}
export interface FindingHistory { version: 1; records: FindingRecord[]; }
export interface FindingAssessmentContext {
  currentCommit: string; reviewedCommit: string; completed: boolean; unchanged: boolean; clean: boolean;
  actual?: ActualIdentity; jobId: string; at: string;
  verification?: { commit: string; passed: boolean };
}
export const MAX_FINDING_RECORDS = 10_000;
const MAX_ASSESSMENTS = 100_000;
const MAX_TEXT_TOTAL = 2_000_000;
type Obj = Record<string, unknown>;
const record = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (o: Obj, names: string[]) => Object.keys(o).every(k => names.includes(k));
const short = (v: unknown): v is string => typeof v === "string" && v.length <= 200 && /\S/u.test(v) && !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const commit = (v: unknown): v is string => typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const family = (v: unknown) => v === "claude" || v === "codex";
const evidence = (v: unknown): v is string => typeof v === "string" && v.length <= 16_000 && /\S/u.test(v);
function identity(v: unknown): v is Required<ActualIdentity> {
  return record(v) && keys(v, ["provider", "model", "family"]) && family(v.family) && short(v.model) && (v.provider === "mock" || v.provider === v.family);
}
function finding(v: unknown): v is Finding {
  return record(v) && keys(v, ["severity", "file", "description", "suggestedTest"]) &&
    (v.severity === "blocker" || v.severity === "major" || v.severity === "minor") &&
    typeof v.description === "string" && v.description.length <= 100_000 &&
    (v.file === null || (typeof v.file === "string" && v.file.length <= 4096)) &&
    (v.suggestedTest === null || (typeof v.suggestedTest === "string" && v.suggestedTest.length <= 100_000));
}
export function findingId(originFeatureId: string, f: Finding): string {
  return createHash("sha256").update(JSON.stringify([originFeatureId, f.severity, f.file, f.description, f.suggestedTest]), "utf8").digest("hex");
}
function assessment(v: unknown, f: Finding): v is FindingAssessment {
  return record(v) && keys(v, ["outcome", "evidence", "reviewedCommit", "jobId", "actual", "at", "verificationPassedAtCommit"]) &&
    (v.outcome === "resolved" || v.outcome === "open" || v.outcome === "cannot_judge") && evidence(v.evidence) &&
    commit(v.reviewedCommit) && short(v.jobId) && identity(v.actual) && instant(v.at) &&
    (v.verificationPassedAtCommit === null || v.verificationPassedAtCommit === v.reviewedCommit) &&
    (v.outcome !== "resolved" || f.severity === "minor" || v.verificationPassedAtCommit === v.reviewedCommit);
}
function readHistory(raw: unknown, origin: string): FindingHistory | undefined {
  if (!short(origin) || !record(raw) || !keys(raw, ["version", "records"]) || raw.version !== 1 ||
      !Array.isArray(raw.records) || raw.records.length > MAX_FINDING_RECORDS) return undefined;
  const ids = new Set<string>(); const reviews = new Map<string, string>(); let total = 0; let textSize = 0;
  for (const r of raw.records) {
    if (!record(r) || !keys(r, ["id", "originFeatureId", "finding", "assessments", "reopens"]) || r.originFeatureId !== origin ||
        !hash(r.id) || ids.has(r.id) || !finding(r.finding) || findingId(origin, r.finding) !== r.id ||
        !Array.isArray(r.assessments) || r.assessments.length > MAX_ASSESSMENTS - total) return undefined;
    ids.add(r.id); total += r.assessments.length;
    if (Object.hasOwn(r, "reopens")) {
      if (!Array.isArray(r.reopens) || r.reopens.length > MAX_ASSESSMENTS - total) return undefined;
      total += r.reopens.length; let previous = 0;
      for (const event of r.reopens) {
        if (!record(event) || !keys(event, ["afterAssessmentCount", "at"]) || !Number.isSafeInteger(event.afterAssessmentCount) ||
            (event.afterAssessmentCount as number) <= previous || (event.afterAssessmentCount as number) > r.assessments.length || !instant(event.at)) return undefined;
        previous = event.afterAssessmentCount as number;
        const anchor = r.assessments[previous - 1];
        if (!record(anchor) || anchor.outcome !== "resolved") return undefined;
      }
    }
    textSize += r.finding.description.length + (r.finding.file?.length ?? 0) + (r.finding.suggestedTest?.length ?? 0);
    if (textSize > MAX_TEXT_TOTAL) return undefined;
    const jobs = new Set<string>();
    for (const a of r.assessments) {
      if (!assessment(a, r.finding) || jobs.has(a.jobId)) return undefined;
      const review = JSON.stringify([a.reviewedCommit, a.actual.provider, a.actual.family, a.actual.model, a.at, a.verificationPassedAtCommit]);
      const previous = reviews.get(a.jobId);
      if (previous !== undefined && previous !== review) return undefined;
      reviews.set(a.jobId, review);
      jobs.add(a.jobId); textSize += a.evidence.length + a.actual.model.length;
      if (textSize > MAX_TEXT_TOTAL) return undefined;
    }
  }
  return structuredClone(raw) as unknown as FindingHistory;
}
/** Legacy findings can seed audit records, never fabricated assessments. Bad existing data remains unusable. */
export function retainFindings(raw: unknown, origin: string, findings: readonly Finding[]): FindingHistory | undefined {
  if (!short(origin) || !Array.isArray(findings) || findings.length > MAX_FINDING_RECORDS) return undefined;
  const h = raw === undefined ? { version: 1 as const, records: [] as FindingRecord[] } : readHistory(raw, origin);
  if (!h) return undefined;
  const known = new Set(h.records.map(r => r.id));
  for (const f of findings) {
    if (!finding(f)) return undefined;
    const id = findingId(origin, f);
    if (known.has(id)) continue;
    if (h.records.length >= MAX_FINDING_RECORDS) return undefined;
    known.add(id); h.records.push({ id, originFeatureId: origin, finding: { ...f }, assessments: [] });
  }
  return readHistory(h, origin);
}
/** Only fresh reports use this; ordinary seeding/projection never creates a reopen event. */
export function rediscoverFindings(raw: unknown, origin: string, findings: readonly Finding[], at: string): FindingHistory | undefined {
  const h = retainFindings(raw, origin, findings);
  if (!h || !instant(at)) return undefined;
  const ids = new Set(findings.map(f => findingId(origin, f)));
  for (const row of h.records) {
    if (!ids.has(row.id) || row.assessments.at(-1)?.outcome !== "resolved" || row.reopens?.at(-1)?.afterAssessmentCount === row.assessments.length) continue;
    (row.reopens ??= []).push({ afterAssessmentCount: row.assessments.length, at });
  }
  return readHistory(h, origin);
}

/** The latest accepted assessment overall governs; an earlier matching-head closure is never resurrected. */
export function currentOpenFindings(raw: unknown, origin: string, currentCommit: string): FindingRecord[] | undefined {
  const h = readHistory(raw, origin);
  if (!h || !commit(currentCommit)) return undefined;
  return h.records.filter(r => {
    const latest = r.assessments.at(-1);
    return r.reopens?.at(-1)?.afterAssessmentCount === r.assessments.length || !latest || latest.outcome !== "resolved" || latest.reviewedCommit !== currentCommit ||
      (r.finding.severity !== "minor" && latest.verificationPassedAtCommit !== currentCommit);
  });
}
/** Validate multiplicity BEFORE per-row shape. An oversized batch closes nothing. */
export function assessFindings(raw: unknown, origin: string, responses: unknown, context: FindingAssessmentContext): FindingHistory | undefined {
  const h = readHistory(raw, origin);
  if (!h) return undefined;
  if (!commit(context.currentCommit) || context.reviewedCommit !== context.currentCommit || context.completed !== true ||
      context.unchanged !== true || context.clean !== true || !identity(context.actual) || !short(context.jobId) || !instant(context.at) ||
      !Array.isArray(responses) || responses.length > MAX_FINDING_RECORDS) return h;
  const counts = new Map<string, number>(); let responseSize = 0;
  for (const raw of responses) {
    if (record(raw) && typeof raw.id === "string") {
      responseSize += raw.id.length;
      if (responseSize > MAX_TEXT_TOTAL) return h;
      counts.set(raw.id, (counts.get(raw.id) ?? 0) + 1);
    }
  }
  const open = new Set(currentOpenFindings(h, origin, context.currentCommit)!.map(r => r.id));
  const rows = new Map(h.records.map(r => [r.id, r]));
  const verified = context.verification?.passed === true && context.verification.commit === context.reviewedCommit ? context.reviewedCommit : null;
  for (const raw of responses) {
    if (!record(raw) || !keys(raw, ["id", "outcome", "evidence"]) || !hash(raw.id) || counts.get(raw.id) !== 1 || !open.has(raw.id) ||
        !evidence(raw.evidence) || (raw.outcome !== "resolved" && raw.outcome !== "open" && raw.outcome !== "cannot_judge")) continue;
    const row = rows.get(raw.id)!;
    if (row.assessments.some(a => a.jobId === context.jobId)) continue;
    if (raw.outcome === "resolved" && row.finding.severity !== "minor" && verified === null) continue;
    row.assessments.push({
      outcome: raw.outcome, evidence: raw.evidence, reviewedCommit: context.reviewedCommit,
      jobId: context.jobId, actual: { provider: context.actual.provider, model: context.actual.model, family: context.actual.family },
      at: context.at, verificationPassedAtCommit: verified,
    });
  }
  return readHistory(h, origin); // overflow never returns a partially updated prefix
}
