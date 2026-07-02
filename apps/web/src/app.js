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

function rateLabel(value) {
  return value > 0 ? money.format(value) : "TBD";
}

function renderTravel(travel) {
  const hotelRows = travel.hotelWatches.map(
    (watch) => `
      <article class="compact-card">
        <span class="pill">${escapeHtml(watch.status)}</span>
        <div>
          <strong>${escapeHtml(watch.property)}</strong>
          <p>${escapeHtml(watch.location)} · ${escapeHtml(watch.checkIn)} to ${escapeHtml(watch.checkOut)}</p>
        </div>
        <small>${rateLabel(watch.bestRate)} / target ${rateLabel(watch.targetRate)}</small>
      </article>
    `
  );
  const flightRows = travel.flightWatches.map(
    (watch) => `
      <article class="compact-card">
        <span class="pill">${escapeHtml(watch.status)}</span>
        <div>
          <strong>${escapeHtml(watch.route)}</strong>
          <p>${escapeHtml(watch.dates)} · ${escapeHtml(watch.providers.join(", "))}</p>
        </div>
        <small>${rateLabel(watch.bestPrice)} / target ${rateLabel(watch.targetPrice)}</small>
      </article>
    `
  );
  byId("travel-watches").innerHTML = [...hotelRows, ...flightRows].join("");

  byId("deal-count").textContent = `${travel.dealFeed.length} candidates`;
  byId("deal-feed").innerHTML = travel.dealFeed
    .map(
      (deal) => `
        <article class="compact-card">
          <span class="pill">${escapeHtml(deal.status)}</span>
          <div>
            <strong>${escapeHtml(deal.title)}</strong>
            <p>${escapeHtml(deal.route)} · ${escapeHtml(deal.source)} · ${escapeHtml(deal.confidence)}</p>
          </div>
          <small>${rateLabel(deal.price)}</small>
        </article>
      `
    )
    .join("");

  byId("reservations").innerHTML = travel.reservations
    .map(
      (reservation) => `
        <article class="compact-card">
          <span class="pill">${escapeHtml(reservation.type)}</span>
          <div>
            <strong>${escapeHtml(reservation.title)}</strong>
            <p>${escapeHtml(reservation.dates)} · ${escapeHtml(reservation.source)}</p>
          </div>
          <small>${escapeHtml(reservation.status)}</small>
        </article>
      `
    )
    .join("");
}

function renderFinance(finance) {
  byId("finance-sync").textContent = finance.sync.state;
  byId("finance").innerHTML = finance.accounts
    .map(
      (account) => `
        <article class="compact-card">
          <span class="pill">${escapeHtml(account.kind)}</span>
          <div>
            <strong>${escapeHtml(account.name)}</strong>
            <p>ending ${escapeHtml(account.last4)}</p>
          </div>
          <small>${escapeHtml(account.syncStatus)}</small>
        </article>
      `
    )
    .join("");
}

function renderIntake(intake) {
  byId("intake-count").textContent = `${intake.items.length} queued`;
  byId("intake").innerHTML = intake.items
    .map(
      (item) => `
        <article class="compact-card">
          <span class="pill">${escapeHtml(item.classification)}</span>
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <p>${escapeHtml(item.detail)}</p>
          </div>
          <small>${escapeHtml(item.state)}</small>
        </article>
      `
    )
    .join("");
}

function renderIntegrations(integrations) {
  byId("integration-count").textContent = `${integrations.length} adapters`;
  byId("integrations").innerHTML = integrations
    .map(
      (integration) => `
        <article class="compact-card integration-card">
          <span class="pill">${escapeHtml(integration.stage)}</span>
          <div>
            <strong>${escapeHtml(integration.name)}</strong>
            <p>${escapeHtml(integration.sourceRepo)} · ${escapeHtml(integration.adapter)}</p>
          </div>
        </article>
      `
    )
    .join("");
}

function renderHermes(hermes) {
  byId("hermes-status").textContent = hermes.status;
  const capabilityRows = hermes.capabilities.slice(0, 4).map(
    (capability) => `
      <article class="compact-card integration-card">
        <span class="pill">${escapeHtml(capability.target)}</span>
        <div>
          <strong>${escapeHtml(capability.title)}</strong>
          <p>${escapeHtml(capability.description)}</p>
        </div>
      </article>
    `
  );
  const actionRows = hermes.actions.map(
    (action) => `
      <article class="compact-card integration-card">
        <span class="pill">${escapeHtml(action.status)}</span>
        <div>
          <strong>${escapeHtml(action.title)}</strong>
          <p>${escapeHtml(action.target)} · ${escapeHtml(action.capabilityId)}</p>
        </div>
      </article>
    `
  );
  byId("hermes").innerHTML = [...actionRows, ...capabilityRows].join("");
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
    renderTravel(dashboard.travel);
    renderFinance(dashboard.finance);
    renderIntake(dashboard.intake);
    renderHermes(dashboard.hermes);
    renderIntegrations(dashboard.integrations);
  } catch (error) {
    byId("status-strip").textContent = error instanceof Error ? error.message : String(error);
    byId("status-strip").className = "status-strip critical";
  }
}

main();
