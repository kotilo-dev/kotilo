/** Screen title (§3: 26px / 700 / -0.02em) with a muted subtitle and right-aligned actions. */
import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 id="page-title" className="m-0 text-display font-bold leading-[1.2] tracking-[-0.02em] text-text">
          {title}
        </h1>
        {subtitle && <p className="m-0 text-muted">{subtitle}</p>}
      </div>
      <div className="flex-1" />
      {actions}
    </div>
  );
}

/** Scrollable page body with the standard 28px/32px padding. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <section aria-labelledby="page-title" className="flex h-full flex-col gap-[22px] overflow-auto bg-bg px-8 py-7">
      {children}
    </section>
  );
}
