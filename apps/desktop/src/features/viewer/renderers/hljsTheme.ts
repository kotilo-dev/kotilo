/**
 * Faz 6 §2/§10.9: one `<style>` element, since both `rehype-highlight` themes define the global
 * `.hljs` selector — the light/dark CSS text is pulled in at build time via `?inline` (no network
 * request; stays part of the `MarkdownView` lazy chunk — see that file's header).
 */
import darkCss from "highlight.js/styles/github-dark.css?inline";
import lightCss from "highlight.js/styles/github.css?inline";
import type { ResolvedTheme } from "../../../app/theme/resolvedTheme";

let styleEl: HTMLStyleElement | null = null;

export function setHljsTheme(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-agenthub-hljs-theme", "");
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = theme === "light" ? lightCss : darkCss;
}
