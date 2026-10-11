import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectsPage } from "./ProjectsPage";
import { strings } from "../../app/strings";
import { useRouteStore } from "../../stores/routeStore";
import { useViewerStore } from "../../stores/viewerStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { ProjectDto, TodoFileDto } from "../../lib/hubTypes";

const ipc = vi.hoisted(() => ({ hubRequest: vi.fn(), workspaceSetActive: vi.fn() }));
vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return { ...actual, ...ipc };
});

const ROOT = String.raw`C:\src\app`;

const PROJECT: ProjectDto = {
  root: ROOT,
  name: "app",
  manual: false,
  hidden: false,
  lastActivity: "2026-10-04T09:00:00+03:00",
  done: 3,
  inProgress: 1,
  total: 6,
  percent: 50,
  files: 1,
  next: { file: "tasks/todo.md", text: "Wire the permission card", group: "M2" },
  git: { branch: "main", isDetached: false, hasUpstream: true, ahead: 1, behind: 0, changed: 2, lastCommitAt: null, lastCommitSubject: null, checkedAt: "2026-10-04T09:00:00+03:00" },
  customerId: null,
  alias: null,
};

const FILES: TodoFileDto[] = [
  {
    relativePath: "tasks/todo.md",
    done: 3,
    inProgress: 1,
    total: 6,
    lastWriteUtc: "2026-10-04T06:00:00Z",
    groups: [{ title: "M2", level: 2, done: 3, total: 6, items: [{ text: "Wire the permission card", state: "inProgress", line: 12 }] }],
  },
];

describe("ProjectsPage", () => {
  beforeEach(() => {
    useRouteStore.setState({ route: "projects" });
    ipc.workspaceSetActive.mockReset().mockResolvedValue(undefined);
    ipc.hubRequest.mockReset().mockImplementation((_method: string, path: string) => {
      if (path.startsWith("/v1/projects/files")) return Promise.resolve(FILES);
      if (path.startsWith("/v1/projects")) return Promise.resolve([PROJECT]);
      if (path === "/v1/customers") return Promise.resolve([]);
      return Promise.resolve(null);
    });
  });

  it("shows progress, git status and the next item", async () => {
    useWorkspaceStore.setState({ workspaces: [] });
    render(<ProjectsPage />);
    expect((await screen.findAllByText("app")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(strings.projects.gitChanged(2)).length).toBeGreaterThan(0);
    expect(await screen.findAllByText("Wire the permission card")).not.toHaveLength(0);
    expect(screen.getByText(strings.projects.notInWorkspace)).toBeInTheDocument();
  });

  it("opens a todo file in the viewer when the project is in a workspace", async () => {
    useWorkspaceStore.setState({ workspaces: [{ id: "w1", name: "app", path: ROOT } as never] });
    const openFile = vi.spyOn(useViewerStore.getState(), "openFile");
    render(<ProjectsPage />);
    fireEvent.click(await screen.findByRole("button", { name: strings.projects.openFileLabel("tasks/todo.md") }));
    expect(openFile).toHaveBeenCalledWith("w1", "tasks/todo.md", { pinned: true, line: undefined });
    expect(useRouteStore.getState().route).toBe("workspace");
  });

  it("saves a display name through the hub", async () => {
    useWorkspaceStore.setState({ workspaces: [] });
    render(<ProjectsPage />);
    const alias = await screen.findByLabelText(strings.projects.alias);
    fireEvent.change(alias, { target: { value: "Billing app" } });
    fireEvent.click(screen.getByRole("button", { name: strings.projects.save }));
    await waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledWith("PUT", "/v1/projects/alias", { root: ROOT, alias: "Billing app" }));
  });

  it("edits the alias, not the shown name: the folder name is only a placeholder, clearing sends null", async () => {
    ipc.hubRequest.mockImplementation((_method: string, path: string) => {
      if (path.startsWith("/v1/projects/files")) return Promise.resolve(FILES);
      if (path.startsWith("/v1/projects")) return Promise.resolve([{ ...PROJECT, name: "Billing app", alias: "Billing app" }]);
      if (path === "/v1/customers") return Promise.resolve([]);
      return Promise.resolve(null);
    });
    useWorkspaceStore.setState({ workspaces: [] });
    render(<ProjectsPage />);
    const alias = (await screen.findByLabelText(strings.projects.alias)) as HTMLInputElement;
    expect(alias.value).toBe("Billing app");
    fireEvent.change(alias, { target: { value: "" } });
    expect(alias.placeholder).toBe("app");
    fireEvent.click(screen.getByRole("button", { name: strings.projects.save }));
    await waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledWith("PUT", "/v1/projects/alias", { root: ROOT, alias: null }));
  });
});
