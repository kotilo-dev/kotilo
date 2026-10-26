/**
 * D-066: review notes on a diff's working-copy side, sent to an agent as one prompt. Notes live
 * in memory only (rule 5: they are prompt text); this module is the pure part – the prompt and
 * keeping a note on its lines while the file changes.
 */

export interface ReviewNote {
  id: string;
  workspaceId: string;
  /** Workspace-relative path of the file. */
  rel: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** The noted lines as they were when the note was written (anchor for re-finding them). */
  code: string;
  text: string;
  resolved: boolean;
  /** The noted lines are gone from the file; the note keeps its last place. */
  outdated: boolean;
}

/** Code lines quoted per note in the prompt; longer ranges are cut with a marker. */
export const MAX_QUOTED_LINES = 20;

export function linesOf(content: string): string[] {
  return content.split(/\r?\n/);
}

/** The text of lines `start..end` (1-based, inclusive), clamped to the file. */
export function codeAt(lines: readonly string[], start: number, end: number): string {
  return lines.slice(Math.max(0, start - 1), Math.max(0, end)).join("\n");
}

/**
 * Where the note's lines are in the new content: unchanged place first, then the nearest place
 * with the same lines; otherwise the note stays where it was, marked outdated.
 */
export function reanchor(note: ReviewNote, lines: readonly string[]): ReviewNote {
  const span = note.endLine - note.startLine + 1;
  const want = note.code;
  if (codeAt(lines, note.startLine, note.endLine) === want && note.endLine <= lines.length) {
    return note.outdated ? { ...note, outdated: false } : note;
  }
  let best: number | null = null;
  for (let start = 1; start + span - 1 <= lines.length; start++) {
    if (codeAt(lines, start, start + span - 1) !== want) continue;
    if (best === null || Math.abs(start - note.startLine) < Math.abs(best - note.startLine)) best = start;
  }
  if (best !== null) return { ...note, startLine: best, endLine: best + span - 1, outdated: false };
  const startLine = Math.min(note.startLine, Math.max(1, lines.length));
  const endLine = Math.min(Math.max(note.endLine, startLine), Math.max(1, lines.length));
  return { ...note, startLine, endLine, outdated: true };
}

export function lineLabel(note: Pick<ReviewNote, "startLine" | "endLine">): string {
  return note.startLine === note.endLine ? `${note.startLine}` : `${note.startLine}-${note.endLine}`;
}

/** Fence that the quoted code cannot close early. */
function fenceFor(code: string): string {
  let fence = "```";
  while (code.includes(fence)) fence += "`";
  return fence;
}

function quoted(code: string): string {
  const lines = code.split("\n");
  if (lines.length <= MAX_QUOTED_LINES) return code;
  return [...lines.slice(0, MAX_QUOTED_LINES), `… (${lines.length - MAX_QUOTED_LINES} more lines)`].join("\n");
}

/**
 * One prompt for the agent: every note with its file, lines and the code it is about, in file
 * and line order. The prompt is English whatever the UI language (agents follow it best).
 */
export function buildReviewPrompt(notes: readonly ReviewNote[]): string {
  const sorted = [...notes].sort((a, b) => a.rel.localeCompare(b.rel) || a.startLine - b.startLine);
  const parts = sorted.map((note, i) => {
    const code = quoted(note.code);
    const fence = fenceFor(code);
    const where = `${note.rel}:${lineLabel(note)}${note.outdated ? " (these lines have changed since)" : ""}`;
    return `${i + 1}. ${where}\n${fence}\n${code}\n${fence}\n${note.text.trim()}`;
  });
  return `Please address these review notes on the current changes:\n\n${parts.join("\n\n")}`;
}
