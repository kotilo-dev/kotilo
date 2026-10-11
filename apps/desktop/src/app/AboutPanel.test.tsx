import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AboutPanel } from "./AboutPanel";
import { strings } from "./strings";
import { resetUpdateStoreForTest } from "../features/update/updateStore";

const ipc = vi.hoisted(() => ({
  appInfo: vi.fn(),
  clipboardWriteText: vi.fn(),
  openExternalUrl: vi.fn(),
  updateCheck: vi.fn(),
}));
const licenses = vi.hoisted(() => ({ load: vi.fn() }));
const diagnosticsActions = vi.hoisted(() => ({
  collectDiagnostics: vi.fn(),
}));

vi.mock("../lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("../lib/ipc")>("../lib/ipc");
  return { ...actual, ...ipc };
});
vi.mock("./diagnosticsActions", () => diagnosticsActions);
vi.mock("./licenses", async () => {
  const actual = await vi.importActual<typeof import("./licenses")>("./licenses");
  return { ...actual, loadThirdPartyNotices: licenses.load };
});
// brand.json's supportEmail may be empty (the row is hidden then); the tests pick their own.
const contact = vi.hoisted(() => ({ email: "help@example.test", repository: "https://github.com/example/app" }));
vi.mock("./about", async () => {
  const actual = await vi.importActual<typeof import("./about")>("./about");
  return {
    ...actual,
    get CONTACT_EMAIL() {
      return contact.email;
    },
    projectLinks: () => actual.projectLinks(contact.repository),
  };
});

const APP_INFO = {
  osBuild: 22631,
  version: "0.1.0",
  gitSha: "a1b2c3d",
  webview2: "120.0.0.0",
  os: "11 (22631)",
  buildDate: "2026-09-28",
};

describe("AboutPanel (faz7-spec §11/§12)", () => {
  beforeEach(() => {
    contact.email = "help@example.test";
    contact.repository = "https://github.com/example/app";
    resetUpdateStoreForTest();
    ipc.updateCheck.mockReset();
    licenses.load.mockReset().mockResolvedValue("SUMMARY\n  tokio 1.0 MIT\n  serde 1.0 MIT OR Apache-2.0\n");
    ipc.appInfo.mockReset().mockResolvedValue(APP_INFO);
    ipc.clipboardWriteText.mockReset().mockResolvedValue(undefined);
    ipc.openExternalUrl.mockReset().mockResolvedValue(undefined);
    diagnosticsActions.collectDiagnostics.mockReset().mockResolvedValue(undefined);
  });

  it("renders version, git sha, and build date from app_info", async () => {
    render(<AboutPanel />);
    expect(await screen.findByText(strings.about.version("0.1.0", "a1b2c3d"))).toBeInTheDocument();
    expect(screen.getByText(strings.about.buildDate("2026-09-28"))).toBeInTheDocument();
  });

  it("appends ' — dirty' when the sha ends in -dirty", async () => {
    ipc.appInfo.mockResolvedValue({ ...APP_INFO, gitSha: "a1b2c3d-dirty" });
    render(<AboutPanel />);
    expect(await screen.findByText(strings.about.version("0.1.0", "a1b2c3d-dirty"))).toBeInTheDocument();
  });

  it("shows the contact email as a mailto link", async () => {
    render(<AboutPanel />);
    expect(await screen.findByText("help@example.test")).toBeInTheDocument();
  });

  it("hides the contact row when brand.json has no support email", async () => {
    contact.email = "";
    render(<AboutPanel />);
    expect(await screen.findByText(strings.about.copyVersionInfo)).toBeInTheDocument();
    expect(screen.queryByText(strings.about.contactLabel)).toBeNull();
    expect(screen.queryByText(strings.about.copyEmail)).toBeNull();
  });

  it("Copy (email) button copies the contact address and shows the toast string", async () => {
    render(<AboutPanel />);
    screen.getByText(strings.about.copyEmail).click();
    await waitFor(() => expect(ipc.clipboardWriteText).toHaveBeenCalledWith("help@example.test"));
  });

  it("Copy version info button copies the plain-text summary block", async () => {
    render(<AboutPanel />);
    const button = await screen.findByText(strings.about.copyVersionInfo);
    button.click();
    await waitFor(() => expect(ipc.clipboardWriteText).toHaveBeenCalledWith(strings.about.versionInfoBlock(APP_INFO)));
  });

  it("Collect diagnostics button calls the shared collectDiagnostics() action", async () => {
    render(<AboutPanel />);
    screen.getByText(strings.about.collectDiagnostics).click();
    await waitFor(() => expect(diagnosticsActions.collectDiagnostics).toHaveBeenCalledTimes(1));
  });

  it("renders the description and credits", () => {
    render(<AboutPanel />);
    expect(screen.getByText(strings.about.description)).toBeInTheDocument();
    expect(screen.getByText("Tauri")).toBeInTheDocument();
    expect(screen.getByText("xterm.js")).toBeInTheDocument();
  });

  it("states the Apache-2.0 license and the not-affiliated notice", () => {
    render(<AboutPanel />);
    expect(screen.getByText(strings.update.license)).toBeInTheDocument();
    expect(screen.getByText(strings.update.notAffiliated)).toBeInTheDocument();
  });

  it("links repository, issues and discussions from brand.json", async () => {
    render(<AboutPanel />);
    fireEvent.click(screen.getByText(strings.update.issues));
    await waitFor(() => expect(ipc.openExternalUrl).toHaveBeenCalledWith("https://github.com/example/app/issues"));
    fireEvent.click(screen.getByText(strings.update.discussions));
    await waitFor(() => expect(ipc.openExternalUrl).toHaveBeenCalledWith("https://github.com/example/app/discussions"));
    expect(screen.getByText(strings.update.repository)).toBeInTheDocument();
  });

  it("hides the project links when brand.json has no repository", () => {
    contact.repository = "";
    render(<AboutPanel />);
    expect(screen.queryByRole("navigation", { name: strings.update.linksLabel })).toBeNull();
    expect(screen.queryByText(strings.update.issues)).toBeNull();
  });

  it.each([
    [{ status: "not-configured" }, strings.update.notConfigured],
    [{ status: "up-to-date", current: "0.1.0" }, strings.update.upToDate("0.1.0")],
    [{ status: "available", current: "0.1.0", version: "0.2.0", notes: null, date: null }, strings.update.available("0.2.0")],
    [{ status: "error", message: "offline" }, strings.update.checkFailed("offline")],
  ])("Check for updates shows the %o result", async (result, text) => {
    ipc.updateCheck.mockResolvedValue(result);
    render(<AboutPanel />);
    fireEvent.click(screen.getByRole("button", { name: strings.update.checkNow }));
    await waitFor(() => expect(screen.getByTestId("update-check-status")).toHaveTextContent(text));
  });

  it("shows 'checking' and disables the button while the check runs", async () => {
    ipc.updateCheck.mockReturnValue(new Promise(() => {}));
    render(<AboutPanel />);
    const button = screen.getByRole("button", { name: strings.update.checkNow });
    fireEvent.click(button);
    expect(await screen.findByText(strings.update.checking)).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it("loads the open-source licenses only when opened, and filters them", async () => {
    render(<AboutPanel />);
    expect(licenses.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: strings.update.licensesShow }));
    const text = await screen.findByTestId("licenses-text");
    expect(licenses.load).toHaveBeenCalledTimes(1);
    expect(text).toHaveTextContent("tokio 1.0 MIT");
    fireEvent.change(screen.getByRole("searchbox", { name: strings.update.licensesSearch }), { target: { value: "apache" } });
    await waitFor(() => expect(screen.getByTestId("licenses-text").textContent).toBe("  serde 1.0 MIT OR Apache-2.0"));
    expect(screen.getByText(strings.update.licensesMatches(1))).toBeInTheDocument();
  });

  it("shows an error when the licenses cannot be loaded", async () => {
    licenses.load.mockRejectedValue(new Error("chunk failed"));
    render(<AboutPanel />);
    fireEvent.click(screen.getByRole("button", { name: strings.update.licensesShow }));
    expect(await screen.findByText(strings.update.licensesError)).toBeInTheDocument();
  });
});
