const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});

const number = new Intl.NumberFormat("en-US");
const bridgeTokenStorageKey = "personal-dashboard:bridge-token";
const bridgeRunStorageKey = "personal-dashboard:bridge-run-id";
let appConfig = { apiBaseUrl: "" };
let bridgeEventStream = null;

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

function bridgeToken() {
  return byId("bridge-token")?.value.trim() || "";
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers);
  const token = bridgeToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${appConfig.apiBaseUrl}${path}`, {
    ...options,
    headers
  });
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

function currencyRateLabel(value, currency = "USD") {
  if (!(value > 0)) {
    return "TBD";
  }
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency
    }).format(value);
  } catch {
    return `${escapeHtml(currency)} ${Number(value).toFixed(2)}`;
  }
}

function renderTravel(travel) {
  const hotelRows = travel.hotelWatches.map(
    (watch) => `
      <article class="compact-card">
        <span class="pill">${escapeHtml(watch.status)}</span>
        <div>
          <strong>${escapeHtml(watch.property)}</strong>
          <p>${escapeHtml(watch.location)} · ${escapeHtml(watch.checkIn)} to ${escapeHtml(watch.checkOut)}${watch.cancellationDeadline ? ` · cancel by ${escapeHtml(watch.cancellationDeadline)}` : ""}</p>
        </div>
        <small>${currencyRateLabel(watch.bestRate, watch.currency)} / paid ${currencyRateLabel(watch.targetRate, watch.currency)}</small>
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
            <p>${escapeHtml(reservation.dates)} · ${escapeHtml(reservation.source)}${reservation.cancellationDeadline ? ` · cancel by ${escapeHtml(reservation.cancellationDeadline)}` : ""}</p>
          </div>
          <small>${reservation.paidRate ? currencyRateLabel(reservation.paidRate, reservation.paidCurrency) : escapeHtml(reservation.status)}</small>
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

function renderPluginPanels(apps) {
  const panels = apps?.panels ?? [];
  const items = apps?.items ?? [];
  byId("plugin-panel-count").textContent = `${panels.length} enabled`;
  byId("plugin-panels").innerHTML = panels
    .map((panel) => {
      const appItems = items.filter((item) => item.app === panel.appId);
      const active = appItems.filter((item) => item.status !== "done").length;
      return `
        <article class="compact-card integration-card">
          <span class="pill">${escapeHtml(panel.type)}</span>
          <div>
            <strong>${escapeHtml(panel.title)}</strong>
            <p>${escapeHtml(panel.appId)} · ${escapeHtml(panel.defaultPosition)} · ${active} active</p>
          </div>
        </article>
      `;
    })
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

function bridgeRunId() {
  return byId("bridge-run-id").value.trim();
}

function setBridgeRunId(runId) {
  byId("bridge-run-id").value = runId;
  if (runId) {
    sessionStorage.setItem(bridgeRunStorageKey, runId);
  }
}

function renderBridgeEvent(payload) {
  byId("bridge-events").textContent =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function renderOperatorResult(payload) {
  byId("operator-result").textContent =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function updateOperatorStatus(label, level = "") {
  const status = byId("operator-status");
  status.textContent = label;
  status.className = `pill ${level}`.trim();
}

function appendBridgeEventText(text) {
  const events = byId("bridge-events");
  events.textContent = `${events.textContent}${text}`.slice(-12000);
  events.scrollTop = events.scrollHeight;
}

function parseBridgeRunId(payload) {
  const bridge = payload?.bridge ?? payload;
  return bridge?.run_id ?? bridge?.runId ?? bridge?.id ?? bridge?.run?.id;
}

function updateBridgeStatus(label, level = "") {
  const status = byId("bridge-status");
  status.textContent = label;
  status.className = `pill ${level}`.trim();
}

async function refreshBridge() {
  const response = await apiFetch("/api/hermes/bridge/capabilities");
  const payload = await response.json().catch(() => ({}));
  if (response.ok) {
    const capabilities = payload.bridge?.capabilities ?? payload.bridge ?? [];
    const count = Array.isArray(capabilities) ? capabilities.length : "ready";
    updateBridgeStatus(`Bridge ${count}`);
  } else {
    updateBridgeStatus(response.status === 401 ? "Token" : "Offline", "warning");
  }
  renderBridgeEvent(payload);
}

async function pollBridgeEvents() {
  const runId = bridgeRunId();
  if (!runId) {
    bridgeEventStream?.controller.abort();
    return;
  }
  if (bridgeEventStream?.runId === runId) {
    return;
  }
  bridgeEventStream?.controller.abort();
  const stream = {
    runId,
    controller: new AbortController()
  };
  bridgeEventStream = stream;
  try {
    const response = await apiFetch(`/api/hermes/bridge/runs/${encodeURIComponent(runId)}/events`, {
      signal: stream.controller.signal
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        appendBridgeEventText(decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) {
        appendBridgeEventText(tail);
      }
      return;
    }
    const payload = await response.json().catch(() => ({}));
    renderBridgeEvent(payload);
  } catch (error) {
    if (!stream.controller.signal.aborted) {
      throw error;
    }
  } finally {
    if (bridgeEventStream === stream) {
      bridgeEventStream = null;
    }
  }
}

async function startBridgeRun() {
  const prompt = byId("bridge-prompt").value.trim();
  const response = await apiFetch("/api/hermes/bridge/runs", {
    method: "POST",
    body: JSON.stringify({
      input: prompt,
      instructions:
        "You are Hermes running from Personal Dashboard. Return concise status and request approval for side effects.",
      sessionId: "personal-dashboard"
    })
  });
  const payload = await response.json().catch(() => ({}));
  const runId = parseBridgeRunId(payload);
  if (runId) {
    setBridgeRunId(runId);
    pollBridgeEvents().catch((error) => renderBridgeEvent(String(error)));
  }
  updateBridgeStatus(response.ok ? "Running" : response.status === 401 ? "Token" : "Error");
  renderBridgeEvent(payload);
}

async function stopBridgeRun() {
  const runId = bridgeRunId();
  if (!runId) {
    return;
  }
  const response = await apiFetch(`/api/hermes/bridge/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    body: JSON.stringify({ reason: "dashboard_user" })
  });
  renderBridgeEvent(await response.json().catch(() => ({})));
  updateBridgeStatus(response.ok ? "Stopped" : "Error");
}

async function submitBridgeApproval(approved) {
  const runId = bridgeRunId();
  if (!runId) {
    return;
  }
  const response = await apiFetch(`/api/hermes/bridge/runs/${encodeURIComponent(runId)}/approval`, {
    method: "POST",
    body: JSON.stringify({
      approved,
      decision: approved ? "approved" : "rejected"
    })
  });
  renderBridgeEvent(await response.json().catch(() => ({})));
  updateBridgeStatus(response.ok ? (approved ? "Approved" : "Rejected") : "Error");
}

function positiveIntegerInput(id, label) {
  const input = byId(id);
  const rawValue = input.value.trim();
  const value = Number(rawValue);
  if (!rawValue || !input.checkValidity() || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requiredField(id, label) {
  const value = byId(id).value.trim();
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function optionalField(id) {
  return byId(id).value.trim() || undefined;
}

async function submitPrPickup() {
  const repo = requiredField("pickup-repo", "Repo");
  const prNumber = positiveIntegerInput("pickup-pr-number", "PR");
  updateOperatorStatus("Pickup");
  const response = await apiFetch("/api/apps/coding-agent/pr-pickup", {
    method: "POST",
    body: JSON.stringify({
      githubRepo: repo,
      prNumber,
      title: optionalField("pickup-title"),
      branch: optionalField("pickup-branch"),
      pickupSource: "dashboard"
    })
  });
  const payload = await response.json().catch(() => ({}));
  updateOperatorStatus(response.ok ? "Picked Up" : "Blocked", response.ok ? "" : "warning");
  renderOperatorResult(payload);
}

async function submitIssueTriage() {
  const repo = requiredField("issue-repo", "Repo");
  const issueNumber = positiveIntegerInput("issue-number", "Issue");
  updateOperatorStatus("Triage");
  const response = await apiFetch("/api/apps/coding-agent/issue-triage", {
    method: "POST",
    body: JSON.stringify({
      githubRepo: repo,
      issueNumber,
      title: requiredField("issue-title", "Title"),
      body: optionalField("issue-body"),
      author: optionalField("issue-author"),
      authorAssociation: byId("issue-association").value
    })
  });
  const payload = await response.json().catch(() => ({}));
  updateOperatorStatus(response.ok ? "Drafted" : "Approval", response.ok ? "" : "warning");
  renderOperatorResult(payload);
}

function setupHermesBridgeControls() {
  byId("bridge-token").value = sessionStorage.getItem(bridgeTokenStorageKey) ?? "";
  byId("bridge-run-id").value = sessionStorage.getItem(bridgeRunStorageKey) ?? "";
  byId("bridge-token").addEventListener("input", () => {
    sessionStorage.setItem(bridgeTokenStorageKey, bridgeToken());
  });
  byId("bridge-run-id").addEventListener("input", () => {
    sessionStorage.setItem(bridgeRunStorageKey, bridgeRunId());
    pollBridgeEvents().catch((error) => renderBridgeEvent(String(error)));
  });
  byId("bridge-refresh").addEventListener("click", () => {
    refreshBridge().catch((error) => renderBridgeEvent(String(error)));
  });
  byId("bridge-start").addEventListener("click", () => {
    startBridgeRun().catch((error) => renderBridgeEvent(String(error)));
  });
  byId("bridge-stop").addEventListener("click", () => {
    stopBridgeRun().catch((error) => renderBridgeEvent(String(error)));
  });
  byId("bridge-approve").addEventListener("click", () => {
    submitBridgeApproval(true).catch((error) => renderBridgeEvent(String(error)));
  });
  byId("bridge-reject").addEventListener("click", () => {
    submitBridgeApproval(false).catch((error) => renderBridgeEvent(String(error)));
  });
  byId("pickup-submit").addEventListener("click", () => {
    submitPrPickup().catch((error) => {
      updateOperatorStatus("Error", "warning");
      renderOperatorResult(String(error));
    });
  });
  byId("issue-submit").addEventListener("click", () => {
    submitIssueTriage().catch((error) => {
      updateOperatorStatus("Error", "warning");
      renderOperatorResult(String(error));
    });
  });
  setInterval(() => {
    pollBridgeEvents().catch(() => {});
  }, 5000);
  refreshBridge().catch((error) => renderBridgeEvent(String(error)));
}

async function main() {
  try {
    const config = await loadConfig();
    appConfig = config;
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
    renderPluginPanels(dashboard.apps);
    setupHermesBridgeControls();
  } catch (error) {
    byId("status-strip").textContent = error instanceof Error ? error.message : String(error);
    byId("status-strip").className = "status-strip critical";
  }
}

main();
