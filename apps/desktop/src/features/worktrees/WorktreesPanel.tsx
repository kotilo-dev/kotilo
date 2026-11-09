/**
 * 0.6 Mission control: the worktrees of each workspace, one compact row per worktree (branch,
 * agents running in it with their state, uncommitted files, ahead/behind the base, +/− lines)
 * with Open terminal / Compare / Merge / Remove. Unmanaged worktrees (made by another tool
 * inside the workspace) get no Merge/Remove. Lists refresh on file events while shown.
 */
import { useEffect } from "react";
import { useStrings } from "../../app/i18n";
import { AgentAvatar, Button, SectionLabel } from "../../app/ui";
import type { Agent, Workspace, WorktreeInfo } from "../../lib/ipc";
import { useAgentStore } from "../../stores/agentStore";
import { useTerminalStore, type TerminalTab } from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { AgentBadge } from "../agents/AgentBadge";
import { navigateToAgent } from "../agents/navigate";
import { BranchIcon } from "./WorktreeBadge";
import { openCreateWorktreeDialog, openWorktreeTerminal } from "./worktreeActions";
import { tabsInWorktree, unsupportedHint } from "./worktreeLogic";

const NO_TABS: TerminalTab[] = [];
const ROW_BUTTON = "h-7 whitespace-nowrap px-2 text-small";

export function WorktreesPanel() {
  const s = useStrings();
  const workspaces = useWorkspaceStore((st) => st.workspaces);
  if (workspaces.length === 0) return null;
  return (
    <section aria-labelledby="worktrees-title" className="flex flex-col gap-2.5" data-testid="worktrees-panel">
      <SectionLabel id="worktrees-title">{s.worktrees.title}</SectionLabel>
      {workspaces.map((ws) => (
        <WorkspaceWorktrees key={ws.id} workspace={ws} />
      ))}
    </section>
  );
}

function WorkspaceWorktrees({ workspace }: { workspace: Workspace }) {
  const s = useStrings();
  const t = s.worktrees;
  const entry = useWorktreeStore((st) => st.byWorkspace[workspace.id]);
  const tabs = useTerminalStore((st) => st.byWorkspace[workspace.id]?.tabs ?? NO_TABS);
  useEffect(() => useWorktreeStore.getState().watch(workspace.id), [workspace.id]);

  const list = entry?.list ?? null;
  const supported = list?.supported === true;
  const meta = list?.supported
    ? [list.currentBranch ? t.onBranch(list.currentBranch) : null, list.mainDirty ? t.mainDirty : null].filter(Boolean).join(" · ")
    : "";

  let body;
  if (!list) {
    body = <p className="m-0 px-4 py-3 text-body text-muted">{entry?.status === "error" ? t.loadFailed : t.loading}</p>;
  } else if (!list.supported) {
    body = <p className="m-0 px-4 py-3 text-body text-muted" data-testid="worktrees-unsupported">{unsupportedHint(s, list.reason)}</p>;
  } else if (list.worktrees.length === 0) {
    body = <p className="m-0 px-4 py-3 text-body text-muted">{t.empty}</p>;
  } else {
    body = (
      <ul className="m-0 list-none p-0">
        {list.worktrees.map((wt) => (
          <WorktreeRow key={wt.rel} workspaceId={workspace.id} wt={wt} tabs={tabs} />
        ))}
      </ul>
    );
  }

  return (
    <section
      aria-label={`${t.title} · ${workspace.name}`}
      className="flex min-w-0 flex-col overflow-hidden rounded-card border border-border-subtle bg-surface-2"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-4 py-2.5">
        <h3 className="m-0 text-title font-semibold text-text">{workspace.name}</h3>
        {meta && <span className={`text-meta ${list?.mainDirty ? "text-working-ink" : "text-muted"}`}>{meta}</span>}
        <div className="flex-1" />
        <Button variant="secondary" className={ROW_BUTTON} disabled={!supported} onClick={() => openCreateWorktreeDialog(workspace.id)}>
          {t.newAgent}
        </Button>
      </header>
      {body}
    </section>
  );
}

function WorktreeRow({ workspaceId, wt, tabs }: { workspaceId: string; wt: WorktreeInfo; tabs: readonly TerminalTab[] }) {
  const s = useStrings();
  const t = s.worktrees;
  const agents = useAgentStore((st) => st.agents);
  const openDialog = useWorktreeStore((st) => st.openDialog);
  const inside = tabsInWorktree(tabs, wt.rel);
  const running: Agent[] = [];
  for (const tab of inside) {
    const agent = tab.paneId ? agents.find((a) => a.paneId === tab.paneId) : undefined;
    if (agent) running.push(agent);
  }
  const branch = wt.branch ?? `${wt.name} (${t.detached})`;
  const sub = [wt.rel, wt.managed ? null : t.unmanaged, wt.prunable ? t.missing : null, wt.locked ? t.locked : null].filter(Boolean).join(" · ");

  return (
    <li
      data-testid="worktree-row"
      data-worktree={wt.name}
      aria-label={t.rowLabel(branch)}
      className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border-subtle px-4 py-2.5 first:border-t-0 xl:grid xl:grid-cols-[minmax(0,1fr)_10rem_24rem_21rem]"
    >
      <div className="flex min-w-[14rem] flex-1 items-center gap-2.5 xl:min-w-0">
        <span className="text-accent">
          <BranchIcon size={14} />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-body text-text">{branch}</span>
          <span className={`truncate text-meta ${wt.prunable ? "text-blocked-ink" : "text-muted"}`} title={sub}>
            {sub}
          </span>
        </div>
      </div>

      <div className="flex min-w-[10rem] flex-wrap items-center gap-2 xl:min-w-0">
        {running.length === 0 ? (
          <span className="text-meta text-muted">{t.noAgent}</span>
        ) : (
          running.map((agent) => (
            <button
              key={agent.paneId}
              type="button"
              className="inline-flex items-center gap-1.5 rounded-control px-1 py-0.5 text-meta text-text-2 hover:bg-surface-4"
              onClick={() => navigateToAgent(agent)}
            >
              <AgentAvatar agent={agent.adapterId ?? agent.kind} size={18} />
              <AgentBadge state={agent.state} />
              <span>{s.agents.stateLabel[agent.state]}</span>
            </button>
          ))
        )}
      </div>

      <div className="flex items-center gap-3.5 font-mono text-small">
        <span className={`whitespace-nowrap xl:w-[9rem] ${wt.dirty > 0 ? "text-working-ink" : "text-muted"}`}>{wt.dirty > 0 ? t.dirty(wt.dirty) : t.clean}</span>
        <span className="whitespace-nowrap text-text-3 xl:w-[10rem]">
          {t.ahead(wt.ahead)} · {t.behind(wt.behind)}
        </span>
        <span className="whitespace-nowrap" aria-label={t.linesLabel(wt.added, wt.removed)}>
          <span className="text-idle-ink">+{wt.added}</span> <span className="text-blocked-ink">−{wt.removed}</span>
        </span>
      </div>

      <div className="flex items-center gap-1 xl:justify-end">
        <Button variant="ghost" className={ROW_BUTTON} disabled={wt.prunable} onClick={() => openWorktreeTerminal(workspaceId, wt.rel)}>
          {t.actions.openTerminal}
        </Button>
        <Button variant="ghost" className={ROW_BUTTON} disabled={wt.prunable} onClick={() => openDialog({ kind: "compare", workspaceId, name: wt.name })}>
          {t.actions.compare}
        </Button>
        {wt.managed && (
          <>
            <Button
              variant="ghost"
              className={ROW_BUTTON}
              disabled={!wt.branch || !wt.base || wt.prunable}
              onClick={() => openDialog({ kind: "merge", workspaceId, name: wt.name })}
            >
              {t.actions.merge}
            </Button>
            <Button variant="danger" className={ROW_BUTTON} onClick={() => openDialog({ kind: "remove", workspaceId, name: wt.name })}>
              {t.actions.remove}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
