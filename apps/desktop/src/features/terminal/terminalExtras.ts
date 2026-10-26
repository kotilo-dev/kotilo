/**
 * 0.4.0 C (D-068): pure helpers for the terminal extras – OSC 52 clipboard writes, resetting
 * modes a crashed program left on, and the text of "Copy recent output".
 */

/** Largest clipboard text an OSC 52 write may set (decoded). */
export const OSC52_MAX_BYTES = 1024 * 1024;

/**
 * The text of an OSC 52 clipboard write (`Pc;Pd`, `Pd` base64), or null for anything that is not
 * a write we follow: queries (`?`), clearing (empty `Pd`), bad base64, too large.
 */
export function parseOsc52(data: string): string | null {
  const sep = data.indexOf(";");
  if (sep < 0) return null;
  const payload = data.slice(sep + 1).trim();
  if (payload === "" || payload === "?") return null;
  // Base64 grows 4:3; reject before decoding.
  if ((payload.length * 3) / 4 > OSC52_MAX_BYTES + 3) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (bytes.length > OSC52_MAX_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Written to xterm itself (not to the shell) by "Reset terminal": mouse reporting, focus
 * events, application cursor/keypad keys and the alternate screen off, cursor shown, colours
 * reset. Bracketed paste is left alone (shells turn it on once and rely on it), and so is
 * everything ConPTY negotiates.
 */
export const RESET_MODES_SEQUENCE = [
  "\x1b[?9l",
  "\x1b[?1000l",
  "\x1b[?1001l",
  "\x1b[?1002l",
  "\x1b[?1003l",
  "\x1b[?1005l",
  "\x1b[?1006l",
  "\x1b[?1015l",
  "\x1b[?1016l",
  "\x1b[?1004l",
  "\x1b[?1l",
  "\x1b>",
  "\x1b[?1049l",
  "\x1b[?25h",
  "\x1b[0m",
].join("");

/** Rows "Copy recent output" takes from the end of the buffer. */
export const RECENT_OUTPUT_ROWS = 1000;

/** The rows as copied text: trailing blank rows dropped, leading blank rows dropped. */
export function recentOutputText(rows: readonly string[]): string {
  let start = 0;
  let end = rows.length;
  while (start < end && rows[start]!.trim() === "") start++;
  while (end > start && rows[end - 1]!.trim() === "") end--;
  return rows.slice(start, end).join("\n");
}
