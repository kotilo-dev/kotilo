import { expect, test } from "@playwright/test";
import { waitForApp } from "./app";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// A Claude tab restored from the last run waits behind the Start overlay; its button must start it
// and hand the keyboard to the terminal.
test("restored agent tab · Start button spawns the agent", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?theme=dark&lang=en&restore=agent");
  await waitForApp(page);
  await page.keyboard.press("Alt+1");
  const start = page.getByRole("button", { name: "Start claude" });
  await expect(start).toBeVisible();
  await page.screenshot({ path: "test-results/screens/restore-start-overlay.png" });
  await start.click();
  await expect(start).toBeHidden();
  // The overlay button vanishes on click; the keyboard must land in the started terminal, not on <body>.
  await expect(page.locator(".xterm-helper-textarea:focus")).toHaveCount(1);
  expect(errors).toEqual([]);
});
