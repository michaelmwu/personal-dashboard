export function metric(label, value, delta) {
  return { label, value, delta };
}

export function alert({ id, title, detail, severity = "low", source = "Hermes" }) {
  return { id, title, detail, severity, source };
}

export function transaction({ id, merchant, amount, category, card, status }) {
  return { id, merchant, amount, category, card, status };
}

export function rewardInsight({ id, title, detail, pointsImpact }) {
  return { id, title, detail, pointsImpact };
}

export function openClawTask({ id, title, owner = "OpenClaw", state, priority }) {
  return { id, title, owner, state, priority };
}

export function dashboardContract({ health, metrics, alerts, transactions, rewards, openclaw }) {
  return {
    generatedAt: new Date().toISOString(),
    health,
    metrics,
    alerts,
    transactions,
    rewards,
    openclaw
  };
}
