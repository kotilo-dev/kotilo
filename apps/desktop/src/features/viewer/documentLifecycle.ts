/**
 * Pure logic producing the `documentStore.load`/`release` calls for tab opens/closes
 * (faz3-spec §5.5, finding #4). Used by `ViewerPanel`'s `useDocumentLifecycle` hook.
 *
 * The key is **tab.id**, not `docKey`: a retarget (rename, `viewerStore.retarget`) keeps the same
 * tab.id with a different `rel`. A naive diff on `docKey` would read that as "old tab closed +
 * new tab opened" — producing both a needless `load()` (the refcount was already moved by
 * `rekeyDocsForRetarget`) and, when the tab later closes, an extra `release()`; the result is a
 * refcount one too high (leak) or a ghost reference. Keying by tab.id classifies a retarget
 * correctly as "neither load nor release".
 */

export interface LoadedTabEntry {
  workspaceId: string;
  rel: string;
}

export interface LifecycleDiff {
  toLoad: LoadedTabEntry[];
  toRelease: LoadedTabEntry[];
}

/** Pure: compares the previous and current tabId → {workspaceId, rel} maps. */
export function diffLoadedTabs(
  previous: Map<string, LoadedTabEntry>,
  current: Map<string, LoadedTabEntry>,
): LifecycleDiff {
  const toLoad: LoadedTabEntry[] = [];
  const toRelease: LoadedTabEntry[] = [];
  for (const [tabId, entry] of current) {
    if (!previous.has(tabId)) toLoad.push(entry);
  }
  for (const [tabId, entry] of previous) {
    if (!current.has(tabId)) toRelease.push(entry);
  }
  return { toLoad, toRelease };
}
