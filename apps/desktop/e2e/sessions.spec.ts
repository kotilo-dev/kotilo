import { expect, test } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// D-067: Sessions page – hub session metadata (invented demo data), search, grouping, resume.
for (const theme of ["dark", "light"] as const) {
  for (const lang of ["en", "tr"] as const) {
    test(`sessions page · ${theme} · ${lang}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`/?theme=${theme}&lang=${lang}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.waitForTimeout(800);
      await page.locator('[data-route="sessions"]').click();
      await expect(page.getByTestId("session-row")).toHaveCount(4);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/screens/sessions-${theme}-${lang}.png` });
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
}

test("sessions page · search, group, copy menu, resume in a new terminal", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?theme=dark&lang=en");
  await page.waitForTimeout(800);
  await page.locator('[data-route="sessions"]').click();
  await expect(page.getByTestId("session-row")).toHaveCount(4);

  // Search matches agent names and models; "This workspace" keeps orders-service only.
  await page.getByRole("searchbox", { name: /Search project/ }).fill("codex");
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await page.getByRole("searchbox", { name: /Search project/ }).fill("");
  await page.getByRole("radio", { name: "This workspace" }).click();
  await expect(page.getByTestId("session-row")).toHaveCount(2);
  await page.getByRole("radio", { name: "All" }).click();
  await page.getByRole("radio", { name: "Agent" }).click();
  await expect(page.getByRole("region", { name: "Claude Code" }).getByTestId("session-row")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Codex CLI" }).getByTestId("session-row")).toHaveCount(1);

  // The running session can be jumped to only when its pane is open; the ended one resumes.
  const ended = page.locator('[data-session-id="6f1c2d3e-5b7a-4c1e-9d2f-0a1b2c3d4e5f"]');
  await expect(ended.getByRole("button", { name: "Resume" })).toHaveAttribute("title", /claude --resume 6f1c2d3e-5b7a-4c1e-9d2f-0a1b2c3d4e5f/);
  await ended.getByRole("button", { name: "Copy…" }).click();
  await expect(page.getByRole("button", { name: "Copy resume command" })).toBeEnabled();
  await page.keyboard.press("Escape");

  // Each agent resumes with its own arguments (OpenCode: --session).
  const opencode = page.locator('[data-session-id="ses_01JDEMO7Q2K8"]');
  await expect(opencode.getByRole("button", { name: "Resume" })).toHaveAttribute("title", /opencode --session ses_01JDEMO7Q2K8/);

  await ended.getByRole("button", { name: "Resume" }).click();
  await expect(page.locator('[data-route="workspace"]')).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("claude --resume 6f1c2d3e-5b7a-4c1e-9d2f-0a1b2c3d4e5f").first()).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/screens/sessions-resumed.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});
