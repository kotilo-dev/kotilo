/**
 * One shared section index for the Help modal (faz7-spec §12.6): TOC, search, and the bundled-
 * docs link/anchor integrity test all read from THIS, instead of three separate hand-rolled
 * scans — built from `remark-parse` (fence-aware by construction, unlike line regexes: a `#` or
 * blank-looking line inside a code fence is never mistaken for a heading/section break) +
 * `mdast-util-to-string`, slugged with the exact same `createHeadingIdFactory`/`slugify` the
 * markdown renderer uses, so ids always agree with the rendered anchors.
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import { toString as mdastToString } from "mdast-util-to-string";
import { createHeadingIdFactory, slugify } from "../viewer/renderers/mdLinks";
import type { Language } from "../../app/i18n";
import { HELP_DOC_SETS, type HelpDocId } from "./helpDocs";

/** Minimal shape we rely on — avoids pulling in `@types/mdast` for one field set. */
interface MdNode {
  type: string;
  depth?: number;
  url?: string;
  children?: MdNode[];
}

export interface HelpSection {
  language: Language;
  doc: HelpDocId;
  id: string;
  level: number;
  title: string;
  /** Flattened text of every node between this heading and the next (any level), for search. */
  bodyText: string;
}

function parse(markdown: string): MdNode {
  return unified().use(remarkParse).parse(markdown) as unknown as MdNode;
}

/** Every `[text](url)`/autolink target in document order (mdast "link" nodes), depth-first. */
export function collectLinkHrefs(markdown: string): string[] {
  const hrefs: string[] = [];
  function walk(node: MdNode) {
    if (node.type === "link" && typeof node.url === "string") hrefs.push(node.url);
    node.children?.forEach(walk);
  }
  walk(parse(markdown));
  return hrefs;
}

function buildSections(language: Language, doc: HelpDocId, markdown: string): HelpSection[] {
  const tree = parse(markdown);
  const makeId = createHeadingIdFactory();
  const sections: HelpSection[] = [];
  let current: HelpSection | null = null;
  let pendingBody: string[] = [];

  for (const node of tree.children ?? []) {
    if (node.type === "heading") {
      const title = mdastToString(node);
      const id = makeId(title);
      current = { language, doc, id, level: node.depth ?? 1, title, bodyText: pendingBody.join("\n") };
      pendingBody = [];
      sections.push(current);
    } else {
      const text = mdastToString(node);
      if (!text) continue;
      if (current) current.bodyText += (current.bodyText ? "\n" : "") + text;
      else pendingBody.push(text); // faz7-spec §12.10: pre-heading text belongs to the `#` title
    }
  }
  return sections;
}

/** Built once at module load for every language — the docs are static bundled content (§10.1). */
export const HELP_SECTIONS: readonly HelpSection[] = (Object.keys(HELP_DOC_SETS) as Language[]).flatMap((language) =>
  HELP_DOC_SETS[language].flatMap((d) => buildSections(language, d.id, d.content)),
);

/** `##`/`###` only (§10.2) — the left-column table of contents for one doc, in document order. */
export function tocFor(doc: HelpDocId, language: Language = "en"): HelpSection[] {
  return HELP_SECTIONS.filter((s) => s.language === language && s.doc === doc && (s.level === 2 || s.level === 3));
}

export interface HelpSearchResult {
  doc: HelpDocId;
  id: string;
  title: string;
}

const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 50;

/**
 * Case-insensitive `includes`. Turkish text is also folded with Turkish rules, so "izin" finds
 * "İzin" (plain toLowerCase gives "i̇zin"); English folding still runs, so "install" finds
 * "Install" in a Turkish doc.
 */
function containsFolded(text: string, query: string, language: Language): boolean {
  if (text.toLowerCase().includes(query.toLowerCase())) return true;
  return language === "tr" && text.toLocaleLowerCase("tr-TR").includes(query.toLocaleLowerCase("tr-TR"));
}

/**
 * Case-insensitive substring over heading text + body text (§12.10); empty/short (<2 char)
 * query → no results. Results in doc-then-heading order, capped at 50. The About item is a
 * separate, non-markdown modal section and is never searched (§12.10/§12.11). Only the given
 * language's docs are searched.
 */
export function searchHelp(query: string, language: Language = "en"): HelpSearchResult[] {
  const q = query.trim();
  if (q.length < MIN_QUERY_LENGTH) return [];
  const results: HelpSearchResult[] = [];
  for (const s of HELP_SECTIONS) {
    if (s.language !== language) continue;
    if (containsFolded(s.title, q, language) || containsFolded(s.bodyText, q, language)) {
      results.push({ doc: s.doc, id: s.id, title: s.title });
      if (results.length >= MAX_RESULTS) break;
    }
  }
  return results;
}

/** Exported for the link/anchor integrity test and slugify parity checks. */
export { slugify };
