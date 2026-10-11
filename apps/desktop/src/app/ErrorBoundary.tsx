/**
 * Full-window crash recovery (faz7-spec.md §2 + §9.4, binding revision). Wraps `<App/>` in
 * `main.tsx`. Deliberately does NOT import any zustand store — the error being displayed may
 * well have originated inside one, and the recovery UI must render regardless. That is also why
 * it reads the non-reactive `strings` (not `useStrings()`, which subscribes to the i18n store).
 * Styling uses design-token classes (`index.css`) only.
 *
 * `RecoveryScreen` is also used directly by `main.tsx` for a throw that happens *before*
 * `createRoot` (§9.3) — `ErrorBoundary` itself can't catch that since React isn't mounted yet.
 */
import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { strings } from "./strings";
import { clipboardWriteText, diagnosticsCollect, saveStateSlice } from "../lib/ipc";
import { logError, logWarn, oneLineMessage, serializeError } from "../lib/logging";

const CRASH_STORAGE_KEY = "agenthub.crashes";
/** §9.4: at this crash count (within one session, see reset rule below) show "Reset layout". */
const CRASH_LOOP_THRESHOLD = 2;
/** §9.4: the counter resets after 60s of uptime without another crash. */
const CRASH_RESET_AFTER_MS = 60_000;

function readCrashCount(): number {
  try {
    const raw = sessionStorage.getItem(CRASH_STORAGE_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeCrashCount(n: number): void {
  try {
    sessionStorage.setItem(CRASH_STORAGE_KEY, String(n));
  } catch {
    // Storage disabled (private mode etc.) — the crash-loop button just won't appear.
  }
}

/**
 * Shared by `ErrorBoundary.componentDidCatch` and `main.tsx`'s pre-render catch: marks the
 * session as crashed (§9.4: `saveStateSlice` stops writing while this is set), bumps the
 * per-session crash counter, and logs the full (multi-line) serialized error. Returns the new
 * count so the caller can decide whether to show "Reset layout and reload".
 */
export function recordCrash(error: unknown): number {
  window.__agenthubCrashed = true;
  const count = readCrashCount() + 1;
  writeCrashCount(count);
  logError(`[frontend] unexpected error: ${serializeError(error)}`);
  return count;
}

interface RecoveryScreenProps {
  message: string;
  showResetLayout: boolean;
}

function Button({
  onClick,
  disabled,
  primary,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-3 py-1.5 text-xs disabled:opacity-50 ${
        primary ? "border-none bg-accent text-on-accent" : "border border-border bg-transparent text-text"
      }`}
    >
      {children}
    </button>
  );
}

/** Full-window recovery UI — design tokens only, no store dependency (see file header). */
export function RecoveryScreen({ message, showResetLayout }: RecoveryScreenProps) {
  const [collecting, setCollecting] = useState(false);
  const [result, setResult] = useState<{ ok: true; path: string } | { ok: false } | null>(null);
  const [resetting, setResetting] = useState(false);

  async function handleCollectDiagnostics() {
    setCollecting(true);
    setResult(null);
    try {
      const { path } = await diagnosticsCollect();
      try {
        await clipboardWriteText(path);
      } catch {
        // Path is still shown inline below — copy failing doesn't hide it.
      }
      setResult({ ok: true, path });
    } catch {
      // Already logged by ipc.ts's central wrapper (§9.5) — no need to log it again here.
      setResult({ ok: false });
    } finally {
      setCollecting(false);
    }
  }

  async function handleResetLayout() {
    setResetting(true);
    logWarn("[frontend] crash loop");
    try {
      // §9.4: bypasses the crash guard on purpose — this is the one write we want through.
      await saveStateSlice("layout", {}, { bypassCrashGuard: true });
    } catch {
      // Best effort — reload regardless so the user isn't stuck.
    }
    location.reload();
  }

  return (
    <div
      className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-bg p-6 text-center text-text"
    >
      <div className="text-base font-semibold">{strings.errorBoundary.heading}</div>
      <div className="max-w-[640px] truncate text-xs text-muted" title={message}>
        {message}
      </div>
      <div className="text-xs text-muted">
        {strings.errorBoundary.reloadWarning}
      </div>
      <div className="flex gap-2">
        <Button primary onClick={() => location.reload()}>
          {strings.errorBoundary.reload}
        </Button>
        <Button disabled={collecting} onClick={() => void handleCollectDiagnostics()}>
          {collecting ? strings.errorBoundary.collecting : strings.errorBoundary.collectDiagnostics}
        </Button>
        {showResetLayout && (
          <Button disabled={resetting} onClick={() => void handleResetLayout()}>
            {strings.errorBoundary.resetLayoutAndReload}
          </Button>
        )}
      </div>
      {result?.ok === true && (
        <div className="max-w-[640px] break-all text-label text-idle">
          {strings.errorBoundary.collectSuccess(result.path)}
        </div>
      )}
      {result?.ok === false && (
        <div className="text-label text-blocked">
          {strings.errorBoundary.collectFailure}
        </div>
      )}
    </div>
  );
}

interface State {
  hasError: boolean;
  message: string;
  crashCount: number;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  private resetTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: "", crashCount: readCrashCount() };
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { hasError: true, message: oneLineMessage(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    void info; // component stack isn't logged (may reference user data via props/names)
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = undefined;
    }
    const crashCount = recordCrash(error);
    this.setState({ crashCount });
  }

  componentDidMount(): void {
    // §9.4: "resets after 60s of uptime without a crash" — started once, on the FIRST mount
    // (before any crash); cleared in componentDidCatch if a crash happens first.
    this.resetTimer = setTimeout(() => writeCrashCount(0), CRASH_RESET_AFTER_MS);
  }

  componentWillUnmount(): void {
    if (this.resetTimer) clearTimeout(this.resetTimer);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <RecoveryScreen message={this.state.message} showResetLayout={this.state.crashCount >= CRASH_LOOP_THRESHOLD} />
      );
    }
    return this.props.children;
  }
}
