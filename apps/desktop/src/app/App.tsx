import { useEffect, useMemo, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { installGlobalKeydownListener, registerCommand } from "./commands";
import { strings, useStrings } from "./strings";
import { NavRail } from "./NavRail";
import { RoutePage } from "./RoutePage";
import { registerRouteCommands } from "./routeCommands";
import { installThemeSync } from "./theme/themeSync";
import { useResolvedTheme } from "./theme/resolvedTheme";
import { initHubStore } from "../stores/hubStore";
import { useRouteStore } from "../stores/routeStore";
import { collectDiagnostics, openLogsFolder } from "./diagnosticsActions";
import { StatusBar } from "./StatusBar";
import { AppTray } from "./AppTray";
import { CloseGuard } from "./CloseGuard";
import { HelpModal } from "../features/help/HelpModal";
import { openHelpFromF1, useHelpStore } from "../features/help/helpStore";
import { WorkspacesPanel } from "../features/workspaces/WorkspacesPanel";
import { openAddWorkspaceDialog } from "../features/workspaces/addWorkspaceDialog";
import { AgentsPanel } from "../features/agents/AgentsPanel";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { focusTerminal } from "../features/terminal/terminalRegistry";
import { spawnTerminal } from "../features/terminal/defaultShell";
import { ViewerPanel } from "../features/viewer/ViewerPanel";
import { TimelineRail } from "../features/timeline/TimelineRail";
import { ToastHost } from "../features/toast/ToastHost";
import { UpdatePrompt } from "../features/update/UpdatePrompt";
import { MascotOffer } from "../features/toast/MascotOffer";
import { useMascotBridge } from "../features/mascot/useMascotBridge";
import { useAssistantBridge } from "../features/assistant/useAssistantBridge";
import { scheduleStartupUpdateCheck } from "../features/update/updateStore";
import { QuickPick } from "../features/palette/QuickPick";
import { installRecentTabsTracking } from "../features/palette/recentTabs";
import { useLayoutStore, type ColumnSizes } from "../stores/layoutStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useAgentStore } from "../stores/agentStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useQuickPickStore } from "../stores/quickPickStore";
import { nextBlockedTarget, sortAgents } from "../features/agents/agentLogic";
import { navigateToAgent } from "../features/agents/navigate";
import { installLaunchCommands } from "../features/agents/launch";
import { installUnseenWork } from "../features/agents/unseenWork";
import { useDefinitionsStore } from "../stores/definitionsStore";
import { installLeftoverListener } from "../stores/leftoverStore";

const WORKSPACE_SHORTCUT_COUNT = 9;

const VERTICAL_HANDLE_CLASS =
  "w-[3px] shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent data-[resize-handle-active]:bg-accent";
const HORIZONTAL_HANDLE_CLASS =
  "h-[3px] shrink-0 cursor-row-resize bg-border transition-colors hover:bg-accent data-[resize-handle-active]:bg-accent";

type MainSlot = "left" | "terminal" | "viewer";

function LeftColumn() {
  const leftSplitSizes = useLayoutStore((s) => s.layout.leftSplitSizes);
  const setLeftSplitSizes = useLayoutStore((s) => s.setLeftSplitSizes);

  return (
    <PanelGroup
      direction="vertical"
      onLayout={(sizes) => {
        const [workspaces, agents] = sizes;
        if (workspaces === undefined || agents === undefined) return;
        setLeftSplitSizes({ workspaces, agents });
      }}
    >
      <Panel id="workspaces" defaultSize={leftSplitSizes.workspaces} minSize={10}>
        <WorkspacesPanel />
      </Panel>
      <PanelResizeHandle className={HORIZONTAL_HANDLE_CLASS} />
      <Panel id="agents" defaultSize={leftSplitSizes.agents} minSize={10}>
        <AgentsPanel />
      </Panel>
    </PanelGroup>
  );
}

export function App() {
  // Subscribes the whole tree to the UI language: a switch re-renders everything below.
  const s = useStrings();
  const route = useRouteStore((st) => st.route);
  const status = useLayoutStore((st) => st.status);
  const init = useLayoutStore((s) => s.init);
  const toggleLeft = useLayoutStore((s) => s.toggleLeft);
  const toggleTerminal = useLayoutStore((s) => s.toggleTerminal);
  const toggleViewer = useLayoutStore((s) => s.toggleViewer);

  useEffect(() => {
    void init();
    initHubStore();
    void useDefinitionsStore.getState().init();
    installLeftoverListener();
  }, [init]);

  useEffect(() => {
    document.title = s.windowTitle;
  }, [s, route]);

  // faz6-spec §2/§10.11: a theme change updates `<html data-theme>`. `main.tsx` sets it once at
  // startup (no flash); this handles LATER changes (from Settings / `view.toggleTheme`). It is
  // installed on App mount (as early as possible, before any terminal exists) so it runs first
  // in zustand's listener order: `TerminalView`'s own xterm theme effect must read the CSS
  // tokens AFTER this update (see the live font/theme effect in `TerminalView.tsx`).
  useEffect(() => installThemeSync(), []);

  useEffect(() => {
    installRecentTabsTracking();
  }, []);

  // M3: "Agents: New <agent>" palette commands for every installed adapter definition plus
  // the user's own commands (re-registered when either list changes).
  useEffect(() => installLaunchCommands(), []);

  // M5: one automatic update check a few seconds after launch (Settings → About can turn it off).
  useEffect(() => scheduleStartupUpdateCheck(), []);

  // M6: combined agent state → the desktop mascot; its clicks and menu come back here.
  useMascotBridge();
  useAssistantBridge();
  // D-056: taskbar badge, "while you were away" toast, hub seen state of own panes.
  useEffect(() => installUnseenWork(), []);

  // D18 (second half): WebView2 accelerator keys are disabled in Rust (src-tauri/src/lib.rs);
  // the right-click context menu is blocked here in the frontend.
  useEffect(() => {
    const handler = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);

  useEffect(() => {
    const unregisterFns = [
      registerCommand({
        id: "view.toggleLeftPanel",
        title: () => strings.commandTitles.toggleLeftPanel,
        category: () => strings.commandCategories.view,
        keybinding: "Mod+B",
        run: toggleLeft,
      }),
      // faz4-spec §4.1 (user decision 2026-09-27, VS Code layout): Ctrl+B left column
      // (unchanged), Ctrl+J terminal column (was Ctrl+Shift+T), Ctrl+Shift+U viewer column
      // (was Ctrl+Shift+V, which is now terminal paste everywhere). Both are "global": they
      // toggle the panel even while a terminal has focus and send nothing to the shell.
      registerCommand({
        id: "view.toggleTerminalPanel",
        title: () => strings.commandTitles.toggleTerminalPanel,
        category: () => strings.commandCategories.view,
        keybinding: "Mod+J",
        run: toggleTerminal,
      }),
      registerCommand({
        id: "view.toggleViewerPanel",
        title: () => strings.commandTitles.toggleViewerPanel,
        category: () => strings.commandCategories.view,
        keybinding: "Mod+Shift+U",
        run: toggleViewer,
      }),
      // faz4-spec §2.4/§4: focus the active workspace's active terminal (showing the column if
      // hidden); open a new terminal if there is none. Global scope.
      registerCommand({
        id: "terminal.focusOrCreate",
        title: () => strings.commandTitles.focusTerminal,
        category: () => strings.commandCategories.terminal,
        // Ctrl on every OS (U-3): macOS uses Cmd+` to cycle windows.
        keybinding: "Ctrl+`",
        run: () => {
          useRouteStore.getState().navigate("workspace");
          const workspaceId = useWorkspaceStore.getState().activeId;
          if (!workspaceId) return;
          useLayoutStore.getState().setVisible("terminal", true);
          const store = useTerminalStore.getState();
          let ws = store.byWorkspace[workspaceId];
          if (!ws || ws.tabs.length === 0) {
            store.newTerminal(workspaceId);
            ws = useTerminalStore.getState().byWorkspace[workspaceId];
          }
          const activeTabId = ws?.activeTabId;
          if (!activeTabId) return;
          store.activate(workspaceId, activeTabId);
          requestAnimationFrame(() => focusTerminal(activeTabId));
        },
      }),
      // faz5-spec §2.4: go to the next blocked agent (after the focused pane, else the first;
      // silent when none is blocked). "Focused pane" = the active workspace's active terminal tab
      // (regardless of the terminal column's visibility; the shortcut makes the panel visible).
      registerCommand({
        id: "agents.nextBlocked",
        title: () => strings.commandTitles.nextBlockedAgent,
        category: () => strings.commandCategories.agents,
        keybinding: "Mod+Shift+A",
        run: () => {
          const sorted = sortAgents(useAgentStore.getState().agents);
          const activeWorkspaceId = useWorkspaceStore.getState().activeId;
          const activeTab = activeWorkspaceId
            ? useTerminalStore.getState().byWorkspace[activeWorkspaceId]
            : undefined;
          const focusedPaneId = activeTab?.tabs.find((t) => t.id === activeTab.activeTabId)?.paneId ?? null;
          const target = nextBlockedTarget(sorted, focusedPaneId);
          if (target) navigateToAgent(target);
        },
      }),
      // Ctrl+1..9 → switch to the Nth workspace (faz2-spec §6, §8.16: only this is global,
      // tree-specific keys live in Tree.tsx's own onKeyDown).
      ...Array.from({ length: WORKSPACE_SHORTCUT_COUNT }, (_, i) =>
        registerCommand({
          id: `workspaces.switchTo${i + 1}`,
          title: () => strings.commandTitles.switchToWorkspace(i + 1),
          category: () => strings.commandCategories.workspaces,
          keybinding: `Mod+${i + 1}`,
          run: () => {
            const ws = useWorkspaceStore.getState().workspaces[i];
            if (ws) void useWorkspaceStore.getState().setActive(ws.id);
          },
        }),
      ),
      // M2 shell: one command per route, Alt+1…Alt+9 (Ctrl+1…9 already switch workspaces).
      ...registerRouteCommands(),
      // faz6-spec §5: QuickPick. File mode goes to the terminal while it has focus
      // (`notTerminal`); command mode and settings are always global (§10.6). Both are idempotent
      // (§10.7: if already open they switch mode / no-op, see `quickPickStore`).
      registerCommand({
        id: "quickOpen.show",
        title: () => strings.commandTitles.quickOpenShow,
        keybinding: "Mod+P",
        scope: "notTerminal",
        run: () => useQuickPickStore.getState().openFile(),
      }),
      registerCommand({
        id: "palette.show",
        title: () => strings.commandTitles.paletteShow,
        keybinding: "Mod+Shift+P",
        run: () => useQuickPickStore.getState().openCommand(),
      }),
      registerCommand({
        id: "settings.open",
        title: () => strings.commandTitles.settingsOpen,
        category: () => strings.commandCategories.preferences,
        keybinding: "Mod+,",
        run: () => useRouteStore.getState().navigate("settings"),
      }),
      registerCommand({
        id: "view.toggleTheme",
        title: () => strings.commandTitles.toggleTheme,
        category: () => strings.commandCategories.view,
        run: () => {
          // Toggles what is shown; a "system" setting becomes the opposite fixed theme.
          const shown = useResolvedTheme.getState().theme;
          useSettingsStore.getState().update({ theme: shown === "dark" ? "light" : "dark" });
        },
      }),
      registerCommand({
        id: "terminal.new",
        title: () => strings.commandTitles.terminalNew,
        category: () => strings.commandCategories.terminal,
        run: () => {
          const workspaceId = useWorkspaceStore.getState().activeId;
          if (workspaceId) spawnTerminal(workspaceId);
        },
      }),
      registerCommand({
        id: "workspaces.add",
        title: () => strings.commandTitles.workspacesAdd,
        category: () => strings.commandCategories.workspaces,
        run: () => void openAddWorkspaceDialog(),
      }),
      registerCommand({
        id: "agents.installHooks",
        title: () => strings.commandTitles.installHooks,
        category: () => strings.commandCategories.agents,
        enabled: () => !(useAgentStore.getState().hooks?.installed ?? false),
        run: () => void useAgentStore.getState().installHooks(),
      }),
      registerCommand({
        id: "agents.uninstallHooks",
        title: () => strings.commandTitles.uninstallHooks,
        category: () => strings.commandCategories.agents,
        enabled: () => useAgentStore.getState().hooks?.installed ?? false,
        run: () => void useAgentStore.getState().uninstallHooks(),
      }),
      // faz7-spec §4.2: command palette entries for the same actions as Settings → About.
      registerCommand({
        id: "help.collectDiagnostics",
        title: () => strings.commandTitles.collectDiagnostics,
        category: () => strings.commandCategories.help,
        run: () => void collectDiagnostics(),
      }),
      registerCommand({
        id: "help.openLogsFolder",
        title: () => strings.commandTitles.openLogsFolder,
        category: () => strings.commandCategories.help,
        run: () => void openLogsFolder(),
      }),
      // faz7-spec §10.3/§12.13: discoverable palette entries, one per Help item.
      registerCommand({
        id: "help.userGuide",
        title: () => strings.commandTitles.helpUserGuide,
        category: () => strings.commandCategories.help,
        run: () => useHelpStore.getState().openHelp("user-guide.md"),
      }),
      registerCommand({
        id: "help.keybindings",
        title: () => strings.commandTitles.helpKeybindings,
        category: () => strings.commandCategories.help,
        run: () => useHelpStore.getState().openHelp("keybindings.md"),
      }),
      registerCommand({
        id: "help.troubleshooting",
        title: () => strings.commandTitles.helpTroubleshooting,
        category: () => strings.commandCategories.help,
        run: () => useHelpStore.getState().openHelp("troubleshooting.md"),
      }),
      registerCommand({
        id: "help.about",
        title: () => strings.commandTitles.helpAbout,
        category: () => strings.commandCategories.help,
        run: () => useHelpStore.getState().openHelp("about"),
      }),
      // faz7-spec §10.3/§12.2/§12.4: F1, global (see `GLOBAL_COMBOS` in keyRouting.ts) — opens
      // Help on the last viewed doc (default User guide). Hidden from the palette (`enabled:
      // false` only affects palette visibility, not the keybinding itself, see `commands.ts`) —
      // the four entries above already cover discoverable access; F1's own behavior (contextual
      // "last doc") doesn't map to a single fixed palette title. No-op while any OTHER modal is
      // open, or while Help itself is already open.
      registerCommand({
        id: "help.openF1",
        title: () => strings.help.dialogLabel,
        category: () => strings.commandCategories.help,
        keybinding: "F1",
        enabled: () => false,
        run: openHelpFromF1,
      }),
    ];
    const removeListener = installGlobalKeydownListener();
    return () => {
      unregisterFns.forEach((unregister) => unregister());
      removeListener();
    };
  }, [toggleLeft, toggleTerminal, toggleViewer]);

  if (status === "loading") {
    // Panels are not rendered before the saved sizes load; otherwise they would jump from the
    // default size to the saved one (flicker).
    return (
      <div className="flex h-screen items-center justify-center text-muted">
        {s.loading}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex min-h-0 flex-1">
        <NavRail />
        <main className="relative min-w-0 flex-1">
          {/* The workspace stays mounted (terminals, editors, panel sizes) while another route is shown. */}
          <div className={route === "workspace" ? "flex h-full" : "hidden"} data-testid="workspace-route">
            <div className="h-full min-w-0 flex-1">
              <MainColumns />
            </div>
            <TimelineRail />
          </div>
          {route !== "workspace" && <RoutePage route={route} />}
        </main>
      </div>
      <StatusBar />
      <UpdatePrompt />
      <MascotOffer />
      <ToastHost />
      <CloseGuard />
      <AppTray />
      <QuickPick />
      <HelpModal />
    </div>
  );
}

const MAIN_SLOTS: MainSlot[] = ["left", "terminal", "viewer"];
const MIN_SIZE: Record<MainSlot, number> = { left: 12, terminal: 20, viewer: 15 };

/**
 * The three main columns. Hidden panels are **not unmounted** but collapsed to width 0 with
 * `collapse()`: when the terminal column is hidden its xterm instances and buffers must live on
 * (Phase 4). The store is the single source of truth; this component mirrors its visibility onto
 * the imperative panel API, and closing/opening by dragging is written back via
 * `onCollapse`/`onExpand`.
 */
function MainColumns() {
  const layout = useLayoutStore((s) => s.layout);
  const setColumnSizes = useLayoutStore((s) => s.setColumnSizes);
  const setVisible = useLayoutStore((s) => s.setVisible);

  const refs: Record<MainSlot, React.RefObject<ImperativePanelHandle>> = {
    left: useRef<ImperativePanelHandle>(null),
    terminal: useRef<ImperativePanelHandle>(null),
    viewer: useRef<ImperativePanelHandle>(null),
  };

  const visible: Record<MainSlot, boolean> = {
    left: layout.leftVisible,
    terminal: layout.terminalVisible,
    viewer: layout.viewerVisible,
  };

  // Sizes on first mount: hidden panels 0, visible ones scaled to sum to 100.
  const initialSizes = useMemo(() => {
    const total = MAIN_SLOTS.reduce((sum, s) => sum + (visible[s] ? layout.columnSizes[s] : 0), 0) || 1;
    return Object.fromEntries(
      MAIN_SLOTS.map((s) => [s, visible[s] ? (layout.columnSizes[s] / total) * 100 : 0]),
    ) as Record<MainSlot, number>;
    // Computed on the first render only; later changes go through the imperative API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    for (const slot of MAIN_SLOTS) {
      const panel = refs[slot].current;
      if (!panel) continue;
      if (visible[slot] && panel.isCollapsed()) {
        panel.expand();
        panel.resize(Math.max(layout.columnSizes[slot], MIN_SIZE[slot]));
      } else if (!visible[slot] && !panel.isCollapsed()) {
        panel.collapse();
      }
    }
    // Sizes are deliberately not dependencies: apply only when visibility changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.left, visible.terminal, visible.viewer]);

  function handleMainLayout(sizes: number[]) {
    const update: Partial<ColumnSizes> = {};
    MAIN_SLOTS.forEach((slot, i) => {
      const size = sizes[i];
      // A collapsed (0) panel keeps its last known size.
      if (size !== undefined && size > 0) update[slot] = size;
    });
    setColumnSizes(update);
  }

  const panelProps = (slot: MainSlot) => ({
    id: slot,
    order: MAIN_SLOTS.indexOf(slot),
    ref: refs[slot],
    collapsible: true,
    collapsedSize: 0,
    minSize: MIN_SIZE[slot],
    defaultSize: initialSizes[slot],
    onCollapse: () => setVisible(slot, false),
    onExpand: () => setVisible(slot, true),
  });

  const hideIf = (hidden: boolean) => (hidden ? " hidden" : "");

  return (
    <PanelGroup direction="horizontal" onLayout={handleMainLayout}>
      <Panel {...panelProps("left")}>
        <LeftColumn />
      </Panel>
      <PanelResizeHandle
        className={VERTICAL_HANDLE_CLASS + hideIf(!visible.left || (!visible.terminal && !visible.viewer))}
      />
      <Panel {...panelProps("terminal")}>
        <TerminalPanel />
      </Panel>
      <PanelResizeHandle className={VERTICAL_HANDLE_CLASS + hideIf(!visible.terminal || !visible.viewer)} />
      <Panel {...panelProps("viewer")}>
        <ViewerPanel />
      </Panel>
    </PanelGroup>
  );
}
