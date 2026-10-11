/**
 * Split pane (DESIGN_SYSTEM §7.3, M4): a workspace's terminal panel shows its active tab on
 * the left and, when split, a second tab on the right. Pure layout rules; `terminalStore`
 * applies them and persists `splitIndex` next to `activeIndex` in the `terminals` slice.
 */

export interface SplitTargets {
  /** Tab on the left half (the workspace's active tab). */
  left: string;
  /** Tab on the right half. */
  right: string;
}

function neighborOf(tabIds: readonly string[], tabId: string): string | null {
  const idx = tabIds.indexOf(tabId);
  if (idx === -1) return null;
  return tabIds[idx + 1] ?? tabIds[idx - 1] ?? null;
}

/**
 * "Split right" on a tab (tab menu, or dragging the tab onto the right half): that tab goes
 * right. The left keeps the active tab, or its neighbour when the tab itself is active.
 * `null` when there is no second tab to show.
 */
export function splitTabToRight(tabIds: readonly string[], activeTabId: string | null, tabId: string): SplitTargets | null {
  if (!tabIds.includes(tabId)) return null;
  if (activeTabId && activeTabId !== tabId && tabIds.includes(activeTabId)) return { left: activeTabId, right: tabId };
  const left = neighborOf(tabIds, tabId);
  return left ? { left, right: tabId } : null;
}

/**
 * The header split button of a pane: the pane stays on the left and its neighbour opens on
 * the right. `null` when it is the only tab (the caller opens a new terminal for the right).
 */
export function splitBeside(tabIds: readonly string[], tabId: string): SplitTargets | null {
  const right = neighborOf(tabIds, tabId);
  return right ? { left: tabId, right } : null;
}

/** Active/split after a tab was removed: closing either half returns to a single pane. */
export function splitAfterRemove(
  activeTabId: string | null,
  splitTabId: string | null,
  removedId: string,
): { activeTabId: string | null; splitTabId: null } | null {
  if (!splitTabId) return null;
  if (removedId === splitTabId) return { activeTabId, splitTabId: null };
  if (removedId === activeTabId) return { activeTabId: splitTabId, splitTabId: null };
  return null;
}

/** Restores the split from `state.json` indices; invalid or equal indices mean no split. */
export function restoreSplit(tabIds: readonly string[], activeIndex: number, splitIndex: unknown): string | null {
  if (typeof splitIndex !== "number" || !Number.isInteger(splitIndex) || splitIndex === activeIndex) return null;
  return tabIds[splitIndex] ?? null;
}
