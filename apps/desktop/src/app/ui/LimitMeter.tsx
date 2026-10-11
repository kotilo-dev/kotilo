/**
 * §7.9 limit gauge: label + value (mono), 5px bar, note. Bar color by fill: < 70% accent,
 * 70–90% working, > 90% blocked. A missing value shows "—" and an empty track.
 */
import type { ReactNode } from "react";
import { formatPercent100 } from "./format";

export function meterColorClass(percent: number): string {
  if (percent > 90) return "bg-blocked";
  if (percent >= 70) return "bg-working";
  return "bg-accent";
}

export function LimitMeter({
  label,
  percent,
  value,
  note,
  leading,
}: {
  label: ReactNode;
  /** 0–100; null when unknown. */
  percent: number | null;
  /** Shown instead of the percentage when given (e.g. a cost). */
  value?: string;
  note?: ReactNode;
  leading?: ReactNode;
}) {
  const clamped = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-card border border-border-subtle bg-surface-2 px-4 py-3.5">
      <div className="flex items-center gap-2 text-small text-text-3">
        {leading}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="font-mono text-text">{value ?? formatPercent100(percent)}</span>
      </div>
      <div
        className="h-[5px] overflow-hidden rounded-[3px] bg-track"
        role={percent === null ? undefined : "meter"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(clamped)}
        aria-label={typeof label === "string" ? label : undefined}
      >
        <div className={`h-full rounded-[3px] ${meterColorClass(clamped)}`} style={{ width: `${clamped}%` }} />
      </div>
      {note && <span className="text-meta text-muted">{note}</span>}
    </div>
  );
}
