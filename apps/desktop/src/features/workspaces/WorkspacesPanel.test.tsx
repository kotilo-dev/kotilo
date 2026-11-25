import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Agent, Workspace, WorkspacesState } from "../../lib/ipc";

const ipc = vi.hoisted(() => ({
  state: { workspaces: [], activeId: null } as unknown as WorkspacesState,
  changed: null as null | ((s: WorkspacesState) => void),
}));

vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return {
    ...actual,
    workspaceList: vi.fn(async () => ipc.state),
    // Stands in for the backend: switching emits `workspaces:changed`.
    workspaceSetActive: vi.fn(async (id: string) => {
      ipc.state = { ...ipc.state, activeId: id };
      ipc.changed?.(ipc.state);
    }),
    fsReadDir: vi.fn(async () => [
      { name: "src", rel: "src", isDir: true },
      { name: "README.md", rel: "README.md", isDir: false },
    ]),
    fsQuickOpen: vi.fn(async () => ({ items: [] })),
    gitHead: vi.fn(async () => ({ kind: "branch", name: "main" })),
    onFsChanged: vi.fn(async () => () => {}),
    onFsRescan: vi.fn(async () => () => {}),
    onWorkspacesChanged: vi.fn(async (handler: (s: WorkspacesState) => void) => {
      ipc.changed = handler;
      return () => {};
    }),
    workspaceSetExpanded: vi.fn(async () => {}),
  };
});
// jsdom has no layout, so the real virtualizer renders no rows.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * estimateSize() })),
    scrollToIndex: () => {},
  }),
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => false, onFocusChanged: async () => () => {} }),
}));
vi.mock("../../stores/docsStore", () => {
  const state = { byWorkspace: {}, watch: () => () => {} };
  const hook = (selector: (s: typeof state) => unknown) => selector(state);
  hook.getState = () => state;
  return { useDocsStore: hook };
});

import * as ipcModule from "../../lib/ipc";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useWorkspacePanelStore } from "../../stores/workspacePanelStore";
import { useAgentStore } from "../../stores/agentStore";
import { useI18nStore } from "../../app/i18n";
import { WorkspacesPanel } from "./WorkspacesPanel";

function ws(id: string, name: string): Workspace {
  return { id, name, path: `C:\\dev\\${name}`, expandedDirs: [] };
}

function agent(workspaceId: string, state: Agent["state"], id = `${workspaceId}-${state}`): Agent {
  return { id, paneId: `pane-${id}`, workspaceId, kind: "claude", state, sinceMs: 0, source: "hook", sessionId: null };
}

async function mount(workspaces: Workspace[], activeId: string | null) {
  ipc.state = { workspaces, activeId };
  render(<WorkspacesPanel />);
  await waitFor(() => expect(useWorkspaceStore.getState().ready).toBe(true));
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(name, "i") });

beforeEach(() => {
  vi.clearAllMocks();
  useI18nStore.setState({ preference: "en", language: "en" });
  useWorkspacePanelStore.setState({ tab: null });
  useAgentStore.setState({ agents: [] });
  useWorkspaceStore.setState({ ready: false, workspaces: [], activeId: null, dirCache: {}, expanded: {}, selected: null });
});

describe("WorkspacesPanel tabs", () => {
  it("starts on Files with the active workspace's name and branch in the header", async () => {
    await mount([ws("a", "orders-service"), ws("b", "billing-api")], "a");
    expect(tab("files")).toHaveAttribute("aria-selected", "true");
    expect(tab("workspaces")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("files-workspace-name")).toHaveTextContent("orders-service");
    await waitFor(() => expect(screen.getByTestId("files-branch")).toHaveTextContent("main"));
    // The tree has no root row: its top level is the workspace's contents.
    await waitFor(() => expect(screen.getByTitle("README.md")).toBeInTheDocument());
    expect(screen.queryByText("Other workspaces (1)")).toBeNull();
  });

  it("empty state: no workspaces → Workspaces tab with the empty text, Files disabled", async () => {
    await mount([], null);
    expect(tab("workspaces")).toHaveAttribute("aria-selected", "true");
    expect(tab("files")).toBeDisabled();
    expect(screen.getByText("No workspaces added yet.")).toBeInTheDocument();
  });

  it("no active workspace → opens on the Workspaces tab with the list", async () => {
    await mount([ws("a", "orders-service")], null);
    expect(tab("workspaces")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /orders-service/ })).toBeInTheDocument();
  });

  it("a click on a workspace row makes it active and stays on the Workspaces tab", async () => {
    await mount([ws("a", "orders-service"), ws("b", "billing-api")], "a");
    fireEvent.click(tab("workspaces"));
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("aria-selected", "true");
    expect(rows[1]).toHaveAttribute("aria-selected", "false");
    fireEvent.click(within(rows[1]!).getByTitle("billing-api"));
    await waitFor(() => expect(ipcModule.workspaceSetActive).toHaveBeenCalledWith("b"));
    await waitFor(() => expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true"));
    expect(tab("workspaces")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tab("files"));
    await waitFor(() => expect(screen.getByTestId("files-workspace-name")).toHaveTextContent("billing-api"));
  });

  it("Enter on the list activates the cursor row", async () => {
    await mount([ws("a", "orders-service"), ws("b", "billing-api")], "a");
    fireEvent.click(tab("workspaces"));
    const list = screen.getByRole("listbox", { name: "Workspaces" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(ipcModule.workspaceSetActive).toHaveBeenCalledWith("b"));
    expect(tab("workspaces")).toHaveAttribute("aria-selected", "true");
  });

  it("the workspace context menu holds only workspace actions", async () => {
    await mount([ws("a", "orders-service"), ws("b", "billing-api")], "a");
    fireEvent.click(tab("workspaces"));
    fireEvent.contextMenu(screen.getAllByRole("option")[1]!);
    for (const label of ["Rename", "Remove", "Move up", "Move down", "Check docs", "New agent in worktree…", "Agent context…"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "New File" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Make active" })).toBeNull();
  });
});

describe("Workspaces tab alert badge", () => {
  it("counts other workspaces with an agent that needs permission", async () => {
    useAgentStore.setState({
      agents: [agent("b", "blocked"), agent("b", "blocked", "b2"), agent("c", "blocked"), agent("a", "blocked"), agent("d", "working")],
    });
    await mount([ws("a", "orders"), ws("b", "billing"), ws("c", "kotilo"), ws("d", "docs")], "a");
    const badge = screen.getByTestId("workspaces-alert-badge");
    // b and c; the active workspace "a" and the merely working "d" do not count.
    expect(badge).toHaveTextContent("2");
    expect(badge).toHaveAttribute("title", "2 agents need permission in other workspaces");
  });

  it("shows no badge when nothing elsewhere is blocked", async () => {
    useAgentStore.setState({ agents: [agent("a", "blocked"), agent("b", "working")] });
    await mount([ws("a", "orders"), ws("b", "billing")], "a");
    expect(screen.queryByTestId("workspaces-alert-badge")).toBeNull();
  });

  it("the Workspaces tab rows carry the agent state label", async () => {
    useAgentStore.setState({ agents: [agent("b", "blocked")] });
    await mount([ws("a", "orders"), ws("b", "billing")], "a");
    fireEvent.click(tab("workspaces"));
    const rows = screen.getAllByRole("option");
    expect(within(rows[1]!).getByText("Needs permission")).toBeInTheDocument();
    expect(within(rows[0]!).queryByTestId("agent-state-pill")).toBeNull();
  });
});

describe("workspace switcher", () => {
  async function openSwitcher() {
    await mount([ws("a", "orders-service"), ws("b", "billing-api"), ws("c", "kotilo")], "a");
    fireEvent.click(screen.getByRole("button", { name: "Switch workspace" }));
    return screen.getByRole("combobox", { name: "Search workspaces" });
  }

  it("lists the workspaces and filters by name", async () => {
    const input = await openSwitcher();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    fireEvent.change(input, { target: { value: "bill" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("billing-api");
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching workspaces")).toBeInTheDocument();
  });

  it("Enter picks the highlighted workspace (arrow keys move) and stays on Files", async () => {
    const input = await openSwitcher();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(ipcModule.workspaceSetActive).toHaveBeenCalledWith("c"));
    expect(screen.queryByRole("combobox", { name: "Search workspaces" })).toBeNull();
    expect(tab("files")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByTestId("files-workspace-name")).toHaveTextContent("kotilo"));
  });

  it("a click on an option picks it; picking the active workspace changes nothing", async () => {
    await openSwitcher();
    fireEvent.click(screen.getAllByRole("option")[0]!);
    expect(ipcModule.workspaceSetActive).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Esc closes the popover and does not reach other key handlers", async () => {
    await openSwitcher();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search workspaces" }), { key: "Escape" });
    window.removeEventListener("keydown", seen);
    expect(screen.queryByRole("combobox", { name: "Search workspaces" })).toBeNull();
    expect(seen).not.toHaveBeenCalled();
  });

  it("\"Manage workspaces…\" closes the popover and shows the Workspaces tab", async () => {
    await openSwitcher();
    fireEvent.click(screen.getByRole("button", { name: "Manage workspaces…" }));
    expect(screen.queryByRole("combobox", { name: "Search workspaces" })).toBeNull();
    expect(tab("workspaces")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("listbox", { name: "Workspaces" })).toBeInTheDocument();
  });

  it("an outside click (the scrim) closes it", async () => {
    await openSwitcher();
    const scrim = document.querySelector("button[aria-hidden='true'].bg-scrim") as HTMLElement;
    expect(scrim).not.toBeNull();
    act(() => {
      fireEvent.click(scrim);
    });
    expect(screen.queryByRole("combobox", { name: "Search workspaces" })).toBeNull();
  });
});
