import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DictationPage, formatBytes } from "./DictationPage";
import { strings } from "../../app/strings";
import type { DictationModel, DictationRecord } from "../../lib/hubTypes";
import type { DictationStatus } from "../../lib/ipc";

const STATUS: DictationStatus = {
  enabled: true,
  hotkey: { gesture: "Ctrl+Alt+D", error: null },
  pasteLastHotkey: { gesture: "Ctrl+Alt+Shift+D", error: null },
  phase: "hidden",
};
let doneHandler: ((p: { id: number | null }) => void) | null = null;

const ipc = vi.hoisted(() => ({ hubRequest: vi.fn(), clipboardWriteText: vi.fn(), dictationStatus: vi.fn(), onDictationDone: vi.fn() }));
vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return { ...actual, ...ipc };
});

const MODELS: DictationModel[] = [
  { id: "large", fileName: "ggml-large.bin", size: 574 * 1024 ** 2, installed: false, selected: true, partialBytes: 0, downloading: false, progress: null, error: null },
  { id: "small", fileName: "ggml-small.bin", size: 190 * 1024 ** 2, installed: true, selected: false, partialBytes: 0, downloading: false, progress: null, error: null },
];
const HISTORY: DictationRecord[] = [
  { id: 1, createdAt: "2026-10-04T09:00:00+03:00", durationSeconds: 4.2, rawText: "eee merhaba dünya", finalText: "Merhaba dünya.", cleaned: true, mode: "Clean", model: "large", language: "tr", outputs: "paste" },
];

describe("DictationPage", () => {
  beforeEach(() => {
    ipc.clipboardWriteText.mockReset().mockResolvedValue(undefined);
    ipc.dictationStatus.mockReset().mockResolvedValue(STATUS);
    doneHandler = null;
    ipc.onDictationDone.mockReset().mockImplementation((h: (p: { id: number | null }) => void) => {
      doneHandler = h;
      return Promise.resolve(() => {});
    });
    ipc.hubRequest.mockReset().mockImplementation((method: string, path: string) => {
      if (method === "GET" && path === "/v1/dictation/models") return Promise.resolve(MODELS);
      if (method === "GET" && path.startsWith("/v1/dictations")) return Promise.resolve(HISTORY);
      if (method === "POST") return Promise.resolve(MODELS);
      return Promise.resolve(null);
    });
  });

  it("shows the dictation shortcuts when they are registered", async () => {
    render(<DictationPage />);
    expect(await screen.findByText(strings.dictation.hotkeysLine("Ctrl+Alt+D", "Ctrl+Alt+Shift+D"))).toBeInTheDocument();
  });

  it("warns about a shortcut that could not be registered, naming it", async () => {
    ipc.dictationStatus.mockResolvedValue({ ...STATUS, hotkey: { gesture: "Ctrl+Alt+D", error: "taken" }, pasteLastHotkey: { gesture: "Ctrl+Q+", error: "invalid" } });
    render(<DictationPage />);
    expect(await screen.findByText(strings.dictation.hotkeyTaken("Ctrl+Alt+D"))).toBeInTheDocument();
    expect(screen.getByText(strings.dictation.hotkeyInvalid("Ctrl+Q+"))).toBeInTheDocument();
  });

  it("says so when dictation is off, and shows nothing when the status is unknown", async () => {
    ipc.dictationStatus.mockResolvedValue({ ...STATUS, enabled: false });
    const { unmount } = render(<DictationPage />);
    expect(await screen.findByText(strings.dictation.disabled)).toBeInTheDocument();
    unmount();
    ipc.dictationStatus.mockRejectedValue({ code: "io", message: "no such command" });
    render(<DictationPage />);
    await screen.findByText("Merhaba dünya.");
    expect(screen.queryByText(strings.dictation.disabled)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.dictation.hotkeysLine("Ctrl+Alt+D", "Ctrl+Alt+Shift+D"))).not.toBeInTheDocument();
  });

  it("reloads the history when a dictation finishes", async () => {
    render(<DictationPage />);
    await screen.findByText("Merhaba dünya.");
    const calls = () => ipc.hubRequest.mock.calls.filter(([m, p]) => m === "GET" && String(p).startsWith("/v1/dictations")).length;
    const before = calls();
    await waitFor(() => expect(doneHandler).not.toBeNull());
    doneHandler!({ id: 2 });
    await waitFor(() => expect(calls()).toBe(before + 1));
  });

  it("formats model sizes", () => {
    expect(formatBytes(574 * 1024 ** 2)).toMatch(/^574 MB$/);
  });

  it("starts a model download", async () => {
    render(<DictationPage />);
    fireEvent.click(await screen.findByRole("button", { name: strings.dictation.download }));
    await waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledWith("POST", "/v1/dictation/models/large/download"));
  });

  it("deletes an installed model only after confirmation", async () => {
    render(<DictationPage />);
    fireEvent.click(await screen.findByRole("button", { name: strings.dictation.delete }));
    expect(screen.getByText(strings.dictation.deleteTitle)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: strings.dictation.delete }).slice(-1)[0]!);
    await waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledWith("DELETE", "/v1/dictation/models/small"));
  });

  it("shows history with the raw text and copies the final text", async () => {
    render(<DictationPage />);
    expect(await screen.findByText("Merhaba dünya.")).toBeInTheDocument();
    expect(screen.getByText(strings.dictation.beforeCleanup)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: strings.dictation.copy }));
    await waitFor(() => expect(ipc.clipboardWriteText).toHaveBeenCalledWith("Merhaba dünya."));
  });

  it("clears the history after confirmation", async () => {
    render(<DictationPage />);
    fireEvent.click(await screen.findByRole("button", { name: strings.dictation.clearAll }));
    fireEvent.click(screen.getAllByRole("button", { name: strings.dictation.clearAll }).slice(-1)[0]!);
    await waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledWith("DELETE", "/v1/dictations"));
  });
});
