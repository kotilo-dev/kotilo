/**
 * Entry for the mascot window (`index.html?view=mascot`, created by Rust, M6): renders only
 * the snail — no app shell, stores, theme or settings (the mascot sits on the user's desktop
 * and does not follow the app theme). `?demo=<state>` gives a static demo state for e2e.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { MascotView } from "./MascotView";
import { INITIAL_MASCOT_STATE, parseDemoParams } from "./mascotState";

export const MASCOT_VIEW = "mascot";

export function bootstrapMascot(): void {
  document.documentElement.dataset.view = MASCOT_VIEW;
  const initial = parseDemoParams(window.location.search) ?? INITIAL_MASCOT_STATE;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <MascotView initial={initial} />
    </React.StrictMode>,
  );
}
