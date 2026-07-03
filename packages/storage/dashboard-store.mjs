import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  await writeFile(filePath, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
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
