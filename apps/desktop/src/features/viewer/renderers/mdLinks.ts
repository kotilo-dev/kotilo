/**
 * Markdown preview: relative path resolution + link classification (faz3-spec §3, §79) — pure,
 * no DOM/IPC. `MarkdownView` uses it to decide between `adfsUrl` (image inside the workspace),
 * `viewerStore.openFile` (file link inside the workspace), in-page scrolling (`#anchor`) or
 * `openExternalUrl` (http/https). Links escaping the workspace root return `"disabled"`.
 */
import type { ReactNode } from "react";
import { parentRel } from "../../workspaces/paths";

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // broken percent escape — use the raw segment
  }
}

/** `"a/b.md?x=1#sec"` → `{ path: "a/b.md", hash: "sec" }` (query dropped, only the hash kept). */
export function splitPathFragment(target: string): { path: string; hash: string } {
  const hashIdx = target.indexOf("#");
  const withoutHash = hashIdx === -1 ? target : target.slice(0, hashIdx);
  const hash = hashIdx === -1 ? "" : target.slice(hashIdx + 1);
  const queryIdx = withoutHash.indexOf("?");
  const path = queryIdx === -1 ? withoutHash : withoutHash.slice(0, queryIdx);
  return { path, hash };
}

/**
 * Resolves a relative (or `/`-prefixed root-relative) target against `baseDir` (a workspace
 * `rel`, `""` for the root). Supports `./`, `../`, percent encoding and the Windows `\` separator.
 * Returns `null` if the result escapes the workspace root (too many `..`).
 */
export function resolveWorkspacePath(baseDir: string, target: string): string | null {
  const normalized = normalizeSlashes(target);
  const rootRelative = normalized.startsWith("/");
  const stack = rootRelative || baseDir === "" ? [] : baseDir.split("/");
  for (const rawSegment of normalized.split("/")) {
    if (rawSegment === "" || rawSegment === ".") continue;
    if (rawSegment === "..") {
      if (stack.length === 0) return null; // escapes the workspace root
      stack.pop();
      continue;
    }
    stack.push(decodeSegment(rawSegment));
  }
  return stack.join("/");
}

const HTTP_RE = /^https?:\/\//i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
// Windows drive letters ("C:\...") look like a URI scheme but aren't.
const DRIVE_LETTER_RE = /^[a-z]:[\\/]/i;

export type ImageSrcClass =
  | { kind: "data"; src: string }
  | { kind: "remote"; src: string }
  | { kind: "workspace"; rel: string }
  | { kind: "disabled" };

/**
 * `data:` passes through (allowed by CSP `img-src`). `http(s)` is classified separately as
 * **"remote"** (finding #12): CSP `img-src` doesn't allow general http/https (`'self' data: blob:
 * http://adfs.localhost`), so `MarkdownView` renders it as a clickable placeholder instead of a
 * real `<img>`. A relative path resolves to a workspace `rel`.
 */
export function classifyImageSrc(currentRel: string, src: string): ImageSrcClass {
  if (src.startsWith("data:")) return { kind: "data", src };
  if (HTTP_RE.test(src)) return { kind: "remote", src };
  if (SCHEME_RE.test(src) && !DRIVE_LETTER_RE.test(src)) return { kind: "disabled" };
  const { path } = splitPathFragment(src);
  const rel = resolveWorkspacePath(parentRel(currentRel), path);
  return rel === null ? { kind: "disabled" } : { kind: "workspace", rel };
}

export type LinkClass =
  | { kind: "external"; href: string }
  | { kind: "anchor"; id: string }
  /** `hash`: the (decoded, possibly empty) fragment after the path — faz7-spec §12.7: the Help
   *  modal needs it to scroll after switching docs; `MarkdownView`'s workspace file links ignore
   *  it (opening a file doesn't scroll to an anchor there). */
  | { kind: "file"; rel: string; hash: string }
  | { kind: "disabled" };

/** `http(s)` → external link; `"#x"` → in-page anchor; relative inside the workspace → file; otherwise disabled. */
export function classifyLink(currentRel: string, href: string): LinkClass {
  if (href.startsWith("#")) return { kind: "anchor", id: decodeSegment(href.slice(1)) };
  if (HTTP_RE.test(href)) return { kind: "external", href };
  if (SCHEME_RE.test(href) && !DRIVE_LETTER_RE.test(href)) return { kind: "disabled" }; // mailto:, javascript:, vbscript:, data: etc.
  const { path, hash } = splitPathFragment(href);
  if (path === "") return hash ? { kind: "anchor", id: decodeSegment(hash) } : { kind: "disabled" };
  const rel = resolveWorkspacePath(parentRel(currentRel), path);
  return rel === null ? { kind: "disabled" } : { kind: "file", rel, hash: decodeSegment(hash) };
}

/**
 * DOM `href`: never the real target for external links (or file/anchor links, finding #13) — so
 * a middle/ctrl click can't trigger the webview's default navigation; the real target moves to
 * `onClick`/`onAuxClick` → `openExternalUrl`/`openFile` and shows as `title`. `MarkdownView`
 * always uses this — it never puts the raw `href` into the DOM.
 */
export function hrefForLink(classified: LinkClass): string {
  if (classified.kind === "anchor") return `#${classified.id}`;
  return "#"; // external / file / disabled — gezinme her zaman JS handler'dan
}

/**
 * GitHub-compatible heading slug (faz7-spec §12.5, BINDING exact algorithm): lowercase, strip
 * anything that isn't a letter/digit/whitespace/`_`/`-`, then replace EACH whitespace character
 * with `-` individually (no collapsing — unlike the pre-§12 version, consecutive whitespace
 * yields consecutive dashes, matching GitHub's own anchor generation for e.g. em-dash-separated
 * headings). Used both by the markdown preview's heading ids and the Help modal's shared section
 * index (`createHeadingIdFactory`) — the two MUST stay byte-identical so TOC/search results and
 * rendered anchors agree.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * React children → flat text (heading slug input) — DOM'a dokunmaz. Extracted from
 * `MarkdownView` (faz7-spec §12.14) so the Help modal's own markdown renderer can share it.
 */
export function flattenText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return flattenText(props?.children);
  }
  return "";
}

/**
 * Per-render heading-id factory (faz7-spec §12.14): `slugify` + "-1"/"-2" dedupe for repeated
 * headings, scoped to ONE call (one render pass / one section-index build) so counts never leak
 * across renders or documents. Shared by `MarkdownView` and the Help modal's renderer/section
 * index — both must produce the SAME ids for the same heading text and traversal order.
 */
export function createHeadingIdFactory(): (rawText: string) => string {
  const counts = new Map<string, number>();
  return function makeHeadingId(rawText: string): string {
    const base = slugify(rawText) || "section";
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}
