/** 0.7: a doc's docs check badge in the file tree – red dot for missing paths, else amber for stale. */
import { useStrings } from "../../app/i18n";
import { badgeTooltip, type DocBadge } from "./docsLogic";

export function DocBadgeDot({ badge }: { badge: DocBadge }) {
  const t = useStrings().docs;
  const tooltip = badgeTooltip(badge, t);
  const label = `${badge.kind === "missing" ? t.badge.missing : t.badge.stale}: ${tooltip}`;
  return (
    <span role="img" aria-label={label} title={tooltip} data-testid="doc-badge" data-kind={badge.kind} className="ml-1 flex h-full w-3 shrink-0 items-center justify-center">
      <span className={`block h-[7px] w-[7px] rounded-full ${badge.kind === "missing" ? "bg-blocked" : "bg-working"}`} />
    </span>
  );
}
