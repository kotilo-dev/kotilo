/**
 * Settings filter: which sections show for a query. A section matches by its name or by any
 * field label it contains (taken from the i18n strings, so it works in both languages).
 */
import type { Strings } from "../../app/i18n/en";
import { currentLanguage } from "../../app/i18n";
import type { SettingsSectionId } from "./SettingsPage";

function values(o: Record<string, unknown>, keys: readonly string[]): string[] {
  return keys.map((k) => o[k]).filter((v): v is string => typeof v === "string");
}

/** Searchable texts per section (name first). */
export function sectionTexts(s: Strings, id: SettingsSectionId): string[] {
  const t = s.settingsPage;
  const st = s.settings;
  const name = t.sections[id];
  switch (id) {
    case "appearance":
      return [
        name,
        ...values(st.appearance, ["mode", "language", "uiScale", "uiFontFamily", "darkTheme", "lightTheme", "windowOpacity", "acrylic"]),
        st.about.closeToTray,
        s.update.checkOnStart,
        ...values(t.groups, ["mode", "text", "window", "general"]),
      ];
    case "mascot":
      return [name, ...values(s.mascot, ["enabled", "size", "placement", "placementTaskbar", "placementCorner", "celebrate"])];
    case "editor":
      return [name, ...values(st.appearance, ["editorFontFamily", "editorFontSize"])];
    case "terminal":
      return [name, ...values(st.terminal, ["fontFamily", "fontSize", "defaultShell", "copyOnSelect", "warnMultilinePaste", "osc52Clipboard", "bundledConpty", "colorScheme"]), s.worktrees.settings.branchPrefix];
    case "quickCommands":
      return [name, ...values(s.quickCommands, ["intro", "kindCommand", "kindPrompt", "commandsGroup", "promptsGroup", "add"])];
    case "files":
      return [name, ...values(st.files, ["hiddenPatterns", "respectGitignore"]), st.clipboard.copyPathAfterImageSave];
    case "agents":
      return [name, t.agents.integrations, t.groups.launch, t.groups.deck, s.agentSetup.addCustom];
    case "ai":
      return [name, ...values(s.ai, ["features", "cliProviders", "endpoints", "provider", "model", "addEndpoint", "fullyLocal"]), ...Object.values(s.ai.featureNames)];
    case "notifications":
      return [name, ...values(t.notifications, ["language", "rules", "quietHours", "dnd", "waitingPermission", "waitingInput", "completed", "stale", "reminder", "contextHigh"]), st.agents.notifications, st.agents.awaySummary, ...values(s.watch.settings, ["title", "enabled", "builtins", "userRules", "add", "test", "projects"])];
    case "usage":
      return [name, ...values(t.usage, ["rules", "dailyCost", "pricing", "dailySummary"])];
    case "projects":
      return [name, ...values(t.projects, ["tasksGlob", "folders", "git", "uncommittedThreshold"])];
    case "tasks":
      return [name, ...values(t.tasks, ["hotkey", "reminders"])];
    case "dictation":
      return [name, ...values(t.dictation, ["enabled", "hotkey", "pasteLastHotkey", "model"])];
    case "about":
      return [name, ...values(st.about, ["verboseLogging", "openLogsFolder"])];
  }
}

const COMBINING_DOT = new RegExp(String.fromCharCode(0x307), "g");
const DOTLESS_I = new RegExp(String.fromCharCode(0x131), "g");

/** Lower-cased in the UI language, with the Turkish dotted/dotless i folded to a plain i on both sides. */
export function foldForSearch(text: string, lang: string): string {
  return text.toLocaleLowerCase(lang).replace(COMBINING_DOT, "").replace(DOTLESS_I, "i");
}

export function sectionMatches(s: Strings, id: SettingsSectionId, query: string, lang: string = currentLanguage()): boolean {
  const q = foldForSearch(query.trim(), lang);
  if (q === "") return true;
  return sectionTexts(s, id).some((x) => foldForSearch(x, lang).includes(q));
}
