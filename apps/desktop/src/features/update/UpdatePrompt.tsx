/**
 * Non-blocking update prompt (M5): a floating card in the bottom right (DESIGN_SYSTEM §7.11
 * `rise`) with the new version, its notes and "Install and restart" / "Later". Installing shows
 * the download progress; a failure stays in the card with "Try again".
 */
import { useEffect, useState } from "react";
import { formatNumber } from "../../app/i18n";
import { useStrings } from "../../app/strings";
import { ProgressBar } from "../../app/ui";
import { Button } from "../../app/ui/Button";
import { useUpdateStore } from "./updateStore";

function formatMegabytes(bytes: number): string {
  return `${formatNumber(bytes / 1_048_576, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

export function UpdatePrompt() {
  const s = useStrings().update;
  const prompt = useUpdateStore((st) => st.prompt);
  const install = useUpdateStore((st) => st.install);
  const installUpdate = useUpdateStore((st) => st.installUpdate);
  const dismiss = useUpdateStore((st) => st.dismissPrompt);
  // "Hide" only hides the card: the download keeps running and an error brings it back.
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (install.phase === "error" || install.phase === "idle") setHidden(false);
  }, [install.phase]);
  if (!prompt || hidden) return null;

  const percent =
    install.phase === "downloading" && install.total ? Math.min(100, Math.round((install.downloaded / install.total) * 100)) : null;

  return (
    <section
      role="region"
      aria-label={s.promptLabel}
      data-testid="update-prompt"
      className="fixed bottom-9 right-3 z-[90] flex w-[360px] animate-rise flex-col gap-3 rounded-panel border border-border bg-surface-4 p-4 text-ui text-text shadow-float"
    >
      <header className="flex flex-col gap-0.5">
        <h2 className="m-0 text-title font-semibold">{install.phase === "error" ? s.failedTitle : s.promptTitle(prompt.version)}</h2>
        <span className="text-meta text-muted">{s.promptCurrent(prompt.current, prompt.date)}</span>
      </header>

      {prompt.notes && (
        <div className="flex flex-col gap-1">
          <span className="text-label font-semibold uppercase tracking-[0.08em] text-faint">{s.notesLabel}</span>
          <p className="m-0 max-h-32 overflow-auto whitespace-pre-wrap text-small text-text-2">{prompt.notes}</p>
        </div>
      )}

      {install.phase === "downloading" && (
        <div className="flex flex-col gap-1.5" aria-live="polite">
          <div className="flex items-center justify-between text-small text-text-2">
            <span>{s.downloading(percent)}</span>
            <span className="font-mono text-label text-muted">
              {s.downloadedSize(formatMegabytes(install.downloaded), install.total ? formatMegabytes(install.total) : null)}
            </span>
          </div>
          <ProgressBar value={percent === null ? 0 : percent / 100} label={s.progressLabel} />
        </div>
      )}
      {install.phase === "ready" && (
        <p role="status" className="m-0 text-small text-text-2">
          {s.ready}
        </p>
      )}
      {install.phase === "error" && (
        <p role="alert" className="m-0 text-small text-blocked-ink">
          {s.installFailed(install.message)}
        </p>
      )}

      {install.phase !== "ready" && (
        <div className="flex justify-end gap-2">
          {install.phase === "downloading" ? (
            <Button variant="ghost" onClick={() => setHidden(true)}>
              {s.hide}
            </Button>
          ) : install.phase === "error" ? (
            <>
              <Button variant="ghost" onClick={dismiss}>
                {s.later}
              </Button>
              <Button variant="primary" onClick={() => void installUpdate()}>
                {s.retry}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={dismiss}>
                {s.later}
              </Button>
              <Button variant="primary" onClick={() => void installUpdate()}>
                {s.install}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
