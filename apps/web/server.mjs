import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.WEB_PORT ?? "8811", 10);
const apiPort = Number.parseInt(process.env.API_PORT ?? "8810", 10);
const configuredApiBaseUrl = process.env.PERSONAL_DASHBOARD_API_BASE_URL?.trim().replace(/\/$/, "");
const apiBaseUrl = configuredApiBaseUrl || `http://127.0.0.1:${apiPort}`;

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
]);

function safePath(pathname, rootDir = __dirname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
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

async function proxyApiRequest(request, response, { baseUrl = apiBaseUrl } = {}) {
  const upstreamUrl = new URL(request.url ?? "/", baseUrl);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");

  const upstreamResponse = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD" ? undefined : await requestBody(request)
  });
  const body = Buffer.from(await upstreamResponse.arrayBuffer());
  response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse.headers));
  response.end(body);
}

export function createWebServer({ rootDir = __dirname, proxyBaseUrl = apiBaseUrl } = {}) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/config.json") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ apiBaseUrl: "" }));
      return;
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        await proxyApiRequest(request, response, { baseUrl: proxyBaseUrl });
      } catch {
        response.writeHead(502);
        response.end("Bad gateway");
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
  server.listen(port, "127.0.0.1", () => {
    console.log(`Personal Dashboard listening on http://127.0.0.1:${port}`);
  });
}
