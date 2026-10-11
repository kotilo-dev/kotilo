import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const navigateToAgent = vi.fn();
vi.mock("../agents/navigate", () => ({ navigateToAgent: (...a: unknown[]) => navigateToAgent(...a) }));
const hubRequest = vi.fn(async (..._a: unknown[]) => null);
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  hubRequest: (...a: unknown[]) => hubRequest(...a),
}));

import { MissionControlPage } from "./MissionControlPage";
import { useHubStore } from "../../stores/hubStore";
import { useAgentStore } from "../../stores/agentStore";
import { useTerminalStore, type TerminalTab } from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useI18nStore } from "../../app/i18n";
import type { SessionDto } from "../../lib/hubTypes";
import { clearAllEntries, getOrCreateEntry, readBufferTail, resetCreateTerminalFactory, setCreateTerminalFactory } from "../terminal/terminalRegistry";

function session(partial: Partial<SessionDto>): SessionDto {
  return {
    sessionId: "s",
    agent: "claude-code",
    paneId: null,
    projectRoot: "C:/src/app",
    projectName: "app",
    state: "Idle",
    stateSince: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    currentTool: null,
    model: "opus",
    tokens: 1200,
    costUsd: 1.24,
    contextUsedPercent: 41,
    lastCompletedAt: null,
    unseen: false,
    turnStartedAt: null,
    endedAt: null,
    activeSubagents: 0,
    lastNotification: null,
    error: null,
    tasks: null,
    pendingPermission: null,
    ...partial,
  };
}

/** Fake xterm whose active buffer holds `lines` (mutable between ticks). */
function fakeTerm(lines: string[]) {
  return {
    cols: 80,
    rows: 24,
    write: vi.fn(),
    reset: vi.fn(),
    dispose: vi.fn(),
    buffer: { active: { get length() { return lines.length; }, getLine: (y: number) => ({ translateToString: () => lines[y] ?? "" }) } },
  };
}

const tab = (id: string, paneId: string): TerminalTab =>
  ({ id, title: "claude", profileId: null, cwdRel: "", agentCommand: "claude", status: "running", paneId, titleEdited: false }) as TerminalTab;

let paneLines: string[];

beforeEach(() => {
  vi.useFakeTimers();
  useI18nStore.setState({ preference: "en", language: "en" });
  navigateToAgent.mockReset();
  hubRequest.mockClear();
  paneLines = ["$ claude", "● Edit src/approval.ts", "", "  + case Cancelled: return Rejected;", "● Bash npm test", "  PASS approval.test.ts", "✻ Running the full suite…", "", ""];
  setCreateTerminalFactory(() => fakeTerm(paneLines));
  getOrCreateEntry("tab-1");
  useTerminalStore.setState({ byWorkspace: { w1: { tabs: [tab("tab-1", "p1")], activeTabId: "tab-1" } } });
  useWorkspaceStore.setState({ workspaces: [{ id: "w1", name: "orders-ws", path: "C:/src/orders", expandedDirs: [] }] });
  useAgentStore.setState({ agents: [] });
  useHubStore.setState({
    connected: true,
    usage: null,
    health: null,
    limits: [{ agent: "codex", window: "weekly", usedPercent: 31, resetsAt: new Date().toISOString() }],
    sessions: [
      session({ sessionId: "b", projectName: "orders-service", state: "Working", paneId: "p1" }),
      session({
        sessionId: "a",
        agent: "codex",
        projectName: "payments-gateway",
        state: "WaitingPermission",
        costUsd: null,
        tokens: 88_000,
        pendingPermission: { tool: "Bash", command: "dotnet ef database update", path: null, risk: "writesDatabase", since: new Date().toISOString() },
      }),
      session({ sessionId: "c", projectName: "docs-site", state: "Idle", unseen: true, lastNotification: "Claude is waiting for your input" }),
      session({ sessionId: "d", projectName: "old", state: "Ended" }),
    ],
  });
});

afterEach(() => {
  clearAllEntries();
  resetCreateTerminalFactory();
  vi.useRealTimers();
});

describe("MissionControlPage", () => {
  it("shows the not-running state when the hub is unreachable", () => {
    useHubStore.setState({ connected: false, sessions: [] });
    render(<MissionControlPage />);
    expect(screen.getByText("Background service not running")).toBeInTheDocument();
  });

  it("summarises, shows limits and tiles with needs-you first", () => {
    render(<MissionControlPage />);
    expect(screen.getByRole("heading", { name: "Mission control" })).toBeInTheDocument();
    expect(screen.getByText("3 agents · 1 need you · 1 working · 1 done")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Codex CLI · Weekly" })).toBeInTheDocument();
    const names = screen.getAllByText(/^(payments-gateway|orders-service|docs-site)$/).map((el) => el.textContent);
    expect(names).toEqual(["payments-gateway", "orders-service", "docs-site"]);
    expect(screen.queryByText("old")).not.toBeInTheDocument();
  });

  it("previews the last five non-blank buffer lines of an in-app pane and refreshes them", () => {
    render(<MissionControlPage />);
    const tile = screen.getByRole("button", { name: /orders-service/ });
    const preview = within(tile).getByTestId("mission-preview");
    expect(Array.from(preview.children, (el) => el.textContent)).toEqual([
      "● Edit src/approval.ts",
      "  + case Cancelled: return Rejected;",
      "● Bash npm test",
      "  PASS approval.test.ts",
      "✻ Running the full suite…",
    ]);
    expect(within(tile).getByText(/Claude Code · orders-ws/)).toBeInTheDocument();

    paneLines.push("  Tests: 214 passed");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(within(tile).getByText("Tests: 214 passed", { exact: false })).toBeInTheDocument();
    expect(within(tile).queryByText("● Edit src/approval.ts")).not.toBeInTheDocument();
  });

  it("shows metadata for sessions outside the app and does not make them links", () => {
    render(<MissionControlPage />);
    expect(screen.queryByRole("button", { name: /payments-gateway/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /docs-site/ })).toHaveAccessibleName(/Mark as seen/);
    expect(screen.getByText("Asks permission for Bash")).toBeInTheDocument();
    expect(screen.getByText("dotnet ef database update")).toBeInTheDocument();
    expect(screen.getByText("Claude is waiting for your input")).toBeInTheDocument();
    expect(screen.getAllByText(/Running outside Kotilo/)).toHaveLength(2);
    expect(screen.getByText("88k tok")).toBeInTheDocument();
  });

  it("filters by group", () => {
    render(<MissionControlPage />);
    fireEvent.click(screen.getByRole("radio", { name: "Working · 1" }));
    expect(screen.getByText("orders-service")).toBeInTheDocument();
    expect(screen.queryByText("payments-gateway")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Done · 1" }));
    expect(screen.getByText("docs-site")).toBeInTheDocument();
    act(() => useHubStore.setState({ sessions: [session({ sessionId: "z", state: "Working" })] }));
    fireEvent.click(screen.getByRole("radio", { name: "Needs you · 0" }));
    expect(screen.getByText("No sessions in this group right now")).toBeInTheDocument();
  });

  it("opens the pane on tile click", () => {
    render(<MissionControlPage />);
    fireEvent.click(screen.getByRole("button", { name: /orders-service/ }));
    expect(navigateToAgent).toHaveBeenCalledWith(expect.objectContaining({ paneId: "p1", workspaceId: "w1" }));
  });

  it("shows unseen finished work as Done and marks an outside session seen on click (D-056)", () => {
    render(<MissionControlPage />);
    const tile = screen.getByRole("button", { name: /docs-site/ });
    expect(within(tile).getByText("Done")).toBeInTheDocument();
    fireEvent.click(tile);
    expect(hubRequest).toHaveBeenCalledWith("POST", "/v1/sessions/claude-code/c/seen");
    // Cleared locally right away: now a seen, idle session (not a button, not in "Done").
    expect(screen.queryByRole("button", { name: /docs-site/ })).not.toBeInTheDocument();
    expect(screen.getByText("Idle")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Done · 0" })).toBeInTheDocument();
  });

  it("marks an in-app session seen when its tile opens the pane", () => {
    useHubStore.setState({ sessions: [session({ sessionId: "b", projectName: "orders-service", state: "Idle", unseen: true, paneId: "p1" })] });
    render(<MissionControlPage />);
    fireEvent.click(screen.getByRole("button", { name: /orders-service · .* · Done/ }));
    expect(navigateToAgent).toHaveBeenCalled();
    expect(hubRequest).toHaveBeenCalledWith("POST", "/v1/sessions/claude-code/b/seen");
  });

  it("offers Mark all as seen only while something is unseen", () => {
    render(<MissionControlPage />);
    fireEvent.click(screen.getByRole("button", { name: "Mark all as seen" }));
    expect(hubRequest).toHaveBeenCalledWith("POST", "/v1/sessions/seen");
    expect(screen.queryByRole("button", { name: "Mark all as seen" })).not.toBeInTheDocument();
  });

  it("readBufferTail joins soft-wrapped rows and right-trims", () => {
    const rows = [
      { text: "old", wrapped: false },
      { text: "Allow command? dotnet ef ", wrapped: false },
      { text: "database update   ", wrapped: true },
      { text: "  › 1. Yes   ", wrapped: false },
    ];
    setCreateTerminalFactory(() => ({
      ...fakeTerm([]),
      buffer: { active: { length: rows.length, getLine: (y: number) => ({ isWrapped: rows[y]!.wrapped, translateToString: () => rows[y]!.text }) } },
    }));
    getOrCreateEntry("tab-wrap");
    expect(readBufferTail("tab-wrap", 3)).toEqual(["Allow command? dotnet ef database update", "  › 1. Yes"]);
    expect(readBufferTail("missing", 3)).toEqual([]);
  });

  it("shows the empty state without sessions", () => {
    useHubStore.setState({ sessions: [] });
    render(<MissionControlPage />);
    expect(screen.getByText("No agent sessions yet")).toBeInTheDocument();
  });
});
