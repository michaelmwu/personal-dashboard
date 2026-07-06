export class HermesBridgeLoopError extends Error {
  constructor(actionId) {
    super(`Refusing to dispatch Hermes-originated action ${actionId} back into Hermes.`);
    this.name = "HermesBridgeLoopError";
  }
}

export function hermesBridgeConfig(env = process.env) {
  return {
    baseUrl: env.HERMES_BRIDGE_URL ?? env.HERMES_API_BASE_URL ?? "",
    password: env.HERMES_BRIDGE_PASSWORD ?? env.HERMES_API_KEY ?? "",
    sessionKey: env.HERMES_BRIDGE_SESSION_KEY ?? "personal-dashboard"
  };
}

export function isHermesBridgeConfigured(config = hermesBridgeConfig()) {
  return Boolean(config.baseUrl && config.password);
}

function bridgeBaseUrl(config) {
  return config.baseUrl.replace(/\/$/, "");
}

function bridgeHeaders(config, headers = {}) {
  return {
    Authorization: `Bearer ${config.password}`,
    "X-Hermes-Session-Key": config.sessionKey,
    ...headers
  };
}

async function bridgeResponseBody(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export async function hermesBridgeRequest(path, options = {}) {
  const config = options.config ?? hermesBridgeConfig();
  if (!isHermesBridgeConfigured(config)) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "missing_hermes_bridge_config",
        message: "Hermes Bridge URL and password are required."
      }
    };
  }

  const fetchImpl = options.fetch ?? fetch;
  const headers = {
    ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(options.accept ? { Accept: options.accept } : {}),
    ...(options.headers ?? {})
  };
  try {
    const response = await fetchImpl(`${bridgeBaseUrl(config)}${path}`, {
      method: options.method ?? "GET",
      headers: bridgeHeaders(config, headers),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      body: await bridgeResponseBody(response)
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      body: {
        error: "hermes_bridge_unavailable",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export function hermesBridgeStatus(config = hermesBridgeConfig()) {
  return {
    configured: isHermesBridgeConfigured(config),
    baseUrl: config.baseUrl || undefined,
    sessionKey: config.sessionKey
  };
}

export function createHermesBridgeRunPayload(payload = {}) {
  return {
    input: payload.input ?? payload.prompt ?? "",
    instructions: payload.instructions,
    session_id: payload.sessionId ?? payload.session_id,
    metadata: payload.metadata
  };
}

export async function startHermesBridgeRun(payload, options = {}) {
  return hermesBridgeRequest("/v1/runs", {
    ...options,
    method: "POST",
    headers: {
      ...(options.headers ?? {}),
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {})
    },
    body: createHermesBridgeRunPayload(payload)
  });
}

export async function getHermesBridgeRun(runId, options = {}) {
  return hermesBridgeRequest(`/v1/runs/${encodeURIComponent(runId)}`, options);
}

export async function getHermesBridgeRunEvents(runId, options = {}) {
  return hermesBridgeRequest(`/v1/runs/${encodeURIComponent(runId)}/events`, {
    ...options,
    accept: options.accept ?? "text/event-stream, application/json"
  });
}

export async function openHermesBridgeRunEvents(runId, options = {}) {
  const config = options.config ?? hermesBridgeConfig();
  if (!isHermesBridgeConfigured(config)) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "missing_hermes_bridge_config",
        message: "Hermes Bridge URL and password are required."
      }
    };
  }

  const fetchImpl = options.fetch ?? fetch;
  try {
    const response = await fetchImpl(
      `${bridgeBaseUrl(config)}/v1/runs/${encodeURIComponent(runId)}/events`,
      {
        headers: bridgeHeaders(config, {
          Accept: options.accept ?? "text/event-stream, application/json",
          ...(options.headers ?? {})
        }),
        signal: options.signal
      }
    );
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      response
    };
  } catch (error) {
    return {
      ok: false,
      status: 502,
      body: {
        error: "hermes_bridge_unavailable",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export async function approveHermesBridgeRun(runId, payload, options = {}) {
  return hermesBridgeRequest(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
    ...options,
    method: "POST",
    body: payload ?? {}
  });
}

export async function stopHermesBridgeRun(runId, payload, options = {}) {
  return hermesBridgeRequest(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
    ...options,
    method: "POST",
    body: payload ?? {}
  });
}

export async function getHermesBridgeCapabilities(options = {}) {
  return hermesBridgeRequest("/v1/capabilities", options);
}

export function assertBridgeDispatchable(action) {
  if (action.origin === "hermes") {
    throw new HermesBridgeLoopError(action.id);
  }
}

export function bridgePromptForAction(action) {
  return [
    `Dashboard action ${action.id}`,
    `Capability: ${action.capabilityId}`,
    `Target: ${action.target}`,
    "",
    "Payload:",
    JSON.stringify(action.payload ?? {}, null, 2)
  ].join("\n");
}

export async function createHermesBridgeRun(action, options = {}) {
  assertBridgeDispatchable(action);
  const config = options.config ?? hermesBridgeConfig();
  if (!isHermesBridgeConfigured(config)) {
    return { dispatched: false, reason: "missing_hermes_bridge_config" };
  }

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${bridgeBaseUrl(config)}/v1/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...bridgeHeaders(config),
      ...(action.idempotencyKey ? { "Idempotency-Key": action.idempotencyKey } : {})
    },
    body: JSON.stringify({
      input: action.payload?.prompt ?? bridgePromptForAction(action),
      instructions:
        action.payload?.instructions ??
        "You are Hermes acting on a Personal Dashboard action envelope. Use dashboard context when needed and report concise status.",
      session_id: `dashboard:${action.id}`
    })
  });

  const body = await response.json().catch(async () => ({ raw: await response.text() }));
  return {
    dispatched: response.ok,
    target: "hermes-bridge",
    statusCode: response.status,
    runId: body.run_id,
    response: body
  };
}

export function parseSseFrame(frame) {
  let event;
  const data = [];

  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    }
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  const raw = data.join("\n");
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}

export async function streamHermesBridgeRunEvents(runId, onEvent, options = {}) {
  const config = options.config ?? hermesBridgeConfig();
  if (!isHermesBridgeConfigured(config)) {
    return { streamed: false, reason: "missing_hermes_bridge_config" };
  }

  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(
    `${bridgeBaseUrl(config)}/v1/runs/${encodeURIComponent(runId)}/events`,
    {
      headers: bridgeHeaders(config, {
        Accept: "text/event-stream"
      }),
      signal: options.signal
    }
  );

  if (!response.ok) {
    return { streamed: false, statusCode: response.status, response: await response.text() };
  }
  if (!response.body) {
    return { streamed: false, reason: "missing_sse_body" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const event = parseSseFrame(frame);
      if (!event) {
        continue;
      }
      eventCount += 1;
      await onEvent(event);
    }
  }

  return { streamed: true, eventCount };
}
