import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useViewerStore } from "../../stores/viewerStore";
import { flattenVisible, type Row } from "./flatten";
import { iconFor } from "./icons";
import { baseName, parentRel } from "./paths";
import { useStrings } from "../../app/strings";
import type { AppError } from "../../lib/ipc";
import { ContextMenu, type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import { InlineInput } from "./InlineInput";
import { ConfirmModal } from "../../app/ConfirmModal";
import { useTerminalStore } from "../../stores/terminalStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { isModPressed } from "../../lib/keys";
import { useSettingsStore } from "../../stores/settingsStore";
import { useDocsStore } from "../../stores/docsStore";
import { DocBadgeDot } from "../docs/DocBadgeDot";
import { badgeIndex } from "../docs/docsLogic";

const ROW_HEIGHT = 22;
const INDENT_PX = 14;

export type Editing =
  | { kind: "rename-entry"; workspaceId: string; rel: string }
  | { kind: "creating"; workspaceId: string; dirRel: string; mode: "file" | "dir" };

interface PendingDelete {
  workspaceId: string;
  rel: string;
  name: string;
}

type CreatingRow = { kind: "creating"; workspaceId: string; dirRel: string; mode: "file" | "dir"; depth: number };
type DisplayRow = Row | CreatingRow;

/** Where the inline "new file/folder" row goes: the top of the list for the root, else under the folder. */
function findAnchorIndex(rows: Row[], workspaceId: string, dirRel: string): { index: number; depth: number } | null {
  if (dirRel === "") return { index: -1, depth: 0 };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.workspaceId !== workspaceId) continue;
    if (r.kind === "dir" && r.rel === dirRel) return { index: i, depth: r.depth + 1 };
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
  if (editing.kind === "rename-entry") {
    return rows.some(
      (r) => (r.kind === "dir" || r.kind === "file") && r.workspaceId === editing.workspaceId && r.rel === editing.rel,
    );
  }
  return findAnchorIndex(rows, editing.workspaceId, editing.dirRel) !== null;
}

type SelectableRow = Extract<Row, { kind: "dir" | "file" }>;

function rowKey(row: DisplayRow): string {
  if (row.kind === "creating") return `creating:${row.workspaceId}:${row.dirRel}`;
  return `${row.kind}:${row.workspaceId}:${row.rel}`;
}

/** What the Files header's "New file" / "New folder" buttons call into. */
export interface TreeHandle {
  /** Starts an inline create in the selected folder (or the selected file's folder, else the root). */
  startCreateAtSelection: (mode: "file" | "dir") => void;
}

/** The active workspace's file tree (the Files tab). No root row: the top level is always open. */
export const Tree = forwardRef<TreeHandle>(function Tree(_props, ref) {
  const strings = useStrings();
  const activeId = useWorkspaceStore((s) => s.activeId);
  const dirCache = useWorkspaceStore((s) => s.dirCache);
  const expanded = useWorkspaceStore((s) => s.expanded);
  const selected = useWorkspaceStore((s) => s.selected);

  const toggleExpanded = useWorkspaceStore((s) => s.toggleExpanded);
  const ensureRootLoaded = useWorkspaceStore((s) => s.ensureRootLoaded);
  const select = useWorkspaceStore((s) => s.select);
  const setActive = useWorkspaceStore((s) => s.setActive);
  const createFile = useWorkspaceStore((s) => s.createFile);
  const createDir = useWorkspaceStore((s) => s.createDir);
  const renameEntry = useWorkspaceStore((s) => s.renameEntry);
  const deleteEntry = useWorkspaceStore((s) => s.deleteEntry);
  const reveal = useWorkspaceStore((s) => s.reveal);
  const saveClipboardImage = useWorkspaceStore((s) => s.saveClipboardImage);
  const copyPath = useWorkspaceStore((s) => s.copyPath);
  const copyRelativePath = useWorkspaceStore((s) => s.copyRelativePath);

  const openFile = useViewerStore((s) => s.openFile);

  // 0.7: docs check badges on the active workspace's doc files (missing red, stale amber).
  const treeBadges = useSettingsStore((s) => s.settings.docs?.treeBadges ?? true);
  const docsReport = useDocsStore((s) => (activeId ? s.byWorkspace[activeId]?.report : null));
  const docBadges = useMemo(() => (treeBadges ? badgeIndex(docsReport) : null), [treeBadges, docsReport]);
  useEffect(() => (treeBadges && activeId ? useDocsStore.getState().watch(activeId) : undefined), [treeBadges, activeId]);

  // The top level is always shown, even when the saved state had the root collapsed.
  useEffect(() => {
    if (activeId) void ensureRootLoaded(activeId);
  }, [activeId, ensureRootLoaded]);

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  // A half-finished inline edit belongs to the workspace it started in.
  useEffect(() => setEditing(null), [activeId]);

  const rows = useMemo(() => flattenVisible({ dirCache, expanded, workspaceId: activeId }), [dirCache, expanded, activeId]);
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

  function matchesSelected(row: Row): boolean {
    if (!selected) return false;
    if (row.kind === "dir" || row.kind === "file") {
      return selected.workspaceId === row.workspaceId && selected.rel === row.rel;
    }
    return false;
  }

  function selectableRows(): SelectableRow[] {
    return rows.filter((r): r is SelectableRow => r.kind === "dir" || r.kind === "file");
  }

  function selectedRow(): SelectableRow | undefined {
    return selectableRows().find(matchesSelected);
  }

  function moveSelection(delta: number) {
    const list = selectableRows();
    if (list.length === 0) return;
    const idx = list.findIndex(matchesSelected);
    const nextIdx = Math.min(Math.max(idx + delta, 0), list.length - 1);
    const row = list[nextIdx];
    if (!row) return;
    select(row.workspaceId, row.rel);
    const flatIdx = displayRows.findIndex((r) => r === row);
    if (flatIdx >= 0) virtualizer.scrollToIndex(flatIdx, { align: "auto" });
  }

  function openRow(row: Row, pinned: boolean) {
    if (row.kind === "dir") {
      select(row.workspaceId, row.rel);
      toggleExpanded(row.workspaceId, row.rel);
    } else if (row.kind === "file") {
      select(row.workspaceId, row.rel);
      openFile(row.workspaceId, row.rel, { pinned });
    }
  }

  function startRenameForSelected() {
    const row = selectedRow();
    if (row) setEditing({ kind: "rename-entry", workspaceId: row.workspaceId, rel: row.rel });
  }

  function startDeleteForSelected() {
    const row = selectedRow();
    if (row) setPendingDelete({ workspaceId: row.workspaceId, rel: row.rel, name: baseName(row.rel) });
  }

  function startCreate(workspaceId: string, dirRel: string, mode: "file" | "dir") {
    // The root is always open; a sub-folder is opened so the new row is visible.
    if (dirRel !== "" && !(expanded[workspaceId]?.has(dirRel) ?? false)) toggleExpanded(workspaceId, dirRel);
    setEditing({ kind: "creating", workspaceId, dirRel, mode });
  }

  useImperativeHandle(ref, () => ({
    startCreateAtSelection: (mode) => {
      if (!activeId) return;
      const row = selected && selected.workspaceId === activeId ? selectedRow() : undefined;
      const dirRel = row ? (row.kind === "dir" ? row.rel : parentRel(row.rel)) : "";
      startCreate(activeId, dirRel, mode);
    },
  }));

  function handleTreeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // ConfirmModal/ContextMenu render *inside* this div (so they can be positioned
    // relative to it), so their key events bubble here too. Bail out whenever one of
    // them is open (their own keys — e.g. Enter on the Confirm button — must not also
    // be interpreted as tree navigation), and also when the event didn't originate on
    // the tree container itself (e.g. from the modal's focused button), as a second
    // line of defense (finding #2).
    if (editing || pendingDelete || contextMenu) return;
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
        if (row?.kind === "dir" && !row.expanded) toggleExpanded(row.workspaceId, row.rel);
        break;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const row = selectedRow();
        if (row?.kind === "dir" && row.expanded) toggleExpanded(row.workspaceId, row.rel);
        else if (row && selected) {
          const parent = parentRel(row.rel);
          if (parent !== "") select(selected.workspaceId, parent);
        }
        break;
      }
      case "Enter": {
        e.preventDefault();
        const row = selectedRow();
        // Enter = double click (open in the preview tab), Ctrl+Enter = Ctrl+click (new tab).
        if (row) openRow(row, isModPressed(e));
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
        if (isModPressed(e) && !e.shiftKey && !e.altKey && activeId) {
          e.preventDefault();
          const row = selectedRow();
          if (row?.kind === "dir") void saveClipboardImage(row.workspaceId, row.rel);
          else if (!row) void saveClipboardImage(activeId, "");
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

  /** Right click on the empty area below the rows: the workspace root's file actions. */
  function rootMenuItems(workspaceId: string): ContextMenuItem[] {
    return [
      { label: strings.contextMenu.newFile, onClick: () => startCreate(workspaceId, "", "file") },
      { label: strings.contextMenu.newFolder, onClick: () => startCreate(workspaceId, "", "dir") },
      { label: strings.contextMenu.openInExplorer, onClick: () => void reveal(workspaceId, ""), separatorBefore: true },
      {
        label: strings.contextMenu.saveClipboardImageHere,
        onClick: () => void saveClipboardImage(workspaceId, ""),
        separatorBefore: true,
      },
      { label: strings.contextMenu.openTerminalHere, onClick: () => openTerminalHere(workspaceId, "") },
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
        onClick: () => setPendingDelete({ workspaceId, rel, name: baseName(rel) }),
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
        onClick: () => setPendingDelete({ workspaceId, rel, name: baseName(rel) }),
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

    const { rel, workspaceId, name } = row;
    const isDir = row.kind === "dir";
    const rowExpanded = row.kind === "dir" ? row.expanded : false;
    const isEditingThis = editing?.kind === "rename-entry" && editing.workspaceId === workspaceId && editing.rel === rel;
    const isSel = matchesSelected(row);
    const docBadge = row.kind === "file" && workspaceId === activeId ? docBadges?.get(rel) : undefined;

    return (
      <div
        className={`group flex cursor-default select-none items-center px-1${isSel ? " bg-surface-4" : ""}`}
        style={{ paddingLeft: 4 + row.depth * INDENT_PX, height: ROW_HEIGHT }}
        onClick={(e) => {
          if (isEditingThis) return;
          // File: a click only selects, Ctrl+click opens in a new (pinned) tab, a double click
          // opens in the preview tab (onDoubleClick). Folder: a click toggles.
          if (row.kind === "file") {
            if (isModPressed(e)) openRow(row, true);
            else select(workspaceId, rel);
            return;
          }
          openRow(row, false);
        }}
        onDoubleClick={(e) => {
          if (isEditingThis || isModPressed(e)) return;
          if (row.kind === "file") openRow(row, false);
        }}
        onContextMenu={(e) => {
          select(workspaceId, rel);
          openContextMenu(e, isDir ? dirMenuItems(workspaceId, rel) : fileMenuItems(workspaceId, rel));
        }}
      >
        <span className="mr-1 w-3.5 shrink-0 select-none text-muted">{isDir ? (rowExpanded ? "▼" : "▶") : ""}</span>
        <span className="mr-1 shrink-0">{iconFor(name, isDir, rowExpanded)}</span>
        {isEditingThis ? (
          <div className="min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
            <InlineInput
              initialValue={name}
              selectBaseNameOnly
              onSubmit={(value) => submitRenameEntry(workspaceId, rel, value)}
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate" title={name}>
              {name}
            </span>
            {docBadge && <DocBadgeDot badge={docBadge} />}
          </>
        )}
      </div>
    );
  }

  if (!activeId) return null;

  return (
    <div
      ref={parentRef}
      tabIndex={0}
      onKeyDown={handleTreeKeyDown}
      onContextMenu={(e) => openContextMenu(e, rootMenuItems(activeId))}
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

      {pendingDelete && (
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
    </div>
  );
});
