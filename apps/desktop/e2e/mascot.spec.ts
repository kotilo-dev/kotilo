import { expect, test, type Page } from "@playwright/test";

// M6 mascot window (`?view=mascot`, transparent, 2H × 2H with H = 16 × scale). The page has a
// static demo state from the URL (`demo`, `scale`, `direction`, `walking`, `celebrate`), so no
// events are needed. A style override paints a light or dark "desktop" behind the transparent
// page for the screenshots.
const STATES = ["sleep", "done", "work", "sweat", "input", "perm", "error"] as const;
const BACKDROPS = { light: "#e9edf3", dark: "#1f1f1f" } as const;
type Backdrop = keyof typeof BACKDROPS;

function mascotUrl(params: Record<string, string | number | boolean>): string {
  const q = new URLSearchParams({ view: "mascot", ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  return `/?${q.toString()}`;
}

async function openMascot(page: Page, scale: number, params: Record<string, string | number | boolean>, backdrop?: Backdrop): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 32 * scale, height: 32 * scale });
  await page.goto(mascotUrl({ scale, ...params }));
  await expect(page.locator("html")).toHaveAttribute("data-view", "mascot");
  await expect(page.getByTestId("mascot-snail")).toBeVisible();
  if (backdrop) await page.addStyleTag({ content: `html[data-view="mascot"] { background: ${BACKDROPS[backdrop]} !important; }` });
  return errors;
}

/** Records every IPC command name the page invokes (wraps the mock `mockIPC` installs). */
async function recordInvokes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: { cmd: string; args: unknown }[] = [];
    let inner: ((cmd: string, args: unknown, options: unknown) => Promise<unknown>) | undefined;
    const internals: Record<string, unknown> = {};
    Object.defineProperty(internals, "invoke", {
      configurable: true,
      get: () => (cmd: string, args: unknown, options: unknown) => {
        if (!cmd.startsWith("plugin:")) calls.push({ cmd, args });
        return inner ? inner(cmd, args, options) : Promise.resolve(null);
      },
      set: (fn) => {
        inner = fn;
      },
    });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
    (window as unknown as Record<string, unknown>).__mascotCalls = calls;
  });
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __mascotCalls: { cmd: string; args: unknown }[] }).__mascotCalls.slice());

for (const backdrop of ["light", "dark"] as const) {
  test(`mascot states · scale 3 · ${backdrop}`, async ({ page }) => {
    for (const state of STATES) {
      for (const direction of ["left", "right"] as const) {
        const errors = await openMascot(page, 3, { demo: state, direction }, backdrop);
        await expect(page.locator(".mascot")).toHaveAttribute("data-state", state);
        await expect(page.getByTestId("mascot-bubble")).toHaveCount(state === "perm" || state === "input" || state === "error" ? 1 : 0);
        await page.screenshot({ path: `test-results/screens/mascot-${state}-s3-${direction}-${backdrop}.png`, animations: "disabled" });
        expect(errors, errors.join("\n")).toEqual([]);
      }
    }
  });

  test(`mascot scales 2 and 4 · ${backdrop}`, async ({ page }) => {
    for (const scale of [2, 4]) {
      const errors = await openMascot(page, scale, { demo: "perm", direction: "right" }, backdrop);
      const box = await page.getByTestId("mascot-snail").boundingBox();
      expect(box).toEqual({ x: 0.375 * 16 * scale, y: 16 * scale, width: 20 * scale, height: 16 * scale });
      await page.screenshot({ path: `test-results/screens/mascot-perm-s${scale}-${backdrop}.png`, animations: "disabled" });
      expect(errors, errors.join("\n")).toEqual([]);
    }
  });
}

// Overview for review: every state side by side at 3× pixel density on both backdrops.
test("mascot lineup", async ({ browser }) => {
  for (const scale of [2, 3]) {
    const context = await browser.newContext({ deviceScaleFactor: 3 });
    const page = await context.newPage();
    const base = "http://localhost:1430";
    const size = 32 * scale;
    const cell = (state: string, direction: string) =>
      `<iframe src="${base}${mascotUrl({ demo: state, scale, direction })}" width="${size}" height="${size}" style="border:0;background:transparent" allowtransparency="true"></iframe>`;
    const row = (backdrop: Backdrop, direction: string) =>
      `<div style="display:flex;gap:6px;padding:6px;background:${BACKDROPS[backdrop]}">${STATES.map((s) => cell(s, direction)).join("")}</div>`;
    await page.setViewportSize({ width: STATES.length * (size + 6) + 12, height: 4 * (size + 12) });
    await page.setContent(`<body style="margin:0">${row("light", "right")}${row("dark", "right")}${row("light", "left")}${row("dark", "left")}</body>`);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `test-results/screens/mascot-lineup-s${scale}.png`, animations: "disabled" });
    await context.close();
  }
});

test("mascot shows the event state, sends ready, click, context menu and drag", async ({ page }) => {
  await recordInvokes(page);
  const errors = await openMascot(page, 3, {});
  // Before any event: sleep, scale 3, facing left.
  await expect(page.locator(".mascot")).toHaveAttribute("data-state", "sleep");
  await expect(page.locator(".mascot")).toHaveAttribute("data-direction", "left");
  await expect.poll(async () => (await calls(page)).map((c) => c.cmd)).toContain("mascot_ready");

  await page.evaluate(async () => {
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("mascot:state", { state: "input", direction: "right", walking: false, scale: 3, celebrate: false, label: "Kotilo: an agent asks a question" });
  });
  await expect(page.locator(".mascot")).toHaveAttribute("data-state", "input");
  await expect(page.getByRole("img", { name: "Kotilo: an agent asks a question" })).toBeVisible();
  await expect(page.getByTestId("mascot-bubble")).toHaveText("?");

  const snail = page.getByTestId("mascot-snail");
  const box = (await snail.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const before = (await calls(page)).length;

  // Click (no movement) → mascot_clicked.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.up();
  // Right click → mascot_context_menu (and no click).
  await snail.click({ button: "right" });
  // Small jitter under the threshold is still a click.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 2, cy + 1);
  await page.mouse.up();
  await expect.poll(async () => (await calls(page)).slice(before).map((c) => c.cmd)).toEqual(["mascot_clicked", "mascot_context_menu", "mascot_clicked"]);

  // Drag → mascot_drag deltas summing to the horizontal movement, then mascot_drag_end, no click.
  const dragStart = (await calls(page)).length;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 10, cy, { steps: 5 });
  await page.mouse.move(cx + 25, cy + 3, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await calls(page)).slice(dragStart).at(-1)?.cmd).toBe("mascot_drag_end");
  const drag = (await calls(page)).slice(dragStart);
  expect(drag.map((c) => c.cmd)).not.toContain("mascot_clicked");
  const dx = drag.filter((c) => c.cmd === "mascot_drag").reduce((sum, c) => sum + (c.args as { dx: number }).dx, 0);
  expect(dx).toBe(25);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("mascot reduced motion keeps the state without animation", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await openMascot(page, 3, { demo: "perm", direction: "right" }, "dark");
  const halo = page.locator(".ms-halo");
  expect(await halo.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  expect(await halo.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0);
  await page.goto(mascotUrl({ demo: "work", scale: 3, direction: "right" }));
  await expect(page.locator(".mascot")).toHaveAttribute("data-walking", "true");
  expect(await page.locator(".ms-shell").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await page.screenshot({ path: "test-results/screens/mascot-work-reduced-motion.png" });
  await context.close();
});
