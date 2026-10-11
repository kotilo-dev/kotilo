import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useViewerStore } from "../../stores/viewerStore";
import { flattenVisible, type Row } from "./flatten";
import { iconFor } from "./icons";
import { baseName, parentRel } from "./paths";
import { useStrings } from "../../app/strings";
import type { AppError, Workspace } from "../../lib/ipc";
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import { InlineInput } from "./InlineInput";
import { ConfirmModal } from "../../app/ConfirmModal";
import { UnsavedChangesModal } from "../viewer/UnsavedChangesModal";
import { collectDirtyDocsForWorkspace, saveAllDirty, type DirtyDocRef } from "../viewer/unsavedChanges";
import { useToastStore } from "../../stores/toastStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useAgentStore } from "../../stores/agentStore";
import { urgentStateForWorkspace } from "../agents/agentLogic";
import { AgentBadge } from "../agents/AgentBadge";

const ROW_HEIGHT = 22;
const INDENT_PX = 14;

export type Editing =
  | { kind: "rename-workspace"; workspaceId: string }
  | { kind: "rename-entry"; workspaceId: string; rel: string }
  | { kind: "creating"; workspaceId: string; dirRel: string; mode: "file" | "dir" };

type PendingDelete =
  | { kind: "entry"; workspaceId: string; rel: string; name: string }
  | { kind: "workspace"; workspaceId: string; name: string };

type CreatingRow = { kind: "creating"; workspaceId: string; dirRel: string; mode: "file" | "dir"; depth: number };
type DisplayRow = Row | CreatingRow;

function findAnchorIndex(rows: Row[], workspaceId: string, dirRel: string): { index: number; depth: number } | null {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.workspaceId !== workspaceId) continue;
    if (dirRel === "" && r.kind === "root") return { index: i, depth: 1 };
    if (dirRel !== "" && r.kind === "dir" && r.rel === dirRel) return { index: i, depth: r.depth + 1 };
  }
  return null;
}

function insertCreatingRow(rows: Row[], editing: Editing | null): DisplayRow[] {
  if (!editing || editing.kind !== "creating") return rows;
  const anchor = findAnchorIndex(rows, editing.workspaceId, editing.dirRel);
  if (!anchor) return rows; // target folder not visible (collapsed): skip silently
  const creating: CreatingRow = {
    kind: "creating",
    workspaceId: editing.workspaceId,
    dirRel: editing.dirRel,
    mode: editing.mode,
    depth: anchor.depth,
  };
  const next = [...rows] as DisplayRow[];
  next.splice(anchor.index + 1, 0, creating);
  return next;
}

/**
 * `true` if `editing`'s anchor row is still present in `rows` (finding #6). If it isn't
 * — the anchor directory got collapsed, or an `fs:changed` refresh pruned it — `editing`
 * must be cleared, otherwise there's no inline input left to receive tree keys and
 * `handleTreeKeyDown`'s `if (editing) return` leaves every tree key dead forever.
 */
export function editingAnchorExists(rows: Row[], editing: Editing): boolean {
  if (editing.kind === "rename-workspace") {
    return rows.some((r) => r.kind === "root" && r.workspaceId === editing.workspaceId);
  }
  if (editing.kind === "rename-entry") {
    return rows.some(
      (r) => (r.kind === "dir" || r.kind === "file") && r.workspaceId === editing.workspaceId && r.rel === editing.rel,
    );
  }
  return findAnchorIndex(rows, editing.workspaceId, editing.dirRel) !== null;
}

function rowKey(row: DisplayRow): string {
  if (row.kind === "root") return `root:${row.workspaceId}`;
  if (row.kind === "creating") return `creating:${row.workspaceId}:${row.dirRel}`;
  return `${row.kind}:${row.workspaceId}:${row.rel}`;
}

export function Tree() {
  const strings = useStrings();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const dirCache = useWorkspaceStore((s) => s.dirCache);
  const expanded = useWorkspaceStore((s) => s.expanded);
  const selected = useWorkspaceStore((s) => s.selected);

  const toggleExpanded = useWorkspaceStore((s) => s.toggleExpanded);
  const select = useWorkspaceStore((s) => s.select);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace);
  const moveWorkspace = useWorkspaceStore((s) => s.moveWorkspace);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const createDir = useWorkspaceStore((s) => s.createDir);
  const renameEntry = useWorkspaceStore((s) => s.renameEntry);
  const deleteEntry = useWorkspaceStore((s) => s.deleteEntry);
  const reveal = useWorkspaceStore((s) => s.reveal);
  const saveClipboardImage = useWorkspaceStore((s) => s.saveClipboardImage);
  const copyPath = useWorkspaceStore((s) => s.copyPath);
  const copyRelativePath = useWorkspaceStore((s) => s.copyRelativePath);

  const openFile = useViewerStore((s) => s.openFile);
  const agents = useAgentStore((s) => s.agents);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  // finding #6: removing a workspace with dirty documents does not call `removeWorkspace`
  // directly; it reuses the "Save all / Discard / Cancel" flow (same as CloseGuard, shared in
  // `unsavedChanges.ts`).
  const [pendingRemoveWorkspace, setPendingRemoveWorkspace] = useState<{
    workspaceId: string;
    name: string;
    dirty: DirtyDocRef[];
  } | null>(null);

  const rows = useMemo(
    () => flattenVisible({ workspaces, dirCache, expanded, activeId }),
    [workspaces, dirCache, expanded, activeId],
  );
  const displayRows = useMemo(() => insertCreatingRow(rows, editing), [rows, editing]);

  // Finding #6: clear `editing` once its anchor row is no longer visible so the tree
  // doesn't get stuck believing it's in edit mode with nothing actually rendered to
  // receive the keys.
  useEffect(() => {
    if (editing && !editingAnchorExists(rows, editing)) setEditing(null);
  }, [rows, editing]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: displayRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  function wsOf(id: string): Workspace | undefined {
    return workspaces.find((w) => w.id === id);
  }

  function matchesSelected(row: Row): boolean {
    if (!selected) return false;
    if (row.kind === "root") return selected.workspaceId === row.workspaceId && selected.rel === "";
    if (row.kind === "dir" || row.kind === "file") {
      return selected.workspaceId === row.workspaceId && selected.rel === row.rel;
    }
    return false;
  }

  function selectableRows(): Row[] {
    return rows.filter((r): r is Row => r.kind === "root" || r.kind === "dir" || r.kind === "file");
  }

  function selectedRow(): Row | undefined {
    return rows.find(matchesSelected);
  }

  function moveSelection(delta: number) {
    const list = selectableRows();
    if (list.length === 0) return;
    const idx = list.findIndex(matchesSelected);
    const nextIdx = Math.min(Math.max(idx + delta, 0), list.length - 1);
    const row = list[nextIdx];
    if (!row) return;
    select(row.workspaceId, row.kind === "root" ? "" : row.rel);
    const flatIdx = displayRows.findIndex((r) => r === row);
    if (flatIdx >= 0) virtualizer.scrollToIndex(flatIdx, { align: "auto" });
  }

  function openRow(row: Row, pinned: boolean) {
    if (row.kind === "root") {
      // Enter: activates an inactive root; toggles the tree of the active root.
      select(row.workspaceId, "");
      if (row.workspaceId === activeId) toggleExpanded(row.workspaceId, "");
      else void setActive(row.workspaceId);
    } else if (row.kind === "dir") {
      select(row.workspaceId, row.rel);
      toggleExpanded(row.workspaceId, row.rel);
    } else if (row.kind === "file") {
      select(row.workspaceId, row.rel);
      openFile(row.workspaceId, row.rel, { pinned });
    }
  }

  function startRenameForSelected() {
    const row = selectedRow();
    if (!row) return;
    if (row.kind === "root") setEditing({ kind: "rename-workspace", workspaceId: row.workspaceId });
    else if (row.kind === "dir" || row.kind === "file") setEditing({ kind: "rename-entry", workspaceId: row.workspaceId, rel: row.rel });
  }

  /** finding #6: removing a workspace with dirty documents asks Save all/Discard/Cancel first. */
  function requestRemoveWorkspace(workspaceId: string, name: string) {
    const dirty = collectDirtyDocsForWorkspace(workspaceId);
    if (dirty.length === 0) {
      setPendingDelete({ kind: "workspace", workspaceId, name });
    } else {
      setPendingRemoveWorkspace({ workspaceId, name, dirty });
    }
  }

  function startDeleteForSelected() {
    const row = selectedRow();
    if (!row) return;
    if (row.kind === "root") {
      const ws = wsOf(row.workspaceId);
      if (ws) requestRemoveWorkspace(row.workspaceId, ws.name);
    } else if (row.kind === "dir" || row.kind === "file") {
      setPendingDelete({ kind: "entry", workspaceId: row.workspaceId, rel: row.rel, name: baseName(row.rel) });
    }
  }

  function startCreate(workspaceId: string, dirRel: string, mode: "file" | "dir") {
    const isExpanded = expanded[workspaceId]?.has(dirRel) ?? false;
    if (!isExpanded) toggleExpanded(workspaceId, dirRel);
    setEditing({ kind: "creating", workspaceId, dirRel, mode });
  }

  function handleTreeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // ConfirmModal/ContextMenu render *inside* this div (so they can be positioned
    // relative to it), so their key events bubble here too. Bail out whenever one of
    // them is open (their own keys — e.g. Enter on the Confirm button — must not also
    // be interpreted as tree navigation), and also when the event didn't originate on
    // the tree container itself (e.g. from the modal's focused button), as a second
    // line of defense (finding #2).
    if (editing || pendingDelete || pendingRemoveWorkspace || contextMenu) return;
    if (e.target !== e.currentTarget) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveSelection(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveSelection(-1);
        break;
      case "ArrowRight": {
        e.preventDefault();
        const row = selectedRow();
        if (row?.kind === "root" && !row.expanded && row.workspaceId === activeId) toggleExpanded(row.workspaceId, "");
        else if (row?.kind === "dir" && !row.expanded) toggleExpanded(row.workspaceId, row.rel);
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const row = selectedRow();
        if (row?.kind === "root" && row.expanded) toggleExpanded(row.workspaceId, "");
        else if (row?.kind === "dir" && row.expanded) toggleExpanded(row.workspaceId, row.rel);
        else if (row && selected) {
          const parent = row.kind === "root" ? null : parentRel(row.rel);
          if (parent !== null) select(selected.workspaceId, parent);
        }
        break;
      }
      case "Enter": {
        e.preventDefault();
        const row = selectedRow();
        // Enter = double click (open in the preview tab), Ctrl+Enter = Ctrl+click (new tab).
        if (row) openRow(row, e.ctrlKey);
        break;
      }
      case "F2":
        e.preventDefault();
        startRenameForSelected();
        break;
      case "Delete":
        e.preventDefault();
        startDeleteForSelected();
        break;
      case "v":
      case "V":
        // Ctrl+Shift+V is the terminal-paste shortcut everywhere now (faz4-spec §4.1 — the
        // panel toggle moved to Ctrl+Shift+U); without the shift/alt guard, a bare Ctrl+V
        // here would still collide with a clipboard-image save.
        if (e.ctrlKey && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          const row = selectedRow();
          if (row?.kind === "root") void saveClipboardImage(row.workspaceId, "");
          else if (row?.kind === "dir") void saveClipboardImage(row.workspaceId, row.rel);
        }
        break;
      default:
        break;
    }
  }

  /** faz4-spec §2.7: a folder's own path as cwd; a file's parent folder. */
  function openTerminalHere(workspaceId: string, cwdRel: string) {
    void setActive(workspaceId);
    useTerminalStore.getState().newTerminal(workspaceId, { cwdRel });
    useLayoutStore.getState().setVisible("terminal", true);
  }

  function openContextMenu(e: ReactMouseEvent, items: ContextMenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }

  function rootMenuItems(ws: Workspace): ContextMenuItem[] {
    return [
      {
        label: strings.contextMenu.makeActive,
        onClick: () => void setActive(ws.id),
        disabled: ws.id === activeId,
      },
      { label: strings.contextMenu.newFile, onClick: () => startCreate(ws.id, "", "file"), separatorBefore: true },
      { label: strings.contextMenu.newFolder, onClick: () => startCreate(ws.id, "", "dir") },
      {
        label: strings.contextMenu.rename,
        onClick: () => setEditing({ kind: "rename-workspace", workspaceId: ws.id }),
        separatorBefore: true,
      },
      {
        label: strings.contextMenu.removeWorkspace,
        onClick: () => requestRemoveWorkspace(ws.id, ws.name),
      },
      { label: strings.contextMenu.openInExplorer, onClick: () => void reveal(ws.id, ""), separatorBefore: true },
      { label: strings.contextMenu.saveClipboardImageHere, onClick: () => void saveClipboardImage(ws.id, "") },
      {
        label: strings.contextMenu.moveUp,
        onClick: () => void moveWorkspace(ws.id, "up"),
        disabled: workspaces[0]?.id === ws.id,
        separatorBefore: true,
      },
      {
        label: strings.contextMenu.moveDown,
        onClick: () => void moveWorkspace(ws.id, "down"),
        disabled: workspaces[workspaces.length - 1]?.id === ws.id,
      },
    ];
  }

  function dirMenuItems(workspaceId: string, rel: string): ContextMenuItem[] {
    return [
      { label: strings.contextMenu.newFile, onClick: () => startCreate(workspaceId, rel, "file") },
      { label: strings.contextMenu.newFolder, onClick: () => startCreate(workspaceId, rel, "dir") },
      {
        label: strings.contextMenu.rename,
        onClick: () => setEditing({ kind: "rename-entry", workspaceId, rel }),
        separatorBefore: true,
      },
      {
        label: strings.contextMenu.delete,
        onClick: () => setPendingDelete({ kind: "entry", workspaceId, rel, name: baseName(rel) }),
      },
      { label: strings.contextMenu.copyPath, onClick: () => void copyPath(workspaceId, rel), separatorBefore: true },
      { label: strings.contextMenu.copyRelativePath, onClick: () => void copyRelativePath(workspaceId, rel) },
      { label: strings.contextMenu.revealInExplorer, onClick: () => void reveal(workspaceId, rel) },
      {
        label: strings.contextMenu.saveClipboardImageHere,
        onClick: () => void saveClipboardImage(workspaceId, rel),
        separatorBefore: true,
      },
      { label: strings.contextMenu.openTerminalHere, onClick: () => openTerminalHere(workspaceId, rel) },
    ];
  }

  function fileMenuItems(workspaceId: string, rel: string): ContextMenuItem[] {
    return [
      { label: strings.contextMenu.rename, onClick: () => setEditing({ kind: "rename-entry", workspaceId, rel }) },
      {
        label: strings.contextMenu.delete,
        onClick: () => setPendingDelete({ kind: "entry", workspaceId, rel, name: baseName(rel) }),
      },
      { label: strings.contextMenu.copyPath, onClick: () => void copyPath(workspaceId, rel), separatorBefore: true },
      { label: strings.contextMenu.copyRelativePath, onClick: () => void copyRelativePath(workspaceId, rel) },
      { label: strings.contextMenu.revealInExplorer, onClick: () => void reveal(workspaceId, rel) },
      {
        label: strings.contextMenu.openTerminalHere,
        onClick: () => openTerminalHere(workspaceId, parentRel(rel)),
        separatorBefore: true,
      },
    ];
  }

  async function submitRenameWorkspace(workspaceId: string, name: string): Promise<AppError | null> {
    const err = await renameWorkspace(workspaceId, name);
    if (!err) setEditing(null);
    return err;
  }

  async function submitRenameEntry(workspaceId: string, rel: string, newName: string): Promise<AppError | null> {
    const err = await renameEntry(workspaceId, rel, newName);
    if (!err) setEditing(null);
    return err;
  }

  async function submitCreate(workspaceId: string, dirRel: string, mode: "file" | "dir", name: string): Promise<AppError | null> {
    const err = mode === "file" ? await createFile(workspaceId, dirRel, name) : await createDir(workspaceId, dirRel, name);
    if (!err) setEditing(null);
    return err;
  }

  function renderRow(row: DisplayRow) {
    if (row.kind === "creating") {
      return (
        <div
          className="flex items-center px-1"
          style={{ paddingLeft: 4 + row.depth * INDENT_PX, height: ROW_HEIGHT }}
        >
          <span className="mr-1 w-3.5 shrink-0" />
          <span className="mr-1 shrink-0">{iconFor(row.mode === "dir" ? "" : "new", row.mode === "dir")}</span>
          <div className="min-w-0 flex-1">
            <InlineInput
              initialValue=""
              placeholder={row.mode === "file" ? strings.inline.newFilePlaceholder : strings.inline.newFolderPlaceholder}
              onSubmit={(name) => submitCreate(row.workspaceId, row.dirRel, row.mode, name)}
              onCancel={() => setEditing(null)}
            />
          </div>
        </div>
      );
    }

    if (row.kind === "loading") {
      return (
        <div
          className="flex items-center px-1 text-label text-muted"
          style={{ paddingLeft: 4 + row.depth * INDENT_PX, height: ROW_HEIGHT }}
        >
          {strings.workspaces.loading}
        </div>
      );
    }

    if (row.kind === "error") {
      return (
        <div
          className="flex items-center truncate px-1 text-label text-blocked"
          style={{ paddingLeft: 4 + row.depth * INDENT_PX, height: ROW_HEIGHT }}
        >
          {strings.errors.forCode(row.error.code)}
        </div>
      );
    }

    const isRoot = row.kind === "root";
    const rel = isRoot ? "" : row.rel;
    const workspaceId = row.workspaceId;
    const name = isRoot ? row.workspace.name : row.name;
    const isDir = isRoot || row.kind === "dir";
    const rowExpanded = isRoot || row.kind === "dir" ? row.expanded : false;
    const isEditingThis =
      (editing?.kind === "rename-workspace" && isRoot && editing.workspaceId === workspaceId) ||
      (editing?.kind === "rename-entry" && !isRoot && editing.workspaceId === workspaceId && editing.rel === rel);
    const isActive = isRoot && activeId === workspaceId;
    const isSel = matchesSelected(row);
    const rootWorkspace = row.kind === "root" ? row.workspace : null;

    return (
      <div
        className={`flex items-center px-1${isSel ? " bg-surface-4" : ""}`}
        style={{ paddingLeft: 4 + row.depth * INDENT_PX, height: ROW_HEIGHT }}
        onClick={(e) => {
          if (isEditingThis) return;
          // File: a click only selects, Ctrl+click opens in a new (pinned) tab, a double click
          // opens in the preview tab (onDoubleClick). Folder: a click toggles. Root: a click only
          // selects; activation is the ○ button (user request 2026-09-27); the active root's
          // tree toggles with the arrow (▶/▼).
          if (row.kind === "file") {
            if (e.ctrlKey) openRow(row as Row, true);
            else select(workspaceId, rel);
            return;
          }
          if (isRoot) {
            select(workspaceId, "");
            return;
          }
          openRow(row as Row, false);
        }}
        onDoubleClick={(e) => {
          if (isEditingThis || e.ctrlKey) return;
          if (row.kind === "file") openRow(row as Row, false);
        }}
        onContextMenu={(e) => {
          select(workspaceId, rel);
          if (rootWorkspace) openContextMenu(e, rootMenuItems(rootWorkspace));
          else if (isDir) openContextMenu(e, dirMenuItems(workspaceId, rel));
          else openContextMenu(e, fileMenuItems(workspaceId, rel));
        }}
      >
        <span
          className="mr-1 w-3.5 shrink-0 select-none text-muted"
          onClick={(e) => {
            // The active root's arrow toggles its tree; inactive roots have no arrow (no tree shown).
            if (!isRoot || isEditingThis) return;
            e.stopPropagation();
            if (isActive) toggleExpanded(workspaceId, "");
          }}
        >
          {isDir && (!isRoot || isActive) ? (rowExpanded ? "▼" : "▶") : ""}
        </span>
        {isRoot && (
          <button
            type="button"
            className={`mr-1 shrink-0 leading-none ${isActive ? "cursor-default text-accent" : "cursor-pointer text-muted"}`}
            title={isActive ? strings.workspaces.activeTooltip : strings.workspaces.activateTooltip}
            onClick={(e) => {
              e.stopPropagation();
              if (!isActive) void setActive(workspaceId);
            }}
          >
            {isActive ? "●" : "○"}
          </button>
        )}
        <span className="mr-1 shrink-0">{iconFor(name, isDir, rowExpanded)}</span>
        {isEditingThis ? (
          <div className="min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
            {editing?.kind === "rename-workspace" ? (
              <InlineInput
                initialValue={name}
                onSubmit={(value) => submitRenameWorkspace(workspaceId, value)}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <InlineInput
                initialValue={name}
                selectBaseNameOnly
                onSubmit={(value) => submitRenameEntry(workspaceId, rel, value)}
                onCancel={() => setEditing(null)}
              />
            )}
          </div>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate" title={name}>
              {name}
            </span>
            {isRoot && <AgentBadge state={urgentStateForWorkspace(agents, workspaceId)} />}
          </>
        )}
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      tabIndex={0}
      onKeyDown={handleTreeKeyDown}
      className="h-full min-h-0 flex-1 overflow-auto outline-none text-xs"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = displayRows[item.index];
          if (!row) return null;
          return (
            <div
              key={rowKey(row)}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
            >
              {renderRow(row)}
            </div>
          );
        })}
      </div>

      {contextMenu && <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />}

      {pendingDelete && pendingDelete.kind === "entry" && (
        <ConfirmModal
          title={strings.confirm.deleteTitle(pendingDelete.name)}
          body={strings.confirm.deleteBody}
          confirmLabel={strings.confirm.deleteConfirm}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void deleteEntry(pendingDelete.workspaceId, pendingDelete.rel);
            setPendingDelete(null);
          }}
        />
      )}

      {pendingDelete && pendingDelete.kind === "workspace" && (
        <ConfirmModal
          title={strings.confirm.removeWorkspaceTitle(pendingDelete.name)}
          body={strings.confirm.removeWorkspaceBody(useTerminalStore.getState().runningCount(pendingDelete.workspaceId))}
          confirmLabel={strings.confirm.removeConfirm}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void removeWorkspace(pendingDelete.workspaceId);
            setPendingDelete(null);
          }}
        />
      )}

      {pendingRemoveWorkspace && (
        <UnsavedChangesModal
          title={strings.confirm.removeWorkspaceUnsavedTitle(pendingRemoveWorkspace.name)}
          body={strings.confirm.removeWorkspaceUnsavedBody(useTerminalStore.getState().runningCount(pendingRemoveWorkspace.workspaceId))}
          saveLabel={strings.viewer.closeAppModal.saveAll}
          discardLabel={strings.viewer.closeAppModal.discard}
          onCancel={() => setPendingRemoveWorkspace(null)}
          onDiscard={() => {
            void removeWorkspace(pendingRemoveWorkspace.workspaceId);
            setPendingRemoveWorkspace(null);
          }}
          onSave={() => {
            const target = pendingRemoveWorkspace;
            setPendingRemoveWorkspace(null);
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
