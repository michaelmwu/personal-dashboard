import {
  financeAccount,
  flightSearchWatch,
  hotelRateWatch,
  intakeItem,
  integrationStatus,
  reservation,
  transaction,
  travelDeal
} from "../contracts/index.mjs";
import {
  normalizeHotelRateWatchFromJob,
  normalizeHotelReservationPayload
} from "./hotel-rates.mjs";
import { normalizePlaidAccount, normalizePlaidTransaction } from "./plaid.mjs";

export function integrationCatalog() {
  return [
    integrationStatus({
      id: "hotel_rate_finder",
      name: "Hotel rate finder",
      sourceRepo: "~/dev/hotel_rate_finder",
      adapter: "hotel-rate-finder",
      stage: "saved-search-sync",
      nextStep: "Run active Hyatt/IHG reservation watches against saved searches."
    }),
    integrationStatus({
      id: "flight_searcher",
      name: "Flight Searcher",
      sourceRepo: "future:~/dev/flight-searcher",
      adapter: "flight-searcher",
      stage: "adapter-contract",
      nextStep: "Run Playwright/cloakbrowser flight searches behind a saved route-watch API."
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
      id: "house_calendar",
      name: "House Calendar",
      sourceRepo: "508-dev/house-calendar",
      adapter: "house-calendar",
      stage: "standalone-app",
      nextStep: "Open the shared household calendar from the dashboard porthole."
    }),
    integrationStatus({
      id: "plaid",
      name: "Plaid transactions",
      sourceRepo: "external:plaid",
      adapter: "plaid",
      stage: "link-and-sync",
      nextStep: "Connect a personal Plaid account and run deterministic /transactions/sync."
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
  if (payload.reservation && payload.job) {
    return normalizeHotelRateWatchFromJob(payload.reservation, payload.job);
  }

  if (payload.type === "hotel" || payload.confirmationNumber || payload.confirmation_number) {
    return normalizeHotelReservationPayload(payload);
  }

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

function objectPayload(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const GMAIL_TRANSACTION_NOTIFICATION_VERSION = "gmail-transaction-notification.v1";
const GMAIL_TRANSACTION_EXTERNAL_ID_LENGTH = 43;
const GMAIL_TRANSACTION_MERCHANT_MAX_LENGTH = 160;
const GMAIL_TRANSACTION_MAX_ABSOLUTE_AMOUNT = 1_000_000_000;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function opaqueGmailTransactionId(value) {
  const id = nonEmptyString(value);
  if (!id || id.length !== GMAIL_TRANSACTION_EXTERNAL_ID_LENGTH) {
    return undefined;
  }

  // The gateway emits a SHA-256-derived base64url identifier. Do not accept a
  // raw Gmail message identifier or any email content as the dashboard key.
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
}

function finiteAmount(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= GMAIL_TRANSACTION_MAX_ABSOLUTE_AMOUNT
      ? value
      : undefined;
  }

  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const amount = Number(value);
  return Number.isFinite(amount) && Math.abs(amount) <= GMAIL_TRANSACTION_MAX_ABSOLUTE_AMOUNT
    ? amount
    : undefined;
}

function currencyCode(value) {
  const currency = nonEmptyString(value);
  return currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : undefined;
}

function cardFromLast4(value) {
  const last4 = nonEmptyString(value);
  return last4 && /^\d{4}$/.test(last4) ? `Card •••• ${last4}` : "Unknown card";
}

function timestamp(value) {
  const candidate = nonEmptyString(value);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}

function displayText(value, maxLength) {
  const text = nonEmptyString(value)?.replace(/\s+/g, " ");
  return text ? text.slice(0, maxLength) : undefined;
}

export function isGmailTransactionNotification(payload) {
  const envelope = objectPayload(payload);
  const hasCanonicalType = envelope.type === "transaction-notification";
  const hasCompatibleEventType =
    (envelope.type === undefined || envelope.type === null || envelope.type === "") &&
    envelope.eventType === "transaction-notification";

  return (
    envelope.version === GMAIL_TRANSACTION_NOTIFICATION_VERSION &&
    (hasCanonicalType || hasCompatibleEventType)
  );
}

function gmailTransactionNotificationCandidate(payload) {
  const envelope = objectPayload(payload);
  const data = objectPayload(envelope.data);
  const explicitCandidate = objectPayload(envelope.candidate);
  const nestedCandidate = objectPayload(data.candidate);
  const candidate = Object.keys(explicitCandidate).length
    ? explicitCandidate
    : Object.keys(nestedCandidate).length
      ? nestedCandidate
      : data;

  const field = (...names) => {
    for (const source of [candidate, data, envelope]) {
      for (const name of names) {
        if (source[name] !== undefined && source[name] !== null) {
          return source[name];
        }
      }
    }
    return undefined;
  };

  return {
    id: field("externalId", "id"),
    merchant: field("merchant"),
    amount: field("amount"),
    currency: field("currency"),
    cardLast4: field("cardLast4"),
    occurredAt: field("occurredAt"),
    authorizedAt: field("authorizedAt")
  };
}

/**
 * Normalize the narrow, gateway-originated transaction fast path. This is
 * deliberately not a generic email-to-transaction parser: only an explicitly
 * typed, versioned gateway event can enter the finance collection.
 */
export function normalizeGmailTransactionNotificationPayload(payload) {
  if (!isGmailTransactionNotification(payload)) {
    return undefined;
  }

  const candidate = gmailTransactionNotificationCandidate(payload);
  const sourceTransactionId = opaqueGmailTransactionId(candidate.id);
  const amount = finiteAmount(candidate.amount);

  // A malformed event must not become a zero-value or non-idempotent finance
  // item. The source event dispatcher will leave it unpersisted.
  if (!sourceTransactionId || amount === undefined) {
    return undefined;
  }

  return transaction({
    id: `gmail_${sourceTransactionId}`,
    merchant:
      displayText(candidate.merchant, GMAIL_TRANSACTION_MERCHANT_MAX_LENGTH) ?? "Unknown merchant",
    amount,
    category: "Unclassified",
    card: cardFromLast4(candidate.cardLast4),
    status: "pending",
    pending: true,
    date: timestamp(candidate.occurredAt),
    authorizedDate: timestamp(candidate.authorizedAt),
    isoCurrencyCode: currencyCode(candidate.currency),
    sourceTransactionId,
    source: "gmail"
  });
}

/**
 * Asia Travel Deals sends a versioned webhook envelope whose candidate lives
 * under `candidate`.  The feed endpoint returns that same candidate shape
 * directly.  Normalize both at this boundary so no application view needs to
 * know about provider-specific webhook structure.
 */
function asiaTravelDealCandidate(payload) {
  const envelope = objectPayload(payload);
  const nestedData = objectPayload(envelope.data);
  const explicitCandidate = objectPayload(envelope.candidate);
  const nestedCandidate = objectPayload(nestedData.candidate);
  const candidate = Object.keys(explicitCandidate).length
    ? explicitCandidate
    : Object.keys(nestedCandidate).length
      ? nestedCandidate
      : Object.keys(nestedData).length
        ? nestedData
        : envelope;
  return {
    ...candidate,
    candidateId: candidate.candidateId ?? envelope.candidateId,
    dealGroupId: candidate.dealGroupId ?? envelope.dealGroupId,
    status: candidate.status ?? envelope.status,
    score: candidate.score ?? envelope.score,
    adminUrl: candidate.adminUrl ?? envelope.adminUrl,
    updatedAt: candidate.updatedAt ?? envelope.occurredAt
  };
}

export function normalizeAsiaDealPayload(payload) {
  const candidate = asiaTravelDealCandidate(payload);
  const originAirports = candidate.originAirports ?? candidate.origin_airports ?? [];
  const destinationAirports = candidate.destinationAirports ?? candidate.destination_airports ?? [];
  const route =
    candidate.route ??
    `${originAirports.join(",") || "Asia"}-${destinationAirports.join(",") || "deal"}`;
  const score = Number(candidate.dealScore ?? candidate.deal_score ?? candidate.score ?? 0);
  const status = candidate.status ?? candidate.reviewStatus ?? "candidate";
  const priceUsd = candidate.priceUsd ?? candidate.price_usd;
  const priceAmount = candidate.priceAmount ?? candidate.price_amount;
  const hasUsdPrice = priceUsd !== undefined && priceUsd !== null;

  return travelDeal({
    id:
      candidate.id ??
      candidate.candidateId ??
      candidate.dealId ??
      candidate.deal_id ??
      `deal_${Date.now()}`,
    title: candidate.title ?? candidate.headline ?? "Untitled travel deal",
    route,
    price: Number(candidate.price ?? priceUsd ?? priceAmount ?? 0),
    currency: candidate.currency ?? (hasUsdPrice ? "USD" : (candidate.priceCurrency ?? "USD")),
    source: candidate.source ?? "asia-travel-deals",
    confidence: candidate.confidence ?? (score ? `score ${score}` : "review"),
    status,
    dealGroupId: candidate.dealGroupId ?? candidate.deal_group_id,
    score,
    verificationStatus:
      candidate.verificationStatus ??
      candidate.verification_status ??
      candidate.reviewStatus ??
      status,
    sourceUrl:
      candidate.sourceUrl ??
      candidate.source_url ??
      candidate.reviewUrl ??
      candidate.review_url ??
      candidate.adminUrl,
    updatedAt: candidate.updatedAt ?? candidate.updated_at
  });
}

export function normalizePlaidPayload(payload) {
  if (payload.account_id && (payload.balances || payload.mask || payload.official_name)) {
    return normalizePlaidAccount(payload);
  }

  if (payload.transaction_id || payload.personal_finance_category) {
    return normalizePlaidTransaction(payload);
  }

  if (payload.merchant || payload.amount || payload.transactionId || payload.transaction_id) {
    return transaction({
      id: payload.id ?? payload.transactionId ?? payload.transaction_id ?? `txn_${Date.now()}`,
      merchant: payload.merchant ?? payload.name ?? "Unknown merchant",
      amount: Number(payload.amount ?? 0),
      category: payload.category ?? "Unclassified",
      categoryDetailed: payload.categoryDetailed ?? payload.category_detailed,
      card: payload.card ?? payload.accountName ?? payload.account_name ?? "Unknown card",
      status: payload.status ?? (payload.pending ? "pending" : "posted"),
      accountId: payload.accountId ?? payload.account_id,
      accountType: payload.accountType ?? payload.account_type,
      accountSubtype: payload.accountSubtype ?? payload.account_subtype,
      institutionName: payload.institutionName ?? payload.institution_name,
      originalDescription: payload.originalDescription ?? payload.original_description,
      transactionCode: payload.transactionCode ?? payload.transaction_code,
      isoCurrencyCode: payload.isoCurrencyCode ?? payload.iso_currency_code,
      originalAmount: payload.originalAmount ?? payload.original_amount,
      originalCurrencyCode: payload.originalCurrencyCode ?? payload.original_currency_code,
      exchangeRate: payload.exchangeRate ?? payload.exchange_rate,
      date: payload.date,
      authorizedDate: payload.authorizedDate ?? payload.authorized_date,
      source: "plaid"
    });
  }

  return financeAccount({
    id: payload.id ?? payload.account_id ?? `acct_${Date.now()}`,
    name: payload.name ?? "Unknown account",
    kind: payload.kind ?? payload.type ?? "credit",
    type: payload.type,
    subtype: payload.subtype,
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
      return {
        kind:
          payload.type === "hotel" || payload.confirmationNumber || payload.confirmation_number
            ? "reservation"
            : "hotelRateWatch",
        value: normalizeHotelRatePayload(payload)
      };
    case "flight-searcher":
      return { kind: "flightSearchWatch", value: normalizeFlightSearchPayload(payload) };
    case "asia-travel-deals":
      return { kind: "travelDeal", value: normalizeAsiaDealPayload(payload) };
    case "plaid":
      return {
        kind:
          payload.merchant || payload.amount || payload.transactionId || payload.transaction_id
            ? "transaction"
            : "financeAccount",
        value: normalizePlaidPayload(payload)
      };
    case "gmail-intake": {
      if (isGmailTransactionNotification(payload)) {
        const normalizedTransaction = normalizeGmailTransactionNotificationPayload(payload);
        return normalizedTransaction
          ? { kind: "transaction", value: normalizedTransaction }
          : { kind: "unknown", value: payload };
      }

      return {
        kind:
          payload.reservationType || payload.travelDate || payload.confirmationCode
            ? "reservation"
            : "intakeItem",
        value: normalizeGmailPayload(payload)
      };
    }
    default:
      return { kind: "unknown", value: payload };
  }
}
