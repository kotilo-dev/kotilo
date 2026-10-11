/** Pure helpers for Mission control (M4, DESIGN_SYSTEM §7.8; unit-tested). */
import type { SessionDto, SessionState } from "../../lib/hubTypes";

export type MissionFilter = "all" | "attention" | "working" | "done";
export type MissionGroup = Exclude<MissionFilter, "all">;

/** Rows read from the end of an xterm buffer per preview tick; enough to skip blank rows below the cursor. */
export const PREVIEW_SCAN_ROWS = 120;
/** Lines shown in a tile preview (§7.8: 5 lines). */
export const PREVIEW_LINES = 5;

/** Filter group of a session state; `null` for states that only show under "All" (Stale). */
export function groupOf(state: SessionState): MissionGroup | null {
  switch (state) {
    case "WaitingPermission":
    case "WaitingInput":
    case "Error":
      return "attention";
    case "Working":
      return "working";
    case "Idle":
      return "done";
    default:
      return null;
  }
}

const ORDER: Record<MissionGroup | "other", number> = { attention: 0, working: 1, done: 2, other: 3 };

/** Live sessions (ended / unknown left out): needs-you first, then working, done, the rest; hub order kept inside a group. */
export function liveSessions(sessions: readonly SessionDto[]): SessionDto[] {
  return sessions
    .filter((s) => s.state !== "Ended" && s.state !== "Unknown")
    .map((s, i) => ({ s, i, rank: ORDER[groupOf(s.state) ?? "other"] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.s);
}

export function filterSessions(sessions: readonly SessionDto[], filter: MissionFilter): SessionDto[] {
  return filter === "all" ? sessions.slice() : sessions.filter((s) => groupOf(s.state) === filter);
}

export function countGroups(sessions: readonly SessionDto[]): Record<MissionFilter, number> {
  const counts: Record<MissionFilter, number> = { all: sessions.length, attention: 0, working: 0, done: 0 };
  for (const s of sessions) {
    const g = groupOf(s.state);
    if (g) counts[g] += 1;
  }
  return counts;
}

/** The last `count` non-blank lines (right-trimmed), oldest first. */
export function lastNonBlankLines(rows: readonly string[], count = PREVIEW_LINES): string[] {
  const out: string[] = [];
  for (let i = rows.length - 1; i >= 0 && out.length < count; i--) {
    const line = rows[i]!.replace(/\s+$/, "");
    if (line.trim() !== "") out.push(line);
  }
  return out.reverse();
}

export function sameLines(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((line, i) => line === b[i]);
}

export type FallbackLine =
  | { kind: "permission"; tool: string | null; target: string | null }
  | { kind: "notification"; text: string }
  | { kind: "tool"; tool: string };

const MAX_TARGET = 200;

/**
 * Preview for a session without a pane in this app (or an empty buffer): the pending permission,
 * the agent's own last notification and the current tool. Never conversation content.
 */
export function fallbackLines(session: SessionDto): FallbackLine[] {
  const lines: FallbackLine[] = [];
  const p = session.pendingPermission;
  if (p) {
    const target = p.command ?? p.path;
    lines.push({ kind: "permission", tool: p.tool, target: target ? target.slice(0, MAX_TARGET) : null });
  }
  if (session.lastNotification) lines.push({ kind: "notification", text: session.lastNotification });
  if (session.currentTool && !p) lines.push({ kind: "tool", tool: session.currentTool });
  return lines;
}

export function sessionKey(session: SessionDto): string {
  return `${session.agent}:${session.sessionId}`;
}
