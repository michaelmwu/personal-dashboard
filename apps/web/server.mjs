import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.WEB_PORT ?? "8811", 10);
const apiPort = Number.parseInt(process.env.API_PORT ?? "8810", 10);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"]
]);

function safePath(pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalized = normalize(relative);
  if (normalized.startsWith("..")) {
    return null;
  }
  return join(__dirname, normalized);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/config.json") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ apiBaseUrl: `http://127.0.0.1:${apiPort}` }));
    return;
  }

  const path = safePath(url.pathname);
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

server.listen(port, "127.0.0.1", () => {
  console.log(`Personal Dashboard listening on http://127.0.0.1:${port}`);
});
