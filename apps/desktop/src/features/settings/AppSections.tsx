/**
 * Settings sections stored by the desktop app (`settings_get/set`, applied immediately, as the
 * old Settings dialog did): appearance, editor, terminal, files, about. Agents lives in
 * `AgentsSection.tsx`.
 */
import { useState } from "react";
import { useStrings, useI18nStore, type LanguagePreference } from "../../app/i18n";
import { AboutPanel } from "../../app/AboutPanel";
import { openLogsFolder } from "../../app/diagnosticsActions";
import type { ShellKind, ThemeName } from "../../lib/ipc";
import { useHelpStore } from "../help/helpStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { platformFeatures } from "../../lib/platform";
import { useTerminalStore } from "../../stores/terminalStore";
import { effectiveTerminalFont, getTerminalFontSuggestion } from "../terminal/terminalRegistry";
import { applyWindowOpacity } from "../../app/theme/applyTheme";
import { Button, Checkbox, DebouncedNumber, DebouncedText, Field, RangeSlider, Select } from "./controls";
import { EditableList } from "./EditableList";
import { TerminalSchemePicker, ThemePicker, WtSchemeImport } from "./ThemeSettings";

/** D-065: the range of Settings → Appearance → Background opacity (the backend clamps the same). */
const MIN_WINDOW_OPACITY = 30;

export function AppearanceSection() {
  const s = useStrings();
  const features = platformFeatures();
  const theme = useSettingsStore((st) => st.settings.theme);
  const appearance = useSettingsStore((st) => st.settings.appearance);
  const update = useSettingsStore((st) => st.update);
  const language = useI18nStore((st) => st.preference);
  const setLanguage = useI18nStore((st) => st.setPreference);

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div className="flex max-w-md flex-col gap-5">
        <Field label={s.settings.appearance.theme} hint={theme === "system" ? s.settings.appearance.themeSystemHint : undefined}>
          {(ids) => (
            <Select<ThemeName>
              {...ids}
              value={theme}
              onChange={(v) => update({ theme: v })}
              options={[
                { value: "dark", label: s.settings.appearance.themeDark },
                { value: "light", label: s.settings.appearance.themeLight },
                { value: "system", label: s.settings.appearance.themeSystem },
              ]}
            />
          )}
        </Field>
        <Field label={s.settings.appearance.language}>
          {(ids) => (
            <Select<LanguagePreference>
              {...ids}
              value={language}
              onChange={setLanguage}
              options={[
                { value: "system", label: s.settings.appearance.languageSystem },
                { value: "en", label: s.settings.appearance.languageEnglish },
                { value: "tr", label: s.settings.appearance.languageTurkish },
              ]}
            />
          )}
        </Field>
        <Field label={s.settings.appearance.windowOpacity} hint={s.settings.appearance.windowOpacityHint}>
          {({ id }) => (
            <RangeSlider
              id={id}
              value={appearance?.windowOpacity ?? 100}
              min={MIN_WINDOW_OPACITY}
              max={100}
              format={(v) => `${v}%`}
              onPreview={(v) => applyWindowOpacity(v)}
              onCommit={(v) => update({ appearance: { windowOpacity: v } })}
            />
          )}
        </Field>
        {features.windowAcrylic && (
          <Checkbox
            checked={appearance?.acrylic ?? false}
            onChange={(v) => update({ appearance: { acrylic: v } })}
            label={s.settings.appearance.acrylic}
            hint={s.settings.appearance.acrylicHint}
          />
        )}
      </div>
      {theme !== "light" && (
        <ThemePicker
          label={s.settings.appearance.darkTheme}
          kind="dark"
          value={appearance?.darkTheme ?? ""}
          onChange={(id) => update({ appearance: { darkTheme: id } })}
        />
      )}
      {theme !== "dark" && (
        <ThemePicker
          label={s.settings.appearance.lightTheme}
          kind="light"
          value={appearance?.lightTheme ?? ""}
          onChange={(id) => update({ appearance: { lightTheme: id } })}
        />
      )}
    </div>
  );
}

export function EditorSection() {
  const s = useStrings();
  const editor = useSettingsStore((st) => st.settings.editor);
  const update = useSettingsStore((st) => st.update);
  return (
    <div className="flex max-w-md flex-col gap-5">
      <Field label={s.settings.appearance.editorFontFamily}>
        {({ id }) => <DebouncedText id={id} value={editor.fontFamily} onCommit={(v) => update({ editor: { fontFamily: v } })} />}
      </Field>
      <Field label={s.settings.appearance.editorFontSize}>
        {({ id }) => <DebouncedNumber id={id} value={editor.fontSize} onCommit={(v) => update({ editor: { fontSize: v } })} />}
      </Field>
    </div>
  );
}

export function TerminalSection() {
  const s = useStrings();
  const terminal = useSettingsStore((st) => st.settings.terminal);
  const update = useSettingsStore((st) => st.update);
  const profiles = useTerminalStore((st) => st.profiles);
  const detected = getTerminalFontSuggestion();
  const usesDetected = detected !== null && effectiveTerminalFont(terminal.fontFamily) !== terminal.fontFamily;
  const features = platformFeatures();

  return (
    <div className="flex max-w-md flex-col gap-5">
      <Field label={s.settings.terminal.fontFamily} hint={usesDetected ? s.settings.terminal.fontDetected(detected) : undefined}>
        {({ id }) => <DebouncedText id={id} value={terminal.fontFamily} onCommit={(v) => update({ terminal: { fontFamily: v } })} />}
      </Field>
      <Field label={s.settings.terminal.fontSize}>
        {({ id }) => <DebouncedNumber id={id} value={terminal.fontSize} onCommit={(v) => update({ terminal: { fontSize: v } })} />}
      </Field>
      <Field label={s.settings.terminal.defaultShell}>
        {(ids) => (
          <Select<string>
            {...ids}
            value={terminal.defaultShell ?? ""}
            onChange={(v) => update({ terminal: { defaultShell: (v || null) as ShellKind | null } })}
            options={[{ value: "", label: s.settings.terminal.automatic }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
          />
        )}
      </Field>
      <Checkbox checked={terminal.copyOnSelect} onChange={(v) => update({ terminal: { copyOnSelect: v } })} label={s.settings.terminal.copyOnSelect} />
      <Checkbox checked={terminal.warnMultilinePaste} onChange={(v) => update({ terminal: { warnMultilinePaste: v } })} label={s.settings.terminal.warnMultilinePaste} />
      <Checkbox
        checked={terminal.osc52Clipboard ?? true}
        onChange={(v) => update({ terminal: { osc52Clipboard: v } })}
        label={s.settings.terminal.osc52Clipboard}
        hint={s.settings.terminal.osc52ClipboardHint}
      />
      {features.bundledConpty && (
        <Checkbox
          checked={terminal.bundledConpty}
          onChange={(v) => update({ terminal: { bundledConpty: v } })}
          label={s.settings.terminal.bundledConpty}
          hint={s.settings.terminal.bundledConptyHint}
        />
      )}
      <TerminalSchemePicker />
      {features.windowsTerminalSchemes && <WtSchemeImport />}
    </div>
  );
}

export function FilesSection() {
  const s = useStrings();
  const settings = useSettingsStore((st) => st.settings);
  const update = useSettingsStore((st) => st.update);
  const lastError = useSettingsStore((st) => st.lastError);
  return (
    <div className="flex max-w-lg flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <span className="text-small font-medium text-text-3">{s.settings.files.hiddenPatterns}</span>
        <EditableList
          items={settings.files.hiddenPatterns}
          onChange={(next) => update({ files: { hiddenPatterns: next } })}
          addPlaceholder={s.settings.files.addPatternPlaceholder}
          addLabel={s.settings.files.addPattern}
          removeLabel={s.settings.files.removePattern}
          emptyLabel=""
          listLabel={s.settings.files.hiddenPatterns}
        />
        {lastError?.code === "invalid_argument" && (
          <span role="alert" className="text-meta text-blocked-ink">
            {lastError.message}
          </span>
        )}
      </div>
      <Checkbox checked={settings.files.respectGitignore} onChange={(v) => update({ files: { respectGitignore: v } })} label={s.settings.files.respectGitignore} />
      <Checkbox
        checked={settings.clipboard.copyPathAfterImageSave}
        onChange={(v) => update({ clipboard: { copyPathAfterImageSave: v } })}
        label={s.settings.clipboard.copyPathAfterImageSave}
      />
    </div>
  );
}

export { AgentsSection } from "./AgentsSection";

export function AboutSection() {
  const s = useStrings();
  const verbose = useSettingsStore((st) => st.settings.diagnostics.verboseLogging);
  const checkUpdatesOnStart = useSettingsStore((st) => st.settings.updates?.checkOnStart !== false);
  const closeToTray = useSettingsStore((st) => st.settings.window?.closeToTray === true);
  const update = useSettingsStore((st) => st.update);
  const [openingLogs, setOpeningLogs] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <AboutPanel />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => useHelpStore.getState().openHelp()}>{s.settings.about.openHelp}</Button>
        <Button
          disabled={openingLogs}
          onClick={() => {
            setOpeningLogs(true);
            void openLogsFolder().finally(() => setOpeningLogs(false));
          }}
        >
          {s.settings.about.openLogsFolder}
        </Button>
      </div>
      <Checkbox
        checked={closeToTray}
        onChange={(v) => update({ window: { closeToTray: v } })}
        label={s.settings.about.closeToTray}
        hint={s.settings.about.closeToTrayHint}
      />
      <Checkbox
        checked={checkUpdatesOnStart}
        onChange={(v) => update({ updates: { checkOnStart: v } })}
        label={s.update.checkOnStart}
      />
      <Checkbox checked={verbose}onChange={(v) => update({ diagnostics: { verboseLogging: v } })} label={s.settings.about.verboseLogging} />
      <span className="text-small text-muted">{s.settings.about.privacyNote}</span>
    </div>
  );
}
