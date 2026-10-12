import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the real production bundle (built with
 * --mode e2e so it calls the API on its own origin), served by
 * `vite preview`. The API is mocked inside the browser (e2e/mockApi.ts), so
 * the suite needs no backend or database and runs the same in CI.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:4173",
    // The production service worker would answer fetches before page.route sees them.
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command:
      "npx vite build --mode e2e --outDir dist-e2e && npx vite preview --outDir dist-e2e --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
