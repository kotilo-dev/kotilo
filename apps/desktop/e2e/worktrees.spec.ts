import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// 0.6 worktrees for parallel agents against the mocked `worktree_*` commands
// (src/e2e/worktreeFixtures.ts, invented demo data): Mission control panel, create + start an
// agent with its badge, compare against the merge-base, merge (conflict and success), remove.
const BASE = "4f7d2a91c3e85b06d1a9f2c47e3b8d5a6c0f1e29";

async function open(page: Page, theme: string, extra = ""): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?theme=${theme}&lang=en&worktrees=demo&panes=pane-wt1,pane-wt2${extra}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__e2e.pushHubSnapshot());
  return errors;
}

async function toMission(page: Page) {
  await page.getByRole("button", { name: "Mission control" }).click();
  await expect(page.getByTestId("worktrees-panel")).toBeVisible();
}

const row = (page: Page, name: string) => page.locator(`[data-worktree="${name}"]`);

for (const theme of ["dark", "light"] as const) {
  test(`worktrees · panel, new agent in a worktree with badges · ${theme}`, async ({ page }) => {
    const errors = await open(page, theme);
    await toMission(page);
    await expect(page.getByTestId("worktree-row")).toHaveCount(3);
    await expect(row(page, "fix-login")).toContainText("kotilo/fix-login");
    await expect(row(page, "fix-login")).toContainText("2 uncommitted");
    await expect(row(page, "fix-login")).toContainText("3 ahead · 1 behind");
    // Unmanaged worktrees: compare and terminal only.
    await expect(row(page, "spike")).toContainText("compare and terminal only");
    await expect(row(page, "spike").getByRole("button", { name: "Merge" })).toHaveCount(0);
    await expect(row(page, "spike").getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(row(page, "fix-login").getByRole("button", { name: "Merge" })).toBeVisible();
    await page.getByTestId("worktrees-panel").scrollIntoViewIfNeeded();
    await page.getByTestId("worktrees-panel").screenshot({ path: `test-results/screens/worktrees-panel-${theme}.png` });

    await page.getByRole("button", { name: "New agent in worktree…" }).click();
    const dialog = page.getByRole("dialog", { name: "New agent in worktree" });
    await dialog.getByLabel("Name").fill("Payment retry");
    await expect(dialog).toContainText("Folder .kotilo/worktrees/payment-retry · branch kotilo/payment-retry");
    await dialog.getByLabel("Agent").selectOption({ label: "Claude Code" });
    await page.waitForTimeout(400); // the dialog's rise animation
    await page.screenshot({ path: `test-results/screens/worktrees-create-${theme}.png` });
    await dialog.getByRole("button", { name: "Create and start" }).click();
    await expect(dialog).toHaveCount(0);

    // The tab runs the agent in the new worktree and carries its branch badge.
    expect(await page.evaluate(() => window.__e2eWorktree.created)).toEqual(["payment-retry"]);
    await expect.poll(() => page.evaluate(() => window.__e2eWorktree.spawns.at(-1))).toEqual({ cwdRel: ".kotilo/worktrees/payment-retry", agentCommand: "claude" });
    const tab = page.locator("[data-tab-id]").first();
    await expect(tab.getByTestId("worktree-badge")).toHaveText("kotilo/payment-retry");

    // The agent header strip shows it too once the agent reports a state.
    await page.evaluate(async () => {
      const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
      await emit("agents:changed", [
        { id: "a1", paneId: "pane-wt1", workspaceId: "ws-demo", kind: "claude", adapterId: "claude-code", state: "working", sinceMs: Date.now() - 30_000, source: "hook", sessionId: null },
      ]);
    });
    await expect(page.getByRole("group", { name: /in orders-service/ }).getByTestId("worktree-badge")).toHaveText("kotilo/payment-retry");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/worktrees-badge-${theme}.png` });

    // Back in Mission control, the row lists the running agent.
    await toMission(page);
    await expect(row(page, "payment-retry")).toContainText("Working");
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test(`worktrees · compare against the merge-base, merge conflict, merge and clean up · ${theme}`, async ({ page }) => {
    const errors = await open(page, theme);
    await toMission(page);

    await row(page, "fix-login").getByRole("button", { name: "Compare" }).click();
    const compare = page.getByRole("dialog", { name: "Changes in kotilo/fix-login" });
    await expect(compare.getByTestId("worktree-changes").locator("li")).toHaveCount(3);
    await page.waitForTimeout(400); // the dialog's rise animation
    await page.screenshot({ path: `test-results/screens/worktrees-compare-list-${theme}.png` });
    await compare.getByRole("button", { name: "Open diff of src/auth/login.ts" }).click();
    const diff = page.getByTestId("diff-view");
    await expect(diff).toContainText(".kotilo/worktrees/fix-login/src/auth/login.ts");
    await expect(diff).toContainText("4f7d2a91 ↔ working copy");
    await expect(page.locator(".monaco-diff-editor .editor.modified")).toContainText("refreshIfExpired");
    expect(await page.evaluate(() => window.__e2eWorktree.showHead.at(-1))).toEqual({ path: ".kotilo/worktrees/fix-login/src/auth/login.ts", rev: BASE });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/screens/worktrees-compare-diff-${theme}.png` });

    // Squash merge of fix-login conflicts: aborted, files listed.
    await toMission(page);
    await row(page, "fix-login").getByRole("button", { name: "Merge" }).click();
    const merge = page.getByRole("dialog", { name: "Merge kotilo/fix-login into main" });
    await merge.getByRole("radio", { name: "Squash" }).click();
    await expect(merge.getByLabel("Commit message")).toHaveValue("Squash kotilo/fix-login");
    await merge.getByRole("button", { name: "Merge", exact: true }).click();
    await expect(merge.getByTestId("worktree-result")).toContainText("conflicts and was undone");
    await expect(merge.getByTestId("merge-conflicts")).toContainText("src/auth/session.ts");
    expect(await page.evaluate(() => window.__e2eWorktree.merges)).toEqual([{ name: "fix-login", squash: true, message: "Squash kotilo/fix-login" }]);
    await page.waitForTimeout(400); // the dialog's rise animation
    await page.screenshot({ path: `test-results/screens/worktrees-merge-conflict-${theme}.png` });
    await merge.getByRole("button", { name: "Cancel" }).click();

    // api-docs merges; cleanup is offered and deletes the merged branch by default.
    await row(page, "api-docs").getByRole("button", { name: "Merge" }).click();
    const merge2 = page.getByRole("dialog", { name: "Merge kotilo/api-docs into main" });
    await merge2.getByRole("button", { name: "Merge", exact: true }).click();
    await expect(merge2.getByTestId("worktree-result")).toContainText("Merged kotilo/api-docs into main.");
    await expect(merge2).toContainText("Remove the worktree and its branch now?");
    await merge2.getByRole("button", { name: "Remove worktree…" }).click();
    const remove = page.getByRole("dialog", { name: "Remove worktree api-docs" });
    await expect(remove.getByRole("checkbox", { name: "Also delete branch kotilo/api-docs" })).toBeChecked();
    await remove.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(remove).toHaveCount(0);
    expect(await page.evaluate(() => window.__e2eWorktree.removes)).toEqual([{ name: "api-docs", force: false, deleteBranch: true, forceBranch: false }]);
    await expect(row(page, "api-docs")).toHaveCount(0);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test(`worktrees · remove a dirty worktree closes its terminal after confirmation · ${theme}`, async ({ page }) => {
    const errors = await open(page, theme);
    await toMission(page);
    await row(page, "fix-login").getByRole("button", { name: "Open terminal" }).click();
    await expect(page.locator("[data-tab-id]")).toHaveCount(1);
    await expect(page.locator("[data-tab-id]").getByTestId("worktree-badge")).toHaveText("kotilo/fix-login");

    await toMission(page);
    await row(page, "fix-login").getByRole("button", { name: "Remove" }).click();
    const remove = page.getByRole("dialog", { name: "Remove worktree fix-login" });
    await expect(remove).toContainText("1 terminal in this worktree will be closed first.");
    await expect(remove.getByTestId("remove-confirm-dirty")).toContainText("2 uncommitted changes");
    // Not merged: the branch is kept by default, so no branch confirmation.
    await expect(remove.getByRole("checkbox", { name: "Also delete branch kotilo/fix-login" })).not.toBeChecked();
    await expect(remove.getByRole("button", { name: "Remove", exact: true })).toBeDisabled();
    await page.waitForTimeout(400); // the dialog's rise animation
    await page.screenshot({ path: `test-results/screens/worktrees-remove-${theme}.png` });

    // Deleting the unmerged branch needs its own tick.
    await remove.getByRole("checkbox", { name: "Also delete branch kotilo/fix-login" }).check();
    await expect(remove.getByTestId("remove-confirm-unmerged")).toBeVisible();
    await remove.getByRole("checkbox", { name: "Also delete branch kotilo/fix-login" }).uncheck();

    await remove.getByRole("checkbox", { name: "Remove anyway" }).check();
    await remove.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(remove).toHaveCount(0, { timeout: 5000 });
    expect(await page.evaluate(() => window.__e2eWorktree.removes)).toEqual([{ name: "fix-login", force: true, deleteBranch: false, forceBranch: false }]);
    await expect(row(page, "fix-login")).toHaveCount(0);
    await page.getByRole("button", { name: "Workspace" }).first().click();
    await expect(page.locator("[data-tab-id]")).toHaveCount(0);
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("worktrees · unsupported workspace shows a hint", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?theme=dark&lang=tr&worktrees=unsupported");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Görev kontrol" }).click();
  await expect(page.getByTestId("worktrees-unsupported")).toHaveText("Worktree için çalışma alanı deponun en üst klasörü olmalı.");
  await expect(page.getByRole("button", { name: "Worktree'de yeni ajan…" })).toBeDisabled();
  await page.getByTestId("worktrees-panel").screenshot({ path: "test-results/screens/worktrees-unsupported-dark-tr.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});

test("worktrees · branch prefix setting in Settings → Terminal", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?theme=dark&lang=en");
  await page.waitForTimeout(1200);
  await page.getByRole("navigation").first().getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Terminal", exact: true }).click();
  const field = page.getByLabel("Worktree branch prefix");
  await expect(field).toHaveValue("kotilo/");
  await field.fill("agents/");
  await field.blur();
  await page.waitForTimeout(600);
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Terminal", exact: true }).click();
  await field.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/screens/worktrees-setting-dark.png" });
  // The create dialog previews the new prefix.
  await page.evaluate(async () => {
    const { openCreateWorktreeDialog } = await import("/src/features/worktrees/worktreeActions.ts");
    openCreateWorktreeDialog("ws-demo");
  });
  await page.getByRole("dialog", { name: "New agent in worktree" }).getByLabel("Name").fill("x");
  await expect(page.getByRole("dialog", { name: "New agent in worktree" })).toContainText("branch agents/x");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("worktrees · panel in Turkish", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?theme=light&lang=tr&worktrees=demo");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Görev kontrol" }).click();
  await expect(page.locator('[data-worktree="fix-login"]')).toContainText("2 commit edilmemiş");
  await page.getByTestId("worktrees-panel").screenshot({ path: "test-results/screens/worktrees-panel-light-tr.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});
