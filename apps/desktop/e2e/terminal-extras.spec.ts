import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// D-068: OSC 52 clipboard writes, Reset terminal / Copy recent output from the tab menu and the
// palette, and the link actions on a plain click. Invented demo text only.
async function openShell(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?theme=dark&lang=en&panes=none");
  await page.waitForTimeout(1000);
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: "New terminal" }).first().click();
  await page.waitForTimeout(500);
  return errors;
}

async function writeToTerminal(page: Page, data: string): Promise<void> {
  await page.evaluate(async (text) => {
    const registry = await import("/src/features/terminal/terminalRegistry.ts");
    const entry = registry.allEntries()[0]!;
    await new Promise<void>((resolve) => entry.term.write(text, resolve));
  }, data);
}

test("OSC 52 writes reach the clipboard, queries and the off switch are ignored", async ({ page }) => {
  const errors = await openShell(page);
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  await writeToTerminal(page, `\x1b]52;c;${b64("copied from vim ✓")}\x07`);
  await writeToTerminal(page, "\x1b]52;c;?\x07");
  await expect.poll(() => page.evaluate(() => window.__e2eClipboard)).toEqual(["copied from vim ✓"]);

  await page.evaluate(async () => {
    const { useSettingsStore } = await import("/src/stores/settingsStore.ts");
    useSettingsStore.getState().update({ terminal: { osc52Clipboard: false } });
  });
  await writeToTerminal(page, `\x1b]52;c;${b64("blocked")}\x07`);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__e2eClipboard)).toEqual(["copied from vim ✓"]);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("tab menu: copy recent output and reset stuck mouse mode", async ({ page }) => {
  const errors = await openShell(page);
  await writeToTerminal(page, "\r\n\r\nPS C:\src> npm test\r\n42 passed\r\n\x1b[?1000h\x1b[?1006h");
  expect(await page.evaluate(async () => (await import("/src/features/terminal/terminalRegistry.ts")).allEntries()[0]!.term.modes.mouseTrackingMode)).not.toBe("none");

  const tab = page.locator("[data-tab-id]").first();
  await tab.click({ button: "right" });
  await page.screenshot({ path: "test-results/screens/terminal-tab-menu.png" });
  await page.getByRole("button", { name: "Copy recent output" }).click();
  await expect.poll(() => page.evaluate(() => window.__e2eClipboard.at(-1))).toContain("npm test\n42 passed");

  await tab.click({ button: "right" });
  await page.getByRole("button", { name: "Reset terminal" }).click();
  await expect(page.getByText("Terminal modes reset.")).toBeVisible();
  expect(await page.evaluate(async () => (await import("/src/features/terminal/terminalRegistry.ts")).allEntries()[0]!.term.modes.mouseTrackingMode)).toBe("none");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("a plain click on a link offers its actions", async ({ page }) => {
  const errors = await openShell(page);
  await writeToTerminal(page, "\x1b[2J\x1b[HSee https://example.com/docs for details\r\n");
  const rows = page.locator(".xterm-screen");
  const box = (await rows.boundingBox())!;
  const cell = await page.evaluate(async () => {
    const registry = await import("/src/features/terminal/terminalRegistry.ts");
    const term = registry.allEntries()[0]!.term as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } } };
    return term._core._renderService.dimensions.css.cell;
  });
  // Column 10 of row 1 is inside the URL.
  await page.mouse.move(box.x + cell.width * 10.5, box.y + cell.height * 0.5);
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + cell.width * 10.5, box.y + cell.height * 0.5);
  await expect(page.getByRole("button", { name: "Open in browser" })).toBeVisible();
  await page.screenshot({ path: "test-results/screens/terminal-link-menu.png" });
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect.poll(() => page.evaluate(() => window.__e2eClipboard.at(-1))).toBe("https://example.com/docs");
  expect(errors, errors.join("\n")).toEqual([]);
});
