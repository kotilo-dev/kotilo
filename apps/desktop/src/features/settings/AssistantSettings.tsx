/**
 * Settings → AI, assistant row (M7): the assistant on/off (`buddy.enabled`), its global
 * shortcut (`buddy.hotkey`) with the registration status Rust reports, and "Open assistant".
 * Both settings edit the page draft like the rest of the AI section (save bar).
 */
import { useStrings } from "../../app/i18n";
import type { HubSettings } from "../../lib/hubTypes";
import { assistantOpen } from "../assistant/assistantIpc";
import { useAssistantHotkeyStore } from "../assistant/useAssistantBridge";
import { Button, Checkbox, Field, TextInput } from "./controls";
import { platformFeatures } from "../../lib/platform";

export function AssistantSettings({
  draft,
  update,
  errors,
}: {
  draft: HubSettings;
  update: (change: (d: HubSettings) => HubSettings) => void;
  errors: Record<string, string>;
}) {
  const t = useStrings().assistant.settings;
  const buddy = draft.buddy;
  const reported = useAssistantHotkeyStore((st) => st.status);
  // Only a report about the shortcut in the field counts (an edited field isn't registered yet).
  const same = (a: string) => a.trim().toLowerCase() === buddy.hotkey.trim().toLowerCase();
  const status = reported && (same(reported.configured) || same(reported.hotkey)) ? reported.status : null;
  const statusError = buddy.enabled && status === "taken" ? t.hotkeyTaken : buddy.enabled && status === "invalid" ? t.hotkeyInvalid : null;
  const set = (patch: Partial<HubSettings["buddy"]>) => update((d) => ({ ...d, buddy: { ...d.buddy, ...patch } }));

  return (
    <div className="flex flex-col gap-3" data-testid="assistant-settings">
      <Checkbox checked={buddy.enabled} onChange={(enabled) => set({ enabled })} label={t.enabled} hint={t.enabledHint} />
      {buddy.enabled && (
        <div className="grid items-start gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          {platformFeatures().globalHotkeys ? (
            <Field label={t.hotkey} hint={t.hotkeyHint} error={errors["buddy.hotkey"] ?? statusError}>
              {(ids) => <TextInput {...ids} value={buddy.hotkey} onChange={(hotkey) => set({ hotkey })} />}
            </Field>
          ) : (
            <div />
          )}
          <div className="flex flex-col sm:pt-[22px]">
            <Button small onClick={() => void assistantOpen().catch(() => {})}>
              {t.open}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
