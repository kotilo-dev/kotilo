/**
 * Markdown of an assistant answer (M7): GFM + highlighted code like the file preview
 * (`MarkdownView`), raw HTML off, a copy button on every code block. Links open in the
 * browser; images are not loaded (CSP), only their alt text / address is shown.
 */
import { useEffect, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "../viewer/renderers/markdownPreview.css";
import { useStrings } from "../../app/i18n";
import { useResolvedTheme } from "../../app/theme/resolvedTheme";
import { clipboardWriteText, openExternalUrl } from "../../lib/ipc";
import { setHljsTheme } from "../viewer/renderers/hljsTheme";
import { CheckIcon, CopyIcon } from "./icons";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];
const COPIED_MS = 1_500;

interface HastLike {
  type?: string;
  value?: string;
  children?: HastLike[];
}

/** Plain text of a hast node (the code inside a `<pre>`). */
export function hastText(node: HastLike | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** Copy button with a short "Copied" confirmation. */
export function CopyButton({ text, label, className = "" }: { text: string; label: string; className?: string }) {
  const s = useStrings().assistant;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={copied ? s.copied : label}
      title={copied ? s.copied : label}
      onClick={() => void clipboardWriteText(text).then(() => setCopied(true), () => {})}
      className={`inline-flex size-7 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-surface-5 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${className}`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function isWebUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

const COMPONENTS: Components = {
  pre: function Pre({ node, children }) {
    const s = useStrings().assistant;
    return (
      <div className="assistant-code group relative">
        <pre>{children}</pre>
        <CopyButton text={hastText(node as HastLike).replace(/\n$/, "")} label={s.copyCode} className="absolute right-1.5 top-1.5 bg-surface-3" />
      </div>
    );
  },
  a: function Link({ href, children }) {
    if (!href || !isWebUrl(href)) return <span>{children}</span>;
    return (
      <a
        href="#"
        title={href}
        onClick={(e) => {
          e.preventDefault();
          void openExternalUrl(href).catch(() => {});
        }}
      >
        {children}
      </a>
    );
  },
  img: function Img({ alt, src }) {
    return <span className="italic text-muted">{alt || src}</span>;
  },
};

export function AssistantMarkdown({ text, children }: { text: string; children?: ReactNode }) {
  const theme = useResolvedTheme((st) => st.theme);
  useEffect(() => setHljsTheme(theme), [theme]);
  return (
    <div className="md-preview assistant-md">
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
        {text}
      </Markdown>
      {children}
    </div>
  );
}
