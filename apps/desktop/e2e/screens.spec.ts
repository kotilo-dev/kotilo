import { expect, test, type Page } from "@playwright/test";
import { startAtFixtureTime } from "./clock";

startAtFixtureTime(test);

// Every route in dark/light × EN/TR against the fake hub; fails on uncaught page errors.
const ROUTES = ["workspace", "overview", "mission", "usage", "reports", "projects", "tasks", "dictation", "settings"] as const;
const VARIANTS = [
  { theme: "dark", lang: "en" },
  { theme: "light", lang: "en" },
  { theme: "dark", lang: "tr" },
  { theme: "light", lang: "tr" },
] as const;

async function openApp(page: Page, theme: string, lang: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?theme=${theme}&lang=${lang}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__e2e.pushHubSnapshot());
  await page.waitForTimeout(300);
  return errors;
}

for (const { theme, lang } of VARIANTS) {
  test(`all screens · ${theme} · ${lang}`, async ({ page }) => {
    const errors = await openApp(page, theme, lang);
    for (const [i, route] of ROUTES.entries()) {
      await page.keyboard.press(`Alt+${i + 1}`);
      await page.waitForTimeout(700);
      await page.screenshot({ path: `test-results/screens/${route}-${theme}-${lang}.png` });
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

// Workspace with two agent panes: the Codex pane waits for permission (fixture session
// `pane-codex`), the Claude pane is working. Shows the header strips and the permission card.
for (const theme of ["dark", "light"] as const) {
  test(`workspace agents · ${theme}`, async ({ page }) => {
    const errors = await openApp(page, theme, "en");
    await page.keyboard.press("Alt+1");
    const newTerminal = page.getByRole("button", { name: "New terminal" }).first();
    await newTerminal.click();
    await page.waitForTimeout(400);
    await page.getByTitle("New terminal").first().click();
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
    await page.screenshot({ path: `test-results/screens/workspace-agents-${theme}.png` });
    // The decision note: a small pill in the top-right corner, the bottom rows stay visible.
    await page.getByRole("button", { name: /^Allow once/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Allowed once" })).toBeVisible();
    await page.waitForTimeout(500); // the rise animation
    await page.screenshot({ path: `test-results/screens/workspace-permission-result-${theme}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

// Dictation overlay window (`?view=dictation-overlay`, 380×58): listening, transcribing and
// results, driven by `dictation:overlay` events the way Rust sends them.
for (const theme of ["dark", "light"] as const) {
  test(`dictation overlay · ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 380, height: 58 });
    await page.goto(`/?view=dictation-overlay&theme=${theme}&lang=en`);
    await expect(page.locator("html")).toHaveAttribute("data-view", "dictation-overlay");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.waitForTimeout(300);
    const show = (state: Record<string, unknown>) =>
      page.evaluate(async (payload) => {
        const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
        await emit("dictation:overlay", payload);
      }, { phase: "recording", mode: "undecided", elapsedMs: 0, level: 0, result: null, sound: null, ...state });

    for (const [i, level] of [0.002, 0.01, 0.04, 0.09, 0.03, 0.16, 0.06, 0.12, 0.02, 0.2, 0.08, 0.05].entries()) {
      await show({ mode: i < 9 ? "undecided" : "hold", elapsedMs: 7_000 + i * 40, level });
    }
    await page.waitForTimeout(150);
    await page.screenshot({ path: `test-results/screens/dictation-overlay-recording-${theme}.png`, omitBackground: true });

    await show({ phase: "transcribing", elapsedMs: 7_500 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `test-results/screens/dictation-overlay-transcribing-${theme}.png`, omitBackground: true });

    await show({ phase: "result", result: { ok: true, message: "inserted" } });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `test-results/screens/dictation-overlay-inserted-${theme}.png`, omitBackground: true });

    await show({ phase: "result", result: { ok: false, message: "elevatedTarget" } });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `test-results/screens/dictation-overlay-error-${theme}.png`, omitBackground: true });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

// Settings → AI: two agent CLIs (Gemini not verified), the local Ollama endpoint with a stored
// key; "Not fully local" with the daily summary on an agent CLI, "Fully local" with `ai=local`.
for (const { theme, lang } of VARIANTS) {
  for (const ai of ["mixed", "local"] as const) {
    test(`settings ai · ${ai} · ${theme} · ${lang}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setViewportSize({ width: 1440, height: 1400 });
      await page.goto(`/?theme=${theme}&lang=${lang}${ai === "local" ? "&ai=local" : ""}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.__e2e.pushHubSnapshot());
      await page.waitForTimeout(300);
      await page.getByRole("navigation").first().getByRole("button", { name: lang === "tr" ? "Ayarlar" : "Settings", exact: true }).click();
      await page.getByRole("button", { name: lang === "tr" ? "Yapay zekâ" : "AI", exact: true }).click();
      await expect(page.getByRole("button", { name: lang === "tr" ? "Gemini CLI dene" : "Test Gemini CLI" })).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `test-results/screens/settings-ai-${ai}-${theme}-${lang}.png` });
      if (ai === "mixed") {
        await page.getByRole("button", { name: lang === "tr" ? "Gemini CLI dene" : "Test Gemini CLI" }).click();
        await page.getByRole("button", { name: lang === "tr" ? "ollama düzenle" : "Edit ollama" }).click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `test-results/screens/settings-ai-endpoint-${theme}-${lang}.png` });
      }
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
}

// M3 wave 3 — Settings → Agents: the eight built-in adapters (hook states, the folder-trust /
// hooks-disabled hints, needs approval), a custom protocol adapter and an invalid user file;
// then the "Add custom agent" wizard on its screen-rules step with one rule rejected.
const AGENT_LABELS = {
  en: { settings: "Settings", agents: "Agents", add: "Add custom agent", next: "Next", addRule: "Add rule", pattern: "Pattern", id: "Id", name: "Display name", command: "Launch command", allow: "Allow once", deny: "Deny" },
  tr: { settings: "Ayarlar", agents: "Ajanlar", add: "Özel ajan ekle", next: "İleri", addRule: "Kural ekle", pattern: "Desen", id: "Kimlik", name: "Görünen ad", command: "Başlatma komutu", allow: "Bir kez izin ver", deny: "Reddet" },
} as const;

for (const { theme, lang } of VARIANTS) {
  test(`settings agents · ${theme} · ${lang}`, async ({ page }) => {
    const l = AGENT_LABELS[lang];
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 1900 });
    await page.goto(`/?theme=${theme}&lang=${lang}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.__e2e.pushHubSnapshot());
    await page.getByRole("navigation").first().getByRole("button", { name: l.settings, exact: true }).click();
    await page.getByRole("button", { name: l.agents, exact: true }).click();
    await expect(page.getByText("Local LLM Agent")).toBeVisible();
    await expect(page.getByText("broken-agent").first()).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/screens/settings-agents-${theme}-${lang}.png` });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: l.add, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(l.id, { exact: true }).fill("local-review");
    await dialog.getByLabel(l.name, { exact: true }).fill("Local Review");
    await dialog.getByRole("button", { name: l.next, exact: true }).click();
    await dialog.getByLabel(l.command, { exact: true }).fill("local-review");
    await dialog.getByRole("button", { name: l.next, exact: true }).click();
    await dialog.getByLabel(l.allow, { exact: true }).fill("y");
    await dialog.getByLabel(l.deny, { exact: true }).fill("n");
    await dialog.getByRole("button", { name: l.next, exact: true }).click();
    await dialog.getByRole("button", { name: l.addRule, exact: true }).click();
    await dialog.getByLabel(l.pattern, { exact: true }).nth(0).fill("Allow this command\? \(y/n\)");
    await dialog.getByRole("button", { name: l.addRule, exact: true }).click();
    await dialog.getByLabel(l.pattern, { exact: true }).nth(1).fill("(?<=Run )tool");
    await dialog.getByRole("button", { name: l.next, exact: true }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/settings-agents-wizard-rules-${theme}-${lang}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

// A Cursor CLI pane whose permission prompt was found on its screen (desktop `blocked`, the
// hub session only knows observational hooks): the card offers Cursor's own y / n keys.
for (const theme of ["dark", "light"] as const) {
  test(`workspace cursor permission · ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/?theme=${theme}&lang=en&panes=pane-cursor`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.waitForTimeout(1200);
    await page.keyboard.press("Alt+1");
    await page.getByRole("button", { name: "New terminal" }).first().click();
    await page.waitForTimeout(400);
    await page.evaluate(async () => {
      const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
      await emit("agents:changed", [
        { id: "a3", paneId: "pane-cursor", workspaceId: "ws-demo", kind: "cursor", adapterId: "cursor", state: "blocked", sinceMs: Date.now() - 38_000, source: "hook", sessionId: null },
      ]);
    });
    await page.evaluate(() => window.__e2e.pushHubSnapshot());
    await expect(page.getByRole("region", { name: "Permission request" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Deny/ })).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/screens/workspace-cursor-permission-${theme}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

// Overlays imported from AgentDeck: Help (F1) with a doc and the About item, the command
// palette (Ctrl+Shift+P) and quick open (Ctrl+P) over the workspace.
for (const theme of ["dark", "light"] as const) {
  test(`overlays · ${theme}`, async ({ page }) => {
    const errors = await openApp(page, theme, "en");
    await page.keyboard.press("Alt+1");
    await page.waitForTimeout(300);
    // The workspace may still be moving focus into a terminal when F1 is pressed; retry until Help opens.
    await expect(async () => {
      await page.keyboard.press("F1");
      await expect(page.getByRole("dialog", { name: "Help" })).toBeVisible({ timeout: 1_500 });
    }).toPass({ timeout: 15_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/help-${theme}.png` });
    await page.getByRole("tab", { name: "About" }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/screens/help-about-${theme}.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+Shift+P");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/screens/palette-${theme}.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+P");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/screens/quick-open-${theme}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

// M6 — Settings → Mascot (saved at once; the fixture has the mascot off and already offered).
for (const { theme, lang } of VARIANTS) {
  test(`settings mascot · ${theme} · ${lang}`, async ({ page }) => {
    const errors = await openApp(page, theme, lang);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("navigation").first().getByRole("button", { name: lang === "tr" ? "Ayarlar" : "Settings", exact: true }).click();
    await page.getByRole("button", { name: lang === "tr" ? "Maskot" : "Mascot", exact: true }).click();
    await expect(page.getByTestId("mascot-preview")).toBeVisible();
    await page.getByRole("radio", { name: lang === "tr" ? "Büyük" : "Large" }).click();
    await expect(page.getByRole("radio", { name: lang === "tr" ? "Büyük" : "Large" })).toHaveAttribute("aria-checked", "true");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/screens/settings-mascot-${theme}-${lang}.png` });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
