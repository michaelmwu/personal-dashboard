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
  createHermesBridgeRun,
  HermesBridgeLoopError,
  streamHermesBridgeRunEvents
} from "../../packages/integrations/hermes-bridge.mjs";
import {
  integrationCatalog,
  isSupportedSourceAdapter,
  normalizeSourceEvent
} from "../../packages/integrations/sources.mjs";
import {
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  normalizePlaidAccount,
  normalizePlaidTransaction,
  normalizeRemovedPlaidTransaction,
  syncPlaidTransactions
} from "../../packages/integrations/plaid.mjs";
import {
  applyPlaidSync,
  dashboardStorePath,
  listPlaidItems,
  loadDashboard,
  patchHermesAction,
  upsertPlaidItem,
  upsertHermesAction,
  upsertHermesEvent,
  upsertNormalizedEvent
} from "../../packages/storage/dashboard-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const port = Number.parseInt(process.env.API_PORT ?? "8810", 10);
const webPort = Number.parseInt(process.env.WEB_PORT ?? "8811", 10);
const hermesApiToken = process.env.PERSONAL_DASHBOARD_API_TOKEN ?? "";
const storePath = dashboardStorePath(root);
const asiaTravelDealsApiBaseUrl = process.env.ASIA_TRAVEL_DEALS_API_BASE_URL ?? "";
const asiaTravelDealsApiToken = process.env.ASIA_TRAVEL_DEALS_API_TOKEN ?? "";

async function dashboardSnapshot() {
  return loadDashboard(dashboardFixture(), storePath);
}

async function syncPlaidItem(item) {
  const sync = await syncPlaidTransactions({
    accessToken: item.accessToken,
    cursor: item.cursor
  });
  const normalizedSync = {
    ...sync,
    accounts: sync.accounts.map(normalizePlaidAccount),
    added: sync.added.map(normalizePlaidTransaction),
    modified: sync.modified.map(normalizePlaidTransaction),
    removed: sync.removed.map(normalizeRemovedPlaidTransaction)
  };
  await applyPlaidSync(storePath, item.id, normalizedSync);
  return normalizedSync;
}

async function syncPlaidItems({ itemId } = {}) {
  const items = await listPlaidItems(storePath);
  const selectedItems = itemId ? items.filter((item) => item.id === itemId) : items;
  const results = [];
  for (const item of selectedItems) {
    results.push({ itemId: item.id, ...(await syncPlaidItem(item)) });
  }
  return {
    synced: results.every((result) => result.synced),
    itemCount: selectedItems.length,
    results
  };
}

async function streamBridgeRunOntoAction(action, runId) {
  try {
    await streamHermesBridgeRunEvents(runId, async (event) => {
      const status = event.data?.status;
      await patchHermesAction(storePath, action.id, {
        status: typeof status === "string" ? status : "running",
        bridgeRunId: runId,
        dispatch: {
          target: "hermes-bridge",
          runId,
          lastEvent: event
        }
      });
    });
  } catch (error) {
    await patchHermesAction(storePath, action.id, {
      status: "dispatch_error",
      dispatch: {
        target: "hermes-bridge",
        runId,
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

async function dispatchHermesAction(action) {
  if (action.capabilityId !== "asia_deal_verify" && action.origin === "hermes") {
    return { dispatched: false, reason: "hermes_origin_loop_guard" };
  }

  if (action.capabilityId !== "asia_deal_verify") {
    const dispatch = await createHermesBridgeRun(action);
    if (dispatch.dispatched && dispatch.runId) {
      queueMicrotask(() => {
        streamBridgeRunOntoAction(action, dispatch.runId);
      });
    }
    return dispatch;
  }
  const dealId = action.payload.dealId ?? action.payload.deal_id;
  if (!dealId) {
    return { dispatched: false, reason: "missing_deal_id" };
  }
  if (!asiaTravelDealsApiBaseUrl) {
    return { dispatched: false, reason: "missing_asia_travel_deals_api_base_url" };
  }

  const response = await fetch(
    `${asiaTravelDealsApiBaseUrl.replace(/\/$/, "")}/deals/${encodeURIComponent(dealId)}/verify`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(asiaTravelDealsApiToken ? { Authorization: `Bearer ${asiaTravelDealsApiToken}` } : {})
      },
      body: JSON.stringify({
        provider: action.payload.provider ?? "dashboard",
        query: action.payload.query ?? { requestedBy: "hermes" }
      })
    }
  );
  return {
    dispatched: response.ok,
    statusCode: response.status,
    response: response.ok ? await response.json() : await response.text()
  };
}

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": `http://127.0.0.1:${webPort}`,
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Idempotency-Key, X-Hermes-Signature",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  response.end(body);
}

function error(response, statusCode, code, message) {
  json(response, statusCode, { error: code, message });
}

function requireHermesAuth(request, response) {
  if (!hermesApiToken) {
    return true;
  }

  if (request.headers.authorization === `Bearer ${hermesApiToken}`) {
    return true;
  }

  error(response, 401, "unauthorized", "Missing or invalid Hermes API bearer token.");
  return false;
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
      json(response, 200, await dashboardSnapshot());
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/integrations/catalog") {
      json(response, 200, { integrations: integrationCatalog() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/travel") {
      json(response, 200, (await dashboardSnapshot()).travel);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/finance") {
      json(response, 200, (await dashboardSnapshot()).finance);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/intake") {
      json(response, 200, (await dashboardSnapshot()).intake);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/integrations/plaid/link-token") {
      if (!requireHermesAuth(request, response)) {
        return;
      }
      const payload = await readJson(request);
      const linkToken = await createPlaidLinkToken({
        userId: payload.userId ?? "personal-dashboard"
      });
      json(response, linkToken.created ? 200 : 503, linkToken);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/integrations/plaid/exchange-public-token"
    ) {
      if (!requireHermesAuth(request, response)) {
        return;
      }
      const payload = await readJson(request);
      if (!payload.publicToken && !payload.public_token) {
        error(response, 400, "missing_public_token", "Plaid public token is required.");
        return;
      }
      const exchange = await exchangePlaidPublicToken(payload.publicToken ?? payload.public_token);
      if (!exchange.exchanged) {
        json(response, 502, exchange);
        return;
      }
      await upsertPlaidItem(storePath, {
        id: exchange.itemId,
        accessToken: exchange.accessToken,
        cursor: undefined,
        institutionName: payload.institutionName ?? payload.institution_name,
        syncStatus: "linked",
        linkedAt: new Date().toISOString()
      });
      json(response, 202, {
        accepted: true,
        itemId: exchange.itemId,
        requestId: exchange.requestId
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/integrations/plaid/sync") {
      if (!requireHermesAuth(request, response)) {
        return;
      }
      const payload = await readJson(request);
      const result = await syncPlaidItems({ itemId: payload.itemId ?? payload.item_id });
      json(response, result.synced ? 202 : 207, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/integrations/plaid/webhook") {
      const payload = await readJson(request);
      if (
        payload.webhook_type === "TRANSACTIONS" &&
        payload.webhook_code === "SYNC_UPDATES_AVAILABLE"
      ) {
        const result = await syncPlaidItems({ itemId: payload.item_id });
        json(response, result.synced ? 202 : 207, {
          accepted: true,
          webhook: payload,
          result
        });
        return;
      }
      json(response, 202, {
        accepted: true,
        ignored: true,
        webhook: payload
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/hermes/context") {
      if (!requireHermesAuth(request, response)) {
        return;
      }
      json(response, 200, hermesContextFromDashboard(await dashboardSnapshot()));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/hermes/capabilities") {
      if (!requireHermesAuth(request, response)) {
        return;
      }
      json(response, 200, { capabilities: hermesCapabilities() });
      return;
    }

    if (
      request.method === "POST" &&
      (url.pathname === "/api/hermes/actions" ||
        url.pathname === "/api/integrations/hermes/actions")
    ) {
      if (!requireHermesAuth(request, response)) {
        return;
      }
      const payload = await readJson(request);
      if (!payload.idempotencyKey && request.headers["idempotency-key"]) {
        payload.idempotencyKey = request.headers["idempotency-key"];
      }
      const capabilityId = payload.capabilityId ?? payload.action;
      const capability = hermesCapabilities().find((item) => item.id === capabilityId);
      if (!capability) {
        error(
          response,
          400,
          "unsupported_capability",
          `Unsupported Hermes capability: ${capabilityId ?? "missing"}`
        );
        return;
      }
      if (payload.target && payload.target !== capability.target) {
        error(
          response,
          400,
          "target_mismatch",
          `Hermes capability ${capabilityId} must target ${capability.target}, not ${payload.target}.`
        );
        return;
      }
      let action = createHermesAction({
        ...payload,
        origin: payload.origin ?? "hermes"
      });
      let dispatch;
      try {
        dispatch = await dispatchHermesAction(action);
      } catch (dispatchError) {
        if (dispatchError instanceof HermesBridgeLoopError) {
          dispatch = { dispatched: false, reason: "hermes_origin_loop_guard" };
        } else {
          throw dispatchError;
        }
      }
      if (dispatch.dispatched) {
        action = {
          ...action,
          status: dispatch.runId ? "running" : "dispatched",
          bridgeRunId: dispatch.runId,
          payload: { ...action.payload, dispatch },
          dispatch
        };
      }
      await upsertHermesAction(storePath, action);
      json(response, 202, {
        accepted: true,
        action,
        dispatch
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/integrations/hermes/events") {
      const payload = await readJson(request);
      const normalized = normalizeHermesEvent(payload);
      await upsertHermesEvent(storePath, normalized);
      json(response, 202, {
        accepted: true,
        normalized
      });
      return;
    }

    const sourceEventMatch = url.pathname.match(/^\/api\/integrations\/([^/]+)\/events$/);
    if (request.method === "POST" && sourceEventMatch) {
      const source = sourceEventMatch[1];
      if (!isSupportedSourceAdapter(source)) {
        error(response, 404, "unsupported_source", `Unsupported integration source: ${source}`);
        return;
      }
      const payload = await readJson(request);
      const normalized = normalizeSourceEvent(source, payload);
      await upsertNormalizedEvent(storePath, normalized);
      json(response, 202, {
        accepted: true,
        normalized
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
