import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// Settings structure: grouped nav with a filter, Mode segmented control, notification switches
// under Notifications, calm row actions. Screenshots in test-results/screens/.
async function openSettings(page: Page, query: string, lang: "en" | "tr"): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?${query}`);
  await page.waitForTimeout(800);
  await page
    .getByRole("navigation", { name: lang === "tr" ? "Ana gezinme" : "Main navigation" })
    .getByRole("button", { name: lang === "tr" ? "Ayarlar" : "Settings", exact: true })
    .click();
  return errors;
}

for (const theme of ["dark", "light"] as const) {
  for (const lang of ["en", "tr"] as const) {
    test(`settings sections · ${theme} ${lang}`, async ({ page }) => {
      const errors = await openSettings(page, `theme=${theme}&lang=${lang}`, lang);
      const nav = page.getByRole("navigation", { name: lang === "tr" ? "Ayar bölümleri" : "Settings sections" });
      const shot = (name: string) => page.screenshot({ path: `test-results/screens/settings-ux-${name}-${theme}-${lang}.png` });
      await shot("appearance");
      for (const [id, en, tr] of [
        ["agents", "Agents", "Ajanlar"],
        ["ai", "AI", "Yapay zekâ"],
        ["notifications", "Notifications", "Bildirimler"],
      ] as const) {
        await nav.getByRole("button", { name: lang === "tr" ? tr : en, exact: true }).click();
        await page.waitForTimeout(400);
        await shot(id);
      }
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
}

test("filter narrows the nav; notification switches live under Notifications", async ({ page }) => {
  const errors = await openSettings(page, "theme=dark&lang=en", "en");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("searchbox", { name: "Filter settings" }).fill("quiet");
  await expect(nav.getByRole("button", { name: "Notifications" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Terminal" })).toHaveCount(0);
  await nav.getByRole("button", { name: "Notifications" }).click();
  await expect(page.getByRole("checkbox", { name: "Notifications", exact: true })).toBeVisible();
  await expect(page.getByText("Changes in this section need Save.")).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});
