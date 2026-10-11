import { useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { useStrings } from "../../app/strings";
import { useResolvedTheme } from "../../app/theme/resolvedTheme";
import { fsReadText } from "../../lib/ipc";
import { useDocument, useDocumentStore } from "../../stores/documentStore";
import { languageForRel, monacoThemeFor } from "./renderers/TextEditor";
interface ExternalChangeBannerProps {
  workspaceId: string;
  rel: string;
}

/**
 * "The version on disk changed" banner (faz3-spec §2 external change flow): Reload / Keep mine /
 * Compare (Monaco DiffEditor: disk on the left, mine on the right). Renders nothing while
 * `doc.external === null`.
 */
export function ExternalChangeBanner({ workspaceId, rel }: ExternalChangeBannerProps) {
  const strings = useStrings();
  const doc = useDocument(workspaceId, rel);
  const reload = useDocumentStore((s) => s.reload);
  const keepMine = useDocumentStore((s) => s.keepMine);
  const [diskText, setDiskText] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const theme = useResolvedTheme((s) => s.theme);

  if (!doc || doc.status !== "ready" || !doc.external) return null;

  async function openCompare() {
    setComparing(true);
    try {
      const file = await fsReadText(workspaceId, rel);
      setDiskText(file.text);
    } catch {
      setDiskText(null);
    }
  }

  return (
    <>
      <div
        className="flex shrink-0 items-center justify-between gap-3 bg-working px-2 py-1 text-label text-on-accent"
      >
        <span>{strings.viewer.externalChange.message}</span>
        <div className="flex gap-2">
          <button type="button" className="underline" onClick={() => void reload(workspaceId, rel)}>
            {strings.viewer.externalChange.reload}
          </button>
          <button type="button" className="underline" onClick={() => keepMine(workspaceId, rel)}>
            {strings.viewer.externalChange.keepMine}
          </button>
          <button type="button" className="underline" onClick={() => void openCompare()}>
            {strings.viewer.externalChange.compare}
          </button>
        </div>
      </div>

      {comparing && (
        <div className="fixed inset-0 z-50 flex flex-col bg-bg">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2 text-xs text-text">
            <span>{strings.viewer.externalChange.compareTitle}</span>
            <button type="button" onClick={() => setComparing(false)} className="text-muted">
              {strings.viewer.externalChange.close}
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <DiffEditor
              theme={monacoThemeFor(theme)}
              language={languageForRel(rel)}
              original={diskText ?? ""}
              modified={doc.text}
              // `compare-disk:`/`compare-mine:` prefixes: TextEditor's `modelPathFor` always starts
              // with "/" (finding #1), so these path spaces never collide.
              originalModelPath={`compare-disk:${workspaceId}/${rel}`}
              modifiedModelPath={`compare-mine:${workspaceId}/${rel}`}
              options={{ readOnly: true, renderSideBySide: true }}
            />
          </div>
        </div>
      )}
    </>
  );
}
