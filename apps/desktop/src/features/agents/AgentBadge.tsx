import type { AgentState } from "../../lib/ipc";

const STATE_BG_CLASS: Record<AgentState, string> = {
  blocked: "bg-blocked",
  working: "bg-working",
  done: "bg-done",
  idle: "bg-idle",
};

/**
 * Small coloured dot badge (faz5-spec §2.3): workspace tree root row + terminal tab.
 * Renders nothing when `state` is `null`/`undefined` (no agent, no badge).
 */
export function AgentBadge({ state }: { state: AgentState | null | undefined }) {
  if (!state) return null;
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STATE_BG_CLASS[state]}`} />;
}
