/**
 * Pure path helpers: the workspace tree works with `rel` everywhere (relative to the workspace
 * root, `/`-separated, `""` for the root; faz2-spec §2). No IPC/DOM; fully tested with Vitest.
 */
import type { Workspace } from "../../lib/ipc";

/** The parent's rel. The parent of the root (`""`) and of its direct children is `""`. */
export function parentRel(rel: string): string {
  if (rel === "") return "";
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? "" : rel.slice(0, idx);
}

/** The last component of `rel` (file/folder name); `""` for the root. */
export function baseName(rel: string): string {
  if (rel === "") return "";
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? rel : rel.slice(idx + 1);
}

/** Folder rel + name → the new entry's rel. */
export function joinRel(dirRel: string, name: string): string {
  return dirRel === "" ? name : `${dirRel}/${name}`;
}

/** `rel === ancestor`, or does `rel` start with `ancestor + "/"` (a descendant)? */
export function isSameOrDescendant(rel: string, ancestor: string): boolean {
  if (ancestor === "") return true; // everything is the root or below it
  return rel === ancestor || rel.startsWith(`${ancestor}/`);
}

/** Depth by the number of `/` in `rel` (root = 0), for parent-first sorting. */
export function depthOf(rel: string): number {
  return rel === "" ? 0 : rel.split("/").length;
}

/** Absolute path: `ws.path` + rel with Windows `\` separators (faz2-spec §6 "Copy path"). */
export function absolutePath(ws: Pick<Workspace, "path">, rel: string): string {
  if (rel === "") return ws.path;
  const winRel = rel.split("/").join("\\");
  const sep = ws.path.endsWith("\\") ? "" : "\\";
  return `${ws.path}${sep}${winRel}`;
}

/**
 * Returns a new `Record` with keys matching `oldPrefix` (itself or below) moved to `newPrefix`
 * (for `dirCache` etc. when a folder is renamed, faz2-spec §8.17).
 */
export function rekeyRecordPrefix<T>(record: Record<string, T>, oldPrefix: string, newPrefix: string): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSameOrDescendant(key, oldPrefix)) {
      const rest = key.slice(oldPrefix.length); // "" or "/..."
      next[`${newPrefix}${rest}`] = value;
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** Returns a new `Record` without the keys matching `prefix` (itself or below). */
export function pruneRecordPrefix<T>(record: Record<string, T>, prefix: string): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isSameOrDescendant(key, prefix)) next[key] = value;
  }
  return next;
}

/** The same rekey logic for a `Set<string>` (the `expanded` state). */
export function rekeySetPrefix(set: Set<string>, oldPrefix: string, newPrefix: string): Set<string> {
  const next = new Set<string>();
  for (const key of set) {
    if (isSameOrDescendant(key, oldPrefix)) {
      const rest = key.slice(oldPrefix.length);
      next.add(`${newPrefix}${rest}`);
    } else {
      next.add(key);
    }
  }
  return next;
}

/** The same prune logic for a `Set<string>`. */
export function pruneSetPrefix(set: Set<string>, prefix: string): Set<string> {
  const next = new Set<string>();
  for (const key of set) {
    if (!isSameOrDescendant(key, prefix)) next.add(key);
  }
  return next;
}

/** The rels of all ancestors of `rel` up to the root, starting at the root (parent-first). */
export function ancestorsOf(rel: string): string[] {
  const result: string[] = [];
  let cur = parentRel(rel);
  const seen: string[] = [];
  while (true) {
    seen.push(cur);
    if (cur === "") break;
    cur = parentRel(cur);
  }
  for (let i = seen.length - 1; i >= 0; i--) result.push(seen[i]!);
  return result;
}
