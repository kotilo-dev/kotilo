/**
 * Left navigation rail (M2 shell, mockup "Permission request" rail): app mark, one button per
 * route, Settings and the expand toggle at the bottom. Icons only by default; expanded, each
 * button shows its full label beside the icon (the choice lives in the layout slice). Buttons
 * carry `aria-label` + `aria-current`, and the Alt+n shortcut is shown in the tooltip. Tasks
 * carries a badge with today's + overdue tasks (hub stream).
 */
import { Icon } from "./icons";
import { useStrings } from "./i18n";
import { routeShortcut, visibleRoutes, type RouteDef } from "./routes";
import { useRouteStore } from "../stores/routeStore";
import { useHubStore } from "../stores/hubStore";
import { useLayoutStore } from "../stores/layoutStore";
import { formatKeybinding } from "../lib/keys";

/** Today + overdue open tasks from the hub stream; null when there are none (or for other routes). */
function useTaskBadge(enabled: boolean): { count: number; overdue: boolean; text: string } | null {
  const s = useStrings();
  const counts = useHubStore((st) => (enabled ? st.taskCounts : null));
  if (!counts || counts.today + counts.overdue === 0) return null;
  return { count: counts.today + counts.overdue, overdue: counts.overdue > 0, text: s.nav.tasksDue(counts.today, counts.overdue) };
}

/** Shared look of a rail row: a 36px square collapsed, a full-width row with a label expanded. */
function railButtonClass(expanded: boolean, active: boolean): string {
  return (
    "relative flex h-9 shrink-0 cursor-pointer items-center rounded-button border transition-colors duration-150 " +
    (expanded ? "w-full gap-2.5 px-2.5 " : "w-9 justify-center ") +
    (active ? "border-accent/40 bg-surface-4 text-text" : "border-transparent bg-transparent text-muted hover:bg-surface-3 hover:text-text-2")
  );
}

function RailButton({ def, index, expanded }: { def: RouteDef; index: number; expanded: boolean }) {
  const s = useStrings();
  const active = useRouteStore((st) => st.route === def.id);
  const navigate = useRouteStore((st) => st.navigate);
  const badge = useTaskBadge(def.id === "tasks");
  const name = s.nav[def.label];
  const label = badge ? `${name} (${badge.text})` : name;
  const shortcut = routeShortcut(index);
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={shortcut ? `${label} (${formatKeybinding(shortcut)})` : label}
      data-route={def.id}
      onClick={() => navigate(def.id)}
      className={railButtonClass(expanded, active)}
    >
      <span className="shrink-0">
        <Icon name={def.icon} />
      </span>
      {expanded && (
        <span aria-hidden="true" className="min-w-0 flex-1 truncate text-left text-ui">
          {name}
        </span>
      )}
      {badge && (
        <span
          aria-hidden="true"
          data-testid="nav-badge"
          className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-label font-semibold leading-none tabular-nums text-on-accent ${
            badge.overdue ? "bg-blocked" : "bg-accent"
          } ${expanded ? "shrink-0" : "absolute -top-0.5 -right-0.5"}`}
        >
          {badge.count > 99 ? "99+" : badge.count}
        </span>
      )}
    </button>
  );
}

export function NavRail() {
  const s = useStrings();
  const expanded = useLayoutStore((st) => st.layout.navExpanded);
  const toggle = useLayoutStore((st) => st.toggleNavExpanded);
  const indexed = visibleRoutes().map((def, index) => ({ def, index }));
  const toggleLabel = expanded ? s.nav.collapse : s.nav.expand;
  return (
    <nav
      aria-label={s.nav.label}
      data-expanded={expanded ? "true" : undefined}
      className={`flex shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-border-subtle bg-surface-1 py-3 ${
        expanded ? "w-48 items-stretch px-2" : "w-14 items-center"
      }`}
    >
      <div className={`mb-2 flex h-[30px] ${expanded ? "px-[3px]" : ""}`}>
        <div className="flex h-[30px] w-[30px] items-center justify-center rounded-button bg-accent text-on-accent" aria-hidden="true">
          <Icon name="appMark" size={15} strokeWidth={2.5} />
        </div>
      </div>
      {indexed
        .filter(({ def }) => !def.bottom)
        .map(({ def, index }) => (
          <RailButton key={def.id} def={def} index={index} expanded={expanded} />
        ))}
      <div className="flex-1" />
      {indexed
        .filter(({ def }) => def.bottom)
        .map(({ def, index }) => (
          <RailButton key={def.id} def={def} index={index} expanded={expanded} />
        ))}
      <button
        type="button"
        aria-label={toggleLabel}
        aria-expanded={expanded}
        title={toggleLabel}
        data-testid="nav-expand"
        onClick={toggle}
        className={railButtonClass(expanded, false)}
      >
        <span className="shrink-0">
          <Icon name={expanded ? "railCollapse" : "railExpand"} />
        </span>
        {expanded && (
          <span aria-hidden="true" className="min-w-0 flex-1 truncate text-left text-ui">
            {toggleLabel}
          </span>
        )}
      </button>
    </nav>
  );
}
