import { GMAIL_READONLY_SCOPE } from "./config.mjs";

const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export class GmailGatewayError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "GmailGatewayError";
    this.code = code;
    this.status = status;
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GmailGatewayError("gmail_not_connected", `${name} is not configured.`, 503);
  }
  return value.trim();
}

function readonlyScope(scope) {
  const scopes = String(scope ?? "")
    .split(/\s+/)
    .filter(Boolean);
  return scopes.length === 1 && scopes[0] === GMAIL_READONLY_SCOPE;
}

async function responseBody(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => ({}));
  }
  return { raw: (await response.text()).slice(0, 500) };
}

export async function exchangeAuthorizationCode(config, { code, codeVerifier }, fetchImpl = fetch) {
  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code: requiredString(code, "OAuth authorization code"),
      client_id: requiredString(config.oauthClientId, "OAuth client ID"),
      client_secret: requiredString(config.oauthClientSecret, "OAuth client secret"),
      redirect_uri: requiredString(config.oauthRedirectUri, "OAuth redirect URI"),
      grant_type: "authorization_code",
      code_verifier: requiredString(codeVerifier, "PKCE code verifier")
    })
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new GmailGatewayError(
      "oauth_exchange_failed",
      "Google OAuth authorization exchange failed.",
      502
    );
  }
  if (!readonlyScope(body.scope) || !body.access_token || !body.refresh_token) {
    throw new GmailGatewayError(
      "unexpected_gmail_scope",
      "Google did not grant exactly the required Gmail read-only scope.",
      403
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scope: body.scope,
    expiresAt: new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000).toISOString()
  };
}

export async function refreshAccessToken(config, tokenRecord, fetchImpl = fetch) {
  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: requiredString(config.oauthClientId, "OAuth client ID"),
      client_secret: requiredString(config.oauthClientSecret, "OAuth client secret"),
      refresh_token: requiredString(tokenRecord.refreshToken, "OAuth refresh token"),
      grant_type: "refresh_token"
    })
  });
  const body = await responseBody(response);
  if (!response.ok || !body.access_token) {
    throw new GmailGatewayError(
      "oauth_refresh_failed",
      "Google OAuth refresh failed; reconnect the email gateway.",
      401
    );
  }
  if (body.scope && !readonlyScope(body.scope)) {
    throw new GmailGatewayError(
      "unexpected_gmail_scope",
      "Refreshed Google token has an unexpected Gmail scope.",
      403
    );
  }
  return {
    ...tokenRecord,
    accessToken: body.access_token,
    scope: body.scope || tokenRecord.scope,
    expiresAt: new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000).toISOString()
  };
}

export async function currentAccessToken(config, tokenStore, fetchImpl = fetch, now = Date.now()) {
  const record = await tokenStore.read();
  if (!record) {
    throw new GmailGatewayError(
      "gmail_not_connected",
      "Email gateway is not connected to Gmail.",
      503
    );
  }
  if (!readonlyScope(record.scope)) {
    throw new GmailGatewayError(
      "unexpected_gmail_scope",
      "Stored Google token does not have exactly the Gmail read-only scope.",
      403
    );
  }
  if (record.accessToken && Date.parse(record.expiresAt ?? "") > now + 60_000) {
    return record.accessToken;
  }
  const refreshed = await refreshAccessToken(config, record, fetchImpl);
  await tokenStore.write(refreshed);
  return refreshed.accessToken;
}

async function gmailJson(
  config,
  tokenStore,
  path,
  { method = "GET", body } = {},
  fetchImpl = fetch
) {
  const accessToken = await currentAccessToken(config, tokenStore, fetchImpl);
  const response = await fetchImpl(`${GMAIL_API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const parsed = await responseBody(response);
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? 403 : 502;
    throw new GmailGatewayError("gmail_api_failed", "Gmail API request failed.", status);
  }
  return parsed;
}

export async function gmailProfile(config, tokenStore, fetchImpl = fetch) {
  return gmailJson(config, tokenStore, "/profile", {}, fetchImpl);
}

export async function gmailListMessages(config, tokenStore, { query, limit }, fetchImpl = fetch) {
  const params = new URLSearchParams({ maxResults: String(limit), includeSpamTrash: "false" });
  if (query) params.set("q", query);
  return gmailJson(config, tokenStore, `/messages?${params.toString()}`, {}, fetchImpl);
}

export async function gmailGetMessage(
  config,
  tokenStore,
  id,
  { format = "metadata" } = {},
  fetchImpl = fetch
) {
  const params = new URLSearchParams({ format });
  if (format === "metadata") {
    for (const header of ["From", "To", "Subject", "Date", "Authentication-Results"]) {
      params.append("metadataHeaders", header);
    }
  }
  return gmailJson(
    config,
    tokenStore,
    `/messages/${encodeURIComponent(id)}?${params.toString()}`,
    {},
    fetchImpl
  );
}

export async function gmailWatch(
  config,
  tokenStore,
  { topicName, labelIds } = {},
  fetchImpl = fetch
) {
  const request = {
    topicName: requiredString(topicName, "Pub/Sub topic name"),
    ...(Array.isArray(labelIds) && labelIds.length
      ? { labelIds: labelIds, labelFilterBehavior: "INCLUDE" }
      : {})
  };
  return gmailJson(config, tokenStore, "/watch", { method: "POST", body: request }, fetchImpl);
}

export async function gmailHistory(
  config,
  tokenStore,
  startHistoryId,
  { pageToken } = {},
  fetchImpl = fetch
) {
  const params = new URLSearchParams({
    startHistoryId: String(startHistoryId),
    historyTypes: "messageAdded"
  });
  if (pageToken) params.set("pageToken", String(pageToken));
  return gmailJson(config, tokenStore, `/history?${params.toString()}`, {}, fetchImpl);
}
