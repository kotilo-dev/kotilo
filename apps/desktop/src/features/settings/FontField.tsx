/**
 * A font family setting: free text (a CSS font list still works) plus a list of the installed
 * families to pick from. The list comes from the platform layer once per app run; where it is
 * empty (no platform list yet) only the text field shows.
 */
import { useEffect, useState } from "react";
import { useStrings } from "../../app/i18n";
import { fontsInstalled } from "../../lib/ipc";
import { DebouncedText, Select } from "./controls";

let cache: Promise<string[]> | null = null;

function loadFonts(): Promise<string[]> {
  cache ??= fontsInstalled().catch(() => []);
  return cache;
}

/** Test hook: forget the cached list. */
export function resetInstalledFontsCache(): void {
  cache = null;
}

function useInstalledFonts(): string[] {
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void loadFonts().then((list) => {
      if (alive) setFonts(list);
    });
    return () => {
      alive = false;
    };
  }, []);
  return fonts;
}

/** The first family of a CSS font list, without quotes. */
export function firstFamily(value: string): string {
  return (value.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}

export function FontField({
  id,
  value,
  onCommit,
  placeholder,
  fallback,
}: {
  id?: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  /** Appended to a picked family (e.g. `monospace`); without it the bare name is stored. */
  fallback?: string;
}) {
  const s = useStrings();
  const fonts = useInstalledFonts();
  const current = firstFamily(value).toLowerCase();
  const picked = fonts.find((f) => f.toLowerCase() === current) ?? "";

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <DebouncedText id={id} value={value} placeholder={placeholder} onCommit={onCommit} />
      </div>
      {fonts.length > 0 && (
        <div className="w-44 shrink-0">
          <Select<string>
            ariaLabel={s.settings.appearance.installedFonts}
            value={picked}
            onChange={(f) => {
              if (f !== "") onCommit(fallback ? `"${f}", ${fallback}` : f);
            }}
            options={[{ value: "", label: s.settings.appearance.installedFonts }, ...fonts.map((f) => ({ value: f, label: f }))]}
          />
        </div>
      )}
    </div>
  );
}
