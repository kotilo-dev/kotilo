/**
 * Overview (M2, CCC spec §12.1): active 5-hour block, today / this week, plan limits for every
 * agent, a session summary that links to Mission control (M4: the session tiles live there),
 * recent project progress.
 * Live data comes from the hub stream (`hubStore`); projects are loaded once per visit.
 */
import { useStrings, formatNumber } from "../../app/i18n";
import {
  AgentAvatar,
  Button,
  StatusPill,
  Card,
  EmptyState,
  LimitMeter,
  Page,
  PageHeader,
  ProgressBar,
  SectionLabel,
  StatTile,
  agentDisplayName,
  formatClock,
  formatCost,
  formatDuration,
  formatPercent100,
  secondsSince,
  formatTokenCount,
  useHubQuery,
  useNow,
} from "../../app/ui";
import type { LimitDto, ProjectDto, SessionDto, SessionState, UsageCurrent } from "../../lib/hubTypes";
import { useHubStore } from "../../stores/hubStore";
import { useRouteStore } from "../../stores/routeStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { canGoToSession, goToSession } from "../mission/MissionControlPage";
import { blockProgress, countWorking, recentProjects, splitSessions } from "./overviewLogic";

export function OverviewPage() {
  const s = useStrings();
  const connected = useHubStore((st) => st.connected);
  const sessions = useHubStore((st) => st.sessions);
  const usage = useHubStore((st) => st.usage);
  const limits = useHubStore((st) => st.limits);
  const projects = useHubQuery<ProjectDto[]>("/v1/projects");
  const now = useNow(1000);

  const { attention, others } = splitSessions(sessions);
  const live = attention.length + others.length;
  const unavailable = !connected && usage === null && sessions.length === 0;

  return (
    <Page>
      <PageHeader
        title={s.nav.overview}
        subtitle={unavailable ? undefined : s.overview.subtitle(live, attention.length, countWorking(sessions))}
      />

      {unavailable ? (
        <Card>
          <EmptyState title={s.ui.hubUnavailableTitle} body={s.ui.hubUnavailableBody} />
        </Card>
      ) : (
        <>
          <UsageRow usage={usage} now={now} />
          <LimitStrip limits={limits} />

          <WaitingList waiting={attention} live={live} now={now} />

          <ProjectsCard projects={projects.data} loading={projects.loading} />
        </>
      )}
    </Page>
  );
}

function UsageRow({ usage, now }: { usage: UsageCurrent | null; now: number }) {
  const s = useStrings();
  const navigate = useRouteStore((st) => st.navigate);
  const block = usage?.activeBlock ?? null;
  const progress = block ? blockProgress(block.start, block.end, now) : 0;
  const blockSeconds = block ? (Date.parse(block.end) - Date.parse(block.start)) / 1000 : 0;
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_1fr_1fr]">
      <div className="flex min-w-0 flex-col gap-2.5 rounded-card border border-border-subtle bg-surface-2 px-4 py-3.5">
        <div className="flex items-center gap-2 text-small text-text-3">
          <span>{s.overview.activeBlock}</span>
          {block && (
            <span className="font-mono text-muted">
              {formatClock(block.start)}–{formatClock(block.end)}
            </span>
          )}
          <div className="flex-1" />
          {block && <span className="font-mono text-text-2">{s.overview.remaining(formatDuration(block.remainingMinutes * 60))}</span>}
        </div>
        {block ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[22px] font-semibold text-text">{formatTokenCount(block.tokens)}</span>
              <span className="text-muted">{s.overview.tokens}</span>
              <span className="font-mono text-text-2">≈ {formatCost(block.costUsd)}</span>
              <div className="flex-1" />
              <span className="font-mono text-small text-muted">
                {s.overview.burnRate(formatNumber(Math.round(block.tokensPerMinute)))}
              </span>
            </div>
            <ProgressBar value={progress} label={s.overview.blockElapsed(formatDuration(progress * blockSeconds), formatDuration(blockSeconds))} />
            <div className="flex flex-wrap items-center gap-x-3 text-small text-muted">
              <span className="font-mono">{s.overview.blockElapsed(formatDuration(progress * blockSeconds), formatDuration(blockSeconds))}</span>
              <span>{s.overview.projected(formatTokenCount(block.projectedTokens), formatCost(block.projectedCostUsd))}</span>
            </div>
          </>
        ) : (
          <span className="text-muted">{s.overview.noActiveBlock}</span>
        )}
        <span className="text-meta text-faint">{s.overview.blockEstimateNote}</span>
      </div>
      <StatTile
        label={s.overview.today}
        value={formatTokenCount(usage?.today.tokens ?? null)}
        detail={`${formatCost(usage?.today.costUsd ?? null)}${usage?.today.sessions != null ? ` · ${s.overview.sessionsCount(usage.today.sessions)}` : ""}`}
      />
      <StatTile label={s.overview.thisWeek} value={formatTokenCount(usage?.week.tokens ?? null)} detail={formatCost(usage?.week.costUsd ?? null)}>
        <Button variant="ghost" className="-ml-2 mt-1 self-start" onClick={() => navigate("usage")}>
          {s.overview.usageDetails}
        </Button>
      </StatTile>
    </div>
  );
}

/** Plan limits per agent (§7.9); also shown on Mission control. */
export function LimitStrip({ limits }: { limits: LimitDto[] }) {
  const s = useStrings();
  if (limits.length === 0) {
    return <p className="m-0 text-small text-muted">{s.overview.noLimits}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>{s.overview.limits}</SectionLabel>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {limits.map((l) => (
          <LimitMeter
            key={`${l.agent}-${l.window}`}
            leading={<AgentAvatar agent={l.agent} size={20} />}
            label={`${agentDisplayName(l.agent)} · ${s.ui.windows[l.window]}`}
            percent={l.usedPercent}
            note={s.ui.resetsAt(formatClock(l.resetsAt))}
          />
        ))}
      </div>
    </div>
  );
}

/** Up to three agents waiting for the user, plus the way to Mission control. */
const MAX_WAITING = 3;

function WaitingList({ waiting, live, now }: { waiting: SessionDto[]; live: number; now: number }) {
  const s = useStrings();
  const navigate = useRouteStore((st) => st.navigate);
  const shown = waiting.slice(0, MAX_WAITING);
  const hidden = waiting.length - shown.length;
  const byWorkspace = useTerminalStore((st) => st.byWorkspace);
  return (
    <Card
      title={s.overview.waitingTitle}
      labelledBy="overview-waiting"
      actions={
        <Button variant="ghost" onClick={() => navigate("mission")}>
          {s.mission.open}
        </Button>
      }
    >
      {shown.length === 0 ? (
        <p className="m-0 text-muted">{live === 0 ? s.overview.noSessions : s.overview.noAttention}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {shown.map((w) => (
            <li key={`${w.agent}/${w.sessionId}`} className="flex items-center gap-3">
              <AgentAvatar agent={w.agent} size={28} />
              <span className="min-w-0 flex-1 truncate font-medium text-text">{w.projectName}</span>
              <StatusPill state={w.state as SessionState} />
              <span className="hidden w-28 text-right font-mono text-small text-muted sm:block">
                {s.overview.waitingFor(formatDuration(secondsSince(w.stateSince, now)))}
              </span>
              <Button disabled={!canGoToSession(w, byWorkspace)} title={canGoToSession(w, byWorkspace) ? undefined : s.sessions.runningElsewhere} onClick={() => goToSession(w)}>
                {s.sessions.goTo}
              </Button>
            </li>
          ))}
          {hidden > 0 && (
            <li>
              <Button variant="ghost" onClick={() => navigate("mission")}>
                {s.overview.moreWaiting(hidden)}
              </Button>
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}

function ProjectsCard({ projects, loading }: { projects: ProjectDto[] | null; loading: boolean }) {
  const s = useStrings();
  const navigate = useRouteStore((st) => st.navigate);
  const list = projects ? recentProjects(projects) : [];
  return (
    <Card
      title={s.overview.projects}
      labelledBy="overview-projects"
      actions={
        <Button variant="ghost" onClick={() => navigate("projects")}>
          {s.overview.allProjects}
        </Button>
      }
    >
      {loading && !projects ? (
        <p className="m-0 text-muted">{s.ui.loading}</p>
      ) : list.length === 0 ? (
        <EmptyState title={s.overview.noProjects} />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {list.map((p) => (
            <li key={p.root} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium text-text">{p.name}</span>
                <span className="font-mono text-small text-text-2">{s.overview.tasksDone(p.done, p.total)}</span>
                <span className="w-10 text-right font-mono text-small text-muted">{formatPercent100(p.percent)}</span>
              </div>
              <ProgressBar value={p.percent / 100} tone={p.percent >= 100 ? "idle" : "accent"} label={p.name} />
              {p.next && (
                <span className="truncate text-meta text-muted">
                  {s.overview.next}: {p.next.text}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
