/**
 * 0.7 docs check entry points: the workspace context menu ("Check docs") and the palette
 * ("Docs: Check") both open the workspace's Docs tab and run the check.
 */
import { registerCommand } from "../../app/commands";
import { strings } from "../../app/strings";
import { useDocsStore } from "../../stores/docsStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useRouteStore } from "../../stores/routeStore";
import { useViewerStore } from "../../stores/viewerStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";

/** Shows the workspace (default: the active one) with its Docs tab and re-checks it. */
export function openDocsCheck(workspaceId?: string | null): void {
  const id = workspaceId ?? useWorkspaceStore.getState().activeId;
  if (!id) return;
  useRouteStore.getState().navigate("workspace");
  if (useWorkspaceStore.getState().activeId !== id) void useWorkspaceStore.getState().setActive(id);
  useViewerStore.getState().openDocs(id);
  useLayoutStore.getState().setVisible("viewer", true);
  void useDocsStore.getState().refresh(id);
}

/** "Docs: Check" in the palette; returns the uninstaller. */
export function installDocsCommands(): () => void {
  return registerCommand({
    id: "docs.check",
    title: () => strings.docs.commandTitle,
    category: () => strings.docs.commandCategory,
    enabled: () => useWorkspaceStore.getState().activeId !== null,
    run: () => openDocsCheck(),
  });
}
