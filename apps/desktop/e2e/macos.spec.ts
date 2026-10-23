import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// U-3: `?platform=macos` makes the mocked `app_info` report macOS (setup.ts). Keys are sent to
// our own page only (Playwright), never to the desktop.
async function openMac(page: Page, extra = "") {
  await page.goto(`/?theme=dark&lang=en&platform=macos${extra}`);
  await page.waitForTimeout(1200);
}

async function openTerminal(page: Page) {
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: "New terminal" }).first().click();
  await page.waitForTimeout(600);
  await page.locator(".xterm-screen").first().click({ position: { x: 80, y: 40 } });
  await page.evaluate(() => window.__e2ePtyWrites.splice(0));
}

const writes = (page: Page) => page.evaluate(() => window.__e2ePtyWrites.slice());

test("macOS · Cmd+V pastes once, Ctrl+V and Ctrl+C go to the shell", async ({ page }) => {
  await openMac(page);
  await openTerminal(page);

  await page.keyboard.press("Meta+V");
  await expect.poll(() => writes(page)).toEqual(["hello"]);

  await page.evaluate(() => window.__e2ePtyWrites.splice(0));
  await page.keyboard.press("Control+V");
  await page.keyboard.press("Control+C");
  await expect.poll(() => writes(page)).toEqual(["\x16", "\x03"]);
});

test("macOS · Cmd shortcuts and labels in the palette and nav rail", async ({ page }) => {
  await openMac(page);
  await expect(page.locator('[data-route="overview"]')).toHaveAttribute("title", /\(⌥2\)$/);
  // Option+2 types "™" on a Mac keyboard; the route still switches (matched on e.code).
  await page.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "™", code: "Digit2", altKey: true, bubbles: true })),
  );
  await expect(page.locator('[data-route="overview"]')).toHaveAttribute("aria-current", "page");

  await page.keyboard.press("Meta+Shift+P");
  const palette = page.getByPlaceholder(/command/i);
  await expect(palette).toBeVisible();
  await palette.fill(">settings");
  await expect(page.getByText("⌘,").first()).toBeVisible();
  await page.screenshot({ path: "test-results/screens/macos-palette.png" });
  await page.keyboard.press("Escape");

  // Ctrl+Shift+P is not the palette on macOS.
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(300);
  await expect(palette).toBeHidden();

  await page.keyboard.press("Meta+,");
  await expect(page.locator('[data-route="settings"]')).toHaveAttribute("aria-current", "page");
});

test("macOS · the tree's context menu names Finder", async ({ page }) => {
  await openMac(page, "&workspaces=2");
  await page.getByTitle("billing-api", { exact: true }).click({ button: "right" });
  await expect(page.getByRole("button", { name: "Open in Finder" })).toBeVisible();
  await page.screenshot({ path: "test-results/screens/macos-context-menu.png" });
});
