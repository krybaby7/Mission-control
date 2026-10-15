// What a second AI writes about files it read is made plain before anyone sees it (V2-10): nothing hidden, no picture or link, no web address.
import { describe, expect, it } from "vitest";
import { HIDDEN as PLAN_HIDDEN } from "../plan.js";
import { cleanAiText, isHiddenChar, WEB_ADDRESS_REMOVED } from "./ai-text.js";

/** Characters are written as code points, so this file holds none of the characters it talks about. */
const u = (...codes: number[]): string => String.fromCodePoint(...codes);
const GONE = WEB_ADDRESS_REMOVED;

describe("the class of hidden characters", () => {
  it("is the class the plan reader bans, on every code point", () => {
    const different: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates cannot be written in a string
      const ch = String.fromCodePoint(cp);
      if (isHiddenChar(ch) !== PLAN_HIDDEN.test(ch)) different.push(cp.toString(16));
    }
    expect(different).toEqual([]);
  });

  it("holds the characters the finding names: zero-width, direction-changing, and the blank ones", () => {
    for (const cp of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0xad, 0x2800, 0x3164, 0xe0041, 0xfe0f]) {
      expect(isHiddenChar(u(cp)), cp.toString(16)).toBe(true);
    }
    for (const ch of ["a", " ", "é", "“", "…", "-"]) expect(isHiddenChar(ch)).toBe(false);
  });
});

describe("cleanAiText: hidden characters", () => {
  it("takes out zero-width, direction-changing and other hidden characters, and keeps the words", () => {
    const text = `ok ${u(0x202e)}reversed${u(0x200b)}zero${u(0x2066)}iso${u(0xfeff)}bom${u(0xe0041)}tag${u(0x2800)}blank${u(0x00ad)}soft done`;
    expect(cleanAiText(text)).toBe("ok reversedzeroisobomtagblanksoft done");
  });

  it("turns line breaks, tabs and odd spaces into one plain space", () => {
    expect(cleanAiText(`one\ntwo\r\nthree\tfour${u(0xa0)}five${u(0x2003)}six${u(0x2028)}seven${u(0x3000)}eight   nine`)).toBe("one two three four five six seven eight nine");
  });

  it("takes out terminal control characters", () => {
    expect(cleanAiText(`a${u(0x1b)}[2Jb${u(0x00)}c${u(0x7f)}d${u(0x9b)}e`)).toBe("a[2Jbcde");
  });

  it("cannot be used to hide a web address: a hidden character inside the scheme does not save it", () => {
    expect(cleanAiText(`see ht${u(0x200b)}tps://evil.example/x and ${u(0x202e)}ww${u(0x200d)}w.evil.example`)).toBe(`see ${GONE} and ${GONE}`);
  });
});

describe("cleanAiText: pictures and links of markdown", () => {
  it("turns a picture into its words and takes the web address out", () => {
    expect(cleanAiText("![a chart](https://evil.example/x.png)")).toBe(`a chart ${GONE}`);
    expect(cleanAiText("![](https://evil.example/x.png)")).toBe(`image ${GONE}`);
  });

  it("turns a link into its words and takes the web address out", () => {
    expect(cleanAiText("[click here](http://evil.example/p?a=1)")).toBe(`click here ${GONE}`);
    expect(cleanAiText("[](http://evil.example)")).toBe(`link ${GONE}`);
    expect(cleanAiText("[evil](//evil.example/a)")).toBe(`evil ${GONE}`);
    expect(cleanAiText("[evil](www.evil.example)")).toBe(`evil ${GONE}`);
  });

  it("keeps where a link or a picture inside the project points to, in brackets", () => {
    expect(cleanAiText("See [the guide](docs/setup.md#install) and ![shot](img/shot.png).")).toBe("See the guide (docs/setup.md#install) and shot (img/shot.png).");
  });

  it("leaves nothing that a markdown reader would draw or link", () => {
    for (const text of ["![x](a.png)", "![x][ref]", "[x](a)", "![x] (a)", "[x]( http://e.example )", "![x](<http://e.example>)", "![[x]](a.png)", "![x]((a.png))", "[a](b)[c](d)", "!![x](y)"]) {
      const out = cleanAiText(text);
      expect(out, text).not.toMatch(/!\[/u);
      expect(out, text).not.toMatch(/\]\(/u);
      expect(out, text).not.toMatch(/https?:/iu);
    }
  });
});

describe("cleanAiText: web addresses", () => {
  it.each([
    ["https://evil.example/x?y=1#z", GONE],
    ["HTTP://EVIL.EXAMPLE", GONE],
    ["see http://127.0.0.1:8080/admin now", `see ${GONE} now`],
    ["ftp://host/file and file:///etc/passwd and ws://h:1/", `${GONE} and ${GONE} and ${GONE}`],
    ["see //evil.example/path now", `see ${GONE} now`],
    ["(//evil.example)", `(${GONE})`],
    ["see www.evil.example/a/b now", `see ${GONE} now`],
    ["WWW.EVIL.EXAMPLE", GONE],
    ["a<img src=\"https://evil.example/x.png\">b", `a<img src="${GONE}">b`],
    ["<https://evil.example/x>", `<${GONE}>`],
  ])("%s", (text, expected) => {
    expect(cleanAiText(text)).toBe(expected);
  });

  it("keeps the marks of the sentence around an address", () => {
    expect(cleanAiText("It links to https://evil.example/a.")).toBe(`It links to ${GONE}.`);
    expect(cleanAiText("(see https://evil.example/a), then www.evil.example/b; done")).toBe(`(see ${GONE}), then ${GONE}; done`);
    expect(cleanAiText("He said “go to https://evil.example/a”.")).toBe(`He said “go to ${GONE}”.`);
  });

  it("takes out every address of a long line", () => {
    const out = cleanAiText(`${"http://a.example/x ".repeat(40)}end`, 5000);
    expect(out).not.toMatch(/example|http/u);
    expect(out.endsWith(" end")).toBe(true);
  });
});

describe("cleanAiText: readable text stays as it is", () => {
  it.each([
    "The file says “Add your first habit” in docs/setup-guide.md.",
    "Step 3 says: run `npm start` and open the page.",
    "A comment like // note or a path like src//app is not an address.",
    "The www prefix and the word www. alone are not an address.",
    "Ratio 3/4 and a-b/c, d.e and e.g. this.",
    "Cafe\u0301 and naive and 日本語 and emoji 🙂 stay.",
    "It is 100% done... or is it?",
  ])("%s", (text) => {
    expect(cleanAiText(text)).toBe(text);
  });
});

describe("cleanAiText: length, repeat and bad input", () => {
  it("cuts at the limit, with a closing mark, and never splits a pair of code units", () => {
    expect(cleanAiText("x".repeat(500)).length).toBe(300);
    expect(cleanAiText("x".repeat(500)).endsWith("…")).toBe(true);
    expect(cleanAiText("x".repeat(300))).toBe("x".repeat(300));
    const emoji = cleanAiText("🙂".repeat(400), 10);
    expect(Array.from(emoji)).toHaveLength(10);
    expect(emoji.endsWith("…")).toBe(true);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });

  it("cleaning twice changes nothing more", () => {
    const hostile = `a ${u(0x202e)}b ![x](https://evil.example/x.png) [c](http://d.example) //e.example www.f.example ${"y".repeat(400)}`;
    const once = cleanAiText(hostile);
    expect(cleanAiText(once)).toBe(once);
    const long = cleanAiText("https://evil.example/ ".repeat(80));
    expect(cleanAiText(long)).toBe(long);
  });

  it("takes anything that is not a string: nothing for nothing, a number as its digits", () => {
    expect(cleanAiText(undefined)).toBe("");
    expect(cleanAiText(null)).toBe("");
    expect(cleanAiText(42)).toBe("42");
    expect(cleanAiText("")).toBe("");
    expect(cleanAiText("   ")).toBe("");
  });

  it("is fast on text built to be slow", () => {
    const shapes = ["a.".repeat(60_000), "[a](".repeat(30_000), "[".repeat(100_000), "![".repeat(50_000), ")".repeat(100_000) + "x", "//".repeat(50_000), "://".repeat(30_000), "www.".repeat(30_000), "https://".repeat(15_000), `${u(0x200b)}`.repeat(100_000), "a:/".repeat(40_000)];
    for (const shape of shapes) {
      const start = Date.now();
      const out = cleanAiText(shape, 300);
      expect(Date.now() - start, shape.slice(0, 12)).toBeLessThan(1000);
      expect(Array.from(out).length).toBeLessThanOrEqual(300);
    }
  });
});
