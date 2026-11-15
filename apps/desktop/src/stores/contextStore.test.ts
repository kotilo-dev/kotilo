import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextReport } from "../lib/ipc";

const ipc = vi.hoisted(() => ({
  contextAgents: vi.fn(),
  contextReport: vi.fn(),
  contextRead: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({ ...ipc, toAppError: (e: unknown) => e }));

import { previewKey, reportKey, resetContextStoreForTests, useContextStore } from "./contextStore";

const report: ContextReport = {
  agent: "claude-code",
  supported: true,
  root: "C:\\src\\app",
  files: [],
  skills: [],
  mcp: [],
  sources: [],
  maxBytes: null,
  totals: { alwaysTokens: 0, onDemandTokens: 0, skillTokens: 0, alwaysBytes: 0 },
};
const target = { agent: "claude-code", path: "C:\\Users\\demo\\.claude\\CLAUDE.md", display: "~/.claude/CLAUDE.md" };

beforeEach(() => {
  resetContextStoreForTests();
  ipc.contextAgents.mockReset().mockResolvedValue([{ id: "claude-code", displayName: "Claude Code", supported: true }]);
  ipc.contextReport.mockReset().mockResolvedValue(report);
  ipc.contextRead.mockReset().mockResolvedValue({ text: "# Hi", truncated: false });
});

describe("contextStore", () => {
  it("loads the agent list once", async () => {
    await Promise.all([useContextStore.getState().loadAgents(), useContextStore.getState().loadAgents()]);
    await useContextStore.getState().loadAgents();
    expect(ipc.contextAgents).toHaveBeenCalledTimes(1);
    expect(useContextStore.getState().agents?.map((a) => a.id)).toEqual(["claude-code"]);
  });

  it("keeps a report per workspace and agent; ensure loads only once", async () => {
    useContextStore.getState().ensure("ws1", "claude-code");
    useContextStore.getState().ensure("ws1", "claude-code");
    expect(useContextStore.getState().reports[reportKey("ws1", "claude-code")]?.status).toBe("loading");
    await vi.waitFor(() => expect(useContextStore.getState().reports[reportKey("ws1", "claude-code")]?.status).toBe("ready"));
    expect(ipc.contextReport).toHaveBeenCalledTimes(1);
    expect(ipc.contextReport).toHaveBeenCalledWith("ws1", "claude-code");
    expect(useContextStore.getState().reports[reportKey("ws1", "codex")]).toBeUndefined();
  });

  it("keeps the last report on a failed refresh", async () => {
    await useContextStore.getState().refresh("ws1", "claude-code");
    ipc.contextReport.mockRejectedValueOnce({ code: "io", message: "boom" });
    await useContextStore.getState().refresh("ws1", "claude-code");
    const entry = useContextStore.getState().reports[reportKey("ws1", "claude-code")];
    expect(entry?.status).toBe("error");
    expect(entry?.report).toBe(report);
    expect(entry?.error).toEqual({ code: "io", message: "boom" });
  });

  it("reads a preview once and again after a refresh", async () => {
    useContextStore.getState().openPreview("ws1", target);
    const key = previewKey("ws1", "claude-code", target.path);
    await vi.waitFor(() => expect(useContextStore.getState().previews[key]?.status).toBe("ready"));
    expect(useContextStore.getState().previews[key]?.text).toBe("# Hi");
    useContextStore.getState().openPreview("ws1", target);
    expect(ipc.contextRead).toHaveBeenCalledTimes(1);

    ipc.contextRead.mockResolvedValueOnce({ text: "# Changed", truncated: true });
    await useContextStore.getState().refresh("ws1", "claude-code");
    await vi.waitFor(() => expect(useContextStore.getState().previews[key]?.text).toBe("# Changed"));
    expect(useContextStore.getState().previews[key]?.truncated).toBe(true);
    expect(ipc.contextRead).toHaveBeenCalledWith("ws1", "claude-code", target.path);

    useContextStore.getState().closePreview("ws1");
    expect(useContextStore.getState().preview.ws1).toBeNull();
  });

  it("records a read error", async () => {
    ipc.contextRead.mockRejectedValueOnce({ code: "invalid_argument", message: "not listed" });
    useContextStore.getState().openPreview("ws1", target);
    const key = previewKey("ws1", "claude-code", target.path);
    await vi.waitFor(() => expect(useContextStore.getState().previews[key]?.status).toBe("error"));
    expect(useContextStore.getState().previews[key]?.error?.code).toBe("invalid_argument");
  });
});
