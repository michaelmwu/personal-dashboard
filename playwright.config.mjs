import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const localChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const launchOptions = existsSync(localChromePath)
  ? {
      executablePath: localChromePath
    }
  : undefined;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.playwright.mjs",
  timeout: 10_000,
  webServer: {
    command:
      "API_PORT=55310 WEB_PORT=55311 PERSONAL_DASHBOARD_API_TOKEN= HOTEL_RATE_FINDER_API_BASE_URL= DASHBOARD_DATA_FILE=.context/e2e-dashboard-store.json bun apps/api/server.mjs",
    url: "http://127.0.0.1:55310/api/health",
    reuseExistingServer: false,
    timeout: 10_000
  },
  use: {
    baseURL: "http://127.0.0.1:55310",
    launchOptions
  }
});
