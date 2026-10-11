/**
 * Mission control (M4, DESIGN_SYSTEM §7.8). Part of `en` as `mission`; `mission.tr.ts` has the
 * same shape.
 */
import { APP_NAME } from "../constants";

export const missionEn = {
  summary: (total: number, attention: number, working: number, done: number) =>
    `${total} ${total === 1 ? "agent" : "agents"} · ${attention} need you · ${working} working · ${done} done`,
  filterLabel: "Show sessions",
  filters: { all: "All", attention: "Needs you", working: "Working", done: "Done" },
  noSessions: "No agent sessions yet",
  noSessionsBody: "Start an agent in a terminal. Sessions appear here once its integration is installed (Settings).",
  noMatch: "No sessions in this group right now",
  noOutput: "No output yet",
  permission: (tool: string | null) => `Asks permission${tool ? ` for ${tool}` : ""}`,
  tool: (tool: string) => `Running ${tool}`,
  waiting: (duration: string) => `waiting ${duration}`,
  context: (percent: string) => `context ${percent}`,
  subagents: (n: number) => `${n} ${n === 1 ? "subagent" : "subagents"}`,
  tokens: (count: string) => `${count} tok`,
  outsideApp: `Running outside ${APP_NAME}`,
  open: "Open mission control",
};
