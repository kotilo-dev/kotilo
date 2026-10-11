/**
 * In-app Help (faz7-spec §10, revised §12): a modal shell like `SettingsModal` (role="dialog",
 * Esc/backdrop close, focus returns to the trigger on close), but with search + doc tabs + TOC +
 * markdown content + an "About" item, instead of settings fields.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "../viewer/renderers/markdownPreview.css";
import { useI18nStore, useStrings, type Language } from "../../app/i18n";
import { useResolvedTheme } from "../../app/theme/resolvedTheme";
import { AboutPanel } from "../../app/AboutPanel";
import { openExternalUrl } from "../../lib/ipc";
import { setHljsTheme } from "../viewer/renderers/hljsTheme";
import { createHeadingIdFactory, flattenText } from "../viewer/renderers/mdLinks";
import { HELP_DOCS, helpDocContent, type HelpDocId } from "./helpDocs";
import { tocFor, searchHelp, type HelpSearchResult } from "./helpIndex";
import { classifyHelpLink } from "./helpLinks";
import { useHelpStore } from "./helpStore";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];
const MIN_QUERY_LENGTH = 2;

function cssEscapeId(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(id);
  return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

const DOC_ORDER: HelpDocId[] = HELP_DOCS.map((d) => d.id);

function HelpContent({ doc, language, onAnchorClick, onDocClick }: {
  doc: HelpDocId;
  language: Language;
  onAnchorClick: (id: string) => void;
  onDocClick: (target: HelpDocId, hash: string) => void;
}) {
  const strings = useStrings();
  const content = helpDocContent(doc, language);
  const makeHeadingId = createHeadingIdFactory();

  const components: Components = (() => {
    // `Components["h1"]`..`["h6"]` are structurally identical (all just `HTMLHeadingElement`
    // attributes) but TS doesn't consider a single generic factory assignable across the union
    // (same issue noted in `MarkdownView.tsx`) — six one-liners instead of union gymnastics.
    const h1: Components["h1"] = ({ children, node: _node, ...rest }) => (
      <h1 id={makeHeadingId(flattenText(children))} {...rest}>
        {children}
      </h1>
    );
    const h2: Components["h2"] = ({ children, node: _node, ...rest }) => (
      <h2 id={makeHeadingId(flattenText(children))} {...rest}>
        {children}
      </h2>
    );
    const h3: Components["h3"] = ({ children, node: _node, ...rest }) => (
      <h3 id={makeHeadingId(flattenText(children))} {...rest}>
        {children}
      </h3>
    );
    const h4: Components["h4"] = ({ children, node: _node, ...rest }) => (
      <h4 id={makeHeadingId(flattenText(children))} {...rest}>
        {children}
      </h4>
    );
    const h5: Components["h5"] = ({ children, node: _node, ...rest }) => (
      <h5 id={makeHeadingId(flattenText(children))} {...rest}>
        {children}
      </h5>
    );
    const h6: Components["h6"] = ({ children, node: _node, ...rest }) => (
      <h6 id={makeHeadingId(flattenText(children))} {...rest}>
        {children}
      </h6>
    );

    // faz7-spec §12.7: docs have no images — always render as unavailable.
    const img: Components["img"] = ({ alt }) => (
      <span className="italic text-muted" title={strings.help.unavailableLinkTitle}>
        {alt || ""}
      </span>
    );

    const a: Components["a"] = ({ href, children, node: _node, ...rest }) => {
      if (!href) return <span {...rest}>{children}</span>;
      const action = classifyHelpLink(doc, href);
      if (action.kind === "unavailable") {
        return (
          <span className="text-muted" title={strings.help.unavailableLinkTitle}>
            {children}
          </span>
        );
      }
      if (action.kind === "external") {
        return (
          <a
            href="#"
            title={action.href}
            {...rest}
            onClick={(e) => {
              e.preventDefault();
              void openExternalUrl(action.href);
            }}
            onAuxClick={(e) => {
              e.preventDefault();
              void openExternalUrl(action.href);
            }}
          >
            {children}
          </a>
        );
      }
      if (action.kind === "anchor") {
        return (
          <a
            href={`#${action.id}`}
            {...rest}
            onClick={(e) => {
              e.preventDefault();
              onAnchorClick(action.id);
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a
          href="#"
          {...rest}
          onClick={(e) => {
            e.preventDefault();
            onDocClick(action.doc, action.hash);
          }}
        >
          {children}
        </a>
      );
    };

    return { h1, h2, h3, h4, h5, h6, img, a } satisfies Components;
  })();

  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} urlTransform={(v: string) => v} components={components}>
      {content}
    </Markdown>
  );
}

export function HelpModal() {
  const strings = useStrings();
  const language = useI18nStore((s) => s.language);
  const open = useHelpStore((s) => s.open);
  const item = useHelpStore((s) => s.item);
  const pendingAnchor = useHelpStore((s) => s.pendingAnchor);
  const close = useHelpStore((s) => s.close);
  const setItem = useHelpStore((s) => s.setItem);
  const openItemWithAnchor = useHelpStore((s) => s.openItemWithAnchor);
  const clearPendingAnchor = useHelpStore((s) => s.clearPendingAnchor);
  const theme = useResolvedTheme((s) => s.theme);

  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHljsTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    requestAnimationFrame(() => searchInputRef.current?.focus()); // §12.12: initial focus on search
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [open, close]);

  // §12.8: scroll after a doc switch (or a same-doc search hit), once the target content has
  // rendered; runs for anchor-only navigation within the current doc too.
  useEffect(() => {
    if (!pendingAnchor) return;
    const el = contentRef.current?.querySelector<HTMLElement>(`#${cssEscapeId(pendingAnchor)}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    clearPendingAnchor();
  }, [item, pendingAnchor, clearPendingAnchor]);

  const results = useMemo<HelpSearchResult[]>(() => searchHelp(query, language), [query, language]);
  const searching = query.trim().length >= MIN_QUERY_LENGTH;

  function scrollToAnchor(id: string) {
    const target = contentRef.current?.querySelector<HTMLElement>(`#${cssEscapeId(id)}`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openResult(result: HelpSearchResult) {
    setQuery("");
    openItemWithAnchor(result.doc, result.id);
  }

  if (!open) return null;

  const toc = item === "about" ? [] : tocFor(item, language);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={strings.help.dialogLabel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="flex h-[85vh] w-[90vw] flex-col overflow-hidden rounded border border-border bg-surface-1 shadow-lg"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
          <input
            ref={searchInputRef}
            type="search"
            aria-label={strings.help.searchLabel}
            placeholder={strings.help.searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && results[0]) {
                e.preventDefault();
                openResult(results[0]);
              }
            }}
            className="min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 py-1 text-xs text-text"
          />
          <button type="button" onClick={close} className="text-muted">
            {strings.help.close}
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-48 shrink-0 flex-col overflow-auto border-r border-border py-2">
            <div role="tablist">
              {DOC_ORDER.map((docId) => (
                <button
                  key={docId}
                  type="button"
                  role="tab"
                  aria-selected={item === docId}
                  onClick={() => {
                    setQuery("");
                    setItem(docId);
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-xs text-text ${item === docId ? "bg-surface-4" : "bg-transparent"}`}
                >
                  {strings.help.docTitles[docId]}
                </button>
              ))}
              <button
                type="button"
                role="tab"
                aria-selected={item === "about"}
                onClick={() => {
                  setQuery("");
                  setItem("about");
                }}
                className={`block w-full px-3 py-1.5 text-left text-xs text-text ${item === "about" ? "bg-surface-4" : "bg-transparent"}`}
              >
                {strings.help.aboutItem}
              </button>
            </div>

            {toc.length > 0 && (
              <nav aria-label={strings.help.tocLabel} className="mt-2 border-t border-border pt-2">
                {toc.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => scrollToAnchor(section.id)}
                    className={`block w-full truncate py-1 pr-3 text-left text-label text-muted ${section.level === 3 ? "pl-6" : "pl-3"}`}
                  >
                    {section.title}
                  </button>
                ))}
              </nav>
            )}
          </div>

          <div role="tabpanel" ref={contentRef} className="md-preview min-w-0 flex-1 overflow-auto p-4">
            {searching ? (
              results.length === 0 ? (
                <div className="text-xs text-muted">
                  {strings.help.noResults}
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {results.map((r) => (
                    <button
                      key={`${r.doc}#${r.id}`}
                      type="button"
                      onClick={() => openResult(r)}
                      className="block w-full rounded px-2 py-1 text-left text-xs text-text"
                    >
                      {strings.help.docTitles[r.doc]} › {r.title}
                    </button>
                  ))}
                </div>
              )
            ) : item === "about" ? (
              <AboutPanel />
            ) : (
              <HelpContent
                doc={item}
                language={language}
                onAnchorClick={scrollToAnchor}
                onDocClick={(target, hash) => openItemWithAnchor(target, hash)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
