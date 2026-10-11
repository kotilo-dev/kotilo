import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { HeaderButton } from "../../app/HeaderButton";
import { PanelHeader } from "../../app/PanelHeader";
import { useStrings } from "../../app/strings";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useViewerStore } from "../../stores/viewerStore";
import type { QuickOpenItem } from "../../lib/ipc";
import { openAddWorkspaceDialog } from "./addWorkspaceDialog";
import { Tree } from "./Tree";

const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_LIMIT = 50;

function SearchResults({ workspaceId, query, onOpen }: { workspaceId: string; query: string; onOpen: (rel: string) => void }) {
  const strings = useStrings();
  const search = useWorkspaceStore((s) => s.search);
  const [hits, setHits] = useState<QuickOpenItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHits(null);
    const timer = setTimeout(() => {
      void search(workspaceId, query, SEARCH_LIMIT).then((result) => {
        if (!cancelled) setHits(result);
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workspaceId, query, search]);

  if (hits === null) {
    return (
      <div className="p-2 text-xs text-muted">
        {strings.workspaces.searching}
      </div>
    );
  }
  if (hits.length === 0) {
    return (
      <div className="p-2 text-xs text-muted">
        {strings.workspaces.searchNoResults}
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-auto text-xs">
      {hits.map((hit) => (
        <button
          key={hit.rel}
          type="button"
          onClick={() => onOpen(hit.rel)}
          className="block w-full truncate px-2 py-1 text-left hover:bg-surface-4"
          title={hit.rel}
        >
          {hit.rel}
        </button>
      ))}
    </div>
  );
}

export function WorkspacesPanel() {
  const strings = useStrings();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const ready = useWorkspaceStore((s) => s.ready);
  const init = useWorkspaceStore((s) => s.init);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const expandAncestors = useWorkspaceStore((s) => s.expandAncestors);
  const select = useWorkspaceStore((s) => s.select);
  const openFile = useViewerStore((s) => s.openFile);

  const [filter, setFilter] = useState("");

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Folder drag and drop (SPEC D17, faz2-spec §6): paths dropped anywhere on the window are
  // added as workspaces; non-folders are skipped silently.
  useEffect(() => {
    // Cancelled-flag pattern (finding #3): under React StrictMode the cleanup for this
    // effect's *first* mount runs before `onDragDropEvent`'s promise resolves, so
    // `unlisten` is still `undefined` when that cleanup fires — the first listener never
    // gets torn down, and the second mount registers another one, so every dropped
    // folder is added twice. `cancelled` lets the resolved promise tear itself down
    // immediately if the effect was already cleaned up by then.
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type !== "drop") return;
        for (const path of e.payload.paths) {
          void addWorkspace(path, { silentIfNotDirectory: true });
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAddClick() {
    await openAddWorkspaceDialog();
  }

  const filterRef = useRef<HTMLInputElement>(null);
  const trimmedFilter = filter.trim();
  const searchWorkspaceId = trimmedFilter !== "" ? activeId : null;

  async function openSearchHit(rel: string) {
    if (!searchWorkspaceId) return;
    await expandAncestors(searchWorkspaceId, rel);
    select(searchWorkspaceId, rel);
    openFile(searchWorkspaceId, rel, { pinned: false });
    setFilter("");
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={strings.panels.workspaces}
        actions={
          <div className="flex items-center gap-1">
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  e.preventDefault();
                  setFilter("");
                  filterRef.current?.blur();
                }
              }}
              disabled={!activeId}
              placeholder={strings.workspaces.filterPlaceholder}
              className="w-28 rounded-sm border border-border bg-bg px-1 py-0.5 text-label leading-none text-text disabled:opacity-40"
            />
            <HeaderButton title={strings.workspaces.addTooltip} onClick={() => void handleAddClick()}>
              +
            </HeaderButton>
          </div>
        }
      />
      {!ready ? (
        <div className="flex-1 overflow-auto p-3 text-xs text-muted">
          {strings.loading}
        </div>
      ) : workspaces.length === 0 && trimmedFilter === "" ? (
        <div className="flex-1 overflow-auto p-3 text-xs text-muted">
          {strings.empty.workspaces}
        </div>
      ) : searchWorkspaceId && trimmedFilter !== "" ? (
        <SearchResults workspaceId={searchWorkspaceId} query={trimmedFilter} onOpen={(rel) => void openSearchHit(rel)} />
      ) : (
        <Tree />
      )}
    </div>
  );
}
