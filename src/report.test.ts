import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReportFacts, collectScreenshots, holdsNeverSay, howToRun, renderReport, usageSummary } from "./report.js";
import type { Feature, Mission, ReportProseOutput, UsageRecord } from "./types.js";

// ───────────────────────────── Fixtures ─────────────────────────────

const MISSION_ID = "2026-10-09-habit-tracker";

function feature(f: Partial<Feature> & Pick<Feature, "id" | "title">): Feature {
  return {
    story: `You can ${f.title.toLowerCase()}.`,
    acceptance: [],
    kind: "standard",
    deps: [],
    status: "pending",
    rung: 0,
    attempts: [],
    frozenTests: [],
    reviewRounds: 0,
    openFindings: [],
    ...f,
  };
}

/** A night with two features done, one stuck, one skipped, a decision, review findings and usage. */
function realisticMission(): Mission {
  const assumptions = ["No login: it is a single-user app on your computer.", "Your habits are saved in a file on this computer."];
  return {
    id: MISSION_ID,
    kind: "greenfield",
    title: "Habit tracker",
    request: "Build me a habit tracker where I can add habits and tick them off each day.",
    repoPath: "/home/pwuser/mc-apps/habit-tracker",
    baseBranch: "main",
    integrationBranch: `mc/${MISSION_ID}`,
    integrationWorktree: `/home/pwuser/.mission-control/worktrees/${MISSION_ID}/_integration`,
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    profile: "mixed",
    roleOverrides: [],
    status: "partial",
    stage: "complete",
    createdAt: "2026-10-09T21:00:00.000Z",
    updatedAt: "2026-10-10T05:00:00.000Z",
    spec: {
      appName: "Habit Tracker",
      summary: "A simple app to keep track of your daily habits",
      features: [],
      assumptions,
      uiContract: "Home page at /, button 'Add habit' (data-testid=add-habit)",
    },
    features: [
      feature({
        id: "add-habit",
        title: "Add a habit",
        story: "You can add a new habit with a name.",
        status: "done",
        commit: "aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd",
        builtBy: "codex",
        attempts: [attempt({ outcome: "pass" })],
        openFindings: [
          { severity: "minor", file: null, description: "The button label could be clearer.", suggestedTest: null },
          {
            severity: "major",
            file: "src/app/page.tsx",
            description: "Empty habit names are accepted.",
            suggestedTest: "Submitting an empty name shows an error.",
          },
        ],
      }),
      feature({
        id: "tick-habit",
        title: "Tick off a habit",
        status: "done",
        commit: "1111111111222222222233333333334444444444",
        builtBy: "claude",
        attempts: [attempt({ outcome: "pass" })],
      }),
      feature({
        id: "streaks",
        title: "Streaks",
        status: "blocked",
        deps: ["tick-habit"],
        branch: `mc/${MISSION_ID}--streaks`,
        blockedReason: "the streak counter kept getting the dates wrong around midnight",
        attempts: [
          attempt({ rung: 0, outcome: "fail", signature: "abc123def456", summary: "2 tests failed" }),
          attempt({ rung: 1, outcome: "fail", signature: "abc123def456", summary: "2 tests failed" }),
          attempt({ rung: 2, action: "diagnose", outcome: "error", summary: "decided to block" }),
        ],
      }),
      feature({
        id: "share-progress",
        title: "Share progress",
        status: "skipped",
        deps: ["streaks"],
        blockedReason: "waiting on streaks, which was blocked",
      }),
    ],
    baselineBroken: false,
    baselineFailures: [],
    verify: { install: "npm install", full: "npm run verify", tests: "node scripts/mc-test.mjs {files}", testGlobs: ["tests/**"] },
    decisionsNeeded: ["Should a streak survive a skipped weekend?"],
    gateCRounds: 0,
    agentRuns: 14,
    notes: [...assumptions, "Restored src/app/page.tsx, which the test author changed."],
  };
}

function attempt(a: Partial<Feature["attempts"][number]>): Feature["attempts"][number] {
  return {
    rung: 0,
    action: "build",
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "medium",
    outcome: "pass",
    summary: "",
    at: "2026-10-10T01:00:00.000Z",
    ...a,
  };
}

function usageRecord(r: Partial<UsageRecord> & Pick<UsageRecord, "provider" | "model">): UsageRecord {
  return {
    at: "2026-10-10T01:00:00.000Z",
    missionId: MISSION_ID,
    role: "engineer",
    effort: "medium",
    outcome: "ok",
    durationMs: 10 * 60_000,
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...r,
  };
}

function realisticUsage(): UsageRecord[] {
  return [
    usageRecord({
      provider: "claude",
      model: "claude-opus-5-5",
      role: "architect",
      usage: { inputTokens: 50_000, outputTokens: 8_000, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 1.25 },
    }),
    usageRecord({ provider: "codex", model: "gpt-6.1-sol", usage: { inputTokens: 120_000, outputTokens: 30_000, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    usageRecord({ provider: "codex", model: "gpt-6.1-sol", outcome: "limited", durationMs: 60_000 }),
    usageRecord({ provider: "codex", model: "gpt-6.1-sol", usage: { inputTokens: 80_000, outputTokens: 20_000, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    usageRecord({
      provider: "claude",
      model: "claude-haiku-5-5",
      role: "scout",
      durationMs: 30_000,
      usage: { inputTokens: 4_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0.004 },
    }),
    // another mission's run: must not appear in this report
    usageRecord({ missionId: "2026-10-08-other", provider: "claude", model: "claude-sonnet-5-5" }),
  ];
}

const PROSE: ReportProseOutput = {
  narrative: "Good morning! Your habit tracker is up and running. You can add habits and tick them off.",
  whatYouCanDo: ["Add a habit by typing its name", "Tick off a habit when you've done it today"],
};

const GENERATED_AT = "2026-10-10T05:00:00.000Z";

/** Rendered as outside the container unless the test says otherwise (inContainer: true). */
function render(m: Mission, opts: Partial<Parameters<typeof renderReport>[1]> = {}): string {
  return renderReport(m, { prose: PROSE, usage: realisticUsage(), screenshots: [], generatedAt: GENERATED_AT, inContainer: false, ...opts });
}

/** The text of one "## <title>" section, without its heading. */
function sectionText(report: string, title: string): string {
  const start = report.indexOf(`\n## ${title}\n`);
  expect(start, `section "${title}" is missing`).toBeGreaterThanOrEqual(0);
  const bodyStart = start + `\n## ${title}\n`.length;
  const next = report.indexOf("\n## ", bodyStart);
  return report.slice(bodyStart, next === -1 ? undefined : next).trim();
}

// ───────────────────────────── usageSummary ─────────────────────────────

describe("usageSummary", () => {
  it("groups runs per provider and model, most-used first, and counts limited runs", () => {
    const summary = usageSummary(realisticUsage());
    expect(summary.totalRuns).toBe(6);
    expect(summary.limitedRuns).toBe(1);
    expect(summary.byModel.map((r) => r.model)).toEqual(["gpt-6.1-sol", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(summary.byModel[0]).toEqual({
      provider: "codex",
      model: "gpt-6.1-sol",
      runs: 3,
      inputTokens: 201_000,
      outputTokens: 50_200,
      estCostUsd: 0,
    });
    expect(summary.byModel.find((r) => r.model === "claude-opus-5-5")?.estCostUsd).toBeCloseTo(1.25);
  });

  it("returns empty totals for no usage", () => {
    expect(usageSummary([])).toEqual({ byModel: [], totalRuns: 0, limitedRuns: 0 });
  });

  it("keeps the same model id from different providers apart", () => {
    const summary = usageSummary([
      usageRecord({ provider: "mock", model: "m" }),
      usageRecord({ provider: "claude", model: "m" }),
    ]);
    expect(summary.byModel.map((r) => r.provider)).toEqual(["claude", "mock"]);
  });

  it("tolerates partial ledger records", () => {
    const broken = { ...usageRecord({ provider: "codex", model: "x" }), usage: undefined } as unknown as UsageRecord;
    const nan = usageRecord({ provider: "codex", model: "x", usage: { inputTokens: Number.NaN, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    const summary = usageSummary([broken, nan]);
    expect(summary.byModel).toEqual([{ provider: "codex", model: "x", runs: 2, inputTokens: 0, outputTokens: 5, estCostUsd: 0 }]);
  });

  it("survives ledger lines without a model or provider, and lines that aren't records", () => {
    const noModel = { ...usageRecord({ provider: "claude", model: "x" }), model: undefined } as unknown as UsageRecord;
    const numericModel = { ...usageRecord({ provider: "claude", model: "x" }), model: 7 } as unknown as UsageRecord;
    const noProvider = { ...usageRecord({ provider: "claude", model: "y" }), provider: undefined } as unknown as UsageRecord;
    const junk = [null, 5, "text"] as unknown as UsageRecord[];
    const summary = usageSummary([noModel, numericModel, noProvider, ...junk]);
    expect(summary.totalRuns).toBe(3);
    expect(summary.byModel.map((r) => [r.provider, r.model, r.runs])).toEqual([
      ["claude", "unknown model", 2],
      [undefined, "y", 1],
    ]);
  });
});

// ───────────────────────────── howToRun ─────────────────────────────

describe("howToRun", () => {
  it("gives the house-stack commands for a greenfield app", () => {
    expect(howToRun(realisticMission())).toEqual([
      "cd /home/pwuser/mc-apps/habit-tracker",
      "npm install",
      "npm run dev",
      "open http://localhost:3000",
    ]);
  });

  it("checks out the mission branch for a done feature mission, then installs and runs the checks", () => {
    const m: Mission = {
      ...realisticMission(),
      kind: "feature",
      status: "done",
      repoPath: "/work/shop",
      verify: { install: "npm ci", full: "npm test", testGlobs: ["test/**"] },
    };
    expect(howToRun(m)).toEqual(["cd /work/shop", `git checkout mc/${MISSION_ID}`, "npm ci", "npm test"]);
  });

  it("uses a detached checkout while an unfinished feature mission still has its branch checked out", () => {
    for (const status of ["partial", "stopped", "failed"] as const) {
      const m: Mission = { ...realisticMission(), kind: "feature", status, repoPath: "/work/shop", verify: undefined };
      expect(howToRun(m), status).toEqual(["cd /work/shop", `git checkout --detach mc/${MISSION_ID}`]);
    }
  });

  it("checks out the work of a greenfield app that stopped before main was moved up to it", () => {
    const m: Mission = { ...realisticMission(), status: "stopped", stage: "features" };
    expect(howToRun(m)).toEqual([
      "cd /home/pwuser/mc-apps/habit-tracker",
      `git checkout --detach mc/${MISSION_ID}`,
      "npm install",
      "npm run dev",
      "open http://localhost:3000",
    ]);
    expect(howToRun({ ...m, stage: "finalize" })[1]).toBe("npm install");
  });

  it("quotes paths that the shell would split", () => {
    const m: Mission = { ...realisticMission(), repoPath: "/home/me/my apps/bob's app" };
    expect(howToRun(m)[0]).toBe(`cd '/home/me/my apps/bob'\\''s app'`);
  });

  it("has nothing to run when the app was never created", () => {
    expect(howToRun({ ...realisticMission(), repoPath: "" })).toEqual([]);
  });

  it("has nothing to run when no feature was finished", () => {
    const m = realisticMission();
    const unfinished = m.features.map((f) => ({ ...f, status: f.status === "done" ? ("blocked" as const) : f.status }));
    const pending = m.features.map((f) => ({ ...f, status: "pending" as const }));
    // greenfield whose scaffolding never went green: the folder holds only an empty first commit
    expect(howToRun({ ...m, status: "failed", stage: "init", features: pending })).toEqual([]);
    expect(howToRun({ ...m, features: unfinished })).toEqual([]);
    expect(howToRun({ ...m, kind: "feature", features: unfinished })).toEqual([]);
  });

  describe("against real git", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "mc-report-git-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" });

    it("gives a checkout that works while the mission's own worktree holds the branch", () => {
      const repo = join(dir, "shop");
      git(dir, "init", "-q", "-b", "main", repo);
      git(repo, "commit", "-q", "--allow-empty", "-m", "init");
      const branch = `mc/${MISSION_ID}`;
      git(repo, "worktree", "add", "-q", "-b", branch, join(dir, "_integration"));
      git(join(dir, "_integration"), "commit", "-q", "--allow-empty", "-m", "feat: work");

      const m: Mission = { ...realisticMission(), kind: "feature", status: "partial", repoPath: repo, verify: undefined };
      const [cd, checkout] = howToRun(m);
      expect(cd).toBe(`cd ${repo}`);
      expect(() => git(repo, "checkout", branch)).toThrow(/already (used|checked out)/);
      execSync(checkout!, { cwd: repo, stdio: "pipe" });
      expect(git(repo, "log", "-1", "--format=%s").toString().trim()).toBe("feat: work");
    });
  });
});

// ───────────────────────────── buildReportFacts ─────────────────────────────

describe("buildReportFacts", () => {
  it("lists features with status and reasons, choices, decisions, findings and totals", () => {
    const facts = buildReportFacts(realisticMission(), realisticUsage());
    expect(facts).toContain("Mission: Habit tracker");
    expect(facts).toContain("Request: Build me a habit tracker where I can add habits and tick them off each day.");
    expect(facts).toContain("Status: Partly done (partial). 2 of 4 features done, 1 blocked, 1 skipped, 0 unfinished.");
    expect(facts).toContain("Plan summary: A simple app to keep track of your daily habits");
    expect(facts).toContain(`- add-habit "Add a habit" [done]: You can add a new habit with a name.`);
    expect(facts).toContain(
      `- streaks "Streaks" [blocked]: the streak counter kept getting the dates wrong around midnight (after 3 attempts)`,
    );
    expect(facts).toContain(`- share-progress "Share progress" [skipped]: waiting on streaks, which was blocked`);
    expect(facts).toContain("- No login: it is a single-user app on your computer.");
    expect(facts).toContain("- Should a streak survive a skipped weekend?");
    expect(facts).toContain("- [major] add-habit (src/app/page.tsx): Empty habit names are accepted.");
    expect(facts).toContain("- [minor] add-habit: The button label could be clearer.");
    // only this mission's 5 runs count
    expect(facts).toContain("Totals: 5 agent runs (1 stopped by usage limits)");
    expect(facts).toContain("estimated list-price cost $1.25");
    expect(facts).toContain("- npm run dev");
  });

  it("keeps run notes but drops the assumptions the dispatcher copied into them", () => {
    const facts = buildReportFacts(realisticMission(), []);
    const notes = facts.slice(facts.indexOf("Run notes:"));
    expect(notes).toContain("Restored src/app/page.tsx");
    expect(notes).not.toContain("No login");
  });

  // R1-3 of the real runs: the architect's guess for the planner ("probably return !") sat next to the leader plan's own choice ("stays empty").
  describe("the architect's notes for the planner, when the leader wrote the plan (R1-3)", () => {
    const GUESS =
      'Onboarding: To match capitalize\'s conventions, shout should probably throw a TypeError for non-string input. For an empty string it should probably return "!". The planner should state both explicitly.';
    const withGuess = (plan: boolean): Mission => {
      const base = realisticMission();
      const m: Mission = { ...base, notes: [...base.notes, GUESS] };
      return plan ? { ...m, plan: { spec: m.spec as never, sha256: `bcd846ce${"0".repeat(56)}`, at: "2026-10-12T09:00:00.000Z" } } : m;
    };

    it("leaves the note out of the report and out of the facts for the AI that writes the summary", () => {
      const m = withGuess(true);
      const report = render(m, { prose: null });
      expect(report).not.toContain("should probably");
      expect(report).not.toContain("Onboarding:");
      expect(buildReportFacts(m, [])).not.toContain("should probably");
      // the other run notes stay
      expect(sectionText(report, "Technical details")).toContain("### Run notes\n\n- Restored src/app/page.tsx, which the test author changed.");
    });

    it("keeps the note for a mission the team's planner planned (nothing changes there)", () => {
      const m = withGuess(false);
      expect(sectionText(render(m, { prose: null }), "Technical details")).toContain(`- ${GUESS}`);
      expect(buildReportFacts(m, [])).toContain(GUESS);
    });

    it("leaves out no other note of a plan mission, and drops the Run notes block when only that note was there", () => {
      const m = withGuess(true);
      const only: Mission = { ...m, notes: [GUESS] };
      expect(sectionText(render(only, { prose: null }), "Technical details")).not.toContain("Run notes");
      const other: Mission = { ...m, notes: [GUESS, "Onboarding is a word that may start a note of its own", "Stopped early: the quota ran out."] };
      const tech = sectionText(render(other, { prose: null }), "Technical details");
      expect(tech).toContain("- Onboarding is a word that may start a note of its own");
      expect(tech).toContain("- Stopped early: the quota ran out.");
      expect(tech).not.toContain("should probably");
    });
  });

  it("says (none) for empty lists so the writer doesn't invent anything", () => {
    const m: Mission = {
      ...realisticMission(),
      status: "failed",
      spec: undefined,
      features: [],
      decisionsNeeded: [],
      notes: [],
      repoPath: "",
    };
    const facts = buildReportFacts(m, []);
    expect(facts).toContain("Status: Stopped, needs your help (failed). 0 of 0 features done");
    expect(facts.match(/- \(none\)/g)).toHaveLength(6);
    expect(facts).toContain("Totals: 0 agent runs");
  });

  it("explains a partial mission whose features are all done", () => {
    const m = realisticMission();
    m.features = m.features.slice(0, 2);
    expect(buildReportFacts(m, [])).toContain(
      "Why partly done: every feature is done, but the final checks or reviews of the whole app left problems open (see the decisions and Run notes).",
    );
    expect(buildReportFacts(realisticMission(), [])).not.toContain("Why partly done");
  });

  it("mentions checks that were failing before a feature mission started", () => {
    const m: Mission = {
      ...realisticMission(),
      kind: "feature",
      baselineBroken: true,
      baselineFailures: ["FAIL tests/legacy.test.ts > old thing"],
    };
    const facts = buildReportFacts(m, []);
    expect(facts).toContain("Kind: a change to an existing app (/home/pwuser/mc-apps/habit-tracker)");
    expect(facts).toContain("Checks that were already failing before the mission started:\n- FAIL tests/legacy.test.ts > old thing");
  });
});

// ───────────────────────────── renderReport ─────────────────────────────

describe("renderReport", () => {
  it("puts the plain-language sections first, in the agreed order, and technical details last", () => {
    const report = render(realisticMission(), { screenshots: ["/x/missions/m/screenshots/home.png"] });
    const headings = [
      "# Habit tracker",
      "**Partly done**",
      PROSE.narrative,
      "## What you can do now",
      "## How to try it",
      "## Needs your decision",
      "## Features",
      "## What it looks like",
      "## Choices I made for you",
      "## Review notes",
      "## Usage",
      "## Technical details",
    ];
    const positions = headings.map((h) => report.indexOf(h));
    positions.forEach((p, i) => expect(p, headings[i]).toBeGreaterThanOrEqual(0));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(report.startsWith("# Habit tracker\n\n**Partly done** · 2 of 4 features done · report written ")).toBe(true);
    expect(report.endsWith("\n")).toBe(true);
    expect(report).not.toMatch(/\n{3,}/);
  });

  it("keeps jargon out of everything above the features table", () => {
    for (const prose of [PROSE, null]) {
      const report = render(realisticMission(), { prose, screenshots: ["/x/missions/m/screenshots/home.png"] });
      const top = report.slice(0, report.indexOf("## Features"));
      expect(top).not.toMatch(/\b(worktree|rung|sha|commit|stage|gate|verify|frozen|anti-?cheat|integration|profile|mc\/)\b/i);
      expect(top).not.toContain(MISSION_ID);
    }
  });

  it("uses the scout's narrative and bullets when given", () => {
    const report = render(realisticMission());
    expect(report).toContain(PROSE.narrative);
    expect(sectionText(report, "What you can do now")).toBe(
      "- Add a habit by typing its name\n- Tick off a habit when you've done it today",
    );
  });

  it("falls back to a template narrative and the done features when prose is null", () => {
    const report = render(realisticMission(), { prose: null });
    expect(report).toContain(
      "I worked on your new app, “Habit tracker”. The plan: A simple app to keep track of your daily habits. " +
        "2 of the 4 features are built and checked. 1 feature got stuck; the table below says why. " +
        "1 feature depended on a stuck feature, so I skipped it. " +
        "There are 2 things I need you to decide; see “Needs your decision”.",
    );
    expect(sectionText(report, "What you can do now")).toBe(
      "- **Add a habit**: You can add a new habit with a name.\n- **Tick off a habit**: You can tick off a habit.",
    );
  });

  it("falls back per part when the prose is blank", () => {
    const report = render(realisticMission(), { prose: { narrative: "  ", whatYouCanDo: [" ", ""] } });
    expect(report).toContain("I worked on your new app, “Habit tracker”.");
    expect(sectionText(report, "What you can do now")).toContain("**Add a habit**");
  });

  it("numbers the commands to try the app, with a plain note on each", () => {
    expect(sectionText(render(realisticMission()), "How to try it")).toBe(
      [
        "Open a terminal and run these one at a time:",
        "",
        "1. `cd /home/pwuser/mc-apps/habit-tracker`: go to the app's folder",
        "2. `npm install`: download what the app needs (slow the first time)",
        "3. `npm run dev`: start the app (leave this window open while you try it)",
        "4. Open http://localhost:3000 in your browser.",
        "",
        "When you're done, press Ctrl+C to stop the app.",
      ].join("\n"),
    );
  });

  it("in the container, starts with mc shell (Ubuntu has no Node) and writes paths that work in Ubuntu too", () => {
    vi.stubEnv("HOME", "/home/pwuser");
    try {
      expect(sectionText(render(realisticMission(), { inContainer: true }), "How to try it")).toBe(
        [
          "The app is in your folder `~/mc-apps/habit-tracker` (in Windows File Explorer: " +
            "`\\\\wsl.localhost\\Ubuntu\\home\\<your Ubuntu name>\\mc-apps\\habit-tracker`).",
          "",
          "In the Ubuntu window, run `mc shell` first: it opens a terminal inside Mission Control's container, which has " +
            "everything the app needs. Then run these one at a time:",
          "",
          "1. `cd ~/mc-apps/habit-tracker`: go to the app's folder",
          "2. `npm install`: download what the app needs (slow the first time)",
          "3. `npm run dev`: start the app (leave this window open while you try it)",
          "4. Open http://localhost:3000 in your browser.",
          "",
          "When you're done, press Ctrl+C to stop the app and type `exit`.",
        ].join("\n"),
      );
      // "~" stays outside the quotes, so the shell still expands it.
      expect(howToRun({ ...realisticMission(), repoPath: "/home/pwuser/mc-apps/my app" }, { inContainer: true })[0]).toBe("cd ~/'mc-apps/my app'");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shows the decisions the user needs to make, and how to have another go at the features that weren't finished", () => {
    expect(sectionText(render(realisticMission()), "Needs your decision")).toBe(
      [
        "- Should a streak survive a skipped weekend?",
        "- 2 features weren't finished, and I won't try again by myself: “Streaks” (got stuck) and “Share progress” " +
          "(skipped: it needed a stuck feature). The “Features” table says why. To have another go, queue them as a change " +
          "to the app: `mc feature /home/pwuser/mc-apps/habit-tracker 'Streaks: You can streaks. Share progress: You can " +
          "share progress.' --base main`. It starts on the next run.",
      ].join("\n"),
    );
  });

  it("gives the retry command for a change to an existing app from its own branch, quoted for the shell, with ~ in the container", () => {
    vi.stubEnv("HOME", "/home/pwuser");
    try {
      const m: Mission = { ...realisticMission(), kind: "feature", repoPath: "/home/pwuser/mc-apps/shop", decisionsNeeded: [] };
      m.features = [m.features[0]!, { ...m.features[2]!, title: "Bob's streaks", story: "You can see Bob's streaks." }];
      const decisions = sectionText(render(m, { inContainer: true }), "Needs your decision");
      expect(decisions).toContain("1 feature wasn't finished, and I won't try again by myself: “Bob's streaks” (got stuck).");
      expect(decisions).toContain(
        `queue it as a change to the app (in the Ubuntu window): \`mc feature ~/mc-apps/shop 'Bob'\\''s streaks: You can see Bob'\\''s streaks.' --base mc/${MISSION_ID}\``,
      );
    } finally {
      vi.unstubAllEnvs();
    }
    // Not while the mission can still continue: its stuck features are its own business until it finishes.
    const paused = render({ ...realisticMission(), status: "stopped", stage: "features" });
    expect(sectionText(paused, "Needs your decision")).toBe("- Should a streak survive a skipped weekend?");
  });

  it("says what to do when every feature is done but the final check of the whole app failed", () => {
    const m = realisticMission();
    m.features = m.features.slice(0, 2);
    m.decisionsNeeded = [];
    expect(sectionText(render(m), "Needs your decision")).toBe(
      "- Every feature passed its own checks, but the final check of the whole app didn't, so some parts may not work right " +
        "yet (“Technical details” has what it found). Have someone look at the app before you rely on it.",
    );
  });

  it("shows every feature with ✅ or ⛔ and a plain reason", () => {
    expect(sectionText(render(realisticMission()), "Features")).toBe(
      [
        "|  | Feature | What happened |",
        "|---|---|---|",
        "| ✅ | Add a habit | Built and checked (2 review notes below) |",
        "| ✅ | Tick off a habit | Built and checked |",
        "| ⛔ | Streaks | Stuck: the streak counter kept getting the dates wrong around midnight (tried 3 times) |",
        "| ⛔ | Share progress | Skipped: waiting on streaks, which was blocked |",
      ].join("\n"),
    );
  });

  it("marks unfinished features as in progress instead of failed", () => {
    const m = realisticMission();
    m.status = "stopped";
    m.features[2] = { ...m.features[2]!, status: "building", blockedReason: undefined };
    m.features[3] = { ...m.features[3]!, status: "pending", blockedReason: undefined };
    const report = render(m, { prose: null });
    expect(report).toContain("| ⏳ | Streaks | Started but not finished |");
    expect(report).toContain("| ⏳ | Share progress | Not started yet |");
    expect(report).toContain("**Paused, continues on the next run** · 2 of 4 features done");
    expect(report).toContain("2 features aren't finished yet. The run stopped before I could finish.");
  });

  it("escapes table separators and flattens multi-line reasons", () => {
    const m = realisticMission();
    m.features[2] = { ...m.features[2]!, title: "Import | export", blockedReason: "the file format\nwas unclear" };
    expect(render(m)).toContain("| ⛔ | Import \\| export | Stuck: the file format was unclear (tried 3 times) |");
  });

  it("lists the assumptions as choices made for the user", () => {
    expect(sectionText(render(realisticMission()), "Choices I made for you")).toBe(
      "- No login: it is a single-user app on your computer.\n- Your habits are saved in a file on this computer.",
    );
  });

  it("lists open review findings, most serious first", () => {
    expect(sectionText(render(realisticMission()), "Review notes")).toBe(
      [
        "- **Add a habit** · Important: Empty habit names are accepted. (in `src/app/page.tsx`) " +
          "Suggested check: Submitting an empty name shows an error.",
        "- **Add a habit** · Small: The button label could be clearer.",
      ].join("\n"),
    );
  });

  it("summarizes usage per model for this mission only", () => {
    const usage = sectionText(render(realisticMission()), "Usage");
    expect(usage).toContain("5 agent runs, 1 run paused by a usage limit, about 32 min of agent time.");
    expect(usage).toContain("| gpt-6.1-sol | Codex | 3 | 201,000 | 50,200 | — |");
    expect(usage).toContain("| claude-opus-5-5 | Claude Code | 1 | 50,000 | 8,000 | $1.25 |");
    expect(usage).toContain("| claude-haiku-5-5 | Claude Code | 1 | 4,000 | 500 | <$0.01 |");
    expect(usage).toContain("| **Total** |  | 5 | 255,000 | 58,700 | $1.25 |");
    expect(usage).not.toContain("claude-sonnet-5-5");
  });

  it("puts branches, commits, attempts, logs and the mission id in the technical details", () => {
    const tech = sectionText(render(realisticMission()), "Technical details");
    expect(tech).toContain(`Mission id: \`${MISSION_ID}\` (greenfield, profile \`mixed\`)`);
    expect(tech).toContain("Started from: `main` at `0123456789`");
    expect(tech).toContain(`Integration branch: \`mc/${MISSION_ID}\``);
    expect(tech).toContain(`Integration worktree: \`/home/pwuser/.mission-control/worktrees/${MISSION_ID}/_integration\``);
    expect(tech).toContain("Full check: `npm run verify` · test files: `node scripts/mc-test.mjs {files}`");
    expect(tech).toContain("agent runs: 14");
    expect(tech).toContain(`\`mc logs ${MISSION_ID}\``);
    expect(tech).toContain(
      `Logs: \`missions/${MISSION_ID}/logs/\` and \`missions/${MISSION_ID}/events.jsonl\` in the Mission Control home folder`,
    );
    expect(tech).toContain(`Report generated: ${GENERATED_AT}`);
    expect(tech).toContain("| `add-habit` | done | `aaaaaaaaaa` |  | codex | 1 |");
    expect(tech).toContain(`| \`streaks\` | blocked |  | \`mc/${MISSION_ID}--streaks\` |  | 3 |`);
    expect(tech).toContain("### What was tried for `streaks`");
    expect(tech).toContain(
      "- 2026-10-10T01:00:00.000Z · rung 0 build · codex `gpt-6.1-sol` (medium) · fail · signature `abc123def456`: 2 tests failed",
    );
    expect(tech).not.toContain("What was tried for `add-habit`");
    expect(tech).toContain("### Run notes\n\n- Restored src/app/page.tsx, which the test author changed.");
    expect(tech).not.toContain("No login");
  });

  it("embeds screenshots with relative links", () => {
    const report = render(realisticMission(), {
      screenshots: [`/home/u/.mission-control/missions/${MISSION_ID}/screenshots/home_page-1.png`, "shots/add habit (1).png"],
    });
    expect(sectionText(report, "What it looks like")).toBe(
      "![home page 1](screenshots/home_page-1.png)\n\n![add habit (1)](shots/add%20habit%20%281%29.png)",
    );
  });

  it("links screenshots relative to another folder the report is saved in", () => {
    const home = "/home/u/.mission-control";
    const report = render(realisticMission(), {
      screenshots: [`${home}/missions/${MISSION_ID}/screenshots/home.png`],
      reportDir: `${home}/reports`,
    });
    expect(sectionText(report, "What it looks like")).toBe(`![home](../missions/${MISSION_ID}/screenshots/home.png)`);
  });

  it("leaves out the screenshots section when there are none", () => {
    expect(render(realisticMission())).not.toContain("What it looks like");
  });

  it("reports a fully done mission", () => {
    const m = realisticMission();
    m.status = "done";
    m.features = m.features.slice(0, 2).map((f) => ({ ...f, openFindings: [] }));
    m.decisionsNeeded = [];
    const report = render(m, { prose: null });
    expect(report).toContain("**Done** · 2 of 2 features done");
    expect(report).toContain("All 2 features are built and checked. Everything passed the final checks.");
    expect(sectionText(report, "Needs your decision")).toBe("Nothing. You don't need to do anything.");
    expect(sectionText(report, "Review notes")).toBe("No open review notes.");
  });

  it("says why a mission is only partly done when every feature is done", () => {
    const m = realisticMission();
    m.features = m.features.slice(0, 2);
    m.decisionsNeeded = [];
    m.notes.push("gate C: major: adding a habit breaks the list page");
    const report = render(m, { prose: null });
    expect(report).toContain("**Partly done** · 2 of 2 features done");
    expect(report).toContain(
      "All 2 features are built and checked. But the final checks or reviews of the whole app left problems open, so some parts " +
        "may not work right yet. “Needs your decision” and “Technical details” say what they found.",
    );
    expect(sectionText(report, "Technical details")).toContain("- gate C: major: adding a habit breaks the list page");
  });

  it("doesn't offer commands when a greenfield app's scaffolding never went green", () => {
    const m: Mission = { ...realisticMission(), status: "failed", stage: "init" };
    m.features = m.features.map((f) => ({ ...f, status: "pending", blockedReason: undefined }));
    const report = render(m, { prose: null, usage: [] });
    expect(sectionText(report, "How to try it")).toBe("There's nothing to try yet: the app wasn't created.");
    expect(sectionText(report, "What you can do now")).toBe("Nothing new to try yet: none of the features were finished.");
    expect(report).not.toContain("npm run dev");
  });

  it("doesn't offer commands when no feature of an existing app was finished", () => {
    const m: Mission = { ...realisticMission(), kind: "feature", status: "stopped", stage: "features" };
    m.features = m.features.map((f) => ({ ...f, status: "pending" }));
    expect(sectionText(render(m, { prose: null }), "How to try it")).toBe(
      "There's nothing to try yet: none of the features were finished.",
    );
  });

  it("still writes the report when a usage ledger line is malformed", () => {
    const bad = { ...usageRecord({ provider: "claude", model: "x" }), model: undefined } as unknown as UsageRecord;
    const report = render(realisticMission(), { usage: [bad, null as unknown as UsageRecord] });
    expect(sectionText(report, "Usage")).toContain("| unknown model | Claude Code | 1 |");
  });

  it("reports a mission that failed before anything was planned", () => {
    const m: Mission = {
      ...realisticMission(),
      status: "failed",
      stage: "spec",
      repoPath: "",
      spec: undefined,
      features: [],
      notes: [],
      decisionsNeeded: ["Log in again: run mc-docker.sh login-claude"],
      integrationWorktree: undefined,
      baseSha: undefined,
      verify: undefined,
    };
    const report = render(m, { prose: null, usage: [] });
    expect(report).toContain("**Stopped, needs your help** · no features planned yet");
    expect(report).toContain("I didn't get as far as planning the features. I hit a problem I couldn't get past on my own");
    expect(sectionText(report, "How to try it")).toBe("There's nothing to try yet: the app wasn't created.");
    expect(sectionText(report, "What you can do now")).toBe("Nothing new to try yet: none of the features were finished.");
    expect(sectionText(report, "Features")).toBe("No features were planned yet.");
    expect(sectionText(report, "Choices I made for you")).toBe("None. I followed your request as written.");
    expect(sectionText(report, "Usage")).toBe("No agent runs were recorded.");
    expect(sectionText(report, "Technical details")).toContain("Repository: not created");
  });

  it("explains a feature mission: branch checkout, existing failures, and starting the app", () => {
    const m: Mission = {
      ...realisticMission(),
      kind: "feature",
      title: "Add dark mode",
      repoPath: "/home/pwuser/mc-apps/shop",
      decisionsNeeded: [],
      baselineBroken: true,
      baselineFailures: ["FAIL tests/legacy.test.ts", "1 failed, 40 passed"],
    };
    const report = render(m, { prose: null });
    expect(report).toContain("I worked on your request for shop: “Add dark mode”.");
    const howTo = sectionText(report, "How to try it");
    expect(howTo).toContain(`2. \`git checkout --detach mc/${MISSION_ID}\`: switch to the version with the new work`);
    expect(howTo).toContain("3. `npm install`: download what the app needs");
    expect(howTo).toContain("4. `npm run verify`: run the project's own checks");
    expect(howTo).toContain("Then start your app the way you usually do.");
    // The detached checkout must be undone before the next `mc feature`, and the change kept or left on purpose.
    expect(howTo).toContain("When you're done, put the folder back on your own version with `git checkout main`.");
    expect(howTo).toContain(`To keep the change, add it to your own version (\`main\`), in the app's folder: \`git checkout main && git merge mc/${MISSION_ID}\`.`);
    expect(howTo).toContain("If you don't want it, do nothing");
    expect(sectionText(report, "Needs your decision")).toContain("already failing before I started");
    expect(report).toContain("There are 2 things I need you to decide"); // that, and the features that weren't finished
    expect(sectionText(report, "Technical details")).toContain(
      "### Checks failing before the mission\n\n```\nFAIL tests/legacy.test.ts\n1 failed, 40 passed\n```",
    );
  });

  it("starts a changed app with its own dev script, when it has one, instead of only running its checks", () => {
    const repo = mkdtempSync(join(tmpdir(), "mc-report-app-"));
    try {
      writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { dev: "next dev", verify: "npm test" } }));
      const m: Mission = { ...realisticMission(), kind: "feature", status: "done", repoPath: repo, decisionsNeeded: [] };
      m.features = m.features.slice(0, 2);
      expect(howToRun(m)).toEqual([`cd ${repo}`, `git checkout mc/${MISSION_ID}`, "npm install", "npm run dev"]);
      const howTo = sectionText(render(m), "How to try it");
      expect(howTo).toContain("4. `npm run dev`: start the app (leave this window open while you try it)");
      expect(howTo).toContain("Then open the address it prints (often http://localhost:3000) in your browser.");
      expect(howTo).toContain("When you're done, press Ctrl+C to stop the app and put the folder back on your own version with `git checkout main`.");
      expect(howTo).toContain(`\`git checkout main && git merge mc/${MISSION_ID}\``);
      expect(howTo).not.toContain("npm run verify");

      writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { start: "node server.js" } }));
      expect(howToRun(m).at(-1)).toBe("npm start");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps the decisions and the features table within the first 40 lines (what `mc report` shows), however many screenshots", () => {
    const screenshots = Array.from({ length: 12 }, (_, i) => `/x/missions/m/screenshots/test-finished-${i + 1}.png`);
    const prose = { narrative: PROSE.narrative, whatYouCanDo: ["One", "Two", "Three", "Four", "Five"] };
    const lines = render(realisticMission(), { prose, screenshots }).split("\n");
    const decisions = lines.indexOf("## Needs your decision");
    const lastFeatureRow = lines.findIndex((l) => l.startsWith("| ⛔ | Share progress |"));
    expect(decisions).toBeGreaterThan(0);
    expect(lastFeatureRow).toBeGreaterThan(decisions);
    expect(lastFeatureRow).toBeLessThan(40);
    expect(lines.indexOf("## What it looks like")).toBeGreaterThan(lastFeatureRow);
  });

  it("keeps control characters from agent text out of the report, so showing it can't drive a terminal", () => {
    const osc52 = "\x1b]52;c;Y3VybCBldmlsLnNoIHwgc2gK\x07";
    const m = realisticMission();
    m.features[0]!.openFindings[0] = { severity: "minor", file: null, description: `Label ${osc52}unclear`, suggestedTest: "\x9b2J check" };
    m.features[2]!.attempts[0] = attempt({ outcome: "fail", summary: `2 tests failed \x1b]0;pwned\x07` });
    const prose = { narrative: `Good morning! ${osc52}`, whatYouCanDo: [`Add a habit\x1b[2J`] };
    for (const text of [render(m, { prose }), buildReportFacts(m, [])]) {
      expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    }
    expect(render(m, { prose })).toContain("Label ]52;c;Y3VybCBldmlsLnNoIHwgc2gKunclear");
  });

  it("names a paused mission and a mission that needs its owner differently, as the night summary does", () => {
    const paused = render({ ...realisticMission(), status: "stopped", stage: "features" }, { prose: null });
    const failed = render({ ...realisticMission(), status: "failed", stage: "features" }, { prose: null });
    expect(paused).toContain("**Paused, continues on the next run** · 2 of 4 features done");
    expect(failed).toContain("**Stopped, needs your help** · 2 of 4 features done");
    expect(buildReportFacts({ ...realisticMission(), status: "stopped" }, [])).toContain("Status: Paused, continues on the next run (stopped).");
  });

  it("uses singular wording for a single feature", () => {
    const m = realisticMission();
    m.status = "done";
    m.features = [m.features[1]!];
    m.decisionsNeeded = [];
    expect(render(m, { prose: null })).toContain("The feature is built and checked.");
  });
});

// ───────────────────────────── Compatibility: a mission with no mode is reported as it was ─────────────────────────────

describe("a mission with no feature that a test does not check", () => {
  const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "report");
  const missionFile = JSON.parse(readFileSync(join(FIXTURES, "legacy-mission.json"), "utf8")) as Mission;
  const parked = (kind: "plan" | "feature" | "final", featureId?: string): NonNullable<Mission["checkpoint"]> => ({
    id: kind === "feature" ? `feature:${featureId}#1` : `${kind}#1`,
    scope: kind === "feature" ? `feature:${featureId}` : kind,
    kind,
    ...(featureId ? { featureId } : {}),
    round: 1,
    state: "pending",
    parkedAt: "2026-10-10T04:00:00.000Z",
    look: { headline: "Check it", lines: ["a line of the look"], ...(kind === "feature" ? { branch: "mc/2026-10-09-habit-tracker--tick-habit", files: ["src/tick.ts"] } : {}) },
  });
  const variants: Record<string, Mission> = {
    complete: missionFile,
    "done-single": { ...missionFile, status: "done", decisionsNeeded: [], features: [missionFile.features[0]!] },
    "done-all": { ...missionFile, status: "done", decisionsNeeded: [], features: missionFile.features.slice(0, 2) },
    "parked-feature": { ...missionFile, status: "stopped", stage: "features", checkpoints: ["plan", "feature", "final"], checkpoint: parked("feature", "tick-habit"), features: [missionFile.features[0]!, { ...missionFile.features[1]!, status: "reviewing" }] },
    "parked-plan-leader": { ...missionFile, status: "stopped", stage: "init", plan: { spec: missionFile.spec!, sha256: `a4adaca5${"0".repeat(56)}`, at: "2026-10-12T09:00:00.000Z" }, checkpoints: ["plan"], checkpoint: parked("plan"), features: [] },
    "parked-final": { ...missionFile, status: "stopped", stage: "gate_c", checkpoints: ["final"], checkpoint: parked("final"), features: missionFile.features.slice(0, 2), checkpointLog: [] },
  };
  const prose: ReportProseOutput = { narrative: "Your habit tracker is up and running. You can add habits and tick them off.", whatYouCanDo: ["Add a habit by typing its name", "Tick off a habit when you've done it today"] };
  // The local time of the report differs with the time zone; the one change on purpose since the golden files were made is the singular.
  const normal = (text: string): string => text.replace(/report written \d{4}-\d\d-\d\d \d\d:\d\d/g, "report written <time>").replaceAll("1 of 1 features done", "1 of 1 feature done");
  const golden = (name: string): string => normal(readFileSync(join(FIXTURES, name), "utf8"));

  it.each(Object.keys(variants))("%s: the report is the same text as the one the end of wave 1 wrote, word for word", (name) => {
    const text = renderReport(variants[name]!, { prose, usage: [], screenshots: [], generatedAt: "2026-10-10T05:00:00.000Z", inContainer: false });
    expect(normal(text)).toBe(golden(`legacy-${name}.report.md`));
  });

  it.each(Object.keys(variants))("%s: the facts for the summary writer are the same text", (name) => {
    expect(normal(buildReportFacts(variants[name]!, []))).toBe(golden(`legacy-${name}.facts.txt`));
  });

  it("the fixtures hold no feature with a mode, so these are the old words", () => {
    for (const m of Object.values(variants)) expect(m.features.some((f) => f.mode !== undefined)).toBe(false);
  });
});

// ───────────────────────────── A mission with a feature that no test checks (docs/modes-spec.md 10.1 and 8.5) ─────────────────────────────

describe("a report for a mission that has a feature no test checks", () => {
  const result = (n: number, r: "pass" | "fail" | "cannot_judge") => ({ n, result: r, evidence: "e", basis: "text" as const });
  const checked = (results: ("pass" | "fail" | "cannot_judge")[], extra = {}): Feature["checked"] => ({
    round: 1,
    reviewer: "claude",
    results: results.map((r, i) => result(i + 1, r)),
    unjudged: results.filter((r) => r === "cannot_judge").length,
    scripted: { problems: [], facts: [] },
    pictures: { taken: 0 },
    ...extra,
  });
  const log = (scope: string, decision: "approve" | "send_back") => ({ id: `${scope}#1`, scope, kind: "feature" as const, round: 1, decision, at: "2026-10-10T03:00:00.000Z" });

  /** A finished mission: one feature with tests, one checked by a second AI, one the plan marked for the owner's look and the owner approved. */
  function mixed(): Mission {
    const m = realisticMission();
    m.status = "done";
    m.decisionsNeeded = [];
    m.features = [
      feature({ id: "add-habit", title: "Add a habit", status: "done", acceptance: ["a", "b", "c"], frozenTests: [{ path: "a.test.ts", sha256: "x" }] }),
      feature({ id: "guide", title: "Setup guide", status: "done", acceptance: ["a", "b", "c"], mode: "review", checked: checked(["pass", "pass", "pass"]) }),
      feature({ id: "landing", title: "Landing page", status: "done", acceptance: ["a", "b", "c"], mode: "owner", checked: checked(["pass", "pass", "pass"]) }),
    ];
    m.checkpointLog = [log("feature:landing", "approve")];
    return m;
  }

  it("adds a Checked line under the title, after the Plan line, counting the finished features by how each was checked", () => {
    const report = render(mixed(), { prose: null });
    expect(report).toContain(
      "Checked: 1 feature by tests; 1 feature by a second AI against your list; 1 feature by a second AI against your list and approved by you.\n",
    );
    const lines = report.split("\n");
    const at = lines.findIndex((l) => l.startsWith("Checked:"));
    expect(lines[at - 2]).toMatch(/^\*\*Done\*\* · 3 of 3 features done/);
    expect(at).toBeLessThan(10);
    // with a plan from the leader, the Checked line follows the Plan line
    const withPlan = render({ ...mixed(), plan: { spec: mixed().spec as never, sha256: `a4adaca5${"0".repeat(56)}`, at: "2026-10-12T09:00:00.000Z" } }, { prose: null }).split("\n");
    const planAt = withPlan.findIndex((l) => l.startsWith("Plan: written by the leader"));
    expect(withPlan[planAt + 2]).toMatch(/^Checked: /);
  });

  it("adds no line, and changes no word, when no finished feature has a mode", () => {
    const m = realisticMission();
    expect(render(m)).not.toContain("Checked:");
    const stuck = mixed();
    stuck.features[1] = feature({ id: "guide", title: "Setup guide", status: "blocked", mode: "review", blockedReason: "x" });
    stuck.features.splice(2, 1);
    expect(render(stuck, { prose: null })).not.toContain("Checked:");
    expect(render(stuck, { prose: null })).toContain("| ✅ | Add a habit | Built and checked |");
  });

  it("says in the Features table how each finished feature was checked, for each row of the table", () => {
    const m = mixed();
    const rows: [Partial<Feature>, string][] = [
      [{ mode: undefined, frozenTests: [] }, "Built; checked by the project's own checks only, because no tests were written for it"],
      [{ mode: "review", checked: undefined }, "Built; the second AI's check did not finish, so only Mission Control's own checks ran"],
      [{ mode: "review", checked: checked(["pass", "fail", "fail"]) }, "Built, but 2 of 3 checks were not met (see the review notes)"],
      [{ mode: "review", checked: checked(["pass", "cannot_judge", "pass"]) }, "Built; 1 check was not judged by anyone"],
      [{ mode: "review", checked: checked(["pass", "pass", "pass"]) }, "Built; a second AI checked it against your list (3 of 3 passed)"],
    ];
    for (const [fields, words] of rows) {
      m.features[1] = { ...m.features[1]!, ...fields };
      expect(render(m, { prose: null })).toContain(`| ✅ | Setup guide | ${words} |`);
    }
    expect(render(m, { prose: null })).toContain("| ✅ | Add a habit | Built and checked |");
    expect(render(m, { prose: null })).toContain("| ✅ | Landing page | Built; a second AI checked it against your list (3 of 3 passed); approved by you |");
  });

  it("adds the ending for a feature queued without a stop for the owner's look, and the one for an approval", () => {
    const m = mixed();
    m.ownerStops = false;
    m.checkpointLog = [];
    m.features[1] = { ...m.features[1]!, checked: checked(["pass", "cannot_judge", "pass"]) };
    const report = render(m, { prose: null });
    expect(report).toContain("| ✅ | Landing page | Built; a second AI checked it against your list (3 of 3 passed); it was queued without a stop for your look |");
    expect(report).toContain("| ✅ | Setup guide | Built; 1 check was not judged by anyone; it was queued without a stop for your look |");
    expect(report).toContain(
      "Checked: 1 feature by tests; 1 feature by a second AI against your list; 1 check could not be judged; it was queued without a stop for your look; 1 feature by a second AI against your list (it was queued without a stop for your look).",
    );
  });

  // R2-3 and R3-6 of the real runs: a guide or a page is read by opening its file; `npm test` checks nothing of it.
  describe("a document or a page is opened, not run", () => {
    const WINDOWS = "\\\\wsl.localhost\\Ubuntu\\home\\<your Ubuntu name>\\mc-apps\\word-tools";

    beforeEach(() => {
      vi.stubEnv("HOME", "/home/pwuser");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /** A change to an existing app (word-tools), finished: one feature checked by reading, whose changed files are `files`. */
    function guideMission(files: string[] | undefined, over: Partial<Mission> = {}): Mission {
      const m = realisticMission();
      return {
        ...m,
        kind: "feature",
        status: "done",
        stage: "complete",
        decisionsNeeded: [],
        repoPath: "/home/pwuser/mc-apps/word-tools",
        features: [
          feature({
            id: "guide",
            title: "Usage guide",
            status: "done",
            acceptance: ["a", "b"],
            mode: "owner",
            checked: checked(["pass", "pass"], files === undefined ? {} : { files }),
          }),
        ],
        checkpointLog: [log("feature:guide", "approve")],
        ...over,
      };
    }

    const tryIt = (m: Mission): string => sectionText(render(m, { inContainer: true }), "How to try it");

    it("names the file of a guide, with the Windows path of the app's folder, and runs nothing", () => {
      const text = tryIt(guideMission(["docs/USAGE.md"]));
      expect(text).toContain("1. `cd ~/mc-apps/word-tools`: go to the app's folder");
      expect(text).toMatch(/\n2\. `git checkout mc\/[^`]+`: switch to the version with the new work\n/);
      expect(text).not.toMatch(/\n3\./);
      expect(text).toContain(`Then open \`docs/USAGE.md\` in your app folder (in Windows File Explorer: \`${WINDOWS}\\docs\\USAGE.md\`).`);
      expect(text).not.toMatch(/npm|install|start your app|project's own checks/);
      expect(text).toContain("When you're done, put the folder back on your own version with `git checkout main` and type `exit`.");
      expect(howToRun(guideMission(["docs/USAGE.md"]), { inContainer: true })).toEqual(["cd ~/mc-apps/word-tools", expect.stringMatching(/^git checkout mc\//)]);
    });

    it("sends the owner to a browser for a page, and to the app's folder for several files", () => {
      expect(tryIt(guideMission(["site/index.html"]))).toContain(`Then open \`site/index.html\` in your browser (in Windows File Explorer: \`${WINDOWS}\\site\\index.html\`).`);
      // The Windows path of the app's folder is in the first sentence of "How to try it", and is not written a second time (real run R3b).
      const several = tryIt(guideMission(["site/index.html", "site/about.htm"]));
      expect(several).toContain("Then open `site/index.html` and `site/about.htm` in your browser.");
      expect(several.split("wsl.localhost")).toHaveLength(2);
      expect(tryIt(guideMission(["docs/USAGE.md", "site/index.html"]))).toContain("Then open `docs/USAGE.md` and `site/index.html` in your app folder.");
      expect(tryIt(guideMission(["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md"]))).toContain("Then open `a.md`, `b.md`, `c.md`, `d.md`, `e.md` and 2 more in your app folder.");
      // a file that is listed twice, in two features, once
      const two = guideMission(["docs/USAGE.md"]);
      two.features.push(feature({ id: "again", title: "Again", status: "done", acceptance: ["a"], mode: "review", checked: checked(["pass"], { files: ["docs/USAGE.md"] }) }));
      expect(tryIt(two)).toContain("Then open `docs/USAGE.md` in your app folder (in Windows File Explorer: ");
    });

    it("R3b-3: says that the page is opened in a browser when a page is changed with another file, and writes the Windows path of the folder once", () => {
      const text = tryIt(guideMission(["README.md", "site/index.html"]));
      expect(text).toContain("Then open `README.md` and `site/index.html` in your app folder. Open `site/index.html` in your browser.");
      expect(text.split("wsl.localhost")).toHaveLength(2);
      // several pages and a guide: every page is named
      expect(tryIt(guideMission(["docs/USAGE.md", "site/a.html", "site/b.htm"]))).toContain("in your app folder. Open `site/a.html` and `site/b.htm` in your browser.");
      // a guide and nothing else, or pages and nothing else, keep their sentences
      expect(tryIt(guideMission(["docs/USAGE.md", "docs/FAQ.md"]))).toMatch(/Then open `docs\/USAGE.md` and `docs\/FAQ.md` in your app folder\.\n/);
      expect(tryIt(guideMission(["docs/USAGE.md", "docs/FAQ.md"]))).not.toContain("in your browser");
      // the fact sheet says the same
      expect(buildReportFacts(guideMission(["README.md", "site/index.html"]), [])).toContain("Then open README.md, site/index.html in your app folder. Open site/index.html in your browser. Nothing needs to be run.");
    });

    it("R4-5: names a data file to open, as it names a guide, and runs nothing", () => {
      const text = tryIt(guideMission(["data/columns.csv"]));
      expect(text).toContain(`Then open \`data/columns.csv\` in your app folder (in Windows File Explorer: \`${WINDOWS}\\data\\columns.csv\`).`);
      expect(text).not.toMatch(/npm|install|start your app|project's own checks/);
      expect(howToRun(guideMission(["data/columns.csv"]), { inContainer: true })).toEqual(["cd ~/mc-apps/word-tools", expect.stringMatching(/^git checkout mc\//)]);
      // a table and a guide together; a picture and a PDF are opened as they are too
      expect(tryIt(guideMission(["docs/USAGE.md", "data/columns.csv", "images/logo.png", "docs/guide.pdf"]))).toContain("Then open `docs/USAGE.md`, `data/columns.csv`, `images/logo.png` and `docs/guide.pdf` in your app folder");
      // a file of code is still not something to open
      const code = tryIt(guideMission(["data/columns.csv", "scripts/make.js"]));
      expect(code).not.toContain("Then open");
    });

    it("outside the container there is no Windows path", () => {
      const text = sectionText(render(guideMission(["docs/USAGE.md"]), { inContainer: false }), "How to try it");
      expect(text).toContain("Then open `docs/USAGE.md` in your app folder.");
      expect(text).not.toContain("wsl.localhost");
      expect(text).not.toMatch(/npm|start your app/);
    });

    it("says the same to the AI that writes the summary", () => {
      const facts = buildReportFacts(guideMission(["docs/USAGE.md"]), []);
      expect(facts).toContain("Then open docs/USAGE.md in your app folder. Nothing needs to be run.");
      expect(facts.slice(facts.indexOf("How to try it:"))).not.toMatch(/npm/);
    });

    it("keeps the old steps where something is not a document or a page, or not known, or checked by tests", () => {
      // code next to a guide: the app is started the way it was, but the project's own checks are not offered as a way to try it
      const code = tryIt(guideMission(["docs/USAGE.md", "src/index.js"]));
      expect(code).toContain("3. `npm install`: download what the app needs (slow the first time)");
      expect(code).toContain("Then start your app the way you usually do.");
      expect(code).not.toContain("npm run verify");
      expect(code).not.toContain("Then open");
      // a mission file from before the files were recorded
      const old = tryIt(guideMission(undefined));
      expect(old).toContain("Then start your app the way you usually do.");
      expect(old).not.toContain("npm run verify");
      // a long list may have been cut, so it is not known to be all documents
      const many = tryIt(guideMission(Array.from({ length: 10 }, (_, i) => `docs/part${i}.md`)));
      expect(many).not.toContain("Then open");
      // a feature checked by tests in the same mission: the project's own checks are a way to try it, as before
      const mixedTests = guideMission(["docs/USAGE.md"]);
      mixedTests.features.push(feature({ id: "code", title: "Code", status: "done", acceptance: ["a"], frozenTests: [{ path: "a.test.ts", sha256: "x" }] }));
      const withTests = tryIt(mixedTests);
      expect(withTests).toContain("`npm run verify`: run the project's own checks");
      expect(withTests).not.toContain("Then open");
      // a feature that was blocked does not count either way
      const blocked = guideMission(["docs/USAGE.md"]);
      blocked.features.push(feature({ id: "stuck", title: "Stuck", status: "blocked", blockedReason: "x" }));
      expect(tryIt(blocked)).toContain("Then open `docs/USAGE.md`");
    });

    it("leaves a mission with no mode feature exactly as it was", () => {
      const m = realisticMission();
      expect(sectionText(render(m, { inContainer: true }), "How to try it")).toContain("3. `npm run dev`: start the app (leave this window open while you try it)");
      expect(sectionText(render(m, { inContainer: true }), "How to try it")).not.toContain("Then open");
      // a change to an app with no start script, checked by tests: the project's own checks are the last step, as before
      const change: Mission = { ...m, kind: "feature", repoPath: "/home/pwuser/mc-apps/no-start" };
      expect(howToRun(change, { inContainer: true })).toEqual(["cd ~/mc-apps/no-start", expect.stringMatching(/^git checkout /), "npm install", "npm run verify"]);
    });

    describe("at the owner's look", () => {
      const lookOf = (files: string[], over: Partial<Mission> = {}): Mission => {
        const base = guideMission(["docs/USAGE.md"]);
        const f = { ...(base.features[0] as Feature), status: "reviewing" as const };
        return {
          ...base,
          status: "stopped",
          stage: "features",
          features: [f],
          checkpointLog: [],
          checkpoint: {
            id: "feature:guide#1",
            scope: "feature:guide",
            kind: "feature",
            featureId: "guide",
            round: 1,
            state: "pending",
            parkedAt: "2026-10-10T04:00:00.000Z",
            look: { headline: "Check “Usage guide” before it is added", lines: ["It is built."], branch: "mc/2026-10-10-word-tools--guide", files },
          },
          ...over,
        };
      };
      const lookText = (m: Mission): string => {
        const report = render(m, { inContainer: true });
        return report.slice(report.indexOf("To look at it yourself:"), report.indexOf("## ", report.indexOf("To look at it yourself:")));
      };

      it("names the file to open and runs no project check", () => {
        const text = lookText(lookOf(["docs/USAGE.md"]));
        expect(text).toContain("1. `cd ~/mc-apps/word-tools`: go to the app's folder");
        expect(text).toContain("2. `git checkout --detach mc/2026-10-10-word-tools--guide`: switch to the version with the new work");
        expect(text).not.toMatch(/\n3\./);
        expect(text).toContain(`Then open \`docs/USAGE.md\` in your app folder (in Windows File Explorer: \`${WINDOWS}\\docs\\USAGE.md\`).`);
        expect(text).not.toMatch(/npm|start your app|project's own checks/);
        expect(text.indexOf("Then open")).toBeLessThan(text.indexOf("When you're done"));
      });

      it("opens a page in a browser", () => {
        expect(lookText(lookOf(["site/index.html"]))).toContain("Then open `site/index.html` in your browser (in Windows File Explorer: ");
      });

      it("R4-5: names the data file to open and offers no project check, as for a guide", () => {
        const text = lookText(lookOf(["data/columns.csv"]));
        expect(text).toContain(`Then open \`data/columns.csv\` in your app folder (in Windows File Explorer: \`${WINDOWS}\\data\\columns.csv\`).`);
        expect(text).not.toMatch(/npm|start your app|project's own checks/);
      });

      it("R3b-3: says the page is opened in a browser when it comes with another file", () => {
        expect(lookText(lookOf(["README.md", "site/index.html"]))).toContain("Then open `README.md` and `site/index.html` in your app folder (in Windows File Explorer, the app's folder is ");
        expect(lookText(lookOf(["README.md", "site/index.html"]))).toContain(". Open `site/index.html` in your browser.");
      });

      it("R4-5: with a feature checked by tests in the same mission, keeps the project's own checks and names the file after them, in other words", () => {
        const withTests = lookOf(["data/columns.csv"]);
        withTests.features.push(feature({ id: "code", title: "Code", status: "pending", acceptance: ["a"] }));
        const text = lookText(withTests);
        expect(text).toContain("4. `npm run verify`: run the project's own checks");
        expect(text).toContain("The project's own checks do not cover this feature. To look at it, open `data/columns.csv` in your app folder (in Windows File Explorer: ");
        expect(text).not.toContain("Then open");
        expect(text.indexOf("npm run verify")).toBeLessThan(text.indexOf("To look at it, open"));
        // a feature that tests check, looked at in the same mission, gets no such sentence
        const tested = lookOf(["src/index.js"]);
        tested.features[0] = { ...tested.features[0]!, mode: undefined, frozenTests: [{ path: "a.test.ts", sha256: "x" }] };
        expect(lookText(tested)).not.toContain("To look at it, open");
      });

      it("R4-1: lists the files that were already there apart from the new ones, and keeps one sentence when all are new", () => {
        const withLook = (look: Record<string, unknown>): Mission => {
          const m = lookOf(["docs/USAGE.md"]);
          m.checkpoint = { ...m.checkpoint!, look: { ...m.checkpoint!.look, ...look } } as Mission["checkpoint"];
          return m;
        };
        const report = (m: Mission): string => render(m, { inContainer: true });
        const both = report(withLook({ files: ["data/columns.csv", "docs/USAGE.md", "scripts/a.js"], existingFiles: ["data/columns.csv"] }));
        expect(both).toContain("New in this feature: `docs/USAGE.md` and `scripts/a.js`.");
        expect(both).toContain("Changed, but already there before this feature: `data/columns.csv`.");
        expect(both).not.toContain("Files that changed:");
        const onlyOld = report(withLook({ files: ["data/columns.csv"], existingFiles: ["data/columns.csv"] }));
        expect(onlyOld).toContain("Changed, but already there before this feature: `data/columns.csv`.");
        expect(onlyOld).not.toContain("New in this feature");
        // all new, or the field is missing (an older mission file): the one sentence it always had
        expect(report(withLook({ files: ["a.md", "b.md"] }))).toContain("Files that changed: `a.md` and `b.md`.");
        expect(report(withLook({ files: ["a.md", "b.md"], existingFiles: [] }))).toContain("Files that changed: `a.md` and `b.md`.");
        // a name that is not among the files, or a damaged field, changes nothing
        expect(report(withLook({ files: ["a.md"], existingFiles: ["zzz.md"] }))).toContain("Files that changed: `a.md`.");
        expect(report(withLook({ files: ["a.md"], existingFiles: "no" }))).toContain("Files that changed: `a.md`.");
      });

      it("keeps the project's own checks away from a mission that no test checks, but not from one a test checks", () => {
        const code = lookText(lookOf(["docs/USAGE.md", "src/index.js"]));
        expect(code).toContain("3. `npm install`: download what the app needs (slow the first time)");
        expect(code).not.toMatch(/npm run verify|Then open/);
        const mixedTests = lookOf(["docs/USAGE.md"]);
        mixedTests.features.push(feature({ id: "code", title: "Code", status: "pending", acceptance: ["a"] }));
        const text = lookText(mixedTests);
        expect(text).toContain("3. `npm install`");
        expect(text).toContain("4. `npm run verify`: run the project's own checks");
        expect(text).not.toContain("Then open");
        // ten files listed: the list may have been cut
        expect(lookText(lookOf(Array.from({ length: 10 }, (_, i) => `docs/part${i}.md`)))).not.toContain("Then open");
      });
    });
  });

  // R2-5 and R3-7 of the real runs: a taste check ends "(the CEO decides)", and the second AI always says it cannot judge it.
  it("says a taste check is left for you, and keeps that clause apart from the approval (real runs R2 and R3)", () => {
    const m = mixed();
    m.features = [
      feature({
        id: "guide",
        title: "Usage guide",
        status: "done",
        acceptance: ["It has an Install part.", "It has a Use part.", "The guide reads as friendly (the CEO decides)."],
        mode: "owner",
        checked: checked(["pass", "pass", "cannot_judge"]),
      }),
    ];
    m.checkpointLog = [log("feature:guide", "approve")];
    const report = render(m, { prose: null });
    expect(report).toContain("Checked: 1 feature by a second AI against your list; 1 check left for you; approved by you.\n");
    expect(report).toContain("| ✅ | Usage guide | Built; 1 check left for you; approved by you |");
    expect(report).not.toMatch(/except|not judged by anyone|could not judge/);
    // the fact sheet the AI writes the summary from says the same
    expect(buildReportFacts(m, [])).toContain("Checked by: a second AI against your list; 1 check left for you; approved by you. No tests were written for it.");
    // queued without a stop: nobody is asked, so it was not judged by anyone
    const queued = { ...m, ownerStops: false as const, checkpointLog: [] };
    expect(render(queued, { prose: null })).toContain("Checked: 1 feature by a second AI against your list; 1 check could not be judged; it was queued without a stop for your look.\n");
    expect(render(queued, { prose: null })).toContain("| ✅ | Usage guide | Built; 1 check was not judged by anyone; it was queued without a stop for your look |");
  });

  it("counts the review notes only where the words do not already point to them", () => {
    const m = mixed();
    const note = { severity: "major" as const, file: null, description: "Check 2 is not met.", suggestedTest: null };
    m.features[1] = { ...m.features[1]!, checked: checked(["pass", "fail", "pass"]), openFindings: [note] };
    m.features[2] = { ...m.features[2]!, openFindings: [note] };
    const report = render(m, { prose: null });
    expect(report).toContain("| ✅ | Setup guide | Built, but 1 of 3 checks was not met (see the review notes) |");
    expect(report).toContain("| ✅ | Landing page | Built; a second AI checked it against your list (3 of 3 passed); approved by you (1 review note below) |");
  });

  it("R3b-4: joins the count of review notes into the bracket the words already end with, never two brackets in a row", () => {
    const m = mixed();
    const note = { severity: "minor" as const, file: null, description: "A small thing to tidy.", suggestedTest: null };
    // the real row of run R3b: a feature checked by a second AI, all six checks passed, one review note
    m.features = [{ ...m.features[1]!, id: "landing-page", title: "One-page landing page", acceptance: ["a", "b", "c", "d", "e", "f"], mode: "review", checked: checked(["pass", "pass", "pass", "pass", "pass", "pass"]), openFindings: [note] }];
    m.checkpointLog = [];
    const report = render(m, { prose: null });
    expect(report).toContain("| ✅ | One-page landing page | Built; a second AI checked it against your list (6 of 6 passed, 1 review note below) |");
    expect(report).not.toMatch(/\)\s*\(/);
    // two notes, and a bracket that is not the last thing of the words (the approval comes after it)
    m.features[0] = { ...m.features[0]!, openFindings: [note, note] };
    expect(render(m, { prose: null })).toContain("(6 of 6 passed, 2 review notes below) |");
    const approved = mixed();
    approved.features[2] = { ...approved.features[2]!, openFindings: [note] };
    expect(render(approved, { prose: null })).toContain("Built; a second AI checked it against your list (3 of 3 passed); approved by you (1 review note below) |");
  });

  it("does not say built and checked in the plain narrative, and sends the reader to the Checked line and the table", () => {
    const m = mixed();
    const report = render(m, { prose: null });
    expect(report).toContain("All 3 features are built. The “Checked” line and the Features table say how each was checked. The final checks of the whole app passed.");
    expect(report).not.toContain("built and checked.");
    expect(report).not.toContain("Everything passed the final checks.");
    // one feature, and a partly done mission
    const one = mixed();
    one.features = [one.features[1]!];
    expect(render(one, { prose: null })).toContain("The feature is built. The Features table says how it was checked. The final checks of the whole app passed.");
    const part = mixed();
    part.status = "partial";
    part.features[2] = feature({ id: "landing", title: "Landing page", status: "blocked", mode: "owner", blockedReason: "x" });
    expect(render(part, { prose: null })).toContain("2 of the 3 features are built.");
    expect(render(part, { prose: null })).not.toContain("are built and checked.");
  });

  it("puts how a finished feature was checked in the facts for the summary writer, only for a feature that has a mode", () => {
    const facts = buildReportFacts(mixed(), []);
    expect(facts).toContain('- add-habit "Add a habit" [done]: You can add a habit.\n');
    expect(facts).toContain('- guide "Setup guide" [done]: You can setup guide. Checked by: a second AI against your list. No tests were written for it.\n');
    expect(facts).toContain('- landing "Landing page" [done]: You can landing page. Checked by: a second AI against your list and approved by you. No tests were written for it.\n');
    expect(buildReportFacts(realisticMission(), [])).not.toContain("Checked by:");
  });

  it("R3b-2: tells the summary writer that pictures of the page were taken and the second AI looked at them, only for a feature that has them", () => {
    const m = mixed();
    const withPictures = (pictures: { taken: number; why?: "reviewer" | "no_tool" }): Mission => {
      const copy = mixed();
      copy.features[1] = { ...copy.features[1]!, checked: { ...checked(["pass", "pass", "pass"])!, pictures } };
      return copy;
    };
    const line = "Pictures of the page were taken at phone width and desktop width, and the second AI looked at them.";
    const facts = buildReportFacts(withPictures({ taken: 2 }), []);
    expect(facts).toContain(`- guide "Setup guide" [done]: You can setup guide. Checked by: a second AI against your list. No tests were written for it. ${line}\n`);
    // the other two features have none, and say nothing about pictures
    expect(facts.split("Pictures of the page")).toHaveLength(2);
    // none taken, or none for a reason: no sentence at all
    for (const none of [{ taken: 0 }, { taken: 0, why: "no_tool" as const }]) expect(buildReportFacts(withPictures(none), [])).not.toContain("Pictures of the page");
    // the second AI could not open them (it runs on another tool): said as it is
    expect(buildReportFacts(withPictures({ taken: 2, why: "reviewer" }), [])).toContain("Pictures of the page were taken at phone width and desktop width, but the second AI could not look at them.");
    // a mission with no mode feature has no such line
    expect(buildReportFacts(realisticMission(), [])).not.toContain("Pictures of the page");
    expect(buildReportFacts(m, [])).not.toContain("Pictures of the page");
  });

  it("R3b-2: keeps a summary that says the second AI did not use tests but judged by reading, even if it adds that it was not a browser test", () => {
    const prose: ReportProseOutput = {
      narrative: "The page is built. A second AI reviewed it against your list.",
      whatYouCanDo: ["Check the columns on a phone (checked by a second AI review, not by a browser test)."],
    };
    expect(holdsNeverSay(prose.whatYouCanDo[0]!)).toBe(false);
    expect(holdsNeverSay("It was checked by a second AI, not by an automated test.")).toBe(false);
    expect(render(mixed(), { prose })).toContain("Check the columns on a phone (checked by a second AI review, not by a browser test).");
    // a claim of a test next to such a denial still counts
    expect(holdsNeverSay("Checked by a second AI, not by a browser test, but it was tested twice.")).toBe(true);
  });

  it("leaves out the AI-written summary and list when they talk about tests, and says so in the technical details", () => {
    const talks: ReportProseOutput[] = [
      { narrative: "All the features were tested and pass.", whatYouCanDo: ["Read the guide"] },
      { narrative: "The guide and the page are ready.", whatYouCanDo: ["Read the guide", "Everything is tested"] },
      { narrative: "It passed its tests.", whatYouCanDo: [] },
      { narrative: "We are testing it.", whatYouCanDo: [] },
      { narrative: "TEST results are in.", whatYouCanDo: [] },
    ];
    for (const prose of talks) {
      const report = render(mixed(), { prose });
      expect(report).not.toContain(prose.narrative);
      expect(report).toContain("All 3 features are built. The “Checked” line");
      expect(sectionText(report, "What you can do now")).toContain("**Setup guide**: You can setup guide.");
      expect(sectionText(report, "Technical details")).toContain("The AI-written summary was left out, because it described how the work was checked in words that Mission Control could not confirm from its own records.");
      expect(sectionText(report, "What you can do now")).not.toContain("Everything is tested");
    }
    // a summary that says nothing about tests is kept
    const clean: ReportProseOutput = { narrative: "The guide and the page are ready.", whatYouCanDo: ["Read the guide"] };
    const report = render(mixed(), { prose: clean });
    expect(report).toContain("The guide and the page are ready.");
    expect(sectionText(report, "What you can do now")).toBe("- Read the guide");
    expect(sectionText(report, "Technical details")).not.toContain("left out");
    // words that only contain test, like "latest" and "contest", are not the word
    expect(render(mixed(), { prose: { narrative: "The latest guide won the contest.", whatYouCanDo: [] } })).toContain("The latest guide won the contest.");
  });

  // V2-06: the other words of the "Never say" column of docs/modes-spec.md 10.3 are caught as well.
  const NEVER_SAY_TEXTS: [string, string][] = [
    ["verified", "I built the guide, and it was verified and double checked by a person."],
    ["verified, in a list line", "Everything is Verified."],
    ["approved by AI", "The page was approved by AI before it was added."],
    ["approved by a second AI", "The guide was approved by a second AI."],
    ["approved by the AI", "Approved by the AI."],
    ["guaranteed", "The steps are guaranteed to work."],
    ["correct", "The steps are correct."],
    ["you looked at it", "You looked at it and it was fine."],
    ["reviewed by you", "The page was reviewed by you."],
    ["signed off", "The guide is signed off."],
    ["signed  off over two lines", "The guide was signed\noff."],
    ["you chose not to look at it", "You chose not to look at it."],
    ["passed with a warning", "It passed with a warning."],
    ["probably fine", "It is probably fine."],
    ["the engine", "The engine wrote the guide."],
  ];

  it.each(NEVER_SAY_TEXTS)("leaves out an AI-written summary that says %s, and says so in the technical details", (_label, text) => {
    for (const prose of [{ narrative: text, whatYouCanDo: ["Read the guide"] }, { narrative: "The guide and the page are ready.", whatYouCanDo: ["Read the guide", text] }]) {
      const report = render(mixed(), { prose });
      expect(report).not.toContain(text);
      expect(report).toContain("All 3 features are built. The “Checked” line");
      expect(sectionText(report, "Technical details")).toContain("The AI-written summary was left out, because it described how the work was checked in words that Mission Control could not confirm from its own records.");
    }
  });

  it("does not leave out a summary that only holds words which look like those of the list", () => {
    for (const text of [
      "The guide works correctly and was corrected twice.",
      "The page was approved by you.",
      "Read the guide, then verify the steps yourself.",
      "The incorrect step was removed, and the page was approved by a person.",
      "The latest guide won the contest.",
      "The engines of the car are not part of this.",
      "It passed without a warning sign.",
    ]) {
      const report = render(mixed(), { prose: { narrative: text, whatYouCanDo: ["Read the guide"] } });
      expect(report, text).toContain(text);
      expect(sectionText(report, "Technical details"), text).not.toContain("left out");
    }
  });

  it("holdsNeverSay answers the same for every case of the list", () => {
    for (const [label, text] of NEVER_SAY_TEXTS) expect(holdsNeverSay(text), label).toBe(true);
    expect(holdsNeverSay("The guide and the page are ready.")).toBe(false);
    expect(holdsNeverSay("")).toBe(false);
  });

  // R2-1 of the real runs: an honest summary that says no test was written was thrown away, and the footnote blamed Mission Control's records.
  const REAL_R2_SUMMARY: ReportProseOutput = {
    narrative:
      "The word-tools project now has a short usage guide with two parts: how to install it, and how to use its capitalize feature. A second AI reviewer checked the guide against your request, and it approved everything except one point it could not judge, which you approved yourself. No automated tests were written for the guide, so its correctness rests on that review and your approval rather than on test results. Nothing from the request was skipped or left unfinished, and no decisions are needed from you.",
    whatYouCanDo: ["Read a short guide that explains how to install word-tools", "Read a guide that shows how to use capitalize, with an example of its output"],
  };

  it("keeps the real honest summary of run R2, which says that no test was written", () => {
    const report = render(mixed(), { prose: REAL_R2_SUMMARY });
    expect(report).toContain("No automated tests were written for the guide, so its correctness rests on that review and your approval rather than on test results.");
    expect(sectionText(report, "What you can do now")).toBe("- Read a short guide that explains how to install word-tools\n- Read a guide that shows how to use capitalize, with an example of its output");
    expect(sectionText(report, "Technical details")).not.toContain("left out");
    expect(report).not.toContain("do not match Mission Control's records");
  });

  // Denials: the AI says that nothing was tested. These have the word and mean the opposite of a claim.
  const DENIALS_LET_THROUGH: string[] = [
    "No tests were written for the guide.",
    "No automated tests were written for the guide, so it rests on the review rather than on test results.",
    "No new unit tests were added, and none were run.",
    "No test was written for this page.",
    "No tests were run.",
    "No tests are claimed for it.",
    "No test is claimed.",
    "There are no tests for the guide.",
    "The guide has no tests.",
    "It has no automated tests at all.",
    "The guide was not tested, and nobody says it was.",
    "Nothing here has been tested.",
    "None of it was tested.",
    "It was never tested.",
    "It was checked by a second AI, not by tests.",
    "It was checked without tests.",
    "It was checked without any automated tests.",
    "It is not checked by tests.",
    "It rests on the review instead of tests.",
    "The tests were not written, because this is a guide.",
    "There are no test results to show.",
    "NO TESTS WERE WRITTEN FOR IT.",
    "No\ntests\nwere written.",
  ];

  it.each(DENIALS_LET_THROUGH)("lets a denial through: %s", (text) => {
    expect(holdsNeverSay(text)).toBe(false);
    for (const prose of [{ narrative: text, whatYouCanDo: ["Read the guide"] }, { narrative: "The guide is ready.", whatYouCanDo: [text] }]) {
      const report = render(mixed(), { prose });
      expect(sectionText(report, "Technical details")).not.toContain("left out");
      expect(report.replace(/\s+/g, " ")).toContain(text.replace(/\s+/g, " "));
    }
  });

  // Claims, also next to a denial, still leave the summary out.
  const CLAIMS_STILL_CAUGHT: string[] = [
    "All the tests passed.",
    "No tests failed.",
    "No tests were written first, but the guide was tested twice.",
    "No tests were written for the page, and the tests passed for the guide.",
    "It was tested and it works. No tests were written for the other page.",
    "Nobody wrote tests, but they all pass.",
    "The tests were written and run, and none were left out.",
    "Without any problems, the tests passed.",
    "It was checked by tests.",
    "It was checked by a second AI and by tests.",
    "We ran the tests rather than reading it.",
    "No tests were written. The page was verified and it is correct.",
    "No tests were written, and the steps are guaranteed to work.",
    "Testing showed no problems.",
    "It was tested without any trouble.",
  ];

  it.each(CLAIMS_STILL_CAUGHT)("still leaves out a claim: %s", (text) => {
    expect(holdsNeverSay(text)).toBe(true);
    const report = render(mixed(), { prose: { narrative: text, whatYouCanDo: ["Read the guide"] } });
    expect(report).not.toContain(text);
    expect(sectionText(report, "Technical details")).toContain("The AI-written summary was left out");
  });

  it("the footnote for a summary that was left out never says that its words do not match the records", () => {
    for (const text of CLAIMS_STILL_CAUGHT) {
      const tech = sectionText(render(mixed(), { prose: { narrative: text, whatYouCanDo: [] } }), "Technical details");
      expect(tech).toContain("The AI-written summary was left out, because it described how the work was checked in words that Mission Control could not confirm from its own records. The summary at the top was written by Mission Control.");
      expect(tech).not.toContain("do not match");
    }
  });

  it("the plain narrative that stands in for it holds none of these words", () => {
    const left = render(mixed(), { prose: { narrative: "It was verified and is correct.", whatYouCanDo: [] } });
    const narrative = left.slice(left.indexOf("\n\n", left.indexOf("Checked:")), left.indexOf("## What you can do now"));
    expect(holdsNeverSay(narrative.replace(/No tests were written for it\./g, "").replace(/\bby tests\b/g, "")), narrative).toBe(false);
  });

  it("keeps a summary with those words in a mission with no mode feature, as before", () => {
    const m = realisticMission();
    const prose: ReportProseOutput = { narrative: "Everything was verified and is correct, and it is guaranteed.", whatYouCanDo: ["You looked at it"] };
    const report = render(m, { prose });
    expect(report).toContain("Everything was verified and is correct, and it is guaranteed.");
    expect(sectionText(report, "Technical details")).not.toContain("left out");
  });

  it("keeps the AI-written summary of a mission with no mode feature, whatever it says about tests", () => {
    const m = realisticMission();
    const prose: ReportProseOutput = { narrative: "Every feature was tested.", whatYouCanDo: ["Run the tests"] };
    const report = render(m, { prose });
    expect(report).toContain("Every feature was tested.");
    expect(sectionText(report, "Technical details")).not.toContain("left out");
  });

  it("says nothing of tests about a feature that no test checked, anywhere in a report of only such features", () => {
    const m = mixed();
    m.features = m.features.slice(1);
    const report = render(m, { prose: null });
    const allowed = /No tests were written for it|by tests/g;
    const text = report.slice(0, report.indexOf("## Usage"));
    expect(text.replace(allowed, "")).not.toMatch(/\btest(s|ed|ing)?\b/i);
  });
});

// ───────────────────────────── The file a review note names (finding W2d-R2) ─────────────────────────────

describe("the file a review note names", () => {
  const checkedAll: Feature["checked"] = {
    round: 1,
    reviewer: "claude",
    results: [{ n: 1, result: "pass", evidence: "e", basis: "text" }],
    unjudged: 0,
    scripted: { problems: [], facts: [] },
    pictures: { taken: 0 },
  };
  /** What a markdown reader still treats as markup once the code spans are taken out (a backtick string closes only at a backtick string of the same length). */
  function outsideCodeSpans(line: string): string {
    let out = "";
    let i = 0;
    while (i < line.length) {
      if (line[i] !== "`") {
        out += line[i++];
        continue;
      }
      let j = i;
      while (line[j] === "`") j++;
      const run = j - i;
      let k = j;
      let close = -1;
      while (k < line.length) {
        if (line[k] !== "`") {
          k++;
          continue;
        }
        let end = k;
        while (line[end] === "`") end++;
        if (end - k === run) {
          close = k;
          break;
        }
        k = end;
      }
      if (close < 0) {
        out += line.slice(i, j);
        i = j;
      } else {
        out += " ";
        i = close + run;
      }
    }
    return out;
  }
  const MARKUP = /!\[|\]\(|https?:\/\/|evil\.example/u;
  const note = (file: string, description = "A small thing to tidy."): Feature["openFindings"][number] => ({ severity: "minor", file, description, suggestedTest: null });
  const notesOf = (m: Mission): string[] => sectionText(render(m, { prose: null }), "Review notes").split("\n");
  const withNote = (file: string, mode: boolean): Mission => {
    const m = realisticMission();
    m.status = "done";
    m.decisionsNeeded = [];
    m.features = [mode ? feature({ id: "guide", title: "Setup guide", status: "done", acceptance: ["a"], mode: "review", checked: checkedAll, openFindings: [note(file)] }) : feature({ id: "app", title: "The app", status: "done", openFindings: [note(file)] })];
    return m;
  };

  it("is put in a code span whose fence is longer than any run of backticks in it, so nothing after it is live markdown", () => {
    const cases: [string, string][] = [
      ["src/app/page.tsx", "`src/app/page.tsx`"],
      ["a`b", "`` a`b ``"],
      ["a``b", "``` a``b ```"],
      ["a```b", "```` a```b ````"],
      ["`edge`", "`` `edge` ``"],
    ];
    for (const [file, span] of cases) {
      const line = notesOf(withNote(file, false)).find((l) => l.includes("A small thing"))!;
      expect(line, file).toContain(`(in ${span})`);
    }
    // The picture and the link of the reported text sit inside the span, so they are not markup: the line with the span taken out holds none.
    const hostile = "a`` ![p](https://evil.example/p.png) [c](https://evil.example/c) `` b";
    const line = notesOf(withNote(hostile, false)).find((l) => l.includes("A small thing"))!;
    expect(line).toContain(`(in \`\`\` ${hostile} \`\`\`)`);
    expect(MARKUP.test(outsideCodeSpans(line))).toBe(false);
    // The same text with the old fence (two backticks) is live: the rule above finds it.
    expect(MARKUP.test(outsideCodeSpans(`(in \`\` ${hostile} \`\`)`))).toBe(true);
  });

  it("of a feature checked by a second AI is also made plain: no picture, link or web address, and a hidden character shown as a code point", () => {
    const hostile = "a`` ![p](https://evil.example/p.png) [c](https://evil.example/c) `` b";
    const m = withNote(hostile, true);
    const line = notesOf(m).find((l) => l.includes("A small thing"))!;
    expect(line).toContain("(in ``` a`` p (web address removed) c (web address removed) `` b ```)");
    expect(MARKUP.test(outsideCodeSpans(line))).toBe(false);
    expect(MARKUP.test(line)).toBe(false);
    expect(buildReportFacts(m, [])).toContain("[minor] guide (a`` p (web address removed) c (web address removed) `` b): A small thing to tidy.");
    const named = notesOf(withNote(`docs/setup.md${String.fromCodePoint(0x202e)}`, true)).find((l) => l.includes("A small thing"))!;
    expect(named).toContain("(in `docs/setup.md<U+202E>`)");
    // A feature checked by tests keeps the name it was given: only the span around it is safe.
    expect(buildReportFacts(withNote(hostile, false), [])).toContain(`[minor] app (${hostile}): A small thing to tidy.`);
  });
});

// ───────────────────────────── collectScreenshots ─────────────────────────────

describe("collectScreenshots", () => {
  let root: string;
  let app: string;
  let dest: string;
  let clock: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-report-test-"));
    app = join(root, "app");
    dest = join(root, "mission", "screenshots");
    mkdirSync(app);
    clock = Date.parse("2026-10-10T01:00:00Z") / 1000;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Writes a file under the app dir; each call is one minute newer than the last. */
  function png(rel: string, content = rel): string {
    const path = join(app, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    clock += 60;
    utimesSync(path, clock, clock);
    return path;
  }

  it("copies the PNGs under test-results and playwright-report, newest first, with flattened names", async () => {
    png("test-results/home-renders-chromium/test-finished-1.png");
    png("playwright-report/data/0a1b2c.png");
    png("test-results/add-habit-chromium/test-finished-1.PNG");
    png("test-results/notes.txt");
    png("test-results/trace.jpg");
    png("screenshots-elsewhere/ignored.png");

    const copied = await collectScreenshots(app, dest);

    expect(copied.map((p) => basename(p))).toEqual([
      "add-habit-chromium-test-finished-1.png",
      "data-0a1b2c.png",
      "home-renders-chromium-test-finished-1.png",
    ]);
    for (const p of copied) expect(dirname(p)).toBe(dest);
    expect(readFileSync(copied[0]!, "utf8")).toBe("test-results/add-habit-chromium/test-finished-1.PNG");
  });

  it("skips byte-identical copies, keeping the newest", async () => {
    png("test-results/home-chromium/test-finished-1.png", "same pixels");
    png("playwright-report/data/ffee.png", "same pixels");
    const copied = await collectScreenshots(app, dest);
    expect(copied.map((p) => basename(p))).toEqual(["data-ffee.png"]);
  });

  it("keeps at most 12 by default, or the given max", async () => {
    for (let i = 0; i < 15; i++) png(`test-results/t${String(i).padStart(2, "0")}/shot.png`);
    const all = await collectScreenshots(app, dest);
    expect(all).toHaveLength(12);
    expect(basename(all[0]!)).toBe("t14-shot.png");
    expect(basename(all[11]!)).toBe("t03-shot.png");

    const two = await collectScreenshots(app, join(root, "two"), 2);
    expect(two.map((p) => basename(p))).toEqual(["t14-shot.png", "t13-shot.png"]);
  });

  it("gives clashing flattened names unique suffixes", async () => {
    png("test-results/a-b.png");
    png("test-results/a/b.png");
    png("playwright-report/a/b.png");
    const names = (await collectScreenshots(app, dest)).map((p) => basename(p));
    expect(names).toEqual(["a-b.png", "a-b-2.png", "a-b-3.png"]);
  });

  it("makes odd file names safe", async () => {
    png("test-results/Home page — “dark” (1)/shot #1.png");
    const [copied] = await collectScreenshots(app, dest);
    expect(basename(copied!)).toBe("Home-page-dark-1-shot-1.png");
  });

  it("returns nothing, and creates no folder, when there are no screenshots", async () => {
    expect(await collectScreenshots(app, dest)).toEqual([]);
    expect(await collectScreenshots(join(root, "missing"), dest)).toEqual([]);
    png("test-results/x.png");
    expect(await collectScreenshots(app, dest, 0)).toEqual([]);
    expect(existsSync(dest)).toBe(false);
  });

  it("does not follow symlinked folders", async () => {
    png("test-results/real/shot.png");
    symlinkSync(join(app, "test-results"), join(app, "test-results", "loop"));
    const copied = await collectScreenshots(app, dest);
    expect(copied.map((p) => basename(p))).toEqual(["real-shot.png"]);
  });
});
