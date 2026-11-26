/** Square icon-only button (32px). `danger` tints it on hover/focus only. */
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function IconButton({
  label,
  children,
  danger = false,
  className = "",
  type = "button",
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & { label: string; children: ReactNode; danger?: boolean }) {
  const tone = danger ? "hover:bg-blocked-bg hover:text-blocked-ink focus-visible:bg-blocked-bg focus-visible:text-blocked-ink" : "hover:bg-surface-4 hover:text-text";
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-button bg-transparent text-text-3 transition-colors duration-150 disabled:cursor-default disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${tone} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
