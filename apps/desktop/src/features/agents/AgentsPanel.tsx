/**
 * Agents panel (faz5-spec §2.2, §2.3). The list is derived from `agentStore.agents` with
 * `sortAgents` (the pure ordering is tested in `agentLogic.ts`) – this component only renders
 * and wires clicks. One 1 s timer for the elapsed time (`useNow`, paused when not seen).
 */
import { useEffect, useRef, useState } from "react";
import { HeaderButton } from "../../app/HeaderButton";
import { PanelHeader } from "../../app/PanelHeader";
import { agentLabel } from "../../app/ui/agents";
import { useStrings } from "../../app/strings";
import { useNow } from "../../app/ui/useNow";
import { useRouteStore } from "../../stores/routeStore";
import { useAgentStore } from "../../stores/agentStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore, findTabByPaneIdInMap } from "../../stores/terminalStore";
import type { Agent } from "../../lib/ipc";
import { formatElapsed, sortAgents } from "./agentLogic";
import { navigateToAgent } from "./navigate";
import { ContextMenu, type ContextMenuItem } from "../workspaces/ContextMenu";
import { PaneStatusDot } from "../workspace/PaneStatus";
import { visualStateForAgent } from "../workspace/paneSession";

function AgentsMenuButton() {
  const strings = useStrings();
  const hooks = useAgentStore((s) => s.hooks);
  const installHooks = useAgentStore((s) => s.installHooks);
  const updateHooks = useAgentStore((s) => s.updateHooks);
  const uninstallHooks = useAgentStore((s) => s.uninstallHooks);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLDivElement>(null);
  const rect = btnRef.current?.getBoundingClientRect();

  const items: ContextMenuItem[] = [
    { label: strings.agents.menu.install, onClick: () => void installHooks(), disabled: hooks?.installed ?? false },
    { label: strings.agents.menu.update, onClick: () => void updateHooks(), disabled: !hooks?.installed },
    { label: strings.agents.menu.uninstall, onClick: () => void uninstallHooks(), disabled: !hooks?.installed },
  ];

  return (
    <div ref={btnRef} className="flex items-center">
      <HeaderButton title={strings.agents.menu.title} onClick={() => setOpen((o) => !o)}>
        …
      </HeaderButton>
      {open && rect && (
        <ContextMenu state={{ x: rect.right - 200, y: rect.bottom, items }} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function InstallBanner() {
  const strings = useStrings();
  const hooks = useAgentStore((s) => s.hooks);
  const installHooks = useAgentStore((s) => s.installHooks);
  const updateHooks = useAgentStore((s) => s.updateHooks);

  if (!hooks || (hooks.hubAvailable && hooks.installed && hooks.upToDate)) return null;

  if (!hooks.hubAvailable) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-2 py-1.5 text-label text-muted">
        <span className="truncate">{strings.agents.banner.hubUnavailable}</span>
      </div>
    );
  }

  const notice = hooks.installed ? strings.agents.banner.outOfDate : strings.agents.banner.notInstalled;
  const actionLabel = hooks.installed ? strings.agents.banner.update : strings.agents.banner.install;
  const onAction = hooks.installed ? updateHooks : installHooks;

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-2 py-1.5 text-label text-muted">
      <span className="truncate">{notice}</span>
      <button
        type="button"
        className="shrink-0 rounded bg-accent px-2 py-0.5 text-on-accent"
        onClick={() => void onAction()}
      >
        {actionLabel}
      </button>
    </div>
  );
}

function AgentRow({ agent, now }: { agent: Agent; now: number }) {
  const strings = useStrings();
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === agent.workspaceId)?.name ?? "");
  const byWorkspace = useTerminalStore((s) => s.byWorkspace);
  const tabTitle = findTabByPaneIdInMap(byWorkspace, agent.paneId)?.tab.title ?? strings.agents.noTab;
  const background =
    agent.state === "working" && agent.backgroundTasks && agent.backgroundTasks.length > 0
      ? strings.workspace.background(agent.backgroundTasks.join(", "))
      : undefined;

  return (
    <div
        role="button"
        tabIndex={0}
        className="flex h-6 shrink-0 items-center gap-1.5 px-2 text-label cursor-pointer"
        onClick={() => navigateToAgent(agent, { ack: true })}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigateToAgent(agent, { ack: true });
          }
        }}
      >
        <PaneStatusDot
          state={visualStateForAgent(agent.state)}
          label={background ? `${strings.status.working} · ${background}` : undefined}
          background={!!background}
        />
        <span className="shrink-0 text-muted">
          {agentLabel(agent)}
        </span>
        <span className="min-w-0 flex-1 truncate">{workspaceName}</span>
        <span className="min-w-0 max-w-[8rem] truncate text-muted">
          {tabTitle}
        </span>
        <span className="shrink-0 tabular-nums text-muted">
          {formatElapsed(now, agent.sinceMs)}
        </span>
    </div>
  );
}

export function AgentsPanel() {
  const strings = useStrings();
  const init = useAgentStore((s) => s.init);
  const ready = useAgentStore((s) => s.ready);
  const agents = useAgentStore((s) => s.agents);
  // One 1 s "now" for the elapsed labels; paused while the workspace route is not shown or the
  // window is unfocused/hidden.
  const onWorkspace = useRouteStore((s) => s.route === "workspace");
  const now = useNow(1000, onWorkspace);

  useEffect(() => {
    void init();
  }, [init]);

  const sorted = sortAgents(agents);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={strings.panels.agents} actions={ready ? <AgentsMenuButton /> : null} />

      <div className="min-h-0 flex-1 overflow-auto">
        {sorted.length === 0 ? (
          <div className="p-3 text-xs text-muted">
            {strings.empty.agents}
          </div>
        ) : (
          sorted.map((agent) => <AgentRow key={agent.id} agent={agent} now={now} />)
        )}
      </div>

      {ready && <InstallBanner />}
    </div>
  );
}
