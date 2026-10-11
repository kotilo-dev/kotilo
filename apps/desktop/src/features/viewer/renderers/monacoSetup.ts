/**
 * Local Monaco bundle (D12: no CDN). Consumed through `@monaco-editor/react`'s
 * `loader.config({ monaco })` (faz3-spec §2 TextEditor).
 *
 * Only `editor/editor.api` (the lean core) is imported — NOT `editor/editor.main`, which also
 * registers the TypeScript language service (and the heavy `ts.worker`). Workers are set up only
 * for editor/json/css/html (§2, §5.19) via Vite `?worker` imports.
 *
 * `basic-languages/monaco.contribution` registers every syntax highlighting (monarch) definition,
 * but each is **lazy** (`loader: () => import(...)`), so importing them all here adds no code size
 * — only the tokenizer of a language actually used is downloaded.
 */
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
import "monaco-editor/language/json/monaco.contribution";
import "monaco-editor/language/css/monaco.contribution";
import "monaco-editor/language/html/monaco.contribution";
import { PALETTES } from "../../../app/theme/palette";

import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      default:
        return new EditorWorker();
    }
  },
};

monaco.editor.defineTheme("agenthub-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": PALETTES.dark.terminalBg,
  },
});

/** Faz 6 §2/§10.8: light theme — matches the `[data-theme="light"]` tokens in `index.css`. */
monaco.editor.defineTheme("agenthub-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": PALETTES.light.terminalBg,
  },
});

export { monaco };
