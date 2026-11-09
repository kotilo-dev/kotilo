/**
 * 0.7 docs check (D-074): pure helpers for the tree badges, the Docs tab's filter and the
 * "Update with agent…" prompt. The report itself comes from the Rust `agenthub-docs` crate.
 */
import type { Strings } from "../../app/i18n";
import type { DocDoc, DocLink, DocsReport } from "../../lib/ipc";
import type { DocsFilter } from "../../stores/docsStore";

export type { DocsFilter };

/** A doc's tree badge: missing (red) wins over stale (amber). */
export interface DocBadge {
  kind: "missing" | "stale";
  missing: number;
  /** Short baseline id when the doc is stale. */
  staleSince: string | null;
}

export function shortId(id: string): string {
  return id.slice(0, 7);
}

export function hasFindings(doc: DocDoc): boolean {
  return doc.missing.length > 0 || doc.stale !== null;
}

export function docBadge(doc: DocDoc | undefined): DocBadge | null {
  if (!doc || !hasFindings(doc)) return null;
  return {
    kind: doc.missing.length > 0 ? "missing" : "stale",
    missing: doc.missing.length,
    staleSince: doc.stale ? shortId(doc.stale.baseline) : null,
  };
}

/** "2 missing paths · stale since 3f2c1ab". */
export function badgeTooltip(badge: DocBadge, t: Pick<Strings["docs"], "missingCount" | "staleSince">): string {
  return [badge.missing > 0 ? t.missingCount(badge.missing) : null, badge.staleSince ? t.staleSince(badge.staleSince) : null].filter(Boolean).join(" · ");
}

/** Badges by repo-relative doc path (only docs with findings). */
export function badgeIndex(report: DocsReport | null | undefined): Map<string, DocBadge> {
  const out = new Map<string, DocBadge>();
  for (const doc of report?.docs ?? []) {
    const badge = docBadge(doc);
    if (badge) out.set(doc.path, badge);
  }
  return out;
}

/** Docs with findings for the filter, in report order (agent files first). */
export function filterDocs(docs: readonly DocDoc[], filter: DocsFilter): DocDoc[] {
  return docs.filter((d) => (filter === "missing" ? d.missing.length > 0 : filter === "stale" ? d.stale !== null : hasFindings(d)));
}

export function findingCounts(docs: readonly DocDoc[]): { all: number; missing: number; stale: number } {
  return { all: filterDocs(docs, "all").length, missing: filterDocs(docs, "missing").length, stale: filterDocs(docs, "stale").length };
}

/** A docs.toml `covers` glob has no line in the doc itself. */
export function isConfigLink(link: DocLink): boolean {
  return link.source === "config" && link.line === 0;
}

/**
 * The English prompt for "Update with agent…": doc path, missing paths with their lines, the
 * stale reason (commit subjects and changed covered files). Never any doc content (rule 5 –
 * and the agent can read the file itself).
 */
export function buildDocsPrompt(doc: DocDoc, configPath: string | null): string {
  const parts = [`Update ${doc.path} so it matches the current code. Do not change code. Keep the existing structure.`];
  if (doc.missing.length > 0) {
    const lines = doc.missing.map((l) =>
      isConfigLink(l) ? `- ${l.target} (listed in ${configPath ?? ".kotilo/docs.toml"}, matches nothing)` : `- ${l.target} (line ${l.line})`,
    );
    parts.push(`Paths named in ${doc.path} that do not exist:\n${lines.join("\n")}`);
  }
  if (doc.stale) {
    const st = doc.stale;
    const since = st.baselineKind === "reviewed" ? `it was last reviewed (${shortId(st.baseline)})` : `its last change (${shortId(st.baseline)})`;
    const commits = st.commits.map((c) => `- ${shortId(c.id)} ${c.subject}`);
    if (st.commitCount > st.commits.length) commits.push(`- … and ${st.commitCount - st.commits.length} more`);
    const files = st.files.map((f) => `- ${f.path}`);
    parts.push(
      `Code covered by ${doc.path} changed in ${st.commitCount} commit${st.commitCount === 1 ? "" : "s"} since ${since}:\n${commits.join("\n")}`,
    );
    if (files.length > 0) parts.push(`Changed files:\n${files.join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Example for the empty state (copyable). */
export const DOCS_TOML_EXAMPLE = `[[doc]]
path = "docs/api.md"
covers = ["src/api/**", "schema/api.json"]
`;
