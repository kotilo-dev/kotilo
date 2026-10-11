/**
 * Uncaught frontend error capture (faz7-spec.md §9.3, replacing §2's frontend half).
 *
 * Imported as the FIRST import of `main.tsx` on purpose: `window.addEventListener` calls in a
 * module's top-level body run as soon as the module is evaluated, so being first means these
 * listeners exist before any other module (including ones with buggy top-level code) is
 * evaluated. Installation is idempotent (`window.__agenthubErrorsInstalled`) so re-importing
 * this module (e.g. from a test, or twice under HMR) never double-registers listeners.
 */
import { logError, serializeError } from "./logging";

declare global {
  interface Window {
    __agenthubErrorsInstalled?: boolean;
  }
}

/** §9.3: ignore reasons/messages that mention `plugin:log` itself (loop prevention). */
function isIgnorable(text: string): boolean {
  return text.includes("plugin:log");
}

function handleErrorEvent(e: ErrorEvent): void {
  const detail = e.error !== undefined && e.error !== null ? serializeError(e.error) : e.message || "unknown error";
  if (isIgnorable(detail) || isIgnorable(e.message ?? "")) return;
  logError(`[frontend] ${detail} at ${e.filename}:${e.lineno}`);
}

function handleRejectionEvent(e: PromiseRejectionEvent): void {
  const detail = serializeError(e.reason);
  if (isIgnorable(detail)) return;
  logError(`[frontend] unhandled rejection: ${detail}`);
}

/**
 * Installs the `error`/`unhandledrejection` listeners once. Exported (rather than only run as a
 * top-level side effect) so tests can install against a scoped `EventTarget`-like stub instead
 * of polluting the real `window`.
 */
export function installFrontendErrorHandlers(target: Window = window): void {
  if (target.__agenthubErrorsInstalled) return;
  target.__agenthubErrorsInstalled = true;

  target.addEventListener("error", handleErrorEvent as EventListener);
  target.addEventListener("unhandledrejection", handleRejectionEvent as EventListener);
}

installFrontendErrorHandlers();
