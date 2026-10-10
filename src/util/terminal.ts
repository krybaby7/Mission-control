// Text that reaches a terminal or a report file. Agents write much of it (findings, summaries, report prose, errors),
// and an agent misled by what it read can put terminal control sequences in it.

/**
 * C0 control characters except tab and newline, DEL, and C1 control characters. ESC (and C1's CSI) start terminal
 * escape sequences: OSC 52 writes the clipboard in Windows Terminal, others change the title or move the cursor.
 */
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** `s` without control characters (tab and newline stay), so printing it can't drive the terminal. */
export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}
