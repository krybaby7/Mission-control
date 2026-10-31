// One wording layer over the canonical provenance interpreter; never reads routing/configuration.
import { interpretProvenance, type ProvenanceContext } from "./provenance.js";
import type { Family } from "./types.js";
const names: Record<Family, string> = { claude: "Claude", codex: "Codex" };
const ordered = (families: Family[]): Family[] => (["claude", "codex"] as const).filter(f => families.includes(f));
const familyNames = (families: Family[]): string => ordered(families).map(f => names[f]).join(" and ");

/** Fixed vocabulary only: model IDs, jobs, paths and raw damaged values never enter owner-facing prose. */
export function reviewDisclosure(envelope: unknown, context: ProvenanceContext): string[] {
  const facts = interpretProvenance(envelope, context);
  const reviewers = ordered(facts.currentReviews.map(r => r.actual.family));
  if (context.subject.kind === "plan") return reviewers.length
    ? ["Plan reviewed by " + familyNames(reviewers) + ".", "This records review of the plan, not the built application."]
    : ["Plan review identity not recorded for this version."];
  if (context.subject.kind === "frozen_tests") return ["Review identity not recorded for this version."];
  const application = context.subject.kind === "application_commit";
  const lines: string[] = [];
  if (facts.contributorFamilies.length) lines.push(application
    ? "Recorded AI contributors to this mission's retained work: " + familyNames(facts.contributorFamilies) + "."
    : "Recorded build and repair contributors: " + familyNames(facts.contributorFamilies) + ".");
  else lines.push(application ? "Retained mission AI contributor identity not recorded for this version." : "Build and repair identity not recorded for this version.");
  if (!facts.contributionsComplete) lines.push(application
    ? "Some retained mission AI contributions have no recorded identity."
    : "Some retained build or repair contributions have no recorded AI identity.");
  if (!reviewers.length) lines.push(application ? "Final review identity not recorded for this version." : "Review identity not recorded for this version.");
  for (const family of reviewers) {
    const fact = facts.currentReviews.find(r => r.actual.family === family)!;
    const name = names[family];
    if (application) lines.push("Final review of this version: " + name + ".");
    if (fact.relationship === "same_family") {
      lines.push(application
        ? name + " also contributed to the retained mission work; this was not a review by another AI family."
        : facts.contributorFamilies.length === 1
          ? "Built and reviewed by " + name + " in separate jobs; this was not a review by another AI family."
          : name + " reviewed this version in a separate job and also contributed to the retained work; this was not a review by another AI family.");
    } else if (fact.relationship === "different_family") lines.push(application
      ? "The final reviewer belongs to another AI family from all recorded contributors to this mission's retained work."
      : "Reviewed by " + name + " in a separate job from the recorded builders; the reviewer belongs to another AI family.");
    else lines.push(application
      ? "Whether the final reviewer came from another AI family than the retained mission contributors could not be established."
      : "Reviewed by " + name + "; whether the reviewer came from another AI family could not be established.");
  }
  if (application) lines.push("These comparisons cover retained AI work from this mission; earlier repository authorship is outside this record.");
  return lines;
}

/** Frozen test authorship is separate from review identity and compared only to the same feature's builders. */
export function testAuthorshipDisclosure(envelope: unknown, tests: ProvenanceContext, build: ProvenanceContext): string[] {
  const authors = interpretProvenance(envelope, tests);
  const builders = interpretProvenance(envelope, build);
  const paired = tests.subject.kind === "frozen_tests" && build.subject.kind === "feature_commit" && tests.subject.featureId === build.subject.featureId;
  const lines = authors.contributorFamilies.length && tests.subject.kind === "frozen_tests"
    ? ["Recorded authors of the frozen tests: " + familyNames(authors.contributorFamilies) + "."]
    : ["Frozen test author identity not recorded."];
  if (!authors.contributionsComplete || tests.subject.kind !== "frozen_tests") lines.push("Some retained test contributions have no recorded AI identity.");
  const overlap = paired ? ordered(authors.contributorFamilies.filter(f => builders.contributorFamilies.includes(f))) : [];
  for (const family of overlap) lines.push(names[family] + " authored retained tests and also contributed to the build.");
  if (!paired || !authors.contributionsComplete || !builders.contributionsComplete) lines.push("Whether test authors and builders came from different AI families could not be established.");
  else if (!overlap.length) lines.push("The recorded test authors and builders belong to different AI families.");
  return lines;
}
