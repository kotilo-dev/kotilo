/**
 * Keys an agent's own permission prompt accepts (D-016), from its adapter definition
 * (`adapter.json` `permissionKeys`). The permission card sends them with `pane_send_keys`
 * (key notation: `Esc`, `Enter`, `1`, `y`, …; Rust parses them). The Rust test
 * `repo_builtin_permission_keys_are_complete_and_parse` checks the built-in files.
 */
import type { AdapterDefinition } from "../../lib/ipc";
import { definitionFor } from "../../stores/definitionsStore";

export interface PermissionKeys {
  allowOnce: string;
  /** Only when the agent offers a persistent "always" option. */
  alwaysAllow?: string;
  /** The "always" option's text as the agent shows it (read from the screen, 0.3.2). */
  alwaysLabel?: string;
  deny: string;
}

/**
 * The card's keys, or null when the definition has no complete pair (e.g. Droid, whose keys
 * are not verified): the card then offers only "Answer in terminal".
 */
export function permissionKeysOf(def: AdapterDefinition | undefined): PermissionKeys | null {
  const pk = def?.permissionKeys;
  if (!pk?.allowOnce || !pk.deny) return null;
  return pk.alwaysAllow ? { allowOnce: pk.allowOnce, alwaysAllow: pk.alwaysAllow, deny: pk.deny } : { allowOnce: pk.allowOnce, deny: pk.deny };
}

export function permissionKeysFor(adapterId: string): PermissionKeys | null {
  return permissionKeysOf(definitionFor(adapterId));
}

/**
 * Tools whose "permission" dialog is really a multiple-choice question (Claude Code's
 * `AskUserQuestion` and plan approval `ExitPlanMode`): answered in the terminal, never with the
 * card's allow/deny keys. The hub already reports them as WaitingInput; this also covers an
 * older hub.
 */
export function isQuestionTool(tool: string | null | undefined): boolean {
  return tool === "AskUserQuestion" || tool === "ExitPlanMode";
}

/** The agent detects permission prompts on its screen (no hook reports them, e.g. Cursor). */
export function hasScreenPermissionRule(def: AdapterDefinition | undefined): boolean {
  return def?.screenRules?.some((r) => r.state === "waitingPermission") ?? false;
}
