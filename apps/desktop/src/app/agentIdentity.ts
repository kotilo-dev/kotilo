/**
 * Agent identity (DESIGN_SYSTEM §2.4): avatar letter + tile/ink colours. The adapter
 * definition (`adapter.json` `avatar`) is the source; built-in agents render their colours
 * through the `--agent-<key>-*` tokens in `index.css` (kept equal to their adapter.json by
 * `agentIdentity.test.ts`), user adapters with the hex values from their own file. Keyed by
 * both the desktop's pane `AgentKind` and the adapter id (`claude-code`, `codex`, …).
 */
import type { AdapterDefinition, AgentKind } from "../lib/ipc";
import { useDefinitionsStore } from "../stores/definitionsStore";

export type AgentIdentityKey =
  | "claude"
  | "codex"
  | "copilot"
  | "gemini"
  | "opencode"
  | "cursor"
  | "qwen"
  | "droid"
  | "other";

export interface AgentIdentity {
  key: AgentIdentityKey;
  letter: string;
  /** CSS value for the avatar tile background. */
  bg: string;
  /** CSS value for the avatar letter. */
  ink: string;
}

/** Fallback letters while the definitions are not loaded (same as the built-in adapter.json files). */
const LETTERS: Record<AgentIdentityKey, string> = {
  claude: "C",
  codex: "X",
  copilot: "P",
  gemini: "G",
  opencode: "O",
  cursor: "U",
  qwen: "Q",
  droid: "D",
  other: "?",
};

/** Adapter ids (and older aliases) that differ from the identity key. */
const ALIASES: Record<string, AgentIdentityKey> = {
  "claude-code": "claude",
  "copilot-cli": "copilot",
  "gemini-cli": "gemini",
  "cursor-cli": "cursor",
  "qwen-code": "qwen",
  "factory-droid": "droid",
};

/** Pane kinds whose adapter id differs from the kind. */
const ADAPTER_FOR_KIND: Partial<Record<string, string>> = { claude: "claude-code" };

export function agentIdentity(
  kindOrAdapterId: AgentKind | string,
  definitions: readonly AdapterDefinition[] = useDefinitionsStore.getState().definitions,
): AgentIdentity {
  const raw = kindOrAdapterId.toLowerCase();
  const key = (ALIASES[raw] ?? (raw in LETTERS ? raw : "other")) as AgentIdentityKey;
  const adapterId = ADAPTER_FOR_KIND[raw] ?? raw;
  const avatar = definitions.find((d) => d.id === adapterId)?.avatar ?? null;
  if (key === "other" && avatar) {
    // A user adapter: its colours are data from its own adapter.json.
    return { key, letter: avatar.letter, bg: avatar.bg, ink: avatar.ink };
  }
  return {
    key,
    letter: avatar?.letter ?? LETTERS[key],
    bg: `var(--agent-${key}-bg)`,
    ink: `var(--agent-${key}-ink)`,
  };
}
