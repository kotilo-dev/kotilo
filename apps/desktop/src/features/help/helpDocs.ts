/**
 * Bundled user docs (faz7-spec §10.1, §12): imported as raw text at BUILD time via Vite's
 * `?raw` — the in-app Help always matches the installed version; nothing is read from disk or
 * network at runtime. `development.md`/`manual-tests.md` are deliberately NOT included
 * (developer-only docs). One set per UI language (`docs/` English, `docs/tr/` Turkish) with
 * the same file ids, so cross-doc links work unchanged; anchors follow each set's headings.
 */
import userGuideRaw from "../../../docs/user-guide.md?raw";
import keybindingsRaw from "../../../docs/keybindings.md?raw";
import troubleshootingRaw from "../../../docs/troubleshooting.md?raw";
import userGuideTrRaw from "../../../docs/tr/user-guide.md?raw";
import keybindingsTrRaw from "../../../docs/tr/keybindings.md?raw";
import troubleshootingTrRaw from "../../../docs/tr/troubleshooting.md?raw";
import type { Language } from "../../app/i18n";

export type HelpDocId = "user-guide.md" | "keybindings.md" | "troubleshooting.md";

export interface HelpDoc {
  id: HelpDocId;
  content: string;
}

/** Order = tab order in the Help modal (§10.2). */
export const HELP_DOC_SETS: Record<Language, readonly HelpDoc[]> = {
  en: [
    { id: "user-guide.md", content: userGuideRaw },
    { id: "keybindings.md", content: keybindingsRaw },
    { id: "troubleshooting.md", content: troubleshootingRaw },
  ],
  tr: [
    { id: "user-guide.md", content: userGuideTrRaw },
    { id: "keybindings.md", content: keybindingsTrRaw },
    { id: "troubleshooting.md", content: troubleshootingTrRaw },
  ],
};

/** The English set: the reference every other language mirrors. */
export const HELP_DOCS: readonly HelpDoc[] = HELP_DOC_SETS.en;

const HELP_DOC_IDS: ReadonlySet<string> = new Set(HELP_DOCS.map((d) => d.id));

export function isHelpDocId(value: string): value is HelpDocId {
  return HELP_DOC_IDS.has(value);
}

/** A doc in the given language; falls back to English if that language lacks it. */
export function helpDocContent(id: HelpDocId, language: Language = "en"): string {
  const doc = HELP_DOC_SETS[language].find((d) => d.id === id) ?? HELP_DOCS.find((d) => d.id === id)!;
  return doc.content;
}
