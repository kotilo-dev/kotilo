import { defineConfig, devices } from "@playwright/test";

// Browser e2e against the Vite dev server in `--mode e2e` (Tauri IPC mocked, fake hub data
// from src/e2e/fixtures.ts). Run: `npm run e2e`. Screenshots land in test-results/screens/.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1430",
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: "npx vite --mode e2e --port 1430 --strictPort",
    url: "http://localhost:1430",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
