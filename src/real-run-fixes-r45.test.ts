// What the real runs R3b, R4 and R5 found in the words the owner reads (docs/modes-spec.md, section 22): each test starts from a piece
// of the real mission (test/fixtures/modes/real-r45) or from the real report line, and fails on the code of commit b859b81.
// Nothing here calls an AI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { issueShown, ISSUE_MAX_CHARS, planReviewSentence } from "./checkpoint.js";
import { afterSendBackLines } from "./dispatcher.js";
import { checkChangeLines, checkChanges, checkChangeSummary, describePlan, reviewLines, wrapLine } from "./plan.js";
import type { PlanReview, SpecOutput } from "./types.js";
import { rangeNumbers, rangeOf } from "./util/words.js";

const FIX = join(import.meta.dirname, "..", "test", "fixtures", "modes", "real-r45");
const read = <T>(name: string): T => JSON.parse(readFileSync(join(FIX, name), "utf8")) as T;

/** The mission of the real run R4 (a script with tests and a table that the owner looks at): the plan as the leader wrote it, and the plan the team worked from. */
const r4 = read<{ title: string; request: string; plan: { spec: SpecOutput; review: PlanReview }; spec: SpecOutput }>("r4-plan-and-spec.json");
/** The answer of the plan reviewer in the real run R3b (a page). */
const r3b = read<{ request: string; review: PlanReview }>("r3b-plan-review.json");

const featureOf = (spec: SpecOutput, id: string): SpecOutput["features"][number] => spec.features.find((f) => f.id === id)!;

// ───────────────────────────── R4-4: "3 to 3 rows" ─────────────────────────────

describe("R4-4: a range with the same number at both ends says exactly that number", () => {
  it("says exactly 3 rows for the table of the real plan, in the command-line style and in the look", () => {
    expect(featureOf(r4.spec, "column-notes").expect?.rows).toEqual([3, 3]);
    for (const style of ["text", "look"] as const) {
      const lines = describePlan(r4.spec, { request: r4.request, style });
      expect(lines.some((l) => l.endsWith("The table has exactly 3 rows.")), style).toBe(true);
      expect(lines.join("\n"), style).not.toContain("3 to 3");
    }
  });

  it("does the same for a length in words, with the singular for one, and keeps a real range as it was", () => {
    const spec = (words: [number, number], rows: [number, number]): SpecOutput => ({
      ...r4.spec,
      features: [{ ...featureOf(r4.spec, "column-notes"), expect: { words, rows, columns: ["A"] } }],
    });
    const said = (s: SpecOutput): string => describePlan(s, { request: "x", style: "text" }).join("\n");
    expect(said(spec([5, 5], [3, 3]))).toContain("Its new text is exactly 5 words long.");
    expect(said(spec([1, 1], [1, 1]))).toContain("Its new text is exactly 1 word long.");
    expect(said(spec([1, 1], [1, 1]))).toContain("The table has exactly 1 row.");
    expect(said(spec([200, 500], [4, 12]))).toContain("Its new text is 200 to 500 words long.");
    expect(said(spec([200, 500], [4, 12]))).toContain("The table has 4 to 12 rows.");
  });

  it("has two small helpers for it", () => {
    expect(rangeOf(3, 3, "row")).toBe("exactly 3 rows");
    expect(rangeOf(1, 1, "row")).toBe("exactly 1 row");
    expect(rangeOf(4, 12, "row")).toBe("4 to 12 rows");
    expect(rangeNumbers(5, 5)).toBe("exactly 5");
    expect(rangeNumbers(11, 20)).toBe("11 to 20");
  });
});

// ───────────────────────────── R4-2: the checks the team changed ─────────────────────────────

describe("R4-2: the checks the plan reviewer removed and added are listed", () => {
  const changes = checkChanges(r4.plan.spec, r4.spec);

  it("finds, in the real plan, the seven checks of the leader that are gone and the nine that came in, and nothing for the feature that was not touched", () => {
    expect(changes.map((c) => c.id)).toEqual(["region-totals"]);
    const [totals] = changes;
    expect(totals?.title).toBe("Totals for each region");
    expect(totals?.removed).toHaveLength(7);
    expect(totals?.added).toHaveLength(9);
    // the check the real run lost: the one that recomputes the sums from the input
    expect(totals?.removed).toContain("The units and the revenue of every row equal the sums of that region's rows in the sales file.");
    expect(totals?.added).toContain("Running the script leaves data/sales.csv byte-for-byte unchanged.");
    // the plan reviewer reworded the other six, and a reworded check is one removed and one added: none of the leader's seven came through word for word
    expect(totals?.removed).toEqual(featureOf(r4.plan.spec, "region-totals").acceptance);
    expect(totals?.added).toEqual(featureOf(r4.spec, "region-totals").acceptance);
    // the feature the plan reviewer did not touch has the same checks in both plans
    expect(featureOf(r4.plan.spec, "column-notes").acceptance).toEqual(featureOf(r4.spec, "column-notes").acceptance);
  });

  it("counts them in one plain sentence", () => {
    expect(checkChangeSummary(changes)).toBe("Compared with the plan the leader wrote, 7 checks were removed and 9 checks were added.");
    expect(checkChangeSummary([{ id: "a", title: "A", removed: ["x"], added: [] }])).toBe("Compared with the plan the leader wrote, 1 check was removed.");
    expect(checkChangeSummary([{ id: "a", title: "A", removed: [], added: ["x"] }])).toBe("Compared with the plan the leader wrote, 1 check was added.");
    expect(checkChangeSummary([])).toBe("");
  });

  it("lists each one for `mc plan show`, under the feature, word for word, in lines of at most 280 characters", () => {
    const lines = checkChangeLines(changes, "text");
    expect(lines[0]).toBe("Compared with the plan the leader wrote, 7 checks were removed and 9 checks were added.");
    expect(lines[1]).toBe("- “Totals for each region” (id: region-totals)");
    expect(lines).toContain("  - Removed: The units and the revenue of every row equal the sums of that region's rows in the sales file.");
    expect(lines).toContain("  - Added: Running the script leaves data/sales.csv byte-for-byte unchanged.");
    expect(lines.filter((l) => l.startsWith("  - Removed: "))).toHaveLength(7);
    expect(lines.filter((l) => l.startsWith("  - Added: "))).toHaveLength(9);
    expect(lines.every((l) => l.length <= 280)).toBe(true);
    // the feature that was not touched has no line
    expect(lines.join("\n")).not.toContain("Description of each column");
  });

  it("lists each one for the owner's look as a line that says what it is on its own", () => {
    const lines = checkChangeLines(changes, "look");
    expect(lines).toHaveLength(16);
    expect(lines).toContain("Check the team removed from “Totals for each region”: The units and the revenue of every row equal the sums of that region's rows in the sales file.");
    expect(lines).toContain("Check the team added to “Totals for each region”: Running the script leaves data/sales.csv byte-for-byte unchanged.");
    expect(lines.every((l) => l.length <= 280)).toBe(true);
  });

  it("wraps a long check without losing a word, and keeps the lead on every line in the look", () => {
    const long = "word ".repeat(120).trim();
    const lines = checkChangeLines([{ id: "a", title: "A", removed: [], added: [long] }], "look");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((l) => l.startsWith("Check the team added to “A”: ") && l.length <= 280)).toBe(true);
    expect(lines.map((l) => l.slice("Check the team added to “A”: ".length)).join(" ")).toBe(long);
    const text = checkChangeLines([{ id: "a", title: "A", removed: [], added: [long] }], "text");
    expect(text.slice(2).join(" ").replace(/\s+/g, " ")).toContain(long);
  });

  it("is empty when the team kept every check, and counts a check that only moved as kept", () => {
    expect(checkChanges(r4.plan.spec, r4.plan.spec)).toEqual([]);
    expect(checkChangeLines([], "text")).toEqual([]);
    expect(checkChangeLines([], "look")).toEqual([]);
    const swapped: SpecOutput = { ...r4.plan.spec, features: r4.plan.spec.features.map((f) => ({ ...f, acceptance: [...f.acceptance].reverse() })) };
    expect(checkChanges(r4.plan.spec, swapped)).toEqual([]);
  });

  it("says a reworded check is one removed and one added", () => {
    const reworded: SpecOutput = {
      ...r4.plan.spec,
      features: r4.plan.spec.features.map((f) => (f.id === "column-notes" ? { ...f, acceptance: [f.acceptance[0]!, `${f.acceptance[1]!} Always.`, f.acceptance[2]!] } : f)),
    };
    const [one] = checkChanges(r4.plan.spec, reworded);
    expect(one).toMatchObject({ id: "column-notes", removed: [featureOf(r4.plan.spec, "column-notes").acceptance[1]], added: [`${featureOf(r4.plan.spec, "column-notes").acceptance[1]!} Always.`] });
  });

  it("lists the checks of a feature that only one of the plans has", () => {
    const fewer: SpecOutput = { ...r4.plan.spec, features: r4.plan.spec.features.filter((f) => f.id === "region-totals") };
    expect(checkChanges(r4.plan.spec, fewer)).toEqual([{ id: "column-notes", title: "Description of each column", removed: featureOf(r4.plan.spec, "column-notes").acceptance, added: [] }]);
    expect(checkChanges(fewer, r4.plan.spec)).toEqual([{ id: "column-notes", title: "Description of each column", removed: [], added: featureOf(r4.plan.spec, "column-notes").acceptance }]);
  });

  it("reads a damaged plan without failing", () => {
    expect(checkChanges(undefined, undefined)).toEqual([]);
    expect(checkChanges({ features: "no" }, { features: [null, 3, { id: 5, acceptance: "no" }] })).toEqual([]);
    expect(checkChanges({ features: [{ id: "a", title: "A", acceptance: ["x", 7, null] }] }, { features: [{ id: "a", title: "A", acceptance: [" x "] }] })).toEqual([]);
  });
});

// ───────────────────────────── R4-7 and R3b-1: the plan reviewer's answer ─────────────────────────────

describe("R4-7 and R3b-1: what the plan reviewer asked is shown whole, or cut at the end of a sentence", () => {
  const r3bIssue = r3b.review.issues[0]!;
  const r4Issue = r4.plan.review.issues[0]!;

  it("keeps a point of up to 400 characters whole", () => {
    const text = `${"The first sentence is plain. ".repeat(13)}The last one ends here.`.slice(0, ISSUE_MAX_CHARS);
    expect(text).toHaveLength(ISSUE_MAX_CHARS);
    expect(issueShown(text)).toBe(text);
    expect(issueShown("  Short   point\nover two lines. ")).toBe("Short point over two lines.");
  });

  it("cuts the real answer of R3b (424 characters) at the end of a sentence, with an ellipsis, and never in a word", () => {
    expect(r3bIssue.length).toBeGreaterThan(ISSUE_MAX_CHARS);
    const shown = issueShown(r3bIssue);
    expect(shown.length).toBeLessThanOrEqual(ISSUE_MAX_CHARS);
    expect(shown.endsWith(" …")).toBe(true);
    const kept = shown.slice(0, -2);
    expect(r3bIssue.startsWith(kept)).toBe(true);
    expect(kept.endsWith("which file to open.")).toBe(true);
    expect(shown).not.toContain("single fi");
  });

  it("cuts the real answer of R4 (512 characters, with code in backticks) at the end of a sentence too", () => {
    const shown = issueShown(r4Issue);
    expect(shown.length).toBeLessThanOrEqual(ISSUE_MAX_CHARS);
    expect(shown.endsWith(' starts with "Running the script". …')).toBe(true);
    expect(r4Issue.startsWith(shown.slice(0, -2))).toBe(true);
    expect(shown).not.toMatch(/ w…$/);
  });

  it("cuts at a space, never in the middle of a word, when no sentence ends in time", () => {
    const text = `${"alphabet ".repeat(80)}end`;
    const shown = issueShown(text);
    expect(shown.length).toBeLessThanOrEqual(ISSUE_MAX_CHARS);
    expect(shown.endsWith("alphabet…")).toBe(true);
    expect(text.startsWith(shown.slice(0, -1) + " ")).toBe(true);
    // a short first sentence is not worth a cut there: the cut is made at a word, so that most of the point stays
    const early = `Yes. ${"alphabet ".repeat(80)}end`;
    expect(issueShown(early).endsWith("alphabet…")).toBe(true);
  });

  it("puts the cut point into the sentence the owner reads, with no full stop after the ellipsis", () => {
    const sentence = planReviewSentence(r3b.review);
    expect(sentence).toMatch(/It asked: The spec never says where the page goes\. .* which file to open\. …$/);
    expect(sentence).not.toContain("….");
    const word = planReviewSentence({ outcome: "revised", issues: [`${"alphabet ".repeat(80)}end`] });
    expect(word.endsWith("alphabet…")).toBe(true);
  });

  it("keeps up to three points, each cut by the same rule, and counts the rest", () => {
    const sentence = planReviewSentence({ outcome: "not_applied", issues: [r3bIssue, "Name the label.", "Say what farewell returns.", "Fourth.", "Fifth."] });
    expect(sentence).toContain("which file to open. … Name the label. Say what farewell returns. and 2 more.");
  });

  it("puts the answer on one line in `mc plan show` and in lines of at most 280 characters for the owner's look", () => {
    const one = reviewLines(r4.plan.review, 0, false);
    expect(one).toHaveLength(1);
    expect(one[0]!.length).toBeGreaterThan(280);
    const wrapped = reviewLines(r4.plan.review, 0);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.every((l) => l.length <= 280)).toBe(true);
    expect(wrapped.join(" ")).toBe(one[0]);
    expect(reviewLines(r4.plan.review, 0)).toEqual(wrapLine(planReviewSentence(r4.plan.review)));
    // the owner's send-backs are a line of their own either way
    expect(reviewLines(r4.plan.review, 2, false)).toEqual([one[0], "You sent the plan back twice. This is the plan as it stands now."]);
  });
});

// ───────────────────────────── R4-6: the second showing ─────────────────────────────

describe("R4-6: the second showing repeats the owner's note and says that nobody checks it was followed", () => {
  const SENTENCE = "It was changed after your note and checked again by a second AI. Nothing checks that your note was followed, so please look.";

  it("repeats the real note of R4 in curly quotes, then says it plainly", () => {
    expect(afterSendBackLines("Make every Meaning one short sentence of at most 7 words.")).toEqual([
      "Your note: “Make every Meaning one short sentence of at most 7 words.”",
      SENTENCE,
    ]);
  });

  it("cleans the note like any text and cuts it at 200 characters", () => {
    const long = `${"word ".repeat(60)}end`;
    const [note] = afterSendBackLines(long);
    expect(note).toMatch(/^Your note: “word( word)*…”$/);
    expect(Array.from(note!.slice("Your note: “".length, -1))).toHaveLength(200);
    const zeroWidth = String.fromCharCode(0x200b);
    const [addr] = afterSendBackLines(`See https://evil.example/x and <b>bold</b>${zeroWidth} now`);
    expect(addr).not.toMatch(/https|<b>/);
    expect(addr).not.toContain(zeroWidth);
    expect(addr).toContain("(web address removed)");
    // a curly quote inside the note would break the pair around it
    expect(afterSendBackLines("Say “hi” first")[0]).toBe('Your note: “Say "hi" first”');
  });

  it("still says the sentence when the note is empty, and leaves the empty note out", () => {
    expect(afterSendBackLines("")).toEqual([SENTENCE]);
  });
});
