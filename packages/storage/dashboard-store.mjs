import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const overlayMutationQueues = new Map();
const PLAID_TOKEN_ENCRYPTION_AAD = Buffer.from("personal-dashboard:plaid-access-token:v1", "utf8");

export class PlaidTokenEncryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlaidTokenEncryptionError";
  }
}

export function plaidTokenEncryptionKey(env = process.env) {
  const encoded = String(env.PLAID_TOKEN_ENCRYPTION_KEY ?? "").trim();
  if (!encoded) {
    return undefined;
  }
  let key;
  try {
    key = Buffer.from(encoded, "base64");
  } catch {
    throw new PlaidTokenEncryptionError("PLAID_TOKEN_ENCRYPTION_KEY must be base64-encoded.");
  }
  if (key.length !== 32) {
    throw new PlaidTokenEncryptionError(
      "PLAID_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes."
    );
  }
  return key;
}

function requiredPlaidTokenEncryptionKey(options = {}) {
  const key = options.encryptionKey ?? plaidTokenEncryptionKey(options.env);
  if (!key) {
    throw new PlaidTokenEncryptionError(
      "PLAID_TOKEN_ENCRYPTION_KEY is required before Plaid access tokens can be stored or read."
    );
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new PlaidTokenEncryptionError("Plaid token encryption key must be exactly 32 bytes.");
  }
  return key;
}

export function encryptPlaidAccessToken(accessToken, options = {}) {
  if (!accessToken) {
    return undefined;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", requiredPlaidTokenEncryptionKey(options), iv);
  cipher.setAAD(PLAID_TOKEN_ENCRYPTION_AAD);
  const ciphertext = Buffer.concat([cipher.update(String(accessToken), "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export function decryptPlaidAccessToken(encrypted, options = {}) {
  if (!encrypted) {
    return undefined;
  }
  if (
    encrypted.version !== 1 ||
    encrypted.algorithm !== "aes-256-gcm" ||
    !encrypted.iv ||
    !encrypted.tag ||
    !encrypted.ciphertext
  ) {
    throw new PlaidTokenEncryptionError("Unsupported encrypted Plaid access-token format.");
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      requiredPlaidTokenEncryptionKey(options),
      Buffer.from(encrypted.iv, "base64")
    );
    decipher.setAAD(PLAID_TOKEN_ENCRYPTION_AAD);
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof PlaidTokenEncryptionError) {
      throw error;
    }
    throw new PlaidTokenEncryptionError("Unable to decrypt Plaid access token.");
  }
}

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
      plaidItems: [],
      benefits: []
    },
    intake: {
      items: []
    },
    apps: {
      items: []
    },
    sourceStates: {},
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
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(overlay, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

async function mutateOverlay(filePath, mutator) {
  const previous = overlayMutationQueues.get(filePath) ?? Promise.resolve();
  const queued = previous
    .catch(() => {})
    .then(async () => {
      const overlay = await readOverlay(filePath);
      const result = await mutator(overlay);
      await writeOverlay(filePath, overlay);
      return result ?? overlay;
    });
  overlayMutationQueues.set(filePath, queued);
  try {
    return await queued;
  } finally {
    if (overlayMutationQueues.get(filePath) === queued) {
      overlayMutationQueues.delete(filePath);
    }
  }
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

function publicPlaidItem(item) {
  const { accessToken, accessTokenEncrypted, cursor, ...publicItem } = item;
  return publicItem;
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
      sync: overlay.finance?.sync
        ? { ...(baseDashboard.finance.sync ?? {}), ...overlay.finance.sync }
        : baseDashboard.finance.sync,
      accounts: mergeById(baseDashboard.finance.accounts, overlay.finance?.accounts ?? []),
      plaidItems: (overlay.finance?.plaidItems ?? baseDashboard.finance.plaidItems ?? []).map(
        publicPlaidItem
      ),
      benefits: mergeById(baseDashboard.finance.benefits ?? [], overlay.finance?.benefits ?? [])
    },
    intake: {
      ...baseDashboard.intake,
      items: mergeById(baseDashboard.intake.items, overlay.intake?.items ?? [])
    },
    apps: {
      ...baseDashboard.apps,
      items: mergeById(baseDashboard.apps?.items ?? [], overlay.apps?.items ?? [])
    },
    sourceStates: {
      ...(baseDashboard.sourceStates ?? {}),
      ...(overlay.sourceStates ?? {})
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
  return mutateOverlay(filePath, (overlay) => {
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
    return overlay;
  });
}

export async function getSourceState(filePath, source) {
  const overlay = await readOverlay(filePath);
  return overlay.sourceStates?.[source];
}

export async function upsertSourceState(filePath, source, state = {}) {
  if (!source) {
    return undefined;
  }
  return mutateOverlay(filePath, (overlay) => {
    overlay.sourceStates = {
      ...(overlay.sourceStates ?? {}),
      [source]: {
        ...(overlay.sourceStates?.[source] ?? {}),
        ...state,
        updatedAt: state.updatedAt ?? new Date().toISOString()
      }
    };
    return overlay.sourceStates[source];
  });
}

export async function listPlaidItems(filePath, options = {}) {
  const overlay = await readOverlay(filePath);
  return (overlay.finance.plaidItems ?? []).map((item) => {
    if (item.accessTokenEncrypted) {
      return {
        ...item,
        accessToken: decryptPlaidAccessToken(item.accessTokenEncrypted, options)
      };
    }
    if (item.accessToken) {
      requiredPlaidTokenEncryptionKey(options);
    }
    return item;
  });
}

export async function upsertPlaidItem(filePath, item, options = {}) {
  const { accessToken, ...storedItem } = item;
  const accessTokenEncrypted = accessToken
    ? encryptPlaidAccessToken(accessToken, options)
    : undefined;
  return mutateOverlay(filePath, (overlay) => {
    overlay.finance.plaidItems = upsertById(overlay.finance.plaidItems ?? [], {
      ...storedItem,
      ...(accessTokenEncrypted ? { accessTokenEncrypted } : {}),
      syncStatus: storedItem.syncStatus ?? "linked",
      updatedAt: storedItem.updatedAt ?? new Date().toISOString()
    });
    return overlay;
  });
}

export async function migratePlaidAccessTokens(filePath, options = {}) {
  return mutateOverlay(filePath, (overlay) => {
    let migrated = 0;
    overlay.finance.plaidItems = (overlay.finance.plaidItems ?? []).map((item) => {
      if (!item.accessToken) {
        return item;
      }
      migrated += 1;
      const { accessToken, ...storedItem } = item;
      return {
        ...storedItem,
        accessTokenEncrypted: encryptPlaidAccessToken(accessToken, options)
      };
    });
    return { migrated };
  });
}

export async function listFinanceBenefits(filePath) {
  const overlay = await readOverlay(filePath);
  return overlay.finance?.benefits ?? [];
}

export async function upsertFinanceBenefit(filePath, benefit) {
  return mutateOverlay(filePath, (overlay) => {
    overlay.finance.benefits = upsertById(overlay.finance.benefits ?? [], {
      ...benefit,
      createdAt: benefit.createdAt ?? new Date().toISOString(),
      updatedAt: benefit.updatedAt ?? new Date().toISOString()
    });
    return overlay.finance.benefits.find((candidate) => candidate.id === benefit.id);
  });
}

export async function removeFinanceBenefit(filePath, benefitId) {
  return mutateOverlay(filePath, (overlay) => {
    const before = overlay.finance.benefits ?? [];
    const removed = before.find((benefit) => benefit.id === benefitId);
    overlay.finance.benefits = before.filter((benefit) => benefit.id !== benefitId);
    return removed;
  });
}

export async function upsertHotelReservation(filePath, reservation) {
  return mutateOverlay(filePath, (overlay) => {
    overlay.travel.reservations = upsertById(overlay.travel.reservations, {
      ...reservation,
      type: "hotel",
      updatedAt: reservation.updatedAt ?? new Date().toISOString()
    });
    return overlay;
  });
}

export async function patchHotelReservation(filePath, reservationId, patch) {
  return mutateOverlay(filePath, (overlay) => {
    const existing = overlay.travel.reservations.find(
      (reservation) => reservation.id === reservationId
    );
    overlay.travel.reservations = upsertById(overlay.travel.reservations, {
      ...(existing ?? { id: reservationId, type: "hotel" }),
      ...patch,
      id: reservationId,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    });
    return overlay;
  });
}

export async function applyHotelRateWatch(filePath, reservation, watch, alerts = []) {
  return mutateOverlay(filePath, (overlay) => {
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
    return overlay;
  });
}

export async function listAppItems(filePath, { app, type } = {}) {
  const overlay = await readOverlay(filePath);
  return (overlay.apps.items ?? []).filter(
    (item) => (!app || item.app === app) && (!type || item.type === type)
  );
}

export async function upsertAppItem(filePath, item) {
  return mutateOverlay(filePath, (overlay) => {
    const id = item.id ?? `${item.app}:${item.type}:${item.externalId ?? Date.now()}`;
    overlay.apps.items = upsertById(overlay.apps.items ?? [], {
      ...item,
      id,
      ts: item.ts ?? new Date().toISOString()
    });
    return overlay;
  });
}

export async function patchAppItemPayload(filePath, selector, patcher) {
  return mutateOverlay(filePath, (overlay) => {
    const index = (overlay.apps.items ?? []).findIndex(
      (item) =>
        (!selector.id || item.id === selector.id) &&
        (!selector.app || item.app === selector.app) &&
        (!selector.type || item.type === selector.type)
    );
    if (index < 0) {
      return undefined;
    }
    const item = overlay.apps.items[index];
    const payload = item.payload ?? {};
    const patch = typeof patcher === "function" ? patcher(payload, item) : patcher;
    if (!patch) {
      return item;
    }
    const next = {
      ...item,
      payload: {
        ...payload,
        ...patch
      },
      status: patch.status ?? item.status,
      ts: item.ts ?? new Date().toISOString()
    };
    overlay.apps.items[index] = next;
    return next;
  });
}

export async function applyPlaidSync(filePath, itemId, sync) {
  return mutateOverlay(filePath, (overlay) => {
    for (const account of sync.accounts ?? []) {
      overlay.finance.accounts = upsertById(overlay.finance.accounts, account);
    }
    for (const item of [...(sync.added ?? []), ...(sync.modified ?? [])]) {
      overlay.transactions = upsertById(overlay.transactions, item);
    }
    for (const item of sync.removed ?? []) {
      overlay.transactions = overlay.transactions.filter(
        (transaction) => transaction.id !== item.id
      );
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
      state: sync.synced ? "synced" : "error",
      provider: "plaid",
      updatedAt: new Date().toISOString(),
      plaid: {
        status: sync.synced ? "synced" : "error",
        itemId,
        added: sync.added?.length ?? 0,
        modified: sync.modified?.length ?? 0,
        removed: sync.removed?.length ?? 0,
        lastSyncedAt: new Date().toISOString()
      }
    };
    return overlay;
  });
}

export async function upsertHermesEvent(filePath, normalized) {
  return mutateOverlay(filePath, (overlay) => {
    if (normalized.alert) {
      overlay.alerts = upsertById(overlay.alerts, normalized.alert);
    }
    if (normalized.transaction) {
      overlay.transactions = upsertById(overlay.transactions, normalized.transaction);
    }
    return overlay;
  });
}

export async function upsertHermesAction(filePath, action) {
  return mutateOverlay(filePath, (overlay) => {
    overlay.hermes.actions = upsertById(overlay.hermes.actions, action);
    return overlay;
  });
}

export async function findHermesActionByIdempotencyKey(filePath, idempotencyKey) {
  if (!idempotencyKey) {
    return undefined;
  }
  const overlay = await readOverlay(filePath);
  return overlay.hermes.actions.find((action) => action.idempotencyKey === idempotencyKey);
}

export async function patchHermesAction(filePath, actionId, patch) {
  return mutateOverlay(filePath, (overlay) => {
    const existing = overlay.hermes.actions.find((action) => action.id === actionId);
    overlay.hermes.actions = upsertById(overlay.hermes.actions, {
      ...(existing ?? { id: actionId }),
      ...patch,
      id: actionId,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    });
    return overlay;
  });
}
