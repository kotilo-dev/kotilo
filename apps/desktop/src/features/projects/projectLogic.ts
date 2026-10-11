/** Pure helpers for the Projects screen. */
import type { Workspace } from "../../lib/ipc";

function normalize(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** `root` + `relativePath` as an absolute Windows-style path. */
export function joinProjectPath(root: string, relativePath: string): string {
  return `${root.replace(/[\\/]+$/, "")}\\${relativePath.replace(/\//g, "\\").replace(/^\\+/, "")}`;
}

/**
 * The workspace that contains `absolutePath` (the deepest one when workspaces nest) and the
 * path's `rel` inside it (`/`-separated, as the viewer expects). Null when no workspace has it.
 */
export function findWorkspaceFile(workspaces: readonly Pick<Workspace, "id" | "path">[], absolutePath: string): { workspaceId: string; rel: string } | null {
  const target = normalize(absolutePath);
  let best: { workspaceId: string; rel: string; depth: number } | null = null;
  for (const ws of workspaces) {
    const root = normalize(ws.path);
    if (!target.startsWith(`${root}\\`)) continue;
    if (best && root.length <= best.depth) continue;
    const original = absolutePath.replace(/\//g, "\\");
    const rel = original.slice(root.length + 1).replace(/\\/g, "/");
    best = { workspaceId: ws.id, rel, depth: root.length };
  }
  return best ? { workspaceId: best.workspaceId, rel: best.rel } : null;
}
