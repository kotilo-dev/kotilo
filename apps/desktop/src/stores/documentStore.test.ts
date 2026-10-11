import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "../lib/ipc";

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

vi.mock("../lib/ipc", () => ipc);

let fsChangedHandler: ((p: { workspaceId: string; dirs: string[] }) => void) | undefined;
let fsRescanHandler: ((p: { workspaceId: string }) => void) | undefined;

function textFile(overrides: Partial<{ text: string; encoding: string; eol: string; mixedEol: boolean; hash: string; readOnly: boolean }> = {}) {
  return {
    text: "hello",
    encoding: "utf8" as const,
    eol: "lf" as const,
    mixedEol: false,
    hash: "h1",
    mtimeMs: 1000,
    size: 5,
    readOnly: false,
    readOnlyReason: null,
    ...overrides,
  };
}

async function freshStore() {
  vi.resetModules();
  fsChangedHandler = undefined;
  fsRescanHandler = undefined;

  ipc.onFsChanged.mockImplementation((h: typeof fsChangedHandler) => {
    fsChangedHandler = h;
    return Promise.resolve(() => {});
  });
  ipc.onFsRescan.mockImplementation((h: typeof fsRescanHandler) => {
    fsRescanHandler = h;
    return Promise.resolve(() => {});
  });

  const mod = await import("./documentStore");
  return mod;
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

describe("load / dirty / setText", () => {
  it("loads a document as ready with dirty=false", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile());

    await useDocumentStore.getState().load("ws1", "a.txt");

    const doc = useDocumentStore.getState().docs[docKey("ws1", "a.txt")];
    expect(doc?.status).toBe("ready");
    expect(doc?.text).toBe("hello");
    expect(doc?.dirty).toBe(false);
  });

  it("setText marks dirty only when text differs from savedText, and clears when it matches again", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile());
    await useDocumentStore.getState().load("ws1", "a.txt");

    useDocumentStore.getState().setText("ws1", "a.txt", "hello world");
    expect(useDocumentStore.getState().docs[docKey("ws1", "a.txt")]?.dirty).toBe(true);

    useDocumentStore.getState().setText("ws1", "a.txt", "hello");
    expect(useDocumentStore.getState().docs[docKey("ws1", "a.txt")]?.dirty).toBe(false);
  });

  it("a second load() for the same key does not re-read the file (refcount only)", async () => {
    const { useDocumentStore } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile());

    await useDocumentStore.getState().load("ws1", "a.txt");
    await useDocumentStore.getState().load("ws1", "a.txt");

    expect(ipc.fsReadText).toHaveBeenCalledTimes(1);
  });

  it("release() frees the document only after the matching number of load() calls", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile());

    await useDocumentStore.getState().load("ws1", "a.txt");
    await useDocumentStore.getState().load("ws1", "a.txt"); // two tabs show it

    useDocumentStore.getState().release("ws1", "a.txt");
    expect(useDocumentStore.getState().docs[docKey("ws1", "a.txt")]).toBeDefined();

    useDocumentStore.getState().release("ws1", "a.txt");
    expect(useDocumentStore.getState().docs[docKey("ws1", "a.txt")]).toBeUndefined();
  });

  it("binary_file / other read errors produce a status:'error' doc", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockRejectedValue({ code: "binary_file", message: "binary" });

    await useDocumentStore.getState().load("ws1", "a.bin");

    const doc = useDocumentStore.getState().docs[docKey("ws1", "a.bin")];
    expect(doc?.status).toBe("error");
    expect(doc?.error?.code).toBe("binary_file");
  });
});

describe("transient vs. persistent load errors (finding #10)", () => {
  it("a transient error (e.g. io) is retried on the next load() for the same key", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockRejectedValueOnce({ code: "io", message: "locked" });
    await useDocumentStore.getState().load("ws1", "a.txt");
    expect(useDocumentStore.getState().docs[docKey("ws1", "a.txt")]?.status).toBe("error");

    ipc.fsReadText.mockResolvedValueOnce(textFile({ text: "ok" }));
    await useDocumentStore.getState().load("ws1", "a.txt");

    expect(ipc.fsReadText).toHaveBeenCalledTimes(2);
    expect(useDocumentStore.getState().docs[docKey("ws1", "a.txt")]?.status).toBe("ready");
  });

  it("a persistent error (binary_file) is not retried — the cached error doc is reused", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockRejectedValue({ code: "binary_file", message: "binary" });
    await useDocumentStore.getState().load("ws1", "a.bin");
    await useDocumentStore.getState().load("ws1", "a.bin"); // second tab showing the same file

    expect(ipc.fsReadText).toHaveBeenCalledTimes(1);
    expect(useDocumentStore.getState().docs[docKey("ws1", "a.bin")]?.status).toBe("error");
  });

  it("a persistent error (too_large) is not retried either", async () => {
    const { useDocumentStore } = await freshStore();
    ipc.fsReadText.mockRejectedValue({ code: "too_large", message: "huge" });
    await useDocumentStore.getState().load("ws1", "huge.bin");
    await useDocumentStore.getState().load("ws1", "huge.bin");

    expect(ipc.fsReadText).toHaveBeenCalledTimes(1);
  });
});

describe("save", () => {
  it("on success: savedText becomes the pre-save snapshot, hash updates, dirty reflects text vs snapshot (§5.15)", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ text: "v1", hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "a.txt");
    useDocumentStore.getState().setText("ws1", "a.txt", "v2");

    let resolveWrite: ((r: { hash: string; mtimeMs: number }) => void) | undefined;
    ipc.fsWriteText.mockReturnValue(
      new Promise((resolve) => {
        resolveWrite = resolve;
      }),
    );

    const savePromise = useDocumentStore.getState().save("ws1", "a.txt");
    // While the write is in flight, the user keeps typing.
    useDocumentStore.getState().setText("ws1", "a.txt", "v2-and-more");

    resolveWrite!({ hash: "h2", mtimeMs: 2000 });
    await savePromise;

    const doc = useDocumentStore.getState().docs[docKey("ws1", "a.txt")];
    expect(doc?.savedText).toBe("v2"); // the snapshot taken at save-start, not the latest text
    expect(doc?.hash).toBe("h2");
    expect(doc?.dirty).toBe(true); // "v2-and-more" !== "v2"
    expect(ipc.fsWriteText).toHaveBeenCalledWith("ws1", "a.txt", "v2", "utf8", "lf", "h1");
  });

  it("finding #2: a read-only document is never written — save() is a no-op returning null", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ text: "v1", hash: "h1", readOnly: true }));
    await useDocumentStore.getState().load("ws1", "big.txt");

    const err = await useDocumentStore.getState().save("ws1", "big.txt");

    expect(err).toBeNull();
    expect(ipc.fsWriteText).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().docs[docKey("ws1", "big.txt")]?.savedText).toBe("v1");
  });

  it("finding #5: two overlapping save() calls never write concurrently; the second re-checks dirty with the fresh hash", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ text: "v1", hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "a.txt");
    useDocumentStore.getState().setText("ws1", "a.txt", "v2");

    let resolveFirst: ((r: { hash: string; mtimeMs: number }) => void) | undefined;
    ipc.fsWriteText.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    ipc.fsWriteText.mockResolvedValueOnce({ hash: "h3", mtimeMs: 3000 });

    const save1 = useDocumentStore.getState().save("ws1", "a.txt");
    // More edits land while the first write is still in flight.
    useDocumentStore.getState().setText("ws1", "a.txt", "v3");
    const save2 = useDocumentStore.getState().save("ws1", "a.txt");

    expect(ipc.fsWriteText).toHaveBeenCalledTimes(1); // save2 must NOT fire a concurrent write

    resolveFirst!({ hash: "h2", mtimeMs: 2000 });
    await Promise.all([save1, save2]);

    expect(ipc.fsWriteText).toHaveBeenCalledTimes(2);
    // The second write uses the hash the first write produced — never a stale `expectedHash`.
    expect(ipc.fsWriteText).toHaveBeenLastCalledWith("ws1", "a.txt", "v3", "utf8", "lf", "h2");
    const doc = useDocumentStore.getState().docs[docKey("ws1", "a.txt")];
    expect(doc?.hash).toBe("h3");
    expect(doc?.dirty).toBe(false);
  });

  it("finding #5: a queued save is a no-op (no second write) if nothing changed while the first was in flight", async () => {
    const { useDocumentStore } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ text: "v1", hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "a.txt");
    useDocumentStore.getState().setText("ws1", "a.txt", "v2");

    let resolveFirst: ((r: { hash: string; mtimeMs: number }) => void) | undefined;
    ipc.fsWriteText.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));

    const save1 = useDocumentStore.getState().save("ws1", "a.txt");
    const save2 = useDocumentStore.getState().save("ws1", "a.txt"); // no edits in between

    resolveFirst!({ hash: "h2", mtimeMs: 2000 });
    await Promise.all([save1, save2]);

    expect(ipc.fsWriteText).toHaveBeenCalledTimes(1);
  });

  it("conflict: does not update savedText/hash, instead sets `external` from a fresh fs_stat", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ text: "v1", hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "a.txt");
    useDocumentStore.getState().setText("ws1", "a.txt", "v2");

    ipc.fsWriteText.mockRejectedValue({ code: "conflict", message: "conflict" });
    ipc.fsStat.mockResolvedValue({ size: 10, mtimeMs: 999, hash: "diskhash" });

    const err = await useDocumentStore.getState().save("ws1", "a.txt");

    expect(err?.code).toBe("conflict");
    const doc = useDocumentStore.getState().docs[docKey("ws1", "a.txt")];
    expect(doc?.savedText).toBe("v1");
    expect(doc?.hash).toBe("h1");
    expect(doc?.external).toEqual({ hash: "diskhash" });
  });
});

describe("external change via fs:changed / fs:rescan", () => {
  it("same hash on disk (our own save reflected back): no-op, no reload", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "dir/a.txt");
    ipc.fsStat.mockResolvedValue({ size: 5, mtimeMs: 111, hash: "h1" });

    fsChangedHandler!({ workspaceId: "ws1", dirs: ["dir"] });
    await vi.waitFor(() => expect(ipc.fsStat).toHaveBeenCalled());

    const doc = useDocumentStore.getState().docs[docKey("ws1", "dir/a.txt")];
    expect(doc?.external).toBeNull();
    expect(ipc.fsReadText).toHaveBeenCalledTimes(1); // only the initial load, no reload
  });

  it("different hash, clean document: silently reloads", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ text: "old", hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "dir/a.txt");

    ipc.fsStat.mockResolvedValue({ size: 8, mtimeMs: 222, hash: "h2" });
    ipc.fsReadText.mockResolvedValue(textFile({ text: "new-from-disk", hash: "h2" }));

    fsChangedHandler!({ workspaceId: "ws1", dirs: ["dir"] });
    await vi.waitFor(() => {
      const doc = useDocumentStore.getState().docs[docKey("ws1", "dir/a.txt")];
      expect(doc?.text).toBe("new-from-disk");
    });

    const doc = useDocumentStore.getState().docs[docKey("ws1", "dir/a.txt")];
    expect(doc?.dirty).toBe(false);
    expect(doc?.external).toBeNull();
  });

  it("different hash, dirty document: sets `external` instead of reloading (banner)", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ text: "old", hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "dir/a.txt");
    useDocumentStore.getState().setText("ws1", "dir/a.txt", "my local edit");

    ipc.fsStat.mockResolvedValue({ size: 8, mtimeMs: 222, hash: "h2" });

    fsChangedHandler!({ workspaceId: "ws1", dirs: ["dir"] });
    await vi.waitFor(() => {
      const doc = useDocumentStore.getState().docs[docKey("ws1", "dir/a.txt")];
      expect(doc?.external).not.toBeNull();
    });

    const doc = useDocumentStore.getState().docs[docKey("ws1", "dir/a.txt")];
    expect(doc?.text).toBe("my local edit"); // local edit preserved
    expect(doc?.external).toEqual({ hash: "h2" });
    expect(doc?.dirty).toBe(true);
  });

  it("keepMine clears `external` and adopts the disk hash so the next save overwrites", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ text: "old", hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "dir/a.txt");
    useDocumentStore.getState().setText("ws1", "dir/a.txt", "my local edit");
    ipc.fsStat.mockResolvedValue({ size: 8, mtimeMs: 222, hash: "h2" });
    fsChangedHandler!({ workspaceId: "ws1", dirs: ["dir"] });
    await vi.waitFor(() => expect(useDocumentStore.getState().docs[docKey("ws1", "dir/a.txt")]?.external).not.toBeNull());

    useDocumentStore.getState().keepMine("ws1", "dir/a.txt");

    const doc = useDocumentStore.getState().docs[docKey("ws1", "dir/a.txt")];
    expect(doc?.external).toBeNull();
    expect(doc?.hash).toBe("h2");
    expect(doc?.text).toBe("my local edit");
  });

  it("ignores changes to unrelated directories", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "dir/a.txt");

    fsChangedHandler!({ workspaceId: "ws1", dirs: ["other-dir"] });
    await Promise.resolve();

    expect(ipc.fsStat).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().docs[docKey("ws1", "dir/a.txt")]?.hash).toBe("h1");
  });

  it("fs:rescan re-checks every loaded document for that workspace regardless of dirs", async () => {
    const { useDocumentStore } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "a.txt");
    await useDocumentStore.getState().load("ws1", "deep/b.txt");
    ipc.fsStat.mockResolvedValue({ size: 1, mtimeMs: 1, hash: "h1" });

    fsRescanHandler!({ workspaceId: "ws1" });

    await vi.waitFor(() => expect(ipc.fsStat).toHaveBeenCalledTimes(2));
  });

  it("finding #3: if the document becomes dirty while the silent reload's fs_read_text is in flight, the local edit is preserved and a banner is shown instead of being clobbered", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ text: "old", hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "dir/a.txt");

    ipc.fsStat.mockResolvedValue({ size: 1, mtimeMs: 1, hash: "h2" });
    let resolveReload: ((f: ReturnType<typeof textFile>) => void) | undefined;
    ipc.fsReadText.mockReturnValue(
      new Promise((resolve) => {
        resolveReload = resolve;
      }),
    );

    fsChangedHandler!({ workspaceId: "ws1", dirs: ["dir"] });
    await vi.waitFor(() => expect(ipc.fsReadText).toHaveBeenCalledTimes(2)); // initial load + this reload attempt

    // The user starts typing while the reload's fs_read_text is still in flight.
    useDocumentStore.getState().setText("ws1", "dir/a.txt", "my edit while reloading");

    resolveReload!(textFile({ text: "from-disk", hash: "h2" }));
    await vi.waitFor(() => expect(useDocumentStore.getState().docs[docKey("ws1", "dir/a.txt")]?.external).not.toBeNull());

    const doc = useDocumentStore.getState().docs[docKey("ws1", "dir/a.txt")];
    expect(doc?.text).toBe("my edit while reloading"); // never overwritten by the disk version
    expect(doc?.dirty).toBe(true);
  });

  it("finding #3: a document released while the silent reload's fs_read_text is in flight is not resurrected", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ text: "old", hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "dir/a.txt");

    ipc.fsStat.mockResolvedValue({ size: 1, mtimeMs: 1, hash: "h2" });
    let resolveReload: ((f: ReturnType<typeof textFile>) => void) | undefined;
    ipc.fsReadText.mockReturnValue(
      new Promise((resolve) => {
        resolveReload = resolve;
      }),
    );

    fsChangedHandler!({ workspaceId: "ws1", dirs: ["dir"] });
    await vi.waitFor(() => expect(ipc.fsReadText).toHaveBeenCalledTimes(2));

    useDocumentStore.getState().release("ws1", "dir/a.txt"); // the tab closed

    resolveReload!(textFile({ text: "from-disk", hash: "h2" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(useDocumentStore.getState().docs[docKey("ws1", "dir/a.txt")]).toBeUndefined();
  });

  it("finding #3: the explicit reload() action does not resurrect a document released while it was in flight", async () => {
    const { useDocumentStore, docKey } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ text: "old", hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "a.txt");

    let resolveReload: ((f: ReturnType<typeof textFile>) => void) | undefined;
    ipc.fsReadText.mockReturnValue(
      new Promise((resolve) => {
        resolveReload = resolve;
      }),
    );
    const reloadPromise = useDocumentStore.getState().reload("ws1", "a.txt");

    useDocumentStore.getState().release("ws1", "a.txt");
    resolveReload!(textFile({ text: "from-disk", hash: "h2" }));
    await reloadPromise;

    expect(useDocumentStore.getState().docs[docKey("ws1", "a.txt")]).toBeUndefined();
  });

  it("finding #11: an announced ancestor directory triggers a recheck for a document nested deeper inside it", async () => {
    const { useDocumentStore } = await freshStore();
    ipc.fsReadText.mockResolvedValue(textFile({ hash: "h1" }));
    await useDocumentStore.getState().load("ws1", "old/deep/nested/a.txt");
    ipc.fsStat.mockResolvedValue({ size: 1, mtimeMs: 1, hash: "h1" });

    // The backend only reports the renamed/deleted dir's *parent* — not "old/deep/nested" itself.
    fsChangedHandler!({ workspaceId: "ws1", dirs: [""] });

    await vi.waitFor(() => expect(ipc.fsStat).toHaveBeenCalledWith("ws1", "old/deep/nested/a.txt"));
  });

  it("re-checks are deferred while the document is still loading, and run once it settles (§5.15)", async () => {
    const { useDocumentStore } = await freshStore();
    let resolveRead: ((f: ReturnType<typeof textFile>) => void) | undefined;
    ipc.fsReadText.mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );

    const loadPromise = useDocumentStore.getState().load("ws1", "dir/a.txt");
    // fs:changed arrives while still "loading" — must not crash / must not stat yet.
    fsChangedHandler!({ workspaceId: "ws1", dirs: ["dir"] });
    await Promise.resolve();
    expect(ipc.fsStat).not.toHaveBeenCalled();

    ipc.fsStat.mockResolvedValue({ size: 1, mtimeMs: 1, hash: "different" });
    resolveRead!(textFile({ hash: "h1" }));
    await loadPromise;

    await vi.waitFor(() => expect(ipc.fsStat).toHaveBeenCalledTimes(1));
    // Not dirty (fresh load) + different hash => silent reload should have been attempted.
    expect(ipc.fsReadText).toHaveBeenCalledTimes(2);
  });
});
