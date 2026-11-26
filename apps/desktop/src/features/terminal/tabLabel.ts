import { agentIdentity } from "../../app/agentIdentity";
import { agentDisplayName } from "../../app/ui/agents";
import { useAgentStore } from "../../stores/agentStore";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { useTerminalStore, type TerminalTab } from "../../stores/terminalStore";

export interface TabLabel {
  /** Plain-text title: "C Claude Code" for an agent tab, the tab's own title otherwise. */
  text: string;
  /** The title without the agent letter (what follows the avatar in the tab strip). */
  name: string;
  /** Avatar key (adapter id or pane kind) when an agent runs in the tab and the title was not edited. */
  agent: string | null;
}

type LabelTab = Pick<TerminalTab, "title" | "titleEdited" | "agentCommand">;

/**
 * Pure part of {@link useTabLabels}: a user-edited title always wins; plain shells keep theirs. An agent
 * tab shows its avatar plus the live (OSC) title when that is more than the shell/profile default, else the
 * agent's display name.
 */
export function tabLabelFor(tab: LabelTab, agent: string | null, agentName: string, defaultTitles: readonly string[]): TabLabel {
  if (tab.titleEdited || !agent) return { text: tab.title, name: tab.title, agent: null };
  const live = tab.title.trim();
  const isDefault = live === "" || live === tab.agentCommand || defaultTitles.some((d) => d.toLowerCase() === live.toLowerCase());
  const name = isDefault ? agentName : live;
  return { text: `${agentIdentity(agent).letter} ${name}`, name, agent };
}

/** Appends " 2", " 3" (in tab order) to agent labels that would otherwise read the same. Shells are left alone. */
export function dedupeTabLabels(labels: readonly TabLabel[]): TabLabel[] {
  const seen = new Map<string, number>();
  return labels.map((l) => {
    if (!l.agent) return l;
    const n = (seen.get(l.text) ?? 0) + 1;
    seen.set(l.text, n);
    return n === 1 ? l : { ...l, text: `${l.text} ${n}`, name: `${l.name} ${n}` };
  });
}

/** One label per tab of a strip, de-duplicated across the strip. */
export function useTabLabels(tabs: readonly TerminalTab[]): TabLabel[] {
  const agents = useAgentStore((s) => s.agents);
  const definitions = useDefinitionsStore((s) => s.definitions);
  const profiles = useTerminalStore((s) => s.profiles);
  const defaults = profiles.map((p) => p.name);
  return dedupeTabLabels(
    tabs.map((tab) => {
      const a = tab.status === "running" && tab.paneId ? agents.find((x) => x.paneId === tab.paneId) : undefined;
      const id = a ? (a.adapterId ?? a.kind) : null;
      return tabLabelFor(tab, id, id ? agentDisplayName(id, definitions) : "", defaults);
    }),
  );
}

/** The label of a single tab (no strip-wide de-duplication), e.g. for a split header. */
export function useTabLabel(tab: TerminalTab): TabLabel {
  return useTabLabels([tab])[0]!;
}
