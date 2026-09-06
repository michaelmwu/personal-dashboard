const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});

const number = new Intl.NumberFormat("en-US");
const bridgeTokenStorageKey = "personal-dashboard:bridge-token";
const bridgeRunStorageKey = "personal-dashboard:bridge-run-id";
let appConfig = { apiBaseUrl: "" };
let bridgeEventStream = null;
let currentDashboard = null;
let plaidConnectionSettings = { browserLinkEnabled: false, onboarding: "unavailable" };

function oneYearAgoInputValue(now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

let transactionState = {
  q: "",
  accountId: "",
  accountType: "credit",
  category: "",
  status: "",
  startDate: oneYearAgoInputValue(),
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
  for (const key of [
    "q",
    "accountId",
    "accountType",
    "category",
    "status",
    "startDate",
    "endDate"
  ]) {
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

async function loadFinanceOverview(apiBaseUrl, query = transactionState) {
  const params = new URLSearchParams();
  for (const key of ["accountType", "startDate", "endDate"]) {
    const value = query[key];
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, value);
    }
  }
  const response = await fetch(`${apiBaseUrl}/api/finance/overview?${params}`);
  if (!response.ok) {
    throw new Error(`Finance API returned ${response.status}`);
  }
  return response.json();
}

function bridgeToken() {
  return (byId("bridge-token") ?? byId("finance-token"))?.value.trim() || "";
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

function humanLabel(value) {
  const text = String(value ?? "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function renderStatus(dashboard) {
  const strip = byId("status-strip");
  const sync = dashboard.finance?.sync ?? {};
  const sample = (dashboard.transactions ?? []).some((item) => item.source === "fixture");
  const finance = document.body.dataset.app === "finance";
  const label = sample
    ? "Sample data"
    : finance
      ? sync.state === "synced"
        ? "Accounts connected"
        : sync.state === "not-connected"
          ? "No bank connected"
          : humanLabel(sync.state || "Connection unavailable")
      : "";
  strip.hidden = !label;
  strip.textContent = label;
  strip.className = "status-strip";
  if (finance) {
    byId("plaid-status").textContent = sample
      ? "These are example accounts and transactions. Connect a bank through Plaid to add yours."
      : sync.state === "not-connected"
        ? "Connect a bank through Plaid to see your balances and transactions."
        : sync.lastSync
          ? `Last updated ${new Date(sync.lastSync).toLocaleString()}`
          : "Your saved transactions are shown below.";
    byId("plaid-sync").disabled = !(
      dashboard.finance?.plaidItems?.length || sync.state === "synced"
    );
  }
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
  byId("alerts").innerHTML =
    alerts
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
      .join("") || `<p class="empty-state">Nothing to review.</p>`;
}

function signedMoney(amount, currency = "USD") {
  try {
    const formatter =
      currency === "USD"
        ? money
        : new Intl.NumberFormat("en-US", {
            style: "currency",
            currency
          });
    return formatter.format(amount);
  } catch {
    return `${currency} ${Number(amount ?? 0).toFixed(2)}`;
  }
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
  return humanLabel(transaction.category || "Uncategorized");
}

function renderSelectOptions(select, options, placeholder) {
  const currentValue = select.value;
  select.innerHTML = [
    `<option value="">${escapeHtml(placeholder)}</option>`,
    ...options.map(
      (option) =>
        `<option value="${escapeHtml(option.id)}">${escapeHtml(select.id === "transaction-account" ? option.label : humanLabel(option.label))} (${number.format(option.count)})</option>`
    )
  ].join("");
  select.value = [...select.options].some((option) => option.value === currentValue)
    ? currentValue
    : "";
}

function renderTransactionFilters(facets) {
  const account = byId("transaction-account");
  const category = byId("transaction-category");
  const status = byId("transaction-status");
  renderSelectOptions(account, facets.accounts ?? [], "All accounts");
  renderSelectOptions(category, facets.categories ?? [], "All categories");
  renderSelectOptions(status, facets.statuses ?? [], "Any status");
  account.value = transactionState.accountId;
  category.value = transactionState.category;
  status.value = transactionState.status;
  byId("transaction-start").value = transactionState.startDate;
  byId("transaction-end").value = transactionState.endDate;
}

function accountDisplay(transaction) {
  const account = transaction.account;
  const name = account?.name ?? transaction.accountLabel ?? transaction.card ?? "Unknown account";
  const last4 = account?.last4 && account.last4 !== "----" ? ` • ${account.last4}` : "";
  const institution = account?.institutionName ?? transaction.institutionName ?? "";
  return {
    name: `${name}${last4}`,
    detail: institution || account?.type || transaction.accountType || ""
  };
}

function renderTransactions(result) {
  const transactions = result.items ?? [];
  const total = result.total ?? transactions.length;
  byId("transaction-count").textContent = `${number.format(total)} transactions`;
  byId("transaction-page").textContent = total
    ? `${transactionState.offset + 1}–${transactionState.offset + transactions.length} of ${number.format(total)}`
    : "0 transactions";
  byId("transaction-previous").disabled = transactionState.offset === 0;
  byId("transaction-next").disabled = transactionState.offset + transactions.length >= total;
  const range = `${transactionState.startDate || "Any date"} to ${transactionState.endDate || "today"}`;
  const filters = [
    transactionState.q && `“${transactionState.q}”`,
    transactionState.category && humanLabel(transactionState.category),
    transactionState.status && humanLabel(transactionState.status)
  ].filter(Boolean);
  byId("filter-summary").textContent = [range, ...filters].join(" · ");
  renderTransactionFilters(result.facets ?? {});
  byId("transactions").innerHTML = `
    <div class="table-row table-head" role="row">
      <span role="columnheader">Date</span>
      <span role="columnheader">Merchant</span>
      <span role="columnheader">Account</span>
      <span role="columnheader">Category</span>
      <span role="columnheader">Type</span>
      <span role="columnheader">Amount</span>
    </div>
    ${transactions
      .map((transaction) => {
        const account = accountDisplay(transaction);
        const classification = transaction.classification ?? {};
        return `
          <div class="table-row ${transaction.amount < 0 ? "credit-row" : ""}" role="row">
            <span role="cell">
              <strong>${escapeHtml(compactDate(transaction.date))}</strong>
              <small>${escapeHtml(transaction.status ?? "posted")}</small>
            </span>
            <span role="cell">
              <strong>${escapeHtml(transaction.merchant)}</strong>
              <small>${escapeHtml(humanLabel(transaction.paymentChannel ?? ""))}</small>
            </span>
            <span role="cell">
              <strong>${escapeHtml(account.name)}</strong>
              <small>${escapeHtml(account.detail)}</small>
            </span>
            <span role="cell">${escapeHtml(categoryLabel(transaction))}</span>
            <span role="cell"><span class="pill transaction-kind">${escapeHtml(humanLabel(classification.kind ?? "transaction"))}</span></span>
            <span role="cell">${signedMoney(transaction.amount, transaction.isoCurrencyCode ?? "USD")}</span>
          </div>
        `;
      })
      .join("")}
  `;
  if (!transactions.length) {
    byId("transactions").innerHTML =
      `<div class="empty-state"><strong>No transactions found</strong><p>Try a wider date range or reset your filters. If you haven’t connected a bank yet, start above.</p></div>`;
  }
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
              <strong>${escapeHtml(aggregate.groupBy === "month" ? new Date(`${group.key}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : humanLabel(group.key))}</strong>
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

function financeAccountScope(account) {
  if (account?.type === "credit" || /credit|charge card/i.test(account?.kind ?? "")) {
    return "credit";
  }
  if (
    account?.type === "depository" ||
    /checking|savings|depository|cash|money market|prepaid/i.test(
      `${account?.kind ?? ""} ${account?.subtype ?? ""}`
    )
  ) {
    return "depository";
  }
  return "other";
}

function financeAccountTypeLabel(account) {
  const type = financeAccountScope(account);
  if (type === "credit") {
    return "credit card";
  }
  if (type === "depository") {
    return account.subtype ?? "bank account";
  }
  return account.subtype ?? account.kind ?? "account";
}

function financeAccountBalance(account) {
  const currency = account.isoCurrencyCode ?? "USD";
  const current = account.currentBalance ?? account.balance;
  const available = account.availableBalance;
  const limit = account.creditLimit;
  if (current === undefined || current === null) {
    return account.syncStatus ?? "unknown";
  }
  if (financeAccountTypeLabel(account) === "credit card" && (available ?? limit) !== undefined) {
    const remaining = available ?? limit - current;
    return `${signedMoney(current, currency)} owed · ${signedMoney(remaining, currency)} left`;
  }
  if (available !== undefined && available !== null && available !== current) {
    return `${signedMoney(current, currency)} current · ${signedMoney(available, currency)} available`;
  }
  return signedMoney(current, currency);
}

function renderFinance(finance) {
  const accounts = finance.accounts ?? [];
  byId("finance-sync").textContent = humanLabel(finance.sync?.state ?? "not-connected");
  byId("finance").innerHTML =
    accounts
      .map(
        (account) => `
          <article class="compact-card finance-account-card">
            <span class="pill">${escapeHtml(financeAccountTypeLabel(account))}</span>
            <div>
              <strong>${escapeHtml(account.name)}</strong>
              <p>${escapeHtml(account.institutionName ? `${account.institutionName} · ` : "")}ending ${escapeHtml(account.last4 ?? "----")}</p>
            </div>
            <small>${escapeHtml(financeAccountBalance(account))}</small>
          </article>
        `
      )
      .join("") || `<p class="empty-state">No accounts in this view yet.</p>`;
}

function renderFeeWatch(fees = []) {
  byId("fee-count").textContent = `${number.format(fees.length)} found`;
  byId("fee-watch").innerHTML =
    fees
      .map(
        (fee) => `
          <article class="compact-card fee-card ${escapeHtml(fee.classification?.severity ?? "low")}">
            <span class="pill">${escapeHtml(fee.classification?.feeType ?? "fee")}</span>
            <div>
              <strong>${escapeHtml(fee.merchant)}</strong>
              <p>${escapeHtml(fee.account)} · ${escapeHtml(compactDate(fee.date))}</p>
            </div>
            <small>${signedMoney(fee.amount, fee.currency)}</small>
          </article>
        `
      )
      .join("") || `<p class="empty-state">No posted fees in this period.</p>`;
}

function benefitPeriodLabel(benefit) {
  const period = benefit.period ?? {};
  return period.startDate && period.endDate
    ? `${compactDate(period.startDate)} – ${compactDate(period.endDate)}`
    : "Current period";
}

function renderBenefits(benefits = []) {
  byId("benefit-count").textContent = `${number.format(benefits.length)} tracked`;
  byId("benefits").innerHTML =
    benefits
      .map((benefit) => {
        const match = benefit.matches?.at(-1);
        const total = signedMoney(benefit.amount, benefit.currency);
        const credited = signedMoney(benefit.creditedAmount, benefit.currency);
        return `
          <article class="benefit-card ${escapeHtml(benefit.status)}">
            <div class="benefit-heading">
              <span class="pill">${escapeHtml(humanLabel(benefit.status))}</span>
              <button type="button" class="quiet-button" data-benefit-delete="${escapeHtml(benefit.id)}">Remove</button>
            </div>
            <strong>${escapeHtml(benefit.name)}</strong>
            <p>${escapeHtml(benefit.account)} · ${escapeHtml(benefitPeriodLabel(benefit))}</p>
            <p>${credited} credited of ${total}${benefit.remainingAmount > 0 ? ` · ${signedMoney(benefit.remainingAmount, benefit.currency)} remaining` : ""}</p>
            <small>${match ? `Matched ${escapeHtml(match.merchant)} on ${escapeHtml(compactDate(match.date))}` : "Waiting for a matching posted credit"}</small>
          </article>
        `;
      })
      .join("") ||
    `<p class="empty-state">Add a card benefit to verify its statement credits automatically.</p>`;

  for (const button of document.querySelectorAll("[data-benefit-delete]")) {
    button.addEventListener("click", () => {
      deleteFinanceBenefit(button.dataset.benefitDelete).catch((error) => {
        byId("benefit-status").textContent = error instanceof Error ? error.message : String(error);
      });
    });
  }
}

function renderRecentCredits(credits = []) {
  byId("recent-credit-count").textContent = `${number.format(credits.length)} found`;
  byId("recent-credits").innerHTML =
    credits
      .map(
        (credit) => `
          <article class="compact-card credit-card">
            <span class="pill">${escapeHtml(credit.classification?.kind ?? "credit")}</span>
            <div>
              <strong>${escapeHtml(credit.merchant)}</strong>
              <p>${escapeHtml(compactDate(credit.date))}</p>
            </div>
            <small>+${signedMoney(credit.amount, credit.currency)}</small>
          </article>
        `
      )
      .join("") || `<p class="empty-state">No posted credits in this view.</p>`;
}

function renderBenefitAccountOptions(accounts = []) {
  const select = byId("benefit-account");
  const selected = select.value;
  const creditAccounts = accounts.filter((account) => financeAccountScope(account) === "credit");
  select.innerHTML = [
    `<option value="">Choose a credit card</option>`,
    ...creditAccounts.map(
      (account) =>
        `<option value="${escapeHtml(account.id)}">${escapeHtml(account.name)}${account.last4 && account.last4 !== "----" ? ` • ${escapeHtml(account.last4)}` : ""}</option>`
    )
  ].join("");
  select.value = [...select.options].some((option) => option.value === selected) ? selected : "";
}

function renderFinanceOverview(overview) {
  renderFinance({ accounts: overview.accounts, sync: overview.sync });
  renderFeeWatch(overview.feeWatch);
  renderBenefits(overview.benefits);
  renderRecentCredits(overview.recentCredits);
  renderBenefitAccountOptions(currentDashboard?.finance?.accounts ?? overview.accounts);
  byId("finance-summary").textContent =
    `${signedMoney(overview.summary?.spend ?? 0)} spend · ${number.format(overview.summary?.feeCount ?? 0)} fees`;
  const summary = overview.summary ?? {};
  renderMetrics([
    {
      label: "Posted spending",
      value: signedMoney(summary.spend ?? 0),
      delta: "Purchases, excluding fees"
    },
    {
      label: "Refunds & credits",
      value: signedMoney(summary.creditAmount ?? 0),
      delta: `${summary.creditCount ?? 0} posted credits`
    },
    {
      label: "Fees",
      value: signedMoney(summary.feeAmount ?? 0),
      delta: `${summary.feeCount ?? 0} posted fees`
    },
    {
      label: "Accounts",
      value: number.format(overview.accounts?.length ?? 0),
      delta: "In selected account type"
    }
  ]);
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

function appDeepLink(manifest) {
  const baseUrl = String(manifest?.baseUrl ?? "").trim();
  if (!/^https?:\/\//i.test(baseUrl)) {
    return "";
  }
  try {
    return new URL(manifest.deepLink || "/", baseUrl).toString();
  } catch {
    return "";
  }
}

function renderPluginPanels(apps) {
  const panels = apps?.panels ?? [];
  const items = apps?.items ?? [];
  const manifests = new Map((apps?.manifests ?? []).map((manifest) => [manifest.id, manifest]));
  byId("plugin-panel-count").textContent = `${panels.length} enabled`;
  byId("plugin-panels").innerHTML = panels
    .map((panel) => {
      const appItems = items.filter((item) => item.app === panel.appId);
      const active = appItems.filter((item) => item.status !== "done").length;
      const href = appDeepLink(manifests.get(panel.appId));
      const title = href
        ? `<a class="app-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(panel.title)}</a>`
        : `<strong>${escapeHtml(panel.title)}</strong>`;
      return `
        <article class="compact-card integration-card">
          <span class="pill">${escapeHtml(panel.type)}</span>
          <div>
            ${title}
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
      workspaceMode: byId("pickup-workspace-mode").value || undefined,
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

function dateInputDaysAgo(days) {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (days === 365) {
    date.setUTCFullYear(date.getUTCFullYear() - 1);
    return date.toISOString().slice(0, 10);
  }
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function markActiveFinanceScope() {
  const activeScope = transactionState.accountType || "all";
  for (const button of document.querySelectorAll("[data-finance-scope]")) {
    const active = button.dataset.financeScope === activeScope;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function markActiveDatePreset() {
  for (const button of document.querySelectorAll("[data-date-range]")) {
    const days = Number(button.dataset.dateRange);
    const active =
      Number.isFinite(days) &&
      !transactionState.endDate &&
      transactionState.startDate === dateInputDaysAgo(days);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

async function refreshFinanceAfterMutation() {
  currentDashboard = await loadDashboard(appConfig.apiBaseUrl);
  renderStatus(currentDashboard);
  await refreshTransactionView();
}

async function submitFinanceBenefit() {
  const name = byId("benefit-name").value.trim();
  const amount = Number(byId("benefit-amount").value);
  const accountId = byId("benefit-account").value;
  const patterns = byId("benefit-patterns").value.trim();
  const status = byId("benefit-status");
  if (!name || !accountId || !Number.isFinite(amount) || amount <= 0 || !patterns) {
    status.textContent = "Name, credit card, positive value, and credit descriptors are required.";
    return;
  }
  status.textContent = "Saving benefit…";
  const response = await apiFetch("/api/finance/benefits", {
    method: "POST",
    body: JSON.stringify({
      name,
      accountId,
      amount,
      currency: byId("benefit-currency").value.trim().toUpperCase() || "USD",
      period: byId("benefit-period").value,
      periodStartMonth: Number(byId("benefit-start-month").value),
      descriptorPatterns: patterns
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message ?? "Unable to save benefit.");
  }
  byId("benefit-name").value = "";
  byId("benefit-amount").value = "";
  byId("benefit-patterns").value = "";
  status.textContent = "Saved. Posted matching credits will appear here.";
  await refreshFinanceAfterMutation();
}

async function deleteFinanceBenefit(benefitId) {
  if (!benefitId || !window.confirm("Remove this benefit configuration?")) {
    return;
  }
  const response = await apiFetch(`/api/finance/benefits/${encodeURIComponent(benefitId)}`, {
    method: "DELETE"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message ?? "Unable to remove benefit.");
  }
  byId("benefit-status").textContent = "Benefit removed.";
  await refreshFinanceAfterMutation();
}

async function syncPlaidTransactions() {
  const status = byId("plaid-status");
  status.textContent = "Refreshing transactions…";
  const response = await apiFetch("/api/integrations/plaid/sync", {
    method: "POST",
    body: JSON.stringify({})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.reason ?? payload.error ?? "Plaid sync failed.");
  }
  await refreshFinanceAfterMutation();
  status.textContent = payload.synced
    ? `Refreshed ${number.format(payload.itemCount ?? 0)} connection${payload.itemCount === 1 ? "" : "s"}.`
    : (payload.results?.find((result) => !result.synced)?.message ??
      payload.reason ??
      "A bank connection needs attention. Try again or check its credential setup.");
}

async function connectPlaid() {
  const status = byId("plaid-status");
  status.textContent = "Opening Plaid to connect your bank…";
  const response = await apiFetch("/api/integrations/plaid/link-token", {
    method: "POST",
    body: JSON.stringify({ userId: "personal-dashboard" })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.linkToken) {
    const reason = payload.response?.error ?? payload.error;
    throw new Error(
      reason === "missing_plaid_config"
        ? "Bank connections aren’t configured yet. Add the Plaid credentials in your deployment settings, then try again."
        : response.status === 401 || response.status === 403
          ? "Access is required to connect a bank. Check API access below or your dashboard sign-in."
          : "Couldn’t connect to Plaid. Try again in a moment."
    );
  }
  if (!window.Plaid?.create) {
    throw new Error("Plaid Link did not load. Check the network connection and try again.");
  }
  const handler = window.Plaid.create({
    token: payload.linkToken,
    onSuccess: async (publicToken, metadata) => {
      try {
        status.textContent = "Saving connection…";
        const exchangeResponse = await apiFetch("/api/integrations/plaid/exchange-public-token", {
          method: "POST",
          body: JSON.stringify({
            publicToken,
            institutionName: metadata.institution?.name
          })
        });
        const exchange = await exchangeResponse.json().catch(() => ({}));
        if (!exchangeResponse.ok) {
          throw new Error(exchange.response?.error ?? "Unable to save Plaid connection.");
        }
        status.textContent = "Connected. Pulling transaction history…";
        await syncPlaidTransactions();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        byId("plaid-connect").disabled = false;
      }
    },
    onExit: (_error, metadata) => {
      byId("plaid-connect").disabled = false;
      if (!metadata?.status?.successful) {
        status.textContent = "Plaid Link closed before an account was connected.";
      }
    }
  });
  handler.open();
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

function markActiveSortButton() {
  byId("transaction-sort").value = `${transactionState.sort}:${transactionState.direction}`;
}

async function refreshTransactionView() {
  transactionRefreshToken += 1;
  const refreshToken = transactionRefreshToken;
  const requestedState = JSON.stringify(transactionState);
  byId("transaction-error").hidden = true;
  byId("transactions").setAttribute("aria-busy", "true");
  byId("transaction-previous").disabled = true;
  byId("transaction-next").disabled = true;
  try {
    if (transactionState.endDate && transactionState.startDate > transactionState.endDate) {
      throw new Error("Choose an end date on or after the start date.");
    }
    const [transactions, categoryAggregate, monthAggregate, overview] = await Promise.all([
      loadTransactions(appConfig.apiBaseUrl),
      loadTransactionAggregate(appConfig.apiBaseUrl, "category"),
      loadTransactionAggregate(appConfig.apiBaseUrl, "month"),
      loadFinanceOverview(appConfig.apiBaseUrl)
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
    renderFinanceOverview(overview);
    markActiveSortButton();
    markActiveFinanceScope();
    markActiveDatePreset();
  } catch (error) {
    if (
      refreshToken === transactionRefreshToken &&
      requestedState === JSON.stringify(transactionState)
    ) {
      reportTransactionError(error);
    }
  } finally {
    if (refreshToken === transactionRefreshToken) byId("transactions").removeAttribute("aria-busy");
  }
}

function reportTransactionError(error) {
  byId("transaction-error").hidden = false;
  byId("transaction-error").textContent =
    `${error instanceof Error && error.message.startsWith("Choose an end date") ? error.message : "Couldn’t update this view. Check your connection and try again."} Previously loaded results may be out of date.`;
}

function setupTransactionControls() {
  byId("finance-token").value = sessionStorage.getItem(bridgeTokenStorageKey) ?? "";
  byId("finance-token").addEventListener("input", () =>
    sessionStorage.setItem(bridgeTokenStorageKey, bridgeToken())
  );
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
  byId("transaction-sort").addEventListener("change", () => {
    const [sort, direction] = byId("transaction-sort").value.split(":");
    transactionState = { ...transactionState, sort, direction, offset: 0 };
    refreshTransactionView();
  });
  byId("transaction-reset").addEventListener("click", () => {
    transactionState = {
      ...transactionState,
      q: "",
      accountId: "",
      category: "",
      status: "",
      startDate: oneYearAgoInputValue(),
      endDate: "",
      sort: "date",
      direction: "desc",
      offset: 0
    };
    byId("transaction-search").value = "";
    refreshTransactionView();
  });
  for (const [id, direction] of [
    ["transaction-previous", -1],
    ["transaction-next", 1]
  ]) {
    byId(id).addEventListener("click", () => {
      transactionState = {
        ...transactionState,
        offset: Math.max(0, transactionState.offset + direction * transactionState.limit)
      };
      refreshTransactionView();
    });
  }
  for (const button of document.querySelectorAll("[data-finance-scope]")) {
    button.addEventListener("click", () => {
      const scope = button.dataset.financeScope;
      transactionState = {
        ...transactionState,
        accountType: scope === "all" ? "" : scope,
        accountId: "",
        category: "",
        status: "",
        offset: 0
      };
      refreshTransactionView();
    });
  }
  for (const button of document.querySelectorAll("[data-date-range]")) {
    button.addEventListener("click", () => {
      const days = Number(button.dataset.dateRange);
      if (!Number.isFinite(days)) {
        return;
      }
      transactionState = {
        ...transactionState,
        startDate: dateInputDaysAgo(days),
        endDate: "",
        offset: 0
      };
      refreshTransactionView();
    });
  }
  byId("benefit-submit").addEventListener("click", () => {
    submitFinanceBenefit().catch((error) => {
      byId("benefit-status").textContent = error instanceof Error ? error.message : String(error);
    });
  });
  byId("benefit-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitFinanceBenefit().catch((error) => {
      byId("benefit-status").textContent = error instanceof Error ? error.message : String(error);
    });
  });
  byId("plaid-connect").addEventListener("click", () => {
    if (!plaidConnectionSettings.browserLinkEnabled) {
      byId("plaid-owner-setup").hidden = false;
      byId("plaid-owner-setup").scrollIntoView({ block: "nearest" });
      return;
    }
    byId("plaid-connect").disabled = true;
    connectPlaid().catch((error) => {
      byId("plaid-status").textContent = error instanceof Error ? error.message : String(error);
      byId("plaid-connect").disabled = false;
    });
  });
  byId("plaid-sync").addEventListener("click", () => {
    byId("plaid-sync").disabled = true;
    syncPlaidTransactions()
      .catch((error) => {
        byId("plaid-status").textContent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        byId("plaid-sync").disabled = !(
          currentDashboard?.finance?.plaidItems?.length ||
          currentDashboard?.finance?.sync?.state === "synced"
        );
      });
  });
  markActiveSortButton();
  markActiveFinanceScope();
  markActiveDatePreset();
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

async function setupPlaidConnectionSettings() {
  try {
    const response = await fetch(
      `${appConfig.apiBaseUrl}/api/integrations/plaid/connection-settings`
    );
    if (!response.ok) throw new Error("unavailable");
    const settings = await response.json();
    if (
      !["owner-tool", "browser"].includes(settings.onboarding) ||
      typeof settings.browserLinkEnabled !== "boolean" ||
      settings.browserLinkEnabled !== (settings.onboarding === "browser")
    )
      throw new Error("invalid");
    plaidConnectionSettings = settings;
    byId("plaid-connect").disabled = false;
  } catch {
    byId("plaid-connect").disabled = true;
    byId("plaid-status").textContent = "Bank setup is unavailable. Reload this page to try again.";
  }
}

async function main() {
  try {
    appConfig = await loadConfig();
    const dashboard = await loadDashboard(appConfig.apiBaseUrl);
    currentDashboard = dashboard;
    renderStatus(dashboard);
    const app = document.body.dataset.app;
    if (app === "finance") {
      renderAlerts(dashboard.alerts);
      setupTransactionControls();
      await Promise.all([refreshTransactionView(), setupPlaidConnectionSettings()]);
    } else if (app === "travel") {
      renderTravel(dashboard.travel);
    } else if (app === "coding") {
      renderTasks(dashboard.openclaw);
      renderHermes(dashboard.hermes);
      setupHermesBridgeControls();
    } else if (app === "inbox") {
      renderIntake(dashboard.intake);
    } else if (app === "connections") {
      renderIntegrations(dashboard.integrations);
      renderPluginPanels(dashboard.apps);
    }
    for (const list of document.querySelectorAll(
      ".app-workspace .compact-list, .app-workspace .task-list"
    )) {
      if (!list.textContent.trim()) list.innerHTML = `<p class="empty-state">Nothing here yet.</p>`;
    }
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  } catch {
    byId("status-strip").textContent = "Unable to load";
    byId("status-strip").className = "status-strip critical";
    byId("page-error").hidden = false;
  }
}

main();
