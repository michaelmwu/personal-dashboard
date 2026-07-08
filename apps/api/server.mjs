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
  applyPrStatus,
  applyCodingTaskControl,
  archiveCodingTask,
  codingTaskMissionApproved,
  codingAgentPolicyFromEnv,
  codingTaskItem,
  enqueueCodingTaskItems,
  normalizeCodingAgentSignal,
  normalizeCodingAgentFinding,
  normalizeCodingTaskMission,
  normalizeCodingAgentRegressionMemory,
  pickupExistingPrTask,
  planCodingAgentGoalMutation,
  planCodingTaskIntake,
  planCodingTaskQueue,
  planPrMaintenance,
  proposeCodingAgentGoalMutations,
  reconcileCodingAgentTasks,
  reviewCodingAgentRisk,
  shortRepoName,
  summarizeCodingTaskHandoff,
  synthesizeCodingAgentFindings,
  triageCodingAgentIssue,
  updateCodingTaskCoordination,
  visibleCodingTasks
} from "../../packages/integrations/coding-agent.mjs";
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
const codingAgentPolicy = codingAgentPolicyFromEnv();

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

async function codingTaskItems() {
  return listAppItems(storePath, { app: "coding-agent", type: "coding-task" });
}

async function codingFindingItems() {
  return listAppItems(storePath, { app: "coding-agent", type: "coding-improvement-finding" });
}

async function findCodingTask(payload) {
  const taskId = payload.taskId ?? payload.task_id ?? payload.id;
  const prNumber = payload.prNumber ?? payload.pr_number;
  const repo = payload.repo;
  const githubRepo = payload.githubRepo ?? payload.github_repo;
  const shortRepo = shortRepoName(repo ?? githubRepo);
  return (await codingTaskItems()).find(
    (item) =>
      (taskId && item.id === taskId) ||
      (prNumber &&
        (repo || githubRepo) &&
        (item.payload?.repo === repo ||
          item.payload?.repo === shortRepo ||
          item.payload?.githubRepo === githubRepo ||
          item.payload?.githubRepo === repo) &&
        item.payload?.prNumber === prNumber)
  );
}

async function findCodingFinding(payload) {
  const findingId =
    payload.findingId ?? payload.finding_id ?? payload.sourceFindingId ?? payload.source_finding_id;
  if (!findingId) {
    return undefined;
  }
  return (await codingFindingItems()).find((item) => item.id === findingId);
}

async function persistCodingTaskItem(item) {
  await upsertAppItem(storePath, item);
  return item;
}

async function registerCodingTask(payload) {
  if (!payload.repo) {
    return { ok: false, statusCode: 400, reason: "missing_repo" };
  }
  const item = codingTaskItem(payload);
  await upsertAppItem(storePath, item);
  return { ok: true, statusCode: 202, task: item.payload, item };
}

async function planCodingTask(payload) {
  const result = planCodingTaskIntake(payload);
  await persistCodingTaskItem(result.taskItem);
  return result;
}

async function planCodingQueue(payload) {
  const result = planCodingTaskQueue(payload, await codingTaskItems());
  await persistCodingTaskItem(result.taskItem);
  return result;
}

async function pickupCodingPr(payload) {
  const existing = await findCodingTask(payload);
  const result = pickupExistingPrTask(existing, payload, codingAgentPolicy);
  if (result.pickupAttemptItem) {
    await upsertAppItem(storePath, result.pickupAttemptItem);
  }
  if (!result.ok) {
    return result;
  }
  await persistCodingTaskItem(result.taskItem);
  return result;
}

async function triageCodingIssue(payload) {
  const result = triageCodingAgentIssue(payload, codingAgentPolicy);
  await upsertAppItem(storePath, result.item);
  return result;
}

async function reviewCodingRisk(payload) {
  const item = reviewCodingAgentRisk(payload);
  await upsertAppItem(storePath, item);
  return {
    ok: item.status === "approved",
    statusCode: item.status === "approved" ? 202 : 409,
    riskReview: item.payload,
    item
  };
}

async function recordCodingSignal(payload) {
  const item = normalizeCodingAgentSignal(payload);
  await upsertAppItem(storePath, item);
  return { ok: true, statusCode: 202, signal: item.payload, item };
}

async function recordCodingFinding(payload) {
  const item = normalizeCodingAgentFinding(payload);
  await upsertAppItem(storePath, item);
  return { ok: true, statusCode: 202, finding: item.payload, item };
}

async function recordCodingRegressionMemory(payload) {
  const item = normalizeCodingAgentRegressionMemory(payload);
  await upsertAppItem(storePath, item);
  return { ok: true, statusCode: 202, memory: item.payload, item };
}

async function synthesizeCodingFindings(payload = {}) {
  const signals = await listAppItems(storePath, {
    app: "coding-agent",
    type: "coding-improvement-signal"
  });
  const findings = synthesizeCodingAgentFindings(signals, {
    minimumSignals: payload.minimumSignals ?? payload.minimum_signals
  });
  for (const finding of findings) {
    await upsertAppItem(storePath, finding);
  }
  return { ok: true, statusCode: 202, findings: findings.map((item) => item.payload) };
}

async function planCodingGoalMutation(payload = {}) {
  const findingItem = await findCodingFinding(payload);
  const input = findingItem ? { ...payload, finding: findingItem.payload } : payload;
  const results =
    input.propose || (!input.action && input.finding)
      ? proposeCodingAgentGoalMutations(input)
      : [planCodingAgentGoalMutation(input)];
  for (const result of results) {
    if (result.mutationItem) {
      await upsertAppItem(storePath, result.mutationItem);
    }
  }
  const blocked = results.some((result) => result.blocked);
  const failed = results.find((result) => !result.mutationItem);
  return {
    ok: !failed && !blocked,
    statusCode: failed?.statusCode ?? (blocked ? 409 : 202),
    reason: failed?.reason ?? results.find((result) => result.reason)?.reason,
    blocked,
    mutations: results.filter((result) => result.mutation).map((result) => result.mutation),
    mutation: results.find((result) => result.mutation)?.mutation
  };
}

async function updateCodingCoordination(payload) {
  const existing = await findCodingTask(payload);
  if (!existing) {
    return { ok: false, statusCode: 404, reason: "coding_task_not_found" };
  }
  const item = updateCodingTaskCoordination(existing, payload);
  await persistCodingTaskItem(item);
  return { ok: true, statusCode: 202, task: item.payload, item };
}

async function applyCodingControl(payload) {
  const existing = await findCodingTask(payload);
  if (!existing) {
    return { ok: false, statusCode: 404, reason: "coding_task_not_found" };
  }
  const result = applyCodingTaskControl(existing, payload);
  if (!result.ok) {
    return result;
  }
  await persistCodingTaskItem(result.taskItem);
  return result;
}

async function syncCodingPrStatus(payload) {
  const existing = await findCodingTask(payload);
  if (!existing) {
    return { ok: false, statusCode: 404, reason: "coding_task_not_found" };
  }
  const item = applyPrStatus(existing, payload);
  await persistCodingTaskItem(item);
  return { ok: true, statusCode: 202, task: item.payload, item };
}

async function enqueueCodingTask(payload) {
  const existing = await findCodingTask(payload);
  if (!existing) {
    return { ok: false, statusCode: 404, reason: "coding_task_not_found" };
  }
  const item = enqueueCodingTaskItems(existing, payload);
  await persistCodingTaskItem(item);
  return { ok: true, statusCode: 202, task: item.payload, item };
}

async function reconcileCodingTasks(payload = {}) {
  const result = reconcileCodingAgentTasks(await codingTaskItems(), payload);
  for (const item of result.taskItems) {
    await persistCodingTaskItem(item);
  }
  await upsertAppItem(storePath, result.auditItem);
  return result;
}

async function summarizeCodingHandoff(payload = {}) {
  const existing = await findCodingTask(payload);
  const result = summarizeCodingTaskHandoff(existing, payload);
  if (!result.ok) {
    return result;
  }
  await upsertAppItem(storePath, result.item);
  return result;
}

async function runCodingPrMaintenance(payload) {
  const existing = await findCodingTask(payload);
  if (!existing) {
    return { ok: false, statusCode: 404, reason: "coding_task_not_found" };
  }
  const result = planPrMaintenance(existing, payload, codingAgentPolicy);
  await persistCodingTaskItem(result.taskItem);
  return {
    ok: !result.rejected,
    statusCode: result.rejected ? 400 : result.blocked ? 409 : 202,
    task: result.taskItem.payload,
    maintenance: result.maintenance,
    blocked: result.blocked,
    rejected: result.rejected,
    reason: result.rejected
      ? result.maintenance.find((item) => item.status === "rejected")?.rejectionReason
      : undefined
  };
}

async function archiveCodingTaskByPayload(payload) {
  const existing = await findCodingTask(payload);
  if (!existing) {
    return { ok: false, statusCode: 404, reason: "coding_task_not_found" };
  }
  const item = archiveCodingTask(existing, payload);
  await persistCodingTaskItem(item);
  return { ok: true, statusCode: 202, task: item.payload, item };
}

async function recordCodingTaskHermesRun(action, dispatch) {
  const taskId = action.payload?.taskId ?? action.payload?.task_id;
  if (!taskId || !dispatch.runId) {
    return;
  }
  const existing = await findCodingTask({ taskId });
  if (!existing) {
    return;
  }
  await persistCodingTaskItem(
    codingTaskItem(
      {
        hermesRunId: dispatch.runId,
        latestHermesRunId: dispatch.runId,
        hermesRunStatus: "running"
      },
      existing
    )
  );
}

async function guardCodingTaskStartMission(action) {
  const taskId = action.payload?.taskId ?? action.payload?.task_id;
  const existing = taskId ? await findCodingTask({ taskId }) : undefined;
  const mission =
    existing?.payload?.mission ??
    normalizeCodingTaskMission(action.payload ?? {}, codingAgentPolicy).mission;
  if (!codingTaskMissionApproved(mission)) {
    return {
      ok: false,
      reason: "mission_approval_required",
      mission
    };
  }
  return { ok: true, mission };
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

  if (action.capabilityId === "start-coding-task") {
    const missionGuard = await guardCodingTaskStartMission(action);
    if (!missionGuard.ok) {
      return {
        dispatched: false,
        target: "coding-agent",
        reason: missionGuard.reason,
        mission: missionGuard.mission
      };
    }
  }

  const dispatch = await createHermesBridgeRun(action);
  if (dispatch.dispatched && dispatch.runId) {
    await recordCodingTaskHermesRun(action, dispatch);
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
  if (capability.endpoint === "/api/apps/coding-agent/tasks") {
    const response = await registerCodingTask(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/intake-plan") {
    const response = await planCodingTask(action.payload);
    return {
      dispatched: response.ok && !response.blocked,
      target: capability.target,
      response
    };
  }
  if (capability.endpoint === "/api/apps/coding-agent/queue-plan") {
    const response = await planCodingQueue(action.payload);
    return {
      dispatched: response.ok && !response.blocked,
      target: capability.target,
      response
    };
  }
  if (capability.endpoint === "/api/apps/coding-agent/pr-pickup") {
    const response = await pickupCodingPr(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/issue-triage") {
    const response = await triageCodingIssue(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/pr-status") {
    const response = await syncCodingPrStatus(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/queue") {
    const response = await enqueueCodingTask(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/reconcile") {
    const response = await reconcileCodingTasks(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/handoff-summary") {
    const response = await summarizeCodingHandoff(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/pr-maintenance") {
    const response = await runCodingPrMaintenance(action.payload);
    return {
      dispatched: response.ok && !response.blocked,
      target: capability.target,
      response
    };
  }
  if (capability.endpoint === "/api/apps/coding-agent/risk-review") {
    const response = await reviewCodingRisk(action.payload);
    return {
      dispatched: response.ok,
      target: capability.target,
      response
    };
  }
  if (capability.endpoint === "/api/apps/coding-agent/signals") {
    const response = await recordCodingSignal(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/findings") {
    const response = action.payload?.synthesize
      ? await synthesizeCodingFindings(action.payload)
      : await recordCodingFinding(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/regression-memory") {
    const response = await recordCodingRegressionMemory(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/goal-mutations") {
    const response = await planCodingGoalMutation(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/coordination") {
    const response = await updateCodingCoordination(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/control") {
    const response = await applyCodingControl(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
  }
  if (capability.endpoint === "/api/apps/coding-agent/archive") {
    const response = await archiveCodingTaskByPayload(action.payload);
    return { dispatched: response.ok, target: capability.target, response };
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
    if (!abortController.signal.aborted && !response.headersSent) {
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

async function requirePlaidWebhookAuth(
  request,
  response,
  rawBody,
  { apiToken = hermesApiToken } = {}
) {
  if (request.headers.authorization === `Bearer ${apiToken}`) {
    return true;
  }

  const verification = await verifyPlaidWebhook(rawBody, request.headers["plaid-verification"]);
  if (verification.ok) {
    return true;
  }

  if (!apiToken && !request.headers["plaid-verification"]) {
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

      if (request.method === "GET" && url.pathname === "/api/apps/coding-agent/tasks") {
        json(response, 200, {
          tasks: visibleCodingTasks(await codingTaskItems(), {
            includeArchived: url.searchParams.get("includeArchived") === "true",
            status: url.searchParams.get("status")
          }).map((item) => item.payload)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/tasks") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await registerCodingTask(await readJson(request));
        if (!result.ok) {
          error(response, result.statusCode, result.reason, "Coding task repo is required.");
          return;
        }
        json(response, result.statusCode, {
          accepted: true,
          task: result.task
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/intake-plan") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await planCodingTask(await readJson(request));
        json(response, result.statusCode, {
          accepted: true,
          blocked: result.blocked,
          plan: result.plan,
          task: result.task
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/queue-plan") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await planCodingQueue(await readJson(request));
        json(response, result.statusCode, {
          accepted: true,
          blocked: result.blocked,
          duplicateCandidates: result.duplicateCandidates,
          priority: result.priority,
          workspacePolicy: result.workspacePolicy,
          plan: result.plan,
          task: result.task
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/pr-pickup") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await pickupCodingPr(await readJson(request));
        if (!result.ok) {
          error(response, result.statusCode, result.reason, "Existing PR pickup rejected.");
          return;
        }
        json(response, result.statusCode, {
          accepted: true,
          task: result.task
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/issue-triage") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await triageCodingIssue(await readJson(request));
        json(response, result.statusCode, {
          accepted: result.ok,
          blocked: result.blocked,
          reason: result.reason,
          triage: result.triage
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/coordination") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await updateCodingCoordination(await readJson(request));
        if (!result.ok) {
          error(response, result.statusCode, result.reason, "Registered coding task not found.");
          return;
        }
        json(response, result.statusCode, {
          accepted: true,
          task: result.task
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/control") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await applyCodingControl(await readJson(request));
        if (!result.ok) {
          error(response, result.statusCode, result.reason, "Coding task control rejected.");
          return;
        }
        json(response, result.statusCode, {
          accepted: true,
          control: result.control,
          task: result.task
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/risk-review") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await reviewCodingRisk(await readJson(request));
        json(response, result.statusCode, {
          accepted: result.ok,
          riskReview: result.riskReview
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/signals") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await recordCodingSignal(await readJson(request));
        json(response, result.statusCode, {
          accepted: true,
          signal: result.signal
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/findings") {
        if (!requireAuth(request, response)) {
          return;
        }
        const payload = await readJson(request);
        const result = payload.synthesize
          ? await synthesizeCodingFindings(payload)
          : await recordCodingFinding(payload);
        json(response, result.statusCode, {
          accepted: true,
          finding: result.finding,
          findings: result.findings
        });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/apps/coding-agent/regression-memory"
      ) {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await recordCodingRegressionMemory(await readJson(request));
        json(response, result.statusCode, {
          accepted: true,
          memory: result.memory
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/goal-mutations") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await planCodingGoalMutation(await readJson(request));
        if (result.reason && !result.mutations.length) {
          error(response, result.statusCode, result.reason, "Goal mutation rejected.");
          return;
        }
        json(response, result.statusCode, {
          accepted: result.ok,
          blocked: result.blocked,
          mutation: result.mutation,
          mutations: result.mutations
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/queue") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await enqueueCodingTask(await readJson(request));
        if (!result.ok) {
          error(response, result.statusCode, result.reason, "Registered coding task not found.");
          return;
        }
        json(response, result.statusCode, {
          accepted: true,
          task: result.task
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/pr-status") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await syncCodingPrStatus(await readJson(request));
        if (!result.ok) {
          error(response, result.statusCode, result.reason, "Registered coding task not found.");
          return;
        }
        json(response, result.statusCode, {
          accepted: true,
          task: result.task
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/reconcile") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await reconcileCodingTasks(await readJson(request));
        json(response, result.statusCode, {
          accepted: true,
          reconciled: result.reconciled,
          results: result.results,
          audit: result.auditItem.payload
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/handoff-summary") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await summarizeCodingHandoff(await readJson(request));
        if (!result.ok) {
          error(response, result.statusCode, result.reason, "Registered coding task not found.");
          return;
        }
        json(response, result.statusCode, {
          accepted: true,
          summary: result.summary
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/pr-maintenance") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await runCodingPrMaintenance(await readJson(request));
        if (!result.ok && result.rejected) {
          error(response, result.statusCode, result.reason, "PR maintenance guardrail rejected.");
          return;
        }
        json(response, result.statusCode, {
          accepted: !result.rejected,
          blocked: result.blocked,
          task: result.task,
          maintenance: result.maintenance
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/apps/coding-agent/archive") {
        if (!requireAuth(request, response)) {
          return;
        }
        const result = await archiveCodingTaskByPayload(await readJson(request));
        if (!result.ok) {
          error(response, result.statusCode, result.reason, "Registered coding task not found.");
          return;
        }
        json(response, result.statusCode, {
          accepted: true,
          task: result.task
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
        if (!(await requirePlaidWebhookAuth(request, response, rawBody, { apiToken }))) {
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
