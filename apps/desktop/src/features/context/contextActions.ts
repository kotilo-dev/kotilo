/**
 * 0.9 agent context entry points: the workspace context menu ("Agent context…"), the palette
 * ("Agents: Show agent context") and the agent pane header / terminal tab menu (with that pane's agent)
 * all open the workspace's "Agent context" tab and reload the report.
 */
import { registerCommand } from "../../app/commands";
import { strings } from "../../app/strings";
import { useAgentStore } from "../../stores/agentStore";
import { useContextStore } from "../../stores/contextStore";
import { useHubStore } from "../../stores/hubStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useRouteStore } from "../../stores/routeStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useViewerStore } from "../../stores/viewerStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { matchSession } from "../workspace/paneSession";
import { adapterForKind, defaultContextAgent } from "./contextLogic";

/** The adapter id of the agent running in a pane (hub session first, then the desktop tracker). */
export function paneAgentId(paneId: string): string | null {
  const known = useAgentStore.getState().agents.find((a) => a.paneId === paneId);
  const session = matchSession(useHubStore.getState().sessions, paneId, known);
  if (!known && !session) return null;
  return session?.agent ?? known?.adapterId ?? (known ? adapterForKind(known.kind) : null);
}

/** Adapter ids of the agents running in the workspace's terminals, the active tab's first. */
export function runningAgentIds(workspaceId: string): string[] {
  const ws = useTerminalStore.getState().byWorkspace[workspaceId];
  const tabs = ws?.tabs ?? [];
  const ordered = [...tabs.filter((t) => t.id === ws?.activeTabId), ...tabs.filter((t) => t.id !== ws?.activeTabId)];
  const ids = ordered.flatMap((t) => (t.status === "running" && t.paneId ? [paneAgentId(t.paneId)] : []));
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/** The agent a newly opened tab shows: one running in the workspace, else Claude Code. */
export function defaultAgentFor(workspaceId: string): string {
  return defaultContextAgent(runningAgentIds(workspaceId), useContextStore.getState().agents);
}

/**
 * Shows the workspace (default: the active one) with its "Agent context" tab and reloads it.
 * Without `agent` an existing tab keeps its agent; a new one takes `defaultAgentFor`.
 */
export function openAgentContext(workspaceId?: string | null, agent?: string | null): void {
  const id = workspaceId ?? useWorkspaceStore.getState().activeId;
  if (!id) return;
  useRouteStore.getState().navigate("workspace");
  if (useWorkspaceStore.getState().activeId !== id) void useWorkspaceStore.getState().setActive(id);
  const existing = useViewerStore.getState().byWorkspace[id]?.tabs.find((t) => t.context);
  const target = agent ?? existing?.contextAgent ?? defaultAgentFor(id);
  useViewerStore.getState().openContext(id, target);
  useLayoutStore.getState().setVisible("viewer", true);
  void useContextStore.getState().loadAgents();
  void useContextStore.getState().refresh(id, target);
}

/** "Agent: Show context" in the palette; returns the uninstaller. */
export function installContextCommands(): () => void {
  return registerCommand({
    id: "context.show",
    title: () => strings.agentContext.commandTitle,
    category: () => strings.commandCategories.agents,
    enabled: () => useWorkspaceStore.getState().activeId !== null,
    run: () => openAgentContext(),
  });
}
