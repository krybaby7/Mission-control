// What a second AI writes about files it read is made plain before anyone sees it (V2-10): nothing hidden, no picture or link, no web address,
// no raw HTML tag, no e-mail address and no script address (W2e-R3), and ordinary text that only looks like an address is left alone (W2e-R10).
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HIDDEN as PLAN_HIDDEN } from "../plan.js";
import { cleanAiText, hasWords, isHiddenChar, WEB_ADDRESS_REMOVED, writtenLength } from "./ai-text.js";

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
    ["a<img src=\"https://evil.example/x.png\">b", "a img tag b"],
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

describe("cleanAiText: raw HTML (W2e-R3)", () => {
  /** What the reviewer's battery put through a markdown viewer: the first group draws or runs something, the second is tags in odd shapes. */
  const HOSTILE = [
    "<img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">go</a>',
    "<svg onload=alert(1)>",
    "<script>alert(1)</script>",
    "<style>body{display:none}</style>",
    '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
    "<iframe src=//evil.example/x></iframe>",
    '<img alt=">" src=x onerror=alert(1)>',
    "<!-- hidden --> text <![CDATA[ x ]]> <!DOCTYPE html> <?php echo 1; ?>",
    "<<b>script>alert(1)</b>",
    "<<<img src=x onerror=alert(1)>>>",
    "<img src=x onerror=alert(1)",
    "<scr<script>ipt>alert(1)</scr</script>ipt>",
    "<IMG SRC=x ONERROR=alert(1)>",
    "<a/b onclick=alert(1)>x",
    "</div><div>",
    "<javascript:alert(1)>",
    "<mailto:a@b.example>",
    "<data:text/html,<script>alert(1)</script>>",
  ];

  it.each(HOSTILE)("leaves no tag of %s", (text) => {
    const out = cleanAiText(text);
    expect(out).not.toMatch(/<[A-Za-z/!?]/u);
    expect(out).not.toMatch(/(?:javascript|vbscript):/iu);
    expect(out).not.toMatch(/\bdata:[\w.+-]*\//iu);
    expect(cleanAiText(out), "cleaning twice").toBe(out);
  });

  it.each([
    ["<img src=x onerror=alert(1)>", "an img tag"],
    ['<a href="javascript:alert(1)">go</a>', "an a tag go closing a tag"],
    ["<script>alert(1)</script>", "a script tag alert(1) closing script tag"],
    ["Before <b>bold</b> after.", "Before b tag bold closing b tag after."],
    ["a<br>b", "a br tag b"],
    ["<<b>script>x", "< b tag script>x"],
    ["<img src=x onerror=alert(1)", "< img src=x onerror=alert(1)"],
    ["<!-- hidden --> text", "a comment text"],
    ["List<string> and Map<K, V> are types.", "List string tag and Map k tag are types."],
  ])("%s", (text, expected) => {
    expect(cleanAiText(text)).toBe(expected);
  });

  it("keeps a bracket that is not the start of a tag, and the hidden-character marks that Mission Control writes itself", () => {
    for (const text of ["when a < b and c > d", "x<3 and y>2, 1 <2", "arrows -> and => and <- and <= and >=", "a << b and c >> d", "a file named docs/setup.md<U+202E> and <U+200B>"]) {
      expect(cleanAiText(text), text).toBe(text);
    }
  });

  it("does not let the words around a tag join into a new one", () => {
    expect(cleanAiText("<<b></b>img src=x onerror=alert(1)>")).not.toMatch(/<[A-Za-z/!?]/u);
    expect(cleanAiText("ht<b></b>tp://evil.example/x")).not.toMatch(/evil/u);
    expect(cleanAiText("<scr<i></i>ipt>alert(1)")).not.toMatch(/<[A-Za-z/!?]/u);
  });
});

describe("cleanAiText: a tag becomes its name in words (R3-5 of the real runs)", () => {
  it("reads well for the sentences the second AI really wrote about a page", () => {
    // From the evidence of the real run R3 (a page with pictures): before, these read `inside " " there are three " " elements` and `has no , , or @import`.
    expect(cleanAiText('site/index.html: inside "<div class="benefits" data-testid="benefits">" there are three "<section class="benefit" data-testid="benefit">" elements.')).toBe(
      'site/index.html: inside "a div tag" there are three "a section tag" elements.',
    );
    expect(cleanAiText("site/index.html has no <script>, <link>, <img> or @import. The only href is the relative \"../README.md\".")).toBe(
      'site/index.html has no script tag, link tag, img tag or @import. The only href is the relative "../README.md".',
    );
    expect(cleanAiText("It has one <h1>, and the <title> is word-tools.")).toBe("It has one h1 tag, and the title tag is word-tools.");
    expect(cleanAiText('all of its CSS sits in one "<style>" block (lines 8-25)')).toBe('all of its CSS sits in one "a style tag" block (lines 8-25)');
    expect(cleanAiText('line 7: "<title>word-tools</title>".')).toBe('line 7: "a title tag word-tools closing title tag".');
  });

  it("puts a word in front of a tag that stands alone, and leaves the writer's own words in front of any other", () => {
    expect(cleanAiText('<div class="x">')).toBe("a div tag");
    expect(cleanAiText('"<div class=\'x\'>" and (<td>) and <b>bold</b>')).toBe('"a div tag" and (a td tag) and b tag bold closing b tag');
    expect(cleanAiText("</div>")).toBe("a closing div tag");
    expect(cleanAiText("then </div> follows")).toBe("then closing div tag follows");
    expect(cleanAiText("<!-- note -->")).toBe("a comment");
    expect(cleanAiText("see <!-- note --> here")).toBe("see comment here");
  });

  it("says `a` or `an` as a reader would say the name", () => {
    const alone = (name: string): string => cleanAiText(`<${name}>`);
    for (const [name, words] of [
      ["div", "a div tag"],
      ["section", "a section tag"],
      ["img", "an img tag"],
      ["input", "an input tag"],
      ["a", "an a tag"],
      ["em", "an em tag"],
      ["ol", "an ol tag"],
      ["ul", "a ul tag"],
      ["u", "a u tag"],
      ["h1", "an h1 tag"],
      ["hr", "an hr tag"],
      ["html", "an html tag"],
      ["svg", "an svg tag"],
      ["td", "a td tag"],
      ["tr", "a tr tag"],
      ["header", "a header tag"],
      ["IMG", "an img tag"],
    ] as const) {
      expect(alone(name), name).toBe(words);
    }
  });

  it("keeps nothing from inside a tag: no attribute, handler, address or script, and a name that is odd or long is just `tag`", () => {
    const out = cleanAiText('<img src="https://evil.example/x.png" onerror="alert(1)" alt="secret words">');
    expect(out).toBe("an img tag");
    expect(cleanAiText("<img/src=x onerror=alert(1)>")).toBe("an img tag");
    expect(cleanAiText(`<${"a".repeat(21)} onclick=alert(1)>`)).toBe("a tag");
    expect(cleanAiText("<a-b-c onclick=alert(1)>")).toBe("an a-b-c tag");
    expect(cleanAiText("<!DOCTYPE html> <?php echo 1; ?>")).toBe("a doctype tag php tag");
    // An address in an attribute is taken out first, as it always was; the tag then goes the same way as any other.
    expect(cleanAiText('<a href="mailto:a@b.example">mail</a>')).not.toMatch(/mailto|example/u);
  });

  it("cleaning twice changes nothing more, and the words do not make a tag, a link or an address", () => {
    for (const text of ["<div class=\"x\">hello</div>", "<<b>script>x", "<scr<script>ipt>alert(1)</scr</script>ipt>", "ht<b></b>tp://evil.example/x", "[<b>](javascript:alert(1))", "![<i>](x)"]) {
      const out = cleanAiText(text);
      expect(cleanAiText(out), text).toBe(out);
      expect(out, text).not.toMatch(/<[A-Za-z/!?]/u);
      expect(out, text).not.toMatch(/!\[|\]\(|evil|javascript:/u);
    }
  });

  it("does not count as writing: evidence that is nothing but tags still says nothing", () => {
    expect(cleanAiText("<b></b> <i></i>")).toBe("a b tag closing b tag i tag closing i tag");
    expect(hasWords("<b></b> <i></i>")).toBe(false);
    expect(hasWords('<img src=x onerror=alert(1)> <div class="x">')).toBe(false);
    expect(writtenLength("<b></b>")).toBe(7);
  });

  // Rendered as GitHub-flavoured markdown by pandoc, when this computer has it: no element that draws or runs anything comes out.
  const pandoc = spawnSync("pandoc", ["--version"], { encoding: "utf8" });
  const battery = [
    "<img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">go</a>',
    "<svg onload=alert(1)>",
    "<script>alert(1)</script>",
    "<style>body{display:none}</style>",
    '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
    "<iframe src=//evil.example/x></iframe>",
    "<!-- hidden --> text <![CDATA[ x ]]> <!DOCTYPE html> <?php echo 1; ?>",
    "<<<img src=x onerror=alert(1)>>>",
    "<scr<script>ipt>alert(1)</scr</script>ipt>",
    "<IMG SRC=x ONERROR=alert(1)>",
    '"<div class="benefits" data-testid="benefits">" and "<a class="button" href="https://evil.example/x">Go</a>"',
    "![x](https://evil.example/x.png) [y](http://evil.example) <https://evil.example/z> <b>[z](javascript:alert(1))</b>",
  ];
  it.skipIf(pandoc.status !== 0)("pandoc draws no tag, link or picture from the cleaned text", () => {
    for (const text of battery) {
      const html = spawnSync("pandoc", ["-f", "gfm", "-t", "html"], { input: cleanAiText(text, 2000), encoding: "utf8" }).stdout;
      expect(html, text).not.toMatch(/<(?!\/?(?:p|code|em|strong|del)\b)[A-Za-z]/u);
      expect(html, text).not.toMatch(/\b(?:href|src|onerror|onload)\s*=/iu);
    }
  });
});

describe("cleanAiText: script, data and mail addresses (W2e-R3)", () => {
  it.each([
    ["[x](javascript:alert(1))", `x ${GONE})`],
    ["[x](<javascript:alert(1)>)", `x ${GONE}>)`],
    ["[x](  JaVaScRiPt:alert(1) )", `x ${GONE} )`],
    ["[x](vbscript:msgbox(1))", `x ${GONE})`],
    ["[x](data:text/html;base64,PHNjcmlwdD4=)", `x ${GONE}`],
    ["[mail me](mailto:a@b.example)", `mail me ${GONE}`],
    ["![x](data:image/svg+xml;base64,PHN2Zz4=)", `x ${GONE}`],
    ["see javascript:alert(1) now", `see ${GONE} now`],
    ["see VBScript:msgbox(1) now", `see ${GONE} now`],
    ["see mailto:a@b.example, or data:text/html,hi.", `see ${GONE}, or ${GONE}.`],
    ["<a href=\"mailto:a@b.example\">mail</a>", "an a tag mail closing a tag"],
    [`java${u(0x200b)}script:alert(1)`, GONE],
    ["write to a@b.example.", `write to ${GONE}.`],
    ["write to first.last+tag@mail.example.co.uk, then stop", `write to ${GONE}, then stop`],
    ["[x]: javascript:alert(1)", `[x]: ${GONE}`],
  ])("%s", (text, expected) => {
    expect(cleanAiText(text)).toBe(expected);
  });

  it("leaves words that are not addresses", () => {
    for (const text of [
      "JavaScript: The Good Parts is a book.",
      "The data: three columns and two rows.",
      "Metadata:name and the {data:1} object.",
      "Use the mailto link, and the javascript word.",
      "Write to @claude about npm i @scope/pkg@1.2.3 please.",
      "Contact: someone at example dot com.",
      "user@host has no dot, and a@b.c has a short ending.",
    ]) {
      expect(cleanAiText(text), text).toBe(text);
    }
  });
});

describe("cleanAiText: text that only looks like an address stays (W2e-R10)", () => {
  it.each([
    "The file has a //TODO comment on line 3.",
    "The file has a //TODO: fix this comment, and a // note.",
    "Line 4 reads //FIXME and line 9 reads ///separator.",
    "paths like C://Users are Windows",
    "paths like D://data/backup are Windows",
    "a ratio of 3://4 is odd",
    "a page named www.html and a word www. alone",
    "the files www.css and www.js are mine",
    "a drive C:\\Users and a path src//app",
    "a.b.c ratios like 1.5://2.5",
    "x://y is not a scheme, and 7://8 is not one",
  ])("%s", (text) => {
    expect(cleanAiText(text)).toBe(text);
  });

  it.each([
    ["see http://example.com now", `see ${GONE} now`],
    ["see ab://c and xy://host/path?q=1 now", `see ${GONE} and ${GONE} now`],
    ["a custom scheme my-app+x.y://open/file", `a custom scheme ${GONE}`],
    ["see //example.com now", `see ${GONE} now`],
    ["see //host.tld/path now", `see ${GONE} now`],
    ["see //cdn.example.co.uk:8080/a.js?x=1#y now", `see ${GONE} now`],
    ["see //127.0.0.1/admin now", `see ${GONE} now`],
    ["see //user:pw@host.example/x now", `see ${GONE} now`],
    ["(//evil.example), then //evil.example.", `(${GONE}), then ${GONE}.`],
    ["see www.example.com now", `see ${GONE} now`],
    ["see WWW.A.EXAMPLE/x?y now", `see ${GONE} now`],
    ["see www.host.tld. Then www.a.example/b, www.a.xn--p1ai", `see ${GONE}. Then ${GONE}, ${GONE}`],
    ["a TODO //TODO and a link //evil.example/x in one line", `a TODO //TODO and a link ${GONE} in one line`],
    ["C://Users and https://evil.example/x", `C://Users and ${GONE}`],
    ["[a](//TODO) and [b](www.html) and [c](C://Users) and [d](www.example.com)", `a ${GONE} and b (www.html) and c ${GONE} and d ${GONE}`],
  ])("still takes out %s", (text, expected) => {
    expect(cleanAiText(text)).toBe(expected);
  });
});

describe("evidence that says nothing (W2e-R4)", () => {
  it("measures how much was written before anything is taken out, after only the hidden characters", () => {
    expect(writtenLength("http://x")).toBe(8);
    expect(writtenLength("https://a.b/c")).toBe(13);
    expect(writtenLength(`  yes${u(0x200b)}  it \n does  `)).toBe("yes it does".length);
    expect(writtenLength(undefined)).toBe(0);
    expect(writtenLength(42)).toBe(2);
  });

  it("says no when nothing is left but the places that were taken out", () => {
    for (const text of ["https://a.b/c", "http://example.com/a/very/long/address", "![](https://a.example/b.png)", "[](//host.example/x)", "<img src=x onerror=alert(1)>", "<b></b> <i></i>", "mailto:a@b.example", "a@b.example", "javascript:alert(1)", "https://a.example/b https://c.example/d", "   ", "", "...", "()"]) {
      expect(hasWords(text), text).toBe(false);
    }
  });

  it("says yes when there is a word or a number, whatever else is in the text", () => {
    for (const text of ["yes it does", "See https://a.example/b", "[the guide](https://a.example/b)", "<b>bold</b>", "Step 3", "日本語", "a"]) {
      expect(hasWords(text), text).toBe(true);
    }
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
    const shapes = ["a.".repeat(60_000), "[a](".repeat(30_000), "[".repeat(100_000), "![".repeat(50_000), ")".repeat(100_000) + "x", "//".repeat(50_000), "://".repeat(30_000), "www.".repeat(30_000), "https://".repeat(15_000), `${u(0x200b)}`.repeat(100_000), "a:/".repeat(40_000), "<".repeat(100_000), "<a ".repeat(40_000), "<!--".repeat(30_000), "<a".repeat(50_000), "@".repeat(100_000), "a@b.".repeat(30_000), "a@".repeat(50_000), "x".repeat(100_000) + "@", "javascript:".repeat(10_000), "data:text/".repeat(10_000), "a.b".repeat(40_000) + "@", "www.a.".repeat(20_000), "//a.".repeat(20_000), "//".repeat(20_000) + "a.bc"];
    for (const shape of shapes) {
      const start = Date.now();
      const out = cleanAiText(shape, 300);
      expect(Date.now() - start, shape.slice(0, 12)).toBeLessThan(1000);
      expect(Array.from(out).length).toBeLessThanOrEqual(300);
    }
  });
});
