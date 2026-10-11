/**
 * Viewer panel (faz3-spec §2, §5 binding revision). Tab strip + the active tab's renderer; the
 * document lifecycle (`documentStore.load`/`release`) is managed **here** — a document loads
 * when a tab opens it and is dropped from memory when the last tab showing it closes (§5.5).
 */
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { PanelHeader } from "../../app/PanelHeader";
import { strings, useStrings } from "../../app/strings";
import { registerCommand } from "../../app/commands";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useViewerStore, type ViewerMode, type ViewerTab } from "../../stores/viewerStore";
import { docKey, useDocument, useDocumentStore } from "../../stores/documentStore";
import { useToastStore } from "../../stores/toastStore";
import { getRenderer, type RenderKind } from "./getRenderer";
import { ViewerTabStrip } from "./ViewerTabStrip";
import { ExternalChangeBanner } from "./ExternalChangeBanner";
import { UnsavedChangesModal } from "./UnsavedChangesModal";
import { TextEditor } from "./renderers/TextEditor";
import { diffLoadedTabs, type LoadedTabEntry } from "./documentLifecycle";

// Heavy renderers (react-markdown/highlight.js, pdfjs) live in separate chunks to keep the initial bundle small.
const MarkdownView = lazy(() => import("./renderers/MarkdownView").then((m) => ({ default: m.MarkdownView })));
const HtmlView = lazy(() => import("./renderers/HtmlView").then((m) => ({ default: m.HtmlView })));
const ImageView = lazy(() => import("./renderers/ImageView").then((m) => ({ default: m.ImageView })));
const PdfView = lazy(() => import("./renderers/PdfView").then((m) => ({ default: m.PdfView })));
const DiffView = lazy(() => import("./renderers/DiffView").then((m) => ({ default: m.DiffView })));
import { UnsupportedView } from "./renderers/UnsupportedView";

const TEXTUAL_KINDS = new Set<RenderKind>(["text", "markdown", "html", "svg"]);

interface PendingClose {
  workspaceId: string;
  tabId: string;
  rel: string;
}

/**
 * `load` when a tab opens, `release` when it closes — for tabs in **all** workspaces, not just the
 * active one. Otherwise switching away from a workspace would silently drop its dirty (unsaved)
 * documents from memory (data loss); `release` must only run when the tab itself closes.
 */
function useDocumentLifecycle(byWorkspace: Record<string, { tabs: ViewerTab[] }>) {
  // finding #4: keyed by tab.id (not docKey) — see the `documentLifecycle.ts` header. A retarget
  // keeps the same tabId with a different `rel`; `diffLoadedTabs` classifies that as "neither
  // load nor release" (the refcount was already moved by `rekeyDocsForRetarget`) — otherwise a
  // retarget followed by a tab close would leave the refcount one too high (leak).
  const loadedRef = useRef<Map<string, LoadedTabEntry>>(new Map());

  useEffect(() => {
    const { load, release } = useDocumentStore.getState();
    const current = new Map<string, LoadedTabEntry>();
    for (const [workspaceId, ws] of Object.entries(byWorkspace)) {
      for (const tab of ws.tabs) {
        if (!tab.diff && TEXTUAL_KINDS.has(getRenderer(tab.rel))) {
          current.set(tab.id, { workspaceId, rel: tab.rel });
        }
      }
    }

    const { toLoad, toRelease } = diffLoadedTabs(loadedRef.current, current);
    for (const entry of toLoad) void load(entry.workspaceId, entry.rel);
    for (const entry of toRelease) release(entry.workspaceId, entry.rel);
    loadedRef.current = current;
  }, [byWorkspace]);

  useEffect(() => {
    return () => {
      const { release } = useDocumentStore.getState();
      for (const entry of loadedRef.current.values()) release(entry.workspaceId, entry.rel);
      loadedRef.current = new Map();
    };
  }, []);
}

function renderActiveTab(workspaceId: string, tab: ViewerTab) {
  const kind = getRenderer(tab.rel);
  // finding #7: `key={tab.id}` — tab.id survives even a permanent rename (retarget, see
  // `documentLifecycle.ts`), so a full remount happens only when the *tab* changes. Renderer
  // state (HtmlView "Enable scripts", ImageView zoom, PdfView search) does not leak between
  // tabs, while re-renders of the same tab (retarget included) don't remount Monaco.
  return (
    <Suspense key={tab.id} fallback={null}>
      <ActiveTabBody workspaceId={workspaceId} tab={tab} kind={kind} />
    </Suspense>
  );
}

/** Falls back to Unsupported on `doc.status==="error" && error.code==="binary_file"`, whatever the extension. */
function ActiveTabBody({ workspaceId, tab, kind }: { workspaceId: string; tab: ViewerTab; kind: RenderKind }) {
  const needsDoc = TEXTUAL_KINDS.has(kind);
  const doc = useDocument(workspaceId, tab.rel);

  if (tab.diff) return <DiffView workspaceId={workspaceId} rel={tab.rel} />;
  if (needsDoc && doc?.status === "error" && doc.error?.code === "binary_file") {
    return <UnsupportedView workspaceId={workspaceId} rel={tab.rel} />;
  }

  switch (kind) {
    case "text":
      return <TextEditor workspaceId={workspaceId} rel={tab.rel} />;
    case "markdown":
      return <MarkdownView workspaceId={workspaceId} rel={tab.rel} mode={tab.mode ?? "preview"} />;
    case "html":
      return <HtmlView workspaceId={workspaceId} rel={tab.rel} mode={tab.mode ?? "preview"} />;
    case "svg":
      return <ImageView workspaceId={workspaceId} rel={tab.rel} mode={tab.mode ?? "preview"} />;
    case "image":
      return <ImageView workspaceId={workspaceId} rel={tab.rel} />;
    case "pdf":
      return <PdfView workspaceId={workspaceId} rel={tab.rel} />;
    default:
      return <UnsupportedView workspaceId={workspaceId} rel={tab.rel} />;
  }
}

function cycleTab(direction: 1 | -1) {
  const workspaceId = useWorkspaceStore.getState().activeId;
  if (!workspaceId) return;
  const ws = useViewerStore.getState().byWorkspace[workspaceId];
  if (!ws || ws.tabs.length === 0) return;
  const idx = ws.tabs.findIndex((t) => t.id === ws.activeTabId);
  const nextIdx = ((idx === -1 ? 0 : idx) + direction + ws.tabs.length) % ws.tabs.length;
  const next = ws.tabs[nextIdx];
  if (next) useViewerStore.getState().activate(workspaceId, next.id);
}

function toggleMarkdownMode() {
  const workspaceId = useWorkspaceStore.getState().activeId;
  if (!workspaceId) return;
  const ws = useViewerStore.getState().byWorkspace[workspaceId];
  const tab = ws?.tabs.find((t) => t.id === ws.activeTabId);
  if (!tab || tab.diff || getRenderer(tab.rel) !== "markdown") return;
  const next: ViewerMode = tab.mode === "edit" ? "preview" : "edit";
  useViewerStore.getState().setMode(workspaceId, tab.id, next);
}

async function saveActiveTab() {
  const workspaceId = useWorkspaceStore.getState().activeId;
  if (!workspaceId) return;
  const ws = useViewerStore.getState().byWorkspace[workspaceId];
  const tab = ws?.tabs.find((t) => t.id === ws.activeTabId);
  if (!tab || tab.diff) return;

  const doc = useDocumentStore.getState().docs[docKey(workspaceId, tab.rel)];
  if (doc?.readOnly) {
    // finding #2: a read-only document can't become dirty in Monaco, but Ctrl+S can still
    // arrive (e.g. focus outside Monaco) — `documentStore.save` is a silent no-op, so tell
    // the user why here.
    useToastStore.getState().show(strings.viewer.readOnlySaveToast);
    return;
  }
  if (doc?.external) {
    // finding #9: saving again before the banner is resolved only repeats the same conflict —
    // point the user at the banner instead of swallowing it.
    useToastStore.getState().show(strings.viewer.conflictSaveToast);
    return;
  }

  const err = await useDocumentStore.getState().save(workspaceId, tab.rel);
  if (!err) return;
  if (err.code === "conflict") {
    useToastStore.getState().show(strings.viewer.conflictSaveToast);
    return;
  }
  useToastStore.getState().show(strings.errors.forCode(err.code));
}

export function ViewerPanel() {
  const strings = useStrings();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeId);
  const viewerReady = useViewerStore((s) => s.ready);
  const initViewer = useViewerStore((s) => s.init);
  const byWorkspace = useViewerStore((s) => s.byWorkspace);
  const wsViewer = activeWorkspaceId ? byWorkspace[activeWorkspaceId] : undefined;
  const tabs = wsViewer?.tabs ?? [];
  const activeTab = tabs.find((t) => t.id === wsViewer?.activeTabId);
  const activeDoc = useDocument(activeWorkspaceId ?? "", activeTab?.rel ?? "");

  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);

  useEffect(() => {
    void initViewer();
  }, [initViewer]);

  useDocumentLifecycle(byWorkspace);

  // Starting to edit turns a preview tab into a pinned tab (faz3-spec §2).
  useEffect(() => {
    if (!activeWorkspaceId || !activeTab || !activeDoc) return;
    if (activeDoc.status === "ready" && activeDoc.dirty && !activeTab.pinned) {
      useViewerStore.getState().pin(activeWorkspaceId, activeTab.id);
    }
  }, [activeWorkspaceId, activeTab, activeDoc]);

  useEffect(() => {
    const unregisterFns = [
      registerCommand({ id: "viewer.save", title: () => strings.commandTitles.viewerSave, category: () => strings.commandCategories.viewer, keybinding: "Ctrl+S", scope: "notTerminal", run: () => void saveActiveTab() }),
      registerCommand({
        id: "viewer.closeActiveTab",
        title: () => strings.commandTitles.viewerCloseTab,
        category: () => strings.commandCategories.viewer,
        keybinding: "Ctrl+W",
        scope: "notTerminal",
        run: () => {
          const workspaceId = useWorkspaceStore.getState().activeId;
          const ws = workspaceId ? useViewerStore.getState().byWorkspace[workspaceId] : undefined;
          if (workspaceId && ws?.activeTabId) requestCloseTab(workspaceId, ws.activeTabId, setPendingClose);
        },
      }),
      registerCommand({ id: "viewer.nextTab", title: () => strings.commandTitles.viewerNextTab, category: () => strings.commandCategories.viewer, keybinding: "Ctrl+Tab", run: () => cycleTab(1) }),
      registerCommand({
        id: "viewer.prevTab",
        title: () => strings.commandTitles.viewerPrevTab,
        category: () => strings.commandCategories.viewer,
        keybinding: "Ctrl+Shift+Tab",
        run: () => cycleTab(-1),
      }),
      registerCommand({
        id: "viewer.toggleMarkdownMode",
        title: () => strings.commandTitles.viewerToggleMarkdownMode,
        category: () => strings.commandCategories.viewer,
        keybinding: "Ctrl+Shift+M",
        scope: "notTerminal",
        run: toggleMarkdownMode,
      }),
    ];
    return () => unregisterFns.forEach((unregister) => unregister());
  }, []);

  if (!viewerReady) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title={strings.panels.viewer} />
      </div>
    );
  }

  if (!activeWorkspaceId) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title={strings.panels.viewer} />
        <div className="flex-1 overflow-auto p-3 text-xs text-muted">
          {strings.viewer.noWorkspace}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={strings.panels.viewer} />
      {tabs.length === 0 ? (
        <div className="flex-1 overflow-auto p-3 text-xs text-muted">
          {strings.viewer.noTabs}
        </div>
      ) : (
        <>
          <ViewerTabStrip
            workspaceId={activeWorkspaceId}
            tabs={tabs}
            activeTabId={wsViewer?.activeTabId ?? null}
            onActivate={(tabId) => useViewerStore.getState().activate(activeWorkspaceId, tabId)}
            onRequestClose={(tabId) => requestCloseTab(activeWorkspaceId, tabId, setPendingClose)}
            onSetMode={(tabId, mode) => useViewerStore.getState().setMode(activeWorkspaceId, tabId, mode)}
          />
          {activeTab && !activeTab.diff && TEXTUAL_KINDS.has(getRenderer(activeTab.rel)) && (
            <ExternalChangeBanner workspaceId={activeWorkspaceId} rel={activeTab.rel} />
          )}
          <div className="min-h-0 flex-1">{activeTab && renderActiveTab(activeWorkspaceId, activeTab)}</div>
        </>
      )}

      {pendingClose && (
        <UnsavedChangesModal
          title={strings.viewer.unsavedModal.title(pendingClose.rel.split("/").pop() ?? pendingClose.rel)}
          saveLabel={strings.viewer.unsavedModal.save}
          discardLabel={strings.viewer.unsavedModal.dontSave}
          onCancel={() => setPendingClose(null)}
          onDiscard={() => {
            useViewerStore.getState().closeTab(pendingClose.workspaceId, pendingClose.tabId);
            setPendingClose(null);
          }}
          onSave={() => {
            void useDocumentStore.getState().save(pendingClose.workspaceId, pendingClose.rel).then((err) => {
              if (err) {
                // Save failed (conflict included) — the tab stays open; on a conflict `save()`
                // already set `doc.external`, so the banner shows on the still-open tab.
                useToastStore.getState().show(strings.errors.forCode(err.code));
                setPendingClose(null);
                return;
              }
              useViewerStore.getState().closeTab(pendingClose.workspaceId, pendingClose.tabId);
              setPendingClose(null);
            });
          }}
        />
      )}
    </div>
  );
}

function requestCloseTab(workspaceId: string, tabId: string, setPendingClose: (p: PendingClose | null) => void) {
  const ws = useViewerStore.getState().byWorkspace[workspaceId];
  const tab = ws?.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const dirty = !tab.diff && (useDocumentStore.getState().docs[docKey(workspaceId, tab.rel)]?.dirty ?? false);
  if (!dirty) {
    useViewerStore.getState().closeTab(workspaceId, tabId);
    return;
  }
  setPendingClose({ workspaceId, tabId, rel: tab.rel });
}
