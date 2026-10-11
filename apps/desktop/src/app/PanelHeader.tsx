import type { ReactNode } from "react";

interface PanelHeaderProps {
  title: string;
  actions?: ReactNode;
}

/** Panel header: the upper-case title strip from SPEC §3 (WORKSPACES / AGENTS / ...). */
export function PanelHeader({ title, actions }: PanelHeaderProps) {
  return (
    <div
      className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-surface-3 px-2 text-xs font-semibold tracking-wide text-muted"
    >
      <span>{title}</span>
      {actions}
    </div>
  );
}
