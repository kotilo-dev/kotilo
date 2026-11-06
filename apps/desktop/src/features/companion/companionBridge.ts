/**
 * D-072: connects the stores to the Kotilo Deck client in Rust. Builds the agents snapshot on
 * every store change (Rust sends it at most every 250 ms and only when it changed), reports new
 * and resolved approvals, today's usage, and applies deck decisions through `answerPermission`,
 * the permission card's own path.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { agentDisplayName } from "../../app/ui";
import { agentLabel } from "../../app/ui/agents";
import {
  COMPANION_MESSAGE_EVENT,
  COMPANION_STATUS_EVENT,
  companionSend,
  companionSetAgents,
  companionSetUsage,
  companionStatus,
  type CompanionMessage,
  type CompanionStatus,
} from "../../lib/ipc";
import { useAgentStore } from "../../stores/agentStore";
import { useCompanionStore } from "../../stores/companionStore";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { useHubStore } from "../../stores/hubStore";
import { answerPermission, usePermissionAnswerStore, type PermissionAnswer } from "../../stores/permissionAnswerStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { buildSnapshot, EMPTY_SNAPSHOT, newApprovals, silentResolutions, type Resolution, type Snapshot, type SnapshotPane } from "./companionSnapshot";

const BUILD_DELAY_MS = 50;

function runningPanes(): SnapshotPane[] {
  const names = new Map(useWorkspaceStore.getState().workspaces.map((w) => [w.id, w.name]));
  const panes: SnapshotPane[] = [];
  for (const [workspaceId, ws] of Object.entries(useTerminalStore.getState().byWorkspace)) {
    for (const tab of ws.tabs) {
      if (tab.status === "running" && tab.paneId) panes.push({ paneId: tab.paneId, workspaceName: names.get(workspaceId) ?? "" });
    }
  }
  return panes;
}

function currentSnapshot(): Snapshot {
  const definitions = useDefinitionsStore.getState().definitions;
  return buildSnapshot({
    panes: runningPanes(),
    agents: useAgentStore.getState().agents,
    sessions: useHubStore.getState().sessions,
    definitions,
    displayName: (id) => agentDisplayName(id, definitions),
    kindLabel: (agent) => agentLabel(agent),
  });
}

function answerToResolution(answer: PermissionAnswer): Resolution {
  return { id: answer.requestKey, decision: answer.decision === "deny" ? "deny" : "approve", by: answer.by };
}

export function installCompanion(): () => void {
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  /** Approval ids already resolved by an answer (card or deck). */
  const reported = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const send = (event: Parameters<typeof companionSend>[0]) => void companionSend(event).catch(() => {});

  function rebuild(): void {
    timer = undefined;
    if (disposed) return;
    const next = currentSnapshot();
    for (const approval of newApprovals(snapshot, next)) send({ type: "agent.approval.requested", payload: approval });
    for (const resolution of silentResolutions(snapshot, next, reported)) send({ type: "agent.approval.resolved", payload: resolution });
    const live = new Set(next.state.approvals.map((a) => a.id));
    for (const id of reported) if (!live.has(id)) reported.delete(id);
    snapshot = next;
    void companionSetAgents(next.state).catch(() => {});
  }

  function schedule(): void {
    if (timer === undefined) timer = setTimeout(rebuild, BUILD_DELAY_MS);
  }

  let lastUsage = "";
  function pushUsage(): void {
    const today = useHubStore.getState().usage?.today;
    if (!today) return;
    const key = `${today.tokens}:${today.costUsd}`;
    if (key === lastUsage) return;
    lastUsage = key;
    void companionSetUsage({ tokens: Math.max(0, Math.round(today.tokens)), costUsd: today.costUsd }).catch(() => {
      lastUsage = "";
    });
  }

  function onAnswer(answer: PermissionAnswer): void {
    if (reported.has(answer.requestKey) || !snapshot.targets[answer.requestKey]) return;
    reported.add(answer.requestKey);
    send({ type: "agent.approval.resolved", payload: answerToResolution(answer) });
    schedule();
  }

  function onRespond(id: string, decision: "approve" | "deny"): void {
    const target = currentSnapshot().targets[id];
    if (target && !reported.has(id)) {
      const keyName = decision === "approve" ? target.allowKey : target.denyKey;
      // Records the answer; `onAnswer` sends `resolved` with `by: "deck"`.
      answerPermission(target.paneId, id, decision === "approve" ? "allow" : "deny", keyName, "deck");
      return;
    }
    // Already gone: tell the deck what really happened.
    const earlier = usePermissionAnswerStore.getState().answers[id];
    send({ type: "agent.approval.resolved", payload: earlier ? answerToResolution(earlier) : { id, decision: "unknown", by: "agent" } });
    schedule();
  }

  function onStatus(status: CompanionStatus): void {
    useCompanionStore.getState().setStatus(status);
    if (status.state === "connected") {
      // Rust resends its latest snapshot itself; make sure it has a fresh one.
      lastUsage = "";
      pushUsage();
      schedule();
    }
  }

  const unsubs = [
    useAgentStore.subscribe(schedule),
    useHubStore.subscribe((st, prev) => {
      if (st.sessions !== prev.sessions) schedule();
      if (st.usage !== prev.usage) pushUsage();
    }),
    useTerminalStore.subscribe(schedule),
    useDefinitionsStore.subscribe(schedule),
    useWorkspaceStore.subscribe(schedule),
    usePermissionAnswerStore.subscribe((st, prev) => {
      for (const [key, answer] of Object.entries(st.answers)) if (prev.answers[key] !== answer) onAnswer(answer);
    }),
  ];

  const listeners: Promise<UnlistenFn>[] = [
    listen<CompanionStatus>(COMPANION_STATUS_EVENT, (e) => onStatus(e.payload)),
    listen<CompanionMessage>(COMPANION_MESSAGE_EVENT, (e) => {
      const message = e.payload;
      if (message?.type === "approval.respond" && (message.payload.decision === "approve" || message.payload.decision === "deny")) {
        onRespond(message.payload.id, message.payload.decision);
      } else if (message?.type === "pomodoro.state") {
        useCompanionStore.getState().setPomodoro(message.payload);
      }
    }),
  ];

  void companionStatus()
    .then((status) => {
      if (status && !disposed) onStatus(status);
    })
    .catch(() => {});
  schedule();
  pushUsage();

  return () => {
    disposed = true;
    clearTimeout(timer);
    for (const unsub of unsubs) unsub();
    for (const l of listeners) void l.then((un) => un());
  };
}
