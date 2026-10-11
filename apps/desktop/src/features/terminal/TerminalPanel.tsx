/**
 * Terminal panel (faz4-spec §2.3, §2.5, §2.7, §4). Tab strip + the hosts of every tab of every
 * workspace (hidden ones `display:none`) – the xterm instances live in `terminalRegistry`, so
 * they survive workspace switches and panel collapse (see `TerminalView.tsx`). M4 split pane
 * (§7.3): the active tab on the left and `splitTabId` on the right, each with its own pane
 * chrome; split via the tab menu, the header split button or dragging a tab to the right half.
 */
import { useEffect, useRef, useState } from "react";
import { HeaderButton } from "../../app/HeaderButton";
import { PanelHeader } from "../../app/PanelHeader";
import { ConfirmModal } from "../../app/ConfirmModal";
import { useStrings } from "../../app/strings";
import { ptyBusy, type ShellProfile } from "../../lib/ipc";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore, type TerminalTab } from "../../stores/terminalStore";
import { useAgentStore } from "../../stores/agentStore";
import { useLaunchOptions } from "../agents/launch";
import type { LaunchOption } from "../agents/launchOptions";
import { stateForPane } from "../agents/agentLogic";
import { AgentBadge } from "../agents/AgentBadge";
import { ContextMenu, type ContextMenuItem } from "../workspaces/ContextMenu";
import { InlineInput } from "../workspaces/InlineInput";
import { spawnTerminal } from "./defaultShell";
import { splitBeside, splitTabToRight } from "./splitLayout";
import { focusTerminal } from "./terminalRegistry";
import { AgentPane } from "../workspace/AgentPane";

// faz4-spec §4.21 / LOW #8c: `windowsPty.buildNumber` is now read in `terminalStore.init()`,
// BEFORE restored tabs become a `Terminal` in `terminalRegistry` – fetching it here as well
// caused a race (a fetch still pending while `ready` turned true) and restored terminals were
// created without a build number.

interface PendingBusyClose {
  workspaceId: string;
  tabId: string;
  processes: string[];
}

/** `dataTransfer` type of a dragged terminal tab (M4: drop on the right half to split). */
const TAB_DRAG_TYPE = "application/x-agenthub-tab";

function TabButton({
  tab,
  active,
  onActivate,
  onRequestClose,
  onRename,
  onMenu,
  onDragStart,
  onDragEnd,
}: {
  tab: TerminalTab;
  /** Shown in one of the panel's halves (the active tab, or the right half of a split). */
  active: boolean;
  onActivate: () => void;
  onRequestClose: () => void;
  onRename: (title: string) => void;
  onMenu: (x: number, y: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const strings = useStrings();
  const [editing, setEditing] = useState(false);
  // faz5-spec §2.3: the pane's agent status dot left of the tab title (none without an agent).
  const agentState = useAgentStore((s) => (tab.paneId ? stateForPane(s.agents, tab.paneId) : null));

  return (
    <div
      className={`flex h-7 shrink-0 items-center gap-1.5 border-r border-border px-2 text-xs ${active ? "bg-surface-4" : ""} ${tab.status === "exited" ? "opacity-60" : "opacity-100"}`}
      data-tab-id={tab.id}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      onClick={onActivate}
      onAuxClick={(e) => {
        if (e.button === 1) onRequestClose(); // middle click closes
      }}
      onDoubleClick={() => setEditing(true)}
      title={tab.status === "exited" ? strings.terminal.exitTooltip(tab.exitCode ?? 0) : undefined}
    >
      <AgentBadge state={agentState} />
      {editing ? (
        <InlineInput
          initialValue={tab.title}
          onSubmit={(value) => {
            onRename(value);
            setEditing(false);
            return Promise.resolve(null);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <span className="max-w-[10rem] truncate">{tab.title}</span>
      )}
      <button
        type="button"
        title={strings.terminal.closeTooltip}
        className="rounded px-0.5 leading-none text-muted"
        onClick={(e) => {
          e.stopPropagation();
          onRequestClose();
        }}
      >
        ×
      </button>
    </div>
  );
}

function NewMenuButton({
  workspaceId,
  profiles,
  launch,
}: {
  workspaceId: string;
  profiles: ShellProfile[];
  launch: LaunchOption[];
}) {
  const strings = useStrings();
  const [menu, setMenu] = useState<"profile" | "agent" | null>(null);
  const btnRef = useRef<HTMLDivElement>(null);

  function openMenu(kind: "profile" | "agent") {
    setMenu((m) => (m === kind ? null : kind));
  }

  function itemsFor(kind: "profile" | "agent"): ContextMenuItem[] {
    if (kind === "profile") {
      return profiles.map((p) => ({
        label: p.name,
        onClick: () => useTerminalStore.getState().newTerminal(workspaceId, { profileId: p.id }),
      }));
    }
    return launch.map((o) => ({
      label: o.label,
      onClick: () => spawnTerminal(workspaceId, o.command),
    }));
  }

  const rect = btnRef.current?.getBoundingClientRect();
  // faz6-spec §10.19: "New agent ▶" is hidden when settings have no agent commands.
  const hasAgentCommands = launch.length > 0;

  return (
    <div ref={btnRef} className="flex items-center gap-1.5">
      <div className="flex">
        <HeaderButton joined="left" title={strings.terminal.newTerminal} onClick={() => spawnTerminal(workspaceId)}>
          +
        </HeaderButton>
        <HeaderButton joined="right" title={strings.terminal.chooseShell} onClick={() => openMenu("profile")}>
          ▾
        </HeaderButton>
      </div>
      {hasAgentCommands && (
        <HeaderButton onClick={() => openMenu("agent")}>{strings.terminal.newAgent} ▶</HeaderButton>
      )}
      {menu && rect && (
        <ContextMenu
          state={{ x: rect.left, y: rect.bottom, items: itemsFor(menu) }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * "New agent ▶" in the empty panel: same behaviour as the header button above – asks in a menu
 * which agent to start (does not start the first command directly).
 */
function EmptyNewAgentButton({ workspaceId, launch }: { workspaceId: string; launch: LaunchOption[] }) {
  const strings = useStrings();
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="rounded border border-border px-2 py-1 text-text"
        onClick={() => {
          const rect = btnRef.current?.getBoundingClientRect();
          setMenuAt((m) => (m || !rect ? null : { x: rect.left, y: rect.bottom }));
        }}
      >
        {strings.terminal.newAgent} ▶
      </button>
      {menuAt && (
        <ContextMenu
          state={{
            ...menuAt,
            items: launch.map((o) => ({ label: o.label, onClick: () => spawnTerminal(workspaceId, o.command) })),
          }}
          onClose={() => setMenuAt(null)}
        />
      )}
    </>
  );
}

export function TerminalPanel() {
  const strings = useStrings();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const byWorkspace = useTerminalStore((s) => s.byWorkspace);
  const profiles = useTerminalStore((s) => s.profiles);
  const terminalReady = useTerminalStore((s) => s.ready);
  const initTerminal = useTerminalStore((s) => s.init);
  const launch = useLaunchOptions();

  const [pendingBusyClose, setPendingBusyClose] = useState<PendingBusyClose | null>(null);
  const [tabMenu, setTabMenu] = useState<{ workspaceId: string; tabId: string; x: number; y: number } | null>(null);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState(false);

  useEffect(() => {
    void initTerminal();
  }, [initTerminal]);

  /** "Split right" (tab menu, drag onto the right half): the tab opens on the right. */
  function splitRight(workspaceId: string, tabId: string) {
    const ws = useTerminalStore.getState().byWorkspace[workspaceId];
    const targets = ws ? splitTabToRight(ws.tabs.map((t) => t.id), ws.activeTabId, tabId) : null;
    if (targets) useTerminalStore.getState().setSplit(workspaceId, targets.left, targets.right);
  }

  /**
   * Header split button: splits with the pane on the left (its neighbour, or a new terminal
   * when it is the only tab, on the right); when already split it closes this pane's half.
   */
  function toggleSplitBeside(workspaceId: string, tabId: string) {
    const store = useTerminalStore.getState();
    const ws = store.byWorkspace[workspaceId];
    if (!ws) return;
    if (ws.splitTabId) {
      store.closeSplit(workspaceId, tabId === ws.splitTabId ? "left" : "right");
      return;
    }
    const targets = splitBeside(ws.tabs.map((t) => t.id), tabId);
    const right = targets?.right ?? spawnTerminal(workspaceId);
    useTerminalStore.getState().setSplit(workspaceId, tabId, right);
  }

  function tabMenuItems(workspaceId: string, tabId: string): ContextMenuItem[] {
    const ws = byWorkspace[workspaceId];
    const canSplit = ws ? splitTabToRight(ws.tabs.map((t) => t.id), ws.activeTabId, tabId) !== null : false;
    const items: ContextMenuItem[] = [
      { label: strings.composer.split.splitRight, onClick: () => splitRight(workspaceId, tabId), disabled: !canSplit || ws?.splitTabId === tabId },
    ];
    if (ws?.splitTabId) {
      items.push({ label: strings.composer.split.closeSplit, onClick: () => useTerminalStore.getState().closeSplit(workspaceId, "left") });
    }
    items.push({ label: strings.terminal.close, onClick: () => void requestClose(workspaceId, tabId), separatorBefore: true });
    return items;
  }

  async function requestClose(workspaceId: string, tabId: string) {
    const tab = byWorkspace[workspaceId]?.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.status !== "running" || !tab.paneId) {
      void useTerminalStore.getState().closeTab(workspaceId, tabId);
      return;
    }
    try {
      const busy = await ptyBusy(tab.paneId);
      if (busy.busy) {
        setPendingBusyClose({ workspaceId, tabId, processes: busy.processes });
        return;
      }
    } catch {
      // If ptyBusy failed, close directly as well – nothing blocks.
    }
    void useTerminalStore.getState().closeTab(workspaceId, tabId);
  }

  if (!terminalReady) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title={strings.panels.terminal} />
      </div>
    );
  }

  const activeWs = activeWorkspaceId ? byWorkspace[activeWorkspaceId] : undefined;
  const tabs = activeWs?.tabs ?? [];

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={strings.panels.terminal}
        actions={
          activeWorkspaceId ? (
            <NewMenuButton workspaceId={activeWorkspaceId} profiles={profiles} launch={launch} />
          ) : null
        }
      />

      {activeWorkspaceId && tabs.length > 0 && (
        <div className="flex shrink-0 overflow-x-auto border-b border-border">
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={tab.id === activeWs?.activeTabId || tab.id === activeWs?.splitTabId}
              onActivate={() => {
                useTerminalStore.getState().activate(activeWorkspaceId, tab.id);
                if (tab.id === activeWs?.splitTabId) focusTerminal(tab.id);
              }}
              onRequestClose={() => void requestClose(activeWorkspaceId, tab.id)}
              onRename={(title) => useTerminalStore.getState().rename(activeWorkspaceId, tab.id, title)}
              onMenu={(x, y) => setTabMenu({ workspaceId: activeWorkspaceId, tabId: tab.id, x, y })}
              onDragStart={() => setDragTabId(tab.id)}
              onDragEnd={() => {
                setDragTabId(null);
                setDropOver(false);
              }}
            />
          ))}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {(!activeWorkspaceId || tabs.length === 0) && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted">
            <span>{strings.terminal.emptyTitle}</span>
            {activeWorkspaceId && (
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded bg-accent px-2 py-1 text-on-accent"
                  onClick={() => spawnTerminal(activeWorkspaceId)}
                >
                  {strings.terminal.newTerminal}
                </button>
                {launch.length > 0 && (
                  <EmptyNewAgentButton workspaceId={activeWorkspaceId} launch={launch} />
                )}
              </div>
            )}
          </div>
        )}

        {workspaces.map((ws) => {
          const wsState = byWorkspace[ws.id];
          const splitId = wsState?.splitTabId ?? null;
          return (wsState?.tabs ?? []).map((tab) => {
            const shown = ws.id === activeWorkspaceId;
            const side = !shown ? null : tab.id === wsState?.activeTabId ? (splitId ? "left" : "single") : tab.id === splitId ? "right" : null;
            const visible = side !== null;
            const placement =
              side === "left" ? "inset-y-0 left-0 w-1/2 border-r border-border" : side === "right" ? "inset-y-0 right-0 w-1/2" : "inset-0";
            return (
              <div
                key={tab.id}
                data-split-side={side ?? undefined}
                onFocusCapture={() => useTerminalStore.getState().setFocusedTab(ws.id, tab.id)}
                className={`absolute ${placement} ${visible ? "flex flex-col" : "hidden"}`}
              >
                {(side === "left" || side === "right") && (
                  <div className="flex h-6 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface-2 pl-2.5 pr-1 text-meta text-muted">
                    <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                    <button
                      type="button"
                      aria-label={strings.composer.split.closeHalf(tab.title)}
                      title={strings.composer.split.closeHalf(tab.title)}
                      className="rounded px-1 leading-none hover:text-text"
                      onClick={() => useTerminalStore.getState().closeSplit(ws.id, side === "left" ? "right" : "left")}
                    >
                      ×
                    </button>
                  </div>
                )}
                <AgentPane
                  workspaceId={ws.id}
                  tab={tab}
                  visible={visible}
                  split={{ open: splitId !== null, onToggle: () => toggleSplitBeside(ws.id, tab.id) }}
                />
              </div>
            );
          });
        })}

        {dragTabId && activeWorkspaceId && tabs.length > 1 && (
          <div
            data-testid="split-drop-zone"
            className={`absolute inset-y-0 right-0 z-20 flex w-1/2 items-center justify-center border-2 border-dashed ${dropOver ? "border-accent bg-accent-soft" : "border-border"}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropOver(true);
            }}
            onDragLeave={() => setDropOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              const tabId = e.dataTransfer.getData(TAB_DRAG_TYPE) || dragTabId;
              setDragTabId(null);
              setDropOver(false);
              splitRight(activeWorkspaceId, tabId);
            }}
          >
            <span className="rounded-control bg-surface-2 px-3 py-1.5 text-body text-text shadow-float">{strings.composer.split.dropRight}</span>
          </div>
        )}
      </div>

      {tabMenu && (
        <ContextMenu
          state={{
            x: tabMenu.x,
            y: tabMenu.y,
            items: tabMenuItems(tabMenu.workspaceId, tabMenu.tabId),
          }}
          onClose={() => setTabMenu(null)}
        />
      )}

      {pendingBusyClose && (
        <ConfirmModal
          title={strings.terminal.busyCloseTitle}
          body={strings.terminal.busyCloseBody(pendingBusyClose.processes)}
          confirmLabel={strings.terminal.closeAnyway}
          onCancel={() => setPendingBusyClose(null)}
          onConfirm={() => {
            void useTerminalStore.getState().closeTab(pendingBusyClose.workspaceId, pendingBusyClose.tabId);
            setPendingBusyClose(null);
          }}
        />
      )}
    </div>
  );
}
