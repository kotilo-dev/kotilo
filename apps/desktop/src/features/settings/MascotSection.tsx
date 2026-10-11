/**
 * Settings → Mascot (M6): the robot snail on/off, size, placement and celebration. Saved at once
 * through `useMascotSettingsStore` (only `buddy` changes; the page's hub draft is untouched).
 */
import { useEffect, useState, type CSSProperties } from "react";
import { formatDateTime, useStrings } from "../../app/i18n";
import type { BuddySettings } from "../../lib/hubTypes";
import { MascotSnail } from "../mascot/MascotSnail";
import { hiddenUntilMs, normalizeScale, type MascotScale } from "../mascot/mascotLogic";
import "../mascot/mascot.css";
import { Button, Checkbox, Notice, SectionLabel, Segmented } from "./controls";
import { useMascotSettingsStore } from "./mascotSettings";

type WalkArea = BuddySettings["walkArea"];

/** Static snail at the chosen size (16 px × scale tall, as on the desktop). */
function Preview({ scale }: { scale: MascotScale }) {
  const height = 16 * scale;
  const style = { width: height * 1.25, height, "--ms-led": "var(--mascot-working)" } as CSSProperties;
  return (
    <div className="flex h-[88px] w-[120px] shrink-0 items-end justify-center rounded-card border border-border-subtle bg-surface-3 pb-2" data-testid="mascot-preview">
      <div style={style}>
        <MascotSnail direction="right" />
      </div>
    </div>
  );
}

export function MascotSection() {
  const s = useStrings();
  const t = s.mascot;
  const settings = useMascotSettingsStore((st) => st.settings);
  const load = useMascotSettingsStore((st) => st.load);
  const saveBuddy = useMascotSettingsStore((st) => st.saveBuddy);
  const [loaded, setLoaded] = useState(settings !== null);

  useEffect(() => {
    if (settings) return;
    void load().finally(() => setLoaded(true));
    // Load once when the section opens without settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!settings) return loaded ? <Notice tone="warning">{s.settingsPage.hubUnavailable}</Notice> : null;

  const buddy = settings.buddy;
  const scale = normalizeScale(buddy.mascotScale);
  const hiddenUntil = hiddenUntilMs(buddy, Date.now());
  const set = (patch: Partial<BuddySettings>) => void saveBuddy((b) => ({ ...b, ...patch }));

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="flex items-start gap-5">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <Checkbox checked={buddy.mascotEnabled} onChange={(mascotEnabled) => set({ mascotEnabled, mascotOffered: true })} label={t.enabled} hint={t.enabledHint} />
          {buddy.mascotEnabled && hiddenUntil !== null && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-ui text-text-2">{t.hiddenUntil(formatDateTime(new Date(hiddenUntil), { timeStyle: "short" }))}</span>
              <Button small onClick={() => set({ mascotHiddenUntil: null })}>
                {t.showNow}
              </Button>
            </div>
          )}
        </div>
        <Preview scale={scale} />
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>{t.size}</SectionLabel>
        <Segmented<"2" | "3" | "4">
          ariaLabel={t.size}
          value={String(scale) as "2" | "3" | "4"}
          onChange={(v) => set({ mascotScale: Number(v) })}
          options={[
            { value: "2", label: t.sizeSmall },
            { value: "3", label: t.sizeMedium },
            { value: "4", label: t.sizeLarge },
          ]}
        />
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>{t.placement}</SectionLabel>
        <Segmented<WalkArea>
          ariaLabel={t.placement}
          value={buddy.walkArea}
          onChange={(walkArea) => set({ walkArea })}
          options={[
            { value: "taskbar", label: t.placementTaskbar },
            { value: "corner", label: t.placementCorner },
          ]}
        />
      </div>

      <Checkbox checked={buddy.celebrate} onChange={(celebrate) => set({ celebrate })} label={t.celebrate} hint={t.celebrateHint} />
    </div>
  );
}
