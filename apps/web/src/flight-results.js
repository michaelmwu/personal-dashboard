const numeric = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;

export function sortAwardResults(results, order = "date") {
  return [...results].sort((a, b) => {
    const date = String(a.departureDate ?? "").localeCompare(String(b.departureDate ?? ""));
    const points = numeric(a.mileage) - numeric(b.mileage);
    const stops = numeric(a.stops) - numeric(b.stops);
    if (order === "points") return points || date || stops || 0;
    if (order === "stops") return stops || points || date || 0;
    return date || points || stops || 0;
  });
}
