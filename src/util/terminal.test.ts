import { describe, expect, it } from "vitest";
import { stripControlChars } from "./terminal.js";

describe("stripControlChars", () => {
  it("removes escape sequences' control bytes, so a clipboard or title sequence can't reach the terminal", () => {
    const osc52 = "Hello \x1b]52;c;Y3VybCBldmlsLnNoIHwgc2gK\x07 there";
    expect(stripControlChars(osc52)).toBe("Hello ]52;c;Y3VybCBldmlsLnNoIHwgc2gK there");
    expect(stripControlChars("\x1b]0;pwned\x07title")).toBe("]0;pwnedtitle");
    expect(stripControlChars("csi \x9b2J and \x1b[2J")).toBe("csi 2J and [2J");
    expect(stripControlChars("back\x08space, del\x7f, nul\x00, cr\r")).toBe("backspace, del, nul, cr");
  });

  it("keeps newlines, tabs and ordinary text, accents and emoji included", () => {
    const text = "line 1\n\tline 2 · café ✅ “quoted”";
    expect(stripControlChars(text)).toBe(text);
  });
});
