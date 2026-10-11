/**
 * IPC of the mascot window (M6, D-052). Kept next to the feature because the mascot window
 * loads only this page; the contract is fixed with the Rust side (`platform/mascot/`).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const MASCOT_STATE_EVENT = "mascot:state";

export function onMascotState(handler: (payload: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>(MASCOT_STATE_EVENT, (e) => handler(e.payload));
}

/** The page listens; Rust replies with the current state. */
export function mascotReady(): Promise<void> {
  return invoke<void>("mascot_ready");
}

export function mascotClicked(): Promise<void> {
  return invoke<void>("mascot_clicked");
}

export function mascotContextMenu(): Promise<void> {
  return invoke<void>("mascot_context_menu");
}

/** Horizontal drag delta in CSS px since the previous call. */
export function mascotDrag(dx: number): Promise<void> {
  return invoke<void>("mascot_drag", { dx });
}

export function mascotDragEnd(): Promise<void> {
  return invoke<void>("mascot_drag_end");
}
