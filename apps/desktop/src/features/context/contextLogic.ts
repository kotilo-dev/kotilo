/**
 * 0.9 agent context (D-076): pure helpers for the "Agent context" tab – which agent to show by
 * default, how the report's files split into sections (imports indented under their importer)
 * and the rough number formats.
 */
import { formatNumber } from "../../app/i18n";
import type { AgentKind, ContextAgent, ContextFile, ContextReport } from "../../lib/ipc";

export const FALLBACK_CONTEXT_AGENT = "claude-code";

/** Pane kinds whose adapter id differs from the kind (as `agentIdentity`); `null` = no adapter. */
export function adapterForKind(kind: AgentKind): string | null {
  if (kind === "custom" || kind === "other") return null;
  return kind === "claude" ? "claude-code" : kind;
}

/**
 * The agent the tab opens with: the first agent running in the workspace that has context data,
 * else Claude Code (when supported), else the first supported agent. `agents` null = not loaded
 * yet (then the running agent or Claude Code is taken as is).
 */
export function defaultContextAgent(running: readonly string[], agents: readonly ContextAgent[] | null): string {
  if (!agents) return running[0] ?? FALLBACK_CONTEXT_AGENT;
  const supported = agents.filter((a) => a.supported);
  const runningSupported = running.find((id) => supported.some((a) => a.id === id));
  if (runningSupported) return runningSupported;
  if (supported.some((a) => a.id === FALLBACK_CONTEXT_AGENT)) return FALLBACK_CONTEXT_AGENT;
  return supported[0]?.id ?? FALLBACK_CONTEXT_AGENT;
}

/** Picker options: supported agents, plus the current one when it has no context data (empty state). */
export function pickerAgents(agents: readonly ContextAgent[], current: string): ContextAgent[] {
  const supported = agents.filter((a) => a.supported);
  if (supported.some((a) => a.id === current)) return supported;
  const own = agents.find((a) => a.id === current) ?? { id: current, displayName: current, supported: false };
  return [...supported, own];
}

export interface FileRow {
  file: ContextFile;
  /** Import depth: 0 = a file the agent finds itself, 1+ = pulled in by `@path`. */
  depth: number;
}

export interface ContextSections {
  always: FileRow[];
  onDemand: FileRow[];
  rules: FileRow[];
}

const MAX_DEPTH = 4;

/**
 * Splits `files` (load order) into Always loaded (instructions), On demand (nested instruction
 * files) and Rules; an import's depth comes from its importer's display name.
 */
export function contextSections(files: readonly ContextFile[]): ContextSections {
  const depthOf = new Map<string, number>();
  const rows = files.map((file) => {
    const parent = file.importedBy ? depthOf.get(file.importedBy) : undefined;
    const depth = file.importedBy ? Math.min((parent ?? 0) + 1, MAX_DEPTH) : 0;
    if (!depthOf.has(file.display)) depthOf.set(file.display, depth);
    return { file, depth };
  });
  return {
    always: rows.filter((r) => r.file.kind === "instruction" && r.file.loaded === "always"),
    onDemand: rows.filter((r) => r.file.kind === "instruction" && r.file.loaded === "onDemand"),
    rules: rows.filter((r) => r.file.kind === "rule"),
  };
}

/** True when the report has nothing at all to show. */
export function isEmptyReport(report: ContextReport): boolean {
  return report.files.length === 0 && report.skills.length === 0 && report.mcp.length === 0;
}

/** Rough token counts: `830`, `4.2k`, `12k`, `1.3M` (locale decimal separator). */
export function formatTokenEstimate(tokens: number): string {
  if (tokens < 1_000) return formatNumber(tokens);
  if (tokens < 10_000) return `${formatNumber(Math.round(tokens / 100) / 10, { maximumFractionDigits: 1 })}k`;
  if (tokens < 1_000_000) return `${formatNumber(Math.round(tokens / 1_000))}k`;
  return `${formatNumber(Math.round(tokens / 100_000) / 10, { maximumFractionDigits: 1 })}M`;
}

/** File sizes: `512 B`, `3.4 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, { maximumFractionDigits: 1 })} KB`;
  return `${formatNumber(bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
}
