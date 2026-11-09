import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// 0.7 docs check (D-074) against the mocked `docs_check` / `docs_mark_reviewed` commands
// (src/e2e/docsFixtures.ts, invented demo data): tree badges, the Docs tab (filter, expand,
// open at a line, diff from the baseline, mark reviewed, update with agent), Turkish, palette.
const REVIEWED = "3f2c1ab9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3";

async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?${query}`);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__e2e.pushHubSnapshot());
  return errors;
}

/** A tree row by its title (file or folder name). */
const treeRow = (page: Page, name: string) => page.locator("div.group").filter({ has: page.getByTitle(name, { exact: true }) });

async function expandTree(page: Page) {
  const root = treeRow(page, "orders-service");
  if (await root.getByText("▶").isVisible()) await root.getByText("▶").click();
  await expect(page.getByTitle("AGENTS.md", { exact: true })).toBeVisible();
  await treeRow(page, "docs").click();
  await expect(page.getByTitle("api.md", { exact: true })).toBeVisible();
}

const docRow = (page: Page, path: string) => page.locator(`[data-testid="docs-row"][data-doc="${path}"]`);

for (const theme of ["dark", "light"] as const) {
  test(`docs · tree badges and the Docs tab · ${theme}`, async ({ page }) => {
    const errors = await open(page, `theme=${theme}&lang=en&docs=demo&panes=pane-claude`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    // A running Claude pane to hand the prompt to (hub session fixture on pane-claude).
    await page.keyboard.press("Alt+1");
    await page.getByRole("button", { name: "New terminal" }).first().click();
    await page.waitForTimeout(400);

    // Badges: missing (red) wins over stale (amber); clean docs have none.
    await expandTree(page);
    await expect(treeRow(page, "AGENTS.md").getByTestId("doc-badge")).toHaveAttribute("data-kind", "missing");
    await expect(treeRow(page, "AGENTS.md").getByTestId("doc-badge")).toHaveAttribute("title", "2 missing paths");
    await expect(treeRow(page, "api.md").getByTestId("doc-badge")).toHaveAttribute("data-kind", "missing");
    await expect(treeRow(page, "api.md").getByTestId("doc-badge")).toHaveAttribute("title", "1 missing path · stale since 3f2c1ab");
    await expect(treeRow(page, "setup.md").getByTestId("doc-badge")).toHaveAttribute("data-kind", "stale");
    await expect(treeRow(page, "README.md").getByTestId("doc-badge")).toHaveCount(0);
    await page.screenshot({ path: `test-results/screens/docs-tree-badges-${theme}.png` });

    // Workspace context menu → Check docs.
    await treeRow(page, "orders-service").click({ button: "right" });
    await page.getByRole("button", { name: "Check docs" }).click();
    const view = page.getByTestId("docs-view");
    await expect(view).toBeVisible();
    await expect(view.getByTestId("docs-summary")).toHaveText("6 docs scanned · 2 with missing paths · 2 stale");
    await expect(view.getByTestId("docs-row")).toHaveCount(3);
    await expect(view.getByTestId("docs-row").first()).toHaveAttribute("data-doc", "AGENTS.md");
    await expect(docRow(page, "AGENTS.md")).toContainText("Agent file");

    // Filter.
    await view.getByRole("radio", { name: "Missing 2" }).click();
    await expect(view.getByTestId("docs-row")).toHaveCount(2);
    await view.getByRole("radio", { name: "Stale 2" }).click();
    await expect(view.getByTestId("docs-row").first()).toHaveAttribute("data-doc", "docs/api.md");
    await expect(view.getByTestId("docs-row").nth(1)).toHaveAttribute("data-doc", "docs/setup.md");
    await view.getByRole("radio", { name: "All 3" }).click();

    // Expand: missing paths and why stale.
    await page.getByRole("button", { name: "Details for AGENTS.md" }).click();
    await expect(docRow(page, "AGENTS.md").getByTestId("docs-missing")).toContainText("src/legacy/queue.ts");
    await page.getByRole("button", { name: "Details for docs/api.md" }).click();
    const api = docRow(page, "docs/api.md");
    await expect(api.getByTestId("docs-missing")).toContainText("schema/orders.json");
    await expect(api.getByTestId("docs-missing")).toContainText("docs.toml, matches nothing");
    await expect(api.getByTestId("docs-stale")).toContainText("3 commits changed covered code since 3f2c1ab (last review).");
    await expect(api.getByTestId("docs-stale")).toContainText("Rename OrderStatus.Pending to Open");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/docs-tab-${theme}.png` });

    // A missing path opens the doc at that line (source view).
    await page.getByRole("button", { name: "Open AGENTS.md at line 14" }).click();
    await expect(page.locator(".monaco-editor .view-line").filter({ hasText: "src/legacy/queue.ts" })).toBeVisible();

    // Back on the Docs tab, the rows stay expanded; a changed file opens its diff from the baseline.
    await page.getByTitle("Docs", { exact: true }).click();
    await expect(api.getByTestId("docs-stale")).toBeVisible();
    await page.getByRole("button", { name: "Show changes in src/api/orders.ts since 3f2c1ab" }).click();
    await expect(page.getByTestId("diff-view")).toContainText("3f2c1ab9 ↔ working copy");
    await expect.poll(() => page.evaluate(() => window.__e2eDocs.showHead.at(-1))).toEqual({ path: "src/api/orders.ts", rev: REVIEWED });

    // Mark reviewed: confirmation names docs.toml; the doc drops out once it is no longer stale.
    await page.getByTitle("Docs", { exact: true }).click();
    await page.getByRole("button", { name: "Details for docs/setup.md" }).click();
    await expect(docRow(page, "docs/setup.md").getByTestId("docs-stale")).toContainText("The reviewed commit no longer exists");
    await docRow(page, "docs/setup.md").getByRole("button", { name: "Mark reviewed" }).click();
    await expect(page.getByText("Mark docs/setup.md as reviewed?")).toBeVisible();
    await expect(page.getByText(/writes the current commit b41e9c0 for this doc into \.kotilo\/docs\.toml/)).toBeVisible();
    await page.screenshot({ path: `test-results/screens/docs-mark-reviewed-${theme}.png` });
    await page.getByRole("button", { name: "Mark reviewed", exact: true }).last().click();
    await expect(docRow(page, "docs/setup.md")).toHaveCount(0);
    expect(await page.evaluate(() => window.__e2eDocs.reviewed)).toEqual(["docs/setup.md"]);
    await expect(page.getByText("Marked docs/setup.md as reviewed")).toBeVisible();
    await expect(treeRow(page, "setup.md").getByTestId("doc-badge")).toHaveCount(0);

    // Update with agent: the prompt lands in the Claude pane's composer, nothing is sent.
    await docRow(page, "AGENTS.md").getByRole("button", { name: "Update with agent…" }).click();
    await page.getByRole("button", { name: "Claude Code", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Message Claude Code" });
    await expect(composer).toBeFocused();
    const text = await composer.inputValue();
    expect(text).toContain("Update AGENTS.md so it matches the current code. Do not change code. Keep the existing structure.");
    expect(text).toContain("- src/legacy/queue.ts (line 14)");
    expect(text).toContain("- scripts/old-build.ps1 (line 22)");
    expect(text).not.toContain("Background jobs go through the queue");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/docs-update-with-agent-${theme}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("docs · palette, empty state with a copyable example, Turkish", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=tr&docs=empty");
  await page.keyboard.press("Control+Shift+P");
  const palette = page.getByPlaceholder(/komut/i);
  await expect(palette).toBeVisible();
  await palette.fill(">Denetle");
  await expect(page.getByText("Dokümanlar: Denetle").first()).toBeVisible();
  await page.keyboard.press("Enter");
  const view = page.getByTestId("docs-view");
  await expect(view.getByTestId("docs-empty")).toContainText("Henüz koda bağlanan bir doküman yok");
  await expect(view.getByTestId("docs-summary")).toHaveText("2 doküman tarandı · 0 dokümanda eksik yol · 0 doküman güncel değil");
  await view.getByRole("button", { name: "Örneği kopyala" }).click();
  await expect.poll(() => page.evaluate(() => window.__e2eClipboard.at(-1))).toContain('[[doc]]\npath = "docs/api.md"');
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/docs-empty-dark-tr.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});

test("docs · tab in Turkish", async ({ page }) => {
  const errors = await open(page, "theme=light&lang=tr&docs=demo");
  await treeRow(page, "orders-service").click({ button: "right" });
  await page.getByRole("button", { name: "Dokümanları denetle" }).click();
  const view = page.getByTestId("docs-view");
  await expect(view.getByTestId("docs-summary")).toHaveText("6 doküman tarandı · 2 dokümanda eksik yol · 2 doküman güncel değil");
  await page.getByRole("button", { name: "AGENTS.md ayrıntıları" }).click();
  await page.getByRole("button", { name: "docs/api.md ayrıntıları" }).click();
  await expect(docRow(page, "AGENTS.md")).toContainText("Ajan dosyası");
  await expect(docRow(page, "docs/api.md").getByTestId("docs-stale")).toContainText("Kapsanan kod 3f2c1ab sonrasında 3 commit ile değişti (son gözden geçirme).");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/docs-tab-light-tr.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});

test("docs · the tree badge setting in Settings → Files", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=en&docs=demo");
  await expandTree(page);
  await expect(treeRow(page, "AGENTS.md").getByTestId("doc-badge")).toBeVisible();
  await page.getByRole("navigation").first().getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Files", exact: true }).click();
  const box = page.getByRole("checkbox", { name: "Show docs check badges in the file tree" });
  await expect(box).toBeChecked();
  await box.uncheck();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/docs-setting-dark.png" });
  await page.getByRole("navigation").first().getByRole("button", { name: "Workspace" }).first().click();
  await expect(page.getByTitle("AGENTS.md", { exact: true })).toBeVisible();
  await expect(page.getByTestId("doc-badge")).toHaveCount(0);
  expect(errors, errors.join("\n")).toEqual([]);
});
