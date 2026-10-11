/**
 * Extension → icon table (SPEC §4.1 "file icons by extension"; faz2-spec §6 "small emoji/SVG
 * table, pure function + test"). A simple emoji set; it can be swapped for a real icon set
 * later while this function's signature stays the same.
 */

const EXTENSION_ICONS: Record<string, string> = {
  ts: "🟦",
  tsx: "🟦",
  js: "🟨",
  jsx: "🟨",
  mjs: "🟨",
  cjs: "🟨",
  json: "🟫",
  md: "📝",
  mdx: "📝",
  css: "🎨",
  scss: "🎨",
  html: "🌐",
  htm: "🌐",
  rs: "⚙️",
  py: "🐍",
  yml: "🔧",
  yaml: "🔧",
  toml: "🔧",
  ini: "🔧",
  png: "🖼️",
  jpg: "🖼️",
  jpeg: "🖼️",
  gif: "🖼️",
  webp: "🖼️",
  bmp: "🖼️",
  ico: "🖼️",
  svg: "🖼️",
  pdf: "📕",
  txt: "📄",
  log: "📄",
  csv: "📊",
  sql: "🗄️",
  lock: "🔒",
  env: "🔑",
  sh: "💻",
  ps1: "💻",
  bat: "💻",
  cmd: "💻",
  xml: "📄",
};

const FOLDER_CLOSED = "📁";
const FOLDER_OPEN = "📂";
const DEFAULT_FILE_ICON = "📄";

/** The extension (without the dot, lower case); `null` when there is none (or the dot is first). */
export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // files like "" or ".gitignore" have no extension
  return name.slice(dot + 1).toLowerCase();
}

/** Icon for a tree row: open/closed for folders, the extension mapping for files. */
export function iconFor(name: string, isDir: boolean, expanded = false): string {
  if (isDir) return expanded ? FOLDER_OPEN : FOLDER_CLOSED;
  const ext = extensionOf(name);
  if (ext === null) return DEFAULT_FILE_ICON;
  return EXTENSION_ICONS[ext] ?? DEFAULT_FILE_ICON;
}
