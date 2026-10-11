/**
 * One component, two modes (faz6-spec §5, VS Code model): `Ctrl+P` file mode, `Ctrl+Shift+P`
 * command mode (input starts with `>`). The mode is derived from the input text
 * (`quickPickLogic.ts`) – there is no separate state field, so behaviours like "typing `>` in
 * file mode switches to command mode" work on their own.
 *
 * Open/close go through `quickPickStore` (so code outside React, e.g. `commands.ts` `run()`
 * callbacks, can reach it); this component is mounted unconditionally in App.tsx and returns
 * `null` while `open=false`.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStrings } from "../../app/strings";
import { listCommands, type Command } from "../../app/commands";
import { pushModalOpen } from "../../app/modalStack";
import { useQuickPickStore } from "../../stores/quickPickStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useViewerStore } from "../../stores/viewerStore";
import { fsQuickOpen } from "../../lib/ipc";
import { RequestGuard } from "../../lib/staleGuard";
import { EMPTY_ARRAY } from "../../lib/emptyArray";
import { moveIndex, PAGE_STEP } from "./listNav";
import {
  baseNameMatchIndices,
  commandLabel,
  filterCommands,
  modeForInput,
  queryForInput,
  recordCommandUsed,
  type ScoredCommand,
} from "./quickPickLogic";
import { orderByRecency, recentOrderFor } from "./recentTabs";

const FILE_QUERY_DEBOUNCE_MS = 60;
const FILE_QUERY_LIMIT = 50;
const MAX_VISIBLE_ROWS = 50;
const ROW_HEIGHT_PX = 24;

interface FileRow {
  rel: string;
  indices: number[] | null;
}

function HighlightedText({ text, indices }: { text: string; indices: number[] | null }) {
  if (!indices || indices.length === 0) return <>{text}</>;
  const chars = Array.from(text);
  const highlighted = new Set(indices);
  return (
    <>
      {chars.map((ch, i) =>
        highlighted.has(i) ? (
          <span key={i} className="font-semibold text-accent">
            {ch}
          </span>
        ) : (
          ch
        ),
      )}
    </>
  );
}

export function QuickPick() {
  const strings = useStrings();
  const open = useQuickPickStore((s) => s.open);
  const input = useQuickPickStore((s) => s.input);
  const setInput = useQuickPickStore((s) => s.setInput);
  const close = useQuickPickStore((s) => s.close);

  const activeWorkspaceId = useWorkspaceStore((s) => s.activeId);
  // CRITICAL fix #1: the selector never returns a fresh `[]` – without `s.byWorkspace[...]?.tabs`
  // it returns `undefined` (the real state reference or `undefined`, both stable); the fallback
  // (`EMPTY_ARRAY`, one module-level constant) is applied in a SEPARATE step in the render body.
  // Before, `?? []` sat inside the selector: every render where the active workspace had no
  // `viewerStore` entry produced a new `[]` – zustand v5 `useSyncExternalStore` took that as
  // "changed" and looped forever (QuickPick is always mounted).
  const rawWorkspaceTabs = useViewerStore((s) => (activeWorkspaceId ? s.byWorkspace[activeWorkspaceId]?.tabs : undefined));
  const workspaceTabs = rawWorkspaceTabs ?? EMPTY_ARRAY;

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const guardRef = useRef<RequestGuard | null>(null);
  if (!guardRef.current) guardRef.current = new RequestGuard();

  const [selected, setSelected] = useState(0);
  const [fileRows, setFileRows] = useState<FileRow[]>([]);
  const [truncated, setTruncated] = useState(false);

  const mode = modeForInput(input);
  const query = queryForInput(input);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // faz7-spec §12.4: tracked so the global F1 (Help) shortcut is a no-op while QuickPick is open.
  useEffect(() => {
    if (!open) return;
    return pushModalOpen();
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [mode, query, activeWorkspaceId]);

  // --- file mode: empty query -> open tabs (most recently activated first); with a query ->
  // `fs_quick_open` (60ms debounce, stale responses ignored via `RequestGuard` – §5.2, §10.21) ---
  useEffect(() => {
    if (!open || mode !== "file" || !activeWorkspaceId) {
      setFileRows([]);
      setTruncated(false);
      return;
    }
    if (query.trim() === "") {
      const order = recentOrderFor(activeWorkspaceId);
      const ordered = orderByRecency(
        workspaceTabs.map((t) => t.id),
        order,
      );
      const byId = new Map(workspaceTabs.map((t) => [t.id, t]));
      setFileRows(
        ordered
          .map((id) => byId.get(id))
          .filter((t): t is (typeof workspaceTabs)[number] => t !== undefined)
          .map((t) => ({ rel: t.rel, indices: null })),
      );
      setTruncated(false);
      return;
    }
    const requestId = guardRef.current!.next();
    const timer = setTimeout(() => {
      void fsQuickOpen(activeWorkspaceId, query, FILE_QUERY_LIMIT).then(
        (result) => {
          if (!guardRef.current!.isLatest(requestId)) return; // stale response – ignore
          setFileRows(result.items.map((item) => ({ rel: item.rel, indices: item.indices })));
          setTruncated(result.truncated);
        },
        () => {
          if (!guardRef.current!.isLatest(requestId)) return;
          setFileRows([]);
          setTruncated(false);
        },
      );
    }, FILE_QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, mode, query, activeWorkspaceId, workspaceTabs]);

  const commandRows: ScoredCommand[] = mode === "command" ? filterCommands(listCommands(), query) : [];
  const rowCount = mode === "file" ? fileRows.length : commandRows.length;

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) return null;

  function openFileRow(rel: string, pinned: boolean) {
    if (!activeWorkspaceId) return;
    void useWorkspaceStore.getState().expandAncestors(activeWorkspaceId, rel);
    useWorkspaceStore.getState().select(activeWorkspaceId, rel);
    useViewerStore.getState().openFile(activeWorkspaceId, rel, { pinned });
    close();
  }

  function runCommandRow(command: Command) {
    recordCommandUsed(command.id);
    close();
    command.run();
  }

  function activateRow(index: number, pinned: boolean) {
    if (mode === "file") {
      const row = fileRows[index];
      if (row) openFileRow(row.rel, pinned);
    } else {
      const command = commandRows[index]?.command;
      if (command) runCommandRow(command);
    }
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => moveIndex(i, rowCount, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => moveIndex(i, rowCount, -1));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setSelected((i) => moveIndex(i, rowCount, PAGE_STEP));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setSelected((i) => moveIndex(i, rowCount, -PAGE_STEP));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selected >= 0) activateRow(selected, e.ctrlKey);
    }
  }

  const placeholder = mode === "command" ? strings.quickPick.commandPlaceholder : strings.quickPick.filePlaceholder;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-24"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex w-[560px] max-w-[90vw] flex-col overflow-hidden rounded border border-border bg-surface-1 shadow-lg"
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full border-b border-border bg-transparent px-3 py-2 text-sm text-text outline-none"
        />

        {mode === "file" && !activeWorkspaceId ? (
          <div className="p-3 text-xs text-muted">
            {strings.quickPick.noActiveWorkspace}
          </div>
        ) : (
          <div ref={listRef} className="overflow-auto py-1" style={{ maxHeight: `${MAX_VISIBLE_ROWS * ROW_HEIGHT_PX}px` }}>
            {mode === "file" &&
              fileRows.map((row, i) => {
                // MEDIUM fix #7: `row.indices` always refer to the FULL `rel` path
                // (fsQuickOpen/nucleo-matcher) but the first column shows only the file name
                // (`base`) – applied to `base` without an offset they would highlight the wrong
                // characters. `baseNameMatchIndices` offsets them; the second column (full `rel`)
                // is highlighted with its own (unshifted) indices (it was not highlighted before).
                const base = row.rel.split("/").pop() ?? row.rel;
                return (
                  <button
                    key={row.rel}
                    type="button"
                    data-row-index={i}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => openFileRow(row.rel, false)}
                    className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs text-text ${i === selected ? "bg-surface-4" : "bg-transparent"}`}
                  >
                    <span className="shrink-0">
                      <HighlightedText text={base} indices={baseNameMatchIndices(row.rel, base, row.indices)} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-label text-muted">
                      <HighlightedText text={row.rel} indices={row.indices} />
                    </span>
                  </button>
                );
              })}
            {mode === "file" && fileRows.length === 0 && query.trim() !== "" && (
              <div className="px-3 py-2 text-xs text-muted">
                {strings.quickPick.noMatchingFiles}
              </div>
            )}
            {mode === "file" && fileRows.length === 0 && query.trim() === "" && (
              <div className="px-3 py-2 text-xs text-muted">
                {strings.quickPick.openTabsHint}
              </div>
            )}
            {mode === "command" &&
              commandRows.map((row, i) => (
                <button
                  key={row.command.id}
                  type="button"
                  data-row-index={i}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => runCommandRow(row.command)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1 text-left text-xs text-text ${i === selected ? "bg-surface-4" : "bg-transparent"}`}
                >
                  <span className="truncate">
                    <HighlightedText text={commandLabel(row.command)} indices={row.indices} />
                  </span>
                  {row.command.keybinding && (
                    <span className="shrink-0 text-label text-muted">
                      {row.command.keybinding}
                    </span>
                  )}
                </button>
              ))}
            {mode === "command" && commandRows.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted">
                {strings.quickPick.noMatchingCommands}
              </div>
            )}
          </div>
        )}

        {mode === "file" && truncated && (
          <div className="border-t border-border px-3 py-1 text-label text-muted">
            {strings.quickPick.truncatedNotice}
          </div>
        )}
      </div>
    </div>
  );
}
