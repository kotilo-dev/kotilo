/**
 * D-057 settings controls: app colour theme pickers (Appearance) and the terminal colour scheme
 * picker + Windows Terminal import (Terminal). Swatch colours come from the theme catalogue /
 * imported scheme data (inline styles), never from literals here.
 */
import { useEffect, useId, useState } from "react";
import { useStrings } from "../../app/i18n";
import { groupByFamily, THEMES, type TerminalColors, type ThemeDef, type ThemeKind } from "../../app/theme/catalogue";
import { terminalColorsOf } from "../../app/theme/derive";
import { useResolvedTheme } from "../../app/theme/resolvedTheme";
import { APP_SCHEME, importedSchemeId, resolveTerminalColors, schemeToColors } from "../../app/theme/terminalScheme";
import { terminalWtSchemes, type TerminalScheme } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settingsStore";
import { Button, Dialog } from "./controls";

const MAX_IMPORTED = 50;

/** Background with a "prompt" line and five colour dots (accent-ish + red/yellow/green/blue). */
export function SchemeSwatch({ colors, className = "" }: { colors: TerminalColors; className?: string }) {
  const dots = [colors.ansi.magenta, colors.ansi.red, colors.ansi.yellow, colors.ansi.green, colors.ansi.blue];
  return (
    <span aria-hidden className={`flex h-9 w-16 shrink-0 flex-col justify-center gap-1 rounded-badge border border-border px-1.5 ${className}`} style={{ background: colors.background }}>
      <span className="block h-1 w-8 rounded-full" style={{ background: colors.foreground }} />
      <span className="flex gap-0.5">
        {dots.map((c, i) => (
          <span key={i} className="block size-1.5 rounded-full" style={{ background: c }} />
        ))}
      </span>
    </span>
  );
}

/** Grid of theme cards grouped by family (radio group). */
export function ThemePicker({ label, kind, value, onChange }: { label: string; kind: ThemeKind; value: string; onChange: (id: string) => void }) {
  const labelId = useId();
  const themes = THEMES.filter((t) => !t.terminalOnly && t.kind === kind);
  const selected = themes.some((t) => t.id === value) ? value : themes[0]!.id;
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-small font-medium text-text-3">
        {label}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-x-3 gap-y-3">
        {groupByFamily(themes).map(([family, members]) => (
          <div key={family} className="flex flex-col gap-1">
            <span className="text-label font-semibold uppercase tracking-[0.08em] text-faint">{family}</span>
            <div className="flex flex-col gap-1.5">
              {members.map((t) => (
                <ThemeCard key={t.id} theme={t} checked={t.id === selected} onSelect={() => onChange(t.id)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ThemeCard({ theme, checked, onSelect }: { theme: ThemeDef; checked: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-theme-id={theme.id}
      onClick={onSelect}
      className={`flex items-center gap-2.5 rounded-control border p-1.5 text-left text-body transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        checked ? "border-accent bg-accent-soft text-text" : "border-border bg-surface-3 text-text-2 hover:bg-surface-4"
      }`}
    >
      <SchemeSwatch colors={terminalColorsOf(theme)} />
      <span className="min-w-0 truncate">{theme.name}</span>
    </button>
  );
}

/** Terminal → colour scheme select (grouped) with a live swatch of the resolved scheme. */
export function TerminalSchemePicker() {
  const s = useStrings();
  const terminal = useSettingsStore((st) => st.settings.terminal);
  const update = useSettingsStore((st) => st.update);
  const appThemeId = useResolvedTheme((st) => st.id);
  const id = useId();
  const imported = terminal.importedSchemes ?? [];
  const value = terminal.colorScheme || APP_SCHEME;
  const known = value === APP_SCHEME || THEMES.some((t) => t.id === value) || imported.some((i) => importedSchemeId(i.name) === value);
  const colors = resolveTerminalColors(value, imported, appThemeId);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-small font-medium text-text-3">
        {s.settings.terminal.colorScheme}
      </label>
      <div className="flex items-center gap-2">
        <select
          id={id}
          value={known ? value : APP_SCHEME}
          onChange={(e) => update({ terminal: { colorScheme: e.target.value } })}
          className="w-full rounded-control border border-border bg-surface-3 px-2 py-1.5 text-ui text-text outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <option value={APP_SCHEME}>{s.settings.terminal.sameAsApp}</option>
          {groupByFamily(THEMES).map(([family, members]) => (
            <optgroup key={family} label={family}>
              {members.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          ))}
          {imported.length > 0 && (
            <optgroup label={s.settings.terminal.importedGroup}>
              {imported.map((i) => (
                <option key={i.name} value={importedSchemeId(i.name)}>
                  {i.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <SchemeSwatch colors={colors} />
      </div>
    </div>
  );
}

/** Imported schemes (with remove) + "Import from Windows Terminal…". */
export function WtSchemeImport() {
  const s = useStrings();
  const terminal = useSettingsStore((st) => st.settings.terminal);
  const update = useSettingsStore((st) => st.update);
  const [found, setFound] = useState<TerminalScheme[] | null>(null);
  const [open, setOpen] = useState(false);
  const imported = terminal.importedSchemes ?? [];

  useEffect(() => {
    let cancelled = false;
    // Via a promise: a missing command (older backend, test mocks) just means "none found".
    Promise.resolve()
      .then(() => terminalWtSchemes())
      .then((list) => {
        if (!cancelled) setFound(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setFound([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = (name: string) => {
    const next = imported.filter((i) => i.name !== name);
    const selectedGone = terminal.colorScheme === importedSchemeId(name);
    update({ terminal: { importedSchemes: next, ...(selectedGone ? { colorScheme: APP_SCHEME } : {}) } });
  };

  const importChosen = (chosen: TerminalScheme[]) => {
    const names = new Set(chosen.map((c) => c.name));
    const next = [...imported.filter((i) => !names.has(i.name)), ...chosen].slice(-MAX_IMPORTED);
    update({ terminal: { importedSchemes: next } });
    setOpen(false);
  };

  const none = found !== null && found.length === 0;

  return (
    <div className="flex flex-col gap-2">
      {imported.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-small font-medium text-text-3">{s.settings.terminal.importedSchemes}</span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {imported.map((i) => (
              <li key={i.name} className="flex items-center gap-2.5 rounded-control border border-border-subtle bg-surface-3 p-1.5">
                <SchemeSwatch colors={schemeToColors(i)} />
                <span className="min-w-0 flex-1 truncate text-body text-text">{i.name}</span>
                <Button small variant="ghost" ariaLabel={s.settings.terminal.removeScheme(i.name)} onClick={() => remove(i.name)}>
                  {s.settings.terminal.remove}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-col items-start gap-1">
        <Button small disabled={found === null || none} onClick={() => setOpen(true)}>
          {s.settings.terminal.importWt}
        </Button>
        {none && <span className="text-meta text-muted">{s.settings.terminal.importNone}</span>}
      </div>
      {open && found && <WtImportDialog schemes={found} importedNames={new Set(imported.map((i) => i.name))} onCancel={() => setOpen(false)} onImport={importChosen} />}
    </div>
  );
}

function WtImportDialog({
  schemes,
  importedNames,
  onCancel,
  onImport,
}: {
  schemes: TerminalScheme[];
  importedNames: Set<string>;
  onCancel: () => void;
  onImport: (chosen: TerminalScheme[]) => void;
}) {
  const s = useStrings();
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const toggle = (name: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  return (
    <Dialog
      title={s.settings.terminal.importTitle}
      onCancel={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{s.settings.terminal.importCancel}</Button>
          <Button variant="primary" disabled={chosen.size === 0} onClick={() => onImport(schemes.filter((x) => chosen.has(x.name)))}>
            {s.settings.terminal.importAction(chosen.size)}
          </Button>
        </>
      }
    >
      <p className="m-0 text-body text-muted">{s.settings.terminal.importHint}</p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {schemes.map((x) => (
          <li key={x.name}>
            <label className="flex cursor-pointer items-center gap-2.5 rounded-control border border-border-subtle bg-surface-3 p-1.5 text-body text-text">
              <input type="checkbox" className="size-4 accent-accent" checked={chosen.has(x.name)} onChange={(e) => toggle(x.name, e.target.checked)} />
              <SchemeSwatch colors={schemeToColors(x)} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{x.name}</span>
                {importedNames.has(x.name) && <span className="text-meta text-muted">{s.settings.terminal.alreadyImported}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
