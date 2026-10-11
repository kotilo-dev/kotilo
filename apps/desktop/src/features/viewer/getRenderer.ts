/**
 * Renderer selection (SPEC §4.4/§5 architecture: "a single getRenderer(...) function").
 *
 * faz3-spec §5.3 (binding revision): `fs_sniff` was removed — this function looks **only** at the
 * extension and does no IO. Unknown extension → `"text"` (if the backend's `fs_read_text` detects
 * binary it returns `binary_file`, and `ViewerPanel` then shows the tab as `"unsupported"` — this
 * file doesn't model that fallback, it is only the static extension map).
 */

export type RenderKind = "markdown" | "text" | "html" | "pdf" | "image" | "svg" | "unsupported";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
const PDF_EXTENSIONS = new Set(["pdf"]);
const SVG_EXTENSIONS = new Set(["svg"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

/** Extension of the last path segment, lower-cased, without the dot. `""` if there is none. */
function extensionOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const idx = base.lastIndexOf(".");
  if (idx <= 0) return ""; // no extension, or the name starts with "." (e.g. ".gitignore")
  return base.slice(idx + 1).toLowerCase();
}

export function getRenderer(rel: string): RenderKind {
  const ext = extensionOf(rel);
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (HTML_EXTENSIONS.has(ext)) return "html";
  if (PDF_EXTENSIONS.has(ext)) return "pdf";
  if (SVG_EXTENSIONS.has(ext)) return "svg";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "text";
}
