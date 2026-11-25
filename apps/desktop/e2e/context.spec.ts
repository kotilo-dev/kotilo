import { expect, test, type Page } from "@playwright/test";
import { waitForApp } from "./app";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// 0.9 agent context (D-076) against the mocked `context_agents` / `context_report` /
// `context_read` commands (src/e2e/contextFixtures.ts, invented demo data): the "Agent context"
// tab from the workspace menu, the palette and the agent pane header; agent switch, read-only
// preview of a file outside the workspace, a workspace file opened in the viewer.

async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?${query}`);
  await waitForApp(page);
  await page.evaluate(() => window.__e2e.pushHubSnapshot());
  return errors;
}

/** The workspace's row on the Workspaces tab. */
const workspaceRow = (page: Page, name: string) => page.getByRole("option").filter({ has: page.getByTitle(name, { exact: true }) });
const fileRow = (page: Page, display: string) => page.locator(`[data-testid="context-file"][data-path="${display}"]`);

const LABELS = {
  en: { menu: "Agent context…", always: "≈ 3.8k tokens always loaded", preview: "Preview ~/.claude/CLAUDE.md", readOnly: "Read-only · outside the workspace" },
  tr: { menu: "Ajan bağlamı…", always: "≈ 3,8k token her zaman yüklü", preview: "~/.claude/CLAUDE.md önizlemesi", readOnly: "Salt okunur · çalışma alanının dışında" },
} as const;

for (const theme of ["dark", "light"] as const) {
  for (const lang of ["en", "tr"] as const) {
    test(`context · tab from the workspace menu · ${theme} · ${lang}`, async ({ page }) => {
      const l = LABELS[lang];
      const errors = await open(page, `theme=${theme}&lang=${lang}&context=demo`);
      await page.getByTestId("workspace-panel-tabs").getByRole("tab").first().click();
      await workspaceRow(page, "orders-service").click({ button: "right" });
      await page.getByRole("button", { name: l.menu }).click();
      const view = page.getByTestId("context-view");
      await expect(view).toHaveAttribute("data-agent", "claude-code");
      await expect(view.getByTestId("context-totals")).toContainText(l.always);
      await expect(view.getByTestId("context-section-always").getByTestId("context-file")).toHaveCount(6);
      await expect(view.getByTestId("context-section-onDemand").getByTestId("context-file")).toHaveCount(1);
      await expect(view.getByTestId("context-section-rules").getByTestId("context-file")).toHaveCount(2);
      await expect(view.getByTestId("context-skill")).toHaveCount(2);
      await expect(view.getByTestId("context-mcp")).toHaveCount(5);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/screens/context-tab-${theme}-${lang}.png` });

      // Read-only preview of a home file, inside the tab.
      await view.getByRole("button", { name: l.preview }).click();
      const preview = view.getByTestId("context-preview");
      await expect(preview).toContainText(l.readOnly);
      await expect(preview.getByRole("heading", { name: "My defaults" })).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/screens/context-preview-${theme}-${lang}.png` });
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
}

test("context · pane header opens the agent's context; switch agent, preview, open in the viewer", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=en&context=demo&panes=pane-codex");
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: "New terminal" }).first().click();
  await page.waitForTimeout(400);
  // Push again now that the pane exists: under load the first snapshot can arrive before it.
  await page.evaluate(() => window.__e2e.pushHubSnapshot());

  // The Codex pane's header button opens the tab with Codex.
  await page.locator("[data-agent-pane]").getByRole("button", { name: "Agent context" }).click();
  const view = page.getByTestId("context-view");
  await expect(view).toHaveAttribute("data-agent", "codex");
  await expect(view.getByTestId("context-totals")).toContainText("This agent reads at most 32 KB of instructions in total.");
  await expect(fileRow(page, "AGENTS.md").getByText("over limit")).toBeVisible();
  await expect(view.getByTestId("context-sources")).toContainText("not found");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/context-codex-over-limit-dark.png" });

  // Switch to Claude Code.
  await view.getByRole("combobox", { name: "Agent" }).selectOption("claude-code");
  await expect(view).toHaveAttribute("data-agent", "claude-code");
  await expect(fileRow(page, "docs/conventions.md")).toBeVisible();
  await expect(view.getByTestId("context-file").filter({ hasText: "ProgramData" }).getByText("unreadable")).toBeVisible();
  const github = view.locator('[data-testid="context-mcp"][data-name="github"]');
  await expect(github.first().getByTestId("context-secrets")).toHaveAttribute("title", "Values never leave the config file: env.GITHUB_PERSONAL_ACCESS_TOKEN");
  await expect(github.nth(1)).toContainText("shadowed by .mcp.json");
  await expect(view.locator('[data-testid="context-mcp"][data-name="postgres"]')).toContainText("disabled");
  expect(await page.evaluate(() => window.__e2eContext.reports.map((r) => r.agent))).toEqual(expect.arrayContaining(["codex", "claude-code"]));

  // A user-scope file outside the workspace: read-only preview with the truncated note.
  await view.getByRole("button", { name: "Preview ~/.claude/shared/review.md" }).click();
  const preview = view.getByTestId("context-preview");
  await expect(preview.getByRole("heading", { name: "Review checklist" })).toBeVisible();
  await expect(preview).toContainText("Only the first 256 KB are shown.");
  expect(await page.evaluate(() => window.__e2eContext.reads)).toEqual(["C:\\Users\\demo\\.claude\\shared\\review.md"]);

  // A workspace file opens in the normal viewer.
  await view.getByRole("button", { name: "Open CLAUDE.md", exact: true }).click();
  await expect(page.getByTestId("context-view")).toHaveCount(0);
  await expect(page.locator(".md-preview").getByRole("heading", { name: "orders-service" })).toBeVisible();

  // Back on the tab: still Claude Code, the preview is still open.
  await page.locator('div[title="Agent context"]').click();
  await expect(page.getByTestId("context-view")).toHaveAttribute("data-agent", "claude-code");
  await expect(page.getByTestId("context-preview")).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("context · palette, empty state for an agent without data, Turkish", async ({ page }) => {
  const errors = await open(page, "theme=light&lang=tr&context=demo");
  const palette = page.getByPlaceholder(/komut/i);
  // The first key press can land before the app has focus under load; press until it opens.
  await expect(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press("Control+Shift+P");
    await expect(palette).toBeVisible({ timeout: 1000 });
  }).toPass();
  await palette.fill(">Bağlamı");
  await expect(page.getByText("Ajan: Bağlamı göster").first()).toBeVisible();
  await page.keyboard.press("Enter");
  const view = page.getByTestId("context-view");
  await expect(view).toHaveAttribute("data-agent", "claude-code");
  await view.getByRole("combobox", { name: "Ajan" }).selectOption("gemini");
  await expect(view.getByTestId("context-empty")).toContainText("Bu ajan burada hiçbir talimat dosyası");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/context-empty-light-tr.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});
