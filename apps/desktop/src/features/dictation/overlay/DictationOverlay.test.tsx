import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DictationOverlay } from "./DictationOverlay";
import { strings } from "../../../app/strings";
import type { DictationOverlayState } from "../../../lib/ipc";

const ipc = vi.hoisted(() => ({ dictationCancel: vi.fn(), onDictationOverlay: vi.fn() }));
vi.mock("../../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/ipc")>("../../../lib/ipc");
  return { ...actual, ...ipc };
});

let emit: (state: DictationOverlayState) => void = () => {};
const rec = (patch: Partial<DictationOverlayState> = {}): DictationOverlayState => ({
  phase: "recording",
  mode: "undecided",
  elapsedMs: 0,
  level: 0,
  result: null,
  sound: null,
  ...patch,
});
const t = strings.dictation.overlay;

describe("DictationOverlay", () => {
  beforeEach(() => {
    ipc.dictationCancel.mockReset().mockResolvedValue(undefined);
    ipc.onDictationOverlay.mockReset().mockImplementation((h: (s: DictationOverlayState) => void) => {
      emit = (s) => act(() => h(s));
      return Promise.resolve(() => {});
    });
  });

  it("renders nothing while hidden", () => {
    const { container } = render(<DictationOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it("recording: record dot, timer, hint per mode and 18 bars that follow the level", () => {
    const onSessionStart = vi.fn();
    render(<DictationOverlay onSessionStart={onSessionStart} />);
    emit(rec({ elapsedMs: 7_200, level: 0.25 }));
    expect(onSessionStart).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("record-dot")).toBeInTheDocument();
    expect(screen.getByText(t.listening("0:07"))).toBeInTheDocument();
    expect(screen.getByText(t.hintUndecided)).toBeInTheDocument();
    const bars = screen.getAllByTestId("level-bar");
    expect(bars).toHaveLength(18);
    expect(bars[bars.length - 1]).toHaveStyle({ height: "23px" });
    expect(bars[0]).toHaveStyle({ height: "3px" });

    emit(rec({ mode: "hold", elapsedMs: 9_000, level: 0 }));
    expect(screen.getByText(t.hintHold)).toBeInTheDocument();
    expect(screen.getAllByTestId("level-bar")[16]).toHaveStyle({ height: "23px" });
    expect(onSessionStart).toHaveBeenCalledTimes(1);
  });

  it("transcribing and cleaning show a spinner and keep the cancel button", () => {
    render(<DictationOverlay />);
    emit(rec({ phase: "transcribing" }));
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.getByText(t.transcribing)).toBeInTheDocument();
    expect(screen.getByText(t.hintCancel)).toBeInTheDocument();
    emit(rec({ phase: "cleaning" }));
    expect(screen.getByText(t.cleaning)).toBeInTheDocument();
    expect(screen.queryAllByTestId("level-bar")).toHaveLength(0);
  });

  it("✕ cancels through the desktop", () => {
    render(<DictationOverlay />);
    emit(rec());
    fireEvent.click(screen.getByRole("button", { name: t.cancel }));
    expect(ipc.dictationCancel).toHaveBeenCalledTimes(1);
  });

  it("result: icon and message, no cancel button; a new recording starts with empty bars", () => {
    const onSessionStart = vi.fn();
    render(<DictationOverlay onSessionStart={onSessionStart} />);
    emit(rec({ level: 1 }));
    emit(rec({ phase: "result", result: { ok: true, message: "inserted" } }));
    expect(screen.getByTestId("result-ok")).toBeInTheDocument();
    expect(screen.getByText(t.messages.inserted)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.cancel })).not.toBeInTheDocument();

    emit(rec({ phase: "result", result: { ok: false, message: "failed", detail: "boom" } }));
    expect(screen.getByTestId("result-warning")).toBeInTheDocument();
    expect(screen.getByText(t.withDetail(t.messages.failed, "boom"))).toBeInTheDocument();

    emit(rec({ level: 0 }));
    expect(onSessionStart).toHaveBeenCalledTimes(2);
    for (const bar of screen.getAllByTestId("level-bar")) expect(bar).toHaveStyle({ height: "3px" });
  });

  it("follows the UI language", async () => {
    const { useI18nStore } = await import("../../../app/i18n");
    render(<DictationOverlay />);
    emit(rec({ elapsedMs: 3_000 }));
    act(() => useI18nStore.setState({ language: "tr" }));
    expect(screen.getByText("Dinliyor · 0:03")).toBeInTheDocument();
    act(() => useI18nStore.setState({ language: "en" }));
  });
});
