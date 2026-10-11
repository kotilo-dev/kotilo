/**
 * M3 wave 3: what "New agent ▶" and the palette's "Agents: New …" offer. Every installed
 * adapter definition (`launch.command` + `args`), then the user's own command strings from
 * Settings → Agents that no definition already covers. Pure.
 */
import type { AdapterDefinition } from "../../lib/ipc";

export interface LaunchOption {
  /** The command line run in the new terminal's shell. */
  command: string;
  /** Menu text: the agent's display name, or the custom command itself. */
  label: string;
  /** Adapter id when the option comes from (or matches) a definition. */
  adapterId: string | null;
}

/** Quotes an argument for the shell line when it has whitespace or quotes. */
function quoteArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/** `launch.command` plus its args as one shell command line. */
export function commandLine(launch: { command: string; args?: string[] }): string {
  return [launch.command, ...(launch.args ?? []).map(quoteArg)].join(" ");
}

export function launchOptions(
  definitions: readonly AdapterDefinition[],
  installed: readonly string[] | null,
  customCommands: readonly string[],
): LaunchOption[] {
  const out: LaunchOption[] = [];
  const seen = new Set<string>();
  const byCommand = new Map<string, AdapterDefinition>();
  for (const def of definitions) {
    if (!def.launch) continue;
    const command = commandLine(def.launch);
    if (!byCommand.has(command)) byCommand.set(command, def);
    if (installed?.includes(def.id) && !seen.has(command)) {
      seen.add(command);
      out.push({ command, label: def.displayName, adapterId: def.id });
    }
  }
  for (const raw of customCommands) {
    const command = raw.trim();
    if (!command || seen.has(command)) continue;
    seen.add(command);
    // A custom string that is exactly an agent's launch line still gets the agent's name.
    const def = byCommand.get(command);
    out.push({ command, label: def?.displayName ?? command, adapterId: def?.id ?? null });
  }
  return out;
}
