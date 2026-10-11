import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssistantView } from "./AssistantView";
import type { AssistantEvent, AssistantInfo, AssistantMessage } from "./assistantIpc";

const ipc = vi.hoisted(() => ({
  assistantInfo: vi.fn(),
  assistantChat: vi.fn(),
  assistantStop: vi.fn(),
  assistantHide: vi.fn(),
  requestAiSettings: vi.fn(),
  onAssistantOpened: vi.fn(),
  onAssistantClosed: vi.fn(),
}));
vi.mock("./assistantIpc", () => ipc);
const clipboard = vi.hoisted(() => ({ clipboardWriteText: vi.fn(), openExternalUrl: vi.fn() }));
vi.mock("../../lib/ipc", async () => ({ ...(await vi.importActual<object>("../../lib/ipc")), ...clipboard }));

const INFO: AssistantInfo = { enabled: true, provider: "cli:claude-code", providerLabel: "Claude Code", model: "haiku", ephemeral: true, available: true, unavailableReason: null };

let pushEvent: (e: AssistantEvent) => void = () => {};
let opened: () => void = () => {};
let finishChat: () => void = () => {};

function input() {
  return screen.getByRole("textbox", { name: "Message" });
}

async function renderView(info: AssistantInfo = INFO) {
  ipc.assistantInfo.mockResolvedValue(info);
  render(<AssistantView />);
  await act(async () => {});
}

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}

function press(key: string, init: Partial<KeyboardEventInit> = {}, target: Element = input()) {
  fireEvent.keyDown(target, { key, ...init });
}

describe("AssistantView", () => {
  beforeEach(() => {
    for (const fn of [...Object.values(ipc), ...Object.values(clipboard)]) fn.mockReset().mockResolvedValue(undefined);
    ipc.assistantChat.mockImplementation((_messages: AssistantMessage[], onEvent: (e: AssistantEvent) => void) => {
      pushEvent = (e) => act(() => onEvent(e));
      return new Promise<void>((resolve) => {
        finishChat = resolve;
      });
    });
    ipc.onAssistantOpened.mockImplementation((h: () => void) => {
      opened = () => act(() => h());
      return Promise.resolve(() => {});
    });
    ipc.onAssistantClosed.mockResolvedValue(() => {});
  });

  it("shows provider and model, streams an answer and finishes", async () => {
    await renderView();
    expect(screen.getByTestId("assistant-provider")).toHaveTextContent("Claude Code · haiku");
    type("What is 2+2?");
    press("Enter");
    expect(ipc.assistantChat).toHaveBeenCalledWith([{ role: "user", text: "What is 2+2?" }], expect.any(Function));
    expect(input()).toHaveValue("");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByTestId("assistant-typing")).toBeInTheDocument();

    pushEvent({ type: "text", text: "It is" });
    pushEvent({ type: "text", text: "It is **4**." });
    expect(screen.getByText("4").tagName).toBe("STRONG");
    pushEvent({ type: "done", errorKind: "none" });
    finishChat();
    expect(screen.queryByTestId("assistant-typing")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    expect(clipboard.clipboardWriteText).toHaveBeenCalledWith("It is **4**.");
  });

  it("sends the whole conversation on the next turn and copies code blocks", async () => {
    await renderView();
    type("q1");
    press("Enter");
    pushEvent({ type: "text", text: "```js\nconst a = 1;\n```" });
    pushEvent({ type: "done", errorKind: "none" });
    type("q2");
    press("Enter");
    expect(ipc.assistantChat).toHaveBeenLastCalledWith(
      [
        { role: "user", text: "q1" },
        { role: "assistant", text: "```js\nconst a = 1;\n```" },
        { role: "user", text: "q2" },
      ],
      expect.any(Function),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(clipboard.clipboardWriteText).toHaveBeenCalledWith("const a = 1;");
  });

  it("Shift+Enter doesn't send; Esc stops a running answer, then closes", async () => {
    await renderView();
    type("hello");
    press("Enter", { shiftKey: true });
    expect(ipc.assistantChat).not.toHaveBeenCalled();
    press("Enter");
    press("Escape");
    expect(ipc.assistantStop).toHaveBeenCalledTimes(1);
    expect(ipc.assistantHide).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    pushEvent({ type: "text", text: "half" });
    // Rust sends no `done` after a stop: the resolved stop ends the turn.
    await act(async () => {});
    expect(screen.getByText("Stopped.")).toBeInTheDocument();
    expect(screen.getByText("half")).toBeInTheDocument();
    press("Escape", {}, document.body);
    expect(ipc.assistantHide).toHaveBeenCalledTimes(1);
  });

  it("↑ in an empty composer puts the last question back and drops its turn", async () => {
    await renderView();
    type("first");
    press("Enter");
    pushEvent({ type: "text", text: "answer" });
    pushEvent({ type: "done", errorKind: "none" });
    expect(screen.getAllByTestId("assistant-turn")).toHaveLength(1);
    press("ArrowUp");
    expect(input()).toHaveValue("first");
    expect(screen.queryAllByTestId("assistant-turn")).toHaveLength(0);
  });

  it("shows turn errors inline with the Settings → AI hint", async () => {
    await renderView();
    type("hi");
    press("Enter");
    pushEvent({ type: "done", errorKind: "notInstalled" });
    expect(screen.getByRole("alert")).toHaveTextContent("isn't installed");
    fireEvent.click(screen.getByRole("button", { name: "Settings → AI" }));
    expect(ipc.assistantHide).toHaveBeenCalled();
    expect(ipc.requestAiSettings).toHaveBeenCalled();

    type("again");
    press("Enter");
    pushEvent({ type: "done", errorKind: "weird", error: "exit code 7" });
    expect(screen.getAllByRole("alert")[1]).toHaveTextContent("Something went wrong: exit code 7");
    expect(screen.getAllByRole("button", { name: "Settings → AI" })).toHaveLength(1);
  });

  it("an error after partial text keeps the text and shows the error on that turn", async () => {
    await renderView();
    type("hi");
    press("Enter");
    pushEvent({ type: "text", text: "Partial answer" });
    pushEvent({ type: "done", errorKind: "timeout" });
    expect(screen.getByText("Partial answer")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("took too long");
    expect(screen.queryByRole("button", { name: "Settings → AI" })).toBeNull();
  });

  it("a failed invoke becomes an error turn", async () => {
    ipc.assistantChat.mockRejectedValueOnce({ code: "io", message: "hub unreachable" });
    await renderView();
    type("hi");
    press("Enter");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong: hub unreachable"));
  });

  it("Ctrl+N and assistant:opened start a new chat", async () => {
    await renderView();
    type("one");
    press("Enter");
    pushEvent({ type: "text", text: "a" });
    pushEvent({ type: "done", errorKind: "none" });
    press("n", { ctrlKey: true }, document.body);
    expect(screen.queryAllByTestId("assistant-turn")).toHaveLength(0);

    type("two");
    press("Enter");
    opened();
    expect(ipc.assistantStop).toHaveBeenCalledTimes(1); // the running answer is stopped
    expect(screen.queryAllByTestId("assistant-turn")).toHaveLength(0);
    // Events of the dropped chat are ignored.
    pushEvent({ type: "text", text: "late" });
    expect(screen.queryByText("late")).toBeNull();
  });

  it.each([
    [true, "ephemeral", null],
    [false, "keeps", "Claude Code keeps its own copy of this chat in its session files."],
    [null, "mayKeep", "Claude Code may keep its own copy of this chat."],
  ] as const)("footer for ephemeral=%s", async (ephemeral, variant, note) => {
    await renderView({ ...INFO, ephemeral });
    const footer = screen.getByTestId("assistant-footer");
    expect(footer).toHaveAttribute("data-variant", variant);
    expect(footer).toHaveTextContent("Nothing is saved · tools off · sent to Claude Code");
    if (note) expect(footer).toHaveTextContent(note);
    else expect(footer.textContent).not.toContain("copy");
  });

  it("the stream's meta replaces the header and footer", async () => {
    await renderView();
    type("hi");
    press("Enter");
    pushEvent({ type: "meta", provider: "openai:ollama", providerLabel: "ollama", model: "llama3", ephemeral: true });
    expect(screen.getByTestId("assistant-provider")).toHaveTextContent("ollama · llama3");
    expect(screen.getByTestId("assistant-footer")).toHaveTextContent("sent to ollama");
  });

  it("shows the empty state when the assistant is off or unavailable", async () => {
    await renderView({ ...INFO, enabled: false });
    expect(screen.getByTestId("assistant-unavailable")).toHaveTextContent("The assistant is off");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("maps a known unavailable reason", async () => {
    await renderView({ ...INFO, available: false, unavailableReason: "notInstalled" });
    expect(screen.getByTestId("assistant-unavailable")).toHaveTextContent("isn't installed");
    fireEvent.click(screen.getByRole("button", { name: "Settings → AI" }));
    expect(ipc.requestAiSettings).toHaveBeenCalled();
  });
});
