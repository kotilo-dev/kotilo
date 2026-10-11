import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  deepMergeSettings,
  hydrateSettingsStore,
  resetSettingsStoreForTest,
  useSettingsStore,
} from "./settingsStore";
import type { Settings } from "../lib/ipc";

const ipc = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
  toAppError: vi.fn((e: unknown) => (e as { code: string; message: string }) ?? { code: "io", message: "io" }),
}));

vi.mock("../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../lib/ipc")>("../lib/ipc");
  return { ...actual, ...ipc };
});

/** Kontrollü çözülebilen promise — sıralı yazımları adım adım test etmek için. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("deepMergeSettings", () => {
  it("merges nested objects field by field", () => {
    const merged = deepMergeSettings(DEFAULT_SETTINGS, { editor: { fontSize: 16 } });
    expect(merged.editor.fontSize).toBe(16);
    expect(merged.editor.fontFamily).toBe(DEFAULT_SETTINGS.editor.fontFamily);
  });

  it("replaces arrays wholesale rather than merging elements", () => {
    const merged = deepMergeSettings(DEFAULT_SETTINGS, { agents: { commands: ["foo"] } });
    expect(merged.agents.commands).toEqual(["foo"]);
  });

  it("returns the base unchanged when patch is undefined", () => {
    expect(deepMergeSettings(DEFAULT_SETTINGS, undefined)).toBe(DEFAULT_SETTINGS);
  });
});

describe("useSettingsStore", () => {
  beforeEach(() => {
    resetSettingsStoreForTest();
    ipc.settingsGet.mockReset();
    ipc.settingsSet.mockReset();
  });

  it("starts not ready and becomes ready with server settings after init()", async () => {
    ipc.settingsGet.mockResolvedValue({ ...DEFAULT_SETTINGS, theme: "light" });
    expect(useSettingsStore.getState().ready).toBe(false);

    await useSettingsStore.getState().init();

    expect(useSettingsStore.getState().ready).toBe(true);
    expect(useSettingsStore.getState().settings.theme).toBe("light");
  });

  it("falls back to defaults if settings_get rejects", async () => {
    ipc.settingsGet.mockRejectedValue(new Error("nope"));
    await useSettingsStore.getState().init();
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(useSettingsStore.getState().ready).toBe(true);
  });

  it("hydrateSettingsStore seeds state synchronously (used by main.tsx pre-render)", () => {
    const settings = { ...DEFAULT_SETTINGS, theme: "light" as const };
    hydrateSettingsStore(settings);
    expect(useSettingsStore.getState().ready).toBe(true);
    expect(useSettingsStore.getState().settings.theme).toBe("light");
  });

  it("update() applies the patch to local state immediately (optimistic)", async () => {
    ipc.settingsGet.mockResolvedValue(DEFAULT_SETTINGS);
    await useSettingsStore.getState().init();
    const pending = deferred<Settings>();
    ipc.settingsSet.mockReturnValue(pending.promise);

    useSettingsStore.getState().update({ editor: { fontSize: 20 } });

    // Sunucu henüz yanıt vermeden önce bile local state güncel.
    expect(useSettingsStore.getState().settings.editor.fontSize).toBe(20);
    expect(ipc.settingsSet).toHaveBeenCalledTimes(1);

    pending.resolve({ ...DEFAULT_SETTINGS, editor: { ...DEFAULT_SETTINGS.editor, fontSize: 20 } });
    await Promise.resolve();
    await Promise.resolve();
  });

  it("serializes writes: rapid updates while one is in flight send only the latest merged state next", async () => {
    ipc.settingsGet.mockResolvedValue(DEFAULT_SETTINGS);
    await useSettingsStore.getState().init();
    const first = deferred<Settings>();
    ipc.settingsSet.mockReturnValueOnce(first.promise);

    useSettingsStore.getState().update({ editor: { fontSize: 14 } });
    useSettingsStore.getState().update({ editor: { fontSize: 15 } });
    useSettingsStore.getState().update({ editor: { fontSize: 16 } });

    // Yalnızca ilk çağrı hemen gitti; sonrakiler kuyrukta birikti (üzerine yazıldı).
    expect(ipc.settingsSet).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().settings.editor.fontSize).toBe(16);

    const second = deferred<Settings>();
    ipc.settingsSet.mockReturnValueOnce(second.promise);
    first.resolve({ ...DEFAULT_SETTINGS, editor: { ...DEFAULT_SETTINGS.editor, fontSize: 14 } });
    await Promise.resolve();
    await Promise.resolve();

    // İlk istek çözülünce kuyruktaki EN SON tam state (16) tek bir ikinci çağrıyla gönderildi.
    expect(ipc.settingsSet).toHaveBeenCalledTimes(2);
    expect(ipc.settingsSet.mock.calls[1]?.[0].editor.fontSize).toBe(16);

    second.resolve({ ...DEFAULT_SETTINGS, editor: { ...DEFAULT_SETTINGS.editor, fontSize: 16 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(ipc.settingsSet).toHaveBeenCalledTimes(2);
  });

  it("updates `confirmed` only after settings_set resolves (live: tree reload lagged one step)", async () => {
    hydrateSettingsStore(DEFAULT_SETTINGS);
    const d = deferred<Settings>();
    ipc.settingsSet.mockReturnValueOnce(d.promise);
    useSettingsStore.getState().update({ files: { respectGitignore: true } });
    expect(useSettingsStore.getState().settings.files.respectGitignore).toBe(true);
    expect(useSettingsStore.getState().confirmed.files.respectGitignore).toBe(false);
    const server = deepMergeSettings(DEFAULT_SETTINGS, { files: { respectGitignore: true } });
    d.resolve(server);
    await d.promise;
    await Promise.resolve();
    expect(useSettingsStore.getState().confirmed).toEqual(server);
  });

  it("reverts to the last server-confirmed value and sets lastError when settings_set rejects", async () => {
    ipc.settingsGet.mockResolvedValue(DEFAULT_SETTINGS);
    await useSettingsStore.getState().init();
    const pending = deferred<Settings>();
    ipc.settingsSet.mockReturnValue(pending.promise);

    useSettingsStore.getState().update({ editor: { fontSize: 99 } });
    expect(useSettingsStore.getState().settings.editor.fontSize).toBe(99);

    pending.reject({ code: "invalid_argument", message: "bad" });
    await Promise.resolve();
    await Promise.resolve();

    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(useSettingsStore.getState().lastError).toEqual({ code: "invalid_argument", message: "bad" });
  });

  it("does not subscribe to a settings:changed event (review #12: removed — pure echo in this single-window app)", async () => {
    // `../lib/ipc` no longer exports `onSettingsChanged` at all; this is a compile-time
    // guarantee (see settingsStore.ts import list) as much as a runtime one. The remaining
    // behavioural guarantee is that a stale server response can never clobber a later write —
    // covered by the "serializes writes" test above (only the queue's `settings_set` response
    // is ever applied).
    expect((ipc as Record<string, unknown>).onSettingsChanged).toBeUndefined();
  });
});
