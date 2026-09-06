const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
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
  href,
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
  const tasks = (dashboard.openclaw?.tasks ?? []).filter(
    (task) => !["done", "completed", "cancelled"].includes(task.state)
  );
  const transactions = dashboard.transactions ?? [];
  const intake = dashboard.intake?.items ?? [];
  const alerts = dashboard.alerts ?? [];
  const flightWatches = travel.flightWatches ?? [];
  const financeRows = [...transactions]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 3)
    .map((item) => ({
      label: `${item.merchant} · ${item.card}`,
      meta: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: item.isoCurrencyCode || "USD"
      }).format(item.amount)
    }));
  const rateDrops = hotelWatches.filter(
    (watch) => watch.bestRate > 0 && watch.targetRate > watch.bestRate
  );
  const rate = rateDrops[0];
  document.querySelector("#today").textContent = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  });
  const sample = transactions.some((item) => item.source === "fixture");
  const notice = document.querySelector("#home-notice");
  notice.hidden = !sample;
  notice.textContent = "Sample data is shown. Connect your accounts in Finance to get started.";
  document.querySelector("#portholes").innerHTML = [
    appCard({
      name: "Award flights",
      mark: "FL",
      href: "/flights",
      badge: flightWatches.length ? `${flightWatches.length} searches` : "ready",
      footer: "Search availability",
      body: rows(
        flightWatches.map((watch) => ({
          label: watch.route,
          meta: watch.status,
          tone: watch.status === "waiting_human" ? "attention" : ""
        })),
        "Search Seats.aero, ANA, JAL, and EVA."
      )
    }),
    appCard({
      name: "Finance",
      mark: "FI",
      href: "/finance",
      badge: alerts.length ? `${alerts.length} to review` : `${transactions.length} transactions`,
      footer: "Review transactions",
      body: rows(financeRows, "No transactions yet.")
    }),
    appCard({
      name: "Hotel rates",
      mark: "RA",
      state: rate ? "attention" : "quiet",
      badge: rate ? "Price drop" : `${hotelWatches.length} watches`,
      href: "/travel#rates",
      footer: rate ? "Review rebooking" : "Rate watches",
      body: rate
        ? `<div class="headline-metric">−${money.format(rate.targetRate - rate.bestRate)}</div><span class="muted">below target rate</span>${rows([{ label: rate.property, meta: `${rate.location} · ${rate.checkIn}` }], "")}`
        : rows(
            hotelWatches.map((watch) => ({
              label: watch.property,
              meta: watch.status.replaceAll("-", " ")
            })),
            "No active rate watches."
          )
    }),
    appCard({
      name: "Trips",
      mark: "TR",
      href: "/travel#trips",
      badge: `${(travel.reservations ?? []).length} reservations`,
      footer: "Trip details",
      body: rows(
        (travel.reservations ?? []).map((item) => ({ label: item.title, meta: item.dates })),
        "No upcoming trips."
      )
    }),
    appCard({
      name: "Flight deals",
      mark: "AD",
      href: "/travel#deals",
      badge: deals.length ? `${deals.length} fares` : "No new items",
      footer: "Browse fares",
      body: rows(
        deals.map((deal) => ({ label: deal.route, meta: money.format(deal.price) })),
        "No flight deals yet."
      )
    }),
    appCard({
      name: "Coding",
      mark: "CO",
      href: "/coding",
      badge: tasks.length ? `${tasks.length} active` : "No new items",
      footer: "Review queue",
      body: rows(
        tasks.map((task) => ({ label: task.title, meta: task.state.replaceAll("-", " ") })),
        "Nothing running."
      )
    }),
    appCard({
      name: "Inbox",
      mark: "IN",
      href: "/inbox",
      badge: intake.length ? `${intake.length} items` : "No new items",
      footer: "Review inbox",
      body: rows(
        intake.map((item) => ({ label: item.title, meta: item.state.replaceAll("-", " ") })),
        "Inbox is clear."
      )
    })
  ].join("");
}

async function main() {
  try {
    const configResponse = await fetch("/config.json");
    if (!configResponse.ok) throw new Error("Couldn’t load your apps.");
    const config = await configResponse.json();
    const response = await fetch(`${config.apiBaseUrl}/api/dashboard`);
    if (!response.ok) throw new Error("Dashboard data is unavailable");
    render(await response.json());
  } catch {
    document.querySelector("#today").textContent = "Dashboard unavailable";
    document.querySelector("#portholes").innerHTML =
      `<div class="empty"><p>Couldn’t load your apps. Try again in a moment.</p><button type="button" id="home-retry">Try again</button> <a href="/finance">Go to Finance →</a></div>`;
    document.querySelector("#home-retry").addEventListener("click", main);
  }
}

main();
