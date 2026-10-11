/**
 * Pure tree flattening: workspace list + directory cache + expanded folders → the flat row list
 * shown in the virtualised list (`@tanstack/react-virtual`, D6). No IPC/DOM calls; tested with
 * Vitest (faz2-spec §6).
 */
import type { AppError, DirEntry, Workspace } from "../../lib/ipc";

/** A folder's cache state: not requested yet (`undefined`), loading, loaded or error. */
export type DirState = DirEntry[] | "loading" | { error: AppError } | undefined;

export type Row =
  | { kind: "root"; workspaceId: string; workspace: Workspace; depth: 0; expanded: boolean }
  | { kind: "dir"; workspaceId: string; rel: string; name: string; depth: number; expanded: boolean }
  | { kind: "file"; workspaceId: string; rel: string; name: string; depth: number }
  | { kind: "loading"; workspaceId: string; rel: string; depth: number }
  | { kind: "error"; workspaceId: string; rel: string; depth: number; error: AppError };

export interface FlattenInputs {
  workspaces: Workspace[];
  /** `dirCache[workspaceId][rel]` */
  dirCache: Record<string, Record<string, DirState>>;
  /** `expanded[workspaceId]` is a `Set<rel>`; the root itself is `rel=""`. */
  expanded: Record<string, Set<string>>;
  /**
   * When given, only this workspace's tree can expand; other roots look collapsed even if saved as
   * expanded (user request 2026-09-27: only the active workspace's files are visible).
   * `null` = none active → all roots collapsed. `undefined` = no filter.
   */
  activeId?: string | null;
}

function pushChildren(
  rows: Row[],
  workspaceId: string,
  parentRel: string,
  depth: number,
  dirCache: Record<string, Record<string, DirState>>,
  expandedSet: Set<string>,
): void {
  const state = dirCache[workspaceId]?.[parentRel];
  if (state === undefined) return; // not requested yet: flatten has no side effects, loading is the store's job
  if (state === "loading") {
    rows.push({ kind: "loading", workspaceId, rel: parentRel, depth });
    return;
  }
  if (!Array.isArray(state)) {
    rows.push({ kind: "error", workspaceId, rel: parentRel, depth, error: state.error });
    return;
  }
  for (const entry of state) {
    if (entry.isDir) {
      const childExpanded = expandedSet.has(entry.rel);
      rows.push({ kind: "dir", workspaceId, rel: entry.rel, name: entry.name, depth, expanded: childExpanded });
      if (childExpanded) {
        pushChildren(rows, workspaceId, entry.rel, depth + 1, dirCache, expandedSet);
      }
    } else {
      rows.push({ kind: "file", workspaceId, rel: entry.rel, name: entry.name, depth });
    }
  }
}

/** Workspace order = display order (roots in `workspaces` array order). */
export function flattenVisible({ workspaces, dirCache, expanded, activeId }: FlattenInputs): Row[] {
  const rows: Row[] = [];
  for (const workspace of workspaces) {
    const expandedSet = expanded[workspace.id] ?? new Set<string>();
    const canExpand = activeId === undefined || activeId === workspace.id;
    const rootExpanded = canExpand && expandedSet.has("");
    rows.push({ kind: "root", workspaceId: workspace.id, workspace, depth: 0, expanded: rootExpanded });
    if (rootExpanded) {
      pushChildren(rows, workspace.id, "", 1, dirCache, expandedSet);
    }
  }
  return rows;
}
