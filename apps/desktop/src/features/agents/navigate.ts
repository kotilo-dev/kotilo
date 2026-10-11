/**
 * Bir agent kaydına "gitme" (faz5-spec §2.2 satır tıklaması, §2.4 `Ctrl+Shift+A`): aktif
 * workspace'i değiştirir, terminal kolonunu görünür yapar, pane hâlâ bir sekmeye karşılık
 * geliyorsa o sekmeyi aktif eder ve xterm'e odaklanır. Pane bir sekmeden yeniden başlatılmış
 * (yeni paneId) olabilir — bu durumda sekme bulunamaz, yalnızca workspace + panel görünürlüğü
 * uygulanır (zarif bozulma, faz5-spec §2.2 notu).
 */
import { agentAck, type Agent } from "../../lib/ipc";
import { useLayoutStore } from "../../stores/layoutStore";
import { useRouteStore } from "../../stores/routeStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { focusTerminal } from "../terminal/terminalRegistry";

export function navigateToAgent(agent: Agent, opts?: { ack?: boolean }): void {
  useRouteStore.getState().navigate("workspace");
  void useWorkspaceStore.getState().setActive(agent.workspaceId);
  useLayoutStore.getState().setVisible("terminal", true);

  const found = useTerminalStore.getState().findTabByPaneId(agent.paneId);
  if (found) {
    useTerminalStore.getState().activate(found.workspaceId, found.tab.id);
    requestAnimationFrame(() => focusTerminal(found.tab.id));
  }

  if (opts?.ack) void agentAck(agent.paneId).catch(() => {});
}
