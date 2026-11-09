/**
 * 0.6: worktree/branch badge for terminal tabs, the agent header strip and Mission control
 * tiles, derived from the tab's cwd and the workspace's worktree list.
 */
import { useEffect, useMemo } from "react";
import { useStrings } from "../../app/i18n";
import { useWorktreeStore } from "../../stores/worktreeStore";
import { badgeLabel, worktreeForCwd, type WorktreeMatch } from "./worktreeLogic";

export function BranchIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

/** The worktree a tab's cwd is in (loads the workspace's list once when the cwd is not the root). */
export function useWorktreeMatch(workspaceId: string, cwdRel: string): WorktreeMatch | null {
  const worktrees = useWorktreeStore((s) => s.byWorkspace[workspaceId]?.list?.worktrees ?? null);
  const nested = !!cwdRel;
  useEffect(() => {
    if (nested) useWorktreeStore.getState().ensure(workspaceId);
  }, [workspaceId, nested]);
  return useMemo(() => worktreeForCwd(cwdRel, worktrees), [cwdRel, worktrees]);
}

export function WorktreeBadge({ match }: { match: WorktreeMatch }) {
  const s = useStrings();
  const label = badgeLabel(match);
  return (
    <span
      data-testid="worktree-badge"
      title={s.worktrees.badgeTitle(label, match.rel)}
      className="inline-flex min-w-0 max-w-[12rem] shrink-0 items-center gap-1 rounded-badge bg-accent-soft px-1.5 py-px font-mono text-label leading-[1.45] text-accent"
    >
      <BranchIcon />
      <span className="truncate">{label}</span>
    </span>
  );
}
