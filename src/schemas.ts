// JSON Schemas for every structured agent output, plus validation.
// Codex `--output-schema` (OpenAI strict structured outputs) and Claude `--json-schema` both accept these,
// which is why every schema is "strict-compatible" (see docs/mvp-spec.md §Schemas).
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { JsonSchema, SpecOutput, VerifyConfig, VerifyConfigOutput } from "./types.js";

// ───────────────────────────── Builders ─────────────────────────────
// Objects are built so that `required` always lists every property: strictness by construction.

function str(description?: string): JsonSchema {
  return withDescription({ type: "string" }, description);
}

function nullableStr(description?: string): JsonSchema {
  return withDescription({ type: ["string", "null"] }, description);
}

function strArray(description?: string): JsonSchema {
  return withDescription({ type: "array", items: { type: "string" } }, description);
}

function integer(description?: string): JsonSchema {
  return withDescription({ type: "integer" }, description);
}

function arrayOf(items: JsonSchema, description?: string): JsonSchema {
  return withDescription({ type: "array", items }, description);
}

function enumOf(values: string[], description?: string): JsonSchema {
  return withDescription({ type: "string", enum: values }, description);
}

function obj(properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  const schema = { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  return withDescription(schema, description);
}

function nullable(schema: JsonSchema, description?: string): JsonSchema {
  return withDescription({ anyOf: [schema, { type: "null" }] }, description);
}

function withDescription(schema: JsonSchema, description: string | undefined): JsonSchema {
  return description === undefined ? schema : { ...schema, description };
}

// ───────────────────────────── Shared shapes ─────────────────────────────

const specFeature = obj({
  id: str("kebab-case, unique within the spec, e.g. add-todo"),
  title: str(),
  story: str("Plain-language user story"),
  acceptance: strArray("Concrete, testable criteria describing observable behavior (UI or HTTP)"),
  kind: enumOf(["standard", "mechanical"], "mechanical = narrow boilerplate work"),
  deps: strArray("ids of features that must be done first"),
});

const verifyConfig = obj({
  install: nullableStr("Install dependencies, e.g. `npm install`; null when nothing needs installing"),
  full: str("One non-interactive command that runs every check (lint, typecheck, unit, e2e) and exits 0 only when all pass"),
  tests: nullableStr("Runs specific test files; `{files}` is replaced by space-separated repo-relative paths; null if unsupported"),
  testGlobs: strArray("Repo-relative globs that match test files, e.g. tests/**"),
});

const finding = obj({
  severity: enumOf(["blocker", "major", "minor"]),
  file: nullableStr("Repo-relative path, or null when the finding is not about one file"),
  description: str("What is wrong and why it matters"),
  suggestedTest: nullableStr("A test that would expose the problem"),
});

// ───────────────────────────── Output schemas ─────────────────────────────

export const SCHEMAS = {
  spec: obj({
    appName: str("Short human-readable app name"),
    summary: str("Plain-language summary for a non-programmer"),
    features: arrayOf(specFeature, "In build order; the first is the core user flow"),
    assumptions: strArray("Decisions made on the user's behalf, in plain language"),
    uiContract: str("Routes, visible labels, data-testids and endpoints shared by test authors and engineers"),
  }),
  gate: obj({
    verdict: enumOf(["approve", "revise"]),
    issues: strArray("Concrete, actionable problems; empty when approving"),
  }),
  onboard: obj({
    stackSummary: str("Languages, frameworks, test tools and layout of the existing repository"),
    verify: verifyConfig,
    notes: strArray(),
  }),
  init: obj({
    summary: str("What was scaffolded"),
    verify: verifyConfig,
    notes: strArray(),
  }),
  testAuthor: obj({
    testFiles: strArray("Repo-relative paths of every test file written or changed"),
    notes: str(),
  }),
  build: obj({
    summary: str("What was implemented"),
    filesChanged: strArray("Repo-relative paths"),
    testDispute: nullable(
      obj({ file: str("Repo-relative path of the frozen test"), reason: str("Why the test is wrong") }),
      "null unless a frozen test is genuinely wrong",
    ),
    notes: str(),
  }),
  review: obj({
    verdict: enumOf(["approve", "changes"]),
    findings: arrayOf(finding),
  }),
  finalReview: obj({
    verdict: enumOf(["approve", "changes"]),
    findings: arrayOf(finding),
    resolutions: arrayOf(obj({
      id: str("Exact outstanding finding ID from the brief"),
      outcome: enumOf(["resolved", "open", "cannot_judge"]),
      evidence: str("Specific current-file evidence; no omission or empty evidence closes a concern"),
    })),
  }),
  diagnosis: obj({
    action: enumOf(["retry_with_hint", "amend_tests", "block"]),
    hint: str("Root cause and concrete guidance for the next engineer"),
    reason: str("amend_tests: why the tests are wrong; block: why the feature cannot be built; otherwise empty"),
  }),
  contextPack: obj({
    files: arrayOf(obj({ path: str("Repo-relative path from the file list"), why: str() })),
    notes: str(),
  }),
  failureDigest: obj({
    summary: str(),
    likelyCause: str(),
    failingTests: strArray("Failing test names or files, copied from the output"),
  }),
  reportProse: obj({
    narrative: str("3-8 plain-language sentences for a non-programmer"),
    whatYouCanDo: strArray("Things the user can now do in the app, in plain language"),
  }),
  rubric: obj({
    verdict: enumOf(["approve", "changes"], "approve only when every check passes"),
    results: arrayOf(
      obj({
        number: integer("The number of the check in the list"),
        check: str("The check, copied from the list"),
        result: enumOf(["pass", "fail", "cannot_judge"]),
        evidence: str(
          "An exact quote in quotation marks with the file name, or what a picture shows, or where you looked and found nothing. One or two sentences",
        ),
        basis: enumOf(
          ["text", "picture"],
          "text when the judgement rests on the words of the files, picture when it rests on a picture you opened",
        ),
      }),
    ),
    seen: strArray("The files and pictures you really opened, as the brief names them"),
    notes: arrayOf(
      obj({
        severity: enumOf(["major", "minor"]),
        file: nullableStr("The file, or null"),
        description: str("A problem outside the list that would mislead or hurt a reader"),
      }),
    ),
  }),
};

export type SchemaName = keyof typeof SCHEMAS;

// ───────────────────────────── Validation ─────────────────────────────

const MAX_REPORTED_ERRORS = 20;

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new WeakMap<JsonSchema, ValidateFunction>();

/** Validates `value` against `schema` with Ajv. Compiled validators are cached by schema identity. */
export function validateOutput<T>(schema: JsonSchema, value: unknown): { ok: true; value: T } | { ok: false; errors: string } {
  let validate = compiled.get(schema);
  if (validate === undefined) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  if (validate(value)) return { ok: true, value: value as T };
  return { ok: false, errors: formatErrors(validate.errors ?? []) };
}

function formatErrors(errors: ErrorObject[]): string {
  const lines = errors.slice(0, MAX_REPORTED_ERRORS).map(describeError);
  const more = errors.length - lines.length;
  if (more > 0) lines.push(`(${more} more errors)`);
  return lines.join("; ");
}

function describeError(e: ErrorObject): string {
  const where = e.instancePath || "(root)";
  const params = e.params as Record<string, unknown>;
  if (e.keyword === "additionalProperties") return `${where} has unexpected property "${String(params.additionalProperty)}"`;
  if (e.keyword === "enum") return `${where} must be one of ${JSON.stringify(params.allowedValues)}`;
  return `${where} ${e.message ?? "is invalid"}`;
}

// ───────────────────────────── Strict compatibility ─────────────────────────────

const ALLOWED_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "anyOf", "description"]);
const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** Throws when `schema` breaks a strict structured-output rule. The message names the offending JSON path. */
export function assertStrictCompatible(schema: JsonSchema): void {
  if (schema.type !== "object") throw new Error('strict schema: the root must have type "object"');
  checkNode(schema, "$");
}

function checkNode(node: unknown, path: string): void {
  if (!isPlainObject(node)) throw strictError(path, "must be a schema object");
  for (const key of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) throw strictError(path, `keyword "${key}" is not allowed`);
  }
  if (node.description !== undefined && typeof node.description !== "string") throw strictError(path, "description must be a string");
  if (node.type === undefined && node.anyOf === undefined) throw strictError(path, "needs a type or anyOf");

  const types = node.type === undefined ? [] : checkType(node.type, path);
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    throw strictError(path, "enum must be a non-empty array");
  }
  if (node.anyOf !== undefined) checkAnyOf(node.anyOf, path);

  if (types.includes("object")) checkObject(node, path);
  else if (node.properties !== undefined || node.required !== undefined || node.additionalProperties !== undefined) {
    throw strictError(path, "properties/required/additionalProperties are only allowed on objects");
  }

  if (types.includes("array")) {
    if (node.items === undefined) throw strictError(path, "arrays need items");
    checkNode(node.items, `${path}.items`);
  } else if (node.items !== undefined) {
    throw strictError(path, "items is only allowed on arrays");
  }
}

function checkType(type: unknown, path: string): string[] {
  const types = Array.isArray(type) ? type : [type];
  if (types.length === 0 || !types.every((t) => typeof t === "string" && JSON_TYPES.has(t))) {
    throw strictError(path, `invalid type ${JSON.stringify(type)}`);
  }
  return types as string[];
}

function checkAnyOf(anyOf: unknown, path: string): void {
  if (!Array.isArray(anyOf) || anyOf.length === 0) throw strictError(path, "anyOf must be a non-empty array");
  anyOf.forEach((branch, i) => checkNode(branch, `${path}.anyOf[${i}]`));
}

function checkObject(node: Record<string, unknown>, path: string): void {
  if (node.additionalProperties !== false) throw strictError(path, "objects need additionalProperties: false");
  if (!isPlainObject(node.properties)) throw strictError(path, "objects need properties");
  const keys = Object.keys(node.properties);
  const required = node.required;
  if (!Array.isArray(required)) throw strictError(path, "objects need a required array");
  const missing = keys.filter((k) => !required.includes(k));
  if (missing.length > 0) throw strictError(path, `required must list every property; missing ${missing.join(", ")}`);
  const unknown = required.filter((k) => typeof k !== "string" || !keys.includes(k));
  if (unknown.length > 0) throw strictError(path, `required names unknown properties: ${unknown.join(", ")}`);
  for (const key of keys) checkNode(node.properties[key], `${path}.properties.${key}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strictError(path: string, problem: string): Error {
  return new Error(`strict schema: ${path} ${problem}`);
}

// ───────────────────────────── Conversions ─────────────────────────────

export type { VerifyConfigOutput } from "./types.js";

/** Converts the schema shape of a verify config (nullable fields) to `VerifyConfig` (optional fields).
 *  Blank optional commands count as unset, and blank globs are dropped. Strict schemas can't forbid empty values,
 *  so this throws when the config could never verify anything; the message is fit to send back to the agent. */
export function normalizeVerifyConfig(v: VerifyConfigOutput): VerifyConfig {
  const vc: VerifyConfig = { full: v.full.trim(), testGlobs: v.testGlobs.map((g) => g.trim()).filter((g) => g !== "") };
  const problems = [
    vc.full === "" && "`verify.full` is empty; give one command that runs every check",
    vc.testGlobs.length === 0 && "`verify.testGlobs` has no glob; list globs that match the test files, including where new tests go",
  ].filter((p): p is string => p !== false);
  if (problems.length > 0) throw new Error(`Unusable verify config: ${problems.join("; ")}.`);
  const install = v.install?.trim();
  const tests = v.tests?.trim();
  if (install) vc.install = install;
  if (tests) vc.tests = tests;
  return vc;
}

/** Compatibility entry point: JSON was already parsed; never decode its strings a second time. */
export function normalizeSpecText(spec: SpecOutput): SpecOutput {
  return spec;
}
