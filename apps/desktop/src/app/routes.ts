/**
 * App routes (M2 shell). Each non-workspace route renders its page from
 * `src/features/<screen>/<Screen>Page.tsx`; wave 2 fills those files in without touching the
 * shell. Order here is the nav rail order and the Alt+1…Alt+9 shortcut order.
 */
import type { IconName } from "./icons";
import type { Strings } from "./i18n";

export type RouteId = "workspace" | "overview" | "mission" | "usage" | "reports" | "projects" | "tasks" | "dictation" | "settings";

export interface RouteDef {
  id: RouteId;
  icon: IconName;
  /** Key of the label in `strings.nav`. */
  label: keyof Omit<Strings["nav"], "label" | "tasksDue">;
  /** Shown at the bottom of the rail rather than in the main group. */
  bottom?: boolean;
}

export const ROUTES: readonly RouteDef[] = [
  { id: "workspace", icon: "workspace", label: "workspace" },
  { id: "overview", icon: "overview", label: "overview" },
  { id: "mission", icon: "mission", label: "mission" },
  { id: "usage", icon: "usage", label: "usage" },
  { id: "reports", icon: "reports", label: "reports" },
  { id: "projects", icon: "projects", label: "projects" },
  { id: "tasks", icon: "tasks", label: "tasks" },
  { id: "dictation", icon: "dictation", label: "dictation" },
  { id: "settings", icon: "settings", label: "settings", bottom: true },
];

/** Global shortcut for the n-th route (1-based). Alt, not Ctrl: Ctrl+1…9 switch workspaces. */
export function routeShortcut(index: number): string {
  return `Alt+${index + 1}`;
}
