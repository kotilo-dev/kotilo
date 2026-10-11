import { expect, test, type Page } from "@playwright/test";

// M4 composer (§7.6) and split pane (§7.3) against the mocked IPC: `@` suggestions, an image
// chip, composer dictation (the `dictation:composer` event Rust sends), saved prompts, send
// into the PTY, and two panes side by side via drag and the tab menu.

async function emitEvent(page: Page, name: string, payload: unknown) {
  await page.evaluate(
    async ([n, p]) => {
      const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
      await emit(n as string, p);
    },
    [name, payload] as const,
  );
}

/** Workspace with the Claude (working) and Codex (waiting for permission) fixture panes. */
async function openAgents(page: Page, theme: "dark" | "light"): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?theme=${theme}&lang=en`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.waitForTimeout(1200);
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: "New terminal" }).first().click();
  await page.waitForTimeout(400);
  await page.getByTitle("New terminal").first().click();
  await page.waitForTimeout(400);
  const now = Date.now();
  await emitEvent(page, "agents:changed", [
    { id: "a1", paneId: "pane-claude", workspaceId: "ws-demo", kind: "claude", state: "working", sinceMs: now - 120_000, source: "hook", sessionId: "demo-claude-1" },
    { id: "a2", paneId: "pane-codex", workspaceId: "ws-demo", kind: "codex", state: "blocked", sinceMs: now - 72_000, source: "hook", sessionId: "demo-codex-1" },
  ]);
  await page.evaluate(() => window.__e2e.pushHubSnapshot());
  await page.waitForTimeout(600);
  return errors;
}

test("composer · mentions, image chip, dictation, saved prompts, send", async ({ page }) => {
  const errors = await openAgents(page, "dark");
  await page.locator("[data-tab-id]").first().click();
  const input = page.getByRole("textbox", { name: "Message Claude Code" });
  await expect(input).toBeVisible();

  // `@` file suggestions from fs_quick_open.
  await input.click();
  await input.pressSequentially("fix the failing @appr");
  await expect(page.getByRole("option", { name: "src/approval/approval.ts" })).toBeVisible();
  await page.screenshot({ path: "test-results/screens/composer-mentions-dark.png" });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("fix the failing @src/approval/approval.test.ts ");

  // An image paste becomes a chip (+ the one-time .gitignore hint).
  await input.evaluate((el) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByText("@screenshot-20261008-101500.png")).toBeVisible();
  await expect(page.getByText(/Add \.kotilo\/ to your \.gitignore/)).toBeVisible();

  // Composer dictation: the mic records, the text comes back as `dictation:composer`.
  await page.getByRole("button", { name: "Dictate into the message" }).click();
  await expect(page.getByRole("button", { name: "Stop dictation" })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "test-results/screens/composer-dark.png" });
  await page.getByRole("button", { name: "Stop dictation" }).click();
  await emitEvent(page, "dictation:composer", { paneId: "pane-codex", text: "not for this pane", cleaned: false });
  await emitEvent(page, "dictation:composer", { paneId: "pane-claude", text: "and keep the status mapping", cleaned: true });
  await expect(input).toHaveValue("fix the failing @src/approval/approval.test.ts and keep the status mapping");
  await page.getByRole("button", { name: "Got it" }).click();

  // Saved prompts: save two, show the list.
  await page.getByRole("button", { name: "Saved prompts" }).click();
  await page.getByRole("button", { name: "Save message as prompt" }).click();
  await input.fill("Review the diff and list risky changes before committing.");
  await page.getByRole("button", { name: "Save message as prompt" }).click();
  await expect(page.getByRole("dialog", { name: "Saved prompts" }).getByRole("button", { name: /^Review the diff/ })).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/screens/composer-saved-prompts-dark.png" });
  await page.keyboard.press("Escape");

  // Send: the text goes into the PTY, then Enter.
  await page.evaluate(() => window.__e2ePtyWrites.splice(0));
  await input.fill("run the approval tests");
  await page.getByRole("button", { name: "Send (Enter)" }).click();
  await expect(input).toHaveValue("");
  await expect.poll(() => page.evaluate(() => window.__e2ePtyWrites.slice(-2))).toEqual([
    expect.stringContaining("run the approval tests @.kotilo/attachments/screenshot-20261008-101500.png"),
    "\r",
  ]);
  expect(errors, errors.join("\n")).toEqual([]);
});

for (const theme of ["dark", "light"] as const) {
  test(`split pane · ${theme}`, async ({ page }) => {
    const errors = await openAgents(page, theme);
    const tabs = page.locator("[data-tab-id]");

    // Drag the Codex tab onto the right half.
    const source = await tabs.nth(1).boundingBox();
    await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
    await page.mouse.down();
    await page.mouse.move(source!.x + source!.width / 2 + 30, source!.y + 40, { steps: 5 });
    const zone = page.getByTestId("split-drop-zone");
    await expect(zone).toBeVisible();
    const box = await zone.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 5 });
    await page.mouse.up();

    await expect(page.locator('[data-split-side="left"]')).toBeVisible();
    await expect(page.locator('[data-split-side="right"]')).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Claude Code" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Codex CLI" })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/screens/split-pane-${theme}.png` });

    // The header split button of a half closes the split; the other half stays.
    await page.locator('[data-split-side="right"]').getByRole("button", { name: "Close split" }).click();
    await expect(page.locator('[data-split-side="right"]')).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message Claude Code" })).toBeVisible();

    // "Split right" from the tab menu; the half's × returns to a single pane (tabs stay).
    await tabs.nth(1).click({ button: "right" });
    await page.getByRole("button", { name: "Split right" }).last().click();
    await expect(page.locator('[data-split-side="right"]')).toBeVisible();
    await page.getByRole("button", { name: /^Close the split/ }).first().click();
    await expect(page.locator('[data-split-side="left"], [data-split-side="right"]')).toHaveCount(0);
    await expect(tabs).toHaveCount(2);
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
