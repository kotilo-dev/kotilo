import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { HeaderButton } from "../../app/HeaderButton";
import { useStrings } from "../../app/strings";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useViewerStore } from "../../stores/viewerStore";
import { useAgentStore } from "../../stores/agentStore";
import { effectivePanelTab, useWorkspacePanelStore, type PanelTab } from "../../stores/workspacePanelStore";
import type { QuickOpenItem } from "../../lib/ipc";
import { openAddWorkspaceDialog } from "./addWorkspaceDialog";
import { Tree, type TreeHandle } from "./Tree";
import { WorkspaceList } from "./WorkspaceList";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { blockedElsewhereCount } from "./panelLogic";

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

function TabButton({
  tab,
  current,
  disabled,
  onSelect,
  children,
}: {
  tab: PanelTab;
  current: PanelTab;
  disabled?: boolean;
  onSelect: (tab: PanelTab) => void;
  children: React.ReactNode;
}) {
  const selected = tab === current;
  return (
    <button
      type="button"
      role="tab"
      id={`workspace-panel-tab-${tab}`}
      aria-selected={selected}
      aria-controls="workspace-panel-body"
      disabled={disabled}
      onClick={() => onSelect(tab)}
      className={`flex min-w-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-2 text-label font-semibold disabled:cursor-default disabled:opacity-40 ${
        selected ? "border-accent text-text" : "border-transparent text-muted hover:text-text-2"
      }`}
    >
      {children}
    </button>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-text-3 hover:bg-surface-4 hover:text-text disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
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
  const agents = useAgentStore((s) => s.agents);
  const userTab = useWorkspacePanelStore((s) => s.tab);
  const setTab = useWorkspacePanelStore((s) => s.setTab);

  const activeWorkspace = workspaces.find((w) => w.id === activeId) ?? null;
  const tab = effectivePanelTab(userTab, activeWorkspace !== null);
  const alertCount = useMemo(() => blockedElsewhereCount(agents, workspaces, activeId), [agents, workspaces, activeId]);

  const [filter, setFilter] = useState("");
  const treeRef = useRef<TreeHandle>(null);

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

  function renderBody() {
    if (!ready) {
      return <div className="flex-1 overflow-auto p-3 text-xs text-muted">{strings.loading}</div>;
    }
    if (workspaces.length === 0) {
      return <div className="flex-1 overflow-auto p-3 text-xs text-muted">{strings.empty.workspaces}</div>;
    }
    if (tab === "workspaces" || !activeWorkspace) return <WorkspaceList />;
    return (
      <>
        <div className="flex shrink-0 flex-col gap-2 border-b border-border-subtle px-2.5 py-2">
          <div className="flex min-w-0 items-center gap-1">
            <WorkspaceSwitcher workspace={activeWorkspace} />
            <IconButton
              label={strings.workspaces.newFileTooltip}
              disabled={trimmedFilter !== ""}
              onClick={() => treeRef.current?.startCreateAtSelection("file")}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 2h5l3 3v9H4z" />
                <path d="M8 7.5v4M6 9.5h4" />
              </svg>
            </IconButton>
            <IconButton
              label={strings.workspaces.newFolderTooltip}
              disabled={trimmedFilter !== ""}
              onClick={() => treeRef.current?.startCreateAtSelection("dir")}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
                <path d="M8 7v4M6 9h4" />
              </svg>
            </IconButton>
          </div>
          <label className="flex h-[26px] items-center gap-1.5 rounded-sm border border-border bg-bg px-2 text-muted focus-within:border-accent">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5 14 14" />
            </svg>
            <input
              ref={filterRef}
              type="text"
              aria-label={strings.workspaces.filterLabel}
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
              placeholder={strings.workspaces.filterPlaceholder}
              className="min-w-0 flex-1 border-0 bg-transparent text-small text-text outline-none"
            />
          </label>
        </div>
        {searchWorkspaceId && trimmedFilter !== "" ? (
          <SearchResults workspaceId={searchWorkspaceId} query={trimmedFilter} onOpen={(rel) => void openSearchHit(rel)} />
        ) : (
          <Tree ref={treeRef} />
        )}
      </>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="flex h-[34px] shrink-0 items-stretch justify-between border-b border-border bg-surface-3 pl-1 pr-2 uppercase">
        <div role="tablist" data-testid="workspace-panel-tabs" aria-label={strings.workspaces.tabsLabel} className="flex min-w-0 items-stretch">
          <TabButton tab="workspaces" current={tab} onSelect={setTab}>
            <span className="truncate">{strings.panels.workspaces}</span>
            {alertCount > 0 && (
              <span
                data-testid="workspaces-alert-badge"
                title={strings.workspaces.alertBadge(alertCount)}
                aria-label={strings.workspaces.alertBadge(alertCount)}
                className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-blocked px-1 text-label font-semibold leading-none tracking-normal text-on-accent"
              >
                {alertCount}
              </span>
            )}
          </TabButton>
          <TabButton tab="files" current={tab} disabled={activeWorkspace === null} onSelect={setTab}>
            {strings.panels.files}
          </TabButton>
        </div>
        <div className="flex items-center">
          <HeaderButton
            aria-label={strings.workspaces.addTooltip}
            title={strings.workspaces.addTooltip}
            onClick={() => void handleAddClick()}
          >
            +
          </HeaderButton>
        </div>
      </div>
      <div id="workspace-panel-body" role="tabpanel" aria-labelledby={`workspace-panel-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
        {renderBody()}
      </div>
    </div>
  );
}
