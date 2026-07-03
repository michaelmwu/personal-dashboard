import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function emptyOverlay() {
  return {
    alerts: [],
    transactions: [],
    travel: {
      hotelWatches: [],
      flightWatches: [],
      dealFeed: [],
      reservations: []
    },
    finance: {
      accounts: [],
      sync: undefined,
      plaidItems: []
    },
    intake: {
      items: []
    },
    apps: {
      items: []
    },
    hermes: {
      actions: []
    }
  };
}

export function dashboardStorePath(root) {
  return process.env.DASHBOARD_DATA_FILE ?? join(root, ".data", "dashboard-store.json");
}

async function readOverlay(filePath) {
  try {
    return { ...emptyOverlay(), ...JSON.parse(await readFile(filePath, "utf8")) };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return emptyOverlay();
    }
    throw error;
  }
}

async function writeOverlay(filePath, overlay) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function upsertById(items, item) {
  if (!item?.id) {
    return items;
  }
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) {
    return [item, ...items];
  }
  return items.map((candidate, currentIndex) =>
    currentIndex === index ? { ...candidate, ...item } : candidate
  );
}

function mergeById(baseItems, overlayItems) {
  return overlayItems.reduce((items, item) => upsertById(items, item), baseItems);
}

export function mergeDashboardOverlay(baseDashboard, overlay) {
  return {
    ...baseDashboard,
    alerts: mergeById(baseDashboard.alerts, overlay.alerts ?? []),
    transactions: mergeById(baseDashboard.transactions, overlay.transactions ?? []),
    travel: {
      ...baseDashboard.travel,
      hotelWatches: mergeById(
        baseDashboard.travel.hotelWatches,
        overlay.travel?.hotelWatches ?? []
      ),
      flightWatches: mergeById(
        baseDashboard.travel.flightWatches,
        overlay.travel?.flightWatches ?? []
      ),
      dealFeed: mergeById(baseDashboard.travel.dealFeed, overlay.travel?.dealFeed ?? []),
      reservations: mergeById(baseDashboard.travel.reservations, overlay.travel?.reservations ?? [])
    },
    finance: {
      ...baseDashboard.finance,
      sync: overlay.finance?.sync ?? baseDashboard.finance.sync,
      accounts: mergeById(baseDashboard.finance.accounts, overlay.finance?.accounts ?? []),
      plaidItems: overlay.finance?.plaidItems ?? baseDashboard.finance.plaidItems ?? []
    },
    intake: {
      ...baseDashboard.intake,
      items: mergeById(baseDashboard.intake.items, overlay.intake?.items ?? [])
    },
    apps: {
      ...baseDashboard.apps,
      items: mergeById(baseDashboard.apps?.items ?? [], overlay.apps?.items ?? [])
    },
    hermes: {
      ...baseDashboard.hermes,
      actions: mergeById(baseDashboard.hermes.actions, overlay.hermes?.actions ?? [])
    }
  };
}

export async function loadDashboard(baseDashboard, filePath) {
  return mergeDashboardOverlay(baseDashboard, await readOverlay(filePath));
}

export async function upsertNormalizedEvent(filePath, normalized) {
  const overlay = await readOverlay(filePath);
  switch (normalized.kind) {
    case "hotelRateWatch":
      overlay.travel.hotelWatches = upsertById(overlay.travel.hotelWatches, normalized.value);
      break;
    case "flightSearchWatch":
      overlay.travel.flightWatches = upsertById(overlay.travel.flightWatches, normalized.value);
      break;
    case "travelDeal":
      overlay.travel.dealFeed = upsertById(overlay.travel.dealFeed, normalized.value);
      break;
    case "financeAccount":
      overlay.finance.accounts = upsertById(overlay.finance.accounts, normalized.value);
      break;
    case "transaction":
      overlay.transactions = upsertById(overlay.transactions, normalized.value);
      break;
    case "reservation":
      overlay.travel.reservations = upsertById(overlay.travel.reservations, normalized.value);
      break;
    case "intakeItem":
      overlay.intake.items = upsertById(overlay.intake.items, normalized.value);
      break;
    default:
      break;
  }
  await writeOverlay(filePath, overlay);
  return overlay;
}

export async function listPlaidItems(filePath) {
  const overlay = await readOverlay(filePath);
  return overlay.finance.plaidItems ?? [];
}

export async function upsertPlaidItem(filePath, item) {
  const overlay = await readOverlay(filePath);
  overlay.finance.plaidItems = upsertById(overlay.finance.plaidItems ?? [], {
    ...item,
    syncStatus: item.syncStatus ?? "linked",
    updatedAt: item.updatedAt ?? new Date().toISOString()
  });
  await writeOverlay(filePath, overlay);
  return overlay;
}

export async function upsertHotelReservation(filePath, reservation) {
  const overlay = await readOverlay(filePath);
  overlay.travel.reservations = upsertById(overlay.travel.reservations, {
    ...reservation,
    type: "hotel",
    updatedAt: reservation.updatedAt ?? new Date().toISOString()
  });
  await writeOverlay(filePath, overlay);
  return overlay;
}

export async function patchHotelReservation(filePath, reservationId, patch) {
  const overlay = await readOverlay(filePath);
  const existing = overlay.travel.reservations.find(
    (reservation) => reservation.id === reservationId
  );
  overlay.travel.reservations = upsertById(overlay.travel.reservations, {
    ...(existing ?? { id: reservationId, type: "hotel" }),
    ...patch,
    id: reservationId,
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  });
  await writeOverlay(filePath, overlay);
  return overlay;
}

export async function applyHotelRateWatch(filePath, reservation, watch, alerts = []) {
  const overlay = await readOverlay(filePath);
  overlay.travel.hotelWatches = upsertById(overlay.travel.hotelWatches, watch);
  overlay.travel.reservations = upsertById(overlay.travel.reservations, {
    ...reservation,
    hotelRateFinder: {
      ...(reservation.hotelRateFinder ?? {}),
      savedSearchId: watch.savedSearchId,
      lastJobId: watch.jobId,
      lastStatus: watch.status,
      lastCheckedAt: new Date().toISOString()
    },
    status: watch.status === "failed" ? "watch-error" : "watching",
    updatedAt: new Date().toISOString()
  });
  for (const alert of alerts.filter(Boolean)) {
    overlay.alerts = upsertById(overlay.alerts, alert);
  }
  await writeOverlay(filePath, overlay);
  return overlay;
}

export async function listAppItems(filePath, { app, type } = {}) {
  const overlay = await readOverlay(filePath);
  return (overlay.apps.items ?? []).filter(
    (item) => (!app || item.app === app) && (!type || item.type === type)
  );
}

export async function upsertAppItem(filePath, item) {
  const overlay = await readOverlay(filePath);
  const id = item.id ?? `${item.app}:${item.type}:${item.externalId ?? Date.now()}`;
  overlay.apps.items = upsertById(overlay.apps.items ?? [], {
    ...item,
    id,
    ts: item.ts ?? new Date().toISOString()
  });
  await writeOverlay(filePath, overlay);
  return overlay;
}

export async function applyPlaidSync(filePath, itemId, sync) {
  const overlay = await readOverlay(filePath);
  for (const account of sync.accounts ?? []) {
    overlay.finance.accounts = upsertById(overlay.finance.accounts, account);
  }
  for (const item of [...(sync.added ?? []), ...(sync.modified ?? [])]) {
    overlay.transactions = upsertById(overlay.transactions, item);
  }
  for (const item of sync.removed ?? []) {
    overlay.transactions = upsertById(overlay.transactions, item);
  }
  overlay.finance.plaidItems = upsertById(overlay.finance.plaidItems ?? [], {
    id: itemId,
    cursor: sync.cursor,
    syncStatus: sync.synced ? "synced" : "error",
    lastSyncedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  overlay.finance.sync = {
    ...(overlay.finance.sync ?? {}),
    plaid: {
      status: sync.synced ? "synced" : "error",
      itemId,
      added: sync.added?.length ?? 0,
      modified: sync.modified?.length ?? 0,
      removed: sync.removed?.length ?? 0,
      lastSyncedAt: new Date().toISOString()
    }
  };
  await writeOverlay(filePath, overlay);
  return overlay;
}

export async function upsertHermesEvent(filePath, normalized) {
  const overlay = await readOverlay(filePath);
  if (normalized.alert) {
    overlay.alerts = upsertById(overlay.alerts, normalized.alert);
  }
  if (normalized.transaction) {
    overlay.transactions = upsertById(overlay.transactions, normalized.transaction);
  }
  await writeOverlay(filePath, overlay);
  return overlay;
}

export async function upsertHermesAction(filePath, action) {
  const overlay = await readOverlay(filePath);
  overlay.hermes.actions = upsertById(overlay.hermes.actions, action);
  await writeOverlay(filePath, overlay);
  return overlay;
}

export async function findHermesActionByIdempotencyKey(filePath, idempotencyKey) {
  if (!idempotencyKey) {
    return undefined;
  }
  const overlay = await readOverlay(filePath);
  return overlay.hermes.actions.find((action) => action.idempotencyKey === idempotencyKey);
}

export async function patchHermesAction(filePath, actionId, patch) {
  const overlay = await readOverlay(filePath);
  const existing = overlay.hermes.actions.find((action) => action.id === actionId);
  overlay.hermes.actions = upsertById(overlay.hermes.actions, {
    ...(existing ?? { id: actionId }),
    ...patch,
    id: actionId,
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  });
  await writeOverlay(filePath, overlay);
  return overlay;
}
