import { expect, test } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// D-075: Days | Weeks switch on the Usage page's chart card.
for (const theme of ["dark", "light"] as const) {
  for (const lang of ["en", "tr"] as const) {
    test(`usage weekly view · ${theme} · ${lang}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`/?theme=${theme}&lang=${lang}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.waitForTimeout(800);
      await page.locator('[data-route="usage"]').click();
      await page.getByRole("radio", { name: lang === "en" ? "Weeks" : "Hafta" }).click();
      const chart = page.getByRole("img", { name: lang === "en" ? "Weekly tokens over the last 12 weeks" : "Son 12 haftada haftalık token" });
      await expect(chart).toBeVisible();
      // 12 week bars (one transparent hover target each).
      await expect(chart.locator('rect[fill="transparent"]')).toHaveCount(12);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/screens/usage-weeks-${theme}-${lang}.png` });
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
}

// D-075: the tray menu carries today, the block, limits and the waiting sessions.
test("tray menu · usage summary and waiting sessions", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?theme=dark&lang=en");
  await expect
    .poll(async () => (await page.evaluate(() => window.__e2eTray.menus.at(-1) ?? [])).join("|"), { timeout: 10_000 })
    .toMatch(/^Today: .+ tokens ≈ .+\|5-hour block: .+ left\|Codex CLI · 5-hour 62%\|Codex CLI · Weekly 31%\|---\|Waiting for you\|gateway · Codex CLI · Needs permission\|---\|Show .+\|Quit .+$/);
  const tooltip = await page.evaluate(() => window.__e2eTray.tooltips.at(-1) ?? "");
  expect(tooltip.split("\n")[0]).not.toBe("");
  expect(tooltip).toContain("1 agent waiting");
  expect(errors, errors.join("\n")).toEqual([]);
});
