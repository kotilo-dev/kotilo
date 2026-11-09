/**
 * 0.6 worktrees: pure helpers for the panel, badges and dialogs. Rust is the authority for
 * names and git state; the slug here is only the dialog's preview of the folder and branch.
 */
import type {
  WorktreeInfo,
  WorktreeMergeResult,
  WorktreeRemoveResult,
  WorktreeUnsupported,
} from "../../lib/ipc";
import type { Strings } from "../../app/i18n";
import type { TerminalTab } from "../../stores/terminalStore";

/** Where our worktrees live inside the workspace root. */
export const MANAGED_WORKTREES_REL = ".kotilo/worktrees";
export const DEFAULT_BRANCH_PREFIX = "kotilo/";
const SLUG_MAX = 40;

/** Name → folder slug as Rust makes it: lowercase, `[a-z0-9-]`, other runs → `-`, trimmed, ≤ 40. Empty = invalid. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, SLUG_MAX).replace(/-+$/g, "");
}

/** What a tab's badge needs: the worktree a cwd is in. */
export interface WorktreeMatch {
  name: string;
  rel: string;
  branch: string | null;
  managed: boolean;
}

/** Tolerates a missing cwd (older persisted tabs, test doubles). */
function normalizeRel(rel: string | undefined): string {
  return (rel ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isInside(cwd: string, rel: string): boolean {
  return cwd === rel || cwd.startsWith(`${rel}/`);
}

/**
 * The worktree `cwdRel` lies in: the deepest listed worktree containing it, else (list not
 * loaded yet) a folder under `.kotilo/worktrees/` by its name. `null` outside any worktree.
 */
export function worktreeForCwd(cwdRel: string, worktrees: readonly WorktreeInfo[] | null | undefined): WorktreeMatch | null {
  const cwd = normalizeRel(cwdRel);
  if (cwd === "") return null;
  let best: WorktreeInfo | null = null;
  for (const wt of worktrees ?? []) {
    if (isInside(cwd, wt.rel) && (!best || wt.rel.length > best.rel.length)) best = wt;
  }
  if (best) return { name: best.name, rel: best.rel, branch: best.branch, managed: best.managed };
  const prefix = `${MANAGED_WORKTREES_REL}/`;
  if (!cwd.startsWith(prefix)) return null;
  const name = cwd.slice(prefix.length).split("/")[0] ?? "";
  if (name === "") return null;
  return { name, rel: `${prefix}${name}`, branch: null, managed: true };
}

function normalizeAbs(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Fallback from a hub session's `worktree` (absolute worktree root) and `worktreeBranch`: the
 * listed worktree at `<workspaceRoot>/<rel>` (compared case-insensitively, separators
 * normalized), else the branch or the path's last segment as the label.
 */
export function worktreeFromSession(
  session: { worktree?: string | null; worktreeBranch?: string | null } | null | undefined,
  workspaceRoot: string | null | undefined,
  worktrees: readonly WorktreeInfo[] | null | undefined,
): WorktreeMatch | null {
  const path = session?.worktree;
  if (!path) return null;
  const target = normalizeAbs(path);
  if (workspaceRoot) {
    const root = normalizeAbs(workspaceRoot);
    const wt = (worktrees ?? []).find((w) => `${root}/${w.rel.toLowerCase()}` === target);
    if (wt) return { name: wt.name, rel: wt.rel, branch: wt.branch ?? session.worktreeBranch ?? null, managed: wt.managed };
  }
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  const name = parts[parts.length - 1] ?? "";
  if (name === "" && !session.worktreeBranch) return null;
  return { name, rel: path, branch: session.worktreeBranch ?? null, managed: false };
}

/** Badge text: the branch, else the folder name. */
export function badgeLabel(match: WorktreeMatch): string {
  return match.branch ?? match.name;
}

/** The terminal tabs whose cwd is inside `rel`. */
export function tabsInWorktree(tabs: readonly TerminalTab[], rel: string): TerminalTab[] {
  return tabs.filter((t) => isInside(normalizeRel(t.cwdRel), rel));
}

export function unsupportedHint(s: Strings, reason: WorktreeUnsupported | null): string {
  return reason ? s.worktrees.unsupported[reason] : s.worktrees.create.unsupported;
}

export function defaultSquashMessage(branch: string): string {
  return `Squash ${branch}`;
}

export type MessageTone = "success" | "info" | "error";

export interface ResultMessage {
  tone: MessageTone;
  text: string;
}

/** Merge result → the dialog's message (conflict files and git output are shown separately). */
export function mergeMessage(s: Strings, result: WorktreeMergeResult, branch: string, base: string): ResultMessage {
  const r = s.worktrees.merge.result;
  switch (result.status) {
    case "merged":
      return { tone: "success", text: r.merged(branch, base) };
    case "upToDate":
      return { tone: "info", text: r.upToDate(base) };
    case "conflict":
      return { tone: "error", text: r.conflict };
    case "mainDirty":
      return { tone: "error", text: r.mainDirty };
    case "worktreeDirty":
      return { tone: "error", text: r.worktreeDirty };
    case "notOnBase":
      return { tone: "error", text: r.notOnBase(base) };
    case "failed":
      return { tone: "error", text: r.failed };
  }
}

/** After a merge: cleanup is offered once the base has every change. */
export function offersCleanup(result: WorktreeMergeResult): boolean {
  return result.status === "merged" || result.status === "upToDate";
}

/** What the remove dialog asks for next after a refused or failed remove. */
export type RemoveFollowUp = "done" | "confirmForce" | "confirmForceBranch" | "failed";

export function removeFollowUp(result: WorktreeRemoveResult): RemoveFollowUp {
  switch (result.status) {
    case "removed":
      return "done";
    case "dirty":
      return "confirmForce";
    case "unmerged":
      return "confirmForceBranch";
    case "failed":
      return "failed";
  }
}

/** Default of "also delete the branch": on when the base already has every commit. */
export function deleteBranchDefault(wt: WorktreeInfo): boolean {
  return wt.branch !== null && wt.ahead === 0;
}
