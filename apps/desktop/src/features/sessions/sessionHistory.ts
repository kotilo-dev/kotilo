/**
 * D-067: pure part of the Sessions page – filtering, grouping, the resume command and which
 * workspace a session's folder belongs to. Rows are hub metadata only (no transcript content).
 */
import type { SessionHistoryRow } from "../../lib/hubTypes";
import type { Workspace } from "../../lib/ipc";

export type SessionGrouping = "project" | "agent" | "none";

export interface SessionGroup {
  key: string;
  label: string;
  rows: SessionHistoryRow[];
}

/** Placeholder in an adapter's `launch.resumeArgs`. */
export const SESSION_ID_PLACEHOLDER = "{sessionId}";

/**
 * Session ids go into a shell command line, so only plain id characters are accepted (UUIDs,
 * `ses_…`, Codex names); anything else gets no resume command.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isSafeSessionId(id: string): boolean {
  return SAFE_SESSION_ID.test(id);
}

/** `command` + `resumeArgs` with the session id filled in; null when the agent cannot resume it. */
export function resumeCommand(launch: { command: string; resumeArgs?: string[] } | null | undefined, sessionId: string): string | null {
  if (!launch?.resumeArgs?.length || !isSafeSessionId(sessionId)) return null;
  if (!launch.resumeArgs.some((a) => a.includes(SESSION_ID_PLACEHOLDER))) return null;
  return [launch.command, ...launch.resumeArgs.map((a) => a.split(SESSION_ID_PLACEHOLDER).join(sessionId))].join(" ");
}

function normalizePath(path: string, caseInsensitive: boolean): string {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return caseInsensitive ? p.toLowerCase() : p;
}

/**
 * The workspace that holds `folder` (the deepest one when workspaces nest) and the folder's path
 * inside it (`""` for the root, `/`-separated). Null when no workspace has it.
 */
export function workspaceForFolder(
  workspaces: readonly Pick<Workspace, "id" | "path">[],
  folder: string,
  caseInsensitive: boolean,
): { workspaceId: string; cwdRel: string } | null {
  const target = normalizePath(folder, caseInsensitive);
  const original = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  let best: { workspaceId: string; cwdRel: string; depth: number } | null = null;
  for (const ws of workspaces) {
    const root = normalizePath(ws.path, caseInsensitive);
    const inside = target === root || target.startsWith(`${root}/`);
    if (!inside || (best && root.length <= best.depth)) continue;
    best = { workspaceId: ws.id, cwdRel: original.slice(root.length).replace(/^\//, ""), depth: root.length };
  }
  return best ? { workspaceId: best.workspaceId, cwdRel: best.cwdRel } : null;
}

/** Case-insensitive match on project, folder, model, agent (id or name) and session id. */
export function filterSessions(rows: readonly SessionHistoryRow[], query: string, agentName: (id: string) => string): SessionHistoryRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((r) => {
    const hay = [r.projectName, r.projectRoot, r.model ?? "", r.agent, agentName(r.agent), r.sessionId].join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Groups in order of their newest session; rows keep their order (newest first). */
export function groupSessions(rows: readonly SessionHistoryRow[], by: SessionGrouping, agentName: (id: string) => string): SessionGroup[] {
  if (by === "none") return rows.length ? [{ key: "all", label: "", rows: [...rows] }] : [];
  const groups = new Map<string, SessionGroup>();
  for (const r of rows) {
    const key = by === "project" ? r.projectRoot : r.agent;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: by === "project" ? r.projectName || r.projectRoot : agentName(r.agent), rows: [] };
      groups.set(key, g);
    }
    g.rows.push(r);
  }
  return [...groups.values()];
}
