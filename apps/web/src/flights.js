import { createDateRangePicker, futureDateValue } from "./date-range-picker.js";
import { isWaitlistResult, partitionAwardResults, sortAwardResults } from "./flight-results.js";
import { createTokenInput } from "./token-input.js";

const apiRoot = "/api/integrations/flight-searcher";
const activeStatuses = new Set(["queued", "running", "waiting_human"]);
const terminalStatuses = new Set(["completed", "partial", "failed", "canceled"]);
const providerNames = { seats_aero: "Seats.aero", ana: "ANA", jal: "JAL", eva: "EVA" };
const state = { jobs: [], selectedId: null, refreshing: false, timer: null, previewTimer: null };
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

function selectedJob() {
  return state.jobs.find((job) => job.id === state.selectedId) ?? state.jobs[0] ?? null;
}

function debugReportUrl(jobId, provider) {
  return `${apiRoot}/searches/${encodeURIComponent(jobId)}/providers/${encodeURIComponent(provider)}/debug-html`;
}

function renderProviders(providers) {
  byId("provider-choices").innerHTML = providers
    .map((provider) => {
      const challenges = (provider.humanChallenges ?? [])
        .map((item) => item.replaceAll("_", " "))
        .join(", ");
      return `<label class="choice">
        <input type="checkbox" name="providers" value="${escapeHtml(provider.id)}" ${provider.configured ? "checked" : "disabled"}>
        <span>${escapeHtml(provider.name)}${provider.configured ? "" : " · not configured"}${provider.scope ? `<small class="provider-note">${escapeHtml(provider.scope)}</small>` : ""}${challenges ? `<small class="provider-note">Human: ${escapeHtml(challenges)}</small>` : ""}</span>
      </label>`;
    })
    .join("");
  const seatsAero = providers.find((provider) => provider.id === "seats_aero");
  programInput?.setOptions(seatsAero?.programs ?? []);
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
      <p>${escapeHtml(run.message ?? (run.resultCount ? `${run.resultCount} result(s)` : "Waiting to start"))}</p>
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

function renderResultTable(results) {
  return `<div class="result-table-wrap"><table class="result-table">
    <thead><tr><th scope="col">Route and date</th><th scope="col">Price and program</th><th scope="col">Cabin and seats</th><th scope="col">Routing</th><th scope="col">Provider</th><th scope="col">Book</th></tr></thead>
    <tbody>${results
      .map((result) => {
        const bookingUrl = safeBookingUrl(result.bookingUrl);
        return `<tr class="result-row${isWaitlistResult(result) ? " waitlist" : ""}">
          <td class="result-route"><strong>${escapeHtml(result.origin)} → ${escapeHtml(result.destination)}</strong><span>${escapeHtml(result.departureDate)}${result.flightNumbers?.length ? ` · ${escapeHtml(result.flightNumbers.join(", "))}` : ""}</span></td>
          <td class="result-cell"><strong>${escapeHtml(resultPrice(result))}</strong><span>${escapeHtml(result.program)}</span></td>
          <td class="result-cell"><strong>${escapeHtml(result.cabin)}</strong><span>${result.seats ? `${escapeHtml(result.seats)} seat(s)` : "Seats not reported"}</span></td>
          <td class="result-cell"><strong>${result.stops === 0 ? "Nonstop" : result.stops === null || result.stops === undefined ? "Stops n/a" : `${escapeHtml(result.stops)} stop(s)`}</strong><span>${escapeHtml((result.carriers ?? []).join(", ") || "Carrier n/a")}</span></td>
          <td class="result-cell result-provider">${escapeHtml(providerNames[result.provider] ?? result.provider)}${isWaitlistResult(result) ? '<span class="availability-badge">Waitlist · not bookable</span>' : ""}</td>
          <td class="result-cell">${bookingUrl && !isWaitlistResult(result) ? `<a class="booking-link" href="${escapeHtml(bookingUrl)}" target="_blank" rel="noopener noreferrer">Open</a>` : "—"}</td>
        </tr>`;
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
  const direction = byId("sort-direction").dataset.direction;
  const sorted = sortAwardResults(allResults, byId("result-sort").value, direction);
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
  const renderKey = JSON.stringify([job?.id, job?.status, results, view, emptyMessage]);
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

function previewControls(interactive) {
  return `<div class="preview-controls">
    <span data-preview-age>Capturing preview…</span>
    <button class="control-button" type="button" data-browser-zoom>1:1</button>
    <button class="control-button" type="button" data-preview-refresh>Refresh preview</button>
    <button class="control-button" type="button" data-browser-scroll="-650">Scroll up</button>
    <button class="control-button" type="button" data-browser-scroll="650">Scroll down</button>
    ${interactive ? '<span class="preview-hint">Click the image to focus a control.</span>' : ""}
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
  for (const card of document.querySelectorAll(".challenge-card")) {
    updatePreviewAge(card);
    const image = card.querySelector(".browser-shot");
    const capturedAt = Number(image?.dataset.capturedAt ?? 0);
    if (image && Date.now() - capturedAt >= 3000) refreshPreview(card);
  }
}

function renderChallenges(job) {
  const challenges = Object.values(job?.providers ?? {})
    .map((run) => run.challenge)
    .filter((challenge) => challenge?.status === "pending");
  const region = byId("challenge-region");
  const renderKey = JSON.stringify([job?.id, challenges]);
  if (region.dataset.renderKey === renderKey) return;
  region.dataset.renderKey = renderKey;
  region.innerHTML = challenges
    .map((challenge) => {
      const acknowledgement = challenge.responseFormat === "acknowledge";
      const inputLabel = challenge.kind.includes("otp") ? "One-time code" : "CAPTCHA response";
      return `<article class="challenge-card" data-job-id="${escapeHtml(job.id)}" data-challenge-id="${escapeHtml(challenge.id)}">
        <div class="challenge-copy">
          <p class="section-label">${escapeHtml(providerNames[challenge.provider] ?? challenge.provider)} · ${escapeHtml(challenge.kind.replaceAll("_", " "))}</p>
          <h2>Waiting for you</h2>
          <p>${escapeHtml(challenge.prompt)}</p>
          <span class="challenge-expiry">Expires ${escapeHtml(new Date(challenge.expiresAt).toLocaleString())}. Nothing entered here is stored by the dashboard.</span>
        </div>
        ${challenge.screenshotAvailable ? `<div class="browser-frame"><div class="browser-canvas"><img class="browser-shot" data-interactive="${acknowledgement}" src="${screenshotUrl(job.id, challenge.id)}" alt="Redacted live ${escapeHtml(challenge.provider)} browser preview"></div></div>${previewControls(acknowledgement)}` : ""}
        ${
          acknowledgement
            ? `<div class="challenge-controls acknowledgement-controls">
          <details class="browser-tools" open>
            <summary>Manual browser controls</summary>
            <p>Correct the airline form here. Login credentials are handled automatically; send only ordinary search text such as an airport code.</p>
            <div class="browser-type-row"><label>Text for the selected airline field<input data-browser-text type="text" autocomplete="off" placeholder="For example, SFO"></label><button class="secondary-button" type="button" data-browser-type>Send to browser</button></div>
            <div class="browser-buttons"><button class="control-button" type="button" data-browser-key="Tab">Tab</button><button class="control-button" type="button" data-browser-key="Enter">Enter</button><button class="control-button" type="button" data-browser-key="Escape">Escape</button><button class="control-button" type="button" data-browser-key="Backspace">Backspace</button><button class="control-button" type="button" data-browser-key="Delete">Delete</button><button class="control-button" type="button" data-browser-key="ArrowUp">↑</button><button class="control-button" type="button" data-browser-key="ArrowDown">↓</button></div>
            <button class="danger-button" type="button" data-browser-reload>Reload airline page…</button>
          </details>
          <button class="secondary-button continue-button" type="button" data-challenge-submit>I finished — continue search</button>
        </div>`
            : `<div class="challenge-controls"><input data-challenge-value autocomplete="one-time-code" inputmode="text" placeholder="${escapeHtml(inputLabel)}"><button class="primary-button" type="button" data-challenge-submit>Submit</button><small>Copy the code from your own email or phone. This app does not access either inbox.</small></div>`
        }
        <p class="challenge-action-status" data-challenge-status role="status"></p>
      </article>`;
    })
    .join("");
  bindChallengePreviews(region);
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

async function browserAction(card, action) {
  const jobId = card.dataset.jobId;
  const challengeId = card.dataset.challengeId;
  await api(
    `/searches/${encodeURIComponent(jobId)}/challenges/${encodeURIComponent(challengeId)}/browser-actions`,
    { method: "POST", body: action }
  );
  const image = card.querySelector(".browser-shot");
  if (image)
    window.setTimeout(() => {
      refreshPreview(card);
    }, 450);
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

byId("cancel-search").addEventListener("click", async () => {
  const job = selectedJob();
  if (!job) return;
  try {
    const updated = await api(`/searches/${encodeURIComponent(job.id)}/cancel`, {
      method: "POST",
      body: {}
    });
    state.jobs = state.jobs.map((item) => (item.id === updated.id ? updated : item));
    render();
  } catch (error) {
    byId("service-state").textContent = error.message;
    byId("service-state").className = "service-state error";
  }
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
      await browserAction(card, { kind: "click", x, y });
    }
    if (event.target.matches("[data-browser-type], [data-browser-key], [data-browser-scroll]")) {
      setChallengeStatus(card, "Browser action sent. Preview will update shortly.", "success");
    }
  } catch (error) {
    setChallengeStatus(card, error.message, "error");
  }
});

for (const id of [
  "result-sort",
  "show-waitlist",
  "result-provider-filter",
  "result-cabin-filter",
  "result-program-filter",
  "result-view"
]) {
  byId(id).addEventListener("change", () => renderResults(selectedJob()));
}
byId("sort-direction").addEventListener("click", (event) => {
  const descending = event.currentTarget.dataset.direction === "asc";
  event.currentTarget.dataset.direction = descending ? "desc" : "asc";
  event.currentTarget.textContent = descending ? "↓" : "↑";
  event.currentTarget.setAttribute("aria-label", descending ? "Sort descending" : "Sort ascending");
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
