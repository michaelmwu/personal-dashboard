import { readFile } from "node:fs/promises";
import http from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.WEB_PORT ?? "8811", 10);
const apiPort = Number.parseInt(process.env.API_PORT ?? "8810", 10);
const host = process.env.WEB_HOST ?? "127.0.0.1";
const configuredApiBaseUrl = process.env.PERSONAL_DASHBOARD_API_BASE_URL?.trim().replace(/\/$/, "");
const apiBaseUrl = configuredApiBaseUrl || `http://127.0.0.1:${apiPort}`;
const dashboardApiToken = process.env.PERSONAL_DASHBOARD_API_TOKEN ?? "";
const tailscaleAllowedLogins = process.env.PERSONAL_DASHBOARD_TAILSCALE_ALLOWED_LOGINS;
const tailscaleAllowedAppCapabilities =
  process.env.PERSONAL_DASHBOARD_TAILSCALE_ALLOWED_APP_CAPABILITIES;

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
]);

const loopbackOnlyApiPaths = new Set(["/api/host-dashboard/summary"]);
const healthcheckPath = "/api/health";

function parseCommaSeparatedValues(value, { normalize = (item) => item } = {}) {
  if (typeof value !== "string") {
    return new Set();
  }

  return new Set(
    value
      .split(",")
      .map((item) => normalize(item.trim()))
      .filter(Boolean)
  );
}

export function parseTailscaleAllowedLogins(value) {
  return parseCommaSeparatedValues(value, { normalize: (login) => login.toLowerCase() });
}

export function parseTailscaleAllowedAppCapabilities(value) {
  return parseCommaSeparatedValues(value);
}

function configuredTailscaleAccess({ allowedLogins, allowedAppCapabilities }) {
  return allowedLogins.size > 0 || allowedAppCapabilities.size > 0;
}

function requestHasAllowedTailscaleLogin(request, allowedLogins) {
  const login = request.headers["tailscale-user-login"];
  if (typeof login !== "string" || login.includes(",")) {
    return false;
  }

  return allowedLogins.has(login.trim().toLowerCase());
}

function requestHasAllowedTailscaleAppCapability(request, allowedAppCapabilities) {
  const header = request.headers["tailscale-app-capabilities"];
  if (typeof header !== "string") {
    return false;
  }

  try {
    const capabilities = JSON.parse(header);
    if (!capabilities || Array.isArray(capabilities) || typeof capabilities !== "object") {
      return false;
    }

    return [...allowedAppCapabilities].some(
      (capability) => Array.isArray(capabilities[capability]) && capabilities[capability].length > 0
    );
  } catch {
    return false;
  }
}

function requestHasAllowedTailscaleIdentity(request, access) {
  if (!configuredTailscaleAccess(access)) {
    return true;
  }

  return (
    requestHasAllowedTailscaleLogin(request, access.allowedLogins) ||
    requestHasAllowedTailscaleAppCapability(request, access.allowedAppCapabilities)
  );
}

function rejectUnapprovedTailscaleIdentity(response) {
  response.writeHead(403, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(
    JSON.stringify({
      error: "tailscale_identity_required",
      message: "This dashboard is restricted to an approved Tailscale identity."
    })
  );
}

function safePath(pathname, rootDir = __dirname) {
  const routeFiles = new Map([
    ["/", "home.html"],
    ["/finance", "index.html"],
    ["/finance.html", "index.html"],
    ["/flights", "flights.html"],
    ["/flights.html", "flights.html"]
  ]);
  const relative = routeFiles.get(pathname) ?? pathname.slice(1);
  const normalized = normalize(relative);
  if (normalized.startsWith("..")) {
    return null;
  }
  return join(rootDir, normalized);
}

function responseHeaders(headers) {
  const excludedHeaders = new Set([
    "connection",
    "content-encoding",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ]);
  return Object.fromEntries(
    [...headers.entries()].filter(([name]) => !excludedHeaders.has(name.toLowerCase()))
  );
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function proxyApiRequest(
  request,
  response,
  { baseUrl = apiBaseUrl, apiToken = dashboardApiToken } = {}
) {
  const upstreamUrl = new URL(request.url ?? "/", baseUrl);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  if (apiToken && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${apiToken}`);
  }
  const abortController = new AbortController();
  response.on("close", () => {
    abortController.abort();
  });

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await requestBody(request),
    signal: abortController.signal
  });

  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && upstreamResponse.body) {
    response.writeHead(upstreamResponse.status, {
      ...responseHeaders(upstreamResponse.headers),
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no"
    });
    try {
      for await (const chunk of upstreamResponse.body) {
        if (response.destroyed) {
          break;
        }
        response.write(chunk);
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        throw error;
      }
    } finally {
      if (!response.destroyed) {
        response.end();
      }
    }
    return;
  }

  const body = Buffer.from(await upstreamResponse.arrayBuffer());
  response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse.headers));
  response.end(body);
}

export function createWebServer({
  rootDir = __dirname,
  proxyBaseUrl = apiBaseUrl,
  dashboardApiToken: configuredApiToken = dashboardApiToken,
  tailscaleAllowedLogins: configuredAllowedLogins = tailscaleAllowedLogins,
  tailscaleAllowedAppCapabilities:
    configuredAllowedAppCapabilities = tailscaleAllowedAppCapabilities
} = {}) {
  const tailscaleAccess = {
    allowedLogins: parseTailscaleAllowedLogins(configuredAllowedLogins),
    allowedAppCapabilities: parseTailscaleAllowedAppCapabilities(configuredAllowedAppCapabilities)
  };

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    // Docker and Coolify liveness checks run locally without a Serve identity.
    // The endpoint is intentionally non-sensitive and is not a UI/API bypass.
    const isHealthcheckRequest = request.method === "GET" && url.pathname === healthcheckPath;
    if (!isHealthcheckRequest && !requestHasAllowedTailscaleIdentity(request, tailscaleAccess)) {
      rejectUnapprovedTailscaleIdentity(response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/config.json") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ apiBaseUrl: "" }));
      return;
    }

    if (loopbackOnlyApiPaths.has(url.pathname)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        await proxyApiRequest(request, response, {
          baseUrl: proxyBaseUrl,
          apiToken: configuredApiToken
        });
      } catch {
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(502);
          response.end("Bad gateway");
        } else if (!response.destroyed) {
          response.end();
        }
      }
      return;
    }

    const path = safePath(url.pathname, rootDir);
    if (!path) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    try {
      const body = await readFile(path);
      response.writeHead(200, {
        "Content-Type": contentTypes.get(extname(path)) ?? "application/octet-stream"
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
}

const server = createWebServer();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, host, () => {
    console.log(`Personal Dashboard listening on http://${host}:${port}`);
  });
}
