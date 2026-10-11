import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityDto } from "../../lib/hubTypes";
import type { GitChanges } from "../../lib/ipc";
import { makeSession } from "../workspace/sessionFixture";

const ipc = vi.hoisted(() => ({
  hubRequest: vi.fn(),
  gitChanges: vi.fn(),
  onHubEvent: vi.fn(() => Promise.resolve(() => {})),
  onHubStatus: vi.fn(() => Promise.resolve(() => {})),
  onFsChanged: vi.fn(() => Promise.resolve(() => {})),
  onFsRescan: vi.fn(() => Promise.resolve(() => {})),
  saveStateSlice: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../lib/ipc", () => ipc);

vi.mock("../../stores/agentStore", async () => {
  const { create } = await import("zustand");
  return { useAgentStore: create(() => ({ agents: [] })) };
});
vi.mock("../../stores/workspaceStore", async () => {
  const { create } = await import("zustand");
  return { useWorkspaceStore: create(() => ({ activeId: "ws1", workspaces: [{ id: "ws1", name: "app", path: "C:\\src\\app" }] })) };
});
vi.mock("../../stores/terminalStore", async () => {
  const { create } = await import("zustand");
  return { useTerminalStore: create(() => ({ byWorkspace: { ws1: { tabs: [{ id: "t1", paneId: "pane-1" }], activeTabId: "t1" } } })) };
});

import { useHubStore } from "../../stores/hubStore";
import { useLayoutStore, DEFAULT_LAYOUT } from "../../stores/layoutStore";
import { useViewerStore } from "../../stores/viewerStore";
import { getCommand } from "../../app/commands";
import { resetActivityStoreForTests } from "./activityStore";
import { resetChangesStoreForTests } from "./changesStore";
import { TimelineRail } from "./TimelineRail";

const activity: ActivityDto = {
  entries: [
    { id: 1, kind: "turn", at: "2026-10-08T10:00:00Z" },
    { id: 2, kind: "read", tool: "Read", target: "src/approval.ts", startedAt: "2026-10-08T10:00:01Z", durationMs: 12, status: "ok" },
    { id: 3, kind: "edit", tool: "Edit", target: "src/approval.ts", startedAt: "2026-10-08T10:00:05Z", durationMs: 40, status: "ok" },
    { id: 4, kind: "bash", tool: "Bash", target: "npm test", startedAt: "2026-10-08T10:00:09Z", status: "failed" },
    { id: 5, kind: "bash", tool: "Bash", target: "npm test -- approval", startedAt: "2026-10-08T10:00:20Z", status: "running" },
  ],
  plan: {
    items: [
      { text: "Reproduce the failing test", status: "completed" },
      { text: "Fix the mapping", status: "in_progress" },
      { text: "Update CHANGELOG", status: "pending" },
    ],
  },
};

const changes: GitChanges = {
  repo: true,
  head: "abc",
  truncated: false,
  files: [
    { path: "README.md", status: "M", added: 2, removed: 0 },
    { path: "src/approval.ts", status: "M", added: 12, removed: 3 },
  ],
};

beforeEach(() => {
  resetActivityStoreForTests();
  resetChangesStoreForTests();
  ipc.hubRequest.mockReset().mockResolvedValue(activity);
  ipc.gitChanges.mockReset().mockResolvedValue(changes);
  useLayoutStore.setState({ status: "ready", layout: DEFAULT_LAYOUT });
  useViewerStore.setState({ byWorkspace: {} });
  useHubStore.setState({ sessions: [makeSession({ sessionId: "s1", paneId: "pane-1", projectRoot: "C:\\src\\app", state: "Working" })] });
});

describe("TimelineRail", () => {
  it("shows the plan, the activity newest first and the changed files touched first", async () => {
    render(<TimelineRail />);
    expect(await screen.findByText("Fix the mapping")).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(ipc.hubRequest).toHaveBeenCalledWith("GET", "/v1/sessions/claude-code/s1/activity");

    const rows = within(screen.getByTestId("timeline-activity")).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-kind"))).toEqual(["bash", "bash", "edit", "read", "turn"]);
    expect(rows[0]).toHaveAttribute("data-status", "running");
    expect(rows[0]).toHaveTextContent("Bash · running");
    expect(rows[1]).toHaveTextContent("Bash · failed");
    expect(rows[2]).toHaveTextContent("E");
    expect(rows[4]).toHaveTextContent("New prompt");

    const changed = await screen.findByTestId("timeline-changes");
    const files = await within(changed).findAllByRole("button", { name: /Show changes in/ });
    expect(files.map((b) => b.getAttribute("aria-label"))).toEqual(["Show changes in src/approval.ts", "Show changes in README.md"]);
    expect(files[0]).toHaveAttribute("data-touched", "true");
    expect(within(changed).getByText("Other changes")).toBeInTheDocument();
    expect(files[0]).toHaveTextContent("+12 −3");
  });

  it("opens a read-only diff tab for a changed file", async () => {
    useLayoutStore.setState({ layout: { ...DEFAULT_LAYOUT, viewerVisible: false } });
    render(<TimelineRail />);
    fireEvent.click(await screen.findByRole("button", { name: "Show changes in README.md" }));
    const ws = useViewerStore.getState().byWorkspace.ws1!;
    expect(ws.tabs).toEqual([expect.objectContaining({ rel: "README.md", diff: true, pinned: true })]);
    expect(ws.activeTabId).toBe(ws.tabs[0]!.id);
    expect(useLayoutStore.getState().layout.viewerVisible).toBe(true);
  });

  it("collapses and expands from its header and the palette command", async () => {
    render(<TimelineRail />);
    fireEvent.click(screen.getByRole("button", { name: "Hide timeline" }));
    expect(useLayoutStore.getState().layout.timelineVisible).toBe(false);
    expect(screen.queryByTestId("timeline-rail")).toBeNull();
    act(() => getCommand("view.toggleTimeline")!.run());
    expect(await screen.findByTestId("timeline-rail")).toBeInTheDocument();
  });

  it("says when the workspace has no agent session", async () => {
    useHubStore.setState({ sessions: [] });
    render(<TimelineRail />);
    expect(await screen.findByText("No agent session in this workspace yet.")).toBeInTheDocument();
    expect(ipc.hubRequest).not.toHaveBeenCalled();
  });
});
