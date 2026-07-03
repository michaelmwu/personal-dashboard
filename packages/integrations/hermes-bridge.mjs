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
  const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, "")}/v1/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.password}`,
      "X-Hermes-Session-Key": config.sessionKey,
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
    `${config.baseUrl.replace(/\/$/, "")}/v1/runs/${encodeURIComponent(runId)}/events`,
    {
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${config.password}`,
        "X-Hermes-Session-Key": config.sessionKey
      },
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
