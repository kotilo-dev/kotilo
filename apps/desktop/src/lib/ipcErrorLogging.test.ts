import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
}));
const plugin = vi.hoisted(() => ({
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", async () => {
  const actual = await vi.importActual<typeof import("@tauri-apps/api/core")>("@tauri-apps/api/core");
  return { ...actual, invoke: core.invoke };
});
vi.mock("@tauri-apps/plugin-log", () => plugin);

import { fsReadDir, fsStat, fsWriteText, ptyKill, ptyResize, ptyWrite, saveStateSlice, workspaceList } from "./ipc";
import { resetLoggingForTest } from "./logging";

describe("ipc.ts central error logging (faz7-spec §9.5)", () => {
  beforeEach(() => {
    resetLoggingForTest();
    core.invoke.mockReset();
    plugin.warn.mockClear();
    plugin.error.mockClear();
    delete window.__agenthubCrashed;
  });

  it("logs `[ipc] <command> failed: <code> <message>` on a rejected AppError", async () => {
    core.invoke.mockRejectedValue({ code: "not_a_directory", message: "not a folder" });
    await expect(workspaceList()).rejects.toEqual({ code: "not_a_directory", message: "not a folder" });
    expect(plugin.warn).toHaveBeenCalledWith("[ipc] workspace_list failed: not_a_directory not a folder");
  });

  it("rethrows the original rejection unchanged (error-propagation behaviour is untouched)", async () => {
    const original = { code: "invalid_argument", message: "bad" };
    core.invoke.mockRejectedValue(original);
    await expect(workspaceList()).rejects.toBe(original);
  });

  it("never logs the call's arguments", async () => {
    core.invoke.mockRejectedValue({ code: "io", message: "boom" });
    await expect(fsReadDir("secret-workspace-id", "secret/rel")).rejects.toBeDefined();
    const loggedText = plugin.warn.mock.calls.map((c) => c[0]).join("\n");
    expect(loggedText).not.toContain("secret-workspace-id");
    expect(loggedText).not.toContain("secret/rel");
  });

  it("does not log on success", async () => {
    core.invoke.mockResolvedValue({ workspaces: [], activeId: null });
    await workspaceList();
    expect(plugin.warn).not.toHaveBeenCalled();
    expect(plugin.error).not.toHaveBeenCalled();
  });

  describe("exempt (command, code) pairs", () => {
    it("fs_write_text/conflict is not logged", async () => {
      core.invoke.mockRejectedValue({ code: "conflict", message: "changed on disk" });
      await expect(fsWriteText("ws", "f.txt", "x", "utf8", "lf", "hash")).rejects.toBeDefined();
      expect(plugin.warn).not.toHaveBeenCalled();
    });

    it("fs_stat/not_found is not logged", async () => {
      core.invoke.mockRejectedValue({ code: "not_found", message: "gone" });
      await expect(fsStat("ws", "f.txt")).rejects.toBeDefined();
      expect(plugin.warn).not.toHaveBeenCalled();
    });

    it.each(["pty_write", "pty_resize", "pty_kill"] as const)("%s/not_found is not logged", async () => {
      core.invoke.mockRejectedValue({ code: "not_found", message: "gone" });
      await expect(ptyWrite("pane1", "x")).rejects.toBeDefined();
      await expect(ptyResize("pane1", 80, 24)).rejects.toBeDefined();
      await expect(ptyKill("pane1")).rejects.toBeDefined();
      expect(plugin.warn).not.toHaveBeenCalled();
    });

    it("the SAME code is still logged for a DIFFERENT command (exemption is per-pair, not per-code)", async () => {
      core.invoke.mockRejectedValue({ code: "not_found", message: "gone" });
      await expect(workspaceList()).rejects.toBeDefined();
      expect(plugin.warn).toHaveBeenCalledWith("[ipc] workspace_list failed: not_found gone");
    });

    it("fs_write_text with a DIFFERENT code than conflict is still logged", async () => {
      core.invoke.mockRejectedValue({ code: "io", message: "disk full" });
      await expect(fsWriteText("ws", "f.txt", "x", "utf8", "lf", null)).rejects.toBeDefined();
      expect(plugin.warn).toHaveBeenCalledWith("[ipc] fs_write_text failed: io disk full");
    });
  });
});

describe("saveStateSlice crash guard (faz7-spec §9.4)", () => {
  beforeEach(() => {
    resetLoggingForTest();
    core.invoke.mockReset().mockResolvedValue(undefined);
    plugin.warn.mockClear();
    delete window.__agenthubCrashed;
  });

  it("writes normally while window.__agenthubCrashed is not set", async () => {
    await saveStateSlice("layout", { a: 1 });
    expect(core.invoke).toHaveBeenCalledWith("save_state_slice", { key: "layout", value: { a: 1 } });
  });

  it("skips the write once window.__agenthubCrashed is set", async () => {
    window.__agenthubCrashed = true;
    await saveStateSlice("layout", { a: 1 });
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("still writes when bypassCrashGuard is passed, even while crashed", async () => {
    window.__agenthubCrashed = true;
    await saveStateSlice("layout", {}, { bypassCrashGuard: true });
    expect(core.invoke).toHaveBeenCalledWith("save_state_slice", { key: "layout", value: {} });
  });
});
