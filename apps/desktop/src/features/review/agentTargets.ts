/**
 * D-066: the agents a prompt can be handed to – running in the workspace's terminals (the pane's
 * own record or a live hub session, as on the pane header), named like the header. Used by
 * "Send N notes to…" and the docs check's "Update with agent…".
 */
import { useMemo } from "react";
import { useStrings } from "../../app/i18n";
import { agentDisplayName } from "../../app/ui";
import type { Agent } from "../../lib/ipc";
import { useAgentStore } from "../../stores/agentStore";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { useHubStore } from "../../stores/hubStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { matchSession } from "../workspace/paneSession";

export interface AgentTarget {
  agent: Agent;
  label: string;
}

/**
 * Agents running in the workspace's terminals (the pane's own record or a live hub session, as
 * on the pane header), named like the header.
 */
export function useAgentTargets(workspaceId: string): AgentTarget[] {
  const strings = useStrings();
  const agents = useAgentStore((s) => s.agents);
  const sessions = useHubStore((s) => s.sessions);
  const definitions = useDefinitionsStore((s) => s.definitions);
  const byWorkspace = useTerminalStore((s) => s.byWorkspace);
  return useMemo(() => {
    const tabs = byWorkspace[workspaceId]?.tabs ?? [];
    return tabs.flatMap((tab) => {
      if (tab.status !== "running" || !tab.paneId) return [];
      const paneId = tab.paneId;
      const known = agents.find((a) => a.paneId === paneId);
      const session = matchSession(sessions, paneId, known);
      if (!known && !session) return [];
      const adapterId = session?.agent ?? known?.adapterId ?? null;
      const name = adapterId ? agentDisplayName(adapterId, definitions) : strings.agents.kindLabel[known?.kind ?? "other"];
      const agent: Agent = known ?? { id: paneId, paneId, workspaceId, kind: "other", state: "idle", sinceMs: 0, source: "hook", sessionId: session?.sessionId ?? null };
      // A renamed tab says which one; otherwise only agents of the same kind need a number.
      return [{ agent, name, label: tab.titleEdited ? `${name} · ${tab.title}` : name }];
    }).map((t, _, list) => {
      const same = list.filter((o) => o.label === t.label);
      return { agent: t.agent, label: same.length > 1 ? `${t.label} (${same.indexOf(t) + 1})` : t.label };
    });
  }, [agents, sessions, definitions, byWorkspace, workspaceId, strings]);
}
