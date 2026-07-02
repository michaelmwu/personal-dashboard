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
      category: "Wholesale",
      card: "Chase Freedom",
      status: "pending"
    }),
    transaction({
      id: "txn_002",
      merchant: "Momoshop",
      amount: 126.4,
      category: "Retail",
      card: "Amex Gold",
      status: "pending"
    }),
    transaction({
      id: "txn_003",
      merchant: "Din Tai Fung",
      amount: 97.8,
      category: "Dining",
      card: "Amex Gold",
      status: "posted"
    }),
    transaction({
      id: "txn_004",
      merchant: "United Airlines",
      amount: 812.12,
      category: "Travel",
      card: "Amex Platinum",
      status: "posted"
    })
  ];

  return dashboardContract({
    health: {
      level: "warning",
      summary: "Hermes online, Plaid pending, OpenClaw synced 12m ago"
    },
    metrics: [
      metric("Monthly spend", "$6,832", "+8% vs May"),
      metric("Estimated points", "42,000", "+13,422 this month"),
      metric("Missed points", "2,100", "3 card-choice misses"),
      metric("Alerts", "3", "1 high priority")
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
      }),
      alert({
        id: "alert_003",
        title: "Reward mismatch",
        detail: "Costco coded as wholesale. Expected Freedom quarterly bonus should be checked.",
        severity: "low"
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
      accounts: [
        financeAccount({
          id: "acct_001",
          name: "Amex Gold",
          kind: "credit",
          last4: "1001",
          syncStatus: "placeholder"
        }),
        financeAccount({
          id: "acct_002",
          name: "Chase Sapphire Reserve",
          kind: "credit",
          last4: "4242",
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
          detail: "Reservation email has dates and cancellation deadline but no normalized trip yet.",
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
          capabilityId: "gmail_intake_scan",
          target: "gmail-intake",
          title: "Scan recent travel emails",
          status: "ready",
          payload: {
            query: "newer_than:14d (confirmation OR itinerary OR receipt)",
            limit: 25
          },
          createdAt: "2026-07-02T11:00:00.000Z"
        }),
        hermesAction({
          id: "ha_002",
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
