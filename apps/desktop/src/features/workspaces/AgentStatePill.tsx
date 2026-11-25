import type { AgentState } from "../../lib/ipc";
import { useStrings } from "../../app/strings";

const PILL_CLASS: Partial<Record<AgentState, string>> = {
  blocked: "bg-blocked-bg text-blocked-ink",
  working: "bg-working-bg text-working-ink",
  done: "bg-done-bg text-done-ink",
};

/**
 * Small state label for a workspace's most urgent agent (Workspaces tab, switcher). Idle agents
 * show nothing: "nothing to look at" needs no label.
 */
export function AgentStatePill({ state }: { state: AgentState | null | undefined }) {
  const strings = useStrings();
  const cls = state ? PILL_CLASS[state] : undefined;
  if (!state || !cls) return null;
  return (
    <span
      data-testid="agent-state-pill"
      data-state={state}
      className={`shrink-0 whitespace-nowrap rounded-full px-1.5 py-px text-label ${cls}`}
    >
      {strings.agents.stateLabel[state]}
    </span>
  );
}
