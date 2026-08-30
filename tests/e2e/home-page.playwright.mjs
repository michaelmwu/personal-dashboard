import { expect, test } from "@playwright/test";
import http from "node:http";

import { createWebServer } from "../../apps/web/server.mjs";
import { dashboardFixture } from "../../packages/fixtures/dashboard.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("home page presents application portholes and links finance to its full workflow", async ({
  page
}) => {
  const apiServer = http.createServer((request, response) => {
    if (request.url === "/api/dashboard") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(dashboardFixture()));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const apiPort = await listen(apiServer);
  const webServer = createWebServer({ proxyBaseUrl: `http://127.0.0.1:${apiPort}` });
  const webPort = await listen(webServer);

  try {
    await page.goto(`http://127.0.0.1:${webPort}`, { waitUntil: "networkidle" });
    await expect(
      page.getByRole("heading", { name: "A calm view of what needs you." })
    ).toBeVisible();
    await expect(page.locator(".porthole").filter({ hasText: "Finance" })).toHaveAttribute(
      "href",
      "/finance"
    );
    await expect(page.getByText("Hotel rates")).toBeVisible();
    await expect(page.getByText("Coding agent")).toBeVisible();
  } finally {
    await page.close();
    await closeServer(webServer);
    await closeServer(apiServer);
  }
});
