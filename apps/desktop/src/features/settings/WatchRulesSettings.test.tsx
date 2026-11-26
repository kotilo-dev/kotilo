import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { HubSettings, WatchOverview } from "../../lib/hubTypes";

const ipc = vi.hoisted(() => ({ hubRequest: vi.fn() }));
vi.mock("../../lib/ipc", async () => ({ ...(await vi.importActual<object>("../../lib/ipc")), ...ipc }));

import { WatchRulesSettings } from "./WatchRulesSettings";

const OVERVIEW: WatchOverview = {
  builtins: [
    { id: "builtin.secret-file", name: "Secret file", enabled: true, notify: true },
    { id: "builtin.git-discard", name: "Irreversible git", enabled: true, notify: false },
  ],
  user: [],
  projects: [{ root: "C:/src/app", trusted: false, ruleCount: 2, problems: [{ line: 4, message: "bad regex" }] }],
  problems: [],
};

const draft = (watch?: HubSettings["watch"]) => ({ watch }) as unknown as HubSettings;

function renderBlock(d: HubSettings = draft()) {
  const update = vi.fn();
  render(<WatchRulesSettings draft={d} update={update} />);
  const apply = (call = 0, from: HubSettings = d) => update.mock.calls[call]![0](from) as HubSettings;
  return { update, apply };
}

describe("WatchRulesSettings", () => {
  beforeEach(() => {
    ipc.hubRequest.mockReset().mockImplementation((m: string, p: string) => {
      if (m === "GET" && p === "/v1/watch") return Promise.resolve(structuredClone(OVERVIEW));
      return Promise.resolve({
        matches: [
          { id: "builtin.force-push", name: "Force push" },
          { id: "user.mine", name: "Mine" },
        ],
      });
    });
  });

  it("toggles the master switch and the built-in switches in the draft", async () => {
    const { apply } = renderBlock();
    fireEvent.click(screen.getByRole("checkbox", { name: "Watch what agents do" }));
    expect(apply(0).watch?.enabled).toBe(false);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Secret file" }));
    expect(apply(1).watch?.disabledBuiltins).toEqual(["builtin.secret-file"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Notify for rule: Irreversible git command" }));
    expect(apply(2).watch?.notifyOffBuiltins).toEqual(["builtin.git-discard"]);
  });

  it("adds a user rule only when it passes the checks", async () => {
    const { update, apply } = renderBlock();
    fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
    const editor = screen.getByRole("group", { name: "Add rule" });
    fireEvent.click(within(editor).getByRole("button", { name: "Save rule" }));
    expect(update).not.toHaveBeenCalled();
    expect(within(editor).getByText("Enter a name.")).toBeInTheDocument();

    fireEvent.change(within(editor).getByRole("textbox", { name: "Name" }), { target: { value: "Prod host" } });
    expect(within(editor).getByText("Fill in at least one of tools, command or paths.")).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole("button", { name: "Save rule" }));
    expect(update).not.toHaveBeenCalled();

    fireEvent.change(within(editor).getByRole("textbox", { name: /Command pattern/ }), { target: { value: "curl .*prod" } });
    fireEvent.change(within(editor).getByRole("textbox", { name: /Tools/ }), { target: { value: "Bash, WebFetch" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save rule" }));
    expect(apply().watch?.rules).toEqual([{ id: "user.prod-host", name: "Prod host", enabled: true, notify: true, tools: ["Bash", "WebFetch"], command: "curl .*prod" }]);
  });

  it("shows a regex hint but still allows saving", async () => {
    const { update } = renderBlock();
    fireEvent.click(await screen.findByRole("button", { name: "Add rule" }));
    const editor = screen.getByRole("group", { name: "Add rule" });
    fireEvent.change(within(editor).getByRole("textbox", { name: "Name" }), { target: { value: "x" } });
    fireEvent.change(within(editor).getByRole("textbox", { name: /Command pattern/ }), { target: { value: "(unclosed" } });
    expect(within(editor).getByText(/look like a valid regular expression/)).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole("button", { name: "Save rule" }));
    expect(update).toHaveBeenCalled();
  });

  it("edits and deletes a user rule", () => {
    const rule = { id: "user.a", name: "Alpha", enabled: true, notify: true, paths: ["**/.env"] };
    const { apply } = renderBlock(draft({ enabled: true, disabledBuiltins: [], notifyOffBuiltins: [], rules: [rule], trustedProjects: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    expect(apply().watch?.rules).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Edit Alpha" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Beta" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(apply(1).watch?.rules).toEqual([{ ...rule, name: "Beta" }]);
  });

  it("lists projects with rule counts and problems and trusts one", async () => {
    const { apply } = renderBlock();
    expect(await screen.findByText("2 rules")).toBeInTheDocument();
    expect(screen.getByText("Line 4: bad regex")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /C:\/src\/app/ }));
    expect(apply().watch?.trustedProjects).toEqual(["C:/src/app"]);
  });

  it("tries a command against the hub and lists the matching rules", async () => {
    renderBlock();
    fireEvent.change(await screen.findByRole("textbox", { name: "Command" }), { target: { value: "git push -f" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByTestId("watch-test-matches")).toBeInTheDocument());
    expect(ipc.hubRequest).toHaveBeenCalledWith("POST", "/v1/watch/test", { tool: "Bash", command: "git push -f" });
    const items = within(screen.getByTestId("watch-test-matches")).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual(["Force push", "Mine"]);
  });

  it("says so when nothing matches and when the test fails", async () => {
    renderBlock();
    ipc.hubRequest.mockImplementation(() => Promise.resolve({ matches: [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Test" }));
    expect(await screen.findByText("No rule matches.")).toBeInTheDocument();
    ipc.hubRequest.mockImplementation(() => Promise.reject({ code: "io", message: "boom" }));
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("The test could not run.")).toBeInTheDocument();
  });

  it("hides the details while watching is off", () => {
    renderBlock(draft({ enabled: false, disabledBuiltins: [], notifyOffBuiltins: [], rules: [], trustedProjects: [] }));
    expect(screen.queryByRole("button", { name: "Add rule" })).toBeNull();
  });
});
