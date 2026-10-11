import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// D-057: app colour themes + terminal schemes. Workspace with a terminal showing coloured sample
// output, and Settings → Appearance / Terminal, per theme; fails on uncaught page errors.
const THEMES = [
  { id: "kotilo-dark", mode: "dark" },
  { id: "catppuccin-mocha", mode: "dark" },
  { id: "catppuccin-latte", mode: "light" },
  { id: "gruvbox-dark", mode: "dark" },
  { id: "tokyo-night", mode: "dark" },
] as const;

const E = "\x1b[";
const SAMPLE = [
  `${E}1;32m❯${E}0m ${E}36morders-service${E}0m on ${E}35m feature/approval-flow${E}0m ${E}33m!2 ?1${E}0m`,
  `${E}90m# ansi 0–7:${E}0m ${E}30m■ black${E}0m ${E}31m■ red${E}0m ${E}32m■ green${E}0m ${E}33m■ yellow${E}0m ${E}34m■ blue${E}0m ${E}35m■ magenta${E}0m ${E}36m■ cyan${E}0m ${E}37m■ white${E}0m`,
  `${E}90m# ansi 8–15:${E}0m ${E}90m■ black${E}0m ${E}91m■ red${E}0m ${E}92m■ green${E}0m ${E}93m■ yellow${E}0m ${E}94m■ blue${E}0m ${E}95m■ magenta${E}0m ${E}96m■ cyan${E}0m ${E}97m■ white${E}0m`,
  `${E}1;31merror${E}0m${E}1m: cannot find value \`approval\` in this scope${E}0m`,
  `${E}1;33mwarning${E}0m: unused import: \`std::fmt\``,
  `${E}1;32m✓${E}0m 42 tests passed ${E}90m(1.84s)${E}0m`,
  `${E}7m inverse ${E}0m ${E}4munderline${E}0m ${E}1mbold${E}0m plain text`,
].join("\r\n");

async function openApp(page: Page, query: string, expectedTheme: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?lang=en&${query}`);
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", expectedTheme);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__e2e.pushHubSnapshot());
  await page.waitForTimeout(300);
  return errors;
}

async function writeSample(page: Page): Promise<void> {
  await page.evaluate(async (sample) => {
    const registry = await import("/src/features/terminal/terminalRegistry.ts");
    for (const entry of registry.allEntries()) entry.term.write(`\x1b[2J\x1b[H${sample}\r\n`);
  }, SAMPLE);
  await page.waitForTimeout(400);
}

async function openSettings(page: Page, section: string): Promise<void> {
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: section, exact: true }).click();
  await page.waitForTimeout(400);
}

for (const { id, mode } of THEMES) {
  test(`theme ${id}: workspace terminal + Settings → Appearance`, async ({ page }) => {
    const errors = await openApp(page, `theme=${mode}&colorTheme=${id}`, id);
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    await page.keyboard.press("Alt+1");
    await page.getByRole("button", { name: "New terminal" }).first().click();
    await page.waitForTimeout(800);
    await writeSample(page);
    await page.screenshot({ path: `test-results/screens/theme-${id}-workspace.png` });

    await openSettings(page, "Appearance");
    await expect(page.locator(`[role="radio"][data-theme-id="${id}"]`)).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: `test-results/screens/theme-${id}-appearance.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("theme switch applies live, and the terminal follows a separate / imported scheme", async ({ page }) => {
  const errors = await openApp(page, "theme=dark", "kotilo-dark");
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: "New terminal" }).first().click();
  await page.waitForTimeout(800);
  await writeSample(page);

  // Appearance: pick Catppuccin Mocha – tokens change without a reload.
  await openSettings(page, "Appearance");
  await page.locator('[role="radio"][data-theme-id="catppuccin-mocha"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-color-theme", "catppuccin-mocha");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--terminal-bg").trim())).toBe("#1e1e2e");

  // Terminal: import "One Half Dark" from Windows Terminal (mocked) and use it.
  await openSettings(page, "Terminal");
  await page.getByRole("button", { name: "Import from Windows Terminal…" }).click();
  const dialog = page.getByRole("dialog", { name: "Import from Windows Terminal" });
  await dialog.getByRole("checkbox", { name: /One Half Dark/ }).check();
  await page.screenshot({ path: "test-results/screens/theme-terminal-import-dialog.png" });
  await dialog.getByRole("button", { name: "Import 1 scheme" }).click();
  await expect(page.getByRole("button", { name: "Remove One Half Dark" })).toBeVisible();
  await page.getByLabel("Color scheme").selectOption("imported:One Half Dark");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/theme-terminal-settings.png" });

  // The open terminal switched without reopening: its host shows the imported background.
  await page.keyboard.press("Alt+1");
  await page.waitForTimeout(500);
  const hostBg = await page.evaluate(async () => {
    const registry = await import("/src/features/terminal/terminalRegistry.ts");
    return registry.allEntries()[0]?.host.style.background;
  });
  expect(hostBg).toBe("rgb(40, 44, 52)");
  await page.screenshot({ path: "test-results/screens/theme-terminal-imported-workspace.png" });

  // Removing the selected import falls back to "Same as app".
  await openSettings(page, "Terminal");
  await page.getByRole("button", { name: "Remove One Half Dark" }).click();
  await expect(page.getByLabel("Color scheme")).toHaveValue("app");
  expect(errors, errors.join("\n")).toEqual([]);
});
