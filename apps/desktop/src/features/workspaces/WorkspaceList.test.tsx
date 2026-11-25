import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Agent, Workspace } from "../../lib/ipc";

vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  const state = { workspaces: [], activeId: null };
  return {
    ...actual,
    workspaceSetActive: vi.fn(async () => {}),
    workspaceGroupCreate: vi.fn(async () => state),
    workspaceGroupRemove: vi.fn(async () => state),
    workspaceGroupMove: vi.fn(async () => state),
    workspaceSetGroup: vi.fn(async () => state),
    workspaceReorder: vi.fn(async () => state),
  };
});

import * as ipcModule from "../../lib/ipc";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useAgentStore } from "../../stores/agentStore";
import { useLayoutStore } from "../../stores/layoutStore";
import { useI18nStore } from "../../app/i18n";
import { WorkspaceList } from "./WorkspaceList";

function ws(id: string, name: string, group?: string): Workspace {
  return { id, name, path: `C:\\dev\\${name}`, expandedDirs: [], group };
}
function blocked(workspaceId: string): Agent {
  return { id: `${workspaceId}-b`, paneId: `p-${workspaceId}`, workspaceId, kind: "claude", state: "blocked", sinceMs: 0, source: "hook", sessionId: null };
}

function setup(workspaces: Workspace[], groups: { id: string; name: string }[], collapsed: string[] = []) {
  useWorkspaceStore.setState({ ready: true, workspaces, groups, activeId: workspaces[0]?.id ?? null });
  useLayoutStore.setState((s) => ({ layout: { ...s.layout, collapsedWorkspaceGroups: collapsed } }));
  render(<WorkspaceList />);
}

const collapsedIds = () => useLayoutStore.getState().layout.collapsedWorkspaceGroups;

beforeEach(() => {
  vi.clearAllMocks();
  useI18nStore.setState({ preference: "en", language: "en" });
  useAgentStore.setState({ agents: [] });
});

describe("WorkspaceList groups", () => {
  it("renders no headers when there are no groups", () => {
    setup([ws("a", "alpha"), ws("b", "beta")], []);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("shows headers with counts and an Ungrouped header; collapsed groups hide rows", () => {
    setup([ws("a", "alpha", "g1"), ws("b", "beta", "g1"), ws("c", "gamma")], [{ id: "g1", name: "Work" }], ["g1"]);
    expect(screen.getByRole("group", { name: "Work" })).toHaveTextContent("2");
    expect(screen.getByRole("group", { name: "Ungrouped" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /gamma/ })).toBeInTheDocument();
  });

  it("a collapsed group shows a badge with its blocked agents", () => {
    useAgentStore.setState({ agents: [blocked("a"), blocked("b")] });
    setup([ws("a", "alpha", "g1"), ws("b", "beta", "g1")], [{ id: "g1", name: "Work" }], ["g1"]);
    expect(screen.getByTestId("group-alert-badge")).toHaveTextContent("2");
  });

  it("clicking a header toggles the collapsed state in the layout store", () => {
    setup([ws("a", "alpha", "g1")], [{ id: "g1", name: "Work" }]);
    fireEvent.click(screen.getByRole("group", { name: "Work" }));
    expect(collapsedIds()).toEqual(["g1"]);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("keyboard: arrows land on headers, Enter/Left/Right toggle, hidden rows are skipped", () => {
    setup([ws("a", "alpha", "g1"), ws("b", "beta")], [{ id: "g1", name: "Work" }]);
    const list = screen.getByRole("listbox", { name: "Workspaces" });
    fireEvent.keyDown(list, { key: "ArrowUp" }); // alpha -> Work header
    fireEvent.keyDown(list, { key: "Enter" });
    expect(collapsedIds()).toEqual(["g1"]);
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(collapsedIds()).toEqual([]);
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(collapsedIds()).toEqual(["g1"]);
    fireEvent.keyDown(list, { key: "ArrowDown" }); // alpha is hidden: the next visible row is beta
    fireEvent.keyDown(list, { key: "Enter" });
    expect(ipcModule.workspaceSetActive).toHaveBeenCalledWith("b");
  });

  it("Delete on a header does nothing (groups are deleted from the header menu only)", () => {
    setup([ws("a", "alpha", "g1")], [{ id: "g1", name: "Work" }]);
    const list = screen.getByRole("listbox", { name: "Workspaces" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Delete" });
    expect(ipcModule.workspaceGroupRemove).not.toHaveBeenCalled();
  });

  it("Move to group swaps the menu in place; the current group is disabled", () => {
    setup([ws("a", "alpha", "g1"), ws("b", "beta")], [{ id: "g1", name: "Work" }]);
    fireEvent.contextMenu(screen.getByRole("option", { name: /alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move to group…" }));
    expect(screen.getByRole("button", { name: "Work" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New group…" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove from group" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("picking a group calls workspaceSetGroup and closes the menu", () => {
    setup([ws("a", "alpha", "g1"), ws("b", "beta")], [{ id: "g1", name: "Work" }]);
    fireEvent.contextMenu(screen.getByRole("option", { name: /beta/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move to group…" }));
    expect(screen.getByRole("button", { name: "Remove from group" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(ipcModule.workspaceSetGroup).toHaveBeenCalledWith("b", "g1");
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
  });

  it("New group from a workspace creates the group with that workspace", async () => {
    setup([ws("a", "alpha")], []);
    fireEvent.contextMenu(screen.getByRole("option", { name: /alpha/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move to group…" }));
    fireEvent.click(screen.getByRole("button", { name: "New group…" }));
    const input = screen.getByPlaceholderText("Group name");
    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(ipcModule.workspaceGroupCreate).toHaveBeenCalledWith("Work", "a"));
  });

  it("the empty-area menu offers New group without a workspace", async () => {
    setup([ws("a", "alpha")], []);
    fireEvent.contextMenu(screen.getByRole("listbox", { name: "Workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: "New group…" }));
    const input = screen.getByPlaceholderText("Group name");
    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(ipcModule.workspaceGroupCreate).toHaveBeenCalledWith("Work", undefined));
  });

  it("Move up/down are disabled at in-group edges, not global ones", () => {
    setup(
      [ws("a", "alpha", "g1"), ws("b", "beta", "g1"), ws("c", "gamma", "g2")],
      [{ id: "g1", name: "One" }, { id: "g2", name: "Two" }],
    );
    fireEvent.contextMenu(screen.getByRole("option", { name: /beta/ }));
    // beta is not the global last, but it is the last of its group.
    expect(screen.getByRole("button", { name: "Move up" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move down" })).toBeDisabled();
  });

  it("group header menu: Delete group, Move up disabled on the first group", () => {
    setup([ws("a", "alpha", "g1")], [{ id: "g1", name: "One" }, { id: "g2", name: "Two" }]);
    fireEvent.contextMenu(screen.getByRole("group", { name: "One" }));
    expect(screen.getByRole("button", { name: "Move up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move down" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete group" }));
    expect(ipcModule.workspaceGroupRemove).toHaveBeenCalledWith("g1");
  });
});
