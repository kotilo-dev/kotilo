/**
 * Entry for the assistant window (`index.html?view=assistant`, created by Rust, M7): renders
 * only the chat popup – no app shell or main-window stores. Theme and language are read like
 * the dictation overlay does and re-read on every opening, so changes made in the main
 * window show up without restarting.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { applyOverlayAppearance } from "../dictation/overlay/overlayEntry";
import { AssistantView } from "./AssistantView";

export const ASSISTANT_VIEW = "assistant";

async function applyAppearance(): Promise<void> {
  // Also publishes `useResolvedTheme` (code highlighting follows it).
  await applyOverlayAppearance();
}

export async function bootstrapAssistant(): Promise<void> {
  document.documentElement.dataset.view = ASSISTANT_VIEW;
  await applyAppearance();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <AssistantView onOpened={() => void applyAppearance()} />
    </React.StrictMode>,
  );
}
