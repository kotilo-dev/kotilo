import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationComposerResult, Settings } from "../../lib/ipc";

const ipc = vi.hoisted(() => ({
  clipboardSaveImage: vi.fn(),
  dictationStartComposer: vi.fn(),
  dictationStopComposer: vi.fn(),
  fsCreateDir: vi.fn(),
  fsQuickOpen: vi.fn(),
  onDictationComposer: vi.fn(),
  ptyWrite: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
  isAppError: (e: unknown, code?: string) =>
    typeof e === "object" && e !== null && "code" in e && (code === undefined || (e as { code: string }).code === code),
  toAppError: (e: unknown) =>
    typeof e === "object" && e !== null && "code" in e ? e : { code: "io", message: String(e) },
}));
vi.mock("../../lib/ipc", () => ipc);

const registry = vi.hoisted(() => ({ bracketedPasteMode: vi.fn(), focusTerminal: vi.fn() }));
vi.mock("../terminal/terminalRegistry", () => registry);

import { DEFAULT_SETTINGS, resetSettingsStoreForTest, useSettingsStore } from "../../stores/settingsStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { Composer } from "./Composer";

let dictationHandler: ((r: DictationComposerResult) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  resetSettingsStoreForTest();
  useSettingsStore.setState({ ready: true });
  dictationHandler = undefined;
  ipc.onDictationComposer.mockImplementation((h: (r: DictationComposerResult) => void) => {
    dictationHandler = h;
    return Promise.resolve(() => {});
  });
  ipc.ptyWrite.mockResolvedValue(undefined);
  ipc.fsCreateDir.mockResolvedValue("");
  ipc.dictationStartComposer.mockResolvedValue(undefined);
  ipc.dictationStopComposer.mockResolvedValue(undefined);
  ipc.settingsSet.mockImplementation((s: Settings) => Promise.resolve(s));
  ipc.fsQuickOpen.mockResolvedValue({ items: [{ rel: "src/approval.ts", score: 1, indices: [] }], truncated: false });
  registry.bracketedPasteMode.mockReturnValue(true);
});

function renderComposer() {
  render(<Composer workspaceId="ws1" tabId="t1" paneId="p1" agentName="Claude Code" />);
  return screen.getByRole("textbox", { name: "Message Claude Code" }) as HTMLTextAreaElement;
}

function type(input: HTMLTextAreaElement, value: string) {
  fireEvent.change(input, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
}

describe("Composer", () => {
  it("Enter sends one bracketed paste and then Enter to the pane", async () => {
    const input = renderComposer();
    type(input, "fix the test");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(ipc.ptyWrite).toHaveBeenCalledTimes(2));
    expect(ipc.ptyWrite).toHaveBeenNthCalledWith(1, "p1", "\x1b[200~fix the test\x1b[201~");
    expect(ipc.ptyWrite).toHaveBeenNthCalledWith(2, "p1", "\r");
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("Shift+Enter does not send; Escape hands focus back to the terminal", () => {
    const input = renderComposer();
    type(input, "line one");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(ipc.ptyWrite).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(registry.focusTerminal).toHaveBeenCalledWith("t1");
  });

  it("asks before sending several lines to a program without bracketed paste", async () => {
    registry.bracketedPasteMode.mockReturnValue(false);
    const input = renderComposer();
    type(input, "one\ntwo");
    fireEvent.click(screen.getByRole("button", { name: "Send (Enter)" }));
    expect(ipc.ptyWrite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    await waitFor(() => expect(ipc.ptyWrite).toHaveBeenCalledTimes(2));
    expect(ipc.ptyWrite).toHaveBeenNthCalledWith(1, "p1", "one\rtwo");
  });

  it("suggests files after @ and inserts the chosen one", async () => {
    const input = renderComposer();
    type(input, "look at @appr");
    const option = await screen.findByRole("option", { name: "src/approval.ts" });
    expect(ipc.fsQuickOpen).toHaveBeenCalledWith("ws1", "appr", 8);
    expect(option).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("look at @src/approval.ts ");
    expect(ipc.ptyWrite).not.toHaveBeenCalled();
  });

  it("dictation: the mic starts and stops; only this pane's text is inserted", async () => {
    const input = renderComposer();
    type(input, "please");
    fireEvent.click(screen.getByRole("button", { name: "Dictate into the message" }));
    expect(ipc.dictationStartComposer).toHaveBeenCalledWith("p1");
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(ipc.dictationStopComposer).toHaveBeenCalled();
    await waitFor(() => expect(dictationHandler).toBeDefined());
    act(() => dictationHandler!({ paneId: "other", text: "ignored", cleaned: false }));
    expect(input.value).toBe("please");
    act(() => dictationHandler!({ paneId: "p1", text: "run the tests", cleaned: true }));
    expect(input.value).toBe("please run the tests");
    expect(screen.getByRole("button", { name: "Dictate into the message" })).toBeEnabled();
  });

  it("dictation errors are shown, a cancel is not", async () => {
    renderComposer();
    await waitFor(() => expect(dictationHandler).toBeDefined());
    act(() => dictationHandler!({ paneId: "p1", error: "cancelled" }));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => dictationHandler!({ paneId: "p1", error: "noMicrophone" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Could not open the microphone");
  });

  it("a pasted image becomes an @path chip in .kotilo/attachments with a one-time hint", async () => {
    ipc.clipboardSaveImage.mockResolvedValue(".kotilo/attachments/screenshot-1.png");
    ipc.fsCreateDir.mockRejectedValueOnce({ code: "already_exists", message: "exists" });
    const input = renderComposer();
    fireEvent.paste(input, { clipboardData: { items: [{ kind: "file", type: "image/png" }] } });
    expect(await screen.findByText("@screenshot-1.png")).toBeInTheDocument();
    expect(ipc.fsCreateDir).toHaveBeenNthCalledWith(1, "ws1", "", ".kotilo");
    expect(ipc.fsCreateDir).toHaveBeenNthCalledWith(2, "ws1", ".kotilo", "attachments");
    expect(ipc.clipboardSaveImage).toHaveBeenCalledWith("ws1", ".kotilo/attachments");
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(useSettingsStore.getState().settings.composer?.attachmentsHintShown).toBe(true);

    type(input, "what is this?");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(ipc.ptyWrite).toHaveBeenCalledTimes(2));
    expect(ipc.ptyWrite).toHaveBeenNthCalledWith(1, "p1", "\x1b[200~what is this? @.kotilo/attachments/screenshot-1.png\x1b[201~");
    await waitFor(() => expect(screen.queryByText("@screenshot-1.png")).toBeNull());
  });

  it("text paste stays a normal paste", () => {
    const input = renderComposer();
    fireEvent.paste(input, { clipboardData: { items: [{ kind: "string", type: "text/plain" }] } });
    expect(ipc.clipboardSaveImage).not.toHaveBeenCalled();
  });

  it("saved prompts: save the message, insert it, delete it", () => {
    const input = renderComposer();
    type(input, "Review the diff carefully");
    fireEvent.click(screen.getByRole("button", { name: "Saved prompts" }));
    fireEvent.click(screen.getByRole("button", { name: "Save message as prompt" }));
    const saved = useSettingsStore.getState().settings.composer!.savedPrompts;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: "Review the diff carefully", text: "Review the diff carefully" });

    type(input, "");
    fireEvent.click(screen.getByRole("button", { name: /^Review the diff carefully/ }));
    expect(input.value).toBe("Review the diff carefully");

    fireEvent.click(screen.getByRole("button", { name: "Saved prompts" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete “Review the diff carefully”" }));
    expect(useSettingsStore.getState().settings.composer!.savedPrompts).toEqual([]);
    expect(screen.getByText(/No saved prompts yet/)).toBeInTheDocument();
  });

  it("lists only prompts for this workspace, not shell commands (D-069)", () => {
    useWorkspaceStore.setState({ workspaces: [{ id: "ws1", name: "app", path: "C:\\src\\app", expandedDirs: [] }] });
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        composer: {
          attachmentsHintShown: false,
          savedPrompts: [
            { id: "g", title: "Global prompt", text: "g" },
            { id: "c", title: "Run tests", text: "npm test", kind: "command" },
            { id: "o", title: "Other project", text: "o", project: "C:\\src\\other" },
            { id: "h", title: "This project", text: "h", project: "c:/src/app/" },
          ],
        },
      },
    });
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Saved prompts" }));
    expect(screen.getByRole("button", { name: /^Global prompt/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^This project/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Run tests/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Other project/ })).toBeNull();
  });

  it("starts from settings without a composer section", () => {
    const { composer: _omit, ...rest } = DEFAULT_SETTINGS;
    useSettingsStore.setState({ settings: rest as Settings });
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Saved prompts" }));
    expect(screen.getByText(/No saved prompts yet/)).toBeInTheDocument();
  });
});
