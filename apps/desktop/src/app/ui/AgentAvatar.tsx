/** DESIGN_SYSTEM §2.4: square avatar, agent letter in its ink on its tile. */
import { agentIdentity } from "../agentIdentity";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { agentDisplayName } from "./agents";

export function AgentAvatar({ agent, size = 28 }: { agent: string; size?: number }) {
  const definitions = useDefinitionsStore((s) => s.definitions);
  const id = agentIdentity(agent, definitions);
  const name = agentDisplayName(agent, definitions);
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-button font-bold"
      style={{ width: size, height: size, background: id.bg, color: id.ink, fontSize: Math.round(size * 0.46) }}
    >
      {id.letter}
    </span>
  );
}
