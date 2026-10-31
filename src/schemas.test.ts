import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertStrictCompatible, normalizeSpecText, normalizeVerifyConfig, SCHEMAS, type SchemaName, validateOutput, type VerifyConfigOutput } from "./schemas.js";
import type {
  BuildOutput,
  ContextPackOutput,
  DiagnosisOutput,
  FailureDigestOutput,
  GateOutput,
  InitOutput,
  JsonSchema,
  OnboardOutput,
  ReportProseOutput,
  ReviewOutput,
  RubricOutput,
  SpecOutput,
  TestAuthorOutput,
} from "./types.js";

// Samples are typed with the output interfaces from types.ts, so schema/type drift fails either here
// (compile time) or in the validation tests below (the schemas forbid extra keys and require every key).
const spec: SpecOutput = {
  appName: "Habit Tracker",
  summary: "A simple app to record daily habits and see your streaks.",
  features: [
    {
      id: "track-habit",
      title: "Track a habit",
      story: "As a user I can add a habit and tick it off each day.",
      acceptance: ["Adding a habit named 'Read' shows it in the list", "Ticking it shows a streak of 1"],
      kind: "standard",
      deps: [],
    },
    {
      id: "about-page",
      title: "About page",
      story: "As a visitor I can read what the app is for.",
      acceptance: ["GET /about shows the heading 'About'"],
      kind: "mechanical",
      deps: ["track-habit"],
    },
  ],
  assumptions: ["Single user, no login"],
  uiContract: "Route `/`: input labelled 'Habit name', button 'Add habit', list `data-testid=habit-list`.",
};

const verify: VerifyConfigOutput = { install: "npm install", full: "npm run verify", tests: "node scripts/mc-test.mjs {files}", testGlobs: ["tests/**"] };

// types.ts types OnboardOutput/InitOutput.verify as VerifyConfig (optional fields), but agents return nulls.
type Raw<T> = Omit<T, "verify"> & { verify: VerifyConfigOutput };

const samples: { [K in SchemaName]: { valid: unknown; broken: unknown } } = {
  spec: {
    valid: spec,
    broken: { ...spec, features: [{ ...spec.features[0], kind: "huge" }] },
  },
  gate: {
    valid: { verdict: "revise", issues: ["Feature 2 has no testable criteria"] } satisfies GateOutput,
    broken: { verdict: "maybe", issues: [] },
  },
  onboard: {
    valid: { stackSummary: "Express + Jest", verify: { ...verify, install: null }, notes: [] } satisfies Raw<OnboardOutput>,
    broken: { stackSummary: "Express + Jest", verify: { full: "npm test", testGlobs: [] }, notes: [] },
  },
  init: {
    valid: { summary: "Scaffolded Next.js", verify, notes: ["Playwright browsers were preinstalled"] } satisfies Raw<InitOutput>,
    broken: { summary: "Scaffolded", verify: { ...verify, install: 42 }, notes: [] },
  },
  testAuthor: {
    valid: { testFiles: ["tests/e2e/track-habit.spec.ts"], notes: "" } satisfies TestAuthorOutput,
    broken: { testFiles: "tests/e2e/track-habit.spec.ts", notes: "" },
  },
  build: {
    valid: {
      summary: "Added habit list",
      filesChanged: ["src/app/page.tsx"],
      testDispute: { file: "tests/e2e/track-habit.spec.ts", reason: "Expects label 'Name' but the contract says 'Habit name'" },
      notes: "",
    } satisfies BuildOutput,
    broken: { summary: "x", filesChanged: [], testDispute: { file: "tests/a.spec.ts" }, notes: "" },
  },
  review: {
    valid: {
      verdict: "changes",
      findings: [
        { severity: "blocker", file: "src/app/api/habits/route.ts", description: "SQL built by string concatenation", suggestedTest: "POST a name containing a quote" },
        { severity: "minor", file: null, description: "Inconsistent naming", suggestedTest: null },
      ],
    } satisfies ReviewOutput,
    broken: { verdict: "changes", findings: [{ severity: "critical", file: null, description: "x", suggestedTest: null }] },
  },
  finalReview: {
    valid: { verdict: "approve", findings: [], resolutions: [{ id: "a".repeat(64), outcome: "cannot_judge", evidence: "No current evidence." }] },
    broken: { verdict: "approve", findings: [] },
  },
  diagnosis: {
    valid: { action: "retry_with_hint", hint: "The list re-renders before the insert commits; await the action.", reason: "" } satisfies DiagnosisOutput,
    broken: { action: "retry", hint: "x", reason: "" },
  },
  contextPack: {
    valid: { files: [{ path: "src/app/page.tsx", why: "Home page renders the list" }], notes: "No auth yet" } satisfies ContextPackOutput,
    broken: { files: [{ path: "src/app/page.tsx", why: "x", score: 3 }], notes: "" },
  },
  failureDigest: {
    valid: { summary: "1 e2e test failed", likelyCause: "Missing button", failingTests: ["track-habit.spec.ts › adds a habit"] } satisfies FailureDigestOutput,
    broken: { summary: "x", likelyCause: "y", failingTests: "all" },
  },
  reportProse: {
    valid: { narrative: "Tonight the team built your habit tracker.", whatYouCanDo: ["Add a habit"] } satisfies ReportProseOutput,
    broken: { narrative: 7, whatYouCanDo: [] },
  },
  rubric: {
    valid: {
      verdict: "changes",
      results: [
        { number: 1, check: "The guide is a list of numbered steps.", result: "pass", evidence: "“1. Run the installer.” in docs/setup.md", basis: "text" },
        { number: 2, check: "On a phone the page is one column.", result: "cannot_judge", evidence: "No picture could be opened.", basis: "picture" },
      ],
      seen: ["docs/setup.md"],
      notes: [{ severity: "minor", file: null, description: "The last step has no full stop." }],
    } satisfies RubricOutput,
    broken: { verdict: "changes", results: [{ number: 1, check: "x", result: "pass", evidence: "y" }], seen: [], notes: [] },
  },
};

const names = Object.keys(SCHEMAS) as SchemaName[];

describe("SCHEMAS", () => {
  it("covers every structured output", () => {
    expect(names.sort()).toEqual(
      ["build", "contextPack", "diagnosis", "failureDigest", "finalReview", "gate", "init", "onboard", "reportProse", "review", "rubric", "spec", "testAuthor"].sort(),
    );
  });

  it.each(names)("%s is strict-compatible", (name) => {
    expect(() => assertStrictCompatible(SCHEMAS[name])).not.toThrow();
  });

  it.each(names)("%s accepts a realistic sample", (name) => {
    const result = validateOutput(SCHEMAS[name], samples[name].valid);
    expect(result).toEqual({ ok: true, value: samples[name].valid });
  });

  it.each(names)("%s rejects a broken sample", (name) => {
    const result = validateOutput(SCHEMAS[name], samples[name].broken);
    expect(result.ok).toBe(false);
  });

  it.each(names)("%s rejects unexpected top-level keys", (name) => {
    const result = validateOutput(SCHEMAS[name], { ...(samples[name].valid as object), extra: true });
    expect(result).toEqual({ ok: false, errors: '(root) has unexpected property "extra"' });
  });

  it("leaves every schema of the end of wave 1 as it was: the spec, the review and the others serialise to the same text", () => {
    const before = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "plans", "golden", "schemas-wave1.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(before)).not.toContain("rubric");
    for (const [name, schema] of Object.entries(before)) expect(JSON.stringify(SCHEMAS[name as SchemaName]), name).toBe(JSON.stringify(schema));
    expect(Object.keys(SCHEMAS).filter(name => name !== "finalReview")).toEqual([...Object.keys(before), "rubric"]);
  });

  it("the rubric answer needs the basis of every judgement, a whole number for each check, and only the three results", () => {
    const answer = (result: object) => ({ verdict: "changes", results: [result], seen: [], notes: [] });
    const good = { number: 1, check: "c", result: "pass", evidence: "e", basis: "text" };
    expect(validateOutput(SCHEMAS.rubric, answer(good)).ok).toBe(true);
    const { basis: _basis, ...noBasis } = good;
    expect(validateOutput(SCHEMAS.rubric, answer(noBasis))).toEqual({ ok: false, errors: "/results/0 must have required property 'basis'" });
    expect(validateOutput(SCHEMAS.rubric, answer({ ...good, basis: "guess" })).ok).toBe(false);
    expect(validateOutput(SCHEMAS.rubric, answer({ ...good, number: 1.5 })).ok).toBe(false);
    expect(validateOutput(SCHEMAS.rubric, answer({ ...good, number: "1" })).ok).toBe(false);
    expect(validateOutput(SCHEMAS.rubric, answer({ ...good, result: "maybe" })).ok).toBe(false);
    expect(validateOutput(SCHEMAS.rubric, answer({ ...good, result: "cannot_judge", basis: "picture" })).ok).toBe(true);
    expect(validateOutput(SCHEMAS.rubric, { ...answer(good), notes: [{ severity: "huge", file: null, description: "x" }] }).ok).toBe(false);
  });

  it("allows a null testDispute and null finding fields", () => {
    const build: BuildOutput = { summary: "Done", filesChanged: [], testDispute: null, notes: "" };
    expect(validateOutput(SCHEMAS.build, build).ok).toBe(true);
  });

  it("requires nullable keys to be present", () => {
    const result = validateOutput(SCHEMAS.build, { summary: "Done", filesChanged: [], notes: "" });
    expect(result).toEqual({ ok: false, errors: "(root) must have required property 'testDispute'" });
  });
});

describe("validateOutput", () => {
  afterEach(() => vi.restoreAllMocks());

  it("describes enum, type and nested errors with their paths", () => {
    const result = validateOutput(SCHEMAS.review, { verdict: "nope", findings: [{ severity: "minor", file: 3, description: "x", suggestedTest: null }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('/verdict must be one of ["approve","changes"]');
    expect(result.errors).toContain("/findings/0/file must be string,null");
  });

  it("caps the number of reported errors", () => {
    const findings = Array.from({ length: 30 }, () => ({ severity: "huge", file: null, description: "x", suggestedTest: null }));
    const result = validateOutput(SCHEMAS.review, { verdict: "changes", findings });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.split("; ")).toHaveLength(21);
    expect(result.errors).toMatch(/\(10 more errors\)$/);
  });

  it("rejects non-objects", () => {
    expect(validateOutput(SCHEMAS.gate, null).ok).toBe(false);
    expect(validateOutput(SCHEMAS.gate, "approve").ok).toBe(false);
  });

  it("compiles each schema object once", () => {
    const compile = vi.spyOn(Ajv.prototype, "compile");
    const schema: JsonSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
    expect(validateOutput(schema, { ok: true }).ok).toBe(true);
    expect(validateOutput(schema, { ok: "yes" }).ok).toBe(false);
    expect(compile).toHaveBeenCalledTimes(1);
    validateOutput({ ...schema }, { ok: true });
    expect(compile).toHaveBeenCalledTimes(2);
  });
});

describe("assertStrictCompatible", () => {
  const leaf = (extra: Record<string, unknown>) => ({
    type: "object",
    properties: { a: { type: "string", ...extra } },
    required: ["a"],
    additionalProperties: false,
  });

  it("accepts nullable types, enums, anyOf with null and descriptions", () => {
    expect(() =>
      assertStrictCompatible({
        type: "object",
        description: "root",
        properties: {
          a: { type: ["string", "null"] },
          b: { type: "string", enum: ["x", "y"] },
          c: { anyOf: [{ type: "object", properties: {}, required: [], additionalProperties: false }, { type: "null" }] },
          d: { type: "array", items: { type: "integer" } },
        },
        required: ["a", "b", "c", "d"],
        additionalProperties: false,
      }),
    ).not.toThrow();
  });

  it.each([
    ["a non-object root", { type: "array", items: { type: "string" } }, /root must have type "object"/],
    ["a nullable root", { type: ["object", "null"], properties: {}, required: [], additionalProperties: false }, /root/],
    ["a missing additionalProperties", { type: "object", properties: {}, required: [] }, /\$ objects need additionalProperties: false/],
    ["additionalProperties: true", { type: "object", properties: {}, required: [], additionalProperties: true }, /additionalProperties: false/],
    ["a missing required key", { type: "object", properties: { a: { type: "string" } }, required: [], additionalProperties: false }, /missing a/],
    ["no required array", { type: "object", properties: { a: { type: "string" } }, additionalProperties: false }, /required array/],
    ["required naming an unknown key", { type: "object", properties: {}, required: ["ghost"], additionalProperties: false }, /unknown properties: ghost/],
    ["an object without properties", { type: "object", required: [], additionalProperties: false }, /objects need properties/],
  ])("rejects %s", (_label, schema, message) => {
    expect(() => assertStrictCompatible(schema)).toThrow(message);
  });

  it.each(["minLength", "maxLength", "pattern", "format", "minItems", "maxItems", "oneOf", "allOf", "$ref", "default", "const"])(
    "rejects the %s keyword with its path",
    (keyword) => {
      expect(() => assertStrictCompatible(leaf({ [keyword]: 1 }))).toThrow(`strict schema: $.properties.a keyword "${keyword}" is not allowed`);
    },
  );

  it("rejects violations nested in arrays and anyOf branches, naming the path", () => {
    const nested = {
      type: "object",
      properties: {
        list: { type: "array", items: { type: "object", properties: { x: { type: "string" } }, required: [], additionalProperties: false } },
      },
      required: ["list"],
      additionalProperties: false,
    };
    expect(() => assertStrictCompatible(nested)).toThrow("$.properties.list.items required must list every property; missing x");

    const branch = {
      type: "object",
      properties: { maybe: { anyOf: [{ type: "object", properties: {}, required: [] }, { type: "null" }] } },
      required: ["maybe"],
      additionalProperties: false,
    };
    expect(() => assertStrictCompatible(branch)).toThrow("$.properties.maybe.anyOf[0] objects need additionalProperties: false");
  });

  it.each([
    ["an array without items", { type: "array" }, /arrays need items/],
    ["items on a non-array", { type: "string", items: { type: "string" } }, /items is only allowed on arrays/],
    ["properties on a non-object", { type: "string", properties: {} }, /only allowed on objects/],
    ["an empty anyOf", { anyOf: [] }, /anyOf must be a non-empty array/],
    ["an empty enum", { type: "string", enum: [] }, /enum must be a non-empty array/],
    ["a node with neither type nor anyOf", { description: "anything" }, /needs a type or anyOf/],
    ["an unknown type", { type: "date" }, /invalid type "date"/],
    ["an empty type list", { type: [] }, /invalid type/],
    ["a non-string description", { type: "string", description: 5 }, /description must be a string/],
  ])("rejects %s", (_label, child, message) => {
    const schema = { type: "object", properties: { a: child }, required: ["a"], additionalProperties: false };
    expect(() => assertStrictCompatible(schema)).toThrow(message);
  });

  it("rejects a property schema that is not an object", () => {
    const schema = { type: "object", properties: { a: true }, required: ["a"], additionalProperties: false };
    expect(() => assertStrictCompatible(schema)).toThrow("$.properties.a must be a schema object");
  });
});

describe("normalizeVerifyConfig", () => {
  it("turns null commands into absent keys", () => {
    const vc = normalizeVerifyConfig({ install: null, full: "npm test", tests: null, testGlobs: ["test/**"] });
    expect(vc).toEqual({ full: "npm test", testGlobs: ["test/**"] });
    expect(Object.keys(vc)).not.toContain("install");
    expect(Object.keys(vc)).not.toContain("tests");
  });

  it("keeps set commands, trimmed", () => {
    expect(normalizeVerifyConfig({ install: " npm install ", full: " npm run verify\n", tests: "node scripts/mc-test.mjs {files}", testGlobs: ["tests/**"] })).toEqual({
      install: "npm install",
      full: "npm run verify",
      tests: "node scripts/mc-test.mjs {files}",
      testGlobs: ["tests/**"],
    });
  });

  it("treats blank commands as unset and drops blank globs", () => {
    expect(normalizeVerifyConfig({ install: "  ", full: "make check", tests: "", testGlobs: ["", " tests/** ", "  "] })).toEqual({
      full: "make check",
      testGlobs: ["tests/**"],
    });
  });

  // The schema accepts these (strict mode has no minLength/minItems), but the Verifier could never pass with them.
  it("rejects a blank full command", () => {
    expect(() => normalizeVerifyConfig({ install: null, full: "  \n", tests: null, testGlobs: ["tests/**"] })).toThrow(/Unusable verify config: `verify\.full` is empty/);
  });

  it("rejects a config without any test glob", () => {
    expect(() => normalizeVerifyConfig({ install: null, full: "npm test", tests: null, testGlobs: [] })).toThrow(/`verify\.testGlobs` has no glob/);
    expect(() => normalizeVerifyConfig({ install: null, full: "npm test", tests: null, testGlobs: ["  ", ""] })).toThrow(/`verify\.testGlobs` has no glob/);
  });

  it("names every problem at once", () => {
    expect(() => normalizeVerifyConfig({ install: null, full: "", tests: null, testGlobs: [" "] })).toThrow(/`verify\.full` is empty.*; `verify\.testGlobs` has no glob/);
  });
});

describe("normalizeSpecText (R3-4 of the real runs)", () => {
  // The contract of the revised plan in the real run R3: one line, with the two characters backslash and n between its items (9 times),
  // and a backslash before each of its quotation marks (12 times), where the plan had a list on separate lines.
  const real = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "modes", "real-r3", "revised-contract.txt"), "utf8");
  const withContract = (uiContract: string): SpecOutput => ({ ...spec, uiContract });

  it("preserves the historical R3 contract literally, including every escape", () => {
    expect(real).not.toContain("\n");
    expect(real.split("\\n")).toHaveLength(10);
    const fixed = normalizeSpecText(withContract(real)).uiContract;
    expect(fixed).toBe(real);
    expect(fixed.split("\n")).toHaveLength(1);
    expect(fixed).toMatch(/\\[n"]/u);
  });

  it("works on every string of the plan, and leaves the rest of it as it was", () => {
    const messy: SpecOutput = {
      ...spec,
      appName: "Habit Tracker",
      summary: "First.\\nSecond.\\nThird.",
      assumptions: ["One.\\nTwo.\\nThree.", "Plain."],
      features: [{ ...spec.features[0]!, title: "Track", story: 'Say \\"hello\\" and \\"bye\\"', acceptance: ['Shows \\"a\\" and \\"b\\"', "fine"] }, spec.features[1]!],
    };
    const fixed = normalizeSpecText(messy);
    expect(fixed.summary).toBe(messy.summary);
    expect(fixed.assumptions).toEqual(messy.assumptions);
    expect(fixed.features[0]).toEqual(messy.features[0]);
    expect(fixed.features[1]).toEqual(spec.features[1]);
    expect(fixed.appName).toBe("Habit Tracker");
  });

  it("returns the very same object when nothing needs changing, and never changes its input", () => {
    expect(normalizeSpecText(spec)).toBe(spec);
    const right = withContract("- one\n- two\n- three");
    expect(normalizeSpecText(right)).toBe(right);
    const before = JSON.stringify(withContract(real));
    const input = withContract(real);
    normalizeSpecText(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("leaves text that only talks about an escape: one backslash-n in a sentence, a string with real line breaks, quotation marks that are not all escaped", () => {
    for (const text of [
      "The tool splits the text on \\n and joins it again.",
      "- one\n- two\\n- three\\n- four",
      'It says "hello" and also \\"bye\\".',
      'One \\"quoted\\" word and "another".',
      "Windows paths like C:\\new\\folder have no line break in them, only a backslash.",
      "A single \\\" mark.",
    ]) {
      expect(normalizeSpecText(withContract(text)).uiContract, text).toBe(text);
    }
  });

  it("preserves literal backslash-n in titles, stories, checks and summaries alike", () => {
    const talk = "lines('a\\nb\\nc') returns three items, split on \\n";
    const fixed = normalizeSpecText({ ...spec, summary: "A.\\nB.\\nC.", features: [{ ...spec.features[0]!, title: talk, story: talk, acceptance: [talk] }, spec.features[1]!] });
    expect(fixed.summary).toBe("A.\\nB.\\nC.");
    expect(fixed.features[0]).toMatchObject({ title: talk, story: talk, acceptance: [talk] });
    expect(normalizeSpecText({ ...spec, appName: talk }).appName).toBe(talk);
  });

  it("preserves repeated escape text as literally as real newlines", () => {
    for (const text of ["a\\nb\\nc", 'data-testid=\\"x\\" and \\"y\\"', "a\nb\nc"]) expect(normalizeSpecText(withContract(text)).uiContract).toBe(text);
  });
});
