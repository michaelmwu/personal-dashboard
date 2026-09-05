import { expect, test } from "bun:test";
import { sortAwardResults } from "../apps/web/src/flight-results.js";

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
  expect(results[0].id).toBe("unknown");
});
