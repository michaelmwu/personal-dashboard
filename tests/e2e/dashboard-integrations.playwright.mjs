import { expect, test } from "@playwright/test";

test("source events upsert into the dashboard contract", async ({ request }) => {
  const event = await request.post("/api/integrations/asia-travel-deals/events", {
    data: {
      id: "deal_e2e_001",
      dealGroupId: "group_e2e_001",
      headline: "Tokyo to Singapore business class candidate",
      originAirports: ["TYO"],
      destinationAirports: ["SIN"],
      priceUsd: 777,
      dealScore: 88,
      status: "needs_verification"
    }
  });

  expect(event.status()).toBe(202);

  const dashboardResponse = await request.get("/api/dashboard");
  expect(dashboardResponse.status()).toBe(200);
  const dashboard = await dashboardResponse.json();
  expect(dashboard.travel.dealFeed).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "deal_e2e_001",
        dealGroupId: "group_e2e_001",
        price: 777,
        score: 88,
        status: "needs_verification"
      })
    ])
  );
});

test("Plaid Link token endpoint fails closed without server credentials", async ({ request }) => {
  const response = await request.post("/api/integrations/plaid/link-token", {
    data: {
      userId: "e2e-user"
    }
  });

  expect(response.status()).toBe(503);
  await expect(response.json()).resolves.toMatchObject({
    created: false,
    response: {
      error: "missing_plaid_config"
    }
  });
});

test("Hotel Rate Finder sync endpoint fails closed without service URL", async ({ request }) => {
  const response = await request.post("/api/integrations/hotel-rate-finder/sync", {
    data: {
      reservationId: "reservation_hotel_e2e_001"
    }
  });

  expect(response.status()).toBe(503);
  await expect(response.json()).resolves.toMatchObject({
    synced: false,
    reason: "missing_hotel_rate_finder_api_base_url"
  });
});

test("plugin registry exposes enabled apps and accepts opaque app events", async ({ request }) => {
  const registry = await request.get("/api/apps");
  expect(registry.status()).toBe(200);
  await expect(registry.json()).resolves.toMatchObject({
    apps: expect.arrayContaining([
      expect.objectContaining({
        id: "hotel-rate-finder"
      })
    ]),
    panels: expect.arrayContaining([
      expect.objectContaining({
        id: "hotel-watches",
        appId: "hotel-rate-finder"
      })
    ])
  });

  const event = await request.post("/api/apps/hotel-rate-finder/events", {
    data: {
      type: "status",
      externalId: "e2e-status",
      status: "warning",
      title: "Hotel scraper stale",
      detail: "Last job failed."
    }
  });
  expect(event.status()).toBe(202);

  const items = await request.get("/api/apps/hotel-rate-finder/items?type=status");
  expect(items.status()).toBe(200);
  await expect(items.json()).resolves.toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({
        app: "hotel-rate-finder",
        type: "status",
        status: "warning"
      })
    ])
  });
});

test("Hermes actions dedupe by Idempotency-Key before dispatch", async ({ request }) => {
  const first = await request.post("/api/hermes/actions", {
    headers: {
      "Idempotency-Key": "verify-deal-e2e-001"
    },
    data: {
      capabilityId: "asia_deal_verify",
      origin: "dashboard",
      payload: {
        dealId: "deal_e2e_001"
      }
    }
  });
  expect(first.status()).toBe(202);
  const firstBody = await first.json();

  const second = await request.post("/api/hermes/actions", {
    headers: {
      "Idempotency-Key": "verify-deal-e2e-001"
    },
    data: {
      capabilityId: "asia_deal_verify",
      origin: "dashboard",
      payload: {
        dealId: "deal_e2e_001"
      }
    }
  });
  expect(second.status()).toBe(202);
  const secondBody = await second.json();

  expect(secondBody).toMatchObject({
    accepted: true,
    deduped: true,
    action: {
      id: firstBody.action.id,
      idempotencyKey: "verify-deal-e2e-001"
    }
  });
});
