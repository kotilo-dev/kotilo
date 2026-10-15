/**
 * One terminal tab's body in the workspace (M2): the xterm view, and — when an agent runs in
 * it — the §7.3 header strip (with the M4 split button), the §7.4 state frame, the §7.5
 * permission card and the §7.6 composer (M4). Hub data
 * (model, tokens, permission details) comes from `hubStore`; the desktop tracker covers
 * hookless agents and works without the hub.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useStrings } from "../../app/i18n";
import { agentDisplayName } from "../../app/ui";
import { useAppActive } from "../../app/ui/useAppActive";
import { useNow } from "../../app/ui/useNow";
import { gitHead, paneSendKeys } from "../../lib/ipc";
import { useRouteStore } from "../../stores/routeStore";
import type { PendingPermission } from "../../lib/hubTypes";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { useAgentStore } from "../../stores/agentStore";
import { useHubStore } from "../../stores/hubStore";
import type { TerminalTab } from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { formatElapsed } from "../agents/agentLogic";
import { hasScreenPermissionRule, isQuestionTool, permissionKeysOf } from "../agents/permissionKeys";
import { parsePromptOptions, screenPermissionKeys, type PromptOption } from "../agents/promptOptions";
import { focusTerminal, readBufferTail } from "../terminal/terminalRegistry";
import { TerminalView } from "../terminal/TerminalView";
import { Composer } from "../composer/Composer";
import { AgentHeaderStrip, type HeaderLimit } from "./AgentHeaderStrip";
import { matchSession, paneVisualState, statusFamily, type PaneVisualState } from "./paneSession";
import { LeftoverStrip } from "./LeftoverStrip";
import { PermissionCard, PermissionResult, type PermissionDecision } from "./PermissionCard";

const RESULT_VISIBLE_MS = 2500;
const BRANCH_POLL_MS = 15000;
/** The card appears on the hook; the agent may draw its dialog a few hundred ms later. */
const DIALOG_RETRY_MS = 250;
const DIALOG_WAIT_MS = 1500;
const DIALOG_ROWS = 60;

/**
 * The numbered options of the dialog at the bottom of the tab's screen while `requestKey` is
 * open (0.3.2): read on open and again every 250 ms for 1.5 s until a dialog is found.
 */
function useScreenOptions(tabId: string, requestKey: string | null): PromptOption[] {
  const [found, setFound] = useState<{ key: string; options: PromptOption[] } | null>(null);
  useEffect(() => {
    if (!requestKey) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const options = parsePromptOptions(readBufferTail(tabId, DIALOG_ROWS));
      if (options.length > 0) {
        setFound({ key: requestKey, options });
        return;
      }
      if (Date.now() - started < DIALOG_WAIT_MS) timer = setTimeout(read, DIALOG_RETRY_MS);
    };
    read();
    return () => clearTimeout(timer);
  }, [tabId, requestKey]);
  return found && found.key === requestKey ? found.options : [];
}

/** §7.4 frame: working = thin amber border + 4px halo; waiting = stronger blocked border + glow. */
export function frameStyle(state: PaneVisualState | null): CSSProperties | undefined {
  if (!state) return undefined;
  const family = statusFamily(state);
  const mix = (token: string, pct: number) => `color-mix(in srgb, var(--status-${token}) ${pct}%, transparent)`;
  if (family === "blocked" || family === "error") {
    return {
      border: `1px solid ${mix(family, 55)}`,
      boxShadow: `0 0 0 4px ${mix(family, 8)}, 0 0 40px ${mix(family, 10)}`,
    };
  }
  if (family === "working") {
    return { border: `1px solid ${mix("working", 28)}`, boxShadow: `0 0 0 4px ${mix("working", 5)}` };
  }
  return { border: "1px solid var(--border)" };
}

function useBranch(workspaceId: string, active: boolean): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const refresh = () =>
      gitHead(workspaceId)
        .then((head) => {
          if (!cancelled) setBranch(head ? (head.kind === "branch" ? head.name : head.sha) : null);
        })
        .catch(() => {
          if (!cancelled) setBranch(null);
        });
    void refresh();
    const timer = setInterval(() => void refresh(), BRANCH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workspaceId, active]);
  return branch;
}

/** M4 split pane controls of one pane (§7.3 header split button). */
export interface PaneSplit {
  /** The panel is split (the button then closes this half). */
  open: boolean;
  onToggle: () => void;
}

function SplitButton({ split }: { split: PaneSplit }) {
  const s = useStrings();
  const label = split.open ? s.composer.split.closeSplit : s.composer.split.splitRight;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={split.open}
      className={`flex h-[30px] w-[30px] items-center justify-center rounded-control border border-border hover:text-text ${split.open ? "bg-accent-soft text-accent" : "text-text-3"}`}
      onClick={split.onToggle}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M12 4v16" />
      </svg>
    </button>
  );
}

export function AgentPane({ workspaceId, tab, visible, split }: { workspaceId: string; tab: TerminalTab; visible: boolean; split?: PaneSplit }) {
  const s = useStrings();
  const paneId = tab.paneId ?? null;
  const agent = useAgentStore((st) => (paneId ? st.agents.find((a) => a.paneId === paneId) : undefined));
  const sessions = useHubStore((st) => st.sessions);
  const limits = useHubStore((st) => st.limits);
  const workspaceName = useWorkspaceStore((st) => st.workspaces.find((w) => w.id === workspaceId)?.name ?? "");

  const definitions = useDefinitionsStore((st) => st.definitions);

  const session = paneId ? matchSession(sessions, paneId, agent) : null;
  const adapterId = session?.agent ?? agent?.adapterId ?? null;
  const definition = adapterId ? definitions.find((d) => d.id === adapterId) : undefined;
  const screenPermission = hasScreenPermissionRule(definition);
  const state = paneVisualState(session, agent, screenPermission);
  const hasAgent = state !== null && tab.status === "running";
  // Timers run only while the pane can be seen: its tab shown, the workspace route active and
  // the window focused (`useNow` also checks the window).
  const onWorkspace = useRouteStore((st) => st.route === "workspace");
  const appActive = useAppActive();
  const now = useNow(1000, visible && hasAgent && onWorkspace);
  const branch = useBranch(workspaceId, visible && hasAgent && onWorkspace && appActive);

  const [dismissed, setDismissed] = useState<string | null>(null);
  const [result, setResult] = useState<{ decision: PermissionDecision; keyName: string; at: number } | null>(null);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), RESULT_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [result]);

  const agentKey = adapterId ?? agent?.kind ?? "other";
  const agentName = adapterId ? agentDisplayName(adapterId, definitions) : agent ? s.agents.kindLabel[agent.kind] : "";
  const projectName = session?.projectName || workspaceName;

  const sinceMs = session ? Date.parse(session.stateSince) : (agent?.sinceMs ?? now);
  const elapsed = state && state !== "idle" ? formatElapsed(now, sinceMs) : null;

  const backgroundTasks = session?.backgroundTasks ?? agent?.backgroundTasks ?? [];
  const background = state === "working" && backgroundTasks.length > 0 ? s.workspace.background(backgroundTasks.join(", ")) : null;

  const limit: HeaderLimit | null = adapterId
    ? limits
        .filter((l) => l.agent === adapterId)
        .reduce<HeaderLimit | null>((best, l) => (best && best.usedPercent >= l.usedPercent ? best : { window: l.window, usedPercent: l.usedPercent }), null)
    : null;

  // The hub's request (tool, command, risk), else a prompt the desktop found on the screen
  // (Cursor), which has no details: the card then only names the agent.
  const hubPermission =
    session?.state === "WaitingPermission" && !isQuestionTool(session.pendingPermission?.tool) ? session.pendingPermission : null;
  const screenBlocked = !hubPermission && screenPermission && agent?.state === "blocked";
  const permission: PendingPermission | null =
    hubPermission ?? (screenBlocked && agent ? { tool: null, command: null, path: null, risk: null, since: new Date(agent.sinceMs).toISOString() } : null);
  const requestKey = hubPermission && session
    ? `${session.agent}:${session.sessionId}:${hubPermission.since}`
    : permission && agent
      ? `${adapterId}:${agent.paneId}:${agent.sinceMs}`
      : null;
  const screenOptions = useScreenOptions(tab.id, hasAgent && permission ? requestKey : null);
  const showCard = hasAgent && permission !== null && requestKey !== dismissed && !(result && result.at >= Date.parse(permission.since));

  function decide(decision: PermissionDecision, keyName: string) {
    if (!paneId) return;
    void paneSendKeys(paneId, keyName).catch(() => {});
    setResult({ decision, keyName, at: Date.now() });
    setDismissed(requestKey);
    focusTerminal(tab.id);
  }

  return (
    <div data-agent-pane className="flex min-h-0 min-w-0 flex-1 flex-col">
      {hasAgent && state && (
        <AgentHeaderStrip
          agent={agentKey}
          agentName={agentName}
          projectName={projectName}
          branch={branch}
          model={session?.model ?? null}
          state={state}
          elapsed={elapsed}
          contextPercent={session?.contextUsedPercent ?? null}
          tokens={session ? session.tokens : null}
          costUsd={session?.costUsd ?? null}
          limit={limit}
          background={background}
          actions={split ? <SplitButton split={split} /> : undefined}
        />
      )}
      {paneId && <LeftoverStrip paneId={paneId} />}
      <div className="relative flex min-h-0 flex-1" data-pane-state={hasAgent ? state : undefined} style={hasAgent ? frameStyle(state) : undefined}>
        <TerminalView workspaceId={workspaceId} tab={tab} visible={visible} />
        {showCard && permission && (
          <PermissionCard
            key={requestKey}
            agentName={agentName}
            projectName={projectName}
            waiting={formatElapsed(now, Date.parse(permission.since))}
            permission={permission}
            keys={screenPermissionKeys(permissionKeysOf(definition), screenOptions, adapterId === "claude-code")}
            autoFocus={visible && document.hasFocus()}
            onDecide={decide}
            onAnswerInTerminal={() => {
              setDismissed(requestKey);
              focusTerminal(tab.id);
            }}
          />
        )}
        {result && !showCard && <PermissionResult decision={result.decision} keyName={result.keyName} />}
      </div>
      {hasAgent && paneId && <Composer workspaceId={workspaceId} tabId={tab.id} paneId={paneId} agentName={agentName} />}
    </div>
  );
}

