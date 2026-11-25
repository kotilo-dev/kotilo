import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { gitHead, type GitHead } from "../../lib/ipc";

const GIT_HEAD_POLL_MS = 5000;

/**
 * Git head (branch / detached SHA) of a workspace (faz6-spec §6). Refreshed immediately when the
 * workspace changes or the window gains focus, and every 5 s while focused; polling stops while
 * unfocused. `null` without a repo (or while loading).
 */
export function useGitHead(workspaceId: string): GitHead | null {
  const [head, setHead] = useState<GitHead | null>(null);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;

    async function refresh() {
      try {
        const result = await gitHead(workspaceId);
        if (!cancelled) setHead(result);
      } catch {
        if (!cancelled) setHead(null);
      }
    }

    function startPolling() {
      if (interval) return;
      interval = setInterval(() => void refresh(), GIT_HEAD_POLL_MS);
    }
    function stopPolling() {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    }

    void refresh();

    let unlistenFocus: (() => void) | undefined;
    const win = getCurrentWindow();
    void win.isFocused().then((focused) => {
      if (!cancelled && focused) startPolling();
    });
    void win
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          void refresh();
          startPolling();
        } else {
          stopPolling();
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenFocus = fn;
      });

    return () => {
      cancelled = true;
      stopPolling();
      unlistenFocus?.();
    };
  }, [workspaceId]);

  return head;
}
