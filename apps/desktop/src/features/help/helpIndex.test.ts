import { describe, expect, it } from "vitest";
import { HELP_SECTIONS, searchHelp, tocFor } from "./helpIndex";

describe("HELP_SECTIONS (faz7-spec §12.6/§12.10)", () => {
  it("includes the doc's own h1 as a section (pre-heading text has nowhere else to go)", () => {
    expect(HELP_SECTIONS.some((s) => s.language === "en" && s.doc === "user-guide.md" && s.level === 1 && s.title === "User guide")).toBe(true);
  });

  it("ids match the headings a reader would expect (plain ASCII headings, no special punctuation)", () => {
    const installation = HELP_SECTIONS.find((s) => s.doc === "user-guide.md" && s.title === "Installation");
    expect(installation?.id).toBe("installation");
  });
});

describe("tocFor (faz7-spec §10.2: only ## and ###)", () => {
  it("excludes the doc's own h1 title", () => {
    const toc = tocFor("user-guide.md");
    expect(toc.some((s) => s.level === 1)).toBe(false);
    expect(toc.length).toBeGreaterThan(0);
  });

  it("is scoped to one doc", () => {
    expect(tocFor("keybindings.md").every((s) => s.doc === "keybindings.md")).toBe(true);
  });
});

describe("searchHelp (faz7-spec §12.10)", () => {
  it("requires at least 2 characters", () => {
    expect(searchHelp("")).toEqual([]);
    expect(searchHelp("a")).toEqual([]);
  });

  it("is case-insensitive and matches heading text", () => {
    const results = searchHelp("WORKSPACES");
    expect(results.some((r) => r.doc === "user-guide.md" && r.title === "Workspaces")).toBe(true);
  });

  it("matches body text, not just headings", () => {
    const results = searchHelp("SmartScreen");
    expect(results.some((r) => r.doc === "troubleshooting.md")).toBe(true);
  });

  it("returns results in doc order (user guide, keybindings, troubleshooting), never more than 50", () => {
    const results = searchHelp("terminal");
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(50);
    const order: Record<string, number> = { "user-guide.md": 0, "keybindings.md": 1, "troubleshooting.md": 2 };
    const indices = results.map((r) => order[r.doc]);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });
});

describe("per-language index (Turkish help)", () => {
  it("tocFor returns the Turkish headings for tr and the English ones by default", () => {
    expect(tocFor("user-guide.md", "tr").some((s) => s.title === "Kurulum")).toBe(true);
    expect(tocFor("user-guide.md").some((s) => s.title === "Kurulum")).toBe(false);
    expect(tocFor("user-guide.md", "tr").every((s) => s.language === "tr")).toBe(true);
  });

  it("Turkish anchors keep Turkish letters, matching the rendered heading ids", () => {
    const section = HELP_SECTIONS.find((s) => s.language === "tr" && s.title === "Veri konumları");
    expect(section?.id).toBe("veri-konumları");
  });

  it("search is scoped to one language", () => {
    expect(searchHelp("Kurulum", "tr").length).toBeGreaterThan(0);
    expect(searchHelp("Kurulum", "en")).toEqual([]);
  });

  it("Turkish search folds İ/i with Turkish rules and still matches English-cased words", () => {
    expect(searchHelp("izin kartı", "tr").some((r) => r.title === "İzin kartı")).toBe(true);
    expect(searchHelp("smartscreen", "tr").some((r) => r.doc === "troubleshooting.md")).toBe(true);
  });
});
