import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { dashboardFixture } from "../../packages/fixtures/dashboard.mjs";
import {
  createHermesAction,
  hermesCapabilities,
  hermesContextFromDashboard,
  normalizeHermesEvent
} from "../../packages/integrations/hermes.mjs";
import {
  approveHermesBridgeRun,
  createHermesBridgeRun,
  getHermesBridgeCapabilities,
  getHermesBridgeRun,
  hermesBridgeStatus,
  HermesBridgeLoopError,
  openHermesBridgeRunEvents,
  startHermesBridgeRun,
  stopHermesBridgeRun,
  streamHermesBridgeRunEvents
} from "../../packages/integrations/hermes-bridge.mjs";
import {
  integrationCatalog,
  isSupportedSourceAdapter,
  normalizeSourceEvent
} from "../../packages/integrations/sources.mjs";
import {
  genericAppItemsFromDashboard,
  loadPluginRegistry
} from "../../packages/integrations/registry.mjs";
import {
  createHotelSavedSearch,
  hotelRateDropAlert,
  hotelRateFailureAlert,
  hotelRateWatchFromJobResponse,
  hotelRatesConfig,
  hotelReservationIsWatchable,
  hotelSavedSearchName,
  hotelSearchRequestFromReservation,
  isHotelRatesConfigured,
  normalizeHotelReservationPayload,
  runHotelSavedSearch,
  waitForHotelJob
} from "../../packages/integrations/hotel-rates.mjs";
import {
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  normalizePlaidAccount,
  normalizePlaidTransaction,
  normalizeRemovedPlaidTransaction,
  syncPlaidTransactions,
  verifyPlaidWebhook
} from "../../packages/integrations/plaid.mjs";
import {
  applyHotelRateWatch,
  applyPlaidSync,
  dashboardStorePath,
  findHermesActionByIdempotencyKey,
  listAppItems,
  listPlaidItems,
  loadDashboard,
  patchHermesAction,
  patchHotelReservation,
  upsertAppItem,
  upsertPlaidItem,
  upsertHotelReservation,
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
const hotelRateFinderConfig = hotelRatesConfig();

async function dashboardSnapshot() {
  const dashboard = await loadDashboard(dashboardFixture(), storePath);
  const registry = await pluginRegistry();
  const registryItems = registry.apps.flatMap((app) =>
    genericAppItemsFromDashboard(dashboard, app.id)
  );
  return {
    ...dashboard,
    apps: {
      manifests: registry.apps,
      panels: registry.panels,
      items: [...registryItems, ...(dashboard.apps?.items ?? [])]
    },
    hermes: {
      ...dashboard.hermes,
      capabilities: registry.capabilities.length
        ? registry.capabilities
        : dashboard.hermes.capabilities
    }
  };
}

async function pluginRegistry() {
  return loadPluginRegistry(root);
}

async function enabledHermesCapabilities() {
  const registry = await pluginRegistry();
  return registry.capabilities.length ? registry.capabilities : hermesCapabilities();
}

async function appItems(appId, { type } = {}) {
  const dashboard = await dashboardSnapshot();
  const projectedItems = genericAppItemsFromDashboard(dashboard, appId);
  const overlayItems = await listAppItems(storePath, { app: appId, type });
  return [...projectedItems, ...overlayItems].filter((item) => !type || item.type === type);
}

function activeHotelRateReservations(dashboard, { reservationId } = {}) {
  return dashboard.travel.reservations.filter(
    (reservation) =>
      (!reservationId || reservation.id === reservationId) &&
      reservation.refundable !== false &&
      hotelReservationIsWatchable(reservation)
  );
}

async function ensureHotelSavedSearch(reservation) {
  const existingSavedSearchId =
    reservation.hotelRateFinder?.savedSearchId ??
    reservation.savedSearchId ??
    reservation.saved_search_id;
  if (existingSavedSearchId) {
    return { reservation, savedSearchId: existingSavedSearchId, created: false };
  }

  const savedSearch = await createHotelSavedSearch(
    {
      name: hotelSavedSearchName(reservation),
      request: hotelSearchRequestFromReservation(reservation)
    },
    { config: hotelRateFinderConfig }
  );
  if (!savedSearch.ok) {
    return {
      reservation,
      savedSearchId: undefined,
      created: false,
      error: savedSearch.body,
      statusCode: savedSearch.status
    };
  }

  const savedSearchId = savedSearch.body.id;
  const updatedReservation = {
    ...reservation,
    hotelRateFinder: {
      ...(reservation.hotelRateFinder ?? {}),
      savedSearchId,
      request: savedSearch.body.request,
      savedAt: new Date().toISOString()
    }
  };
  await patchHotelReservation(storePath, reservation.id, {
    hotelRateFinder: updatedReservation.hotelRateFinder
  });
  return { reservation: updatedReservation, savedSearchId, created: true };
}

async function runHotelRateReservation(reservation, { forceRefresh } = {}) {
  const savedSearch = await ensureHotelSavedSearch(reservation);
  if (!savedSearch.savedSearchId) {
    return {
      reservationId: reservation.id,
      synced: false,
      reason: "saved_search_failed",
      statusCode: savedSearch.statusCode,
      response: savedSearch.error
    };
  }

  const run = await runHotelSavedSearch(
    savedSearch.savedSearchId,
    { forceRefresh: forceRefresh ?? hotelRateFinderConfig.forceRefresh },
    { config: hotelRateFinderConfig }
  );
  if (!run.ok) {
    return {
      reservationId: reservation.id,
      savedSearchId: savedSearch.savedSearchId,
      synced: false,
      reason: "run_failed",
      statusCode: run.status,
      response: run.body
    };
  }

  const jobId = run.body.job_id ?? run.body.id;
  if (!jobId) {
    return {
      reservationId: reservation.id,
      savedSearchId: savedSearch.savedSearchId,
      synced: false,
      reason: "missing_job_id",
      response: run.body
    };
  }
  const jobResponse = await waitForHotelJob(jobId, { config: hotelRateFinderConfig });
  const { watch } = hotelRateWatchFromJobResponse(savedSearch.reservation, jobId, jobResponse, {
    priceDropThreshold: hotelRateFinderConfig.priceDropThreshold
  });
  const alerts = [
    hotelRateDropAlert(savedSearch.reservation, watch),
    hotelRateFailureAlert(savedSearch.reservation, watch)
  ];
  await applyHotelRateWatch(storePath, savedSearch.reservation, watch, alerts);
  return {
    reservationId: reservation.id,
    savedSearchId: savedSearch.savedSearchId,
    jobId,
    synced: jobResponse.ok && !jobResponse.timedOut && watch.status !== "failed",
    timedOut: jobResponse.timedOut,
    status: watch.status,
    watch
  };
}

async function syncHotelRateReservations({ reservationId, forceRefresh } = {}) {
  if (!isHotelRatesConfigured(hotelRateFinderConfig)) {
    return {
      synced: false,
      reason: "missing_hotel_rate_finder_api_base_url",
      reservationCount: 0,
      results: []
    };
  }

  const reservations = activeHotelRateReservations(await dashboardSnapshot(), { reservationId });
  if (reservations.length === 0) {
    return {
      synced: false,
      reason: reservationId
        ? "reservation_not_found_or_not_watchable"
        : "no_watchable_reservations",
      reservationCount: 0,
      results: []
    };
  }
  const results = [];
  for (const reservation of reservations) {
    results.push(await runHotelRateReservation(reservation, { forceRefresh }));
  }
  return {
    synced: results.every((result) => result.synced),
    reservationCount: reservations.length,
    results
  };
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
  if (selectedItems.length === 0) {
    return {
      synced: false,
      reason: itemId ? "plaid_item_not_found" : "no_plaid_items",
      itemCount: 0,
      results: []
    };
  }
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

async function dispatchHermesAction(action, capability) {
  if (capability?.kind === "deterministic") {
    return dispatchDeterministicCapability(action, capability);
  }

  if (action.origin === "hermes") {
    return { dispatched: false, reason: "hermes_origin_loop_guard" };
  }

  const dispatch = await createHermesBridgeRun(action);
  if (dispatch.dispatched && dispatch.runId) {
    queueMicrotask(() => {
      streamBridgeRunOntoAction(action, dispatch.runId);
    });
  }
  return dispatch;
}

async function dispatchDeterministicCapability(action, capability) {
  if (capability.endpoint === "/api/integrations/plaid/sync") {
    const response = await syncPlaidItems({
      itemId: action.payload.itemId ?? action.payload.item_id
    });
    return { dispatched: response.synced, target: capability.target, response };
  }
  if (capability.endpoint === "/api/integrations/hotel-rate-finder/sync") {
    const response = await syncHotelRateReservations({
      reservationId: action.payload.reservationId ?? action.payload.reservation_id,
      forceRefresh: action.payload.forceRefresh ?? action.payload.force_refresh
    });
    return { dispatched: response.synced, target: capability.target, response };
  }
  if (action.capabilityId !== "asia_deal_verify") {
    return { dispatched: false, reason: "unsupported_deterministic_capability" };
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
    target: capability.target,
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

function jsonFromBridge(response, result) {
  json(response, result.status, {
    ok: result.ok,
    status: result.status,
    bridge: result.body
  });
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function bridgeProxyBody(upstreamResponse, contentType) {
  if (contentType.includes("application/json")) {
    return upstreamResponse.json().catch(async () => ({ raw: await upstreamResponse.text() }));
  }
  return upstreamResponse.text();
}

async function pipeBridgeEventStream(response, runId) {
  const abortController = new AbortController();
  response.on("close", () => {
    abortController.abort();
  });

  const result = await openHermesBridgeRunEvents(runId, { signal: abortController.signal });
  if (!result.response) {
    jsonFromBridge(response, result);
    return;
  }

  if (!result.contentType.includes("text/event-stream") || !result.response.body) {
    json(response, result.status, {
      ok: result.ok,
      status: result.status,
      bridge: await bridgeProxyBody(result.response, result.contentType)
    });
    return;
  }

  response.writeHead(result.status, {
    "Content-Type": result.contentType,
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": `http://127.0.0.1:${webPort}`,
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Idempotency-Key, X-Hermes-Signature",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });

  try {
    for await (const chunk of result.response.body) {
      if (response.destroyed) {
        break;
      }
      response.write(chunk);
    }
  } catch (error) {
    if (!abortController.signal.aborted) {
      throw error;
    }
  } finally {
    if (!response.destroyed) {
      response.end();
    }
  }
}

function requireHermesAuth(request, response, { apiToken = hermesApiToken } = {}) {
  if (!apiToken) {
    return true;
  }

  if (request.headers.authorization === `Bearer ${apiToken}`) {
    return true;
  }

  error(response, 401, "unauthorized", "Missing or invalid Hermes API bearer token.");
  return false;
}

async function requirePlaidWebhookAuth(request, response, rawBody) {
  if (request.headers.authorization === `Bearer ${hermesApiToken}`) {
    return true;
  }

  const verification = await verifyPlaidWebhook(rawBody, request.headers["plaid-verification"]);
  if (verification.ok) {
    return true;
  }

  if (!hermesApiToken && !request.headers["plaid-verification"]) {
    return true;
  }

  error(response, 401, "unauthorized", "Missing or invalid Plaid webhook verification.");
  return false;
}

async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(rawBody) {
  const raw = rawBody.toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function readJson(request) {
  return parseJson(await readRawBody(request));
}

async function packageInfo() {
  const raw = await readFile(join(root, "package.json"), "utf8");
  return JSON.parse(raw);
}

export function createApiServer({ apiToken = hermesApiToken } = {}) {
  const requireAuth = (request, response) => requireHermesAuth(request, response, { apiToken });

  return http.createServer(async (request, response) => {
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
        const registry = await pluginRegistry();
        json(response, 200, { integrations: integrationCatalog(), apps: registry.apps });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/apps") {
        const registry = await pluginRegistry();
        json(response, 200, {
          apps: registry.apps,
          panels: registry.panels
        });
        return;
      }

      const appItemsMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/items$/);
      if (request.method === "GET" && appItemsMatch) {
        json(response, 200, {
          app: appItemsMatch[1],
          items: await appItems(appItemsMatch[1], { type: url.searchParams.get("type") })
        });
        return;
      }

      const appEventsMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/events$/);
      if (request.method === "POST" && appEventsMatch) {
        if (!requireAuth(request, response)) {
          return;
        }
        const payload = await readJson(request);
        const item = {
          app: appEventsMatch[1],
          type: payload.type ?? "event",
          externalId: payload.externalId ?? payload.external_id ?? payload.id,
          status: payload.status ?? "active",
          title: payload.title,
          detail: payload.detail,
          payload: payload.payload ?? payload
        };
        await upsertAppItem(storePath, item);
        json(response, 202, {
          accepted: true,
          item
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/travel") {
        json(response, 200, (await dashboardSnapshot()).travel);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/travel/reservations") {
        if (!requireAuth(request, response)) {
          return;
        }
        const payload = await readJson(request);
        const reservation = normalizeHotelReservationPayload(payload);
        await upsertHotelReservation(storePath, reservation);
        json(response, 202, {
          accepted: true,
          reservation
        });
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
        if (!requireAuth(request, response)) {
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
        if (!requireAuth(request, response)) {
          return;
        }
        const payload = await readJson(request);
        if (!payload.publicToken && !payload.public_token) {
          error(response, 400, "missing_public_token", "Plaid public token is required.");
          return;
        }
        const exchange = await exchangePlaidPublicToken(
          payload.publicToken ?? payload.public_token
        );
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
        if (!requireAuth(request, response)) {
          return;
        }
        const payload = await readJson(request);
        const result = await syncPlaidItems({ itemId: payload.itemId ?? payload.item_id });
        json(response, result.synced ? 202 : 207, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/integrations/plaid/webhook") {
        const rawBody = await readRawBody(request);
        if (!(await requirePlaidWebhookAuth(request, response, rawBody))) {
          return;
        }
        const payload = parseJson(rawBody);
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

      if (
        request.method === "POST" &&
        url.pathname === "/api/integrations/hotel-rate-finder/sync"
      ) {
        if (!requireAuth(request, response)) {
          return;
        }
        const payload = await readJson(request);
        const result = await syncHotelRateReservations({
          reservationId: payload.reservationId ?? payload.reservation_id,
          forceRefresh: payload.forceRefresh ?? payload.force_refresh
        });
        json(response, result.synced ? 202 : 503, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/hermes/context") {
        if (!requireAuth(request, response)) {
          return;
        }
        json(response, 200, hermesContextFromDashboard(await dashboardSnapshot()));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/hermes/capabilities") {
        if (!requireAuth(request, response)) {
          return;
        }
        json(response, 200, { capabilities: await enabledHermesCapabilities() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/hermes/bridge/capabilities") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await getHermesBridgeCapabilities();
        json(response, result.status, {
          ok: result.ok,
          status: result.status,
          configured: hermesBridgeStatus().configured,
          bridge: result.body
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/hermes/bridge/runs") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await startHermesBridgeRun(await readJson(request), {
          idempotencyKey: firstHeaderValue(request.headers["idempotency-key"])
        });
        jsonFromBridge(response, result);
        return;
      }

      const bridgeRunMatch = url.pathname.match(/^\/api\/hermes\/bridge\/runs\/([^/]+)$/);
      if (request.method === "GET" && bridgeRunMatch) {
        if (!requireAuth(request, response)) {
          return;
        }
        jsonFromBridge(response, await getHermesBridgeRun(bridgeRunMatch[1]));
        return;
      }

      const bridgeRunEventsMatch = url.pathname.match(
        /^\/api\/hermes\/bridge\/runs\/([^/]+)\/events$/
      );
      if (request.method === "GET" && bridgeRunEventsMatch) {
        if (!requireAuth(request, response)) {
          return;
        }
        await pipeBridgeEventStream(response, bridgeRunEventsMatch[1]);
        return;
      }

      const bridgeRunApprovalMatch = url.pathname.match(
        /^\/api\/hermes\/bridge\/runs\/([^/]+)\/approval$/
      );
      if (request.method === "POST" && bridgeRunApprovalMatch) {
        if (!requireAuth(request, response)) {
          return;
        }
        jsonFromBridge(
          response,
          await approveHermesBridgeRun(bridgeRunApprovalMatch[1], await readJson(request))
        );
        return;
      }

      const bridgeRunStopMatch = url.pathname.match(/^\/api\/hermes\/bridge\/runs\/([^/]+)\/stop$/);
      if (request.method === "POST" && bridgeRunStopMatch) {
        if (!requireAuth(request, response)) {
          return;
        }
        jsonFromBridge(
          response,
          await stopHermesBridgeRun(bridgeRunStopMatch[1], await readJson(request))
        );
        return;
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/api/hermes/actions" ||
          url.pathname === "/api/integrations/hermes/actions")
      ) {
        if (!requireAuth(request, response)) {
          return;
        }
        const payload = await readJson(request);
        if (!payload.idempotencyKey && request.headers["idempotency-key"]) {
          payload.idempotencyKey = request.headers["idempotency-key"];
        }
        const idempotencyLookupKey = payload.idempotencyKey ?? payload.id;
        const existingAction = await findHermesActionByIdempotencyKey(
          storePath,
          idempotencyLookupKey
        );
        if (existingAction) {
          json(response, 202, {
            accepted: true,
            deduped: true,
            action: existingAction,
            dispatch: existingAction.dispatch ?? { dispatched: false, reason: "already_dispatched" }
          });
          return;
        }
        const capabilityId = payload.capabilityId ?? payload.action;
        const capability = (await enabledHermesCapabilities()).find(
          (item) => item.id === capabilityId
        );
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
        action = {
          ...action,
          target: capability.target,
          title:
            payload.title ??
            capability.title ??
            (action.title === "Unknown Hermes action" ? capability.id : action.title)
        };
        let dispatch;
        try {
          dispatch = await dispatchHermesAction(action, capability);
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
        if (!requireAuth(request, response)) {
          return;
        }
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
        if (!requireAuth(request, response)) {
          return;
        }
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
}

const server = createApiServer();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, "127.0.0.1", () => {
    console.log(`Personal Dashboard API listening on http://127.0.0.1:${port}`);
  });
}
