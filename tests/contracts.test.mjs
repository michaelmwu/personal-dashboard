import { describe, expect, test } from "bun:test";

import { dashboardFixture } from "../packages/fixtures/dashboard.mjs";
import {
  createHermesAction,
  hermesCapabilities,
  hermesContextFromDashboard,
  normalizeHermesEvent
} from "../packages/integrations/hermes.mjs";
import { integrationCatalog, normalizeSourceEvent } from "../packages/integrations/sources.mjs";

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
    expect(dashboard.travel.hotelWatches).toHaveLength(2);
    expect(dashboard.travel.flightWatches).toHaveLength(2);
    expect(dashboard.travel.dealFeed).toHaveLength(2);
    expect(dashboard.travel.reservations).toHaveLength(2);
    expect(dashboard.finance.accounts).toHaveLength(2);
    expect(dashboard.intake.items).toHaveLength(2);
    expect(dashboard.hermes.capabilities.map((capability) => capability.id)).toContain(
      "gmail_intake_scan"
    );
    expect(dashboard.integrations.map((integration) => integration.id)).toContain("plaid");
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

  test("integration catalog defines the next provider boundaries", () => {
    const ids = integrationCatalog().map((integration) => integration.id);

    expect(ids).toContain("hotel_rate_finder");
    expect(ids).toContain("flights_extension");
    expect(ids).toContain("asia_travel_deals");
    expect(ids).toContain("gmail_intake");
  });

  test("Hermes can pull compact dashboard context and create action envelopes", () => {
    const dashboard = dashboardFixture();
    const context = hermesContextFromDashboard(dashboard);
    const action = createHermesAction({
      capabilityId: "flight_search",
      payload: {
        origin: "TYO",
        destination: "SIN",
        dates: "September"
      }
    });

    expect(context.capabilities).toHaveLength(hermesCapabilities().length);
    expect(context.travel.reservationsNeedingReview).toHaveLength(1);
    expect(context.intake.needsReview).toHaveLength(2);
    expect(action).toMatchObject({
      capabilityId: "flight_search",
      target: "flights-extension",
      status: "queued"
    });
  });

  test("source events normalize into domain-specific placeholders", () => {
    expect(
      normalizeSourceEvent("hotel-rate-finder", {
        property: "Park Hyatt Tokyo",
        rate: "455"
      })
    ).toMatchObject({
      kind: "hotelRateWatch",
      value: {
        property: "Park Hyatt Tokyo",
        bestRate: 455,
        source: "hotel-rate-finder"
      }
    });

    expect(
      normalizeSourceEvent("gmail-intake", {
        subject: "Flight confirmation",
        reservationType: "flight",
        travelDate: "2026-09-01"
      })
    ).toMatchObject({
      kind: "reservation",
      value: {
        type: "flight",
        status: "needs-review"
      }
    });

    expect(
      normalizeSourceEvent("gmail-intake", {
        subject: "Important account notice",
        snippet: "Please review this message."
      })
    ).toMatchObject({
      kind: "intakeItem",
      value: {
        title: "Important account notice",
        state: "needs-review"
      }
    });
  });
});
