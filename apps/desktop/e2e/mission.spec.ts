import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// Mission control (M4, DESIGN_SYSTEM §7.8) against the fake hub: two agent panes in the app
// (Claude working, Codex waiting for permission) with invented terminal output, plus the
// docs-site session that runs outside the app (metadata preview only).
const DEMO_OUTPUT: Record<string, string> = {
  "pane-claude": [
    "● Edit src/approval/approval.ts (+12 −3)",
    "    + case ProviderStatus.Cancelled: return Rejected;",
    "",
    "● Bash npm test -- approval",
    "    PASS approval.test.ts (14 tests)",
    "✻ Running the full suite…",
  ].join("\r\n"),
  "pane-codex": [
    "• Added migration 20261004_AddCancellationStatus",
    "• Migration is ready. Applying it needs a database write.",
    "",
    "  Allow command? dotnet ef database update --project Gateway",
    "  › 1. Yes  2. Always  3. No",
  ].join("\r\n"),
};

async function openWithPanes(page: Page, theme: string, lang: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?theme=${theme}&lang=${lang}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.waitForTimeout(1200);
  await page.keyboard.press("Alt+1");
  // Two terminals: `pty_spawn` hands out pane-claude, then pane-codex (setup.ts).
  const label = lang === "tr" ? "Yeni terminal" : "New terminal";
  await page.getByRole("button", { name: label }).first().click();
  await page.waitForTimeout(400);
  await page.getByTitle(label).first().click();
  await page.waitForTimeout(400);
  await page.evaluate(async (output) => {
    const registry = await import("/src/features/terminal/terminalRegistry.ts");
    for (const entry of registry.allEntries()) {
      const text = entry.paneId ? output[entry.paneId] : undefined;
      if (text) entry.term.write(`${text}\r\n`);
    }
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    const now = Date.now();
    await emit("agents:changed", [
      { id: "a1", paneId: "pane-claude", workspaceId: "ws-demo", kind: "claude", state: "working", sinceMs: now - 120_000, source: "hook", sessionId: "demo-claude-1" },
      { id: "a2", paneId: "pane-codex", workspaceId: "ws-demo", kind: "codex", state: "blocked", sinceMs: now - 72_000, source: "hook", sessionId: "demo-codex-1" },
    ]);
  }, DEMO_OUTPUT);
  await page.evaluate(() => window.__e2e.pushHubSnapshot());
  await page.waitForTimeout(300);
  return errors;
}

for (const { theme, lang } of [
  { theme: "dark", lang: "en" },
  { theme: "light", lang: "en" },
  { theme: "dark", lang: "tr" },
] as const) {
  test(`mission control · ${theme} · ${lang}`, async ({ page }) => {
    const errors = await openWithPanes(page, theme, lang);
    await page.getByRole("button", { name: lang === "tr" ? "Görev kontrol" : "Mission control" }).click();
    await expect(page.getByRole("heading", { name: lang === "tr" ? "Görev kontrol" : "Mission control" })).toBeVisible();
    // The preview is read about once a second.
    await expect(page.getByText("✻ Running the full suite…")).toBeVisible({ timeout: 4000 });
    await expect(page.getByText("› 1. Yes  2. Always  3. No")).toBeVisible();
    await page.screenshot({ path: `test-results/screens/mission-${theme}-${lang}.png` });

    if (lang === "en") {
      await page.getByRole("radio", { name: /^Needs you/ }).click();
      await page.waitForTimeout(300);
      await expect(page.getByText("✻ Running the full suite…")).toHaveCount(0);
      await page.screenshot({ path: `test-results/screens/mission-needs-you-${theme}.png` });

      // Tile click goes to the workspace and its pane.
      await page.getByRole("radio", { name: "All" }).click();
      await page.getByRole("button", { name: /^orders-service · / }).click();
      await page.waitForTimeout(400);
      await expect(page.getByRole("heading", { name: "Mission control" })).toHaveCount(0);
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
