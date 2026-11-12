/**
 * D-075: what the tray shows – today, the active 5-hour block, plan limits and the sessions
 * waiting for the user. Pure (unit-tested); `AppTray` turns it into a menu and a tooltip.
 */
import type { LimitDto, SessionDto, UsageCurrent } from "../lib/hubTypes";
import type { Strings } from "./strings";
import { agentDisplayName } from "./ui/agents";
import { formatCost, formatDuration, formatPercent100, formatTokenCount } from "./ui/format";

/** Waiting sessions listed one by one; the rest become "+n more". */
export const TRAY_WAITING_MAX = 5;
/** Windows cuts tray tooltips at 127 characters. */
export const TRAY_TOOLTIP_MAX = 127;

export interface TrayWaiting {
  key: string;
  label: string;
  session: SessionDto;
}

export interface TraySummary {
  /** Disabled info lines at the top of the menu. */
  lines: string[];
  waiting: TrayWaiting[];
  /** Waiting sessions not listed. */
  moreWaiting: number;
  tooltip: string;
  /** Changes whenever the menu or tooltip would look different. */
  signature: string;
}

export function traySummary(
  input: { connected: boolean; usage: UsageCurrent | null; limits: readonly LimitDto[]; sessions: readonly SessionDto[] },
  s: Strings,
  appName: string,
  stateLabel: (state: SessionDto["state"]) => string,
): TraySummary {
  const t = s.tray;
  const lines: string[] = [];
  const tip: string[] = [appName];

  if (!input.connected && input.usage === null) {
    lines.push(t.hubDown);
    tip.push(t.hubDown);
  } else {
    const today = input.usage?.today;
    lines.push(t.today(formatTokenCount(today?.tokens ?? null), formatCost(today?.costUsd ?? null)));
    tip.push(t.todayShort(formatTokenCount(today?.tokens ?? null), formatCost(today?.costUsd ?? null)));

    const block = input.usage?.activeBlock ?? null;
    if (block) {
      const left = formatDuration(block.remainingMinutes * 60);
      lines.push(t.block(formatTokenCount(block.tokens), left));
      tip.push(t.blockShort(left));
    } else {
      lines.push(t.noBlock);
    }

    for (const l of input.limits) {
      lines.push(t.limit(agentDisplayName(l.agent), s.ui.windows[l.window], formatPercent100(l.usedPercent)));
    }
    const top = [...input.limits].sort((a, b) => b.usedPercent - a.usedPercent)[0];
    if (top) tip.push(t.limit(agentDisplayName(top.agent), s.ui.windows[top.window], formatPercent100(top.usedPercent)));
  }

  const waitingAll = input.sessions.filter((x) => x.state === "WaitingPermission" || x.state === "WaitingInput");
  const waiting = waitingAll.slice(0, TRAY_WAITING_MAX).map((x) => ({
    key: `${x.agent}/${x.sessionId}`,
    label: `${x.projectName} · ${agentDisplayName(x.agent)} · ${stateLabel(x.state)}`,
    session: x,
  }));
  if (waitingAll.length > 0) tip.push(t.waitingCount(waitingAll.length));

  let tooltip = tip.join("\n");
  if (tooltip.length > TRAY_TOOLTIP_MAX) tooltip = `${tooltip.slice(0, TRAY_TOOLTIP_MAX - 1)}…`;
  const moreWaiting = waitingAll.length - waiting.length;
  const signature = JSON.stringify([lines, waiting.map((w) => [w.key, w.label]), moreWaiting, tooltip]);
  return { lines, waiting, moreWaiting, tooltip, signature };
}
