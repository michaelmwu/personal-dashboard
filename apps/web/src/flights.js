import { createDateRangePicker, futureDateValue } from "./date-range-picker.js";
import { isWaitlistResult, partitionAwardResults, sortAwardResults } from "./flight-results.js";
import { createTokenInput } from "./token-input.js";

const apiRoot = "/api/integrations/flight-searcher";
const activeStatuses = new Set(["queued", "running", "waiting_human"]);
const terminalStatuses = new Set(["completed", "partial", "failed", "canceled"]);
const providerNames = { seats_aero: "Seats.aero", ana: "ANA", jal: "JAL", eva: "EVA" };
const airlineProviderIds = new Set(["ana", "jal", "eva"]);
const state = {
  jobs: [],
  selectedId: null,
  refreshing: false,
  timer: null,
  previewTimer: null,
  activeChallenges: new Map(),
  challengeUi: new Map(),
  browserTypeQueues: new Map(),
  browserActionChains: new Map(),
  resultSort: "date",
  resultDirection: "asc",
  expandedResults: new Set()
};
const number = new Intl.NumberFormat("en-US");
const airportChoices = [
  { id: "TYO", name: "Tokyo (all airports)", aliases: ["Tokyo"] },
  { id: "HND", name: "Tokyo Haneda", aliases: ["Haneda"] },
  { id: "NRT", name: "Tokyo Narita", aliases: ["Narita"] },
  { id: "OSA", name: "Osaka (all airports)", aliases: ["Osaka"] },
  { id: "KIX", name: "Osaka Kansai" },
  { id: "SEA", name: "Seattle–Tacoma", aliases: ["Seattle"] },
  { id: "SFO", name: "San Francisco" },
  { id: "LAX", name: "Los Angeles" },
  { id: "JFK", name: "New York JFK", aliases: ["New York"] },
  { id: "NYC", name: "New York (all airports)" },
  { id: "ORD", name: "Chicago O'Hare", aliases: ["Chicago"] },
  { id: "DFW", name: "Dallas–Fort Worth", aliases: ["Dallas"] },
  { id: "BOS", name: "Boston" },
  { id: "TPE", name: "Taipei Taoyuan", aliases: ["Taipei"] },
  { id: "HKG", name: "Hong Kong" },
  { id: "SIN", name: "Singapore Changi", aliases: ["Singapore"] },
  { id: "BKK", name: "Bangkok Suvarnabhumi", aliases: ["Bangkok"] },
  { id: "ICN", name: "Seoul Incheon", aliases: ["Seoul"] },
  { id: "SEL", name: "Seoul (all airports)" },
  { id: "LHR", name: "London Heathrow", aliases: ["London"] },
  { id: "LON", name: "London (all airports)" },
  { id: "CDG", name: "Paris Charles de Gaulle", aliases: ["Paris"] },
  { id: "SYD", name: "Sydney" },
  { id: "MEL", name: "Melbourne" },
  { id: "YVR", name: "Vancouver" }
];
let departurePicker;
let returnPicker;
let originInput;
let destinationInput;
let programInput;

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiRoot}${path}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const detail =
      body?.message ?? body?.detail ?? body?.error ?? `Request failed (${response.status})`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

function checkedValues(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(
    (input) => input.value
  );
}

function statusPill(status) {
  return `<span class="status-pill ${escapeHtml(status)}">${escapeHtml(String(status).replaceAll("_", " "))}</span>`;
}

function elapsedLabel(timestamp) {
  const started = Date.parse(timestamp ?? "");
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function providerQueueDetails(run) {
  if (run.state !== "queued") return "";
  const parts = [];
  if (run.queuePosition) parts.push(`Queue position ${run.queuePosition}`);
  const elapsed = elapsedLabel(run.queuedAt);
  if (elapsed) parts.push(`waiting ${elapsed}`);
  if (!parts.length) return "";
  return `<p class="provider-queue-details">${escapeHtml(parts.join(" · "))}</p>`;
}

function queueJobsAhead(job, providerId, run) {
  if (run.state !== "queued") return [];
  const expected = Math.max(0, Number(run.queuePosition ?? 1) - 1);
  const currentCreatedAt = Date.parse(job.createdAt ?? "");
  const currentIndex = state.jobs.findIndex((candidate) => candidate.id === job.id);
  const candidates = state.jobs
    .filter((candidate, candidateIndex) => {
      if (candidate.id === job.id) return false;
      if (!activeStatuses.has(candidate.providers?.[providerId]?.state)) return false;
      const candidateCreatedAt = Date.parse(candidate.createdAt ?? "");
      if (Number.isFinite(currentCreatedAt) && Number.isFinite(candidateCreatedAt)) {
        return candidateCreatedAt < currentCreatedAt;
      }
      return currentIndex >= 0 && candidateIndex > currentIndex;
    })
    .sort((left, right) => Date.parse(left.createdAt ?? "") - Date.parse(right.createdAt ?? ""));
  const directBlocker = state.jobs.find((candidate) => candidate.id === run.blockedByJobId);
  if (directBlocker && !candidates.some((candidate) => candidate.id === directBlocker.id)) {
    candidates.unshift(directBlocker);
  }
  const count = Math.max(expected, run.blockedByJobId ? 1 : 0);
  return count ? candidates.slice(0, count) : [];
}

function queueActions(job, providerId, run) {
  const blockers = queueJobsAhead(job, providerId, run);
  if (!blockers.length) return "";
  return `<div class="provider-queue-actions"><span>Search${blockers.length === 1 ? "" : "es"} ahead</span>${blockers
    .map((blocker) => {
      const request = blocker.request ?? {};
      const route = `${(request.origins ?? []).join(", ")} → ${(request.destinations ?? []).join(", ")}`;
      const label = route === " → " ? "previous search" : route;
      return `<button class="queue-cancel" type="button" data-cancel-job="${escapeHtml(blocker.id)}" aria-label="Cancel ${escapeHtml(providerNames[providerId] ?? providerId)} search ahead: ${escapeHtml(label)}">Cancel ${escapeHtml(label)}</button>`;
    })
    .join("")}</div>`;
}

function selectedJob() {
  return state.jobs.find((job) => job.id === state.selectedId) ?? state.jobs[0] ?? null;
}

function debugReportUrl(jobId, provider) {
  return `${apiRoot}/searches/${encodeURIComponent(jobId)}/providers/${encodeURIComponent(provider)}/debug-html`;
}

function renderAirlineCabinChoice(provider) {
  const id = escapeHtml(provider.id);
  const name = escapeHtml(providerNames[provider.id] ?? provider.name);
  return `<div class="airline-cabin-choice" data-airline-cabin="${id}" role="group" aria-label="${name} cabin">
    <span class="airline-cabin-label">${name}</span>
    <label><input type="radio" name="airlineCabin-${id}" value="business" checked><span>Business</span></label>
    <label><input type="radio" name="airlineCabin-${id}" value="first"><span>First</span></label>
  </div>`;
}

function renderProviders(providers) {
  byId("provider-choices").innerHTML = providers
    .map((provider) => {
      return `<label class="choice">
        <input type="checkbox" name="providers" value="${escapeHtml(provider.id)}" ${provider.configured ? "checked" : "disabled"}>
        <span>${escapeHtml(provider.name)}${provider.configured ? "" : " · not configured"}</span>
      </label>`;
    })
    .join("");
  const airlines = providers.filter(
    (provider) => airlineProviderIds.has(provider.id) && provider.configured
  );
  byId("airline-cabin-choices").innerHTML = airlines.length
    ? `<div class="airline-cabin-heading"><strong>Airline cabin</strong></div>${airlines
        .map(renderAirlineCabinChoice)
        .join("")}`
    : "";
  syncAirlineCabinControls();
  const seatsAero = providers.find((provider) => provider.id === "seats_aero");
  programInput?.setOptions(seatsAero?.programs ?? []);
}

function syncAirlineCabinControls() {
  for (const group of document.querySelectorAll("[data-airline-cabin]")) {
    const provider = group.dataset.airlineCabin;
    const enabled = document.querySelector(
      `input[name="providers"][value="${CSS.escape(provider)}"]`
    )?.checked;
    group.classList.toggle("disabled", !enabled);
    for (const input of group.querySelectorAll("input")) input.disabled = !enabled;
  }
}

function renderRun(job) {
  const title = byId("run-title");
  const status = byId("run-status");
  const cancel = byId("cancel-search");
  if (!job) {
    title.textContent = "No search selected";
    status.textContent = "Idle";
    status.className = "status-pill";
    cancel.hidden = true;
    byId("provider-runs").innerHTML =
      '<p class="empty">Start a search to see each provider advance independently.</p>';
    return;
  }
  const request = job.request ?? {};
  title.textContent = `${(request.origins ?? []).join(", ")} → ${(request.destinations ?? []).join(", ")}`;
  status.textContent = String(job.status).replaceAll("_", " ");
  status.className = `status-pill ${job.status}`;
  cancel.hidden = !activeStatuses.has(job.status);
  byId("provider-runs").innerHTML = Object.entries(job.providers ?? {})
    .map(
      ([id, run]) => `<div class="provider-run">
      <div class="provider-run-head"><span>${escapeHtml(providerNames[id] ?? id)}</span>${statusPill(run.state)}</div>
      <p>${escapeHtml(run.message ?? (run.resultCount ? `${run.resultCount} result(s)` : run.state === "queued" ? "Queued by the provider scheduler." : "Starting provider."))}</p>
      ${providerQueueDetails(run)}
      ${queueActions(job, id, run)}
      ${run.errorCode ? `<p class="provider-error-code">Error code: <code>${escapeHtml(run.errorCode)}</code></p>` : ""}
      ${run.debugHtmlAvailable ? `<a class="debug-report-link" href="${debugReportUrl(job.id, id)}" download>Download sanitized selector report</a>` : ""}
      ${run.rateLimitRemaining === null || run.rateLimitRemaining === undefined ? "" : `<p>${number.format(run.rateLimitRemaining)} Seats.aero calls remaining today</p>`}
    </div>`
    )
    .join("");
}

function resultPrice(result) {
  const miles = result.mileage ? `${number.format(result.mileage)} pts` : "Points not reported";
  if (result.taxes === null || result.taxes === undefined) return miles;
  let taxes = `${result.taxes} ${result.taxCurrency ?? ""}`.trim();
  try {
    taxes = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: result.taxCurrency || "USD",
      maximumFractionDigits: 2
    }).format(result.taxes);
  } catch {}
  return `${miles} + ${taxes}`;
}

function resultPoints(result) {
  return result.mileage ? `${number.format(result.mileage)} pts` : "Not reported";
}

function resultTaxes(result) {
  if (result.taxes === null || result.taxes === undefined) return "Not reported";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: result.taxCurrency || "USD",
      maximumFractionDigits: 2
    }).format(result.taxes);
  } catch {
    return `${result.taxes} ${result.taxCurrency ?? ""}`.trim();
  }
}

function safeBookingUrl(value) {
  try {
    const url = new URL(value);
    return new Set(["http:", "https:"]).has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function setFilterOptions(id, values, label) {
  const select = byId(id);
  const selected = select.value;
  const options = [`<option value="">All ${escapeHtml(label)}</option>`].concat(
    values.map(
      (value) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(
          id === "result-provider-filter" ? (providerNames[value] ?? value) : value
        )}</option>`
    )
  );
  const key = JSON.stringify(values);
  if (select.dataset.optionsKey !== key) {
    select.dataset.optionsKey = key;
    select.innerHTML = options.join("");
    if (values.includes(selected)) select.value = selected;
  }
}

function syncResultFilters(results) {
  setFilterOptions(
    "result-provider-filter",
    [...new Set(results.map((result) => result.provider).filter(Boolean))].sort(),
    "providers"
  );
  setFilterOptions(
    "result-cabin-filter",
    [...new Set(results.map((result) => result.cabin).filter(Boolean))].sort(),
    "cabins"
  );
  setFilterOptions(
    "result-program-filter",
    [...new Set(results.map((result) => result.program).filter(Boolean))].sort(),
    "programs"
  );
}

function resultMatchesFilters(result) {
  const provider = byId("result-provider-filter").value;
  const cabin = byId("result-cabin-filter").value;
  const program = byId("result-program-filter").value;
  return (
    (!provider || result.provider === provider) &&
    (!cabin || result.cabin === cabin) &&
    (!program || result.program === program)
  );
}

function resultDetailId(result) {
  return `result-detail-${String(result.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function sortableHeader(label, sort) {
  const active = state.resultSort === sort;
  const direction = active ? state.resultDirection : "none";
  const nextDirection = active && direction === "asc" ? "descending" : "ascending";
  return `<th scope="col" aria-sort="${active ? `${direction}ending` : "none"}">
    <button class="result-sort-button${active ? " active" : ""}" type="button" data-result-sort="${sort}" aria-label="Sort by ${label}, ${nextDirection}">
      <span>${label}</span><span class="result-sort-arrow" aria-hidden="true">${active ? (direction === "asc" ? "↑" : "↓") : "↕"}</span>
    </button>
  </th>`;
}

function formatResultTimestamp(value) {
  if (!value) return "Not reported";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(parsed);
}

function renderResultDetails(result) {
  const segments = result.segments ?? [];
  const segmentMarkup = segments.length
    ? `<ol class="flight-segments">${segments
        .map(
          (segment, index) => `<li class="flight-segment">
            <span class="segment-index">${index + 1}</span>
            <div><strong>${escapeHtml(segment.origin)} → ${escapeHtml(segment.destination)}</strong><span>${escapeHtml(segment.departureLocalTime ?? "Time n/a")} – ${escapeHtml(segment.arrivalLocalTime ?? "Time n/a")}</span></div>
            <div><strong>${escapeHtml(segment.flightNumber)}</strong><span>${escapeHtml(segment.operatingCarrier ?? "Operating carrier n/a")}</span></div>
            <div><strong>${escapeHtml(segment.aircraftName ?? segment.aircraftCode ?? "Aircraft n/a")}</strong><span>${segment.aircraftName && segment.aircraftCode ? escapeHtml(segment.aircraftCode) : ""}</span></div>
            <div><strong>${escapeHtml(segment.cabin ?? result.cabin)}</strong><span>Cabin</span></div>
          </li>`
        )
        .join("")}</ol>`
    : '<p class="result-detail-empty">This provider did not supply segment-level flight details.</p>';
  return `<div class="result-detail-content">
    <div class="result-detail-summary">
      <span><strong>Departure</strong>${escapeHtml(formatResultTimestamp(result.departsAt))}</span>
      <span><strong>Arrival</strong>${escapeHtml(formatResultTimestamp(result.arrivesAt))}</span>
      <span><strong>Award type</strong>${escapeHtml(result.awardType ?? "Not reported")}</span>
      <span><strong>Mixed cabin</strong>${result.mixedCabinPercent === null || result.mixedCabinPercent === undefined ? "Not reported" : `${escapeHtml(result.mixedCabinPercent)}%`}</span>
      <span><strong>Observed</strong>${escapeHtml(formatResultTimestamp(result.observedAt))}</span>
    </div>
    ${segmentMarkup}
  </div>`;
}

function renderResultTable(results) {
  return `<div class="result-table-wrap"><table class="result-table">
    <thead><tr><th scope="col"><span class="visually-hidden">Details</span></th>${sortableHeader("Date", "date")}<th scope="col">Route</th><th scope="col">Cabin</th>${sortableHeader("Points", "points")}<th scope="col">Taxes</th>${sortableHeader("Routing", "stops")}<th scope="col">Seats</th><th scope="col">Source</th><th scope="col">Book</th></tr></thead>
    <tbody>${results
      .map((result) => {
        const bookingUrl = safeBookingUrl(result.bookingUrl);
        const expanded = state.expandedResults.has(result.id);
        const detailId = resultDetailId(result);
        return `<tr class="result-row${isWaitlistResult(result) ? " waitlist" : ""}">
          <td class="result-expand-cell"><button class="result-expand" type="button" data-result-expand="${escapeHtml(result.id)}" aria-expanded="${expanded}" aria-controls="${escapeHtml(detailId)}" aria-label="${expanded ? "Hide" : "Show"} flight details for ${escapeHtml(result.origin)} to ${escapeHtml(result.destination)}"><span aria-hidden="true">${expanded ? "−" : "+"}</span></button></td>
          <td class="result-cell"><strong>${escapeHtml(result.departureDate)}</strong><span>${escapeHtml(formatResultTimestamp(result.departsAt))}</span></td>
          <td class="result-route"><strong>${escapeHtml(result.origin)} → ${escapeHtml(result.destination)}</strong><span>${result.flightNumbers?.length ? escapeHtml(result.flightNumbers.join(", ")) : "Flight n/a"}</span></td>
          <td class="result-cell"><strong>${escapeHtml(result.cabin)}</strong><span>${result.mixedCabinPercent === null || result.mixedCabinPercent === undefined ? "" : `${escapeHtml(result.mixedCabinPercent)}% in cabin`}</span></td>
          <td class="result-cell"><strong>${escapeHtml(resultPoints(result))}</strong><span>${escapeHtml(result.program)}</span></td>
          <td class="result-cell"><strong>${escapeHtml(resultTaxes(result))}</strong><span>${escapeHtml(result.taxCurrency ?? "")}</span></td>
          <td class="result-cell"><strong>${result.stops === 0 ? "Nonstop" : result.stops === null || result.stops === undefined ? "Stops n/a" : `${escapeHtml(result.stops)} stop(s)`}</strong><span>${escapeHtml((result.carriers ?? []).join(", ") || "Carrier n/a")}</span></td>
          <td class="result-cell"><strong>${result.seats ? escapeHtml(result.seats) : "—"}</strong><span>${result.seats ? "available" : "Not reported"}</span></td>
          <td class="result-cell result-provider">${escapeHtml(providerNames[result.provider] ?? result.provider)}${isWaitlistResult(result) ? '<span class="availability-badge">Waitlist · not bookable</span>' : ""}</td>
          <td class="result-cell">${bookingUrl && !isWaitlistResult(result) ? `<a class="booking-link" href="${escapeHtml(bookingUrl)}" target="_blank" rel="noopener noreferrer">Open</a>` : "—"}</td>
        </tr>${expanded ? `<tr class="result-detail-row" id="${escapeHtml(detailId)}"><td colspan="10">${renderResultDetails(result)}</td></tr>` : ""}`;
      })
      .join("")}</tbody>
  </table></div>`;
}

function renderDateGrid(results) {
  const dates = [...new Set(results.map((result) => result.departureDate).filter(Boolean))].sort();
  const cabins = [...new Set(results.map((result) => result.cabin).filter(Boolean))];
  const cabinOrder = ["economy", "premium", "business", "first"];
  cabins.sort((left, right) => cabinOrder.indexOf(left) - cabinOrder.indexOf(right));
  const best = new Map();
  for (const result of results) {
    const key = `${result.departureDate}:${result.cabin}`;
    const current = best.get(key);
    if (
      !current ||
      (result.mileage ?? Number.POSITIVE_INFINITY) < (current.mileage ?? Number.POSITIVE_INFINITY)
    ) {
      best.set(key, result);
    }
  }
  return `<div class="result-table-wrap"><table class="date-result-grid">
    <thead><tr><th scope="col">Date</th>${cabins.map((cabin) => `<th scope="col">${escapeHtml(cabin)}</th>`).join("")}</tr></thead>
    <tbody>${dates
      .map(
        (date) =>
          `<tr><th scope="row">${escapeHtml(date)}</th>${cabins
            .map((cabin) => {
              const result = best.get(`${date}:${cabin}`);
              if (!result) return "<td>—</td>";
              const bookingUrl = safeBookingUrl(result.bookingUrl);
              const content = `<strong>${escapeHtml(resultPrice(result))}</strong><span>${escapeHtml(providerNames[result.provider] ?? result.provider)} · ${escapeHtml(result.program)}</span>`;
              return `<td class="${isWaitlistResult(result) ? "waitlist" : ""}">${bookingUrl && !isWaitlistResult(result) ? `<a href="${escapeHtml(bookingUrl)}" target="_blank" rel="noopener noreferrer">${content}</a>` : content}</td>`;
            })
            .join("")}</tr>`
      )
      .join("")}</tbody>
  </table></div>`;
}

function renderResults(job) {
  const allResults = job?.results ?? [];
  syncResultFilters(allResults);
  const sorted = sortAwardResults(allResults, state.resultSort, state.resultDirection);
  const partitioned = partitionAwardResults(sorted);
  const showWaitlist = byId("show-waitlist").checked;
  const visibleByAvailability = showWaitlist ? sorted : partitioned.available;
  const results = visibleByAvailability.filter(resultMatchesFilters);
  const waitlistSummary = partitioned.waitlist.length
    ? ` · ${partitioned.waitlist.length} waitlist${showWaitlist ? "" : " hidden"}`
    : "";
  const filteredSummary =
    results.length === visibleByAvailability.length ? "" : ` · ${results.length} shown`;
  byId("result-count").textContent =
    `${partitioned.available.length} available${waitlistSummary}${filteredSummary}`;
  const emptyMessage =
    !showWaitlist && partitioned.waitlist.length
      ? "Only waitlist inventory was returned. Turn on Show waitlist to inspect it."
      : job && terminalStatuses.has(job.status)
        ? "No matching award options were returned."
        : "Award options will appear here as providers finish.";
  const view = byId("result-view").value;
  const renderKey = JSON.stringify([
    job?.id,
    job?.status,
    results,
    view,
    emptyMessage,
    state.resultSort,
    state.resultDirection,
    [...state.expandedResults].sort()
  ]);
  const region = byId("results");
  if (region.dataset.renderKey === renderKey) return;
  region.dataset.renderKey = renderKey;
  region.innerHTML = results.length
    ? view === "grid"
      ? renderDateGrid(results)
      : renderResultTable(results)
    : `<p class="empty">${emptyMessage}</p>`;
}

function screenshotUrl(jobId, challengeId) {
  return `${apiRoot}/searches/${encodeURIComponent(jobId)}/challenges/${encodeURIComponent(challengeId)}/screenshot?t=${Date.now()}`;
}

function challengeKey(jobId, challengeId) {
  return `${jobId}:${challengeId}`;
}

function challengeKindLabel(challenge) {
  if (challenge.kind === "browser_handoff") return "stuck page";
  if (challenge.kind === "email_otp") return "email code";
  if (challenge.kind === "sms_otp") return "SMS code";
  if (challenge.kind.includes("captcha")) return "CAPTCHA";
  return challenge.kind.replaceAll("_", " ");
}

function captureChallengeUi(region) {
  for (const card of region.querySelectorAll(".challenge-card")) {
    const frame = card.querySelector(".browser-frame");
    const marker = card.querySelector(".browser-focus-marker");
    state.challengeUi.set(challengeKey(card.dataset.jobId, card.dataset.challengeId), {
      challengeValue: card.querySelector("[data-challenge-value]")?.value ?? "",
      browserText: card.querySelector("[data-browser-text]")?.value ?? "",
      nativeZoom: frame?.classList.contains("zoom-native") ?? false,
      scrollLeft: frame?.scrollLeft ?? 0,
      scrollTop: frame?.scrollTop ?? 0,
      markerLeft: marker?.style.left ?? "",
      markerTop: marker?.style.top ?? ""
    });
  }
}

function restoreChallengeUi(region) {
  for (const card of region.querySelectorAll(".challenge-card")) {
    const saved = state.challengeUi.get(challengeKey(card.dataset.jobId, card.dataset.challengeId));
    if (!saved) continue;
    const challengeInput = card.querySelector("[data-challenge-value]");
    const browserInput = card.querySelector("[data-browser-text]");
    const frame = card.querySelector(".browser-frame");
    if (challengeInput) challengeInput.value = saved.challengeValue;
    if (browserInput) browserInput.value = saved.browserText;
    if (frame && saved.nativeZoom) {
      frame.classList.add("zoom-native");
      const zoom = card.querySelector("[data-browser-zoom]");
      if (zoom) zoom.textContent = "Fit";
    }
    if (frame) {
      frame.scrollLeft = saved.scrollLeft;
      frame.scrollTop = saved.scrollTop;
    }
    if (saved.markerLeft && saved.markerTop) {
      addBrowserFocusMarker(card, saved.markerLeft, saved.markerTop);
    }
  }
}

function previewControls(interactive) {
  return `<div class="preview-controls">
    <span data-preview-age>Capturing preview…</span>
    <button class="control-button" type="button" data-browser-zoom>1:1</button>
    <button class="control-button" type="button" data-preview-refresh>Refresh preview</button>
    <button class="control-button" type="button" data-browser-scroll="-650">Scroll up</button>
    <button class="control-button" type="button" data-browser-scroll="650">Scroll down</button>
    ${interactive ? '<span class="preview-hint" data-browser-focus>No field selected · click a field, then type or paste</span>' : ""}
  </div>`;
}

function bindChallengePreviews(region) {
  for (const image of region.querySelectorAll(".browser-shot")) {
    image.dataset.loading = image.complete ? "false" : "true";
    if (image.complete && image.naturalWidth) image.dataset.capturedAt = String(Date.now());
    image.addEventListener("load", () => {
      image.dataset.capturedAt = String(Date.now());
      image.dataset.loading = "false";
      updatePreviewAge(image.closest(".challenge-card"));
    });
    image.addEventListener("error", () => {
      image.dataset.loading = "false";
      const label = image.closest(".challenge-card")?.querySelector("[data-preview-age]");
      if (label) label.textContent = "Preview unavailable — try again";
    });
  }
}

function updatePreviewAge(card) {
  const image = card?.querySelector(".browser-shot");
  const label = card?.querySelector("[data-preview-age]");
  if (!image || !label) return;
  const capturedAt = Number(image.dataset.capturedAt);
  if (!capturedAt) return;
  const seconds = Math.max(0, Math.floor((Date.now() - capturedAt) / 1000));
  label.textContent = `Captured ${seconds}s ago`;
}

function refreshPreview(card) {
  const image = card?.querySelector(".browser-shot");
  if (!image || image.dataset.loading === "true") return;
  image.dataset.loading = "true";
  image.src = screenshotUrl(card.dataset.jobId, card.dataset.challengeId);
}

function refreshChallengePreviews() {
  for (const card of document.querySelectorAll(".challenge-card:not([hidden])")) {
    updatePreviewAge(card);
    const image = card.querySelector(".browser-shot");
    const capturedAt = Number(image?.dataset.capturedAt ?? 0);
    if (image && Date.now() - capturedAt >= 3000) refreshPreview(card);
  }
}

function activateChallenge(jobId, challengeId, { focus = false, scroll = false } = {}) {
  state.activeChallenges.set(jobId, challengeId);
  for (const tab of document.querySelectorAll(
    `[data-challenge-tab][data-job-id="${CSS.escape(jobId)}"]`
  )) {
    const active = tab.dataset.challengeId === challengeId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  for (const card of document.querySelectorAll(
    `.challenge-card[data-job-id="${CSS.escape(jobId)}"]`
  )) {
    card.hidden = card.dataset.challengeId !== challengeId;
  }
  const card = document.querySelector(
    `.challenge-card[data-job-id="${CSS.escape(jobId)}"][data-challenge-id="${CSS.escape(challengeId)}"]`
  );
  const capturedAt = Number(card?.querySelector(".browser-shot")?.dataset.capturedAt ?? 0);
  if (card && Date.now() - capturedAt >= 3000) refreshPreview(card);
  if (scroll) byId("challenge-region").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderInterventionQueue(job, challenges, activeId) {
  const queue = byId("intervention-queue");
  if (!job || !challenges.length) {
    queue.hidden = true;
    queue.innerHTML = "";
    queue.dataset.renderKey = "";
    return;
  }
  const renderKey = JSON.stringify([job.id, challenges]);
  if (queue.dataset.renderKey === renderKey) return;
  queue.dataset.renderKey = renderKey;
  queue.hidden = false;
  queue.innerHTML = `<strong>${challenges.length} provider${challenges.length === 1 ? "" : "s"} need${challenges.length === 1 ? "s" : ""} you</strong>
    <div class="intervention-tabs" role="tablist" aria-label="Airline searches needing intervention">
      ${challenges
        .map((challenge, index) => {
          const active = challenge.id === activeId;
          const provider = providerNames[challenge.provider] ?? challenge.provider;
          const kind = challengeKindLabel(challenge);
          return `<button type="button" role="tab" id="challenge-tab-${index}" aria-label="${escapeHtml(provider)} ${escapeHtml(kind)}" aria-controls="challenge-panel-${index}" aria-selected="${active}" tabindex="${active ? "0" : "-1"}" class="intervention-tab${active ? " active" : ""}" data-job-id="${escapeHtml(job.id)}" data-challenge-id="${escapeHtml(challenge.id)}" data-challenge-tab><span>${escapeHtml(provider)}</span>${escapeHtml(kind)}</button>`;
        })
        .join("")}
    </div>`;
}

function renderChallenges(job) {
  const challenges = Object.values(job?.providers ?? {})
    .map((run) => run.challenge)
    .filter((challenge) => challenge?.status === "pending");
  const region = byId("challenge-region");
  const renderKey = JSON.stringify([job?.id, challenges]);
  const pendingIds = new Set(challenges.map((challenge) => challenge.id));
  let activeId = state.activeChallenges.get(job?.id);
  if (!pendingIds.has(activeId)) activeId = challenges[0]?.id;
  if (job?.id && activeId) state.activeChallenges.set(job.id, activeId);
  renderInterventionQueue(job, challenges, activeId);
  if (region.dataset.renderKey === renderKey) {
    if (job?.id && activeId) activateChallenge(job.id, activeId);
    return;
  }
  captureChallengeUi(region);
  if (job?.id) {
    for (const key of state.challengeUi.keys()) {
      if (key.startsWith(`${job.id}:`) && !pendingIds.has(key.slice(job.id.length + 1))) {
        state.challengeUi.delete(key);
        state.browserTypeQueues.delete(key);
        state.browserActionChains.delete(key);
      }
    }
  }
  region.dataset.renderKey = renderKey;
  region.innerHTML = challenges
    .map((challenge, index) => {
      const acknowledgement = challenge.responseFormat === "acknowledge";
      const inputLabel = challenge.kind.includes("otp") ? "One-time code" : "CAPTCHA response";
      const active = challenge.id === activeId;
      const next = challenges[(index + 1) % challenges.length];
      return `<article class="challenge-card ${acknowledgement ? "browser-handoff-challenge" : "verification-challenge"}" role="tabpanel" id="challenge-panel-${index}" aria-labelledby="challenge-tab-${index}" data-job-id="${escapeHtml(job.id)}" data-challenge-id="${escapeHtml(challenge.id)}" ${active ? "" : "hidden"}>
        <div class="challenge-copy">
          <div class="challenge-heading"><p class="section-label">Needs you</p><h2>${escapeHtml(providerNames[challenge.provider] ?? challenge.provider)} · ${escapeHtml(challengeKindLabel(challenge))}</h2>${challenges.length > 1 ? `<span>Next: ${escapeHtml(providerNames[next.provider] ?? next.provider)} · ${escapeHtml(challengeKindLabel(next))}</span>` : ""}</div>
          <p>${escapeHtml(challenge.prompt)}</p>
          <span class="challenge-expiry">Expires ${escapeHtml(new Date(challenge.expiresAt).toLocaleString())}.</span>
        </div>
        ${challenge.screenshotAvailable ? `<div class="browser-frame"><div class="browser-canvas" ${acknowledgement ? 'tabindex="0" role="application" data-browser-input-surface aria-label="Interactive airline browser preview. Click a field, then type or paste."' : ""}><img class="browser-shot" data-interactive="${acknowledgement}" src="${screenshotUrl(job.id, challenge.id)}" alt="Redacted live ${escapeHtml(challenge.provider)} browser preview"></div></div>${previewControls(acknowledgement)}` : ""}
        ${
          acknowledgement
            ? `<div class="challenge-controls acknowledgement-controls">
          <details class="browser-tools" open>
            <summary>Manual browser controls</summary>
            <p>Correct the airline form here. Account and password fields are filled automatically and intentionally hidden.</p>
            <div class="browser-type-row"><label>Text for selected field<input data-browser-text type="text" autocomplete="off" placeholder="For example, SFO"></label><div class="browser-type-actions"><button class="primary-button" type="button" data-browser-replace>Replace field</button><button class="secondary-button" type="button" data-browser-type>Append</button></div></div>
            <div class="browser-buttons"><button class="control-button" type="button" data-browser-key="Tab">Tab</button><button class="control-button" type="button" data-browser-key="Enter">Enter</button><button class="control-button" type="button" data-browser-key="Escape">Escape</button><button class="control-button" type="button" data-browser-key="Backspace" title="Delete one character to the left">← Backspace</button><button class="control-button" type="button" data-browser-key="Delete" title="Delete one character to the right">Delete →</button><button class="control-button" type="button" data-browser-key="ArrowUp">↑</button><button class="control-button" type="button" data-browser-key="ArrowDown">↓</button></div>
            <button class="danger-button" type="button" data-browser-reload>Reload airline page…</button>
          </details>
          <button class="secondary-button continue-button" type="button" data-challenge-submit>I finished — continue search</button>
        </div>`
            : `<div class="challenge-controls"><input data-challenge-value autocomplete="one-time-code" inputmode="text" placeholder="${escapeHtml(inputLabel)}"><button class="primary-button" type="button" data-challenge-submit>Submit</button><small>Codes are not saved.</small></div>`
        }
        <p class="challenge-action-status" data-challenge-status role="status"></p>
      </article>`;
    })
    .join("");
  bindChallengePreviews(region);
  restoreChallengeUi(region);
  if (job?.id && activeId) activateChallenge(job.id, activeId);
}

function renderHistory() {
  const region = byId("search-history");
  const renderKey = JSON.stringify(
    state.jobs.map((job) => [job.id, job.status, job.request, job.id === state.selectedId])
  );
  if (region.dataset.renderKey === renderKey) return;
  region.dataset.renderKey = renderKey;
  region.innerHTML = state.jobs.length
    ? state.jobs
        .map((job) => {
          const request = job.request ?? {};
          return `<div class="history-row ${job.id === state.selectedId ? "selected" : ""}">
          <button class="history-select" type="button" data-select-job="${escapeHtml(job.id)}" aria-label="View ${escapeHtml((request.origins ?? []).join(", "))} to ${escapeHtml((request.destinations ?? []).join(", "))} search">
          <strong>${escapeHtml((request.origins ?? []).join(", "))} → ${escapeHtml((request.destinations ?? []).join(", "))}</strong>
          <span>${escapeHtml(request.departureStart ?? "")}${request.departureEnd && request.departureEnd !== request.departureStart ? ` – ${escapeHtml(request.departureEnd)}` : ""}</span>
          <span>${escapeHtml((request.providers ?? []).map((id) => providerNames[id] ?? id).join(", "))}</span>
          ${statusPill(job.status)}
          </button>
          <button class="history-quickfill" type="button" data-fill-job="${escapeHtml(job.id)}">Use as search</button>
          ${activeStatuses.has(job.status) ? `<button class="history-cancel" type="button" data-cancel-job="${escapeHtml(job.id)}" aria-label="Cancel ${escapeHtml((request.origins ?? []).join(", "))} to ${escapeHtml((request.destinations ?? []).join(", "))} search">Cancel</button>` : ""}
        </div>`;
        })
        .join("")
    : '<p class="empty">No searches yet.</p>';
}

function fillSearchFromJob(job) {
  const request = job?.request ?? {};
  const form = byId("search-form");
  originInput.setValues(request.origins ?? []);
  destinationInput.setValues(request.destinations ?? []);
  form.elements.passengers.value = String(request.passengers ?? 1);
  form.elements.maxStops.value = request.maxStops ?? "";
  form.elements.maxPoints.value = request.maxPoints ?? "";
  programInput.setValues(request.seatsAeroSources ?? []);

  const departureStart = request.departureStart ?? "";
  const departureEnd = request.departureEnd ?? departureStart;
  departurePicker?.setRange(departureStart, departureEnd, { emit: true });
  if (request.returnStart) {
    returnPicker?.setRange(request.returnStart, request.returnEnd ?? request.returnStart, {
      emit: true
    });
  } else {
    returnPicker?.setRange("", "", { emit: true });
  }

  const cabins = new Set(request.cabins ?? []);
  for (const input of document.querySelectorAll('input[name="cabins"]')) {
    input.checked = cabins.has(input.value);
  }
  const providers = new Set(request.providers ?? []);
  const unavailableProviders = [];
  for (const provider of providers) {
    const input = document.querySelector(
      `input[name="providers"][value="${CSS.escape(provider)}"]`
    );
    if (!input || input.disabled) unavailableProviders.push(providerNames[provider] ?? provider);
  }
  for (const input of document.querySelectorAll('input[name="providers"]')) {
    input.checked = !input.disabled && providers.has(input.value);
  }
  syncAirlineCabinControls();
  const defaultAirlineCabin =
    (request.cabins ?? []).find((cabin) => new Set(["business", "first"]).has(cabin)) ?? "business";
  for (const provider of airlineProviderIds) {
    const cabin = request.airlineCabins?.[provider] ?? defaultAirlineCabin;
    const input = document.querySelector(
      `input[name="airlineCabin-${CSS.escape(provider)}"][value="${CSS.escape(cabin)}"]`
    );
    if (input && !input.disabled) input.checked = true;
  }

  state.selectedId = job.id;
  render();
  const restoredRange = departurePicker?.getRange();
  const note =
    restoredRange?.start !== departureStart
      ? " The saved dates are no longer selectable."
      : unavailableProviders.length
        ? ` ${unavailableProviders.join(", ")} is not currently configured.`
        : "";
  byId("form-status").textContent =
    `Recent search copied. Review it, then start a new search.${note}`;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function render() {
  const job = selectedJob();
  if (job && !state.selectedId) state.selectedId = job.id;
  renderRun(job);
  renderResults(job);
  renderChallenges(job);
  renderHistory();
}

function scheduleRefresh() {
  clearTimeout(state.timer);
  const delay = state.jobs.some((job) => activeStatuses.has(job.status)) ? 2500 : 10_000;
  state.timer = setTimeout(refreshSearches, delay);
}

async function refreshSearches() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    state.jobs = await api("/searches?limit=50");
    if (state.selectedId && !state.jobs.some((job) => job.id === state.selectedId))
      state.selectedId = null;
    render();
    byId("service-state").textContent = "Flight Searcher online";
    byId("service-state").className = "service-state ready";
  } catch (error) {
    byId("service-state").textContent = error.message;
    byId("service-state").className = "service-state error";
  } finally {
    state.refreshing = false;
    scheduleRefresh();
  }
}

async function cancelJob(jobId, button = null) {
  if (!jobId) return;
  if (button) button.disabled = true;
  try {
    const updated = await api(`/searches/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: {}
    });
    state.jobs = state.jobs.map((item) => (item.id === updated.id ? updated : item));
    render();
    await refreshSearches();
  } catch (error) {
    byId("service-state").textContent = error.message;
    byId("service-state").className = "service-state error";
    if (button) button.disabled = false;
  }
}

async function browserAction(card, action) {
  const jobId = card.dataset.jobId;
  const challengeId = card.dataset.challengeId;
  const key = challengeKey(jobId, challengeId);
  const previous = state.browserActionChains.get(key) ?? Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(async () => {
      await api(
        `/searches/${encodeURIComponent(jobId)}/challenges/${encodeURIComponent(challengeId)}/browser-actions`,
        { method: "POST", body: action }
      );
      const image = card.querySelector(".browser-shot");
      if (image)
        window.setTimeout(() => {
          refreshPreview(card);
        }, 450);
    });
  state.browserActionChains.set(key, pending);
  try {
    await pending;
  } finally {
    if (state.browserActionChains.get(key) === pending) state.browserActionChains.delete(key);
  }
}

function setChallengeStatus(card, message, kind = "") {
  const status = card.querySelector("[data-challenge-status]");
  if (!status) return;
  status.textContent = message;
  status.className = `challenge-action-status ${kind}`.trim();
}

function showClickMarker(image, clientX, clientY) {
  const rect = image.getBoundingClientRect();
  const marker = document.createElement("span");
  marker.className = "browser-click-marker";
  marker.style.left = `${((clientX - rect.left) / rect.width) * 100}%`;
  marker.style.top = `${((clientY - rect.top) / rect.height) * 100}%`;
  image.closest(".browser-canvas").append(marker);
  window.setTimeout(() => marker.remove(), 1100);
}

function addBrowserFocusMarker(card, left, top) {
  const canvas = card.querySelector(".browser-canvas");
  if (!canvas) return;
  canvas.querySelector(".browser-focus-marker")?.remove();
  const marker = document.createElement("span");
  marker.className = "browser-focus-marker";
  marker.style.left = typeof left === "number" ? `${left}%` : left;
  marker.style.top = typeof top === "number" ? `${top}%` : top;
  marker.setAttribute("aria-hidden", "true");
  marker.innerHTML = "<span>Selected field</span>";
  canvas.append(marker);
  const label = card.querySelector("[data-browser-focus]");
  if (label) label.textContent = "Field selected · Replace field overwrites its current value";
}

function markBrowserFocus(card, image, clientX, clientY) {
  const rect = image.getBoundingClientRect();
  addBrowserFocusMarker(
    card,
    ((clientX - rect.left) / rect.width) * 100,
    ((clientY - rect.top) / rect.height) * 100
  );
  card.querySelector("[data-browser-input-surface]")?.focus({ preventScroll: true });
}

function flushBrowserText(card) {
  const key = challengeKey(card.dataset.jobId, card.dataset.challengeId);
  const queued = state.browserTypeQueues.get(key);
  if (!queued?.text) return queued?.chain ?? Promise.resolve();
  clearTimeout(queued.timer);
  const value = queued.text;
  queued.text = "";
  queued.chain = queued.chain.then(async () => {
    try {
      await browserAction(card, { kind: "type", text: value });
      setChallengeStatus(card, "Typed into the selected airline field.", "success");
    } catch (error) {
      setChallengeStatus(card, error.message, "error");
    }
  });
  return queued.chain;
}

function queueBrowserText(card, text) {
  if (!text) return;
  const key = challengeKey(card.dataset.jobId, card.dataset.challengeId);
  const queued = state.browserTypeQueues.get(key) ?? {
    text: "",
    timer: null,
    chain: Promise.resolve()
  };
  queued.text += text;
  clearTimeout(queued.timer);
  queued.timer = window.setTimeout(() => flushBrowserText(card), 120);
  state.browserTypeQueues.set(key, queued);
  setChallengeStatus(card, "Typing into the selected airline field…");
}

byId("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const cabins = checkedValues("cabins");
  const providers = checkedValues("providers");
  originInput.commit();
  destinationInput.commit();
  programInput.commit();
  const origins = originInput.getValues();
  const destinations = destinationInput.getValues();
  if (!cabins.length || !providers.length) {
    byId("form-status").textContent = "Choose at least one cabin and one configured provider.";
    return;
  }
  if (!origins.length || !destinations.length) {
    byId("form-status").textContent = "Choose at least one valid origin and destination code.";
    return;
  }
  if (!data.get("departureStart") || !data.get("departureEnd")) {
    byId("form-status").textContent = "Choose a complete departure date range.";
    return;
  }
  const payload = {
    origins,
    destinations,
    departureStart: data.get("departureStart"),
    departureEnd: data.get("departureEnd"),
    passengers: Number(data.get("passengers")),
    cabins,
    providers,
    seatsAeroSources: programInput.getValues()
  };
  const airlineCabins = {};
  for (const provider of providers.filter((provider) => airlineProviderIds.has(provider))) {
    const input = form.querySelector(`input[name="airlineCabin-${CSS.escape(provider)}"]:checked`);
    if (!input) {
      byId("form-status").textContent =
        `Choose Business or First for ${providerNames[provider] ?? provider}.`;
      return;
    }
    airlineCabins[provider] = input.value;
  }
  if (Object.keys(airlineCabins).length) payload.airlineCabins = airlineCabins;
  if (data.get("returnStart")) payload.returnStart = data.get("returnStart");
  if (data.get("returnEnd")) payload.returnEnd = data.get("returnEnd");
  if (data.get("maxPoints") !== "") payload.maxPoints = Number(data.get("maxPoints"));
  if (data.get("maxStops") !== "") payload.maxStops = Number(data.get("maxStops"));
  const submit = byId("search-submit");
  submit.disabled = true;
  byId("form-status").textContent = "Starting provider searches…";
  try {
    const job = await api("/searches", { method: "POST", body: payload });
    state.selectedId = job.id;
    state.jobs = [job, ...state.jobs.filter((item) => item.id !== job.id)];
    render();
    byId("form-status").textContent = "Search started. You can leave this page and return later.";
    scheduleRefresh();
  } catch (error) {
    byId("form-status").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

byId("search-history").addEventListener("click", (event) => {
  const cancel = event.target.closest("[data-cancel-job]");
  if (cancel) {
    void cancelJob(cancel.dataset.cancelJob, cancel);
    return;
  }
  const quickfill = event.target.closest("[data-fill-job]");
  if (quickfill) {
    const job = state.jobs.find((item) => item.id === quickfill.dataset.fillJob);
    if (job) fillSearchFromJob(job);
    return;
  }
  const button = event.target.closest("[data-select-job]");
  if (!button) return;
  state.selectedId = button.dataset.selectJob;
  render();
});

byId("provider-runs").addEventListener("click", (event) => {
  const cancel = event.target.closest("[data-cancel-job]");
  if (cancel) {
    void cancelJob(cancel.dataset.cancelJob, cancel);
    return;
  }
  const select = event.target.closest("[data-select-job-inline]");
  if (!select) return;
  state.selectedId = select.dataset.selectJobInline;
  render();
});

byId("intervention-queue").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-challenge-tab]");
  if (!tab) return;
  activateChallenge(tab.dataset.jobId, tab.dataset.challengeId, { scroll: true });
});

byId("intervention-queue").addEventListener("keydown", (event) => {
  const tab = event.target.closest("[data-challenge-tab]");
  if (!tab || !new Set(["ArrowLeft", "ArrowRight", "Home", "End"]).has(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll("[data-challenge-tab]")];
  const current = tabs.indexOf(tab);
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  const next = tabs[nextIndex];
  activateChallenge(next.dataset.jobId, next.dataset.challengeId, { focus: true });
});

byId("cancel-search").addEventListener("click", async () => {
  const job = selectedJob();
  if (!job) return;
  await cancelJob(job.id, byId("cancel-search"));
});

byId("challenge-region").addEventListener("click", async (event) => {
  const card = event.target.closest(".challenge-card");
  if (!card) return;
  try {
    setChallengeStatus(card, "");
    if (event.target.matches("[data-challenge-submit]")) {
      const input = card.querySelector("[data-challenge-value]");
      const value = input ? input.value.trim() : "continue";
      if (!value) return;
      if (input) input.value = "";
      await api(
        `/searches/${encodeURIComponent(card.dataset.jobId)}/challenges/${encodeURIComponent(card.dataset.challengeId)}/respond`,
        { method: "POST", body: { value } }
      );
      await refreshSearches();
    } else if (event.target.matches("[data-preview-refresh]")) {
      refreshPreview(card);
    } else if (event.target.matches("[data-browser-zoom]")) {
      const frame = card.querySelector(".browser-frame");
      const native = frame.classList.toggle("zoom-native");
      event.target.textContent = native ? "Fit" : "1:1";
      event.target.setAttribute("aria-label", native ? "Fit preview" : "Show preview at 1 to 1");
    } else if (event.target.matches("[data-browser-type]")) {
      const input = card.querySelector("[data-browser-text]");
      const text = input.value;
      input.value = "";
      if (text) await browserAction(card, { kind: "type", text });
    } else if (event.target.matches("[data-browser-replace]")) {
      const input = card.querySelector("[data-browser-text]");
      const text = input.value;
      input.value = "";
      if (text) await browserAction(card, { kind: "replace", text });
    } else if (event.target.matches("[data-browser-key]")) {
      await browserAction(card, { kind: "key", key: event.target.dataset.browserKey });
    } else if (event.target.matches("[data-browser-scroll]")) {
      await browserAction(card, {
        kind: "scroll",
        deltaY: Number(event.target.dataset.browserScroll)
      });
    } else if (event.target.matches("[data-browser-reload]")) {
      if (
        window.confirm(
          "Reload the airline page? Unsaved form corrections on the airline site will be lost."
        )
      ) {
        await browserAction(card, { kind: "refresh" });
      }
    } else if (
      event.target.matches(".browser-shot") &&
      event.target.dataset.interactive === "true"
    ) {
      const rect = event.target.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * event.target.naturalWidth;
      const y = ((event.clientY - rect.top) / rect.height) * event.target.naturalHeight;
      showClickMarker(event.target, event.clientX, event.clientY);
      markBrowserFocus(card, event.target, event.clientX, event.clientY);
      await browserAction(card, { kind: "click", x, y });
    }
    if (
      event.target.matches(
        "[data-browser-type], [data-browser-replace], [data-browser-key], [data-browser-scroll]"
      )
    ) {
      setChallengeStatus(card, "Browser action sent. Preview will update shortly.", "success");
    }
  } catch (error) {
    setChallengeStatus(card, error.message, "error");
  }
});

byId("challenge-region").addEventListener("keydown", async (event) => {
  const surface = event.target.closest("[data-browser-input-surface]");
  if (!surface) return;
  const card = surface.closest(".challenge-card");
  const directKeys = new Set([
    "Enter",
    "Tab",
    "Escape",
    "Backspace",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "PageUp",
    "PageDown",
    "Home",
    "End"
  ]);
  if (directKeys.has(event.key)) {
    event.preventDefault();
    try {
      await flushBrowserText(card);
      await browserAction(card, { kind: "key", key: event.key });
      const focus = card.querySelector("[data-browser-focus]");
      if (focus) focus.textContent = `${event.key} sent · airline focus may have moved`;
      setChallengeStatus(card, `${event.key} sent to the airline page.`, "success");
    } catch (error) {
      setChallengeStatus(card, error.message, "error");
    }
    return;
  }
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    queueBrowserText(card, event.key);
  }
});

byId("challenge-region").addEventListener("paste", (event) => {
  const surface = event.target.closest("[data-browser-input-surface]");
  if (!surface) return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!text) return;
  event.preventDefault();
  queueBrowserText(surface.closest(".challenge-card"), text);
});

for (const id of [
  "show-waitlist",
  "result-provider-filter",
  "result-cabin-filter",
  "result-program-filter",
  "result-view"
]) {
  byId(id).addEventListener("change", () => renderResults(selectedJob()));
}

byId("provider-choices").addEventListener("change", syncAirlineCabinControls);

byId("results").addEventListener("click", (event) => {
  const sort = event.target.closest("[data-result-sort]");
  if (sort) {
    if (state.resultSort === sort.dataset.resultSort) {
      state.resultDirection = state.resultDirection === "asc" ? "desc" : "asc";
    } else {
      state.resultSort = sort.dataset.resultSort;
      state.resultDirection = "asc";
    }
    renderResults(selectedJob());
    return;
  }
  const expand = event.target.closest("[data-result-expand]");
  if (!expand) return;
  const resultId = expand.dataset.resultExpand;
  if (state.expandedResults.has(resultId)) state.expandedResults.delete(resultId);
  else state.expandedResults.add(resultId);
  renderResults(selectedJob());
});

byId("refresh-searches").addEventListener("click", refreshSearches);

async function main() {
  originInput = createTokenInput(document.querySelector('[data-token-field="origins"]'), {
    choices: airportChoices,
    allowCustomPattern: /^[A-Za-z]{3}$/,
    invalidMessage: "Choose a city suggestion or enter a three-letter IATA code."
  });
  destinationInput = createTokenInput(document.querySelector('[data-token-field="destinations"]'), {
    choices: airportChoices,
    allowCustomPattern: /^[A-Za-z]{3}$/,
    invalidMessage: "Choose a city suggestion or enter a three-letter IATA code."
  });
  programInput = createTokenInput(document.querySelector('[data-token-field="programs"]'), {
    choices: [],
    invalidMessage: "Choose a supported Seats.aero program from the suggestions."
  });
  departurePicker = createDateRangePicker(
    document.querySelector('[data-date-range-picker="departure"]'),
    {
      label: "Departure window",
      startName: "departureStart",
      endName: "departureEnd",
      start: futureDateValue(30),
      end: futureDateValue(37),
      min: futureDateValue(0),
      emptyLabel: "Choose departure dates",
      emptyMeta: "Flexible outbound window",
      onChange: ({ end }) => returnPicker?.setMin(end)
    }
  );
  returnPicker = createDateRangePicker(
    document.querySelector('[data-date-range-picker="return"]'),
    {
      label: "Return window",
      startName: "returnStart",
      endName: "returnEnd",
      min: departurePicker.getRange().end,
      emptyLabel: "Add return dates",
      emptyMeta: "For ANA and JAL searches",
      optional: true
    }
  );
  state.previewTimer = window.setInterval(refreshChallengePreviews, 1000);
  try {
    renderProviders(await api("/providers"));
    await refreshSearches();
  } catch (error) {
    byId("provider-choices").innerHTML =
      `<span class="loading-line">${escapeHtml(error.message)}</span>`;
    byId("service-state").textContent = error.message;
    byId("service-state").className = "service-state error";
    scheduleRefresh();
  }
}

main();
