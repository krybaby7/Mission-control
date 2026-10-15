// Fixed inputs for the golden prompt texts of docs/modes-spec.md section 15, item 4. A mission with no mode feature must
// get exactly the text of the end of wave 1 from every existing prompt builder. `oldWayPrompts()` renders them all; the
// files in `prompts/` next to this one were made by running it with the code of the end of wave 1.
//
// This file uses only functions that existed at the end of wave 1, so it runs against both trees.
import {
  buildPrompt,
  contextPackPrompt,
  diagnosisPrompt,
  failureDigestPrompt,
  gateAPrompt,
  gateCPrompt,
  initPrompt,
  loadRolePrompt,
  onboardPrompt,
  reportProsePrompt,
  reviewPrompt,
  specPrompt,
  testAuthorPrompt,
} from "../../../src/prompts.js";
import type { Feature, Mission, Role, Spec } from "../../../src/types.js";

export const SPEC: Spec = {
  appName: "Habit Tracker",
  summary: "Track daily habits and streaks.",
  features: [
    {
      id: "track-habit",
      title: "Track a habit",
      story: "As a user I can add a habit and tick it off.",
      acceptance: ["Adding 'Read' shows it in the habit list", "Ticking it shows 'Streak: 1'"],
      kind: "standard",
      deps: [],
    },
    { id: "about-page", title: "About page", story: "As a visitor I can read about the app.", acceptance: ["/about shows 'About'"], kind: "mechanical", deps: ["track-habit"] },
  ],
  assumptions: ["Single user, no login"],
  uiContract: "UI-CONTRACT-MARKER: route `/`, input labelled 'Habit name', button 'Add habit', list data-testid=habit-list",
};

export function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    ...SPEC.features[0]!,
    status: "building",
    rung: 0,
    attempts: [],
    frozenTests: [
      { path: "tests/e2e/track-habit.spec.ts", sha256: "a".repeat(64) },
      { path: "tests/unit/streak.test.ts", sha256: "b".repeat(64) },
    ],
    reviewRounds: 0,
    openFindings: [],
    ...overrides,
  };
}

export function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: "2026-10-09-habit-tracker",
    kind: "greenfield",
    title: "Habit tracker",
    request: "Build me a habit tracker where I can tick off habits every day.",
    repoPath: "/work/habit-tracker",
    baseBranch: "main",
    integrationBranch: "mc/2026-10-09-habit-tracker",
    profile: "default",
    roleOverrides: [],
    status: "running",
    stage: "features",
    createdAt: "2026-10-09T22:00:00.000Z",
    updatedAt: "2026-10-09T22:00:00.000Z",
    spec: SPEC,
    features: [],
    baselineBroken: false,
    baselineFailures: [],
    verify: { install: "npm install", full: "npm run verify", tests: "node scripts/mc-test.mjs {files}", testGlobs: ["tests/**"] },
    decisionsNeeded: [],
    gateCRounds: 0,
    agentRuns: 0,
    notes: [],
    ...overrides,
  };
}

const FILES = ["src/app/page.tsx", "src/db/index.ts", "package.json"];
const FACTS = "Status: 2 of 2 features done\nFeature: Track a habit, done\nFeature: About page, done\n";

/** The name of every prompt and the text the builder gives for a mission with no mode feature. */
export function oldWayPrompts(): Record<string, string> {
  const m = mission();
  const f = feature();
  const second = feature({ ...SPEC.features[1]!, frozenTests: [], status: "done" });
  const broken = mission({ baselineBroken: true, baselineFailures: ["Error: lint failed in src/a.ts", "Error: 2 tests failed"] });
  const done = feature({ status: "done" });
  const blocked = feature({ ...SPEC.features[1]!, status: "blocked", blockedReason: "tried every escalation step, but its checks still failed" });
  const out: Record<string, string> = {
    spec: specPrompt(m, "STACK", { previous: SPEC, issues: ["The about page needs a link from the home page", "Add a test id to the list"] }),
    "spec-plain": specPrompt(m, null),
    "spec-existing-repo": specPrompt(mission({ kind: "feature" }), null),
    gateA: gateAPrompt(m),
    "gateA-broken-baseline": gateAPrompt(broken),
    onboard: onboardPrompt(m, FILES),
    init: initPrompt(m, "STACK", { outputTail: "boom", attempt: 1 }),
    testAuthor: testAuthorPrompt(m, f, { fileList: FILES }),
    "testAuthor-amend": testAuthorPrompt(m, f, { fileList: FILES, amendReason: "The test asserts the wrong streak", previousTestFiles: ["tests/unit/streak.test.ts"] }),
    build: buildPrompt(m, f, { rung: 0, fileList: FILES }),
    "build-second-rung": buildPrompt(m, f, {
      rung: 1,
      fileList: FILES,
      hint: "Use the streak helper",
      lastFailure: { outputTail: "1 failed", antiCheat: ["tests/unit/streak.test.ts: skip (it.skip)"], frozenViolations: ["tests/unit/streak.test.ts"] },
      contextPack: { files: [{ path: "src/db/index.ts", why: "the data layer" }], notes: "Look at the data layer first." },
    }),
    "build-no-tests": buildPrompt(m, feature({ frozenTests: [] }), { rung: 0, fileList: FILES }),
    "build-fix": buildPrompt(m, f, {
      rung: 0,
      fileList: FILES,
      reviewFindings: [{ severity: "major", file: "src/db/index.ts", description: "The streak is not reset", suggestedTest: "Tick, skip a day, tick again" }],
    }),
    "build-broken-baseline": buildPrompt(broken, f, { rung: 0, fileList: FILES }),
    review: reviewPrompt(m, f, { diff: "diff --git a/x b/x\n+x\n", verifyTail: "ok" }),
    "review-no-tests": reviewPrompt(m, feature({ frozenTests: [] }), { diff: "diff --git a/x b/x\n+x\n", verifyTail: "ok" }),
    "review-broken-baseline": reviewPrompt(broken, f, { diff: "diff --git a/x b/x\n+x\n", verifyTail: "ok" }),
    diagnosis: diagnosisPrompt(m, f, { lastOutputTail: "fail", diff: "diff" }),
    "diagnosis-dispute": diagnosisPrompt(m, feature({ hint: "Earlier hint" }), { lastOutputTail: "fail", diff: "diff", dispute: { file: "tests/unit/streak.test.ts", reason: "The streak starts at 0" } }),
    gateC: gateCPrompt(m, { diff: "diff", verifyTail: "ok", features: [f] }),
    "gateC-several": gateCPrompt(m, { diff: "diff", verifyTail: "ok", features: [done, blocked, second] }),
    "gateC-broken-baseline": gateCPrompt(broken, { diff: "diff", verifyTail: "ok", features: [done] }),
    contextPack: contextPackPrompt(m, f, FILES),
    failureDigest: failureDigestPrompt("1 failed: expected 2, got 1"),
    reportProse: reportProsePrompt(m, FACTS),
    "reportProse-several": reportProsePrompt(mission({ title: "Another app" }), `${FACTS}Checked by: tests\n`),
  };
  for (const role of ["architect", "engineer", "test_author", "reviewer", "scout"] as Role[]) out[`role-${role}`] = loadRolePrompt(role);
  return out;
}
