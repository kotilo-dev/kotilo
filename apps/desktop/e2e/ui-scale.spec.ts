import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// D-081: interface scale (Rust zooms the webview, so xterm/Monaco sizes are divided by it) and
// interface font (`--font-ui`). The mocked IPC has no real zoom; this checks the sizes we hand over.
async function openSettings(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?${query}&panes=none`);
  await page.waitForTimeout(1000);
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: /New terminal|Yeni terminal/ }).first().click();
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+,");
  await page.waitForTimeout(500);
  return errors;
}

const termFontSize = (page: Page) =>
  page.evaluate(async () => {
    const registry = await import("/src/features/terminal/terminalRegistry.ts");
    return registry.allEntries()[0]!.term.options.fontSize;
  });

test("interface scale 125% hands xterm 15 / 1.25 = 12; the font field sets --font-ui", async ({ page }) => {
  const errors = await openSettings(page, "theme=dark&lang=en");
  expect(await termFontSize(page)).toBe(15);

  await page.getByLabel("Interface scale").selectOption("125");
  await expect.poll(() => termFontSize(page)).toBe(12);

  const font = page.getByLabel("Interface font");
  await font.fill("Comic Sans MS");
  await font.blur();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).fontFamily))
    .toContain("Comic Sans MS");
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--font-ui"))).toContain('"Comic Sans MS"');

  await page.getByRole("button", { name: "Reset" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--font-ui"))).toBe("");
  await page.getByLabel("Interface scale").selectOption("100");
  await expect.poll(() => termFontSize(page)).toBe(15);
  expect(errors, errors.join("\n")).toEqual([]);
});

for (const theme of ["dark", "light"]) {
  for (const lang of ["en", "tr"]) {
    test(`appearance settings screenshot · ${theme} ${lang}`, async ({ page }) => {
      const errors = await openSettings(page, `theme=${theme}&lang=${lang}`);
      await page.screenshot({ path: `test-results/screens/ui-scale-appearance-${theme}-${lang}.png` });
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
}
