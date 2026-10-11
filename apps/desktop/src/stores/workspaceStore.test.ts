import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError, DirEntry, Workspace, WorkspacesState } from "../lib/ipc";

const ipc = vi.hoisted(() => ({
  workspaceList: vi.fn(),
  workspaceAdd: vi.fn(),
  workspaceRemove: vi.fn(),
  workspaceRename: vi.fn(),
  workspaceReorder: vi.fn(),
  workspaceSetActive: vi.fn(),
  workspaceSetExpanded: vi.fn(),
  fsReadDir: vi.fn(),
  fsCreateDir: vi.fn(),
  fsCreateFile: vi.fn(),
  fsRename: vi.fn(),
  fsDelete: vi.fn(),
  fsReveal: vi.fn(),
  fsQuickOpen: vi.fn(),
  clipboardSaveImage: vi.fn(),
  clipboardWriteText: vi.fn(),
  onFsChanged: vi.fn(),
  onFsRescan: vi.fn(),
  onWorkspacesChanged: vi.fn(),
  toAppError: vi.fn((e: unknown): AppError => {
    if (e && typeof e === "object" && "code" in e && "message" in e) return e as AppError;
    return { code: "io", message: String(e) };
  }),
}));

vi.mock("../lib/ipc", () => ipc);

function ws(id: string, name: string, expandedDirs: string[] = []): Workspace {
  return { id, name, path: `C:\\dev\\${name}`, expandedDirs };
}

function entries(...names: string[]): DirEntry[] {
  return names.map((n) => ({ name: n, rel: n, isDir: n.endsWith("/") }));
}

let fsChangedHandler: ((p: { workspaceId: string; dirs: string[] }) => void) | undefined;
let fsRescanHandler: ((p: { workspaceId: string }) => void) | undefined;
let workspacesChangedHandler: ((p: WorkspacesState) => void) | undefined;

async function freshStore() {
  vi.resetModules();
  fsChangedHandler = undefined;
  fsRescanHandler = undefined;
  workspacesChangedHandler = undefined;

  ipc.onFsChanged.mockImplementation((h: typeof fsChangedHandler) => {
    fsChangedHandler = h;
    return Promise.resolve(() => {});
  });
  ipc.onFsRescan.mockImplementation((h: typeof fsRescanHandler) => {
    fsRescanHandler = h;
    return Promise.resolve(() => {});
  });
  ipc.onWorkspacesChanged.mockImplementation((h: typeof workspacesChangedHandler) => {
    workspacesChangedHandler = h;
    return Promise.resolve(() => {});
  });

  const mod = await import("./workspaceStore");
  return mod.useWorkspaceStore;
}

beforeEach(() => {
  Object.values(ipc).forEach((fn) => {
    if (typeof fn === "function" && "mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  });
  ipc.toAppError.mockImplementation((e: unknown): AppError => {
    if (e && typeof e === "object" && "code" in e && "message" in e) return e as AppError;
    return { code: "io", message: String(e) };
  });
  ipc.workspaceList.mockResolvedValue({ workspaces: [], activeId: null });
  ipc.workspaceSetExpanded.mockResolvedValue(undefined);
});

describe("workspaceStore.init", () => {
  it("loads the workspace list and restores parent-first cached expanded dirs", async () => {
    const useWorkspaceStore = await freshStore();
    ipc.workspaceList.mockResolvedValue({
      workspaces: [ws("a", "a-ws", ["src/app", "src"])], // çocuk önce listede, sıralama parent-first olmalı
      activeId: "a",
    });
    const callOrder: string[] = [];
    ipc.fsReadDir.mockImplementation(async (_wsId: string, rel: string) => {
      callOrder.push(rel);
      return entries();
    });

    await useWorkspaceStore.getState().init();

    expect(callOrder).toEqual(["src", "src/app"]);
    expect(useWorkspaceStore.getState().activeId).toBe("a");
    expect([...(useWorkspaceStore.getState().expanded.a ?? [])].sort()).toEqual(["src", "src/app"]);
  });

  it("silently drops not_found dirs (and their descendants) from expanded on restore", async () => {
    const useWorkspaceStore = await freshStore();
    ipc.workspaceList.mockResolvedValue({
      workspaces: [ws("a", "a-ws", ["gone", "gone/child", "kept"])],
      activeId: "a",
    });
    ipc.fsReadDir.mockImplementation(async (_wsId: string, rel: string) => {
      if (rel === "gone" || rel === "gone/child") throw { code: "not_found", message: "yok" };
      return entries();
    });

    await useWorkspaceStore.getState().init();

    expect(useWorkspaceStore.getState().expanded.a).toEqual(new Set(["kept"]));
    // gone/child'ın fsReadDir'i hiç çağrılmamalı: ebeveyni zaten düşürüldü.
    expect(ipc.fsReadDir).not.toHaveBeenCalledWith("a", "gone/child");
  });

  it("merges restored expanded dirs into whatever is already expanded, instead of clobbering it (finding #8)", async () => {
    const useWorkspaceStore = await freshStore();
    ipc.workspaceList.mockResolvedValue({
      workspaces: [ws("a", "a-ws", ["persisted"])],
      activeId: "a",
    });

    let resolveRestore: (() => void) | undefined;
    ipc.fsReadDir.mockImplementation(async (_wsId: string, rel: string) => {
      if (rel === "persisted") {
        await new Promise<void>((resolve) => {
          resolveRestore = resolve;
        });
      }
      return entries();
    });

    const initPromise = useWorkspaceStore.getState().init();
    await vi.waitFor(() => expect(resolveRestore).toBeDefined());

    // The user toggles some unrelated dir open while `restoreExpanded` is still awaiting
    // `fsReadDir("persisted")`.
    useWorkspaceStore.getState().toggleExpanded("a", "other");
    expect(useWorkspaceStore.getState().expanded.a?.has("other")).toBe(true);

    resolveRestore!();
    await initPromise;

    // Before the fix, `restoreExpanded` replaced `expanded.a` wholesale with just the
    // persisted set, silently dropping the user's concurrent toggle.
    const finalExpanded = useWorkspaceStore.getState().expanded.a;
    expect(finalExpanded?.has("other")).toBe(true);
    expect(finalExpanded?.has("persisted")).toBe(true);
  });
});

describe("fs:changed handling", () => {
  it("only re-reads directories that are already in the cache", async () => {
    const useWorkspaceStore = await freshStore();
    ipc.workspaceList.mockResolvedValue({ workspaces: [ws("a", "a-ws")], activeId: "a" });
    await useWorkspaceStore.getState().init();

    // "src" ağaçta açılıp yüklenmiş (cache'te var); "docs" hiç açılmamış (cache'te yok).
    ipc.fsReadDir.mockResolvedValue(entries());
    useWorkspaceStore.getState().toggleExpanded("a", "src");
    await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalledWith("a", "src"));

    ipc.fsReadDir.mockClear();
    expect(fsChangedHandler).toBeDefined();
    fsChangedHandler!({ workspaceId: "a", dirs: ["src", "docs"] });

    await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalledWith("a", "src"));
    expect(ipc.fsReadDir).not.toHaveBeenCalledWith("a", "docs");
    expect(ipc.fsReadDir).toHaveBeenCalledTimes(1);
  });

  it("fs:rescan re-reads every cached directory for that workspace", async () => {
    const useWorkspaceStore = await freshStore();
    ipc.workspaceList.mockResolvedValue({ workspaces: [ws("a", "a-ws")], activeId: "a" });
    await useWorkspaceStore.getState().init();

    ipc.fsReadDir.mockResolvedValue(entries());
    useWorkspaceStore.getState().toggleExpanded("a", "src");
    await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalledWith("a", "src"));
    useWorkspaceStore.getState().toggleExpanded("a", "docs");
    await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalledWith("a", "docs"));

    ipc.fsReadDir.mockClear();
    fsRescanHandler!({ workspaceId: "a" });

    await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalledTimes(2)); // yalnızca cache'te olan: src + docs
    expect(ipc.fsReadDir).toHaveBeenCalledWith("a", "src");
    expect(ipc.fsReadDir).toHaveBeenCalledWith("a", "docs");
  });
});

describe("workspaces:changed handling", () => {
  it("removes cache/expanded/selected state for workspaces no longer in the list", async () => {
    const useWorkspaceStore = await freshStore();
    ipc.workspaceList.mockResolvedValue({ workspaces: [ws("a", "a-ws")], activeId: "a" });
    await useWorkspaceStore.getState().init();
    ipc.fsReadDir.mockResolvedValue(entries());
    useWorkspaceStore.getState().toggleExpanded("a", "src");
    await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalledWith("a", "src"));
    useWorkspaceStore.getState().select("a", "src");

    workspacesChangedHandler!({ workspaces: [], activeId: null });

    const s = useWorkspaceStore.getState();
    expect(s.workspaces).toEqual([]);
    expect(s.dirCache.a).toBeUndefined();
    expect(s.expanded.a).toBeUndefined();
    expect(s.selected).toBeNull();
  });

  it("expands the root of a newly activated workspace, but not on unrelated updates", async () => {
    const useWorkspaceStore = await freshStore();
    ipc.workspaceList.mockResolvedValue({ workspaces: [ws("a", "a-ws"), ws("b", "b-ws")], activeId: "a" });
    await useWorkspaceStore.getState().init();
    ipc.fsReadDir.mockResolvedValue(entries("README.md"));

    workspacesChangedHandler!({ workspaces: [ws("a", "a-ws"), ws("b", "b-ws")], activeId: "b" });
    await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalledWith("b", ""));
    expect(useWorkspaceStore.getState().expanded.b?.has("")).toBe(true);

    // Kullanıcı aktif kökü kapattı; aktif değişmeyen bir güncelleme (ör. rename) onu yeniden açmaz.
    useWorkspaceStore.getState().toggleExpanded("b", "");
    workspacesChangedHandler!({ workspaces: [ws("a", "a-ws"), ws("b", "b-renamed")], activeId: "b" });
    expect(useWorkspaceStore.getState().expanded.b?.has("")).toBe(false);
  });

  it("expands and loads the root of a newly added workspace", async () => {
    const useWorkspaceStore = await freshStore();
    ipc.workspaceList.mockResolvedValue({ workspaces: [], activeId: null });
    await useWorkspaceStore.getState().init();

    ipc.fsReadDir.mockResolvedValue(entries("README.md"));
    workspacesChangedHandler!({ workspaces: [ws("a", "a-ws")], activeId: "a" });

    await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalledWith("a", ""));
    expect(useWorkspaceStore.getState().expanded.a?.has("")).toBe(true);
  });

  it("persists the default-expanded root of a newly added workspace (finding #12)", async () => {
    const useWorkspaceStore = await freshStore();
    ipc.workspaceList.mockResolvedValue({ workspaces: [], activeId: null });
    await useWorkspaceStore.getState().init();
    ipc.fsReadDir.mockResolvedValue(entries("README.md"));

    vi.useFakeTimers();
    try {
      workspacesChangedHandler!({ workspaces: [ws("a", "a-ws")], activeId: "a" });
      // Before the fix nothing ever scheduled a save for this root, so it collapsed
      // again after a restart.
      await vi.advanceTimersByTimeAsync(500);
      expect(ipc.workspaceSetExpanded).toHaveBeenCalledWith("a", [""]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("renameEntry", () => {
  it("moves nested dirCache/expanded prefixes under the renamed folder, and selects the renamed item", async () => {
    const useWorkspaceStore = await freshStore();
    ipc.workspaceList.mockResolvedValue({ workspaces: [ws("a", "a-ws")], activeId: "a" });
    await useWorkspaceStore.getState().init();

    ipc.fsReadDir.mockResolvedValue(entries());
    useWorkspaceStore.getState().toggleExpanded("a", "old");
    await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalledWith("a", "old"));
    useWorkspaceStore.getState().toggleExpanded("a", "old/nested");
    await vi.waitFor(() => expect(ipc.fsReadDir).toHaveBeenCalledWith("a", "old/nested"));

    ipc.fsRename.mockResolvedValue("renamed");
    ipc.fsReadDir.mockResolvedValue(entries());
    await useWorkspaceStore.getState().renameEntry("a", "old", "renamed");

    const s = useWorkspaceStore.getState();
    // Eski önekli anahtarlar yeni öneke taşınmış olmalı, eskileri kalmamalı.
    expect(s.expanded.a?.has("renamed")).toBe(true);
    expect(s.expanded.a?.has("renamed/nested")).toBe(true);
    expect(s.expanded.a?.has("old")).toBe(false);
    expect(s.expanded.a?.has("old/nested")).toBe(false);
    expect(s.dirCache.a?.["renamed/nested"]).toBeDefined();
    expect(s.dirCache.a?.["old/nested"]).toBeUndefined();
    // Yeniden adlandırılan öğenin kendisi seçili olur.
    expect(s.selected).toEqual({ workspaceId: "a", rel: "renamed" });
  });
});
