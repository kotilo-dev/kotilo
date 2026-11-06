/** D-072: Settings → Agents → "Connect to Kotilo Deck" and the connection status. */
import { useStrings } from "../../app/i18n";
import type { CompanionStatus } from "../../lib/ipc";
import { useCompanionStore } from "../../stores/companionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Checkbox } from "../settings/controls";

export function companionStatusText(status: CompanionStatus, t: ReturnType<typeof useStrings>["companion"]["status"]): string {
  switch (status.state) {
    case "connected":
      return t.connected(status.serverVersion);
    case "off":
      return t.off;
    case "rejected":
      return t.rejected;
    case "untrusted":
      return t.untrusted;
    case "tokenError":
      return t.tokenError;
    default:
      return t.notRunning;
  }
}

export function CompanionSettings() {
  const s = useStrings();
  const enabled = useSettingsStore((st) => st.settings.companion?.enabled ?? true);
  const update = useSettingsStore((st) => st.update);
  const status = useCompanionStore((st) => st.status);
  const shown: CompanionStatus = enabled ? status : { state: "off" };
  const warn = shown.state === "rejected" || shown.state === "untrusted" || shown.state === "tokenError";
  return (
    <div data-companion-settings className="flex max-w-lg flex-col gap-1.5">
      <span className="text-small font-medium text-text-3">{s.companion.title}</span>
      <Checkbox checked={enabled} onChange={(v) => update({ companion: { enabled: v } })} label={s.companion.enabled} hint={s.companion.hint} />
      {enabled && (
        <span data-companion-status={shown.state} role="status" className={`pl-6 text-small ${warn ? "text-blocked-ink" : "text-muted"}`}>
          {companionStatusText(shown, s.companion.status)}
        </span>
      )}
    </div>
  );
}
