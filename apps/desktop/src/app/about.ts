/**
 * About content (faz7-spec §11/§12, M5) — pure data, no React/IPC. Contact and project links
 * come from brand.json (the single source); empty values hide their rows in About. `CREDITS`
 * are brand/product names + their project sites, not translatable copy, so they live here
 * rather than in `strings.ts` (the surrounding sentence — "Built with X, Y and Z." — is in
 * `strings.about`).
 */
import { BRAND } from "./constants";

// From brand.json; empty hides the contact row in About.
export const CONTACT_EMAIL: string = BRAND.supportEmail;

/** brand.json `repository` (GitHub URL of the public repo); optional, missing = empty. */
export const REPOSITORY_URL: string = ((BRAND as { repository?: string }).repository ?? "").trim();

export interface ProjectLinks {
  repository: string;
  issues: string;
  discussions: string;
}

/** Repository / issues / discussions URLs, or null when no repository is configured. */
export function projectLinks(repository: string = REPOSITORY_URL): ProjectLinks | null {
  const base = repository.trim().replace(/\/+$/, "");
  if (!base) return null;
  return { repository: base, issues: `${base}/issues`, discussions: `${base}/discussions` };
}

export const CREDITS: readonly { name: string; href: string }[] = [
  { name: "Tauri", href: "https://tauri.app/" },
  { name: "React", href: "https://react.dev/" },
  { name: "Monaco Editor", href: "https://microsoft.github.io/monaco-editor/" },
  { name: "xterm.js", href: "https://xtermjs.org/" },
];
