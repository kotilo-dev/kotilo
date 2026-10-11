import { useEffect, useState } from "react";
import { useStrings } from "../../../app/strings";
import { fsOpenDefault, fsReveal, fsStat, isAppError } from "../../../lib/ipc";
import { useToastStore } from "../../../stores/toastStore";
import type { RendererProps } from "./types";

/**
 * Executable extensions the backend rejects in `fs_open_default` (finding #17) — for these the
 * "Open with default app" button is never shown, only "Reveal in Explorer".
 */
const EXECUTABLE_EXTENSIONS = new Set([
  "exe", "com", "scr", "pif", "msi", "msp", "bat", "cmd", "ps1", "psm1", "vbs", "vbe",
  "js", "jse", "wsf", "wsh", "hta", "lnk", "url", "reg", "cpl", "jar", "appref-ms", "application",
]);

function extensionOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIdx]}`;
}

/** Fully functional view for an unsupported binary (Frontend-A) — needs nothing from Frontend-B. */
export function UnsupportedView({ workspaceId, rel }: RendererProps) {
  const strings = useStrings();
  const [size, setSize] = useState<number | null>(null);
  // finding #17: if `fs_open_default` rejects with `invalid_name` (an extension unknown here but
  // still blocked by the backend) — show "Reveal in Explorer" instead of "Open with default app".
  const [blockedByBackend, setBlockedByBackend] = useState(false);
  const showToast = useToastStore((s) => s.show);

  useEffect(() => {
    let cancelled = false;
    setSize(null);
    setBlockedByBackend(false);
    void fsStat(workspaceId, rel).then(
      (stat) => {
        if (!cancelled) setSize(stat.size);
      },
      () => {
        // Without a size nothing is shown; the button still works.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, rel]);

  const isKnownExecutable = EXECUTABLE_EXTENSIONS.has(extensionOf(rel));
  const blocked = isKnownExecutable || blockedByBackend;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-xs text-muted">
      <div>{blocked ? strings.viewer.unsupported.blockedNotice : strings.viewer.unsupported.title}</div>
      {size !== null && <div>{formatSize(size)}</div>}
      {blocked ? (
        <button
          type="button"
          onClick={() => {
            void fsReveal(workspaceId, rel).catch(() => showToast(strings.toast.genericError));
          }}
          className="rounded border border-border px-2 py-1 text-text"
        >
          {strings.contextMenu.revealInExplorer}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            void fsOpenDefault(workspaceId, rel).catch((e) => {
              if (isAppError(e, "invalid_name")) setBlockedByBackend(true);
              else showToast(strings.toast.genericError);
            });
          }}
          className="rounded border border-border px-2 py-1 text-text"
        >
          {strings.viewer.unsupported.openWithDefault}
        </button>
      )}
    </div>
  );
}
