/** Test helper: a complete hub `SessionDto` with overrides. */
import type { SessionDto } from "../../lib/hubTypes";

export function makeSession(partial: Partial<SessionDto>): SessionDto {
  return {
    sessionId: "s1",
    agent: "claude-code",
    paneId: null,
    projectRoot: "C:/src/app",
    projectName: "app",
    state: "Idle",
    stateSince: "2026-10-04T10:00:00Z",
    lastEventAt: "2026-10-04T10:00:00Z",
    currentTool: null,
    model: null,
    tokens: 0,
    costUsd: null,
    contextUsedPercent: null,
    turnStartedAt: null,
    endedAt: null,
    activeSubagents: 0,
    lastNotification: null,
    error: null,
    tasks: null,
    pendingPermission: null,
    ...partial,
  };
}
