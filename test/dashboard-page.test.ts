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
import { CARD_KINDS, FEATURE_STATES, LAMP_STATES, MISSION_STATES, PILL_STATES, PROGRESS_STEPS, SCOPES, TICK_STATES, TONES } from "../src/dashboard/types.js";

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

  it("splits the missions by the scope ids of the contract: earlier ones in the quiet row, everything else in the main list", () => {
    expect([...SCOPES]).toEqual(["recent", "earlier"]);
    const now = functionSource("renderNow");
    const row = functionSource("earlierRow");
    expect(now).toContain('m.scope !== "earlier"');
    expect(row).toContain('m.scope === "earlier"');
    // an unknown scope is shown in the main list, never hidden; the count comes from counts.openFromEarlier
    expect(row).toContain("snap.counts.openFromEarlier");
    expect(lexed.strings).not.toContain("before");
  });
});

describe("T-PAGE the page's words (docs/dashboard-spec.md 17.1)", () => {
  /** Every exact string, and every fixed fragment around a number or a snapshot string, of the "Page words" table. */
  const PAGE_WORDS = [
    // tabs
    "Now",
    "Needs you",
    "Needs you (",
    "Timeline",
    "Results",
    "These are the things the AI team could not settle alone.",
    "What happened",
    "If you do nothing",
    // buttons: on every card and tile, the global bar, and the sentence that opens the stop sheet
    "Tell the leader about this",
    "Tell the leader anything",
    "Stop the current run",
    "Tell the leader",
    "Open the question",
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
    // a feature checked by a second AI has no test files: its tile says how many checks are on the list (docs/modes-spec.md, 11.5)
    "1 check on your list",
    " checks on your list",
    "Built on the first try.",
    "repair round",
    "Allowance (how much of your plans is used)",
    "work pauses here",
    "Earlier work still open (",
    "Updated ",
    " s ago)",
    "Earlier events are not shown (",
    "1 more mission is not shown. The lamp above counts it.",
    " more missions are not shown. The lamp above counts them.",
    "1 more thing for you is not shown. The lamp on the Now tab counts it.",
    " more things for you are not shown. The lamp on the Now tab counts them.",
    ").",
    " times)",
    // results
    "What you got",
    "Not finished",
    "How it went",
    "Allowance now",
    " AI runs)",
    "Yes",
    "Not this time",
    "Could not tell",
    // empty states
    "No missions yet. When one is queued it appears here.",
    "Nothing needs you right now.",
    "Nothing for you to decide. See the note above.",
    "Nothing for you to decide. See the note on the Now tab.",
    "Nothing has happened yet.",
    "Results appear when work has finished or paused.",
    "Results are ready",
    "This page and Mission Control are different versions. Reload the page.",
    "Cannot reach Mission Control.",
    "Demo data. This is not live.",
    "Now:",
    // review round: what to do, a calm strip that never contradicts the lamp, folded finished missions, the sheet that
    // says it cannot send, and where a stopped mission stopped
    "What to do",
    "Built and checked on the first try.",
    " features done ",
    "(show)",
    "(hide)",
    "This page cannot send messages. Pick or type an answer, tap Copy, then paste it into your chat with the leader.",
    "This page cannot stop the run. Tap Copy, then paste the sentence into your chat with the leader.",
    "Your message (preview)",
    "Choose a quick answer or type your own words first, then tap Copy.",
    "Stopped here",
    "Paused here",
    // a check the owner asked for: what to look at, and the two answers, which are sentences to copy like every other button
    "What to look at",
    "Tell the leader: approve",
    "Tell the leader: send it back",
    "This page cannot send messages. Tap Copy, then paste the sentence into your chat with the leader.",
  ];

  it.each(PAGE_WORDS.map((w) => [w] as const))("contains %j", (word) => {
    expect(html.includes(word)).toBe(true);
  });

  it("has the four tabs Now, Needs you, Timeline, Results, in that order, each with its own panel", () => {
    const tabs = [...markup.matchAll(/<button\b[^>]*\brole="tab"[^>]*\bid="tab-([a-z]+)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[1], m[2]]);
    expect(tabs).toEqual([["now", "Now"], ["needs", "Needs you"], ["timeline", "Timeline"], ["results", "Results"]]);
    for (const [id] of tabs) expect(markup).toMatch(new RegExp(`role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}"`));
    expect(lexed.noComments).toContain('var TABS = ["now", "needs", "timeline", "results"];');
    expect(lexed.noComments).toContain('tab: "now"');
  });

  it("names its buttons in the owner's words: about this, anything, and the current run", () => {
    expect(lexed.noComments).toContain('tell: "Tell the leader about this"');
    expect(markup).toMatch(/<button[^>]*id="gbar-tell"[^>]*>Tell the leader anything<\/button>/);
    expect(markup).toMatch(/<button[^>]*id="gbar-stop"[^>]*>Stop the current run<\/button>/);
    expect(markup).toMatch(/<h2 id="sheet-title">Tell the leader<\/h2>/);
    // the card, tile, earlier-work and results buttons all come from tellButton, which uses the one word W.tell
    expect(functionSource("tellButton")).toContain("W.tell)");
    expect(lexed.noComments).not.toMatch(/\bel\("button", [^)]*"Tell the leader/);
  });

  it("has a header with the product name and the freshness line only", () => {
    const header = /<header class="top">([\s\S]*?)<\/header>/.exec(markup)?.[1] ?? "";
    expect([...header.matchAll(/<(h1|p)\b/g)].map((m) => m[1])).toEqual(["h1", "p"]);
    expect(header).toContain('<h1 class="brand">Mission Control</h1>');
    expect(header).toContain('id="fresh"');
    expect(header).not.toMatch(/\bRun,|<time\b/i);
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

  it("never frames the work around a time of day: not in a string, a comment, an id, a class or an identifier", () => {
    // The pattern is written with a bracket in each word so that this file does not hold the words it forbids: the
    // two stems cover every longer form (the evening and early-day words, and their compounds). "midnight" is the one allowed word.
    const forbidden = /n[i]ght|mor[n]ing/i;
    const withoutMidnight = (text: string): string => text.replace(/midn[i]ght/gi, "");
    for (const [name, text] of [["dashboard/index.html", html], ["test/dashboard-page.test.ts", readFileSync(fileURLToPath(import.meta.url), "utf8")] as const]) {
      const found = withoutMidnight(text).split("\n").filter((line) => forbidden.test(line));
      expect(found, name).toEqual([]);
    }
  });

  it("keeps none of the retired page words or names", () => {
    for (const retired of ["Open from before", "openBefore", "beforeOpen", "debriefRow", "renderDebrief", "tab-debrief", "panel-debrief", "data-tab=\"debrief\"", "older-list", "openFromBefore"]) {
      expect(html, retired).not.toContain(retired);
    }
  });

  it("uses curly quotes in what it shows and straight ones only to build the sentence for the chat", () => {
    for (const text of visibleText.filter((t) => /^[A-Z][^"]*$/.test(t))) expect(text).not.toContain('"');
  });
});

/** The source of one function of the script, from its `function name(` to the next function of the same indent. */
function functionSource(name: string): string {
  const start = lexed.noComments.indexOf(`  function ${name}(`);
  expect(start, `function ${name}`).toBeGreaterThanOrEqual(0);
  const end = lexed.noComments.indexOf("\n  }\n", start);
  return lexed.noComments.slice(start, end + 5);
}

describe("T-PAGE what the review round asked for (page parts of M5, M6, M7, m8 to m13, m15)", () => {
  it("M5: the calm strip depends on the lamp: green only for on_track, nothing for idle, a muted line otherwise", () => {
    const strip = functionSource("strip");
    expect(strip).toContain("lampState === \"idle\"");
    expect(strip).toContain("lampState === \"on_track\"");
    // the green check is drawn inside the on_track branch only, and the other branch says the note above is the thing to read
    expect(strip.indexOf("lampState === \"on_track\"")).toBeLessThan(strip.indexOf("ic(\"check\")"));
    expect(strip.indexOf("ic(\"check\")")).toBeLessThan(strip.indexOf("W.calmLook"));
    // it is painted from the lamp that is showing (the page's own clock can swap the lamp), not only from the snapshot
    expect(functionSource("paintLamp")).toContain("paintUnderLamp(lamp)");
    expect(functionSource("paintUnderLamp")).toContain("lamp.state");
  });

  it("V6: the Needs you tab with no cards also depends on the lamp: the plain line only beside a green or grey lamp, else a pointer to the Now tab", () => {
    const words = functionSource("needsEmptyWords");
    expect(words).toContain('lampState === "on_track" || lampState === "idle"');
    expect(words.indexOf("W.emptyCards")).toBeLessThan(words.indexOf("W.calmLookNeeds"));
    // drawn from the lamp that is showing, and written again when the page's own clock changes the lamp
    const needs = functionSource("renderNeeds");
    expect(needs).toContain("needsEmptyWords(effectiveLamp(snap, state.level).state)");
    expect(needs).toContain('"data-empty", "needs"');
    expect(functionSource("paintNeedsEmpty")).toContain("needsEmptyWords(lampState)");
    expect(functionSource("paintLamp")).toContain("paintNeedsEmpty(lamp.state)");
    // the two pointers say where the note is: above on the Now tab, on the Now tab from the Needs you tab
    expect(lexed.noComments).toContain('calmLook: "Nothing for you to decide. See the note above."');
    expect(lexed.noComments).toContain('calmLookNeeds: "Nothing for you to decide. See the note on the Now tab."');
  });

  it("M6: a strip row carries a second line and a card shows What to do, both only when the engine wrote a step", () => {
    const sub = functionSource("stripSub");
    expect(sub).toContain("todo.text");
    expect(sub).toContain("author !== \"ai\"");
    expect(sub).toContain("what.author === \"engine\"");
    expect(sub).toContain("firstSentence");
    expect(lexed.noComments).toContain("c.whatToDo && c.whatToDo.text");
    // the section sits between What happened and If you do nothing
    const card = functionSource("card");
    for (const word of ["W.happened", "W.whatToDo", "W.ifNothing"]) expect(card).toContain(word);
    expect(card).toContain("add(body, what, todo, nothing)");
  });

  it("M7: a first-try feature is one calm line, pips only for tries that matter, finished missions fold away, groups are ordered", () => {
    expect(functionSource("firstTryDone")).toMatch(/f\.state === "done" && f\.reinforcements === 0 && !f\.recovered/);
    const tile = functionSource("tile");
    // the calm tile returns before the steps line, the checks line and the button are built
    expect(tile.indexOf("firstTryDone(f)")).toBeLessThan(tile.indexOf("showTries(f)"));
    expect(tile.indexOf("W.firstTry")).toBeLessThan(tile.indexOf("tellButton("));
    expect(tile.slice(tile.indexOf("firstTryDone(f)"), tile.indexOf("showTries(f)"))).toContain("return t;");
    const tries = functionSource("showTries");
    for (const id of ["stuck", "being_built", "being_reviewed", "paused"]) expect(tries).toContain(`"${id}"`);
    expect(tries).toContain("f.reinforcements > 0");
    expect(lexed.noComments).toMatch(/el\("details", "donebox"\)/);
    expect(functionSource("missionGroup")).toContain("m.state === \"done\" ? doneFold(m, tiles)");
    // the order of 5 in the decisions: needs you or failed, stuck, working, waiting, paused, done, queued
    const order = /var order = \{([^}]*)\}/.exec(lexed.noComments)?.[1] ?? "";
    const ranks = [...order.matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])] as const);
    expect(ranks.map(([id]) => id)).toEqual(["working", "waiting", "paused", "done", "not_started"]);
    expect(ranks.map(([, rank]) => rank)).toEqual([...ranks.map(([, rank]) => rank)].sort((a, b) => a - b));
    const rank = functionSource("groupRank");
    expect(rank.indexOf("needs_you")).toBeLessThan(rank.indexOf("stuck"));
    expect(rank.indexOf("stuck")).toBeLessThan(rank.indexOf("var order"));
  });

  it("a feature checked by a second AI never gets the words that claim tests: its own first-try line, its own checks line", () => {
    expect(functionSource("byReading")).toContain("typeof f.modeChecks === \"number\"");
    const checks = functionSource("checksLine");
    expect(checks.indexOf("byReading(f)")).toBeLessThan(checks.indexOf("W.checkNone"));
    expect(checks).toContain("f.checkedBy");
    expect(checks).toContain("W.listOne");
    expect(checks).toContain("W.listMany");
    expect(functionSource("tile")).toContain("byReading(f) ? W.firstTryRead : W.firstTry");
    // the page never writes "checked" for such a feature by itself: those words are only in the first-try line of the other features
    expect(lexed.strings.filter((x) => /on your list/.test(x))).toEqual(["1 check on your list", " checks on your list"]);
  });

  it("M7: a folded mission is a native details element, so Enter and Space work, and it keeps its state across redraws", () => {
    const fold = functionSource("doneFold");
    expect(fold).toContain("el(\"summary\"");
    expect(fold).toContain("data-key");
    expect(fold).toContain("state.doneOpen[m.id]");
    expect(fold).toContain("W.doneShow");
    expect(fold).toContain("W.doneHide");
  });

  it("m8: a sentence that is already said above is not said again (the Now line and the mission sentence)", () => {
    expect(functionSource("paintLamp")).toContain("snap.now.text !== lamp.sentence");
    const group = functionSource("missionGroup");
    expect(group).toContain("m.sentence === snap.lamp.sentence");
    expect(group).toContain("m.sentence === snap.now.text");
    expect(group).toContain("m.state === \"needs_you\" && snap.needsYou.some(");
    // with nothing planned there is one line, not a heading and a line; the line says "no missions" only when there is
    // none at all (with only earlier work open, the quiet row is the answer and "No missions yet" above it would contradict it)
    const now = functionSource("renderNow");
    expect(now).toMatch(/current\.length === 0\) \{ if \(snap\.missions\.length === 0\) features\.appendChild\(el\("p", "empty", W\.emptyMissions\)\); \}\s*else features\.appendChild\(el\("h2"/);
    expect(now).toContain("if (features.firstChild) frag.appendChild(features);");
  });

  it("m9: the sheet says first that it cannot send, lays out answer, words, preview in that order, and Copy waits for a message", () => {
    const at = (id: string): number => markup.indexOf(`id="${id}"`);
    expect(at("sheet-cannot")).toBeGreaterThan(at("sheet-title"));
    expect(at("sheet-cannot")).toBeLessThan(at("sheet-phrases-box"));
    expect(at("sheet-phrases-box")).toBeLessThan(at("sheet-own-box"));
    expect(at("sheet-own-box")).toBeLessThan(at("sheet-msg"));
    expect(markup).toMatch(/id="sheet-msg"[^>]*\breadonly\b/);
    // Copy waits for a message: the stop sentence and a sentence with nothing to fill in (an approval) are complete as they are,
    // every other sentence needs a quick answer or the owner's own words first.
    expect(lexed.noComments).toMatch(/function canCopy\(\) \{ return sheet\.mode === "stop" \|\| sheet\.template\.indexOf\(PLACEHOLDER\) < 0 \|\| sheet\.answer\.trim\(\) !== ""; \}/);
    expect(functionSource("copyMessage")).toContain("if (!canCopy())");
    expect(lexed.noComments).toContain('"aria-disabled"');
    expect(style).toContain('.btn[aria-disabled="true"]');
  });

  it("m10: the bar's button is about anything, the card and tile buttons are about this, Stop shows only while a run is on", () => {
    expect(markup).toMatch(/<button[^>]*id="gbar-tell"[^>]*>Tell the leader anything<\/button>/);
    expect(functionSource("tellButton")).toContain("W.tell)");
    expect(functionSource("paintGbar")).toContain("snap.run.active || snap.run.stopRequested");
  });

  it("m11: when results are ready a link row to the Results tab sits under the lamp, only without a live run", () => {
    expect(functionSource("paintUnderLamp")).toContain("snap.debrief && !snap.run.active");
    const row = functionSource("resultsRow");
    expect(row).toContain("W.resultsReady");
    expect(row).toContain("selectTab(\"results\"");
    expect(row).toContain("el(\"button\"");
    expect(lexed.noComments).toContain('resultsReady: "Results are ready"');
  });

  it("m12: the AI label comes once above a list of short stories, and stays boxed for what is not finished", () => {
    const list = functionSource("featureList");
    expect(list).toContain("once");
    expect(list).toContain("aiLabel(");
    const mission = functionSource("resultsMission");
    expect(mission).toMatch(/featureList\(W\.gotHeading, d\.got, snap, true\)/);
    expect(mission).toMatch(/featureList\(W\.notFinished, d\.leftOut, snap, false\)/);
    expect(mission).toMatch(/featureList\(W\.recovered, d\.recovered, snap, true\)/);
  });

  it("m13: at Not responding the frozen live lines are left out, and the greyed content stays readable (opacity of at least 0.9)", () => {
    expect(functionSource("paintLamp")).toContain("state.level < 2");
    const rule = /\.gone \.panel > :not\(\.lamp\) \{([^}]*)\}/.exec(style)?.[1] ?? "";
    expect(rule).toContain("grayscale(1)");
    expect(Number(/opacity:\s*([0-9.]+)/.exec(rule)?.[1])).toBeGreaterThanOrEqual(0.9);
  });

  it("m15: a stopped or paused mission does not draw its current step as work, and a card scrolled to clears the top edge", () => {
    const stepper = functionSource("stepper");
    expect(stepper).toContain("m.state === \"needs_you\" || m.state === \"paused\"");
    expect(stepper).toContain("W.stoppedHere");
    expect(stepper).toContain("W.pausedHere");
    expect(style).toMatch(/\.card \{[^}]*scroll-margin-top: calc\(16px/);
    expect(functionSource("goCard")).toContain("requestAnimationFrame");
  });
});

describe("T-PAGE a check the owner asked for (docs/checkpoints-spec.md, 10)", () => {
  it("draws the card with an eye, and the page has the eye in its sprite", () => {
    expect(lexed.noComments).toMatch(/CARD_ICON = \{[^}]*checkpoint: "eye"/);
    expect(markup).toContain('<symbol id="i-eye"');
  });

  it("gives the card two buttons, approve and send it back, only when the snapshot has the two answers", () => {
    const card = functionSource("card");
    expect(card).toContain("if (c.answers)");
    expect(card).toContain("tellButton(c.answers.approve,");
    expect(card).toContain("tellButton(c.answers.sendBack,");
    expect(card.indexOf("W.approveBtn")).toBeLessThan(card.indexOf("W.sendBackBtn"));
    // the generic button stays, after the two, as the quiet one
    expect(card.indexOf("W.sendBackBtn")).toBeLessThan(card.indexOf("tellButton(c.tellLeader,"));
    expect(card).toContain("!!c.answers");
    expect(lexed.noComments).toContain('approveBtn: "Tell the leader: approve"');
    expect(lexed.noComments).toContain('sendBackBtn: "Tell the leader: send it back"');
  });

  it("a button only opens the sheet with a sentence to copy: the buttons add no way to send an approval", () => {
    const button = functionSource("tellButton");
    expect(button).toContain("openSheet(\"tell\", template, b)");
    expect(button).toContain("label || W.tell");
    // the page's only request is still the one read of the snapshot (the fetch test above), and no method but GET appears
    expect(lexed.noComments).not.toMatch(/method\s*:/);
  });

  it("shows the look's lines under What happened: one label for the list, then each line as a quote", () => {
    const card = functionSource("card");
    expect(card).toContain("c.lines && c.lines.length");
    expect(card).toContain("aiLabel(snap.leader.aiNotice)");
    expect(card).toContain("quoted(line)");
    expect(card.indexOf("W.happened")).toBeLessThan(card.indexOf("W.lookAt"));
    expect(card).toContain("add(body, what, todo, nothing)");
  });

  it("puts an AI-written line in curly quotes, but never doubles a mark that the line already has", () => {
    const inCurlyQuotes = new Function(`${functionSource("inCurlyQuotes")}\nreturn inCurlyQuotes;`)() as (text: string) => string;
    // A plain line gets its pair.
    expect(inCurlyQuotes("Add a whisper command")).toBe("“Add a whisper command”");
    expect(inCurlyQuotes("Check for “Add whisper”: it whispers")).toBe("“Check for “Add whisper”: it whispers”");
    // A line that starts with an opening mark (the plan card's “Title”: story lines) is shown as it is: no ““ at the start.
    const startsWith = "“Add whisper”: As a user I can whisper a message.";
    expect(inCurlyQuotes(startsWith)).toBe(startsWith);
    // A line that ends with a closing mark is shown as it is: no ”” at the end.
    const endsWith = "The next feature is “Add whisper”";
    expect(inCurlyQuotes(endsWith)).toBe(endsWith);
    // A line that is already one quotation, and one with spaces around it.
    expect(inCurlyQuotes("“Add whisper”")).toBe("“Add whisper”");
    expect(inCurlyQuotes("  “Add whisper”: story  ")).toBe("  “Add whisper”: story  ");
    for (const line of [startsWith, endsWith, "Add a whisper command", "“A” and “B”"]) {
      const shownLine = inCurlyQuotes(line);
      expect(shownLine.startsWith("““"), shownLine).toBe(false);
      expect(shownLine.endsWith("””"), shownLine).toBe(false);
    }
    // Both places that quote AI text use it; no other place writes the quote marks itself.
    expect(functionSource("aiBlock")).toContain("inCurlyQuotes(text)");
    expect(functionSource("quoted")).toContain("inCurlyQuotes(s.text)");
    expect(script.match(/\\u201C/g)).toHaveLength(2);
  });

  it("a sentence with nothing to fill in is complete: Copy works at once, and the sheet hides the answers it does not need", () => {
    const open = functionSource("openSheet");
    expect(open).toContain('var ready = !stop && template.indexOf(PLACEHOLDER) < 0;');
    expect(open).toContain("W.cannotSendReady");
    expect(open).toContain("$(\"sheet-phrases-box\").hidden = stop || ready;");
    expect(open).toContain("$(\"sheet-own-box\").hidden = stop || ready;");
    // a sentence with the placeholder still waits for an answer
    expect(lexed.noComments).toMatch(/function canCopy\(\) \{ return [^}]*\|\| sheet\.answer\.trim\(\) !== ""; \}/);
  });

  it("the card with the buttons wraps on a phone", () => {
    expect(style).toMatch(/\.card-foot \{[^}]*display: flex; flex-wrap: wrap;/);
  });
});

describe("T-PAGE a list that the snapshot cut says so (counts.missionsNotShown and counts.cardsNotShown, spec 3.2)", () => {
  it("says how many missions and cards are not listed, from the two counts, with the lamp counting them", () => {
    expect(functionSource("renderNow")).toContain("snap.counts.missionsNotShown");
    expect(functionSource("renderNow")).toContain("W.missionNotShown");
    expect(functionSource("renderNow")).toContain("W.missionsNotShown");
    expect(functionSource("renderNeeds")).toContain("snap.counts.cardsNotShown");
    expect(functionSource("renderNeeds")).toContain("W.cardNotShown");
    expect(functionSource("renderNeeds")).toContain("W.cardsNotShown");
  });
});

describe("T-PAGE how a feature was checked (docs/modes-spec.md, 11.4)", () => {
  it("draws the snapshot's checkedBy line under each finished feature, as plain text, and only when the snapshot has it", () => {
    const list = functionSource("featureList");
    expect(list).toContain("f.checkedBy");
    expect(list).toMatch(/if \(f\.checkedBy\) li\.appendChild\(el\("p", "small muted", f\.checkedBy\)\);/);
    // the line is text from the snapshot: it is never turned into markup
    expect(list).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it("adds no new look to the page: the line uses the classes of the planned-features line", () => {
    expect(functionSource("resultsMission")).toContain('el("p", "small muted", d.plannedLine)');
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
