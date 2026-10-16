// Text that a second AI wrote about files it did not write (its evidence and its notes). It can quote a hostile file, so before it
// reaches a report, a pull request text, a card or a terminal it is made plain: nothing hidden, nothing that draws a picture or a
// link, no raw HTML tag, and no web address, e-mail address or script address. The second AI's words stay readable; only the parts
// that could do something are changed. A tag becomes its name in words (`div tag`), so a sentence about a page still reads.

/**
 * Control, format, private-use, unassigned, surrogate and separator characters, odd spaces, variation selectors and blank-looking
 * letters. This is the class the plan reader bans (`HIDDEN` in plan.ts); a test compares the two on every code point.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]|(?! )\p{Zs}|[\p{Variation_Selector}]|[\p{Default_Ignorable_Code_Point}]/u;

/** White space that is not a plain space: it becomes a plain space, so the words around it stay apart. */
const SPACE_LIKE = /[\t\n\v\f\r\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;

/** True for a character that cannot be seen (the class above, and the blank braille cell U+2800 that no property covers). */
export function isHiddenChar(ch: string): boolean {
  return HIDDEN.test(ch) || ch.codePointAt(0) === 0x2800;
}

/** What stands where a web address, an e-mail address or a script address was. */
export const WEB_ADDRESS_REMOVED = "(web address removed)";

/** How many characters of the text are looked at: the rest is far more than any message keeps. */
const LOOK_MAX = 8_000;

/** `[text](where)` and `![text](where)`: the destination runs to the first closing bracket. */
const MARKDOWN_LINK = /(!?)\[([^[\]]*)\]\(([^)]*)\)/gu;
/** What ends an address in running text: white space, and the marks that close an attribute or a bracket of a tag or an automatic link. */
const ADDRESS_END = /[\s"<>`]/u;

/**
 * A host as it is written in an address: names with dots whose last part has two or more letters (`example.com`, `a.b.example`,
 * `xn--p1ai`), or four numbers with dots (`127.0.0.1`). A single word (`TODO`), a name with one dot and a short ending (`e.g`), and
 * a ratio (`3`, `4`) are not hosts.
 */
const HOST = String.raw`(?:(?:[\p{L}\p{N}-]+\.)+\p{L}[\p{L}\p{N}-]*\p{L}|\d{1,3}(?:\.\d{1,3}){3})`;
/** An address that starts with two slashes and a host, perhaps with a user name before it: `//host.tld/path`. Not `a//b`, not `//TODO`, not `// note`. */
const SLASH_ADDRESS = new RegExp(String.raw`(^|[^\w:/.~-])\/{2,}(?=(?:[^\s/@"<>\x60]*@)?${HOST})[^\s"<>\x60]+`, "giu");
/** An address that starts with `www.` and a host: `www.host.tld`. Not the word `www.html`. */
const WWW_ADDRESS = new RegExp(String.raw`(^|[^\w.-])www\.(?=${HOST})[^\s"<>\x60]+`, "giu");
/**
 * The addresses of a link that run a script, show data or open a mail program, written `name:` and then the rest with no space
 * (`javascript:alert(1)`, `mailto:a@b.example`, `data:text/html,...`). A name that ends a longer word (`metadata:`) is not one, and
 * neither are the words as they stand in a sentence (`JavaScript: The Good Parts`, `data: three columns`, `{data:1}`).
 */
const SCRIPT_ADDRESS = /(?<![\p{L}\p{N}_-])(?:javascript|vbscript|livescript|mailto|data(?=:(?:[\w.+-]+\/|[;,]))):[^\s"<>`]+/giu;
/** An e-mail address: a name, an @ and a host (a viewer makes a link of it). */
const EMAIL_ADDRESS = new RegExp(String.raw`(?<![\w.+-])[\w.+-]+@${HOST}`, "giu");
/**
 * The start of a raw HTML tag, comment, declaration or instruction, and the rest of it up to the closing bracket when there is one:
 * `<img src=x onerror=alert(1)>`, `</a>`, `<!-- -->`, `<?php ?>`, `<javascript:alert(1)>`. Not `<U+202E>`: that is how Mission Control
 * itself shows a hidden character in a file name (`plainName`), and no tag has that name.
 */
const HTML_TAG = /<(?!U\+[0-9A-F]{4,6}>)(?=[A-Za-z/!?])([^<>]*>)?/gu;
/** Marks that end a sentence or close a bracket or a quote: they stay in the text after the address is taken out of it. */
const SENTENCE_MARKS = new Set(Array.from('.,;:!?)]}"\'”’»>'));

/**
 * The words that stand for an address, followed by the marks that most likely belonged to the sentence around it. A closing bracket
 * that closes a bracket opened inside the address (`javascript:alert(1)`, `.../Foo_(bar)`) belongs to the address.
 */
function removeAddress(token: string, mark: string): string {
  let opens = 0;
  let closes = 0;
  for (const c of token) {
    if (c === "(") opens++;
    else if (c === ")") closes++;
  }
  let end = token.length;
  while (end > 0 && SENTENCE_MARKS.has(token.charAt(end - 1))) {
    if (token.charAt(end - 1) === ")") {
      if (opens > closes - 1) break;
      closes--;
    }
    end--;
  }
  return mark + token.slice(end);
}

/**
 * Every web address that has a scheme (`http://`, `https://`, `ftp://`, ...), from the first letter of the scheme to where it ends
 * (ADDRESS_END). A scheme has two letters at least: `C://Users` (a drive) and `3://4` (a ratio) are not addresses.
 */
function plainSchemeAddresses(text: string, mark: string): string {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("://", from);
    if (at < 0) break;
    let start = at;
    while (start > from && /[a-z0-9+.-]/iu.test(text.charAt(start - 1))) start--;
    // A scheme starts with a letter.
    while (start < at && !/[a-z]/iu.test(text.charAt(start))) start++;
    if (at - start < 2) {
      parts.push(text.slice(from, at + 3));
      from = at + 3;
      continue;
    }
    let end = at + 3;
    while (end < text.length && !ADDRESS_END.test(text.charAt(end))) end++;
    parts.push(text.slice(from, start), removeAddress(text.slice(start, end), mark));
    from = end;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

function plainAddresses(text: string, mark: string): string {
  return plainSchemeAddresses(text, mark)
    .replace(SLASH_ADDRESS, (all, before: string) => before + removeAddress(all.slice(before.length), mark))
    .replace(WWW_ADDRESS, (all, before: string) => before + removeAddress(all.slice(before.length), mark))
    .replace(SCRIPT_ADDRESS, (all) => removeAddress(all, mark))
    .replace(EMAIL_ADDRESS, mark);
}

/** Longest tag name that is written out in words. A longer one is no tag name of HTML, and a tag is then just `tag`. */
const TAG_NAME_MAX = 20;

/** The letters that are said with a vowel sound when they stand alone (`an h1 tag`, `an svg tag`): ef, aitch, el, em, en, ar, ess, ex. */
const LETTER_WITH_VOWEL_SOUND = /^[fhlmnrsx]/u;

/**
 * The words for a tag, as plain as can be: its name and nothing from inside it, so no attribute, address or script can stay.
 * `<div class="x">` is `div tag`, `</div>` is `closing div tag`, `<!-- note -->` is `comment`. The name is cut to letters, digits and
 * dashes and written in lower case; a tag with no usable name is just `tag`. A tag that stands by itself (at the start, or right
 * after a quotation mark or a bracket) gets a word in front, `a div tag`, because it was the whole of what was quoted; anywhere else the
 * writer's own words in front of it (`the <title>`, `no <script>`) do that.
 */
function tagWords(tag: string, alone: boolean): string {
  if (tag.startsWith("<!--")) return alone ? "a comment" : "comment";
  const found = /^<(\/?)[!?]?([A-Za-z][A-Za-z0-9-]*)/u.exec(tag);
  const name = (found?.[2] ?? "").toLowerCase();
  if (name === "" || name.length > TAG_NAME_MAX) return alone ? "a tag" : "tag";
  if (found?.[1] === "/") return `${alone ? "a " : ""}closing ${name} tag`;
  // A name with a vowel is said as a word (`a div`, `an img`, `a ul`); one without is said letter by letter (`an h1`, `a td`).
  const spokenAsLetters = !/[aeiou]/u.test(name);
  const vowelSound = spokenAsLetters ? LETTER_WITH_VOWEL_SOUND.test(name) : /^[aeiou]/u.test(name) && !/^ul?$/u.test(name);
  return `${alone ? (vowelSound ? "an " : "a ") : ""}${name} tag`;
}

/**
 * Raw HTML out: a tag is replaced by its name in words (`tagWords`), or by one space when `words` is false (to find out whether anything
 * is left to read). The words stand apart from the text around them, so that text can not join into a new tag. A bracket that opens
 * something with no closing bracket is followed by a space, so it opens nothing. A bracket that is not followed by a letter, `/`,
 * `!` or `?` (`a < b`, `x<3`, `<-`) is plain text and stays.
 */
function plainTags(text: string, words: boolean): string {
  if (!text.includes("<")) return text;
  return text.replace(HTML_TAG, (all: string, closed: string | undefined, at: number, whole: string) => {
    if (closed === undefined) return "< ";
    if (!words) return " ";
    let back = at - 1;
    while (back >= 0 && whole.charAt(back) === " ") back--;
    const alone = back < 0 || /["“‘(]/u.test(whole.charAt(back));
    // No space is put next to a quotation mark or a bracket, or at an end: `inside "a div tag" there`.
    const before = at === 0 ? "" : whole.charAt(at - 1);
    const after = whole.charAt(at + all.length);
    const lead = before === "" || /[\s"“‘(]/u.test(before) ? "" : " ";
    const trail = after === "" || /[\s"”’).,;:!?]/u.test(after) ? "" : " ";
    return `${lead}${tagWords(all, alone)}${trail}`;
  });
}

/**
 * What a markdown link points to, when it is an address: any scheme with two slashes, two slashes and a name (a link to `//TODO` goes to
 * the host TODO, whatever a comment would mean), `www.` and a host (a link to `www.html` is a link to a file), or a script address.
 */
const LINK_ADDRESS = new RegExp(String.raw`^<?(?:[a-z][a-z0-9+.-]*:\/\/|\/{2,}[^\s/]|www\.${HOST}|(?:javascript|vbscript|livescript|mailto|data):)`, "iu");

/** True when `where` (what a markdown link points to) starts as a web address, an e-mail address or a script address. */
function isAddress(where: string): boolean {
  return LINK_ADDRESS.test(where);
}

/**
 * A link or a picture of markdown as plain words: the words of the link, then where it points, with a web address taken out.
 * What is left of the syntax afterwards (a picture mark whose brackets do not close, a bracket pair that touches a bracket)
 * cannot make a link or a picture either. `mark` stands where an address was, and `image` and `link` stand for a picture or a link
 * with no words.
 */
function plainLinks(text: string, mark: string, image: string, link: string): string {
  const out = text.replace(MARKDOWN_LINK, (_all, bang: string, label: string, target: string) => {
    const words = label.trim() === "" ? (bang === "!" ? image : link) : label.trim();
    const where = target.trim();
    if (where === "") return words;
    return isAddress(where) ? `${words} ${mark}` : `${words} (${where})`;
  });
  return out.replace(/!\[/gu, "[").replace(/\]\(/gu, "] (");
}

/** The text with the hidden characters out and odd white space made one plain space. Nothing else is changed. */
function visible(input: string): string {
  let seen = "";
  let looked = 0;
  for (const ch of input) {
    if (++looked > LOOK_MAX) break;
    if (SPACE_LIKE.test(ch)) seen += " ";
    else if (!isHiddenChar(ch)) seen += ch;
  }
  return seen;
}

function asText(text: unknown): string {
  return typeof text === "string" ? text : text === undefined || text === null ? "" : String(text);
}

function plain(text: unknown, max: number, mark: string, image: string, link: string, tagsAsWords: boolean): string {
  // Hidden characters are gone before the addresses are looked for, so a zero-width character cannot split `https://`.
  const clean = plainTags(plainAddresses(plainLinks(visible(asText(text)), mark, image, link), mark), tagsAsWords).replace(/ {2,}/gu, " ").trim();
  const points = Array.from(clean);
  if (points.length <= max) return clean;
  return points.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}

/**
 * `text` as one plain line of at most `max` characters (a closing `…` when it was cut):
 * hidden, zero-width and direction-changing characters are taken out (the class the plan reader bans), line breaks and odd
 * spaces become one space, a markdown picture or link becomes its words with the place it points to in brackets, a raw HTML tag
 * becomes its name in words (`a div tag`, `closing div tag`; the words between tags stay), and every web address (`http://`, `https://`, `//host.tld`,
 * `www.host.tld`), e-mail address and script address (`javascript:`, `vbscript:`, `data:`, `mailto:`) becomes the words
 * (web address removed). Ordinary text that only looks like an address stays: `//TODO`, `C://Users`, `3://4`, `www.html`.
 * Running it twice changes nothing more.
 */
export function cleanAiText(text: unknown, max = 300): string {
  return plain(text, max, WEB_ADDRESS_REMOVED, "image", "link", true);
}

/**
 * How many characters `text` has when only the hidden characters are out and white space is one plain space: how much the writer
 * wrote, before anything was taken out of it (so the words that stand for an address are not counted as writing).
 */
export function writtenLength(text: unknown): number {
  return visible(asText(text)).replace(/ {2,}/gu, " ").trim().length;
}

/**
 * True when `text` still holds a letter or a number once its pictures, links, addresses and tags are taken out: when it does not,
 * it said nothing, whatever its length (`https://a.example/b`, `<img src=x>`, `![](https://a.example/b.png)`).
 */
export function hasWords(text: unknown): boolean {
  return /[\p{L}\p{N}]/u.test(plain(text, LOOK_MAX, "", "", "", false));
}
