/**
 * D-067: Sessions page – the agent sessions the hub has seen (metadata only: project, folder,
 * agent, model, times, tokens, cost), searchable and grouped. "Resume" opens a terminal in the
 * session's folder running the adapter's resume command; a running session can be jumped to.
 */
import { useMemo, useState } from "react";
import { useStrings } from "../../app/i18n";
import { AgentAvatar, agentDisplayName } from "../../app/ui";
import { formatCost, formatDuration, formatTokenCount } from "../../app/ui/format";
import { StatusPill } from "../../app/ui/StatusPill";
import { clipboardWriteText, type Agent } from "../../lib/ipc";
import type { SessionHistoryRow, SessionState } from "../../lib/hubTypes";
import { platformId } from "../../lib/platform";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useRouteStore } from "../../stores/routeStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useToastStore } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { navigateToAgent } from "../agents/navigate";
import { Button, EmptyState, Notice, Page, PageHeader, SectionLabel, Segmented, Select, TextInput } from "../settings/controls";
import { useHubResource } from "../settings/hubData";
import { formatRelative } from "../tasks/taskLogic";
import { ContextMenu, type ContextMenuState } from "../workspaces/ContextMenu";
import { filterSessions, groupSessions, resumeCommand, workspaceForFolder, type SessionGrouping } from "./sessionHistory";

type Scope = "workspace" | "all";
type Days = "7" | "30" | "90";

const WORKSPACE_WAIT_MS = 3000;

function caseInsensitivePaths(): boolean {
  return platformId() === "windows";
}

/** Waits for the workspace store to list a workspace holding `folder` (after `addWorkspace`). */
async function waitForWorkspace(folder: string): Promise<{ workspaceId: string; cwdRel: string } | null> {
  const find = () => workspaceForFolder(useWorkspaceStore.getState().workspaces, folder, caseInsensitivePaths());
  const deadline = Date.now() + WORKSPACE_WAIT_MS;
  while (Date.now() < deadline) {
    const found = find();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  return find();
}

export function SessionsPage() {
  const s = useStrings();
  const t = s.sessions;
  const [days, setDays] = useState<Days>("30");
  const [scope, setScope] = useState<Scope>("all");
  const [grouping, setGrouping] = useState<SessionGrouping>("project");
  const [query, setQuery] = useState("");
  const history = useHubResource<SessionHistoryRow[]>(`/v1/sessions/history?days=${days}&limit=1000`);
  const definitions = useDefinitionsStore((st) => st.definitions);
  const workspaces = useWorkspaceStore((st) => st.workspaces);
  const activeId = useWorkspaceStore((st) => st.activeId);
  const active = workspaces.find((w) => w.id === activeId) ?? null;

  const agentName = useMemo(() => (id: string) => agentDisplayName(id, definitions), [definitions]);
  const scoped = useMemo(() => {
    const rows = history.data ?? [];
    if (scope === "all") return rows;
    if (!active) return [];
    return rows.filter((r) => workspaceForFolder([active], r.projectRoot, caseInsensitivePaths()) !== null);
  }, [history.data, scope, active]);
  const groups = useMemo(() => groupSessions(filterSessions(scoped, query, agentName), grouping, agentName), [scoped, query, grouping, agentName]);

  return (
    <Page>
      <PageHeader
        title={t.title}
        subtitle={history.data ? t.subtitle(history.data.length, Number(days)) : undefined}
        actions={<Button onClick={() => void history.reload()}>{t.refresh}</Button>}
      />
      <div className="flex flex-wrap items-center gap-3">
        <TextInput type="search" value={query} onChange={setQuery} placeholder={t.search} ariaLabel={t.search} className="w-72" />
        <Segmented<Scope>
          ariaLabel={t.scopeLabel}
          value={scope}
          onChange={setScope}
          options={[
            { value: "workspace", label: t.scopeWorkspace },
            { value: "all", label: t.scopeAll },
          ]}
        />
        <Segmented<SessionGrouping>
          ariaLabel={t.groupLabel}
          value={grouping}
          onChange={setGrouping}
          options={[
            { value: "project", label: t.groupProject },
            { value: "agent", label: t.groupAgent },
            { value: "none", label: t.groupNone },
          ]}
        />
        <div className="w-44">
          <Select<Days>
            ariaLabel={t.rangeLabel}
            value={days}
            onChange={setDays}
            options={(["7", "30", "90"] as const).map((d) => ({ value: d, label: t.range(Number(d)) }))}
          />
        </div>
      </div>

      {history.unavailable && <Notice tone="warning">{s.errors.forCode("hub_unavailable")}</Notice>}
      {history.error && !history.unavailable && <Notice tone="error">{history.error.message}</Notice>}
      {history.data && history.data.length === 0 && <EmptyState title={t.empty} body={t.emptyBody} />}
      {history.data && history.data.length > 0 && scope === "workspace" && !active && <EmptyState title={t.noWorkspace} />}
      {history.data && history.data.length > 0 && groups.length === 0 && (scope === "all" || active) && <EmptyState title={t.noMatch} />}

      {groups.length > 0 && (
        <div className="flex flex-col gap-5" aria-label={t.listLabel}>
          {groups.map((g) => (
            <section key={g.key} className="flex flex-col gap-2" aria-label={g.label || t.listLabel}>
              {g.label && (
                <SectionLabel>
                  {g.label} <span className="font-normal text-faint">{g.rows.length}</span>
                </SectionLabel>
              )}
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {g.rows.map((r) => (
                  <li key={`${r.agent}/${r.sessionId}`}>
                    <SessionRow row={r} agentName={agentName(r.agent)} showProject={grouping !== "project"} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}

function SessionRow({ row, agentName, showProject }: { row: SessionHistoryRow; agentName: string; showProject: boolean }) {
  const s = useStrings();
  const t = s.sessions;
  const launch = useDefinitionsStore((st) => st.definitions.find((d) => d.id === row.agent)?.launch);
  const command = resumeCommand(launch, row.sessionId);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const seconds = Math.max(0, (Date.parse(row.lastEventAt) - Date.parse(row.startedAt)) / 1000);
  const byWorkspace = useTerminalStore((st) => st.byWorkspace);
  const paneTab = useMemo(() => {
    if (!row.live || !row.paneId) return undefined;
    for (const [workspaceId, state] of Object.entries(byWorkspace)) {
      if (state.tabs.some((tab) => tab.paneId === row.paneId && tab.status === "running")) return { workspaceId };
    }
    return undefined;
  }, [byWorkspace, row.live, row.paneId]);

  const copy = (text: string) => {
    void clipboardWriteText(text).then(() => useToastStore.getState().show(t.copied));
  };

  const resume = async () => {
    if (!command) return;
    let target = workspaceForFolder(useWorkspaceStore.getState().workspaces, row.projectRoot, caseInsensitivePaths());
    if (!target) {
      // Not in any workspace yet: open the session's folder as one.
      await useWorkspaceStore.getState().addWorkspace(row.projectRoot);
      target = await waitForWorkspace(row.projectRoot);
    }
    if (!target) {
      useToastStore.getState().show(t.folderMissing(row.projectRoot));
      return;
    }
    useRouteStore.getState().navigate("workspace");
    await useWorkspaceStore.getState().setActive(target.workspaceId);
    useLayoutStore.getState().setVisible("terminal", true);
    useTerminalStore.getState().newTerminal(target.workspaceId, { cwdRel: target.cwdRel, agentCommand: command });
  };

  const goTo = () => {
    if (!row.paneId || !paneTab) return;
    const agent: Agent = { id: row.paneId, paneId: row.paneId, workspaceId: paneTab.workspaceId, kind: "other", state: "idle", sinceMs: 0, source: "hook", sessionId: row.sessionId };
    navigateToAgent(agent);
  };

  return (
    <div className="flex items-center gap-3 rounded-card border border-border-subtle bg-surface-2 px-3 py-2.5" data-testid="session-row" data-session-id={row.sessionId}>
      <AgentAvatar agent={row.agent} size={28} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold text-text">{showProject ? row.projectName : agentName}</span>
          <span className="truncate text-small text-muted">
            {showProject ? agentName : null}
            {showProject && row.model ? " · " : null}
            {row.model}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-label text-faint">
          <span className="truncate font-mono" title={row.projectRoot}>
            {row.projectRoot}
          </span>
          <span className="shrink-0">·</span>
          <span className="shrink-0" title={t.started(new Date(row.startedAt).toLocaleString())}>
            {t.lastActivity(formatRelative(row.lastEventAt))}
          </span>
        </div>
      </div>
      <div className="hidden shrink-0 flex-col items-end gap-0.5 text-small sm:flex">
        <span className="num text-text-2">{formatTokenCount(row.tokens)}</span>
        <span className="num text-faint">
          {formatCost(row.costUsd)} · {formatDuration(seconds)}
        </span>
      </div>
      {/* Running outside Kotilo's terminals: no Resume, a second client on the same session would clash. */}
      {row.live && (
        <span title={paneTab ? undefined : t.runningElsewhere}>
          <StatusPill state={row.state as SessionState} />
        </span>
      )}
      <div className="flex shrink-0 items-center gap-1.5">
        {row.live && paneTab ? (
          <Button onClick={goTo}>{t.goTo}</Button>
        ) : row.live ? null : (
          <Button variant="primary" disabled={!command} title={command ? t.resumeTitle(command) : t.noResume} onClick={() => void resume()}>
            {t.resume}
          </Button>
        )}
        <button
          type="button"
          aria-label={t.copy}
          title={t.copy}
          className="inline-flex h-9 w-9 items-center justify-center rounded-button text-text-2 hover:bg-surface-4"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setMenu({
              x: box.left,
              y: box.bottom + 4,
              items: [
                { label: t.copyCommand, onClick: () => command && copy(command), disabled: !command },
                { label: t.copyId, onClick: () => copy(row.sessionId) },
                { label: t.copyFolder, onClick: () => copy(row.projectRoot) },
              ],
            });
          }}
        >
          …
        </button>
      </div>
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
