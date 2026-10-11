/**
 * Pure (Monaco-free) helpers of `TextEditor.tsx` — a separate file because `TextEditor.tsx`
 * imports the real `monaco-editor` package (via `./monacoSetup`), which crashes under jsdom in
 * Vitest for lack of `matchMedia` (Monaco's standalone theme service touches
 * `mainWindow.matchMedia`). This file has no IO/Monaco and is directly testable.
 */

export const XML_LANGUAGE_EXTENSIONS = new Set(["xml", "xsd", "xslt", "svg", "config"]);

/** Faz 6 §10.8: `agenthub-dark`/`agenthub-light` (defined in `monacoSetup.ts`) — per the theme setting. */
export function monacoThemeFor(theme: "dark" | "light"): string {
  return theme === "light" ? "agenthub-light" : "agenthub-dark";
}

export function extensionOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  json: "json",
  xml: "xml",
  xsd: "xml",
  xslt: "xml",
  config: "xml",
  html: "html",
  htm: "html",
  svg: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
  ini: "ini",
  sql: "sql",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
};

/** Extension → Monaco language id (kept separate so Vitest can use it). */
export function languageForRel(rel: string): string {
  const ext = extensionOf(rel);
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}

/**
 * Monaco model path: not a real URI, just a stable, unique key per tab. finding #1: every segment
 * (workspaceId + each `/`-separated part of `rel`) is encoded with `encodeURIComponent`
 * separately — otherwise rels like `a#1.md` and `a#2.md` could collide after `monaco.Uri.parse`
 * (`#` is the URI fragment separator). Never collides with the `compare-disk:`/`compare-mine:`
 * prefixed paths of `ExternalChangeBanner`'s DiffEditor (this one always starts with `/`).
 */
export function modelPathFor(workspaceId: string, rel: string): string {
  const segments = rel === "" ? [] : rel.split("/").map((segment) => encodeURIComponent(segment));
  return `/${encodeURIComponent(workspaceId)}/${segments.join("/")}`;
}
