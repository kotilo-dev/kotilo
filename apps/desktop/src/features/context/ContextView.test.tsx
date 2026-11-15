import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextReport } from "../../lib/ipc";

const ipc = vi.hoisted(() => ({
  contextAgents: vi.fn(),
  contextReport: vi.fn(),
  contextRead: vi.fn(),
  openExternalUrl: vi.fn(),
  clipboardWriteText: vi.fn(),
  onHubEvent: vi.fn(() => Promise.resolve(() => {})),
  onHubStatus: vi.fn(() => Promise.resolve(() => {})),
  onFsChanged: vi.fn(() => Promise.resolve(() => {})),
  onFsRescan: vi.fn(() => Promise.resolve(() => {})),
  onWorkspacesChanged: vi.fn(() => Promise.resolve(() => {})),
  saveStateSlice: vi.fn(() => Promise.resolve()),
  toAppError: (e: unknown) => e,
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
  return { useTerminalStore: create(() => ({ byWorkspace: {} })) };
});

import { resetContextStoreForTests } from "../../stores/contextStore";
import { useViewerStore } from "../../stores/viewerStore";
import { ContextView } from "./ContextView";

const report: ContextReport = {
  agent: "codex",
  supported: true,
  root: "C:\\src\\app",
  files: [
    { kind: "instruction", scope: "user", path: "C:\\Users\\demo\\.codex\\AGENTS.md", display: "~/.codex/AGENTS.md", rel: null, bytes: 2_000, tokens: 500, loaded: "always", importedBy: null, overLimit: false, error: null },
    { kind: "instruction", scope: "project", path: "C:\\src\\app\\AGENTS.md", display: "AGENTS.md", rel: "AGENTS.md", bytes: 38_912, tokens: 9_728, loaded: "always", importedBy: null, overLimit: true, error: null },
  ],
  skills: [{ scope: "project", name: "db-migrate", description: "Writes a migration.", path: "C:\\src\\app\\.agents\\skills\\db-migrate\\SKILL.md", display: ".agents/skills/db-migrate/SKILL.md", rel: ".agents/skills/db-migrate/SKILL.md", tokens: 12 }],
  mcp: [
    { name: "context7", scope: "user", source: "~/.codex/config.toml", transport: "http", command: null, argCount: 0, url: "https://mcp.context7.com", secretKeys: ["http_headers.KEY", "env.TOKEN"], disabled: false, shadowedBy: null },
    { name: "old", scope: "user", source: "~/.codex/config.toml", transport: "stdio", command: "node", argCount: 1, url: null, secretKeys: [], disabled: true, shadowedBy: null },
  ],
  sources: [
    { scope: "user", path: "C:\\Users\\demo\\.codex\\config.toml", display: "~/.codex/config.toml", exists: true, error: null, serverCount: 2 },
    { scope: "project", path: "C:\\src\\app\\.codex\\config.toml", display: ".codex/config.toml", exists: false, error: null, serverCount: 0 },
  ],
  maxBytes: 32_768,
  totals: { alwaysTokens: 10_228, onDemandTokens: 0, skillTokens: 12, alwaysBytes: 40_912 },
};

beforeEach(() => {
  resetContextStoreForTests();
  useViewerStore.setState({ byWorkspace: {} });
  ipc.contextAgents.mockReset().mockResolvedValue([
    { id: "claude-code", displayName: "Claude Code", supported: true },
    { id: "codex", displayName: "Codex CLI", supported: true },
    { id: "acme", displayName: "Acme", supported: false },
  ]);
  ipc.contextReport.mockReset().mockImplementation((_ws: string, agent: string) =>
    Promise.resolve(agent === "codex" ? report : { ...report, agent, supported: false, files: [], skills: [], mcp: [], sources: [] }),
  );
  ipc.contextRead.mockReset().mockResolvedValue({ text: "# User notes\n\nKeep it short.", truncated: true });
});

describe("ContextView", () => {
  it("shows totals, sections, badges and MCP servers without secret values", async () => {
    render(<ContextView workspaceId="ws1" agent="codex" />);
    expect(await screen.findByText("≈ 10k tokens always loaded")).toBeInTheDocument();
    expect(screen.getByText(/MCP tool definitions are not counted\. This agent reads at most 32 KB/)).toBeInTheDocument();
    expect(ipc.contextReport).toHaveBeenCalledWith("ws1", "codex");

    const always = screen.getByTestId("context-section-always");
    expect(within(always).getAllByTestId("context-file").map((li) => li.dataset.path)).toEqual(["~/.codex/AGENTS.md", "AGENTS.md"]);
    expect(within(always).getByText("over limit")).toHaveAttribute("title", "Past the 32 KB limit: the agent cuts this file off or skips it.");
    expect(within(screen.getByTestId("context-section-onDemand")).getByText("None found.")).toBeInTheDocument();
    expect(screen.queryByTestId("context-section-rules")).toBeNull();

    const secrets = screen.getByTestId("context-secrets");
    expect(secrets).toHaveTextContent("2 hidden secrets");
    expect(secrets).toHaveAttribute("title", "Values never leave the config file: http_headers.KEY, env.TOKEN");
    expect(screen.getByText("https://mcp.context7.com")).toBeInTheDocument();
    expect(screen.getByText("node · 1 arg")).toBeInTheDocument();
    expect(screen.getByText("disabled")).toBeInTheDocument();
    expect(within(screen.getByTestId("context-sources")).getByText("not found")).toBeInTheDocument();

    // The agent picker lists supported agents only.
    const picker = screen.getByRole("combobox", { name: "Agent" });
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["Claude Code", "Codex CLI"]);
  });

  it("previews a file outside the workspace and opens one inside in the viewer", async () => {
    useViewerStore.getState().openContext("ws1", "codex");
    render(<ContextView workspaceId="ws1" agent="codex" />);
    fireEvent.click(await screen.findByRole("button", { name: "Preview ~/.codex/AGENTS.md" }));
    const preview = await screen.findByTestId("context-preview");
    expect(await within(preview).findByRole("heading", { name: "User notes" })).toBeInTheDocument();
    expect(within(preview).getByText("Only the first 256 KB are shown.")).toBeInTheDocument();
    expect(ipc.contextRead).toHaveBeenCalledWith("ws1", "codex", "C:\\Users\\demo\\.codex\\AGENTS.md");
    fireEvent.click(within(preview).getByRole("button", { name: "Close preview" }));
    expect(screen.queryByTestId("context-preview")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open .agents/skills/db-migrate/SKILL.md" }));
    const tabs = useViewerStore.getState().byWorkspace.ws1!.tabs;
    expect(tabs.map((t) => t.rel)).toEqual(["", ".agents/skills/db-migrate/SKILL.md"]);
    expect(ipc.contextRead).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state for an agent without context data", async () => {
    render(<ContextView workspaceId="ws1" agent="acme" />);
    expect(await screen.findByTestId("context-unsupported")).toHaveTextContent("No context data for Acme");
    // The current (unsupported) agent stays selectable in the picker.
    expect(screen.getByRole("combobox", { name: "Agent" })).toHaveValue("acme");
  });
});
