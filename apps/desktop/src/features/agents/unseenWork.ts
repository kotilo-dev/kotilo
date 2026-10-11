/**
 * D-056: finished work nobody looked at yet, in three places outside the agent's own pane:
 * the taskbar badge (`taskbar_set_badge`), the "while you were away" toast on `user:returned`,
 * and keeping the hub's seen state in step with own panes. Counting is pure (one entry per
 * agent, own panes and hub sessions merged as for the mascot); the installer wires it up.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Agent } from "../../lib/ipc";
import type { SessionDto } from "../../lib/hubTypes";
import { useAgentStore } from "../../stores/agentStore";
import { markSessionSeen, useHubStore } from "../../stores/hubStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useMascotSettingsStore } from "../settings/mascotSettings";
import { isDoNotDisturb, mergeEntries, type MascotEntry } from "../mascot/mascotLogic";
import { matchSession } from "../workspace/paneSession";
import { strings } from "../../app/strings";
import { notifyAwaySummary } from "./notifications";

export interface WorkCounts {
  /** Finished turns not seen yet. */
  finished: number;
  /** Waiting for the user: permission, an answer, or stopped with an error. */
  waiting: number;
}

export type BadgeTone = "attention" | "done";

export interface TaskbarBadge {
  count: number;
  tone: BadgeTone;
}

export function countWork(entries: readonly MascotEntry[]): WorkCounts {
  let finished = 0;
  let waiting = 0;
  for (const e of entries) {
    if (e.state === "permission" || e.state === "input" || e.state === "error") waiting += 1;
    else if (e.unseen) finished += 1;
  }
  return { finished, waiting };
}

/** Own agents + hub sessions, an agent and its hub session counted once. */
export function countUnseenWork(agents: readonly Agent[], sessions: readonly SessionDto[]): WorkCounts {
  return countWork(mergeEntries(agents, sessions));
}

/** Orange while anything waits, blue for finished work only; count 0 clears the badge. */
export function taskbarBadge(counts: WorkCounts): TaskbarBadge {
  return { count: counts.finished + counts.waiting, tone: counts.waiting > 0 ? "attention" : "done" };
}

/** The away toast's text, or null when there is nothing to report. */
export function awaySummaryText(counts: WorkCounts, format: (finished: number, waiting: number) => string): string | null {
  return counts.finished + counts.waiting > 0 ? format(counts.finished, counts.waiting) : null;
}

/**
 * Hub sessions of own panes to mark seen: the desktop tracker (which knows what's on screen)
 * says the pane's work is seen – `idle`, not `done` – while the hub still holds it unseen
 * (the user looked, or watched it finish). Hook records only: a heuristic record never reaches
 * `done`, so its idle says nothing about the hub's finished turn.
 */
export function sessionsToMarkSeen(agents: readonly Agent[], sessions: readonly SessionDto[]): SessionDto[] {
  const out: SessionDto[] = [];
  for (const agent of agents) {
    if (agent.source !== "hook" || agent.state !== "idle") continue;
    const session = matchSession(sessions, agent.paneId, agent);
    if (session?.unseen && !out.includes(session)) out.push(session);
  }
  return out;
}

const AWAY_EVENT = "user:returned";

/** Installs the badge, away summary and seen sync; returns the cleanup. Mounted once in `App.tsx`. */
export function installUnseenWork(): () => void {
  let sentBadge = "";
  let disposed = false;

  function update(): void {
    const { agents } = useAgentStore.getState();
    const { sessions } = useHubStore.getState();

    for (const session of sessionsToMarkSeen(agents, sessions)) void markSessionSeen(session);

    const counts = countUnseenWork(agents, sessions);
    const badge = taskbarBadge(counts);
    const description = strings.agents.notification.badge(counts.finished, counts.waiting);
    const key = `${badge.count}:${badge.tone}:${description}`;
    if (key === sentBadge) return;
    sentBadge = key;
    void invoke("taskbar_set_badge", { count: badge.count, tone: badge.tone, description }).catch(() => {
      sentBadge = "";
    });
  }

  async function onReturned(): Promise<void> {
    const app = useSettingsStore.getState().settings.agents;
    if (!app.awaySummary || !app.notifications) return;
    const counts = countUnseenWork(useAgentStore.getState().agents, useHubStore.getState().sessions);
    if (counts.finished + counts.waiting === 0) return;
    // Fresh DND / quiet hours (they may have changed since the mascot last loaded them).
    await useMascotSettingsStore.getState().load();
    const hub = useMascotSettingsStore.getState().settings;
    if (disposed || (hub && isDoNotDisturb(hub.doNotDisturbUntil, hub.quietHours, new Date()))) return;
    await notifyAwaySummary(counts);
  }

  const unsubscribers = [
    useAgentStore.subscribe((s, prev) => {
      if (s.agents !== prev.agents) update();
    }),
    useHubStore.subscribe((s, prev) => {
      if (s.sessions !== prev.sessions) update();
    }),
  ];
  const unlisten: Promise<UnlistenFn> = listen(AWAY_EVENT, () => void onReturned());

  update();

  return () => {
    disposed = true;
    unsubscribers.forEach((u) => u());
    void unlisten.then((u) => u()).catch(() => {});
  };
}
