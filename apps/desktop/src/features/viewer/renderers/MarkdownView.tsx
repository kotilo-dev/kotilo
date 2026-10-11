/**
 * Markdown renderer (faz3-spec §3): Edit (TextEditor) / Preview / Split (side by side, no scroll
 * sync needed). Preview: `react-markdown` + `remark-gfm` + `rehype-highlight`; raw HTML is not
 * rendered (no `rehype-raw` — that is enough, §3). The text is read live from `documentStore`
 * (updates while editing too).
 */
import { useEffect, useRef } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "./markdownPreview.css";
import { useStrings } from "../../../app/strings";
import { useResolvedTheme } from "../../../app/theme/resolvedTheme";
import { adfsUrl, openExternalUrl } from "../../../lib/ipc";
import { useDocument } from "../../../stores/documentStore";
import { useViewerStore } from "../../../stores/viewerStore";
import { setHljsTheme } from "./hljsTheme";
import { classifyImageSrc, classifyLink, createHeadingIdFactory, flattenText, hrefForLink } from "./mdLinks";
import { TextEditor } from "./TextEditor";
import type { RendererProps } from "./types";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

function cssEscapeId(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(id);
  return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

interface MarkdownPreviewProps {
  workspaceId: string;
  rel: string;
  text: string;
}

function MarkdownPreview({ workspaceId, rel, text }: MarkdownPreviewProps) {
  const strings = useStrings();
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme((s) => s.theme);

  // faz6-spec §10.9: the hljs light/dark stylesheet lives in one global <style> whose content
  // follows the theme (both define the same `.hljs` selector).
  useEffect(() => {
    setHljsTheme(theme);
  }, [theme]);

  function scrollToAnchor(id: string) {
    const container = containerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`#${cssEscapeId(id)}`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Heading slug counters for this render pass — fresh on every render (so repeated headings get
  // "-1", "-2"). faz7-spec §12.14: shared factory (`mdLinks.ts`) — the SAME id logic as the Help
  // modal's renderer.
  const makeHeadingId = createHeadingIdFactory();

  // Note: `components` is rebuilt on every render (not memoized) on purpose. `makeHeadingId`
  // closes over this render's `slugCounts`; reusing a `components` object from an earlier render
  // would leak slug counters across renders and produce wrong "-1", "-2"… ids. The tree is small,
  // so the cost is negligible.
  const components: Components = (() => {
    // `Components["h1"]`..`["h6"]` are structurally identical (all `HTMLHeadingElement`
    // attributes) but TS doesn't accept one generic factory across the union — six one-liners are
    // simpler and type-safe.
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

    const img: Components["img"] = function MdImage({ src, alt, node: _node, ...rest }) {
      if (!src) return null;
      const classified = classifyImageSrc(rel, src);
      if (classified.kind === "disabled") {
        return (
          <span className="italic text-muted" title={strings.viewer.markdown.disabledLinkTitle}>
            {alt || src}
          </span>
        );
      }
      if (classified.kind === "remote") {
        // finding #12: CSP `img-src` doesn't allow general http(s) (only `'self' data: blob:
        // http://adfs.localhost`) — a real `<img>` would silently show as broken. Instead a
        // clickable placeholder; the real URL only opens via `openExternalUrl`. CSP untouched.
        return (
          <a
            href={hrefForLink({ kind: "external", href: classified.src })}
            className="italic text-muted underline"
            title={classified.src}
            onClick={(e) => {
              e.preventDefault();
              void openExternalUrl(classified.src);
            }}
            onAuxClick={(e) => {
              e.preventDefault();
              void openExternalUrl(classified.src);
            }}
          >
            {strings.viewer.markdown.remoteImage(alt || classified.src)}
          </a>
        );
      }
      const resolvedSrc = classified.kind === "data" ? classified.src : adfsUrl(workspaceId, classified.rel);
      // eslint-disable-next-line jsx-a11y/alt-text -- `alt` is passed, only the prop order differs
      return <img src={resolvedSrc} alt={alt} {...rest} />;
    };

    const a: Components["a"] = function MdLink({ href, children, node: _node, ...rest }) {
      if (!href) return <span {...rest}>{children}</span>;
      const classified = classifyLink(rel, href);
      if (classified.kind === "disabled") {
        return (
          <span className="text-muted" title={strings.viewer.markdown.disabledLinkTitle}>
            {children}
          </span>
        );
      }
      if (classified.kind === "external") {
        const target = classified.href;
        return (
          // finding #13: `href` doesn't carry the real URL (`hrefForLink` → "#"), so a middle/ctrl
          // click can't trigger the webview's default navigation and bypass the opener; the real
          // target shows as `title`, navigation always goes through `onClick`/`onAuxClick`.
          <a
            href={hrefForLink(classified)}
            title={target}
            {...rest}
            onClick={(e) => {
              e.preventDefault();
              void openExternalUrl(target);
            }}
            onAuxClick={(e) => {
              e.preventDefault();
              void openExternalUrl(target);
            }}
          >
            {children}
          </a>
        );
      }
      if (classified.kind === "anchor") {
        const id = classified.id;
        return (
          <a
            href={hrefForLink(classified)}
            {...rest}
            onClick={(e) => {
              e.preventDefault();
              scrollToAnchor(id);
            }}
          >
            {children}
          </a>
        );
      }
      const targetRel = classified.rel;
      return (
        <a
          href={hrefForLink(classified)}
          {...rest}
          onClick={(e) => {
            e.preventDefault();
            useViewerStore.getState().openFile(workspaceId, targetRel, { pinned: true });
          }}
        >
          {children}
        </a>
      );
    };

    return {
      h1,
      h2,
      h3,
      h4,
      h5,
      h6,
      img,
      a,
    } satisfies Components;
  })();

  return (
    <div ref={containerRef} className="md-preview h-full overflow-auto p-4">
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} urlTransform={(v: string) => v} components={components}>
        {text}
      </Markdown>
    </div>
  );
}

export function MarkdownView({ workspaceId, rel, mode }: RendererProps) {
  const strings = useStrings();
  const doc = useDocument(workspaceId, rel);
  const effectiveMode = mode ?? "preview";

  // In "Edit" the TextEditor shows its own loading/error state — no need to wait here (same
  // order as HtmlView/ImageView).
  if (effectiveMode === "edit") {
    return <TextEditor workspaceId={workspaceId} rel={rel} language="markdown" />;
  }

  if (!doc || doc.status === "loading") {
    return (
      <div className="p-3 text-xs text-muted">
        {strings.loading}
      </div>
    );
  }
  if (doc.status === "error") {
    return (
      <div className="p-3 text-xs text-blocked">
        {strings.errors.forCode(doc.error?.code ?? "io")}
      </div>
    );
  }

  if (effectiveMode === "split") {
    return (
      <div className="flex h-full">
        <div className="min-w-0 flex-1 border-r border-border">
          <TextEditor workspaceId={workspaceId} rel={rel} language="markdown" />
        </div>
        <div className="min-w-0 flex-1">
          <MarkdownPreview workspaceId={workspaceId} rel={rel} text={doc.text} />
        </div>
      </div>
    );
  }

  return <MarkdownPreview workspaceId={workspaceId} rel={rel} text={doc.text} />;
}
