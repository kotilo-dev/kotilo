import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const hubRequest = vi.fn();
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  hubRequest: (...args: unknown[]) => hubRequest(...args),
}));

import { OverviewPage } from "./OverviewPage";
import { useHubStore } from "../../stores/hubStore";
import { useRouteStore } from "../../stores/routeStore";
import { useI18nStore } from "../../app/i18n";
import type { SessionDto } from "../../lib/hubTypes";
import { recentProjects, splitSessions, blockProgress } from "./overviewLogic";

function session(partial: Partial<SessionDto>): SessionDto {
  return {
    sessionId: "s",
    agent: "claude-code",
    paneId: null,
    projectRoot: "C:/src/app",
    projectName: "app",
    state: "Idle",
    stateSince: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
    currentTool: null,
    model: "opus",
    tokens: 1200,
    costUsd: 1.24,
    contextUsedPercent: 41,
    lastCompletedAt: null,
    unseen: false,
    turnStartedAt: null,
    endedAt: null,
    activeSubagents: 0,
    lastNotification: null,
    error: null,
    tasks: null,
    pendingPermission: null,
    ...partial,
  };
}

beforeEach(() => {
  useI18nStore.setState({ preference: "en", language: "en" });
  hubRequest.mockReset().mockResolvedValue([]);
  useHubStore.setState({ connected: true, sessions: [], usage: null, limits: [], health: null });
});

describe("OverviewPage", () => {
  it("shows the not-running state when the hub is unreachable", () => {
    useHubStore.setState({ connected: false });
    render(<OverviewPage />);
    expect(screen.getByText("Background service not running")).toBeInTheDocument();
  });

  it("summarises sessions, shows the limit strip and links to mission control", async () => {
    useHubStore.setState({
      sessions: [
        session({ sessionId: "a", projectName: "payments-gateway", agent: "codex", state: "WaitingPermission" }),
        session({ sessionId: "b", projectName: "orders-service", state: "Working" }),
      ],
      limits: [{ agent: "codex", window: "weekly", usedPercent: 31, resetsAt: new Date().toISOString() }],
    });
    useRouteStore.setState({ route: "overview" });
    render(<OverviewPage />);
    expect(screen.getByText("Needs you · 1")).toBeInTheDocument();
    expect(screen.getByText("Sessions · 2")).toBeInTheDocument();
    // The session tiles moved to Mission control.
    expect(screen.queryByText("payments-gateway")).not.toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Codex CLI · Weekly" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open mission control" }));
    expect(useRouteStore.getState().route).toBe("mission");
    await waitFor(() => expect(hubRequest).toHaveBeenCalledWith("GET", "/v1/projects"));
  });

  it("logic: split, recent projects, block progress", () => {
    const { attention, others } = splitSessions([session({ state: "Ended" }), session({ state: "Error" }), session({ state: "Idle" })]);
    expect(attention.map((s) => s.state)).toEqual(["Error"]);
    expect(others.map((s) => s.state)).toEqual(["Idle"]);
    expect(blockProgress("2026-10-04T10:00:00Z", "2026-10-04T15:00:00Z", Date.parse("2026-10-04T12:30:00Z"))).toBe(0.5);
    const p = (name: string, last: string, total = 3) =>
      ({ root: name, name, manual: false, hidden: false, lastActivity: last, done: 1, inProgress: 0, total, percent: 33, files: 1, next: null, git: null, customerId: null, alias: null });
    expect(recentProjects([p("old", "2026-01-01T00:00:00Z"), p("new", "2026-10-01T00:00:00Z"), p("none", "2026-10-02T00:00:00Z", 0)]).map((x) => x.name)).toEqual(["new", "old"]);
  });
});
