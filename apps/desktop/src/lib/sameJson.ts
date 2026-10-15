/**
 * 0.3.2: structural equality for small IPC frames (agent records, hub stream snapshots), so a
 * store can skip `set` when a frame repeats what it already holds and nothing re-renders.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
