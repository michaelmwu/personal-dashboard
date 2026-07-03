export const DASHBOARD_CONTRACT_VERSION = "dashboard.v1";
export const HERMES_ACTION_VERSION = "hermes-action.v1";

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
  card,
  status,
  accountId,
  date,
  authorizedDate,
  pendingTransactionId,
  source
}) {
  return {
    id,
    merchant,
    amount,
    category,
    card,
    status,
    accountId,
    date,
    authorizedDate,
    pendingTransactionId,
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

export function hotelRateWatch({
  id,
  property,
  location,
  checkIn,
  checkOut,
  targetRate,
  bestRate,
  source,
  status
}) {
  return { id, property, location, checkIn, checkOut, targetRate, bestRate, source, status };
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

export function reservation({ id, type, title, dates, source, status }) {
  return { id, type, title, dates, source, status };
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
    hermes,
    integrations
  };
}
