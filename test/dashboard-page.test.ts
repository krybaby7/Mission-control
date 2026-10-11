// T-PAGE: static checks on dashboard/index.html (docs/dashboard-spec.md 15 and 17). No DOM library is used: the page
// is read as text, split into its markup, its one style and its one script, and the script is lexed so that comments,
// strings and regular expressions can be told apart. The browser checks (layout, focus, the page's own clock, copy)
// are run outside the repository with Playwright and are listed in the spec's section 15.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../src/dashboard/server.js";
import { CARD_KINDS, FEATURE_STATES, LAMP_STATES, MISSION_STATES, PILL_STATES, PROGRESS_STEPS, TICK_STATES, TONES } from "../src/dashboard/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(ROOT, "dashboard", "index.html");
const html = readFileSync(PAGE, "utf8");

/** The text between the one pair of <script> tags and the one pair of <style> tags. */
function inner(tag: "script" | "style"): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(html);
  return match?.[1] ?? "";
}
const script = inner("script");
const style = inner("style");
/** The page without its script and style: only the markup. */
const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "");

interface Lexed {
  /** The script with every comment blanked out (strings and regular expressions kept). */
  noComments: string;
  /** The script with comments, strings and regular expressions blanked out: only code is left. */
  code: string;
  /** Every string literal, unescaped only as far as quotes go. */
  strings: string[];
}

const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "else", "do", "instanceof"]);
const PUNCTUATION_BEFORE_REGEX = "(,=:[!&|?{};+-*%<>~^";

/** A small lexer, enough for this page's script: strings, template literals, regular expressions and both comment kinds. */
function lex(source: string): Lexed {
  let noComments = "";
  let code = "";
  const strings: string[] = [];
  let previous = ""; // the last significant token: a punctuation character, or a whole word
  let i = 0;
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  while (i < source.length) {
    const c = source[i] ?? "";
    const next = source[i + 1] ?? "";
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      noComments += blank(source.slice(i, stop));
      code += blank(source.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      noComments += blank(source.slice(i, stop));
      code += blank(source.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      const literal = source.slice(i, j + 1);
      strings.push(literal.slice(1, -1));
      noComments += literal;
      code += blank(literal);
      previous = "string";
      i = j + 1;
    } else if (c === "/" && (previous === "" || PUNCTUATION_BEFORE_REGEX.includes(previous) || KEYWORDS_BEFORE_REGEX.has(previous))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") j += 1;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j += 1;
      }
      j += 1;
      while (/[a-z]/i.test(source[j] ?? "")) j += 1;
      noComments += source.slice(i, j);
      code += blank(source.slice(i, j));
      previous = "regex";
      i = j;
    } else if (/[A-Za-z_$0-9]/.test(c)) {
      let j = i;
      while (/[A-Za-z_$0-9]/.test(source[j] ?? "")) j += 1;
      previous = source.slice(i, j);
      noComments += previous;
      code += previous;
      i = j;
    } else {
      if (!/\s/.test(c)) previous = c;
      noComments += c;
      code += c;
      i += 1;
    }
  }
  return { noComments, code, strings };
}

const lexed = lex(script);

/** Text that is on the page for a reader: the string literals of the script and the text between the tags of the markup. */
const visibleText = [...lexed.strings, ...markup.replace(/<[^>]*>/g, "\n").split("\n")].map((t) => t.trim()).filter(Boolean);

describe("T-PAGE the page file", () => {
  it("is one file under 150 KB with one inline script and one inline style", () => {
    expect(statSync(PAGE).size).toBeLessThan(150 * 1024);
    expect(html.match(/<script\b/gi)).toHaveLength(1);
    expect(html.match(/<style\b/gi)).toHaveLength(1);
    expect(script.length).toBeGreaterThan(1000);
    expect(style.length).toBeGreaterThan(1000);
  });

  it("is a page with the right frame: doctype, lang, title, viewport, colour schemes", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Mission Control</title>");
    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1/);
    expect(style).toContain("prefers-color-scheme: dark");
    expect(style).toContain(':root:not([data-theme="light"])');
    expect(style).toContain(':root[data-theme="dark"]');
    expect(style).toContain("prefers-reduced-motion");
    expect(html).toContain('aria-live="polite"');
  });

  it("makes no external request: no http(s) address, no protocol-relative address, no <link>, no src or href but #", () => {
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<(?:img|iframe|object|embed|form|base|video|audio|source|track)\b/i);
    expect(html).not.toMatch(/<meta[^>]+http-equiv/i);
    expect(style).not.toMatch(/@import|url\(/i);
    for (const attribute of markup.matchAll(/\s(src|href|action|data|poster|srcset)\s*=\s*(["'])(.*?)\2/gi)) {
      expect(attribute[3], `${attribute[1] ?? ""} attribute`).toMatch(/^#/);
    }
    expect(markup).not.toMatch(/\s(?:src|href|action|data|poster|srcset)\s*=\s*[^"'\s>]/i); // unquoted
    for (const text of lexed.strings) expect(text, "a script string").not.toMatch(/^(?:\/\/|https?:|data:|javascript:)/i);
    for (const call of lexed.noComments.matchAll(/setAttribute\(\s*"(href|src)"\s*,\s*"([^"]*)"/g)) expect(call[2]).toMatch(/^#/);
  });

  it("uses no style attribute and no inline event handler (the policy forbids both); widths are set through the CSSOM", () => {
    expect(markup).not.toMatch(/\sstyle\s*=/i);
    expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
    expect(lexed.noComments).not.toMatch(/setAttribute\(\s*["']style["']/);
    expect(lexed.noComments).not.toMatch(/\.cssText\b|insertRule|adoptedStyleSheets/);
    expect(lexed.noComments).toMatch(/\.style\.width\s*=/);
  });

  it("never turns a string into markup or code", () => {
    for (const forbidden of [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write(?:ln)?\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\bsetTimeout\s*\(\s*["'`]/, /\bsetInterval\s*\(\s*["'`]/, /\bimportScripts\b/, /\bimport\s*\(/, /\bsrcdoc\b/, /\bcreateContextualFragment\b/, /\bDOMParser\b/, /\bjavascript:/]) {
      expect(lexed.noComments).not.toMatch(forbidden);
    }
  });

  it("asks one address only, with fetch, and sends nothing anywhere", () => {
    const calls = [...lexed.code.matchAll(/\bfetch\s*\(/g)];
    expect(calls).toHaveLength(1);
    const at = calls[0]?.index ?? 0;
    expect(lexed.noComments.slice(at).replace(/\s+/g, " ")).toMatch(/^fetch\("\/api\/snapshot", options\)/);
    for (const other of [/\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bsendBeacon\b/, /\bserviceWorker\b/, /\bwindow\.open\b/, /\blocation\.(?:assign|replace|href)\b/, /\bFormData\b/, /\bmethod\s*:\s*["'](?:POST|PUT|PATCH|DELETE)/i, /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bdocument\.cookie\b/]) {
      expect(lexed.noComments).not.toMatch(other);
    }
    expect(lexed.strings).toContain("/api/snapshot");
    expect(lexed.strings.filter((t) => t.startsWith("/"))).toEqual(["/api/snapshot"]);
  });

  it("is a script that compiles", () => {
    expect(() => new Script(script, { filename: "dashboard/index.html" })).not.toThrow();
  });

  it("looks up only elements that the markup has", () => {
    const wanted = new Set<string>();
    for (const m of lexed.noComments.matchAll(/(?:\$|getElementById)\(\s*"([^"]+)"\s*\)/g)) wanted.add(m[1] ?? "");
    const present = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ""));
    // "mc-demo" is the one block that exists only in the generated demo page (spec 17.2)
    const missing = [...wanted].filter((id) => !present.has(id) && id !== "mc-demo");
    expect(missing).toEqual([]);
    expect(wanted.size).toBeGreaterThan(20);
    const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size, "an id appears twice").toBe(ids.length);
  });

  it("knows every state id of the contract, so none is drawn as an unknown one", () => {
    const lists = { LAMP_STATES, MISSION_STATES, FEATURE_STATES, PILL_STATES, TONES, CARD_KINDS, TICK_STATES, PROGRESS_STEPS };
    for (const [name, ids] of Object.entries(lists)) {
      for (const id of ids) expect(lexed.noComments, `${name}: ${id}`).toMatch(new RegExp(`(?<![A-Za-z0-9_])${id}(?![A-Za-z0-9_])`));
    }
  });
});

describe("T-PAGE the page's words (docs/dashboard-spec.md 17.1)", () => {
  /** Every exact string, and every fixed fragment around a number or a snapshot string, of the "Page words" table. */
  const PAGE_WORDS = [
    "Tonight",
    "Needs you",
    "Needs you (",
    "Timeline",
    "Morning debrief",
    "These are the things the AI team could not settle alone.",
    "What happened",
    "If you do nothing",
    "Tell the leader",
    "Open the question",
    "Stop tonight's run",
    "Quick answers",
    "Add your own words",
    "Type here (optional)",
    "Copy",
    "Close",
    "Copied. Paste it into your chat with the leader.",
    "Reinforcements called in: ",
    "none",
    " steps used)",
    " of ",
    "Recovered after a retry",
    "Repair feature",
    "1 check written for this feature",
    " checks written for this feature",
    "No checks written for this feature",
    "repair round",
    "Allowance (usage left in your plans)",
    "work pauses here",
    "Open from before (",
    "Updated ",
    " s ago)",
    "Earlier events are not shown (",
    ").",
    " times)",
    "What you got",
    "Not finished",
    "Night result",
    "Allowance now",
    " AI runs)",
    "Yes",
    "Not this time",
    "Could not tell",
    "No missions yet. When one is queued it appears here.",
    "Nothing needs you right now.",
    "Nothing has happened tonight yet.",
    "The morning debrief appears when tonight's work has finished or paused.",
    "This page and Mission Control are different versions. Reload the page.",
    "Cannot reach Mission Control.",
    "Demo data. This is not live.",
    "Now:",
  ];

  it.each(PAGE_WORDS.map((w) => [w] as const))("contains %j", (word) => {
    expect(html.includes(word)).toBe(true);
  });

  it("has the demo hooks of spec 17.2 and never the demo data block itself", () => {
    expect(html).toContain("mc-demo");
    expect(html).toContain("#demo=");
    expect(html).not.toMatch(/<script\b[^>]*type="application\/json"/i);
    expect(html).not.toContain("<!--"); // the demo block is inserted before the first <script tag
    expect(html.indexOf("<script")).toBeGreaterThan(0);
  });

  it("writes no word the glossary forbids, no em dash and no emoji", () => {
    const forbidden = /(?<![A-Za-z])(?:builder|test writer|acceptance|git|crash|crashed|worktree|branch|frozen|gate|escalation|rung|token|objective|internal error|mission\.json|repair lap|halted|killed|AI programs|the AIs)(?![A-Za-z])/i;
    const found = visibleText.filter((t) => forbidden.test(t));
    expect(found).toEqual([]);
    expect(html).not.toContain("\u2014");
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("uses curly quotes in what it shows and straight ones only to build the sentence for the chat", () => {
    for (const text of visibleText.filter((t) => /^[A-Z][^"]*$/.test(t))) expect(text).not.toContain('"');
  });
});

describe("T-PAGE the page and the server agree", () => {
  it("has a policy with the hash of its one script and its one style and no 'unsafe-inline'", () => {
    const policy = contentSecurityPolicy(html);
    expect(policy).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+=*'(?:;|$)/);
    expect(policy).toMatch(/style-src 'sha256-[A-Za-z0-9+/]+=*'(?:;|$)/);
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'self'");
  });

  it("stays valid when the demo block is inserted before the first <script tag (spec 17.2)", () => {
    const at = html.indexOf("<script");
    const block = `<script type="application/json" id="mc-demo">{"done":{"a":"\\u003c/script>"}}</script>\n`;
    const demo = html.slice(0, at) + block + html.slice(at);
    expect(demo.match(/<script\b/gi)).toHaveLength(2);
    expect(contentSecurityPolicy(demo).match(/'sha256-/g)).toHaveLength(3); // the data block, the script and the style
    expect(demo.indexOf('id="mc-demo"')).toBeLessThan(demo.indexOf("(function () {"));
  });
});
