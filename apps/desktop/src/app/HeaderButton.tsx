import type { ButtonHTMLAttributes } from "react";

/**
 * Panel header action button (Workspaces "+", Terminal "+ ▾ / New agent ▶", Agents "…"): thin
 * outline style so it reads as clickable next to the plain-text title. `joined`: in a
 * split-button group ("+" + "▾") its edge merges with the neighbour.
 */
export function HeaderButton({
  joined,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { joined?: "left" | "right" }) {
  const radius = joined === "left" ? "rounded-l-sm" : joined === "right" ? "-ml-px rounded-r-sm" : "rounded-sm";
  return <button type="button" className={`header-btn ${radius} ${className}`} {...rest} />;
}
