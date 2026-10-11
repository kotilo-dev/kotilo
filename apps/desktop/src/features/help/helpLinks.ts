/**
 * Help modal link routing (faz7-spec §12.7): reuses the viewer's `classifyLink` unchanged — the
 * three bundled docs are flat siblings (no subfolders), so treating a doc id as a workspace
 * `rel` with no slash (`parentRel` → `""`) resolves exactly like the viewer's workspace-relative
 * links, just against the bundled-doc map instead of the filesystem.
 */
import { classifyLink } from "../viewer/renderers/mdLinks";
import { isHelpDocId, type HelpDocId } from "./helpDocs";

export type HelpLinkAction =
  | { kind: "anchor"; id: string }
  | { kind: "doc"; doc: HelpDocId; hash: string }
  | { kind: "external"; href: string }
  | { kind: "unavailable" };

export function classifyHelpLink(currentDoc: HelpDocId, href: string): HelpLinkAction {
  const classified = classifyLink(currentDoc, href);
  if (classified.kind === "anchor") return classified;
  if (classified.kind === "external") return classified;
  if (classified.kind === "disabled") return { kind: "unavailable" };
  // "file": basename must be one of the three bundled docs (§12.7) — anything else (e.g.
  // development.md) is "not in map" → unavailable, same as an unsupported scheme.
  if (!isHelpDocId(classified.rel)) return { kind: "unavailable" };
  return { kind: "doc", doc: classified.rel, hash: classified.hash };
}
