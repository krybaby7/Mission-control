// Cleaning every string that came from a file (docs/dashboard-spec.md, 3.3). Agents write feature titles, reasons and
// questions, so a string may hold control, bidi or zero-width characters, or be enormous. The page inserts every string
// with textContent; this is the second line, not a substitute.
import { ID_MAX_CHARS } from "./constants.js";

/** C0 controls except tab and newline, DEL, C1 controls, bidi controls and zero-width characters. */
const REMOVED = /[\u{0}-\u{8}\u{b}-\u{1f}\u{7f}-\u{9f}\u{61c}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}\u{2066}-\u{2069}\u{feff}]/gu;
const LINE_SEPARATORS = /[\u{2028}\u{2029}]/gu;
/** A half of a surrogate pair with no other half: it cannot be written as UTF-8, so it becomes the replacement character. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Cuts to at most `max` code points, ending with an ellipsis when something was cut. Not named "truncate": see the read-only scan. */
export function shorten(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return points.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}

/** `text` as one clean line of at most `max` code points: no control, bidi or zero-width characters, whitespace collapsed. */
export function clean(text: unknown, max: number): string {
  const plain = String(text).replace(LONE_SURROGATE, "\ufffd").replace(LINE_SEPARATORS, " ").replace(REMOVED, "").replace(/\s+/g, " ").trim();
  return shorten(plain, max);
}

/** A mission or feature id, cleaned and capped. */
export function cleanId(text: unknown): string {
  return clean(text, ID_MAX_CHARS);
}
