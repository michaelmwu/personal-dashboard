import { describe, expect, test } from "bun:test";

import {
  compactFlightSearchJob,
  createFlightSearch,
  flightSearcherHermesContext,
  getFlightChallengeScreenshot,
  normalizeFlightSearchRequest
} from "../packages/integrations/flight-searcher.mjs";

const config = {
  baseUrl: "http://127.0.0.1:8730",
  apiToken: "flight-service-secret",
  timeoutMs: 1_000
};

describe("Flight Searcher integration", () => {
  test("normalizes dashboard and Hermes search inputs to the service contract", () => {
    expect(
      normalizeFlightSearchRequest({
        origin: "HND, NRT",
        destination: "JFK",
        departure_start: "2026-11-01",
        departure_end: "2026-11-05",
        return_start: "2026-11-10",
        passengers: "2",
        cabins: ["business"],
        providers: ["seats_aero", "ana"],
        max_stops: "1",
        max_points: "75000",
        seats_aero_sources: "aeroplan, united"
      })
    ).toEqual({
      origins: ["HND", "NRT"],
      destinations: ["JFK"],
      departureStart: "2026-11-01",
      departureEnd: "2026-11-05",
      returnStart: "2026-11-10",
      returnEnd: "2026-11-10",
      passengers: 2,
      cabins: ["business"],
      providers: ["seats_aero", "ana"],
      maxStops: 1,
      maxPoints: 75000,
      seatsAeroSources: ["aeroplan", "united"]
    });
  });

  test("sends the service token only as a bearer header", async () => {
    let observed;
    const result = await createFlightSearch(
      {
        origins: ["HND"],
        destinations: ["JFK"],
        departureStart: "2026-11-01",
        cabins: ["first"],
        providers: ["seats_aero"],
        maxPoints: 75000,
        maxStops: 0
      },
      {
        config,
        fetch: async (url, options) => {
          observed = { url: String(url), options };
          return Response.json({ id: "search_123", status: "queued" }, { status: 202 });
        }
      }
    );

    expect(result).toMatchObject({ ok: true, status: 202, body: { id: "search_123" } });
    expect(observed.url).toBe("http://127.0.0.1:8730/api/searches");
    expect(observed.url).not.toContain(config.apiToken);
    expect(observed.options.headers.Authorization).toBe(`Bearer ${config.apiToken}`);
    expect(JSON.parse(observed.options.body)).toMatchObject({
      origins: ["HND"],
      destinations: ["JFK"],
      departureStart: "2026-11-01",
      providers: ["seats_aero"],
      maxPoints: 75000,
      maxStops: 0
    });
  });

  test("keeps handoff URLs out of compact Hermes context", async () => {
    const job = {
      id: "search_waiting",
      status: "waiting_human",
      request: { origins: ["HND"], destinations: ["JFK"] },
      providers: {
        jal: {
          state: "waiting_human",
          resultCount: 0,
          challenge: {
            id: "challenge_sms",
            provider: "jal",
            kind: "sms_otp",
            prompt: "Enter the SMS code.",
            status: "pending",
            screenshotAvailable: true,
            handoffUrl: "https://private.example/session",
            expiresAt: "2026-11-01T12:00:00Z"
          }
        }
      },
      results: [],
      createdAt: "2026-11-01T10:00:00Z",
      updatedAt: "2026-11-01T10:01:00Z"
    };

    const compact = compactFlightSearchJob(job);
    expect(compact.providers.jal.challenge).not.toHaveProperty("handoffUrl");

    const context = await flightSearcherHermesContext({
      config,
      fetch: async () => Response.json([job])
    });
    expect(context).toMatchObject({
      configured: true,
      available: true,
      emailAccess: false,
      searches: [{ id: "search_waiting", status: "waiting_human" }]
    });
    expect(JSON.stringify(context)).not.toContain("private.example");
  });

  test("proxies challenge screenshots as bytes without decoding them", async () => {
    const png = Uint8Array.from([137, 80, 78, 71]);
    const result = await getFlightChallengeScreenshot("job/unsafe", "challenge 1", {
      config,
      fetch: async (url) => {
        expect(String(url)).toContain("job%2Funsafe/challenges/challenge%201/screenshot");
        return new Response(png, { headers: { "Content-Type": "image/png" } });
      }
    });

    expect(result.ok).toBe(true);
    expect(result.contentType).toBe("image/png");
    expect([...result.body]).toEqual([...png]);
  });
});
