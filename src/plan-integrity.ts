// Automatic gate-A revisions only. Owner-requested changes use their existing separate path.
import { isDeepStrictEqual } from "node:util";
import type { PlanReview, SpecFeature, SpecOutput } from "./types.js";

export interface ReconciledPlan {
  spec: SpecOutput;
  applied: boolean;
  latestRevision: NonNullable<PlanReview["latestRevision"]>;
  rejectedChanges: string[];
}
const protectedFields = (f: SpecFeature) => ({ id: f.id, acceptance: f.acceptance, kind: f.kind, deps: f.deps, mode: f.mode, effort: f.effort, expect: f.expect });

/** Inputs have already passed validateSpec. Omission of mode metadata is normal in the planner schema. */
export function reconcileSuppliedPlan(original: SpecOutput, current: SpecOutput, candidate?: SpecOutput, problems: readonly string[] = []): ReconciledPlan {
  const intact = isDeepStrictEqual(original.features.map(protectedFields), current.features.map(protectedFields));
  const fallback = intact ? current : original;
  const rejected: string[] = [];
  const reject = (text: string) => rejected.push(text.length <= 1200 ? text : `${text.slice(0, 1120)}… Full proposed wording remains in the planner job log.`);
  const finish = (spec: SpecOutput, applied: boolean): ReconciledPlan => ({
    spec: structuredClone(spec), applied,
    latestRevision: applied ? (rejected.length ? "partly_rejected" : "applied") : "not_applied",
    rejectedChanges: rejected.length <= 40 ? rejected : [...rejected.slice(0, 39), `${rejected.length - 39} further changes were rejected; see the planner job log. Original requirements were retained.`],
  });
  if (!candidate) {
    reject(`The proposed revision was not usable: ${problems.join("; ") || "no valid planner answer"}. The usable plan was retained.`);
    return finish(fallback, false);
  }
  const ids = new Set(original.features.map((f) => f.id));
  const nextIds = new Set(candidate.features.map((f) => f.id));
  const removed = [...ids].filter((id) => !nextIds.has(id));
  const added = [...nextIds].filter((id) => !ids.has(id));
  if (removed.length) reject(`Supplied feature IDs would be dropped or renamed: ${removed.join(", ")}. Original IDs were retained.`);
  if (added.length) reject(`New or renamed feature IDs were proposed: ${added.join(", ")}. Original IDs were retained.`);
  if (nextIds.size !== candidate.features.length) reject("The proposed revision repeats a feature ID. Original IDs were retained.");
  if (rejected.length) return finish(fallback, false);
  const next = new Map(candidate.features.map((f) => [f.id, f]));
  for (const f of original.features) {
    const proposed = next.get(f.id)!;
    if (!isDeepStrictEqual(f.deps, proposed.deps)) reject(`Feature ${f.id}: dependencies ${JSON.stringify(proposed.deps)} were rejected; original dependencies ${JSON.stringify(f.deps)} were retained.`);
  }
  if (rejected.length) return finish(fallback, false);
  const features = original.features.map((f): SpecFeature => {
    const proposed = next.get(f.id)!;
    if (!isDeepStrictEqual(f.acceptance, proposed.acceptance)) {
      const positions = Array.from({ length: Math.max(f.acceptance.length, proposed.acceptance.length) }, (_, i) => i).filter((i) => f.acceptance[i] !== proposed.acceptance[i]).map((i) => i + 1);
      reject(`Feature ${f.id}: proposed acceptance edits at positions ${positions.join(", ")} were rejected. All ${f.acceptance.length} original checks were retained byte for byte in their original order.`);
    }
    for (const key of ["kind", "mode", "effort", "expect"] as const) {
      if ((key === "kind" || proposed[key] !== undefined) && !isDeepStrictEqual(f[key], proposed[key])) reject(`Feature ${f.id}: proposed ${key} was rejected; original ${key} was retained.`);
    }
    // Copy only technical wording. No candidate-owned array can mutate the supplied reference.
    return { ...structuredClone(f), title: proposed.title, story: proposed.story };
  });
  const assembled: SpecOutput = { ...structuredClone(candidate), features };
  return finish(assembled, !isDeepStrictEqual(assembled, fallback));
}
