/**
 * D-069 quick commands, wired to the stores: where an entry goes and the palette commands
 * ("Run: <title>", "Prompt: <title>"), re-registered when the list changes.
 *
 * A shell command is typed (with Enter) into the workspace's current terminal when a plain shell
 * runs there; otherwise it starts in a new tab. A prompt goes into an agent's composer – the
 * current tab's agent, else the workspace's first one – and the user sends it.
 */
import { registerCommand } from "../../app/commands";
import { strings } from "../../app/strings";
import { ptyWrite, type SavedPrompt } from "../../lib/ipc";
import { useAgentStore } from "../../stores/agentStore";
import { useHubStore } from "../../stores/hubStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useRouteStore } from "../../stores/routeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalStore, type TerminalTab } from "../../stores/terminalStore";
import { useToastStore } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useComposerInbox } from "../composer/composerInbox";
import { pastePayload } from "../composer/composerLogic";
import { useSettingsPageStore } from "../settings/SettingsPage";
import { spawnTerminal } from "../terminal/defaultShell";
import { focusTerminal } from "../terminal/terminalRegistry";
import { matchSession, paneVisualState } from "../workspace/paneSession";
import { appliesTo, commandLine, kindOf } from "./quickCommandLogic";

/** An agent runs in the tab: the same test as the pane's composer (own record or live session). */
export function tabHasAgent(tab: TerminalTab): boolean {
  if (tab.status !== "running" || !tab.paneId) return false;
  const paneId = tab.paneId;
  const known = useAgentStore.getState().agents.find((a) => a.paneId === paneId);
  const session = matchSession(useHubStore.getState().sessions, paneId, known);
  return paneVisualState(session, known) !== null;
}

function currentTab(workspaceId: string): TerminalTab | null {
  const ws = useTerminalStore.getState().byWorkspace[workspaceId];
  const id = ws?.focusedTabId ?? ws?.activeTabId;
  return ws?.tabs.find((t) => t.id === id) ?? null;
}

/** The terminal a shell command is typed into: the current tab while a plain shell runs in it. */
export function shellTabFor(workspaceId: string): TerminalTab | null {
  const tab = currentTab(workspaceId);
  return tab && tab.status === "running" && tab.paneId && !tabHasAgent(tab) ? tab : null;
}

/** The agent a prompt goes to: the current tab's, else the workspace's first running agent. */
export function agentTabFor(workspaceId: string): TerminalTab | null {
  const tab = currentTab(workspaceId);
  if (tab && tabHasAgent(tab)) return tab;
  return useTerminalStore.getState().byWorkspace[workspaceId]?.tabs.find(tabHasAgent) ?? null;
}

function workspacePath(workspaceId: string): string | null {
  return useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.path ?? null;
}

function showTab(workspaceId: string, tabId: string): void {
  useRouteStore.getState().navigate("workspace");
  useLayoutStore.getState().setVisible("terminal", true);
  const ws = useTerminalStore.getState().byWorkspace[workspaceId];
  // A split's right half is already on screen; activating it would move it to the left.
  if (ws?.splitTabId !== tabId) useTerminalStore.getState().activate(workspaceId, tabId);
}

export async function runQuickCommand(entry: SavedPrompt, workspaceId: string): Promise<void> {
  if (kindOf(entry) === "command") {
    const line = commandLine(entry.text);
    if (!line) return;
    const tab = shellTabFor(workspaceId);
    if (!tab?.paneId) {
      // The new tab runs the command in the default shell and stays open afterwards.
      showTab(workspaceId, spawnTerminal(workspaceId, line));
      return;
    }
    showTab(workspaceId, tab.id);
    try {
      await ptyWrite(tab.paneId, `${pastePayload(line, false)}\r`);
    } catch {
      useToastStore.getState().show(strings.toast.genericError);
    }
    requestAnimationFrame(() => focusTerminal(tab.id));
    return;
  }
  const tab = agentTabFor(workspaceId);
  if (!tab?.paneId) {
    useToastStore.getState().show(strings.quickCommands.noAgent);
    return;
  }
  showTab(workspaceId, tab.id);
  // The composer focuses itself when it takes the text.
  useComposerInbox.getState().deliver(tab.paneId, entry.text);
}

export function openQuickCommandSettings(): void {
  useSettingsPageStore.getState().setSection("quickCommands");
  useRouteStore.getState().navigate("settings");
}

function sameEntries(a: readonly SavedPrompt[], b: readonly SavedPrompt[]): boolean {
  return (
    a.length === b.length &&
    a.every((e, i) => {
      const o = b[i]!;
      return e.id === o.id && e.title === o.title && e.text === o.text && kindOf(e) === kindOf(o) && (e.project ?? "") === (o.project ?? "");
    })
  );
}

/** Registers one palette command per quick command and saved prompt; returns the uninstaller. */
export function installQuickCommands(): () => void {
  let current: SavedPrompt[] = [];
  let unregister: Array<() => void> = [];
  function sync() {
    const next = useSettingsStore.getState().settings.composer?.savedPrompts ?? [];
    // Value comparison: every settings_set answer carries a new list.
    if (unregister.length > 0 && sameEntries(current, next)) return;
    unregister.forEach((fn) => fn());
    current = next;
    const activeId = () => useWorkspaceStore.getState().activeId;
    unregister = [
      registerCommand({
        id: "quickCommands.manage",
        title: () => strings.commandTitles.manageQuickCommands,
        category: () => strings.commandCategories.terminal,
        run: openQuickCommandSettings,
      }),
      ...next.map((entry) =>
        registerCommand({
          id: `quick:${entry.id}`,
          title: entry.title,
          category: () => (kindOf(entry) === "command" ? strings.commandCategories.quickCommand : strings.commandCategories.quickPrompt),
          enabled: () => {
            const workspaceId = activeId();
            if (!workspaceId || !appliesTo(entry, workspacePath(workspaceId))) return false;
            return kindOf(entry) === "command" || agentTabFor(workspaceId) !== null;
          },
          run: () => {
            const workspaceId = activeId();
            if (workspaceId) void runQuickCommand(entry, workspaceId);
          },
        }),
      ),
    ];
  }
  sync();
  const unsubscribe = useSettingsStore.subscribe(sync);
  return () => {
    unregister.forEach((fn) => fn());
    unsubscribe();
  };
}
