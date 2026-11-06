/**
 * The permission an agent pane is waiting on, if any: the hub's request (tool, command, risk),
 * else a prompt the desktop found on the screen (Cursor), which has no details. Questions
 * (Claude Code's AskUserQuestion/ExitPlanMode, or the desktop's own question flag) never count:
 * allow/deny keys would pick or cancel one of their answers. Shared by the permission card and
 * the Kotilo Deck companion (D-072), so both use the same request key.
 */
import type { PendingPermission, SessionDto } from "../../lib/hubTypes";
import type { AdapterDefinition, Agent } from "../../lib/ipc";
import { hasScreenPermissionRule, isQuestionTool } from "./permissionKeys";

export interface PendingRequest {
  permission: PendingPermission;
  /** Stable for one prompt: `<agent>:<sessionId>:<since>` (hub) or `<adapter>:<paneId>:<sinceMs>` (screen). */
  requestKey: string;
}

export function pendingPermissionOf(
  session: SessionDto | null,
  agent: Agent | undefined,
  definition: AdapterDefinition | undefined,
): PendingRequest | null {
  const hubPermission =
    session?.state === "WaitingPermission" && !isQuestionTool(session.pendingPermission?.tool) ? session.pendingPermission : null;
  if (hubPermission && session) {
    return { permission: hubPermission, requestKey: `${session.agent}:${session.sessionId}:${hubPermission.since}` };
  }
  const screenBlocked =
    hasScreenPermissionRule(definition) && agent?.state === "blocked" && !agent.questionPending && session?.state !== "WaitingInput";
  if (screenBlocked && agent) {
    const adapterId = session?.agent ?? agent.adapterId ?? null;
    return {
      permission: { tool: null, command: null, path: null, risk: null, since: new Date(agent.sinceMs).toISOString() },
      requestKey: `${adapterId}:${agent.paneId}:${agent.sinceMs}`,
    };
  }
  return null;
}
