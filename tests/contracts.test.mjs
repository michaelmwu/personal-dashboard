import { describe, expect, test } from "bun:test";

import { dashboardFixture } from "../packages/fixtures/dashboard.mjs";
import {
  createHermesBridgeRun,
  HermesBridgeLoopError,
  parseSseFrame
} from "../packages/integrations/hermes-bridge.mjs";
import {
  createHermesAction,
  hermesCapabilities,
  hermesContextFromDashboard,
  normalizeHermesEvent
} from "../packages/integrations/hermes.mjs";
import { integrationCatalog, normalizeSourceEvent } from "../packages/integrations/sources.mjs";
import {
  createHotelSavedSearch,
  hotelRateDropAlert,
  hotelSearchRequestFromReservation,
  normalizeHotelRateWatchFromJob,
  normalizeHotelReservationPayload,
  runHotelSavedSearch,
  waitForHotelJob
} from "../packages/integrations/hotel-rates.mjs";
import {
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  normalizePlaidAccount,
  normalizePlaidTransaction,
  syncPlaidTransactions
} from "../packages/integrations/plaid.mjs";
import {
  applyHotelRateWatch,
  applyPlaidSync,
  listPlaidItems,
  loadDashboard,
  upsertPlaidItem,
  upsertHotelReservation,
  upsertHermesAction,
  upsertNormalizedEvent
} from "../packages/storage/dashboard-store.mjs";

describe("contracts", () => {
  test("dashboard fixture exposes the core integration surfaces", () => {
    const dashboard = dashboardFixture();

    expect(dashboard.version).toBe("dashboard.v1");
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
    expect(context.version).toBe("dashboard.v1");
    expect(context.travel.reservationsNeedingReview).toHaveLength(1);
    expect(context.intake.needsReview).toHaveLength(2);
    expect(action).toMatchObject({
      version: "hermes-action.v1",
      capabilityId: "flight_search",
      target: "flights-extension",
      status: "queued",
      origin: "hermes",
      idempotencyKey: action.id
    });

    expect(
      createHermesAction({
        capabilityId: "flight_search",
        target: "plaid"
      })
    ).toMatchObject({
      capabilityId: "flight_search",
      target: "flights-extension"
    });
  });

  test("Hermes Bridge dispatch passes idempotency and refuses Hermes-origin loops", async () => {
    const requests = [];
    const fetch = async (url, options) => {
      requests.push({ url, options });
      return Response.json({ run_id: "run_123", status: "started" }, { status: 202 });
    };

    const action = createHermesAction({
      id: "action_bridge_001",
      origin: "dashboard",
      capabilityId: "reservation_parse",
      idempotencyKey: "idem_action_bridge_001",
      payload: {
        messageId: "gmail_msg_001"
      }
    });
    const dispatch = await createHermesBridgeRun(action, {
      fetch,
      config: {
        baseUrl: "http://127.0.0.1:8642",
        password: "bridge-secret",
        sessionKey: "personal-dashboard-test"
      }
    });

    expect(dispatch).toMatchObject({
      dispatched: true,
      runId: "run_123",
      target: "hermes-bridge"
    });
    expect(requests[0].url).toBe("http://127.0.0.1:8642/v1/runs");
    expect(requests[0].options.headers).toMatchObject({
      Authorization: "Bearer bridge-secret",
      "Idempotency-Key": "idem_action_bridge_001",
      "X-Hermes-Session-Key": "personal-dashboard-test"
    });
    expect(JSON.parse(requests[0].options.body)).toMatchObject({
      session_id: "dashboard:action_bridge_001"
    });

    await expect(
      createHermesBridgeRun(
        createHermesAction({
          id: "action_loop_001",
          origin: "hermes",
          capabilityId: "reservation_parse"
        }),
        {
          fetch,
          config: {
            baseUrl: "http://127.0.0.1:8642",
            password: "bridge-secret",
            sessionKey: "personal-dashboard-test"
          }
        }
      )
    ).rejects.toThrow(HermesBridgeLoopError);
  });

  test("Hermes Bridge SSE frames parse structured and text data", () => {
    expect(
      parseSseFrame('event: run.status\ndata: {"status":"running","run_id":"run_123"}')
    ).toEqual({
      event: "run.status",
      data: {
        status: "running",
        run_id: "run_123"
      }
    });
    expect(parseSseFrame("event: token\ndata: hello")).toEqual({
      event: "token",
      data: "hello"
    });
  });

  test("Plaid Link and token exchange call the documented REST endpoints", async () => {
    const calls = [];
    const client = {
      async linkTokenCreate(body) {
        calls.push({ method: "linkTokenCreate", body });
        return {
          data: {
            link_token: "link-sandbox-123",
            expiration: "2026-07-03T00:00:00Z",
            request_id: "req_link"
          }
        };
      },
      async itemPublicTokenExchange(body) {
        calls.push({ method: "itemPublicTokenExchange", body });
        return {
          data: {
            access_token: "access-sandbox-123",
            item_id: "item_123",
            request_id: "req_exchange"
          }
        };
      }
    };
    const config = {
      baseUrl: "https://sandbox.plaid.com",
      clientId: "client-id",
      secret: "secret",
      clientName: "Personal Dashboard",
      products: ["transactions"],
      countryCodes: ["US"],
      language: "en",
      webhook: "https://dashboard.example.test/api/integrations/plaid/webhook"
    };

    const linkToken = await createPlaidLinkToken({ userId: "michael" }, { client, config });
    const exchange = await exchangePlaidPublicToken("public-sandbox-123", { client, config });

    expect(linkToken).toMatchObject({
      created: true,
      linkToken: "link-sandbox-123"
    });
    expect(exchange).toMatchObject({
      exchanged: true,
      accessToken: "access-sandbox-123",
      itemId: "item_123"
    });
    expect(calls.map((call) => call.method)).toEqual([
      "linkTokenCreate",
      "itemPublicTokenExchange"
    ]);
    expect(calls[0].body).toMatchObject({
      products: ["transactions"],
      user: {
        client_user_id: "michael"
      }
    });
    expect(calls[1].body).toEqual({
      public_token: "public-sandbox-123"
    });
  });

  test("Plaid transaction sync paginates with cursor and normalizes account data", async () => {
    const cursors = [];
    const client = {
      async transactionsSync(body) {
        cursors.push(body.cursor);
        if (!body.cursor) {
          return {
            data: {
              added: [
                {
                  transaction_id: "plaid_txn_001",
                  account_id: "plaid_account_001",
                  merchant_name: "Hyatt",
                  amount: 455.12,
                  pending: true,
                  date: "2026-07-01",
                  personal_finance_category: {
                    primary: "TRAVEL"
                  }
                }
              ],
              modified: [],
              removed: [],
              accounts: [
                {
                  account_id: "plaid_account_001",
                  name: "Amex Platinum",
                  subtype: "credit card",
                  mask: "1001",
                  balances: {
                    current: 455.12
                  }
                }
              ],
              next_cursor: "cursor_1",
              has_more: true,
              request_id: "req_sync_1"
            }
          };
        }
        return {
          data: {
            added: [],
            modified: [
              {
                transaction_id: "plaid_txn_001",
                account_id: "plaid_account_001",
                merchant_name: "Hyatt Regency",
                amount: 455.12,
                pending: false,
                pending_transaction_id: "pending_001",
                date: "2026-07-02"
              }
            ],
            removed: [{ transaction_id: "pending_001", account_id: "plaid_account_001" }],
            accounts: [],
            next_cursor: "cursor_2",
            has_more: false,
            request_id: "req_sync_2"
          }
        };
      }
    };

    const sync = await syncPlaidTransactions(
      { accessToken: "access-sandbox-123" },
      {
        client,
        config: {
          baseUrl: "https://sandbox.plaid.com",
          clientId: "client-id",
          secret: "secret",
          daysRequested: 730
        }
      }
    );

    expect(sync).toMatchObject({
      synced: true,
      cursor: "cursor_2"
    });
    expect(cursors).toEqual([undefined, "cursor_1"]);
    expect(normalizePlaidTransaction(sync.added[0])).toMatchObject({
      id: "plaid_txn_001",
      merchant: "Hyatt",
      category: "TRAVEL",
      status: "pending",
      source: "plaid"
    });
    expect(normalizePlaidAccount(sync.accounts[0])).toMatchObject({
      id: "plaid_account_001",
      name: "Amex Platinum",
      kind: "credit card",
      last4: "1001",
      balance: 455.12
    });
  });

  test("Hotel Rate Finder client creates saved searches, runs jobs, and polls status", async () => {
    const calls = [];
    const fetch = async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/saved-searches")) {
        return Response.json(
          {
            id: "saved_hotel_001",
            name: "Park Hyatt Tokyo",
            request: JSON.parse(options.body).request
          },
          { status: 200 }
        );
      }
      if (url.endsWith("/api/saved-searches/saved_hotel_001/run")) {
        return Response.json({ job_id: "job_hotel_001", status: "queued" }, { status: 200 });
      }
      return Response.json(
        {
          id: "job_hotel_001",
          status: "completed",
          report: {
            hotels: []
          }
        },
        { status: 200 }
      );
    };
    const config = {
      baseUrl: "http://127.0.0.1:8720",
      pollAttempts: 1,
      pollIntervalMs: 0
    };

    const reservation = normalizeHotelReservationPayload({
      id: "reservation_hotel_001",
      property: "Park Hyatt Tokyo",
      chain: "hyatt",
      propertyId: "tyoph",
      checkIn: "2026-09-12",
      checkOut: "2026-09-15",
      paidRate: 455,
      paidCurrency: "USD"
    });
    const request = hotelSearchRequestFromReservation(reservation);
    const saved = await createHotelSavedSearch(
      {
        name: "Park Hyatt Tokyo",
        request
      },
      { fetch, config }
    );
    const run = await runHotelSavedSearch(
      "saved_hotel_001",
      { forceRefresh: true },
      { fetch, config }
    );
    const job = await waitForHotelJob("job_hotel_001", { fetch, config, sleep: async () => {} });

    expect(saved).toMatchObject({
      ok: true,
      body: {
        id: "saved_hotel_001"
      }
    });
    expect(request).toMatchObject({
      providers: ["hyatt"],
      mode: "hotel",
      hotel_id: "tyoph",
      checkin: "2026-09-12",
      checkout: "2026-09-15",
      display_currency: "USD"
    });
    expect(run.body).toMatchObject({ job_id: "job_hotel_001" });
    expect(job.body).toMatchObject({ status: "completed" });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:8720/api/saved-searches",
      "http://127.0.0.1:8720/api/saved-searches/saved_hotel_001/run",
      "http://127.0.0.1:8720/api/jobs/job_hotel_001"
    ]);
  });

  test("Hotel rate jobs normalize cheapest cancellable drops with cancellation deadline", () => {
    const reservation = normalizeHotelReservationPayload({
      id: "reservation_hotel_002",
      property: "InterContinental Osaka",
      chain: "ihg",
      propertyId: "OSAHA",
      checkIn: "2026-10-01",
      checkOut: "2026-10-04",
      paidRate: 520,
      paidCurrency: "USD",
      roomClass: "classic",
      cancellationDeadline: "2026-09-25T18:00:00+09:00"
    });
    const watch = normalizeHotelRateWatchFromJob(
      {
        ...reservation,
        hotelRateFinder: {
          savedSearchId: "saved_hotel_002"
        }
      },
      {
        id: "job_hotel_002",
        status: "completed",
        report: {
          hotels: [
            {
              hotel_id: "OSAHA",
              hotel_name: "InterContinental Osaka",
              rates: [
                {
                  comparison: "cheapest_non_corp",
                  candidate: {
                    amount: 430,
                    currency: "USD",
                    room_name: "Classic room",
                    cancellation_policy: "Non-refundable. Full prepayment required."
                  }
                },
                {
                  comparison: "cheapest_flexible",
                  candidate: {
                    amount: 455,
                    currency: "USD",
                    room_name: "Classic room",
                    cancellation_policy: "Fully refundable before Sep 25, 2026",
                    points_rate: {
                      points: 35000
                    }
                  }
                }
              ]
            }
          ]
        }
      },
      { priceDropThreshold: 25 }
    );
    const alert = hotelRateDropAlert(reservation, watch);

    expect(watch).toMatchObject({
      id: "hotel_reservation_hotel_002",
      status: "price-drop",
      bestRate: 455,
      targetRate: 520,
      cancellationDeadline: "2026-09-25T18:00:00+09:00",
      savedSearchId: "saved_hotel_002"
    });
    expect(watch.cancellationPolicy).toBe("Fully refundable before Sep 25, 2026");
    expect(alert).toMatchObject({
      severity: "medium",
      source: "hotel-rate-finder"
    });
    expect(alert.detail).toContain("Cancellation deadline: 2026-09-25T18:00:00+09:00");
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
      normalizeSourceEvent("hotel-rate-finder", {
        id: "reservation_hotel_003",
        type: "hotel",
        property: "Andaz Tokyo",
        chain: "hyatt",
        propertyId: "tyoaz",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
        paidRate: "488",
        cancellationDeadline: "2026-09-10T18:00:00+09:00"
      })
    ).toMatchObject({
      kind: "reservation",
      value: {
        id: "reservation_hotel_003",
        property: "Andaz Tokyo",
        paidRate: 488,
        status: "watching"
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

    expect(
      normalizeSourceEvent("flights-extension", {
        origin: "TYO",
        destination: "SIN",
        providers: "google-flights"
      })
    ).toMatchObject({
      kind: "flightSearchWatch",
      value: {
        route: "TYO-SIN",
        providers: ["google-flights"]
      }
    });

    expect(
      normalizeSourceEvent("asia-travel-deals", {
        id: "deal_candidate_123",
        deal_group_id: "deal_group_123",
        headline: "Taipei to Bangkok business class",
        origin_airports: ["TPE"],
        destination_airports: ["BKK"],
        price_usd: 812,
        deal_score: 82,
        status: "needs_verification"
      })
    ).toMatchObject({
      kind: "travelDeal",
      value: {
        id: "deal_candidate_123",
        dealGroupId: "deal_group_123",
        route: "TPE-BKK",
        price: 812,
        score: 82,
        status: "needs_verification"
      }
    });

    expect(
      normalizeSourceEvent("plaid", {
        transactionId: "plaid_txn_001",
        merchant: "Hyatt",
        amount: "455.12",
        accountName: "Amex Platinum",
        pending: true
      })
    ).toMatchObject({
      kind: "transaction",
      value: {
        id: "plaid_txn_001",
        merchant: "Hyatt",
        amount: 455.12,
        card: "Amex Platinum",
        status: "pending"
      }
    });
  });

  test("dashboard store upserts normalized module events over the fixture contract", async () => {
    const filePath = `${process.env.TMPDIR ?? "/tmp"}/personal-dashboard-store-${Date.now()}.json`;

    await upsertNormalizedEvent(filePath, {
      kind: "travelDeal",
      value: {
        id: "deal_store_001",
        title: "Tokyo to Seoul candidate",
        route: "TYO-SEL",
        price: 244,
        source: "asia-travel-deals",
        confidence: "score 91",
        status: "needs_verification",
        score: 91
      }
    });
    await upsertNormalizedEvent(filePath, {
      kind: "transaction",
      value: {
        id: "txn_store_001",
        merchant: "Hyatt",
        amount: 455.12,
        category: "Travel",
        card: "Amex Platinum",
        status: "pending"
      }
    });
    await upsertHermesAction(filePath, {
      id: "action_store_001",
      capabilityId: "asia_deal_verify",
      target: "asia-travel-deals",
      title: "Verify deal",
      status: "queued",
      payload: { dealId: "deal_store_001" }
    });

    const dashboard = await loadDashboard(dashboardFixture(), filePath);
    expect(dashboard.travel.dealFeed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "deal_store_001",
          score: 91
        })
      ])
    );
    expect(dashboard.hermes.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "action_store_001",
          capabilityId: "asia_deal_verify"
        })
      ])
    );
    expect(dashboard.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "txn_store_001",
          merchant: "Hyatt"
        })
      ])
    );
  });

  test("dashboard store persists Plaid item cursors and synced transactions", async () => {
    const filePath = `${process.env.TMPDIR ?? "/tmp"}/personal-dashboard-plaid-store-${Date.now()}.json`;

    await upsertPlaidItem(filePath, {
      id: "item_123",
      accessToken: "access-sandbox-123",
      cursor: "cursor_0"
    });
    await applyPlaidSync(filePath, "item_123", {
      synced: true,
      cursor: "cursor_1",
      accounts: [
        {
          id: "plaid_account_001",
          name: "Amex Platinum",
          kind: "credit card",
          last4: "1001",
          syncStatus: "synced",
          source: "plaid"
        }
      ],
      added: [
        {
          id: "plaid_txn_001",
          accountId: "plaid_account_001",
          merchant: "Hyatt",
          amount: 455.12,
          category: "TRAVEL",
          card: "Amex Platinum",
          status: "posted",
          source: "plaid"
        }
      ],
      modified: [],
      removed: []
    });

    const dashboard = await loadDashboard(dashboardFixture(), filePath);
    const items = await listPlaidItems(filePath);
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "item_123",
          cursor: "cursor_1",
          syncStatus: "synced"
        })
      ])
    );
    expect(dashboard.finance.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plaid_account_001",
          source: "plaid"
        })
      ])
    );
    expect(dashboard.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plaid_txn_001",
          source: "plaid"
        })
      ])
    );
  });

  test("dashboard store persists hotel reservations, watches, and rate alerts", async () => {
    const filePath = `${process.env.TMPDIR ?? "/tmp"}/personal-dashboard-hotel-store-${Date.now()}.json`;
    const reservation = normalizeHotelReservationPayload({
      id: "reservation_hotel_store_001",
      property: "Park Hyatt Kyoto",
      chain: "hyatt",
      propertyId: "kyoto",
      checkIn: "2026-08-20",
      checkOut: "2026-08-23",
      paidRate: 700,
      paidCurrency: "USD"
    });
    const watch = {
      id: "hotel_reservation_hotel_store_001",
      reservationId: reservation.id,
      property: "Park Hyatt Kyoto",
      location: "Kyoto",
      checkIn: "2026-08-20",
      checkOut: "2026-08-23",
      targetRate: 700,
      bestRate: 640,
      currency: "USD",
      source: "hotel-rate-finder",
      status: "price-drop",
      jobId: "job_hotel_store_001",
      savedSearchId: "saved_hotel_store_001"
    };

    await upsertHotelReservation(filePath, reservation);
    await applyHotelRateWatch(filePath, reservation, watch, [
      {
        id: "alert_hotel_store_001",
        title: "Park Hyatt Kyoto cancellable rate dropped",
        detail: "Current cancellable rate is USD 640.",
        severity: "medium",
        source: "hotel-rate-finder"
      }
    ]);

    const dashboard = await loadDashboard(dashboardFixture(), filePath);
    expect(dashboard.travel.reservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "reservation_hotel_store_001",
          hotelRateFinder: expect.objectContaining({
            savedSearchId: "saved_hotel_store_001",
            lastJobId: "job_hotel_store_001"
          })
        })
      ])
    );
    expect(dashboard.travel.hotelWatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "hotel_reservation_hotel_store_001",
          status: "price-drop",
          bestRate: 640
        })
      ])
    );
    expect(dashboard.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "alert_hotel_store_001",
          source: "hotel-rate-finder"
        })
      ])
    );
  });
});
