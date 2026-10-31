// Review invocation boundary, separate from baseline/checkpoint captures.
import { captureCommittedTree } from "./work-capture.js";
import type { WorkScope } from "./provenance.js";
export function captureReviewSubject(cwd:string,scope:WorkScope,commit:string) {
  return captureCommittedTree(cwd,scope,commit);
}
