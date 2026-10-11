import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi, UseBoundStore } from "zustand";
import type { Agent } from "../../lib/ipc";
import type { SessionDto } from "../../lib/hubTypes";
import type { TerminalTab } from "../../stores/terminalStore";
import { makeSession } from "./sessionFixture";

const ipc = vi.hoisted(() => ({
  paneSendKeys: vi.fn(),
  gitHead: vi.fn(),
  onHubEvent: vi.fn(),
  onHubStatus: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ipc);

const focusTerminal = vi.hoisted(() => vi.fn());
vi.mock("../terminal/terminalRegistry", () => ({ focusTerminal }));
vi.mock("../composer/Composer", () => ({
  Composer: ({ paneId, agentName }: { paneId: string; agentName: string }) => <div data-testid={`composer-${paneId}`}>{agentName}</div>,
}));
vi.mock("../terminal/TerminalView", () => ({
  TerminalView: ({ tab }: { tab: TerminalTab }) => <div data-testid={`terminal-${tab.id}`} />,
}));

const agentStore = vi.hoisted(() => ({ store: null as unknown as UseBoundStore<StoreApi<{ agents: Agent[] }>> }));
vi.mock("../../stores/agentStore", async () => {
  const { create: createStore } = await import("zustand");
  agentStore.store = createStore<{ agents: Agent[] }>(() => ({ agents: [] }));
  return { useAgentStore: agentStore.store };
});
vi.mock("../../stores/workspaceStore", async () => {
  const { create: createStore } = await import("zustand");
  return { useWorkspaceStore: createStore(() => ({ workspaces: [{ id: "ws1", name: "Workspace One" }] })) };
});

import { useHubStore } from "../../stores/hubStore";
import { useDefinitionsStore } from "../../stores/definitionsStore";
import { builtinDefinitions } from "../../test/builtinDefinitions";
import { AgentPane, frameStyle } from "./AgentPane";

function tab(partial: Partial<TerminalTab> = {}): TerminalTab {
  return { id: "t1", title: "codex", paneId: "p1", status: "running", ...partial } as TerminalTab;
}

function waiting(partial: Partial<SessionDto> = {}): SessionDto {
  return makeSession({
    sessionId: "cx",
    agent: "codex",
    paneId: "p1",
    projectName: "payments-gateway",
    state: "WaitingPermission",
    stateSince: new Date(Date.now() - 72_000).toISOString(),
    pendingPermission: {
      tool: "Bash",
      command: "dotnet ef database update",
      path: null,
      risk: "writesDatabase",
      since: new Date(Date.now() - 72_000).toISOString(),
    },
    ...partial,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.paneSendKeys.mockResolvedValue(undefined);
  ipc.gitHead.mockResolvedValue({ kind: "branch", name: "main" });
  agentStore.store.setState({ agents: [] });
  useHubStore.setState({ sessions: [], limits: [], connected: true });
  useDefinitionsStore.setState({ loaded: true, definitions: builtinDefinitions() });
});

describe("AgentPane", () => {
  it("is a plain terminal without an agent: no header, no frame, no card", () => {
    const { container } = render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    expect(screen.getByTestId("terminal-t1")).toBeInTheDocument();
    expect(screen.queryByRole("group")).toBeNull();
    expect(container.querySelector("[data-pane-state]")).toBeNull();
  });

  it("shows the header and the working frame for a hub session on this pane", () => {
    useHubStore.setState({ sessions: [waiting({ state: "Working", pendingPermission: null })] });
    const { container } = render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    expect(screen.getByRole("group", { name: "Codex CLI in payments-gateway" })).toBeInTheDocument();
    expect(container.querySelector('[data-pane-state="working"]')).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Permission request" })).toBeNull();
  });

  it("finds a Codex session through the desktop record when the hub has no pane id", () => {
    agentStore.store.setState({
      agents: [{ id: "p1", paneId: "p1", workspaceId: "ws1", kind: "codex", adapterId: "codex", state: "blocked", sinceMs: 0, source: "hook", sessionId: "cx" }],
    });
    useHubStore.setState({ sessions: [waiting({ paneId: null })] });
    render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    expect(screen.getByText("Codex CLI wants to run a command")).toBeInTheDocument();
  });

  it("renders the permission card with command, risk and the agent's keys", () => {
    useHubStore.setState({ sessions: [waiting()] });
    render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    const card = screen.getByRole("region", { name: "Permission request" });
    expect(card).toHaveAttribute("aria-live", "assertive");
    expect(screen.getByText("Codex CLI wants to run a command")).toBeInTheDocument();
    expect(screen.getByText("dotnet ef database update")).toBeInTheDocument();
    expect(screen.getByText("Writes to a database")).toBeInTheDocument();
    expect(screen.getByText(/payments-gateway · waiting 1m/)).toBeInTheDocument();
  });

  it.each([
    ["Allow once", "y", /Allowed once\. Sent “y”/],
    ["Always allow in this project", "p", /Always allowed\. Sent “p”/],
    ["Deny", "Esc", /Denied\. Sent “Esc”/],
  ])("%s sends %j to this pane and shows the result", (button, bytes, result) => {
    useHubStore.setState({ sessions: [waiting()] });
    render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${button}`) }));
    expect(ipc.paneSendKeys).toHaveBeenCalledWith("p1", bytes);
    expect(screen.queryByRole("region", { name: "Permission request" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(result);
    expect(focusTerminal).toHaveBeenCalledWith("t1");
  });

  it("sends Claude Code's own keys for a Claude session", () => {
    useHubStore.setState({ sessions: [waiting({ agent: "claude-code" })] });
    render(<AgentPane workspaceId="ws1" tab={tab({ title: "claude" })} visible />);
    fireEvent.click(screen.getByRole("button", { name: /^Allow once/ }));
    expect(ipc.paneSendKeys).toHaveBeenCalledWith("p1", "1");
  });

  it("handles Enter and Esc only while focus is inside the card", () => {
    useHubStore.setState({ sessions: [waiting()] });
    render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    // A key on the terminal (outside the card) is never taken.
    fireEvent.keyDown(screen.getByTestId("terminal-t1"), { key: "Escape" });
    expect(ipc.paneSendKeys).not.toHaveBeenCalled();
    // Esc inside the card denies.
    fireEvent.keyDown(screen.getByText("dotnet ef database update"), { key: "Escape" });
    expect(ipc.paneSendKeys).toHaveBeenCalledWith("p1", "Esc");
  });

  it("Enter inside the card (not on a button) allows once", () => {
    useHubStore.setState({ sessions: [waiting()] });
    render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    fireEvent.keyDown(screen.getByText("dotnet ef database update"), { key: "Enter" });
    expect(ipc.paneSendKeys).toHaveBeenCalledWith("p1", "y");
  });

  it("'Answer in terminal' hides the card for this request without sending anything", () => {
    useHubStore.setState({ sessions: [waiting()] });
    render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    fireEvent.click(screen.getByRole("button", { name: "Answer in terminal" }));
    expect(screen.queryByRole("region", { name: "Permission request" })).toBeNull();
    expect(ipc.paneSendKeys).not.toHaveBeenCalled();
    expect(focusTerminal).toHaveBeenCalledWith("t1");

    // A new request (different `since`) shows the card again.
    act(() => {
      useHubStore.setState({
        sessions: [waiting({ pendingPermission: { ...waiting().pendingPermission!, since: new Date(Date.now() + 1000).toISOString() } })],
      });
    });
    expect(screen.getByRole("region", { name: "Permission request" })).toBeInTheDocument();
  });

  it("offers only 'Answer in terminal' for an agent without verified keys (Droid)", () => {
    useHubStore.setState({ sessions: [waiting({ agent: "droid" })] });
    render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    expect(screen.queryByRole("button", { name: /^Allow once/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Answer in terminal" })).toBeInTheDocument();
  });

  it("shows the card with Cursor's y/n for a prompt found on its screen (hub still Working)", () => {
    agentStore.store.setState({
      agents: [{ id: "p1", paneId: "p1", workspaceId: "ws1", kind: "cursor", adapterId: "cursor", state: "blocked", sinceMs: Date.now() - 5000, source: "hook", sessionId: null }],
    });
    useHubStore.setState({ sessions: [waiting({ agent: "cursor", state: "Working", pendingPermission: null })] });
    const { container } = render(<AgentPane workspaceId="ws1" tab={tab({ title: "cursor-agent" })} visible />);
    expect(container.querySelector('[data-pane-state="permission"]')).not.toBeNull();
    expect(screen.getByText("Cursor CLI needs permission")).toBeInTheDocument();
    expect(screen.getByText("Read the prompt in the terminal before you answer.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Always allow in this project" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    expect(ipc.paneSendKeys).toHaveBeenCalledWith("p1", "n");
  });

  it("shows no card without permission details from the hub", () => {
    useHubStore.setState({ sessions: [waiting({ pendingPermission: null })] });
    render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    expect(screen.queryByRole("region", { name: "Permission request" })).toBeNull();
  });
});

describe("frameStyle", () => {
  it("uses status tokens for working and waiting, nothing without an agent", () => {
    expect(frameStyle(null)).toBeUndefined();
    expect(frameStyle("working")?.border).toContain("var(--status-working)");
    expect(frameStyle("permission")?.boxShadow).toContain("var(--status-blocked)");
    expect(frameStyle("idle")?.border).toContain("var(--border)");
  });
});

describe("AgentPane composer and split button (M4)", () => {
  it("shows the composer only for a running agent pane", () => {
    const { unmount } = render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    expect(screen.queryByTestId("composer-p1")).toBeNull();
    unmount();
    useHubStore.setState({ sessions: [waiting({ state: "Working", pendingPermission: null })] });
    render(<AgentPane workspaceId="ws1" tab={tab()} visible />);
    expect(screen.getByTestId("composer-p1")).toHaveTextContent("Codex CLI");
  });

  it("hides the composer once the pane's process exited", () => {
    useHubStore.setState({ sessions: [waiting({ state: "Working", pendingPermission: null })] });
    render(<AgentPane workspaceId="ws1" tab={tab({ status: "exited" })} visible />);
    expect(screen.queryByTestId("composer-p1")).toBeNull();
  });

  it("the header split button toggles the split", () => {
    useHubStore.setState({ sessions: [waiting({ state: "Working", pendingPermission: null })] });
    const onToggle = vi.fn();
    const { rerender } = render(<AgentPane workspaceId="ws1" tab={tab()} visible split={{ open: false, onToggle }} />);
    fireEvent.click(screen.getByRole("button", { name: "Split right" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<AgentPane workspaceId="ws1" tab={tab()} visible split={{ open: true, onToggle }} />);
    expect(screen.getByRole("button", { name: "Close split" })).toHaveAttribute("aria-pressed", "true");
  });
});
