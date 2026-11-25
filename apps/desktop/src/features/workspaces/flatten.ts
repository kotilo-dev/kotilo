/**
 * Pure tree flattening: directory cache + expanded folders → the flat row list shown in the
 * virtualised list (`@tanstack/react-virtual`, D6). No IPC/DOM calls; tested with Vitest
 * (faz2-spec §6).
 */
import type { AppError, DirEntry } from "../../lib/ipc";

/** A folder's cache state: not requested yet (`undefined`), loading, loaded or error. */
export type DirState = DirEntry[] | "loading" | { error: AppError } | undefined;

export type Row =
  | { kind: "dir"; workspaceId: string; rel: string; name: string; depth: number; expanded: boolean }
  | { kind: "file"; workspaceId: string; rel: string; name: string; depth: number }
  | { kind: "loading"; workspaceId: string; rel: string; depth: number }
  | { kind: "error"; workspaceId: string; rel: string; depth: number; error: AppError };

export interface FlattenInputs {
  /** `dirCache[workspaceId][rel]` */
  dirCache: Record<string, Record<string, DirState>>;
  /** `expanded[workspaceId]` is a `Set<rel>` of open sub-folders (the root, `rel=""`, is always open). */
  expanded: Record<string, Set<string>>;
  /** The workspace whose files are shown; `null`/`undefined` = none → no rows. */
  workspaceId: string | null | undefined;
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

/**
 * The Files tab shows only the active workspace's contents (no root row): its top level starts at
 * depth 0 and is treated as always expanded.
 */
export function flattenVisible({ dirCache, expanded, workspaceId }: FlattenInputs): Row[] {
  const rows: Row[] = [];
  if (!workspaceId) return rows;
  pushChildren(rows, workspaceId, "", 0, dirCache, expanded[workspaceId] ?? new Set<string>());
  return rows;
}
