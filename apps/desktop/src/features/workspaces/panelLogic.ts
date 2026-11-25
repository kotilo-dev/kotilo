import type { Agent, Workspace } from "../../lib/ipc";
import { urgentStateForWorkspace } from "../agents/agentLogic";

/**
 * Workspaces (other than the active one) with an agent that needs permission: the number on the
 * Workspaces tab's red badge. The active workspace is excluded because its agents are already in
 * front of the user.
 */
export function blockedElsewhereCount(agents: Agent[], workspaces: Workspace[], activeId: string | null): number {
  let count = 0;
  for (const ws of workspaces) {
    if (ws.id !== activeId && urgentStateForWorkspace(agents, ws.id) === "blocked") count++;
  }
  return count;
}
