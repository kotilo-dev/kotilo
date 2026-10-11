/** About → "Check for updates" with the last result (M5). The install itself runs in `UpdatePrompt`. */
import { useStrings } from "../../app/strings";
import type { Strings } from "../../app/i18n";
import type { UpdateCheckResult } from "../../lib/ipc";
import { useUpdateStore, type CheckState } from "./updateStore";

function resultText(s: Strings["update"], result: UpdateCheckResult): { text: string; tone: "muted" | "accent" | "error" } {
  switch (result.status) {
    case "not-configured":
      return { text: s.notConfigured, tone: "muted" };
    case "up-to-date":
      return { text: s.upToDate(result.current), tone: "muted" };
    case "available":
      return { text: s.available(result.version), tone: "accent" };
    case "error":
      return { text: s.checkFailed(result.message), tone: "error" };
  }
}

const TONE = { muted: "text-muted", accent: "text-accent", error: "text-blocked-ink" } as const;

export function UpdateCheck() {
  const s = useStrings().update;
  const check: CheckState = useUpdateStore((st) => st.check);
  const checkNow = useUpdateStore((st) => st.checkNow);
  const checking = check.phase === "checking";
  const result = check.phase === "done" ? resultText(s, check.result) : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={checking}
        onClick={() => void checkNow()}
        className="shrink-0 rounded border border-border px-2 py-1 text-xs text-text disabled:opacity-40"
      >
        {s.checkNow}
      </button>
      <span role="status" aria-live="polite" data-testid="update-check-status" className={result ? TONE[result.tone] : "text-muted"}>
        {checking ? s.checking : (result?.text ?? "")}
      </span>
    </div>
  );
}
