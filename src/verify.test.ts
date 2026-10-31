import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger, VerifyConfig } from "./types.js";
import {
  checkFrozen,
  failureSignature,
  hashFiles,
  isTestPath,
  matchesGlob,
  scanAntiCheat,
  stripAnsi,
  tailLines,
  Verifier,
} from "./verify.js";

let tempDirs: string[] = [];

function makeTempDir(prefix = "mc-verify-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ───────────────────────────── stripAnsi / tailLines ─────────────────────────────

describe("stripAnsi", () => {
  it("removes color and style codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[39m and \x1b[1;32mbold green\x1b[0m")).toBe("red and bold green");
  });

  it("removes cursor movement and line clearing", () => {
    expect(stripAnsi("\x1b[2K\x1b[1Gprogress \x1b[?25lhidden cursor\x1b[?25h")).toBe("progress hidden cursor");
  });

  it("removes OSC hyperlinks but keeps their label", () => {
    expect(stripAnsi("see \x1b]8;;https://example.com\x07the docs\x1b]8;;\x07 now")).toBe("see the docs now");
    expect(stripAnsi("\x1b]8;;file:///x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });

  it("removes charset and other two-byte escapes", () => {
    expect(stripAnsi("\x1b(Bplain\x1b7saved\x1b8")).toBe("plainsaved");
  });

  it("leaves ordinary text, including brackets, untouched", () => {
    const text = "⎯⎯⎯ [1/1] ⎯⎯⎯ expected [ 1, 2 ] to equal [ 1 ]";
    expect(stripAnsi(text)).toBe(text);
  });
});

describe("tailLines", () => {
  it("returns the last n lines", () => {
    expect(tailLines("a\nb\nc\nd", 2)).toBe("c\nd");
  });

  it("ignores a single trailing newline", () => {
    expect(tailLines("a\nb\nc\n", 1)).toBe("c");
    expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc");
  });

  it("returns everything when there are fewer lines than n", () => {
    expect(tailLines("a\nb", 10)).toBe("a\nb");
    expect(tailLines("single", 3)).toBe("single");
  });

  it("keeps leading and inner blank lines that fall inside the window", () => {
    expect(tailLines("\nb", 2)).toBe("\nb");
    expect(tailLines("a\n\n\nd", 3)).toBe("\n\nd");
  });

  it("returns an empty string for n <= 0 or empty input", () => {
    expect(tailLines("a\nb", 0)).toBe("");
    expect(tailLines("a\nb", -1)).toBe("");
    expect(tailLines("", 5)).toBe("");
  });
});

// ───────────────────────────── failureSignature ─────────────────────────────

interface RunNoise {
  workdir: string;
  ms: number;
  clock: string;
  iso: string;
  port: number;
  line: number;
  col: number;
  sha: string;
}

const NOISE_A: RunNoise = {
  workdir: "/tmp/mc-verify-Xa81Kq/app",
  ms: 12,
  clock: "21:15:30",
  iso: "2026-10-09T21:15:30.123Z",
  port: 3100,
  line: 14,
  col: 23,
  sha: "3f9a2b1c4d5e6f70",
};

const NOISE_B: RunNoise = {
  workdir: "/home/runner/.mission-control/worktrees/2026-10-09-todo-app/add-todo",
  ms: 1874,
  clock: "03:02:09",
  iso: "2026-10-10T03:02:09.987Z",
  port: 51234,
  line: 31,
  col: 7,
  sha: "a0b1c2d3e4f5a6b7",
};

/** A realistic failing vitest run; everything in `noise` varies between otherwise identical runs. */
function vitestOutput(noise: RunNoise, failure = "expected [] to have a length of 1 but got +0", testName = "adds a todo") {
  return [
    `\x1b[7m RUN \x1b[27m v2.1.8 ${noise.workdir}`,
    "",
    ` \x1b[31m❯\x1b[39m tests/unit/todo.test.ts (3 tests | 1 failed) ${noise.ms}ms`,
    `   \x1b[31m×\x1b[39m ${testName} ${noise.ms + 3}ms`,
    `     → ${failure}`,
    `   ✓ lists todos ${noise.ms - 2}ms`,
    "",
    "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
    "",
    ` FAIL  tests/unit/todo.test.ts > ${testName}`,
    `AssertionError: ${failure}`,
    "",
    " ❯ tests/unit/todo.test.ts:" + `${noise.line}:${noise.col}`,
    `     12|   it("${testName}", async () => {`,
    `     13|     const res = await fetch("http://localhost:${noise.port}/api/todos");`,
    "     14|     expect(await res.json()).toHaveLength(1);",
    " ❯ processTicksAndRejections node:internal/process/task_queues:95:5",
    ` ❯ ${noise.workdir}/tests/unit/todo.test.ts:${noise.line}:${noise.col}`,
    `[${noise.iso}] error: request to http://127.0.0.1:${noise.port}/api/todos failed (trace ${noise.sha})`,
    "",
    "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
    "",
    " Test Files  1 failed (1)",
    "      Tests  1 failed | 2 passed (3)",
    `   Start at  ${noise.clock}`,
    `   Duration  ${noise.ms * 10}ms (transform 25ms, setup 0ms, collect ${noise.ms}ms, tests ${noise.ms}ms)`,
    "",
  ].join("\n");
}

/** A realistic failing Playwright run. */
function playwrightOutput(noise: RunNoise, locator = "getByTestId('todo-item')", title = "adds a todo") {
  return [
    "Running 3 tests using 1 worker",
    `  1) [chromium] › tests/e2e/todo.spec.ts:${noise.line}:${noise.col} › ${title} ─────────────`,
    "",
    `    Error: Timed out ${noise.ms * 100}ms waiting for expect(locator).toBeVisible()`,
    "",
    `    Locator: ${locator}`,
    "    Expected: visible",
    "    Received: <element(s) not found>",
    "    Call log:",
    `      - expect.toBeVisible with timeout ${noise.ms * 100}ms`,
    `      - waiting for ${locator}`,
    "",
    `      at ${noise.workdir}/tests/e2e/todo.spec.ts:${noise.line}:${noise.col}`,
    "",
    `    Error Context: test-results/todo-adds-a-todo-chromium/error-context.md (server http://localhost:${noise.port})`,
    "",
    "  1 failed",
    `    [chromium] › tests/e2e/todo.spec.ts:${noise.line}:${noise.col} › ${title}`,
    `  2 passed (${(noise.ms / 10).toFixed(1)}s)`,
  ].join("\n");
}

describe("failureSignature", () => {
  it('returns "" for empty or whitespace-only output', () => {
    expect(failureSignature("")).toBe("");
    expect(failureSignature("\n\n   \n\t\n")).toBe("");
  });

  it("returns the first 12 hex chars of a sha1", () => {
    expect(failureSignature("Error: boom")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is stable across vitest runs that differ only in durations, times, paths, ports, line:col and hashes", () => {
    const a = failureSignature(vitestOutput(NOISE_A));
    expect(a).not.toBe("");
    expect(failureSignature(vitestOutput(NOISE_B))).toBe(a);
  });

  it("is stable across Playwright runs that differ only in noise", () => {
    expect(failureSignature(playwrightOutput(NOISE_B))).toBe(failureSignature(playwrightOutput(NOISE_A)));
  });

  it("differs for a different assertion failure", () => {
    const original = failureSignature(vitestOutput(NOISE_A));
    const other = failureSignature(vitestOutput(NOISE_A, 'expected "Buy milk" to be "Buy eggs"'));
    expect(other).not.toBe(original);
  });

  it("differs when a different test fails", () => {
    const original = failureSignature(vitestOutput(NOISE_A));
    expect(failureSignature(vitestOutput(NOISE_A, undefined, "deletes a todo"))).not.toBe(original);
  });

  it("differs for a different Playwright locator", () => {
    const original = failureSignature(playwrightOutput(NOISE_A));
    expect(failureSignature(playwrightOutput(NOISE_A, "getByRole('button', { name: 'Add' })"))).not.toBe(original);
  });

  it("differs when a different Playwright test fails the same way", () => {
    const original = failureSignature(playwrightOutput(NOISE_A));
    expect(failureSignature(playwrightOutput(NOISE_A, undefined, "completes a todo"))).not.toBe(original);
  });

  it("ignores Playwright failure numbering, which depends on worker timing", () => {
    const header = (n: number, title: string) => `  ${n}) [chromium] › tests/e2e/todo.spec.ts:3:5 › ${title} ───`;
    const timeout = "    Error: Timed out 5000ms waiting for expect(locator).toBeVisible()";
    const a = [header(1, "adds"), timeout, header(2, "removes"), timeout].join("\n");
    const b = [header(1, "removes"), timeout, header(2, "adds"), timeout].join("\n");
    expect(failureSignature(b)).toBe(failureSignature(a));
  });

  it("tells node --test failures apart by the failing test's name", () => {
    const run = (name: string) =>
      `✖ ${name} (1.2ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n  3 !== 4\n\nℹ fail 1`;
    expect(failureSignature(run("adds numbers"))).not.toBe(failureSignature(run("subtracts numbers")));
  });

  it("differs between unit and e2e failures", () => {
    expect(failureSignature(vitestOutput(NOISE_A))).not.toBe(failureSignature(playwrightOutput(NOISE_A)));
  });

  it("ignores ANSI colors and CRLF line endings", () => {
    const plain = "FAIL tests/a.test.ts > works\nAssertionError: expected 1 to be 2";
    const colored = "\x1b[31mFAIL\x1b[39m tests/a.test.ts > works\r\n\x1b[1mAssertionError\x1b[22m: expected 1 to be 2\r\n";
    expect(failureSignature(colored)).toBe(failureSignature(plain));
  });

  it("ignores progress lines redrawn with carriage returns", () => {
    const a = "Building 10%\rBuilding 80%\rError: build failed";
    const b = "Building 35%\rError: build failed";
    expect(failureSignature(a)).toBe(failureSignature(b));
  });

  it("ignores the order of failure lines (parallel test output)", () => {
    const lines = ["FAIL tests/a.test.ts > one", "FAIL tests/b.test.ts > two", "Error: expected 1 to be 2"];
    expect(failureSignature([...lines].reverse().join("\n"))).toBe(failureSignature(lines.join("\n")));
  });

  it("ignores changes to non-failure lines when failure lines exist", () => {
    const a = "compiling 12 modules\nError: cannot find module './db'\nready in a moment";
    const b = "compiling 97 modules\nError: cannot find module './db'\nsomething else entirely";
    expect(failureSignature(a)).toBe(failureSignature(b));
  });

  it("keeps URL routes and relative paths, which identify the failure", () => {
    const a = failureSignature("Error: GET /api/items returned 500");
    expect(failureSignature("Error: GET /api/users returned 500")).not.toBe(a);
    expect(failureSignature("Error: redirect to /login failed")).not.toBe(failureSignature("Error: redirect to /signup failed"));
    expect(failureSignature("Error in src/app/page.tsx")).not.toBe(failureSignature("Error in src/app/layout.tsx"));
  });

  it("keeps the basename of absolute paths, so different files still differ", () => {
    const a = failureSignature("Error: cannot read /home/u/app/src/db.ts");
    expect(failureSignature("Error: cannot read /srv/other/checkout/src/db.ts")).toBe(a);
    expect(failureSignature("Error: cannot read /home/u/app/src/auth.ts")).not.toBe(a);
  });

  it("normalizes temp directories, file:// URLs, uuids and memory addresses", () => {
    const a = failureSignature(
      "Error: ENOENT /tmp/vitest-Ab12Cd\n" +
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module file:///tmp/x1/app/src/a.ts:3:9\n" +
        "Error: id 123e4567-e89b-12d3-a456-426614174000 not found at 0x7ffd5e8c12",
    );
    const b = failureSignature(
      "Error: ENOENT /tmp/vitest-Zz99Yy\n" +
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find module file:///var/tmp/other/src/a.ts:8:1\n" +
        "Error: id 9f0e1d2c-3b4a-5968-7766-554433221100 not found at 0x55aa00ff33",
    );
    expect(b).toBe(a);
    const missingModule = (file: string) => `Error [ERR_MODULE_NOT_FOUND]: Cannot find module file:///tmp/x1/app/src/${file}:3:9`;
    expect(failureSignature(missingModule("b.ts"))).not.toBe(failureSignature(missingModule("a.ts")));
  });

  it("normalizes clock times and ISO timestamps on failure lines", () => {
    const run = (clock: string, iso: string) => `Error: request timed out at ${clock}\n[${iso}] error: db locked`;
    const a = failureSignature(run("21:15:30", "2026-10-09T21:15:30.123Z"));
    expect(failureSignature(run("03:02:09", "2026-10-10T03:02:09.987+02:00"))).toBe(a);
    expect(failureSignature(run("3:45 PM", "2026-10-10 03:02"))).toBe(a);
  });

  it("normalizes node --test durations and timeouts", () => {
    const run = (ms: string) =>
      `✖ adds numbers (${ms}ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\nℹ fail 1\nℹ duration_ms ${ms}\nError: timeout of ${ms}ms exceeded`;
    expect(failureSignature(run("1.234"))).toBe(failureSignature(run("56.789")));
  });

  it("normalizes duration fields written as key: value or key=value", () => {
    const run = (n: number) => `Error: test failed {"duration": ${n}} duration=${n * 2} Duration ${n * 3}`;
    expect(failureSignature(run(12))).toBe(failureSignature(run(3456)));
  });

  it("stays fast on huge lines, including a duration key followed by a long run of spaces", () => {
    const started = Date.now();
    expect(failureSignature(`Error: duration${" ".repeat(1_000_000)}|`)).toMatch(/^[0-9a-f]{12}$/);
    expect(failureSignature(`Error: duration${" ".repeat(4000)}|`)).toMatch(/^[0-9a-f]{12}$/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("only looks at the first 4096 characters of a line", () => {
    const head = `Error: ${"x".repeat(5000)}`;
    expect(failureSignature(`${head} tail one`)).toBe(failureSignature(`${head} tail two`));
  });

  it("falls back to the last 30 lines when no line looks like a failure", () => {
    const filler = Array.from({ length: 40 }, (_, i) => `step ${i + 1}`);
    const base = [...filler, "Killed"].join("\n");
    const sig = failureSignature(base);
    expect(sig).toMatch(/^[0-9a-f]{12}$/);
    // Lines before the last 30 don't matter...
    expect(failureSignature(["something different", ...filler.slice(1), "Killed"].join("\n"))).toBe(sig);
    // ...the last 30 do.
    expect(failureSignature([...filler, "Terminated"].join("\n"))).not.toBe(sig);
  });

  it("caps the kept failure lines at 60", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `Error: case ${String(i).padStart(3, "0")}`);
    const sig = failureSignature(lines.join("\n"));
    // Sorted, the last 20 lines fall outside the kept 60: changing them does not change the signature.
    const changedTail = [...lines.slice(0, 60), ...Array.from({ length: 20 }, (_, i) => `Error: zzz ${i}`)];
    expect(failureSignature(changedTail.join("\n"))).toBe(sig);
    const changedHead = ["Error: aaa", ...lines.slice(1)];
    expect(failureSignature(changedHead.join("\n"))).not.toBe(sig);
  });
});

// ───────────────────────────── Globs ─────────────────────────────

describe("matchesGlob", () => {
  it.each([
    ["tests/a.test.ts", "tests/**", true],
    ["tests/unit/deep/a.test.ts", "tests/**", true],
    ["src/tests/a.test.ts", "tests/**", false],
    ["testsuite/a.ts", "tests/**", false],
    ["a.test.ts", "**/*.test.ts", true],
    ["src/lib/a.test.ts", "**/*.test.ts", true],
    ["src/lib/a.test.tsx", "**/*.test.ts", false],
    ["src/a.ts", "src/*.ts", true],
    ["src/x/a.ts", "src/*.ts", false],
    ["src/a/b/c/z.ts", "src/**/z.ts", true],
    ["src/z.ts", "src/**/z.ts", true],
    ["e2e/a1.spec.ts", "e2e/a?.spec.ts", true],
    ["e2e/a12.spec.ts", "e2e/a?.spec.ts", false],
    ["e2e/a/.spec.ts", "e2e/a?.spec.ts", false],
    ["src/a.spec.tsx", "**/*.{test,spec}.{ts,tsx}", true],
    ["src/a.test.ts", "**/*.{test,spec}.{ts,tsx}", true],
    ["src/a.e2e.ts", "**/*.{test,spec}.{ts,tsx}", false],
    ["tests/a.ts", "./tests/**", true],
    ["tests/a.ts", "/tests/**", true],
    ["tests/a.ts", "tests/", true],
    ["anything/at/all.ts", "**", true],
    ["tests/a.ts", "{tests/**,e2e/**}", true],
    ["tests/a/b.ts", "{tests/**,e2e/**}", true],
    ["e2e/x/y/z.spec.ts", "{tests/**,e2e/**}", true],
    ["src/tests/a.ts", "{tests/**,e2e/**}", false],
    ["src/a/b.test.ts", "{**/*.test.ts,e2e/**}", true],
    ["e2e/a/b.ts", "{**/*.test.ts,e2e/**}", true],
    ["tests/unit/a.ts", "tests/{unit/**,e2e}", true],
    ["tests/e2e/a.ts", "tests/{unit/**,e2e}", false],
    ["tests/a**b/c.ts", "tests/{a**b,x}/c.ts", true],
    ["tests/a/b/c.ts", "tests/{a**b,x}/c.ts", false],
  ])("%s vs %s → %s", (path, glob, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected);
  });

  it("matches a slash-less glob against any path segment, like .gitignore", () => {
    expect(matchesGlob("src/components/Button.test.tsx", "*.test.tsx")).toBe(true);
    expect(matchesGlob("Button.test.tsx", "*.test.tsx")).toBe(true);
    expect(matchesGlob("e2e/todo.spec.ts", "e2e")).toBe(true);
    expect(matchesGlob("packages/web/__tests__/a.ts", "__tests__")).toBe(true);
    expect(matchesGlob("src/e2e-helpers.ts", "e2e")).toBe(false);
  });

  it("does not match the directory itself for dir/**", () => {
    expect(matchesGlob("tests", "tests/**")).toBe(false);
  });

  it("treats regex metacharacters and unbalanced braces literally", () => {
    expect(matchesGlob("tests/a+b(1).ts", "tests/a+b(1).ts")).toBe(true);
    expect(matchesGlob("tests/aab1.ts", "tests/a+b(1).ts")).toBe(false);
    expect(matchesGlob("tests/x.ts", "tests/[x].ts")).toBe(false);
    expect(matchesGlob("tests/{a.ts", "tests/{a.ts")).toBe(true);
    expect(matchesGlob("tests/a}.ts", "tests/a}.ts")).toBe(true);
  });

  it("accepts paths written with a leading ./", () => {
    expect(matchesGlob("./tests/a.ts", "tests/**")).toBe(true);
  });
});

describe("isTestPath", () => {
  const globs = ["tests/**", "e2e/**", "**/*.test.ts"];

  it("is true when any glob matches", () => {
    expect(isTestPath("tests/unit/a.ts", globs)).toBe(true);
    expect(isTestPath("e2e/login.spec.ts", globs)).toBe(true);
    expect(isTestPath("src/lib/math.test.ts", globs)).toBe(true);
  });

  it("is false otherwise, and for an empty glob list", () => {
    expect(isTestPath("src/lib/math.ts", globs)).toBe(false);
    expect(isTestPath("tests/unit/a.ts", [])).toBe(false);
  });
});

// ───────────────────────────── hashFiles / checkFrozen ─────────────────────────────

describe("hashFiles and checkFrozen", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeTempDir();
    mkdirSync(join(repo, "tests/unit"), { recursive: true });
    writeFileSync(join(repo, "tests/unit/b.test.ts"), "expect(b).toBe(2);\n");
    writeFileSync(join(repo, "tests/a.test.ts"), "expect(a).toBe(1);\n");
  });

  it("hashes files by repo-relative path, sorted and de-duplicated", async () => {
    const frozen = await hashFiles(repo, ["tests/unit/b.test.ts", "./tests/a.test.ts", join(repo, "tests/a.test.ts")]);
    expect(frozen).toEqual([
      { path: "tests/a.test.ts", sha256: sha256("expect(a).toBe(1);\n") },
      { path: "tests/unit/b.test.ts", sha256: sha256("expect(b).toBe(2);\n") },
    ]);
  });

  it("skips paths that are missing or are directories", async () => {
    const frozen = await hashFiles(repo, ["tests/a.test.ts", "tests/missing.test.ts", "tests/unit"]);
    expect(frozen.map((f) => f.path)).toEqual(["tests/a.test.ts"]);
  });

  it("rejects paths outside the repository", async () => {
    await expect(hashFiles(repo, ["../outside.ts"])).rejects.toThrow(/outside|inside the repository/);
    await expect(hashFiles(repo, ["/etc/hostname"])).rejects.toThrow(/inside the repository/);
    await expect(hashFiles(repo, ["."])).rejects.toThrow(/inside the repository/);
  });

  it("returns [] for no paths", async () => {
    expect(await hashFiles(repo, [])).toEqual([]);
  });

  it("is ok while the frozen files are unchanged", async () => {
    const frozen = await hashFiles(repo, ["tests/a.test.ts", "tests/unit/b.test.ts"]);
    expect(await checkFrozen(repo, frozen)).toEqual({ ok: true, modified: [], missing: [] });
  });

  it("reports modified and missing files", async () => {
    const frozen = await hashFiles(repo, ["tests/a.test.ts", "tests/unit/b.test.ts"]);
    writeFileSync(join(repo, "tests/a.test.ts"), "expect(true).toBe(true);\n");
    rmSync(join(repo, "tests/unit/b.test.ts"));
    expect(await checkFrozen(repo, frozen)).toEqual({
      ok: false,
      modified: ["tests/a.test.ts"],
      missing: ["tests/unit/b.test.ts"],
    });
  });

  it("treats a frozen file replaced by a directory as missing", async () => {
    const frozen = await hashFiles(repo, ["tests/a.test.ts"]);
    rmSync(join(repo, "tests/a.test.ts"));
    mkdirSync(join(repo, "tests/a.test.ts"));
    expect(await checkFrozen(repo, frozen)).toEqual({ ok: false, modified: [], missing: ["tests/a.test.ts"] });
  });

  it("detects a whitespace-only edit", async () => {
    const frozen = await hashFiles(repo, ["tests/a.test.ts"]);
    writeFileSync(join(repo, "tests/a.test.ts"), "expect(a).toBe(1);\n\n");
    expect((await checkFrozen(repo, frozen)).modified).toEqual(["tests/a.test.ts"]);
  });

  it("is ok for an empty frozen list", async () => {
    expect(await checkFrozen(repo, [])).toEqual({ ok: true, modified: [], missing: [] });
  });

  it("reports a frozen file replaced by a FIFO as modified, without blocking on it", async () => {
    const frozen = await hashFiles(repo, ["tests/a.test.ts"]);
    rmSync(join(repo, "tests/a.test.ts"));
    execFileSync("mkfifo", [join(repo, "tests/a.test.ts")]);
    expect(await checkFrozen(repo, frozen)).toEqual({ ok: false, modified: ["tests/a.test.ts"], missing: [] });
  });

  it("reports a frozen file replaced by a symlink as modified, whatever it points to", async () => {
    const frozen = await hashFiles(repo, ["tests/a.test.ts", "tests/unit/b.test.ts"]);
    const original = readFileSync(join(repo, "tests/a.test.ts"));
    writeFileSync(join(repo, "copy.ts"), original);
    rmSync(join(repo, "tests/a.test.ts"));
    symlinkSync("../copy.ts", join(repo, "tests/a.test.ts")); // same content, but now a link the agent controls
    rmSync(join(repo, "tests/unit/b.test.ts"));
    symlinkSync("/dev/zero", join(repo, "tests/unit/b.test.ts")); // would never finish reading
    expect(await checkFrozen(repo, frozen)).toEqual({
      ok: false,
      modified: ["tests/a.test.ts", "tests/unit/b.test.ts"],
      missing: [],
    });
  });

  it("reports a symlink loop as modified instead of throwing", async () => {
    const frozen = await hashFiles(repo, ["tests/a.test.ts"]);
    rmSync(join(repo, "tests/a.test.ts"));
    symlinkSync("a.test.ts", join(repo, "tests/a.test.ts"));
    expect(await checkFrozen(repo, frozen)).toEqual({ ok: false, modified: ["tests/a.test.ts"], missing: [] });
  });

  it("hashes only regular files, skipping symlinks and FIFOs", async () => {
    symlinkSync("a.test.ts", join(repo, "tests/link.test.ts"));
    execFileSync("mkfifo", [join(repo, "tests/pipe.test.ts")]);
    const frozen = await hashFiles(repo, ["tests/a.test.ts", "tests/link.test.ts", "tests/pipe.test.ts"]);
    expect(frozen.map((f) => f.path)).toEqual(["tests/a.test.ts"]);
  });

  it("hashes files larger than the read buffer correctly", async () => {
    const big = "expect(x).toBe(1);\n".repeat(150_000); // ~2.8 MB, several 1 MiB chunks
    writeFileSync(join(repo, "tests/big.test.ts"), big);
    expect(await hashFiles(repo, ["tests/big.test.ts"])).toEqual([{ path: "tests/big.test.ts", sha256: sha256(big) }]);
  });
});

// ───────────────────────────── scanAntiCheat ─────────────────────────────

/** A one-hunk git diff for `path`; body lines start with " ", "+" or "-". Hunk counts are computed. */
function fileDiff(path: string, body: string[], kind: "modified" | "new" | "deleted" = "modified"): string {
  const oldCount = body.filter((l) => l.startsWith(" ") || l.startsWith("-")).length;
  const newCount = body.filter((l) => l.startsWith(" ") || l.startsWith("+")).length;
  const header = [`diff --git a/${path} b/${path}`];
  if (kind === "new") header.push("new file mode 100644", "index 0000000..e69de29", "--- /dev/null", `+++ b/${path}`);
  else if (kind === "deleted") header.push("deleted file mode 100644", "index e69de29..0000000", `--- a/${path}`, "+++ /dev/null");
  else header.push("index 83db48f..bf269f4 100644", `--- a/${path}`, `+++ b/${path}`);
  const oldStart = kind === "new" ? 0 : 1;
  const newStart = kind === "deleted" ? 0 : 1;
  return [...header, `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@ describe("todos", () => {`, ...body].join("\n");
}

const TEST_GLOBS = ["tests/**"];

describe("scanAntiCheat", () => {
  it("returns [] for an empty diff", () => {
    expect(scanAntiCheat("", TEST_GLOBS)).toEqual([]);
  });

  it("flags a skipped test added to a test file", () => {
    const diff = fileDiff("tests/unit/todo.test.ts", [
      ' import { addTodo } from "../../src/todo";',
      '-  it("adds a todo", () => {',
      '+  it.skip("adds a todo", () => {',
      "     expect(addTodo('x')).toHaveLength(1);",
      "   });",
    ]);
    expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([
      { file: "tests/unit/todo.test.ts", line: 'it.skip("adds a todo", () => {', rule: "test-skip", severity: "blocker" },
    ]);
  });

  it.each([
    ['describe.skip("todos", () => {', "test-skip"],
    ['it.skipIf(process.env.CI)("adds", () => {', "test-skip"],
    ['xit("adds a todo", () => {', "test-skip"],
    ['xdescribe("todos", () => {', "test-skip"],
    ['xtest("adds a todo", () => {', "test-skip"],
    ['@pytest.mark.skip(reason="flaky")', "test-skip"],
    ['@pytest.mark.skipif(sys.platform == "linux", reason="x")', "test-skip"],
    ['pytest.skip("not ready")', "test-skip"],
    ["it.skip.each([[1, 2]])('adds %i', (a, b) => {", "test-skip"],
    ["describe.skip.each([1, 2])('todos %i', () => {", "test-skip"],
    ["test.skip.for([1, 2])('adds %i', () => {", "test-skip"],
    ["xit.each([1, 2])('adds %i', () => {", "test-skip"],
    ["xdescribe.each([1, 2])('todos %i', () => {", "test-skip"],
    ["it.runIf(false)('adds', () => {", "test-skip"],
    ["describe.runIf(process.env.NEVER)('todos', () => {", "test-skip"],
    ["pytestmark = pytest.mark.skip", "test-skip"],
    ['pytest.importorskip("numpy")', "test-skip"],
    ['@unittest.skipUnless(sys.platform == "win32", "windows")', "test-skip"],
    ['it.only("adds a todo", () => {', "test-only"],
    ['test.describe.only("todos", () => {', "test-only"],
    ["it.only.each([1, 2])('adds %i', () => {", "test-only"],
    ['it.todo("adds a todo");', "test-todo"],
    ['test.todo("adds a todo");', "test-todo"],
    ['test.fixme("adds a todo", async ({ page }) => {', "test-todo"],
    ["@pytest.mark.xfail", "expected-failure"],
    ["pytestmark = pytest.mark.xfail", "expected-failure"],
    ['pytest.xfail("broken")', "expected-failure"],
    ["@unittest.expectedFailure", "expected-failure"],
    ["test.fail();", "expected-failure"],
    ['it.fails("adds a todo", () => {', "expected-failure"],
    ["expect(true).toBe(true);", "vacuous-assertion"],
    ["expect( true ).toBeTruthy();", "vacuous-assertion"],
    ["assert True", "vacuous-assertion"],
    ["assert(true);", "vacuous-assertion"],
    ["assert.ok(true);", "vacuous-assertion"],
  ])("flags %s in a test file as %s", (line, rule) => {
    const diff = fileDiff("tests/e2e/todo.spec.ts", [" // context", `+  ${line}`]);
    const findings = scanAntiCheat(diff, TEST_GLOBS);
    expect(findings).toEqual([{ file: "tests/e2e/todo.spec.ts", line, rule, severity: "blocker" }]);
  });

  it("does not apply test-only rules to normal source files", () => {
    const diff = fileDiff("src/lexer.ts", [
      " export class Lexer {",
      "+  skip(n: number) { this.pos += n; return this; }",
      "+  next() { return this.skip(1).peek(); }",
      "+  first() { return this.tokens.only(0); }",
      "+  check() { expect(true); assert(true); }",
      "+  quit() { process.exit(1); }",
      " }",
    ]);
    expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([]);
  });

  it("does not mistake exit( or similar words in a test file for x-prefixed tests", () => {
    const diff = fileDiff("tests/unit/cli.test.ts", [
      ' it("exits", () => {',
      "+  const spy = vi.spyOn(process, 'exit');",
      "+  cli.exit(1); context.exit();",
      "+  expect(spy).toHaveBeenCalledWith(1);",
      " });",
    ]);
    expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([]);
  });

  it("ignores removed skips (un-skipping a test is fine)", () => {
    const diff = fileDiff("tests/unit/todo.test.ts", ['-  it.skip("adds a todo", () => {', '+  it("adds a todo", () => {']);
    expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([]);
  });

  it("ignores a pre-existing skip that was only moved or re-indented", () => {
    const diff = fileDiff("tests/unit/todo.test.ts", [
      '-it.skip("legacy behaviour", () => {});',
      " describe('todos', () => {",
      '+  it.skip("legacy behaviour", () => {});',
      " });",
    ]);
    expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([]);
  });

  it("ignores a pre-existing skip in a test file that was renamed (a deletion plus an addition)", () => {
    const body = ["it.skip('legacy', () => {});", "it('works', () => {", "});"];
    const diff = [
      fileDiff("tests/old.test.ts", body.map((l) => `-${l}`), "deleted"),
      fileDiff("tests/new.test.ts", body.map((l) => `+${l}`), "new"),
    ].join("\n");
    expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([]);
  });

  it("still flags each extra copy of a moved skip, and skips moved into tests from non-test files", () => {
    const skip = "it.skip('legacy', () => {});";
    const diff = [
      fileDiff("tests/old.test.ts", [`-${skip}`], "deleted"),
      fileDiff("tests/new.test.ts", [`+${skip}`, `+${skip}`], "new"),
      fileDiff("docs/testing.md", [`-${skip}`]),
      fileDiff("tests/other.test.ts", [`+${skip}`]),
    ].join("\n");
    expect(scanAntiCheat(diff, TEST_GLOBS).map((f) => [f.file, f.rule])).toEqual([
      ["tests/new.test.ts", "test-skip"],
      ["tests/other.test.ts", "test-skip"],
    ]);
  });

  it("uses testGlobs and conventional test names to decide what a test file is", () => {
    const skip = ['+it.skip("x", () => {});'];
    expect(scanAntiCheat(fileDiff("cypress/e2e/a.cy.ts", skip), ["cypress/**"])).toHaveLength(1);
    expect(scanAntiCheat(fileDiff("cypress/e2e/a.cy.ts", skip), TEST_GLOBS)).toEqual([]);
    for (const path of ["src/components/Button.test.tsx", "src/__tests__/util.ts", "app/test_models.py", "app/models_test.py"]) {
      expect(scanAntiCheat(fileDiff(path, skip), TEST_GLOBS).map((f) => f.file)).toEqual([path]);
    }
  });

  describe("assertion removal", () => {
    const expects = (n: number, sign: "+" | "-") => Array.from({ length: n }, (_, i) => `${sign}  expect(list[${i}]).toBe(${i});`);

    it("flags a net removal of more than 2 assertion lines in test files", () => {
      const diff = fileDiff("tests/unit/todo.test.ts", [' it("lists", () => {', ...expects(3, "-"), " });"]);
      expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([
        {
          file: "tests/unit/todo.test.ts",
          line: "3 assertion line(s) removed (net 3 across test files)",
          rule: "assertions-removed",
          severity: "blocker",
        },
      ]);
    });

    it("allows removing up to 2 more assertion lines than were added", () => {
      expect(scanAntiCheat(fileDiff("tests/a.test.ts", expects(2, "-")), TEST_GLOBS)).toEqual([]);
      expect(scanAntiCheat(fileDiff("tests/a.test.ts", [...expects(4, "-"), ...expects(2, "+")]), TEST_GLOBS)).toEqual([]);
    });

    it("adds up removals spread over several test files", () => {
      const diff = [fileDiff("tests/a.test.ts", expects(2, "-")), fileDiff("tests/b.test.ts", expects(1, "-"))].join("\n");
      expect(scanAntiCheat(diff, TEST_GLOBS).map((f) => [f.file, f.rule])).toEqual([
        ["tests/a.test.ts", "assertions-removed"],
        ["tests/b.test.ts", "assertions-removed"],
      ]);
    });

    it("lets assertions move between test files", () => {
      const diff = [fileDiff("tests/a.test.ts", expects(5, "-")), fileDiff("tests/b.test.ts", expects(5, "+"))].join("\n");
      expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([]);
    });

    it("does not let new, different assertions in another test file make up for deleted ones", () => {
      const removed = Array.from({ length: 6 }, (_, i) => `-  expect(legacy(${i})).toBe(${i});`);
      const added = Array.from({ length: 6 }, (_, i) => `+  expect(newFeature(${i})).toBeDefined();`);
      const diff = [fileDiff("tests/unit/legacy.test.ts", removed), fileDiff("src/lib/feature.test.ts", added, "new")].join("\n");
      expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([
        {
          file: "tests/unit/legacy.test.ts",
          line: "6 assertion line(s) removed (net 6 across test files)",
          rule: "assertions-removed",
          severity: "blocker",
        },
      ]);
    });

    it("lets assertions be rewritten in place", () => {
      const rewritten = Array.from({ length: 4 }, (_, i) => `+  expect(items[${i}]).toBe(${i});`);
      expect(scanAntiCheat(fileDiff("tests/a.test.ts", [...expects(4, "-"), ...rewritten]), TEST_GLOBS)).toEqual([]);
    });

    it("counts a moved assertion once, even when its new file also rewrites others", () => {
      // b.test.ts receives a's assertions verbatim and also rewrites 3 of its own: nothing is lost.
      const diff = [
        fileDiff("tests/a.test.ts", expects(3, "-")),
        fileDiff("tests/b.test.ts", [
          ...expects(3, "+"),
          ...["-  expect(x).toBe(1);", "-  expect(y).toBe(2);", "-  expect(z).toBe(3);"],
          ...["+  expect(x2).toBe(1);", "+  expect(y2).toBe(2);", "+  expect(z2).toBe(3);"],
        ]),
      ].join("\n");
      expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([]);
    });

    it("treats commented-out assertions as removed", () => {
      const diff = fileDiff("src/math.test.ts", [
        ...["-  expect(add(1, 2)).toBe(3);", "-  expect(add(2, 2)).toBe(4);", "-  expect(add(0, 0)).toBe(0);"],
        ...["+  // expect(add(1, 2)).toBe(3);", "+  /* expect(add(2, 2)).toBe(4); */", "+  # assert add(0, 0) == 0"],
      ]);
      expect(scanAntiCheat(diff, TEST_GLOBS).map((f) => [f.file, f.rule, f.line])).toEqual([
        ["src/math.test.ts", "assertions-removed", "3 assertion line(s) removed (net 3 across test files)"],
      ]);
    });

    it("allows deleting assertions that were already commented out", () => {
      const commentedOut = ["-  // expect(a).toBe(1);", "-  // expect(b).toBe(2);", "-  # assert c == 3", "-   * expect(d)"];
      const diff = fileDiff("tests/a.test.ts", commentedOut);
      expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([]);
    });

    it("flags deleting a test file full of assertions", () => {
      const diff = fileDiff("tests/unit/todo.test.ts", ['-it("x", () => {', ...expects(4, "-"), "-});"], "deleted");
      expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([
        expect.objectContaining({ file: "tests/unit/todo.test.ts", rule: "assertions-removed", severity: "blocker" }),
      ]);
    });

    it("counts Python asserts", () => {
      const diff = fileDiff("tests/test_todo.py", ["-    assert len(todos) == 1", "-    assert todos[0].title == 'x'", "-    assert todos[0].done is False"]);
      expect(scanAntiCheat(diff, TEST_GLOBS).map((f) => f.rule)).toEqual(["assertions-removed"]);
    });

    it("ignores assertion removals in non-test files", () => {
      expect(scanAntiCheat(fileDiff("src/invariants.ts", expects(5, "-")), TEST_GLOBS)).toEqual([]);
    });
  });

  describe("test discovery changes", () => {
    it("flags testIgnore in any file", () => {
      const diff = fileDiff("playwright.config.ts", [" export default defineConfig({", '+  testIgnore: ["**/todo.spec.ts"],']);
      expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([
        { file: "playwright.config.ts", line: 'testIgnore: ["**/todo.spec.ts"],', rule: "test-discovery", severity: "blocker" },
      ]);
    });

    it.each([
      ["vitest.config.ts", '    exclude: ["tests/unit/todo.test.ts"],'],
      ["vitest.config.mts", "    exclude: [...configDefaults.exclude, 'tests/unit/**'],"],
      ["vitest.unit.config.ts", "    exclude: ['tests/**'],"],
      ["vite.config.ts", "    exclude: ['tests/**'],"],
      ["jest.config.json", '  "exclude": ["tests"],'],
      ["playwright.config.ts", "  exclude: ['e2e/**'],"],
    ])("flags exclude: in test runner config %s", (file, line) => {
      const findings = scanAntiCheat(fileDiff(file, [`+${line}`]), TEST_GLOBS);
      expect(findings).toEqual([{ file, line: line.trim(), rule: "test-discovery", severity: "blocker" }]);
    });

    it("does not flag exclude: outside test runner configs", () => {
      expect(scanAntiCheat(fileDiff("src/filters.ts", ["+  exclude: ['archived'],"]), TEST_GLOBS)).toEqual([]);
      expect(scanAntiCheat(fileDiff("tsconfig.json", ['+  "exclude": ["node_modules"]']), TEST_GLOBS)).toEqual([]);
    });

    it.each([
      ["package.json", '    "test": "vitest run --passWithNoTests",'],
      ["vitest.config.ts", "    passWithNoTests: true,"],
      ["jest.config.json", '  "passWithNoTests": true,'],
      ["jest.config.js", "  testPathIgnorePatterns: ['/tests/unit/'],"],
      ["scripts/mc-test.mjs", "const args = ['playwright', 'test', '--passWithNoTests'];"],
    ])("flags passWithNoTests / ignore patterns in %s", (file, line) => {
      expect(scanAntiCheat(fileDiff(file, [`+${line}`]), TEST_GLOBS).map((f) => f.rule)).toEqual(["test-discovery"]);
    });

    it("does not flag passWithNoTests: false", () => {
      expect(scanAntiCheat(fileDiff("vitest.config.ts", ["+    passWithNoTests: false,"]), TEST_GLOBS)).toEqual([]);
    });

    const rulesAndLines = (diff: string) => scanAntiCheat(diff, TEST_GLOBS).map((f) => [f.file, f.rule, f.line]);

    it("flags narrowing vitest include, Playwright testDir/testMatch and Jest testRegex", () => {
      const diff = [
        fileDiff("vitest.config.ts", [
          " export default defineConfig({",
          "   test: {",
          '-    include: ["tests/unit/**/*.test.ts"],',
          '+    include: ["tests/unit/**/todo.test.ts"],',
          "   },",
        ]),
        fileDiff("playwright.config.ts", [
          " export default defineConfig({",
          '-  testDir: "tests/e2e",',
          '-  testMatch: "**/*.spec.ts",',
          '+  testDir: "tests/e2e/smoke",',
          '+  testMatch: "**/login.spec.ts",',
          '   reporter: "line",',
        ]),
        fileDiff("jest.config.js", ["-  testRegex: '\\\\.test\\\\.ts$',", "+  testRegex: 'todo\\\\.test\\\\.ts$',"]),
      ].join("\n");
      expect(rulesAndLines(diff)).toEqual([
        ["vitest.config.ts", "test-discovery", 'include: ["tests/unit/**/todo.test.ts"],'],
        ["playwright.config.ts", "test-discovery", 'testDir: "tests/e2e/smoke",'],
        ["playwright.config.ts", "test-discovery", 'testMatch: "**/login.spec.ts",'],
        ["jest.config.js", "test-discovery", "testRegex: 'todo\\\\.test\\\\.ts$',"],
      ]);
    });

    it("flags a Playwright grep filter", () => {
      const diff = fileDiff("playwright.config.ts", [" export default defineConfig({", "+  grep: /@smoke/,", '   testDir: "tests/e2e",']);
      expect(rulesAndLines(diff)).toEqual([["playwright.config.ts", "test-discovery", "grep: /@smoke/,"]]);
    });

    it("flags entries added to an existing multi-line exclude or testIgnore list", () => {
      const diff = [
        fileDiff("vitest.config.ts", [
          "   test: {",
          "     exclude: [",
          "       ...configDefaults.exclude,",
          "+      'tests/unit/todo.test.ts',",
          "     ],",
        ]),
        fileDiff("playwright.config.ts", ["   testIgnore: [", "     '**/fixtures/**',", "+    '**/todo.spec.ts',", "   ],"]),
      ].join("\n");
      expect(rulesAndLines(diff)).toEqual([
        ["vitest.config.ts", "test-discovery", "'tests/unit/todo.test.ts',"],
        ["playwright.config.ts", "test-discovery", "'**/todo.spec.ts',"],
      ]);
    });

    it("flags a new exclude list once, by its key line", () => {
      const diff = fileDiff("vitest.config.ts", [
        "   test: {",
        "+    exclude: [",
        "+      'tests/unit/a.test.ts',",
        "+      'tests/unit/b.test.ts',",
        "+    ],",
        "   },",
      ]);
      expect(rulesAndLines(diff)).toEqual([["vitest.config.ts", "test-discovery", "exclude: ["]]);
    });

    it("flags entries removed from an existing include list", () => {
      const diff = fileDiff("vitest.config.ts", [
        "   test: {",
        "     include: [",
        "       'tests/unit/**/*.test.ts',",
        "-      'tests/integration/**/*.test.ts',",
        "     ],",
      ]);
      expect(rulesAndLines(diff)).toEqual([
        ["vitest.config.ts", "test-discovery", "(removed) 'tests/integration/**/*.test.ts',"],
      ]);
    });

    it("does not flag re-indented include entries, added include entries, or removing a whole include list", () => {
      const reindented = fileDiff("vitest.config.ts", [
        "   test: {",
        "     include: [",
        "-    'tests/unit/**/*.test.ts',",
        "+      'tests/unit/**/*.test.ts',",
        "+      'tests/integration/**/*.test.ts',",
        "     ],",
      ]);
      expect(scanAntiCheat(reindented, TEST_GLOBS)).toEqual([]);
      const wholeList = fileDiff("vitest.config.ts", [
        "   test: {",
        "-    include: [",
        "-      'tests/unit/**',",
        "-    ],",
        "     globals: true,",
      ]);
      expect(scanAntiCheat(wholeList, TEST_GLOBS)).toEqual([]);
    });

    it("does not flag include/exclude in coverage, optimizeDeps and other non-test sections", () => {
      const diff = [
        fileDiff("vitest.config.ts", [
          "   test: {",
          "     coverage: {",
          "       provider: 'v8',",
          "+      exclude: ['src/generated/**'],",
          "+      include: ['src/**/*.{ts,tsx}'],",
          "     },",
        ]),
        fileDiff("vite.config.ts", [
          " export default defineConfig({",
          "   optimizeDeps: {",
          "+    exclude: ['@electric-sql/pglite'],",
          "   },",
        ]),
        fileDiff("vitest.workspace.ts", [
          "   test: {",
          "     coverage: {",
          "       include: [",
          "-        'src/legacy/**',",
          "+        'src/app/**',",
          "       ],",
        ]),
        fileDiff("vitest.unit.config.ts", ["+  test: { coverage: { exclude: ['src/gen/**'] } },"]),
      ].join("\n");
      expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([]);
    });

    it("flags a one-line test section that excludes tests", () => {
      const diff = fileDiff("vitest.config.ts", ["+  test: { globals: true, exclude: ['tests/unit/todo.test.ts'] },"]);
      expect(rulesAndLines(diff)).toEqual([
        ["vitest.config.ts", "test-discovery", "test: { globals: true, exclude: ['tests/unit/todo.test.ts'] },"],
      ]);
    });

    it("is not confused by brackets inside strings and comments", () => {
      const diff = fileDiff("vitest.config.ts", [
        "   test: {",
        "     include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'], // (unit tests [all])",
        "     exclude: [",
        "       '**/{node_modules,dist}/**',",
        "+      'tests/**/*.{flaky,slow}.test.ts',",
        "     ],",
      ]);
      expect(rulesAndLines(diff)).toEqual([["vitest.config.ts", "test-discovery", "'tests/**/*.{flaky,slow}.test.ts',"]]);
    });

    it("flags a discovery key whose section is out of view, but not unrelated list entries", () => {
      expect(rulesAndLines(fileDiff("vitest.config.ts", ["+      include: ['tests/unit/todo.test.ts'],"]))).toEqual([
        ["vitest.config.ts", "test-discovery", "include: ['tests/unit/todo.test.ts'],"],
      ]);
      const plugins = fileDiff("vite.config.ts", ["   plugins: [", "     react(),", "+    tsconfigPaths(),", "   ],"]);
      expect(scanAntiCheat(plugins, TEST_GLOBS)).toEqual([]);
    });
  });

  it.each([
    ["// @ts-nocheck", "ts-nocheck"],
    ["// eslint-disable-next-line @typescript-eslint/no-explicit-any", "eslint-disable"],
    ["/* eslint-disable */", "eslint-disable"],
    ["/* istanbul ignore next */", "istanbul-ignore"],
  ])("warns about %s", (line, rule) => {
    expect(scanAntiCheat(fileDiff("src/app/page.tsx", [`+${line}`]), TEST_GLOBS)).toEqual([
      { file: "src/app/page.tsx", line, rule, severity: "warn" },
    ]);
  });

  it("never treats file headers as added or removed lines", () => {
    // Without hunk tracking, "+++ b/src/testIgnore.ts" would look like an added line mentioning testIgnore.
    const diff = fileDiff("src/testIgnore.ts", ["+export const x = 1;"], "new");
    expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([]);
  });

  it('reads "+++"/"---" lines inside a hunk as content', () => {
    // An added line "++i; it.only(...)" appears as "+++i; ..." and a removed "--x" as "---x".
    const diff = fileDiff("tests/a.test.ts", [" let i = 0;", "---x;", "+++i; it.only('x', () => {});"]);
    expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([
      { file: "tests/a.test.ts", line: "++i; it.only('x', () => {});", rule: "test-only", severity: "blocker" },
    ]);
  });

  it("attributes findings to the right file in a multi-file diff with new, deleted and renamed files", () => {
    const diff = [
      fileDiff("src/todo.ts", ["+export function addTodo() {}", "+// eslint-disable-next-line no-console"], "new"),
      "diff --git a/tests/old.test.ts b/tests/renamed.test.ts",
      "similarity index 100%",
      "rename from tests/old.test.ts",
      "rename to tests/renamed.test.ts",
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
      fileDiff("tests/e2e/todo.spec.ts", [" test('adds', async ({ page }) => {", "+  test.fixme();", " });"]),
      fileDiff("tests/unit/gone.test.ts", ["-it('gone', () => {});"], "deleted"),
    ].join("\n");
    expect(scanAntiCheat(diff, TEST_GLOBS).map((f) => [f.file, f.rule, f.severity])).toEqual([
      ["src/todo.ts", "eslint-disable", "warn"],
      ["tests/e2e/todo.spec.ts", "test-todo", "blocker"],
    ]);
  });

  it("parses plain unified diffs without git headers", () => {
    const diff = [
      "--- a/tests/a.test.ts\t2026-10-09 21:00:00.000000000 +0200",
      "+++ b/tests/a.test.ts\t2026-10-09 21:05:00.000000000 +0200",
      "@@ -1,2 +1,2 @@",
      " describe('a', () => {",
      "-  it('works', () => {});",
      "+  it.only('works', () => {});",
      "--- a/src/b.ts\t2026-10-09 21:00:00.000000000 +0200",
      "+++ b/src/b.ts\t2026-10-09 21:05:00.000000000 +0200",
      "@@ -1 +1 @@",
      "-export const b = 1;",
      "+export const b = 2; // @ts-nocheck",
    ].join("\n");
    expect(scanAntiCheat(diff, TEST_GLOBS).map((f) => [f.file, f.rule])).toEqual([
      ["tests/a.test.ts", "test-only"],
      ["src/b.ts", "ts-nocheck"],
    ]);
  });

  it("handles quoted paths and CRLF diffs", () => {
    const diff = [
      'diff --git "a/tests/my \\"odd\\" file.test.ts" "b/tests/my \\"odd\\" file.test.ts"',
      '--- "a/tests/my \\"odd\\" file.test.ts"',
      '+++ "b/tests/my \\"odd\\" file.test.ts"',
      "@@ -1 +1 @@",
      "-it('a', () => {});",
      "+it.skip('a', () => {});",
    ].join("\r\n");
    expect(scanAntiCheat(diff, TEST_GLOBS)).toEqual([
      { file: 'tests/my "odd" file.test.ts', line: "it.skip('a', () => {});", rule: "test-skip", severity: "blocker" },
    ]);
  });

  it("survives a truncated diff and keeps the findings before the cut", () => {
    const diff = [
      "diff --git a/tests/a.test.ts b/tests/a.test.ts",
      "--- a/tests/a.test.ts",
      "+++ b/tests/a.test.ts",
      "@@ -1,10 +1,10 @@",
      "+it.only('a', () => {});",
      "[diff truncated: 48213 chars omitted]",
    ].join("\n");
    expect(scanAntiCheat(diff, TEST_GLOBS).map((f) => f.rule)).toEqual(["test-only"]);
  });

  it("stays fast on huge adversarial lines and deep nesting", () => {
    const started = Date.now();
    const diff = [
      fileDiff("tests/a.test.ts", [
        `+${".skip".repeat(40_000)}`,
        `+'${"\\'".repeat(20_000)}\\`,
        `+${"x".repeat(100_000)}; it.only('x', () => {});`,
      ]),
      fileDiff("vitest.config.ts", [
        "   test: {",
        ...Array.from({ length: 500 }, () => `+${"(".repeat(2000)}`),
        `+${"include: ".repeat(20_000)}`,
        `+${" exclude: [".repeat(10_000)}`,
      ]),
      fileDiff("playwright.config.ts", [`+${" ".repeat(5000)}grep: /@smoke/,`]),
    ].join("\n");
    const findings = scanAntiCheat(diff, TEST_GLOBS);
    expect(Date.now() - started).toBeLessThan(3000);
    // Found even far into a line.
    expect(findings).toContainEqual(expect.objectContaining({ file: "tests/a.test.ts", rule: "test-only" }));
    expect(findings).toContainEqual(expect.objectContaining({ file: "vitest.config.ts", rule: "test-discovery" }));
    expect(findings).toContainEqual(expect.objectContaining({ file: "playwright.config.ts", line: "grep: /@smoke/," }));
  });

  it("trims finding lines and caps them at 200 characters", () => {
    const long = `it.skip("${"x".repeat(300)}", () => {});`;
    const [finding] = scanAntiCheat(fileDiff("tests/a.test.ts", [`+      ${long}`]), TEST_GLOBS);
    expect(finding?.line).toBe(long.slice(0, 200));
  });

  it("finds cheats in a diff produced by real git", () => {
    const repo = makeTempDir();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    mkdirSync(join(repo, "tests"));
    const original = [
      'import { expect, it } from "vitest";',
      'import { add } from "../src/math";',
      'it("adds", () => {',
      "  expect(add(1, 2)).toBe(3);",
      "  expect(add(2, 2)).toBe(4);",
      "  expect(add(0, 0)).toBe(0);",
      "});",
      "",
    ].join("\n");
    writeFileSync(join(repo, "tests/math.test.ts"), original);
    writeFileSync(join(repo, "vitest.config.ts"), "export default { test: {} };\n");
    git("add", "-A");
    git("commit", "-q", "-m", "tests");
    writeFileSync(
      join(repo, "tests/math.test.ts"),
      ['import { expect, it } from "vitest";', 'import { add } from "../src/math";', 'it.skip("adds", () => {', "});", ""].join("\n"),
    );
    writeFileSync(join(repo, "vitest.config.ts"), "export default { test: {\n  exclude: ['tests/math.test.ts'],\n} };\n");
    const findings = scanAntiCheat(git("diff", "HEAD"), TEST_GLOBS);
    expect(findings.map((f) => [f.file, f.rule])).toEqual([
      ["tests/math.test.ts", "test-skip"],
      ["vitest.config.ts", "test-discovery"],
      ["tests/math.test.ts", "assertions-removed"],
    ]);
  });
});

// ───────────────────────────── Verifier ─────────────────────────────

interface LogEntry {
  level: string;
  msg: string;
  data?: Record<string, unknown>;
}

function captureLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const log = (level: string) => (msg: string, data?: Record<string, unknown>) => entries.push({ level, msg, data });
  return { logger: { info: log("info"), warn: log("warn"), error: log("error") }, entries };
}

function config(full: string, extra: Partial<VerifyConfig> = {}): VerifyConfig {
  return { full, testGlobs: ["tests/**"], ...extra };
}

describe("Verifier", () => {
  let cwd: string;
  let logsDir: string;
  let verifier: Verifier;

  beforeEach(() => {
    cwd = makeTempDir("mc-verify-cwd-");
    logsDir = join(makeTempDir("mc-verify-logs-"), "logs");
    verifier = new Verifier({ logsDir, timeoutMs: 20_000 });
  });

  it("passes install immediately when no install command is configured", async () => {
    for (const install of [undefined, "", "   "]) {
      const result = await verifier.install(cwd, config("true", install === undefined ? {} : { install }));
      expect(result).toEqual({ ok: true, exitCode: 0, timedOut: false, durationMs: 0, outputTail: "", signature: "", logFile: "" });
    }
    expect(existsSync(logsDir)).toBe(false);
  });

  it("runs the install command with an install log", async () => {
    const result = await verifier.install(cwd, config("true", { install: "echo installing > installed.txt && echo done" }));
    expect(result.ok).toBe(true);
    expect(readFileSync(join(cwd, "installed.txt"), "utf8")).toBe("installing\n");
    expect(result.logFile).toBe(join(logsDir, "verify-install.log"));
    expect(result.outputTail).toContain("done");
  });

  it("reports a passing run with the full output in the log and no signature", async () => {
    const result = await verifier.runFull(cwd, config("echo lint ok; echo tests ok"), "full");
    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false, signature: "" });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.logFile).toBe(join(logsDir, "verify-full.log"));
    expect(result.outputTail.split("\n").slice(0, 2)).toEqual(["lint ok", "tests ok"]);
    const log = readFileSync(result.logFile, "utf8");
    expect(log).toContain("$ echo lint ok; echo tests ok");
    expect(log).toContain(`# cwd: ${cwd}`);
    expect(log).toContain("lint ok\ntests ok\n");
  });

  it("ignores the shell's login and rc files, which agents could rewrite outside the repository", async () => {
    const home = makeTempDir("mc-verify-home-");
    for (const file of [".bash_profile", ".profile", ".bashrc", ".bash_login"]) writeFileSync(join(home, file), "exit 0\n");
    vi.stubEnv("HOME", home);
    vi.stubEnv("BASH_ENV", join(home, ".profile"));
    const withHome = new Verifier({ logsDir, timeoutMs: 20_000 });
    const result = await withHome.runFull(cwd, config("echo running tests; exit 1"));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.outputTail).toContain("running tests");
  });

  it("reports a failing run with its exit code and a signature", async () => {
    const result = await verifier.runFull(cwd, config("echo 'FAIL tests/a.test.ts > adds'; echo 'AssertionError: expected 1 to be 2' >&2; exit 3"));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.signature).toMatch(/^[0-9a-f]{12}$/);
    expect(result.outputTail).toContain("FAIL tests/a.test.ts > adds");
    expect(result.outputTail).toContain("AssertionError: expected 1 to be 2");
    expect(result.outputTail).toContain("exit code 3");
  });

  it("gives a failing run without output a non-empty signature", async () => {
    const result = await verifier.runFull(cwd, config("exit 1"));
    expect(result.ok).toBe(false);
    expect(result.signature).toMatch(/^[0-9a-f]{12}$/);
  });

  it("tells apart failures whose output has no failure keywords, using their last lines", async () => {
    const outputs = [
      "echo '[warn] src/app/page.tsx'; echo '[warn] Code style issues found in the above file.'",
      "echo '[warn] src/lib/db.ts'; echo '[warn] src/lib/auth.ts'",
      "echo 'Killed'",
      "echo 'Segmentation fault (core dumped)'",
      "true",
    ];
    const signatures: string[] = [];
    for (const output of outputs) signatures.push((await verifier.runFull(cwd, config(`${output}; exit 1`))).signature);
    expect(new Set(signatures).size).toBe(outputs.length);
    for (const signature of signatures) expect(signature).toMatch(/^[0-9a-f]{12}$/);
    // The same keyword-free failure again is recognized as the same.
    expect((await verifier.runFull(cwd, config(`${outputs[2]}; exit 1`))).signature).toBe(signatures[2]);
  });

  it("bases the signature on failure lines when there are some, not on the exit status", async () => {
    const output = "echo 'Error: cannot find module ./db'";
    const exit1 = await verifier.runFull(cwd, config(`${output}; exit 1`));
    const exit2 = await verifier.runFull(cwd, config(`${output}; exit 2`));
    expect(exit2.signature).toBe(exit1.signature);
    expect(exit1.signature).toBe(failureSignature("Error: cannot find module ./db"));
  });

  it("gives the same signature to runs that differ only in noise, and different ones to different failures", async () => {
    const script = (message: string) =>
      [
        `dir=/tmp/run-$RANDOM$RANDOM/app`,
        `echo " FAIL  tests/unit/todo.test.ts > adds a todo"`,
        `echo "AssertionError: ${message}"`,
        `echo "  at $dir/tests/unit/todo.test.ts:$((RANDOM % 90 + 10)):$((RANDOM % 9 + 1))"`,
        `echo "Error: connect ECONNREFUSED 127.0.0.1:$((RANDOM % 20000 + 30000))"`,
        `echo "   Start at  $(date +%H:%M:%S)"`,
        `echo "   Duration  $RANDOM ms"`,
        "exit 1",
      ].join("\n");
    const first = await verifier.runFull(cwd, config(script("expected 1 to be 2")));
    const second = await verifier.runFull(cwd, config(script("expected 1 to be 2")));
    const different = await verifier.runFull(cwd, config(script("expected 'a' to be 'b'")));
    expect(first.signature).toMatch(/^[0-9a-f]{12}$/);
    expect(second.signature).toBe(first.signature);
    expect(different.signature).not.toBe(first.signature);
  });

  it("combines stdout and stderr and strips ANSI codes from the tail", async () => {
    const result = await verifier.runFull(cwd, config("echo out; echo err >&2; printf '\\033[31mred\\033[0m\\n'"));
    const lines = result.outputTail.split("\n");
    expect(lines).toEqual(expect.arrayContaining(["out", "err", "red"]));
    expect(result.outputTail).not.toContain("\x1b");
  });

  it("keeps only the last 200 lines in the tail while the log keeps everything", async () => {
    const result = await verifier.runFull(cwd, config("for i in $(seq 1 500); do echo line-$i; done; exit 1"));
    const lines = result.outputTail.split("\n");
    expect(lines).toHaveLength(200);
    expect(lines).toContain("line-500");
    expect(lines).not.toContain("line-301");
    expect(lines[0]).toBe("line-302");
    expect(lines[199]).toContain("exit code 1");
    const log = readFileSync(result.logFile, "utf8");
    expect(log).toContain("line-1\n");
    expect(log).toContain("line-500\n");
  });

  it("runs in cwd with CI=1, FORCE_COLOR=0 and a positive environment", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    vi.stubEnv("OPENAI_API_KEY", "sk-openai");
    vi.stubEnv("MC_TEST_VALUE", "synthetic-excluded");
    const scrubbed = new Verifier({ logsDir, timeoutMs: 20_000 });
    const result = await scrubbed.runFull(
      cwd,
      config('echo "pwd=$(pwd)"; echo "CI=$CI FORCE_COLOR=$FORCE_COLOR"; echo "keys=${ANTHROPIC_API_KEY:-none}/${OPENAI_API_KEY:-none} value=$MC_TEST_VALUE"'),
    );
    expect(result.ok).toBe(true);
    expect(result.outputTail).toContain(`pwd=${cwd}`);
    expect(result.outputTail).toContain("CI=1 FORCE_COLOR=0");
    expect(result.outputTail).toContain("keys=none/none value=");
    expect(result.outputTail).not.toContain("sk-secret");
  });

  it("kills a command that exceeds the timeout", async () => {
    const quick = new Verifier({ logsDir, timeoutMs: 300 });
    const result = await quick.runFull(cwd, config("echo starting; sleep 30"));
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
    expect(result.signature).toMatch(/^[0-9a-f]{12}$/);
    expect(result.outputTail).toContain("starting");
    expect(result.outputTail).toContain("timeout");
  });

  it("fails cleanly when the command cannot start", async () => {
    const result = await verifier.runFull(join(cwd, "does-not-exist"), config("true"));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.signature).toMatch(/^[0-9a-f]{12}$/);
    expect(result.outputTail).toMatch(/could not start/);
  });

  it("fails an empty verify command instead of passing vacuously", async () => {
    const result = await verifier.runFull(cwd, config("  "));
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.outputTail).toContain("no verify command");
    expect(result.signature).toMatch(/^[0-9a-f]{12}$/);
    expect(existsSync(result.logFile)).toBe(true);
  });

  it("treats a missing or null command from malformed config like an empty one", async () => {
    const malformed = { full: null, install: null, tests: null, testGlobs: [] } as unknown as VerifyConfig;
    const full = await verifier.runFull(cwd, malformed, "malformed");
    expect(full).toMatchObject({ ok: false, exitCode: null });
    expect(full.outputTail).toContain("no verify command");
    expect(readFileSync(full.logFile, "utf8")).toContain("no verify command");
    expect((await verifier.install(cwd, malformed)).ok).toBe(true);
    expect((await verifier.runTests(cwd, malformed, ["tests/a.ts"])).outputTail).toContain("no verify command");
    const missing = await verifier.runFull(cwd, { testGlobs: [] } as unknown as VerifyConfig);
    expect(missing.ok).toBe(false);
  });

  it("still runs the command when the log directory cannot be created", async () => {
    const blocker = join(makeTempDir(), "not-a-dir");
    writeFileSync(blocker, "");
    const { logger, entries } = captureLogger();
    const noLogs = new Verifier({ logsDir: join(blocker, "logs"), timeoutMs: 20_000, logger });
    const result = await noLogs.runFull(cwd, config("echo still ran; exit 4"));
    expect(result).toMatchObject({ ok: false, exitCode: 4, logFile: "" });
    expect(result.outputTail).toContain("still ran");
    expect(result.signature).toMatch(/^[0-9a-f]{12}$/);
    expect(entries.some((e) => e.level === "warn" && /log/.test(e.msg))).toBe(true);
  });

  it("cuts very long lines in the tail", async () => {
    const result = await verifier.runFull(cwd, config("head -c 100000 /dev/zero | tr '\\0' x; echo; echo after"));
    const [long, after] = result.outputTail.split("\n");
    expect(long).toBe(`${"x".repeat(4096)} … [${100_000 - 4096} chars cut]`);
    expect(after).toBe("after");
    expect(readFileSync(result.logFile, "utf8")).toContain("x".repeat(100_000));
  });

  it("kills a running command when the abort signal fires", async () => {
    const controller = new AbortController();
    const abortable = new Verifier({ logsDir, timeoutMs: 60_000, signal: controller.signal });
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    const result = await abortable.runFull(cwd, config("echo starting; sleep 30"));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ ok: false, timedOut: false });
    expect(result.outputTail).toContain("starting");
    expect(result.outputTail).toContain("aborted");
  });

  it("does not start a command once the signal has fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortable = new Verifier({ logsDir, timeoutMs: 60_000, signal: controller.signal });
    const result = await abortable.runFull(cwd, config("touch ran.txt"));
    expect(result.ok).toBe(false);
    expect(result.outputTail).toContain("aborted");
    expect(existsSync(join(cwd, "ran.txt"))).toBe(false);
  });

  it("names logs after the label, never overwriting an earlier log", async () => {
    const first = await verifier.runFull(cwd, config("echo one"), "add-todo/attempt 1");
    const second = await verifier.runFull(cwd, config("echo two"), "add-todo/attempt 1");
    expect(first.logFile).toBe(join(logsDir, "verify-add-todo-attempt-1.log"));
    expect(second.logFile).toBe(join(logsDir, "verify-add-todo-attempt-1-2.log"));
    expect(readFileSync(first.logFile, "utf8")).toContain("one");
    expect(readFileSync(second.logFile, "utf8")).toContain("two");
  });

  it("names logs after a timestamp when there is no label", async () => {
    const result = await verifier.runFull(cwd, config("true"));
    expect(result.logFile.startsWith(logsDir)).toBe(true);
    expect(readdirSync(logsDir)).toEqual([expect.stringMatching(/^verify-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.log$/)]);
  });

  it("substitutes shell-quoted files into the tests command", async () => {
    const files = ["tests/a.test.ts", "tests/my file.test.ts", "tests/it's.test.ts", "tests/$(touch pwned).test.ts"];
    const result = await verifier.runTests(cwd, config("echo full", { tests: "printf '[%s]\\n' {files}" }), files, "unit");
    expect(result.ok).toBe(true);
    expect(result.outputTail.split("\n").slice(0, 4)).toEqual(files.map((f) => `[${f}]`));
    expect(existsSync(join(cwd, "pwned"))).toBe(false);
    expect(result.logFile).toBe(join(logsDir, "verify-unit.log"));
  });

  it("replaces every {files} placeholder", async () => {
    const result = await verifier.runTests(cwd, config("echo full", { tests: "echo {files} && echo again {files}" }), ["tests/a.ts"]);
    expect(result.outputTail).toContain("tests/a.ts\nagain tests/a.ts");
  });

  it("appends the files when the tests command has no {files} placeholder", async () => {
    const result = await verifier.runTests(cwd, config("echo full", { tests: "echo running" }), ["tests/a.ts", "tests/b.ts"]);
    expect(result.outputTail).toContain("running tests/a.ts tests/b.ts");
  });

  it("falls back to the full command when there is no tests command or no files", async () => {
    const noTestsCommand = await verifier.runTests(cwd, config("echo full-run"), ["tests/a.ts"]);
    expect(noTestsCommand.outputTail).toContain("full-run");
    const noFiles = await verifier.runTests(cwd, config("echo full-run", { tests: "echo targeted {files}" }), []);
    expect(noFiles.outputTail).toContain("full-run");
    expect(noFiles.outputTail).not.toContain("targeted");
  });

  it("logs each run's outcome", async () => {
    const { logger, entries } = captureLogger();
    const logged = new Verifier({ logsDir, timeoutMs: 20_000, logger });
    await logged.runFull(cwd, config("true"), "green");
    await logged.runFull(cwd, config("exit 2"), "red");
    expect(entries.map((e) => [e.level, e.msg, e.data?.exitCode])).toEqual([
      ["info", "verify passed", 0],
      ["info", "verify failed", 2],
    ]);
    expect(entries[1]?.data?.logFile).toBe(join(logsDir, "verify-red.log"));
  });
});

describe("Verifier positive launch policy", () => {
  it("does not pass an unrelated value to a project verification command", async () => {
    const cwd = makeTempDir();
    vi.stubEnv("MC_UNRELATED_SECRET", "synthetic-secret");
    const verifier = new Verifier({ logsDir: join(cwd, "logs"), timeoutMs: 5000 });
    const result = await verifier.runFull(cwd, config('printf "%s" "${MC_UNRELATED_SECRET-unset}"'));
    expect(result.ok).toBe(true);
    expect(result.outputTail).toContain("unset");
    expect(result.outputTail).not.toContain("synthetic-secret");
  });
});

describe("Verifier environment preparation failure", () => {
  it("returns a failed verification without launching or echoing the invalid value", async () => {
    const cwd = makeTempDir();
    const verifier = new Verifier({ logsDir: join(cwd, "logs"), timeoutMs: 5000, path: ["/mnt/c/synthetic-private-value"] });
    const result = await verifier.runFull(cwd, config("echo synthetic-launched"));
    expect(result.ok).toBe(false);
    expect(result.outputTail).toContain("path[0]");
    expect(result.outputTail).not.toContain("synthetic-private-value");
    expect(result.outputTail).not.toContain("synthetic-launched");
    expect(result.signature).not.toBe("");
    expect(readFileSync(result.logFile, "utf8")).toContain("path[0]");
  });
});
