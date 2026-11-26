/**
 * DESIGN_SYSTEM §7.3 agent header strip, above an agent's terminal: avatar · project +
 * "agent · branch · model" · state pill · context bar · session tokens/cost · the agent's
 * most-used plan limit. Display only: it never takes focus from the terminal.
 */
import type { ReactNode } from "react";
import { AgentAvatar, meterColorClass } from "../../app/ui";
import { formatCurrencyUsd, formatTokens, useStrings } from "../../app/i18n";
import { PaneStatePill } from "./PaneStatus";
import { WorktreeBadge } from "../worktrees/WorktreeBadge";
import type { WorktreeMatch } from "../worktrees/worktreeLogic";
import type { PaneVisualState } from "./paneSession";

export interface HeaderLimit {
  window: "fiveHour" | "weekly";
  usedPercent: number;
}

export interface AgentHeaderStripProps {
  /** Hub adapter id or desktop pane kind (avatar identity). */
  agent: string;
  agentName: string;
  projectName: string;
  branch: string | null;
  model: string | null;
  state: PaneVisualState;
  /** Already formatted (e.g. "1m 12s"); omitted for idle. */
  elapsed: string | null;
  contextPercent: number | null;
  tokens: number | null;
  costUsd: number | null;
  limit: HeaderLimit | null;
  /** 0.3.2: "Background: …" while the turn waits for background work. */
  background?: string | null;
  /** Panel actions at the end of the strip (M4: the split button). */
  actions?: ReactNode;
  /** 0.6: the worktree the agent runs in; its badge replaces the branch in the meta line. */
  worktree?: WorktreeMatch | null;
}

export function AgentHeaderStrip(p: AgentHeaderStripProps) {
  const s = useStrings();
  const meta = [p.agentName, p.worktree ? null : p.branch, p.model].filter(Boolean).join(" · ");
  const context = p.contextPercent === null ? null : Math.max(0, Math.min(100, p.contextPercent));
  const usage =
    p.costUsd !== null ? formatCurrencyUsd(p.costUsd) : p.tokens !== null && p.tokens > 0 ? s.workspace.tokens(formatTokens(p.tokens)) : s.workspace.noData;
  const urgent = p.state === "permission" || p.state === "input" || p.state === "error";

  // Stable two-row grid (no height jump between states). Below ~420 px the metrics fold into
  // one compact line: their captions and bars drop out, the values stay.
  const caption = "@max-[420px]:hidden";
  return (
    <div
      role="group"
      aria-label={s.workspace.headerLabel(p.agentName, p.projectName)}
      className="@container flex shrink-0 flex-col gap-1.5 border-b border-border-subtle bg-surface-3 px-3.5 py-2"
    >
      <div className="flex min-w-0 items-center gap-3">
        <AgentAvatar agent={p.agent} size={28} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-title font-semibold text-text">{p.projectName}</span>
            {p.worktree && <WorktreeBadge match={p.worktree} />}
          </span>
          <span className="truncate text-meta text-muted">{meta}</span>
        </div>
        {p.background && (
          <span className="hidden min-w-0 max-w-[16rem] truncate text-meta text-muted @[420px]:block" title={p.background}>
            {p.background}
          </span>
        )}
        <span className="shrink-0 whitespace-nowrap" aria-live={urgent ? "assertive" : "polite"}>
          <PaneStatePill state={p.state} suffix={p.elapsed ?? undefined} background={!!p.background} />
        </span>
      </div>
      <div className="flex min-h-[30px] min-w-0 items-center gap-3 text-small text-text-3">
        <div className="flex min-w-0 flex-1 items-center gap-x-[18px] gap-y-1 overflow-hidden whitespace-nowrap">
          <div className="flex flex-col gap-1 @max-[420px]:flex-row @max-[420px]:items-center @max-[420px]:gap-1.5" title={s.workspace.context}>
            <span className={caption}>{s.workspace.context}</span>
            <div className="flex items-center gap-2">
              <div
                className={`h-[5px] w-[120px] overflow-hidden rounded-[3px] bg-track ${caption}`}
                role={context === null ? undefined : "meter"}
                aria-label={s.workspace.context}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={context === null ? undefined : Math.round(context)}
              >
                {context !== null && <div className="h-full rounded-[3px] bg-accent" style={{ width: `${context}%` }} />}
              </div>
              <span className="font-mono text-text">{context === null ? s.workspace.noData : `${Math.round(context)}%`}</span>
            </div>
          </div>
          <div className="flex flex-col gap-1 @max-[420px]:flex-row @max-[420px]:items-center" title={s.workspace.session}>
            <span className={caption}>{s.workspace.session}</span>
            <span className="font-mono text-text">{usage}</span>
          </div>
          {p.limit && (
            <div className="flex flex-col gap-1 @max-[420px]:flex-row @max-[420px]:items-center @max-[420px]:gap-1.5" title={s.workspace.limit[p.limit.window]}>
              <span className={caption}>{s.workspace.limit[p.limit.window]}</span>
              <div className="flex items-center gap-2">
                <div className={`h-[5px] w-[56px] overflow-hidden rounded-[3px] bg-track ${caption}`}>
                  <div
                    className={`h-full rounded-[3px] ${meterColorClass(p.limit.usedPercent)}`}
                    style={{ width: `${Math.max(0, Math.min(100, p.limit.usedPercent))}%` }}
                  />
                </div>
                <span className="font-mono text-text">{Math.round(p.limit.usedPercent)}%</span>
              </div>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{p.actions}</div>
      </div>
    </div>
  );
}
