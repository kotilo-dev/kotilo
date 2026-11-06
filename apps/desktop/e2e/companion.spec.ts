import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// D-072 Kotilo Deck companion against the mocked IPC (`?deck=connected`): the webview's agents
// snapshot, a deck approval going through the permission card's path, the pomodoro chip and the
// settings status. Invented demo data only.
const YES_NO = [
  "────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   npm run build",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel",
];

interface DeckSnapshot {
  agents: { id: string; status: string; task?: string }[];
  approvals: { id: string; agentId: string; summary: string; detail?: string }[];
}

async function openClaudePane(page: Page, theme: string, lang = "en"): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?theme=${theme}&lang=${lang}&panes=pane-claude&deck=connected`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.waitForTimeout(1200);
  await page.keyboard.press("Alt+1");
  await page.getByRole("button", { name: lang === "tr" ? "Yeni terminal" : "New terminal" }).first().click();
  await page.waitForTimeout(400);
  return errors;
}

async function claudeAsks(page: Page): Promise<void> {
  // After setup.ts's last fixture snapshot (3 s after load), which would reset the session.
  await page.waitForTimeout(1600);
  await page.evaluate(async (screen) => {
    const registry = await import("/src/features/terminal/terminalRegistry.ts");
    for (const entry of registry.allEntries()) if (entry.paneId === "pane-claude") entry.term.write(`${screen.join("\r\n")}\r\n`);
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    const fx = await import("/src/e2e/fixtures.ts");
    const since = new Date(Date.now() - 9_000).toISOString();
    const sessions = fx.sessions.map((s) =>
      s.sessionId === "demo-claude-1"
        ? { ...s, state: "WaitingPermission", stateSince: since, pendingPermission: { tool: "Bash", command: "npm run build", path: null, risk: null, since } }
        : s,
    );
    await emit("agents:changed", [
      { id: "a1", paneId: "pane-claude", workspaceId: "ws-demo", kind: "claude", adapterId: "claude-code", state: "blocked", sinceMs: Date.now() - 9_000, source: "hook", sessionId: "demo-claude-1" },
    ]);
    await emit("hub:status", { connected: true });
    await emit("hub:event", { type: "sessions", data: sessions });
  }, YES_NO);
}

const lastSnapshot = (page: Page) => page.evaluate(() => (window.__e2eCompanion.agents.at(-1) ?? null) as unknown as DeckSnapshot | null);

for (const theme of ["dark", "light"] as const) {
  test(`deck approval goes through the card's path, pomodoro chip · ${theme}`, async ({ page }) => {
    const errors = await openClaudePane(page, theme);
    await claudeAsks(page);
    const card = page.getByRole("region", { name: "Permission request" });
    await expect(card).toBeVisible();

    // The snapshot carries the pane agent as waiting and the answerable approval.
    await expect.poll(async () => (await lastSnapshot(page))?.approvals.length ?? 0).toBe(1);
    const snapshot = (await lastSnapshot(page))!;
    const approval = snapshot.approvals[0]!;
    expect(approval).toMatchObject({ agentId: "pane:pane-claude", summary: "Bash", detail: "npm run build" });
    expect(approval.id).toMatch(/^claude-code:demo-claude-1:/);
    expect(snapshot.agents.find((a) => a.id === "pane:pane-claude")?.status).toBe("waiting");
    const sent = await page.evaluate(() => window.__e2eCompanion.sent as { type: string; payload: { id: string } }[]);
    expect(sent.some((e) => e.type === "agent.approval.requested" && e.payload.id === approval.id)).toBe(true);

    // The deck approves: Claude's "1" goes to the pane, the card shows the result.
    await page.evaluate((id) => window.__e2e.deck("approval.respond", { id, decision: "approve" }), approval.id);
    await expect.poll(() => page.evaluate(() => window.__e2eCompanion.keys)).toContainEqual({ paneId: "pane-claude", keys: "1" });
    await expect(card).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => window.__e2eCompanion.sent))
      .toContainEqual({ type: "agent.approval.resolved", payload: { id: approval.id, decision: "approve", by: "deck" } });
    await page.screenshot({ path: `test-results/screens/deck-approved-${theme}.png` });

    // A second respond for the same prompt does not send keys again.
    await page.evaluate((id) => window.__e2e.deck("approval.respond", { id, decision: "deny" }), approval.id);
    await page.waitForTimeout(200);
    expect((await page.evaluate(() => window.__e2eCompanion.keys)).length).toBe(1);

    // Pomodoro from the deck: a countdown chip in the status bar.
    await page.evaluate(() =>
      window.__e2e.deck("pomodoro.state", { phase: "focus", running: true, endsAt: Date.now() + 25 * 60_000, remaining: 1500, duration: 1500, session: 2, sessionsPerCycle: 4 }),
    );
    const chip = page.locator("[data-pomodoro-chip]");
    await expect(chip).toContainText("Focus");
    await expect(chip).toContainText(/2[45]:\d\d/);
    await page.screenshot({ path: `test-results/screens/deck-pomodoro-${theme}.png` });
    await page.evaluate(() =>
      window.__e2e.deck("pomodoro.state", { phase: "short-break", running: false, endsAt: null, remaining: 272, duration: 300, session: 2, sessionsPerCycle: 4 }),
    );
    await expect(chip).toContainText("Short break");
    await expect(chip).toContainText("4:32");
    await expect(chip).toContainText("paused");
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

for (const lang of ["en", "tr"] as const) {
  test(`settings shows the deck connection · ${lang}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/?theme=dark&lang=${lang}&deck=connected`);
    await page.waitForTimeout(1200);
    await page.getByRole("navigation").first().getByRole("button", { name: lang === "tr" ? "Ayarlar" : "Settings", exact: true }).click();
    await page.getByRole("button", { name: lang === "tr" ? "Ajanlar" : "Agents", exact: true }).click();
    const block = page.locator("[data-companion-settings]");
    await expect(block).toBeVisible();
    await expect(block.getByRole("status")).toHaveText(lang === "tr" ? "Kotilo Deck 1.0.1 ile bağlı" : "Connected to Kotilo Deck 1.0.1");
    await block.scrollIntoViewIfNeeded();
    await block.screenshot({ path: `test-results/screens/settings-deck-${lang}.png` });
    // Turning it off hides the status and saves the setting.
    await block.getByRole("checkbox").click();
    await expect(block.getByRole("status")).toHaveCount(0);
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
