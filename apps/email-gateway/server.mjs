import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

import {
  assertEnabledGatewayConfig,
  decodeEncryptionKey,
  emailGatewayConfig,
  GMAIL_READONLY_SCOPE,
  gatewayEnvironment
} from "./config.mjs";
import {
  exchangeAuthorizationCode,
  GmailGatewayError,
  gmailGetMessage,
  gmailHistory,
  gmailListMessages,
  gmailProfile,
  gmailWatch
} from "./gmail-client.mjs";
import {
  compileEmailSearch,
  createSearchReceipt,
  messageSummary,
  parseTransactionCandidate,
  sanitizedMessageText
} from "./policy.mjs";
import {
  appendGatewayAudit,
  readEncryptedGatewayRecord,
  writeEncryptedGatewayRecord
} from "./secure-store.mjs";

const JSON_LIMIT_BYTES = 96 * 1024;
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const STATE_VERSION = "email-gateway-state.v1";

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function html(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function bearerToken(request) {
  const authorization = firstHeader(request.headers.authorization);
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

function tokenMatches(received, expected) {
  if (!received || !expected) return false;
  const receivedBytes = Buffer.from(received);
  const expectedBytes = Buffer.from(expected);
  return (
    receivedBytes.length === expectedBytes.length && timingSafeEqual(receivedBytes, expectedBytes)
  );
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > JSON_LIMIT_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Request body must be a JSON object.");
    }
    return parsed;
  } catch (error) {
    const parseError = new Error("Request body must be valid JSON.");
    parseError.status = 400;
    throw error instanceof SyntaxError ? parseError : error;
  }
}

function base64urlJson(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid JWT encoding.");
  }
}

function validString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function hasAsciiControl(value) {
  return Array.from(String(value ?? "")).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function defaultGatewayState() {
  return {
    version: STATE_VERSION,
    historyId: "",
    historyPageToken: "",
    watchExpiration: "",
    pendingHistoryIds: [],
    seenMessageIds: [],
    needsResync: false,
    updatedAt: new Date().toISOString()
  };
}

function validState(value) {
  if (!value || value.version !== STATE_VERSION || typeof value !== "object") {
    return defaultGatewayState();
  }
  return {
    ...defaultGatewayState(),
    ...value,
    pendingHistoryIds: Array.isArray(value.pendingHistoryIds)
      ? value.pendingHistoryIds.filter((id) => /^[0-9]+$/.test(String(id))).slice(-100)
      : [],
    historyPageToken:
      typeof value.historyPageToken === "string" &&
      value.historyPageToken.length <= 4096 &&
      !hasAsciiControl(value.historyPageToken)
        ? value.historyPageToken
        : "",
    seenMessageIds: Array.isArray(value.seenMessageIds)
      ? value.seenMessageIds.filter((id) => /^[A-Za-z0-9_-]{20,100}$/.test(String(id))).slice(-1000)
      : []
  };
}

function stateStore(config, encryptionKey) {
  let loaded;
  let writeTail = Promise.resolve();
  async function load() {
    if (loaded) return loaded;
    loaded = validState(await readEncryptedGatewayRecord(config.stateFile, encryptionKey));
    return loaded;
  }
  return {
    async read() {
      return { ...(await load()) };
    },
    async mutate(mutator) {
      const next = writeTail
        .catch(() => {})
        .then(async () => {
          const current = await load();
          const changed = (await mutator({ ...current })) ?? current;
          loaded = validState({ ...changed, updatedAt: new Date().toISOString() });
          await writeEncryptedGatewayRecord(config.stateFile, loaded, encryptionKey);
          return { ...loaded };
        });
      writeTail = next;
      return next;
    }
  };
}

function tokenStore(config, encryptionKey) {
  return {
    read: () => readEncryptedGatewayRecord(config.tokenFile, encryptionKey),
    write: (record) => writeEncryptedGatewayRecord(config.tokenFile, record, encryptionKey)
  };
}

function dateUsageKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function usageTracker(config, now) {
  let day = dateUsageKey(now());
  let searches = 0;
  let bodyChars = 0;
  const reset = () => {
    const currentDay = dateUsageKey(now());
    if (currentDay !== day) {
      day = currentDay;
      searches = 0;
      bodyChars = 0;
    }
  };
  return {
    search() {
      reset();
      if (searches >= config.maxDailySearches) {
        throw new GmailGatewayError(
          "email_policy_limit",
          "Daily email search budget has been reached.",
          429
        );
      }
      searches += 1;
    },
    body(characters) {
      reset();
      if (bodyChars + characters > config.maxDailyBodyChars) {
        throw new GmailGatewayError(
          "email_policy_limit",
          "Daily email body budget has been reached.",
          429
        );
      }
      bodyChars += characters;
    },
    snapshot() {
      reset();
      return { day, searches, bodyChars };
    }
  };
}

function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url")
  };
}

function oauthAuthorizationUrl(config, state, challenge) {
  const params = new URLSearchParams({
    client_id: config.oauthClientId,
    redirect_uri: config.oauthRedirectUri,
    response_type: "code",
    scope: GMAIL_READONLY_SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function validLabelIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new GmailGatewayError(
      "invalid_watch_request",
      "labelIds must contain no more than 20 labels.",
      400
    );
  }
  const labels = value.map((label) => String(label));
  if (labels.some((label) => !/^[A-Za-z0-9_-]{1,160}$/.test(label))) {
    throw new GmailGatewayError(
      "invalid_watch_request",
      "labelIds contains an invalid Gmail label id.",
      400
    );
  }
  return labels;
}

function compactAuditEntry(entry) {
  return {
    ts: new Date().toISOString(),
    ...entry
  };
}

function pubsubClaimsAreExpected(claims, config, now) {
  const issuer = claims.iss;
  const expectedAudience = config.pubsubAudience;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const expiresAt = Number(claims.exp) * 1000;
  return (
    ["accounts.google.com", "https://accounts.google.com"].includes(issuer) &&
    audience.includes(expectedAudience) &&
    claims.email === config.pubsubPushServiceAccount &&
    claims.email_verified === true &&
    Number.isFinite(expiresAt) &&
    expiresAt > now()
  );
}

function pubsubJwtVerifier(config, fetchImpl, now) {
  let cachedKeys;
  let expiresAt = 0;
  async function keys() {
    if (cachedKeys && expiresAt > now()) return cachedKeys;
    const response = await fetchImpl(GOOGLE_JWKS_URL, { headers: { Accept: "application/json" } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(body.keys)) {
      throw new GmailGatewayError(
        "pubsub_jwks_unavailable",
        "Unable to validate Pub/Sub identity.",
        503
      );
    }
    cachedKeys = body.keys;
    const cacheControl = response.headers.get("cache-control") ?? "";
    const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] ?? 300);
    expiresAt = now() + Math.max(60, Math.min(maxAge, 3600)) * 1000;
    return cachedKeys;
  }
  return async (jwt) => {
    const parts = String(jwt).split(".");
    if (parts.length !== 3) {
      throw new GmailGatewayError(
        "invalid_pubsub_identity",
        "Invalid Pub/Sub identity token.",
        401
      );
    }
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = base64urlJson(encodedHeader);
    const claims = base64urlJson(encodedClaims);
    if (header.alg !== "RS256" || !validString(header.kid)) {
      throw new GmailGatewayError(
        "invalid_pubsub_identity",
        "Unsupported Pub/Sub identity token.",
        401
      );
    }
    const jwk = (await keys()).find(
      (candidate) => candidate.kid === header.kid && candidate.kty === "RSA"
    );
    if (!jwk) {
      throw new GmailGatewayError("invalid_pubsub_identity", "Unknown Pub/Sub identity key.", 401);
    }
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const validSignature = verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      publicKey,
      Buffer.from(encodedSignature, "base64url")
    );
    if (!validSignature || !pubsubClaimsAreExpected(claims, config, now)) {
      throw new GmailGatewayError(
        "invalid_pubsub_identity",
        "Unexpected Pub/Sub identity token.",
        401
      );
    }
    return claims;
  };
}

export function createEmailGatewayServer({
  config,
  fetch: fetchImpl = fetch,
  now = () => Date.now()
} = {}) {
  const configured = config ?? emailGatewayConfig();
  if (configured.enabled) {
    assertEnabledGatewayConfig(configured);
  }
  const encryptionKey = configured.enabled
    ? decodeEncryptionKey(configured.tokenEncryptionKey)
    : undefined;
  const credentials = configured.enabled ? tokenStore(configured, encryptionKey) : undefined;
  const persistentState = configured.enabled ? stateStore(configured, encryptionKey) : undefined;
  const receiptCache = new Map();
  const oauthStates = new Map();
  const usage = usageTracker(configured, now);
  const validatePubsubJwt = configured.enabled
    ? pubsubJwtVerifier(configured, fetchImpl, now)
    : undefined;
  let processingNotifications = false;

  const audit = (entry) => {
    if (configured.enabled) {
      return appendGatewayAudit(configured.auditFile, compactAuditEntry(entry));
    }
    return Promise.resolve();
  };

  const purgeExpired = () => {
    const currentTime = now();
    for (const [receipt, record] of receiptCache) {
      if (Date.parse(record.expiresAt) <= currentTime) receiptCache.delete(receipt);
    }
    for (const [state, record] of oauthStates) {
      if (record.expiresAt <= currentTime) oauthStates.delete(state);
    }
  };

  const requireEnabled = (response) => {
    if (configured.enabled) return true;
    json(response, 503, { error: "email_gateway_disabled", message: "Email gateway is disabled." });
    return false;
  };

  const requireToken = (request, response, expected, role) => {
    if (tokenMatches(bearerToken(request), expected)) return true;
    json(response, 401, {
      error: "unauthorized",
      message: `Missing or invalid ${role} bearer token.`
    });
    return false;
  };

  const requireAdmin = (request, response) =>
    requireEnabled(response) &&
    requireToken(request, response, configured.adminToken, "gateway admin");
  const requireConsumer = (request, response) =>
    requireEnabled(response) &&
    requireToken(request, response, configured.consumerToken, "gateway consumer");

  async function deliverTransaction(candidate) {
    if (!configured.dashboardEventUrl || !configured.dashboardEventToken) {
      await audit({ event: "transaction_delivery_unconfigured", parserId: candidate.parserId });
      return false;
    }
    const response = await fetchImpl(configured.dashboardEventUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configured.dashboardEventToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Idempotency-Key": `gmail:${candidate.externalId}`
      },
      body: JSON.stringify(candidate)
    });
    if (!response.ok) {
      await audit({
        event: "transaction_delivery_failed",
        status: response.status,
        parserId: candidate.parserId
      });
      return false;
    }
    await audit({ event: "transaction_delivered", parserId: candidate.parserId });
    return true;
  }

  async function processQueuedNotifications() {
    if (processingNotifications || !configured.enabled) return;
    processingNotifications = true;
    try {
      while (true) {
        const state = await persistentState.read();
        const nextHistoryId = state.pendingHistoryIds[0];
        if (!nextHistoryId) return;
        if (!state.historyId) {
          await persistentState.mutate((current) => ({
            ...current,
            historyId: nextHistoryId,
            historyPageToken: "",
            pendingHistoryIds: current.pendingHistoryIds.filter((id) => id !== nextHistoryId)
          }));
          await audit({ event: "history_cursor_initialized" });
          continue;
        }

        let history;
        try {
          history = await gmailHistory(
            configured,
            credentials,
            state.historyId,
            { pageToken: state.historyPageToken || undefined },
            fetchImpl
          );
        } catch (error) {
          await persistentState.mutate((current) => ({ ...current, needsResync: true }));
          await audit({ event: "history_sync_failed", code: error?.code ?? "unknown" });
          return;
        }
        const messageIds = [
          ...new Set(
            (history.history ?? []).flatMap((entry) =>
              (entry.messagesAdded ?? []).map((added) => added?.message?.id).filter(Boolean)
            )
          )
        ];
        let deliveryFailed = false;
        const seen = new Set(state.seenMessageIds);
        const newlySeen = [];
        for (const messageId of messageIds) {
          const opaqueId = createHash("sha256").update(String(messageId)).digest("base64url");
          if (seen.has(opaqueId)) continue;
          const message = await gmailGetMessage(
            configured,
            credentials,
            messageId,
            { format: "full" },
            fetchImpl
          );
          const candidate = parseTransactionCandidate(message, configured.transactionParsers, {
            maxBodyChars: configured.maxBodyChars
          });
          if (candidate && !(await deliverTransaction(candidate))) {
            deliveryFailed = true;
            break;
          }
          newlySeen.push(opaqueId);
        }
        if (deliveryFailed) return;
        const nextPageToken = validString(history.nextPageToken);
        const completedHistoryId = /^\d+$/.test(String(history.historyId ?? ""))
          ? String(history.historyId)
          : nextHistoryId;
        await persistentState.mutate((current) => ({
          ...current,
          ...(nextPageToken
            ? { historyPageToken: nextPageToken }
            : {
                historyId: completedHistoryId,
                historyPageToken: "",
                pendingHistoryIds: current.pendingHistoryIds.filter((id) => id !== nextHistoryId)
              }),
          seenMessageIds: [...new Set([...current.seenMessageIds, ...newlySeen])].slice(-1000),
          needsResync: false
        }));
        await audit({
          event: nextPageToken ? "history_page_synced" : "history_synced",
          messageCount: messageIds.length
        });
      }
    } catch (error) {
      await audit({ event: "history_processing_error", code: error?.code ?? "unknown" });
    } finally {
      processingNotifications = false;
    }
  }

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? configured.host}`);
    try {
      purgeExpired();
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const connected = configured.enabled ? Boolean(await credentials.read()) : false;
        const state = configured.enabled ? await persistentState.read() : undefined;
        json(response, configured.enabled ? 200 : 503, {
          status: configured.enabled ? "ok" : "disabled",
          connected,
          scope: configured.enabled ? GMAIL_READONLY_SCOPE : undefined,
          watchExpiration: state?.watchExpiration || undefined,
          needsResync: state?.needsResync || false,
          usage: configured.enabled ? usage.snapshot() : undefined
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/oauth/start") {
        if (!requireAdmin(request, response)) return;
        const { verifier, challenge } = pkcePair();
        const state = randomBytes(32).toString("base64url");
        oauthStates.set(state, { verifier, expiresAt: now() + 10 * 60 * 1000 });
        await audit({ event: "oauth_started" });
        json(response, 200, {
          authorizationUrl: oauthAuthorizationUrl(configured, state, challenge),
          expiresAt: new Date(now() + 10 * 60 * 1000).toISOString()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/oauth/callback") {
        if (!configured.enabled) {
          html(response, 503, "<h1>Email gateway disabled</h1>");
          return;
        }
        const state = validString(url.searchParams.get("state"));
        const pending = oauthStates.get(state);
        const code = validString(url.searchParams.get("code"));
        oauthStates.delete(state);
        if (!pending || pending.expiresAt <= now() || !code) {
          await audit({ event: "oauth_callback_rejected" });
          html(response, 400, "<h1>OAuth callback rejected</h1><p>Start the connection again.</p>");
          return;
        }
        const token = await exchangeAuthorizationCode(
          configured,
          { code, codeVerifier: pending.verifier },
          fetchImpl
        );
        const transientStore = { read: async () => token, write: async () => {} };
        const profile = await gmailProfile(configured, transientStore, fetchImpl);
        const email = validString(profile.emailAddress).toLowerCase();
        if (!email || email !== configured.allowedEmail.toLowerCase()) {
          await audit({ event: "oauth_account_rejected" });
          html(
            response,
            403,
            "<h1>Google account rejected</h1><p>This is not the configured Gmail account.</p>"
          );
          return;
        }
        await credentials.write({ ...token, email, connectedAt: new Date(now()).toISOString() });
        await audit({ event: "oauth_connected" });
        html(response, 200, "<h1>Gmail connected</h1><p>You may close this tab.</p>");
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/oauth/status") {
        if (!requireAdmin(request, response)) return;
        const token = await credentials.read();
        json(response, 200, {
          connected: Boolean(token),
          account: token?.email,
          scope: token?.scope,
          expiresAt: token?.expiresAt
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/search") {
        if (!requireConsumer(request, response)) return;
        const compiled = compileEmailSearch(await readJson(request), {
          maxResults: configured.maxResults
        });
        usage.search();
        const listed = await gmailListMessages(configured, credentials, compiled, fetchImpl);
        const messages = [];
        for (const item of (listed.messages ?? []).slice(0, compiled.limit)) {
          if (!item?.id) continue;
          messages.push(
            await gmailGetMessage(
              configured,
              credentials,
              item.id,
              { format: "metadata" },
              fetchImpl
            )
          );
        }
        const receipt = createSearchReceipt(messages, {
          ttlSeconds: configured.receiptTtlSeconds,
          now: now()
        });
        receiptCache.set(receipt.receipt, receipt);
        await audit({
          event: "email_search",
          purpose: compiled.purpose,
          queryFingerprint: compiled.queryFingerprint,
          resultCount: receipt.results.length
        });
        json(response, 200, {
          receipt: receipt.receipt,
          expiresAt: receipt.expiresAt,
          messages: receipt.results
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/messages/read") {
        if (!requireConsumer(request, response)) return;
        const payload = await readJson(request);
        const receiptId = validString(payload.receipt);
        const handle = validString(payload.handle);
        const receipt = receiptCache.get(receiptId);
        const gmailMessageId = receipt?.handles?.get(handle);
        if (!receipt || Date.parse(receipt.expiresAt) <= now() || !gmailMessageId) {
          throw new GmailGatewayError(
            "invalid_email_receipt",
            "Message receipt is invalid or has expired; search again.",
            404
          );
        }
        if (receipt.reads >= configured.maxReadsPerReceipt) {
          throw new GmailGatewayError(
            "email_policy_limit",
            "Receipt read limit has been reached.",
            429
          );
        }
        // Reserve the slot before the first await. Concurrent callers cannot
        // collectively exceed a receipt's bounded read budget.
        receipt.reads += 1;
        try {
          const message = await gmailGetMessage(
            configured,
            credentials,
            gmailMessageId,
            { format: "full" },
            fetchImpl
          );
          const text = sanitizedMessageText(message, { maxChars: configured.maxBodyChars });
          usage.body(text.length);
          await audit({ event: "email_message_read", bodyChars: text.length });
          json(response, 200, {
            receipt: receiptId,
            handle,
            message: {
              ...messageSummary(message),
              text,
              untrustedContent: true,
              attachments: "not-available"
            }
          });
        } catch (error) {
          receipt.reads -= 1;
          throw error;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/watch/renew") {
        if (!requireAdmin(request, response)) return;
        const payload = await readJson(request);
        const watch = await gmailWatch(
          configured,
          credentials,
          { topicName: configured.pubsubTopic, labelIds: validLabelIds(payload.labelIds) },
          fetchImpl
        );
        const state = await persistentState.mutate((current) => ({
          ...current,
          historyId: String(watch.historyId ?? current.historyId),
          historyPageToken: "",
          watchExpiration: Number.isFinite(Number(watch.expiration))
            ? new Date(Number(watch.expiration)).toISOString()
            : current.watchExpiration,
          needsResync: false
        }));
        await audit({ event: "gmail_watch_renewed" });
        json(response, 202, {
          historyId: state.historyId || undefined,
          expiration: state.watchExpiration || undefined
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/pubsub/push") {
        if (!requireEnabled(response)) return;
        if (!configured.pubsubAudience || !configured.pubsubPushServiceAccount) {
          json(response, 503, {
            error: "pubsub_not_configured",
            message: "Pub/Sub push auth is not configured."
          });
          return;
        }
        await validatePubsubJwt(bearerToken(request));
        const envelope = await readJson(request);
        const encoded = validString(envelope.message?.data);
        let notification;
        try {
          notification = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        } catch {
          throw new GmailGatewayError(
            "invalid_pubsub_notification",
            "Invalid Pub/Sub notification payload.",
            400
          );
        }
        if (
          validString(notification.emailAddress).toLowerCase() !==
            configured.allowedEmail.toLowerCase() ||
          !/^\d+$/.test(String(notification.historyId ?? ""))
        ) {
          throw new GmailGatewayError(
            "invalid_pubsub_notification",
            "Unexpected Gmail notification payload.",
            400
          );
        }
        const historyId = String(notification.historyId);
        await persistentState.mutate((current) => ({
          ...current,
          pendingHistoryIds: current.pendingHistoryIds.includes(historyId)
            ? current.pendingHistoryIds
            : [...current.pendingHistoryIds, historyId].slice(-100)
        }));
        await audit({ event: "pubsub_notification_received" });
        response.writeHead(204, { "Cache-Control": "no-store" });
        response.end();
        queueMicrotask(() => {
          processQueuedNotifications().catch(() => {});
        });
        return;
      }

      json(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error instanceof GmailGatewayError ? error.status : (error?.status ?? 500);
      const code =
        error instanceof GmailGatewayError
          ? error.code
          : error?.code === "invalid_email_search"
            ? "invalid_email_search"
            : status === 400 || status === 413
              ? "invalid_request"
              : "internal_error";
      const message =
        error instanceof GmailGatewayError || status === 400 || status === 413
          ? error.message
          : "Email gateway request failed.";
      await audit({ event: "request_rejected", code, status });
      json(response, status, { error: code, message });
    }
  });
}

export async function startEmailGateway() {
  const env = await gatewayEnvironment();
  const config = emailGatewayConfig(env);
  assertEnabledGatewayConfig(config);
  const server = createEmailGatewayServer({ config });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  console.log(`Email gateway listening on http://${config.host}:${config.port}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startEmailGateway().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
