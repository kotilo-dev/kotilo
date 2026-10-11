import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPage, sectionForField, useSettingsPageStore } from "./SettingsPage";
import { strings } from "../../app/strings";
import { useHelpStore } from "../help/helpStore";
import { DEFAULT_SETTINGS, hydrateSettingsStore, resetSettingsStoreForTest, useSettingsStore } from "../../stores/settingsStore";
import type { AdapterDto, HubSettings } from "../../lib/hubTypes";
import { useMascotSettingsStore } from "./mascotSettings";

const ipc = vi.hoisted(() => ({
  appInfo: vi.fn(),
  settingsSet: vi.fn(),
  clipboardWriteText: vi.fn(),
  hubRequest: vi.fn(),
  hooksInstall: vi.fn(),
  hooksUninstall: vi.fn(),
  hooksStatus: vi.fn(),
  pickFolders: vi.fn(),
  dictationReload: vi.fn(),
}));
const diagnosticsActions = vi.hoisted(() => ({
  collectDiagnostics: vi.fn(),
  openLogsFolder: vi.fn(),
}));

vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return { ...actual, ...ipc };
});
vi.mock("../../app/diagnosticsActions", () => diagnosticsActions);

const HUB_SETTINGS: HubSettings = {
  language: "en-US",
  rules: {
    waitingPermissionEnabled: true,
    waitingInputEnabled: true,
    completedEnabled: true,
    staleEnabled: true,
    waitingReminderEnabled: false,
    todoCompletedEnabled: false,
    contextHighEnabled: true,
    contextThresholdPercent: 80,
    contextRearmPercent: 70,
    errorEnabled: true,
    errorDebounce: "00:00:05",
    minTurnForCompleted: "00:00:30",
    reminderAfter: "00:05:00",
    unseenReminderEnabled: false,
    unseenReminderAfter: "00:30:00",
    debounce: "00:00:02",
    settle: "00:00:01",
  },
  usageRules: { blockThresholdEnabled: false, blockTokenThresholds: [1000000], resetMargin: 0.1, dailyCostEnabled: false, dailyCostThresholdUsd: 10, burnProjectionEnabled: false },
  quietHours: { enabled: false, start: "23:00:00", end: "08:00:00" },
  doNotDisturbUntil: null,
  suppressWhenTerminalFocused: true,
  buddy: { enabled: false, mascotEnabled: false, mascotOffered: false, hotkey: "Ctrl+Alt+B", mascotScale: 3, walkArea: "taskbar", celebrate: true, showBuddySessions: false, mascotHiddenUntil: null, mascotPosition: 0 },
  tasks: { hotkey: "Ctrl+Alt+N", reminders: true },
  dictation: {
    enabled: false,
    hotkey: "Ctrl+Alt+D",
    pasteLastHotkey: "Ctrl+Alt+Shift+D",
    model: "large",
    language: "tr",
    useGpu: true,
    aiCleanup: false,
    mode: "Clean",
    customPrompt: "",
    vocabulary: "",
    outputFocused: true,
    insertMethod: "paste",
    outputClipboard: false,
    outputFile: false,
    filePath: "",
    soundCues: true,
    maxMinutes: 5,
    keepHistory: true,
  },
  tasksGlob: "tasks/**/*.md",
  insights: { gitEnabled: true, uncommittedThreshold: 20, uncommittedInToast: false, dailySummaryEnabled: false, dailySummaryTime: "18:00", dailySummaryWithoutAi: false, healthInfoBarLevel: "Warning" },
};

const ADAPTERS: AdapterDto[] = [
  { id: "claude-code", displayName: "Claude Code", source: "builtIn", definition: null, hooks: { state: "installed", configPath: "C:/u/.claude/settings.json", needsApproval: false, hint: null }, error: null },
  { id: "codex", displayName: "Codex CLI", source: "builtIn", definition: null, hooks: { state: "missing", configPath: "C:/u/.codex/hooks.json", needsApproval: false, hint: null }, error: null },
];

function routeHub(method: string, path: string, body?: unknown): Promise<unknown> {
  if (method === "GET" && path === "/v1/settings") return Promise.resolve(structuredClone(HUB_SETTINGS));
  if (method === "PUT" && path === "/v1/settings") return Promise.resolve(body);
  if (method === "GET" && path === "/v1/adapters") return Promise.resolve(ADAPTERS);
  if (method === "GET" && path === "/v1/pricing") return Promise.resolve({ path: "C:/p.json", error: null, models: {} });
  return Promise.reject({ code: "not_found", message: path });
}

describe("SettingsPage", () => {
  beforeEach(() => {
    resetSettingsStoreForTest();
    hydrateSettingsStore(DEFAULT_SETTINGS);
    useSettingsPageStore.setState({ section: "appearance" });
    useHelpStore.setState({ open: false, item: "user-guide.md", pendingAnchor: null, previouslyFocused: null });
    ipc.dictationReload.mockReset().mockResolvedValue(undefined);
    ipc.appInfo.mockReset().mockResolvedValue({ osBuild: 22631, version: "0.1.0", gitSha: "abc1234", webview2: "120.0.0.0", os: "11 (22631)", buildDate: "2026-09-28" });
    ipc.settingsSet.mockReset().mockImplementation((s: unknown) => Promise.resolve(s));
    ipc.hubRequest.mockReset().mockImplementation(routeHub);
    ipc.hooksInstall.mockReset().mockResolvedValue(undefined);
    ipc.hooksStatus.mockReset().mockResolvedValue({ hubAvailable: true, installed: true, upToDate: true, state: "installed", settingsPath: null });
    diagnosticsActions.collectDiagnostics.mockReset().mockResolvedValue(undefined);
    diagnosticsActions.openLogsFolder.mockReset().mockResolvedValue(undefined);
  });

  it("lists every section and switches on click", () => {
    render(<SettingsPage />);
    for (const label of Object.values(strings.settingsPage.sections)) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.sections.terminal }));
    expect(screen.getByLabelText(strings.settings.terminal.fontFamily)).toBeInTheDocument();
  });

  it("theme changes apply immediately to the app settings", async () => {
    render(<SettingsPage />);
    fireEvent.change(screen.getByLabelText(strings.settings.appearance.theme), { target: { value: "light" } });
    await waitFor(() => expect(useSettingsStore.getState().settings.theme).toBe("light"));
  });

  describe("About (moved from the Settings dialog)", () => {
    beforeEach(() => useSettingsPageStore.setState({ section: "about" }));

    it("renders the shared AboutPanel via app_info", async () => {
      render(<SettingsPage />);
      expect(await screen.findByText(strings.about.version("0.1.0", "abc1234"))).toBeInTheDocument();
      expect(screen.getByText(strings.settings.about.privacyNote)).toBeInTheDocument();
    });

    it("verbose logging toggles diagnostics.verboseLogging", async () => {
      render(<SettingsPage />);
      fireEvent.click(screen.getByLabelText(strings.settings.about.verboseLogging));
      await waitFor(() => expect(useSettingsStore.getState().settings.diagnostics.verboseLogging).toBe(true));
    });

    it("open logs folder and open help call the shared actions", async () => {
      render(<SettingsPage />);
      fireEvent.click(screen.getByText(strings.settings.about.openLogsFolder));
      await waitFor(() => expect(diagnosticsActions.openLogsFolder).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByText(strings.settings.about.openHelp));
      expect(useHelpStore.getState().open).toBe(true);
    });
  });

  it("agents: installs the Codex integration through the hub with its adapter id", async () => {
    useSettingsPageStore.setState({ section: "agents" });
    render(<SettingsPage />);
    expect(await screen.findByText("Codex CLI")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.agents.install }));
    await waitFor(() => expect(ipc.hooksInstall).toHaveBeenCalledWith("codex"));
  });

  it("agents: tells the user to approve Codex hooks in the agent", async () => {
    ipc.hubRequest.mockImplementation((m: string, p: string, b?: unknown) =>
      p === "/v1/adapters" ? Promise.resolve([{ ...ADAPTERS[1]!, hooks: { state: "installed", configPath: null, needsApproval: true, hint: null } }]) : routeHub(m, p, b),
    );
    useSettingsPageStore.setState({ section: "agents" });
    render(<SettingsPage />);
    expect(await screen.findByText(strings.agentSetup.needsApproval("Codex CLI"))).toBeInTheDocument();
  });

  it("hub settings: an invalid field blocks saving and shows an inline error", async () => {
    useSettingsPageStore.setState({ section: "notifications" });
    render(<SettingsPage />);
    const threshold = await screen.findByLabelText(strings.settingsPage.notifications.contextThreshold);
    fireEvent.change(threshold, { target: { value: "150" } });
    expect(await screen.findByText(strings.settingsPage.rangeError(1, 100))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.save }));
    expect(await screen.findByText(strings.settingsPage.saveFailed(strings.settingsPage.fixErrors))).toBeInTheDocument();
    expect(ipc.hubRequest).not.toHaveBeenCalledWith("PUT", "/v1/settings", expect.anything());
  });

  it("hub settings: a valid change is sent back as the whole object", async () => {
    useSettingsPageStore.setState({ section: "notifications" });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByLabelText(strings.settingsPage.notifications.stale));
    fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.save }));
    await waitFor(() =>
      expect(ipc.hubRequest).toHaveBeenCalledWith("PUT", "/v1/settings", expect.objectContaining({ rules: expect.objectContaining({ staleEnabled: false }), tasksGlob: "tasks/**/*.md" })),
    );
    expect(await screen.findByText(strings.settingsPage.saved)).toBeInTheDocument();
    expect(ipc.dictationReload).toHaveBeenCalledTimes(1);
  });

  it("hub settings: shows the hub's own rejection message", async () => {
    ipc.hubRequest.mockImplementation((m: string, p: string, b?: unknown) =>
      m === "PUT" ? Promise.reject({ code: "invalid_argument", message: "Some settings are not valid." }) : routeHub(m, p, b),
    );
    useSettingsPageStore.setState({ section: "tasks" });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByLabelText(strings.settingsPage.tasks.reminders));
    fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.save }));
    expect(await screen.findByText(strings.settingsPage.saveFailed("Some settings are not valid."))).toBeInTheDocument();
  });

  it("hub settings: marks the fields the hub rejected and their sections, until the next edit", async () => {
    ipc.hubRequest.mockImplementation((m: string, p: string, b?: unknown) =>
      m === "PUT"
        ? Promise.reject({ code: "invalid_argument", message: "Some settings are not valid.", fields: { "tasks.hotkey": ["unknown key"], tasksGlob: ["required"] } })
        : routeHub(m, p, b),
    );
    useSettingsPageStore.setState({ section: "tasks" });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByLabelText(strings.settingsPage.tasks.reminders));
    fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.save }));
    expect(await screen.findByText(strings.settingsPage.serverFieldError("unknown key"))).toBeInTheDocument();
    const flagged = screen.getAllByRole("img", { name: strings.settingsPage.sectionHasErrors }).map((dot) => dot.closest("button")?.textContent);
    expect(flagged).toEqual([strings.settingsPage.sections.projects, strings.settingsPage.sections.tasks]);

    fireEvent.click(screen.getByLabelText(strings.settingsPage.tasks.reminders));
    expect(screen.queryByText(strings.settingsPage.serverFieldError("unknown key"))).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: strings.settingsPage.sectionHasErrors })).not.toBeInTheDocument();
  });

  it("sectionForField maps hub field paths to the section that shows them", () => {
    expect(sectionForField("rules.minTurnForCompleted")).toBe("notifications");
    expect(sectionForField("quietHours.start")).toBe("notifications");
    expect(sectionForField("usageRules.resetMargin")).toBe("usage");
    expect(sectionForField("insights.dailySummaryTime")).toBe("usage");
    expect(sectionForField("insights.uncommittedThreshold")).toBe("projects");
    expect(sectionForField("tasksGlob")).toBe("projects");
    expect(sectionForField("dictation.model")).toBe("dictation");
    expect(sectionForField("buddy.mascotScale")).toBe("mascot");
    expect(sectionForField("settings")).toBeNull();
  });

  it("hub settings: says so when the background service is not running", async () => {
    ipc.hubRequest.mockRejectedValue({ code: "hub_unavailable", message: "down" });
    useSettingsPageStore.setState({ section: "dictation" });
    render(<SettingsPage />);
    expect(await screen.findByText(strings.settingsPage.hubUnavailable)).toBeInTheDocument();
  });

  describe("Mascot (saved at once, only buddy)", () => {
    beforeEach(() => useMascotSettingsStore.setState({ settings: null, offerVisible: false }));

    it("saves a mascot change on the hub's current settings and keeps it in the draft", async () => {
      // A hub that remembers what was saved, like the real one.
      let stored = structuredClone(HUB_SETTINGS);
      ipc.hubRequest.mockImplementation((m: string, p: string, b?: unknown) => {
        if (p !== "/v1/settings") return routeHub(m, p, b);
        if (m === "PUT") stored = structuredClone(b as HubSettings);
        return Promise.resolve(structuredClone(stored));
      });
      useSettingsPageStore.setState({ section: "notifications" });
      render(<SettingsPage />);
      fireEvent.click(await screen.findByLabelText(strings.settingsPage.notifications.stale));

      fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.sections.mascot }));
      fireEvent.click(await screen.findByLabelText(strings.mascot.enabled, { exact: false }));
      await waitFor(() =>
        expect(ipc.hubRequest).toHaveBeenCalledWith(
          "PUT",
          "/v1/settings",
          expect.objectContaining({ buddy: expect.objectContaining({ mascotEnabled: true, mascotOffered: true }), rules: expect.objectContaining({ staleEnabled: true }) }),
        ),
      );
      fireEvent.click(screen.getByRole("radio", { name: strings.mascot.sizeLarge }));
      await waitFor(() => expect(useMascotSettingsStore.getState().settings?.buddy.mascotScale).toBe(4));

      // The unsaved notifications edit is still there, and saving it sends the mascot values along.
      fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.sections.notifications }));
      expect(screen.getByLabelText(strings.settingsPage.notifications.stale)).not.toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.save }));
      await waitFor(() =>
        expect(ipc.hubRequest).toHaveBeenLastCalledWith(
          "PUT",
          "/v1/settings",
          expect.objectContaining({ buddy: expect.objectContaining({ mascotEnabled: true, mascotScale: 4 }), rules: expect.objectContaining({ staleEnabled: false }) }),
        ),
      );
    });

    it("keeps an unsaved assistant edit (Settings → AI) when a mascot change is saved at once (M7)", async () => {
      const withAi = {
        ...HUB_SETTINGS,
        ai: { providers: [], assistant: { provider: "cli:claude-code", model: null }, dailySummary: { provider: "cli:claude-code", model: null }, dictationCleanup: { provider: "cli:claude-code", model: null } },
      } as HubSettings;
      let stored = structuredClone(withAi);
      ipc.hubRequest.mockImplementation((m: string, p: string, b?: unknown) => {
        if (p !== "/v1/settings") return routeHub(m, p, b);
        if (m === "PUT") stored = structuredClone(b as HubSettings);
        return Promise.resolve(structuredClone(stored));
      });
      useSettingsPageStore.setState({ section: "ai" });
      render(<SettingsPage />);
      fireEvent.click(await screen.findByLabelText(strings.assistant.settings.enabled, { exact: false }));
      fireEvent.change(screen.getByRole("textbox", { name: strings.assistant.settings.hotkey }), { target: { value: "Ctrl+Alt+K" } });

      fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.sections.mascot }));
      fireEvent.click(await screen.findByRole("radio", { name: strings.mascot.sizeLarge }));
      await waitFor(() => expect(useMascotSettingsStore.getState().settings?.buddy.mascotScale).toBe(4));
      // The immediate mascot save didn't take the unsaved assistant edit along.
      expect(stored.buddy.enabled).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.sections.ai }));
      expect(screen.getByLabelText(strings.assistant.settings.enabled, { exact: false })).toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.save }));
      await waitFor(() =>
        expect(ipc.hubRequest).toHaveBeenLastCalledWith(
          "PUT",
          "/v1/settings",
          expect.objectContaining({ buddy: expect.objectContaining({ enabled: true, hotkey: "Ctrl+Alt+K", mascotScale: 4 }) }),
        ),
      );
    });

    it("shows when the mascot is hidden and brings it back", async () => {
      const hidden = { ...HUB_SETTINGS, buddy: { ...HUB_SETTINGS.buddy, mascotEnabled: true, mascotHiddenUntil: new Date(Date.now() + 1_800_000).toISOString() } };
      ipc.hubRequest.mockImplementation((m: string, p: string, b?: unknown) =>
        m === "GET" && p === "/v1/settings" ? Promise.resolve(structuredClone(hidden)) : routeHub(m, p, b),
      );
      useSettingsPageStore.setState({ section: "mascot" });
      render(<SettingsPage />);
      fireEvent.click(await screen.findByRole("button", { name: strings.mascot.showNow }));
      await waitFor(() =>
        expect(ipc.hubRequest).toHaveBeenCalledWith("PUT", "/v1/settings", expect.objectContaining({ buddy: expect.objectContaining({ mascotHiddenUntil: null }) })),
      );
      expect(screen.queryByRole("button", { name: strings.mascot.showNow })).not.toBeInTheDocument();
    });
  });
});
