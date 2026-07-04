import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.playwright.mjs",
  timeout: 10_000,
  webServer: {
    command:
      "API_PORT=55310 WEB_PORT=55311 DASHBOARD_DATA_FILE=.context/e2e-dashboard-store.json bun apps/api/server.mjs",
    url: "http://127.0.0.1:55310/api/health",
    reuseExistingServer: false,
    timeout: 10_000
  },
  use: {
    baseURL: "http://127.0.0.1:55310"
  }
});
