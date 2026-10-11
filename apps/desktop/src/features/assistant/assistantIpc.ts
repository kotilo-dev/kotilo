/**
 * IPC of the assistant chat popup (M7, D-053); the contract is fixed with the Rust side
 * (`assistant_*` commands, `assistant:*` events). Uses the raw `invoke` on purpose: the
 * `lib/ipc` wrapper logs failure messages, and nothing about a chat may reach the log (rule 5).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AssistantInfo {
  enabled: boolean;
  provider: string;
  providerLabel: string;
  model: string | null;
  /** true = the provider keeps no copy; false = it keeps one (CLI session files); null = unknown. */
  ephemeral: boolean | null;
  available: boolean;
  unavailableReason: string | null;
}

export interface AssistantMessage {
  role: "user" | "assistant";
  text: string;
}

export type AssistantEvent =
  | { type: "meta"; provider: string; providerLabel: string; model: string | null; ephemeral: boolean | null }
  | { type: "text"; text: string }
  | { type: "done"; errorKind: string; error?: string | null };

/** `assistant_set_config` payload (main window → Rust). */
export interface AssistantConfig {
  enabled: boolean;
  hotkey: string;
}

export type HotkeyStatus = "ok" | "taken" | "invalid" | "off";

export const ASSISTANT_OPENED_EVENT = "assistant:opened";
export const ASSISTANT_CLOSED_EVENT = "assistant:closed";
export const ASSISTANT_HOTKEY_EVENT = "assistant:hotkey";
/** Assistant page → main window: open Settings → AI (Rust brings the main window up). */
export const ASSISTANT_SETTINGS_EVENT = "assistant:settings";

export function assistantInfo(): Promise<AssistantInfo> {
  return invoke<AssistantInfo>("assistant_info");
}

/** Streams one answer; resolves when Rust has finished (the last event is `done`). */
export function assistantChat(messages: AssistantMessage[], onEvent: (e: AssistantEvent) => void): Promise<void> {
  const channel = new Channel<AssistantEvent>(onEvent);
  return invoke<void>("assistant_chat", { messages, onEvent: channel });
}

export function assistantStop(): Promise<void> {
  return invoke<void>("assistant_stop");
}

export function assistantHide(): Promise<void> {
  return invoke<void>("assistant_hide");
}

export function assistantOpen(): Promise<void> {
  return invoke<void>("assistant_open");
}

/** Registers the shortcut; returns its status (also emitted to the main window as `assistant:hotkey`). */
export function assistantSetConfig(config: AssistantConfig): Promise<{ status: HotkeyStatus; hotkey: string } | null> {
  return invoke<{ status: HotkeyStatus; hotkey: string } | null>("assistant_set_config", { config });
}

export function onAssistantOpened(handler: () => void): Promise<UnlistenFn> {
  return listen(ASSISTANT_OPENED_EVENT, () => handler());
}

export function onAssistantClosed(handler: () => void): Promise<UnlistenFn> {
  return listen(ASSISTANT_CLOSED_EVENT, () => handler());
}

export function requestAiSettings(): Promise<void> {
  return emit(ASSISTANT_SETTINGS_EVENT);
}
