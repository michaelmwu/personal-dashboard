import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const MAX_DOTENV_BYTES = 64 * 1024;

function nonEmptyString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanValue(value, fallback = false) {
  const normalized = nonEmptyString(value).toLowerCase();
  if (["true", "1"].includes(normalized)) return true;
  if (["false", "0"].includes(normalized)) return false;
  return fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function validLoopbackHost(value) {
  const host = nonEmptyString(value, "127.0.0.1");
  return ["127.0.0.1", "localhost", "::1"].includes(host) ? host : "";
}

function optionalUrl(value) {
  const url = nonEmptyString(value);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const loopbackHttp =
      parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !loopbackHttp) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function defaultDataDirectory(env) {
  const stateHome = nonEmptyString(env.XDG_STATE_HOME);
  if (stateHome) return join(stateHome, "personal-dashboard-email-gateway");
  const home = nonEmptyString(env.HOME);
  if (home) return join(home, ".local", "state", "personal-dashboard-email-gateway");
  // This fallback exists only for explicitly configured test/dev processes
  // without HOME. Production launchers must provide a gateway-owned HOME.
  return join(process.cwd(), ".data", "email-gateway");
}

/**
 * Parse a gateway-only dotenv file without evaluating it as shell code.
 * Deliberately supported syntax is only KEY=VALUE. Values are literal: shell
 * quoting, expansion, export, command substitution, and continuation syntax
 * are never evaluated.
 */
export function parseStrictDotenv(contents) {
  if (Buffer.byteLength(contents, "utf8") > MAX_DOTENV_BYTES) {
    throw new Error("Email gateway dotenv file exceeds 64 KiB.");
  }

  const values = {};
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=([^\r\n]*)$/);
    if (!match) {
      throw new Error(`Invalid email gateway dotenv line ${index + 1}. Use only KEY=VALUE.`);
    }
    const [, key, value] = match;
    if (value.includes(String.fromCharCode(0))) {
      throw new Error(`Invalid email gateway dotenv value on line ${index + 1}.`);
    }
    values[key] = value.trim();
  }
  return values;
}

export async function gatewayEnvironment(runtimeEnv = process.env) {
  const envFile = nonEmptyString(runtimeEnv.EMAIL_GATEWAY_ENV_FILE);
  if (!envFile) return { ...runtimeEnv };
  const metadata = await stat(envFile);
  if (!metadata.isFile()) {
    throw new Error("EMAIL_GATEWAY_ENV_FILE must name a regular file.");
  }
  if (metadata.mode & 0o077) {
    throw new Error("EMAIL_GATEWAY_ENV_FILE must not be readable by group or others.");
  }
  const contents = await readFile(envFile, "utf8");
  // Runtime values are injected by the launcher and intentionally take
  // precedence over the private file (notably port and local API base URL).
  return { ...parseStrictDotenv(contents), ...runtimeEnv };
}

function parseTransactionParsers(value) {
  const raw = nonEmptyString(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((parser) => parser && typeof parser === "object" && !Array.isArray(parser))
      .slice(0, 32);
  } catch {
    throw new Error("EMAIL_GATEWAY_TRANSACTION_PARSERS_JSON must be a JSON array.");
  }
}

export function emailGatewayConfig(env = process.env) {
  const host = validLoopbackHost(env.EMAIL_GATEWAY_HOST);
  const port = boundedInteger(env.EMAIL_GATEWAY_PORT, 8830, 1, 65535);
  const dashboardApiBaseUrl = optionalUrl(env.PERSONAL_DASHBOARD_API_BASE_URL);
  const explicitDashboardEventUrl = optionalUrl(env.EMAIL_GATEWAY_DASHBOARD_EVENT_URL);
  const oauthRedirectUri = optionalUrl(env.EMAIL_GATEWAY_OAUTH_REDIRECT_URI);
  const dataDirectoryConfigured = Boolean(
    nonEmptyString(env.EMAIL_GATEWAY_DATA_DIR) ||
      nonEmptyString(env.XDG_STATE_HOME) ||
      nonEmptyString(env.HOME)
  );
  const dataDirectory = nonEmptyString(env.EMAIL_GATEWAY_DATA_DIR, defaultDataDirectory(env));

  return {
    enabled: booleanValue(env.EMAIL_GATEWAY_ENABLED, false),
    host,
    port,
    allowedEmail: nonEmptyString(env.EMAIL_GATEWAY_ALLOWED_EMAIL),
    oauthClientId: nonEmptyString(env.EMAIL_GATEWAY_OAUTH_CLIENT_ID),
    oauthClientSecret: nonEmptyString(env.EMAIL_GATEWAY_OAUTH_CLIENT_SECRET),
    oauthRedirectUri: oauthRedirectUri || `http://${host || "127.0.0.1"}:${port}/oauth/callback`,
    dataDirectoryConfigured,
    tokenEncryptionKey: nonEmptyString(env.EMAIL_GATEWAY_TOKEN_ENCRYPTION_KEY),
    tokenFile: nonEmptyString(
      env.EMAIL_GATEWAY_TOKEN_FILE,
      join(dataDirectory, "email-gateway-token.json")
    ),
    stateFile: nonEmptyString(
      env.EMAIL_GATEWAY_STATE_FILE,
      join(dataDirectory, "email-gateway-state.json")
    ),
    auditFile: nonEmptyString(
      env.EMAIL_GATEWAY_AUDIT_FILE,
      join(dataDirectory, "email-gateway-audit.jsonl")
    ),
    adminToken: nonEmptyString(env.EMAIL_GATEWAY_ADMIN_TOKEN),
    consumerToken: nonEmptyString(env.EMAIL_GATEWAY_CONSUMER_TOKEN),
    dashboardEventUrl:
      explicitDashboardEventUrl ||
      (dashboardApiBaseUrl
        ? `${dashboardApiBaseUrl.replace(/\/$/, "")}/api/integrations/gmail-intake/events`
        : ""),
    dashboardEventToken: nonEmptyString(env.EMAIL_GATEWAY_DASHBOARD_EVENT_TOKEN),
    pubsubTopic: nonEmptyString(env.EMAIL_GATEWAY_PUBSUB_TOPIC),
    pubsubAudience: nonEmptyString(env.EMAIL_GATEWAY_PUBSUB_AUDIENCE),
    pubsubPushServiceAccount: nonEmptyString(env.EMAIL_GATEWAY_PUBSUB_PUSH_SERVICE_ACCOUNT),
    receiptTtlSeconds: boundedInteger(env.EMAIL_GATEWAY_RECEIPT_TTL_SECONDS, 900, 60, 3600),
    maxResults: boundedInteger(env.EMAIL_GATEWAY_MAX_RESULTS, 25, 1, 50),
    maxReadsPerReceipt: boundedInteger(env.EMAIL_GATEWAY_MAX_READS_PER_RECEIPT, 10, 1, 25),
    maxBodyChars: boundedInteger(env.EMAIL_GATEWAY_MAX_BODY_CHARS, 12_000, 500, 50_000),
    maxDailySearches: boundedInteger(env.EMAIL_GATEWAY_MAX_DAILY_SEARCHES, 250, 1, 10_000),
    maxDailyBodyChars: boundedInteger(
      env.EMAIL_GATEWAY_MAX_DAILY_BODY_CHARS,
      500_000,
      1_000,
      20_000_000
    ),
    transactionParsers: parseTransactionParsers(env.EMAIL_GATEWAY_TRANSACTION_PARSERS_JSON)
  };
}

export function assertEnabledGatewayConfig(config) {
  if (!config.enabled) return;
  const missing = [
    ["EMAIL_GATEWAY_HOST", config.host],
    ["EMAIL_GATEWAY_ALLOWED_EMAIL", config.allowedEmail],
    ["EMAIL_GATEWAY_OAUTH_CLIENT_ID", config.oauthClientId],
    ["EMAIL_GATEWAY_OAUTH_CLIENT_SECRET", config.oauthClientSecret],
    ["EMAIL_GATEWAY_TOKEN_ENCRYPTION_KEY", config.tokenEncryptionKey],
    ["EMAIL_GATEWAY_ADMIN_TOKEN", config.adminToken],
    ["EMAIL_GATEWAY_CONSUMER_TOKEN", config.consumerToken],
    ["EMAIL_GATEWAY_DATA_DIR or a gateway-owned HOME", config.dataDirectoryConfigured]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Email gateway is enabled but missing ${missing.join(", ")}.`);
  }
  const key = decodeEncryptionKey(config.tokenEncryptionKey);
  if (key.length !== 32) {
    throw new Error("EMAIL_GATEWAY_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
}

export function decodeEncryptionKey(value) {
  const normalized = nonEmptyString(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}
