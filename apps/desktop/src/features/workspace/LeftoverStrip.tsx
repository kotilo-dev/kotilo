/**
 * 0.3.2: the agent exited but processes it started still run under the pane's shell (a dev
 * server, a script). A warning strip above the terminal names them; **Stop** terminates the
 * shell's descendants (Rust `pty_stop_leftovers`), the shell itself stays. Nothing is killed
 * automatically.
 */
import { useState } from "react";
import { useStrings } from "../../app/i18n";
import { ptyStopLeftovers } from "../../lib/ipc";
import { useLeftoverStore } from "../../stores/leftoverStore";

const MAX_NAMES = 3;

export function LeftoverStrip({ paneId }: { paneId: string }) {
  const s = useStrings();
  const processes = useLeftoverStore((st) => st.byPane[paneId]);
  const clear = useLeftoverStore((st) => st.clear);
  const [stopping, setStopping] = useState(false);
  if (!processes || processes.length === 0) return null;

  const names = [...new Set(processes)];
  const shown = names.slice(0, MAX_NAMES).join(", ") + (names.length > MAX_NAMES ? ", …" : "");

  async function stop() {
    setStopping(true);
    try {
      await ptyStopLeftovers(paneId);
    } catch {
      // The strip stays; Rust clears it with an empty `pty:leftover` once they exit.
    } finally {
      setStopping(false);
    }
  }

  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2.5 border-b border-working/35 bg-working-bg px-3 py-1.5 text-small text-working-ink"
    >
      <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3l9.5 17h-19z" />
        <path d="M12 10v4M12 17h.01" />
      </svg>
      <span className="min-w-0 flex-1 truncate" title={names.join(", ")}>
        {s.workspace.leftover.message(processes.length, shown)}
      </span>
      <button
        type="button"
        disabled={stopping}
        onClick={() => void stop()}
        className="h-[26px] shrink-0 rounded-button border border-working/45 bg-transparent px-3 text-small font-medium text-working-ink hover:bg-surface-5 disabled:opacity-50"
      >
        {s.workspace.leftover.stop}
      </button>
      <button
        type="button"
        aria-label={s.workspace.leftover.dismiss}
        title={s.workspace.leftover.dismiss}
        onClick={() => clear(paneId)}
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-control text-working-ink hover:bg-surface-5"
      >
        <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
