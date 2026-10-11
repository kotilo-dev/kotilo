import "./lib/frontendErrors"; // faz7-spec §9.3: MUST be the first import (catches module-eval errors below too)
import { resolveTheme, systemPrefersDark, useResolvedTheme } from "./app/theme/resolvedTheme";
import React from "react";
import ReactDOM from "react-dom/client";
// NOTE: a throw during THESE modules' own evaluation (`ErrorBoundary` and everything it
// pulls in transitively -- `strings`, `ipc`, `settingsStore`) happens before `bootstrap()`
// ever runs, so `bootstrap`'s try/catch below can't see it and no `RecoveryScreen` is drawn
// (that component lives in the very module that may have failed to load). The only thing
// that still catches and logs it is `frontendErrors.ts`'s global `window` error/
// `unhandledrejection` listener, installed by the import above -- the user just sees a
// blank window, but the error is in the log file.
import { ErrorBoundary, recordCrash, RecoveryScreen } from "./app/ErrorBoundary";
import { loadState, settingsGet } from "./lib/ipc";
import { hydrateLanguage } from "./app/i18n";
import { DEFAULT_SETTINGS, hydrateSettingsStore } from "./stores/settingsStore";
import { oneLineMessage } from "./lib/logging";
import "./index.css";

const CRASH_LOOP_THRESHOLD = 2;

/**
 * Tema flaşı olmasın diye (faz6-spec §1.3): render'dan önce `settings_get`'i bekler ve
 * `<html data-theme>`'i ayarlar. Hata → varsayılanlarla (render yine olur, uygulama açılışı
 * ayarlar servisine bağımlı değil).
 *
 * faz7-spec §9.3: the whole body (including the dynamic `import("./app/App")`, which pulls in
 * every store/feature module) is wrapped in try/catch — a throw during THEIR module evaluation
 * (not just a render-time throw, which `ErrorBoundary` already catches) still draws the
 * recovery screen instead of leaving a blank window. `App` is imported dynamically rather than
 * statically so that this catch can actually see it fail.
 */
async function bootstrap() {
  // M2b: the dictation overlay is its own small window on the same bundle; it renders only the
  // overlay, without the app shell.
  if (new URLSearchParams(window.location.search).get("view") === "dictation-overlay") {
    const { bootstrapOverlay } = await import("./features/dictation/overlay/overlayEntry");
    await bootstrapOverlay();
    return;
  }
  try {
    let settings = DEFAULT_SETTINGS;
    try {
      settings = await settingsGet();
    } catch {
      settings = DEFAULT_SETTINGS;
    }
    const theme = resolveTheme(settings.theme, systemPrefersDark());
    document.documentElement.dataset.theme = theme;
    useResolvedTheme.setState({ theme });
    hydrateSettingsStore(settings);
    // M2: UI language (frontend preference in the `ui` slice of state.json), before the first render.
    try {
      hydrateLanguage(await loadState());
    } catch {
      hydrateLanguage({});
    }

    const { App } = await import("./app/App");

    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );
  } catch (e) {
    const crashCount = recordCrash(e);
    const root = document.getElementById("root");
    if (root) {
      ReactDOM.createRoot(root).render(
        <RecoveryScreen message={oneLineMessage(e)} showResetLayout={crashCount >= CRASH_LOOP_THRESHOLD} />,
      );
    }
  }
}

void bootstrap();
