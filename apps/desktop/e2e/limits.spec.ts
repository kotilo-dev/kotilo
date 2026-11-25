import { expect, test } from "@playwright/test";
import { waitForApp } from "./app";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// D-078: Claude Code plan limits (fed by the status line helper) render exactly where Codex's do:
// Overview and Mission control meters, and the agent header strip in the workspace.
for (const theme of ["dark", "light"] as const) {
  test(`claude plan limits · overview + header strip · ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/?theme=${theme}&lang=en`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await waitForApp(page);
    await page.evaluate(() => window.__e2e.pushHubSnapshot());

    await page.keyboard.press("Alt+2");
    for (const name of ["Claude Code · 5-hour", "Claude Code · Weekly", "Codex CLI · 5-hour", "Codex CLI · Weekly"]) {
      await expect(page.getByRole("meter", { name })).toBeVisible();
    }
    await expect(page.getByRole("meter", { name: "Claude Code · 5-hour" })).toHaveAttribute("aria-valuenow", "42");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/limits-overview-${theme}.png` });

    await page.keyboard.press("Alt+3");
    await expect(page.getByRole("meter", { name: "Claude Code · Weekly" })).toBeVisible();

    await page.keyboard.press("Alt+1");
    await page.getByRole("button", { name: "New terminal" }).first().click();
    await page.waitForTimeout(400);
    await page.evaluate(async () => {
      const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
      await emit("agents:changed", [
        { id: "a1", paneId: "pane-claude", workspaceId: "ws-demo", kind: "claude", state: "working", sinceMs: Date.now() - 120_000, source: "hook", sessionId: "demo-claude-1" },
      ]);
    });
    await page.evaluate(() => window.__e2e.pushHubSnapshot());
    // The strip shows the agent's most-used window: 5-hour at 42%.
    await expect(page.getByText("5-hour limit")).toBeVisible();
    await expect(page.getByText("42%").first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/screens/limits-header-strip-${theme}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

// Settings → Agents → Claude Code: the status line switch starts off.
test("settings · claude status line switch · dark", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1900 });
  await page.goto("/?theme=dark&lang=en");
  await waitForApp(page);
  await page.evaluate(() => window.__e2e.pushHubSnapshot());
  await page.getByRole("navigation").first().getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  const box = page.getByRole("checkbox", { name: /Show plan limits/ });
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/limits-settings-dark.png" });
  expect(errors, errors.join(String.fromCharCode(10))).toEqual([]);
});
