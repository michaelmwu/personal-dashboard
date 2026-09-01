const apiRoot = "/api/integrations/flight-searcher";
const activeStatuses = new Set(["queued", "running", "waiting_human"]);
const terminalStatuses = new Set(["completed", "partial", "failed", "canceled"]);
const providerNames = { seats_aero: "Seats.aero", ana: "ANA", jal: "JAL", eva: "EVA" };
const state = { jobs: [], selectedId: null, refreshing: false, timer: null };
const number = new Intl.NumberFormat("en-US");

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function dateValue(offsetDays) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

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

function commaValues(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusPill(status) {
  return `<span class="status-pill ${escapeHtml(status)}">${escapeHtml(String(status).replaceAll("_", " "))}</span>`;
}

function selectedJob() {
  return state.jobs.find((job) => job.id === state.selectedId) ?? state.jobs[0] ?? null;
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
      ${run.rateLimitRemaining === null || run.rateLimitRemaining === undefined ? "" : `<p>${number.format(run.rateLimitRemaining)} Seats.aero calls remaining today</p>`}
    </div>`
    )
    .join("");
}

function resultPrice(result) {
  const miles = result.mileage ? `${number.format(result.mileage)} mi` : "Mileage n/a";
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

function renderResults(job) {
  const results = job?.results ?? [];
  byId("result-count").textContent = `${results.length} option${results.length === 1 ? "" : "s"}`;
  byId("results").innerHTML = results.length
    ? results
        .map(
          (result) => `<article class="result-row">
        <div class="result-route"><strong>${escapeHtml(result.origin)} → ${escapeHtml(result.destination)}</strong><span>${escapeHtml(result.departureDate)}${result.flightNumbers?.length ? ` · ${escapeHtml(result.flightNumbers.join(", "))}` : ""}</span></div>
        <div class="result-cell"><strong>${escapeHtml(resultPrice(result))}</strong><span>${escapeHtml(result.program)}</span></div>
        <div class="result-cell"><strong>${escapeHtml(result.cabin)}</strong><span>${result.seats ? `${escapeHtml(result.seats)} seat(s)` : "Seats not reported"}</span></div>
        <div class="result-cell"><strong>${result.stops === 0 ? "Nonstop" : result.stops === null || result.stops === undefined ? "Stops n/a" : `${escapeHtml(result.stops)} stop(s)`}</strong><span>${escapeHtml((result.carriers ?? []).join(", ") || "Carrier n/a")}</span></div>
        <div class="result-cell result-provider">${escapeHtml(providerNames[result.provider] ?? result.provider)}</div>
      </article>`
        )
        .join("")
    : `<p class="empty">${job && terminalStatuses.has(job.status) ? "No matching award options were returned." : "Award options will appear here as providers finish."}</p>`;
}

function screenshotUrl(jobId, challengeId) {
  return `${apiRoot}/searches/${encodeURIComponent(jobId)}/challenges/${encodeURIComponent(challengeId)}/screenshot?t=${Date.now()}`;
}

function renderChallenges(job) {
  const challenges = Object.values(job?.providers ?? {})
    .map((run) => run.challenge)
    .filter((challenge) => challenge?.status === "pending");
  byId("challenge-region").innerHTML = challenges
    .map((challenge) => {
      const acknowledgement = challenge.responseFormat === "acknowledge";
      const inputLabel = acknowledgement
        ? "Type into the focused browser field"
        : challenge.kind.includes("otp")
          ? "One-time code"
          : "CAPTCHA response";
      return `<article class="challenge-card" data-job-id="${escapeHtml(job.id)}" data-challenge-id="${escapeHtml(challenge.id)}">
        <div class="challenge-copy">
          <p class="section-label">${escapeHtml(providerNames[challenge.provider] ?? challenge.provider)} · ${escapeHtml(challenge.kind.replaceAll("_", " "))}</p>
          <h2>Waiting for you</h2>
          <p>${escapeHtml(challenge.prompt)}</p>
          <span class="challenge-expiry">Expires ${escapeHtml(new Date(challenge.expiresAt).toLocaleString())}. Nothing entered here is stored by the dashboard.</span>
        </div>
        ${challenge.screenshotAvailable ? `<div class="browser-frame"><img class="browser-shot" data-interactive="${acknowledgement}" src="${screenshotUrl(job.id, challenge.id)}" alt="Redacted live ${escapeHtml(challenge.provider)} browser preview"></div>` : ""}
        <div class="challenge-controls">
          ${acknowledgement ? `<input data-browser-text type="password" autocomplete="off" placeholder="${escapeHtml(inputLabel)}"><button class="secondary-button" type="button" data-browser-type>Type securely</button>` : `<input data-challenge-value autocomplete="one-time-code" inputmode="text" placeholder="${escapeHtml(inputLabel)}"><button class="primary-button" type="button" data-challenge-submit>Submit</button>`}
          ${acknowledgement ? `<div class="browser-buttons"><button class="control-button" type="button" data-browser-key="Tab">Tab</button><button class="control-button" type="button" data-browser-key="Enter">Enter</button><button class="control-button" type="button" data-browser-scroll="-650">Scroll up</button><button class="control-button" type="button" data-browser-scroll="650">Scroll down</button><button class="control-button" type="button" data-browser-refresh>Refresh page</button><button class="primary-button" type="button" data-challenge-submit>Continue search</button></div><small>Click the screenshot to click the remote browser. Password and username fields are masked in every preview.</small>` : `<small>Copy the code from your own email or phone. This app does not access either inbox.</small>`}
        </div>
      </article>`;
    })
    .join("");
}

function renderHistory() {
  byId("search-history").innerHTML = state.jobs.length
    ? state.jobs
        .map((job) => {
          const request = job.request ?? {};
          return `<button class="history-row ${job.id === state.selectedId ? "selected" : ""}" type="button" data-select-job="${escapeHtml(job.id)}">
          <strong>${escapeHtml((request.origins ?? []).join(", "))} → ${escapeHtml((request.destinations ?? []).join(", "))}</strong>
          <span>${escapeHtml(request.departureStart ?? "")}${request.departureEnd && request.departureEnd !== request.departureStart ? ` – ${escapeHtml(request.departureEnd)}` : ""}</span>
          <span>${escapeHtml((request.providers ?? []).map((id) => providerNames[id] ?? id).join(", "))}</span>
          ${statusPill(job.status)}
        </button>`;
        })
        .join("")
    : '<p class="empty">No searches yet.</p>';
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
      image.src = screenshotUrl(jobId, challengeId);
    }, 450);
}

byId("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const cabins = checkedValues("cabins");
  const providers = checkedValues("providers");
  if (!cabins.length || !providers.length) {
    byId("form-status").textContent = "Choose at least one cabin and one configured provider.";
    return;
  }
  const payload = {
    origins: commaValues(data.get("origins")),
    destinations: commaValues(data.get("destinations")),
    departureStart: data.get("departureStart"),
    departureEnd: data.get("departureEnd"),
    passengers: Number(data.get("passengers")),
    cabins,
    providers,
    seatsAeroSources: commaValues(data.get("seatsAeroSources"))
  };
  if (data.get("returnStart")) payload.returnStart = data.get("returnStart");
  if (data.get("returnEnd")) payload.returnEnd = data.get("returnEnd");
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
    } else if (event.target.matches("[data-browser-refresh]")) {
      await browserAction(card, { kind: "refresh" });
    } else if (
      event.target.matches(".browser-shot") &&
      event.target.dataset.interactive === "true"
    ) {
      const rect = event.target.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * event.target.naturalWidth;
      const y = ((event.clientY - rect.top) / rect.height) * event.target.naturalHeight;
      await browserAction(card, { kind: "click", x, y });
    }
  } catch (error) {
    byId("service-state").textContent = error.message;
    byId("service-state").className = "service-state error";
  }
});

byId("refresh-searches").addEventListener("click", refreshSearches);

async function main() {
  const form = byId("search-form");
  form.elements.departureStart.value = dateValue(30);
  form.elements.departureEnd.value = dateValue(37);
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
