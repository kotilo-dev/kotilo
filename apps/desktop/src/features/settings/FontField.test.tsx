import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return { ...actual, fontsInstalled: vi.fn(async () => ["Cascadia Code", "Consolas", "Segoe UI"]) };
});

import * as ipcModule from "../../lib/ipc";
import { useI18nStore } from "../../app/i18n";
import { FontField, firstFamily, resetInstalledFontsCache } from "./FontField";

beforeEach(() => {
  resetInstalledFontsCache();
  useI18nStore.setState({ preference: "en", language: "en" });
});

describe("FontField", () => {
  it("reads the first family of a CSS list", () => {
    expect(firstFamily(`"Cascadia Code", Consolas, monospace`)).toBe("Cascadia Code");
    expect(firstFamily("Segoe UI")).toBe("Segoe UI");
    expect(firstFamily("")).toBe("");
  });

  it("selects the installed family that the value starts with", async () => {
    render(<FontField value={`"cascadia code", monospace`} onCommit={() => {}} />);
    const select = await screen.findByRole("combobox", { name: "Installed fonts…" });
    expect(select).toHaveValue("Cascadia Code");
  });

  it("picking a family commits it with the fallback, or bare without one", async () => {
    const onCommit = vi.fn();
    const { unmount } = render(<FontField value="" fallback="monospace" onCommit={onCommit} />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Installed fonts…" }), { target: { value: "Consolas" } });
    expect(onCommit).toHaveBeenCalledWith(`"Consolas", monospace`);
    unmount();
    render(<FontField value="" onCommit={onCommit} />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Installed fonts…" }), { target: { value: "Segoe UI" } });
    expect(onCommit).toHaveBeenLastCalledWith("Segoe UI");
  });

  it("shows only the text field when the platform has no list", async () => {
    vi.mocked(ipcModule.fontsInstalled).mockResolvedValueOnce([]);
    render(<FontField value="Inter" onCommit={() => {}} />);
    await Promise.resolve();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("textbox")).toHaveValue("Inter");
  });
});
