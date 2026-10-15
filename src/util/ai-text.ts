// Text that a second AI wrote about files it did not write (its evidence and its notes). It can quote a hostile file, so before it
// reaches a report, a pull request text, a card or a terminal it is made plain: nothing hidden, nothing that draws a picture or a
// link, and no web address. The second AI's words stay readable; only the parts that could do something are changed.

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

/** What stands where a web address was. */
export const WEB_ADDRESS_REMOVED = "(web address removed)";

/** How many characters of the text are looked at: the rest is far more than any message keeps. */
const LOOK_MAX = 8_000;

/** `[text](where)` and `![text](where)`: the destination runs to the first closing bracket. */
const MARKDOWN_LINK = /(!?)\[([^[\]]*)\]\(([^)]*)\)/gu;
/** What ends an address in running text: white space, and the marks that close an attribute or a bracket of a tag or an automatic link. */
const ADDRESS_END = /[\s"<>`]/u;
/** An address that starts with two slashes and a host: `//host/path`. Not `a//b`, not a comment like `// note`. */
const SLASH_ADDRESS = /(^|[^\w:/.~-])\/{2,}[^\s/"<>`][^\s"<>`]*/gu;
/** An address that starts with `www.`. */
const WWW_ADDRESS = /(^|[^\w.-])www\.[^\s"<>`]+/giu;
/** Marks that end a sentence or close a bracket or a quote: they stay in the text after the address is taken out of it. */
const SENTENCE_MARKS = new Set(Array.from('.,;:!?)]}"\'”’»>'));

/** The words that stand for an address, followed by the marks that most likely belonged to the sentence around it. */
function removeAddress(token: string): string {
  let end = token.length;
  while (end > 0 && SENTENCE_MARKS.has(token.charAt(end - 1))) end--;
  return WEB_ADDRESS_REMOVED + token.slice(end);
}

/** Every web address that has a scheme (`http://`, `https://`, `ftp://`, ...), from the first letter of the scheme to where it ends (ADDRESS_END). */
function plainSchemeAddresses(text: string): string {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("://", from);
    if (at < 0) break;
    let start = at;
    while (start > from && /[a-z0-9+.-]/iu.test(text.charAt(start - 1))) start--;
    let end = at + 3;
    while (end < text.length && !ADDRESS_END.test(text.charAt(end))) end++;
    parts.push(text.slice(from, start), removeAddress(text.slice(start, end)));
    from = end;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

function plainAddresses(text: string): string {
  return plainSchemeAddresses(text)
    .replace(SLASH_ADDRESS, (all, before: string) => before + removeAddress(all.slice(before.length)))
    .replace(WWW_ADDRESS, (all, before: string) => before + removeAddress(all.slice(before.length)));
}

/** True when `where` (what a markdown link points to) starts as a web address. */
function isAddress(where: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|\/{2,}[^\s/]|www\.\S)/iu.test(where);
}

/**
 * A link or a picture of markdown as plain words: the words of the link, then where it points, with a web address taken out.
 * What is left of the syntax afterwards (a picture mark whose brackets do not close, a bracket pair that touches a bracket)
 * cannot make a link or a picture either.
 */
function plainLinks(text: string): string {
  const out = text.replace(MARKDOWN_LINK, (_all, bang: string, label: string, target: string) => {
    const words = label.trim() === "" ? (bang === "!" ? "image" : "link") : label.trim();
    const where = target.trim();
    if (where === "") return words;
    return isAddress(where) ? `${words} ${WEB_ADDRESS_REMOVED}` : `${words} (${where})`;
  });
  return out.replace(/!\[/gu, "[").replace(/\]\(/gu, "] (");
}

/**
 * `text` as one plain line of at most `max` characters (a closing `…` when it was cut):
 * hidden, zero-width and direction-changing characters are taken out (the class the plan reader bans), line breaks and odd
 * spaces become one space, a markdown picture or link becomes its words with the place it points to in brackets, and every web
 * address (`http://`, `https://`, `//host`, `www.`) becomes the words (web address removed). Running it twice changes nothing more.
 */
export function cleanAiText(text: unknown, max = 300): string {
  const input = typeof text === "string" ? text : text === undefined || text === null ? "" : String(text);
  let seen = "";
  let looked = 0;
  for (const ch of input) {
    if (++looked > LOOK_MAX) break;
    if (SPACE_LIKE.test(ch)) seen += " ";
    else if (!isHiddenChar(ch)) seen += ch;
  }
  // Hidden characters are gone before the addresses are looked for, so a zero-width character cannot split `https://`.
  const plain = plainAddresses(plainLinks(seen)).replace(/ {2,}/gu, " ").trim();
  const points = Array.from(plain);
  if (points.length <= max) return plain;
  return points.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}
