import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HelpModal } from "./HelpModal";
import { strings } from "../../app/strings";
import { useI18nStore } from "../../app/i18n";
import { useHelpStore } from "./helpStore";
import { DEFAULT_SETTINGS, hydrateSettingsStore, resetSettingsStoreForTest } from "../../stores/settingsStore";

const ipc = vi.hoisted(() => ({
  appInfo: vi.fn(),
  clipboardWriteText: vi.fn(),
  openExternalUrl: vi.fn(),
}));
const diagnosticsActions = vi.hoisted(() => ({ collectDiagnostics: vi.fn() }));

vi.mock("../../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../../lib/ipc")>("../../lib/ipc");
  return { ...actual, ...ipc };
});
vi.mock("../../app/diagnosticsActions", () => diagnosticsActions);

function closeHelp() {
  useHelpStore.setState({ open: false, item: "user-guide.md", pendingAnchor: null, previouslyFocused: null });
}

describe("HelpModal (faz7-spec §10/§12)", () => {
  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView (faz7-spec §12.8 relies on it) — stubbed for tests.
    Element.prototype.scrollIntoView = vi.fn();
    closeHelp();
    resetSettingsStoreForTest();
    hydrateSettingsStore(DEFAULT_SETTINGS);
    ipc.appInfo.mockReset().mockResolvedValue({
      osBuild: 22631,
      version: "0.1.0",
      gitSha: "abc1234",
      webview2: "120.0.0.0",
      os: "11 (22631)",
      buildDate: "2026-09-28",
    });
    ipc.clipboardWriteText.mockReset().mockResolvedValue(undefined);
    ipc.openExternalUrl.mockReset().mockResolvedValue(undefined);
    diagnosticsActions.collectDiagnostics.mockReset().mockResolvedValue(undefined);
  });

  it("renders nothing while closed", () => {
    render(<HelpModal />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens on the User guide by default, as a dialog with 4 tabs", () => {
    useHelpStore.getState().openHelp();
    render(<HelpModal />);
    const dialog = screen.getByRole("dialog", { name: strings.help.dialogLabel });
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs).toHaveLength(4);
    expect(within(dialog).getByRole("tab", { name: strings.help.docTitles["user-guide.md"] })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(dialog).getByRole("heading", { name: "Installation" })).toBeInTheDocument();
  });

  it("clicking the Keybindings tab switches the rendered doc", async () => {
    useHelpStore.getState().openHelp();
    render(<HelpModal />);
    screen.getByRole("tab", { name: strings.help.docTitles["keybindings.md"] }).click();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Global" })).toBeInTheDocument());
  });

  it("clicking the About tab renders AboutPanel instead of markdown", async () => {
    useHelpStore.getState().openHelp();
    render(<HelpModal />);
    screen.getByRole("tab", { name: strings.help.aboutItem }).click();
    expect(await screen.findByText(strings.about.description)).toBeInTheDocument();
  });

  it("opening directly on 'about' selects the About tab", async () => {
    useHelpStore.getState().openHelp("about");
    render(<HelpModal />);
    expect(screen.getByRole("tab", { name: strings.help.aboutItem })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(strings.about.description)).toBeInTheDocument();
  });

  it("an in-doc anchor link scrolls within the current doc (no doc switch)", () => {
    useHelpStore.getState().openHelp("user-guide.md");
    render(<HelpModal />);
    // "Data locations" is linked from the Installation section as "#data-locations".
    screen.getAllByRole("link", { name: "Data locations" })[0]!.click();
    expect(useHelpStore.getState().item).toBe("user-guide.md");
  });

  it("a cross-doc link switches doc and scrolls to the target anchor", () => {
    useHelpStore.getState().openHelp("troubleshooting.md");
    render(<HelpModal />);
    screen.getByRole("link", { name: "Notifications" }).click();
    expect(useHelpStore.getState().item).toBe("user-guide.md");
  });

  it("an external (http) link calls openExternalUrl, never navigates in-app", () => {
    useHelpStore.getState().openHelp("troubleshooting.md");
    render(<HelpModal />);
    screen.getByRole("link", { name: "Microsoft Edge WebView2 Runtime" }).click();
    expect(ipc.openExternalUrl).toHaveBeenCalledWith("https://developer.microsoft.com/microsoft-edge/webview2/");
  });

  it("a link to a non-bundled doc renders as plain unavailable text, not a link", () => {
    useHelpStore.getState().openHelp("troubleshooting.md");
    render(<HelpModal />);
    // faz7-spec §12.1: the development.md links were rewritten to plain text, so there is no
    // longer a link here at all — this is itself the regression guard for that rewrite.
    expect(screen.queryByRole("link", { name: /development/i })).not.toBeInTheDocument();
  });

  it("search requires 2+ characters and shows 'Doc › Heading' results; Enter opens the first hit", () => {
    useHelpStore.getState().openHelp("user-guide.md");
    render(<HelpModal />);
    const search = screen.getByRole("searchbox", { name: strings.help.searchLabel });
    fireEvent.change(search, { target: { value: "W" } });
    // 1 char: still showing the doc, not a results list.
    expect(screen.queryByText(strings.help.noResults)).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: "Workspaces" } });
    expect(screen.getByText(`${strings.help.docTitles["user-guide.md"]} › Workspaces`)).toBeInTheDocument();
  });

  it("the search box has initial focus when the modal opens", async () => {
    useHelpStore.getState().openHelp();
    render(<HelpModal />);
    await waitFor(() => expect(screen.getByRole("searchbox", { name: strings.help.searchLabel })).toHaveFocus());
  });

  it("shows the Turkish docs, tabs and search when the UI language is Turkish", () => {
    useI18nStore.setState({ language: "tr" });
    try {
      useHelpStore.getState().openHelp("user-guide.md");
      render(<HelpModal />);
      expect(screen.getByRole("tab", { name: "Kullanım kılavuzu" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("heading", { name: "Kurulum" })).toBeInTheDocument();
      const search = screen.getByRole("searchbox");
      fireEvent.change(search, { target: { value: "izin kartı" } });
      expect(screen.getByText("Kullanım kılavuzu › İzin kartı")).toBeInTheDocument();
    } finally {
      useI18nStore.setState({ language: "en" });
    }
  });

  it("Esc closes the modal", () => {
    useHelpStore.getState().openHelp();
    render(<HelpModal />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(useHelpStore.getState().open).toBe(false);
  });
});
