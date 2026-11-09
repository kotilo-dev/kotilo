/**
 * 0.6 worktree actions wired to the stores: create + start an agent in it, open a terminal or a
 * diff in it, close its tabs and remove it, and the palette command. Git work itself is Rust's
 * (`worktree_*` commands); the dialogs call these.
 */
import { registerCommand } from "../../app/commands";
import { strings } from "../../app/strings";
import {
  worktreeCreate,
  worktreeRemove,
  type WorktreeInfo,
  type WorktreeRemoveResult,
} from "../../lib/ipc";
import { useLayoutStore } from "../../stores/layoutStore";
import { useRouteStore } from "../../stores/routeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useViewerStore } from "../../stores/viewerStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { resolveDefaultProfileId } from "../terminal/defaultShell";
import { focusTerminal } from "../terminal/terminalRegistry";
import { tabsInWorktree } from "./worktreeLogic";

/** After closing a worktree's terminals: time for their processes (and an agent's graceful close) to let go of the folder. */
export const CLOSE_GRACE_MS = 1200;
/** A remove that fails right after closing terminals is retried this often (Windows file locks). */
const REMOVE_RETRIES = 2;
const REMOVE_RETRY_GAP_MS = 1500;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** New terminal tab in `rel` (the worktree folder), optionally running an agent; shown and focused. */
export function openWorktreeTerminal(workspaceId: string, rel: string, agentCommand: string | null = null): string {
  useRouteStore.getState().navigate("workspace");
  if (useWorkspaceStore.getState().activeId !== workspaceId) void useWorkspaceStore.getState().setActive(workspaceId);
  useLayoutStore.getState().setVisible("terminal", true);
  const store = useTerminalStore.getState();
  const profileId = resolveDefaultProfileId(store.profiles, useSettingsStore.getState().settings.terminal.defaultShell);
  const tabId = store.newTerminal(workspaceId, { profileId, cwdRel: rel, agentCommand });
  requestAnimationFrame(() => focusTerminal(tabId));
  return tabId;
}

/** Creates the worktree, refreshes the list and starts `agentCommand` (or a shell) in it. Rejects with the AppError. */
export async function createWorktreeAndStart(workspaceId: string, name: string, agentCommand: string | null): Promise<WorktreeInfo> {
  const info = await worktreeCreate(workspaceId, name);
  void useWorktreeStore.getState().refresh(workspaceId);
  openWorktreeTerminal(workspaceId, info.rel, agentCommand);
  return info;
}

/** The diff of one changed file of a worktree against `rev` (the merge-base), in the viewer. */
export function openWorktreeDiff(workspaceId: string, path: string, rev: string | null): void {
  useRouteStore.getState().navigate("workspace");
  if (useWorkspaceStore.getState().activeId !== workspaceId) void useWorkspaceStore.getState().setActive(workspaceId);
  useViewerStore.getState().openDiff(workspaceId, path, rev ? { rev } : undefined);
  useLayoutStore.getState().setVisible("viewer", true);
}

/**
 * Closes every terminal tab inside the worktree (the store's normal close: `pty_kill`, which
 * runs an agent's graceful close in Rust). Returns how many had a live process.
 */
export async function closeWorktreeTabs(workspaceId: string, rel: string): Promise<number> {
  const store = useTerminalStore.getState();
  const tabs = tabsInWorktree(store.byWorkspace[workspaceId]?.tabs ?? [], rel);
  const live = tabs.filter((t) => t.paneId || t.status === "starting").length;
  await Promise.all(tabs.map((t) => store.closeTab(workspaceId, t.id)));
  return live;
}

/**
 * Closes the worktree's terminals, then removes it. While closed processes may still hold the
 * folder, a `failed` remove is retried a couple of times. Refusals (`dirty` / `unmerged`) come
 * back unchanged for the dialog to confirm.
 */
export async function removeWorktreeClosingTabs(
  workspaceId: string,
  wt: Pick<WorktreeInfo, "name" | "rel">,
  opts: { force: boolean; deleteBranch: boolean; forceBranch: boolean },
): Promise<WorktreeRemoveResult> {
  const live = await closeWorktreeTabs(workspaceId, wt.rel);
  if (live > 0) await wait(CLOSE_GRACE_MS);
  let result = await worktreeRemove(workspaceId, wt.name, opts);
  for (let i = 0; live > 0 && result.status === "failed" && i < REMOVE_RETRIES; i++) {
    await wait(REMOVE_RETRY_GAP_MS);
    result = await worktreeRemove(workspaceId, wt.name, opts);
  }
  void useWorktreeStore.getState().refresh(workspaceId);
  return result;
}

/** Opens the create dialog for a workspace (default: the active one). */
export function openCreateWorktreeDialog(workspaceId?: string | null): void {
  const id = workspaceId ?? useWorkspaceStore.getState().activeId;
  if (id) useWorktreeStore.getState().openDialog({ kind: "create", workspaceId: id });
}

/** "Agents: New agent in worktree…" in the palette; returns the uninstaller. */
export function installWorktreeCommands(): () => void {
  return registerCommand({
    id: "worktrees.newAgent",
    title: () => strings.worktrees.commandTitle,
    category: () => strings.commandCategories.agents,
    enabled: () => useWorkspaceStore.getState().activeId !== null,
    run: () => openCreateWorktreeDialog(),
  });
}
