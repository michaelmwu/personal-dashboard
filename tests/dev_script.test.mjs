import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import http from "node:http";

const spawned = new Set();
let occupiedServer;

function waitForListening(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

function runDevWithEnv(env) {
  return new Promise((resolve) => {
    const child = spawn("bun", ["scripts/dev.mjs"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    spawned.add(child);
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("exit", (code, signal) => {
      spawned.delete(child);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

afterEach(async () => {
  for (const child of spawned) {
    child.kill("SIGTERM");
  }
  spawned.clear();

  if (occupiedServer) {
    await new Promise((resolve) => occupiedServer.close(resolve));
    occupiedServer = undefined;
  }
});

describe("dev script", () => {
  test("returns non-zero when a child service fails to start", async () => {
    occupiedServer = http.createServer((_request, response) => response.end("occupied"));
    await waitForListening(occupiedServer, 19980);

    const result = await runDevWithEnv({
      API_PORT: "19980",
      WEB_PORT: "19981"
    });

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("[api] exited with 1");
  });
});
