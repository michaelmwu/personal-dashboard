import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dashboardFixture } from "../../packages/fixtures/dashboard.mjs";
import {
  createHermesAction,
  hermesCapabilities,
  hermesContextFromDashboard,
  normalizeHermesEvent
} from "../../packages/integrations/hermes.mjs";
import {
  integrationCatalog,
  normalizeSourceEvent
} from "../../packages/integrations/sources.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const port = Number.parseInt(process.env.API_PORT ?? "8810", 10);
const webPort = Number.parseInt(process.env.WEB_PORT ?? "8811", 10);

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": `http://127.0.0.1:${webPort}`,
    "Access-Control-Allow-Headers": "Content-Type, X-Hermes-Signature",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function packageInfo() {
  const raw = await readFile(join(root, "package.json"), "utf8");
  return JSON.parse(raw);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (request.method === "OPTIONS") {
      json(response, 204, {});
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      const pkg = await packageInfo();
      json(response, 200, {
        status: "ok",
        service: "@personal-dashboard/api",
        version: pkg.version,
        integrations: {
          hermes: "fixture-adapter-ready",
          openclaw: "fixture-adapter-ready"
        }
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      json(response, 200, dashboardFixture());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/integrations/catalog") {
      json(response, 200, { integrations: integrationCatalog() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/travel") {
      json(response, 200, dashboardFixture().travel);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/finance") {
      json(response, 200, dashboardFixture().finance);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/intake") {
      json(response, 200, dashboardFixture().intake);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/hermes/context") {
      json(response, 200, hermesContextFromDashboard(dashboardFixture()));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/hermes/capabilities") {
      json(response, 200, { capabilities: hermesCapabilities() });
      return;
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/api/hermes/actions" ||
        url.pathname === "/api/integrations/hermes/actions")
    ) {
      const payload = await readJson(request);
      json(response, 202, {
        accepted: true,
        action: createHermesAction(payload)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/integrations/hermes/events") {
      const payload = await readJson(request);
      json(response, 202, {
        accepted: true,
        normalized: normalizeHermesEvent(payload)
      });
      return;
    }

    const sourceEventMatch = url.pathname.match(/^\/api\/integrations\/([^/]+)\/events$/);
    if (request.method === "POST" && sourceEventMatch) {
      const payload = await readJson(request);
      json(response, 202, {
        accepted: true,
        normalized: normalizeSourceEvent(sourceEventMatch[1], payload)
      });
      return;
    }

    json(response, 404, { error: "not_found", path: url.pathname });
  } catch (error) {
    json(response, 500, {
      error: "internal_error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Personal Dashboard API listening on http://127.0.0.1:${port}`);
});
