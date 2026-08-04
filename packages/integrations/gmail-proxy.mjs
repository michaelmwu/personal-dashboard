const DEFAULT_TIMEOUT_MS = 15_000;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function boundedPositiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function gatewayBaseUrl(value) {
  const raw = nonEmptyString(value);
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    const loopbackHttp =
      parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    if (!(parsed.protocol === "https:" || loopbackHttp)) {
      return "";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

/**
 * This client has a deliberately tiny surface. It can only invoke the
 * gateway's fixed read-only APIs; neither OAuth credentials nor a generic
 * upstream request facility can cross the dashboard boundary.
 */
export function gmailGatewayConfig(env = process.env) {
  const baseUrl = gatewayBaseUrl(env.EMAIL_GATEWAY_API_BASE_URL);
  const token = nonEmptyString(env.EMAIL_GATEWAY_DASHBOARD_TOKEN);
  return {
    configured: Boolean(baseUrl && token),
    baseUrl,
    token,
    timeoutMs: boundedPositiveInteger(env.EMAIL_GATEWAY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 60_000)
  };
}

async function parseGatewayResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => ({ error: "invalid_gateway_json" }));
  }
  const text = await response.text();
  return { error: "unexpected_gateway_response", detail: text.slice(0, 500) };
}

async function gatewayPost(path, payload, options = {}) {
  const config = options.config ?? gmailGatewayConfig();
  if (!config.configured) {
    return {
      ok: false,
      status: 503,
      body: { error: "email_gateway_unavailable", message: "Email gateway is not configured." }
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await (options.fetch ?? fetch)(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status, body: await parseGatewayResponse(response) };
  } catch (error) {
    return {
      ok: false,
      status: controller.signal.aborted ? 504 : 502,
      body: {
        error: controller.signal.aborted ? "email_gateway_timeout" : "email_gateway_unavailable",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function searchGmailGateway(payload, options = {}) {
  return gatewayPost("/v1/search", payload, options);
}

export async function readGmailGatewayMessages(payload, options = {}) {
  return gatewayPost("/v1/messages/read", payload, options);
}

export async function renewGmailGatewayWatch(payload, options = {}) {
  return gatewayPost("/v1/watch/renew", payload, options);
}
