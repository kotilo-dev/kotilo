/**
 * Entry for the dictation overlay window (`index.html?view=dictation-overlay`, created by Rust):
 * renders only the overlay — no app shell, stores or global listeners of the main window. Theme
 * and UI language are read like the main window does, and re-read when a dictation starts so a
 * change made in the main window shows up without reopening the overlay.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { hydrateLanguage } from "../../../app/i18n";
import { resolveTheme, systemPrefersDark } from "../../../app/theme/resolvedTheme";
import { loadState, settingsGet } from "../../../lib/ipc";
import { DictationOverlay } from "./DictationOverlay";

export const OVERLAY_VIEW = "dictation-overlay";

export async function applyOverlayAppearance(): Promise<void> {
  try {
    const settings = await settingsGet();
    document.documentElement.dataset.theme = resolveTheme(settings.theme, systemPrefersDark());
  } catch {
    document.documentElement.dataset.theme ??= "dark";
  }
  try {
    hydrateLanguage(await loadState());
  } catch {
    hydrateLanguage({});
  }
}

export async function bootstrapOverlay(): Promise<void> {
  document.documentElement.dataset.view = OVERLAY_VIEW;
  await applyOverlayAppearance();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <DictationOverlay onSessionStart={() => void applyOverlayAppearance()} />
    </React.StrictMode>,
  );
}
