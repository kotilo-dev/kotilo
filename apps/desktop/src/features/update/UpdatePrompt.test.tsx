import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { strings } from "../../app/strings";
import { resetUpdateStoreForTest, useUpdateStore } from "./updateStore";
import { UpdatePrompt } from "./UpdatePrompt";

const AVAILABLE = { status: "available", current: "0.1.0", version: "0.2.0", notes: "Faster previews", date: "2026-10-09" } as const;

describe("UpdatePrompt", () => {
  beforeEach(() => resetUpdateStoreForTest());

  it("renders nothing without an available update", () => {
    const { container } = render(<UpdatePrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows version, current version, notes and the two actions", () => {
    useUpdateStore.setState({ prompt: AVAILABLE });
    render(<UpdatePrompt />);
    expect(screen.getByRole("region", { name: strings.update.promptLabel })).toBeInTheDocument();
    expect(screen.getByText(strings.update.promptTitle("0.2.0"))).toBeInTheDocument();
    expect(screen.getByText(strings.update.promptCurrent("0.1.0", "2026-10-09"))).toBeInTheDocument();
    expect(screen.getByText("Faster previews")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.update.install })).toBeEnabled();
    expect(screen.getByRole("button", { name: strings.update.later })).toBeEnabled();
  });

  it("Install calls the store; Later dismisses", () => {
    const installUpdate = vi.fn().mockResolvedValue(undefined);
    useUpdateStore.setState({ prompt: AVAILABLE, installUpdate });
    render(<UpdatePrompt />);
    fireEvent.click(screen.getByRole("button", { name: strings.update.install }));
    expect(installUpdate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: strings.update.later }));
    expect(useUpdateStore.getState().prompt).toBeNull();
  });

  it("shows download progress and disables the actions while installing", () => {
    useUpdateStore.setState({ prompt: AVAILABLE, install: { phase: "downloading", downloaded: 5_242_880, total: 10_485_760 } });
    render(<UpdatePrompt />);
    expect(screen.getByText(strings.update.downloading(50))).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: strings.update.progressLabel })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.queryByRole("button", { name: strings.update.install })).toBeNull();
    expect(screen.queryByRole("button", { name: strings.update.later })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: strings.update.hide }));
    expect(screen.queryByTestId("update-prompt")).toBeNull();
    expect(useUpdateStore.getState().install.phase).toBe("downloading");
  });

  it("shows an unknown-size download without a percentage", () => {
    useUpdateStore.setState({ prompt: AVAILABLE, install: { phase: "downloading", downloaded: 1_048_576, total: null } });
    render(<UpdatePrompt />);
    expect(screen.getByText(strings.update.downloading(null))).toBeInTheDocument();
  });

  it("shows ready, then an error with Try again / Close", () => {
    useUpdateStore.setState({ prompt: AVAILABLE, install: { phase: "ready" } });
    render(<UpdatePrompt />);
    expect(screen.getByText(strings.update.ready)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);

    act(() => useUpdateStore.setState({ install: { phase: "error", message: "disk full" } }));
    expect(screen.getByRole("alert")).toHaveTextContent(strings.update.installFailed("disk full"));
    expect(screen.getByText(strings.update.failedTitle)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.update.retry })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: strings.update.later }));
    expect(useUpdateStore.getState().prompt).toBeNull();
  });
});
