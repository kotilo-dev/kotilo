import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "../../lib/ipc";

const ipc = vi.hoisted(() => ({
  fsReadText: vi.fn(),
  fsWriteText: vi.fn(),
  fsStat: vi.fn(),
  onFsChanged: vi.fn(),
  onFsRescan: vi.fn(),
  toAppError: vi.fn((e: unknown): AppError => {
    if (e && typeof e === "object" && "code" in e && "message" in e) return e as AppError;
    return { code: "io", message: String(e) };
  }),
}));

vi.mock("../../lib/ipc", () => ipc);

function textFile(overrides: Partial<{ text: string; hash: string }> = {}) {
  return {
    text: "hello",
    encoding: "utf8" as const,
    eol: "lf" as const,
    mixedEol: false,
    hash: "h1",
    mtimeMs: 1,
    size: 5,
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

async function freshModules() {
  vi.resetModules();
  ipc.onFsChanged.mockImplementation(() => Promise.resolve(() => {}));
  ipc.onFsRescan.mockImplementation(() => Promise.resolve(() => {}));
  const docMod = await import("../../stores/documentStore");
  const unsavedMod = await import("./unsavedChanges");
  const { useViewerStore } = await import("../../stores/viewerStore");
  return { ...docMod, ...unsavedMod, useViewerStore };
}

function openTab(useViewerStore: Awaited<ReturnType<typeof freshModules>>["useViewerStore"], workspaceId: string, rel: string, tabId: string) {
  useViewerStore.setState((s) => ({
    byWorkspace: {
      ...s.byWorkspace,
      [workspaceId]: {
        tabs: [...(s.byWorkspace[workspaceId]?.tabs ?? []), { id: tabId, rel, pinned: true, missing: false }],
        activeTabId: tabId,
      },
    },
  }));
}

beforeEach(() => {
  Object.values(ipc).forEach((fn) => {
    if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  });
  ipc.toAppError.mockImplementation((e: unknown): AppError => {
    if (e && typeof e === "object" && "code" in e && "message" in e) return e as AppError;
    return { code: "io", message: String(e) };
  });
});

describe("collectDirtyDocsForWorkspace / collectDirtyDocs (finding #6)", () => {
  it("only returns dirty, non-read-only docs scoped to the requested workspace", async () => {
    const { useDocumentStore, useViewerStore, collectDirtyDocsForWorkspace, collectDirtyDocs } = await freshModules();

    ipc.fsReadText.mockResolvedValueOnce(textFile({ text: "v1" })).mockResolvedValueOnce(textFile({ text: "v1" }));
    await useDocumentStore.getState().load("ws1", "a.txt");
    await useDocumentStore.getState().load("ws2", "b.txt");
    useDocumentStore.getState().setText("ws1", "a.txt", "v2"); // dirty
    // ws2/b.txt stays clean.

    openTab(useViewerStore, "ws1", "a.txt", "tab-1");
    openTab(useViewerStore, "ws2", "b.txt", "tab-2");

    expect(collectDirtyDocsForWorkspace("ws1")).toEqual([{ workspaceId: "ws1", rel: "a.txt" }]);
    expect(collectDirtyDocsForWorkspace("ws2")).toEqual([]);
    expect(collectDirtyDocs()).toEqual([{ workspaceId: "ws1", rel: "a.txt" }]);
  });

  it("excludes a dirty-looking doc if it is read-only (defensive, finding #2)", async () => {
    const { useDocumentStore, useViewerStore, collectDirtyDocsForWorkspace, docKey } = await freshModules();
    ipc.fsReadText.mockResolvedValue(textFile());
    await useDocumentStore.getState().load("ws1", "a.txt");
    openTab(useViewerStore, "ws1", "a.txt", "tab-1");
    // Force an inconsistent (should-be-impossible) dirty+readOnly state to prove the guard.
    useDocumentStore.setState((s) => ({
      docs: { ...s.docs, [docKey("ws1", "a.txt")]: { ...s.docs[docKey("ws1", "a.txt")]!, dirty: true, readOnly: true } },
    }));

    expect(collectDirtyDocsForWorkspace("ws1")).toEqual([]);
  });
});

describe("saveAllDirty", () => {
  it("returns true when every document saves successfully", async () => {
    const { useDocumentStore, saveAllDirty } = await freshModules();
    ipc.fsReadText.mockResolvedValue(textFile());
    ipc.fsWriteText.mockResolvedValue({ hash: "h2", mtimeMs: 2 });
    await useDocumentStore.getState().load("ws1", "a.txt");
    useDocumentStore.getState().setText("ws1", "a.txt", "v2");

    const ok = await saveAllDirty([{ workspaceId: "ws1", rel: "a.txt" }]);

    expect(ok).toBe(true);
    expect(ipc.fsWriteText).toHaveBeenCalledTimes(1);
  });

  it("returns false (and cancels the caller's close/remove flow) if any save conflicts", async () => {
    const { useDocumentStore, saveAllDirty } = await freshModules();
    ipc.fsReadText.mockResolvedValue(textFile());
    ipc.fsWriteText.mockRejectedValue({ code: "conflict", message: "conflict" });
    ipc.fsStat.mockResolvedValue({ size: 1, mtimeMs: 1, hash: "diskhash" });
    await useDocumentStore.getState().load("ws1", "a.txt");
    useDocumentStore.getState().setText("ws1", "a.txt", "v2");

    const ok = await saveAllDirty([{ workspaceId: "ws1", rel: "a.txt" }]);

    expect(ok).toBe(false);
  });
});
