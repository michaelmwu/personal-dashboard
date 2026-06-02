import { alert, transaction } from "../contracts/index.mjs";

export function normalizeHermesEvent(payload) {
  const merchant = payload.merchant ?? payload.subject ?? "Unknown merchant";
  const amount = Number.parseFloat(payload.amount ?? "0");
  const severity = payload.duplicateCandidate || amount >= 1000 ? "high" : "medium";

  return {
    alert: alert({
      id: payload.id ?? `hermes_${Date.now()}`,
      title: payload.title ?? `Charge detected at ${merchant}`,
      detail:
        payload.detail ??
        `${merchant} charged ${Number.isFinite(amount) ? `$${amount.toFixed(2)}` : "an unknown amount"}.`,
      severity,
      source: "Hermes"
    }),
    transaction: transaction({
      id: payload.transactionId ?? `txn_${Date.now()}`,
      merchant,
      amount: Number.isFinite(amount) ? amount : 0,
      category: payload.category ?? "Unclassified",
      card: payload.card ?? "Unknown card",
      status: payload.status ?? "pending"
    })
  };
}
