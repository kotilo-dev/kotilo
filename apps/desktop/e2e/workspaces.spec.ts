import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

/** The workspace root row whose name is `name`. */
function root(page: Page, name: string) {
  return page.locator("div.group").filter({ has: page.getByTitle(name, { exact: true }) });
}

async function expectActive(page: Page, name: string) {
  await expect(root(page, name).getByTitle("Active workspace")).toBeVisible();
}

// Switching workspaces with the mouse: the "Switch" button on hover, a double click, the context menu.
test("workspace switching · button, double click, context menu", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?theme=dark&lang=en&workspaces=2");
  await page.waitForTimeout(1200);
  await expectActive(page, "orders-service");

  // The active workspace and its tree come first; the others sit under their own header.
  const activeRoot = root(page, "orders-service");
  if (await activeRoot.getByText("▶").isVisible()) await activeRoot.getByText("▶").click();
  await expect(page.getByTitle("README.md", { exact: true })).toBeVisible();
  const header = page.getByText("Other workspaces (1)");
  await expect(header).toBeVisible();
  const [readmeBox, headerBox, billingBox] = await Promise.all([
    page.getByTitle("README.md", { exact: true }).boundingBox(),
    header.boundingBox(),
    page.getByTitle("billing-api", { exact: true }).boundingBox(),
  ]);
  expect(readmeBox!.y).toBeLessThan(headerBox!.y);
  expect(headerBox!.y).toBeLessThan(billingBox!.y);
  await page.screenshot({ path: "test-results/screens/workspace-groups.png" });

  // Names are not text fields: the normal arrow cursor.
  const billingName = page.getByTitle("billing-api", { exact: true });
  expect(await billingName.evaluate((el) => getComputedStyle(el).cursor)).toBe("default");

  await billingName.hover();
  const switchButton = root(page, "billing-api").getByRole("button", { name: "Switch" });
  await expect(switchButton).toBeVisible();
  await page.screenshot({ path: "test-results/screens/workspace-switch-hover.png" });
  await switchButton.click();
  await expectActive(page, "billing-api");

  await page.getByTitle("orders-service", { exact: true }).dblclick();
  await expectActive(page, "orders-service");

  await billingName.click({ button: "right" });
  await page.getByRole("button", { name: "Make active" }).click();
  await expectActive(page, "billing-api");
  expect(errors).toEqual([]);
});
