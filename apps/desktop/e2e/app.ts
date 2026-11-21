import type { Page } from "@playwright/test";

/**
 * Waits until the main window's App has rendered, then lets its startup effects settle.
 * `data-theme` is set before the App module loads, and under a parallel run the Vite dev
 * server can take several seconds more to serve it; a fixed wait then lets key presses and
 * startup checks land before the App exists.
 */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(1200);
}
