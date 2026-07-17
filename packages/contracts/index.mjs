export const DASHBOARD_CONTRACT_VERSION = "dashboard.v1";
export const HERMES_ACTION_VERSION = "hermes-action.v1";
export const DASHBOARD_APP_MANIFEST_VERSION = "dashboard-app.v1";
export const HOST_DASHBOARD_SUMMARY_VERSION = "host-dashboard-summary.v1";

const HOST_DASHBOARD_DEFAULT_LIMIT = 6;

function hostDashboardString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function hostDashboardList(value) {
  return Array.isArray(value) ? value : [];
}

function hostDashboardObject(value) {
  return value && typeof value === "object" ? value : {};
}

function hostDashboardDetail(...parts) {
  return parts
    .map((part) => hostDashboardString(part))
    .filter(Boolean)
    .join(" · ");
}

function hostDashboardItem({ id, kind, title, detail, status, source, priority }) {
  return {
    id: hostDashboardString(id, `${kind}-unknown`),
    kind,
    title: hostDashboardString(title, "Untitled item"),
    detail: hostDashboardString(detail),
    status: hostDashboardString(status, "unknown"),
    source: hostDashboardString(source),
    priority: hostDashboardString(priority)
  };
}

/**
 * A deliberately compact, read-only projection for trusted host dashboards.
 *
 * Keep this contract separate from dashboard.v1: host adapters need enough
 * context to render useful status, but never the full account, transaction,
 * action, or token-bearing dashboard payload.
 */
export function hostDashboardSummary(
  dashboard = {},
  { limit = HOST_DASHBOARD_DEFAULT_LIMIT } = {}
) {
  const sourceDashboard = hostDashboardObject(dashboard);
  const itemLimit = Number.isInteger(limit) && limit > 0 ? limit : HOST_DASHBOARD_DEFAULT_LIMIT;
  const travel = hostDashboardObject(sourceDashboard.travel);
  const appItems = hostDashboardList(sourceDashboard.apps?.items);

  const travelItems = [
    ...hostDashboardList(travel.reservations).map((rawReservation) => {
      const reservation = hostDashboardObject(rawReservation);
      return hostDashboardItem({
        id: reservation.id,
        kind: "reservation",
        title: reservation.title,
        detail: hostDashboardDetail(reservation.dates, reservation.type),
        status: reservation.status,
        source: reservation.source
      });
    }),
    ...hostDashboardList(travel.hotelWatches).map((rawWatch) => {
      const watch = hostDashboardObject(rawWatch);
      return hostDashboardItem({
        id: watch.id,
        kind: "hotel-watch",
        title: watch.property ?? watch.location,
        detail: hostDashboardDetail(
          watch.location,
          watch.checkIn && watch.checkOut ? `${watch.checkIn} to ${watch.checkOut}` : ""
        ),
        status: watch.status,
        source: watch.source
      });
    }),
    ...hostDashboardList(travel.flightWatches).map((rawWatch) => {
      const watch = hostDashboardObject(rawWatch);
      return hostDashboardItem({
        id: watch.id,
        kind: "flight-watch",
        title: watch.route,
        detail: watch.dates,
        status: watch.status,
        source: "flight-watch"
      });
    }),
    ...hostDashboardList(travel.dealFeed).map((rawDeal) => {
      const deal = hostDashboardObject(rawDeal);
      return hostDashboardItem({
        id: deal.id,
        kind: "travel-deal",
        title: deal.title,
        detail: hostDashboardDetail(deal.route, deal.price === undefined ? "" : String(deal.price)),
        status: deal.status,
        source: deal.source
      });
    })
  ].slice(0, itemLimit);

  const taskItems = [
    ...hostDashboardList(sourceDashboard.openclaw?.tasks).map((rawTask) => {
      const task = hostDashboardObject(rawTask);
      return hostDashboardItem({
        id: task.id,
        kind: "openclaw-task",
        title: task.title,
        detail: task.owner,
        status: task.state,
        source: "openclaw",
        priority: task.priority
      });
    }),
    ...appItems
      .map(hostDashboardObject)
      .filter((item) => item.app === "coding-agent" && item.type === "coding-task")
      .map((task) =>
        hostDashboardItem({
          id: task.id,
          kind: "coding-task",
          title: task.title,
          detail: task.detail,
          status: task.status,
          source: task.app
        })
      )
  ].slice(0, itemLimit);

  return {
    version: HOST_DASHBOARD_SUMMARY_VERSION,
    generatedAt: hostDashboardString(sourceDashboard.generatedAt, new Date().toISOString()),
    health: {
      level: hostDashboardString(sourceDashboard.health?.level, "unknown"),
      summary: hostDashboardString(
        sourceDashboard.health?.summary,
        "Dashboard status is unavailable."
      )
    },
    metrics: hostDashboardList(sourceDashboard.metrics)
      .slice(0, itemLimit)
      .map((rawMetricItem) => {
        const metricItem = hostDashboardObject(rawMetricItem);
        return {
          label: hostDashboardString(metricItem.label, "Metric"),
          value: hostDashboardString(String(metricItem.value ?? ""), "—"),
          delta: hostDashboardString(metricItem.delta)
        };
      }),
    alerts: hostDashboardList(sourceDashboard.alerts)
      .slice(0, itemLimit)
      .map((rawAlertItem) => {
        const alertItem = hostDashboardObject(rawAlertItem);
        return {
          id: hostDashboardString(alertItem.id, "alert-unknown"),
          title: hostDashboardString(alertItem.title, "Untitled alert"),
          detail: hostDashboardString(alertItem.detail),
          severity: hostDashboardString(alertItem.severity, "unknown"),
          source: hostDashboardString(alertItem.source)
        };
      }),
    travel: travelItems,
    tasks: taskItems
  };
}

export function metric(label, value, delta) {
  return { label, value, delta };
}

export function alert({ id, title, detail, severity = "low", source = "Hermes" }) {
  return { id, title, detail, severity, source };
}

export function transaction({
  id,
  merchant,
  amount,
  category,
  categoryDetailed,
  categoryConfidence,
  card,
  status,
  accountId,
  date,
  authorizedDate,
  pendingTransactionId,
  paymentChannel,
  pending,
  isoCurrencyCode,
  unofficialCurrencyCode,
  merchantEntityId,
  name,
  logoUrl,
  website,
  location,
  sourceTransactionId,
  source
}) {
  return {
    id,
    merchant,
    amount,
    category,
    categoryDetailed,
    categoryConfidence,
    card,
    status,
    accountId,
    date,
    authorizedDate,
    pendingTransactionId,
    paymentChannel,
    pending,
    isoCurrencyCode,
    unofficialCurrencyCode,
    merchantEntityId,
    name,
    logoUrl,
    website,
    location,
    sourceTransactionId,
    source
  };
}

export function rewardInsight({ id, title, detail, pointsImpact }) {
  return { id, title, detail, pointsImpact };
}

export function openClawTask({ id, title, owner = "OpenClaw", state, priority }) {
  return { id, title, owner, state, priority };
}

export function integrationStatus({ id, name, sourceRepo, adapter, stage, nextStep }) {
  return { id, name, sourceRepo, adapter, stage, nextStep };
}

export function appPanel({
  id,
  appId,
  type,
  title,
  dataSource,
  defaultPosition = "main",
  order = 100,
  enabled = true
}) {
  return { id, appId, type, title, dataSource, defaultPosition, order, enabled };
}

export function appManifest({
  id,
  name,
  version = DASHBOARD_APP_MANIFEST_VERSION,
  baseUrl,
  healthUrl,
  panels = [],
  capabilities = [],
  eventTypes = [],
  deepLink
}) {
  return { id, name, version, baseUrl, healthUrl, panels, capabilities, eventTypes, deepLink };
}

export function appItem({
  id,
  app,
  type,
  externalId,
  ts,
  status = "active",
  title,
  detail,
  payload = {}
}) {
  return { id, app, type, externalId, ts, status, title, detail, payload };
}

export function hotelRateWatch({
  id,
  reservationId,
  property,
  location,
  checkIn,
  checkOut,
  targetRate,
  bestRate,
  currency,
  source,
  status,
  jobId,
  savedSearchId,
  cancellationDeadline,
  cancellationPolicy,
  comparableRate,
  comparisonBasis,
  pointsAlternative,
  error,
  providerErrors
}) {
  return {
    id,
    reservationId,
    property,
    location,
    checkIn,
    checkOut,
    targetRate,
    bestRate,
    currency,
    source,
    status,
    jobId,
    savedSearchId,
    cancellationDeadline,
    cancellationPolicy,
    comparableRate,
    comparisonBasis,
    pointsAlternative,
    error,
    providerErrors
  };
}

export function flightSearchWatch({ id, route, dates, providers, targetPrice, bestPrice, status }) {
  return { id, route, dates, providers, targetPrice, bestPrice, status };
}

export function travelDeal({
  id,
  title,
  route,
  price,
  source,
  confidence,
  status,
  dealGroupId,
  score,
  verificationStatus,
  sourceUrl,
  updatedAt
}) {
  return {
    id,
    title,
    route,
    price,
    source,
    confidence,
    status,
    dealGroupId,
    score,
    verificationStatus,
    sourceUrl,
    updatedAt
  };
}

export function reservation({
  id,
  type,
  title,
  dates,
  source,
  status,
  property,
  location,
  checkIn,
  checkOut,
  confirmationNumber,
  paidRate,
  paidCurrency,
  roomClass,
  cancellationPolicy,
  cancellationDeadline,
  chain,
  propertyId,
  refundable,
  hotelRateFinder
}) {
  return {
    id,
    type,
    title,
    dates,
    source,
    status,
    property,
    location,
    checkIn,
    checkOut,
    confirmationNumber,
    paidRate,
    paidCurrency,
    roomClass,
    cancellationPolicy,
    cancellationDeadline,
    chain,
    propertyId,
    refundable,
    hotelRateFinder
  };
}

export function financeAccount({
  id,
  name,
  kind,
  last4,
  syncStatus,
  institutionName,
  source,
  balance
}) {
  return { id, name, kind, last4, syncStatus, institutionName, source, balance };
}

export function intakeItem({ id, source, title, detail, classification, state, receivedAt }) {
  return { id, source, title, detail, classification, state, receivedAt };
}

export function hermesCapability({ id, title, target, description, inputSchema = {} }) {
  return { id, title, target, description, inputSchema };
}

export function hermesAction({
  id,
  capabilityId,
  target,
  title,
  status,
  origin = "hermes",
  payload = {},
  idempotencyKey,
  createdAt,
  updatedAt,
  dispatch,
  bridgeRunId,
  version = HERMES_ACTION_VERSION
}) {
  return {
    id,
    version,
    idempotencyKey,
    capabilityId,
    target,
    title,
    status,
    origin,
    payload,
    createdAt,
    updatedAt,
    dispatch,
    bridgeRunId
  };
}

export function dashboardContract({
  health,
  metrics,
  alerts,
  transactions,
  rewards,
  openclaw,
  travel = { hotelWatches: [], flightWatches: [], dealFeed: [], reservations: [] },
  finance = { accounts: [], sync: {} },
  intake = { items: [] },
  apps = { manifests: [], panels: [], items: [] },
  hermes = {
    status: "unknown",
    contextEndpoint: "",
    actionEndpoint: "",
    capabilities: [],
    actions: []
  },
  integrations = []
}) {
  return {
    version: DASHBOARD_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    health,
    metrics,
    alerts,
    transactions,
    rewards,
    openclaw,
    travel,
    finance,
    intake,
    apps,
    hermes,
    integrations
  };
}
