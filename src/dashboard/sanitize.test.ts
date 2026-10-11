import { describe, expect, it } from "vitest";
import { ID_MAX_CHARS, TITLE_MAX_CHARS } from "./constants.js";
import { clean, cleanId, shorten } from "./sanitize.js";

// Written as code points: an escape in this file would be turned into the character itself by some editors.
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);

describe("clean", () => {
  it("leaves a plain line alone, markup included (the page inserts it as text)", () => {
    expect(clean("Weekly progress chart", 120)).toBe("Weekly progress chart");
    expect(clean("<b>bold</b> & \"quoted\"", 120)).toBe("<b>bold</b> & \"quoted\"");
  });

  it.each([
    ["a C0 control", ch(0x07), "ab"],
    ["a null", ch(0), "ab"],
    ["DEL", ch(0x7f), "ab"],
    ["a C1 control", ch(0x85), "ab"],
    ["a right-to-left override", ch(0x202e), "ab"],
    ["an isolate", ch(0x2066), "ab"],
    ["a left-to-right mark", ch(0x200e), "ab"],
    ["an Arabic letter mark", ch(0x061c), "ab"],
    ["a zero-width space", ch(0x200b), "ab"],
    ["a zero-width joiner", ch(0x200d), "ab"],
    ["a word joiner", ch(0x2060), "ab"],
    ["a byte order mark", ch(0xfeff), "ab"],
  ])("removes %s", (_name, bad, expected) => {
    expect(clean(`a${bad}b`, 50)).toBe(expected);
  });

  it("turns tabs, newlines and line separators into one space", () => {
    expect(clean(`a\tb\nc${ch(0x2028)}d${ch(0x2029)}e`, 50)).toBe("a b c d e");
  });

  it("collapses runs of whitespace (non-breaking spaces too) and trims", () => {
    expect(clean(`  a   b${ch(0xa0)}${ch(0xa0)}c \n `, 50)).toBe("a b c");
  });

  it("turns a lone surrogate into the replacement character and keeps a real pair", () => {
    expect(clean(`a${String.fromCharCode(0xd800)}b`, 50)).toBe(`a${ch(0xfffd)}b`);
    expect(clean(`a${ch(0x1f600)}b`, 50)).toBe(`a${ch(0x1f600)}b`);
  });

  it("cuts at the limit in code points and ends with an ellipsis, so the result is never longer than the limit", () => {
    const out = clean("x".repeat(10_000), TITLE_MAX_CHARS);
    expect(Array.from(out)).toHaveLength(TITLE_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(clean("x".repeat(TITLE_MAX_CHARS), TITLE_MAX_CHARS)).toBe("x".repeat(TITLE_MAX_CHARS));
  });

  it("counts a character outside the basic plane as one", () => {
    const wide = ch(0x1f600).repeat(10);
    expect(clean(wide, 10)).toBe(wide);
    expect(Array.from(clean(wide, 5))).toEqual([...ch(0x1f600).repeat(4), "…"]);
  });

  it("does not leave a space in front of the ellipsis", () => {
    expect(clean("word word word", 6)).toBe("word…");
  });

  it("makes a string of anything", () => {
    expect(clean(42, 10)).toBe("42");
    expect(clean("", 10)).toBe("");
  });
});

describe("shorten", () => {
  it("returns short text as it is", () => {
    expect(shorten("short", 10)).toBe("short");
  });
  it("cuts long text to the limit with an ellipsis", () => {
    expect(shorten("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("cleanId", () => {
  it("caps at the id limit", () => {
    expect(Array.from(cleanId("a".repeat(500)))).toHaveLength(ID_MAX_CHARS);
  });
  it("removes what clean removes", () => {
    expect(cleanId(`2026${ch(0x202e)}-10-11-x`)).toBe("2026-10-11-x");
  });
});
