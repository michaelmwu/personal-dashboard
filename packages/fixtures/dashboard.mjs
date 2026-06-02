import {
  alert,
  dashboardContract,
  metric,
  rewardInsight,
  transaction
} from "../contracts/index.mjs";
import { openClawSnapshot } from "../integrations/openclaw.mjs";

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
    openclaw: openClawSnapshot()
  });
}
