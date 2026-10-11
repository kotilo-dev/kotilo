/** §7.10 buttons: primary (accent), secondary (surface + border), danger (outlined). */
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-on-accent font-semibold hover:brightness-110",
  secondary: "border border-border bg-surface-5 text-text hover:bg-surface-selected",
  danger: "border border-blocked/35 bg-transparent text-blocked-ink hover:bg-blocked-bg",
  ghost: "bg-transparent text-text-2 hover:bg-surface-5",
};

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`inline-flex h-8 items-center gap-2 rounded-button px-3 text-body transition-colors duration-150 disabled:cursor-default disabled:opacity-40 ${VARIANT[variant]} ${className}`}
      {...rest}
    />
  );
}
