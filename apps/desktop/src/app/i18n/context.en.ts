/**
 * 0.9 agent context (D-076): the "Agent context" tab and its entry points. Part of `en` as
 * `agentContext`; `context.tr.ts` has the same shape.
 */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const contextEn = {
  tabTitle: "Agent context",
  title: "Agent context",
  /** Palette: "Agents: Show agent context". */
  commandCategory: "Agent",
  commandTitle: "Show agent context",
  contextMenu: "Agent context…",
  /** Agent pane header button and terminal tab menu. */
  paneButton: "Agent context",
  agentLabel: "Agent",
  refresh: "Refresh",
  loading: "Loading…",
  loadFailed: "Could not read the agent's context.",
  alwaysTotal: (tokens: string) => `≈ ${tokens} tokens always loaded`,
  onDemandTotal: (tokens: string) => `≈ ${tokens} on demand`,
  skillsTotal: (tokens: string) => `≈ ${tokens} for skills`,
  estimateNote: "Rough estimate (characters ÷ 4). MCP tool definitions are not counted.",
  maxBytes: (size: string) => `This agent reads at most ${size} of instructions in total.`,
  sections: {
    always: "Always loaded",
    onDemand: "On demand",
    rules: "Rules",
    skills: "Skills",
    mcp: "MCP servers",
  },
  hints: {
    always: "Read at the start of every session, in this order.",
    onDemand: "Read when the agent works with files in that folder.",
    skills: "Only the name and description are loaded until a skill is used.",
  },
  none: "None found.",
  scope: { managed: "managed", user: "user", project: "project", local: "local" },
  importedBy: (display: string) => `imported by ${display}`,
  tokens: (tokens: string) => `≈ ${tokens} tokens`,
  onDemandChip: "on demand",
  overLimit: "over limit",
  overLimitTitle: (size: string) => `Past the ${size} limit: the agent cuts this file off or skips it.`,
  unreadable: "unreadable",
  open: (display: string) => `Open ${display}`,
  previewOf: (display: string) => `Preview ${display}`,
  preview: {
    readOnly: "Read-only · outside the workspace",
    close: "Close preview",
    truncated: "Only the first 256 KB are shown.",
    failed: "Could not read this file.",
  },
  mcp: {
    transport: { stdio: "stdio", http: "http", sse: "sse", unknown: "unknown" },
    args: (n: number) => plural(n, "arg", "args"),
    secrets: (n: number) => plural(n, "hidden secret", "hidden secrets"),
    secretsTitle: (keys: string) => `Values never leave the config file: ${keys}`,
    disabled: "disabled",
    shadowed: (by: string) => `shadowed by ${by}`,
    source: (display: string) => `in ${display}`,
  },
  sources: {
    title: "MCP config files looked at",
    missing: "not found",
    servers: (n: number) => plural(n, "server", "servers"),
    error: (message: string) => `error: ${message}`,
  },
  unsupported: {
    title: (name: string) => `No context data for ${name}`,
    body: "This agent's adapter has no context section, so Kotilo does not know which files it reads.",
  },
  empty: "This agent picks up no instruction files, rules, skills or MCP servers here.",
};
