const numeric = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;

export function isWaitlistResult(result) {
  return result?.availabilityStatus === "waitlist";
}

export function partitionAwardResults(results) {
  const available = [];
  const waitlist = [];
  for (const result of results) {
    (isWaitlistResult(result) ? waitlist : available).push(result);
  }
  return { available, waitlist };
}

export function sortAwardResults(results, order = "date") {
  return [...results].sort((a, b) => {
    const availability = Number(isWaitlistResult(a)) - Number(isWaitlistResult(b));
    const date = String(a.departureDate ?? "").localeCompare(String(b.departureDate ?? ""));
    const points = numeric(a.mileage) - numeric(b.mileage);
    const stops = numeric(a.stops) - numeric(b.stops);
    if (order === "points") return availability || points || date || stops || 0;
    if (order === "stops") return availability || stops || points || date || 0;
    return availability || date || points || stops || 0;
  });
}
