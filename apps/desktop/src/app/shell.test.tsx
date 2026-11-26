import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NavRail } from "./NavRail";
import { RoutePage } from "./RoutePage";
import { ROUTES } from "./routes";
import { registerRouteCommands } from "./routeCommands";
import { clearCommands, installGlobalKeydownListener } from "./commands";
import { installThemeSync } from "./theme/themeSync";
import { agentIdentity } from "./agentIdentity";
import { useRouteStore } from "../stores/routeStore";
import { useHubStore } from "../stores/hubStore";
import { useSettingsStore } from "../stores/settingsStore";
import { DEFAULT_LAYOUT, useLayoutStore } from "../stores/layoutStore";
import { useI18nStore } from "./i18n";
import { en } from "./i18n/en";

function Shell() {
  const route = useRouteStore((s) => s.route);
  return (
    <>
      <NavRail />
      {route === "workspace" ? <div>workspace body</div> : <RoutePage route={route} />}
    </>
  );
}

beforeEach(() => {
  useRouteStore.setState({ route: "workspace" });
  useI18nStore.setState({ preference: "en", language: "en" });
  useHubStore.setState({ taskCounts: null });
  useLayoutStore.setState({ layout: DEFAULT_LAYOUT });
});

afterEach(() => {
  clearCommands();
});

describe("nav rail", () => {
  it("has a labelled button per route and marks the active one", () => {
    render(<Shell />);
    expect(screen.getByRole("navigation", { name: en.nav.label })).toBeInTheDocument();
    for (const def of ROUTES) {
      expect(screen.getByRole("button", { name: en.nav[def.label] })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: en.nav.workspace })).toHaveAttribute("aria-current", "page");
  });

  it("navigates on click and renders the route's page", () => {
    render(<Shell />);
    fireEvent.click(screen.getByRole("button", { name: en.nav.usage }));
    expect(useRouteStore.getState().route).toBe("usage");
    expect(screen.getByRole("heading", { name: en.nav.usage })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.nav.usage })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("workspace body")).not.toBeInTheDocument();
  });

  it("Alt+n switches routes through the command registry", () => {
    const unregister = registerRouteCommands();
    const removeListener = installGlobalKeydownListener();
    render(<Shell />);
    act(() => {
      fireEvent.keyDown(window, { key: "3", altKey: true });
    });
    expect(useRouteStore.getState().route).toBe(ROUTES[2]!.id);
    act(() => {
      fireEvent.keyDown(window, { key: "1", altKey: true });
    });
    expect(useRouteStore.getState().route).toBe("workspace");
    removeListener();
    unregister.forEach((fn) => fn());
  });

  it("badges Tasks with today's and overdue tasks from the hub stream", () => {
    render(<Shell />);
    expect(screen.queryByTestId("nav-badge")).not.toBeInTheDocument();
    act(() => useHubStore.getState().apply({ type: "tasks", data: { today: 2, overdue: 1 } }));
    const tasks = screen.getByRole("button", { name: `${en.nav.tasks} (${en.nav.tasksDue(2, 1)})` });
    expect(tasks.querySelector("[data-testid=nav-badge]")).toHaveTextContent("3");
    expect(en.nav.tasksDue(2, 1)).toBe("1 overdue, 2 due today");
    act(() => useHubStore.getState().apply({ type: "tasks", data: { today: 0, overdue: 0 } }));
    expect(screen.queryByTestId("nav-badge")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.nav.tasks })).toBeInTheDocument();
  });

  it("shows icons only by default; the toggle adds full labels and is remembered in the layout", () => {
    render(<Shell />);
    const nav = screen.getByRole("navigation", { name: en.nav.label });
    expect(nav).not.toHaveAttribute("data-expanded");
    expect(screen.queryByText(en.nav.mission)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.nav.expand }));
    expect(nav).toHaveAttribute("data-expanded", "true");
    expect(screen.getByText(en.nav.mission)).toBeInTheDocument();
    expect(useLayoutStore.getState().layout.navExpanded).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: en.nav.collapse }));
    expect(useLayoutStore.getState().layout.navExpanded).toBe(false);
  });

  it("follows the UI language", () => {
    render(<Shell />);
    act(() => useI18nStore.setState({ language: "tr" }));
    expect(screen.getByRole("button", { name: "Genel bakış" })).toBeInTheDocument();
  });
});

describe("theme attribute", () => {
  it("tracks the theme setting", () => {
    const root = document.createElement("div");
    const stop = installThemeSync(root);
    expect(root.dataset.theme).toBe(useSettingsStore.getState().settings.theme);
    act(() => {
      useSettingsStore.setState((s) => ({ settings: { ...s.settings, theme: "light" } }));
    });
    expect(root.dataset.theme).toBe("light");
    act(() => {
      useSettingsStore.setState((s) => ({ settings: { ...s.settings, theme: "dark" } }));
    });
    expect(root.dataset.theme).toBe("dark");
    stop();
  });
});

describe("agent identity", () => {
  it("maps pane kinds and hub adapter ids to DESIGN_SYSTEM §2.4 tokens", () => {
    expect(agentIdentity("claude")).toMatchObject({ letter: "C", bg: "var(--agent-claude-bg)" });
    expect(agentIdentity("claude-code").key).toBe("claude");
    expect(agentIdentity("codex").letter).toBe("X");
    expect(agentIdentity("unknown-agent").key).toBe("other");
  });
});
