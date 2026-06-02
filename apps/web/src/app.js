const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});

const number = new Intl.NumberFormat("en-US");

async function loadConfig() {
  const response = await fetch("/config.json");
  if (!response.ok) {
    throw new Error("Unable to load config");
  }
  return response.json();
}

async function loadDashboard(apiBaseUrl) {
  const response = await fetch(`${apiBaseUrl}/api/dashboard`);
  if (!response.ok) {
    throw new Error(`Dashboard API returned ${response.status}`);
  }
  return response.json();
}

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderStatus(dashboard) {
  const strip = byId("status-strip");
  strip.innerHTML = `<span class="status-dot"></span>${escapeHtml(dashboard.health.summary)}`;
  strip.className = `status-strip ${escapeHtml(dashboard.health.level)}`;
}

function renderMetrics(metrics) {
  byId("metrics").innerHTML = metrics
    .map(
      (metric) => `
        <article class="metric">
          <span>${escapeHtml(metric.label)}</span>
          <strong>${escapeHtml(metric.value)}</strong>
          <small>${escapeHtml(metric.delta)}</small>
        </article>
      `
    )
    .join("");
}

function renderAlerts(alerts) {
  byId("alert-count").textContent = `${alerts.length} active`;
  byId("alerts").innerHTML = alerts
    .map(
      (alert) => `
        <article class="alert ${escapeHtml(alert.severity)}">
          <div>
            <strong>${escapeHtml(alert.title)}</strong>
            <p>${escapeHtml(alert.detail)}</p>
          </div>
          <span>${escapeHtml(alert.source)}</span>
        </article>
      `
    )
    .join("");
}

function renderTransactions(transactions) {
  byId("transactions").innerHTML = `
    <div class="table-row table-head">
      <span>Merchant</span>
      <span>Card</span>
      <span>Status</span>
      <span>Amount</span>
    </div>
    ${transactions
      .map(
        (transaction) => `
          <div class="table-row">
            <span>
              <strong>${escapeHtml(transaction.merchant)}</strong>
              <small>${escapeHtml(transaction.category)}</small>
            </span>
            <span>${escapeHtml(transaction.card)}</span>
            <span><mark>${escapeHtml(transaction.status)}</mark></span>
            <span>${money.format(transaction.amount)}</span>
          </div>
        `
      )
      .join("")}
  `;
}

function renderRewards(summary) {
  byId("reward-period").textContent = summary.period;
  byId("rewards").innerHTML = `
    <div class="reward-total">
      <span>Estimated points</span>
      <strong>${number.format(summary.estimatedPoints)}</strong>
    </div>
    ${summary.insights
      .map(
        (insight) => `
          <article class="reward-card">
            <strong>${escapeHtml(insight.title)}</strong>
            <p>${escapeHtml(insight.detail)}</p>
            <span>${number.format(insight.pointsImpact)} point impact</span>
          </article>
        `
      )
      .join("")}
  `;
}

function renderTasks(openclaw) {
  byId("openclaw-status").textContent = openclaw.status;
  byId("tasks").innerHTML = openclaw.tasks
    .map(
      (task) => `
        <article class="task">
          <span class="task-priority">${escapeHtml(task.priority)}</span>
          <div>
            <strong>${escapeHtml(task.title)}</strong>
            <p>${escapeHtml(task.owner)} · ${escapeHtml(task.state)}</p>
          </div>
        </article>
      `
    )
    .join("");
}

async function main() {
  try {
    const config = await loadConfig();
    const dashboard = await loadDashboard(config.apiBaseUrl);
    renderStatus(dashboard);
    renderMetrics(dashboard.metrics);
    renderAlerts(dashboard.alerts);
    renderTransactions(dashboard.transactions);
    renderRewards(dashboard.rewards);
    renderTasks(dashboard.openclaw);
  } catch (error) {
    byId("status-strip").textContent = error instanceof Error ? error.message : String(error);
    byId("status-strip").className = "status-strip critical";
  }
}

main();
