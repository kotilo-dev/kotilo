/** A headline number: label, big mono value, muted detail line. */
import type { ReactNode } from "react";

export function StatTile({ label, value, detail, children }: { label: string; value: string; detail?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-card border border-border-subtle bg-surface-2 px-4 py-3.5">
      <span className="text-small text-text-3">{label}</span>
      <span className="font-mono text-[22px] font-semibold leading-tight text-text">{value}</span>
      {detail && <span className="text-small text-muted">{detail}</span>}
      {children}
    </div>
  );
}

/** Thin horizontal progress bar (0..1) on the `--track` token. */
export function ProgressBar({ value, tone = "accent", label }: { value: number; tone?: "accent" | "working" | "blocked" | "idle"; label?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const color = { accent: "bg-accent", working: "bg-working", blocked: "bg-blocked", idle: "bg-idle" }[tone];
  return (
    <div
      className="h-[5px] w-full overflow-hidden rounded-[3px] bg-track"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div className={`h-full rounded-[3px] ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
