import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import YAML from "yaml";

import { DASHBOARD_APP_MANIFEST_VERSION, appManifest, appPanel } from "../contracts/index.mjs";

export const DEFAULT_DASHBOARD_CONFIG = "dashboard.config.yaml";

function resolvePath(root, path) {
  return isAbsolute(path) ? path : join(root, path);
}

function configuredBaseUrl(manifest, env = process.env) {
  if (manifest.baseUrlEnv) {
    return env[manifest.baseUrlEnv] ?? "";
  }
  return manifest.baseUrl ?? "";
}

export async function loadDashboardConfig(root, configPath = DEFAULT_DASHBOARD_CONFIG) {
  const raw = await readFile(resolvePath(root, configPath), "utf8");
  const parsed = YAML.parse(raw) ?? {};
  return {
    apps: Array.isArray(parsed.apps) ? parsed.apps : [],
    panels: parsed.panels ?? {},
    alertThresholds: parsed.alertThresholds ?? {}
  };
}

export async function loadDashboardManifest(root, appConfig, options = {}) {
  const manifestPath = appConfig.manifest;
  if (!manifestPath) {
    throw new Error(`App ${appConfig.id ?? "unknown"} is missing a manifest path.`);
  }
  const raw = await readFile(resolvePath(root, manifestPath), "utf8");
  const manifest = JSON.parse(raw);
  validateDashboardManifest(manifest);
  return appManifest({
    ...manifest,
    baseUrl: configuredBaseUrl(manifest, options.env ?? process.env),
    panels: (manifest.panels ?? []).map((panel) =>
      appPanel({
        ...panel,
        appId: manifest.id
      })
    )
  });
}

export function validateDashboardManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Dashboard manifest must be an object.");
  }
  for (const field of ["id", "name", "version"]) {
    if (!manifest[field] || typeof manifest[field] !== "string") {
      throw new Error(`Dashboard manifest is missing string field: ${field}`);
    }
  }
  if (manifest.version !== DASHBOARD_APP_MANIFEST_VERSION) {
    throw new Error(
      `Dashboard manifest ${manifest.id} uses unsupported version ${manifest.version}.`
    );
  }
  for (const panel of manifest.panels ?? []) {
    for (const field of ["id", "type", "title", "dataSource"]) {
      if (!panel[field] || typeof panel[field] !== "string") {
        throw new Error(`Dashboard manifest ${manifest.id} has invalid panel field: ${field}`);
      }
    }
  }
  for (const capability of manifest.capabilities ?? []) {
    for (const field of ["id", "title", "kind", "target", "description"]) {
      if (!capability[field] || typeof capability[field] !== "string") {
        throw new Error(`Dashboard manifest ${manifest.id} has invalid capability field: ${field}`);
      }
    }
    if (!["deterministic", "agentic"].includes(capability.kind)) {
      throw new Error(`Dashboard manifest ${manifest.id} has invalid capability kind.`);
    }
  }
  return true;
}

function panelOverrides(appConfig, panelId) {
  return (appConfig.panels ?? []).find((panel) => panel.id === panelId) ?? {};
}

function enabledPanels(appConfig, manifest) {
  return manifest.panels
    .map((panel) => {
      const overrides = panelOverrides(appConfig, panel.id);
      return {
        ...panel,
        enabled: overrides.enabled ?? panel.enabled ?? true,
        defaultPosition: overrides.position ?? panel.defaultPosition,
        order: overrides.order ?? panel.order ?? 100
      };
    })
    .filter((panel) => panel.enabled !== false)
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title));
}

export async function loadPluginRegistry(root, options = {}) {
  const config = await loadDashboardConfig(root, options.configPath);
  const apps = [];
  const panels = [];

  for (const appConfig of config.apps) {
    if (appConfig.enabled === false) {
      continue;
    }
    const manifest = await loadDashboardManifest(root, appConfig, options);
    apps.push(manifest);
    panels.push(...enabledPanels(appConfig, manifest));
  }

  return {
    apps,
    panels,
    capabilities: manifestCapabilities(apps),
    alertThresholds: config.alertThresholds
  };
}

export function manifestCapabilities(apps) {
  return apps.flatMap((app) =>
    (app.capabilities ?? []).map((capability) => ({
      ...capability,
      appId: app.id,
      target: capability.target ?? app.id
    }))
  );
}

export function genericAppItemsFromDashboard(dashboard, appId) {
  switch (appId) {
    case "asia-travel-deals":
      return dashboard.travel.dealFeed.map((item) => ({
        id: item.id,
        app: appId,
        type: "deal",
        externalId: item.id,
        ts: item.updatedAt ?? dashboard.generatedAt,
        status: item.status,
        title: item.title,
        detail: `${item.route} · ${item.confidence}`,
        payload: item
      }));
    case "hotel-rate-finder":
      return dashboard.travel.hotelWatches.map((item) => ({
        id: item.id,
        app: appId,
        type: "rate-watch",
        externalId: item.id,
        ts: item.updatedAt ?? dashboard.generatedAt,
        status: item.status,
        title: item.property,
        detail: `${item.checkIn ?? "TBD"} to ${item.checkOut ?? "TBD"}`,
        payload: item
      }));
    case "flight-searcher":
      return dashboard.travel.flightWatches.map((item) => ({
        id: item.id,
        app: appId,
        type: "flight-watch",
        externalId: item.id,
        ts: dashboard.generatedAt,
        status: item.status,
        title: item.route,
        detail: `${item.dates} · ${item.providers.join(", ")}`,
        payload: item
      }));
    case "plaid":
      return [
        {
          id: "plaid_sync",
          app: appId,
          type: "sync",
          externalId: "plaid_sync",
          ts: dashboard.generatedAt,
          status: dashboard.finance.sync?.state ?? dashboard.finance.sync?.status ?? "unknown",
          title: "Plaid sync",
          detail:
            dashboard.finance.sync?.provider ?? dashboard.finance.sync?.status ?? "not configured",
          payload: dashboard.finance.sync ?? {}
        }
      ];
    case "gmail-intake":
      return dashboard.intake.items.map((item) => ({
        id: item.id,
        app: appId,
        type: "intake",
        externalId: item.id,
        ts: item.receivedAt ?? dashboard.generatedAt,
        status: item.state,
        title: item.title,
        detail: item.detail,
        payload: item
      }));
    default:
      return [];
  }
}
