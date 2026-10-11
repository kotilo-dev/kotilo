import { expect, test, type Page } from "@playwright/test";

// M5 About + updates against the mocked IPC (src/e2e/setup.ts): `update=available` makes
// `update_check` find 0.2.0 and `update_install` stream progress then `update://ready`;
// `update=install-error` fails the install; the default build is `not-configured`.
async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?${query}`);
  await page.waitForTimeout(800);
  return errors;
}

async function openAbout(page: Page, lang: "en" | "tr" = "en"): Promise<void> {
  const tr = lang === "tr";
  await page
    .getByRole("navigation", { name: tr ? "Ana gezinme" : "Main navigation" })
    .getByRole("button", { name: tr ? "Ayarlar" : "Settings", exact: true })
    .click();
  const nav = page.getByRole("navigation", { name: lang === "tr" ? "Ayar bölümleri" : "Settings sections" });
  await nav.getByRole("button", { name: lang === "tr" ? "Hakkında ve tanılama" : "About & diagnostics" }).click();
}

for (const theme of ["dark", "light"] as const) {
  test(`about · not configured · ${theme}`, async ({ page }) => {
    const errors = await open(page, `theme=${theme}&lang=en`);
    await openAbout(page);
    await expect(page.getByText("Free and open source under the Apache License 2.0.")).toBeVisible();
    await expect(page.getByText(/is not affiliated with or endorsed by their makers/)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Check for updates on start" })).toBeChecked();
    // brand.json names the repository: project links point at it (updates stay not-configured until the
    // updater public key is set).
    const links = page.getByRole("navigation", { name: "Project links" });
    await expect(links).toHaveCount(1);
    await expect(links.getByRole("link", { name: "Source code" })).toBeVisible();

    // The startup check (≈4 s) is silent for not-configured: no prompt, but About shows it.
    await expect(page.getByTestId("update-check-status")).toHaveText("Updates are not configured in this build.", { timeout: 10_000 });
    await expect(page.getByTestId("update-prompt")).toHaveCount(0);
    await page.getByRole("button", { name: "Check for updates" }).click();
    await expect(page.getByTestId("update-check-status")).toHaveText("Updates are not configured in this build.");

    await page.getByRole("button", { name: "Show open-source licenses" }).click();
    const licenses = page.getByTestId("licenses-text");
    await expect(licenses).toContainText("THIRD-PARTY SOFTWARE NOTICES");
    await page.getByRole("searchbox", { name: "Search licenses" }).fill("tokio");
    await expect(page.getByText(/matching line/)).toBeVisible();
    await expect(licenses).toContainText("tokio");
    await page.screenshot({ path: `test-results/screens/about-${theme}-en.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("about · tr", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=tr");
  await openAbout(page, "tr");
  await expect(page.getByText("Apache Lisansı 2.0 ile ücretsiz ve açık kaynak.")).toBeVisible();
  await expect(page.getByTestId("update-check-status")).toHaveText("Bu derlemede güncellemeler yapılandırılmamış.", { timeout: 10_000 });
  await page.screenshot({ path: "test-results/screens/about-dark-tr.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});

for (const theme of ["dark", "light"] as const) {
  test(`update prompt · available → install → ready · ${theme}`, async ({ page }) => {
    const errors = await open(page, `theme=${theme}&lang=en&update=available`);
    const prompt = page.getByTestId("update-prompt");
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt).toContainText("0.2.0 is available");
    await expect(prompt).toContainText("You have 0.1.0 · released 2026-10-09");
    await expect(prompt).toContainText("Faster Mission control previews.");
    await page.screenshot({ path: `test-results/screens/update-prompt-${theme}.png` });

    await prompt.getByRole("button", { name: "Install and restart" }).click();
    await expect(prompt).toContainText("Downloading… 62%");
    await expect(prompt.getByRole("button", { name: "Later" })).toBeDisabled();
    await page.screenshot({ path: `test-results/screens/update-progress-${theme}.png` });
    await expect(prompt).toContainText("the app restarts in a moment", { timeout: 5_000 });
    await page.screenshot({ path: `test-results/screens/update-ready-${theme}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("update prompt · install error, then Later", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=en&update=install-error");
  const prompt = page.getByTestId("update-prompt");
  await expect(prompt).toBeVisible({ timeout: 20_000 });
  await prompt.getByRole("button", { name: "Install and restart" }).click();
  await expect(prompt.getByRole("alert")).toHaveText(/could not be installed: The update signature could not be verified\./);
  await expect(prompt.getByRole("button", { name: "Try again" })).toBeEnabled();
  await page.screenshot({ path: "test-results/screens/update-error-dark.png" });
  await prompt.getByRole("button", { name: "Close" }).click();
  await expect(prompt).toHaveCount(0);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("update prompt · manual check from About, Later hides it", async ({ page }) => {
  const errors = await open(page, "theme=dark&lang=en&update=available");
  await openAbout(page);
  // Turning the setting off before the startup check fires keeps the start silent.
  await page.getByRole("checkbox", { name: "Check for updates on start" }).uncheck();
  await page.waitForTimeout(4500);
  await expect(page.getByTestId("update-prompt")).toHaveCount(0);
  await page.getByRole("button", { name: "Check for updates" }).click();
  await expect(page.getByTestId("update-check-status")).toHaveText("Version 0.2.0 is available.");
  const prompt = page.getByTestId("update-prompt");
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Later" }).click();
  await expect(prompt).toHaveCount(0);
  expect(errors, errors.join("\n")).toEqual([]);
});
