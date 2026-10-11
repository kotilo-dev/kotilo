/**
 * Agent display names by adapter id: the definition's `displayName` first (built-in and user
 * adapters), then the built-in names while the definitions are not loaded, else the id.
 * Product names of the agents themselves (plain-text compatibility, PRD §8) – not translated.
 */
import type { AdapterDefinition, AgentKind } from "../../lib/ipc";
import { strings } from "../strings";
import { useDefinitionsStore } from "../../stores/definitionsStore";

const NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  copilot: "GitHub Copilot CLI",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  cursor: "Cursor CLI",
  qwen: "Qwen Code",
  droid: "Factory Droid",
};

export function agentDisplayName(
  agentId: string,
  definitions: readonly AdapterDefinition[] = useDefinitionsStore.getState().definitions,
): string {
  return definitions.find((d) => d.id === agentId)?.displayName ?? NAMES[agentId] ?? agentId;
}

/** A desktop pane record's agent name: its adapter's display name, else the coarse kind label. */
export function agentLabel(agent: { kind: AgentKind; adapterId?: string | null }): string {
  return agent.adapterId ? agentDisplayName(agent.adapterId) : strings.agents.kindLabel[agent.kind];
}
