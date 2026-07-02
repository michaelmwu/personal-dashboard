import { alert, hermesAction, hermesCapability, transaction } from "../contracts/index.mjs";

export function normalizeHermesEvent(payload) {
  const merchant = payload.merchant ?? payload.subject ?? "Unknown merchant";
  const amount = Number.parseFloat(payload.amount ?? "0");
  const severity = payload.duplicateCandidate || amount >= 1000 ? "high" : "medium";

  return {
    alert: alert({
      id: payload.id ?? `hermes_${Date.now()}`,
      title: payload.title ?? `Charge detected at ${merchant}`,
      detail:
        payload.detail ??
        `${merchant} charged ${Number.isFinite(amount) ? `$${amount.toFixed(2)}` : "an unknown amount"}.`,
      severity,
      source: "Hermes"
    }),
    transaction: transaction({
      id: payload.transactionId ?? `txn_${Date.now()}`,
      merchant,
      amount: Number.isFinite(amount) ? amount : 0,
      category: payload.category ?? "Unclassified",
      card: payload.card ?? "Unknown card",
      status: payload.status ?? "pending"
    })
  };
}

export function hermesCapabilities() {
  return [
    hermesCapability({
      id: "hotel_rate_search",
      title: "Search hotel rates",
      target: "hotel-rate-finder",
      description: "Ask hotel_rate_finder to watch or refresh property rates.",
      inputSchema: {
        property: "string",
        location: "string",
        checkIn: "YYYY-MM-DD",
        checkOut: "YYYY-MM-DD",
        targetRate: "number"
      }
    }),
    hermesCapability({
      id: "flight_search",
      title: "Search flights",
      target: "flights-extension",
      description: "Trigger Google Flights and Skyscanner route searches through the extension adapter.",
      inputSchema: {
        origin: "IATA",
        destination: "IATA",
        dates: "string",
        targetPrice: "number"
      }
    }),
    hermesCapability({
      id: "asia_deals_refresh",
      title: "Refresh Asia deals",
      target: "asia-travel-deals",
      description: "Refresh the candidate feed and surface cheap Asia travel deals for review.",
      inputSchema: {
        region: "string",
        cabin: "string",
        maxPrice: "number"
      }
    }),
    hermesCapability({
      id: "plaid_sync",
      title: "Sync Plaid transactions",
      target: "plaid",
      description: "Pull latest card transactions and queue reconciliation work.",
      inputSchema: {
        accountId: "string?",
        since: "YYYY-MM-DD?"
      }
    }),
    hermesCapability({
      id: "gmail_intake_scan",
      title: "Scan Gmail intake",
      target: "gmail-intake",
      description: "Read recent Gmail and classify reservations, statements, and important messages.",
      inputSchema: {
        query: "string",
        limit: "number"
      }
    }),
    hermesCapability({
      id: "reservation_parse",
      title: "Parse reservation",
      target: "gmail-intake",
      description: "Parse one email or attachment into a normalized travel reservation.",
      inputSchema: {
        messageId: "string"
      }
    })
  ];
}

export function createHermesAction(payload) {
  const capabilityId = payload.capabilityId ?? payload.action ?? "unknown";
  const capability = hermesCapabilities().find((item) => item.id === capabilityId);
  const target = payload.target ?? capability?.target ?? "unknown";
  return hermesAction({
    id: payload.id ?? `ha_${Date.now()}`,
    capabilityId,
    target,
    title: payload.title ?? capability?.title ?? "Unknown Hermes action",
    status: payload.status ?? "queued",
    payload: payload.payload ?? {},
    createdAt: payload.createdAt ?? new Date().toISOString()
  });
}

export function hermesContextFromDashboard(dashboard) {
  return {
    generatedAt: dashboard.generatedAt,
    health: dashboard.health,
    alerts: dashboard.alerts.filter((item) => item.severity !== "low"),
    travel: {
      hotelWatches: dashboard.travel.hotelWatches,
      flightWatches: dashboard.travel.flightWatches,
      dealFeed: dashboard.travel.dealFeed,
      reservationsNeedingReview: dashboard.travel.reservations.filter(
        (item) => item.status !== "parsed"
      )
    },
    finance: {
      sync: dashboard.finance.sync,
      accounts: dashboard.finance.accounts
    },
    intake: {
      needsReview: dashboard.intake.items.filter((item) => item.state !== "done")
    },
    capabilities: hermesCapabilities(),
    integrations: dashboard.integrations
  };
}
