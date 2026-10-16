// Tests of the scripted checks (docs/modes-spec.md sections 6 and 8.3, and the matching tests of section 15).
// Text that looks like a key is built in code from pieces, so this file holds none.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  checkDeliverables,
  checkPageRendered,
  checkPageStatic,
  type DeliverableFile,
  type Deliverables,
  fileKind,
  findSecrets,
  githubSlugs,
  judgeRubric,
  markdownHeadings,
  mergeOutcomes,
  parseCsv,
  plainName,
  projectChecksProblem,
  readDeliverables,
  type RubricInput,
} from "./checks.js";
import type { PageFacts, RenderedPage } from "./render.js";
import type { FeatureExpect, RubricOutput } from "./types.js";

// A spy on the reading functions of the engine's checks: every path they are asked about is recorded while `on` is set.
const spy = vi.hoisted(() => ({ on: false, calls: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const watch = (name: string, fn: (...args: never[]) => unknown) =>
    ((...args: unknown[]) => {
      if (spy.on && typeof args[0] === "string") spy.calls.push(`${name} ${args[0]}`);
      return (fn as (...a: unknown[]) => unknown)(...args);
    }) as never;
  return {
    ...actual,
    lstat: watch("lstat", actual.lstat),
    stat: watch("stat", actual.stat),
    realpath: watch("realpath", actual.realpath),
    open: watch("open", actual.open),
    readFile: watch("readFile", actual.readFile),
    readdir: watch("readdir", actual.readdir),
  };
});

// ───────────────────────────── Helpers ─────────────────────────────

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A temporary worktree with these files. Its path is the real path. */
function tree(files: Record<string, string | Buffer>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-checks-")));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

function addedLines(now: string, before: string): string[] {
  const old = new Set(before.split("\n"));
  return now.split("\n").filter((l) => !old.has(l));
}

/** What the engine does: read the changed files of a worktree, then check them. `before` holds the text a file had at the start. */
async function scan(dir: string, changed: string[], opts: { before?: Record<string, string>; expect?: FeatureExpect } = {}) {
  const deliverables = await readDeliverables({
    worktree: dir,
    changed,
    before: async (p) => opts.before?.[p],
    added: async (p) => {
      const old = opts.before?.[p];
      if (old === undefined) return undefined;
      const now = (await import("node:fs")).readFileSync(join(dir, p), "utf8");
      return addedLines(now, old);
    },
  });
  const check = await checkDeliverables({ deliverables, expect: opts.expect });
  return { deliverables, check };
}

function file(path: string, text: string, extra: Partial<DeliverableFile> = {}): DeliverableFile {
  return { path, kind: fileKind(path), size: Buffer.byteLength(text), isNew: true, text, added: text.split("\n"), ...extra };
}

function dels(files: DeliverableFile[], extra: Partial<Deliverables> = {}): Deliverables {
  return { files, skipped: [], onlyRemoved: false, facts: [], ...extra };
}

async function run(files: DeliverableFile[], expectKeys?: FeatureExpect) {
  return checkDeliverables({ deliverables: dels(files), expect: expectKeys });
}

/** Builds a string from pieces so that this file holds no text that looks like a key. */
const join2 = (...parts: (string | number)[]): string => parts.join("");
const rep = (ch: string, n: number): string => ch.repeat(n);

// ───────────────────────────── plainName ─────────────────────────────

describe("plainName", () => {
  it("keeps a plain name as it is", () => {
    expect(plainName("docs/setup.md")).toBe("docs/setup.md");
  });

  it("shows hidden characters as their code points", () => {
    expect(plainName("a\nb")).toBe("a<U+000A>b");
    expect(plainName(`x${String.fromCodePoint(0x202e)}y`)).toBe("x<U+202E>y");
    expect(plainName(`x${String.fromCodePoint(0x200b)}y`)).toBe("x<U+200B>y");
    expect(plainName(`x${String.fromCodePoint(0x2800)}y`)).toBe("x<U+2800>y");
    expect(plainName("tab\there")).toBe("tab<U+0009>here");
  });

  it("cuts a 500-character name at 80 characters and says so", () => {
    const out = plainName("a".repeat(500));
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
    expect(plainName("a".repeat(80))).toBe("a".repeat(80));
    expect(plainName("a".repeat(81)).length).toBe(80);
    expect(plainName("a".repeat(200), 10).length).toBe(10);
  });

  it("never cuts inside a code point marker and never exceeds the limit", () => {
    const hidden = String.fromCodePoint(0x200b).repeat(50);
    const out = plainName(hidden);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).not.toMatch(/<U\+[0-9A-F]{0,3}…/);
  });

  it("copes with a huge name without reading all of it", () => {
    const start = Date.now();
    expect(plainName("x".repeat(5_000_000)).length).toBe(80);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

// ───────────────────────────── Reading the files (6.1) ─────────────────────────────

describe("readDeliverables", () => {
  it("reads regular files in sorted order and gives each its kind, size, text and added lines", async () => {
    const dir = tree({ "b.md": "# B\n", "a.csv": "x,y\n1,2\n", "c.html": "<title>t</title>" });
    const d = await readDeliverables({ worktree: dir, changed: ["c.html", "a.csv", "b.md"], before: async () => undefined, added: async () => undefined });
    expect(d.files.map((f) => f.path)).toEqual(["a.csv", "b.md", "c.html"]);
    expect(d.files.map((f) => f.kind)).toEqual(["table", "markdown", "page"]);
    expect(d.files[1]).toMatchObject({ size: 4, isNew: true, text: "# B\n" });
    expect(d.files[1]!.added).toEqual(["# B", ""]);
    expect(d.worktree).toBe(dir);
  });

  it("skips a symbolic link and a link to a file outside the folder, and names them in a fact", async () => {
    const outside = tree({ "secret.txt": "outside" });
    const dir = tree({ "real.md": "# Real\n" });
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.md"));
    symlinkSync(join(dir, "real.md"), join(dir, "inner.md"));
    const d = await readDeliverables({ worktree: dir, changed: ["link.md", "inner.md", "real.md"], before: async () => undefined, added: async () => undefined });
    expect(d.files.map((f) => f.path)).toEqual(["real.md"]);
    expect(d.skipped).toEqual(
      expect.arrayContaining([
        { path: "link.md", why: "not_plain_file" },
        { path: "inner.md", why: "not_plain_file" },
      ]),
    );
    expect(d.facts).toContain("“link.md” is not a plain file inside the project, so it was not read.");
    const r = await checkDeliverables({ deliverables: d });
    expect(JSON.stringify(r)).not.toContain("outside");
  });

  it("skips a file reached through a folder that is a link to a place outside", async () => {
    const outside = tree({ "docs/x.md": "# X\n" });
    const dir = tree({ "real.md": "# Real\n" });
    symlinkSync(outside, join(dir, "sub"));
    const d = await readDeliverables({ worktree: dir, changed: ["sub/docs/x.md"], before: async () => undefined, added: async () => undefined });
    expect(d.files).toEqual([]);
    expect(d.skipped[0]).toEqual({ path: "sub/docs/x.md", why: "not_plain_file" });
  });

  it("never opens a path that leaves the folder, whatever the list says", async () => {
    const dir = tree({ "a.md": "# A\n" });
    spy.calls = [];
    spy.on = true;
    const d = await readDeliverables({
      worktree: dir,
      changed: ["../etc/passwd", "/etc/passwd", "a/../../x", "a\0b", "", ".", "a//b", "a.md"],
      before: async () => undefined,
      added: async () => undefined,
    });
    spy.on = false;
    expect(d.files.map((f) => f.path)).toEqual(["a.md"]);
    for (const c of spy.calls) expect(c).toMatch(/mc-checks-/);
    expect(spy.calls.some((c) => c.includes("passwd"))).toBe(false);
    expect(d.skipped.filter((s) => s.why === "not_plain_file")).toHaveLength(7);
  });

  it("treats a deleted file as removed, and a feature that only removed files as passing with a fact", async () => {
    const dir = tree({ "keep.md": "# Keep\n" });
    const { deliverables, check } = await scan(dir, ["gone.md", "gone2.csv"]);
    expect(deliverables.onlyRemoved).toBe(true);
    expect(check.pass).toBe(true);
    expect(check.facts).toContain("It only removed files.");
  });

  it("S01: a feature whose only changes are left-out kinds changed no files", async () => {
    const dir = tree({ "node_modules/x/index.js": "x", "package-lock.json": "{}", "test-results/a.png": "x", "playwright-report/index.html": "x", ".git/config": "x", "yarn.lock": "x", "pnpm-lock.yaml": "x", "npm-shrinkwrap.json": "{}" });
    const changed = ["node_modules/x/index.js", "package-lock.json", "test-results/a.png", "playwright-report/index.html", ".git/config", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json"];
    const { deliverables, check } = await scan(dir, changed);
    expect(deliverables.files).toEqual([]);
    expect(deliverables.skipped.every((s) => s.why === "left_out")).toBe(true);
    expect(check.problems).toEqual(["It changed no files."]);
    expect(check.pass).toBe(false);
  });

  it("S01 negative: a feature that changed one file is fine", async () => {
    const dir = tree({ "a.md": "# A\n\nText here.\n" });
    const { check } = await scan(dir, ["a.md"]);
    expect(check.problems).toEqual([]);
  });

  it("looks at 60 files at most and says how many it did not look at", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 61; i++) files[`f${String(i).padStart(2, "0")}.md`] = `# File ${i}\n\nSome text.\n`;
    const dir = tree(files);
    const { deliverables } = await scan(dir, Object.keys(files));
    expect(deliverables.files).toHaveLength(60);
    expect(deliverables.skipped).toEqual([{ path: "f60.md", why: "not_looked_at" }]);
    expect(deliverables.facts).toContain("1 more file changed and was not looked at.");
  });

  it("reads at most 12 MB of text in all", async () => {
    const chunk = "x".repeat(1024 * 1024 - 10);
    const files: Record<string, string> = {};
    for (let i = 0; i < 14; i++) files[`t${String(i).padStart(2, "0")}.txt`] = chunk;
    const dir = tree(files);
    const { deliverables } = await scan(dir, Object.keys(files));
    expect(deliverables.files.length).toBeLessThanOrEqual(12);
    expect(deliverables.files.length).toBeGreaterThanOrEqual(11);
    expect(deliverables.skipped.filter((s) => s.why === "not_looked_at").length).toBeGreaterThanOrEqual(2);
    expect(deliverables.facts.some((f) => /more files changed and were not looked at/.test(f))).toBe(true);
  });

  it("S03: a text file just over 1 MB is reported and not read, one just under is read", async () => {
    const limit = 1024 * 1024;
    const dir = tree({ "big.md": "a".repeat(limit + 1), "edge.md": "a".repeat(limit), "huge.png": Buffer.alloc(5 * limit + 1), "bin.png": Buffer.alloc(5 * limit) });
    const { deliverables, check } = await scan(dir, ["big.md", "edge.md", "huge.png", "bin.png"]);
    expect(deliverables.files.map((f) => f.path).sort()).toEqual(["bin.png", "edge.md"]);
    expect(check.problems).toContain("“big.md” is larger than 1 MB, which is too big for a document, a page or a data file.");
    expect(check.problems).toContain("“huge.png” is larger than 5 MB, which is too big for a document, a page or a data file.");
    expect(check.problems.some((p) => p.includes("edge.md"))).toBe(false);
    expect(check.problems.some((p) => p.includes("bin.png"))).toBe(false);
  });

  it("S02: an empty file, or one of only spaces and line ends, is empty; a text file with a word is not", async () => {
    const dir = tree({ "a.md": "", "b.md": "  \n\n \t\n", "c.md": "Hello", "d.png": Buffer.alloc(0), "e.png": Buffer.from([1, 2, 3]) });
    const { check } = await scan(dir, ["a.md", "b.md", "c.md", "d.png", "e.png"]);
    expect(check.problems).toEqual(["“a.md” is empty.", "“b.md” is empty.", "“d.png” is empty."]);
  });

  it("lists other kinds in a fact and says what the second AI cannot read", async () => {
    const dir = tree({ "run.sh": "echo hi\n", "data.xlsx": Buffer.from([80, 75, 3, 4]), "Makefile": "all:\n" });
    const { check } = await scan(dir, ["run.sh", "data.xlsx", "Makefile"]);
    expect(check.facts).toContain("It also changed files of other kinds: “Makefile”, “run.sh”.");
    expect(check.facts).toContain("“data.xlsx” is a spreadsheet file, which the second AI cannot read.");
    expect(check.pass).toBe(true);
  });

  it("gives a file name with a new line or a mark that reverses text a safe name in every message", async () => {
    const odd = `bad\nname${String.fromCodePoint(0x202e)}.md`;
    const dir = tree({ [odd]: "" });
    const { check } = await scan(dir, [odd]);
    expect(check.problems).toEqual(["“bad<U+000A>name<U+202E>.md” is empty."]);
  });

  it("reads files whose names have spaces, quote marks, a leading dash or letters from other scripts", async () => {
    const names = ["my notes.md", "-leading.md", 'q"uote.md', "curly“quote”.md", "ünï.md", "页面.md", "a'b.md", "semi;colon.md", "dollar$(x).md", "back`tick`.md"];
    const dir = tree(Object.fromEntries(names.map((n) => [n, "# Title\n\nSome text here.\n"])));
    const { deliverables, check } = await scan(dir, names);
    expect(deliverables.files).toHaveLength(names.length);
    expect(check.problems).toEqual([]);
    const empty = tree({ 'q"uote“d”.md': "" });
    const bad = await scan(empty, ['q"uote“d”.md']);
    expect(bad.check.problems).toEqual(['“q"uote"d".md” is empty.']);
  });

  it("copes with a file name that is a 500-character string", async () => {
    const name = `${"n".repeat(200)}.md`;
    const dir = tree({ [name]: "" });
    const { check } = await scan(dir, [name]);
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]!.length).toBeLessThanOrEqual(200);
  });
});

describe("fileKind", () => {
  it("maps extensions to kinds, capitals and all", () => {
    expect(fileKind("a/b.MD")).toBe("markdown");
    expect(fileKind("x.markdown")).toBe("markdown");
    expect(fileKind("x.txt")).toBe("text");
    expect(fileKind("x.htm")).toBe("page");
    expect(fileKind("x.csv")).toBe("table");
    expect(fileKind("x.css")).toBe("style");
    expect(fileKind("x.svg")).toBe("drawing");
    expect(fileKind("x.xlsx")).toBe("binary");
    expect(fileKind("x.json")).toBe("other");
    expect(fileKind("Makefile")).toBe("other");
    expect(fileKind("dir.d/Makefile")).toBe("other");
    expect(fileKind("a.constructor")).toBe("other");
  });
});

// ───────────────────────────── No plan value is opened ─────────────────────────────

describe("no plan value is opened as a path", () => {
  it("opens only the changed files and the link targets, whatever the plan says", async () => {
    const dir = tree({ "README.md": "# Guide\n\nSee [the doc](docs/guide.md#setup) and [x](../../../../etc/passwd#a).\n", "docs/guide.md": "# Setup\n" });
    const hostile: FeatureExpect = {
      headings: ["/etc/passwd", "../../etc/passwd", "C:\\Windows\\system.ini", "-rf", ".ssh/id_rsa"],
      mentions: ["/etc/passwd", "../../x", "www.example.com", "//evil.example/x", "mailto:a@b.c", "javascript:alert(1)", "data:text/html,x", "etc/passwd", "rm -rf x", ".*", "("],
    };
    spy.calls = [];
    spy.on = true;
    const { check } = await scan(dir, ["README.md"], { expect: hostile });
    spy.on = false;
    const paths = spy.calls.map((c) => c.slice(c.indexOf(" ") + 1));
    for (const p of paths) {
      expect(p.startsWith(dir) || p === dir).toBe(true);
      expect(p).not.toContain("passwd");
      expect(p).not.toContain("id_rsa");
      expect(p).not.toContain("system.ini");
    }
    // The link target under the folder was looked at; the one that leaves the folder was not.
    expect(paths).toContain(join(dir, "docs", "guide.md"));
    expect(check.problems).toContain("The link to “../../../../etc/passwd#a” in “README.md” does not lead to a file in the project.");
    expect(check.problems).toContain("The text has no heading called “/etc/passwd”.");
  });

  it("compares a mention as a plain string: capital letters, dots and brackets mean nothing special", async () => {
    const r = await run([file("a.md", "# T\n\nwe have a.b and f(x) here\n")], { mentions: ["a.b", "f(x)", "a.*", "[x"] });
    expect(r.problems).toEqual(["The visible text does not contain “a.*”.", "The visible text does not contain “[x”."]);
  });
});

// ───────────────────────────── S04: the ten patterns (6.2a) ─────────────────────────────

describe("S04, the ten key patterns", () => {
  const A = rep("A", 40);
  const cases: { pattern: number; hit: string; near: string }[] = [
    { pattern: 1, hit: join2("-----BEGIN RSA ", "PRIVATE KEY", "-----"), near: join2("-----BEGIN CERTIFICATE", "-----") },
    { pattern: 2, hit: join2("AK", "IA", rep("Q", 16)), near: join2("AK", "IA", rep("Q", 15)) },
    { pattern: 3, hit: join2("gh", "p_", rep("a", 36)), near: join2("gh", "p_", rep("a", 35)) },
    { pattern: 3, hit: join2("github", "_pat_", rep("b", 22)), near: join2("github", "_pat_", rep("b", 21)) },
    { pattern: 4, hit: join2("s", "k-", rep("c", 24)), near: join2("s", "k-", rep("c", 19)) },
    { pattern: 5, hit: join2("s", "k_live_", rep("d", 20)), near: join2("s", "k_live_", rep("d", 10)) },
    { pattern: 6, hit: join2("xo", "xb-", rep("1", 12)), near: join2("xo", "xb-", rep("1", 5)) },
    { pattern: 7, hit: join2("AI", "za", rep("e", 35)), near: join2("AI", "za", rep("e", 30)) },
    { pattern: 8, hit: join2("ey", "J", rep("f", 10), ".ey", "J", rep("g", 10), ".", rep("h", 12)), near: join2("ey", "J", rep("f", 10), ".", rep("g", 10), ".", rep("h", 12)) },
    { pattern: 9, hit: join2("pass", "word = '", rep("x1", 6), "'"), near: join2("pass", "word = '", "short", "'") },
    { pattern: 9, hit: join2("API", "_KEY: ", rep("Zq", 8)), near: join2("api", "_key: ", "<", rep("Zq", 8), ">") },
    { pattern: 10, hit: join2("https:", "//user:", "hunter2", "@example.org/x"), near: join2("https:", "//example.org:8080/x") },
  ];

  it.each(cases)("pattern $pattern: matches one string and not the near miss", ({ pattern, hit, near }) => {
    const found = findSecrets(`line one\nsomething ${hit} more\n`);
    expect(found.map((h) => h.pattern)).toContain(pattern);
    expect(found.find((h) => h.pattern === pattern)?.line).toBe(2);
    expect(findSecrets(`line one\nsomething ${near} more\n`).filter((h) => h.pattern === pattern)).toEqual([]);
  });

  it("does not count the placeholder values of pattern 9", () => {
    const names = ["pass" + "word", "sec" + "ret", "api" + "_key"];
    const values = ["<your-value-here>", "$ENV_VALUE_X", "{{ value_here }}", "%VALUE_HERE%", "*********", "your-value-here", "Example-value", "changeme-now", "XXXXXXXXXXXX", "process.env.SOME_VALUE_NAME"];
    for (const n of names) for (const v of values) expect(findSecrets(`${n}: ${v}`), `${n} ${v}`).toEqual([]);
  });

  it("does not count a placeholder password in a web address, as a guide shows one", () => {
    for (const pw of ["<token>", "$TOKEN", "{{ token }}", "%TOKEN%", "*****", "your-token", "example-token"]) {
      expect(findSecrets(join2("git remote add origin https:", `//<user>:${pw}@github.com/x/y.git`)), pw).toEqual([]);
    }
  });

  it("finds a key that straddles the 2,000-character slice boundary, and reports it once", () => {
    const key = join2("gh", "p_", rep("k", 40));
    // The key starts at 1,990, so the first slice (0 to 2,000) holds only its first ten characters.
    const line = rep("a ", 995) + key + rep(" b", 500);
    expect(line.indexOf(key)).toBe(1990);
    const hits = findSecrets(line).filter((h) => h.pattern === 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(1);
    // A key wholly inside the overlap of two slices is still one hit.
    const inside = rep("a ", 950) + key + rep(" b", 500);
    expect(inside.indexOf(key)).toBe(1900);
    expect(findSecrets(inside).filter((h) => h.pattern === 3)).toHaveLength(1);
  });

  it("builds the message with the line number and never prints the key", async () => {
    const key = join2("s", "k-", rep("m", 30));
    const r = await run([file("notes.md", `# Notes\n\nA line\nthe key is ${key} for now\n`)]);
    expect(r.problems).toEqual(["“notes.md” has text that looks like a key or a password (line 4). Remove it."]);
    expect(JSON.stringify(r)).not.toContain(key);
    expect(A.length).toBe(40);
  });

  it("scans an unknown kind of file for keys too", async () => {
    const key = join2("AK", "IA", rep("Z", 16));
    const r = await run([file("config.json", `{ "x": "${key}" }\n`)]);
    expect(r.problems).toEqual(["“config.json” has text that looks like a key or a password (line 1). Remove it."]);
  });
});

// ───────────────────────────── M25: problems the file already had ─────────────────────────────

describe("M25, problems the file already had are facts", () => {
  it("moves a dead link, a TODO, a key-shaped string and an outside font that were already there to the facts, and fails the same defects when the feature adds them", async () => {
    const key = join2("s", "k-", rep("n", 30));
    const oldText = [
      "# Readme",
      "",
      "See [old](gone/old.md) for more.",
      `Old key: ${key}`,
      "TODO fix this later",
      "",
    ].join("\n");
    const newText = oldText + "\nA new line of text.\n";
    const dir = tree({ "README.md": newText });
    const same = await scan(dir, ["README.md"], { before: { "README.md": oldText } });
    expect(same.check.problems).toEqual([]);
    expect(same.check.facts).toContain("“README.md” already had this before the feature: The link to “gone/old.md” in “README.md” does not lead to a file in the project.");
    expect(same.check.facts).toContain("“README.md” already had this before the feature: “README.md” has text that looks like a key or a password (line 4). Remove it.");
    expect(same.check.facts.some((f) => f.includes("still has placeholder text"))).toBe(true);
    // The same defects, but new in this feature, are failures.
    const dir2 = tree({ "README.md": newText });
    const fresh = await scan(dir2, ["README.md"], { before: { "README.md": "# Readme\n" } });
    expect(fresh.check.problems.some((p) => p.includes("does not lead to a file"))).toBe(true);
    expect(fresh.check.problems.some((p) => p.includes("looks like a key"))).toBe(true);
    expect(fresh.check.problems.some((p) => p.includes("placeholder"))).toBe(true);
  });

  it("does the same for a page: an outside font and a missing title that were already there", async () => {
    const before = '<!doctype html><link rel="stylesheet" href="https://fonts.example.org/a.css"><body><p>Hi</p></body>';
    const page = file("index.html", before + "<p>More</p>", { isNew: false, before });
    const r = checkPageStatic(page);
    expect(r.problems).toEqual([]);
    expect(r.facts.length).toBe(3);
    expect(r.facts[0]).toMatch(/^“index\.html” already had this before the feature: /);
    const fresh = checkPageStatic(file("index.html", before));
    expect(fresh.problems).toHaveLength(3);
  });

  it("a table cell that a spreadsheet may run was already there is a fact", async () => {
    const before = "a,b\n=1+1,2\n";
    const r = await run([file("t.csv", before + "3,4\n", { isNew: false, before })]);
    expect(r.problems).toEqual([]);
    expect(r.facts.some((f) => f.startsWith("“t.csv” already had this before the feature: Row 2, column “a” of “t.csv” starts with"))).toBe(true);
    const fresh = await run([file("t.csv", before + "3,4\n")]);
    expect(fresh.problems).toEqual(["Row 2, column “a” of “t.csv” starts with a character that a spreadsheet may run as a formula. Start it with a letter."]);
  });

  it("counts words over the added lines only, and the whole of a new file", async () => {
    const before = "# Title\n\nOne two three.\n";
    const now = before + "\nFour five six seven eight.\n";
    const r = await run([file("a.md", now, { isNew: false, before, added: addedLines(now, before) })], { words: [5, 5] });
    expect(r.problems).toEqual([]);
    const whole = await run([file("a.md", now)], { words: [5, 5] });
    expect(whole.problems).toEqual(["The new text has 9 words; it should have 5 to 5."]);
  });
});

// ───────────────────────────── S05 placeholders ─────────────────────────────

describe("S05, placeholder text", () => {
  const cases: [string, string, string][] = [
    ["lorem ipsum anywhere", "# Hi\n\nSome Lorem   Ipsum dolor.\n", "Lorem ipsum"],
    ["a TODO at the start of a line", "# Hi\n\nTODO write this\n", "TODO write this"],
    ["a FIXME after a list mark", "# Hi\n\n- FIXME later\n", "- FIXME later"],
    ["a TBD after a quote mark", "# Hi\n\n> TBD\n", "> TBD"],
    ["a TODO after a comment mark", "// TODO tidy\n", "// TODO tidy"],
    ["a TODO after an HTML comment mark", "<!-- TODO -->\n", "<!-- TODO -->"],
    ["an insert blank", "# Hi\n\nDear [insert name here],\n", "[insert name here]"],
    ["a your blank", "# Hi\n\nCall [Your phone number].\n", "[Your phone number]"],
    ["a name blank", "# Hi\n\nBy [name] on [date].\n", "[name]"],
  ];

  it.each(cases)("fails on %s", async (_label, text, shownText) => {
    const name = text.startsWith("//") || text.startsWith("<!--") ? "a.txt" : "a.md";
    const r = await run([file(name, text)]);
    expect(r.problems).toEqual([`“${name}” still has placeholder text (“${shownText}”).`]);
  });

  it("does not read code in the script of a page as a blank to fill in, but reads the text of the page", async () => {
    const head = '<title>t</title><meta name="viewport" content="x">';
    expect((await run([file("p.html", `${head}<script>var a = names[name]; var b = d[date];</script><p>Hi</p>`)])).problems).toEqual([]);
    expect((await run([file("p.html", `${head}<p>Dear [name], hello</p>`)])).problems).toEqual(["“p.html” still has placeholder text (“[name]”)."]);
  });

  it("does not fail on the middle of a sentence, code, TODOs, a link, or a word that only looks like one", async () => {
    const text = [
      "# Hi",
      "",
      "We should TODO later in the sentence.",
      "The TODOs file is long.",
      "Use `[your name]` in the code span.",
      "```",
      "TODO inside a fence",
      "lorem-like [insert x]",
      "```",
      "[name](https://example.org) is a link and [date]: reference.",
      "A todo in lowercase at the start is fine.",
    ].join("\n");
    const r = await run([file("a.md", text)]);
    expect(r.problems).toEqual([]);
  });

  it("ignores a placeholder inside an HTML comment of a markdown file", async () => {
    const r = await run([file("a.md", "# Hi\n\n<!-- TODO hidden note\nstill a comment -->\nReal text.\n")]);
    expect(r.problems).toEqual([]);
  });
});

// ───────────────────────────── S06, S07: links ─────────────────────────────

describe("S06 and S07, links", () => {
  const base = {
    "docs/guide.md": "# Guide\n\n## Setup\n\n## Setup\n\n## Other things\n",
    "my file.md": "# My file\n",
    "public/logo.png": "png",
    "README.md": "",
  };

  async function links(readme: string, extra: Record<string, string | Buffer> = {}, before?: string) {
    const dir = tree({ ...base, ...extra, "README.md": readme });
    return { dir, ...(await scan(dir, ["README.md"], before === undefined ? {} : { before: { "README.md": before } })) };
  }

  it("S06 negative: relative links, ..-links, %20, root links with an extension, directories and pictures that exist are fine", async () => {
    const { check } = await links(
      [
        "# Readme",
        "",
        "[a](docs/guide.md) [b](./docs/guide.md) [c](docs/../docs/guide.md) [d](my%20file.md) [e](<my file.md>) [f](docs/) [g](/docs/guide.md)",
        "![logo](/logo.png) [t](docs/guide.md \"A title\") [u](docs/guide.md 'Another')",
        "[ref]: docs/guide.md",
      ].join("\n"),
    );
    expect(check.problems).toEqual([]);
  });

  it("S06 positive: a link to a missing file, a missing picture and a missing reference definition", async () => {
    const { check } = await links("# Readme\n\n[a](docs/missing.md) ![p](img/none.png)\n\n[ref]: nowhere.md\n");
    expect(check.problems).toEqual([
      "The link to “docs/missing.md” in “README.md” does not lead to a file in the project.",
      "The link to “img/none.png” in “README.md” does not lead to a file in the project.",
      "The link to “nowhere.md” in “README.md” does not lead to a file in the project.",
    ]);
  });

  it("does not check links with a scheme, a bare anchor target, a route, or a text that is not a link", async () => {
    const { check } = await links(
      [
        "# Readme",
        "",
        "[a](https://example.org/x) [b](mailto:a@b.c) [c](//cdn.example.org/y) [d](tel:123) [e](/pricing) [f](#readme) [g](javascript:void(0))",
        "[h](my file.md) [i]() [j][k] [^1]",
        "",
        "[^1]: A footnote, not a link.",
      ].join("\n"),
    );
    expect(check.problems).toEqual([]);
    expect(check.facts).toContain("2 links to web addresses were not followed, because Mission Control does not use the internet.");
  });

  it("S06: a root link with an extension that does not exist is dead; one under public/ is fine", async () => {
    const { check } = await links("# Readme\n\n[a](/missing.png) [b](/logo.png)\n");
    expect(check.problems).toEqual(["The link to “/missing.png” in “README.md” does not lead to a file in the project."]);
  });

  it("ignores links in code fences and inline code", async () => {
    const { check } = await links("# Readme\n\n```\n[a](docs/none.md)\n```\n\nUse `[b](docs/none2.md)` like this.\n");
    expect(check.problems).toEqual([]);
  });

  it("a link that leaves the folder is a dead link and nothing outside is read", async () => {
    spy.calls = [];
    spy.on = true;
    const { dir, check } = await links("# Readme\n\n[x](../../../../home/x/y.md#a) [y](../outside.md) [z](/../../etc/hosts.txt)\n");
    spy.on = false;
    expect(check.problems).toHaveLength(3);
    for (const c of spy.calls) expect(c.slice(c.indexOf(" ") + 1).startsWith(dir)).toBe(true);
  });

  it("a link to a symbolic link is a dead link", async () => {
    const outside = tree({ "x.md": "# X\n" });
    const dir = tree({ "README.md": "# Readme\n\n[x](link.md) [y](dirlink/x.md)\n" });
    symlinkSync(join(outside, "x.md"), join(dir, "link.md"));
    symlinkSync(outside, join(dir, "dirlink"));
    const { check } = await scan(dir, ["README.md"]);
    expect(check.problems).toEqual([
      "The link to “link.md” in “README.md” does not lead to a file in the project.",
      "The link to “dirlink/x.md” in “README.md” does not lead to a file in the project.",
    ]);
  });

  it("S07: anchors match GitHub's rule, including repeats and punctuation", async () => {
    const { check } = await links(
      [
        "# Readme",
        "",
        "[a](#readme) [b](#install-now) [c](#whats-new) [d](#missing-heading) [e](docs/guide.md#setup) [f](docs/guide.md#setup-1) [g](docs/guide.md#setup-2) [h](docs/guide.md#other-things)",
        "",
        "## Install now",
        "",
        "## What's new?",
      ].join("\n"),
    );
    expect(check.problems).toEqual([
      "The link to the heading “#missing-heading” in “README.md” does not lead to a heading.",
      "The link to the heading “#setup-2” in “docs/guide.md” (from “README.md”) does not lead to a heading.",
    ]);
  });

  it("S07: an anchor that points to an HTML id is fine, and a link to a heading of a file that is not markdown is not checked", async () => {
    const { check } = await links('# Readme\n\n<a id="top-of-page"></a> [a](#top-of-page) [b](page.html#nothing) [c](#top)\n', { "page.html": "<title>x</title>" });
    expect(check.problems).toEqual([]);
  });

  it("S07 reads the target markdown file only under the reading rules: a symbolic link is not read, a big file is not read", async () => {
    const outside = tree({ "o.md": "# Setup\n" });
    const dir = tree({ "README.md": "# Readme\n\n[a](o.md#setup)\n" });
    symlinkSync(join(outside, "o.md"), join(dir, "o.md"));
    const { check } = await scan(dir, ["README.md"]);
    expect(check.problems).toEqual(["The link to “o.md#setup” in “README.md” does not lead to a file in the project."]);
  });

  it("uses the headings of a markdown file that the feature changed, from its text", async () => {
    const dir = tree({ "README.md": "# Readme\n\n[a](docs/new.md#fresh)\n", "docs/new.md": "# New\n\n## Fresh\n" });
    const { check } = await scan(dir, ["README.md", "docs/new.md"]);
    expect(check.problems).toEqual([]);
  });

  it("S06 on a page: href and src of its own files", async () => {
    const dir = tree({
      "index.html": '<!doctype html><title>t</title><meta name="viewport" content="width=device-width"><a href="about.html">a</a><a href="gone.html">g</a><img src="p.png" alt=""><img src="q.png" alt=""><script src="app.js"></script><a href="#x">x</a><a href="mailto:a@b.c">m</a>',
      "about.html": "<title>a</title>",
      "p.png": "x",
      "app.js": "1",
    });
    const { check } = await scan(dir, ["index.html"]);
    expect(check.problems).toEqual(["The link to “gone.html” in “index.html” does not lead to a file in the project.", "The link to “q.png” in “index.html” does not lead to a file in the project."]);
  });

  it("when the worktree is not known the link rules are skipped, and the other rules still run", async () => {
    const r = await run([file("a.md", "# A\n\n[x](gone.md)\n\nTODO x\n")]);
    expect(r.problems).toEqual(["“a.md” still has placeholder text (“TODO x”)."]);
  });

  it("a page with thousands of dead links writes at most ten problems and a count", async () => {
    const lines = ["# Readme", ""];
    for (let i = 0; i < 5000; i++) lines.push(`[l${i}](gone/${i}.md)`);
    const dir = tree({ "README.md": lines.join("\n") });
    const { check } = await scan(dir, ["README.md"]);
    expect(check.problems).toHaveLength(11);
    expect(check.problems[10]).toBe("and 4990 more.");
    for (const p of check.problems.slice(0, 10)) expect(p.length).toBeLessThanOrEqual(200);
  });
});

// ───────────────────────────── Headings and slugs ─────────────────────────────

describe("markdownHeadings and githubSlugs", () => {
  it("reads ATX and underlined headings and skips fences, comments and raw HTML", () => {
    const text = [
      "# One",
      "Two",
      "===",
      "",
      "Three **bold** `code` [link](x.md)",
      "---",
      "",
      "```",
      "# not a heading",
      "```",
      "<!-- # hidden",
      "## still hidden -->",
      "<div>",
      "# inside html",
      "</div>",
      "",
      "###### Six ######",
      "####### seven",
      "#nospace",
      "   ## Indented",
      "    # Code",
    ].join("\n");
    expect(markdownHeadings(text).map((h) => [h.level, h.text, h.line])).toEqual([
      [1, "One", 1],
      [1, "Two", 2],
      [2, "Three bold code link", 5],
      [6, "Six", 17],
      [2, "Indented", 20],
    ]);
  });

  it("reads a heading after a byte-order mark, and decodes an entity in its text", () => {
    expect(markdownHeadings("\ufeff# First\n\n## Tom &amp; Jerry\n").map((h) => h.text)).toEqual(["First", "Tom & Jerry"]);
  });

  it("applies GitHub's slug rule with -1 and -2 for repeats", () => {
    expect(githubSlugs(["Install now", "What's new?", "A", "A", "A", "Über Café", "a-1", "C++ & more"])).toEqual(["install-now", "whats-new", "a", "a-1", "a-2", "über-café", "a-1-1", "c--more"]);
  });
});

// ───────────────────────────── S08, S09, S10: the plan's words ─────────────────────────────

describe("S08 headings, S09 words, S10 length", () => {
  const PAGE_HEAD = '<title>T</title><meta name="viewport" content="x">';

  it("S08: a heading of any level is found, whatever the capitals, spaces and marks", async () => {
    const r = await run([file("a.md", "## add   YOUR first *habit*\n\nText\n")], { headings: ["Add your first habit"] });
    expect(r.problems).toEqual([]);
    const missing = await run([file("a.md", "# Other\n")], { headings: ["Add your first habit"] });
    expect(missing.problems).toEqual(["The text has no heading called “Add your first habit”."]);
  });

  it("S08: a heading in a page, an NFC heading against an NFD one, and a heading in a comment or a hidden element do not count when it is not visible", async () => {
    const nfd = "Cafe\u0301";
    const nfdFile = file("a.md", `# ${nfd}\n`);
    expect((await run([nfdFile], { headings: ["Caf\u00e9"] })).problems).toEqual([]);
    const page = file("p.html", PAGE_HEAD + "<h2>Install</h2><!-- <h1>Secret</h1> --><div hidden><h3>Hidden one</h3></div><div style='display:none'><h3>Hidden two</h3></div>");
    expect((await run([page], { headings: ["install"] })).problems).toEqual([]);
    const r = await run([page], { headings: ["Secret", "Hidden one", "Hidden two"] });
    expect(r.problems).toEqual(["The text has no heading called “Secret”.", "The text has no heading called “Hidden one”.", "The text has no heading called “Hidden two”."]);
    expect((await run([file("a.md", "# A\n\n<!-- ## Secret -->\n")], { headings: ["Secret"] })).problems).toEqual(["The text has no heading called “Secret”."]);
  });

  it("S09: a word that is in the visible text counts, with its capitals, across files joined", async () => {
    const files = [file("a.md", "# A\n\nHabit **tracker** here\n"), file("b.txt", "second file: Get started")];
    const ok = await run(files, { mentions: ["Habit tracker", "Get started"] });
    expect(ok.problems).toEqual([]);
    const bad = await run(files, { mentions: ["habit tracker", "Nowhere"] });
    expect(bad.problems).toEqual(["The visible text does not contain “habit tracker”.", "The visible text does not contain “Nowhere”."]);
  });

  it("S09 hidden text: a word only in a comment, a meta tag, a script string, a hidden element or raw HTML does not count", async () => {
    const page = file(
      "p.html",
      '<!doctype html><title>Secret title</title><meta name="viewport" content="x"><meta name="description" content="Secret meta"><!-- Secret comment --><script>var s = "Secret script";</script><style>.a::after{content:"Secret style"}</style><div hidden>Secret hidden</div><p style="display: none">Secret display</p><p title="Secret attr">Shown text</p>',
    );
    const r = await run([page], { mentions: ["Shown text", "Secret"] });
    expect(r.problems).toEqual(["The visible text does not contain “Secret”."]);
    const md = file("a.md", "# A\n\n<!-- Secret comment -->\n<span title=\"Secret attr\">Plain</span> <div hidden>Secret hidden</div>\n[Visible link](https://example.org/Secret-url)\n");
    const m = await run([md], { mentions: ["Plain", "Visible link", "Secret"] });
    expect(m.problems).toEqual(["The visible text does not contain “Secret”."]);
  });

  it("S09 matches an accent written one way against an accent written the other way", async () => {
    const r = await run([file("a.md", "# A\n\nCafe\u0301 time\n")], { mentions: ["Caf\u00e9 time"] });
    expect(r.problems).toEqual([]);
  });

  it("S10: words of markdown count without fences, comments, tags and link targets; the range is inclusive", async () => {
    const text = ["# One two", "", "Three four five.", "", "```", "ignored code words here", "```", "", "<!-- ignored comment words -->", "", "[six seven](https://example.org/long/ignored/target) it's well-known snake_case"].join("\n");
    // One two Three four five six seven it's well-known snake_case = 10
    expect((await run([file("a.md", text)], { words: [10, 10] })).problems).toEqual([]);
    expect((await run([file("a.md", text)], { words: [11, 20] })).problems).toEqual(["The new text has 10 words; it should have 11 to 20."]);
    expect((await run([file("a.md", text)], { words: [1, 9] })).problems).toEqual(["The new text has 10 words; it should have 1 to 9."]);
  });

  it("S10: a page counts the words a reader sees, without scripts, styles, comments and tags", async () => {
    const page = file("p.html", `<meta name="viewport" content="x"><title>ignored title words</title><style>.a{}</style><script>var many = 'ignored words in script';</script><!-- ignored --><h1>Hello big world</h1><p>Two more</p>`);
    expect((await run([page], { words: [5, 5] })).problems).toEqual([]);
  });

  it("S10 with no text file changed finds 0 words", async () => {
    expect((await run([file("t.csv", "a,b\n1,2\n")], { words: [1, 5] })).problems).toEqual(["The new text has 0 words; it should have 1 to 5."]);
  });
});

// ───────────────────────────── Tables: S11 to S18, S27 ─────────────────────────────

describe("parseCsv", () => {
  it("reads a byte-order mark, CRLF, quoted new lines, doubled quotes and a final blank line", () => {
    expect(parseCsv("\ufeffa,b\r\n1,2\r\n").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv('a,b\n"x\ny","he said ""hi"""\n').rows).toEqual([["a", "b"], ["x\ny", 'he said "hi"']]);
    expect(parseCsv("a,b\n1,2\n\n").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\n1,2").rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a,b\n1,\n").rows).toEqual([["a", "b"], ["1", ""]]);
    expect(parseCsv("").rows).toEqual([]);
    expect(parseCsv("a;b;c\n1;2;3\n").rows).toEqual([["a;b;c"], ["1;2;3"]]);
  });

  it("says when a quote mark is opened and never closed", () => {
    expect(parseCsv('a,b\n"x,2\n').unclosedQuote).toBe(true);
    expect(parseCsv('a,b\n"x",2\n').unclosedQuote).toBe(false);
  });
});

describe("table rules", () => {
  it("S11 to S15 positive and negative", async () => {
    expect((await run([file("t.csv", "a,b\n1,2\n3,4\n")])).problems).toEqual([]);
    expect((await run([file("t.csv", 'a,b\n"1,2\n')])).problems).toContain("“t.csv” is not a valid table: a quote mark is opened and never closed.");
    expect((await run([file("t.csv", ",,\n1,2,3\n")])).problems).toContain("“t.csv” has no header row.");
    expect((await run([file("t.csv", "a,,c\n1,2,3\n")])).problems).toEqual(["“t.csv” has a column with no name in its first row."]);
    expect((await run([file("t.csv", "a,b,a\n1,2,3\n")])).problems).toEqual(["“t.csv” has two columns called “a”."]);
    const ragged = await run([file("t.csv", "a,b\n1\n2,3,4\n5\n6\n7,8\n9\n")]);
    expect(ragged.problems).toEqual([
      "Row 2 of “t.csv” has 1 value, but the first row has 2.",
      "Row 3 of “t.csv” has 3 values, but the first row has 2.",
      "Row 4 of “t.csv” has 1 value, but the first row has 2.",
      "2 more rows of “t.csv” have the wrong number of values.",
    ]);
  });

  it("V2-08: one value, one more row and one word are said in the singular", async () => {
    const one = await run([file("t.csv", "a,b\n1\n2,3,4\n5\n6\n7,8\n")]);
    expect(one.problems).toEqual([
      "Row 2 of “t.csv” has 1 value, but the first row has 2.",
      "Row 3 of “t.csv” has 3 values, but the first row has 2.",
      "Row 4 of “t.csv” has 1 value, but the first row has 2.",
      "1 more row of “t.csv” has the wrong number of values.",
    ]);
    expect((await run([file("a.md", "Word\n")], { words: [5, 9] })).problems).toEqual(["The new text has 1 word; it should have 5 to 9."]);
    expect((await run([file("a.md", "# Hi\n\nTwo words\n")], { words: [5, 9] })).problems.some((p) => p.startsWith("The new text has 3 words;"))).toBe(true);
  });

  it("S16: the first row must be exactly the plan's names, in order; spaces at the ends do not matter", async () => {
    const ok = await run([file("t.csv", " Item , Units,Price\n1,2,3\n")], { columns: ["Item", "Units", "Price"] });
    expect(ok.problems).toEqual([]);
    const wrong = await run([file("t.csv", "Units,Item,Price\n1,2,3\n")], { columns: ["Item", "Units", "Price"] });
    expect(wrong.problems).toEqual(["“t.csv” has the columns Units, Item, Price, but the plan asks for Item, Units, Price."]);
    const extra = await run([file("t.csv", "Item,Units\n1,2\n"), file("other.csv", "Item,Units,Price\n")], { columns: ["Item", "Units", "Price"] });
    expect(extra.problems).toEqual([]);
  });

  it("S17: the number of data rows must be inside the range, and the blank last line does not count", async () => {
    const text = "a\n1\n2\n3\n";
    expect((await run([file("t.csv", text)], { rows: [3, 3] })).problems).toEqual([]);
    expect((await run([file("t.csv", text)], { rows: [4, 9] })).problems).toEqual(["“t.csv” has 3 rows; it should have 4 to 9."]);
    expect((await run([file("t.csv", "a\n1\n")], { rows: [2, 9] })).problems).toEqual(["“t.csv” has 1 row; it should have 2 to 9."]);
    expect((await run([file("t.csv", "a\n")], { rows: [0, 0] })).problems).toEqual([]);
  });

  it("S18: columns or rows in the plan and no table file changed", async () => {
    expect((await run([file("a.md", "# A\n\nText\n")], { columns: ["a"] })).problems).toEqual(["The plan asks for a table with columns or rows, but no table file changed."]);
    expect((await run([file("a.md", "# A\n\nText\n")], { rows: [1, 2] })).problems).toEqual(["The plan asks for a table with columns or rows, but no table file changed."]);
    expect((await run([file("a.md", "# A\n\nText\n"), file("t.csv", "a\n1\n")], { columns: ["a"] })).problems).toEqual([]);
  });

  it("S27: cells that a spreadsheet may run are refused, and the cell is never printed", async () => {
    const bad = ["=SUM(A1)", "@cmd", "\tx", "+x", "-x", "-cmd|' /C calc'!A0", "+1+1"];
    for (const cell of bad) {
      const r = await run([file("t.csv", `a,b\n"${cell.replaceAll('"', '""')}",2\n`)]);
      expect(r.problems, cell).toEqual(["Row 2, column “a” of “t.csv” starts with a character that a spreadsheet may run as a formula. Start it with a letter."]);
      expect(JSON.stringify(r)).not.toContain("SUM(A1)");
    }
    const ok = ["-3", "+2", "1,5", "1e3", "5%", "-1,234.56", "-0.5", "12", "-", "text", "x=1", " =spaced", "-2.5e-3"];
    for (const cell of ok) {
      const r = await run([file("t.csv", `a,b\n"${cell}",2\n`)]);
      expect(r.problems, cell).toEqual([]);
    }
  });

  it("S27 names the row and the column of a later cell", async () => {
    const r = await run([file("t.csv", "name,note\nann,fine\nbob,=HYPERLINK(x)\n")]);
    expect(r.problems).toEqual(["Row 3, column “note” of “t.csv” starts with a character that a spreadsheet may run as a formula. Start it with a letter."]);
  });
});

// ───────────────────────────── Pages: S19 to S22 ─────────────────────────────

describe("page rules, static", () => {
  const good = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Habits</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><img src="a.png" alt="A"><img src="b.png" alt=""></body></html>';

  it("a good page has no problem", () => {
    expect(checkPageStatic(file("index.html", good))).toEqual({ problems: [], facts: [] });
  });

  it("S19 no title, S20 no viewport line, S21 pictures without alt", () => {
    const r = checkPageStatic(file("index.html", '<!doctype html><body><img src="a.png"><img src="b.png"><img src="c.png" alt="ok"></body>'));
    expect(r.problems).toEqual([
      "“index.html” has no title.",
      "“index.html” has no setting for phone screens (a viewport line).",
      "“index.html” has 2 pictures with no description (alt text).",
    ]);
    expect(checkPageStatic(file("index.html", '<title>   </title><meta name=viewport content=x><img src=a.png>')).problems).toEqual(["“index.html” has no title.", "“index.html” has 1 picture with no description (alt text)."]);
  });

  const loads: [string, string][] = [
    ["an image", '<img src="https://cdn.example.org/a.png" alt="">'],
    ["a script", '<script src="http://cdn.example.org/a.js"></script>'],
    ["a protocol-relative script", '<script src="//cdn.example.org/a.js"></script>'],
    ["an iframe", '<iframe src="https://cdn.example.org/f"></iframe>'],
    ["a video", '<video src="https://cdn.example.org/v.mp4"></video>'],
    ["an audio", '<audio src="https://cdn.example.org/a.mp3"></audio>'],
    ["a source", '<source src="https://cdn.example.org/a.webm">'],
    ["an embed", '<embed src="https://cdn.example.org/e">'],
    ["an object", '<object data="https://cdn.example.org/o"></object>'],
    ["a form", '<form action="https://cdn.example.org/post"></form>'],
    ["a stylesheet link", '<link rel="stylesheet" href="https://cdn.example.org/a.css">'],
    ["an icon link", '<link rel="shortcut icon" href="https://cdn.example.org/a.ico">'],
    ["a preload link", '<link rel="preload" href="https://cdn.example.org/a.woff2" as="font">'],
    ["a meta refresh", '<meta http-equiv="refresh" content="0; url=https://cdn.example.org/next">'],
    ["a style block url", "<style>body{background:url('https://cdn.example.org/bg.png')}</style>"],
    ["a style block import", '<style>@import "https://cdn.example.org/a.css";</style>'],
    ["a style block import url", "<style>@import url(https://cdn.example.org/a.css);</style>"],
    ["a style attribute", '<p style="background:url(//cdn.example.org/x.png)">x</p>'],
    ["a tab inside the scheme", '<img src="ht\ttps://cdn.example.org/a.png" alt="">'],
    ["a backslash start", '<script src="\\\\cdn.example.org/a.js"></script>'],
  ];

  it.each(loads)("S22: %s from the internet fails", (_label, markup) => {
    const r = checkPageStatic(file("index.html", `<title>t</title><meta name="viewport" content="x">${markup}`));
    expect(r.problems).toEqual(["“index.html” loads something from the internet (“cdn.example.org”). A page must work without the internet."]);
  });

  it("S22 negative: links to the internet, relative files and data are fine", () => {
    const r = checkPageStatic(
      file("index.html", '<title>t</title><meta name="viewport" content="x"><a href="https://example.org">a</a><img src="a.png" alt=""><img src="data:image/png;base64,AAA" alt=""><link rel="canonical" href="https://example.org/"><style>p{background:url(a.png)}</style>'),
    );
    expect(r.problems).toEqual([]);
  });

  it("copes with tag names and entities that are names of things every object has", () => {
    const r = checkPageStatic(file("index.html", "<title>t</title><meta name=viewport content=x><constructor src=a.png><toString hidden>x</toString><__proto__ href=x>&toString; &valueOf; &constructor;<hasOwnProperty>y"));
    expect(r.problems).toEqual([]);
  });

  it("S22 applies to a style sheet and a drawing too", async () => {
    const css = await run([file("a.css", "@import url('https://fonts.example.org/x.css'); p{background:url(//cdn.example.org/y.png)}")]);
    expect(css.problems).toEqual([
      "“a.css” loads something from the internet (“fonts.example.org”). A page must work without the internet.",
      "“a.css” loads something from the internet (“cdn.example.org”). A page must work without the internet.",
    ]);
    const svg = await run([file("a.svg", '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://cdn.example.org/a.png"/><a href="https://example.org"><text>x</text></a></svg>')]);
    expect(svg.problems).toEqual(["“a.svg” loads something from the internet (“cdn.example.org”). A page must work without the internet."]);
  });
});

// ───────────────────────────── Pages: S23 to S26 ─────────────────────────────

function facts(over: Partial<PageFacts> = {}): PageFacts {
  return { title: "T", hasViewport: true, documentWidth: 390, windowWidth: 390, text: "Hello", brokenImages: 0, failedRequests: [], errors: [], ...over };
}

function rendered(phone: Partial<PageFacts> = {}, desktop: Partial<PageFacts> = {}): RenderedPage {
  return {
    path: "index.html",
    n: 1,
    phone: { width: "phone", file: "/x/p.png", facts: facts(phone) },
    desktop: { width: "desktop", file: "/x/d.png", facts: facts({ documentWidth: 1280, windowWidth: 1280, ...desktop }) },
  };
}

describe("page rules, drawn", () => {
  it("a good page has no problem", () => {
    expect(checkPageRendered(rendered())).toEqual({ problems: [], facts: [] });
  });

  it("S23 a blank page at either width", () => {
    expect(checkPageRendered(rendered({ text: "  \n" })).problems).toEqual(["“index.html” shows nothing: the page is blank."]);
    expect(checkPageRendered(rendered({}, { text: "" })).problems).toEqual(["“index.html” shows nothing: the page is blank."]);
  });

  it("S24 a page wider than the screen at phone width, and not at desktop width", () => {
    expect(checkPageRendered(rendered({ documentWidth: 900 })).problems).toEqual(["At phone width (390 pixels), “index.html” is wider than the screen (900 pixels), so it scrolls sideways."]);
    expect(checkPageRendered(rendered({}, { documentWidth: 1500 })).problems).toEqual([]);
  });

  it("S25 files it could not load", () => {
    const r = checkPageRendered(rendered({ failedRequests: ["a.css", "b.js", "c.png"] }, { failedRequests: ["a.css"] }));
    expect(r.problems).toEqual(["“index.html” could not load 3 of the files it uses (a.css, b.js), so it will look different from what was meant."]);
  });

  it("S26 an error when it loads, cut at 100 characters", () => {
    const r = checkPageRendered(rendered({ errors: ["x".repeat(300), "y"] }));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.startsWith("“index.html” shows an error when it loads: xxx")).toBe(true);
    expect(r.problems[0]!.length).toBeLessThan(160);
  });

  it("S08 and S09 are run again on the text the browser shows", () => {
    const page = rendered({ text: "Hello Get started", headings: ["Welcome"] }, { text: "Hello Get started", headings: ["Welcome"] });
    expect(checkPageRendered(page, { expect: { headings: ["welcome"], mentions: ["Get started"] } }).problems).toEqual([]);
    expect(checkPageRendered(page, { expect: { headings: ["Goodbye"], mentions: ["Nowhere"] } }).problems).toEqual(["The text has no heading called “Goodbye”.", "The visible text does not contain “Nowhere”."]);
  });

  it("with factsOnly (a page found by the fallback) every finding is a fact", () => {
    const r = checkPageRendered(rendered({ documentWidth: 900, text: "", errors: ["boom"] }), { factsOnly: true });
    expect(r.problems).toEqual([]);
    expect(r.facts).toHaveLength(3);
  });

  it("a page that was not drawn has nothing to judge", () => {
    expect(checkPageRendered({ path: "a.html", n: 1, why: "no_browser" })).toEqual({ problems: [], facts: [] });
  });
});

describe("S28, the project's own checks", () => {
  it("builds the problem from the first lines the checks print, cut at 300 characters", () => {
    expect(projectChecksProblem("FAIL src/a.test.ts\n  expected 1 to be 2\n")).toBe("The project's own checks fail after this change. The first lines they print: FAIL src/a.test.ts expected 1 to be 2.");
    const long = projectChecksProblem(`${"x".repeat(100)}\n${"y".repeat(100)}\n${"z".repeat(100)}\n${"w".repeat(100)}`);
    const printed = long.slice("The project's own checks fail after this change. The first lines they print: ".length, -1);
    expect(printed.length).toBeLessThanOrEqual(300);
    expect(long.endsWith(".")).toBe(true);
  });

  it("shows hidden characters in the output as code points and keeps the curly marks in pairs", () => {
    const out = projectChecksProblem(`bad${String.fromCodePoint(0x202e)}line\nsaid “hi”`);
    expect(out).toContain("bad<U+202E>line");
    expect(out).toContain('said "hi"');
    expect(projectChecksProblem("")).toBe("The project's own checks fail after this change. The first lines they print: (nothing was printed).");
  });
});

// ───────────────────────────── S29, the merge helper, the cap ─────────────────────────────

describe("S29 and the cap", () => {
  it("S29: more than 60 seconds in all is a problem, tested between files", async () => {
    let t = 0;
    const slow = await checkDeliverables({ deliverables: dels([file("a.md", "# A\n\nText\n"), file("b.md", "# B\n\nText\n")]), now: () => (t += 61_000) });
    expect(slow.problems).toEqual(["Checking the files took too long (over 60 seconds). Make the files smaller or fewer."]);
    const fast = await checkDeliverables({ deliverables: dels([file("a.md", "# A\n\nText\n")]), now: () => 0 });
    expect(fast.problems).toEqual([]);
  });

  it("keeps at most ten problems of at most 200 characters, then a count; the lowest rules first", async () => {
    const files: DeliverableFile[] = [];
    for (let i = 0; i < 15; i++) files.push(file(`f${i}-${"long".repeat(30)}.md`, ""));
    const r = await run(files);
    expect(r.problems).toHaveLength(11);
    expect(r.problems[10]).toBe("and 5 more.");
    for (const p of r.problems.slice(0, 10)) expect(p.length).toBeLessThanOrEqual(200);
  });

  it("mergeOutcomes puts outcomes together without repeating a message and re-counts the rest", () => {
    const a = { problems: ["x", "y"], facts: ["f"] };
    const b = { problems: ["y", "z"], facts: ["f", "g"] };
    expect(mergeOutcomes(a, b)).toEqual({ problems: ["x", "y", "z"], facts: ["f", "g"] });
    const big = { problems: Array.from({ length: 12 }, (_, i) => `p${i}`), facts: [] };
    const merged = mergeOutcomes(big, { problems: ["and 4 more."], facts: [] });
    expect(merged.problems).toHaveLength(11);
    expect(merged.problems[10]).toBe("and 6 more.");
  });
});

// ───────────────────────────── Speed and the event loop (6.5) ─────────────────────────────

describe("speed: each shape finishes in under 5 seconds and the event loop keeps turning", () => {
  /** Runs the checks while a timer ticks every 5 ms; `gap` is the longest time the event loop went without a turn (the run lock's heartbeat is every 60 s). */
  async function timed(files: DeliverableFile[], expectKeys?: FeatureExpect) {
    let ticks = 0;
    const start = Date.now();
    let last = start;
    let gap = 0;
    const timer = setInterval(() => {
      ticks++;
      const t = Date.now();
      gap = Math.max(gap, t - last);
      last = t;
    }, 5);
    const result = await checkDeliverables({ deliverables: dels(files), expect: expectKeys });
    const elapsed = Date.now() - start;
    gap = Math.max(gap, Date.now() - last);
    clearInterval(timer);
    return { result, elapsed, ticks, gap };
  }

  const MB = 1024 * 1024 - 100;
  const shapes: [string, string, string][] = [
    ["500,000 open brackets", "a.md", "[".repeat(500_000)],
    ["250,000 link starts", "a.md", "[a](".repeat(250_000)],
    ["250,000 h1 tags in a page", "a.html", "<h1>".repeat(250_000)],
    ["125,000 script starts in a page", "a.html", "<script>".repeat(125_000)],
    ["250,000 comment starts in a page", "a.html", "<!--".repeat(250_000)],
    ["a 1 MB line of <", "a.html", "<".repeat(MB)],
    ["a 1 MB line of < in markdown", "a.md", "<".repeat(MB)],
    ["a 200,000-character run inside a link", "a.md", `[x](${"a".repeat(200_000)})`],
    ["many 1,999-character lines of link starts", "a.md", ("[a](".repeat(499) + "\n").repeat(500)],
    ["many 1,999-character lines of open brackets", "a.md", ("[".repeat(1999) + "\n").repeat(500)],
    ["many lines of backticks", "a.md", ("`a``b```".repeat(249) + "\n").repeat(500)],
    ["many comment starts per line in markdown", "a.md", ("<!--x".repeat(399) + "\n").repeat(500)],
    ["a million blank lines", "a.md", "\n".repeat(1_000_000) + "x"],
    ["a 1 MB line of web token starts", "a.md", "eyJ".repeat(330_000)],
    ["a 1 MB line of key starts", "a.txt", "ghp_sk-AKIA://a:".repeat(60_000)],
    ["a 1 MB line of url( in a style sheet", "a.css", "url(".repeat(250_000)],
    ["a 1 MB line of quotes in a table", "a.csv", '"'.repeat(MB)],
    ["a 1 MB line of < tags that never end in a page", "a.html", "<a ".repeat(330_000)],
    ["nested divs closed by the wrong tag", "a.html", "<div>".repeat(100_000) + "</p>".repeat(100_000)],
    ["1 MB of stars", "a.md", "*".repeat(MB)],
    ["1 MB of underscores and tildes", "a.md", "_~".repeat(MB / 2)],
  ];

  it.each(shapes)("%s", async (_label, name, text) => {
    const { elapsed, ticks, gap } = await timed([file(name, text)], { headings: ["x"], mentions: ["y"], words: [1, 2], columns: ["a"], rows: [1, 2] });
    expect(elapsed).toBeLessThan(5000);
    // The timer fires while the checks run: a run that lasts long enough for a tick has one, and the loop is never blocked for long.
    if (elapsed >= 50) expect(ticks).toBeGreaterThan(0);
    expect(gap).toBeLessThan(2000);
  });

  it("60 files of 1 MB: the read stops at 12 MB and the checks stay under 5 seconds", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`f${String(i).padStart(2, "0")}.md`] = ("word ".repeat(1000) + "\n").repeat(200).slice(0, 1024 * 1024 - 10);
    const dir = tree(files);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const start = Date.now();
    const { deliverables, check } = await scan(dir, Object.keys(files), { expect: { mentions: ["nothing"], words: [1, 2] } });
    clearInterval(timer);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    if (elapsed >= 50) expect(ticks).toBeGreaterThan(0);
    expect(deliverables.files.length).toBeLessThanOrEqual(12);
    expect(check.facts.some((f) => /more files changed and were not looked at/.test(f))).toBe(true);
  });

  // V1-5: a file with hundreds of thousands of findings of one kind used to make the whole check throw a RangeError (the list of findings
  // was handed to `push` as arguments), so the feature was blocked at once with `internal error: Maximum call stack size exceeded`.
  const FLOOD = 300_000;
  const PAGE = (body: string): string => `<!doctype html><title>t</title><meta name="viewport" content="x"><body>${body}</body>`;
  const floods: [string, string, string, string][] = [
    ["a blank to fill in", "a.md", "[name]\n".repeat(FLOOD), "“a.md” still has placeholder text (“[name]”)."],
    ["a TODO line", "a.md", "TODO\n".repeat(FLOOD), "“a.md” still has placeholder text (“TODO”)."],
    ["a TODO line", "a.txt", "TODO\n".repeat(FLOOD), "“a.txt” still has placeholder text (“TODO”)."],
    ["a blank to fill in", "a.html", PAGE("<p>[name]</p>\n".repeat(FLOOD)), "“a.html” still has placeholder text (“[name]”)."],
    ["a key-shaped string", "a.txt", 'password = "hunter2-hunter2"\n'.repeat(FLOOD), "“a.txt” has text that looks like a key or a password (line 1). Remove it."],
  ];

  it.each(floods)("a flood of %s (%#) in %s: a normal problem list, no internal error", async (_label, name, text, problem) => {
    const r = await run([file(name, text)]);
    expect(r.problems[0], r.problems.join("\n")).toBe(problem);
    expect(r.problems.length).toBeLessThanOrEqual(11);
  }, 60_000);

  it("a file just under the 1 MB limit, with 209,000 TODO lines, read the way the engine reads it: a normal problem list", async () => {
    const dir = tree({ "a.md": "TODO\n".repeat(209_000) });
    const { check } = await scan(dir, ["a.md"]);
    expect(check.problems).toEqual(["“a.md” still has placeholder text (“TODO”)."]);
  }, 60_000);

  it("140,000 links to a file that is not there, read the way the engine reads them: one problem for the link", async () => {
    const dir = tree({ "a.md": "[a](g)\n".repeat(140_000), "b.html": PAGE('<a href="gone.html">x</a>\n'.repeat(30_000)) });
    const { check } = await scan(dir, ["a.md", "b.html"]);
    expect(check.problems).toContain("The link to “g” in “a.md” does not lead to a file in the project.");
    expect(check.problems).toContain("The link to “gone.html” in “b.html” does not lead to a file in the project.");
  }, 60_000);

  it("a very long markdown line is not scanned and a fact says so", async () => {
    const r = await run([file("a.md", `# A\n\n${"[a](x.md) ".repeat(500)}\n`)]);
    expect(r.facts).toContain("A very long line of “a.md” was not scanned (line 3).");
  });
});

// ───────────────────────────── A seeded fuzz of checkDeliverables ─────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHAPES: RegExp[] = [
  /^It changed no files\.$/,
  /^“[\s\S]*” is empty\.$/,
  /^“[\s\S]*” is larger than [15] MB, which is too big for a document, a page or a data file\.$/,
  /^“[\s\S]*” has text that looks like a key or a password \(line \d+\)\. Remove it\.$/,
  /^“[\s\S]*” still has placeholder text \(“[\s\S]*”\)\.$/,
  /^The link to “[\s\S]*” in “[\s\S]*” does not lead to a file in the project\.$/,
  /^The link to the heading “#[\s\S]*” in “[\s\S]*” does not lead to a heading\.$/,
  /^The link to the heading “#[\s\S]*” in “[\s\S]*” \(from “[\s\S]*”\) does not lead to a heading\.$/,
  /^The text has no heading called “[\s\S]*”\.$/,
  /^The visible text does not contain “[\s\S]*”\.$/,
  /^The new text has \d+ words?; it should have \d+ to \d+\.$/,
  /^“[\s\S]*” is not a valid table: a quote mark is opened and never closed\.$/,
  /^“[\s\S]*” has no header row\.$/,
  /^“[\s\S]*” has a column with no name in its first row\.$/,
  /^“[\s\S]*” has two columns called “[\s\S]*”\.$/,
  /^Row \d+ of “[\s\S]*” has \d+ values?, but the first row has \d+\.$/,
  /^\d+ more rows? of “[\s\S]*” (?:has|have) the wrong number of values\.$/,
  /^“[\s\S]*” has the columns [\s\S]*, but the plan asks for [\s\S]*\.$/,
  /^“[\s\S]*” has \d+ rows?; it should have \d+ to \d+\.$/,
  /^The plan asks for a table with columns or rows, but no table file changed\.$/,
  /^“[\s\S]*” has no title\.$/,
  /^“[\s\S]*” has no setting for phone screens \(a viewport line\)\.$/,
  /^“[\s\S]*” has \d+ pictures? with no description \(alt text\)\.$/,
  /^“[\s\S]*” loads something from the internet \(“[\s\S]*”\)\. A page must work without the internet\.$/,
  /^Row \d+, column “[\s\S]*” of “[\s\S]*” starts with a character that a spreadsheet may run as a formula\. Start it with a letter\.$/,
  /^Checking the files took too long \(over 60 seconds\)\. Make the files smaller or fewer\.$/,
  /^and \d+ more\.$/,
];

describe("a seeded fuzz of checkDeliverables", () => {
  const frags = [
    "# Title", "## Install", "Setup\n=====", "[a](b.md)", "[x](#nowhere)", "![p](pic.png)", "`code`", "```\nfenced\n```", "<!-- c -->", "<b>bold</b>", "<div hidden>h</div>",
    "TODO later", "lorem ipsum", "[insert name]", "a,b\n1,2", '"q,"', "=1+1", "<title>T</title>", '<meta name="viewport" content="x">', '<img src="https://x.example/a.png">',
    "<script>var a=1;</script>", "<style>p{}</style>", "<h1>Head</h1>", "<a href='z.html'>z</a>", "word word word", "\n\n", "  ", "\t", "[", "](", "<", ">", "&amp;", "&#x41;", "\u202e", "ü", "e\u0301",
    "https://example.org/x", "//cdn.example.org/y", "*", "_", "~~", "|", "\r\n", "\r", "x".repeat(2500), "-----BEGIN", "password: abc", "<!--", "-->", "<![CDATA[x]]>", "<?xml?>",
    "<constructor a=1>", "<toString>", "&valueOf;", "<__proto__>", "<hasOwnProperty hidden>", "&toString;",
  ];
  const names = ["a.md", "b.markdown", "c.txt", "d.html", "e.htm", "f.csv", "g.css", "h.svg", "i.json", "dir/j.md", `n\nl.md`, `rtl${String.fromCodePoint(0x202e)}.md`, `${"v".repeat(400)}.md`, "q\"uote“d.md"];
  const wants: FeatureExpect[] = [{}, { headings: ["Install", "x"], mentions: ["word", "Head"] }, { words: [1, 50], columns: ["a", "b"], rows: [1, 3] }];

  async function oneCase(seed: number) {
    const rnd = mulberry32(seed);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const count = 1 + Math.floor(rnd() * 3);
    const files: DeliverableFile[] = [];
    for (let i = 0; i < count; i++) {
      const parts: string[] = [];
      const n = Math.floor(rnd() * 25);
      for (let k = 0; k < n; k++) parts.push(pick(frags));
      const text = parts.join(rnd() < 0.5 ? "\n" : " ");
      files.push(file(`${i}${pick(names)}`, text));
    }
    const want = pick(wants);
    return { files, want, run: () => checkDeliverables({ deliverables: dels(files), expect: want }) };
  }

  it("never throws, gives the same result twice, uses only the known messages, and cleans every name", async () => {
    const hidden = /[\p{Cc}\p{Cf}]/u;
    for (let seed = 1; seed <= 2000; seed++) {
      const c = await oneCase(seed);
      const first = await c.run();
      const second = await c.run();
      expect(second, `seed ${seed}`).toEqual(first);
      expect(first.pass).toBe(first.problems.length === 0);
      expect(first.problems.length).toBeLessThanOrEqual(11);
      for (const p of first.problems) {
        expect(SHAPES.some((s) => s.test(p)), `seed ${seed}: ${p}`).toBe(true);
        expect(p.length, `seed ${seed}: ${p}`).toBeLessThanOrEqual(200);
        expect(hidden.test(p), `seed ${seed}: ${JSON.stringify(p)}`).toBe(false);
      }
      for (const f of first.facts) expect(hidden.test(f), `seed ${seed} fact ${JSON.stringify(f)}`).toBe(false);
    }
  }, 120_000);
});

describe("a seeded fuzz on disk: links, loops and odd names never lead outside the folder", () => {
  it("reads and checks random trees with symbolic links, and every path it asks about is inside the folder", async () => {
    const outside = tree({ "o1.md": "# Outside one\n\nOUTSIDE\n", "dir/o2.md": "# Outside two\n", "o3.html": "<title>o</title>" });
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = mulberry32(seed * 7919);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const dir = tree({ "base.md": "# Base\n\n## Part\n", "sub/inner.md": "# Inner\n" });
      const changed: string[] = ["base.md", "sub/inner.md", "missing.md"];
      const targets = [join(outside, "o1.md"), join(outside, "dir"), join(outside, "o3.html"), join(dir, "base.md"), join(dir, "sub"), "base.md", "../o1.md", "loop-b", "loop-a", "/etc/hostname", "nowhere", dir, ".."];
      for (let i = 0; i < 8; i++) {
        const name = `${pick(["l", "docs/l", "sub/l", "x y/l"])}${i}${pick([".md", ".html", ".csv", ".txt", ""])}`;
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        try {
          symlinkSync(pick(targets), join(dir, name));
        } catch {
          // A name that is already taken.
        }
        changed.push(name, `${name}/inner.md`, `${name}/../base.md`);
      }
      writeFileSync(join(dir, "README.md"), ["# Readme", "", ...Array.from({ length: 10 }, (_, i) => `[l${i}](${pick(changed)}#part) ![p](${pick(changed)})`)].join("\n"));
      changed.push("README.md");
      spy.calls = [];
      spy.on = true;
      let result;
      try {
        result = await scan(dir, changed, { expect: { headings: ["Part"], mentions: ["OUTSIDE"], words: [1, 50] } });
      } finally {
        spy.on = false;
      }
      for (const call of spy.calls) {
        const path = call.slice(call.indexOf(" ") + 1);
        expect(path.startsWith(dir), `seed ${seed}: ${call}`).toBe(true);
      }
      expect(JSON.stringify(result.check), `seed ${seed}`).not.toContain("Outside one");
      // The text of a file outside the folder never reaches the files that were read.
      for (const f of result.deliverables.files) expect(f.text ?? "", `seed ${seed}`).not.toContain("OUTSIDE");
    }
  }, 60_000);
});

// ───────────────────────────── judgeRubric (8.3) ─────────────────────────────

describe("judgeRubric", () => {
  const checks = ["The guide has numbered steps.", "The guide says how to start the app.", "The guide explains the first habit."];
  const guide = "# Setup\n\n1. Run the installer.\n2. Start the app with the **start** command.\n\nAdd your first habit with the button.\n";
  const WT = "/work/tree";

  function answer(over: Partial<RubricOutput["results"][number]>[] = [], extra: Partial<RubricOutput> = {}): RubricOutput {
    const base = checks.map((check, i) => ({
      number: i + 1,
      check,
      result: "pass" as const,
      evidence: i === 0 ? 'It says “1. Run the installer.” in docs/setup.md' : i === 1 ? 'It says "Start the app with the start command" in docs/setup.md' : 'The text “Add your first habit with the button.” is in docs/setup.md',
      basis: "text" as const,
    }));
    return { verdict: "approve", results: base.map((b, i) => ({ ...b, ...(over[i] ?? {}) })), seen: ["docs/setup.md"], notes: [], ...extra };
  }

  function input(a: RubricOutput, over: Partial<RubricInput> = {}): RubricInput {
    return { answer: a, checks, changedFiles: ["docs/setup.md"], changedText: [guide], pageText: [], family: "claude", opened: [`${WT}/docs/setup.md`], worktree: WT, pictures: [], ...over };
  }

  function ok(j: ReturnType<typeof judgeRubric>) {
    if (!j.ok) throw new Error(`not ok: ${j.problem}`);
    return j;
  }

  it("a complete honest answer passes every check, with a computed verdict and no notes", () => {
    const j = ok(judgeRubric(input(answer())));
    expect(j.results.map((r) => r.result)).toEqual(["pass", "pass", "pass"]);
    expect(j.results.map((r) => r.n)).toEqual([1, 2, 3]);
    expect(j.verdict).toBe("approve");
    expect(j.unjudged).toBe(0);
    expect(j.downgraded).toBe(0);
    expect(j.findings).toEqual([]);
    expect(j.seen).toEqual(["docs/setup.md"]);
    expect(j.lookNotes).toEqual([]);
  });

  it("asks again when a number is missing, repeated or extra, or a result is absent", () => {
    const a = answer();
    const missing = judgeRubric(input({ ...a, results: a.results.slice(0, 2) }));
    expect(missing).toMatchObject({ ok: false });
    expect(!missing.ok && missing.problem).toMatch(/no result for check 3/);
    const repeated = judgeRubric(input({ ...a, results: [a.results[0]!, a.results[0]!, a.results[1]!, a.results[2]!] }));
    expect(!repeated.ok && repeated.problem).toMatch(/more than one result for check 1/);
    const extra = judgeRubric(input({ ...a, results: [...a.results, { ...a.results[0]!, number: 9 }] }));
    expect(!extra.ok && extra.problem).toMatch(/not in the list: 9/);
    const wrong = judgeRubric(input({ ...a, results: [{ ...a.results[0]!, number: 0 }, a.results[1]!, a.results[2]!] }));
    expect(wrong.ok).toBe(false);
  });

  it("cuts `seen` down to what a Claude run really opened and says so", () => {
    const j = ok(judgeRubric(input(answer([], { seen: ["docs/setup.md", "docs/other.md", "/etc/hosts"] }))));
    expect(j.seen).toEqual(["docs/setup.md"]);
    expect(j.lookNotes).toEqual(["The second AI named a file it did not open."]);
  });

  it("compares paths once the worktree is taken off, either way round", () => {
    const j = ok(judgeRubric(input(answer([], { seen: [`${WT}/docs/setup.md`] }), { opened: ["docs/setup.md"] })));
    expect(j.seen).toEqual(["docs/setup.md"]);
    const k = ok(judgeRubric(input(answer([], { seen: ["setup.md"] }), { changedFiles: ["docs/setup.md"], opened: [`${WT}/docs/setup.md`] })));
    expect(k.seen).toEqual(["setup.md"]);
  });

  it("asks again when `seen` names none of the changed files", () => {
    const j = judgeRubric(input(answer([], { seen: ["README.md"] }), { opened: [`${WT}/README.md`] }));
    expect(j.ok).toBe(false);
    const empty = judgeRubric(input(answer([], { seen: [] })));
    expect(empty.ok).toBe(false);
    const noFiles = ok(judgeRubric(input(answer([], { seen: [] }), { changedFiles: [] })));
    expect(noFiles.seen).toEqual([]);
  });

  it("takes `seen` as stated when the run cannot tell (no `opened`), and says that it could not check", () => {
    const j = ok(judgeRubric(input(answer([], { seen: ["docs/setup.md", "docs/other.md"] }), { opened: undefined, family: "codex" })));
    expect(j.seen).toEqual(["docs/setup.md", "docs/other.md"]);
    expect(j.lookNotes).toEqual(["What the second AI opened could not be checked."]);
  });

  it("downgrades a pass with evidence of 11 characters, but not one of 12", () => {
    const short = ok(judgeRubric(input(answer([{ evidence: "Looks good!" }]))));
    expect(short.results[0]).toMatchObject({ result: "cannot_judge", evidence: "No evidence was given." });
    expect(short.downgraded).toBe(1);
    expect(short.unjudged).toBe(1);
    expect(short.verdict).toBe("changes");
    const twelve = ok(judgeRubric(input(answer([{ evidence: "Looks good!!" }]))));
    expect(twelve.results[0]!.result).toBe("pass");
  });

  it("downgrades a pass whose quote is not in the files, and keeps one that is", () => {
    const j = ok(judgeRubric(input(answer([{ evidence: 'It says “Install with the magic wand” in docs/setup.md' }]))));
    expect(j.results[0]!.result).toBe("cannot_judge");
    expect(j.results[0]!.evidence.startsWith("The quote was not found in the files.")).toBe(true);
    expect(j.downgraded).toBe(1);
  });

  it("finds a quote with straight or curly marks, with markdown marks, a link, an ellipsis, or from the drawn page", () => {
    const text = "# Setup\n\nThe **fast** way: see [the guide](docs/guide.md) now. Then `run it` and enjoy the result today.\n";
    const quotes = [
      '“The fast way: see the guide now.”',
      '"The **fast** way: see [the guide](docs/guide.md) now."',
      '“The fast way ... enjoy the result today”',
      '“Then run it and enjoy the result today.”',
    ];
    for (const q of quotes) {
      const j = ok(judgeRubric(input(answer([{ evidence: `It says ${q} in docs/setup.md` }]), { changedText: [text] })));
      expect(j.results[0]!.result, q).toBe("pass");
    }
    const page = ok(judgeRubric(input(answer([{ evidence: 'The page shows “Welcome to the habit tracker” as its headline' }]), { pageText: ["Welcome to the habit tracker. Get started."] })));
    expect(page.results[0]!.result).toBe("pass");
  });

  it("finds a quote from an unchanged file that `seen` names, through readSeen", () => {
    const a = answer([{ evidence: 'The project has “src/main.ts” and says “export const answer = 42;” there' }], { seen: ["docs/setup.md", "src/main.ts"] });
    const withRead = ok(judgeRubric(input(a, { opened: [`${WT}/docs/setup.md`, `${WT}/src/main.ts`], readSeen: (n) => (n === "src/main.ts" ? "export const answer = 42;\n" : undefined) })));
    expect(withRead.results[0]!.result).toBe("pass");
    const without = ok(judgeRubric(input(a, { opened: [`${WT}/docs/setup.md`, `${WT}/src/main.ts`] })));
    expect(without.results[0]!.result).toBe("cannot_judge");
  });

  it("does not hold a quote of 7 characters or a file name in quotes to the files", () => {
    const j = ok(judgeRubric(input(answer([{ evidence: 'It says “nothing” and names “docs/setup.md” as its file' }]))));
    expect(j.results[0]!.result).toBe("pass");
  });

  it("a quote that is not in the files is not downgraded on a fail", () => {
    const j = ok(judgeRubric(input(answer([{ result: "fail", evidence: 'It never says “Install with the magic wand” anywhere' }]))));
    expect(j.results[0]!.result).toBe("fail");
    expect(j.downgraded).toBe(0);
  });

  const pic = `${WT.replace("/tree", "")}/mission/screenshots/look__f__1__index__phone.png`;
  const picAnswer = () => answer([{ basis: "picture", evidence: "The picture shows one column and readable text on a phone" }]);

  it("keeps a picture-basis pass only when pictures were offered, a Claude run answered and a picture was opened", () => {
    const base = { pictures: [pic], opened: [`${WT}/docs/setup.md`, pic] };
    expect(ok(judgeRubric(input(picAnswer(), base))).results[0]!.result).toBe("pass");
    const notOpened = ok(judgeRubric(input(picAnswer(), { ...base, opened: [`${WT}/docs/setup.md`] })));
    expect(notOpened.results[0]).toMatchObject({ result: "cannot_judge", evidence: "No picture was opened by the second AI." });
    expect(notOpened.downgraded).toBe(1);
    const codex = ok(judgeRubric(input(picAnswer(), { ...base, family: "codex" })));
    expect(codex.results[0]!.result).toBe("cannot_judge");
    const none = ok(judgeRubric(input(picAnswer(), { pictures: [] })));
    expect(none.results[0]!.result).toBe("cannot_judge");
    const noOpened = ok(judgeRubric(input(picAnswer(), { ...base, opened: undefined })));
    expect(noOpened.results[0]!.result).toBe("cannot_judge");
  });

  it("always keeps a picture-basis fail", () => {
    const a = answer([{ basis: "picture", result: "fail", evidence: "Text runs off the right edge" }]);
    const j = ok(judgeRubric(input(a, { pictures: [], family: "codex", opened: undefined })));
    expect(j.results[0]).toMatchObject({ result: "fail", basis: "picture" });
    expect(j.downgraded).toBe(0);
  });

  it("computes the verdict and ignores the one in the answer", () => {
    const j = ok(judgeRubric(input(answer([{ result: "fail", evidence: "It does not start the app." }], { verdict: "approve" }))));
    expect(j.verdict).toBe("changes");
    const all = ok(judgeRubric(input(answer([], { verdict: "changes" }))));
    expect(all.verdict).toBe("approve");
  });

  it("maps a fail to a major finding, a major note to a major finding with its file, a minor note to a small one", () => {
    const a = answer([{ result: "fail", evidence: "It never says what the reader should see." }], {
      notes: [
        { severity: "major", file: "docs/setup.md", description: "A link is broken." },
        { severity: "minor", file: null, description: "A comma is missing." },
      ],
    });
    const j = ok(judgeRubric(input(a)));
    expect(j.findings).toEqual([
      { severity: "major", file: null, description: "Check 1 is not met: The guide has numbered steps. The second AI found: It never says what the reader should see.", suggestedTest: null },
      { severity: "major", file: "docs/setup.md", description: "A link is broken.", suggestedTest: null },
    ]);
    expect(j.minorFindings).toEqual([{ severity: "minor", file: null, description: "A comma is missing.", suggestedTest: null }]);
  });

  it("V2-07: the check, a full stop and the evidence read as two sentences, whether or not the check ends with a full stop", () => {
    const fail = { result: "fail" as const, evidence: "It never says what the reader should see." };
    const descriptions = (list: string[]): string[] =>
      ok(judgeRubric(input(answer([fail]), { checks: list }))).findings.map((f) => f.description);
    const tail = "The second AI found: It never says what the reader should see.";
    expect(descriptions(["The guide has numbered steps.", "b", "c"])).toEqual([`Check 1 is not met: The guide has numbered steps. ${tail}`]);
    expect(descriptions(["The guide has numbered steps", "b", "c"])).toEqual([`Check 1 is not met: The guide has numbered steps. ${tail}`]);
    expect(descriptions(["Does the guide have steps?", "b", "c"])).toEqual([`Check 1 is not met: Does the guide have steps? ${tail}`]);
    expect(descriptions(["It reads well and more…", "b", "c"])).toEqual([`Check 1 is not met: It reads well and more… ${tail}`]);
    expect(descriptions(["  The guide has numbered steps.  ", "b", "c"])).toEqual([`Check 1 is not met: The guide has numbered steps. ${tail}`]);
    for (const d of descriptions(["The guide has numbered steps.", "b", "c"])) expect(d).not.toContain("..");
  });

  it("V2-10: the evidence and the notes lose pictures, links and web addresses, and keep their words", () => {
    const hostile = `It says “1. Run the installer.” ![chart](https://evil.example/x.png) and [click here](http://evil.example/p) or //evil.example/a, www.evil.example/b.`;
    const j = ok(judgeRubric(input(answer([{ evidence: hostile }, { result: "fail", evidence: hostile }], { notes: [{ severity: "major", file: "docs/setup.md", description: hostile }, { severity: "minor", file: null, description: hostile }] }))));
    const clean = "It says “1. Run the installer.” chart (web address removed) and click here (web address removed) or (web address removed), (web address removed).";
    expect(j.results.map((r) => r.evidence).slice(0, 2)).toEqual([clean, clean]);
    expect(j.findings.map((f) => f.description)).toEqual([`Check 2 is not met: The guide says how to start the app. The second AI found: ${clean}`, clean]);
    expect(j.minorFindings.map((f) => f.description)).toEqual([clean]);
    expect(JSON.stringify(j)).not.toMatch(/evil\.example|!\[|\]\(/u);
  });

  it("W2d-R2: the file of a note loses pictures, links and web addresses too, and keeps hidden characters shown as code points", () => {
    const hostileFile = "a`` ![p](https://evil.example/p.png) [c](https://evil.example/c) `` b";
    const j = ok(judgeRubric(input(answer([], { notes: [{ severity: "major", file: hostileFile, description: "A link is broken." }, { severity: "minor", file: hostileFile, description: "A comma is missing." }, { severity: "minor", file: `docs/setup.md${String.fromCodePoint(0x202e)}`, description: "Another." }] }))));
    const clean = "a`` p (web address removed) c (web address removed) `` b";
    expect(j.findings.map((f) => f.file)).toEqual([clean]);
    expect(j.minorFindings.map((f) => f.file)).toEqual([clean, "docs/setup.md<U+202E>"]);
    expect(JSON.stringify(j)).not.toMatch(/evil\.example|!\[|\]\(/u);
    // A bare address is a file name that is not a file: it is made plain too, and the cut at 200 characters holds after the change.
    const bare = ok(judgeRubric(input(answer([], { notes: [{ severity: "minor", file: `https://evil.example/${"x".repeat(300)}`, description: "d" }] }))));
    expect(bare.minorFindings[0]!.file).toBe("(web address removed)");
    const long = ok(judgeRubric(input(answer([], { notes: [{ severity: "minor", file: `${"[a](https://evil.example/c)".repeat(5)}`, description: "d" }] }))));
    expect(long.minorFindings[0]!.file!.length).toBeLessThanOrEqual(200);
    // An ordinary file name is untouched.
    const plain = ok(judgeRubric(input(answer([], { notes: [{ severity: "minor", file: "docs/my notes (2).md", description: "d" }] }))));
    expect(plain.minorFindings[0]!.file).toBe("docs/my notes (2).md");
  });

  it("V2-10: a quote is still looked for in the files as the second AI wrote it, so cleaning does not change what passes", () => {
    // The quote is real, and the evidence also holds an address: the pass stands.
    const real = ok(judgeRubric(input(answer([{ evidence: "It says “1. Run the installer.” and links to https://evil.example/x" }]))));
    expect(real.results[0]).toMatchObject({ result: "pass", evidence: "It says “1. Run the installer.” and links to (web address removed)" });
    // The quote is made up: the pass is still turned down.
    const made = ok(judgeRubric(input(answer([{ evidence: "It says “Install with the magic wand” and links to https://evil.example/x" }]))));
    expect(made.results[0]).toMatchObject({ result: "cannot_judge" });
    expect(made.results[0]!.evidence.startsWith("The quote was not found in the files.")).toBe(true);
  });

  it("cleans the evidence of control and hidden characters and cuts it at 300 characters", () => {
    const evil = `Fine\nline${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x200b)} ${"x".repeat(600)}`;
    const j = ok(judgeRubric(input(answer([{ result: "fail", evidence: evil }]))));
    const ev = j.results[0]!.evidence;
    expect(ev.length).toBeLessThanOrEqual(300);
    expect(ev.startsWith("Fine line ")).toBe(true);
    expect(/[\p{Cc}\p{Cf}]/u.test(ev)).toBe(false);
  });

  it("counts every downgrade", () => {
    const j = ok(judgeRubric(input(answer([{ evidence: "short" }, { evidence: 'It says “nothing like this exists” here' }, { basis: "picture", evidence: "A long enough description of a picture" }]))));
    expect(j.downgraded).toBe(3);
    expect(j.unjudged).toBe(3);
  });
});
