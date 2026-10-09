import { describe, expect, it } from "vitest";
import { LineSplitter, parseJsonLine } from "./ndjson.js";

describe("LineSplitter", () => {
  it("returns complete lines and keeps the unterminated tail", () => {
    const s = new LineSplitter();
    expect(s.push("one\ntwo\nthr")).toEqual(["one", "two"]);
    expect(s.push("ee\n")).toEqual(["three"]);
    expect(s.flush()).toEqual([]);
  });

  it("joins a line spread over many chunks without newlines", () => {
    const s = new LineSplitter();
    expect(s.push("a")).toEqual([]);
    expect(s.push("b")).toEqual([]);
    expect(s.push("c\nd")).toEqual(["abc"]);
    expect(s.flush()).toEqual(["d"]);
  });

  it("strips \\r from \\r\\n endings, also when split across chunks", () => {
    const s = new LineSplitter();
    expect(s.push("win\r\nsplit\r")).toEqual(["win"]);
    expect(s.push("\nnext")).toEqual(["split"]);
    expect(s.flush()).toEqual(["next"]);
  });

  it("keeps a \\r that is not at the end of the line", () => {
    const s = new LineSplitter();
    expect(s.push("50%\r100%\n")).toEqual(["50%\r100%"]);
  });

  it("preserves empty lines", () => {
    const s = new LineSplitter();
    expect(s.push("a\n\n\nb\n")).toEqual(["a", "", "", "b"]);
  });

  it("flush returns the trailing partial line once and resets", () => {
    const s = new LineSplitter();
    s.push("partial\r");
    expect(s.flush()).toEqual(["partial"]);
    expect(s.flush()).toEqual([]);
    expect(s.push("fresh\n")).toEqual(["fresh"]);
  });

  it("handles a chunk that is only a newline", () => {
    const s = new LineSplitter();
    s.push("x");
    expect(s.push("\n")).toEqual(["x"]);
    expect(s.push("\n")).toEqual([""]);
  });
});

describe("parseJsonLine", () => {
  it("returns [] for empty and whitespace-only lines", () => {
    expect(parseJsonLine("")).toEqual([]);
    expect(parseJsonLine("   \t ")).toEqual([]);
  });

  it("parses a normal JSON object", () => {
    expect(parseJsonLine('{"type":"result","n":1}')).toEqual([{ type: "result", n: 1 }]);
    expect(parseJsonLine('  {"a":[1,{"b":2}]}  ')).toEqual([{ a: [1, { b: 2 }] }]);
    expect(parseJsonLine("{}")).toEqual([{}]);
  });

  it("returns every object when several are glued together", () => {
    expect(parseJsonLine('{"a":1}{"b":2}{"c":3}')).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(parseJsonLine('{"a":1} {"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips junk text before, between and after objects", () => {
    expect(parseJsonLine('Warning: something {"type":"x"}')).toEqual([{ type: "x" }]);
    expect(parseJsonLine('noise {"a":1} more noise {"b":2} trailing')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("ignores quotes and braces in junk text outside objects", () => {
    expect(parseJsonLine('it\'s "odd" } { text {"ok":true}')).toEqual([{ ok: true }]);
  });

  it("respects braces and escaped quotes inside strings", () => {
    const line = '{"text":"a } brace and \\" quote {"}{"next":"\\\\"}';
    expect(parseJsonLine(line)).toEqual([{ text: 'a } brace and " quote {' }, { next: "\\" }]);
  });

  it("returns nested objects as part of their top-level object", () => {
    expect(parseJsonLine('x{"outer":{"inner":{"deep":1}}}')).toEqual([{ outer: { inner: { deep: 1 } } }]);
  });

  it("recovers a complete object glued after a truncated one", () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"half{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}';
    expect(parseJsonLine(line)).toEqual([{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }]);
  });

  it("skips a balanced segment that is not valid JSON", () => {
    expect(parseJsonLine('{"a": nope}{"b":2}')).toEqual([{ b: 2 }]);
  });

  it("handles whitespace after the opening brace", () => {
    expect(parseJsonLine('junk { "spaced" : true } {\n"nl":1}')).toEqual([{ spaced: true }, { nl: 1 }]);
  });

  it("returns [] when there is no valid JSON object", () => {
    expect(parseJsonLine("plain text")).toEqual([]);
    expect(parseJsonLine('{"unterminated": "value')).toEqual([]);
    expect(parseJsonLine("{not json}")).toEqual([]);
    expect(parseJsonLine("}{")).toEqual([]);
  });

  it("ignores JSON values that are not objects", () => {
    expect(parseJsonLine("42")).toEqual([]);
    expect(parseJsonLine('"a string with {braces}"')).toEqual([]);
    expect(parseJsonLine("null")).toEqual([]);
  });

  it("parses unicode and escapes", () => {
    expect(parseJsonLine('{"s":"caf\\u00e9 ✓","n":"line\\nbreak"}')).toEqual([{ s: "café ✓", n: "line\nbreak" }]);
  });

  it("stays fast on a long line of unbalanced object starts", () => {
    const line = '{"a":'.repeat(4000) + "garbage";
    const started = Date.now();
    expect(parseJsonLine(line)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
