/** D-081: palette commands that step the interface scale (no keybinding). */
import { useSettingsStore } from "../../stores/settingsStore";
import { registerCommand } from "../commands";
import { strings } from "../strings";
import { DEFAULT_UI_SCALE, nextUiScale, previousUiScale } from "./uiScale";

function setScale(pick: (current: number | undefined) => number): void {
  const store = useSettingsStore.getState();
  void store.update({ appearance: { uiScale: pick(store.settings.appearance?.uiScale) } });
}

export function registerUiScaleCommands(): Array<() => void> {
  const category = () => strings.commandCategories.preferences;
  return [
    registerCommand({ id: "ui.scaleUp", title: () => strings.commandTitles.uiScaleIncrease, category, run: () => setScale(nextUiScale) }),
    registerCommand({ id: "ui.scaleDown", title: () => strings.commandTitles.uiScaleDecrease, category, run: () => setScale(previousUiScale) }),
    registerCommand({ id: "ui.scaleReset", title: () => strings.commandTitles.uiScaleReset, category, run: () => setScale(() => DEFAULT_UI_SCALE) }),
  ];
}
