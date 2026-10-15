// Small wording helpers shared by the report, the run summary and the notices, so one sentence is never built two ways.

/** "1 feature", "2 features". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "1 of 1 feature done", "4 of 6 features done": the noun follows the total. */
export function featuresDone(done: number, total: number): string {
  return `${done} of ${plural(total, "feature")} done`;
}
