function compareNumeric(left, right, direction) {
  const leftKnown = typeof left === "number" && Number.isFinite(left);
  const rightKnown = typeof right === "number" && Number.isFinite(right);
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  if (!leftKnown) return 0;
  return (left - right) * direction;
}

function compareText(left, right, direction) {
  const leftValue = String(left ?? "");
  const rightValue = String(right ?? "");
  if (!leftValue && rightValue) return 1;
  if (leftValue && !rightValue) return -1;
  return leftValue.localeCompare(rightValue) * direction;
}

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

export function sortAwardResults(results, order = "date", sortDirection = "asc") {
  const direction = sortDirection === "desc" ? -1 : 1;
  return [...results].sort((a, b) => {
    const availability = Number(isWaitlistResult(a)) - Number(isWaitlistResult(b));
    const date = compareText(a.departureDate, b.departureDate, direction);
    const points = compareNumeric(a.mileage, b.mileage, direction);
    const stops = compareNumeric(a.stops, b.stops, direction);
    if (order === "points") return availability || points || date || stops || 0;
    if (order === "stops") return availability || stops || points || date || 0;
    return availability || date || points || stops || 0;
  });
}
