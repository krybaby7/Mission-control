import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_LINE_LENGTH, LineSplitter, parseJsonLine } from "./ndjson.js";

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

  it("cuts an overlong line to its first maxLineLength characters and carries on", () => {
    const s = new LineSplitter(5);
    expect(s.push("abc")).toEqual([]);
    expect(s.push("defgh")).toEqual([]);
    expect(s.push("ij\nfive!\nxy\n")).toEqual(["abcde", "five!", "xy"]);
    expect(s.push("0123456789\nz")).toEqual(["01234"]);
    expect(s.flush()).toEqual(["z"]);
  });

  it("caps a newline-free stream at the default line length instead of growing without bound", () => {
    const s = new LineSplitter();
    const mib = "x".repeat(1024 * 1024);
    for (let i = 0; i < DEFAULT_MAX_LINE_LENGTH / mib.length + 4; i++) expect(s.push(mib)).toEqual([]);
    const [line, next] = s.push("tail\nnext\n");
    expect(line).toHaveLength(DEFAULT_MAX_LINE_LENGTH);
    expect(next).toBe("next");
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

  it("ignores JSON values that are not objects, including arrays of objects", () => {
    expect(parseJsonLine("42")).toEqual([]);
    expect(parseJsonLine('"a string with {braces}"')).toEqual([]);
    expect(parseJsonLine('"{\\"type\\":\\"x\\"}"')).toEqual([]);
    expect(parseJsonLine("null")).toEqual([]);
    expect(parseJsonLine('[{"type":"result"}]')).toEqual([]);
    expect(parseJsonLine('[1, {"type":"result"}, {"b":2}]')).toEqual([]);
  });

  it("does not return the nested values of a truncated object as events", () => {
    // Codex item whose outer event was cut short: the inner {"type":"error"} is not a top-level error event.
    expect(parseJsonLine('{"type":"item.completed","item":{"id":"i1","type":"error","message":"x"}')).toEqual([]);
    expect(
      parseJsonLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"a.ts"}}]}'),
    ).toEqual([]);
    expect(parseJsonLine('{"a":1}garbage{"b":{"c":2}')).toEqual([{ a: 1 }]);
    expect(parseJsonLine('{"list": [ {"x":1},\n {"y":2}')).toEqual([]);
  });

  it("does not return the nested values of a balanced but invalid object", () => {
    expect(parseJsonLine('{"a": nope, "b": {"c": 2}}{"d":3}')).toEqual([{ d: 3 }]);
  });

  it("still finds an object after junk that ends in a colon or comma", () => {
    expect(parseJsonLine('data: {"type":"x"}')).toEqual([{ type: "x" }]);
    expect(parseJsonLine('a, b, {"type":"y"} [z]')).toEqual([{ type: "y" }]);
  });

  it("parses unicode and escapes", () => {
    expect(parseJsonLine('{"s":"caf\\u00e9 ✓","n":"line\\nbreak"}')).toEqual([{ s: "café ✓", n: "line\nbreak" }]);
  });

  it.each([
    ["nested unbalanced starts", '{"a":'.repeat(100_000) + "garbage"],
    ["unbalanced starts after junk", 'x{"a":'.repeat(100_000) + "garbage"],
    ["a truncated event with many nested values", '{"items":[' + '{"k":"v"},'.repeat(100_000)],
  ])("stays linear on a long line of %s", (_name, line) => {
    const started = performance.now();
    expect(parseJsonLine(line)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("gives up within a bounded time on a contrived line that defeats the brace cache", () => {
    // Each `{"` sits where every earlier scan was inside a string, so each needs a scan of its own.
    const line = '{"a\\"'.repeat(100_000);
    const started = performance.now();
    expect(parseJsonLine(line)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("finds a complete event glued after a long truncated one, quickly", () => {
    const line = '{"type":"user","items":[' + '{"k":"v"},'.repeat(100_000) + '{"text":"cut{"type":"result","ok":true}';
    const started = performance.now();
    expect(parseJsonLine(line)).toEqual([{ type: "result", ok: true }]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
