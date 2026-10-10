// Line splitting and defensive NDJSON parsing for CLI event streams.

/** Default cap on one line, in characters: far above any real event, far below V8's maximum string length. */
export const DEFAULT_MAX_LINE_LENGTH = 16 * 1024 * 1024;

/** Splits a stream of text chunks into complete lines (no trailing "\n"; "\r\n" endings are stripped). */
export class LineSplitter {
  private pending = "";

  /** Lines longer than `maxLineLength` characters are cut to their first `maxLineLength`, so memory stays bounded. */
  constructor(private readonly maxLineLength = DEFAULT_MAX_LINE_LENGTH) {}

  /** Returns the lines completed by this chunk; an unterminated tail is kept for the next push. */
  push(chunk: string): string[] {
    const parts = chunk.split("\n");
    const lines: string[] = [];
    for (const [i, part] of parts.entries()) {
      if (i > 0) lines.push(this.take());
      this.append(part);
    }
    return lines;
  }

  /** Returns the unterminated last line, if any, and resets the splitter. Call at end of stream. */
  flush(): string[] {
    return this.pending === "" ? [] : [this.take()];
  }

  private append(text: string): void {
    const room = this.maxLineLength - this.pending.length;
    if (room > 0) this.pending += text.length <= room ? text : text.slice(0, room);
  }

  private take(): string {
    const line = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
    this.pending = "";
    return line;
  }
}

/** Where a JSON object can plausibly begin: "{" followed by a key or an immediate "}". */
const OBJECT_START = /\{\s*["}]/g;

/**
 * Extracts every top-level JSON object from one line of output.
 * Handles the normal case (one object per line), objects glued together (`{…}{…}`),
 * junk text around them, and a truncated object followed by a complete one.
 * Returns [] when the line holds no valid JSON object, or is valid JSON but not an object (e.g. an array).
 */
export function parseJsonLine(line: string): unknown[] {
  const text = line.trim();
  if (text === "") return [];
  const whole = tryParse(text);
  if (whole) return isObject(whole.value) ? [whole.value] : [];
  return scanForObjects(text);
}

function scanForObjects(text: string): object[] {
  const found: object[] = [];
  const braces = new BraceMatcher(text);
  // Index of the last character covered by an object that failed to parse.
  let brokenUntil = -1;
  let from = 0;
  for (let start = nextObjectStart(text, from); start >= 0 && !braces.exhausted(); start = nextObjectStart(text, from)) {
    from = start + 1;
    // Inside a broken object, a "{" after ":", "," or "[" is one of its nested values, not an event of its own;
    // a glued event follows arbitrary text instead (e.g. `"text":"half{"type":…`).
    if (start <= brokenUntil && followsValueSeparator(text, start)) continue;
    const end = braces.closerOf(start);
    const value = end < 0 ? undefined : parseObject(text.slice(start, end + 1));
    if (value === undefined) {
      brokenUntil = Math.max(brokenUntil, end < 0 ? text.length : end);
    } else {
      found.push(value);
      from = end + 1;
    }
  }
  return found;
}

function nextObjectStart(text: string, from: number): number {
  OBJECT_START.lastIndex = from;
  return OBJECT_START.exec(text)?.index ?? -1;
}

function followsValueSeparator(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text.charAt(i))) i--;
  return i >= 0 && ":,[".includes(text.charAt(i));
}

/** Scanning work allowed per character of a line before the search for objects gives up. */
const MAX_SCAN_STEPS_PER_CHAR = 32;

/**
 * Finds the "}" that balances a "{", ignoring braces inside strings. One scan also settles every "{" it meets
 * outside a string (a scan starting there would agree with it from that point on); caching those answers keeps
 * the search linear on real broken lines. A step budget bounds contrived ones, so no line can stall the event loop.
 */
class BraceMatcher {
  private readonly closers = new Map<number, number>();
  private stepsLeft: number;

  constructor(private readonly text: string) {
    this.stepsLeft = MAX_SCAN_STEPS_PER_CHAR * text.length;
  }

  exhausted(): boolean {
    return this.stepsLeft <= 0;
  }

  /** Index of the "}" that balances the "{" at `start`; -1 if unbalanced. */
  closerOf(start: number): number {
    const cached = this.closers.get(start);
    if (cached !== undefined) return cached;
    const { text } = this;
    const open: number[] = [];
    let inString = false;
    let i = start;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        open.push(i);
      } else if (ch === "}") {
        const opener = open.pop();
        if (opener !== undefined) this.closers.set(opener, i);
        if (open.length === 0) break;
      }
    }
    this.stepsLeft -= i - start;
    for (const opener of open) this.closers.set(opener, -1);
    return this.closers.get(start) ?? -1;
  }
}

function tryParse(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string): object | undefined {
  const parsed = tryParse(text);
  return parsed && isObject(parsed.value) ? parsed.value : undefined;
}
