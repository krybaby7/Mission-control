import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendJsonl,
  ensureDir,
  expandHome,
  readJson,
  readJsonl,
  readJsonOr,
  sha256,
  sha256File,
  writeJsonAtomic,
} from "./fs.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-fs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeJsonAtomic / readJson", () => {
  it("writes pretty JSON with a trailing newline and reads it back", () => {
    const file = join(dir, "state.json");
    const data = { id: "m1", list: [1, 2], nested: { ok: true } };
    writeJsonAtomic(file, data);
    expect(readFileSync(file, "utf8")).toBe(JSON.stringify(data, null, 2) + "\n");
    expect(readJson<typeof data>(file)).toEqual(data);
  });

  it("creates missing parent directories", () => {
    const file = join(dir, "a", "b", "c.json");
    writeJsonAtomic(file, [1]);
    expect(readJson<number[]>(file)).toEqual([1]);
  });

  it("replaces an existing file and leaves no temp files behind", () => {
    const file = join(dir, "m.json");
    writeJsonAtomic(file, { v: 1 });
    writeJsonAtomic(file, { v: 2 });
    expect(readJson(file)).toEqual({ v: 2 });
    expect(readdirSync(dir)).toEqual(["m.json"]);
  });

  it("cleans up the temp file when the rename fails", () => {
    const target = join(dir, "is-a-dir");
    ensureDir(join(target, "child"));
    expect(() => writeJsonAtomic(target, { v: 1 })).toThrow();
    expect(readdirSync(dir)).toEqual(["is-a-dir"]);
  });

  // A real short write: the kernel stops the first write at the file-size limit and fails the next with EFBIG.
  it.skipIf(process.platform === "win32")("keeps the old file when the disk refuses part of the write", () => {
    const file = join(dir, "state.json");
    writeJsonAtomic(file, { good: "previous state" });
    const script = `
      const { writeJsonAtomic } = await import(process.argv[1]);
      try { writeJsonAtomic(process.argv[2], { big: "x".repeat(200_000) }); console.log("written"); }
      catch (err) { console.log("threw " + err.code); }`;
    const fsModule = fileURLToPath(new URL("./fs.ts", import.meta.url));
    const child = spawnSync(
      "sh",
      ["-c", 'ulimit -f 64 && exec "$0" "$@"', process.execPath, "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script, fsModule, file],
      { encoding: "utf8" },
    );
    expect(child.stdout.trim()).toBe("threw EFBIG");
    expect(readJson(file)).toEqual({ good: "previous state" });
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("refuses values that are not JSON-serializable", () => {
    expect(() => writeJsonAtomic(join(dir, "u.json"), undefined)).toThrow(TypeError);
    expect(existsSync(join(dir, "u.json"))).toBe(false);
  });

  it("readJson throws on a missing file", () => {
    expect(() => readJson(join(dir, "missing.json"))).toThrow(/ENOENT/);
  });

  it("readJson throws an error naming the file on invalid JSON", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{ nope");
    expect(() => readJson(file)).toThrow(`invalid JSON in ${file}`);
  });
});

describe("readJsonOr", () => {
  it("returns the parsed file when present", () => {
    const file = join(dir, "ok.json");
    writeFileSync(file, '{"a":1}');
    expect(readJsonOr(file, { a: 0 })).toEqual({ a: 1 });
  });

  it("returns the fallback for a missing or corrupt file", () => {
    expect(readJsonOr(join(dir, "missing.json"), { fallback: true })).toEqual({ fallback: true });
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ torn");
    expect(readJsonOr(bad, [])).toEqual([]);
  });

  it("still throws for other read errors", () => {
    expect(() => readJsonOr(dir, null)).toThrow(/EISDIR/);
  });
});

describe("appendJsonl / readJsonl", () => {
  it("appends one record per line and reads them back in order", () => {
    const file = join(dir, "logs", "events.jsonl");
    appendJsonl(file, { n: 1 });
    appendJsonl(file, { n: 2, s: "line\nbreak" });
    expect(readFileSync(file, "utf8").split("\n")).toHaveLength(3);
    expect(readJsonl(file)).toEqual([{ n: 1 }, { n: 2, s: "line\nbreak" }]);
  });

  it("returns [] for a missing file", () => {
    expect(readJsonl(join(dir, "none.jsonl"))).toEqual([]);
  });

  it("skips blank and corrupt lines", () => {
    const file = join(dir, "mixed.jsonl");
    writeFileSync(file, '{"a":1}\n\n{"broken":\n  \n{"b":2}\r\nnot json\n{"c":3}');
    expect(readJsonl(file)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("starts a fresh line after a torn (unterminated) last record", () => {
    const file = join(dir, "torn.jsonl");
    appendJsonl(file, { ok: 1 });
    appendFileSync(file, '{"half":');
    appendJsonl(file, { ok: 2 });
    expect(readJsonl(file)).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it("throws for read errors other than a missing file", () => {
    expect(() => readJsonl(dir)).toThrow(/EISDIR/);
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/mc-apps")).toBe(join(homedir(), "mc-apps"));
    expect(expandHome("~/a/b/")).toBe(join(homedir(), "a/b/"));
  });

  it("leaves other paths alone", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path");
    expect(expandHome("relative/~/x")).toBe("relative/~/x");
    expect(expandHome("~other/x")).toBe("~other/x");
    expect(expandHome("")).toBe("");
  });
});

describe("ensureDir", () => {
  it("creates nested directories, is idempotent, and returns the path", () => {
    const target = join(dir, "x", "y", "z");
    expect(ensureDir(target)).toBe(target);
    expect(ensureDir(target)).toBe(target);
    expect(statSync(target).isDirectory()).toBe(true);
  });
});

describe("sha256 / sha256File", () => {
  const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  it("hashes text as UTF-8", () => {
    expect(sha256("abc")).toBe(ABC);
    expect(sha256("")).toBe(EMPTY);
    expect(sha256("é")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c");
  });

  it("hashes file bytes", () => {
    const file = join(dir, "f.txt");
    writeFileSync(file, "abc");
    expect(sha256File(file)).toBe(ABC);
    writeFileSync(file, "");
    expect(sha256File(file)).toBe(EMPTY);
  });

  it("throws for a missing file", () => {
    expect(() => sha256File(join(dir, "missing"))).toThrow(/ENOENT/);
  });
});
