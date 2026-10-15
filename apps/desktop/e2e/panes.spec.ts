import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// 0.3.2 pane findings against the mocked IPC: the permission card reads Claude's dialog from
// the screen, the leftover-process strip, the background-work label, the timeline rail split
// and the agents list status icons. Invented demo data only.
const YES_NO = [
  "● I'll clean the build output first.",
  "",
  "────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   Remove-Item -Recurse dist",
  "   Remove the old build output",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel",
];

const THREE_OPTIONS = [
  "● Running the approval tests.",
  "",
  "────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   npm test -- approval",
  "   Run the approval tests",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for npm test commands in",
  "      C:\\src\\orders-service",
  "   3. No, and tell Claude what to do differently (esc)",
];

async function openClaudePane(page: Page, theme: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?theme=${theme}&lang=en&panes=pane-claude`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.waitForTimeout(1200);
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: "New terminal" }).first().click();
  await page.waitForTimeout(400);
  return errors;
}

/** Writes `screen` into the Claude pane, then reports the session waiting for permission. */
async function claudeAsks(page: Page, screen: string[], command: string): Promise<void> {
  // After setup.ts's last fixture snapshot (3 s after load), which would reset the session.
  await page.waitForTimeout(1600);
  await page.evaluate(
    async ({ screen, command }) => {
      const registry = await import("/src/features/terminal/terminalRegistry.ts");
      for (const entry of registry.allEntries()) if (entry.paneId === "pane-claude") entry.term.write(`${screen.join("\r\n")}\r\n`);
      const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
      const fx = await import("/src/e2e/fixtures.ts");
      const since = new Date(Date.now() - 9_000).toISOString();
      const sessions = fx.sessions.map((s) =>
        s.sessionId === "demo-claude-1"
          ? { ...s, state: "WaitingPermission", stateSince: since, pendingPermission: { tool: "Bash", command, path: null, risk: null, since } }
          : s,
      );
      await emit("agents:changed", [
        { id: "a1", paneId: "pane-claude", workspaceId: "ws-demo", kind: "claude", adapterId: "claude-code", state: "blocked", sinceMs: Date.now() - 9_000, source: "hook", sessionId: "demo-claude-1" },
      ]);
      await emit("hub:status", { connected: true });
      await emit("hub:event", { type: "sessions", data: sessions });
    },
    { screen, command },
  );
}

for (const theme of ["dark", "light"] as const) {
  test(`permission card reads Claude's Yes/No dialog · ${theme}`, async ({ page }) => {
    const errors = await openClaudePane(page, theme);
    await claudeAsks(page, YES_NO, "Remove-Item -Recurse dist");
    const card = page.getByRole("region", { name: "Permission request" });
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: /^Allow once/ })).toBeVisible();
    await expect(card.getByRole("button", { name: /^Deny/ })).toBeVisible();
    // Option 2 is "No" here: no "always" button (it would have sent 2 = No).
    await page.waitForTimeout(1800);
    await expect(card.getByRole("button")).toHaveCount(3);
    await page.screenshot({ path: `test-results/screens/permission-claude-yes-no-${theme}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test(`permission card offers Claude's always option · ${theme}`, async ({ page }) => {
    const errors = await openClaudePane(page, theme);
    await claudeAsks(page, THREE_OPTIONS, "npm test -- approval");
    const card = page.getByRole("region", { name: "Permission request" });
    const always = card.getByRole("button", { name: /^Don't ask again for npm test/ });
    await expect(always).toBeVisible();
    await expect(always).toHaveAttribute("title", "Yes, and don't ask again for npm test commands in C:\\src\\orders-service");
    await page.waitForTimeout(500); // the rise animation
    await page.screenshot({ path: `test-results/screens/permission-claude-always-${theme}.png` });
    await always.click();
    await expect(page.getByRole("status").filter({ hasText: "Always allowed" })).toContainText("“2”");
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test(`leftover processes strip · ${theme}`, async ({ page }) => {
    const errors = await openClaudePane(page, theme);
    await page.evaluate(async () => {
      const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
      await emit("pty:leftover", { paneId: "pane-claude", processes: ["python.exe", "node.exe"] });
    });
    const strip = page.getByRole("status").filter({ hasText: "Agent exited" });
    await expect(strip).toContainText("2 processes still running: python.exe, node.exe");
    await page.screenshot({ path: `test-results/screens/leftover-strip-${theme}.png` });
    await strip.getByRole("button", { name: "Stop" }).click();
    await expect(strip).toHaveCount(0);
    expect(await page.evaluate(() => window.__e2eLeftoverStops)).toEqual(["pane-claude"]);
    // Dismiss hides it without stopping anything.
    await page.evaluate(async () => {
      const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
      await emit("pty:leftover", { paneId: "pane-claude", processes: ["python.exe"] });
    });
    await expect(page.getByText("1 process still running: python.exe")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByText("still running")).toHaveCount(0);
    expect(await page.evaluate(() => window.__e2eLeftoverStops)).toEqual(["pane-claude"]);
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("background work label in the header strip", async ({ page }) => {
  const errors = await openClaudePane(page, "dark");
  await page.evaluate(async () => {
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    const fx = await import("/src/e2e/fixtures.ts");
    const sessions = fx.sessions.map((s) => (s.sessionId === "demo-claude-1" ? { ...s, backgroundTasks: ["backend-expert"] } : s));
    await emit("agents:changed", [
      { id: "a1", paneId: "pane-claude", workspaceId: "ws-demo", kind: "claude", adapterId: "claude-code", state: "working", sinceMs: Date.now() - 60_000, source: "hook", sessionId: "demo-claude-1", backgroundTasks: ["backend-expert"] },
    ]);
    await emit("hub:status", { connected: true });
    await emit("hub:event", { type: "sessions", data: sessions });
  });
  await expect(page.getByRole("group").getByText("Background: backend-expert")).toBeVisible();
  await expect(page.getByRole("img", { name: "Working · Background: backend-expert" })).toBeVisible();
  await page.screenshot({ path: "test-results/screens/background-label-dark.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});

test("timeline rail keeps changed files in their own pane", async ({ page }) => {
  const errors = await openClaudePane(page, "dark");
  await page.evaluate(async () => {
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("agents:changed", [
      { id: "a1", paneId: "pane-claude", workspaceId: "ws-demo", kind: "claude", adapterId: "claude-code", state: "working", sinceMs: Date.now() - 60_000, source: "hook", sessionId: "demo-claude-1" },
    ]);
    await window.__e2e.pushHubSnapshot();
  });
  const rail = page.getByTestId("timeline-rail");
  await expect(rail.getByTestId("timeline-activity").locator("li")).toHaveCount(8);
  await page.evaluate(() => {
    const now = Date.now();
    const entries = Array.from({ length: 40 }, (_, i) => ({
      id: 200 + i,
      kind: i % 3 === 0 ? "bash" : "read",
      tool: i % 3 === 0 ? "Bash" : "Read",
      target: i % 3 === 0 ? `npm test -- part-${i}` : `src/module-${i}/index.ts`,
      startedAt: new Date(now - (40 - i) * 20_000).toISOString(),
      durationMs: 120 + i,
      status: "ok",
    }));
    return window.__e2e.emit("activity", { agent: "claude-code", sessionId: "demo-claude-1", entries, plan: null });
  });
  await expect(rail.getByTestId("timeline-activity").locator("li")).toHaveCount(48);
  // Both panes on screen: the changed files show without scrolling the activity.
  await expect(rail.getByTestId("timeline-changes")).toBeInViewport();
  const activityPane = rail.getByTestId("timeline-activity-pane");
  expect(await activityPane.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.screenshot({ path: "test-results/screens/timeline-split-dark.png" });
  expect(errors, errors.join("\n")).toEqual([]);
});

for (const theme of ["dark", "light"] as const) {
  test(`agents list status icons · ${theme}`, async ({ page }) => {
    const errors = await openClaudePane(page, theme);
    await page.evaluate(async () => {
      const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
      const now = Date.now();
      await emit("agents:changed", [
        { id: "a1", paneId: "pane-claude", workspaceId: "ws-demo", kind: "claude", adapterId: "claude-code", state: "working", sinceMs: now - 120_000, source: "hook", sessionId: null },
        { id: "a2", paneId: "pane-x2", workspaceId: "ws-demo", kind: "codex", adapterId: "codex", state: "blocked", sinceMs: now - 72_000, source: "hook", sessionId: null },
        { id: "a3", paneId: "pane-x3", workspaceId: "ws-demo", kind: "claude", adapterId: "claude-code", state: "done", sinceMs: now - 30_000, source: "hook", sessionId: null },
        { id: "a4", paneId: "pane-x4", workspaceId: "ws-demo", kind: "other", adapterId: null, state: "idle", sinceMs: now - 600_000, source: "heuristic", sessionId: null },
      ]);
    });
    for (const name of ["Working", "Needs permission", "Done", "Idle"]) {
      await expect(page.getByRole("img", { name, exact: true }).first()).toBeVisible();
    }
    await page.screenshot({ path: `test-results/screens/agents-list-icons-${theme}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
