import { expect, test, type Page } from "@playwright/test";

// M7 assistant popup (`?view=assistant`, 400 × 580). The mocked backend (src/e2e/assistantFixtures.ts)
// streams canned answers through the Tauri Channel; `assistant=off|unavailable|error|slow`
// picks a scenario. Calls are recorded on `window.__e2eAssistant`.
const VARIANTS = [
  { theme: "dark", lang: "en" },
  { theme: "light", lang: "en" },
  { theme: "dark", lang: "tr" },
  { theme: "light", lang: "tr" },
] as const;

const QUESTIONS = {
  en: ["How do I undo the last git commit but keep the changes?", "And if I already pushed it?"],
  tr: ["Son git commit'ini değişiklikleri koruyarak nasıl geri alırım?", "Peki zaten push ettiysem?"],
} as const;

const LABELS = {
  en: { message: "Message", stop: "Stop", copyAnswer: "Copy answer", copyCode: "Copy code", settings: "Settings → AI", newChat: "New chat" },
  tr: { message: "Mesaj", stop: "Durdur", copyAnswer: "Yanıtı kopyala", copyCode: "Kodu kopyala", settings: "Ayarlar → Yapay zekâ", newChat: "Yeni sohbet" },
} as const;

interface Recorder {
  chats: { role: string; text: string }[][];
  stops: number;
  hides: number;
  opens: number;
  configs: unknown[];
}

const recorder = (page: Page) => page.evaluate(() => (window as unknown as { __e2eAssistant: Recorder }).__e2eAssistant);

async function openAssistant(page: Page, params: Record<string, string>): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 400, height: 580 });
  await page.goto(`/?${new URLSearchParams({ view: "assistant", theme: "dark", lang: "en", ...params }).toString()}`);
  await expect(page.locator("html")).toHaveAttribute("data-view", "assistant");
  await expect(page.getByTestId("assistant")).toBeVisible();
  return errors;
}

async function ask(page: Page, lang: "en" | "tr", text: string): Promise<void> {
  const input = page.getByRole("textbox", { name: LABELS[lang].message });
  await input.fill(text);
  await input.press("Enter");
}

const turns = (page: Page) => page.getByTestId("assistant-turn");

for (const { theme, lang } of VARIANTS) {
  test(`assistant chat · ${theme} · ${lang}`, async ({ page }) => {
    const errors = await openAssistant(page, { theme, lang });
    await expect(page.getByRole("textbox", { name: LABELS[lang].message })).toBeFocused();
    await ask(page, lang, QUESTIONS[lang][0]);
    await expect(turns(page).nth(0)).toHaveAttribute("data-status", "done");
    await ask(page, lang, QUESTIONS[lang][1]);
    await expect(turns(page).nth(1)).toHaveAttribute("data-status", "done");
    await expect(page.getByRole("button", { name: LABELS[lang].copyCode })).toHaveCount(1);
    await expect(page.getByTestId("assistant-footer")).toHaveAttribute("data-variant", "ephemeral");

    // The second send carries the first turn (user + answer) and the new question.
    const rec = await recorder(page);
    expect(rec.chats.map((c) => c.map((m) => m.role))).toEqual([["user"], ["user", "assistant", "user"]]);
    expect(rec.chats[1]![2]!.text).toBe(QUESTIONS[lang][1]);

    await page.mouse.move(0, 0);
    await page.screenshot({ path: `test-results/screens/assistant-chat-${theme}-${lang}.png`, omitBackground: true });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("assistant streaming · stop with Esc, then Esc closes", async ({ page }) => {
  const errors = await openAssistant(page, { assistant: "slow", ephemeral: "false" });
  await ask(page, "en", QUESTIONS.en[0]);
  const stop = page.getByRole("button", { name: LABELS.en.stop });
  await expect(stop).toBeVisible();
  await expect(page.getByTestId("assistant-typing")).toBeVisible();
  // Half an answer is on screen (the mock waits there for Stop).
  await expect(turns(page).nth(0)).toContainText("git reset --soft");
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
  await expect(page.getByTestId("assistant-footer")).toHaveAttribute("data-variant", "keeps");
  await page.screenshot({ path: "test-results/screens/assistant-streaming-dark.png", omitBackground: true, animations: "disabled" });

  await page.keyboard.press("Escape");
  await expect(turns(page).nth(0)).toHaveAttribute("data-status", "stopped");
  expect((await recorder(page)).stops).toBe(1);
  expect((await recorder(page)).hides).toBe(0);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await recorder(page)).hides).toBe(1);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("assistant error turn with the settings hint", async ({ page }) => {
  const errors = await openAssistant(page, { assistant: "error", ephemeral: "null" });
  await ask(page, "en", "What's a good name for a robot snail?");
  await expect(turns(page).nth(0)).toHaveAttribute("data-status", "error");
  await expect(page.getByRole("alert")).toContainText("isn't signed in");
  await expect(page.getByTestId("assistant-footer")).toHaveAttribute("data-variant", "mayKeep");
  await page.screenshot({ path: "test-results/screens/assistant-error-dark.png", omitBackground: true });
  await page.getByRole("button", { name: LABELS.en.settings }).click();
  await expect.poll(async () => (await recorder(page)).hides).toBe(1);
  expect(errors, errors.join("\n")).toEqual([]);
});

for (const theme of ["dark", "light"] as const) {
  test(`assistant not available · ${theme}`, async ({ page }) => {
    const errors = await openAssistant(page, { assistant: "unavailable", theme });
    await expect(page.getByTestId("assistant-unavailable")).toContainText("isn't installed");
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await page.screenshot({ path: `test-results/screens/assistant-unavailable-${theme}.png`, omitBackground: true });

    await page.goto(`/?view=assistant&assistant=off&theme=${theme}&lang=tr`);
    await expect(page.getByTestId("assistant-unavailable")).toContainText("Asistan kapalı");
    await page.screenshot({ path: `test-results/screens/assistant-off-${theme}-tr.png`, omitBackground: true });
    expect(errors, errors.join("\n")).toEqual([]);
  });
}

test("assistant keys: ↑ edits the last question, Ctrl+N and assistant:opened start a new chat", async ({ page }) => {
  const errors = await openAssistant(page, {});
  const input = page.getByRole("textbox", { name: LABELS.en.message });
  await ask(page, "en", QUESTIONS.en[0]);
  await expect(turns(page).nth(0)).toHaveAttribute("data-status", "done");
  await ask(page, "en", QUESTIONS.en[1]);
  await expect(turns(page).nth(1)).toHaveAttribute("data-status", "done");

  // Shift+Enter is a new line, not a send.
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("\n");
  await input.fill("");

  await input.press("ArrowUp");
  await expect(input).toHaveValue(QUESTIONS.en[1]);
  await expect(turns(page)).toHaveCount(1);
  await input.press("Enter");
  await expect(turns(page).nth(1)).toHaveAttribute("data-status", "done");
  expect((await recorder(page)).chats.at(-1)!.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

  await page.keyboard.press("Control+n");
  await expect(turns(page)).toHaveCount(0);
  await expect(input).toBeFocused();

  await ask(page, "en", QUESTIONS.en[0]);
  await expect(turns(page).nth(0)).toHaveAttribute("data-status", "done");
  await page.evaluate(async () => {
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("assistant:opened");
  });
  await expect(turns(page)).toHaveCount(0);
  // A fresh chat sends only the new question.
  await ask(page, "en", QUESTIONS.en[1]);
  await expect(turns(page).nth(0)).toHaveAttribute("data-status", "done");
  expect((await recorder(page)).chats.at(-1)!.map((m) => m.role)).toEqual(["user"]);
  expect(errors, errors.join("\n")).toEqual([]);
});

// Settings → AI, assistant row: on/off, shortcut with the "taken" report from Rust, Open assistant.
for (const { theme, lang } of VARIANTS) {
  test(`settings assistant · ${theme} · ${lang}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/?theme=${theme}&lang=${lang}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.__e2e.pushHubSnapshot());
    // The bridge sends the saved config at startup.
    await expect.poll(async () => (await recorder(page)).configs.at(-1)).toEqual({ enabled: true, hotkey: "Ctrl+Alt+Space" });

    await page.getByRole("navigation").first().getByRole("button", { name: lang === "tr" ? "Ayarlar" : "Settings", exact: true }).click();
    await page.getByRole("button", { name: lang === "tr" ? "Yapay zekâ" : "AI", exact: true }).click();
    const row = page.getByTestId("assistant-settings");
    await expect(row).toBeVisible();
    await page.evaluate(async () => {
      const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
      await emit("assistant:hotkey", { status: "taken", hotkey: "Ctrl+Alt+Space" });
    });
    await expect(row.getByRole("alert")).toContainText(lang === "tr" ? "başka bir uygulama" : "used by another app");
    await row.getByRole("button", { name: lang === "tr" ? "Asistanı aç" : "Open assistant" }).click();
    await expect.poll(async () => (await recorder(page)).opens).toBe(1);
    await page.mouse.move(0, 0);
    await row.locator("xpath=..").screenshot({ path: `test-results/screens/settings-assistant-${theme}-${lang}.png` });

    // Turning it off goes through the save bar.
    await row.getByRole("checkbox").uncheck();
    await expect(row.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("region", { name: lang === "tr" ? "Değişiklikleri kaydet" : "Save changes" })).toBeVisible();
    expect(errors, errors.join("\n")).toEqual([]);
  });
}
