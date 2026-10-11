import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";
import { strings } from "./strings";

const ipc = vi.hoisted(() => ({
  diagnosticsCollect: vi.fn(),
  clipboardWriteText: vi.fn(),
  saveStateSlice: vi.fn(),
}));

vi.mock("../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../lib/ipc")>("../lib/ipc");
  return { ...actual, ...ipc };
});
vi.mock("@tauri-apps/plugin-log", () => ({
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}));

function Bomb(): never {
  throw new Error("kaboom");
}

describe("ErrorBoundary (faz7-spec §2, §9.3, §9.4)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    delete window.__agenthubCrashed;
    ipc.diagnosticsCollect.mockReset();
    ipc.clipboardWriteText.mockReset().mockResolvedValue(undefined);
    ipc.saveStateSlice.mockReset().mockResolvedValue(undefined);
    // jsdom's `window.location` isn't configurable enough for `vi.spyOn` — stub the whole global.
    reloadMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload: reloadMock });
    // React logs the boundary's caught error to console.error — expected noise, silence it.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("renders the recovery screen (heading, one-line message, reload warning) instead of a blank tree", () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText(strings.errorBoundary.heading)).toBeInTheDocument();
    expect(screen.getByText("Error: kaboom")).toBeInTheDocument();
    expect(screen.getByText(strings.errorBoundary.reloadWarning)).toBeInTheDocument();
  });

  it("sets window.__agenthubCrashed on catch (so saveStateSlice stops writing, §9.4)", () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(window.__agenthubCrashed).toBe(true);
  });

  it("Reload button calls location.reload()", () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    screen.getByText(strings.errorBoundary.reload).click();
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("does not show 'Reset layout and reload' on the first crash of a session", () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.queryByText(strings.errorBoundary.resetLayoutAndReload)).not.toBeInTheDocument();
  });

  it("shows 'Reset layout and reload' from the 2nd crash of a session onward", () => {
    sessionStorage.setItem("agenthub.crashes", "1");
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText(strings.errorBoundary.resetLayoutAndReload)).toBeInTheDocument();
  });

  it("'Reset layout and reload' saves an empty layout slice bypassing the crash guard, then reloads", async () => {
    sessionStorage.setItem("agenthub.crashes", "1");
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    screen.getByText(strings.errorBoundary.resetLayoutAndReload).click();
    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    expect(ipc.saveStateSlice).toHaveBeenCalledWith("layout", {}, { bypassCrashGuard: true });
  });

  it("Collect diagnostics: on success, copies the path and shows it inline (toasts may be dead)", async () => {
    ipc.diagnosticsCollect.mockResolvedValue({ path: "C:\\diag\\agenthub-diagnostics-1.zip" });
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    screen.getByText(strings.errorBoundary.collectDiagnostics).click();
    await waitFor(() => expect(ipc.clipboardWriteText).toHaveBeenCalledWith("C:\\diag\\agenthub-diagnostics-1.zip"));
    // The message renders after the clipboard write resolves, one microtask later.
    expect(
      await screen.findByText(strings.errorBoundary.collectSuccess("C:\\diag\\agenthub-diagnostics-1.zip")),
    ).toBeInTheDocument();
  });

  it("Collect diagnostics: on failure, shows a failure message instead of throwing", async () => {
    ipc.diagnosticsCollect.mockRejectedValue({ code: "io", message: "disk full" });
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    screen.getByText(strings.errorBoundary.collectDiagnostics).click();
    await waitFor(() => expect(screen.getByText(strings.errorBoundary.collectFailure)).toBeInTheDocument());
  });
});
