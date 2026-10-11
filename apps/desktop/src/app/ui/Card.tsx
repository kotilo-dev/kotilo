/** DESIGN_SYSTEM §7.8-style surface: `--surface-2` body, hairline border, 10px radius. */
import type { ReactNode } from "react";

export function Card({
  title,
  actions,
  children,
  className = "",
  bodyClassName = "p-4",
  labelledBy,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  labelledBy?: string;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={`flex min-w-0 flex-col overflow-hidden rounded-card border border-border-subtle bg-surface-2 ${className}`}
    >
      {(title || actions) && (
        <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
          {title && (
            <h2 id={labelledBy} className="m-0 text-title font-semibold text-text">
              {title}
            </h2>
          )}
          <div className="flex-1" />
          {actions}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** §3 section label: 11px uppercase, letter-spaced. */
export function SectionLabel({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="m-0 text-label font-semibold uppercase tracking-[0.08em] text-faint">
      {children}
    </h2>
  );
}
