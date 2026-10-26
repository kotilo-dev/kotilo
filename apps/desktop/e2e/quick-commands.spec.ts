import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// D-069: quick commands – added in Settings, run from the terminal header menu (command → the
// current shell) and the palette (prompt → the agent's composer). Invented demo text only.

async function emitEvent(page: Page, name: string, payload: unknown) {
  await page.evaluate(
    async ([n, p]) => {
      const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
      await emit(n as string, p);
    },
    [name, payload] as const,
  );
}

test("quick commands · add in settings, run a command, hand a prompt to the agent", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?theme=dark&lang=en&panes=none");
  await page.waitForTimeout(1000);
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: "New terminal" }).first().click();
  await page.waitForTimeout(500);

  // Empty menu: only "Manage…", which opens the settings section.
  await page.getByRole("button", { name: "Quick commands" }).click();
  await page.getByRole("button", { name: "Manage quick commands…" }).click();
  await expect(page.getByText(/Shell commands are typed into the current terminal/)).toBeVisible();

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Unit tests");
  await page.getByLabel("Command", { exact: true }).fill("npm test -- --run");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Type", { exact: true }).selectOption("prompt");
  await page.getByLabel("Available in").selectOption({ index: 1 });
  await page.getByLabel("Name", { exact: true }).fill("Review changes");
  await page.getByLabel("Prompt", { exact: true }).fill("Review the uncommitted changes and list risky spots.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const list = page.getByRole("list", { name: "Quick commands" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await page.screenshot({ path: "test-results/screens/quick-commands-settings.png" });

  // Header menu: the prompt is disabled while no agent runs; the command goes to the shell.
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: "Quick commands" }).click();
  await expect(page.getByRole("button", { name: "Review changes" })).toBeDisabled();
  await page.screenshot({ path: "test-results/screens/quick-commands-menu.png" });
  await page.getByRole("button", { name: "Unit tests" }).click();
  await expect.poll(() => page.evaluate(() => window.__e2ePtyWrites.at(-1))).toBe("npm test -- --run\r");

  // An agent starts in that terminal: the palette hands the prompt to its composer.
  const pane = await page.evaluate(async () => {
    const { useTerminalStore } = await import("/src/stores/terminalStore.ts");
    const { useWorkspaceStore } = await import("/src/stores/workspaceStore.ts");
    const workspaceId = useWorkspaceStore.getState().activeId!;
    return { workspaceId, paneId: useTerminalStore.getState().byWorkspace[workspaceId]!.tabs[0]!.paneId! };
  });
  await emitEvent(page, "agents:changed", [
    { id: "a1", paneId: pane.paneId, workspaceId: pane.workspaceId, kind: "claude", state: "idle", sinceMs: Date.now() - 60_000, source: "hook", sessionId: null },
  ]);
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("Review changes");
  await expect(page.getByRole("button", { name: "Prompt: Review changes" })).toBeVisible();
  await page.keyboard.press("Enter");
  const composer = page.getByRole("textbox", { name: /^Message / });
  await expect(composer).toHaveValue("Review the uncommitted changes and list risky spots.");
  await expect(composer).toBeFocused();
  await page.screenshot({ path: "test-results/screens/quick-commands-prompt.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});
