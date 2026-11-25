import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useAgentStore } from "../../stores/agentStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useToastStore } from "../../stores/toastStore";
import { useStrings } from "../../app/strings";
import { ConfirmModal } from "../../app/ConfirmModal";
import type { AppError, Workspace, WorkspaceGroup } from "../../lib/ipc";
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import { InlineInput } from "./InlineInput";
import { AgentStatePill } from "./AgentStatePill";
import { defaultCursor, groupNeighbour, groupedWorkspaces, rowKey, visibleRows } from "./groups";
import { urgentStateForWorkspace } from "../agents/agentLogic";
import { UnsavedChangesModal } from "../viewer/UnsavedChangesModal";
import { collectDirtyDocsForWorkspace, saveAllDirty, type DirtyDocRef } from "../viewer/unsavedChanges";
import { openCreateWorktreeDialog } from "../worktrees/worktreeActions";
import { openDocsCheck } from "../docs/docsActions";
import { openAgentContext } from "../context/contextActions";

interface RemoveRequest {
  workspaceId: string;
  name: string;
}

function GroupHeader({
  group,
  label,
  count,
  blocked,
  collapsed,
  isCursor,
  editing,
  onToggle,
  onContextMenu,
  onRename,
  onCancelRename,
}: {
  /** `null` = the "Ungrouped" header: not collapsible, no menu. */
  group: WorkspaceGroup | null;
  label: string;
  count: number;
  blocked: number;
  collapsed: boolean;
  isCursor: boolean;
  editing: boolean;
  onToggle: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  onRename?: (name: string) => Promise<AppError | null>;
  onCancelRename?: () => void;
}) {
  const strings = useStrings();
  const collapsible = group !== null;
  return (
    <div
      role="group"
      aria-label={label}
      data-group-id={group?.id ?? "ungrouped"}
      data-collapsed={collapsible ? String(collapsed) : undefined}
      className={`mt-1 flex select-none items-center gap-1.5 rounded-md px-2 py-1 text-label tracking-wide text-muted first:mt-0 ${
        isCursor ? "bg-surface-4" : collapsible ? "hover:bg-surface-4" : ""
      } ${collapsible ? "cursor-pointer" : "cursor-default"}`}
      onClick={() => {
        if (collapsible && !editing) onToggle();
      }}
      onContextMenu={onContextMenu}
    >
      <span aria-hidden className={`w-3 shrink-0 text-center ${collapsible ? "" : "invisible"}`}>
        {collapsed ? "▸" : "▾"}
      </span>
      {editing && onRename && onCancelRename ? (
        <span className="min-w-0 flex-1 normal-case" onClick={(e) => e.stopPropagation()}>
          <InlineInput initialValue={group?.name ?? ""} onSubmit={onRename} onCancel={onCancelRename} />
        </span>
      ) : (
        // User group names are shown as typed: CSS uppercase is locale-dependent ("iş" became "IŞ").
        <span className={`min-w-0 flex-1 truncate ${collapsible ? "" : "uppercase"}`} title={label}>
          {label}
        </span>
      )}
      {collapsed && blocked > 0 && (
        <span
          data-testid="group-alert-badge"
          title={strings.workspaces.groupAlertBadge(blocked)}
          aria-label={strings.workspaces.groupAlertBadge(blocked)}
          className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-blocked px-1 text-label font-semibold leading-none tracking-normal text-on-accent"
        >
          {blocked}
        </span>
      )}
      <span className="shrink-0 tabular-nums">{count}</span>
    </div>
  );
}

function WorkspaceRow({
  workspace,
  isActive,
  isCursor,
  editing,
  onPick,
  onContextMenu,
  onRename,
  onCancelRename,
}: {
  workspace: Workspace;
  isActive: boolean;
  isCursor: boolean;
  editing: boolean;
  onPick: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onRename: (name: string) => Promise<AppError | null>;
  onCancelRename: () => void;
}) {
  const strings = useStrings();
  const urgent = useAgentStore((s) => urgentStateForWorkspace(s.agents, workspace.id));
  const terminals = useTerminalStore((s) => s.runningCount(workspace.id));
  const bg = isActive ? "bg-accent-soft" : isCursor ? "bg-surface-4" : "hover:bg-surface-4";
  return (
    <div
      role="option"
      aria-selected={isActive}
      data-workspace-id={workspace.id}
      data-active={isActive ? "true" : undefined}
      className={`flex cursor-default select-none items-center gap-2.5 rounded-md px-2.5 py-2 ${bg}`}
      onClick={() => {
        if (!editing) onPick();
      }}
      onContextMenu={onContextMenu}
    >
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${isActive ? "bg-accent" : "border-[1.5px] border-faint"}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {editing ? (
          <span onClick={(e) => e.stopPropagation()}>
            <InlineInput initialValue={workspace.name} onSubmit={onRename} onCancel={onCancelRename} />
          </span>
        ) : (
          <span className={`truncate text-ui ${isActive ? "font-semibold" : ""}`} title={workspace.name}>
            {workspace.name}
          </span>
        )}
        <span className="truncate font-mono text-label text-muted" title={workspace.path}>
          {workspace.path}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        <AgentStatePill state={urgent} />
        {terminals > 0 && <span className="text-label text-muted">{strings.workspaces.terminalCount(terminals)}</span>}
      </span>
    </div>
  );
}

/**
 * Workspaces tab: the full list for managing workspaces, optionally in collapsible user groups
 * (D-080). One click makes a workspace active and stays on this tab; the context menu carries
 * the workspace actions; up/down move the cursor over the visible rows (group headers
 * included), Enter activates / toggles, F2 renames, Delete removes.
 */
export function WorkspaceList() {
  const strings = useStrings();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const groups = useWorkspaceStore((s) => s.groups);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const moveWorkspace = useWorkspaceStore((s) => s.moveWorkspace);
  const createGroup = useWorkspaceStore((s) => s.createGroup);
  const renameGroup = useWorkspaceStore((s) => s.renameGroup);
  const removeGroup = useWorkspaceStore((s) => s.removeGroup);
  const moveGroup = useWorkspaceStore((s) => s.moveGroup);
  const setWorkspaceGroup = useWorkspaceStore((s) => s.setWorkspaceGroup);
  const reveal = useWorkspaceStore((s) => s.reveal);
  const collapsedIds = useLayoutStore((s) => s.layout.collapsedWorkspaceGroups);
  const setGroupCollapsed = useLayoutStore((s) => s.setWorkspaceGroupCollapsed);
  const agents = useAgentStore((s) => s.agents);

  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  /** The "new group" input at the top; `workspaceId` = the workspace that joins the new group. */
  const [creating, setCreating] = useState<{ workspaceId?: string } | null>(null);
  const [pendingRemove, setPendingRemove] = useState<RemoveRequest | null>(null);
  // Removing a workspace with dirty documents reuses the "Save all / Discard / Cancel" flow
  // (same as CloseGuard, shared in `unsavedChanges.ts`).
  const [pendingRemoveDirty, setPendingRemoveDirty] = useState<(RemoveRequest & { dirty: DirtyDocRef[] }) | null>(null);

  const hasGroups = groups.length > 0;
  const collapsed = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const sections = useMemo(() => groupedWorkspaces(workspaces, groups), [workspaces, groups]);
  const rows = useMemo(() => visibleRows(sections, collapsed), [sections, collapsed]);
  const cursor =
    cursorKey && rows.some((r) => rowKey(r) === cursorKey) ? cursorKey : defaultCursor(rows, workspaces, groups, activeId);
  const cursorRow = rows.find((r) => rowKey(r) === cursor);

  function blockedIn(list: Workspace[]): number {
    const ids = new Set(list.map((w) => w.id));
    return agents.filter((a) => a.state === "blocked" && ids.has(a.workspaceId)).length;
  }

  async function pick(id: string) {
    setCursorKey(`w:${id}`);
    if (id !== activeId) await setActive(id);
  }

  function requestRemove(workspace: Workspace) {
    const dirty = collectDirtyDocsForWorkspace(workspace.id);
    const request = { workspaceId: workspace.id, name: workspace.name };
    if (dirty.length === 0) setPendingRemove(request);
    else setPendingRemoveDirty({ ...request, dirty });
  }

  function toggleGroup(id: string, next?: boolean) {
    setGroupCollapsed(id, next ?? !collapsed.has(id));
  }

  function groupPickerItems(ws: Workspace): ContextMenuItem[] {
    return [
      ...groups.map((g) => ({
        label: g.name,
        onClick: () => void setWorkspaceGroup(ws.id, g.id),
        disabled: ws.group === g.id,
      })),
      { label: strings.workspaces.newGroup, onClick: () => setCreating({ workspaceId: ws.id }), separatorBefore: groups.length > 0 },
      {
        label: strings.workspaces.removeFromGroup,
        onClick: () => void setWorkspaceGroup(ws.id, null),
        disabled: !ws.group || !groups.some((g) => g.id === ws.group),
      },
    ];
  }

  function menuItems(ws: Workspace): ContextMenuItem[] {
    return [
      { label: strings.worktrees.newAgent, onClick: () => openCreateWorktreeDialog(ws.id) },
      { label: strings.docs.contextMenu, onClick: () => openDocsCheck(ws.id) },
      { label: strings.agentContext.contextMenu, onClick: () => openAgentContext(ws.id) },
      { label: strings.contextMenu.rename, onClick: () => setRenamingId(ws.id), separatorBefore: true },
      { label: strings.contextMenu.removeWorkspace, onClick: () => requestRemove(ws) },
      {
        label: strings.workspaces.moveToGroup,
        keepOpen: true,
        separatorBefore: true,
        onClick: () => setContextMenu((m) => (m ? { ...m, items: groupPickerItems(ws) } : m)),
      },
      { label: strings.contextMenu.openInExplorer, onClick: () => void reveal(ws.id, ""), separatorBefore: true },
      {
        label: strings.contextMenu.moveUp,
        onClick: () => void moveWorkspace(ws.id, "up"),
        disabled: groupNeighbour(workspaces, groups, ws.id, "up") === null,
        separatorBefore: true,
      },
      {
        label: strings.contextMenu.moveDown,
        onClick: () => void moveWorkspace(ws.id, "down"),
        disabled: groupNeighbour(workspaces, groups, ws.id, "down") === null,
      },
    ];
  }

  function groupMenuItems(g: WorkspaceGroup): ContextMenuItem[] {
    const idx = groups.findIndex((x) => x.id === g.id);
    return [
      { label: strings.contextMenu.rename, onClick: () => setRenamingGroupId(g.id) },
      { label: strings.workspaces.deleteGroup, onClick: () => void removeGroup(g.id) },
      { label: strings.contextMenu.moveUp, onClick: () => void moveGroup(g.id, "up"), disabled: idx <= 0, separatorBefore: true },
      { label: strings.contextMenu.moveDown, onClick: () => void moveGroup(g.id, "down"), disabled: idx === groups.length - 1 },
      { label: strings.workspaces.newGroup, onClick: () => setCreating({}), separatorBefore: true },
    ];
  }

  function moveCursor(delta: number) {
    if (rows.length === 0) return;
    const idx = rows.findIndex((r) => rowKey(r) === cursor);
    const next = rows[Math.min(Math.max(idx + delta, 0), rows.length - 1)];
    if (next) setCursorKey(rowKey(next));
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // The context menu and the modals render inside this div, so their keys bubble here too.
    if (renamingId || renamingGroupId || creating || pendingRemove || pendingRemoveDirty || contextMenu) return;
    if (e.target !== e.currentTarget) return;
    const row = cursorRow;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveCursor(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveCursor(-1);
        break;
      case "ArrowLeft":
        if (row?.kind === "group") {
          e.preventDefault();
          toggleGroup(row.group.id, true);
        }
        break;
      case "ArrowRight":
        if (row?.kind === "group") {
          e.preventDefault();
          toggleGroup(row.group.id, false);
        }
        break;
      case "Enter":
      case " ":
        if (row?.kind === "group") {
          e.preventDefault();
          toggleGroup(row.group.id);
        } else if (row && e.key === "Enter") {
          e.preventDefault();
          void pick(row.workspace.id);
        }
        break;
      case "F2":
        e.preventDefault();
        if (row?.kind === "group") setRenamingGroupId(row.group.id);
        else if (row) setRenamingId(row.workspace.id);
        break;
      case "Delete":
        // Only workspaces (with a confirm); a group is deleted from its header menu, so one
        // stray key on a header (the default cursor of a collapsed group) cannot dissolve it.
        if (row?.kind === "workspace") {
          e.preventDefault();
          requestRemove(row.workspace);
        }
        break;
      default:
        break;
    }
  }

  async function submitRename(id: string, name: string): Promise<AppError | null> {
    const err = await renameWorkspace(id, name);
    if (!err) setRenamingId(null);
    return err;
  }

  async function submitGroupRename(id: string, name: string): Promise<AppError | null> {
    const err = await renameGroup(id, name);
    if (!err) setRenamingGroupId(null);
    return err;
  }

  async function submitNewGroup(name: string): Promise<AppError | null> {
    const err = await createGroup(name, creating?.workspaceId);
    if (!err) setCreating(null);
    return err;
  }

  return (
    <div
      role="listbox"
      aria-label={strings.workspaces.listLabel}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        // Only the list's own empty area: menus and modals render inside this div too.
        if (e.target !== e.currentTarget || contextMenu || pendingRemove || pendingRemoveDirty) return;
        setContextMenu({ x: e.clientX, y: e.clientY, items: [{ label: strings.workspaces.newGroup, onClick: () => setCreating({}) }] });
      }}
      className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-1.5 text-xs outline-none"
    >
      {creating && (
        <div className="px-2.5 py-1">
          <InlineInput
            initialValue=""
            placeholder={strings.workspaces.newGroupPlaceholder}
            onSubmit={submitNewGroup}
            onCancel={() => setCreating(null)}
          />
        </div>
      )}

      {sections.map((section) => {
        const g = section.group;
        const isCollapsed = !!g && collapsed.has(g.id);
        return (
          <div key={g?.id ?? "ungrouped"} className="flex flex-col gap-0.5">
            {hasGroups && (
              <GroupHeader
                group={g}
                label={g?.name ?? strings.workspaces.ungrouped}
                count={section.workspaces.length}
                blocked={blockedIn(section.workspaces)}
                collapsed={isCollapsed}
                isCursor={!!g && cursor === `g:${g.id}`}
                editing={!!g && renamingGroupId === g.id}
                onToggle={() => {
                  if (!g) return;
                  setCursorKey(`g:${g.id}`);
                  toggleGroup(g.id);
                }}
                onContextMenu={
                  g
                    ? (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCursorKey(`g:${g.id}`);
                        setContextMenu({ x: e.clientX, y: e.clientY, items: groupMenuItems(g) });
                      }
                    : undefined
                }
                onRename={g ? (name) => submitGroupRename(g.id, name) : undefined}
                onCancelRename={() => setRenamingGroupId(null)}
              />
            )}
            {!isCollapsed &&
              section.workspaces.map((ws) => (
                <WorkspaceRow
                  key={ws.id}
                  workspace={ws}
                  isActive={ws.id === activeId}
                  isCursor={cursor === `w:${ws.id}`}
                  editing={renamingId === ws.id}
                  onPick={() => void pick(ws.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCursorKey(`w:${ws.id}`);
                    setContextMenu({ x: e.clientX, y: e.clientY, items: menuItems(ws) });
                  }}
                  onRename={(name) => submitRename(ws.id, name)}
                  onCancelRename={() => setRenamingId(null)}
                />
              ))}
          </div>
        );
      })}

      {contextMenu && <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />}

      {pendingRemove && (
        <ConfirmModal
          title={strings.confirm.removeWorkspaceTitle(pendingRemove.name)}
          body={strings.confirm.removeWorkspaceBody(useTerminalStore.getState().runningCount(pendingRemove.workspaceId))}
          confirmLabel={strings.confirm.removeConfirm}
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            void removeWorkspace(pendingRemove.workspaceId);
            setPendingRemove(null);
          }}
        />
      )}

      {pendingRemoveDirty && (
        <UnsavedChangesModal
          title={strings.confirm.removeWorkspaceUnsavedTitle(pendingRemoveDirty.name)}
          body={strings.confirm.removeWorkspaceUnsavedBody(useTerminalStore.getState().runningCount(pendingRemoveDirty.workspaceId))}
          saveLabel={strings.viewer.closeAppModal.saveAll}
          discardLabel={strings.viewer.closeAppModal.discard}
          onCancel={() => setPendingRemoveDirty(null)}
          onDiscard={() => {
            void removeWorkspace(pendingRemoveDirty.workspaceId);
            setPendingRemoveDirty(null);
          }}
          onSave={() => {
            const target = pendingRemoveDirty;
            setPendingRemoveDirty(null);
            void saveAllDirty(target.dirty).then((ok) => {
              if (!ok) {
                useToastStore.getState().show(strings.viewer.closeAppModal.saveFailed);
                return; // save failed: cancel the removal
              }
              void removeWorkspace(target.workspaceId);
            });
          }}
        />
      )}
    </div>
  );
}
