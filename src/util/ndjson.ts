// Line splitting and defensive NDJSON parsing for CLI event streams.

/** Splits a stream of text chunks into complete lines (no trailing "\n"; "\r\n" endings are stripped). */
export class LineSplitter {
  private pending = "";

  /** Returns the lines completed by this chunk; an unterminated tail is kept for the next push. */
  push(chunk: string): string[] {
    if (!chunk.includes("\n")) {
      this.pending += chunk;
      return [];
    }
    const parts = (this.pending + chunk).split("\n");
    this.pending = parts.pop() ?? "";
    return parts.map(stripCarriageReturn);
  }

  /** Returns the unterminated last line, if any, and resets the splitter. Call at end of stream. */
  flush(): string[] {
    const rest = this.pending;
    this.pending = "";
    return rest === "" ? [] : [stripCarriageReturn(rest)];
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Where a JSON object can plausibly begin: "{" followed by a key or an immediate "}". */
const OBJECT_START = /\{\s*["}]/g;

/**
 * Extracts every top-level JSON object from one line of output.
 * Handles the normal case (one object per line), objects glued together (`{…}{…}`),
 * junk text around them, and a truncated object followed by a complete one.
 * Returns [] when the line holds no valid JSON object.
 */
export function parseJsonLine(line: string): unknown[] {
  const text = line.trim();
  if (text === "") return [];
  const whole = parseObject(text);
  return whole === undefined ? scanForObjects(text) : [whole];
}

function scanForObjects(text: string): object[] {
  const found: object[] = [];
  let from = 0;
  for (let start = nextObjectStart(text, from); start >= 0; start = nextObjectStart(text, from)) {
    const end = matchingBrace(text, start);
    const value = end < 0 ? undefined : parseObject(text.slice(start, end + 1));
    if (value === undefined) {
      // Not a valid object here (e.g. truncated); an object may still start inside it.
      from = start + 1;
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

/** Index of the "}" that balances the "{" at `start`, ignoring braces inside strings; -1 if unbalanced. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

function parseObject(text: string): object | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
