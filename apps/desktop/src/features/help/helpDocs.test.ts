/**
 * faz7-spec §10.1 (BINDING, strict): the bundled docs must be non-empty, and every relative
 * link in them must resolve to either a bundled doc of the SAME language (optionally with an
 * anchor that exists in it) or an in-page anchor that exists in the SAME doc. A doc edit that
 * breaks a help link must fail this test — that's the whole point of bundling.
 */
import { describe, expect, it } from "vitest";
import type { Language } from "../../app/i18n";
import { HELP_DOCS, HELP_DOC_SETS, helpDocContent } from "./helpDocs";
import { HELP_SECTIONS, collectLinkHrefs } from "./helpIndex";
import { classifyLink } from "../viewer/renderers/mdLinks";

const LANGUAGES = Object.keys(HELP_DOC_SETS) as Language[];

describe("bundled help docs (faz7-spec §10.1)", () => {
  it("every language has the same docs, in the same order, and none is empty", () => {
    for (const language of LANGUAGES) {
      expect(HELP_DOC_SETS[language].map((d) => d.id)).toEqual(HELP_DOCS.map((d) => d.id));
      for (const doc of HELP_DOC_SETS[language]) {
        expect(doc.content.length, `${language}/${doc.id} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("the Turkish set is its own text, not a copy of the English one", () => {
    expect(helpDocContent("user-guide.md", "tr")).toMatch(/^# Kullanım kılavuzu/);
    expect(helpDocContent("user-guide.md", "en")).toMatch(/^# User guide/);
  });

  for (const language of LANGUAGES) {
    it(`${language}: every relative link resolves to a bundled doc and an existing anchor; external links are left alone`, () => {
      const docs = HELP_DOC_SETS[language];
      const idsByDoc = new Map<string, Set<string>>(docs.map((d) => [d.id, new Set<string>()]));
      for (const section of HELP_SECTIONS) {
        if (section.language === language) idsByDoc.get(section.doc)!.add(section.id);
      }

      for (const doc of docs) {
        for (const href of collectLinkHrefs(doc.content)) {
          const where = `${language}/${doc.id}`;
          const classified = classifyLink(doc.id, href);
          if (classified.kind === "external") continue; // http(s) — not our concern here
          if (classified.kind === "anchor") {
            expect(idsByDoc.get(doc.id)!.has(classified.id), `${where}: missing anchor #${classified.id} (from "${href}")`).toBe(true);
            continue;
          }
          if (classified.kind === "file") {
            const targetIds = idsByDoc.get(classified.rel);
            expect(targetIds, `${where}: link to unknown/unbundled doc "${classified.rel}" (from "${href}")`).toBeDefined();
            if (classified.hash) {
              expect(targetIds!.has(classified.hash), `${where}: ${classified.rel} has no anchor #${classified.hash} (from "${href}")`).toBe(
                true,
              );
            }
            continue;
          }
          throw new Error(`${where}: unsupported/disabled link target "${href}"`);
        }
      }
    });
  }
});
