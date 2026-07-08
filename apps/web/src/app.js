const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});

const number = new Intl.NumberFormat("en-US");
const bridgeTokenStorageKey = "personal-dashboard:bridge-token";
const bridgeRunStorageKey = "personal-dashboard:bridge-run-id";
let appConfig = { apiBaseUrl: "" };
let bridgeEventStream = null;
let transactionState = {
  q: "",
  accountId: "",
  category: "",
  status: "",
  startDate: "",
  endDate: "",
  sort: "date",
  direction: "desc",
  limit: 75,
  offset: 0
};
let transactionRefreshToken = 0;

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

async function loadTransactions(apiBaseUrl, query = transactionState) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  }
  const response = await fetch(`${apiBaseUrl}/api/transactions?${params}`);
  if (!response.ok) {
    throw new Error(`Transactions API returned ${response.status}`);
  }
  return response.json();
}

async function loadTransactionAggregate(apiBaseUrl, groupBy, query = transactionState) {
  const params = new URLSearchParams({ groupBy });
  for (const key of ["q", "accountId", "category", "status", "startDate", "endDate"]) {
    const value = query[key];
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  }
  const response = await fetch(`${apiBaseUrl}/api/transactions/aggregate?${params}`);
  if (!response.ok) {
    throw new Error(`Transaction aggregate API returned ${response.status}`);
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

function financeMetrics(dashboard) {
  const transactions = dashboard.finance?.transactions;
  if (!transactions) {
    return dashboard.metrics;
  }
  return [
    {
      label: "Tracked spend",
      value: money.format(transactions.totalSpend ?? 0),
      delta: `${number.format(transactions.transactionCount ?? 0)} transactions`
    },
    {
      label: "Accounts",
      value: number.format(transactions.accountCount ?? dashboard.finance?.accounts?.length ?? 0),
      delta: dashboard.finance?.sync?.state ?? "not-connected"
    },
    {
      label: "Pending",
      value: number.format(transactions.pendingCount ?? 0),
      delta: "Not final yet"
    },
    {
      label: "Credits",
      value: number.format(transactions.creditCount ?? 0),
      delta: "Refunds and statement credits"
    }
  ];
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

function signedMoney(amount, currency = "USD") {
  const formatter =
    currency === "USD"
      ? money
      : new Intl.NumberFormat("en-US", {
          style: "currency",
          currency
        });
  return formatter.format(amount);
}

function compactDate(value) {
  if (!value) {
    return "No date";
  }
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function categoryLabel(transaction) {
  return [transaction.category, transaction.categoryDetailed].filter(Boolean).join(" / ");
}

function localTransactionResult(dashboard) {
  const transactions = [...(dashboard.transactions ?? [])].sort((left, right) =>
    String(right.date ?? "").localeCompare(String(left.date ?? ""))
  );
  const countBy = (items, valueFor) => {
    const counts = new Map();
    for (const item of items) {
      const id = valueFor(item) ?? "";
      if (!id) {
        continue;
      }
      const existing = counts.get(id) ?? { id, label: id, count: 0 };
      existing.count += 1;
      counts.set(id, existing);
    }
    return [...counts.values()];
  };
  return {
    items: transactions.slice(0, transactionState.limit),
    total: transactions.length,
    limit: transactionState.limit,
    offset: 0,
    facets: {
      accounts: countBy(transactions, (transaction) => transaction.accountId).map((facet) => ({
        ...facet,
        label:
          dashboard.finance?.accounts?.find((account) => account.id === facet.id)?.name ?? facet.id
      })),
      categories: countBy(transactions, (transaction) => transaction.category),
      statuses: countBy(transactions, (transaction) => transaction.status)
    }
  };
}

function localAggregate(dashboard, groupBy) {
  const groups = new Map();
  for (const transaction of dashboard.transactions ?? []) {
    const key =
      groupBy === "month"
        ? String(transaction.date ?? "").slice(0, 7) || "Unknown month"
        : transaction.category || "Unclassified";
    const currency = transaction.isoCurrencyCode ?? transaction.unofficialCurrencyCode ?? "USD";
    const groupId = `${key}\u0000${currency}`;
    const existing = groups.get(groupId) ?? {
      key,
      currency,
      count: 0,
      spend: 0,
      credits: 0,
      net: 0
    };
    const amount = Number(transaction.amount ?? 0);
    existing.count += 1;
    existing.net += amount;
    if (amount >= 0) {
      existing.spend += amount;
    } else {
      existing.credits += Math.abs(amount);
    }
    groups.set(groupId, existing);
  }
  return { groupBy, total: dashboard.transactions?.length ?? 0, groups: [...groups.values()] };
}

function renderSelectOptions(select, options, placeholder) {
  const currentValue = select.value;
  select.innerHTML = [
    `<option value="">${escapeHtml(placeholder)}</option>`,
    ...options.map(
      (option) =>
        `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)} (${number.format(option.count)})</option>`
    )
  ].join("");
  select.value = [...select.options].some((option) => option.value === currentValue)
    ? currentValue
    : "";
}

function renderTransactionFilters(facets) {
  renderSelectOptions(byId("transaction-account"), facets.accounts ?? [], "All accounts");
  renderSelectOptions(byId("transaction-category"), facets.categories ?? [], "All categories");
  renderSelectOptions(byId("transaction-status"), facets.statuses ?? [], "Any status");
}

function renderTransactions(result) {
  const transactions = result.items ?? [];
  byId("transaction-count").textContent =
    `${number.format(result.total ?? transactions.length)} matching`;
  renderTransactionFilters(result.facets ?? {});
  byId("transactions").innerHTML = `
    <div class="table-row table-head">
      <span>Date</span>
      <span>Merchant</span>
      <span>Card</span>
      <span>Category</span>
      <span>Amount</span>
    </div>
    ${transactions
      .map(
        (transaction) => `
          <div class="table-row ${transaction.amount < 0 ? "credit-row" : ""}">
            <span>
              <strong>${escapeHtml(compactDate(transaction.date))}</strong>
              <small>${escapeHtml(transaction.status ?? "posted")}</small>
            </span>
            <span>
              <strong>${escapeHtml(transaction.merchant)}</strong>
              <small>${escapeHtml(transaction.paymentChannel ?? transaction.source ?? "")}</small>
            </span>
            <span>${escapeHtml(transaction.card)}</span>
            <span>${escapeHtml(categoryLabel(transaction))}</span>
            <span>${signedMoney(transaction.amount, transaction.isoCurrencyCode ?? "USD")}</span>
          </div>
        `
      )
      .join("")}
  `;
}

function renderAggregate(targetId, aggregate) {
  const rows = (aggregate.groups ?? []).slice(0, 8);
  byId(targetId).innerHTML =
    rows
      .map(
        (group) => `
          <article class="compact-card aggregate-card">
            <span class="pill">${number.format(group.count)}</span>
            <div>
              <strong>${escapeHtml(group.key)}</strong>
              <p>${signedMoney(group.spend, group.currency ?? "USD")} spend · ${signedMoney(group.credits, group.currency ?? "USD")} credits</p>
            </div>
            <small>${signedMoney(group.net, group.currency ?? "USD")}</small>
          </article>
        `
      )
      .join("") || `<p class="empty-state">No matching transactions.</p>`;
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
  byId("finance-sync").textContent = finance.sync?.state ?? "not-connected";
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

function updateTransactionStateFromControls() {
  transactionState = {
    ...transactionState,
    q: byId("transaction-search").value.trim(),
    accountId: byId("transaction-account").value,
    category: byId("transaction-category").value,
    status: byId("transaction-status").value,
    startDate: byId("transaction-start").value,
    endDate: byId("transaction-end").value,
    offset: 0
  };
}

function sortButtonLabel(sort, active) {
  const label = `${sort[0].toUpperCase()}${sort.slice(1)}`;
  if (!active) {
    return label;
  }
  return `${label} ${transactionState.direction === "asc" ? "up" : "down"}`;
}

function markActiveSortButton() {
  for (const button of document.querySelectorAll("[data-sort]")) {
    const active = button.dataset.sort === transactionState.sort;
    button.classList.toggle("active", active);
    button.textContent = sortButtonLabel(button.dataset.sort, active);
  }
}

async function refreshTransactionView() {
  transactionRefreshToken += 1;
  const refreshToken = transactionRefreshToken;
  const requestedState = JSON.stringify(transactionState);
  try {
    const [transactions, categoryAggregate, monthAggregate] = await Promise.all([
      loadTransactions(appConfig.apiBaseUrl),
      loadTransactionAggregate(appConfig.apiBaseUrl, "category"),
      loadTransactionAggregate(appConfig.apiBaseUrl, "month")
    ]);
    if (
      refreshToken !== transactionRefreshToken ||
      requestedState !== JSON.stringify(transactionState)
    ) {
      return;
    }
    renderTransactions(transactions);
    renderAggregate("aggregate-categories", categoryAggregate);
    renderAggregate("aggregate-months", monthAggregate);
    markActiveSortButton();
  } catch (error) {
    if (
      refreshToken === transactionRefreshToken &&
      requestedState === JSON.stringify(transactionState)
    ) {
      reportTransactionError(error);
    }
  }
}

function reportTransactionError(error) {
  byId("transaction-count").textContent = error instanceof Error ? error.message : String(error);
}

function setupTransactionControls() {
  const filterIds = [
    "transaction-search",
    "transaction-account",
    "transaction-category",
    "transaction-status",
    "transaction-start",
    "transaction-end"
  ];
  for (const id of filterIds) {
    byId(id).addEventListener("input", () => {
      updateTransactionStateFromControls();
      refreshTransactionView();
    });
  }
  for (const button of document.querySelectorAll("[data-sort]")) {
    button.addEventListener("click", () => {
      const sort = button.dataset.sort;
      transactionState = {
        ...transactionState,
        sort,
        direction:
          transactionState.sort === sort && transactionState.direction === "desc" ? "asc" : "desc"
      };
      refreshTransactionView();
    });
  }
  markActiveSortButton();
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
    const [transactions, categoryAggregate, monthAggregate] = await Promise.all([
      loadTransactions(config.apiBaseUrl).catch(() => localTransactionResult(dashboard)),
      loadTransactionAggregate(config.apiBaseUrl, "category").catch(() =>
        localAggregate(dashboard, "category")
      ),
      loadTransactionAggregate(config.apiBaseUrl, "month").catch(() =>
        localAggregate(dashboard, "month")
      )
    ]);
    renderStatus(dashboard);
    renderMetrics(financeMetrics(dashboard));
    renderAlerts(dashboard.alerts);
    renderTransactions(transactions);
    renderAggregate("aggregate-categories", categoryAggregate);
    renderAggregate("aggregate-months", monthAggregate);
    renderTasks(dashboard.openclaw);
    renderTravel(dashboard.travel);
    renderFinance(dashboard.finance);
    renderIntake(dashboard.intake);
    renderHermes(dashboard.hermes);
    renderIntegrations(dashboard.integrations);
    renderPluginPanels(dashboard.apps);
    setupTransactionControls();
    setupHermesBridgeControls();
  } catch (error) {
    byId("status-strip").textContent = error instanceof Error ? error.message : String(error);
    byId("status-strip").className = "status-strip critical";
  }
}

main();
