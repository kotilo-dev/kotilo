/**
 * M4 workspace timeline rail (DESIGN_SYSTEM §7.7, mockup Main.dc.html right rail): the plan,
 * the tool activity and the changed files of the session in the active terminal tab. Lives to
 * the right of the workspace columns; visibility and width are part of the `layout` slice.
 * Rule 5: activity and diffs only live in memory.
 */
import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { registerCommand } from "../../app/commands";
import { strings as liveStrings, useStrings } from "../../app/strings";
import { AgentAvatar } from "../../app/ui/AgentAvatar";
import { agentDisplayName } from "../../app/ui/agents";
import { formatClock, formatDuration, NO_VALUE, secondsSince } from "../../app/ui/format";
import { useNow } from "../../app/ui/useNow";
import type { ActivityEntry, ActivityPlan, ActivityToolEntry, SessionDto } from "../../lib/hubTypes";
import type { GitChangedFile } from "../../lib/ipc";
import { useAgentStore } from "../../stores/agentStore";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { useHubStore } from "../../stores/hubStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useRouteStore } from "../../stores/routeStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useViewerStore } from "../../stores/viewerStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActivityStore } from "./activityStore";
import { useChangesStore } from "./changesStore";
import {
  baseNameOf,
  dirNameOf,
  formatToolDuration,
  groupChangedFiles,
  isToolEntry,
  newestFirst,
  planProgress,
  selectTimelineSession,
  sessionKey,
  toolLetter,
  toolTone,
  touchedPaths,
  type ToolTone,
} from "./timelineLogic";

const RESIZE_STEP_PX = 16;

/** Palette command; the rail registers it while mounted. */
function useTimelineCommand() {
  useEffect(
    () =>
      registerCommand({
        id: "view.toggleTimeline",
        title: () => liveStrings.timeline.commandToggle,
        category: () => liveStrings.commandCategories.view,
        run: () => useLayoutStore.getState().toggleTimeline(),
      }),
    [],
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
      <path d={direction === "left" ? "M10 10l-2 2 2 2" : "M8 10l2 2-2 2"} />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" />
      <path d="M4 3v5h5" />
      <path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" />
      <path d="M20 21v-5h-5" />
    </svg>
  );
}

const SECTION_LABEL = "text-label font-semibold uppercase tracking-[0.08em] text-faint";

export function TimelineRail() {
  const strings = useStrings();
  const visible = useLayoutStore((s) => s.layout.timelineVisible);
  const width = useLayoutStore((s) => s.layout.timelineWidth);
  useTimelineCommand();

  if (!visible) {
    return (
      <div className="flex h-full w-7 shrink-0 flex-col items-center border-l border-border bg-surface-1 pt-1.5">
        <button
          type="button"
          aria-label={strings.timeline.show}
          title={strings.timeline.show}
          onClick={() => useLayoutStore.getState().toggleTimeline()}
          className="flex size-6 items-center justify-center rounded-control text-muted hover:bg-surface-4 hover:text-text"
        >
          <ChevronIcon direction="left" />
        </button>
      </div>
    );
  }

  return (
    <aside
      aria-label={strings.timeline.region}
      data-testid="timeline-rail"
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-surface-1"
      style={{ width }}
    >
      <ResizeHandle width={width} />
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-surface-3 pl-3 pr-1.5 text-xs font-semibold tracking-wide text-muted">
        <span>{strings.timeline.title.toUpperCase()}</span>
        <button
          type="button"
          aria-label={strings.timeline.hide}
          title={strings.timeline.hide}
          onClick={() => useLayoutStore.getState().toggleTimeline()}
          className="flex size-6 items-center justify-center rounded-control text-muted hover:bg-surface-4 hover:text-text"
        >
          <ChevronIcon direction="right" />
        </button>
      </div>
      <TimelineBody />
    </aside>
  );
}

function ResizeHandle({ width }: { width: number }) {
  const strings = useStrings();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const setWidth = useLayoutStore((s) => s.setTimelineWidth);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={strings.timeline.resize}
      aria-valuenow={width}
      tabIndex={0}
      className="absolute inset-y-0 -left-0.5 z-10 w-[5px] cursor-col-resize transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        if (drag.current) setWidth(drag.current.width + (drag.current.x - e.clientX));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "ArrowLeft") setWidth(width + RESIZE_STEP_PX);
        else if (e.key === "ArrowRight") setWidth(width - RESIZE_STEP_PX);
        else return;
        e.preventDefault();
      }}
    />
  );
}

/** Pane id of the active workspace's active terminal tab. */
function useActivePaneId(workspaceId: string | null): string | null {
  return useTerminalStore((s) => {
    const ws = workspaceId ? s.byWorkspace[workspaceId] : undefined;
    if (!ws) return null;
    // While split, follow the half that last had focus.
    const tabId = ws.splitTabId && ws.focusedTabId === ws.splitTabId ? ws.splitTabId : ws.activeTabId;
    return ws.tabs.find((t) => t.id === tabId)?.paneId ?? null;
  });
}

function TimelineBody() {
  const strings = useStrings();
  const workspaceId = useWorkspaceStore((s) => s.activeId);
  const workspacePath = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeId)?.path ?? null);
  const onWorkspaceRoute = useRouteStore((s) => s.route === "workspace");
  const activePaneId = useActivePaneId(workspaceId);
  const sessions = useHubStore((s) => s.sessions);
  const agents = useAgentStore((s) => s.agents);
  const session = useMemo(
    () => selectTimelineSession(sessions, agents, activePaneId, workspacePath),
    [sessions, agents, activePaneId, workspacePath],
  );
  const key = session ? sessionKey({ agent: session.agent, sessionId: session.sessionId }) : null;
  const activity = useActivityStore((s) => (key ? s.bySession[key] : undefined));

  useEffect(() => {
    if (session) void useActivityStore.getState().ensure({ agent: session.agent, sessionId: session.sessionId });
    // Only the identity matters, not every session update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (!workspaceId || !onWorkspaceRoute) return;
    return useChangesStore.getState().watch(workspaceId);
  }, [workspaceId, onWorkspaceRoute]);

  if (!workspaceId) return <div className="p-3 text-xs text-muted">{strings.timeline.noWorkspace}</div>;

  const entries = activity?.entries ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-3.5 py-3">
      <SessionLine session={session} />
      {activity?.plan && <PlanSection plan={activity.plan} />}
      {session && <ActivitySection entries={entries} loading={activity?.status !== "ready"} />}
      <ChangedFilesSection
        workspaceId={workspaceId}
        workspacePath={workspacePath ?? ""}
        projectRoot={session?.projectRoot ?? null}
        entries={entries}
      />
    </div>
  );
}

function SessionLine({ session }: { session: SessionDto | null }) {
  const strings = useStrings();
  const definitions = useDefinitionsStore((s) => s.definitions);
  if (!session) return <div className="text-xs text-muted">{strings.timeline.noSession}</div>;
  return (
    <div className="flex min-w-0 items-center gap-2 text-small text-text-3">
      <AgentAvatar agent={session.agent} size={24} />
      <span className="truncate">{strings.timeline.session(agentDisplayName(session.agent, definitions), session.projectName)}</span>
    </div>
  );
}

function PlanSection({ plan }: { plan: ActivityPlan }) {
  const strings = useStrings();
  const progress = planProgress(plan);
  if (!progress) return null;
  return (
    <section className="flex flex-col gap-2.5" aria-label={strings.timeline.plan}>
      <div className="flex items-center justify-between">
        <span className={SECTION_LABEL}>{strings.timeline.plan}</span>
        <span className="text-meta text-text-3">{strings.timeline.planProgress(progress.done, progress.total)}</span>
      </div>
      <div className="h-1 rounded-sm bg-track" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-sm bg-idle" style={{ width: `${progress.percent}%` }} />
      </div>
      <ul className="flex flex-col gap-2">
        {plan.items.map((item, i) => (
          <li key={i} className="flex items-start gap-2.5 text-body" title={strings.timeline.planStatus[item.status]}>
            <span
              aria-hidden="true"
              className={`mt-0.5 size-3.5 shrink-0 rounded-badge ${
                item.status === "completed"
                  ? "bg-idle"
                  : item.status === "in_progress"
                    ? "border-2 border-working"
                    : "border-[1.5px] border-faint"
              }`}
            />
            <span
              className={
                item.status === "completed"
                  ? "text-muted line-through"
                  : item.status === "in_progress"
                    ? "font-medium text-working-ink"
                    : "text-text-2"
              }
            >
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const TONE_CLASS: Record<ToolTone, string> = {
  running: "text-working border-working",
  failed: "text-blocked border-border-subtle",
  edit: "text-accent border-border-subtle",
  neutral: "text-faint border-border-subtle",
};

function ActivitySection({ entries, loading }: { entries: readonly ActivityEntry[]; loading: boolean }) {
  const strings = useStrings();
  const now = useNow(5000);
  const rows = useMemo(() => newestFirst(entries), [entries]);
  return (
    <section className="flex flex-col gap-1" aria-label={strings.timeline.activity}>
      <span className={`${SECTION_LABEL} mb-1.5`}>{strings.timeline.activity}</span>
      {rows.length === 0 ? (
        <div className="text-xs text-muted">{loading ? strings.timeline.loading : strings.timeline.noActivity}</div>
      ) : (
        <ol className="flex flex-col" data-testid="timeline-activity">
          {rows.map((e) =>
            isToolEntry(e) ? (
              <ToolRow key={e.id} entry={e} now={now} />
            ) : (
              <li key={e.id} className="my-1 flex items-center gap-2 text-label text-faint" data-kind="turn">
                <span className="h-px flex-1 bg-border" />
                <span>
                  {strings.timeline.turn} · {formatClock(e.at)}
                </span>
                <span className="h-px flex-1 bg-border" />
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  );
}

function ToolRow({ entry, now }: { entry: ActivityToolEntry; now: number }) {
  const strings = useStrings();
  const tone = toolTone(entry);
  const since = secondsSince(entry.startedAt, now);
  const parts = [entry.tool];
  if (entry.status === "running") {
    parts.push(strings.timeline.status.running);
    if (since !== null) parts.push(formatDuration(since));
  } else {
    if (entry.status !== "ok") parts.push(strings.timeline.status[entry.status]);
    if (entry.durationMs !== undefined) parts.push(formatToolDuration(entry.durationMs));
    if (since !== null) parts.push(since < 5 ? strings.timeline.justNow : strings.timeline.ago(formatDuration(since)));
  }
  const target = entry.paths && entry.paths.length > 1 ? entry.paths.join(", ") : entry.target;
  return (
    <li className="flex gap-2.5 px-1 py-1.5" data-status={entry.status} data-kind={entry.kind}>
      <span
        aria-hidden="true"
        className={`flex size-6 shrink-0 items-center justify-center rounded-control border bg-surface-5 font-mono text-label font-semibold ${TONE_CLASS[tone]}`}
      >
        {toolLetter(entry)}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`truncate text-body ${target ? "text-text" : "text-muted"}`} title={target}>
          {target ?? strings.timeline.noTarget}
        </div>
        <div className={`truncate text-label ${tone === "failed" ? "text-blocked-ink" : tone === "running" ? "text-working-ink" : "text-faint"}`}>
          {parts.join(" · ")}
        </div>
      </div>
    </li>
  );
}

function ChangedFilesSection({
  workspaceId,
  workspacePath,
  projectRoot,
  entries,
}: {
  workspaceId: string;
  workspacePath: string;
  projectRoot: string | null;
  entries: readonly ActivityEntry[];
}) {
  const strings = useStrings();
  const state = useChangesStore((s) => s.byWorkspace[workspaceId]);
  const touched = useMemo(() => touchedPaths(entries, workspacePath, projectRoot), [entries, workspacePath, projectRoot]);
  const changes = state?.changes ?? null;
  const groups = useMemo(() => groupChangedFiles(changes?.files ?? [], touched), [changes, touched]);
  const count = changes?.files.length ?? 0;

  let body: JSX.Element;
  if (!state || (state.status === "loading" && !changes)) body = <div className="text-xs text-muted">{strings.timeline.loading}</div>;
  else if (state.status === "error") body = <div className="text-xs text-blocked-ink">{strings.timeline.changesFailed}</div>;
  else if (changes && !changes.repo) body = <div className="text-xs text-muted">{strings.timeline.notRepo}</div>;
  else if (count === 0) body = <div className="text-xs text-muted">{strings.timeline.noChanges}</div>;
  else
    body = (
      <div className="flex flex-col gap-1">
        {groups.touched.length > 0 && (
          <FileGroup label={groups.other.length > 0 ? strings.timeline.touchedHint : null} files={groups.touched} workspaceId={workspaceId} touched />
        )}
        {groups.other.length > 0 && (
          <FileGroup label={groups.touched.length > 0 ? strings.timeline.otherChanges : null} files={groups.other} workspaceId={workspaceId} />
        )}
        {changes?.truncated && <div className="text-label text-faint">{strings.timeline.truncated}</div>}
      </div>
    );

  return (
    <section className="mt-auto rounded-card border border-border-subtle bg-surface-3 p-3" aria-label={strings.timeline.changedFiles} data-testid="timeline-changes">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-small font-semibold text-text">
          {strings.timeline.changedFiles}
          {count > 0 && <span className="ml-1.5 font-normal text-faint">{count}</span>}
        </span>
        <button
          type="button"
          aria-label={strings.timeline.refresh}
          title={strings.timeline.refresh}
          onClick={() => void useChangesStore.getState().refresh(workspaceId)}
          className="flex size-6 items-center justify-center rounded-control text-muted hover:bg-surface-4 hover:text-text"
        >
          <RefreshIcon />
        </button>
      </div>
      {body}
    </section>
  );
}

const STATUS_CLASS: Record<GitChangedFile["status"], string> = {
  M: "text-working-ink",
  A: "text-idle-ink",
  "?": "text-idle-ink",
  D: "text-blocked-ink",
  R: "text-done-ink",
};

function FileGroup({ label, files, workspaceId, touched = false }: { label: string | null; files: GitChangedFile[]; workspaceId: string; touched?: boolean }) {
  return (
    <div className="flex flex-col">
      {label && <div className="mb-0.5 mt-1 text-label text-faint">{label}</div>}
      <ul className="flex flex-col">
        {files.map((f) => (
          <FileRow key={f.path} file={f} workspaceId={workspaceId} touched={touched} />
        ))}
      </ul>
    </div>
  );
}

function FileRow({ file, workspaceId, touched }: { file: GitChangedFile; workspaceId: string; touched: boolean }) {
  const strings = useStrings();
  const dir = dirNameOf(file.path);
  const counts = file.added === null && file.removed === null;
  return (
    <li>
      <button
        type="button"
        data-touched={touched}
        title={`${strings.timeline.fileStatus[file.status]} · ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}`}
        aria-label={strings.timeline.openDiff(file.path)}
        onClick={() => {
          useViewerStore.getState().openDiff(workspaceId, file.path);
          useLayoutStore.getState().setVisible("viewer", true);
        }}
        className="-mx-1.5 flex w-[calc(100%+12px)] items-center gap-2 rounded-control px-1.5 py-[3px] text-left font-mono text-small hover:bg-surface-4"
      >
        <span className={`w-2.5 shrink-0 text-label font-semibold ${STATUS_CLASS[file.status]}`}>{file.status === "?" ? "U" : file.status}</span>
        <span className="min-w-0 flex-1 truncate">
          <span className={touched ? "text-text" : "text-text-2"}>{baseNameOf(file.path)}</span>
          {dir && <span className="ml-1.5 text-label text-faint">{dir}</span>}
        </span>
        <span className="shrink-0 whitespace-nowrap">
          {counts ? (
            <span className="text-faint">{NO_VALUE}</span>
          ) : (
            <>
              <span className="text-idle">+{file.added ?? 0}</span> <span className="text-blocked">−{file.removed ?? 0}</span>
            </>
          )}
        </span>
      </button>
    </li>
  );
}
