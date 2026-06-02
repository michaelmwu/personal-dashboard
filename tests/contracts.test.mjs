import { describe, expect, test } from "bun:test";

import { dashboardFixture } from "../packages/fixtures/dashboard.mjs";
import { normalizeHermesEvent } from "../packages/integrations/hermes.mjs";

describe("contracts", () => {
  test("dashboard fixture exposes the core integration surfaces", () => {
    const dashboard = dashboardFixture();

    expect(dashboard.health.level).toBe("warning");
    expect(dashboard.metrics).toHaveLength(4);
    expect(dashboard.alerts.some((alert) => alert.severity === "high")).toBe(true);
    expect(dashboard.transactions.some((transaction) => transaction.status === "pending")).toBe(
      true
    );
    expect(dashboard.openclaw.tasks).toHaveLength(3);
  });

  test("Hermes events normalize into alert and transaction candidates", () => {
    const normalized = normalizeHermesEvent({
      id: "evt_123",
      merchant: "Amex Travel",
      amount: "1250.00",
      category: "Travel",
      card: "Amex Platinum"
    });

    expect(normalized.alert.severity).toBe("high");
    expect(normalized.transaction.merchant).toBe("Amex Travel");
    expect(normalized.transaction.amount).toBe(1250);
    expect(normalized.transaction.status).toBe("pending");
  });
});
