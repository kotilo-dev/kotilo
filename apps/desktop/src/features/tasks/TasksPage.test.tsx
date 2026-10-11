import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TasksPage } from "./TasksPage";
import { strings } from "../../app/strings";
import type { PersonalTask } from "../../lib/hubTypes";

const ipc = vi.hoisted(() => ({ hubRequest: vi.fn() }));
vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return { ...actual, ...ipc };
});

const TASKS: PersonalTask[] = [
  {
    id: 7,
    text: "Renew certificate\nbefore Friday",
    title: "Renew certificate",
    details: "before Friday",
    projectRoot: null,
    projectName: null,
    dueDate: "2026-10-01",
    dueTime: null,
    priority: "high",
    dueState: "overdue",
    createdAt: "2026-09-30T10:00:00+03:00",
    updatedAt: "2026-09-30T10:00:00+03:00",
    completedAt: null,
  },
  {
    id: 8,
    text: "Write release notes",
    title: "Write release notes",
    details: null,
    projectRoot: "C:/src/app",
    projectName: "app",
    dueDate: null,
    dueTime: null,
    priority: "normal",
    dueState: "none",
    createdAt: "2026-10-02T10:00:00+03:00",
    updatedAt: "2026-10-02T10:00:00+03:00",
    completedAt: null,
  },
];

describe("TasksPage", () => {
  beforeEach(() => {
    ipc.hubRequest.mockReset().mockImplementation((method: string, path: string) => {
      if (method === "GET" && path.startsWith("/v1/tasks")) return Promise.resolve(TASKS);
      if (method === "GET" && path === "/v1/projects") return Promise.resolve([]);
      return Promise.resolve({});
    });
  });

  it("groups general notes before projects and marks overdue tasks", async () => {
    render(<TasksPage />);
    expect(await screen.findByText("Renew certificate")).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([strings.tasks.generalNotes, "app"]);
    expect(screen.getByText(strings.tasks.overdue, { exact: false })).toBeInTheDocument();
  });

  it("quick add posts a general note on Enter", async () => {
    render(<TasksPage />);
    const input = screen.getByLabelText(strings.tasks.quickAddLabel);
    fireEvent.change(input, { target: { value: "Call the bank" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledWith("POST", "/v1/tasks", { text: "Call the bank" }));
  });

  it("creates a task with a due date from the dialog", async () => {
    render(<TasksPage />);
    fireEvent.click(screen.getByRole("button", { name: strings.tasks.newTask }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(strings.tasks.noteLabel), { target: { value: "Renew passport" } });
    fireEvent.click(within(dialog).getByRole("button", { name: strings.tasks.dueToday }));
    fireEvent.click(within(dialog).getByRole("button", { name: new RegExp(strings.tasks.save) }));
    await waitFor(() =>
      expect(ipc.hubRequest).toHaveBeenCalledWith("POST", "/v1/tasks", expect.objectContaining({ text: "Renew passport", dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })),
    );
  });

  it("does not save an empty note", async () => {
    render(<TasksPage />);
    fireEvent.click(screen.getByRole("button", { name: strings.tasks.newTask }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: new RegExp(strings.tasks.save) }));
    expect(await within(dialog).findByText(strings.tasks.noteRequired)).toBeInTheDocument();
    expect(ipc.hubRequest).not.toHaveBeenCalledWith("POST", "/v1/tasks", expect.anything());
  });

  it("completes a task with its checkbox", async () => {
    render(<TasksPage />);
    fireEvent.click(await screen.findByLabelText(strings.tasks.markDone("Renew certificate")));
    await waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledWith("POST", "/v1/tasks/7/complete", { completed: true }));
  });

  it("deletes a task only after confirmation", async () => {
    render(<TasksPage />);
    fireEvent.click(await screen.findByRole("button", { name: `${strings.tasks.delete}: Write release notes` }));
    expect(ipc.hubRequest).not.toHaveBeenCalledWith("DELETE", expect.anything());
    expect(screen.getByText(strings.tasks.deleteTitle)).toBeInTheDocument();
    const confirm = screen.getAllByRole("button", { name: strings.tasks.delete }).slice(-1)[0]!;
    fireEvent.click(confirm);
    await waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledWith("DELETE", "/v1/tasks/8"));
  });
});
