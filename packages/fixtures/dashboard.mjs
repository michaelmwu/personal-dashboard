import {
  alert,
  dashboardContract,
  financeAccount,
  flightSearchWatch,
  hermesAction,
  hotelRateWatch,
  intakeItem,
  metric,
  reservation,
  rewardInsight,
  transaction,
  travelDeal
} from "../contracts/index.mjs";
import { hermesCapabilities } from "../integrations/hermes.mjs";
import { openClawSnapshot } from "../integrations/openclaw.mjs";
import { integrationCatalog } from "../integrations/sources.mjs";

export function dashboardFixture() {
  const transactions = [
    transaction({
      id: "txn_001",
      merchant: "Costco",
      amount: 83.21,
      category: "GENERAL_MERCHANDISE",
      categoryDetailed: "GENERAL_MERCHANDISE_SUPERSTORES",
      card: "Chase Freedom",
      accountId: "acct_003",
      status: "pending",
      pending: true,
      paymentChannel: "in store",
      isoCurrencyCode: "USD",
      date: "2026-06-29",
      source: "fixture"
    }),
    transaction({
      id: "txn_002",
      merchant: "Momoshop",
      amount: 126.4,
      category: "GENERAL_MERCHANDISE",
      categoryDetailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
      card: "Amex Gold",
      accountId: "acct_001",
      status: "pending",
      pending: true,
      paymentChannel: "online",
      isoCurrencyCode: "USD",
      date: "2026-06-30",
      source: "fixture"
    }),
    transaction({
      id: "txn_003",
      merchant: "Din Tai Fung",
      amount: 97.8,
      category: "FOOD_AND_DRINK",
      categoryDetailed: "FOOD_AND_DRINK_RESTAURANT",
      card: "Amex Gold",
      accountId: "acct_001",
      status: "posted",
      pending: false,
      paymentChannel: "in store",
      isoCurrencyCode: "USD",
      date: "2026-06-28",
      source: "fixture"
    }),
    transaction({
      id: "txn_004",
      merchant: "United Airlines",
      amount: 812.12,
      category: "TRAVEL",
      categoryDetailed: "TRAVEL_FLIGHTS",
      card: "Amex Platinum",
      accountId: "acct_002",
      status: "posted",
      pending: false,
      paymentChannel: "online",
      isoCurrencyCode: "USD",
      date: "2026-06-22",
      source: "fixture"
    }),
    transaction({
      id: "txn_005",
      merchant: "United Airlines",
      amount: -50,
      category: "TRAVEL",
      categoryDetailed: "TRAVEL_FLIGHTS",
      card: "Amex Platinum",
      accountId: "acct_002",
      status: "posted",
      pending: false,
      paymentChannel: "online",
      isoCurrencyCode: "USD",
      date: "2026-06-25",
      source: "fixture"
    })
  ];

  return dashboardContract({
    health: {
      level: "warning",
      summary: "Hermes online, Plaid pending, OpenClaw synced 12m ago"
    },
    metrics: [
      metric("Tracked spend", "$1,120", "Fixture ledger"),
      metric("Transactions", "5", "2 pending"),
      metric("Credits", "1", "$50 matched later"),
      metric("Alerts", "2", "1 high priority")
    ],
    alerts: [
      alert({
        id: "alert_001",
        title: "Possible duplicate charge",
        detail: "Momoshop charged Amex Gold twice within six minutes for similar amounts.",
        severity: "high"
      }),
      alert({
        id: "alert_002",
        title: "Foreign transaction detected",
        detail: "United Airlines posted in a travel category. Confirm itinerary ownership.",
        severity: "medium"
      })
    ],
    transactions,
    rewards: {
      period: "June 2026",
      estimatedPoints: 42000,
      insights: [
        rewardInsight({
          id: "reward_001",
          title: "Dining card choice working",
          detail: "Amex Gold captured 4x on posted dining transactions.",
          pointsImpact: 3912
        }),
        rewardInsight({
          id: "reward_002",
          title: "Wrong card candidates",
          detail:
            "Three retail transactions likely under-earned compared with category bonus cards.",
          pointsImpact: -2100
        })
      ]
    },
    openclaw: openClawSnapshot(),
    travel: {
      hotelWatches: [
        hotelRateWatch({
          id: "hotel_001",
          property: "Andaz Tokyo Toranomon Hills",
          location: "Tokyo",
          checkIn: "2026-09-12",
          checkOut: "2026-09-15",
          targetRate: 420,
          bestRate: 488,
          source: "hotel-rate-finder",
          status: "above-target"
        }),
        hotelRateWatch({
          id: "hotel_002",
          property: "Capella Bangkok",
          location: "Bangkok",
          checkIn: "2026-10-04",
          checkOut: "2026-10-08",
          targetRate: 520,
          bestRate: 501,
          source: "hotel-rate-finder",
          status: "bookable"
        })
      ],
      flightWatches: [
        flightSearchWatch({
          id: "flight_001",
          route: "TYO-SIN",
          dates: "Sep 12-18",
          providers: ["google-flights", "skyscanner"],
          targetPrice: 420,
          bestPrice: 468,
          status: "watching"
        }),
        flightSearchWatch({
          id: "flight_002",
          route: "TPE-BKK",
          dates: "Oct flexible",
          providers: ["google-flights"],
          targetPrice: 180,
          bestPrice: 162,
          status: "alert"
        })
      ],
      dealFeed: [
        travelDeal({
          id: "deal_001",
          title: "Taipei to Bangkok business class fare window",
          route: "TPE-BKK",
          price: 812,
          source: "asia-travel-deals",
          confidence: "needs-verification",
          status: "candidate"
        }),
        travelDeal({
          id: "deal_002",
          title: "Tokyo to Singapore premium economy sale",
          route: "TYO-SIN",
          price: 690,
          source: "asia-travel-deals",
          confidence: "medium",
          status: "review"
        })
      ],
      reservations: [
        reservation({
          id: "reservation_001",
          type: "flight",
          title: "United 876 TPE-SFO",
          dates: "2026-08-19",
          source: "gmail",
          status: "parsed"
        }),
        reservation({
          id: "reservation_002",
          type: "hotel",
          title: "Hyatt Regency Kyoto",
          dates: "2026-08-20 to 2026-08-23",
          source: "gmail",
          status: "needs-review"
        })
      ]
    },
    finance: {
      sync: {
        provider: "Plaid",
        state: "not-connected",
        lastSync: null
      },
      benefits: [],
      accounts: [
        financeAccount({
          id: "acct_001",
          name: "Amex Gold",
          kind: "credit",
          type: "credit",
          subtype: "credit card",
          last4: "1001",
          syncStatus: "placeholder"
        }),
        financeAccount({
          id: "acct_002",
          name: "Chase Sapphire Reserve",
          kind: "credit",
          type: "credit",
          subtype: "credit card",
          last4: "4242",
          syncStatus: "placeholder"
        }),
        financeAccount({
          id: "acct_003",
          name: "Chase Freedom",
          kind: "credit",
          type: "credit",
          subtype: "credit card",
          last4: "9009",
          syncStatus: "placeholder"
        })
      ]
    },
    intake: {
      items: [
        intakeItem({
          id: "mail_001",
          source: "gmail",
          title: "Hotel confirmation needs parsing",
          detail:
            "Reservation email has dates and cancellation deadline but no normalized trip yet.",
          classification: "reservation",
          state: "needs-review",
          receivedAt: "2026-07-02T09:12:00.000Z"
        }),
        intakeItem({
          id: "mail_002",
          source: "gmail",
          title: "Credit card statement available",
          detail: "Statement email should be matched to Plaid transactions once sync is live.",
          classification: "finance",
          state: "queued",
          receivedAt: "2026-07-02T10:34:00.000Z"
        })
      ]
    },
    hermes: {
      status: "context-ready",
      contextEndpoint: "/api/hermes/context",
      actionEndpoint: "/api/hermes/actions",
      capabilities: hermesCapabilities(),
      actions: [
        hermesAction({
          id: "ha_001",
          idempotencyKey: "gmail-search-2026-07-02",
          capabilityId: "gmail_search",
          target: "gmail-intake",
          title: "Search recent travel emails",
          status: "ready",
          payload: {
            purpose: "interactive-search",
            filters: {
              keywords: ["confirmation", "itinerary", "receipt"],
              after: "2026-06-18T00:00:00.000Z",
              labels: ["INBOX"]
            },
            limit: 25
          },
          createdAt: "2026-07-02T11:00:00.000Z"
        }),
        hermesAction({
          id: "ha_002",
          idempotencyKey: "asia-deals-refresh-2026-07-02",
          capabilityId: "asia_deals_refresh",
          target: "asia-travel-deals",
          title: "Refresh Asia fare candidates",
          status: "ready",
          payload: {
            region: "Asia",
            cabin: "business",
            maxPrice: 1200
          },
          createdAt: "2026-07-02T11:05:00.000Z"
        })
      ]
    },
    integrations: integrationCatalog()
  });
}

function envBoolean(value) {
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

/**
 * Fixture data is useful for local development, but it must never silently
 * become production data.  A caller can explicitly opt in or out with
 * DASHBOARD_FIXTURES_ENABLED; otherwise production-like environments start
 * from an empty, honest dashboard state.
 */
export function dashboardFixturesEnabled(env = process.env) {
  if (env.DASHBOARD_FIXTURES_ENABLED !== undefined && env.DASHBOARD_FIXTURES_ENABLED !== "") {
    return envBoolean(env.DASHBOARD_FIXTURES_ENABLED);
  }

  return !["production", "prod"].includes(String(env.ENVIRONMENT ?? "local").toLowerCase());
}

export function emptyDashboard() {
  return dashboardContract({
    health: {
      level: "unknown",
      summary: "Waiting for live integration data."
    },
    metrics: [],
    alerts: [],
    transactions: [],
    rewards: {
      period: "Current period",
      estimatedPoints: 0,
      insights: []
    },
    openclaw: {
      tasks: []
    },
    travel: {
      hotelWatches: [],
      flightWatches: [],
      dealFeed: [],
      reservations: []
    },
    finance: {
      sync: {
        provider: "Plaid",
        state: "not-connected",
        lastSync: null
      },
      benefits: [],
      accounts: []
    },
    intake: {
      items: []
    },
    hermes: {
      status: "not-configured",
      contextEndpoint: "/api/hermes/context",
      actionEndpoint: "/api/hermes/actions",
      capabilities: [],
      actions: []
    },
    integrations: integrationCatalog()
  });
}

export function dashboardSeed(env = process.env) {
  return dashboardFixturesEnabled(env) ? dashboardFixture() : emptyDashboard();
}
