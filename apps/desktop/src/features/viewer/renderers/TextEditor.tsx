/**
 * Monaco-based text editor (faz3-spec §2/§5.5). The document lifecycle (load/release) is **not**
 * here but in `ViewerPanel` — this component only reads/writes the document already loaded in
 * `documentStore` (so preview modes can reach the text without ever mounting the editor).
 *
 * Local Monaco bundle: `./monacoSetup` (D12 — no CDN, `loader.config({ monaco })`).
 */
import { useEffect, useRef } from "react";
import Editor, { loader } from "@monaco-editor/react";
import type { editor as MonacoEditorNs } from "monaco-editor";
import xmlFormat from "xml-formatter";
import { monaco } from "./monacoSetup";
import { XML_LANGUAGE_EXTENSIONS, extensionOf, languageForRel, modelPathFor, monacoThemeFor } from "./textEditorSupport";
import { useDocument, useDocumentStore } from "../../../stores/documentStore";
import { useToastStore } from "../../../stores/toastStore";
import { useViewerStore, type RevealTarget } from "../../../stores/viewerStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { strings, useStrings } from "../../../app/strings";
import { useResolvedTheme } from "../../../app/theme/resolvedTheme";

loader.config({ monaco });

export interface TextEditorProps {
  workspaceId: string;
  rel: string;
  language?: string;
}

// Other files (`ExternalChangeBanner`, renderers) still import `languageForRel`/`modelPathFor`/
// `monacoThemeFor` from here — the real definitions live in `./textEditorSupport` (Monaco-free,
// directly testable; see that file's header).
export { languageForRel, modelPathFor, monacoThemeFor };

/** faz4-spec §2.6: terminal file path link — scroll to the line, place the cursor, focus. */
function applyReveal(editorInstance: MonacoEditorNs.IStandaloneCodeEditor, target: RevealTarget): void {
  editorInstance.revealLineInCenter(target.line);
  editorInstance.setPosition({ lineNumber: target.line, column: target.column ?? 1 });
  editorInstance.focus();
}

async function formatDocument(
  editorInstance: MonacoEditorNs.IStandaloneCodeEditor,
  ext: string,
  showToast: (message: string) => void,
): Promise<void> {
  const model = editorInstance.getModel();
  if (!model) return;

  if (ext === "json") {
    await editorInstance.getAction("editor.action.formatDocument")?.run();
    return;
  }

  if (XML_LANGUAGE_EXTENSIONS.has(ext)) {
    try {
      const formatted = xmlFormat(model.getValue(), { indentation: "  ", collapseContent: true });
      editorInstance.executeEdits("agenthub.format", [{ range: model.getFullModelRange(), text: formatted }]);
      editorInstance.pushUndoStop();
    } catch {
      showToast(strings.viewer.formatError);
    }
  }
}

export function TextEditor({ workspaceId, rel, language }: TextEditorProps) {
  const strings = useStrings();
  const doc = useDocument(workspaceId, rel);
  const setText = useDocumentStore((s) => s.setText);
  const showToast = useToastStore((s) => s.show);
  const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);
  const theme = useResolvedTheme((s) => s.theme);
  const editorFont = useSettingsStore((s) => s.settings.editor);

  // faz4-spec §2.6: `RendererProps` has a fixed shape (see `types.ts`), so the reveal request
  // doesn't flow as a prop — TextEditor finds its tab in viewerStore by (workspaceId, rel). It
  // works for Markdown/HtmlView "edit" mode too, since they use the same TextEditor (same rel).
  const tab = useViewerStore((s) => s.byWorkspace[workspaceId]?.tabs.find((t) => t.rel === rel));
  const clearReveal = useViewerStore((s) => s.clearReveal);
  const revealTarget = tab?.revealTarget;

  useEffect(() => {
    if (!revealTarget || !tab) return;
    const editorInstance = editorRef.current;
    if (!editorInstance) return; // not mounted yet: `onMount` applies it
    applyReveal(editorInstance, revealTarget);
    clearReveal(workspaceId, tab.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget, tab?.id]);

  const ext = extensionOf(rel);
  const resolvedLanguage = language ?? languageForRel(rel);
  const modelPath = modelPathFor(workspaceId, rel);

  // finding #1: `@monaco-editor/react` silently reuses an existing model for a `path` and does
  // **not update its text** — if the same tab remounts after the file changed on disk and was
  // reloaded (or the same rel opens elsewhere), the stale model is shown; the first keystroke
  // writes that stale text to the store and Ctrl+S overwrites the disk. This component disposes
  // its model on unmount (`useEffect` below) — and, against a StrictMode double mount or an
  // unusual remount order, also disposes any model still sitting at that URI right before mount
  // (`beforeMount`), so Editor always creates a fresh model from the `value` prop (the current
  // text in documentStore).
  useEffect(() => {
    return () => {
      editorRef.current = null;
      // Deferred + conditional: on StrictMode's fake unmount the model is still bound to a live
      // editor — dispose only if no editor uses it (on a real unmount @monaco-editor/react has
      // already disposed the editor).
      const uri = monaco.Uri.parse(modelPath);
      setTimeout(() => {
        const model = monaco.editor.getModel(uri);
        if (model && !monaco.editor.getEditors().some((e) => e.getModel() === model)) model.dispose();
      }, 0);
    };
  }, [modelPath]);

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

  return (
    <div className="flex h-full flex-col">
      {doc.readOnly && (
        <div className="shrink-0 bg-surface-1 px-2 py-1 text-label text-muted">
          {strings.viewer.readOnlyNotice(doc.readOnlyReason)}
        </div>
      )}
      {doc.mixedEol && (
        <div className="shrink-0 bg-surface-1 px-2 py-1 text-label text-muted">
          {strings.viewer.mixedEolNotice(doc.eol)}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Editor
          key={modelPath}
          theme={monacoThemeFor(theme)}
          language={resolvedLanguage}
          path={modelPath}
          value={doc.text}
          options={{
            readOnly: doc.readOnly,
            fontFamily: editorFont.fontFamily,
            fontSize: editorFont.fontSize,
            minimap: { enabled: false },
            automaticLayout: true,
          }}
          beforeMount={(monacoInstance) => {
            // finding #1: dispose any model still sitting at this URI right before mount — Editor
            // then always creates a new model from `value` (fresh text from documentStore) and
            // never silently reuses a stale one.
            monacoInstance.editor.getModel(monacoInstance.Uri.parse(modelPath))?.dispose();
          }}
          onMount={(editorInstance) => {
            editorRef.current = editorInstance;
            const model = editorInstance.getModel();
            // The model is always LF (the backend already normalizes text to \n) — this pins
            // Monaco's own line-ending insertion to LF (faz3-spec §2 TextEditor).
            if (model) model.setEOL(monaco.editor.EndOfLineSequence.LF);
            // faz4-spec §2.6: revealTarget may be set before mount (Monaco loads async) — apply
            // it here too, or the only chance is missed.
            if (revealTarget && tab) {
              applyReveal(editorInstance, revealTarget);
              clearReveal(workspaceId, tab.id);
            }
            editorInstance.addAction({
              id: "agenthub.formatDocument",
              label: "Format Document",
              keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
              run: () => void formatDocument(editorInstance, ext, showToast),
            });
            // faz7-spec §12.2: F1 is the app's global Help shortcut (`GLOBAL_COMBOS`/`App.tsx`) —
            // remove Monaco's own F1 binding (its built-in command palette) so the keypress
            // reaches the global handler instead of being swallowed here. `addKeybindingRule` is
            // a `monaco.editor`-namespace API (applies wherever Monaco is used, not per-instance);
            // re-registering it on every mount is harmless (idempotent override).
            monaco.editor.addKeybindingRule({ keybinding: monaco.KeyCode.F1, command: null });
          }}
          onChange={(value) => {
            // §5.16: only from Monaco's onChange — never written via getValue() on mount (this
            // callback only fires on real content changes).
            if (value === undefined) return;
            setText(workspaceId, rel, value);
          }}
        />
      </div>
    </div>
  );
}
