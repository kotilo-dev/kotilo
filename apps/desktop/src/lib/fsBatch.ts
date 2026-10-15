/**
 * 0.3.2: `fs:changed` arrives in bursts while an agent builds or installs packages. Each store
 * handles it through this throttle: the first event of a quiet period is handled at once, later
 * ones are merged (deduplicated dirs per workspace) and handled at most once per `windowMs`.
 */
import type { FsChangedPayload } from "./ipc";

export const FS_BATCH_MS = 250;

export function batchFsChanges(
  flush: (payload: FsChangedPayload) => void,
  windowMs = FS_BATCH_MS,
): (payload: FsChangedPayload) => void {
  const pending = new Map<string, Set<string>>();
  const cooling = new Map<string, ReturnType<typeof setTimeout>>();

  const cool = (workspaceId: string) => {
    cooling.set(
      workspaceId,
      setTimeout(() => {
        cooling.delete(workspaceId);
        const dirs = pending.get(workspaceId);
        if (!dirs || dirs.size === 0) return;
        pending.delete(workspaceId);
        flush({ workspaceId, dirs: [...dirs] });
        cool(workspaceId);
      }, windowMs),
    );
  };

  return (payload) => {
    if (!cooling.has(payload.workspaceId)) {
      flush({ workspaceId: payload.workspaceId, dirs: [...new Set(payload.dirs)] });
      cool(payload.workspaceId);
      return;
    }
    const dirs = pending.get(payload.workspaceId) ?? new Set<string>();
    for (const d of payload.dirs) dirs.add(d);
    pending.set(payload.workspaceId, dirs);
  };
}
