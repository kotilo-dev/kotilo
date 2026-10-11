/** Pure helpers for the Overview screen (unit-tested). */
import type { ProjectDto, SessionDto, SessionState } from "../../lib/hubTypes";

const ATTENTION: readonly SessionState[] = ["WaitingPermission", "WaitingInput", "Error"];

export function needsAttention(state: SessionState): boolean {
  return ATTENTION.includes(state);
}

/** Attention first (hub order kept), then the other live sessions; ended ones are left out. */
export function splitSessions(sessions: readonly SessionDto[]): { attention: SessionDto[]; others: SessionDto[] } {
  const attention = sessions.filter((s) => needsAttention(s.state));
  const others = sessions.filter((s) => !needsAttention(s.state) && s.state !== "Ended" && s.state !== "Unknown");
  return { attention, others };
}

export function countWorking(sessions: readonly SessionDto[]): number {
  return sessions.filter((s) => s.state === "Working").length;
}

/** The most recently active projects that have todo items. */
export function recentProjects(projects: readonly ProjectDto[], limit = 5): ProjectDto[] {
  return projects
    .filter((p) => !p.hidden && p.total > 0)
    .slice()
    .sort((a, b) => Date.parse(b.lastActivity ?? "") - Date.parse(a.lastActivity ?? "") || b.percent - a.percent)
    .slice(0, limit);
}

/** Fraction (0..1) of the block's elapsed time, for the projection bar. */
export function blockProgress(start: string, end: string, now: number): number {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return 0;
  return Math.max(0, Math.min(1, (now - s) / (e - s)));
}
