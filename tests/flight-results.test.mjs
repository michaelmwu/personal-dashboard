import { expect, test } from "bun:test";
import {
  isWaitlistResult,
  partitionAwardResults,
  sortAwardResults
} from "../apps/web/src/flight-results.js";

test("sorts points and stops with unknown values last, preserving job data", () => {
  const results = [
    { id: "unknown", departureDate: "2026-11-01", mileage: null, stops: null },
    { id: "cheap", departureDate: "2026-11-03", mileage: 50000, stops: 1 },
    { id: "nonstop", departureDate: "2026-11-02", mileage: 70000, stops: 0 }
  ];
  expect(sortAwardResults(results, "points").map((r) => r.id)).toEqual([
    "cheap",
    "nonstop",
    "unknown"
  ]);
  expect(sortAwardResults(results, "stops").map((r) => r.id)).toEqual([
    "nonstop",
    "cheap",
    "unknown"
  ]);
  expect(sortAwardResults(results).map((r) => r.id)).toEqual(["unknown", "nonstop", "cheap"]);
  expect(sortAwardResults(results, "points", "desc").map((r) => r.id)).toEqual([
    "nonstop",
    "cheap",
    "unknown"
  ]);
  expect(results[0].id).toBe("unknown");
});

test("keeps waitlist inventory separate and after bookable results", () => {
  const results = [
    {
      id: "waitlist",
      departureDate: "2026-09-21",
      mileage: 10_000,
      availabilityStatus: "waitlist"
    },
    {
      id: "available",
      departureDate: "2027-07-10",
      mileage: 75_000,
      availabilityStatus: "available"
    },
    { id: "legacy", departureDate: "2027-07-11", mileage: 80_000 }
  ];

  expect(isWaitlistResult(results[0])).toBe(true);
  expect(isWaitlistResult(results[2])).toBe(false);
  expect(partitionAwardResults(results)).toEqual({
    available: [results[1], results[2]],
    waitlist: [results[0]]
  });
  expect(sortAwardResults(results, "points").map((result) => result.id)).toEqual([
    "available",
    "legacy",
    "waitlist"
  ]);
});
