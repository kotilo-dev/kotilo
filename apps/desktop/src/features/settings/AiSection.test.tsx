import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SettingsPage, sectionForField, useSettingsPageStore } from "./SettingsPage";
import { strings } from "../../app/strings";
import type { AiProvidersResponse, AiSettings, HubSettings } from "../../lib/hubTypes";

const ipc = vi.hoisted(() => ({ hubRequest: vi.fn(), dictationReload: vi.fn() }));
vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return { ...actual, ...ipc };
});

const t = strings.ai;
const SECRET = "sk-test-0123456789";

const AI: AiSettings = {
  providers: [{ name: "ollama", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.1:8b", hasKey: true }],
  assistant: { provider: "cli:claude-code", model: "haiku" },
  dailySummary: { provider: "cli:claude-code", model: null },
  dictationCleanup: { provider: "openai:ollama", model: null },
};

const SETTINGS = {
  language: "en-US",
  rules: { contextThresholdPercent: 80, contextRearmPercent: 70, reminderAfter: "00:05:00", minTurnForCompleted: "00:00:30" },
  usageRules: { dailyCostThresholdUsd: 10 },
  quietHours: { enabled: false, start: "23:00:00", end: "08:00:00" },
  doNotDisturbUntil: null,
  buddy: { enabled: false },
  tasks: { hotkey: "Ctrl+Alt+N", reminders: true },
  dictation: { enabled: true, aiCleanup: true, hotkey: "Ctrl+Alt+D", pasteLastHotkey: "Ctrl+Alt+Shift+D", maxMinutes: 5, mode: "Clean", model: "large", language: "tr", vocabulary: "", filePath: "" },
  tasksGlob: "tasks/**/*.md",
  insights: { uncommittedThreshold: 20, dailySummaryEnabled: true, dailySummaryTime: "18:00", dailySummaryWithoutAi: false },
  ai: AI,
} as unknown as HubSettings;

function providers(overrides: Partial<AiProvidersResponse> = {}): AiProvidersResponse {
  return {
    providers: [
      { id: "cli:claude-code", kind: "cli", displayName: "Claude Code", installed: true, verified: true, hasKey: null, baseUrl: null, isLoopback: false },
      { id: "cli:gemini", kind: "cli", displayName: "Gemini CLI", installed: true, verified: false, hasKey: null, baseUrl: null, isLoopback: false },
      { id: "openai:ollama", kind: "openai", displayName: "ollama", installed: true, verified: true, hasKey: true, baseUrl: "http://127.0.0.1:11434/v1", isLoopback: true },
    ],
    fullyLocal: false,
    secretStoreAvailable: true,
    ...overrides,
  };
}

let current: HubSettings;
let providersResponse: AiProvidersResponse;

function routeHub(method: string, path: string, body?: unknown): Promise<unknown> {
  if (method === "GET" && path === "/v1/settings") return Promise.resolve(structuredClone(current));
  if (method === "PUT" && path === "/v1/settings") {
    current = structuredClone(body as HubSettings);
    return Promise.resolve(structuredClone(current));
  }
  if (method === "GET" && path === "/v1/ai/providers") return Promise.resolve(providersResponse);
  if (method === "PUT" && path.endsWith("/key")) return Promise.resolve(null);
  if (method === "DELETE" && path.endsWith("/key")) return Promise.resolve(null);
  if (method === "POST" && path === "/v1/ai/test") return Promise.resolve({ ok: true, errorKind: "none", latencyMs: 840 });
  if (method === "GET" && path.endsWith("/models")) return Promise.resolve({ models: ["llama3.1:8b", "qwen3:14b"], errorKind: "none" });
  return Promise.reject({ code: "not_found", message: path });
}

function renderAi() {
  useSettingsPageStore.setState({ section: "ai" });
  return render(<SettingsPage />);
}

/** The feature card whose title is `name`. */
function featureCard(name: string): HTMLElement {
  return screen.getByText(name, { selector: "span" }).closest("div.rounded-card") as HTMLElement;
}

describe("Settings → AI", () => {
  beforeEach(() => {
    current = structuredClone(SETTINGS);
    providersResponse = providers();
    ipc.hubRequest.mockReset().mockImplementation(routeHub);
    ipc.dictationReload.mockReset().mockResolvedValue(undefined);
  });

  it("lists agent CLIs (unverified badge) and endpoints (local, key saved), not fully local", async () => {
    renderAi();
    expect(await screen.findByText("Gemini CLI")).toBeInTheDocument();
    expect(screen.getByText("Claude Code", { selector: "span" })).toBeInTheDocument();
    expect(screen.getAllByText(t.notVerified)).toHaveLength(1);
    expect(screen.getByText("ollama", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(t.local)).toBeInTheDocument();
    expect(screen.getByText(t.keySaved)).toBeInTheDocument();
    expect(screen.getByText(t.notFullyLocal)).toBeInTheDocument();
    expect(screen.getByText(t.cliHint)).toBeInTheDocument();
  });

  it("shows Fully local once every enabled feature uses the loopback endpoint (unsaved draft)", async () => {
    renderAi();
    const select = within(await screen.findByText(t.featureNames.dailySummary).then(() => featureCard(t.featureNames.dailySummary))).getByLabelText(t.provider);
    fireEvent.change(select, { target: { value: "openai:ollama" } });
    expect(await screen.findByText(t.fullyLocal)).toBeInTheDocument();
    expect(screen.getByText(t.fullyLocal).getAttribute("title")).toBe(t.fullyLocalTooltip);
  });

  it("adds an endpoint, sends the key to the vault only, and keeps no copy of it", async () => {
    renderAi();
    fireEvent.click(await screen.findByRole("button", { name: t.addEndpoint }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(t.name), { target: { value: "lmstudio" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "LM Studio" }));
    expect(within(dialog).getByLabelText(t.baseUrl)).toHaveValue("http://127.0.0.1:1234/v1");
    fireEvent.change(within(dialog).getByLabelText(t.defaultModel), { target: { value: "qwen3-8b" } });
    fireEvent.change(within(dialog).getByLabelText(t.apiKey), { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole("button", { name: t.save }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const calls = ipc.hubRequest.mock.calls as [string, string, unknown?][];
    const settingsPut = calls.find(([m, p]) => m === "PUT" && p === "/v1/settings");
    expect((settingsPut?.[2] as HubSettings).ai!.providers[1]).toEqual({ name: "lmstudio", kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", model: "qwen3-8b", hasKey: false });
    expect(calls).toContainEqual(["PUT", "/v1/ai/providers/lmstudio/key", { key: SECRET }]);
    // Only the vault call carries the key; neither the settings nor the page keep it.
    expect(calls.filter(([, p]) => !p.endsWith("/key")).some((c) => JSON.stringify(c).includes(SECRET))).toBe(false);
    expect(JSON.stringify(current)).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);

    fireEvent.click(screen.getByRole("button", { name: t.editNamed("lmstudio") }));
    expect(within(screen.getByRole("dialog")).getByLabelText(t.apiKey)).toHaveValue("");
  });

  it("maps the hub's endpoint field errors onto the form", async () => {
    ipc.hubRequest.mockImplementation((m: string, p: string, b?: unknown) =>
      m === "PUT" && p === "/v1/settings"
        ? Promise.reject({ code: "invalid_argument", message: "Some settings are not valid.", fields: { "ai.providers[1].baseUrl": ["an http(s) URL"] } })
        : routeHub(m, p, b),
    );
    renderAi();
    fireEvent.click(await screen.findByRole("button", { name: t.addEndpoint }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(t.name), { target: { value: "lan" } });
    fireEvent.change(within(dialog).getByLabelText(t.baseUrl), { target: { value: "http://10.0.0.2:11434/v1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: t.save }));
    expect(await within(dialog).findByText("an http(s) URL")).toBeInTheDocument();
    expect(within(dialog).getByLabelText(t.baseUrl)).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByText("Some settings are not valid.")).toBeInTheDocument();
  });

  it("disables the key field without a vault", async () => {
    providersResponse = providers({ secretStoreAvailable: false });
    renderAi();
    await screen.findByText("Gemini CLI");
    fireEvent.click(screen.getByRole("button", { name: t.editNamed("ollama") }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText(t.apiKey)).toBeDisabled();
    expect(within(dialog).getByText(t.apiKeyUnavailable)).toBeInTheDocument();
  });

  it("removes a stored key", async () => {
    renderAi();
    fireEvent.click(await screen.findByRole("button", { name: t.removeKeyNamed("ollama") }));
    await waitFor(() => expect(ipc.hubRequest).toHaveBeenCalledWith("DELETE", "/v1/ai/providers/ollama/key"));
  });

  it("deleting an endpoint moves its features to the first agent CLI", async () => {
    renderAi();
    fireEvent.click(await screen.findByRole("button", { name: t.deleteNamed("ollama") }));
    const confirm = screen.getAllByRole("button", { name: t.delete });
    fireEvent.click(confirm[confirm.length - 1]!);
    await waitFor(() => expect(current.ai!.providers).toEqual([]));
    expect(current.ai!.dictationCleanup).toEqual({ provider: "cli:claude-code", model: null });
  });

  it("tests a provider and a feature, translating the error kind", async () => {
    renderAi();
    fireEvent.click(await screen.findByRole("button", { name: t.testNamed("Gemini CLI") }));
    expect(await screen.findByText(t.testOk(840))).toBeInTheDocument();
    expect(ipc.hubRequest).toHaveBeenCalledWith("POST", "/v1/ai/test", { provider: "cli:gemini", model: null });

    ipc.hubRequest.mockImplementation((m: string, p: string, b?: unknown) =>
      p === "/v1/ai/test" ? Promise.resolve({ ok: false, errorKind: "notLoggedIn", latencyMs: 120 }) : routeHub(m, p, b),
    );
    fireEvent.click(screen.getByRole("button", { name: t.testNamed(t.featureNames.assistant) }));
    expect(await screen.findByText(t.testFailed(t.errorKinds.notLoggedIn))).toBeInTheDocument();
    expect(ipc.hubRequest).toHaveBeenCalledWith("POST", "/v1/ai/test", { provider: "cli:claude-code", model: "haiku" });
  });

  it("an endpoint without a default model needs a feature model before saving", async () => {
    current = structuredClone({ ...SETTINGS, ai: { ...AI, providers: [{ ...AI.providers[0]!, model: null }], dictationCleanup: { provider: "cli:claude-code", model: null } } });
    renderAi();
    const card = await screen.findByText(t.featureNames.dictationCleanup).then(() => featureCard(t.featureNames.dictationCleanup));
    fireEvent.change(within(card).getByLabelText(t.provider), { target: { value: "openai:ollama" } });
    expect(await within(card).findByText(t.validation.modelRequired)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.save }));
    expect(await screen.findByText(strings.settingsPage.saveFailed(strings.settingsPage.fixErrors))).toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText(t.model), { target: { value: "llama3.1:8b" } });
    fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.save }));
    await waitFor(() => expect(current.ai!.dictationCleanup).toEqual({ provider: "openai:ollama", model: "llama3.1:8b" }));
  });

  it("marks feature fields the hub rejected and flags the AI section", async () => {
    ipc.hubRequest.mockImplementation((m: string, p: string, b?: unknown) =>
      m === "PUT" && p === "/v1/settings"
        ? Promise.reject({ code: "invalid_argument", message: "Some settings are not valid.", fields: { "ai.assistant.provider": ["agents: claude-code, codex"] } })
        : routeHub(m, p, b),
    );
    renderAi();
    const card = await screen.findByText(t.featureNames.assistant).then(() => featureCard(t.featureNames.assistant));
    fireEvent.change(within(card).getByLabelText(t.model), { target: { value: "sonnet" } });
    fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.save }));
    expect(await within(card).findByText(strings.settingsPage.serverFieldError("agents: claude-code, codex"))).toBeInTheDocument();
    expect(within(card).getByLabelText(t.provider)).toHaveAttribute("aria-describedby");
    const flagged = screen.getAllByRole("img", { name: strings.settingsPage.sectionHasErrors }).map((dot) => dot.closest("button")?.textContent);
    expect(flagged).toEqual([strings.settingsPage.sections.ai]);
    expect(sectionForField("ai.providers[0].baseUrl")).toBe("ai");
  });

  it("the daily summary and dictation toggles edit the same settings as their own sections", async () => {
    renderAi();
    const dictation = await screen.findByText(t.featureNames.dictationCleanup).then(() => featureCard(t.featureNames.dictationCleanup));
    fireEvent.click(within(dictation).getByLabelText(strings.settingsPage.dictation.aiCleanup));
    fireEvent.click(screen.getByLabelText(t.dailySummaryUseAi));
    fireEvent.click(screen.getByRole("button", { name: strings.settingsPage.save }));
    await waitFor(() => expect(current.dictation.aiCleanup).toBe(false));
    expect(current.insights.dailySummaryWithoutAi).toBe(true);
  });

  it("the Dictation section names the cleanup provider and links to Settings → AI", async () => {
    useSettingsPageStore.setState({ section: "dictation" });
    render(<SettingsPage />);
    expect(await screen.findByText(t.dictationProvider("openai:ollama"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t.openAiSettings }));
    expect(useSettingsPageStore.getState().section).toBe("ai");
  });
});
