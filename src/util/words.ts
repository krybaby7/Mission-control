// Small wording helpers shared by the report, the run summary and the notices, so one sentence is never built two ways.

/** "1 feature", "2 features". */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** "1 of 1 feature done", "4 of 6 features done": the noun follows the total. */
export function featuresDone(done: number, total: number): string {
  return `${done} of ${plural(total, "feature")} done`;
}

/** "exactly 3 rows" when both ends of a range are the same number, else "4 to 12 rows" (real run R4: "The table has 3 to 3 rows"). */
export function rangeOf(first: number, last: number, noun: string): string {
  return first === last ? `exactly ${plural(first, noun)}` : `${first} to ${last} ${noun}s`;
}

/** "exactly 5" when both ends of a range are the same number, else "5 to 9": for a sentence that names the unit before it ("it should have ..."). */
export function rangeNumbers(first: number, last: number): string {
  return first === last ? `exactly ${first}` : `${first} to ${last}`;
}
