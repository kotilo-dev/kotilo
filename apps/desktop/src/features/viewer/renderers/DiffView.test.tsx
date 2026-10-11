import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  gitShowHead: vi.fn(),
  fsReadText: vi.fn(),
  onFsChanged: vi.fn(() => Promise.resolve(() => {})),
  isAppError: (e: unknown, code?: string) => typeof e === "object" && e !== null && (code === undefined || (e as { code: string }).code === code),
}));
vi.mock("../../../lib/ipc", () => ipc);
vi.mock("./TextEditor", () => ({ languageForRel: () => "typescript", monacoThemeFor: () => "vs-dark" }));
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (p: { original: string; modified: string }) => (
    <div data-testid="monaco-diff">
      {p.original}|{p.modified}
    </div>
  ),
}));

import { DiffView, loadDiff } from "./DiffView";

const head = (content: string | null, extra: Partial<{ binary: boolean; tooLarge: boolean }> = {}) => ({ content, binary: false, tooLarge: false, ...extra });

beforeEach(() => {
  ipc.gitShowHead.mockReset();
  ipc.fsReadText.mockReset();
});

describe("loadDiff", () => {
  it("diffs HEAD against the working copy", async () => {
    ipc.gitShowHead.mockResolvedValue(head("old"));
    ipc.fsReadText.mockResolvedValue({ text: "new" });
    expect(await loadDiff("ws", "a.ts")).toEqual({ status: "ready", original: "old", modified: "new" });
    expect(ipc.gitShowHead).toHaveBeenCalledWith("ws", "a.ts");
  });

  it("uses empty sides for added and deleted files", async () => {
    ipc.gitShowHead.mockResolvedValue(head(null));
    ipc.fsReadText.mockResolvedValue({ text: "new" });
    expect(await loadDiff("ws", "a.ts")).toMatchObject({ original: "", modified: "new" });
    ipc.gitShowHead.mockResolvedValue(head("old"));
    ipc.fsReadText.mockRejectedValue({ code: "not_found", message: "" });
    expect(await loadDiff("ws", "a.ts")).toMatchObject({ original: "old", modified: "" });
  });

  it("reports binary, too large and failures", async () => {
    ipc.gitShowHead.mockResolvedValue(head(null, { binary: true }));
    ipc.fsReadText.mockResolvedValue({ text: "" });
    expect((await loadDiff("ws", "a.png")).status).toBe("binary");
    ipc.gitShowHead.mockResolvedValue(head(null));
    ipc.fsReadText.mockRejectedValue({ code: "binary_file", message: "" });
    expect((await loadDiff("ws", "a.png")).status).toBe("binary");
    ipc.gitShowHead.mockResolvedValue(head(null, { tooLarge: true }));
    ipc.fsReadText.mockResolvedValue({ text: "" });
    expect((await loadDiff("ws", "big.txt")).status).toBe("tooLarge");
    ipc.gitShowHead.mockRejectedValue({ code: "outside_workspace", message: "" });
    expect((await loadDiff("ws", "../x")).status).toBe("failed");
  });
});

describe("DiffView", () => {
  it("renders the read-only diff with its header", async () => {
    ipc.gitShowHead.mockResolvedValue(head("old"));
    ipc.fsReadText.mockResolvedValue({ text: "new" });
    render(<DiffView workspaceId="ws" rel="src/a.ts" />);
    expect(await screen.findByTestId("monaco-diff")).toHaveTextContent("old|new");
    expect(screen.getByText("HEAD ↔ working copy (read-only)")).toBeInTheDocument();
  });
});
