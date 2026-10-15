// T-MODES-TILES: the feature tile of the dashboard for a feature checked by a second AI (docs/modes-spec.md, 11.5).
//
// The words of the page are written in the page itself, not in the snapshot, so a text-only check of the snapshot cannot see them.
// The page is therefore drawn in a real browser from snapshots that the real engine wrote (the mock team builds the examples of the
// spec; nothing calls an AI), and the text of each tile is read back. The rule: a tile of a feature that no test checked never says
// "checked" alone, never says "No checks written", and says how many checks are on the list or how the feature was checked.
// The drawn tests are skipped when this computer has no browser; the snapshot facts they rest on are checked either way.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Snapshot } from "../src/dashboard/types.js";
import { findChromium } from "../src/render.js";
import { type AgentHandler, buildOutput, isMaker, writeFile } from "./fixtures/mission-harness.js";
import { EXAMPLE_A, EXAMPLE_B, EXAMPLE_C, MADE, openWorld, TITLE, type World } from "./modes-real-kit.js";

let w: World;
afterEach(() => w?.cleanup());

/** Runs the mission through every stop of the plan and of the owner (the owner approves each) until it is no longer stopped. */
async function finish(world: World, id: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const m = await world.run(id);
    if (m.status !== "stopped" || m.checkpoint?.state !== "pending") return;
    await world.approve(id);
  }
}

const tilesOf = (s: Snapshot, missionIndex = 0) => s.missions[missionIndex]?.features ?? [];
const BAD_GUIDE = "# Notes\n\nShort.\n";

/** A mock builder that writes a guide Mission Control's own checks refuse for its first `bad` tries, then the real one. */
function guideBuilder(bad: number, defaults: () => AgentHandler): AgentHandler {
  return (job, call) => {
    const made = isMaker(job) && call.feature === "setup-guide" ? MADE["setup-guide"] : undefined;
    if (!made) return defaults()(job, call);
    return { edit: (cwd) => writeFile(cwd, made.path, call.n <= bad ? BAD_GUIDE : made.text), structured: buildOutput("wrote it") };
  };
}

/** A world whose builder of the guide fails Mission Control's own checks for its first `bad` tries. */
async function worldWithBadGuide(bad: number): Promise<World> {
  const holder: { world?: World } = {};
  holder.world = await openWorld({ agents: { engineer: guideBuilder(bad, () => holder.world!.h.defaults.engineer) } });
  return holder.world;
}

describe("what the snapshot says about the tile of a feature checked by a second AI", () => {
  it("carries the number of checks on the list and, once done, the words for how it was checked; a feature checked by tests carries neither", async () => {
    w = await openWorld();
    const { id } = await w.queue(EXAMPLE_C);
    await finish(w, id);
    const [totals, notes] = tilesOf(w.snapshot());
    expect(totals).toMatchObject({ title: TITLE.totals, state: "done" });
    expect(Object.keys(totals ?? {})).not.toContain("modeChecks");
    expect(Object.keys(totals ?? {})).not.toContain("checkedBy");
    expect(notes).toMatchObject({ title: TITLE.notes, state: "done", modeChecks: 2, checkedBy: "Checked by a second AI against your list" });
    expect(notes?.reason).toBeNull();
  });

  it("says the retry of such a feature was a build, not a check", async () => {
    w = await worldWithBadGuide(1);
    const { id } = await w.queue(EXAMPLE_A);
    await finish(w, id);
    const [guide] = tilesOf(w.snapshot());
    expect(guide).toMatchObject({ state: "done", recovered: true, modeChecks: 4 });
    expect(guide?.reason).toEqual({ text: "Built after a retry.", author: "engine" });
  });
});

// ───────────────────────────── The page, drawn ─────────────────────────────

const CHROMIUM = findChromium();
const PAGE = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "index.html");
const scratch = mkdtempSync(join(tmpdir(), "mc-tiles-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The text of every tile of every snapshot, by the name the snapshot was given: `{ [name]: { [feature title]: text } }`. */
async function drawTiles(snapshots: Record<string, Snapshot>): Promise<Record<string, Record<string, string>>> {
  const { chromium } = (await import("playwright-core")) as unknown as { chromium: { launch(o: Record<string, unknown>): Promise<any> } };
  const html = readFileSync(PAGE, "utf8");
  const at = html.indexOf("<script");
  const demo = `<script type="application/json" id="mc-demo">${JSON.stringify(snapshots).replace(/</g, "\\u003c")}</script>\n`;
  mkdirSync(scratch, { recursive: true });
  const file = join(scratch, "page.html");
  writeFileSync(file, html.slice(0, at) + demo + html.slice(at));
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(String(e)));
    const out: Record<string, Record<string, string>> = {};
    for (const name of Object.keys(snapshots)) {
      await page.goto(`file://${file}#demo=${name}`);
      await page.waitForSelector(".tile, details.donebox");
      // textContent, not innerText: a finished mission folds its tiles away, and folded text is not drawn.
      out[name] = await page.evaluate(
        `(function () { var r = {}; document.querySelectorAll(".tile").forEach(function (t) { var h = t.querySelector(".tile-title"); r[h ? h.textContent : "?"] = Array.prototype.map.call(t.children, function (c) { return c.textContent; }).join(" | "); }); return r; })()`,
      );
    }
    expect(errors).toEqual([]);
    return out;
  } finally {
    await browser.close();
  }
}

const NEVER = [/checked on the first try/i, /Built and checked/i, /No checks written/i, /checks? written for this feature/i];

describe.skipIf(CHROMIUM === undefined)("the page, drawn in a browser from what the real engine wrote", () => {
  it("never claims tests or checking for a feature that no test checked: first try, owner stop, retry, stuck, and a mixed mission", async () => {
    const snapshots: Record<string, Snapshot> = {};

    // A first try, done (example A).
    w = await openWorld();
    let q = await w.queue(EXAMPLE_A);
    await finish(w, q.id);
    snapshots["first-try"] = w.snapshot();
    w.cleanup();

    // The owner's stop (example B), and after the owner's answer.
    w = await openWorld();
    q = await w.queue(EXAMPLE_B);
    await w.run(q.id); // the plan stop
    await w.approve(q.id);
    expect((await w.run(q.id)).checkpoint?.kind).toBe("feature");
    snapshots["owner-stop"] = w.snapshot();
    await finish(w, q.id);
    snapshots["owner-approved"] = w.snapshot();
    w.cleanup();

    // A retry: the first try is refused by Mission Control's own checks, the second passes.
    w = await worldWithBadGuide(1);
    q = await w.queue(EXAMPLE_A);
    await finish(w, q.id);
    snapshots["retry"] = w.snapshot();
    w.cleanup();

    // Stuck: every try is refused.
    w = await worldWithBadGuide(99);
    q = await w.queue(EXAMPLE_A);
    await finish(w, q.id);
    snapshots["stuck"] = w.snapshot();
    w.cleanup();

    // A mixed mission (example C): one feature checked by tests, one by a second AI.
    w = await openWorld();
    q = await w.queue(EXAMPLE_C);
    await finish(w, q.id);
    snapshots["mixed"] = w.snapshot();
    w.cleanup();

    const drawn = await drawTiles(snapshots);
    const text = (name: string, title: string): string => drawn[name]?.[title] ?? `(no tile “${title}” in ${name}: ${Object.keys(drawn[name] ?? {}).join(", ")})`;

    expect(text("first-try", TITLE.guide)).toContain("Built on the first try.");
    expect(text("first-try", TITLE.guide)).toContain("Checked by a second AI against your list");
    expect(text("owner-stop", TITLE.page)).toContain("4 checks on your list");
    expect(text("owner-approved", TITLE.page)).toContain("Checked by a second AI against your list; approved by you");
    expect(text("retry", TITLE.guide)).toContain("Built after a retry.");
    expect(text("retry", TITLE.guide)).toContain("Recovered after a retry");
    expect(text("retry", TITLE.guide)).toContain("Checked by a second AI against your list");
    expect(text("stuck", TITLE.guide)).toContain("4 checks on your list");
    expect(text("mixed", TITLE.notes)).toContain("Built on the first try.");
    expect(text("mixed", TITLE.notes)).toContain("Checked by a second AI against your list");

    // The rule, for every tile of a feature that no test checked.
    const byReading: [string, string][] = [["first-try", TITLE.guide], ["owner-stop", TITLE.page], ["owner-approved", TITLE.page], ["retry", TITLE.guide], ["stuck", TITLE.guide], ["mixed", TITLE.notes]];
    const claims = byReading.flatMap(([name, title]) => NEVER.filter((rule) => rule.test(text(name, title))).map((rule) => `${name} / ${title}: ${rule} in ${text(name, title)}`));
    expect(claims).toEqual([]);

    // And the feature that tests did check keeps its old words (nothing was taken from it).
    expect(text("mixed", TITLE.totals)).toContain("Built and checked on the first try.");
  });
});
