// The dashboard only reads. Four proofs (docs/dashboard-spec.md, 15): the home is byte-identical after many snapshots
// (T-RO-1), the sources hold no way to write (T-RO-2), a build runs with every write blocked (T-RO-3), and nothing
// secret reaches the snapshot (T-RO-4).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { copyHome, hashTree, touch, withLock, withStop } from "../../test/dashboard-helpers.js";
import { FIN, fixtureNames, fixtureSnapshot, MID, SECOND, snap } from "../../test/dashboard-kit.js";
import { clearReadCache } from "./read.js";
import { buildSnapshot } from "./snapshot.js";

// The runtime guard of T-RO-3: every function of node:fs that can change a file throws while `guard.on` is set.
const guard = vi.hoisted(() => ({ on: false, calls: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const everything = actual as unknown as Record<string, (...args: unknown[]) => unknown>;
  const blocked = [
    "writeFileSync",
    "appendFileSync",
    "mkdirSync",
    "mkdtempSync",
    "rmSync",
    "rmdirSync",
    "renameSync",
    "linkSync",
    "symlinkSync",
    "unlinkSync",
    "utimesSync",
    "futimesSync",
    "lutimesSync",
    "copyFileSync",
    "cpSync",
    "truncateSync",
    "ftruncateSync",
    "chmodSync",
    "fchmodSync",
    "chownSync",
    "fchownSync",
    "writeSync",
    "writevSync",
    "fsyncSync",
    "createWriteStream",
  ];
  const patched: Record<string, unknown> = { ...actual };
  for (const name of blocked) {
    patched[name] = (...args: unknown[]) => {
      if (guard.on) {
        guard.calls.push(name);
        throw new Error(`${name} is not allowed while the dashboard builds a snapshot`);
      }
      return everything[name]?.(...args);
    };
  }
  patched.openSync = (path: unknown, flags?: unknown, ...rest: unknown[]) => {
    if (guard.on && flags !== undefined && flags !== "r" && flags !== actual.constants.O_RDONLY) {
      guard.calls.push(`openSync(${String(flags)})`);
      throw new Error("openSync with a write flag is not allowed while the dashboard builds a snapshot");
    }
    return everything.openSync?.(path, flags, ...rest);
  };
  return { ...patched, default: patched };
});

// ───────────────────────────── T-RO-1 ─────────────────────────────

describe("T-RO-1: the home is byte-identical after many snapshots", () => {
  it("a copy of the multi-mission home, with a lock and a STOP file, hashed before and after", () => {
    const home = copyHome("multi-mission");
    const now = Date.parse("2026-10-11T13:03:30.000Z");
    withLock(home, { at: "2026-10-11T09:50:00.000Z", ageMs: 15_000, now });
    withStop(home);
    touch(join(home, "quota.json"), now - 60_000);
    const before = hashTree(home);
    for (let i = 0; i < 25; i++) {
      clearReadCache();
      const s = buildSnapshot({ home, now: now + i * 4 * SECOND, timeZone: "UTC", until: i % 2 === 0 ? "07:00" : undefined, onError: (e) => { throw e; } });
      expect(s.missions).toHaveLength(5);
    }
    expect(hashTree(home)).toBe(before);
  });

  it("every fixture is left as it was, a stale lock and a missing home included", () => {
    for (const name of fixtureNames()) {
      const home = copyHome(name);
      const before = hashTree(home);
      snap(home, FIN);
      snap(home, MID);
      expect(hashTree(home), name).toBe(before);
    }
  });

  it("the hash notices a change, so the proof proves something", () => {
    const home = copyHome("done");
    const before = hashTree(home);
    writeFileSync(join(home, "extra.txt"), "x");
    expect(hashTree(home)).not.toBe(before);
  });
});

// ───────────────────────────── T-RO-2 ─────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `source` with its comments taken out and, unless `keepStrings`, with every string, template text and regular
 * expression replaced by an empty one, so a word in prose does not count. Code inside `${...}` of a template stays.
 */
function strip(source: string, keepStrings: boolean): string {
  let out = "";
  let i = 0;
  let depth = 0;
  let prev = "";
  const templates: number[] = [];
  const text = (open: string, close: string): void => {
    // `i` is on the first character after `open`
    const start = i;
    while (i < source.length && source[i] !== close) i += source[i] === "\\" ? 2 : 1;
    const body = source.slice(start, i);
    i += 1;
    out += keepStrings ? `${open}${body}${close}` : `${open}${close}`;
    prev = close;
  };
  const template = (): void => {
    const start = i;
    while (i < source.length) {
      if (source[i] === "\\") i += 2;
      else if (source[i] === "`") break;
      else if (source[i] === "$" && source[i + 1] === "{") break;
      else i += 1;
    }
    if (keepStrings) out += source.slice(start, i);
    if (source[i] === "`") {
      i += 1;
      out += keepStrings ? "`" : '""';
      prev = '"';
    } else if (source[i] === "$") {
      i += 2;
      templates.push(depth);
      depth += 1;
      out += keepStrings ? "${" : "+(";
      prev = "(";
    }
  };
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'") {
      i += 1;
      text(c, c);
    } else if (c === "`") {
      i += 1;
      out += keepStrings ? "`" : "";
      template();
    } else if (c === "}" && templates.length > 0 && templates[templates.length - 1] === depth - 1) {
      templates.pop();
      depth -= 1;
      i += 1;
      out += keepStrings ? "}" : ")";
      template();
    } else if (c === "/" && (prev === "" || "(,=:[!&|?{};".includes(prev))) {
      // a regular expression literal: up to the next slash that is not escaped and not inside [...]
      const start = i;
      i += 1;
      let inClass = false;
      while (i < source.length && (source[i] !== "/" || inClass)) {
        if (source[i] === "\\") i += 1;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        i += 1;
      }
      i += 1;
      while (/[a-z]/.test(source[i] ?? "")) i += 1;
      out += keepStrings ? source.slice(start, i) : "/ /";
      prev = "/";
    } else {
      if (c === "{") depth += 1;
      if (c === "}") depth -= 1;
      out += c;
      if (!/\s/.test(c)) prev = c;
      i += 1;
    }
  }
  return out;
}

const WRITE_CALL = /\b(?:writeFile|appendFile|mkdir|mkdtemp|rmdir|rename|unlink|utimes|futimes|lutimes|copyFile|symlink|link|truncate|ftruncate|chmod|fchmod|chown|fchown|createWriteStream|writeSync)\w*\s*\(/;
const REMOVE_CALL = /\b(?:rm|rmSync|cp|cpSync)\s*\(/;
const ENGINE_WRITERS = /\b(?:acquireLock|appendEvent|appendUsage|requestStop|clearStop|logsDir|createMission|ensureDir|writeJsonAtomic|appendJsonl|activeRun)\b|\.save\(|\.list\(/;
const READ_ONLY_FS = new Set(["existsSync", "readdirSync", "readFileSync", "statSync", "openSync", "readSync", "closeSync", "fstatSync"]);
const TYPE_ONLY_FS = new Set(["Stats", "Dirent"]);

/** Everything wrong with the source of one dashboard module, in words. */
function readOnlyProblems(source: string): string[] {
  const problems: string[] = [];
  const withStrings = strip(source, true);
  const code = strip(source, false);

  // openSync is allowed for reading only: the flag must be the literal "r".
  for (const match of withStrings.matchAll(/\bopenSync\s*\(/g)) {
    let depth = 1;
    let at = (match.index ?? 0) + match[0].length;
    const start = at;
    while (at < withStrings.length && depth > 0) {
      if (withStrings[at] === "(") depth += 1;
      if (withStrings[at] === ")") depth -= 1;
      at += 1;
    }
    const args = withStrings.slice(start, at - 1).split(",").map((a) => a.trim());
    if (args.length !== 2 || args[1] !== '"r"') problems.push(`openSync(${args.join(", ")}) is not a read-only open`);
  }

  const write = WRITE_CALL.exec(code) ?? REMOVE_CALL.exec(code);
  if (write !== null) problems.push(`a call that writes or removes: ${write[0]}`);
  const engine = ENGINE_WRITERS.exec(code);
  if (engine !== null) problems.push(`the engine's writer ${engine[0]}`);
  if (/\brequire\s*\(/.test(code)) problems.push("require(");
  if (/\bimport\s*\(/.test(code)) problems.push("a dynamic import(");

  for (const match of withStrings.matchAll(/\b(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    const [, , clause = "", from = ""] = match;
    if (/^(?:node:)?(?:fs\/promises|child_process)$/.test(from)) problems.push(`an import of ${from}`);
    if (from !== "fs" && from !== "node:fs") continue;
    const named = /^\{([^}]*)\}$/.exec(clause.trim());
    if (named === null) {
      problems.push(`import of ${from} that is not a list of names: ${clause}`);
      continue;
    }
    for (const entry of (named[1] ?? "").split(",").map((n) => n.trim()).filter((n) => n !== "")) {
      const name = entry.replace(/^type\s+/, "");
      const typeOnly = match[1] !== undefined || entry.startsWith("type ");
      if (!(typeOnly ? TYPE_ONLY_FS.has(name) || READ_ONLY_FS.has(name) : READ_ONLY_FS.has(name))) problems.push(`${name} is not on the list of read-only names from ${from}`);
    }
  }
  return problems;
}

function dashboardSources(): { file: string; source: string }[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort()
    .map((file) => ({ file, source: readFileSync(join(HERE, file), "utf8") }));
}

describe("T-RO-2: the sources hold no way to write", () => {
  it("finds the modules to scan", () => {
    const files = dashboardSources().map((s) => s.file);
    for (const expected of ["read.ts", "snapshot.ts", "missions.ts", "cards.ts", "lamp.ts", "vocabulary.ts", "sanitize.ts", "constants.ts", "types.ts"]) expect(files).toContain(expected);
  });

  it.each(dashboardSources().map((s) => [s.file, s.source] as const))("%s", (_file, source) => {
    expect(readOnlyProblems(source)).toEqual([]);
  });

  describe("the scan itself", () => {
    it.each([
      ['import { writeFileSync } from "node:fs";', "writeFileSync"],
      ['import fs from "node:fs";', "not a list of names"],
      ['import * as fs from "fs";', "not a list of names"],
      ['import { readFileSync, rmSync } from "node:fs";', "rmSync"],
      ['import { readFile } from "node:fs/promises";', "node:fs/promises"],
      ['import { exec } from "node:child_process";', "node:child_process"],
      ['const fs = require("node:fs");', "require("],
      ['const m = await import("node:fs");', "dynamic import("],
      ['import { openSync } from "node:fs";\nopenSync(path, "w");', "openSync(path, "],
      ['import { openSync } from "node:fs";\nopenSync(path, flags);', "openSync(path, flags)"],
      ['import { openSync } from "node:fs";\nopenSync(path);', "openSync(path)"],
      ["fs.writeFileSync(file, text);", "writeFileSync("],
      ["await fsp.appendFile(file, text);", "appendFile("],
      ["mkdirSync(dir, { recursive: true });", "mkdirSync("],
      ["store.logsDir(id);", "logsDir"],
      ["store.save(mission);", ".save("],
      ["store.list();", ".list("],
      ["store.acquireLock();", "acquireLock"],
      ["rmSync(dir);", "rmSync("],
      ["const x = `${store.appendEvent(id)}`;", "appendEvent"],
      ["utimesSync(file, a, b);", "utimesSync("],
    ])("flags %s", (source, expected) => {
      expect(readOnlyProblems(source).join("\n")).toContain(expected);
    });

    it.each([
      ['import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, fstatSync, type Stats } from "node:fs";'],
      ['import type { Stats } from "node:fs";'],
      ['import { openSync } from "node:fs";\nconst fd = openSync(file, "r");'],
      ["// fs.writeFileSync(file) is what this module never does\nconst a = 1;"],
      ["/* mkdirSync(dir) */ const a = 1;"],
      ['const text = "mkdirSync(dir) and logsDir and .save(";'],
      ["const text = `a ${1 + 1} writeFileSync( b`;"],
      ["const re = /rmSync\\(/u; const b = 1;"],
      ['const re = /["\'`]/g; const c = "rmSync(";'],
      ["const a = b / c; const d = e / f;"],
    ])("lets %s through", (source) => {
      expect(readOnlyProblems(source)).toEqual([]);
    });

    it("still sees code inside a template's ${...}", () => {
      expect(readOnlyProblems("const x = `text ${rmSync(file)} more`;").join()).toContain("rmSync(");
    });
  });
});

// ───────────────────────────── T-RO-3 ─────────────────────────────

describe("T-RO-3: a snapshot is built with every write blocked", () => {
  it("the guard blocks a write while it is on (so the proof proves something)", () => {
    const home = copyHome("done");
    guard.calls.length = 0;
    guard.on = true;
    try {
      expect(() => writeFileSync(join(home, "x.txt"), "x")).toThrow(/not allowed/);
    } finally {
      guard.on = false;
    }
    expect(guard.calls).toEqual(["writeFileSync"]);
    guard.calls.length = 0;
  });

  it.each(["multi-mission", "midrun-building", "limit-waiting", "failed-auth", "hostile-strings", "scope-mix", "unreadable-mission"])("%s", (name) => {
    const home = copyHome(name);
    withLock(home, { at: "2026-10-11T09:50:00.000Z", ageMs: 15_000, now: MID });
    withStop(home);
    clearReadCache();
    guard.calls.length = 0;
    guard.on = true;
    let snapshot;
    try {
      snapshot = buildSnapshot({ home, now: MID, timeZone: "UTC", until: "07:00", onError: (e) => { throw e; } });
    } finally {
      guard.on = false;
    }
    expect(guard.calls).toEqual([]);
    expect(snapshot.schemaVersion).toBe(1);
  });
});

// ───────────────────────────── T-RO-4 ─────────────────────────────

describe("T-RO-4: nothing secret reaches the snapshot", () => {
  const SENTINEL = "ghp_FAKE0123456789SENTINEL";

  it.each(fixtureNames().filter((n) => n !== "hostile-strings"))("%s", (name) => {
    const json = JSON.stringify(fixtureSnapshot(name));
    expect(json, "the sentinel token").not.toContain(SENTINEL);
    expect(json, "an absolute path").not.toMatch(/\/fixture|\/home\/|\/tmp\/|\/root/);
    expect(json, "a model name").not.toMatch(/claude-|gpt-/);
    expect(json, "a command").not.toContain("mc run");
    expect(json, "a backtick").not.toContain("`");
    expect(json, "a commit").not.toMatch(/\b[0-9a-f]{40}\b/);
    expect(json, "the raw words of a wait").not.toMatch(/limit until \d{4}-|trying again at/);
  });

  it("the home with the sentinel really holds it, and the snapshot of it does not", () => {
    const home = copyHome("dispatch-with-secret");
    const raw = readFileSync(join(home, "missions", "2026-10-11-habit-tracker", "dispatch.json"), "utf8");
    expect(raw).toContain(SENTINEL);
    expect(JSON.stringify(snap(home, FIN))).not.toContain(SENTINEL);
  });

  it("the hostile strings may hold such text, but never an absolute path of the machine or a model name", () => {
    const json = JSON.stringify(fixtureSnapshot("hostile-strings"));
    expect(json).not.toMatch(/claude-|gpt-|\/home\/|\/tmp\//);
  });
});
