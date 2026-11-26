import { expect, test, type Page } from "@playwright/test";
import { waitForApp } from "./app";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// The Workspaces panel (D-077): a WORKSPACES tab with the full list, a FILES tab with the active
// workspace's tree and a "name ▾ branch" quick switcher.

const tabs = (page: Page) => page.getByTestId("workspace-panel-tabs");
const workspacesTab = (page: Page) => tabs(page).getByRole("tab").first();
const filesTab = (page: Page) => tabs(page).getByRole("tab").nth(1);
const wsRow = (page: Page, name: string) => page.getByRole("option").filter({ has: page.getByTitle(name, { exact: true }) });
const switcherButton = (page: Page) => page.getByTestId("files-workspace-name").locator("xpath=..");
const switcherSearch = (page: Page) => page.getByRole("combobox");

/** A permission-blocked agent in the second workspace (billing-api). */
const BLOCKED_IN_BILLING = [
  { id: "a-blocked", paneId: "pane-b1", workspaceId: "ws-billing", kind: "claude", adapterId: "claude-code", state: "blocked", sinceMs: Date.now() - 40_000, source: "hook", sessionId: null },
];

async function pushAgents(page: Page, agents: unknown[]) {
  await page.evaluate(async (list) => {
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("agents:changed", list);
  }, agents);
}

async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?${query}`);
  await waitForApp(page);
  return errors;
}

test("workspace panel · tabs, list click, switcher, manage", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=en&workspaces=2");

  // Starts on Files: the active workspace's contents, no root row, no "other workspaces" group.
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("files-workspace-name")).toHaveText("orders-service");
  await expect(page.getByTitle("README.md", { exact: true })).toBeVisible();
  await expect(page.getByText("Other workspaces (1)")).toHaveCount(0);
  await expect(page.getByTitle("billing-api", { exact: true })).toHaveCount(0);

  // Workspaces tab: two-line rows (name + path), the active one marked.
  await workspacesTab(page).click();
  await expect(workspacesTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("option")).toHaveCount(2);
  await expect(wsRow(page, "orders-service")).toHaveAttribute("aria-selected", "true");
  await expect(wsRow(page, "billing-api")).toContainText("C:\\src\\billing-api");

  // One click makes a workspace active and stays on the Workspaces tab.
  await wsRow(page, "billing-api").click();
  await expect(wsRow(page, "billing-api")).toHaveAttribute("aria-selected", "true");
  await expect(workspacesTab(page)).toHaveAttribute("aria-selected", "true");
  await filesTab(page).click();
  await expect(page.getByTestId("files-workspace-name")).toHaveText("billing-api");

  // Switcher: search, pick with Enter; it stays on Files.
  await switcherButton(page).click();
  await expect(page.getByRole("option")).toHaveCount(2);
  await switcherSearch(page).fill("orders");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(switcherSearch(page)).toHaveCount(0);
  await expect(page.getByTestId("files-workspace-name")).toHaveText("orders-service");
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");

  // Esc closes the popover and leaves the tab alone.
  await switcherButton(page).click();
  await expect(switcherSearch(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(switcherSearch(page)).toHaveCount(0);
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");

  // "Manage workspaces…" goes to the Workspaces tab.
  await switcherButton(page).click();
  await page.getByRole("button", { name: "Manage workspaces…" }).click();
  await expect(workspacesTab(page)).toHaveAttribute("aria-selected", "true");

  // Right click on a row: workspace actions only, "Make active" is gone.
  await wsRow(page, "billing-api").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Move up" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Make active" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "New File", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("workspace panel · red badge for a blocked agent in another workspace", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=en&workspaces=2");
  await expect(page.getByTestId("workspaces-alert-badge")).toHaveCount(0);
  await pushAgents(page, BLOCKED_IN_BILLING);
  const badge = page.getByTestId("workspaces-alert-badge");
  await expect(badge).toHaveText("1");
  await expect(badge).toHaveAttribute("title", "1 agent needs permission in other workspaces");
  await workspacesTab(page).click();
  await expect(wsRow(page, "billing-api").getByTestId("agent-state-pill")).toHaveText("Needs permission");
  // Opening that workspace removes the badge: its agents are now in front of the user.
  await wsRow(page, "billing-api").click();
  await expect(page.getByTestId("workspaces-alert-badge")).toHaveCount(0);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("workspace panel · files header buttons and the empty-area menu", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=en");
  await expect(page.getByTitle("README.md", { exact: true })).toBeVisible();
  // "New file" starts an inline input at the top (no root row to anchor on).
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await expect(page.getByPlaceholder("New file name")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("New file name")).toHaveCount(0);
  // Right click below the rows: the root's file actions.
  const tree = page.locator("div.overflow-auto[tabindex='0']").last();
  const box = await tree.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 8, { button: "right" });
  for (const name of ["New File", "New Folder", "Save clipboard image here", "Open terminal here"]) {
    await expect(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
  }
  await page.getByRole("menuitem", { name: "New Folder", exact: true }).click();
  await expect(page.getByPlaceholder("New folder name")).toBeVisible();
  await page.keyboard.press("Escape");
  expect(errors, errors.join("\n")).toEqual([]);
});

for (const theme of ["dark", "light"] as const) {
  for (const lang of ["en", "tr"] as const) {
    test(`workspace panel · screenshots · ${theme} · ${lang}`, async ({ page }) => {
      const errors = await open(page, `theme=${theme}&lang=${lang}&workspaces=2`);
      await pushAgents(page, BLOCKED_IN_BILLING);
      await expect(page.getByTestId("workspaces-alert-badge")).toHaveText("1");
      await expect(page.getByTitle("README.md", { exact: true })).toBeVisible();
      const panel = page.getByTestId("workspace-panel-tabs").locator("xpath=../..");
      await page.waitForTimeout(300);
      await panel.screenshot({ path: `test-results/screens/workspace-panel-files-${theme}-${lang}.png` });

      await workspacesTab(page).click();
      await expect(page.getByRole("option")).toHaveCount(2);
      await page.waitForTimeout(200);
      await panel.screenshot({ path: `test-results/screens/workspace-panel-workspaces-${theme}-${lang}.png` });

      await filesTab(page).click();
      await switcherButton(page).click();
      await expect(switcherSearch(page)).toBeVisible();
      await page.waitForTimeout(200);
      await panel.screenshot({ path: `test-results/screens/workspace-panel-switcher-${theme}-${lang}.png` });
      await page.screenshot({ path: `test-results/screens/workspace-panel-switcher-full-${theme}-${lang}.png` });
      await page.keyboard.press("Escape");
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
}

// D-080: workspace groups. The mock keeps groups in memory; `save_state_slice` is a no-op there,
// so the collapsed state is asserted within one page load (persistence has unit tests).
async function createGroupFrom(page: Page, wsName: string, group: string) {
  await wsRow(page, wsName).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to group…", exact: true }).click();
  await page.getByRole("menuitem", { name: "New group…", exact: true }).click();
  await page.getByPlaceholder("Group name").fill(group);
  await page.keyboard.press("Enter");
}

test("workspace groups · create, move in, collapse, keyboard, Ctrl+digit order, delete", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=en&workspaces=4");
  await workspacesTab(page).click();
  await expect(page.getByRole("option")).toHaveCount(4);
  await expect(page.getByRole("group")).toHaveCount(0);

  await createGroupFrom(page, "orders-service", "Work");
  const work = page.getByRole("group", { name: "Work" });
  await expect(work).toBeVisible();
  await expect(work).toContainText("1");
  await expect(page.getByRole("group", { name: "Ungrouped" })).toBeVisible();

  // Move a second workspace in through the swapped menu; the current group is offered.
  await wsRow(page, "blog").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Remove from group", exact: true })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Move to group…", exact: true }).click();
  await page.getByRole("menuitem", { name: "Work", exact: true }).click();
  await expect(work).toContainText("2");

  // Ctrl+digit follows the display order: orders-service, blog, billing-api, space-game.
  await page.keyboard.press("ControlOrMeta+3");
  await expect(wsRow(page, "billing-api")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ControlOrMeta+2");
  await expect(wsRow(page, "blog")).toHaveAttribute("aria-selected", "true");

  // Collapse by click: member rows disappear.
  await work.click();
  await expect(work).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByRole("option")).toHaveCount(2);
  await work.click();
  await expect(page.getByRole("option")).toHaveCount(4);

  // Keyboard on the header: Left collapses, Right expands, Enter toggles.
  const list = page.getByRole("listbox", { name: "Workspaces" });
  await list.focus();
  await page.keyboard.press("ArrowUp"); // blog (active, 2nd in Work) -> orders-service
  await page.keyboard.press("ArrowUp"); // -> Work header
  await page.keyboard.press("ArrowLeft");
  await expect(work).toHaveAttribute("data-collapsed", "true");
  await page.keyboard.press("ArrowRight");
  await expect(work).toHaveAttribute("data-collapsed", "false");
  await page.keyboard.press("Enter");
  await expect(work).toHaveAttribute("data-collapsed", "true");
  // Ctrl+digit still counts the hidden rows.
  await page.keyboard.press("ControlOrMeta+1");
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option")).toHaveCount(4);

  await page.screenshot({ path: "test-results/screens/workspace-groups-dark-en.png" });

  // "Remove from group" is on the first menu level of a grouped workspace.
  await wsRow(page, "blog").click({ button: "right" });
  await page.screenshot({ path: "test-results/screens/workspace-groups-menu-dark-en.png" });
  await page.getByRole("menuitem", { name: "Remove from group", exact: true }).click();
  await expect(work).toContainText("1");

  // Delete the group from its menu: everybody is ungrouped again and the headers go away.
  await work.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete group", exact: true }).click();
  await expect(page.getByRole("group")).toHaveCount(0);
  await expect(page.getByRole("option")).toHaveCount(4);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("workspace groups · collapsed header badge, quick switcher labels and search", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=en&workspaces=4");
  await workspacesTab(page).click();
  await createGroupFrom(page, "billing-api", "Work");
  await pushAgents(page, BLOCKED_IN_BILLING);
  const work = page.getByRole("group", { name: "Work" });
  await work.click();
  await expect(page.getByTestId("group-alert-badge")).toHaveText("1");

  await filesTab(page).click();
  await switcherButton(page).click();
  await expect(page.getByTestId("switcher-group-label")).toHaveText(["Work", "Ungrouped"]);
  await switcherSearch(page).fill("o");
  await expect(page.getByTestId("switcher-group-label")).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(errors, errors.join("\n")).toEqual([]);
});

const AGENT_SECTION_FIXTURE = [
  { id: "s1", paneId: "p1", workspaceId: "ws-demo", kind: "claude", adapterId: "claude-code", state: "working", sinceMs: Date.now() - 60_000, source: "hook", sessionId: null },
  { id: "s2", paneId: "p2", workspaceId: "ws-demo", kind: "codex", adapterId: "codex", state: "blocked", sinceMs: Date.now() - 30_000, source: "hook", sessionId: null },
  { id: "s3", paneId: "p3", workspaceId: "ws-demo", kind: "claude", adapterId: "claude-code", state: "idle", sinceMs: Date.now() - 90_000, source: "hook", sessionId: null },
];

for (const theme of ["dark", "light"] as const) {
  for (const lang of ["en", "tr"] as const) {
    test(`workspace groups · screenshots · ${theme} · ${lang}`, async ({ page }) => {
      const errors = await open(page, `theme=${theme}&lang=${lang}&workspaces=4`);
      await workspacesTab(page).click();
      await wsRow(page, "orders-service").click({ button: "right" });
      await page.getByRole("menuitem", { name: lang === "en" ? "Move to group…" : "Gruba taşı…", exact: true }).click();
      await page.getByRole("menuitem", { name: lang === "en" ? "New group…" : "Yeni grup…", exact: true }).click();
      await page.getByPlaceholder(lang === "en" ? "Group name" : "Grup adı").fill(lang === "en" ? "Work" : "İş");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("group")).toHaveCount(2);
      await pushAgents(page, AGENT_SECTION_FIXTURE.map((a) => ({ ...a, workspaceId: "ws-billing" })));
      const panel = page.getByTestId("workspace-panel-tabs").locator("xpath=../..");
      await page.waitForTimeout(300);
      await panel.screenshot({ path: `test-results/screens/workspace-groups-list-${theme}-${lang}.png` });

      // Agents panel sections.
      const waiting = page.getByTestId("agents-section-blocked");
      await expect(waiting).toBeVisible();
      await expect(waiting).toContainText(lang === "en" ? "Waiting" : "Bekleyen");
      await expect(page.getByTestId("agents-section-working")).toContainText(lang === "en" ? "Working" : "Çalışan");
      await expect(page.getByTestId("agents-section-idle")).toContainText(lang === "en" ? "Idle" : "Boşta");
      await page.waitForTimeout(200);
      await waiting.locator("xpath=../..").screenshot({ path: `test-results/screens/agents-sections-${theme}-${lang}.png` });

      // Collapsing a section hides its rows.
      await waiting.getByRole("button").first().click();
      await expect(waiting).toHaveAttribute("data-collapsed", "true");
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
}

test("workspace groups · the header button opens the new-group input, also from Files", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=en&workspaces=4");
  await filesTab(page).click();
  await page.getByRole("button", { name: "New group", exact: true }).click();
  await expect(workspacesTab(page)).toHaveAttribute("aria-selected", "true");
  const input = page.getByPlaceholder("Group name");
  await expect(input).toBeFocused();
  await page.screenshot({ path: "test-results/screens/workspace-groups-header-button-dark-en.png" });
  await input.fill("Side projects");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("group", { name: "Side projects" })).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});
