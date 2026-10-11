import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const hubRequest = vi.fn();
const hubExport = vi.fn();
vi.mock("../../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ipc")>()),
  hubRequest: (...args: unknown[]) => hubRequest(...args),
  hubExport: (...args: unknown[]) => hubExport(...args),
}));
const save = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...a: unknown[]) => save(...a) }));

import { ReportsPage } from "./ReportsPage";
import { useI18nStore } from "../../app/i18n";
import { costPath, defaultCostRange, exportFileName } from "./reportsLogic";

const totals = { input: 1, output: 1, cacheCreate: 0, cacheRead: 0, tokens: 72000, costUsd: 4.2, hasUnpricedEntries: false, entries: 10 };

function routes(path: string): unknown {
  if (path === "/v1/reports/daily-summaries?limit=30") return [];
  if (path === "/v1/reports/daily-summaries/status")
    return { enabled: true, scheduledAt: "18:30", withoutAi: false, model: "haiku", generationAvailable: false, reason: "clientRequired" };
  if (path.startsWith("/v1/reports/daily-summaries/"))
    return { summary: null, input: { date: "2026-10-04", activeMinutes: 47, sessions: 3, tokens: 1000, costUsd: 1, waitMinutes: 5, hasActivity: true } };
  if (path.startsWith("/v1/reports/cost"))
    return {
      from: "2026-09-05",
      to: "2026-10-04",
      groupBy: "project",
      sessions: 3,
      totals,
      rows: [{ kind: "normal", key: "app", name: "app", color: null, projects: ["app"], sessions: 3, totals, share: 1 }],
    };
  return null;
}

beforeEach(() => {
  useI18nStore.setState({ preference: "en", language: "en" });
  hubRequest.mockReset().mockImplementation((_m: string, path: string) => Promise.resolve(routes(path)));
  hubExport.mockReset().mockResolvedValue(undefined);
  save.mockReset().mockResolvedValue("C:/out/report.csv");
});

describe("ReportsPage", () => {
  it("daily tab explains that generation needs the assistant and shows the day's metrics", async () => {
    render(<ReportsPage />);
    expect(await screen.findByText(/Generating summaries arrives with the assistant/)).toBeInTheDocument();
    expect(await screen.findByText("47m 00s")).toBeInTheDocument();
  });

  it("cost tab exports CSV through a save dialog", async () => {
    render(<ReportsPage />);
    fireEvent.click(screen.getByRole("radio", { name: "Cost" }));
    expect(await screen.findByText("Total")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(hubExport).toHaveBeenCalledTimes(1));
    const [path, dest] = hubExport.mock.calls[0] as [string, string];
    expect(path).toContain("format=csv");
    expect(path).toContain("lang=en");
    expect(dest).toBe("C:/out/report.csv");
  });

  it("logic: cost path, default range, file name", () => {
    expect(costPath("2026-09-01", "2026-09-30", "agent")).toBe("/v1/reports/cost?from=2026-09-01&to=2026-09-30&groupBy=agent");
    expect(defaultCostRange(new Date(2026, 9, 4))).toEqual({ from: "2026-09-05", to: "2026-10-04" });
    expect(exportFileName("a", "b", "xlsx")).toBe("kotilo-cost-a_b.xlsx");
  });
});
