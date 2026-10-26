/**
 * App routes (M2 shell). Each non-workspace route renders its page from
 * `src/features/<screen>/<Screen>Page.tsx`; wave 2 fills those files in without touching the
 * shell. Order here is the nav rail order and the Alt+1…Alt+9 shortcut order.
 */
import type { PlatformFeatures } from "../lib/ipc";
import { platformFeatures } from "../lib/platform";
import type { IconName } from "./icons";
import type { Strings } from "./i18n";

export type RouteId = "workspace" | "overview" | "mission" | "usage" | "reports" | "projects" | "tasks" | "sessions" | "dictation" | "settings";

export interface RouteDef {
  id: RouteId;
  icon: IconName;
  /** Key of the label in `strings.nav`. */
  label: keyof Omit<Strings["nav"], "label" | "tasksDue">;
  /** Shown at the bottom of the rail rather than in the main group. */
  bottom?: boolean;
  /** U-2: shown only where this OS feature exists. */
  needs?: keyof PlatformFeatures;
}

export const ROUTES: readonly RouteDef[] = [
  { id: "workspace", icon: "workspace", label: "workspace" },
  { id: "overview", icon: "overview", label: "overview" },
  { id: "mission", icon: "mission", label: "mission" },
  { id: "usage", icon: "usage", label: "usage" },
  { id: "reports", icon: "reports", label: "reports" },
  { id: "projects", icon: "projects", label: "projects" },
  { id: "tasks", icon: "tasks", label: "tasks" },
  // D-067: after the routes users already reach with Alt+1…7, so their shortcuts stay.
  { id: "sessions", icon: "sessions", label: "sessions" },
  { id: "dictation", icon: "dictation", label: "dictation", needs: "dictation" },
  { id: "settings", icon: "settings", label: "settings", bottom: true },
];

/** The routes this OS offers (U-2), in rail order. */
export function visibleRoutes(): readonly RouteDef[] {
  const features = platformFeatures();
  return ROUTES.filter((def) => !def.needs || features[def.needs]);
}

/**
 * Global shortcut for the route at `index` (0-based): Alt+1…Alt+9, none after the ninth. Alt,
 * not Ctrl: Ctrl+1…9 switch workspaces.
 */
export function routeShortcut(index: number): string | undefined {
  return index < 9 ? `Alt+${index + 1}` : undefined;
}
