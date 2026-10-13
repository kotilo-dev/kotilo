import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// The mocked clipboard holds "hello" (setup.ts `clipboard_read_text`).
async function openTerminal(page: Page) {
  await page.goto("/?theme=dark&lang=en");
  await page.waitForTimeout(1200);
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: "New terminal" }).first().click();
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__e2ePtyWrites.splice(0));
}

/** What the shell printed to turn on mouse tracking (SGR), the way agent TUIs do. */
async function trackMouse(page: Page) {
  await page.evaluate(async () => {
    const reg = await import("/src/features/terminal/terminalRegistry.ts");
    const term = reg.allEntries()[0]!.term as { write: (s: string, cb?: () => void) => void };
    await new Promise<void>((resolve) => term.write("\x1b[?1000h\x1b[?1006h", resolve));
  });
}

const writes = (page: Page) => page.evaluate(() => window.__e2ePtyWrites.slice());
const rightClick = (page: Page, modifiers: ("Shift")[] = []) =>
  page.locator(".xterm-screen").first().click({ button: "right", position: { x: 80, y: 40 }, modifiers });

test("terminal right click pastes once", async ({ page }) => {
  await openTerminal(page);
  await rightClick(page);
  await expect.poll(() => writes(page)).toEqual(["hello"]);
});

// A program tracking the mouse gets the click and may paste itself: Kotilo must not paste too.
test("terminal right click goes only to a program that tracks the mouse; Shift pastes", async ({ page }) => {
  await openTerminal(page);
  await trackMouse(page);
  await rightClick(page);
  await page.waitForTimeout(400);
  const sent = await writes(page);
  expect(sent.some((w) => w.startsWith("\x1b[<2;"))).toBe(true);
  expect(sent).not.toContain("hello");

  await page.evaluate(() => window.__e2ePtyWrites.splice(0));
  await rightClick(page, ["Shift"]);
  await expect.poll(() => writes(page)).toEqual(["hello"]);
});
