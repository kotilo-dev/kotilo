import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { HubSettings } from "../../lib/hubTypes";
import { useAssistantHotkeyStore } from "../assistant/useAssistantBridge";
import { AssistantSettings } from "./AssistantSettings";
import { validateHubSettings } from "./hubSettings";
import { sectionForField } from "./SettingsPage";
import { dictionary } from "../../app/i18n";

const ipc = vi.hoisted(() => ({ assistantOpen: vi.fn() }));
vi.mock("../assistant/assistantIpc", async () => ({ ...(await vi.importActual<object>("../assistant/assistantIpc")), ...ipc }));

const draft = (buddy: Partial<HubSettings["buddy"]> = {}) => ({ buddy: { enabled: true, hotkey: "Ctrl+Alt+Space", ...buddy } }) as unknown as HubSettings;

function renderRow(d: HubSettings, errors: Record<string, string> = {}) {
  const update = vi.fn();
  render(<AssistantSettings draft={d} update={update} errors={errors} />);
  return update;
}

describe("AssistantSettings", () => {
  beforeEach(() => {
    ipc.assistantOpen.mockReset().mockResolvedValue(undefined);
    useAssistantHotkeyStore.setState({ status: null });
  });

  it("edits buddy.enabled and buddy.hotkey in the draft", () => {
    const d = draft();
    const update = renderRow(d);
    fireEvent.click(screen.getByRole("checkbox", { name: /Turn on the assistant/ }));
    expect(update.mock.calls[0]![0](d).buddy.enabled).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: "Shortcut" }), { target: { value: "Ctrl+Alt+K" } });
    expect(update.mock.calls[1]![0](d).buddy).toEqual({ enabled: true, hotkey: "Ctrl+Alt+K" });
  });

  it("hides the shortcut while the assistant is off", () => {
    renderRow(draft({ enabled: false }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open assistant" })).toBeNull();
  });

  it("shows the shortcut status Rust reports for this shortcut", () => {
    useAssistantHotkeyStore.setState({ status: { status: "taken", hotkey: "Ctrl+Alt+Space", configured: "ctrl+alt+space" } });
    renderRow(draft());
    expect(screen.getByRole("alert")).toHaveTextContent("Shortcut is used by another app");
    expect(screen.getByRole("textbox", { name: "Shortcut" })).toHaveAttribute("aria-invalid", "true");
  });

  it("ignores a status about another shortcut, shows invalid as a field hint", () => {
    useAssistantHotkeyStore.setState({ status: { status: "taken", hotkey: "Ctrl+Alt+B", configured: "Ctrl+Alt+B" } });
    renderRow(draft());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows invalid and hub validation errors on the field", () => {
    useAssistantHotkeyStore.setState({ status: { status: "invalid", hotkey: "Ctrl+Alt+Space", configured: "Ctrl+Alt+Space" } });
    const { unmount } = render(<AssistantSettings draft={draft()} update={vi.fn()} errors={{}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("isn't a valid shortcut");
    unmount();
    renderRow(draft(), { "buddy.hotkey": "Same as the dictation shortcut." });
    expect(screen.getByRole("alert")).toHaveTextContent("Same as the dictation shortcut.");
  });

  it("Open assistant calls assistant_open", () => {
    renderRow(draft());
    fireEvent.click(screen.getByRole("button", { name: "Open assistant" }));
    expect(ipc.assistantOpen).toHaveBeenCalledTimes(1);
  });

  it("buddy.enabled / buddy.hotkey errors belong to the AI section, the rest of buddy to Mascot", () => {
    expect(sectionForField("buddy.hotkey")).toBe("ai");
    expect(sectionForField("buddy.enabled")).toBe("ai");
    expect(sectionForField("buddy.mascotScale")).toBe("mascot");
  });

  it("requires a shortcut while the assistant is on", () => {
    const t = dictionary("en").settingsPage;
    const base = { rules: { contextThresholdPercent: 80, contextRearmPercent: 50, reminderAfter: "00:05:00", minTurnForCompleted: "00:00:30" }, usageRules: { dailyCostThresholdUsd: 10 }, quietHours: { start: "22:00", end: "08:00" }, dictation: { hotkey: "Ctrl+Alt+D", pasteLastHotkey: "Ctrl+Alt+Shift+D", maxMinutes: 5 }, insights: { uncommittedThreshold: 20, dailySummaryTime: "18:00" } };
    const s = (buddy: Partial<HubSettings["buddy"]>) => ({ ...base, ...draft(buddy) }) as unknown as HubSettings;
    expect(validateHubSettings(s({ hotkey: " " }), t)["buddy.hotkey"]).toBe(t.dictation.hotkeyRequired);
    expect(validateHubSettings(s({ hotkey: " ", enabled: false }), t)["buddy.hotkey"]).toBeUndefined();
    expect(validateHubSettings(s({}), t)["buddy.hotkey"]).toBeUndefined();
  });
});
