/**
 * M2: which hub session belongs to a terminal pane, and how the pane should look. Pure;
 * the hub session (rich: model, tokens, permission details) is preferred, the desktop
 * tracker's pane record (fast, includes hookless agents) fills gaps. "Done" = finished and not
 * seen yet, by either source (D-056: the hub stores seen state too).
 */
import type { Agent } from "../../lib/ipc";
import type { SessionDto } from "../../lib/hubTypes";

/**
 * The live hub session for `paneId`: by the hook's pane id first (newest event wins), else
 * by the desktop record's `(adapterId, sessionId)` — Codex hooks run without our pane env (D-013).
 */
export function matchSession(sessions: readonly SessionDto[], paneId: string, agent: Agent | undefined): SessionDto | null {
  const live = sessions.filter((s) => s.state !== "Ended");
  const byPane = live
    .filter((s) => s.paneId === paneId)
    .sort((a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt))[0];
  if (byPane) return byPane;
  if (!agent?.sessionId) return null;
  const adapter = agent.adapterId ?? null;
  return live.find((s) => s.sessionId === agent.sessionId && (adapter === null || s.agent === adapter)) ?? null;
}

/** What the pane frame, header pill and status dots show (DESIGN_SYSTEM §7.3/§7.4, §10). */
export type PaneVisualState = "working" | "permission" | "input" | "done" | "idle" | "error";

/**
 * `screenPermission`: the agent's definition detects permission prompts on its terminal
 * screen (Cursor: no hook reports them), so the desktop's `blocked` wins over the hub.
 */
export function paneVisualState(session: SessionDto | null, agent: Agent | undefined, screenPermission = false): PaneVisualState | null {
  if (screenPermission && agent?.state === "blocked" && session?.state !== "WaitingInput") return "permission";
  if (session) {
    switch (session.state) {
      case "WaitingPermission":
        return "permission";
      case "WaitingInput":
        return "input";
      case "Error":
        return "error";
      case "Working":
        return "working";
      case "Idle":
      case "Stale":
        return session.unseen || agent?.state === "done" ? "done" : "idle";
      case "Unknown":
      case "Ended":
        break;
    }
  }
  if (!agent) return null;
  return visualStateForAgent(agent.state);
}

/** The desktop tracker's own states (hookless agents, or no hub). */
export function visualStateForAgent(state: Agent["state"]): PaneVisualState {
  switch (state) {
    case "blocked":
      return "permission";
    case "working":
      return "working";
    case "done":
      return "done";
    case "idle":
      return "idle";
  }
}

/** Token family for a visual state (`--status-<family>*`, Tailwind `*-<family>`). */
export function statusFamily(state: PaneVisualState): "working" | "blocked" | "done" | "idle" | "error" {
  switch (state) {
    case "permission":
    case "input":
      return "blocked";
    default:
      return state;
  }
}
