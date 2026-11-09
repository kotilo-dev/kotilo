import { describe, expect, it } from "vitest";
import type { DocDoc, DocsReport } from "../../lib/ipc";
import { en } from "../../app/i18n/en";
import { tr } from "../../app/i18n/tr";
import { badgeIndex, badgeTooltip, buildDocsPrompt, docBadge, filterDocs, findingCounts } from "./docsLogic";

const BASE = "3f2c1ab9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3";

const clean: DocDoc = { path: "README.md", agentFile: false, links: [{ target: "src/a.ts", source: "link", line: 3, exists: true }], missing: [], stale: null };
const missing: DocDoc = {
  path: "AGENTS.md",
  agentFile: true,
  links: [],
  missing: [
    { target: "src/old.ts", source: "inline", line: 12, exists: false },
    { target: "hub/Api/**", source: "config", line: 0, exists: false },
  ],
  stale: null,
};
const stale: DocDoc = {
  path: "docs/api.md",
  agentFile: false,
  links: [],
  missing: [],
  stale: {
    baseline: BASE,
    baselineKind: "reviewed",
    reviewedMissing: false,
    commits: [
      { id: "9a8b7c6d5e4f", subject: "Add order cancel route", date: "2026-11-02T10:00:00Z" },
      { id: "1b2c3d4e5f6a", subject: "Rename order status", date: "2026-11-01T10:00:00Z" },
    ],
    commitCount: 5,
    files: [
      { path: "src/api/orders.ts", commits: 2 },
      { path: "src/api/routes.ts", commits: 1 },
    ],
  },
};
const both: DocDoc = { ...stale, path: "docs/setup.md", missing: [{ target: "scripts/x.ps1", source: "link", line: 4, exists: false }] };

describe("docBadge", () => {
  it("missing wins over stale, no badge without findings", () => {
    expect(docBadge(clean)).toBeNull();
    expect(docBadge(undefined)).toBeNull();
    expect(docBadge(missing)).toEqual({ kind: "missing", missing: 2, staleSince: null });
    expect(docBadge(stale)).toEqual({ kind: "stale", missing: 0, staleSince: "3f2c1ab" });
    expect(docBadge(both)).toEqual({ kind: "missing", missing: 1, staleSince: "3f2c1ab" });
  });

  it("tooltip names missing paths and the stale baseline", () => {
    expect(badgeTooltip(docBadge(both)!, en.docs)).toBe("1 missing path · stale since 3f2c1ab");
    expect(badgeTooltip(docBadge(missing)!, en.docs)).toBe("2 missing paths");
    expect(badgeTooltip(docBadge(stale)!, tr.docs)).toBe("eskimiş (3f2c1ab sonrası)");
  });

  it("indexes badges by path", () => {
    const report = { docs: [clean, missing, stale] } as unknown as DocsReport;
    const index = badgeIndex(report);
    expect([...index.keys()]).toEqual(["AGENTS.md", "docs/api.md"]);
    expect(badgeIndex(null).size).toBe(0);
  });
});

describe("filterDocs", () => {
  it("keeps report order and only docs with findings", () => {
    const docs = [missing, clean, stale, both];
    expect(filterDocs(docs, "all").map((d) => d.path)).toEqual(["AGENTS.md", "docs/api.md", "docs/setup.md"]);
    expect(filterDocs(docs, "missing").map((d) => d.path)).toEqual(["AGENTS.md", "docs/setup.md"]);
    expect(filterDocs(docs, "stale").map((d) => d.path)).toEqual(["docs/api.md", "docs/setup.md"]);
    expect(findingCounts(docs)).toEqual({ all: 3, missing: 2, stale: 2 });
  });
});

describe("buildDocsPrompt", () => {
  it("names missing paths with lines and the config entry", () => {
    expect(buildDocsPrompt(missing, ".kotilo/docs.toml")).toBe(
      [
        "Update AGENTS.md so it matches the current code. Do not change code. Keep the existing structure.",
        "",
        "Paths named in AGENTS.md that do not exist:",
        "- src/old.ts (line 12)",
        "- hub/Api/** (listed in .kotilo/docs.toml, matches nothing)",
      ].join("\n"),
    );
  });

  it("explains staleness with commit subjects and changed files", () => {
    const prompt = buildDocsPrompt(stale, null);
    expect(prompt).toBe(
      [
        "Update docs/api.md so it matches the current code. Do not change code. Keep the existing structure.",
        "",
        "Code covered by docs/api.md changed in 5 commits since it was last reviewed (3f2c1ab):",
        "- 9a8b7c6 Add order cancel route",
        "- 1b2c3d4 Rename order status",
        "- … and 3 more",
        "",
        "Changed files:",
        "- src/api/orders.ts",
        "- src/api/routes.ts",
      ].join("\n"),
    );
  });

  it("uses the last change as baseline wording and combines both findings", () => {
    const doc: DocDoc = { ...both, stale: { ...stale.stale!, baselineKind: "lastTouch", commitCount: 1, commits: [stale.stale!.commits[0]!], files: [] } };
    const prompt = buildDocsPrompt(doc, null);
    expect(prompt).toContain("- scripts/x.ps1 (line 4)");
    expect(prompt).toContain("changed in 1 commit since its last change (3f2c1ab):");
    expect(prompt).not.toContain("Changed files:");
  });
});
