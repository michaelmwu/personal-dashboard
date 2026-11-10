import { describe, expect, test } from "bun:test";
import { hotelJobForHermes } from "../packages/integrations/hotel-rates.mjs";

describe("Hermes hotel job results", () => {
  test("keeps prices and terms while excluding raw provider data", () => {
    const job = {
      id: "job-1",
      status: "completed",
      report: {
        raw_results: "x".repeat(3_000_000),
        provider_errors: [],
        hotels: [
          {
            hotel_id: "cslth",
            hotel_name: "The Cape",
            rates: [
              {
                corp_code: "123",
                candidate: {
                  amount: 123,
                  currency: "USD",
                  total_after_tax: 145,
                  cancellation_policy: "Refundable",
                  room_name: "King",
                  context: "x".repeat(500_000)
                }
              }
            ]
          }
        ]
      }
    };
    const result = hotelJobForHermes(job);
    expect(result.report.hotels[0].rates[0].candidate).toMatchObject({
      amount: 123,
      currency: "USD",
      total_after_tax: 145,
      cancellation_policy: "Refundable"
    });
    expect(JSON.stringify(result).length).toBeLessThan(10_000);
    expect(result.report.results_truncated).toBe(false);
    expect(job.report.raw_results.length).toBe(3_000_000);
  });

  test("marks results truncated when rate data exceeds the budget", () => {
    const rates = Array.from({ length: 500 }, () => ({
      candidate: { room_name: "x".repeat(1000), amount: 12 }
    }));
    const result = hotelJobForHermes({ status: "completed", report: { hotels: [{ rates }] } });
    expect(result.report.results_truncated).toBe(true);
    expect(result.report.hotels[0].rates.length).toBeLessThan(rates.length);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(129 * 1024);
  });
  test("preserves jobs without a report", () => {
    expect(hotelJobForHermes({ status: "running" })).toEqual({ status: "running" });
  });
});
