import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({ onHubEvent: vi.fn(), onHubStatus: vi.fn() }));

import { setHubNotificationHandler, useHubStore } from "./hubStore";
import type { NotificationDto } from "../lib/hubTypes";

describe("hubStore", () => {
  beforeEach(() => {
    useHubStore.setState({ connected: false, sessions: [], usage: null, limits: [], health: null, taskCounts: null });
    setHubNotificationHandler(null);
  });

  it("stores snapshot frames by type", () => {
    useHubStore.getState().apply({ type: "sessions", data: [] });
    useHubStore.getState().apply({ type: "limits", data: [{ agent: "codex", window: "weekly", usedPercent: 31, resetsAt: null } as never] });
    expect(useHubStore.getState().limits).toHaveLength(1);
  });

  it("hands notifications to the registered owner only", () => {
    const shown: NotificationDto[] = [];
    useHubStore.getState().apply({ type: "notification", data: { ruleId: "x" } as NotificationDto });
    setHubNotificationHandler((n) => shown.push(n));
    useHubStore.getState().apply({ type: "notification", data: { ruleId: "y" } as NotificationDto });
    expect(shown.map((n) => n.ruleId)).toEqual(["y"]);
  });
});
