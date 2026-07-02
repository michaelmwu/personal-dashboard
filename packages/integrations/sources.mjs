import {
  financeAccount,
  flightSearchWatch,
  hotelRateWatch,
  intakeItem,
  integrationStatus,
  reservation,
  travelDeal
} from "../contracts/index.mjs";

export function integrationCatalog() {
  return [
    integrationStatus({
      id: "hotel_rate_finder",
      name: "Hotel rate finder",
      sourceRepo: "~/dev/hotel_rate_finder",
      adapter: "hotel-rate-finder",
      stage: "adapter-contract",
      nextStep: "Emit property/date/rate observations into dashboard watches."
    }),
    integrationStatus({
      id: "flights_extension",
      name: "Flight finder",
      sourceRepo: "~/dev/flights-extension",
      adapter: "flights-extension",
      stage: "adapter-contract",
      nextStep: "Port Google Flights and Skyscanner search payloads behind one route watch."
    }),
    integrationStatus({
      id: "asia_travel_deals",
      name: "Asia deal feed",
      sourceRepo: "~/dev/asiatraveldeals",
      adapter: "asia-travel-deals",
      stage: "adapter-contract",
      nextStep: "Expose reviewed deal candidates as a compact personal feed."
    }),
    integrationStatus({
      id: "plaid",
      name: "Plaid transactions",
      sourceRepo: "external:plaid",
      adapter: "plaid",
      stage: "placeholder",
      nextStep: "Sync account and card transactions into reconciliation surfaces."
    }),
    integrationStatus({
      id: "gmail_intake",
      name: "Gmail intake",
      sourceRepo: "external:gmail",
      adapter: "gmail-intake",
      stage: "placeholder",
      nextStep: "Classify travel confirmations, statements, and important email."
    })
  ];
}

export function supportedSourceAdapters() {
  return integrationCatalog().map((integration) => integration.adapter);
}

export function isSupportedSourceAdapter(source) {
  return supportedSourceAdapters().includes(source);
}

export function normalizeHotelRatePayload(payload) {
  return hotelRateWatch({
    id: payload.id ?? `hotel_${Date.now()}`,
    property: payload.property ?? payload.hotelName ?? "Unknown hotel",
    location: payload.location ?? "Unknown location",
    checkIn: payload.checkIn ?? payload.check_in ?? "TBD",
    checkOut: payload.checkOut ?? payload.check_out ?? "TBD",
    targetRate: Number(payload.targetRate ?? payload.target_rate ?? 0),
    bestRate: Number(payload.bestRate ?? payload.best_rate ?? payload.rate ?? 0),
    source: payload.source ?? "hotel-rate-finder",
    status: payload.status ?? "watching"
  });
}

export function normalizeFlightSearchPayload(payload) {
  const defaultProviders = ["google-flights", "skyscanner"];
  const providers = Array.isArray(payload.providers)
    ? payload.providers
    : typeof payload.providers === "string" && payload.providers.trim()
      ? [payload.providers]
      : defaultProviders;

  return flightSearchWatch({
    id: payload.id ?? `flight_${Date.now()}`,
    route: payload.route ?? `${payload.origin ?? "?"}-${payload.destination ?? "?"}`,
    dates: payload.dates ?? payload.dateRange ?? "Flexible",
    providers,
    targetPrice: Number(payload.targetPrice ?? payload.target_price ?? 0),
    bestPrice: Number(payload.bestPrice ?? payload.best_price ?? payload.price ?? 0),
    status: payload.status ?? "watching"
  });
}

export function normalizeAsiaDealPayload(payload) {
  return travelDeal({
    id: payload.id ?? `deal_${Date.now()}`,
    title: payload.title ?? "Untitled travel deal",
    route: payload.route ?? "Asia",
    price: Number(payload.price ?? payload.priceUsd ?? payload.price_usd ?? 0),
    source: payload.source ?? "asia-travel-deals",
    confidence: payload.confidence ?? payload.score ?? "review",
    status: payload.status ?? "candidate"
  });
}

export function normalizePlaidPayload(payload) {
  return financeAccount({
    id: payload.id ?? payload.account_id ?? `acct_${Date.now()}`,
    name: payload.name ?? "Unknown account",
    kind: payload.kind ?? payload.type ?? "credit",
    last4: payload.last4 ?? payload.mask ?? "----",
    syncStatus: payload.syncStatus ?? "pending"
  });
}

export function normalizeGmailPayload(payload) {
  if (payload.reservationType || payload.travelDate || payload.confirmationCode) {
    return reservation({
      id: payload.id ?? `reservation_${Date.now()}`,
      type: payload.reservationType ?? "travel",
      title: payload.title ?? payload.subject ?? "Travel reservation",
      dates: payload.dates ?? payload.travelDate ?? "TBD",
      source: "gmail",
      status: payload.status ?? "needs-review"
    });
  }

  return intakeItem({
    id: payload.id ?? `mail_${Date.now()}`,
    source: "gmail",
    title: payload.title ?? payload.subject ?? "Untitled email",
    detail: payload.detail ?? payload.snippet ?? "No summary yet.",
    classification: payload.classification ?? "important",
    state: payload.state ?? "needs-review",
    receivedAt: payload.receivedAt ?? new Date().toISOString()
  });
}

export function normalizeSourceEvent(source, payload) {
  switch (source) {
    case "hotel-rate-finder":
      return { kind: "hotelRateWatch", value: normalizeHotelRatePayload(payload) };
    case "flights-extension":
      return { kind: "flightSearchWatch", value: normalizeFlightSearchPayload(payload) };
    case "asia-travel-deals":
      return { kind: "travelDeal", value: normalizeAsiaDealPayload(payload) };
    case "plaid":
      return { kind: "financeAccount", value: normalizePlaidPayload(payload) };
    case "gmail-intake":
      return {
        kind:
          payload.reservationType || payload.travelDate || payload.confirmationCode
            ? "reservation"
            : "intakeItem",
        value: normalizeGmailPayload(payload)
      };
    default:
      return { kind: "unknown", value: payload };
  }
}
