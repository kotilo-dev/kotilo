import { expect, test, type Page } from "@playwright/test";
import { waitForApp } from "./app";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// Watch rules against the fake hub (src/e2e/watchFixtures.ts): the rule badge on the permission
// card, the mark on timeline rows (`?watch=1`) and the Settings → Notifications block.
const VARIANTS = [
  { theme: "dark", lang: "en" },
  { theme: "light", lang: "en" },
  { theme: "dark", lang: "tr" },
  { theme: "light", lang: "tr" },
] as const;

async function open(page: Page, theme: string, lang: string, query = ""): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?theme=${theme}&lang=${lang}${query}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await waitForApp(page);
  await page.evaluate(() => window.__e2e.pushHubSnapshot());
  await page.waitForTimeout(300);
  return errors;
}

async function openWorkspaceWithAgents(page: Page, lang: string): Promise<void> {
  await page.keyboard.press("Alt+1");
  const newTerminal = lang === "tr" ? "Yeni terminal" : "New terminal";
  await page.getByRole("button", { name: newTerminal }).first().click();
  await page.waitForTimeout(400);
  await page.getByTitle(newTerminal).first().click();
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    const now = Date.now();
    await emit("agents:changed", [
      { id: "a1", paneId: "pane-claude", workspaceId: "ws-demo", kind: "claude", state: "working", sinceMs: now - 120_000, source: "hook", sessionId: "demo-claude-1" },
      { id: "a2", paneId: "pane-codex", workspaceId: "ws-demo", kind: "codex", state: "blocked", sinceMs: now - 72_000, source: "hook", sessionId: "demo-codex-1" },
    ]);
  });
  await page.evaluate(() => window.__e2e.pushHubSnapshot());
  await page.waitForTimeout(800);
}

for (const { theme, lang } of VARIANTS) {
  test(`watch permission card · ${theme} · ${lang}`, async ({ page }) => {
    const errors = await open(page, theme, lang, "&watch=1");
    await openWorkspaceWithAgents(page, lang);

    const badge = page.getByTestId("permission-watch-rule");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(lang === "tr" ? "Kural: Zorla push" : "Rule: Force push");
    await page.screenshot({ path: `test-results/screens/watch-permission-${theme}-${lang}.png` });

    expect(errors, errors.join("\n")).toEqual([]);
  });
}

// One terminal: the working Claude session, whose activity carries two hits.
for (const { theme, lang } of VARIANTS) {
  test(`watch timeline mark · ${theme} · ${lang}`, async ({ page }) => {
    const errors = await open(page, theme, lang, "&watch=1");
    await page.keyboard.press("Alt+1");
    await page.getByRole("button", { name: lang === "tr" ? "Yeni terminal" : "New terminal" }).first().click();
    await page.waitForTimeout(400);
    await page.evaluate(async () => {
      const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
      await emit("agents:changed", [
        { id: "a1", paneId: "pane-claude", workspaceId: "ws-demo", kind: "claude", state: "working", sinceMs: Date.now() - 120_000, source: "hook", sessionId: "demo-claude-1" },
      ]);
    });
    await page.evaluate(() => window.__e2e.pushHubSnapshot());
    await page.waitForTimeout(600);
    const marks = page.getByTestId("timeline-rail").getByTestId("timeline-watch-mark");
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveAttribute("aria-label", lang === "tr" ? "İzleme kuralı: Zorla push" : "Watch rule: Force push");
    await page.screenshot({ path: `test-results/screens/watch-timeline-${theme}-${lang}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("the permission card has no rule badge without a hit", async ({ page }) => {
  const errors = await open(page, "dark", "en");
  await openWorkspaceWithAgents(page, "en");
  await expect(page.getByRole("region", { name: "Permission request" })).toBeVisible();
  await expect(page.getByTestId("permission-watch-rule")).toHaveCount(0);
  expect(errors, errors.join("\n")).toEqual([]);
});

for (const { theme, lang } of VARIANTS) {
  test(`settings watch rules · ${theme} · ${lang}`, async ({ page }) => {
    const tr = lang === "tr";
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 2600 });
    await page.goto(`/?theme=${theme}&lang=${lang}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await waitForApp(page);
    await page.evaluate(() => window.__e2e.pushHubSnapshot());
    await page.waitForTimeout(300);
    await page.getByRole("navigation").first().getByRole("button", { name: tr ? "Ayarlar" : "Settings", exact: true }).click();
    await page.getByRole("button", { name: tr ? "Bildirimler" : "Notifications", exact: true }).click();

    await expect(page.getByRole("group", { name: tr ? "İzleme kuralları" : "Watch rules" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: tr ? "Gizli dosya" : "Secret file", exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: tr ? "Geniş silme" : "Wide delete", exact: true })).not.toBeChecked();
    await expect(page.getByText(tr ? "3 kural" : "3 rules")).toBeVisible();

    // Try a command against the fake evaluator.
    await page.getByRole("textbox", { name: tr ? "Komut" : "Command", exact: true }).fill("git push --force origin main");
    await page.getByRole("button", { name: tr ? "Dene" : "Test", exact: true }).click();
    await expect(page.getByTestId("watch-test-matches")).toContainText(tr ? "Zorla push" : "Force push");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/settings-watch-${theme}-${lang}.png` });

    // Adding a rule needs a name and a match field; the rule then shows in the list.
    await page.getByRole("button", { name: tr ? "Kural ekle" : "Add rule", exact: true }).click();
    await page.getByRole("button", { name: tr ? "Kuralı kaydet" : "Save rule" }).click();
    await expect(page.getByText(tr ? "Bir ad girin." : "Enter a name.")).toBeVisible();
    await page.getByRole("textbox", { name: tr ? "Ad" : "Name", exact: true }).fill("Staging host");
    await page.getByRole("textbox", { name: tr ? /Komut deseni/ : /Command pattern/ }).fill("(unclosed");
    await expect(page.getByText(tr ? /geçerli bir düzenli ifade gibi görünmüyor/ : /look like a valid regular expression/)).toBeVisible();
    await page.screenshot({ path: `test-results/screens/settings-watch-editor-${theme}-${lang}.png` });
    await page.getByRole("button", { name: tr ? "Kuralı kaydet" : "Save rule" }).click();
    await expect(page.getByRole("button", { name: tr ? "Staging host kuralını düzenle" : "Edit Staging host" })).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
