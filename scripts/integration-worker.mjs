import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

function envNumber(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function dashboardEventUrl(source) {
  const baseUrl = process.env.PERSONAL_DASHBOARD_API_BASE_URL ?? "http://127.0.0.1:8810";
  return `${baseUrl.replace(/\/$/, "")}/api/integrations/${source}/events`;
}

function asiaDealsUrl() {
  const baseUrl = process.env.ASIA_TRAVEL_DEALS_API_BASE_URL;
  if (!baseUrl) {
    throw new Error("ASIA_TRAVEL_DEALS_API_BASE_URL is required for Asia deal polling.");
  }
  return `${baseUrl.replace(/\/$/, "")}/deals`;
}

function asiaDealPayload(deal) {
  return {
    id: deal.id,
    dealGroupId: deal.deal_group_id,
    headline: deal.headline,
    originAirports: deal.origin_airports,
    destinationAirports: deal.destination_airports,
    cabin: deal.cabin,
    priceUsd: deal.price_usd,
    dealScore: deal.deal_score,
    status: deal.status,
    updatedAt: deal.updated_at
  };
}

async function postDashboardEvent(source, payload) {
  const response = await fetch(dashboardEventUrl(source), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(process.env.PERSONAL_DASHBOARD_API_TOKEN)
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Dashboard event POST failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function postDashboardAction(path, payload = {}) {
  const baseUrl = process.env.PERSONAL_DASHBOARD_API_BASE_URL ?? "http://127.0.0.1:8810";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(process.env.PERSONAL_DASHBOARD_API_TOKEN)
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Dashboard POST ${path} failed with HTTP ${response.status}`);
  }
  return response.json();
}

async function readJsonFeed(filePath) {
  const payload = JSON.parse(await readFile(filePath, "utf8"));
  return Array.isArray(payload) ? payload : [payload];
}

async function ingestJsonFeed({ source, envName }) {
  const filePath = process.env[envName];
  if (!filePath) {
    return { source, skipped: true, reason: `${envName} is not configured` };
  }

  const items = await readJsonFeed(filePath);
  let upserts = 0;
  for (const item of items) {
    await postDashboardEvent(source, item);
    upserts += 1;
  }
  return { source, fetched: items.length, upserts };
}

export async function runIngestion(source, task) {
  try {
    return { source, ...(await task()) };
  } catch (error) {
    return {
      source,
      error: true,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function pollAsiaTravelDeals() {
  const response = await fetch(asiaDealsUrl(), {
    headers: authHeaders(process.env.ASIA_TRAVEL_DEALS_API_TOKEN)
  });
  if (!response.ok) {
    throw new Error(`AsiaTravelDeals /deals poll failed with HTTP ${response.status}`);
  }

  const deals = await response.json();
  let upserts = 0;
  for (const deal of deals) {
    await postDashboardEvent("asia-travel-deals", asiaDealPayload(deal));
    upserts += 1;
  }
  return { fetched: deals.length, upserts };
}

export async function runConfiguredIngestions() {
  const results = [];
  if (process.env.ASIA_TRAVEL_DEALS_API_BASE_URL) {
    results.push(await runIngestion("asia-travel-deals", pollAsiaTravelDeals));
  }
  for (const feed of [
    { source: "hotel-rate-finder", envName: "HOTEL_RATE_FINDER_EVENTS_FILE" },
    { source: "flight-searcher", envName: "FLIGHT_SEARCHER_EVENTS_FILE" },
    { source: "plaid", envName: "PLAID_EVENTS_FILE" },
    { source: "gmail-intake", envName: "GMAIL_INTAKE_EVENTS_FILE" }
  ]) {
    results.push(await runIngestion(feed.source, () => ingestJsonFeed(feed)));
  }
  if (process.env.PLAID_SYNC_ENABLED === "true") {
    results.push(
      await runIngestion("plaid", () => postDashboardAction("/api/integrations/plaid/sync"))
    );
  }
  if (process.env.HOTEL_RATE_SYNC_ENABLED === "true") {
    results.push(
      await runIngestion("hotel-rate-finder", () =>
        postDashboardAction("/api/integrations/hotel-rate-finder/sync")
      )
    );
  }
  return results;
}

async function main() {
  const once = process.argv.includes("--once");
  const intervalSeconds = envNumber("ASIA_TRAVEL_DEALS_POLL_INTERVAL_SECONDS", 300);

  do {
    const results = await runConfiguredIngestions();
    for (const result of results) {
      console.log(JSON.stringify(result));
    }
    if (!once) {
      await sleep(intervalSeconds * 1000);
    }
  } while (!once);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
