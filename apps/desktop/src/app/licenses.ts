/**
 * The repo-root `THIRD_PARTY_NOTICES` (generated, D-046), bundled as text. Loaded on demand via
 * a dynamic import of a Vite virtual module (vite.config.ts) so the ~500 KB text is its own
 * chunk and never part of startup.
 */
let cached: Promise<string> | null = null;

export function loadThirdPartyNotices(): Promise<string> {
  cached ??= import("virtual:third-party-notices").then((m) => m.default).catch((e: unknown) => {
    cached = null;
    throw e;
  });
  return cached;
}

/** Lines containing `query` (case-insensitive); the whole text for an empty query. */
export function filterNotices(text: string, query: string): { text: string; matches: number | null } {
  const q = query.trim().toLowerCase();
  if (!q) return { text, matches: null };
  const lines = text.split(/\r?\n/).filter((line) => line.toLowerCase().includes(q));
  return { text: lines.join("\n"), matches: lines.length };
}
