/**
 * Dirty document collection + "Save all" helpers (faz3-spec §2 close confirmation, finding #6).
 * `CloseGuard` (app close) and `Tree` (workspace removal) share this logic — it lives here once
 * instead of a copy in each.
 */
import { docKey, useDocumentStore } from "../../stores/documentStore";
import { useViewerStore } from "../../stores/viewerStore";

export interface DirtyDocRef {
  workspaceId: string;
  rel: string;
}

function collectDirtyDocsFiltered(matches: (workspaceId: string) => boolean): DirtyDocRef[] {
  const result: DirtyDocRef[] = [];
  const byWorkspace = useViewerStore.getState().byWorkspace;
  const docs = useDocumentStore.getState().docs;
  for (const [workspaceId, ws] of Object.entries(byWorkspace)) {
    if (!matches(workspaceId)) continue;
    for (const tab of ws.tabs) {
      const doc = docs[docKey(workspaceId, tab.rel)];
      // finding #2: a read-only document can't become dirty in Monaco, but it is filtered here
      // defensively too — "Save all" never tries to write a read-only document.
      if (doc?.dirty && !doc.readOnly) result.push({ workspaceId, rel: tab.rel });
    }
  }
  return result;
}

/** Dirty documents across all workspaces (for app close). */
export function collectDirtyDocs(): DirtyDocRef[] {
  return collectDirtyDocsFiltered(() => true);
}

/** Dirty documents of `workspaceId` only (for workspace removal, finding #6). */
export function collectDirtyDocsForWorkspace(workspaceId: string): DirtyDocRef[] {
  return collectDirtyDocsFiltered((ws) => ws === workspaceId);
}

/** Saves them all; `true` if every save succeeded. */
export async function saveAllDirty(dirty: DirtyDocRef[]): Promise<boolean> {
  const save = useDocumentStore.getState().save;
  const results = await Promise.all(dirty.map((d) => save(d.workspaceId, d.rel)));
  return results.every((err) => err === null);
}
