const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const appCard = ({
  name,
  mark,
  href = "#",
  state = "quiet",
  badge = "",
  featured = false,
  body = "",
  footer = "Open app"
}) => `
  <a class="porthole ${featured ? "porthole-featured" : ""} ${state}" href="${escapeHtml(href)}">
    <div class="porthole-head">
      <div class="app-title"><span class="app-mark">${escapeHtml(mark)}</span>${escapeHtml(name)}</div>
      ${badge ? `<span class="badge">${escapeHtml(badge)}</span>` : ""}
    </div>
    <div class="porthole-body">${body}</div>
    <span class="porthole-footer">${escapeHtml(footer)} <span aria-hidden="true">→</span></span>
  </a>`;

function rows(items, empty) {
  if (!items.length) return `<p class="empty">${escapeHtml(empty)}</p>`;
  return items
    .slice(0, 3)
    .map(
      ({ label, meta, tone }) =>
        `<div class="item-row"><span>${escapeHtml(label)}</span><strong class="${tone ?? ""}">${escapeHtml(meta)}</strong></div>`
    )
    .join("");
}

function render(dashboard) {
  const travel = dashboard.travel ?? {};
  const hotelWatches = travel.hotelWatches ?? [];
  const deals = travel.dealFeed ?? [];
  const tasks = dashboard.openclaw?.tasks ?? [];
  const transactions = dashboard.transactions ?? [];
  const intake = dashboard.intake?.items ?? [];
  const alerts = dashboard.alerts ?? [];
  const financeRows = transactions
    .slice(0, 3)
    .map((item) => ({ label: `${item.merchant} · ${item.card}`, meta: money.format(item.amount) }));
  const rateDrops = hotelWatches.filter(
    (watch) => watch.bestRate > 0 && watch.targetRate > watch.bestRate
  );
  const rate = rateDrops[0];
  const attention =
    alerts.length + rateDrops.length + tasks.filter((task) => task.state !== "done").length;

  document.querySelector("#freshness").textContent =
    dashboard.health?.summary ?? "Workspace synced";
  document.querySelector("#today").textContent = attention
    ? `${attention} things need attention`
    : "Your workspace is quiet";
  document.querySelector("#portholes").innerHTML = [
    appCard({
      name: "Hotel rates",
      mark: "RA",
      featured: true,
      state: rate ? "attention" : "quiet",
      badge: rate ? "review" : `${hotelWatches.length} watches`,
      href: "#travel",
      footer: rate ? "Review rebooking" : "Open rate watches",
      body: rate
        ? `<div class="headline-metric">−${money.format(rate.targetRate - rate.bestRate)}</div><span class="muted">against your booked rate</span>${rows([{ label: rate.property, meta: `${rate.location} · ${rate.checkIn}` }], "")}`
        : rows(
            hotelWatches.map((watch) => ({ label: watch.property, meta: watch.status })),
            "No active rate watches."
          )
    }),
    appCard({
      name: "Finance",
      mark: "FI",
      href: "/finance",
      badge: `${transactions.length} recent`,
      footer: "Open finance",
      body: rows(financeRows, "No transactions are available yet.")
    }),
    appCard({
      name: "Trips",
      mark: "TR",
      href: "#travel",
      badge: `${(travel.reservations ?? []).length} reservations`,
      footer: "View travel",
      body: rows(
        (travel.reservations ?? []).map((item) => ({ label: item.title, meta: item.dates })),
        "No trips need attention."
      )
    }),
    appCard({
      name: "Asia deals",
      mark: "AD",
      href: "#travel",
      badge: deals.length ? `${deals.length} new fares` : "quiet",
      footer: "See fare ideas",
      body: rows(
        deals.map((deal) => ({ label: deal.route, meta: money.format(deal.price) })),
        "No fare candidates right now."
      )
    }),
    appCard({
      name: "Coding agent",
      mark: "CO",
      href: "#operations",
      badge: tasks.length ? `${tasks.length} active` : "quiet",
      footer: "Open queue",
      body: rows(
        tasks.map((task) => ({ label: task.title, meta: task.state })),
        "Nothing is running."
      )
    }),
    appCard({
      name: "Intake",
      mark: "IN",
      href: "#operations",
      badge: intake.length ? `${intake.length} to review` : "quiet",
      footer: "Open intake",
      body: rows(
        intake.map((item) => ({ label: item.title, meta: item.state })),
        "Inbox is clear."
      )
    })
  ].join("");
}

async function main() {
  try {
    const [configResponse] = await Promise.all([fetch("/config.json")]);
    const config = await configResponse.json();
    const response = await fetch(`${config.apiBaseUrl}/api/dashboard`);
    if (!response.ok) throw new Error("Dashboard data is unavailable");
    render(await response.json());
  } catch (error) {
    document.querySelector("#freshness").textContent = "Dashboard unavailable";
    document.querySelector("#portholes").innerHTML =
      `<p class="empty">${escapeHtml(error instanceof Error ? error.message : error)}</p>`;
  }
}

main();
