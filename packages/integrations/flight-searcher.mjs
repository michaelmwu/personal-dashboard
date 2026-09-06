const DEFAULT_TIMEOUT_MS = 30_000;

export function flightSearcherConfig(env = process.env) {
  return {
    baseUrl: String(env.FLIGHT_SEARCHER_API_BASE_URL ?? "").trim(),
    apiToken: String(env.FLIGHT_SEARCHER_API_TOKEN ?? "").trim(),
    timeoutMs: Number.parseInt(
      env.FLIGHT_SEARCHER_REQUEST_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`,
      10
    )
  };
}

export function isFlightSearcherConfigured(config = flightSearcherConfig()) {
  return Boolean(config.baseUrl);
}

function serviceUrl(baseUrl, path) {
  const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("Flight Searcher URL must use HTTP or HTTPS.");
  }
  return url;
}

function upstreamError(error) {
  return {
    ok: false,
    status: 503,
    body: {
      error: "flight_searcher_unavailable",
      message: error instanceof Error ? error.message : "Flight Searcher is unavailable."
    }
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: "invalid_flight_searcher_response" };
    }
  }
  return { ok: response.ok, status: response.status, body };
}

async function flightSearcherFetch(path, options = {}) {
  const config = options.config ?? flightSearcherConfig();
  if (!isFlightSearcherConfigured(config)) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "flight_searcher_not_configured",
        message: "FLIGHT_SEARCHER_API_BASE_URL is not configured."
      }
    };
  }

  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetch ?? fetch)(serviceUrl(config.baseUrl, path), {
      method: options.method ?? "GET",
      headers: {
        Accept: options.responseType === "bytes" ? "image/png" : "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
    if (options.responseType === "bytes") {
      return {
        ok: response.ok,
        status: response.status,
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? "application/octet-stream"
      };
    }
    return parseJsonResponse(response);
  } catch (error) {
    return upstreamError(error);
  } finally {
    clearTimeout(timeout);
  }
}

function list(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function normalizeFlightSearchRequest(payload = {}) {
  const origins = list(payload.origins ?? payload.origin);
  const destinations = list(payload.destinations ?? payload.destination);
  const departureStart = payload.departureStart ?? payload.departure_start;
  const departureEnd = payload.departureEnd ?? payload.departure_end ?? departureStart;
  const returnStart = payload.returnStart ?? payload.return_start;
  const returnEnd = payload.returnEnd ?? payload.return_end ?? returnStart;
  const passengers = Number(payload.passengers ?? 1);
  const maxPoints = payload.maxPoints ?? payload.max_points;
  const maxStops = payload.maxStops ?? payload.max_stops;
  const seatsAeroSources = list(payload.seatsAeroSources ?? payload.seats_aero_sources);

  return {
    origins,
    destinations,
    departureStart,
    departureEnd,
    ...(returnStart ? { returnStart } : {}),
    ...(returnEnd ? { returnEnd } : {}),
    passengers: Number.isFinite(passengers) ? passengers : 1,
    cabins: list(payload.cabins).length ? list(payload.cabins) : ["business", "first"],
    providers: list(payload.providers).length
      ? list(payload.providers)
      : ["seats_aero", "ana", "jal", "eva"],
    ...(maxStops === undefined || maxStops === null || maxStops === ""
      ? {}
      : { maxStops: Number(maxStops) }),
    ...(maxPoints === undefined || maxPoints === null || maxPoints === ""
      ? {}
      : { maxPoints: Number.isFinite(Number(maxPoints)) ? Number(maxPoints) : String(maxPoints) }),
    ...(seatsAeroSources.length ? { seatsAeroSources } : {})
  };
}

export function listFlightSearchProviders(options = {}) {
  return flightSearcherFetch("api/providers", options);
}

export function listFlightSearches({ limit = 50 } = {}, options = {}) {
  return flightSearcherFetch(`api/searches?limit=${encodeURIComponent(limit)}`, options);
}

export function createFlightSearch(payload, options = {}) {
  return flightSearcherFetch("api/searches", {
    ...options,
    method: "POST",
    body: normalizeFlightSearchRequest(payload)
  });
}

export function getFlightSearch(jobId, options = {}) {
  return flightSearcherFetch(`api/searches/${encodeURIComponent(jobId)}`, options);
}

export function cancelFlightSearch(jobId, options = {}) {
  return flightSearcherFetch(`api/searches/${encodeURIComponent(jobId)}/cancel`, {
    ...options,
    method: "POST",
    body: {}
  });
}

export function respondToFlightChallenge(jobId, challengeId, value, options = {}) {
  return flightSearcherFetch(
    `api/searches/${encodeURIComponent(jobId)}/challenges/${encodeURIComponent(challengeId)}/respond`,
    {
      ...options,
      method: "POST",
      body: { value }
    }
  );
}

export function sendFlightBrowserAction(jobId, challengeId, action, options = {}) {
  return flightSearcherFetch(
    `api/searches/${encodeURIComponent(jobId)}/challenges/${encodeURIComponent(challengeId)}/browser-actions`,
    {
      ...options,
      method: "POST",
      body: action
    }
  );
}

export function getFlightChallengeScreenshot(jobId, challengeId, options = {}) {
  return flightSearcherFetch(
    `api/searches/${encodeURIComponent(jobId)}/challenges/${encodeURIComponent(challengeId)}/screenshot`,
    { ...options, responseType: "bytes" }
  );
}

export function compactFlightSearchJob(job) {
  return {
    id: job.id,
    status: job.status,
    request: job.request,
    providers: Object.fromEntries(
      Object.entries(job.providers ?? {}).map(([id, run]) => [
        id,
        {
          state: run.state,
          resultCount: run.resultCount,
          message: run.message,
          errorCode: run.errorCode,
          rateLimitRemaining: run.rateLimitRemaining,
          challenge: run.challenge
            ? {
                id: run.challenge.id,
                provider: run.challenge.provider,
                kind: run.challenge.kind,
                prompt: run.challenge.prompt,
                status: run.challenge.status,
                screenshotAvailable: run.challenge.screenshotAvailable,
                expiresAt: run.challenge.expiresAt
              }
            : null
        }
      ])
    ),
    results: (job.results ?? []).slice(0, 25),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt
  };
}

export async function flightSearcherHermesContext(options = {}) {
  const response = await listFlightSearches({ limit: 10 }, options);
  if (!response.ok) {
    return {
      configured: response.body?.error !== "flight_searcher_not_configured",
      available: false,
      error: response.body?.error ?? "flight_searcher_unavailable",
      searches: []
    };
  }
  return {
    configured: true,
    available: true,
    emailAccess: false,
    searches: (Array.isArray(response.body) ? response.body : []).map(compactFlightSearchJob)
  };
}
