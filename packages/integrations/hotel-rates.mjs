const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "canceled"]);
const NON_REFUNDABLE_MARKERS = [
  "non refundable",
  "non-refundable",
  "nonrefundable",
  "no refund",
  "no changes",
  "full prepayment"
];

export function hotelRatesConfig(env = process.env) {
  return {
    baseUrl: env.HOTEL_RATE_FINDER_API_BASE_URL ?? "",
    priceDropThreshold: Number.parseFloat(env.HOTEL_RATE_DROP_THRESHOLD ?? "25"),
    pollIntervalMs: Number.parseInt(env.HOTEL_RATE_JOB_POLL_INTERVAL_MS ?? "1500", 10),
    pollAttempts: Number.parseInt(env.HOTEL_RATE_JOB_POLL_ATTEMPTS ?? "20", 10),
    forceRefresh: env.HOTEL_RATE_FORCE_REFRESH === "true"
  };
}

export function isHotelRatesConfigured(config = hotelRatesConfig()) {
  return Boolean(config.baseUrl);
}

function cleanBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, "");
}

function joinUrl(baseUrl, path) {
  if (/^https?:\/\//.test(path)) {
    return path;
  }
  return `${cleanBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

async function readJsonResponse(response) {
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body
    };
  }
  return {
    ok: true,
    status: response.status,
    body
  };
}

async function hotelRatesFetch(path, options = {}) {
  const config = options.config ?? hotelRatesConfig();
  if (!isHotelRatesConfigured(config)) {
    return {
      ok: false,
      status: 0,
      body: { error: "missing_hotel_rate_finder_api_base_url" }
    };
  }

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(joinUrl(config.baseUrl, path), {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return readJsonResponse(response);
}

export async function createHotelAgentSearch(request, options = {}) {
  return hotelRatesFetch("/api/agent/search", {
    ...options,
    method: "POST",
    body: request
  });
}

export async function listHotelSavedSearches(options = {}) {
  return hotelRatesFetch("/api/saved-searches", options);
}

export async function createHotelSavedSearch({ name, request }, options = {}) {
  return hotelRatesFetch("/api/saved-searches", {
    ...options,
    method: "POST",
    body: { name, request }
  });
}

export async function getHotelSavedSearch(savedSearchId, options = {}) {
  return hotelRatesFetch(`/api/saved-searches/${encodeURIComponent(savedSearchId)}`, options);
}

export async function runHotelSavedSearch(
  savedSearchId,
  { forceRefresh = false } = {},
  options = {}
) {
  return hotelRatesFetch(`/api/saved-searches/${encodeURIComponent(savedSearchId)}/run`, {
    ...options,
    method: "POST",
    body: { force_refresh: forceRefresh }
  });
}

export async function getHotelJob(jobId, options = {}) {
  return hotelRatesFetch(`/api/jobs/${encodeURIComponent(jobId)}`, options);
}

export async function cancelHotelJob(jobId, options = {}) {
  return hotelRatesFetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    ...options,
    method: "POST",
    body: {}
  });
}

export async function waitForHotelJob(jobId, options = {}) {
  const config = options.config ?? hotelRatesConfig();
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastResponse;
  for (let attempt = 0; attempt < config.pollAttempts; attempt += 1) {
    lastResponse = await getHotelJob(jobId, options);
    const status = lastResponse.body?.status;
    if (!lastResponse.ok || TERMINAL_JOB_STATUSES.has(status)) {
      return {
        ...lastResponse,
        timedOut: false,
        attempts: attempt + 1
      };
    }
    await sleep(config.pollIntervalMs);
  }
  return {
    ...(lastResponse ?? { ok: false, status: 0, body: {} }),
    timedOut: true,
    attempts: config.pollAttempts
  };
}

export function hotelReservationIsWatchable(reservation) {
  const provider = hotelProviderForReservation(reservation);
  return Boolean(
    reservation?.type === "hotel" &&
      provider &&
      (reservation.checkIn || reservation.check_in) &&
      (reservation.checkOut || reservation.check_out) &&
      (reservation.paidRate ||
        reservation.paid_rate ||
        reservation.paidTotal ||
        reservation.paid_total)
  );
}

export function hotelProviderForReservation(reservation) {
  const chain = String(reservation.chain ?? reservation.provider ?? "").toLowerCase();
  if (chain.includes("hyatt")) {
    return "hyatt";
  }
  if (
    chain.includes("ihg") ||
    chain.includes("intercontinental") ||
    chain.includes("holiday inn")
  ) {
    return "ihg";
  }
  return undefined;
}

export function hotelSearchRequestFromReservation(reservation) {
  const provider = hotelProviderForReservation(reservation);
  const propertyId =
    reservation.propertyId ??
    reservation.property_id ??
    reservation.hotelId ??
    reservation.hotel_id ??
    reservation.chainPropertyId ??
    reservation.chain_property_id;
  const location = reservation.location ?? reservation.area;
  const mode = propertyId ? "hotel" : "region";
  return {
    providers: provider ? [provider] : ["hyatt", "ihg"],
    mode,
    ...(mode === "hotel" ? { hotel_id: propertyId } : { area: location ?? reservation.title }),
    checkin: reservation.checkIn ?? reservation.check_in,
    checkout: reservation.checkOut ?? reservation.check_out,
    rooms: Number(reservation.rooms ?? 1),
    adults: Number(reservation.adults ?? 2),
    kids: Number(reservation.kids ?? reservation.children ?? 0),
    display_currency: String(
      reservation.paidCurrency ?? reservation.currency ?? "USD"
    ).toUpperCase(),
    ...(provider === "ihg" ? { ihg_try_corp_if_no_rate: true } : {})
  };
}

export function hotelSavedSearchName(reservation) {
  const property = reservation.property ?? reservation.title ?? "Hotel reservation";
  const checkIn = reservation.checkIn ?? reservation.check_in ?? "TBD";
  const checkOut = reservation.checkOut ?? reservation.check_out ?? "TBD";
  return `${property} ${checkIn}-${checkOut}`.slice(0, 120);
}

export function normalizeHotelReservationPayload(payload) {
  const id =
    payload.id ?? payload.reservationId ?? payload.reservation_id ?? `reservation_${Date.now()}`;
  return {
    id,
    type: "hotel",
    title: payload.title ?? payload.property ?? payload.hotelName ?? "Hotel reservation",
    property: payload.property ?? payload.hotelName ?? payload.title,
    location: payload.location ?? payload.area,
    dates:
      payload.dates ??
      `${payload.checkIn ?? payload.check_in ?? "TBD"} to ${payload.checkOut ?? payload.check_out ?? "TBD"}`,
    checkIn: payload.checkIn ?? payload.check_in,
    checkOut: payload.checkOut ?? payload.check_out,
    confirmationNumber: payload.confirmationNumber ?? payload.confirmation_number,
    paidRate: numberOrUndefined(
      payload.paidRate ?? payload.paid_rate ?? payload.paidTotal ?? payload.paid_total
    ),
    paidCurrency: payload.paidCurrency ?? payload.currency ?? "USD",
    roomClass: payload.roomClass ?? payload.room_class,
    cancellationPolicy: payload.cancellationPolicy ?? payload.cancellation_policy,
    cancellationDeadline: payload.cancellationDeadline ?? payload.cancellation_deadline,
    chain: payload.chain ?? payload.provider,
    provider: payload.provider ?? payload.chain,
    propertyId:
      payload.propertyId ??
      payload.property_id ??
      payload.hotelId ??
      payload.hotel_id ??
      payload.chainPropertyId ??
      payload.chain_property_id,
    refundable:
      payload.refundable ??
      !isNonRefundableText(payload.cancellationPolicy ?? payload.cancellation_policy),
    source: payload.source ?? "manual",
    status: payload.status ?? "watching",
    hotelRateFinder: payload.hotelRateFinder ?? payload.hotel_rate_finder
  };
}

function numberOrUndefined(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isNonRefundableText(text) {
  const normalized = String(text ?? "").toLowerCase();
  return NON_REFUNDABLE_MARKERS.some((marker) => normalized.includes(marker));
}

function candidateAmount(candidate, currency) {
  if (!candidate) {
    return undefined;
  }
  const targetCurrency = String(currency ?? "").toUpperCase();
  const fx = targetCurrency ? candidate.fx?.[targetCurrency] : undefined;
  const nativeCurrency = String(candidate.currency ?? "").toUpperCase();
  const values = fx
    ? [fx.total_after_tax, fx.rate_after_tax, fx.total_before_tax, fx.rate_before_tax]
    : nativeCurrency && nativeCurrency === targetCurrency
      ? [
          candidate.adjusted_total_after_tax,
          candidate.total_after_tax,
          candidate.rate_after_tax,
          candidate.amount,
          candidate.adjusted_total_before_tax,
          candidate.total_before_tax,
          candidate.rate_before_tax
        ]
      : [];
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function candidateCurrency(candidate, fallback) {
  return String(fallback ?? candidate?.currency ?? "USD").toUpperCase();
}

function candidatePolicy(candidate) {
  return (
    candidate?.cancellation_policy ?? candidate?.cancellationPolicy ?? candidate?.deposit_policy
  );
}

function candidateIsCancellable(candidate) {
  if (!candidate) {
    return false;
  }
  if (candidate.is_non_refundable === true || candidate.is_refundable === false) {
    return false;
  }
  if (candidate.is_refundable === true) {
    return true;
  }
  const text = String(candidatePolicy(candidate) ?? candidate.rate_name ?? "").toLowerCase();
  if (isNonRefundableText(text)) {
    return false;
  }
  return Boolean(
    text.includes("refundable") ||
      text.includes("free cancellation") ||
      text.includes("cancel before") ||
      text.includes("cancellable")
  );
}

function reservationRoomMatchesCandidate(reservation, candidate) {
  const roomClass = String(reservation.roomClass ?? reservation.room_class ?? "").toLowerCase();
  if (!roomClass) {
    return true;
  }
  const candidateRoom = String(
    candidate?.room_name ?? candidate?.roomName ?? candidate?.room_type ?? candidate?.roomType ?? ""
  ).toLowerCase();
  return !candidateRoom || candidateRoom.includes(roomClass) || roomClass.includes(candidateRoom);
}

function scoreRateRow(row, reservation) {
  const candidate = row?.candidate;
  if (!candidate) {
    return undefined;
  }
  const amount = candidateAmount(candidate, reservation.paidCurrency ?? reservation.currency);
  if (amount === undefined) {
    return undefined;
  }
  if (!candidateIsCancellable(candidate) && row.comparison !== "cheapest_flexible") {
    return undefined;
  }
  if (!reservationRoomMatchesCandidate(reservation, candidate)) {
    return undefined;
  }
  return { row, candidate, amount };
}

function matchingHotel(report, reservation) {
  const hotels = Array.isArray(report?.hotels) ? report.hotels : [];
  if (hotels.length === 0) {
    return undefined;
  }
  const propertyId = String(reservation.propertyId ?? reservation.hotelId ?? "").toLowerCase();
  const propertyName = String(reservation.property ?? reservation.title ?? "").toLowerCase();
  return (
    hotels.find(
      (hotel) => propertyId && String(hotel.hotel_id ?? "").toLowerCase() === propertyId
    ) ??
    hotels.find(
      (hotel) =>
        propertyName &&
        String(hotel.hotel_name ?? "")
          .toLowerCase()
          .includes(propertyName)
    ) ??
    hotels[0]
  );
}

function comparableRate(hotel, reservation) {
  const rows = Array.isArray(hotel?.rates) ? hotel.rates : [];
  const preferred = rows.find((row) => row.comparison === "cheapest_flexible");
  const scored = [preferred, ...rows]
    .filter(Boolean)
    .map((row) => scoreRateRow(row, reservation))
    .filter(Boolean)
    .sort((left, right) => left.amount - right.amount);
  return scored[0];
}

function pointsAlternative(hotel) {
  const candidates = (hotel?.rates ?? [])
    .flatMap((row) => [row?.candidate, row?.candidate?.points_rate, row?.cheapest_non_corp])
    .filter(Boolean);
  const pointsCandidate = candidates.find((candidate) => candidate.points || candidate.points_rate);
  if (!pointsCandidate) {
    return undefined;
  }
  return {
    points: pointsCandidate.points ?? pointsCandidate.points_rate?.points,
    centsPerPoint: pointsCandidate.cents_per_point ?? pointsCandidate.points_rate?.cents_per_point,
    rateName: pointsCandidate.rate_name ?? pointsCandidate.points_rate?.rate_name
  };
}

export function normalizeHotelRateWatchFromJob(reservation, job, options = {}) {
  const threshold = Number(options.priceDropThreshold ?? hotelRatesConfig().priceDropThreshold);
  const paidRate = numberOrUndefined(
    reservation.paidRate ?? reservation.paid_rate ?? reservation.paidTotal
  );
  const report = job?.report;
  const hotel = matchingHotel(report, reservation);
  const rate = comparableRate(hotel, reservation);
  const bestRate = rate?.amount;
  const currency = candidateCurrency(
    rate?.candidate,
    reservation.paidCurrency ?? reservation.currency
  );
  const terminalStatus = TERMINAL_JOB_STATUSES.has(job?.status);
  const failed =
    (terminalStatus && job?.status !== "completed") ||
    (Array.isArray(report?.provider_errors) && report.provider_errors.length > 0 && !rate);
  const status = failed
    ? "failed"
    : bestRate !== undefined && paidRate !== undefined && bestRate < paidRate - threshold
      ? "price-drop"
      : bestRate !== undefined
        ? "watching"
        : (job?.status ?? "pending");

  return {
    id: reservation.hotelWatchId ?? `hotel_${reservation.id}`,
    reservationId: reservation.id,
    property: reservation.property ?? reservation.title ?? hotel?.hotel_name ?? "Hotel reservation",
    location: reservation.location ?? hotel?.hotel_name ?? "Unknown location",
    checkIn: reservation.checkIn ?? reservation.check_in,
    checkOut: reservation.checkOut ?? reservation.check_out,
    targetRate: paidRate,
    bestRate,
    currency,
    source: "hotel-rate-finder",
    status,
    jobId: job?.id ?? job?.job_id,
    savedSearchId: reservation.hotelRateFinder?.savedSearchId ?? reservation.savedSearchId,
    cancellationDeadline: reservation.cancellationDeadline ?? reservation.cancellation_deadline,
    cancellationPolicy: candidatePolicy(rate?.candidate) ?? reservation.cancellationPolicy,
    comparableRate: rate?.candidate,
    comparisonBasis: "cheapest-cancellable-same-room-when-identifiable",
    pointsAlternative: pointsAlternative(hotel),
    error: job?.error,
    providerErrors: report?.provider_errors ?? []
  };
}

export function hotelRateDropAlert(reservation, watch) {
  if (watch.status !== "price-drop") {
    return undefined;
  }
  const currency = watch.currency ?? reservation.paidCurrency ?? "USD";
  const paidRate = numberOrUndefined(
    reservation.paidRate ?? reservation.paid_rate ?? reservation.paidTotal
  );
  const delta =
    paidRate !== undefined && watch.bestRate !== undefined ? paidRate - watch.bestRate : undefined;
  const points = watch.pointsAlternative?.points
    ? ` Points option: ${watch.pointsAlternative.points.toLocaleString("en-US")} points.`
    : "";
  return {
    id: `hotel_rate_drop_${reservation.id}_${watch.currency ?? "USD"}_${watch.bestRate}`,
    title: `${watch.property} cancellable rate dropped`,
    detail: `Current cancellable rate is ${currency} ${watch.bestRate}; paid rate was ${currency} ${paidRate}${delta ? `, down ${currency} ${delta.toFixed(2)}` : ""}. Cancellation deadline: ${watch.cancellationDeadline ?? "unknown"}.${points}`,
    severity: "medium",
    source: "hotel-rate-finder"
  };
}

export function hotelRateFailureAlert(reservation, watch) {
  if (watch.status !== "failed") {
    return undefined;
  }
  return {
    id: `hotel_rate_failed_${reservation.id}_${watch.jobId ?? Date.now()}`,
    title: `${watch.property} rate check failed`,
    detail: `Hotel Rate Finder could not refresh this watch. Cancellation deadline: ${watch.cancellationDeadline ?? "unknown"}.`,
    severity: "medium",
    source: "hotel-rate-finder"
  };
}
