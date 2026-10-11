/**
 * HTML renderer (faz3-spec §3): Source (TextEditor) / Preview: a sandboxed `<iframe>`, scripts off
 * by default (`sandbox=""`); "Enable scripts" in the toolbar (`sandbox="allow-scripts"`) — **never**
 * together with `allow-same-origin`. `src = adfsUrl(ws, rel) + "?v=" + hash`: the HTML is loaded in
 * `documentStore` (TEXTUAL_KINDS), so `doc.hash` is used directly — it doesn't change while dirty
 * (the disk version is shown) and changes on save (the iframe reloads via `key`).
 */
import { useState } from "react";
import { useStrings } from "../../../app/strings";
import { adfsUrl } from "../../../lib/ipc";
import { useDocument } from "../../../stores/documentStore";
import { TextEditor } from "./TextEditor";
import type { RendererProps } from "./types";

export function HtmlView({ workspaceId, rel, mode }: RendererProps) {
  const strings = useStrings();
  const doc = useDocument(workspaceId, rel);
  const [scriptsEnabled, setScriptsEnabled] = useState(false);
  const effectiveMode = mode ?? "preview";

  if (effectiveMode === "edit") {
    return <TextEditor workspaceId={workspaceId} rel={rel} language="html" />;
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

  const hash = doc.hash;
  const src = `${adfsUrl(workspaceId, rel)}?v=${encodeURIComponent(hash)}`;
  const sandbox = scriptsEnabled ? "allow-scripts" : "";

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-2 py-1 text-label">
        <span className="text-muted">{strings.viewer.html.previewNotice}</span>
        <label className="flex items-center gap-1 text-text">
          <input type="checkbox" checked={scriptsEnabled} onChange={(e) => setScriptsEnabled(e.target.checked)} />
          {strings.viewer.html.enableScripts}
        </label>
      </div>
      <iframe
        key={hash}
        src={src}
        sandbox={sandbox}
        title={rel}
        className="min-h-0 flex-1 border-0 bg-paper"
      />
    </div>
  );
}
