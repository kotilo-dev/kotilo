import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, SavedPrompt } from "../../lib/ipc";

const ipc = vi.hoisted(() => ({ ptyWrite: vi.fn() }));
vi.mock("../../lib/ipc", async (importOriginal) => ({ ...(await importOriginal<object>()), ...ipc }));
const shell = vi.hoisted(() => ({ spawnTerminal: vi.fn(() => "new-tab") }));
vi.mock("../terminal/defaultShell", () => shell);
vi.mock("../terminal/terminalRegistry", () => ({ focusTerminal: vi.fn() }));

import { useAgentStore } from "../../stores/agentStore";
import { useHubStore } from "../../stores/hubStore";
import { useTerminalStore, type TerminalTab } from "../../stores/terminalStore";
import { useToastStore } from "../../stores/toastStore";
import { useComposerInbox } from "../composer/composerInbox";
import { agentTabFor, runQuickCommand, shellTabFor } from "./quickCommandActions";

const tab = (id: string, extra: Partial<TerminalTab> = {}): TerminalTab => ({
  id,
  title: id,
  profileId: null,
  cwdRel: "",
  agentCommand: null,
  status: "running",
  paneId: `pane-${id}`,
  titleEdited: false,
  ...extra,
});

const agentOn = (paneId: string): Agent => ({ id: paneId, paneId, workspaceId: "ws", kind: "claude", state: "idle", sinceMs: 0, source: "hook", sessionId: null });

function setTabs(tabs: TerminalTab[], activeTabId: string) {
  useTerminalStore.setState({ byWorkspace: { ws: { tabs, activeTabId } } });
}

const command: SavedPrompt = { id: "c", title: "Test", text: "npm test\n-- --watch", kind: "command" };
const prompt: SavedPrompt = { id: "p", title: "Review", text: "Review the diff" };

beforeEach(() => {
  vi.clearAllMocks();
  ipc.ptyWrite.mockResolvedValue(undefined);
  useAgentStore.setState({ agents: [] });
  useHubStore.setState({ sessions: [] });
  useComposerInbox.setState({ pending: {} });
});

describe("quick command targets", () => {
  it("types a command into the current plain shell, on one line with Enter", async () => {
    setTabs([tab("a"), tab("b")], "b");
    await runQuickCommand(command, "ws");
    expect(ipc.ptyWrite).toHaveBeenCalledWith("pane-b", "npm test -- --watch\r");
    expect(shell.spawnTerminal).not.toHaveBeenCalled();
  });

  it("starts a command in a new tab when an agent runs in the current one", async () => {
    setTabs([tab("a")], "a");
    useAgentStore.setState({ agents: [agentOn("pane-a")] });
    expect(shellTabFor("ws")).toBeNull();
    await runQuickCommand(command, "ws");
    expect(ipc.ptyWrite).not.toHaveBeenCalled();
    expect(shell.spawnTerminal).toHaveBeenCalledWith("ws", "npm test -- --watch");
  });

  it("starts a command in a new tab when the current shell has exited", async () => {
    setTabs([tab("a", { status: "exited" })], "a");
    await runQuickCommand(command, "ws");
    expect(shell.spawnTerminal).toHaveBeenCalledWith("ws", "npm test -- --watch");
  });

  it("hands a prompt to the current agent's composer, else to the workspace's first agent", async () => {
    setTabs([tab("shell"), tab("agent")], "shell");
    useAgentStore.setState({ agents: [agentOn("pane-agent")] });
    expect(agentTabFor("ws")?.id).toBe("agent");
    await runQuickCommand(prompt, "ws");
    expect(useComposerInbox.getState().pending).toEqual({ "pane-agent": "Review the diff" });
    expect(ipc.ptyWrite).not.toHaveBeenCalled();
  });

  it("says so when no agent can take a prompt", async () => {
    setTabs([tab("shell")], "shell");
    const show = vi.spyOn(useToastStore.getState(), "show");
    await runQuickCommand(prompt, "ws");
    expect(show).toHaveBeenCalledTimes(1);
    expect(useComposerInbox.getState().pending).toEqual({});
  });
});
