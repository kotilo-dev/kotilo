/**
 * Kotilo Deck snapshots (D-072, `docs/companion-protocol.md` §5). Pure: the bridge feeds in the
 * stores. Agents are the terminal panes running an agent (same state as the pane frame) plus
 * live hub sessions in other terminals. Approvals are only prompts the deck can answer: a pane's
 * permission whose agent has verified allow/deny keys (D-016); questions and keyless agents stay
 * out and show as `waiting`.
 */
import type { SessionDto } from "../../lib/hubTypes";
import type { AdapterDefinition, Agent } from "../../lib/ipc";
import { pendingPermissionOf } from "../agents/pendingPermission";
import { hasScreenPermissionRule, permissionKeysOf } from "../agents/permissionKeys";
import { matchSession, paneVisualState, type PaneVisualState } from "../workspace/paneSession";

export type DeckAgentStatus = "idle" | "working" | "waiting";

export interface DeckAgent {
  id: string;
  repo: string;
  name: string;
  status: DeckAgentStatus;
  task?: string;
  since?: number;
}

export interface DeckApproval {
  id: string;
  agentId: string;
  summary: string;
  detail?: string;
  requestedAt: number;
}

export interface DeckAgentsState {
  agents: DeckAgent[];
  approvals: DeckApproval[];
}

/** Where a deck decision goes: the pane and the keys the permission card would send. */
export interface ApprovalTarget {
  paneId: string;
  allowKey: string;
  denyKey: string;
}

export interface SnapshotPane {
  paneId: string;
  workspaceName: string;
}

export interface SnapshotInput {
  /** Running terminal tabs with a pane, in all workspaces. */
  panes: readonly SnapshotPane[];
  agents: readonly Agent[];
  sessions: readonly SessionDto[];
  definitions: readonly AdapterDefinition[];
  displayName: (adapterId: string) => string;
  kindLabel: (agent: Agent) => string;
}

export interface Snapshot {
  state: DeckAgentsState;
  targets: Record<string, ApprovalTarget>;
}

function deckStatus(state: PaneVisualState): DeckAgentStatus {
  switch (state) {
    case "working":
      return "working";
    case "permission":
    case "input":
      return "waiting";
    default:
      return "idle";
  }
}

function permissionText(tool: string | null, detail: string | null): string | undefined {
  if (tool && detail) return `${tool}: ${detail}`;
  return tool ?? detail ?? undefined;
}

function taskOf(state: PaneVisualState, session: SessionDto | null): string | undefined {
  if (!session) return undefined;
  if (state === "permission") {
    const p = session.pendingPermission;
    return p ? permissionText(p.tool, p.command ?? p.path) : undefined;
  }
  if (state === "input") return session.lastNotification ?? undefined;
  if (state === "working") return session.currentTool ?? undefined;
  return undefined;
}

function withOptional<T extends object>(base: T, optional: Record<string, string | number | undefined>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) out[key] = value;
  return out as T;
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const agents: DeckAgent[] = [];
  const approvals: DeckApproval[] = [];
  const targets: Record<string, ApprovalTarget> = {};
  const matched = new Set<SessionDto>();

  for (const pane of input.panes) {
    const agent = input.agents.find((a) => a.paneId === pane.paneId);
    const session = matchSession(input.sessions, pane.paneId, agent);
    const adapterId = session?.agent ?? agent?.adapterId ?? null;
    const definition = adapterId ? input.definitions.find((d) => d.id === adapterId) : undefined;
    const state = paneVisualState(session, agent, hasScreenPermissionRule(definition));
    if (!state) continue;
    if (session) matched.add(session);
    const id = `pane:${pane.paneId}`;
    const since = session ? Date.parse(session.stateSince) : agent?.sinceMs;
    agents.push(
      withOptional(
        {
          id,
          repo: session?.projectName || pane.workspaceName,
          name: adapterId ? input.displayName(adapterId) : agent ? input.kindLabel(agent) : "",
          status: deckStatus(state),
        },
        { task: taskOf(state, session), since: Number.isFinite(since) ? since : undefined },
      ),
    );

    const pending = pendingPermissionOf(session, agent, definition);
    const keys = permissionKeysOf(definition);
    if (pending && keys) {
      const { permission, requestKey } = pending;
      approvals.push(
        withOptional(
          { id: requestKey, agentId: id, summary: permission.tool ?? input.displayName(adapterId ?? ""), requestedAt: Date.parse(permission.since) },
          { detail: permission.command ?? permission.path ?? undefined },
        ),
      );
      targets[requestKey] = { paneId: pane.paneId, allowKey: keys.allowOnce, denyKey: keys.deny };
    }
  }

  // Sessions in other terminals: status only, the deck cannot answer them.
  for (const session of input.sessions) {
    if (session.state === "Ended" || matched.has(session)) continue;
    const state = paneVisualState(session, undefined);
    if (!state) continue;
    agents.push(
      withOptional(
        { id: `${session.agent}:${session.sessionId}`, repo: session.projectName, name: input.displayName(session.agent), status: deckStatus(state) },
        { task: taskOf(state, session), since: Date.parse(session.stateSince) },
      ),
    );
  }

  return { state: { agents, approvals }, targets };
}

export type ResolvedDecision = "approve" | "deny" | "expired" | "unknown";
export type ResolvedBy = "deck" | "desktop" | "agent";

export interface Resolution {
  id: string;
  decision: ResolvedDecision;
  by: ResolvedBy;
}

/**
 * Approvals that left the snapshot without a recorded answer: `expired` when the agent's pane
 * is gone from the agents list (session ended, pane closed), else `unknown` (answered in the
 * terminal, outcome not visible). `reported` holds ids already resolved by an answer.
 */
export function silentResolutions(prev: Snapshot, next: Snapshot, reported: ReadonlySet<string>): Resolution[] {
  const nextIds = new Set(next.state.approvals.map((a) => a.id));
  const liveAgents = new Set(next.state.agents.map((a) => a.id));
  return prev.state.approvals
    .filter((a) => !nextIds.has(a.id) && !reported.has(a.id))
    .map((a) => ({ id: a.id, decision: liveAgents.has(a.agentId) ? "unknown" : "expired", by: "agent" }));
}

/** Approvals in `next` that were not in `prev`. */
export function newApprovals(prev: Snapshot, next: Snapshot): DeckApproval[] {
  const prevIds = new Set(prev.state.approvals.map((a) => a.id));
  return next.state.approvals.filter((a) => !prevIds.has(a.id));
}

export const EMPTY_SNAPSHOT: Snapshot = { state: { agents: [], approvals: [] }, targets: {} };
