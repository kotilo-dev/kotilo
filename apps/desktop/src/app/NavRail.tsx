/**
 * Left navigation rail (M2 shell, mockup "Permission request" rail): app mark, one icon button
 * per route, Settings at the bottom. Buttons carry `aria-label` + `aria-current`, and the
 * Alt+n shortcut is shown in the tooltip. Tasks carries a badge with today's + overdue tasks (hub stream).
 */
import { Icon } from "./icons";
import { useStrings } from "./i18n";
import { routeShortcut, visibleRoutes, type RouteDef } from "./routes";
import { useRouteStore } from "../stores/routeStore";
import { useHubStore } from "../stores/hubStore";

/** Today + overdue open tasks from the hub stream; null when there are none (or for other routes). */
function useTaskBadge(enabled: boolean): { count: number; overdue: boolean; text: string } | null {
  const s = useStrings();
  const counts = useHubStore((st) => (enabled ? st.taskCounts : null));
  if (!counts || counts.today + counts.overdue === 0) return null;
  return { count: counts.today + counts.overdue, overdue: counts.overdue > 0, text: s.nav.tasksDue(counts.today, counts.overdue) };
}

function RailButton({ def, index }: { def: RouteDef; index: number }) {
  const s = useStrings();
  const active = useRouteStore((st) => st.route === def.id);
  const navigate = useRouteStore((st) => st.navigate);
  const badge = useTaskBadge(def.id === "tasks");
  const label = badge ? `${s.nav[def.label]} (${badge.text})` : s.nav[def.label];
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={`${label} (${routeShortcut(index)})`}
      data-route={def.id}
      onClick={() => navigate(def.id)}
      className={
        "relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-button border transition-colors duration-150 " +
        (active
          ? "border-accent/40 bg-surface-4 text-text"
          : "border-transparent bg-transparent text-muted hover:bg-surface-3 hover:text-text-2")
      }
    >
      <Icon name={def.icon} />
      {badge && (
        <span
          aria-hidden="true"
          data-testid="nav-badge"
          className={`absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-label font-semibold leading-none tabular-nums text-on-accent ${
            badge.overdue ? "bg-blocked" : "bg-accent"
          }`}
        >
          {badge.count > 99 ? "99+" : badge.count}
        </span>
      )}
    </button>
  );
}

export function NavRail() {
  const s = useStrings();
  const indexed = visibleRoutes().map((def, index) => ({ def, index }));
  return (
    <nav
      aria-label={s.nav.label}
      className="flex w-14 shrink-0 flex-col items-center gap-1.5 border-r border-border-subtle bg-surface-1 py-3"
    >
      <div className="mb-2 flex h-[30px] w-[30px] items-center justify-center rounded-button bg-accent text-on-accent" aria-hidden="true">
        <Icon name="appMark" size={15} strokeWidth={2.5} />
      </div>
      {indexed
        .filter(({ def }) => !def.bottom)
        .map(({ def, index }) => (
          <RailButton key={def.id} def={def} index={index} />
        ))}
      <div className="flex-1" />
      {indexed
        .filter(({ def }) => def.bottom)
        .map(({ def, index }) => (
          <RailButton key={def.id} def={def} index={index} />
        ))}
    </nav>
  );
}
