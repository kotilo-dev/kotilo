import { defineConfig, devices } from "@playwright/test";
import process from "node:process";

// Browser e2e against the Vite dev server in `--mode e2e` (Tauri IPC mocked, fake hub data
// from src/e2e/fixtures.ts). Run: `npm run e2e`. Screenshots land in test-results/screens/.
// `E2E_PORT` lets several checkouts (git worktrees) run their e2e suites side by side.
const port = Number(process.env.E2E_PORT ?? 1430);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx vite --mode e2e --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
