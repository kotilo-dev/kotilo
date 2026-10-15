import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { strings } from "../../app/strings";
import type { AdapterDto } from "../../lib/hubTypes";
import { builtinDefinitions } from "../../test/builtinDefinitions";

const ipc = vi.hoisted(() => ({
  hubRequest: vi.fn(),
  hooksInstall: vi.fn(),
  hooksUninstall: vi.fn(),
  hooksStatus: vi.fn(),
  clipboardWriteText: vi.fn(),
  agentsDefinitions: vi.fn(),
  agentsDefinitionsReload: vi.fn(),
  agentsInstalled: vi.fn(),
  agentsSaveUserDefinition: vi.fn(),
  agentsDeleteUserDefinition: vi.fn(),
  settingsSet: vi.fn(),
}));
vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return { ...actual, ...ipc };
});

import { AgentsSection } from "./AgentsSection";
import { CustomAgentWizard } from "./CustomAgentWizard";
import { resetDefinitionsStoreForTests, useDefinitionsStore } from "../../stores/definitionsStore";
import { DEFAULT_SETTINGS, hydrateSettingsStore, resetSettingsStoreForTest } from "../../stores/settingsStore";
import { useToastStore } from "../../stores/toastStore";

const a = strings.agentSetup;
const w = a.wizard;
const defs = builtinDefinitions();
const user = { ...defs.find((d) => d.id === "cursor")!, id: "my-agent", displayName: "My Agent", source: "user" as const, avatar: { letter: "M", bg: "#1c262e", ink: "#86c8f0" } };

function dto(id: string, patch: Partial<AdapterDto> = {}): AdapterDto {
  const def = defs.find((d) => d.id === id);
  return {
    id,
    displayName: def?.displayName ?? id,
    source: "builtIn",
    // The desktop shape is close enough to the hub's for these cards.
    definition: def ? ({ ...def } as unknown as AdapterDto["definition"]) : null,
    hooks: { state: "installed", configPath: `C:/u/${id}.json`, needsApproval: false, hint: null },
    error: null,
    ...patch,
  };
}

const ADAPTERS: AdapterDto[] = [
  dto("claude-code"),
  dto("gemini", { hooks: { state: "installed", configPath: "C:/u/.gemini/settings.json", needsApproval: false, hint: "folderTrust" } }),
  dto("qwen", { hooks: { state: "outdated", configPath: "C:/u/.qwen/settings.json", needsApproval: false, hint: "hooksDisabled" } }),
  dto("cursor"),
  { ...dto("my-agent"), displayName: "My Agent", source: "user", definition: null, hooks: null },
  { id: "broken", displayName: "", source: "user", definition: null, hooks: null, error: "Not valid JSON: 'x' is invalid" },
];

function routeHub(method: string, path: string): Promise<unknown> {
  if (method === "GET" && path === "/v1/adapters") return Promise.resolve(ADAPTERS);
  if (method === "POST" && path === "/v1/adapters/reload") return Promise.resolve(ADAPTERS);
  return Promise.reject({ code: "not_found", message: path });
}

beforeEach(() => {
  resetSettingsStoreForTest();
  hydrateSettingsStore(DEFAULT_SETTINGS);
  useDefinitionsStore.setState({ loaded: true, definitions: [...defs, user], errors: [], installed: ["claude-code", "my-agent"] });
  for (const fn of Object.values(ipc)) fn.mockReset();
  ipc.hubRequest.mockImplementation(routeHub);
  ipc.hooksInstall.mockResolvedValue(undefined);
  ipc.agentsInstalled.mockResolvedValue(["claude-code"]);
  ipc.clipboardWriteText.mockResolvedValue(undefined);
  ipc.agentsDefinitionsReload.mockResolvedValue({ definitions: defs, errors: [] });
  ipc.agentsSaveUserDefinition.mockResolvedValue({ definitions: [...defs, user], errors: [] });
  ipc.agentsDeleteUserDefinition.mockResolvedValue({ definitions: defs, errors: [] });
});
afterEach(() => resetDefinitionsStoreForTests());

describe("Settings → Agents", () => {
  it("shows one card per adapter: hook states and hints, protocol and invalid files", async () => {
    render(<AgentsSection />);
    expect(await screen.findByText("Gemini CLI")).toBeInTheDocument();
    expect(screen.getByText(a.hints.folderTrust)).toBeInTheDocument();
    expect(screen.getByText(a.hints.hooksDisabled)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: a.repair })).toBeInTheDocument();
    // Cursor, and Claude Code's screen safety net (0.3.2).
    expect(screen.getAllByText(a.screenPermission).length).toBeGreaterThanOrEqual(1);
    // Protocol adapter: snippet + edit/delete.
    expect(screen.getByText("kotilo-hook --agent my-agent --event working")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: a.edit })).toBeInTheDocument();
    // Invalid user file: its error and a delete button, no edit.
    expect(screen.getByText("Not valid JSON: 'x' is invalid")).toBeInTheDocument();
    expect(screen.getAllByText(a.invalid)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: a.delete })).toHaveLength(2);
    // PATH check from the desktop.
    expect(screen.getAllByText(new RegExp(a.notInstalled)).length).toBeGreaterThan(0);
  });

  it("reload re-reads the desktop definitions and the hub's", async () => {
    const show = vi.spyOn(useToastStore.getState(), "show");
    render(<AgentsSection />);
    await screen.findByText("Gemini CLI");
    fireEvent.click(screen.getByRole("button", { name: a.reload }));
    await waitFor(() => expect(ipc.agentsDefinitionsReload).toHaveBeenCalled());
    await waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledWith("POST", "/v1/adapters/reload"));
    await waitFor(() => expect(show).toHaveBeenCalledWith(a.reloaded));
  });

  it("deletes a user adapter after confirming", async () => {
    render(<AgentsSection />);
    await screen.findByText("My Agent");
    fireEvent.click(screen.getAllByRole("button", { name: a.delete })[0]!);
    const deletes = screen.getAllByRole("button", { name: a.delete });
    fireEvent.click(deletes[deletes.length - 1]!);
    await waitFor(() => expect(ipc.agentsDeleteUserDefinition).toHaveBeenCalledWith("my-agent"));
  });

  it("installs a hook integration through the hub", async () => {
    ipc.hubRequest.mockImplementation((m: string, p: string) =>
      p === "/v1/adapters" ? Promise.resolve([dto("copilot", { hooks: { state: "missing", configPath: null, needsApproval: false, hint: null } })]) : routeHub(m, p),
    );
    render(<AgentsSection />);
    fireEvent.click(await screen.findByRole("button", { name: strings.settingsPage.agents.install }));
    await waitFor(() => expect(ipc.hooksInstall).toHaveBeenCalledWith("copilot"));
  });
});

describe("CustomAgentWizard", () => {
  const props = { editing: null, builtinIds: ["claude-code", "codex"], userIds: ["taken"], onClose: vi.fn() };

  it("blocks Next until the step is valid, then walks to the snippet and saves", async () => {
    render(<CustomAgentWizard {...props} />);
    fireEvent.click(screen.getByRole("button", { name: w.next }));
    expect(screen.getAllByText(w.errors.required).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(w.id), { target: { value: "codex" } });
    expect(screen.getByText(w.errors.idBuiltIn)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(w.id), { target: { value: "my-agent" } });
    fireEvent.change(screen.getByLabelText(w.displayName), { target: { value: "My Agent" } });
    expect(screen.getByLabelText(w.letter)).toHaveValue("M");
    fireEvent.click(screen.getByRole("radio", { name: w.colors.green }));
    fireEvent.click(screen.getByRole("button", { name: w.next }));

    fireEvent.change(screen.getByLabelText(w.command), { target: { value: "my-agent" } });
    expect(screen.getByLabelText(w.executables)).toHaveValue("my-agent.exe, my-agent.cmd, my-agent");
    fireEvent.click(screen.getByRole("button", { name: w.next }));

    fireEvent.change(screen.getByLabelText(w.allowOnce), { target: { value: "y" } });
    fireEvent.click(screen.getByRole("button", { name: w.next }));
    expect(screen.getByText(w.errors.keyPair)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(w.deny), { target: { value: "n" } });
    fireEvent.click(screen.getByRole("button", { name: w.next }));

    fireEvent.click(screen.getByRole("button", { name: w.addRule }));
    fireEvent.change(screen.getByLabelText(w.pattern), { target: { value: "(?<=x)y" } });
    fireEvent.click(screen.getByRole("button", { name: w.next }));
    expect(screen.getByText(w.errors.unsupported)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(w.pattern), { target: { value: "Allow\\? \\(y/n\\)" } });
    fireEvent.click(screen.getByRole("button", { name: w.next }));

    expect(screen.getByLabelText("kotilo-hook")).toHaveTextContent("kotilo-hook --agent my-agent --event working");
    expect(screen.getByLabelText("POST /v1/events")).toHaveTextContent('"agent":"my-agent"');
    fireEvent.click(screen.getByRole("button", { name: `${a.copy}: kotilo-hook` }));
    expect(ipc.clipboardWriteText).toHaveBeenCalledWith(expect.stringContaining("--agent my-agent"));

    fireEvent.click(screen.getByRole("button", { name: w.save }));
    await waitFor(() => expect(ipc.agentsSaveUserDefinition).toHaveBeenCalled());
    const [def, overwrite] = ipc.agentsSaveUserDefinition.mock.calls[0]!;
    expect(overwrite).toBe(false);
    expect(def).toMatchObject({
      id: "my-agent",
      avatar: { letter: "M", bg: "#1d2a26", ink: "#8fe0b6" },
      launch: { command: "my-agent", args: [] },
      permissionKeys: { allowOnce: "y", deny: "n" },
      screenRules: [{ id: "rule-1", state: "waitingPermission", pattern: "Allow\\? \\(y/n\\)" }],
    });
    await waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledWith("POST", "/v1/adapters/reload"));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("edits an existing adapter with overwrite and a fixed id", async () => {
    const { source: _s, ...editing } = user;
    render(<CustomAgentWizard {...props} editing={editing} userIds={["my-agent"]} initialStep="finish" />);
    expect(screen.queryByRole("textbox", { name: w.id })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: w.save }));
    await waitFor(() => expect(ipc.agentsSaveUserDefinition).toHaveBeenCalledWith(expect.objectContaining({ id: "my-agent", screenRules: user.screenRules }), true));
  });

  it("shows the desktop's refusal and stays open", async () => {
    ipc.agentsSaveUserDefinition.mockRejectedValue({ code: "already_exists", message: "a custom agent with the id 'my-agent' already exists" });
    const { source: _s, ...editing } = user;
    const onClose = vi.fn();
    render(<CustomAgentWizard {...props} editing={editing} onClose={onClose} initialStep="finish" />);
    fireEvent.click(screen.getByRole("button", { name: w.save }));
    expect(await screen.findByText(w.saveFailed("a custom agent with the id 'my-agent' already exists"))).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lists the steps with the current one marked", () => {
    render(<CustomAgentWizard {...props} initialStep="rules" />);
    const steps = screen.getByRole("list", { name: w.stepsLabel });
    expect(within(steps).getByText(w.steps.rules).closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByText(w.noRules)).toBeInTheDocument();
  });
});
