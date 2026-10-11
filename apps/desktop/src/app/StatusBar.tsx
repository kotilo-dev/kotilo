import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStrings } from "./strings";
import { useHelpStore } from "../features/help/helpStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useViewerStore } from "../stores/viewerStore";
import { useDocument } from "../stores/documentStore";
import { useAgentStore } from "../stores/agentStore";
import { countsByState } from "../features/agents/agentLogic";
import { gitHead, type GitHead } from "../lib/ipc";
import { PaneStatusDot } from "../features/workspace/PaneStatus";
import { visualStateForAgent } from "../features/workspace/paneSession";

const GIT_HEAD_POLL_MS = 5000;

/**
 * Git branch/detached SHA (faz6-spec §6). Refreshed immediately when the active workspace
 * changes or the window gains focus, and every 5 s while focused; polling stops while unfocused.
 * Shows nothing without a repo (`null`).
 */
function GitBranch({ workspaceId }: { workspaceId: string }) {
  const [head, setHead] = useState<GitHead | null>(null);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    async function refresh() {
      try {
        const result = await gitHead(workspaceId);
        if (!cancelled) setHead(result);
      } catch {
        if (!cancelled) setHead(null);
      }
    }

    function startPolling() {
      if (interval) return;
      interval = setInterval(() => void refresh(), GIT_HEAD_POLL_MS);
    }
    function stopPolling() {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    }

    void refresh();

    let unlistenFocus: (() => void) | undefined;
    const win = getCurrentWindow();
    void win.isFocused().then((focused) => {
      if (!cancelled && focused) startPolling();
    });
    void win
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          void refresh();
          startPolling();
        } else {
          stopPolling();
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenFocus = fn;
      });

    return () => {
      cancelled = true;
      stopPolling();
      unlistenFocus?.();
    };
  }, [workspaceId]);

  if (!head) return null;
  return <span> {head.kind === "branch" ? head.name : head.sha}</span>;
}

/**
 * Agent summary counter (faz5-spec §2.3): status dot + count per state (M2: token-coloured dot
 * instead of an emoji, DESIGN_SYSTEM §5/§6). Zero counts are hidden; the whole section is hidden
 * without agents (idle is not counted in the status bar, SPEC §4.2). The status bar itself shows
 * the active workspace name and the active text document's encoding/EOL (faz3-spec §2, display only).
 */
function AgentSummary() {
  const agents = useAgentStore((s) => s.agents);
  if (agents.length === 0) return null;
  const counts = countsByState(agents);
  const parts = (["blocked", "working", "done"] as const).filter((state) => counts[state] > 0);
  if (parts.length === 0) return null;
  return (
    <span className="flex items-center gap-3">
      {parts.map((state) => (
        <span key={state} className="flex items-center gap-1">
          <PaneStatusDot state={visualStateForAgent(state)} />
          <span className="font-mono">{counts[state]}</span>
        </span>
      ))}
    </span>
  );
}

export function StatusBar() {
  const strings = useStrings();
  const activeId = useWorkspaceStore((s) => s.activeId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const active = activeId ? workspaces.find((w) => w.id === activeId) : undefined;

  const wsViewer = useViewerStore((s) => (activeId ? s.byWorkspace[activeId] : undefined));
  const activeTab = wsViewer?.tabs.find((t) => t.id === wsViewer.activeTabId);
  const doc = useDocument(activeId ?? "", activeTab?.rel ?? "");
  const showEncoding = doc?.status === "ready";

  return (
    <div
      className="flex h-6 shrink-0 items-center justify-between border-t border-border bg-surface-3 px-2 text-label text-muted"
    >
      <span>
        {active ? active.name : strings.statusBar.noActiveWorkspace}
        {active && <GitBranch workspaceId={active.id} />}
      </span>
      <div className="flex items-center gap-3">
        {showEncoding && doc && (
          <span>
            {strings.viewer.encoding[doc.encoding]} · {strings.viewer.eol[doc.eol]}
          </span>
        )}
        <AgentSummary />
        <button
          type="button"
          aria-label={strings.help.statusBarButtonLabel}
          title={strings.help.statusBarButtonLabel}
          onClick={() => useHelpStore.getState().openHelp()}
          className="px-1 text-muted"
        >
          ?
        </button>
      </div>
    </div>
  );
}
