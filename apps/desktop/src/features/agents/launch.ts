/**
 * Launch options wired to the stores: the React hook for the terminal panel's menus and the
 * palette commands ("Agents: New <agent>"), re-registered when the definitions, the installed
 * check or the user's commands change.
 */
import { useMemo } from "react";
import { registerCommand } from "../../app/commands";
import { strings } from "../../app/strings";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { spawnTerminal } from "../terminal/defaultShell";
import { launchOptions, type LaunchOption } from "./launchOptions";

export function useLaunchOptions(): LaunchOption[] {
  const definitions = useDefinitionsStore((s) => s.definitions);
  const installed = useDefinitionsStore((s) => s.installed);
  const commands = useSettingsStore((s) => s.settings.agents.commands);
  return useMemo(() => launchOptions(definitions, installed, commands), [definitions, installed, commands]);
}

function currentLaunchOptions(): LaunchOption[] {
  const { definitions, installed } = useDefinitionsStore.getState();
  return launchOptions(definitions, installed, useSettingsStore.getState().settings.agents.commands);
}

function sameOptions(a: LaunchOption[], b: LaunchOption[]): boolean {
  return a.length === b.length && a.every((o, i) => o.command === b[i]!.command && o.label === b[i]!.label);
}

/** Registers one palette command per launch option; returns the uninstaller. */
export function installLaunchCommands(): () => void {
  let current: LaunchOption[] = [];
  let unregister: Array<() => void> = [];
  function sync() {
    const next = currentLaunchOptions();
    // Value comparison: every settings_set answer carries a new `agents.commands` array.
    if (unregister.length > 0 && sameOptions(current, next)) return;
    unregister.forEach((fn) => fn());
    current = next;
    unregister = next.map((option) =>
      registerCommand({
        id: `agents.new:${option.command}`,
        title: () => strings.commandTitles.newAgent(option.label),
        category: () => strings.commandCategories.agents,
        run: () => {
          const workspaceId = useWorkspaceStore.getState().activeId;
          if (workspaceId) spawnTerminal(workspaceId, option.command);
        },
      }),
    );
  }
  sync();
  const unsubscribeSettings = useSettingsStore.subscribe(sync);
  const unsubscribeDefinitions = useDefinitionsStore.subscribe(sync);
  return () => {
    unregister.forEach((fn) => fn());
    unsubscribeSettings();
    unsubscribeDefinitions();
  };
}
