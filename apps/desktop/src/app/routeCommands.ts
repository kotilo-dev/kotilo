/** Palette entries + Alt+n shortcuts for the app routes (M2 shell). */
import { registerCommand } from "./commands";
import { strings } from "./strings";
import { ROUTES, routeShortcut } from "./routes";
import { useRouteStore } from "../stores/routeStore";

/** Registers one command per route; returns the unregister functions. */
export function registerRouteCommands(): Array<() => void> {
  return ROUTES.map((def, index) =>
    registerCommand({
      id: `navigate.${def.id}`,
      title: () => strings.nav[def.label],
      category: () => strings.commandCategories.navigate,
      keybinding: routeShortcut(index),
      run: () => useRouteStore.getState().navigate(def.id),
    }),
  );
}
