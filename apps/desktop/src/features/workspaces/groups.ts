/**
 * D-080: pure workspace-group logic shared by the Workspaces list, the quick switcher,
 * Ctrl+1…9 and Mission Control. Mirrors `WorkspacesState::display_order` in Rust.
 */
import type { Workspace, WorkspaceGroup } from "../../lib/ipc";

export interface WorkspaceSection {
  /** `null` = the ungrouped section (shown last, and without a header when no group exists). */
  group: WorkspaceGroup | null;
  workspaces: Workspace[];
}

function knownGroup(ws: Workspace, groups: WorkspaceGroup[]): string | null {
  return ws.group && groups.some((g) => g.id === ws.group) ? ws.group : null;
}

/**
 * Groups in their order (empty ones too, so a new group can be seen and filled), then the
 * ungrouped workspaces when there are any. A reference to a missing group counts as ungrouped.
 */
export function groupedWorkspaces(workspaces: Workspace[], groups: WorkspaceGroup[]): WorkspaceSection[] {
  const sections: WorkspaceSection[] = groups.map((group) => ({
    group,
    workspaces: workspaces.filter((w) => knownGroup(w, groups) === group.id),
  }));
  const ungrouped = workspaces.filter((w) => knownGroup(w, groups) === null);
  if (ungrouped.length > 0 || groups.length === 0) sections.push({ group: null, workspaces: ungrouped });
  return sections;
}

/** Every workspace in display order (collapsed groups included: Ctrl+N must not shift). */
export function displayOrder(workspaces: Workspace[], groups: WorkspaceGroup[]): Workspace[] {
  return groupedWorkspaces(workspaces, groups).flatMap((s) => s.workspaces);
}

/** The workspace above/below `id` inside its own section, or `null` at the section's edge. */
export function groupNeighbour(
  workspaces: Workspace[],
  groups: WorkspaceGroup[],
  id: string,
  direction: "up" | "down",
): string | null {
  for (const section of groupedWorkspaces(workspaces, groups)) {
    const idx = section.workspaces.findIndex((w) => w.id === id);
    if (idx === -1) continue;
    return section.workspaces[direction === "up" ? idx - 1 : idx + 1]?.id ?? null;
  }
  return null;
}

/** A row the keyboard cursor can stand on in the Workspaces list. */
export type ListRow = { kind: "group"; group: WorkspaceGroup } | { kind: "workspace"; workspace: Workspace };

export function rowKey(row: ListRow): string {
  return row.kind === "group" ? `g:${row.group.id}` : `w:${row.workspace.id}`;
}

/**
 * The visible rows top to bottom: each group's header, then its workspaces unless collapsed;
 * the ungrouped section has a header only when groups exist (it cannot be collapsed).
 */
export function visibleRows(sections: WorkspaceSection[], collapsed: ReadonlySet<string>): ListRow[] {
  const rows: ListRow[] = [];
  for (const section of sections) {
    if (section.group) {
      rows.push({ kind: "group", group: section.group });
      if (collapsed.has(section.group.id)) continue;
    }
    for (const workspace of section.workspaces) rows.push({ kind: "workspace", workspace });
  }
  return rows;
}

/**
 * Where the cursor stands when the user has not moved it: the active workspace, or the header
 * of its collapsed group (never a hidden row), else the first row.
 */
export function defaultCursor(rows: ListRow[], workspaces: Workspace[], groups: WorkspaceGroup[], activeId: string | null): string | null {
  if (activeId && rows.some((r) => r.kind === "workspace" && r.workspace.id === activeId)) return `w:${activeId}`;
  const active = workspaces.find((w) => w.id === activeId);
  const groupId = active ? knownGroup(active, groups) : null;
  if (groupId) return `g:${groupId}`;
  return rows[0] ? rowKey(rows[0]) : null;
}
