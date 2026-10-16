// T-HOSTILE-EVIDENCE (V2-10): what the second AI writes about a file can quote hostile text (hidden and direction-changing characters, a
// markdown picture, a link, a web address). Before it reaches a surface the owner or another program reads, it is made plain.
//
// Example A runs on the mock team with a second AI whose evidence and notes are hostile on every kind of answer: a check that fails, one
// that cannot be judged, one that passes, and a note. The text of every surface that shows it is collected: the report at each stop and at
// the end, `mc report`, `mc plan show`, `mc logs`, the phone notices, the dashboard (card, timeline, Results page, everything the snapshot
// holds), the draft pull request text (the real host script), the brief the builder gets for the fix, and the mission file. None holds a
// hidden character, a picture, a link or a web address, and the readable words of the second AI are still there. Nothing calls an AI.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderReport } from "../src/report.js";
import type { Feature, Finding, Mission } from "../src/types.js";
import { checkerBehavior, isChecker } from "./fixtures/mission-harness.js";
import { pullRequestBody } from "./modes-pr-kit.js";
import { EXAMPLE_A, openWorld, type World } from "./modes-real-kit.js";

let w: World;
const cleanups: (() => void)[] = [];
afterEach(() => {
  w?.cleanup();
  for (const undo of cleanups.splice(0)) undo();
});

const u = (...codes: number[]): string => String.fromCodePoint(...codes);
/** Every hidden, zero-width and direction-changing character the evidence below uses. */
const HIDDEN_CHARS = [0x202e, 0x202a, 0x202c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x2066, 0x2069, 0xfeff, 0x00ad, 0x2800, 0xe0041, 0xfe0f];
const HIDDEN_RUN = u(...HIDDEN_CHARS);
const ANY_HIDDEN = new RegExp(`[${HIDDEN_CHARS.map((c) => `\\u{${c.toString(16)}}`).join("")}]`, "u");

/** The hostile tail of every piece of evidence: a picture, a link, three kinds of web address, and hidden characters inside words. */
const HOSTILE = ` re${u(0x202e)}versed${u(0x200b)}zero${u(0x2066)}iso${u(0xfeff)}bom ![chart](https://evil.example/x.png) [click here](http://evil.example/p?a=1) see //evil.example/a and www.evil.example/b or http://127.0.0.1:8080/admin ht${u(0x200b)}tps://hidden.example/h`;
const QUOTE = "Add your first habit";
/** A file name of a note that closes a two-backtick code span early and then draws a picture and a link (finding W2d-R2). 69 characters, so it is inside the cut for a file name. */
const HOSTILE_FILE = "a`` ![p](https://evil.example/p.png) [c](https://evil.example/c) `` b";
const CLEAN_FILE = "a`` p (web address removed) c (web address removed) `` b";

/** The address and hidden-character marks that must not be found on any surface. */
const BAD: [string, RegExp][] = [
  ["a hidden character", ANY_HIDDEN],
  ["a markdown picture", /!\[/u],
  ["a markdown link", /\]\(/u],
  ["evil.example", /evil\.example|hidden\.example/iu],
  ["a web address", /https?:\/\/|\/\/127\.0\.0\.1|www\.evil/iu],
  ["a loopback address", /127\.0\.0\.1:8080/u],
];

/** Everything a snapshot of the dashboard says, one string at a time. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) strings(v, out);
  return out;
}

function problemsIn(surface: string, text: string): string[] {
  return BAD.filter(([, re]) => re.test(text)).map(([what]) => `${surface}: has ${what}`);
}

/** A second AI whose every piece of evidence and every note is hostile. Round 1: check 1 fails. Every round: check 2 cannot be judged, check 3 passes. */
function hostileChecker() {
  let round = 0;
  return (job: Parameters<typeof checkerBehavior>[0], call: { label: string }) => {
    if (!isChecker(job)) return w.h.defaults.reviewer(job, call as never);
    round++;
    const behavior = checkerBehavior(job, (results) => {
      for (const r of results) r.evidence = `The file says “${QUOTE}” in docs/setup-guide.md.${HOSTILE}`;
      if (round === 1) results[0] = { ...results[0]!, result: "fail", evidence: `It never says what the reader should see.${HOSTILE}` };
      results[1] = { ...results[1]!, result: "cannot_judge", evidence: `Taste cannot be seen.${HOSTILE}` };
    });
    (behavior.structured as { notes: unknown[] }).notes = [
      { severity: "minor", file: `docs/setup-guide.md${u(0x202e)}`, description: `A small thing to tidy.${HOSTILE}` },
      { severity: "minor", file: HOSTILE_FILE, description: "A second small thing to tidy." },
    ];
    return behavior;
  };
}

interface Run {
  id: string;
  surfaces: { name: string; text: string }[];
  stops: number;
}

async function runHostile(): Promise<Run> {
  w = await openWorld({ agents: { reviewer: hostileChecker() as never } });
  const { id } = await w.queue(EXAMPLE_A);
  const surfaces: { name: string; text: string }[] = [];
  let stops = 0;
  for (;;) {
    const m = await w.run(id);
    surfaces.push({ name: `report at stop ${stops}`, text: w.report(id) });
    surfaces.push({ name: `mc report at stop ${stops}`, text: (await w.mc(["report", id])).out });
    surfaces.push({ name: `plan show at stop ${stops}`, text: (await w.mc(["plan", "show", id])).out });
    surfaces.push({ name: `dashboard at stop ${stops}`, text: strings(w.snapshot()).join("\n") });
    if (m.status !== "stopped") {
      expect(m.status).toBe("done");
      break;
    }
    stops++;
    await w.approve(id);
    expect(stops).toBeLessThan(5);
  }
  surfaces.push({ name: "mc logs", text: (await w.mc(["logs", id])).out });
  surfaces.push({ name: "phone notices", text: w.h.notifications.map((n) => `${n.title}\n${n.message}`).join("\n") });
  surfaces.push({ name: "pull request text", text: pullRequestBody(w, id, "habit-tracker", (undo) => cleanups.push(undo)) });
  surfaces.push({ name: "the brief of the fix", text: w.h.jobsLabeled("fix-setup-guide").map((j) => j.prompt).join("\n") });
  surfaces.push({ name: "events", text: readFileSync(join(w.h.home, "missions", id, "events.jsonl"), "utf8") });
  surfaces.push({ name: "the mission file", text: readFileSync(join(w.h.home, "missions", id, "mission.json"), "utf8") });
  return { id, surfaces, stops };
}

describe("hostile evidence from the second AI", () => {
  it("reaches no surface with a hidden character, a picture, a link or a web address, and the readable words stay", async () => {
    const run = await runHostile();
    // The second AI had something to say at the feature stop, and the feature went through a fix round first.
    expect(run.stops).toBeGreaterThanOrEqual(2);
    expect(w.h.jobsLabeled("fix-setup-guide").length).toBeGreaterThanOrEqual(1);
    const text = (name: string): string => run.surfaces.filter((s) => s.name === name || s.name.startsWith(`${name} at stop`)).map((s) => s.text).join("\n");
    expect(run.surfaces.flatMap((s) => problemsIn(s.name, s.text))).toEqual([]);

    // The words the second AI wrote are still there, on every surface that shows them.
    const stopReport = run.surfaces.find((s) => s.name === "report at stop 1")!.text;
    expect(stopReport).toContain("Taste cannot be seen. reversedzeroisobom chart (web address removed) click here (web address removed)");
    expect(stopReport).toContain(`see ${"(web address removed)"} and ${"(web address removed)"} or ${"(web address removed)"} ${"(web address removed)"}`);
    expect(text("mc report")).toContain("Taste cannot be seen.");
    expect(text("plan show")).toContain(`Evidence: The file says “${QUOTE}” in docs/setup-guide.md. reversedzeroisobom chart (web address removed)`);
    expect(text("plan show")).toContain("not judged: ");
    expect(text("dashboard")).toContain("Taste cannot be seen. reversedzeroisobom chart (web address removed)");
    // The note and the fix: the final report's review notes, and the brief the builder was given.
    expect(text("report")).toContain("A small thing to tidy. reversedzeroisobom chart (web address removed)");
    expect(run.surfaces.find((s) => s.name === "the brief of the fix")!.text).toContain("It never says what the reader should see. reversedzeroisobom chart (web address removed)");

    // The file name of a note keeps its hidden character shown as a code point, as for any file name.
    expect(text("report")).toContain("docs/setup-guide.md<U+202E>");
    // A file name that closes the code span early and draws a picture and a link is plain words in a code span that it cannot close (W2d-R2).
    const noteLine = text("report").split("\n").find((l) => l.includes("A second small thing to tidy."));
    expect(noteLine).toBeDefined();
    expect(noteLine).toContain(`(in \`\`\` ${CLEAN_FILE} \`\`\`)`);

    // The mission file holds the cleaned words, which is what every reader reads.
    const m = w.h.load(run.id);
    const feature = m.features[0] as Feature;
    expect(feature.openFindings.map((f) => f.file)).toContain(CLEAN_FILE);
    for (const r of feature.checked?.results ?? []) expect(r.evidence).not.toMatch(/evil\.example/u);
    expect(feature.checked?.results[2]?.evidence).toBe(`The file says “${QUOTE}” in docs/setup-guide.md. reversedzeroisobom chart (web address removed) click here (web address removed) see (web address removed) and (web address removed) or (web address removed) (web address removed)`);
  }, 120_000);

  it("a mission file that already holds hostile text (written by hand, or by older code) is still shown plain by the report and `mc plan show`", async () => {
    const run = await runHostile();
    const m = w.h.load(run.id) as Mission;
    const feature = m.features[0] as Feature;
    const hostile = `Raw words.${HOSTILE}`;
    const finding: Finding = { severity: "major", file: HOSTILE_FILE, description: `Check 2 is not met: A check. The second AI found: ${hostile}`, suggestedTest: null };
    feature.openFindings = [finding];
    feature.checked = { ...feature.checked!, results: feature.checked!.results.map((r) => ({ ...r, evidence: hostile })) };
    // A feature checked by tests keeps its finding byte for byte: a reviewer's note may legitimately hold an address.
    const tested: Feature = { ...feature, id: "tested", title: "Tested feature", openFindings: [{ severity: "minor", file: null, description: "See https://docs.example/guide for the API.", suggestedTest: null }] };
    delete (tested as { mode?: string }).mode;
    delete tested.checked;
    m.features = [feature, tested];
    const report = renderReport(m, { usage: [], screenshots: [], generatedAt: "2026-10-12T09:00:00.000Z" });
    expect(problemsIn("report", report.slice(0, report.indexOf("## Technical details")).replace("See https://docs.example/guide for the API.", ""))).toEqual([]);
    expect(report).toContain("Raw words. reversedzeroisobom chart (web address removed)");
    expect(report).toContain(`(in \`\`\` ${CLEAN_FILE} \`\`\`)`);
    expect(report).toContain("See https://docs.example/guide for the API.");
    w.h.store.save(m);
    const shown = (await w.mc(["plan", "show", run.id])).out;
    expect(problemsIn("plan show", shown)).toEqual([]);
    expect(shown).toContain("Evidence: Raw words. reversedzeroisobom chart (web address removed)");
  }, 120_000);

  it("the same cleaning holds with the flag that turns the owner's stop off: no stop, and the report is still plain", async () => {
    w = await openWorld({ agents: { reviewer: hostileChecker() as never } });
    const { id } = await w.queue(EXAMPLE_A, ["--no-owner-checkpoint"]);
    let m = await w.run(id);
    while (m.status === "stopped") {
      await w.approve(id);
      m = await w.run(id);
    }
    expect(m.status).toBe("done");
    const text = [w.report(id), (await w.mc(["plan", "show", id])).out, (await w.mc(["report", id])).out, strings(w.snapshot()).join("\n")].join("\n");
    expect(problemsIn("all", text)).toEqual([]);
    expect(text).toContain("(web address removed)");
  }, 120_000);
});
