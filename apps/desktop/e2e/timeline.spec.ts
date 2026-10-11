import { expect, test, type Page } from "@playwright/test";

// M4 timeline rail against the fake hub (src/e2e/timelineFixtures.ts): plan, activity, changed
// files, a live `activity` delta, the HEAD ↔ working copy diff tab and the collapsed rail.
const VARIANTS = [
  { theme: "dark", lang: "en" },
  { theme: "light", lang: "en" },
  { theme: "dark", lang: "tr" },
] as const;

async function openWorkspace(page: Page, theme: string, lang: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?theme=${theme}&lang=${lang}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.waitForTimeout(1200);
  await page.keyboard.press("Alt+1");
  // One terminal: pane `pane-claude`, the working Claude session of the fixtures.
  await page.getByRole("button", { name: lang === "tr" ? "Yeni terminal" : "New terminal" }).first().click();
  await page.waitForTimeout(400);
  await page.evaluate(async () => {
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("agents:changed", [
      { id: "a1", paneId: "pane-claude", workspaceId: "ws-demo", kind: "claude", state: "working", sinceMs: Date.now() - 120_000, source: "hook", sessionId: "demo-claude-1" },
    ]);
  });
  await page.evaluate(() => window.__e2e.pushHubSnapshot());
  await page.waitForTimeout(500);
  return errors;
}

for (const { theme, lang } of VARIANTS) {
  test(`timeline rail · ${theme} · ${lang}`, async ({ page }) => {
    const errors = await openWorkspace(page, theme, lang);
    const rail = page.getByTestId("timeline-rail");
    await expect(rail).toBeVisible();
    await expect(rail.getByText("Run the full approval suite")).toBeVisible();
    const activity = rail.getByTestId("timeline-activity").locator("li");
    await expect(activity).toHaveCount(8);
    await expect(activity.first()).toHaveAttribute("data-status", "running");

    // Files the agent edited/wrote come first, the rest under "Other changes".
    const files = rail.getByTestId("timeline-changes").locator("button[data-touched]");
    await expect(files).toHaveCount(5);
    await expect(files.nth(0)).toHaveAttribute("data-touched", "true");
    await expect(files.nth(1)).toHaveAttribute("data-touched", "true");
    await expect(files.nth(2)).toHaveAttribute("data-touched", "false");
    await page.screenshot({ path: `test-results/screens/timeline-${theme}-${lang}.png` });

    // Live delta: the running test run fails, a new edit starts.
    await page.evaluate(() =>
      window.__e2e.emit("activity", {
        agent: "claude-code",
        sessionId: "demo-claude-1",
        entries: [
          { id: 108, kind: "bash", tool: "Bash", target: "npm test -- approval", startedAt: new Date(Date.now() - 24_000).toISOString(), durationMs: 21_000, status: "ok" },
          { id: 109, kind: "edit", tool: "Edit", target: "CHANGELOG.md", startedAt: new Date().toISOString(), status: "running" },
        ],
        plan: {
          items: [
            { text: "Reproduce the failing approval test", status: "completed" },
            { text: "Map provider CANCELLED to Rejected", status: "completed" },
            { text: "Add regression test for cancelled orders", status: "completed" },
            { text: "Run the full approval suite", status: "completed" },
            { text: "Update CHANGELOG", status: "in_progress" },
          ],
        },
      }),
    );
    await expect(activity).toHaveCount(9);
    await expect(activity.first()).toContainText("CHANGELOG.md");
    await expect(activity.nth(1)).toHaveAttribute("data-status", "ok");
    await expect(rail.getByText("4 / 5")).toBeVisible();

    // Diff tab: HEAD ↔ working copy, read-only Monaco.
    await files.nth(0).click();
    const diff = page.getByTestId("diff-view");
    await expect(diff).toBeVisible();
    await expect(diff.locator(".monaco-diff-editor")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `test-results/screens/timeline-diff-${theme}-${lang}.png` });

    if (theme === "dark" && lang === "en") {
      await rail.getByRole("button", { name: "Hide timeline" }).click();
      await expect(rail).toHaveCount(0);
      await page.screenshot({ path: `test-results/screens/timeline-collapsed-${theme}-${lang}.png` });
      await page.getByRole("button", { name: "Show timeline" }).click();
      await expect(page.getByTestId("timeline-rail")).toBeVisible();
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
