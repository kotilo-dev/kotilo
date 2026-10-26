import { expect, test } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// D-066: review notes on the diff tab's working-copy side, sent to the Claude pane's composer
// as one prompt. Invented demo data only (timelineFixtures).
for (const theme of ["dark", "light"] as const) {
  test(`review notes · add, resolve, send to the agent · ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/?theme=${theme}&lang=en&panes=pane-claude`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.waitForTimeout(1200);
    await page.keyboard.press("Alt+1");
    await page.getByRole("button", { name: "New terminal" }).first().click();
    await page.waitForTimeout(400);

    await page.getByRole("button", { name: "Show changes in src/approval/approval.ts" }).click();
    const modified = page.locator(".monaco-diff-editor .editor.modified");
    await expect(modified.locator(".view-line").nth(5)).toBeVisible();
    await expect(page.getByText("Hover a line and click +")).toBeVisible();

    // Mouse: the "+" in the glyph margin of the hovered line.
    await modified.locator(".view-line").nth(5).hover();
    await modified.locator(".review-add-glyph").click();
    const editor = page.getByTestId("review-note-editor");
    await expect(editor).toContainText(/Line \d+/);
    const line = (await editor.innerText()).match(/Line (\d+)/)![1];
    await editor.getByRole("textbox", { name: "Add review note" }).fill("Map Cancelled to Rejected here as well.");
    await editor.getByRole("textbox", { name: "Add review note" }).press("Enter");
    await expect(page.getByTestId("review-note")).toHaveCount(1);

    // Keyboard: C on the cursor line.
    await modified.locator(".view-line").nth(1).click();
    await page.keyboard.press("c");
    await page.getByTestId("review-note-editor").getByRole("textbox", { name: "Add review note" }).fill("Drop this blank line.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("review-note")).toHaveCount(2);

    // A resolved note stays visible but is not sent.
    await page.getByTestId("review-note").filter({ hasText: "Drop this blank line." }).getByRole("button", { name: "Resolve" }).click();
    await expect(page.locator("[data-testid=review-note][data-resolved=true]")).toHaveCount(1);
    await expect(page.getByTestId("timeline-changes").getByTitle("1 note")).toHaveText("1");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/review-notes-${theme}.png` });

    await page.getByRole("button", { name: "Send 1 note to…" }).click();
    await page.getByRole("button", { name: "Claude Code", exact: true }).click();
    const composer = page.getByRole("textbox", { name: "Message Claude Code" });
    await expect(composer).toBeFocused();
    const text = await composer.inputValue();
    expect(text).toContain("Please address these review notes on the current changes:");
    expect(text).toContain(`1. src/approval/approval.ts:${line}\n`);
    expect(text).toContain("Map Cancelled to Rejected here as well.");
    expect(text).not.toContain("Drop this blank line.");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/review-notes-sent-${theme}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
