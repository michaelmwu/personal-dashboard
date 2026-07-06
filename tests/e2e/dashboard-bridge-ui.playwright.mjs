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

test("Hermes Bridge UI switches event streams when run ID changes", async ({ page }) => {
  const eventRunIds = [];
  const openEventResponses = new Set();
  const apiServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(dashboardFixture()));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/hermes/bridge/capabilities") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, bridge: { capabilities: [] } }));
      return;
    }

    const eventsMatch = url.pathname.match(/^\/api\/hermes\/bridge\/runs\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      const runId = eventsMatch[1];
      eventRunIds.push(runId);
      openEventResponses.add(response);
      response.on("close", () => {
        openEventResponses.delete(response);
      });
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache"
      });
      response.write(`event: run.status\ndata: {"run_id":"${runId}","status":"running"}\n\n`);
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "not_found", path: url.pathname }));
  });
  const apiPort = await listen(apiServer);
  const webServer = createWebServer({ proxyBaseUrl: `http://127.0.0.1:${apiPort}` });
  const webPort = await listen(webServer);

  try {
    await page.goto(`http://127.0.0.1:${webPort}`, { waitUntil: "networkidle" });
    await page.locator("#bridge-run-id").fill("run_old");
    await expect(page.locator("#bridge-events")).toContainText("run_old");

    await page.locator("#bridge-run-id").fill("run_new");
    await expect(page.locator("#bridge-events")).toContainText("run_new");
    expect(eventRunIds).toEqual(expect.arrayContaining(["run_old", "run_new"]));
  } finally {
    await page.close();
    for (const response of openEventResponses) {
      response.destroy();
    }
    await closeServer(webServer);
    await closeServer(apiServer);
  }
});
