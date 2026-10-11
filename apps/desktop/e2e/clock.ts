import type { test as base } from "@playwright/test";

/** The mocked hub data is written relative to this instant (`NOW` in src/e2e/fixtures.ts). */
export const FIXTURE_NOW = new Date("2026-10-04T12:00:00+03:00");

/** Starts the page clock at the fixture time (it keeps running), so waits and ages read as in the fixtures. */
export function startAtFixtureTime(test: typeof base): void {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: FIXTURE_NOW });
  });
}
