/**
 * Mission control (M4, DESIGN_SYSTEM §7.8, mockup `MissionControl.dc.html`): every live agent
 * session as a tile with a live terminal preview, filterable by Needs you / Working / Done, with
 * the plan limit strip on top. Sessions come from the hub stream (`hubStore`).
 *
 * Preview: for sessions running in one of our panes, the last 5 non-blank lines of that pane's
 * xterm buffer (`readBufferTail`), read about once a second while this page is mounted and the
 * window is visible. Plain text only; it stays in this component's state (rule 5: never logged
 * or persisted). Sessions outside the app show their pending permission / notification / tool.
 *
 * D-056: "Done" is finished work nobody looked at yet (hub `unseen`). Opening an in-app tile, or
 * clicking an outside session's tile (it has no pane to open), marks it seen; so does
 * "Mark all as seen".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStrings } from "../../app/i18n";
import {
  AgentAvatar,
  Button,
  Card,
  EmptyState,
  Page,
  PageHeader,
  Segmented,
  StatusPill,
  agentDisplayName,
  formatCost,
  formatDuration,
  formatPercent100,
  formatTokenCount,
  secondsSince,
  useNow,
  useStateLabel,
} from "../../app/ui";
import type { SessionDto } from "../../lib/hubTypes";
import type { Agent } from "../../lib/ipc";
import { useAgentStore } from "../../stores/agentStore";
import { markAllSessionsSeen, markSessionSeen, useHubStore } from "../../stores/hubStore";
import { findTabByPaneIdInMap, useTerminalStore } from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { navigateToAgent } from "../agents/navigate";
import { LimitStrip } from "../overview/OverviewPage";
import { readBufferTail } from "../terminal/terminalRegistry";
import {
  PREVIEW_LINES,
  PREVIEW_SCAN_ROWS,
  countGroups,
  fallbackLines,
  filterSessions,
  groupOf,
  hasUnseen,
  lastNonBlankLines,
  liveSessions,
  sameLines,
  sessionKey,
  type FallbackLine,
  type MissionFilter,
} from "./missionLogic";

const PREVIEW_INTERVAL_MS = 1000;

/** Where a session's pane lives in this app (tab id for the preview, workspace for the label). */
interface PaneTarget {
  tabId: string;
  workspaceId: string;
}

/** Workspace route, the session's workspace, its tab, focus the terminal. */
export function goToSession(session: SessionDto): void {
  if (session.unseen) void markSessionSeen(session);
  const paneId = session.paneId;
  if (!paneId) return;
  const known = useAgentStore.getState().agents.find((a) => a.paneId === paneId);
  if (known) {
    navigateToAgent(known);
    return;
  }
  const found = useTerminalStore.getState().findTabByPaneId(paneId);
  if (!found) return;
  const agent: Agent = {
    id: paneId,
    paneId,
    workspaceId: found.workspaceId,
    kind: "other",
    state: "idle",
    sinceMs: 0,
    source: "hook",
    sessionId: session.sessionId,
  };
  navigateToAgent(agent);
}

/**
 * Last lines of each target's xterm buffer, refreshed every second while mounted and the
 * document is visible. State only changes when a preview's text changed.
 */
function usePanePreviews(targets: ReadonlyMap<string, PaneTarget>): Record<string, string[]> {
  const [previews, setPreviews] = useState<Record<string, string[]>>({});
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const targetKey = Array.from(targets, ([key, t]) => `${key}=${t.tabId}`).join("|");

  useEffect(() => {
    const read = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setPreviews((prev) => {
        const next: Record<string, string[]> = {};
        let changed = Object.keys(prev).length !== targetsRef.current.size;
        for (const [key, target] of targetsRef.current) {
          const lines = lastNonBlankLines(readBufferTail(target.tabId, PREVIEW_SCAN_ROWS), PREVIEW_LINES);
          const old = prev[key];
          next[key] = old && sameLines(old, lines) ? old : lines;
          if (next[key] !== old) changed = true;
        }
        return changed ? next : prev;
      });
    };
    read();
    const id = setInterval(read, PREVIEW_INTERVAL_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", read);
    };
  }, [targetKey]);

  return previews;
}

export function MissionControlPage() {
  const s = useStrings();
  const connected = useHubStore((st) => st.connected);
  const sessions = useHubStore((st) => st.sessions);
  const usage = useHubStore((st) => st.usage);
  const limits = useHubStore((st) => st.limits);
  const byWorkspace = useTerminalStore((st) => st.byWorkspace);
  const workspaces = useWorkspaceStore((st) => st.workspaces);
  const [filter, setFilter] = useState<MissionFilter>("all");
  const now = useNow(1000);

  const live = useMemo(() => liveSessions(sessions), [sessions]);
  const counts = countGroups(live);
  const shown = filterSessions(live, filter);

  const targets = useMemo(() => {
    const map = new Map<string, PaneTarget>();
    for (const session of live) {
      if (!session.paneId) continue;
      const found = findTabByPaneIdInMap(byWorkspace, session.paneId);
      if (found) map.set(sessionKey(session), { tabId: found.tab.id, workspaceId: found.workspaceId });
    }
    return map;
  }, [live, byWorkspace]);
  const previews = usePanePreviews(targets);

  const unavailable = !connected && usage === null && sessions.length === 0;
  const options = (["all", "attention", "working", "done"] as const).map((value) => ({
    value,
    label: value === "all" ? s.mission.filters.all : `${s.mission.filters[value]} · ${counts[value]}`,
  }));

  return (
    <Page>
      <PageHeader
        title={s.nav.mission}
        subtitle={unavailable ? undefined : s.mission.summary(counts.all, counts.attention, counts.working, counts.done)}
        actions={
          unavailable ? undefined : (
            <div className="flex flex-wrap items-center gap-2">
              {hasUnseen(live) && (
                <Button variant="ghost" onClick={() => void markAllSessionsSeen()}>
                  {s.mission.markAllSeen}
                </Button>
              )}
              <Segmented options={options} value={filter} onChange={setFilter} ariaLabel={s.mission.filterLabel} />
            </div>
          )
        }
      />

      {unavailable ? (
        <Card>
          <EmptyState title={s.ui.hubUnavailableTitle} body={s.ui.hubUnavailableBody} />
        </Card>
      ) : (
        <>
          <LimitStrip limits={limits} />
          {shown.length > 0 ? (
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
              {shown.map((session) => {
                const key = sessionKey(session);
                const target = targets.get(key);
                const workspace = target ? workspaces.find((w) => w.id === target.workspaceId) : undefined;
                return (
                  <MissionTile
                    key={key}
                    session={session}
                    now={now}
                    inApp={target !== undefined}
                    workspaceName={workspace?.name ?? null}
                    preview={previews[key] ?? []}
                  />
                );
              })}
            </div>
          ) : (
            <Card>
              {live.length === 0 ? (
                <EmptyState title={s.mission.noSessions} body={s.mission.noSessionsBody} />
              ) : (
                <EmptyState title={s.mission.noMatch} />
              )}
            </Card>
          )}
        </>
      )}
    </Page>
  );
}

function MissionTile({
  session,
  now,
  inApp,
  workspaceName,
  preview,
}: {
  session: SessionDto;
  now: number;
  inApp: boolean;
  workspaceName: string | null;
  preview: string[];
}) {
  const s = useStrings();
  const stateLabel = useStateLabel();
  const attention = groupOf(session) === "attention";
  const unseen = session.unseen && session.state === "Idle";
  const since = formatDuration(secondsSince(session.stateSince, now));
  const sub = [agentDisplayName(session.agent), workspaceName ?? session.model].filter(Boolean).join(" · ");
  const fallback = preview.length === 0 ? fallbackLines(session) : [];

  const metaLeft = attention
    ? s.mission.waiting(since)
    : session.contextUsedPercent !== null
      ? s.mission.context(formatPercent100(session.contextUsedPercent))
      : session.currentTool
        ? s.mission.tool(session.currentTool)
        : "";
  // No price for this agent (e.g. Codex): show its tokens, never a made-up cost.
  const metaRight = session.costUsd !== null ? formatCost(session.costUsd) : s.mission.tokens(formatTokenCount(session.tokens));

  const body = (
    <>
      <div className="flex items-center gap-2.5 border-b border-border-subtle px-3.5 py-3">
        <AgentAvatar agent={session.agent} size={30} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold text-text">{session.projectName}</span>
          <span className="truncate text-meta text-muted">{sub}</span>
        </div>
        <StatusPill state={session.state} suffix={since} unseen={unseen} />
      </div>
      {/* Not a live region: a once-a-second terminal echo would flood screen readers. */}
      <div
        data-testid="mission-preview"
        className="flex h-[132px] flex-col justify-end gap-0.5 overflow-hidden bg-terminal px-3.5 py-2.5 font-mono text-meta leading-[1.6]"
      >
        {preview.length > 0 ? (
          preview.map((line, i) => (
            <span key={i} className="truncate whitespace-pre text-text-2">
              {line}
            </span>
          ))
        ) : fallback.length > 0 ? (
          fallback.map((line, i) => <FallbackRow key={i} line={line} />)
        ) : (
          <span className="text-muted">{s.mission.noOutput}</span>
        )}
      </div>
      <div className="flex items-center gap-2 px-3.5 py-2.5 text-meta">
        <span className="min-w-0 flex-1 truncate text-muted">
          {[metaLeft, session.activeSubagents > 0 ? s.mission.subagents(session.activeSubagents) : "", inApp ? "" : s.mission.outsideApp]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span className="font-mono text-text-2">{metaRight}</span>
      </div>
    </>
  );

  const cls = `flex flex-col overflow-hidden rounded-sheet bg-surface-2 text-left ${
    attention ? "border border-blocked/50 shadow-[var(--halo-blocked)]" : "border border-border-subtle"
  }`;
  const label = unseen ? s.status.done : stateLabel(session.state);
  const button = `${cls} cursor-pointer hover:bg-surface-4 focus-visible:outline-2 focus-visible:outline-accent`;
  return inApp ? (
    <button type="button" aria-label={`${session.projectName} · ${sub} · ${label} ${since}`} className={button} onClick={() => goToSession(session)}>
      {body}
    </button>
  ) : unseen ? (
    // No pane to open: the click only acknowledges the finished work.
    <button
      type="button"
      aria-label={`${session.projectName} · ${sub} · ${label} ${since} · ${s.mission.markSeen}`}
      title={s.mission.markSeen}
      className={button}
      onClick={() => void markSessionSeen(session)}
    >
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function FallbackRow({ line }: { line: FallbackLine }) {
  const s = useStrings();
  switch (line.kind) {
    case "permission":
      return (
        <>
          <span className="truncate text-blocked-ink">{s.mission.permission(line.tool)}</span>
          {line.target && <span className="truncate whitespace-pre text-text-2">{line.target}</span>}
        </>
      );
    case "notification":
      return <span className="line-clamp-2 text-text-2">{line.text}</span>;
    case "tool":
      return <span className="truncate text-working-ink">{s.mission.tool(line.tool)}</span>;
  }
}
